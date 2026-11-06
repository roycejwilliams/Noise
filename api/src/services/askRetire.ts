// Ask retirement (Royce, 2026-10-13: "Fix the retirement ID bug, but retirement must respect the recheck flow: ask once, then idle,
// with a member-visible note - no silent expiries. If retirement and the recheck disagree about who acts first, the recheck acts
// first."). A find ask that restates one of their work or Co-task goals (goalEdges.ts planGoalSweep) used to be switched to kind
// 'help' on the spot, silently, and never was: ask_checkins.id is a UUID and was read with Number() (NaN).
//   1. The plan marks it retire-due (flagRetire), tied to the goals it restates and the active goal it serves (serves_goal_id). A
//      Co-task ask ("have Co draft…") restates Co's own work: it's in the status-check lane (services/statusCheck.ts, Royce
//      2026-10-13), never retired, never switched, no note; asked about, the reply answers where the work stands, and the search keeps
//      running. Each whole plan re-evaluates: a mark the plan no longer makes, on an ask not yet asked and not tied to a set-aside still
//      to be told, is cleared.
//   2. The recheck acts first: while a tied goal's recheck is due or open (or its set-aside question is still to be told), the ask
//      waits. A tied goal that stops after the mark (idled by the recheck, or closed and told) takes the ask with it: kind help, no
//      question of its own, the goal's one note covers both, and bringing the goal back brings the ask back. A tied goal that stopped
//      before the mark doesn't: the ask is asked once on its own. A tied goal they answered or brought back since the mark: cleared,
//      and the next plan decides again.
//   3. Otherwise the ask goes the goal's way: one question ("still want me looking for X?") in the next natural reply, through the
//      same hint path, or one paced text (goal_recheck, kind ask) after RECHECK_TEXT_AFTER_DAYS with no exchange; one question at a
//      time across goals and asks (the logged asks: goal.recheck_asked, ask.retire_asked). The same Haiku read decides whether the
//      question went out. No answer in RECHECK_ANSWER_DAYS: idle (kind help through laneMoves.ts setAskKind, no longer searched).
//   4. Before the question, a mention or a reaction to one of its finds keeps it searched and holds retirement off for
//      RETIRE_HOLD_DAYS. Once it's asked, only their answer counts ("No, stop looking for the venues" names it and is a no): a Haiku
//      read of their reply against Co's last text, acted on only when that text asked it.
//   5. No silent expiries: an ask (or a goal the recheck idled) that stops being searched leaves one short line in Co's voice,
//      written once when it idles (lineInVoice, stored: retire_note, idle_note), carried by code in the next natural reply, or, with
//      no exchange for RECHECK_TEXT_AFTER_DAYS, in the next paced text Co sends anyway (never a heavy check-in; a hard day makes it
//      wait, at most the cap: services/moodHold.ts). Never a text of its own, never a list, never twice. For REVIVE_DAYS after it,
//      their reply is read: "pick it back up" brings it back.
// Every decision is made in pure functions here (retireDecide, marksToClear, notesFrom, noteToRide, fallbackLabel); every read and
// write is one member's own.
import pool from "../db/db.js";
import { goalHash, fromStateRow, isCoTaskGoal, type GoalState } from "./goalEdges.js";
import { ROLE_NOUN } from "./goalOwnership.js";
import {
  RECHECK_ANSWER_DAYS, RECHECK_IDLE_REASON, RECHECK_LOOKBACK_DAYS, RECHECK_REPLY_HINTS, RECHECK_TEXT_AFTER_DAYS,
  haikuRecheckJudge, judgeRecheckAsked, mentionsGoal, realRecheckDeps, recheckAskOpen, type RecheckJudge, type RecheckStep,
} from "./goalRecheck.js";

export const RETIRE_HOLD_DAYS = 30;
// How long after a stopped-looking note their replies are read for "pick it back up".
export const REVIVE_DAYS = 14;
// About sixty characters, cut on a word boundary and never on a dangling small word.
export const NOTE_LABEL_CHARS = 64;
const DAY = 86_400_000;

// ---------- pure: the note's fallback (the written line is lineInVoice's; this is used when that read fails)

