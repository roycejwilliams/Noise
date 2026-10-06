// The member brief (Royce, 2026-10-05, November event set, item 1). The day before a Co event, each confirmed
// member gets one short message: how many are coming, the two or three people Co thinks they should find, and
// one line on why for each.
//
// Naming is the rule that matters. A guest is named in anyone's brief only when THEY said yes to it, at the
// moment they confirmed going: "Can Co mention you by name in the member brief?" No answer means no name.
// And the reason shown is only what that person said they're looking for, the same line the in-room nudge may
// show (harness/matchGate.ts gateShareReason). Everyone else who fits is a count, never a name
// (services/preArrival.ts keeps its own never-who rule: the pre-arrival text still names no one).
//
// Built on what already exists: the event's guest rankings (services/eventScoring.ts, stored on every scoring
// pass), the registered members (services/eventPresence.ts eventMembers) and the daily pick (harness/proactive.ts).
// Nothing new is asked of a member except that one question.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import type { RankedCandidate } from "./eventScoring.js";

export const BRIEF = {
  // Opens at 9 in the morning, local, the day before; closes 6 hours before the start (the pre-arrival text
  // follows at 3 hours, so the two never land together).
  openLocalHour: 9,
  closeBeforeStartMs: 6 * 3_600_000,
  maxNamed: 3,
  // The same bar the in-room nudge uses for a strong match (eventScoring MATCH_NUDGE_MIN_SCORE).
  minScore: 60,
  minCountToMention: 2,
  maxBubbles: 4,
  // The question goes out once someone is registered and the brief is still ahead of them.
  askUntilBeforeStartMs: 6 * 3_600_000,
};

export const NAME_QUESTION = "Can Co mention you by name in the member brief?";

// ---------------------------------------------------------------- rules (pure)

export function briefWindow(startAt: string, zone: string | null): { from: Date; until: Date } | null {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const start = DateTime.fromISO(startAt, { zone: z });
  if (!start.isValid) return null;
  const from = start.minus({ days: 1 }).set({ hour: BRIEF.openLocalHour, minute: 0, second: 0, millisecond: 0 });
  const until = start.minus({ milliseconds: BRIEF.closeBeforeStartMs });
  if (until <= from) return null;
  return { from: from.toJSDate(), until: until.toJSDate() };
}

// Who gets it: registered, hasn't said they can't make it, not sent already, event still listed.
export function briefEligible(p: { registered: boolean; notGoing: boolean; alreadySent: boolean; eventListed: boolean }): { ok: boolean; why: string | null } {
  if (!p.eventListed) return { ok: false, why: "the event is no longer on the calendar" };
  if (!p.registered) return { ok: false, why: "not registered" };
  if (p.notGoing) return { ok: false, why: "said they can't make it" };
  if (p.alreadySent) return { ok: false, why: "already sent for this event" };
  return { ok: true, why: null };
}

// The question at RSVP: once, to a registered member who hasn't been asked, while a brief is still ahead of them.
export function nameAskDue(p: { registered: boolean; notGoing: boolean; alreadyAsked: boolean; startAt: string; now: Date }): boolean {
  if (!p.registered || p.notGoing || p.alreadyAsked) return false;
  return new Date(p.startAt).getTime() - p.now.getTime() > BRIEF.askUntilBeforeStartMs;
}

export function nameAskMessages(eventName: string): string[] {
  return [`You're on the list for ${eventName}.`, `One question: ${NAME_QUESTION.replace("Can Co mention you", "can I mention you")} Yes or no. If I don't hear, I won't.`];
}

