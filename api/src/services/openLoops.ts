// Open loops as first-class state (Royce, 2026-10-01: "Every stated ask becomes
// a tracked outcome with a status - waiting on a reply, price unconfirmed,
// decision needed. Proactivity isn't generating new ideas, it's iterating those
// loops and speaking when one of them changes."). One row per thing Co is
// carrying for someone, synced from where it already lives (Co's tasks, its
// working notes, their open asks, offers waiting on a reaction). Co can set a
// loop's status itself (agent/loopTools.ts updateLoop), and that wins over
// what code derives. Every reply sees the loops (routes/sendblue.ts); a loop
// that changes while they're away wakes the task that owns it, which decides
// whether there's something to say (services/taskTurn.ts).
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

export const LOOP_STATUSES = ["open", "waiting_on_reply", "unconfirmed", "decision_needed", "done", "dropped"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];
export type DerivedLoop = { source: "task" | "notes" | "ask" | "offer"; sourceRef: string; title: string; status: LoopStatus; detail: string | null; dueDate: string | null; taskId: number | null };
export type LoopRow = DerivedLoop & { id: number; statusBy: "code" | "co"; changedAt: Date; wokeAt: Date | null; closedAt: Date | null };

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
  tasks: { id: number; goal: string; deadline: string | null; awaitingReply: boolean; latest: string | null }[];
  notes: { what: string; when: string | null; shortlist: { name: string; note?: string }[]; picked: string | null; next: string | null } | null;
  asks: { askId: string; text: string }[];
  offers: { key: string; name: string }[];
}): DerivedLoop[] {
  const out: DerivedLoop[] = [];
  for (const t of src.tasks) {
    const status: LoopStatus = t.awaitingReply ? "waiting_on_reply" : /\b(unconfirmed|not confirmed|no price|waiting on (a )?(quote|price))\b/i.test(t.latest ?? "") ? "unconfirmed" : "open";
    out.push({ source: "task", sourceRef: String(t.id), title: t.goal.slice(0, 120), status, detail: t.latest?.slice(0, 240) ?? null, dueDate: t.deadline, taskId: t.id });
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

// Pure: what the reply reads each turn.
export function describeLoops(rows: Pick<LoopRow, "title" | "status" | "detail" | "dueDate" | "source">[]): string | null {
  const open = rows.filter((r) => r.status !== "done" && r.status !== "dropped").slice(0, 8);
  if (!open.length) return null;
  const lines = open.map((r) => `${r.title}: ${STATUS_WORDS[r.status]}${r.detail ? ` (${r.detail})` : ""}${r.dueDate ? `, due ${r.dueDate}` : ""}`);
  return `What you're carrying for them right now, and where each stands (this is what to report when they ask what you're doing or how it's going, and what to move forward): ${lines.join("; ")}.`;
}

async function sources(userId: string) {
  const q = (sql: string, args: unknown[]) => pool.query(sql, args).then((r) => r.rows).catch(() => [] as any[]);
  const [tasks, brief, asks, offers] = await Promise.all([
    q(`SELECT id, goal, deadline, awaiting_reply, notes FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind = 'work' ORDER BY created_at DESC LIMIT 6`, [userId]),
    q(`SELECT brief FROM search_briefs WHERE user_id = $1 AND updated_at > NOW() - interval '72 hours'`, [userId]),
    q(`SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 4`, [userId]),
    q(`SELECT target_key, payload->'match'->>'name' AS name FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status = 'sent' AND decided_at > NOW() - interval '2 days' ORDER BY decided_at DESC LIMIT 3`, [userId]),
  ]);
  const b = brief[0]?.brief ?? null;
  return {
    tasks: tasks.map((t: any) => ({ id: Number(t.id), goal: String(t.goal), deadline: t.deadline ? String(t.deadline instanceof Date ? t.deadline.toISOString() : t.deadline).slice(0, 10) : null, awaitingReply: !!t.awaiting_reply, latest: Array.isArray(t.notes) && t.notes.length ? String(t.notes[t.notes.length - 1]?.text ?? "") : null })),
    notes: b ? { what: String(b.what ?? b.summary ?? ""), when: b.when ?? null, shortlist: Array.isArray(b.shortlist) ? b.shortlist : [], picked: b.picked ?? null, next: b.next ?? null } : null,
    asks: asks.map((a: any) => ({ askId: String(a.ask_id), text: String(a.ask_text) })),
    offers: offers.filter((o: any) => o.name).map((o: any) => ({ key: String(o.target_key), name: String(o.name) })),
  };
}

// Bring the table in line with what Co holds. A loop Co set itself keeps its
// status until its source closes. Returns the loops whose status or detail
// changed in this sync.
export async function syncOpenLoops(userId: string): Promise<{ rows: LoopRow[]; changed: LoopRow[] }> {
  const derived = deriveLoops(await sources(userId));
  const { rows: existing } = await pool.query(`SELECT * FROM open_loops WHERE user_id = $1 AND closed_at IS NULL`, [userId]).catch(() => ({ rows: [] as any[] }));
  const byKey = new Map(existing.map((r: any) => [`${r.source}:${r.source_ref}`, r]));
  const changed: LoopRow[] = [];
  for (const d of derived) {
    const ex: any = byKey.get(`${d.source}:${d.sourceRef}`);
    byKey.delete(`${d.source}:${d.sourceRef}`);
    const status = ex?.status_by === "co" ? ex.status : d.status;
    const detail = ex?.status_by === "co" && ex.detail ? ex.detail : d.detail;
    const moved = !ex || ex.status !== status || (ex.detail ?? null) !== (detail ?? null);
    const { rows } = await pool
      .query(
        `INSERT INTO open_loops (user_id, source, source_ref, title, status, detail, due_date, task_id, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user_id, source, source_ref) DO UPDATE SET title = EXCLUDED.title, status = $5, detail = $6, due_date = EXCLUDED.due_date, task_id = EXCLUDED.task_id, updated_at = NOW(), closed_at = NULL${moved ? ", changed_at = NOW()" : ""}
         RETURNING *`,
        [userId, d.source, d.sourceRef, d.title, status, detail, d.dueDate, d.taskId],
      )
      .catch(() => ({ rows: [] as any[] }));
    if (rows[0] && moved && ex) changed.push(toRow(rows[0]));
  }
  // Gone from its source (task closed, ask resolved, notes expired): closed.
  for (const gone of byKey.values()) {
    if ((gone as any).source === "co") continue;
    await pool.query(`UPDATE open_loops SET status = CASE WHEN status IN ('done','dropped') THEN status ELSE 'done' END, closed_at = NOW(), updated_at = NOW() WHERE id = $1`, [(gone as any).id]).catch(() => {});
  }
  const { rows: now } = await pool.query(`SELECT * FROM open_loops WHERE user_id = $1 AND closed_at IS NULL ORDER BY due_date NULLS LAST, changed_at DESC`, [userId]).catch(() => ({ rows: [] as any[] }));
  return { rows: now.map(toRow), changed };
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
    wokeAt: r.woke_at ? new Date(r.woke_at) : null,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
  };
}

// Co sets where a loop stands (the closest open loop by title, or a new one).
export async function setLoopStatus(userId: string, title: string, status: LoopStatus, detail: string | null): Promise<{ ok: boolean; title: string }> {
  const { rows } = await syncOpenLoops(userId);
  const words = title.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  const score = (r: LoopRow) => words.filter((w) => r.title.toLowerCase().includes(w)).length;
  const best = rows.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s)[0];
  if (best && best.s > 0) {
    await pool.query(`UPDATE open_loops SET status = $2, status_by = 'co', detail = COALESCE($3, detail), changed_at = NOW(), updated_at = NOW(), closed_at = CASE WHEN $2 IN ('done','dropped') THEN NOW() ELSE NULL END WHERE id = $1`, [best.r.id, status, detail]);
    return { ok: true, title: best.r.title };
  }
  await pool.query(
    `INSERT INTO open_loops (user_id, source, source_ref, title, status, status_by, detail) VALUES ($1, 'co', $2, $3, $4, 'co', $5) ON CONFLICT (user_id, source, source_ref) DO UPDATE SET status = $4, detail = $5, changed_at = NOW(), updated_at = NOW()`,
    [userId, title.toLowerCase().slice(0, 80), title.slice(0, 120), status, detail],
  );
  return { ok: true, title };
}

