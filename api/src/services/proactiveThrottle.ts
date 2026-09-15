import pool from "../db/db.js";

// Gap closed 2026-08-30 (Royce): "we also have to think about not annoying
// the user" — the event tease, ask solicitation, and calendar-follow
// reach-out each had their own individual cooldown, but nothing stopped two
// or three of them (plus the Stage 5 ask check-in text) landing on the same
// person on the same day from unrelated triggers.
//
// co_profiles.last_proactive_outreach_at already exists for exactly this
// purpose — added as "the shared cooldown timestamp" so unrelated proactive
// systems don't reach out within days of each other (see migrations.ts and
// jobs/proactiveCheckinCall.ts, which already reads/writes it for the
// proactive check-in CALL cadence). That call-cadence port was explicitly
// left as a stated follow-up for other systems and never finished. This
// finishes it for the four discretionary TEXT nudges — sharing the same
// clock as the call cadence (whichever fires most recently updates it for
// everyone), but with its own, much lighter floor appropriate to a text
// versus a call.
//
// Deliberately NOT applied to event_change_notification — a real
// cancellation/change to something someone's actually registered for is
// time-critical information, not a discretionary nudge, so it stays exempt.
// Layer 7 (2026-09-14): discretionary texts now go through the proactive
// harness (src/harness/proactive.ts), which has its own ledger and caps.
// This claim is still used by Layer 6 in-room nudges during a live event
// (eventScoring.ts), which are deliberately outside that harness.
const TEXT_NUDGE_COOLDOWN_HOURS = 24;

// Single atomic claim, not check-then-write (bug fix, 2026-08-30) — two
// separate calls (a SELECT to check, then an UPDATE to record) let two
// proactive mechanisms firing around the same moment for the same user
// (e.g. the daily sweep cron and a webhook-triggered reach-out) both read
// "not nudged recently" before either had written its claim, so both would
// send — exactly what this throttle exists to prevent. Folding the check
// and the write into one UPDATE...WHERE...RETURNING makes Postgres's
// row-level locking do the serialization: only one concurrent caller's
// WHERE clause can still be true by the time it actually executes, so only
// one gets rows back. Call this BEFORE sending, not after — claim first,
// then act, same as any idempotency-key pattern; a send that then fails for
// an unrelated reason costs an unused claim, which is a fine trade for
// closing the race.
export async function tryClaimProactiveNudge(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE co_profiles
     SET last_proactive_outreach_at = NOW()
     WHERE user_id = $1
       AND (last_proactive_outreach_at IS NULL OR last_proactive_outreach_at <= NOW() - ($2 || ' hours')::interval)
     RETURNING user_id`,
    [userId, TEXT_NUDGE_COOLDOWN_HOURS],
  );
  return rows.length > 0;
}
