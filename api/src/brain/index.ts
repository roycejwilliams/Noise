// One brain (item 10, 2026-10-12). The founder: "Co's judgment is spread across call sites, each with its own instructions
// (that's how item 9 happened). Build one judgment module: member state, knowledge, goals and event context in, decision and
// message out. The brain judges, functions guard."
//
// ---------------------------------------------------------------------------------------------------------------------------
// THE MAP: where Co's judgment and instructions are assembled today (origin/co-test at #167)
// ---------------------------------------------------------------------------------------------------------------------------
// Who Co is (shared by every surface)
//   services/coVoice.ts       CO_VOICE (identity, "what are you" vs. the list), CO_TEXT_CHANNEL, CO_WHY, CO_CRITIQUE
//   services/coCore.ts        CO_CORE = voice + listening + grounding + other-member safety + safety; texts and calls both start here
//   services/capabilities.ts  the registry: what Co can do (`can`), each tool's `use`, limits, yes-rules, onCall; the member's
//                             list per surface (capabilityMenu). Item 9 made it the one source; it is the brain's first input.
// Text replies
//   routes/sendblue.ts        builds the turn: gatherReplyFacts, then ~60 addInstruction sites (owed answer, link read, loop
//                             guide, lens rule, timeline note, safety, feedback, about-Co/list, repeat/walk-in/clarify, call
//                             scheduling, outcome and check-in answers, moment, lessons, why, dots)
//   harness/replyGrounding.ts baseReplyFacts (the capability sheet as facts), gatherReplyFacts, the door moment, cold-start steer,
//                             renderReplyFacts; groundReply is the grounding GUARD
//   agent/conversationReply.ts the system prompt (CO_CORE + MOVES + rhythm + coaching, then the member and moment), TOOL_TURN_RULES,
//                             call-offer eligibility, withdraws steer/door on safety or a call offer
//   agent/conversationTools.ts, agent/loopTools.ts  tool descriptions from the registry; situationFor trims the tool map
//   services/readTurn.ts      the one model read of a turn: mode, emotion, feedback, about_co, asks_for_list, ack; ABOUT_CO_INSTRUCTION
//   services/turnContext.ts   the turn's one picture (asks, threads, sent, lessons, tasks, kit, door, today's event)
//   services/memberKnowledge.ts the one member-knowledge layer (identity, goals, asks, delivered, carrying, lessons, corrections, limits)
// Calls
//   services/elevenLabsCalls.ts promptForElevenLabs: Hume voice layer + context block + core grounding + guides + CAPABILITY_SHEET
//   services/callBriefing.ts  CAPABILITY_SHEET (now generated from the registry), the clock and the finds per call
//   services/callContext.ts   the call's context summary (buildContextSummary), fit lines, promises, carried lines
//   services/callTools.ts     CALL_TOOLS_GUIDE + records + turn notes (task facts, avoid list); the call toolset from the registry
//   services/callLlmProxy.ts  the call brain's rounds, safety turn, closing; harness/callGrounding.ts is the spoken GUARD
// Proactive (Co texts first)
//   harness/proactive*.ts     drafts, purpose, specifics, registry; agent/companionCheckin.ts, askCheckin.ts, windowFollowUp.ts
//   services/eventBrief.ts    the member brief before a Co event (batch H owns these)
//   services/sweepSelect.ts   the sweep picker's own SELECT_SYSTEM prompt (why-member, why-now)
//   services/theDoor.ts       the first read (doorDecision, doorInstruction); tool notes come from the registry's `use`
//
// ---------------------------------------------------------------------------------------------------------------------------
// THE DESIGN
// ---------------------------------------------------------------------------------------------------------------------------
// In:  a Picture: the surface, the member's state (the turn's read, owed answers, safety), what Co knows (TurnContext /
//      memberKnowledge), their goals and open loops, event context, the capabilities live on this surface (the registry), and
//      the guards in force.
// Out: a Decision: act | ask | wait | deliver, why, and the plan: the instructions (or the brief) the surface's model drafts
//      from. The model writes the message; tools act; the decision is logged (harness_decisions "brain.<surface>").
// Guards stay functions with veto power. The brain names the ones in force so the decision log shows them, and never bypasses
// them: grounding (replyGrounding.groundReply, callGrounding), tool limits and the member's yes (agent/toolGuard.ts), outreach
// caps and quiet hours (proactive), pause (proactivePause.ts), privacy (memberSafeMemories, no cross-member leaks), safety.
// Migration: one surface at a time, each cutover its own commit, old assembly kept as the brain's implementation detail until
// verified: (1) text replies, (2) the call briefing, (3) calls. Proactive drafts and the sweep picker come after.
// Text replies (cutover 1) own the turn's judgment calls: feedback to save, the list vs. "what are you", a repeated text answered
// once, the walk-in ask, the clarifying question, and the act/ask/deliver decision. Facts (what's true) are still gathered in
// routes/sendblue.ts; the owed-answer and crisis lines stay there for now, read by the brain as state (owed, safetyConcern).
// Call briefings (cutover 2) own what a call may offer and how it reads the clock (judgeBriefing); services/callBriefing.ts gathers
// the clock and the finds and keeps the fallback a slow or failed build falls to (a guard: never a pause, never a guessed offer).
// Decisions bind (2026-10-12, the founder: "a 'wait' actually holds the send, a 'don't say this' actually blocks it"). A Decision is
// not advice: the acting code reads it. `kind` wait holds the send (texts: nothing goes out now, the reply is retried later through
// the turn's resume path, and the message stays owed until answered). `dontSay` lists what the decision rules out, each enforced
// where it acts: a tapback can't stand in for a reply (agent/conversationTools.ts), no call offer, cold-start steer or first read
// beside the brain's one question (agent/conversationReply.ts), and no event offered on a call (the briefing hands the call no
// finds, so services/offerGuard.ts has nothing to back one). Guards keep their veto after the brain and the brain can never undo
// one: a guard can only add a hold or a don't-say (vetoBriefingOffers), never remove one.
import { recordDecision } from "../harness/core.js";
import { addInstruction, type ReplyFacts } from "../harness/replyGrounding.js";
import { capabilityListInstruction, type Surface } from "../services/capabilities.js";
import { ABOUT_CO_INSTRUCTION, feedbackInstruction, type TurnRead } from "../services/readTurn.js";
import type { TurnContext } from "../services/turnContext.js";
import type { VoiceFinds } from "../services/voiceFinds.js";
import { DateTime } from "luxon";

