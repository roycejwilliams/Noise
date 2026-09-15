import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import sendblue from "../services/sendblue.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { writeMemory } from "../services/memory.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

// Places calls booked via the schedule-a-call flow in sendblue.ts
// (scheduled_calls, distinct from the existing "call me now" explicit_request
// path). scheduled_for is already a resolved absolute UTC instant, computed
// once at capture time — this job never re-parses a timezone, it just polls
// for what's due.
export async function placeDueCalls(io: import("socket.io").Server | null): Promise<void> {
  // Excludes opted-out users — a scheduled call from before they opted out
  // should never fire; left 'pending' rather than force-completed/cancelled
  // so nothing here silently rewrites a status the user didn't cause.
  const due = await pool.query(
    `SELECT sc.id, sc.user_id FROM scheduled_calls sc
     JOIN users u ON u.id = sc.user_id
     WHERE sc.scheduled_for <= NOW() AND sc.status = 'pending' AND u.sms_opted_out = false
     LIMIT 20`,
  );

  for (const row of due.rows) {
    // Claim first (status flip in the same statement as the eligibility
    // check) so two overlapping cron ticks can't both place the same call —
    // same pattern as postCallFollowUp's sent_at claim.
    const claim = await pool.query(
      `UPDATE scheduled_calls SET status = 'processing' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [row.id],
    );
    if (!claim.rows[0]) continue;

    try {
      const result = await triggerCallForUser(row.user_id, io);
      if (result.success) {
        await pool.query(
          `UPDATE scheduled_calls SET status = 'completed', call_sid = $2 WHERE id = $1`,
          [row.id, result.call_sid],
        );
      } else {
        console.error(`scheduledCall: triggerCallForUser failed for scheduled call ${row.id}:`, result.error);
        await pool.query(`UPDATE scheduled_calls SET status = 'failed' WHERE id = $1`, [row.id]);
      }
    } catch (err: any) {
      console.error(`scheduledCall: unexpected error placing scheduled call ${row.id} (non-fatal):`, err?.message ?? err);
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
export async function sendDueReminders(): Promise<void> {
  const due = await pool.query(
    `SELECT sc.id, u.id AS user_id, u.first_name, u.phone_number
     FROM scheduled_calls sc
     JOIN users u ON u.id = sc.user_id
     WHERE sc.status = 'pending'
       AND sc.reminder_sent_at IS NULL
       AND sc.scheduled_for <= NOW() + INTERVAL '15 minutes'
       AND sc.scheduled_for > NOW()
       AND u.sms_opted_out = false
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
          functionId: "jobs.scheduledCallReminder",
        },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're about to call ${row.first_name} in about 15 minutes, as scheduled. Send a short, natural one-line heads-up text. Vary how you say it, don't just say "Calling you soon." No exclamation points, no em dashes. Under 60 characters.`,
      });
      const trimmed = variedReminder.trim();
      if (trimmed) reminderMessage = trimmed;
    } catch (err: any) {
      console.error(
        `scheduledCall: reminder message generation failed for ${row.id} (non-fatal, using fallback):`,
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
      console.error(`scheduledCall: reminder send failed for ${row.id} (non-fatal):`, err?.message ?? err);
      continue;
    }

    // Confirmed live, 2026-09-08: without this, a reminder sent here was
    // completely invisible to Co's own reply-generation (recentConversation
    // only reads text_exchange rows) — asked "why are you calling me in 15
    // mins?" moments later, Co had no memory of having just said that and
    // flatly denied it, when the scheduling itself had actually worked
    // correctly the whole time.
    await writeMemory(row.user_id, "text_exchange", `Co replied: ${reminderMessage}`).catch((err: any) =>
      console.error(`scheduledCall: reminder text_exchange log failed for ${row.id} (non-fatal):`, err?.message ?? err),
    );
  }
}
