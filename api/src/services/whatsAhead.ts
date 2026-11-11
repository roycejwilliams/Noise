// What's ahead for one member from Co, read from what is really scheduled (Royce, 2026-10-13: "'What's coming up' answers read the
// promise ledger. Co promised a Friday check-in this morning and said 'nothing confirmed' this afternoon. Any scheduled commitment
// (check-ins, follow-ups, sweeps, sends) feeds answers about what's ahead"). One fact line, every turn: the reply drafts from it and
// the reply check's honest fallback reads it (harness/replyGrounding.ts), so neither says nothing is planned while something is.
//   - every open task with a next time ahead, of every kind: work, check-ins and follow-ups (co_tasks; the ledger's commitments are
//     these tasks, services/commitmentLog.ts)
//   - Co's daily search, when it is covering something for them (services/searchCoverage.ts)
//   - finds already queued to go to them (proactive_candidates pending), counted only: each arrives as its own text
import { localStamp } from "./memberTime.js";
import type { SearchCoverage } from "./searchCoverage.js";
import { isCommitment } from "./commitmentLog.js";

// promised: a commitment on the ledger (services/commitmentLog.ts isCommitment): something Co said it would do for them.
// debriefOf: a debrief follow-up's event name (followup.type "debrief"), said as asking whether they made it, never how it went.
export type AheadTask = { id: number; goal: string; kind: string | null; nextCheckAt: string; deadline: string | null; promised?: boolean; debriefOf?: string | null };
export type Ahead = { tasks: AheadTask[]; queuedFinds: number };

const AHEAD_MAX = 8;

// Read through the one source fence (services/sourceFence.ts): Co's own tasks and queue for them. A task whose words the strip
// blanked keeps its place with an empty goal, so aheadLine counts it without showing it.
// A failed read rejects (no ahead line at all, so nothing says "nothing is scheduled" from a read that didn't happen).
export async function loadAhead(userId: string, now = new Date(), given?: import("./sourceFence.js").Fence): Promise<Ahead> {
  const F = await import("./sourceFence.js");
  const fence = given ?? (await F.memberFence(userId));
  const [rows, queuedFinds] = await Promise.all([F.readScheduled(fence, now, AHEAD_MAX), F.readQueuedFindCount(fence)]);
  const tasks = rows.map((x): AheadTask => ({ id: x.id, goal: x.goal ?? "", kind: x.kind, nextCheckAt: x.nextCheckAt, deadline: x.deadline, promised: isCommitment({ source: x.source, followup: x.followup, kind: x.kind }), debriefOf: x.kind === "followup" && x.followup?.type === "debrief" ? String(x.followup?.payload?.eventName ?? "").trim() || null : null }));
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
    // A debrief is only ever "whether they made it" here (2026-11-11: "I'll follow up on how both went" for two events nothing said
    // they went to). The send-time draft decides the rest from the record (harness/proactiveRegistry.ts draftDebrief).
    const debrief = t.debriefOf ? keep(t.debriefOf) : null;
    if (t.kind === "followup" && debrief) parts.push(`a check-in on whether they made it to "${debrief.slice(0, 120)}" (say it that way, never as how it went), on ${when}`);
    else if (t.kind === "followup") parts.push(`a check-in with them, "${goal.slice(0, 140)}", on ${when}`);
    else if (t.kind === "research_brief") parts.push(`research brief #${t.id} "${goal.slice(0, 140)}", next due on Cue's side around ${when}`);
    else if (t.promised) parts.push(`task #${t.id} "${goal.slice(0, 140)}", which Cue committed to them, due around ${when}${t.deadline ? `; their deadline ${t.deadline}` : ""}`);
    else parts.push(`task #${t.id} "${goal.slice(0, 140)}", next due on Cue's side around ${when}${t.deadline ? `; their deadline ${t.deadline}` : ""}`);
  }
  if (withheld) parts.push(`${withheld} more scheduled item${withheld === 1 ? "" : "s"} from Cue (details not shown here)`);
  const searching = coverage.asks.length + coverage.goals.length + (coverage.hidden ?? 0);
  if (searching) parts.push(`Cue's daily search, every morning from 9, for ${searching} thing${searching === 1 ? "" : "s"} they want (listed under what's running)`);
  if (a.queuedFinds) parts.push(`${a.queuedFinds} find${a.queuedFinds === 1 ? "" : "s"} already queued to go to them, each as its own text (don't describe one before it arrives)`);
  if (!parts.length) return "What's ahead for them from Cue: nothing is scheduled (no check-in, follow-up, task or daily search). If they ask what's coming up, say what they've told you is ahead for them, if anything, and that nothing is set on your side.";
  return `What's ahead for them from Cue, as scheduled now: ${parts.join("; ")}. When they ask what's coming up, what's ahead this week or what to look forward to, answer from this and from their own plans; never say nothing is planned or confirmed while this lists something, and only promise to reach them at a time listed as a check-in or a commitment.`;
}
