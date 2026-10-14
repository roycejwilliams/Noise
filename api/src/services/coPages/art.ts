// Art direction (founder's brief, 2026-10-12: "the artifacts read as one template with two skins ... every artifact is the product
// demo"). On top of the member's design tokens (style.ts: font and palette stay theirs), each artifact takes a grammar: a composition
// system chosen for the member and the content. Co chooses it (a model judgment, passed on makeDeck / makePage); code only keeps the
// facts: which layouts a slide can really take (a map needs a place, a plate needs a picture, a timeline needs times), and the
// composition rule (no more than half a deck's slides on the same title + numbered list layout).
//
//   catalog    gallery catalog: asymmetric spreads, large captioned plates, oversized type moments
//   fieldguide field guide: a map, a timeline, photo strips, coordinates
//   menu       a menu: courses on a centered column, rules between them
//   editorial  an editorial magazine: Co's designed set (points, grid, statement, split), plates for pictures
//   poster     poster: oversized type, full-bleed pictures
//
// Pictures (imagery.ts fills them, never the model): the member's own first, then a real venue's photo (Google Places, credited), then
// mood imagery (Unsplash, labelled "Mood image" and credited), then their logo or a typographic plate. A picture is only ever what
// it's labelled as. Maps are drawn from OpenStreetMap tiles (credited), served through the artifact's own link.

export const GRAMMARS = ["catalog", "fieldguide", "menu", "editorial", "poster"] as const;
export type Grammar = (typeof GRAMMARS)[number];
export const GRAMMAR_NAMES: Record<Grammar, string> = {
  catalog: "a gallery catalog: asymmetric spreads, large plates, captions",
  fieldguide: "a field guide: a map, a timeline, photo strips",
  menu: "a menu: courses on a centered column, set between rules",
  editorial: "an editorial magazine: headline-led spreads",
  poster: "a poster: oversized type, full-bleed pictures",
};
// How Co says it in its line of choices: only the grammar's name (what the artifact really has, a map or the cover, is said apart).
export const GRAMMAR_SAID: Record<Grammar, string> = { catalog: "a gallery catalog", fieldguide: "a field guide", menu: "a menu", editorial: "an editorial magazine", poster: "a poster" };
// For Co's tool descriptions: what each grammar is for.
export const GRAMMAR_GUIDE =
  "catalog (art, objects, a show, a studio, a collection: a gallery catalog of large captioned plates and asymmetric spreads), fieldguide (a trip, a weekend, a route, anything moving between places: map, timeline, photo strips), menu (food, a dinner, a chef, a tasting, a bar: courses on a centered column), editorial (a pitch, a story, ideas and arguments: a magazine's headline-led spreads), poster (a launch, a party, one loud idea: oversized type and full-bleed pictures)";

// A picture Co found (never written by the model): a real venue's photo, or mood imagery labelled as such.
//   venue: only Google's place id and which of its photos (i) are kept (Google's terms: nothing else of theirs is stored). The photo
//          and its author's credit are fetched each time it's shown (services/artImagery.ts googleArt), and a photo whose credit can't
//          be had isn't shown. src is the key "gp:<placeId>:<i>"; place and alt are Co's own words for the place, never Google's.
//   mood:  src is the Unsplash image's own https URL (hotlinked, as Unsplash requires), with its photographer's credit.
export type ArtImage = { kind: "venue" | "mood"; src: string; alt: string; credit?: string; creditUrl?: string | null; via: "google" | "unsplash"; placeId?: string; i?: number; place?: string };
export type Credit = { credit: string; creditUrl: string | null };
export type MapPin = { lat: number; lng: number; label: string };
export type ArtMap = { pins: MapPin[] };

const UNSPLASH_IMG = /^https:\/\/images\.unsplash\.com\/[A-Za-z0-9_./?=&%-]{4,600}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{6,300}$/;
export const venueKey = (placeId: string, i: number) => `gp:${placeId}:${i}`;

// ---------------------------------------------------------------- the gate for code-filled art

