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
//   venue: src is the Google Places photo name ("places/<id>/photos/<ref>"); placeId re-finds it when the name expires.
//   mood:  src is the Unsplash image's own https URL (hotlinked, as Unsplash requires).
export type ArtImage = { kind: "venue" | "mood"; src: string; alt: string; credit: string; creditUrl: string | null; via: "google" | "unsplash"; placeId?: string; place?: string };
export type MapPin = { lat: number; lng: number; label: string };
export type ArtMap = { pins: MapPin[] };

export const PLACE_PHOTO = /^places\/[A-Za-z0-9_-]{6,300}\/photos\/[A-Za-z0-9_-]{6,1200}$/;
const UNSPLASH_IMG = /^https:\/\/images\.unsplash\.com\/[A-Za-z0-9_./?=&%-]{4,600}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{6,300}$/;

// ---------------------------------------------------------------- the gate for code-filled art

// Pure: a stored picture, checked: every field plain and capped, its source only one of the two Co uses, its credit always there.
export function checkArtImage(v: unknown, field: string, problems: string[]): ArtImage | null {
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    problems.push(`${field} must be a picture Co found`);
    return null;
  }
  for (const k of Object.keys(o)) if (!["kind", "src", "alt", "credit", "creditUrl", "via", "placeId", "place"].includes(k)) problems.push(`${field} has unknown field ${k}`);
  const text = (x: unknown, max: number) => (typeof x === "string" && x.trim() && x.length <= max && !/[<>\r\n]/.test(x) ? x.trim() : null);
  const kind = o.kind === "venue" || o.kind === "mood" ? o.kind : null;
  const via = o.via === "google" || o.via === "unsplash" ? o.via : null;
  const src = typeof o.src === "string" ? o.src : "";
  const okSrc = (kind === "venue" && via === "google" && PLACE_PHOTO.test(src)) || (kind === "mood" && via === "unsplash" && UNSPLASH_IMG.test(src));
  const alt = text(o.alt, 140);
  const credit = text(o.credit, 120);
  let creditUrl: string | null = null;
  if (o.creditUrl != null) {
    try {
      const u = new URL(String(o.creditUrl));
      if (u.protocol === "https:" && !/["'<>\s\\]/.test(String(o.creditUrl)) && String(o.creditUrl).length <= 400) creditUrl = u.toString();
    } catch {}
  }
  const placeId = o.placeId == null ? undefined : typeof o.placeId === "string" && PLACE_ID.test(o.placeId) ? o.placeId : null;
  const place = o.place == null ? undefined : text(o.place, 90);
  if (!kind || !via || !okSrc || !alt || !credit || placeId === null || place === null) {
    problems.push(`${field} isn't a picture Co can show (a credited venue photo or a labelled mood image)`);
    return null;
  }
  return { kind, src, alt, credit, creditUrl, via, ...(placeId ? { placeId } : {}), ...(place ? { place } : {}) };
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

// Pure: a picture's credit line, said as what it is (a mood image is never passed off as the place).
export function creditLine(p: ArtImage): string {
  return p.kind === "mood" ? `Mood image · Photo by ${p.credit} on Unsplash` : `${p.place ? `${p.place} · ` : ""}Photo: ${p.credit} · Google Maps`;
}
export function creditHtml(p: ArtImage, e: (s: string) => string, cls = "credit"): string {
  const who = p.creditUrl ? `<a href="${e(p.creditUrl)}" rel="noopener noreferrer">${e(p.credit)}</a>` : e(p.credit);
  const inner =
    p.kind === "mood"
      ? `Mood image · Photo by ${who} on <a href="https://unsplash.com/?utm_source=co&amp;utm_medium=referral" rel="noopener noreferrer">Unsplash</a>`
      : `${p.place ? `${e(p.place)} · ` : ""}Photo: ${who} · Google Maps`;
  return `<span class="${cls}" data-qa-text="credit">${inner}</span>`;
}

// A typographic plate (when no picture is available at all): the title's initial set large in their colors, framed like a plate,
// and said as what it is. An honest image: it's type, never a stand-in photo.
export function typePlate(title: string, c: { ground: string; ink: string; accent: string; font: string }, e: (s: string) => string): string {
  const letter = (title.trim().match(/[A-Za-z0-9]/)?.[0] ?? "C").toUpperCase();
  return `<svg class="tplate" viewBox="0 0 400 500" role="img" aria-label="Typographic plate" data-art="plate" preserveAspectRatio="xMidYMid meet" style="background:${c.ground}"><rect width="400" height="500" fill="${c.ground}"/><rect x="22" y="22" width="356" height="456" fill="none" stroke="${c.accent}" stroke-width="1.5"/><text x="200" y="330" text-anchor="middle" font-family="${e(c.font)}" font-size="300" fill="${c.ink}">${e(letter)}</text><line x1="150" y1="400" x2="250" y2="400" stroke="${c.accent}" stroke-width="2"/></svg>`;
}

// ---------------------------------------------------------------- slide layouts per grammar

export const LIST_LAYOUTS = ["points", "grid"] as const;
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
  if (l === "courses") return s.bullets.length >= 1 && s.bullets.length <= 5;
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
      if (layoutFits("courses", s) && s.bullets.every((b) => leadOf(b))) return "courses";
      if (s.bullets.length <= 2) return "oversized";
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
  const isList = (l: string) => (LIST_LAYOUTS as readonly string[]).includes(l);
  const alt: Record<Grammar, string[]> = {
    catalog: ["asym", "oversized", "statement"],
    fieldguide: ["asym", "statement", "oversized"],
    menu: ["courses", "oversized", "statement"],
    editorial: ["asym", "statement", "oversized"],
    poster: ["oversized", "asym", "statement"],
  };
  const order = out.map((l, i) => i).filter((i) => isList(out[i])).sort((a, b) => slides[a].bullets.length - slides[b].bullets.length);
  let count = order.length;
  for (const i of order) {
    if (count <= max) break;
    const to = alt[g].find((l) => layoutFits(l, slides[i]));
    // A slide with more points than any other form holds still sheds a list slot as an asymmetric grid of its first four.
    out[i] = to ?? "asym";
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
        const to = [...alt[g], "asym", "statement", "points"].find((l) => l !== top && layoutFits(l, slides[i]) && (counts.get(l) ?? 0) < max);
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
  return { layouts: out, relaid };
}

// Pure: the composition rule, as QA reads it from the layouts actually rendered.
export function compositionProblem(layouts: string[]): string | null {
  const n = layouts.length;
  if (n < 2) return null;
  for (const l of LIST_LAYOUTS) {
    const k = layouts.filter((x) => x === l).length;
    if (k > Math.floor(n / 2)) return `${k} of ${n} slides use the same title and numbered list layout (${l}); half at most`;
  }
  const lists = layouts.filter((x) => (LIST_LAYOUTS as readonly string[]).includes(x)).length;
  if (lists > Math.floor(n / 2)) return `${lists} of ${n} slides are title and numbered list layouts; half at most`;
  if (n >= 4) for (const l of new Set(layouts)) {
    const k = layouts.filter((x) => x === l).length;
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
