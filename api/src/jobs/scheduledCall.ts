import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { cleanCoMessage } from "../services/sendblue.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { sendExempt } from "../harness/proactive.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { MODELS } from "../models.js";
import { withTraceUser } from "../services/llmTraceText.js";

// One-line heads-up draft checked by length; narrow work, so Haiku.
const REMINDER_MODEL = MODELS.haiku;

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
      const result = await triggerCallForUser(row.user_id, io, { kind: "scheduled_call", scheduledCallId: row.id });
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

// A reminder only makes sense for a call that's still pending and still
// coming up in the next ~20 minutes. Pure, so the Layer 7 eval can test it.
export function reminderStillDue(call: { status: string; scheduled_for: Date | string }, now: Date): boolean {
  const at = new Date(call.scheduled_for).getTime();
  return call.status === "pending" && at > now.getTime() && at <= now.getTime() + 20 * 60 * 1000;
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
      // Under the member's own trace-text mark (services/llmTraceText.ts).
      const { text: variedReminder } = await withTraceUser(row.user_id, () =>
        generateText({
          model: anthropic(REMINDER_MODEL),
          experimental_telemetry: {
            isEnabled: true,
            functionId: "jobs.scheduledCallReminder",
          },
          prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're about to call ${row.first_name} in about 15 minutes, as scheduled. Send a short, natural one-line heads-up text. Vary how you say it, don't just say "Calling you soon." No em dashes. Under 60 characters.`,
        }),
      );
      const trimmed = variedReminder.trim();
      if (trimmed && trimmed.length <= 80 && !/[!—–]|https?:/.test(trimmed)) reminderMessage = trimmed;
    } catch (err: any) {
      console.error(
        `scheduledCall: reminder message generation failed for ${row.id} (non-fatal, using fallback):`,
        err?.message ?? err,
      );
    }

    // Re-read right before sending (live 2026-09-10: "gonna ring you in like
    // 15" went out for a call that had been cancelled after the reminder
    // row was claimed). Anything but still-pending and still ~15 min out
    // means no reminder.
    const still = await pool.query(`SELECT status, scheduled_for FROM scheduled_calls WHERE id = $1`, [row.id]);
    if (!still.rows[0] || !reminderStillDue(still.rows[0], new Date())) {
      console.log(`scheduledCall: reminder for ${row.id} skipped, call no longer pending at that time`);
      continue;
    }

    // Transactional: outside the daily proactive pick, but idempotent per
    // call through the proactive ledger. sendExempt logs text_exchange.
    try {
      await sendExempt({
        userId: row.user_id,
        phoneNumber: row.phone_number,
        type: "call_reminder",
        targetKey: `call_reminder:${row.id}`,
        messages: [cleanCoMessage(reminderMessage)],
      });
    } catch (err: any) {
      console.error(`scheduledCall: reminder send failed for ${row.id} (non-fatal):`, err?.message ?? err);
    }
  }
}
