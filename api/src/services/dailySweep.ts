// The 9am daily sweep (Royce, 2026-10-13: "Bring back the real 9 am sweep"). A floor under the hourly sweeps:
//   - once per member per day, from 9am their time, inside waking hours (localHours.ts), for every member;
//   - every open find ask searched in all three places (events, web, X; sweepFind.ts SWEEP_SOURCES), leaning to what's new
//     (sweepFind.ts RECENT_HOURS), and each active goal searched on its own, from their latest goal plan while it was read from the
//     goals they have now; when their goals changed, there's no plan, or the read is past the week's backstop, the search list is
//     built right then (floorGoalPlan; only the list: goal states, retiring asks and the recheck stay with the hourly goal sweep).
//     No timer decides whether their goals are searched (Royce, 2026-10-14): not the goal cooldown, not a sweep schedule, not a plan's age;
//   - no source selectivity and no empty-streak backoff here; and it leaves the ask lifecycle alone: it never moves an ask's
//     last_attempted_at or its empty-run count (eventSurfacingSweep.ts), so the hourly sweeps run exactly as before, on top;
//   - finds go to the pool (the event backlog), the picker chooses right after (sweepShadow.ts runPickerAfterSweep), and what it chose
//     goes to the member then as their morning finds (sendMorningFinds: each find's link, then its description);
//   - every ask and goal it doesn't search says why, and each run writes one summary line per member (sweep.daily);
//   - an ask that is Co's own work isn't searched (no web, no X, no model loop): it's "followed as its task", the work goes on through
//     the task, and a mixed one is searched for its find part only (services/askSplit.ts, Royce 2026-10-13; planAsk);
//   - a failed run is a failed day: logged as an error and run again on a later hour, at most DAILY_SWEEP_ERRORS_PER_DAY a day.
// Its own cron (jobs/index.ts, :05), never overlapping itself, and a member is claimed while a sweep works on them (claimMember),
// so it and the hourly ask sweep never search one member at the same time.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { hoursZone, REASONABLE_HOUR_END } from "./localHours.js";
import { memberZone } from "./memberTime.js";
import { emptyTierCounts, type TierCounts } from "./tierCounts.js";

export const DAILY_SWEEP_HOUR = 9;
// A failed day is run again on a later hour, at most this many failed runs a day (the picker's rule, sweepShadow.ts PICK_ERRORS_PER_DAY).
export const DAILY_SWEEP_ERRORS_PER_DAY = 3;
export const DAILY_SWEEP_CONCURRENCY = 3;

// Members a sweep is working on right now (this process: co-test runs one). The hourly ask sweep and this one both claim a member
// before searching, and skip one that's taken, so the two never search one member's asks at once.
const busy = new Set<string>();
export function claimMember(userId: string): boolean {
  if (busy.has(userId)) return false;
  busy.add(userId);
  return true;
}
export function releaseMember(userId: string): void {
  busy.delete(userId);
}

// Pure: where a member's day is for the daily sweep: before 9am, open (9am until waking hours end), or past waking hours.
export function dailySweepWindow(now: Date, timezone: string | null | undefined): { day: string; phase: "before" | "open" | "after" } {
  const local = DateTime.fromJSDate(now).setZone(hoursZone(timezone));
  const phase = local.hour < DAILY_SWEEP_HOUR ? "before" : local.hour < REASONABLE_HOUR_END ? "open" : "after";
  return { day: local.toISODate()!, phase };
}

export type ItemResult = {
  kind: "ask" | "goal";
  id: string;
  text: string;
  // incomplete: searched, but a place failed or timed out with nothing back (sweepFind.ts SweepSources.outages): retried on a later
  // hour like an error, never carried as searched (incompleteRetry).
  status: "searched" | "skipped" | "error" | "followed_as_task" | "incomplete";
  why?: string;
  // Followed as its task (planAsk): the task it follows, when one matches (services/statusCheck.ts).
  taskId?: number;
  // A mixed request searched for its find part only (services/askSplit.ts).
  searchedPart?: string;
  sources?: { events: boolean; web: boolean; x: boolean };
  failures?: string[];
  // The places that failed or timed out (incomplete), the places down in a way a retry won't fix (a key, credit, a cap: shown, never
  // retried), and web results dropped for not proving themselves on their page.
  outages?: string[];
  placesDown?: string[];
  unverified?: number;
  // Per tier (1 Noise's events, 2 event pages, 3 web and X openings): searched, found, kept, dropped (sweepFind.ts TierCounts).
  tiers?: TierCounts;
  // Which finds (SurfacingReport.foundKeys / pooledKeys), so a retry counts a find it finds again once (mergeRetried).
  foundKeys?: string[];
  pooledKeys?: string[];
  found?: number;
  pooled?: number;
  queued?: number;
  outcome?: string;
  earlierRun?: boolean;
};

// Pure: per-tier counts added up (an item without them, an older record, adds nothing).
export function sumTiers(list: (TierCounts | undefined)[]): TierCounts {
  const out = emptyTierCounts();
  for (const t of list) if (t) for (const k of ["1", "2", "3"] as const) for (const f of ["searched", "found", "kept", "dropped"] as const) out[k][f] += Number(t[k]?.[f] ?? 0);
  return out;
}

// Pure: the day's one summary line, from what each ask and goal did. An incomplete item isn't counted as searched (nor its places), but
// what it did find is real and in the pool, so its finds count (2026-10-28 sweep).
export function dailySummary(items: ItemResult[]): { action: string; totals: { asksSearched: number; goalsSearched: number; skipped: number; followed: number; errors: number; incomplete: number; placesDown: number; unverified: number; tiers: TierCounts; sources: { events: number; web: number; x: number }; kept: number; pooled: number; queued: number } } {
  const searched = items.filter((i) => i.status === "searched");
  const withFinds = items.filter((i) => i.status === "searched" || i.status === "incomplete");
  const sources = { events: 0, web: 0, x: 0 };
  for (const i of searched) for (const s of ["events", "web", "x"] as const) if (i.sources?.[s]) sources[s]++;
  const totals = {
    asksSearched: searched.filter((i) => i.kind === "ask").length,
    goalsSearched: searched.filter((i) => i.kind === "goal").length,
    skipped: items.filter((i) => i.status === "skipped").length,
    followed: items.filter((i) => i.status === "followed_as_task").length,
    errors: items.filter((i) => i.status === "error").length,
    incomplete: items.filter((i) => i.status === "incomplete").length,
    // Each place down for one ask or goal counts once (web down for three goals is 3).
    placesDown: withFinds.reduce((n, i) => n + (i.placesDown?.length ?? 0), 0),
    unverified: withFinds.reduce((n, i) => n + (i.unverified ?? 0), 0),
    tiers: sumTiers(withFinds.map((i) => i.tiers)),
    sources,
    kept: withFinds.reduce((n, i) => n + (i.found ?? 0), 0),
    pooled: withFinds.reduce((n, i) => n + (i.pooled ?? 0), 0),
    queued: withFinds.reduce((n, i) => n + (i.queued ?? 0), 0),
  };
  const action = `asks searched ${totals.asksSearched}, goals searched ${totals.goalsSearched}, sources events ${sources.events}/web ${sources.web}/x ${sources.x}, finds kept ${totals.kept}, new in the pool ${totals.pooled}, queued ${totals.queued}${totals.skipped ? `, skipped ${totals.skipped}` : ""}${totals.followed ? `, followed as tasks ${totals.followed}` : ""}${totals.incomplete ? `, incomplete ${totals.incomplete}` : ""}${totals.placesDown ? `, places down (not retried) ${totals.placesDown}` : ""}${totals.unverified ? `, web results dropped unverified ${totals.unverified}` : ""}${totals.errors ? `, errors ${totals.errors}` : ""}`;
  return { action, totals };
}

