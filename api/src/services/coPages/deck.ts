// A deck: the second artifact type on the Co page pipeline (Royce, 2026-10-11: "make me a pitch deck about my startup" gets back a link
// to a hosted deck). Same store, same /d/ link, same rules as a page (store.ts: owner-only changes, noindex, 90-day expiry, wiped on
// take-down), same grounding (grounding.ts deckProblems). Only the shape and the renderer differ: a title slide, then content slides
// of a headline and a few bullets.
//
// The look comes from the member's own design system (services/designSystem.ts), never a fixed Co theme: their colors, a gradient,
// their fonts (open fonts only), density, and a designed layout per slide (2026-10-12). Colors are plain six-digit hex only and font
// names letters only, checked here, so nothing but a color or a font name can reach the CSS. Like a page, every field is plain text,
// escaped, and the model writes no HTML.
//
// Layouts (a small designed set, filled by the member's tokens):
//   title:   field (a full-bleed color or gradient field, oversized type), editorial (paper, oversized display type, a gradient strip),
//            centered (the logo leads).
//   content: statement (one big line on the field), points (index and headline left, points right on hairlines), grid (two to four
//            short points as numbered columns), split (the picture bleeds off one side). Picked from each slide's shape unless Co
//            picked one, never three of a kind in a row.
// Every size is in container units (cqw), so a slide is the same design on a phone, a laptop and the 13.333in PDF page.
import { escapeHtml } from "../emailDesign.js";
import { list, obj, plain } from "./schema.js";

import { DECK_MOODS, STYLE_KEYS, checkExtras, contrast, inkOn, styleFrom, type DeckMood, type DeckStyle } from "./style.js";
import { DEFAULT_FONTS, fontLinks, fontStack } from "../designFonts.js";
import { checkArtImage, checkArtMap, composeLayouts, creditHtml, googlePhotosIn, leadOf, mapHtml, typePlate, type ArtImage, type ArtMap, type Grammar } from "./art.js";
export { DECK_MOODS, MOOD_STYLES, contrast, styleFrom, type DeckMood, type DeckStyle } from "./style.js";

// The art-direction layouts (art.ts): timeline, map, asym (an asymmetric grid), oversized (oversized type), plate (a captioned plate),
// strip (a photo strip), courses (a menu's centered column).
export const SLIDE_LAYOUTS = ["statement", "points", "grid", "split", "timeline", "map", "asym", "oversized", "plate", "strip", "courses"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];
// How an image is placed, decided in code from its pixels (services/designRead.ts), never by the model: full, small (a low-res image
// is never stretched), plate (a logo cropped to its edges sits on its own ground color). mono: one ink on one ground, so it can drop
// its ground on a colored field.
export type ImageMeta = { fit: "full" | "small" | "plate"; ground: string | null; ink: string | null; mono: boolean };
// image / logo: a member asset's id (services/memberAssets.ts), one of the owner's own images; never a URL. The store checks the
// owner, and the image is served only through this deck's own link (routes/coPage.ts).
// notes: speaker notes for this slide, only when the member asked for them (PR 3, 2026-10-11); shown under the slide, folded.
// fit: the design QA's fix for a slide whose text ran over (services/designQa.ts): a step smaller type each level, never under the
// type floor (FIT_STEPS); past the last step QA splits the slide in two.
export const FIT_STEPS = ["tight", "tighter", "tightest"] as const;
export type Fit = (typeof FIT_STEPS)[number];
// place: the real place this slide is about, as Co named it (a venue, an address), for its photo and the map. photos and map are found
// by code from it (services/artImagery.ts), never written by the model.
export type Slide = { headline: string; bullets: string[]; image: string | null; notes?: string; layout?: SlideLayout; imageMeta?: ImageMeta; fit?: Fit; place?: string; photos?: ArtImage[]; map?: ArtMap };
// coverArt: the full-bleed cover picture Co found (a venue's photo, or a mood image said as one). coverImage: their own image as the cover.
export type DeckData = { kind: "deck"; title: string; subtitle: string; logo: string | null; slides: Slide[]; style: DeckStyle; logoMeta?: ImageMeta; coverArt?: ArtImage; coverImage?: string; place?: string };
const ASSET = /^[A-Za-z0-9_-]{24}$/;
const HEX = /^#[0-9a-f]{6}$/i;

// bullets stays 5 for what's stored (decks saved with five points before the tool asked for four must still open, update and
// export); the tool asks for four (agent/deckTools.ts DECK_INPUT) and QA's one-idea rule flags a fifth.
export const DECK_LIMITS = { title: 90, subtitle: 140, slidesMin: 2, slides: 15, headline: 90, bulletsMin: 1, bullets: 5, bullet: 160, notes: 700 } as const;

function imageMeta(v: unknown, field: string, problems: string[]): ImageMeta | undefined {
  if (v === undefined || v === null) return undefined;
  const m = obj(v, field, ["fit", "ground", "ink", "mono"], problems);
  if (!m) return undefined;
  const hex = (x: unknown) => (typeof x === "string" && HEX.test(x) ? x.toUpperCase() : null);
  if (!["full", "small", "plate"].includes(m.fit as string)) problems.push(`${field}.fit must be full, small or plate`);
  if ((m.ground != null && !hex(m.ground)) || (m.ink != null && !hex(m.ink))) problems.push(`${field} colors must be six-digit hex`);
  return { fit: (["full", "small", "plate"].includes(m.fit as string) ? m.fit : "full") as ImageMeta["fit"], ground: hex(m.ground), ink: hex(m.ink), mono: m.mono === true };
}

