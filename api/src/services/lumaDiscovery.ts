import { generateEmbedding } from "./embeddings.js";
import { geocodeCity, haversineMiles, type GeoPoint } from "./geocoding.js";
import type { StatedIntent } from "./matching.js";

// UNOFFICIAL — kept deliberately separate from luma.ts. This calls
// api.luma.com/discover/get-paginated-events, not public-api.luma.com — a
// different domain, unauthenticated, undocumented on docs.luma.com. It's
// almost certainly what powers Luma's own public Discover page for
// anonymous browsing, not a supported third-party integration surface.
// Lower risk than the session-cookie mechanism (no credentials, nothing
// borrowed from a user, genuinely public with zero access control) but not
// confirmed safe either — Luma owes it no stability guarantee and could
// change or remove it without notice. Treat every field here as best-effort.
const DISCOVER_URL = "https://api.luma.com/discover/get-paginated-events";

export type DiscoveredEvent = {
  api_id: string;
  name: string;
  start_at: string;
  city: string | null;
  url: string;
};

// The location filter is confirmed (2026-09-16): discover_place_api_id,
// the id Luma's own city pages use. Without it the feed is personalised by
// the caller's IP, which from a datacenter returned one day of events for
// whatever city Luma guessed — every question about a later day found
// nothing. With it, results are the city's own upcoming events across days.
// The id comes from the city page itself (lu.ma/sf), cached in memory.
// Luma's own catalog of discover cities, published in the page data of
// lu.ma/discover: name, slug, api id and coordinates for each. Read once a
// day and matched against wherever the person actually says they are, so
// this works for any city Luma covers rather than a list we maintain.
const DISCOVER_PAGE = "https://lu.ma/discover";
const PLACE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// How far from a city Luma still counts as that city's scene.
const PLACE_MAX_MILES = 75;

export type DiscoverPlace = { apiId: string; name: string; slug: string; lat: number; lng: number };

let placeCache: { at: number; places: DiscoverPlace[] } | null = null;

