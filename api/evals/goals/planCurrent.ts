// A goal plan stays current until their goals change (Royce, 2026-10-14: "The bug class: a goal plan expiring by age at all ... New
// rule: a plan stays current until goals change ... Hard rule: no timer may gate whether a member's goals get searched. Not a cooldown,
// not a sweep schedule, not a plan age. A send can never reduce what Co knows"). Zero tokens: the plan read is a stub, the store is stubbed.
//   npx tsx evals/goals/planCurrent.ts
import { readFileSync } from "fs";
import * as G from "../../src/services/goalEdges.js";
import * as GS from "../../src/services/goalSweep.js";
import { floorGoalPlan, goalItemsFromPlan, type FloorPlanDeps } from "../../src/services/dailySweep.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};
const day = (d: string) => new Date(`${d}T16:00:00Z`); // 9am in LA
const state = (goal: string, s: "active" | "done" | "stale", reason = "") => [G.goalHash(goal), { goalHash: G.goalHash(goal), goal, state: s, reason, source: "context" as const, changedAt: day("2026-10-01"), toldAt: null, hints: 0 }] as const;

// ---------------------------------------------------------------- the fingerprint
{
  const goals = ["Raise a pre-seed round", "Find a climbing partner", "Host a launch dinner in November"];
  const sig = G.goalsSignature(G.liveGoals(goals, null, new Map()));
  check("same goals in another order or spacing: the same fingerprint", sig === G.goalsSignature(G.liveGoals(["Find a  climbing partner", "Host a launch dinner in November", "raise a pre-seed round"], null, new Map())));
  check("a goal's text edited: a new fingerprint", sig !== G.goalsSignature(G.liveGoals(["Raise a seed round", ...goals.slice(1)], null, new Map())));
  check("a goal added: a new fingerprint", sig !== G.goalsSignature(G.liveGoals([...goals, "Learn to sail"], null, new Map())));
  check("a goal removed: a new fingerprint", sig !== G.goalsSignature(G.liveGoals(goals.slice(1), null, new Map())));
  check("a goal idled (the recheck, or set aside): a new fingerprint", sig !== G.goalsSignature(G.liveGoals(goals, null, new Map([state(goals[1], "stale", "no answer to the recheck")]))));
  check("their long-term direction is one of the goals a plan reads", sig !== G.goalsSignature(G.liveGoals(goals, "build a company in climate", new Map())));
}

// ---------------------------------------------------------------- when a plan is used, and when it's built
{
  const sig = "abc";
  const now = day("2026-10-14");
  check("no plan: build", G.planCurrent(null, sig, now).why === "no_plan" && !G.planCurrent(null, sig, now).reuse);
  check("goals changed: build", G.planCurrent({ goalsSig: "other", at: day("2026-10-13") }, sig, now).why === "goals_changed");
  check("a plan from before fingerprints (no goalsSig): build once", G.planCurrent({ at: day("2026-10-13") }, sig, now).why === "goals_changed");
  check("same goals, 6 days old: used as it is", G.planCurrent({ goalsSig: sig, at: day("2026-10-08") }, sig, now).reuse);
  check(`same goals, past the ${G.PLAN_BACKSTOP_DAYS}-day backstop: rebuilt, never skipped`, G.planCurrent({ goalsSig: sig, at: day("2026-10-06") }, sig, now).why === "backstop");
  check("the backstop counts from the model's read (builtAt), not from when the plan was last logged", G.planCurrent({ goalsSig: sig, builtAt: day("2026-10-01").toISOString(), at: day("2026-10-13") }, sig, now).why === "backstop");
}