// The one gate for a deck, like parseCoPageData for a page: unknown fields refused, every line plain, colors hex only.
export function parseCoDeckData(input: unknown): { ok: true; data: DeckData } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const o = obj(input, "the deck", ["kind", "title", "subtitle", "logo", "slides", "style", "logoMeta", "coverArt", "coverImage", "place"], problems);
  if (!o) return { ok: false, problems: ["a deck must be an object of fields"] };
  if (o.kind !== "deck") problems.push("kind must be deck");
  const L = DECK_LIMITS;
  const title = plain(o.title, "title", L.title, problems, true);
  const subtitle = plain(o.subtitle, "subtitle", L.subtitle, problems, true);
  const asset = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !ASSET.test(v)) problems.push(`${field} must be one of their saved images`);
    return typeof v === "string" && ASSET.test(v) ? v : null;
  };
  const logo = asset(o.logo, "logo");
  const logoMeta = logo ? imageMeta(o.logoMeta, "logoMeta", problems) : undefined;
  const slides = list(o.slides, "slides", L.slides, problems, L.slidesMin)
    .map((s, i) => {
      const f = `slides[${i}]`;
      const r = obj(s, f, ["headline", "bullets", "image", "notes", "layout", "imageMeta", "fit", "place", "photos", "map"], problems);
      if (!r) return null;
      const headline = plain(r.headline, `${f}.headline`, L.headline, problems, true);
      const bullets = list(r.bullets, `${f}.bullets`, L.bullets, problems, L.bulletsMin)
        .map((b, j) => plain(b, `${f}.bullets[${j}]`, L.bullet, problems, true))
        .filter((x): x is string => !!x);
      const image = asset(r.image, `${f}.image`);
      const notes = plain(r.notes, `${f}.notes`, L.notes, problems, false);
      if (r.layout !== undefined && r.layout !== null && !SLIDE_LAYOUTS.includes(r.layout as SlideLayout)) problems.push(`${f}.layout must be one of ${SLIDE_LAYOUTS.join(", ")}`);
      if (r.fit !== undefined && r.fit !== null && !FIT_STEPS.includes(r.fit as Fit)) problems.push(`${f}.fit must be one of ${FIT_STEPS.join(", ")}`);
      const layout = SLIDE_LAYOUTS.includes(r.layout as SlideLayout) ? (r.layout as SlideLayout) : undefined;
      const meta = image ? imageMeta(r.imageMeta, `${f}.imageMeta`, problems) : undefined;
      const place = plain(r.place, `${f}.place`, 90, problems, false);
      const photos = list(r.photos, `${f}.photos`, 3, problems).map((p, k) => checkArtImage(p, `${f}.photos[${k}]`, problems)).filter((x): x is ArtImage => !!x);
      const map = checkArtMap(r.map, `${f}.map`, problems);
      return headline && bullets.length
        ? { headline, bullets, image, ...(notes ? { notes } : {}), ...(layout ? { layout } : {}), ...(meta ? { imageMeta: meta } : {}), ...(FIT_STEPS.includes(r.fit as Fit) ? { fit: r.fit as Fit } : {}), ...(place ? { place } : {}), ...(photos.length ? { photos } : {}), ...(map ? { map } : {}) }
        : null;
    })
    .filter((x): x is Slide => !!x);
  const coverArt = checkArtImage(o.coverArt, "coverArt", problems);
  const coverImage = asset(o.coverImage, "coverImage");
  const deckPlace = plain(o.place, "place", 90, problems, false);
  const st = obj(o.style, "style", STYLE_KEYS, problems);
  let extras = {};
  if (st) {
    if (!DECK_MOODS.includes(st.mood as DeckMood)) problems.push(`style.mood must be one of ${DECK_MOODS.join(", ")}`);
    for (const k of ["background", "text", "accent"] as const) if (typeof st[k] !== "string" || !HEX.test(String(st[k]))) problems.push(`style.${k} must be a six-digit hex color`);
    if (st.type !== "serif" && st.type !== "sans") problems.push("style.type must be serif or sans");
    extras = checkExtras(st, problems);
  }
  if (problems.length) return { ok: false, problems };
  // Re-derived, so a stored style can never carry text that doesn't read.
  const style = { ...styleFrom(st!.mood, { background: st!.background, text: st!.text, accent: st!.accent }, st!.type, { field: !!(extras as any).gradient }), ...extras };
  return { ok: true, data: { kind: "deck", title: title!, subtitle: subtitle!, logo, slides, style, ...(logoMeta ? { logoMeta } : {}), ...(coverArt ? { coverArt } : {}), ...(coverImage ? { coverImage } : {}), ...(deckPlace ? { place: deckPlace } : {}) } };
}

// Pure: the member assets a deck places (its logo and slide images).
export function deckAssetIds(d: DeckData): string[] {
  return [...new Set([d.logo, d.coverImage, ...d.slides.map((s) => s.image)].filter((x): x is string => !!x))];
}

export function isDeckData(d: unknown): boolean {
  return !!d && typeof d === "object" && (d as any).kind === "deck";
}

// ---------------------------------------------------------------- layouts

// Pure: each slide's layout, the deck's grammar's way (art.ts composeLayouts): Co's pick stands when the slide has what it needs, the
// rest from each slide's shape; never three of a kind in a row; no more than half the slides on a title + numbered list layout.
export function slideLayouts(slides: Pick<Slide, "bullets" | "image" | "layout" | "photos" | "map">[], grammar: Grammar = "editorial"): SlideLayout[] {
  return composeLayouts(slides, grammar).layouts as SlideLayout[];
}

