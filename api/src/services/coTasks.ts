// Co's own multi-step work, across days (Royce, 2026-09-30: "It can't carry a
// multi-step task across days by its own plan. Scheduled jobs decide when it
// follows up, not Co. Let's fix this gap").
//
// When a member asks for something that takes more than one reply (find a venue
// by Friday, line up sponsors, get them ready for a pitch), Co opens a task: the
// goal in their words, the steps it will take, and when it will next work on it.
// When that time comes Co wakes up with the task, does the next step with its
// tools, decides whether there's anything worth texting them, and chooses when
// to look again, or closes it. Co decides; code holds the lines:
//   - a task opens only with a quote of the member's own words
//   - Co picks its next check-in, between 1 hour and 14 days out
//   - at most 5 open tasks per member, 12 wake-ups and 30 days per task
//   - at most one text per task per 20 hours and two task texts per member a
//     day, inside their hours; texts are drafted only from what the task found
//   - an open task is a scheduled fact, so "I'll look again Thursday" is true
// Owner-scoped: every read and write uses the member's own id.
import pool from "../db/db.js";

export type TaskStep = { text: string; done: boolean };
export type TaskNote = { at: string; text: string };
export type CoTask = {
  id: number;
  userId: string;
  goal: string;
  theirWords: string;
  steps: TaskStep[];
  planNext: string | null;
  nextCheckAt: string | null;
  status: "open" | "done" | "dropped" | "expired";
  wakes: number;
  notes: TaskNote[];
  textsSent: number;
  lastTextedAt: string | null;
  createdAt: string;
};

export const TASK_LIMITS = {
  maxOpen: 5,
  maxWakes: 12,
  maxDays: 30,
  minHours: 1,
  maxHours: 14 * 24,
  textGapHours: 20,
  textsPerMemberPerDay: 2,
  maxSteps: 8,
};

const HOUR = 3_600_000;
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Their words must really be in what they wrote (this message or the ones just before it).
export function wordsAreTheirs(quote: unknown, theirText: string): boolean {
  const q = norm(quote);
  return q.length >= 6 && norm(theirText).includes(q);
}

// Co picks when; code keeps it between an hour and two weeks.
export function clampNextHours(hours: unknown): number {
  const h = Number(hours);
  if (!Number.isFinite(h)) return 24;
  return Math.min(TASK_LIMITS.maxHours, Math.max(TASK_LIMITS.minHours, h));
}

export function cleanSteps(steps: unknown): TaskStep[] {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => (typeof s === "string" ? s : (s as any)?.text))
    .filter((s): s is string => typeof s === "string" && s.trim().length > 2)
    .slice(0, TASK_LIMITS.maxSteps)
    .map((text) => ({ text: text.trim().slice(0, 160), done: false }));
}

// A task past its wake-ups or its days is closed as expired, not left to run.
export function isExhausted(t: Pick<CoTask, "wakes" | "createdAt">, now: Date): boolean {
  return t.wakes >= TASK_LIMITS.maxWakes || now.getTime() - new Date(t.createdAt).getTime() > TASK_LIMITS.maxDays * 24 * HOUR;
}

// May a task text go out now? One per task per 20 hours, two task texts per member a day.
export function mayText(t: Pick<CoTask, "lastTextedAt">, memberTaskTextsToday: number, now: Date): { ok: boolean; why: string | null } {
  if (t.lastTextedAt && now.getTime() - new Date(t.lastTextedAt).getTime() < TASK_LIMITS.textGapHours * HOUR) return { ok: false, why: "already texted them about this task in the last 20 hours" };
  if (memberTaskTextsToday >= TASK_LIMITS.textsPerMemberPerDay) return { ok: false, why: "already sent them two task updates today" };
  return { ok: true, why: null };
}

// What Co reads in every reply: its open work for them, as scheduled facts.
export function taskFactLines(tasks: CoTask[], fmt: (iso: string) => string = (x) => x.slice(0, 16).replace("T", " ") + " UTC"): string[] {
  return tasks
    .filter((t) => t.status === "open")
    .map((t) => {
      const done = t.steps.filter((s) => s.done).map((s) => s.text);
      const left = t.steps.filter((s) => !s.done).map((s) => s.text);
      const last = t.notes.slice(-2).map((n) => n.text);
      return `Co is working on task #${t.id} for them: "${t.goal}" (their words: "${t.theirWords.slice(0, 160)}").${done.length ? ` Done: ${done.join("; ")}.` : ""}${left.length ? ` Still to do: ${left.join("; ")}.` : ""}${last.length ? ` Latest: ${last.join(" / ")}.` : ""}${t.nextCheckAt ? ` Co will work on it next around ${fmt(t.nextCheckAt)}${t.planNext ? `: ${t.planNext}` : ""}.` : ""}`;
    });
}