// ---------------------------------------------------------------- the floor's plan (dailySweep.ts floorGoalPlan)
const GOALS = ["meet other climate founders", "find a hiking crew in the Bay Area", "raise a pre-seed round"];
const answer = (goals: string[]) => JSON.stringify(goals.map((g, i) => ({ n: i + 1, kind: "findable", edges: [i === 0 ? "climate founder dinners" : i === 1 ? "group hikes Bay Area" : "pre-seed founder programs"], until: null, superseded_by: null, why: "findable" })));
function world(o: { goals?: string[]; states?: Map<string, any>; stored?: { proposal: any; created_at: Date } | null; modelFails?: boolean; inputsFail?: boolean } = {}) {
  const calls = { model: 0, log: [] as any[], writes: 0 };
  const goals = o.goals ?? GOALS;
  const deps: FloorPlanDeps = {
    inputs: async () => { if (o.inputsFail) throw new Error("name read failed"); return { goals, city: "San Francisco", zone: "America/Los_Angeles", firstName: "Priya", direction: null, enjoys: null, specifics: null, record: { person: "", statedTaste: [], avoid: [], openAsks: [] } }; },
    states: async () => o.states ?? new Map(),
    stored: async () => o.stored ?? null,
    build: G.buildFloorPlan,
    model: async () => { calls.model++; if (o.modelFails) throw new Error("overloaded"); return answer(goals); },
    log: async (d) => { calls.log.push(d); },
  };
  return { deps, calls };
}
const stored = (goals: string[], at: Date, extra: any = {}) => ({ proposal: { edges: goals.map((g) => ({ goal: g, kind: "findable", edges: ["x y"] })), passed: [], setAside: [], goalsSig: G.goalsSignature(goals), builtAt: at.toISOString(), ...extra }, created_at: at });
const searched = (fp: { plan: any }) => (fp.plan ? goalItemsFromPlan(fp.plan, (e) => G.edgeSearchText([e])).filter((g) => g.search).map((g) => g.goal) : []);
{
  const reuse = world({ stored: stored(GOALS, day("2026-10-10")) });
  const r = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), reuse.deps);
  check("same goals, 4-day-old plan: used as it is, no planning call, every goal searched", r.how === "reused" && reuse.calls.model === 0 && searched(r).length === 3, r);
  const changed = world({ goals: [...GOALS, "learn to sail in the bay"], stored: stored(GOALS, day("2026-10-13")) });
  const c = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), changed.deps);
  check("goals changed: rebuilt at 9am (one call), then all four searched", c.how === "built" && c.why === "goals_changed" && changed.calls.model === 1 && searched(c).length === 4, c);
  check("the 9am build is written so later runs reuse it: built_at_9am, its fingerprint and builtAt, builtBy floor", changed.calls.log.length === 1 && changed.calls.log[0].action === "built_at_9am" && changed.calls.log[0].proposal.goalsSig === G.goalsSignature([...GOALS, "learn to sail in the bay"]) && changed.calls.log[0].proposal.builtBy === "floor" && Array.isArray(changed.calls.log[0].proposal.derived));
  const none = world({ stored: null });
  const n = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), none.deps);
  check("no plan at all: built at 9am and searched (it was 'no goal plan ... so no goal was searched')", n.how === "built" && n.why === "no_plan" && searched(n).length === 3);
  for (const age of [0, 1, 3, 4, 7, 8, 30, 90]) {
    const w = world({ stored: stored(GOALS, new Date(day("2026-10-14").getTime() - age * 86_400_000)) });
    const x = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), w.deps);
    check(`a plan ${age} day(s) old never means no search (${x.how}, ${w.calls.model} call)`, searched(x).length === 3 && (age > G.PLAN_BACKSTOP_DAYS ? x.how === "built" && x.why === "backstop" : x.how === "reused" && w.calls.model === 0), x);
  }
  const failOld = world({ stored: stored(GOALS, day("2026-10-01")), modelFails: true });
  const fo = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), failOld.deps);
  check("the rebuild fails and an old plan exists: the old plan is searched, and it's said (a stale plan beats searching nothing)", fo.how === "fallback" && searched(fo).length === 3 && /couldn't read their goals; searched from their plan of 2026-10-01/.test(fo.note ?? ""), fo);
  const failNew = world({ stored: null, modelFails: true });
  const fn = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), failNew.deps);
  check("the rebuild fails with no plan to fall back on: a failure naming every goal (the floor logs each as an error and retries), never a quiet skip", !fn.plan && !!fn.failed && fn.live.length === 3, fn);
  const failRecord = world({ stored: stored(GOALS, day("2026-10-12")), inputsFail: true });
  const fr = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), failRecord.deps);
  check("their record can't be read: the last plan is searched, and it's said", fr.how === "fallback" && searched(fr).length === 3);
  const windowGone = world({ stored: null, goals: ["attend SF Climate Week on October 1", ...GOALS.slice(1)] });
  windowGone.deps.model = async () => JSON.stringify([{ n: 1, kind: "findable", edges: ["climate founder dinners"], until: "2026-10-01", superseded_by: null, why: "x" }, { n: 2, kind: "findable", edges: ["group hikes Bay Area"], until: null, superseded_by: null, why: "x" }, { n: 3, kind: "findable", edges: ["pre-seed founder programs"], until: null, superseded_by: null, why: "x" }]);
  const wg = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), windowGone.deps);
  check("the 9am build writes no goal state: a goal whose window passed is only passed over (the hourly sweep sets it aside)", searched(wg).length === 2 && (wg.plan.passed as any[]).some((p) => /its window passed/.test(p.why)));
  check("the 9am build only reads: its deps are the model and the log, nothing that writes goal states, retires asks or rechecks", !/setState|helpAsk|keepRetireFlags|recheck/.test(G.buildFloorPlan.toString()));
}

