import pool from "../db/db.js";
import { effectiveEnd } from "../harness/introConsent.js";
import { listCalendarEvents } from "./luma.js";
import { captureIntent } from "./profileExtraction.js";
import { getActiveSeekingAsk } from "./matching.js";
import type { ScorableGuest } from "./eventScoring.js";
import { solicitationKey } from "../agent/eventAskSolicitation.js";

// Day-of QR check-in flow (Royce, 2026-09-10) — a venue QR pre-fills a text
// like "I'm currently at a Co sponsored event — SF Founders Meetup", and
// whoever taps Send is treated as physically present at THAT real Luma
// event, resolved live rather than hardcoded to any one event. Deliberately
// generic: works for any Co-hosted event going forward, not just this one.

const CHECKIN_PHRASE = /\bi'?m\s+(?:currently\s+)?at\s+a\s+(?:co|cue|noise)\s+(?:sponsored\s+)?event\b/i;

// Strip a small set of English stopwords before comparing word sets — "the",
// "a", "at", "for" etc. are noise for matching an event name and would let
// two unrelated events both score a false partial match.
const STOPWORDS = new Set([
  "the", "a", "an", "at", "for", "of", "in", "on", "to", "and", "&", "co", "cue", "noise",
]);

function significantWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w)),
  );
}

// Loose containment score: how much of the CANDIDATE event's own name is
// present in what the person actually sent — not the other way around,
// since the sent text may carry extra words (the fixed check-in phrase
// itself) around the event name, but the event name itself shouldn't be
// half-missing for a real match.
function overlapScore(sentWords: Set<string>, eventWords: Set<string>): number {
  if (!eventWords.size) return 0;
  let hits = 0;
  for (const w of eventWords) if (sentWords.has(w)) hits++;
  return hits / eventWords.size;
}

const MATCH_THRESHOLD = 0.5;

// A check-in only counts for an event that's actually on right now (Layer 6
// consent harness, 2026-09-14): a QR text for an event that ended yesterday
// or starts next week must not put someone into that event's live scoring
// pool, where in-room nudges would name them to strangers.
export const CHECKIN_OPENS_BEFORE_START_MINUTES = 180;

export function isCheckinOpen(event: { start_at: string; end_at?: string | null; timezone?: string | null }, now: Date): boolean {
  const t = now.getTime();
  const start = new Date(event.start_at).getTime();
  if (t < start - CHECKIN_OPENS_BEFORE_START_MINUTES * 60_000) return false;
  // The one end every in-room reader uses (introConsent.effectiveEnd): with no end on file, the end of that evening.
  return t <= new Date(effectiveEnd({ start_at: event.start_at, end_at: event.end_at ?? null, timezone: event.timezone ?? null })).getTime();
}

// Resolves an inbound text to a real, currently-listed Luma event. Returns
// null whenever it isn't confidently a check-in — never forces a false
// positive; the caller falls through to normal conversation handling.
export async function detectCheckinPhrase(
  messageText: string,
): Promise<{ eventApiId: string; eventName: string } | null> {
  if (!CHECKIN_PHRASE.test(messageText)) return null;

  const events = await listCalendarEvents().catch((err: any) => {
    console.error("eventWalkinCheckin: listCalendarEvents failed (non-fatal):", err?.message ?? err);
    return [] as Awaited<ReturnType<typeof listCalendarEvents>>;
  });
  if (!events.length) return null;

  const sentWords = significantWords(messageText);
  const now = new Date();
  const scored = events
    .filter((e) => isCheckinOpen(e, now))
    .map((e) => ({ event: e, score: overlapScore(sentWords, significantWords(e.name)) }))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Ambiguous tie between two current events with similar name overlap —
      // prefer whichever is happening soonest, since that's the one someone
      // physically checking in right now is far more likely to mean.
      return new Date(a.event.start_at).getTime() - new Date(b.event.start_at).getTime();
    });

  if (!scored.length) return null;
  return { eventApiId: scored[0].event.api_id, eventName: scored[0].event.name };
}

