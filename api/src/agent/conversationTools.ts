import { notToTeammate } from "../services/teamLines.js";
import { brandSafe } from "../services/brandGuard.js";
import { z } from "zod";
import { tool } from "ai";
import { memberMoOn, memberMoTools, situationFor, teamOnlyTools, toolsOutOfSituation, toolUse } from "../services/capabilities.js";
import { guardTools } from "./toolGuard.js";
import { sendLimiter } from "../services/sendLimiter.js";
import sendblue, { cleanCoMessage, sendReaction } from "../services/sendblue.js";
import { coAskedQuestion } from "../services/conversationClose.js";
import { parseAck } from "../services/readTurn.js";
import { reactedTo, reactionFor, sameReaction } from "../services/tapbacks.js";
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
import { resolveNamedEventGuest, requestIntroToNamedGuest } from "../services/eventGuestMatchHandoff.js";
import { askEntries } from "../harness/profileWrite.js";
import { localStamp, memberZone, memberZoneOrFallback } from "../services/memberTime.js";
import { DateTime } from "luxon";
import { googleTools } from "../services/googleTools.js";
import { loopTools, newLoopState } from "./loopTools.js";
import { BEAT_GAP_MS, toBeats } from "../services/beats.js";

// A date as the member would say it, in their own zone (2026-09-22 code
// review: toDateString() used the server's zone, so a Pacific evening showed
// the next day). Null for a missing or unreadable date rather than
// "Invalid Date".
async function memberDate(userId: string): Promise<(iso: string | Date | null | undefined) => string | null> {
  const zone = await memberZoneOrFallback(userId);
  return (iso) => {
    if (!iso) return null;
    const d = iso instanceof Date ? DateTime.fromJSDate(iso) : DateTime.fromISO(String(iso));
    return d.isValid ? d.setZone(zone).toFormat("ccc LLL d") : null;
  };
}

// Resolves false when the message didn't go out (a refused or failed send),
// so callers only log and count what was really sent (2026-09-17 code review).
export type SendCoReply = (params: { phone: string; message: string; asVoice: boolean }) => Promise<boolean | void>;