// Pure: a stored picture, checked: every field plain and capped, its source only one of the two Co uses. A venue photo carries only
// its place id and index (no Google data); a mood image carries its photographer's credit.
export function checkArtImage(v: unknown, field: string, problems: string[]): ArtImage | null {
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    problems.push(`${field} must be a picture Cue found`);
    return null;
  }
  for (const k of Object.keys(o)) if (!["kind", "src", "alt", "credit", "creditUrl", "via", "placeId", "i", "place"].includes(k)) problems.push(`${field} has unknown field ${k}`);
  const text = (x: unknown, max: number) => (typeof x === "string" && x.trim() && x.length <= max && !/[<>\r\n]/.test(x) ? x.trim() : null);
  const alt = text(o.alt, 140);
  if (o.kind === "venue" && o.via === "google") {
    const placeId = typeof o.placeId === "string" && PLACE_ID.test(o.placeId) ? o.placeId : null;
    const i = Number.isInteger(o.i) && (o.i as number) >= 0 && (o.i as number) < 10 ? (o.i as number) : null;
    const place = text(o.place, 90);
    // Google's own data (a photo name, an author) is never kept with the artifact.
    if (!placeId || i === null || !place || !alt || o.src !== venueKey(placeId, i) || o.credit != null || o.creditUrl != null) {
      problems.push(`${field} isn't a venue photo Cue can show (only its place id and index are kept)`);
      return null;
    }
    return { kind: "venue", via: "google", src: venueKey(placeId, i), placeId, i, place, alt };
  }
  const src = typeof o.src === "string" ? o.src : "";
  const credit = text(o.credit, 120);
  let creditUrl: string | null = null;
  if (o.creditUrl != null) {
    try {
      const u = new URL(String(o.creditUrl));
      if (u.protocol === "https:" && !/["'<>\s\\]/.test(String(o.creditUrl)) && String(o.creditUrl).length <= 400) creditUrl = u.toString();
    } catch {}
  }
  if (o.kind !== "mood" || o.via !== "unsplash" || !UNSPLASH_IMG.test(src) || !alt || !credit || o.placeId != null || o.i != null) {
    problems.push(`${field} isn't a picture Cue can show (a venue photo by its place id, or a credited mood image)`);
    return null;
  }
  return { kind: "mood", via: "unsplash", src, alt, credit, creditUrl };
}

export function checkArtMap(v: unknown, field: string, problems: string[]): ArtMap | null {
  if (v === undefined || v === null) return null;
  const pins = (v as any)?.pins;
  if (!Array.isArray(pins) || !pins.length || pins.length > 8) {
    problems.push(`${field} needs one to eight places`);
    return null;
  }
  const out: MapPin[] = [];
  for (const p of pins) {
    const lat = Number(p?.lat), lng = Number(p?.lng);
    const label = typeof p?.label === "string" && p.label.trim() && p.label.length <= 90 && !/[<>\r\n]/.test(p.label) ? p.label.trim() : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180 || !label) {
      problems.push(`${field} has a place without a real position`);
      return null;
    }
    out.push({ lat, lng, label });
  }
  return { pins: out };
}

// ---------------------------------------------------------------- maps (OpenStreetMap tiles, Web Mercator)

export const MAP_CANVAS = { w: 1024, h: 640, tile: 256 } as const;
const lon2x = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z * 256;
const lat2y = (lat: number, z: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z * 256;

// Pure: the view that holds every pin with room around it (one pin: a neighborhood view), and the tiles it needs with where each sits
// on the canvas, as shares of it so the map scales with its box. Zoom 3 to 16.
export function mapView(m: ArtMap, canvas: { w: number; h: number } = MAP_CANVAS): { z: number; tiles: { z: number; x: number; y: number; left: number; top: number; size: number; sizeH: number }[]; pins: (MapPin & { left: number; top: number })[] } {
  const pad = 0.22;
  let z = 16;
  if (m.pins.length > 1) {
    for (z = 16; z > 3; z--) {
      const xs = m.pins.map((p) => lon2x(p.lng, z)), ys = m.pins.map((p) => lat2y(p.lat, z));
      if (Math.max(...xs) - Math.min(...xs) <= canvas.w * (1 - 2 * pad) && Math.max(...ys) - Math.min(...ys) <= canvas.h * (1 - 2 * pad)) break;
    }
  } else z = 14;
  const xs = m.pins.map((p) => lon2x(p.lng, z)), ys = m.pins.map((p) => lat2y(p.lat, z));
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const x0 = cx - canvas.w / 2, y0 = cy - canvas.h / 2;
  const n = 2 ** z;
  const tiles: { z: number; x: number; y: number; left: number; top: number; size: number; sizeH: number }[] = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + canvas.h - 1) / 256); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + canvas.w - 1) / 256); tx++) {
      const wx = ((tx % n) + n) % n;
      tiles.push({ z, x: wx, y: ty, left: ((tx * 256 - x0) / canvas.w) * 100, top: ((ty * 256 - y0) / canvas.h) * 100, size: (256 / canvas.w) * 100, sizeH: (256 / canvas.h) * 100 });
    }
  }
  const pins = m.pins.map((p) => ({ ...p, left: ((lon2x(p.lng, z) - x0) / canvas.w) * 100, top: ((lat2y(p.lat, z) - y0) / canvas.h) * 100 }));
  return { z, tiles, pins };
}

