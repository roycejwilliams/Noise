// The one event page template (Royce, 2026-10-10: "One template, designed once, mobile-first ... It should feel like an invitation
// to a private social club"; "Keep the template dumb and the data clean"). It takes a page that already passed the schema
// (schema.ts) and places each field in its own slot, escaped. It never reads prose, markdown or HTML from the data, and the model
// never writes any of it.
//
// Design: Co's approved email set (services/emailDesign.ts, Figma "Email Campaigns"): a paper card centered on a one-color
// gradient, Fraunces for the headline and Co's lines, Satoshi for the rest, a thin gold rule, no photos on the page. Inline CSS only.
//
// The interaction layer (RSVP and the like) is another module's job: it fills the marked slot between <!-- co:actions --> and
// <!-- /co:actions --> through renderActions. Without one, a non-member sees one quiet line.
import { EMAIL_COLORS, escapeHtml } from "../emailDesign.js";
import type { EventPageData } from "./schema.js";

export type EventPageView = { id: string; data: EventPageData; version: number; ownerUserId?: string | null; archivedAt?: Date | null };
export type RenderActions = (page: EventPageView) => string;

export const ACTIONS_OPEN = "<!-- co:actions -->";
export const ACTIONS_CLOSE = "<!-- /co:actions -->";
export const DEFAULT_ACTIONS: RenderActions = () => `<p class="co-actions-note">Members RSVP by texting Co.</p>`;

const C = EMAIL_COLORS;
const PAPER = "#FDFBF7";
// One color, light to dark: Co's ink.
const GROUND_TOP = "#4A2733";
const GROUND_BOTTOM = "#1C0E12";
const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "'Satoshi', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

const e = escapeHtml;

// "Saturday, October 24" and "7:30 to 11 PM PDT", in the event's own zone.
export function whenLines(d: Pick<EventPageData, "startsAt" | "endsAt" | "timezone">): { day: string; time: string } {
  const start = new Date(d.startsAt);
  const tz = d.timezone;
  const dayOf = (x: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(x);
  const parts = (x: Date) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(x);
    const get = (t: string) => p.find((q) => q.type === t)?.value ?? "";
    const minute = get("minute");
    return { clock: minute === "00" ? get("hour") : `${get("hour")}:${minute}`, period: get("dayPeriod").toUpperCase(), zone: get("timeZoneName") };
  };
  const s = parts(start);
  if (!d.endsAt) return { day: dayOf(start), time: `${s.clock} ${s.period} ${s.zone}` };
  const end = new Date(d.endsAt);
  const en = parts(end);
  const sameDay = dayOf(start) === dayOf(end);
  if (!sameDay) {
    const endDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(end);
    return { day: dayOf(start), time: `${s.clock} ${s.period} to ${endDay} ${en.clock} ${en.period} ${en.zone}` };
  }
  return { day: dayOf(start), time: s.period === en.period ? `${s.clock} to ${en.clock} ${en.period} ${en.zone}` : `${s.clock} ${s.period} to ${en.clock} ${en.period} ${en.zone}` };
}

// The preview line under the title when the link is texted: the date and the place.
export function ogDescription(d: EventPageData): string {
  const w = whenLines(d);
  return `${w.day}, ${w.time} · ${d.venueName}`;
}

export function mapsHref(d: Pick<EventPageData, "venueName" | "address">): string {
  return `https://maps.apple.com/?q=${encodeURIComponent([d.venueName, d.address].filter(Boolean).join(", "))}`;
}

