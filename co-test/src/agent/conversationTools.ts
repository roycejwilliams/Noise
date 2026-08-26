import { z } from "zod";
import { tool } from "ai";
import pool from "../../../api/src/db/db.js";
import sendblue, { cleanCoMessage } from "../../../api/src/services/sendblue.js";
import { pause, capMessageLength } from "../routes/webhooks.js";

export type ConversationToolContext = {
  userId: string;
  phoneNumber: string;
  content: string;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  dryRun: boolean;
};

// Sends ONE message — no more mechanically slicing one long draft into two
// via splitIntoMessages. That approach is what produced the leading-dash/
// comma bug (a split landing mid-clause on a dash boundary) and, more
// fundamentally, wasn't how people actually double-text: it cut one
// continuous thought in half by character count, not two genuinely separate
// thoughts. Multiple real texts now come from the model calling sendReply
// more than once (see createConversationTools below) — each call is one
// complete text, capped defensively so a single call can't itself become a
// wall of text, but never auto-split.
async function sendOneMessage(ctx: ConversationToolContext, message: string): Promise<void> {
  const capped = capMessageLength(message);
  if (ctx.dryRun) {
    // cleanCoMessage normally only runs inside sendblue.messages.send, which
    // dry-run skips — apply it here too so dry-run output reflects what
    // would actually reach the user, not the raw draft.
    console.log(`[conversationReply dryRun] would reply to ${ctx.userId}: "${cleanCoMessage(capped)}"`);
    return;
  }
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`, [
      ctx.userId,
      `Co replied: ${capped}`,
    ])
    .catch((err: any) => console.error("conversationReply: memory write failed (non-fatal):", err?.message ?? err));
  try {
    await sendblue.messages.send({
      number: ctx.phoneNumber,
      content: capped,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (smsErr: any) {
    console.error(`conversationReply: send failed for ${ctx.phoneNumber} (non-fatal):`, smsErr?.message ?? smsErr);
  }
}

// Kept for conversationReply.ts's no-tool-call fallback (the model finished
// without ever calling sendReply) — always exactly one message in that case.
export async function deliverReply(ctx: ConversationToolContext, message: string): Promise<void> {
  await sendOneMessage(ctx, message);
}

// Same shape as api/src/agent/conversationTools.ts (the prod harness), but
// co-test-local rather than a cross-import — sendReply here must replicate
// this file's own per-message send/log behavior (per-call co_memories
// inserts with no embedding, unlike prod's single-message Step 7), which
// doesn't fit prod's sendCoReply shape. See the plan's "co-test-local agent"
// rationale for why this isn't shared.
//
// No offerCall tool here (removed) — a real conversation confirmed the model
// self-declaring "I included a call offer" via a second tool call is not
// reliable: it called offerCall right after a reply that never mentioned a
// call at all, which set a false call_offer_pending and, combined with a
// pre-existing classifier gap, led to two unwanted real outbound calls. This
// is exactly the failure mode the original pre-harness code's post-hoc
// verification existed to prevent. That verification is restored in
// conversationReply.ts (verifyAndRecordCallOffer) — it reads the actual sent
// text after the fact, rather than trusting a self-report.
export function createConversationTools(ctx: ConversationToolContext) {
  const state = { sent: false, replyCount: 0, lastReplyText: "" };

  const tools = {
    // Genuinely callable more than once now — see the description below.
    // The old design generated one long draft and mechanically sliced it by
    // character count (splitIntoMessages), which is what produced the
    // leading-dash/comma bug: a cut landing mid-clause on a dash boundary.
    // It also wasn't how people actually double-text — that's two separate
    // thoughts, not one thought cut in half. Now each call is one complete
    // text; a second genuinely separate thought is a second call, paced with
    // the same real gap the old mechanical split used.
    sendReply: tool({
      description:
        "Send one text message to the user, and log it. Call this once for your reply. If you genuinely have two distinct thoughts that would read more naturally as two separate texts sent one after another — the way a person might send a quick reaction, then a follow-up — you may call it a second time. Most replies are a single call; never call it twice just to split one continuous thought into shorter pieces.",
      inputSchema: z.object({
        message: z.string().describe("One complete text message. A sentence or two, no em dashes, no exclamation points."),
      }),
      execute: async ({ message }) => {
        if (state.replyCount > 0) await pause(2000);
        state.lastReplyText = state.lastReplyText ? `${state.lastReplyText} ${message}` : message;
        await sendOneMessage(ctx, message);
        state.sent = true;
        state.replyCount += 1;
        return { ok: true };
      },
    }),
  };

  return { tools, state };
}
