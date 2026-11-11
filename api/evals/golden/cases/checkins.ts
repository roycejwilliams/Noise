// Golden check-in cases (Royce, 2026-10-14: "Fix how Co handles check-ins and casual openers"). One real reply turn each, the way
// evals/golden/cases/reply.ts runs one: the turn read, the reply agent with its tools, the fact check, no database, nothing sent. The
// member's world is built by the real builder (services/memberWorld.ts buildMemberWorld) from fixture state and put on the reply's
// facts by the real wiring (harness/replyGrounding.ts addMemberWorld, which gatherReplyFacts calls), so a change to either is tested
// here. Every case pins its own clock (never the real one): the daytime cases run at 2:00pm Tuesday Pacific, the late-night case at
// 12:04am. Invented members only (Jordan, Noor, Ellis). Mechanical facts are regexes; tone (soft register, one breath, no re-greeting)
// is one short judge (GRADER_HEADERS).
import "../../lib/requireMeter.js";
import { DateTime } from "luxon";
import type { GoldenCase, GoldenResult } from "../types.js";
import { result } from "../types.js";
import { goldenSnapshot } from "../snapshot.js";
import { captureSends, linesOf, noteReply } from "../replies.js";
import { turnKind, type Send, type TurnKind } from "../../lib/hardRules.js";

const ZONE = "America/Los_Angeles";
export const DAY = new Date("2026-10-13T21:00:00Z"); // Tue Oct 13, 2:00pm Pacific (the replay harness's pinned clock)
const LATE = new Date("2026-10-14T07:04:48Z"); // Wed Oct 14, 12:04am Pacific (the 10-14 failure)
export const member = (firstName: string) => ({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName });

export type Kind = "known" | "did_before" | "scheduled" | "ongoing" | "unknown";
export type Line = { at: Date; from: "member" | "co"; text: string };
export type Scene = {
  firstName: string;
  now: Date;
  exchange: Line[];
  searching?: { asks: string[]; goals: string[]; held: string[] };
  sent?: { name: string; sentAt: Date; endsOn?: string | null }[];
  threads?: { text: string; line: string }[];
  facts?: [Kind, string][];
  message: string;
  // What kind of turn this is for the hard rules (evals/lib/hardRules.ts); read from the message when not given.
  kind?: TurnKind;
  // The moment read wired the way the text route wires it (routes/sendblue.ts: replyFacts.moment and momentInstruction). Off for the
  // cases recorded before it (their recorded requests carry no moment line).
  withMoment?: boolean;
  // The whole exchange wired the way the text route wires it (routes/sendblue.ts: the record into the read, its lines into this turn's
  // instructions, the record to the draft check). Off for the cases recorded before it (their recorded read carries no record).
  withExchange?: { sent?: { name: string; url: string | null }[]; asks?: string[]; closed?: { label: string; how: "solved" | "dropped" }[] };
  // What the stubbed event search returns this turn (agent/loopTools.ts StubEvent), and their links as the turn's finds for the
  // link-then-caption hard rule. Without it the search comes back empty, as before.
  stubEvents?: import("../../../src/agent/loopTools.js").StubEvent[];
};
// reacted: Co answered with a reaction move (a tapback, or leaving it at one) instead of a text: Co's choice (tapbacks are quiet).
export type Reply = { text: string; tools: string[]; checked: string[]; world: string; reacted: boolean; sends: Send[] };
const REACTION_TOOLS = ["reactInsteadOfReplying", "leaveItAtReaction"];

