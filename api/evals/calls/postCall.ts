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
const CALL = `assistant: Hey Jordan, it's Cue. How's the launch going?
user: We moved the date. We're partnering with Lumen AI on something in November, at the Atrium with a guy named Ellis.
assistant: The most useful role at an event is helping people find the right person in the room. I can learn who's coming, who each person is trying to meet. Point people toward those connections.
user: That fits. Ellis runs logistics software for events.
assistant: So you're planning the November event at the Atrium with Ellis Marr. Want me to hold onto this?
user: ${ASK}
assistant: Yes, I can take that on. When we hang up, I'll set up a task to draft a planning doc. I'll text you what I put together, and you and your cofounder can review it. Should it focus on the event only, or also how Cue keeps a presence after it?
user: Yeah, for sure. The later half is more important.
assistant: Got it. Then the plan will focus on how Cue keeps its presence after the event. I'll set that up when we hang up and text you what I put together.
user: Yeah, it's perfect.
assistant: Good. I'll set up the post-event branding plan when we hang up. Text you what I find. Talk soon.
user: Thanks.`;

// ---------------------------------------------------------------- 1. capability corrections, held to the registry
{
  const q = "I can learn who's coming, who each person is trying to meet. Point people toward those connections.";
  const reg = G.auditRegistry();
  check("the audit reads the real registry: in-room guest-list matching is on it", reg.abilities.some((a) => a.id === "co_events" && /guest list/.test(a.can) && /who they hope to meet/.test(a.can)));
  check("the audit prompt carries every member-facing ability by id and the limits by number", (() => { const p = G.callAuditPrompt(CALL, "known"); return /\[co_events\] At Noise events: Cue knows who's coming/.test(p) && /\nL1 /.test(p) && /"limit": "L# or null"/.test(p) && /"asked_quote"/.test(p) && /"specifics"/.test(p); })());
  check("the call's own can't line no longer denies knowing what guests want at Noise's own events", /At Noise's own events it does know the guest list/.test(G.CALL_CAPABILITIES) && !/people's intentions\) it wasn't given/.test(G.CALL_CAPABILITIES));
  const today = G.capabilityCorrectionVerdict({ quote: q, what: "Cue cannot learn attendee identities or intentions at an event or make real-time matches", limit: "L8" });
  check("2026-10-08: 'I can learn who's coming, who each person is trying to meet' is refused as a correction, even citing a limit", !today.save && /co_events/.test(today.why), today);
  check("refused when the audit names the registry line that covers it", !G.capabilityCorrectionVerdict({ quote: "I'll point you to who's worth meeting", what: "x", ability: "co_events", limit: "L8" }).save);
  check("refused when it names no can't line it breaks (the old audit's shape)", !G.capabilityCorrectionVerdict({ quote: "I can book that table for you tonight", what: "x" }).save);
  const book = G.capabilityCorrectionVerdict({ quote: "I can book that table for you tonight", what: "Cue can't book", limit: String(`L${reg.limits.findIndex((l) => /can't book, buy, register/.test(l)) + 1}`) });
  check("a real wrong claim (booking) that cites the limit it breaks is still saved", book.save, book);
  const plan = G.planCallAudit([{ quote: q, type: "capability", what: "Cue cannot learn attendee identities", limit: "L8" }], CALL, { knownBefore: "", records: "", tasks: [] });
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
  check("Cue having said it earlier on the call is not a source", G.inventedFactVerdict({ quote: "It's at the Atrium with Ellis Marr", specifics: ["Ellis Marr"] }, `assistant: Ellis Marr runs it\n${CALL}`, "", "").save);
  check("the record loader reads only their own lines and Cue's records, never Cue's texts or summaries", /content LIKE 'User said:%'/.test(src("services/followThrough.ts")) && /FROM co_facts WHERE owner_user_id = \$1/.test(src("services/followThrough.ts")));
  // ElevenLabs' judge, re-checked
  const analysis = { evaluation_criteria_results: {
    no_invented_specifics: { criteria_id: "no_invented_specifics", result: "failure", rationale: "Cue invented 'Ellis Marr' — the member only said 'a guy named Ellis.' No last name was given." },
    names_and_voice: { criteria_id: "names_and_voice", result: "failure", rationale: "Cue invented the last name 'Marr' for Ellis, which the member never provided." },
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
  check("finish(done) and marking the send step done both go through the check, and the real turn reads what was sent", /if \(status === "done"\) \{\s*const kept = await promiseCloseCheck\(task, texts, deps, docsSent\);/.test(tt) && /stepDone && task\.source === "promise"/.test(tt) && /sentSince: \(since\) => sendsSince\(userId, since, task\.id\)/.test(tt));
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
  check("their ask and Cue's live promise answering it are the same commitment", F.sameCommitment({ goal: "Start planning docs and PDFs for branding and launch plans for the Lumen event", theirWords: ASK.slice(20) }, live));
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
  // A text send on the same call as a text task rides it (the live task here is a document, so use a text one).
  const textTask = { id: 112, goal: 'Keep your word from the call: "I\'ll text you the run link."', theirWords: "yes send it", createdAt: "2026-10-08T00:28:49Z", source: "promise" };
  cdeps.open = async () => [textTask];
  const fresh = await C.trackCallCommitment({ userId: "u1", sentence: "I'll text you those venue links right after we hang up.", theirLine: "can you send the venue links", now: new Date("2026-10-08T00:29:30Z") }, cdeps);
  // Royce, 2026-10-08 (his real call: two sends opened two tasks and two "nothing yet" texts): one call's sends are one delivery.
  check("a different send on the same call rides the same task, noted to go in the same message", !fresh.ok && started.length === 0 && cnotes.some((n) => n.id === 112 && /Also said on the call: "I'll text you those venue links/.test(n.t) && /same message/.test(n.t)), { fresh, cnotes });
  const startedBefore = started.length;
  const nextDay = await C.trackCallCommitment({ userId: "u1", sentence: "I'll text you those venue links right after we hang up.", theirLine: "can you send the venue links", now: new Date("2026-10-09T09:00:00Z") }, cdeps);
  check("a send on a later call still opens its own task", nextDay.ok && started.length === startedBefore + 1, nextDay);
  // the audit's promises: five ways of saying one thing become one, carried by the live task
  const claims: any[] = [
    { quote: "Yes, I can take that on. When we hang up, I'll set up a task to draft a planning doc.", type: "promise_keepable", what: "draft a post-event branding/presence planning doc" },
    { quote: "I'll text you what I put together, and you and your cofounder can review it.", type: "promise_keepable", what: "text the drafted planning document" },
    { quote: "Got it. Then the plan will focus on how Cue keeps its presence after the event. I'll set that up when we hang up and text you what I put together.", type: "promise_keepable", what: "draft and text a plan on Cue's post-event presence" },
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
  check("after a call, commitments open first (call end), then the task read, then the audit", co.indexOf("m.followThroughOnCallEnd(") > 0 && co.indexOf("m.followThroughOnCallEnd(") < co.indexOf("await import(\"../services/callTasks.js\").then((m) => m.tasksFromCall(user_id, cleanTranscript))") && co.indexOf("m.tasksFromCall(user_id, cleanTranscript)") < co.indexOf("await auditCall(user_id, cleanTranscript, knownBeforeCall") && /trackCommitmentsFromTranscript/.test(src("services/callFollowThrough.ts")));
}

// ---------------------------------------------------------------- 3c. asked vs. Co's own idea, from their words
{
  const c = { quote: "I'll text you what I put together, and you and your cofounder can review it.", asked_quote: null };
  const asked = G.askedQuoteFor(c, CALL);
  check("2026-10-08: their explicit ask ('I actually want you to take lead ... start planning any docs') is read as asked", !!asked && /take lead/.test(asked), asked);
  check("the audit's own quote counts when it's really theirs", G.askedQuoteFor({ quote: "x", asked_quote: "start planning any docs or PDFs" }, CALL) === "start planning any docs or PDFs");
  check("an invented quote doesn't, and Cue's own unprompted offer stays Cue's", G.askedQuoteFor({ quote: "I'll look for some events for you while we're at it", asked_quote: "please find me events" }, "assistant: How was your week?\nuser: Fine, busy.\nassistant: I'll look for some events for you while we're at it\nuser: sounds good") === null);
  const plan = G.planCallAudit([{ quote: c.quote, type: "promise_keepable", what: "text the drafted planning document" }], CALL, { knownBefore: "", records: "", tasks: [] });
  check("so the plan files it as their ask, never 'Cue's own initiative'", plan.promises[0].asked !== null);
}

// ---------------------------------------------------------------- after-call steps read the shared member-knowledge layer (PR 7)
{
  const PC = await import("../../src/jobs/postCallFollowUp.js");
  const MK = await import("../../src/services/memberKnowledge.js");
  const at = "2026-10-08T19:00:00.000Z";
  const identity = { firstName: "Jordan", city: null, zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: at };
  const k: any = {
    userId: "u1", asOf: at, identity,
    goals: [{ text: "Launch the brand at the Lumen event", state: "active", reason: null, told: false, verifiedAt: at }, { text: "Hire a designer", state: "done", reason: "hired", told: true, verifiedAt: at }],
    asks: [{ id: "a1", text: "venues for a launch dinner", kind: "find", verifiedAt: at }],
    delivered: [{ what: "Post-event presence plan", kind: "document", at, via: ["receipt"], url: "https://example.com/plan", reaction: null, verifiedAt: at }],
    carrying: [{ what: "Find venues for the launch dinner", kind: "task", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: "task #3", status: null, detail: null, verifiedAt: at }],
    lessons: [{ text: "Lead with the answer, not a question.", verifiedAt: at }],
    corrections: [{ field: "city", was: "Oakland", now: "San Francisco", verifiedAt: at }],
    preferences: [],
    claims: [
      { text: "Jordan is building a design studio.", provenance: "user_said", kind: "building", quote: "building a design studio", expiresOn: null, saidOn: "2026-10-05", verifiedAt: at },
      { text: "Jordan seems stretched thin.", provenance: "co_inferred", kind: "mood", quote: null, expiresOn: "2026-10-10", saidOn: "2026-10-07", verifiedAt: at },
    ],
    restraint: null,
    exchanges: [{ from: "member", text: "can you find venues", call: false, verifiedAt: at }, { from: "co", text: "summary of the call", call: true, verifiedAt: at }],
    person: null,
  };
  const kb = G.knownBeforeFrom(k, { facts: `Details on file for "Atrium mixer", which Cue sent them.\nThey've asked Cue for (their words): "venues for a launch dinner"`, impressions: "Who they are: a founder." });
  check("the audit's facts carry the layer's asks once, its delivered items and the picture's sent details", (kb.facts.match(/venues for a launch dinner/g) ?? []).length === 1 && /Post-event presence plan/.test(kb.facts) && /Atrium mixer/.test(kb.facts), kb.facts);
  check("a correction is on record only in its corrected version (the old value Cue might say is still caught)", /San Francisco/.test(kb.facts) && !/Oakland/.test(kb.facts + kb.impressions));
  check("what they said is a fact; Cue's read and goals (with state) are impressions only", /design studio/.test(kb.facts) && !/stretched thin/.test(kb.facts) && /stretched thin/.test(kb.impressions) && /Hire a designer \(done\)/.test(kb.impressions) && !/Hire a designer/.test(kb.facts));
  check("without the layer the audit reads the call picture as before", JSON.stringify(G.knownBeforeFrom(null, { facts: "f", impressions: "i" })) === JSON.stringify({ facts: "f", impressions: "i" }));
  const labelled = PC.labelClaims(k);
  check("the post-call claims keep their labels: what they said apart from Cue's read", labelled.enduring.length === 1 && /they said/.test(labelled.enduring[0]) && labelled.coInferred.length === 1 && /Cue's read/.test(labelled.coInferred[0]) && labelled.theySaid.length === 0);
  // Review of #121: the label is the day it was SAID, as their local date (2026-10-05 stays Oct 5 in Pacific, never Oct 4).
  check("claim labels are the day said, never shifted a day early through UTC", /they said, Oct 5\)/.test(labelled.enduring[0]) && /Cue's read, Oct 7, until Oct 9\)/.test(labelled.coInferred[0]) && /They said \(Oct 5\): Jordan is building/.test(kb.facts), { labelled, facts: kb.facts });
  // Review probe: a Denver -> Austin correction and an enduring "Lives in Denver" claim gave both as facts.
  {
    const probe: any = { ...k, corrections: [{ field: "city", was: "Denver", now: "Austin", verifiedAt: at }], claims: [{ text: "Jordan lives in Denver.", provenance: "user_said", kind: "city", quote: "I live in denver", expiresOn: null, saidOn: "2026-09-01", verifiedAt: at }, ...k.claims] };
    const pkb = G.knownBeforeFrom(probe, { facts: "", impressions: "" });
    check("probe: a claim holding a corrected-away value is no fact for the audit (only the correction is)", !/Denver/i.test(pkb.facts + pkb.impressions) && /Austin/.test(pkb.facts) && /design studio/.test(pkb.facts), pkb);
    const pl = PC.labelClaims(probe);
    const sf = G.uncorrectedClaims([{ text: "Is transferring teams" }, { text: "Lives in SF." }, { text: "Moved from Denver (CO)." }], [{ was: "SF" }, { was: "Denver (CO)" }]);
    check("probe: an 'SF' correction never drops 'Is transferring teams' (whole words only), but drops 'Lives in SF', and regex characters are literal", sf.length === 1 && sf[0].text === "Is transferring teams", sf);
    check("probe: and the post-call text never gets it as something they said", ![...pl.enduring, ...pl.theySaid, ...pl.coInferred].some((l) => /Denver/i.test(l)) && pl.enduring.length === 1, pl);
  }
  const sec = PC.postCallKnowledgeSection(k);
  const rules = MK.memberRules(k);
  check("the post-call text gets the member rules from memberRules(k), word for word", [rules.discretion, rules.memberSafety, rules.grounding, rules.deliveryShape, rules.restraint, rules.quietHours].every((r) => !r || sec.includes(r)));
  check("what they have is never restated, and what Cue carries is never in this text (#115)", /THEY ALREADY HAVE THESE \(never restate[^\n]*\n- "Post-event presence plan"/.test(sec) && /WORK CO IS CARRYING FOR THEM \(never in this text[^\n]*\n- Find venues/.test(sec) && !/task #3/.test(sec));
  check("recent texts carry when, and the call's own summary isn't one of them", /RECENT TEXTS, WITH WHEN[^\n]*\n- \w{3} Oct 8[^\n]*They: can you find venues/.test(sec) && !/summary of the call/.test(sec));
  check("restraint and quiet hours shape the text, never a reason to SKIP (code decides whether it goes)", /never a reason to SKIP/.test(sec));
  // Nothing from the layer goes into CONFIRMED_FACTS, so it can't back a day or a commitment in the draft.
  const P = await import("../../src/harness/proactive.js");
  let prompt = "";
  P.setProactiveModelForTests(async (p) => { prompt = p; return "SKIP"; });
  await PC.draftPostCallText("Jordan", "assistant: hi\nuser: The dinner is the hard part.", "", [], { theySaid: [], coInferred: [] }, null, k);
  P.setProactiveModelForTests(null);
  const factsBlock = prompt.slice(prompt.indexOf("CONFIRMED_FACTS"), prompt.indexOf("TASK"));
  check("the layer reaches the draft's task, never its facts", /WORK CO IS CARRYING/.test(prompt) && !/Find venues|Post-event presence plan|can you find venues/.test(factsBlock) && /what_co_said_it_would_look_into/.test(src("jobs/postCallFollowUp.ts")));
  const pc = src("jobs/postCallFollowUp.ts");
  check("a rejected layer read is caught and never replaced by un-stripped claims", /memberKnowledge\(userId, \{ include: POST_CALL_SECTIONS[^)]*\}\)\.catch\(\(\) => null\)/.test(pc) && !/liveClaimsRendered/.test(pc));
  check("the call's audit is handed the layer's knowledge with the call picture", /memberKnowledge\(user_id, \{ include: AUDIT_SECTIONS \}\)/.test(src("routes/co.ts")) && /knownBeforeFrom\(auditKnowledge, callPicture\)/.test(src("routes/co.ts")));
}

check("a call confirmation never counts as the promise kept (2026-10-08, with services/callFollowThrough.ts)", /ps\.type IN \('call_confirm', 'task_window'\) AND ps\.message = om\.content/.test(src("services/followThrough.ts")));
console.log(`post-call rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
