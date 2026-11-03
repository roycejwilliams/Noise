// Never reopen what they closed (Royce, 2026-11-03, the whole-exchange baseline: 13 reopenings in 30 days on 8 active members, nearly
// all finds or promises after a drop: venue finds 7h after "got the venue", a DJ find 4 days after "not doing the party").
//
// Every send Cue starts serves something: an ask, a goal, a task, a thread, a loop. When that subject is closed (solved or dropped), the
// send is a reopening. Each proactive path reads the subject's state twice: right before drafting, and again inside the send's lock
// (a close can land while a draft is being written). A candidate whose subject closed is dropped and logged (proactive.dropped_closed),
// never sent.
//
// What closed means comes from the stores that already hold it, never from reading their words here:
//   ask     ask_checkins.resolved_at (the #351 retire read, Cue's closeAsk tool, the ask lifecycle); at their word when closed_reason is
//           member / moved_on, or Cue closed it in the turn they said so ("closed by Cue: ...")
//   task    co_tasks closed at their word (the #368 record's test: the close's outcome says so, or the commitment log kept their words).
//           A task Cue closed itself (done, or kept open for a last line) is never a reason: its own result still goes
//   goal    a goal entry on their profile that's no longer active (closeGoal: at their word)
//   thread  member_threads resolved, or changed with their quote (both only at their word)
//   loop    open_loops done or dropped (never by staleness, an archive or removal)
// A task that answers an ask (target ask_checkin:<ask>) closes with that ask when they closed it.
//
// Requested work they still want is never dropped by this: a requested result goes unless they closed or dropped what it serves
// (theirWord). An event find keeps the #361 rule exactly (services/askLifecycle.ts servesClosedAsk: a find for an ask closed any way is
// dead; a reminder about something already shown is exempt). Pure, apart from loadClosedSubjects.
import { threadIds } from "./attention.js";

export type SubjectKind = "ask" | "task" | "goal" | "thread" | "loop";
export type SubjectRef = { kind: SubjectKind; id: string };
export type ClosedSubject = { ref: SubjectRef; how: string; theirWord: boolean };
// Keyed by `${kind}:${id}`.
export type ClosedSet = Map<string, ClosedSubject>;

export const refKey = (r: SubjectRef) => `${r.kind}:${r.id}`;

// The decision every drop is logged under, and the start of its reason (the door's drop note reads it).
export const DROPPED_CLOSED = "proactive.dropped_closed";
export const SUBJECT_CLOSED = "what it serves has closed";

// The ask closes that are theirs: they said it's done, found, off, or replaced (Cue's closeAsk tool runs on their word in that turn).
export function askClosedAtTheirWord(reason: string | null | undefined): boolean {
  const r = String(reason ?? "").trim();
  return r === "member" || r === "moved_on" || /^closed by (?:cue|co):/i.test(r);
}
// A task closed at their word, by the close's own outcome (Cue's own words; the same test as the #368 record's closedLately).
export const TASK_THEIR_WORD_OUTCOME = /their word|they said|no longer|dropped:/i;

// Types whose subject is the close itself, or that serve nothing they could close.
const NO_SUBJECT = new Set(["goal_closed", "name_change", "announcement", "voice_read_ask", "product_update"]);