export const NONE = { asks: [] as string[], goals: [] as string[], held: [] as string[] };
const SEQUIN = { asks: [] as string[], goals: ["a rooftop venue for the Sequin AI launch party"], held: [] as string[] };
const FELLOWSHIP = "Harbor Light Fellowship";
// Yesterday afternoon's thread, then Co's 5:30pm send ending on a question, never answered (the 10-13 shape).
const SENT_AT = new Date("2026-10-13T00:30:40Z");
export const THREAD_BEFORE: Line[] = [
  { at: new Date("2026-10-12T23:04:00Z"), from: "member", text: "Which of those dinners is better for me?" },
  { at: new Date("2026-10-12T23:04:38Z"), from: "co", text: "The Thursday one. Small tables, no pitching." },
  { at: new Date("2026-10-12T23:05:56Z"), from: "member", text: "Gotcha" },
];
const FELLOWSHIP_SEND: Line[] = [
  { at: new Date("2026-10-13T00:30:37Z"), from: "co", text: "https://harborlight.example/fellowship" },
  { at: new Date("2026-10-13T00:30:37Z"), from: "co", text: "Harbor Light Fellowship just opened applications for its second cohort. It's an 8-week program for full-time founders with $75K on incorporation, a fit while you're weighing funding." },
  { at: new Date("2026-10-13T00:30:37Z"), from: "co", text: "Worth a look before you decide on funding timing?" },
];
const FELLOWSHIP_FACTS: [Kind, string][] = [
  ["did_before", `Cue sent them "${FELLOWSHIP}" (https://harborlight.example/fellowship) on Mon Oct 12 at 5:30pm, with: "Harbor Light Fellowship just opened applications for its second cohort. It's an 8-week program for full-time founders with $75K on incorporation." They haven't reacted to it.`],
  ["known", `Details on file for "${FELLOWSHIP}", which Cue sent them: an 8-week fellowship for full-time founders; $75K on incorporation; applications are open for its second cohort; application deadline Dec 15, 2026. Not on file: how many are accepted.`],
];

