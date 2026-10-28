import { Client } from "@googlemaps/google-maps-services-js";
import { find as findTimezone } from "geo-tz";
import pool from "../db/db.js";

const client = new Client({});

// The Google key (Geocoding + Places, one key): GOOGLE_API_KEY, the name co-test's Railway sets (Royce, 2026-10-28: "We're going to
// stick with that"). The code read GOOGLE_PLACES_API_KEY, which co-test never set, so every lookup was refused (the morning's ~65
// "Google failed ... 403" lines) and fell back to the open geocoder, and Places photos never ran. The old name still works where it's
// set (production's service has it), so nothing changes there.
export const googleKey = (env: NodeJS.ProcessEnv = process.env): string => env.GOOGLE_API_KEY || env.GOOGLE_PLACES_API_KEY || "";

export type GeoPoint = { lat: number; lng: number };

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

// Real geo filter (Royce, 2026-09-02) — replaces the old "bake the city into
// the embedding and hope semantic similarity happens to favor it" bias.
// PostGIS was assumed available (co_profiles' now-removed `coordinates
// geometry` migration) but never actually was on this database — confirmed
// live: pg_extension/pg_available_extensions both come back empty for
// postgis on co-test's Postgres, and it's not something Railway's managed
// image ships at all, only pgvector. Plain lat/lng + haversine needs nothing
// extra.
//
// Cached by the raw city string, not a normalized form — Google's Geocoding
// API already absorbs case/whitespace/synonym variance internally, so two
// different raw strings that resolve to the same place just become two
// cache rows with identical lat/lng. Simpler than building our own
// normalization, and the cache table is tiny either way (a handful of
// distinct city strings a real user or event ever mentions).
//
// Failed lookups are never cached — a transient API hiccup shouldn't
// permanently blacklist a real city string; it just retries next call.
//
// A bare name is ambiguous (2026-10-12 intelligence audit: the cache held Cambridge in England, Medford in Oregon, Somerville and
// Newark in New Jersey, Saratoga in New York, all for Boston-area members, and one bare row answered every caller). So a bare city
// is geocoded as "city, region" when the caller knows the member's region (their state, from their phone's area code:
// services/areaCodes.ts), and the cache row is keyed by what was actually geocoded, never by the bare name for a biased lookup.
// A name that already carries its region ("Cambridge, MA", "Cambridge MA") is used as is.
export type GeoBias = { region?: string | null };

// Pure: what to geocode (and cache under) for a city and a bias.
export function geoQuery(city: string, bias?: GeoBias | null): string {
  const c = String(city ?? "").trim().replace(/\s+/g, " ");
  if (!c) return "";
  const region = String(bias?.region ?? "").trim();
  if (!region || c.includes(",") || /\s[A-Z]{2}$/.test(c)) return c;
  return `${c}, ${region}`;
}

export async function geocodeCity(city: string, bias?: GeoBias | null): Promise<GeoPoint | null> {
  const trimmed = geoQuery(city, bias);
  if (!trimmed) return null;

  // The cache is an optimization: without a database (evals, local runs) the
  // lookup still works, it just isn't cached.
  const cached = await pool
    .query(`SELECT lat, lng FROM geocode_cache WHERE query = $1`, [trimmed])
    .catch(() => ({ rows: [] as any[] }));
  if (cached.rows.length) {
    return { lat: Number(cached.rows[0].lat), lng: Number(cached.rows[0].lng) };
  }

  try {
    // Geocoding API (Royce enabled it live, 2026-09-02, after it first came
    // back "This API is not activated on your API project" — Places API
    // being enabled on the same key/project doesn't imply Geocoding is too,
    // they're separately toggled). Confirmed working against this key
    // immediately after enabling.
    const ask = (address: string) => client.geocode({
      // region: a US bias for a name with nothing else to go on (the club is in the US).
      params: { address, region: "us", key: googleKey() },
    });
    let response = await ask(trimmed);
    // No such place in that state ("Newark, MA" came back as a nearby town): the name as given, never a guess near the bias.
    const given = String(city ?? "").trim();
    if (response.data.results?.[0]?.partial_match && given && given !== trimmed) response = await ask(given);
    const location = response.data.results?.[0]?.geometry?.location;
    if (!location) return openMeteoGeocode(trimmed);

    await pool
      .query(`INSERT INTO geocode_cache (query, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (query) DO NOTHING`, [
        trimmed,
        location.lat,
        location.lng,
      ])
      .catch((err: any) => console.error("geocodeCity: cache write failed (non-fatal):", err?.message ?? err));

    return { lat: location.lat, lng: location.lng };
  } catch (err: any) {
    // Google needs billing enabled on the Cloud project; without it every
    // uncached city fails (2026-09-16: REQUEST_DENIED, which silently broke
    // the distance checks, time zones, and event search for any city not
    // already in the cache). The free fallback keeps those working.
    console.error(`geocodeCity: Google failed for "${trimmed}", trying the open geocoder (non-fatal):`, err?.message ?? err);
    return openMeteoGeocode(trimmed);
  }
}