// ---------------------------------------------------------------- the hard rule, structurally (no position in a file)
{
  const DS = await import("../../src/services/dailySweep.js");
  const P = await import("../../src/harness/proactive.js");
  // 1. A row that throws if anything on the floor's goal path reads the cooldown or the sweep schedule.
  const trap = (o: any) => new Proxy(o, { get: (t, k) => { if (["cooldown_cleared", "last_surfaced_at", "last_attempted_at"].includes(String(k))) throw new Error(`read ${String(k)}`); return (t as any)[k]; } });
  let threw: string | null = null;
  const fp = await floorGoalPlan(trap({ user_id: "u1" }), day("2026-10-14"), world({ stored: stored(GOALS, day("2026-10-12")) }).deps).catch((e: any) => { threw = e.message; return null; });
  check("structural: the floor's goal plan never reads the cooldown or the sweep schedule (a row that throws on those reads passes)", !threw && !!fp && searched(fp).length === 3, threw);
  // 2. Every function on the floor's goal call path, whole: none reads a cooldown, the sweep schedule, a send or a plan's age, except
  // planCurrent's backstop (which only ever rebuilds).
  const path: [string, Function][] = [["floorGoalPlan", DS.floorGoalPlan], ["floorGoalDecision", DS.floorGoalDecision], ["goalItemsFromPlan", DS.goalItemsFromPlan], ["withoutPassedWindows", DS.withoutPassedWindows], ["buildFloorPlan", G.buildFloorPlan], ["readGoalEdges", G.readGoalEdges], ["liveGoals", G.liveGoals], ["goalsSignature", G.goalsSignature], ["latestPlan", GS.latestPlan], ["planInputs", GS.planInputs], ["planCurrent", G.planCurrent]];
  const timerRead = /last_surfaced_at|cooldown|last_attempted_at|GOAL_PLAN_MAX_AGE|INTERVAL|created_at >|proactive_sends|weekly_cap|unanswered|engagement_pace/;
  const bad = path.filter(([, f]) => timerRead.test(f.toString())).map(([n]) => n);
  check("structural: no function on the floor's goal call path reads a cooldown, the sweep schedule, a send timer or a plan age query", bad.length === 0, bad);
  // The floor's member read and its whole per-member sweep (asks and goals) too: no cooldown column, no profile_surfacing_state, no
  // last_attempted_at, anywhere (review of the tier PR: a cooldown re-added to MEMBERS_SQL plus a skip in the goal loop passed).
  const floorRead = /cooldown_cleared|last_surfaced_at|profile_surfacing_state|last_attempted_at/;
  check("structural: the floor's member query reads no cooldown or sweep schedule", !floorRead.test(DS.MEMBERS_SQL), floorRead.exec(DS.MEMBERS_SQL)?.[0]);
  check("structural: the floor's per-member sweep (every line of it) reads no cooldown or sweep schedule", !floorRead.test(DS.sweepMember.toString()), floorRead.exec(DS.sweepMember.toString())?.[0]);
  // Function sources are compared with their whitespace taken out (the runner may minify them).
  const flat = (f: Function) => f.toString().replace(/\s+/g, "");
  const ageReaders = path.filter(([, f]) => /PLAN_BACKSTOP_DAYS|getTime\(\)-/.test(flat(f))).map(([n]) => n);
  check("structural: the only age on that path is planCurrent's backstop, and planCurrent only answers reuse or rebuild", ageReaders.join() === "planCurrent" && flat(DS.floorGoalPlan).includes("if(cur.reuse)return") && flat(DS.floorGoalPlan).includes("constbuilt=awaitd.build("), ageReaders);
  check("structural: the floor's goal gate holds no send-set timer", !P.SWEEP_BLOCKERS.floor_goal.some((x) => P.SEND_TIMERS.includes(x)) && ["weekly_cap", "engagement_pace", "unanswered_pause"].every((x) => P.SEND_TIMERS.includes(x)));
  // 3. The one exception: the engagement taper reads only their own last message and the floor's own last search, never a send.
  const cadenceSrc = DS.searchCadence.toString();
  check("structural: the taper's inputs are their last message and the floor's last search; nothing Cue sent", !/send|sent|unanswered|cooldown|surfaced/i.test(cadenceSrc.replace(/lastSearchAt|lastInboundAt/g, "")) && /lastInboundAt/.test(cadenceSrc) && /lastSearchAt/.test(cadenceSrc));
  const rd = DS.runDailySweep.toString().replace(/\s+/g, "");
  check("structural: the floor's day reads the taper from their last message and its own last search record, never a send", rd.includes("constinboundAt=awaitlastInboundAt(userId);") && rd.includes("searchCadence({now,zone,lastInboundAt:inboundAt,lastSearchAt:") && rd.includes("decision='sweep.daily'") && !/proactive_sends|proactive_candidates|last_surfaced/.test(rd));
  const fp1 = await floorGoalPlan({ user_id: "u1", cooldown_cleared: false, last_surfaced_at: day("2026-10-14") }, day("2026-10-14"), world({ stored: stored(GOALS, day("2026-10-12")) }).deps);
  const fp2 = await floorGoalPlan({ user_id: "u1", cooldown_cleared: true, last_surfaced_at: null }, day("2026-10-14"), world({ stored: stored(GOALS, day("2026-10-12")) }).deps);
  check("a goal find going out this morning changes nothing about tomorrow's floor plan", JSON.stringify(searched(fp1)) === JSON.stringify(searched(fp2)) && searched(fp1).length === 3);
  const gs = readFileSync(new URL("../../src/services/goalSweep.ts", import.meta.url), "utf8");
  check("the latest plan is read at any age (no interval), skipping only reads that failed", /NOT IN \('read_failed', 'read_cut_off'\) ORDER BY created_at DESC LIMIT 1/.test(GS.latestPlan.toString()) && !/INTERVAL/.test(GS.latestPlan.toString()) && /export async function latestPlan/.test(gs));
}

