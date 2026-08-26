import cron from "node-cron";
import pool from "../../../api/src/db/db.js";
import { triggerCall } from "../services/callTrigger.js";

// The other half of "always lend an ear" — inbound calling (POST
// /co/incoming-call) means a user can always reach Co; this is Co reaching
// back out on its own, on a cadence the user set themselves post-call (see
// extractCheckinCadencePreference, api/src/services/profileExtraction.ts).
// Deliberately unconditional once due — no "is there something new to say"
// gate. A plain check-in call fits the positioning directly; manufacturing a
// reason each time would be the opposite of "you don't need one."
//
// checkin_call_cadence_days: NULL means never asked or no preference —
// proactive calling stays off for that person, same opt-in-only posture
// triggerCallForUser enforces elsewhere. 0 means they explicitly declined —
// also off, but recorded as a real answer, distinct from "never asked."
// Only > 0 values (7 or 14) are ever due.
async function placeDueProactiveCalls(): Promise<void> {
  // The UPDATE's own WHERE clause is both the due-check and the claim —
  // stamping last_proactive_outreach_at here, before triggerCall runs, means
  // a concurrent tick can't also claim the same row (the due-condition no
  // longer matches once stamped), and a failed call still waits out the
  // full cadence before retrying rather than hammering every tick — same
  // "bump regardless of send success" reasoning jobs/index.ts's ask-checkin
  // cron already uses for the same class of problem.
  const claimed = await pool.query(
    `UPDATE co_profiles cp
     SET last_proactive_outreach_at = NOW()
     FROM users u
     WHERE cp.user_id = u.id
       AND cp.checkin_call_cadence_days IS NOT NULL
       AND cp.checkin_call_cadence_days > 0
       AND (
         cp.last_proactive_outreach_at IS NULL
         OR cp.last_proactive_outreach_at <= NOW() - (cp.checkin_call_cadence_days || ' days')::interval
       )
       AND u.sms_opted_out = false
     RETURNING cp.user_id`,
  );

  for (const row of claimed.rows) {
    try {
      const result = await triggerCall(row.user_id);
      if (!result.success) {
        console.error(`proactiveCheckinCallJob: triggerCall failed for user ${row.user_id}:`, result.error);
      }
    } catch (err: any) {
      console.error(`proactiveCheckinCallJob: unexpected error calling user ${row.user_id} (non-fatal):`, err?.message ?? err);
    }
  }
}

export function registerProactiveCheckinCallJob(): void {
  cron.schedule("*/15 * * * *", () => {
    placeDueProactiveCalls().catch((err) => console.error("proactiveCheckinCallJob: poll failed:", err?.message ?? err));
  });
}