const GOAL_VERBS = new Set(["raise", "take", "learn", "write", "build", "meet", "run", "start", "launch", "plan", "join", "travel", "get", "make", "grow", "hire", "explore", "try", "visit", "attend", "train", "practice", "improve", "read", "play", "open", "move", "buy", "sell", "ship", "partner", "connect", "network", "date", "cook", "study", "teach", "host", "organize", "become", "save", "spend", "see", "go", "do", "have", "keep", "work", "lose", "finish", "close", "land", "pitch", "fundraise", "create", "design", "release", "publish", "record", "found", "expand", "scale", "rebuild", "relocate", "settle"]);
const IRREGULAR: Record<string, string> = { be: "being", see: "seeing", go: "going", do: "doing", die: "dying", lie: "lying" };
export function gerund(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR[v]) return IRREGULAR[v];
  if (/ing$/.test(v)) return v;
  if (/ie$/.test(v)) return `${v.slice(0, -2)}ying`;
  if (/[^aeiouy]e$/.test(v) && v !== "be") return `${v.slice(0, -1)}ing`;
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(v) && v.length <= 4 && !/^(?:open|visit)$/.test(v)) return `${v}${v.slice(-1)}ing`;
  return `${v}ing`;
}
// Pure: what the fallback line names, from their words, made to read after "the search on" (a thing, "a cofounder for your climate
// startup", or a doing, "raising a pre-seed round"). In order: the framing goes (an opener like "Of course,", wanting and request
// words, an infinitive "to", "going to"/"need to"/"about to"/"planning to" only before a verb, "find me", "the search for", a leading
// preposition), repeated until nothing more comes off; Cue is dropped only when addressed ("Cue, find me jazz", a leading "Cue's",
// "find Cue" or Cue alone), never as an ordinary noun ("Cue cards for my talk", "Pool Cue repair"); "my" is "your"; a leading verb
// used as one becomes its doing ("raise" is "raising"), but never the first word of a noun phrase ("date night spots", "launch party venues"); only the
// word that started their text is lower-cased, and never a capitalized name after it ("To Lisbon" keeps "Lisbon"); no quotes,
// dashes or exclamation points; nothing but framing or prepositions left is nothing ("this", in the line); at most
// NOTE_LABEL_CHARS, on a word boundary when there is one. (It used to read after "looking for", with a doing as "things for
// <doing it>"; Royce, 2026-10-17: "reword it so it works for any goal".) Each pattern runs on the text with a trailing space, so a
// label that is only framing ("Looking for", "Honestly") comes off whole.
const OPENERS = /^(?:of course|honestly|basically|ideally|well|also|okay|ok|for now|right now)\s*,?\s+/i;
const WANTING = /^(?:(?:can|could|would) you |please |pls |help me |i(?:'d| would) like to |i want to |wants to |want to |would like to |hoping to |trying to |looking to |i'm |im |i am |to )+/i;
// "Going to", "need to", "about to", "planning to" are framing only before a verb ("Going to Tokyo" is a place, "Need to know: wine
// bars" is the thing).
const VERB_FRAMING = new RegExp(`^(?:going|need|needs|about|planning|plan) to (?=(?:${[...GOAL_VERBS].join("|")})\\b)`, "i");
const SEARCHING = /^(?:(?:the|a|my|our) (?:search|hunt|look)(?: for,?)? |on the (?:search|hunt|lookout) for,? |looking for,? |look(?:ing)? out for,? |keep an eye out for,? |find(?:ing)? |look for,? |search(?:ing)? for,? |get me |watch for |track down |seeking )(?:me )?/i;
// A leading preposition comes off only with something after it that isn't another preposition ("for my sister's birthday dinner").
const LEAD_PREP = /^(?:for|on|about|into|of|to)\s+(?!(?:for|on|about|into|of|to|in|at|with|by)\b)(?=\S)/i;
const ONLY_PREPS = /^(?:(?:for|on|about|into|of|to|in|at|with|by|from)\b\s*)*$/i;
// The second word that makes a leading verb the first half of a noun ("date night", "run club", "launch party", "pitch deck").
const COMPOUND_NOUN = new Set(["night", "nights", "club", "clubs", "party", "parties", "plan", "plans", "event", "events", "deck", "decks", "store", "stores", "group", "groups", "book", "books", "date", "dates", "spot", "spots", "list", "lists", "space", "spaces", "session", "sessions", "buddy", "buddies", "crew", "crews", "team", "teams", "venue", "venues", "idea", "ideas", "trip", "trips", "ticket", "tickets", "mate", "mates", "partner", "partners", "shoe", "shoes", "gear", "night's", "nights'", "class", "classes", "room", "rooms", "studio", "studios"]);
export function fallbackLabel(text: string): string {
  let t = String(text ?? "").replace(/[“”"]/g, "").replace(/\s*[—–]\s*/g, ", ").replace(/!/g, "").replace(/\s+/g, " ").trim().replace(/[.,;:?]+$/, "");
  t = t.replace(/\s*\b(?:with|for|via|through|by|from|and) (?:Co|Cue)\b('s)?/gi, "").replace(/\bCo's\s+/gi, "").replace(/^cue(?:,\s*|'s\s+)/i, "").replace(/^(?:(?:find|ask) )?cue(?:'s)?$/i, "").replace(/\s+/g, " ").trim();
  const opening = t;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = `${t} `.replace(OPENERS, "").replace(WANTING, "").replace(VERB_FRAMING, "").replace(SEARCHING, "").replace(LEAD_PREP, "").replace(/^[,;:]\s*/, "").trim();
    if (t === before) break;
  }
  // Only the word their text started with may be lower-cased: a word the framing uncovered keeps its case ("To Lisbon").
  const startsTheirText = t === opening;
  // "Getting into pottery" is about getting into it; "Getting a dog" is the dog.
  const getting = t.match(/^getting\s+(\S+)/i);
  if (getting) t = /^(?:into|back|better|in|on|out|started|fit|over|through)$/i.test(getting[1]) ? `getting${t.slice("getting".length)}` : t.replace(/^getting\s+/i, "");
  t = t.replace(/\bmy\b/gi, "your").replace(/\bme\b/gi, "you").replace(/\bI'm\b/g, "you're").trim();
  const words = t.split(" ");
  const first = (words[0] ?? "").toLowerCase();
  const nounPhrase = COMPOUND_NOUN.has(String(words[1] ?? "").toLowerCase());
  if (GOAL_VERBS.has(first) && !nounPhrase) t = `${gerund(first)}${t.slice(words[0].length)}`;
  // Any other leading "-ing" verb ("partnering with Sequin AI…") is a doing already.
  else if (/^[a-z]+ing$/.test(first) && first.length > 5 && !/^(?:thing|something|anything|evening|morning|building|meeting|ring|king|wedding|clothing|housing|wing|string|painting|reading|tasting|screening)$/.test(first)) t = `${first}${t.slice(words[0].length)}`;
  else if (startsTheirText && /^[A-Z][a-z]+$/.test(words[0] ?? "") && !/^[A-Z]/.test(words[1] ?? "")) t = `${first}${t.slice(words[0].length)}`;
  if (ONLY_PREPS.test(t.trim())) return "";
  if (t.length > NOTE_LABEL_CHARS) {
    const cut = t.slice(0, NOTE_LABEL_CHARS + 1);
    // One word longer than the cap has no boundary to cut on: it's cut hard.
    t = /\s/.test(cut) ? cut.replace(/\s+\S*$/, "").replace(/[,;:]$/, "").replace(/(?:\s+(?:on|in|at|for|that|the|a|an|and|to|of|with|near|from|by|or))+$/i, "") : cut.slice(0, NOTE_LABEL_CHARS);
  }
  return t;
}
// The fixed line (Royce, 2026-10-17: "reword it so it works for any goal, and show me the exact line before it ships"; approved by
// Royce 2026-10-17, PR #236). "The search on" reads the same before a thing or a doing, and "paused" is what "pick it back up" undoes.
export function fallbackNote(text: string): string {
  return `I've paused the search on ${fallbackLabel(text) || "this"}; say the word and I'll pick it back up`;
}
// Pure: whether a written note keeps the rules: one line, short, no exclamation point or dash, not a question, and Co never names
// itself by a role (goalOwnership.ts ROLE_NOUN, the one guard for that).
export function noteKeepsRules(line: string): boolean {
  const t = String(line ?? "").trim();
  return !!t && t.length <= 220 && !/\n/.test(t) && !/[!—–]/.test(t) && !ROLE_NOUN.test(t) && !/\?\s*$/.test(t);
}

export type StopNote = { kind: "goal" | "ask"; key: string; line: string; since: Date };
// Pure: the notes still owed, oldest first, each with its stored line (or the fallback): a goal the recheck idled whose note hasn't
// gone, and an ask that idled on its own. An ask that idled with its goal is the goal's note.
export function notesFrom(
  goals: { goalHash: string; goal: string; state: GoalState; reason: string; source: string; toldAt: Date | null; changedAt: Date; idleNote?: string | null }[],
  asks: { id: string; text: string; retiredAt: Date | null; toldAt: Date | null; withGoal?: string | null; note?: string | null }[],
): StopNote[] {
  return [
    ...goals.filter((g) => g.state === "stale" && g.source === "context" && g.reason === RECHECK_IDLE_REASON && !g.toldAt).map((g) => ({ kind: "goal" as const, key: g.goalHash, line: g.idleNote || fallbackNote(g.goal), since: g.changedAt })),
    ...asks.filter((a) => a.retiredAt && !a.toldAt && !a.withGoal).map((a) => ({ kind: "ask" as const, key: a.id, line: a.note || fallbackNote(a.text), since: a.retiredAt! })),
  ].sort((a, b) => a.since.getTime() - b.since.getTime());
}
// Pure: the first note that passes the member fence whole (a line the strip would change is never sent, and never blocks a newer one).
export function firstSurviving(notes: StopNote[], keep: (s: string) => string | null): StopNote | null {
  return notes.find((n) => keep(n.line) === n.line) ?? null;
}
// Pure: the notes a paced text may carry: owed RECHECK_TEXT_AFTER_DAYS (no reply carried them in that long).
export function notesToRide(notes: StopNote[], now: Date): StopNote[] {
  return notes.filter((n) => now.getTime() - n.since.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY);
}
export function noteToRide(notes: StopNote[], now: Date): StopNote | null {
  return notesToRide(notes, now)[0] ?? null;
}
// Pure: whether a sent text carried the note (code wrote it, so it's there word for word).
const flat = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ");
export function noteCarried(sent: string, note: Pick<StopNote, "line">): boolean {
  return flat(sent).includes(flat(note.line));
}
// The proactive types a note may ride in: Co's own companion and offer texts. Never an event-day or in-room text, a lapse or expiry
// notice, or a recheck question about something else.
export const NOTE_RIDES = new Set(["companion", "ask_checkin", "window_followup", "debrief", "event_offer", "network_tease", "loop_check", "goal_checkin", "goal_nudge", "intro_nudge", "commitment_nudge", "deadline_nudge", "calendar_follow", "event_followthrough", "post_call", "goal_closed"]);
// Pure: whether this paced text may carry a note: an allowed type, never a heavy check-in, never while a hard day holds it. moodHeld is
// the capped hold (harness/proactive.ts heldForMood, services/moodHold.ts): the note waits, never dropped, at most the cap.
export function noteMayRide(c: { type: string; payload?: any }, moodHeld: boolean): boolean {
  return NOTE_RIDES.has(c.type) && !c.payload?.heavy && !moodHeld;
}
// Pure: the paced text with the note in it: the last message that isn't a bare link carries it (laneMoves.ts carryLaneNotes).
export function rideAlong(messages: string[], line: string, carry: (draft: string, pending: string[]) => { text: string }): string[] {
  const at = [...messages.keys()].reverse().find((i) => !/^\s*https?:\/\/\S+\s*$/.test(messages[i]));
  if (at === undefined) return messages;
  return messages.map((m, i) => (i === at ? carry(m, [line]).text : m));
}
// Pure: Co's last text before their message, from the conversation as the text route renders it ("Co replied: ..." lines): the run
// of Co lines at the end, so a question in an earlier beat of the same reply counts.
export function lastCoBlock(recentConversation: string): string {
  const lines = String(recentConversation ?? "").split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].startsWith("Co replied: ")) i--;
  const out: string[] = [];
  for (; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith("Co replied: ")) out.unshift(l.slice("Co replied: ".length));
    else if (/^(?:User said|User sent|\[)/.test(l)) break;
    else out.unshift(l);
  }
  return out.join("\n").trim();
}

// ---------- pure: the decision

export type RetireRow = {
  id: string;
  text: string;
  kind: string | null;
  intent: string | null;
  dueAt: Date | null;
  goals: string[];
  askedAt: Date | null;
  hints: number;
  holdUntil: Date | null;
  retiredAt: Date | null;
  toldAt: Date | null;
  // The goal it idled with (its note is the goal's; the goal coming back brings it back).
  withGoal?: string | null;
  // Its stopped-looking line, written when it idled.
  note?: string | null;
};
export type GoalView = { goalHash: string; goal?: string; state: GoalState; reason: string; source: string; toldAt: Date | null; changedAt: Date; recheckAskedAt: Date | null; lastSignalAt: Date | null; idleNote?: string | null };
// text: their own words naming it; reaction: they reacted to a find served for it.
export type AskSignal = { askId: string; at: Date; kind: "text" | "reaction" };
export type RetireInput = {
  asks: RetireRow[];
  goals: GoalView[];
  // This run's goal recheck decisions (goalRecheck.ts recheckDecide): a goal asked about now goes first.
  goalSteps: Pick<RecheckStep, "goalHash" | "action">[];
  now: Date;
  signals: AskSignal[];
  // When any recheck question last went out (a goal's or an ask's): one at a time.
  lastAskAt: Date | null;
  lastExchangeAt: Date | null;
  held: string[];
  pendingText: string[];
};
// wait: the goal's recheck acts first; keep: they want it (held off RETIRE_HOLD_DAYS); unflag: a tied goal came back, re-evaluated on
// the next plan; due: the next natural reply asks; text: one paced text; asked: waiting; idle: no answer, kind help, its note owed;
// idle_with_goal: its goal stopped after the mark, the goal's note covers it.
export type RetireAction = "none" | "wait" | "keep" | "unflag" | "due" | "text" | "asked" | "idle" | "idle_with_goal";
export type RetireStep = { id: string; text: string; action: RetireAction; why: string; signalAt: Date | null; dueAt: Date | null };

const recheckIdle = (g: Pick<GoalView, "state" | "source" | "reason">) => g.state === "stale" && g.source === "context" && g.reason === RECHECK_IDLE_REASON;

export function retireDecide(input: RetireInput): RetireStep[] {
  const { now } = input;
  const latestOf = (askId: string, kinds: AskSignal["kind"][]) =>
    input.signals.filter((s) => s.askId === askId && kinds.includes(s.kind) && s.at <= now).reduce<Date | null>((m, s) => (!m || s.at > m ? s.at : m), null);
  const goalById = new Map(input.goals.map((g) => [g.goalHash, g]));
  const goalStep = new Map(input.goalSteps.map((s) => [s.goalHash, s.action]));
  // A goal whose own question comes first: its recheck due or open, or its set-aside question not yet told.
  const busy = (g: GoalView) =>
    ["due", "text", "asked"].includes(goalStep.get(g.goalHash) ?? "") ||
    (g.state === "active" && recheckAskOpen(g.recheckAskedAt, now)) ||
    (g.state !== "active" && g.source === "context" && !g.toldAt && !recheckIdle(g));
  const stoppedAfter = (g: GoalView, mark: Date) => g.state !== "active" && (!!g.toldAt || recheckIdle(g)) && g.changedAt > mark;
  const steps = input.asks.map((a): RetireStep => {
    const base = { id: a.id, text: a.text, signalAt: null as Date | null, dueAt: null as Date | null };
    if (a.retiredAt) return { ...base, action: "none", why: "retired" };
    if (a.holdUntil && a.holdUntil > now) return { ...base, action: "none", why: "they said keep it" };
    if (!a.dueAt) return { ...base, action: "none", why: "not marked" };
    // Before the question, naming it or reacting to one of its finds keeps it; after, only a reaction (their words are the answer,
    // and a "no" names it too).
    const keptBy = latestOf(a.id, a.askedAt ? ["reaction"] : ["text", "reaction"]);
    if (keptBy && keptBy > a.dueAt) return { ...base, signalAt: keptBy, action: "keep", why: a.askedAt ? "they reacted to a find for it" : "they named it, or reacted to a find for it, since it was marked" };
    const tied = a.goals.map((h) => goalById.get(h)).filter((g): g is GoalView => !!g);
    if (tied.some(busy)) return { ...base, action: "wait", why: "its goal's recheck acts first" };
    if (tied.length && tied.every((g) => stoppedAfter(g, a.dueAt!))) return { ...base, action: "idle_with_goal", why: "its goal stopped being searched after it was marked; that note covers it" };
    if (!a.askedAt && tied.some((g) => g.state === "active" && g.lastSignalAt && g.lastSignalAt > a.dueAt!)) return { ...base, action: "unflag", why: "its goal came back since it was marked; the next plan decides again" };
    if (a.askedAt) {
      // Silence is not rejection (Royce, 2026-11-04): an unanswered question never retires the ask. It stays open and searched; only
      // their word or other evidence (the goal it serves closing on their word) ends it.
      if (now.getTime() - a.askedAt.getTime() >= RECHECK_ANSWER_DAYS * DAY) return { ...base, action: "none", why: `no answer in ${RECHECK_ANSWER_DAYS} days since it was asked: less contact, the ask stays open (and the reply stops carrying the question)` };
      return { ...base, action: "asked", why: "asked; waiting on them" };
    }
    return { ...base, action: "due", dueAt: a.dueAt, why: "marked: it restates a plan of theirs, not something to find" };
  });
  // One question at a time, goals first: a goal asked about this run, or any question (a goal's or an ask's) within
  // RECHECK_TEXT_AFTER_DAYS, holds every ask; otherwise the ask marked longest is the one.
  const goalAsking = input.goalSteps.some((s) => s.action === "due" || s.action === "text");
  const lastAsk = [input.lastAskAt, ...input.asks.filter((a) => !a.retiredAt).map((a) => a.askedAt), ...input.goals.filter((g) => g.state === "active").map((g) => g.recheckAskedAt)].reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);
  const spaced = !lastAsk || now.getTime() - lastAsk.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY;
  const hintsOf = new Map(input.asks.map((a) => [a.id, a.hints]));
  const dues = steps.filter((s) => s.action === "due").sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
  const replyPick = dues.find((s) => (hintsOf.get(s.id) ?? 0) < RECHECK_REPLY_HINTS) ?? null;
  const textPick = dues.find((s) => now.getTime() - s.dueAt!.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY) ?? null;
  for (const s of dues) {
    if (goalAsking) Object.assign(s, { action: "wait" as const, why: "a goal's recheck is asked first" });
    else if (!spaced) Object.assign(s, { action: "none" as const, why: `another recheck went out within ${RECHECK_TEXT_AFTER_DAYS} days` });
    else if (s !== replyPick && s !== textPick) Object.assign(s, { action: "none" as const, why: "one question at a time: another is due longer" });
    else if (s !== replyPick) s.why = `its ${RECHECK_REPLY_HINTS} reply attempts are used; left to the text`;
  }
  const quiet = !input.lastExchangeAt || now.getTime() - input.lastExchangeAt.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY;
  if (!goalAsking && spaced && textPick && quiet) {
    if (input.held.length) textPick.why = `held: ${input.held.join(", ")}`;
    else if (input.pendingText.length) textPick.why = "a recheck text is already waiting";
    else Object.assign(textPick, { action: "text" as const, why: `due ${RECHECK_TEXT_AFTER_DAYS}+ days with no exchange` });
  }
  return steps;
}

// Pure: which marks a whole plan clears: marked, not asked, not marked again this plan, and not tied to a goal set aside from context
// whose question is still to be told (that ask still retires, after the goal is told).
export function marksToClear(asks: Pick<RetireRow, "id" | "dueAt" | "askedAt" | "retiredAt" | "goals">[], flaggedIds: string[], goals: Pick<GoalView, "goalHash" | "state" | "source" | "toldAt">[]): string[] {
  const keepIds = new Set(flaggedIds.map(String));
  const pendingAside = new Set(goals.filter((g) => g.state !== "active" && g.source === "context" && !g.toldAt).map((g) => g.goalHash));
  return asks.filter((a) => a.dueAt && !a.askedAt && !a.retiredAt && !keepIds.has(a.id) && !a.goals.some((h) => pendingAside.has(h))).map((a) => a.id);
}

// Pure: their texts (already fenced) as signals for the asks they name.
export function askTextSignals(lines: { at: Date; text: string }[], asks: Pick<RetireRow, "id" | "text">[]): AskSignal[] {
  return lines.flatMap((l) => asks.filter((a) => mentionsGoal(l.text, a.text)).map((a) => ({ askId: a.id, at: l.at, kind: "text" as const })));
}

// ---------- pure: their answer to the question, and to the note

export function retireAnswerPrompt(askText: string, lastCo: string, reply: string): string {
  return `Cue asks a member of a private club, at most once, whether they still want Cue looking for this: "${askText.slice(0, 300)}".

Cue's last text to them:
"""
${lastCo.slice(0, 1500)}
"""

Their reply:
"""
${reply.slice(0, 1500)}
"""

question_in_last_text: does Cue's last text ask whether they still want Cue looking for that thing (not an offer of something else, not another topic)?
answer: if it does, does their reply say "yes" (keep looking), "no" (stop, or it's no longer needed), or "neither" (about something else, or unclear)? A "no thanks" to something else Cue offered is "neither".

Answer only with JSON: {"question_in_last_text": true or false, "answer": "yes" or "no" or "neither", "reason": "a few words"}`;
}
// Pure: the read, strictly: acted on only when Co's last text asked it and the answer is a plain yes or no.
export function readRetireAnswer(raw: string): "yes" | "no" | "neither" {
  try {
    const j = JSON.parse(String(raw ?? "").replace(/```(?:json)?/g, "").trim());
    if (!j || j.question_in_last_text !== true) return "neither";
    return j.answer === "yes" || j.answer === "no" ? j.answer : "neither";
  } catch {
    return "neither";
  }
}
export function reviveReadPrompt(note: string, lastCo: string, reply: string): string {
  return `Cue told a member of a private club: "${note.slice(0, 300)}"

Cue's last text to them:
"""
${lastCo.slice(0, 1500)}
"""

Their reply:
"""
${reply.slice(0, 1500)}
"""

Does their reply ask Cue to pick that back up and keep looking for it (yes), or not (no: anything else, unclear, or about something different)?

Answer only with JSON: {"revive": true or false, "reason": "a few words"}`;
}
export function readRevive(raw: string): boolean {
  try {
    const j = JSON.parse(String(raw ?? "").replace(/```(?:json)?/g, "").trim());
    return !!j && j.revive === true;
  } catch {
    return false;
  }
}

// The answer and revive reads: Haiku, their own usage names, a short timeout; any failure changes nothing.
const haikuRead = (functionId: string): RecheckJudge => async (prompt) => {
  const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 1500, experimental_telemetry: { isEnabled: true, functionId }, prompt, abortSignal: AbortSignal.timeout(8000) });
  return text;
};
export const haikuRetireAnswer: RecheckJudge = haikuRead("ask.retireAnswer");
export const haikuReviveRead: RecheckJudge = haikuRead("ask.reviveRead");

