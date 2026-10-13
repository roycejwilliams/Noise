// What's ahead for one member from Co, read from what is really scheduled (Royce, 2026-10-13: "'What's coming up' answers read the
// promise ledger. Co promised a Friday check-in this morning and said 'nothing confirmed' this afternoon. Any scheduled commitment
// (check-ins, follow-ups, sweeps, sends) feeds answers about what's ahead"). One fact line, every turn: the reply drafts from it and
// the reply check's honest fallback reads it (harness/replyGrounding.ts), so neither says nothing is planned while something is.
//   - every open task with a next time ahead, of every kind: work, check-ins and follow-ups (co_tasks; the ledger's commitments are
//     these tasks, services/commitmentLog.ts)
//   - Co's daily search, when it is covering something for them (services/searchCoverage.ts)
//   - finds already queued to go to them (proactive_candidates pending), counted only: each arrives as its own text
import pool from "../db/db.js";
import { localStamp } from "./memberTime.js";
import type { SearchCoverage } from "./searchCoverage.js";
import { isCommitment } from "./commitmentLog.js";

// promised: a commitment on the ledger (services/commitmentLog.ts isCommitment): something Co said it would do for them.
export type AheadTask = { id: number; goal: string; kind: string | null; nextCheckAt: string; deadline: string | null; promised?: boolean };
export type Ahead = { tasks: AheadTask[]; queuedFinds: number };

const AHEAD_MAX = 8;

export async function loadAhead(userId: string, now = new Date()): Promise<Ahead> {
  const [tasks, queuedFinds] = await Promise.all([
    pool
      .query(`SELECT id, goal, kind, source, followup, next_check_at, deadline FROM co_tasks WHERE user_id = $1 AND status = 'open' AND next_check_at IS NOT NULL AND next_check_at > $2 ORDER BY next_check_at LIMIT ${AHEAD_MAX}`, [userId, now])
      .then((r) => r.rows.map((x: any): AheadTask => ({ id: Number(x.id), goal: String(x.goal ?? ""), kind: x.kind ?? null, nextCheckAt: new Date(x.next_check_at).toISOString(), deadline: x.deadline ? String(x.deadline instanceof Date ? x.deadline.toISOString().slice(0, 10) : x.deadline) : null, promised: isCommitment({ source: x.source, followup: x.followup, kind: x.kind }) })))
      .catch(() => [] as AheadTask[]),
    pool
      .query(`SELECT count(*)::int AS n FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND type = 'event_offer'`, [userId])
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0),
  ]);
  return { tasks, queuedFinds };
}

// Pure: the one line. keep strips another member's details from a task's words (turnContext's memberSafeLine); a task it blanks is
// still counted, never dropped, so the line never says nothing is scheduled while something is (review of the 10-13 fixes).
// A check-in or follow-up is the time Co reaches out; a commitment on the ledger is said as one; any other task is said as due on
// Co's side around its next time (the Friday branding check-in of 10-13 was a plain work task, so it isn't called internal).
export function aheadLine(a: Ahead, coverage: SearchCoverage, zone: string | null, keep: (s: string) => string | null = (s) => s): string {
  const parts: string[] = [];
  let withheld = 0;
  for (const t of a.tasks) {
    const goal = keep(t.goal);
    if (!goal) { withheld++; continue; }
    const when = localStamp(t.nextCheckAt, zone);
    if (t.kind === "followup") parts.push(`a check-in with them, "${goal.slice(0, 140)}", on ${when}`);
    else if (t.kind === "research_brief") parts.push(`research brief #${t.id} "${goal.slice(0, 140)}", next due on Co's side around ${when}`);
    else if (t.promised) parts.push(`task #${t.id} "${goal.slice(0, 140)}", which Co committed to them, due around ${when}${t.deadline ? `; their deadline ${t.deadline}` : ""}`);
    else parts.push(`task #${t.id} "${goal.slice(0, 140)}", next due on Co's side around ${when}${t.deadline ? `; their deadline ${t.deadline}` : ""}`);
  }
  if (withheld) parts.push(`${withheld} more scheduled item${withheld === 1 ? "" : "s"} from Co (details not shown here)`);
  const searching = coverage.asks.length + coverage.goals.length + (coverage.hidden ?? 0);
  if (searching) parts.push(`Co's daily search, every morning from 9, for ${searching} thing${searching === 1 ? "" : "s"} they want (listed under what's running)`);
  if (a.queuedFinds) parts.push(`${a.queuedFinds} find${a.queuedFinds === 1 ? "" : "s"} already queued to go to them, each as its own text (don't describe one before it arrives)`);
  if (!parts.length) return "What's ahead for them from Co: nothing is scheduled (no check-in, follow-up, task or daily search). If they ask what's coming up, say what they've told you is ahead for them, if anything, and that nothing is set on your side.";
  return `What's ahead for them from Co, as scheduled now: ${parts.join("; ")}. When they ask what's coming up, what's ahead this week or what to look forward to, answer from this and from their own plans; never say nothing is planned or confirmed while this lists something, and only promise to reach them at a time listed as a check-in or a commitment.`;
}
