// Real details for anything Co recommends, across all three tiers, plus a
// personal "why this fits you" (Royce, 2026-09-15: "Co sent me an event via
// Luma. I asked it for more detail and it said it can't... Through all tiers
// we need to be able to pull important info for our users and why it
// applies to them").
//
// Before this, a match carried only name, date, and link, and reply
// grounding correctly told Co it didn't know the time, place, host, or
// format, so "tell me more" got "I don't have that".
//
//   Tier 1 (Co's Luma events) and Tier 2 (public Luma events): the event's
//   own public page, which carries the full record (times with timezone,
//   venue and address when public, hosts, price, spots left, approval,
//   headcount, description).
//   Tier 3 (X opportunities): the source post's own text, which is the only
//   real record there is.
import { audienceLine } from "./eventAudience.js";
import { parseModelJson } from "./modelJson.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import { MODELS } from "../models.js";
import { IDENTITY_RULE, stripUngroundedIdentity } from "./identityGuard.js";
import { identityDropped } from "./guardDrops.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { availabilityConflict } from "./availability.js";
import { assumedZoneTime, clockTime, listedEnd, listedTime, listedWithOffset, ZONE_ASSUMED, ZONE_UNCLEAR } from "./zoneWords.js";

export type EventDetails = {
  startAt: string | null;
  endAt: string | null;
  timezone: string | null;
  online: boolean;
  venue: string | null;
  address: string | null;
  city: string | null;
  hosts: string[];
  price: string | null;
  spotsRemaining: number | null;
  requiresApproval: boolean | null;
  soldOut: boolean | null;
  guestCount: number | null;
  description: string | null;
  // Set only for an event found through Exa and read from Luma's official API (services/luma.ts getPublicLumaEvent): its Luma id,
  // its own name, and who the host listed it for ("public", "members-only", "private").
  apiId?: string | null;
  name?: string | null;
  visibility?: string | null;
  // Its zone came from its city, not its page, and its start doesn't carry that zone's offset (eventPage.ts settleZone): its time is
  // said as a guess (renderEventDetails).
  zoneGuessed?: boolean;
  // Luma's own registration state on its page (registration_availability: "open", "waitlist", "sold-out", ...), as the page says it.
  // Upcoming isn't the same as taking registrations: a waitlisted or sold-out event exists, it just isn't open.
  registration?: string | null;
  // Full, with a waitlist to join (registration "waitlist"; Royce, 2026-11-10: offered, said honestly as waitlist only, never turned
  // away as sold out). soldOut stays for full with no way on: a waitlist event is soldOut false and waitlist true, and never has spots.
  waitlist?: boolean;
  // The page's own schema.org record says it's cancelled (eventStatus EventCancelled). Absent: the page didn't say (unknown, not live).
  cancelled?: boolean;
};

// A waitlist event's registration, as Cue is told it (COPY: needs Royce's wording approval). The caption check (sendCheck.ts
// captionNumbersBacked) refuses a caption that says there are spots, or that Cue can get them off the waitlist.
export const WAITLIST_FACT = "Registration: waitlist only (no open spots; joining puts them on the waitlist, not in).";
export const WAITLIST_SHORT = "waitlist only (no open spots)";

// Tier 3: what the source post actually says.
export type OpportunityDetails = { postText: string };

export type EnrichedMatch = TierMatch;

const PAGE_TIMEOUT_MS = 6000;
const DESCRIPTION_MAX = 900;
const detailCache = new Map<string, { at: number; details: EventDetails | null }>();

export function lumaUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://lu.ma/${url.replace(/^\//, "")}`;
}

function proseMirrorText(node: any): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  const inner = Array.isArray(node.content) ? node.content.map(proseMirrorText).join(node.type === "doc" ? "\n" : "") : "";
  return ["paragraph", "heading", "list_item", "bullet_list", "ordered_list"].includes(node.type) ? `${inner}\n` : inner;
}

