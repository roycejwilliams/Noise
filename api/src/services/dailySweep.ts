// The 9am daily sweep (Royce, 2026-10-13: "Bring back the real 9 am sweep"). A floor under the hourly sweeps:
//   - once per member per day, from 9am their time, inside waking hours (localHours.ts), for every member;
//   - every open find ask searched in all three places (events, web, X; sweepFind.ts SWEEP_SOURCES), leaning to what's new
//     (sweepFind.ts RECENT_HOURS), and each active goal searched on its own, from the goal plan the hourly goal sweep last made
//     (read, never re-planned: planning sets goal states and retires asks, which is the lifecycle this must not touch);
//   - no source selectivity and no empty-streak backoff here; and it leaves the ask lifecycle alone: it never moves an ask's
//     last_attempted_at or its empty-run count (eventSurfacingSweep.ts), so the hourly sweeps run exactly as before, on top;
//   - finds go to the pool (the event backlog), the picker chooses right after (sweepShadow.ts runPickerAfterSweep), and what it chose
//     goes to the member then as their morning finds (sendMorningFinds: each find's link, then its description);
//   - every ask and goal it doesn't search says why, and each run writes one summary line per member (sweep.daily);
//   - a failed run is a failed day: logged as an error and run again on a later hour, at most DAILY_SWEEP_ERRORS_PER_DAY a day.
// Its own cron (jobs/index.ts, :05), never overlapping itself, and a member is claimed while a sweep works on them (claimMember),
// so it and the hourly ask sweep never search one member at the same time.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { hoursZone, REASONABLE_HOUR_END } from "./localHours.js";
import { memberZone } from "./memberTime.js";

export const DAILY_SWEEP_HOUR = 9;
// A failed day is run again on a later hour, at most this many failed runs a day (the picker's rule, sweepShadow.ts PICK_ERRORS_PER_DAY).
export const DAILY_SWEEP_ERRORS_PER_DAY = 3;
export const DAILY_SWEEP_CONCURRENCY = 3;
// The goal plan the floor reads: the hourly goal sweep's latest, if it's this recent.
export const GOAL_PLAN_MAX_AGE_DAYS = 3;

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
  status: "searched" | "skipped" | "error";
  why?: string;
  sources?: { events: boolean; web: boolean; x: boolean };
  failures?: string[];
  found?: number;
  pooled?: number;
  queued?: number;
  outcome?: string;
  earlierRun?: boolean;
};

// Pure: the day's one summary line, from what each ask and goal did.
export function dailySummary(items: ItemResult[]): { action: string; totals: { asksSearched: number; goalsSearched: number; skipped: number; errors: number; sources: { events: number; web: number; x: number }; kept: number; pooled: number; queued: number } } {
  const searched = items.filter((i) => i.status === "searched");
  const sources = { events: 0, web: 0, x: 0 };
  for (const i of searched) for (const s of ["events", "web", "x"] as const) if (i.sources?.[s]) sources[s]++;
  const totals = {
    asksSearched: searched.filter((i) => i.kind === "ask").length,
    goalsSearched: searched.filter((i) => i.kind === "goal").length,
    skipped: items.filter((i) => i.status === "skipped").length,
    errors: items.filter((i) => i.status === "error").length,
    sources,
    kept: searched.reduce((n, i) => n + (i.found ?? 0), 0),
    pooled: searched.reduce((n, i) => n + (i.pooled ?? 0), 0),
    queued: searched.reduce((n, i) => n + (i.queued ?? 0), 0),
  };
  const action = `asks searched ${totals.asksSearched}, goals searched ${totals.goalsSearched}, sources events ${sources.events}/web ${sources.web}/x ${sources.x}, finds kept ${totals.kept}, new in the pool ${totals.pooled}, queued ${totals.queued}${totals.skipped ? `, skipped ${totals.skipped}` : ""}${totals.errors ? `, errors ${totals.errors}` : ""}`;
  return { action, totals };
}

// Pure: what an earlier failed run today already searched, by item (a retry carries them into its summary instead of searching again).
export function searchedEarlierToday(earlier: { proposal: any }[]): Map<string, ItemResult> {
  const done = new Map<string, ItemResult>();
  for (const e of earlier) for (const i of (e.proposal?.items ?? []) as ItemResult[]) if (i.status === "searched") done.set(`${i.kind}:${i.id}`, { ...i, earlierRun: true });
  return done;
}

