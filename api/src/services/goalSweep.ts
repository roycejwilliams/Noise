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
import { COLD_START, isNewMember, seedSignature } from "./coldStart.js";
import { goalHash } from "./goalEdges.js";

export const GOAL_SWEEP_EVERY_HOURS = 20;
export const GOAL_SURFACE_COOLDOWN_DAYS = 3;
export const GOAL_SWEEP_BATCH = 50;

// Cold start (services/coldStart.ts, 2026-10-08): a new member's seeds go into the very next sweep. In their first week, once their
// profile has changed since the last attempt (and at least COLD_START_RESWEEP_HOURS after it), they're read again; the run goes on only
// when what the goal sweep reads (goals, direction, what they enjoy) actually changed (seedSignature), so a chat about their week
// costs nothing.
export const COLD_START_RESWEEP_HOURS = 1;

// Members with a direction to search from. No condition on their asks. Members due on the 20-hour budget come first, then new members
// whose profile changed.
export const GOAL_SWEEP_SQL = `SELECT u.id AS user_id, u.first_name, u.phone_number, u.created_at AS joined_at, cp.city, cp.goals, cp.activity_preferences,
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
   AND (pss.last_attempted_at IS NULL OR pss.last_attempted_at <= NOW() - INTERVAL '${GOAL_SWEEP_EVERY_HOURS} hours'
        OR (u.created_at > NOW() - INTERVAL '${COLD_START.newMemberDays} days' AND cp.updated_at > pss.last_attempted_at
            AND pss.last_attempted_at <= NOW() - INTERVAL '${COLD_START_RESWEEP_HOURS} hours'))
 ORDER BY (pss.last_attempted_at IS NULL OR pss.last_attempted_at <= NOW() - INTERVAL '${GOAL_SWEEP_EVERY_HOURS} hours') DESC
 LIMIT ${GOAL_SWEEP_BATCH}`;

// Pure: the goals planning reads: their own words for each goal the record holds as active and on file.
export function planGoals(row: { goals?: string[] | null; intent?: unknown }, goals: { hash: string; state: string; onFile: boolean }[]): string[] {
  const live = new Set(goals.filter((g) => g.state === "active" && g.onFile).map((g) => g.hash));
  return (goalSweepGoals(row) ?? []).filter((g) => live.has(goalHash(g)));
}

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

// What the goal sweep reads for a member, as a fingerprint (services/coldStart.ts seedSignature).
export function rowSeedSignature(row: { goals?: string[] | null; intent?: unknown; long_term_direction?: string | null; activity_preferences?: string[] | null }): string {
  return seedSignature({ goals: goalSweepGoals(row) ?? [], direction: row.long_term_direction ?? null, enjoys: row.activity_preferences ?? null });
}

// Pure: whether a row runs this tick. Due on the 20-hour budget; or, for a new member (their first week), early when what the sweep
// reads changed since the last run (lastSig: the signature the last plan logged; null when there's none on record).
export function goalSweepRuns(row: { last_attempted_at: Date | string | null; joined_at?: Date | string | null }, sig: string, lastSig: string | null, now = new Date()): { run: boolean; why: "due" | "new_seeds" | "not_due" } {
  if (goalSweepDue(row, now)) return { run: true, why: "due" };
  if (isNewMember(row.joined_at ?? null, now) && sig !== lastSig) return { run: true, why: "new_seeds" };
  return { run: false, why: "not_due" };
}