// Pure: what an earlier failed run today already searched, by item (a retry carries them into its summary instead of searching again).
export function searchedEarlierToday(earlier: { proposal: any }[]): Map<string, ItemResult> {
  const done = new Map<string, ItemResult>();
  for (const e of earlier) for (const i of (e.proposal?.items ?? []) as ItemResult[]) if (i.status === "searched") done.set(`${i.kind}:${i.id}`, { ...i, earlierRun: true });
  return done;
}

// Pure: what the floor does with one open ask (services/askSplit.ts floorPlan): search it (its find part, for a mixed one), or follow
// it as its task with no search at all. Reads nothing; the split read and the matching task are handed in.
// Followed only when the read says it's Co's own work AND a task really is that work (task); a part with no task leaves a note.
export type AskPlan = { search: string | null; item: ItemResult | null; plan: import("./askSplit.js").FloorPlan };
export function planAsk(b: { kind: "ask"; id: string; text: string }, askText: string, read: import("./askSplit.js").SplitRead | null, task: { id: number } | null, floorPlan: typeof import("./askSplit.js").floorPlan): AskPlan {
  const p = floorPlan(askText, read, task?.id ?? null);
  if (p.followed && task) return { search: null, item: { ...b, status: "followed_as_task", why: p.why, taskId: task.id }, plan: p };
  // Co's own promise with no task: not searched, said why (the note lists it for the team).
  if (p.search === null) return { search: null, item: { ...b, status: "skipped", why: p.why }, plan: p };
  return { search: p.search, item: null, plan: p };
}

// Pure: a search that looked nowhere failed (the loop threw, their record couldn't be read, or every place failed): an error, so the
// day is retried, never a quiet "searched".
export function searchFailed(rep: { sources: { events: boolean; web: boolean; x: boolean } } | null): boolean {
  return !rep || (!rep.sources.events && !rep.sources.web && !rep.sources.x);
}

// Pure: what one search that looked somewhere did: "searched", or "incomplete" when a place failed or timed out with nothing back
// (Royce, 2026-10-28: "treat a timeout as incomplete with a bounded retry". That morning Exa timed out on all four web queries for
// "apply to South Park Commons or Blueprint II"; events and X ran, so the goal counted as searched and nothing retried it).
export function searchedItem<B extends { kind: "ask" | "goal"; id: string; text: string }>(b: B, rep: { sources: { events: boolean; web: boolean; x: boolean; failures: string[]; outages?: string[]; lasting?: string[]; unverified?: number; tiers?: TierCounts }; found: number; pooled: number; queued: number; outcome: string; foundKeys?: string[]; pooledKeys?: string[] }): ItemResult {
  const outages = rep.sources.outages ?? [];
  return {
    ...b,
    status: outages.length ? "incomplete" : "searched",
    ...(outages.length ? { why: `${outages.join(", ")} failed or timed out: ${rep.sources.failures.join(" | ").slice(0, 240)}`, outages } : {}),
    sources: { events: rep.sources.events, web: rep.sources.web, x: rep.sources.x },
    failures: rep.sources.failures,
    ...(rep.sources.lasting?.length ? { placesDown: rep.sources.lasting } : {}),
    ...(rep.sources.unverified ? { unverified: rep.sources.unverified } : {}),
    ...(rep.sources.tiers ? { tiers: rep.sources.tiers } : {}),
    ...(rep.foundKeys ? { foundKeys: rep.foundKeys } : {}),
    ...(rep.pooledKeys ? { pooledKeys: rep.pooledKeys } : {}),
    found: rep.found,
    pooled: rep.pooled,
    queued: rep.queued,
    outcome: rep.outcome,
  };
}

// Pure: the items an earlier run today left incomplete, by item (the latest one), for mergeRetried.
export function incompleteEarlierToday(earlier: { proposal: any }[]): Map<string, ItemResult> {
  const out = new Map<string, ItemResult>();
  for (const e of earlier) for (const i of (e.proposal?.items ?? []) as ItemResult[]) if (i.status === "incomplete") out.set(`${i.kind}:${i.id}`, i);
  return out;
}

// Pure: a retried item with what its earlier, incomplete search today found (review of #293: the day's counts came from the last run
// alone, so finds the first attempt pooled went uncounted when the retry found fewer). Finds counted once across both by their keys;
// queued is what each run queued (the queue takes a find once), so it adds. Without keys (an older record) the larger count stands.
export function mergeRetried(now: ItemResult, before: ItemResult | undefined): ItemResult {
  if (!before) return now;
  const union = (a?: string[], b?: string[]) => (a && b ? [...new Set([...a, ...b])] : null);
  const fk = union(before.foundKeys, now.foundKeys);
  const pk = union(before.pooledKeys, now.pooledKeys);
  return {
    ...now,
    ...(fk ? { foundKeys: fk } : {}),
    ...(pk ? { pooledKeys: pk } : {}),
    found: fk ? fk.length : Math.max(before.found ?? 0, now.found ?? 0),
    pooled: pk ? pk.length : Math.max(before.pooled ?? 0, now.pooled ?? 0),
    queued: (before.queued ?? 0) + (now.queued ?? 0),
  };
}

// Pure: whether this run's incomplete items get the day run again, using the floor's own retry (a run written as "error" is run again
// on a later hour, at most DAILY_SWEEP_ERRORS_PER_DAY runs a day: the 9am run and two retries). An item searched in full is carried by
// the retry (searchedEarlierToday), never searched twice; an incomplete one is searched again whole: its finds are already in the pool,
// and finding them again adds nothing twice (the backlog merge and the queue each take a find once). The day's last run keeps what it
// has and is written as a normal run, incomplete items said; an on-demand run is never retried.
export function incompleteRetry(items: ItemResult[], errorsToday: number, manual: boolean): "retry" | "last" | null {
  if (!items.some((i) => i.status === "incomplete")) return null;
  return !manual && errorsToday + 1 < DAILY_SWEEP_ERRORS_PER_DAY ? "retry" : "last";
}

// Pure: what the floor searches for each goal, from the hourly goal sweep's latest plan (goal_sweep.plan): each active goal's
// findable edges, on their own (not mixed with another goal's or what they enjoy), and each goal the plan passed or set aside, with why.
// placeBound: the plan's read of the goal (goalEdges.ts GoalEdge.placeBound), carried as the plan has it (true, false, or left out when
// the read didn't say). Away holds only an explicit true (unknown is portable); the 9am search leaves city events out only for an
// explicit false (unknown keeps them: sweepFind.ts sweepSkips, Royce 2026-10-28).
export function goalItemsFromPlan(plan: any, searchText: (edge: any) => string | null): { goal: string; search: string | null; why: string | null; placeBound?: boolean }[] {
  const out: { goal: string; search: string | null; why: string | null; placeBound?: boolean }[] = [];
  for (const e of Array.isArray(plan?.edges) ? plan.edges : []) {
    const s = searchText(e);
    out.push({ goal: String(e.goal ?? ""), search: s, why: s ? null : "its plan has nothing findable to search", ...(typeof e.placeBound === "boolean" ? { placeBound: e.placeBound } : {}) });
  }
  for (const p of Array.isArray(plan?.passed) ? plan.passed : []) out.push({ goal: String(p.goal ?? ""), search: null, why: `nothing findable to search: ${String(p.why ?? "").slice(0, 160)}` });
  for (const a of Array.isArray(plan?.setAside) ? plan.setAside : []) out.push({ goal: String(a.goal ?? ""), search: null, why: `set aside (${a.state ?? "not active"}): ${String(a.reason ?? "").slice(0, 160)}` });
  return out.filter((g) => g.goal);
}