function rowTo(r: any): CoTask {
  return {
    id: Number(r.id),
    userId: r.user_id,
    goal: r.goal,
    theirWords: r.their_words,
    steps: Array.isArray(r.steps) ? r.steps : [],
    planNext: r.plan_next,
    nextCheckAt: r.next_check_at ? new Date(r.next_check_at).toISOString() : null,
    status: r.status,
    wakes: r.wakes,
    notes: Array.isArray(r.notes) ? r.notes : [],
    textsSent: r.texts_sent,
    lastTextedAt: r.last_texted_at ? new Date(r.last_texted_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function openTasks(userId: string): Promise<CoTask[]> {
  const { rows } = await pool.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT ${TASK_LIMITS.maxOpen}`, [userId]);
  return rows.map(rowTo);
}

export async function getTask(userId: string, id: number): Promise<CoTask | null> {
  const { rows } = await pool.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? rowTo(rows[0]) : null;
}

export async function startTask(input: { userId: string; goal: string; theirWords: string; steps: unknown; firstPlan: string; inHours: unknown }): Promise<{ ok: true; task: CoTask } | { ok: false; why: string }> {
  const open = await openTasks(input.userId);
  if (open.length >= TASK_LIMITS.maxOpen) return { ok: false, why: `already working on ${open.length} things for them; finish or drop one first` };
  const goal = input.goal.trim().slice(0, 200);
  if (goal.length < 4) return { ok: false, why: "the goal is too thin to work on" };
  if (open.some((t) => norm(t.goal) === norm(goal))) return { ok: false, why: "already working on that" };
  const steps = cleanSteps(input.steps);
  const next = new Date(Date.now() + clampNextHours(input.inHours) * HOUR);
  const { rows } = await pool.query(
    `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb) RETURNING *`,
    [input.userId, goal, input.theirWords.trim().slice(0, 400), JSON.stringify(steps), input.firstPlan.trim().slice(0, 240), next, JSON.stringify([{ at: new Date().toISOString(), text: "Started." }])],
  );
  return { ok: true, task: rowTo(rows[0]) };
}

export async function noteOnTask(userId: string, id: number, note: string, doneStep?: string | null): Promise<CoTask | null> {
  const t = await getTask(userId, id);
  if (!t || t.status !== "open") return null;
  const steps = doneStep ? t.steps.map((s) => (norm(s.text) === norm(doneStep) || norm(s.text).includes(norm(doneStep)) ? { ...s, done: true } : s)) : t.steps;
  const notes = [...t.notes, { at: new Date().toISOString(), text: note.trim().slice(0, 300) }].slice(-30);
  const { rows } = await pool.query(`UPDATE co_tasks SET steps = $3::jsonb, notes = $4::jsonb, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *`, [userId, id, JSON.stringify(steps), JSON.stringify(notes)]);
  return rows[0] ? rowTo(rows[0]) : null;
}

export async function scheduleTask(userId: string, id: number, inHours: unknown, plan: string): Promise<CoTask | null> {
  const next = new Date(Date.now() + clampNextHours(inHours) * HOUR);
  const { rows } = await pool.query(
    `UPDATE co_tasks SET next_check_at = $3, plan_next = $4, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open' RETURNING *`,
    [userId, id, next, plan.trim().slice(0, 240)],
  );
  return rows[0] ? rowTo(rows[0]) : null;
}

export async function closeTask(userId: string, id: number, status: "done" | "dropped" | "expired", outcome: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE co_tasks SET status = $3, outcome = $4, closed_at = NOW(), next_check_at = NULL, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`,
    [userId, id, status, outcome.trim().slice(0, 300)],
  );
  return (rowCount ?? 0) > 0;
}

// Tasks due to wake, each claimed so two runs never work the same one.
export async function claimDueTasks(limit = 20): Promise<CoTask[]> {
  const { rows } = await pool.query(
    `UPDATE co_tasks SET next_check_at = NOW() + INTERVAL '45 minutes', wakes = wakes + 1, updated_at = NOW()
     WHERE id IN (SELECT id FROM co_tasks WHERE status = 'open' AND next_check_at <= NOW() ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [limit],
  );
  return rows.map(rowTo);
}

export async function taskTextsToday(userId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'task_update' AND sent_at > NOW() - INTERVAL '24 hours'`, [userId]);
  return rows[0]?.n ?? 0;
}

export async function markTexted(userId: string, id: number): Promise<void> {
  await pool.query(`UPDATE co_tasks SET texts_sent = texts_sent + 1, last_texted_at = NOW() WHERE user_id = $1 AND id = $2`, [userId, id]);
}
