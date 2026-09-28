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
import pool from "../db/db.js";
import { parseModelJson } from "./modelJson.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import { MODELS } from "../models.js";
import { IDENTITY_RULE, stripUngroundedIdentity } from "./identityGuard.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { getPersonSnapshot, renderSnapshot } from "../harness/personSnapshot.js";
import { latestAskEntry } from "../harness/profileWrite.js";
import { availabilityConflict } from "./availability.js";

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
};

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
    soldOut: typeof data.sold_out === "boolean" ? data.sold_out : null,
    guestCount: typeof data.guest_count === "number" ? data.guest_count : null,
    description: description ? description.slice(0, DESCRIPTION_MAX) : null,
  };
}

// A page read that worked is reused for an hour. One that failed or timed out
// is only reused for two minutes (enough to avoid refetching it twice in the
// same search): it used to be cached as null for an hour, and a page Co
// couldn't read meant no description and unknown sold-out status, so an
// off-topic sold-out event passed as a fit (code review, 2026-09-17).
const DETAIL_TTL_MS = 60 * 60 * 1000;
const FAILED_DETAIL_TTL_MS = 2 * 60 * 1000;

// maxAgeMs: how old a cached successful read may be. A cached search result
// re-checks availability with a short one, since sold-out status changes.
export async function fetchLumaEventDetails(url: string, opts: { maxAgeMs?: number } = {}): Promise<EventDetails | null> {
  const key = lumaUrl(url);
  const cached = detailCache.get(key);
  const ttl = cached?.details ? Math.min(opts.maxAgeMs ?? DETAIL_TTL_MS, DETAIL_TTL_MS) : FAILED_DETAIL_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.details;
  let details: EventDetails | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await fetch(key, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow", signal: controller.signal });
      if (res.ok) details = parseLumaEventPage(await res.text());
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    console.error(`eventDetails: fetch failed for ${key} (non-fatal):`, err?.message ?? err);
  }
  if (detailCache.size > 500) detailCache.clear();
  detailCache.set(key, { at: Date.now(), details });
  return details;
}

