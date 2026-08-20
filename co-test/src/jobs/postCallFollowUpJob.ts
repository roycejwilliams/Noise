import cron from "node-cron";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../../../api/src/db/db.js";
import sendblue from "../../../api/src/services/sendblue.js";
import { getCoPersonaPrompt } from "../services/coPersona.js";

// A person who was actually listening doesn't follow up the same way every
// time — one fixed "observation + reframe" template, generated over and
// over, reads as scripted even with varied content. Rotating the shape
// forces real variety: sometimes a callback + light question, sometimes a
// pure resonant observation with no question, sometimes framed as something
// that occurred to Co since the call (which is also what makes the 2h-2d
// delay read as genuine rather than arbitrary).
const SHAPES = [
  `Pick exactly ONE real, specific thing they said. Callback to it, then ask one light, genuine question tied to it — something that invites them to say more, not a survey question.`,
  `Pick exactly ONE real, specific thing they said. Respond to only that with a warm, resonant observation — no question. Leave room for them to reply without demanding it.`,
  `Pick exactly ONE real, specific thing they said. Frame it as something that occurred to you since you talked — like it crossed your mind, not like you're reporting back immediately.`,
] as const;

async function sendDueFollowUps(): Promise<void> {
  const due = await pool.query(
    `SELECT pcf.id, pcf.user_id, pcf.transcript, u.first_name, u.phone_number
     FROM post_call_follow_ups pcf
     JOIN users u ON u.id = pcf.user_id
     WHERE pcf.send_at <= NOW() AND pcf.sent_at IS NULL AND u.sms_opted_out = false
     LIMIT 20`,
  );

  for (const row of due.rows) {
    // Claim first (sets sent_at in the same statement as the send-eligibility
    // check) so a crash mid-send fails closed — skipped, never resent — and
    // two overlapping cron ticks can't double-send the same row.
    const claim = await pool.query(
      `UPDATE post_call_follow_ups SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING id`,
      [row.id],
    );
    if (!claim.rows[0]) continue;

    try {
      const persona = await getCoPersonaPrompt();
      const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
      const { text: followUpMessage } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        experimental_telemetry: { isEnabled: true, functionId: "co-test.jobs.postCallFollowUp" },
        prompt: `${persona ?? "You are Co."} You got off a call with ${row.first_name} a little while ago. Here's what they told you:\n\n"${row.transcript}"\n\n${shape}\n\nThis is a relationship text, not a status update — never mention next steps, circle placement, timing, or anything operational. That's handled elsewhere; this message's only job is proving you were actually listening.\n\nNo exclamation points. No em dashes. This is a text message — keep it short, one text-message-length turn, under 160 characters.`,
      });
      const capped = followUpMessage.trim().length > 160 ? `${followUpMessage.trim().slice(0, 159)}…` : followUpMessage.trim();
      await sendblue.messages.send({
        number: row.phone_number,
        content: capped,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (err: any) {
      console.error(`postCallFollowUpJob: send failed for follow-up ${row.id} (non-fatal, already claimed — will not retry):`, err?.message ?? err);
    }
  }
}

export function registerPostCallFollowUpJob(): void {
  cron.schedule("*/10 * * * *", () => {
    sendDueFollowUps().catch((err) => console.error("postCallFollowUpJob: poll failed:", err?.message ?? err));
  });
}