// The goal cooldown (profile_surfacing_state) isn't read here: it limits the hourly goal sweep's own extra finds, never this floor.
export const MEMBERS_SQL = `SELECT u.id AS user_id, u.first_name, u.phone_number, COALESCE(u.sms_opted_out, false) AS opted_out,
        cp.city, cp.goals, cp.intent, cp.activity_preferences, cp.long_term_direction
   FROM users u
   LEFT JOIN co_profiles cp ON cp.user_id = u.id
  WHERE u.archived_at IS NULL AND u.phone_number IS NOT NULL AND u.phone_number NOT LIKE '%#%'
    AND u.identity_captured = true AND u.invite_verified = true`;

// The day's record, written so a failed write is known (recordDecision swallows its errors; a missing summary would re-run the
// member every hour with nothing logged). Throws on failure, so the caller logs it as the member's failed run.
async function writeDaily(userId: string, outcome: "act" | "skip", action: string, reason: string | null, proposal: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO harness_decisions (layer, decision, user_id, outcome, action, proposal, checks, confidence, reason) VALUES (5, 'sweep.daily', $1, $2, $3, $4, '[]', NULL, $5)`,
    [userId, outcome, action, JSON.stringify(proposal), reason],
  );
}

// ------------------------------------------------------------------ the floor's goal plan (Royce, 2026-10-14: "a plan stays current until
// goals change ... Same goals: use the plan, however old. Goals changed or no plan: build a new plan right then (one small model call),
// then search. The 9am run builds only the search list ... Backstop: ... one week ... a stale plan triggers a rebuild at 9am, never a
// skip"). How: "reused" (the plan was read from the goals they have now), "built" (read now), "fallback" (the build failed, so their
// last plan is used: a stale plan beats searching nothing, and it's said), "none" (no live goals). failed: why no plan could be had.
// uncovered: on a fallback, the live goals the old plan doesn't hold (new since it): each is a failed item, retried (review of the tier PR).
export type FloorGoalPlan = { plan: any | null; live: string[]; how: "reused" | "built" | "fallback" | "none" | "kept_quiet"; why: string; note: string | null; failed: string | null; uncovered?: string[] };
export type FloorPlanDeps = {
  inputs: (row: any) => Promise<Awaited<ReturnType<typeof import("./goalSweep.js").planInputs>>>;
  states: (userId: string) => Promise<Map<string, import("./goalEdges.js").GoalStateRow>>;
  stored: (userId: string) => Promise<{ proposal: any; created_at: Date | string } | null>;
  build: typeof import("./goalEdges.js").buildFloorPlan;
  model: import("./goalEdges.js").GoalDeps["model"];
  log: import("./goalEdges.js").GoalDeps["log"];
};
export const realFloorPlanDeps = async (): Promise<FloorPlanDeps> => {
  const [GS, GE] = await Promise.all([import("./goalSweep.js"), import("./goalEdges.js")]);
  return { inputs: GS.planInputs, states: GE.goalStates, stored: GS.latestPlan, build: GE.buildFloorPlan, model: GE.realGoalDeps.model, log: GE.realGoalDeps.log };
};
// quiet: a tapered search day. No plan is written: their last plan is searched as it is (however old, whatever changed), and with none,
// the search list is read for this search only, never logged as their plan (Royce, 2026-10-14: no goal or plan changes while tapered).
// When a goal was recorded, for where it is (services/wantPlace.ts): its intent entry's created_at, else unknown (a goal from the older
// profile list, read from its own words only).
export function goalRecordedAt(intent: unknown, goal: string): Date | null {
  const e = (Array.isArray(intent) ? intent : []).find((x: any) => x?.kind === "goal" && typeof x?.text === "string" && x.text.trim().toLowerCase() === goal.trim().toLowerCase());
  const at = e?.created_at ?? e?.createdAt;
  return at ? new Date(at) : null;
}

export async function floorGoalPlan(row: any, now: Date, deps?: FloorPlanDeps, o: { quiet?: boolean } = {}): Promise<FloorGoalPlan> {
  const d = deps ?? (await realFloorPlanDeps());
  const GE = await import("./goalEdges.js");
  const userId = String(row.user_id);
  const stored = await d.stored(userId).catch(() => null);
  const fallback = (why: string, failed: string): FloorGoalPlan =>
    stored
      ? { plan: stored.proposal, live: [], how: "fallback", why, note: `${failed}; searched from their plan of ${new Date(String(stored.created_at)).toISOString().slice(0, 10)}`, failed: null }
      : { plan: null, live: [], how: "none", why, note: failed, failed };
  let inputs: Awaited<ReturnType<FloorPlanDeps["inputs"]>>;
  let states: Map<string, import("./goalEdges.js").GoalStateRow>;
  try {
    [inputs, states] = await Promise.all([d.inputs(row), d.states(userId)]);
  } catch (err: any) {
    return fallback("record_unreadable", `their goals couldn't be read for the plan (${String(err?.message ?? err).slice(0, 120)})`);
  }
  const live = GE.liveGoals(inputs.goals, inputs.direction, states);
  // No live goals: nothing to search, and no old plan is searched in their place.
  if (!live.length) return { plan: null, live, how: "none", why: "no_live_goals", note: null, failed: null };
  if (o.quiet && stored) return { plan: withoutPassedWindows(stored.proposal, now, inputs.zone), live, how: "kept_quiet", why: "tapered: their plan is kept as it is", note: null, failed: null };
  const sig = GE.goalsSignature(live);
  const cur = GE.planCurrent(stored ? { goalsSig: stored.proposal?.goalsSig ?? null, builtAt: stored.proposal?.builtAt ?? null, at: stored.created_at } : null, sig, now);
  if (cur.reuse) return { plan: withoutPassedWindows(stored!.proposal, now, inputs.zone), live, how: "reused", why: cur.why, note: null, failed: null };
  const built = await d.build(userId, live, { city: inputs.city, zone: inputs.zone, now, firstName: inputs.firstName, direction: inputs.direction, record: inputs.record, why: cur.why }, { model: d.model, log: o.quiet ? async () => {} : d.log }).catch((err: any) => ({ proposal: null as any, read: "failed" as const, err }));
  if (built.proposal && built.read !== "failed" && built.read !== "cut_off") return { plan: built.proposal, live, how: "built", why: cur.why, note: o.quiet ? "tapered: the search list was read for this search only, not kept as their plan" : `their goal plan was built at 9am (${cur.why.replace(/_/g, " ")})`, failed: null };
  const r = { ...fallback(cur.why, `the 9am plan build (${cur.why.replace(/_/g, " ")}) couldn't read their goals${built.read === "cut_off" ? " whole" : ""}`), live };
  if (r.plan) {
    // The old plan searches what it holds; a goal it doesn't hold (new since) is a failed item, retried next hour.
    const held = new Set(goalItemsFromPlan(r.plan, () => null).map((g) => g.goal.trim().toLowerCase()));
    r.plan = withoutPassedWindows(r.plan, now, inputs.zone);
    r.uncovered = live.filter((g) => !held.has(g.trim().toLowerCase()));
  }
  return r;
}

// Pure: a reused plan without the goals whose own read said their window has passed (derived.until before today in their zone): those
// are passed over, never searched (the hourly sweep sets them aside). A plan without that read (older) is used as it is.
export function withoutPassedWindows(plan: any, now: Date, zone: string | null): any {
  const derived: any[] = Array.isArray(plan?.derived) ? plan.derived : [];
  if (!derived.length) return plan;
  const today = DateTime.fromJSDate(now).setZone(hoursZone(zone)).toISODate()!;
  const gone = new Map(derived.filter((e) => typeof e?.until === "string" && e.until < today).map((e) => [String(e.goal), String(e.until)]));
  if (!gone.size) return plan;
  return { ...plan, edges: (plan.edges ?? []).filter((e: any) => !gone.has(String(e.goal))), passed: [...(plan.passed ?? []), ...[...gone].map(([goal, until]) => ({ goal, why: `its window passed (${until}); the hourly sweep sets it aside` }))] };
}

