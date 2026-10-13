// The one Co page template (Royce, 2026-10-11: "It reads like a document made by someone who knows you"; "No nav, no app chrome, no
// CTAs, no signup anything"). It takes a page that already passed the schema (schema.ts) and puts each field in its own slot,
// escaped. It never reads prose, markdown or HTML from the data, and the model never writes any of it.
//
// Design (Royce's inspiration, 2026-10-11: an editorial travel page): a full-bleed one-color cover band with the title in small,
// widely spaced capitals; warm cream paper; an asymmetric opening (the title in serif on the left, the context in an accent italic on
// the right); tiny capital labels; recommendations as large, light serif names; the itinerary on a dark band, where the inspiration
// runs its dark photographs; and a centered serif sign-off. Built from Co's own brand only (services/emailDesign.ts EMAIL_COLORS,
// the approved Figma email set): Fraunces and Satoshi, ink, maroon, gold, cream. No photographs: the page carries no images. Inline
// CSS, no scripts. The footer ("Made by Co", as of) is how Co travels when the page is shared with non-members.
// Design audit (2026-10-12): without a cover photo the band is a slim strip (with their logo, a short band for it), never an empty
// half screen, and the title is said once, in the opening, its last two words held together.
import { EMAIL_COLORS, escapeHtml } from "../emailDesign.js";
import type { Block, CoPageData, ComparisonOption, LinkItem } from "./schema.js";
import { contrast, inkOn, type DeckStyle } from "./style.js";
import { fontLinks, fontStack } from "../designFonts.js";
import { abstractCover, creditHtml, googlePhotosIn, mapHtml, type ArtImage, type Credit, type Grammar } from "./art.js";

export type CoPageView = { id: string; data: CoPageData; version: number; updatedAt: Date };

const C = EMAIL_COLORS;
const PAPER = "#FBF9F5";
const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "'Satoshi', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
const e = escapeHtml;

// "Oct 11, 2026", in the zone given (the member's), else UTC.
export function asOfLine(d: Date, zone: string | null = null): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone ?? "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  }
}

// The host of a link, for a quiet "where this goes": "lardine.com".
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// The preview line under the title when the link is texted.
export function ogDescription(d: CoPageData): string {
  const firstText = d.sections.flatMap((s) => s.blocks).find((b): b is Extract<Block, { type: "text" }> => b.type === "text")?.text ?? "";
  const lead = `${d.context}`;
  return firstText ? `${lead}. ${firstText}`.slice(0, 200) : lead;
}

const two = (n: number) => String(n).padStart(2, "0");

function renderText(text: string): string {
  return `<p class="t">${e(text)}</p>`;
}

function renderBullets(items: { text: string; lead: string | null }[]): string {
  const anyLead = items.some((i) => i.lead);
  return `<ul class="b${anyLead ? " led" : ""}">${items
    .map((i) => `<li>${anyLead ? `<span class="lead">${e(i.lead ?? "")}</span>` : ""}<span class="bt">${e(i.text)}</span></li>`)
    .join("")}</ul>`;
}

function renderOption(o: ComparisonOption): string {
  const facts = o.facts.map((f) => `<div class="f"><dt>${e(f.label)}</dt><dd>${e(f.value)}</dd></div>`).join("");
  return `<article class="opt"><h4>${e(o.name)}</h4>${facts ? `<dl>${facts}</dl>` : ""}${o.note ? `<p class="on">${e(o.note)}</p>` : ""}${o.url ? `<a class="ol" href="${e(o.url)}" rel="noopener noreferrer">${e(hostOf(o.url))}</a>` : ""}</article>`;
}

function renderComparison(options: ComparisonOption[]): string {
  return `<div class="cmp n${options.length}">${options.map(renderOption).join("")}</div>`;
}

