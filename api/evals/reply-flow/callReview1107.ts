// The 2026-11-07 call review and the check-in after it (Royce: "fix all"). Layer 1: zero tokens (every model read here is a stub of
// this file's own), no database, nothing sent. Invented members (Jordan, Noor).
//   TZ=UTC node evals/runLayer1.mjs evals/reply-flow/callReview1107.ts
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const G = await import("../../src/services/gptLive.js");
const EL = await import("../../src/services/elevenLabsCalls.js");
const V = await import("../../src/services/coVoice.js");
const MT = await import("../../src/harness/memberThreads.js");
const PS = await import("../../src/harness/personSnapshot.js");
const CC = await import("../../src/services/callContext.js");
const Q = await import("../../src/harness/quotedWords.js");
const MS = await import("../../src/services/milestones.js");
const STR = await import("../../src/harness/momentFit.js");
const RG = await import("../../src/harness/replyGrounding.js");
const { candidateClass } = await import("../../src/harness/notifyGate.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`); }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const { default: pool } = await import("../../src/db/db.js");
const realQuery = (pool as any).query;
// A stand-in database for one block: each query goes to `handle` (sql, params); nothing else is reached.
const withDb = async <T,>(handle: (sql: string, params: any[]) => { rows: any[] } | null, fn: () => Promise<T>): Promise<T> => {
  (pool as any).query = async (sql: string, params: any[] = []) => handle(sql, params) ?? { rows: [] };
  try { return await fn(); } finally { (pool as any).query = realQuery; }
};
const CR = await import("../../src/services/callReason.js");
const PG = await import("../../src/services/peopleGraph.js");
const VOICE = src("prompts/co-system-prompt.md");
const base = { userId: "u-jordan", callSid: "CA1", firstName: "Jordan", team: false, voiceLayer: VOICE, contextSummary: "Where things stand now: leaving the agency on the 21st.", rightNow: "Tuesday 2pm.", findsNow: "", callReason: "They asked for this call: they asked Cue to call them (by text, just now). Let them lead; it's their call.", timeOfDay: "Wednesday afternoon" };

// ---------------------------------------------------------------- 1. who asked for the call frames the opening and the close
{
  const asked = G.buildLiveCall({ ...base, direction: "outbound", askedBy: "member" });
  const placed = G.buildLiveCall({ ...base, direction: "outbound", askedBy: "cue", callReason: "Cue called because of something in their life: the agency exit." });
  const inbound = G.buildLiveCall({ ...base, direction: "inbound", askedBy: "member" });
  check("member-asked outbound: GPT-Live's instructions state the fact (they asked), with no forced wording", asked.instructions.includes(EL.MEMBER_ASKED_CALL_LINE) && !/you asked me to call|I had a minute|glad you picked up/.test(EL.MEMBER_ASKED_CALL_LINE));
  check("member-asked outbound: never the 'glad they picked up' allowance or 'your idea'", !/glad they picked up/.test(asked.instructions) && !asked.instructions.includes(EL.CUE_PLACED_CALL_LINE));
  check("member-asked outbound: the thinking gets the same fact", asked.backendSystem.includes(EL.MEMBER_ASKED_CALL_LINE));
  check("member-asked outbound: the held reason note is the fact 'Why this call: they asked you to call (<reason>)'", G.heldOpeningNote(asked.opening).startsWith("Why this call: they asked you to call (") && !/Why you called them/.test(G.heldOpeningNote(asked.opening)));
  check("Cue-initiated outbound: the thinking is told it was Cue's idea (the voice keeps the outbound line, at its cap), and the held note is 'why you called them'", !placed.instructions.includes(EL.CUE_PLACED_CALL_LINE) && placed.instructions.includes("This call: you called them") && placed.backendSystem.includes(EL.CUE_PLACED_CALL_LINE) && G.heldOpeningNote(placed.opening).startsWith("Why you called them") && !placed.instructions.includes(EL.MEMBER_ASKED_CALL_LINE));
  check("not known: the outbound line as before", EL.callSituation({ direction: "outbound", team: false }).startsWith("This call: you called them") && !EL.callSituation({ direction: "outbound", team: false }).includes(EL.CUE_PLACED_CALL_LINE));
  check("inbound: unchanged (they called you), askedBy ignored", inbound.instructions.includes("This call: they called you.") && !inbound.instructions.includes(EL.MEMBER_ASKED_CALL_LINE) && inbound.opening.askedBy === undefined);
  // Who asked, from the gate's held reason (services/callReason.ts callAskedBy, which the route calls), into the call's situation.
  CR.holdCallReason("u-asked", "router_decision", { reason: CR.memberAskedReason("router_decision"), considered: [] });
  CR.holdCallReason("u-placed", "checkin_cadence", { reason: { kind: "open_thread", key: "t:1", text: "the agency exit", at: null } as any, considered: [] });
  const heldAsked = CR.callAskedBy("outbound", CR.heldCallReason("u-asked")), heldPlaced = CR.callAskedBy("outbound", CR.heldCallReason("u-placed"));
  check("who asked: a member-asked hold is theirs, a Cue-cadence hold is Cue's, nothing held or inbound is unknown", heldAsked === "member" && heldPlaced === "cue" && CR.callAskedBy("outbound", CR.heldCallReason("u-none")) === null && CR.callAskedBy("inbound", CR.heldCallReason("u-asked")) === null);
  check("...and that reaches the call's situation", EL.callSituation({ direction: "outbound", team: false, askedBy: heldAsked }) === EL.MEMBER_ASKED_CALL_LINE && EL.callSituation({ direction: "outbound", team: false, askedBy: heldPlaced }).endsWith(EL.CUE_PLACED_CALL_LINE) && /Never thank them for calling/.test(EL.MEMBER_ASKED_CALL_LINE));
  for (const a of ["member", "cue", undefined] as const) {
    const n = G.buildLiveCall({ ...base, firstName: "Alexandria-Maximiliana", direction: "outbound", team: true, askedBy: a, first: { firstCall: true, theirWords: "x".repeat(400), inviter: "Bartholomew", emailOnFile: false } }).instructions.length;
    check(`instructions stay under the session cap on an outbound team first call (askedBy ${a})`, n <= G.GPT_LIVE.maxInstructionChars, n);
  }
}

// ---------------------------------------------------------------- 2. Cue sees its own openers (judgment, never a filter)
{
  const turns = [
    { who: "cue" as const, text: "Hey Jordan, you asked me to call.", startMs: 0, endMs: 1000 },
    { who: "member" as const, text: "Yeah, the agency thing.", startMs: 1100, endMs: 2000 },
    { who: "cue" as const, text: "I hear you. That's a lot.", startMs: 2100, endMs: 3000 },
    { who: "member" as const, text: "mm", startMs: 3100, endMs: 3200 },
    { who: "cue" as const, text: "I hear you, and the 21st is close.", startMs: 3300, endMs: 4000 },
    { who: "member" as const, text: "It is.", startMs: 4100, endMs: 4500 },
  ];
  const op = G.callOpeners(turns);
  check("openers: each once, newest last, up to the first pause", JSON.stringify(op) === JSON.stringify(["Hey Jordan", "I hear you"]), op);
  check("openers note: names them and says vary it (optional, never a ban)", G.openersNote(op).includes('"I hear you"') && /Vary it so it doesn't sound like a script\./.test(G.openersNote(op)) && !/Don't reuse|never/i.test(G.openersNote(op)) && G.openersNote([]) === "");
  const call = G.buildLiveCall({ ...base, direction: "inbound" });
  const reqs: any[] = [];
  const events = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }] as any[];
  await G.thinkOnCall(call, turns, (r: any) => { reqs.push(r); return (async function* () { for (const e of events("The 21st is close.")) yield e; })(); }, undefined, undefined, undefined, undefined, { tools: async () => null });
  check("openers reach the thinking's prompt on the turn", reqs.length > 0 && JSON.stringify(reqs[0]).includes(JSON.stringify(G.openersNote(op)).slice(1, -1)), JSON.stringify(reqs[0] ?? {}).slice(-600));
  check("GPT-Live keeps its own vary-your-openers rule (its instructions are at the cap on an outbound first call)", /Vary how you start your turns/.test(call.instructions));
  check("the stock-line audit stays (call.stock_lines)", /decision: "call\.stock_lines"/.test(src("src/routes/co.ts")));
}

