import { z } from "zod";
import { tool } from "ai";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { recordDecision } from "../harness/core.js";
import { markTopicAsked as persistTopicAsked, RAPPORT_TOPICS } from "../services/profileExtraction.js";

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
  // Layer 3 grounding gate (harness/replyGrounding.ts): runs on each drafted
  // message before it's sent or logged, and returns what actually goes out.
  gate?: (draft: string, sentThisTurn: string[]) => Promise<string>;
};

// Side-effecting tools are bound to server-known context (userId,
// phoneNumber, the two hard call-offer gates) rather than letting the model
// supply them.
//
// No offerCall tool here (removed) — a real conversation confirmed the model
// self-declaring "I included a call offer" via a second tool call is not
// reliable: it called offerCall right after a reply that never mentioned a
// call at all, which set a false call_offer_pending and, combined with a
// pre-existing classifier gap, led to two unwanted real outbound calls. This
// is exactly the failure mode the original pre-harness code's post-hoc
// callOfferCheck verification existed to prevent. That verification is
// restored in conversationReply.ts (verifyAndRecordCallOffer) — it reads the
// actual sent text after the fact, rather than trusting a self-report.
export function createConversationTools(ctx: ConversationToolContext) {
  // sent is an out-of-band signal for the caller (sendblue.ts), same
  // reasoning as askCheckin.ts's state.sent — generateText's return value
  // doesn't cleanly expose which tools actually executed.
  const state = { sent: false, replyCount: 0, lastReplyText: "", sentMessages: [] as string[] };

  const tools = {
    // Genuinely callable more than once for a text reply (never for a voice
    // note — one clip naturally holds two thoughts spoken in a row, unlike
    // two separate SMS bubbles). A second call is paced with a real gap, the
    // same way co-test's version double-texts.
    sendReply: tool({
      description: ctx.isVoice
        ? "Send your voice-note reply to the user and log it. Call this exactly once, with your full response — always respond to what they actually said before any secondary gesture."
        : "Send one text message to the user, and log it. Call this once for your reply. If you genuinely have two distinct thoughts that would read more naturally as two separate texts sent one after another — the way a person might send a quick reaction, then a follow-up — you may call it a second time. Most replies are a single call; never call it twice just to split one continuous thought into shorter pieces.",
      inputSchema: z.object({
        message: z.string().describe("One complete reply. A sentence or two, no em dashes."),
      }),
      execute: async ({ message: draft }) => {
        const message = ctx.gate ? await ctx.gate(draft, [...state.sentMessages]) : draft;
        if (state.replyCount > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
        state.sentMessages.push(message);
        state.lastReplyText = state.lastReplyText ? `${state.lastReplyText} ${message}` : message;
        if (ctx.dryRun) {
          // cleanCoMessage normally only runs inside sendCoReply's send
          // call, which dry-run skips — apply it here too so dry-run output
          // reflects what would actually reach the user, not the raw draft.
          console.log(`[conversationReply dryRun] would reply to ${ctx.userId}: "${cleanCoMessage(message)}"`);
        } else {
          await ctx.sendCoReply({ phone: ctx.phoneNumber, message, asVoice: ctx.isVoice });
          // Logs the cleaned text, not the raw draft (Royce, 2026-09-08
          // sweep) — sendCoReply applies cleanCoMessage internally before
          // the real send, so logging the raw `message` here meant
          // recentConversation's own record of what Co said didn't always
          // match what was actually delivered (an em dash the user never
          // saw, since it was rewritten to a comma before sending).
          await writeMemory(ctx.userId, "text_exchange", `Co replied: ${cleanCoMessage(message)}`);
        }
        state.sent = true;
        state.replyCount += 1;
        return { ok: true };
      },
    }),

    // Real action behind "can you send your contact card": the same vCard
    // intake sends, so they can save Co.
    sendContactCard: tool({
      description: "Send Co's contact card (vCard) so they can save Co's contact. Use when they ask for your contact or card, or want to save you. Still send a short reply with sendReply.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.CO_VCARD_URL) return { ok: false, error: "no contact card configured" };
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would send contact card to ${ctx.userId}`);
        } else {
          await sendblue.messages.send({ number: ctx.phoneNumber, content: "Here's my card.", media_url: process.env.CO_VCARD_URL, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
          await writeMemory(ctx.userId, "text_exchange", "Co replied: [sent Co's contact card]");
        }
        state.sentMessages.push("[sent Co's contact card]");
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "reply.contactCard", userId: ctx.userId, outcome: "act", action: "sent_contact_card" });
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
