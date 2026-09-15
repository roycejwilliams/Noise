import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import sendblue from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { buildContextSummary } from "../services/callContext.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { isReasonableLocalHour } from "../services/localHours.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

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
    `SELECT pcf.id, pcf.user_id, pcf.transcript, u.first_name, u.phone_number, cp.city
     FROM post_call_follow_ups pcf
     JOIN users u ON u.id = pcf.user_id
     LEFT JOIN co_profiles cp ON cp.user_id = pcf.user_id
     WHERE pcf.send_at <= NOW() AND pcf.sent_at IS NULL AND u.sms_opted_out = false
     LIMIT 20`,
  );

  for (const row of due.rows) {
    // Gated on the recipient's own local hour (Royce, 2026-09-03, confirmed
    // live via Sendblue's message log: a call ending late evening plus the
    // 2h-2d random delay below landed a real send at 12:30am Pacific) — same
    // fix as the auto-call/ask-checkin/event-surfacing crons got on
    // 2026-09-02 (jobs/index.ts), just never applied here since this job
    // polls its own due-row table instead of living inline in that file.
    // send_at is left untouched, so a row due at a bad hour just gets
    // re-checked on the next 10-min tick instead of being dropped.
    const timezone = row.city ? await getTimezoneForCity(row.city) : null;
    if (!isReasonableLocalHour(timezone)) continue;

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
      const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
      const { text: followUpMessage } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        experimental_telemetry: { isEnabled: true, functionId: "jobs.postCallFollowUp" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You got off a call with ${row.first_name} a little while ago.${contextSummary ? `\n\nWhat you already know about them (background only, don't recite it):\n${contextSummary}` : ""}\n\nHere's what they told you on the call:\n\n"${row.transcript}"\n\n${shape}\n\nThis is a relationship text, not a status update — never mention next steps, timing, or anything operational. That's handled elsewhere; this message's only job is proving you were actually listening.\n\nNo exclamation points. No em dashes. Normal sentence capitalization. This is a text message — keep it short, one text-message-length turn, under 160 characters.`,
      });
      const trimmed = followUpMessage.trim();

      // Row is already claimed (sent_at set above), so a send rejected by
      // sendblue.ts's meta-commentary guard just means no text goes out this
      // round — not a retry. (That guard used to live here as its own
      // regex — moved to services/sendblue.ts 2026-09-03 so every send gets
      // it, not just this job's.)
      const capped = trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
      await sendblue.messages.send({
        number: row.phone_number,
        content: capped,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
      // Royce, 2026-09-08 sweep — this send had zero logging of any kind,
      // so recentConversation had no record of it at all.
      await writeMemory(row.user_id, "text_exchange", `Co replied: ${capped}`).catch((err: any) =>
        console.error(`postCallFollowUp: text_exchange log failed for ${row.id} (non-fatal):`, err?.message ?? err),
      );
    } catch (err: any) {
      console.error(`postCallFollowUp: send failed for follow-up ${row.id} (non-fatal, already claimed — will not retry):`, err?.message ?? err);
    }
  }
}
