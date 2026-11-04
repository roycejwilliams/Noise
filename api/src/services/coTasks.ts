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
  // "research_brief": retired (2026-11-04, with the document layer); old rows are read as history and closed unsent when they come due.
  kind?: "work" | "followup" | "research_brief";
  followup?: any;
  targetKey?: string | null;
  // A job dispatched during a call (services/callTools.ts): the call and the need, so the same need asked again on the same call is
  // this job, never a second one (dispatchKeyFor). Null for every other task.
  dispatchKey?: string | null;
  // Where it came from: what they asked for, a promise Co made in a reply (services/promises.ts), or a look-out Co said on a call
  // it would keep (harness/callGrounding.ts openPromiseThread): its own kind, outside the send-promise cap and checks.
  source?: "ask" | "promise" | "lookout";
  // A commitment's window in their local time (services/memberTime.ts), kept in the row's followup JSON (work tasks don't use it
  // otherwise): when Co said they'd have it, and the last moment Co can still tell them inside it.
  window?: CommitWindow | null;
  // A look-out's origin, recorded when it opens (Royce, 2026-10-09), so the send path never infers it: "member" when they asked
  // for it ("let me know when...", "keep an eye out for X", or yes to Co's offer to), whose finds are deliveries and never count
  // toward backoff; "co" when it came from Co's own promise ("you'll hear from me"), whose finds count like sweep finds.
  lookoutOrigin?: LookoutOrigin | null;
  // How it closed, in a line (co_tasks.outcome), once it has.
  outcome?: string | null;
};
export type LookoutOrigin = "member" | "co";

// Pure: a look-out's origin from its followup JSON. A look-out with none recorded (opened before origins) is Co's: until #131 the
// only look-outs were Co's own call promises (harness/callGrounding.ts openPromiseThread).
export function lookoutOriginOf(source: string | null | undefined, followup: any): LookoutOrigin | null {
  if (source !== "lookout") return null;
  return followup?.lookoutOrigin === "member" ? "member" : "co";
}

// Pure: a look that began as a new member's first read whose text promised nothing (services/theDoor.ts settleFirstRead): Co's own
// look, never promised and never said on a call, so nothing about it may read as a promise Co made. Only rows from before 2026-10-13:
// such a first look is withdrawn now, never kept as a lookout (Royce: "no exception"); the readers stay for the rows still open.
export const isDoorLook = (t: { followup?: any }): boolean => t.followup?.lookoutFrom === "first_read";

// Pure: a work task's commitment window, from its followup JSON.
export function windowOf(followup: any): CommitWindow | null {
  const w = followup?.window;
  return w && typeof w.deadline === "string" && typeof w.warnBy === "string" ? (w as CommitWindow) : null;
}

// Pure: the first check of a commitment lands inside its window: no later than its warn-by (a "tonight" promise made at 6pm is
// worked before 8:40pm, not at 10pm), and never sooner than five minutes out.
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
  return YES.test(message.trim()) && /\b(?:check in|check on|follow up|how it went|ping you|text you)\b/i.test(lastCoMessage ?? "") && /\?\s*$/.test((lastCoMessage ?? "").trim()) || isYesToWatchOffer(message, lastCoMessage);
}