// Pure: what a candidate (or a held send) serves, from its own ids: the payload's ask, goal, task, thread (its own, or the thread read's
// answer stored on it), loop and ask check-in row, a member-state nudge's entry, and the task a task:<id>: target key names.
export function subjectRefs(c: { type: string; targetKey?: string | null; payload?: unknown }): SubjectRef[] {
  if (NO_SUBJECT.has(c.type)) return [];
  const p = (c.payload ?? {}) as { askCheckinId?: string | null; loopId?: string | number | null; entryKey?: string | null; door?: boolean; taskId?: number | string | null };
  const out: SubjectRef[] = [];
  const add = (kind: SubjectKind, id: unknown) => {
    const s = id == null ? "" : String(id).trim();
    if (s && !out.some((r) => r.kind === kind && r.id === s)) out.push({ kind, id: s });
  };
  const ids = threadIds({ type: c.type, targetKey: c.targetKey ?? "", payload: c.payload ?? {} });
  if (ids.ask && !ids.ask.startsWith("promise:")) add("ask", ids.ask);
  add("ask", p.askCheckinId);
  if (ids.goal) add("goal", ids.goal);
  if (ids.task) add("task", ids.task);
  if (ids.thread) add("thread", ids.thread);
  add("loop", p.loopId);
  // A member-state nudge's entry: goal:<id>, commitment:<thread>, deadline:<item>.
  const entry = String(p.entryKey ?? "");
  const e = entry.replace(/^deadline:/, "");
  const m = e.match(/^(goal|commitment|ask|task|thread):(.+)$/);
  if (m) add(m[1] === "commitment" ? "thread" : (m[1] as SubjectKind), m[2]);
  const tk = String(c.targetKey ?? "").match(/^task:(\d+):/);
  if (tk) add("task", tk[1]);
  return out;
}

// Pure: the closed subject a candidate serves, or null when it may go. cls is its class for the member's rules (notifyGate.candidateClass).
export function closedSubjectFor(c: { type: string; targetKey?: string | null; payload?: unknown }, closed: ClosedSet | null | undefined, cls: string): ClosedSubject | null {
  if (!closed?.size) return null;
  const p = (c.payload ?? {}) as { askId?: string | null; reminder?: boolean | null; fromProfile?: boolean };
  for (const r of subjectRefs(c)) {
    const hit = closed.get(refKey(r));
    if (!hit) continue;
    // An event find: the #361 rule as it was (any close of its ask ends it; a reminder of something already shown goes).
    if (c.type === "event_offer" && r.kind === "ask") {
      if (p.reminder) continue;
      return hit;
    }
    // Requested work they still want goes; so does a task's own result after Cue closed the task itself.
    if ((cls === "requested" || r.kind === "task") && !hit.theirWord) continue;
    return hit;
  }
  return null;
}

