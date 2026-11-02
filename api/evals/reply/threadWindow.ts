// The reply keeps the whole thread (2026-11-02, a member's thread on dev; the scenario here is made up, with the same shape):
//   1. the window counts their texts, not rows, within a character budget: one long answer of Cue's in bubbles no longer pushes out what
//      they said three texts ago, so news and feedback they already gave reach the reply (Cue asked for the feedback again when it didn't);
//   2. replaying the thread turn by turn, nothing they say later reaches an earlier turn's prompt;
//   3. a text of theirs in paragraphs is their words in full, and nothing that isn't theirs (a call's follow-up, an old Mo row) is;
//   4. the thread read sees each of their texts whole enough to tell their own news from a status report, and its yes still cuts:
//      a clause Cue added about their thread is never let through because the rest of the sentence quotes them.
// Layer 1: zero tokens, no database. The model is a fake fetch answering by what each request is for; where a real reply matters, the
// fake gives the shape of reply Cue sent before this change, so the checks are about what code feeds and keeps, never about wording.
//   npx tsx evals/reply/threadWindow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

// ---- the fake model
let threadReports: number[] = [];
let claims: unknown[] = [];
let replyText = "";
const systems: string[] = [];
const threadPrompts: string[] = [];
const kinds: string[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const raw = String(init?.body ?? "");
  let body: any = {};
  try { body = JSON.parse(raw); } catch {}
  const sys = Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("\n") : String(body.system ?? "");
  let text = "{}";
  if (/Only the member knows where it stands/.test(raw)) (kinds.push("thread_read"), threadPrompts.push(JSON.stringify(body.messages ?? raw)), (text = JSON.stringify({ reports: threadReports })));
  else if (/You check a text message Cue is about to send/.test(raw)) (kinds.push("claims"), (text = JSON.stringify({ claims })));
  else if (/You are replying by iMessage/.test(sys + raw)) (kinds.push("reply"), systems.push(sys + raw), (text = replyText));
  else kinds.push("other");
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const W = await import("../../src/services/threadWindow.js");
const G = await import("../../src/harness/replyGrounding.js");
const M = await import("../../src/services/memberWorld.js");
const SF = await import("../../src/services/sourceFence.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { readFileSync } = await import("node:fs");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) {
    failed++;
    process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`);
  }
};
const quietLog = console.log;
const quietErr = console.error;
const hush = () => { console.log = () => {}; console.error = () => {}; };
const loud = () => { console.log = quietLog; console.error = quietErr; };

// ---- the thread: an invented member (Jordan, who makes candles) and a shop owner (Priya). One row per text or bubble, as logged.
type Row = { content: string; created_at: Date };
let clock = Date.parse("2026-11-02T16:28:00Z");
const log: Row[] = [];
const them = (t: string) => log.push({ content: `User said: ${t}`, created_at: new Date((clock += 20_000)) }) - 1;
const cue = (...bubbles: string[]) => bubbles.forEach((b) => log.push({ content: `Co replied: ${b}`, created_at: new Date((clock += 2_000)) }));
const FIRST = "Met Priya at her shop, it went well. We might do a weekend pop-up together to see if the candles actually sell, that's what she cares about first. She asked about my scent recipes but I'm not sure I want to share them.\n\nMaybe a simple written agreement first.\n\nShe had two notes:\n1) checkout on my site is slow\n2) my labels look a lot like a big brand's";
them(FIRST);
cue("Her wanting to see them sell first is a good sign.", "Holding back on the recipes is fair.", "Both notes are worth acting on. I've passed both to the team.", "Does the recipe question feel early to you?");
them("Let's talk about Priya for a sec");
cue("Sure, what's on your mind with her?");
them("What should I do? Give me the steps");
cue("Agree on the split before the pop-up.", "Ask what she needs to see to believe they'll sell.", "If she still wants recipes, put it in writing first.", "Bring your sister in before anything moves.", "Run the pop-up as the test.", "Which part feels least settled?");
them("I told her the candles already sell out at markets. How do I work with shops without giving my recipes away?");
cue("The split is between showing what sells and handing over how it's made.", "Wholesale first, no recipes involved.", "Keep the blends written down only at the studio.", "A partner is a bigger conversation.", "For Priya, the pop-up may be enough.", "Which way is this pointing?");
const SAMPLE = them("I dropped off a sample box so she can try them at home");
cue("Smart move.", "Has she said anything about them yet?");
them("I already sent you her notes");
cue("You're right. The slow checkout and the labels, that's what she sent.");
const SUMMARY = them("ok sum up my issue");
cue("The candles sell and that's your leverage; agree terms before recipes.");
const CORRECTION = them("No, I mean the problem with Priya");
cue("That's the part worth slowing down on.");
// Later in the thread they add two things Cue must not know before they say them.
const LATER1 = them("Also her shop closes for a renovation in March");
cue("Then the pop-up wants to be before that.");
const LATER2 = them("And my wax supplier just raised prices");
cue("That changes the wholesale math.");
const LATER_FACTS = [/renovation in March/, /wax supplier just raised prices/];

// What the database holds at the moment a turn's text arrives: every row up to and including it, newest first (the query's order).
const asOf = (i: number) => log.slice(0, i + 1).reverse();
const text = (rows: Row[]) => rows.map((r) => r.content).join("\n");
const oldWindow = (i: number) => asOf(i).slice(0, 20).reverse();

// ------------------------------------------------------------------ 1. the window counts their texts, within a budget
{
  const before = text(oldWindow(SAMPLE));
  const after = text(W.threadWindow(asOf(SAMPLE)));
  check("before: at the sample-box turn the 20-row window had already lost their first text (the two notes)", !before.includes("checkout on my site is slow") && log.slice(0, SAMPLE + 1).length > 20, log.slice(0, SAMPLE + 1).length);
  check("after: their first text, notes and all, is in the window", after.includes("checkout on my site is slow") && after.includes("Maybe a simple written agreement first."));
  check("the window ends on their latest text and runs oldest first", after.endsWith("User said: I dropped off a sample box so she can try them at home") && after.indexOf("Met Priya") < after.indexOf("sample box"));
  const many: Row[] = Array.from({ length: 30 }, (_, i) => ({ content: i % 2 ? `Co replied: line ${i}` : `User said: text ${i}`, created_at: new Date(i * 1000) }));
  const w = W.threadWindow([...many].reverse());
  check(`at most ${W.WINDOW_THEIR_TEXTS} of their texts, plus the line of Cue's the oldest one answered`, w.filter((r) => r.content.startsWith("User said:")).length === W.WINDOW_THEIR_TEXTS && w[0].content === "Co replied: line 9" && w[w.length - 1].content === "Co replied: line 29", w.map((r) => r.content));
  const bubbles: Row[] = [{ content: "User said: hi", created_at: new Date(0) }, ...Array.from({ length: 90 }, (_, i) => ({ content: `Co replied: b${i}`, created_at: new Date(i + 1) }))];
  check(`never more than ${W.WINDOW_MAX_ROWS} rows`, W.threadWindow([...bubbles].reverse()).length === W.WINDOW_MAX_ROWS);
  check("a short thread is all of it", W.threadWindow(asOf(2)).length === 3 && W.threadWindow([]).length === 0);
  // The budget: long rows (an email draft pasted back) are cut with a marker, and the window stops at the budget, newest first.
  const draft = `Co replied: Here's the email draft: ${"word ".repeat(600)}`;
  const heavy: Row[] = [{ content: "User said: old news", created_at: new Date(0) }, ...Array.from({ length: 8 }, (_, i) => ({ content: draft, created_at: new Date(i + 1) })), { content: "User said: so what now", created_at: new Date(99) }];
  const hw = W.threadWindow([...heavy].reverse());
  const chars = hw.reduce((a, r) => a + r.content.length, 0);
  check(`the window stays within ${W.WINDOW_CHARS} characters`, chars <= W.WINDOW_CHARS, chars);
  check("a long row of Cue's is cut with a marker, at most the row size, never dropped whole for being long", hw.some((r) => r.content.startsWith("Co replied:") && r.content.endsWith(W.TRIMMED) && r.content.length <= W.WINDOW_ROW_CHARS + W.TRIMMED.length));
  const sentences = `Co replied: ${Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of the draft is here.`).join(" ")}`;
  const cutAt = W.trimCueRow(sentences);
  check("Cue's row is cut at a sentence end, never mid-word", cutAt.endsWith(`is here.${W.TRIMMED}`) && cutAt.length <= W.WINDOW_ROW_CHARS + W.TRIMMED.length, cutAt.slice(-80));
  check("the marker says what was left out, and whose", /the rest of this message of Cue's is left out/.test(W.TRIMMED));
  // Review of #343: their own text is never cut. A long text of theirs whose tail takes back its start ("…he hasn't signed") stays whole;
  // when it can't fit with what's older, the older rows go, never part of it.
  const takesBack = `User said: ${"Some context about the shop and the pop-up plans. ".repeat(40)}I thought she'd signed the agreement. Actually she hasn't signed anything yet.`;
  const tb = W.threadWindow([{ content: takesBack, created_at: new Date(5) }, { content: "Co replied: Got it.", created_at: new Date(4) }, { content: "User said: earlier text", created_at: new Date(3) }].map((r) => r).sort((a, b) => +b.created_at - +a.created_at), { chars: takesBack.length + 10 });
  check("a long text of theirs over the row size stays whole, its tail included", tb.some((r) => r.content === takesBack) && !tb.some((r) => r.content.endsWith(W.TRIMMED)) && takesBack.length > W.WINDOW_ROW_CHARS, takesBack.length);
  check("…and when the budget can't hold it with older rows, the older rows are dropped", tb.length === 1, tb.map((r) => r.content.slice(0, 30)));
  const mid = W.threadWindow([{ content: "User said: what now", created_at: new Date(9) }, { content: takesBack, created_at: new Date(5) }, { content: "User said: earlier text", created_at: new Date(3) }].sort((a, b) => +b.created_at - +a.created_at), { chars: takesBack.length + 10 });
  check("an older long text of theirs that doesn't fit is left out whole, never cut to fit", mid.length === 1 && mid[0].content === "User said: what now", mid.map((r) => r.content.slice(0, 30)));
  check("the newest rows are the ones kept, ending on their latest text", hw[hw.length - 1].content === "User said: so what now" && !hw.some((r) => r.content === "User said: old news"));
  check("the input rows are never changed", heavy.every((r) => !r.content.endsWith(W.TRIMMED)));
  const one = W.threadWindow([{ content: `User said: ${"x".repeat(9000)}`, created_at: new Date(0) }]);
  check("their latest text always stays, whole, however long", one.length === 1 && one[0].content.length === 9011);
  const route = readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("the reply's window is this one: the query reads up to the row cap and threadWindow cuts it", /ORDER BY created_at DESC\s+LIMIT \$2`,\s+\[user\.id, WINDOW_MAX_ROWS\],/.test(route) && /const chronological = threadWindow\(chronologicalResult\.rows\);/.test(route));
  check("a failed guard read falls back to the old 20-row window, never the longer one unguarded", /W\.guardRows\(user\.id, chronological\)\)\.catch\(\(\) => chronological\.slice\(-OLD_WINDOW_ROWS\)\)/.test(route) && W.OLD_WINDOW_ROWS === 20);
}

