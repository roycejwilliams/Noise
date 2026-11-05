// The purpose boundary, through the real routing (Royce, 2026-11-04). Layer 1: the model is a stub (its verdicts are handed in as the
// reads would give them), the database is a fake, zero tokens, nothing sent. Invented members (Jordan, Dana).
//   npx tsx evals/scope/boundary.ts
// The rule under test: the model's read decides (the turn read's scope, the start-task call's own scope, the audit's read of a call
// promise, classifyAsk); code is a narrow backstop for unmistakable outs and never vetoes anything ambiguous or about meeting people.
// Each case runs on a text AND on a call (the same tool, onCall), and checks what work was created and what Cue was told to say.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

const { default: pool } = await import("../../src/db/db.js");
const created: { goal: string; followup: any; source: string }[] = [];
const closed: { id: number; status: string; outcome: string }[] = [];
const memories: { type: string; content: string }[] = [];
const sqlSeen: string[] = [];
let nextId = 100;
const answer = async (sql: string, p: any[] = []): Promise<{ rows: any[]; rowCount?: number }> => {
  const q = sql.replace(/\s+/g, " ");
  sqlSeen.push(q);
  if (/^INSERT INTO co_tasks/.test(q)) {
    const row = { id: nextId++, user_id: p[0], goal: p[1], their_words: p[2], steps: JSON.parse(p[3]), plan_next: p[4], next_check_at: p[5], status: "open", wakes: 0, notes: [], texts_sent: 0, kind: "work", source: p[9], followup: p[10] ? JSON.parse(p[10]) : null, created_at: new Date().toISOString() };
    created.push({ goal: row.goal, followup: row.followup, source: row.source });
    return { rows: [row] };
  }
  if (/^UPDATE co_tasks SET status = \$3/.test(q)) {
    closed.push({ id: Number(p[1]), status: p[2], outcome: p[3] });
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO co_memories/.test(q)) { memories.push({ type: p[1], content: p[2] }); return { rows: [{ id: 1 }] }; }
  return { rows: [], rowCount: 0 };
};
(pool as any).query = answer;
(pool as any).connect = async () => ({ query: answer, release: () => {} });
(await import("../../src/services/embeddings.js")).setEmbeddingsClientForTests({ embeddings: { create: async () => ({ data: [{ index: 0, embedding: [0] }] }) } } as any);
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));

