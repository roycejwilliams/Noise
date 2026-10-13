// Branded link previews (founder brief, 2026-10-12): a shared artifact link unfurls into a rich card in iMessage and Slack. Each
// artifact gets its own 1200x630 Open Graph image in the member's own look (their palette, fonts and gradient, or Co's own when they
// have none) with the title, the member's name and the Made by Co mark, and the route serves the tags crawlers read in the first
// HTML (no scripts write the head).
//
// Privacy:
//   - The image lives under the link it was opened with (/d/<id>/og/<tag>.png, /d/v/<share>/og/<tag>.png), so it is exactly as
//     guessable as the link itself (144 random bits), and a reset, revoked, expired or taken-down link takes its image with it: the
//     image route loads the artifact through the same loader as the page, and nothing found is a plain 404.
//   - The description never carries the artifact's content beyond its title: only its kind and size ("A 6-slide deck made by Co.").
//   - The name on the card is the owner's first name and last initial ("Jordan K."), from their own row, never anyone else's. A
//     member Co hasn't got a name for yet gets no name line.
//   - The 404 page carries one generic card for every missing link: no title, no name, no image.
//   - Crawlers keep their own copy of a preview; one fetched before a link was revoked can stay in Slack's or iMessage's cache.
//
// The image is rendered once per artifact version and look (headless Chrome, browserRead.ts renderPng) and held in memory. The tag
// in its address is a hash of the id, version, title and look, so an update gives it a new address: a stale title is never served.
import { createHash } from "crypto";
import pool from "../../db/db.js";
import { EMAIL_COLORS, escapeHtml } from "../emailDesign.js";
import { DEFAULT_FONTS, fontLinks, fontStack, type FontChoice } from "../designFonts.js";
import { contrast, inkOn, type DeckStyle } from "./style.js";
import { isDeckData, type DeckData } from "./deck.js";
import type { CoPageData } from "./schema.js";
import type { StoredCoPage } from "./store.js";

export const OG_SIZE = { width: 1200, height: 630 } as const;
const e = escapeHtml;
const C = EMAIL_COLORS;
const SATOSHI: FontChoice = { family: "Satoshi", source: "fontshare", kind: "sans" };
const FRAUNCES: FontChoice = { family: "Fraunces", source: "google", kind: "serif" };

// ---------------------------------------------------------------- what the card says

