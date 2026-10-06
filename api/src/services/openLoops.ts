// Open loops as first-class state (Royce, 2026-10-01: "Every stated ask becomes
// a tracked outcome with a status - waiting on a reply, price unconfirmed,
// decision needed. Proactivity isn't generating new ideas, it's iterating those
// loops and speaking when one of them changes."). One row per thing Co is
// carrying for someone, synced from where it already lives (Co's tasks, its
// working notes, their open asks, offers waiting on a reaction). Co can set a
// loop's status itself (agent/loopTools.ts updateLoop), and that wins over
// what code derives; a loop Co closes stays closed. Every reply sees the loops (routes/sendblue.ts); a loop
// that changes while they're away wakes the task that owns it, which decides
// whether there's something to say (services/taskTurn.ts).
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { DateTime } from "luxon";
import { decayAction, isDraftable, stateOf, type LifecycleRow } from "./loopLifecycle.js";

const LOOP_ZONE = "America/Los_Angeles";
const localDay = (d: Date) => DateTime.fromJSDate(d).setZone(LOOP_ZONE).toISODate()!;

export const LOOP_STATUSES = ["open", "waiting_on_reply", "unconfirmed", "decision_needed", "done", "dropped"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];
export type DerivedLoop = { source: "task" | "notes" | "ask" | "offer"; sourceRef: string; title: string; status: LoopStatus; detail: string | null; dueDate: string | null; taskId: number | null; signalAt?: Date | null };
export type LoopRow = DerivedLoop & { id: number; statusBy: "code" | "co"; changedAt: Date; seenAt: Date | null; wokeAt: Date | null; closedAt: Date | null; closedReason: string | null; lastConfirmedAt: Date | null; decayAskedAt: Date | null };

const STATUS_WORDS: Record<LoopStatus, string> = {
  open: "in progress",
  waiting_on_reply: "waiting on a reply",
  unconfirmed: "something unconfirmed",
  decision_needed: "a decision that's theirs",
  done: "done",
  dropped: "dropped",
};