// ---------- the note, written once when it idles

// Co's own line, in its voice (services/voiceLine.ts), from their words only; the fallback when the read fails or breaks a rule.
export type LineWriter = (ask: import("./voiceLine.js").LineAsk) => Promise<{ text: string; written: boolean }>;
export async function writeStopLine(text: string, write?: LineWriter): Promise<string> {
  const fallback = fallbackNote(text);
  const w = write ?? (await import("./voiceLine.js")).lineInVoice;
  const out = await w({
    purpose: "One short line telling them you've stopped looking for this, and that they can say the word for you to pick it back up. A statement, not a question, no apology, no recap, never naming yourself.",
    facts: [`What you've stopped looking for, in their own words: "${String(text ?? "").slice(0, 200)}"`],
    examples: [fallback],
    fallback,
  }).catch(() => ({ text: fallback, written: false }));
  // Stored without its closing period: the code that carries it ends the sentence (laneMoves.ts carryLaneNotes).
  return out.written && noteKeepsRules(out.text) ? out.text.trim().replace(/[.\s]+$/, "") : fallback;
}
// A goal the recheck idled (goalRecheck.ts realRecheckDeps.idle): its line, stored for the reply or the paced text that carries it.
export async function storeGoalNote(userId: string, goal: string, write?: LineWriter): Promise<void> {
  const line = await writeStopLine(goal, write);
  await pool.query(`UPDATE goal_states SET idle_note = $3 WHERE user_id = $1 AND goal_hash = $2 AND told_at IS NULL`, [userId, goalHash(goal), line]);
}

