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

export const DECK_MOODS = ["minimal", "bold", "warm", "dark", "playful", "editorial", "classic"] as const;
export type DeckMood = (typeof DECK_MOODS)[number];
export type DeckStyle = { mood: DeckMood; background: string; text: string; accent: string; type: "serif" | "sans" };
// image / logo: a member asset's id (services/memberAssets.ts), one of the owner's own images; never a URL. The store checks the
// owner, and the image is served only through this deck's own link (routes/coPage.ts).
export type Slide = { headline: string; bullets: string[]; image: string | null };
export type DeckData = { kind: "deck"; title: string; subtitle: string; logo: string | null; slides: Slide[]; style: DeckStyle };
const ASSET = /^[A-Za-z0-9_-]{24}$/;

export const DECK_LIMITS = { title: 90, subtitle: 140, slidesMin: 2, slides: 15, headline: 90, bulletsMin: 1, bullets: 5, bullet: 160 } as const;

// Each mood's own pairing: the default when they named no colors, and the fallback when theirs wouldn't read. "minimal" is the
// default when they don't care (Royce: "If they don't care, default to clean and minimal").
export const MOOD_STYLES: Record<DeckMood, Omit<DeckStyle, "mood">> = {
  minimal: { background: "#FAFAF8", text: "#141414", accent: "#7A7A7A", type: "sans" },
  bold: { background: "#111111", text: "#FFFFFF", accent: "#FF4F1F", type: "sans" },
  warm: { background: "#F6EFE6", text: "#2B1D14", accent: "#B5652E", type: "serif" },
  dark: { background: "#121417", text: "#ECEDEE", accent: "#7FA7D9", type: "sans" },
  playful: { background: "#FFF6E9", text: "#1E1B4B", accent: "#E8487D", type: "sans" },
  editorial: { background: "#FBF9F5", text: "#1A1A1A", accent: "#9A3A55", type: "serif" },
  classic: { background: "#FFFFFF", text: "#0B2545", accent: "#9C7A45", type: "serif" },
};

const HEX = /^#[0-9a-f]{6}$/i;
// WCAG contrast ratio of two hex colors.
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Pure: a style from a mood and the colors they named (any may be missing or bad). Body text must read on the background (4.5:1);
// the accent only needs to be seen (2:1 against the background, else the mood's accent).
export function styleFrom(mood: unknown, colors: { background?: unknown; text?: unknown; accent?: unknown } = {}, type?: unknown): DeckStyle {
  const m: DeckMood = DECK_MOODS.includes(mood as DeckMood) ? (mood as DeckMood) : "minimal";
  const base = MOOD_STYLES[m];
  const pick = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toUpperCase() : d);
  const background = pick(colors.background, base.background);
  let text = pick(colors.text, base.text);
  if (contrast(text, background) < 4.5) text = contrast(base.text, background) >= 4.5 ? base.text : contrast("#111111", background) >= contrast("#FFFFFF", background) ? "#111111" : "#FFFFFF";
  let accent = pick(colors.accent, base.accent);
  if (contrast(accent, background) < 2) accent = text;
  return { mood: m, background, text, accent, type: type === "serif" || type === "sans" ? type : base.type };
}

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
      const r = obj(s, f, ["headline", "bullets", "image"], problems);
      if (!r) return null;
      const headline = plain(r.headline, `${f}.headline`, L.headline, problems, true);
      const bullets = list(r.bullets, `${f}.bullets`, L.bullets, problems, L.bulletsMin)
        .map((b, j) => plain(b, `${f}.bullets[${j}]`, L.bullet, problems, true))
        .filter((x): x is string => !!x);
      const image = asset(r.image, `${f}.image`);
      return headline && bullets.length ? { headline, bullets, image } : null;
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
export function renderDeck(page: { id: string; data: DeckData; updatedAt: Date }, o: { url: string | null; zone?: string | null; assetBase?: string }): string {
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
.n{position:absolute;right:clamp(14px,3vw,32px);bottom:clamp(10px,2.4vw,26px);font-size:clamp(10px,1.2vw,13px);letter-spacing:0.12em;opacity:0.55}
.mark{position:absolute;left:clamp(14px,3vw,32px);bottom:clamp(10px,2.4vw,26px);font-size:clamp(10px,1.2vw,13px);letter-spacing:0.12em;opacity:0.55}
@media print{html{scroll-snap-type:none}.slide{min-height:auto;page-break-after:always;padding:0}.frame{border:none}}
`;
  // An asset is served only under this deck's own link (relative, so it never names another host).
  const img = (id: string, alt: string, cls = "") => `<img${cls ? ` class="${cls}"` : ""} src="${e(`${o.assetBase ?? `${page.id}/a/`}${id}`)}" alt="${e(alt)}" decoding="async">`;
  const slides = d.slides
    .map(
      (sl, i) =>
        `<section class="slide"><div class="frame"><div class="split${sl.image ? " has-img" : ""}"><div><div class="rule"></div><h2>${e(sl.headline)}</h2><ul>${sl.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul></div>${sl.image ? img(sl.image, sl.headline) : ""}</div><div class="n">${i + 2} / ${d.slides.length + 1}</div></div></section>`,
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
<section class="slide title"><div class="frame">${d.logo ? img(d.logo, `${d.title} logo`, "logo") : `<div class="rule"></div>`}<h1>${e(d.title)}</h1><p class="sub">${e(d.subtitle)}</p><div class="mark">Made by Co · ${e(asOf(page.updatedAt, o.zone ?? null))}</div></div></section>
${slides}
</main>
</body>
</html>`;
}
