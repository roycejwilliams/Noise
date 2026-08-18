import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import cron from "node-cron";
import pool from "../../../api/src/db/db.js";
import sendblue from "../../../api/src/services/sendblue.js";
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

// Heads-up text ~15 minutes before a scheduled call actually fires — the
// window is deliberately wide relative to this job's 5-min tick (rather
// than a narrow "exactly 15 min out" check) so a slow tick or a brief
// outage can't cause a reminder to be silently skipped; reminder_sent_at
// being non-null is what actually prevents a duplicate, not the timing
// window itself.
async function sendDueReminders(): Promise<void> {
  const due = await pool.query(
    `SELECT sc.id, u.first_name, u.phone_number
     FROM scheduled_calls sc
     JOIN users u ON u.id = sc.user_id
     WHERE sc.status = 'pending'
       AND sc.reminder_sent_at IS NULL
       AND sc.scheduled_for <= NOW() + INTERVAL '15 minutes'
       AND sc.scheduled_for > NOW()
     LIMIT 20`,
  );

  for (const row of due.rows) {
    // Claim first, same reasoning as placeDueCalls' status claim — two
    // overlapping ticks can't both send the same reminder.
    const claim = await pool.query(
      `UPDATE scheduled_calls SET reminder_sent_at = NOW() WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id`,
      [row.id],
    );
    if (!claim.rows[0]) continue;

    // Varied, not a fixed string, same reasoning as callConfirmation and
    // every other short Co-voice text in this codebase — hard fallback so
    // a slow/failed generation never blocks the reminder from going out.
    let reminderMessage = "Calling you soon, like we said.";
    try {
      const { text: variedReminder } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "co-test.jobs.scheduledCallReminder",
        },
        prompt: `You are Co. You're about to call ${row.first_name} in about 15 minutes, as scheduled. Send a short, natural one-line heads-up text. Vary how you say it, don't just say "Calling you soon." No exclamation points, no em dashes. Under 60 characters.`,
      });
      const trimmed = variedReminder.trim();
      if (trimmed) reminderMessage = trimmed;
    } catch (err: any) {
      console.error(
        `scheduledCallJob: reminder message generation failed for ${row.id} (non-fatal, using fallback):`,
        err?.message ?? err,
      );
    }

    try {
      await sendblue.messages.send({
        number: row.phone_number,
        content: reminderMessage,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (err: any) {
      console.error(`scheduledCallJob: reminder send failed for ${row.id} (non-fatal):`, err?.message ?? err);
    }
  }
}

export function registerScheduledCallJob(): void {
  cron.schedule("*/5 * * * *", () => {
    placeDueCalls().catch((err) => console.error("scheduledCallJob: poll failed:", err?.message ?? err));
    sendDueReminders().catch((err) => console.error("scheduledCallJob: reminder poll failed:", err?.message ?? err));
  });
}