// The loops that changed while they weren't texting wake the task that owns
// them, at most every 6 hours a loop, so the task decides whether there's
// something to tell them (Royce: "speaking when one of them changes").
export const WAKE_EVERY_HOURS = 6;
export function shouldWake(l: Pick<LoopRow, "taskId" | "changedAt" | "wokeAt" | "status">, now: Date): boolean {
  if (!l.taskId || l.status === "done" || l.status === "dropped") return false;
  if (l.wokeAt && l.wokeAt.getTime() >= l.changedAt.getTime()) return false;
  return !l.wokeAt || now.getTime() - l.wokeAt.getTime() >= WAKE_EVERY_HOURS * 3_600_000;
}

export async function runLoopSync(): Promise<void> {
  const { rows: users } = await pool
    .query(`SELECT DISTINCT user_id FROM co_tasks WHERE status = 'open' AND kind = 'work' UNION SELECT user_id FROM search_briefs WHERE updated_at > NOW() - interval '72 hours'`)
    .catch(() => ({ rows: [] as any[] }));
  const now = new Date();
  for (const u of users) {
    const { changed } = await syncOpenLoops(u.user_id).catch(() => ({ changed: [] as LoopRow[] }));
    for (const l of changed.filter((x) => shouldWake(x, now))) {
      await pool.query(`UPDATE co_tasks SET next_check_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'open'`, [l.taskId]).catch(() => {});
      await pool.query(`UPDATE open_loops SET woke_at = NOW() WHERE id = $1`, [l.id]).catch(() => {});
      await recordDecision({ layer: 7, decision: "loop.changed", userId: u.user_id, outcome: "act", action: `woke task ${l.taskId}`, proposal: { title: l.title, status: l.status, detail: l.detail } }).catch(() => {});
    }
  }
}