function renderLinks(items: LinkItem[]): string {
  // Grouped in the order the groups first appear; ungrouped items stay where they are, as their own run.
  const runs: { group: string | null; items: LinkItem[] }[] = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    const existing = it.group ? runs.find((r) => r.group === it.group) : null;
    if (existing) existing.items.push(it);
    else if (last && !it.group && !last.group) last.items.push(it);
    else runs.push({ group: it.group, items: [it] });
  }
  return runs
    .map(
      (r) =>
        `<div class="grp">${r.group ? `<div class="gl">${e(r.group)}</div>` : ""}<ul class="lk">${r.items
          .map(
            (i) =>
              `<li>${i.url ? `<a class="ln" href="${e(i.url)}" rel="noopener noreferrer">${e(i.name)}</a>` : `<span class="ln">${e(i.name)}</span>`}${i.note ? `<span class="lnote">${e(i.note)}</span>` : ""}</li>`,
          )
          .join("")}</ul></div>`,
    )
    .join("");
}

function renderBlock(b: Block): string {
  switch (b.type) {
    case "text":
      return renderText(b.text);
    case "bullets":
      return renderBullets(b.items);
    case "comparison":
      return renderComparison(b.options);
    case "links":
      return renderLinks(b.items);
  }
}

const INK_BAND = "#1F1013";
const COVER_TOP = "#9A3A55";
const COVER_BOTTOM = "#6E2438";
const CREAM = C.cream;
// The palette the CSS is written in. Co's own (no taste) is exactly the design above; a member's taste (style.ts DeckStyle) maps
// onto it: their background is the paper, their text the ink, their accent the cover and the small accents, and the dark band is
// their text color with their background on it (contrast already checked by styleFrom).
export type Palette = { paper: string; body: string; ink: string; muted: string; soft: string; line: string; gold: string; maroon: string; band: string; bandText: string; bandSoft: string; bandLine: string; coverTop: string; coverBottom: string; coverText: string; serif: string; sans: string };
// Labels in muted and the section numbers read at 4.5:1 on the cream (design audit: Co's own muted and gold labels sat near 3:1).
const CO_LABELS = `.num{color:${C.maroon}}.band .num{color:#E9E3DA}`;
export const CO_PALETTE: Palette = { paper: CREAM, body: C.body, ink: C.ink, muted: "#6E6159", soft: C.soft, line: C.line, gold: C.gold, maroon: C.maroon, band: INK_BAND, bandText: CREAM, bandSoft: "#E9E3DA", bandLine: "rgba(239,236,230,0.16)", coverTop: COVER_TOP, coverBottom: COVER_BOTTOM, coverText: CREAM, serif: SERIF, sans: SANS };
// Pure: a hex color a share of the way toward another (0 = a, 1 = b).
function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
export function paletteFor(st: DeckStyle | null | undefined): Palette {
  if (!st) return CO_PALETTE;
  // Dark paper (their background darker than their text): the band is their background lifted a little, never an inverted white
  // block; light paper keeps Co's dark band in their text color. The cover is a full accent field only for bold and playful; for the
  // quieter moods it's their background, a shade deeper, with the title in their accent (live run, 2026-10-11: a gold field on a
  // "quiet and premium" page was loud).
  const dark = contrast(st.background, "#000000") < contrast(st.text, "#000000");
  const loud = st.mood === "bold" || st.mood === "playful";
  const coverBg = loud ? st.accent : mix(st.background, dark ? "#000000" : st.text, dark ? 0.25 : 0.06);
  const coverText = loud
    ? contrast(st.background, st.accent) >= 4.5 ? st.background : contrast(st.text, st.accent) >= 4.5 ? st.text : contrast("#FFFFFF", st.accent) >= contrast("#111111", st.accent) ? "#FFFFFF" : "#111111"
    : contrast(st.accent, coverBg) >= 3 ? st.accent : st.text;
  const band = dark ? mix(st.background, st.text, 0.07) : st.text;
  const bandText = dark ? st.text : st.background;
  const sans = st.type === "sans" ? SANS : SERIF;
  // Their design system's tokens (2026-10-12): their fonts (open fonts, by name), and a gradient runs the cover from one end to the
  // other with an ink that reads on both.
  const grad = st.gradient && st.accent2 ? [st.accent, st.accent2] : null;
  return {
    // muted at 75% of their ink: small labels in it read at 4.5:1 (design audit: 60% left them near 2:1).
    paper: st.background, body: st.text, ink: st.text, muted: `${st.text}BF`, soft: `${st.text}BF`, line: `${st.text}26`, gold: st.accent, maroon: st.accent,
    band, bandText, bandSoft: `${bandText}E6`, bandLine: `${bandText}29`,
    coverTop: grad ? grad[0] : coverBg, coverBottom: grad ? grad[1] : coverBg, coverText: grad ? inkOn(grad, [st.text, st.background]) : coverText,
    serif: st.display ? fontStack(st.display) : st.type === "sans" ? SANS : SERIF, sans: st.body ? fontStack(st.body) : sans,
  };
}
// Their accent must read where it's text (review of PR 2: a navy accent on a navy band was 1.6:1): the band's times and dots fall back
// to the band's text color below 3:1, and the title and group labels to their text color below 3:1 on the paper.
function readableAccents(st: DeckStyle): string {
  const p = paletteFor(st);
  const onBand = contrast(st.accent, p.band) >= 3 ? st.accent : p.bandText;
  const onPaper = contrast(st.accent, st.background) >= 3 ? st.accent : st.text;
  // Small labels (section numbers, group labels) at 4.5:1; large type (the title, leads) at 3:1.
  const labBand = contrast(st.accent, p.band) >= 4.5 ? st.accent : p.bandText;
  const labPaper = contrast(st.accent, st.background) >= 4.5 ? st.accent : st.text;
  return `.band .lead{color:${onBand}}.band .b li::before{background:${onBand}}.band .num{color:${labBand}}h1,section:not(.band) .lead,.on{color:${onPaper}}.gl,.num{color:${labPaper}}`;
}
function pageCss(t: Palette): string {
  return `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{margin:0;background:${t.paper};color:${t.body};font-family:${t.sans};font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased}
.cover{min-height:min(58vh,520px);min-height:min(58svh,520px);background:linear-gradient(180deg,${t.coverTop},${t.coverBottom});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;position:relative;text-align:center}
.cover-mark{position:absolute;top:22px;left:22px;font-family:${t.serif};font-size:20px;color:${t.coverText};opacity:0.9}
.cover.slim{min-height:0;height:64px;padding:0}
.cover.logo-only{min-height:220px}
.cover.photo{background-size:cover;background-position:center;min-height:min(72vh,640px);min-height:min(72svh,640px)}
.cover-credit{position:absolute;bottom:14px;right:18px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${t.coverText};opacity:0.75}
.bleed{margin:24px 0 0;padding:0}
.bleed img{display:block;width:100%;height:62vw;max-height:560px;object-fit:cover}
.bleed figcaption{max-width:720px;margin:0 auto;padding:8px 22px 0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${t.muted}}
section.after-img{padding-top:36px}
section.band.after-img{margin-top:0}
.meta{display:flex;justify-content:space-between;padding:12px 22px;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${t.muted}}
main{display:block}
.inner{max-width:720px;margin:0 auto;padding:0 22px}
.open{max-width:720px;margin:0 auto;padding:44px 22px 8px;display:grid;gap:18px}
h1{font-family:${t.serif};font-weight:300;font-size:34px;line-height:1.1;letter-spacing:-0.015em;color:${t.maroon};margin:0;text-wrap:balance}
.ctx{margin:0;font-family:${t.serif};font-style:italic;font-size:19px;line-height:1.35;color:${t.ink}}
section{padding:56px 0}
section.band{background:${t.band};color:${t.bandText};margin:24px 0}
.num{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${t.gold};font-weight:500}
h2{font-family:${t.serif};font-weight:300;font-size:28px;line-height:1.15;color:${t.ink};margin:10px 0 20px;letter-spacing:-0.01em;text-wrap:balance}
.band h2{color:${t.bandText}}
.t{margin:0 0 18px;font-size:16.5px}
.band .t{color:${t.bandSoft}}
.b{list-style:none;margin:0 0 18px;padding:0}
.b li{position:relative;padding:0 0 10px 18px}
.b li::before{content:"";position:absolute;left:2px;top:0.72em;width:5px;height:5px;border-radius:50%;background:${t.gold}}
.b.led li{display:grid;grid-template-columns:80px 1fr;gap:14px;padding:14px 0;border-top:1px solid ${t.bandLine}}
.b.led li:last-child{border-bottom:1px solid ${t.bandLine}}
section:not(.band) .b.led li{border-color:${t.line}}
.b.led li::before{display:none}
.lead{font-family:${t.serif};font-style:italic;font-size:17px;color:${t.gold};line-height:1.45}
section:not(.band) .lead{color:${t.maroon}}
.bt{color:inherit}
.cmp{display:flex;gap:28px;overflow-x:auto;scroll-snap-type:x mandatory;margin:8px -22px 18px 0;padding:2px 22px 10px 0;scrollbar-width:none}
.cmp::-webkit-scrollbar{display:none}
.opt{flex:0 0 78%;scroll-snap-align:start;border-top:1px solid ${t.ink};padding:16px 0 0}
.opt h4{font-family:${t.serif};font-weight:300;font-size:26px;line-height:1.15;color:${t.ink};margin:0 0 14px}
.opt dl{margin:0}
.f{padding:9px 0;border-top:1px solid ${t.line}}
.f dt{font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${t.muted};line-height:1.4}
.f dd{margin:3px 0 0;color:${t.ink};font-size:15px;line-height:1.45}
.on{font-family:${t.serif};font-style:italic;font-size:16px;line-height:1.5;color:${t.maroon};margin:14px 0 0}
.ol{display:inline-block;margin-top:12px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${t.muted};text-decoration:none;border-bottom:1px solid ${t.gold}}
.grp{margin:4px 0 30px}
.gl{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${t.maroon};margin:0 0 8px;font-weight:500}
.lk{list-style:none;margin:0;padding:0}
.lk li{padding:6px 0 12px}
.ln{display:inline;font-family:${t.serif};font-weight:300;font-size:32px;line-height:1.15;color:${t.ink};text-decoration:none;letter-spacing:-0.01em}
a.ln:hover{color:${t.maroon}}
.lnote{display:block;margin-top:4px;font-size:14px;line-height:1.55;color:${t.soft};max-width:440px}
.src{margin-top:16px;padding-top:24px;border-top:1px solid ${t.line}}
.src h3{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${t.muted};font-weight:500;margin:0 0 10px}
.src ol{margin:0;padding:0 0 0 18px;color:${t.muted};font-size:13px;line-height:1.7}
.src a{color:${t.soft};text-decoration:none;border-bottom:1px solid ${t.line}}
.src .h{color:${t.muted}}
footer{margin:72px auto 0;padding:56px 22px 48px;text-align:center;border-top:1px solid ${t.line};max-width:720px}
.sign{font-family:${t.serif};font-weight:300;font-size:26px;line-height:1.25;color:${t.ink}}
.monogram{margin:22px auto 0;font-family:${t.serif};font-size:18px;color:${t.maroon}}
footer .asof{display:block;margin-top:10px;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${t.muted}}
@media (min-width:720px){
  .cover.photo{min-height:min(76vh,720px)}
  .cover.logo-only{min-height:260px}
  .open{grid-template-columns:1fr 1fr;gap:40px;padding-top:64px;align-items:start}
  .ctx{text-align:right}
  h1{font-size:40px}
  .cmp{display:grid;overflow:visible;margin:8px 0 18px;padding:0;gap:32px}
  .cmp.n2{grid-template-columns:repeat(2,1fr)}
  .cmp.n3{grid-template-columns:repeat(3,1fr)}
  .cmp.n4{grid-template-columns:repeat(2,1fr)}
  .opt{flex:none}
  .ln{font-size:38px}
}
`;
}
export const STYLE = pageCss(CO_PALETTE);