// ---------- the run (one member)

export type RetireDeps = {
  asks: (userId: string) => Promise<RetireRow[]>;
  goals: (userId: string) => Promise<GoalView[]>;
  texts: (userId: string, days: number) => Promise<{ at: Date; text: string }[] | null>;
  reactions: (userId: string, days: number) => Promise<AskSignal[]>;
  lastAsk: (userId: string) => Promise<Date | null>;
  held: (userId: string) => Promise<string[]>;
  pendingText: (userId: string) => Promise<string[]>;
  keep: (userId: string, row: RetireRow) => Promise<void>;
  unflag: (userId: string, row: RetireRow) => Promise<void>;
  revive: (userId: string, row: RetireRow) => Promise<boolean>;
  reviveGoal: (userId: string, goal: GoalView) => Promise<boolean>;
  // how: "note" its own line is owed (written now); "goal" it idled with that goal (the goal's note covers it); "said" they said stop.
  idle: (userId: string, row: RetireRow, how: { note: true } | { goal: string } | { said: true }) => Promise<boolean>;
  queueText: (userId: string, row: RetireRow) => Promise<boolean>;
  log: (d: { userId: string; decision: string; outcome: "act" | "skip"; action: string; reason?: string | null; proposal: Record<string, unknown> }) => Promise<void>;
};