// One real reply turn, as production builds it: profile line, today and the timeline in their zone at the case's clock, the
// running-work line, the member's world, the case's facts, the read's notes.
export async function reply(s: Scene): Promise<Reply> {
  const { runConversationReplyAgent } = await import("../../../src/agent/conversationReply.js");
  const G = await import("../../../src/harness/replyGrounding.js");
  const R = await import("../../../src/services/readTurn.js");
  const M = await import("../../../src/services/memberWorld.js");
  const T = await import("../../../src/services/timeline.js");
  const searching = s.searching ?? NONE;
  const snapshot = await goldenSnapshot({ ...member(s.firstName), city: "San Francisco", zone: ZONE });
  const facts = G.baseReplyFacts(undefined, snapshot);
  G.addFact(facts, "known", G.todayFact(ZONE, s.now));
  G.addFact(facts, "known", T.renderTimeline(DateTime.fromJSDate(s.now).setZone(ZONE), []));
  for (const f of G.ongoingFactsFor(searching.asks.map((text) => ({ text, kind: "find" as const })))) G.addFact(facts, f.kind, f.text);
  G.addFact(facts, "known", G.runningWorkLine([], [], searching));
  for (const [kind, text] of s.facts ?? []) G.addFact(facts, kind as any, text);
  const world = M.buildMemberWorld({ now: s.now, zone: ZONE, keep: (x) => x, tasks: [], briefs: [], searching, ahead: null, offeredGoals: [], threads: s.threads ?? [], exchange: s.exchange, sent: s.sent ?? [], activity: s.exchange.filter((l) => l.from === "member").map((l) => l.at), safetyHold: false, letPass: [] });
  G.addMemberWorld(facts, world);
  const recent = s.exchange
    .filter((l) => s.now.getTime() - l.at.getTime() < 3 * 86_400_000)
    .map((l) => `${l.from === "member" ? "User said" : "Co replied"}: ${l.text}`)
    .join("\n");
  const X = s.withExchange ? await import("../../../src/services/exchangeRecord.js") : null;
  const base = X && s.withExchange ? { done: X.doneFrom(recent, s.withExchange.sent ?? []), unresolved: X.unresolvedFrom({ asks: (s.withExchange.asks ?? []).map((text) => ({ text })), closed: s.withExchange.closed ?? [] }), priorMeant: [] } : null;
  const read: any = await R.readTurn({ message: s.message, recentConversation: recent, openItems: [] }, null, null, base ? { record: base } : {}).catch(() => null);
  if (X && base) {
    facts.exchange = { ...base, read: read?.exchange ?? null };
    const lines = X.recordLines(facts.exchange);
    if (lines) G.addInstruction(facts, lines);
  }
  if (read?.aboutCo) G.addInstruction(facts, R.ABOUT_CO_INSTRUCTION);
  const note = R.feedbackInstruction(read?.feedback ?? []);
  if (note) G.addInstruction(facts, note);
  // As production sets them (routes/sendblue.ts): the check's feedback turn reads the pushback and the read's feedback with the mode.
  facts.feedbackNoted = !!read?.feedback?.length;
  if (s.withMoment && read?.moment) {
    const D = await import("../../../src/services/connectDots.js");
    facts.moment = read.moment.mode ?? null;
    facts.pushback = read.moment.pushback ?? null;
    const m = D.momentInstruction(read.moment);
    if (m) G.addInstruction(facts, m);
  }
  const { value: r, sends } = await captureSends<any>(() => runConversationReplyAgent(
    { ackSent: null, ...member(s.firstName), resolvedContent: s.message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: recent, snapshot, personaPrompt: null, sendCoReply: async () => true },
    // What Cue sent before stands as the turn's referents (diagnosis 2026-11-11: with none, the past-find link guards, findGuards.ts
    // unlinkedPastFinds and the plain-text link-first send, could never fire in a golden case).
    { dryRun: true, record: false, stubSearch: true, ...(s.stubEvents ? { stubEvents: s.stubEvents } : {}), ...(s.withExchange?.sent?.length ? { dryRunReferents: s.withExchange.sent } : {}) },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}`, toolsCalled: [], grounding: [] })));
  const thread = linesOf(recent);
  noteReply({ text: String(r.replyText ?? ""), sends, tools: r.toolsCalled ?? [], kind: s.kind ?? turnKind(s.message, s.withMoment ? read?.moment?.mode : null), facts: s.stubEvents ? `${G.renderReplyFacts(facts)}\n${s.stubEvents.map((e) => `${e.name} ${e.url} ${e.lines.join(" ")}`).join("\n")}` : G.renderReplyFacts(facts), theirLines: [s.message, ...thread.theirs], coLines: thread.cue, firstName: s.firstName, message: s.message, recent, ...(s.stubEvents ? { findUrls: s.stubEvents.map((e) => e.url) } : {}) });
  const checked = (r.grounding ?? []).filter((g: any) => g.outcome && g.outcome !== "as_drafted" && g.outcome !== "unchecked").map((g: any) => `${g.outcome}: ${(g.checks ?? []).filter((x: any) => !x.pass || x.name === "world_line").map((x: any) => x.reason ?? x.name).join(" | ").slice(0, 200)}`);
  const tools: string[] = r.toolsCalled ?? [];
  return { text: String(r.replyText ?? ""), tools, checked, world: M.memberWorldFact(world), reacted: tools.some((t) => REACTION_TOOLS.includes(t)), sends };
}

// One yes/no question about the reply, quoted. A failed or unparsed judge is a miss, never a pass.
export async function judge(text: string, context: string, question: string): Promise<{ yes: boolean; reason: string }> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { MODELS, GRADER_HEADERS } = await import("../../../src/models.js");
  const { parseModelJson } = await import("../../../src/services/modelJson.js");
  try {
    const { text: out } = await generateText({
      model: anthropic(MODELS.haiku),
      headers: GRADER_HEADERS,
      maxOutputTokens: 300,
      prompt: `You grade one text a companion called Cue sent a member of a private club.\n\nThe situation: ${context}\n\nCue's text:\n"""${text}"""\n\n${question}\n\nReturn ONLY JSON: {"answer": "yes" | "no", "reason": "one short line quoting the words that decide it"}`,
    });
    const j = parseModelJson<{ answer?: string; reason?: string }>(out);
    return { yes: /^yes$/i.test(String(j.answer ?? "")), reason: String(j.reason ?? "") };
  } catch (e: any) {
    return { yes: false, reason: `judge failed: ${e?.message ?? e}` };
  }
}

