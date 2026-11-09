// The events section of the shared member picture (Cue Memory Spec step 3, 2026-11-06): what a member planned, whether they went, how it
// went, and that they met someone (their side only). Opt-in through memberKnowledge (include: ["events"]); NOT rendered into any prompt
// yet (step 6 does that).
//
// Rules, from Royce:
//   - Attendance only with evidence (never assume attendance, 11-04): a door check-in, an arrival Cue saw, or their own words after the
//     event started. A plan, an offer Cue sent, an "interested" or an "acted" is never attendance.
//   - A plan whose date has passed with no evidence is dropped, never read as attended. Attended events are kept with no window.
//   - Their side only: a quote of theirs, the fact that they met someone, never another member's name. Their words go under `quote`
//     (the picture's one convention). memberKnowledge's final strip exempts the key `quote`, so the name check here is the one in force:
//     guardEvents `named` drops a quote that names a linked member (linked members only; a name the finder doesn't know passes).
//   - A met-someone note is kept as `met` and is never attendance: recordMetSomeone writes to the latest-touched event of the last 48
//     hours, whatever the evidence.
//   - Every value carries its source (table), its date and its provenance (said, seen, did, inferred: services/memberSnapshot.ts Prov).
//   - Rows are guarded like transitions (services/whatCoKnows.ts): a removed event is not returned, forgotten words are cut, and a
//     failed guard read leaves the section empty (decided in memberKnowledge).
//   - Read only, every query bound to $1 = the member. No model call.
import { DateTime } from "luxon";
import type { Fact } from "../memberKnowledge.js";

export const EVENTS_BUDGET_CHARS = 3000;
// An undated plan can't be told to have passed: it stays this many days from when it was said, then it goes.
export const UNDATED_PLAN_DAYS = 30;
export const OUTCOMES_PER_EVENT = 4;
const CLIP = 300;
const DAY = 86_400_000;

export type EventProv = "said" | "seen" | "did" | "inferred";
export type Q = { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> };

export type RawPresence = { eventId: string; arrivedAt: Date | null; arrivedVia: string | null; notGoingAt: Date | null; metAt: Date | null; metQuote: string | null; noshowOutcome: string | null };
// registration: a plan that is a registration Cue submitted for them (services/eventRegistration/followThrough.ts): its status as the
// page said it, and the reason they approved for THAT event only (their own words, or a draft of Cue's they approved), kept apart.
export type PlanRegistration = { status: "registered" | "pending_approval" | "waitlisted"; reason: string | null; reasonSource: "their_words" | "approved_draft" | null };
export type RawPlan = { id: string; name: string; date: string | null; provenance: string | null; quote: string | null; at: Date; registration?: PlanRegistration | null };
export type RawOffer = { eventId: string; name: string; date: string | null; at: Date };
export type RawOutcome = { key: string; name: string; result: string; provenance: string | null; quote: string | null; at: Date };
export type RawFollowThrough = { eventId: string; people: number; at: Date };
export type RawEventInfo = { eventId: string; name: string; startAt: Date | null };
export type RawEvents = { presence: RawPresence[]; plans: RawPlan[]; offers: RawOffer[]; outcomes: RawOutcome[]; followThroughs: RawFollowThrough[]; info: RawEventInfo[] };
export const noEvents = (): RawEvents => ({ presence: [], plans: [], offers: [], outcomes: [], followThroughs: [], info: [] });

export type EventItem = {
  id: string;
  name: string | null;
  date: string | null;
  when: "upcoming" | "passed" | "undated";
  plan: { source: string; on: string; prov: "said" | "inferred"; quote: string | null; registration?: PlanRegistration | null } | null;
  offered: { source: string; on: string; prov: "did" } | null;
  attendance: { source: string; on: string; state: "attended" | "not_going"; via: "door" | "location" | "text" | "said" | null; prov: "said" | "seen"; quote: string | null } | null;
  outcomes: { source: string; on: string; result: string; prov: "said" | "inferred"; quote: string | null }[];
  outcomesOmitted: number;
  met: { source: string; on: string; prov: "said"; quote: string | null } | null;
  followedUp: { source: string; on: string; prov: "did"; people: number } | null;
};