// Pure: whether the floor searches one planned goal, or the item that says why not (null: search it). Its inputs are the plan, the goal
// states, the floor's own gate (proactive.ts SWEEP_BLOCKERS.floor_goal: never a send timer) and whether either read failed: no cooldown,
// no sweep schedule, no plan age (pinned in evals/goals/planCurrent.ts). An unreadable read is an error, retried, never a quiet skip.
// Away pauses only place-bound goals: portable ones (funding, jobs, programs) keep being searched (Royce, 2026-10-14); unknown is portable.
export function floorGoalDecision(g: { search: string | null; why: string | null; placeBound?: boolean }, o: { states: Map<string, { state: string; reason: string }> | null; statesError: string | null; gateError: string | null; hold: string[]; goalId: string }): { status: "skipped" | "error"; why: string } | null {
  if (!g.search) return { status: "skipped", why: g.why ?? "nothing to search" };
  if (!o.states) return { status: "error", why: `its state couldn't be read${o.statesError ? `: ${o.statesError}` : ""}` };
  if (o.gateError) return { status: "error", why: o.gateError };
  const st = o.states.get(o.goalId);
  if (st && st.state !== "active") return { status: "skipped", why: `set aside since its plan (${st.state}: ${st.reason.slice(0, 120)})` };
  const otherHolds = o.hold.filter((h) => h !== "away_hold");
  if (otherHolds.length) return { status: "skipped", why: `held: ${otherHolds.join(", ")}` };
  if (o.hold.includes("away_hold") && g.placeBound === true) return { status: "skipped", why: "away: place-bound" };
  return null;
}

// ------------------------------------------------------------------ search cadence follows engagement (Royce, 2026-10-14: "Quiet member
// tapers daily to every few days to weekly, with instant resume on any reply. Same guardrail as your silence pacing, applied to search
// cost"). The one timer the floor's search may follow, a deliberate exception to "no timer may gate whether a member's goals get searched":
// it reads only their own silence (their last message to Co, any channel, a timestamp), never anything Co sent, and it only spaces the
// searches out: weekly is the floor, never none. A week is the unit (Royce, 2026-10-14: "Taper starts at 7 days of silence, not 8"):
// wrote within the last 6 days, daily; quiet 7 to 14 days, every 3 days; quiet over 14 days, weekly. A message from them since the last
// search means the next run searches everything. The hourly ask sweep follows the same cadence per ask (jobs/index.ts).
export const SEARCH_TAPER = { dailyUpToDays: 6, everyFewUpToDays: 14, everyFewDays: 3, weeklyDays: 7 } as const;
// Pure: whether today's floor searches, and if not, why and when it next does. The inputs are the member's own last message and the
// floor's own last search: nothing Co sends is an input.
export function searchCadence(o: { now: Date; zone: string | null; lastInboundAt: Date | null; lastSearchAt: Date | null }): { search: boolean; quietDays: number | null; everyDays: number; next: string | null; why: string } {
  const z = hoursZone(o.zone);
  const day = (d: Date) => DateTime.fromJSDate(d).setZone(z).startOf("day");
  const today = day(o.now);
  const quietDays = o.lastInboundAt ? Math.floor(today.diff(day(o.lastInboundAt), "days").days) : null;
  const everyDays = quietDays === null || quietDays <= SEARCH_TAPER.dailyUpToDays ? 1 : quietDays <= SEARCH_TAPER.everyFewUpToDays ? SEARCH_TAPER.everyFewDays : SEARCH_TAPER.weeklyDays;
  if (!o.lastSearchAt) return { search: true, quietDays, everyDays, next: null, why: "no search on record" };
  if (o.lastInboundAt && o.lastInboundAt.getTime() > o.lastSearchAt.getTime()) return { search: true, quietDays, everyDays, next: null, why: "they wrote since the last search" };
  const since = Math.floor(today.diff(day(o.lastSearchAt), "days").days);
  if (since >= everyDays) return { search: true, quietDays, everyDays, next: null, why: everyDays === 1 ? "engaged: daily" : `quiet ${quietDays} days: every ${everyDays} days` };
  const next = day(o.lastSearchAt).plus({ days: everyDays }).toISODate()!;
  return { search: false, quietDays, everyDays, next, why: `tapered: quiet ${quietDays} days, next search ${next}` };
}

// ------------------------------------------------------------------ while tapered, nothing is lost (Royce, 2026-10-14: "The taper only
// slows searching. It never deletes goals, plans, or finds. Anything found while tapered is held and surfaces on resume ... Instant
// resume: any reply or activity from the member restores full daily searching on the very next run"). Tapered: their own silence puts
// their search cadence past daily (quiet more than SEARCH_TAPER.dailyUpToDays days). While tapered:
//   - the floor searches on its tapered days and holds what it finds in the backlog: no picker run, no send, no goal plan written;
//   - no picker run at all (sweepShadow.ts holdWhileQuiet): no aging tick, no fit-only exit, no reject exit; only a find whose date has
//     passed leaves, logged "passed while quiet";
//   - the hourly goal sweep holds their goals (no recheck idling, no lifecycle, no ask retiring: goalSweep.ts);
//   - an ask with no time frame doesn't expire on its 30 days (askExpiry.ts); one whose named time passed does, "passed while quiet";
//   - a queued find whose send window ended goes back to the backlog, not out (eventSurfacingSweep.ts onEventOfferDropped).
// Engaged members (quiet 6 days or less) go through none of it.
// Pure: tapered, from their own last message only.
export function quietTapered(o: { now: Date; zone: string | null; lastInboundAt: Date | null }): boolean {
  if (!o.lastInboundAt) return false;
  const z = hoursZone(o.zone);
  const quietDays = Math.floor(DateTime.fromJSDate(o.now).setZone(z).startOf("day").diff(DateTime.fromJSDate(o.lastInboundAt).setZone(z).startOf("day"), "days").days);
  return quietDays > SEARCH_TAPER.dailyUpToDays;
}
// Their silence now, read from their record: "quiet" (tapered), "engaged", or "unknown" when the read failed. Callers that would delete
// something treat unknown as quiet (holding loses nothing, an exit can't be undone); nothing ever logs unknown as tapered.
export type Silence = "quiet" | "engaged" | "unknown";
export async function memberSilence(userId: string, now = new Date()): Promise<Silence> {
  try {
    const [{ lastInboundAt }, zone] = await Promise.all([import("../harness/proactive.js"), memberZone(userId).catch(() => null)]);
    return quietTapered({ now, zone, lastInboundAt: await lastInboundAt(userId) }) ? "quiet" : "engaged";
  } catch {
    return "unknown";
  }
}
// For the deletions: quiet, or a read that failed. Never used to decide a send.
export async function memberTapered(userId: string, now = new Date()): Promise<boolean> {
  return (await memberSilence(userId, now)) !== "engaged";
}
// Pure: whether today's floor is done. A quiet day's record (tapered, or a search whose finds were held) no longer counts once they've
// written since it: the next hourly tick runs today's floor in full (instant resume, the same day).
export function floorDoneToday(earlier: { action: string; created_at: Date | string; proposal?: any }[], lastInboundAt: Date | null): boolean {
  return earlier.some((e) => {
    if (e.action === "error") return false;
    const quiet = e.action === "tapered" || e.proposal?.heldQuiet === true;
    return !(quiet && lastInboundAt && lastInboundAt.getTime() > new Date(String(e.created_at)).getTime());
  });
}