// Asking Co to watch over time, in their words (Royce, 2026-10-09: "let me know when...", "keep an eye out for X").
export const WATCH_ASK = /\b(?:let me know (?:when|if)|keep an eye out|keep (?:an )?eye on|keep (?:me )?posted|keep me in the loop|tell me when|(?:text|ping|message|hit) me (?:up )?(?:when|if)|look(?:ing)? out for|watch (?:out )?for|heads up (?:when|if)|be on the lookout)\b/i;
// A watching offer from Co ("want me to keep an eye out for...?", "should I let you know when...?").
const WATCH_OFFER = /\b(?:keep an eye out|keep (?:an )?eye on|let you know (?:when|if)|text you (?:when|if)|ping you (?:when|if)|watch for|look out for|on the lookout|keep (?:you )?posted)\b/i;
// Pure: the watching offer in a text Co sent ("Want me to keep an eye out for founder runs?"), or null: a question that offers to watch.
// Co offering, not asking about someone else ("Did Maya let you know when it starts?" isn't an offer; re-review of #131).
const OFFER_FRAME = /\b(?:want me to|do you want me to|should i|shall i|would you like me to|i can|i could|happy to)\b/i;
export function watchOfferIn(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) if (/\?\s*["')\]]*$/.test(sentence.trim()) && WATCH_OFFER.test(sentence) && OFFER_FRAME.test(sentence)) return sentence.trim();
  return null;
}
export function isYesToWatchOffer(message: string, lastCoMessage: string | null | undefined): boolean {
  return YES.test(message.trim()) && watchOfferIn((lastCoMessage ?? "").trim()) !== null;
}

// Pure: a look-out is theirs only when they asked to be told over time, now: their current message asks Co to watch (and the quote
// is from it), or it's a yes to Co's offer to watch (review of #131: any quote of theirs plus a model's lookout flag made one,
// exempt from all restraint). Anything else the model calls a look-out is Co's, and its finds are counted.
// offerLogged: the offer they said yes to is on the ledger as a find (proactive.ts recordReplyWatchOffer). A yes to an offer that was
// never counted (one in a proactive or task text) opens Co's look-out, not theirs (re-review of #131: Co pays to open the door).
export function lookoutOriginAt(o: { message: string; quote: string; lastCoMessage: string | null | undefined; offerLogged?: boolean }): LookoutOrigin {
  if (isYesToWatchOffer(o.message, o.lastCoMessage)) return o.offerLogged ? "member" : "co";
  return WATCH_ASK.test(o.message) && wordsAreTheirs(o.quote, o.message) ? "member" : "co";
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
export function mayText(t: Pick<CoTask, "lastTextedAt"> & Partial<Pick<CoTask, "theirReplyAt" | "finalCheckAt" | "finalTold" | "source">>, memberTaskTextsToday: number, now: Date): { ok: boolean; why: string | null } {
  // The last check before their deadline always gets to tell them where it stands.
  if (isFinalCheck(t, now)) return { ok: true, why: null };
  // The first text of a promise is the thing Co said it would send: the delivery, not an update, so the daily cap on updates
  // never holds it back (2026-10-08, Royce's call: the run link and shortlist were ready and blocked by "two task updates today",
  // and a "nothing yet" warning went out instead).
  if (t.source === "promise" && !t.lastTextedAt) return { ok: true, why: null };
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
      return `Cue is working on task #${t.id} for them: "${t.goal}" (their words: "${t.theirWords.slice(0, 160)}").${done.length ? ` Done: ${done.join("; ")}.` : ""}${left.length ? ` Still to do: ${left.join("; ")}.` : ""}${last.length ? ` Latest: ${last.join(" / ")}.` : ""}${t.deadline ? ` Their deadline: ${t.deadline}${t.finalCheckAt && !t.finalTold ? `; Cue's last check before it, where it tells them where things stand, is around ${fmt(t.finalCheckAt)}` : ""}.` : ""}${t.nextCheckAt ? ` Cue will work on it next around ${fmt(t.nextCheckAt)}${t.planNext ? `: ${t.planNext}` : ""}.` : ""}${t.window && !t.window.closedAt ? ` ${windowLine(t.window)}` : ""}`;
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
    dispatchKey: r.dispatch_key ?? null,
    source: r.source === "promise" ? "promise" : r.source === "lookout" ? "lookout" : "ask",
    window: r.kind === "followup" || r.kind === "research_brief" ? null : windowOf(r.followup),
    lookoutOrigin: lookoutOriginOf(r.source, r.followup),
    outcome: r.outcome ?? null,
  };
}

type TaskDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export async function openTasks(userId: string, db: TaskDb = pool): Promise<CoTask[]> {
  const { rows } = await db.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind = 'work' ORDER BY created_at DESC LIMIT ${TASK_LIMITS.maxOpen}`, [userId]);
  return rows.map(rowTo);
}

export async function getTask(userId: string, id: number): Promise<CoTask | null> {
  const { rows } = await pool.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? rowTo(rows[0]) : null;
}

// Pure: what a new task keeps in its followup JSON: its window, and a look-out's origin (always recorded; Co's unless told).
// A goal's piece or check-in (services/goalOwnership.ts) carries its goal: goalId, the item, and for a check-in what it is for.
export type GoalLink = { goalId: number; goalTitle: string; item?: number; checkin?: "checkin" | "reminder"; at?: string; reminders?: string[]; moment?: GoalMoment | null };
// The dated moment a goal is for, in their words ("the show is Nov 8"): YYYY-MM-DD, their day.
export type GoalMoment = { date: string; words: string };
export function followupJson(input: { source?: string; lookoutOrigin?: LookoutOrigin; window?: CommitWindow | null; goalLink?: GoalLink | null }): string | null {
  const f: Record<string, unknown> = {};
  if (input.window) f.window = input.window;
  if (input.source === "lookout") f.lookoutOrigin = input.lookoutOrigin ?? "co";
  if (input.goalLink) Object.assign(f, { goalId: input.goalLink.goalId, goalTitle: input.goalLink.goalTitle.slice(0, 200), ...(input.goalLink.item != null ? { goalItem: input.goalLink.item } : {}), ...(input.goalLink.moment ? { goalMoment: input.goalLink.moment } : {}), ...(input.goalLink.checkin ? { checkin: input.goalLink.checkin, checkinAt: input.goalLink.at ?? null, reminders: input.goalLink.reminders ?? [] } : {}) });
  return Object.keys(f).length ? JSON.stringify(f) : null;
}

// Starting a task reads what's open, then inserts (concurrency audit, 2026-10-12): two starts at once (a call's after-processing and a
// text turn, payloadFirst and the reply) both passed the same-goal check and the cap (39 of 40 doubled; 6 open against a cap of 5).
// Both starts run under one lock per member, on one connection, so the second sees the first.
async function underTaskLock<T>(userId: string, fn: (db: TaskDb) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`co_tasks:start:${userId}`]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// exactAt: a check-in Co agreed to at a set moment (goalOwnership.ts), kept to that moment rather than rounded to hours.
// Pure: a call job's key (Royce, 2026-11-02: "A dispatched job must survive disconnects, session end and retries without duplicate
// work"): the call, and the need as its goal's own words (lowercased, sorted, once each), so the same need started again on the same
// call, in the same words in any order, is the same job. Reworded, it's caught by the open-task check (agent/conversationTools.ts
// statusCandidate), which Cue decides on.
const KEY_PLAIN = new Set("that this those these with what when where them they their your from have just also about into over then than some more find look looking research send text them help find".split(" "));
export function dispatchKeyFor(callKey: string, goal: string): string {
  const need = [...new Set(goal.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, "").replace(/(?<=\w{3})s$/, "")).filter((w) => w.length >= 3 && !KEY_PLAIN.has(w)))].sort().join(" ");
  return `call:${callKey}:${need}`.slice(0, 300);
}

// The open job this call already started for this need, if any (read before any other check, so a repeat is the same job).
export async function openCallJob(userId: string, dispatchKey: string, db: TaskDb = pool): Promise<CoTask | null> {
  const { rows } = await db.query(`SELECT * FROM co_tasks WHERE user_id = $1 AND dispatch_key = $2 AND status = 'open' ORDER BY id LIMIT 1`, [userId, dispatchKey]);
  return rows[0] ? rowTo(rows[0]) : null;
}

export async function startTask(input: { userId: string; goal: string; theirWords: string; steps: unknown; firstPlan: string; inHours: unknown; deadline?: { deadline: string; finalCheckAt: string } | null; source?: "ask" | "promise" | "lookout"; lookoutOrigin?: LookoutOrigin; window?: CommitWindow | null; goalLink?: GoalLink | null; exactAt?: Date | null; dispatchKey?: string | null }): Promise<{ ok: true; task: CoTask; existing?: boolean } | { ok: false; why: string }> {
  const r = await underTaskLock(input.userId, (db) => startTaskLocked(input, db));
  // The commitment ledger (services/commitmentLog.ts): a promise, a call look-out or a goal's piece is logged with its fire time.
  if (r.ok && !r.existing) {
    const L = await import("./commitmentLog.js");
    if (L.isCommitment(r.task)) await L.logCommitment("created", { userId: r.task.userId, taskId: r.task.id, goalId: r.task.followup?.goalId ?? null, fireAt: r.task.nextCheckAt, what: r.task.goal, source: r.task.source ?? null });
  }
  return r;
}
async function startTaskLocked(input: Parameters<typeof startTask>[0], db: TaskDb): Promise<{ ok: true; task: CoTask; existing?: boolean } | { ok: false; why: string }> {
  // The same need already started on this call (a retry, a repeat, a turn run again): that job, as it is. Read under the lock, so two
  // starts at once never both insert; the unique index (db/migrations.ts) is the backstop.
  if (input.dispatchKey) {
    const same = await openCallJob(input.userId, input.dispatchKey, db);
    if (same) return { ok: true, task: same, existing: true };
  }
  const open = await openTasks(input.userId, db);
  if (open.length >= TASK_LIMITS.maxOpen) return { ok: false, why: `already working on ${open.length} things for them; finish or drop one first` };
  const goal = input.goal.trim().slice(0, 200);
  if (goal.length < 4) return { ok: false, why: "the goal is too thin to work on" };
  if (open.some((t) => norm(t.goal) === norm(goal))) return { ok: false, why: "already working on that" };
  const steps = cleanSteps(input.steps);
  const dl = input.deadline ?? null;
  const exact = input.exactAt && input.exactAt.getTime() > Date.now() && input.exactAt.getTime() - Date.now() <= TASK_LIMITS.maxHours * HOUR ? input.exactAt : null;
  const next = exact ?? firstCheckInWindow(capToFinal(new Date(Date.now() + clampNextHours(input.inHours) * HOUR), { finalCheckAt: dl?.finalCheckAt ?? null, finalTold: false }).at, input.window, new Date());
  const { rows } = await db.query(
    `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes, deadline, final_check_at, source, followup, dispatch_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12) RETURNING *`,
    [input.userId, goal, input.theirWords.trim().slice(0, 400), JSON.stringify(steps), input.firstPlan.trim().slice(0, 240), next, JSON.stringify([{ at: new Date().toISOString(), text: "Started." }]), dl?.deadline ?? null, dl?.finalCheckAt ?? null, input.source ?? "ask", followupJson(input), input.dispatchKey ?? null],
  );
  return { ok: true, task: rowTo(rows[0]) };
}

// evenClosed: a record that must land whatever the task's state (a text queued at the door that never went, harness/door.ts).
export async function noteOnTask(userId: string, id: number, note: string, doneStep?: string | null, opts: { evenClosed?: boolean } = {}): Promise<CoTask | null> {
  const t = await getTask(userId, id);
  if (!t || (t.status !== "open" && !opts.evenClosed)) return null;
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
// A commitment's close is its outcome in the ledger (services/commitmentLog.ts): kept, partial, missed, released or withdrawn.
// theirWord: the member's own words that closed it ("we booked it", "don't need it anymore"), quoted and checked by the caller. Only
// that makes a drop "released"; without it a drop counts against Co (commitmentLog.ts outcomeOf).
// A task turn's close passes their word this way (the turn's close is one line its checks read): held for that task's next close only.
const theirWordAtClose = new Map<string, string>();
export function closedOnTheirWord(userId: string, id: number, quote: string): void {
  theirWordAtClose.set(`${userId}:${id}`, quote);
}
// logWords false: their word decides the outcome (released), but only ids go in the log. cascade false: the goal Cue carries for them is
// never settled by this close (a close that only went with something they dropped; review of #351).
export async function closeTask(userId: string, id: number, status: "done" | "dropped" | "expired", outcome: string, opts: { theirWord?: string | null; logWords?: boolean; cascade?: boolean } = {}): Promise<boolean> {
  const held = theirWordAtClose.get(`${userId}:${id}`) ?? null;
  theirWordAtClose.delete(`${userId}:${id}`);
  const logWords = opts.logWords !== false;
  const cascade = opts.cascade !== false;
  opts = { theirWord: opts.theirWord ?? held };
  const { rowCount, rows } = await pool.query(
    `UPDATE co_tasks SET status = $3, outcome = $4, closed_at = NOW(), next_check_at = NULL, updated_at = NOW(),
       followup = CASE WHEN kind = 'work' AND followup ? 'window' THEN jsonb_set(followup, '{window,closedAt}', to_jsonb(NOW())) ELSE followup END
     WHERE user_id = $1 AND id = $2 AND status = 'open' RETURNING id, kind, source, followup, steps, goal, texts_sent`,
    [userId, id, status, outcome.trim().slice(0, 300)],
  );
  const closed = (rowCount ?? 0) > 0;
  const row = rows?.[0];
  if (closed && row) {
    const L = await import("./commitmentLog.js");
    if (L.isCommitment(row)) await L.logCommitment("outcome", { userId, taskId: id, goalId: row.followup?.goalId ?? null, outcome: L.outcomeOf(status, outcome, Array.isArray(row.steps) ? row.steps : [], { source: row.source, goalItem: row.followup?.goalItem != null, theirWord: opts.theirWord ?? null, sentAnything: Number(row.texts_sent ?? 0) > 0 }), why: outcome, what: row.goal, source: row.source, theirWord: logWords ? (opts.theirWord ?? null) : null });
    // A goal whose last open piece or check-in just closed is settled now (goalOwnership.ts closeGoalIfSettled).
    if (cascade && row.followup?.goalId != null) await import("./goalOwnership.js").then((G) => G.closeGoalIfSettled(userId, Number(row.followup.goalId))).catch(() => false);
  }
  return closed;
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

// A wake that could only be held for pacing doesn't count toward maxWakes (review of #129): a long hold must not run the task out.
export async function unspendWake(userId: string, id: number): Promise<void> {
  await pool.query(`UPDATE co_tasks SET wakes = GREATEST(wakes - 1, 0), updated_at = NOW() WHERE user_id = $1 AND id = $2`, [userId, id]);
}

// Tasks due to wake, each claimed so two runs never work the same one. The claim's 45-minute next check is a lease, not a time Co
// chose: a work task records when it was leased (followup.leasedAt) so nothing reads the lease as a fire time (promiseBinding.ts entryOf).
export async function claimDueTasks(limit = 20): Promise<CoTask[]> {
  const { rows } = await pool.query(
    `UPDATE co_tasks SET next_check_at = NOW() + INTERVAL '45 minutes', wakes = wakes + 1, updated_at = NOW(),
       followup = CASE WHEN kind = 'work' THEN jsonb_set(COALESCE(followup, '{}'::jsonb), '{leasedAt}', to_jsonb(NOW())) ELSE followup END
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

// The same, once a text the door held actually went (harness/door.ts); awaiting: whether that text asked them something.
export async function markTextedAt(userId: string, id: number, awaiting: boolean): Promise<void> {
  await pool.query(`UPDATE co_tasks SET texts_sent = texts_sent + 1, last_texted_at = NOW(), awaiting_reply = $3 WHERE user_id = $1 AND id = $2`, [userId, id, awaiting]);
}
export async function markTexted(userId: string, id: number): Promise<void> {
  await pool.query(`UPDATE co_tasks SET texts_sent = texts_sent + 1, last_texted_at = NOW(), awaiting_reply = true WHERE user_id = $1 AND id = $2`, [userId, id]);
}

// ---------------------------------------------------------------- research briefs, as the reply sees them
// A brief isn't a work task (no steps, no model loop: retired), so openTasks leaves it out and everything that
// counts or wakes work tasks is unchanged. The reply still has to see it: "what are you working on for me?" answers from these
// lines too, and a finished brief stays in view for a few days so "did you send that?" has its answer.
export type BriefView = { id: number; goal: string; theirWords: string; status: CoTask["status"]; createdAt: string; closedAt: string | null; outcome: string | null; held: { text: string; at: string } | null };
export const BRIEF_VISIBLE_DAYS = 3;

export async function recentBriefs(userId: string, days = BRIEF_VISIBLE_DAYS): Promise<BriefView[]> {
  const { rows } = await pool.query(
    `SELECT id, goal, their_words, status, created_at, closed_at, outcome, next_check_at, followup FROM co_tasks
     WHERE user_id = $1 AND kind = 'research_brief' AND (status = 'open' OR closed_at > NOW() - make_interval(days => $2))
     ORDER BY created_at DESC LIMIT 6`,
    [userId, days],
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    goal: String(r.goal ?? ""),
    theirWords: String(r.their_words ?? ""),
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    outcome: r.outcome ?? null,
    held: r.status === "open" && r.followup?.held?.text ? { text: String(r.followup.held.text), at: r.next_check_at ? new Date(r.next_check_at).toISOString() : "" } : null,
  }));
}

