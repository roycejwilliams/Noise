// Where a want's place is on the map (Royce, 2026-10-29). services/wantPlace.ts keeps the place in the member's words ("Bay Area");
// this turns those words into one real place before anything searches there, relative to where they live.
//
// What it fixed: "Bay Area" from a Sacramento member geocoded to Bay Area Park in Texas, by Houston (the open geocoder's "first US
// hit", cached under the bare name), so every search for their Bay Area ask ran in Houston and found only Houston events.
//
// How a place resolves, deterministic and with no reading of intent:
//   - candidates: the geocoders' hits for the name (Google, then the open geocoder's populated places, never a park or an airport),
//     plus a short table of well-known regional names (REGIONS) that geocoders don't hold as places;
//   - only hits whose name is the name they used count ("Bay Area Park" is not "Bay Area");
//   - a qualified place ("Portland, ME", "San Francisco Bay Area, CA, US") must land in that state and country, or it's rejected;
//   - near home wins: a real place (not a hamlet) within PLACE_RESOLVE.nearHomeMiles of their home, nearest first;
//   - else the clearly most prominent hit (in their country when there's one there); two of comparable size is ambiguous, and an
//     ambiguous place is not searched (never quietly searched at home instead, Royce 2026-10-29).
// A member with no home city keeps the behavior from before this (the place word passed through as it was).
//
// The answer is kept on the want's own row (want_places.resolved_*), relative to the home it was resolved against, so the shared
// geocode cache's bare-name rows (the stale "Bay Area" row among them) are never read for a want's place. A correction clears it
// (wantPlace.ts setPlace). The far-from-home check (farCheck) and its log rows are here too.
import { haversineMiles, googleKey, type GeoPoint } from "./geocoding.js";
import { STATE_NAMES } from "./areaCodes.js";
import type { PlaceSource } from "./wantPlace.js";

export const PLACE_RESOLVE = {
  // A same-named real place this close to home is the one they mean (Springfield, MO from St. Louis is ~215 mi).
  nearHomeMiles: 250,
  // Further than this from home needs the member's own naming of the place, or a window on this want, to be searched.
  farFromHomeMiles: 300,
  // A hit smaller than this never wins on nearness alone (Austin, NV, population 192, is not what a Sacramento member means).
  minPopulation: 5000,
  // The biggest hit is "the" place only when it's at least this many times the next one (Portland, OR over Portland, ME: ~10x).
  dominance: 2,
  // A Google hit and an open-geocoder hit this close together with the same name are one place.
  mergeMiles: 30,
} as const;

export type PlaceCandidate = {
  name: string;
  // Other names it goes by (a region's short forms: "bay area"). Matched like its name.
  keys?: string[];
  lat: number;
  lng: number;
  admin1: string | null;
  // The region's short code when the geocoder gives one (Google's administrative_area_level_1 short_name: "BC", "ON", "CA").
  admin1Code?: string | null;
  country: string | null;
  population: number | null;
  source: "google" | "open_meteo" | "region";
};

// Regional names geocoders don't hold as places (the open geocoder has only parks and a heliport for "Bay Area"). Kept tiny on
// purpose: each is a name members really use for a region, with every region it can mean, so near-home picks among them. The
// populations are rough metro sizes, used only to say which is the better-known one for a member who lives near none of them.
export const REGIONS: PlaceCandidate[] = [
  { name: "San Francisco Bay Area", keys: ["bay area", "the bay area", "the bay", "sf bay area", "sf bay"], lat: 37.8271784, lng: -122.2913078, admin1: "California", country: "US", population: 7_700_000, source: "region" },
  { name: "Bay Area Houston", keys: ["bay area", "the bay area"], lat: 29.55, lng: -95.11, admin1: "Texas", country: "US", population: 500_000, source: "region" },
  { name: "Tampa Bay Area", keys: ["bay area", "the bay area", "tampa bay"], lat: 27.9506, lng: -82.4572, admin1: "Florida", country: "US", population: 3_200_000, source: "region" },
];