// Their answer, from their own words in this message: a short yes or no is enough. Anything else is no answer.
const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|definitely|absolutely|that'?s fine|fine by me|you can|yes please)\b/i;
const NO = /^(?:no|nope|nah|please don'?t|don'?t|rather not|i'?d rather not|not really|no thanks)\b/i;
export function readNameAnswer(quote: unknown, message: string): "yes" | "no" | null {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(quote);
  if (q.length < 2 || !norm(message).includes(q)) return null;
  if (NO.test(q)) return "no";
  if (YES.test(q) && !/\b(no|not|don'?t|never)\b/.test(q)) return "yes";
  return null;
}

export type Pick = { id: string; firstName: string; reason: string; score: number };

// The people who may be named in this member's brief. Only guests who said yes, still going, strong enough, with a
// reason in their own words, never the recipient, and never a first name two guests share (a name that could mean
// someone who didn't say yes).
export function pickNamed(p: {
  ranked: RankedCandidate[];
  recipientId: string;
  members: { user_id: string; first_name: string }[];
  nameOk: Set<string>;
  notGoing: Set<string>;
}): { picks: Pick[]; unnamedFits: number } {
  const byId = new Map(p.members.map((m) => [m.user_id, m]));
  const firstCount = new Map<string, number>();
  for (const m of p.members) firstCount.set(m.first_name.trim().toLowerCase(), (firstCount.get(m.first_name.trim().toLowerCase()) ?? 0) + 1);
  const picks: Pick[] = [];
  let unnamedFits = 0;
  for (const r of [...p.ranked].sort((a, b) => b.score - a.score)) {
    if (r.candidate_id === p.recipientId || p.notGoing.has(r.candidate_id)) continue;
    const m = byId.get(r.candidate_id);
    if (!m || r.score < BRIEF.minScore || !r.shareReason?.trim()) continue;
    const named = p.nameOk.has(r.candidate_id) && (firstCount.get(m.first_name.trim().toLowerCase()) ?? 0) === 1 && m.first_name.trim().length >= 2;
    if (named && picks.length < BRIEF.maxNamed) picks.push({ id: m.user_id, firstName: m.first_name.trim(), reason: r.shareReason.trim(), score: r.score });
    else unnamedFits++;
  }
  return { picks, unnamedFits };
}

// Worth sending at all: someone to name, or a few who fit. Otherwise the pre-arrival text covers the evening.
export function worthSending(picks: Pick[], unnamedFits: number): boolean {
  return picks.length > 0 || unnamedFits >= BRIEF.minCountToMention;
}

// No guest who didn't say yes is named; every one who did may be.
export function namesOutsiders(text: string, members: { user_id: string; first_name: string }[], allowedIds: Set<string>, recipientId: string): string | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, " ")} `;
  const allowed = new Set(members.filter((m) => allowedIds.has(m.user_id)).map((m) => m.first_name.trim().toLowerCase()));
  for (const m of members) {
    if (m.user_id === recipientId) continue;
    const n = m.first_name.trim().toLowerCase();
    if (n.length < 3 || allowed.has(n)) continue;
    if (t.includes(` ${n} `)) return m.first_name;
  }
  return null;
}

// The brief is a few short bubbles, split on blank lines.
export function briefBubbles(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- data

export async function presenceFlags(eventId: string, userId: string): Promise<{ asked: boolean; nameOk: boolean | null; briefSent: boolean; notGoing: boolean }> {
  const { rows } = await pool
    .query(`SELECT name_asked_at, name_ok, brief_sent_at, not_going_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2`, [eventId, userId])
    .catch(() => ({ rows: [] as any[] }));
  const r = rows[0];
  return { asked: !!r?.name_asked_at, nameOk: r?.name_ok ?? null, briefSent: !!r?.brief_sent_at, notGoing: !!r?.not_going_at };
}

// Who said yes to being named at this event. Only an explicit yes counts: no row, no answer and "no" are all no.
export async function namedYes(eventId: string, userIds: string[]): Promise<{ yes: Set<string>; notGoing: Set<string> }> {
  if (!userIds.length) return { yes: new Set(), notGoing: new Set() };
  const { rows } = await pool
    .query(`SELECT user_id, name_ok, not_going_at FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [eventId, userIds])
    .catch(() => ({ rows: [] as any[] }));
  return { yes: new Set(rows.filter((r: any) => r.name_ok === true).map((r: any) => String(r.user_id))), notGoing: new Set(rows.filter((r: any) => r.not_going_at).map((r: any) => String(r.user_id))) };
}