// Pure: the tile keys ("z/x/y") an artifact's maps need: the only tiles its link will serve (routes/coPage.ts), so the link is never
// an open tile proxy.
export function tilesIn(data: any): string[] {
  const maps: ArtMap[] = [];
  if (data?.kind === "deck") for (const s of data.slides ?? []) if (s.map) maps.push(s.map);
  if (data?.map) maps.push(data.map);
  return [...new Set(maps.flatMap((m) => mapView(m).tiles.map((t) => `${t.z}/${t.x}/${t.y}`)))];
}

// Pure: the Google photo names an artifact shows, in order: the photo route serves the k-th of these only.
export function googlePhotosIn(data: any): ArtImage[] {
  const all: (ArtImage | null | undefined)[] = [data?.coverArt];
  if (data?.kind === "deck") for (const s of data.slides ?? []) all.push(...(s.photos ?? []));
  else for (const s of data?.sections ?? []) all.push(...(s.photos ?? []));
  const seen = new Set<string>();
  return all.filter((p): p is ArtImage => !!p && p.via === "google" && !seen.has(p.src) && !!seen.add(p.src));
}

// How a map and a credit are drawn (HTML, escaped by the caller's e()). src resolves a tile key or a picture to its address.
export function mapHtml(m: ArtMap, e: (s: string) => string, tileSrc: (key: string) => string | null, o: { cls?: string; ratio?: string } = {}): string {
  const v = mapView(m);
  const tiles = v.tiles
    .map((t) => {
      const u = tileSrc(`${t.z}/${t.x}/${t.y}`);
      return u ? `<img class="tile" src="${e(u)}" alt="" data-qa-crop="ok" style="left:${t.left.toFixed(3)}%;top:${t.top.toFixed(3)}%;width:${(t.size + 0.05).toFixed(3)}%;height:${(t.sizeH + 0.05).toFixed(3)}%" data-qa-tile>` : "";
    })
    .join("");
  // A label that would sit on an earlier one's goes under its pin instead.
  const below = v.pins.map((p, i) => v.pins.slice(0, i).some((q) => Math.abs(q.top - p.top) < 9 && Math.abs(q.left - p.left) < 22));
  const pins = v.pins.map((p, i) => `<span class="pin${below[i] ? " below" : ""}" style="left:${p.left.toFixed(2)}%;top:${p.top.toFixed(2)}%"><b>${i + 1}</b><span class="pl">${e(p.label)}</span></span>`).join("");
  return `<figure class="map${o.cls ? ` ${o.cls}` : ""}" role="img" aria-label="${e(`Map: ${m.pins.map((p) => p.label).join(", ")}`)}" data-art="map"><div class="mapc">${tiles}${pins}</div><figcaption class="osm"><a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer">© OpenStreetMap contributors</a></figcaption></figure>`;
}

// Pure: a picture's credit line, said as what it is (a mood image is never passed off as the place). A venue photo's credit is the one
// fetched for it now (c), never a stored one.
export function creditLine(p: ArtImage, c: Credit | null = null): string {
  return p.kind === "mood" ? `Mood image · Photo by ${p.credit} on Unsplash` : `${p.place ? `${p.place} · ` : ""}Photo: ${c?.credit ?? ""} · Google Maps`;
}
export function creditHtml(p: ArtImage, e: (s: string) => string, cls = "credit", c: Credit | null = null): string {
  const name = p.kind === "mood" ? p.credit ?? "" : c?.credit ?? "";
  const url = p.kind === "mood" ? p.creditUrl ?? null : c?.creditUrl ?? null;
  const who = url ? `<a href="${e(url)}" rel="noopener noreferrer">${e(name)}</a>` : e(name);
  const inner =
    p.kind === "mood"
      ? `Mood image · Photo by ${who} on <a href="https://unsplash.com/?utm_source=co&amp;utm_medium=referral" rel="noopener noreferrer">Unsplash</a>`
      : `${p.place ? `${e(p.place)} · ` : ""}Photo: ${who} · Google Maps`;
  return `<span class="${cls}" data-qa-text="credit">${inner}</span>`;
}

