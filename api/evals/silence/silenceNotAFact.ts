// Silence is never a fact (Royce, 2026-11-04/05; Cue Memory Spec step 9). Zero tokens, no database: pure functions and a stubbed store.
//   1. A goal's unanswered recheck does not stale it or retire its asks; a stated done still closes it.
//   2. A paused kind is visible in what-Cue-knows as pacing, removable, and removal lifts the pause for good.
//   3. Unanswered research finds weigh 0 for the member and for everyone; real answers still count.
//   4. A call-only member is active; quiet never excludes; an unanswered suggestion doesn't block a pair forever; a decline does.
//   5. Asks don't close on a clock.
//   npx tsx evals/silence/silenceNotAFact.ts
process.env.SENDBLUE_API_API_KEY ||= "ci";
process.env.SENDBLUE_API_API_SECRET ||= "ci";
process.env.ANTHROPIC_API_KEY ||= "ci";
process.env.OPENAI_API_KEY ||= "ci";
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
import fs from "node:fs";
import { DateTime } from "luxon";
const R = await import("../../src/services/goalRecheck.js");
const G = await import("../../src/services/goalEdges.js");
const A = await import("../../src/services/askRetire.js");
const K = await import("../../src/services/kindRestraint.js");
const W = await import("../../src/services/whatCoKnows.js");
const Q = await import("../../src/services/researchQuality.js");
const M = await import("../../src/harness/matchGate.js");
const AE = await import("../../src/services/askExpiry.js");
const NN = await import("../../src/services/networkIntroNudge.js");
const { default: pool } = await import("../../src/db/db.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const DAY = 86_400_000;
const NOW = new Date("2026-11-20T18:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

// ---- 1. goals and their asks
{
  const GOAL = "find a running club in the Marina";
  const row = (o: any = {}) => ({ goalHash: G.goalHash(GOAL), goal: GOAL, state: "active" as const, reason: "", source: "context" as const, changedAt: ago(60), lastSignalAt: ago(30), recheckAskedAt: ago(8), searched: true, ...o });
  for (const days of [8, 30, 120]) {
    const s = R.recheckDecide({ rows: [row({ recheckAskedAt: ago(days) })], now: NOW, signals: [], lastExchangeAt: ago(1), held: [], pendingText: [] })[0];
    check(`${days} days after an unanswered recheck: no idle, the goal stays active`, s.action !== "idle", s);
  }
  const answered = R.recheckDecide({ rows: [row()], now: NOW, signals: [{ goalHash: G.goalHash(GOAL), at: ago(2), kind: "text" }], lastExchangeAt: ago(1), held: [], pendingText: [] })[0];
  check("an answer still clears the ask", answered.action === "signal" && answered.clearAsk, answered);
  check("the stopped-looking note is not written for silence (the idle writer is unreachable from the decision)", !/action: "idle"/.test(src("services/goalRecheck.ts").replace(/\/\/.*$/gm, "").split("export function recheckDecide")[1]?.split("export function textSignals")[0] ?? ""));
  // The ask: a question out 8 days with no answer stays asked, never idle.
  const ask = { id: "a1", text: "find a running club", kind: "find", retiredAt: null, holdUntil: null, dueAt: ago(20), askedAt: ago(8), goals: [G.goalHash(GOAL)], hints: 0 } as any;
  const steps = A.retireDecide({ asks: [ask], goals: [{ goalHash: G.goalHash(GOAL), goal: GOAL, state: "active", reason: "", source: "context", toldAt: null, changedAt: ago(60), recheckAskedAt: null, lastSignalAt: ago(30) } as any], goalSteps: [], now: NOW, signals: [], lastAskAt: null, lastExchangeAt: ago(1), held: [], pendingText: [] });
  check("an ask whose question went unanswered for a week is not retired", steps[0].action !== "idle" && steps[0].action !== "idle_with_goal", steps[0]);
  // A stated done closes: markGoal still writes done (the path is untouched and not silence).
  check("a stated done still closes a goal (markGoal 'done' state exists)", /"done"/.test(src("services/goalEdges.ts")));
}

// ---- 2. a paused kind is visible and removable
{
  const items = W.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], paces: [{ kind: "find", line: `paused for now: ${K.PACE_LABELS.find}` }] } as any);
  const it = items.find((i: any) => i.source === "pace");
  check("a paused kind is listed in what-Cue-knows", !!it && it.ref === "pace:find", items);
  check("it reads as pacing, not taste", !!it && it.text === "paused for now: finds" && !/don't like|not interested|lost interest|not your thing/i.test(it.text), it);
  check("the member can remove it (the removal path knows the kind)", W.fieldFor("pace:find") !== "pace" && /removePace/.test(src("services/whatCoKnows.ts")));
  // Removal: the pause lifts and what was let pass before it no longer re-suppresses.
  const sends = [1, 2].map((n) => ({ id: `s${n}`, kind: "find" as const, sentAt: ago(40 - n * 5), message: `find ${n}` }));
  const pausedStored = [{ kind: "find" as const, state: "suppressed" as const, suppressedAt: ago(30), enabledAt: null, evidence: ["s1", "s2"] }];
  const before = K.evaluateKindRestraint({ sends, inbound: [], stored: pausedStored, now: NOW }).get("find")!;
  check("two let pass: the kind is paused", before.suppressed || !!before.trial, before);
  const lifted = [{ ...pausedStored[0], state: "enabled" as const, enabledAt: ago(1) }];
  const after = K.evaluateKindRestraint({ sends, inbound: [], stored: lifted, now: NOW }).get("find")!;
  check("after their removal the same history does not pause it again", !after.suppressed && !after.trial, after);
  const newer = [...sends, { id: "s3", kind: "find" as const, sentAt: ago(0.5 + 3), message: "f3" }];
  check("one more let pass after the removal is not enough either", !K.evaluateKindRestraint({ sends: newer, inbound: [], stored: lifted, now: NOW }).get("find")!.suppressed);
}

