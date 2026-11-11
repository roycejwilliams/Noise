// A reply whose substance the fact check cut is written again once, whole, instead of sending what's left (Royce, 2026-11-11). From a
// real 11-11 turn, the member's two messages with the three events Cue had sent as facts: "What do you think is the best option for me
// this week?" and "What's the details and why it fits?". Zero tokens: the send step runs with a scripted fact check (what the real one
// returned that morning, then what it returns on a draft that keeps to the facts) and the model's drafts are scripted. Layer 1 proves
// the delivery: what reaches the member is the second draft, whole, in one text, with no remnant and no promise in its place. Whether
// the model writes that second draft well (one pick, the comparison, the benefit and its limit) is model judgment: layer 1 can't prove it.
//   npx tsx evals/reply/cutRedraft.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const CR = await import("../../src/agent/cutRedraft.js");
const RG = await import("../../src/harness/replyGrounding.js");
const CRP = await import("../../src/agent/conversationReply.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

// The three events Cue had sent (as the turn's facts would carry them), with an invented member name.
const SENT = [
  { name: "Speech & NLP Paper Reading Meetup", url: "https://lu.ma/speech-nlp-papers", facts: "Pizza, 45 minutes of paper discussion, no pitching." },
  { name: "SGLang x NVIDIA Meetup", url: "https://lu.ma/sglang-nvidia", facts: "Tonight 5:30-8:30pm. Hosted by NVIDIA, SGLang and Modal. Drinks and talks with engineers working on inference and tooling." },
  { name: "Founder Dinner", url: "https://lu.ma/founder-dinner", facts: "A seated dinner for founders." },
];
const ASK_BEST = "What do you think is the best option for me this week?";
const ASK_WHY = "What’s the details and why it fits?";

type G = import("../../src/agent/cutRedraft.js").CutRead;
// The send step with a scripted fact check: check(draft) gives the check's result for that draft.
const turn = (message: string, check: (draft: string) => G, o: { redraftLeft?: () => boolean; safety?: boolean } = {}) => {
  const sends: string[] = [];
  let last: G | null = null;
  const t = createConversationTools({
    userId: "u", phoneNumber: "+14155550101", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true,
    safetyConcern: !!o.safety,
    sendCoReply: async ({ message: m }: any) => (sends.push(m), true), facts: { add: () => {}, text: () => SENT.map((s) => `${s.name}: ${s.facts} ${s.url}`).join("\n") },
    gate: async (d: string) => ((last = check(d)), last.final),
    lastGrounding: () => last,
    redraftLeft: o.redraftLeft,
    dryRunReferents: SENT.map((s) => ({ name: s.name, url: s.url })),
  } as any) as any;
  const send = (m: string, toolCallId = "x") => t.tools.sendReply.execute({ message: m }, { toolCallId, messages: [] });
  // The pick's link sent on its own first, as DECISION_LINE asks (Royce, 2026-11-11): "send its link again with shareLink before your reply".
  const shareLink = (url: string) => t.tools.shareLink.execute({ urls: [url] }, { toolCallId: "link", messages: [] });
  return { send, shareLink, state: t.state, sends };
};
const fail = (reason: string) => ({ name: "claim_other_person", pass: false, reason });

// ---------------------------------------------------------------- 06:05, as it happened: the comparison cut, the headline left
const DRAFT_0605 = "Tonight's SGLang x NVIDIA meetup is probably it. It's engineers working on inference and tooling specifically, happening this evening, and that's a much better room for finding someone technical than a basketball game or happy hour mixer.";
const CUT_0605: G = { draft: DRAFT_0605, final: "Tonight's SGLang x NVIDIA meetup is probably it.", outcome: "cut", checks: [fail('other_person: "It\'s engineers working on inference and tooling specifically"')] };
// The redraft that keeps to the facts (scripted: what a good second draft looks like; the model's real one is the paid check's to judge).
const REDRAFT_0605 = "Tonight's SGLang x NVIDIA meetup is my pick. The page says it's drinks and talks with engineers working on inference and tooling, hosted by NVIDIA, SGLang and Modal, which beats the paper reading (a 45 minute discussion, good for learning, less for meeting) and the founder dinner (founders, not engineers).\n\nWhat you'd get is mostly learning from people doing inference work, with a chance to meet an engineer you could build with. Who actually shows up isn't something I can know.\n\nTonight 5:30-8:30pm: https://lu.ma/sglang-nvidia";
{
  const t = turn(ASK_BEST, (d) => (d === DRAFT_0605 ? CUT_0605 : { draft: d, final: d, outcome: "as_drafted", checks: [] }));
  await t.shareLink("https://lu.ma/sglang-nvidia");
  const r1 = await t.send(DRAFT_0605);
  check("06:05: a pick whose comparison the check cut isn't sent as its headline: one whole redraft, with the reason", r1.ok === false && /fact check couldn't back part of that reply/.test(r1.error) && /inference and tooling specifically/.test(r1.error) && t.sends.length === 0 && !t.state.sent, r1);
  const r2 = await t.send(REDRAFT_0605);
  check("... the redraft goes out whole, as one reply", r2.ok !== false && t.state.replyCount === 1, r2);
  const visible = t.state.sentMessages.join("\n\n");
  check("final 06:05 sequence: one pick, a comparison with the options already sent, the benefit and its limit, the link", /my pick/.test(visible) && /paper reading/.test(visible) && /founder dinner/.test(visible) && /learning/.test(visible) && /meet an engineer/.test(visible) && /isn't something I can know/.test(visible) && /lu\.ma\/sglang-nvidia/.test(visible), visible);
  check("... and never the bare headline on its own", !t.state.sentMessages.includes("Tonight's SGLang x NVIDIA meetup is probably it."), t.state.sentMessages);
  check("... the pick's link went once, first, on its own (a link sent before the reply doesn't stop the redraft)", t.state.sentMessages[0] === "https://lu.ma/sglang-nvidia" && t.state.sentMessages.filter((m: string) => m === "https://lu.ma/sglang-nvidia").length === 1, t.state.sentMessages);
}
// ---------------------------------------------------------------- 06:07, as it happened: details stripped to the honest line + a promise
const DRAFT_0607 = "It's tonight, 5:30 to 8:30pm, NVIDIA and SGLang and Modal hosting the night before the SGLang Summit. Free, still open, no exact venue listed yet, so worth checking the page before heading out.";
const HONEST_0607 = "Don't have the details confirmed yet, so I won't guess at the fit. What I do have: I'll follow up with you Wed morning on how both the SF dinner and the Start UP Funding & Legal event went.";
const STRIP_0607: G = { draft: DRAFT_0607, final: HONEST_0607, outcome: "stripped", notSure: true, checks: [fail('other_person: "NVIDIA and SGLang"'), fail('other_person: "Modal hosting the night"'), { name: "claim_detail", pass: false, reason: 'detail: "still open" (that detail is from an earlier read, not checked since: say it as of then, or check it live)' }] };
const REDRAFT_0607 = "Tonight 5:30-8:30pm, hosted by NVIDIA, SGLang and Modal: drinks and talks with engineers working on inference and tooling. The page didn't list an exact venue when I read it, so check it before you head out.\n\nWhy it fits: it's mainly a room to learn from people doing inference work, and maybe meet an engineer to build with. That second part depends on who comes, which I can't know.\n\nhttps://lu.ma/sglang-nvidia";
{
  const t = turn(ASK_WHY, (d) => (d === DRAFT_0607 ? STRIP_0607 : { draft: d, final: d, outcome: "as_drafted", checks: [] }));
  await t.shareLink("https://lu.ma/sglang-nvidia");
  const r1 = await t.send(DRAFT_0607);
  check("06:07: details the check stripped to the honest line aren't replaced by it: one whole redraft", r1.ok === false && /Write the whole reply again/.test(r1.error) && /never put a promise or a check-in in its place/.test(r1.error) && t.sends.length === 0, r1);
  await t.send(REDRAFT_0607);
  const visible = t.state.sentMessages.join("\n\n");
  check("final 06:07 sequence: the details, the benefit type and its limit, the link, together", t.state.replyCount === 1 && /5:30-8:30pm/.test(visible) && /learn from people doing inference work/.test(visible) && /can't know/.test(visible) && /lu\.ma\/sglang-nvidia/.test(visible), visible);
  check("... no 'not confirmed' text before the details (no contradiction), no unrelated promise, no presumed attendance", !/confirmed yet/.test(visible) && !/follow up/i.test(visible) && !/how both/.test(visible) && !/went\b/.test(visible), visible);
}
// ---------------------------------------------------------------- bounded: once a turn, then the existing behaviour
{
  const t = turn(ASK_BEST, () => CUT_0605);
  await t.shareLink("https://lu.ma/sglang-nvidia");
  await t.send(DRAFT_0605);
  const r2 = await t.send(DRAFT_0605);
  check("a second cut in the same turn goes out as the check left it (one redraft a turn, never a loop)", r2.ok !== false && t.state.sentMessages.includes(CUT_0605.final), { r2, sent: t.state.sentMessages });
}
{
  const t = turn(ASK_BEST, () => CUT_0605, { redraftLeft: () => false });
  const r = await t.send(DRAFT_0605);
  // No redraft can follow, so the pick's link goes first on its own (#448, now on a decision ask too), then what the check left.
  check("no redraft when none can follow (last step, last seconds): what's left goes, as before, after the pick's link", r.ok !== false && t.state.sentMessages[0] === "https://lu.ma/sglang-nvidia" && t.state.sentMessages[1] === CUT_0605.final, { r, sent: t.state.sentMessages });
}
{
  const t = turn(ASK_BEST, () => CUT_0605);
  const r = await t.send(DRAFT_0605, "plain-text-reply");
  check("the plain text sent after the loop ended is never sent back for a redraft", r.ok !== false && t.state.sent, r);
}
{
  const t = turn("I don't feel safe tonight", () => CUT_0605, { safety: true });
  const r = await t.send(DRAFT_0605);
  check("never on a turn that touches their safety", r.ok !== false && t.state.sent, r);
}
// ---------------------------------------------------------------- what counts as substance (pure)
const base = { draft: DRAFT_0605, final: CUT_0605.final, outcome: "cut", checks: CUT_0605.checks };
check("a cut that took most of the answer is substance", CR.cutLostSubstance(base));
check("a cut of a word or a filler line isn't", !CR.cutLostSubstance({ ...base, draft: "Tonight's SGLang x NVIDIA meetup is probably it. Honestly.", final: "Tonight's SGLang x NVIDIA meetup is probably it." }));
check("stripped to the honest line is substance; other stripped lines (world, night care) aren't", CR.cutLostSubstance({ ...STRIP_0607 }) && !CR.cutLostSubstance({ ...STRIP_0607, notSure: false }));
check("as drafted, the check's own redraft, an emptied reply and a kept promise never are", !CR.cutLostSubstance({ ...base, outcome: "as_drafted" }) && !CR.cutLostSubstance({ ...base, outcome: "redrafted" }) && !CR.cutLostSubstance({ ...base, final: "" }) && !CR.cutLostSubstance({ ...base, keptPromise: true }));
check("a style flag alone is never a cut", !CR.cutLostSubstance({ ...base, checks: [{ name: "pref_style", pass: false, reason: "style" }] }));
check("the note names the check's own reasons, at most four", (CR.cutRedraftNote(STRIP_0607).match(/other_person|detail:/g) ?? []).length === 3);

// ---------------------------------------------------------------- the honest line carries what's ahead only when they asked about it
check("'what's the details and why it fits' never gets the ahead line", !RG.asksWhatsAhead(ASK_WHY) && !RG.asksWhatsAhead(ASK_BEST));
check("questions about what's ahead do", RG.asksWhatsAhead("what's coming up for me?") && RG.asksWhatsAhead("Anything planned on your end this week?") && RG.asksWhatsAhead("are you following up on that?") && RG.asksWhatsAhead("when will you check in?"));

// ---------------------------------------------------------------- the decision and why-it-fits lines ride only on those asks
check("'best option' and 'which one' are decision asks", CRP.DECISION_ASK.test(ASK_BEST) && CRP.DECISION_ASK.test("which one should I go to?") && CRP.DECISION_ASK.test("should I go to the dinner or the meetup?"));
check("'why it fits' is a fit ask; a plain question is neither", CRP.FIT_ASK.test(ASK_WHY) && !CRP.DECISION_ASK.test("what time is it?") && !CRP.FIT_ASK.test("what time is it?"));
// With finds sent: a sent find's facts in this reply's facts (services/turnContext.ts sentFindFacts starts "Cue sent them").
const rf = () => ({ facts: [{ id: "F1", kind: "known", text: 'Cue sent them "SGLang x NVIDIA Meetup" on Nov 10; the link it sent: https://lu.ma/sglang-nvidia.' }], instructions: [] }) as any;
const r1 = rf(); CRP.addAnswerShapeLines(r1, ASK_BEST);
const r2 = rf(); CRP.addAnswerShapeLines(r2, ASK_WHY);
const r3 = rf(); CRP.addAnswerShapeLines(r3, "just landed");
check("a decision ask gets the pick-and-compare line and the benefit line; a why-it-fits ask the benefit line; others nothing", r1.instructions.length === 2 && r1.instructions.includes(CRP.DECISION_LINE) && r1.instructions.includes(CRP.FIT_LINE) && r2.instructions.length === 1 && r2.instructions[0] === CRP.FIT_LINE && r3.instructions.length === 0, { r1, r2, r3 });
// Review of #457: only when Cue has sent them finds to choose among; the misses and false hits it found.
const none = () => ({ facts: [], instructions: [] }) as any;
const n1 = none(); CRP.addAnswerShapeLines(n1, "Which of the three is cheapest?");
const n2 = none(); CRP.addAnswerShapeLines(n2, "would you take the offer?");
const n3 = none(); CRP.addAnswerShapeLines(n3, ASK_BEST);
check("no finds sent: no decision or benefit line, whatever the ask", n1.instructions.length === 0 && n2.instructions.length === 0 && n3.instructions.length === 0);
const s1 = rf(); CRP.addAnswerShapeLines(s1, ASK_BEST, false);
const s2 = rf(); CRP.addAnswerShapeLines(s2, ASK_BEST, true);
check("the caller's finds-sent read decides (referents or recent sends)", s1.instructions.length === 0 && s2.instructions.length === 2);
check("now caught: 'Dinner or meetup?', 'What would you do?', 'is the dinner worth it?'", ["Dinner or meetup?", "What would you do?", "is the dinner worth it?"].every((m) => CRP.DECISION_ASK.test(m)));
check("not decisions: 'should i do this or not', 'would you take the offer?'", !CRP.DECISION_ASK.test("should i do this or not") && !CRP.DECISION_ASK.test("should i do this or not?") && !CRP.DECISION_ASK.test("would you take the offer?"));
check("fit asks widened: 'why does this fit', 'is this relevant to me', 'relevant to me?'", ["why does this fit?", "Why does that one suit me", "is this relevant to me?", "relevant to me?"].every((m) => CRP.FIT_ASK.test(m)));

// ---------------------------------------------------------------- review of #457: never a redraft once something already answered them
{
  const t = turn(ASK_BEST, (d) => (d === DRAFT_0605 ? CUT_0605 : { draft: d, final: d, outcome: "as_drafted", checks: [] }));
  await t.shareLink("https://lu.ma/sglang-nvidia");
  t.state.sentMessages.push("Tonight's SGLang x NVIDIA meetup is my pick.");
  t.state.sent = true;
  t.state.workSinceSend = true;
  const r = await t.send(DRAFT_0605);
  check("a cut after an earlier text already answered this turn goes as the check left it (no 'answer everything' redraft restating it)", r.ok !== false && !t.state.cutNudged, r);
}
{
  const t = turn(ASK_BEST, (d) => (d === DRAFT_0605 ? CUT_0605 : { draft: d, final: d, outcome: "as_drafted", checks: [] }));
  await t.shareLink("https://lu.ma/sglang-nvidia");
  t.state.sentMessages.push("Let me look");
  t.state.holdLines.push("Let me look");
  const r = await t.send(DRAFT_0605);
  check("... a holding line isn't an answer: the redraft still happens", r.ok === false && /Write the whole reply again/.test(r.error), r);
}

console.log(`cut redraft: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