// A designed cover (founder's review, 2026-10-12: a type plate isn't an image): when there's no photo of theirs, no venue's and no mood
// image, an abstract composition Co makes in their palette, seeded from the title so it's the same each time, and labelled as Co's
// design, never as a photo. Only on artifacts made with it (coverDesign), never added to older ones.
export function abstractCover(title: string, c: { ground: string; ink: string; accent: string; accent2?: string | null }, e: (s: string) => string): string {
  let h = 2166136261;
  for (const ch of title) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const r = (n: number) => ((h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0) % 1000) / 1000 * n;
  const a2 = c.accent2 ?? c.ink;
  const cx = 120 + r(160), cy = 150 + r(200), rad = 110 + r(70);
  const bandY = 280 + r(120), tilt = -18 + r(36);
  const arcs = Array.from({ length: 4 }, (_, k) => `<circle cx="${(cx + 40).toFixed(0)}" cy="${(cy + 30).toFixed(0)}" r="${(rad + 34 + k * 26).toFixed(0)}" fill="none" stroke="${c.ink}" stroke-opacity="${(0.22 - k * 0.04).toFixed(2)}" stroke-width="1.5"/>`).join("");
  return `<svg class="tplate" viewBox="0 0 400 500" role="img" aria-label="Abstract cover design by Cue" data-art="design" preserveAspectRatio="xMidYMid slice" style="background:${c.ground}"><rect width="400" height="500" fill="${c.ground}"/><g transform="rotate(${tilt.toFixed(1)} 200 250)"><rect x="-60" y="${bandY.toFixed(0)}" width="520" height="${(60 + r(50)).toFixed(0)}" fill="${a2}" fill-opacity="0.85"/></g><circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="${c.accent}"/>${arcs}</svg><span class="credit design" data-qa-text="credit">${e("Cover design by Cue, not a photo")}</span>`;
}

// ---------------------------------------------------------------- slide layouts per grammar

export const LIST_LAYOUTS = ["points", "grid"] as const;
// Pure: whether a slide, as laid out, is really a title over a list (founder's review: a statement carrying a list, or an asymmetric
// grid of points, is a list too). A statement with one line, a timeline, a map, a plate, a strip, courses or oversized type isn't.
export function listLike(layout: string, bullets: number): boolean {
  if ((LIST_LAYOUTS as readonly string[]).includes(layout)) return true;
  if (layout === "asym") return bullets >= 2;
  if (layout === "statement") return bullets >= 2;
  return false;
}
type Shape = { bullets: string[]; image: string | null; photos?: ArtImage[]; map?: ArtMap | null; layout?: string };

// Pure: a bullet's short lead before a colon ("7:00 PM: Dinner", "Friday: Arrive"), or null.
export function leadOf(b: string): { lead: string; text: string } | null {
  // A time written last ("Doors 6:30 PM") leads too.
  const end = b.match(/^(.{2,}?)[,\s]+(?:at\s+)?(\d{1,2}(?::\d{2})?\s?(?:[AaPp]\.?[Mm]\.?))$/);
  if (end) return { lead: end[2].trim(), text: end[1].trim() };
  const m = b.match(/^(\d{1,2}:\d{2}\s?(?:[AaPp]\.?[Mm]\.?)?|[^:]{1,18}):\s+(.{2,})$/);
  if (!m || /\s{2,}/.test(m[1]) || m[1].split(/\s+/).length > 3) return null;
  return { lead: m[1].trim(), text: m[2].trim() };
}
// Pure: a menu's dish ("Oyster: smoked butter", "Lamb shoulder over coals: green garlic"): its name and what it is, or null. Only these
// are set as courses (founder's review: a call to action set as a dish).
export function dishOf(b: string): { lead: string; text: string } | null {
  const l = leadOf(b);
  if (l && !/^\d/.test(l.lead)) return l;
  const m = b.match(/^([^:]{2,40}?):\s+(.{2,})$/);
  return m && m[1].trim().split(/\s+/).length <= 6 && !/^\d/.test(m[1]) ? { lead: m[1].trim(), text: m[2].trim() } : null;
}
export const timed = (s: Pick<Shape, "bullets">) => s.bullets.length >= 2 && s.bullets.filter((b) => leadOf(b)).length === s.bullets.length;
const pictures = (s: Shape) => (s.image ? 1 : 0) + (s.photos?.length ?? 0);

