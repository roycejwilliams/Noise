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
export { DECK_MOODS, MOOD_STYLES, contrast, styleFrom, type DeckMood, type DeckStyle } from "./style.js";

export const SLIDE_LAYOUTS = ["statement", "points", "grid", "split"] as const;
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
export type Slide = { headline: string; bullets: string[]; image: string | null; notes?: string; layout?: SlideLayout; imageMeta?: ImageMeta; fit?: Fit };
export type DeckData = { kind: "deck"; title: string; subtitle: string; logo: string | null; slides: Slide[]; style: DeckStyle; logoMeta?: ImageMeta };
const ASSET = /^[A-Za-z0-9_-]{24}$/;
const HEX = /^#[0-9a-f]{6}$/i;

export const DECK_LIMITS = { title: 90, subtitle: 140, slidesMin: 2, slides: 15, headline: 90, bulletsMin: 1, bullets: 4, bullet: 160, notes: 700 } as const;

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
  const o = obj(input, "the deck", ["kind", "title", "subtitle", "logo", "slides", "style", "logoMeta"], problems);
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
      const r = obj(s, f, ["headline", "bullets", "image", "notes", "layout", "imageMeta", "fit"], problems);
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
      return headline && bullets.length
        ? { headline, bullets, image, ...(notes ? { notes } : {}), ...(layout ? { layout } : {}), ...(meta ? { imageMeta: meta } : {}), ...(FIT_STEPS.includes(r.fit as Fit) ? { fit: r.fit as Fit } : {}) }
        : null;
    })
    .filter((x): x is Slide => !!x);
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
  return { ok: true, data: { kind: "deck", title: title!, subtitle: subtitle!, logo, slides, style, ...(logoMeta ? { logoMeta } : {}) } };
}

// Pure: the member assets a deck places (its logo and slide images).
export function deckAssetIds(d: DeckData): string[] {
  return [...new Set([d.logo, ...d.slides.map((s) => s.image)].filter((x): x is string => !!x))];
}

export function isDeckData(d: unknown): boolean {
  return !!d && typeof d === "object" && (d as any).kind === "deck";
}

// ---------------------------------------------------------------- layouts

