// Golden reply cases (2026-10-13): what Co says about its own running work and what's ahead, one real reply turn each, the way
// evals/replay/run.ts runs one: the turn read, the reply agent with its tools, the fact check, no database, nothing sent, searches
// stubbed. Facts come from the real builders (harness/replyGrounding.ts runningWorkLine and ongoingFactsFor, services/whatsAhead.ts
// aheadLine, services/coTasks.ts taskFactLines), so a change to what they say is tested here too. NOT covered here: the turn wiring
// that feeds them (gatherReplyFacts reading turn.searching and turn.ahead, the searchCoverage and whatsAhead reads); those need a
// database and come with the discovery store's status contract (phase 3). Invented member only (Jordan).
// Mechanical facts are regexes; where meaning matters, one short judge (GRADER_HEADERS: the meter runs it as the grader).
import "../../lib/requireMeter.js";
import { DateTime } from "luxon";
import type { GoldenCase, GoldenResult } from "../types.js";
import { result } from "../types.js";

const ZONE = "America/Los_Angeles";
const MEMBER = { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan" };

type Kind = "known" | "did_before" | "scheduled" | "ongoing" | "unknown";
type Turn = { recent: string; facts: [Kind, string][]; message: string };
type Reply = { text: string; tools: string[]; checked: string[] };

// One real reply turn, as production runs it (replay/run.ts): profile line, today in their zone, the case's facts, the read's notes.
async function reply(t: Turn): Promise<Reply> {
  const { runConversationReplyAgent } = await import("../../../src/agent/conversationReply.js");
  const G = await import("../../../src/harness/replyGrounding.js");
  const R = await import("../../../src/services/readTurn.js");
  const { LOOP_GUIDE } = await import("../../../src/agent/loop.js");
  const facts = G.baseReplyFacts();
  G.addFact(facts, "known", "They live in San Francisco.");
  G.addFact(facts, "known", G.todayFact(ZONE));
  for (const [kind, text] of t.facts) G.addFact(facts, kind as any, text);
  const read: any = await R.readTurn({ message: t.message, recentConversation: t.recent, openItems: [] }, null, null).catch(() => null);
  if (read?.aboutCo) G.addInstruction(facts, R.ABOUT_CO_INSTRUCTION);
  if (read?.router?.wantsRecommendation) G.addInstruction(facts, LOOP_GUIDE);
  const note = R.feedbackInstruction(read?.feedback ?? []);
  if (note) G.addInstruction(facts, note);
  const r: any = await runConversationReplyAgent(
    { ackSent: null, ...MEMBER, resolvedContent: t.message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: t.recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true },
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}`, toolsCalled: [], grounding: [] }));
  // What the fact check did to each message (cut, redrafted, stripped), so a miss shows whether the draft or the check said it.
  const checked = (r.grounding ?? []).filter((g: any) => g.outcome && g.outcome !== "as_drafted" && g.outcome !== "unchecked").map((g: any) => `${g.outcome}: ${(g.checks ?? []).filter((x: any) => !x.pass).map((x: any) => x.reason ?? x.name).join(" | ").slice(0, 200)}`);
  return { text: String(r.replyText ?? ""), tools: r.toolsCalled ?? [], checked };
}

// One yes/no question about the reply, quoted. A failed or unparsed judge is a miss, never a pass.
async function judge(text: string, context: string, question: string): Promise<{ yes: boolean; reason: string; n?: number }> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { MODELS, GRADER_HEADERS } = await import("../../../src/models.js");
  const { parseModelJson } = await import("../../../src/services/modelJson.js");
  try {
    const { text: out } = await generateText({
      model: anthropic(MODELS.haiku),
      headers: GRADER_HEADERS,
      maxOutputTokens: 300,
      prompt: `You grade one text a companion called Co sent a member.\n\nThe situation: ${context}\n\nCo's text:\n"""${text}"""\n\n${question}\n\nReturn ONLY JSON: {"answer": "yes" | "no", "count": <number, only if the question asks for one>, "reason": "one short line quoting the words that decide it"}`,
    });
    const j = parseModelJson<{ answer?: string; count?: number; reason?: string }>(out);
    return { yes: /^yes$/i.test(String(j.answer ?? "")), reason: String(j.reason ?? ""), n: typeof j.count === "number" ? j.count : undefined };
  } catch (e: any) {
    return { yes: false, reason: `judge failed: ${e?.message ?? e}` };
  }
}

