// A Co page as data (Royce, 2026-10-11): one document format for anything planned, not page types. An itinerary, a night out, a
// member-hosted dinner, a group decision, a week view are all the same shape: a title, one line of context, sections (one per
// question the page answers) made of content blocks, and the sources at the bottom. Co fills these fields; the template
// (template.ts) is the only thing that turns them into HTML, and the model never writes any of it. Restored from the event page
// (archive/feat/event-pages, #136) and generalized.
//
// Every text field is plain text: one line, length-capped, no markdown, no HTML, no links. Links live only in the fields made for
// them (a comparison option's url, a link item's url, a source), and only as plain https. This file is the only gate: the store
// refuses anything that hasn't passed it, and the page re-checks what it loads.
import { STYLE_KEYS, checkExtras, styleFrom, type DeckStyle } from "./style.js";
import { GRAMMARS, checkArtImage, checkArtMap, type ArtImage, type ArtMap, type Grammar } from "./art.js";

export type TextBlock = { type: "text"; text: string };
// lead: a short label in front of the line (a time on an itinerary, a day on a week view): "7:00 PM", "Thu".
export type BulletItem = { text: string; lead: string | null };
export type BulletsBlock = { type: "bullets"; items: BulletItem[] };
// Side by side: two to four options, each with the same few facts, so the eye reads across.
export type ComparisonOption = { name: string; facts: { label: string; value: string }[]; note: string | null; url: string | null };
export type ComparisonBlock = { type: "comparison"; options: ComparisonOption[] };
// Recommendations: each a name with one line on why, grouped by vibe or area when `group` is given.
export type LinkItem = { name: string; note: string | null; url: string | null; group: string | null };
export type LinksBlock = { type: "links"; items: LinkItem[] };
export type Block = TextBlock | BulletsBlock | ComparisonBlock | LinksBlock;

// An image (Royce, 2026-10-11): "every image on a page belongs to the thing being recommended: the venue's site, the listing, the
// event page. No stock photos, ever." url is the image itself; sourceUrl is the page it came from, which must be one of that section's
// own entities (an option's or a recommendation's link) or a source the page cites. A page can't carry an image of anything it isn't
// about. Images are filled in code from those pages' own og:image when the page is made (ogImage.ts), never written by the model.
export type Photo = { url: string; alt: string; sourceUrl: string };
// asset: one of the owner's own images (services/memberAssets.ts) placed in this section, by id; never a URL (2026-10-11, PR 2).
// place: the real place the section is about, as Co named it, for its photos and the map; photos are found by code (art.ts ArtImage).
export type Section = { heading: string; blocks: Block[]; image: Photo | null; asset?: string; place?: string; photos?: ArtImage[] };
export type Source = { label: string; url: string };

export type CoPageData = {
  title: string;
  // The cover band's photograph, optional.
  cover: Photo | null;
  // One line under the title: dates, place, who it's for. "Saturday, Oct 24 · Mission District · for Jordan"
  context: string;
  sections: Section[];
  sources: Source[];
  // The member's own look (services/designTaste.ts, the same style a deck takes) and their logo (a member asset id), when they have
  // them. Without a style the page is Co's own design (Royce, 2026-10-11: taste and images apply to pages as they do to decks).
  style?: DeckStyle | null;
  logo?: string | null;
  // Art direction (art.ts): the grammar when the page has no style of theirs to carry it, a cover picture Co found or one of theirs,
  // and the map of the places on it.
  grammar?: Grammar;
  coverArt?: ArtImage;
  coverImage?: string;
  map?: ArtMap;
  // The main real place it's about, as Co named it (its cover photo and the map, when no section names one).
  place?: string;
  // Co's designed cover (art.ts abstractCover), set when it was made with no picture at all; never added to an older page.
  coverDesign?: boolean;
};
const ASSET_ID_RE = /^[A-Za-z0-9_-]{24}$/;

export const PAGE_LIMITS = {
  title: 90,
  context: 140,
  sections: 10,
  heading: 80,
  blocksPerSection: 6,
  text: 700,
  bullets: 14,
  bulletText: 220,
  lead: 20,
  options: 4,
  optionsMin: 2,
  optionName: 70,
  facts: 8,
  factLabel: 30,
  factValue: 90,
  optionNote: 220,
  links: 14,
  linkName: 80,
  linkNote: 200,
  group: 40,
  sources: 12,
  sourceLabel: 100,
  alt: 140,
  url: 500,
} as const;

