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
//   - a deadline they gave ("by Friday") is stored; no check-in is scheduled past
//     the morning of it, and that last check always tells them where it stands
//   - when they reply to a task's text, the task wakes within minutes
// Owner-scoped: every read and write uses the member's own id.
import { DateTime } from "luxon";
import { parseAskWindow } from "./askWindow.js";
import pool from "../db/db.js";
import { localStamp, windowLine, type CommitWindow } from "./memberTime.js";

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
  deadline: string | null; // YYYY-MM-DD, their day
  finalCheckAt: string | null; // the morning of the deadline, their time
  finalTold: boolean;
  awaitingReply: boolean;
  theirReplyAt: string | null;
  // "followup": a check-in Co decides the timing of (services/followUps.ts).
  // "research_brief": a find and a document, run as a fixed sequence (services/researchBrief.ts), not a model loop.
  kind?: "work" | "followup" | "research_brief";
  followup?: any;
  targetKey?: string | null;
  // Where it came from: what they asked for, or a promise Co made in a reply (services/promises.ts).
  source?: "ask" | "promise";
  // A commitment's window in their local time (services/memberTime.ts), kept in the row's followup JSON (work tasks don't use it
  // otherwise): when Co said they'd have it, and the last moment Co can still tell them inside it.
  window?: CommitWindow | null;
};

// Pure: a work task's commitment window, from its followup JSON.
export function windowOf(followup: any): CommitWindow | null {
  const w = followup?.window;
  return w && typeof w.deadline === "string" && typeof w.warnBy === "string" ? (w as CommitWindow) : null;
}

// Pure: the first check of a commitment lands inside its window: no later than its warn-by (a "tonight" promise made at 6pm is
// worked before 7:40pm, not at 10pm), and never sooner than five minutes out.
export function firstCheckInWindow(next: Date, w: CommitWindow | null | undefined, now: Date): Date {
  if (!w) return next;
  const by = new Date(w.warnBy).getTime();
  return by < next.getTime() ? new Date(Math.max(by - 10 * 60_000, now.getTime() + 5 * 60_000)) : next;
}

export const TASK_LIMITS = {
  maxOpen: 5,
  maxWakes: 12,
  maxDays: 30,
  minHours: 1,
  maxHours: 14 * 24,
  textGapHours: 20,
  textsPerMemberPerDay: 2,
  maxSteps: 8,
  maxDeadlineDays: 60,
  finalCheckHour: 10,
  wakeAfterReplyMinutes: 3,
};

const HOUR = 3_600_000;
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Their words must really be in what they wrote (this message or the ones just before it).
export function wordsAreTheirs(quote: unknown, theirText: string): boolean {
  const q = norm(quote);
  return q.length >= 6 && norm(theirText).includes(q);
}

// A short yes to Co's own offer ("want me to check in after?" / "yes") is the member asking: the quote
// check needs six characters, which "yes" and "sure" never have.
const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|sounds good|that would be great|yes please|go ahead|definitely|absolutely)[.!]*$/i;
export function isYesToOffer(message: string, lastCoMessage: string | null | undefined): boolean {
  return YES.test(message.trim()) && /\b(?:check in|check on|follow up|how it went|ping you|text you)\b/i.test(lastCoMessage ?? "") && /\?\s*$/.test((lastCoMessage ?? "").trim());
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
export function isExhausted(t: Pick<CoTask, "wakes" | "createdAt"> & Partial<Pick<CoTask, "finalCheckAt" | "finalTold">>, now: Date): boolean {
  const pastDeadline = !!t.finalCheckAt && !!t.finalTold && now.getTime() - new Date(t.finalCheckAt).getTime() > 2 * 24 * HOUR;
  return t.wakes >= TASK_LIMITS.maxWakes || now.getTime() - new Date(t.createdAt).getTime() > TASK_LIMITS.maxDays * 24 * HOUR || pastDeadline;
}

// A deadline they gave: a real date, in their words, not in the past, within 60 days.
// The last check is the morning of it (10am their time), or an hour from now if that's passed.
export function planDeadline(input: { date: unknown; words: unknown }, theirText: string, zone: string | null, now: Date): { ok: true; deadline: string; finalCheckAt: string } | { ok: false; why: string } {
  const date = typeof input.date === "string" ? input.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, why: "the deadline isn't a date" };
  if (!wordsAreTheirs(input.words, theirText)) return { ok: false, why: "the deadline has to come from their own words" };
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const today = DateTime.fromJSDate(now).setZone(z).startOf("day");
  const day = DateTime.fromISO(date, { zone: z }).startOf("day");
  if (!day.isValid) return { ok: false, why: "the deadline isn't a date" };
  if (day < today) return { ok: false, why: "the deadline has already passed" };
  if (day.diff(today, "days").days > TASK_LIMITS.maxDeadlineDays) return { ok: false, why: "the deadline is too far out" };
  const morning = day.set({ hour: TASK_LIMITS.finalCheckHour });
  const final = morning.toMillis() > now.getTime() + HOUR ? morning.toJSDate() : new Date(now.getTime() + HOUR);
  return { ok: true, deadline: date, finalCheckAt: final.toISOString() };
}