// Each grammar's composition on a page (art.ts), over the same palette: pictures, a map, a timeline, and how the page is set.
function artCss(t: Palette, g: Grammar): string {
  const base = `
.cover-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.cover.photo{background:#222}
.cover.photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.12),rgba(0,0,0,0.45))}
.cover .cover-mark,.cover .credit,.cover .cover-logo{position:relative;z-index:1}
.cover .cover-mark{position:absolute}
.cover .credit{position:absolute;right:14px;bottom:12px;left:auto;z-index:2}
.cover.plate-cover{min-height:260px;padding:0}
.cover.plate-cover .tplate{position:absolute;inset:0;width:100%;height:100%}
.cover.plate-cover .credit.design{position:absolute;right:14px;bottom:12px}
.credit{display:inline-block;font-size:11px;line-height:1.4;letter-spacing:0.04em;color:#FFFFFF;background:rgba(0,0,0,0.66);padding:3px 8px;border-radius:3px;max-width:calc(100% - 28px)}
.credit a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.art{margin:24px 0 0;position:relative}
.art img{display:block;width:100%;height:62vw;max-height:560px;object-fit:cover}
.art .credit{position:absolute;left:12px;bottom:12px}
.strip{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:20px 0 6px}
.strip figure{margin:0;position:relative;aspect-ratio:4/3;overflow:hidden;background:${t.line}}
.strip img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.strip .credit{position:absolute;left:6px;bottom:6px;right:6px}
.map{position:relative;margin:28px auto 0;max-width:960px;aspect-ratio:16/10;overflow:hidden;background:#E8E4DC}
.mapc{position:absolute;inset:0}
.map .tile{position:absolute;display:block;max-width:none}
.map .pin{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:4px}
.map .pin b{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${t.maroon};color:#FFFFFF;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.3)}
.map .pin b{font-family:${t.sans}}
.map .pin.below .pl{order:1}
.map .pl{order:-1;background:#FFFFFF;color:#111111;font-size:12px;padding:2px 7px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 5px rgba(0,0,0,0.2)}
.osm{position:absolute;right:0;bottom:0;font-size:11px;background:rgba(255,255,255,0.9);color:#222222;padding:2px 7px;margin:0;letter-spacing:0;text-transform:none}
.osm a{color:inherit;text-decoration:none}
.mapsec{padding:8px 0 24px}
.tl{list-style:none;margin:8px 0 18px;padding:0 0 0 22px;position:relative}
.tl::before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;background:${t.line}}
.band .tl::before{background:${t.bandLine}}
.tl li{position:relative;padding:0 0 18px}
.tl li::before{content:"";position:absolute;left:-22px;top:6px;width:12px;height:12px;border-radius:50%;background:${t.maroon}}
.tl .when{display:block;font-family:${t.serif};font-style:italic;font-size:18px;line-height:1.3;color:${t.maroon}}
.band .tl .when{color:inherit}
`;
  const per: Record<Grammar, string> = {
    editorial: "",
    catalog: `
h1{font-size:40px;max-width:16ch}
.plate{margin:24px 0 0}
.plate figure{margin:0;position:relative}
.plate img{display:block;width:100%;aspect-ratio:4/5;object-fit:cover;max-height:620px}
.plate .cap{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:10px 0 0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${t.muted}}
.plate .credit{position:absolute;left:10px;bottom:10px;text-transform:none;letter-spacing:0.02em}
.plab{color:${t.maroon};font-weight:500}
h2{font-size:32px}
@media (min-width:720px){
  .open{grid-template-columns:2fr 1fr}
  h1{font-size:58px}
  .spread{display:grid;grid-template-columns:1.15fr 1fr;gap:48px;align-items:start;max-width:1100px;margin:0 auto;padding:0 22px}
  .spread.flip{grid-template-columns:1fr 1.15fr}
  .spread.flip .plate{order:2}
  .spread .inner{padding:0}
  .spread .plate{margin-top:56px}
}`,
    fieldguide: `
.coords{font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${t.muted};margin:0}
h2{font-size:26px}
.num::after{content:" · field note"}
@media (min-width:720px){h1{font-size:44px}}`,
    menu: `
.open{grid-template-columns:1fr!important;text-align:center;justify-items:center}
.ctx{text-align:center!important}
h1{font-size:40px;max-width:18ch;margin:0 auto}
section .inner{text-align:center}
.num{display:block}
h2{font-size:24px;letter-spacing:0.02em}
h2::after{content:"";display:block;width:56px;margin:18px auto 0;border-top:1px solid ${t.maroon}}
.b li{padding-left:0}.b li::before{display:none}
.b.led li{grid-template-columns:1fr;gap:2px;text-align:center}
.lk li{text-align:center;border-bottom:1px dotted ${t.line};padding:14px 0}
.ln{font-size:26px}
.lnote{margin:6px auto 0;font-style:italic}
.cmp{justify-content:center}
.tl{display:inline-block;text-align:left}
@media (min-width:720px){h1{font-size:52px}.inner{max-width:600px}.ln{font-size:30px}}`,
    poster: `
h1{font-size:56px;line-height:0.98;letter-spacing:-0.03em;font-weight:400}
h2{font-size:40px;line-height:1.02;letter-spacing:-0.02em}
.open{grid-template-columns:1fr!important}
.ctx{text-align:left!important}
@media (min-width:720px){h1{font-size:104px;max-width:12ch}h2{font-size:56px}}`,
  };
  return base + per[g];
}