// Pure: each slide's layout. Co's pick stands; otherwise from the slide's shape: a picture splits, one line is a statement, two to four
// short points are a grid, anything else is points. Never three of a kind in a row (points and grid trade places when a slide fits).
export function slideLayouts(slides: Pick<Slide, "bullets" | "image" | "layout">[]): SlideLayout[] {
  const fitsGrid = (s: Pick<Slide, "bullets">) => s.bullets.length >= 2 && s.bullets.length <= 4 && s.bullets.every((b) => b.length <= 95);
  const out: SlideLayout[] = [];
  slides.forEach((s, i) => {
    let l: SlideLayout = s.layout ?? (s.image ? "split" : s.bullets.length === 1 ? "statement" : fitsGrid(s) ? "grid" : "points");
    if (!s.layout && i >= 2 && out[i - 1] === l && out[i - 2] === l) {
      if (l === "grid") l = "points";
      else if (l === "points" && fitsGrid(s)) l = "grid";
    }
    out.push(l);
  });
  return out;
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
export const noOrphan = (escaped: string) => escaped.replace(/\s+(\S+)\s*$/, "&nbsp;$1");

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
.foot,.t-editorial .foot-ed{font-size:11px;left:22px;right:22px;bottom:20px}
.foot{gap:12px}.foot span{white-space:nowrap}.foot span:first-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
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
  o: { url: string | null; zone?: string | null; assetBase?: string; showNotes?: boolean; imageSrc?: (assetId: string) => string | null; print?: boolean; downloadBase?: string },
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
  // Labels on a color field (the foot line, an index number) sit on a light scrim of the field's own ink's opposite, so they read
  // wherever the gradient runs; data-ground tells QA the ground they're really on.
  const scrimInk = contrast(fieldInk, "#000000") > contrast(fieldInk, "#FFFFFF") ? "#000000" : "#FFFFFF";
  const scrimGround = stops.map((c) => mixHex(scrimInk, c, 0.32)).join(",");
  const titleLayout = s.titleLayout ?? (s.gradient || loud ? "field" : "editorial");
  const displayWeight = display.kind === "serif" ? (loud ? 600 : 400) : loud || s.mood === "dark" ? 800 : 650;
  const layouts = slideLayouts(d.slides);
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
.foot{position:absolute;left:${dens.pad * 1.1}cqw;right:${dens.pad * 1.1}cqw;bottom:${dens.pad * 0.55}cqw;display:flex;justify-content:space-between;font-size:0.95cqw;letter-spacing:0.14em;text-transform:uppercase;opacity:0.72}
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
  const titleSlide = (() => {
    if (titleLayout === "field")
      return `<section class="slide title"><div class="frame t-field on-field" data-qa-frame data-ground="${ground(true)}"><div class="in"><div>${logoHtml(true)}</div><div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div></div><div class="foot"><span data-qa-text="label" data-ground="${scrimGround}">${mark}</span><span data-qa-text="label" data-ground="${scrimGround}">01 / ${String(total).padStart(2, "0")}</span></div></div></section>`;
    if (titleLayout === "centered")
      return `<section class="slide title"><div class="frame t-centered paper" data-qa-frame data-ground="${ground(false)}"><div class="in">${d.logo ? logoHtml(false).replace('class="logo', 'class="logo') : ""}<h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p><div class="rule"></div></div><div class="foot"><span data-qa-text="label">${mark}</span><span data-qa-text="label">01 / ${String(total).padStart(2, "0")}</span></div></div></section>`;
    return `<section class="slide title"><div class="frame t-editorial paper" data-qa-frame data-ground="${ground(false)}"><div class="in"><div class="top">${d.logo ? logoHtml(false) : `<span class="lab acc" data-qa-text="label">${e(d.subtitle.split(/[.:,]/)[0].slice(0, 40))}</span>`}<span class="lab" data-qa-text="label">${e(asOf(page.updatedAt, o.zone ?? null))}</span></div><div><h1 class="disp" data-qa-text="h1">${noOrphan(e(d.title))}</h1><p class="sub" data-qa-text="body">${e(d.subtitle)}</p></div></div><div class="strip"></div><div class="foot foot-ed"><span data-qa-text="label">Made by Co</span><span data-qa-text="label">01 / ${String(total).padStart(2, "0")}</span></div></div></section>`;
  })();

  const slides = d.slides
    .map((sl, i) => {
      const n = String(i + 2).padStart(2, "0");
      const l = layouts[i];
      // Statements stand on the field when the deck has one worth standing on (a gradient, or a loud mood); otherwise on paper.
      const onField = l === "statement" && (!!s.gradient || loud);
      const tight = sl.fit ? ` ${sl.fit}` : "";
      const sg = onField ? ` data-ground="${scrimGround}"` : "";
      const foot = `<div class="foot"><span data-qa-text="label"${sg}>${e(d.title.slice(0, 60))}</span><span data-qa-text="label"${sg}>${n} / ${String(total).padStart(2, "0")}</span></div>`;
      const h2 = `<h2 class="disp" data-qa-text="h2">${noOrphan(e(sl.headline))}</h2>`;
      const kicker = `<div class="kicker"><span class="lab acc" data-qa-text="label"${onField ? ` data-ground="${scrimGround}"` : ""}>${n}</span></div>`;
      let inner = "";
      if (l === "statement") {
        const [first, ...rest] = sl.bullets;
        inner = `<div class="in">${kicker}${h2}${first ? `<p class="after" data-qa-text="body">${e(first)}</p>` : ""}${rest.length ? `<ul>${rest.map((b) => `<li data-qa-text="body">${e(b)}</li>`).join("")}</ul>` : ""}</div>`;
      } else if (l === "grid") {
        inner = `<div class="in">${kicker}${h2}<div class="cols" style="--n:${Math.min(4, sl.bullets.length)}">${sl.bullets.slice(0, 4).map((b, k) => `<div class="col"><div class="num">${String(k + 1).padStart(2, "0")}</div><p data-qa-text="body">${e(b)}</p></div>`).join("")}</div>${sl.bullets.length > 4 ? `<p class="more" data-qa-text="body">${e(sl.bullets.slice(4).join(" "))}</p>` : ""}</div>`;
      } else if (l === "split") {
        const fit = sl.imageMeta?.fit ?? "full";
        inner = `<div class="in">${kicker}${h2}<ul>${sl.bullets.map((b) => `<li data-qa-text="body">${e(b)}</li>`).join("")}</ul></div>${sl.image ? `<div class="pic ${fit}"${fit === "plate" && sl.imageMeta?.ground ? ` style="background:${sl.imageMeta.ground}"` : ""}>${img(sl.image, sl.headline)}</div>` : ""}`;
      } else {
        inner = `<div class="in"><div>${kicker}${h2}</div><ul>${sl.bullets.map((b) => `<li data-qa-text="body">${e(b)}</li>`).join("")}</ul></div>`;
      }
      const notes = sl.notes && o.showNotes !== false ? `<details class="notes"><summary>Speaker notes</summary><p>${e(sl.notes)}</p></details>` : "";
      return `<section class="slide${notes ? " with-notes" : ""}"><div class="frame l-${l}${onField ? " on-field" : " paper"}${tight}" data-qa-frame data-qa-slide="${i + 2}" data-qa-layout="${l}" data-ground="${ground(onField)}">${inner}${foot}</div>${notes}</section>`;
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
