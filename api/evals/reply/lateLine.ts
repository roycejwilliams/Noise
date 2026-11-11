// No "looking" text when a search starts; one optional late line (Royce, 2026-11-11: "It doesn't need to say anything, it could just be
// a tapback as an acknowledgement"; then, with the measured wait (median 33s, p90 64s, max 115s), one late line, approved wording).
// Zero tokens: the search is stubbed, the late line's draft is injected, and its wait is shortened for the test. Whether the real Haiku
// draft reads well is model judgment, which layer 1 can't prove.
//   npx tsx evals/reply/lateLine.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const L = await import("../../src/agent/loopTools.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ASK = "Can you find me a wine night in SF this week where I can whine down and chill";
const GOOD = "Whine down is exactly the right energy for a Thursday.";
const mk = (o: { draft?: (w: string) => Promise<string | null>; after?: number; arrived?: number; onCall?: boolean; isVoice?: boolean } = {}) => {
  const drafts: string[] = [];
  const t = createConversationTools({
    userId: "u", phoneNumber: "+14155550101", resolvedContent: ASK, isVoice: !!o.isVoice, onCall: !!o.onCall, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, stubSearch: true,
    stubEvents: [{ name: "Wine Down Thursday", url: "https://lu.ma/wine-down-test", lines: ["Thursday 7pm."] }],
    sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
    lateLineAfterMs: o.after ?? 30,
    messageArrivedAt: o.arrived ?? Date.now(),
    lateLineDraft: async (w: string) => (drafts.push(w), (o.draft ?? (async () => GOOD))(w)),
    // No redraft guards in the way: the reply here is the answer as written.
    redraftLeft: () => false,
  } as any) as any;
  const search = (id = "s") => t.tools.searchEvents.execute({ what: "wine night", city: "SF" }, { toolCallId: id, messages: [] });
  const reply = (m: string) => ((t.state.workSinceSend = true), t.tools.sendReply.execute({ message: m }, { toolCallId: "r", messages: [] }));
  return { t, search, reply, drafts };
};

