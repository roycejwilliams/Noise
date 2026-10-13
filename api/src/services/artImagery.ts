// Real imagery for Co's artifacts (founder's brief, 2026-10-12: "No artifact ships with zero images"). Found by code when an artifact
// is made, never written by the model, and only ever what it's labelled as. In order:
//   1. the member's own images (their numbered images, placed by Co: memberAssets.ts) and a venue's own og:image (ogImage.ts);
//   2. a real venue's photos from Google Places (GOOGLE_PLACES_API_KEY), credited to their author and to Google Maps, served through
//      the artifact's own link so the key never reaches a page; the photo is only kept when the place Google found is the place Co
//      named (sameVenue);
//   3. a mood image from Unsplash, only when UNSPLASH_ACCESS_KEY is set (gated on the key, never a toggle): hotlinked from Unsplash's
//      own URL, credited to the photographer and Unsplash with referral links, and its download tracked when it's used, as their API
//      guidelines require. Said as "Mood image", never as the place;
//   4. none: the renderer sets their logo, or a typographic plate (art.ts typePlate).
// Maps: Google's Maps Static API isn't enabled on Co's key (checked 2026-10-12), so maps are drawn from OpenStreetMap's tiles (art.ts
// mapView), fetched by the server with an identifying User-Agent, cached (memory and disk, 7 days), at low volume, credited
// "© OpenStreetMap contributors", and served only for the tiles a live artifact's own maps need.
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { ArtImage, ArtMap, Grammar, MapPin } from "./coPages/art.js";

const GOOGLE_KEY = () => process.env.GOOGLE_PLACES_API_KEY ?? "";
const UNSPLASH_KEY = () => process.env.UNSPLASH_ACCESS_KEY ?? "";
export const imageryAvailable = () => ({ places: !!GOOGLE_KEY(), unsplash: !!UNSPLASH_KEY() });
export const ART_DEADLINE_MS = 9_000;

// ---------------------------------------------------------------- the venue is the venue

const STOP = new Set(["the", "a", "an", "and", "of", "at", "in", "on", "by", "&", "co", "inc", "llc", "restaurant", "bar", "cafe", "gallery", "studio", "hotel", "shop", "store"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
// Pure: whether the place Google found is the one Co named (its name part, before any comma): most of the found name's own words are
// in what Co named, or the reverse. A photo of some other place is never labelled as this one.
export function sameVenue(named: string, found: string): boolean {
  const a = new Set(words(named.split(",")[0]));
  const b = words(found);
  if (!a.size || !b.length) return false;
  const hit = b.filter((w) => a.has(w)).length;
  return hit / b.length >= 0.5 || hit / a.size >= 0.6;
}

export type FoundPlace = { id: string; name: string; pin: MapPin; photos: ArtImage[] };
export type ImageryDeps = { fetch: typeof fetch; now: () => number };
const realDeps: ImageryDeps = { fetch: (...a) => fetch(...a), now: () => Date.now() };

// A real place by what Co named ("Heath Ceramics, San Francisco"): its position and up to n photos, each credited. Null when the key
// is missing, nothing is found, or what's found isn't the place named.
export async function findPlace(query: string, n = 3, deps: ImageryDeps = realDeps): Promise<FoundPlace | null> {
  if (!GOOGLE_KEY() || !query.trim()) return null;
  const r = await deps
    .fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY(), "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.photos.name,places.photos.authorAttributions" },
      body: JSON.stringify({ textQuery: query.slice(0, 200), maxResultCount: 1 }),
      signal: AbortSignal.timeout(6000),
    })
    .catch(() => null);
  if (!r?.ok) return null;
  const p = ((await r.json().catch(() => null)) as any)?.places?.[0];
  const name = String(p?.displayName?.text ?? "");
  if (!p?.id || !name || !Number.isFinite(p?.location?.latitude) || !sameVenue(query, name)) return null;
  const photos: ArtImage[] = (p.photos ?? [])
    .filter((ph: any) => typeof ph?.name === "string" && ph.authorAttributions?.[0]?.displayName)
    .slice(0, n)
    .map((ph: any) => ({
      kind: "venue" as const,
      src: ph.name,
      alt: `${name}`.slice(0, 140),
      credit: String(ph.authorAttributions[0].displayName).replace(/[<>\r\n]/g, "").slice(0, 120),
      creditUrl: /^https:\/\//.test(ph.authorAttributions[0].uri ?? "") ? String(ph.authorAttributions[0].uri).slice(0, 400) : null,
      via: "google" as const,
      placeId: String(p.id),
      place: name.replace(/[<>\r\n]/g, "").slice(0, 90),
    }));
  return { id: String(p.id), name, pin: { lat: Number(p.location.latitude), lng: Number(p.location.longitude), label: name.slice(0, 90) }, photos };
}

