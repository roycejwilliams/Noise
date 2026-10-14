// Asks and goals are two things (Royce, 2026-10-06). Layer 1: fake store, fake classifier, zero tokens.   npx tsx evals/asks/split.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const W = await import("../../src/harness/profileWrite.js");
const K = await import("../../src/services/entryKind.js");
const GS = await import("../../src/services/goalSweep.js");
const A = await import("../../src/services/askLifecycle.js");
const X = await import("../../src/services/profileExtraction.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const P = await import("../../src/harness/proactive.js");
const { default: pool } = await import("../../src/db/db.js");
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

// ---- 1. the store: a hard type on every entry
const ask = { id: "a1", text: "Find me weekend events", type: "seeking", status: "active", kind: "ask" };
const goal = { id: "g1", text: "Get Cue in front of users", type: "seeking", status: "active", kind: "goal" };
const legacy = { id: "l1", text: "Looking for a founder community", type: "seeking", status: "active" };
const doneGoal = { id: "g2", text: "Build a founder community", type: "seeking", status: "resolved", kind: "goal" };
const intent = [ask, goal, legacy, doneGoal];
check("an entry with no kind (written before the split) reads as an ask until the reclassify pass types it", W.entryKind(legacy) === "ask" && W.isOpenAsk(legacy));
check("a goal is NOT an open ask: not for isOpenAsk, askEntries, or latestAskEntry (the one predicate every search, offer, match and check-in reads)", !W.isOpenAsk(goal) && !W.askEntries(intent).some((e) => e.id === "g1") && W.latestAskEntry([ask, goal])?.id === "a1");
check("and an ask is NOT a goal: goalEntries returns only active goal-typed entries", W.goalEntries(intent).map((e) => e.id).join() === "g1" && !W.isActiveGoal(ask) && !W.isActiveGoal(legacy));
check("a goal the member closed stays out of both", !W.isOpenAsk(doneGoal) && !W.isActiveGoal(doneGoal));

// ---- 2. the consumers
const SQL_RELEVANCE = src("services/relevance.ts");
check("people-matching's embeddings read only asks, never goals", /COALESCE\(e->>'kind', 'ask'\) = 'ask'/.test(SQL_RELEVANCE));
const rawSeeking = ["services", "harness", "agent", "jobs", "routes"].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`)).filter((f) => !/profileWrite|matching\.ts|profileExtraction|turnLearning|readTurn/.test(f)).filter((f) => /i\??\.type === "seeking"/.test(src(f)) && !/isOpenAsk/.test(src(f)));
check("nothing filters intent by type 'seeking' on its own: every reader of asks goes through isOpenAsk (found raw: " + (rawSeeking.join(",") || "none") + ")", rawSeeking.length === 0);
check("the stated-ask readers (pre-arrival, partner readout, matching) use the predicate", /isOpenAsk\(i\) && i\?\.type === "seeking"/.test(src("services/preArrival.ts")) && /isOpenAsk\(i\) && i\?\.type === "seeking"/.test(src("services/partnerReadout.ts")) && /import \{ goalEntries, isOpenAsk \}/.test(src("services/matching.ts")));
check("orientation reads goals, not asks: the call context and the person snapshot take goal entries as direction", /goals: k\.goals\.filter\(\(g\) => g\.state === "active"\)/.test(src("services/callContext.ts")) && /const goals = p\.goals\.filter/.test(src("services/callContext.ts")) && /goalEntries|kind !== "goal"/.test(src("services/memberKnowledge.ts")) && /goalEntries\(intentRow\.rows\[0\]\?\.intent\)/.test(src("harness/personSnapshot.ts")) && /Where they say they are headed \(direction\)/.test(src("harness/personSnapshot.ts")));

// ---- 3. the write path: classify before it lands
type Q = { sql: string; args: any[] };
const calls: Q[] = [];
let profileIntent: any[] = [];
(pool as any).query = async (sql: string, args: any[] = []) => {
  calls.push({ sql, args });
  if (/FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL/.test(sql)) return { rows: [] };
  if (/SELECT intent FROM co_profiles/.test(sql)) return { rows: [{ intent: profileIntent }] };
  if (/INSERT INTO co_memories/.test(sql)) return { rows: [{ id: "m1" }] };
  return { rows: [] };
};
const extras = { concrete_preferences: [], wants: [], availability: null } as any;
const wrote = (re: RegExp) => calls.filter((c) => re.test(c.sql));
K.setEntryClassifierForTests(async (t) => (/^find me|link to/i.test(t) ? "ask" : "goal"));
{
  calls.length = 0;
  const e = await X.persistCapturedIntent("u1", { text: "Find me weekend events", type: "seeking" } as any, extras);
  check("'Find me weekend events' is typed ask and gets its ask_checkins row (the lifecycle starts)", e.kind === "ask" && wrote(/INSERT INTO ask_checkins/).length === 1 && wrote(/INSERT INTO co_profiles/).some((c) => JSON.parse(c.args[1])[0].kind === "ask"));
}
{
  calls.length = 0;
  const e = await X.persistCapturedIntent("u1", { text: "Get Cue in front of users", type: "seeking" } as any, extras);
  check("'Get Cue in front of users' is typed goal and gets NO ask_checkins row: nothing can search, offer or check in on it", e.kind === "goal" && wrote(/INSERT INTO ask_checkins/).length === 0 && wrote(/UPDATE ask_checkins/).length === 0 && wrote(/INSERT INTO co_profiles/).some((c) => JSON.parse(c.args[1])[0].kind === "goal" && JSON.parse(c.args[1])[0].status === "active"));
}
{
  calls.length = 0;
  profileIntent = [{ id: "g1", text: "Get Cue in front of users", type: "seeking", status: "active", kind: "goal", embedding: null }];
  const e = await X.persistCapturedIntent("u1", { text: "Get Cue in front of users", type: "seeking" } as any, extras);
  check("a restated goal updates the goal it repeats (in place, no duplicate, no ask row, no time limit renewed)", e.id === "g1" && wrote(/UPDATE co_profiles SET intent/).length === 1 && wrote(/INSERT INTO ask_checkins|UPDATE ask_checkins/).length === 0);
  profileIntent = [];
}
K.setEntryClassifierForTests(async () => "goal");
{
  calls.length = 0;
  profileIntent = [{ id: "a9", text: "Get Cue in front of users", type: "seeking", status: "active", kind: "ask", embedding: null }];
  const e = await X.persistCapturedIntent("u1", { text: "Get Cue in front of users", type: "seeking" } as any, extras);
  check("a goal is never merged into an ask with the same words (each kind dedupes only against its own kind)", e.id !== "a9" && e.kind === "goal" && wrote(/INSERT INTO co_profiles/).length === 1);
  profileIntent = [];
}
K.setEntryClassifierForTests(async () => { throw new Error("model down"); });
{
  calls.length = 0;
  const orig = console.error; console.error = () => {};
  const e = await X.persistCapturedIntent("u1", { text: "Get Cue in front of users", type: "seeking" } as any, extras).catch(() => null);
  console.error = orig;
  check("when the classifier is down the entry is still written, as an ask (it has a lifecycle and a time limit; a goal with none is the riskier default)", !!e && e.kind === "ask" && wrote(/INSERT INTO ask_checkins/).length === 1);
}
K.setEntryClassifierForTests(null);
check("the classifier's definitions carry the two examples: errand vs direction, ask when unsure", /Get Cue in front of users/.test(K.KIND_DEFINITIONS) && /Plan out the event and take lead/.test(K.KIND_DEFINITIONS) && /If you cannot tell, it is an ASK/.test(K.KIND_DEFINITIONS) && /Find me weekend events/.test(K.KIND_DEFINITIONS));
check("an ask can reference the goal it serves: ask_checkins.serves_goal_id exists, and nothing reasons over it yet", /ADD COLUMN IF NOT EXISTS serves_goal_id TEXT/.test(src("db/migrations.ts")) && !/serves_goal_id/.test(["services/askLifecycle.ts", "services/goalSweep.ts", "jobs/index.ts", "harness/proactiveRegistry.ts"].map(src).join("\n")));

// ---- REGRESSIONS
// (a) a goal never produces a check-in or a search
{
  const gate = await A.checkinGate("u1", "g1", { openAsks: async () => [], conversation: async () => [], delivered: async () => null, judge: async () => [], close: async () => {}, markChecked: async () => {} } as any);
  check("REGRESSION: a goal has no ask row, so the check-in gate refuses it (no check-in can be written for a goal)", gate.ok === false);
  check("REGRESSION: a goal never produces a SEARCH: the ask sweep reads ask_checkins only, and a goal has no row there", /FROM ask_checkins ac\s+JOIN users u/.test(src("jobs/index.ts")) && /WHERE ac\.resolved_at IS NULL AND ac\.kind IN \('find', 'person'\)\s+AND u\.archived_at IS NULL/.test(src("jobs/index.ts")) && !/goalEntries|isActiveGoal/.test(src("jobs/index.ts")) && !/goalEntries|isActiveGoal/.test(src("services/relevance.ts")) && !/goalEntries|isActiveGoal/.test(src("services/askLifecycle.ts")));
  check("REGRESSION: and the check-in cron reads ask_checkins only", /FROM ask_checkins ac\s+JOIN users u ON u\.id = ac\.user_id\s+LEFT JOIN \(/.test(src("jobs/index.ts")));
}
// (b) an answered ask produces neither
{
  let drafted = 0;
  P.setProactiveModelForTests(async () => { drafted++; return "Still looking?"; });
  const answeredRow = { id: "i1", user_id: "u1", ask_id: "a1", ask_text: "Seeking the link to Pitch Protocol", kind: "find", created_at: new Date("2026-10-02T20:00:00Z"), last_mentioned_at: null, resolved_at: new Date("2026-10-03T20:00:00Z"), expired_at: null, closed_reason: "answered", awaiting_response_since: null };
  A.setAskDepsForTests({ openAsks: async () => [], conversation: async () => [], delivered: async () => null, judge: async () => [], close: async () => {}, markChecked: async () => {} } as any);
  const r: any = await proactiveRegistry.ask_checkin.draft({ id: "c1", userId: "u1", type: "ask_checkin", payload: { askCheckinId: "i1", askId: "a1", askText: answeredRow.ask_text, checkinCount: 0, hasMatches: false } } as any, { firstName: "Jordan", userId: "u1" } as any);
  check("REGRESSION: an answered (closed) ask produces no check-in and no model call", !!r.skip && drafted === 0 && A.askState(answeredRow as any) === "closed");
  check("REGRESSION: and no search: a closed ask is not in the ask sweep's read (resolved_at IS NULL)", /WHERE ac\.resolved_at IS NULL AND ac\.kind IN \('find', 'person'\)\s+AND u\.archived_at IS NULL/.test(src("jobs/index.ts")));
  P.setProactiveModelForTests(null);
  A.setAskDepsForTests(null);
}
// (c) the goal sweep runs for a member who has open asks
{
  const sql = GS.GOAL_SWEEP_SQL;
  check("REGRESSION: the goal sweep's query has no condition on the member's asks (it used to require none open)", !/ask_checkins/.test(sql) && !/NOT EXISTS/.test(sql));
  const member = { user_id: "u1", first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco", goals: ["raise a pre-seed"], activity_preferences: ["founder dinners"], long_term_direction: "", intent: [ask, goal], last_attempted_at: null, cooldown_cleared: true };
  const surfaced: { id: string; ctx: string }[] = [];
  const marked: string[] = [];
  const n = await GS.runGoalSweep(async (items, _l, fn) => { for (const i of items) await fn(i); }, { rows: async () => [member, { ...member, user_id: "u2", intent: [] }], mark: async (id) => { marked.push(id); }, surface: async (row, ctx) => { surfaced.push({ id: row.user_id, ctx }); }, plan: async () => ({ searchText: "look for: programs and cohorts for pre-seed founders in SF. enjoys: founder dinners" }) });
  check("REGRESSION: the goal sweep runs for a member with open asks, same as for one without", n === 2 && surfaced.map((s) => s.id).join() === "u1,u2" && marked.join() === "u1,u2");
  const ctx = surfaced[0].ctx;
  // 2026-10-08: the search is each active goal's findable edge (services/goalEdges.ts), never a goal's own words or an ask's text.
  check("what it searches is the plan's findable edges, never a goal's own words or an ask's text", /programs and cohorts for pre-seed founders/.test(ctx) && /founder dinners/.test(ctx) && !/raise a pre-seed/.test(ctx) && !/Get Cue in front of users/.test(ctx) && !/Find me weekend events/.test(ctx));
  check("the budget is per member and independent of asks: due again 20 hours after the last attempt, not before", GS.goalSweepDue({ last_attempted_at: null }) && !GS.goalSweepDue({ last_attempted_at: new Date(Date.now() - 19 * 3_600_000) }) && GS.goalSweepDue({ last_attempted_at: new Date(Date.now() - 21 * 3_600_000) }) && /INTERVAL '20 hours'/.test(sql) && /INTERVAL '3 days'/.test(sql));
  check("the cron hands the whole sweep to services/goalSweep.ts and still dispatches after", /await runGoalSweep\(runWithConcurrency\);\s*await runDispatch\(\);/.test(src("jobs/index.ts")) && !/NOT EXISTS \(SELECT 1 FROM ask_checkins ac WHERE ac\.user_id = u\.id AND ac\.resolved_at IS NULL\)/.test(src("jobs/index.ts")));
}

console.log(`asks and goals split: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
