// The goal-based sweep (Royce, 2026-10-06): discovery driven by WHERE A MEMBER IS HEADED (their goals, what they enjoy, their direction),
// not by an errand. Before, it ran only for a member with NO open ask, so an engaged member (someone with asks) got less discovery than a
// quiet one. Now every member with a direction has their own budget, whatever else is open:
//   - one attempt per member per 20 hours (profile_surfacing_state.last_attempted_at)
//   - a find surfaced for them at most once per 3 days (cooldown), and the one-text-a-day nudge cap still applies across all mechanisms
// Open asks neither block it nor boost it: the ask sweep and this one are separate, each with its own budget. Goals reach this sweep as
// context only; no goal ever has an ask_checkins row, so nothing here (or in the ask sweep) can search or check in on a goal AS an errand.
import pool from "../db/db.js";
import { attemptEventSurfacing, PROFILE_ASK_ID } from "./eventSurfacingSweep.js";
import { goalEntries } from "../harness/profileWrite.js";

export const GOAL_SWEEP_EVERY_HOURS = 20;
export const GOAL_SURFACE_COOLDOWN_DAYS = 3;
export const GOAL_SWEEP_BATCH = 50;

// Members with a direction to search from. No condition on their asks.
export const GOAL_SWEEP_SQL = `SELECT u.id AS user_id, u.first_name, u.phone_number, cp.city, cp.goals, cp.activity_preferences,
        cp.long_term_direction, cp.intent, pss.last_attempted_at,
        (pss.last_surfaced_at IS NULL OR pss.last_surfaced_at <= NOW() - INTERVAL '${GOAL_SURFACE_COOLDOWN_DAYS} days') AS cooldown_cleared
 FROM users u
 JOIN co_profiles cp ON cp.user_id = u.id
 LEFT JOIN profile_surfacing_state pss ON pss.user_id = u.id
 WHERE u.sms_opted_out = false AND u.phone_number IS NOT NULL AND u.archived_at IS NULL
   AND (array_length(cp.goals, 1) > 0 OR array_length(cp.activity_preferences, 1) > 0
        OR COALESCE(cp.long_term_direction, '') <> ''
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cp.intent) = 'array' THEN cp.intent ELSE '[]'::jsonb END) e
                   WHERE e->>'kind' = 'goal' AND e->>'status' = 'active'))
   AND (pss.last_attempted_at IS NULL OR pss.last_attempted_at <= NOW() - INTERVAL '${GOAL_SWEEP_EVERY_HOURS} hours')
 LIMIT ${GOAL_SWEEP_BATCH}`;

export function goalSweepGoals(row: { goals?: string[] | null; intent?: unknown }): string[] | null {
  const g = [...new Set([...(row.goals ?? []), ...goalEntries(row.intent).map((e) => String(e.text).trim())].filter(Boolean))];
  return g.length ? g : null;
}

// Whether they have a direction on file at all (the gate for a goal sweep). Since 2026-10-08 the search itself is never these words:
// it is each active goal's findable edge (services/goalEdges.ts planGoalSweep).
export function goalSweepContext(row: { goals?: string[] | null; activity_preferences?: string[] | null; long_term_direction?: string | null; intent?: unknown }): string | null {
  const intents = Array.isArray(row.intent) ? (row.intent as any[]) : [];
  const goalTexts = goalEntries(intents).map((g) => String(g.text).trim());
  const latest = intents[intents.length - 1] ?? {};
  const parts = [
    row.goals?.length || goalTexts.length ? `goals: ${[...(row.goals ?? []), ...goalTexts].join("; ")}` : null,
    row.activity_preferences?.length ? `enjoys: ${row.activity_preferences.join(", ")}` : null,
    row.long_term_direction ? `direction: ${row.long_term_direction}` : null,
    latest.wants?.length ? `wants: ${latest.wants.join(", ")}` : null,
    latest.concrete_preferences?.length ? `specifics: ${latest.concrete_preferences.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(". ").slice(0, 600) : null;
}

// The per-member budget, as a pure rule (the SQL applies the same one): a member is due when 20 hours have passed since their last
// attempt. How many asks they have is not an input.
export function goalSweepDue(row: { last_attempted_at: Date | string | null }, now = new Date()): boolean {
  return !row.last_attempted_at || now.getTime() - new Date(row.last_attempted_at).getTime() >= GOAL_SWEEP_EVERY_HOURS * 3_600_000;
}

export type GoalSweepDeps = {
  rows: () => Promise<any[]>;
  mark: (userId: string) => Promise<void>;
  surface: (row: any, context: string) => Promise<void>;
  // This run's reading of their goals (services/goalEdges.ts planGoalSweep): never cached, never a goal's own words.
  plan: (row: any) => Promise<{ searchText: string | null }>;
};
const realDeps: GoalSweepDeps = {
  rows: async () => (await pool.query(GOAL_SWEEP_SQL)).rows,
  plan: async (row) => {
    const { planGoalSweep, realGoalDeps } = await import("./goalEdges.js");
    const { memberZone } = await import("./memberTime.js");
    const goals = goalSweepGoals(row) ?? [];
    const latest = Array.isArray(row.intent) ? (row.intent as any[])[row.intent.length - 1] ?? {} : {};
    return planGoalSweep(row.user_id, goals, { city: row.city ?? null, zone: await memberZone(row.user_id), now: new Date(), firstName: row.first_name ?? null, direction: row.long_term_direction ? String(row.long_term_direction) : null, enjoys: row.activity_preferences ?? null, specifics: latest.concrete_preferences ?? null }, realGoalDeps);
  },
  mark: async (userId) => { await pool.query(`INSERT INTO profile_surfacing_state (user_id, last_attempted_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET last_attempted_at = NOW()`, [userId]); },
  surface: async (row, context) => {
    await attemptEventSurfacing({ askId: PROFILE_ASK_ID, userId: row.user_id, firstName: row.first_name, phoneNumber: row.phone_number, askText: context, fromProfile: true, city: row.city ?? null, goals: goalSweepGoals(row), activityPreferences: row.activity_preferences ?? null, cooldownCleared: row.cooldown_cleared });
  },
};

// Returns how many members it attempted. The cron (jobs/index.ts) runs it every hour at :30.
export async function runGoalSweep(run: <T>(items: T[], limit: number, fn: (i: T) => Promise<void>) => Promise<void>, deps: GoalSweepDeps = realDeps): Promise<number> {
  const rows = await deps.rows();
  let n = 0;
  await run(rows, 3, async (row: any) => {
    if (!goalSweepContext(row)) return;
    await deps.mark(row.user_id);
    n++;
    try {
      // What to look for is each active goal's findable edge (services/goalEdges.ts), read fresh this run; a member whose goals
      // have no findable side is passed, and the plan logs why.
      const { searchText } = await deps.plan(row);
      if (!searchText) return;
      await deps.surface(row, searchText);
    } catch (err: any) {
      console.error(`Goal sweep failed for ${row.user_id}:`, err?.message ?? err);
    }
  });
  return n;
}