// The bytes of a Google photo, for the artifact's own link (never cached past a few minutes, as Google's terms ask). A photo name
// can expire: then the place is read again by its id and its photo at the same place in the list is used.
const gCache = new Map<string, { at: number; data: Buffer; type: string }>();
export async function placePhotoBytes(photo: ArtImage, deps: ImageryDeps = realDeps): Promise<{ data: Buffer; mediaType: string } | null> {
  if (!GOOGLE_KEY() || photo.via !== "google") return null;
  const hit = gCache.get(photo.src);
  if (hit && deps.now() - hit.at < 10 * 60_000) return { data: hit.data, mediaType: hit.type };
  const get = async (name: string) => {
    const r = await deps.fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=1600`, { headers: { "X-Goog-Api-Key": GOOGLE_KEY() }, redirect: "follow", signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok || !/^image\//.test(r.headers.get("content-type") ?? "")) return null;
    return { data: Buffer.from(await r.arrayBuffer()), mediaType: (r.headers.get("content-type") ?? "image/jpeg").split(";")[0] };
  };
  let got = await get(photo.src);
  if (!got && photo.placeId) {
    const r = await deps.fetch(`https://places.googleapis.com/v1/places/${photo.placeId}`, { headers: { "X-Goog-Api-Key": GOOGLE_KEY(), "X-Goog-FieldMask": "photos.name" }, signal: AbortSignal.timeout(6000) }).catch(() => null);
    const fresh = r?.ok ? (((await r.json().catch(() => null)) as any)?.photos ?? []).map((x: any) => x.name).filter(Boolean) : [];
    if (fresh[0]) got = await get(fresh[0]);
  }
  if (got) {
    gCache.set(photo.src, { at: deps.now(), data: got.data, type: got.mediaType });
    while (gCache.size > 60) gCache.delete(gCache.keys().next().value as string);
  }
  return got;
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

const TILE_DIR = path.join(os.tmpdir(), "co-osm-tiles");
const TILE_TTL = 7 * 24 * 3600_000;
const tCache = new Map<string, { at: number; data: Buffer }>();
const tInflight = new Map<string, Promise<Buffer | null>>();
const UA = "CoArtifactMaps/1.0 (+https://copatible.com; low-volume static maps for members' plans)";
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
  if (tInflight.has(key)) return tInflight.get(key)!;
  const p = (async () => {
    const r = await deps.fetch(`https://tile.openstreetmap.org/${key}.png`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok || !/image\/png/.test(r.headers.get("content-type") ?? "")) return null;
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

export type ArtReport = { venues: string[]; mood: boolean; map: number; cover: "theirs" | "venue" | "mood" | "og" | "logo" | "plate" | "none"; notes: string[]; track: string[] };

// Pure: what to say about the pictures in Co's one line of choices, honestly.
export function artNote(r: ArtReport, grammarName: string): string {
  const pics =
    r.cover === "venue" ? `the cover is ${r.venues[0]} from Google Maps` : r.cover === "mood" ? "the cover is a mood image from Unsplash" : r.cover === "theirs" ? "the cover is your own photo" : r.cover === "og" ? "the cover is from the venue's own site" : r.cover === "logo" ? "no photos fit, so your logo leads" : r.cover === "plate" ? "no photos fit, so the cover is a typographic plate" : "";
  const map = r.map ? `with a map of ${r.map === 1 ? "the place" : `the ${r.map} places`}` : "";
  return `Laid out as ${grammarName}${map ? `, ${map}` : ""}${pics ? `; ${pics}` : ""}.`;
}

// A deck's pictures and map, from the places Co named on its slides and a mood for the cover. Inside one deadline: past it, the deck
// goes with what was found. Their own cover picture (coverImage) is never replaced.
export async function fillDeckArt(data: any, o: { mood?: string | null; deadlineMs?: number } = {}, deps: ImageryDeps = realDeps): Promise<{ data: any; report: ArtReport }> {
  const next = JSON.parse(JSON.stringify(data));
  const report: ArtReport = { venues: [], mood: false, map: 0, cover: "none", notes: [], track: [] };
  const grammar: Grammar = next.style?.grammar ?? "editorial";
  const work = (async () => {
    const slides: any[] = next.slides;
    const found = await Promise.all(slides.map((s) => (s.place ? findPlace(s.place, grammar === "fieldguide" || grammar === "catalog" ? 3 : 2, deps).catch(() => null) : Promise.resolve(null))));
    const pins: MapPin[] = [];
    found.forEach((f, i) => {
      // A place that isn't found is said plainly, and never pictured.
      if (!f) {
        if (slides[i].place) report.notes.push(`couldn't find ${slides[i].place} on the map`);
        delete slides[i].photos;
        delete slides[i].map;
        return;
      }
      report.venues.push(f.name);
      if (!pins.some((p) => p.label === f.pin.label)) pins.push(f.pin);
      slides[i].photos = f.photos;
    });
    // Anything location-based gets a map: on the slide Co laid out as a map, else the first slide with a place.
    if (pins.length) {
      const at = slides.findIndex((s, i) => s.layout === "map" && found[i]) >= 0 ? slides.findIndex((s, i) => s.layout === "map" && found[i]) : found.findIndex(Boolean);
      slides[at].map = { pins: pins.slice(0, 8) };
      slides[at].layout = "map";
      report.map = Math.min(8, pins.length);
    }
    for (const s of slides) if (s.layout === "map" && !s.map) delete s.layout;
    if (next.coverImage) report.cover = "theirs";
    else if (next.coverArt) report.cover = next.coverArt.kind === "mood" ? "mood" : "venue";
    else {
      // The cover: a venue's photo (from the slide that shows none itself: the map slide), else a mood image.
      const mapAt = slides.findIndex((s) => s.map);
      const pool = [...(mapAt >= 0 ? slides[mapAt].photos ?? [] : []), ...slides.flatMap((s, i) => (i === mapAt ? [] : s.photos ?? []))];
      if (pool[0]) {
        next.coverArt = pool[0];
        report.cover = "venue";
        // The cover isn't shown twice.
        for (const s of slides) if (s.photos) s.photos = s.photos.filter((p: ArtImage) => p.src !== pool[0].src);
      } else if (o.mood) {
        const m = await unsplashMood(o.mood, deps).catch(() => null);
        if (m) {
          next.coverArt = m.image;
          report.cover = "mood";
          report.mood = true;
          report.track.push(m.downloadLocation);
        }
      }
    }
    // The map slide shows no photos: what's left of its place's photos goes on the next slide with no picture of its own, still
    // credited as that place (inline imagery where it carries the plan).
    const mapAt2 = slides.findIndex((s) => s.map);
    if (mapAt2 >= 0 && slides[mapAt2].photos?.length) {
      const rest = slides[mapAt2].photos;
      delete slides[mapAt2].photos;
      const to = slides.findIndex((s, i) => i > mapAt2 && !s.image && !s.photos?.length && !s.map && !s.place);
      if (to >= 0) slides[to].photos = rest;
    }
    for (const s of slides) if (s.photos && !s.photos.length) delete s.photos;
    if (report.cover === "none") report.cover = next.logo ? "logo" : slides.some((s) => s.image || s.photos?.length || s.map) ? "none" : "plate";
  })();
  const ok = await Promise.race([work.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), o.deadlineMs ?? ART_DEADLINE_MS))]);
  if (!ok) return { data, report: { ...report, notes: [...report.notes, "the pictures took too long to find"], cover: data.logo ? "logo" : "plate" } };
  return { data: next, report };
}