// ---------------------------------------------------------------- the plan's review fixes
{
  const DS = await import("../../src/services/dailySweep.js");
  // 6. A failed rebuild with an old plan: the goals it doesn't hold are failed items.
  const newer = [...GOALS, "learn to sail in the bay"];
  const fo = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), world({ goals: newer, stored: stored(GOALS, day("2026-10-01")), modelFails: true }).deps);
  check("a failed rebuild searches the old plan and names the goals it doesn't hold (each a failed item, retried)", fo.how === "fallback" && JSON.stringify(fo.uncovered) === JSON.stringify(["learn to sail in the bay"]) && searched(fo).length === 3, fo);
  check("pin: uncovered goals become error items on the floor", /for \(const g of fp\?\.uncovered \?\? \[\]\) items\.push\(\{ kind: "goal", id: goalHash\(g\), text: itemText\(g\), status: "error"/.test(readFileSync(new URL("../../src/services/dailySweep.ts", import.meta.url), "utf8")));
  // 7. A reused plan drops a goal whose window has passed since.
  const withUntil = stored(GOALS, day("2026-10-12"), { derived: [{ goal: GOALS[2], until: "2026-10-13" }, { goal: GOALS[0], until: null }] });
  const re = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), world({ stored: withUntil }).deps);
  check("on reuse, a goal whose window passed since is passed over, not searched", re.how === "reused" && searched(re).length === 2 && !searched(re).includes(GOALS[2]) && (re.plan.passed as any[]).some((p) => p.goal === GOALS[2] && /its window passed \(2026-10-13\)/.test(p.why)), re.plan);
  // 8. A 9am build never reads as "the seeds changed" for a new member's early rerun.
  check("the hourly sweep's seed check reads only its own plans (a floor build carries no seed signature)", /AND COALESCE\(proposal->>'builtBy', ''\) <> 'floor'/.test(readFileSync(new URL("../../src/services/goalSweep.ts", import.meta.url), "utf8")));
  // 11. No live goals: no plan.
  const none = await floorGoalPlan({ user_id: "u1" }, day("2026-10-14"), world({ goals: [], stored: stored(GOALS, day("2026-10-12")) }).deps);
  check("no live goals means no plan (an old one is never searched in their place)", none.plan === null && none.how === "none");
  // 12. An unreadable state or gate is an error, never a quiet skip.
  const g = { search: "x y", why: null };
  check("unreadable goal states: an error item, retried", DS.floorGoalDecision(g, { states: null, statesError: "db down", gateError: null, hold: [], goalId: "h" })?.status === "error");
  check("an unreadable send gate (kind restraint, away, safety): an error item, retried", DS.floorGoalDecision(g, { states: new Map(), statesError: null, gateError: "their send gates couldn't be read: timeout", hold: [], goalId: "h" })?.status === "error");
  check("a readable hold that isn't a timer still skips, and says so", DS.floorGoalDecision(g, { states: new Map(), statesError: null, gateError: null, hold: ["safety_hold"], goalId: "h" })?.why === "held: safety_hold");
}