// Pure: a search that looked nowhere failed (the loop threw, their record couldn't be read, or every place failed): an error, so the
// day is retried, never a quiet "searched".
export function searchFailed(rep: { sources: { events: boolean; web: boolean; x: boolean } } | null): boolean {
  return !rep || (!rep.sources.events && !rep.sources.web && !rep.sources.x);
}

// Pure: what the floor searches for each goal, from the hourly goal sweep's latest plan (goal_sweep.plan): each active goal's
// findable edges, on their own (not mixed with another goal's or what they enjoy), and each goal the plan passed or set aside, with why.
export function goalItemsFromPlan(plan: any, searchText: (edge: any) => string | null): { goal: string; search: string | null; why: string | null }[] {
  const out: { goal: string; search: string | null; why: string | null }[] = [];
  for (const e of Array.isArray(plan?.edges) ? plan.edges : []) {
    const s = searchText(e);
    out.push({ goal: String(e.goal ?? ""), search: s, why: s ? null : "its plan has nothing findable to search" });
  }
  for (const p of Array.isArray(plan?.passed) ? plan.passed : []) out.push({ goal: String(p.goal ?? ""), search: null, why: `nothing findable to search: ${String(p.why ?? "").slice(0, 160)}` });
  for (const a of Array.isArray(plan?.setAside) ? plan.setAside : []) out.push({ goal: String(a.goal ?? ""), search: null, why: `set aside (${a.state ?? "not active"}): ${String(a.reason ?? "").slice(0, 160)}` });
  return out.filter((g) => g.goal);
}