// ON CONFLICT DO NOTHING is the whole idempotency guarantee here — a
// double-scan or a resent text must never re-trigger the name/email ask or
// double-insert this person into the event's scoring pool. isNew tells the
// caller whether to proceed with onboarding/the ask question, or just
// re-acknowledge.
export async function recordCheckin(eventApiId: string, personId: string): Promise<{ isNew: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO event_walkin_checkins (event_api_id, person_id)
     VALUES ($1, $2)
     ON CONFLICT (event_api_id, person_id) DO NOTHING
     RETURNING id`,
    [eventApiId, personId],
  );
  return { isNew: rows.length > 0 };
}

// Mirrors matching.ts's getActiveSeekingAsk against this person's real
// co_profiles.intent — reused directly rather than re-implemented so "does
// this person already have an ask" means the exact same thing here as it
// does everywhere else in the scoring pipeline.
export async function hasActiveAsk(personId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [personId]);
  if (!rows.length) return false;
  return getActiveSeekingAsk(rows[0].intent) !== null;
}

// One ask per member per event (decided 2026-10-19 on Royce's delegation, review of #254): the walk-in check-in asks "what are you
// hoping to find here" only when they have no ask and the scoring pass's ask for this event (ask_solicitation) hasn't gone out. When
// it asks, a still-pending ask for this event is dropped, and the event is marked asked (event_ask_solicitations), so the scoring pass
// doesn't queue one after it (eventScoring.ts wasRecentlySolicited).
export type WalkinAskDeps = {
  hasAsk: (personId: string) => Promise<boolean>;
  solicitationSent: (personId: string, key: string) => Promise<boolean>;
  dropPending: (personId: string, key: string) => Promise<void>;
  markAsked: (eventApiId: string, personId: string) => Promise<void>;
};
export const realWalkinAskDeps: WalkinAskDeps = {
  hasAsk: hasActiveAsk,
  solicitationSent: async (personId, key) =>
    (await pool.query(`SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND target_key = $2 AND status = 'sent' LIMIT 1`, [personId, key])).rows.length > 0,
  dropPending: async (personId, key) => {
    await pool.query(
      `UPDATE proactive_candidates SET status = 'skipped', skip_reason = 'asked at the walk-in check-in', decided_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND target_key = $2 AND status = 'pending'`,
      [personId, key],
    );
  },
  markAsked: async (eventApiId, personId) => {
    await pool.query(
      `INSERT INTO event_ask_solicitations (event_id, person_id, solicited_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (event_id, person_id) DO UPDATE SET solicited_at = NOW()`,
      [eventApiId, personId],
    );
  },
};
export async function walkinAskDue(eventName: string, personId: string, deps: WalkinAskDeps = realWalkinAskDeps): Promise<boolean> {
  if (await deps.hasAsk(personId)) return false;
  return !(await deps.solicitationSent(personId, solicitationKey(eventName)));
}
// Pure: whether the reply delivered this turn asked the walk-in question (a delivered text with a question in it). Only then
// is the ask noted (routes/sendblue.ts, after the reply): one that was held, failed or only acknowledged them never counts.
export function walkinAskWentOut(delivered: string[]): boolean {
  return delivered.some((t) => /\?/.test(String(t ?? "")));
}
export async function noteWalkinAsked(eventApiId: string, eventName: string, personId: string, deps: WalkinAskDeps = realWalkinAskDeps): Promise<void> {
  await Promise.all([deps.dropPending(personId, solicitationKey(eventName)), deps.markAsked(eventApiId, personId)]);
}

// Routes the check-in ask through captureIntent (profileExtraction.ts) —
// the same real pipeline every other ask goes through (co_profiles.intent
// upsert, embedding, ask_checkins Stage 5 cadence row, immediate network
// sweep) — rather than writing a second, parallel ask store the rest of the
// scoring pipeline doesn't know about. A one-line synthetic transcript is
// enough since captureIntent's own extraction prompt reads from "user:"
// lines.
export async function recordWalkinAsk(eventApiId: string, personId: string, askText: string): Promise<void> {
  await pool.query(`UPDATE event_walkin_checkins SET ask_text = $1 WHERE event_api_id = $2 AND person_id = $3`, [
    askText,
    eventApiId,
    personId,
  ]);
  await captureIntent(personId, `user: ${askText}`).catch((err: any) =>
    console.error("eventWalkinCheckin: captureIntent failed (non-fatal):", err?.message ?? err),
  );
}

// Same shape matchGuestsToUsers (eventScoring.ts) returns for Luma-sourced
// guests, so the two arrays can be unioned with no further transformation:
// [...lumaMatched, ...walkinMatched]. Deliberately does NOT filter on
// ask_text being present — a walk-in with an existing active ask (Path C:
// already a Co user) never gets ask_text written here at all, since
// recordWalkinAsk is only called when hasActiveAsk was false; either way,
// their real ask lives in co_profiles.intent, which is what scoring reads.
// Who checked in by QR. Not the room by itself: eventScoring.ts inRoomPool keeps only walk-ins Co has seen arrive.
export async function mergeWalkinsIntoGuestPool(eventApiId: string): Promise<ScorableGuest[]> {
  const { rows } = await pool.query(
    `SELECT cp.user_id, u.first_name, u.phone_number, u.email, cp.city, cp.goals, cp.blockers, cp.activity_preferences, cp.intent
     FROM event_walkin_checkins ewc
     JOIN co_profiles cp ON cp.user_id = ewc.person_id
     JOIN users u ON u.id = cp.user_id
     WHERE ewc.event_api_id = $1 AND coalesce(u.sms_opted_out, false) = false AND u.archived_at IS NULL`,
    [eventApiId],
  );
  return rows;
}
