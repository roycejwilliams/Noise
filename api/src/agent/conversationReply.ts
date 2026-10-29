import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { TurnContext } from "../services/turnContext.js";
import { generateText, stepCountIs } from "ai";
import { LOOP_BUDGET } from "./loop.js";
import { createConversationTools, type SendCoReply } from "./conversationTools.js";
import { exchangeFromLog } from "../services/theirYes.js";
import { writeMemory } from "../services/memory.js";
import pool from "../db/db.js";
import { CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { CO_CORE, CO_LISTENING } from "../services/coCore.js";
import { MOVES_GUIDE, moveOf, type Move } from "../services/moves.js";
import { COACHING, MESSAGE_RHYTHM } from "../services/textRhythm.js";
import { groundReply, LAYER3_MODELS, renderReplyFacts, type GroundingResult, type ReplyFacts, addFact, withdrawColdStartSteer, withdrawDoorMoment } from "../harness/replyGrounding.js";
import { capitalizeSentences, dropRepeatedQuestion, looksLikeMetaReply } from "../services/textStyle.js";
import { dropStockSentences } from "../harness/stockLines.js";
import { lastCoLine } from "../services/conversationClose.js";
import { judgeText, ruledOut, type Decision } from "../brain/index.js";
import type { StubEvent } from "./loopTools.js";
import { deliveryFallback, REPLY_DELAYED_NOTE, REPLY_GAVE_UP_NOTE, REPLY_NO_RETRY_NOTE, REPLY_PARTIAL_NOTE } from "../services/turnFailure.js";

// How Co listens, the part of the call guide that carries over to text,
// written the way Co should text (2026-09-24). The full guide is 18,600
// characters of call pacing and reflective lines, and Co copies its style.
// The length a reply should be, said last and specifically (2026-09-24).
const DEPTH_ASK = /\b(plan|detail|details|walk (me )?through|how (do|should|would|can|to)|outline|lead|steps?|explain|why|what should|help me|ideas|options|break (it )?down|elaborate|examples?|compare|draft|feedback|thoughts on)\b/i;
export function replyLengthLine(message: string): string | null {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 15 || DEPTH_ASK.test(message)) return null;
  return `Their message was ${words} ${words === 1 ? "word" : "words"} and doesn't ask for detail. Reply in one or two sentences.`;
}

// How Co listens now lives in Co's shared core (services/coCore.ts), the same
// block a call gets (2026-10-08). The name stays for existing imports.
export const TEXT_LISTENING = CO_LISTENING;

// How a turn uses its tools, said once for both prompts (2026-10-08 review B1, B4, B7). Do the work first, then speak from its
// result; one sendReply; independent tools together; and one rule for a tool that fails or comes back thin.
export const TOOL_FAILURE_RULE = "When a tool fails or comes back thin, lead with what they get now: the content, or the best find you have. Say something is still coming only when a receipt or a task in the facts backs it. Never mention tools, searches, limits, errors or retries, and never ask them to try again: code already retries what can be retried.";
export function TOOL_TURN_RULES(isVoice: boolean): string {
  return [
    "- When this turn starts or delivers work (startTask, researchBrief, writeDocument, emailPlan, draftEmail, followUp, moveLane), call that tool first. Then sendReply says what happened, from its result, as what they get and when, never as what you're doing.",
    "- Call tools that don't depend on each other in the same step.",
    `- One sendReply per turn.${isVoice ? " Your reply goes back as a voice note: call sendReply exactly once, with your full response, answering what they actually said before any secondary gesture." : " The one exception is a separate thought after a tool result, as its own text. Never split one thought into pieces."}`,
    `- ${TOOL_FAILURE_RULE}`,
  ].join("\n");
}

export type ConversationReplyInput = {
  // A confirmed lane move's line the first try at this reply never carried (laneMoves.ts): the retry carries it.
  laneNotesOwed?: string[];
  // When their text arrived. The reply's one deadline runs from here, so the
  // turn's prep counts against it (2026-10-01 code review).
  turnStartedAt?: Date;
  // The reaction already put on their text this turn, if any.
  ackSent?: string | null;
  // Thread the next text under theirs (routes/sendblue.ts threadedSend).
  threadNext?: () => void;
  // The walk-in question due this turn and Cue's receipt that it asked it (agent/conversationTools.ts askedWalkin).
  walkinAsk?: { eventId: string; asked: boolean } | null;
  // For a tapback instead of a reply (conversationTools.ts
  // reactInsteadOfReplying): their message's handle, and whether Co still
  // owes them an answer from before.
  messageHandle?: string | null;
  replyOwed?: boolean;
  // Co's last reaction to them, so a closing tapback never repeats it.
  lastReaction?: string | null;
  // Their message may mean they aren't safe (services/safety.ts).
  safetyConcern?: boolean;
  // The brain's decision for this text (brain/index.ts planTextReply). It binds: a wait holds the send, and what it rules out
  // (dontSay) is enforced here and in the tools. Without one (tests, old callers) it is judged from replyOwed and safetyConcern.
  decision?: Decision | null;
  // The one picture of this turn (services/turnContext.ts).
  turn?: TurnContext | null;
  userId: string;
  phoneNumber: string;
  firstName: string;
  resolvedContent: string;
  isVoice: boolean;
  imageForVision: { data: Buffer; mediaType: string } | null;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  callAction: string;
  isThinProfileFirstMessage: boolean;
  isFirstContact: boolean;
  missingTopic: string | null;
  missingTopicDescription: string | null;
  // Layer 3 harness (harness/replyGrounding.ts): everything that's actually
  // true this turn (what Co did, what's pending, scheduled calls, real event
  // fields and known gaps) plus this turn's instructions (clarify, repeat,
  // call failure, how to answer an outcome, ...). Replaces the ~15 separate
  // context strings this used to take.
  facts: ReplyFacts;
  toneContext: string;
  seekingModeContext: string;
  styleHint: string;
  recentConversation: string;
  recentMemories: string;
  // Same buildContextSummary() output baked into personaPrompt's
  // {{context_summary}} slot (see coPersona.ts) — but that slot only gets
  // read by the model as an instruction for OPENING a call ("Phase 1 —
  // Rapport... open by picking up from something specific"). Over text, the
  // system prompt below tells the model to disregard the call's phase
  // structure, which left this genuinely unclear to be weighted the same
  // way on turn 40 of an ongoing thread. Surfaced again here, explicitly and
  // unconditionally, so what Co already knows about this person carries the
  // same weight as something they just said in this conversation — not
  // background trivia contingent on a call-opening instruction that no
  // longer applies.
  contextSummary: string;
  // No longer used for texts (2026-09-24): texts get TEXT_LISTENING instead
  // of the full call guide. Kept so existing callers and evals compile.
  personaPrompt: string | null;
  sendCoReply: SendCoReply;
  // On the team (users.mo_approver). Looked up when not given.
  isTeam?: boolean;
  // Runs a retry of this same reply later, guarded by the caller (phone lock,
  // nothing newer from them, nothing answered since). When given, an empty
  // reply says "give me a minute" and retries once from their message instead
  // of making them say it again (services/turnFailure.ts).
  resumeLater?: (retry: () => Promise<void>) => void;
};

