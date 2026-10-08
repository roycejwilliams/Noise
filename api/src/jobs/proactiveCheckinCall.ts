import pool from "../db/db.js";
import { memberZone } from "../services/memberTime.js";
import { callHourOk, nextAllowedCallTime } from "../harness/callGate.js";
import { triggerCallForUser } from "../services/callTrigger.js";

// The other half of "always lend an ear" — inbound calling (POST
// /co/incoming-call) means a user can always reach Co; this is Co reaching
// back out on its own, on a cadence the user set themselves post-call (see
// extractCheckinCadencePreference, services/profileExtraction.ts).
// Deliberately unconditional once due — no "is there something new to say"
// gate. A plain check-in call fits the positioning directly; manufacturing a
// reason each time would be the opposite of "you don't need one."
//
// checkin_call_cadence_days: NULL means never asked or no preference —
// proactive calling stays off for that person, same opt-in-only posture
// triggerCallForUser enforces elsewhere. 0 means they explicitly declined —
// also off, but recorded as a real answer, distinct from "never asked."
// Only > 0 values (7 or 14) are ever due.
export async function placeDueProactiveCalls(io: import("socket.io").Server | null): Promise<void> {
  // The UPDATE's own WHERE clause is both the due-check and the claim —
  // stamping last_proactive_outreach_at here, before triggerCallForUser runs,
  // means a concurrent tick can't also claim the same row (the due-condition
  // no longer matches once stamped). Fixed 2026-09-17 (Royce): stamping
  // unconditionally at NOW() meant a call blocked purely by local hours
  // (this cron runs every 15 min, all day, everywhere) consumed the whole
  // 7/14-day cycle anyway — a person whose allowed window this cadence kept
  // landing just outside could drift permanently. The claim below still
  // happens up front (still race-safe), but a pure-hours block gets its
  // stamp corrected afterward to the next allowed local hour instead of a
  // full cadence out — see the local_hours check below.
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
     RETURNING cp.user_id, cp.city, cp.checkin_call_cadence_days`,
  );

  for (const row of claimed.rows) {
    try {
      const result = await triggerCallForUser(row.user_id, io, { kind: "checkin_cadence" });
      if (result.success) continue; // cycle correctly consumed — a real call went out

      console.error(`proactiveCheckinCall: triggerCallForUser failed for user ${row.user_id}:`, result.error);

      // Only correct the stamp for a pure hours block — anything else
      // (opted out mid-flight, subscription lapsed, a live/recent call)
      // still waits out the normal cadence, same as before this fix.
      const timezone = await memberZone(row.user_id);
      const now = new Date();
      if (!callHourOk(timezone, now)) {
        const retryAt = nextAllowedCallTime(timezone, now);
        await pool.query(
          `UPDATE co_profiles SET last_proactive_outreach_at = $2::timestamptz - (checkin_call_cadence_days || ' days')::interval WHERE user_id = $1`,
          [row.user_id, retryAt.toISOString()],
        );
      }
    } catch (err: any) {
      console.error(`proactiveCheckinCall: unexpected error calling user ${row.user_id} (non-fatal):`, err?.message ?? err);
    }
  }
}