// A deadline in their own words that Co left off the task ("I need options by
// Friday", 2026-09-30). Only after "by", "before", "no later than" or "due", so an
// event's own date ("my Oct 10 party") is never read as a deadline.
export function deadlineFromWords(theirText: string, zone: string | null, now: Date): { date: string; words: string } | null {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  for (const m of theirText.matchAll(/\b(by|before|no later than|due)\s+([^.,;!?\n]{2,30})/gi)) {
    const w = parseAskWindow(m[2], DateTime.fromJSDate(now).setZone(z));
    if (!w) continue;
    const date = w.end.toISODate();
    if (date) return { date, words: m[0].trim() };
  }
  return null;
}

// No check-in past the last one before the deadline.
export function capToFinal(next: Date, t: Partial<Pick<CoTask, "finalCheckAt" | "finalTold">>): { at: Date; capped: boolean } {
  if (!t.finalCheckAt || t.finalTold) return { at: next, capped: false };
  const f = new Date(t.finalCheckAt);
  return next.getTime() > f.getTime() ? { at: f, capped: true } : { at: next, capped: false };
}

// The last check before the deadline, not yet told.
export function isFinalCheck(t: Partial<Pick<CoTask, "finalCheckAt" | "finalTold">>, now: Date): boolean {
  return !!t.finalCheckAt && !t.finalTold && now.getTime() >= new Date(t.finalCheckAt).getTime() - 10 * 60_000;
}

// May a task text go out now? One per task per 20 hours, two task texts per member a day.
export function mayText(t: Pick<CoTask, "lastTextedAt"> & Partial<Pick<CoTask, "theirReplyAt" | "finalCheckAt" | "finalTold">>, memberTaskTextsToday: number, now: Date): { ok: boolean; why: string | null } {
  // The last check before their deadline always gets to tell them where it stands.
  if (isFinalCheck(t, now)) return { ok: true, why: null };
  // They answered the last task text: it's a conversation, the 20-hour gap doesn't apply.
  const theyReplied = !!t.theirReplyAt && (!t.lastTextedAt || new Date(t.theirReplyAt).getTime() > new Date(t.lastTextedAt).getTime());
  if (!theyReplied && t.lastTextedAt && now.getTime() - new Date(t.lastTextedAt).getTime() < TASK_LIMITS.textGapHours * HOUR) return { ok: false, why: "already texted them about this task in the last 20 hours" };
  if (memberTaskTextsToday >= TASK_LIMITS.textsPerMemberPerDay) return { ok: false, why: "already sent them two task updates today" };
  return { ok: true, why: null };
}

