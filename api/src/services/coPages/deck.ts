// A deck: the second artifact type on the Co page pipeline (Royce, 2026-10-11: "make me a pitch deck about my startup" gets back a link
// to a hosted deck). Same store, same /d/ link, same rules as a page (store.ts: owner-only changes, noindex, 90-day expiry, wiped on
// take-down), same grounding (grounding.ts deckProblems). Only the shape and the renderer differ: a title slide, then content slides
// of a headline and a few bullets. No speaker notes, no themes to pick, no export.
//
// The look comes from the member's own taste (services/designTaste.ts), never a fixed Co theme: a mood, and the colors they named.
// Colors are plain six-digit hex only, checked here, so nothing but a color can reach the CSS. Text that wouldn't read on its
// background falls back to the mood's own pairing. Like a page, every field is plain text, escaped, and the model writes no HTML.
import { escapeHtml } from "../emailDesign.js";
import { list, obj, plain } from "./schema.js";

import { DECK_MOODS, contrast, styleFrom, type DeckMood, type DeckStyle } from "./style.js";
export { DECK_MOODS, MOOD_STYLES, contrast, styleFrom, type DeckMood, type DeckStyle } from "./style.js";
// image / logo: a member asset's id (services/memberAssets.ts), one of the owner's own images; never a URL. The store checks the
// owner, and the image is served only through this deck's own link (routes/coPage.ts).
// notes: speaker notes for this slide, only when the member asked for them (PR 3, 2026-10-11); shown under the slide, folded.
export type Slide = { headline: string; bullets: string[]; image: string | null; notes?: string };
export type DeckData = { kind: "deck"; title: string; subtitle: string; logo: string | null; slides: Slide[]; style: DeckStyle };
const ASSET = /^[A-Za-z0-9_-]{24}$/;
const HEX = /^#[0-9a-f]{6}$/i;

export const DECK_LIMITS = { title: 90, subtitle: 140, slidesMin: 2, slides: 15, headline: 90, bulletsMin: 1, bullets: 5, bullet: 160, notes: 700 } as const;

// The one gate for a deck, like parseCoPageData for a page: unknown fields refused, every line plain, colors hex only.
export function parseCoDeckData(input: unknown): { ok: true; data: DeckData } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const o = obj(input, "the deck", ["kind", "title", "subtitle", "logo", "slides", "style"], problems);
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
  const slides = list(o.slides, "slides", L.slides, problems, L.slidesMin)
    .map((s, i) => {
      const f = `slides[${i}]`;
      const r = obj(s, f, ["headline", "bullets", "image", "notes"], problems);
      if (!r) return null;
      const headline = plain(r.headline, `${f}.headline`, L.headline, problems, true);
      const bullets = list(r.bullets, `${f}.bullets`, L.bullets, problems, L.bulletsMin)
        .map((b, j) => plain(b, `${f}.bullets[${j}]`, L.bullet, problems, true))
        .filter((x): x is string => !!x);
      const image = asset(r.image, `${f}.image`);
      const notes = plain(r.notes, `${f}.notes`, L.notes, problems, false);
      return headline && bullets.length ? { headline, bullets, image, ...(notes ? { notes } : {}) } : null;
    })
    .filter((x): x is Slide => !!x);
  const st = obj(o.style, "style", ["mood", "background", "text", "accent", "type"], problems);
  if (st) {
    if (!DECK_MOODS.includes(st.mood as DeckMood)) problems.push(`style.mood must be one of ${DECK_MOODS.join(", ")}`);
    for (const k of ["background", "text", "accent"] as const) if (typeof st[k] !== "string" || !HEX.test(String(st[k]))) problems.push(`style.${k} must be a six-digit hex color`);
    if (st.type !== "serif" && st.type !== "sans") problems.push("style.type must be serif or sans");
  }
  if (problems.length) return { ok: false, problems };
  // Re-derived, so a stored style can never carry text that doesn't read.
  const style = styleFrom(st!.mood, { background: st!.background, text: st!.text, accent: st!.accent }, st!.type);
  return { ok: true, data: { kind: "deck", title: title!, subtitle: subtitle!, logo, slides, style } };
}

// Pure: the member assets a deck places (its logo and slide images).
export function deckAssetIds(d: DeckData): string[] {
  return [...new Set([d.logo, ...d.slides.map((s) => s.image)].filter((x): x is string => !!x))];
}

export function isDeckData(d: unknown): boolean {
  return !!d && typeof d === "object" && (d as any).kind === "deck";
}

// ---------------------------------------------------------------- the renderer