// Pure: the loops implied by what Co already holds.
export function deriveLoops(src: {
  tasks: { id: number; goal: string; deadline: string | null; awaitingReply: boolean; latest: string | null; theirReplyAt?: Date | null }[];
  notes: { what: string; when: string | null; shortlist: { name: string; note?: string }[]; picked: string | null; next: string | null } | null;
  asks: { askId: string; text: string }[];
  offers: { key: string; name: string }[];
}): DerivedLoop[] {
  const out: DerivedLoop[] = [];
  for (const t of src.tasks) {
    const status: LoopStatus = t.awaitingReply ? "waiting_on_reply" : /\b(unconfirmed|not confirmed|no price|waiting on (a )?(quote|price))\b/i.test(t.latest ?? "") ? "unconfirmed" : "open";
    out.push({ source: "task", sourceRef: String(t.id), title: t.goal.slice(0, 120), status, detail: t.latest?.slice(0, 240) ?? null, dueDate: t.deadline, taskId: t.id, signalAt: t.theirReplyAt ?? null });
  }
  if (src.notes?.what) {
    const n = src.notes;
    const unconfirmed = n.shortlist.some((s) => /\bunconfirmed|not confirmed|confirm\b|no price|price (isn't|is not|still)/i.test(s.note ?? "")) || /\bconfirm\b/i.test(n.next ?? "");
    const status: LoopStatus = n.picked ? (unconfirmed ? "unconfirmed" : "open") : /\b(pick|choose|decide|which one)\b/i.test(n.next ?? "") ? "decision_needed" : unconfirmed ? "unconfirmed" : "open";
    const detail = [n.shortlist.length ? `shortlist: ${n.shortlist.map((s) => s.name).join(", ")}` : null, n.picked ? `they picked ${n.picked}` : null, n.next ? `next: ${n.next}` : null].filter(Boolean).join("; ");
    out.push({ source: "notes", sourceRef: "brief", title: `${n.what}${n.when ? ` (${n.when})` : ""}`.slice(0, 120), status, detail: detail || null, dueDate: null, taskId: null });
  }
  for (const a of src.asks) out.push({ source: "ask", sourceRef: a.askId, title: a.text.slice(0, 120), status: "open", detail: null, dueDate: null, taskId: null });
  for (const o of src.offers) out.push({ source: "offer", sourceRef: o.key, title: `Sent them ${o.name}`.slice(0, 120), status: "waiting_on_reply", detail: "waiting on how it landed", dueDate: null, taskId: null });
  return out;
}

// Pure: what the reply reads each turn. withIds (text replies, which have
// updateLoop) gives each loop the id updateLoop names it by; calls, tasks and
// the sweep read it without, since nothing there takes an id.
export function describeLoops(rows: (Pick<LoopRow, "title" | "status" | "detail" | "dueDate" | "source"> & { id?: number; lastConfirmedAt?: Date | null; closedAt?: Date | null; closedReason?: string | null; decayAskedAt?: Date | null })[], opts: { withIds?: boolean; now?: Date; today?: string; draftOnly?: boolean } = {}): string | null {
  const now = opts.now ?? new Date();
  const today = opts.today ?? localDay(now);
  const live = rows.filter((r) => r.status !== "done" && r.status !== "dropped" && !r.closedAt);
  // A row with no confirmation date predates the lifecycle: unconfirmed, never stated as current.
  const draftable = (r: (typeof rows)[number]) => isDraftable({ status: r.status, closedAt: r.closedAt ?? null, closedReason: r.closedReason ?? null, dueDate: r.dueDate, lastConfirmedAt: r.lastConfirmedAt ?? null, decayAskedAt: r.decayAskedAt ?? null }, now, today);
  const open = (opts.draftOnly ? live.filter(draftable) : live).slice(0, 8);
  if (!open.length) return null;
  const ids = !!opts.withIds;
  const lines = open.map((r) => {
    const fresh = draftable(r);
    return `${ids && r.id != null ? `[loop ${r.id}] ` : ""}${r.title}: ${STATUS_WORDS[r.status]}${r.detail ? ` (${r.detail})` : ""}${r.dueDate ? `, due ${r.dueDate}` : ""}${fresh ? "" : " [not confirmed lately: background only, ask before treating it as current]"}`;
  });
  return `What you're carrying for them right now, and where each stands (this is what to report when they ask what you're doing or how it's going, and what to move forward${ids ? "; the [loop N] ids are for updateLoop, never for your texts" : ""}): ${lines.join("; ")}.`;
}

// A read is either the whole list or nothing to reason from (2026-10-01 code
// review: a failed read came back as an empty list, and the sync closed every
// loop from that source as done; a display cap of 6/4/3 did the same to the
// 7th task). `complete` is false when the read failed or hit its cap, and
// nothing from an incomplete source is ever closed.
export const SOURCE_READ_CAP = 50;
export const NOTES_FRESH_HOURS = 72;
type Read<T> = { complete: boolean; rows: T[] };
export type LoopSources = Parameters<typeof deriveLoops>[0] & { complete: Record<DerivedLoop["source"], boolean>; briefUpdatedAt: Date | null; briefStale: boolean };

async function sources(userId: string, now: Date): Promise<LoopSources> {
  const q = (sql: string, args: unknown[]): Promise<Read<any>> =>
    pool.query(sql, args).then((r) => ({ complete: r.rows.length < SOURCE_READ_CAP, rows: r.rows })).catch((err: any) => {
      console.error("openLoops: a source read failed (nothing from it will be closed):", err?.message ?? err);
      return { complete: false, rows: [] };
    });
  const [tasks, brief, asks, offers] = await Promise.all([
    q(`SELECT id, goal, deadline, awaiting_reply, their_reply_at, notes FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind = 'work' ORDER BY created_at DESC LIMIT ${SOURCE_READ_CAP}`, [userId]),
    q(`SELECT brief, updated_at FROM search_briefs WHERE user_id = $1`, [userId]),
    q(`SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT ${SOURCE_READ_CAP}`, [userId]),
    q(`SELECT target_key, payload->'match'->>'name' AS name FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND decided_at > NOW() - interval '2 days' ORDER BY decided_at DESC LIMIT ${SOURCE_READ_CAP}`, [userId]),
  ]);
  const briefRow = brief.rows[0] ?? null;
  const briefUpdatedAt = briefRow?.updated_at ? new Date(briefRow.updated_at) : null;
  const briefStale = !!briefUpdatedAt && now.getTime() - briefUpdatedAt.getTime() > NOTES_FRESH_HOURS * 3_600_000;
  const b = briefRow && !briefStale ? briefRow.brief : null;
  return {
    tasks: tasks.rows.map((t: any) => ({ id: Number(t.id), goal: String(t.goal), deadline: t.deadline ? String(t.deadline instanceof Date ? t.deadline.toISOString() : t.deadline).slice(0, 10) : null, awaitingReply: !!t.awaiting_reply, theirReplyAt: t.their_reply_at ? new Date(t.their_reply_at) : null, latest: Array.isArray(t.notes) && t.notes.length ? String(t.notes[t.notes.length - 1]?.text ?? "") : null })),
    notes: b ? { what: String(b.what ?? b.summary ?? ""), when: b.when ?? null, shortlist: Array.isArray(b.shortlist) ? b.shortlist : [], picked: b.picked ?? null, next: b.next ?? null } : null,
    asks: asks.rows.map((a: any) => ({ askId: String(a.ask_id), text: String(a.ask_text) })),
    offers: offers.rows.filter((o: any) => o.name).map((o: any) => ({ key: String(o.target_key), name: String(o.name) })),
    complete: { task: tasks.complete, notes: brief.complete, ask: asks.complete, offer: offers.complete },
    briefUpdatedAt,
    briefStale,
  };
}

// Why a loop that's gone from its source's open list is closed, from a direct
// read of that one source row. null keeps it open: the read failed, or the
// source still says it's open (so the list missed it, not the world).
//   srcRow undefined = the read failed; null = the row no longer exists.
export type CloseVerdict = { status: LoopStatus | null; reason: "source_done" | "source_dropped" | "stale" };
export function closeVerdict(source: DerivedLoop["source"], srcRow: Record<string, any> | null | undefined, ctx: { briefStale?: boolean } = {}): CloseVerdict | null {
  if (srcRow === undefined) return null;
  if (srcRow === null) return { status: "dropped", reason: "source_dropped" };
  if (source === "task") {
    if (srcRow.status === "done") return { status: "done", reason: "source_done" };
    if (srcRow.status === "dropped" || srcRow.status === "expired") return { status: "dropped", reason: "source_dropped" };
    return null;
  }
  if (source === "ask") return srcRow.resolved_at ? { status: "done", reason: "source_done" } : null;
  // An offer they reacted to has landed; one that aged out unanswered is just stale.
  if (source === "offer") return srcRow.status !== "sent" ? { status: "done", reason: "source_done" } : { status: null, reason: "stale" };
  // The notes went quiet: stale, not done (nothing says it was finished).
  if (source === "notes") return ctx.briefStale ? { status: null, reason: "stale" } : srcRow.brief?.what || srcRow.brief?.summary ? null : { status: "dropped", reason: "source_dropped" };
  return null;
}

async function readSourceRow(userId: string, source: DerivedLoop["source"], ref: string): Promise<Record<string, any> | null | undefined> {
  const one = (sql: string, args: unknown[]) => pool.query(sql, args).then((r) => r.rows[0] ?? null).catch(() => undefined);
  if (source === "task") return /^\d+$/.test(ref) ? one(`SELECT status FROM co_tasks WHERE user_id = $1 AND id = $2`, [userId, Number(ref)]) : null;
  if (source === "ask") return one(`SELECT resolved_at FROM ask_checkins WHERE user_id = $1 AND ask_id = $2 LIMIT 1`, [userId, ref]);
  if (source === "offer") return one(`SELECT status FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND target_key = $2 ORDER BY decided_at DESC NULLS LAST LIMIT 1`, [userId, ref]);
  if (source === "notes") return one(`SELECT brief, updated_at FROM search_briefs WHERE user_id = $1`, [userId]);
  return undefined;
}

// Pure: what the sync does with each derived loop given the rows it has.
//   - an open row: keeps Co's status if Co set it, else takes the derived one
//   - a row Co closed (closed_reason 'co') stays closed: a tombstone, so the
//     next sync doesn't reopen what Co finished (2026-10-01 code review),
//     unless its source has a newer version than the close (new notes)
//   - no row: a new loop
export type SyncPlan =
  | { kind: "upsert"; d: DerivedLoop; status: LoopStatus; detail: string | null; moved: boolean; isNew: boolean }
  | { kind: "keep_closed"; d: DerivedLoop };
export function planLoop(d: DerivedLoop, ex: any | undefined, sourceUpdatedAt: Date | null): SyncPlan {
  if (ex?.closed_at) {
    const newer = !!sourceUpdatedAt && sourceUpdatedAt.getTime() > new Date(ex.closed_at).getTime();
    if (!newer) return { kind: "keep_closed", d };
    return { kind: "upsert", d, status: d.status, detail: d.detail, moved: true, isNew: false };
  }
  const status = ex?.status_by === "co" ? ex.status : d.status;
  const detail = ex?.status_by === "co" && ex.detail ? ex.detail : d.detail;
  const moved = !ex || ex.status !== status || (ex.detail ?? null) !== (detail ?? null);
  return { kind: "upsert", d, status, detail, moved, isNew: !ex };
}

// Bring the table in line with what Co holds, under one lock per member so a
// text turn and the 15-minute pass can't interleave. Returns the open loops
// and the ones whose status or detail changed in this sync.
export async function syncOpenLoops(userId: string, now = new Date()): Promise<{ rows: LoopRow[]; changed: LoopRow[] }> {
  const src = await sources(userId, now);
  const derived = deriveLoops(src);
  const client = await pool.connect();
  const changed: LoopRow[] = [];
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('open_loops:' || $1))`, [userId]);
    const { rows: existing } = await client.query(`SELECT * FROM open_loops WHERE user_id = $1 AND (closed_at IS NULL OR closed_reason IN ('co', 'expired', 'date_passed'))`, [userId]);
    const byKey = new Map(existing.map((r: any) => [`${r.source}:${r.source_ref}`, r]));
    for (const d of derived) {
      const key = `${d.source}:${d.sourceRef}`;
      const ex: any = byKey.get(key);
      byKey.delete(key);
      const plan = planLoop(d, ex, d.source === "notes" ? src.briefUpdatedAt : d.signalAt ?? null);
      if (plan.kind === "keep_closed") continue;
      // A new loop is news to no one (seen_at = now); a change after it is
      // pending until a wake handles it (runLoopSync). A row this sync reopens
      // goes back to code's word.
      const { rows } = await client.query(
        `INSERT INTO open_loops (user_id, source, source_ref, title, status, detail, due_date, task_id, changed_at, seen_at, last_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())
         ON CONFLICT (user_id, source, source_ref) DO UPDATE SET title = EXCLUDED.title, status = $5, detail = $6, due_date = EXCLUDED.due_date, task_id = EXCLUDED.task_id, updated_at = NOW(),
           status_by = CASE WHEN open_loops.closed_at IS NULL THEN open_loops.status_by ELSE 'code' END, closed_at = NULL, closed_reason = NULL${plan.moved ? ", changed_at = NOW()" : ""},
           last_confirmed_at = CASE WHEN open_loops.closed_at IS NOT NULL THEN NOW() WHEN $9::timestamptz IS NOT NULL AND $9::timestamptz > COALESCE(open_loops.last_confirmed_at, '-infinity') THEN $9::timestamptz ELSE open_loops.last_confirmed_at END
         RETURNING *`,
        [userId, d.source, d.sourceRef, d.title, plan.status, plan.detail, d.dueDate, d.taskId, d.signalAt ?? null],
      );
      if (rows[0] && plan.moved && !plan.isNew) changed.push(toRow(rows[0]));
    }
    // Gone from its source's open list: closed only when that source was read
    // in full and a direct read of the row says why.
    for (const gone of byKey.values() as Iterable<any>) {
      if (gone.closed_at || gone.source === "co") continue;
      if (!src.complete[gone.source as DerivedLoop["source"]]) continue;
      const verdict = closeVerdict(gone.source, await readSourceRow(userId, gone.source, gone.source_ref), { briefStale: src.briefStale });
      if (!verdict) continue;
      await client.query(
        `UPDATE open_loops SET status = COALESCE($2, status), status_by = 'code', closed_reason = $3, closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [gone.id, verdict.status, verdict.reason],
      );
    }
    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("openLoops: sync failed (loops left as they were):", err?.message ?? err);
  } finally {
    client.release();
  }
  const { rows: open } = await pool.query(`SELECT * FROM open_loops WHERE user_id = $1 AND closed_at IS NULL ORDER BY due_date NULLS LAST, changed_at DESC`, [userId]).catch(() => ({ rows: [] as any[] }));
  return { rows: open.map(toRow), changed };
}