let floorRunning = false;
export async function runDailySweepAll(run: <T>(items: T[], limit: number, fn: (i: T) => Promise<void>) => Promise<void>, now = new Date()): Promise<void> {
  // Never overlaps itself: a run still going when the next tick comes keeps going, and the tick says so.
  if (floorRunning) {
    console.log("Daily sweep: the previous run is still going; this tick is skipped (its members are picked up next hour)");
    return;
  }
  floorRunning = true;
  try {
    const { rows } = await pool.query(MEMBERS_SQL);
    await run(rows, DAILY_SWEEP_CONCURRENCY, async (row: any) => {
      // (each member's run)
      await runDailySweep(row, now).catch(async (err: any) => {
        // Anything that escaped the member's run is that member's failed day (their day, not Pacific's), retried on a later hour.
        console.error(`Daily sweep failed for ${row.user_id}:`, err?.message ?? err);
        const zone = await memberZone(String(row.user_id)).catch(() => null);
        await recordDecision({ layer: 5, decision: "sweep.daily", userId: row.user_id, outcome: "skip", action: "error", reason: `the run failed: ${String(err?.message ?? err).slice(0, 300)}`, proposal: { day: dailySweepWindow(now, zone).day, items: [] } });
      });
    });
  } finally {
    floorRunning = false;
  }
}

// No recap text, ever (Royce, 2026-10-13: "Don't ever send a recap"). What the floor found goes to the members themselves (sendMorningFinds);
// the numbers stay in the decision log and on the team-only co-test /sweeps dashboard.

export async function runDailySweep(row: any, now = new Date()): Promise<void> {
  const userId = String(row.user_id);
  const zone = await memberZone(userId);
  const { day, phase } = dailySweepWindow(now, zone);
  if (phase === "before") return; // not 9am for them yet: nothing is decided
  const { rows: earlier } = await pool.query(
    `SELECT action, proposal, created_at FROM harness_decisions WHERE decision = 'sweep.daily' AND user_id = $1 AND proposal->>'day' = $2 AND COALESCE(proposal->>'trigger', '') <> 'manual' ORDER BY created_at`,
    [userId, day],
  );
  // Their last message (any channel): the taper's one input, and what lets a quiet day's record give way to a same-day full run.
  const { lastInboundAt } = await import("../harness/proactive.js");
  const inboundAt = await lastInboundAt(userId);
  if (floorDoneToday(earlier, inboundAt)) return; // today's run is done and logged (an on-demand run never counts as it)
  const errorsToday = earlier.filter((e: any) => e.action === "error").length;
  if (errorsToday >= DAILY_SWEEP_ERRORS_PER_DAY) return; // the day's failed runs are logged; the retry cap is reached
  const base = { day, zone: hoursZone(zone) };

  if (phase === "after") {
    await writeDaily(userId, "skip", "missed", `waking hours ended (${REASONABLE_HOUR_END}:00 their time) before today's sweep ran${errorsToday ? `; ${errorsToday} earlier run(s) today failed` : ""}`, { ...base, items: [] });
    return;
  }
  if (row.opted_out) {
    await writeDaily(userId, "skip", "opted_out", "they opted out of texts, so nothing is searched for them", { ...base, items: [] });
    return;
  }
  // Search cadence follows their engagement (searchCadence): a tapered day is said, never silent, and searches nothing.
  const [lastSearch] = (await pool.query(
    `SELECT MAX(created_at) AS at FROM harness_decisions WHERE decision = 'sweep.daily' AND user_id = $1 AND outcome = 'act' AND COALESCE(proposal->>'trigger', '') <> 'manual'`,
    [userId],
  )).rows;
  const cadence = searchCadence({ now, zone, lastInboundAt: inboundAt, lastSearchAt: lastSearch?.at ? new Date(lastSearch.at) : null });
  if (!cadence.search) {
    await writeDaily(userId, "skip", "tapered", cadence.why, { ...base, items: [], taper: { quietDays: cadence.quietDays, everyDays: cadence.everyDays, next: cadence.next } });
    return;
  }
  // The hourly ask sweep is on them right now: next hour (nothing decided yet, so nothing to log).
  if (!claimMember(userId)) return;
  try {
    // A tapered search day (they're still quiet, and it's the day the cadence searches): what it finds is held, nothing else changes.
    await sweepMember(row, userId, now, base, earlier, errorsToday, { quiet: quietTapered({ now, zone, lastInboundAt: inboundAt }) });
  } finally {
    releaseMember(userId);
  }
}

// An on-demand run (Royce, 2026-10-13: "Every run self-reports, no exceptions for manual ones"): the same search, pick and send as the
// 9am run, for one member, now (scripts/sweepNow.ts). Every outcome writes its summary line (sweep.daily, trigger "manual"), the runs
// that don't happen too; the dashboard shows them beside the day's 9am run, and they never count as it (the floor still runs that day).
// At most one morning text goes out a day, whatever ran the sweep (sendMorningFinds).
export async function runDailySweepNow(userId: string, now = new Date()): Promise<{ ran: boolean; why: string }> {
  const { rows } = await pool.query(`${MEMBERS_SQL} AND u.id = $1`, [userId]);
  const row = rows[0];
  const zone = await memberZone(userId).catch(() => null);
  const base = { day: dailySweepWindow(now, zone).day, zone: hoursZone(zone), trigger: "manual" as const };
  const skip = async (action: string, why: string) => {
    await writeDaily(userId, "skip", action, why, { ...base, items: [] });
    return { ran: false, why };
  };
  if (!row) return skip("not_member", "not a live member (archived, no phone, or not through the door)");
  if (row.opted_out) return skip("opted_out", "they opted out of texts, so nothing is searched for them");
  if (!claimMember(userId)) return skip("busy", "another sweep is on them right now; try again in a few minutes");
  try {
    await sweepMember(row, userId, now, base, [], 0);
  } catch (err: any) {
    await recordDecision({ layer: 5, decision: "sweep.daily", userId, outcome: "skip", action: "error", reason: `the on-demand run failed: ${String(err?.message ?? err).slice(0, 300)}`, proposal: { ...base, items: [] } });
    return { ran: false, why: `failed: ${String(err?.message ?? err).slice(0, 200)}` };
  } finally {
    releaseMember(userId);
  }
  return { ran: true, why: "ran; its summary is on the dashboard" };
}

