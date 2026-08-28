import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import sendblue from "../services/sendblue.js";
import { renderCoPersonaPrompt } from "../services/coPersona.js";
import { buildContextSummary } from "../services/callContext.js";

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

export async function sendDueFollowUps(): Promise<void> {
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
      const contextSummary = await buildContextSummary(row.user_id);
      const persona = await renderCoPersonaPrompt(row.first_name, contextSummary);
      const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
      const { text: followUpMessage } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        experimental_telemetry: { isEnabled: true, functionId: "jobs.postCallFollowUp" },
        prompt: `${persona ?? "You are Co."} You got off a call with ${row.first_name} a little while ago. Here's what they told you:\n\n"${row.transcript}"\n\n${shape}\n\nThis is a relationship text, not a status update — never mention next steps, timing, or anything operational. That's handled elsewhere; this message's only job is proving you were actually listening.\n\nNo exclamation points. No em dashes. This is a text message — keep it short, one text-message-length turn, under 160 characters.`,
      });
      const trimmed = followUpMessage.trim();

      // Guards against ever texting a real user raw model meta-commentary
      // (e.g. "I don't have access to...") instead of an actual follow-up —
      // the exact failure this job produced live before the persona-prompt
      // template tokens above were being filled in. An unresolved "{{" or a
      // literal mention of an internal field name are things a real
      // follow-up text would never contain, so either is a reliable signal
      // the model fell back to explaining what it's missing rather than
      // writing the message. Row is already claimed (sent_at set above), so
      // skipping here just means no text goes out this round — not a retry.
      if (trimmed.includes("{{") || /context_summary/i.test(trimmed)) {
        console.error(
          `postCallFollowUp: generated text for follow-up ${row.id} looked like leaked prompt/meta-commentary, not sending:`,
          trimmed,
        );
        continue;
      }

      const capped = trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
      await sendblue.messages.send({
        number: row.phone_number,
        content: capped,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (err: any) {
      console.error(`postCallFollowUp: send failed for follow-up ${row.id} (non-fatal, already claimed — will not retry):`, err?.message ?? err);
    }
  }
}