// ---------------------------------------------------------------- away pauses only place-bound goals (Royce, 2026-10-14)
{
  const DS = await import("../../src/services/dailySweep.js");
  const plan = { edges: [{ goal: "apply to South Park Commons", kind: "findable", edges: ["SPC founder fellowship"], placeBound: false }, { goal: "find a venue near home for a launch dinner", kind: "findable", edges: ["private dining Mission"], placeBound: true }, { goal: "raise a pre-seed round", kind: "findable", edges: ["pre-seed open calls"] }], passed: [], setAside: [] };
  const items = DS.goalItemsFromPlan(plan, (e) => G.edgeSearchText([e]));
  const away = items.map((g) => ({ goal: g.goal, d: DS.floorGoalDecision(g, { states: new Map(), statesError: null, gateError: null, hold: ["away_hold"], goalId: "h" }) }));
  check("away: SPC (portable) is searched, the venue near home (place-bound) is skipped as 'away: place-bound'", away[0].d === null && away[1].d?.why === "away: place-bound" && away[1].d?.status === "skipped", away);
  check("a goal whose read has no placeBound counts as portable: searched while away", away[2].d === null);
  const both = DS.floorGoalDecision(items[0], { states: new Map(), statesError: null, gateError: null, hold: ["away_hold", "safety_hold"], goalId: "h" });
  check("away with another hold (safety): that hold still skips every goal", both?.why === "held: safety_hold");
  const parsed = G.parseEdges(["apply to SPC", "find a venue near home", "learn Spanish"], JSON.stringify([{ n: 1, kind: "findable", edges: ["SPC fellowship"], place_bound: false }, { n: 2, kind: "findable", edges: ["private dining Mission"], place_bound: true }, { n: 3, kind: "findable", edges: ["Spanish classes"] }]));
  check("the plan's own read carries placeBound (same call); missing reads as unknown", parsed[0].placeBound === false && parsed[1].placeBound === true && parsed[2].placeBound === null && /place_bound: true when/.test(G.edgePrompt(["x"], { city: "SF", today: "2026-10-14" })));
}