// ------------------------------------------------------------------ 2. answered feedback reaches the reply
// The fake model gives the shape of reply Cue sent before: it asked for the feedback again. What code controls is whether the notes
// were in front of it. The reply's own behavior is unverified until a paid run.
const replyInput = (message: string, recentConversation: string) => ({
  userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: message, isVoice: false, imageForVision: null,
  hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null,
  facts: G.createReplyFacts(), toneContext: "", seekingModeContext: "", styleHint: "", recentConversation, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true,
}) as any;
const promptFor = async (i: number, window: Row[]) => {
  systems.length = 0;
  replyText = "Smart move.\n\nHas she said anything about them yet?";
  claims = [];
  threadReports = [];
  hush();
  try {
    await runConversationReplyAgent(replyInput(log[i].content.replace(/^User said: /, ""), text(window)), { dryRun: true, record: false });
  } finally {
    loud();
  }
  return systems.join("\n");
};
{
  const before = await promptFor(SAMPLE, oldWindow(SAMPLE));
  const after = await promptFor(SAMPLE, W.threadWindow(asOf(SAMPLE)));
  check("the reply ran on the fake model", systems.length > 0);
  check("before: the reply prompt had no trace of the notes they'd already given", !/checkout on my site is slow/.test(before) && !/big brand's/.test(before));
  check("after: the notes they already gave are in the reply prompt, in their words", /checkout on my site is slow/.test(after) && /my labels look a lot like a big brand's/.test(after));
  check("after: so is what Cue said back (that both went to the team)", /I've passed both to the team\./.test(after));
}

// ------------------------------------------------------------------ 3. replayed turn by turn, nothing later leaks into an earlier turn
{
  const leaks: string[] = [];
  const present: string[] = [];
  for (let i = 0; i < log.length; i++) {
    if (!log[i].content.startsWith("User said:")) continue;
    const window = text(W.threadWindow(asOf(i)));
    LATER_FACTS.forEach((re, k) => {
      const givenAt = k === 0 ? LATER1 : LATER2;
      if (i < givenAt && re.test(window)) leaks.push(`turn ${i}: ${re}`);
      if (i >= givenAt && !re.test(window)) present.push(`turn ${i}: ${re} missing`);
    });
  }
  check("no turn's window carries what they only said later", leaks.length === 0, leaks);
  check("from the turn they say it, it's there", present.length === 0, present);
  const summaryPrompt = await promptFor(SUMMARY, W.threadWindow(asOf(SUMMARY)));
  check("the summary turn's reply prompt has neither later fact", LATER_FACTS.every((re) => !re.test(summaryPrompt)));
  const laterPrompt = await promptFor(LATER2, W.threadWindow(asOf(LATER2)));
  check("the turn they give the second one has both", LATER_FACTS.every((re) => re.test(laterPrompt)));
  const world = M.buildMemberWorld({ now: log[SUMMARY].created_at, zone: "America/Los_Angeles", keep: (s: string) => s, tasks: [], briefs: [], searching: { asks: [], goals: [], held: [] }, ahead: null, offeredGoals: [], docOffer: null, threads: [], exchange: asOf(SUMMARY).reverse().map((r) => ({ at: r.created_at, from: r.content.startsWith("User said:") ? ("member" as const) : ("co" as const), text: r.content.replace(/^(User said|Co replied): /, "") })), sent: [], activity: [], safetyHold: false, letPass: [] } as any);
  check("their recent words for the thread read, at the summary turn: nothing said later", world.theirWords.every((w) => LATER_FACTS.every((re) => !re.test(w))));
}

// ------------------------------------------------------------------ 4. their words: a text in paragraphs, and nothing that isn't theirs
{
  const recent = text(W.threadWindow(asOf(SAMPLE)));
  const words = G.theirOwnWords(recent);
  check("their words keep a text's later paragraphs", words.includes("Maybe a simple written agreement first.") && words.includes("2) my labels look a lot like a big brand's"));
  check("…and never Cue's lines, or the paragraphs of Cue's own replies", !words.includes("Smart move") && !G.theirOwnWords("Co replied: First line.\n\nSecond paragraph of Cue's.\nUser said: mine").includes("Second paragraph"));
  // The #49 rule: a call's follow-up row (routes/co.ts: its colon is past the first 60 characters) and an old Mo row are never theirs.
  const called = 'User said: ok\nCo called Jordan — no-answer (CA0000000000000000000000000000000). Followed up via iMessage: "Ellis said yes to the intro"\nloose line after it';
  check("a call's follow-up row ends their text, and nothing in it or after it is theirs", G.theirOwnWords(called) === "ok", G.theirOwnWords(called));
  const mo = "User said: thanks\nMo replied: Ellis runs a ceramics studio in Oakland\nand takes walk-ins";
  check("an old \"Mo replied:\" row ends their text, its later lines too", G.theirOwnWords(mo) === "thanks", G.theirOwnWords(mo));
  check("a gap marker or a [Call] note ends their text", G.theirOwnWords("User said: one\n[— 2 days later —]\nloose line") === "one" && G.theirOwnWords("User said: one\n[Call] Jordan said the venue fell through\nloose") === "one");
  check("every header the exchange reads starts a row for theirOwnWords too (one list)", SF.EXCHANGE_ROW.source.match(/\^\(([^)]*)\)/)![1].split("|").every((h) => SF.ROW_START.test(`${h}: x`)) && ["Co called Jordan — busy", "Mo replied: x", "[Call] x", "Cue replied: x", "Co tagged x"].every((h) => SF.ROW_START.test(h)));
  check("the dated and voice-memo forms still read", G.theirOwnWords("User said on September 29, 2026: hello there\nUser sent a voice memo: and this").split("\n").length === 2);
  const quoted = G.claimChecks([{ text: "you're thinking about a written agreement first", type: "member_life", supported: true, factId: null, quote: "Maybe a simple written agreement first." }], G.createReplyFacts(), { message: "ok", recentConversation: recent });
  check("before this, a member_life claim quoting their second paragraph was cut as \"cited support not found\"; now it stands", quoted[0].pass, quoted);
  const callQuote = G.claimChecks([{ text: "Ellis said yes", type: "member_life", supported: true, factId: null, quote: "Ellis said yes to the intro" }], G.createReplyFacts(), { message: "ok", recentConversation: called });
  check("a member_life claim quoting a call's follow-up row fails (not their words)", !callQuote[0].pass, callQuote);
  const invented = G.claimChecks([{ text: "you already signed it", type: "member_life", supported: true, factId: null, quote: "I already signed the agreement" }], G.createReplyFacts(), { message: "ok", recentConversation: recent });
  check("a quote that isn't in their texts still fails", !invented[0].pass);
}

// ------------------------------------------------------------------ 5. the thread read sees their texts whole, and its yes cuts
{
  const THREAD = { text: "deciding whether to share scent recipes with Priya", line: "deciding whether to share scent recipes with Priya (said Mon Nov 2)" };
  const exchange = asOf(CORRECTION).reverse().map((r) => ({ at: r.created_at, from: r.content.startsWith("User said:") ? ("member" as const) : ("co" as const), text: r.content.replace(/^(User said|Co replied): /, "") }));
  const world = M.buildMemberWorld({ now: log[CORRECTION].created_at, zone: "America/Los_Angeles", keep: (s: string) => s, tasks: [], briefs: [], searching: { asks: [], goals: [], held: [] }, ahead: null, offeredGoals: [], docOffer: null, threads: [THREAD], exchange, sent: [], activity: [], safetyHold: false, letPass: [] } as any);
  check("the thread read gets their long first text whole, last paragraph included (600 characters, was 240)", world.theirWords.includes(FIRST) && FIRST.length > 240 && FIRST.length <= M.THEIR_WORDS_CHARS, FIRST.length);
  const src = { message: "No, I mean the problem with Priya", recentConversation: text(W.threadWindow(asOf(CORRECTION))) };
  const SAID_BACK = "The problem with Priya specifically: she asked about your scent recipes and you're not sure you want to share them.";
  const ADDED = "The problem with Priya specifically: she asked about your scent recipes before you two have agreed on terms.";
  const run = async (draft: string, o: { reports: number[]; claims: unknown[] }) => {
    const rf = G.createReplyFacts();
    G.addMemberWorld(rf, world);
    threadReports = o.reports;
    claims = o.claims;
    kinds.length = 0;
    threadPrompts.length = 0;
    hush();
    try {
      return await G.groundReply(`${draft} That's the part worth slowing down on.`, rf, src, { userId: null, record: false });
    } finally {
      loud();
    }
  };
  check("the answer names their thread, so the thread read is asked about it", M.threadCandidates(world, SAID_BACK).includes(SAID_BACK));
  const kept = await run(SAID_BACK, { reports: [], claims: [{ text: "she asked about your scent recipes", type: "other_person", supported: true, factId: null, quote: "She asked about my scent recipes" }] });
  check("a read that hears it as their own news said back keeps it whole", kept.final.startsWith(SAID_BACK) && kept.outcome === "as_drafted", kept);
  check("…and that read was shown their whole first text, notes included", kinds.includes("thread_read") && threadPrompts.some((p) => p.includes("my labels look a lot like a big brand")), threadPrompts.map((p) => p.slice(0, 200)));
  // The reviewer's case: the rest of the sentence quotes them, but "before you two have agreed on terms" is Cue's own advice said as
  // where things stand. The read says report, and the cut stands even though the claim read backed the part it quoted.
  const added = await run(ADDED, { reports: [1], claims: [{ text: "she asked about your scent recipes", type: "other_person", supported: true, factId: null, quote: "She asked about my scent recipes" }] });
  check("a clause Cue added about where it stands is cut, though the rest quotes them", !added.final.includes("before you two have agreed on terms") && added.checks.some((c) => c.name === "no_thread_report" && !c.pass), added);
  const route = readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("no bypass of the thread read on their words: only the read's yes decides", /if \(rf\.thread\?\.judged\.get\(threadKey\(s\)\) === true\) checks\.push\(\{ name: "no_thread_report"/.test(route) && !/saidBackSentence/.test(route));
}

console.log(`thread window: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