// How long an unanswered call offer stays "open" before Co treats it as
// abandoned. Referenced by sendblue.ts's pending-offer lookup — same
// reasoning as eventSurfacingSweep.ts's EVENT_OFFER_EXPIRY_DAYS. Gap closed
// 2026-09-04 (Royce): previously there was no expiry at all, so a call offer
// from 2026-08-27 was still "pending" over a week later and got matched
// against an unrelated "For sure" reply on 2026-09-04, triggering an
// unwanted real outbound call.
export const CALL_OFFER_EXPIRY_DAYS = 7;

// Re-checks the actual sent text for whether it's a call offer, rather than
// trusting the model to have self-declared it via a tool call. Restored
// after a real conversation showed the model calling offerCall right after a
// reply that never mentioned a call at all — a false positive that set
// call_offer_pending and, combined with a pre-existing classifier gap, led
// to two unwanted real outbound calls. Same question and gating the deleted
// offerCall tool / original callOfferCheck used.
async function verifyAndRecordCallOffer(
  input: Pick<ConversationReplyInput, "userId" | "resolvedContent" | "hasPendingOffer" | "recentOfferBurstActive" | "callAction">,
  replyText: string,
  dryRun: boolean,
): Promise<boolean> {
  if (input.hasPendingOffer || input.recentOfferBurstActive || !replyText) return false;
  // "asks_about_calling" replies restate Co's own standing number so the
  // USER can call CO — they never mean Co is proposing to call THEM, so this
  // must never register as a pending call offer. Root cause of a real
  // 2026-09-07 incident: this got tagged pending anyway, sat unresolved for
  // 14+ hours, and an unrelated later "sure" (accepting a recommendation)
  // got misread as accepting it, placing a real unwanted outbound call.
  if (input.callAction === "asks_about_calling") return false;
  try {
    const { text: rawCheck } = await generateText({
      model: anthropic(LAYER3_MODELS.narrow),
      experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply.callOfferCheck" },
      prompt: `Does this text message actually offer that CO will call THEM — Cue proposing to place an outbound call to the person, not just telling them how they can call Cue themselves — in any wording, even indirectly (e.g. "I'm here if you want to talk this through")? Not just related to talking or listening in general — specifically Cue offering to call them.

Message: "${replyText}"

Return ONLY "yes" or "no".`,
    });
    const offered = rawCheck.trim().toLowerCase().startsWith("yes");
    if (!offered) return false;
  } catch (err: any) {
    console.error("conversationReply: call-offer verification failed (non-fatal, not recording a pending offer):", err?.message ?? err);
    return false;
  }
  if (dryRun) {
    console.log(`[conversationReply dryRun] would record call_offer_pending for ${input.userId}`);
    return true;
  }
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
      input.userId,
      `User described: ${input.resolvedContent} | Cue offered: ${replyText}`,
    ])
    .catch((err: any) => console.error("conversationReply: call_offer_pending memory write failed (non-fatal):", err?.message ?? err));
  return true;
}

// Resolves whether each topically-retrieved memory actually applies to what
// was just said, before it's handed to the reply agent as foreground
// context — see the Step 5 comment in sendblue.ts for the bug this guards
// against: vector similarity search has no sense of recency or real
// relevance, and unfiltered this produced a reply referencing an unrelated
// "3pm" proposal from a different conversation entirely. Cheap/fast model,
// same tradeoff as verifyAndRecordCallOffer below: a yes/no-shaped
// classification, not a creative task. Fails closed (drops the memories)
// rather than open, since passing through unverified content is exactly
// the failure mode this exists to prevent.
// Per model call, not per reply: a search inside the reply can take up to
// 45s on its own, while a drafting call normally takes under 20s.
// Seconds past the loop's budget for Co to write its answer before the reply stops.
export const TURN_GRACE_S = 30;
export const REPLY_CALL_TIMEOUT_MS = Number(process.env.REPLY_CALL_TIMEOUT_MS ?? 40_000);

// A fresh provider per reply whose fetch gives up on a stalled call.
// REPLY_TEST_STALL_CALL=n[,m] (tests only) makes those calls hang until the cap.
function replyProvider() {
  let calls = 0;
  const stallAt = new Set(String(process.env.REPLY_TEST_STALL_CALL ?? "").split(",").map(Number).filter((n) => n > 0));
  return createAnthropic({
    fetch: async (url: any, init: any = {}) => {
      calls++;
      const cap = AbortSignal.timeout(REPLY_CALL_TIMEOUT_MS);
      const signal = init.signal ? AbortSignal.any([init.signal, cap]) : cap;
      if (stallAt.has(calls)) {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("stalled call timed out"), { name: "TimeoutError" }))));
      }
      return fetch(url, { ...init, signal });
    },
  });
}

export function isTimeout(err: any, depth = 0): boolean {
  if (!err || depth > 5) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError" || /timed? ?out|aborted/i.test(String(err.message ?? ""))) return true;
  return isTimeout(err.cause, depth + 1) || isTimeout(err.lastError, depth + 1) || (Array.isArray(err.errors) && err.errors.some((e: any) => isTimeout(e, depth + 1)));
}

export async function filterRelevantMemories(resolvedContent: string, candidates: string[]): Promise<string> {
  if (!candidates.length) return "";
  try {
    const { text } = await generateText({
      model: anthropic(LAYER3_MODELS.narrow),
      experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply.filterRelevantMemories" },
      prompt: `A user just said: "${resolvedContent}"

Here are memories retrieved by topic similarity — they may or may not actually be about what the user just said (similarity search has no sense of recency or real relevance):
${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Return ONLY the numbers of the memories that are genuinely relevant to what the user just said, comma-separated (e.g. "1,3"). Return "none" if none of them actually apply.`,
    });
    const trimmed = text.trim().toLowerCase();
    if (trimmed.startsWith("none")) return "";
    const indices = trimmed
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length);
    return indices.map((i) => candidates[i]).join("\n");
  } catch (err: any) {
    console.error(
      "conversationReply: filterRelevantMemories failed (non-fatal, dropping retrieved memories this turn):",
      err?.message ?? err,
    );
    return "";
  }
}