export async function applyRetireSteps(userId: string, steps: RetireStep[], rows: RetireRow[], goals: GoalView[], deps: Pick<RetireDeps, "keep" | "unflag" | "idle" | "queueText" | "log">, only?: Set<RetireAction>): Promise<void> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const s of steps) {
    if (only && !only.has(s.action)) continue;
    const r = byId.get(s.id);
    if (!r) continue;
    const proposal = { ask: r.text.slice(0, 200), askId: r.id, goals: r.goals, markedAt: r.dueAt, askedAt: r.askedAt, why: s.why };
    const log = (decision: string, outcome: "act" | "skip", action: string) => deps.log({ userId, decision, outcome, action, reason: s.why, proposal }).catch(() => {});
    if (s.action === "keep") { await deps.keep(userId, r).catch(() => {}); await log("ask.retire_kept", "act", "kept"); }
    else if (s.action === "unflag") { await deps.unflag(userId, r).catch(() => {}); await log("ask.retire_due", "skip", "unmarked"); }
    else if (s.action === "idle") { const ok = await deps.idle(userId, r, { note: true }).catch(() => false); await log("ask.retired", ok ? "act" : "skip", ok ? "no_answer" : "not_changed"); }
    else if (s.action === "idle_with_goal") {
      // The goal it goes with: the tied goal that stopped last.
      const g = r.goals.map((h) => goals.find((x) => x.goalHash === h)).filter((x): x is GoalView => !!x).sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())[0];
      const ok = g ? await deps.idle(userId, r, { goal: g.goalHash }).catch(() => false) : false;
      await log("ask.retired", ok ? "act" : "skip", ok ? "with_goal" : "not_changed");
    } else if (s.action === "wait") await log("ask.retire_due", "skip", "waits_for_goal");
    else if (s.action === "due") await log("ask.retire_due", /^held|already waiting/.test(s.why) ? "skip" : "act", /left to the text/.test(s.why) ? "left_to_text" : "ask_in_reply");
    else if (s.action === "text") { const q = await deps.queueText(userId, r).catch(() => false); await log("ask.retire_due", q ? "act" : "skip", q ? "text_queued" : "text_not_queued"); }
  }
}

// The goal sweep's pass for one member, right after the goal recheck (services/goalSweep.ts). goalSteps: this run's goal decisions,
// applied already.
export async function runAskRetire(userId: string, goalSteps: Pick<RecheckStep, "goalHash" | "action">[], now = new Date(), deps: RetireDeps = realRetireDeps): Promise<RetireStep[]> {
  const asks = await deps.asks(userId);
  if (!asks.some((a) => !a.retiredAt)) return [];
  const texts = await deps.texts(userId, RECHECK_LOOKBACK_DAYS).catch(() => null);
  // Their texts couldn't be read through the fence: nothing is decided on a partial picture.
  if (!texts) return [];
  const [goals, reactions, lastAskAt] = await Promise.all([deps.goals(userId).catch(() => []), deps.reactions(userId, RECHECK_LOOKBACK_DAYS).catch(() => []), deps.lastAsk(userId).catch(() => now)]);
  const signals = [...askTextSignals(texts, asks), ...reactions];
  const lastExchangeAt = texts.reduce<Date | null>((m, t) => (!m || t.at > m ? t.at : m), null);
  const textable = asks.some((a) => a.dueAt && !a.askedAt && !a.retiredAt && now.getTime() - a.dueAt.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY);
  const [held, pendingText] = textable ? await Promise.all([deps.held(userId).catch(() => ["their send gates couldn't be read"]), deps.pendingText(userId).catch(() => ["unreadable"])]) : [[], []];
  const steps = retireDecide({ asks, goals, goalSteps, now, signals, lastAskAt, lastExchangeAt, held, pendingText });
  await applyRetireSteps(userId, steps, asks, goals, deps);
  return steps;
}

// The reply's question (services/turnContext.ts): the one ask to raise ("ask"), if no goal question is offered this turn, and any
// already asked, so the reply reads their answer. This message counts as a signal. Fails closed: no fence, nothing.
export async function retireForTurn(userId: string, message: string, fence: import("./sourceFence.js").Fence | null, o: { goalQuestion: boolean; now?: Date }, deps: Pick<RetireDeps, "asks" | "goals" | "reactions" | "lastAsk"> = realRetireDeps): Promise<{ ask: RetireRow | null; asked: RetireRow[] }> {
  const none = { ask: null, asked: [] };
  if (!fence || fence.failed) return none;
  const now = o.now ?? new Date();
  const asks = (await deps.asks(userId)).filter((a) => !a.retiredAt);
  if (!asks.some((a) => a.dueAt)) return none;
  const F = await import("./sourceFence.js");
  const [goals, reactions, lastAskAt] = await Promise.all([deps.goals(userId).catch(() => []), deps.reactions(userId, RECHECK_LOOKBACK_DAYS).catch(() => []), deps.lastAsk(userId).catch(() => now)]);
  const signals = [...askTextSignals(F.fenceTheirTexts(fence, [{ at: now, text: message }]), asks), ...reactions];
  const steps = retireDecide({ asks, goals, goalSteps: o.goalQuestion ? [{ goalHash: "", action: "due" }] : [], now, signals, lastAskAt, lastExchangeAt: now, held: [], pendingText: [] });
  const byId = new Map(asks.map((a) => [a.id, a]));
  const ask = steps.find((s) => s.action === "due" && (byId.get(s.id)!.hints ?? 0) < RECHECK_REPLY_HINTS);
  return { ask: ask ? byId.get(ask.id)! : null, asked: steps.filter((s) => s.action === "asked").map((s) => byId.get(s.id)!) };
}