// quiet: a tapered search day (runDailySweep): the goal plan isn't written, and what's found waits in the backlog (no picker, no send).
export async function sweepMember(row: any, userId: string, now: Date, base: { day: string; zone: string; trigger?: "manual" }, earlier: any[], errorsToday: number, o: { quiet?: boolean } = {}): Promise<void> {
  const E = await import("./eventSurfacingSweep.js");
  const { sweepHold } = await import("../harness/proactive.js");
  const { goalTexts } = await import("./goalJourney.js");
  const { goalHash, edgeSearchText, goalStates } = await import("./goalEdges.js");
  const picker = await E.pickerDecides(userId).catch(() => false);
  const done = searchedEarlierToday(earlier);
  const retried = incompleteEarlierToday(earlier);
  const items: ItemResult[] = [];
  const goals = goalTexts(row.intent, row.goals);
  const AS = await import("./askSplit.js");
  const search = async (b: { kind: "ask" | "goal"; id: string; text: string; searchedPart?: string }, cand: Omit<import("./eventSurfacingSweep.js").SurfacingCandidate, "onReport" | "allSources">) => {
    let rep: import("./eventSurfacingSweep.js").SurfacingReport | null = null;
    try {
      await E.attemptEventSurfacing({ ...cand, allSources: true, onReport: (x) => { rep = x; } });
    } catch (err: any) {
      items.push({ ...b, status: "error", why: `the search failed: ${String(err?.message ?? err).slice(0, 200)}` });
      return;
    }
    const r = rep as import("./eventSurfacingSweep.js").SurfacingReport | null;
    if (searchFailed(r)) {
      items.push({ ...b, status: "error", why: `it looked nowhere: ${(r?.sources.failures ?? ["the search returned without a report"]).join(" | ").slice(0, 300)}`, ...(r ? { failures: r.sources.failures } : {}) });
      return;
    }
    items.push(mergeRetried(searchedItem(b, r!), retried.get(`${b.kind}:${b.id}`)));
  };

  // ---- asks: every open one; find asks in all three places
  const { rows: asks } = await pool.query(
    `SELECT ac.id, ac.ask_text, ac.kind, ac.split_read, ac.created_at
       FROM ask_checkins ac WHERE ac.user_id = $1 AND ac.resolved_at IS NULL ORDER BY COALESCE(ac.last_mentioned_at, ac.created_at) DESC`,
    [userId],
  );
  const askHold = asks.length ? await sweepHold(userId, "ask", now).catch(() => ["their send gates couldn't be read"]) : [];
  for (const a of asks) {
    const b = { kind: "ask" as const, id: String(a.id), text: String(a.ask_text ?? "").slice(0, 160) };
    const prior = done.get(`ask:${b.id}`);
    if (prior) { items.push(prior); continue; } // searched in an earlier run today: carried, not searched again
    if (askHold.length) { items.push({ ...b, status: "skipped", why: `held: ${askHold.join(", ")}` }); continue; }
    if (a.kind === "person") { items.push({ ...b, status: "skipped", why: "a person to meet is met by an introduction (the hourly sweep), not a search" }); continue; }
    if (a.kind !== "find") { items.push({ ...b, status: "skipped", why: `not something to search for (kind: ${a.kind ?? "unclassified"})` }); continue; }
    // Closed while this run was working through their asks: never searched.
    const [still] = (await pool.query(`SELECT resolved_at, closed_reason FROM ask_checkins WHERE id = $1`, [a.id])).rows;
    if (still?.resolved_at) { items.push({ ...b, status: "skipped", why: `closed mid-run (${still.closed_reason ?? "closed"})` }); continue; }
    // Co's own work (services/askSplit.ts, Royce 2026-10-13): followed as its task, never searched; a mixed one is searched for its find
    // part only; a split read that fails searches it whole, as before. Its kind is never changed.
    let askText = String(a.ask_text ?? "");
    if (AS.isOwnWork(askText)) {
      // One read per ask text, kept on the ask (askSplit.ts askSearchPlan), shared with the hourly sweep.
      const { read, taskId } = await AS.askSearchPlan(userId, a);
      const plan = planAsk(b, askText, read, taskId != null ? { id: taskId } : null, AS.floorPlan);
      // Own work with no task, or a mixed request's work part with no task: listed for the team once a day.
      if (plan.plan.note) await AS.notePlan(plan.plan, { id: b.id, user_id: userId, ask_text: askText }, { taskId, day: base.day, sweep: "daily" }).catch(() => {});
      if (plan.item) { items.push(plan.item); continue; }
      if (plan.search && plan.search !== askText) {
        askText = plan.search;
        await recordDecision({ layer: 5, decision: "ask.split", userId, outcome: "act", action: "floor_find_part", reason: "a mixed request on file: only its find part is searched", proposal: { askId: b.id, ask: b.text, work: read?.split?.work ?? null, find: askText, findIsLookout: read?.split?.findIsLookout ?? false } }).catch(() => {});
      }
    }
    const searchB = askText === String(a.ask_text ?? "") ? b : { ...b, searchedPart: askText.slice(0, 160) };
    await search(searchB, { askId: String(a.id), userId, firstName: row.first_name, phoneNumber: row.phone_number, askText, city: row.city ?? null, goals: goals.length ? goals : null, activityPreferences: row.activity_preferences ?? null, cooldownCleared: true, want: { key: `ask:${a.id}`, text: String(a.ask_text ?? ""), createdAt: a.created_at ? new Date(a.created_at) : null } });
  }

  // ---- goals: each one their current plan holds, on its own, in all three places (floorGoalPlan: reused while their goals are the
  // same, built now when they changed, there's none, or it's past the backstop)
  const fp = goals.length || row.long_term_direction ? await floorGoalPlan(row, now, undefined, { quiet: !!o.quiet }) : null;
  const goalNote = fp?.note ?? null;
  const planned = fp?.plan ? goalItemsFromPlan(fp.plan, (e) => edgeSearchText([e])) : [];
  // No plan could be had (the build failed and there was none before): each goal is a failed item, never a quiet skip, so the day is
  // retried on a later hour.
  if (fp && !fp.plan && fp.failed) {
    if (fp.live.length) for (const g of fp.live) items.push({ kind: "goal", id: goalHash(g), text: g.slice(0, 160), status: "error", why: fp.failed });
    else items.push({ kind: "goal", id: "goals", text: "their goals", status: "error", why: fp.failed });
  }
  // Searched from an old plan because the rebuild failed: the goals it doesn't hold are failed items, retried.
  for (const g of fp?.uncovered ?? []) items.push({ kind: "goal", id: goalHash(g), text: g.slice(0, 160), status: "error", why: `${fp?.note ?? "the plan build failed"}; this goal isn't in that plan` });
  // Only what isn't a send-set timer holds the goal search (proactive.ts SWEEP_BLOCKERS.floor_goal): a weekly cap or an unanswered pause
  // gates the send, and the finds wait in the pool for it.
  // A gate that can't be read is an error, retried, never a quiet skip (review of the tier PR).
  let gateError: string | null = null;
  const goalHold = planned.some((g) => g.search) ? await sweepHold(userId, "floor_goal", now).catch((err: any) => { gateError = `their send gates couldn't be read: ${String(err?.message ?? err).slice(0, 120)}`; return [] as string[]; }) : [];
  // A goal set aside since the plan was made (the goal recheck's idle, services/goalRecheck.ts, or done) isn't searched off that plan.
  let statesError: string | null = null;
  const states = planned.some((g) => g.search) ? await goalStates(userId).catch((err: any) => { statesError = String(err?.message ?? err).slice(0, 120); return null; }) : new Map();
  for (const g of planned) {
    const b = { kind: "goal" as const, id: goalHash(g.goal), text: g.goal.slice(0, 160) };
    const prior = done.get(`goal:${b.id}`);
    if (prior) { items.push(prior); continue; }
    const decide = floorGoalDecision(g, { states, statesError, gateError, hold: goalHold, goalId: b.id });
    if (decide) { items.push({ ...b, ...decide }); continue; }
    // cooldownCleared is only logged by the search; the floor never reads the goal cooldown, so it's always clear here.
    await search(b, { askId: E.PROFILE_ASK_ID, userId, firstName: row.first_name, phoneNumber: row.phone_number, askText: g.search ?? "", fromProfile: true, city: row.city ?? null, goals: goals.length ? goals : null, activityPreferences: row.activity_preferences ?? null, cooldownCleared: true, want: { key: `goal:${b.id}`, text: g.goal, createdAt: goalRecordedAt(row.intent, g.goal) }, ...(typeof g.placeBound === "boolean" ? { placeBound: g.placeBound } : {}) });
  }

  const { action, totals } = dailySummary(items);
  const proposal = { ...base, items, totals, picker, ...(o.quiet ? { heldQuiet: true, note: "tapered search day: what was found is held for when they write" } : {}), ...(fp ? { goalPlan: { how: fp.how, why: fp.why } } : {}), ...(goalNote ? { goalNote } : {}), ...(asks.length || planned.length || goals.length ? {} : { note: "no open asks and no active goals: nothing to search" }) };
  // An incomplete item (a place failed or timed out) gets the day retried while retries remain (incompleteRetry), the same way as an error.
  const retryIncomplete = incompleteRetry(items, errorsToday, base.trigger === "manual");
  const incompleteLines = items.filter((i) => i.status === "incomplete").map((i) => `${i.kind} "${i.text.slice(0, 60)}" incomplete: ${i.why}`);
  const failed = [...items.filter((i) => i.status === "error").map((i) => `${i.kind} "${i.text.slice(0, 60)}": ${i.why}`), ...(retryIncomplete === "retry" ? incompleteLines : [])];
  // Searched in part counts here: what it found is in the pool.
  const searchedAny = totals.asksSearched + totals.goalsSearched + totals.incomplete > 0;
  if (failed.length) {
    const last = errorsToday + 1 >= DAILY_SWEEP_ERRORS_PER_DAY;
    await writeDaily(userId, "skip", "error", `${failed.join(" | ").slice(0, 800)}${last ? " (the day's last retry: no more runs today)" : " (run again next hour)"}`, proposal);
    // What did get searched is in the pool: the picker still runs for it.
    if (searchedAny && !o.quiet) await sendMorningFinds(userId, base.day);
    return;
  }
  const stillIncomplete = retryIncomplete === "last" ? `still incomplete${base.trigger === "manual" ? "" : " after the day's retries"}: ${incompleteLines.join(" | ")}`.slice(0, 600) : null;
  await writeDaily(userId, searchedAny ? "act" : "skip", action, searchedAny ? [goalNote, stillIncomplete].filter(Boolean).join("; ") || null : [(proposal as any).note, goalNote].filter(Boolean).join("; ") || "nothing searched; each item says why", proposal);
  // The sweep discovers, the picker decides (sweepShadow.ts runPickerAfterSweep): right after, for what this run put in the pool.
  // While quiet, what was found is held in the backlog: it competes in the first full morning after they write (never dumped at once).
  if (searchedAny && !o.quiet) await sendMorningFinds(userId, base.day);
}

