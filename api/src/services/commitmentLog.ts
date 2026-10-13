// Promises made vs kept (Royce, 2026-10-13, goal ownership 5/6): every commitment Co makes, each time it fires, any slip, and how it
// ended go in the decision log, so the team-only dashboard (co-test /sweeps, promises view) can show made, kept and missed per goal.
// Never a text or an email: "Don't ever send a recap."
//
// A commitment is a task Co owes: a promise it made in a reply or on a call (co_tasks.source = 'promise'), a look-out it said on a
// call (source = 'lookout', not a first read), and every piece of a goal it took or a check-in it set (followup.goalId). Work a member
// simply asked for is their ask, already logged by the task itself, and isn't counted here.
//
// The events (harness_decisions.decision):
//   commitment.created   the ledger entry exists, with its first fire time
//   commitment.fired     its time came and Co woke on it
//   commitment.slipped   it moved past its time (outside their hours, a held send, a window moved), with the new time and why
//   commitment.outcome   how it ended: kept, partial, missed, released (they no longer need it) or withdrawn (never said after all)
// Each carries taskId and, when it belongs to one, goalId, so the rollup groups by goal.
import { recordDecision } from "../harness/core.js";
import pool from "../db/db.js";

export type CommitmentOutcome = "kept" | "partial" | "missed" | "released" | "withdrawn";
export type CommitmentEvent = "created" | "fired" | "slipped" | "outcome";

// Pure: is this task a commitment Co owes?
export function isCommitment(t: { source?: string | null; followup?: any; kind?: string | null }): boolean {
  if (t.kind && t.kind !== "work") return false;
  if (t.followup?.goalId != null) return true;
  if (t.source === "promise") return true;
  return t.source === "lookout" && t.followup?.lookoutFrom !== "first_read" && t.followup?.lookoutOrigin !== "member";
}

// Pure: how a commitment ended, from how its task closed (Royce, 2026-10-13: "'Released' without the member's word is laundering.
// Dropped without their agreement counts against Co"):
//   - expired: missed
//   - dropped: withdrawn when the promise never went out (never made); released only on the member's own word, quoted (or their
//     opt-out, which is their own STOP); any other drop is missed, its why kept
//   - done: released when they said they handled it themselves and Co never sent anything for it (Co didn't keep it, they did);
//     partial when a goal piece left some of its own steps undone; otherwise kept
export const OPTED_OUT = /^Member opted out or archived\.$/;
export function outcomeOf(status: "done" | "dropped" | "expired", outcome: string, steps: { done: boolean }[] = [], o: { source?: string | null; goalItem?: boolean; theirWord?: string | null; sentAnything?: boolean } = {}): CommitmentOutcome {
  const theirs = !!o.theirWord && o.theirWord.trim().length >= 3;
  if (status === "expired") return "missed";
  if (status === "dropped") return /promise was not in the text that went out/i.test(outcome) ? "withdrawn" : theirs || OPTED_OUT.test(outcome.trim()) ? "released" : "missed";
  if (theirs && o.sentAnything === false) return "released";
  // A goal piece closed as done with steps never done: some of it landed, not all.
  if (o.goalItem && steps.length > 1 && steps.some((s) => s.done) && steps.some((s) => !s.done)) return "partial";
  return "kept";
}

export async function logCommitment(event: CommitmentEvent, d: { userId: string; taskId: number; goalId?: number | null; why?: string | null; outcome?: CommitmentOutcome; fireAt?: string | null; what?: string | null; source?: string | null; theirWord?: string | null; admitted?: boolean }): Promise<void> {
  await recordDecision({
    layer: 7,
    decision: `commitment.${event}`,
    userId: d.userId,
    outcome: event === "outcome" ? (d.outcome === "kept" ? "act" : "skip") : "act",
    action: event === "outcome" ? d.outcome ?? null : event,
    reason: d.why ? d.why.slice(0, 300) : null,
    proposal: { taskId: d.taskId, goalId: d.goalId ?? null, fireAt: d.fireAt ?? null, what: d.what ? d.what.slice(0, 200) : null, source: d.source ?? null, ...(d.theirWord ? { theirWord: d.theirWord.slice(0, 200) } : {}), ...(d.admitted !== undefined ? { admitted: d.admitted } : {}) },
  }).catch(() => {});
}