// Pure: the rows read into the closed set.
export type ClosedRows = {
  asks: { id: string; ask_id: string; closed_reason: string | null }[];
  tasks: { id: number | string; status: string; outcome: string | null; their_word?: boolean | null }[];
  // Open tasks that answer an ask (target ask_checkin:<ask_id>).
  askTasks: { id: number | string; target_key: string }[];
  intent: unknown;
  threads: { id: string; status: string; closed_quote: string | null }[];
  loops: { id: number | string; status: string; closed_reason: string | null }[];
};
export function closedSetFrom(r: ClosedRows): ClosedSet {
  const out: ClosedSet = new Map();
  const put = (kind: SubjectKind, id: unknown, how: string, theirWord: boolean) => {
    const s = id == null ? "" : String(id);
    if (!s) return;
    const prior = out.get(`${kind}:${s}`);
    if (prior && prior.theirWord) return;
    out.set(`${kind}:${s}`, { ref: { kind, id: s }, how, theirWord });
  };
  const askWord = new Map<string, boolean>();
  for (const a of r.asks) {
    const w = askClosedAtTheirWord(a.closed_reason);
    const how = String(a.closed_reason ?? "closed").slice(0, 40);
    put("ask", a.id, how, w);
    put("ask", a.ask_id, how, w);
    askWord.set(String(a.ask_id), w || (askWord.get(String(a.ask_id)) ?? false));
    askWord.set(String(a.id), w || (askWord.get(String(a.id)) ?? false));
  }
  for (const t of r.tasks) {
    const w = t.their_word === true || TASK_THEIR_WORD_OUTCOME.test(String(t.outcome ?? ""));
    put("task", t.id, String(t.status), w);
  }
  for (const t of r.askTasks) {
    const ask = String(t.target_key ?? "").replace(/^ask_checkin:/, "");
    if (askWord.get(ask) === true) put("task", t.id, "its ask closed at their word", true);
  }
  for (const e of Array.isArray(r.intent) ? (r.intent as any[]) : []) {
    if (e?.kind !== "goal" || !e?.id || e?.status === "active") continue;
    put("goal", e.id, String(e.status ?? "closed"), e.closed_by === "member" || e.status === "resolved");
  }
  for (const t of r.threads) {
    if (t.status === "resolved") put("thread", t.id, "resolved", true);
    else if (t.status === "changed" && t.closed_quote) put("thread", t.id, "changed", true);
  }
  for (const l of r.loops) {
    if (l.status !== "done" && l.status !== "dropped") continue;
    if (["stale", "archived", "removed"].includes(String(l.closed_reason ?? ""))) continue;
    put("loop", l.id, String(l.status), false);
  }
  return out;
}

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
// One member's closed subjects (any reader works: the pool, or the send's own client inside its lock). A read that fails throws: the
// caller decides (dispatch goes on as before; nothing is dropped on a failed read).
export async function loadClosedSubjects(userId: string, db?: Q): Promise<ClosedSet> {
  const q = db ?? (await import("../db/db.js")).default;
  const [asks, tasks, askTasks, prof, threads, loops, words] = await Promise.all([
    q.query(`SELECT id::text AS id, ask_id, closed_reason FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NOT NULL`, [userId]),
    q.query(`SELECT id, status, outcome FROM co_tasks WHERE user_id = $1 AND status IN ('done','dropped') AND closed_at > NOW() - INTERVAL '60 days'`, [userId]),
    q.query(`SELECT id, target_key FROM co_tasks WHERE user_id = $1 AND status = 'open' AND target_key LIKE 'ask_checkin:%'`, [userId]),
    q.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]),
    q.query(`SELECT id::text AS id, status, closed_quote FROM member_threads WHERE user_id = $1 AND status IN ('resolved','changed') AND closed_at > NOW() - INTERVAL '60 days'`, [userId]),
    q.query(`SELECT id, status, closed_reason FROM open_loops WHERE user_id = $1 AND status IN ('done','dropped') AND closed_at > NOW() - INTERVAL '60 days'`, [userId]),
    // The commitment log keeps their words when a task closed at their word (services/commitmentLog.ts logCommitment).
    q.query(`SELECT DISTINCT proposal->>'taskId' AS id FROM harness_decisions WHERE user_id = $1 AND decision = 'commitment.outcome' AND proposal ? 'theirWord' AND created_at > NOW() - INTERVAL '60 days'`, [userId]),
  ]);
  const theirs = new Set(words.rows.map((r: any) => String(r.id)));
  return closedSetFrom({
    asks: asks.rows,
    tasks: tasks.rows.map((t: any) => ({ ...t, their_word: theirs.has(String(t.id)) })),
    askTasks: askTasks.rows,
    intent: prof.rows[0]?.intent ?? null,
    threads: threads.rows,
    loops: loops.rows,
  });
}

// Pure: the logged reason (ids and states only: never a label or their words).
export function closedReason(hit: ClosedSubject): string {
  return `${SUBJECT_CLOSED}: ${hit.ref.kind} ${hit.ref.id} (${hit.how}${hit.theirWord ? ", at their word" : ""})`;
}
// The decision row for one drop (ids only).
export function droppedClosedDecision(o: { userId: string; stage: string; candidate: { id?: string | null; type: string; targetKey?: string | null }; hit: ClosedSubject }) {
  return {
    layer: 7 as const,
    decision: DROPPED_CLOSED,
    userId: o.userId,
    outcome: "skip" as const,
    action: `${o.stage}:${o.candidate.type}`,
    reason: closedReason(o.hit),
    proposal: { candidate: o.candidate.id ?? null, targetKey: o.candidate.targetKey ?? null, ref: refKey(o.hit.ref), how: o.hit.how, theirWord: o.hit.theirWord, stage: o.stage },
  };
}