export type DecisionKind = "act" | "ask" | "wait" | "deliver";

// The guards. Each lives in its own function and can veto; the brain only says which are in force for a decision.
export const GUARDS = {
  grounding: "harness/replyGrounding.ts groundReply (texts), harness/callGrounding.ts (calls): no claim without a source",
  tool_limits: "agent/toolGuard.ts: per-turn and per-day limits, the member's own yes, receipts",
  privacy: "services/memberSafeMemories.ts: another member's details never reach this member",
  safety: "services/safety.ts + flagSafetyConcern: stay with them, crisis support, no steering or offers",
  pause: "services/proactivePause.ts: proactive texts held while paused",
  outreach_caps: "proactive caps and 3h spacing (PR #55)",
  quiet_hours: "member-local quiet hours for anything Co sends first",
} as const;
export type GuardName = keyof typeof GUARDS;

// What a decision rules out on its surface, each enforced by the code that acts:
//   tapback      a reaction alone can't answer this turn: leaveItAtReaction and reactInsteadOfReplying refuse (`tell` is the refusal)
//   call_offer   no call offer in this reply (agent/conversationReply.ts callOfferEligible)
//   steer        the cold-start steering question is withdrawn (replyGrounding withdrawColdStartSteer)
//   first_read   a new member's first read is withdrawn (replyGrounding withdrawDoorMoment)
//   event_offer  the call is handed no finds: its findsNow is the don't-offer line, so the spoken offer guard backs no find
export type DontSay = "tapback" | "call_offer" | "steer" | "first_read" | "event_offer";
export type Rule = { what: DontSay; why: string; tell?: string };

export type Decision = {
  surface: Surface;
  kind: DecisionKind;
  why: string;
  // What the surface's model drafts from, in order.
  instructions: string[];
  guards: GuardName[];
  // What this decision rules out (bound, see DontSay).
  dontSay: Rule[];
};

// The rule a decision sets for one thing, or null when it doesn't rule it out.
export function ruledOut(d: Pick<Decision, "dontSay"> | null | undefined, what: DontSay): Rule | null {
  return d?.dontSay.find((r) => r.what === what) ?? null;
}

// ---------- Text replies (cutover 1)
export type TextPicture = {
  userId: string;
  // The turn's one model read (services/readTurn.ts); null when it didn't run.
  read: Pick<TurnRead, "aboutCo" | "asksForList" | "feedback"> | null;
  // Their last message never got a real answer.
  owed: boolean;
  safetyConcern: boolean;
  // The router couldn't tell what they mean (a clarifying question is due).
  clarify: string | null;
  // They sent the same text again while waiting (answer once), and a walk-in check-in with no ask on file (ask it, once).
  repeat?: string | null;
  walkinAsk?: string | null;
  turn: Pick<TurnContext, "tasks" | "todayEvent"> | null;
};