// Pure: why a new brief can't start, given their briefs, or null. One runs at a time; one that's finished but waiting for their
// hours to tell them is still theirs to hear first.
export function briefAlreadyOpen(briefs: Pick<BriefView, "status" | "held">[]): string | null {
  const open = briefs.filter((b) => b.status === "open");
  if (!open.length) return null;
  const held = open.find((b) => b.held);
  return held
    ? `the last research brief already finished, and what it came to goes to them in their hours: "${held.held!.text.slice(0, 200)}". Tell them that now instead of starting another`
    : "a research brief is already being put together for them";
}

// Pure: the reply's lines for their briefs, in their local time.
export function briefFactLines(briefs: BriefView[], zone?: string | null): string[] {
  const at = (x: string) => localStamp(x, zone ?? null);
  return briefs.map((b) => {
    const what = `"${b.goal}" (their words: "${b.theirWords.slice(0, 160)}")`;
    if (b.status === "open" && b.held) return `Research brief #${b.id} for them, ${what}, is finished but hasn't reached them yet (it was outside their hours). What it came to: "${b.held.text}". That goes to them${b.held.at ? ` around ${at(b.held.at)}` : " in their morning"}, unless you tell them first.`;
    if (b.status === "open") return `Cue is putting together research brief #${b.id} for them, ${what}, since ${at(b.createdAt)}. It runs in the background and goes to them as a document when it's done.`;
    if (b.status === "done") return `Research brief #${b.id}, ${what}, finished${b.closedAt ? ` ${at(b.closedAt)}` : ""}: ${b.outcome ?? "sent"}.`;
    return `Research brief #${b.id}, ${what}, stopped${b.closedAt ? ` ${at(b.closedAt)}` : ""} without a brief: ${b.outcome ?? "no reason recorded"}.`;
  });
}

