// Real imagery for Co's artifacts (founder's brief, 2026-10-12: "No artifact ships with zero images"). Found by code when an artifact
// is made, never written by the model, and only ever what it's labelled as. In order:
//   1. the member's own images (their cover, a slide's or section's picture) and a venue's own og:image (ogImage.ts);
//   2. a real venue's photos from Google Places (GOOGLE_PLACES_API_KEY), kept only as the place id and which photo (Google's terms: no
//      Google data is stored), the photo and its author's credit fetched each time it's shown (cached a few minutes at most), and only
//      when the place Google found is the place Co named, in the city named (sameVenue);
//   3. a mood image from Unsplash, only when UNSPLASH_ACCESS_KEY is set (gated on the key, never a toggle): hotlinked from Unsplash's
//      own URL, credited to the photographer and Unsplash with referral links, its download tracked when it's used. Said as "Mood image";
//   4. none: their logo, else a cover Co designs (an abstract composition in their palette, labelled as Co's design, not a photo).
// Maps: Google's Maps Static API isn't enabled on Co's key, and Google's coordinates may not go on a non-Google map, so a map's pins
// come from OpenStreetMap's own geocoder (Nominatim: an identifying User-Agent, one request a second at most, cached) and it's drawn
// from OpenStreetMap's tiles (cached, 7 days), credited "© OpenStreetMap contributors", served only for the tiles an artifact needs.
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { venueKey, type ArtImage, type ArtMap, type Credit, type Grammar, type MapPin } from "./coPages/art.js";

const GOOGLE_KEY = () => process.env.GOOGLE_PLACES_API_KEY ?? "";
const UNSPLASH_KEY = () => process.env.UNSPLASH_ACCESS_KEY ?? "";
export const imageryAvailable = () => ({ places: !!GOOGLE_KEY(), unsplash: !!UNSPLASH_KEY() });
export const ART_DEADLINE_MS = 9_000;
const UA = "CoArtifactMaps/1.0 (+https://copatible.com; low-volume static maps for members' plans)";

// ---------------------------------------------------------------- the venue is the venue

const STOP = new Set(["the", "a", "an", "and", "of", "at", "in", "on", "by", "&"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
// Pure: whether the place found is the one Co named. Both ways (founder's review: "Smith & Wollensky" is not "The Smith", "Bar
// Agricole" is not "Agricole Farmstand"): most of the found name's words are in what Co named AND most of what Co named is in the found
// name (words of the address it named left out). And the city Co named (after the comma) must be in the found place's address
// ("Gagosian, New York" is not Gagosian Paris).
// regions: when the city Co named isn't written in the address (a landmark or an area: "Mt Hood"), the state (else the country) where
// OpenStreetMap puts that area must be the found place's.
export type Region = { state?: string | null; country?: string | null };
export function sameVenue(named: string, found: string, address: string | null = null, regions: { place?: Region | null; city?: Region | null } = {}): boolean {
  const [namePart, ...rest] = named.split(",");
  const addr = new Set(words(address ?? ""));
  const b = words(found);
  const bs = new Set(b);
  // A word of what Co named that's really the city ("Heath Ceramics San Francisco") isn't part of the name.
  const a = [...new Set(words(namePart))].filter((w) => bs.has(w) || !addr.has(w));
  if (!a.length || !b.length) return false;
  const as = new Set(a);
  const hitB = b.filter((w) => as.has(w)).length / b.length;
  const hitA = a.filter((w) => bs.has(w)).length / a.length;
  if (hitB < 0.6 || hitA < 0.6) return false;
  const city = words(rest.join(" ")).filter((w) => !/^\d+$/.test(w));
  if (city.length && address !== null) {
    const ok = city.filter((w) => addr.has(w) || bs.has(w)).length / city.length;
    if (ok < 0.5) {
      const a1 = regions.place, b1 = regions.city;
      const eq = (x?: string | null, y?: string | null) => !!x && !!y && x.trim().toLowerCase() === y.trim().toLowerCase();
      const sameRegion = a1 && b1 && (a1.state && b1.state ? eq(a1.state, b1.state) && eq(a1.country, b1.country) : eq(a1.country, b1.country));
      if (!sameRegion) return false;
    }
  }
  return true;
}
// The name part of what Co named ("Heath Ceramics" for "Heath Ceramics, San Francisco"): the label Co uses, never Google's.
export const placeLabel = (named: string) => named.split(",")[0].trim().slice(0, 90);

export type FoundPlace = { placeId: string; label: string; photos: ArtImage[] };
export type ImageryDeps = { fetch: typeof fetch; now: () => number };
const realDeps: ImageryDeps = { fetch: (...a) => fetch(...a), now: () => Date.now() };

// A real place by what Co named ("Heath Ceramics, San Francisco"): its id, checked against its name and address, and up to n of its
// photos as references (place id and index only). Null when the key is missing, nothing is found, or it isn't the place named.
export async function findPlace(query: string, n = 3, deps: ImageryDeps = realDeps): Promise<FoundPlace | null> {
  if (!GOOGLE_KEY() || !query.trim()) return null;
  const r = await deps
    .fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY(), "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.photos.name" },
      body: JSON.stringify({ textQuery: query.slice(0, 200), maxResultCount: 1 }),
      signal: AbortSignal.timeout(6000),
    })
    .catch(() => null);
  if (!r?.ok) return null;
  const p = ((await r.json().catch(() => null)) as any)?.places?.[0];
  if (!p?.id) return null;
  const name = String(p?.displayName?.text ?? ""), address = String(p?.formattedAddress ?? "");
  if (!sameVenue(query, name, address)) {
    // Only the city failed (an area, not a town, in what Co named): the same state, else country, as where OpenStreetMap puts it.
    const comps: any[] = p.addressComponents ?? [];
    const pick = (t: string) => comps.find((c) => (c.types ?? []).includes(t))?.longText ?? null;
    const place: Region = { state: pick("administrative_area_level_1"), country: comps.find((c) => (c.types ?? []).includes("country"))?.shortText?.toLowerCase() ?? null };
    const cityPart = query.split(",").slice(1).join(",").trim();
    const city = cityPart && sameVenue(query, name, null) ? await osmRegion(cityPart, deps).catch(() => null) : null;
    if (!city || !sameVenue(query, name, address, { place, city })) return null;
  }
  const label = placeLabel(query);
  const count = Math.min(n, (p.photos ?? []).length);
  const photos: ArtImage[] = Array.from({ length: count }, (_, i) => ({ kind: "venue" as const, via: "google" as const, src: venueKey(String(p.id), i), placeId: String(p.id), i, place: label, alt: label }));
  return { placeId: String(p.id), label, photos };
}

