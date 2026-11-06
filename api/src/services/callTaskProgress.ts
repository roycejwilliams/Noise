// What Cue is working on for them, for a call (Royce, 2026-11-06: "how's that search going?" is answered from the record, never
// from a guess). The call context already knew how many tasks are open and their goals (callContext.ts capacity); this adds where
// each one stands, from the task row itself: its goal, the last note, what has gone to them, and when it looks next. Results the task
// merely saw (followup.found) are not shown: they are not vetted or sent, so they are never presented as found. Read-only, owner only, open tasks only, bounded in lines and characters. Nothing here writes or sends.
import { openTasks, type CoTask } from "./coTasks.js";
import { localStamp } from "./memberTime.js";

export const CALL_TASK_PROGRESS = { tasks: 4, lineChars: 330, sectionChars: 1200 };

const bare = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/[ ,;(]+[^ ,;(]*$/, "")}...` : s);

// Pure: a task that belongs on the list. Theirs (asked for, or a promise Cue made) and open; a look-out only when they asked for it.
export function worksForThem(t: Pick<CoTask, "status" | "kind" | "source" | "lookoutOrigin">): boolean {
  if (t.status !== "open" || (t.kind ?? "work") !== "work") return false;
  return t.source !== "lookout" || t.lookoutOrigin === "member";
}

// Pure: one task as one compact line. Says what is on the record and nothing past it.
export function taskProgressLine(t: CoTask, zone: string | null): string {
  const goal = bare(t.goal.replace(/^Keep (?:your word|your promise)[^:]{0,40}:\s*/i, ""));
  const lastNote = [...(t.notes ?? [])].reverse().find((n) => n?.text && !/^Started\.?$/.test(String(n.text).trim()));
  const doneSteps = (t.steps ?? []).filter((s) => s.done);
  const parts = [
    `${cut(goal, 110)}.`,
    lastNote ? `Latest: ${cut(bare(String(lastNote.text)), 130)} (${localStamp(lastNote.at, zone)}).` : "No progress noted yet.",
    t.steps?.length ? `Steps ${doneSteps.length} of ${t.steps.length} done.` : null,
    t.textsSent > 0 ? `Sent them ${t.textsSent} text${t.textsSent === 1 ? "" : "s"}${t.lastTextedAt ? `, last ${localStamp(t.lastTextedAt, zone)}` : ""}.` : "Nothing sent them yet.",
    t.nextCheckAt ? `Next look around ${localStamp(t.nextCheckAt, zone)}.` : null,
  ];
  return cut(`- ${parts.filter(Boolean).join(" ")}`, CALL_TASK_PROGRESS.lineChars);
}

export const CALL_TASK_PROGRESS_HEAD = "What you're working on for them, and where each stands on your record (this is all you know of it: if they ask how one is going, answer from these lines, say plainly when nothing has been sent yet, and never suggest a result you don't have):";

// Pure: the section, or null when nothing is open. Newest task first, capped in tasks and in total size.
export function renderTaskProgress(tasks: readonly CoTask[], zone: string | null): string | null {
  const lines: string[] = [];
  let used = CALL_TASK_PROGRESS_HEAD.length;
  for (const t of tasks.filter(worksForThem).slice(0, CALL_TASK_PROGRESS.tasks)) {
    const line = taskProgressLine(t, zone);
    if (used + line.length + 1 > CALL_TASK_PROGRESS.sectionChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `${CALL_TASK_PROGRESS_HEAD}\n${lines.join("\n")}` : null;
}

// This member's own open tasks (user_id scoped inside openTasks), rendered. A read that fails is no section, never a guess.
export async function callTaskProgress(userId: string, zone: string | null, read: typeof openTasks = openTasks): Promise<string | null> {
  return renderTaskProgress(await read(userId).catch(() => [] as CoTask[]), zone);
}