// Pure: the name on the card. First name and last initial ("Jordan K."), letters only, from the owner's own row; null when Co hasn't
// got their name yet (a placeholder row has an empty first name).
export function previewName(row: { first_name?: unknown; last_name?: unknown; identity_captured?: unknown } | null | undefined): string | null {
  if (!row || row.identity_captured === false) return null;
  const clean = (v: unknown) => String(v ?? "").normalize("NFC").replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim();
  const first = clean(row.first_name).split(" ")[0]?.slice(0, 24) ?? "";
  if (!first) return null;
  const last = clean(row.last_name);
  const initial = last ? Array.from(last.replace(/^[' -]+/, ""))[0] : "";
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

export async function ownerPreviewName(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT first_name, last_name, identity_captured FROM users WHERE id = $1`, [userId]);
  return previewName(rows[0]);
}

// Pure: the one-liner under the title. Never the artifact's own words beyond the title (a page's context line or a deck's subtitle
// can name people, places and dates), only what it is.
export function previewDescription(data: StoredCoPage["data"]): string {
  if (isDeckData(data)) {
    const n = (data as DeckData).slides.length + 1;
    return `A ${n}-slide deck made by Co.`;
  }
  return "A page made by Co.";
}

const styleOf = (data: StoredCoPage["data"]): DeckStyle | null => (isDeckData(data) ? (data as DeckData).style : ((data as CoPageData).style ?? null));
const titleOf = (data: StoredCoPage["data"]): string => String((data as { title?: string }).title ?? "");

// Pure: the image's tag: the artifact, its version, its title and its look. Any change gives a new address.
export function previewTag(page: Pick<StoredCoPage, "id" | "version" | "data">): string {
  const st = styleOf(page.data);
  return createHash("sha256")
    .update(JSON.stringify([page.id, page.version, titleOf(page.data), isDeckData(page.data) ? "deck" : "page", st ?? null]))
    .digest("base64url")
    .slice(0, 16);
}
// The link-preview fetchers: iMessage (it sends "facebookexternalhit ... Facebot Twitterbot"), Slack, Discord, WhatsApp, LinkedIn.
export const PREVIEW_CRAWLER = /facebookexternalhit|Facebot|Twitterbot|Slackbot|Slack-ImgProxy|Discordbot|WhatsApp|LinkedInBot|TelegramBot|Applebot/i;
export const PREVIEW_TAG = /^[A-Za-z0-9_-]{16}$/;

// ---------------------------------------------------------------- the card

// Pure: the ground, ink and accent the card is drawn in. Their gradient when their look runs one, else their paper and ink with
// their accent as a bar; Co's own cream, ink and maroon when they have no look.
export function cardColors(st: DeckStyle | null): { ground: string; ink: string; accent: string; label: string; soft: string } {
  if (!st) return { ground: "#FBF9F5", ink: C.ink, accent: C.maroon, label: C.maroon, soft: C.muted };
  if (st.gradient && st.accent2) {
    const ink = inkOn([st.accent, st.accent2], [st.text, st.background]);
    return { ground: `linear-gradient(135deg, ${st.accent} 0%, ${st.accent2} 100%)`, ink, accent: ink, label: ink, soft: ink };
  }
  const label = contrast(st.accent, st.background) >= 3 ? st.accent : st.text;
  return { ground: st.background, ink: st.text, accent: st.accent, label, soft: st.text };
}

// Pure: the display size a title gets, so it fits three lines at most (no scripts run in the render to measure it).
export function titleSize(title: string): number {
  const n = title.length;
  return n <= 22 ? 96 : n <= 40 ? 80 : n <= 60 ? 66 : 56;
}

// Pure: the card's HTML, 1200x630. Every value escaped; colors and fonts come only from a style that passed style.ts.
export function previewCardHtml(o: { title: string; kind: "page" | "deck"; name: string | null; style: DeckStyle | null }): string {
  const st = o.style;
  const display = st?.display ?? (st ? DEFAULT_FONTS[st.type] : FRAUNCES);
  const body = st?.body ?? (st ? (st.display ?? DEFAULT_FONTS[st.type]) : SATOSHI);
  const k = cardColors(st);
  const gradient = !!(st?.gradient && st.accent2);
  const links = fontLinks([display, body, FRAUNCES]);
  const size = titleSize(o.title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${links.map((h) => `<link href="${e(h)}" rel="stylesheet">`).join("")}<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${OG_SIZE.width}px;height:${OG_SIZE.height}px;overflow:hidden}
body{background:${k.ground};color:${k.ink};font-family:${fontStack(body)};-webkit-font-smoothing:antialiased}
.card{position:relative;width:100%;height:100%;padding:72px 88px 64px ${gradient ? 88 : 104}px;display:flex;flex-direction:column}
.bar{position:absolute;left:0;top:0;bottom:0;width:20px;background:${k.accent}}
.kind{font-size:20px;letter-spacing:.24em;text-transform:uppercase;color:${k.label};font-weight:500}
h1{margin-top:auto;font-family:${fontStack(display)};font-weight:400;font-size:${size}px;line-height:1.06;letter-spacing:-.01em;max-width:1000px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.foot{margin-top:48px;display:flex;align-items:center;justify-content:space-between;font-size:26px}
.who{font-weight:500}
.made{display:flex;align-items:center;gap:14px;font-size:22px;letter-spacing:.04em;color:${k.soft}}
.mark{width:52px;height:52px;border-radius:50%;border:2px solid ${k.ink};display:flex;align-items:center;justify-content:center;font-family:'Fraunces',Georgia,serif;font-size:24px;color:${k.ink}}
</style></head><body><div class="card">${gradient ? "" : `<div class="bar"></div>`}<div class="kind">${o.kind === "deck" ? "A deck" : "A page"}</div><h1>${e(o.title)}</h1><div class="foot"><span class="who">${o.name ? e(o.name) : ""}</span><span class="made"><span class="mark">Co</span>Made by Co</span></div></div></body></html>`;
}

// The app icon: Co's mark, for the favicon and apple-touch-icon.
export const CO_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="${C.ink}"/><text x="90" y="116" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="80" fill="#FBF9F5">Co</text></svg>`;
export function coMarkHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400&display=swap" rel="stylesheet"><style>*{margin:0}html,body{width:180px;height:180px;background:${C.ink};overflow:hidden}div{width:180px;height:180px;display:flex;align-items:center;justify-content:center;font-family:'Fraunces',Georgia,serif;font-size:80px;color:#FBF9F5}</style></head><body><div>Co</div></body></html>`;
}

// ---------------------------------------------------------------- the head

// Pure: the preview tags for a live artifact. url: the link it was opened with; imageUrl: its card, or null when there's no public
// base to name it from.
export function previewHead(o: { title: string; description: string; url: string | null; imageUrl: string | null; iconBase: string | null }): string {
  return [
    `<meta name="description" content="${e(o.description)}">`,
    `<meta property="og:site_name" content="Co">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${e(o.title)}">`,
    `<meta property="og:description" content="${e(o.description)}">`,
    o.url ? `<meta property="og:url" content="${e(o.url)}">` : "",
    ...(o.imageUrl
      ? [
          `<meta property="og:image" content="${e(o.imageUrl)}">`,
          o.imageUrl.startsWith("https://") ? `<meta property="og:image:secure_url" content="${e(o.imageUrl)}">` : "",
          `<meta property="og:image:type" content="image/png">`,
          `<meta property="og:image:width" content="${OG_SIZE.width}">`,
          `<meta property="og:image:height" content="${OG_SIZE.height}">`,
          `<meta property="og:image:alt" content="${e(o.title)}">`,
          `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="twitter:image" content="${e(o.imageUrl)}">`,
        ]
      : [`<meta name="twitter:card" content="summary">`]),
    `<meta name="twitter:title" content="${e(o.title)}">`,
    `<meta name="twitter:description" content="${e(o.description)}">`,
    ...iconLinks(o.iconBase),
  ]
    .filter(Boolean)
    .join("\n");
}
// Pure: the one card every missing link shows: no title, no name, no image.
export function genericHead(iconBase: string | null): string {
  return [
    `<meta property="og:site_name" content="Co">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="Co">`,
    `<meta property="og:description" content="This link isn't available.">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="Co">`,
    `<meta name="twitter:description" content="This link isn't available.">`,
    ...iconLinks(iconBase),
  ].join("\n");
}
const iconLinks = (iconBase: string | null) =>
  iconBase ? [`<link rel="icon" type="image/svg+xml" href="${e(`${iconBase}/d/co.svg`)}">`, `<link rel="apple-touch-icon" href="${e(`${iconBase}/d/co.png`)}">`] : [];

// Pure: a rendered page with its own preview tags (the renderers' og:, twitter: and description tags) taken out and these put in
// their place, at the top of the head, so they are in the first bytes a crawler reads.
export function withPreviewHead(html: string, head: string): string {
  const stripped = html.replace(/<meta\s+(?:property="og:[^"]*"|name="twitter:[^"]*"|name="description")[^>]*>\n?/gi, "");
  // After the charset, which must stay in the first bytes.
  if (/<meta charset="utf-8">\n?/i.test(stripped)) return stripped.replace(/<meta charset="utf-8">\n?/i, (m) => `${m.trimEnd()}\n${head}\n`);
  return stripped.replace(/<head>\n?/i, (m) => `${m.trimEnd()}\n${head}\n`);
}

// ---------------------------------------------------------------- the image, rendered once per version and look

type Render = (html: string, size: { width: number; height: number }) => Promise<Buffer | null>;
const realRender: Render = async (html, size) => (await import("../browserRead.js")).renderPng(html, size);
export const OG_CACHE_LIMITS = { entries: 64, bytes: 48 * 1024 * 1024, maxImage: 4 * 1024 * 1024 } as const;
const cache = new Map<string, Buffer>();
const inflight = new Map<string, Promise<Buffer | null>>();
let cacheBytes = 0;
function put(key: string, png: Buffer, pageId: string): void {
  // A new version or look: the old cards of the same artifact go.
  for (const k of [...cache.keys()]) if (k.startsWith(`${pageId}:`) && k !== key) drop(k);
  cache.set(key, png);
  cacheBytes += png.length;
  while (cache.size > OG_CACHE_LIMITS.entries || cacheBytes > OG_CACHE_LIMITS.bytes) drop(cache.keys().next().value as string);
}
function drop(k: string): void {
  const b = cache.get(k);
  if (b) cacheBytes -= b.length;
  cache.delete(k);
}
export function clearPreviewCache(): void {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
}

// The card for one live artifact: from the cache, else rendered once (concurrent asks share one render). Null when Chrome isn't
// there or the render failed (the route answers 404, and the preview falls back to the title alone).
export async function previewPng(page: StoredCoPage, name: string | null, render: Render = realRender): Promise<Buffer | null> {
  const key = `${page.id}:${previewTag(page)}:${createHash("sha256").update(name ?? "").digest("base64url").slice(0, 8)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const html = previewCardHtml({ title: titleOf(page.data), kind: isDeckData(page.data) ? "deck" : "page", name, style: styleOf(page.data) });
    const png = await render(html, { ...OG_SIZE }).catch(() => null);
    if (!png || png.length > OG_CACHE_LIMITS.maxImage) return null;
    put(key, png, page.id);
    return png;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

let markPng: Promise<Buffer | null> | null = null;
export function coMarkPng(render: Render = realRender): Promise<Buffer | null> {
  markPng ??= render(coMarkHtml(), { width: 180, height: 180 })
    .catch(() => null)
    .then((b) => {
      if (!b) markPng = null;
      return b;
    });
  return markPng;
}