const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:${GROUND_BOTTOM};background-image:linear-gradient(180deg,${GROUND_TOP} 0%,${GROUND_BOTTOM} 100%);background-attachment:fixed;color:${C.body};font-family:${SANS};-webkit-font-smoothing:antialiased}
.ground{padding:40px 16px 48px;display:flex;justify-content:center}
.card{width:100%;max-width:520px;background:${PAPER};border-radius:2px;padding:12px;box-shadow:0 24px 60px rgba(0,0,0,.35)}
.frame{border:1px solid ${C.gold};padding:40px 24px 32px;text-align:center}
.brand{font-family:${SERIF};font-size:28px;line-height:1;color:${C.ink};margin:0 0 28px}
.eyebrow{font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:${C.muted};margin:0 0 18px}
.host{font-family:${SERIF};font-style:italic;font-size:16px;line-height:1.5;color:${C.ink};margin:0 0 12px}
h1{font-family:${SERIF};font-weight:300;font-size:34px;line-height:1.15;letter-spacing:-.01em;color:${C.ink};margin:0;overflow-wrap:anywhere}
.rule{width:40px;height:1px;background:${C.gold};margin:28px auto}
.day{font-family:${SERIF};font-size:20px;line-height:1.3;color:${C.ink};margin:0 0 6px}
.time{font-size:14px;line-height:1.5;letter-spacing:.3px;color:${C.soft};margin:0 0 24px}
.venue{font-size:13px;font-weight:500;letter-spacing:1.2px;text-transform:uppercase;color:${C.ink};margin:0 0 6px;overflow-wrap:anywhere}
.address{display:inline-block;font-size:14px;line-height:1.5;color:${C.soft};text-decoration:none;border-bottom:1px solid ${C.line};overflow-wrap:anywhere}
section{margin:36px 0 0;text-align:left}
h2{font-size:11px;font-weight:500;letter-spacing:1.6px;text-transform:uppercase;color:${C.muted};text-align:center;margin:0 0 18px}
h2::after{content:"";display:block;width:24px;height:1px;background:${C.gold};margin:10px auto 0}
ol,ul{list-style:none;margin:0;padding:0}
.schedule li{display:flex;gap:16px;padding:12px 0;border-top:1px solid ${C.line}}
.schedule li:last-child{border-bottom:1px solid ${C.line}}
.t{flex:0 0 72px;font-family:${SERIF};font-size:15px;line-height:1.4;color:${C.maroon}}
.label{font-size:15px;line-height:1.4;color:${C.ink};margin:0}
.detail{font-size:14px;line-height:1.55;color:${C.soft};margin:4px 0 0}
.bring{text-align:center}
.bring li{font-size:15px;line-height:1.5;color:${C.body};padding:4px 0}
.notes p{font-size:14px;line-height:1.65;color:${C.body};margin:0 0 12px;text-align:center}
.notes p:last-child{margin-bottom:0}
.actions{margin:36px 0 0;text-align:center}
.co-actions-note{font-family:${SERIF};font-style:italic;font-size:15px;color:${C.ink};margin:0}
.foot{margin:36px 0 0;padding-top:16px;border-top:1px solid ${C.line};font-size:11px;font-weight:500;letter-spacing:1px;text-transform:uppercase;color:${C.muted};text-align:center}
@media (min-width:600px){.ground{padding:72px 24px 80px}.frame{padding:56px 48px 40px}h1{font-size:40px}}
`;

export function renderEventPage(page: EventPageView, o: { url: string | null; ogImageUrl: string | null; renderActions?: RenderActions }): string {
  const d = page.data;
  const w = whenLines(d);
  const desc = ogDescription(d);
  const image = d.imageUrl ?? o.ogImageUrl;
  const card = d.imageUrl ? "summary_large_image" : "summary";
  const meta = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Co">`,
    `<meta property="og:title" content="${e(d.title)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    o.url ? `<meta property="og:url" content="${e(o.url)}">` : "",
    image ? `<meta property="og:image" content="${e(image)}">` : "",
    image ? `<meta property="og:image:alt" content="${e(d.title)}">` : "",
    `<meta name="twitter:card" content="${card}">`,
    `<meta name="twitter:title" content="${e(d.title)}">`,
    `<meta name="twitter:description" content="${e(desc)}">`,
    image ? `<meta name="twitter:image" content="${e(image)}">` : "",
  ].filter(Boolean).join("\n");

  const schedule = d.schedule.length
    ? `<section aria-label="Schedule"><h2>Schedule</h2><ol class="schedule">${d.schedule
        .map((b) => `<li><span class="t">${e(b.time)}</span><div><p class="label">${e(b.label)}</p>${b.detail ? `<p class="detail">${e(b.detail)}</p>` : ""}</div></li>`)
        .join("")}</ol></section>`
    : "";
  const bring = d.whatToBring.length ? `<section aria-label="What to bring"><h2>What to bring</h2><ul class="bring">${d.whatToBring.map((s) => `<li>${e(s)}</li>`).join("")}</ul></section>` : "";
  const notes = d.notes.length ? `<section aria-label="Good to know" class="notes"><h2>Good to know</h2>${d.notes.map((s) => `<p>${e(s)}</p>`).join("")}</section>` : "";
  const actions = (o.renderActions ?? DEFAULT_ACTIONS)(page);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light only">
<title>${e(d.title)}</title>
<meta name="description" content="${e(desc)}">
${meta}
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;1,400&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<main class="ground">
<article class="card">
<div class="frame">
<div class="brand">Co.</div>
<p class="eyebrow">A private invitation</p>
${d.hostLine ? `<p class="host">${e(d.hostLine)}</p>` : ""}
<h1>${e(d.title)}</h1>
<div class="rule" role="presentation"></div>
<p class="day">${e(w.day)}</p>
<p class="time">${e(w.time)}</p>
<p class="venue">${e(d.venueName)}</p>
${d.address ? `<a class="address" href="${e(mapsHref(d))}" rel="noopener noreferrer">${e(d.address)}</a>` : ""}
${schedule}
${bring}
${notes}
<div class="actions">
${ACTIONS_OPEN}
${actions}
${ACTIONS_CLOSE}
</div>
<div class="foot">Co &nbsp;&middot;&nbsp; Private, by referral</div>
</div>
</article>
</main>
</body>
</html>`;
}

// What an unknown or archived link shows: nothing about any page.
export function notFoundPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Not available</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${GROUND_BOTTOM};background-image:linear-gradient(180deg,${GROUND_TOP} 0%,${GROUND_BOTTOM} 100%);font-family:${SANS};color:${PAPER}}main{text-align:center;padding:24px}.brand{font-family:${SERIF};font-size:28px;margin-bottom:20px}p{font-size:15px;color:${C.line};margin:0}</style></head>
<body><main><div class="brand">Co.</div><p>This page isn't available.</p></main></body></html>`;
}