export const observed = (r: Reply) => `${r.text}${r.tools.length ? `  [tools ${r.tools.join(",")}]` : ""}${r.checked.length ? `  [fact check ${r.checked.join(" || ")}]` : ""}`;
const done = (misses: string[], r: Reply): GoldenResult => result(misses, observed(r));

// Co's machinery said aloud, a list, or a voice slip: never in a check-in reply.
export function voiceMisses(text: string): string[] {
  const m: string[] = [];
  if (!text.trim() || /^ERROR /.test(text)) m.push(`no reply (${text.slice(0, 80)})`);
  if (/\bon my end\b|\bmy (systems?|pipeline|backend|queue)\b|\bnothing new\b/i.test(text)) m.push("narrates Cue's own machinery");
  if (/^\s*(?:[-*•]|\d+[.)])\s/m.test(text)) m.push("a list");
  if (/[—–]/.test(text)) m.push("an em or en dash");
  if (/!/.test(text)) m.push("an exclamation point");
  if (/\b(your|an?) (assistant|concierge)\b|copatible/i.test(text)) m.push("a role noun or the old brand");
  // Cue never goes by its old name or its old partner's (the rename, 2026-10-14).
  if (/\bCo\b|\bMo\b/.test(text)) m.push("calls itself Co (or names Mo)");
  return m;
}
const ONE_BREATH = "Is it one breath: a short, conversational reply (presence plus at most ONE item of their world), with no list, no status report, and no rundown of several things?";