// Pure: what Co does with this text, and what it drafts from.
export function judgeText(p: TextPicture): Decision {
  const instructions: string[] = [];
  const feedback = feedbackInstruction(p.read?.feedback ?? []);
  if (feedback) instructions.push(feedback);
  // An outright "what can you do" gets the whole list from the registry; "what are you" gets where their work stands.
  if (p.read?.asksForList) instructions.push(capabilityListInstruction());
  else if (p.read?.aboutCo) instructions.push(ABOUT_CO_INSTRUCTION);
  if (p.repeat) instructions.push(p.repeat);
  if (p.walkinAsk) instructions.push(p.walkinAsk);
  if (p.clarify) instructions.push(p.clarify);
  const kind: DecisionKind = p.safetyConcern ? "act" : p.owed || p.read?.asksForList ? "deliver" : p.clarify || p.walkinAsk ? "ask" : "act";
  const why = p.safetyConcern
    ? "they may not be safe: stay with them"
    : p.owed
      ? "an earlier message is still owed a real answer"
      : p.read?.asksForList
        ? "they asked for the list of what Co can do"
        : p.clarify
          ? "what they mean isn't clear yet"
          : p.walkinAsk
            ? "they just walked in with no ask on file"
          : "answer what they said and act on it";
  const guards: GuardName[] = ["grounding", "tool_limits", "privacy", ...(p.safetyConcern ? (["safety"] as const) : [])];
  // What it rules out. A safety turn and an owed answer keep the lines Co was already held to; the list and an ask are new.
  const dontSay: Rule[] = [];
  const tapback = (why: string, tell: string) => dontSay.push({ what: "tapback", why, tell });
  if (p.safetyConcern) {
    tapback("they may not be safe, so Co has to reply", "They may not be safe. Reply to them properly.");
    dontSay.push({ what: "steer", why: "a safety concern this turn" }, { what: "first_read", why: "a safety concern this turn" });
  } else if (p.owed) tapback("Co still owes them an answer from before, so it has to reply", "You still owe them an answer from before. Reply properly instead.");
  else if (kind === "deliver") tapback("they asked what Co can do, so a reaction can't answer it", "They asked what you can do. A reaction can't answer that; reply with it.");
  if (kind === "ask") {
    tapback("this turn asks them something, so it needs words", "This turn asks them something, and a reaction can't ask it. Reply with the question.");
    // One question a reply: the ask is it, so nothing else that asks something goes beside it.
    dontSay.push({ what: "call_offer", why: "this reply's one question is the ask" }, { what: "steer", why: "this reply asks them something" }, { what: "first_read", why: "this reply asks them something" });
  }
  return { surface: "text", kind, why, instructions, guards, dontSay };
}

// The text path's cutover: the brain's plan goes into the reply's facts (the old assembly around it is unchanged), and the
// decision is logged. Never throws: a failed log costs the reply nothing.
export function planTextReply(p: TextPicture, facts: ReplyFacts): Decision {
  const d = judgeText(p);
  for (const i of d.instructions) addInstruction(facts, i);
  recordDecision({ layer: 3, decision: "brain.text", userId: p.userId, outcome: d.kind === "ask" ? "ask" : d.kind === "wait" ? "skip" : "act", action: d.kind, proposal: { why: d.why, instructions: d.instructions.length, guards: d.guards, dontSay: d.dontSay.map((r) => r.what), tasks: p.turn?.tasks?.length ?? 0, eventToday: !!p.turn?.todayEvent } }).catch(() => {});
  return d;
}

// ---------- Call briefings (cutover 2)
// What the call brain is handed per call besides its prompt: the clock and what Co has found for them. The facts are gathered in
// services/callBriefing.ts (their city from member knowledge, the timeline, the finds); the brain judges what the call may offer.
export type BriefingPicture = {
  userId: string;
  now: Date;
  // Their local time and what's ahead (services/timeline.ts), or null when it didn't load.
  clock: { fact: string; note?: string | null } | null;
  finds: VoiceFinds;
  // Guards that veto offers on this call, applied after the brain judges (e.g. a safety hold: services/safety.ts).
  vetoes?: { guard: GuardName; why: string }[];
};
export type CallBriefing = { rightNow: string; findsNow: string };
// The briefing that was built, or the fallback a slow or failed build falls to (a guard: never a pause, never a guessed offer).
export type BriefingDecision = Decision & { briefing: CallBriefing; source: "built" | "fallback" };

