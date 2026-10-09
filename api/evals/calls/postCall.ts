// After a call: corrections held to the capability registry, grader flags re-checked against the member's texts, promises kept
// only by a send after them, one task per commitment, and their ask read from their own words (2026-10-08 call review).
// Layer 1: no model, no network, no database.   npx tsx evals/calls/postCall.ts
// The fixture is a fictional call in the shape of the real one (invented names), never a member's own words.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const G = await import("../../src/harness/callGrounding.js");
const F = await import("../../src/services/followThrough.js");
const V = await import("../../src/services/callEvals.js");
const T = await import("../../src/services/callTasks.js");
const C = await import("../../src/services/callCommitments.js");
const TT = await import("../../src/services/taskTurn.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };

const ASK = "Yeah, that's fine. But actually, I actually want you to take lead and, you know, just kind of start planning any docs or PDFs that we could kind of have between me and my cofounder going forward, and how we plan on launching our own branding throughout the Lumen event.";
const CALL = `assistant: Hey Jordan, it's Co. How's the launch going?
user: We moved the date. We're partnering with Lumen AI on something in November, at the Atrium with a guy named Ellis.
assistant: The most useful role at an event is helping people find the right person in the room. I can learn who's coming, who each person is trying to meet. Point people toward those connections.
user: That fits. Ellis runs logistics software for events.
assistant: So you're planning the November event at the Atrium with Ellis Marr. Want me to hold onto this?
user: ${ASK}
assistant: Yes, I can take that on. When we hang up, I'll set up a task to draft a planning doc. I'll text you what I put together, and you and your cofounder can review it. Should it focus on the event only, or also how Co keeps a presence after it?
user: Yeah, for sure. The later half is more important.
assistant: Got it. Then the plan will focus on how Co keeps its presence after the event. I'll set that up when we hang up and text you what I put together.
user: Yeah, it's perfect.
assistant: Good. I'll set up the post-event branding plan when we hang up. Text you what I find. Talk soon.
user: Thanks.`;

// ---------------------------------------------------------------- 1. capability corrections, held to the registry
{
  const q = "I can learn who's coming, who each person is trying to meet. Point people toward those connections.";
  const reg = G.auditRegistry();
  check("the audit reads the real registry: in-room guest-list matching is on it", reg.abilities.some((a) => a.id === "co_events" && /guest list/.test(a.can) && /who they hope to meet/.test(a.can)));
  check("the audit prompt carries every member-facing ability by id and the limits by number", (() => { const p = G.callAuditPrompt(CALL, "known"); return /\[co_events\] At Co events: Co knows who's coming/.test(p) && /\nL1 /.test(p) && /"limit": "L# or null"/.test(p) && /"asked_quote"/.test(p) && /"specifics"/.test(p); })());
  check("the call's own can't line no longer denies knowing what guests want at Co's own events", /At Co's own events it does know the guest list/.test(G.CALL_CAPABILITIES) && !/people's intentions\) it wasn't given/.test(G.CALL_CAPABILITIES));
  const today = G.capabilityCorrectionVerdict({ quote: q, what: "Co cannot learn attendee identities or intentions at an event or make real-time matches", limit: "L8" });
  check("2026-10-08: 'I can learn who's coming, who each person is trying to meet' is refused as a correction, even citing a limit", !today.save && /co_events/.test(today.why), today);
  check("refused when the audit names the registry line that covers it", !G.capabilityCorrectionVerdict({ quote: "I'll point you to who's worth meeting", what: "x", ability: "co_events", limit: "L8" }).save);
  check("refused when it names no can't line it breaks (the old audit's shape)", !G.capabilityCorrectionVerdict({ quote: "I can book that table for you tonight", what: "x" }).save);
  const book = G.capabilityCorrectionVerdict({ quote: "I can book that table for you tonight", what: "Co can't book", limit: String(`L${reg.limits.findIndex((l) => /can't book, buy, register/.test(l)) + 1}`) });
  check("a real wrong claim (booking) that cites the limit it breaks is still saved", book.save, book);
  const plan = G.planCallAudit([{ quote: q, type: "capability", what: "Co cannot learn attendee identities", limit: "L8" }], CALL, { knownBefore: "", records: "", tasks: [] });
  check("the plan saves no correction for it and says why", plan.corrections.length === 0 && plan.refused.length === 1 && /registry has it/.test(plan.refused[0].why));
  const cg = src("harness/callGrounding.ts");
  check("auditCall writes call_correction only from the checked plan", /const corrections = plan\.corrections;/.test(cg) && !/claims\.filter\(\(x\) => x\.type === "promise_unkeepable" \|\| x\.type === "invented_fact" \|\| x\.type === "capability"\)/.test(cg));
}

// ---------------------------------------------------------------- 2. names from their texts aren't invented
{
  const records = "User said: Meeting Ellis Marr at the Atrium next week about the November event.\nUser said: the dates are flexible";
  const claim = { quote: "So you're planning the November event at the Atrium with Ellis Marr.", type: "invented_fact" as const, what: "last name not given on the call", specifics: ["Ellis Marr"] };
  const v = G.inventedFactVerdict(claim, CALL, "", records);
  check("a full name the member texted is not invented, though the call only had the first name", !v.save && v.onRecord.includes("Ellis Marr"), v);
  check("without their texts it still counts as invented", G.inventedFactVerdict(claim, CALL, "", "User said: hi").save);
  check("with no specifics from the audit, the quote's own names are checked", !G.inventedFactVerdict({ quote: claim.quote, specifics: null }, CALL, "", records).save);
  check("Co having said it earlier on the call is not a source", G.inventedFactVerdict({ quote: "It's at the Atrium with Ellis Marr", specifics: ["Ellis Marr"] }, `assistant: Ellis Marr runs it\n${CALL}`, "", "").save);
  check("the record loader reads only their own lines and Co's records, never Co's texts or summaries", /content LIKE 'User said:%'/.test(src("services/followThrough.ts")) && /FROM co_facts WHERE owner_user_id = \$1/.test(src("services/followThrough.ts")));
  // ElevenLabs' judge, re-checked
  const analysis = { evaluation_criteria_results: {
    no_invented_specifics: { criteria_id: "no_invented_specifics", result: "failure", rationale: "Co invented 'Ellis Marr' — the member only said 'a guy named Ellis.' No last name was given." },
    names_and_voice: { criteria_id: "names_and_voice", result: "failure", rationale: "Co invented the last name 'Marr' for Ellis, which the member never provided." },
    no_known_questions: { criteria_id: "no_known_questions", result: "failure", rationale: "asked their city again" },
    short_spoken_replies: { criteria_id: "short_spoken_replies", result: "success", rationale: "" },
  } };
  check("the rationale's quoted names are what gets checked", V.flaggedSpecifics(analysis.evaluation_criteria_results.no_invented_specifics.rationale).includes("Ellis Marr"));
  const seen: any[] = [];
  const n = await V.recordCallEvaluation("u1", "conv_x", analysis, (async (d: any) => { seen.push(d); }) as any, { transcript: CALL, records: async () => records });
  const d = seen[0];
  check("a name from their texts is overturned in the grade, the rest still fail", n === 1 && d.proposal.failed.join() === "no_known_questions" && d.proposal.overturned.map((o: any) => o.id).sort().join() === "names_and_voice,no_invented_specifics", d?.proposal);
  check("an overturned verdict stays visible for the review, as passed with the reason", d.checks.some((c: any) => c.name === "no_invented_specifics" && c.pass === true && /Ellis Marr/.test(c.reason)));
  const seen2: any[] = [];
  await V.recordCallEvaluation("u1", "conv_y", analysis, (async (d: any) => { seen2.push(d); }) as any, { transcript: CALL, records: async () => "User said: hello" });
  check("without the name in their texts, the grader's failure stands", seen2[0].proposal.failed.includes("no_invented_specifics") && !seen2[0].proposal.overturned);
  check("our own criteria tell the judge it can't see their texts, so a last name added isn't a failure on its own", ["no_invented_specifics", "names_and_voice", "no_unsaid_attribution"].every((id) => /can't see|see only the call/.test(V.CALL_CRITERIA.find((c) => c.id === id)!.conversation_goal_prompt)));
}

// ---------------------------------------------------------------- 3a. a promise is kept only by a send after it
{
  const promisedAt = new Date("2026-10-08T00:28:49Z");
  const earlierDoc: any = { at: new Date("2026-10-07T16:50:14Z"), text: "a document (PDF): Launch Party Funnel", kind: "document" };
  const goal = "Keep your word from the call: \"I'll text you what I put together, and you and your cofounder can review it.\"";
  const r = F.promiseKeptBy({ goal, theirWords: ASK, at: promisedAt }, [earlierDoc]);
  check("2026-10-08: a document sent the day before doesn't keep a promise made on the call", !r.kept && /before the promise/.test(r.why), r);
  check("a plain text after it doesn't keep a promise of a document", !F.promiseKeptBy({ goal, theirWords: ASK, at: promisedAt }, [earlierDoc, { at: new Date("2026-10-08T00:40:00Z"), text: "Calling you now, talk soon about everything", kind: "text" }]).kept);
  check("a document sent after it does", F.promiseKeptBy({ goal, theirWords: ASK, at: promisedAt }, [earlierDoc, { at: new Date("2026-10-08T01:10:00Z"), text: "a document (PDF): Post-event presence plan", kind: "document" }]).kept);
  check("links promised need a link after", !F.promiseKeptBy({ goal: "Keep your word from the call: \"I'll text you those links.\"", at: promisedAt }, [{ at: new Date("2026-10-08T01:00:00Z"), text: "Here's what I found, more soon", kind: "text" }]).kept && F.promiseKeptBy({ goal: "Keep your word from the call: \"I'll text you those links.\"", at: promisedAt }, [{ at: new Date("2026-10-08T01:00:00Z"), text: "https://lu.ma/x", kind: "link" }]).kept);
  // the task runner's close
  const task: any = { goal, theirWords: ASK, createdAt: promisedAt.toISOString(), source: "promise" };
  const deps: any = { now: () => new Date("2026-10-08T01:00:06Z"), sentSince: async () => [earlierDoc] };
  const refused = await TT.promiseCloseCheck(task, [], deps);
  check("the task runner can't close it as done on the earlier send", !refused.ok && /before the promise/.test(refused.why), refused);
  check("a task that isn't a promise closes as before", (await TT.promiseCloseCheck({ ...task, source: "ask" }, [], deps)).ok);
  const other: any = { goal: "Keep your promise: \"I'll check what time it starts and let you know\"", theirWords: "what time does it start", createdAt: promisedAt.toISOString(), source: "promise" };
  check("a promise kept by the task's own text this turn closes", (await TT.promiseCloseCheck(other, ["It starts at 7 and doors open at 6:30, so there's time for dinner first."], deps)).ok);
  const tt = src("services/taskTurn.ts");
  check("finish(done) and marking the send step done both go through the check, and the real turn reads what was sent", /if \(status === "done"\) \{\s*const kept = await promiseCloseCheck\(task, texts, deps, docsSent\);/.test(tt) && /stepDone && task\.source === "promise"/.test(tt) && /sentSince: \(since\) => sendsSince\(userId, since\)/.test(tt));
  check("sends are read by when they happened, not when the record was written", /COALESCE\(happened_at, created_at\) > \$2/.test(src("services/followThrough.ts")));
  // the after-call commitment check uses the same rule
  const recorded: any[] = [];
  const mk = (sends: any[]): any => ({ due: async () => [{ id: "111", user_id: "u1", goal, their_words: ASK, created_at: promisedAt }], sentSince: async () => new Date("2026-10-08T00:50:00Z"), sends: async () => sends, note: async () => null, record: async (x: any) => { recorded.push(x); } });
  const c1 = await C.checkCallCommitments(new Date("2026-10-08T01:30:00Z"), mk([earlierDoc, { at: new Date("2026-10-08T00:50:00Z"), text: "an unrelated event text that went out", kind: "text" }]));
  check("the commitment check: an unrelated text after it isn't the promised document", c1.unkept === 1 && recorded[0].action === "unkept");
}

// ---------------------------------------------------------------- 3b. one commitment, one task
{
  const live = { id: 111, goal: "Keep your word from the call: \"I'll text you what I put together, and you and your cofounder can review it.\"", theirWords: ASK.slice(0, 300), createdAt: "2026-10-08T00:28:49Z" };
  check("their ask and Co's live promise answering it are the same commitment", F.sameCommitment({ goal: "Start planning docs and PDFs for branding and launch plans for the Lumen event", theirWords: ASK.slice(20) }, live));
  check("different asks are not", !F.sameCommitment({ goal: "Find venues for a dinner for 40 in October", theirWords: "can you find me a few venues for a launch dinner, about 40 people" }, live));
  // tasksFromCall notes the live task instead of opening a second
  const calls: any[] = []; const notes: any[] = [];
  const got = await T.tasksFromCall("u1", CALL, {
    read: async () => [{ goal: "Start planning docs and PDFs for branding and launch plans for the Lumen event", quote: "start planning any docs or PDFs that we could kind of have between me and my cofounder going forward" }],
    start: async (i: any) => { calls.push(i); return { ok: true, task: { id: 114 } } as any; },
    alreadyDone: async () => false,
    record: async () => {},
    existing: async () => [live],
    note: async (_u: string, id: number, t: string) => { notes.push({ id, t }); },
  });
  check("2026-10-08: the call-task read doesn't open a duplicate of the live promise task; it notes the ask on it", calls.length === 0 && notes.length === 1 && notes[0].id === 111 && /They asked for this on the call/.test(notes[0].t) && got.length === 1, { calls, notes });
  // the transcript fallback / a second spoken line of the same commitment
  const started: any[] = []; const cnotes: any[] = [];
  const cdeps: any = { open: async () => [{ ...live, source: "promise" }], start: async (i: any) => { started.push(i); return { ok: true, task: { id: 200 } }; }, setDue: async () => {}, note: async (_u: string, id: number, t: string) => { cnotes.push({ id, t }); } };
  const again = await C.trackCallCommitment({ userId: "u1", sentence: "I'll text you what I put together for the post-event plan.", theirLine: ASK, now: new Date("2026-10-08T00:29:30Z") }, cdeps);
  check("the same commitment said again on the call opens no second task", !again.ok && started.length === 0 && cnotes[0]?.id === 111, { again, cnotes });
  const fresh = await C.trackCallCommitment({ userId: "u1", sentence: "I'll text you those venue links right after we hang up.", theirLine: "can you send the venue links", now: new Date("2026-10-08T00:29:30Z") }, cdeps);
  // Royce, 2026-10-08 (his real call: two sends opened two tasks and two "nothing yet" texts): one call's sends are one delivery.
  check("a different send on the same call rides the same task, noted to go in the same message", !fresh.ok && started.length === 0 && cnotes.some((n) => n.id === 111 && /Also said on the call: "I'll text you those venue links/.test(n.t) && /same message/.test(n.t)), { fresh, cnotes });
  const nextDay = await C.trackCallCommitment({ userId: "u1", sentence: "I'll text you those venue links right after we hang up.", theirLine: "can you send the venue links", now: new Date("2026-10-09T09:00:00Z") }, cdeps);
  check("a send on a later call still opens its own task", nextDay.ok && started.length === 1, nextDay);
  // the audit's promises: five ways of saying one thing become one, carried by the live task
  const claims: any[] = [
    { quote: "Yes, I can take that on. When we hang up, I'll set up a task to draft a planning doc.", type: "promise_keepable", what: "draft a post-event branding/presence planning doc" },
    { quote: "I'll text you what I put together, and you and your cofounder can review it.", type: "promise_keepable", what: "text the drafted planning document" },
    { quote: "Got it. Then the plan will focus on how Co keeps its presence after the event. I'll set that up when we hang up and text you what I put together.", type: "promise_keepable", what: "draft and text a plan on Co's post-event presence" },
    { quote: "Good. I'll set up the post-event branding plan when we hang up. Text you what I find.", type: "promise_keepable", what: "set up and text the post-event branding plan" },
  ];
  const plan = G.planCallAudit(claims, CALL, { knownBefore: "", records: "", tasks: [live] });
  check("same-call duplicate promises merge into one", plan.promises.length === 1 && plan.promises[0].quotes.length === 4, plan.promises);
  check("and a task already open for it carries it: no new search", plan.promises[0].coveredBy === 111);
  const solo = G.planCallAudit(claims, CALL, { knownBefore: "", records: "", tasks: [] });
  check("with no task open, still one promise, so one search at most", solo.promises.length === 1 && solo.promises[0].coveredBy === null);
  const cg = src("harness/callGrounding.ts");
  check("a covered promise neither searches nor saves an ask", /if \(p\.coveredBy\) \{[\s\S]{0,400}task #\$\{p\.coveredBy\} is carrying it/.test(cg));
  const co = src("routes/co.ts");
  // Commitments open the moment the call ends, with their confirmation (services/callFollowThrough.ts), before the task read; the
  // task read then notes a promise it shares instead of opening a second task, and the audit runs after it.
  check("after a call, commitments open first (call end), then the task read, then the audit", co.indexOf("m.followThroughOnCallEnd(") > 0 && co.indexOf("m.followThroughOnCallEnd(") < co.indexOf("await import(\"../services/callTasks.js\").then((m) => m.tasksFromCall(user_id, cleanTranscript))") && co.indexOf("m.tasksFromCall(user_id, cleanTranscript)") < co.indexOf("await auditCall(user_id, cleanTranscript, knownBeforeCall)") && /trackCommitmentsFromTranscript/.test(src("services/callFollowThrough.ts")));
}

// ---------------------------------------------------------------- 3c. asked vs. Co's own idea, from their words
{
  const c = { quote: "I'll text you what I put together, and you and your cofounder can review it.", asked_quote: null };
  const asked = G.askedQuoteFor(c, CALL);
  check("2026-10-08: their explicit ask ('I actually want you to take lead ... start planning any docs') is read as asked", !!asked && /take lead/.test(asked), asked);
  check("the audit's own quote counts when it's really theirs", G.askedQuoteFor({ quote: "x", asked_quote: "start planning any docs or PDFs" }, CALL) === "start planning any docs or PDFs");
  check("an invented quote doesn't, and Co's own unprompted offer stays Co's", G.askedQuoteFor({ quote: "I'll look for some events for you while we're at it", asked_quote: "please find me events" }, "assistant: How was your week?\nuser: Fine, busy.\nassistant: I'll look for some events for you while we're at it\nuser: sounds good") === null);
  const plan = G.planCallAudit([{ quote: c.quote, type: "promise_keepable", what: "text the drafted planning document" }], CALL, { knownBefore: "", records: "", tasks: [] });
  check("so the plan files it as their ask, never 'Co's own initiative'", plan.promises[0].asked !== null);
}

check("a call confirmation never counts as the promise kept (2026-10-08, with services/callFollowThrough.ts)", /ps\.type IN \('call_confirm', 'task_window'\) AND ps\.message = om\.content/.test(src("services/followThrough.ts")));
console.log(`post-call rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
