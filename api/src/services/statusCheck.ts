// Status checks (Royce, 2026-10-13): "A member restating something Co is already doing isn't a stop and isn't a new ask - it's a
// status check. Answer it as one: 'already on it, here's where it stands,' and the search keeps running. No silent stop, no misleading
// note, and the member gets the thing they were actually asking for."
// Co decides, code only suggests (review of this branch, 2026-10-13: a word match that refused saves and starts dropped new requests,
// and turned "stop", "thanks" and "it moved to Nov 5" into status replies):
//   1. A strict pre-filter in code: a sentence of theirs that names an open task of Co's and adds nothing it lacks (every meaning word
//      of the sentence is the task's, the asking, watching and status words left out) makes that task a candidate. Nothing else.
//   2. The reply gets the candidate and where it stands, and decides: asking for it again or how it's going is a status check (already
//      on it, where it stands); changing, stopping, adding to or thanking Co for it, or anything different, is handled as that.
//   3. saveAsk and startTask on a candidate say so once ("this looks like task #N"); called again with differentFrom N, they go
//      through, logged. Nothing is ever refused outright.
//   4. Background ask capture skips a save only when this turn was answered as that task's status check (status_check.turn).
// Everything a member reads from a task here goes through their fence (services/sourceFence.ts); when it can't be read, only the
// task's number and goal. Nothing here writes a task or an ask.
import pool from "../db/db.js";
import { meaningWords } from "./profileExtraction.js";
import { localStamp } from "./memberTime.js";
import type { Strip } from "./sourceFence.js";

// The asking, watching and status words: "how's the X going", "any update on X", "can you draft X" all name X.
const NOT_THE_THING = [
  "keep", "eye", "out", "watch", "watching", "track", "let", "know", "when", "if", "ping", "text", "for", "how", "going", "update", "updates",
  "status", "progress", "coming", "news", "where", "stand", "stands", "done", "yet", "still", "ready", "already", "again", "also", "hey",
  "quick", "check", "on", "do", "doing", "work", "working", "started", "start", "are", "we", "did", "luck", "anything", "along", "with",
  "me", "have", "co",
];

export type OpenWork = { id: number; goal: string; steps: { text: string; done: boolean }[]; notes: { at: string; text: string }[]; planNext: string | null; nextCheckAt: string | null; kind?: string | null; source?: string | null };

const taskWords = (goal: string) => meaningWords(String(goal ?? "").replace(/^[A-Z][a-z ]+:\s*/, ""), NOT_THE_THING);
// Pure: the open task one of their sentences restates, or null. One-sided: the sentence shares at least two of the task's meaning words
// (one when the task has only one) and adds none the task lacks. A suggestion, never a decision.
export function restatedTask<T extends Pick<OpenWork, "id" | "goal" | "source">>(words: string, tasks: readonly T[]): T | null {
  const sentences = String(words ?? "").split(/[.!?\n]+/).map((p) => meaningWords(p, NOT_THE_THING)).filter((s) => s.size);
  let best: { t: T; shared: number } | null = null;
  for (const t of tasks) {
    if (t.source === "lookout") continue;
    const w = taskWords(t.goal);
    if (!w.size) continue;
    for (const p of sentences) {
      const shared = [...p].filter((x) => w.has(x)).length;
      if (shared >= Math.min(2, w.size) && p.size - shared === 0 && (!best || shared > best.shared)) best = { t, shared };
    }
  }
  return best?.t ?? null;
}

