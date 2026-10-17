import { notToTeammate } from "../services/teamLines.js";
import { brandSafe } from "../services/brandGuard.js";
import { z } from "zod";
import { tool } from "ai";
import { situationFor, teamOnlyTools, toolsOutOfSituation, toolUse } from "../services/capabilities.js";
import { guardTools } from "./toolGuard.js";
import { doorOpen } from "../services/theDoor.js";
import { proactivePaused } from "../services/proactivePause.js";
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
import { quoteIsTheirs } from "../services/provenance.js";
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
import { loopTools, newLoopState, type LoopState } from "./loopTools.js";
import { FIND_READS_PER_TURN, findsRedraftNote, ignoresFinds, isPost, realFindUseRead, turnFinds, unlinkedFinds } from "./findGuards.js";
import { BEAT_GAP_MS, toBeats } from "../services/beats.js";
import { carryLaneNotes, LANE_WORDS, laneNote, laneStoreFor, lookoutRestatesTask, moveLane, noteLabel, offersMove, ruleFor } from "../services/laneMoves.js";

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
  // Links made this turn whose text didn't send (agent/linkAnswer.ts unsentLink): resendLink sends one again, so a member is never
  // left without a working link (founder's review, 2026-10-12: on a reset the old link is already off).
  unsentLinks?: { url: string; text: string; what: string }[];
  // On a call (services/callTools.ts): a page's, deck's or share link still goes to their texts while they talk (PR 6). Everything
  // else on a call is spoken; only a text carrying one of their own /d/ links goes this way.
  sendLinkText?: (text: string) => Promise<boolean>;
  // The reply's own fact check and brand guard, for an answer that rides with a link (agent/linkAnswer.ts). Set per turn below.
  checkAnswer?: (draft: string) => Promise<string>;
  // An answer that rode with a link went out: it counts as part of this turn's reply (the call-offer check reads lastReplyText).
  noteAnswerSent?: (answer: string) => void;
  // An answer that was meant to ride with a link but didn't go (agent/linkAnswer.ts withAnswer): owed, so the one reply that
  // answers it may follow the link (sendReply), once.
  answerOwed?: string | null;
  // When their text arrived; the loop's time budget runs from here.
  turnStartedAt?: number;
  // A confirmed lane move's line an earlier try at this reply never carried (conversationReply.ts retry): this reply carries it.
  laneNotesOwed?: string[];
  // The one stopped-looking line owed (services/askRetire.ts): carried in a reply that goes anyway, never forcing one.
  stopNotesOwed?: string[];
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
  // findsWaiting is read when the check decides, not before it runs: the check can outlast the redraft window.
  gate?: (draft: string, sentThisTurn: string[], answeredThisTurn?: string[], findsWaiting?: () => boolean) => Promise<string>;
  // Tests only: the loop's searches and page reads return a placeholder
  // instead of spending on the web (agent/loopTools.ts).
  stubSearch?: boolean;
  // Tests only: what a stubbed event search returns (agent/loopTools.ts).
  stubEvents?: import("./loopTools.js").StubEvent[];
  // Tests only: the meaning read the find guards use (agent/findGuards.ts realFindUseRead otherwise).
  findUseRead?: import("./findGuards.js").FindUseRead;
  // A live call (services/callTools.ts): nothing but a link is texted mid-call.
  onCall?: boolean;
  // Whether the reply loop has a step and the seconds left for a redraft (agent/conversationReply.ts); unset means it has.
  redraftLeft?: () => boolean;
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
  // On the team (users.mo_approver): gets the team-only tools, if any.
  isTeam?: boolean;
  // The one picture of this turn (services/turnContext.ts), for tools that read what Co sent.
  turn?: TurnContext | null;
  firstName?: string | null;
  replyOwed?: boolean;
  // The brain's decision for this turn (brain/index.ts). What it rules out binds the tools here (a tapback can't stand in for a reply).
  // Without one (calls, tests), the turn's own flags above stand in for it.
  decision?: import("../brain/index.js").Decision | null;
  lastCoMessage?: string | null;
  // The exchange before their message (services/theirYes.ts exchangeText): what a yes answers. Without it, Co's last line alone.
  recentExchange?: string | null;
  // Facts for this reply (replyGrounding). Tools add what they actually did
  // so the grounding check accepts it, and shareLink only sends links on file.
  facts?: { add: (kind: "did_this_turn" | "known" | "ongoing" | "not_done" | "capability", text: string) => void; text: () => string };
  // A first read this turn (services/theDoor.ts): held until the reply goes out, then counted as given only if a sent text says it back.
  onFirstRead?: (pending: import("../services/theDoor.js").FirstReadPending) => void;
  // Thread the next text under theirs too (routes/sendblue.ts): the first find
  // after a "looking" line, the way the first search result always was.
  threadNext?: () => void;
};

// The exchange a yes answers: the caller's, else Co's last line alone.
// Pure: their words, when the quote is copied from what they said: this message, or on a call this turn and the call's last turns (their
// lines only, never Cue's). Anything else is null: a place, a window or a free time is never kept on Cue's paraphrase.
export function theirQuote(message: string, recent: string | null | undefined, quote: string | null | undefined): string | null {
  const q = String(quote ?? "").trim();
  if (q.length < 3) return null;
  const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  // The exchange may start mid-line ("…<tail>", exchangeText trims long ones): that fragment could be Cue's, so it never counts.
  const lines = String(recent ?? "").split("\n");
  if (/^\s*…/.test(lines[0] ?? "")) lines.shift();
  const theirs = [message, ...lines.filter((l) => !/^\s*(Co|Cue):/i.test(l))].filter(Boolean);
  return theirs.some((t) => norm(t).includes(norm(q))) ? q : null;
}

// Where and until when a want is for, from their own words (services/wantWhen.ts, the bounce; Royce 2026-10-15). Kept only when their
// words this turn (or the call's last turns) say it; the want's own place otherwise comes from its words (wantPlace.ts), and with none,
// Cue looks near home and says so out loud, or asks (Royce's design pass: "defaults to home and says so out loud... if Cue doesn't know,
// it asks instead of guessing").
export async function wantWhereFromWords(ctx: Pick<ConversationToolContext, "userId" | "resolvedContent" | "recentExchange" | "lastCoMessage">, text: string, w: { place?: string; until?: string; theirWords?: string }): Promise<{ fact: string; note: string } | null> {
  // The ask row the save just wrote (or updated): theirs, open, with this text.
  const [{ rows: row }, { rows: prof }] = await Promise.all([
    pool.query(`SELECT id FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND ask_text = $2 ORDER BY COALESCE(last_mentioned_at, created_at) DESC LIMIT 1`, [ctx.userId, text]),
    pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [ctx.userId]),
  ]);
  if (!row[0]) return null;
  const home: string | null = prof[0]?.city ?? null;
  const W = await import("../services/wantPlace.js");
  const WW = await import("../services/wantWhen.js");
  const { localDay } = await import("../services/memberTime.js");
  const today = localDay(new Date(), await memberZone(ctx.userId).catch(() => null));
  const quoted = theirQuote(ctx.resolvedContent, recentOf(ctx), w.theirWords);
  const place = quoted && w.place ? W.backedPlace(w.place, quoted, [quoted])?.place ?? null : null;
  const until = quoted && w.until ? WW.windowBacked(w.until, quoted, today) : null;
  const key = W.wantKeyForAsk(String(row[0].id));
  if (place || until) await WW.saveWantWhere(pool, ctx.userId, key, text, { place, placeQuote: place ? quoted : null, windowStart: until ? today : null, windowEnd: until, windowQuote: until ? quoted : null });
  const notes: string[] = [];
  if (place) notes.push(`It's for ${place}.`);
  if (until) notes.push(`It's for ${WW.describeWindow(null, until)}.`);
  if ((w.place && !place) || (w.until && !until)) notes.push("What you passed for where or when wasn't in their own words, so it isn't kept; ask if it matters.");
  // No place passed: the want's own words are read now, the way the sweep would (one small read), so "near home" is only said when true.
  const read = place ? null : await W.placeFor(ctx.userId, { key, text, createdAt: new Date() }).catch(() => null);
  const where = place ?? read?.place ?? null;
  if (!place && read?.place) notes.push(`It's for ${read.place}, from ${read.source === "their_words" ? "their words" : "what they've told you about where they go for this"}.`);
  if (!where) notes.push(`No place on it: Cue looks near their home${home ? ` (${home})` : ""}. Say that in a line, or ask where if it's not clear.`);
  return { fact: `Cue's daily search is now looking for: "${text}"${where ? ` in ${where}` : ""}${until ? `, ${WW.describeWindow(null, until)}` : ""}. If something real fits, Cue may text them (at most one text a day). Cue can't promise it will find anything, or when.`, note: notes.join(" ") };
}

const recentOf = (ctx: Pick<ConversationToolContext, "recentExchange" | "lastCoMessage">): string | null => ctx.recentExchange ?? (ctx.lastCoMessage ? `Cue: ${ctx.lastCoMessage}` : null);