export type ConversationToolContext = {
  // Set by loopTools for this turn: a page's, deck's or share link just went out, and that text is the turn's whole answer
  // (rule 2). The page, deck and share tools call it after the link sends.
  onLinkDelivered?: () => void;
  // On a call (services/callTools.ts): a page's, deck's or share link still goes to their texts while they talk (PR 6). Everything
  // else on a call is spoken; only a text carrying one of their own /d/ links goes this way.
  sendLinkText?: (text: string) => Promise<boolean>;
  // The reply's own fact check and brand guard, for an answer that rides with a link (agent/linkAnswer.ts). Set per turn below.
  checkAnswer?: (draft: string) => Promise<string>;
  // An answer that rode with a link went out: it counts as part of this turn's reply (the call-offer check reads lastReplyText).
  noteAnswerSent?: (answer: string) => void;
  // When their text arrived; the loop's time budget runs from here.
  turnStartedAt?: number;
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
  // Tests only: the loop's searches and page reads return a placeholder
  // instead of spending on the web (agent/loopTools.ts).
  stubSearch?: boolean;
  // The reaction already put on their text this turn (routes/sendblue.ts ack),
  // so Co can leave it at that (leaveItAtReaction).
  ackSent?: string | null;
  // For reactInsteadOfReplying.
  messageHandle?: string | null;
  // Co's last reaction to them (this turn's ack, or the latest before it), so
  // the closing tapback is never the same one twice in a row.
  lastReaction?: string | null;
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
  // Thread the next text under theirs too (routes/sendblue.ts): the first find
  // after a "looking" line, the way the first search result always was.
  threadNext?: () => void;
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
  // linkDelivered: a page's, deck's or share link went this turn (agent/loopTools.ts deliver): that text is the whole delivery.
  const state = { safetyFlagged: false, sent: false, reacted: false, replyCount: 0, failedSends: 0, sendStopped: false, lastReplyText: "", sentMessages: [] as string[], pendingLinks: [] as string[], linkDelivered: false };
  ctx.checkAnswer = async (draft: string) => brandSafe(ctx.gate ? await ctx.gate(draft, [...state.sentMessages]) : draft, ctx.resolvedContent);
  ctx.noteAnswerSent = (answer: string) => {
    state.lastReplyText = state.lastReplyText ? `${state.lastReplyText} ${answer}` : answer;
  };
  // Receipts (2026-09-25): anything tried this turn that didn't happen
  // becomes a fact Co writes from, so it can't say it did.
  const notDone = (what: string) => ctx.facts?.add("not_done", what);
  // The log of a text that already went out. Its failure is logged, never
  // thrown, so a database error can't make a delivered text look unsent and
  // set off a second reply (2026-10-01 code review).
  const logDelivered = (content: string) =>
    writeMemory(ctx.userId, "text_exchange", content).catch((err: any) => console.error("conversationTools: logging a sent text failed (it did send):", err?.message ?? err));
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
        await logDelivered(`Co replied: ${url}`);
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
        message: z.string().describe("Your reply, no em dashes. Each distinct thought (the reaction, the answer, the advice, the question, the offer) is its own short paragraph with a blank line between, and each paragraph goes out as its own text, so never stack several thoughts in one. A question to them is always its own last paragraph. When you've given them lines to say before a moment that's coming (a conversation, a pitch, a result), the last paragraph is the offer to check in after it, not another question. Most replies are one to three short beats, up to five when each earns its place."),
      }),
      execute: async ({ message: draft }) => {
        // Rule 2 (Royce, 2026-10-11): a page or deck goes as ONE text, the line plus the link. Told so, Co still added a second
        // ("Done. The old link is dead now, only this new one works.") in live runs, so after a link went out nothing more does.
        // An answer to something else they asked still goes (Royce, 2026-10-11: never drop it silently); commentary on the link
        // doesn't (agent/linkAnswer.ts afterLinkAnswers). Either way it's logged.
        if (state.linkDelivered) {
          // Already said with the link (alsoAnswer): never twice.
          const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
          if (norm(draft).length > 20 && norm(state.sentMessages.join(" ")).includes(norm(draft))) {
            notDone("A reply repeating what already went with the link wasn't sent again.");
            return { ok: true, note: "That already went with the link; nothing more went out." };
          }
          const { afterLinkAnswers } = await import("./linkAnswer.js");
          const answers = ctx.dryRun ? true : await afterLinkAnswers(ctx.resolvedContent, state.sentMessages.join("\n"), draft);
          if (!ctx.dryRun) {
            const { recordDecision } = await import("../harness/core.js");
            await recordDecision({ layer: 3, decision: "reply.after_link", userId: ctx.userId, outcome: answers ? "act" : "skip", action: answers ? "sent_answer" : "held_commentary", proposal: { draft: draft.slice(0, 300) } }).catch(() => {});
          }
          if (!answers) {
            notDone("A reply about the link after the link wasn't sent (the link's text is the whole delivery).");
            return { ok: false, error: "Not sent: it was about the page or deck, and the link's text is the whole delivery. Don't call sendReply again this turn." };
          }
        }
        const message = brandSafe(ctx.gate ? await ctx.gate(draft, [...state.sentMessages]) : draft, ctx.resolvedContent);
        // The fact check left nothing to add after what already went out this turn.
        if (!message.trim() && state.sentMessages.length) return { ok: true, note: "What you already sent this turn is the answer; nothing more went out. Don't add a closing line." };
        if (state.replyCount > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
        // Texted in beats: each paragraph its own message (services/beats.ts).
        // A voice note stays one clip.
        const beats = ctx.isVoice ? [message] : toBeats(message);
        if (!ctx.dryRun && beats.length > 1) {
          const sentBeats: string[] = [];
          for (const [i, beat] of beats.entries()) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, BEAT_GAP_MS));
            const ok = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: beat, asVoice: false });
            if (ok === false) {
              state.failedSends += 1;
              if (!sentBeats.length) {
                if (sendLimiter.blocked(ctx.phoneNumber) || state.failedSends >= 2) {
                  state.sendStopped = true;
                  return { ok: false, error: "Texts to them can't go out right now. Stop here; don't call any more tools." };
                }
                return { ok: false, error: "That message didn't go out. Rewrite it as a plain, direct text to them and call sendReply again." };
              }
              notDone(`Only part of the reply went out: "${beat.slice(0, 120)}" didn't send.`);
              break;
            }
            await logDelivered(`Co replied: ${cleanCoMessage(beat)}`);
            sentBeats.push(beat);
          }
          const sentText = sentBeats.join("\n\n");
          state.sentMessages.push(sentText);
          state.lastReplyText = state.lastReplyText ? `${state.lastReplyText} ${sentText}` : sentText;
          state.sent = true;
          state.replyCount += 1;
          return { ok: true };
        }
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
          await logDelivered(`Co replied: ${cleanCoMessage(message)}`);
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
          await logDelivered("Co replied: [sent Co's contact card]");
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
        deadline: z
          .object({ date: z.string().describe("YYYY-MM-DD"), theirWords: z.string().describe("Their own words giving it, copied exactly (\"by Friday\").") })
          .optional()
          .describe("Only if they gave a deadline."),
        lookout: z
          .boolean()
          .optional()
          .describe("True when they asked you to keep watching over time and tell them when something turns up (\"let me know when...\", \"keep an eye out for...\"), not for one result now."),
      }),
      execute: async ({ goal, theirWords, steps, firstStep, inHours, deadline, lookout }) => {
        const T = await import("../services/coTasks.js");
        const recent = ctx.dryRun
          ? ""
          : await pool
              .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 6`, [ctx.userId])
              .then((r) => r.rows.map((x: any) => String(x.content)).join("\n"))
              .catch(() => "");
        const yesToOffer = T.isYesToOffer(ctx.resolvedContent, ctx.lastCoMessage);
        if (!yesToOffer && !T.wordsAreTheirs(theirWords, `${ctx.resolvedContent}\n${recent}`)) {
          notDone("No task was started: the quote isn't in their words.");
          return { ok: false, error: "theirWords must be copied exactly from what they wrote. Don't start a task they didn't ask for." };
        }
        // A deadline they gave, checked against their words and their time zone.
        let dl: { deadline: string; finalCheckAt: string } | null = null;
        const zone = await memberZone(ctx.userId);
        // Co left off a deadline they gave: code finds it in their words.
        const given = deadline ? { date: deadline.date, theirWords: deadline.theirWords } : (() => { const f = T.deadlineFromWords(ctx.resolvedContent, zone, new Date()); return f ? { date: f.date, theirWords: f.words } : null; })();
        if (given) {
          const d = T.planDeadline({ date: given.date, words: given.theirWords }, `${ctx.resolvedContent}\n${recent}`, zone, new Date());
          if (d.ok) dl = { deadline: d.deadline, finalCheckAt: d.finalCheckAt };
          else notDone(`The deadline wasn't kept on the task: ${d.why}.`);
        }
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Started task: "${goal}". Co will work on it first in about ${T.clampNextHours(inHours)} hours: ${firstStep}.${dl ? ` Their deadline: ${dl.deadline}; Co's last check before it is ${localStamp(dl.finalCheckAt, zone)}.` : ""}`);
          return { ok: true, deadline: dl };
        }
        // A look-out's origin, recorded now so the send path never guesses (Royce, 2026-10-09): theirs only when this message asks Co
        // to watch or says yes to Co's offer to (their finds are deliveries); otherwise Co's, and its finds are counted (review of #131).
        const offer = lookout ? T.watchOfferIn(String(ctx.lastCoMessage ?? "")) : null;
        const offerLogged = offer ? await import("../harness/proactive.js").then((P) => P.replyWatchOfferLogged(ctx.userId, String(ctx.lastCoMessage ?? ""))).catch(() => false) : false;
        const origin = lookout ? T.lookoutOriginAt({ message: ctx.resolvedContent, quote: theirWords, lastCoMessage: ctx.lastCoMessage, offerLogged }) : null;
        const r = await T.startTask({ userId: ctx.userId, goal, theirWords: yesToOffer ? `${ctx.resolvedContent.trim()} (to Co's offer: ${String(ctx.lastCoMessage ?? "").slice(0, 160)})` : theirWords, steps, firstPlan: firstStep, inHours, deadline: dl, ...(origin ? { source: "lookout" as const, lookoutOrigin: origin } : {}) });
        if (!r.ok) {
          notDone(`No task was started: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: "${r.task.goal}". Co will work on it first around ${r.task.nextCheckAt ? localStamp(r.task.nextCheckAt, zone) : "soon"}: ${firstStep}.${r.task.deadline ? ` Their deadline: ${r.task.deadline}; Co's last check before it, where it tells them where things stand, is around ${r.task.finalCheckAt ? localStamp(r.task.finalCheckAt, zone) : "the day before"}.` : ""}`);
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

    // Today's Co event (services/preArrival.ts): their yes to sharing location, and whether they're going.
    shareLocationYes: tool({
      description: toolUse("shareLocationYes"),
      inputSchema: z.object({ theirYes: z.string().describe("Their yes, copied exactly from this message.") }),
      execute: async ({ theirYes }) => {
        const P = await import("../services/preArrival.js");
        if (!P.yesToSharing(theirYes, ctx.resolvedContent)) {
          notDone("Their location wasn't turned on: the yes isn't in their words.");
          return { ok: false, error: "Only their own yes, from this message, turns it on." };
        }
        const today = await import("../services/eventPresence.js").then((e) => e.todayEventFor(ctx.userId)).catch(() => null);
        if (!today) {
          notDone("Their location wasn't turned on: they have no Co event today.");
          return { ok: false, error: "They aren't going to a Co event today, so there's nothing to use it for." };
        }
        if (!ctx.dryRun) await P.recordLocationYes(today.eventApiId, ctx.userId, theirYes);
        ctx.facts?.add("did_this_turn", `They said yes to sharing their location for "${today.name}" only. Co will use it just to know when they've arrived. They share it themselves in Messages (Share My Location with Co), and "stop sharing" ends it.`);
        return { ok: true, event: today.name };
      },
    }),
    answerShareAsks: tool({
      description: toolUse("answerShareAsks"),
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        const r = await (await import("../services/askSharing.js")).recordRsvpShareAnswer(ctx.userId, ctx.resolvedContent);
        if (!r.ok) {
          notDone(`Nothing about sharing their asks was recorded: ${r.why}.`);
          return { ok: false, error: r.why === "their answer isn't a clear choice" ? "Ask which numbers they're happy to share (or all, or none)." : r.why };
        }
        ctx.facts?.add("did_this_turn", r.shared.length ? `Recorded which asks Co may tell a good match in the room: ${r.shared.map((t) => `"${t}"`).join(", ")}. The rest stay private.` : "Recorded that none of their asks are to be shared. They stay private.");
        return { ok: true, shared: r.shared };
      },
    }),
    shareAskInIntros: tool({
      description: toolUse("shareAskInIntros"),
      inputSchema: z.object({
        ask: z.string().describe("The ask as it's on file (their words)."),
        answer: z.enum(["yes", "no"]),
        theirWords: z.string().describe("Their yes or no, copied exactly from this message."),
      }),
      execute: async ({ ask, answer, theirWords }) => {
        const B = await import("../services/eventBrief.js");
        if (B.readNameAnswer(theirWords, ctx.resolvedContent) !== answer) {
          notDone("Nothing was marked shareable: their words aren't a clear yes or no.");
          return { ok: false, error: "Only their own clear yes or no, from this message, counts. If it was unclear, ask once more." };
        }
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        const r = await (await import("../services/askSharing.js")).setAskShareable(ctx.userId, ask, answer === "yes");
        if (!r.ok) {
          notDone(`Nothing was marked shareable: ${r.why}.`);
          return { ok: false, error: r.options ? `Ask which one they mean: ${r.options.join(" / ")}` : "That isn't one of their open asks." };
        }
        ctx.facts?.add("did_this_turn", answer === "yes" ? `They said Co may mention "${r.text}" in their own words when introducing them. Their other asks stay private.` : `They said not to mention "${r.text}" to anyone. It stays private.`);
        return { ok: true, ask: r.text, shareable: answer === "yes" };
      },
    }),
    answerBriefName: tool({
      description: toolUse("answerBriefName"),
      inputSchema: z.object({ answer: z.enum(["yes", "no"]), theirWords: z.string().describe("Their yes or no, copied exactly from this message.") }),
      execute: async ({ answer, theirWords }) => {
        const B = await import("../services/eventBrief.js");
        if (B.readNameAnswer(theirWords, ctx.resolvedContent) !== answer) {
          notDone("Their answer about being named wasn't recorded: it isn't a clear yes or no in their words.");
          return { ok: false, error: "Only their own clear yes or no, from this message, counts. If it was unclear, ask once more." };
        }
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        const done = await B.recordNameAnswer(ctx.userId, answer, theirWords);
        if (done && "ambiguous" in done) {
          notDone("Their answer about being named wasn't recorded: there is more than one event question open.");
          return { ok: false, error: "More than one event question is open. Ask which event they mean, then record it." };
        }
        if (!done) {
          notDone("Their answer about being named wasn't recorded: there's no brief question open for them.");
          return { ok: false, error: "There's no open question about the member brief for them." };
        }
        ctx.facts?.add("did_this_turn", answer === "yes" ? "They said yes: Co may mention them by name in the member brief for that event, with only what they're looking for as the reason. They can change that any time." : "They said no: Co won't name them in the member brief for that event.");
        return { ok: true, answer };
      },
    }),
    // ---------- member-facing Mo (mo/memberFlow.ts). Every yes is read from their WHOLE message, in code.
    answerMoOptIn: tool({
      description: toolUse("answerMoOptIn"),
      inputSchema: z.object({ answer: z.enum(["yes", "no"]) }),
      execute: async (input: any) => {
        const R = await import("../mo/memberRules.js");
        const F = await import("../mo/memberFlow.js");
        if (R.readConsent(input.theirYes, ctx.resolvedContent) !== input.answer) {
          notDone("Their answer about Mo wasn't recorded: it isn't a clear yes or no in their words.");
          return { ok: false, error: "Only their own clear yes or no counts. If it was unclear, ask once more." };
        }
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        const r = await F.recordOptIn(ctx.userId, input.answer, String(input.theirYes));
        if (!r.ok) {
          notDone("Their answer about Mo wasn't recorded: there's no open question about Mo.");
          return { ok: false, error: "There's no open question about Mo for them." };
        }
        ctx.facts?.add("did_this_turn", input.answer === "yes" ? "They said yes to Mo looking outside the club for someone. Nothing is sent to anyone until they've seen the person and the exact words and said yes to each." : "They said no to Mo. Nothing is searched or sent.");
        return { ok: true, answer: input.answer };
      },
    }),
    approveMoVoice: tool({
      description: toolUse("approveMoVoice"),
      inputSchema: z.object({ useMyName: z.boolean().optional() }),
      execute: async (input: any) => {
        const R = await import("../mo/memberRules.js");
        const F = await import("../mo/memberFlow.js");
        if (R.readConsent(input.theirYes, ctx.resolvedContent) !== "yes") {
          notDone("The wording wasn't approved: it isn't a clear yes in their words.");
          return { ok: false, error: "Only their own clear yes counts." };
        }
        const named = input.useMyName === true && /\b(my (first )?name|use my name|name me|say it'?s me|call me)\b/i.test(ctx.resolvedContent);
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        const row = await F.optInRow(ctx.userId);
        if (!row?.voice_text) {
          notDone("The wording wasn't approved: it hasn't been shown to them yet.");
          return { ok: false, error: "They haven't been shown the wording yet." };
        }
        await F.saveVoice(ctx.userId, row.voice_text, named);
        const ok = await F.approveVoice(ctx.userId, String(input.theirYes));
        if (!ok) return { ok: false, error: "Nothing to approve." };
        const batch = await F.openBatch(ctx.userId);
        if (batch) await (await import("../mo/memberJobs.js")).queuePresentation(ctx.userId, batch.id, true);
        ctx.facts?.add("did_this_turn", `They approved how Mo introduces itself${named ? ", using their first name" : ', calling them "a member of the club"'}. Next they will see each person and the exact message, and pick.`);
        return { ok: true, named };
      },
    }),
    approveMoPeople: tool({
      description: toolUse("approveMoPeople"),
      inputSchema: z.object({}),
      execute: async (input: any) => {
        const R = await import("../mo/memberRules.js");
        const F = await import("../mo/memberFlow.js");
        const batch = await F.openBatch(ctx.userId);
        if (!batch || batch.status !== "open") {
          notDone("No one was approved: there's no open list of people for them.");
          return { ok: false, error: "There's no open list of people for them." };
        }
        const people = (await F.candidatesOf(batch.id, ctx.userId)).filter((p) => p.status === "pending");
        const picks = R.readPicks(ctx.resolvedContent, Math.max(...people.map((p) => p.n), 0));
        if (picks === null) {
          notDone("No one was approved: which people they chose isn't clear.");
          return { ok: false, error: "Their choice isn't clear. Ask which numbers, or none." };
        }
        if (ctx.dryRun) return { ok: true, picks, note: "dry run" };
        const r = await F.approvePicks(ctx.userId, picks, String(input.theirYes));
        if (!r) {
          notDone("No one was approved: the wording hasn't been approved yet, or the list is closed.");
          return { ok: false, error: "The list isn't ready to approve yet." };
        }
        ctx.facts?.add("did_this_turn", "none" in r ? "They chose no one. Nothing goes out." : `They chose ${r.approved} of the people. Mo will reach out to only those, within its limits, and tell them what comes back.`);
        return { ok: true, ...r };
      },
    }),
    approveMoIntro: tool({
      description: toolUse("approveMoIntro"),
      inputSchema: z.object({ who: z.string().optional() }),
      execute: async (input: any) => {
        const R = await import("../mo/memberRules.js");
        const F = await import("../mo/memberFlow.js");
        if (R.readConsent(input.theirYes, ctx.resolvedContent) !== "yes") {
          notDone("The introduction wasn't set up: it isn't a clear yes in their words.");
          return { ok: false, error: "Only their own clear yes counts." };
        }
        const { rows } = await pool.query(`SELECT * FROM mo_member_candidates WHERE user_id = $1 AND status IN ('replied', 'invited', 'joined') AND intro_at IS NULL ORDER BY created_at DESC`, [ctx.userId]);
        const want = String(input.who ?? "").trim().toLowerCase();
        const matches = want ? rows.filter((r: any) => String(r.name ?? "").toLowerCase().includes(want) || String(r.x_handle ?? "").toLowerCase() === want.replace(/^@/, "") || String(r.n) === want) : rows;
        if (matches.length !== 1) {
          notDone(matches.length ? "The introduction wasn't set up: more than one person is waiting on this." : "The introduction wasn't set up: no one is waiting on it.");
          return { ok: false, error: matches.length ? "More than one person is waiting on this. Ask which one." : "No one is waiting on an introduction." };
        }
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        const done = await F.recordIntroYes(ctx.userId, matches[0].id, String(input.theirYes));
        if (!done.ok) return { ok: false, error: done.why ?? "Not possible." };
        // Their side is only recorded. If the person joins, the other side is asked on their own (mo/memberJobs.ts) and the email
        // goes out only when both say yes. The member is never told whether or when someone joined.
        ctx.facts?.add("did_this_turn", "They said yes to being introduced if this person joins. Nothing else happens unless the person joins and also says yes; you will not be told if they join, so never say or imply that they have.");
        return { ok: true };
      },
    }),
    stopMo: tool({
      description: toolUse("stopMo"),
      inputSchema: z.object({}),
      execute: async () => {
        // Stopping is always safe, so the model's call is enough: it only ever cancels what hasn't been sent.
        if (ctx.dryRun) return { ok: true, note: "dry run" };
        await (await import("../mo/memberFlow.js")).stopMo(ctx.userId, ctx.resolvedContent.slice(0, 200));
        ctx.facts?.add("did_this_turn", "Mo is stopped for them: nothing more goes out and anything not yet sent is cancelled. They can ask you to start it again.");
        return { ok: true };
      },
    }),
    myMoContacts: tool({
      description: toolUse("myMoContacts"),
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await (await import("../mo/memberFlow.js")).myReceipts(ctx.userId, 10);
        if (!rows.length) return { ok: true, contacts: [], note: "Mo hasn't contacted anyone for them." };
        return { ok: true, contacts: rows.map((r) => ({ when: new Date(r.at).toISOString().slice(0, 10), what: r.kind, who: r.who, how: r.channel, outcome: r.outcome, text: r.text })) };
      },
    }),
    updateGoing: tool({
      description: toolUse("updateGoing"),
      inputSchema: z.object({ going: z.boolean(), theirWords: z.string().describe("Their words, copied exactly.") }),
      execute: async ({ going, theirWords }) => {
        const T = await import("../services/coTasks.js");
        if (!T.wordsAreTheirs(theirWords, ctx.resolvedContent) && theirWords.trim().length >= 6) {
          notDone("Going wasn't updated: the quote isn't in their words.");
          return { ok: false, error: "Quote their own words." };
        }
        const today = await import("../services/eventPresence.js").then((e) => e.todayEventFor(ctx.userId)).catch(() => null);
        if (!today) return { ok: false, error: "No Co event of theirs today." };
        if (!ctx.dryRun) await import("../services/preArrival.js").then((P) => P.setGoing(today.eventApiId, ctx.userId, going));
        ctx.facts?.add("did_this_turn", going ? `Noted they're going to "${today.name}".` : `Noted they can't make "${today.name}"; Co won't send them anything more about it.`);
        return { ok: true };
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
    leaveItAtReaction: tool({
      description: toolUse("leaveItAtReaction"),
      inputSchema: z.object({}),
      execute: async () => {
        if (state.replyCount > 0) return { ok: false, error: "You already replied this turn." };
        if (ctx.safetyConcern || ctx.replyOwed || coAskedQuestion(ctx.lastCoMessage)) return { ok: false, error: "They need words this time. Reply properly." };
        state.sent = true;
        state.reacted = true;
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "turn.closing", userId: ctx.userId, outcome: "act", action: `left at ${ctx.ackSent}`, proposal: { message: ctx.resolvedContent } }).catch(() => {});
        return { ok: true, note: "Done. Don't send a text." };
      },
    }),

    reactInsteadOfReplying: tool({
      // Any single emoji chosen for this exact message (Royce, 2026-10-01
      // decisions), same rules as the ack (readTurn.ts parseAck).
      description: `${toolUse("reactInsteadOfReplying")}${ctx.lastReaction ? ` Your last reaction to them was ${ctx.lastReaction}; use a different one.` : ""}`,
      inputSchema: z.object({
        reaction: z.string().describe('Exactly one emoji that says something about this message: "🥂" a plan locked in or a win, "🫡" a correction or instruction taken, "🔥" real news, "😂" when they\'re genuinely funny, "❤️" something personal and good, "👍" a plain okay (never on bad news, and never a heart on a complaint or burnout). Any other single emoji that fits the moment beats a generic one.'),
      }),
      execute: async ({ reaction: picked }) => {
        if (state.replyCount > 0) return { ok: false, error: "You already replied this turn." };
        const reaction = parseAck(picked);
        if (!reaction) return { ok: false, error: "A reaction is exactly one emoji, and not a startup-cute one (rocket, raised hands, confetti). Pick one that fits this message, or reply." };
        if (ctx.lastReaction && sameReaction(ctx.lastReaction, reaction)) {
          return { ok: false, error: `Your last reaction to them was ${ctx.lastReaction}. Pick a different one that fits this message, or reply with a short text.` };
        }
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
        // One reaction per message (services/tapbacks.ts): the early "on it" read may
        // already have reacted to this very text; a second would be a double.
        if (!ctx.dryRun && (await reactedTo(ctx.messageHandle))) {
          state.sent = true;
          state.reacted = true;
          return { ok: true, note: "They already have a reaction from you on this message. Nothing more to send; don't reply." };
        }
        let how = "dry_run";
        if (!ctx.dryRun) {
          const tapped = ctx.messageHandle ? await sendReaction(ctx.messageHandle, reactionFor(reaction)) : false;
          if (!tapped) {
            // No tapback (SMS, an old message, or Sendblue refused it): the same emoji as a text says the same.
            const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: reaction, asVoice: false });
            if (sent === false) {
              notDone("The reaction didn't go through.");
              return { ok: false, error: "That didn't go through. Reply with a short text instead." };
            }
            await logDelivered(`Co replied: ${reaction}`);
          }
          how = tapped ? `tapback:${reaction}` : `emoji:${reaction}`;
          await recordDecision({ layer: 3, decision: "turn.closing", userId: ctx.userId, outcome: "act", action: how, proposal: { message: ctx.resolvedContent, handle: ctx.messageHandle ? ctx.messageHandle.slice(-8) : null } }).catch(() => {});
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
        // Nothing posted: a receipt, so Co can't say it sent a rundown (2026-10-01:
        // "sent you the rundown" with an empty list, then "where is it?").
        if (!rows[0]) {
          notDone("No update list was sent: nothing new is posted.");
          return { ok: false, error: "Nothing new is posted, so nothing was sent. Say so in a few words; don't say you sent anything." };
        }
        const message = `Here's what's new:\n\n${rows[0].content}`;
        if (!ctx.dryRun) {
          const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message, asVoice: false });
          if (sent === false) {
            notDone("The update list was not sent (the send failed).");
            return { ok: false, error: "The update list didn't go through. Tell them plainly." };
          }
          await logDelivered(`Co replied: ${message}`);
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
        await logDelivered(`Co replied: ${message}`);
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
    // What kind of room they want (services/roomTaste.ts): ranks what Co picks for them (Royce, 2026-10-09).
    noteRoomTaste: tool({
      description: toolUse("noteRoomTaste"),
      inputSchema: z.object({
        wants: z.string().optional().describe("The kind of room they want, a few words (\"small rooms where people drop their guard\")."),
        avoids: z.string().optional().describe("The kind they don't (\"performative networking\")."),
        quote: z.string().describe("Their own words saying it, copied exactly from what they wrote."),
      }),
      execute: async ({ wants, avoids, quote }) => {
        if (!wants?.trim() && !avoids?.trim()) return { ok: false, error: "Say what kind of room they want, or don't." };
        const T = await import("../services/coTasks.js");
        const recent = ctx.dryRun
          ? ""
          : await pool
              .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 6`, [ctx.userId])
              .then((r) => r.rows.map((x: any) => String(x.content)).join("\n"))
              .catch(() => "");
        // Their words: this message, their recent texts, and on a call, everything they've said on it (ctx.turn.message is the whole
        // call's words there: the quote can be from earlier in the call).
        if (!T.wordsAreTheirs(quote, `${ctx.resolvedContent}\n${ctx.isVoice ? String(ctx.turn?.message ?? "") : ""}\n${recent}`)) {
          notDone("Their taste wasn't noted: the quote isn't in their words.");
          return { ok: false, error: "The quote must be copied exactly from what they wrote." };
        }
        // What drives ranking (wants, avoids) has to rest on what they said: each shares a word with their quote (review of #132:
        // "I'm tired" could carry an invented "avoids: loud parties").
        const off = (await import("../services/roomTaste.js")).tasteUnbacked({ wants, avoids, quote });
        if (off) {
          notDone("Their taste wasn't noted: it says more than their words do.");
          return { ok: false, error: off };
        }
        const taste = { wants: wants?.trim() || null, avoids: avoids?.trim() || null, quote: quote.trim().slice(0, 200) };
        if (ctx.dryRun) return { ok: true };
        await (await import("../services/roomTaste.js")).recordRoomTaste(ctx.userId, taste);
        // Re-rank today (services/sweepShadow.ts), in the background: the reply never waits on it.
        void import("../services/sweepShadow.js").then((m) => m.rerunPickerForTaste(ctx.userId)).catch(() => {});
        ctx.facts?.add("did_this_turn", "Noted the kind of room they want, so what Co picks for them leans that way.");
        return { ok: true };
      },
    }),

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
        // Their answer settles the sent find everywhere it waits: the router's reveal and the offer's loop (2026-10-11, loop 53372).
        await import("../services/offerReactions.js").then((O) => O.settleSentOffer(ctx.userId, match.name, reaction, note ?? null)).catch(() => {});
        ctx.facts?.add("did_this_turn", `Noted how "${match.name}" landed with them (${reaction.replace(/_/g, " ")}), so Co leans that way next time.`);
        return { ok: true };
      },
    }),

    // Second contact (Royce, 2026-10-11, services/secondContact.ts): they said they saw or talked with someone Co introduced them to
    // again, or haven't. Recorded in their record only; never told to the other person, never a claim about the other side.
    noteMetAgain: tool({
      description: toolUse("noteMetAgain"),
      inputSchema: z.object({
        person: z.string().describe("The first name of someone Co introduced them to."),
        outcome: z.enum(["met_again", "talked_again", "not_yet", "not_going_to"]).describe("What they said: they met up again, talked again (call, text, email), haven't yet, or don't plan to."),
        note: z.string().optional().describe("Their words, briefly."),
        metOn: z.string().optional().describe("When they met or talked, as YYYY-MM-DD, only if they said (\"last Tuesday\" with today's date). Leave it out otherwise."),
      }),
      execute: async ({ person, outcome, note, metOn }) => {
        const SC = await import("../services/secondContact.js");
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was recorded." };
        const pick = SC.pickIntro(await SC.introducedTo(ctx.userId).catch(() => []), person);
        if (pick === "ambiguous") return { ok: false, error: `More than one person Co introduced them to is called ${person}. Ask which one, then try again.` };
        if (!pick) {
          notDone(`Nothing recorded: ${person.slice(0, 40)} isn't someone Co introduced them to.`);
          return { ok: false, error: "That isn't someone Co introduced them to (only Co's own introductions count)." };
        }
        await SC.recordSecondContact(ctx.userId, pick, outcome, note ?? null, new Date(), metOn ?? null);
        ctx.facts?.add("did_this_turn", `Noted that they ${outcome === "met_again" ? "saw" : outcome === "talked_again" ? "talked with" : outcome === "not_yet" ? "haven't seen" : "don't plan to see"} ${pick.firstName} again.`);
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
        const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [ctx.userId]);
        const entries = askEntries(rows[0]?.intent ?? null);
        // What they ruled out, from the record's one reader (services/memberKnowledge.ts limits; Phase A6).
        const avoid: string[] = (await import("../services/memberKnowledge.js").then((M) => M.realKnowledgeDeps.limits(ctx.userId)).catch(() => null))?.avoid ?? [];
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
        // What's already waiting for them of that kind leaves too, each with its fact (services/workingSet.ts exitAvoidedFinds), in the
        // background: the reply doesn't wait on it.
        if (!undo) {
          const userId = ctx.userId;
          void Promise.all([import("../services/workingSet.js"), import("../services/sweepShadow.js")])
            .then(([W, S]) => W.exitAvoidedFinds(userId, k, { ...S.realPruneDeps, ...S.realAvoidDeps }))
            .then((r) => recordDecision({ layer: 3, decision: "reply.steerAwayFrom.workingSet", userId, outcome: r.backlog || r.queued ? "act" : "skip", action: `out: ${r.backlog} waiting, ${r.queued} queued`, proposal: { kind: k, ...r } }))
            .catch((err: any) => console.error("steerAwayFrom: clearing what's waiting failed (non-fatal):", err?.message ?? err));
        }
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
        lastName: z.string().optional().describe("Their last name, once the member has told you. Never guess it."),
      }),
      execute: async ({ personName, lastName }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would look up "${personName}" for ${ctx.userId} to request an intro`);
          return { ok: true, note: "dry run" };
        }
        const resolved = await resolveNamedEventGuest(ctx.userId, personName, lastName);
        // Always the same first question, whoever they name: the guest list isn't read until Co has a full name.
        if ("needsDetail" in resolved) {
          return { ok: true, note: "Before anything else, ask for the person's last name, so you reach the right person. Ask it plainly, the same way you would for anyone; don't say whether you know anyone by that first name, how many, or whether they were there." };
        }
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
          // decision log only. Two guests with the same full name get this
          // same answer too (no one is contacted).
          return {
            ok: true,
            note: "Tell them that if it's someone you know from that event, you'll check whether they're open to it too. Never confirm or deny that the person is someone you know, is a Co member, or was on the guest list, and don't say whether you found them.",
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
          const zone = await memberZone(ctx.userId);
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
        ctx.facts?.add("did_this_turn", r.queued ? `Queued their words for ${r.to}: "${message.slice(0, 200)}". ${r.note}` : `Passed their words to ${r.to}: "${message.slice(0, 200)}". ${r.note}`);
        return { ok: true, note: r.queued ? `${r.note} Say it will reach ${r.to} in their morning, not that it went through; don't promise ${r.to} will reply.` : `${r.note} Say it went through; don't promise ${r.to} will reply.` };
      },
    }),
  };

  // Leaving it at the reaction needs a reaction to have gone out this turn.
  if (!ctx.ackSent) delete (tools as Record<string, unknown>).leaveItAtReaction;
  // Team-only tools never exist for anyone else (services/capabilities.ts teamOnly).
  if (!ctx.isTeam) for (const name of teamOnlyTools()) delete (tools as Record<string, unknown>)[name];
  // Member-facing Mo exists for a member only while its switches are on (services/capabilities.ts memberMoOn).
  if (!memberMoOn()) for (const name of memberMoTools()) delete (tools as Record<string, unknown>)[name];
  // Tools that can't apply this turn aren't offered (capabilities.ts situations).
  if (ctx.turn) {
    const t = ctx.turn;
    const s = situationFor({ kitFields: Object.keys(t.kit ?? {}).length, message: ctx.resolvedContent, openTasks: t.tasks?.length ?? 0, eventToday: !!t.todayEvent });
    for (const name of toolsOutOfSituation(s)) delete (tools as Record<string, unknown>)[name];
  }

  // Finding things: Co's own loop (agent/loop.ts), general tools it chains itself.
  Object.assign(tools, loopTools(ctx, state, newLoopState(ctx.turnStartedAt), notDone));

  // Google Calendar and Gmail, read-only (services/googleTools.ts).
  Object.assign(tools, googleTools(ctx, notDone));

  // Switches, limits, their yes, receipts and the decision log (toolGuard.ts).
  guardTools(tools, { userId: ctx.userId, resolvedContent: ctx.resolvedContent, dryRun: ctx.dryRun, notDone });
  return { tools, state, flushLinks };
}