// What makes a line not plain text. Checked in this order, first hit named.
const NOT_PLAIN: { test: RegExp; why: string }[] = [
  { test: /[\u0000-\u0008\u000B-\u001F\u007F]/, why: "has control characters" },
  { test: /[\r\n]/, why: "has a line break (each field is one line; use another item or block)" },
  { test: /<\s*\/?\s*[a-z!?]|<|>/i, why: "has HTML or angle brackets" },
  { test: /&(#\d+|#x[0-9a-f]+|[a-z]+);/i, why: "has an HTML entity" },
  { test: /\bhttps?:\/\/|\bwww\.\S/i, why: "has a link (put links in a url field or in sources)" },
  { test: /\*\*|__|~~|`/, why: "has markdown emphasis or code" },
  { test: /\[[^\]]*\]\([^)]*\)/, why: "has a markdown link" },
  { test: /^\s*(#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s)/, why: "starts with a markdown heading, bullet or number (use a bullets block)" },
  { test: /—/, why: "has an em dash (Cue doesn't use them)" },
  { test: /!/, why: "has an exclamation point (Cue doesn't use them)" },
];

export function plain(v: unknown, field: string, max: number, problems: string[], required: boolean): string | null {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) problems.push(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") {
    problems.push(`${field} must be text`);
    return null;
  }
  const s = v.replace(/[ \t]+/g, " ").trim();
  const bad = NOT_PLAIN.find((p) => p.test.test(s));
  if (bad) {
    problems.push(`${field} ${bad.why}`);
    return null;
  }
  if (s.length > max) {
    problems.push(`${field} is ${s.length} characters; the most is ${max}`);
    return null;
  }
  return s;
}

// A link field: plain https, no credentials, nothing that could break out of an attribute.
function link(v: unknown, field: string, problems: string[], required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) problems.push(`${field} is required`);
    return null;
  }
  if (typeof v !== "string" || v.length > PAGE_LIMITS.url) {
    problems.push(`${field} must be an https link of at most ${PAGE_LIMITS.url} characters`);
    return null;
  }
  try {
    const t = v.trim();
    const u = new URL(t);
    if (u.protocol !== "https:" || u.username || u.password || /["'<>\s\\]/.test(t)) throw new Error("not plain https");
    return u.toString();
  } catch {
    problems.push(`${field} must be a plain https link`);
    return null;
  }
}

export function list(v: unknown, field: string, maxItems: number, problems: string[], minItems = 0): unknown[] {
  if (v === undefined || v === null) {
    if (minItems) problems.push(`${field} needs at least ${minItems}`);
    return [];
  }
  if (!Array.isArray(v)) {
    problems.push(`${field} must be a list`);
    return [];
  }
  if (v.length > maxItems) problems.push(`${field} has ${v.length} items; the most is ${maxItems}`);
  if (v.length < minItems) problems.push(`${field} needs at least ${minItems}`);
  return v.slice(0, maxItems);
}

export function obj(v: unknown, field: string, keys: readonly string[], problems: string[]): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    problems.push(`${field} must be an object`);
    return null;
  }
  const o = v as Record<string, unknown>;
  // Unknown keys are refused, not dropped, so a field the template doesn't have can't ride along unseen.
  for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${field} has unknown field ${k}`);
  return o;
}

const L = PAGE_LIMITS;

function block(v: unknown, at: string, problems: string[]): Block | null {
  const type = v && typeof v === "object" && !Array.isArray(v) ? (v as any).type : undefined;
  if (type === "text") {
    const o = obj(v, at, ["type", "text"], problems);
    const text = o ? plain(o.text, `${at}.text`, L.text, problems, true) : null;
    return text ? { type, text } : null;
  }
  if (type === "bullets") {
    const o = obj(v, at, ["type", "items"], problems);
    if (!o) return null;
    const items = list(o.items, `${at}.items`, L.bullets, problems, 1)
      .map((it, i) => {
        const f = `${at}.items[${i}]`;
        const r = obj(it, f, ["text", "lead"], problems);
        if (!r) return null;
        const text = plain(r.text, `${f}.text`, L.bulletText, problems, true);
        const lead = plain(r.lead, `${f}.lead`, L.lead, problems, false);
        return text ? { text, lead } : null;
      })
      .filter((x): x is BulletItem => !!x);
    return items.length ? { type, items } : null;
  }
  if (type === "comparison") {
    const o = obj(v, at, ["type", "options"], problems);
    if (!o) return null;
    const options = list(o.options, `${at}.options`, L.options, problems, L.optionsMin)
      .map((op, i) => {
        const f = `${at}.options[${i}]`;
        const r = obj(op, f, ["name", "facts", "note", "url"], problems);
        if (!r) return null;
        const name = plain(r.name, `${f}.name`, L.optionName, problems, true);
        const facts = list(r.facts, `${f}.facts`, L.facts, problems)
          .map((fa, j) => {
            const ff = `${f}.facts[${j}]`;
            const q = obj(fa, ff, ["label", "value"], problems);
            if (!q) return null;
            const label = plain(q.label, `${ff}.label`, L.factLabel, problems, true);
            const value = plain(q.value, `${ff}.value`, L.factValue, problems, true);
            return label && value ? { label, value } : null;
          })
          .filter((x): x is { label: string; value: string } => !!x);
        const note = plain(r.note, `${f}.note`, L.optionNote, problems, false);
        const url = link(r.url, `${f}.url`, problems, false);
        return name ? { name, facts, note, url } : null;
      })
      .filter((x): x is ComparisonOption => !!x);
    // Side by side reads across: the options carry the same facts, in the same order.
    const labels = options.map((op) => op.facts.map((fa) => fa.label.toLowerCase()).join("|"));
    if (options.length >= 2 && new Set(labels).size > 1) problems.push(`${at}: every option needs the same facts, in the same order, so they read side by side`);
    return options.length >= L.optionsMin ? { type, options } : null;
  }
  if (type === "links") {
    const o = obj(v, at, ["type", "items"], problems);
    if (!o) return null;
    const items = list(o.items, `${at}.items`, L.links, problems, 1)
      .map((it, i) => {
        const f = `${at}.items[${i}]`;
        const r = obj(it, f, ["name", "note", "url", "group"], problems);
        if (!r) return null;
        const name = plain(r.name, `${f}.name`, L.linkName, problems, true);
        const note = plain(r.note, `${f}.note`, L.linkNote, problems, false);
        const url = link(r.url, `${f}.url`, problems, false);
        const group = plain(r.group, `${f}.group`, L.group, problems, false);
        return name ? { name, note, url, group } : null;
      })
      .filter((x): x is LinkItem => !!x);
    return items.length ? { type, items } : null;
  }
  problems.push(`${at}.type must be text, bullets, comparison or links`);
  return null;
}

function photo(v: unknown, field: string, problems: string[]): Photo | null {
  if (v === undefined || v === null) return null;
  const r = obj(v, field, ["url", "alt", "sourceUrl"], problems);
  if (!r) return null;
  const url = link(r.url, `${field}.url`, problems, true);
  const alt = plain(r.alt, `${field}.alt`, L.alt, problems, true);
  const sourceUrl = link(r.sourceUrl, `${field}.sourceUrl`, problems, true);
  return url && alt && sourceUrl ? { url, alt, sourceUrl } : null;
}

// Pure: the pages a section's image may come from: its own entities (comparison options, recommendations), in order.
export function sectionEntities(s: Pick<Section, "blocks">): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const b of s.blocks) {
    if (b.type === "comparison") for (const o of b.options) if (o.url) out.push({ name: o.name, url: o.url });
    if (b.type === "links") for (const i of b.items) if (i.url) out.push({ name: i.name, url: i.url });
  }
  return out;
}
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