// Pure: whether a slide has what a layout needs (a map needs places, a plate a picture, a strip two pictures, a timeline times).
export function layoutFits(l: string, s: Shape): boolean {
  if (l === "statement") return s.bullets.length <= 5;
  if (l === "map") return !!s.map?.pins.length;
  if (l === "plate" || l === "split") return pictures(s) >= 1;
  if (l === "strip") return pictures(s) >= 2;
  if (l === "timeline") return timed(s) && s.bullets.length <= 5;
  if (l === "grid") return s.bullets.length >= 2 && s.bullets.length <= 4 && s.bullets.every((b) => b.length <= 95);
  if (l === "asym") return s.bullets.length >= 2 && s.bullets.length <= 5;
  if (l === "courses") return s.bullets.length >= 2 && s.bullets.length <= 5 && s.bullets.every((b) => dishOf(b));
  if (l === "pull") return s.bullets.length <= 2;
  if (l === "oversized") return s.bullets.length <= 2;
  return true;
}

// Pure: a slide's layout from its shape, the grammar's way.
function byShape(s: Shape, g: Grammar, i: number): string {
  const pics = pictures(s);
  if (s.map?.pins.length) return "map";
  if (timed(s) && s.bullets.length <= 5 && g !== "menu") return "timeline";
  const one = s.bullets.length === 1;
  switch (g) {
    case "catalog":
      if (pics >= 2) return i % 2 ? "plate" : "strip";
      if (pics) return "plate";
      if (one) return "oversized";
      return layoutFits("asym", s) ? "asym" : "points";
    case "fieldguide":
      if (pics >= 2) return "strip";
      if (pics) return "plate";
      if (one) return "statement";
      return layoutFits("grid", s) ? "grid" : "points";
    case "menu":
      if (pics) return "plate";
      // Courses are dishes ("Oyster: smoked butter"); the rest of a menu is set as its statements, centered.
      if (layoutFits("courses", s)) return "courses";
      // The rest of a menu: a pull line, oversized type or a centered statement, in turn, so it never reads as one form.
      if (s.bullets.length <= 2) return ["pull", "oversized", "statement"][i % 3];
      return i % 2 ? "asym" : "statement";
    case "poster":
      if (pics) return "plate";
      if (s.bullets.length <= 2) return "oversized";
      return layoutFits("asym", s) ? "asym" : "grid";
    default:
      if (pics) return "split";
      if (one) return "statement";
      return layoutFits("grid", s) ? "grid" : "points";
  }
}

