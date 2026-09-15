import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";
import { getTimezoneForCity } from "./geocoding.js";
import { enqueueCandidate, nextLocalHour } from "../harness/proactive.js";

// Outcome-learning loop (Royce, 2026-09-02: "Co follows up" + the shared
// "named someone?" classifier + wiring signal weighting into future
// matching — Notion V1 board rows 7/12/13, confirmed fully unbuilt before
// this). Tier 1/2 only — a Tier 3 opportunity (accelerator, fellowship) has
// no attendees to "meet," so "who did you meet?" doesn't apply to it.
//
// Same due-timestamp + nullable claim column + partial index convention as
// post_call_follow_ups (jobs/postCallFollowUp.ts) — see migrations.ts's
// recommendation_outcome_followups table. The outcome itself is written as
// a co_memories row ('recommendation_outcome'), not a new table — that's
// exactly what co_memories already exists for (event_offer_pending/
// event_offer_resolved/recap all follow this same shape).
export async function scheduleOutcomeFollowUp(userId: string, askText: string, match: TierMatch): Promise<void> {
  if (!("event_date" in match) || !match.event_date) return; // Tier 3 has no event_date — nothing to schedule

  try {
    await pool.query(
      // One follow-up per recommended event, however many times it got
      // recommended (2026-09-14: the same event produced two follow-ups
      // sent 2 seconds apart).
      `INSERT INTO recommendation_outcome_followups (user_id, ask_text, tier, match_name, match, send_at)
       SELECT $1::uuid, $2::text, $3::int, $4::text, $5::jsonb, ($6::date + INTERVAL '1 day 11 hours')
       WHERE NOT EXISTS (
         SELECT 1 FROM recommendation_outcome_followups
         WHERE user_id = $1 AND (
           (match ->> 'event_api_id') = ($5::jsonb ->> 'event_api_id')
           OR lower(match_name) = lower($4)
         )
       )`,
      [userId, askText, match.tier, match.name, JSON.stringify(match), match.event_date],
    );
  } catch (err: any) {
    console.error("scheduleOutcomeFollowUp: insert failed (non-fatal):", err?.message ?? err);
  }
}

// Same expiry reasoning as sendblue.ts's EVENT_OFFER_EXPIRY_DAYS — a reply
// classifier shouldn't be trying to resolve a "who did you meet?" follow-up
// from weeks ago against unrelated later conversation.
const OUTCOME_FOLLOWUP_EXPIRY_DAYS = 7;

export type PendingOutcomeFollowUp = {
  id: string;
  tier: number;
  match_name: string;
  ask_text: string;
};

// Mirrors sendblue.ts's pendingEventOffer lookup shape exactly (same
// created_at-cutoff + NOT EXISTS resolved-row pattern), scoped to this
// feature's own table instead of co_memories.
export async function findPendingOutcomeFollowUp(userId: string): Promise<PendingOutcomeFollowUp | null> {
  const { rows } = await pool.query(
    `SELECT id, tier, match_name, ask_text FROM recommendation_outcome_followups
     WHERE user_id = $1 AND sent_at IS NOT NULL
       AND sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM co_memories r
         WHERE r.user_id = $1 AND r.memory_type = 'recommendation_outcome'
           AND (r.content::jsonb ->> 'followupId') = recommendation_outcome_followups.id::text
       )
     ORDER BY sent_at DESC LIMIT 1`,
    [userId, OUTCOME_FOLLOWUP_EXPIRY_DAYS],
  );
  return rows[0] ?? null;
}

export type NamedOutcome = "named_positive" | "named_critical" | "not_mentioned" | "unrelated";

export async function recordOutcome(userId: string, followupId: string, tier: number, outcome: NamedOutcome): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation_outcome', $2)`, [
      userId,
      JSON.stringify({ followupId, tier, outcome }),
    ])
    .catch((err: any) => console.error("recordOutcome: memory write failed (non-fatal):", err?.message ?? err));
}

// Tier-weighting loop-back (Notion board row 12, "wire signal weighting into
// the standing profile") — TierMatch carries no per-person identity (see
// this session's research), so "reinforce/deprioritize" is scoped to which
// TIER tends to land for this person, matching the diamond's own "not
// mentioned -> adjusts tier weighting" language. Net positive-minus-critical
// per tier; a user with no history gets all zeros, which keeps
// eventSurfacingSweep.ts's sort behaving exactly as it does today (tier-
// number order) until real signal exists.
export async function getTierBias(userId: string): Promise<Record<number, number>> {
  const bias: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT content::jsonb ->> 'tier' AS tier, content::jsonb ->> 'outcome' AS outcome
       FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation_outcome'`,
      [userId],
    );
    for (const row of rows) {
      const tier = Number(row.tier);
      if (!(tier in bias)) continue;
      if (row.outcome === "named_positive") bias[tier] += 1;
      else if (row.outcome === "named_critical") bias[tier] -= 1;
    }
  } catch (err: any) {
    console.error("getTierBias: query failed (non-fatal, no bias applied):", err?.message ?? err);
  }
  return bias;
}

