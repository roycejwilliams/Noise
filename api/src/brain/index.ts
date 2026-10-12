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
import { recordDecision } from "../harness/core.js";
import { addInstruction, type ReplyFacts } from "../harness/replyGrounding.js";
import { capabilityListInstruction, capabilityMenu, type Surface } from "../services/capabilities.js";
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

export type Decision = {
  surface: Surface;
  kind: DecisionKind;
  why: string;
  // What the surface's model drafts from, in order.
  instructions: string[];
  guards: GuardName[];
};

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
  return { surface: "text", kind, why, instructions, guards };
}

// The text path's cutover: the brain's plan goes into the reply's facts (the old assembly around it is unchanged), and the
// decision is logged. Never throws: a failed log costs the reply nothing.
export function planTextReply(p: TextPicture, facts: ReplyFacts): Decision {
  const d = judgeText(p);
  for (const i of d.instructions) addInstruction(facts, i);
  recordDecision({ layer: 3, decision: "brain.text", userId: p.userId, outcome: d.kind === "ask" ? "ask" : d.kind === "wait" ? "skip" : "act", action: d.kind, proposal: { why: d.why, instructions: d.instructions.length, guards: d.guards, tasks: p.turn?.tasks?.length ?? 0, eventToday: !!p.turn?.todayEvent } }).catch(() => {});
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
};
export type CallBriefing = { rightNow: string; findsNow: string };

export function renderFinds(f: VoiceFinds): string {
  if (!f.available) return `Nothing to offer right now (${f.reason}). Don't offer an event; if they ask what's on, look it up now or say you don't have anything yet.`;
  const lines = f.items.map((i) => `- ${i.name}${i.starts ? ` | starts ${i.starts}` : ""}${i.details.length ? ` | ${i.details.join(" ")}` : ""}${i.link ? " | link on file (offer to text it)" : ""}`);
  return `${f.note}\nLooking for: ${f.lookingFor}\n${lines.join("\n")}`.slice(0, 2400);
}

// Pure: what the call may offer and how it reads the clock. Something on file is delivered; nothing means wait (no event offered).
export function judgeBriefing(p: BriefingPicture): Decision & { briefing: CallBriefing } {
  const rightNow = p.clock
    ? `${p.clock.fact}${p.clock.note ? ` ${p.clock.note}` : ""} "Tonight" and "today" mean the hours left before they sleep; an event is only "tonight" if its start below says today.`
    : `It is ${DateTime.fromJSDate(p.now).setZone("America/Los_Angeles").toFormat("cccc, LLLL d, h:mm a")} Pacific. Don't assume that is their local time.`;
  const findsNow = renderFinds(p.finds);
  const offering = p.finds.available && p.finds.items.length > 0;
  return {
    surface: "call",
    kind: offering ? "deliver" : "wait",
    why: offering ? "Co has finds on file for them that the call can offer" : "nothing on file to offer, so the call offers no event",
    instructions: [rightNow, findsNow],
    guards: ["grounding", "privacy"],
    briefing: { rightNow, findsNow },
  };
}

// The briefing's cutover: judged, then logged without waiting (the call never pauses on the log).
export function planCallBriefing(p: BriefingPicture): CallBriefing {
  const d = judgeBriefing(p);
  recordDecision({ layer: 3, decision: "brain.briefing", userId: p.userId, outcome: d.kind === "wait" ? "skip" : "act", action: d.kind, proposal: { why: d.why, guards: d.guards, finds: p.finds.available ? p.finds.items.length : 0, clock: !!p.clock } }).catch(() => {});
  return d.briefing;
}

// What Co can do on a surface, from the registry (the brain's first input source).
export function capabilitiesFor(surface: Surface) {
  return capabilityMenu(surface);
}