function toRow(r: any): LoopRow {
  return {
    id: Number(r.id),
    source: r.source,
    sourceRef: r.source_ref,
    title: r.title,
    status: r.status,
    statusBy: r.status_by,
    detail: r.detail,
    dueDate: r.due_date ? String(r.due_date instanceof Date ? r.due_date.toISOString() : r.due_date).slice(0, 10) : null,
    taskId: r.task_id ? Number(r.task_id) : null,
    changedAt: new Date(r.changed_at),
    seenAt: r.seen_at ? new Date(r.seen_at) : null,
    wokeAt: r.woke_at ? new Date(r.woke_at) : null,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    closedReason: r.closed_reason ?? null,
    lastConfirmedAt: r.last_confirmed_at ? new Date(r.last_confirmed_at) : null,
    decayAskedAt: r.decay_asked_at ? new Date(r.decay_asked_at) : null,
  };
}

// Which loop Co means. By its id from what Co reads each turn; by title only
// when exactly one loop matches best (2026-10-01 code review: a tie between
// two venue loops updated the first one silently). No match at all is a new
// loop.
export function pickLoop(rows: Pick<LoopRow, "id" | "title">[], ref: { id?: number | null; title: string }): { kind: "loop"; id: number } | { kind: "new" } | { kind: "ambiguous"; candidates: { id: number; title: string }[] } | { kind: "unknown_id" } {
  if (ref.id != null) return rows.some((r) => r.id === ref.id) ? { kind: "loop", id: ref.id } : { kind: "unknown_id" };
  const t = ref.title.trim().toLowerCase();
  const exact = rows.filter((r) => r.title.trim().toLowerCase() === t);
  if (exact.length === 1) return { kind: "loop", id: exact[0].id };
  const words = t.split(/\W+/).filter((w) => w.length >= 4);
  const scored = rows.map((r) => ({ r, s: words.filter((w) => r.title.toLowerCase().includes(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { kind: "new" };
  const top = scored.filter((x) => x.s === scored[0].s);
  if (top.length > 1) return { kind: "ambiguous", candidates: top.map((x) => ({ id: x.r.id, title: x.r.title })) };
  return { kind: "loop", id: top[0].r.id };
}

// Co sets where a loop stands. Its own change is already known to it, so it
// never wakes the task (seen_at = now). Finishing a loop finishes what's
// behind it (the task, the ask), so the next sync doesn't bring it back.
export async function setLoopStatus(
  userId: string,
  ref: { id?: number | null; title: string },
  status: LoopStatus,
  detail: string | null,
): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const { rows } = await syncOpenLoops(userId);
  const pick = pickLoop(rows, ref);
  if (pick.kind === "unknown_id") return { ok: false, error: `There's no open loop ${ref.id}. Use an id from what you're carrying for them.` };
  if (pick.kind === "ambiguous") return { ok: false, error: `More than one loop fits "${ref.title}": ${pick.candidates.map((c) => `${c.id} (${c.title})`).join(", ")}. Say which by its id.` };
  const closing = status === "done" || status === "dropped";
  if (pick.kind === "new") {
    await pool.query(
      `INSERT INTO open_loops (user_id, source, source_ref, title, status, status_by, detail, seen_at, last_confirmed_at, closed_at, closed_reason)
       VALUES ($1, 'co', $2, $3, $4, 'co', $5, NOW(), NOW(), ${closing ? "NOW(), 'co'" : "NULL, NULL"})
       ON CONFLICT (user_id, source, source_ref) DO UPDATE SET status = $4, status_by = 'co', detail = $5, changed_at = NOW(), seen_at = NOW(), updated_at = NOW(), last_confirmed_at = NOW(), closed_at = ${closing ? "NOW()" : "NULL"}, closed_reason = ${closing ? "'co'" : "NULL"}`,
      [userId, ref.title.toLowerCase().slice(0, 80), ref.title.slice(0, 120), status, detail],
    );
    return { ok: true, title: ref.title };
  }
  const row = rows.find((r) => r.id === pick.id)!;
  await pool.query(
    `UPDATE open_loops SET status = $2, status_by = 'co', detail = COALESCE($3, detail), changed_at = NOW(), seen_at = NOW(), updated_at = NOW(), last_confirmed_at = NOW(),
       closed_at = CASE WHEN $2 IN ('done','dropped') THEN NOW() ELSE NULL END, closed_reason = CASE WHEN $2 IN ('done','dropped') THEN 'co' ELSE NULL END
     WHERE id = $1 AND user_id = $4`,
    [row.id, status, detail, userId],
  );
  if (closing) {
    if (row.source === "task" && row.taskId) {
      const { closeTask } = await import("./coTasks.js");
      await closeTask(userId, row.taskId, status as "done" | "dropped", detail ?? `Co marked it ${status}`).catch((err: any) => console.error("openLoops: closing the loop's task failed:", err?.message ?? err));
    } else if (row.source === "ask") {
      await pool.query(`UPDATE ask_checkins SET resolved_at = COALESCE(resolved_at, NOW()) WHERE user_id = $1 AND ask_id = $2`, [userId, row.sourceRef]).catch((err: any) => console.error("openLoops: resolving the loop's ask failed:", err?.message ?? err));
    }
  }
  return { ok: true, title: row.title };
}

// A loop that changed wakes the task that owns it, so the task decides whether
// there's something to tell them (Royce: "speaking when one of them changes").
// What's pending is durable (changed_at after seen_at), not just what this one
// pass saw (2026-10-01 code review: a change seen by a text turn, or held by
// the cooldown, was never woken later). At most one wake a loop every 6 hours,
// unless its due date is within 2 days.
export const WAKE_EVERY_HOURS = 6;
export const URGENT_WITHIN_DAYS = 2;
export function shouldWake(l: Pick<LoopRow, "taskId" | "changedAt" | "seenAt" | "wokeAt" | "status" | "dueDate">, now: Date): boolean {
  if (!l.taskId || l.status === "done" || l.status === "dropped") return false;
  if (l.seenAt && l.seenAt.getTime() >= l.changedAt.getTime()) return false;
  if (!l.wokeAt || now.getTime() - l.wokeAt.getTime() >= WAKE_EVERY_HOURS * 3_600_000) return true;
  return !!l.dueDate && new Date(`${l.dueDate}T23:59:59Z`).getTime() - now.getTime() <= URGENT_WITHIN_DAYS * 86_400_000;
}

export async function runLoopSync(): Promise<void> {
  const { rows: users } = await pool
    .query(
      `SELECT DISTINCT user_id FROM co_tasks WHERE status = 'open' AND kind = 'work'
       UNION SELECT user_id FROM search_briefs WHERE updated_at > NOW() - interval '${NOTES_FRESH_HOURS + 24} hours'
       UNION SELECT user_id FROM open_loops WHERE closed_at IS NULL`,
    )
    .catch((err: any) => {
      console.error("openLoops: listing members to sync failed:", err?.message ?? err);
      return { rows: [] as any[] };
    });
  const now = new Date();
  for (const u of users) {
    await syncOpenLoops(u.user_id, now).catch((err: any) => console.error("openLoops: sync failed:", err?.message ?? err));
    const { rows: pending } = await pool
      .query(`SELECT * FROM open_loops WHERE user_id = $1 AND closed_at IS NULL AND task_id IS NOT NULL AND (seen_at IS NULL OR changed_at > seen_at)`, [u.user_id])
      .catch((err: any) => {
        console.error("openLoops: reading pending loop changes failed:", err?.message ?? err);
        return { rows: [] as any[] };
      });
    for (const l of pending.map(toRow).filter((x) => shouldWake(x, now))) {
      // One statement: the loop counts as woken only if its task really was.
      const woke = await pool
        .query(
          `WITH t AS (UPDATE co_tasks SET next_check_at = NOW(), updated_at = NOW() WHERE id = $2 AND user_id = $3 AND status = 'open' RETURNING id)
           UPDATE open_loops SET woke_at = NOW(), seen_at = NOW() WHERE id = $1 AND EXISTS (SELECT 1 FROM t) RETURNING id`,
          [l.id, l.taskId, u.user_id],
        )
        .then((r) => r.rows.length > 0)
        .catch((err: any) => {
          console.error(`openLoops: waking task ${l.taskId} failed (stays pending):`, err?.message ?? err);
          return false;
        });
      await recordDecision({ layer: 7, decision: "loop.changed", userId: u.user_id, outcome: woke ? "act" : "skip", action: woke ? `woke task ${l.taskId}` : `task ${l.taskId} not woken`, proposal: { title: l.title, status: l.status, detail: l.detail } }).catch(() => {});
    }
  }
}

// The daily pass: evidence and decay (services/loopLifecycle.ts). A passed date closes a loop; a loop nobody has signalled on for
// ASK_AFTER_DAYS gets one "still on your plate?" ask; asked and still nothing after EXPIRE_AFTER_ASK_DAYS, it expires quietly.
// A loop counts as ASKED when the ask is actually sent (loop_check onSent sets decay_asked_at), not when it is queued: an ask held by
// quiet hours or caps, or one that expired unsent, never starts the expiry clock.
// `deps` lets a test run it without a database; the real ones are below.
export const MAX_ASKS_PER_PASS = 10;
export type DecayDeps = {
  live: () => Promise<LoopRow[]>;
  close: (id: number, reason: "date_passed") => Promise<void>;
  expire: (id: number) => Promise<void>;
  ask: (l: LoopRow) => Promise<boolean>; // true when an ask is queued (or already pending)
};
export async function runLoopDecay(now = new Date(), deps: DecayDeps = realDecayDeps()): Promise<{ closed: number; asked: number; expired: number }> {
  const today = localDay(now);
  const out = { closed: 0, asked: 0, expired: 0 };
  for (const l of await deps.live()) {
    const a = decayAction(l as LifecycleRow, now, today);
    if (a.kind === "close_date_passed") { await deps.close(l.id, "date_passed"); out.closed++; }
    else if (a.kind === "expire") { await deps.expire(l.id); out.expired++; }
    else if (a.kind === "ask" && out.asked < MAX_ASKS_PER_PASS) { if (await deps.ask(l)) out.asked++; }
  }
  return out;
}

function realDecayDeps(): DecayDeps {
  return {
    // Live members only: archived or opted-out members get no loop asks (and no candidates created for them).
    live: () =>
      pool
        .query(
          `SELECT o.*, (t.status = 'open' AND t.next_check_at IS NOT NULL AND t.next_check_at > NOW()) AS in_motion
           FROM open_loops o JOIN users u ON u.id = o.user_id LEFT JOIN co_tasks t ON t.id = o.task_id
           WHERE o.closed_at IS NULL AND o.status NOT IN ('done', 'dropped') AND u.archived_at IS NULL AND u.sms_opted_out = false`,
        )
        .then((r) => r.rows.map((x: any) => ({ ...toRow(x), inMotion: !!x.in_motion, userId: x.user_id }))),
    close: async (id, reason) => { await pool.query(`UPDATE open_loops SET status = 'dropped', status_by = 'code', closed_reason = $2, closed_at = NOW(), updated_at = NOW() WHERE id = $1 AND closed_at IS NULL`, [id, reason]); },
    expire: async (id) => { await pool.query(`UPDATE open_loops SET status = 'dropped', status_by = 'code', closed_reason = 'expired', closed_at = NOW(), updated_at = NOW() WHERE id = $1 AND closed_at IS NULL`, [id]); },
    ask: async (l) => {
      const userId = (l as LoopRow & { userId?: string }).userId;
      if (!userId) return false;
      const { enqueueCandidate } = await import("../harness/proactive.js");
      // One pending ask per loop; a new day's key only after the last one went unsent (its candidate expires in 3 days).
      const { rows: pending } = await pool.query(`SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND type = 'loop_check' AND status = 'pending' AND (payload->>'loopId')::bigint = $2 LIMIT 1`, [userId, l.id]);
      if (pending.length) return true;
      const r = await enqueueCandidate({
        userId,
        type: "loop_check",
        targetKey: `loop_check:${l.id}:${localDay(new Date())}`,
        topicKey: `loop:${l.id}`,
        summary: `Ask once whether "${l.title.slice(0, 60)}" is still on their plate`,
        payload: { loopId: l.id, title: l.title, lastConfirmedOn: l.lastConfirmedAt ? localDay(l.lastConfirmedAt) : null },
        dueAt: new Date(),
        expiresAt: new Date(Date.now() + 3 * 86_400_000),
      }).catch(() => ({ queued: false }));
      return !!r.queued;
    },
  };
}

// What drafting may state as current, from the rows of one member: open AND recently confirmed (services/loopLifecycle.ts isDraftable).
export function draftableLoops<T extends Pick<LoopRow, "status" | "closedAt" | "closedReason" | "dueDate" | "lastConfirmedAt" | "decayAskedAt">>(rows: T[], now = new Date()): T[] {
  const today = localDay(now);
  return rows.filter((r) => isDraftable(r, now, today));
}
export { stateOf };
