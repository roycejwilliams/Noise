// Ask retirement through the recheck flow (Royce, 2026-10-13: "Fix the retirement ID bug, but retirement must respect the recheck
// flow: ask once, then idle, with a member-visible note - no silent expiries. If retirement and the recheck disagree about who acts
// first, the recheck acts first."). Zero tokens: the store, the fence, the reads, the line writer and the clock are stubbed.
//   1. the id is the UUID it is (it was Number(), NaN); the plan marks retire-due; a Co-task ask is left as it is (Royce deciding)
//   2. the recheck acts first: a tied goal's recheck due or open holds the ask; a goal that stops after the mark takes it along
//   3. a standalone ask: one question, idle after 7 days unanswered, one note; once asked only their answer (read against Co's last
//      text) or a reaction counts; "pick it back up" brings it back
//   4. one question at a time across goals and asks; the note once, in Co's voice, fenced, never on a heavy check-in
//   5. the runs end to end: plan, question, idle, note, told
//   npx tsx evals/goals/retire.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const A = await import("../../src/services/askRetire.js");
const G = await import("../../src/services/goalEdges.js");
const R = await import("../../src/services/goalRecheck.js");
const L = await import("../../src/services/laneMoves.js");
const { default: pool } = await import("../../src/db/db.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const DAY = 86_400_000;
const NOW = new Date("2026-11-20T18:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const UUID = "5f0c2a8e-3b7d-4e21-9c1a-6d2f8b3e4a10";
const UUID2 = "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";

const WORK = "partnering with Sequin AI for a November launch party";
const ASK = "Sequin AI launch party venues";
const QUESTION = "Still want me looking for Sequin AI launch party venues, or should I let it go?";
type Row = import("../../src/services/askRetire.js").RetireRow;
type GV = import("../../src/services/askRetire.js").GoalView;
const ask = (o: Partial<Row> = {}): Row => ({
  id: UUID, text: ASK, kind: "find", intent: null, dueAt: ago(1), goals: [G.goalHash(WORK)], askedAt: null, hints: 0, holdUntil: null, retiredAt: null, toldAt: null, withGoal: null, note: null, ...o,
});
const goal = (o: Partial<GV> = {}): GV => ({
  goalHash: G.goalHash(WORK), goal: WORK, state: "active", reason: "", source: "context", toldAt: ago(60), changedAt: ago(60), recheckAskedAt: null, lastSignalAt: ago(30), idleNote: null, ...o,
});
const decide = (asks: Row[], o: Partial<import("../../src/services/askRetire.js").RetireInput> = {}) => A.retireDecide({ asks, goals: [goal()], goalSteps: [], now: NOW, signals: [], lastAskAt: null, lastExchangeAt: ago(1), held: [], pendingText: [], ...o });
const one = (a: Row, o: any = {}) => decide([a], o)[0];
const withPool = async <T>(fn: (sql: string, args: any[]) => any, run: () => Promise<T>): Promise<T> => {
  const orig = (pool as any).query;
  (pool as any).query = async (sql: string, args: any[] = []) => fn(sql, args) ?? { rows: [], rowCount: 1 };
  try { return await run(); } finally { (pool as any).query = orig; }
};

// ---- 1. the id; the plan marks; a Co-task ask is left as it is
{
  const calls: { sql: string; args: any[] }[] = [];
  const store = (servesState: string | null, text = ASK) => (sql: string, args: any[]) => {
    calls.push({ sql, args });
    if (/SELECT id, ask_text, intent FROM ask_checkins/.test(sql)) return { rows: [{ id: UUID, ask_text: ASK, intent: null }], rowCount: 1 };
    if (/SELECT ask_text, serves_goal_id, kind/.test(sql)) return { rows: [{ ask_text: text, serves_goal_id: "g7", kind: "find" }], rowCount: 1 };
    if (/SELECT intent FROM co_profiles/.test(sql)) return { rows: [{ intent: [{ id: "g7", kind: "goal", status: "active", text: "host a launch party in November" }] }], rowCount: 1 };
    if (/SELECT state FROM goal_states/.test(sql)) return { rows: servesState ? [{ state: servesState }] : [], rowCount: servesState ? 1 : 0 };
    return null;
  };
  await withPool(store(null), async () => {
    const asks = await G.realGoalDeps.findAsks("u1");
    check("the ask's id is read as the UUID it is (it was Number(), NaN)", asks.length === 1 && asks[0].id === UUID && typeof asks[0].id === "string", asks);
    await G.realGoalDeps.helpAsk("u1", asks[0].id, null, [WORK]);
  });
  const mark = calls.find((c) => /UPDATE ask_checkins SET retire_due_at/.test(c.sql));
  check("the plan marks it retire-due with that UUID, tied to the goal it restates and the active goal it serves", !!mark && mark.args[0] === UUID && mark.args[2].includes(G.goalHash(WORK)) && mark.args[2].includes(G.goalHash("host a launch party in November")), mark?.args);
  check("...never switching a member-findable ask's kind on the spot", !calls.some((c) => /SET kind = /.test(c.sql)));
  check("the mark keeps the first time, never touches a lookout or an ask they said keep", !!mark && /COALESCE\(retire_due_at, NOW\(\)\)/.test(mark.sql) && /intent IS DISTINCT FROM 'lookout'/.test(mark.sql) && /retire_hold_until IS NULL OR retire_hold_until <= NOW\(\)/.test(mark.sql));
  calls.length = 0;
  await withPool(store("done"), () => A.flagRetire("u1", UUID, null, [WORK]));
  const mark2 = calls.find((c) => /UPDATE ask_checkins SET retire_due_at/.test(c.sql));
  check("the goal it serves is tied only while that goal is active", !!mark2 && mark2.args[2].join() === G.goalHash(WORK), mark2?.args);
  calls.length = 0;
  await withPool(store(null, "Have Cue draft the launch plan with Sequin AI"), () => A.flagRetire("u1", UUID, null, [WORK]));
  check("a Co-task ask is left exactly as it is: no kind change, no mark, no question, no note, logged", !calls.some((c) => /UPDATE ask_checkins SET kind/.test(c.sql)) && !calls.some((c) => /retire_due_at/.test(c.sql)) && calls.some((c) => /INSERT INTO harness_decisions/.test(c.sql) && c.args.includes("co_task_unchanged")), calls.map((c) => c.sql.slice(0, 60)));
  // The planner hands the UUID and the tied goals through, and re-evaluates the marks only on a whole read.
  const helped: any[] = [];
  let kept: string[] | null = null;
  const deps = (answer: string): any => ({
    model: async () => answer, states: async () => new Map(), setState: async () => true, corrections: async () => [], retired: () => null,
    findAsks: async () => [{ id: UUID, text: ASK, intent: null }, { id: UUID2, text: "jazz nights in Oakland", intent: null }],
    helpAsk: async (_u: string, id: string, _i: any, goals: string[]) => { helped.push({ id, goals }); },
    keepRetireFlags: async (_u: string, ids: string[]) => { kept = ids; }, log: async () => {},
  });
  await G.planGoalSweep("u1", [WORK], { city: "San Francisco", zone: "America/Los_Angeles", now: NOW }, deps(JSON.stringify([{ n: 1, kind: "work", edges: [], until: null, superseded_by: null, why: "their own plan" }])));
  check("the plan marks only the ask that restates the work goal, by UUID, with that goal", helped.length === 1 && helped[0].id === UUID && helped[0].goals.join() === WORK, helped);
  check("...and on a whole read, re-evaluates the marks it no longer makes", JSON.stringify(kept) === JSON.stringify([UUID]));
  kept = null; helped.length = 0;
  await G.planGoalSweep("u1", [WORK], { city: "San Francisco", zone: "America/Los_Angeles", now: NOW }, deps(""));
  check("a failed read marks nothing and clears nothing", helped.length === 0 && kept === null);
  // Which marks a whole plan clears.
  const aside = goal({ goalHash: "aside", state: "stale", reason: "its window passed (2026-11-01)", toldAt: null });
  const clear = A.marksToClear([ask({ id: "a1" }), ask({ id: "a2", goals: ["aside"] }), ask({ id: "a3", askedAt: ago(1) }), ask({ id: "a4" })], ["a4"], [goal(), aside]);
  check("a whole plan clears an unasked mark it no longer makes, but keeps one tied to a set-aside still to be told, one asked, and one re-marked", clear.join() === "a1", clear);
  check("...and the clear goes through that pure read", /const clear = marksToClear\(asks, ids, goals\);/.test(src("services/askRetire.ts")));
}

// ---- 2. the recheck acts first
{
  check("the tied goal's recheck is open: the ask waits", one(ask(), { goals: [goal({ recheckAskedAt: ago(2) })] }).action === "wait");
  check("...a recheck asked 8 days ago is no longer open: the ask isn't held by it", one(ask(), { goals: [goal({ recheckAskedAt: ago(8) })] }).action === "due");
  check("the tied goal's recheck is due this run: the ask waits", one(ask(), { goalSteps: [{ goalHash: G.goalHash(WORK), action: "due" }] }).action === "wait");
  check("the tied goal is set aside and its question not yet told: the ask waits", one(ask(), { goals: [goal({ state: "stale", reason: "its window passed (2026-11-01)", toldAt: null, changedAt: ago(0.5) })] }).action === "wait");
  const idleAfter = goal({ state: "stale", reason: R.RECHECK_IDLE_REASON, toldAt: null, changedAt: ago(0.2) });
  check("the goal idles via the recheck after the mark: the ask idles with it, no question of its own", one(ask(), { goals: [idleAfter] }).action === "idle_with_goal");
  check("...a goal closed and told after the mark takes it too", one(ask(), { goals: [goal({ state: "done", toldAt: ago(0.5), changedAt: ago(0.5) })] }).action === "idle_with_goal");
  check("...but a goal that stopped long before the mark doesn't: the ask is asked once on its own", one(ask(), { goals: [goal({ state: "done", toldAt: ago(40), changedAt: ago(40) })] }).action === "due");
  const notes = A.notesFrom([{ goalHash: G.goalHash(WORK), goal: WORK, state: "stale", reason: R.RECHECK_IDLE_REASON, source: "context", toldAt: null, changedAt: ago(0.5), idleNote: "I've let the Sequin AI launch go for now; say the word and I'll pick it back up" }], [{ id: UUID, text: ASK, retiredAt: ago(0.5), toldAt: null, withGoal: G.goalHash(WORK) }]);
  check("...one note covers both: the goal's stored line, none for the ask that went with it", notes.length === 1 && notes[0].kind === "goal" && notes[0].line.startsWith("I've let the Sequin AI launch go"), notes);
  check("...the goal's note told tells the asks that went with it, and the goal coming back brings them back", /UPDATE ask_checkins SET retire_told_at = NOW\(\) WHERE user_id = \$1 AND retired_with_goal = \$2/.test(src("services/askRetire.ts")) && /A\.reviveAsksWithGoal\(userId, goalHash\(goal\)\)/.test(src("services/goalRecheck.ts")) && /if \(state === "active"\) await import\("\.\.\/services\/askRetire\.js"\)\.then\(\(A\) => A\.reviveAsksWithGoal\(ctx\.userId, G\.goalHash\(match\)\)\)/.test(src("agent/loopTools.ts")));
  check("the goal answered or brought back since the mark: cleared, the next plan decides again", one(ask(), { goals: [goal({ lastSignalAt: ago(0.2) })] }).action === "unflag");
  check("...but never once the ask's own question is out", one(ask({ askedAt: ago(2) }), { goals: [goal({ lastSignalAt: ago(0.2) })] }).action === "asked");
}

// ---- 3. a standalone ask: one question, idle, one note; their answer; pick it back up
{
  check("marked, its goal quiet: due, asked in the next natural reply", one(ask()).action === "due");
  check("asked 6 days ago, nothing: waiting; 7 and 30 days: not carried any more (none), never retired for silence", one(ask({ askedAt: ago(6) })).action === "asked" && one(ask({ askedAt: ago(7) })).action === "none" && one(ask({ askedAt: ago(30) })).action === "none");
  const n = A.notesFrom([], [{ id: UUID, text: ASK, retiredAt: ago(0.1), toldAt: null, note: "I've set aside the Sequin AI venue search; say the word and I'll pick it back up" }]);
  check("the idled ask leaves one note: its stored line", n.length === 1 && n[0].kind === "ask" && n[0].line.startsWith("I've set aside the Sequin AI venue search"), n);
  check("...told, never owed again", A.notesFrom([], [{ id: UUID, text: ASK, retiredAt: ago(0.1), toldAt: ago(0.05) }]).length === 0);
  check("before the question, a mention keeps it searched (held off 30 days)", one(ask(), { signals: [{ askId: UUID, at: ago(0.5), kind: "text" }] }).action === "keep" && A.RETIRE_HOLD_DAYS === 30);
  check("once asked, a text naming it is not a keep (a 'no' names it too); only a reaction is", one(ask({ askedAt: ago(2) }), { signals: [{ askId: UUID, at: ago(0.5), kind: "text" }] }).action === "asked" && one(ask({ askedAt: ago(2) }), { signals: [{ askId: UUID, at: ago(0.5), kind: "reaction" }] }).action === "keep");
  check("held: never a question again inside the 30 days", one(ask({ holdUntil: new Date(NOW.getTime() + 10 * DAY) })).action === "none");
  check("the idle goes through the one kind write (help), revive back to find", /setAskKind\(pool, \{ id: row\.id, userId, read: \{ kind: row\.kind, intent: row\.intent \}, kind: "help" \}\)/.test(src("services/askRetire.ts")) && /setAskKind\(pool, \{ id: row\.id, userId, read: \{ kind: row\.kind, intent: row\.intent \}, kind: "find" \}\)/.test(src("services/askRetire.ts")));
  // Their answer, read against Co's last text, after the reply's path. The stub reads the prompt the way the real read is told to.
  const calls: string[] = [];
  const stub = (rows: Row[], goals: GV[] = []): any => ({
    asks: async () => rows, goals: async () => goals, texts: async () => [], reactions: async () => [], lastAsk: async () => null, held: async () => [], pendingText: async () => [],
    keep: async (_u: string, r: Row) => { calls.push(`keep:${r.id}`); }, unflag: async () => {}, revive: async (_u: string, r: Row) => { calls.push(`revive:${r.id}`); return true; },
    reviveGoal: async (_u: string, g: GV) => { calls.push(`reviveGoal:${g.goalHash}`); return true; },
    idle: async (_u: string, r: Row, how: any) => { calls.push(`idle:${r.id}:${Object.keys(how)[0]}`); return true; }, queueText: async () => true, log: async () => {},
  });
  const answerRead = (answer: "yes" | "no") => async (p: string) => {
    const last = p.split("Cue's last text to them:")[1]?.split("Their reply:")[0] ?? "";
    return JSON.stringify({ question_in_last_text: /still want me looking for/i.test(last), answer, reason: "stub" });
  };
  const open = [ask({ askedAt: ago(1) })];
  await withPool(() => null, async () => {
    await A.noteAskText("u1", "No, stop looking for the Sequin AI launch party venues", { lastCoText: QUESTION, now: NOW }, stub(open), { answer: answerRead("no") });
    check("'No, stop looking for the Sequin AI launch party venues' after the question: idle at their word, no note, no hold", calls.join() === `idle:${UUID}:said`, calls);
    calls.length = 0;
    await A.noteAskText("u1", "yes please, keep at it", { lastCoText: QUESTION, now: NOW }, stub(open), { answer: answerRead("yes") });
    check("their yes keeps it", calls.join() === `keep:${UUID}`, calls);
    calls.length = 0;
    await A.noteAskText("u1", "no thanks", { lastCoText: "Want the link for the founder supper on Thursday?", now: NOW }, stub(open), { answer: answerRead("no") });
    check("a 'no thanks' to an event offer inside the window doesn't stop the ask", calls.length === 0, calls);
    await A.noteAskText("u1", "no", { lastCoText: "Sounds like a big week.", now: NOW }, stub(open), { answer: async () => { calls.push("read"); return "{}"; } });
    check("Cue's last text has no question: no read at all", calls.length === 0);
    await A.noteAskText("u1", "hmm", { lastCoText: QUESTION, now: NOW }, stub(open), { answer: async () => { throw new Error("down"); } });
    await A.noteAskText("u1", "ok", { lastCoText: QUESTION, now: NOW }, stub(open), { answer: async () => "not json" });
    check("a failed or unreadable read changes nothing", calls.length === 0, calls);
    // Pick it back up: their reply to the note, for 14 days.
    const NOTE = "I've stopped looking for Sequin AI launch party venues; say the word and I'll pick it back up";
    const told = [ask({ retiredAt: ago(3), toldAt: ago(2), note: NOTE, dueAt: ago(20), askedAt: ago(10) })];
    const yesRevive = async (p: string) => JSON.stringify({ revive: /pick it back up/i.test(p.split("Their reply:")[1] ?? ""), reason: "stub" });
    await A.noteAskText("u1", "actually yes, pick it back up", { lastCoText: `Good luck with the deck. ${NOTE}.`, now: NOW }, stub(told), { revive: yesRevive });
    check("'pick it back up' right after the note brings the ask back", calls.join() === `revive:${UUID}`, calls);
    calls.length = 0;
    await A.noteAskText("u1", "ok thanks", { lastCoText: `Good luck with the deck. ${NOTE}.`, now: NOW }, stub(told), { revive: yesRevive });
    check("...an 'ok thanks' to it doesn't", calls.length === 0, calls);
    await A.noteAskText("u1", "can you pick the Sequin AI launch party venues back up?", { lastCoText: "Morning.", now: NOW }, stub([{ ...told[0], toldAt: ago(15) }]), { revive: async () => { calls.push("read"); return '{"revive":true}'; } });
    check("...after 14 days, no revive read", calls.length === 0, calls);
    await A.noteAskText("u1", "how was your weekend", { lastCoText: "Morning.", now: NOW }, stub(told), { revive: async () => { calls.push("read"); return '{"revive":true}'; } });
    check("...a text that neither answers the note nor names it gets no read", calls.length === 0, calls);
    const gNote = "I've stopped looking for things for partnering with Sequin AI; say the word and I'll pick it back up";
    await A.noteAskText("u1", "please pick it back up", { lastCoText: gNote, now: NOW }, stub([], [goal({ state: "stale", reason: R.RECHECK_IDLE_REASON, toldAt: ago(1), changedAt: ago(2), idleNote: gNote })]), { revive: yesRevive });
    check("a goal's note answered 'pick it back up' brings the goal back (and its asks with it)", calls.join() === `reviveGoal:${G.goalHash(WORK)}` && /if \(rowCount\) await reviveAsksWithGoal\(userId, g\.goalHash\)/.test(src("services/askRetire.ts")), calls);
  });
  check("the reads are strict: only a read that says Cue's last text asked it acts", A.readRetireAnswer('{"question_in_last_text": true, "answer": "no"}') === "no" && A.readRetireAnswer('{"question_in_last_text": false, "answer": "no"}') === "neither" && A.readRetireAnswer('{"answer":"yes"}') === "neither" && A.readRevive('{"revive": true}') && !A.readRevive('{"revive": "yes"}') && !A.readRevive("yes"));
  check("the answer read sees Cue's last text, and a 'no thanks' to something else is neither", /Cue's last text to them:/.test(A.retireAnswerPrompt(ASK, "x?", "y")) && /A "no thanks" to something else Cue offered is "neither"/.test(A.retireAnswerPrompt(ASK, "x?", "y")));
  check("the text route hands the answer read Cue's last text", /A\.noteAskText\(user\.id, content, \{ lastCoText: A\.lastCoBlock\(recentConversation\) \}\)/.test(src("routes/sendblue.ts")));
  check("Cue's last text is the run of Cue lines at the end, a question in an earlier beat included", A.lastCoBlock("User said: hi\nCo replied: Here's the link\nCo replied: Still want me looking for venues?") === "Here's the link\nStill want me looking for venues?" && A.lastCoBlock("Co replied: Old\nUser said: x\nCo replied: New") === "New");
}

// ---- 4. one question at a time; the note
{
  check("a goal's recheck asked this run: the ask waits (goals first)", one(ask(), { goalSteps: [{ goalHash: "other", action: "due" }] }).action === "wait");
  check("any question (goal or ask) within 3 days: no ask", one(ask(), { lastAskAt: ago(1) }).action === "none" && one(ask(), { lastAskAt: ago(3) }).action === "due");
  const two = decide([ask(), ask({ id: UUID2, text: "jazz nights in Oakland", goals: [], dueAt: ago(2) })]);
  check("two asks due: one question (the one marked longest)", two.filter((s) => s.action === "due").length === 1 && two.find((s) => s.action === "due")?.id === UUID2, two.map((s) => s.action));
  check("an ask whose reply attempts are used up doesn't block the next", decide([ask({ hints: 2, dueAt: ago(2) }), ask({ id: UUID2, text: "jazz nights in Oakland", goals: [] })]).find((s) => s.id === UUID2)?.action === "due");
  check("due 3+ days, no exchange in 3 days: one paced text; never while held or with one waiting", one(ask({ dueAt: ago(4) }), { lastExchangeAt: ago(5) }).action === "text" && one(ask({ dueAt: ago(4) }), { lastExchangeAt: null, held: ["safety_hold"] }).action === "due" && one(ask({ dueAt: ago(4) }), { lastExchangeAt: null, pendingText: ["x"] }).action === "due");
  check("the ask's recheck text waits for the reply when they've texted since it was queued", A.retireTextCheck(ask(), { queuedAt: ago(1), latestText: ago(0.5), now: NOW }).ok === false && A.retireTextCheck(ask(), { queuedAt: ago(1), latestText: ago(2), now: NOW }).ok === true && A.retireTextCheck(ask(), { queuedAt: ago(1), latestText: "unreadable", now: NOW }).ok === false);
  check("the ask's text is the goal_recheck type (one in flight), checked by the same judge, and marks asked on send", /c\.payload\?\.kind === "ask"[\s\S]{0,400}retireTextStillDue[\s\S]{0,1400}judgeRecheckAsked\(due\.text, text, undefined, "ask"\)[\s\S]*?markRetireAsked\(c\.userId, String\(c\.payload\.askId\)/.test(src("harness/proactiveRegistry.ts")));
  check("the spacing reads both kinds of logged question", /decision IN \('goal\.recheck_asked', 'ask\.retire_asked'\)/.test(src("services/goalRecheck.ts")));
  const rf = src("harness/replyGrounding.ts");
  check("the reply asks about an ask only when no goal question was handed over", /const retireAsk = aside \? null : opts\.turn\?\.retire\?\.ask \?\? null;/.test(rf) && /goalQuestion = goalSetAsides\.length > 0 \|\| goalRechecks\.some\(\(r\) => r\.recheck === "ask"\)/.test(src("services/turnContext.ts")));
  const fence = { userId: "u1", strip: (t: string) => t };
  const tdeps = (rows: Row[], o: any = {}): any => ({ asks: async () => rows, goals: async () => [], reactions: async () => [], lastAsk: async () => o.lastAsk ?? null });
  const t1 = await A.retireForTurn("u1", "Morning", fence, { goalQuestion: false, now: NOW }, tdeps([ask(), ask({ id: UUID2, text: "jazz nights in Oakland", goals: [], dueAt: ago(2) })]));
  check("the turn gets one ask", !!t1.ask && t1.ask.id === UUID2 && t1.asked.length === 0);
  check("...none with a goal question offered, inside the spacing, with no fence, or when this message names it", !(await A.retireForTurn("u1", "Morning", fence, { goalQuestion: true, now: NOW }, tdeps([ask()]))).ask && !(await A.retireForTurn("u1", "Morning", fence, { goalQuestion: false, now: NOW }, tdeps([ask()], { lastAsk: ago(1) }))).ask && !(await A.retireForTurn("u1", "Morning", { userId: "u1", strip: () => null, failed: true }, { goalQuestion: false, now: NOW }, tdeps([ask()]))).ask && !(await A.retireForTurn("u1", "found a great Sequin AI launch party venue", fence, { goalQuestion: false, now: NOW }, tdeps([ask()]))).ask);
  // The fallback line (used only when the written line fails): six labels that read badly as-is. Reworded 2026-10-17 (Royce: "works
  // for any goal"), approved by Royce 2026-10-17; every label shape is checked in evals/goals/stopLine.ts.
  const labels: [string, string][] = [
    ["I want to find a cofounder for my climate startup", "I've paused the search on a cofounder for your climate startup; say the word and I'll pick it back up"],
    ["Wants to meet more climate founders in SF", "I've paused the search on meeting more climate founders in SF; say the word and I'll pick it back up"],
    ["Getting into pottery", "I've paused the search on getting into pottery; say the word and I'll pick it back up"],
    ["Seeking a lead investor for the pre-seed round", "I've paused the search on a lead investor for the pre-seed round; say the word and I'll pick it back up"],
    ["Find AI events with Cue", "I've paused the search on AI events; say the word and I'll pick it back up"],
    ["Pottery classes near the Mission that run on weekday evenings after work hours", "I've paused the search on pottery classes near the Mission that run on weekday evenings; say the word and I'll pick it back up"],
  ];
  const got = labels.map(([t]) => A.fallbackNote(t));
  check("the fallback reads plainly for six awkward labels (no 'I want to', 'Wants to', leading Getting/Seeking, no Cue, first word lower, capped)", got.every((g, i) => g === labels[i][1]), got);
  check("...and every fallback label stays under the cap, with no Cue, dash, quote or exclamation point", labels.every(([t]) => A.fallbackLabel(t).length <= A.NOTE_LABEL_CHARS && !/\bCue\b|[—–"!]/.test(A.fallbackLabel(t))));
  // The written line: Co's voice, stored once; any rule broken, the fallback.
  const writer = (text: string, written = true) => async () => ({ text, written });
  check("a written line that keeps the rules is used, stored without its period", (await A.writeStopLine(ASK, writer("I've set the Sequin AI venue search aside for now. Say the word and I'll pick it back up."))) === "I've set the Sequin AI venue search aside for now. Say the word and I'll pick it back up");
  check("...one with an exclamation point, a role noun, a question or a dash falls back", (await A.writeStopLine(ASK, writer("Stopped looking for venues! Say the word."))) === A.fallbackNote(ASK) && (await A.writeStopLine(ASK, writer("As your assistant, I've stopped looking for venues."))) === A.fallbackNote(ASK) && (await A.writeStopLine(ASK, writer("Should I stop looking for venues?"))) === A.fallbackNote(ASK) && (await A.writeStopLine(ASK, writer("Stopped looking — say the word."))) === A.fallbackNote(ASK) && (await A.writeStopLine(ASK, writer("x", false))) === A.fallbackNote(ASK));
  check("written once at idle time in the sweep (ask and goal), stored, never on the reply's path", /const line = await writeStopLine\(row\.text\);\s*await pool\.query\(`UPDATE ask_checkins SET retired_at = NOW\(\), retire_told_at = NULL, retired_with_goal = NULL, retire_note = \$3/.test(src("services/askRetire.ts")) && /A\.storeGoalNote\(userId, goal\)/.test(src("services/goalRecheck.ts")) && !/writeStopLine|storeGoalNote/.test(src("services/turnContext.ts") + src("harness/replyGrounding.ts") + src("agent/conversationTools.ts") + src("harness/proactive.ts")));
  // The note: fenced, once, never a text of its own, never on a heavy check-in or while struggling.
  const owed = [
    { kind: "ask" as const, key: "old", line: "I've stopped looking for Jordan's birthday venues; say the word and I'll pick it back up", since: ago(5) },
    { kind: "ask" as const, key: UUID, line: A.fallbackNote(ASK), since: ago(4) },
  ];
  const strip = (t: string) => (/Jordan/.test(t) ? t.replace(/Jordan's /, "") : t);
  check("fenced: a note the strip would change is skipped, and the next one goes (never blocked by it)", A.firstSurviving(owed, strip)?.key === UUID && A.firstSurviving(owed, () => null) === null);
  check("a paced text may carry notes owed 3+ days", A.notesToRide(owed, NOW).length === 2 && A.noteToRide([{ ...owed[1], since: ago(1) }], NOW) === null);
  check("never on a heavy check-in, never while a hard day holds it, only Cue's own companion and offer texts", !A.noteMayRide({ type: "companion", payload: { heavy: { endedAt: ago(1) } } }, false) && !A.noteMayRide({ type: "companion", payload: {} }, true) && A.noteMayRide({ type: "companion", payload: {} }, false) && !A.noteMayRide({ type: "goal_recheck", payload: {} }, false) && !A.noteMayRide({ type: "pre_arrival", payload: {} }, false));
  const rode = A.rideAlong(["https://lu.ma/abc", "A small founder supper Thursday, worth a look?"], owed[1].line, (d, p) => L.carryLaneNotes(d, p));
  check("riding in the last message that isn't a bare link, once", rode[0] === "https://lu.ma/abc" && rode[1].split(owed[1].line).length === 2 && A.noteCarried(rode.join("\n"), owed[1]), rode);
  const ps = src("harness/proactive.ts");
  check("the dispatch: allowed types only, never heavy, waits while a hard day holds it (capped), through the member fence, never in a composed bundle, told once delivered", /let sending = outgoing;\s*if \(!composed && !asWritten\) \{/.test(ps) && /if \(A\.noteMayRide\(c, heldForMood\(member\.state\)\)\)/.test(ps) && /A\.notesToRide\(n, state\.now\)/.test(ps) && /A\.firstSurviving\(owed, fence\.strip\)/.test(ps) && /A\.noteCarried\(result\.delivered\.join\("\\n"\), rideNote\)\) await A\.markNotesTold\(userId, \[rideNote\], "text"\)/.test(ps));
  const reply = L.carryLaneNotes("Sounds like a good week.", [owed[1].line], []);
  const again = L.carryLaneNotes("One more thing.", [owed[1].line], [owed[1].line]);
  check("in a reply: carried once, never again in a second reply that turn", reply.text.includes(owed[1].line) && !again.text.includes(owed[1].line));
  const tools = src("agent/conversationTools.ts");
  check("the reply carries it only in a reply that goes anyway, never when they may not be safe", /if \(\(state\.stopNotes\.length \|\| state\.stopNotesSent\.length\) && !ctx\.safetyConcern && !state\.safetyFlagged\) message = carryLaneNotes\(message, state\.stopNotes, state\.stopNotesSent\)\.text;/.test(tools) && !/state\.stopNotes\.length\) return \{ ok: false/.test(tools));
  const tc = src("services/turnContext.ts");
  check("the turn: notes read alongside the goal reads, the first that passes keep(); a hard day's wait is decided on this message's read (replyGrounding)", /const stopNotesP = import\("\.\/askRetire\.js"\)\.then\(\(A\) => A\.pendingStopNotes\(userId\)\)/.test(tc) && /if \(opts\.turn\?\.stopNote && !noteMood\?\.hold\) \{/.test(src("harness/replyGrounding.ts")) && tc.indexOf("const stopNotesP") < tc.indexOf("const goalSetAsides = await") && /A\.firstSurviving\(notes, keep\)/.test(tc));
  check("told only once it went", /if \(stopNote && state\.stopNotesSent\.length && !opts\.dryRun && opts\.record !== false\)/.test(src("agent/conversationReply.ts")) && /told_at = NOW\(\) WHERE user_id = \$1 AND goal_hash = \$2 AND told_at IS NULL/.test(src("services/askRetire.ts")));
  check("a goal idled by the recheck owes its note (not silent), and is never asked as a set-aside", /setGoalState\(userId, goal, "stale", RECHECK_IDLE_REASON, "context", \{ told: false \}\)/.test(src("services/goalRecheck.ts")) && /reason IS DISTINCT FROM \$2/.test(src("services/goalEdges.ts")));
  const mig = src("db/migrations.ts");
  check("migration: the retirement and note columns, additive", /ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS retire_due_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS retire_goals TEXT\[\],[\s\S]{0,400}retire_told_at TIMESTAMPTZ`/.test(mig) && /ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS retire_note TEXT, ADD COLUMN IF NOT EXISTS retired_with_goal TEXT/.test(mig) && /ALTER TABLE goal_states ADD COLUMN IF NOT EXISTS idle_note TEXT/.test(mig));
  check("the goal sweep runs it right after the goal recheck, with its decisions", /const steps = await \(await import\("\.\/goalRecheck\.js"\)\)\.runGoalRecheck\(row\.user_id, goalSweepGoals\(row\) \?\? \[\]\);\s*await \(await import\("\.\/askRetire\.js"\)\)\.runAskRetire\(row\.user_id, steps\);/.test(src("services/goalSweep.ts")));
}

// ---- 5. the runs, end to end, on an in-memory store
{
  type Mem = { ask: Row; goal: GV; logs: string[]; texts: { at: Date; text: string }[]; lastAsk: Date | null; notesTold: string[] };
  const mem: Mem = { ask: ask({ dueAt: null }), goal: goal(), logs: [], texts: [], lastAsk: null, notesTold: [] };
  const deps = (now: Date): any => ({
    asks: async () => (mem.ask.dueAt || mem.ask.retiredAt ? [mem.ask] : []), goals: async () => [mem.goal], texts: async () => mem.texts, reactions: async () => [], lastAsk: async () => mem.lastAsk,
    held: async () => [], pendingText: async () => [],
    keep: async () => { mem.ask = { ...mem.ask, holdUntil: new Date(now.getTime() + 30 * DAY), dueAt: null, askedAt: null }; },
    unflag: async () => { mem.ask = { ...mem.ask, dueAt: null }; }, revive: async () => true, reviveGoal: async () => true,
    idle: async (_u: string, _r: Row, how: any) => { mem.ask = { ...mem.ask, kind: "help", retiredAt: now, toldAt: "said" in how ? now : null, withGoal: "goal" in how ? how.goal : null, note: "note" in how ? A.fallbackNote(mem.ask.text) : null }; return true; },
    queueText: async () => { mem.logs.push("text_queued"); return true; }, log: async (d: any) => { mem.logs.push(`${d.decision}:${d.action}`); },
  });
  const at = (d: number) => new Date(NOW.getTime() + d * DAY);
  // Day 0: the plan marks it.
  mem.ask = { ...mem.ask, dueAt: at(0) };
  // Day 0, the sweep: due, asked in the next natural reply (they've been texting).
  mem.texts = [{ at: at(-0.5), text: "busy week" }];
  let steps = await A.runAskRetire("u1", [], at(0.1), deps(at(0.1)));
  check("run 1: marked and quiet goal: due for the next natural reply", steps[0]?.action === "due" && mem.logs.includes("ask.retire_due:ask_in_reply"), steps);
  // Day 0.2: the reply asks it (the judge said so).
  mem.ask = { ...mem.ask, askedAt: at(0.2) };
  mem.lastAsk = at(0.2);
  steps = await A.runAskRetire("u1", [], at(3), deps(at(3)));
  check("run 2 (day 3): asked, waiting on them", steps[0]?.action === "asked");
  // They named it in passing while it was asked: not a keep.
  mem.texts = [{ at: at(4), text: "the Sequin AI launch party venues stuff can wait" }];
  steps = await A.runAskRetire("u1", [], at(5), deps(at(5)));
  check("run 3 (day 5): naming it after the question is not a keep", steps[0]?.action === "asked");
  steps = await A.runAskRetire("u1", [], at(7.3), deps(at(7.3)));
  check("run 4 (day 7): no answer: the ask stays open and searched (not retired, kind unchanged, no note)", steps[0]?.action === "none" && mem.ask.kind === "find" && !mem.ask.retiredAt && !mem.logs.includes("ask.retired:no_answer"));
  const owed = A.notesFrom([], [{ id: mem.ask.id, text: mem.ask.text, retiredAt: mem.ask.retiredAt, toldAt: mem.ask.toldAt, withGoal: mem.ask.withGoal, note: mem.ask.note }]);
  check("...no stopped-looking note owed for silence", owed.length === 0);
  mem.ask = { ...mem.ask, toldAt: at(7.5) };
  const after = A.notesFrom([], [{ id: mem.ask.id, text: mem.ask.text, retiredAt: mem.ask.retiredAt, toldAt: mem.ask.toldAt }]);
  steps = await A.runAskRetire("u1", [], at(9), deps(at(9)));
  check("...later runs leave it open, with nothing said", after.length === 0 && steps[0]?.action === "none" && !mem.ask.retiredAt);
  // The goal path: marked, the goal's recheck goes out and idles it, the ask goes with it.
  mem.ask = ask({ dueAt: at(10) });
  mem.goal = goal({ recheckAskedAt: at(10.5), lastSignalAt: at(-20) });
  mem.lastAsk = at(10.5);
  steps = await A.runAskRetire("u1", [], at(12), deps(at(12)));
  check("goal path: the goal's recheck is out: the ask waits", steps[0]?.action === "wait");
  mem.goal = goal({ state: "stale", reason: R.RECHECK_IDLE_REASON, toldAt: null, changedAt: at(17.6), recheckAskedAt: at(10.5) });
  steps = await A.runAskRetire("u1", [{ goalHash: G.goalHash(WORK), action: "idle" }], at(17.6), deps(at(17.6)));
  check("...the goal idles: the ask idles with it, no question of its own, the goal's note covers it", steps[0]?.action === "idle_with_goal" && mem.ask.withGoal === G.goalHash(WORK) && A.notesFrom([{ ...mem.goal, goal: WORK }], [{ id: mem.ask.id, text: mem.ask.text, retiredAt: mem.ask.retiredAt, toldAt: mem.ask.toldAt, withGoal: mem.ask.withGoal }]).map((n) => n.kind).join() === "goal");
  mem.texts = [];
  steps = await A.runAskRetire("u1", [], at(17), deps(at(17)));
  check("their texts can't be read through the fence: nothing is decided", (await A.runAskRetire("u1", [], at(18), { ...deps(at(18)), texts: async () => null })).length === 0);
}

console.log(`ask retirement: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
