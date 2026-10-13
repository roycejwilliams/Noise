// The 9am daily sweep (Royce, 2026-10-13: "Bring back the real 9 am sweep"). A floor under the hourly sweeps:
//   - once per member per day, from 9am their time, inside waking hours (localHours.ts), for every member;
//   - every open find ask searched in all three places (events, web, X; sweepFind.ts SWEEP_SOURCES), leaning to what's new
//     (sweepFind.ts RECENT_HOURS), and each active goal searched on its own, from the goal plan the hourly goal sweep last made
//     (read, never re-planned: planning sets goal states and retires asks, which is the lifecycle this must not touch);
//   - no source selectivity and no empty-streak backoff here; and it leaves the ask lifecycle alone: it never moves an ask's
//     last_attempted_at or its empty-run count (eventSurfacingSweep.ts), so the hourly sweeps run exactly as before, on top;
//   - finds go to the pool (the event backlog), and the picker chooses what sends, right after (sweepShadow.ts runPickerAfterSweep;
//     the 10am review account keeps its 10am run). Nothing here picks or sends itself;
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
      // (each member's run; the day's rollup text goes after all of them, below)
      await runDailySweep(row, now).catch(async (err: any) => {
        // Anything that escaped the member's run is that member's failed day (their day, not Pacific's), retried on a later hour.
        console.error(`Daily sweep failed for ${row.user_id}:`, err?.message ?? err);
        const zone = await memberZone(String(row.user_id)).catch(() => null);
        await recordDecision({ layer: 5, decision: "sweep.daily", userId: row.user_id, outcome: "skip", action: "error", reason: `the run failed: ${String(err?.message ?? err).slice(0, 300)}`, proposal: { day: dailySweepWindow(now, zone).day, items: [] } });
      });
    });
    // The day's rollup to Royce once every member's day has a result (sendRollupIfComplete).
    await sendRollupIfComplete(rows, now).catch((err: any) => console.error("Daily sweep: the rollup text failed (non-fatal):", err?.message ?? err));
  } finally {
    floorRunning = false;
  }
}

// ------------------------------------------------------------------ the rollup text (Royce, 2026-10-13: "After the floor completes, send
// one summary to my account: ran or failed, asks searched, finds kept, sends made. Failed day says so. This is how I catch a silent
// day without reading logs."). One text a day, to the morning-report recipient (devReview.ts digestRecipient), once every member whose
// 9am has come has a result for today. Sent as "ops" (services/sendblue.ts sendingAs): kept in the send log, never added to their
// conversation with Co, so Co doesn't read other members' days as something it said to them. No text by mid-morning is itself the
// sign of a silent day.
export type RollupMember = { name: string; phase: "before" | "open" | "after"; final: { action: string; outcome: string; reason: string | null; totals: any } | null; errors: number; lastError: string | null; sends: number; xUsed?: number; xStarved?: boolean; held?: boolean };
// Pure: why a member's day failed, in words that carry nothing of what they asked (the rollup is a text; ask words stay on the dashboard).
export function failureGist(items: ItemResult[]): string {
  const errs = items.filter((i) => i.status === "error");
  if (!errs.length) return "the run failed";
  const kinds = new Set(errs.map((i) => (/looked nowhere/.test(i.why ?? "") ? "every source failed" : /search failed/.test(i.why ?? "") ? "a search threw" : "a search failed")));
  return `${errs.length} search(es) failed: ${[...kinds].join(", ")}`;
}
// Pure: a day where every item was skipped because sends are held (a hold, a pause, opted out of finds).
export function heldDay(items: ItemResult[]): boolean {
  return items.length > 0 && items.every((i) => i.status === "skipped" && /^held:/.test(i.why ?? ""));
}
// X usage (Royce, 2026-10-13: "Add X search usage to the daily rollup (searches used per run, and any member who got no X because the
// budget ran dry, named). We'll set the cap from those numbers"). sweepsUsed: every sweep's X searches in the last 24 hours, against
// what sweeps may use (tieredRecommendation.ts: the daily cap minus what's kept for member requests).
export type XUsage = { sweepsUsed: number; sweepsCap: number; webUsed?: number; webCap?: number; pickerRuns?: number; pickerErrors?: number };
// Pure: from a member's day items, X searches the floor ran and whether the budget left them without X.
export function xOfItems(items: ItemResult[]): { used: number; starved: boolean } {
  const searched = items.filter((i) => i.status === "searched" || i.status === "error");
  return { used: searched.filter((i) => i.sources?.x).length, starved: searched.some((i) => (i.failures ?? []).some((f) => /^x: unavailable/.test(f))) };
}

