import { z } from "zod";
import { asksForContactCard } from "../services/conversationClose.js";
import { tool } from "ai";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { recordDecision } from "../harness/core.js";
import { markTopicAsked as persistTopicAsked, RAPPORT_TOPICS } from "../services/profileExtraction.js";
import { captureIntentForTurn } from "../services/profileExtraction.js";
import { generateRecommendation } from "../services/recommendation.js";
import { enrichMatch, renderEventDetails } from "../services/eventDetails.js";

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
  // Facts for this reply (replyGrounding). Tools add what they actually did
  // so the grounding check accepts it, and shareLink only sends links on file.
  facts?: { add: (kind: "did_this_turn" | "known" | "ongoing", text: string) => void; text: () => string };
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
  const state = { sent: false, replyCount: 0, lastReplyText: "", sentMessages: [] as string[], pendingLinks: [] as string[] };

  // A link goes out ahead of the message about it (Royce, 2026-09-16: "I
  // want the link first then description"), so the preview lands and the
  // reply reads as its caption. shareLink sends immediately; the queue and
  // the flush at the end of the turn only catch anything left over.
  const flushLinks = async () => {
    const queued = state.pendingLinks.splice(0, state.pendingLinks.length);
    // Never the same link twice in one turn, however often it's asked for.
    const urls = [...new Set(queued)].filter((u) => !state.sentMessages.includes(u));
    for (const url of urls) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (ctx.dryRun) {
        console.log(`[conversationReply dryRun] would share link ${url} with ${ctx.userId}`);
      } else {
        await ctx.sendCoReply({ phone: ctx.phoneNumber, message: url, asVoice: false });
        await writeMemory(ctx.userId, "text_exchange", `Co replied: ${url}`);
      }
      state.sentMessages.push(url);
    }
  };

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
      description:
        "Send Co's contact card (vCard), only when they ask for YOUR contact details: \"send your contact card\", \"what's your number\", \"how do I save you\". Never for anything else they ask you to send, like a link or an event. Still send a short reply with sendReply.",
      inputSchema: z.object({
        theirWords: z.string().describe("The exact words where they asked for your contact card or number."),
      }),
      execute: async ({ theirWords }) => {
        if (!process.env.CO_VCARD_URL) return { ok: false, error: "no contact card configured" };
        // They have to have actually asked for Co's contact (2026-09-16:
        // "You send it over", about a link, got the contact card).
        if (!asksForContactCard(theirWords) && !asksForContactCard(ctx.resolvedContent)) {
          if (!ctx.dryRun) {
            await recordDecision({
              layer: 3,
              decision: "reply.contactCard",
              userId: ctx.userId,
              outcome: "skip",
              action: "not_asked_for",
              proposal: { theirWords, message: ctx.resolvedContent },
              checks: [{ name: "asked_for_cos_contact", pass: false, reason: "they asked for something else" }],
            }).catch(() => {});
          }
          return { ok: false, error: "they didn't ask for your contact card, so it wasn't sent. Send what they actually asked for." };
        }
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

    // Save what they want so the daily search keeps looking. This is what
    // makes "I'll keep looking" true.
    saveAsk: tool({
      description:
        "Save something they want Co to look for (people, events, a community, an opportunity) so Co's daily search keeps looking and can text them when something real fits. Use when they ask for something and nothing fits right now, or they want Co to keep an eye out.",
      inputSchema: z.object({ what: z.string().describe("What they're looking for, in one plain sentence, in their words.") }),
      execute: async ({ what }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would save ask for ${ctx.userId}: "${what}"`);
        } else {
          const saved = await captureIntentForTurn(ctx.userId, `user: ${what}`, { timeoutMs: 6000 }).catch(() => null);
          if (!saved?.ask?.text) return { ok: false, error: "couldn't save that as something to look for" };
          await recordDecision({ layer: 3, decision: "reply.saveAsk", userId: ctx.userId, outcome: "act", action: saved.deduped ? "updated_ask" : "saved_ask", proposal: { what, saved: saved.ask.text } });
        }
        ctx.facts?.add("ongoing", `Co's daily search is now looking for: "${what}". If something real fits, Co may text them (at most one text a day). Co can't promise it will find anything, or when.`);
        return { ok: true, note: "Saved. You can say you'll keep looking and text them if something real fits. Don't promise a time." };
      },
    }),

    // Search right now when they ask and nothing was searched this turn.
    searchNow: tool({
      description:
        "Search right now for events, communities, or opportunities they're asking for, when no search already ran this turn. Returns real results with details; tell them about the best one with sendReply and share its link with shareLink.",
      inputSchema: z.object({ what: z.string().describe("What to look for, one plain sentence.") }),
      execute: async ({ what }) => {
        const result = await Promise.race([
          generateRecommendation(ctx.userId, what),
          new Promise<{ available: false; reason: string }>((resolve) => setTimeout(() => resolve({ available: false, reason: "search took too long" }), 40_000)),
        ]).catch(() => ({ available: false as const, reason: "search failed" }));
        if (!result.available || !("matches" in result) || !result.matches?.length) {
          ctx.facts?.add("did_this_turn", `Searched just now for "${what}" and found nothing real that fits yet.`);
          if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "reply.searchNow", userId: ctx.userId, outcome: "skip", action: "nothing_found", proposal: { what } });
          return { ok: true, found: [], note: "Nothing real found. Say so plainly. You can offer saveAsk so Co keeps looking." };
        }
        const found = [];
        for (const m of result.matches.slice(0, 2)) {
          const em = await enrichMatch(m, { userId: ctx.userId, firstName: "them", askText: what });
          if (em.fits === false) continue;
          const lines = em.details ? renderEventDetails(em.name, em.details) : em.opportunity ? [`What the post says: ${em.opportunity.postText}`] : [];
          ctx.facts?.add("known", `Found just now: "${em.name}"${"url" in em && em.url ? `, link ${em.url}` : ""}. ${lines.join(" ")}${em.whyItFits ? ` Why it fits: ${em.whyItFits}` : ""}`);
          found.push({ name: em.name, link: "url" in em ? em.url ?? null : null, details: lines, whyItFits: em.whyItFits ?? m.reason });
        }
        if (!found.length) {
          ctx.facts?.add("did_this_turn", `Searched just now for "${what}"; what came up didn't fit what they asked.`);
          return { ok: true, found: [], note: "Nothing that fits. Say so plainly. You can offer saveAsk so Co keeps looking." };
        }
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "reply.searchNow", userId: ctx.userId, outcome: "act", action: "found", proposal: { what, found: found.map((f) => f.name) } });
        return { ok: true, found };
      },
    }),

    // Send a link as its own message, only if it's actually on file.
    shareLink: tool({
      description:
        "Share the link (or links) for what you're about to tell them about. Each one is sent as its own message so it previews, and they go out BEFORE your reply, in the order you list them, so call this first and then describe them with sendReply. If you mention two things, share both links. Only links that appear in the facts you were given.",
      inputSchema: z.object({ urls: z.array(z.string()).min(1).max(3).describe("Every link for what you named, in the same order you named them.") }),
      execute: async ({ urls }) => {
        const known = urls.filter((u) => ctx.facts?.text().includes(u));
        const unknown = urls.filter((u) => !known.includes(u));
        if (!known.length) return { ok: false, error: "none of those links are on file, so they can't be sent" };
        state.pendingLinks.push(...known);
        for (const url of known) ctx.facts?.add("did_this_turn", `Sent the link ${url} as its own message.`);
        await flushLinks();
        return unknown.length ? { ok: true, note: `These weren't on file and weren't sent: ${unknown.join(", ")}` } : { ok: true };
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

  return { tools, state, flushLinks };
}
