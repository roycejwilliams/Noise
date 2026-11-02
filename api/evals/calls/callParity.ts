// Both mediums (Royce, 2026-11-02): the reply fixes merged in #353 (#343 #344 #347 #349 #350) reach the call path too, in its spoken
// rhythm. Layer 1: the model, the tools and the database are stubs; zero tokens, no network. Invented members (Jordan, Dana).
//   npx tsx evals/calls/callParity.ts
// What it holds, one section per rule:
//   #347 asked for a summary or steps: the rule is in the thinking's prompt on a GPT-Live call (and the ElevenLabs agent's, the same
//        file), with the spoken note after it; no call prompt tells Cue to end steps on a question
//   #344 where things stand: the thinking's prompt holds a stage to its source, and the after-call audit does too (a stage past its
//        source is a correction for the follow-up; one their texts back is not)
//   #343 the text thread: a call reads the reply's window (their last ten texts, theirs whole), never dropped when the summary is full,
//        and the audit reads it as their own words
//   #349/#350 helpers: a GPT-Live call's thinking has no helper tools at all (end_call only); the call toolset (the ElevenLabs proxy's,
//        on its way out with #337) is wrapped by the same guard, so a thrown send-or-change tool leaves its receipt and isn't run again
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { z } = await import("zod");