// The brain said wait (brain/index.ts): hold the send, logged, and retried once as an answer on the turn's resume path. The retry
// is the next attempt, so an empty one gets the honest give-up line instead of a second "give me a minute" nothing would follow.
// Only called when the turn has a resume path (a replayed turn has none, and runs as act rather than holding with no retry).
async function holdReply(
  input: ConversationReplyInput & { resumeLater: NonNullable<ConversationReplyInput["resumeLater"]> },
  decision: Decision,
  opts: { dryRun?: boolean; record?: boolean; stubSearch?: boolean; attempt?: number; stubEvents?: StubEvent[]; cutFirstReply?: boolean },
): Promise<{ sent: boolean; offered: boolean; replyText: string; grounding: GroundingResult[]; toolsCalled: string[]; move: Move }> {
  if (!opts.dryRun) {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 3, decision: "brain.hold", userId: input.userId, outcome: "skip", action: "requeued", proposal: { why: decision.why, message: input.resolvedContent.slice(0, 200) } }).catch(() => {});
  }
  input.resumeLater(async () => {
    await runConversationReplyAgent({ ...input, decision: { ...decision, kind: "act", why: `held earlier (${decision.why}); answered now` } }, { ...opts, attempt: (opts.attempt ?? 1) + 1 });
  });
  return { sent: false, offered: false, replyText: "", grounding: [], toolsCalled: [], move: "quiet" };
}