// ---------------------------------------------------------------- 3. another person's wants: pinned guidance only (no behaviour test: model-facing)
check("text: the others line and the no-grading line ride in CO_VOICE", V.CO_VOICE.includes(V.OTHERS_LINE) && V.CO_VOICE.includes(V.NO_GRADING_LINE));
check("calls: the thinking gets both", G.BACKEND_NOTE.includes(V.OTHERS_LINE) && G.BACKEND_NOTE.includes(V.NO_GRADING_LINE));
check("the others line: guesses never as facts, a tentative read allowed, no repeat of an answered or unanswerable question unless something changed", /Don't present guesses about what someone else/.test(V.OTHERS_LINE) && /a read offered tentatively, theirs to correct, is fine/.test(V.OTHERS_LINE) && /unless something has changed/.test(V.OTHERS_LINE));
check("paraphrase only as far as their words support (check-in tone and the quote redraft reason)", /only as far as what they actually said supports/.test(V.CHECKIN_TONE) && /only as far as what they actually said supports/.test(Q.quoteCheck('You said "x y z"', []).reason ?? ""));

// ---------------------------------------------------------------- 4. a line they took back never opens a thread
{
  const lines = [
    { at: "2026-11-06T18:00", text: "We're deciding how to position the club this month", via: "text" as const },
    { at: "2026-11-06T19:10", text: "Cleanup: whether to delete the old pages, decks and design data from the repo", via: "text" as const },
    { at: "2026-11-06T19:11", text: "sorry wrong chat", via: "text" as const },
  ];
  const usable = MT.withoutDisowned(lines);
  check("disowned: the text they said went to the wrong chat, and that line, are left out", usable.length === 1 && usable[0].text.startsWith("We're deciding"), usable);
  const g = MT.gateThreadChanges([{ text: "deciding whether to delete old pages, decks and design data", quote: "whether to delete the old pages, decks and design data" }], [], [], usable, null);
  check("disowned: a thread from it is never opened (no quote of theirs supports it)", g.opened.length === 0 && g.checks.some((c) => /not in their own words/.test(c.reason ?? "")), g.checks);
  // The review's four (bd9adc34 dropped both lines of each pair): ordinary lines, and a correction that must win.
  const pair = (a: string, b: string) => MT.withoutDisowned([{ at: "2026-11-06T19:00", text: a, via: "text" }, { at: "2026-11-06T19:01", text: b, via: "text" }]);
  check("kept: 'I just try to ignore that part honestly'", pair("work has been a lot", "I just try to ignore that part honestly").length === 2);
  check("kept: 'she gave me the wrong number lol'", pair("tried calling Noor", "she gave me the wrong number lol").length === 2);
  check("kept: 'HR sent it to the wrong person at first haha'", pair("the offer letter finally came", "HR sent it to the wrong person at first haha").length === 2);
  const fixed = pair("we're moving to Dallas in March", "actually disregard that, it's Austin");
  check("kept, with the correction applied: 'actually disregard that, it's Austin'", fixed.length === 2 && fixed[0].text === "we're moving to Dallas in March [since corrected: it's Austin]" && fixed[1].text === "actually disregard that, it's Austin", fixed);
  check("a take-back still drops: 'sorry, wrong person' and 'ignore that last text' right after a text meant for someone else", pair("Hey Sam, lmk when the deck is ready", "sorry, wrong person").length === 0 && pair("Mom: running 10 late", "ignore that last text").length === 0);
  check("a bare 'wrong person' after a line about their life keeps both ('Went on a date last night')", pair("Went on a date last night", "wrong person").length === 2);
  check("'wrong number lol' five minutes after 'Called the venue and nobody picked up' is their story: both stay", MT.withoutDisowned([{ at: "2026-11-06T19:00", text: "Called the venue and nobody picked up", via: "text" }, { at: "2026-11-06T19:05", text: "wrong number lol", via: "text" }]).length === 2);
  check("'Maya, my cofounder, quit today' + 'ignore that': their own news, both stay", pair("Maya, my cofounder, quit today", "ignore that").length === 2);
  check("'Stripe: we got the partnership...' + 'pls ignore that': both stay", pair("Stripe: we got the partnership signed this morning", "pls ignore that").length === 2);
  check("a greeting to someone else still reads as theirs to that person ('Hey Sam, I'm running late' + 'wrong person'), never 'Hey Cue'", pair("Hey Sam, I'm running late", "wrong person").length === 0 && pair("Hey Cue, I'm running late", "wrong person").length === 2);
  check("...and after one that only starts with an interjection ('Yeah, ...')", pair("Yeah, the date went fine", "wrong person").length === 2);
  check("a bare take-back minutes later keeps both; a strong one ('wrong chat') still takes it back", MT.withoutDisowned([{ at: "2026-11-06T19:00", text: "Hey Sam, lmk when the deck is ready", via: "text" }, { at: "2026-11-06T19:10", text: "sorry, wrong person", via: "text" }]).length === 2 && MT.withoutDisowned([{ at: "2026-11-06T19:00", text: "went on a date last night", via: "text" }, { at: "2026-11-06T19:10", text: "oops wrong chat", via: "text" }]).length === 0);
  check("an ordinary line is kept (no disowning words)", MT.withoutDisowned([{ at: "2026-11-06T19:10", text: "ignore the noise, I'm all in on the club", via: "text" }]).length === 1);
  check("a call line is never disowned by a text", MT.withoutDisowned([{ at: "2026-11-06T19:10", text: "we should delete the old decks", via: "call" }, { at: "2026-11-06T19:11", text: "wrong chat", via: "text" }]).length === 1);
  const rows = [{ field: "thread", old: "deleting the old decks", now: null, ref: "thread:t9", removed: true }];
  const guarded = MT.usableLines([{ at: "2026-11-06T18:00", text: "honestly deleting the old decks is overdue", via: "text" }], rows, (t, r) => (r.some((x) => t.includes(x.old)) ? null : t));
  check("removed: a line saying what they removed goes through the guard (dropped)", guarded.length === 0);
  // applyThreadProposal end to end on a stand-in database: what it writes (INSERT INTO member_threads) is the proof.
  {
    const ls = [
      { at: "2026-11-06T18:00", text: "We're deciding how to position the club this month", via: "text" as const },
      { at: "2026-11-06T18:30", text: "honestly deleting the old decks is overdue for me", via: "text" as const },
      { at: "2026-11-06T19:10", text: "Cleanup: whether to delete the old pages, decks and design data from the repo", via: "text" as const },
      { at: "2026-11-06T19:11", text: "sorry wrong chat", via: "text" as const },
    ];
    const inserted: string[] = [];
    await withDb((sql, params) => {
      if (/FROM profile_corrections/.test(sql)) return { rows: [{ field: "thread", old_value: "deleting the old decks", new_value: null, item_ref: "thread:t9", removed: "true" }] };
      if (/INSERT INTO member_threads/.test(sql)) { inserted.push(String(params[1])); return { rows: [{ id: `n${inserted.length}` }] }; }
      return null;
    }, () => MT.applyThreadProposal("u-jordan", { open: [
      { text: "deciding whether to delete old pages, decks and design data", quote: "whether to delete the old pages, decks and design data" },
      { text: "deleting the old decks", quote: "deleting the old decks is overdue" },
      { text: "positioning the club", quote: "deciding how to position the club this month" },
    ] }, [], ls));
    check("applyThreadProposal: the took-back text and the removed one open nothing; their real line does", JSON.stringify(inserted) === JSON.stringify(["positioning the club"]), inserted);
  }
}

// ---------------------------------------------------------------- 5. a want for a cut capability is never acted on
{
  check("a pitch deck is a want Cue doesn't make; a person who makes one isn't", V.wantNeedsMaker("a pitch deck for Noise & Cue") && V.wantNeedsMaker("slides for Friday") && !V.wantNeedsMaker("a website designer") && !V.wantNeedsMaker("a design cofounder") && !V.wantNeedsMaker("someone to help build a website"));
  const r = PS.renderSnapshot({ work: "founder", place: "SF", wantsNow: ["a pitch deck for Noise & Cue", "to meet operators"], weighingOn: [], valuesInPeople: [], worked: [], didntWork: [], asOf: "x" });
  check("the picture shows it as something Cue doesn't make, never as a want to act on", /Wants right now: to meet operators$/m.test(r) && r.includes(`${V.MAKER_WANTS_LABEL}: a pitch deck for Noise & Cue`), r);
  const input = await withDb((sql) => {
    if (/FROM users/.test(sql)) return { rows: [{ first_name: "Jordan" }] };
    if (/FROM person_snapshots/.test(sql)) return { rows: [{ snapshot: { work: "founder", place: "SF", wantsNow: ["a pitch deck for Noise & Cue", "to meet operators"], weighingOn: [], valuesInPeople: [], worked: [], didntWork: [], asOf: "x" } }] };
    return null;
  }, () => PG.gather("u-jordan"));
  check("matching never reads it (the people-facts reader drops it; its prompt never names it)", JSON.stringify(input?.wantsNow) === JSON.stringify(["to meet operators"]) && !/pitch deck/.test(PG.peopleFactsPrompt(input!)), input);
  check("their record keeps it (no automatic delete)", !/DELETE|UPDATE/.test(src("src/harness/personSnapshot.ts").split("export function renderSnapshot")[1].split("export function profileForSearch")[0]));
}

// ---------------------------------------------------------------- 6. their typed spelling of a name reaches the call summary
{
  const ordinary = CC.typedNamesFor("user: I may make it\nuser: I'm done with data rooms\nuser: so many things", ["Then Maya called", "talked to Dana yesterday"]);
  check("typed names: ordinary words never become names ('may', 'done', 'many' are not Maya or Dana)", ordinary.length === 0, ordinary);
  const collide = CC.typedNamesFor("user: I need to hurry\nuser: it was windy and a bully\nuser: the laurel tree out front", ["Harry is coming", "Wendy said so", "Billy too", "with Lauren"]);
  check("typed names: hurry, windy, bully, laurel are never Harry, Wendy, Billy, Lauren", collide.length === 0, collide);
  check("typed names: 'Bordy' gets 'Boardy'", CC.typedNamesFor("user: I talked to Bordy", ["I was on with Boardy today"]).includes("Boardy"));
  const names = CC.typedNamesFor("assistant: who was it?\nuser: I talked to Bordy about intros", ["I was on with Boardy today", "Then Sangria", "ok sounds good"]);
  check("typed names: the near spelling of what the call said", names.includes("Boardy") && !names.includes("Sangria"), names);
  check("the summary prompt carries them, with the instruction to prefer them", CC.callSummaryPrompt("user: Bordy", ["Boardy"]).includes(CC.typedNamesLine(["Boardy"])) && !CC.callSummaryPrompt("user: hi").includes("Names they have typed"));
}

// ---------------------------------------------------------------- 7. quotes: only their exact, recoverable words
{
  const draft = 'You went from "we are really a social club" to "I like that." That\'s a real answer. How does it sit with you?';
  check("a quote of Cue's framing as theirs fails", !Q.quoteCheck(draft, ["I like that.", "Co replied: we are really a social club"].slice(0, 1)).pass);
  check("a real quote of theirs passes", Q.quoteCheck('You said "the pitch went great" and it shows.', ["honestly the pitch went great!"]).pass);
  check("a quote not said to be theirs (an event's name) isn't read", Q.quotesAsTheirs('The "Founders Night" is Friday.').length === 0);
  check("a door text goes without the sentence", JSON.stringify(Q.withoutUnbackedQuotes([draft], ["I like that."])) === JSON.stringify(["That's a real answer. How does it sit with you?"]), Q.withoutUnbackedQuotes([draft], ["I like that."]));
  // The proactive trace (quotedWords.ts theirLinesForQuotes, what the dispatch reads): their texts and their side of a call only. A call
  // where only Cue said "we are really a social club" never makes it theirs.
  const theirs = await withDb((sql) => (/FROM co_memories/.test(sql) ? { rows: [
    { created_at: "2026-11-07T02:00:00Z", memory_type: "call_transcript", content: "assistant: so we are really a social club\nuser: I like that." },
    { created_at: "2026-11-07T02:30:00Z", memory_type: "text_exchange", content: "User said: Call me" },
  ] } : null), () => Q.theirLinesForQuotes("u-jordan"));
  const r854 = Q.quoteCheck(draft, theirs);
  check("proactive: traced to their own lines only (Cue's line on the call doesn't count; theirs does)", !r854.pass && /we are really a social club/.test(r854.reason ?? "") && Q.unbackedQuotes(draft, theirs).length === 1 && theirs.includes("I like that."), { theirs, r854 });
  const cut = RG.stripUnsupported('You said "we are really a social club." Love where this is going.', [Q.quoteCheck('You said "we are really a social club."', [])]);
  check("reply: the sentence quoting them is cut, the rest stays", cut === "Love where this is going.", cut);
  const rc = RG.codeChecks('You said "we are really a social club." Love where this is going.', RG.baseReplyFacts(), { message: "yeah I like that", recentConversation: "Co replied: we are really a social club\nUser said: yeah I like that" });
  const rcOk = RG.codeChecks('You said "I like that" and it stuck with me.', RG.baseReplyFacts(), { message: "yeah I like that", recentConversation: "User said: yeah I like that" });
  check("reply: codeChecks fails a quote that only Cue said, passes one of theirs", rc.some((c) => c.name === Q.QUOTE_IS_THEIRS && !c.pass) && !rcOk.some((c) => c.name === Q.QUOTE_IS_THEIRS && !c.pass), rc.filter((c) => !c.pass));
  // The milestone builder (candidate 854): a close that says nothing about the thread isn't a moment; quotes must trace to their lines.
  const s = { joinedAt: "2026-09-01T00:00:00Z", now: "2026-11-07T00:00:00Z", went: [], closed: [{ id: "t1", text: "deciding how to position the concept: anti-networking social club vs b2b model", openedQuote: "We are really a social club", closedQuote: "I like that.", at: "2026-11-02T00:00:00Z" }] };
  check("milestone: 'I like that.' doesn't establish how a positioning decision landed: no milestone", MS.deriveMilestones(s).length === 0);
  const s2 = { ...s, closed: [{ ...s.closed[0], closedQuote: "we're going with the social club positioning" }] };
  check("milestone: a close about the thread, traced: kept with their words", MS.deriveMilestones({ ...s2, lines: ["We are really a social club", "ok we're going with the social club positioning"] })[0]?.then === "We are really a social club");
  check("milestone: an opening quote no line of theirs has anymore is dropped (paraphrase only)", MS.deriveMilestones({ ...s2, lines: ["ok we're going with the social club positioning"] })[0]?.then === null);
  check("milestone: a closing quote no line of theirs has: no milestone", MS.deriveMilestones({ ...s2, lines: [] }).length === 0);
  check("milestone: an ordinary close of theirs still stands ('we found one')", MS.closeSaysHowItLanded("finding a co-founder", "we found one") && !MS.closeSaysHowItLanded("x", "I like that.") && !MS.closeSaysHowItLanded("x", "sounds good"));
  {
    const onFile = [{ id: "t1", text: "deciding how to position the concept", openedQuote: "We are really a social club", openedAt: "2026-10-20T00:00:00.000Z", status: "open" as const, feeling: null, dueDate: null, nextStep: "check_in" as const, kind: "thread" as const, closedQuote: null, lastTouchedAt: "2026-10-20T00:00:00.000Z", transition: null, transitionChannel: null }];
    const g = MT.gateThreadChanges([], [{ id: "t1", status: "resolved", quote: "I like that." }], onFile, [{ at: "2026-11-07T03:00", text: "I like that.", via: "call" }], null);
    check("thread: a bare reaction doesn't close it", g.closed.length === 0 && g.checks.some((c) => /bare reaction/.test(c.reason ?? "")), g.checks);
  }
  check("milestone: a stored one like 854 isn't picked", MS.pickToMark([{ key: "thread:t1", kind: "thread_done", text: "They were in the middle of: deciding how to position the concept. It came through.", then: "We are really a social club", now: "I like that.", happenedAt: "2026-11-05T00:00:00Z", markedAt: null }], new Date("2026-11-07T00:00:00Z")) === null);
}

// ---------------------------------------------------------------- 8/9. does it belong now (model judges, code guards)
{
  const now = new Date("2026-11-08T03:05:00Z");
  const queued = new Date("2026-11-02T03:00:00Z");
  const stamp = (d: Date) => d.toISOString().slice(0, 16);
  const recent = "[Fri, Nov 7, 6:40pm PST] User said: Call me";
  const callDone = STR.callContextFor({ status: "completed", statusAt: new Date(now.getTime() - 50 * 60_000), transcript: { at: new Date(now.getTime() - 52 * 60_000), text: "assistant: hey\nuser: rough week with my cofounder" }, summary: { at: new Date(now.getTime() - 51 * 60_000), text: "[Call] Jordan talked through a hard week with their cofounder and whether to keep going." } }, now, stamp);
  const msg = "You marked a real turn on how you position the club. Glad it came through.";
  let prompt = "";
  STR.setMomentModelForTests(async (p) => { prompt = p; return '{"verdict": "drop", "why": "they just talked through something heavier; this old moment is unrelated"}'; });
  const stale = await STR.momentFit({ userId: "u-jordan", firstName: "Jordan", message: msg, recent, call: callDone, queuedAt: queued, now });
  const staleAct = STR.momentAction(stale, { waits: 0 }, now);
  check("the latest call is always in view: its summary, with when", callDone.ready && (callDone as any).line.includes("hard week with their cofounder") && prompt.includes("Their latest call with Cue:") && prompt.includes((callDone as any).line));
  check("stale milestone after a significant call: the read sees it waited 6 days, and the drop goes through (silence is fine)", /queued 6 days ago/.test(prompt) && /Being queued is not a reason to send/.test(prompt) && staleAct.act === "drop" && /heavier/.test((staleAct as any).why));
  // A call that ended 2 minutes ago, summary not written yet: wait for it, in minutes, without a model read.
  let called = false;
  STR.setMomentModelForTests(async () => { called = true; return '{"verdict": "send", "why": "x"}'; });
  const fresh = STR.callContextFor({ status: "completed", statusAt: new Date(now.getTime() - 2 * 60_000), transcript: { at: new Date(now.getTime() - 2 * 60_000), text: "user: rough week" }, summary: { at: new Date(now.getTime() - 3 * 86_400_000), text: "[Call] older" } }, now, stamp);
  const vFresh = await STR.momentFit({ userId: "u", firstName: "J", message: msg, recent, call: fresh, queuedAt: queued, now });
  const aFresh = STR.momentAction(vFresh, { waits: 0 }, now);
  check("a call that ended 2 minutes ago with no summary yet: wait (a few minutes, counted toward nothing), no read spent", !fresh.ready && vFresh.read === "call_not_ready" && !called && aFresh.act === "wait" && (aFresh as any).retryAt.getTime() === now.getTime() + STR.CALL_CONTEXT.retryMinutes * 60_000 && (aFresh as any).counted === null);
  for (const status of ["ringing", "in-progress", "processing", "initiated", "dialing"]) {
    const live = STR.callContextFor({ status, statusAt: new Date(now.getTime() - 5 * 60_000), transcript: null, summary: null }, now, stamp);
    check(`a call that's ${status === "initiated" ? "inbound (marked initiated when it's answered) or just placed" : status}: wait`, !live.ready);
  }
  check("an inbound call is marked on the member's row, with or without a sid", /if \(o\.direction === "inbound"\) await pool\.query\(`UPDATE users SET call_sid = COALESCE\(\$2, call_sid\), call_status = 'initiated'/.test(src("src/routes/co.ts")));
  check("a finished call isn't live (completed, failed, busy, no-answer)", ["completed", "failed", "busy", "no-answer"].every((status) => STR.callContextFor({ status, statusAt: new Date(now.getTime() - 5 * 60_000), transcript: null, summary: { at: new Date(now.getTime() - 86_400_000), text: "[Call] x" } }, now, stamp).ready));
  check("a live status never cleared stops holding after liveCallHours", STR.callContextFor({ status: "in-progress", statusAt: new Date(now.getTime() - (STR.CALL_CONTEXT.liveCallHours + 1) * 3_600_000), transcript: null, summary: null }, now, stamp).ready);
  const old = STR.callContextFor({ status: "completed", statusAt: new Date(now.getTime() - 5 * 3_600_000), transcript: { at: new Date(now.getTime() - 5 * 3_600_000), text: "assistant: hi\nuser: the 21st is my last day" }, summary: null }, now, stamp);
  check("an older call whose summary never came: its last turns, with when", old.ready && /The call's last turns:\nCue: hi\nThem: the 21st is my last day/.test((old as any).line ?? ""), old);
  STR.setMomentModelForTests(async () => '{"verdict": "wait", "why": "they are mid-way through something else"}');
  const w = STR.momentAction(await STR.momentFit({ userId: "u", firstName: "J", message: msg, recent, call: callDone, queuedAt: queued, now }), { waits: 0 }, now);
  check("wait: re-queued a few hours later, with the reason, counted", w.act === "wait" && (w as any).counted && (w as any).retryAt.getTime() === now.getTime() + STR.MOMENT_FIT.waitHours * 3_600_000);
  check("wait is never endless: an optional check-in that waited its turns is dropped", STR.momentAction({ verdict: "wait", why: "still not", read: "model" }, { waits: STR.MOMENT_FIT.maxWaits }, now).act === "drop");
  STR.setMomentModelForTests(async () => '{"verdict": "send", "why": "they asked about this yesterday and it is still open"}');
  check("a useful timely check-in: send", STR.momentAction(await STR.momentFit({ userId: "u", firstName: "J", message: "How did the agency talk go?", recent, call: callDone, queuedAt: now, now }), { waits: 0 }, now).act === "send");
  called = false;
  STR.setMomentModelForTests(async () => { called = true; return '{"verdict": "send", "why": "x"}'; });
  const noCtx = await STR.momentFit({ userId: "u", firstName: "J", message: msg, recent: null, call: callDone, queuedAt: queued, now });
  const noCall = await STR.momentFit({ userId: "u", firstName: "J", message: msg, recent, call: null, queuedAt: queued, now });
  check("unavailable recent context (texts or the call): wait, never send, no read spent", noCtx.read === "no_context" && noCall.read === "no_context" && !called && STR.momentAction(noCtx, { waits: 9 }, now).act === "wait");
  STR.setMomentModelForTests(async () => { throw new Error("timeout"); });
  const failedRead = await STR.momentFit({ userId: "u", firstName: "J", message: msg, recent, call: callDone, queuedAt: queued, now });
  check("a failed read: wait, never send (and never counted toward dropping it)", failedRead.read === "failed" && STR.momentAction(failedRead, { waits: STR.MOMENT_FIT.maxWaits }, now).act === "wait");
  STR.setMomentModelForTests(async () => "sure, send it");
  check("an answer that isn't the shape: wait", (await STR.momentFit({ userId: "u", firstName: "J", message: msg, recent, call: callDone, queuedAt: queued, now })).verdict === "wait");
  STR.setMomentModelForTests(null);
  // Requested reminders and promises are outside the gate entirely; an optional milestone in the same moment is judged.
  check("a requested reminder and a promise's delivery never go through the gate (their own timing)", ["direct_ask", "task_update", "commitment_nudge", "deadline_nudge", "call_reminder"].every((t) => !STR.momentFitApplies(candidateClass(t, false, {}), {}, { type: t })));
  // 2026-11-09: the text after a call is Cue's own optional next thought and is judged; one carrying an owed correction is not (evals/followThrough/momentFollowThrough.ts).
  check("the post-call text is judged like any optional message", STR.momentFitApplies(candidateClass("post_call", false, {}), {}, { type: "post_call" }));
  // sendExempt's one read (2026-11-09, exemptMomentRead) covers only Cue's own event announcements and intro asks: a requested send never.
  check("...and the reminder path (services/relay.ts, sendExempt as requested) never reaches it", !/momentFit/.test(src("src/services/relay.ts")) && /cls: "requested"/.test(src("src/services/relay.ts")) && !/STR\.momentFit\(/.test(src("src/harness/proactive.ts").split("export async function sendExempt")[1]?.split("\nexport ")[0] ?? "") && !STR.exemptHardDayRead({ cls: "requested", type: "direct_ask", targetKey: "reminder:1" }));
  check("the follow-up on their own dated commitment and a check-in on their ask route around it too", !STR.momentFitApplies("checkin", { kind: "commitment" }, { type: "window_followup" }) && !STR.momentFitApplies("checkin", {}, { type: "ask_checkin" }));
  check("an optional milestone in the same moment is judged", STR.momentFitApplies(candidateClass("companion", false, {}), { story: {} }, { type: "companion" }));
  check("a safety follow-up and a pulled item are never read", !STR.momentFitApplies("checkin", { safetyFollowUp: true }, { type: "companion" }) && !STR.momentFitApplies("checkin", {}, { pulled: true, type: "companion" }));
  check("no blanket 'call follow-up goes first' rule", !/waits_behind_follow_up/.test(src("src/harness/proactive.ts")));
  const d = STR.momentDecision({ userId: "u", candidateId: "854", kind: "companion", targetKey: "companion:milestone:thread:t1", v: stale, action: staleAct, waits: 0 });
  check("every verdict is a decision row (proactive.sendRecheck, moment_<act>, ids and the one line of why)", d.decision === "proactive.sendRecheck" && d.action === "moment_drop" && (d.proposal as any).candidate === "854");
  const P = src("src/harness/proactive.ts");
  check("dispatch: the read runs before payload-first with the latest call, wait re-queues with momentWaits, drop closes, a decision row each", /STR\.loadCallContext\(userId\)/.test(P) && /STR\.momentFit\(\{ userId, firstName: person\.firstName/.test(P) && /jsonb_build_object\('momentWaits'/.test(P) && /await dropCandidate\(registry, c, "skipped", `doesn't fit now: \$\{act\.why\}`\)/.test(P) && /recordDecision\(STR\.momentDecision/.test(P) && P.indexOf("STR.momentFit(") < P.indexOf("const pf = await payloadFirst("));
  // The race: a text of theirs between the context read (contextAt, the database's clock) and the send makes the send stale.
  {
    const contextAt = new Date("2026-11-08T03:00:00Z");
    const rows = [{ at: new Date("2026-11-08T02:50:00Z") }];
    const db = { query: async (_sql: string, args: unknown[]) => ({ rows: rows.filter((r) => r.at > (args[1] as Date)) }) };
    const before = await STR.momentStillCurrent(db, "u", contextAt);
    rows.push({ at: new Date("2026-11-08T03:00:40Z") }); // they texted while the pick and the draft ran
    const after = await STR.momentStillCurrent(db, "u", contextAt);
    const failing = await STR.momentStillCurrent({ query: async () => { throw new Error("down"); } }, "u", contextAt);
    check("race: a text arriving between the context read and the send re-judges it; a failed read holds too", before && !after && !failing);
    const P2 = src("src/harness/proactive.ts");
    check("race: judgedAt is the context read's database time, stamped before the knowledge read", /const contextAt: Date = await pool\.query\(`SELECT NOW\(\) AS now`\)/.test(P2) && P2.indexOf("const contextAt: Date") < P2.indexOf("const known = await MK.memberKnowledge(") && /const judgedAt: Date \| null = momentRead \? contextAt : null;/.test(P2));
  }
  // Retry cost: a waited check-in is judged on its kept draft before any new draft; unread reads are capped, then dropped with a reason.
  check("a waited check-in keeps its draft, and is judged on it first (no redraft unless the verdict is send)", /'momentDraft', \$5::text/.test(src("src/harness/proactive.ts")) && src("src/harness/proactive.ts").indexOf("if (moment.kept) {") < src("src/harness/proactive.ts").indexOf("draft = composed ? { messages: composed.messages"));
  const throughCall = STR.momentAction({ verdict: "wait", why: "a call with them is going on", read: "call_not_ready" }, { waits: STR.MOMENT_FIT.maxWaits, unread: STR.MOMENT_FIT.maxUnread }, now);
  check("a check-in that waits through a long call is never dropped for it, and never read trouble", throughCall.act === "wait" && (throughCall as any).counted === null && (STR.momentDecision({ userId: "u", candidateId: "1", kind: "companion", targetKey: "k", v: { verdict: "wait", why: "x", read: "call_not_ready" }, action: throughCall, waits: 0 }).proposal as any).gaveUp === undefined);
  const giveUp = STR.momentAction({ verdict: "wait", why: "the read of whether it fits now didn't answer, so this waits", read: "failed" }, { waits: 0, unread: STR.MOMENT_FIT.maxUnread }, now);
  check("failed or unread reads are capped: then dropped, the reason and the give-up recorded", giveUp.act === "drop" && (giveUp as any).gaveUp === "unread" && (STR.momentDecision({ userId: "u", candidateId: "1", kind: "companion", targetKey: "k", v: { verdict: "wait", why: "x", read: "failed" }, action: giveUp, waits: 0, unread: 6 }).proposal as any).gaveUp === "unread");
  check("the monitor counts moment-read failures and give-ups", /key: "moment_read_trouble"/.test(src("src/harness/monitor.ts")));
  check("send lock: anything of theirs after the judgment holds it (judged again next pick, never a stale send; one ledger key, no duplicate)", /const newer = !\(await STR\.momentStillCurrent\(client, person\.userId, opts\.judgedAt\)\);/.test(P) && /checks\.push\(\{ name: "moment_still_current", pass: !newer/.test(P) && /ON CONFLICT \(user_id, target_key\) DO NOTHING RETURNING id/.test(P));
}

// ---------------------------------------------------------------- tone: grading and forced questions (pinned guidance: model-facing)
check("check-in tone: warm allowed, no grading, no required closing question, no generic coaching question", /Warm, curious or playful is welcome/.test(V.CHECKIN_TONE) && V.CHECKIN_TONE.includes(V.NO_GRADING_LINE) && /A closing question isn't required/.test(V.CHECKIN_TONE) && /never a generic coaching question/.test(V.CHECKIN_TONE));
check("the story check-in no longer asks for the contrast, and carries the tone", !/let the contrast with where they are now show/.test(src("src/agent/companionCheckin.ts")) && (src("src/agent/companionCheckin.ts").match(/\$\{CHECKIN_TONE\}/g) ?? []).length >= 3);

// ---------------------------------------------------------------- dispatch end to end on a fake store (the moment read stubbed)
{
  const RealDate = Date;
  const FIXED = new RealDate("2026-10-13T18:00:00Z").getTime(); // a Tuesday late morning in LA: their hours never decide here
  globalThis.Date = class extends RealDate {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(FIXED); }
    static now() { return FIXED; }
  } as DateConstructor;
  const HOUR = 3_600_000;
  const P = await import("../../src/harness/proactive.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const writes: { sql: string; params: any[] }[] = [];
  let pending: any[] = [];
  let newerInLock = false;
  const handle = async (sql: string, params: any[] = []) => {
    const q = String(sql).trim();
    if (q.startsWith("SELECT 1 FROM co_memories WHERE user_id = $1 AND created_at > $2")) return { rows: newerInLock ? [{ x: 1 }] : [] };
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) { writes.push({ sql: q, params }); return { rows: [], rowCount: 0 }; }
    if (/^SELECT NOW\(\) AS now$/.test(q)) return { rows: [{ now: new Date(FIXED - 60_000) }] };
    if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Jordan", phone_number: "+14155550199", sms_opted_out: false, city: "San Francisco" }] };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/i.test(q)) return { rows: pending };
    if (/SELECT u\.call_status/.test(q)) return { rows: [{ call_status: "completed", call_status_updated_at: new Date(FIXED - 30 * HOUR), transcript: null, summary: { at: new Date(FIXED - 30 * HOUR).toISOString(), text: "[Call] Jordan talked about the agency exit." } }] };
    if (/COALESCE\(sms_opted_out, false\) AS opted_out/.test(q)) return { rows: [{ opted_out: false }] };
    return { rows: [], rowCount: 0 };
  };
  (pool as any).query = handle;
  const realConnect = (pool as any).connect;
  (pool as any).connect = async () => ({ query: handle, release: () => {} });
  const drafts: string[] = [];
  let draftAnswer = "How did the pitch to the second fund land?";
  P.setProactiveModelForTests((async (prompt: string) => { drafts.push(prompt); return draftAnswer; }) as any);
  (await import("../../src/harness/attention.js")).setAttentionModelForTests(async () => '{"asserts": false, "phrase": ""}');
  const judged: string[] = [];
  let verdicts: string[] = [];
  STR.setMomentModelForTests(async (p) => { judged.push(p); return verdicts.shift() ?? '{"verdict": "wait", "why": "default"}'; });
  const row = (payload: Record<string, unknown> = {}) => ({ id: "71", user_id: "u-jordan", type: "companion", target_key: "companion:71", topic_key: "companion:t", summary: "Check in on the pitch", priority: 10, due_at: new Date(FIXED - HOUR), expires_at: new Date(FIXED + 5 * 24 * HOUR), attempts: 0, created_at: new Date(FIXED - 6 * 24 * HOUR), payload: { recap: "", thread: { text: "the pitch to the second fund", quote: "pitching the second fund Thursday", dueDate: null, feeling: null }, ...payload } });
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const run = async () => { writes.length = 0; drafts.length = 0; judged.length = 0; await P.dispatchForUser(proactiveRegistry, "u-jordan", { ignorePacing: true }).catch((e: any) => printed.push(`THREW ${e?.message}`)); return { writes: writes.slice(), drafts: drafts.slice(), judged: judged.slice() }; };
  const keptWith = (w: { sql: string; params: any[] }[]) => w.find((x) => /'momentDraft', \$5::text/.test(x.sql));
  // A) a fresh check-in, the read says wait: re-queued with its draft kept, counted.
  pending = [row()]; verdicts = ['{"verdict": "wait", "why": "they just talked about something else"}'];
  const a = await run();
  const aKept = keptWith(a.writes);
  // B) it waited before: its kept draft is judged first, and no new draft is written when the verdict is wait again.
  pending = [row({ momentDraft: "How did the pitch to the second fund land?", momentWaits: 1 })]; verdicts = ['{"verdict": "wait", "why": "still not the moment"}'];
  const b = await run();
  const bKept = keptWith(b.writes);
  // C) the kept draft gets send; the fresh draft differs, so it's judged too (and the text judged is the one that goes); then a text of
  //    theirs that arrived after the context read holds it at the send lock.
  pending = [row({ momentDraft: "An older line about the pitch.", momentWaits: 1 })]; verdicts = ['{"verdict": "send", "why": "the pitch is still open"}', '{"verdict": "send", "why": "fits"}']; newerInLock = true;
  const c = await run();
  newerInLock = false;
  // D) the read says drop: closed with the reason.
  pending = [row()]; verdicts = ['{"verdict": "drop", "why": "it no longer fits after the call"}'];
  const d = await run();
  console.log = log; console.error = err;
  P.setProactiveModelForTests(null);
  STR.setMomentModelForTests(null);
  (pool as any).query = realQuery;
  (pool as any).connect = realConnect;
  globalThis.Date = RealDate;
  check("dispatch A: a fresh check-in was drafted, then judged once with the latest call in view", a.drafts.length >= 1 && a.judged.length === 1 && a.judged[0].includes("Jordan talked about the agency exit.") && a.judged[0].includes("How did the pitch to the second fund land?"), { drafts: a.drafts.length, judged: a.judged.length, printed: printed.filter((l) => /THREW/.test(l)) });
  check("dispatch A: wait re-queues it with the reason, its draft kept, the wait counted", !!aKept && aKept.params[2] === 1 && aKept.params[3] === 0 && aKept.params[4] === "How did the pitch to the second fund land?", aKept?.params);
  check("dispatch B: a waited check-in is judged on its kept draft, with no new draft written", b.drafts.length === 0 && b.judged.length === 1 && b.judged[0].includes("How did the pitch to the second fund land?") && keptWith(b.writes)?.params[2] === 2, { drafts: b.drafts.length, judged: b.judged.length, kept: bKept?.params });
  check("dispatch C: send on the kept draft, the fresh draft differs: judged again on the text that goes", c.judged.length === 2 && c.judged[0].includes("An older line about the pitch.") && c.judged[1].includes("How did the pitch to the second fund land?") && c.drafts.length >= 1, { judged: c.judged.length, drafts: c.drafts.length });
  check("dispatch C: a text of theirs after the context read holds it at the send lock (never a stale send)", c.writes.some((w) => /harness_decisions/.test(w.sql) && JSON.stringify(w.params).includes("moment_still_current")) && !c.writes.some((w) => /SET status = 'sent'/.test(w.sql)), c.writes.filter((w) => /harness_decisions/.test(w.sql)).map((w) => JSON.stringify(w.params).slice(0, 200)));
  check("dispatch D: drop closes it with the reason", d.writes.some((w) => /UPDATE proactive_candidates SET status = \$2/.test(w.sql) && JSON.stringify(w.params).includes("doesn't fit now: it no longer fits after the call")), d.writes.map((w) => w.sql.slice(0, 80)));
  check("dispatch: every verdict is a decision row", [a, b, d].every((r) => r.writes.some((w) => /harness_decisions/.test(w.sql) && JSON.stringify(w.params).includes("proactive.sendRecheck"))));
  check("dispatch: nothing threw", !printed.some((l) => l.startsWith("THREW")), printed.filter((l) => l.startsWith("THREW")));
}

// ---------------------------------------------------------------- a failed inbound call never leaves its live mark behind
{
  const B = await import("../../src/services/gptLiveBridge.js");
  const { EventEmitter } = await import("node:events");
  class Sock extends EventEmitter { readyState = 1; sent: any[] = []; send(d: unknown) { this.sent.push(JSON.parse(String(d))); } close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); } in(m: unknown) { this.emit("message", JSON.stringify(m)); } }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const liveCall = () => G.buildLiveCall({ ...base, callSid: null, direction: "inbound" });
  const run = async (o: { start: boolean; postCall: () => Promise<unknown> }) => {
    const tw = new Sock(), ai = new Sock();
    const released: string[] = [];
    B.setLiveDeps({ connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; }, apiKey: () => "sk-test", record: () => {}, postCall: o.postCall, release: async (c) => { released.push(c.userId); }, minutes: () => {}, log: () => {}, now: Date.now, guardRows: async () => [], safetyCut: async () => {} });
    B.handleGptLiveStream(tw as any);
    B.setLiveDeps(null);
    tw.in({ event: "start", streamSid: "MZ9", start: { customParameters: { s: G.issueLiveLink(liveCall()) } } });
    await sleep(5);
    if (o.start) { ai.in({ type: "session.started", session: { id: "live_rel" } }); await sleep(5); }
    tw.close();
    ai.close();
    for (let t = 0; t < 400 && !released.length; t += 10) await sleep(10);
    return released;
  };
  check("bridge: a session that never started clears the call's live mark (no sid for the <Connect> action to use)", JSON.stringify(await run({ start: false, postCall: async () => {} })) === JSON.stringify(["u-jordan"]));
  check("bridge: a post-call that failed clears it", JSON.stringify(await run({ start: true, postCall: async () => { throw new Error("db down"); } })) === JSON.stringify(["u-jordan"]));
  check("bridge: a post-call that ran leaves it to the post-call (no release)", (await run({ start: true, postCall: async () => {} })).length === 0);
  // The answer route: the inbound mark set, then the answer can't be built: the mark is cleared in its catch.
  const CO = await import("../../src/routes/co.js");
  const writes: string[] = [];
  const prevUrl = process.env.API_URL;
  process.env.API_URL = "https://api.example.test";
  const r = await withDb((sql) => {
    const q = String(sql).trim();
    if (/FROM gpt_live_minutes/.test(q)) return { rows: [{ s: 0 }] };
    if (/^UPDATE users/.test(q)) { writes.push(q); return { rows: [] }; }
    if (/SELECT first_name FROM users/.test(q)) throw new Error("db read failed");
    return null;
  }, () => CO.gptLiveAnswerForTests({ userId: "u-jordan", callSid: null, direction: "inbound", context: async () => "" }));
  process.env.API_URL = prevUrl;
  check("answer route: an inbound answer that can't be built clears the inbound mark it set (no sid needed)", (r as any).refused === "unavailable" && writes.some((w) => /call_status = 'initiated'/.test(w)) && writes.some((w) => /SET call_status = 'failed'.*call_status IN \('initiated'/.test(w)) && writes.findIndex((w) => /call_status = 'failed'/.test(w)) > writes.findIndex((w) => /call_status = 'initiated'/.test(w)), { r, writes });
}

// ---------------------------------------------------------------- a text sent to Cue by mistake never becomes an obligation
{
  const TB = await import("../../src/services/takeBack.js");
  const mom = "Mom: landing at 6, can you pick me up?";
  const momLines = [{ at: "2026-11-07T22:00", text: mom, via: "text" as const }, { at: "2026-11-07T22:01", text: "sorry wrong person", via: "text" as const }];
  check("the Mom text reads as addressed to someone else, whatever pronouns follow ('me'); family and partner terms are strong", MT.meantForSomeoneElse(mom) && MT.meantForSomeoneElse("babe, I'm outside") && MT.meantForSomeoneElse("Ma, call me") && MT.meantForSomeoneElse("hey babe, we're running late"));
  check("casual addressees with their own news are theirs to Cue ('Dude, the investor said yes!', 'Bro, I finally shipped it')", !MT.meantForSomeoneElse("Dude, the investor said yes!") && !MT.meantForSomeoneElse("Bro, I finally shipped it") && MT.meantForSomeoneElse("hey bro, running late"));
  const pair = (a: string, b: string) => MT.withoutDisowned([{ at: "2026-11-06T19:00", text: a, via: "text" }, { at: "2026-11-06T19:01", text: b, via: "text" }]);
  check("...so with 'ignore that' after them, both lines stay", pair("Dude, the investor said yes!", "ignore that").length === 2 && pair("Bro, I finally shipped it", "ignore that").length === 2);
  check("the threads read and the picture never use the Mom text (both lines out)", MT.withoutDisowned(momLines).length === 0 && TB.takenBack(momLines).map((l) => l.text).join() === mom);
  check("a burst line counts only when it's itself addressed elsewhere", MT.withoutDisowned([{ at: "2026-11-07T22:00", text: "remind me to call Dana at 6", via: "text" }, { at: "2026-11-07T22:00", text: mom, via: "text" }, { at: "2026-11-07T22:01", text: "sorry wrong person", via: "text" }]).map((l) => l.text).join() === "remind me to call Dana at 6");

  // A small stand-in database: the rows a turn (or a job, or a call) may have written around the Mom text.
  const D = (iso: string) => new Date(iso);
  const world = (o: { texts: { at: string; text: string }[] }) => {
    const W = {
      texts: o.texts,
      reminders: [] as any[], tasks: [] as any[], candidates: [] as any[], asks: [] as any[], threads: [] as any[], intent: [] as any[],
      goalStates: [] as any[], loopRefs: [] as string[][], decisions: [] as any[], intentWrites: 0,
    };
    const win = (rows: any[], p: any[], col = "created_at") => rows.filter((r) => r[col] >= p[1] && r[col] < p[2]);
    const handle = (sql: string, p: any[]): { rows: any[]; rowCount?: number } | null => {
      const q = String(sql).trim();
      if (/^SET statement_timeout|^RESET statement_timeout/.test(q)) return { rows: [] };
      if (/FROM co_memories/.test(q)) return { rows: [...W.texts].reverse().map((t) => ({ created_at: D(t.at), content: `User said: ${t.text}` })) };
      if (/^SELECT id, what FROM member_reminders/.test(q)) return { rows: win(W.reminders, p).filter((r) => !r.sent_at) };
      if (/^UPDATE member_reminders/.test(q)) { const r = W.reminders.find((x) => x.id === p[0]); if (r) { r.retired = true; } return { rows: [], rowCount: r ? 1 : 0 }; }
      if (/^SELECT id, message FROM member_relays/.test(q)) return { rows: [] };
      if (/^SELECT ask_id, ask_text FROM ask_checkins/.test(q)) return { rows: win(W.asks, p).filter((a) => !a.resolved) };
      if (/^UPDATE ask_checkins/.test(q)) { const a = W.asks.find((x) => x.ask_id === p[1]); if (a) a.resolved = true; return { rows: [], rowCount: a ? 1 : 0 }; }
      if (/SELECT intent FROM co_profiles/.test(q)) return { rows: [{ intent: W.intent }] };
      if (/^UPDATE co_profiles/.test(q)) { W.intentWrites++; return { rows: [] }; }
      if (/FROM goal_states/.test(q)) return { rows: [] };
      if (/INSERT INTO goal_states/.test(q)) { W.goalStates.push(p); return { rows: [], rowCount: 1 }; }
      if (/^SELECT id, their_words, source/.test(q)) return { rows: win(W.tasks, p).filter((t) => t.status === "open") };
      if (/^UPDATE co_tasks/.test(q)) { const t = W.tasks.find((x) => x.id === p[0] && x.status === "open"); if (t) t.status = "dropped"; return { rows: [], rowCount: t ? 1 : 0 }; }
      if (/^SELECT id, opened_quote FROM member_threads/.test(q)) return { rows: win(W.threads, p, "opened_at").filter((t) => t.status === "open") };
      if (/^UPDATE member_threads/.test(q)) { const t = W.threads.find((x) => x.id === p[0]); if (t) { t.status = "changed"; t.closed_quote = /closed_quote = NULL/.test(q) ? null : "?"; } return { rows: [], rowCount: t ? 1 : 0 }; }
      if (/^UPDATE open_loops/.test(q)) { W.loopRefs.push(p[1]); return { rows: [], rowCount: p[1].length }; }
      if (/^UPDATE proactive_candidates/.test(q)) { const hit = W.candidates.filter((c) => c.status === "pending" && p[1].includes(c.target_key) && !p[2].includes(c.type)); hit.forEach((c) => (c.status = "skipped")); return { rows: [], rowCount: hit.length }; }
      if (/INSERT INTO harness_decisions/.test(q)) { W.decisions.push(p); return { rows: [] }; }
      if (/INSERT INTO commitment|harness_decisions/.test(q)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    };
    const run = (message: string, at: string) => withDb((sql, p) => handle(sql, p), () => TB.settleTakeBack("u-jordan", message, D(at), { query: async (sql: string, p: any[] = []) => handle(sql, p) ?? { rows: [] } }));
    return { W, run };
  };

  // A) the Mom case: what the reply to it wrote is settled; nothing is left active.
  {
    const { W, run } = world({ texts: [{ at: "2026-11-07T22:00:00.000Z", text: mom }, { at: "2026-11-07T22:01:10.000Z", text: "sorry wrong person" }] });
    W.reminders.push({ id: 1, created_at: D("2026-11-07T21:00:00Z"), what: "call the dentist", sent_at: null }, { id: 2, created_at: D("2026-11-07T22:00:20Z"), what: "pick up at the airport, landing at 6", sent_at: null });
    W.tasks.push({ id: 7, created_at: D("2026-11-06T10:00:00Z"), their_words: "find a climbing gym", source: "ask", status: "open" }, { id: 8, created_at: D("2026-11-07T22:00:30Z"), their_words: mom, source: "promise", kind: "work", followup: null, status: "open", dispatch_key: null });
    W.asks.push({ ask_id: "ask-pickup", ask_text: "someone to pick them up, landing at 6", created_at: D("2026-11-07T22:00:10Z") });
    W.threads.push({ id: "th-1", opened_quote: "landing at 6", opened_at: D("2026-11-07T22:00:00Z"), status: "open" }, { id: "th-2", opened_quote: "the pitch to the second fund", opened_at: D("2026-11-07T22:00:00Z"), status: "open" });
    W.intent.push({ id: "g-1", kind: "goal", text: "get picked up when landing at 6", status: "active", created_at: "2026-11-07T22:00:15Z" });
    W.candidates.push({ id: "c-th", type: "window_followup", target_key: "thread:th-1", status: "pending" });
    const settled = await run("sorry wrong person", "2026-11-07T22:01:10.000Z");
    check("A: the Mom case: the reminder, the promise task, the ask, its thread and follow-up are settled", !!settled && W.reminders[1].retired && W.tasks[1].status === "dropped" && W.asks[0].resolved && W.threads[0].status === "changed" && W.candidates[0].status === "skipped", { settled, W: { r: W.reminders, t: W.tasks, a: W.asks, th: W.threads, c: W.candidates } });
    check("A: no false facts: the goal is set aside (stale), never resolved; the thread closes with no quote; another thread in the window stays", W.goalStates.some((g) => g.includes("stale")) && W.intentWrites <= 1 && W.threads[0].closed_quote === null && W.threads[1].status === "open", { gs: W.goalStates, iw: W.intentWrites });
    check("A: nothing from before it is touched", !W.reminders[0].retired && W.tasks[0].status === "open");
    check("A: the loops closed are only the settled ask's and task's", JSON.stringify(W.loopRefs) === JSON.stringify([["ask:ask-pickup", "task:8"]]), W.loopRefs);
    check("A: recorded with why (turn.take_back, the window, never their words)", W.decisions.some((p) => JSON.stringify(p).includes("turn.take_back") && JSON.stringify(p).includes("2026-11-07T22:00:00.000Z") && !JSON.stringify(p).includes("landing at 6")));
  }
  // B) an on-purpose reminder the reply to another text set inside the window: untouched.
  {
    const { W, run } = world({ texts: [{ at: "2026-11-07T21:59:50.000Z", text: "remind me to call Dana at 6" }, { at: "2026-11-07T22:00:00.000Z", text: mom }, { at: "2026-11-07T22:01:00.000Z", text: "sorry wrong person" }] });
    W.reminders.push({ id: 3, created_at: D("2026-11-07T22:00:05Z"), what: "call Dana at 6", sent_at: null });
    await run("sorry wrong person", "2026-11-07T22:01:00.000Z");
    check("B: the on-purpose reminder ('call Dana at 6') set while the Mom text arrived is untouched", !W.reminders[0].retired);
  }
  // B2) the on-purpose text sent right after the Mom text (in the burst, not addressed elsewhere): never swept in, its reminder kept.
  {
    const { W, run } = world({ texts: [{ at: "2026-11-07T22:00:00.000Z", text: mom }, { at: "2026-11-07T22:00:20.000Z", text: "remind me to call Dana at 6" }, { at: "2026-11-07T22:00:50.000Z", text: "sorry wrong person" }] });
    W.reminders.push({ id: 4, created_at: D("2026-11-07T22:00:30Z"), what: "call Dana at 6", sent_at: null });
    await run("sorry wrong person", "2026-11-07T22:00:50.000Z");
    check("B2: a reminder from the next text (outside the window, and not its words) is kept", !W.reminders[0].retired);
  }
  // C) a call's follow-up and a call commitment written inside the window: never settled.
  {
    const { W, run } = world({ texts: [{ at: "2026-11-07T22:00:00.000Z", text: mom }, { at: "2026-11-07T22:01:00.000Z", text: "sorry wrong person" }] });
    W.candidates.push({ id: "pc", type: "post_call", target_key: "post_call:CA1", status: "pending", created_at: D("2026-11-07T22:00:30Z") });
    W.tasks.push({ id: 9, created_at: D("2026-11-07T22:00:40Z"), their_words: "(said on a call)", source: "promise", kind: "work", followup: null, status: "open", dispatch_key: "call:abc" });
    W.tasks.push({ id: 10, created_at: D("2026-11-07T22:00:45Z"), their_words: "landing at 6, can you pick me up", source: "promise", kind: "work", followup: null, status: "open", dispatch_key: "call:def" });
    await run("sorry wrong person", "2026-11-07T22:01:00.000Z");
    check("C: the post_call follow-up and the call-commitment tasks are untouched", W.candidates[0].status === "pending" && W.tasks.every((t) => t.status === "open"), { c: W.candidates, t: W.tasks });
  }
  // On-purpose rows next to the Mom text that share a word or two with it: never settled; "pick Mom up at 6" still is.
  {
    const { W, run } = world({ texts: [{ at: "2026-11-07T22:00:00.000Z", text: mom }, { at: "2026-11-07T22:01:00.000Z", text: "sorry wrong person" }] });
    for (const [id, what] of [[21, "remind me at 6 to pick up the dry cleaning"], [22, "call the landlord about the landing gear repair"], [23, "pick up Maya from practice"], [24, "pick Mom up at 6"]] as const) W.reminders.push({ id, created_at: D("2026-11-07T22:00:20Z"), what, sent_at: null });
    await run("sorry wrong person", "2026-11-07T22:01:00.000Z");
    const retired = W.reminders.filter((r) => r.retired).map((r) => r.id);
    check("one shared word never settles: the dry-cleaning reminder, the landing-gear one and 'pick up Maya from practice' stay; 'pick Mom up at 6' is retired", JSON.stringify(retired) === JSON.stringify([24]), retired);
    check("fromTheText: two content words and most of the row's own", !TB.fromTheText("landing gear", [mom]) && !TB.fromTheText("pick up Maya from practice", [mom]) && TB.fromTheText("pick Mom up at 6", [mom]) && TB.fromTheText(mom, [mom]));
  }
  // A real request to Cue followed by an unrelated "lol": nothing read, nothing settled.
  let read = 0;
  const untouched = await TB.settleTakeBack("u-jordan", "lol", new Date(), { query: async () => { read++; return { rows: [] }; } });
  const untouched2 = await TB.settleTakeBack("u-jordan", "haha nice", new Date(), { query: async () => { read++; return { rows: [] }; } });
  check("a real request to Cue then 'lol': untouched (no read, nothing settled)", untouched === null && untouched2 === null && read === 0);
  // "Dude, the investor said yes!" + "ignore that": settles nothing.
  {
    const { W, run } = world({ texts: [{ at: "2026-11-07T22:00:00.000Z", text: "Dude, the investor said yes!" }, { at: "2026-11-07T22:00:40.000Z", text: "ignore that" }] });
    W.tasks.push({ id: 12, created_at: D("2026-11-07T22:00:10Z"), their_words: "Dude, the investor said yes!", source: "ask", status: "open" });
    const r = await run("ignore that", "2026-11-07T22:00:40.000Z");
    check("'Dude, the investor said yes!' + 'ignore that': nothing settled", r === null && W.tasks[0].status === "open");
  }
  check("the inbound turn settles a take-back before the reply", /T\.settleTakeBack\(user\.id, resolvedContent\)/.test(src("src/routes/sendblue.ts")));
}

console.log(`call review 11-07: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
