import pool from "../db/db.js";
import { getTimezoneForCity } from "./geocoding.js";
import { getEventDetails } from "./luma.js";
import { enqueueDebrief, type NamedOutcome } from "./recommendationOutcome.js";
import type { ScorableGuest } from "./eventScoring.js";

// Event Curation's own "end-of-night check-in" (Notion V1 board row 8, "who
// did you meet that was interesting?") — distinct from
// services/recommendationOutcome.ts's near-identical-looking mechanism,
// which fires off Co having merely RECOMMENDED a Tier 1/2 event (no
// confirmation anyone actually went).
//
// Gated on registration (matchGuestsToUsers already confirms they're on the
// real guest list of one of Co's OWN curated/guest-list-scored events) plus
// the event's real end_at, not on guest.checked_in_at (Royce, 2026-09-07:
// confirmed live that Luma's API has no way to set check-in status at all —
// only a real physical scan or the host manually toggling it on Luma's own
// sign-in-gated page can ever populate it, which made this feature
// practically untestable and, worse, meant it would silently never fire for
// any registered guest who simply forgot to check in on Luma even though
// they genuinely attended). Trades off the ability to skip a no-show
// specifically (registering doesn't guarantee attendance) for a signal that
// actually exists and fires reliably.
//
// Used to reuse classifyNamedOutcome (now read by the Layer 2 router) (Notion board row 13 already said the
// Event Curation surface "would reuse this same function once it exists")
// — same four-way classification, same reasoning. Outcome is written to its
// OWN co_memories type ('event_checkin_outcome'), not 'recommendation_outcome'
// — this is a signal about an actual in-person guest-list event, not a tier
// recommendation, so it shouldn't silently feed getTierBias's tier-weighting
// tally, which is scoped to TierMatch reveals only.

// A few hours after the event actually ends reads as "later that night," not
// an immediate ambush the moment they check in, and not a next-morning
// question either — this row's whole point is "how was TONIGHT," while
// recommendationOutcome.ts's next-day-late-morning cadence fits its own
// different framing ("did you go to the thing I mentioned last week").
const CHECKIN_FOLLOWUP_DELAY_HOURS = 3;

export async function scheduleEventCheckinFollowUp(
  userId: string,
  eventApiId: string,
  eventName: string,
  sendAt: Date,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  if (opts.dryRun) {
    console.log(`[eventCheckinFollowUp dryRun] would schedule ${userId} for ${eventApiId} at ${sendAt.toISOString()}`);
    return;
  }
  try {
    // ON CONFLICT DO NOTHING, not DO UPDATE — once scheduled, a repeat
    // guest.registered/guest.updated for the same guest shouldn't push the
    // send time around or risk re-arming a row a claim already sent.
    await pool.query(
      `INSERT INTO event_checkin_followups (user_id, event_api_id, event_name, send_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_api_id, user_id) DO NOTHING`,
      [userId, eventApiId, eventName, sendAt.toISOString()],
    );
  } catch (err: any) {
    console.error("scheduleEventCheckinFollowUp: insert failed (non-fatal):", err?.message ?? err);
  }
}

export async function detectAndScheduleCheckins(
  eventId: string,
  eventName: string,
  matched: ScorableGuest[],
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  if (!matched.length) return;

  // One lookup for the whole event, not per-guest — end_at doesn't vary
  // per person. No check-in-time fallback anymore (see comment above) —
  // without a real end_at there's no grounded "how was tonight" moment to
  // schedule against, so this cycle is skipped rather than guessing one;
  // a later guest.updated for the same event (Luma backfilling end_at,
  // say) gets another chance via ON CONFLICT DO NOTHING below.
  const details = await getEventDetails(eventId).catch((err: any) => {
    console.error(`detectAndScheduleCheckins: getEventDetails failed for ${eventId} (non-fatal):`, err?.message ?? err);
    return null;
  });
  if (!details) return;
  // No end_at: the end of that evening (introConsent.ts effectiveEnd), the same close the in-room window uses.
  const { effectiveEnd } = await import("../harness/introConsent.js");
  const sendAt = new Date(new Date(effectiveEnd({ start_at: details.start_at, end_at: details.end_at, timezone: details.timezone ?? null })).getTime() + CHECKIN_FOLLOWUP_DELAY_HOURS * 60 * 60 * 1000);
  for (const person of matched) {
    await scheduleEventCheckinFollowUp(person.user_id, eventId, eventName, sendAt, opts);
  }
}