// The one gate.
export function parseCoPageData(input: unknown): { ok: true; data: CoPageData } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const o = obj(input, "the page", ["title", "context", "cover", "sections", "sources", "style", "logo", "grammar", "coverArt", "coverImage", "map", "place", "coverDesign"], problems);
  if (!o) return { ok: false, problems: ["a page must be an object of fields"] };
  const title = plain(o.title, "title", L.title, problems, true);
  const context = plain(o.context, "context", L.context, problems, true);
  const sections = list(o.sections, "sections", L.sections, problems, 1)
    .map((s, i) => {
      const f = `sections[${i}]`;
      const r = obj(s, f, ["heading", "blocks", "image", "asset", "place", "photos"], problems);
      if (!r) return null;
      const heading = plain(r.heading, `${f}.heading`, L.heading, problems, true);
      const blocks = list(r.blocks, `${f}.blocks`, L.blocksPerSection, problems, 1)
        .map((b, j) => block(b, `${f}.blocks[${j}]`, problems))
        .filter((x): x is Block => !!x);
      const image = photo(r.image, `${f}.image`, problems);
      if (r.asset !== undefined && r.asset !== null && (typeof r.asset !== "string" || !ASSET_ID_RE.test(r.asset))) problems.push(`${f}.asset must be one of their saved images`);
      const asset = typeof r.asset === "string" && ASSET_ID_RE.test(r.asset) ? r.asset : null;
      const place = plain(r.place, `${f}.place`, 90, problems, false);
      const photos = list(r.photos, `${f}.photos`, 3, problems).map((p, k) => checkArtImage(p, `${f}.photos[${k}]`, problems)).filter((x): x is ArtImage => !!x);
      return heading && blocks.length ? { heading, blocks, image, ...(asset ? { asset } : {}), ...(place ? { place } : {}), ...(photos.length ? { photos } : {}) } : null;
    })
    .filter((x): x is Section => !!x);
  const sources = list(o.sources, "sources", L.sources, problems)
    .map((s, i) => {
      const f = `sources[${i}]`;
      const r = obj(s, f, ["label", "url"], problems);
      if (!r) return null;
      const label = plain(r.label, `${f}.label`, L.sourceLabel, problems, true);
      const url = link(r.url, `${f}.url`, problems, true);
      return label && url ? { label, url } : null;
    })
    .filter((x): x is Source => !!x);
  if (problems.length) return { ok: false, problems };
  const cover = photo(o.cover, "cover", problems);
  // Every image belongs to something the page is about (no stock, ever): a section's to one of its own entities or a cited source,
  // the cover's to any entity or source on the page.
  const cited = sources.map((s) => s.url);
  sections.forEach((s, i) => {
    if (s.image && ![...sectionEntities(s).map((x) => x.url), ...cited].some((u) => sameUrl(u, s.image!.sourceUrl))) problems.push(`sections[${i}].image must come from one of that section's own links or a cited source`);
  });
  if (cover && ![...sections.flatMap((s) => sectionEntities(s).map((x) => x.url)), ...cited].some((u) => sameUrl(u, cover.sourceUrl))) problems.push("cover must come from a link or a source on the page");
  // Their look and logo: the style re-derived through the deck's own gate (hex only, contrast checked), the logo an asset id only.
  let style: DeckStyle | null = null;
  if (o.style !== undefined && o.style !== null) {
    const st = obj(o.style, "style", STYLE_KEYS, problems);
    const hex = /^#[0-9a-f]{6}$/i;
    if (st && (["background", "text", "accent"] as const).some((k) => typeof st[k] !== "string" || !hex.test(String(st[k])))) problems.push("style colors must be six-digit hex");
    // The design system's tokens (fonts, a second color, density), each checked (style.ts checkExtras).
    const extras = st ? checkExtras(st, problems) : {};
    if (st && !problems.length) style = { ...styleFrom(st.mood, { background: st.background, text: st.text, accent: st.accent }, st.type, { field: !!extras.gradient }), ...extras };
  }
  if (o.logo !== undefined && o.logo !== null && (typeof o.logo !== "string" || !ASSET_ID_RE.test(o.logo))) problems.push("logo must be one of their saved images");
  const logo = typeof o.logo === "string" && ASSET_ID_RE.test(o.logo) ? o.logo : null;
  if (o.grammar != null && !GRAMMARS.includes(o.grammar as Grammar)) problems.push(`grammar must be one of ${GRAMMARS.join(", ")}`);
  const grammar = GRAMMARS.includes(o.grammar as Grammar) ? (o.grammar as Grammar) : null;
  const coverArt = checkArtImage(o.coverArt, "coverArt", problems);
  if (o.coverImage != null && (typeof o.coverImage !== "string" || !ASSET_ID_RE.test(o.coverImage))) problems.push("coverImage must be one of their saved images");
  const coverImage = typeof o.coverImage === "string" && ASSET_ID_RE.test(o.coverImage) ? o.coverImage : null;
  const map = checkArtMap(o.map, "map", problems);
  const pagePlace = plain(o.place, "place", 90, problems, false);
  if (problems.length) return { ok: false, problems };
  return { ok: true, data: { title: title!, context: context!, cover, sections, sources, ...(style ? { style } : {}), ...(logo ? { logo } : {}), ...(grammar ? { grammar } : {}), ...(coverArt ? { coverArt } : {}), ...(coverImage ? { coverImage } : {}), ...(map ? { map } : {}), ...(pagePlace ? { place: pagePlace } : {}), ...(o.coverDesign === true ? { coverDesign: true } : {}) } };
}