// Pure: a color moved toward black or white until it reads on a ground at the ratio asked.
export function readableOn(color: string, ground: string, min: number): string {
  if (contrast(color, ground) >= min) return color;
  const darker = contrast("#000000", ground) > contrast("#FFFFFF", ground);
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const to = darker ? 0 : 255;
    const c = `#${[1, 3, 5].map((i) => Math.round(parseInt(color.slice(i, i + 2), 16) + (to - parseInt(color.slice(i, i + 2), 16)) * t).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    if (contrast(c, ground) >= min) return c;
  }
  return darker ? "#000000" : "#FFFFFF";
}

// Pure: the last two words of a headline held together, so a headline never ends on one word alone.
export const noOrphan = (escaped: string) => escaped.replace(/(\d) ([AaPp]\.?[Mm]\b)/g, "$1&nbsp;$2").replace(/\s+(\S+)\s*$/, "&nbsp;$1");

// ---------------------------------------------------------------- the renderer

const e = escapeHtml;

function asOf(d: Date, zone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone ?? "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  }
}

const DENSITY = {
  airy: { pad: 7.4, h1: 7.2, h2: 4.5, li: 1.95, stmt: 5.6, gap: 1.6 },
  balanced: { pad: 6.2, h1: 6.4, h2: 3.9, li: 1.8, stmt: 5.0, gap: 1.25 },
  dense: { pad: 5.0, h1: 5.6, h2: 3.3, li: 1.6, stmt: 4.4, gap: 0.95 },
} as const;

// Pure: a color a share of the way over a ground (alpha 0 = the ground).
function mixHex(c: string, ground: string, alpha: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(c, i) * alpha + ch(ground, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// The QA's steps down for a slide that ran over: each smaller, none under the floor (an 18px body at the 1280 render, 1.41cqw).
const FIT_SCALE: Record<Fit, number> = { tight: 0.88, tighter: 0.78, tightest: 0.7 };
const BODY_FLOOR_CQW = 18.2 / 12.8;
function fitCss(dens: (typeof DENSITY)[keyof typeof DENSITY]): string {
  return FIT_STEPS.map((f) => {
    const k = FIT_SCALE[f];
    const li = Math.max(dens.li * k, BODY_FLOOR_CQW);
    return `.${f} h2{font-size:${(dens.h2 * k).toFixed(3)}cqw}.${f}.l-statement h2{font-size:${(dens.stmt * k).toFixed(3)}cqw}.${f} li,.${f} .col p,.${f} .more,.${f} .after{font-size:${li.toFixed(3)}cqw}.${f} li{padding-top:${(dens.gap * k).toFixed(3)}cqw;padding-bottom:${(dens.gap * k).toFixed(3)}cqw}`;
  }).join("\n");
}
// On a phone (design audit, 2026-10-12: a 16:9 card on a 390px screen set body type near 7px), a slide is as tall as its content and
// set in real sizes: body 16px, labels 11px, headlines 26 to 38px. Never in print or the PDF.
const PHONE_CSS = `@media (max-width:640px){
html{scroll-snap-type:none}
.slide{min-height:0;padding:8px 12px}
.frame{aspect-ratio:auto;border-radius:4px}
.in{position:relative;inset:auto;padding:28px 22px 60px}
.t-field .in,.t-editorial .in{min-height:440px;gap:40px}
.t-editorial .in{padding-bottom:72px}
.t-field h1,.t-editorial h1{font-size:38px;max-width:none}
.t-centered h1{font-size:32px}
.t-field .sub,.t-editorial .sub,.t-centered .sub{font-size:17px;margin-top:14px}
.t-editorial .strip{height:10px}
.lab{font-size:11px}
.foot,.t-editorial .foot-ed{font-size:11px;position:relative;left:auto;right:auto;bottom:auto;padding:0 22px 18px;flex-wrap:wrap}
.foot{gap:6px 12px}.foot span{white-space:normal;overflow:visible}
.in{padding-bottom:28px}
.t-field .in,.t-editorial .in{padding-bottom:28px}
.logo{height:40px;max-width:60%}.plate .logo{height:34px}.t-centered .logo{height:56px;margin-bottom:22px}
.logo.small{height:auto;max-height:40px}.plate .logo.small{max-height:34px}.t-centered .logo.small{max-height:56px}
.plate{padding:10px 12px;border-radius:5px}
.kicker{margin:0 0 14px}
.l-points .in{display:flex;flex-direction:column;gap:18px;padding-top:28px}
.l-points h2,.l-grid h2,.l-split h2,.tight h2,.tighter h2,.tightest h2{font-size:26px}
.l-statement h2,.l-statement.tight h2,.l-statement.tighter h2,.l-statement.tightest h2{font-size:30px}
.l-points li,.l-statement li,.l-split li,.l-grid .col p,.more,.l-statement .after,.tight li,.tighter li,.tightest li,.tight .col p,.tighter .col p,.tightest .col p{font-size:16px}
.l-points li{padding:12px 0}
.l-split li{padding:0 0 10px 18px}
.l-split li::before{width:6px;height:6px}
.l-statement .after{margin-top:16px}
.l-grid h2{margin-bottom:0}
.l-grid .cols{grid-template-columns:1fr;gap:16px;margin-top:20px}
.l-grid .col{border-top-width:2px;padding-top:10px}
.l-grid .num{font-size:22px;margin-bottom:6px}
.l-split .in{right:auto}
.l-split .pic{position:relative;inset:auto;width:100%;aspect-ratio:4/3}
.l-plate .pl,.l-map .mapw,.t-spread .tfig,.l-strip .strip{position:relative;inset:auto;width:100%;height:auto}
.l-plate .pl,.t-spread .tfig{aspect-ratio:4/3}
.l-map .mapw{padding:0}
.l-plate .in,.l-map .in,.l-strip .in,.t-spread .in{position:relative;inset:auto;left:auto;right:auto;width:auto}
.l-strip .strip{display:grid;grid-template-columns:1fr;gap:8px;padding:0 12px 12px}
.l-strip .strip figure{aspect-ratio:3/2}
.g-poster.l-plate .in{position:relative;background:none;max-width:none}
.t-bleed .in{min-height:520px}
.t-bleed h1{font-size:40px}.t-bleed .sub{font-size:17px}
.t-spread h1{font-size:36px}.t-spread .sub{font-size:17px;margin-top:12px}
.l-oversized h2,.l-oversized.tight h2,.l-oversized.tighter h2,.l-oversized.tightest h2{font-size:40px}
.l-timeline .tl{grid-template-columns:1fr;gap:0;margin-top:22px}
.l-timeline .tl li{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:12px 0;border-top:1px solid currentColor}
.l-timeline .tl li::before{display:none}
.l-timeline .tl .when{font-size:17px!important;margin:0}
.l-asym .in{display:flex;flex-direction:column;gap:18px;align-items:stretch}
.g-catalog.t-spread .tfig,.g-catalog.l-plate .pl,.g-poster.l-plate .pl{position:relative;inset:auto;top:auto;left:auto;right:auto;bottom:auto;width:100%;aspect-ratio:4/3}
.g-catalog.l-plate .in,.g-poster.l-plate .in{position:relative;inset:auto;left:auto;right:auto;width:auto;padding:22px 22px 24px}
.g-menu.t-spread .in{align-items:flex-start;text-align:left}
.l-asym .cell:first-child p{font-size:22px}
.l-courses li .dish{font-size:22px}
.frame [data-qa-text=body]{font-size:16px!important;line-height:1.5}
.frame [data-qa-text=h3]{font-size:20px!important}
.l-asym .cell:first-child p{font-size:20px!important}
.l-plate h2,.l-strip h2,.l-map h2,.l-timeline h2,.l-asym h2{font-size:26px}
.l-strip .top{grid-template-columns:1fr;gap:12px}
.l-map ul{margin-top:14px}
.credit{font-size:11px;position:absolute}
.map{aspect-ratio:16/10;height:auto}
.map .pin b{width:22px;height:22px;font-size:11px}
.map .pl{font-size:11px}
.osm{font-size:11px}
.l-courses h2{font-size:26px}
}`;

// One slide per screen, 16:9, scrolled (and printed) one at a time. No scripts, no controls: a link that reads on a phone or a laptop.
// assetBase: where this view's images are served, relative to the page's own address ("<deck id>/a/" under /d/, "<share id>/a/" under
// /d/v/), so a share link never shows the owner's own link.
// showNotes: speaker notes are for the speaker, so only their own link shows them; a share link (their audience) never does (review
// of PR 3). Never printed.
// imageSrc: where an image's bytes come from, when not the deck's own link (the PDF export inlines them, PR 4). print: one 16:9 page
// per slide, edge to edge, no downloads bar (the PDF export). downloads: the deck's own export links, relative to its address.
export function renderDeck(
  page: { id: string; data: DeckData; updatedAt: Date },
  o: { url: string | null; zone?: string | null; assetBase?: string; showNotes?: boolean; imageSrc?: (assetId: string) => string | null; print?: boolean; downloadBase?: string; artSrc?: (ref: string) => string | null },
): string {
  const d = page.data;
  const s = d.style;
  const display = s.display ?? DEFAULT_FONTS[s.type];
  const body = s.body ?? (s.display ? DEFAULT_FONTS.sans : DEFAULT_FONTS[s.type]);
  const dens = DENSITY[s.density ?? "airy"];
  const loud = s.mood === "bold" || s.mood === "playful";
  // The field: their gradient, else their accent as a solid. Its ink reads on every stop of it.
  const stops = s.gradient && s.accent2 ? [s.accent, s.accent2] : [s.accent];
  const field = stops.length > 1 ? `linear-gradient(120deg, ${stops[0]} 0%, ${stops[1]} 100%)` : stops[0];
  const fieldInk = inkOn(stops, [s.text, s.background]);
  // The accent where it's text on the paper (index numbers, labels): shaded until it reads.
  const accOnPaper = readableOn(s.accent, s.background, 3);
  // Small labels (the index numbers) read at 4.5:1 (design audit: labels were never measured, and sat at 3.4:1).
  const labOnPaper = readableOn(s.accent, s.background, 4.6);
  // The foot line, quieter than the text but never under 4.5:1: their text color softened toward the paper, then shaded back until it
  // reads (review: a foot failing at 72% opacity re-inked the member's whole text color).
  const footInk = readableOn(mixHex(s.text, s.background, 0.72), s.background, 4.6);
  // Labels on a color field (the foot line, an index number) sit on a light scrim of the field's own ink's opposite, so they read
  // wherever the gradient runs; data-ground tells QA the ground they're really on.
  const scrimInk = contrast(fieldInk, "#000000") > contrast(fieldInk, "#FFFFFF") ? "#000000" : "#FFFFFF";
  const scrimGround = stops.map((c) => mixHex(scrimInk, c, 0.32)).join(",");
  const titleLayout = s.titleLayout ?? (s.gradient || loud ? "field" : "editorial");
  const displayWeight = display.kind === "serif" ? (loud ? 600 : 400) : loud || s.mood === "dark" ? 800 : 650;
  const grammar: Grammar = s.grammar ?? "editorial";
  const layouts = slideLayouts(d.slides, grammar);
  const ground = (onField: boolean) => (onField ? stops.join(",") : s.background);

  const css = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-snap-type:y mandatory}
body{margin:0;background:${s.background};color:${s.text};font-family:${fontStack(body)};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.slide{scroll-snap-align:center;min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:16px}
.frame{width:min(100%,1180px);aspect-ratio:16/9;position:relative;container-type:inline-size;overflow:hidden;background:${s.background};color:${s.text};border-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,0.06),0 12px 40px rgba(0,0,0,0.08)}
.in{position:absolute;inset:0;padding:${dens.pad}cqw ${dens.pad * 1.1}cqw;display:flex;flex-direction:column}
.on-field{background:${field};color:${fieldInk}}
.frame.on-field .sub,.frame.on-field .after,.frame.on-field li{opacity:1}
.disp{font-family:${fontStack(display)};font-weight:${displayWeight};letter-spacing:${display.kind === "serif" ? "-0.015em" : "-0.03em"};line-height:1.02;margin:0;text-wrap:balance}
.lab{font-size:1.05cqw;letter-spacing:0.18em;text-transform:uppercase;font-weight:600}
.more{margin:2cqw 0 0;font-size:${dens.li}cqw}
.paper .lab.acc{color:${labOnPaper}}
.on-field .foot{opacity:1}
.on-field .foot span,.on-field .lab{background:${scrimInk === "#000000" ? "rgba(0,0,0,0.32)" : "rgba(255,255,255,0.32)"};padding:0.3cqw 0.6cqw;border-radius:0.3cqw;opacity:1}
.foot{position:absolute;left:${dens.pad * 1.1}cqw;right:${dens.pad * 1.1}cqw;bottom:${dens.pad * 0.55}cqw;display:flex;justify-content:space-between;font-size:0.95cqw;letter-spacing:0.14em;text-transform:uppercase;color:${footInk}}
/* title: field */
.t-field .in{justify-content:space-between}
.t-field h1{font-size:${dens.h1 * 1.18}cqw;max-width:13ch}
.t-field .sub{font-size:2.1cqw;line-height:1.35;max-width:46ch;margin:2.2cqw 0 0;opacity:0.92;font-weight:450}
/* title: editorial */
.t-editorial .in{justify-content:space-between;padding-bottom:${dens.pad + 3}cqw}
.t-editorial .top{display:flex;justify-content:space-between;align-items:flex-start}
.t-editorial h1{font-size:${dens.h1}cqw;max-width:14ch}
.t-editorial .sub{font-size:1.95cqw;line-height:1.4;max-width:44ch;margin:2cqw 0 0;opacity:0.72}
.t-editorial .foot-ed{bottom:3.6cqw}
.t-editorial .strip{position:absolute;left:0;right:0;bottom:0;height:2.6cqw;background:${field}}
/* title: centered */
.t-centered .in{align-items:center;justify-content:center;text-align:center}
.t-centered h1{font-size:${dens.h1 * 0.82}cqw;max-width:18ch}
.t-centered .sub{font-size:1.9cqw;line-height:1.4;max-width:42ch;margin:1.8cqw auto 0;opacity:0.72}
.t-centered .logo{height:9cqw;margin:0 auto 3cqw}
.t-centered .rule{width:5cqw;height:0.3cqw;background:${field};margin:2.4cqw auto 0}
/* the logo, placed by its own pixels */
.logo{display:block;height:5.4cqw;width:auto;max-width:28cqw;object-fit:contain;object-position:left center}
.plate{display:inline-flex;padding:1.2cqw 1.6cqw;border-radius:0.6cqw}
.plate .logo{height:4.4cqw}
/* a small logo (fewer pixels than the slot): drawn at its own pixels at most, never stretched soft */
.logo.small{height:auto;width:auto;max-height:5.4cqw}
.plate .logo.small{height:auto;max-height:4.4cqw}
.t-centered .logo.small{height:auto;max-height:9cqw}
.on-field .logo.drop-light{mix-blend-mode:multiply}
.on-field .logo.drop-dark{filter:invert(1);mix-blend-mode:screen}
/* content */
.kicker{display:flex;gap:1.6cqw;align-items:baseline;margin:0 0 2.4cqw}
.l-points .in{display:grid;grid-template-columns:0.95fr 1.05fr;gap:5cqw;align-items:start;padding-top:${dens.pad + 2.4}cqw}
.l-points h2{font-size:${dens.h2}cqw}
.l-points ul{list-style:none;margin:0;padding:0}
.l-points li{font-size:${dens.li}cqw;line-height:1.45;padding:${dens.gap}cqw 0;border-top:1px solid ${s.text}26}
.l-points li:last-child{border-bottom:1px solid ${s.text}26}
.l-grid h2{font-size:${dens.h2}cqw;max-width:22ch;margin-bottom:auto}
.l-grid .cols{display:grid;grid-template-columns:repeat(var(--n),1fr);gap:3cqw;margin-top:3cqw}
.l-grid .col{border-top:0.25cqw solid ${s.gradient ? s.accent : accOnPaper};padding-top:1.6cqw}
.l-grid .num{font-family:${fontStack(display)};font-size:3.2cqw;line-height:1;color:${accOnPaper};margin-bottom:1.2cqw;font-weight:${displayWeight}}
.l-grid .col p{margin:0;font-size:${dens.li * 0.95}cqw;line-height:1.45}
.l-statement .in{justify-content:center}
.l-statement h2{font-size:${dens.stmt}cqw;max-width:17ch}
.l-statement .after{font-size:2cqw;line-height:1.45;max-width:48ch;margin:3cqw 0 0;opacity:0.85}
.l-statement ul{list-style:none;margin:2.4cqw 0 0;padding:0}
.l-statement li{font-size:${dens.li}cqw;line-height:1.45;padding:0.5cqw 0;opacity:0.85}
.l-split .in{right:44%;justify-content:center}
.l-split h2{font-size:${dens.h2 * 0.92}cqw}
.l-split ul{list-style:none;margin:2.6cqw 0 0;padding:0}
.l-split li{position:relative;font-size:${dens.li}cqw;line-height:1.45;padding:0 0 ${dens.gap}cqw 1.8cqw}
.l-split li::before{content:"";position:absolute;left:0;top:0.62em;width:0.7cqw;height:0.7cqw;border-radius:50%;background:${accOnPaper}}
.l-split .pic{position:absolute;top:0;right:0;bottom:0;width:44%;background:${field};display:flex;align-items:center;justify-content:center;overflow:hidden}
.l-split .pic img{width:100%;height:100%;object-fit:cover;object-position:center top}
.l-split .pic.small img{width:auto;height:auto;max-width:70%;max-height:60%;object-fit:contain;box-shadow:0 1cqw 3cqw rgba(0,0,0,0.18)}
.l-split .pic.plate img{width:auto;height:auto;max-width:84%;max-height:84%;object-fit:contain;box-shadow:0 1cqw 3cqw rgba(0,0,0,0.18)}
${fitCss(dens)}
/* art direction (art.ts): pictures, credits, maps, and each grammar's layouts */
.fig{position:relative;margin:0;overflow:hidden;background:${mixHex(s.text, s.background, 0.08)}}
.fig img.ph{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.fig img.ph.whole{object-fit:contain}
.credit{position:absolute;left:1cqw;bottom:1cqw;max-width:calc(100% - 2cqw);font-size:0.9cqw;line-height:1.35;letter-spacing:0.04em;color:#FFFFFF;background:rgba(0,0,0,0.66);padding:0.35cqw 0.7cqw;border-radius:0.3cqw}
.credit a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.tplate{position:absolute;inset:0;width:100%;height:100%}
.map{position:relative;margin:0;overflow:hidden;width:100%;height:100%;background:#E8E4DC}
.mapc{position:absolute;inset:0}
.map .tile{position:absolute;display:block;max-width:none}
.map .pin{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:0.3cqw}
.map .pin b{display:flex;align-items:center;justify-content:center;width:2.4cqw;height:2.4cqw;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${s.accent};color:${inkOn([s.accent], [s.background, s.text])};font-size:1cqw;box-shadow:0 0.3cqw 0.8cqw rgba(0,0,0,0.3)}
.map .pin b{font-family:${fontStack(body)}}
.map .pin.below .pl{order:1}
.map .pl{order:-1;background:#FFFFFF;color:#111111;font-size:0.95cqw;padding:0.25cqw 0.6cqw;border-radius:0.3cqw;white-space:nowrap;box-shadow:0 0.2cqw 0.6cqw rgba(0,0,0,0.2)}
.osm{position:absolute;right:0;bottom:0;font-size:0.9cqw;background:rgba(255,255,255,0.88);color:#222222;padding:0.25cqw 0.6cqw}
.osm a{color:inherit;text-decoration:none}
/* title: a picture on the cover */
.t-bleed .fig{position:absolute;inset:0}
.t-bleed .scrim{position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,0.8) 0%,rgba(0,0,0,0.62) 46%,rgba(0,0,0,0) 78%)}
.t-bleed .in{justify-content:flex-end;color:#FFFFFF;z-index:1}
.t-bleed h1{font-size:${dens.h1 * (grammar === "poster" ? 1.45 : 1.05)}cqw;max-width:${grammar === "poster" ? 11 : 15}ch}
.t-bleed .sub{font-size:2cqw;line-height:1.35;max-width:46ch;margin:1.8cqw 0 0}
.t-bleed .credit{left:auto;right:1cqw;bottom:auto;top:1cqw;z-index:2}
.t-bleed .foot{color:#FFFFFF;z-index:2}
.t-spread .in{right:50%;justify-content:space-between}
.t-spread h1{font-size:${Math.min(dens.h1 * 0.8, 4.9)}cqw;max-width:none}
.t-spread .sub{font-size:2cqw;line-height:1.4;margin:1.8cqw 0 0;opacity:0.8}
.t-spread .tfig{position:absolute;top:0;right:0;bottom:0;width:50%}
.g-menu.t-spread .in{align-items:center;text-align:center}
.g-catalog.t-spread .tfig{top:${dens.pad}cqw;bottom:${dens.pad}cqw;right:${dens.pad}cqw;width:44%}
/* plate: a large captioned picture (catalog: an asymmetric spread; poster: full bleed) */
.l-plate .pl{position:absolute;top:0;left:0;bottom:0;width:58%}
.l-plate .in{left:58%}
.l-plate h2{font-size:${dens.h2 * 0.85}cqw}
.l-plate ul{list-style:none;margin:2cqw 0 0;padding:0}
.l-plate li{font-size:${dens.li}cqw;line-height:1.45;padding:0 0 ${dens.gap}cqw}
.l-plate .plab{margin:0 0 1.6cqw}
.g-catalog.l-plate .pl{top:${dens.pad}cqw;bottom:${dens.pad}cqw;left:${dens.pad * 1.1}cqw;width:52%}
.g-catalog.l-plate .in{left:58%;justify-content:flex-end}
.g-poster.l-plate .pl{width:100%}
.g-poster.l-plate .in{left:auto;right:${dens.pad}cqw;top:auto;bottom:${dens.pad}cqw;width:44%;position:absolute;inset:auto ${dens.pad}cqw ${dens.pad}cqw auto;background:${s.background};padding:3cqw}
/* strip: photos in a row under the headline */
.l-strip .in{bottom:48%}
.l-strip .top{display:grid;grid-template-columns:1fr 1fr;gap:4cqw;align-items:start}
.l-strip h2{font-size:${dens.h2 * 0.85}cqw}
.l-strip ul{list-style:none;margin:0;padding:0}
.l-strip li{font-size:${dens.li}cqw;line-height:1.45;padding:0 0 ${dens.gap * 0.7}cqw}
.l-strip .strip{position:absolute;left:${dens.pad * 1.1}cqw;right:${dens.pad * 1.1}cqw;bottom:${dens.pad + 1.5}cqw;height:38%;display:grid;grid-template-columns:repeat(var(--n),1fr);gap:1.4cqw}
/* map */
.l-map .mapw{position:absolute;top:0;right:0;bottom:0;width:58%}
.l-map .in{right:58%}
.l-map h2{font-size:${dens.h2 * 0.85}cqw}
.l-map ul{list-style:none;margin:2cqw 0 0;padding:0}
.l-map .foot span:last-child{background:${s.background};padding:0.3cqw 0.6cqw;border-radius:0.3cqw}
.l-map li{font-size:${dens.li}cqw;line-height:1.45;padding:0 0 ${dens.gap * 0.8}cqw}
/* timeline */
.l-timeline h2{font-size:${dens.h2}cqw;max-width:24ch}
.l-timeline .in{justify-content:center}
.l-timeline .tl{list-style:none;margin:6cqw 0 0;padding:0;display:grid;grid-template-columns:repeat(var(--n),1fr);gap:2.4cqw;position:relative}
.l-timeline .tl li{position:relative;padding-top:2.6cqw;border-top:0.25cqw solid ${s.gradient ? s.accent : accOnPaper};font-size:${dens.li}cqw;line-height:1.45}
.l-timeline .tl li::before{content:"";position:absolute;top:-0.85cqw;left:0;width:1.4cqw;height:1.4cqw;border-radius:50%;background:${s.gradient ? s.accent : accOnPaper}}
.l-timeline .when{display:block;font-family:${fontStack(display)};font-size:${dens.li * 1.3}cqw;line-height:1.1;margin:0 0 0.8cqw;color:${accOnPaper};font-weight:${displayWeight}}
/* asymmetric grid: the headline holds the wide column, the points sit in unequal cells */
.l-asym .in{display:grid;grid-template-columns:1.25fr 1fr;gap:5cqw;align-items:center}
.l-asym h2{font-size:${dens.h2}cqw}
.l-asym .cells{display:grid;gap:1.6cqw}
.l-asym .cell{border-top:1px solid ${s.text}33;padding-top:1.2cqw}
.l-asym .cell p{margin:0;font-size:${dens.li}cqw;line-height:1.45}
.l-asym .cell:first-child p{font-family:${fontStack(display)};font-size:${dens.li * 1.3}cqw;line-height:1.2;font-weight:${displayWeight}}
/* oversized type */
.l-oversized .in{justify-content:flex-end}
.l-oversized h2{font-size:${dens.stmt * (grammar === "poster" ? 1.75 : 1.45)}cqw;max-width:${grammar === "poster" ? 10 : 13}ch;line-height:0.98}
.l-oversized .after{font-size:${dens.li}cqw;line-height:1.45;max-width:40ch;margin:2.4cqw 0 0 auto;text-align:right}
.g-menu.l-oversized .in,.g-menu.l-statement .in{align-items:center;text-align:center;justify-content:center}
.g-menu.l-statement h2{max-width:20ch}
.g-menu.l-statement .after,.g-menu.l-statement ul{margin-left:auto;margin-right:auto}
.g-menu.l-oversized .after{margin:2.4cqw auto 0;text-align:center}
/* courses: a menu's centered column, between rules */
.l-courses .in{align-items:center;text-align:center;justify-content:center}
.l-courses h2{font-size:${dens.h2 * 0.85}cqw;max-width:26ch}
.l-courses .rule{width:6cqw;height:0;border-top:1px solid ${accOnPaper};margin:1cqw auto}
.l-courses ul{list-style:none;margin:0;padding:0;width:min(62cqw,100%)}
.l-courses li{padding:${dens.gap * 0.7}cqw 0;border-bottom:1px dotted ${s.text}40}
.l-courses li:last-child{border-bottom:0}
.l-courses .dish{display:block;font-family:${fontStack(display)};font-size:${dens.li * 1.3}cqw;line-height:1.2;font-weight:${displayWeight}}
.l-courses .desc{display:block;font-style:italic;font-size:${dens.li}cqw;line-height:1.4;margin-top:0.4cqw}
.l-courses .lab.acc{margin:0}
.notes{width:min(100%,1180px);margin:10px auto 0;font-size:clamp(13px,1.6vw,16px);line-height:1.55;opacity:0.85}
.notes summary{cursor:pointer;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.7}
.notes p{margin:8px 0 0;max-width:70ch}
.slide.with-notes{flex-direction:column}
@media print{.notes{display:none}.dl{display:none}html{scroll-snap-type:none}.slide{min-height:auto;page-break-after:always;padding:0}.frame{box-shadow:none;border-radius:0}}
.dl{position:fixed;right:16px;top:12px;font-size:12px;letter-spacing:0.08em;z-index:5}
@media (max-width:640px){.dl{position:static;text-align:right;padding:10px 16px 0}.slide{padding:10px}}
${o.print ? "" : PHONE_CSS}
.dl a{color:${s.text};opacity:0.7;text-decoration:none;border-bottom:1px solid ${s.accent};margin-left:14px}
${o.print ? `@page{size:13.333in 7.5in;margin:0}html,body{margin:0}.slide{width:13.333in;height:7.5in;min-height:0;padding:0;page-break-after:always;break-after:page}.frame{width:13.333in;height:7.5in;aspect-ratio:auto;border-radius:0;box-shadow:none}` : ""}
`;
  // An asset is served only under this deck's own link (relative, so it never names another host).
  const src = (id: string) => (o.imageSrc ? o.imageSrc(id) : `${o.assetBase ?? `${page.id}/a/`}${id}`);
  const img = (id: string, alt: string, cls = "") => {
    const u = src(id);
    return u ? `<img${cls ? ` class="${cls}"` : ""} src="${e(u)}" alt="${e(alt)}" decoding="async" data-qa-img>` : "";
  };
  // The logo on its ground: on the field, a one-ink logo drops its own ground (multiply for dark ink on light, screen for light on
  // dark); a cropped one sits on a plate of its own ground color; otherwise as it is.
  const logoHtml = (onField: boolean) => {
    if (!d.logo) return "";
    const m = d.logoMeta;
    const light = (h: string | null) => !!h && contrast(h, "#000000") > contrast(h, "#FFFFFF");
    if (onField && m?.mono && m.ground && m.ink) {
      const darkInkOnLight = light(m.ground) && !light(m.ink);
      const wantDark = contrast(fieldInk, "#000000") < contrast(fieldInk, "#FFFFFF");
      const cls = `${darkInkOnLight === wantDark ? "logo drop-light" : "logo drop-dark"}${m.fit === "small" ? " small" : ""}`;
      return img(d.logo, `${d.title} logo`, cls);
    }
    // A small logo (qualityOf "small", or QA found it drawn past its pixels) is drawn at its own pixels at most.
    const cls = m?.fit === "small" ? "logo small" : "logo";
    if (m?.fit === "plate" || (onField && !m?.mono)) return `<span class="plate" style="background:${m?.ground ?? "#FFFFFF"}">${img(d.logo, `${d.title} logo`, cls)}</span>`;
    return img(d.logo, `${d.title} logo`, cls);
  };
  const mark = `Made by Co · ${e(asOf(page.updatedAt, o.zone ?? null))}`;
  const total = d.slides.length + 1;
  // Pictures Co found: a venue's photo through this deck's own link (the key stays on the server), a mood image hotlinked from
  // Unsplash as its guidelines ask; maps from tiles through the same link. artSrc: the bytes inlined instead (QA, the PDF).
  const artBase = (o.assetBase ?? `${page.id}/a/`).replace(/a\/$/, "");
  const gIndex = new Map(googlePhotosIn(d).map((p, k) => [p.src, k]));
  const artUrl = (p: ArtImage): string | null => (o.artSrc ? o.artSrc(p.via === "google" ? `g:${p.src}` : `u:${p.src}`) : p.via === "google" ? (gIndex.has(p.src) ? `${artBase}g/${gIndex.get(p.src)}` : null) : p.src);
  const tileSrc = (key: string) => (o.artSrc ? o.artSrc(`t:${key}`) : `${artBase}t/${key}.png`);
  // One picture in a box: theirs (by its own pixels: a small or plate image is shown whole), or one Co found, with its credit.
  type Pic = { asset?: string; art?: ArtImage; alt: string; meta?: ImageMeta };
  const figure = (p: Pic, cls: string, extra = "") => {
    if (p.asset) {
      const u = src(p.asset);
      const whole = p.meta && p.meta.fit !== "full";
      return u ? `<figure class="fig ${cls}"${whole && p.meta?.ground ? ` style="background:${p.meta.ground}"` : ""}${extra}><img class="ph${whole ? " whole" : ""}" src="${e(u)}" alt="${e(p.alt)}" decoding="async" data-qa-img></figure>` : "";
    }
    if (p.art) {
      const u = artUrl(p.art);
      return u ? `<figure class="fig ${cls}"${extra}><img class="ph" src="${e(u)}" alt="${e(p.art.alt)}" decoding="async" data-qa-img data-qa-crop="ok">${creditHtml(p.art, e, "credit lab")}</figure>` : "";
    }
    return "";
  };
  const picsOf = (sl: Slide): Pic[] => [...(sl.image ? [{ asset: sl.image, alt: sl.headline, meta: sl.imageMeta }] : []), ...(sl.photos ?? []).map((a) => ({ art: a, alt: a.alt }))];
  // The cover: their own picture, else one Co found; with nothing at all to show (no picture, no map, no logo), a typographic plate.
  const coverPic: Pic | null = d.coverImage ? { asset: d.coverImage, alt: d.title } : d.coverArt ? { art: d.coverArt, alt: d.coverArt.alt } : null;
  const anyPicture = !!coverPic || !!d.logo || d.slides.some((sl) => picsOf(sl).length || sl.map);
  const plate = typePlate(d.title, { ground: mixHex(s.accent, s.background, 0.14), ink: readableOn(s.accent, mixHex(s.accent, s.background, 0.14), 3), accent: accOnPaper, font: fontStack(display) }, e);
  // The editorial title's small label: the subtitle's first clause, whole, or nothing (never cut mid-word).
  const kickWords = d.subtitle.split(/[.:,]/)[0].trim();
  const titleSlide = (() => {
    const foot = (cls = "") => `<div class="foot${cls}"><span data-qa-text="label">${mark}</span><span data-qa-text="label">01 / ${String(total).padStart(2, "0")}</span></div>`;
    if (coverPic && (grammar === "catalog" || grammar === "menu")) {
      return `<section class="slide title"><div class="frame t-spread g-${grammar} paper" data-qa-frame data-ground="${ground(false)}"><div class="in"><div>${d.logo ? logoHtml(false) : `<span class="lab acc" data-qa-text="label">${e(asOf(page.updatedAt, o.zone ?? null))}</span>`}</div><div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div><div></div></div>${figure(coverPic, "tfig")}${foot()}</div></section>`;
    }
    if (coverPic) {
      return `<section class="slide title"><div class="frame t-bleed g-${grammar}" data-qa-frame data-ground="#666666">${figure(coverPic, "cover")}<div class="scrim"></div><div class="in" data-ground="#666666"><div>${d.logo ? logoHtml(true) : ""}</div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div><div class="foot" data-ground="#333333"><span data-qa-text="label" data-ground="#333333">${mark}</span><span data-qa-text="label" data-ground="#333333">01 / ${String(total).padStart(2, "0")}</span></div></div></section>`;
    }
    if (!anyPicture) {
      return `<section class="slide title"><div class="frame t-spread g-${grammar} paper" data-qa-frame data-ground="${ground(false)}"><div class="in"><div><span class="lab acc" data-qa-text="label">${e(asOf(page.updatedAt, o.zone ?? null))}</span></div><div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div><div></div></div><figure class="fig tfig">${plate}</figure>${foot()}</div></section>`;
    }
    if (titleLayout === "field")
      return `<section class="slide title"><div class="frame t-field on-field" data-qa-frame data-ground="${ground(true)}"><div class="in"><div>${logoHtml(true)}</div><div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div></div><div class="foot"><span data-qa-text="label" data-ground="${scrimGround}">${mark}</span><span data-qa-text="label" data-ground="${scrimGround}">01 / ${String(total).padStart(2, "0")}</span></div></div></section>`;
    if (titleLayout === "centered")
      return `<section class="slide title"><div class="frame t-centered paper" data-qa-frame data-ground="${ground(false)}"><div class="in">${d.logo ? logoHtml(false) : ""}<h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p><div class="rule"></div></div>${foot()}</div></section>`;
    return `<section class="slide title"><div class="frame t-editorial paper" data-qa-frame data-ground="${ground(false)}"><div class="in"><div class="top">${d.logo ? logoHtml(false) : (kickWords.length <= 40 ? `<span class="lab acc" data-qa-text="label">${e(kickWords)}</span>` : "<span></span>")}<span class="lab" data-qa-text="label">${e(asOf(page.updatedAt, o.zone ?? null))}</span></div><div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div></div><div class="strip"></div><div class="foot foot-ed"><span data-qa-text="label">Made by Co</span><span data-qa-text="label">01 / ${String(total).padStart(2, "0")}</span></div></div></section>`;
  })();

  const slides = d.slides
    .map((sl, i) => {
      const n = String(i + 2).padStart(2, "0");
      const l = layouts[i];
      // Statements stand on the field when the deck has one worth standing on (a gradient, or a loud mood); otherwise on paper.
      const onField = (l === "statement" || (l === "oversized" && grammar === "poster")) && (!!s.gradient || loud);
      const tight = sl.fit ? ` ${sl.fit}` : "";
      const sg = onField ? ` data-ground="${scrimGround}"` : "";
      // The foot carries the whole title, never a cut one (craft bar: no truncated footer labels).
      const foot = `<div class="foot"><span data-qa-text="label"${sg}>${e(d.title)}</span><span data-qa-text="label"${sg}>${n} / ${String(total).padStart(2, "0")}</span></div>`;
      const h2 = `<h2 class="disp" data-qa-text="h2">${noOrphan(e(sl.headline))}</h2>`;
      const kicker = `<div class="kicker"><span class="lab acc" data-qa-text="label"${onField ? ` data-ground="${scrimGround}"` : ""}>${n}</span></div>`;
      const ul = (items: string[]) => `<ul>${items.map((b) => `<li data-qa-text="body">${e(b)}</li>`).join("")}</ul>`;
      const pics = picsOf(sl);
      let inner = "";
      if (l === "statement") {
        const [first, ...rest] = sl.bullets;
        inner = `<div class="in">${kicker}${h2}${first ? `<p class="after" data-qa-text="body">${e(first)}</p>` : ""}${rest.length ? ul(rest) : ""}</div>`;
      } else if (l === "grid") {
        inner = `<div class="in">${kicker}${h2}<div class="cols" style="--n:${Math.min(4, sl.bullets.length)}">${sl.bullets.slice(0, 4).map((b, k) => `<div class="col"><div class="num">${String(k + 1).padStart(2, "0")}</div><p data-qa-text="body">${e(b)}</p></div>`).join("")}</div>${sl.bullets.length > 4 ? `<p class="more" data-qa-text="body">${e(sl.bullets.slice(4).join(" "))}</p>` : ""}</div>`;
      } else if (l === "split") {
        const p = pics[0];
        const fit = p?.meta?.fit ?? "full";
        inner = `<div class="in">${kicker}${h2}${ul(sl.bullets)}</div>${p?.asset ? `<div class="pic ${fit}"${fit === "plate" && p.meta?.ground ? ` style="background:${p.meta.ground}"` : ""}>${img(p.asset, sl.headline)}</div>` : p ? figure(p, "pic") : ""}`;
      } else if (l === "plate") {
        inner = `${figure(pics[0], "pl")}<div class="in"><div class="plab"><span class="lab acc" data-qa-text="label">Plate ${n}</span></div>${h2}${ul(sl.bullets)}</div>`;
      } else if (l === "strip") {
        const row = pics.slice(0, 3);
        inner = `<div class="in">${kicker}<div class="top">${h2}${ul(sl.bullets)}</div></div><div class="strip" style="--n:${row.length}">${row.map((p) => figure(p, "")).join("")}</div>`;
      } else if (l === "map" && sl.map) {
        inner = `<div class="in">${kicker}${h2}<ul>${sl.bullets.map((b) => `<li data-qa-text="body">${e(b)}</li>`).join("")}</ul></div><div class="mapw">${mapHtml(sl.map, e, tileSrc)}</div>`;
      } else if (l === "timeline") {
        const items = sl.bullets.map((b) => leadOf(b) ?? { lead: "", text: b });
        inner = `<div class="in">${kicker}${h2}<ol class="tl" style="--n:${items.length}">${items.map((x) => `<li><span class="when" data-qa-text="h3">${e(x.lead)}</span><span data-qa-text="body">${e(x.text)}</span></li>`).join("")}</ol></div>`;
      } else if (l === "asym") {
        inner = `<div class="in"><div>${kicker}${h2}</div><div class="cells">${sl.bullets.slice(0, 4).map((b, k) => `<div class="cell"><p data-qa-text="${k === 0 ? "h3" : "body"}">${e(b)}</p></div>`).join("")}${sl.bullets.length > 4 ? `<div class="cell"><p data-qa-text="body">${e(sl.bullets.slice(4).join(" "))}</p></div>` : ""}</div></div>`;
      } else if (l === "oversized") {
        inner = `<div class="in">${kicker}${h2}${sl.bullets.length ? `<p class="after" data-qa-text="body">${e(sl.bullets.join(" "))}</p>` : ""}</div>`;
      } else if (l === "courses") {
        // A course: its name, then what it is, split at its first colon or " - " (never cut).
        const course = (b: string) => {
          const m = leadOf(b) ?? (b.match(/^(.{2,40}?)\s+-\s+(.{2,})$/) ? { lead: b.split(/\s+-\s+/)[0], text: b.split(/\s+-\s+/).slice(1).join(" - ") } : null);
          return m && m.lead ? `<span class="dish" data-qa-text="h3">${e(m.lead)}</span><span class="desc" data-qa-text="body">${e(m.text)}</span>` : `<span class="dish" data-qa-text="h3">${e(b)}</span>`;
        };
        inner = `<div class="in"><span class="lab acc" data-qa-text="label">${n}</span><div class="rule"></div>${h2}<div class="rule"></div><ul>${sl.bullets.map((b) => `<li>${course(b)}</li>`).join("")}</ul></div>`;
      } else {
        inner = `<div class="in"><div>${kicker}${h2}</div>${ul(sl.bullets)}</div>`;
      }
      const notes = sl.notes && o.showNotes !== false ? `<details class="notes"><summary>Speaker notes</summary><p>${e(sl.notes)}</p></details>` : "";
      return `<section class="slide${notes ? " with-notes" : ""}"><div class="frame l-${l} g-${grammar}${onField ? " on-field" : " paper"}${tight}" data-qa-frame data-qa-slide="${i + 2}" data-qa-layout="${l}" data-ground="${ground(onField)}">${inner}${foot}</div>${notes}</section>`;
    })
    .join("\n");
  const links = fontLinks([display, body]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${e(d.title)}</title>
<meta name="description" content="${e(d.subtitle)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${e(d.title)}">
<meta property="og:description" content="${e(d.subtitle)}">
<meta property="og:site_name" content="Co">
${o.url ? `<meta property="og:url" content="${e(o.url)}">` : ""}
<meta name="twitter:card" content="summary">
${links.map((h) => `<link href="${e(h)}" rel="stylesheet">`).join("\n")}
<style>${css}</style>
</head>
<body>
<main>
${o.downloadBase && !o.print ? `<div class="dl"><a href="${e(`${o.downloadBase}deck.pdf`)}" download>PDF</a><a href="${e(`${o.downloadBase}deck.pptx`)}" download>PowerPoint</a></div>` : ""}
${titleSlide}
${slides}
</main>
</body>
</html>`;
}