const day = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
};
const localDay = (t: Date, tz?: string | null): string => {
  try {
    return DateTime.fromJSDate(t).setZone(tz || "UTC").toISODate() ?? t.toISOString().slice(0, 10);
  } catch {
    return t.toISOString().slice(0, 10);
  }
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const clip = (s: string | null | undefined) => (s && s.trim() ? s.trim().slice(0, CLIP) : null);
const DID_RESULT = new Set(["helped", "didnt_help"]);

// ---------------------------------------------------------------- the loader (every query takes the member as the bound $1)

export async function loadEvents(userId: string, q: Q): Promise<RawEvents> {
  const [pres, plans, offers, outs, fts] = await Promise.all([
    q.query(
      `SELECT event_api_id, arrived_at, arrived_via, not_going_at, met_someone_at, met_quote, noshow_outcome FROM event_presence
       WHERE user_id = $1 AND (arrived_at IS NOT NULL OR not_going_at IS NOT NULL OR met_someone_at IS NOT NULL OR noshow_outcome IS NOT NULL)`,
      [userId],
    ),
    q.query(`SELECT id, event_name_raw, event_date, provenance, quote, created_at, registration_status, reason, reason_source FROM planned_event_mentions WHERE user_id = $1`, [userId]),
    q.query(
      `SELECT payload->'match'->>'event_api_id' AS event_api_id, payload->'match'->>'name' AS name, payload->'match'->>'event_date' AS event_date, COALESCE(decided_at, updated_at) AS at
       FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND payload->'match'->>'kind' IN ('co_event', 'public_event')`,
      [userId],
    ),
    q.query(`SELECT item_key, item_name, result, provenance, quote, created_at FROM suggestion_outcomes WHERE user_id = $1 AND kind = 'event' AND result <> 'no_signal'`, [userId]),
    q.query(`SELECT event_id, people_count, sent_at FROM event_follow_throughs WHERE user_id = $1`, [userId]),
  ]);
  const ids = [...new Set([...pres.rows.map((r) => String(r.event_api_id)), ...offers.rows.map((r) => r.event_api_id).filter(Boolean).map(String), ...outs.rows.map((r) => String(r.item_key)).filter((k) => k.startsWith("event:")).map((k) => k.slice(6)), ...fts.rows.map((r) => String(r.event_id))])];
  const info: RawEventInfo[] = [];
  if (ids.length) {
    // Names and start times: Luma's snapshot, then the QA events table (may not exist where test numbers are off: that read alone is allowed to fail).
    const [snap, qa] = await Promise.all([
      q.query(`SELECT event_id, name, start_at FROM luma_event_snapshots WHERE event_id = ANY($1::text[])`, [ids]).catch(() => ({ rows: [] as any[] })),
      q.query(`SELECT api_id AS event_id, name, start_at FROM co_test_events WHERE api_id = ANY($1::text[])`, [ids]).catch(() => ({ rows: [] as any[] })),
    ]);
    for (const r of [...snap.rows, ...qa.rows]) info.push({ eventId: String(r.event_id), name: String(r.name ?? ""), startAt: r.start_at ? new Date(r.start_at) : null });
  }
  return {
    presence: pres.rows.map((r) => ({ eventId: String(r.event_api_id), arrivedAt: r.arrived_at ? new Date(r.arrived_at) : null, arrivedVia: r.arrived_via ?? null, notGoingAt: r.not_going_at ? new Date(r.not_going_at) : null, metAt: r.met_someone_at ? new Date(r.met_someone_at) : null, metQuote: r.met_quote ?? null, noshowOutcome: r.noshow_outcome ?? null })),
    plans: plans.rows.map((r) => ({ id: String(r.id), name: String(r.event_name_raw ?? ""), date: day(r.event_date), provenance: r.provenance ?? null, quote: r.quote ?? null, at: new Date(r.created_at), registration: planRegistration(r) })),
    offers: offers.rows.filter((r) => r.event_api_id && r.name).map((r) => ({ eventId: String(r.event_api_id), name: String(r.name), date: r.event_date ? String(r.event_date).slice(0, 10) : null, at: new Date(r.at) })),
    outcomes: outs.rows.map((r) => ({ key: String(r.item_key), name: String(r.item_name ?? ""), result: String(r.result), provenance: r.provenance ?? null, quote: r.quote ?? null, at: new Date(r.created_at) })),
    followThroughs: fts.rows.map((r) => ({ eventId: String(r.event_id), people: Number(r.people_count) || 0, at: new Date(r.sent_at) })),
    info,
  };
}

// ---------------------------------------------------------------- the guard (pure; the live guards come from memberKnowledge)

// named: true when the text names another member (memberKnowledge hands in the linked-name finder). The shared strip keeps a name and
// drops its details; this section must carry no other member's name at all, so words that name one are not carried (the fact that they
// met someone stays), and an event whose own name names one is left out.
export type EventGuards = { g: (text: string) => string | null; gone: (ref: string) => boolean; named?: (text: string) => boolean };

// Drops what they removed and cuts what they forgot, on the raw rows, before anything is built. A removed event goes whole: by its ref,
// or because its name says the removed thing.
// Pure: a plan row's registration, when it is one (a known status only).
export function planRegistration(r: { registration_status?: unknown; reason?: unknown; reason_source?: unknown }): PlanRegistration | null {
  const s = String(r.registration_status ?? "");
  if (s !== "registered" && s !== "pending_approval" && s !== "waitlisted") return null;
  const src = r.reason_source === "their_words" || r.reason_source === "approved_draft" ? r.reason_source : null;
  return { status: s, reason: src && typeof r.reason === "string" && r.reason.trim() ? r.reason : null, reasonSource: src };
}

export function guardEvents(raw: RawEvents, G: EventGuards): RawEvents {
  const nameOk = (n: string) => !!n.trim() && G.g(n) === n && !G.named?.(n);
  const words = (t: string | null) => {
    const w = t ? G.g(t) : null;
    return w && !G.named?.(w) ? w : null;
  };
  const goneId = (id: string) => G.gone(`event:${id}`);
  const names = new Map(raw.info.map((i) => [i.eventId, i.name]));
  const eventOk = (id: string) => !goneId(id) && (!names.get(id) || nameOk(names.get(id)!));
  return {
    info: raw.info.filter((i) => eventOk(i.eventId)),
    presence: raw.presence.filter((p) => eventOk(p.eventId)).map((p) => ({ ...p, metQuote: words(p.metQuote) })),
    plans: raw.plans.filter((p) => !G.gone(`plan:${p.id}`) && !G.gone(`event:${p.id}`) && nameOk(p.name)).map((p) => ({ ...p, quote: words(p.quote), ...(p.registration ? { registration: { ...p.registration, reason: words(p.registration.reason) } } : {}) })),
    offers: raw.offers.filter((o) => eventOk(o.eventId) && nameOk(o.name)),
    outcomes: raw.outcomes.filter((o) => (!o.key.startsWith("event:") || eventOk(o.key.slice(6))) && !G.gone(o.key) && nameOk(o.name)).map((o) => ({ ...o, quote: words(o.quote) })),
    followThroughs: raw.followThroughs.filter((f) => eventOk(f.eventId)),
  };
}

// ---------------------------------------------------------------- the section (pure)

type Draft = { item: Fact<EventItem>; startAt: Date | null; attendedOn: string | null; hasSaid: boolean };

export function eventsOf(raw: RawEvents, o: { now: Date; budget?: number; timeZone?: string | null }): { items: Fact<EventItem>[]; omitted: number } {
  const budget = o.budget ?? EVENTS_BUDGET_CHARS;
  const today = o.now.toISOString().slice(0, 10);
  const info = new Map(raw.info.map((i) => [i.eventId, i]));
  const drafts = new Map<string, Draft>();
  const blank = (id: string, name: string | null, date: string | null, startAt: Date | null): Draft => ({
    startAt,
    attendedOn: null,
    hasSaid: false,
    item: { id, name, date, when: "undated", plan: null, offered: null, attendance: null, outcomes: [], outcomesOmitted: 0, met: null, followedUp: null, verifiedAt: new Date(0).toISOString() },
  });
  const touch = (d: Draft, at: Date | string | null) => {
    const t = at ? new Date(at).toISOString() : null;
    if (t && t > d.item.verifiedAt) d.item.verifiedAt = t;
  };
  const get = (id: string, name?: string | null, date?: string | null): Draft => {
    let d = drafts.get(id);
    if (!d) {
      const i = info.get(id);
      d = blank(id, i?.name || name || null, day(i?.startAt) ?? date ?? null, i?.startAt ?? null);
      drafts.set(id, d);
    }
    if (!d.item.name && name) d.item.name = name;
    if (!d.item.date && date) d.item.date = date;
    return d;
  };

  // Door, location and text arrivals, a "no", and a met-someone note in their own words (only when it came after the event started).
  for (const p of raw.presence) {
    const d = get(p.eventId);
    const via = p.arrivedVia === "door" || p.arrivedVia === "location" || p.arrivedVia === "text" ? p.arrivedVia : null;
    if (p.arrivedAt) {
      d.item.attendance = { source: "event_presence", on: p.arrivedAt.toISOString(), state: "attended", via, prov: via === "text" ? "said" : "seen", quote: null };
      d.attendedOn = p.arrivedAt.toISOString();
      touch(d, p.arrivedAt);
    } else if (/^came\b/.test(p.noshowOutcome ?? "")) {
      // The no-show flow settles "came" only on evidence (services/eventNoShow.ts verdict).
      // Dated by the event itself (its start, else its day): never by when this was read.
      const when = d.startAt ?? (d.item.date ? new Date(`${d.item.date}T00:00:00Z`) : null);
      if (when) {
        d.item.attendance = { source: "event_presence", on: when.toISOString(), state: "attended", via: null, prov: "seen", quote: null };
        d.attendedOn = d.item.attendance.on;
        touch(d, when);
      }
    } else if (p.notGoingAt) {
      d.item.attendance = { source: "event_presence", on: p.notGoingAt.toISOString(), state: "not_going", via: null, prov: "said", quote: null };
      touch(d, p.notGoingAt);
    }
    // A met note counts only when it was said after the event started, or there is an arrival: recordMetSomeone writes to the latest
    // event of the last 48 hours, so a note from the day before ("met a designer at the gym") must not attach to this one.
    if (p.metAt && (p.arrivedAt || (d.startAt && p.metAt.getTime() >= d.startAt.getTime()))) {
      d.item.met = { source: "event_presence", on: p.metAt.toISOString(), prov: "said", quote: clip(p.metQuote) };
      d.hasSaid = true;
      touch(d, p.metAt);
    }
  }
  for (const f of raw.followThroughs) {
    const d = get(f.eventId);
    d.item.followedUp = { source: "event_follow_throughs", on: f.at.toISOString(), prov: "did", people: f.people };
    touch(d, f.at);
  }
  for (const of of raw.offers) {
    const d = get(of.eventId, of.name, of.date);
    d.item.offered = { source: "proactive_candidates", on: of.at.toISOString(), prov: "did" };
    touch(d, of.at);
  }
  // Outcomes: their result and their words. A went / didn't-help result they stated, after the event started, is attendance in their words.
  const standalone: Draft[] = [];
  for (const r of raw.outcomes) {
    const id = r.key.startsWith("event:") ? r.key.slice(6) : null;
    const d = id ? get(id, r.name) : (() => { const x = blank(r.key, r.name, null, null); standalone.push(x); return x; })();
    const stated = r.provenance === "stated";
    d.item.outcomes.push({ source: "suggestion_outcomes", on: r.at.toISOString(), result: r.result, prov: stated ? "said" : "inferred", quote: clip(r.quote) });
    touch(d, r.at);
    if (stated) d.hasSaid = true;
    // After the event started: against a real start time, else only on a strictly later day in the member's own zone (a statement on the
    // evening before reads as the next UTC day for someone in Pacific time).
    const after = d.startAt ? r.at.getTime() >= d.startAt.getTime() : d.item.date ? localDay(r.at, o.timeZone) > d.item.date : false;
    if (stated && DID_RESULT.has(r.result) && after && !d.attendedOn) {
      d.item.attendance = { source: "suggestion_outcomes", on: r.at.toISOString(), state: "attended", via: "said", prov: "said", quote: clip(r.quote) };
      d.attendedOn = r.at.toISOString();
    }
  }
  // Plans: merged into an event Cue knows by exact name (and a date that doesn't disagree), else standing alone.
  const byName = new Map<string, Draft[]>();
  for (const d of [...drafts.values()]) if (d.item.name) byName.set(norm(d.item.name), [...(byName.get(norm(d.item.name)) ?? []), d]);
  for (const p of raw.plans) {
    if (!p.name.trim()) continue;
    const same = (byName.get(norm(p.name)) ?? []).find((d) => !p.date || !d.item.date || p.date === d.item.date);
    const d = same ?? (() => { const x = blank(`plan:${p.id}`, p.name.trim(), p.date, null); standalone.push(x); return x; })();
    if (same && !d.item.date && p.date) d.item.date = p.date;
    const stated = p.provenance === "stated";
    // A registration is a plan, never attendance: its status rides on the plan, and only evidence below ever makes it "attended".
    d.item.plan = { source: "planned_event_mentions", on: p.at.toISOString(), prov: stated ? "said" : "inferred", quote: clip(p.quote), ...(p.registration ? { registration: { ...p.registration, reason: clip(p.registration.reason) } } : {}) };
    if (stated) d.hasSaid = true;
    touch(d, p.at);
  }

  const all = [...drafts.values(), ...standalone];
  const kept = all.flatMap((d) => {
    const it = d.item;
    const dateKnown = d.startAt ? d.startAt.toISOString().slice(0, 10) : it.date;
    const att = it.attendance?.state === "attended";
    if (dateKnown) it.date = dateKnown;
    const upcoming = !!dateKnown && dateKnown >= today;
    it.when = !dateKnown ? "undated" : upcoming ? "upcoming" : "passed";
    if (att) return [d];
    if (it.when === "upcoming") return [d];
    if (it.when === "passed") {
      // Passed with no evidence they went: a plan or an offer alone drops. What they said about it (a no, an outcome, a met note) stays.
      return it.attendance || it.outcomes.length || it.met ? [d] : [];
    }
    // Undated: kept only while it is fresh, or when they said something about it.
    const fresh = [it.plan?.on, it.offered?.on, ...it.outcomes.map((x) => x.on)].some((t) => t && o.now.getTime() - new Date(t).getTime() <= UNDATED_PLAN_DAYS * DAY);
    return fresh || it.attendance ? [d] : [];
  });

  const rank = (d: Draft) => (d.item.attendance?.state === "attended" ? 1 : d.item.when === "upcoming" || d.item.when === "undated" ? 0 : 2);
  kept.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (a.item.date ?? "9999").localeCompare(b.item.date ?? "9999") || b.item.verifiedAt.localeCompare(a.item.verifiedAt); // soonest first, undated last
    return (b.attendedOn ?? b.item.date ?? b.item.verifiedAt).localeCompare(a.attendedOn ?? a.item.date ?? a.item.verifiedAt); // newest first
  });

  const out: Fact<EventItem>[] = [];
  let used = 0;
  for (const { item } of kept) {
    item.outcomes.sort((a, b) => b.on.localeCompare(a.on));
    item.outcomesOmitted = Math.max(0, item.outcomes.length - OUTCOMES_PER_EVENT);
    item.outcomes = item.outcomes.slice(0, OUTCOMES_PER_EVENT);
    const size = JSON.stringify(item).length;
    if (used + size > budget) continue;
    out.push(item);
    used += size;
  }
  return { items: out, omitted: kept.length - out.length };
}