// A place's photos and their authors, read when they're shown (never stored with the artifact): cached a few minutes, and a failure
// cached too, so a page view never pays for the same miss twice.
const dCache = new Map<string, { at: number; photos: { name: string; credit: string; creditUrl: string | null }[] | null }>();
const DETAILS_MS = 10 * 60_000;
export async function placeDetails(placeId: string, deps: ImageryDeps = realDeps): Promise<{ name: string; credit: string; creditUrl: string | null }[] | null> {
  if (!GOOGLE_KEY()) return null;
  const hit = dCache.get(placeId);
  if (hit && deps.now() - hit.at < DETAILS_MS) return hit.photos;
  const r = await deps.fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, { headers: { "X-Goog-Api-Key": GOOGLE_KEY(), "X-Goog-FieldMask": "photos.name,photos.authorAttributions" }, signal: AbortSignal.timeout(6000) }).catch(() => null);
  const j: any = r?.ok ? await r.json().catch(() => null) : null;
  const photos = j ? (j.photos ?? []).map((x: any) => ({ name: String(x?.name ?? ""), credit: String(x?.authorAttributions?.[0]?.displayName ?? "").replace(/[<>\r\n]/g, "").slice(0, 120), creditUrl: /^https:\/\//.test(x?.authorAttributions?.[0]?.uri ?? "") ? String(x.authorAttributions[0].uri).slice(0, 400) : null })) : null;
  dCache.set(placeId, { at: deps.now(), photos });
  while (dCache.size > 300) dCache.delete(dCache.keys().next().value as string);
  return photos;
}
// The credit for one venue photo, now: the author of the photo at that same index (the photo and its credit always come together).
export async function venueCredit(p: ArtImage, deps: ImageryDeps = realDeps): Promise<Credit | null> {
  if (p.kind !== "venue" || !p.placeId || p.i == null) return null;
  const ph = (await placeDetails(p.placeId, deps))?.[p.i];
  return ph?.name && ph.credit ? { credit: ph.credit, creditUrl: ph.creditUrl } : null;
}
// Every venue photo's credit for one artifact, fetched before it's rendered (the renderer shows no venue photo without its credit).
export async function googleCredits(data: any, deps: ImageryDeps = realDeps): Promise<(p: ArtImage) => Credit | null> {
  const { googlePhotosIn } = await import("./coPages/art.js");
  const got = new Map<string, Credit | null>();
  await Promise.all(googlePhotosIn(data).map(async (p) => got.set(p.src, await venueCredit(p, deps).catch(() => null))));
  return (p) => got.get(p.src) ?? null;
}

// The bytes of a venue photo, fetched now (the photo at that index, with the credit shown beside it). A short memory cache and a cached
// failure keep a burst of views from paying Google twice.
const gCache = new Map<string, { at: number; got: { data: Buffer; mediaType: string } | null }>();
export async function placePhotoBytes(photo: ArtImage, deps: ImageryDeps = realDeps): Promise<{ data: Buffer; mediaType: string } | null> {
  if (!GOOGLE_KEY() || photo.kind !== "venue" || !photo.placeId || photo.i == null) return null;
  const hit = gCache.get(photo.src);
  if (hit && deps.now() - hit.at < DETAILS_MS) return hit.got;
  const ph = (await placeDetails(photo.placeId, deps))?.[photo.i];
  let got: { data: Buffer; mediaType: string } | null = null;
  if (ph?.name && ph.credit) {
    const r = await deps.fetch(`https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=1600`, { headers: { "X-Goog-Api-Key": GOOGLE_KEY() }, redirect: "follow", signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (r?.ok && /^image\//.test(r.headers.get("content-type") ?? "")) got = { data: Buffer.from(await r.arrayBuffer()), mediaType: (r.headers.get("content-type") ?? "image/jpeg").split(";")[0] };
  }
  gCache.set(photo.src, { at: deps.now(), got });
  while (gCache.size > 60) gCache.delete(gCache.keys().next().value as string);
  return got;
}

// ---------------------------------------------------------------- map pins from OpenStreetMap (Nominatim)

// Nominatim's usage policy: an identifying User-Agent, at most one request a second (one queue for the process), results cached, and
// OpenStreetMap credited (every map says "© OpenStreetMap contributors").
const PIN_DIR = process.env.CO_OSM_CACHE_DIR ? path.join(process.env.CO_OSM_CACHE_DIR, "geocode") : path.join(os.tmpdir(), "co-osm-geocode");
const PIN_TTL = 30 * 24 * 3600_000;
const pCache = new Map<string, { at: number; pin: MapPin | null }>();
let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;
// Where OpenStreetMap puts an area or a town ("Mt Hood"): its state and country, through the same one-a-second queue, cached.
const rCache = new Map<string, Region | null>();
export async function osmRegion(area: string, deps: ImageryDeps = realDeps): Promise<Region | null> {
  const q = area.trim().slice(0, 120).toLowerCase();
  if (!q) return null;
  if (rCache.has(q)) return rCache.get(q)!;
  const run = queue.then(async () => {
    const wait = 1100 - (deps.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = deps.now();
    const r = await deps.fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&addressdetails=1`, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    const j: any = r?.ok ? await r.json().catch(() => null) : null;
    const a = Array.isArray(j) ? j[0]?.address : null;
    return a ? { state: a.state ?? null, country: a.country_code ?? null } : null;
  });
  queue = run.catch(() => null);
  const got = await run.catch(() => null);
  rCache.set(q, got);
  return got;
}

export async function osmPin(named: string, deps: ImageryDeps = realDeps): Promise<MapPin | null> {
  const q = named.trim().slice(0, 200);
  if (!q) return null;
  const key = createHash("sha1").update(q.toLowerCase()).digest("hex");
  const mem = pCache.get(key);
  if (mem && deps.now() - mem.at < PIN_TTL) return mem.pin;
  const file = path.join(PIN_DIR, `${key}.json`);
  const disk = await fs.readFile(file, "utf8").then((t) => JSON.parse(t)).catch(() => null);
  if (disk && deps.now() - disk.at < PIN_TTL) {
    pCache.set(key, disk);
    return disk.pin;
  }
  const run = queue.then(async () => {
    const wait = 1100 - (deps.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = deps.now();
    const r = await deps.fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&addressdetails=1`, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    const j: any = r?.ok ? await r.json().catch(() => null) : null;
    const hit = Array.isArray(j) ? j[0] : null;
    const lat = Number(hit?.lat), lng = Number(hit?.lon);
    // The same check as a photo: what OpenStreetMap found is the place named, in the city named.
    return hit && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, name: String(hit.name || String(hit.display_name ?? "").split(",")[0]), display: String(hit.display_name ?? ""), region: { state: hit.address?.state ?? null, country: hit.address?.country_code ?? null } } : null;
  });
  queue = run.catch(() => null);
  const hit = await run.catch(() => null);
  // The same check as a photo: what OpenStreetMap found is the place named, in the city named (or, for an area, its state).
  let pin: MapPin | null = null;
  if (hit) {
    let ok = sameVenue(q, hit.name, hit.display);
    if (!ok && sameVenue(q, hit.name, null) && q.includes(",")) {
      const city = await osmRegion(q.split(",").slice(1).join(",").trim(), deps).catch(() => null);
      ok = sameVenue(q, hit.name, hit.display, { place: hit.region, city });
    }
    if (ok) pin = { lat: hit.lat, lng: hit.lng, label: placeLabel(q) };
  }
  // A miss is cached for a day, a find for thirty.
  const entry = { at: pin ? deps.now() : deps.now() - PIN_TTL + 24 * 3600_000, pin };
  pCache.set(key, entry);
  await fs.mkdir(PIN_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(file, JSON.stringify(entry)).catch(() => {});
  return pin;
}

// A mood image from Unsplash for a few words (only with UNSPLASH_ACCESS_KEY). Landscape, safe content. Its download is tracked when
// it's used (trackUnsplash), as Unsplash's API guidelines require.
export async function unsplashMood(query: string, deps: ImageryDeps = realDeps): Promise<{ image: ArtImage; downloadLocation: string } | null> {
  if (!UNSPLASH_KEY() || !query.trim()) return null;
  const r = await deps
    .fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query.slice(0, 80))}&orientation=landscape&per_page=5&content_filter=high`, { headers: { Authorization: `Client-ID ${UNSPLASH_KEY()}`, "Accept-Version": "v1" }, signal: AbortSignal.timeout(6000) })
    .catch(() => null);
  if (!r?.ok) return null;
  const ph = (((await r.json().catch(() => null)) as any)?.results ?? []).find((x: any) => /^https:\/\/images\.unsplash\.com\//.test(x?.urls?.regular ?? "") && x?.user?.name && x?.links?.download_location);
  if (!ph) return null;
  const ref = "utm_source=co&utm_medium=referral";
  const profile = /^https:\/\/unsplash\.com\//.test(ph.user.links?.html ?? "") ? `${ph.user.links.html}${ph.user.links.html.includes("?") ? "&" : "?"}${ref}` : null;
  return {
    image: { kind: "mood", src: String(ph.urls.regular).slice(0, 600), alt: `Mood image: ${String(ph.alt_description ?? query).replace(/[<>\r\n]/g, "")}`.slice(0, 140), credit: String(ph.user.name).replace(/[<>\r\n]/g, "").slice(0, 120), creditUrl: profile, via: "unsplash" },
    downloadLocation: String(ph.links.download_location),
  };
}
export async function trackUnsplash(downloadLocation: string, deps: ImageryDeps = realDeps): Promise<void> {
  if (!UNSPLASH_KEY() || !/^https:\/\/api\.unsplash\.com\//.test(downloadLocation)) return;
  await deps.fetch(downloadLocation, { headers: { Authorization: `Client-ID ${UNSPLASH_KEY()}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
}

// ---------------------------------------------------------------- OpenStreetMap tiles

const TILE_DIR = process.env.CO_OSM_CACHE_DIR ? path.join(process.env.CO_OSM_CACHE_DIR, "tiles") : path.join(os.tmpdir(), "co-osm-tiles");
const TILE_TTL = 7 * 24 * 3600_000;
const tCache = new Map<string, { at: number; data: Buffer }>();
const tInflight = new Map<string, Promise<Buffer | null>>();
const tMiss = new Map<string, number>();
// One tile, from the cache when it's there (memory, then disk), else from tile.openstreetmap.org, once.
export async function osmTile(key: string, deps: ImageryDeps = realDeps): Promise<Buffer | null> {
  if (!/^\d{1,2}\/\d{1,6}\/\d{1,6}$/.test(key)) return null;
  const mem = tCache.get(key);
  if (mem && deps.now() - mem.at < TILE_TTL) return mem.data;
  const file = path.join(TILE_DIR, `${createHash("sha1").update(key).digest("hex")}.png`);
  const st = await fs.stat(file).catch(() => null);
  if (st && deps.now() - st.mtimeMs < TILE_TTL) {
    const data = await fs.readFile(file).catch(() => null);
    if (data) return remember(key, data, deps);
  }
  // A tile that failed is not asked for again for ten minutes.
  if (deps.now() - (tMiss.get(key) ?? -Infinity) < 10 * 60_000) return null;
  if (tInflight.has(key)) return tInflight.get(key)!;
  const p = (async () => {
    const r = await deps.fetch(`https://tile.openstreetmap.org/${key}.png`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok || !/image\/png/.test(r.headers.get("content-type") ?? "")) {
      tMiss.set(key, deps.now());
      return null;
    }
    const data = Buffer.from(await r.arrayBuffer());
    await fs.mkdir(TILE_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(file, data).catch(() => {});
    return remember(key, data, deps);
  })().finally(() => tInflight.delete(key));
  tInflight.set(key, p);
  return p;
}
function remember(key: string, data: Buffer, deps: ImageryDeps): Buffer {
  tCache.set(key, { at: deps.now(), data });
  while (tCache.size > 600) tCache.delete(tCache.keys().next().value as string);
  return data;
}

// ---------------------------------------------------------------- filling an artifact

export type ArtReport = { venues: string[]; mood: boolean; map: number; cover: "theirs" | "venue" | "mood" | "og" | "logo" | "design" | "none"; notes: string[]; track: string[]; timedOut?: boolean };

// Pure: what to say about the pictures in Co's one line of choices, honestly.
export function artNote(r: ArtReport, grammarName: string): string {
  const pics =
    r.cover === "venue" ? `the cover is ${r.venues[0]} from Google Maps` : r.cover === "mood" ? "the cover is a mood image from Unsplash" : r.cover === "theirs" ? "the cover is your own photo" : r.cover === "og" ? "the cover is from the venue's own site" : r.cover === "logo" ? "no photos fit, so your logo leads" : r.cover === "design" ? "no photos fit, so the cover is an abstract design of mine in your colors" : "";
  const map = r.map ? `with a map of ${r.map === 1 ? "the place" : `the ${r.map} places`}` : "";
  return `Laid out as ${grammarName}${map ? `, ${map}` : ""}${pics ? `; ${pics}` : ""}.`;
}

// Places to pictures and pins, each place once: Google for its photos (by id), OpenStreetMap for where it is.
async function lookUp(names: (string | undefined)[], n: number, deps: ImageryDeps): Promise<{ found: (FoundPlace | null)[]; pins: (MapPin | null)[] }> {
  const uniq = [...new Set(names.filter((x): x is string => !!x))];
  const f = new Map<string, FoundPlace | null>(), p = new Map<string, MapPin | null>();
  await Promise.all(uniq.map(async (q) => f.set(q, await findPlace(q, n, deps).catch(() => null))));
  for (const q of uniq) p.set(q, await osmPin(q, deps).catch(() => null));
  return { found: names.map((q) => (q ? f.get(q) ?? null : null)), pins: names.map((q) => (q ? p.get(q) ?? null : null)) };
}

// A cover kept from before an edit stays only while it's still right: a mood image, or a venue photo of a place still on it.
const keepCover = (c: ArtImage | undefined, placeIds: Set<string>) => (c && (c.kind === "mood" || (c.placeId && placeIds.has(c.placeId))) ? c : undefined);

// A deck's pictures and map, from the places Co named and a mood for the cover. Inside one deadline: past it, the deck keeps what it
// came in with (on an edit, its imagery as it was). Their own cover picture (coverImage) is never replaced.
export async function fillDeckArt(data: any, o: { mood?: string | null; deadlineMs?: number } = {}, deps: ImageryDeps = realDeps): Promise<{ data: any; report: ArtReport }> {
  const next = JSON.parse(JSON.stringify(data));
  const report: ArtReport = { venues: [], mood: false, map: 0, cover: "none", notes: [], track: [] };
  const grammar: Grammar = next.style?.grammar ?? "editorial";
  const work = (async () => {
    const slides: any[] = next.slides;
    // The deck's main place, when no slide names one: on the slide that names it, else the first that isn't a run of times or courses.
    if (next.place && !slides.some((s) => s.place)) {
      const key = String(next.place).split(",")[0].trim().toLowerCase();
      let at = slides.findIndex((s) => `${s.headline} ${s.bullets.join(" ")}`.toLowerCase().includes(key));
      if (at < 0) at = slides.findIndex((s) => !["timeline", "courses"].includes(s.layout ?? "") && !s.bullets.every((b: string) => /^[^:]{1,18}:\s/.test(b)));
      if (at < 0) at = slides.length - 1;
      slides[at].place = next.place;
    }
    for (const s of slides) {
      delete s.photos;
      delete s.map;
    }
    const { found, pins } = await lookUp(slides.map((s) => s.place), grammar === "fieldguide" || grammar === "catalog" ? 3 : 2, deps);
    const mapPins: MapPin[] = [];
    found.forEach((f, i) => {
      if (slides[i].place && !f && !pins[i]) report.notes.push(`couldn't find ${slides[i].place}`);
      if (f) {
        if (!report.venues.includes(f.label)) report.venues.push(f.label);
        if (f.photos.length) slides[i].photos = f.photos;
      }
      const pin = pins[i];
      if (pin && !mapPins.some((p) => p.label === pin.label)) mapPins.push(pin);
    });
    // Anything location-based gets a map: on the slide Co laid out as a map, else the first slide with a place on the map.
    if (mapPins.length) {
      let at = slides.findIndex((s, i) => s.layout === "map" && pins[i]);
      if (at < 0) at = pins.findIndex(Boolean);
      slides[at].map = { pins: mapPins.slice(0, 8) };
      slides[at].layout = "map";
      report.map = Math.min(8, mapPins.length);
    }
    for (const s of slides) if (s.layout === "map" && !s.map) delete s.layout;
    const ids = new Set(found.filter(Boolean).map((f) => f!.placeId));
    next.coverArt = keepCover(next.coverArt, ids);
    if (!next.coverArt) delete next.coverArt;
    delete next.coverDesign;
    const mapAt = slides.findIndex((s) => s.map);
    if (next.coverImage) report.cover = "theirs";
    else if (next.coverArt) report.cover = next.coverArt.kind === "mood" ? "mood" : "venue";
    else {
      // The cover: a venue's photo (from the map slide first: it shows none itself), else a mood image, else their own picture.
      const pool = [...(mapAt >= 0 ? slides[mapAt].photos ?? [] : []), ...slides.flatMap((s, i) => (i === mapAt ? [] : s.photos ?? []))];
      const theirs = slides.find((s) => s.image)?.image;
      const m = !pool[0] && o.mood ? await unsplashMood(o.mood, deps).catch(() => null) : null;
      if (pool[0]) {
        next.coverArt = pool[0];
        report.cover = "venue";
      } else if (m) {
        next.coverArt = m.image;
        report.cover = "mood";
        report.mood = true;
        report.track.push(m.downloadLocation);
      } else if (theirs) {
        next.coverImage = theirs;
        report.cover = "theirs";
      }
    }
    if (next.coverArt?.kind === "venue") for (const s of slides) if (s.photos) s.photos = s.photos.filter((p: ArtImage) => p.src !== next.coverArt.src);
    // The map slide shows no photos: the rest of its place's photos go on the next slide with no picture or place of its own.
    if (mapAt >= 0 && slides[mapAt].photos?.length) {
      const rest = slides[mapAt].photos;
      delete slides[mapAt].photos;
      const to = slides.findIndex((s, i) => i > mapAt && !s.image && !s.photos?.length && !s.map && !s.place);
      if (to >= 0) slides[to].photos = rest;
    }
    for (const s of slides) if (s.photos && !s.photos.length) delete s.photos;
    if (report.cover === "none") {
      if (next.logo) report.cover = "logo";
      else if (!slides.some((s) => s.image || s.photos?.length || s.map)) {
        next.coverDesign = true;
        report.cover = "design";
      }
    }
  })();
  const ok = await Promise.race([work.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), o.deadlineMs ?? ART_DEADLINE_MS))]);
  if (!ok) return { data, report: { venues: [], mood: false, map: 0, cover: data.coverImage ? "theirs" : data.coverArt ? (data.coverArt.kind === "mood" ? "mood" : "venue") : data.logo ? "logo" : data.coverDesign ? "design" : "none", notes: ["the pictures took too long to find, so it keeps what it had"], track: [], timedOut: true } };
  return { data: next, report };
}

// A page's pictures and map, the same way: each section Co tied to a place gets its photos, the page a map of every place, and a
// cover when it has none of its own.
export async function fillPageArt(data: any, o: { mood?: string | null; deadlineMs?: number } = {}, deps: ImageryDeps = realDeps): Promise<{ data: any; report: ArtReport }> {
  const next = JSON.parse(JSON.stringify(data));
  const report: ArtReport = { venues: [], mood: false, map: 0, cover: "none", notes: [], track: [] };
  const grammar: Grammar = next.style?.grammar ?? next.grammar ?? "editorial";
  const work = (async () => {
    if (next.place && !next.sections.some((s: any) => s.place)) {
      const key = String(next.place).split(",")[0].trim().toLowerCase();
      const at = Math.max(0, next.sections.findIndex((s: any) => JSON.stringify(s.blocks).toLowerCase().includes(key) || s.heading.toLowerCase().includes(key)));
      next.sections[at].place = next.place;
    }
    for (const s of next.sections) delete s.photos;
    delete next.map;
    const { found, pins } = await lookUp(next.sections.map((s: any) => s.place), grammar === "fieldguide" ? 3 : 1, deps);
    const mapPins: MapPin[] = [];
    found.forEach((f, i) => {
      const s = next.sections[i];
      if (s.place && !f && !pins[i]) report.notes.push(`couldn't find ${s.place}`);
      if (f) {
        if (!report.venues.includes(f.label)) report.venues.push(f.label);
        if (f.photos.length) s.photos = f.photos;
      }
      const pin = pins[i];
      if (pin && !mapPins.some((p) => p.label === pin.label)) mapPins.push(pin);
    });
    if (mapPins.length) {
      next.map = { pins: mapPins.slice(0, 8) };
      report.map = Math.min(8, mapPins.length);
    }
    const ids = new Set(found.filter(Boolean).map((f) => f!.placeId));
    next.coverArt = keepCover(next.coverArt, ids);
    if (!next.coverArt) delete next.coverArt;
    delete next.coverDesign;
    if (next.coverImage) report.cover = "theirs";
    else if (next.cover) report.cover = "og";
    else if (next.coverArt) report.cover = next.coverArt.kind === "mood" ? "mood" : "venue";
    else {
      const first = next.sections.flatMap((s: any) => s.photos ?? [])[0];
      const theirs = next.sections.find((s: any) => s.asset)?.asset;
      const m = !first && o.mood ? await unsplashMood(o.mood, deps).catch(() => null) : null;
      if (first) {
        next.coverArt = first;
        report.cover = "venue";
      } else if (m) {
        next.coverArt = m.image;
        report.cover = "mood";
        report.mood = true;
        report.track.push(m.downloadLocation);
      } else if (theirs) {
        next.coverImage = theirs;
        report.cover = "theirs";
      }
    }
    if (next.coverArt?.kind === "venue") for (const s of next.sections) if (s.photos) s.photos = s.photos.filter((p: ArtImage) => p.src !== next.coverArt.src);
    for (const s of next.sections) if (s.photos && !s.photos.length) delete s.photos;
    if (report.cover === "none") {
      if (next.logo) report.cover = "logo";
      else if (!next.map && !next.sections.some((s: any) => s.asset || s.image || s.photos?.length)) {
        next.coverDesign = true;
        report.cover = "design";
      }
    }
  })();
  const ok = await Promise.race([work.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), o.deadlineMs ?? ART_DEADLINE_MS))]);
  if (!ok) return { data, report: { venues: [], mood: false, map: 0, cover: data.coverImage ? "theirs" : data.cover ? "og" : data.coverArt ? (data.coverArt.kind === "mood" ? "mood" : "venue") : data.logo ? "logo" : data.coverDesign ? "design" : "none", notes: ["the pictures took too long to find, so it keeps what it had"], track: [], timedOut: true } };
  return { data: next, report };
}