const MEMBERS_SQL = `SELECT u.id AS user_id, u.first_name, u.phone_number, COALESCE(u.sms_opted_out, false) AS opted_out,
        cp.city, cp.goals, cp.intent, cp.activity_preferences,
        (pss.last_surfaced_at IS NULL OR pss.last_surfaced_at <= NOW() - INTERVAL '3 days') AS cooldown_cleared
   FROM users u
   LEFT JOIN co_profiles cp ON cp.user_id = u.id
   LEFT JOIN profile_surfacing_state pss ON pss.user_id = u.id
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
    `SELECT action, proposal FROM harness_decisions WHERE decision = 'sweep.daily' AND user_id = $1 AND proposal->>'day' = $2 ORDER BY created_at`,
    [userId, day],
  );
  if (earlier.some((e: any) => e.action !== "error")) return; // today's run is done and logged
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
  // The hourly ask sweep is on them right now: next hour (nothing decided yet, so nothing to log).
  if (!claimMember(userId)) return;
  try {
    await sweepMember(row, userId, now, base, earlier, errorsToday);
  } finally {
    releaseMember(userId);
  }
}

async function sweepMember(row: any, userId: string, now: Date, base: { day: string; zone: string }, earlier: any[], errorsToday: number): Promise<void> {
  const E = await import("./eventSurfacingSweep.js");
  const { sweepHold } = await import("../harness/proactive.js");
  const { goalTexts } = await import("./goalJourney.js");
  const { goalHash, edgeSearchText } = await import("./goalEdges.js");
  const picker = await E.pickerDecides(userId).catch(() => false);
  const done = searchedEarlierToday(earlier);
  const items: ItemResult[] = [];
  const goals = goalTexts(row.intent, row.goals);
  const search = async (b: { kind: "ask" | "goal"; id: string; text: string }, cand: Omit<import("./eventSurfacingSweep.js").SurfacingCandidate, "onReport" | "allSources">) => {
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
    items.push({ ...b, status: "searched", sources: { events: r!.sources.events, web: r!.sources.web, x: r!.sources.x }, failures: r!.sources.failures, found: r!.found, pooled: r!.pooled, queued: r!.queued, outcome: r!.outcome });
  };

  // ---- asks: every open one; find asks in all three places
  const { rows: asks } = await pool.query(
    `SELECT ac.id, ac.ask_text, ac.kind, (ac.last_surfaced_at IS NULL OR ac.last_surfaced_at <= NOW() - INTERVAL '3 days') AS cooldown_cleared
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
    await search(b, { askId: String(a.id), userId, firstName: row.first_name, phoneNumber: row.phone_number, askText: a.ask_text, city: row.city ?? null, goals: goals.length ? goals : null, activityPreferences: row.activity_preferences ?? null, cooldownCleared: a.cooldown_cleared });
  }

  // ---- goals: each one the hourly goal sweep's latest plan holds, on its own, in all three places
  const [plan] = (await pool.query(
    `SELECT proposal, created_at FROM harness_decisions WHERE decision = 'goal_sweep.plan' AND user_id = $1 AND COALESCE(action, '') NOT IN ('read_failed', 'read_cut_off') AND created_at > NOW() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 1`,
    [userId, String(GOAL_PLAN_MAX_AGE_DAYS)],
  )).rows;
  const goalNote = goals.length && !plan ? `they have ${goals.length} goal(s) but no goal plan from the last ${GOAL_PLAN_MAX_AGE_DAYS} days yet (the hourly goal sweep plans them), so no goal was searched` : null;
  const planned = plan ? goalItemsFromPlan(plan.proposal, (e) => edgeSearchText([e])) : [];
  const goalHold = planned.some((g) => g.search) ? await sweepHold(userId, "goal", now).catch(() => ["their send gates couldn't be read"]) : [];
  for (const g of planned) {
    const b = { kind: "goal" as const, id: goalHash(g.goal), text: g.goal.slice(0, 160) };
    const prior = done.get(`goal:${b.id}`);
    if (prior) { items.push(prior); continue; }
    if (!g.search) { items.push({ ...b, status: "skipped", why: g.why ?? "nothing to search" }); continue; }
    if (goalHold.length) { items.push({ ...b, status: "skipped", why: `held: ${goalHold.join(", ")}` }); continue; }
    await search(b, { askId: E.PROFILE_ASK_ID, userId, firstName: row.first_name, phoneNumber: row.phone_number, askText: g.search, fromProfile: true, city: row.city ?? null, goals: goals.length ? goals : null, activityPreferences: row.activity_preferences ?? null, cooldownCleared: row.cooldown_cleared });
  }

  const { action, totals } = dailySummary(items);
  const proposal = { ...base, items, totals, picker, ...(goalNote ? { goalNote } : {}), ...(asks.length || planned.length || goals.length ? {} : { note: "no open asks and no active goals: nothing to search" }) };
  const failed = items.filter((i) => i.status === "error").map((i) => `${i.kind} "${i.text.slice(0, 60)}": ${i.why}`);
  if (failed.length) {
    const last = errorsToday + 1 >= DAILY_SWEEP_ERRORS_PER_DAY;
    await writeDaily(userId, "skip", "error", `${failed.join(" | ").slice(0, 800)}${last ? " (the day's last retry: no more runs today)" : " (run again next hour)"}`, proposal);
    // What did get searched is in the pool: the picker still runs for it.
    if (totals.asksSearched + totals.goalsSearched > 0) await sendMorningFinds(userId, base.day);
    return;
  }
  const searchedAny = totals.asksSearched + totals.goalsSearched > 0;
  await writeDaily(userId, searchedAny ? "act" : "skip", action, searchedAny ? goalNote : [(proposal as any).note, goalNote].filter(Boolean).join("; ") || "nothing searched; each item says why", proposal);
  // The sweep discovers, the picker decides (sweepShadow.ts runPickerAfterSweep): right after, for what this run put in the pool.
  if (searchedAny) await sendMorningFinds(userId, base.day);
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
  status: "ran" | "nothing to search" | "error" | "missed" | "opted out" | "not yet" | "silent";
  detail: string;
  asksSearched: number;
  goalsSearched: number;
  kept: number;
  queued: number;
  sends: number;
};

// Pure: a member's day, from its sweep.daily records (oldest first), its find sends, and whether 9pm has passed for them.
export function rollupDay(records: { outcome: string; action: string; reason: string | null; proposal: any }[], sends: number, dayOver: boolean, started: boolean): Pick<RollupRow, "status" | "detail" | "asksSearched" | "goalsSearched" | "kept" | "queued" | "sends"> {
  const final = [...records].reverse().find((r) => r.action !== "error");
  const errors = records.filter((r) => r.action === "error");
  const t = (final?.proposal?.totals ?? {}) as Record<string, number>;
  const counts = { asksSearched: t.asksSearched ?? 0, goalsSearched: t.goalsSearched ?? 0, kept: t.kept ?? 0, queued: t.queued ?? 0, sends };
  if (final) {
    const status = final.action === "missed" ? "missed" : final.action === "opted_out" ? "opted out" : final.outcome === "act" ? "ran" : "nothing to search";
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
      out.push({ day, userId: m.id, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || "(no name)", ...rollupDay(mine, sends, dayOver, started) });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.name.localeCompare(b.name)));
}
