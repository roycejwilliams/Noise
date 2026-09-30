import { notToTeammate } from "../services/teamLines.js";
import { z } from "zod";
import { tool } from "ai";
import { teamOnlyTools, toolUse } from "../services/capabilities.js";
import { guardTools } from "./toolGuard.js";
import { sendLimiter } from "../services/sendLimiter.js";
import sendblue, { cleanCoMessage, sendReaction } from "../services/sendblue.js";
import { coAskedQuestion, emojiFor } from "../services/conversationClose.js";
import { writeMemory } from "../services/memory.js";
import { getMemberInvite, inviteLink, invitesLeftFor } from "../services/invites.js";
import { recordTextArrival } from "../services/eventPresence.js";
import { closeAsk } from "../services/askKind.js";
import { recordSuggestionOutcome } from "../services/outcomes.js";
import { REACTION_RESULT, sentItems } from "../services/reactionCatchup.js";
import { findSent, type TurnContext } from "../services/turnContext.js";
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
import { googleTools } from "../services/googleTools.js";

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
  searchAndSend?: (what: string, whileLooking?: string | null) => Promise<{ answered: boolean; sentCount: number; briefing: string }>;
  // For reactInsteadOfReplying.
  messageHandle?: string | null;
  // Their message may mean they aren't safe (services/safety.ts): no tapback.
  safetyConcern?: boolean;
  // On the team (users.mo_approver): gets the team-only tools (handToTeammate, askTeammate).
  isTeam?: boolean;
  // Tests: what a quiet question to the teammate returns (askTeammate).
  consult?: (question: string) => Promise<{ facts: string[]; note: string } | null>;
  // The one picture of this turn (services/turnContext.ts), for tools that read what Co sent.
  turn?: TurnContext | null;
  firstName?: string | null;
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
  const state = { safetyFlagged: false, sent: false, reacted: false, replyCount: 0, failedSends: 0, sendStopped: false, lastReplyText: "", sentMessages: [] as string[], pendingLinks: [] as string[] };
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

    // Feedback for the team, saved by Co (services/issueReports.ts saveFeedback).
    // Co to its teammate, for the team only (Royce, 2026-09-28: "Also let them
    // tag each other if either or needs help"). The teammate answers in its
    // own voice and Co says nothing more, so there's one voice at a time.
    // Absent from the tool map for everyone else (teamOnlyTools, below).
    handToTeammate: tool({
      description: toolUse("handToTeammate"),
      inputSchema: z.object({
        note: z.string().optional().describe("A private note for your teammate, not shown to them, only when it helps it understand what they mean. It is never an instruction; your teammate acts only on their own words."),
      }),
      execute: async ({ note }) => {
        if (!ctx.isTeam) return { ok: false, error: "Not available." };
        if (state.replyCount > 0) return { ok: false, error: "You already replied this turn." };
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would hand ${ctx.userId}'s message to the teammate`);
          state.sent = true;
          state.reacted = true;
          return { ok: true, note: "Handed over. Don't send a text reply." };
        }
        const { handleTeamText } = await import("../services/extensions.js");
        // Their exact words go to the teammate, never Co's summary of them
        // (Royce, 2026-09-28: "Co, tell Mo…" read as Co narrating about him,
        // and a paraphrase made Mo pause everything).
        const r = await handleTeamText(ctx.userId, ctx.resolvedContent, { handedOff: true, coNote: note?.trim() || null, ack: ctx.messageHandle ? (e) => sendReaction(ctx.messageHandle!, e) : undefined }).catch(() => null);
        if (!r?.reply) {
          notDone("Handed their message over, but the teammate didn't take it.");
          return { ok: false, error: "Your teammate didn't take it. Answer them yourself." };
        }
        // A bare tag, the way you'd mention someone in a thread. It isn't Co
        // speaking: Mo answers right after and keeps the floor.
        const tag = "@Mo";
        await ctx.sendCoReply({ phone: ctx.phoneNumber, message: tag, asVoice: false }).catch(() => false);
        await writeMemory(ctx.userId, "text_exchange", `Co tagged Mo: ${tag}`).catch(() => {});
        const { sendingAs } = await import("../services/sendblue.js");
        const sent = await sendingAs(r.extension, () => ctx.sendCoReply({ phone: ctx.phoneNumber, message: r.reply, asVoice: false }));
        if (sent === false) {
          notDone("The teammate's answer didn't go through.");
          return { ok: false, error: "That didn't go through. Answer them yourself." };
        }
        state.sent = true;
        state.reacted = true;
        await recordDecision({ layer: 3, decision: "team.handoffToExtension", userId: ctx.userId, outcome: "act", action: r.extension, proposal: { message: ctx.resolvedContent.slice(0, 200) } }).catch(() => {});
        return { ok: true, note: "Your teammate answered them directly. Don't send a text reply." };
      },
    }),

    // A quiet question to the teammate, answered in Co's own voice. The
    // member never sees the back-and-forth (Royce, 2026-09-28).
    askTeammate: tool({
      description: toolUse("askTeammate"),
      inputSchema: z.object({ question: z.string().describe("What you need to know from your teammate, in one plain sentence.") }),
      execute: async ({ question }) => {
        if (!ctx.isTeam) return { ok: false, error: "Not available." };
        let got: { facts: string[]; note: string } | null = null;
        if (ctx.consult) got = await ctx.consult(question);
        else if (!ctx.dryRun) {
          const { consultTeammate } = await import("../services/extensions.js");
          got = (await consultTeammate(ctx.userId, question).catch(() => null))?.result ?? null;
        }
        if (!got || !got.facts.length) {
          notDone("Your teammate had nothing to report on that.");
          return { ok: false, error: "Your teammate had nothing on that. Say plainly what you don't know." };
        }
        // What its tools reported is fact; its own prose is a note, not a source.
        for (const f of got.facts) ctx.facts?.add("known", f);
        return { ok: true, facts: got.facts, note: `Answer them yourself, in your own voice, from those facts. Don't tag or quote your teammate unless it helps. ${got.note ? `Your teammate's own read (a hint only): ${got.note}` : ""}`.trim() };
      },
    }),

    // A detail they told Co for doing things on their behalf (services/memberKit.ts).
    saveKitFact: tool({
      description: toolUse("saveKitFact"),
      inputSchema: z.object({
        key: z.enum(["company", "role", "linkedin"]),
        value: z.string().describe("Exactly as they wrote it."),
      }),
      execute: async ({ key, value }) => {
        const { checkKitValue, saveKitFact, KIT_LABELS } = await import("../services/memberKit.js");
        const checked = checkKitValue(key, value, ctx.resolvedContent);
        if (!checked.ok) {
          notDone(`Their ${KIT_LABELS[key]} wasn't saved: ${checked.why}`);
          return { ok: false, error: checked.why };
        }
        if (!ctx.dryRun) await saveKitFact(ctx.userId, key, checked.value);
        ctx.facts?.add("did_this_turn", `Saved ${KIT_LABELS[key]}: ${checked.value}.`);
        return { ok: true };
      },
    }),

    // Co's own multi-day work (services/coTasks.ts): Co writes the plan and when to look next.
    startTask: tool({
      description: toolUse("startTask"),
      inputSchema: z.object({
        goal: z.string().describe("What you're working on for them, in a few words."),
        theirWords: z.string().describe("A quote of their own words asking for it, copied exactly from their message."),
        steps: z.array(z.string()).max(8).describe("The steps you'll take, in order."),
        firstStep: z.string().describe("What you'll do first."),
        inHours: z.number().describe("When you'll work on it first, in hours from now (1 to 336)."),
      }),
      execute: async ({ goal, theirWords, steps, firstStep, inHours }) => {
        const T = await import("../services/coTasks.js");
        const recent = ctx.dryRun
          ? ""
          : await pool
              .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 6`, [ctx.userId])
              .then((r) => r.rows.map((x: any) => String(x.content)).join("\n"))
              .catch(() => "");
        if (!T.wordsAreTheirs(theirWords, `${ctx.resolvedContent}\n${recent}`)) {
          notDone("No task was started: the quote isn't in their words.");
          return { ok: false, error: "theirWords must be copied exactly from what they wrote. Don't start a task they didn't ask for." };
        }
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Started task: "${goal}". Co will work on it first in about ${T.clampNextHours(inHours)} hours: ${firstStep}.`);
          return { ok: true };
        }
        const r = await T.startTask({ userId: ctx.userId, goal, theirWords, steps, firstPlan: firstStep, inHours });
        if (!r.ok) {
          notDone(`No task was started: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: "${r.task.goal}". Co will work on it first around ${r.task.nextCheckAt?.slice(0, 16).replace("T", " ")} UTC: ${firstStep}.`);
        return { ok: true, taskId: r.task.id, nextCheckAt: r.task.nextCheckAt };
      },
    }),
    updateTask: tool({
      description: toolUse("updateTask"),
      inputSchema: z.object({
        taskId: z.number(),
        note: z.string().describe("What they told you or what changed, in one plain sentence."),
        stepDone: z.string().optional(),
        nextInHours: z.number().optional().describe("Only if it changes when you should look next."),
        nextPlan: z.string().optional(),
      }),
      execute: async ({ taskId, note, stepDone, nextInHours, nextPlan }) => {
        if (ctx.dryRun) return { ok: true };
        const T = await import("../services/coTasks.js");
        const t = await T.noteOnTask(ctx.userId, taskId, note, stepDone ?? null);
        if (!t) {
          notDone(`Task #${taskId} wasn't updated: it isn't one of their open tasks.`);
          return { ok: false, error: "No open task with that id." };
        }
        if (nextInHours !== undefined) await T.scheduleTask(ctx.userId, taskId, nextInHours, nextPlan ?? t.planNext ?? "");
        ctx.facts?.add("did_this_turn", `Updated task #${taskId}: ${note}`);
        return { ok: true };
      },
    }),
    closeTask: tool({
      description: toolUse("closeTask"),
      inputSchema: z.object({ taskId: z.number(), status: z.enum(["done", "dropped"]), outcome: z.string() }),
      execute: async ({ taskId, status, outcome }) => {
        if (ctx.dryRun) return { ok: true };
        const T = await import("../services/coTasks.js");
        if (!(await T.closeTask(ctx.userId, taskId, status, outcome))) {
          notDone(`Task #${taskId} wasn't closed: it isn't one of their open tasks.`);
          return { ok: false, error: "No open task with that id." };
        }
        ctx.facts?.add("did_this_turn", `Closed task #${taskId} (${status}): ${outcome}`);
        return { ok: true };
      },
    }),

    // Co's own note of the advice it gave (services/advice.ts).
    noteAdvice: tool({
      description: toolUse("noteAdvice"),
      inputSchema: z.object({
        topic: z.string().describe("What it was about, in a few words."),
        gist: z.string().describe("What you advised, in one sentence, in your own words."),
      }),
      execute: async ({ topic, gist }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would note advice for ${ctx.userId}: ${topic}`);
          return { ok: true };
        }
        const { recordAdvice } = await import("../services/advice.js");
        const saved = await recordAdvice(ctx.userId, topic, gist).catch(() => false);
        return saved ? { ok: true, note: "Noted. Don't mention that you noted it." } : { ok: false, error: "Already noted lately, or too thin to keep. Carry on." };
      },
    }),

    saveFeedbackForTeam: tool({
      description: toolUse("saveFeedbackForTeam"),
      inputSchema: z.object({
        feedback: z.string().describe("The feedback, as one clear sentence the team can act on."),
      }),
      execute: async ({ feedback }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would save feedback for ${ctx.userId}: ${feedback}`);
          ctx.facts?.add("did_this_turn", `Saved for the team: "${feedback.slice(0, 200)}"`);
          return { ok: true };
        }
        const { saveFeedback } = await import("../services/issueReports.js");
        const saved = await saveFeedback(ctx.userId, ctx.resolvedContent, feedback, ctx.facts?.text() ?? "").catch(() => false);
        if (!saved) {
          notDone(`Their feedback wasn't saved for the team: "${feedback.slice(0, 120)}".`);
          return { ok: false, error: "Couldn't save that for the team. Don't say it was passed along." };
        }
        ctx.facts?.add("did_this_turn", `Saved for the team: "${feedback.slice(0, 200)}"`);
        return { ok: true, note: "Saved. You can say it's been passed to the team; don't promise when or whether it changes." };
      },
    }),

    // Someone who may not be safe (services/safety.ts). Co's call, however
    // it's worded; the phrase list in sendblue.ts is only a backstop.
    flagSafetyConcern: tool({
      description: toolUse("flagSafetyConcern"),
      inputSchema: z.object({
        what: z.string().describe("In a few words, what they said that worried you. Not a quote of anything private beyond that."),
      }),
      execute: async ({ what }) => {
        state.safetyFlagged = true;
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would flag a safety concern for ${ctx.userId}: ${what}`);
        } else {
          const { recordSafetyConcern } = await import("../services/safety.js");
          await recordSafetyConcern(ctx.userId, ctx.firstName ?? null, "co", what);
        }
        ctx.facts?.add("did_this_turn", "Flagged that they may not be safe: offers are on hold, and Co may check in on them tomorrow.");
        return { ok: true, note: "Flagged. Now reply with sendReply: stay with them, ask plainly if they're safe right now, and share 988 once." };
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
        if (ctx.safetyConcern || state.safetyFlagged) {
          notDone("No tapback: they may not be safe, so Co has to reply.");
          return { ok: false, error: "They may not be safe. Reply to them properly." };
        }
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

    // How many invites they have left: a lookup, its own tool (2026-09-26:
    // tucked into sendInvite as an option, Co skipped it and made up "Still
    // 5, none used yet").
    checkInvitesLeft: tool({
      description: toolUse("checkInvitesLeft"),
      inputSchema: z.object({}),
      execute: async () => {
        const left = ctx.dryRun ? 5 : await invitesLeftFor(ctx.userId);
        ctx.facts?.add("known", left > 0 ? `They have ${left} invite${left === 1 ? "" : "s"} left. One only counts once someone joins. (Co told them how many invites they have left; no invite link was sent.)` : "All 5 of their invites are used.");
        return { ok: true, left, note: left > 0 ? `They have ${left} left; one only counts once someone joins.` : "All 5 are used." };
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
      inputSchema: z.object({}),
      execute: async () => {
        const record = (outcome: "act" | "skip", action: string, extra: Record<string, unknown> = {}) =>
          ctx.dryRun ? Promise.resolve() : recordDecision({ layer: 3, decision: "account.invite", userId: ctx.userId, outcome, action, proposal: extra }).catch(() => {});
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
    // How something Co sent landed (2026-09-26: outcome learning). Co records
    // it when they react to an event or opportunity it sent: interested,
    // going, went and liked it, went and didn't, or not for them. Searches
    // and Co's own choices lean on these (services/outcomes.ts tasteSummary).
    noteReaction: tool({
      description: toolUse("noteReaction"),
      inputSchema: z.object({
        item: z.string().describe("The name of the event or opportunity Co sent them."),
        reaction: z.enum(["interested", "going", "went_liked", "went_disliked", "not_for_me"]),
        note: z.string().optional().describe("Their words, briefly, if they said why."),
      }),
      execute: async ({ item, reaction, note }) => {
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
        const want = norm(item);
        // The turn's one list of what Co sent (services/turnContext.ts): search results and first offers.
        const sent = ctx.dryRun ? [] : (ctx.turn?.sent ?? (await sentItems(ctx.userId)));
        const match = findSent(sent, item);
        if (!ctx.dryRun && !match) {
          notDone(`No reaction was recorded: "${item.slice(0, 80)}" isn't something Co sent them recently.`);
          return { ok: false, error: "That isn't something Co sent them recently (check listSentOffers)." };
        }
        const result = REACTION_RESULT[reaction];
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would record ${result} for "${item}" (${ctx.userId})`);
          return { ok: true };
        }
        if (!match) return { ok: false, error: "That isn't something Co sent them recently." };
        await recordSuggestionOutcome(ctx.userId, match.kind, match.key, match.name, result, note ?? null);
        ctx.facts?.add("did_this_turn", `Noted how "${match.name}" landed with them (${reaction.replace(/_/g, " ")}), so Co leans that way next time.`);
        return { ok: true };
      },
    }),

    // Living asks (2026-09-26): Co closes an ask when they say it's done,
    // found, no longer wanted, or replaced by a newer one. Closed in both
    // places it lives (services/askKind.ts closeAsk), with a receipt.
    closeAsk: tool({
      description: toolUse("closeAsk"),
      inputSchema: z.object({
        ask: z.string().describe("The ask to close, as it appears in what Co has on file for them (listOpenAsks)."),
        reason: z.string().describe("Why, in a few words: done, found it, no longer wanted, replaced by a newer ask."),
      }),
      execute: async ({ ask, reason }) => {
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
        const want = norm(ask);
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would close ask "${ask}" for ${ctx.userId} (${reason})`);
          return { ok: true, closed: ask };
        }
        const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [ctx.userId]);
        const open = askEntries(rows[0]?.intent ?? null).filter((e) => e.text);
        const hits = open.filter((e) => norm(e.text as string) === want || norm(e.text as string).includes(want) || want.includes(norm(e.text as string)));
        if (hits.length !== 1) {
          notDone(`No ask was closed: "${ask.slice(0, 80)}" didn't match exactly one open ask.`);
          return { ok: false, error: hits.length ? "That matches more than one open ask. Check listOpenAsks and use the exact one." : "That isn't one of their open asks. Check listOpenAsks first." };
        }
        await closeAsk(ctx.userId, hits[0].id as string, `closed by Co: ${reason}`);
        ctx.facts?.add("did_this_turn", `Closed their ask "${hits[0].text}" (${reason.slice(0, 80)}). Co stops looking for it.`);
        return { ok: true, closed: hits[0].text };
      },
    }),

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
        // The turn's one list (services/turnContext.ts), last 30 days.
        const cutoff = Date.now() - 30 * 86_400_000;
        const items = (ctx.turn?.sent ?? (await sentItems(ctx.userId))).filter((x) => x.sentAt.getTime() > cutoff).slice(0, 15);
        if (!items.length) {
          ctx.facts?.add("known", "Co hasn't sent them any events or opportunities in the last 30 days.");
          return { ok: true, sent: [] };
        }
        const fmt = await memberDate(ctx.userId);
        const sent = items.map((r) => ({ name: r.name, kind: r.kind, link: r.url, sentOn: fmt(r.sentAt), reaction: r.reaction }));
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
      inputSchema: z.object({
        what: z.string().describe("What to look for, one plain sentence."),
        whileLooking: z
          .string()
          .optional()
          .describe("A short text in your own words, sent right away while the search runs, saying what you're looking for (the way you'd tell a friend you're on it). Fresh each time, not a stock phrase."),
      }),
      execute: async ({ what, whileLooking }) => {
        if (ctx.searchedThisTurn) {
          return { ok: true, found: [], note: "A search already ran this turn and what it found was already sent to them. Do not search again, and do not say nothing came up." };
        }
        if (ctx.stubSearch) return { ok: true, found: [], note: `Test run: the search for "${what}" was skipped. Say you looked and nothing solid came up yet.` };
        // In a real turn: search and send the way Co always has, link then
        // caption for each thing that fits (routes/sendblue.ts searchAndSend).
        if (ctx.searchAndSend) {
          const r = await ctx.searchAndSend(what, whileLooking ?? null);
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

    // Passing their words to someone they're connected to, or a reminder to
    // follow up (services/relay.ts). The guards live in relayMessage: off
    // unless CO_RELAY=on, only their own words, only connected people, one a
    // day per person, nothing about anyone else.
    followUp: tool({
      description: toolUse("followUp"),
      inputSchema: z.object({
        mode: z.enum(["relay", "remind_me"]),
        person: z.string().describe("relay: the first name of the person they asked you to pass it to."),
        message: z.string().describe("relay: their exact words to pass along, copied from what they texted. remind_me: what to remind them about."),
        when: z.string().optional().describe("remind_me: the day and time they gave, as an ISO date-time in their local time, e.g. 2026-10-01T15:00."),
      }),
      execute: async ({ mode, person, message, when }) => {
        const relay = await import("../services/relay.js");
        if (mode === "remind_me") {
          if (ctx.dryRun) {
            ctx.facts?.add("did_this_turn", `Set a reminder for them: "${message.slice(0, 160)}"${when ? ` at ${when}` : ""}.`);
            return { ok: true };
          }
          const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
          const zone = rows[0]?.city ? await getTimezoneForCity(rows[0].city).catch(() => null) : null;
          const r = await relay.addReminder(ctx.userId, message, when ?? "", zone);
          if (!r.ok) {
            notDone("No reminder was set.");
            return { ok: false, error: r.error };
          }
          ctx.facts?.add("did_this_turn", `Set a reminder for them for ${r.at}: "${message.slice(0, 160)}".`);
          return { ok: true, note: `Reminder set for ${r.at}.` };
        }
        if (ctx.dryRun) {
          // Same guards as a real relay, minus the send.
          if (!relay.relayEnabled()) return { ok: false, error: "Passing messages to other members isn't switched on yet. Say so plainly; don't offer it." };
          if (!relay.isOwnWords(message, [ctx.resolvedContent])) return { ok: false, error: "Only their own words can be passed along. Ask them exactly what they want sent, then pass that." };
          const found = relay.matchConnection(person, await relay.connectionsFor(ctx.userId).catch(() => []));
          if (!found.ok) {
            notDone("No message was passed along: Co can't reach that person.");
            return { ok: false, error: relay.NOT_REACHABLE };
          }
          ctx.facts?.add("did_this_turn", `(dry run) Would pass their words to ${found.person.firstName}: "${message.slice(0, 160)}".`);
          return { ok: true };
        }
        const r = await relay.relayMessage({ fromUserId: ctx.userId, fromFirstName: ctx.firstName ?? "A member", to: person, message, currentText: ctx.resolvedContent });
        if (!r.ok) {
          notDone(r.reason === "not_reachable" ? "No message was passed along: Co can't reach that person." : `No message was passed along (${r.reason}).`);
          return { ok: false, error: r.error };
        }
        ctx.facts?.add("did_this_turn", `Passed their words to ${r.to}: "${message.slice(0, 200)}". ${r.note}`);
        return { ok: true, note: `${r.note} Say it went through; don't promise ${r.to} will reply.` };
      },
    }),
  };

  // Team-only tools never exist for anyone else (services/capabilities.ts teamOnly).
  if (!ctx.isTeam) for (const name of teamOnlyTools()) delete (tools as Record<string, unknown>)[name];

  // Google Calendar and Gmail, read-only (services/googleTools.ts).
  Object.assign(tools, googleTools(ctx, notDone));

  // Switches, limits, their yes, receipts and the decision log (toolGuard.ts).
  guardTools(tools, { userId: ctx.userId, resolvedContent: ctx.resolvedContent, dryRun: ctx.dryRun, notDone });
  return { tools, state, flushLinks };
}
