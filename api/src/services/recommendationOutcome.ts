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
// this).
//
// Widened 2026-09-17 (Royce, "close the loop on outcomes" for Tier 3): a
// Tier 3 opportunity has no attendees to "meet," so it never gets the
// event-anchored "who did you meet?" question (draftDebriefText below asks
// something Tier-3-appropriate instead), but it's still worth knowing
// whether it went anywhere — that's what getTier3CategoryBias reads back
// into proposeOpportunityQuery. No event_date to anchor "the day after," so
// Tier 3 gets a fixed delay instead (TIER3_FOLLOWUP_DELAY_DAYS below).
//
// Same due-timestamp + nullable claim column + partial index convention as
// post_call_follow_ups (jobs/postCallFollowUp.ts) — see migrations.ts's
// recommendation_outcome_followups table. The outcome itself is written as
// a co_memories row ('recommendation_outcome'), not a new table — that's
// exactly what co_memories already exists for (event_offer_pending/
// event_offer_resolved/recap all follow this same shape).
const TIER3_FOLLOWUP_DELAY_DAYS = 5;

export async function scheduleOutcomeFollowUp(userId: string, askText: string, match: TierMatch): Promise<void> {
  const eventDate = "event_date" in match ? match.event_date : null;
  if (match.tier !== 3 && !eventDate) return; // Tier 1/2 need a real event date to anchor "the day after"; Tier 3 doesn't have or need one

  try {
    await pool.query(
      // One follow-up per recommended event/opportunity, however many times
      // it got recommended (2026-09-14: the same event produced two
      // follow-ups sent 2 seconds apart).
      `INSERT INTO recommendation_outcome_followups (user_id, ask_text, tier, match_name, match, send_at)
       SELECT $1::uuid, $2::text, $3::int, $4::text, $5::jsonb,
         CASE WHEN $6::date IS NOT NULL THEN $6::date + INTERVAL '1 day 11 hours' ELSE NOW() + ($7 || ' days')::interval END
       WHERE NOT EXISTS (
         SELECT 1 FROM recommendation_outcome_followups
         WHERE user_id = $1 AND (
           (match ->> 'event_api_id') = ($5::jsonb ->> 'event_api_id')
           OR lower(match_name) = lower($4)
         )
       )`,
      [userId, askText, match.tier, match.name, JSON.stringify(match), eventDate, TIER3_FOLLOWUP_DELAY_DAYS],
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

// Same idea as getTierBias, one level more specific: which KIND of Tier 3
// opportunity (tieredRecommendation.ts's category — accelerator, investor,
// mentor, etc.) has actually gone somewhere for this person before, not just
// whether Tier 3 in general has. Read back into proposeOpportunityQuery as
// an optional hint (2026-09-17, "close the loop on outcomes"). The category
// isn't stored on the co_memories outcome row itself — it's already sitting
// in recommendation_outcome_followups.match (the whole TierMatch was stored
// there at schedule time), so this joins back to it rather than needing a
// new column. Real signal here takes days to accumulate (a Tier 3 follow-up
// is deliberately delayed TIER3_FOLLOWUP_DELAY_DAYS) — an empty map is the
// honest, expected result for a while, and the caller already treats "no
// opinion" as "don't mention it," so this is safe to call from day one.
export async function getTier3CategoryBias(userId: string): Promise<Record<string, number>> {
  const bias: Record<string, number> = {};
  try {
    const { rows } = await pool.query(
      `SELECT rof.match ->> 'category' AS category, m.content::jsonb ->> 'outcome' AS outcome
       FROM co_memories m
       JOIN recommendation_outcome_followups rof ON rof.id::text = (m.content::jsonb ->> 'followupId')
       WHERE m.user_id = $1 AND m.memory_type = 'recommendation_outcome' AND (m.content::jsonb ->> 'tier')::int = 3`,
      [userId],
    );
    for (const row of rows) {
      const category = typeof row.category === "string" && row.category ? row.category : null;
      if (!category) continue;
      bias[category] = (bias[category] ?? 0) + (row.outcome === "named_positive" ? 1 : row.outcome === "named_critical" ? -1 : 0);
    }
  } catch (err: any) {
    console.error("getTier3CategoryBias: query failed (non-fatal, no bias applied):", err?.message ?? err);
  }
  return bias;
}

// A "closest miss" (real event that didn't quite fit) used to be presented
// fresh every single search, even when it's the literal same event a daily
// sweep surfaces again tomorrow — reading like Co forgot it already told
// them (2026-09-17, "close the loop conversationally on near-misses").
// Reuses co_memories the same way the outcome-learning rows do — no new
// table. Scoped to name+ask rather than a real id since a closest miss has
// no stable identity the way a sent recommendation does (Tier 3 in
// particular has no event_api_id at all).
const CLOSEST_MISS_RECALL_DAYS = 5;

export async function wasClosestMissRecentlyMentioned(userId: string, name: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM co_memories
       WHERE user_id = $1 AND memory_type = 'closest_miss_mentioned'
         AND lower(content::jsonb ->> 'name') = lower($2)
         AND created_at > NOW() - ($3 || ' days')::interval
       LIMIT 1`,
      [userId, name, CLOSEST_MISS_RECALL_DAYS],
    );
    return rows.length > 0;
  } catch (err: any) {
    console.error("wasClosestMissRecentlyMentioned: query failed (non-fatal, treated as not yet mentioned):", err?.message ?? err);
    return false;
  }
}

export async function recordClosestMissMentioned(userId: string, name: string, askText: string): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'closest_miss_mentioned', $2)`, [
      userId,
      JSON.stringify({ name, askText }),
    ])
    .catch((err: any) => console.error("recordClosestMissMentioned: write failed (non-fatal):", err?.message ?? err));
}

// Layer 7 (2026-09-14): no longer sends. Each due follow-up becomes part of
// one "debrief" candidate per event (merged with the end-of-night check-in
// from eventCheckinFollowUp.ts and the walk-in call offer), due the morning
// after at 10am their time. Live before this: three follow-ups all at 4am
// Pacific, one a duplicate two seconds after the other.
export async function enqueueDueOutcomeFollowUps(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT rof.id, rof.user_id, rof.ask_text, rof.match_name, rof.match, rof.send_at, cp.city
     FROM recommendation_outcome_followups rof
     JOIN users u ON u.id = rof.user_id
     LEFT JOIN co_profiles cp ON cp.user_id = rof.user_id
     WHERE rof.sent_at IS NULL AND rof.harness_status IS NULL AND u.sms_opted_out = false
       AND rof.send_at <= NOW() + INTERVAL '2 days'
     LIMIT 50`,
  );
  for (const row of rows) {
    const match = row.match ?? {};
    // Tier 1/2 anchor on the event's own date ("the day after"); Tier 3 has
    // no event to anchor on, so its already-computed send_at (a fixed delay
    // from when it was recommended) is the anchor instead (2026-09-17).
    const eventDate: string | undefined = match.event_date;
    const anchor: Date | null = eventDate ? null : row.send_at instanceof Date ? row.send_at : row.send_at ? new Date(row.send_at) : null;
    if (!eventDate && !anchor) {
      await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped' WHERE id = $1`, [row.id]);
      continue;
    }
    const timezone = row.city ? await getTimezoneForCity(row.city).catch(() => null) : null;
    // Only mark 'queued' on an actual queue (code review, 2026-09-17) — see
    // enqueueDebrief's comment.
    const result = await enqueueDebrief({
      userId: row.user_id,
      eventApiId: match.event_api_id ?? null,
      eventName: row.match_name,
      eventEnd: eventDate ? endOfLocalDay(eventDate, timezone) : anchor!,
      timezone,
      part: { outcomeFollowupIds: [row.id], askText: row.ask_text },
    }).catch((err: any) => {
      console.error(`recommendationOutcome: enqueueDebrief failed for ${row.id} (non-fatal):`, err?.message ?? err);
      return { queued: false };
    });
    await pool.query(`UPDATE recommendation_outcome_followups SET harness_status = $2 WHERE id = $1`, [row.id, result.queued ? "queued" : "skipped"]);
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
// Returns whether it actually queued (code review, 2026-09-17): this used
// to return void, so all three callers had no way to tell a real queue from
// a no-op (the harness candidate already sent/dropped/expired) and marked
// their own source row 'queued' regardless either way.
export async function enqueueDebrief(opts: {
  userId: string;
  eventApiId: string | null;
  eventName: string;
  eventEnd: Date;
  timezone: string | null;
  part: Partial<Pick<DebriefPayload, "outcomeFollowupIds" | "checkinFollowupIds" | "walkinCheckinIds" | "askText">>;
}): Promise<{ queued: boolean }> {
  const payload: DebriefPayload = {
    eventApiId: opts.eventApiId,
    eventName: opts.eventName,
    outcomeFollowupIds: opts.part.outcomeFollowupIds ?? [],
    checkinFollowupIds: opts.part.checkinFollowupIds ?? [],
    walkinCheckinIds: opts.part.walkinCheckinIds ?? [],
    askText: opts.part.askText ?? null,
  };
  const dueAt = nextLocalHour(opts.eventEnd, opts.timezone, 10);
  return enqueueCandidate({
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