const e = escapeHtml;
const FONTS = {
  serif: { css: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&display=swap", family: "'Fraunces', Georgia, serif" },
  sans: { css: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap", family: "'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" },
} as const;

function asOf(d: Date, zone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone ?? "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  }
}

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
  const f = FONTS[s.type];
  // Headlines in the display weight; on "bold" and "playful", heavier and tighter.
  const heavy = s.mood === "bold" || s.mood === "playful";
  // The title slide: on "bold" and "playful", the accent as a full field (when the background color reads on it); on every other mood,
  // the deck's own background with the accent kept to the rule and the logo (live run, 2026-10-11: a gold field was loud for
  // "quiet and premium like Aesop's site").
  const field = heavy && contrast(s.background, s.accent) >= 4.5;
  const titleInk = field ? s.background : s.text;
  const titleBg = field ? s.accent : s.background;
  const css = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-snap-type:y mandatory}
body{margin:0;background:${s.background};color:${s.text};font-family:${f.family};-webkit-font-smoothing:antialiased}
.slide{scroll-snap-align:center;min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:16px}
.frame{width:min(100%,1100px);aspect-ratio:16/9;position:relative;display:flex;flex-direction:column;justify-content:center;padding:clamp(20px,6vw,72px);border:1px solid ${s.text}1F;border-radius:4px;background:${s.background};overflow:hidden}
.title .frame{background:${titleBg};color:${titleInk};border-color:transparent}
h1{font-size:clamp(26px,5.4vw,64px);line-height:1.04;margin:0;font-weight:${heavy ? 700 : s.type === "serif" ? 300 : 600};letter-spacing:-0.02em;max-width:16ch}
.sub{margin:clamp(10px,2vw,22px) 0 0;font-size:clamp(13px,1.9vw,22px);opacity:0.8;max-width:40ch}
h2{font-size:clamp(20px,3.6vw,44px);line-height:1.1;margin:0 0 clamp(10px,2.4vw,30px);font-weight:${heavy ? 700 : s.type === "serif" ? 300 : 600};letter-spacing:-0.015em;max-width:24ch}
ul{list-style:none;margin:0;padding:0}
li{position:relative;padding:0 0 clamp(6px,1.2vw,14px) clamp(16px,2vw,26px);font-size:clamp(13px,1.9vw,22px);line-height:1.4;max-width:52ch}
li::before{content:"";position:absolute;left:0;top:0.55em;width:clamp(6px,0.8vw,9px);height:clamp(6px,0.8vw,9px);background:${s.accent};border-radius:${s.mood === "playful" ? "50%" : "1px"}}
.rule{width:clamp(28px,5vw,56px);height:3px;background:${s.accent};margin:0 0 clamp(10px,2vw,22px)}
.title .rule{background:${field ? titleInk : s.accent}}
.split{display:grid;grid-template-columns:1fr;gap:clamp(12px,3vw,40px);align-items:center}
.split img{width:100%;max-height:52vh;object-fit:contain;border-radius:2px}
@media (min-width:640px){.split.has-img{grid-template-columns:1.15fr 1fr}.split img{max-height:none;aspect-ratio:4/3;object-fit:cover}}
.logo{height:clamp(44px,8vw,96px);width:auto;max-width:40%;object-fit:contain;object-position:left center;margin:0 0 clamp(14px,3vw,34px);display:block}
.notes{width:min(100%,1100px);margin:10px auto 0;font-size:clamp(13px,1.6vw,16px);line-height:1.55;opacity:0.85}
.notes summary{cursor:pointer;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.7}
.notes p{margin:8px 0 0;max-width:70ch}
.slide.with-notes{flex-direction:column}
.n{position:absolute;right:clamp(14px,3vw,32px);bottom:clamp(10px,2.4vw,26px);font-size:clamp(10px,1.2vw,13px);letter-spacing:0.12em;opacity:0.55}
.mark{position:absolute;left:clamp(14px,3vw,32px);bottom:clamp(10px,2.4vw,26px);font-size:clamp(10px,1.2vw,13px);letter-spacing:0.12em;opacity:0.55}
@media print{.notes{display:none}.dl{display:none}html{scroll-snap-type:none}.slide{min-height:auto;page-break-after:always;padding:0}.frame{border:none}}
.dl{position:fixed;right:16px;top:12px;font-size:12px;letter-spacing:0.08em;z-index:5}
@media (max-width:640px){.dl{position:static;text-align:right;padding:10px 16px 0}}
.dl a{color:${s.text};opacity:0.7;text-decoration:none;border-bottom:1px solid ${s.accent};margin-left:14px}
${o.print ? `@page{size:13.333in 7.5in;margin:0}html,body{margin:0}.slide{width:13.333in;height:7.5in;min-height:0;padding:0;page-break-after:always;break-after:page}.frame{width:13.333in;height:7.5in;aspect-ratio:auto;border:none;border-radius:0;padding:0.9in}` : ""}
`;
  // An asset is served only under this deck's own link (relative, so it never names another host).
  const img = (id: string, alt: string, cls = "") => {
    const src = o.imageSrc ? o.imageSrc(id) : `${o.assetBase ?? `${page.id}/a/`}${id}`;
    return src ? `<img${cls ? ` class="${cls}"` : ""} src="${e(src)}" alt="${e(alt)}" decoding="async">` : "";
  };
  const slides = d.slides
    .map(
      (sl, i) =>
        `<section class="slide${sl.notes && o.showNotes !== false ? " with-notes" : ""}"><div class="frame"><div class="split${sl.image ? " has-img" : ""}"><div><div class="rule"></div><h2>${e(sl.headline)}</h2><ul>${sl.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul></div>${sl.image ? img(sl.image, sl.headline) : ""}</div><div class="n">${i + 2} / ${d.slides.length + 1}</div></div>${sl.notes && o.showNotes !== false ? `<details class="notes"><summary>Speaker notes</summary><p>${e(sl.notes)}</p></details>` : ""}</section>`,
    )
    .join("\n");
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
<link href="${f.css}" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<main>
${o.downloadBase && !o.print ? `<div class="dl"><a href="${e(`${o.downloadBase}deck.pdf`)}" download>PDF</a><a href="${e(`${o.downloadBase}deck.pptx`)}" download>PowerPoint</a></div>` : ""}
<section class="slide title"><div class="frame">${d.logo ? img(d.logo, `${d.title} logo`, "logo") : `<div class="rule"></div>`}<h1>${e(d.title)}</h1><p class="sub">${e(d.subtitle)}</p><div class="mark">Made by Co · ${e(asOf(page.updatedAt, o.zone ?? null))}</div></div></section>
${slides}
</main>
</body>
</html>`;
}