// Case 27's grade: the fellowship as something there for them, never an answer they owe (Royce: never phrase a wait as a debt). The
// 10-14 recording's "Still waiting to hear what you think on the Harbor Light fellowship" must fail it.
const OWES = /\b(still )?waiting (to hear|on you|for you|on your)|waiting to hear (what|from) you|haven'?t heard (back )?from you|get back to me|let me know what you think|your (answer|reply|take) on\b/i;
export async function grade27(text: string): Promise<string[]> {
  const misses = voiceMisses(text);
  if (!/Harbor Light|fellowship/i.test(text)) misses.push("doesn't name the fellowship waiting on them");
  if (/rooftop|Sequin/i.test(text)) misses.push("brings up the running search too (one item: what waits on them leads)");
  if (OWES.test(text)) misses.push("treats the wait as an answer they owe Cue");
  const j = await judge(text, `It's 2pm. Yesterday at 5:30pm Cue sent the member the ${FELLOWSHIP} and asked "Worth a look before you decide on funding timing?"; they never answered. Cue's daily search is also looking for a rooftop venue. The member texted "Just checking in".`, `Does the text give presence AND bring up the ${FELLOWSHIP} as the one item, as something there for them to pick up if they want, WITHOUT implying they owe Cue an answer or that Cue is waiting on them (no "still waiting to hear what you think", no "get back to me"), and without a status report? ${ONE_BREATH} Answer yes only if all of that holds.`);
  if (!j.yes) misses.push(`judge: ${j.reason}`);
  return misses;
}
// Case 28's grade: presence and an open question only (Royce: "pure presence is right ... Never a dashboard dump"). The 10-14
// recording's "Nothing waiting on you right now, just the Thursday dinner on your radar" must fail it.
const SAYS_EMPTY = /\bnothing (is |'?s )?(waiting|running|pending|new|on (my|your) (end|plate|radar|list))\b|\bno(thing)? (updates?|news) (from|on) (me|my end)\b|\bon your radar\b|\ball quiet\b/i;
export async function grade28(text: string): Promise<string[]> {
  const misses = voiceMisses(text);
  if (/\b(search|searching|looking (for|into)|working on|task|running|on file)\b/i.test(text)) misses.push("talks about work or searches with nothing running");
  if (SAYS_EMPTY.test(text)) misses.push("says nothing is waiting or running, or lists what's on their plate (a dashboard line)");
  if (!text.includes("?")) misses.push("no open question");
  const j = await judge(text, "Nothing is running for the member and nothing from Cue is waiting on them. They texted \"Hey cue, just checking in\".", "Is the text ONLY warm presence plus an open question inviting them to share what's on their mind? Answer no if it mentions that nothing is waiting or running, gives any status, lists or names things on their plate (plans, dinners, events), or invents anything about their plans.");
  if (!j.yes) misses.push(`judge: ${j.reason}`);
  return misses;
}

export const CASES: GoldenCase[] = [
  {
    n: 26,
    id: "checkin-work-running",
    title: "\"Just checking in\" at 2pm with a search running: presence plus the one line naming it",
    status: { live: true },
    from: "Royce, 2026-10-14, golden case (1): a check-in with work running gets the one-liner naming it",
    run: async () => {
      const r = await reply({ firstName: "Jordan", now: DAY, exchange: THREAD_BEFORE, searching: SEQUIN, message: "Just checking in" });
      const misses = voiceMisses(r.text);
      if (!/rooftop|Sequin|launch/i.test(r.text)) misses.push("doesn't name the rooftop search for the Sequin launch");
      const j = await judge(r.text, `It's 2pm. Cue's daily search is looking for ${SEQUIN.goals[0]} for the member; nothing else is pending. The member texted "Just checking in".`, `Does the text give presence (a warm hello back) AND mention the rooftop venue search for the Sequin AI launch party as the one thing from their world? ${ONE_BREATH} Answer yes only if both hold.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 27,
    id: "checkin-waiting-on-them",
    title: "\"Just checking in\" at 2pm with a fellowship question of Cue's unanswered: names that, ahead of the running search",
    status: { live: true },
    from: "Royce, 2026-10-14, golden case (2), the 10-14 failure in daylight: Founder Fellows sent at 5:30pm ending on a question he never answered",
    run: async () => {
      const r = await reply({ firstName: "Noor", now: DAY, exchange: [...THREAD_BEFORE, ...FELLOWSHIP_SEND], sent: [{ name: FELLOWSHIP, sentAt: SENT_AT, endsOn: "2026-12-15" }], searching: SEQUIN, facts: FELLOWSHIP_FACTS, message: "Just checking in" });
      return done(await grade27(r.text), r);
    },
  },
  {
    n: 28,
    id: "checkin-nothing",
    title: "\"Hey cue, just checking in\" with nothing running and nothing waiting: presence and an open question only",
    status: { live: true },
    from: "Royce, 2026-10-14, golden case (3): \"the warmth isn't the bug, skipping the check is\"; genuinely nothing gets presence only",
    run: async () => {
      const r = await reply({ firstName: "Ellis", now: DAY, exchange: THREAD_BEFORE, searching: NONE, message: "Hey cue, just checking in" });
      return done(await grade28(r.text), r);
    },
  },
  {
    n: 29,
    id: "checkin-late-night",
    title: "\"Just checking in\" at 12:04am with the fellowship question waiting: the soft, open register first",
    status: { live: true },
    from: "Royce, 2026-10-14, golden case (4), the real failure: 12:04am \"Hey co\" / \"Just checking in\" (opened with \"Hey cue\" since the rename) got \"Good to hear from you.\"",
    run: async () => {
      const exchange: Line[] = [
        ...THREAD_BEFORE.map((l) => ({ ...l, at: new Date(l.at.getTime() + 86_400_000) })),
        ...FELLOWSHIP_SEND.map((l) => ({ ...l, at: new Date(l.at.getTime() + 86_400_000) })),
        { at: new Date("2026-10-14T07:04:20Z"), from: "member", text: "Hey cue" },
        { at: new Date("2026-10-14T07:04:32Z"), from: "co", text: "Hey Noor. What's up?" },
      ];
      const r = await reply({ firstName: "Noor", now: LATE, exchange, sent: [{ name: FELLOWSHIP, sentAt: new Date(SENT_AT.getTime() + 86_400_000), endsOn: "2026-12-15" }], searching: SEQUIN, facts: FELLOWSHIP_FACTS.map(([k, t]) => [k, t.replace("Mon Oct 12", "Tue Oct 13")] as [Kind, string]), message: "Just checking in" });
      const misses = voiceMisses(r.text);
      if (!r.text.trim() || /^good to hear from you\.?$/i.test(r.text.trim())) misses.push("dead air: presence alone with their world waiting");
      // Review of #310: late-night care is care only. The line this case was written against never opens it, and no business follows.
      if (/^\W*good to hear from you/i.test(r.text.trim())) misses.push("opens on the line the case was written against");
      if (/fellowship|harbor light|funding|deadline|appl(y|ication)/i.test(r.text)) misses.push("a business nudge on a late-night check-in");
      const j = await judge(r.text, `It's 12:04am for the member. They texted "Hey cue", Cue said "Hey Noor. What's up?", and now they texted "Just checking in". At 5:30pm Cue had sent them the ${FELLOWSHIP} with a question they never answered.`, "Is the text care only, shaped by the hour: it opens soft (noticing it's late, or asking gently if everything's ok or what's keeping them up), and nothing after that care brings up the fellowship, an opportunity, a deadline, a status or anything for them to act on? Answer no if any business or nudge follows the care.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 30,
    id: "checkin-live-thread",
    title: "\"Just checking in\" with a live thread (waiting on a venue): the reply connects to it",
    status: { live: true },
    from: "Royce, 2026-10-14, golden case (5): \"Good to hear from you - still nothing back from that venue\" beats a generic status line",
    run: async () => {
      const thread = "Waiting to hear back from the Hayes Valley venue about the Nov 14 dinner";
      const exchange: Line[] = [
        { at: new Date("2026-10-12T19:10:00Z"), from: "member", text: "Emailed the Hayes Valley place about the 14th. Fingers crossed they get back to me." },
        { at: new Date("2026-10-12T19:10:40Z"), from: "co", text: "Good call reaching out early. Tell me what they say." },
        { at: new Date("2026-10-12T19:12:00Z"), from: "member", text: "Will do" },
      ];
      const r = await reply({ firstName: "Ellis", now: DAY, exchange, searching: NONE, threads: [{ text: thread, line: `${thread} (said Mon Oct 12)` }], message: "Just checking in" });
      const misses = voiceMisses(r.text);
      if (!/venue|Hayes|dinner|14th|Nov(ember)? 14/i.test(r.text)) misses.push("doesn't connect to the venue thread");
      // Only the member knows whether the venue answered: Co asks, it never reports it.
      if (!r.text.includes("?")) misses.push("states where the venue stands instead of asking");
      const j = await judge(r.text, `Yesterday the MEMBER emailed a Hayes Valley venue about their Nov 14 dinner and said they were waiting to hear back; Cue has no way to know whether the venue has answered them since. Nothing else is running or pending. They texted "Just checking in".`, `Does the text give presence AND pick up the venue thread by ASKING the member whether they've heard back (not stating it as fact), naturally, the way a friend who remembered would? ${ONE_BREATH} Answer yes only if all of that holds.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 31,
    id: "checkin-tell-me-more",
    title: "\"Tell me more\" after a check-in named the fellowship: expands it, no re-greeting",
    status: { live: true },
    from: "Royce, 2026-10-14, golden case (6): a follow-up \"tell me more\" expands without re-greeting",
    run: async () => {
      const exchange: Line[] = [
        ...THREAD_BEFORE,
        ...FELLOWSHIP_SEND,
        { at: new Date("2026-10-13T20:58:00Z"), from: "member", text: "Just checking in" },
        { at: new Date("2026-10-13T20:58:15Z"), from: "co", text: "Good to hear from you. Harbor Light Fellowship is there whenever you want it." },
      ];
      const r = await reply({ firstName: "Noor", now: DAY, exchange, sent: [{ name: FELLOWSHIP, sentAt: SENT_AT, endsOn: "2026-12-15" }], searching: SEQUIN, facts: FELLOWSHIP_FACTS, message: "Tell me more" });
      const misses = voiceMisses(r.text);
      if (/^\s*(hey|hi|hello|good to hear|good to see|nice to hear)\b/i.test(r.text)) misses.push("greets again");
      if (!/8-week|8 week|eight-week|\$75K|75K|Dec(ember)? 15|second cohort|full-time founders/i.test(r.text)) misses.push("doesn't expand with the fellowship's details on file");
      if (/rooftop|Sequin/i.test(r.text)) misses.push("switches to another item");
      const j = await judge(r.text, `Cue's last text was "Good to hear from you. ${FELLOWSHIP} is there whenever you want it." The member replied "Tell me more". On file: an 8-week fellowship for full-time founders, $75K on incorporation, second cohort open, deadline Dec 15.`, `Does the text expand on the ${FELLOWSHIP} with what's on file, picking up straight from the last message WITHOUT greeting them again or restarting the conversation? Answer yes only if both hold.`);
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 32,
    id: "checkin-thread-echo",
    title: "\"Hayes Valley just confirmed! What should I sort out next?\": Cue saying their own news back (\"Great that Hayes Valley confirmed\") is kept, never cut as a status report",
    status: { live: true },
    from: "Third review of the check-in PR, 2026-10-14: the thread guard must keep an echo of what the member told Cue",
    run: async () => {
      const thread = "Waiting to hear back from the Hayes Valley venue about the Nov 14 dinner";
      // Asks for words, so a text reply is called for (a bare "just confirmed!" drew a tapback first in 3 of 3 live runs, 2026-10-14).
      const message = "Hayes Valley just confirmed! What should I sort out next for the 14th?";
      const exchange: Line[] = [
        { at: new Date("2026-10-12T19:10:00Z"), from: "member", text: "Emailed the Hayes Valley place about the 14th. Fingers crossed they get back to me." },
        { at: new Date("2026-10-12T19:10:40Z"), from: "co", text: "Good call reaching out early. Tell me what they say." },
        { at: new Date("2026-10-13T20:59:30Z"), from: "member", text: message },
      ];
      const threads = [{ text: thread, line: `${thread} (said Mon Oct 12)` }];
      // The read itself, on Co's own sentence: a yes here would cut it.
      const G = await import("../../../src/harness/replyGrounding.js");
      const M = await import("../../../src/services/memberWorld.js");
      const world = M.buildMemberWorld({ now: DAY, zone: ZONE, keep: (x) => x, tasks: [], briefs: [], searching: NONE, ahead: null, offeredGoals: [], threads, exchange, sent: [], activity: exchange.filter((l) => l.from === "member").map((l) => l.at), safetyHold: false, letPass: [] });
      const rf = G.createReplyFacts();
      G.addMemberWorld(rf, world);
      const echo = "Great that Hayes Valley confirmed.";
      await G.judgeThreadReports(echo, rf, { message });
      const misses: string[] = [];
      const read = rf.thread?.reads[0];
      if (!read) misses.push("the echo never reached the thread read");
      else if (read.reports === null) misses.push("the thread read failed");
      if (G.codeChecks(echo, rf, { message, recentConversation: "" }).some((c) => c.name === "no_thread_report")) misses.push(`"${echo}" was cut as a status report`);
      // And the reply turn: whatever Co writes back to their news, no line of it is cut as a thread report.
      // Their news is a share for the hard rules and the rubric (kind only: the recorded request has no moment read, see reply.ts).
      const r = await reply({ firstName: "Ellis", now: DAY, exchange: exchange.slice(0, 2), searching: NONE, threads, message, kind: "share" });
      // A reaction alone is a real answer (Co's quiet move); neither a text nor a reaction is a miss (voiceMisses: "no reply").
      if (!(r.reacted && !r.text.trim())) misses.push(...voiceMisses(r.text));
      if (r.checked.some((c) => /thread_report/.test(c))) misses.push("the reply had a line cut as a thread report");
      if (!r.reacted && !/Hayes|venue|dinner|confirm|14/i.test(r.text)) misses.push("doesn't respond to their news");
      return result(misses, `${observed(r)}  [read of "${echo}": ${read ? JSON.stringify(read.reports) : "none"}]`);
    },
  },
];