// Plain facts for any prompt, one per line. Only what's actually on record.
export function renderEventDetails(name: string, d: EventDetails): string[] {
  const lines: string[] = [];
  if (d.startAt) {
    const zone = d.timezone ?? "UTC";
    const start = DateTime.fromISO(d.startAt).setZone(zone);
    const end = d.endAt ? DateTime.fromISO(d.endAt).setZone(zone) : null;
    const sameDay = end && end.hasSame(start, "day");
    lines.push(
      `"${name}" starts ${start.toFormat("cccc, LLLL d 'at' h:mm a")}${end ? ` and ends ${sameDay ? end.toFormat("h:mm a") : end.toFormat("cccc, LLLL d 'at' h:mm a")}` : ""} (${zone}).`,
    );
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
  else if (d.spotsRemaining !== null) lines.push(`${d.spotsRemaining} spots left.`);
  if (d.requiresApproval) lines.push("Registration needs host approval.");
  if (d.guestCount) lines.push(`${d.guestCount} ${d.guestCount === 1 ? "person has" : "people have"} registered so far.`);
  if (d.description) lines.push(`What the event page says: ${d.description.replace(/\n+/g, " ")}`);
  return lines;
}

// What's still missing, stated as gaps so "I don't have that" stays grounded.
export function missingEventDetails(name: string, d: EventDetails | undefined): string | null {
  if (!d) return `For "${name}", Co does not have the start time, address, host, price, or format.`;
  const missing = [
    !d.startAt && "start time",
    !d.online && !d.venue && !d.address && !d.city && "location",
    !d.hosts.length && "host",
    !d.price && "price",
  ].filter(Boolean);
  return missing.length ? `For "${name}", Co does not have: ${missing.join(", ")}.` : null;
}

// avoid and availability (2026-09-22) are loaded by explainFit itself from
// userId, so every search and sweep caller gets them without passing them.
export type PersonForFit = {
  userId?: string;
  firstName: string;
  askText: string | null;
  timeFrame?: string | null;
  goals?: string[] | null;
  city?: string | null;
  // Where this search looked ("San Francisco, California", or several joined
  // with " + "): what they asked about, which can differ from their profile.
  place?: string | null;
  feeling?: string;
  avoid?: string[] | null;
  availability?: string | null;
};

// A personal reason, grounded only in what they've said and the real
// details. Sonnet: it's shown to them and needs judgment.
//
// Fit is judged against what they're asking for now, including a new or
// hypothetical direction (2026-09-15: "accelerators that could help me if I
// decide to build something else" got a pre-seed accelerator called a
// mismatch because the person's current company is Series A).
export function fitPrompt(match: EnrichedMatch, person: PersonForFit, picture: string): string {
  const avoidList = (person.avoid ?? []).filter((a) => a && a.trim());
  const detailLines =
    match.details ? renderEventDetails(match.name, match.details) : match.opportunity ? [`What the post says: ${match.opportunity.postText}`] : [];
  return `Decide whether "${match.name}" fits ${person.firstName}, and explain why in one or two plain sentences, to Co's own notes.

What ${person.firstName} is asking for right now, in their words:
${person.askText ?? "(no specific ask)"}

Background on them:
${picture ? picture : person.goals?.length ? `Goals: ${person.goals.slice(0, 4).join("; ")}` : "(none)"}
${person.city ? `Based in: ${person.city}` : ""}
${person.feeling ? `How they've been feeling: ${person.feeling}` : ""}

What's actually known about "${match.name}":
${detailLines.join("\n") || "(only the name)"}

Rules:
- ${IDENTITY_RULE}
- Two tests, both must pass (Royce, 2026-09-16: "give them things that match their profile"):
  1. It's the kind of thing they're asking for right now. Their ask decides: if they asked for a pottery class, a founder event doesn't fit however good it is for them.
  2. It's worth their time given who they are right now: their work and stage, what they want, what matters to them in people, and what has or hasn't worked before. Something clearly aimed at a different audience or stage (a beginner coding workshop for an experienced technical founder, a job fair for someone not looking) doesn't fit. When the background says nothing either way, this test passes.
- Judge the event by its own main activity. Who attends, hosts, or sponsors never changes what kind of event it is: a chess night full of AI researchers is a chess night, not an AI meetup.
- If they're asking about a new or possible direction ("if I start something new", "if I decide to build something else"), judge it for that new thing. A new company starts from zero, so pre-seed and seed programs fit it. Their current company's stage, funding, or other asks never make it a misfit.
- Say it doesn't fit when it fails either test: the wrong kind of thing, the wrong place or time, or clearly not worth their time for who they are now.
- ${person.timeFrame ? `They asked about ${person.timeFrame}. Something clearly happening outside that time frame doesn't fit, however good it is otherwise.` : "They didn't name a time frame."}
- How they've been feeling never makes something a misfit (2026-09-18): it changes how Co brings it up, not whether they hear about it.
${
    // Only present when there's something to apply (2026-09-22): an
    // always-present "avoided" field made the model mark ordinary matches
    // as avoided (a hackathon fit 1 in 5 times with nothing ruled out,
    // against 3 in 3 before).
    avoidList.length
      ? `- They told Co to stop suggesting these kinds of things: ${avoidList.map((a) => `"${a}"`).join(", ")}. If it is clearly one of those kinds (judged by its main activity, the same way as above), it does not fit, it is not the right kind, and "avoided" is true, however good it is otherwise. Anything else is not avoided.\n`
      : ""
  }${person.availability ? `- When they've said they're usually free: "${person.availability}". Check the day of the week and the time it starts, from the details above, against that. If it's on a day or at a time outside what they said (a Saturday for "weeknights only", a weekday afternoon for "evenings"), it doesn't fit, though it can still be the right kind. When the event's time isn't known, this test passes.\n` : ""}
- Connect a specific thing about them (their ask, or who they are right now) to a specific real detail above. Use only what's written here.

Also say whether it's the right kind of thing for what they asked (test 1 alone), even when it fails on something else like the date or their stage: a founder mixer for someone asking for founder events is the right kind; a funding story for someone asking about hiring is not.

${person.timeFrame ? `Also say whether it clearly happens outside ${person.timeFrame} ("outsideTimeFrame": true), from its own dates above. When its dates aren't known, false.

` : ""}${person.place ? `They're looking in or near ${person.place.split(" + ").join(" or ")}. Also say whether it's clearly somewhere else and not online ("outsidePlace": true), from where it is above. When its place isn't known, false.

` : ""}Return ONLY JSON: {"fits": true or false, "rightKind": true or false,${person.timeFrame ? ' "outsideTimeFrame": true or false,' : ""}${person.place ? ' "outsidePlace": true or false,' : ""}${avoidList.length ? ' "avoided": true or false,' : ""} "why": "the explanation"}`;
}

// What they've ruled out, and when they're usually free, straight from
// their profile (2026-09-22). The latest ask's own availability wins over
// the profile-wide pattern, since it's what they said about this ask.
async function loadFitPreferences(userId: string): Promise<{ avoid: string[]; availability: string | null }> {
  const { rows } = await pool
    .query(`SELECT avoid, availability_pattern, intent FROM co_profiles WHERE user_id = $1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const r = rows[0];
  if (!r) return { avoid: [], availability: null };
  const latest = latestAskEntry(r.intent);
  const availability = (latest?.availability && latest.availability.trim()) || (r.availability_pattern && String(r.availability_pattern).trim()) || null;
  return { avoid: Array.isArray(r.avoid) ? r.avoid.filter((a: unknown) => typeof a === "string" && a.trim()) : [], availability };
}

export async function explainFit(match: EnrichedMatch, person: PersonForFit): Promise<{ fits: boolean; rightKind: boolean; outsideTimeFrame?: boolean; outsidePlace?: boolean; why: string } | null> {
  const picture = person.userId ? renderSnapshot(await getPersonSnapshot(person.userId)) : "";
  if (person.userId && (person.avoid === undefined || person.availability === undefined)) {
    const prefs = await loadFitPreferences(person.userId);
    person = { ...person, avoid: person.avoid ?? prefs.avoid, availability: person.availability ?? prefs.availability };
  }
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "eventDetails.explainFit" },
      prompt: fitPrompt(match, person, picture),
    });
    const p = parseModelJson<{ fits?: boolean; rightKind?: boolean; outsideTimeFrame?: boolean; outsidePlace?: boolean; avoided?: boolean; why?: string }>(text);
    const outsideTimeFrame = !!person.timeFrame && p.outsideTimeFrame === true;
    const outsidePlace = !!person.place && p.outsidePlace === true && !match.online;
    if (typeof p.why !== "string" || !p.why.trim()) return null;
    // Never claim who they are beyond what Co was given about them (services/identityGuard.ts).
    const cleanWhy = stripUngroundedIdentity(p.why, `${picture}\n${person.askText ?? ""}\n${(person.goals ?? []).join(" ")}\n${person.city ?? ""}`);
    if (!cleanWhy) return null;
    p.why = cleanWhy;
    // A kind they ruled out is enforced here, not left to the model's other
    // two answers: it must never fit, and never go out as a "closest thing"
    // stretch either (routes/sendblue.ts sends a rightKind misfit with a
    // caveat when nothing fits).
    if (p.avoided === true && person.avoid?.length) return { fits: false, rightKind: false, why: p.why.trim() };
    // Day and time checked in code (services/availability.ts): a clear
    // conflict is a misfit however the model read it. Still the right kind,
    // so it can go out as a caveated "closest thing" when nothing else fits,
    // and the caveat names the day and time.
    const conflict = availabilityConflict(person.availability, match.details?.startAt ?? null, match.details?.timezone ?? null);
    if (conflict) return { fits: false, rightKind: p.rightKind !== false, outsideTimeFrame, outsidePlace, why: `${p.why.trim()} ${conflict}` };
    // Outside the dates or the place they asked about never fits.
    const fits = p.fits !== false && !outsideTimeFrame && !outsidePlace;
    // Anything that fits is the right kind; a misfit is only the right kind
    // when the model said so outright.
    return { fits, rightKind: fits || p.rightKind === true, outsideTimeFrame, outsidePlace, why: p.why.trim() };
  } catch (err: any) {
    console.error("eventDetails: explainFit failed (non-fatal):", err?.message ?? err);
    return null;
  }
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
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { "User-Agent": "Mozilla/5.0" } });
    return res.url || url;
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
  if (m.kind !== "opportunity" && !m.details && "url" in m && m.url) {
    m.details = (await fetchLumaEventDetails(m.url)) ?? undefined;
  }
  if (m.kind === "opportunity" && !m.opportunity && m.evidence) m.opportunity = { postText: m.evidence };
  // Any event Co surfaces gets its time: an X post with a Luma link reads it from Luma.
  if (!m.details && m.opportunity?.postText) {
    const found = await lumaDetailsFromPost(m.opportunity.postText).catch(() => null);
    if (found) m.details = found.details;
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