// After a reply that carried the question went out: asked only when the Haiku read says it asked (fails closed: a hint is used).
export async function noteRetireReply(userId: string, row: Pick<RetireRow, "id" | "text">, sent: string, judge: RecheckJudge = haikuRecheckJudge): Promise<boolean> {
  const read = await judgeRecheckAsked(row.text, sent, judge, "ask");
  if (read.asked) return markRetireAsked(userId, row.id, row.text, "reply");
  await pool.query(`UPDATE ask_checkins SET retire_hints = retire_hints + 1 WHERE id = $1 AND user_id = $2 AND retire_asked_at IS NULL`, [row.id, userId]);
  return false;
}

// Asked means sent; once per mark. Logged as ask.retire_asked, which the one-question spacing reads with goal.recheck_asked.
export async function markRetireAsked(userId: string, id: string, text: string, via: "reply" | "text"): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE ask_checkins SET retire_asked_at = NOW() WHERE id = $1 AND user_id = $2 AND retire_due_at IS NOT NULL AND retire_asked_at IS NULL AND retired_at IS NULL`, [id, userId]);
  if (rowCount) await realRetireDeps.log({ userId, decision: "ask.retire_asked", outcome: "act", action: via, proposal: { ask: text.slice(0, 200), askId: id } }).catch(() => {});
  return !!rowCount;
}

// The text route, as their text arrives (after the reply's path, never a gate on it):
//   - a marked ask not yet asked that they name stays searched (held off RETIRE_HOLD_DAYS)
//   - every ask whose question is out gets its answer read against Co's last text: acted on only when that text asked it; a yes keeps
//     it, a no stops it at their word (nothing more to tell them)
//   - for REVIVE_DAYS after a stopped-looking note went out, a reply that answers the note (or names the thing) gets a revive read:
//     "pick it back up" brings it back (an ask to find, a goal to active, with the asks that idled with it)
export type TextReads = { answer?: RecheckJudge; revive?: RecheckJudge };
export async function noteAskText(userId: string, text: string, o: { lastCoText?: string | null; now?: Date } = {}, deps: RetireDeps = realRetireDeps, reads: TextReads = {}): Promise<void> {
  const now = o.now ?? new Date();
  const lastCo = String(o.lastCoText ?? "");
  const asks = await deps.asks(userId);
  const open = asks.filter((a) => a.askedAt && !a.retiredAt && recheckAskOpen(a.askedAt, now));
  const markedNamed = asks.some((a) => a.dueAt && !a.askedAt && !a.retiredAt && mentionsGoal(text, a.text));
  const recent = (d: Date | null) => !!d && now.getTime() - d.getTime() < REVIVE_DAYS * DAY;
  const toldAsks = asks.filter((a) => a.retiredAt && !a.withGoal && a.toldAt && recent(a.toldAt) && a.note);
  const goals = await deps.goals(userId).catch(() => [] as GoalView[]);
  const toldGoals = goals.filter((g) => recheckIdle(g) && recent(g.toldAt)).map((g) => ({ ...g, idleNote: g.idleNote ?? fallbackNote(g.goal ?? "") }));
  const answersNote = (line: string, about: string) => (lastCo && noteCarried(lastCo, { line })) || mentionsGoal(text, about);
  const reviveAsks = toldAsks.filter((a) => answersNote(a.note!, a.text));
  const reviveGoals = toldGoals.filter((g) => answersNote(g.idleNote!, g.goal ?? ""));
  if (!markedNamed && !open.length && !reviveAsks.length && !reviveGoals.length) return;
  const F = await import("./sourceFence.js");
  const fence = await F.memberFence(userId);
  if (fence.failed) return;
  const lines = F.fenceTheirTexts(fence, [{ at: now, text }]);
  if (!lines.length) return;
  const reply = lines[0].text;
  if (markedNamed) {
    const steps = retireDecide({ asks, goals: [], goalSteps: [], now, signals: askTextSignals(lines, asks), lastAskAt: null, lastExchangeAt: now, held: [], pendingText: [] });
    await applyRetireSteps(userId, steps, asks, [], deps, new Set<RetireAction>(["keep"]));
  }
  // A question needs a question mark in Co's last text; without one there's nothing to answer, and no read.
  if (/\?/.test(lastCo)) {
    for (const a of open) {
      const answer = await (reads.answer ?? haikuRetireAnswer)(retireAnswerPrompt(a.text, lastCo, reply)).then(readRetireAnswer).catch(() => "neither" as const);
      const proposal = { ask: a.text.slice(0, 200), askId: a.id };
      if (answer === "yes") {
        await deps.keep(userId, a).catch(() => {});
        await deps.log({ userId, decision: "ask.retire_kept", outcome: "act", action: "their_yes", proposal }).catch(() => {});
      } else if (answer === "no") {
        const ok = await deps.idle(userId, a, { said: true }).catch(() => false);
        await deps.log({ userId, decision: "ask.retired", outcome: ok ? "act" : "skip", action: ok ? "their_word" : "not_changed", proposal }).catch(() => {});
      }
    }
  }
  for (const a of reviveAsks) {
    if (!(await (reads.revive ?? haikuReviveRead)(reviveReadPrompt(a.note!, lastCo, reply)).then(readRevive).catch(() => false))) continue;
    const ok = await deps.revive(userId, a).catch(() => false);
    await deps.log({ userId, decision: "ask.revived", outcome: ok ? "act" : "skip", action: ok ? "picked_back_up" : "not_changed", proposal: { ask: a.text.slice(0, 200), askId: a.id } }).catch(() => {});
  }
  for (const g of reviveGoals) {
    if (!(await (reads.revive ?? haikuReviveRead)(reviveReadPrompt(g.idleNote!, lastCo, reply)).then(readRevive).catch(() => false))) continue;
    const ok = await deps.reviveGoal(userId, g).catch(() => false);
    await deps.log({ userId, decision: "goal.revived", outcome: ok ? "act" : "skip", action: ok ? "picked_back_up" : "not_changed", proposal: { goal: String(g.goal ?? "").slice(0, 200), goalHash: g.goalHash } }).catch(() => {});
  }
}

// A goal back to active (the recheck's revive, markGoal active, or "pick it back up"): the asks that idled with it come back too.
export async function reviveAsksWithGoal(userId: string, hash: string): Promise<number> {
  const rows = (await realRetireDeps.asks(userId)).filter((a) => a.retiredAt && a.withGoal === hash);
  let n = 0;
  for (const a of rows) if (await realRetireDeps.revive(userId, a).catch(() => false)) n++;
  if (n) await realRetireDeps.log({ userId, decision: "ask.revived", outcome: "act", action: "with_goal", proposal: { goalHash: hash, asks: n } }).catch(() => {});
  return n;
}

// The plan marks it (goalEdges.ts realGoalDeps.helpAsk). A Co-task ask is left exactly as it is (logged, not changed): it's in the
// status-check lane (Royce, 2026-10-13: "isn't a stop and isn't a new ask - it's a status check"), so the search keeps running, no kind
// change and no note; asked about, the reply says where the work stands (services/statusCheck.ts). Otherwise tied to the goals it
// restates and the goal it serves when that goal is active; the first mark's time stays. Never a lookout, never one held by their yes.
export async function flagRetire(userId: string, id: string, intent: string | null, goals: string[]): Promise<void> {
  const { rows } = await pool.query(`SELECT ask_text, serves_goal_id, kind FROM ask_checkins WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) return;
  const text = String(rows[0].ask_text ?? "");
  if (isCoTaskGoal(text)) {
    await realRetireDeps.log({ userId, decision: "ask.retire_skipped", outcome: "skip", action: "co_task_unchanged", reason: "status-check lane: Cue's own work, the search keeps running (no kind change, no note)", proposal: { ask: text.slice(0, 200), askId: id, intent } }).catch(() => {});
    return;
  }
  const tied = new Set(goals.map((g) => goalHash(g)));
  const serves = rows[0].serves_goal_id ? String(rows[0].serves_goal_id) : null;
  if (serves) {
    const p = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
    const entry = (Array.isArray(p.rows[0]?.intent) ? p.rows[0].intent : []).find((e: any) => String(e?.id ?? "") === serves && e?.kind === "goal");
    if (entry?.text) {
      const h = goalHash(String(entry.text));
      const st = await pool.query(`SELECT state FROM goal_states WHERE user_id = $1 AND goal_hash = $2`, [userId, h]);
      if ((st.rows[0]?.state ?? "active") === "active") tied.add(h);
    }
  }
  await pool.query(
    `UPDATE ask_checkins SET retire_due_at = COALESCE(retire_due_at, NOW()), retire_goals = $3::text[]
     WHERE id = $1 AND user_id = $2 AND kind = 'find' AND intent IS NOT DISTINCT FROM $4 AND intent IS DISTINCT FROM 'lookout'
       AND resolved_at IS NULL AND retired_at IS NULL AND (retire_hold_until IS NULL OR retire_hold_until <= NOW())`,
    [id, userId, [...tied], intent],
  );
}
// Each whole plan re-evaluates (marksToClear).
export async function keepRetireFlags(userId: string, ids: string[], deps: Pick<RetireDeps, "asks" | "goals"> = realRetireDeps): Promise<void> {
  const [asks, goals] = await Promise.all([deps.asks(userId), deps.goals(userId)]);
  const clear = marksToClear(asks, ids, goals);
  if (clear.length) await pool.query(`UPDATE ask_checkins SET retire_due_at = NULL, retire_goals = NULL, retire_hints = 0 WHERE user_id = $1 AND id::text = ANY($2::text[]) AND retire_asked_at IS NULL`, [userId, clear]);
}

