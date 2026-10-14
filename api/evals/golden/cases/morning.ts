// The 9am morning: one find per tier (34), and a goal plan that stays current until the goals change (35-38). The picker and the
// plan read are the real model calls (recorded, replayed in CI); the database and the search are stubbed. The clock is the harness's
// (2026-10-13T21:00:00Z, evals/lib/goldenReplay.mjs GOLDEN_NOW).
import "../../lib/requireMeter.js";
import { goalHash } from "../../../src/services/goalEdges.js";
import * as G from "../../../src/services/goalEdges.js";
import type { MemberKnowledge } from "../../../src/services/memberKnowledge.js";
import { selectForMember, tierOf, type SelectContext } from "../../../src/services/sweepSelect.js";
import { factsFromKnowledge } from "../../../src/services/sweepSelectContext.js";
import { floorGoalPlan, goalItemsFromPlan, type FloorPlanDeps } from "../../../src/services/dailySweep.js";
import { result, type GoldenCase } from "../types.js";

// ---------------------------------------------------------------- 34
const oneFindPerTier: GoldenCase = {
  n: 34,
  id: "one-find-per-tier",
  title: "The morning send is one find per tier: every tier with a find sends its best, never two from one tier",
  status: { live: true },
  from: "Royce 2026-10-14: \"we are suppose to send one find per tier, but one not being available shouldn't stop things from being sent out\" (10-14: three members got nothing with finds in their pools)",
  run: async () => {
    const at = new Date().toISOString();
    const k: MemberKnowledge = {
      userId: "u-ellis",
      asOf: at,
      identity: { firstName: "Ellis", city: "San Francisco", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: at },
      goals: [{ text: "meet other climate founders who actually see each other", state: "active", reason: null, told: true, onFile: true, hash: goalHash("meet other climate founders who actually see each other"), verifiedAt: at }],
      asks: [],
      delivered: [],
      carrying: [],
      lessons: [],
      corrections: [],
      preferences: [],
      claims: [],
      restraint: null,
      exchanges: [
        { from: "member", text: "I run product at a small climate startup and barely know anyone here yet. Dinners, a hike crew, that kind of thing.", call: false, verifiedAt: "2026-10-12T16:20:00Z" },
        { from: "co", text: "Got it. I'll look for small rooms with climate people in them.", call: false, verifiedAt: "2026-10-12T16:21:00Z" },
      ],
      person: null,
      limits: null,
    };
    const c: SelectContext = {
      ...factsFromKnowledge(k),
      today: "2026-10-13",
      weekday: "Tuesday",
      asks: [{ id: "A1", text: "climate founders dinners or a hike crew in SF", since: "2026-10-12" }],
      sent: [],
      outcomes: [],
      discoveryLeft: 4,
      morning: true,
      pool: [
        { id: "C1", key: "co supper|2026-10-16", name: "Cue Supper: Climate Builders", date: "2026-10-16", tier: 1, kind: "answer", asks: ["A1"], details: "a Cue dinner for 12, climate founders and operators, Thursday 7pm, Mission" },
        { id: "C2", key: "climate hike|2026-10-18", name: "Climate Tech Hike: Lands End", date: "2026-10-18", tier: 2, kind: "answer", asks: ["A1"], details: "a 15-person Saturday morning hike for people working in climate" },
        { id: "C3", key: "climate drinks|2026-10-15", name: "Climate Founders Drinks (300+ RSVPs)", date: "2026-10-15", tier: 2, kind: "discovery", asks: [], details: "a large open mixer, 300+ RSVPs, name tags" },
        { id: "C4", key: "on deck climate|", name: "On Deck Climate Fellowship, winter cohort", date: "2026-11-15", tier: 3, kind: "discovery", asks: [], details: "a part-time fellowship for climate operators; applications open, close Nov 15" },
      ],
    };
    const r = await selectForMember(c, { userId: "u-ellis" });
    const misses: string[] = [];
    if (r.error) misses.push(`picker error: ${r.error}`);
    const sends = r.judgments.filter((j) => j.verdict === "send");
    const tierOfId = (id: string) => tierOf(c.pool.find((p) => p.id === id)!);
    const byTier = new Map<number, string[]>();
    for (const j of sends) byTier.set(tierOfId(j.id), [...(byTier.get(tierOfId(j.id)) ?? []), j.id]);
    for (const [t, ids] of byTier) if (ids.length > 1) misses.push(`two sends from tier ${t}: ${ids.join(", ")}`);
    for (const t of [1, 2, 3]) {
      if (byTier.has(t)) continue;
      const held = r.judgments.filter((j) => tierOfId(j.id) === t && j.verdict === "reject" && ["already_known", "closed", "ruled_out", "too_late", "guard"].includes(j.reason));
      if (!held.length) misses.push(`tier ${t} sent nothing and nothing in it had a real reason against it`);
    }
    return result(misses, `${r.judgments.map((j) => `${j.id} t${tierOfId(j.id)} ${j.verdict}/${j.reason}${j.rank ? ` r${j.rank}` : ""}${j.guard ? ` [${j.guard.slice(0, 80)}]` : ""}`).join("; ")}; claim check: ${r.claimCheck?.calls ?? 0} call`);
  },
};