// What Co reads in every reply: its open work for them, as scheduled facts.
// Times are in their local time when their zone is given (services/memberTime.ts), never bare UTC.
export function taskFactLines(tasks: CoTask[], fmt: (iso: string) => string = (x) => x.slice(0, 16).replace("T", " ") + " UTC", zone?: string | null): string[] {
  if (zone !== undefined) fmt = (x) => localStamp(x, zone);
  return tasks
    .filter((t) => t.status === "open")
    .map((t) => {
      const done = t.steps.filter((s) => s.done).map((s) => s.text);
      const left = t.steps.filter((s) => !s.done).map((s) => s.text);
      const last = t.notes.slice(-2).map((n) => n.text);
      return `Co is working on task #${t.id} for them: "${t.goal}" (their words: "${t.theirWords.slice(0, 160)}").${done.length ? ` Done: ${done.join("; ")}.` : ""}${left.length ? ` Still to do: ${left.join("; ")}.` : ""}${last.length ? ` Latest: ${last.join(" / ")}.` : ""}${t.deadline ? ` Their deadline: ${t.deadline}${t.finalCheckAt && !t.finalTold ? `; Co's last check before it, where it tells them where things stand, is around ${fmt(t.finalCheckAt)}` : ""}.` : ""}${t.nextCheckAt ? ` Co will work on it next around ${fmt(t.nextCheckAt)}${t.planNext ? `: ${t.planNext}` : ""}.` : ""}${t.window && !t.window.closedAt ? ` ${windowLine(t.window)}` : ""}`;
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
    deadline: r.deadline ? DateTime.fromJSDate(new Date(r.deadline), { zone: "utc" }).toISODate() : null,
    finalCheckAt: r.final_check_at ? new Date(r.final_check_at).toISOString() : null,
    finalTold: !!r.final_told,
    awaitingReply: !!r.awaiting_reply,
    theirReplyAt: r.their_reply_at ? new Date(r.their_reply_at).toISOString() : null,
    kind: r.kind === "followup" ? "followup" : r.kind === "research_brief" ? "research_brief" : "work",
    followup: r.followup ?? null,
    targetKey: r.target_key ?? null,
    source: r.source === "promise" ? "promise" : "ask",
    window: r.kind === "followup" || r.kind === "research_brief" ? null : windowOf(r.followup),
  };
}

export async function openTasks(userId: string): Promise<CoTask[]> {
  const { rows } = await pool.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind = 'work' ORDER BY created_at DESC LIMIT ${TASK_LIMITS.maxOpen}`, [userId]);
  return rows.map(rowTo);
}

export async function getTask(userId: string, id: number): Promise<CoTask | null> {
  const { rows } = await pool.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? rowTo(rows[0]) : null;
}

export async function startTask(input: { userId: string; goal: string; theirWords: string; steps: unknown; firstPlan: string; inHours: unknown; deadline?: { deadline: string; finalCheckAt: string } | null; source?: "ask" | "promise"; window?: CommitWindow | null }): Promise<{ ok: true; task: CoTask } | { ok: false; why: string }> {
  const open = await openTasks(input.userId);
  if (open.length >= TASK_LIMITS.maxOpen) return { ok: false, why: `already working on ${open.length} things for them; finish or drop one first` };
  const goal = input.goal.trim().slice(0, 200);
  if (goal.length < 4) return { ok: false, why: "the goal is too thin to work on" };
  if (open.some((t) => norm(t.goal) === norm(goal))) return { ok: false, why: "already working on that" };
  const steps = cleanSteps(input.steps);
  const dl = input.deadline ?? null;
  const next = firstCheckInWindow(capToFinal(new Date(Date.now() + clampNextHours(input.inHours) * HOUR), { finalCheckAt: dl?.finalCheckAt ?? null, finalTold: false }).at, input.window, new Date());
  const { rows } = await pool.query(
    `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes, deadline, final_check_at, source, followup)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb) RETURNING *`,
    [input.userId, goal, input.theirWords.trim().slice(0, 400), JSON.stringify(steps), input.firstPlan.trim().slice(0, 240), next, JSON.stringify([{ at: new Date().toISOString(), text: "Started." }]), dl?.deadline ?? null, dl?.finalCheckAt ?? null, input.source ?? "ask", input.window ? JSON.stringify({ window: input.window }) : null],
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
  const t = await getTask(userId, id);
  if (!t || t.status !== "open") return null;
  const c = capToFinal(new Date(Date.now() + clampNextHours(inHours) * HOUR), t);
  const finalPlan = c.capped ? `Last check before their deadline (${t.deadline}): tell them plainly where it stands. Then: ${plan}` : plan;
  const { rows } = await pool.query(
    `UPDATE co_tasks SET next_check_at = $3, plan_next = $4, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open' RETURNING *`,
    [userId, id, c.at, finalPlan.trim().slice(0, 320)],
  );
  return rows[0] ? rowTo(rows[0]) : null;
}

