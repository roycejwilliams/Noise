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
// Calls (cutover 3) own each turn's judgment (judgeCallTurn): what the turn is told (the drained note, the tools guide and records,
// the stop list and a fact to write down) and what it rules out (a second question, anything after the question when they lead,
// ending the call before they close). services/callLlmProxy.ts reads the facts off the request and enforces the decision; its
// spoken guards (the source check, sends not yet made, "glad you called" on Co's call, insisting, stock lines) keep their veto.
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
import { DRAINED_NOTE } from "../services/memberState.js";
import { mentionsIn } from "../services/offerGuard.js";

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
//   second_question  a call turn says one question; a later one is not spoken (services/callLlmProxy.ts say)
//   after_question   a call turn ends at its question: nothing after it is spoken (they lead)
//   end_call         the call isn't ended by Co: they haven't closed it (Co never hangs up first)
//   offer            a text Co sends first carries no link, event or suggestion (its draft rules allow no URL)
export type DontSay = "tapback" | "call_offer" | "steer" | "first_read" | "event_offer" | "second_question" | "after_question" | "end_call" | "offer";
export type Rule = { what: DontSay; why: string; tell?: string };

export type Decision = {
  // A member-facing surface, or what Co sends first (proactive).
  surface: Surface | "proactive";
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

// ---------- Calls (cutover 3): each turn of a call
// The facts of the turn, read off the call's request in services/callLlmProxy.ts (the brain reads no request itself).
export type CallTurnPicture = {
  userId?: string | null;
  // Their last words said they are tired, stressed or drained (services/memberState.ts memberStateSignal), on this turn's first request.
  drained: boolean;
  // The call has touched their safety (callLlmProxy.ts safetyCall): no question limit.
  safetyCall: boolean;
  // An inbound call's first reply, and their first words don't ask Co anything: they lead.
  inboundFirst: boolean;
  // Their last words close the call, or Co already closed its last turn and this is their reply.
  closed: boolean;
  // Co's tools on this call (services/callTools.ts): the guide and Co's records, and this turn's facts for its note.
  tools?: { note?: string | null; turnWords: string; tasks: { id: number; goal: string }[]; avoid?: string[]; canWriteTasks: boolean } | null;
  // A turn note given as is (tests), in place of the one written from the tools' facts.
  givenTurnNote?: string | null;
};
export type CallTurnDecision = Decision & {
  // Added to the cached system prompt, and after their words this turn (past the cache breakpoint).
  systemNote?: string;
  turnNote: string | null;
};

// Pure: what this call turn may do, and what it is told.
export function judgeCallTurn(p: CallTurnPicture): CallTurnDecision {
  const dontSay: Rule[] = [];
  // One question a turn, unless the call has touched their safety.
  if (!p.safetyCall) dontSay.push({ what: "second_question", why: "one question a turn" });
  if (p.inboundFirst && !p.safetyCall) dontSay.push({ what: "after_question", why: "an inbound call's first reply: they lead" });
  if (!p.closed) dontSay.push({ what: "end_call", why: "Co never hangs up first: they haven't said goodbye" });
  const kind: DecisionKind = p.inboundFirst && !p.safetyCall ? "ask" : "act";
  const why = p.safetyCall
    ? "the call has touched their safety: stay with them"
    : p.drained
      ? "they told Co how they are: stay with them"
      : p.inboundFirst
        ? "they called: ask what's on their mind and let them lead"
        : "answer what they said and act on it";
  const systemNote = [p.drained ? DRAINED_NOTE : "", p.tools?.note ?? ""].filter(Boolean).join("\n\n") || undefined;
  const t = p.tools;
  const turnNote = p.givenTurnNote ?? (t ? [t.canWriteTasks ? taskFactNote(t.turnWords, t.tasks) : null, avoidNote(t.avoid)].filter(Boolean).join("\n") || null : null);
  return {
    surface: "call",
    kind,
    why,
    instructions: [systemNote ?? "", turnNote ?? ""].filter(Boolean),
    guards: ["grounding", "privacy", "tool_limits", ...(p.safetyCall ? (["safety"] as const) : [])],
    dontSay,
    systemNote,
    turnNote,
  };
}

// Logged per turn without waiting (the voice never waits on it).
export function logCallTurn(userId: string, d: CallTurnDecision): void {
  recordDecision({ layer: 3, decision: "brain.call", userId, outcome: "act", action: d.kind, proposal: { why: d.why, guards: d.guards, dontSay: d.dontSay.map((r) => r.what), turnNote: !!d.turnNote } }).catch(() => {});
}

// Pure: the stop-suggesting list as it stands right now, for this turn only (after the cache breakpoint, so the call's cached prefix is
// untouched). The call's opening context has it too; this keeps it current when it changes during the call.
export function avoidNote(avoid: string[] | undefined): string | null {
  return avoid?.length ? `(Co's note, not their words: right now they've asked you never to suggest ${avoid.map((a) => `"${a}"`).join(", ")}. No need to mention it.)` : null;
}

// Pure: the names and numbers in their words (each sentence's own first word is only a capital, so sentences are read apart).
export function specificsTheyGave(turnWords: string): string[] {
  const out = new Set<string>();
  for (const s of turnWords.split(/(?<=[.!?])\s+/)) for (const m of mentionsIn(s)) if (m.kind === "name" || m.kind === "time") out.add(m.text);
  for (const m of turnWords.match(/\$?\d[\d,.]*(?:\s?(?:k|%|people|guests|pm|am))?/gi) ?? []) out.add(m.replace(/[.,]$/, ""));
  return [...out].filter((x) => x.length >= 2);
}

const MONTH_OR_DAY = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
// Pure: this turn's note, after their words. Only when a task is open and their words carry a name, number or date.
export function taskFactNote(turnWords: string, tasks: { id: number; goal: string }[]): string | null {
  if (!tasks.length) return null;
  const given = specificsTheyGave(turnWords);
  if (!given.length && !MONTH_OR_DAY.test(turnWords)) return null;
  const what = given.length ? given.map((g) => `"${g}"`).join(", ") : "a date";
  return `(A note from Co's own records, not their words: they just gave you ${what}. If that belongs to one of your open tasks, write it on that task with updateTask in this turn, in their words, then answer. Saying it back doesn't write it down.)`;
}

// ---------- Outgoing drafts (cutover 4): what Co texts first
// The proactive dispatch (harness/proactive.ts dispatchForUser) gathers the facts and runs the model reads (Co's pick, the
// re-read of a waiting answer, the composer, payload first); the brain decides from them, one stage at a time, and the dispatch
// acts only on the decision: a text goes out only when the last decision is deliver, for the candidate it names. Guards keep their
// veto at every step: the gates (caps, quiet hours, pause, safety hold, spacing) decide what is eligible before the brain sees it,
// a find on its last day goes first after it (lastDayFirst), and the draft's checks and the send-time ledger can still stop it.
export type DraftDecision = Decision & {
  // The candidate this decision is about (the one to send, hold or drop), or null when nothing is picked.
  pick: string | null;
  source: "code" | "co";
  // wait: how long nothing goes (hours), or until when the candidate waits; drop: why it leaves the queue for good.
  holdHours?: number;
  until?: Date;
  drop?: string;
  // Payload first: the task that does the work instead of asking.
  task?: string;
};
const draftBase = { surface: "proactive" as const, instructions: [] as string[], guards: ["outreach_caps", "quiet_hours", "pause", "safety", "privacy", "grounding"] as GuardName[], dontSay: [] as Rule[] };

// Pure: the day's pick. A find that would miss its next slot goes first (the code read, expiringFind); otherwise Co's pick; Co picking
// nothing holds the day.
export function judgeDailyPick(p: { urgent: { id: string; why: string } | null; chosen: { id: string | null; why: string; source: "code" | "co" }; noneHoldHours: number }): DraftDecision {
  if (p.urgent) return { ...draftBase, kind: "deliver", why: p.urgent.why, pick: p.urgent.id, source: "code" };
  if (!p.chosen.id) return { ...draftBase, kind: "wait", why: `pick: none (${p.chosen.why})`, pick: null, source: p.chosen.source, holdHours: p.noneHoldHours };
  return { ...draftBase, kind: "deliver", why: p.chosen.why, pick: p.chosen.id, source: p.chosen.source };
}

// The last-day guard after the brain (harness/proactive.ts lastDayFirst): a picked find ending today goes ahead of a pick that is
// still true tomorrow. It only re-points a deliver; it never makes a hold send.
export function lastDayVeto(d: DraftDecision, lastDay: { id: string; why: string } | null): DraftDecision {
  if (!lastDay || d.kind !== "deliver") return d;
  return { ...d, pick: lastDay.id, why: lastDay.why, source: "code" };
}

// Pure: a waiting answer re-read before it goes. Unanswered: it waits and is read again; no longer true: it leaves the queue.
export function afterRelevance(d: DraftDecision, r: { relevant: boolean; why: string } | null, retryHours: number): DraftDecision {
  if (d.kind !== "deliver") return d;
  if (!r) return { ...d, kind: "wait", why: `relevance check unanswered; held ${retryHours}h`, holdHours: retryHours };
  if (!r.relevant) return { ...d, kind: "wait", why: `no longer relevant: ${r.why}`, drop: `stale: ${r.why}` };
  return d;
}

// Pure: the composer asked to wait (a live conversation about something else): the bundle waits until `until`.
export function afterComposeWait(d: DraftDecision, why: string, until: Date): DraftDecision {
  if (d.kind !== "deliver") return d;
  return { ...d, kind: "wait", why: `waiting on a live conversation: ${why}`, until };
}

// Pure: payload first (harness/payloadFirst.ts). A text asking whether Co should do what it could just do goes to a task (act);
// a question that shouldn't be asked leaves the queue.
export function afterPayloadFirst(d: DraftDecision, pf: { handedTo: string; why: string } | { hold: string } | null): DraftDecision {
  if (d.kind !== "deliver" || !pf) return d;
  if ("handedTo" in pf) return { ...d, kind: "act", why: pf.why, task: pf.handedTo };
  return { ...d, kind: "wait", why: pf.hold, drop: `payload first: ${pf.hold}` };
}

// Whether the decision lets this candidate go out now: the dispatch's last check before the send.
export function sends(d: DraftDecision, candidateId: string): boolean {
  return d.kind === "deliver" && d.pick === candidateId;
}

// One row per dispatch that reached the brain, with its final decision. Never waits.
export function logDraftDecision(userId: string, d: DraftDecision, type: string | null): void {
  recordDecision({ layer: 7, decision: "brain.proactive", userId, outcome: d.kind === "deliver" || d.kind === "act" ? "act" : "skip", action: `${d.kind}${type ? `:${type}` : ""}`, proposal: { why: d.why.slice(0, 300), pick: d.pick, source: d.source, drop: d.drop ?? null, task: d.task ?? null, holdHours: d.holdHours ?? null, until: d.until?.toISOString() ?? null, guards: d.guards } }).catch(() => {});
}

// ---------- Companion check-ins: what the check-in is about, and what it may carry
export type CheckinBasis = "heavy" | "advice" | "story" | "thread" | "curious" | "recap";
export type CheckinDecision = Decision & { basis: CheckinBasis };
// Pure: the most pressing thing on file decides what the check-in is about: something hard they shared yesterday, then advice Co gave,
// then a moment worth marking, then an open thread, then what Co is still figuring out, then the recap. Only a thread with one thing
// found for it may carry an offer (that one link); every other check-in offers nothing.
export function judgeCheckin(p: { heavy: boolean; advice: boolean; story: boolean; thread: boolean; curious: boolean; item: boolean }): CheckinDecision {
  const basis: CheckinBasis = p.heavy ? "heavy" : p.advice ? "advice" : p.story ? "story" : p.thread ? "thread" : p.curious ? "curious" : "recap";
  const why = { heavy: "something hard they shared yesterday: check on them", advice: "advice Co gave: ask how it went", story: "a moment worth marking", thread: "an open thread of theirs: ask where it landed", curious: "something Co is still figuring out, where the conversation leads", recap: "one specific thing from the recap, or nothing" }[basis];
  // curious may offer one way Co can help, as a question, never a link.
  const dontSay: Rule[] = basis === "thread" && p.item ? [] : [{ what: "offer", why: basis === "curious" ? "a way to help is offered as a question, never a link" : "this check-in offers nothing" }];
  return { surface: "proactive", kind: "ask", why, instructions: [], guards: ["outreach_caps", "quiet_hours", "pause", "safety", "grounding"], dontSay, basis };
}

// ---------- Sweep picks: what each judged find does to the queue
// The picker's verdicts are the brain's read (services/sweepSelect.ts SELECT_SYSTEM), checked by guardVerdicts (facts: cites that
// exist, why-member and why-now, not past, the day's send limit). What each guarded verdict does is the brain's decision: send
// delivers (queued), hold waits (back to the backlog), reject leaves for good, no verdict waits untouched.
// leave: never judged, so where it waits is left as it is.
export type SweepDecision = { key: string; kind: DecisionKind; drop: boolean; leave: boolean; why: string };
export function judgeSweepItem(j: { key: string; verdict: "send" | "hold" | "reject" | "no_verdict"; why?: string }): SweepDecision {
  const why = j.why ?? "";
  if (j.verdict === "send") return { key: j.key, kind: "deliver", drop: false, leave: false, why };
  if (j.verdict === "reject") return { key: j.key, kind: "wait", drop: true, leave: false, why };
  return { key: j.key, kind: "wait", drop: false, leave: j.verdict === "no_verdict", why };
}