export async function rankingFor(eventId: string, personId: string): Promise<RankedCandidate[]> {
  const { rows } = await pool.query(`SELECT ranked_candidates FROM event_guest_rankings WHERE event_id = $1 AND person_id = $2`, [eventId, personId]).catch(() => ({ rows: [] as any[] }));
  return Array.isArray(rows[0]?.ranked_candidates) ? rows[0].ranked_candidates : [];
}

// Their answer to the question, for the event they were most recently asked about (an upcoming one).
export async function recordNameAnswer(userId: string, answer: "yes" | "no", quote: string): Promise<{ eventApiId: string } | null> {
  const { rows } = await pool
    .query(`SELECT event_api_id FROM event_presence WHERE user_id = $1 AND name_asked_at IS NOT NULL AND brief_sent_at IS NULL ORDER BY name_asked_at DESC LIMIT 1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const eventApiId = rows[0]?.event_api_id as string | undefined;
  if (!eventApiId) return null;
  await pool.query(`UPDATE event_presence SET name_ok = $3, name_ok_at = NOW(), name_ok_quote = $4 WHERE event_api_id = $1 AND user_id = $2`, [eventApiId, userId, answer === "yes", quote.slice(0, 200)]);
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 6, decision: "event.brief_name", userId, outcome: "act", action: answer, proposal: { eventId: eventApiId } }).catch(() => {});
  return { eventApiId };
}

export async function recordBriefSent(eventId: string, userId: string, namedIds: string[], confirmed: number): Promise<void> {
  await pool.query(
    `INSERT INTO event_presence (event_api_id, user_id, brief_sent_at) VALUES ($1, $2, NOW())
     ON CONFLICT (event_api_id, user_id) DO UPDATE SET brief_sent_at = NOW()`,
    [eventId, userId],
  );
  await pool.query(`INSERT INTO event_briefs (event_id, person_id, named_ids, confirmed_count) VALUES ($1, $2, $3::jsonb, $4)`, [eventId, userId, JSON.stringify(namedIds), confirmed]);
}

// ---------------------------------------------------------------- queueing

export async function runEventBriefs(now = new Date()): Promise<{ asks: number; briefs: number }> {
  const { presenceEvents, eventMembers } = await import("./eventPresence.js");
  const { enqueueCandidate } = await import("../harness/proactive.js");
  let asks = 0;
  let briefs = 0;
  for (const event of await presenceEvents()) {
    if (new Date(event.start_at).getTime() <= now.getTime()) continue;
    const members = await eventMembers(event.api_id);
    if (!members.length) continue;
    const w = briefWindow(event.start_at, event.timezone ?? null);
    for (const m of members) {
      const f = await presenceFlags(event.api_id, m.user_id);
      // The question, at RSVP.
      if (nameAskDue({ registered: true, notGoing: f.notGoing, alreadyAsked: f.asked, startAt: event.start_at, now })) {
        const r = await enqueueCandidate({
          userId: m.user_id,
          type: "brief_name_ask",
          targetKey: `brief_name_ask:${event.api_id}`,
          topicKey: `event:${event.api_id}`,
          summary: `They're on the list for "${event.name}": ask once if Co may name them in the member brief`,
          payload: { eventId: event.api_id, name: event.name, startAt: event.start_at },
          dueAt: now,
          expiresAt: new Date(new Date(event.start_at).getTime() - BRIEF.askUntilBeforeStartMs),
        }).catch(() => ({ queued: false }));
        if (r.queued) asks++;
      }
      // The brief, the day before.
      if (!w || now < w.from || now > w.until) continue;
      if (!briefEligible({ registered: true, notGoing: f.notGoing, alreadySent: f.briefSent, eventListed: true }).ok) continue;
      const r = await enqueueCandidate({
        userId: m.user_id,
        type: "event_brief",
        targetKey: `event_brief:${event.api_id}`,
        topicKey: `event:${event.api_id}`,
        summary: `The day before "${event.name}": who's coming and the few worth finding`,
        payload: { eventId: event.api_id, name: event.name, startAt: event.start_at, timezone: event.timezone ?? null, venue: event.venue ?? null, until: w.until.toISOString() },
        dueAt: now,
        expiresAt: w.until,
      }).catch(() => ({ queued: false }));
      if (r.queued) briefs++;
    }
  }
  return { asks, briefs };
}