// Same spellings as wantPlace.ts samePlace ("SF" is San Francisco), plus a few more.
const NAME_ALIASES: Record<string, string> = { sf: "san francisco", "san fran": "san francisco", nyc: "new york", "new york city": "new york", ny: "new york", la: "los angeles", dc: "washington", "washington dc": "washington", philly: "philadelphia", atl: "atlanta", chi: "chicago", sac: "sacramento", kc: "kansas city" };
export const normName = (s: string | null | undefined): string => {
  const c = String(s ?? "").toLowerCase().replace(/[’'.]/g, "").replace(/\s+/g, " ").trim();
  return NAME_ALIASES[c] ?? c;
};

const COUNTRIES: Record<string, string> = { us: "US", usa: "US", "united states": "US", "united states of america": "US", america: "US", uk: "GB", gb: "GB", "united kingdom": "GB", "great britain": "GB", britain: "GB", canada: "CA", mexico: "MX", ireland: "IE", france: "FR", germany: "DE", australia: "AU", japan: "JP", india: "IN" };
// A part of the UK said as the region: its country is GB.
const UK_PARTS = new Set(["england", "scotland", "wales", "northern ireland"]);
// Canada's provinces and territories by their codes ("Vancouver, BC", "London, ON"). Any other country's region code is matched against
// the code the geocoder itself returns (admin1Code).
export const CA_PROVINCES: Record<string, string> = { AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon" };
const isState = (low: string) => Object.values(STATE_NAMES).some((x) => x.toLowerCase() === low);
const isProvince = (low: string) => Object.values(CA_PROVINCES).some((x) => x.toLowerCase() === low);

export type Qualified = { name: string; region: string | null; country: string | null };

// Pure: a place with its qualifiers taken apart. "Portland, ME" -> Portland in Maine; "San Francisco Bay Area, CA, US" -> that, in
// California, in the US; "Portland ME" and "Vancouver BC" (no comma) too. A two-letter part is a US state when it is one ("CA" is
// California), else a Canadian province ("BC"), else a region code matched against the geocoder's own.
export function parseQualified(place: string): Qualified {
  const raw = String(place ?? "").trim().replace(/\s+/g, " ");
  let parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const m = /^(.*\S)\s+([A-Z]{2})$/.exec(parts[0]);
    if (m && (STATE_NAMES[m[2]] || CA_PROVINCES[m[2]])) parts = [m[1], m[2]];
  }
  const out: Qualified = { name: parts[0] ?? "", region: null, country: null };
  for (const p of parts.slice(1)) {
    const up = p.toUpperCase();
    const low = p.toLowerCase();
    if (STATE_NAMES[up]) out.region = STATE_NAMES[up].toLowerCase();
    else if (isState(low)) out.region = low;
    else if (CA_PROVINCES[up]) (out.region = CA_PROVINCES[up].toLowerCase()), (out.country = out.country ?? "CA");
    else if (isProvince(low)) (out.region = low), (out.country = out.country ?? "CA");
    else if (UK_PARTS.has(low)) (out.region = low), (out.country = out.country ?? "GB");
    else if (COUNTRIES[low]) out.country = COUNTRIES[low];
    else if (!out.region) out.region = low;
  }
  // A US state named without a country is in the US.
  if (out.region && !out.country && isState(out.region)) out.country = "US";
  return out;
}

// Pure: every way a candidate's region can be said: its name, its code, and the full name behind a known code.
const regionNames = (c: PlaceCandidate): string[] => {
  const name = String(c.admin1 ?? "").trim();
  const code = String(c.admin1Code ?? "").trim().toUpperCase();
  return [name, code, STATE_NAMES[name.toUpperCase()] ?? "", STATE_NAMES[code] ?? "", CA_PROVINCES[name.toUpperCase()] ?? "", CA_PROVINCES[code] ?? ""].filter(Boolean).map((x) => x.toLowerCase());
};
export const matchesQualifier = (c: PlaceCandidate, q: Qualified): boolean =>
  (!q.region || regionNames(c).includes(q.region)) && (!q.country || String(c.country ?? "").toUpperCase() === q.country);

const namesOf = (c: PlaceCandidate) => [c.name, ...(c.keys ?? [])].map(normName);
export const sameName = (c: PlaceCandidate, name: string) => namesOf(c).includes(normName(name));

// Pure: how a place is shown and searched: "Portland, Maine", "San Francisco Bay Area, California", "Cambridge, England, GB",
// "Washington, US" (the state itself). Always qualified (it always has a comma), so the code downstream that geocodes it by name
// (geocoding.ts geocodeCity) can't mistake it for another one, and it's never a bare shared cache key.
export function placeLabel(c: PlaceCandidate): string {
  const admin = c.admin1 && normName(c.admin1) !== normName(c.name) ? c.admin1 : null;
  const country = String(c.country ?? "").toUpperCase();
  if (country === "US" && admin) return `${c.name}, ${admin}`;
  return [c.name, admin, country || null].filter(Boolean).join(", ");
}

const point = (c: PlaceCandidate): GeoPoint => ({ lat: c.lat, lng: c.lng });

export type Home = { point: GeoPoint; country?: string | null };
export type PickWhy = "near_home" | "only_one" | "most_prominent" | "top_hit";
export type Pick =
  | { status: "resolved"; place: PlaceCandidate; label: string; miles: number | null; why: PickWhy }
  | { status: "ambiguous"; options: string[] }
  | { status: "rejected"; why: "not_that_name" | "not_in_that_region"; options: string[] }
  | { status: "unresolved" };

// Pure: the one place a name means for this member, or why there isn't one.
export function pickPlace(asked: string, cands: PlaceCandidate[], home: Home | null): Pick {
  const q = parseQualified(asked);
  if (!q.name) return { status: "unresolved" };
  if (!cands.length) return { status: "unresolved" };
  let named = cands.filter((c) => sameName(c, q.name));
  // Hits that came back, none of them by that name (the geocoder answered something else): not that place.
  if (!named.length) return { status: "rejected", why: "not_that_name", options: cands.slice(0, 5).map(placeLabel) };
  if (q.region || q.country) {
    const there = named.filter((c) => matchesQualifier(c, q));
    if (!there.length) return { status: "rejected", why: "not_in_that_region", options: named.slice(0, 5).map(placeLabel) };
    named = there;
  }
  const miles = (c: PlaceCandidate) => (home ? haversineMiles(home.point, point(c)) : null);
  const resolved = (c: PlaceCandidate, why: PickWhy): Pick => ({ status: "resolved", place: c, label: placeLabel(c), miles: miles(c), why });
  // A real place: at least minPopulation, or of unknown size when nothing by that name is known to be bigger (a Google hit with no
  // twin, a region). Austin, Nevada (192 people) never wins on nearness while Austin, Texas is a candidate; nor does an unsized hit.
  const bigger = named.some((c) => (c.population ?? 0) >= PLACE_RESOLVE.minPopulation);
  const real = named.filter((c) => (c.population ?? 0) >= PLACE_RESOLVE.minPopulation || (c.population == null && !bigger));
  if (home) {
    const near = real.filter((c) => (miles(c) ?? Infinity) <= PLACE_RESOLVE.nearHomeMiles).sort((a, b) => miles(a)! - miles(b)!);
    if (near.length) return resolved(near[0], "near_home");
  }
  let pool = real.length ? real : named;
  const country = home?.country ?? null;
  if (country) {
    const mine = pool.filter((c) => String(c.country ?? "").toUpperCase() === country);
    if (mine.length) pool = mine;
  }
  if (pool.length === 1) return resolved(pool[0], "only_one");
  const sized = pool.filter((c) => typeof c.population === "number" && c.population > 0).sort((a, b) => b.population! - a.population!);
  // Nothing says how big any of them is: the geocoder's own first answer.
  if (!sized.length) return resolved(pool[0], "top_hit");
  if (sized.length === 1 || sized[0].population! >= PLACE_RESOLVE.dominance * sized[1].population!) return resolved(sized[0], "most_prominent");
  return { status: "ambiguous", options: sized.slice(0, 4).map(placeLabel) };
}

// Pure: one list from the geocoders' answers and the regions: a Google hit and an open-geocoder hit of the same name close together
// are one place (Google's, with the other's population), Google's first.
export function mergeCandidates(google: PlaceCandidate[], openMeteo: PlaceCandidate[], name: string): PlaceCandidate[] {
  const used = new Set<PlaceCandidate>();
  const regions = REGIONS.filter((r) => sameName(r, parseQualified(name).name));
  const out = google.map((g) => {
    const twin = openMeteo.find((o) => !used.has(o) && normName(o.name) === normName(g.name) && haversineMiles(point(o), point(g)) <= PLACE_RESOLVE.mergeMiles);
    if (twin) used.add(twin);
    // A region a geocoder also answered (Google's "San Francisco Bay Area" for "Bay Area") is one place: Google's, going by the
    // region's names too, so it still counts as the name they used.
    const region = regions.find((r) => !used.has(r) && haversineMiles(point(r), point(g)) <= PLACE_RESOLVE.mergeMiles);
    if (region) used.add(region);
    const population = g.population ?? twin?.population ?? region?.population ?? null;
    return { ...g, population, ...(region ? { keys: [...(g.keys ?? []), region.name, ...(region.keys ?? [])] } : {}) };
  });
  return [...out, ...openMeteo.filter((o) => !used.has(o)), ...regions.filter((r) => !used.has(r))];
}

// ---------------------------------------------------------------- the far-from-home check

export type PlaceHow = "confirmed" | "inferred";
// Pure: how a want's place was set. Their own words in the want, or a correction they made, is theirs (confirmed); a place read from
// their other lines is Cue's inference. Only a confirmed place may be searched far from home on its own say-so (Royce, 2026-10-29).
export const placeHow = (source: PlaceSource | "home"): PlaceHow => (source === "their_words" || source === "corrected" ? "confirmed" : "inferred");

export type FarVerdict = "near" | "far_named_by_them" | "far_in_window" | "far_not_searched";
// Pure: whether a resolved place far from home is searched. Far and confirmed: searched (they named it). Far and inferred: searched
// only while this want's own window is open (a trip they told Cue about, for this want and these dates; it ends when the window does).
export function farCheck(o: { miles: number | null; how: PlaceHow; windowEnd: string | null; today: string }): FarVerdict {
  if (o.miles == null || o.miles <= PLACE_RESOLVE.farFromHomeMiles) return "near";
  if (o.how === "confirmed") return "far_named_by_them";
  if (o.windowEnd && o.windowEnd >= o.today) return "far_in_window";
  return "far_not_searched";
}

// ---------------------------------------------------------------- resolving one want's place, with its record

export type StoredResolution = { forPlace: string; forHome: string; status: "resolved" | "ambiguous" | "rejected"; label: string | null; lat: number | null; lng: number | null; options: string[] };
export type WantRow = { windowEnd: string | null; resolution: StoredResolution | null };
export type ResolveDeps = {
  // Their home on the map, and its country as the geocoder gives it (null when it doesn't say).
  home: (city: string) => Promise<Home | null>;
  // The place as they said it ("Portland, ME"): Google reads it whole, the open geocoder by its name. partial: one of them failed.
  lookup: (place: string) => Promise<{ google: PlaceCandidate[]; openMeteo: PlaceCandidate[]; partial?: boolean }>;
  row: (userId: string, key: string) => Promise<WantRow | null>;
  store: (userId: string, key: string, r: StoredResolution) => Promise<void>;
  // The label's point into the shared geocode cache, so what geocodes the label by name downstream gets this exact place.
  seed: (label: string, p: GeoPoint) => Promise<void>;
  log: (d: { decision: string; userId: string; outcome: "act" | "skip"; action: string; proposal: Record<string, unknown> }) => Promise<void>;
  today: (userId: string) => Promise<string>;
};

export type PlaceOnMap = { label: string; miles: number | null; how: PlaceHow; verdict: FarVerdict | "ambiguous" | "rejected" | "unresolved"; from: "stored" | "fresh" };
// retry: this run couldn't place it on the map (a geocoder or their home's lookup down, or no hit at all): nothing is searched this
// run, and the next run tries again (never a guessed place, never the bare word).
export type ResolvedSearch = { city: string | null; skip: string | null; place: PlaceOnMap | null; retry?: string | null };

// One want's place, resolved against their home: the city to search (a qualified label), or why its search is skipped or waits for
// the next run. Nothing here ever falls back to their home for a want that has a place. Never throws.
export async function resolveWantPlace(i: { userId: string; key: string | null; place: string; source: PlaceSource | "home"; homeCity: string | null }, deps: ResolveDeps): Promise<ResolvedSearch> {
  // No home city on file (or no want): the place word as before this existed.
  if (!i.homeCity || !i.key) return { city: i.place, skip: null, place: null };
  const how = placeHow(i.source);
  const base = { key: i.key, how };
  const retry = async (action: string, why: string): Promise<ResolvedSearch> => {
    await deps.log({ decision: "place.unresolved", userId: i.userId, outcome: "skip", action, proposal: base }).catch(() => {});
    return { city: null, skip: null, place: null, retry: why };
  };
  const home = await deps.home(i.homeCity).catch(() => null);
  if (!home) return retry("home_unplaced", "their home city couldn't be placed on the map this run; tried again next run");
  const homePt = home.point;
  const row = await deps.row(i.userId, i.key).catch(() => null);
  let stored = row?.resolution && row.resolution.forPlace === i.place && row.resolution.forHome === i.homeCity ? row.resolution : null;
  const from: PlaceOnMap["from"] = stored ? "stored" : "fresh";
  if (!stored) {
    const hits = await deps.lookup(i.place).catch(() => null);
    const pick = pickPlace(i.place, mergeCandidates(hits?.google ?? [], hits?.openMeteo ?? [], i.place), home);
    if (pick.status === "unresolved") return retry(hits ? "no_hits" : "lookup_failed", hits ? "no place by that name came back this run; tried again next run" : "the geocoders were down this run; tried again next run");
    stored =
      pick.status === "resolved"
        ? { forPlace: i.place, forHome: i.homeCity, status: "resolved", label: pick.label, lat: pick.place.lat, lng: pick.place.lng, options: [] }
        : { forPlace: i.place, forHome: i.homeCity, status: pick.status, label: null, lat: null, lng: null, options: pick.options };
    // An answer from both geocoders is kept; one that came back while either was down is used this once and asked again next time
    // (an outage must not leave a want marked ambiguous for good). A resolved one is kept either way.
    if (stored.status === "resolved" || (hits && !hits.partial)) await deps.store(i.userId, i.key, stored).catch((err: any) => console.error("placeResolve: storing the resolution failed (non-fatal):", err?.message ?? err));
    if (stored.label && stored.lat != null && stored.lng != null) await deps.seed(stored.label, { lat: stored.lat, lng: stored.lng }).catch(() => {});
  }
  if (stored.status !== "resolved" || !stored.label || stored.lat == null || stored.lng == null) {
    const verdict = stored.status === "ambiguous" ? "ambiguous" : "rejected";
    await deps.log({ decision: `place.${verdict}`, userId: i.userId, outcome: "skip", action: "not_searched", proposal: { ...base, options: stored.options, from } }).catch(() => {});
    const skip = verdict === "ambiguous" ? `its place could mean ${stored.options.length} places (${stored.options.join(" / ")}); not searched until it's settled` : `its place didn't resolve to a place by that name in that region (${stored.options.join(" / ") || "no match"}); not searched`;
    return { city: null, skip, place: { label: stored.options.join(" / "), miles: null, how, verdict, from } };
  }
  const miles = Math.round(haversineMiles(homePt, { lat: stored.lat, lng: stored.lng }));
  const today = await deps.today(i.userId).catch(() => "9999-12-31");
  const verdict = farCheck({ miles, how, windowEnd: row?.windowEnd ?? null, today });
  const place: PlaceOnMap = { label: stored.label, miles, how, verdict, from };
  if (verdict === "near") return { city: stored.label, skip: null, place };
  await deps.log({ decision: "place.far_from_home", userId: i.userId, outcome: verdict === "far_not_searched" ? "skip" : "act", action: verdict, proposal: { ...base, place: stored.label, miles, from } }).catch(() => {});
  if (verdict === "far_not_searched") return { city: null, skip: `its place (${stored.label}) is ${miles} mi from home and Cue inferred it; not searched unless they name it or a trip window covers it`, place };
  return { city: stored.label, skip: null, place };
}

// Pure: whether a label may go into the shared geocode cache: qualified only.
export const seedable = (label: string): boolean => label.includes(",");

// ---------------------------------------------------------------- the real lookups and record

// Google types that are a place someone means, not a business, a park or a street.
const GOOGLE_PLACE_TYPES = new Set(["locality", "colloquial_area", "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3", "sublocality", "neighborhood", "postal_town"]);
export async function googleLookup(name: string): Promise<PlaceCandidate[]> {
  if (!googleKey()) return [];
  const { Client } = await import("@googlemaps/google-maps-services-js");
  const r = await new Client({}).geocode({ params: { address: name, region: "us", key: googleKey() } });
  return (r.data.results ?? [])
    .filter((x: any) => !x.partial_match && (x.types ?? []).some((t: string) => GOOGLE_PLACE_TYPES.has(t)))
    .map((x: any) => {
      const comp = (t: string) => (x.address_components ?? []).find((c: any) => (c.types ?? []).includes(t));
      return { name: String(x.address_components?.[0]?.long_name ?? name), lat: x.geometry.location.lat, lng: x.geometry.location.lng, admin1: comp("administrative_area_level_1")?.long_name ?? null, admin1Code: comp("administrative_area_level_1")?.short_name ?? null, country: comp("country")?.short_name ?? null, population: null, source: "google" as const };
    });
}
async function openMeteoLookup(name: string): Promise<PlaceCandidate[]> {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
  if (!res.ok) throw new Error(`open geocoder ${res.status}`);
  const data: any = await res.json();
  return (Array.isArray(data?.results) ? data.results : [])
    // Populated places and administrative areas only: never "Bay Area Park" or an airport.
    .filter((r: any) => /^(PPL|ADM)/.test(String(r.feature_code ?? "")) && typeof r.latitude === "number" && typeof r.longitude === "number")
    .map((r: any) => ({ name: String(r.name), lat: r.latitude, lng: r.longitude, admin1: r.admin1 ?? null, country: r.country_code ?? null, population: typeof r.population === "number" ? r.population : null, source: "open_meteo" as const }));
}

export async function lookupPlace(place: string): Promise<{ google: PlaceCandidate[]; openMeteo: PlaceCandidate[]; partial: boolean }> {
  const [g, o] = await Promise.allSettled([googleLookup(place), openMeteoLookup(parseQualified(place).name)]);
  if (g.status === "rejected" && o.status === "rejected") throw new Error("both geocoders failed");
  return { google: g.status === "fulfilled" ? g.value : [], openMeteo: o.status === "fulfilled" ? o.value : [], partial: g.status === "rejected" || o.status === "rejected" };
}

// Pure: the country of a home point, from the geocoder's hits for its city (the same-named hit at that point), or null.
export function countryAt(p: GeoPoint, cands: PlaceCandidate[]): string | null {
  const hit = cands.find((c) => haversineMiles(p, point(c)) <= PLACE_RESOLVE.mergeMiles && c.country);
  return hit ? String(hit.country).toUpperCase() : null;
}

export const realResolveDeps: ResolveDeps = {
  home: async (city) => {
    const p = await (await import("./geocoding.js")).geocodeCity(city);
    if (!p) return null;
    // Its country from the geocoders (never guessed from a box on the map); unknown leaves no country preference.
    const hits = await lookupPlace(city).catch(() => null);
    return { point: p, country: hits ? countryAt(p, [...hits.google, ...hits.openMeteo]) : null };
  },
  lookup: lookupPlace,
  row: async (userId, key) => {
    const { default: pool } = await import("../db/db.js");
    const { rows } = await pool.query(`SELECT window_end, resolved_for, resolved_home, resolved_status, resolved_label, resolved_lat, resolved_lng, resolved_options FROM want_places WHERE user_id = $1 AND want_key = $2`, [userId, key]);
    const r = rows[0];
    if (!r) return null;
    const end = r.window_end ? (r.window_end instanceof Date ? r.window_end.toISOString().slice(0, 10) : String(r.window_end).slice(0, 10)) : null;
    const resolution: StoredResolution | null = r.resolved_status && r.resolved_for && r.resolved_home
      ? { forPlace: r.resolved_for, forHome: r.resolved_home, status: r.resolved_status, label: r.resolved_label ?? null, lat: r.resolved_lat == null ? null : Number(r.resolved_lat), lng: r.resolved_lng == null ? null : Number(r.resolved_lng), options: Array.isArray(r.resolved_options) ? r.resolved_options.map(String) : [] }
      : null;
    return { windowEnd: end, resolution };
  },
  store: async (userId, key, s) => {
    const { default: pool } = await import("../db/db.js");
    // Only while the place is still the one resolved (a correction made meanwhile wins).
    await pool.query(
      `UPDATE want_places SET resolved_for = $3, resolved_home = $4, resolved_status = $5, resolved_label = $6, resolved_lat = $7, resolved_lng = $8, resolved_options = $9::jsonb, resolved_at = NOW()
        WHERE user_id = $1 AND want_key = $2 AND place = $3`,
      [userId, key, s.forPlace, s.forHome, s.status, s.label, s.lat, s.lng, JSON.stringify(s.options)],
    );
  },
  // Only a qualified label (it has a comma), and never over a row already there: one member's resolution must not change a shared row
  // other members and other code read (review of #314: a Seattle member's "Washington" would have moved the bare row to the state).
  seed: async (label, p) => {
    if (!seedable(label)) return;
    const { default: pool } = await import("../db/db.js");
    await pool.query(`INSERT INTO geocode_cache (query, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (query) DO NOTHING`, [label, p.lat, p.lng]);
  },
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 5, ...d });
  },
  today: async (userId) => {
    const { memberZone, localDay } = await import("./memberTime.js");
    return localDay(new Date(), await memberZone(userId));
  },
};