// The recheck text for an ask, at draft time (harness/proactiveRegistry.ts goal_recheck, payload kind "ask").
export function retireTextCheck(r: RetireRow | null, o: { queuedAt: Date | null; latestText: Date | null | "unreadable"; now: Date }): { ok: true; text: string } | { ok: false; why: string } {
  if (!r || r.kind !== "find" || r.intent === "lookout") return { ok: false, why: "it isn't a find ask any more" };
  if (!r.dueAt || r.retiredAt) return { ok: false, why: "it isn't marked any more" };
  if (r.askedAt) return { ok: false, why: "already asked" };
  if (r.holdUntil && r.holdUntil > o.now) return { ok: false, why: "they said keep it" };
  if (o.latestText === "unreadable") return { ok: false, why: "their texts couldn't be read through the fence" };
  if (o.latestText && o.queuedAt && o.latestText > o.queuedAt) return { ok: false, why: "they've texted since it was queued; the reply raises it" };
  return { ok: true, text: r.text };
}
export async function retireTextStillDue(userId: string, id: string, queuedAt: string | null): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const row = (await realRetireDeps.asks(userId)).find((a) => a.id === id) ?? null;
  const q = queuedAt ? new Date(queuedAt) : null;
  const F = await import("./sourceFence.js");
  const fence = await F.memberFence(userId);
  const minutes = q ? Math.max(1, Math.ceil((Date.now() - q.getTime()) / 60_000)) : 0;
  const latestText = fence.failed ? ("unreadable" as const) : minutes ? (await F.readTheirTexts(fence, minutes, 1)).map((t) => t.at).pop() ?? null : null;
  return retireTextCheck(row, { queuedAt: q, latestText, now: new Date() });
}

// ---------- the notes

export async function pendingStopNotes(userId: string): Promise<StopNote[]> {
  const [g, a] = await Promise.all([
    pool.query(`SELECT * FROM goal_states WHERE user_id = $1 AND state = 'stale' AND source = 'context' AND reason = $2 AND told_at IS NULL`, [userId, RECHECK_IDLE_REASON]),
    pool.query(`SELECT id, ask_text, retired_at, retire_told_at, retired_with_goal, retire_note FROM ask_checkins WHERE user_id = $1 AND retired_at IS NOT NULL AND retire_told_at IS NULL AND retired_with_goal IS NULL AND resolved_at IS NULL`, [userId]),
  ]);
  return notesFrom(
    g.rows.map((r: any) => ({ ...fromStateRow(r), idleNote: r.idle_note ?? null })),
    a.rows.map((r: any) => ({ id: String(r.id), text: String(r.ask_text ?? ""), retiredAt: new Date(r.retired_at), toldAt: null, withGoal: null, note: r.retire_note ?? null })),
  );
}
// The note went out (a reply or a paced text carried it): told, never again. A goal's note also tells the asks that idled with it.
export async function markNotesTold(userId: string, notes: StopNote[], via: "reply" | "text"): Promise<void> {
  for (const n of notes) {
    const r = n.kind === "goal"
      ? await pool.query(`UPDATE goal_states SET told_at = NOW() WHERE user_id = $1 AND goal_hash = $2 AND told_at IS NULL`, [userId, n.key])
      : await pool.query(`UPDATE ask_checkins SET retire_told_at = NOW() WHERE id = $1 AND user_id = $2 AND retire_told_at IS NULL`, [n.key, userId]);
    if (n.kind === "goal" && r.rowCount) await pool.query(`UPDATE ask_checkins SET retire_told_at = NOW() WHERE user_id = $1 AND retired_with_goal = $2 AND retire_told_at IS NULL`, [userId, n.key]);
    if (r.rowCount) await realRetireDeps.log({ userId, decision: n.kind === "goal" ? "goal.stop_note" : "ask.stop_note", outcome: "act", action: via, proposal: { line: n.line, key: n.key } }).catch(() => {});
  }
}

// ---------- real deps