// ---------------------------------------------------------------- no text when a search starts
{
  const { t, search } = mk({ after: 10_000 });
  const r = await search();
  check("a search sends no text when it starts (the tapback on receipt is the acknowledgement)", r.ok === true && t.state.sentMessages.length === 0 && t.state.holdLines.length === 0, { r, sent: t.state.sentMessages });
  const schema = JSON.stringify(Object.keys((t.tools.searchEvents.inputSchema as any).shape ?? {})) + JSON.stringify(Object.keys((t.tools.webSearch.inputSchema as any).shape ?? {})) + JSON.stringify(Object.keys((t.tools.searchPosts.inputSchema as any).shape ?? {}));
  check("no search tool takes a whileLooking line", !/whileLooking/.test(schema), schema);
}
// ---------------------------------------------------------------- answered before the wait: no line
{
  const { t, search, reply, drafts } = mk({ after: 60 });
  await search();
  await reply("Wine Down Thursday at 7 is the quiet one.");
  await wait(120);
  check("a search answered before the wait gets no late line (no draft asked for, nothing extra sent)", drafts.length === 0 && t.state.holdLines.length === 0 && t.state.sentMessages.length === 1, { drafts, sent: t.state.sentMessages });
}
// ---------------------------------------------------------------- past the wait: at most one line, then the answer as normal
{
  const { t, search, reply, drafts } = mk({ after: 20 });
  await search("a");
  await search("b");
  await wait(80);
  check("past the wait with nothing sent: one late line, from their message alone", drafts.length === 1 && drafts[0].includes("wine night") && t.state.holdLines.length === 1 && t.state.holdLines[0] === GOOD && t.state.sentMessages.length === 1, { drafts, held: t.state.holdLines });
  await search("c");
  await wait(60);
  check("... never a second one in the turn, however many searches", drafts.length === 1 && t.state.holdLines.length === 1);
  const r = await reply("Wine Down Thursday at 7 is the quiet one: https://lu.ma/wine-down-test");
  check("... and the answer still goes normally after it, as the reply (the late line answers nothing)", r.ok !== false && t.state.replyCount === 1 && t.state.sent && t.state.sentMessages.length === 2 && !t.state.holdLines.includes(t.state.sentMessages[1]), { r, sent: t.state.sentMessages });
}
// ---------------------------------------------------------------- the wait runs from their message, not the search
{
  const { t, search, drafts } = mk({ after: 45_000, arrived: Date.now() - 50_000 });
  await search();
  await wait(40);
  check("the wait counts from when their message arrived: a search starting 50s in sends its line straight away", drafts.length === 1 && t.state.holdLines.length === 1);
  check("the named wait is 45 seconds", L.LATE_LINE_AFTER_MS === 45_000);
}
// ---------------------------------------------------------------- a draft that fails the check: nothing, no retry
for (const bad of ["Still looking, almost there.", "I'm on it!", "Looking into wine bars now.", "A wine night in SF to whine down and chill.", "Found a couple already.", "Give me a minute.", "Two minutes and I'll have it.", "Love it. Wine nights are the best."]) {
  const { t, search, drafts } = mk({ after: 10, draft: async () => bad });
  await search();
  await wait(60);
  check(`a status, opener, restatement, result hint, time or two-sentence line sends nothing, with no retry: "${bad}"`, drafts.length === 1 && t.state.sentMessages.length === 0 && t.state.holdLines.length === 0, { bad, problem: L.lateLineProblem(bad, ASK) });
}
for (const empty of [null, "", "(empty)", "\"\""]) {
  const { t, search } = mk({ after: 10, draft: async () => empty });
  await search();
  await wait(50);
  check(`an empty draft sends nothing: ${JSON.stringify(empty)}`, t.state.sentMessages.length === 0);
}
{
  const { t, search } = mk({ after: 10, draft: async () => { throw new Error("model down"); } });
  await search();
  await wait(50);
  check("a draft that fails sends nothing", t.state.sentMessages.length === 0);
}
// ---------------------------------------------------------------- never on a call or a voice note
{
  const call = mk({ after: 10, onCall: true, isVoice: true });
  await call.search();
  await wait(50);
  const voice = mk({ after: 10, isVoice: true });
  await voice.search();
  await wait(50);
  check("never on a call or a voice note (no draft, nothing sent)", call.drafts.length === 0 && voice.drafts.length === 0 && call.t.state.sentMessages.length === 0 && voice.t.state.sentMessages.length === 0);
}
// ---------------------------------------------------------------- the answer is going out when it fires: nothing
{
  const { t, search, drafts } = mk({ after: 10 });
  await search();
  t.state.sendsInFlight = 1;
  await wait(50);
  check("the answer already sending when the wait ends: no late line", drafts.length === 0 && t.state.holdLines.length === 0);
}
{
  let release: () => void = () => {};
  const { t, search } = mk({ after: 10, draft: () => new Promise((r) => (release = () => r(GOOD))) });
  await search();
  await wait(30);
  t.state.sentMessages.push("the answer");
  t.state.sent = true;
  release();
  await wait(20);
  check("the answer went while the line was being drafted: the line is dropped", t.state.holdLines.length === 0 && t.state.sentMessages.length === 1);
}
// ---------------------------------------------------------------- the check itself (pure)
check("'I'm on it' and 'on it' style status phrases are caught anywhere in the line", ["I'm on it", "Ok I'm on it, wine it is", "We're on it.", "Still on it"].every((x) => L.STATUS_LINE.test(x) && L.lateLineProblem(x, ASK) !== null));
check("a line about them passes", L.lateLineProblem(GOOD, ASK) === null && L.lateLineProblem("A Thursday wind-down sounds earned.", ASK) === null, [L.lateLineProblem(GOOD, ASK), L.lateLineProblem("A Thursday wind-down sounds earned.", ASK)]);
check("the draft is cleaned to one line without quotes; 'none' or '(empty)' is nothing", L.cleanLateLine("\"Whine down, yes.\"\nextra") === "Whine down, yes." && L.cleanLateLine("(empty)") === "" && L.cleanLateLine("None.") === "");

console.log(`late line: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