const bare = (s: string) => s.trim().replace(/[.\s]+$/, "");
// Pure: where the task stands, through their fence. strip null (the fence couldn't be read): the task's number only.
export function whereItStands(t: OpenWork, zone: string | null, strip: Strip | null): string {
  // The fence couldn't be read: the task's number only, never its goal's words (review, 2026-10-13).
  const goal = strip ? strip(t.goal) : null;
  const head = `Possibly the same as open task #${t.id}${goal ? ` ("${bare(goal)}")` : ""}.`;
  if (!strip) return head;
  const done = t.steps.filter((s) => s.done).map((s) => strip(s.text)).filter((x): x is string => !!x);
  const lastNote = [...t.notes].reverse().find((n) => n.text && !/^Started\.?$/.test(n.text.trim()));
  const last = lastNote ? strip(lastNote.text) : null;
  const next = t.planNext ? strip(t.planNext) : null;
  const parts = [
    head,
    "Where it stands:",
    last ? `latest, ${bare(last)} (${localStamp(lastNote!.at, zone)}).` : lastNote ? null : "started, no progress noted yet.",
    t.steps.length ? `Steps done: ${done.length ? done.map(bare).join("; ") : "none yet"} (${t.steps.filter((s) => s.done).length} of ${t.steps.length}).` : null,
    next ? `Next: ${bare(next)}.` : null,
    t.nextCheckAt ? `Co's next work session on it (not a delivery time): around ${localStamp(t.nextCheckAt, zone)}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}

// What the reply is told with a candidate: Co decides which it is.
export const CANDIDATE_RULE = "Their message may be about an open task of yours (in the facts: \"Possibly the same as open task\"). If they're asking for it again or how it's going, answer as a status check: say you're already on it and where it stands, from those facts; don't start it again or save a new ask, and don't say you stopped anything. If they're changing, stopping, adding to or thanking you for it, or asking for something different, handle that instead and ignore this.";

// Their open work from the turn's own task read (turnContext.ts rawTasks): open, work or follow-up, never a lookout.
export function openWorkFrom<T extends { id: number; goal: string; status: string; steps: any[]; notes: any[]; planNext: string | null; nextCheckAt: string | null; kind?: string | null; source?: string | null }>(tasks: readonly T[]): OpenWork[] {
  return tasks
    .filter((t) => t.status === "open" && (t.kind ?? "work") !== "research_brief" && ["work", "followup"].includes(t.kind ?? "work") && t.source !== "lookout")
    .map((t) => ({ id: t.id, goal: t.goal, steps: t.steps ?? [], notes: t.notes ?? [], planNext: t.planNext, nextCheckAt: t.nextCheckAt, kind: t.kind ?? "work", source: t.source ?? null }));
}

// The tools' read: work tasks and held check-ins, never a lookout.
export async function openWorkFor(userId: string): Promise<OpenWork[]> {
  const { rows } = await pool.query(
    `SELECT id, goal, steps, notes, plan_next, next_check_at, kind, source FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind IN ('work', 'followup') AND COALESCE(source, 'ask') <> 'lookout' ORDER BY created_at DESC LIMIT 12`,
    [userId],
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    goal: String(r.goal ?? ""),
    steps: Array.isArray(r.steps) ? r.steps : [],
    notes: Array.isArray(r.notes) ? r.notes : [],
    planNext: r.plan_next ?? null,
    nextCheckAt: r.next_check_at ? new Date(r.next_check_at).toISOString() : null,
    kind: r.kind ?? null,
    source: r.source ?? null,
  }));
}

// The turn's candidate, or null: the task and where it stands, fenced.
export type StatusCheck = { taskId: number; goal: string; fact: string };
export function statusCheckFor(message: string, work: readonly OpenWork[], zone: string | null, strip: Strip | null): StatusCheck | null {
  const t = restatedTask(message, work);
  return t ? { taskId: t.id, goal: t.goal, fact: whereItStands(t, zone, strip) } : null;
}

// The open work and fence a tool reads before it saves or starts anything: the real ones, none in a dry run, a test's when set.
let testWork: OpenWork[] | null = null;
let testStrip: Strip | null | undefined;
export function setOpenWorkForTests(w: OpenWork[] | null, strip?: Strip | null): void {
  testWork = w;
  testStrip = strip;
}
export async function openWorkForTool(userId: string, dryRun: boolean): Promise<OpenWork[]> {
  if (testWork) return testWork;
  return dryRun ? [] : openWorkFor(userId).catch(() => []);
}
// Their fence's strip, or null when it can't be read (fails closed: number and goal only).
export async function stripForTool(userId: string): Promise<Strip | null> {
  if (testStrip !== undefined) return testStrip;
  const { fenceFrom } = await import("./sourceFence.js");
  const line = await import("./memberSafeMemories.js").then((m) => m.memberSafeLine(userId)).catch(() => null);
  const f = fenceFrom(userId, line);
  return f.failed ? null : f.strip;
}

// The tool result on a candidate, said once: Co decides whether it's the same thing. Asked again without differentFrom: alreadyHeld.
export function looksLike(t: Pick<OpenWork, "id" | "goal">, strip: Strip | null): string {
  const goal = strip ? strip(t.goal) : null;
  return `This looks like task #${t.id}${goal ? ` ("${bare(goal).slice(0, 120)}")` : ""}, already open. If it's the same, answer as a status check (already on it, where it stands) and don't call this again. If it's different, call again with differentFrom: ${t.id}.`;
}

export function alreadyHeld(t: Pick<OpenWork, "id">): string {
  return `Already held as task #${t.id} this turn. Answer as a status check, or call again with differentFrom: ${t.id} if it's different.`;
}

// This turn was answered as a status check for a task (agent/conversationReply.ts): the background ask capture of THIS turn saves no
// new ask that restates it closely (profileExtraction.ts persistIntentFrom). Scoped to the turn by their message; logged for review.
export const STATUS_TURN = "status_check.turn";
export async function statusTurnTasks(userId: string, message: string, db: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT proposal->>'taskId' AS id FROM harness_decisions WHERE user_id = $1 AND decision = $2 AND proposal->>'message' = $3 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId, STATUS_TURN, message.slice(0, 500)],
  );
  return rows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n));
}

// Pure: which task this turn answered as a status check. Only a hold the tools raised that Co never overrode with differentFrom; a
// candidate Co never acted on proves nothing (review, 2026-10-13: Co that judged "different" and just answered was marked status, and
// a broader new ask was dropped). Fail open.
export function answeredAsStatus(o: { raised: number[]; overridden: number[] }): number | null {
  return o.raised.find((id) => !o.overridden.includes(id)) ?? null;
}

// Pure: on a turn answered as a task's status, the captured ask that is that task again: it restates it (adds nothing) AND covers its
// meaning words, every one of three letters or more, with at most one short token (an acronym like "AI") missing. "What's a good wine
// bar?" against "Find a wine bar in Oakland" leaves out Oakland, so it's broader: saved.
export function capturedAskIsTask<T extends Pick<OpenWork, "id" | "goal" | "source">>(text: string, answered: readonly T[]): T | null {
  const t = restatedTask(text, answered);
  if (!t) return null;
  const ask = meaningWords(text, NOT_THE_THING);
  const missing = [...taskWords(t.goal)].filter((w) => !ask.has(w));
  return missing.every((w) => w.length <= 2) && missing.length <= 1 ? t : null;
}