// ---------------------------------------------------------------- 35-38: the floor's goal plan (dailySweep.ts floorGoalPlan)
const GOALS = ["meet other climate founders who actually see each other", "find a Saturday hiking crew in the Bay Area", "raise a pre-seed round for a climate software startup"];
const NOW = () => new Date();
const daysAgo = (n: number) => new Date(NOW().getTime() - n * 86_400_000);
const storedPlan = (goals: string[], at: Date, o: { sig?: boolean } = {}) => ({
  proposal: { edges: goals.map((g) => ({ goal: g, kind: "findable", edges: [`${g.split(" ").slice(1, 4).join(" ")}`] })), passed: [], setAside: [], ...(o.sig === false ? {} : { goalsSig: G.goalsSignature(goals), builtAt: at.toISOString() }) },
  created_at: at,
});
function floorDeps(goals: string[], stored: { proposal: any; created_at: Date } | null) {
  const seen = { model: 0, logged: [] as any[] };
  const deps: FloorPlanDeps = {
    inputs: async () => ({ goals, city: "San Francisco", zone: "America/Los_Angeles", firstName: "Ellis", direction: null, enjoys: null, specifics: null, record: { person: "Runs product at a small climate startup; new to SF.", statedTaste: ["small rooms, people who see each other again"], avoid: [], openAsks: [] } }),
    states: async () => new Map(),
    stored: async () => stored,
    build: G.buildFloorPlan,
    // The real plan read (recorded), counted.
    model: async (prompt) => { seen.model++; return G.realGoalDeps.model(prompt); },
    log: async (d) => { seen.logged.push(d); },
  };
  return { deps, seen };
}
const searchedGoals = (plan: any) => (plan ? goalItemsFromPlan(plan, (e) => G.edgeSearchText([e])).filter((g) => g.search).map((g) => g.goal) : []);

const searchedAfterGoalFind: GoldenCase = {
  n: 35,
  id: "plan-goal-find-yesterday",
  title: "A member who got a goal find yesterday is still searched at 9am today",
  status: { live: true },
  from: "Royce 2026-10-14: Jacqueline got 0 goal searches in 4 days after a goal find (cooldown plus a 3-day plan age); \"A send can never reduce what Cue knows\"",
  run: async () => {
    // Her last plan predates fingerprints (as Jacqueline's from 10-10 did), the hourly goal sweep has sat in its cooldown since the
    // find went out yesterday, and the floor must still search her goals today.
    const { deps, seen } = floorDeps(GOALS, storedPlan(GOALS, daysAgo(3), { sig: false }));
    const fp = await floorGoalPlan({ user_id: "u-ellis", cooldown_cleared: false, last_surfaced_at: daysAgo(1) }, NOW(), deps);
    const s = searchedGoals(fp.plan);
    const misses: string[] = [];
    if (!s.length) misses.push(`no goal searched (${fp.how}: ${fp.note ?? fp.failed ?? ""})`);
    if (fp.how === "none") misses.push("the floor had no plan");
    return result(misses, `${fp.how}/${fp.why}; ${seen.model} plan call(s); searched ${s.length}/${GOALS.length}: ${s.join(" | ")}`);
  },
};