// Layer 7 (2026-09-14): no longer sends. Each due follow-up becomes part of
// one "debrief" candidate per event (merged with the end-of-night check-in
// from eventCheckinFollowUp.ts and the walk-in call offer), due the morning
// after at 10am their time. Live before this: three follow-ups all at 4am
// Pacific, one a duplicate two seconds after the other.
export async function enqueueDueOutcomeFollowUps(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT rof.id, rof.user_id, rof.ask_text, rof.match_name, rof.match, cp.city
     FROM recommendation_outcome_followups rof
     JOIN users u ON u.id = rof.user_id
     LEFT JOIN co_profiles cp ON cp.user_id = rof.user_id
     WHERE rof.sent_at IS NULL AND rof.harness_status IS NULL AND u.sms_opted_out = false
       AND rof.send_at <= NOW() + INTERVAL '2 days'
     LIMIT 50`,
  );
  for (const row of rows) {
    const match = row.match ?? {};
    const eventDate: string | undefined = match.event_date;
    if (!eventDate) {
      await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped' WHERE id = $1`, [row.id]);
      continue;
    }
    const timezone = row.city ? await getTimezoneForCity(row.city).catch(() => null) : null;
    await enqueueDebrief({
      userId: row.user_id,
      eventApiId: match.event_api_id ?? null,
      eventName: row.match_name,
      eventEnd: endOfLocalDay(eventDate, timezone),
      timezone,
      part: { outcomeFollowupIds: [row.id], askText: row.ask_text },
    });
    await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'queued' WHERE id = $1`, [row.id]);
  }
}

function endOfLocalDay(isoDate: string, timezone: string | null): Date {
  const d = DateTime.fromISO(isoDate, { zone: timezone ?? "America/Los_Angeles" });
  return (d.isValid ? d.endOf("day") : DateTime.fromISO(isoDate).endOf("day")).toJSDate();
}

export type DebriefPayload = {
  eventApiId: string | null;
  eventName: string;
  outcomeFollowupIds: string[];
  checkinFollowupIds: string[];
  walkinCheckinIds: string[];
  askText: string | null;
};

// Shared by the three debrief sources. One candidate per (person, event).
export async function enqueueDebrief(opts: {
  userId: string;
  eventApiId: string | null;
  eventName: string;
  eventEnd: Date;
  timezone: string | null;
  part: Partial<Pick<DebriefPayload, "outcomeFollowupIds" | "checkinFollowupIds" | "walkinCheckinIds" | "askText">>;
}): Promise<void> {
  const payload: DebriefPayload = {
    eventApiId: opts.eventApiId,
    eventName: opts.eventName,
    outcomeFollowupIds: opts.part.outcomeFollowupIds ?? [],
    checkinFollowupIds: opts.part.checkinFollowupIds ?? [],
    walkinCheckinIds: opts.part.walkinCheckinIds ?? [],
    askText: opts.part.askText ?? null,
  };
  const dueAt = nextLocalHour(opts.eventEnd, opts.timezone, 10);
  await enqueueCandidate({
    userId: opts.userId,
    type: "debrief",
    targetKey: `debrief:${opts.eventApiId ?? opts.eventName.toLowerCase()}`,
    summary: `Morning-after "how was ${opts.eventName}?" (one text covering who they met there)`,
    payload,
    dueAt,
    expiresAt: new Date(dueAt.getTime() + 3 * 24 * 60 * 60 * 1000),
    merge: (existing: DebriefPayload, incoming: DebriefPayload) => ({
      ...existing,
      eventName: existing.eventName || incoming.eventName,
      askText: existing.askText ?? incoming.askText,
      outcomeFollowupIds: Array.from(new Set([...(existing.outcomeFollowupIds ?? []), ...incoming.outcomeFollowupIds])),
      checkinFollowupIds: Array.from(new Set([...(existing.checkinFollowupIds ?? []), ...incoming.checkinFollowupIds])),
      walkinCheckinIds: Array.from(new Set([...(existing.walkinCheckinIds ?? []), ...incoming.walkinCheckinIds])),
    }),
  });
}