// Whether this turn needs words, not a reaction: the brain's decision when there is one (its tapback rule), else the turn's flags.
function wordsDue(ctx: Pick<ConversationToolContext, "decision" | "safetyConcern" | "replyOwed">): { why: string; tell?: string } | null {
  if (ctx.decision) return ctx.decision.dontSay.find((r) => r.what === "tapback") ?? null;
  if (ctx.safetyConcern) return { why: "they may not be safe, so Cue has to reply", tell: "They may not be safe. Reply to them properly." };
  if (ctx.replyOwed) return { why: "Cue still owes them an answer from before, so it has to reply", tell: "You still owe them an answer from before. Reply properly instead." };
  return null;
}

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
  // laneNotes: a confirmed lane move's one line, waiting for the reply that carries it (laneMoves.ts carryLaneNotes); laneNotesSent: lines
  // already carried this turn, never again. closedTaskGoals: tasks closed this turn, so a lookout Co starts can't restate one.
  const state = { safetyFlagged: false, sent: false, reacted: false, replyCount: 0, failedSends: 0, sendStopped: false, sendsHeld: false, partialUnsent: null as string | null, lastReplyText: "", sentMessages: [] as string[], pendingLinks: [] as string[], linkDelivered: false, statusRaised: [] as number[], statusOverridden: [] as number[], statusFacts: [] as number[], laneNotes: [...(ctx.laneNotesOwed ?? [])] as string[], laneNotesSent: [] as string[], stopNotes: [...(ctx.stopNotesOwed ?? [])] as string[], stopNotesSent: [] as string[], closedTaskGoals: [] as string[], holdLines: [] as string[], findsNudged: false, findsReads: 0 };
  // This turn's loop (what its searches found and what went out with shareFinds), set where the loop tools are made below.
  let turnLoop: LoopState | null = null;
  // What went to them this turn that answers something: a holding line ("Let me look") is not an answer.
  const answeredSent = () => state.sentMessages.filter((m) => !state.holdLines.includes(m.trim()));
  // What went out carries these lane lines: they're said now, and never again this turn.
  const markLaneNotesSent = (went: string) => {
    const said = (n: string) => went.toLowerCase().replace(/\s+/g, " ").includes(n.toLowerCase());
    // The stopped-looking line too (services/askRetire.ts): said now, never again.
    const stops = state.stopNotes.filter(said);
    state.stopNotesSent.push(...stops);
    state.stopNotes = state.stopNotes.filter((n) => !said(n));
    const out = state.laneNotes.filter(said);
    if (!out.length) return;
    state.laneNotesSent.push(...out);
    state.laneNotes = state.laneNotes.filter((n) => !said(n));
  };
  // A save or a start that may be an open task of Co's (services/statusCheck.ts): said once, Co decides. differentFrom that task's number
  // goes through, logged. The candidate's standing goes in the facts once a turn, through their fence, and not when the turn already
  // carries it.
  const statusCandidate = async (text: string, differentFrom: number | undefined, tool: string): Promise<{ hold: string } | null> => {
    const S = await import("../services/statusCheck.js");
    const t = S.restatedTask(text, await S.openWorkForTool(ctx.userId, ctx.dryRun));
    if (!t) return null;
    if (differentFrom === t.id) {
      if (!state.statusOverridden.includes(t.id)) state.statusOverridden.push(t.id);
      if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "status_check.different", userId: ctx.userId, outcome: "act", action: tool, proposal: { taskId: t.id, text: text.slice(0, 200) } }).catch(() => {});
      return null;
    }
    // Asked again without differentFrom: one short reminder, not the whole hint again.
    if (state.statusRaised.includes(t.id)) return { hold: S.alreadyHeld(t) };
    const strip = await S.stripForTool(ctx.userId);
    state.statusRaised.push(t.id);
    if (ctx.turn?.statusCheck?.taskId !== t.id && !state.statusFacts.includes(t.id)) {
      state.statusFacts.push(t.id);
      ctx.facts?.add("known", S.whereItStands(t, await memberZone(ctx.userId).catch(() => null), strip));
    }
    return { hold: S.looksLike(t, strip) };
  };
  ctx.checkAnswer = async (draft: string) => brandSafe(ctx.gate ? await ctx.gate(draft, [...state.sentMessages], answeredSent()) : draft, ctx.resolvedContent);
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
      execute: async ({ message: draft }, call?: { toolCallId?: string }) => {
        // Rule 2 (Royce, 2026-10-11): a page or deck goes as ONE text, the line plus the link. Told so, Co still added a second
        // ("Done. The old link is dead now, only this new one works.") in live runs, so after a link went out nothing more does.
        // An answer to something else they asked still goes (Royce, 2026-10-11: never drop it silently); commentary on the link
        // doesn't (agent/linkAnswer.ts afterLinkAnswers). Either way it's logged.
        // The answer that was meant to ride with the link didn't go (agent/linkAnswer.ts withAnswer): this one reply may answer it.
        const owed = state.linkDelivered && ctx.answerOwed ? ctx.answerOwed : null;
        if (owed) ctx.answerOwed = null;
        // Still owed when this reply didn't go out (emptied by the check, or the send failed): the retry keeps the allowance.
        const stillOwed = () => {
          if (owed) ctx.answerOwed = owed;
        };
        if (state.linkDelivered) {
          // Already said with the link (alsoAnswer): never twice.
          const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
          if (norm(draft).length > 20 && norm(state.sentMessages.join(" ")).includes(norm(draft))) {
            // Nothing went, so an owed answer is still owed.
            stillOwed();
            notDone("A reply repeating what already went with the link wasn't sent again.");
            // A lane move's line still has to go (laneMoves.ts): one short new line carries it.
            if (state.laneNotes.length) return { ok: false, error: "That already went with the link. Send one short new line with sendReply; code adds the move's line to it." };
            return { ok: true, note: "That already went with the link; nothing more went out." };
          }
          const { afterLinkAnswers } = await import("./linkAnswer.js");
          const answers = ctx.dryRun || owed ? true : await afterLinkAnswers(ctx.resolvedContent, state.sentMessages.join("\n"), draft);
          if (!ctx.dryRun) {
            const { recordDecision } = await import("../harness/core.js");
            await recordDecision({ layer: 3, decision: "reply.after_link", userId: ctx.userId, outcome: answers ? "act" : "skip", action: owed ? "sent_owed_answer" : answers ? "sent_answer" : "held_commentary", proposal: { draft: draft.slice(0, 300), ...(owed ? { owed: owed.slice(0, 200) } : {}) } }).catch(() => {});
          }
          // A lane move's line pending lets one reply through after the link: it's the only way the line reaches them (laneMoves.ts).
          if (!answers && !state.laneNotes.length) {
            notDone("A reply about the link after the link wasn't sent (the link's text is the whole delivery).");
            return { ok: false, error: "Not sent: it was about the page or deck, and the link's text is the whole delivery. Don't call sendReply again this turn." };
          }
        }
        // The reply uses what its own search found (agent/findGuards.ts; Royce, 2026-10-17): a find named without its link, or "it's
        // thin" while finds wait, gets one redraft through shareFinds. Once a turn, so it can never loop.
        // Only while a redraft can follow (review of this change): the plain text sent after the loop ended, the last step or the
        // last seconds go out as written, never swapped for the fallback line.
        const canRedraft = call?.toolCallId !== "plain-text-reply" && (ctx.redraftLeft?.() ?? true);
        const finds = turnLoop && canRedraft ? turnFinds(turnLoop.found.values()) : [];
        if (turnLoop && finds.length && !state.findsNudged) {
          let kind: "unlinked" | "ignored" | null = unlinkedFinds(draft, finds, turnLoop.shared).length ? "unlinked" : ignoresFinds(draft, finds, turnLoop.shared) ? "ignored" : null;
          // The words found nothing, finds are waiting and none has gone out, nor rides in this draft: one meaning read
          // (agent/findGuards.ts). X posts are never asked about by name: a post's name is its own prose, so talk on the same subject
          // would read as naming it.
          if (!kind && state.findsReads < FIND_READS_PER_TURN && !turnLoop.shared.length && !finds.some((f) => draft.includes(f.url)) && draft.trim().length >= 12) {
            state.findsReads += 1;
            const named = finds.filter((f) => !isPost(f)).slice(0, 12);
            const use = await (ctx.findUseRead ?? realFindUseRead)(draft, named.length ? named : finds.slice(0, 12));
            if (use?.named.length && named.length) kind = "unlinked";
            else if (use?.saysNothing) kind = "ignored";
          }
          if (kind) {
            state.findsNudged = true;
            if (!ctx.dryRun) {
              const { recordDecision } = await import("../harness/core.js");
              await recordDecision({ layer: 3, decision: "reply.finds_guard", userId: ctx.userId, outcome: "skip", action: kind, proposal: { draft: draft.slice(0, 300), finds: finds.length, shared: turnLoop.shared.length } }).catch(() => {});
            }
            return stillOwed(), { ok: false, error: findsRedraftNote(kind, finds, turnLoop.shared) };
          }
        }
        // A note to itself ("(no further message needed)") is never the reply while nothing has answered them yet (10-17: it was, and
        // the fallback line went out).
        if (/^\s*\([^)]*\)\s*$/.test(draft) && !answeredSent().length) return stillOwed(), { ok: false, error: "Not sent: that's a note to yourself, and nothing has answered them yet (a holding line isn't an answer). Write the reply to them and call sendReply again." };
        // Finds waiting and a redraft still possible: a reply the check cuts to almost nothing comes back empty, for the redraft below.
        // The window is read again when the check decides (review of #228): the check's own redrafts can outlast it, and an empty
        // reply then asks for a redraft that can't happen, so the member got the fallback line. Past it, the check's honest line goes.
        const findsWaiting = !!turnLoop && !state.findsNudged && finds.some((f) => !turnLoop!.shared.includes(f.url));
        const findsWaitingNow = () => findsWaiting && (ctx.redraftLeft?.() ?? true);
        let message = brandSafe(ctx.gate ? await ctx.gate(draft, [...state.sentMessages], answeredSent(), findsWaitingNow) : draft, ctx.resolvedContent);
        // An owed answer the check emptied never went: not "already answered", it's said again plainly.
        if (!message.trim() && owed) return stillOwed(), { ok: false, error: "Nothing was left to send after the fact check. Say it again plainly, only what you know is true, and call sendReply again." };
        // The fact check left nothing to add after what already went out this turn.
        // (A holding line doesn't count: 10-17 "Let me look" was all that had gone, the reply was told it was the answer, and the member
        // got the fallback.)
        if (!message.trim() && answeredSent().length) return { ok: true, note: "What you already sent this turn is the answer; nothing more went out. Don't add a closing line." };
        // Emptied with finds waiting: the one redraft goes through them (agent/findGuards.ts), never the fallback line.
        if (!message.trim() && turnLoop && !state.findsNudged && finds.some((f) => !turnLoop!.shared.includes(f.url))) {
          state.findsNudged = true;
          return stillOwed(), { ok: false, error: findsRedraftNote("emptied", finds, turnLoop.shared) };
        }
        // Never an empty text (2026-10-12 audit, row 11661): with nothing sent yet, Co says it again from what's true.
        if (!message.trim()) return stillOwed(), { ok: false, error: "Nothing was left to send after the fact check. Say it again plainly, only what you know is true, and call sendReply again." };
        // A confirmed lane move's line rides in this reply, exactly once, after the check (laneMoves.ts carryLaneNotes, Royce 2026-10-13):
        // never a text of its own, never repeated in a second reply this turn.
        if (state.laneNotes.length || state.laneNotesSent.length) message = carryLaneNotes(message, state.laneNotes, state.laneNotesSent).text;
        // The stopped-looking line rides in the first reply that goes, once (services/askRetire.ts); never when they may not be safe.
        if ((state.stopNotes.length || state.stopNotesSent.length) && !ctx.safetyConcern && !state.safetyFlagged) message = carryLaneNotes(message, state.stopNotes, state.stopNotesSent).text;
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
              state.sendsHeld = !!sendLimiter.blocked(ctx.phoneNumber);
              if (!sentBeats.length) {
                if (sendLimiter.blocked(ctx.phoneNumber) || state.failedSends >= 2) {
                  state.sendStopped = true;
                  return { ok: false, error: "Texts to them can't go out right now. Stop here; don't call any more tools." };
                }
                stillOwed();
                return { ok: false, error: "That message didn't go out. Rewrite it as a plain, direct text to them and call sendReply again." };
              }
              // Part went out and the rest didn't (2026-10-12 audit: "Fair." went, the draft after it was refused, and the reply
              // looked done). The model is told what's missing so it sends it; if it can't, the turn ends with an honest line
              // (conversationReply.ts), never on the bare first beat.
              notDone(`Only part of the reply went out: "${beat.slice(0, 120)}" didn't send.`);
              const went = sentBeats.join("\n\n");
              markLaneNotesSent(went);
              state.sentMessages.push(went);
              state.lastReplyText = state.lastReplyText ? `${state.lastReplyText} ${went}` : went;
              state.sent = true;
              state.replyCount += 1;
              state.partialUnsent = beats.slice(i).join("\n\n");
              // What went out counts (ok), and the note says what's missing.
              if (sendLimiter.blocked(ctx.phoneNumber) || state.failedSends >= 2) {
                state.sendStopped = true;
                return { ok: true, note: "Only the first part went out, and texts to them can't go out right now. Stop here; don't call any more tools." };
              }
              return { ok: true, note: `Only this went out: "${went.slice(0, 200)}". The rest didn't send. Send the rest now with sendReply, as a plain, direct text to them, without repeating what went out.` };
            }
            await logDelivered(`Co replied: ${cleanCoMessage(beat)}`);
            sentBeats.push(beat);
          }
          const sentText = sentBeats.join("\n\n");
          markLaneNotesSent(sentText);
          state.partialUnsent = null;
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
            state.sendsHeld = !!sendLimiter.blocked(ctx.phoneNumber);
            if (sendLimiter.blocked(ctx.phoneNumber) || state.failedSends >= 2) {
              state.sendStopped = true;
              return { ok: false, error: "Texts to them can't go out right now. Stop here; don't call any more tools." };
            }
            stillOwed();
            return { ok: false, error: "That message didn't go out. Rewrite it as a plain, direct text to them and call sendReply again." };
          }
        }
        state.partialUnsent = null;
        markLaneNotesSent(message);
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
        if (state.sentMessages.includes("[sent Cue's contact card]")) return { ok: true, note: "Already sent this turn." };
        if (!process.env.CO_VCARD_URL) {
          notDone("Cue's contact card was not sent (it isn't available right now).");
          return { ok: false, error: "The card isn't available right now, so it was NOT sent. Tell them plainly." };
        }
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would send contact card to ${ctx.userId}`);
        } else {
          try {
            await sendblue.messages.send({ number: ctx.phoneNumber, content: "Here's my card.", media_url: process.env.CO_VCARD_URL, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
          } catch (err: any) {
            notDone("Cue's contact card was not sent (the send failed).");
            return { ok: false, error: "The card did NOT go through. Tell them plainly." };
          }
          await logDelivered("Co replied: [sent Cue's contact card]");
        }
        state.sentMessages.push("[sent Cue's contact card]");
        ctx.facts?.add("did_this_turn", "Sent Cue's contact card as its own message just before this reply.");
        return { ok: true };
      },
    }),

    // Feedback for the team, saved by Co (services/issueReports.ts saveFeedback).
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

    // What Co knows about them, shown in plain words, and corrected or removed at the source (services/whatCoKnows.ts).
    whatCoKnows: tool({
      description: toolUse("whatCoKnows"),
      inputSchema: z.object({}),
      execute: async () => {
        const W = await import("../services/whatCoKnows.js");
        // Fails closed: if another member's details can't be stripped, nothing is shown.
        const got = await W.whatCoKnows(ctx.userId).catch((err: any) => {
          console.error("whatCoKnows: read failed (non-fatal):", err?.message ?? err);
          return null;
        });
        if (!got) {
          notDone("What Cue knows about them couldn't be read just now.");
          return { ok: false, error: "Couldn't read it right now. Say so plainly and offer to try again in a bit." };
        }
        ctx.facts?.add("known", W.knownFact(got.view));
        return {
          ok: true,
          groups: got.view.groups.map((g) => ({ title: g.title, lines: g.lines.map((l) => ({ refs: l.refs, text: l.text, theirWords: l.theirWords, canCorrect: l.canCorrect })) })),
          note: "Lines starting 'my read:' are your own read of them, so say so. canCorrect false: it can be removed, not reworded. Never show refs.",
        };
      },
    }),
    correctWhatCoKnows: tool({
      description: toolUse("correctWhatCoKnows"),
      inputSchema: z.object({
        changes: z
          .array(
            z.object({
              refs: z.array(z.string()).min(1).describe("The refs of every line from whatCoKnows that says this thing."),
              action: z.enum(["correct", "remove"]),
              now: z.string().optional().describe("correct only: what's true now, short, in their words (\"Oakland\")."),
            }),
          )
          .min(1)
          .max(6),
      }),
      execute: async (input: any) => {
        const { changes } = input as { changes: { refs: string[]; action: "correct" | "remove"; now?: string }[] };
        if (ctx.dryRun) return { ok: true, applied: [], note: "(dry run) nothing changed." };
        const W = await import("../services/whatCoKnows.js");
        const r = await W.applyKnowledgeChanges(ctx.userId, changes, { message: ctx.resolvedContent, theirWords: String(input?.theirYes ?? ctx.resolvedContent), lastCoMessage: ctx.lastCoMessage ?? null });
        for (const a of r.applied) {
          ctx.facts?.add("did_this_turn", a.now == null ? `Removed from what Cue knows about them, everywhere Cue uses it: "${a.was.slice(0, 120)}".` : `Corrected what Cue knows about them, everywhere Cue uses it: "${a.was.slice(0, 80)}" is now "${a.now.slice(0, 80)}".`);
        }
        if (!r.applied.length) notDone("Nothing Cue knows about them was changed.");
        return {
          ok: r.ok,
          ...(r.ok ? {} : { error: r.refused.map((x) => x.why).join("; ") || "nothing matched" }),
          changed: r.applied.map((a) => ({ was: a.was, now: a.now })),
          refused: r.refused,
          stillSays: r.alsoSays.map((l) => ({ refs: l.refs, text: l.text })),
          // What was waiting on it and was taken out of line (cancelled) or sent back to be judged again (recheck). No need to list it.
          queuedStopped: (r.cancelled ?? []).map((c) => ({ what: c.what, action: c.action })),
        };
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
        differentFrom: z.number().optional().describe("Only after this tool said it looks like an open task: that task's number, when this is something different."),
      }),
      execute: async ({ goal, theirWords, steps, firstStep, inHours, deadline, lookout, differentFrom }) => {
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
        // Something that may be an open task of Co's (services/statusCheck.ts, Royce 2026-10-13): said once, Co decides. A lookout on
        // their own watch words goes ahead (#194's exemption); the open task is named in its result.
        const theirWatch = !!lookout && T.WATCH_ASK.test(ctx.resolvedContent) && T.wordsAreTheirs(theirWords, ctx.resolvedContent);
        let alsoOpen: string | null = null;
        if (theirWatch) {
          const S = await import("../services/statusCheck.js");
          const t = S.restatedTask(goal, await S.openWorkForTool(ctx.userId, ctx.dryRun));
          if (t) alsoOpen = `It's also open as task #${t.id}. This lookout is theirs, on their own words. If they meant that task itself should change, that's moveLane on their yes; don't close or change it on your own.`;
        } else {
          const c = await statusCandidate(goal, differentFrom, "startTask");
          if (c) return { ok: false, error: c.hold };
        }
        // A task becomes a lookout only on their words (laneMoves.ts, Royce 2026-10-13): unless their own message asks Co to watch (and
        // the quote is from it), a lookout never restates one of their tasks or open asks (closed this turn or still open). A yes to Co's
        // offer to watch doesn't count: Co never offers to turn a task into a lookout (review, 2026-10-13).
        if (lookout && !(T.WATCH_ASK.test(ctx.resolvedContent) && T.wordsAreTheirs(theirWords, ctx.resolvedContent))) {
          const open = ctx.dryRun
            ? []
            : await Promise.all([
                T.openTasks(ctx.userId).then((ts) => ts.filter((t) => t.source !== "lookout").map((t) => t.goal)),
                pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND intent IS DISTINCT FROM 'lookout'`, [ctx.userId]).then((r) => r.rows.map((x: any) => String(x.ask_text))),
              ]).then(([a, b]) => [...a, ...b]).catch(() => [] as string[]);
          const task = lookoutRestatesTask(goal, [...state.closedTaskGoals, ...open]);
          if (task) {
            notDone(`No lookout was started: "${task.slice(0, 80)}" is one of their tasks, and a task becomes a lookout only on their words.`);
            return { ok: false, error: `That's their task "${task.slice(0, 80)}". A task becomes a lookout only when they ask you to keep watching, in their words; don't offer it. Keep working it as a task.` };
          }
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
          ctx.facts?.add("did_this_turn", `Started task: "${goal}". Cue will work on it first in about ${T.clampNextHours(inHours)} hours: ${firstStep}.${dl ? ` Their deadline: ${dl.deadline}; Cue's last check before it is ${localStamp(dl.finalCheckAt, zone)}.` : ""}`);
          return { ok: true, deadline: dl };
        }
        // A look-out's origin, recorded now so the send path never guesses (Royce, 2026-10-09): theirs only when this message asks Co
        // to watch or says yes to Co's offer to (their finds are deliveries); otherwise Co's, and its finds are counted (review of #131).
        const offer = lookout ? T.watchOfferIn(String(ctx.lastCoMessage ?? "")) : null;
        const offerLogged = offer ? await import("../harness/proactive.js").then((P) => P.replyWatchOfferLogged(ctx.userId, String(ctx.lastCoMessage ?? ""))).catch(() => false) : false;
        const origin = lookout ? T.lookoutOriginAt({ message: ctx.resolvedContent, quote: theirWords, lastCoMessage: ctx.lastCoMessage, offerLogged }) : null;
        const r = await T.startTask({ userId: ctx.userId, goal, theirWords: yesToOffer ? `${ctx.resolvedContent.trim()} (to Cue's offer: ${String(ctx.lastCoMessage ?? "").slice(0, 160)})` : theirWords, steps, firstPlan: firstStep, inHours, deadline: dl, ...(origin ? { source: "lookout" as const, lookoutOrigin: origin } : {}) });
        if (!r.ok) {
          notDone(`No task was started: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: "${r.task.goal}". Cue will work on it first around ${r.task.nextCheckAt ? localStamp(r.task.nextCheckAt, zone) : "soon"}: ${firstStep}.${r.task.deadline ? ` Their deadline: ${r.task.deadline}; Cue's last check before it, where it tells them where things stand, is around ${r.task.finalCheckAt ? localStamp(r.task.finalCheckAt, zone) : "the day before"}.` : ""}`);
        return { ok: true, taskId: r.task.id, nextCheckAt: r.task.nextCheckAt, ...(alsoOpen ? { note: alsoOpen } : {}) };
      },
    }),
    // The door (services/theDoor.ts): a new member's first read, once. Code holds the facts (once, new members, their own words,
    // a time from code that a task keeps); Co decides when and says it.
    firstRead: tool({
      description: toolUse("firstRead"),
      inputSchema: z.object({
        understood: z.string().describe("One line: what you understood they're after, only from what they told you."),
        lookFor: z.string().describe("The one thing you'll look for first, in their terms, in a few words."),
        theirWords: z.string().describe("Their own words it comes from, copied exactly from what they wrote."),
      }),
      execute: async ({ understood, lookFor, theirWords }) => {
        const { giveFirstRead } = await import("../services/theDoor.js");
        const r = await giveFirstRead({ understood, lookFor, theirWords }, { userId: ctx.userId, message: ctx.resolvedContent, dryRun: ctx.dryRun, paused: proactivePaused() });
        if (!r.ok) {
          notDone(`No first read was recorded: ${r.error}`);
          return { ok: false, error: r.error };
        }
        ctx.facts?.add("did_this_turn", r.fact);
        ctx.onFirstRead?.(r.pending);
        return r.timed ? { ok: true, textThemBy: r.pending.words, note: r.note } : { ok: true, note: r.note };
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
      inputSchema: z.object({ taskId: z.number(), status: z.enum(["done", "dropped"]), outcome: z.string(), theirWords: z.string().optional().describe("When they closed it themselves (\"we booked it\", \"don't need it anymore\"): their exact words from this message.") }),
      execute: async ({ taskId, status, outcome, theirWords }) => {
        if (ctx.dryRun) return { ok: true };
        const T = await import("../services/coTasks.js");
        // Their own word, from this message, is what makes a drop theirs; without it a drop counts as a promise Co didn't keep.
        const theirWord = theirWords && T.wordsAreTheirs(theirWords, ctx.resolvedContent) ? theirWords : null;
        const closing = await T.getTask(ctx.userId, taskId).catch(() => null);
        if (!(await T.closeTask(ctx.userId, taskId, status, outcome, { theirWord }))) {
          notDone(`Task #${taskId} wasn't closed: it isn't one of their open tasks.`);
          return { ok: false, error: "No open task with that id." };
        }
        if (closing && closing.source !== "lookout") state.closedTaskGoals.push(closing.goal);
        ctx.facts?.add("did_this_turn", `Closed task #${taskId} (${status}): ${outcome}`);
        return { ok: true };
      },
    }),

    // Goal ownership (services/goalOwnership.ts): Co splits a goal they hand it, offers the split once, and works only what they pick.
    takeOnGoal: tool({
      description: toolUse("takeOnGoal"),
      inputSchema: z.object({
        title: z.string().describe("The goal in a few words, in their terms."),
        theirWords: z.string().describe("A quote of their own words handing it over, copied exactly from their message."),
        items: z
          .array(z.object({ text: z.string().describe("The piece, in a few words."), who: z.enum(["co", "member"]), how: z.enum(["research", "draft", "watch", "reminder"]).optional().describe("Only for who: co.") }))
          .max(10)
          .optional()
          .describe("The goal's pieces. Leave out only when the goal is in a file they sent (file): its pieces come from the file."),
        moment: z
          .object({ date: z.string().describe("YYYY-MM-DD"), theirWords: z.string().describe("Their own words naming it, copied exactly (\"the show is Nov 8\").") })
          .optional()
          .describe("The dated moment the goal is for, only if they named one (a launch, a show, a decision day)."),
        file: z.number().int().nonnegative().optional().describe("Only when they sent a file and, in this message, handed it over for you to work through with them (\"hold me accountable on this\"): its number, or 0 for the one they just sent."),
      }),
      execute: async ({ title, theirWords, items: given, moment, file }) => {
        const G = await import("../services/goalOwnership.js");
        const T = await import("../services/coTasks.js");
        const recent = ctx.dryRun
          ? ""
          : await pool
              .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 6`, [ctx.userId])
              .then((r) => r.rows.map((x: any) => String(x.content)).join("\n"))
              .catch(() => "");
        if (!T.wordsAreTheirs(theirWords, `${ctx.resolvedContent}\n${recent}`)) {
          notDone("No goal was taken on: the quote isn't in their words.");
          return { ok: false, error: "theirWords must be copied exactly from what they wrote. Only a goal they handed you." };
        }
        const zone = await memberZone(ctx.userId).catch(() => null);
        // The moment they're counting on: a real date, in their words, ahead (the same check as a task deadline).
        const m = moment ? T.planDeadline({ date: moment.date, words: moment.theirWords }, `${ctx.resolvedContent}\n${recent}`, zone, new Date()) : null;
        if (m && !m.ok) notDone(`The goal's moment wasn't kept: ${m.why}.`);
        const goalMoment = m?.ok ? { date: m.deadline, words: moment!.theirWords.slice(0, 120) } : null;
        // A file they handed over (goalOwnership.ts, unsealed by purpose): their words in THIS message must hand it over; then only its
        // item titles leave the seal, each held to the no-other-person rule. Anything short of that keeps the seal.
        let items: unknown = given ?? [];
        let fromFile: { n: number; quote: string; dropped: number } | null = null;
        if (file !== undefined) {
          const hand = ctx.dryRun ? { handsOver: false, quote: null, read: false } : await G.handsOverFile(ctx.resolvedContent);
          if (!hand.handsOver || !hand.quote) {
            notDone("Their file stayed sealed: this message doesn't hand it over for you to work through with them.");
            return { ok: false, error: "Their file stays sealed: they haven't handed it over for goal work in this message. Don't describe what's in it. If they want to work through it with you, they can say so, or paste the list." };
          }
          const F = await import("../services/memberFiles.js");
          // Tied to the specific file: the one this message names, or the one they just sent (goalOwnership.ts handoverFile).
          const on = await F.readableFileTimes(ctx.userId).catch(() => [] as { n: number; at: Date }[]);
          const which = G.handoverFile(on, file, ctx.resolvedContent, new Date());
          if (!which.ok) {
            notDone(`Their file stayed sealed: ${which.why}.`);
            return { ok: false, error: `Their file stays sealed: ${which.why}. Don't describe what's in it; ask which file they mean, or ask them to paste the list.` };
          }
          const f = await F.fileText(ctx.userId, which.n);
          if (!f) {
            notDone("No file of theirs was found to work from.");
            return { ok: false, error: "There's no readable file of theirs on file with you. Ask them to send it again or paste the list." };
          }
          const names = await import("../services/memberSafeMemories.js").then((x) => x.memberNamesStrict(ctx.userId)).catch(() => null);
          if (!names) {
            notDone("Their file stayed sealed: the member-name check couldn't run.");
            return { ok: false, error: "Their file stays sealed right now. Ask them to paste the list instead." };
          }
          const titles = await G.titlesFromFile(f.text, `${ctx.resolvedContent}\n${recent}`, names, undefined, { memberName: ctx.firstName ?? null });
          if (!titles.ok) {
            notDone(`Nothing came out of their file #${f.n}: ${titles.why}.`);
            return { ok: false, error: `Nothing usable came out of their file (${titles.why}). Ask them to paste the list.` };
          }
          items = titles.items;
          fromFile = { n: f.n, quote: hand.quote, dropped: titles.dropped };
          await recordDecision({ layer: 3, decision: "goal.file_unsealed", userId: ctx.userId, outcome: "act", action: `file #${f.n}`, reason: hand.quote.slice(0, 200), proposal: { file: f.n, quote: hand.quote.slice(0, 200), kept: titles.items.length, dropped: titles.dropped } }).catch(() => {});
        }
        const cleaned = G.cleanItems(items);
        if (!cleaned.length) {
          notDone("No goal was taken on: it had no pieces.");
          return { ok: false, error: "Write the goal's pieces." };
        }
        // Co's judgment on the goal and each piece, a fail-safe read: unread means light (no split) and every piece theirs.
        const read = await G.readGoal(title, theirWords, cleaned);
        let split = G.splitFor(cleaned.map((i) => ({ ...i, reach: read.reach.get(i.n) ?? "unread" })), read.clubWorld);
        // Admin and grind (outside the club's world): one reminder for the whole goal and its deadline, always. The deadline is the
        // moment Co gave, or one in their own words ("before the 30th"), read in code.
        const lightMoment = goalMoment ?? G.deadlineInTheirWords(ctx.resolvedContent, new Date(), zone);
        if (!read.clubWorld) split = G.withLightReminder(split, title, lightMoment, { now: new Date(), zone });
        const mayTake = split.filter((i) => i.owner === "co");
        const handedBack = cleaned.filter((i) => i.owner === "co" && split.find((x) => x.n === i.n)?.owner === "member");
        // The light path: Co reads only what it can offer (the reminder and its timing) and the instruction to offer it. Who owns the rest
        // and why the goal is light stay in the log (goal.offered), never in what Co reads: Co echoed that framing back as a decline.
        const reminderPiece = !read.clubWorld ? split.find((i) => i.owner === "co" && i.how === "reminder") ?? null : null;
        const guidance = !read.clubWorld
          ? reminderPiece?.suggest
            ? `Open your reply with a plain, warm offer, in your own words and short, to remind them about ${reminderPiece.text.replace(/, ahead of .*$/, "")} on ${reminderPiece.suggest.day}: name what it's for and that day. Make it simply an offer, never framed against a limit (no "what I can do is", "all I can", "the most I can"). A line of real help can follow it. If they say yes, pickGoalItems with piece ${reminderPiece.n} and checkIn "${reminderPiece.suggest.day}" (or the day they pick instead).`
            : `Open your reply with a plain, warm offer, in your own words and short, to remind them about ${reminderPiece?.text ?? "it"}, and ask what day suits them. Make it simply an offer, never framed against a limit (no "what I can do is", "all I can", "the most I can"). A line of real help can follow it. If they say yes, pickGoalItems with piece ${reminderPiece?.n ?? 1} and the day they give in checkIn.`
          : mayTake.length
            ? "Offer the split once, in your own words, naturally, in this reply: what you'd take and what stays with them. No list, no numbers, no form. Nothing starts until they pick."
            : "Nothing here is yours to take on your own: every piece stays with them. Help in the moment, and offer to draft anything they'd send themselves.";
        if (ctx.dryRun) {
          ctx.facts?.add("known", `Goal they handed you, "${title}": ${guidance}`);
          if (!read.clubWorld) return { ok: true, youMayOffer: reminderPiece ? [{ n: reminderPiece.n, text: reminderPiece.text, how: "reminder", suggestedDay: reminderPiece.suggest?.day ?? null }] : [], guidance };
          return { ok: true, clubWorld: read.clubWorld, youMayOffer: mayTake.map((i) => ({ n: i.n, text: i.text, how: i.how })), staysTheirs: split.filter((i) => i.owner === "member").map((i) => ({ n: i.n, text: i.text })), guidance };
        }
        const r = await G.offerGoal({ userId: ctx.userId, title, theirWords, items: split, clubWorld: read.clubWorld, clubWhy: read.why, moment: goalMoment, sourceFile: fromFile?.n ?? null, handedOver: fromFile?.quote ?? null });
        if (!r.ok) {
          notDone(`No new goal split was offered: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        await recordDecision({ layer: 3, decision: "goal.offered", userId: ctx.userId, outcome: "act", action: read.clubWorld ? "split" : "light", reason: read.why, proposal: { goalId: r.goal.id, items: split.map((i) => ({ n: i.n, owner: i.owner, how: i.how, reach: i.reach })), read: read.read } }).catch(() => {});
        // The offer itself, backed as an offer (2026-10-13: "I can text you a nudge on the 27th" was cut as an unbacked promise, and only
        // "Want me to set that?" went out): what Co can do for them if they say yes, offered in this reply, nothing set. It backs "I can..."
        // and "want me to...?"; it never backs "I'll text you on the 27th" as if it were set (replyGrounding.ts OFFERED_NOT_SET).
        for (const line of G.offerFactLines(read.clubWorld ? mayTake : split.filter((i) => i.owner === "co" && i.how === "reminder"))) ctx.facts?.add("capability", line);
        ctx.facts?.add("known", `Goal #${r.goal.id} they handed you, "${r.goal.title}", is on file${fromFile ? `, its pieces from their file #${fromFile.n}, which they handed over ("${fromFile.quote.slice(0, 120)}"); only those piece titles are yours to use, nothing else from the file` : ""}${goalMoment ? `; the moment it's for: ${goalMoment.words}` : ""}. Nothing is started on it until they pick. ${guidance}`);
        if (!read.clubWorld) return { ok: true, goalId: r.goal.id, youMayOffer: reminderPiece ? [{ n: reminderPiece.n, text: reminderPiece.text, how: "reminder", suggestedDay: reminderPiece.suggest?.day ?? null }] : [], guidance };
        return {
          ok: true,
          goalId: r.goal.id,
          clubWorld: read.clubWorld,
          youMayOffer: mayTake.map((i) => ({ n: i.n, text: i.text, how: i.how })),
          staysTheirs: split.filter((i) => i.owner === "member").map((i) => ({ n: i.n, text: i.text })),
          handedBack: handedBack.map((i) => ({ n: i.n, text: i.text, why: (read.reach.get(i.n) ?? "unread") === "unread" ? "couldn't be read as safe to do alone" : `it ${read.reach.get(i.n) === "money" ? "spends money" : read.reach.get(i.n) === "public" ? "posts publicly" : "reaches someone other than them"}` })),
          guidance,
        };
      },
    }),
    pickGoalItems: tool({
      description: toolUse("pickGoalItems"),
      inputSchema: z.object({
        goalId: z.number(),
        take: z.array(z.number()).max(10).describe("The item numbers they handed you."),
        checkIn: z.string().optional().describe("The agreed check-in or reminder time, in words (\"Friday\", \"next Tuesday\", \"Oct 20\"). Only if one was agreed."),
      }),
      execute: async ({ goalId, take, checkIn }) => {
        const G = await import("../services/goalOwnership.js");
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `They picked their split on goal #${goalId} (dry run: nothing started).`);
          return { ok: true };
        }
        const zone = await memberZone(ctx.userId).catch(() => null);
        const r = await G.acceptGoal({ userId: ctx.userId, goalId, take, theirMessage: ctx.resolvedContent, checkinWords: checkIn ?? null, zone });
        if (!r.ok) {
          notDone(`Nothing on goal #${goalId} was started: ${r.why}.`);
          return { ok: false, error: r.why };
        }
        // Picking pieces of a goal is a signal for the goals on file it names (services/goalRecheck.ts).
        await import("../services/goalRecheck.js").then((R) => R.noteGoalActionText(ctx.userId, `${r.goal.title} ${r.goal.theirWords ?? ""}`)).catch(() => {});
        for (const s of r.started) ctx.facts?.add("did_this_turn", `Started task #${s.taskId}: "${s.text}", their goal's piece they handed Cue. Cue sends it when it lands.`);
        if (r.checkin) ctx.facts?.add("did_this_turn", `Started task #${r.checkin.taskId}: Cue's check-in on their goal "${r.goal.title}", set for ${localStamp(r.checkin.at, zone)}. Cue can say it'll check back then.`);
        for (const x of r.refused) notDone(x.n ? `Item ${x.n} of goal #${goalId} wasn't taken: ${x.why}.` : `${x.why}.`);
        await recordDecision({ layer: 3, decision: "goal.picked", userId: ctx.userId, outcome: "act", action: `goal:${goalId}`, proposal: { started: r.started, checkin: r.checkin, refused: r.refused } }).catch(() => {});
        return { ok: true, started: r.started.map((s) => ({ text: s.text })), checkIn: r.checkin ? localStamp(r.checkin.at, zone) : null, notTaken: r.refused };
      },
    }),

    // Lane moves (services/laneMoves.ts, Royce 2026-10-13): Co proposes, their yes in this message moves it (toolGuard.ts their_yes),
    // and the move's one line rides in the reply, once (sendReply, carryLaneNotes). A task never becomes a lookout here.
    moveLane: tool({
      description: toolUse("moveLane"),
      inputSchema: z.object({
        item: z.string().describe("The thing as it's listed: a task as \"task #12\", anything else in its own words."),
        from: z.enum(["task", "lookout", "goal"]).describe("Its lane now."),
        to: z.enum(["task", "lookout", "goal"]).describe("Where it goes."),
        label: z.string().optional().describe("A few words naming it for the line (\"the jazz nights\")."),
      }),
      execute: async (input: any) => {
        const { item, from, to, label } = input as { item: string; from: "task" | "lookout" | "goal"; to: "task" | "lookout" | "goal"; label?: string };
        const store = laneStoreFor(ctx.dryRun);
        let line: string;
        let what = item;
        if (!store) {
          // A dry run reads and writes nothing: the rule and the line only.
          const rule = from === to ? null : ruleFor(from, to);
          if (rule === "confirmed" && !offersMove(recentOf(ctx), to, item)) {
            notDone("Nothing moved: their yes wasn't to this move.");
            return { ok: false, error: "Nothing moved: your last text didn't ask them about this move. Offer it first in one line; move it on their yes." };
          }
          if (rule !== "confirmed") {
            notDone(`Nothing moved: ${rule === "their_words" ? "a task becomes a lookout only on their own words" : `${LANE_WORDS[from]} to ${LANE_WORDS[to]} isn't a move Cue makes`}.`);
            return { ok: false, error: "Nothing moved: that isn't a move you offer. Don't offer it again." };
          }
          // A task's number is never said to them: "that task" when Co gave no name.
          line = laneNote(/#\s*\d+/.test(item) ? label?.trim() || "that task" : noteLabel(label, item), from, to);
        } else {
          const r = await moveLane({ userId: ctx.userId, from, to, item, label: label ?? null, theirYes: String(input?.theirYes ?? ""), message: ctx.resolvedContent, recent: recentOf(ctx) }, store);
          if (!r.ok) {
            notDone(`Nothing moved: ${r.why}.`);
            return { ok: false, error: `Nothing moved: ${r.why}. Say so plainly if it matters; don't offer this move again.` };
          }
          line = r.note;
          what = r.item;
        }
        if (!state.laneNotes.includes(line) && !state.laneNotesSent.includes(line)) state.laneNotes.push(line);
        ctx.facts?.add("did_this_turn", `${ctx.dryRun && !store ? "(dry run) " : ""}Moved "${what.slice(0, 120)}" from their ${LANE_WORDS[from]} to their ${LANE_WORDS[to]}, on their yes. The line "${line}" goes in your reply by code.`);
        // Run after the reply already went: the line still needs a text, so one short reply now carries it.
        if (state.replyCount > 0) return { ok: true, line, note: "Moved. Your reply already went, so send one short reply now with sendReply; code puts that line in it. Don't say the move in your own words, and don't recap anything." };
        return { ok: true, line, note: "Moved. Code puts that line in your reply once; don't say the move in your own words, and don't recap anything." };
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
          notDone("Their location wasn't turned on: they have no Noise event today.");
          return { ok: false, error: "They aren't going to a Noise event today, so there's nothing to use it for." };
        }
        if (!ctx.dryRun) await P.recordLocationYes(today.eventApiId, ctx.userId, theirYes);
        ctx.facts?.add("did_this_turn", `They said yes to sharing their location for "${today.name}" only. Cue will use it just to know when they've arrived. They share it themselves in Messages (Share My Location with Cue), and "stop sharing" ends it.`);
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
        ctx.facts?.add("did_this_turn", r.shared.length ? `Recorded which asks Cue may tell a good match in the room: ${r.shared.map((t) => `"${t}"`).join(", ")}. The rest stay private.` : "Recorded that none of their asks are to be shared. They stay private.");
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
        ctx.facts?.add("did_this_turn", answer === "yes" ? `They said Cue may mention "${r.text}" in their own words when introducing them. Their other asks stay private.` : `They said not to mention "${r.text}" to anyone. It stays private.`);
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
        ctx.facts?.add("did_this_turn", answer === "yes" ? "They said yes: Cue may mention them by name in the member brief for that event, with only what they're looking for as the reason. They can change that any time." : "They said no: Cue won't name them in the member brief for that event.");
        return { ok: true, answer };
      },
    }),
    updateGoing: tool({
      description: toolUse("updateGoing"),
      inputSchema: z.object({ going: z.boolean(), theirWords: z.string().describe("Their words, copied exactly.") }),
      execute: async ({ going, theirWords }) => {
        // Going is theirs to say (services/provenance.ts): a short "yes" counts only when it is really in their message.
        if (!quoteIsTheirs(theirWords, ctx.resolvedContent)) {
          notDone("Going wasn't updated: the quote isn't in their words.");
          return { ok: false, error: "Quote their own words." };
        }
        const today = await import("../services/eventPresence.js").then((e) => e.todayEventFor(ctx.userId)).catch(() => null);
        if (!today) return { ok: false, error: "No Noise event of theirs today." };
        if (!ctx.dryRun) await import("../services/preArrival.js").then((P) => P.setGoing(today.eventApiId, ctx.userId, going));
        ctx.facts?.add("did_this_turn", going ? `Noted they're going to "${today.name}".` : `Noted they can't make "${today.name}"; Cue won't send them anything more about it.`);
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
        ctx.facts?.add("did_this_turn", "Flagged that they may not be safe: offers are on hold, and Cue may check in on them tomorrow.");
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
        if (ctx.safetyConcern || ctx.replyOwed || wordsDue(ctx) || coAskedQuestion(ctx.lastCoMessage)) return { ok: false, error: "They need words this time. Reply properly." };
        // A move made this turn says so in the reply's words (laneMoves.ts).
        if (state.laneNotes.length) return { ok: false, error: "You moved something for them this turn, and its line goes in a text. Reply with sendReply." };
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
        // A move made this turn says so in the reply's words, never a tapback (laneMoves.ts).
        if (state.laneNotes.length) {
          notDone("No tapback: something moved this turn, and its line goes in a text.");
          return { ok: false, error: "You moved something for them this turn, and its line goes in a text. Reply with sendReply." };
        }
        const reaction = parseAck(picked);
        if (!reaction) return { ok: false, error: "A reaction is exactly one emoji, and not a startup-cute one (rocket, raised hands, confetti). Pick one that fits this message, or reply." };
        if (ctx.lastReaction && sameReaction(ctx.lastReaction, reaction)) {
          return { ok: false, error: `Your last reaction to them was ${ctx.lastReaction}. Pick a different one that fits this message, or reply with a short text.` };
        }
        // The safety guard, whatever the decision said: their words this turn, or Co flagged it mid-turn.
        if (ctx.safetyConcern || state.safetyFlagged) {
          notDone("No tapback: they may not be safe, so Cue has to reply.");
          return { ok: false, error: "They may not be safe. Reply to them properly." };
        }
        // An owed answer is a guard too: no decision can lift it. Then what the brain's decision rules out (the list, an ask).
        const due = ctx.replyOwed ? { why: "Cue still owes them an answer from before, so it has to reply", tell: "You still owe them an answer from before. Reply properly instead." } : wordsDue(ctx);
        if (due) {
          notDone(`No tapback: ${due.why}.`);
          return { ok: false, error: due.tell ?? "They need words this time. Reply properly." };
        }
        if (coAskedQuestion(ctx.lastCoMessage)) {
          notDone("No tapback: Cue had just asked them something, so their message is an answer.");
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
        ctx.facts?.add("known", left > 0 ? `They have ${left} invite${left === 1 ? "" : "s"} left. One only counts once someone joins. (Cue told them how many invites they have left; no invite link was sent.)` : "All 5 of their invites are used.");
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
          notDone("No arrival was recorded: there's no Noise event of theirs on right now.");
          return { ok: false, error: "There's no Noise event of theirs on right now, so nothing was recorded. Don't welcome them to an event." };
        }
        if (arrived.isNew) {
          scoreGuestListForEvent(arrived.eventApiId, arrived.eventName).catch((err: any) =>
            console.error("markArrived: arrival re-score failed (non-fatal):", err?.message ?? err),
          );
        }
        ctx.facts?.add("did_this_turn", `They've arrived at "${arrived.eventName}" and Cue recorded it.`);
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
          ctx.facts?.add("did_this_turn", "Cue just texted them an invite link for a friend, as its own message before this reply. They have 4 left; one only counts once someone joins.");
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
        ctx.facts?.add("did_this_turn", `Cue just texted them an invite link for a friend, as its own message before this reply. They have ${invite.left} left; one only counts once someone joins.`);
        return { ok: true, left: invite.left };
      },
    }),

    // Save what they want so the daily search keeps looking. This is what
    // makes "I'll keep looking" true.
    saveAsk: tool({
      description: toolUse("saveAsk"),
      inputSchema: z.object({
        what: z.string().describe("What they're looking for, in one plain sentence, in their words."),
        differentFrom: z.number().optional().describe("Only after this tool said it looks like an open task: that task's number, when this is something different."),
        place: z.string().optional().describe("Only when they said where it's for (\"I'm in Chicago\", \"in SF\"): that place, in their words. Never guessed."),
        until: z.string().optional().describe("Only when they said how long it's for (\"til Friday\", \"through the 17th\"): the last day, YYYY-MM-DD."),
        theirWords: z.string().optional().describe("With place or until: their exact words that say it, copied from what they said."),
      }),
      execute: async ({ what, differentFrom, place, until, theirWords }) => {
        // Something that may be an open task of Co's (services/statusCheck.ts, Royce 2026-10-13): said once, Co decides.
        const c = await statusCandidate(what, differentFrom, "saveAsk");
        if (c) return { ok: false, error: c.hold };
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would save ask for ${ctx.userId}: "${what}"`);
        } else {
          const saved = await captureIntentForTurn(ctx.userId, `user: ${what}`, { timeoutMs: 6000 }).catch(() => null);
          if (!saved?.ask?.text) {
            notDone(`Saving "${what.slice(0, 120)}" for the daily search didn't work, so Cue is NOT looking for it.`);
            return { ok: false, error: "couldn't save that as something to look for" };
          }
          await recordDecision({ layer: 3, decision: "reply.saveAsk", userId: ctx.userId, outcome: "act", action: saved.deduped ? "updated_ask" : "saved_ask", proposal: { what, saved: saved.ask.text } });
          // Where and until when, in the same breath (services/wantWhen.ts, the bounce): kept only when their own words say it.
          const where = await wantWhereFromWords(ctx, saved.ask.text, { place, until, theirWords }).catch(() => null);
          if (where) {
            ctx.facts?.add("ongoing", where.fact);
            return { ok: true, note: `Saved. ${where.note} You can say you'll keep looking and text them if something real fits. Don't promise a time.` };
          }
        }
        ctx.facts?.add("ongoing", `Cue's daily search is now looking for: "${what}". If something real fits, Cue may text them (at most one text a day). Cue can't promise it will find anything, or when.`);
        return { ok: true, note: "Saved. You can say you'll keep looking and text them if something real fits. Don't promise a time." };
      },
    }),

    // Their answer to Cue's one plan (services/bounce.ts, the bounce: "record the yes, execution is the next pass"): yes or no is
    // recorded; nothing is booked, held or sent anywhere.
    answerProposal: tool({
      description: toolUse("answerProposal"),
      inputSchema: z.object({ answer: z.enum(["yes", "no"]), theirWords: z.string().describe("Their exact words answering it.") }),
      execute: async ({ answer, theirWords }) => {
        const quote = theirQuote(ctx.resolvedContent, recentOf(ctx), theirWords);
        if (!quote) return { ok: false, error: "Their answer has to be in their own words this turn. Ask if they want it." };
        if (ctx.dryRun) return { ok: true, note: "(dry run) nothing recorded." };
        const B = await import("../services/bounce.js");
        const r = await B.answerLatest(ctx.userId, answer === "yes", quote);
        if (!r) return { ok: false, error: "There's no plan of yours waiting on an answer." };
        await recordDecision({ layer: 3, decision: "bounce.answer", userId: ctx.userId, outcome: "act", action: answer === "yes" ? "accepted" : "declined", proposal: { id: r.id, find: r.find, day: r.day, quote } });
        const watched = r.gapSource === "calendar" ? "their calendar stays free then" : "the time they told you is still theirs";
        ctx.facts?.add("did_this_turn", answer === "yes" ? (r.watching ? `They said yes to ${r.find} on ${r.day} at ${r.from}. You're keeping an eye on it until it starts: Cue checks it's still on and that ${watched}, and tells them if that changes. Nothing is booked or held; don't say it is.` : `They said yes to ${r.find} on ${r.day} at ${r.from}. It's noted, but it can't be watched; don't say you're keeping an eye on it. Nothing is booked or held.`) : `They passed on ${r.find}. Noted; no apology, no other options now.`);
        return { ok: true, note: answer === "yes" ? (r.watching ? "Say in a few words you'll keep an eye on it and tell them if anything changes; don't claim anything is booked or held." : "Say it's noted in a few words; don't promise to watch it or claim anything is booked.") : "Noted. Acknowledge lightly." };
      },
    }),

    // When they said they're free (services/wantWhen.ts, the bounce, Royce 2026-10-15): a stated gap, in their words. Proposed against,
    // never held (only a calendar gap holds). Nothing inferred: a quiet afternoon is something to ask about, never a gap.
    noteFreeTime: tool({
      description: toolUse("noteFreeTime"),
      inputSchema: z.object({
        weekday: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]).optional().describe("A free time that repeats every week: its day."),
        date: z.string().optional().describe("A one-time free time: its date, YYYY-MM-DD."),
        from: z.string().describe("When it starts, 24h HH:MM (\"16:00\")."),
        to: z.string().describe("When it ends, 24h HH:MM (\"17:30\")."),
        theirWords: z.string().describe("Their exact words that say it, copied from what they said."),
      }),
      execute: async ({ weekday, date, from, to, theirWords }) => {
        const WW = await import("../services/wantWhen.js");
        const { localDay } = await import("../services/memberTime.js");
        const today = localDay(new Date(), await memberZone(ctx.userId).catch(() => null));
        const quote = theirQuote(ctx.resolvedContent, recentOf(ctx), theirWords);
        const f = quote ? WW.freeTimeBacked({ weekday: weekday ?? null, date: date ?? null, from, to }, quote, today) : null;
        if (!f) {
          notDone("No free time was noted: what they said doesn't give a day and both times in their own words.");
          return { ok: false, error: "Not kept: a free time needs its day and both times in their own words. Don't guess one; you can ask." };
        }
        if (!ctx.dryRun) {
          await WW.saveFreeTime(pool, ctx.userId, f, quote!);
          await recordDecision({ layer: 3, decision: "reply.noteFreeTime", userId: ctx.userId, outcome: "act", action: "stated", proposal: { ...f, quote } });
        }
        ctx.facts?.add("ongoing", `They said they're free ${WW.describeFreeTime(f)}. Cue may suggest one thing for then; it never books or holds it.`);
        return { ok: true, note: `Kept: free ${WW.describeFreeTime(f)}. Say it back in a few words.` };
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
        ctx.facts?.add("did_this_turn", "Noted the kind of room they want, so what Cue picks for them leans that way.");
        return { ok: true };
      },
    }),

    noteReaction: tool({
      description: toolUse("noteReaction"),
      inputSchema: z.object({
        item: z.string().describe("The name of the event or opportunity Cue sent them."),
        reaction: z.enum(["interested", "going", "went_liked", "went_disliked", "not_for_me"]),
        note: z.string().optional().describe("Their words, briefly, if they said why."),
        quote: z.string().describe("Their exact words that say it (\"I'm going\", \"signed up\", \"not for me\", or their yes to you offering it), copied from what they said."),
      }),
      execute: async ({ item, reaction, note, quote }) => {
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
        const want = norm(item);
        // The turn's one list of what Co sent (services/turnContext.ts): search results and first offers.
        const sent = ctx.dryRun ? [] : (ctx.turn?.sent ?? (await sentItems(ctx.userId)));
        const match = findSent(sent, item);
        if (!ctx.dryRun && !match) {
          notDone(`No reaction was recorded: "${item.slice(0, 80)}" isn't something Cue sent them recently.`);
          return { ok: false, error: "That isn't something Cue sent them recently (check listSentOffers)." };
        }
        // What they did or will do is theirs to say (services/provenance.ts, 2026-10-12): only their own explicit words record it.
        if (!ctx.dryRun && !quoteIsTheirs(quote, `${ctx.resolvedContent}\n${ctx.isVoice ? String(ctx.turn?.message ?? "") : ""}`)) {
          notDone(`No reaction was recorded for "${item.slice(0, 80)}": they didn't say it in their own words.`);
          return { ok: false, error: "Only their own explicit words record a reaction: the quote must be copied from what they just said. If they didn't say it, ask them (\"Did you end up going?\"); never say they went or are going." };
        }
        const result = REACTION_RESULT[reaction];
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would record ${result} for "${item}" (${ctx.userId})`);
          return { ok: true };
        }
        if (!match) return { ok: false, error: "That isn't something Cue sent them recently." };
        await recordSuggestionOutcome(ctx.userId, match.kind, match.key, match.name, result, note ?? null, { provenance: "stated", quote: quote.trim() });
        // Their answer settles the sent find everywhere it waits: the router's reveal and the offer's loop (2026-10-11, loop 53372).
        await import("../services/offerReactions.js").then((O) => O.settleSentOffer(ctx.userId, match.name, reaction, note ?? null)).catch(() => {});
        ctx.facts?.add("did_this_turn", `Noted how "${match.name}" landed with them (${reaction.replace(/_/g, " ")}), so Cue leans that way next time.`);
        return { ok: true };
      },
    }),

    // Second contact (Royce, 2026-10-11, services/secondContact.ts): they said they saw or talked with someone Co introduced them to
    // again, or haven't. Recorded in their record only; never told to the other person, never a claim about the other side.
    noteMetAgain: tool({
      description: toolUse("noteMetAgain"),
      inputSchema: z.object({
        person: z.string().describe("The first name of someone Cue introduced them to."),
        outcome: z.enum(["met_again", "talked_again", "not_yet", "not_going_to"]).describe("What they said: they met up again, talked again (call, text, email), haven't yet, or don't plan to."),
        note: z.string().optional().describe("Their words, briefly."),
        metOn: z.string().optional().describe("When they met or talked, as YYYY-MM-DD, only if they said (\"last Tuesday\" with today's date). Leave it out otherwise."),
      }),
      execute: async ({ person, outcome, note, metOn }) => {
        const SC = await import("../services/secondContact.js");
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was recorded." };
        const pick = SC.pickIntro(await SC.introducedTo(ctx.userId).catch(() => []), person);
        if (pick === "ambiguous") return { ok: false, error: `More than one person Cue introduced them to is called ${person}. Ask which one, then try again.` };
        if (!pick) {
          notDone(`Nothing recorded: ${person.slice(0, 40)} isn't someone Cue introduced them to.`);
          return { ok: false, error: "That isn't someone Cue introduced them to (only Cue's own introductions count)." };
        }
        await SC.recordSecondContact(ctx.userId, pick, outcome, note ?? null, new Date(), metOn ?? null);
        ctx.facts?.add("did_this_turn", `Noted that they ${outcome === "met_again" ? "saw" : outcome === "talked_again" ? "talked with" : outcome === "not_yet" ? "haven't seen" : "don't plan to see"} ${pick.firstName} again.`);
        return { ok: true };
      },
    }),

    // How meeting someone Co pointed them to at a Co event went (services/roomMatching.ts, 2026-10-12): their side of the
    // pair record, so Co's next value lines learn from it. Only people Co told THEM about can be named; nothing about the
    // other side's answer or outcome comes back.
    noteRoomMeeting: tool({
      description: toolUse("noteRoomMeeting"),
      inputSchema: z.object({
        person: z.string().describe("The first name of someone Cue pointed them to or introduced them to at a Noise event."),
        outcome: z.enum(["met_good", "met_fine", "met_not_a_fit", "did_not_meet"]).describe("They met and it was worth it, met and it was fine, met and it wasn't a fit, or didn't meet."),
        note: z.string().optional().describe("Their words, briefly."),
      }),
      execute: async ({ person, outcome, note }) => {
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was recorded." };
        const RM = await import("../services/roomMatching.js");
        const wanted = person.trim().toLowerCase().split(/\s+/)[0] ?? "";
        const told = (await RM.pairsToldAbout(ctx.userId).catch(() => [])).filter((p) => p.firstName.toLowerCase() === wanted);
        const people = [...new Set(told.map((p) => p.otherId))];
        if (people.length > 1) return { ok: false, error: `More than one person Cue pointed them to is called ${person}. Ask which one, then try again.` };
        if (!told.length) {
          notDone(`Nothing recorded: ${person.slice(0, 40)} isn't someone Cue pointed them to at a Noise event.`);
          return { ok: false, error: "That isn't someone Cue pointed them to at a Noise event (only Cue's own suggestions count)." };
        }
        await RM.notePairMet(ctx.userId, told[0].pairId, outcome, note ?? null);
        ctx.facts?.add("did_this_turn", `Noted how meeting ${told[0].firstName} went for them, so Cue's next introductions learn from it.`);
        return { ok: true };
      },
    }),

    // Living asks (2026-09-26): Co closes an ask when they say it's done,
    // found, no longer wanted, or replaced by a newer one. Closed in both
    // places it lives (services/askKind.ts closeAsk), with a receipt.
    closeAsk: tool({
      description: toolUse("closeAsk"),
      inputSchema: z.object({
        ask: z.string().describe("The ask to close, as it appears in what Cue has on file for them (listOpenAsks)."),
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
        await closeAsk(ctx.userId, hits[0].id as string, `closed by Cue: ${reason}`);
        ctx.facts?.add("did_this_turn", `Closed their ask "${hits[0].text}" (${reason.slice(0, 80)}). Cue stops looking for it.`);
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
          seeking.length ? `Looking out for them: ${seeking.map(line).join("; ")}.` : "Nothing open that Cue is looking out for on their behalf.",
          offering.length ? `What they've offered to others, which Cue matches to people who want it: ${offering.map(line).join("; ")}.` : null,
          avoid.length ? `Kinds of things they asked Cue to stop suggesting: ${avoid.map((a) => `"${a}"`).join(", ")}.` : null,
        ].filter(Boolean);
        ctx.facts?.add("known", `What Cue currently has on file for them, the real complete list. ${parts.join(" ")} Never add, drop, or invent anything beyond this.`);
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
          undo ? `Cue will suggest "${k}" again when something fits.` : `Cue will stop suggesting "${k}" in every search and sweep from now on, until they say otherwise.`,
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
          ctx.facts?.add("known", "Cue hasn't sent them any events or opportunities in the last 30 days.");
          return { ok: true, sent: [] };
        }
        const fmt = await memberDate(ctx.userId);
        const sent = items.map((r) => ({ name: r.name, kind: r.kind, link: r.url, sentOn: fmt(r.sentAt), reaction: r.reaction }));
        ctx.facts?.add(
          "known",
          `What Cue actually sent them in the last 30 days, newest first, the real complete list: ${sent
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
            note: "Tell them that if it's someone you know from that event, you'll check whether they're open to it too. Never confirm or deny that the person is someone you know, is a Noise member, or was on the guest list, and don't say whether you found them.",
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
          `Cue will check with the person they named whether they're open to an intro, only if that's someone Cue knows from that event. Nothing happens unless both say yes. Don't confirm whether Cue knows the person.`,
        );
        return {
          ok: true,
          note: "Tell them that if it's someone you know from that event, you'll check whether they're open to it too. Never confirm or deny that the person is someone you know, is a Noise member, or was on the guest list.",
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
            notDone("No message was passed along: Cue can't reach that person.");
            return { ok: false, error: relay.NOT_REACHABLE };
          }
          ctx.facts?.add("did_this_turn", `(dry run) Would pass their words to ${found.person.firstName}: "${message.slice(0, 160)}".`);
          return { ok: true };
        }
        const r = await relay.relayMessage({ fromUserId: ctx.userId, fromFirstName: ctx.firstName ?? "A member", to: person, message, currentText: ctx.resolvedContent });
        if (!r.ok) {
          notDone(r.reason === "not_reachable" ? "No message was passed along: Cue can't reach that person." : `No message was passed along (${r.reason}).`);
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
  // Tools that can't apply this turn aren't offered (capabilities.ts situations).
  if (ctx.turn) {
    const t = ctx.turn;
    const s = situationFor({ kitFields: Object.keys(t.kit ?? {}).length, message: ctx.resolvedContent, openTasks: t.tasks?.length ?? 0, eventToday: !!t.todayEvent, doorOpen: t.door ? doorOpen(t.door).open : false });
    for (const name of toolsOutOfSituation(s)) delete (tools as Record<string, unknown>)[name];
  }

  // Finding things: Co's own loop (agent/loop.ts), general tools it chains itself.
  turnLoop = newLoopState(ctx.turnStartedAt);
  Object.assign(tools, loopTools(ctx, state, turnLoop, notDone));

  // The calendar and Docs grants, and the Gmail tester flow (services/googleTools.ts). The Gmail one is team only, so team-only tools
  // are taken out again now that these are in (2026-10-15: no member-facing path to the old combined grant).
  Object.assign(tools, googleTools(ctx, notDone));
  if (!ctx.isTeam) for (const name of teamOnlyTools()) delete (tools as Record<string, unknown>)[name];

  // Switches, limits, their yes, receipts and the decision log (toolGuard.ts).
  guardTools(tools, { userId: ctx.userId, resolvedContent: ctx.resolvedContent, dryRun: ctx.dryRun, notDone, recentExchange: recentOf(ctx) });
  return { tools, state, flushLinks, loop: () => turnLoop };
}