// ---------------------------------------------------------------- search cadence follows engagement (Royce, 2026-10-14)
{
  const DS = await import("../../src/services/dailySweep.js");
  const z = "America/Los_Angeles";
  const at = (d: string, h = 16) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
  const now = at("2026-10-30");
  const c = (inbound: string | null, search: string | null) => DS.searchCadence({ now, zone: z, lastInboundAt: inbound ? at(inbound, 2) : null, lastSearchAt: search ? at(search) : null });
  check("engaged (wrote 3 days ago): searched daily", c("2026-10-27", "2026-10-29").search && c("2026-10-27", "2026-10-29").everyDays === 1);
  check("quiet 10 days: every 3 days (searched 2 days ago: not today, next in a day; 3 days ago: today)", !c("2026-10-20", "2026-10-28").search && c("2026-10-20", "2026-10-28").next === "2026-10-31" && c("2026-10-20", "2026-10-27").search && c("2026-10-20", "2026-10-27").everyDays === 3);
  check("quiet over 14 days: weekly (6 days since: not today; 7: today)", !c("2026-10-01", "2026-10-24").search && c("2026-10-01", "2026-10-23").search && c("2026-10-01", "2026-10-23").everyDays === 7);
  check("weekly is the floor: silent 200 days, still searched every 7", c("2026-04-13", "2026-10-23").search && !c("2026-04-13", "2026-10-25").search && c("2026-04-13", "2026-10-25").everyDays === 7);
  const resume = DS.searchCadence({ now, zone: z, lastInboundAt: at("2026-10-29", 23), lastSearchAt: at("2026-10-29") });
  check("silent exactly 7 days: every 3 days (Royce 2026-10-14: taper starts at 7)", c("2026-10-24", "2026-10-29").everyDays === 3 && !c("2026-10-24", "2026-10-29").search && c("2026-10-25", "2026-10-29").everyDays === 1); // inbound at 02:00Z is the evening before in their zone
  check("instant resume: a message from them since the last search means today's 9am searches everything", resume.search && /wrote since the last search/.test(resume.why));
  check("a tapered day says so: 'tapered: quiet N days, next search <date>'", c("2026-10-01", "2026-10-24").why === "tapered: quiet 29 days, next search 2026-10-30" || /^tapered: quiet \d+ days, next search \d{4}-\d{2}-\d{2}$/.test(c("2026-10-01", "2026-10-24").why), c("2026-10-01", "2026-10-24").why);
  check("a send never affects the cadence: it isn't an input (same inputs, same answer, whatever Cue sent)", DS.searchCadence.length === 1 && JSON.stringify(c("2026-10-20", "2026-10-28")) === JSON.stringify(c("2026-10-20", "2026-10-28")));
  check("thresholds: daily within 6 days, tapered from 7 (a week is the unit), every 3 days to 14, weekly after", DS.SEARCH_TAPER.dailyUpToDays === 6 && DS.SEARCH_TAPER.everyFewUpToDays === 14 && DS.SEARCH_TAPER.everyFewDays === 3 && DS.SEARCH_TAPER.weeklyDays === 7);
  const rd = DS.runDailySweep.toString().replace(/\s+/g, "");
  check("pin: a tapered day is written as the day's record (never silent) and searches nothing", rd.includes('if(!cadence.search){awaitwriteDaily(userId,"skip","tapered",cadence.why') && rd.indexOf("cadence.search") < rd.indexOf("sweepMember("));
  check("the team list shows a tapered day as tapered", DS.rollupDay([{ outcome: "skip", action: "tapered", reason: "tapered: quiet 20 days, next search 2026-10-31", proposal: {} }], 0, true, true).status === "tapered");
}

// ---------------------------------------------------------------- the hourly sweep: the cooldown limits its own extra finds only
{
  const calls: string[] = [];
  const row = { user_id: "u", goals: GOALS, intent: [], last_attempted_at: null, cooldown_cleared: false };
  await GS.runGoalSweep(async (items: any[], _n: number, fn: any) => { for (const i of items) await fn(i); }, {
    rows: async () => [row],
    mark: async () => { calls.push("mark"); },
    plan: async () => { calls.push("plan"); return { searchText: "x" }; },
    surface: async () => { calls.push("surface"); },
    held: async () => [],
    skipped: async (_r, why, detail) => { calls.push(`skipped:${why}:${detail.join(" ")}`); },
  });
  check("in the cooldown the hourly goal sweep doesn't search or send, and says the 9am floor still plans and searches", calls.join("|") === "mark|skipped:cooldown:a find went out within 3 days: this sweep's extra search and send held; the 9am floor still plans and searches their goals", calls);
  // The hourly plan reuses the stored read while the goals are the same: no model call, and its lifecycle still runs against today.
  let model = 0;
  const writes: string[] = [];
  const deps: any = { model: async () => { model++; return answer(GOALS); }, states: async () => new Map(), setState: async (_u: string, g: string, s: string, r: string) => { writes.push(`${g}:${s}:${r}`); return true; }, corrections: async () => [], retired: () => null, findAsks: async () => [], helpAsk: async () => {}, log: async () => {} };
  const derived = GOALS.map((g, i) => ({ goal: g, kind: "findable", edges: ["e f"], why: "", until: i === 2 ? "2026-10-10" : null, supersededBy: null, explicit: true }));
  const same = await G.planGoalSweep("u", GOALS, { city: "SF", zone: "America/Los_Angeles", now: day("2026-10-14"), stored: { goalsSig: G.goalsSignature(GOALS), builtAt: day("2026-10-11").toISOString(), derived: derived as any, at: day("2026-10-11") } }, deps);
  check("hourly: same goals inside the backstop reuse the stored read (no model call); a window that passed since still sets its goal aside", model === 0 && same.read === "reused" && writes.some((w) => w.startsWith("raise a pre-seed round:stale:its window passed")), { model, writes, read: same.read });
  await G.planGoalSweep("u", [...GOALS, "learn to sail"], { city: "SF", zone: "America/Los_Angeles", now: day("2026-10-14"), stored: { goalsSig: G.goalsSignature(GOALS), builtAt: day("2026-10-11").toISOString(), derived: derived as any, at: day("2026-10-11") } }, deps);
  check("hourly: changed goals are read fresh", model === 1);
}