const observed = (r: Reply) => `${r.text}${r.tools.length ? `  [tools ${r.tools.join(",")}]` : ""}${r.checked.length ? `  [fact check ${r.checked.join(" || ")}]` : ""}`;
const done = (misses: string[], r: Reply): GoldenResult => result(misses, observed(r));

// Says nothing is running (2026-10-13 live: "Nothing's running on that right now").
const SAYS_NOTHING_RUNNING = /nothing('?s| is) (actually |actively |really )?(running|being (searched|worked|looked))|not (actively )?(searching|looking) for anything/i;
// One offer phrase each; two in one reply is the 10-13 double offer.
const OFFER = /\bwant me to\b|\bwould you like me to\b|\bshould I\b|\bshall I\b|\bdo you want me to\b|\bI can\b[^.?!]{0,80}\bif\b|\bsay the word\b|\blet me know if you('d)? (want|like)\b|\bhappy to\b[^.?!]{0,60}\bif\b/gi;
const offers = (text: string) => text.match(OFFER) ?? [];
const OFFER_COUNT_Q = 'How many separate offers does the text make to start, turn on, set up or look for something for them (e.g. "Want me to start on it?", "I can look if you like", "Should I turn it back on?")? An offer repeated in other words counts again. Answer "yes" if the count is 0 or 1, "no" if it is 2 or more, and give the count.';

const LOOKOUT = "live jazz nights in San Francisco worth taking a date to";
const NOTHING = { asks: [] as string[], goals: [] as string[], held: [] as string[] };

// Two days out, 8:46am their time (the live check-in's time): always inside "this week", whatever day the run is (review: a Friday-
// or Saturday run put "next Friday" 6-7 days out and a correct answer could miss).
function checkInTime(): string {
  return DateTime.now().setZone(ZONE).plus({ days: 2 }).set({ hour: 8, minute: 46, second: 0, millisecond: 0 }).toUTC().toISO()!;
}

export const CASES: GoldenCase[] = [
  {
    n: 1,
    id: "running-work",
    title: "Asked what Co is searching for, with one look-out searched each morning: names it, never says nothing is running",
    status: { live: true },
    from: "2026-10-13 live thread: 'Nothing's running on that right now' while a lookout was searched daily; fixed in #190 (fd8dddf)",
    run: async () => {
      const G = await import("../../../src/harness/replyGrounding.js");
      const searching = { asks: [LOOKOUT], goals: [], held: [] };
      const facts: [Kind, string][] = [
        ["known", G.runningWorkLine([], [], searching)],
        ...G.ongoingFactsFor([{ text: LOOKOUT, kind: "find" }]).map((f): [Kind, string] => [f.kind as Kind, f.text]),
      ];
      const recent = ["User said: Can you keep an eye out for good live jazz nights in SF? Somewhere worth taking a date.", "Co replied: On it. I'll look each morning and text you when something good turns up."].join("\n");
      const r = await reply({ recent, facts, message: "What are you actually searching for?" });
      const misses: string[] = [];
      if (!/jazz/i.test(r.text)) misses.push("doesn't name the jazz look-out");
      if (/nothing('?s| is) (actually |actively )?running/i.test(r.text) || SAYS_NOTHING_RUNNING.test(r.text)) misses.push("says nothing is running");
      const j = await judge(r.text, `Co's daily search looks every morning for what the member asked: "${LOOKOUT}". The member asked "What are you actually searching for?"`, "Does the text answer with live jazz nights as what Co is searching or watching for (naming it as the answer to their question counts; it need not say \"daily\"), without saying nothing is running, that nothing is being searched, or that it's only saved?");
      if (!j.yes) misses.push(`judge: doesn't present the jazz search as running (${j.reason})`);
      return done(misses, r);
    },
  },
  {
    n: 2,
    id: "nothing-at-all",
    title: "Asked what Co is searching for with nothing running: says so plainly, offers at most once",
    status: { live: true },
    from: "2026-10-13 live thread: the honest nothing-running line went out with a second offer on top; fixed in #190 (fd8dddf)",
    run: async () => {
      const G = await import("../../../src/harness/replyGrounding.js");
      const facts: [Kind, string][] = [
        ["known", G.runningWorkLine([], [], NOTHING)],
        ...G.ongoingFactsFor([]).map((f): [Kind, string] => [f.kind as Kind, f.text]),
      ];
      const recent = ["User said: Morning", "Co replied: Morning, Jordan. How's the week shaping up?", "User said: Busy but good"].join("\n");
      const r = await reply({ recent, facts, message: "What are you actually searching for?" });
      const misses: string[] = [];
      const said = SAYS_NOTHING_RUNNING.test(r.text);
      const j = await judge(r.text, "Nothing is running for the member: no task, research, look-out or daily search. They asked \"What are you actually searching for?\"", "Does the text clearly tell them that nothing is being searched for or worked on for them right now, without claiming any search or task is running?");
      if (!said && !j.yes) misses.push(`doesn't say nothing is being searched (${j.reason})`);
      if (said && !j.yes) misses.push(`judge: claims or implies running work (${j.reason})`);
      const found = offers(r.text);
      if (found.length > 1) misses.push(`offers ${found.length} times: ${found.map((o) => `"${o}"`).join(", ")}`);
      const c = await judge(r.text, "Nothing is running for the member; Co may offer once to start something.", OFFER_COUNT_Q);
      if (!c.yes) misses.push(`judge: more than one offer (${c.n ?? "?"}: ${c.reason})`);
      return done(misses, r);
    },
  },
  {
    n: 3,
    id: "double-offer",
    title: "After Co said nothing's running and offered to start, \"What do you mean by that?\" gets at most one offer",
    status: { live: true },
    from: "2026-10-13 live thread: 'What do you mean by that?' after the nothing-running line; the reply offered to turn it on and the canned line offered again; fixed in #190 (fd8dddf)",
    run: async () => {
      const G = await import("../../../src/harness/replyGrounding.js");
      const facts: [Kind, string][] = [
        ["known", G.runningWorkLine([], [], NOTHING)],
        ...G.ongoingFactsFor([]).map((f): [Kind, string] => [f.kind as Kind, f.text]),
      ];
      const recent = [
        "User said: How's the search for a pilates studio near the Mission going?",
        `Co replied: ${G.NOTHING_RUNNING_LINE}`,
      ].join("\n");
      const r = await reply({ recent, facts, message: "What do you mean by that?" });
      const misses: string[] = [];
      const found = offers(r.text);
      if (found.length > 1) misses.push(`offers ${found.length} times: ${found.map((o) => `"${o}"`).join(", ")}`);
      const c = await judge(r.text, `Co just told the member "${G.NOTHING_RUNNING_LINE}" about a pilates studio search, and they asked "What do you mean by that?". Nothing is running for them.`, OFFER_COUNT_Q);
      if (!c.yes) misses.push(`judge: more than one offer (${c.n ?? "?"}: ${c.reason})`);
      if (/\b(still|i'?m|i am|been)\s+(searching|looking|digging|working on)\b/i.test(r.text)) misses.push("claims work is running");
      // The #190 line itself, directly (the turn above only reaches it when the check cuts a work-status claim): with nothing running,
      // a reply that already offers, with or without a "?", never gets a second offer.
      const cut = [{ name: "claim_work_status", pass: false, reason: "work_status (nothing is running for it)" }] as any;
      const rf = { facts: [{ id: "f1", kind: "known", text: G.runningWorkLine([], [], NOTHING) }] } as any;
      for (const draft of ["I meant the pilates search. Want me to turn it back on?", "I can turn it back on if you like."]) {
        const out = await G.withNothingRunningLine(draft, cut, rf);
        if (!/Nothing's running on that right now/.test(out)) misses.push(`the nothing-running line didn't apply to "${draft}" (got "${out}")`);
        if (offers(out).length > 1) misses.push(`the nothing-running line added a second offer to "${draft}": "${out}"`);
      }
      return done(misses, r);
    },
  },
  {
    n: 4,
    id: "whats-ahead",
    title: "\"Anything I should look forward to this week?\" with a check-in two days out scheduled: names it, never 'nothing confirmed'",
    status: { live: true },
    from: "2026-10-13 live thread: Co set a Friday branding check-in that morning and said 'nothing confirmed' that afternoon; fixed in #190 (fd8dddf)",
    run: async () => {
      const G = await import("../../../src/harness/replyGrounding.js");
      const { aheadLine } = await import("../../../src/services/whatsAhead.js");
      const { NO_COVERAGE } = await import("../../../src/services/searchCoverage.js");
      const { taskFactLines } = await import("../../../src/services/coTasks.js");
      const at = checkInTime();
      const day = DateTime.fromISO(at).setZone(ZONE).toFormat("cccc");
      const goal = "Weekly branding accountability check-in";
      // As production builds the turn (replyGrounding.ts): the open task as scheduled, the running-work line, and what's ahead.
      const tasks = taskFactLines(
        [{ id: 41, userId: MEMBER.userId, goal, theirWords: `keep me honest on the branding work, check in ${day}`, steps: [], planNext: "Ask how the branding work went this week", nextCheckAt: at, status: "open", wakes: 0, notes: [], textsSent: 0, lastTextedAt: null, createdAt: new Date().toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work" }],
        undefined,
        ZONE,
      );
      const facts: [Kind, string][] = [
        ...tasks.map((t): [Kind, string] => ["scheduled", t]),
        ["known", G.runningWorkLine(tasks, [], NO_COVERAGE)],
        ["scheduled", aheadLine({ tasks: [{ id: 41, goal, kind: "work", nextCheckAt: at, deadline: null }], queuedFinds: 0 }, NO_COVERAGE, ZONE)],
      ];
      const recent = [`User said: Can you hold me to the branding work? Check in with me ${day}.`, `Co replied: Done. I'll check in ${day} morning and ask where the branding landed.`].join("\n");
      const r = await reply({ recent, facts, message: "Anything I should look forward to this week?" });
      const misses: string[] = [];
      if (!new RegExp(`\\b${day.slice(0, 3)}`, "i").test(r.text) && !/\b(day after tomorrow|in two days|this week)\b/i.test(r.text)) misses.push(`doesn't mention the ${day} check-in`);
      if (/nothing('?s| is)?\s+(firm(ly)?\s+|really\s+|yet\s+)?(confirmed|planned|scheduled|set|on the calendar|lined up)|no(thing)?\s+(firm\s+|confirmed\s+)?plans\b/i.test(r.text)) misses.push("says nothing is confirmed or planned");
      const j = await judge(r.text, `Co has a branding accountability check-in with the member set for ${day}. They asked "Anything I should look forward to this week?"`, "Does the text tell them about the branding check-in that is set for them (in any words: coming up, on the books, on the calendar, scheduled), without saying nothing is planned, confirmed or scheduled? Answer yes if it names that check-in at all.");
      if (!j.yes) misses.push(`judge: no ${day} check-in as ahead (${j.reason})`);
      return done(misses, r);
    },
  },
  {
    n: 13,
    id: "planned-before-first-run",
    title: "A look-out opened at 4pm, first run tomorrow 9am: never 'nothing's running', says it's looked at tomorrow morning",
    status: { live: false, until: "phase 3 (discoveryStatus: planned state)", why: "today's facts can't say a look-out opened this afternoon has its first run tomorrow at 9; the planned state names it" },
    from: "Discovery plan, final case list: a look-out saved after the morning run reads as running (or as nothing) until the next one; run against today's facts for the record",
    run: async () => {
      const G = await import("../../../src/harness/replyGrounding.js");
      const { aheadLine } = await import("../../../src/services/whatsAhead.js");
      const ask = "a quiet cocktail bar in Hayes Valley for a work drinks night";
      const searching = { asks: [ask], goals: [], held: [] };
      const facts: [Kind, string][] = [
        ["known", G.runningWorkLine([], [], searching)],
        ...G.ongoingFactsFor([{ text: ask, kind: "find" }]).map((f): [Kind, string] => [f.kind as Kind, f.text]),
        ["scheduled", aheadLine({ tasks: [], queuedFinds: 0 }, searching, ZONE)],
      ];
      const recent = ["User said: Can you watch for a quiet cocktail bar in Hayes Valley? Work drinks, maybe 8 people.", "Co replied: Saved. I'll keep a look out and text you when one fits."].join("\n");
      const r = await reply({ recent, facts, message: "Is that actually running yet?" });
      const misses: string[] = [];
      if (/nothing('?s| is) (actually |actively )?running/i.test(r.text) || SAYS_NOTHING_RUNNING.test(r.text)) misses.push("says nothing is running");
      const j = await judge(r.text, `The member asked Co this afternoon to watch for "${ask}". Co's daily search runs every morning from 9, so the first look is tomorrow morning. They asked "Is that actually running yet?"`, "Does the text convey that it will be looked at (or the search runs) tomorrow morning / the next morning, without saying nothing is running?");
      if (!j.yes) misses.push(`judge: doesn't say tomorrow morning (${j.reason})`);
      return done(misses, r);
    },
  },
];