// The morning's finds go to them now (Royce, 2026-10-13: the 9am sweep "should be what it found ... in this order link then description";
// "Members get their finds"). The picker chooses (runPickerAfterSweep), what it chose that's still waiting is marked as today's morning
// finds (payload.morningDay: harness/proactive.ts morningFind skips the pacing for them, that day only), and the send step runs for
// them right away: each find's link, then its description. Hours, opt-out, mid-conversation and the safety checks still hold; a find
// they hold for goes out at the next send run that day. Failures here are logged, never thrown into the floor.
// Silence is information (Royce, 2026-10-13: "A club that keeps texting a silent member reads desperate. Keep it gentle: two ignored
// mornings, drop to every other day. A week silent, pause morning finds until they reply to anything. Any reply resets to daily."):
// counted from their last reply (any text, or a call where they spoke), over the morning texts sent since. A paced morning still
// searches and picks; what it picked waits under the normal pacing. Only the morning text slows.
export const MORNING_PACE = { everyOtherDayAfter: 2, pauseAfterDays: 7 } as const;
// Pure: may this morning's finds go out, and if not, why.
export function morningPace(o: { now: Date; zone: string | null; lastReplyAt: Date | null; morningSends: Date[] }): { send: boolean; why: string | null } {
  const z = hoursZone(o.zone);
  const dayOf = (d: Date) => DateTime.fromJSDate(d).setZone(z).toISODate()!;
  const today = dayOf(o.now);
  const unanswered = o.morningSends.filter((d) => (!o.lastReplyAt || d.getTime() > o.lastReplyAt.getTime()) && dayOf(d) !== today).sort((a, b) => a.getTime() - b.getTime());
  const days = [...new Set(unanswered.map(dayOf))];
  if (!days.length) return { send: true, why: null };
  // Counted in their calendar days: the 9am run seven days after the first unanswered morning is a week.
  const silentDays = DateTime.fromISO(today, { zone: z }).diff(DateTime.fromISO(days[0], { zone: z }), "days").days;
  if (silentDays >= MORNING_PACE.pauseAfterDays) return { send: false, why: `paused: no reply in a week of morning texts (first unanswered ${days[0]}); resumes when they reply to anything` };
  const yesterday = DateTime.fromISO(today, { zone: z }).minus({ days: 1 }).toISODate();
  if (days.length >= MORNING_PACE.everyOtherDayAfter && days[days.length - 1] === yesterday) return { send: false, why: `every other day: ${days.length} morning texts unanswered (last ${yesterday}); next morning tomorrow` };
  return { send: true, why: null };
}

