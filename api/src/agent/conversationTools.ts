import { z } from "zod";
import { asksForContactCard, reportsCardNotReceived } from "../services/conversationClose.js";
import { tool } from "ai";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { markTopicAsked as persistTopicAsked, RAPPORT_TOPICS } from "../services/profileExtraction.js";
import { captureIntentForTurn } from "../services/profileExtraction.js";
import { generateRecommendation, recordRecommendationsSent, type RecommendationResult } from "../services/recommendation.js";
import type { TierMatch } from "../services/tieredRecommendation.js";
import { enrichMatch, renderEventDetails } from "../services/eventDetails.js";
import { resolveNamedEventGuest, requestIntroToNamedGuest } from "../services/eventGuestMatchHandoff.js";
import { askEntries } from "../harness/profileWrite.js";

// Resolves false when the message didn't go out (a refused or failed send),
// so callers only log and count what was really sent (2026-09-17 code review).
export type SendCoReply = (params: { phone: string; message: string; asVoice: boolean }) => Promise<boolean | void>;

// A search capped at capMs. Promise.race alone left the search running after
// Co had already said it found nothing (2026-09-17 code review). A result that
// lands after the cap goes to onLate when given (the caller sends it as the
// answer, services/lateSearchResult.ts), otherwise it's dropped; callers only
// record what they actually sent.
export async function searchWithTimeCap(
  userId: string,
  ask: string,
  capMs: number,
  label: string,
  onLate?: (r: RecommendationResult) => Promise<void>,
): Promise<RecommendationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const search = generateRecommendation(userId, ask).then((r) => {
    if (settled) {
      if (onLate) {
        onLate(r).catch((err: any) => console.error(`${label}: late result handling failed for ${userId} (non-fatal):`, err?.message ?? err));
      } else {
        console.log(`${label}: search for ${userId} finished after the ${capMs}ms cap, result discarded`);
      }
    }
    return r;
  });
  const cap = new Promise<RecommendationResult>((resolve) => {
    timer = setTimeout(() => resolve({ available: false, reason: "search took too long" }), capMs);
  });
  try {
    return await Promise.race([search, cap]);
  } finally {
    settled = true;
    clearTimeout(timer);
    search.catch(() => {});
  }
}