// A promise Co spoke on a call that it couldn't bind (services/promiseBinding.ts bindCallPromises): it was made, and it's missed, even
// when Co took it back in a text. Its ledger row is a closed promise task (never woken: it's closed when written), so made vs kept
// counts it, marked admitted when the take-back text went or was queued.
export async function recordUnboundCallPromise(userId: string, p: { sentence: string; why: string; admitted: boolean }): Promise<number | null> {
  const { rows } = await pool.query(
    `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes, source, status, outcome, closed_at)
     VALUES ($1, $2, '(said on a call)', '[]'::jsonb, NULL, NULL, '[]'::jsonb, 'promise', 'dropped', $3, NOW()) RETURNING id`,
    [userId, `Keep your word from the call: "${p.sentence.slice(0, 170)}"`, `${p.admitted ? "Admitted after the call" : "Couldn't be held, and the take-back didn't send"}: ${p.why}`.slice(0, 300)],
  ).catch(() => ({ rows: [] as any[] }));
  const id = rows[0]?.id != null ? Number(rows[0].id) : null;
  if (id == null) return null;
  await logCommitment("created", { userId, taskId: id, what: p.sentence, source: "promise", why: "said on a call" });
  await logCommitment("outcome", { userId, taskId: id, outcome: "missed", why: `${p.admitted ? "admitted after the call" : "not admitted (the take-back didn't send)"}: ${p.why}`, what: p.sentence, source: "promise", admitted: p.admitted });
  return id;
}

// ---------------------------------------------------------------- the rollup (team-only dashboard)

export type CommitmentRow = { member: string; goalId: number | null; goal: string; made: number; kept: number; partial: number; missed: number; admitted: number; released: number; open: number; slipped: number; lastAt: string };

// Pure: the rollup from the log rows (one row per event), grouped by member and goal. Withdrawn promises were never made, so they
// don't count. Open = made with no outcome yet.
export function rollupCommitments(events: { user_id: string; member: string; decision: string; action: string | null; task_id: number | null; goal_id: number | null; goal_title: string | null; what: string | null; created_at: Date | string; admitted?: boolean | null }[]): CommitmentRow[] {
  const groups = new Map<string, CommitmentRow & { tasks: Map<number, { made: boolean; outcome: string | null; admitted: boolean }> }>();
  for (const e of events) {
    if (e.task_id == null) continue;
    const key = `${e.user_id}:${e.goal_id ?? "-"}`;
    let g = groups.get(key);
    if (!g) {
      g = { member: e.member, goalId: e.goal_id, goal: e.goal_id != null ? e.goal_title ?? `goal #${e.goal_id}` : "promises outside a goal", made: 0, kept: 0, partial: 0, missed: 0, admitted: 0, released: 0, open: 0, slipped: 0, lastAt: "", tasks: new Map() };
      groups.set(key, g);
    }
    const at = new Date(e.created_at).toISOString();
    if (at > g.lastAt) g.lastAt = at;
    const t = g.tasks.get(e.task_id) ?? { made: false, outcome: null, admitted: false };
    if (e.decision === "commitment.created") t.made = true;
    if (e.decision === "commitment.slipped") g.slipped++;
    if (e.decision === "commitment.outcome") { t.outcome = e.action; t.admitted = e.admitted === true; }
    g.tasks.set(e.task_id, t);
  }
  const out: CommitmentRow[] = [];
  for (const g of groups.values()) {
    for (const t of g.tasks.values()) {
      if (!t.made || t.outcome === "withdrawn") continue;
      g.made++;
      if (t.outcome === "kept") g.kept++;
      else if (t.outcome === "partial") g.partial++;
      else if (t.outcome === "missed") { g.missed++; if (t.admitted) g.admitted++; }
      else if (t.outcome === "released") g.released++;
      else g.open++;
    }
    if (!g.made && !g.slipped) continue;
    const { tasks: _t, ...row } = g;
    out.push(row);
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

// Read only. Team-only: names every member, so only the co-test team route reads it.
export async function commitmentRollup(days = 30): Promise<CommitmentRow[]> {
  const { rows } = await pool.query(
    `SELECT d.user_id, COALESCE(u.first_name, 'member') AS member, d.decision, d.action, (d.proposal->>'taskId')::bigint AS task_id,
            (d.proposal->>'goalId')::bigint AS goal_id, g.title AS goal_title, d.proposal->>'what' AS what, d.created_at, (d.proposal->>'admitted')::boolean AS admitted
       FROM harness_decisions d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN co_goals g ON g.id = (d.proposal->>'goalId')::bigint AND g.user_id = d.user_id
      WHERE d.decision LIKE 'commitment.%' AND d.created_at > NOW() - make_interval(days => $1)
      ORDER BY d.created_at`,
    [days],
  );
  return rollupCommitments(rows.map((r: any) => ({ ...r, task_id: r.task_id != null ? Number(r.task_id) : null, goal_id: r.goal_id != null ? Number(r.goal_id) : null })));
}