export function parseDiscoverPlaces(html: string): DiscoverPlace[] {
  const raw = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return [];
  try {
    const entries = JSON.parse(raw)?.props?.pageProps?.initialData?.places ?? [];
    return entries
      .map((entry: any) => entry?.place ?? entry)
      .filter((p: any) => p?.api_id && p?.name && p?.coordinate)
      .map((p: any) => ({ apiId: p.api_id, name: p.name, slug: p.slug ?? "", lat: Number(p.coordinate.latitude), lng: Number(p.coordinate.longitude) }))
      .filter((p: DiscoverPlace) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  } catch {
    return [];
  }
}

export async function discoverPlaces(): Promise<DiscoverPlace[]> {
  if (placeCache && Date.now() - placeCache.at < PLACE_CACHE_TTL_MS) return placeCache.places;
  let places: DiscoverPlace[] = [];
  try {
    const res = await fetch(DISCOVER_PAGE, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (res.ok) places = parseDiscoverPlaces(await res.text());
  } catch (err: any) {
    console.error("lumaDiscovery: place catalog fetch failed (non-fatal):", err?.message ?? err);
  }
  if (places.length) placeCache = { at: Date.now(), places };
  return places.length ? places : (placeCache?.places ?? []);
}

// Pure: the closest city in the catalog, by name or by distance.
export function nearestPlace(places: DiscoverPlace[], city: string, point: GeoPoint | null): DiscoverPlace | null {
  const wanted = city.trim().toLowerCase();
  const named = places.find((p) => p.name.toLowerCase() === wanted || p.slug.toLowerCase() === wanted);
  if (named) return named;
  if (!point) return null;
  let best: { place: DiscoverPlace; miles: number } | null = null;
  for (const place of places) {
    const miles = haversineMiles(point, { lat: place.lat, lng: place.lng });
    if (miles <= PLACE_MAX_MILES && (!best || miles < best.miles)) best = { place, miles };
  }
  return best?.place ?? null;
}

// The id Luma's city pages use, for wherever this person actually is. Null
// when they have no city on file or Luma doesn't cover it — the feed then
// falls back to unfiltered, as before.
export async function discoverPlaceId(city: string | null): Promise<string | null> {
  return (await discoverPlaceFor(city))?.apiId ?? null;
}
// The catalog's own place for wherever this person is, or null. The Luma search through Exa (services/lumaViaExa.ts) names a city
// only by this place's name, never by what it was given.
export async function discoverPlaceFor(city: string | null): Promise<DiscoverPlace | null> {
  if (!city?.trim()) return null;
  const [places, point] = await Promise.all([discoverPlaces(), geocodeCity(city).catch(() => null)]);
  if (!places.length) return null;
  return nearestPlace(places, city, point);
}

// One page of the discover feed is a single day, so the days after today
// need the cursor (Royce, 2026-09-16: "what's been surfacing on Luma this
// weekend" found nothing on Luma at all).
const PAGE_SIZE = 20;

// How far a search with no named time frame needs the feed to reach: Tier 2's
// lookahead (tieredRecommendation.ts TIER2_MAX_LOOKAHEAD_DAYS).
export const DEFAULT_FEED_DAYS = 14;

// Page cap, whatever the window. 20 pages is 400 events.
const MAX_PAGES = 20;

// Pages until the feed reaches `until` (default: DEFAULT_FEED_DAYS from now)
// and holds at least `limit` events, within the page cap. It used to stop at
// `limit` whenever no until was given, since reachedUntil() was always true
// then: 50 events is about three pages, not the ~9 days the comments meant, so
// "anything Friday?" on a Monday could come back empty (code review,
// 2026-09-17). Returns everything fetched; callers filter to their window.
export async function fetchPublicEvents(limit: number, city?: string | null, until?: Date | null): Promise<DiscoveredEvent[]> {
  const placeId = await discoverPlaceId(city ?? null);
  const out: DiscoveredEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  const reach = until ?? new Date(Date.now() + DEFAULT_FEED_DAYS * 24 * 60 * 60 * 1000);
  const reachedUntil = () => out.length > 0 && new Date(out[out.length - 1].start_at) > reach;
  for (let page = 0; page < MAX_PAGES && (out.length < limit || !reachedUntil()); page++) {
    const url = new URL(DISCOVER_URL);
    url.searchParams.set("pagination_limit", String(PAGE_SIZE));
    if (placeId) url.searchParams.set("discover_place_api_id", placeId);
    if (cursor) url.searchParams.set("pagination_cursor", cursor);

    const res = await fetch(url);
    if (!res.ok) {
      // A later page failing still leaves the earlier ones usable.
      if (out.length) break;
      throw new Error(`lumaDiscovery: fetchPublicEvents failed (${res.status}): ${await res.text()}`);
    }
    const data: any = await res.json();
    for (const entry of data.entries ?? []) {
      const e = entry.event ?? entry;
      if (!e?.api_id || !e?.name || seen.has(e.api_id)) continue;
      seen.add(e.api_id);
      out.push({
        api_id: e.api_id,
        name: e.name,
        start_at: e.start_at,
        city: e.geo_address_info?.city ?? null,
        url: `https://lu.ma/${e.url}`,
      });
    }
    cursor = typeof data.next_cursor === "string" ? data.next_cursor : null;
    if (!data.has_more || !cursor) break;
  }
  return out;
}

// Calibrated against real data (Royce, 2026-09-02) — the 0.72 first-guess
// default turned out to reject even a textbook-perfect match: "Looking to
// meet other AI builders and founders in San Francisco..." vs a real,
// live "AI Builders Breakfast @ Tesla" (San Francisco, next day) scored
// only 0.517 — nowhere close to 0.72. This embedding model's cosine
// similarity for a full-sentence ask against a short event-name candidate
// just runs lower than 0.72 would ever allow, regardless of how good the
// match actually is — a real ceiling issue with the old value, not a case
// of that one match being unusually weak.
//
// Live-measured spread across a mix of real candidates: genuine
// good-to-strong matches landed at 0.406-0.517 (AI Builders Breakfast:
// 0.517; a founder-focused coffee meetup: 0.406); genuinely unrelated
// events (a fragrance talk, an adults' game night, a microscopy lunch
// talk) landed at 0.087-0.201 — including one event whose NAME sounded
// AI-adjacent ("The Agent Has Entered the Chat") but scored 0.169, closer
// to the unrelated cluster than the real matches. 0.35 sits in the clear
// gap between those two clusters, with real margin on both sides.
const RELEVANCE_THRESHOLD = 0.35;

export async function rankByRelevance<T extends { name: string; city?: string | null }>(
  candidates: T[],
  ask: StatedIntent,
): Promise<(T & { similarity: number }) | null> {
  if (!ask.text || !candidates.length) return null;

  const askEmbedding = ask.embedding?.length ? ask.embedding : await generateEmbedding(ask.text).catch(() => null);
  if (!askEmbedding) return null;

  const candidateEmbeddings = await Promise.all(
    candidates.map((c) => generateEmbedding(c.name).catch(() => null)),
  );

  let best: (T & { similarity: number }) | null = null;
  candidates.forEach((candidate, i) => {
    const embedding = candidateEmbeddings[i];
    if (!embedding) return;
    const similarity = cosineSimilarity(askEmbedding, embedding);
    if (similarity >= RELEVANCE_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { ...candidate, similarity };
    }
  });

  return best;
}


// The one place in this codebase that computes cosine similarity in JS
// instead of via pgvector's <=> — these embeddings never touch the
// database (the events aren't Co's own data), so there's no SQL table to
// push the comparison into.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