// Pure: an edit carries the artifact's imagery as it was (each slide's or section's photos and map by its headline or place, the cover,
// a designed cover), so a search that runs out of time keeps it rather than dropping it; a search that finishes re-checks it all.
export function carryArt(next: any, was: any): any {
  if (!was) return next;
  const out = JSON.parse(JSON.stringify(next));
  const same = (a: any, b: any) => String(a?.headline ?? a?.heading ?? "").trim().toLowerCase() === String(b?.headline ?? b?.heading ?? "").trim().toLowerCase() || (!!a?.place && a.place === b?.place);
  const parts = out.kind === "deck" ? out.slides : out.sections;
  const wasParts = was.kind === "deck" ? was.slides ?? [] : was.sections ?? [];
  for (const x of parts ?? []) {
    const w = wasParts.find((y: any) => same(x, y));
    if (!w) continue;
    if (w.photos && !x.photos) x.photos = w.photos;
    if (w.map && !x.map) x.map = w.map;
  }
  if (was.map && !out.map && out.kind !== "deck") out.map = was.map;
  if (was.coverArt && !out.coverArt && !out.coverImage) out.coverArt = was.coverArt;
  if (was.coverDesign && !out.coverArt && !out.coverImage) out.coverDesign = true;
  return out;
}

// What a renderer needs to show an artifact's art inlined (design QA, the PDF and PowerPoint at download time): every picture and tile
// as data, and each venue photo's credit, fetched now. A venue photo whose bytes or credit can't be had isn't shown.
export type ArtResolver = { src: (ref: string) => string | null; credit: (p: ArtImage) => Credit | null };
export async function artDataUris(data: any, deps: ImageryDeps = realDeps): Promise<ArtResolver> {
  const { googlePhotosIn, tilesIn } = await import("./coPages/art.js");
  const map = new Map<string, string>();
  const credits = new Map<string, Credit | null>();
  await Promise.all(
    googlePhotosIn(data).map(async (p) => {
      const c = await venueCredit(p, deps).catch(() => null);
      const b = c ? await placePhotoBytes(p, deps).catch(() => null) : null;
      if (c && b) {
        credits.set(p.src, c);
        map.set(`g:${p.src}`, `data:${b.mediaType};base64,${b.data.toString("base64")}`);
      }
    }),
  );
  const moods: ArtImage[] = [data?.coverArt, ...(data?.slides ?? []).flatMap((s: any) => s.photos ?? []), ...(data?.sections ?? []).flatMap((s: any) => s.photos ?? [])].filter((p: any) => p?.via === "unsplash");
  const { safeFetch } = await import("./linkReader.js");
  for (const p of moods) {
    const r: any = await safeFetch(p.src, { binary: true }).catch(() => null);
    if (r && !("error" in r) && r.status === 200 && /^image\//.test(r.contentType) && r.bytes?.length) map.set(`u:${p.src}`, `data:${r.contentType.split(";")[0]};base64,${r.bytes.toString("base64")}`);
  }
  await Promise.all(
    tilesIn(data).map(async (k) => {
      const b = await osmTile(k, deps).catch(() => null);
      if (b) map.set(`t:${k}`, `data:image/png;base64,${b.toString("base64")}`);
    }),
  );
  return { src: (ref) => map.get(ref) ?? null, credit: (p) => credits.get(p.src) ?? null };
}

// The bytes behind one of an artifact's art routes (routes/coPage.ts): the k-th venue photo it shows, or a tile its maps need.
export async function artBytes(data: any, ref: { google?: number; tile?: string }, deps: ImageryDeps = realDeps): Promise<{ data: Buffer; mediaType: string } | null> {
  const { googlePhotosIn, tilesIn } = await import("./coPages/art.js");
  if (ref.google !== undefined) {
    const p = googlePhotosIn(data)[ref.google];
    return p ? placePhotoBytes(p, deps) : null;
  }
  if (ref.tile && tilesIn(data).includes(ref.tile)) {
    const b = await osmTile(ref.tile, deps);
    return b ? { data: b, mediaType: "image/png" } : null;
  }
  return null;
}

// A map as one picture (for PowerPoint, which can't lay tiles), drawn by the headless browser from the same tiles, pins and credit.
export async function mapPng(m: ArtMap, artSrc: (ref: string) => string | null): Promise<string | null> {
  const B = await import("./browserRead.js");
  if (!B.browserReadEnabled()) return null;
  const { mapHtml } = await import("./coPages/art.js");
  const { escapeHtml } = await import("./emailDesign.js");
  const css = `html,body{margin:0}.map{position:relative;margin:0;width:1024px;height:640px;overflow:hidden;background:#E8E4DC;font-family:Arial,sans-serif}.mapc{position:absolute;inset:0}.tile{position:absolute;display:block}.pin{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:4px}.pin b{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#B5652E;color:#fff;font-size:13px}.pl{order:-1;background:#fff;color:#111;font-size:14px;padding:2px 8px;border-radius:3px;white-space:nowrap}.osm{position:absolute;right:0;bottom:0;font-size:13px;background:rgba(255,255,255,.9);padding:2px 8px;margin:0}.osm a{color:#222;text-decoration:none}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${mapHtml(m, escapeHtml, (k) => artSrc(`t:${k}`))}</body></html>`;
  const release = await B.browserSlot();
  let ctx: any = null;
  try {
    ctx = await (await B.sharedBrowser()).newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1, javaScriptEnabled: false });
    await ctx.route("**/*", (r: any) => (r.request().url().startsWith("data:") || r.request().url() === "about:blank" ? r.continue() : r.abort()));
    const pg = await ctx.newPage();
    await pg.setContent(html, { waitUntil: "load", timeout: 15_000 });
    const png = Buffer.from(await pg.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1024, height: 640 } }));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  } finally {
    await ctx?.close().catch(() => {});
    release();
  }
}