// Pure: whether the day is complete (no member whose 9am has come is still without a result), and the text.
export function rollupText(day: string, members: RollupMember[], x?: XUsage): { complete: boolean; text: string } {
  const due = members.filter((m) => m.phase !== "before");
  const pending = due.filter((m) => !m.final && !m.errors);
  const ran = due.filter((m) => m.final && m.final.outcome === "act");
  const held = due.filter((m) => m.held);
  const quiet = due.filter((m) => m.final && m.final.outcome !== "act" && !m.held && !["missed", "opted_out"].includes(m.final.action));
  const failed = due.filter((m) => !m.final && m.errors);
  const missed = due.filter((m) => m.final?.action === "missed");
  const sum = (k: string) => due.reduce((n, m) => n + Number(m.final?.totals?.[k] ?? 0), 0);
  const sends = members.reduce((n, m) => n + m.sends, 0);
  const label = DateTime.fromISO(day).toFormat("ccc LLL d");
  const lines = [
    `9am sweep, ${label}: ${failed.length || missed.length ? "failed for some" : "ran"}. ${ran.length} of ${due.length} member(s) searched${quiet.length ? `, ${quiet.length} had nothing to search` : ""}${held.length ? `, ${held.length} held (${held.map((m) => m.name).join(", ")})` : ""}.`,
    `Asks searched ${sum("asksSearched")}, goals searched ${sum("goalsSearched")}, finds kept ${sum("kept")}, queued ${sum("queued")}, finds texted so far today ${sends}.`,
    ...(failed.length ? [`Failed: ${failed.map((m) => `${m.name} (${(m.lastError ?? "no reason").slice(0, 90)}; ${m.errors >= DAILY_SWEEP_ERRORS_PER_DAY ? "no more retries today" : "retrying hourly"})`).join("; ")}.`] : []),
    ...(missed.length ? [`Missed: ${missed.map((m) => m.name).join(", ")} (waking hours ended first).`] : []),
    ...(members.some((m) => m.phase === "before") ? [`Not yet 9am for: ${members.filter((m) => m.phase === "before").map((m) => m.name).join(", ")}.`] : []),
    `X searches: the floor ran ${due.reduce((n, m) => n + (m.xUsed ?? 0), 0)}${x ? `; all sweeps used ${x.sweepsUsed} of ${x.sweepsCap} in the last 24 hours` : ""}.${due.some((m) => m.xStarved) ? ` No X (budget ran dry): ${due.filter((m) => m.xStarved).map((m) => m.name).join(", ")}.` : ""}${x?.webCap ? ` Web searches by sweeps: ${x.webUsed ?? 0} of ${x.webCap} in the last 24 hours.` : ""}`,
    ...(x?.pickerRuns !== undefined ? [`Picker runs after sweeps in the last 24 hours: ${x.pickerRuns}${x.pickerErrors ? `, ${x.pickerErrors} failed` : ""}.`] : []),
  ];
  return { complete: pending.length === 0 && due.length > 0, text: lines.join("\n") };
}

// The one account the rollup goes to, by user id (review, 2026-10-13: a first-name match could send every member's day to someone
// else named Royce). Unset: no text, said once a day in the log.
export function rollupRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = (env.DAILY_ROLLUP_USER_ID ?? "").trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