// A page's pictures and map, the same way: each section Co tied to a place gets its photos, the page a map of every place, and a
// cover when it has none of its own.
export async function fillPageArt(data: any, o: { mood?: string | null; deadlineMs?: number } = {}, deps: ImageryDeps = realDeps): Promise<{ data: any; report: ArtReport }> {
  const next = JSON.parse(JSON.stringify(data));
  const report: ArtReport = { venues: [], mood: false, map: 0, cover: "none", notes: [], track: [] };
  const grammar: Grammar = next.style?.grammar ?? next.grammar ?? "editorial";
  const work = (async () => {
    const found = await Promise.all(next.sections.map((s: any) => (s.place ? findPlace(s.place, grammar === "fieldguide" ? 3 : 1, deps).catch(() => null) : Promise.resolve(null))));
    const pins: MapPin[] = [];
    found.forEach((f: FoundPlace | null, i: number) => {
      const s = next.sections[i];
      if (!f) {
        if (s.place) report.notes.push(`couldn't find ${s.place} on the map`);
        delete s.photos;
        return;
      }
      report.venues.push(f.name);
      if (!pins.some((p) => p.label === f.pin.label)) pins.push(f.pin);
      // Their own picture or the venue's own site image for the section stays; Google's photos join it.
      if (f.photos.length) s.photos = f.photos;
    });
    if (pins.length) {
      next.map = { pins: pins.slice(0, 8) };
      report.map = Math.min(8, pins.length);
    } else delete next.map;
    if (next.coverImage) report.cover = "theirs";
    else if (next.cover) report.cover = "og";
    else if (next.coverArt) report.cover = next.coverArt.kind === "mood" ? "mood" : "venue";
    else {
      const first = next.sections.flatMap((s: any) => s.photos ?? [])[0];
      if (first) {
        next.coverArt = first;
        report.cover = "venue";
        for (const s of next.sections) if (s.photos) s.photos = s.photos.filter((p: ArtImage) => p.src !== first.src);
      } else if (o.mood) {
        const m = await unsplashMood(o.mood, deps).catch(() => null);
        if (m) {
          next.coverArt = m.image;
          report.cover = "mood";
          report.mood = true;
          report.track.push(m.downloadLocation);
        }
      }
    }
    for (const s of next.sections) if (s.photos && !s.photos.length) delete s.photos;
    if (report.cover === "none") report.cover = next.logo ? "logo" : next.sections.some((s: any) => s.asset || s.image || s.photos?.length) || next.map ? "none" : "plate";
  })();
  const ok = await Promise.race([work.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), o.deadlineMs ?? ART_DEADLINE_MS))]);
  if (!ok) return { data, report: { ...report, notes: [...report.notes, "the pictures took too long to find"], cover: data.logo ? "logo" : "plate" } };
  return { data: next, report };
}

// For design QA and the PDF: every picture and tile an artifact shows, as data URIs (the QA browser loads nothing else).
export async function artDataUris(data: any, deps: ImageryDeps = realDeps): Promise<(ref: string) => string | null> {
  const { googlePhotosIn, tilesIn } = await import("./coPages/art.js");
  const map = new Map<string, string>();
  await Promise.all(
    googlePhotosIn(data).map(async (p) => {
      const b = await placePhotoBytes(p, deps).catch(() => null);
      if (b) map.set(`g:${p.src}`, `data:${b.mediaType};base64,${b.data.toString("base64")}`);
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
  return (ref) => map.get(ref) ?? null;
}

// The bytes behind one of an artifact's art routes (routes/coPage.ts): the k-th Google photo it shows, or a tile its maps need.
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