const { default: pool } = await import("../../src/db/db.js");
const decisions: { decision: string; action: string; proposal: any }[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/INSERT INTO harness_decisions/.test(sql.replace(/\s+/g, " "))) {
    decisions.push({ decision: p[1], action: p[4], proposal: p[5] ? JSON.parse(p[5]) : null });
    return { rows: [{ id: String(decisions.length), created_at: new Date() }] };
  }
  return { rows: [] };
};
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
const GL = await import("../../src/services/gptLive.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const CG = await import("../../src/harness/callGrounding.js");
const CC = await import("../../src/services/callContext.js");
const TW = await import("../../src/services/threadWindow.js");
const CT = await import("../../src/services/callTools.js");
const MK = await import("../../src/services/memberKnowledge.js");
const CO = await import("../../src/services/callOpening.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const live = (contextSummary: string) => GL.buildLiveCall({ userId: "u-jordan", callSid: "CA-1", firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary, rightNow: "It's Monday evening for them.", findsNow: "", callReason: "", timeOfDay: "Monday evening" });
const thinking = live("").backendSystem;
const elAgent = E.promptForElevenLabs(VOICE);

// ------------------------------------------------------------ #347: a summary is the whole answer, steps stop at the last step
const ASKED_FOR = [
  "When they ask you to sum something up (their situation, a problem, where things stand with someone), the summary is your whole answer: a few plain sentences, built from what they've told you on this call and before.",
  "When they're struggling, one short line that receives it can come first.",
  "No advice or plan after it unless they asked for that too.",
  "When they ask what to do, say the steps in order, plainly, a sentence or two each, and stop after the last one.",
  "On a legal or money step, think through what it covers and what it leaves open, and say both in your own words.",
  "After a summary or steps the turn is theirs: ask something only when you can't give the right next step without their answer, and a safety moment always comes first.",
];
check("#347: every line of the rule is in the GPT-Live thinking's prompt", ASKED_FOR.every((l) => thinking.includes(l)), ASKED_FOR.filter((l) => !thinking.includes(l)));
check("#347: …and in the ElevenLabs agent's prompt (one file, both providers)", ASKED_FOR.every((l) => elAgent.includes(l)));
check("#347: the spoken rhythm rides after it on GPT-Live: plain spoken sentences, no lists", thinking.endsWith(GL.BACKEND_NOTE) && /no lists/.test(GL.BACKEND_NOTE) && thinking.indexOf(ASKED_FOR[3]) < thinking.indexOf(GL.BACKEND_NOTE));
check("#347: no call prompt tells Cue to end a walkthrough on a question (the text rule #347 removed)", ![thinking, elAgent, GL.liveInstructions({ firstName: "Jordan", direction: "inbound", team: true })].some((p) => /End with one question that gauges/i.test(p)));
check("#347: the coaching guide still answers when they ask what to do (no question in place of an answer)", /when they ask what to do, give a real answer; never a question in place of one/.test(thinking));

// ------------------------------------------------------------ #344: where things stand, held to its source
const STAGE_LINE = "Where something stands is a fact too: say it only as far along as its source says, because suggested, planned, set up, under way and done are different. \"I gave her a sample\" never means she's trying it.";
check("#344: the thinking's prompt holds a stage to its source, before anything is spoken", thinking.includes(STAGE_LINE) && elAgent.includes(STAGE_LINE));
const ap = CG.callAuditPrompt("user: I gave Dana a sample of the app\nassistant: So right now you've got Dana trying it.", "known", undefined, [], [], "Your recent texts with them, oldest first:\nUser said: I handed Dana a sample on Friday");
check("#344: the audit lists where something stands, and holds the stage to its source", /where something or someone stands/.test(ap) && /suggested, planned, set up \(access given, a sample handed over, an intro sent\), under way, and done are different/.test(ap) && /A stage further along than its source is "invented_fact": in "specifics", copy the words of Cue's line that claim the stage, and in "stage_subject"/.test(ap));
{
  const transcript = "user: I gave Dana a sample of the app last week.\nassistant: So right now you've got Dana trying it, and she likes it.";
  const stage = { quote: "So right now you've got Dana trying it, and she likes it.", type: "invented_fact" as const, what: "the stage: she was handed a sample, not trying it", specifics: ["trying it", "likes it"], stage_subject: "Dana" };
  const past = CG.planCallAudit([stage], transcript, { knownBefore: "", records: "User said: I gave Dana a sample of the app", tasks: [] });
  check("#344: a stage past its source becomes a correction for the call's follow-up", past.corrections.length === 1 && past.corrections[0].quote === stage.quote, past);
  const told = CG.planCallAudit([stage], transcript, { knownBefore: "", records: "User said: Dana's trying it this week and she likes it a lot", tasks: [] });
  check("#344: …but when their texts say that stage, it isn't (the record backs it)", told.corrections.length === 0 && told.refused.length === 1, told);
  // Review of #354: the stage words anywhere in their texts used to take a flagged stage back.
  const UNRELATED = "User said: I'm trying it with the new running shoes and my wife likes it\nUser said: Dana was at the demo";
  const unrelated = CG.planCallAudit([stage], transcript, { knownBefore: "", records: UNRELATED, tasks: [] });
  const looseOld = CG.planCallAudit([{ ...stage, stage_subject: null }], transcript, { knownBefore: "", records: UNRELATED, tasks: [] });
  check("#344: control: without a subject the old word match takes it back (the bug the review found)", looseOld.corrections.length === 0, looseOld);
  check("#344: an unrelated text with the stage words doesn't take it back: the subject and the stage must share a line", unrelated.corrections.length === 1, unrelated);
  const pronoun = CG.planCallAudit([{ ...stage, stage_subject: "she" }], transcript, { knownBefore: "", records: "User said: she's trying it, she likes it", tasks: [] });
  check("#344: a pronoun names nobody: the audit's judgment stands", pronoun.corrections.length === 1, pronoun);
  check("#344: the audit is asked who a stage claim is about", /"stage_subject": "for a stage claim only, else null"/.test(ap) && /in "stage_subject" who or what it's about/.test(ap));
  // Review of #354: Cue's own record of its work is a source, so a true line about it isn't "corrected".
  const carrying = CC.carryingFacts(["- Text them the venue shortlist (promised Oct 31)"], ["- the pilot-partner search: under way since Oct 30, checking daily"]);
  check("#344: what Cue is carrying, and where each stands, is in the audit's facts", carrying.some((l) => /^Cue is carrying this for them \(its own record, with where it stands\): the pilot-partner search: under way/.test(l)) && carrying.some((l) => /still open: Text them the venue shortlist/.test(l)) && /\.\.\.carryingFacts\(promised, loopLines\),/.test(src("services/callContext.ts")));
  const own = { quote: "The pilot-partner search is under way.", type: "invented_fact" as const, what: "a stage of Cue's own work", specifics: ["under way"], stage_subject: "the pilot-partner search" };
  const ownPlan = CG.planCallAudit([own], "user: how's the search going?\nassistant: The pilot-partner search is under way.", { knownBefore: carrying.join("\n"), records: "", tasks: [] });
  check("#344: \"the pilot-partner search is under way\" with that loop running is not a correction", ownPlan.corrections.length === 0 && ownPlan.refused.length === 1, ownPlan);
  check("#344: …and the audit prompt shows the model that loop", CG.callAuditPrompt("assistant: hi", carrying.join("\n")).includes("the pilot-partner search: under way since Oct 30"));
}

// ------------------------------------------------------------ #343: the call reads the reply's window of the thread
const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString();
const ex: any[] = [];
let n = 0;
const long = "The feedback from the pilot, all of it:\n\n" + "They liked the onboarding but the export was slow. ".repeat(30) + "\n\nAnd Dana wants a second session before she decides.";
ex.push({ from: "member", text: "an older text of theirs, the twelfth back", call: false, verifiedAt: at(n++) });
ex.push({ from: "member", text: "an older text of theirs, the eleventh back", call: false, verifiedAt: at(n++) });
for (let i = 10; i >= 1; i--) {
  ex.push({ from: "member", text: i === 8 ? long : `their text ${i} back`, call: false, verifiedAt: at(n++) });
  for (let b = 0; b < 4; b++) ex.push({ from: "co", text: `Cue bubble ${b} after text ${i}.`, call: false, verifiedAt: at(n++) });
}
ex.push({ from: "co", text: "Talked about the pilot on a call.", call: true, verifiedAt: at(n++) });
const thread = CC.callThread(ex);
const theirs = thread.split("\n").filter((l) => l.startsWith("User said:"));
check("#343: the call's thread holds their last ten texts, oldest first, under its heading", thread.startsWith(CC.CALL_THREAD_HEAD) && theirs.length === 10 && theirs[0] === "User said: their text 10 back" && theirs[9] === "User said: their text 1 back", theirs);
check("#343: …and none older", !thread.includes("eleventh back") && !thread.includes("twelfth back"));
check("#343: their long text in paragraphs comes through whole", thread.includes(long));
check("#343: a call summary row isn't a text", !thread.includes("Talked about the pilot on a call"));
check("#343: the old window (the last 20 rows) would have held only four of theirs", ex.slice(-20).filter((x) => x.from === "member").length <= 4);
check("#343: the call reads as many rows as the reply's window can", CC.CONTEXT_EXCHANGES.exchanges >= TW.WINDOW_MAX_ROWS);
check("#343: the window is the reply's own (services/threadWindow.ts), with its budget", thread.length <= TW.WINDOW_CHARS + CC.CALL_THREAD_HEAD.length + 200 && /threadWindow\(o\.guardsUnread \? newestFirst\.slice\(0, OLD_WINDOW_ROWS\) : newestFirst\)/.test(src("services/callContext.ts")));
{
  const full = ["A: " + "a".repeat(4000), "B: " + "b".repeat(3900)].join("\n\n");
  const sum = CC.assembleCallSummary({ lessons: [], sentLines: ["From the page for \"Pilot review\": Tuesday 3pm"], threads: [], base: full, thread });
  check("#343: a full summary never drops the thread, and the thread's paragraphs stay together", sum.includes(thread) && sum.includes("A: aaa"));
  check("#343: the thread comes after the rest and before what was sent", sum.indexOf(CC.CALL_THREAD_HEAD) > sum.indexOf("B: bbb") && sum.indexOf(CC.CALL_THREAD_HEAD) < sum.indexOf("What you sent them lately"));
  check("#343: no thread, no heading and nothing else changed", CC.assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: "A: x" }) === "A: x");
  check("#343: the thread reaches the GPT-Live thinking, which already says never to re-ask what it tells you", live(sum).backendSystem.includes(long) && /never re-ask what it already tells you/.test(thinking));
}
{
  // Review of #354: a failed guard read is said, and the call then reads the old 20 rows, as the reply does; never 60 unguarded.
  const narrow = CC.callThread(ex, { guardsUnread: true });
  const narrowTheirs = narrow.split("\n").filter((l) => l.startsWith("User said:"));
  check("#343: guards unread: the thread is the newest OLD_WINDOW_ROWS rows only", narrowTheirs.length <= 4 && narrowTheirs.length >= 1 && !narrow.includes("their text 10 back"), narrowTheirs);
  const base: any = { profile: async () => ({ firstName: "Jordan", city: "Oakland", goals: [], intent: [], updatedAt: new Date() }), zone: async () => "America/Los_Angeles", linkedNames: async () => [], exchanges: async () => [{ content: "User said: hi", at: new Date() }] };
  const failedRead = await quietly(() => MK.memberKnowledge("u-jordan", { include: ["exchanges"] }, { ...base, forgotten: async () => { throw new Error("db down"); } }));
  const goodRead = await MK.memberKnowledge("u-jordan", { include: ["exchanges"] }, { ...base, forgotten: async () => [] });
  check("#343: memberKnowledge says when the guard read failed (it no longer goes quietly empty)", failedRead.guardsUnread === true && !goodRead.guardsUnread);
  check("#343: buildCallKnowledge passes that on to the thread", /callThread\(k\.exchanges, \{ guardsUnread: !!k\.guardsUnread \}\)/.test(src("services/callContext.ts")));
  // Review of #354: a hard cap, the newest row included; their text is never cut mid-way.
  const huge = "word ".repeat(2000).trim();
  const capped = CC.callThread([...ex, { from: "member", text: huge, call: false, verifiedAt: at(900) }]);
  check("#343: the thread is hard-capped, the newest row included", capped.length <= TW.WINDOW_CHARS + CC.CALL_THREAD_HEAD.length + TW.WINDOW_MAX_ROWS + 1, capped.length);
  check("#343: …a text of theirs too long for the whole budget is left out with a marker, never cut mid-way, and the older rows still come", capped.includes(CC.CALL_THREAD_TOO_LONG(2000)) && !capped.includes("word word") && capped.includes("their text 1 back"));
  // The audit's cut keeps the heading.
  const longThread = `${CC.CALL_THREAD_HEAD}\n${Array.from({ length: 200 }, (_, i) => `User said: line ${i} ${"x".repeat(50)}`).join("\n")}`;
  const cut = CG.auditThread(longThread);
  check("#343: the audit's cut keeps the heading and the newest whole lines", cut.startsWith(CC.CALL_THREAD_HEAD + "\n") && cut.length <= CG.AUDIT_THREAD_MAX && cut.endsWith(`line 199 ${"x".repeat(50)}`));
  // The thread is the thinking's, never GPT-Live's own prompt.
  const withThread = live(CC.assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: "A: x", thread }));
  check("#343: the thread never reaches GPT-Live's session prompt (liveInstructions)", !withThread.instructions.includes(CC.CALL_THREAD_HEAD) && !withThread.instructions.includes("their text 1 back") && withThread.backendSystem.includes("their text 1 back"));
  // The ElevenLabs opening writer cuts its context: why Cue is calling goes first, so a long thread can't push it out.
  const why = CO.openingSource("x".repeat(9000), "outbound", { kind: "moment", text: "their pilot review is tomorrow", sensitive: false } as any);
  check("#343: the opening writer's cut keeps \"Why Cue is calling\"", why.startsWith("Why Cue is calling:") && CO.openingPrompt({ firstName: "Jordan", direction: "outbound", summary: why }).includes("Why Cue is calling:"));
}
check("#343: buildCallKnowledge passes the thread to the summary and to the audit", /const thread = callThread\(k\.exchanges, \{ guardsUnread: !!k\.guardsUnread \}\);/.test(src("services/callContext.ts")) && /return \{ summary, facts, impressions, thread \};/.test(src("services/callContext.ts")) && !/Recent texts: \$\{\[\.\.\.p\.recentTexts\]\.filter/.test(src("services/callContext.ts")));
{
  const kb = CG.knownBeforeFrom(null, { facts: "f", impressions: "i", thread: "Your recent texts with them, oldest first:\nUser said: Dana's trying it" });
  check("#343: the audit gets the thread as their own words, not as an impression", kb.thread?.includes("Dana's trying it") && /What they said there \("User said"\) is their own words/.test(CG.callAuditPrompt("assistant: hi", kb.facts, kb.impressions, [], [], kb.thread)));
  check("#343: no thread: the audit prompt is today's, word for word", CG.callAuditPrompt("assistant: hi", "f", "i") === CG.callAuditPrompt("assistant: hi", "f", "i", [], [], ""));
}

// ------------------------------------------------------------ #349/#350: helpers on a call go through the one guard, or don't run
{
  const req = GL.delegationRequest(live(""), [{ who: "member", text: "put that in a doc for me", startMs: 0, endMs: 900 }]);
  check("#349/#350: a GPT-Live delegation offers the thinking end_call and nothing else: no helper runs mid-call", (req.tools ?? []).map((t) => t.function.name).join(",") === "end_call");
  check("#349/#350: …and the call brain runs it with no tools of Cue's", /runCallLlm\(req, \{ stream: \(r\) => upstream\(r, call\.userId\), clean: true, tools: null,/.test(src("services/gptLive.ts")));
  check("#349/#350: the proxy's call toolset is the texting tools wrapped by the same guard (toolGuard.ts)", /createConversationTools\(\{/.test(src("services/callTools.ts")) && /guardTools\(tools, \{ userId: ctx\.userId/.test(src("agent/conversationTools.ts")));
  decisions.length = 0;
  const runs: string[] = [];
  const raw = { startTask: { description: "start a task", inputSchema: z.object({ goal: z.string() }), execute: async () => { runs.push("startTask"); throw new Error("db write timed out"); } }, researchBrief: { description: "research a brief", inputSchema: z.object({ topic: z.string() }), execute: async () => ({ ok: true }) } };
  const member = { phone: "+14155550123", firstName: "Jordan", city: "San Francisco", tasks: [], loops: null } as any;
  const set = CT.buildCallTools({ userId: "u-jordan", callKey: "u-jordan:p", turnWords: "can you keep looking for a pilot partner for me", callWords: "can you keep looking for a pilot partner for me", lastCoLine: null, member, tools: raw, done: async () => {}, owe: async () => {}, sendText: async () => true });
  const r1: any = await quietly(() => set.run("startTask", { goal: "find a pilot partner", theirYes: "can you keep looking for a pilot partner for me" }, "t1"));
  await new Promise((r) => setTimeout(r, 60));
  const r2: any = await quietly(() => set.run("startTask", { goal: "find a pilot partner again", theirYes: "can you keep looking for a pilot partner for me" }, "t2"));
  await new Promise((r) => setTimeout(r, 60));
  check("#350 on a call: a thrown tool comes back not done", r1?.ok === false, r1);
  check("#350 on a call: …leaves a not_done receipt saying it threw", decisions.some((d) => d.decision === "tool.startTask" && d.action === "not_done" && d.proposal?.threw === true), decisions);
  check("#350 on a call: …and a tool that changes something isn't run again that turn", runs.length === 1 && /isn't known/.test(JSON.stringify(r2)), { runs, r2 });
  const yesField = set.defs.find((d: any) => d.name === "researchBrief")?.input_schema?.properties?.theirYes?.description;
  check("#349 on a call: a tool that needs their yes (researchBrief) takes a direct ask as one", typeof yesField === "string" && /asking you for it, or saying yes to your offer of it/.test(yesField), yesField);
}

console.log(`\ncall parity (#343 #344 #347 #349 #350): ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