// A brief's last line to them, held to their hours: the task stays open (still theirs to hear) and wakes when the line can go.
// A finished brief whose document didn't go out: kept on the task with the options, so the next wake re-sends it without
// finding again (2026-10-08: a failed PDF closed the task as dropped and they never heard).
export async function holdBriefDoc(userId: string, id: number, pending: { doc: unknown; options: { name: string; url: string }[]; tries: number; title: string; list: string }, at: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE co_tasks SET followup = jsonb_set(COALESCE(followup, '{}'::jsonb), '{pendingDoc}', $3::jsonb), next_check_at = $4, plan_next = 'send the brief that did not go out', updated_at = NOW()
     WHERE user_id = $1 AND id = $2 AND status = 'open' AND kind = 'research_brief'`,
    [userId, id, JSON.stringify(pending), at],
  );
  return (rowCount ?? 0) > 0;
}

export async function holdBriefLine(userId: string, id: number, held: { text: string; status: "done" | "dropped"; outcome: string }, at: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE co_tasks SET followup = jsonb_set(COALESCE(followup, '{}'::jsonb), '{held}', $3::jsonb), next_check_at = $4, plan_next = 'tell them what the brief came to', updated_at = NOW()
     WHERE user_id = $1 AND id = $2 AND status = 'open' AND kind = 'research_brief'`,
    [userId, id, JSON.stringify(held), at],
  );
  return (rowCount ?? 0) > 0;
}
