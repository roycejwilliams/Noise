import cron from "node-cron";
import pool from "../../../api/src/db/db.js";
import { triggerCall } from "../services/callTrigger.js";

// Places calls booked via the schedule-a-call flow in webhooks.ts
// (scheduled_calls, distinct from the existing "call me now"
// explicit_request path). scheduled_for is already a resolved absolute UTC
// instant, computed once at capture time — this job never re-parses a
// timezone, it just polls for what's due.
async function placeDueCalls(): Promise<void> {
  const due = await pool.query(
    `SELECT id, user_id FROM scheduled_calls WHERE scheduled_for <= NOW() AND status = 'pending' LIMIT 20`,
  );

  for (const row of due.rows) {
    // Claim first (status flip in the same statement as the eligibility
    // check) so two overlapping cron ticks can't both place the same call —
    // same pattern as postCallFollowUpJob's sent_at claim.
    const claim = await pool.query(
      `UPDATE scheduled_calls SET status = 'processing' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [row.id],
    );
    if (!claim.rows[0]) continue;

    try {
      const result = await triggerCall(row.user_id);
      if (result.success) {
        await pool.query(
          `UPDATE scheduled_calls SET status = 'completed', call_sid = $2 WHERE id = $1`,
          [row.id, result.call_sid],
        );
      } else {
        console.error(`scheduledCallJob: triggerCall failed for scheduled call ${row.id}:`, result.error);
        await pool.query(`UPDATE scheduled_calls SET status = 'failed' WHERE id = $1`, [row.id]);
      }
    } catch (err: any) {
      console.error(`scheduledCallJob: unexpected error placing scheduled call ${row.id} (non-fatal):`, err?.message ?? err);
      await pool.query(`UPDATE scheduled_calls SET status = 'failed' WHERE id = $1`, [row.id]).catch(() => {});
    }
  }
}

export function registerScheduledCallJob(): void {
  cron.schedule("*/5 * * * *", () => {
    placeDueCalls().catch((err) => console.error("scheduledCallJob: poll failed:", err?.message ?? err));
  });
}