// Parses a Luma event page's embedded data. Exported for evals.
export function parseLumaEventPage(html: string): EventDetails | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data: any;
  try {
    data = JSON.parse(m[1])?.props?.pageProps?.initialData?.data;
  } catch {
    return null;
  }
  if (!data?.event) return null;
  const ev = data.event;
  const geo = ev.geo_address_info ?? {};
  const addressPublic = ev.geo_address_visibility !== "guests-only" && ev.geo_address_visibility !== "private";
  const ticket = data.ticket_info ?? {};
  const cents = ticket.price?.cents;
  const description = proseMirrorText(data.description_mirror).replace(/\n{3,}/g, "\n\n").trim();
  const registration = typeof data.registration_availability === "string" ? data.registration_availability : null;
  // Sold out by any of the page's own flags (2026-11-10 sample: one real event page said registration "sold-out" with sold_out false).
  // A waitlist (Luma marks a waitlisted event sold_out too) is its own state: offered as waitlist only, not sold out.
  const waitlist = registration === "waitlist";
  const soldOut = waitlist ? false : data.sold_out === true || ticket.is_sold_out === true || registration === "sold-out" ? true : typeof data.sold_out === "boolean" ? false : null;
  const cancelled = lumaPageCancelled(html);
  return {
    startAt: ev.start_at ?? data.start_at ?? null,
    endAt: ev.end_at ?? null,
    timezone: ev.timezone ?? null,
    online: ev.location_type === "online" || ev.location_type === "zoom",
    venue: addressPublic ? (geo.address ?? null) : null,
    address: addressPublic ? (geo.full_address ?? null) : null,
    city: geo.city ?? null,
    hosts: (data.hosts ?? []).map((h: any) => h?.name).filter(Boolean).slice(0, 4),
    price: ticket.is_free ? "free" : typeof cents === "number" ? `${(cents / 100).toFixed(cents % 100 ? 2 : 0)} ${String(ticket.price.currency ?? "usd").toUpperCase()}` : null,
    spotsRemaining: typeof ticket.spots_remaining === "number" ? ticket.spots_remaining : null,
    requiresApproval: typeof ticket.require_approval === "boolean" ? ticket.require_approval : null,
    soldOut,
    guestCount: typeof data.guest_count === "number" ? data.guest_count : null,
    description: description ? description.slice(0, DESCRIPTION_MAX) : null,
    // Who the host listed it for, as the page's own record says ("public", or "private": anyone with the link, never listed).
    visibility: typeof ev.visibility === "string" ? ev.visibility : null,
    ...(registration ? { registration } : {}),
    ...(waitlist ? { waitlist: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

// Pure: whether a Luma page's own schema.org record says the event is cancelled. Only its own words count: no record, or a record that
// doesn't say, is not "cancelled" (unknown).
export function lumaPageCancelled(html: string): boolean {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      for (const x of Array.isArray(d) ? d : [d]) if (/EventCancelled/i.test(String(x?.eventStatus ?? ""))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

// Pure: a Luma event page's record in the shape Luma's API gives (services/luma.ts LumaPublicEvent), so the Luma search through Exa
// (services/lumaViaExa.ts) checks a page and an API answer by the same rules; null when the page holds no event (a calendar's or a
// city's page). Only what the page's own embedded data says: nothing inferred. noindex: the page asks search engines not to list it
// (Luma does this for its "private" events, 2026-11-10 sample), read as one more sign it isn't for public discovery.
export type LumaPageRecord = import("./luma.js").LumaPublicEvent & { details: EventDetails; registration: string | null; soldOut: boolean | null; cancelled: boolean; noindex: boolean };
export function lumaPageRecord(html: string): LumaPageRecord | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data: any;
  try {
    data = JSON.parse(m[1])?.props?.pageProps?.initialData?.data;
  } catch {
    return null;
  }
  const ev = data?.event;
  const details = parseLumaEventPage(html);
  if (!ev || !details || typeof ev.api_id !== "string" || typeof ev.start_at !== "string") return null;
  const geo = ev.geo_address_info ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const registration = details.registration ?? null;
  return {
    id: ev.api_id,
    name: String(ev.name ?? "").trim(),
    slug: str(ev.url),
    startAt: ev.start_at,
    endAt: str(ev.end_at),
    timezone: str(ev.timezone),
    visibility: str(ev.visibility),
    locationType: str(ev.location_type),
    locationVisibility: str(ev.geo_address_visibility),
    city: str(geo.city),
    address: str(geo.address),
    fullAddress: str(geo.full_address),
    hosts: details.hosts,
    description: details.description,
    registrationOpen: registration ? registration === "open" : null,
    requireApproval: details.requiresApproval,
    spotsRemaining: details.spotsRemaining,
    details,
    registration,
    soldOut: details.soldOut,
    cancelled: details.cancelled === true,
    noindex: /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html),
  };
}

// A page read that worked is reused for an hour. One that failed or timed out
// is only reused for two minutes (enough to avoid refetching it twice in the
// same search): it used to be cached as null for an hour, and a page Co
// couldn't read meant no description and unknown sold-out status, so an
// off-topic sold-out event passed as a fit (code review, 2026-09-17).
const DETAIL_TTL_MS = 60 * 60 * 1000;
const FAILED_DETAIL_TTL_MS = 2 * 60 * 1000;

// Redirects followed by hand, each hop checked (security review, 2026-10-12: redirect "follow" let any hop land anywhere): a
// public http(s) address only, the same check the link reader makes. null when a hop is refused or there are too many.
const MAX_HOPS = 5;
export async function hopAllowed(url: string, isPublic?: (host: string) => Promise<boolean>): Promise<boolean> {
  const { urlAllowed, hostIsPublic } = await import("./linkReader.js");
  const u = urlAllowed(url);
  if (!u) return false;
  return (isPublic ?? hostIsPublic)(u.hostname.replace(/^\[|\]$/g, "")).catch(() => false);
}
export async function fetchCheckedHops(url: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, isPublic?: (host: string) => Promise<boolean>): Promise<Response | null> {
  let next = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!(await hopAllowed(next, isPublic))) return null;
    const res = await fetchImpl(next, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual", signal });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    next = new URL(location, next).toString();
  }
  return null;
}

// maxAgeMs: how old a cached successful read may be. A cached search result
// re-checks availability with a short one, since sold-out status changes.
// lane: "sweep" for the background searches (waits its turn, bounded), anything else a reply's (never queues behind a sweep: past
// LUMA_PACE.replyMaxWaitMs it isn't read now, and what's cached, however old, or nothing, is used).
export async function fetchLumaEventDetails(url: string, opts: { maxAgeMs?: number; lane?: LumaLane } = {}): Promise<EventDetails | null> {
  const key = lumaUrl(url);
  const cached = detailCache.get(key);
  const ttl = cached?.details ? Math.min(opts.maxAgeMs ?? DETAIL_TTL_MS, DETAIL_TTL_MS) : FAILED_DETAIL_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.details;
  const r = await readLumaPage(url, fetch, { lane: opts.lane });
  return r.error === LUMA_PACED ? (cached?.details ?? null) : r.details;
}

// One fetch of a Luma page: its html and its event record (null for a calendar's or a city's page), the record cached as above. The web
// search's page check reads both from this one response (taskWeb.ts pickPage; re-review of #293: it fetched the page to check it, then
// read it again).
// status: the page's HTTP status (null when no answer came: timed out, unreachable, or a redirect hop refused); error: why there's no
// html, said plainly. A 404 is a page that isn't there; a 403, 429 or 503 is Luma not serving it to us (never "no such event").
// One pace for every Luma page read in this process (2026-11-11 9am sweep: two searches read 21 and 24 pages five at a time, and the third,
// a minute later, got HTTP 429 on all 24): a token bucket, a small burst, then one read a second, whichever search, member or reply asks.
// The in-process caches (this file's detailCache, lumaViaExa.ts pageCache) mean the same link read again within its TTL is never fetched.
// Every wait is bounded (second review of #456: first-come slots made a reply's read wait 30s behind a sweep's): a sweep read waits up to
// sweepMaxWaitMs, a reply's up to replyMaxWaitMs; past that the read doesn't happen now (LUMA_PACED: nothing is reserved). Luma publishes no
// page limit: one a second is a guess at "safe", not a measured one; a refusal still pauses the route (lumaViaExa.ts). Only the real
// network fetch is paced.
export const LUMA_PACE = { gapMs: 1000, burst: 4, replyMaxWaitMs: 2500, sweepMaxWaitMs: 20_000 } as const;
export type LumaLane = "reply" | "sweep";
export const LUMA_PACED = "paced: Luma's pages are busy; not read now";
let bucket = { tokens: LUMA_PACE.burst as number, at: 0 };
// Pure-ish: take one read's token at `now`. The wait in ms, or null when it would pass maxWait (then nothing is taken).
export function lumaPaceTake(now: number, maxWait: number): number | null {
  const tokens = bucket.at ? Math.min(LUMA_PACE.burst, bucket.tokens + (now - bucket.at) / LUMA_PACE.gapMs) : bucket.tokens;
  const wait = tokens >= 1 ? 0 : Math.ceil((1 - tokens) * LUMA_PACE.gapMs);
  if (wait > maxWait) {
    bucket = { tokens, at: now };
    return null;
  }
  bucket = { tokens: tokens - 1, at: now };
  return wait;
}
export const resetLumaPace = () => void (bucket = { tokens: LUMA_PACE.burst, at: 0 });
async function lumaPace(lane: LumaLane): Promise<boolean> {
  const wait = lumaPaceTake(Date.now(), lane === "sweep" ? LUMA_PACE.sweepMaxWaitMs : LUMA_PACE.replyMaxWaitMs);
  if (wait === null) return false;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return true;
}

export async function readLumaPage(url: string, fetchImpl: typeof fetch = fetch, o: { lane?: LumaLane } = {}): Promise<{ html: string | null; details: EventDetails | null; status: number | null; error: string | null }> {
  const key = lumaUrl(url);
  // Not read now (the pace's bound passed): nothing cached is overwritten, and it isn't a refusal (no pause).
  if (fetchImpl === fetch && !(await lumaPace(o.lane ?? "reply"))) return { html: null, details: null, status: null, error: LUMA_PACED };
  let html: string | null = null;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await fetchCheckedHops(key, controller.signal, fetchImpl);
      if (!res) error = "a redirect hop was refused";
      else {
        status = res.status;
        if (res.ok) html = await res.text();
        else error = `HTTP ${res.status}`;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    error = /abort/i.test(String(err?.name ?? err?.message ?? "")) ? `timed out (${PAGE_TIMEOUT_MS / 1000}s)` : String(err?.message ?? err).slice(0, 120);
    console.error(`eventDetails: fetch failed for ${key} (non-fatal):`, err?.message ?? err);
  }
  const details = html ? parseLumaEventPage(html) : null;
  if (detailCache.size > 500) detailCache.clear();
  detailCache.set(key, { at: Date.now(), details });
  return { html, details, status, error };
}

// Plain facts for any prompt, one per line. Only what's actually on record.
export function renderEventDetails(name: string, d: EventDetails): string[] {
  const lines: string[] = [];
  if (d.startAt) {
    // No zone of its own but an offset in its start: its own offset, as listed (final review of #298: "UTC" here turned a Wednesday 5pm
    // -07:00 start into "Thursday, October 8 at 12:00 AM (UTC)"), the way linkReader.ts timeFact says it.
    const ownOffset = !d.timezone && listedWithOffset(d.startAt);
    const zone = d.timezone ?? "UTC";
    const at = (iso: string) => (ownOffset ? DateTime.fromISO(iso, { setZone: true }) : DateTime.fromISO(iso).setZone(zone));
    const start = at(d.startAt);
    const end = d.endAt ? at(d.endAt) : null;
    const sameDay = end && end.hasSame(start, "day");
    const ends = end ? ` and ends ${sameDay ? end.toFormat("h:mm a") : end.toFormat("cccc, LLLL d 'at' h:mm a")}` : "";
    // The zone assumed from its city (Royce, 2026-10-28 ruling: never "around"; the time as listed, the city named, zoneWords.ts):
    // COPY "\"Launch Night\" starts Wednesday, October 7 at 5 PM PT. The listing doesn't specify a timezone, so I'm assuming local time
    // in San Francisco." No zone it can establish, and no offset of its own: no time at all (ZONE_UNCLEAR).
    const assumed = d.zoneGuessed && d.timezone && d.city ? assumedZoneTime(d.startAt, d.timezone) : null;
    if (assumed) lines.push(`"${name}" starts ${assumed}${end ? ` and ends ${clockTime(end)}` : ""}. ${ZONE_ASSUMED(d.city!)}`);
    else if (!d.timezone && !listedWithOffset(d.startAt)) lines.push(ZONE_UNCLEAR(name));
    // COPY, approved by Royce 2026-10-28: "\"Launch Night\" starts Wednesday, October 7 at 5 PM (UTC−7, as listed) and ends at 8 PM."
    else if (ownOffset) lines.push(`"${name}" starts ${listedTime(d.startAt)}${listedEnd(d.startAt, d.endAt)}.`);
    else lines.push(`"${name}" starts ${start.toFormat("cccc, LLLL d 'at' h:mm a")}${ends} (${zone}).`);
  }
  if (d.online) lines.push(`"${name}" is online.`);
  else if (d.venue || d.address) {
    const place = d.address && d.venue && !d.address.startsWith(d.venue) ? `${d.venue}, ${d.address}` : (d.address ?? d.venue);
    lines.push(`"${name}" is at ${place}.`);
  }
  else if (d.city) lines.push(`"${name}" is in ${d.city}; the exact address is only shown to registered guests.`);
  if (d.hosts.length) lines.push(`Hosted by ${d.hosts.join(", ")}.`);
  if (d.price) lines.push(d.price === "free" ? "It's free." : `Tickets are ${d.price}.`);
  if (d.soldOut) lines.push("It's sold out.");
  else if (d.waitlist) lines.push(WAITLIST_FACT);
  else if (d.spotsRemaining !== null) lines.push(`${d.spotsRemaining} spots left.`);
  if (d.requiresApproval) lines.push("Registration needs host approval.");
  if (d.guestCount) lines.push(`${d.guestCount} ${d.guestCount === 1 ? "person has" : "people have"} registered so far.`);
  if (d.description) lines.push(`What the event page says: ${d.description.replace(/\n+/g, " ")}`);
  const audience = audienceLine(name, d.description);
  if (audience) lines.push(audience);
  return lines;
}

// What's still missing, stated as gaps so "I don't have that" stays grounded.
export function missingEventDetails(name: string, d: EventDetails | undefined): string | null {
  if (!d) return `For "${name}", Cue does not have the start time, address, host, price, or format.`;
  const missing = [
    !d.startAt && "start time",
    !d.online && !d.venue && !d.address && !d.city && "location",
    !d.hosts.length && "host",
    !d.price && "price",
  ].filter(Boolean);
  return missing.length ? `For "${name}", Cue does not have: ${missing.join(", ")}.` : null;
}

// avoid and availability (2026-09-22) are loaded by explainFit itself from userId, through the member record (services/memberKnowledge.ts
// "limits", the one reader since Phase A6), so a caller gets them without passing them.
export type PersonForFit = {
  userId?: string;
  firstName: string;
  // The search Co ran (the brief), which is what a candidate is judged against.
  askText: string | null;
  // Their latest text, as context only.
  latestText?: string | null;
  timeFrame?: string | null;
  goals?: string[] | null;
  city?: string | null;
  // Where this search looked ("San Francisco, California", or several joined
  // with " + "): what they asked about, which can differ from their profile.
  place?: string | null;
  feeling?: string;
  avoid?: string[] | null;
  availability?: string | null;
  // The kind of room they've told Co they want (services/roomTaste.ts), their words: background for the fit (Phase A5).
  roomTaste?: string[] | null;
};

// A personal reason, grounded only in what they've said and the real
// details. Sonnet: it's shown to them and needs judgment.
//
// Fit is judged against what they're asking for now, including a new or
// hypothetical direction (2026-09-15: "accelerators that could help me if I
// decide to build something else" got a pre-seed accelerator called a
// mismatch because the person's current company is Series A).
// What's known about one candidate, for the fit read.
function detailLinesFor(match: EnrichedMatch): string[] {
  return match.details ? renderEventDetails(match.name, match.details) : match.opportunity ? [`What the post says: ${match.opportunity.postText}`] : [];
}

// The person and the tests, shared by the single and the batched read.
// The ask is the search Co actually ran (the brief), not their latest text:
// judged against "Well a couple" or "Hello?", real matches were turned away
// as the wrong kind, place or week in 22 of 30 searches (2026-09-24 to 30).
function fitContext(person: PersonForFit, picture: string): { intro: string; rules: string } {
  const avoidList = (person.avoid ?? []).filter((a) => a && a.trim());
  const latest = person.latestText && person.latestText.trim() && person.latestText.trim() !== (person.askText ?? "").trim() ? person.latestText.trim() : null;
  const intro = `What ${person.firstName} asked Cue to find (the search Cue just ran for them):
${person.askText ?? "(no specific ask)"}${latest ? `\nTheir latest text, for context: "${latest.slice(0, 300)}"` : ""}

Background on them:
${picture ? picture : person.goals?.length ? `Goals: ${person.goals.slice(0, 4).join("; ")}` : "(none)"}
${person.city ? `Based in: ${person.city}` : ""}
${person.roomTaste?.length ? `The kind of room they've told Cue they want, in their words: ${person.roomTaste.map((t) => `"${t}"`).join("; ")}. Something that clearly clashes with it isn't worth their time unless this search asked for exactly that.` : ""}
${person.feeling ? `How they've been feeling: ${person.feeling}` : ""}`;
  const rules = `Rules:
- ${IDENTITY_RULE}
- Two tests, both must pass:
  1. It's the kind of thing they asked Cue to find. The search decides: if they asked for a pottery class, a founder event doesn't fit however good it is for them. Older asks in the background are context, not this search.
  2. It's worth their time given who they are right now: their work and stage, what they want, what matters to them in people, and what has or hasn't worked before. Something clearly aimed at a different audience or stage (a beginner coding workshop for an experienced technical founder, a job fair for someone not looking) doesn't fit. When the background says nothing either way, this test passes.
- Judge the event by its own main activity. Who attends, hosts, or sponsors never changes what kind of event it is: a chess night full of AI researchers is a chess night, not an AI meetup.
- If they're asking about a new or possible direction ("if I start something new", "if I decide to build something else"), judge it for that new thing. A new company starts from zero, so pre-seed and seed programs fit it. Their current company's stage, funding, or other asks never make it a misfit.
- Say it doesn't fit when it fails either test: the wrong kind of thing, the wrong place or time, or clearly not worth their time for who they are now. Your answer and your explanation must agree: if your explanation says it matches what they asked, it fits unless you name the test it fails.
- ${person.timeFrame ? `They asked about ${person.timeFrame}. Something clearly happening outside that time frame doesn't fit, however good it is otherwise.` : "They didn't name a time frame."}
- How they've been feeling never makes something a misfit: it changes how Cue brings it up, not whether they hear about it.
${
    // Only present when there's something to apply (2026-09-22): an
    // always-present "avoided" field made the model mark ordinary matches
    // as avoided (a hackathon fit 1 in 5 times with nothing ruled out,
    // against 3 in 3 before).
    avoidList.length
      ? `- They told Cue to stop suggesting these kinds of things: ${avoidList.map((a) => `"${a}"`).join(", ")}. If it is clearly one of those kinds (judged by its main activity, the same way as above), it does not fit, it is not the right kind, and "avoided" is true, however good it is otherwise. Anything else is not avoided.\n`
      : ""
  }${person.availability ? `- When they've said they're usually free: "${person.availability}". Check the day of the week and the time it starts, from the details above, against that. If it's on a day or at a time outside what they said (a Saturday for "weeknights only", a weekday afternoon for "evenings"), it doesn't fit, though it can still be the right kind. When the event's time isn't known, this test passes.\n` : ""}- Connect a specific thing about them (their ask, or who they are right now) to a specific real detail above. Use only what's written here.

Also say whether it's the right kind of thing for what they asked (test 1 alone), even when it fails on something else like the date or their stage: a founder mixer for someone asking for founder events is the right kind; a funding story for someone asking about hiring is not.
${person.timeFrame ? `\nAlso say whether it clearly happens outside ${person.timeFrame} ("outsideTimeFrame": true), from its own dates above. When its dates aren't known, false.\n` : ""}${person.place ? `\nThey're looking in or near ${person.place.split(" + ").join(" or ")}. Also say whether it's clearly somewhere else and not online ("outsidePlace": true), from where it is above. When its place isn't known, false.\n` : ""}`;
  return { intro, rules };
}

function fitFields(person: PersonForFit): string {
  const avoidList = (person.avoid ?? []).filter((a) => a && a.trim());
  return `"fits": true or false, "rightKind": true or false,${person.timeFrame ? ' "outsideTimeFrame": true or false,' : ""}${person.place ? ' "outsidePlace": true or false,' : ""}${avoidList.length ? ' "avoided": true or false,' : ""} "why": "the explanation"`;
}

export function fitPrompt(match: EnrichedMatch, person: PersonForFit, picture: string): string {
  const { intro, rules } = fitContext(person, picture);
  return `Decide whether "${match.name}" fits ${person.firstName}, and explain why in one or two plain sentences, to Cue's own notes.

${intro}

What's actually known about "${match.name}":
${detailLinesFor(match).join("\n") || "(only the name)"}

${rules}
Return ONLY JSON: {${fitFields(person)}}`;
}

// What they've ruled out, when they're usually free, the kind of room they want and who they are, from the member record (one read, every
// string already stripped of other members' details; review of the audit: this read co_profiles and the raw snapshot on its own). A
// record that can't be read (a failed name read fails closed) gives no picture and no limits rather than anything unstripped.
async function fitKnowledge(userId: string) {
  const { memberKnowledge } = await import("./memberKnowledge.js");
  return memberKnowledge(userId, { include: ["limits", "person", "preferences"] }).catch((err: any) => {
    console.error("eventDetails: member record read failed (non-fatal, judging without it):", err?.message ?? err);
    return null;
  });
}

export async function explainFit(match: EnrichedMatch, person: PersonForFit): Promise<FitResult | null> {
  const k = person.userId ? await fitKnowledge(person.userId) : null;
  const picture = k?.person?.text ?? "";
  // A record that failed closed still has their limits applied: the same reader, alone (their own words; nothing of anyone else's).
  const limits = k?.limits ?? (person.userId ? await import("./memberKnowledge.js").then((M) => M.realKnowledgeDeps.limits(person.userId!)).catch(() => null) : null);
  person = withPreferences(person, k ? { ...k, limits } : limits ? { limits, preferences: [] } : null);
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "eventDetails.explainFit" },
      prompt: fitPrompt(match, person, picture),
    });
    return finishFit(parseModelJson<RawFit>(text), match, person, picture);
  } catch (err: any) {
    console.error("eventDetails: explainFit failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

type RawFit = { fits?: boolean; rightKind?: boolean; outsideTimeFrame?: boolean; outsidePlace?: boolean; avoided?: boolean; why?: string };
export type FitResult = { fits: boolean; rightKind: boolean; outsideTimeFrame?: boolean; outsidePlace?: boolean; why: string };

// The checks code makes on any read, single or batched.
function finishFit(p: RawFit, match: EnrichedMatch, person: PersonForFit, picture: string): FitResult | null {
  const outsideTimeFrame = !!person.timeFrame && p.outsideTimeFrame === true;
  const outsidePlace = !!person.place && p.outsidePlace === true && !match.online;
  if (typeof p.why !== "string" || !p.why.trim()) return null;
  // Never claim who they are beyond what Co was given about them (services/identityGuard.ts).
  const cleanWhy = stripUngroundedIdentity(p.why, `${picture}\n${person.askText ?? ""}\n${person.latestText ?? ""}\n${(person.goals ?? []).join(" ")}\n${person.city ?? ""}`);
  identityDropped(p.why, cleanWhy, "event_fit", person.userId);
  if (!cleanWhy) return null;
  const why = cleanWhy.trim();
  // A kind they ruled out is enforced here, not left to the model's other
  // two answers: it must never fit, and never go out as a "closest thing"
  // stretch either (routes/sendblue.ts sends a rightKind misfit with a
  // caveat when nothing fits).
  if (p.avoided === true && person.avoid?.length) return { fits: false, rightKind: false, why };
  // Day and time checked in code (services/availability.ts): a clear
  // conflict is a misfit however the model read it. Still the right kind,
  // so it can go out as a caveated "closest thing" when nothing else fits,
  // and the caveat names the day and time.
  const conflict = availabilityConflict(person.availability, match.details?.startAt ?? null, match.details?.timezone ?? null);
  if (conflict) return { fits: false, rightKind: p.rightKind !== false, outsideTimeFrame, outsidePlace, why: `${why} ${conflict}` };
  // Outside the dates or the place they asked about never fits.
  const fits = p.fits !== false && !outsideTimeFrame && !outsidePlace;
  // Anything that fits is the right kind; a misfit is only the right kind
  // when the model said so outright.
  return { fits, rightKind: fits || p.rightKind === true, outsideTimeFrame, outsidePlace, why };
}

function withPreferences(person: PersonForFit, k: { limits: { avoid: string[]; availability: string | null } | null; preferences: { text: string; source: string }[] } | null): PersonForFit {
  return {
    ...person,
    avoid: person.avoid ?? k?.limits?.avoid ?? [],
    availability: person.availability ?? k?.limits?.availability ?? null,
    roomTaste: person.roomTaste ?? k?.preferences.filter((p) => p.source === "stated").map((p) => p.text) ?? null,
  };
}

// Attach real details (and, with a person, a personal reason) to a match.
// Safe to call on an already-enriched match; fetches only what's missing.
// Links in a post (X shortens them to t.co), resolved to where they go.
export function linksIn(text: string): string[] {
  return Array.from(new Set(text.match(/https?:\/\/[^\s)"'<>]+/g) ?? [])).slice(0, 4);
}

export function isLumaLink(url: string): boolean {
  return /^https?:\/\/(www\.)?(lu\.ma|luma\.com)\//i.test(url);
}

export async function resolveLink(url: string): Promise<string> {
  if (!/^https?:\/\/t\.co\//i.test(url)) return url;
  try {
    // Every hop checked (linkReader.safeFetch, security review 2026-10-11): a t.co link can't send Co's server to a private address.
    const { safeFetch } = await import("./linkReader.js");
    const r = await safeFetch(url);
    return "error" in r ? url : r.finalUrl;
  } catch {
    return url;
  }
}

// An event posted on X with its Luma page linked: the time and place come
// from Luma (Royce, 2026-09-28: "if a X post contains a Luma url, search and
// gather all the details from luma... we must gather time and date").
export async function lumaDetailsFromPost(postText: string): Promise<{ details: EventDetails; url: string } | null> {
  for (const link of linksIn(postText)) {
    const url = await resolveLink(link);
    if (!isLumaLink(url)) continue;
    const details = await fetchLumaEventDetails(url);
    if (details) return { details, url };
  }
  return null;
}

export async function enrichMatch(match: TierMatch | EnrichedMatch, person?: PersonForFit): Promise<EnrichedMatch> {
  const m: EnrichedMatch = { ...match };
  // A read here is a read: stamped, so a reply doesn't call it stale (Phase B, review of #138; the cache is at most an hour old).
  if (m.kind !== "opportunity" && !m.details && "url" in m && m.url) {
    m.details = (await fetchLumaEventDetails(m.url)) ?? undefined;
    if (m.details) m.checkedAt = new Date().toISOString();
  }
  if (m.kind === "opportunity" && !m.opportunity && m.evidence) m.opportunity = { postText: m.evidence };
  // Any event Co surfaces gets its time: an X post with a Luma link reads it from Luma.
  if (!m.details && m.opportunity?.postText) {
    const found = await lumaDetailsFromPost(m.opportunity.postText).catch(() => null);
    if (found) {
      m.details = found.details;
      m.checkedAt = new Date().toISOString();
    }
  }
  if (person && !m.whyItFits) {
    const fit = await explainFit(m, person);
    if (fit) {
      m.whyItFits = fit.why;
      m.fits = fit.fits;
      m.rightKind = fit.rightKind;
      m.outsideTimeFrame = fit.outsideTimeFrame;
      m.outsidePlace = fit.outsidePlace;
    }
  }
  return m;
}