export async function markFinalTold(userId: string, id: number): Promise<void> {
  await pool.query(`UPDATE co_tasks SET final_told = true, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [userId, id]);
}

// They texted after a task texted them: that task wakes in a few minutes, after
// the reply to their message has gone out (routes/sendblue.ts). Returns how many woke.
export async function wakeOnReply(userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE co_tasks SET awaiting_reply = false, their_reply_at = NOW(),
       next_check_at = LEAST(COALESCE(next_check_at, NOW() + INTERVAL '${TASK_LIMITS.wakeAfterReplyMinutes} minutes'), NOW() + INTERVAL '${TASK_LIMITS.wakeAfterReplyMinutes} minutes'), updated_at = NOW()
     WHERE user_id = $1 AND status = 'open' AND awaiting_reply AND kind = 'work'`,
    [userId],
  );
  return rowCount ?? 0;
}

// Closing a task closes its window too (followup.window.closedAt), so nothing warns about a commitment that's finished.
export async function closeTask(userId: string, id: number, status: "done" | "dropped" | "expired", outcome: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE co_tasks SET status = $3, outcome = $4, closed_at = NOW(), next_check_at = NULL, updated_at = NOW(),
       followup = CASE WHEN kind = 'work' AND followup ? 'window' THEN jsonb_set(followup, '{window,closedAt}', to_jsonb(NOW())) ELSE followup END
     WHERE user_id = $1 AND id = $2 AND status = 'open'`,
    [userId, id, status, outcome.trim().slice(0, 300)],
  );
  return (rowCount ?? 0) > 0;
}

// A commitment's window, set or replaced (a work task's followup JSON only).
export async function setTaskWindow(userId: string, id: number, window: CommitWindow): Promise<void> {
  await pool.query(
    `UPDATE co_tasks SET followup = jsonb_set(COALESCE(followup, '{}'::jsonb), '{window}', $3::jsonb), updated_at = NOW() WHERE user_id = $1 AND id = $2 AND kind = 'work'`,
    [userId, id, JSON.stringify(window)],
  );
}

// The next check at an exact moment (a commitment moved to their morning after a miss warning).
export async function scheduleTaskAt(userId: string, id: number, at: Date, plan: string): Promise<CoTask | null> {
  const { rows } = await pool.query(
    `UPDATE co_tasks SET next_check_at = $3, plan_next = $4, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open' RETURNING *`,
    [userId, id, at, plan.trim().slice(0, 320)],
  );
  return rows[0] ? rowTo(rows[0]) : null;
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
  await pool.query(`UPDATE co_tasks SET texts_sent = texts_sent + 1, last_texted_at = NOW(), awaiting_reply = true WHERE user_id = $1 AND id = $2`, [userId, id]);
}

// A research brief the member asked for (agent/loopTools.ts researchBrief): due now, run once in the background.
export async function startResearchBrief(input: { userId: string; theirWords: string; goal: string; params: Record<string, unknown> }): Promise<{ ok: true; task: CoTask } | { ok: false; why: string }> {
  const open = await openTasks(input.userId);
  if (open.length >= TASK_LIMITS.maxOpen) return { ok: false, why: `already working on ${open.length} things for them; finish or drop one first` };
  if (open.some((t) => t.kind === "research_brief")) return { ok: false, why: "a research brief is already being put together for them" };
  const { rows } = await pool.query(
    `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes, kind, followup, source)
     VALUES ($1, $2, $3, '[]'::jsonb, 'research and send the brief', NOW(), $4::jsonb, 'research_brief', $5::jsonb, 'ask') RETURNING *`,
    [input.userId, input.goal.trim().slice(0, 200), input.theirWords.trim().slice(0, 400), JSON.stringify([{ at: new Date().toISOString(), text: "Started." }]), JSON.stringify(input.params)],
  );
  return { ok: true, task: rowTo(rows[0]) };
}
