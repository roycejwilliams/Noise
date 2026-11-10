// Telling a member their search didn't go through (Royce approved, 2026-11-09). The sweep fix in #429 keeps "search failed" apart from
// "nothing found" and flags an ask or goal that failed SWEEP_FAILING_DAYS days in a row (sweep.failing_again, services/dailySweep.ts).
// When what failed is something the member explicitly asked Cue to look for (their own ask, an ask_checkins row: never a goal, which is
// Cue's background work for them), they'd be expecting a result: Cue tells them, once per failure streak.
//
// The approved meaning (Royce): "I tried to look for {what they asked} this morning and my search didn't go through. I'll try again
// tomorrow." Cue gets those facts and says it in its own words (the 2026-11-06 rule for small system lines): no fixed sentence.
//
// The path: a proactive candidate (search_failed, class "checkin"), so the quiet hours, caps, spacing, the safety hold and the member's
// own rules apply as to any text Cue starts, and the send-time read (harness/momentFit.ts) judges whether it belongs now, told of a hard
// stretch when there is one. Once per streak: its key is the ask and the streak's first day (search_failed:<askId>:<firstDay>); a sent,
// dropped or expired one is never queued again (enqueueCandidate), and a later streak starts on a new day, with a new key. Good until
// the end of their day ("this morning", "tomorrow" stay true). Re-read when it's drafted: the ask closed, or a later search of it went
// through, means nothing goes.
// Ids and kinds only in the summary and the logs; the ask's words ride in the payload, as every ask's own check-in does.
import { DateTime } from "luxon";
import type { EnqueueInput } from "../harness/proactive.js";
import { hoursZone, REASONABLE_HOUR_END } from "./localHours.js";

export const SEARCH_FAILED_KEY = "search_failed:";
// Team-facing (the pick and the decision log read it; never sent).
export const SEARCH_FAILED_SUMMARY = "Tell them a search they asked for didn't go through this morning";
// What the draft is told to do: the approved meaning, in Cue's own words.
export const SEARCH_FAILED_TASK =
  "Tell them plainly, in one or two short sentences, that you tried to look for what they asked for this morning and your search didn't go through (a problem on your side, not an empty result), and that you'll try again tomorrow. Name what they asked for in their terms. Never say nothing was found, never give technical detail, no long apology, no question, no offer.";
export const SEARCH_FAILED_RULES = { maxSentences: 2, maxChars: 240, allowUrl: false } as const;

export type FailingItem = { kind: "ask" | "goal"; id: string; text: string; days: number };

// Pure: the streak's first day, from the day it was flagged and how many days in a row it has failed.
export function streakStart(day: string, days: number): string {
  return DateTime.fromISO(day).minus({ days: Math.max(0, days - 1) }).toISODate()!;
}

// Pure: the end of their day on `day` (the hour waking hours end, their zone).
export function endOfTheirDay(day: string, zone: string | null | undefined): Date {
  return DateTime.fromISO(day, { zone: hoursZone(zone) }).set({ hour: REASONABLE_HOUR_END, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

// Pure: the notices for a day's repeated failures. Only their own asks (kind "ask"), never a goal; each keyed by its streak.
// failedMin: how many days in a row before it counts (dailySweep.ts SWEEP_FAILING_DAYS).
export function searchFailedNotices(o: { userId: string; day: string; zone: string | null; items: FailingItem[]; failedMin: number; now: Date }): EnqueueInput[] {
  const expiresAt = endOfTheirDay(o.day, o.zone);
  if (expiresAt.getTime() <= o.now.getTime()) return [];
  return o.items
    .filter((i) => i.kind === "ask" && i.days >= o.failedMin && i.id)
    .map((i) => ({
      userId: o.userId,
      type: "search_failed" as const,
      targetKey: `${SEARCH_FAILED_KEY}${i.id}:${streakStart(o.day, i.days)}`,
      summary: SEARCH_FAILED_SUMMARY,
      payload: { askCheckinId: i.id, askText: i.text, day: o.day, streakStart: streakStart(o.day, i.days), days: i.days },
      dueAt: o.now,
      expiresAt,
    }));
}

// Pure: whether a notice still holds when it's drafted. ask: the ask's row now (null: gone); lastStatus: that ask's status on its
// latest 9am-sweep record (a later retry or day that searched it ends the streak).
export function stillFailed(ask: { resolved_at: unknown; kind: string | null } | null, lastStatus: string | null): { ok: true } | { ok: false; why: string } {
  if (!ask) return { ok: false, why: "the ask is gone" };
  if (ask.resolved_at) return { ok: false, why: "the ask is closed" };
  if (ask.kind && ask.kind !== "find") return { ok: false, why: "the ask is no longer searched" };
  if (lastStatus !== "error") return { ok: false, why: `a later search of it ${lastStatus ? `ended ${lastStatus}` : "isn't on record"}, not failed` };
  return { ok: true };
}

// The facts the draft states (CONFIRMED_FACTS), and nothing else.
export function searchFailedFacts(p: { askText: string }): Record<string, string> {
  return {
    what_they_asked_you_to_look_for: p.askText,
    what_happened: "your search for it this morning didn't go through: it failed on your side, it did not come back empty",
    what_happens_next: "you'll try the search again tomorrow morning",
  };
}

// The send-time re-read: the ask's row and its latest 9am-sweep status. Failed reads: nothing goes (never a stale notice).
export async function readStillFailed(userId: string, askId: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const { default: pool } = await import("../db/db.js");
  const [ask] = (await pool.query(`SELECT resolved_at, kind FROM ask_checkins WHERE id::text = $1 AND user_id = $2`, [askId, userId])).rows;
  const { rows } = await pool.query(
    `SELECT proposal->'items' AS items FROM harness_decisions
      WHERE decision = 'sweep.daily' AND user_id = $1 AND COALESCE(proposal->>'trigger', '') <> 'manual' AND created_at > NOW() - INTERVAL '3 days'
      ORDER BY created_at DESC LIMIT 6`,
    [userId],
  );
  let last: string | null = null;
  for (const r of rows) {
    const hit = (Array.isArray(r.items) ? r.items : []).find((i: any) => i?.kind === "ask" && String(i?.id) === askId);
    if (hit) { last = String(hit.status ?? ""); break; }
  }
  return stillFailed(ask ?? null, last);
}
