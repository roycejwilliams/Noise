import { Client } from "@googlemaps/google-maps-services-js";
import { find as findTimezone } from "geo-tz";
import pool from "../db/db.js";

const client = new Client({});

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
export async function geocodeCity(city: string): Promise<GeoPoint | null> {
  const trimmed = city.trim();
  if (!trimmed) return null;

  const cached = await pool.query(`SELECT lat, lng FROM geocode_cache WHERE query = $1`, [trimmed]);
  if (cached.rows.length) {
    return { lat: Number(cached.rows[0].lat), lng: Number(cached.rows[0].lng) };
  }

  try {
    // Geocoding API (Royce enabled it live, 2026-09-02, after it first came
    // back "This API is not activated on your API project" — Places API
    // being enabled on the same key/project doesn't imply Geocoding is too,
    // they're separately toggled). Confirmed working against this key
    // immediately after enabling.
    const response = await client.geocode({
      params: { address: trimmed, key: process.env.GOOGLE_PLACES_API_KEY! },
    });
    const location = response.data.results?.[0]?.geometry?.location;
    if (!location) return null;

    await pool
      .query(`INSERT INTO geocode_cache (query, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (query) DO NOTHING`, [
        trimmed,
        location.lat,
        location.lng,
      ])
      .catch((err: any) => console.error("geocodeCity: cache write failed (non-fatal):", err?.message ?? err));

    return { lat: location.lat, lng: location.lng };
  } catch (err: any) {
    console.error(`geocodeCity: failed for "${trimmed}" (non-fatal):`, err?.message ?? err);
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
export async function getTimezoneForCity(city: string): Promise<string | null> {
  const trimmed = city.trim();
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