async function sendMorningFinds(userId: string, day: string): Promise<void> {
  // Only what this run's picker queues becomes a morning find (review, 2026-10-13: a retry later in the day must not turn other sweeps'
  // picks into unpaced texts); a pick already waiting from earlier keeps the normal pacing.
  const [{ t0 }] = (await pool.query(`SELECT NOW() AS t0`)).rows;
  await import("./sweepShadow.js").then((S) => S.runPickerAfterSweep(userId, "daily"));
  // Their silence sets the pace (morningPace), read BEFORE anything is marked, so a send run can't slip a paced morning out. Every
  // morning text since their last reply counts, however long ago: a paused member stays paused until they reply (review, 2026-10-13).
  let pace: { send: boolean; why: string | null };
  try {
    const [{ at: lastReplyAt }] = (await pool.query(
      `SELECT MAX(created_at) AS at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User %' OR content LIKE '[Call]%')`,
      [userId],
    )).rows;
    const { rows: sentMornings } = await pool.query(
      `SELECT COALESCE(decided_at, updated_at) AS at FROM proactive_candidates
        WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND payload ? 'morningDay' AND COALESCE(decided_at, updated_at) > COALESCE($2::timestamptz, '-infinity'::timestamptz)`,
      [userId, lastReplyAt ?? null],
    );
    pace = morningPace({ now: new Date(), zone: await memberZone(userId), lastReplyAt: lastReplyAt ? new Date(lastReplyAt) : null, morningSends: sentMornings.map((r: any) => new Date(r.at)) });
  } catch (err: any) {
    // Can't tell how they've been answering: no morning text today (their picks wait under the normal pacing), and it's said.
    console.error(`Daily sweep: reading the morning pace failed for ${userId} (non-fatal):`, err?.message ?? err);
    await recordDecision({ layer: 7, decision: "sweep.morning_finds", userId, outcome: "skip", action: "error", reason: `the pace couldn't be read: ${String(err?.message ?? err).slice(0, 200)}`, proposal: { day } });
    return;
  }
  if (!pace.send) {
    await recordDecision({ layer: 7, decision: "sweep.morning_finds", userId, outcome: "skip", action: "paced", reason: pace.why, proposal: { day } });
    return;
  }
  // One morning text a day, whatever ran the sweep (the 9am floor, a retry, an on-demand run): once one has gone out today, what's
  // picked now waits under the normal pacing (review, 2026-10-13).
  const [{ n: sentToday }] = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND payload->>'morningDay' = $2`,
    [userId, day],
  )).rows;
  if (Number(sentToday) > 0) {
    await recordDecision({ layer: 7, decision: "sweep.morning_finds", userId, outcome: "skip", action: "already_sent_today", reason: "a morning text already went out today; what's picked now waits under the normal pacing", proposal: { day } });
    return;
  }
  const { rowCount } = await pool.query(
    `UPDATE proactive_candidates SET payload = payload || jsonb_build_object('morningDay', $2::text), updated_at = NOW()
      WHERE user_id = $1 AND type = 'event_offer' AND status = 'pending' AND payload->>'picked' = 'true'
        AND (created_at >= $3 OR (payload->>'pickedAt')::timestamptz >= $3)`,
    [userId, day, t0],
  );
  if (!rowCount) return;
  try {
    const [P, R] = await Promise.all([import("../harness/proactive.js"), import("../harness/proactiveRegistry.js")]);
    await P.dispatchForUser(R.proactiveRegistry, userId);
  } catch (err: any) {
    console.error(`Daily sweep: sending the morning finds failed for ${userId} (non-fatal, the next send run tries again):`, err?.message ?? err);
    await recordDecision({ layer: 7, decision: "sweep.morning_finds", userId, outcome: "skip", action: "error", reason: String(err?.message ?? err).slice(0, 300), proposal: { day, finds: rowCount } });
  }
}

// ------------------------------------------------------------------ the rollup (Royce, 2026-10-13: "Make the summary line visible to
// you, not just the log ... That's how you catch a silent day in November without reading Railway logs at 9pm"). Team only: the
// co-test dashboard's /sweeps page reads it (co-test/src/routes/sweeps.ts). One row per member per day: ran or not, and why.
export type RollupRow = {
  day: string;
  userId: string;
  name: string;
  status: "ran" | "nothing to search" | "error" | "missed" | "opted out" | "not yet" | "silent" | "tapered";
  detail: string;
  asksSearched: number;
  goalsSearched: number;
  kept: number;
  queued: number;
  sends: number;
  // 2026-10-28 (Royce: the sweep failed five days running and this morning's quiet drops never showed): asks and goals left incomplete
  // (a place failed or timed out) or failed, and web results dropped for not proving themselves on their page, in the day's last run.
  incomplete: number;
  failed: number;
  // Places down in a way a retry won't fix (review of #293): shown, never retried.
  placesDown: number;
  unverified: number;
  // Per tier, from the day's last run (Royce, 2026-10-28: to see whether filing finds by kind of page brings better finds).
  tiers: TierCounts;
};

// Pure: a member's day, from its sweep.daily records (oldest first), its find sends, and whether 9pm has passed for them.
export function rollupDay(all: { outcome: string; action: string; reason: string | null; proposal: any }[], sends: number, dayOver: boolean, started: boolean): Pick<RollupRow, "status" | "detail" | "asksSearched" | "goalsSearched" | "kept" | "queued" | "sends" | "incomplete" | "failed" | "placesDown" | "unverified" | "tiers"> {
  // On-demand runs report themselves too, beside the 9am run, never as it.
  const manual = all.filter((r) => r.proposal?.trigger === "manual");
  const records = all.filter((r) => r.proposal?.trigger !== "manual");
  const out = rollupFloorDay(records, sends, dayOver, started);
  return manual.length ? { ...out, detail: `${out.detail} · on-demand runs: ${manual.length} (last: ${manual[manual.length - 1].action})` } : out;
}
function rollupFloorDay(records: { outcome: string; action: string; reason: string | null; proposal: any }[], sends: number, dayOver: boolean, started: boolean): Pick<RollupRow, "status" | "detail" | "asksSearched" | "goalsSearched" | "kept" | "queued" | "sends" | "incomplete" | "failed" | "placesDown" | "unverified" | "tiers"> {
  const final = [...records].reverse().find((r) => r.action !== "error");
  const errors = records.filter((r) => r.action === "error");
  const t = (final?.proposal?.totals ?? {}) as Record<string, number>;
  // Incomplete, failed and unverified come from the day's last run, a failed one too (a day of failed runs shows what the last one hit).
  const lastT = (records[records.length - 1]?.proposal?.totals ?? {}) as Record<string, number>;
  const counts = { asksSearched: t.asksSearched ?? 0, goalsSearched: t.goalsSearched ?? 0, kept: t.kept ?? 0, queued: t.queued ?? 0, sends, incomplete: lastT.incomplete ?? 0, failed: lastT.errors ?? 0, placesDown: lastT.placesDown ?? 0, unverified: lastT.unverified ?? 0, tiers: sumTiers([(records[records.length - 1]?.proposal?.totals ?? {}).tiers]) };
  if (final) {
    const status = final.action === "missed" ? "missed" : final.action === "opted_out" ? "opted out" : final.action === "tapered" ? "tapered" : final.outcome === "act" ? "ran" : "nothing to search";
    return { status, detail: final.reason ?? final.action, ...counts };
  }
  if (errors.length) return { status: "error", detail: `${errors.length} failed run(s): ${errors[errors.length - 1].reason ?? "no reason"}`, ...counts };
  if (!started) return { status: "not yet", detail: "before 9am their time", ...counts };
  return dayOver ? { status: "silent", detail: "no record at all for this day: the sweep never ran for them", ...counts } : { status: "not yet", detail: "9am has passed and it hasn't run yet; it runs at the top of the hour", ...counts };
}

export async function dailySweepRollup(days = 14, now = new Date()): Promise<RollupRow[]> {
  const { rows: members } = await pool.query(`SELECT u.id, u.first_name, u.last_name FROM users u WHERE u.archived_at IS NULL AND u.phone_number IS NOT NULL AND u.phone_number NOT LIKE '%#%' AND u.identity_captured = true AND u.invite_verified = true ORDER BY u.created_at`);
  const { rows: recs } = await pool.query(
    `SELECT user_id, outcome, action, reason, proposal FROM harness_decisions WHERE decision = 'sweep.daily' AND created_at > NOW() - ($1 || ' days')::interval ORDER BY created_at`,
    [String(days + 1)],
  );
  const { rows: sent } = await pool.query(
    `SELECT user_id, COALESCE(decided_at, updated_at) AS at FROM proactive_candidates WHERE type = 'event_offer' AND status = 'sent' AND COALESCE(decided_at, updated_at) > NOW() - ($1 || ' days')::interval`,
    [String(days + 1)],
  );
  // Picker claim checks that couldn't run (services/sweepShadow.ts): counted per member per day on the team list.
  const { rows: checkFails } = await pool.query(
    `SELECT user_id, proposal->>'day' AS day, COUNT(*)::int AS n FROM harness_decisions WHERE decision = 'picker.claim_check_failed' AND created_at > NOW() - ($1 || ' days')::interval GROUP BY 1, 2`,
    [String(days + 1)],
  ).catch(() => ({ rows: [] as any[] }));
  // Days before the first record anywhere are before this existed: not shown as silent.
  const first = recs.map((r: any) => String(r.proposal?.day ?? "")).filter(Boolean).sort()[0] ?? null;
  const out: RollupRow[] = [];
  for (const m of members) {
    const zone = hoursZone(await memberZone(m.id).catch(() => null));
    const local = DateTime.fromJSDate(now).setZone(zone);
    for (let i = 0; i < days; i++) {
      const d = local.minus({ days: i });
      const day = d.toISODate()!;
      if (!first || day < first) continue;
      const mine = recs.filter((r: any) => r.user_id === m.id && r.proposal?.day === day);
      const sends = sent.filter((s: any) => s.user_id === m.id && DateTime.fromJSDate(new Date(s.at)).setZone(zone).toISODate() === day).length;
      const dayOver = i > 0 || local.hour >= REASONABLE_HOUR_END;
      const started = i > 0 || local.hour >= DAILY_SWEEP_HOUR;
      const r = rollupDay(mine, sends, dayOver, started);
      const fails = checkFails.find((f: any) => f.user_id === m.id && f.day === day)?.n ?? 0;
      out.push({ day, userId: m.id, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || "(no name)", ...r, ...(fails ? { detail: `${r.detail} · picker claim checks that couldn't run: ${fails}` } : {}) });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.name.localeCompare(b.name)));
}