// ---------------------------------------------------------------- Jacqueline's 10-10 to 10-14, renamed Priya
{
  // Her last plan was 10-10 21:30 (before fingerprints); a goal find went out 10-11 08:15; the hourly goal sweep then hit the cooldown on
  // 10-11, 10-12, 10-13 and 10-14 and never planned. On 10-14 the old floor read no plan from the last 3 days: 0 of her 9 goals searched. (11-04: 8 of 9 now: the trip is outside the purpose boundary.)
  const NINE = ["co-found Cue with Royce", "build a design system for Cue", "get to 20 members by November", "host a November launch party", "find a Pilates studio near the Mission", "meet women founders in SF", "learn product analytics", "plan a trip to Mexico City", "read more fiction this fall"];
  const old = { proposal: { edges: NINE.map((g) => ({ goal: g, kind: "findable", edges: ["x y"] })), passed: [], setAside: [] }, created_at: new Date("2026-10-10T21:30:05Z") };
  const w = world({ goals: NINE, stored: old });
  w.deps.model = async () => { w.calls.model++; return JSON.stringify(NINE.map((g, i) => ({ n: i + 1, kind: "findable", edges: [`edge ${i}`], until: null, superseded_by: null, why: "" }))); };
  const r = await floorGoalPlan({ user_id: "priya", cooldown_cleared: false }, new Date("2026-10-14T16:00:00Z"), w.deps);
  check("Priya on 10-14: her goals are searched (the pre-fingerprint plan is rebuilt once at 9am, then reused)", r.how === "built" && searched(r).length === 8 && w.calls.model === 1, r); // 8 of 9: "plan a trip to Mexico" is outside the purpose boundary (remembered, never searched)
  const r2 = await floorGoalPlan({ user_id: "priya" }, new Date("2026-10-15T16:00:00Z"), world({ goals: NINE, stored: { proposal: w.calls.log[0].proposal, created_at: new Date("2026-10-14T16:00:00Z") } }).deps);
  check("Priya on 10-15: the 9am plan from 10-14 is reused with no call", r2.how === "reused" && searched(r2).length === 8);
}

// ---------------------------------------------------------------- four days, a goal find on day 1
{
  // Day 0 a plan is built; day 1 a goal find goes out (last_surfaced_at), so the hourly goal sweep sits in its cooldown days 1-3. Each
  // morning the floor plans (only when needed) and searches every goal.
  let plan: { proposal: any; created_at: Date } | null = null;
  let model = 0;
  const log: string[] = [];
  for (let d = 0; d < 5; d++) {
    const now = new Date(Date.UTC(2026, 9, 14 + d, 16));
    const w = world({ stored: plan });
    w.deps.model = async () => { model++; return answer(GOALS); };
    const r = await floorGoalPlan({ user_id: "u1", cooldown_cleared: d === 0 }, now, w.deps);
    if (w.calls.log[0]) plan = { proposal: w.calls.log[0].proposal, created_at: now };
    log.push(`day ${d}: ${r.how}, ${searched(r).length} searched`);
  }
  check("four days after a goal find: every goal searched every morning, one planning call in all (day 0)", log.every((l) => /3 searched/.test(l)) && model === 1 && log[0].startsWith("day 0: built") && log.slice(1).every((l) => /reused/.test(l)), log);
}

console.log(`goal plan current: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