// Pure: every slide's layout, and the composition rule as a fact guard. Co's pick stands when the slide has what it needs; otherwise
// the grammar picks from the slide's shape. Then: never three of a kind in a row, and no more than half the slides on the title +
// numbered list layouts (points, grid): past that, list slides are re-laid (fewest points first) as the grammar's non-list forms.
export function composeLayouts(slides: Shape[], g: Grammar = "editorial"): { layouts: string[]; relaid: number[] } {
  const out = slides.map((s, i) => (s.layout && layoutFits(s.layout, s) ? s.layout : byShape(s, g, i)));
  // Three of a kind in a row (not Co's picks): points and grid trade places when a slide fits.
  out.forEach((l, i) => {
    if (i >= 2 && !slides[i].layout && out[i - 1] === l && out[i - 2] === l) {
      if (l === "grid") out[i] = "points";
      else if (l === "points" && layoutFits("grid", slides[i])) out[i] = "grid";
    }
  });
  const relaid: number[] = [];
  const max = Math.floor(slides.length / 2);
  if (slides.length < 2) return { layouts: out, relaid };
  const isList = (l: string, i: number) => listLike(l, slides[i].bullets.length);
  const alt: Record<Grammar, string[]> = {
    catalog: ["asym", "oversized", "pull", "statement"],
    fieldguide: ["asym", "statement", "oversized"],
    menu: ["courses", "pull", "oversized", "statement"],
    editorial: ["asym", "statement", "pull", "oversized"],
    poster: ["oversized", "asym", "statement"],
  };
  const order = out.map((l, i) => i).filter((i) => isList(out[i], i)).sort((a, b) => slides[a].bullets.length - slides[b].bullets.length);
  let count = order.length;
  for (const i of order) {
    if (count <= max) break;
    // Only a form that isn't itself a list counts (oversized type, a timeline, a picture or a map, courses); a slide with no such form
    // stays as it is, and the rule goes back to Co to rewrite (designQa.ts contentFindings).
    const to = [...alt[g], "timeline", "courses", "plate", "strip", "map"].find((l) => layoutFits(l, slides[i]) && !listLike(l, slides[i].bullets.length) );
    if (!to) continue;
    out[i] = to;
    relaid.push(i);
    count--;
  }
  // Variety (founder's brief: "composition variety per deck"): no one layout on more than half the slides of a deck of four or more.
  if (slides.length >= 4) {
    for (let guard = 0; guard < slides.length; guard++) {
      const counts = new Map<string, number>();
      out.forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1));
      const [top, k] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (k <= max) break;
      // The slide that's easiest to set another way: fewest points first, later slides before earlier ones.
      const cand = out.map((l, i) => i).filter((i) => out[i] === top).sort((a, b) => slides[a].bullets.length - slides[b].bullets.length || b - a);
      let moved = false;
      for (const i of cand) {
        // Never back over the list rule: a list form only while lists are under half.
        const lists = out.filter((l, j) => listLike(l, slides[j].bullets.length)).length - (listLike(top, slides[i].bullets.length) ? 1 : 0);
        const to = [...alt[g], "timeline", "plate", "strip", "asym", "statement", "points"].find((l) => l !== top && layoutFits(l, slides[i]) && (counts.get(l) ?? 0) < max && (!listLike(l, slides[i].bullets.length) || lists < max));
        if (to) {
          out[i] = to;
          relaid.push(i);
          moved = true;
          break;
        }
      }
      if (!moved) break;
    }
  }
  // Never three of one form in a row, any form (founder's review: three oversized slides in a row read as one): the third takes the
  // grammar's next form that fits and keeps the rules above.
  for (let i = 2; i < out.length; i++) {
    if (out[i] !== out[i - 1] || out[i] !== out[i - 2]) continue;
    const listsNow = out.filter((l, j) => listLike(l, slides[j].bullets.length)).length - (listLike(out[i], slides[i].bullets.length) ? 1 : 0);
    const count = (l: string) => out.filter((x) => x === l).length;
    const to = [...alt[g], "pull", "statement", "oversized", "asym"].find((l) => l !== out[i] && layoutFits(l, slides[i]) && (slides.length < 4 || count(l) < max) && (!listLike(l, slides[i].bullets.length) || listsNow < max));
    if (to) {
      out[i] = to;
      relaid.push(i);
    }
  }
  return { layouts: out, relaid };
}

// Pure: the composition rule, as QA reads it from the layouts laid out (each with its number of points): no more than half the slides
// are a title over a list (points, grid, a statement or an asymmetric grid carrying points), and no one layout holds more than half a
// deck of four or more. The slides to rewrite are named.
export function compositionProblem(items: (string | { layout: string; bullets: number })[]): string | null {
  const xs = items.map((x) => (typeof x === "string" ? { layout: x, bullets: 3 } : x));
  const n = xs.length;
  if (n < 2) return null;
  const lists = xs.map((x, i) => (listLike(x.layout, x.bullets) ? i : -1)).filter((i) => i >= 0);
  if (lists.length > Math.floor(n / 2)) return `${lists.length} of ${n} slides are a title over a list (slides ${lists.map((i) => i + 2).join(", ")}); half at most, so set some as one strong line, a run of times, or with a picture`;
  if (n >= 4) for (const l of new Set(xs.map((x) => x.layout))) {
    const k = xs.filter((x) => x.layout === l).length;
    if (k > Math.floor(n / 2)) return `${k} of ${n} slides share one layout (${l}); half at most`;
  }
  return null;
}

// ---------------------------------------------------------------- the craft bar

// Pure: a literal placeholder in shipped text ("[Gallery]", "{{name}}", "TBD", "Lorem ipsum", "Your Name Here", "XX"), or null.
export function placeholderIn(text: string): string | null {
  const t = String(text ?? "");
  const m =
    t.match(/\[[^\]\n]{1,}\]/) ??
    t.match(/\{\{[^}]*\}\}|\{[A-Za-z_ ]{2,30}\}/) ??
    t.match(/\blorem ipsum\b/i) ??
    t.match(/\b(?:TBD|TBA|TK|TODO|FIXME)\b/) ??
    t.match(/\b(?:your|venue|company|artist|gallery|guest) name here\b/i) ??
    t.match(/\binsert (?:name|date|time|venue|address|image|photo|logo|link)\b/i) ??
    t.match(/(?:^|\s)X{2,}(?:\s|$)|\bXX:XX\b|\$X+\b/) ??
    t.match(/\bplaceholder\b/i);
  return m ? m[0].trim() : null;
}