export type GoalSweepDeps = {
  rows: () => Promise<any[]>;
  mark: (userId: string) => Promise<void>;
  surface: (row: any, context: string) => Promise<void>;
  // This run's reading of their goals (services/goalEdges.ts planGoalSweep): never cached, never a goal's own words.
  // seedSig rides along into the plan's log, so the next run can tell whether anything changed.
  plan: (row: any, seedSig?: string) => Promise<{ searchText: string | null; passed?: { goal: string; why: string }[] }>;
  // The seed signature the member's last plan logged (cold start's early rerun). Optional: without it, only the 20-hour budget applies.
  lastSeedSig?: (userId: string) => Promise<string | null>;
  // A new member's sweep that came back with nothing to search (services/coldStart.ts): a flagged miss. Optional; nothing is sent.
  coldStartMiss?: (row: any, why: string, passed: { goal: string; why: string }[]) => Promise<void>;
  // Why dispatch would hold a goal find for them now (harness/proactive.ts sweepHold, Phase A3); empty: nothing holds it.
  held?: (userId: string) => Promise<string[]>;
  // A run that didn't search (held, or a find surfaced within the cooldown), for the log.
  skipped?: (row: any, why: string, detail: string[]) => Promise<void>;
};
const realDeps: GoalSweepDeps = {
  rows: async () => (await pool.query(GOAL_SWEEP_SQL)).rows,
  plan: async (row, seedSig) => {
    const { planGoalSweep, realGoalDeps, PLAN_RECORD_LIMITS } = await import("./goalEdges.js");
    // The member record (Phase A4): their goals with state, the kind of room they want, what they ruled out, what their asks already
    // search, who they are. A record that can't be read (a failed name read fails closed) means no plan this run.
    const { memberKnowledge } = await import("./memberKnowledge.js");
    const k = await memberKnowledge(row.user_id, { include: ["goals", "asks", "preferences", "limits", "person"] });
    if (!k.limits) throw new Error("their limits couldn't be read");
    const latest = Array.isArray(row.intent) ? (row.intent as any[])[row.intent.length - 1] ?? {} : {};
    return planGoalSweep(
      row.user_id,
      // Active goals on file: a goal entry they closed or set aside, or a state row whose goal is gone, is never planned from. Their
      // own words (the record's text is stripped, which would change the goal's hash and orphan its state; review of #134), chosen by
      // the record's hash.
      planGoals(row, k.goals),
      {
        city: k.identity.city ?? row.city ?? null,
        zone: k.identity.zone,
        now: new Date(),
        firstName: row.first_name ?? null,
        direction: row.long_term_direction ? String(row.long_term_direction) : null,
        enjoys: row.activity_preferences ?? null,
        specifics: latest.concrete_preferences ?? null,
        seedSig,
        record: {
          person: (k.person?.text ?? "").slice(0, PLAN_RECORD_LIMITS.person),
          statedTaste: k.preferences.filter((p) => p.source === "stated").map((p) => p.text),
          avoid: k.limits.avoid,
          openAsks: k.asks.map((a) => a.text),
        },
      },
      realGoalDeps,
    );
  },
  lastSeedSig: async (userId) => {
    const { rows } = await pool.query(`SELECT proposal->>'seedSig' AS sig FROM harness_decisions WHERE user_id = $1 AND decision = 'goal_sweep.plan' ORDER BY created_at DESC LIMIT 1`, [userId]);
    return rows[0]?.sig ?? null;
  },
  coldStartMiss: async (row, why, passed) => {
    const { noteColdStartSweep } = await import("./coldStart.js");
    await noteColdStartSweep({ userId: row.user_id, sweep: "goal", searched: null, found: false, why, tried: [], turnedAway: passed.map((p) => `${p.goal.slice(0, 100)}: ${p.why.slice(0, 80)}`) });
  },
  mark: async (userId) => { await pool.query(`INSERT INTO profile_surfacing_state (user_id, last_attempted_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET last_attempted_at = NOW()`, [userId]); },
  held: async (userId) => (await import("../harness/proactive.js")).sweepHold(userId, "goal"),
  skipped: async (row, why, detail) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 7, decision: "goal_sweep.skip", userId: row.user_id, outcome: "skip", action: why, proposal: { detail } });
  },
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
    // Due on the budget, or a new member whose seeds changed since the last run (cold start); anyone else waits, unmarked.
    const sig = rowSeedSignature(row);
    if (!goalSweepDue(row)) {
      const last = deps.lastSeedSig ? await deps.lastSeedSig(row.user_id).catch(() => sig) : sig;
      if (!goalSweepRuns(row, sig, last).run) return;
    }
    // One find per GOAL_SURFACE_COOLDOWN_DAYS (Phase A4: the cooldown was computed and only logged, so a member who'd just had a find
    // still got a full goal sweep every day). The budget is marked, so it's looked at again on the next one.
    if (row.cooldown_cleared === false) {
      await deps.mark(row.user_id);
      await deps.skipped?.(row, "cooldown", [`a find went out within ${GOAL_SURFACE_COOLDOWN_DAYS} days`]).catch(() => {});
      return;
    }
    // Zero sweeps for a member dispatch would hold a goal find for (Phase A3): a hold, a safety hold, kind restraint, the weekly cap,
    // the engagement pace, the unanswered pause. A gate that can't be read holds too: nothing is spent on a guess.
    const held = deps.held ? await deps.held(row.user_id).catch(() => ["gate_unreadable"]) : [];
    if (held.length) {
      await deps.mark(row.user_id);
      await deps.skipped?.(row, "held", held).catch(() => {});
      return;
    }
    await deps.mark(row.user_id);
    n++;
    try {
      // What to look for is each active goal's findable edge (services/goalEdges.ts), read fresh this run; a member whose goals
      // have no findable side is passed, and the plan logs why.
      const { searchText, passed } = await deps.plan(row, sig);
      if (!searchText) {
        // A new member with nothing findable to search is a cold-start miss, never a silent pass (services/coldStart.ts).
        if (deps.coldStartMiss && isNewMember(row.joined_at ?? null)) await deps.coldStartMiss(row, passed?.length ? "none of their goals has a findable side" : "nothing to search from their goals", passed ?? []).catch(() => {});
        return;
      }
      await deps.surface(row, searchText);
    } catch (err: any) {
      console.error(`Goal sweep failed for ${row.user_id}:`, err?.message ?? err);
    }
  });
  return n;
}