const toRetireRow = (r: any): RetireRow => ({
  id: String(r.id), text: String(r.ask_text ?? ""), kind: r.kind ?? null, intent: r.intent ?? null,
  dueAt: r.retire_due_at ? new Date(r.retire_due_at) : null, goals: Array.isArray(r.retire_goals) ? r.retire_goals.map(String) : [],
  askedAt: r.retire_asked_at ? new Date(r.retire_asked_at) : null, hints: Number(r.retire_hints ?? 0),
  holdUntil: r.retire_hold_until ? new Date(r.retire_hold_until) : null, retiredAt: r.retired_at ? new Date(r.retired_at) : null,
  toldAt: r.retire_told_at ? new Date(r.retire_told_at) : null, withGoal: r.retired_with_goal ?? null, note: r.retire_note ?? null,
});

export const realRetireDeps: RetireDeps = {
  // Open asks that are marked, or that this flow retired (a reply to the note can bring those back). Never a lookout.
  asks: async (userId) =>
    (await pool.query(
      `SELECT id, ask_text, kind, intent, retire_due_at, retire_goals, retire_asked_at, retire_hints, retire_hold_until, retired_at, retire_told_at, retired_with_goal, retire_note
         FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND intent IS DISTINCT FROM 'lookout'
          AND ((retire_due_at IS NOT NULL AND kind = 'find') OR (retired_at IS NOT NULL AND kind = 'help'))`,
      [userId],
    )).rows.map(toRetireRow),
  goals: async (userId) =>
    (await pool.query(`SELECT * FROM goal_states WHERE user_id = $1`, [userId])).rows.map((r: any) => {
      const g = fromStateRow(r);
      return { goalHash: g.goalHash, goal: g.goal, state: g.state, reason: g.reason, source: g.source, toldAt: g.toldAt, changedAt: g.changedAt, recheckAskedAt: g.recheckAskedAt ?? null, lastSignalAt: g.lastSignalAt ?? null, idleNote: r.idle_note ?? null };
    }),
  texts: (userId, days) => realRecheckDeps.texts(userId, days),
  // A reaction to a find served for this ask (its candidate names the ask).
  reactions: async (userId, days) => {
    const { rows } = await pool.query(
      `SELECT r.reacted_at, pc.payload->>'askId' AS ask_id
         FROM revealed_offers r
         JOIN proactive_candidates pc ON pc.user_id = r.user_id AND pc.type = 'event_offer' AND pc.status = 'sent'
          AND lower(pc.payload->'match'->>'name') = lower(r.item_name)
        WHERE r.user_id = $1 AND r.reacted_at IS NOT NULL AND r.reacted_at > NOW() - ($2 || ' days')::interval AND pc.payload->>'askId' <> 'profile'`,
      [userId, String(days)],
    );
    return rows.map((x: any) => ({ askId: String(x.ask_id), at: new Date(x.reacted_at), kind: "reaction" as const }));
  },
  lastAsk: (userId) => realRecheckDeps.lastAsk(userId),
  held: (userId) => realRecheckDeps.held(userId),
  pendingText: (userId) => realRecheckDeps.pendingText(userId),
  keep: async (userId, row) => {
    await pool.query(
      `UPDATE ask_checkins SET retire_hold_until = NOW() + ($3 || ' days')::interval, retire_due_at = NULL, retire_goals = NULL, retire_asked_at = NULL, retire_hints = 0 WHERE id = $1 AND user_id = $2`,
      [row.id, userId, String(RETIRE_HOLD_DAYS)],
    );
  },
  unflag: async (userId, row) => {
    await pool.query(`UPDATE ask_checkins SET retire_due_at = NULL, retire_goals = NULL, retire_hints = 0 WHERE id = $1 AND user_id = $2 AND retire_asked_at IS NULL`, [row.id, userId]);
  },
  // Searched again: kind find through the one kind write, then held off RETIRE_HOLD_DAYS.
  revive: async (userId, row) => {
    const { setAskKind } = await import("./laneMoves.js");
    const ok = await setAskKind(pool, { id: row.id, userId, read: { kind: row.kind, intent: row.intent }, kind: "find" }).catch(() => false);
    if (ok) await pool.query(`UPDATE ask_checkins SET retired_at = NULL, retire_told_at = NULL, retired_with_goal = NULL, retire_note = NULL, retire_due_at = NULL, retire_goals = NULL, retire_asked_at = NULL, retire_hints = 0, retire_hold_until = NOW() + ($3 || ' days')::interval WHERE id = $1 AND user_id = $2`, [row.id, userId, String(RETIRE_HOLD_DAYS)]);
    return ok;
  },
  // A goal the note stopped, picked back up: active again (only while it's still idle from the recheck), with its asks.
  reviveGoal: async (userId, g) => {
    const { rowCount } = await pool.query(
      `UPDATE goal_states SET state = 'active', reason = 'they asked to pick it back up', source = 'member', changed_at = NOW(), told_at = NOW(), hints = 0, last_signal_at = NOW(), recheck_asked_at = NULL
       WHERE user_id = $1 AND goal_hash = $2 AND state = 'stale' AND source = 'context' AND reason = $3`,
      [userId, g.goalHash, RECHECK_IDLE_REASON],
    );
    if (rowCount) await reviveAsksWithGoal(userId, g.goalHash).catch(() => 0);
    return !!rowCount;
  },
  // No longer searched: kind help through the one kind write (laneMoves.ts setAskKind), only while it's still the find ask it was read
  // as. Its own note is written now; with a goal, the goal's note covers it (told when that is); at their word, nothing to tell.
  idle: async (userId, row, how) => {
    const { setAskKind } = await import("./laneMoves.js");
    const ok = await setAskKind(pool, { id: row.id, userId, read: { kind: row.kind, intent: row.intent }, kind: "help" }).catch(() => false);
    if (!ok) return false;
    if ("note" in how) {
      const line = await writeStopLine(row.text);
      await pool.query(`UPDATE ask_checkins SET retired_at = NOW(), retire_told_at = NULL, retired_with_goal = NULL, retire_note = $3 WHERE id = $1 AND user_id = $2`, [row.id, userId, line]);
    } else if ("goal" in how) {
      await pool.query(`UPDATE ask_checkins SET retired_at = NOW(), retire_told_at = NULL, retired_with_goal = $3 WHERE id = $1 AND user_id = $2`, [row.id, userId, how.goal]);
    } else {
      await pool.query(`UPDATE ask_checkins SET retired_at = NOW(), retire_told_at = NOW(), retired_with_goal = NULL WHERE id = $1 AND user_id = $2`, [row.id, userId]);
    }
    return true;
  },
  queueText: async (userId, row) => {
    const { enqueueCandidate } = await import("../harness/proactive.js");
    const { localDay, memberZone } = await import("./memberTime.js");
    const zone = await memberZone(userId).catch(() => null);
    const r = await enqueueCandidate({
      userId,
      type: "goal_recheck",
      targetKey: `goal_recheck:ask:${row.id}:${localDay(new Date(), zone)}`,
      topicKey: `ask:${row.id}`,
      summary: `Ask once whether they still want Cue looking for "${row.text.slice(0, 60)}"`,
      payload: { kind: "ask", askId: row.id, text: row.text.slice(0, 300), queuedAt: new Date().toISOString() },
      dueAt: new Date(),
      expiresAt: new Date(Date.now() + RECHECK_TEXT_AFTER_DAYS * DAY),
    });
    return !!r.queued;
  },
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 7, decision: d.decision, userId: d.userId, outcome: d.outcome, action: d.action, reason: d.reason ?? null, proposal: d.proposal });
  },
};