// A venue's exact spot, for noticing arrivals (services/eventPresence.ts,
// 2026-09-23). Unlike geocodeCity there is no city-level fallback: a city's
// center point would never match a real venue, and near one it could
// wrongly mark people as arrived. Street-level or nothing.
const VENUE_PRECISE = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);
const VENUE_TYPES = ["street_address", "premise", "subpremise", "establishment", "point_of_interest"];
export async function geocodeVenue(address: string): Promise<GeoPoint | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const key = `venue:${trimmed}`;
  const cached = await pool.query(`SELECT lat, lng FROM geocode_cache WHERE query = $1`, [key]).catch(() => ({ rows: [] as any[] }));
  if (cached.rows.length) return { lat: Number(cached.rows[0].lat), lng: Number(cached.rows[0].lng) };
  try {
    const response = await client.geocode({ params: { address: trimmed, key: googleKey() } });
    const hit = response.data.results?.[0];
    const precise = hit && (VENUE_PRECISE.has(String(hit.geometry?.location_type)) || (hit.types ?? []).some((t: string) => VENUE_TYPES.includes(t)));
    if (!hit || !precise) return null;
    const { lat, lng } = hit.geometry.location;
    await pool
      .query(`INSERT INTO geocode_cache (query, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (query) DO NOTHING`, [key, lat, lng])
      .catch(() => {});
    return { lat, lng };
  } catch (err: any) {
    console.error("geocodeVenue: lookup failed (non-fatal):", err?.response?.data?.status ?? err?.message ?? err);
    return null;
  }
}

// Open-Meteo's geocoding API: free, no key, no billing.
// It searches names only, so "Medford, MA" is searched as "Medford" and the hit in that region (else in the US) is taken.
async function openMeteoGeocode(city: string): Promise<GeoPoint | null> {
  try {
    const [name, ...rest] = city.split(",").map((x) => x.trim());
    const tail = rest.join(" ") || (city.match(/\s([A-Z]{2})$/)?.[1] ?? "");
    const bare = rest.length ? name : city.replace(/\s[A-Z]{2}$/, "");
    const { STATE_NAMES } = await import("./areaCodes.js");
    const region = (STATE_NAMES[tail.toUpperCase()] ?? tail).toLowerCase();
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(bare)}&count=10&language=en&format=json`);
    if (!res.ok) return null;
    const data: any = await res.json();
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    // In the region asked for; else the first US hit; else the first hit (a bias, never a reason to find nothing).
    const inRegion = region ? results.find((r) => String(r.admin1 ?? "").toLowerCase() === region || String(r.country ?? "").toLowerCase() === region) : undefined;
    const hit = inRegion ?? results.find((r) => r.country_code === "US") ?? results[0];
    if (typeof hit?.latitude !== "number" || typeof hit?.longitude !== "number") return null;
    await pool
      .query(`INSERT INTO geocode_cache (query, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (query) DO NOTHING`, [city, hit.latitude, hit.longitude])
      .catch((err: any) => console.error("openMeteoGeocode: cache write failed (non-fatal):", err?.message ?? err));
    return { lat: hit.latitude, lng: hit.longitude };
  } catch (err: any) {
    console.error(`openMeteoGeocode: failed for "${city}" (non-fatal):`, err?.message ?? err);
    return null;
  }
}

// Timezone-aware proactive contact (Royce, 2026-09-02: a real "thinking
// about you" text arrived at 2am Pacific because jobs/index.ts's crons
// fired at fixed UTC hours with zero regard for the recipient's actual
// local time). Reuses geocodeCity's own cache row rather than a second
// cache table — lazily backfills the `timezone` column on that same row
// the first time a timezone (not just lat/lng) is needed for that city
// string. geo-tz resolves lat/lng -> IANA zone entirely offline (bundled
// timezone-boundary data, no network call, no rate limit) — deliberately
// NOT another Google API, since Geocoding and Places both already hit
// "This API is not activated on your API project" the first time each was
// tried against this same key.
export async function getTimezoneForCity(city: string, bias?: GeoBias | null): Promise<string | null> {
  const trimmed = geoQuery(city, bias);
  if (!trimmed) return null;

  const cached = await pool.query(`SELECT lat, lng, timezone FROM geocode_cache WHERE query = $1`, [trimmed]);
  if (cached.rows.length) {
    const row = cached.rows[0];
    if (row.timezone) return row.timezone;
    const zone = findTimezone(Number(row.lat), Number(row.lng))[0] ?? null;
    if (zone) {
      await pool
        .query(`UPDATE geocode_cache SET timezone = $1 WHERE query = $2`, [zone, trimmed])
        .catch((err: any) => console.error("getTimezoneForCity: cache write failed (non-fatal):", err?.message ?? err));
    }
    return zone;
  }

  const point = await geocodeCity(trimmed);
  if (!point) return null;
  const zone = findTimezone(point.lat, point.lng)[0] ?? null;
  if (zone) {
    await pool
      .query(`UPDATE geocode_cache SET timezone = $1 WHERE query = $2`, [zone, trimmed])
      .catch((err: any) => console.error("getTimezoneForCity: cache write failed (non-fatal):", err?.message ?? err));
  }
  return zone;
}

// Hard radius filter for the recommendation engine — same "Bay Area" case
// Royce raised: a Walnut Creek user should still see San Francisco/Oakland/
// Berkeley events, which a literal city-string match would incorrectly
// exclude. 50 miles comfortably covers the real Bay Area (Walnut Creek to
// San Jose is ~45mi) while still ruling out a same-named venue or a
// same-semantic-vibe event hundreds of miles away that the old embedding-
// similarity bias could let through.
//
// Missing or unresolvable city data never hard-blocks a match — it falls
// back to "don't filter" rather than silently losing real candidates to a
// geocoding gap (an unfamiliar city string, an API hiccup, a user who never
// gave a city). The hard filter only kicks in when both sides are known.
export const SAME_METRO_MAX_MILES = 50;

export async function withinRadius(
  cityA: string | null | undefined,
  cityB: string | null | undefined,
  maxMiles: number = SAME_METRO_MAX_MILES,
): Promise<boolean> {
  if (!cityA || !cityB) return true;
  const [a, b] = await Promise.all([geocodeCity(cityA), geocodeCity(cityB)]);
  if (!a || !b) return true;
  return haversineMiles(a, b) <= maxMiles;
}
