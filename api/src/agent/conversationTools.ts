import { z } from "zod";
import { tool } from "ai";
import { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { markTopicAsked as persistTopicAsked, RAPPORT_TOPICS } from "../services/profileExtraction.js";
import pool from "../db/db.js";

export type SendCoReply = (params: { phone: string; message: string; asVoice: boolean }) => Promise<void>;

export type ConversationToolContext = {
  userId: string;
  phoneNumber: string;
  resolvedContent: string;
  isVoice: boolean;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  dryRun: boolean;
  sendCoReply: SendCoReply;
};

// Side-effecting tools are bound to server-known context (userId,
// phoneNumber, the two hard call-offer gates) rather than letting the model
// supply them — same principle as agent/tools.ts's ask-checkin tools.
export function createConversationTools(ctx: ConversationToolContext) {
  // sent/offered are out-of-band signals for the caller (sendblue.ts), same
  // reasoning as askCheckin.ts's state.sent — generateText's return value
  // doesn't cleanly expose which tools actually executed.
  const state = { sent: false, offered: false, lastReplyText: "" };

  const tools = {
    sendReply: tool({
      description:
        "Send your reply to the user (text or voice note, matches how they contacted Co) and log it. Call this exactly once, with your full response — always respond to what they actually said before any secondary gesture.",
      inputSchema: z.object({
        message: z.string().describe("Your full reply. 2 sentences max, no em dashes, no exclamation points."),
      }),
      execute: async ({ message }) => {
        state.lastReplyText = message;
        if (ctx.dryRun) {
          // cleanCoMessage normally only runs inside sendCoReply's send
          // call, which dry-run skips — apply it here too so dry-run output
          // reflects what would actually reach the user, not the raw draft.
          console.log(`[conversationReply dryRun] would reply to ${ctx.userId}: "${cleanCoMessage(message)}"`);
        } else {
          await ctx.sendCoReply({ phone: ctx.phoneNumber, message, asVoice: ctx.isVoice });
          await writeMemory(ctx.userId, "text_exchange", `Co replied: ${message}`);
        }
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
            `User described: ${ctx.resolvedContent} | Co offered: ${state.lastReplyText}`,
          ])
          .catch((err: any) =>
            console.error("conversationReply: call_offer_pending memory write failed (non-fatal):", err?.message ?? err),
          );
        return { ok: true };
      },
    }),

    markTopicAsked: tool({
      description:
        "Record that you actually asked about a rapport topic in the reply you sent. Only call this if you used the suggested topic in the message you sent via sendReply.",
      inputSchema: z.object({
        topic: z.enum(RAPPORT_TOPICS),
      }),
      execute: async ({ topic }) => {
        if (!ctx.dryRun) persistTopicAsked(ctx.userId, topic);
        return { ok: true };
      },
    }),
  };

  return { tools, state };
}
