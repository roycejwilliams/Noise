import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import { guardTools } from "./toolGuard.js";
import { sendLimiter } from "../services/sendLimiter.js";
import sendblue, { cleanCoMessage, sendReaction } from "../services/sendblue.js";
import { coAskedQuestion, emojiFor } from "../services/conversationClose.js";
import { writeMemory } from "../services/memory.js";
import { getMemberInvite, inviteLink, invitesLeftFor } from "../services/invites.js";
import { recordTextArrival } from "../services/eventPresence.js";
import { scoreGuestListForEvent } from "../services/eventScoring.js";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { markTopicAsked as persistTopicAsked, RAPPORT_TOPICS } from "../services/profileExtraction.js";
import { captureIntentForTurn } from "../services/profileExtraction.js";
import { generateRecommendation, recordRecommendationsSent, type RecommendationResult } from "../services/recommendation.js";
import type { TierMatch } from "../services/tieredRecommendation.js";
import { enrichMatch, renderEventDetails } from "../services/eventDetails.js";
import { resolveNamedEventGuest, requestIntroToNamedGuest } from "../services/eventGuestMatchHandoff.js";
import { askEntries } from "../harness/profileWrite.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { DateTime } from "luxon";

// A date as the member would say it, in their own zone (2026-09-22 code
// review: toDateString() used the server's zone, so a Pacific evening showed
// the next day). Null for a missing or unreadable date rather than
// "Invalid Date".
async function memberDate(userId: string): Promise<(iso: string | Date | null | undefined) => string | null> {
  const city = await pool
    .query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId])
    .then((r) => r.rows[0]?.city as string | undefined)
    .catch(() => undefined);
  const zone = (city ? await getTimezoneForCity(city).catch(() => null) : null) ?? "America/Los_Angeles";
  return (iso) => {
    if (!iso) return null;
    const d = iso instanceof Date ? DateTime.fromJSDate(iso) : DateTime.fromISO(String(iso));
    return d.isValid ? d.setZone(zone).toFormat("ccc LLL d") : null;
  };
}

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
  // Tests only: searchNow returns a placeholder instead of searching the web.
  stubSearch?: boolean;
  // The text route's full search-and-send (see ConversationReplyInput).
  searchAndSend?: (what: string) => Promise<{ answered: boolean; sentCount: number; briefing: string }>;
  // For reactInsteadOfReplying.
  messageHandle?: string | null;
  replyOwed?: boolean;
  lastCoMessage?: string | null;
  // Facts for this reply (replyGrounding). Tools add what they actually did
  // so the grounding check accepts it, and shareLink only sends links on file.
  facts?: { add: (kind: "did_this_turn" | "known" | "ongoing" | "not_done", text: string) => void; text: () => string };
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
  const state = { sent: false, reacted: false, replyCount: 0, failedSends: 0, sendStopped: false, lastReplyText: "", sentMessages: [] as string[], pendingLinks: [] as string[] };
  // Receipts (2026-09-25): anything tried this turn that didn't happen
  // becomes a fact Co writes from, so it can't say it did.
  const notDone = (what: string) => ctx.facts?.add("not_done", what);
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
        if (sent === false) {
          notDone(`The link ${url} was not sent (the send failed).`);
          continue;
        }
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
        : toolUse("sendReply"),
      inputSchema: z.object({
        message: z.string().describe("One complete reply, no em dashes. Usually a sentence or two; a walkthrough they asked for can be longer. Separate ideas or steps into short paragraphs with a blank line between them."),
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
            // Held by the send breaker, or failed twice: another try can't
            // go through and each one is a paid model call (2026-09-24: 8
            // sendReply calls in a row against a closed breaker). The agent
            // loop stops on state.sendStopped.
            state.failedSends += 1;
            if (sendLimiter.blocked(ctx.phoneNumber) || state.failedSends >= 2) {
              state.sendStopped = true;
              return { ok: false, error: "Texts to them can't go out right now. Stop here; don't call any more tools." };
            }
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

    // Co's contact card (vCard). Co decides when they want it (2026-09-25,
    // Royce: "me having to code it to send a vcard is something that it
    // should already know how to do"). A hand-written check used to veto
    // the model and missed "v card"; now the model's judgment stands and
    // the receipt keeps it honest.
    sendContactCard: tool({
      description: toolUse("sendContactCard"),
      inputSchema: z.object({
        theirWords: z.string().describe("Their words that asked for it."),
      }),
      execute: async ({ theirWords }) => {
        if (state.sentMessages.includes("[sent Co's contact card]")) return { ok: true, note: "Already sent this turn." };
        if (!process.env.CO_VCARD_URL) {
          notDone("Co's contact card was not sent (it isn't available right now).");
          return { ok: false, error: "The card isn't available right now, so it was NOT sent. Tell them plainly." };
        }
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would send contact card to ${ctx.userId}`);
        } else {
          try {
            await sendblue.messages.send({ number: ctx.phoneNumber, content: "Here's my card.", media_url: process.env.CO_VCARD_URL, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
          } catch (err: any) {
            notDone("Co's contact card was not sent (the send failed).");
            return { ok: false, error: "The card did NOT go through. Tell them plainly." };
          }
          await writeMemory(ctx.userId, "text_exchange", "Co replied: [sent Co's contact card]");
        }
        state.sentMessages.push("[sent Co's contact card]");
        ctx.facts?.add("did_this_turn", "Sent Co's contact card as its own message just before this reply.");
        return { ok: true };
      },
    }),

    // A tapback instead of a reply when the thread is winding down (2026-09-25:
    // Co's call now, not a pattern's). Hard lines kept from before: never
    // when Co still owes them an answer, and never right after Co asked them
    // something, since then their short reply is an answer.
    reactInsteadOfReplying: tool({
      description: toolUse("reactInsteadOfReplying"),
      inputSchema: z.object({
        reaction: z.enum(["like", "love", "laugh"]).describe("like for thanks or ok, love for warmth, laugh for a joke."),
      }),
      execute: async ({ reaction }) => {
        if (state.replyCount > 0) return { ok: false, error: "You already replied this turn." };
        if (ctx.replyOwed) {
          notDone("No tapback: Co still owes them an answer from before, so it has to reply.");
          return { ok: false, error: "You still owe them an answer from before. Reply properly instead." };
        }
        if (coAskedQuestion(ctx.lastCoMessage)) {
          notDone("No tapback: Co had just asked them something, so their message is an answer.");
          return { ok: false, error: "You just asked them something, so this is their answer. Reply properly." };
        }
        let how = "dry_run";
        if (!ctx.dryRun) {
          const tapped = ctx.messageHandle ? await sendReaction(ctx.messageHandle, reaction) : false;
          if (!tapped) {
            // No tapback (SMS, or an old message): one emoji says the same.
            const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: emojiFor(reaction), asVoice: false });
            if (sent === false) {
              notDone("The reaction didn't go through.");
              return { ok: false, error: "That didn't go through. Reply with a short text instead." };
            }
            await writeMemory(ctx.userId, "text_exchange", `Co replied: ${emojiFor(reaction)}`);
          }
          how = tapped ? `tapback:${reaction}` : `emoji:${reaction}`;
          await recordDecision({ layer: 3, decision: "turn.closing", userId: ctx.userId, outcome: "act", action: how, proposal: { message: ctx.resolvedContent } }).catch(() => {});
        }
        state.sent = true;
        state.reacted = true;
        return { ok: true, note: "Done. Don't send a text reply." };
      },
    }),

    // They've arrived at a Co event (2026-09-25: Co's judgment, not an
    // "I'm here" pattern). Which event, and whether it's on, stays hard in
    // services/eventPresence.ts; their in-room nudge goes out if one was
    // waiting on them.
    markArrived: tool({
      description: toolUse("markArrived"),
      inputSchema: z.object({ theirWords: z.string().describe("Their words saying they've arrived.") }),
      execute: async () => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would record arrival for ${ctx.userId}`);
          return { ok: true, note: "dry run" };
        }
        const arrived = await recordTextArrival(ctx.userId);
        if (!arrived) {
          notDone("No arrival was recorded: there's no Co event of theirs on right now.");
          return { ok: false, error: "There's no Co event of theirs on right now, so nothing was recorded. Don't welcome them to an event." };
        }
        if (arrived.isNew) {
          scoreGuestListForEvent(arrived.eventApiId, arrived.eventName).catch((err: any) =>
            console.error("markArrived: arrival re-score failed (non-fatal):", err?.message ?? err),
          );
        }
        ctx.facts?.add("did_this_turn", `They've arrived at "${arrived.eventName}" and Co recorded it.`);
        return {
          ok: true,
          note: `Recorded. Welcome them to "${arrived.eventName}" in a line. If there's someone for them to meet, that comes in its own text, so don't name anyone or promise a person here.`,
        };
      },
    }),

    // What's new in Co (2026-09-25: Co's call, not a router flag). The list
    // still goes out verbatim in its own text (Royce, 2026-09-07: asked to
    // relay it, the model paraphrased the bullets and blended in unrelated
    // things). product_updates is written by scripts/notifyTesters.ts.
    sendProductUpdates: tool({
      description: toolUse("sendProductUpdates"),
      inputSchema: z.object({}),
      execute: async () => {
        const { rows } = ctx.dryRun
          ? { rows: [{ content: "• (dry run) latest updates" }] }
          : await pool.query(`SELECT content FROM product_updates ORDER BY created_at DESC LIMIT 1`).catch(() => ({ rows: [] as any[] }));
        if (!rows[0]) {
          ctx.facts?.add("known", "There are no product updates posted.");
          return { ok: true, note: "Nothing new is posted. Say so honestly and briefly; don't invent anything." };
        }
        const message = `Here's what's new:\n\n${rows[0].content}`;
        if (!ctx.dryRun) {
          const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message, asVoice: false });
          if (sent === false) {
            notDone("The update list was not sent (the send failed).");
            return { ok: false, error: "The update list didn't go through. Tell them plainly." };
          }
          await writeMemory(ctx.userId, "text_exchange", `Co replied: ${message}`);
        }
        state.sent = true;
        state.sentMessages.push(message);
        ctx.facts?.add("did_this_turn", "Sent the latest product update list as its own message just before this reply.");
        return {
          ok: true,
          note: "The list went out verbatim. If that was all they asked, stop here: no second text pointing at it. Otherwise reply only to whatever else they said, without repeating, paraphrasing or re-listing it.",
        };
      },
    }),

    // An invite for a friend (2026-09-25: Co decides when, instead of an
    // invite pattern and a router flag deciding for it). Quotas, codes and
    // the link stay in services/invites.ts; the link goes in its own text so
    // it previews, and Co writes the words around it.
    sendInvite: tool({
      description: toolUse("sendInvite"),
      inputSchema: z.object({
        countOnly: z.boolean().describe("True when they only want to know how many invites they have left."),
      }),
      execute: async ({ countOnly }) => {
        const record = (outcome: "act" | "skip", action: string, extra: Record<string, unknown> = {}) =>
          ctx.dryRun ? Promise.resolve() : recordDecision({ layer: 3, decision: "account.invite", userId: ctx.userId, outcome, action, proposal: extra }).catch(() => {});
        if (countOnly) {
          const left = ctx.dryRun ? 5 : await invitesLeftFor(ctx.userId);
          await record("act", "count_only", { left });
          ctx.facts?.add("known", left > 0 ? `They have ${left} invite${left === 1 ? "" : "s"} left. One only counts once someone joins. (Co told them how many invites they have left; no invite link was sent.)` : "All 5 of their invites are used.");
          return { ok: true, left };
        }
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would send an invite link to ${ctx.userId}`);
          state.sentMessages.push("https://example.com/i/DRYRUN");
          ctx.facts?.add("did_this_turn", "Co just texted them an invite link for a friend, as its own message before this reply. They have 4 left; one only counts once someone joins.");
          return { ok: true };
        }
        const invite = await getMemberInvite(ctx.userId);
        if (!invite.ok) {
          await record("skip", "none_left");
          ctx.facts?.add("known", "All 5 of their invites are used, so no invite was sent.");
          return { ok: true, noneLeft: true };
        }
        const link = inviteLink(invite.code);
        const message = link ?? `Here's an invite code: ${invite.code}. They text it to me at ${process.env.SENDBLUE_PHONE_NUMBER ?? "this number"} to get in.`;
        const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message, asVoice: false });
        if (sent === false) {
          await record("skip", "send_failed", { left: invite.left });
          notDone("The invite link for their friend was not sent (the send failed).");
          return { ok: false, error: "The invite didn't go through. Tell them plainly." };
        }
        await writeMemory(ctx.userId, "text_exchange", `Co replied: ${message}`);
        state.sentMessages.push(link ?? message);
        await record("act", invite.reused ? "resent_open_code" : "made_code", { left: invite.left, link: Boolean(link), sent: true });
        ctx.facts?.add("did_this_turn", `Co just texted them an invite link for a friend, as its own message before this reply. They have ${invite.left} left; one only counts once someone joins.`);
        return { ok: true, left: invite.left };
      },
    }),

    // Save what they want so the daily search keeps looking. This is what
    // makes "I'll keep looking" true.
    saveAsk: tool({
      description: toolUse("saveAsk"),
      inputSchema: z.object({ what: z.string().describe("What they're looking for, in one plain sentence, in their words.") }),
      execute: async ({ what }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would save ask for ${ctx.userId}: "${what}"`);
        } else {
          const saved = await captureIntentForTurn(ctx.userId, `user: ${what}`, { timeoutMs: 6000 }).catch(() => null);
          if (!saved?.ask?.text) {
            notDone(`Saving "${what.slice(0, 120)}" for the daily search didn't work, so Co is NOT looking for it.`);
            return { ok: false, error: "couldn't save that as something to look for" };
          }
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
      description: toolUse("listOpenAsks"),
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.dryRun) return { ok: true, asks: [] };
        const { rows } = await pool.query(`SELECT intent, avoid FROM co_profiles WHERE user_id = $1`, [ctx.userId]);
        const entries = askEntries(rows[0]?.intent ?? null);
        const avoid: string[] = Array.isArray(rows[0]?.avoid) ? rows[0].avoid : [];
        const fmt = await memberDate(ctx.userId);
        const asks = entries
          .filter((e) => e.text)
          .map((e) => ({ text: e.text as string, type: e.type === "offering" ? "offering" : "seeking", openSince: fmt(e.created_at) }));
        // Seeking and offering read differently (2026-09-22 code review): an
        // offer is something they can give, which Co matches to people who
        // want it, not something Co is looking for on their behalf.
        const seeking = asks.filter((a) => a.type === "seeking");
        const offering = asks.filter((a) => a.type === "offering");
        const line = (a: (typeof asks)[number]) => `"${a.text}"${a.openSince ? ` (since ${a.openSince})` : ""}`;
        const parts = [
          seeking.length ? `Looking out for them: ${seeking.map(line).join("; ")}.` : "Nothing open that Co is looking out for on their behalf.",
          offering.length ? `What they've offered to others, which Co matches to people who want it: ${offering.map(line).join("; ")}.` : null,
          avoid.length ? `Kinds of things they asked Co to stop suggesting: ${avoid.map((a) => `"${a}"`).join(", ")}.` : null,
        ].filter(Boolean);
        ctx.facts?.add("known", `What Co currently has on file for them, the real complete list. ${parts.join(" ")} Never add, drop, or invent anything beyond this.`);
        return { ok: true, asks, avoid };
      },
    }),

    // "No more hackathons" (2026-09-22): turning down one event only ever
    // blocked that one event. This keeps the kind itself out of every future
    // search and sweep (co_profiles.avoid, read by eventDetails.ts's
    // explainFit), until they say they're open to it again.
    steerAwayFrom: tool({
      description: toolUse("steerAwayFrom"),
      inputSchema: z.object({
        kind: z.string().describe("The kind of thing, short and plain, in their words: \"hackathons\", \"crypto events\"."),
        undo: z.boolean().optional().describe("true when they're open to it again."),
      }),
      execute: async ({ kind, undo }) => {
        const k = kind.trim().toLowerCase().slice(0, 80);
        if (!k) return { ok: false, error: "no kind given" };
        if (ctx.dryRun) return { ok: true };
        const { rows } = await pool.query(`SELECT avoid FROM co_profiles WHERE user_id = $1`, [ctx.userId]);
        const current: string[] = Array.isArray(rows[0]?.avoid) ? rows[0].avoid : [];
        const next = undo ? current.filter((a) => a.toLowerCase() !== k) : [...current.filter((a) => a.toLowerCase() !== k), k].slice(-20);
        await pool.query(`UPDATE co_profiles SET avoid = $2 WHERE user_id = $1`, [ctx.userId, next]);
        await recordDecision({ layer: 3, decision: "reply.steerAwayFrom", userId: ctx.userId, outcome: "act", action: undo ? "removed" : "added", proposal: { kind: k, avoid: next } }).catch(() => {});
        ctx.facts?.add(
          "did_this_turn",
          undo ? `Co will suggest "${k}" again when something fits.` : `Co will stop suggesting "${k}" in every search and sweep from now on, until they say otherwise.`,
        );
        return { ok: true };
      },
    }),

    // "What did you send me?" (2026-09-22): answered from what was actually
    // sent (revealed_offers, written by both live replies and sweeps), not
    // reconstructed from the last 20 texts, which could miss something older
    // or answer differently depending on how it was asked.
    listSentOffers: tool({
      description: toolUse("listSentOffers"),
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.dryRun) return { ok: true, sent: [] };
        const { rows } = await pool.query(
          `SELECT item_name, kind, url, sent_at, reaction FROM revealed_offers
           WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '30 days'
           ORDER BY sent_at DESC LIMIT 15`,
          [ctx.userId],
        );
        if (!rows.length) {
          ctx.facts?.add("known", "Co hasn't sent them any events or opportunities in the last 30 days.");
          return { ok: true, sent: [] };
        }
        const fmt = await memberDate(ctx.userId);
        const sent = rows.map((r: any) => ({ name: r.item_name as string, kind: r.kind as string, link: (r.url as string | null) ?? null, sentOn: fmt(r.sent_at), reaction: (r.reaction as string | null) ?? null }));
        ctx.facts?.add(
          "known",
          `What Co actually sent them in the last 30 days, newest first, the real complete list: ${sent
            .map((x) => `"${x.name}"${x.link ? `, link ${x.link}` : ""}${x.sentOn ? `, sent ${x.sentOn}` : ""}${x.reaction ? `, they said: ${x.reaction.replace(/_/g, " ")}` : ""}`)
            .join("; ")}. Never add, drop, or invent anything beyond this list.`,
        );
        return { ok: true, sent };
      },
    }),

    // Search right now when they ask and nothing was searched this turn.
    searchNow: tool({
      description: toolUse("searchNow"),
      inputSchema: z.object({ what: z.string().describe("What to look for, one plain sentence.") }),
      execute: async ({ what }) => {
        if (ctx.searchedThisTurn) {
          return { ok: true, found: [], note: "A search already ran this turn and what it found was already sent to them. Do not search again, and do not say nothing came up." };
        }
        if (ctx.stubSearch) return { ok: true, found: [], note: `Test run: the search for "${what}" was skipped. Say you looked and nothing solid came up yet.` };
        // In a real turn: search and send the way Co always has, link then
        // caption for each thing that fits (routes/sendblue.ts searchAndSend).
        if (ctx.searchAndSend) {
          const r = await ctx.searchAndSend(what);
          if (r.sentCount) {
            state.sent = true;
            state.sentMessages.push(`[sent ${r.sentCount} search result(s)]`);
          }
          return {
            ok: true,
            sent: r.sentCount,
            note: `${r.briefing}${r.answered ? "\nWhat went out answers their ask. If that was all they asked, stop here: don't send another text." : ""}`,
          };
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
      description: toolUse("shareLink"),
      inputSchema: z.object({ urls: z.array(z.string()).min(1).max(3).describe("Every link for what you named, in the same order you named them.") }),
      execute: async ({ urls }) => {
        const known = urls.filter((u) => ctx.facts?.text().includes(u));
        const unknown = urls.filter((u) => !known.includes(u));
        if (!known.length) {
          notDone("A link was not sent: it isn't on file.");
          return { ok: false, error: "none of those links are on file, so they can't be sent" };
        }
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
      description: toolUse("requestEventIntro"),
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
          // Never confirm or deny who is a Co member or who was on a guest
          // list (2026-09-22): "couldn't find Sarah" and "reaching out to
          // Sarah" each tell the asker something about Sarah. The same
          // neutral answer covers both, and the internal reason stays in the
          // decision log only. The one exception is two people with the name,
          // where Co asks for a detail without saying how many there are.
          const ambiguous = /more than one/i.test(resolved.error);
          return {
            ok: true,
            note: ambiguous
              ? "Ask them for one more detail about the person (last name, what they do, what you talked about) so you reach the right one. Never say how many people have that name or that anyone else does."
              : "Tell them that if it's someone you know from that event, you'll check whether they're open to it too. Never confirm or deny that the person is someone you know, is a Co member, or was on the guest list, and don't say whether you found them.",
          };
        }
        const { rows } = await pool.query(`SELECT first_name, phone_number, email FROM users WHERE id = $1`, [ctx.userId]);
        const requester = rows[0];
        if (!requester) {
          notDone(`The intro request for ${personName} was not made.`);
          return { ok: false, error: "couldn't look up their own contact details" };
        }
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
        // The same answer as when nobody resolves, so the reply never tells
        // them whether the person is a Co member (see the note above).
        ctx.facts?.add(
          "did_this_turn",
          `Co will check with the person they named whether they're open to an intro, only if that's someone Co knows from that event. Nothing happens unless both say yes. Don't confirm whether Co knows the person.`,
        );
        return {
          ok: true,
          note: "Tell them that if it's someone you know from that event, you'll check whether they're open to it too. Never confirm or deny that the person is someone you know, is a Co member, or was on the guest list.",
        };
      },
    }),

    markTopicAsked: tool({
      description: toolUse("markTopicAsked"),
      inputSchema: z.object({
        topic: z.enum(RAPPORT_TOPICS),
      }),
      execute: async ({ topic }) => {
        if (!ctx.dryRun) persistTopicAsked(ctx.userId, topic);
        return { ok: true };
      },
    }),
  };

  // Switches, limits, their yes, receipts and the decision log (toolGuard.ts).
  guardTools(tools, { userId: ctx.userId, resolvedContent: ctx.resolvedContent, dryRun: ctx.dryRun, notDone });
  return { tools, state, flushLinks };
}