// assetBase: where this view serves the member's own images (their logo, a section's picture), relative to the page's address, as
// for a deck ("<id>/a/" for their link, "<share id>/a/" for a share link).
// Pure: the last two words of a headline kept together (escaped text in, escaped text out), so it never ends on one word alone.
const keepLastTwo = (escaped: string) => escaped.replace(/\s+(\S+)\s*$/, "&nbsp;$1");

// imageSrc: where an image's bytes come from instead of its address (design QA inlines them, so it measures the real pictures).
export function renderCoPage(page: CoPageView, o: { url: string | null; ogImageUrl: string | null; zone?: string | null; assetBase?: string; imageSrc?: (ref: { asset?: string; url?: string }) => string | null; artSrc?: (ref: string) => string | null; credit?: (p: ArtImage) => Credit | null }): string {
  const d = page.data;
  const grammar: Grammar = d.style?.grammar ?? d.grammar ?? "editorial";
  const desc = ogDescription(d);
  const og = [
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${e(d.title)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    `<meta property="og:site_name" content="Co">`,
    o.url ? `<meta property="og:url" content="${e(o.url)}">` : "",
    o.ogImageUrl ? `<meta property="og:image" content="${e(o.ogImageUrl)}">` : "",
    `<meta name="twitter:card" content="${o.ogImageUrl ? "summary" : "summary"}">`,
    `<meta name="twitter:title" content="${e(d.title)}">`,
    `<meta name="twitter:description" content="${e(desc)}">`,
  ]
    .filter(Boolean)
    .join("\n");
  // A section that leads with a timed run (an itinerary, a week) sits on the dark band, the way the inspiration's dark images break up
  // the page. Decided from the data's shape, never asked of the model.
  const dark = (sec: CoPageData["sections"][number]) => sec.blocks.some((b) => b.type === "bullets" && b.items.some((x) => x.lead));
  const base = o.assetBase ?? `${page.id}/a/`;
  const assetSrc = (id: string) => o.imageSrc?.({ asset: id }) ?? `${base}${id}`;
  const urlSrc = (u: string) => o.imageSrc?.({ url: u }) ?? u;
  // Eager when inlined for the check (lazy images below the fold never load in a screenshot).
  const loading = o.imageSrc ? "eager" : "lazy";
  // Pictures Co found (art.ts): a venue's photo through this page's own link (the key stays on the server), a mood image from
  // Unsplash's own URL; map tiles through the same link. artSrc: inlined instead (design QA).
  const artBase = base.replace(/a\/$/, "");
  const gIndex = new Map(googlePhotosIn(d).map((p, k) => [p.src, k]));
  const artUrl = (p: ArtImage): string | null => (o.artSrc ? o.artSrc(p.via === "google" ? `g:${p.src}` : `u:${p.src}`) : p.via === "google" ? (gIndex.has(p.src) ? `${artBase}g/${gIndex.get(p.src)}` : null) : p.src);
  const tileSrc = (key: string) => (o.artSrc ? o.artSrc(`t:${key}`) : `${artBase}t/${key}.png`);
  const shows = (p: ArtImage) => p.kind === "mood" || !!o.credit?.(p);
  const artImg = (p: ArtImage) => {
    const u = artUrl(p);
    // A venue photo shows only with its author's credit, fetched for this view (Google's terms).
    const c = p.kind === "venue" ? o.credit?.(p) ?? null : null;
    if (p.kind === "venue" && !c) return "";
    return u ? `<img src="${e(u)}" alt="${e(p.alt)}" loading="${loading}" decoding="async" data-qa-crop="ok">${creditHtml(p, e, "credit", c)}` : "";
  };
  const pal = d.style ? paletteFor(d.style) : CO_PALETTE;
  const mapFig = d.map ? mapHtml(d.map, e, tileSrc) : "";
  const mapAfter = d.map ? (grammar === "fieldguide" ? -1 : Math.max(0, d.sections.findIndex((x) => x.place))) : -2;
  // A timed run as a field guide's timeline; elsewhere the dark band, as before.
  const blockHtml = (b: CoPageData["sections"][number]["blocks"][number]) =>
    grammar === "fieldguide" && b.type === "bullets" && b.items.some((x) => x.lead)
      ? `<ol class="tl">${b.items.map((x) => `<li><span class="when">${e(x.lead ?? "")}</span><span class="bt">${e(x.text)}</span></li>`).join("")}</ol>`
      : renderBlock(b);
  const pictureOf = (s: CoPageData["sections"][number], i: number): string => {
    const photos = (s.photos ?? []).filter(shows);
    if (grammar === "fieldguide" && photos.length >= 2) return "";
    if (s.asset) return `<figure class="bleed"><img src="${e(assetSrc(s.asset))}" alt="${e(s.heading)}" loading="${loading}" decoding="async"></figure>`;
    if (s.image) return `<figure class="bleed"><img src="${e(urlSrc(s.image.url))}" alt="${e(s.image.alt)}" loading="${loading}" decoding="async"><figcaption>From ${e(hostOf(s.image.sourceUrl))}</figcaption></figure>`;
    if (photos[0] && grammar !== "catalog") return `<figure class="art">${artImg(photos[0])}</figure>`;
    return "";
  };
  const sections = d.sections
    .map((s, i) => {
      const photos = (s.photos ?? []).filter(shows);
      const strip = grammar === "fieldguide" && photos.length >= 2 ? `<div class="strip">${photos.slice(0, 3).map((p) => `<figure>${artImg(p)}</figure>`).join("")}</div>` : "";
      const coords = grammar === "fieldguide" && s.place && d.map ? (() => {
        const pin = d.map!.pins.find((p) => s.photos?.[0]?.place === p.label) ?? null;
        return pin ? `<p class="coords">${Math.abs(pin.lat).toFixed(3)}° ${pin.lat >= 0 ? "N" : "S"}, ${Math.abs(pin.lng).toFixed(3)}° ${pin.lng >= 0 ? "E" : "W"}</p>` : "";
      })() : "";
      const pic = pictureOf(s, i);
      const body = `<div class="num">${two(i + 1)}</div>${coords}<h2>${keepLastTwo(e(s.heading))}</h2>${strip}${s.blocks.map(blockHtml).join("")}`;
      const band = dark(s) && grammar !== "fieldguide" && grammar !== "menu";
      let html: string;
      if (grammar === "catalog" && (photos[0] || s.asset)) {
        // A gallery catalog: an asymmetric spread, the picture as a numbered plate with its caption, sides trading each time.
        const plateImg = s.asset ? `<img src="${e(assetSrc(s.asset))}" alt="${e(s.heading)}" loading="${loading}" decoding="async">` : artImg(photos[0]);
        html = `<section class="${band ? "band" : ""}"><div class="spread${i % 2 ? " flip" : ""}"><div class="plate"><figure>${plateImg}</figure><div class="cap"><span class="plab">Plate ${two(i + 1)}</span><span>${e(s.heading)}</span></div></div><div class="inner">${body}</div></div></section>`;
      } else html = `${pic}<section class="${band ? "band" : ""}${pic ? " after-img" : ""}"><div class="inner">${body}</div></section>`;
      return html + (i === mapAfter ? `<div class="inner mapsec">${mapFig}</div>` : "");
    })
    .join("");
  const mapTop = mapAfter === -1 ? `<div class="inner mapsec">${mapFig}</div>` : "";
  // The cover: their own picture, the venue's own site image, or a picture Co found, as a real image with its credit; with nothing to
  // show at all (no picture, map or logo anywhere), a typographic plate, said as one.
  const coverSrc = d.coverImage ? { src: assetSrc(d.coverImage), alt: d.title, credit: "" } : d.cover ? { src: urlSrc(d.cover.url), alt: d.cover.alt, credit: `<div class="cover-credit">From ${e(hostOf(d.cover.sourceUrl))}</div>` } : d.coverArt && shows(d.coverArt) && artUrl(d.coverArt) ? { src: artUrl(d.coverArt)!, alt: d.coverArt.alt, credit: creditHtml(d.coverArt, e, "credit", d.coverArt.kind === "venue" ? o.credit?.(d.coverArt) ?? null : null) } : null;
  // Co's designed cover only on a page made with it (coverDesign), never added to an older one.
  const nothing = !coverSrc && !!d.coverDesign;
  const coverHtml = coverSrc
    ? `<div class="cover photo"><img class="cover-img" src="${e(coverSrc.src)}" alt="${e(coverSrc.alt)}" decoding="async" data-qa-crop="ok"><div class="cover-mark">Co.</div>${d.logo ? `<img class="cover-logo" src="${e(assetSrc(d.logo))}" alt="${e(d.title)}" decoding="async">` : ""}${coverSrc.credit}</div>`
    : nothing
      ? `<div class="cover plate-cover">${abstractCover(d.title, { ground: pal.coverTop, ink: pal.coverText, accent: pal.maroon === pal.coverTop ? pal.coverText : pal.maroon, accent2: pal.gold }, e)}</div>`
      : `<div class="cover${d.logo ? " logo-only" : " slim"}"><div class="cover-mark">Co.</div>${d.logo ? `<img class="cover-logo" src="${e(assetSrc(d.logo))}" alt="${e(d.title)}" decoding="async">` : ""}</div>`;
  const sources = d.sources.length
    ? `<div class="src"><h3>Sources</h3><ol>${d.sources.map((s) => `<li><a href="${e(s.url)}" rel="noopener noreferrer">${e(s.label)}</a> <span class="h">${e(hostOf(s.url))}</span></li>`).join("")}</ol></div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${e(d.title)}</title>
<meta name="description" content="${e(desc)}">
${og}
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,400&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500&display=swap" rel="stylesheet">${d.style ? fontLinks([d.style.display, d.style.body].filter((f): f is NonNullable<typeof f> => !!f)).map((h) => `\n<link href="${e(h)}" rel="stylesheet">`).join("") : ""}
<style>${d.style ? pageCss(paletteFor(d.style)) + readableAccents(d.style) : STYLE + CO_LABELS}${artCss(pal, grammar)}${d.logo ? ".cover-logo{display:block;height:64px;width:auto;max-width:50%;object-fit:contain;margin:0 auto 18px}" : ""}</style>
</head>
<body class="g-${grammar}">
${coverHtml}
<main>
<header class="open"><h1>${keepLastTwo(e(d.title))}</h1><p class="ctx">${e(d.context)}</p></header>
${mapTop}${sections}
<div class="inner">${sources}</div>
<footer><div class="sign">Made by Co</div><span class="asof">As of ${e(asOfLine(page.updatedAt, o.zone ?? null))}</span></footer>
</main>
</body>
</html>`;
}

export function notFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Not found</title><style>body{margin:0;background:${PAPER};font-family:${SANS};color:${C.muted};display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}p{margin:0;font-size:15px}</style></head><body><p>This page isn't here.</p></body></html>`;
}