// ---------------------------------------------------------------- the one-time audit (scripts/auditPlaces.ts)

export type AuditWant = { userId: string; key: string; place: string; source: PlaceSource; homeCity: string | null; resolution: StoredResolution | null };
export type AuditCacheRow = { query: string; lat: number; lng: number };
export type AuditFinding = { kind: "want" | "cache"; ref: string; how: PlaceHow | "cached"; finding: string; action: "report_only" | "clear_resolution" | "delete_cache_row" };

// Pure: what the audit says about each want place and cache row, and what --apply would do. A confirmed place (their words or their
// correction) is reported, never changed. An inferred place's stored resolution is cleared (the next sweep resolves it again). A
// shared cache row is a lookup, not anyone's place: a bad one is deleted.
// fresh: each want's resolution now (pickPlace against their home). conflictMiles: how far a cache row is from where its uses resolve
// now: for a bare row, each member want that names it (resolved against that member's home) and each home city it is (resolved in
// that member's home region); for a qualified row, its own resolution. A bare row that's simply far from someone's home (Austin for a
// Sacramento member who named Austin) agrees with its use and isn't flagged.
export function auditPlan(
  wants: { w: AuditWant; fresh: Pick | null; homeMiles: number | null }[],
  cache: { row: AuditCacheRow; conflictMiles: number | null; conflictWith: "want" | "home" | "itself" | null }[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const { w, fresh, homeMiles } of wants) {
    const how = placeHow(w.source);
    const act = how === "confirmed" ? "report_only" : "clear_resolution";
    const ref = `${w.userId}:${w.key}`;
    if (fresh?.status === "ambiguous") out.push({ kind: "want", ref, how, finding: `ambiguous: ${fresh.options.join(" / ")}`, action: act });
    else if (fresh?.status === "rejected") out.push({ kind: "want", ref, how, finding: `rejected (${fresh.why}): ${fresh.options.join(" / ")}`, action: act });
    else if (fresh?.status === "resolved" && w.resolution?.label && w.resolution.label !== fresh.label) out.push({ kind: "want", ref, how, finding: `stored ${w.resolution.label}, resolves now to ${fresh.label}`, action: act });
    else if (homeMiles != null && homeMiles > PLACE_RESOLVE.farFromHomeMiles && how === "inferred") out.push({ kind: "want", ref, how, finding: `inferred place ${homeMiles} mi from home`, action: act });
  }
  for (const { row, conflictMiles, conflictWith } of cache) {
    if (/^(venue|near):/.test(row.query)) continue;
    if (conflictMiles != null && conflictMiles > PLACE_RESOLVE.mergeMiles)
      out.push({ kind: "cache", ref: row.query, how: "cached", finding: `${conflictMiles} mi from where ${conflictWith === "want" ? "a member's place by that name" : conflictWith === "home" ? "a member's home by that name" : "it"} resolves now`, action: "delete_cache_row" });
  }
  return out;
}