export function renderFinds(f: VoiceFinds): string {
  if (!f.available) return `Nothing to offer right now (${f.reason}). Don't offer an event; if they ask what's on, look it up now or say you don't have anything yet.`;
  const lines = f.items.map((i) => `- ${i.name}${i.starts ? ` | starts ${i.starts}` : ""}${i.details.length ? ` | ${i.details.join(" ")}` : ""}${i.link ? " | link on file (offer to text it)" : ""}`);
  return `${f.note}\nLooking for: ${f.lookingFor}\n${lines.join("\n")}`.slice(0, 2400);
}

const pacificClock = (now: Date) => `It is ${DateTime.fromJSDate(now).setZone("America/Los_Angeles").toFormat("cccc, LLLL d, h:mm a")} Pacific. Don't assume that is their local time.`;

// The finds the call is handed follow the decision: only a "deliver" with no event_offer rule hands any over.
function findsFor(d: Pick<Decision, "dontSay">, finds: VoiceFinds): string {
  const held = ruledOut(d, "event_offer");
  return held ? renderFinds(finds.available ? { available: false, reason: held.why } : finds) : renderFinds(finds);
}

// Pure: what the call may offer and how it reads the clock. Something on file is delivered; nothing means wait (no event offered).
export function judgeBriefing(p: BriefingPicture): BriefingDecision {
  const rightNow = p.clock
    ? `${p.clock.fact}${p.clock.note ? ` ${p.clock.note}` : ""} "Tonight" and "today" mean the hours left before they sleep; an event is only "tonight" if its start below says today.`
    : pacificClock(p.now);
  const offering = p.finds.available && p.finds.items.length > 0;
  const why = offering ? "Co has finds on file for them that the call can offer" : "nothing on file to offer, so the call offers no event";
  const dontSay: Rule[] = offering ? [] : [{ what: "event_offer", why: p.finds.available ? "nothing on file to offer" : p.finds.reason }];
  const findsNow = findsFor({ dontSay }, p.finds);
  const judged: BriefingDecision = {
    surface: "call",
    kind: offering ? "deliver" : "wait",
    why,
    instructions: [rightNow, findsNow],
    guards: ["grounding", "privacy"],
    dontSay,
    briefing: { rightNow, findsNow },
    source: "built",
  };
  return (p.vetoes ?? []).reduce((d, v) => vetoBriefingOffers(d, p.finds, v.guard, v.why), judged);
}

// A guard's veto after the brain: the call offers nothing. It only ever adds the hold; nothing here can lift one.
export function vetoBriefingOffers(d: BriefingDecision, finds: VoiceFinds, guard: GuardName, why: string): BriefingDecision {
  const dontSay: Rule[] = ruledOut(d, "event_offer") ? d.dontSay : [...d.dontSay, { what: "event_offer", why }];
  const findsNow = findsFor({ dontSay }, finds);
  return {
    ...d,
    kind: "wait",
    why: d.kind === "wait" ? d.why : `${why} (the ${guard} guard holds the offers)`,
    guards: d.guards.includes(guard) ? d.guards : [...d.guards, guard],
    dontSay,
    instructions: [d.briefing.rightNow, findsNow],
    briefing: { rightNow: d.briefing.rightNow, findsNow },
  };
}

// What a call gets when the briefing isn't ready in time or failed: the Pacific clock and no offers.
export function fallbackBriefing(now: Date, why: string): BriefingDecision {
  const rightNow = pacificClock(now);
  const findsNow = "Nothing to offer right now. Don't offer an event; if they ask what's on, look it up now or say you don't have anything yet.";
  return { surface: "call", kind: "wait", why, instructions: [rightNow, findsNow], guards: ["grounding", "privacy"], dontSay: [{ what: "event_offer", why }], briefing: { rightNow, findsNow }, source: "fallback" };
}

// Logged when the call takes its briefing (services/callBriefing.ts takeCallBriefing), with what the call actually got: the built
// briefing or the fallback. A briefing built for a call that never connects is never logged. Never waits.
export function logBriefing(userId: string, d: BriefingDecision): void {
  recordDecision({ layer: 3, decision: "brain.briefing", userId, outcome: d.kind === "wait" ? "skip" : "act", action: d.kind, proposal: { why: d.why, source: d.source, guards: d.guards, dontSay: d.dontSay.map((r) => r.what), offered: !ruledOut(d, "event_offer") } }).catch(() => {});
}