// ---- 3. unanswered research finds
{
  check("an ignored find weighs 0", Q.OUTCOME_WEIGHT.ignored === 0);
  check("real answers still count", Q.OUTCOME_WEIGHT.yes > 0 && Q.OUTCOME_WEIGHT.no < 0 && Q.OUTCOME_WEIGHT.not_like_that < Q.OUTCOME_WEIGHT.no);
  const stats = Q.featureStats([{ features: ["site:a.com"], outcome: "ignored" }, { features: ["site:a.com"], outcome: "ignored" }, { features: ["site:b.com"], outcome: "yes" }]);
  check("ignored rows add nothing to the stats (not even to the count that dilutes a real answer)", !stats["site:a.com"] && stats["site:b.com"].n === 1, stats);
  const sql = src("services/researchQuality.ts");
  check("the member's and everyone's signal both leave ignored rows out", /outcome <> 'ignored'/.test(sql));
}

// ---- 4. matching
{
  const base = { shareReason: "what they've said they're looking for: \"Looking to meet climate founders\"", candidateStatedAsks: ["Looking to meet climate founders"], candidatePrivateTexts: [], alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true };
  const quiet = M.evaluateNetworkCandidate({ ...base, askerQuiet: true, candidateQuiet: true } as any);
  check("a member quiet for 90+ days is still a candidate: less contact, not excluded", quiet.ok, quiet.checks);
  check("an opted-out or unreachable member is still excluded", !M.evaluateNetworkCandidate({ ...base, candidateActive: false } as any).ok);
  const g = src("harness/matchGate.ts");
  check("activity counts calls as well as texts", /LIKE '\[Call\]%'/.test(g) && /LIKE 'User %'/.test(g));
  check("reachability no longer reads their last message", !/EXISTS \(\s*SELECT 1 FROM co_memories m WHERE m.user_id = u.id/.test(g));
  check("a declined, introduced or both-yes pair blocks for good", /status IN \('declined', 'introduced', 'both_interested'\)/.test(M.PAIR_BLOCKED_SQL));
  check("an unanswered or one-sided suggestion blocks only while recent", M.PAIR_BLOCKED_SQL.includes(`> NOW() - INTERVAL '${M.PAIR_RETRY_DAYS} days'`));
  check("the intro nudge reads the same rule", /PAIR_BLOCKED_SQL/.test(src("services/networkIntroNudge.ts")));
  check("passing on a teased intro still declines the pair even over an unanswered row", /DO UPDATE SET status = 'declined' WHERE network_introductions.status IN \('suggested'/.test(src("services/networkIntroNudge.ts")));
}

// ---- 5. asks don't close on a clock
{
  const said = DateTime.fromISO("2026-11-01T10:00:00", { zone: "UTC" });
  check("an ask with no named time has no clock", AE.askExpiresAt("anyone doing good climate meetups", said) === null);
  const named = AE.askExpiresAt("a founders dinner this Friday", said);
  check("an ask with a named time still ends a day after it", named instanceof Date, named);
  check("the 30-day lifespan is gone", !("ASK_LIFESPAN_DAYS" in AE));
  const e = src("services/askExpiry.ts").replace(/\/\/.*$/gm, "");
  check("the expiry job closes only asks whose named time passed", /if \(!named\)/.test(e) && !/memberSilence/.test(e) && !/INTERVAL '1 day'/.test(e));
}

// ---- review fixes
// 1. quiet members rank after active ones
{
  const cands = [{ id: "quietB", score: 0.9 }, { id: "activeB", score: 0.8 }, { id: "activeC", score: 0.7 }];
  const quiet = new Set(["quietB"]);
  const ordered = M.activeFirst(cands, (c) => quiet.has(c.id));
  check("active B is chosen over quiet B for the same slot", ordered[0].id === "activeB" && ordered[1].id === "activeC" && ordered[2].id === "quietB", ordered);
  check("nobody quiet is dropped", ordered.length === 3);
  check("with nobody quiet the score order stands", M.activeFirst(cands, () => false).map((c) => c.id).join() === "quietB,activeB,activeC");
  check("both the intro nudge and the no-show pick order by it", /activeFirst\(rows/.test(src("services/networkIntroNudge.ts")) && /activeFirst\(ranked/.test(src("services/eventNoShow.ts")));
  let asked = "";
  (pool as any).query = async (sql: string) => { asked = sql; return { rows: [{ id: "activeB" }] }; };
  const q = await M.quietAmong(["activeB", "quietB"]);
  check("quietAmong: no text or call in 90 days is quiet; a call counts", q.has("quietB") && !q.has("activeB") && /LIKE '\[Call\]%'/.test(asked), [...q]);
}

// 2. the pair window runs from the last tease
{
  const created = new Date("2026-01-01T00:00:00Z");
  const day = (n: number) => new Date(created.getTime() + n * 86_400_000);
  const row = (lastSuggestedAt: Date | null) => ({ status: "suggested", createdAt: created, aInterestedAt: day(1), lastSuggestedAt });
  check("a first tease blocks for 60 days, then not", M.pairBlocked(row(created), day(59)) && !M.pairBlocked(row(created), day(61)));
  check("a re-tease at day 61 blocks again until day 121", M.pairBlocked(row(day(61)), day(62)) && M.pairBlocked(row(day(61)), day(120)) && !M.pairBlocked(row(day(61)), day(122)));
  check("a repeat yes keeping its old stamp does not reopen the window", M.pairBlocked(row(day(61)), day(100)));
  check("declined, introduced and both-yes stay closed whatever the date", ["declined", "introduced", "both_interested"].every((st) => M.pairBlocked({ ...row(null), status: st }, day(900))));
  check("the SQL reads the same stamp", /COALESCE\(last_suggested_at, GREATEST\(/.test(M.PAIR_BLOCKED_SQL));
  const writes: { sql: string; args: any[] }[] = [];
  (pool as any).query = async (sql: string, args: any[]) => { writes.push({ sql: sql.replace(/\s+/g, " "), args }); return { rows: [], rowCount: 1 }; };
  await NN.recordTease("b-user", "a-user", "reason", "ask1");
  check("each tease stamps last_suggested_at, writes the pair canonically, and leaves a decided pair alone", writes.length === 1 && /last_suggested_at = NOW\(\) WHERE network_introductions.status IN \('suggested', 'a_interested', 'b_interested'\)/.test(writes[0].sql) && writes[0].args[0] === "a-user", writes);
  check("the tease send hook calls it", /recordTease\(c\.userId/.test(src("harness/proactiveRegistry.ts")));
  check("the column is added", /ADD COLUMN IF NOT EXISTS last_suggested_at/.test(src("db/migrations.ts")));
}

// 3. an unanswered ask question stops being carried
{
  const GOAL = "find a running club in the Marina";
  const mk = (askedDays: number) => ({ id: "a1", text: "find a running club", kind: "find", intent: null, dueAt: ago(40), goals: [G.goalHash(GOAL)], askedAt: ago(askedDays), hints: 0, holdUntil: null, retiredAt: null, toldAt: null, withGoal: null, note: null }) as any;
  const run = (askedDays: number) => A.retireDecide({ asks: [mk(askedDays)], goals: [{ goalHash: G.goalHash(GOAL), goal: GOAL, state: "active", reason: "", source: "context", toldAt: null, changedAt: ago(60), recheckAskedAt: null, lastSignalAt: ago(30) } as any], goalSteps: [], now: NOW, signals: [], lastAskAt: null, lastExchangeAt: ago(1), held: [], pendingText: [] });
  check("inside the window the question is carried (asked)", run(3)[0].action === "asked");
  check("past the window it is not carried (none), and the ask is not retired", run(8)[0].action === "none" && run(30)[0].action === "none");
  const steps = run(8);
  check("the reply's asked list (steps that are asked) is empty then", steps.filter((s) => s.action === "asked").length === 0);
}

// 4. spend: an unanswered recheck drops the goal to weekly search, never off
{
  const GOAL = "find a running club in the Marina";
  const h = G.goalHash(GOAL);
  const rowAsked = (d: number | null) => ({ recheckAskedAt: d === null ? null : ago(d) });
  const days = Array.from({ length: 14 }, (_, i) => new Date(NOW.getTime() + i * DAY));
  const searchedDays = (d: number | null) => days.filter((t) => !G.restingToday(rowAsked(d), h, t)).length;
  check("a goal with no unanswered recheck is searched every day", searchedDays(null) === 14);
  check("inside the answer window it is still searched daily", days.slice(0, 4).every((t) => !G.restingToday(rowAsked(3), h, t)));
  check("after an unanswered recheck it is searched weekly (2 of 14 days), never dropped", searchedDays(30) === 2, searchedDays(30));
  check("a reply or new signal clears the ask and the daily search is back", searchedDays(null) === 14 && /recheck_asked_at = CASE WHEN \$4::boolean THEN NULL/.test(src("services/goalRecheck.ts")));
  // The 9am floor: a resting goal is skipped on non-weekly days and searched on its weekly day; no ask, or an answered one, is daily.
  const DS = await import("../../src/services/dailySweep.js");
  const plan = { search: "running clubs in the Marina", why: null };
  const floor = (asked: number | null, t: Date) => DS.floorGoalDecision(plan, { states: new Map([[h, { state: "active", reason: "", recheckAskedAt: asked === null ? null : ago(asked) }]]), statesError: null, gateError: null, hold: [], goalId: h, now: t });
  const outcomes = days.map((t) => floor(30, t));
  check("floor: a resting goal is searched on exactly its weekly day (2 of 14) and skipped, saying why, on the others", outcomes.filter((o) => o === null).length === 2 && outcomes.filter((o) => o?.status === "skipped" && /weekly/.test(o.why)).length === 12, outcomes.map((o) => o?.status ?? "search"));
  check("floor: with no unanswered recheck it is searched every day", days.every((t) => floor(null, t) === null));
  check("floor: still inside the answer window it is searched every day", days.slice(0, 4).every((t) => floor(3, t) === null));
  check("floor: a set-aside goal is still skipped as before", DS.floorGoalDecision(plan, { states: new Map([[h, { state: "stale", reason: "x" }]]), statesError: null, gateError: null, hold: [], goalId: h, now: NOW })?.status === "skipped");
  check("floor passes the clock to the decision", /goalId: b\.id, now \}/.test(src("services/dailySweep.ts")));
}

// 5. copy placement
{
  check("the pause sits in its own section, 'Paused for now'", W.GROUP_TITLES.reach === "Paused for now");
  const items = W.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], paces: [{ kind: "find", line: "paused for now: finds" }] } as any);
  const view = W.groupKnown(items);
  const g = view.groups.find((x: any) => x.group === "reach");
  check("it renders under that title, not under 'What I'm holding for you'", !!g && g.title === "Paused for now" && g.lines.length === 1 && !view.groups.some((x: any) => x.group === "waiting"), view.groups.map((x: any) => x.title));
}

// 6. the ask expiry backfill runs once
{
  const asks = [{ id: "u1", user_id: "m1", ask_text: "anyone doing climate meetups", created_at: "2026-11-01T10:00:00Z", expires_at: null as any, checked: false }, { id: "u2", user_id: "m1", ask_text: "a founders dinner this Friday", created_at: "2026-11-01T10:00:00Z", expires_at: null as any, checked: false }];
  let backfillReads = 0;
  (pool as any).query = async (sql: string, args: any[] = []) => {
    const t = sql.replace(/\s+/g, " ");
    if (/FROM ask_checkins WHERE resolved_at IS NULL AND expires_at IS NULL AND expiry_checked_at IS NULL/.test(t)) { backfillReads++; return { rows: asks.filter((a) => !a.checked && !a.expires_at) }; }
    if (/^UPDATE ask_checkins SET expires_at = \$2, expiry_checked_at = NOW\(\)/.test(t)) { const a = asks.find((x) => x.id === args[0])!; a.expires_at = args[1]; a.checked = true; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  await AE.expireStaleAsks();
  const firstReads = asks.filter((a) => a.checked).length;
  await AE.expireStaleAsks();
  check("every ask read is marked checked, named or not", firstReads === 2 && asks[0].expires_at === null && asks[1].expires_at instanceof Date, asks);
  check("the second run reads no ask again", backfillReads === 2, backfillReads);
  check("the column is added", /ADD COLUMN IF NOT EXISTS expiry_checked_at/.test(src("db/migrations.ts")));
}

// ---- 7. the no-show note's intro tease stamps the pair too
{
  const NS = await import("../../src/services/eventNoShow.js");
  const seen: { sql: string; args: any[] }[] = [];
  (pool as any).query = async (sql: string, args: any[] = []) => { seen.push({ sql: sql.replace(/\s+/g, " "), args }); return { rows: [], rowCount: 1 }; };
  await NS.afterNoShowNoteSent({ userId: "z-user", payload: { eventId: "e1", intro: { askId: "ask9", candidate: { candidate_id: "a-user", match_reason: "reason", share_safe: true } } } } as any);
  const stamp = seen.find((q) => /INSERT INTO network_introductions/.test(q.sql) && /last_suggested_at/.test(q.sql));
  check("the no-show intro tease stamps the pair (last_suggested_at), canonical order", !!stamp && stamp.args[0] === "a-user" && stamp.args[1] === "z-user", seen.map((q) => q.sql.slice(0, 60)));
  check("and still writes the open question", seen.some((q) => /network_offer_pending/.test(q.sql)));
  const none = seen.length;
  await NS.afterNoShowNoteSent({ userId: "z-user", payload: { eventId: "e1" } } as any);
  check("a note with no intro offer stamps nothing", !seen.slice(none).some((q) => /network_introductions/.test(q.sql)));
  // Every writer of network_offer_pending also stamps.
  const writers = ["harness/proactiveRegistry.ts", "services/eventNoShow.ts"].filter((f) => /'network_offer_pending'/.test(src(f)));
  check("every path that writes network_offer_pending calls recordTease", writers.length === 2 && writers.every((f) => /recordTease/.test(src(f))), writers);
  const all = fs.readdirSync(new URL("../../src", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const strays = all.filter((f) => /INSERT INTO co_memories[^`]*'network_offer_pending'/.test(src(f)) && !/recordTease/.test(src(f)));
  check("no other file writes it without recordTease", strays.length === 0, strays);
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
