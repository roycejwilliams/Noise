// Goals in the sweep (Royce, 2026-10-08). The goal sweep searched a member's goals word for word, and a goal that is a work plan or
// one of Co's own tasks ("maintain Co's presence after the November event", "have Co draft planning docs with Sequin AI") became a
// search for "post-event community engagement strategy", which finds nothing worth a text. The rules, the same as for asks
// (askKind.ts isCoCommitment), plus a lifecycle:
//   1. Goals stay on file unchanged: who they are and what they want, and the history of where they've been.
//   2. The sweep never searches a goal verbatim. Each goal gets its findable edge (events, programs, open calls, communities,
//      people); a work plan or Co task gets only that edge ("SF AI and founder gatherings around November"), and a goal with no
//      findable edge is passed, with the reason logged.
//   3. Co's own tasks are caught in code; the model judges the rest and writes the edges; code drops any edge that restates a goal.
//      Find requests already saved from a work or Co-task goal stop being searched (ask_checkins kind 'help').
//   4. Lifecycle: every goal is active, done or stale (goal_states; no row = active). Each run re-reads the current goals and derives
//      the searches from scratch, never cached. A goal goes stale when its date or window passes, or when their newer words supersede
//      it (a profile correction, or a newer goal on file that replaces it); it's done when they or Co close it. Stale and done goals
//      stop generating searches and stay on file. A goal Co set aside from context (not in a conversation) is told to them in the next
//      natural exchange ("still want things for X?"), never silently (told_at; the reply's hint in harness/replyGrounding.ts).
// Every read and write is scoped to one member (user_id).
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { isCoCommitment } from "./askKind.js";
import { retiredBy } from "./callContext.js";
import { memberTerms, queryProblems } from "./sweepQuery.js";

export type GoalKind = "findable" | "work" | "co_task";
export type GoalState = "active" | "done" | "stale";
export type GoalEdge = { goal: string; kind: GoalKind; edges: string[]; why: string; until: string | null; supersededBy: string | null };
export type GoalStateRow = { goalHash: string; goal: string; state: GoalState; reason: string; source: "context" | "member" | "co"; changedAt: Date; toldAt: Date | null; hints: number };
export type Correction = { field: string; old_value: string | null; new_value: string | null; corrected_at: string | Date };

export const EDGE_LIMITS = { perGoal: 2, chars: 140, timeoutMs: 8000 } as const;
// A goal set aside from context is raised in at most this many replies, then it's left to the next goal check-in.
export const TELL_MAX_HINTS = 4;

// ---------- pure