export type ConversationToolContext = {
  userId: string;
  phoneNumber: string;
  resolvedContent: string;
  isVoice: boolean;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  // The main pipeline already searched and sent results this turn, so searchNow must not
  // run again (2026-09-21: it re-ran, found only what was just sent, and the reply then said
  // "nothing solid came up" right after "two that fit, sending both now").
  searchedThisTurn?: boolean;
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
  // What searchNow found, by link, so the matches are recorded as sent only
  // once their link actually goes out (services/recommendation.ts
  // recordRecommendationsSent, 2026-09-17).
  const foundByUrl = new Map<string, TierMatch>();
  const foundWithoutLink: TierMatch[] = [];

  // A link goes out ahead of the message about it (Royce, 2026-09-16: "I
  // want the link first then description"), so the preview lands and the
  // reply reads as its caption. shareLink sends immediately; the queue and
  // the flush at the end of the turn only catch anything left over.
  const markSent = async (matches: TierMatch[]) => {
    if (!matches.length || ctx.dryRun) return;
    await recordRecommendationsSent(ctx.userId, matches).catch((err: any) =>
      console.error("conversationTools: recordRecommendationsSent failed (non-fatal):", err?.message ?? err),
    );
  };
  // A found match counts as sent once its link went out or the sent reply
  // names it.
  const markNamedInReply = async (message: string) => {
    const lower = message.toLowerCase();
    const named: TierMatch[] = [];
    for (const [url, m] of foundByUrl) if (m.name && lower.includes(m.name.toLowerCase())) (named.push(m), foundByUrl.delete(url));
    for (let i = foundWithoutLink.length - 1; i >= 0; i--) {
      if (foundWithoutLink[i].name && lower.includes(foundWithoutLink[i].name.toLowerCase())) named.push(...foundWithoutLink.splice(i, 1));
    }
    await markSent(named);
  };

  const flushLinks = async () => {
    const queued = state.pendingLinks.splice(0, state.pendingLinks.length);
    // Never the same link twice in one turn, however often it's asked for.
    const urls = [...new Set(queued)].filter((u) => !state.sentMessages.includes(u));
    for (const url of urls) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (ctx.dryRun) {
        console.log(`[conversationReply dryRun] would share link ${url} with ${ctx.userId}`);
      } else {
        const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: url, asVoice: false });
        if (sent === false) continue;
        await writeMemory(ctx.userId, "text_exchange", `Co replied: ${url}`);
        const m = foundByUrl.get(url);
        if (m) {
          foundByUrl.delete(url);
          await markSent([m]);
        }
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
        if (!ctx.dryRun) {
          const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message, asVoice: ctx.isVoice });
          // Refused or failed: nothing is logged or counted as sent, so the
          // model can try again and the fallback still runs (2026-09-17 code
          // review: a refused line was marked sent and the person got nothing).
          if (sent === false) {
            return { ok: false, error: "That message didn't go out. Rewrite it as a plain, direct text to them and call sendReply again." };
          }
        }
        state.sentMessages.push(message);
        state.lastReplyText = state.lastReplyText ? `${state.lastReplyText} ${message}` : message;
        if (ctx.dryRun) {
          // cleanCoMessage normally only runs inside sendCoReply's send
          // call, which dry-run skips — apply it here too so dry-run output
          // reflects what would actually reach the user, not the raw draft.
          console.log(`[conversationReply dryRun] would reply to ${ctx.userId}: "${cleanCoMessage(message)}"`);
        } else {
          // Logs the cleaned text, not the raw draft (Royce, 2026-09-08
          // sweep) — sendCoReply applies cleanCoMessage internally before
          // the real send, so logging the raw `message` here meant
          // recentConversation's own record of what Co said didn't always
          // match what was actually delivered (an em dash the user never
          // saw, since it was rewritten to a comma before sending).
          await writeMemory(ctx.userId, "text_exchange", `Co replied: ${cleanCoMessage(message)}`);
          await markNamedInReply(message);
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
        // "You send it over", about a link, got the contact card). A plain
        // non-receipt report ("I dont see it") isn't a fresh ask either, but
        // it IS a legitimate continuation of one — checked against whether a
        // card was actually sent recently, not guessed from wording alone
        // (2026-09-17, real incident: Jacqueline said "I dont see it" after
        // asking earlier, the tool correctly declined since that alone
        // isn't a request, and the reply agent then falsely claimed
        // "trying again" without this tool ever running a real resend).
        const askedNow = asksForContactCard(theirWords) || asksForContactCard(ctx.resolvedContent);
        let followUpToRealSend = false;
        if (!askedNow && reportsCardNotReceived(ctx.resolvedContent)) {
          const recent = await pool
            .query(
              `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange'
               AND content = 'Co replied: [sent Co''s contact card]' AND created_at > NOW() - INTERVAL '2 hours' LIMIT 1`,
              [ctx.userId],
            )
            .then((r) => r.rows.length > 0)
            .catch(() => false);
          followUpToRealSend = recent;
        }
        if (!askedNow && !followUpToRealSend) {
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

    // "A companion you can ask 'what are you working on for me' is more
    // trustworthy than one that only surfaces results when it feels like
    // it" (Royce, 2026-09-22). The daily search and sweeps already run off
    // exactly these stated asks (getActiveAsks/askEntries) — this just
    // answers honestly from the same real list instead of the model
    // guessing from conversation memory, which can drift or go stale.
    listOpenAsks: tool({
      description:
        "When they ask what you're keeping an eye out for them, what you're tracking or watching for, or what's still open/pending on their asks — call this and answer from the real list. Never guess or reconstruct this from the conversation alone; asks can be older than what's visible in recent messages, or already resolved.",
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.dryRun) return { ok: true, asks: [] };
        const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [ctx.userId]);
        const entries = askEntries(rows[0]?.intent ?? null);
        const asks = entries
          .filter((e) => e.text)
          .map((e) => ({ text: e.text as string, type: e.type ?? null, openSince: e.created_at ?? null }));
        if (!asks.length) {
          ctx.facts?.add("known", "Co has nothing open on file that it's currently searching or watching for on their behalf.");
          return { ok: true, asks: [] };
        }
        ctx.facts?.add(
          "known",
          `What Co currently has open for them, the real complete list: ${asks
            .map((a) => `"${a.text}"${a.openSince ? ` (open since ${new Date(a.openSince).toDateString()})` : ""}`)
            .join("; ")}. Never add, drop, or invent anything beyond this list.`,
        );
        return { ok: true, asks };
      },
    }),

    // Search right now when they ask and nothing was searched this turn.
    searchNow: tool({
      description:
        "Search right now for events, communities, or opportunities they're asking for, when no search already ran this turn. Returns real results with details; tell them about the best one with sendReply and share its link with shareLink.",
      inputSchema: z.object({ what: z.string().describe("What to look for, one plain sentence.") }),
      execute: async ({ what }) => {
        if (ctx.searchedThisTurn) {
          return { ok: true, found: [], note: "A search already ran this turn and what it found was already sent to them. Do not search again, and do not say nothing came up." };
        }
        const result = await searchWithTimeCap(ctx.userId, what, 40_000, "conversationTools.searchNow").catch(() => ({ available: false as const, reason: "search failed" }));
        if (!result.available || !("matches" in result) || !result.matches?.length) {
          ctx.facts?.add("did_this_turn", `Searched just now for "${what}" and found nothing real that fits yet.`);
          if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "reply.searchNow", userId: ctx.userId, outcome: "skip", action: "nothing_found", proposal: { what } });
          return { ok: true, found: [], note: "Nothing real found. Say so plainly. You can offer saveAsk so Co keeps looking." };
        }
        const found = [];
        for (const m of result.matches.slice(0, 2)) {
          const em = await enrichMatch(m, { userId: ctx.userId, firstName: "them", askText: what });
          if (em.fits === false) continue;
          if ("url" in m && m.url) foundByUrl.set(m.url, m);
          else foundWithoutLink.push(m);
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

    // "If someone they met during the event was not recommended Co can
    // still intro that person" (Royce, 2026-09-22). Only for a real person
    // from a real Co event — resolveNamedEventGuest looks them up on that
    // event's actual guest list, never invents someone.
    requestEventIntro: tool({
      description:
        "When they say they met someone specific at a Co event who Co never nudged them about, and they want to be connected — look that person up on the real guest list and start the same double opt-in intro Co uses for its own matches. Only for a real person from a real Co event they actually attended, never a stranger with no shared event.",
      inputSchema: z.object({
        personName: z.string().describe("The first name (or full name) they used for the person they met."),
      }),
      execute: async ({ personName }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would look up "${personName}" for ${ctx.userId} to request an intro`);
          return { ok: true, note: "dry run" };
        }
        const resolved = await resolveNamedEventGuest(ctx.userId, personName);
        if ("error" in resolved) {
          await recordDecision({
            layer: 3,
            decision: "reply.requestEventIntro",
            userId: ctx.userId,
            outcome: "skip",
            action: "not_found",
            proposal: { personName },
            checks: [{ name: "resolved_on_guest_list", pass: false, reason: resolved.error }],
          }).catch(() => {});
          return { ok: false, error: `${resolved.error}. Tell them plainly, don't guess who they mean.` };
        }
        const { rows } = await pool.query(`SELECT first_name, phone_number, email FROM users WHERE id = $1`, [ctx.userId]);
        const requester = rows[0];
        if (!requester) return { ok: false, error: "couldn't look up their own contact details" };
        await requestIntroToNamedGuest(
          resolved.eventId,
          resolved.eventName,
          { user_id: ctx.userId, first_name: requester.first_name, phone_number: requester.phone_number, email: requester.email },
          resolved.target,
        ).catch((err: any) => console.error("requestEventIntro: requestIntroToNamedGuest failed (non-fatal):", err?.message ?? err));
        await recordDecision({
          layer: 3,
          decision: "reply.requestEventIntro",
          userId: ctx.userId,
          outcome: "act",
          action: "requested",
          proposal: { personName, eventId: resolved.eventId, targetId: resolved.target.user_id },
        }).catch(() => {});
        ctx.facts?.add(
          "did_this_turn",
          `Co found ${resolved.target.first_name} on the guest list for "${resolved.eventName}" and started the same intro process it uses for its own matches — it'll ask ${resolved.target.first_name} too, and only connect them once both say yes.`,
        );
        return { ok: true, note: "Tell them plainly that Co's reaching out to that person to see if they're open to it too — it's not instant, both have to say yes." };
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