// What --apply does with the audit's findings, and nothing without it (the dry run makes no write at all). A confirmed place is never
// written: its finding is reported only. An inferred place's stored resolution is cleared (never its place or how it was set); a bad
// shared cache row is deleted. Returns the writes it made (or would make, on a dry run).
export async function applyAudit(findings: AuditFinding[], db: { query: (sql: string, args?: unknown[]) => Promise<unknown> }, apply: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const f of findings) {
    if (f.action === "report_only" || f.how === "confirmed") continue;
    if (f.action === "clear_resolution" && f.kind === "want") {
      const at = f.ref.indexOf(":");
      const [userId, key] = [f.ref.slice(0, at), f.ref.slice(at + 1)];
      out.push(`clear resolution ${f.ref}`);
      if (apply) await db.query(`UPDATE want_places SET resolved_for = NULL, resolved_home = NULL, resolved_status = NULL, resolved_label = NULL, resolved_lat = NULL, resolved_lng = NULL, resolved_options = NULL, resolved_at = NULL WHERE user_id = $1 AND want_key = $2 AND source NOT IN ('their_words', 'corrected')`, [userId, key]);
    } else if (f.action === "delete_cache_row" && f.kind === "cache") {
      out.push(`delete cache row "${f.ref}"`);
      if (apply) await db.query(`DELETE FROM geocode_cache WHERE query = $1`, [f.ref]);
    }
  }
  return out;
}
