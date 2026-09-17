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
    task: `You talked on the phone a little while ago. Pick exactly ONE specific thing they said on the call and send a short text about only that: a callback with one light question, or a warm observation with no question. It should prove you were listening. Never recap the call, never mention next steps, scheduling, or anything operational. If the transcript has nothing specific from them (for example Co did all the talking), return SKIP.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 200 } };
}

export async function markPostCallSent(followUpId: string): Promise<void> {
  await pool.query(`UPDATE post_call_follow_ups SET sent_at = NOW(), harness_status = 'sent' WHERE id = $1`, [followUpId]);
}

export async function markPostCallDropped(followUpId: string, status: string): Promise<void> {
  await pool.query(`UPDATE post_call_follow_ups SET harness_status = $2 WHERE id = $1`, [followUpId, status]);
}
