import pool from "../db/db.js";
import { buildContextSummary } from "../services/callContext.js";
import { enqueueCandidate, draftProactive, type OutputRules } from "../harness/proactive.js";

// Relationship text after a call: one real thought from what they said.
//
// Layer 7 (2026-09-14): the old job waited a random 2h-2d, then sent on its
// own, and live that meant four texts in one 9-second burst, 3-5 days late.
// Now each call becomes a "post_call" candidate due right away (the harness
// holds it for local hours and caps) that expires 24 hours after the call:
// past that, a "kept thinking about what you said" text reads as scripted,
// so it's skipped instead of sent late.
const POST_CALL_EXPIRY_HOURS = 24;

export async function enqueueDuePostCallFollowUps(): Promise<void> {
  // Anything older than the expiry window is closed out without sending.
  await pool.query(
    `UPDATE post_call_follow_ups SET harness_status = 'expired'
     WHERE sent_at IS NULL AND harness_status IS NULL AND created_at <= NOW() - ($1 || ' hours')::interval`,
    [POST_CALL_EXPIRY_HOURS],
  );
  const { rows } = await pool.query(
    `SELECT id, user_id, created_at FROM post_call_follow_ups
     WHERE sent_at IS NULL AND harness_status IS NULL
     LIMIT 50`,
  );
  for (const row of rows) {
    const createdAt = new Date(row.created_at);
    // Only mark 'queued' when enqueueCandidate actually queued it (code
    // review, 2026-09-17): this used to mark 'queued' unconditionally,
    // including when the call threw (swallowed by .catch, ignoring the
    // result) or came back {queued:false} (already sent/dropped, an
    // idempotency no-op, not success) — either way harness_status='queued'
    // made this row look like a real in-flight candidate forever, with
    // nothing ever polling it again to notice it wasn't.
    const result = await enqueueCandidate({
      userId: row.user_id,
      type: "post_call",
      targetKey: `post_call:${row.id}`,
      summary: `Short text about one specific thing they said on a call ${Math.round((Date.now() - createdAt.getTime()) / 3600000)}h ago`,
      payload: { followUpId: row.id },
      dueAt: new Date(createdAt.getTime() + 20 * 60 * 1000),
      expiresAt: new Date(createdAt.getTime() + POST_CALL_EXPIRY_HOURS * 60 * 60 * 1000),
    }).catch((err: any) => {
      console.error(`postCallFollowUp: enqueue failed for ${row.id} (non-fatal):`, err?.message ?? err);
      return { queued: false };
    });
    await pool.query(`UPDATE post_call_follow_ups SET harness_status = $2 WHERE id = $1`, [row.id, result.queued ? "queued" : "skipped"]);
  }
}

export async function draftPostCall(userId: string, firstName: string, followUpId: string): Promise<{ text: string; rules: OutputRules } | null> {
  const { rows } = await pool.query(`SELECT transcript FROM post_call_follow_ups WHERE id = $1`, [followUpId]);
  const transcript: string | undefined = rows[0]?.transcript;
  if (!transcript) return null;
  const contextSummary = await buildContextSummary(userId).catch(() => "");
  return draftPostCallText(firstName, transcript, contextSummary);
}

export async function draftPostCallText(firstName: string, transcript: string, contextSummary: string): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "jobs.postCallFollowUp",
    firstName,
    facts: {
      call_transcript: transcript.slice(-6000),
      background_you_already_knew: contextSummary ? contextSummary.slice(0, 1500) : null,
    },
    maxSentences: 3,
    task: `You just got off a call with them. Text the follow-up a thoughtful friend who was really listening would send, and trust your gut on which kind fits this call best. It can be a follow-up question that picks up a thread they left open (or where they said they'd carry on by text), a piece of kind, concrete advice if they were stuck, weighing a decision, or venting, or a short reflection of what stood out to them with one question that shows you got it. Whatever you choose, start with a few of your own words that show you heard them, then the question or the advice; never send a bare question. Don't offer to keep an eye out, watch for, or look for anything. Send the one a friend would most likely send; a real follow-up every time, not a summary. Use only what THEY said on the call (never Co's own lines, never background they didn't say on the call), and never credit them with a question that was Co's. When they were stuck or weighing a decision, lean toward giving one concrete, kind thought that helps them see a way forward, and let a question be optional. Advice is a thought, not an order: plain words, no lists, no lecturing. Never announce that you were thinking about it ("Been thinking about", "Still turning over", "Kept thinking"); just say it. Call the product Co, never "Compatible" or "CoPatible", even if they did. Write straight to them as "you", never their name in the third person. Reread it before you answer: it has to make complete sense to someone reading it cold. Never recap the whole call, never mention scheduling or logistics. If the transcript has nothing real from them (for example Co did all the talking), return SKIP.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 3, maxChars: 360 } };
}

export async function markPostCallSent(followUpId: string): Promise<void> {
  await pool.query(`UPDATE post_call_follow_ups SET sent_at = NOW(), harness_status = 'sent' WHERE id = $1`, [followUpId]);
}

export async function markPostCallDropped(followUpId: string, status: string): Promise<void> {
  await pool.query(`UPDATE post_call_follow_ups SET harness_status = $2 WHERE id = $1`, [followUpId, status]);
}