const S = await import("../../src/harness/scope.js");
const T = await import("../../src/agent/conversationTools.js");
const CT = await import("../../src/services/coTasks.js");
const RT = await import("../../src/services/readTurn.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

type Verdict = { scope: "in" | "out" | "mixed"; connection?: string };
// One start-task call, on a text or on a call. `verdict` is the model's own scope on the call; `turn` the turn read's.
async function start(medium: "text" | "call", message: string, args: { goal: string; steps?: string[]; firstStep?: string; lookout?: boolean }, verdict?: Verdict, turn?: Verdict) {
  const onCall = medium === "call";
  const before = created.length;
  const t = T.createConversationTools({
    userId: "u-jordan", phoneNumber: "+10000000000", resolvedContent: message, isVoice: onCall, onCall, callKey: onCall ? `CA-${nextId}` : null, hasPendingOffer: false, recentOfferBurstActive: false,
    dryRun: false, isTeam: false, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" }, turnScope: turn ? S.parseVerdict(turn) : null,
  } as any);
  const r: any = await quietly(() => (t.tools as any).startTask.execute({ goal: args.goal, theirWords: message, steps: args.steps ?? [args.goal], firstStep: args.firstStep ?? args.goal, inHours: 3, ...(args.lookout ? { lookout: true } : {}), ...(verdict ? { scope: verdict.scope, ...(verdict.connection ? { connection: verdict.connection } : {}) } : {}) }, {})).catch((e: unknown) => ({ ok: false, error: String(e) }));
  return { r, made: created.slice(before) };
}
const both = async (label: string, message: string, args: Parameters<typeof start>[2], verdict: Verdict | undefined, expect: (x: Awaited<ReturnType<typeof start>>, medium: string) => boolean, turn?: Verdict) => {
  for (const medium of ["text", "call"] as const) { const x = await start(medium, message, args, verdict, turn); check(`${label} (${medium})`, expect(x, medium), { r: x.r, made: x.made.map((m) => m.goal) }); }
};
const made = (x: { made: unknown[]; r: any }) => x.r.ok === true && x.made.length === 1;
const refused = (x: { made: unknown[]; r: any }) => x.r.ok === false && x.made.length === 0;

// ---- a relevant intro
await both("an intro to someone in climate tech starts a task", "Can you introduce me to someone in climate tech?", { goal: "Find someone in climate tech worth an introduction for Jordan" }, { scope: "in" }, made);
await both("…and starts with no verdict at all (nothing ambiguous is vetoed)", "Can you introduce me to someone in climate tech?", { goal: "Find someone in climate tech worth an introduction for Jordan" }, undefined, made);

// ---- event prep, with research steps about the person's company (the reviewer's false out)
await both("prep for coffee with Dana, with a step researching the pricing of her product, starts", "Prep me for coffee with Dana Kim on Thursday", { goal: "Prep for coffee with Dana Kim on Thursday", steps: ["Research the pricing of her product", "Write talking points"], firstStep: "Read her company page" }, { scope: "in" }, made);
await both("…also with no verdict (the backstop never touches prep)", "Prep me for coffee with Dana Kim on Thursday", { goal: "Prep for coffee with Dana Kim on Thursday", steps: ["Research the pricing of her product", "Write talking points"], firstStep: "Read her company page" }, undefined, made);

// ---- a job transition that needs an intro, and the reviewer's false outs
await both("someone changing jobs who wants to meet people in climate tech starts", "I'm leaving my job next month and want to meet people in climate tech", { goal: "People and communities in climate tech for someone changing jobs" }, { scope: "in" }, made);
await both("'help me find a job through people I know' starts (people, not a job board)", "help me find a job through people I know", { goal: "Help Jordan find a job through the people he knows" }, undefined, made);
await both("…and when the model says in", "help me find a job through people I know", { goal: "Help Jordan find a job through the people he knows" }, { scope: "in" }, made);
await both("'find a photographer meetup' and 'a DJ collective community' start", "find a DJ collective community I could join", { goal: "Find a DJ collective community for Jordan" }, undefined, made);
await both("an event search for people planning a trip to Japan starts", "any events for people planning a trip to Japan to meet other travelers", { goal: "Find events for people planning a trip to Japan" }, undefined, made);

// ---- concierge: the backstop (no read in hand) and the model's verdict both stop it
const concierge: [string, string][] = [["find me a dentist near the Mission", "Find a dentist near the Mission"], ["compare laptops for me", "Compare laptops for Jordan"], ["plan my trip to Austin", "Plan Jordan's trip to Austin"], ["find me a cheaper Verizon plan", "Find a cheaper Verizon plan for Jordan"]];
for (const [m, goal] of concierge) {
  await both(`concierge '${m}' is refused by the backstop alone and nothing is created`, m, { goal }, undefined, (x) => refused(x) && /isn't something Cue does/.test(x.r.error));
  await both(`…and when the model says out`, m, { goal }, { scope: "out" }, (x) => refused(x) && /isn't something Cue does/.test(x.r.error));
}
await both("the model's out wins even where no word would have caught it (a therapist search)", "find me a therapist who takes my insurance", { goal: "Find a therapist who takes Jordan's insurance" }, { scope: "out" }, refused);
await both("the model's in wins over the backstop (a laptop community)", "find me a community of people who refurbish laptops", { goal: "Find a community of laptop refurbishers for Jordan" }, { scope: "in" }, made);
await both("the turn read's verdict is used when the call carries none", "find me an apartment in the Mission", { goal: "Find an apartment in the Mission" }, undefined, refused, { scope: "out" });

// ---- 'watch for PM jobs' is declined (a job-listings watch); a watch on rooms is not
await both("'watch for PM jobs' is declined", "watch for PM jobs", { goal: "Watch for PM jobs", lookout: true }, undefined, refused);
await both("'send me PM jobs every week' is declined", "send me PM jobs every week", { goal: "Send Jordan PM jobs every week", lookout: true }, undefined, refused);
await both("a lookout for founder dinners is kept", "keep an eye out for founder dinners in the Mission", { goal: "Founder dinners in the Mission", lookout: true }, { scope: "in" }, made);

// ---- a mixed request: only the connection part starts, or one question
await both("mixed with a connection part is refused whole, and the refusal carries the part to start", "plan my trip to Austin around meeting founders there", { goal: "Plan a trip to Austin and meet founders" }, { scope: "mixed", connection: "meet founders in Austin" }, (x) => refused(x) && /meet founders in Austin/.test(x.r.error) && /ONLY the connection part/.test(x.r.error));
await both("…then the connection part alone starts", "plan my trip to Austin around meeting founders there", { goal: "Meet founders in Austin" }, { scope: "in" }, made);
await both("mixed with no clean connection part: one short question, nothing starts", "plan my trip to Austin and book a table somewhere", { goal: "Plan a trip to Austin" }, { scope: "mixed" }, (x) => refused(x) && /ONE short question/.test(x.r.error));
check("the connection part of a mixed ask is never the whole text", S.connectionPart("plan my trip to Austin and book a table somewhere", { scope: "mixed", connection: null }) === null && S.connectionPart("find me a dentist", { scope: "out", connection: null }) === null && S.connectionPart("Founder dinners in the Mission, and book me a dentist") === "Founder dinners in the Mission");
check("…and an ask with nothing outside it comes back unchanged", S.connectionPart("Founder dinners in the Mission") === "Founder dinners in the Mission");

// ---- the backstop never vetoes anything about meeting people (the reviewer's probes)
for (const m of ["Find a photographer meetup", "find a DJ collective community I could join", "Prep for coffee with Dana", "help me find a job through people I know", "find me investors to meet at a dinner", "keep an eye out for roles at climate startups I could get intros into", "find a hotel near the founders dinner"]) check(`the backstop does not call '${m}' out`, S.classifyScope(m).scope !== "out", S.classifyScope(m));
check("…and does call the unmistakable ones out", ["find me a dentist", "find me a cheaper Verizon plan", "compare laptops", "book me a flight to NYC", "watch for PM jobs"].every((m) => S.classifyScope(m).scope === "out"));

// ---- the turn read carries the verdict (no new model call), and a quick fact carries none
const base = { reason: "r", answers: null, ambiguousBetween: [], call: "none", wantsRecommendation: false, confidence: "high", mode: "asking", topic: "x" };
const withScope = RT.parseTurnRead({ ...base, scope: { verdict: "mixed", connection: "meet founders in Austin" } }, []);
const factTurn = RT.parseTurnRead({ ...base, scope: null }, []);
check("the turn read parses the scope verdict and the connection phrase", withScope.scope?.scope === "mixed" && withScope.scope?.connection === "meet founders in Austin", withScope.scope);
check("a quick fact (no work asked for) carries no verdict, so nothing is started on its account", factTurn.scope === null);
check("the turn read's prompt asks for the verdict in the same JSON (one call, no extra)", /"scope": only when they ask Cue to do, find or keep watching/.test(RT.turnReadAddendum(null, null)) && (src("services/readTurn.ts").match(/generateText\(/g) ?? []).length === 1);
check("the verdict reaches the tools: sendblue → reply facts → conversation tools", /replyFacts\.turnScope = turnRead\?\.scope/.test(src("routes/sendblue.ts")) && /turnScope: input\.facts\.turnScope/.test(src("agent/conversationReply.ts")));

// ---- the verdict is kept on the task, so a wake judges by it
const kept = await start("text", "keep an eye out for founder dinners in the Mission", { goal: "Founder dinners in the Mission", lookout: true }, { scope: "in" });
check("the task row keeps the model's verdict", kept.made[0]?.followup?.scope?.scope === "in", kept.made[0]);

// ---- code-written tasks are trusted: Cue's own connection deliveries (the owed link) are kept, never refused for their words
const owed = await CT.startTask({ userId: "u-jordan", goal: "Keep your word from the call: text them the link to Laptop Swap & Coffee Meetup", theirWords: "(said on a call)", steps: [{ text: "Send the link as its own text" }], firstPlan: "Send each link as its own text", inHours: 1, source: "promise", scope: { scope: "in", connection: null }, trusted: true });
check("the owed-link task is kept (even with a laptop in its name)", owed.ok === true);
const owedBare = await CT.startTask({ userId: "u-jordan", goal: "Keep your word from the call: text them the link to a dentist directory", theirWords: "(said on a call)", steps: [], firstPlan: "send it", inHours: 1, source: "promise", trusted: true });
check("a trusted task is never refused, whatever its words say", owedBare.ok === true);
const call = src("services/callTools.ts");
check("the owed-link start passes trusted, and a failure is logged, never swallowed to null", /trusted: true/.test(call) && !/source: "promise",\s*\}\)\.catch\(\(\) => null\)/.test(call) && /owed-link task could not start/.test(call));

// ---- an old queued general task wakes and is closed honestly (told once when they asked, never worked)
const TT = await import("../../src/services/taskTurn.js");
const queued = (id: number, goal: string, source: "ask" | "lookout", extra: any = {}) => ({ id, userId: "u-jordan", goal, theirWords: goal, steps: [{ text: goal }], planNext: "search", nextCheckAt: null, status: "open", wakes: 0, notes: [], textsSent: 0, lastTextedAt: null, createdAt: new Date().toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", followup: null, source, ...extra }) as any;
const sentLines: string[] = [];
const handBack = (draft: string | null) => async () => ({ firstName: "Jordan", draft: async () => draft, send: async (t: string) => { sentLines.push(t); return { sent: true, queued: false }; }, close: async (outcome: string) => { closed.push({ id: -1, status: "dropped", outcome }); } });
const c0 = closed.length;
await quietly(() => TT.runDueTask(queued(501, "Compare laptops for Jordan", "ask"), { handBack: handBack("Laptops aren't something I do. Happy to help with who to meet, though.") }));
check("an old queued 'compare laptops' task they asked for is told once, in one line, and closed as dropped, never worked", sentLines.length === 1 && closed.length === c0 + 1 && /closed without being done/.test(closed[closed.length - 1].outcome) && !sqlSeen.some((q) => /INSERT INTO co_tasks/.test(q) && false), { sentLines, closed: closed.slice(c0) });
const c1 = closed.length, s1 = sentLines.length;
await quietly(() => TT.runDueTask(queued(502, "Find a dentist near the Mission", "lookout", { lookoutOrigin: "co" }), { handBack: handBack("never sent") }));
check("Cue's own old out-of-scope look-out closes quietly: nothing is texted about work they never asked for", sentLines.length === s1 && closed.length === c1 + 1);
// They asked for it and the line can't be written or sent: never a silent close. It stays open and tries again; only after several tries
// does it close, with the record saying they were never told, and it is never called done.
const c1b = closed.length; let later = 0;
const failing = async () => ({ firstName: "Jordan", draft: async () => null, send: async () => ({ sent: false, queued: false }), close: async (outcome: string) => { closed.push({ id: -2, status: "dropped", outcome }); }, later: async () => { later++; } });
await quietly(() => TT.runDueTask(queued(504, "Compare laptops for Jordan", "ask", { wakes: 1 }), { handBack: failing }));
check("a line that could not be sent keeps the task open for another try: no silent close", later === 1 && closed.length === c1b, { later, closed: closed.slice(c1b) });
await quietly(() => TT.runDueTask(queued(505, "Compare laptops for Jordan", "ask", { wakes: 4 }), { handBack: failing }));
check("after the last try it closes, and the record says they were never told, and that it was closed without being done", closed.length === c1b + 1 && /could not be sent after several tries/.test(closed[closed.length - 1].outcome), closed.slice(c1b));
const c2 = closed.length;
await quietly(() => TT.runDueTask(queued(503, "Keep your word: text them the link to Laptop Swap & Coffee Meetup", "ask", { followup: { scope: { scope: "in", connection: null } } }), { handBack: handBack("never sent") }).catch(() => {}));
check("a task whose stored verdict is in is not closed for scope, whatever its words say", closed.length === c2 || !closed.slice(c2).some((c) => /closed without being done/.test(c.outcome)), closed.slice(c2));

// ---- the research brief only looks for rooms, events and communities
const rb = src("services/researchBrief.ts");
check("the research brief searches rooms and events: the event query and schema, no venue path", /assembleQuery\("event"/.test(rb) && /findRoomOptions\(/.test(rb) && !/findVenueOptions|readVenueSource|peerspace/i.test(rb.replace(/The scripted Peerspace venue reader[^\n]*/, "")) && !/assembleQuery\("venue"/.test(src("agent/loopTools.ts")));
check("the research tool refuses outside work through the same guard", /scopeRefusal\(\{ goal: input\.what, scope: ctx\.turnScope/.test(src("agent/loopTools.ts")));

// ---- the call promise for flights: no search, no 'Looked into', and an honest close
const CG = await import("../../src/harness/callGrounding.js");
const known = { facts: "Jordan lives in San Francisco.", impressions: "" };
const transcript = "user: I need to get to NYC next month, can you look at flights?\nassistant: Sure, I'll look into flights to New York for you and text you what I find.";
const claim = { quote: "I'll look into flights to New York for you and text you what I find.", type: "promise_keepable" as const, what: "cheap flights to New York next month", asked_quote: null, scope: "out" as const };
const m0 = memories.length, q0 = sqlSeen.length;
await quietly(() => CG.auditCall("u-jordan", transcript, known, { claims: [claim] as any, tasks: [], doneOnCall: [] }));
const newSql = sqlSeen.slice(q0);
check("the flights promise: no task, no search, no promise result written ('Looked into' never appears)", created.every((c) => !/flight/i.test(c.goal)) && !newSql.some((q) => /call_promise_results|attemptEventSurfacing|INSERT INTO ask_checkins/.test(q)) && !memories.slice(m0).some((x) => /Looked into/.test(x.content) || x.type === "promise_result"), { newSql: newSql.slice(0, 4), mem: memories.slice(m0) });
const note = memories.slice(m0).find((x) => x.type === "call_correction");
check("…and the promise is closed honestly: a note for the follow-up text to say, in Cue's own words, that it won't take it on", !!note && /promise_unkeepable/.test(note.content) && /Tell them so briefly, in your own words/.test(note.content), memories.slice(m0));
const m1 = memories.length;
await quietly(() => CG.auditCall("u-jordan", transcript, known, { claims: [{ ...claim, scope: undefined }] as any, tasks: [], doneOnCall: [] }));
check("…also when the audit gave no verdict (the backstop catches flights)", memories.slice(m1).some((x) => x.type === "call_correction" && /promise_unkeepable/.test(x.content)) && !memories.slice(m1).some((x) => x.type === "promise_result"));
const m2 = memories.length;
await quietly(() => CG.auditCall("u-jordan", "user: any founder dinners?\nassistant: I'll keep an eye out for founder dinners in the Mission and text you.", known, { claims: [{ quote: "I'll keep an eye out for founder dinners in the Mission and text you.", type: "promise_keepable", what: "founder dinners in the Mission", asked_quote: null, scope: "in" }] as any, tasks: [], doneOnCall: [] }));
check("a promise to find founder dinners is kept as before (a thread opens, no decline note)", created.some((c) => /founder dinners/i.test(c.goal)) && !memories.slice(m2).some((x) => x.type === "call_correction"), { created: created.map((c) => c.goal), mem: memories.slice(m2) });
check("startTask refusals for scope are never fallen back from in the call path", /opened === "declined"/.test(src("harness/callGrounding.ts")) && /outOfScope\) return "declined"/.test(src("harness/callGrounding.ts")));

console.log(`${total - failed}/${total} scope boundary checks passed`);
process.exit(failed ? 1 : 0);
