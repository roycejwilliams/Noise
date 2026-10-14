import pool from "../db/db.js";
import { memberZone } from "../services/memberTime.js";
import { blockedForNoReason, callHourOk, nextAllowedCallTime } from "../harness/callGate.js";
import { recordDecision } from "../harness/core.js";
import { heldCallReason } from "../services/callReason.js";
import { triggerCallForUser } from "../services/callTrigger.js";

// The other half of "always lend an ear" — inbound calling (POST
// /co/incoming-call) means a user can always reach Co; this is Co reaching
// back out on its own, on a cadence the user set themselves post-call (see
// extractCheckinCadencePreference, services/profileExtraction.ts).
// Changed 2026-10-08 (Royce): it used to be unconditional once due, and in a
// 10-call eval 4 of 9 outbound calls opened on Co's own homework ("the PDF
// went out this morning, wanted to make sure it landed"). Now a due check-in
// call goes out only with a reason from their life (services/callReason.ts,
// checked in the call gate): something they said, celebrated, worried about,
// or have coming up. With nothing but Co's own work on file, no call: the
// skip is logged (call.skipped_no_reason) and the next cadence slot re-checks.
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

      // No reason from their life: not an error, and not retried until the next cadence slot (the stamp stays at now). Also
      // outside their hours: the hours correction below re-checks at the next allowed hour instead.
      if (blockedForNoReason(result.error) && !/8am-9pm/.test(result.error)) {
        const held = heldCallReason(row.user_id);
        await recordDecision({
          layer: 8,
          decision: "call.skipped_no_reason",
          userId: row.user_id,
          outcome: "skip",
          action: "checkin_cadence",
          proposal: { considered: held?.result.considered ?? [], nextCheckInDays: Number(row.checkin_call_cadence_days) || null },
          reason: "only Cue's own work (or nothing) to call about; the next cadence slot re-checks",
        });
        continue;
      }
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