const reusedPlan: GoldenCase = {
  n: 36,
  id: "plan-same-goals-reused",
  title: "Same goals and an old plan: the plan is reused, with no planning call",
  status: { live: true },
  from: "Royce 2026-10-14: \"Same goals: use the plan, however old\"",
  run: async () => {
    const { deps, seen } = floorDeps(GOALS, storedPlan(GOALS, daysAgo(5)));
    const fp = await floorGoalPlan({ user_id: "u-ellis" }, NOW(), deps);
    const s = searchedGoals(fp.plan);
    const misses: string[] = [];
    if (fp.how !== "reused") misses.push(`not reused (${fp.how}/${fp.why})`);
    if (seen.model !== 0) misses.push(`${seen.model} planning call(s); expected none`);
    if (s.length !== GOALS.length) misses.push(`searched ${s.length} of ${GOALS.length} goals`);
    return result(misses, `${fp.how}/${fp.why}; ${seen.model} plan call(s); searched ${s.length}`);
  },
};

const changedGoals: GoldenCase = {
  n: 37,
  id: "plan-goals-changed-rebuilt",
  title: "Changed goals: the plan is rebuilt at 9am, then the new goal is searched",
  status: { live: true },
  from: "Royce 2026-10-14: \"Goals changed or no plan: build a new plan right then (one small model call), then search\"",
  run: async () => {
    const now = [...GOALS, "join a community garden in the Mission"];
    const { deps, seen } = floorDeps(now, storedPlan(GOALS, daysAgo(1)));
    const fp = await floorGoalPlan({ user_id: "u-ellis" }, NOW(), deps);
    const s = searchedGoals(fp.plan);
    const misses: string[] = [];
    if (fp.how !== "built" || fp.why !== "goals_changed") misses.push(`not rebuilt for changed goals (${fp.how}/${fp.why})`);
    if (seen.model !== 1) misses.push(`${seen.model} planning calls; expected one`);
    if (!s.includes("join a community garden in the Mission")) misses.push(`the new goal isn't searched (${s.join(" | ")})`);
    if (seen.logged[0]?.action !== "built_at_9am" || seen.logged[0]?.proposal?.goalsSig !== G.goalsSignature(now)) misses.push("the rebuilt plan wasn't written with its fingerprint for later runs");
    return result(misses, `${fp.how}/${fp.why}; ${seen.model} plan call; searched ${s.length}: ${s.join(" | ")}`);
  },
};

const backstopRebuild: GoldenCase = {
  n: 38,
  id: "plan-backstop-rebuilt",
  title: "A plan past the week's backstop, goals unchanged: rebuilt at 9am, never skipped",
  status: { live: true },
  from: "Royce 2026-10-14: \"Add a slow max-age refresh, one week ... a stale plan triggers a rebuild at 9am, never a skip\"",
  run: async () => {
    const { deps, seen } = floorDeps(GOALS, storedPlan(GOALS, daysAgo(G.PLAN_BACKSTOP_DAYS + 2)));
    const fp = await floorGoalPlan({ user_id: "u-ellis" }, NOW(), deps);
    const s = searchedGoals(fp.plan);
    const misses: string[] = [];
    if (fp.how !== "built" || fp.why !== "backstop") misses.push(`not rebuilt on the backstop (${fp.how}/${fp.why})`);
    if (!s.length) misses.push("nothing searched");
    return result(misses, `${fp.how}/${fp.why}; ${seen.model} plan call; searched ${s.length}`);
  },
};

export const CASES: GoldenCase[] = [oneFindPerTier, searchedAfterGoalFind, reusedPlan, changedGoals, backstopRebuild];