// Same expiry reasoning as recommendationOutcome.ts's OUTCOME_FOLLOWUP_EXPIRY_DAYS.
const CHECKIN_FOLLOWUP_EXPIRY_DAYS = 7;

export type PendingEventCheckinFollowUp = {
  id: string;
  event_api_id: string;
  event_name: string;
};

// Mirrors recommendationOutcome.ts's findPendingOutcomeFollowUp exactly,
// scoped to this feature's own table + memory type.
export async function findPendingEventCheckinFollowUp(userId: string): Promise<PendingEventCheckinFollowUp | null> {
  const { rows } = await pool.query(
    `SELECT id, event_api_id, event_name FROM event_checkin_followups
     WHERE user_id = $1 AND sent_at IS NOT NULL
       AND sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM co_memories r
         WHERE r.user_id = $1 AND r.memory_type = 'event_checkin_outcome'
           AND (r.content::jsonb ->> 'followupId') = event_checkin_followups.id::text
       )
     ORDER BY sent_at DESC LIMIT 1`,
    [userId, CHECKIN_FOLLOWUP_EXPIRY_DAYS],
  );
  return rows[0] ?? null;
}

export async function recordEventCheckinOutcome(
  userId: string,
  followupId: string,
  eventApiId: string,
  outcome: NamedOutcome,
): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_checkin_outcome', $2)`, [
      userId,
      JSON.stringify({ followupId, eventApiId, outcome }),
    ])
    .catch((err: any) => console.error("recordEventCheckinOutcome: memory write failed (non-fatal):", err?.message ?? err));
}


// Layer 7 (2026-09-14): no longer sends at end+3h. Merged into the same
// per-event "debrief" candidate as the recommendation outcome follow-up
// (recommendationOutcome.ts enqueueDebrief), due the morning after.
export async function enqueueDueEventCheckinFollowUps(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT ecf.id, ecf.user_id, ecf.event_api_id, ecf.event_name, ecf.send_at, cp.city
     FROM event_checkin_followups ecf
     JOIN users u ON u.id = ecf.user_id
     LEFT JOIN co_profiles cp ON cp.user_id = ecf.user_id
     WHERE ecf.sent_at IS NULL AND ecf.harness_status IS NULL AND u.sms_opted_out = false
       AND ecf.send_at <= NOW() + INTERVAL '1 day'
     LIMIT 50`,
  );
  for (const row of rows) {
    const timezone = row.city ? await getTimezoneForCity(row.city).catch(() => null) : null;
    // send_at was scheduled as end_at + CHECKIN_FOLLOWUP_DELAY_HOURS.
    const eventEnd = new Date(new Date(row.send_at).getTime() - CHECKIN_FOLLOWUP_DELAY_HOURS * 60 * 60 * 1000);
    // Only mark 'queued' on an actual queue (code review, 2026-09-17) — see
    // recommendationOutcome.ts's enqueueDebrief comment.
    const result = await enqueueDebrief({
      userId: row.user_id,
      eventApiId: row.event_api_id,
      eventName: row.event_name,
      eventEnd,
      timezone,
      part: { checkinFollowupIds: [row.id] },
    }).catch((err: any) => {
      console.error(`eventCheckinFollowUp: enqueueDebrief failed for ${row.id} (non-fatal):`, err?.message ?? err);
      return { queued: false };
    });
    await pool.query(`UPDATE event_checkin_followups SET harness_status = $2 WHERE id = $1`, [row.id, result.queued ? "queued" : "skipped"]);
  }
}
