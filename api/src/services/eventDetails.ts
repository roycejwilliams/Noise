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
import { parseModelJson } from "./modelJson.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import { MODELS } from "../models.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { getPersonSnapshot, renderSnapshot } from "../harness/personSnapshot.js";

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

export async function fetchLumaEventDetails(url: string): Promise<EventDetails | null> {
  const key = lumaUrl(url);
  const cached = detailCache.get(key);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.details;
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

export type PersonForFit = { userId?: string; firstName: string; askText: string | null; timeFrame?: string | null; goals?: string[] | null; city?: string | null; feeling?: string };

// A personal reason, grounded only in what they've said and the real
// details. Sonnet: it's shown to them and needs judgment.
//
// Fit is judged against what they're asking for now, including a new or
// hypothetical direction (2026-09-15: "accelerators that could help me if I
// decide to build something else" got a pre-seed accelerator called a
// mismatch because the person's current company is Series A).
export function fitPrompt(match: EnrichedMatch, person: PersonForFit, picture: string): string {
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
- Judge fit against what they're asking for right now. The background is context, not the test.
- Judge the event by its own main activity. Who attends, hosts, or sponsors never changes what kind of event it is: a chess night full of AI researchers is a chess night, not an AI meetup.
- If they're asking about a new or possible direction ("if I start something new", "if I decide to build something else"), judge it for that new thing. A new company starts from zero, so pre-seed and seed programs fit it. Their current company's stage, funding, or other asks never make it a misfit.
- Only say it doesn't fit when it doesn't match what they're asking for right now (wrong kind of thing, wrong place, wrong stage for the thing they're asking about).
- ${person.timeFrame ? `They asked about ${person.timeFrame}. Something clearly happening outside that time frame doesn't fit, however good it is otherwise.` : "They didn't name a time frame."}
- Connect a specific thing they said to a specific real detail above. Use only what's written here.

Return ONLY JSON: {"fits": true or false, "why": "the explanation"}`;
}

export async function explainFit(match: EnrichedMatch, person: PersonForFit): Promise<{ fits: boolean; why: string } | null> {
  const picture = person.userId ? renderSnapshot(await getPersonSnapshot(person.userId)) : "";
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "eventDetails.explainFit" },
      prompt: fitPrompt(match, person, picture),
    });
    const p = parseModelJson<{ fits?: boolean; why?: string }>(text);
    if (typeof p.why !== "string" || !p.why.trim()) return null;
    return { fits: p.fits !== false, why: p.why.trim() };
  } catch (err: any) {
    console.error("eventDetails: explainFit failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// Attach real details (and, with a person, a personal reason) to a match.
// Safe to call on an already-enriched match; fetches only what's missing.
export async function enrichMatch(match: TierMatch | EnrichedMatch, person?: PersonForFit): Promise<EnrichedMatch> {
  const m: EnrichedMatch = { ...match };
  if (m.kind !== "opportunity" && !m.details && "url" in m && m.url) {
    m.details = (await fetchLumaEventDetails(m.url)) ?? undefined;
  }
  if (m.kind === "opportunity" && !m.opportunity && m.evidence) m.opportunity = { postText: m.evidence };
  if (person && !m.whyItFits) {
    const fit = await explainFit(m, person);
    if (fit) {
      m.whyItFits = fit.why;
      m.fits = fit.fits;
    }
  }
  return m;
}