async function sendRollupIfComplete(rows: any[], now: Date): Promise<void> {
  const to = rollupRecipient();
  if (!to) {
    const day = dailySweepWindow(now, null).day;
    const [said] = (await pool.query(`SELECT 1 FROM harness_decisions WHERE decision = 'sweep.daily_rollup_failed' AND proposal->>'day' = $1 LIMIT 1`, [day])).rows;
    if (!said) await writeRollupRecord(null, false, day, "", "no rollup recipient set (DAILY_ROLLUP_USER_ID), so no text");
    return;
  }
  const toZone = await memberZone(to).catch(() => null);
  const { day, phase } = dailySweepWindow(now, toZone);
  if (phase === "before") return;
  const [already] = (await pool.query(`SELECT 1 FROM harness_decisions WHERE decision = 'sweep.daily_rollup' AND proposal->>'day' = $1 LIMIT 1`, [day])).rows;
  if (already) return;
  const members: RollupMember[] = [];
  for (const r of rows) {
    const zone = await memberZone(String(r.user_id)).catch(() => null);
    const w = dailySweepWindow(now, zone);
    const { rows: recs } = await pool.query(`SELECT outcome, action, reason, proposal->'totals' AS totals, proposal->'items' AS items FROM harness_decisions WHERE decision = 'sweep.daily' AND user_id = $1 AND proposal->>'day' = $2 ORDER BY created_at`, [r.user_id, w.day]);
    const final = [...recs].reverse().find((x: any) => x.action !== "error") ?? null;
    const errs = recs.filter((x: any) => x.action === "error");
    const { rows: s } = await pool.query(`SELECT COALESCE(decided_at, updated_at) AS at FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND COALESCE(decided_at, updated_at) > NOW() - INTERVAL '30 hours'`, [r.user_id]);
    const sends = s.filter((x: any) => DateTime.fromJSDate(new Date(x.at)).setZone(hoursZone(zone)).toISODate() === w.day).length;
    // X across every run today (a retry's carried items are counted once, in the run that searched them).
    const xr = xOfItems(recs.flatMap((x: any) => (Array.isArray(x.items) ? x.items : []).filter((i: ItemResult) => !i.earlierRun)));
    const lastErrItems = errs.length ? ((errs[errs.length - 1].items ?? []) as ItemResult[]) : [];
    members.push({ name: String(r.first_name || "(no name)"), phase: w.phase, final, errors: errs.length, lastError: errs.length ? failureGist(lastErrItems) : null, sends, xUsed: xr.used, xStarved: xr.starved, held: !!final && heldDay((final.items ?? []) as ItemResult[]) });
  }
  const T = await import("./tieredRecommendation.js");
  const [{ n }] = (await pool.query(`SELECT COUNT(*)::int AS n FROM x_search_log WHERE source = 'sweep' AND created_at > NOW() - INTERVAL '1 day'`)).rows;
  const [{ w: webN }] = (await pool.query(`SELECT COUNT(*)::int AS w FROM web_search_log WHERE source = 'sweep' AND created_at > NOW() - INTERVAL '1 day'`)).rows;
  const WS = await import("./webOpportunitySearch.js");
  const [pk] = (await pool.query(`SELECT COUNT(*) FILTER (WHERE action = 'ran')::int AS ran, COUNT(*) FILTER (WHERE action = 'error')::int AS err FROM harness_decisions WHERE decision = 'sweep.picker_after' AND created_at > NOW() - INTERVAL '1 day'`)).rows;
  const { complete, text } = rollupText(day, members, { sweepsUsed: Number(n), sweepsCap: T.X_SWEEP_SHARE(), webUsed: Number(webN), webCap: WS.WEB_SWEEP_SHARE(), pickerRuns: Number(pk?.ran ?? 0), pickerErrors: Number(pk?.err ?? 0) });
  if (!complete) return;
  const [me] = (await pool.query(`SELECT phone_number FROM users WHERE id = $1`, [to])).rows;
  if (!me?.phone_number) return;
  const { default: sendblue, sendingAs } = await import("./sendblue.js");
  const { isTestNumber, testHandle } = await import("./testNumbers.js");
  let sent = true;
  if (isTestNumber(me.phone_number)) {
    // A test member's texts are logged, never sent (services/testNumbers.ts).
    await pool.query(`INSERT INTO outbound_messages (message_handle, user_id, content, sender) VALUES ($1, $2, $3, 'ops')`, [testHandle(), to, text]);
  } else {
    sent = await sendingAs("ops", () => sendblue.messages.send({ number: me.phone_number, content: text, from_number: process.env.SENDBLUE_PHONE_NUMBER! }))
      .then(() => true)
      .catch((err: any) => {
        console.error("Daily sweep: the rollup text failed:", err?.message ?? err);
        return false;
      });
  }
  // Recorded either way; a failed send is retried next tick (only a sent one marks the day done).
  await writeRollupRecord(to, sent, day, text);
}

async function writeRollupRecord(to: string | null, sent: boolean, day: string, text: string, why?: string): Promise<void> {
  await pool.query(
    `INSERT INTO harness_decisions (layer, decision, user_id, outcome, action, proposal, checks, confidence, reason) VALUES (5, $1, $2, $3, $4, $5, '[]', NULL, $6)`,
    [sent ? "sweep.daily_rollup" : "sweep.daily_rollup_failed", to, sent ? "act" : "skip", sent ? "sent" : why ? "no_recipient" : "send_failed", JSON.stringify({ day, text }), sent ? null : why ?? "the text didn't go through; tried again next hour"],
  );
}

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
    if (totals.asksSearched + totals.goalsSearched > 0) await import("./sweepShadow.js").then((S) => S.runPickerAfterSweep(userId, "daily"));
    return;
  }
  const searchedAny = totals.asksSearched + totals.goalsSearched > 0;
  await writeDaily(userId, searchedAny ? "act" : "skip", action, searchedAny ? goalNote : [(proposal as any).note, goalNote].filter(Boolean).join("; ") || "nothing searched; each item says why", proposal);
  // The sweep discovers, the picker decides (sweepShadow.ts runPickerAfterSweep): right after, for what this run put in the pool.
  if (searchedAny) await import("./sweepShadow.js").then((S) => S.runPickerAfterSweep(userId, "daily"));
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