// Co Loop Stage 1, agentized: replaces the hardcoded shouldOfferCall/
// usingTopicNudge branching with a tool-calling loop that decides the reply
// and topic-nudge gesture. Whether a call offer went out is NOT
// self-declared by the model (see verifyAndRecordCallOffer above) — it's
// verified against the actual sent text afterward. Does NOT own whether to
// place a real call (that stays deterministic in sendblue.ts, gated purely
// on explicit classifier output) — only the secondary gesture + reply.
export async function runConversationReplyAgent(
  input: ConversationReplyInput,
  opts: { dryRun?: boolean; record?: boolean; stubSearch?: boolean; attempt?: number; stubEvents?: StubEvent[]; cutFirstReply?: boolean } = {},
): Promise<{ sent: boolean; offered: boolean; replyText: string; grounding: GroundingResult[]; toolsCalled: string[]; move: Move }> {
  const grounding: GroundingResult[] = [];
  let decision: Decision = input.decision ?? judgeText({ userId: input.userId, read: null, owed: !!input.replyOwed, safetyConcern: !!input.safetyConcern, clarify: null, turn: null });
  // A wait holds the send: nothing goes out now and no model runs. Never dropped: the reply is retried once through the turn's
  // resume path (the caller's guards: phone lock, nothing newer from them, nothing answered since), answered then, and their
  // message stays owed meanwhile. A turn with no resume path (a replayed turn) can't be held without being stranded, so it runs
  // as act now.
  if (decision.kind === "wait") {
    if (input.resumeLater) return holdReply({ ...input, resumeLater: input.resumeLater }, decision, opts);
    decision = { ...decision, kind: "act", why: `${decision.why}; no way to retry this turn, so answered now` };
  }
  // The team gets the team-only tools; nobody else ever sees them.
  const isTeam = input.isTeam ?? (opts.dryRun ? false : await import("../services/extensions.js").then((m) => m.isTeamMember(input.userId)).catch(() => false));
  // A retry is its own attempt, with its own clock.
  const turnStart = (opts.attempt ?? 1) === 1 && input.turnStartedAt ? input.turnStartedAt.getTime() : Date.now();
  const replyDeadlineAt = () => turnStart + (LOOP_BUDGET.seconds + TURN_GRACE_S) * 1000;
  // A first read this turn (services/theDoor.ts), settled once the reply has gone out.
  let firstRead: import("../services/theDoor.js").FirstReadPending | null = null;
  let cutFirstDone = false;
  // Steps finished, so a guard knows whether a redraft can still follow (conversationTools.ts sendReply redraftLeft).
  let stepsDone = 0;
  const { tools, state, flushLinks } = createConversationTools({
    redraftLeft: () => stepsDone < LOOP_BUDGET.steps - 1 && Date.now() < replyDeadlineAt() - 15_000,
    onFirstRead: (p) => {
      firstRead = p;
    },
    turnStartedAt: turnStart,
    laneNotesOwed: input.laneNotesOwed ?? [],
    stopNotesOwed: input.facts.stopNote ? [input.facts.stopNote.line] : [],
    isTeam,
    userId: input.userId,
    phoneNumber: input.phoneNumber,
    resolvedContent: input.resolvedContent,
    isVoice: input.isVoice,
    hasPendingOffer: input.hasPendingOffer,
    recentOfferBurstActive: input.recentOfferBurstActive,
    dryRun: opts.dryRun ?? false,
    stubSearch: opts.stubSearch ?? false,
    // Tests only (golden cases): a stubbed search returns these instead of nothing (agent/loopTools.ts searchEvents).
    stubEvents: opts.stubSearch ? opts.stubEvents : undefined,
    messageHandle: input.messageHandle ?? null,
    lastReaction: input.lastReaction ?? null,
    replyOwed: input.replyOwed ?? false,
    safetyConcern: input.safetyConcern ?? false,
    decision,
    turn: input.turn ?? null,
    firstName: input.firstName ?? null,
    lastCoMessage: lastCoLine(input.recentConversation),
    // What a yes answers is in the exchange, not only Co's last line (services/theirYes.ts, 2026-10-13).
    recentExchange: exchangeFromLog(input.recentConversation),
    sendCoReply: input.sendCoReply,
    threadNext: input.threadNext,
    walkinAsk: input.walkinAsk ?? null,
    ackSent: input.ackSent ?? null,
    facts: {
      add: (kind, text) => addFact(input.facts, kind, text),
      text: () => renderReplyFacts(input.facts),
    },
    gate: async (draft, sentThisTurn, answeredThisTurn, findsWaiting) => {
      // Tests only, in a dry run: the first reply is cut to nothing, the way a fact check that strips every claim leaves it, so a
      // golden case can show what the agent does next (Royce, 2026-10-17: a redraft, never the fallback line).
      if (opts.dryRun && opts.cutFirstReply && !cutFirstDone) {
        cutFirstDone = true;
        grounding.push({ final: "", outcome: "stripped", checks: [{ name: "test_cut_everything", pass: false, reason: "test: every claim cut" }], latencyMs: 0, firstCheckMs: 0, stages: {} } as GroundingResult);
        return "";
      }
      const result = await groundReply(
        draft,
        input.facts,
        {
          message: input.resolvedContent,
          recentConversation: input.recentConversation,
          contextSummary: input.contextSummary,
          recentMemories: input.recentMemories,
          sentThisTurn,
          answeredThisTurn,
          findsWaiting,
        },
        { userId: input.userId, record: opts.record !== false && !opts.dryRun },
      );
      grounding.push(result);
      // Always sentence case, however they text (2026-09-16). Never the
      // same question as one of Co's last two texts (2026-09-23).
      // Never a sentence that is only a stock phrase ("I hear you.", "Makes sense."), the same rule a call has (harness/stockLines.ts).
      return capitalizeSentences(dropStockSentences(dropRepeatedQuestion(result.final, input.recentConversation)));
    },
  });

  // What Co tried and what worked, recorded as each tool runs, so they're
  // known even when a model call times out mid-turn and the move counts only
  // what really happened (services/moves.ts).
  const tried: string[] = [];
  const worked: string[] = [];
  for (const [name, t] of Object.entries(tools as Record<string, any>)) {
    if (typeof t?.execute !== "function") continue;
    const run = t.execute.bind(t);
    t.execute = async (...args: any[]) => {
      tried.push(name);
      const out = await run(...args);
      if (out?.ok !== false) worked.push(name);
      return out;
    };
  }

  const callOfferEligible =
    !input.hasPendingOffer &&
    !input.recentOfferBurstActive &&
    // The brain's ask is this reply's one question: no call offer beside it.
    !ruledOut(decision, "call_offer") &&
    (input.callAction === "would_benefit" || input.isThinProfileFirstMessage);

  // One question a reply (services/coldStart.ts): a reply that offers a call, or answers a safety concern, never also steers.
  if (input.safetyConcern) withdrawColdStartSteer(input.facts, "a safety concern this turn");
  else if (callOfferEligible) withdrawColdStartSteer(input.facts, "this reply offers a call");
  // The same for a new member's first read (services/theDoor.ts): never beside a call offer or a safety concern.
  if (input.safetyConcern) withdrawDoorMoment(input.facts, "a safety concern this turn");
  else if (callOfferEligible) withdrawDoorMoment(input.facts, "this reply offers a call");
  // What the brain's decision rules out (brain/index.ts dontSay): the steer and the first read beside its ask or a safety turn.
  const noSteer = ruledOut(decision, "steer");
  if (noSteer) withdrawColdStartSteer(input.facts, noSteer.why);
  const noFirstRead = ruledOut(decision, "first_read");
  if (noFirstRead) withdrawDoorMoment(input.facts, noFirstRead.why);

  const lastCoMessage = lastCoLine(input.recentConversation);

  // Split so the part that never changes (Co's voice and how it listens) is
  // cached on its own; the rest is this member and this moment (2026-09-23,
  // prompt caching).
  // Texts get how Co listens, not the whole call guide (2026-09-24,
  // evals/texting: on 40 real co-test texts, blind Opus preferred this over
  // the old prompt 29 to 10; the guide's 18,600 characters of call pacing
  // and reflective lines were being copied into texts). Calls keep the full
  // guide on Hume. Same for every member, so it caches across them.
  // Co's core (who Co is, how it listens, what's true, other members, safety)
  // is the same block a call's prompt is built from (services/coCore.ts,
  // 2026-10-08), so texts and calls can't drift apart.
  const sharedSystem = `${CO_CORE}

${MOVES_GUIDE}

${MESSAGE_RHYTHM}

${COACHING}`;
  // Written the way Co should text (2026-09-24): short sentences, no dashes,
  // one idea per paragraph. Co copies the style of its own instructions (on
  // calls, removing the prompt's dashes took spoken dashes from 8 to 0), so
  // every rule here is kept but said plainly. Measured by evals/texting.
  // A freer-flowing version (Royce, 2026-09-28: "How can we let Co & Mo
  // language be free flowing like other personal agents?"). Same context,
  // same truth rules and tools, but principles instead of sample dialogues
  // and quoted phrasings (the model copies examples; evals/texting found
  // example replies lost 14-26), plus varying its own phrasing. Off unless
  // REPLY_PROMPT=flow until it wins the blind texting eval.
  const systemFlow = `You are replying by iMessage to ${input.firstName}, picking up wherever this conversation actually is. ${CO_TEXT_CHANNEL}

${input.firstName} is texting you. You already have their number, so never ask for it.

What you already know about ${input.firstName}. Use it to understand them and get details right. Bring something up from it only when it's directly relevant to what they just said. Don't repeat a detail you've already mentioned in this conversation.
${input.contextSummary || "(nothing on file yet; this is effectively a first real conversation with them)"}

How ${input.firstName} has been feeling, from a read of what they texted and said on recent calls (their words, plus a frustration score from calls):
${input.toneContext || "(nothing notable)"}

Start from this. Decide what they most need right now: to feel heard, real help with something, or to share in something good. That decides your length, your pace, whether you ask a question, and whether anything else belongs in this reply.
- When they're struggling, stay with them. No pivoting to plans, events or opportunities in the same message.
- When something good happened, meet their energy.
- If a feeling keeps coming up about the same thing, you can gently pick it back up when it fits.
- Don't assume a feeling or circumstance they haven't told you. Don't say they're doing it alone when they have a team.
- When you don't have something they asked for, say so the first time, plainly and once, and name what you don't have.
- Show you get how they feel by how you respond, without naming or diagnosing the feeling.
- If nothing notable is listed, just read the conversation.

${renderReplyFacts(input.facts)}

${input.seekingModeContext}
${input.styleHint}
${input.isFirstContact ? `\nThis is the start of your first real conversation with ${input.firstName}. They just finished the intro: greeting, what Cue is, saving your contact, verification. What they just said may only be a greeting.${input.contextSummary ? ` You already have real context on them (see "What you already know" above). Lead with it: your first line picks up from something specific in it, the way you'd open a call, not a generic greeting.` : ""} If it IS something real, pick up from it. If it's just a greeting or blank, don't treat it as substance. Open the real conversation yourself${input.contextSummary ? ", grounded in what you already know" : ""}: warm, unhurried, inviting the real version of their life, not a status update.\n` : ""}
Recent conversation, in order. This is the actual thread, so follow it. Don't jump to older topics below unless they bring them up again.
${input.recentConversation || "(this is the start of the conversation)"}

What Cue knows from past conversations that's relevant to what they just said. It was already checked for relevance, so give it the same weight as this thread. It's theirs: when they ask about their own people, plans or history, answer from it.
${input.recentMemories || "(nothing from past conversations applies to what they just said)"}

${lastCoMessage ? `Your last message to them was: "${lastCoMessage}"\n` : ""}${input.lastReaction ? `Your last reaction to them was ${input.lastReaction}; if you react this time, use a different one.\n` : ""}${input.imageForVision ? "They just sent the attached photo." : `They just said: "${input.resolvedContent}"`}${lastCoMessage ? `\nIf what they just said is a short answer, read it as an answer to your last message first. If they moved on from a question you asked, go where they went; don't ask it again.` : ""}

What's true:
Everything you say about them, other people, events, places, or what you've done comes from what's above or this thread. If it isn't there and a search tool can find it, search first, then answer from what you found; ask them only for what no search can give you. If no search can find it either, you don't know it: say so plainly, once, and say what you can do now. Your own past actions come from what you actually sent. Only promise something later when the context says it will happen. If you can't tell what they mean, ask.

How you talk:
You're a person texting someone you know, not a service. Answer or react first, in your own words, the way you would in the moment. Let the conversation decide the shape: a quick line back to a quick text, real room for something that matters, a full walkthrough when they want help doing something (every step, in order, committing even where it depends, then one question about where they are with it). When it's a feeling, meet it before any plan, and ask what would help before you advise.
Keep it alive the way people do: an observation, a thought, a question when you're actually curious. When they say what they want, sharpen it with one specific follow-up.
Be specific to them. Advice that could fit anyone isn't worth sending; make it about their event, their date, their people, and name the tradeoff instead of hiding it.
Vary how you say things. Read your recent messages in the thread and don't reuse their openings, phrasings or sign-offs; say it fresh each time, the way a person naturally does.
Say each thing once. Only suggest what's still ahead, and only ask how something went once it's over.

On a phone:
Short sentences, a short paragraph per idea with a blank line between, no headings or labels, no dashes. Normal capitalized sentences, however they text.${input.imageForVision ? " React to what's actually in the photo." : ""}

At most one extra gesture, and only after you've responded; never let a gesture replace actually responding.
${callOfferEligible ? (input.isThinProfileFirstMessage ? `- This is the first real thing they've shared and nothing is known about them yet. A quick, low-pressure call would get further than texting. After responding, offer one, briefly. Don't place a call, just make the offer. Skip it only if it would feel forced right after this reply; being eligible means offering by default.` : `- What they shared could benefit from talking it through by voice. Respond briefly first, even if it was heavy. Then offer a call as a warm gesture, not a logistics question. Make it a warm, open invitation rather than a scheduling question, and name a call or the phone plainly so it's clear what you mean. Don't place a call, just make the offer. Skip it only if it would feel forced right after this reply; being eligible means offering by default.`) : `- A call offer is NOT available this turn (one is already pending or was offered too recently). Don't mention, suggest or ask about a phone call at all, in any wording. Just respond to what they said.`}
${input.missingTopic ? `- Something Cue is still figuring out about them: ${input.missingTopicDescription}. Only if what they just said actually leads there, work in one brief, natural question toward it after responding. If the conversation doesn't lead there, leave it for another time; never steer to it. If you use it, call markTopicAsked with topic "${input.missingTopic}" after sendReply.` : ""}

Then act with your tools:
${TOOL_TURN_RULES(input.isVoice)}
- Call markTopicAsked only if you actually used that question in what you sent.`;
  const system = `You are replying by iMessage to ${input.firstName}, picking up wherever this conversation actually is. ${CO_TEXT_CHANNEL}

${input.firstName} is texting you. You already have their number, so never ask for it.

What you already know about ${input.firstName}. Use it to understand them and get details right. Bring something up from it only when it's directly relevant to what they just said. Don't repeat a detail you've already mentioned in this conversation.
${input.contextSummary || "(nothing on file yet; this is effectively a first real conversation with them)"}

How ${input.firstName} has been feeling, from a read of what they texted and said on recent calls (their words, plus a frustration score from calls):
${input.toneContext || "(nothing notable)"}

Start from this. Decide what they most need right now: to feel heard, real help with something, or to share in something good. That decides your length, your pace, whether you ask a question, and whether anything else belongs in this reply.
- When they're struggling, stay with them. No pivoting to plans, events or opportunities in the same message.
- When something good happened, meet their energy.
- If a feeling keeps coming up about the same thing, you can gently pick it back up when it fits.
- Don't assume a feeling or circumstance they haven't told you. Don't say they're doing it alone when they have a team.
- When you don't have something they asked for, say so the first time, plainly and once, and name what you don't have.
- Never name or diagnose the feeling ("you sound stressed"). Show you get it by how you respond.
- If nothing notable is listed, just read the conversation.

${renderReplyFacts(input.facts)}

${input.seekingModeContext}
${input.styleHint}
${input.isFirstContact ? `\nThis is the start of your first real conversation with ${input.firstName}. They just finished the intro: greeting, what Cue is, saving your contact, verification. What they just said may only be a greeting.${input.contextSummary ? ` You already have real context on them (see "What you already know" above). Lead with it: your first line picks up from something specific in it, the way you'd open a call, not a generic greeting.` : ""} If it IS something real, pick up from it. If it's just a greeting or blank, don't treat it as substance. Open the real conversation yourself${input.contextSummary ? ", grounded in what you already know" : ""}: warm, unhurried, inviting the real version of their life, not a status update.\n` : ""}
Recent conversation, in order. This is the actual thread, so follow it. Don't jump to older topics below unless they bring them up again.
${input.recentConversation || "(this is the start of the conversation)"}

What Cue knows from past conversations that's relevant to what they just said. It was already checked for relevance, so give it the same weight as this thread. It's theirs: when they ask about their own people, plans or history, answer from it.
${input.recentMemories || "(nothing from past conversations applies to what they just said)"}

${lastCoMessage ? `Your last message to them was: "${lastCoMessage}"\n` : ""}${input.lastReaction ? `Your last reaction to them was ${input.lastReaction}; if you react this time, use a different one.\n` : ""}${input.imageForVision ? "They just sent the attached photo." : `They just said: "${input.resolvedContent}"`}${lastCoMessage ? `\nIf what they just said is a short answer, read it as an answer to your last message first. If they moved on from a question you asked, go where they went; don't ask it again.` : ""}

Only what's real:
- Ground everything in "What's true right now", the rest of what's above, and what was said in this thread. Never state or imply a personal detail, preference or fact about them that isn't there.
- Never name a specific venue or business unless it's given above as something you actually found. If you don't have a real one, describe what you'd look for.
- The same goes for your own past actions. If they ask what you sent or meant, check what you actually sent in the thread and answer from that.
- Never invent an excuse for something you supposedly did wrong (a "broken link", an "accidental" send) unless the thread shows it. A real link you can see there was real and intentional.
- If you can't tell what they're referring to, say so and ask. Don't make up an explanation.
- Never promise to do something later ("I'll send the link once I have it", "I'll track that down") unless the context above says it will happen. Only promise what a tool you called this turn, or a task in the facts, will do. If you don't have it, say so and say what you can do now.
- Don't bring back an old promise or missing item unless they ask about it.

How to reply:
- Always respond genuinely to what they said first: start with your answer or your own reaction, in your own words.
- Match the weight of your reply to theirs. If their message is under about 15 words and doesn't ask for a plan or detail, reply in one or two sentences. They: "just landed". You: "Welcome back. How was Austin?" Something long, layered or emotional gets real room, but that still means about two short paragraphs. This is a text, not an essay.
- Say each thing once. Don't repeat a point, an offer or a question from your last message.
- The exception is a request for help doing something. They ask how to do it, ask you to walk them through it or lead, or want a plan or more detail on one. Or they're stuck on a real problem and want help. Then give the whole walkthrough in this one reply (Royce, 2026-09-22: it took four asks before Cue committed to a plan). Open straight on the first step, with no line announcing the plan. Every step in order, each its own short paragraph of one to three sentences, up to 6 steps. Advice isn't a fact claim, so don't hold it back or ask them to pick a piece first. If a detail would change a step, say so in a few words and still commit. End with one question that gauges where they are with it: which step to go deeper on, or what doesn't fit.
- When it's a feeling rather than a task (nervous about the night, discouraged, stuck), meet the feeling first, then gauge before you plan: one question about what would help right now, talking it through or a way forward. When they want the way forward, walk them through it fully. Shape it around what they're feeling. Never leave them with a one-liner, and never make them ask twice.
- Whenever you give advice or an opinion, challenge your own answer before you send it. (Jacqueline, 2026-09-22: "she sometimes gives generic or not fully thought out answers".) Would this line fit anyone, or only them? Swap anything generic for their specifics: their event, their date, their people, and what's happened for them since you first talked (their story, if it's in what you know) or what you advised before. If you advised something earlier and they're back on the same thing, build on it or say what changed; don't start over. Did you skip the hard part or hide a tradeoff? Name it. Would someone who's done this nod or wince? If it depends, say on what, and still pick one.
- When you draft something for them to send, use only the names, titles, events and details they gave you, in their own wording. If you'd expand an abbreviation or fill a gap with a guess ("WW26" into "WWDC"), use what they wrote or check with them first.
- The length limit covers the whole reply, however many things are listed under "For this reply". Develop the single most important one. Keep the rest to a fragment or save them for later.
- If you're also making the one extra gesture below, keep the response to what they shared to one or two sentences, then the gesture.
- Keep a stalling conversation going with a question, an observation or a related thought. Don't lean only on questions, and don't force it when things are winding down or already moving.
- When they say something concrete about what they want or who they're looking for, ask one specific follow-up that sharpens it.
- Check what you mention against today. The facts mark each event as already over, happening today, or coming up. Only suggest what's still ahead, and only ask how something went once it's over.

How it looks on a phone:
- When a reply has more than one idea, give each idea its own short paragraph with a blank line between them, never one long block. Each step starts its own paragraph and reads the way you'd say it to them across a table. Write plain sentences that open with the thing itself ("Start with two tiers." "Then give each sponsor a table in the room."). Never a heading or a label with a colon.
- Your first words are your answer or your own reaction, never their words handed back. They: "should I raise now or wait?" You: "I'd wait until Monday. You'll have the numbers."
- Short sentences. No dashes of any kind.
- Normal capitalized sentences, however they text.${input.imageForVision ? "\n- React to what's actually in the photo." : ""}

At most one extra gesture, and only after you've responded; never let a gesture replace actually responding.
${callOfferEligible ? (input.isThinProfileFirstMessage ? `- This is the first real thing they've shared and nothing is known about them yet. A quick, low-pressure call would get further than texting. After responding, offer one, briefly. Don't place a call, just make the offer. Skip it only if it would feel forced right after this reply; being eligible means offering by default.` : `- What they shared could benefit from talking it through by voice. Respond briefly first, even if it was heavy. Then offer a call as a warm gesture, not a logistics question. Say "I'm here if you'd ever want to hop on a call and actually talk it through," not "are you free today or tomorrow." The offer has to name a call or the phone; "I'm here if you want to talk" isn't clear enough. Don't place a call, just make the offer. Skip it only if it would feel forced right after this reply; being eligible means offering by default.`) : `- A call offer is NOT available this turn (one is already pending or was offered too recently). Don't mention, suggest or ask about a phone call at all, in any wording. Just respond to what they said.`}
${input.missingTopic ? `- Something Cue is still figuring out about them: ${input.missingTopicDescription}. Only if what they just said actually leads there, work in one brief, natural question toward it after responding. If the conversation doesn't lead there, leave it for another time; never steer to it. If you use it, call markTopicAsked with topic "${input.missingTopic}" after sendReply.` : ""}

Then act with your tools:
${TOOL_TURN_RULES(input.isVoice)}
- Call markTopicAsked only if you actually used that question in what you sent.`;

  const baseUserText = input.imageForVision ? "Respond to what they just sent." : "Respond to what they just said.";
  // The length rule, computed for this message and said last, right before
  // Co writes (2026-09-24, evals/texting: on the 24 real messages that call
  // for a short reply, the median reply went from 39 to 21 words and one or
  // two sentences from 13 to 20 of 24, with no loss in blind comparison).
  const lengthLine = input.imageForVision ? null : replyLengthLine(input.resolvedContent);
  const userText = lengthLine ? `${baseUserText} ${lengthLine}` : baseUserText;

  // Medium effort (2026-09-26): on 40 real texting cases, blind, medium beat
  // the default 22-16 and drafted faster (median 8.0s vs 9.3s, slowest tenth
  // 16.8s vs 30.9s); low lost 17-21. REPLY_EVAL_EFFORT only exists so
  // evals/texting can compare levels.
  const replyDeadline = replyDeadlineAt();
  const REPLY_EFFORT = (["low", "medium", "high"] as const).find((e) => e === process.env.REPLY_EVAL_EFFORT) ?? "medium";
  // Each model call is capped (2026-09-26: a call stalled for 318s in a
  // test). A timeout after a text already went out ends the turn with what
  // was sent; with nothing sent, the fallback line below goes out.
  let agentRun: { steps: any[]; text: string; finishReason: string } | null = null;
  // A photo the model can't open (2026-10-01: two screenshots in a row failed
  // the whole turn, and Co asked them to send it again) retries once without
  // it, from their words and what's known about the photo.
  const runAgent = (withImage: boolean) =>
    generateText({
    // Sonnet, not Haiku — dry-run testing showed Haiku missing the
    // offerCall follow-up call ~2/5 times even when the reply text clearly
    // gestured toward a call, which breaks call_offer_pending tracking (a
    // later "yes" gets misread as unrelated). This is a correctness/
    // state-consistency issue, not just phrasing quality, so it justifies
    // the latency/cost tradeoff.
    model: replyProvider()(LAYER3_MODELS.reply),
    maxRetries: 1,
    // Caching: the unchanging part gets its own breakpoint (reused by any
    // member's text within 5 minutes), and the request-level cacheControl caches
    // everything up to the latest message, so each step of this tool loop
    // reads the prompt the step before it wrote instead of paying full
    // price for it again.
    providerOptions: {
      anthropic: {
        cacheControl: { type: "ephemeral" },
        effort: REPLY_EFFORT,
      },
    },
    system: [
      { role: "system" as const, content: sharedSystem, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "system" as const, content: process.env.REPLY_PROMPT === "flow" ? systemFlow : system },
    ],
    tools,
    // 6, not 5 — a genuine second sendReply call now needs an extra
    // call/result round trip the single-reply design didn't. (Briefly
    // raised to 12 for a multi-message recommendation sequence the agent
    // used to own — that sending is now deterministic in sendblue.ts
    // instead, so this reverted back to 6.)
    // Also stops the moment a send is held (conversationTools.ts sendReply):
    // retrying can't get through and each step is a paid call.
    // One deadline for the whole reply (2026-10-01 code review: 14 steps of
    // up to 40s each could run far past the loop's 75s). Past LOOP_BUDGET the
    // tools answer "out of time" so Co writes what it has; this stops the
    // loop between steps, never mid-tool, TURN_GRACE_S after that.
    stopWhen: [stepCountIs(LOOP_BUDGET.steps), () => state.sendStopped, () => state.reacted, () => Date.now() > replyDeadline],
    onStepFinish: () => {
      stepsDone += 1;
    },
    experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply" },
    ...(withImage && input.imageForVision
      ? {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "image" as const, image: input.imageForVision.data, mediaType: input.imageForVision.mediaType },
                { type: "text" as const, text: userText },
              ],
            },
          ],
        }
      : { prompt: withImage || !input.imageForVision ? userText : `${userText}\n\nTheir photo couldn't be opened on your side. Work from what they said and anything already known about it; don't ask them to send it again. If you need one detail from it, ask for just that.` }),
  });
  try {
    try {
      agentRun = await runAgent(true);
    } catch (err: any) {
      if (!input.imageForVision || isTimeout(err) || state.sent) throw err;
      console.error(`conversationReply: the reply with their photo failed for ${input.userId} (${err?.constructor?.name ?? "error"}), retrying without it`);
      agentRun = await runAgent(false);
    }
  } catch (err: any) {
    if (!isTimeout(err)) throw err;
    console.error(`conversationReply: a model call timed out for ${input.userId} (${state.sent ? "after a text went out; ending with what was sent" : "before anything went out; sending the fallback"})`);
    if (!opts.dryRun) {
      const { recordDecision } = await import("../harness/core.js");
      await recordDecision({ layer: 3, decision: "reply.timeout", userId: input.userId, outcome: "skip", action: state.sent ? "after_send" : "before_send", proposal: { message: input.resolvedContent.slice(0, 200), capMs: REPLY_CALL_TIMEOUT_MS } }).catch(() => {});
    }
  }

  // Unlike a plain generateText completion (which always returns text), a
  // tool-calling loop can finish without ever invoking sendReply — the
  // model runs out of its step budget mid-reasoning, or just answers in
  // plain text instead of using the tool. Silently sending nothing back is
  // a real regression versus the old code, which always produced something
  // to send, so this guarantees a reply goes out either way.
  // Held by the send breaker: nothing can go out, so no plain-text retry and
  // no fallback line. The member is told what happened once texts resume
  // (replyGrounding.ts send_held).
  // Stopped after two refused sends that weren't the breaker (the outbound filter, a failed send): not held, so the member still
  // gets the plain-text reply or the fallback line, never silence for a reply Co wrote (2026-10-12 audit).
  if (state.sendStopped && !state.sendsHeld) state.sendStopped = false;
  if (!state.sent && state.sendStopped) {
    console.error(`conversationReply: sends to ${input.userId} are held; stopped without retrying`);
  }
  if (!state.sent && !state.sendStopped) {
    // What the agent did instead, so a fallback can be traced (2026-09-22).
    const toolsCalled = (agentRun?.steps ?? []).flatMap((st: any) => st.toolCalls.map((t: any) => t.toolName));
    console.error(
      `conversationReply: agent completed without calling sendReply for user ${input.userId} — sending its plain text, or the fallback if there is none (finish: ${agentRun?.finishReason ?? "timeout"}, steps: ${agentRun?.steps.length ?? 0}, tools: ${toolsCalled.join(",") || "none"}, text: ${JSON.stringify((agentRun?.text ?? "").slice(0, 300))})`,
    );
    // The model often writes a good reply as plain text instead of calling
    // sendReply (2026-09-22: 2 of 4 runs on "I'm nervous nobody will show",
    // and the member got the generic line below). That text goes out through
    // sendReply itself, so it's grounded and logged like any reply; the
    // generic line is only for when there's nothing usable.
    const plain = (agentRun?.text ?? "").trim();
    if (!input.isVoice && plain.split(/\s+/).length >= 4 && !looksLikeMetaReply(plain)) {
      await (tools.sendReply as any).execute({ message: plain }, { toolCallId: "plain-text-reply", messages: [] }).catch((err: any) =>
        console.error("conversationReply: sending the plain-text reply failed:", err?.message ?? err),
      );
    }
  }
  if (!state.sent && !state.sendStopped) {
    // Nothing usable came out. Never ask them to say it again (2026-10-01 code
    // review): Co still has their message, so the first time it says it needs
    // a minute and retries once from it; a retry that also comes out empty
    // says so. Their message stays owed either way (OWED_AFTER), so their
    // next text gets it answered too. A retry only runs when this run sent
    // nothing at all, so nothing goes out twice.
    const attempt = opts.attempt ?? 1;
    // Two failed sends mean texts aren't getting through: a retry would be a second paid run into the same outage.
    const retrying = attempt === 1 && !!input.resumeLater && !opts.dryRun && state.sentMessages.length === 0 && state.failedSends < 2;
    const fallback = retrying ? REPLY_DELAYED_NOTE : attempt > 1 ? REPLY_GAVE_UP_NOTE : REPLY_NO_RETRY_NOTE;
    if (opts.dryRun) {
      console.log(`[conversationReply dryRun] fallback would send to ${input.userId}: "${fallback}"`);
      state.sent = true;
      state.lastReplyText = fallback;
    } else {
      // Only counted when it really went out (2026-09-17 code review: a
      // refused send used to be marked sent, so nobody noticed the silence).
      const sent = await input.sendCoReply({ phone: input.phoneNumber, message: fallback, asVoice: input.isVoice });
      if (sent !== false) {
        state.sent = true;
        state.lastReplyText = fallback;
        await writeMemory(input.userId, "text_exchange", `Co replied: ${fallback}`).catch((err: any) => console.error("conversationReply: logging the fallback failed (it did send):", err?.message ?? err));
      } else {
        console.error(`conversationReply: fallback reply also failed to send for user ${input.userId}`);
      }
    }
    if (retrying) {
      const toldThem = state.sent;
      // A lane move made on the first try already happened: its line rides in the retry's reply (laneMoves.ts).
      const laneNotesOwed = [...state.laneNotes];
      state.laneNotes = [];
      input.resumeLater!(async () => {
        if (toldThem) addFact(input.facts, "did_this_turn", `A minute ago you told them "${REPLY_DELAYED_NOTE}" because your first try at this reply came out empty. This is that answer: answer what they said, and don't apologize again.`);
        const again = await runConversationReplyAgent({ ...input, laneNotesOwed }, { ...opts, attempt: attempt + 1 });
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 3, decision: "reply.resume", userId: input.userId, outcome: again.sent && again.replyText !== REPLY_GAVE_UP_NOTE ? "act" : "skip", action: again.replyText === REPLY_GAVE_UP_NOTE ? "empty_again" : again.sent ? "answered" : "not_sent", proposal: { message: input.resolvedContent.slice(0, 200) } }).catch(() => {});
      });
    }
  }

  // Part of the reply went out and the rest never did, even after Co tried again: say so, never leave a bare first beat.
  if (deliveryFallback(state) === "partial" && !opts.dryRun) {
    const sent = await input.sendCoReply({ phone: input.phoneNumber, message: REPLY_PARTIAL_NOTE, asVoice: false });
    if (sent !== false) {
      state.partialUnsent = null;
      state.lastReplyText = `${state.lastReplyText} ${REPLY_PARTIAL_NOTE}`;
      await writeMemory(input.userId, "text_exchange", `Co replied: ${REPLY_PARTIAL_NOTE}`).catch((err: any) => console.error("conversationReply: logging the partial note failed (it did send):", err?.message ?? err));
    }
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 3, decision: "reply.partial", userId: input.userId, outcome: sent !== false ? "act" : "skip", action: sent !== false ? "told_them" : "not_sent" }).catch(() => {});
  }

  // A link queued but never flushed (the model shared one and then stopped)
  // still goes out, after the reply it belongs to.
  if (state.pendingLinks.length && !state.sendStopped) await flushLinks();

  // A lane move whose line no text carried (the reply never went, or only a link did): logged for the morning review, never sent on
  // its own (laneMoves.ts, Royce 2026-10-13: "never a separate text").
  if (state.laneNotes.length && !opts.dryRun) {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 3, decision: "lane.note", userId: input.userId, outcome: "skip", action: "not_carried", reason: "a confirmed move's line didn't go out in a reply this turn", proposal: { lines: state.laneNotes } }).catch(() => {});
  }

  // A turn answered as a status check for a task of Co's (services/statusCheck.ts): only a tool hold Co didn't override with
  // differentFrom (kept in the turn state, so a run that timed out still counts it). Logged with their message, so only this turn's
  // background ask capture reads it.
  if (state.sent && !opts.dryRun && opts.record !== false) {
    const S = await import("../services/statusCheck.js");
    const taskId = S.answeredAsStatus({ raised: state.statusRaised, overridden: state.statusOverridden });
    if (taskId != null) {
      const { recordDecision } = await import("../harness/core.js");
      await recordDecision({ layer: 3, decision: S.STATUS_TURN, userId: input.userId, outcome: "act", action: "answered_as_status", proposal: { taskId, message: input.resolvedContent.slice(0, 500) } }).catch(() => {});
    }
  }

  const offered = await verifyAndRecordCallOffer(input, state.lastReplyText, opts.dryRun ?? false);

  // The one artifact offer this reply was told it may make (a plan sheet, a venue brief, a stale document's fix), recorded only when
  // a text that went out makes it, so it's never offered twice (services/documentOffer.ts). Bookkeeping, never a gate on the text.
  const artifact = input.facts.artifactOffer;
  if (artifact && state.sent && !opts.dryRun && opts.record !== false) {
    const O = await import("../services/documentOffer.js");
    if (O.madeArtifactOffer(state.sentMessages.join("\n"), artifact.kind)) {
      await O.recordArtifactOffer(input.userId, artifact.kind, artifact.topic).catch((err: any) => console.error("conversationReply: recording the offer failed (non-fatal):", err?.message ?? err));
    }
  }

  // A watching offer this reply made ("want me to keep an eye out for X?") is a Co-initiated find on the ledger, so the door to a
  // member look-out is paid for (Royce, 2026-10-09). Bookkeeping after it went, never a gate on the text.
  if (state.sent && !opts.dryRun && opts.record !== false) {
    const offer = (await import("../services/coTasks.js")).watchOfferIn(state.sentMessages.join("\n"));
    if (offer) await import("../harness/proactive.js").then((P) => P.recordReplyWatchOffer(input.userId, offer)).catch((err: any) => console.error("conversationReply: logging the watch offer failed (non-fatal):", err?.message ?? err));
  }

  // A set-aside goal the reply was told about: told once a sent text raised it, else one more hint used (services/goalEdges.ts).
  const aside = input.facts.goalSetAside;
  if (aside && state.sent && !opts.dryRun && opts.record !== false) {
    // Not awaited: the recheck's Haiku read runs after the send, off the reply's path.
    void import("../services/goalEdges.js").then((g) => g.noteGoalHints(input.userId, [aside], state.sentMessages.join("\n"), { turnStartedAt: input.turnStartedAt ?? null })).catch((err: any) => console.error("conversationReply: noting the goal hint failed (non-fatal):", err?.message ?? err));
  }

  // Ask retirement (services/askRetire.ts): the question counts as asked only when the Haiku read says the sent reply asked it (else a
  // hint is used); not awaited, off the reply's path. The stopped-looking line a sent reply carried is told, never again.
  const retireAsk = input.facts.retireAsk;
  if (retireAsk && state.sent && !opts.dryRun && opts.record !== false) {
    void import("../services/askRetire.js").then((A) => A.noteRetireReply(input.userId, retireAsk, state.sentMessages.join("\n"))).catch((err: any) => console.error("conversationReply: noting the ask question failed (non-fatal):", err?.message ?? err));
  }
  const stopNote = input.facts.stopNote;
  if (stopNote && state.stopNotesSent.length && !opts.dryRun && opts.record !== false) {
    await import("../services/askRetire.js").then((A) => A.markNotesTold(input.userId, [stopNote], "reply")).catch((err: any) => console.error("conversationReply: marking the stopped-looking line told failed (non-fatal):", err?.message ?? err));
  }

  // A member with fewer than two findable interests on file: what this reply did with the steering question (services/coldStart.ts),
  // so the next reply rests after a steer and nothing already asked is asked again. Bookkeeping, never a gate on the text.
  const cold = input.facts.coldStart;
  if (cold && state.sent && !opts.dryRun && opts.record !== false) {
    const [C, R] = await Promise.all([import("../services/coldStart.js"), import("../harness/repeatAsk.js")]);
    await C.recordSteer(input.userId, { offered: cold.offered, why: cold.why, sent: state.sentMessages.join("\n"), seeds: cold.seeds, questionsIn: R.questionsIn }).catch((err: any) => console.error("conversationReply: recording the cold-start steer failed (non-fatal):", err?.message ?? err));
  }

  // A new member's first read counts as given only when a text that went out says it back (services/theDoor.ts settleFirstRead);
  // otherwise the door stays open for the next reply. Bookkeeping, never a gate on the text.
  const fr = firstRead as import("../services/theDoor.js").FirstReadPending | null;
  if (fr && state.sent && !opts.dryRun && opts.record !== false) {
    await import("../services/theDoor.js").then((d) => d.settleFirstRead(input.userId, fr, state.sentMessages.join("\n"))).catch((err: any) => console.error("conversationReply: settling the first read failed (non-fatal):", err?.message ?? err));
  }

  // Which tools Co chose, in order (evals/capabilities/probe.ts reads this).
  const toolsCalled = (agentRun?.steps ?? []).flatMap((st: any) => st.toolCalls.map((t: any) => t.toolName));
  // The one move this turn made (services/moves.ts), logged every turn, from
  // what worked rather than what was tried.
  const move = moveOf({ toolsCalled: tried, toolsDone: worked, sent: state.sent });
  if (!opts.dryRun) {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 3, decision: "turn.move", userId: input.userId, outcome: move === "quiet" ? "skip" : "act", action: move, proposal: { tools: toolsCalled, tried, worked } }).catch(() => {});
  }
  return { sent: state.sent, offered, replyText: state.lastReplyText, grounding, toolsCalled, move };
}
