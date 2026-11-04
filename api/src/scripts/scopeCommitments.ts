// Open commitments that sit outside Cue's purpose (Royce, 2026-11-04: "Existing commitments: never silently abandon or claim finished;
// identify and propose honest closes"). Counts only: no member id, name, text or error text is ever printed.
//
//   npx tsx src/scripts/scopeCommitments.ts --dry-run   counts by kind, nothing changes (the default if nothing is passed)
//   npx tsx src/scripts/scopeCommitments.ts --apply     the honest close, below; run only once Royce has approved the counts
//
// What --apply does, and what it never does:
//   - open tasks (work, follow-up, research brief) outside the boundary: made due now. The next task wake (services/taskTurn.ts
//     runDueTask) re-checks the boundary and closes each one honestly: a member who asked for it gets one line in fresh words through
//     the door, then it closes as dropped; Cue's own look-outs, goal check-ins and follow-ups close quietly. Nothing is texted from this
//     script and nothing is ever marked done.
//   - open asks outside the boundary (find, help, person): their kind becomes "outside" (remembered, never searched, checked in on or
//     looped). The ask is NOT resolved or deleted: Cue still knows what they said.
//   - queued "how was it" follow-ups for programs and undated web finds: dropped without a text.
//   Never touched: member data, goals, memories, reminders members set themselves, anything in scope.
import pool from "../db/db.js";
import { classifyScope, type OutKind } from "../harness/scope.js";
import { memberWaitsOn, scopeOfTask } from "../services/scopeClose.js";
import { isRealEventForFollowUp } from "../services/recommendationOutcome.js";
import type { CoTask } from "../services/coTasks.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type ScopeCounts = {
  tasks: { work: number; followup: number; research_brief: number };
  taskKinds: Partial<Record<OutKind, number>>;
  handBack: number; // the member asked for it (or was promised it): they get one line, then it closes
  closeQuietly: number; // Cue's own look-out, a goal check-in, a follow-up: closes with nothing sent
  asks: { find: number; help: number; person: number; lookout: number };
  askKinds: Partial<Record<OutKind, number>>;
  programFollowUps: number;
};

const bump = <K extends string>(m: Partial<Record<K, number>>, k: K) => void (m[k] = (m[k] ?? 0) + 1);

function taskOf(r: any): CoTask {
  return {
    id: Number(r.id), userId: String(r.user_id), goal: String(r.goal ?? ""), theirWords: String(r.their_words ?? ""),
    steps: Array.isArray(r.steps) ? r.steps : [], planNext: r.plan_next ?? null, kind: r.kind === "followup" ? "followup" : r.kind === "research_brief" ? "research_brief" : "work",
    followup: r.followup ?? null, source: r.source === "promise" ? "promise" : r.source === "lookout" ? "lookout" : "ask",
    lookoutOrigin: r.source === "lookout" ? (r.followup?.lookoutOrigin === "co" || r.followup?.lookoutFrom ? "co" : "member") : null,
  } as unknown as CoTask;
}

// Reads rows, classifies in code (no model), and returns counts. Never returns or logs a row.
export async function scopeCommitmentCounts(db: Db): Promise<{ counts: ScopeCounts; taskIds: number[]; askIds: string[]; followUpIds: string[] }> {
  const counts: ScopeCounts = { tasks: { work: 0, followup: 0, research_brief: 0 }, taskKinds: {}, handBack: 0, closeQuietly: 0, asks: { find: 0, help: 0, person: 0, lookout: 0 }, askKinds: {}, programFollowUps: 0 };
  const taskIds: number[] = [];
  const askIds: string[] = [];
  const followUpIds: string[] = [];
  const tasks = await db.query(`SELECT id, user_id, goal, their_words, steps, plan_next, kind, followup, source FROM co_tasks WHERE status = 'open'`).then((r) => r.rows).catch(() => [] as any[]);
  for (const r of tasks) {
    const t = taskOf(r);
    const sc = scopeOfTask(t);
    if (sc.scope !== "out") continue;
    counts.tasks[t.kind as "work" | "followup" | "research_brief"]++;
    if (sc.kind) bump(counts.taskKinds, sc.kind);
    if (memberWaitsOn(t)) counts.handBack++;
    else counts.closeQuietly++;
    taskIds.push(t.id);
  }
  const asks = await db.query(`SELECT id, ask_text, kind, intent FROM ask_checkins WHERE resolved_at IS NULL AND kind IS DISTINCT FROM 'outside'`).then((r) => r.rows).catch(() => [] as any[]);
  for (const a of asks) {
    const sc = classifyScope(String(a.ask_text ?? ""));
    if (sc.scope !== "out") continue;
    if (a.intent === "lookout") counts.asks.lookout++;
    else if (a.kind === "help" || a.kind === "person") counts.asks[a.kind as "help" | "person"]++;
    else counts.asks.find++;
    if (sc.kind) bump(counts.askKinds, sc.kind);
    askIds.push(String(a.id));
  }
  const fu = await db.query(`SELECT id, match FROM recommendation_outcome_followups WHERE sent_at IS NULL AND (harness_status IS NULL OR harness_status = 'queued')`).then((r) => r.rows).catch(() => [] as any[]);
  for (const f of fu) {
    if (isRealEventForFollowUp(f.match ?? {})) continue;
    counts.programFollowUps++;
    followUpIds.push(String(f.id));
  }
  return { counts, taskIds, askIds, followUpIds };
}

export type Applied = { tasksMadeDue: number; asksMarkedOutside: number; followUpsDropped: number };

export async function applyScopeCommitments(db: Db): Promise<Applied & { before: ScopeCounts }> {
  const { counts, taskIds, askIds, followUpIds } = await scopeCommitmentCounts(db);
  let tasksMadeDue = 0, asksMarkedOutside = 0, followUpsDropped = 0;
  // Due now, nothing else: the next wake does the honest close (hand back or quiet) with the boundary check in code.
  if (taskIds.length) tasksMadeDue = await db.query(`UPDATE co_tasks SET next_check_at = NOW(), updated_at = NOW() WHERE status = 'open' AND id = ANY($1::bigint[])`, [taskIds]).then((r) => r.rowCount ?? 0).catch(() => 0);
  // Remembered, not resolved: only the kind moves.
  if (askIds.length) asksMarkedOutside = await db.query(`UPDATE ask_checkins SET kind = 'outside', kind_checked_at = NOW() WHERE resolved_at IS NULL AND id = ANY($1::uuid[])`, [askIds]).then((r) => r.rowCount ?? 0).catch(() => 0);
  if (followUpIds.length) followUpsDropped = await db.query(`UPDATE recommendation_outcome_followups SET harness_status = 'dropped' WHERE sent_at IS NULL AND id = ANY($1::uuid[])`, [followUpIds]).then((r) => r.rowCount ?? 0).catch(() => 0);
  return { before: counts, tasksMadeDue, asksMarkedOutside, followUpsDropped };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dry = args.includes("--dry-run") || !apply;
  if (apply && args.includes("--dry-run")) {
    console.log("Pass one of --dry-run or --apply, not both. Nothing was done.");
    return;
  }
  if (dry) {
    console.log("dry run (nothing changed):", JSON.stringify((await scopeCommitmentCounts(pool)).counts));
    return;
  }
  console.log("applied:", JSON.stringify(await applyScopeCommitments(pool)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error("scopeCommitments failed:", err?.name ?? "error"); process.exitCode = 1; }).finally(() => pool.end());
}
