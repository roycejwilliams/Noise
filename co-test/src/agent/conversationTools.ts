import { z } from "zod";
import { tool } from "ai";
import pool from "../../../api/src/db/db.js";
import sendblue, { cleanCoMessage } from "../../../api/src/services/sendblue.js";
import { pause, splitIntoMessages } from "../routes/webhooks.js";

export type ConversationToolContext = {
  userId: string;
  phoneNumber: string;
  content: string;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  dryRun: boolean;
};

// Shared by sendReply's tool execute below AND conversationReply.ts's
// no-tool-call fallback, so the fallback doesn't need to reach into a tool's
// internal execute function to reuse this logic.
export async function deliverReply(ctx: ConversationToolContext, message: string): Promise<void> {
  // sendblue.messages.send (api/src/services/sendblue.js) already runs
  // cleanCoMessage on every send — no manual em-dash strip needed here.
  const parts = splitIntoMessages(message);
  if (ctx.dryRun) {
    // cleanCoMessage normally only runs inside sendblue.messages.send, which
    // dry-run skips — apply it here too so dry-run output reflects what
    // would actually reach the user, not the raw draft.
    console.log(
      `[conversationReply dryRun] would reply to ${ctx.userId} (${parts.length} part(s)):`,
      parts.map(cleanCoMessage),
    );
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    await pool
      .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`, [
        ctx.userId,
        `Co replied: ${part}`,
      ])
      .catch((err: any) => console.error("conversationReply: memory write failed (non-fatal):", err?.message ?? err));
    try {
      await sendblue.messages.send({
        number: ctx.phoneNumber,
        content: part,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (smsErr: any) {
      console.error(`conversationReply: send failed for ${ctx.phoneNumber} (non-fatal):`, smsErr?.message ?? smsErr);
    }
    if (i < parts.length - 1) await pause(2000);
  }
}

// Same shape as api/src/agent/conversationTools.ts (the prod harness), but
// co-test-local rather than a cross-import — sendReply here must replicate
// this file's own multi-part send/pace/log behavior (splitIntoMessages, a 2s
// gap between parts, per-part co_memories inserts with no embedding, unlike
// prod's single-message Step 7), which doesn't fit prod's sendCoReply shape.
// See the plan's "co-test-local agent" rationale for why this isn't shared.
export function createConversationTools(ctx: ConversationToolContext) {
  const state = { sent: false, offered: false, lastReplyText: "" };

  const tools = {
    sendReply: tool({
      description:
        "Send your reply to the user and log it. Call this exactly once, with your full response — always respond to what they actually said before any secondary gesture.",
      inputSchema: z.object({
        message: z.string().describe("Your full reply. A sentence or two, no em dashes, no exclamation points."),
      }),
      execute: async ({ message }) => {
        state.lastReplyText = message;
        await deliverReply(ctx, message);
        state.sent = true;
        return { ok: true };
      },
    }),

    offerCall: tool({
      description:
        `Record that your reply included a call offer — call this ONLY after sendReply, and ONLY if the message you actually sent genuinely offered/gestured toward a phone call. ` +
        (ctx.hasPendingOffer || ctx.recentOfferBurstActive
          ? "Do NOT call this right now: a call offer is already pending or was just made too recently — you may still respond warmly, just without a new call gesture."
          : "Not required — only call it if you actually used the gesture."),
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.hasPendingOffer || ctx.recentOfferBurstActive) {
          return { ok: false, reason: "blocked: pending offer or recent burst active" };
        }
        if (!state.sent) {
          return { ok: false, reason: "call sendReply first" };
        }
        state.offered = true;
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would record call_offer_pending for ${ctx.userId}`);
          return { ok: true, dryRun: true };
        }
        await pool
          .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
            ctx.userId,
            `User described: ${ctx.content} | Co offered: ${state.lastReplyText}`,
          ])
          .catch((err: any) =>
            console.error("conversationReply: call_offer_pending memory write failed (non-fatal):", err?.message ?? err),
          );
        return { ok: true };
      },
    }),
  };

  return { tools, state };
}
