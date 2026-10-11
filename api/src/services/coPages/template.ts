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
import { EMAIL_COLORS, escapeHtml } from "../emailDesign.js";
import type { Block, CoPageData, ComparisonOption, LinkItem } from "./schema.js";

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
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{margin:0;background:${CREAM};color:${C.body};font-family:${SANS};font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased}
.cover{min-height:min(58vh,520px);min-height:min(58svh,520px);background:linear-gradient(180deg,${COVER_TOP},${COVER_BOTTOM});display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;position:relative;text-align:center}
.cover-mark{position:absolute;top:22px;left:22px;font-family:${SERIF};font-size:20px;color:${CREAM};opacity:0.9}
.cover-title{font-size:13px;letter-spacing:0.38em;text-transform:uppercase;color:${CREAM};line-height:1.9;max-width:320px;font-weight:500}
.cover.photo{background-size:cover;background-position:center;min-height:min(72vh,640px);min-height:min(72svh,640px)}
.cover-credit{position:absolute;bottom:14px;right:18px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${CREAM};opacity:0.75}
.bleed{margin:24px 0 0;padding:0}
.bleed img{display:block;width:100%;height:62vw;max-height:560px;object-fit:cover}
.bleed figcaption{max-width:720px;margin:0 auto;padding:8px 22px 0;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${C.muted}}
section.after-img{padding-top:36px}
section.band.after-img{margin-top:0}
.meta{display:flex;justify-content:space-between;padding:12px 22px;font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:${C.muted}}
main{display:block}
.inner{max-width:720px;margin:0 auto;padding:0 22px}
.open{max-width:720px;margin:0 auto;padding:44px 22px 8px;display:grid;gap:18px}
h1{font-family:${SERIF};font-weight:300;font-size:34px;line-height:1.1;letter-spacing:-0.015em;color:${C.maroon};margin:0}
.ctx{margin:0;font-family:${SERIF};font-style:italic;font-size:19px;line-height:1.35;color:${C.ink}}
section{padding:56px 0}
section.band{background:${INK_BAND};color:${CREAM};margin:24px 0}
.num{font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;color:${C.gold};font-weight:500}
h2{font-family:${SERIF};font-weight:300;font-size:28px;line-height:1.15;color:${C.ink};margin:10px 0 20px;letter-spacing:-0.01em}
.band h2{color:${CREAM}}
.t{margin:0 0 18px;font-size:16.5px}
.band .t{color:#E9E3DA}
.b{list-style:none;margin:0 0 18px;padding:0}
.b li{position:relative;padding:0 0 10px 18px}
.b li::before{content:"";position:absolute;left:2px;top:0.72em;width:5px;height:5px;border-radius:50%;background:${C.gold}}
.b.led li{display:grid;grid-template-columns:80px 1fr;gap:14px;padding:14px 0;border-top:1px solid rgba(239,236,230,0.16)}
.b.led li:last-child{border-bottom:1px solid rgba(239,236,230,0.16)}
section:not(.band) .b.led li{border-color:${C.line}}
.b.led li::before{display:none}
.lead{font-family:${SERIF};font-style:italic;font-size:17px;color:${C.gold};line-height:1.45}
section:not(.band) .lead{color:${C.maroon}}
.bt{color:inherit}
.cmp{display:flex;gap:28px;overflow-x:auto;scroll-snap-type:x mandatory;margin:8px -22px 18px 0;padding:2px 22px 10px 0;scrollbar-width:none}
.cmp::-webkit-scrollbar{display:none}
.opt{flex:0 0 78%;scroll-snap-align:start;border-top:1px solid ${C.ink};padding:16px 0 0}
.opt h4{font-family:${SERIF};font-weight:300;font-size:26px;line-height:1.15;color:${C.ink};margin:0 0 14px}
.opt dl{margin:0}
.f{padding:9px 0;border-top:1px solid ${C.line}}
.f dt{font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:${C.muted};line-height:1.4}
.f dd{margin:3px 0 0;color:${C.ink};font-size:15px;line-height:1.45}
.on{font-family:${SERIF};font-style:italic;font-size:16px;line-height:1.5;color:${C.maroon};margin:14px 0 0}
.ol{display:inline-block;margin-top:12px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${C.muted};text-decoration:none;border-bottom:1px solid ${C.gold}}
.grp{margin:4px 0 30px}
.gl{font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;color:${C.maroon};margin:0 0 8px;font-weight:500}
.lk{list-style:none;margin:0;padding:0}
.lk li{padding:6px 0 12px}
.ln{display:inline;font-family:${SERIF};font-weight:300;font-size:32px;line-height:1.15;color:${C.ink};text-decoration:none;letter-spacing:-0.01em}
a.ln:hover{color:${C.maroon}}
.lnote{display:block;margin-top:4px;font-size:14px;line-height:1.55;color:${C.soft};max-width:440px}
.src{margin-top:16px;padding-top:24px;border-top:1px solid ${C.line}}
.src h3{font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;color:${C.muted};font-weight:500;margin:0 0 10px}
.src ol{margin:0;padding:0 0 0 18px;color:${C.muted};font-size:13px;line-height:1.7}
.src a{color:${C.soft};text-decoration:none;border-bottom:1px solid ${C.line}}
.src .h{color:${C.muted}}
footer{margin:72px auto 0;padding:56px 22px 48px;text-align:center;border-top:1px solid ${C.line};max-width:720px}
.sign{font-family:${SERIF};font-weight:300;font-size:26px;line-height:1.25;color:${C.ink}}
.monogram{margin:22px auto 0;font-family:${SERIF};font-size:18px;color:${C.maroon}}
footer .asof{display:block;margin-top:10px;font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:${C.muted}}
@media (min-width:720px){
  .cover{min-height:min(64vh,620px)}
  .cover.photo{min-height:min(76vh,720px)}
  .cover-title{font-size:14px}
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

export function renderCoPage(page: CoPageView, o: { url: string | null; ogImageUrl: string | null; zone?: string | null }): string {
  const d = page.data;
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
  const sections = d.sections
    .map((s, i) => `${s.image ? `<figure class="bleed"><img src="${e(s.image.url)}" alt="${e(s.image.alt)}" loading="lazy" decoding="async"><figcaption>From ${e(hostOf(s.image.sourceUrl))}</figcaption></figure>` : ""}<section class="${dark(s) ? "band" : ""}${s.image ? " after-img" : ""}"><div class="inner"><div class="num">${two(i + 1)}</div><h2>${e(s.heading)}</h2>${s.blocks.map(renderBlock).join("")}</div></section>`)
    .join("");
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
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<div class="cover${d.cover ? " photo" : ""}"${d.cover ? ` style="background-image:linear-gradient(180deg,rgba(38,19,24,0.25),rgba(38,19,24,0.55)),url('${e(d.cover.url)}')" role="img" aria-label="${e(d.cover.alt)}"` : ""}><div class="cover-mark">Co.</div><div class="cover-title">${e(d.title)}</div>${d.cover ? `<div class="cover-credit">From ${e(hostOf(d.cover.sourceUrl))}</div>` : ""}</div>
<main>
<header class="open"><h1>${e(d.title)}</h1><p class="ctx">${e(d.context)}</p></header>
${sections}
<div class="inner">${sources}</div>
<footer><div class="sign">Made by Co</div><span class="asof">As of ${e(asOfLine(page.updatedAt, o.zone ?? null))}</span></footer>
</main>
</body>
</html>`;
}

export function notFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Not found</title><style>body{margin:0;background:${PAPER};font-family:${SANS};color:${C.muted};display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}p{margin:0;font-size:15px}</style></head><body><p>This page isn't here.</p></body></html>`;
}