// Co's own task, in code: the asks guard, plus a goal that hands Co the work ("have Co draft…", "maintain Co's presence…").
const CO_TASK = /\b(?:have|has|get|let|ask(?:ing)?|want(?:s)?)\s+co\s+(?:to\s+)?\w+|\bco(?:'s)?\s+(?:to\s+)?(?:draft|write|send|prepare|put together|plan|build|keep|maintain)\b|\bmaintain(?:ing)?\s+co'?s\b/i;
export function isCoTaskGoal(text: string): boolean {
  return isCoCommitment(text) || CO_TASK.test(text ?? "");
}

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
// An edge that is the goal restated (most of its words are the goal's) is not a findable edge: dropped in code.
export function restates(edge: string, goal: string): boolean {
  const e = words(edge), g = new Set(words(goal));
  if (!e.length) return true;
  return e.filter((w) => g.has(w)).length / e.length >= 0.75 || edge.trim().toLowerCase() === goal.trim().toLowerCase();
}

export function goalHash(goal: string): string {
  return createHash("sha1").update(goal.trim().toLowerCase()).digest("hex").slice(0, 20);
}

export function edgePrompt(goals: string[], o: { city: string | null; today: string }): string {
  return `A member of a private club in ${o.city ?? "San Francisco"} has these goals on file, oldest first (today is ${o.today}):
${goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}

Co searches the world each day for things worth texting them about: events and gatherings, programs and cohorts, open calls, fellowships and grants, communities, people worth meeting. For each goal:
- kind: "findable" if the goal itself is something like that to look for; "work" if it's their own work plan (partnering, pitching, building, launching, raising); "co_task" if it's something Co itself is doing for them (drafting, sending, planning, keeping something going).
- edges: up to ${EDGE_LIMITS.perGoal} short searches for the FINDABLE side of the goal, things that would actually help it along, named the way a good researcher would search for the thing itself, in a few words ("SF AI founder events November", "consumer AI pre-seed open calls", "founder wellness community SF"). Never a name (theirs, their company, partners or people), never a description of them, never the goal reworded, never a strategy, a how-to or advice. A work plan or Co task gets only its findable side; if it has none, give no edges.
- until: the last day it can still matter (YYYY-MM-DD) when the goal is tied to a date or window ("the November launch" -> its last day in November); null when it has none.
- superseded_by: the number of a LATER goal in this list that replaces it (a changed plan, a cancelled date), else null.
- why: one short reason, especially when there are no edges.

Answer only with JSON: [{"n": 1, "kind": "...", "edges": ["..."], "until": null, "superseded_by": null, "why": "..."}, ...]`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Pure: the model's answer, checked in code. Co tasks are Co tasks whatever the model said; restated edges are dropped; a date must
// be a real date; a goal can only be superseded by a later goal in the list.
export function parseEdges(goals: string[], raw: string, firstName?: string | null): GoalEdge[] {
  let arr: any[] = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    arr = m ? JSON.parse(m[0]) : [];
  } catch {
    arr = [];
  }
  const rows = goals.map((_, i) => arr.find((x) => Number(x?.n) === i + 1) ?? {});
  // The member never goes into a search (services/sweepQuery.ts): an edge naming them, their company or partners is dropped. Their
  // own work is in the goals that aren't findable; a name in a findable goal (a neighborhood, a program) is the thing being found.
  const terms = memberTerms({ firstName, goals: goals.filter((g, i) => isCoTaskGoal(g) || String(rows[i].kind ?? "") !== "findable") });
  return goals.map((goal, i) => {
    const r = rows[i];
    const k = String(r.kind ?? "");
    const kind: GoalKind = isCoTaskGoal(goal) ? "co_task" : k === "findable" || k === "co_task" ? (k as GoalKind) : "work";
    const edges = (Array.isArray(r.edges) ? r.edges : [])
      .map((e: unknown) => String(e ?? "").replace(/\s+/g, " ").trim().slice(0, EDGE_LIMITS.chars))
      .filter((e: string) => e && !goals.some((g) => restates(e, g)) && !queryProblems(e, { terms, source: "events" }).length)
      .slice(0, EDGE_LIMITS.perGoal);
    const until = typeof r.until === "string" && ISO.test(r.until) && DateTime.fromISO(r.until).isValid ? r.until : null;
    const by = Number(r.superseded_by);
    const supersededBy = Number.isInteger(by) && by > i + 1 && by <= goals.length ? goals[by - 1] : null;
    const why = String(r.why ?? "").trim().slice(0, 200) || (edges.length ? "" : arr.length ? "no findable side" : "couldn't be read this time");
    return { goal, kind, edges, why, until, supersededBy };
  });
}

// Pure: what a goal is now, from this run's reading. Done stays done; a passed window or newer words make it stale; else active.
export function lifecycle(e: GoalEdge, o: { today: string; corrections: Correction[]; prior: GoalStateRow | null; retired: (goal: string, c: Correction[]) => Correction | null }): { state: GoalState; reason: string } {
  if (o.prior?.state === "done") return { state: "done", reason: o.prior.reason };
  if (o.prior?.state === "stale" && o.prior.source !== "context") return { state: "stale", reason: o.prior.reason };
  if (e.until && e.until < o.today) return { state: "stale", reason: `its window passed (${e.until})` };
  const c = o.retired(e.goal, o.corrections);
  if (c) return { state: "stale", reason: `they said since: "${String(c.new_value ?? "that's no longer the plan").slice(0, 120)}"` };
  if (e.supersededBy) return { state: "stale", reason: `replaced by a newer goal: "${e.supersededBy.slice(0, 120)}"` };
  return { state: "active", reason: "" };
}

// What the sweep is told to look for: the active goals' edges, never a goal's own words, plus what they enjoy. Null: nothing to search.
export function edgeSearchText(edges: GoalEdge[], extra: { enjoys?: string[] | null; specifics?: string[] | null } = {}): string | null {
  const looks = [...new Set(edges.flatMap((e) => e.edges))];
  if (!looks.length && !extra.enjoys?.length) return null;
  const parts = [
    looks.length ? `look for: ${looks.join("; ")}` : null,
    extra.enjoys?.length ? `enjoys: ${extra.enjoys.join(", ")}` : null,
    extra.specifics?.length ? `specifics: ${extra.specifics.join(", ")}` : null,
  ].filter(Boolean);
  return parts.join(". ").slice(0, 600);
}

// ---------- the run

export type GoalPlan = { searchText: string | null; active: GoalEdge[]; passed: { goal: string; why: string }[]; setAside: { goal: string; state: GoalState; reason: string }[]; retiredAsks: number };

export type GoalDeps = {
  model: (prompt: string) => Promise<string>;
  states: (userId: string) => Promise<Map<string, GoalStateRow>>;
  setState: (userId: string, goal: string, state: GoalState, reason: string, source: GoalStateRow["source"]) => Promise<void>;
  corrections: (userId: string) => Promise<Correction[]>;
  retired: (goal: string, c: Correction[]) => Correction | null;
  findAsks: (userId: string) => Promise<{ id: number; text: string }[]>;
  helpAsk: (userId: string, id: number) => Promise<void>;
  log: (d: { userId: string; action: string; proposal: Record<string, unknown>; reason?: string | null }) => Promise<void>;
};

// One member's goals for this sweep: read fresh, derived fresh, the lifecycle applied, set-asides recorded, goal-derived find
// requests retired. Returns what to search (or null with the reasons each goal was passed).
export async function planGoalSweep(userId: string, goals: string[], o: { city: string | null; zone: string | null; now: Date; enjoys?: string[] | null; specifics?: string[] | null; firstName?: string | null }, deps: GoalDeps): Promise<GoalPlan> {
  const today = DateTime.fromJSDate(o.now).setZone(o.zone && DateTime.now().setZone(o.zone).isValid ? o.zone : "America/Los_Angeles").toISODate()!;
  const uniq = [...new Set(goals.map((g) => g.trim()).filter(Boolean))];
  const states = await deps.states(userId).catch(() => new Map<string, GoalStateRow>());
  // Done or stale goals stay on file and out of the search; only active ones are read and derived.
  const live = uniq.filter((g) => {
    const s = states.get(goalHash(g));
    return !s || s.state === "active";
  });
  const raw = live.length ? await deps.model(edgePrompt(live, { city: o.city, today })).catch(() => "") : "";
  const derived = parseEdges(live, raw, o.firstName);
  const corrections = await deps.corrections(userId).catch(() => [] as Correction[]);
  const active: GoalEdge[] = [], passed: { goal: string; why: string }[] = [], setAside: GoalPlan["setAside"] = [];
  for (const e of derived) {
    const life = lifecycle(e, { today, corrections, prior: states.get(goalHash(e.goal)) ?? null, retired: deps.retired });
    if (life.state !== "active") {
      await deps.setState(userId, e.goal, life.state, life.reason, "context").catch(() => {});
      setAside.push({ goal: e.goal, state: life.state, reason: life.reason });
      continue;
    }
    if (e.edges.length) active.push(e);
    else passed.push({ goal: e.goal, why: `${e.kind}: ${e.why || "no findable side"}` });
  }
  // Find requests saved from a goal that isn't findable (or from a goal set aside) stop being searched.
  const notFindable = [...derived.filter((e) => e.kind !== "findable").map((e) => e.goal), ...setAside.map((s) => s.goal)];
  let retiredAsks = 0;
  if (notFindable.length) {
    for (const a of await deps.findAsks(userId).catch(() => [])) {
      if (!(isCoTaskGoal(a.text) || notFindable.some((g) => restates(a.text, g) || restates(g, a.text)))) continue;
      await deps.helpAsk(userId, a.id).catch(() => {});
      retiredAsks++;
    }
  }
  const searchText = edgeSearchText(active, { enjoys: o.enjoys, specifics: o.specifics });
  await deps
    .log({
      userId,
      action: searchText ? "searching_edges" : "passed",
      reason: searchText ? null : live.length && !raw ? "the goals couldn't be read this time" : passed.length || setAside.length ? "no active goal with a findable side" : "no active goals",
      proposal: { edges: active.map((e) => ({ goal: e.goal, kind: e.kind, edges: e.edges })), passed, setAside, retiredAsks },
    })
    .catch(() => {});
  return { searchText, active, passed, setAside, retiredAsks };
}

// ---------- real deps

const fromStateRow = (r: any): GoalStateRow => ({ goalHash: String(r.goal_hash), goal: String(r.goal_text), state: r.state, reason: String(r.reason ?? ""), source: r.source, changedAt: new Date(r.changed_at), toldAt: r.told_at ? new Date(r.told_at) : null, hints: Number(r.hints ?? 0) });

export async function goalStates(userId: string): Promise<Map<string, GoalStateRow>> {
  const { rows } = await pool.query(`SELECT * FROM goal_states WHERE user_id = $1`, [userId]);
  return new Map(rows.map((r: any) => [String(r.goal_hash), fromStateRow(r)]));
}

// A context set-aside waits to be told (told_at NULL); one Co or the member made in conversation is already said.
export async function setGoalState(userId: string, goal: string, state: GoalState, reason: string, source: GoalStateRow["source"]): Promise<void> {
  await pool.query(
    `INSERT INTO goal_states (user_id, goal_hash, goal_text, state, reason, source, changed_at, told_at, hints)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), CASE WHEN $6 = 'context' AND $4 <> 'active' THEN NULL ELSE NOW() END, 0)
     ON CONFLICT (user_id, goal_hash) DO UPDATE SET goal_text = EXCLUDED.goal_text, state = EXCLUDED.state, reason = EXCLUDED.reason, source = EXCLUDED.source,
       changed_at = NOW(), told_at = EXCLUDED.told_at, hints = 0
     WHERE goal_states.state IS DISTINCT FROM EXCLUDED.state OR goal_states.source IS DISTINCT FROM EXCLUDED.source`,
    [userId, goalHash(goal), goal.slice(0, 500), state, reason.slice(0, 300), source],
  );
}

// The set-asides they haven't heard about yet, for the reply's hint.
export async function untoldSetAsides(userId: string): Promise<GoalStateRow[]> {
  const { rows } = await pool.query(`SELECT * FROM goal_states WHERE user_id = $1 AND state <> 'active' AND source = 'context' AND told_at IS NULL AND hints < $2 ORDER BY changed_at`, [userId, TELL_MAX_HINTS]);
  return rows.map(fromStateRow);
}

// Pure: whether a sent reply raised the set-aside goal (shares at least two of its meaning words).
export function raisedGoal(sent: string, goal: string): boolean {
  const g = new Set(words(goal).filter((w) => w.length > 3));
  return words(sent).filter((w) => g.has(w)).length >= 2;
}

// After a reply went out: told when it raised the goal; else one more hint used.
export async function noteGoalHints(userId: string, rows: GoalStateRow[], sent: string): Promise<void> {
  for (const r of rows) {
    if (raisedGoal(sent, r.goal)) await pool.query(`UPDATE goal_states SET told_at = NOW() WHERE user_id = $1 AND goal_hash = $2`, [userId, r.goalHash]);
    else await pool.query(`UPDATE goal_states SET hints = hints + 1 WHERE user_id = $1 AND goal_hash = $2`, [userId, r.goalHash]);
  }
}

export const realGoalDeps: GoalDeps = {
  // Haiku 5.5 thinks by default and the ai-sdk drops "thinking disabled" (2026-10-07), so the SDK is called directly.
  model: async (prompt) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), EDGE_LIMITS.timeoutMs);
    try {
      const r: any = await new Anthropic().messages.create({ model: MODELS.haiku, max_tokens: 900, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any, { signal: ctl.signal });
      return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    } finally {
      clearTimeout(t);
    }
  },
  states: goalStates,
  setState: setGoalState,
  corrections: async (userId) => (await pool.query(`SELECT field, old_value, new_value, corrected_at FROM profile_corrections WHERE user_id = $1 ORDER BY corrected_at DESC LIMIT 40`, [userId])).rows,
  // The same check that retires a corrected thread in the call context (services/callContext.ts).
  retired: (goal, c) => retiredBy(goal, c as any) as Correction | null,
  findAsks: async (userId) => (await pool.query(`SELECT id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'find'`, [userId])).rows.map((r: any) => ({ id: Number(r.id), text: String(r.ask_text ?? "") })),
  helpAsk: async (userId, id) => {
    await pool.query(`UPDATE ask_checkins SET kind = 'help', kind_checked_at = NOW() WHERE id = $1 AND user_id = $2 AND kind = 'find'`, [id, userId]);
  },
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 7, decision: "goal_sweep.plan", userId: d.userId, outcome: d.action === "passed" ? "skip" : "act", action: d.action, reason: d.reason ?? null, proposal: d.proposal });
  },
};
