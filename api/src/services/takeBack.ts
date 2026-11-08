// A text they took back (Royce, 2026-11-07: "Mom: landing at 6, can you pick me up?", then "sorry wrong person"). Keeping it in the
// history is fine; what matters is that it never becomes something Cue acts on or brings up. When their latest text takes back the text
// before it (harness/memberThreads.ts withoutDisowned: a strong "wrong chat", or a bare "wrong person" right after a text addressed to
// someone else), everything that text set going between when they sent it and now is settled, each with why:
//   - a reminder set from it (member_reminders, unsent): retired the way a given-up reminder is (claimed, at its last try), never sent;
//   - a relay it asked for (member_relays, not yet sent): skipped;
//   - an ask captured from it (ask_checkins and its intent entry, services/askKind.ts closeAsk), or a goal (set aside: goal_states stale);
//   - a task Cue started or promised from it (co_tasks open): dropped, the outcome saying why;
//   - a loop it opened (open_loops open or pending): dropped;
//   - a queued follow-up or check-in (proactive_candidates pending): skipped;
//   - a thread opened from its words (member_threads open): closed as changed, on their take-back.
// Nothing is deleted. One decision row (turn.take_back) with the counts and the window, never their words. The threads read and the
// picture never use the line again (memberThreads.ts ownLines through withoutDisowned).
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { withoutDisowned, DISOWNS, type OwnLine } from "../harness/memberThreads.js";
import { notToTeammate } from "./teamLines.js";
import { REMINDER_RETRY } from "./relay.js";

export const TAKE_BACK_WHY = "they took it back: it was sent to Cue by mistake";

// Pure: the texts (oldest first, the latest last) the latest one takes back: their times. Empty when it takes nothing back.
export function takenBack(lines: OwnLine[]): OwnLine[] {
  if (lines.length < 2) return [];
  const kept = withoutDisowned(lines);
  const latest = lines[lines.length - 1];
  if (kept.some((k) => k.at === latest.at && k.text === latest.text)) return [];
  return lines.slice(0, -1).filter((l) => !kept.some((k) => k.at === l.at && k.text.startsWith(l.text)));
}

export type Settled = { reminders: number; relays: number; asks: number; goals: number; tasks: number; loops: number; candidates: number; threads: number };
type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
// The window: from the taken-back text's own created_at to the next text of theirs (only the reply to it writes there), and only what
// that reply wrote from its words. Never anything a job, a sweep or a call makes: those candidate types and task sources stay.
export type TakeBackWindow = { from: Date; until: Date; texts: string[] };
// Candidate types a text reply never queues (calls, sweeps, finds, events, matching, Cue's own announcements): never settled here.
const NOT_FROM_A_REPLY = ["post_call", "event_offer", "co_event", "event_change", "pre_arrival", "event_brief", "event_followthrough", "noshow_note", "in_room", "direct_ask", "intro_nudge", "intro_close", "event_match_nudge", "announcement", "product_update", "name_change", "companion", "debrief"];
const SETTLE_TIMEOUT_MS = 3000;
const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
// Pure: a row's words come from the taken-back text: at least two content words shared, and most of the row's own content words are in
// it. When in doubt, it isn't settled ("remind me at 6 to pick up the dry cleaning" next to "Mom: landing at 6, can you pick me up?"
// shares only "pick"; "landing gear" only "landing"; "pick up Maya from practice" only "pick"). Content words: three letters or more,
// not a function word, lightly stemmed (picked, picking -> pick).
const STOP = new Set("the and but for are was were you your yours they them their there this that these those with from have has had will would can could should what when where which who whom how why then than just about into onto over some someone something anyone anything me my mine our ours his her hers its it's i'm i've i'll you're we're they're get got gets getting want wants need needs like also very really okay remind reminder please let lets".split(" "));
const stem = (w: string) => w.replace(/'s$/, "").replace(/(?:ing|ed|es|s)$/, "") || w;
const contentWords = (t: string) => new Set(flat(t).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)).map(stem).filter((w) => w.length >= 3));
export function fromTheText(words: string | null | undefined, texts: string[]): boolean {
  const row = contentWords(String(words ?? ""));
  if (row.size < 2) return false;
  return texts.some((t) => {
    const text = contentWords(t);
    const shared = [...row].filter((w) => text.has(w)).length;
    return shared >= 2 && shared / row.size > 0.5;
  });
}

// What the reply to the taken-back text set going inside the window, settled. Each step on its own: one failing never stops the rest.
export async function settleWindow(userId: string, w: TakeBackWindow, db: Q = pool): Promise<Settled> {
  const out: Settled = { reminders: 0, relays: 0, asks: 0, goals: 0, tasks: 0, loops: 0, candidates: 0, threads: 0 };
  const rows = (sql: string, args: unknown[]) => db.query(sql, args).then((r) => r.rows).catch(() => [] as any[]);
  const inWindow = `created_at >= $2 AND created_at < $3`;
  const args = [userId, w.from, w.until];
  // A reminder set from its words, unsent: retired the way a given-up reminder is.
  for (const r of await rows(`SELECT id, what FROM member_reminders WHERE user_id = $1 AND ${inWindow} AND sent_at IS NULL`, args)) {
    if (!fromTheText(r.what, w.texts)) continue;
    out.reminders += await db.query(`UPDATE member_reminders SET queued_at = COALESCE(queued_at, NOW()), attempts = GREATEST(COALESCE(attempts, 0), $2) WHERE id = $1 AND sent_at IS NULL`, [r.id, REMINDER_RETRY.maxAttempts]).then((x) => x.rowCount ?? 0).catch(() => 0);
  }
  for (const r of await rows(`SELECT id, message FROM member_relays WHERE from_user = $1 AND ${inWindow} AND status NOT IN ('sent', 'skipped', 'failed')`, args)) {
    if (!fromTheText(r.message, w.texts)) continue;
    out.relays += await db.query(`UPDATE member_relays SET status = 'skipped' WHERE id = $1 AND status NOT IN ('sent', 'skipped', 'failed')`, [r.id]).then((x) => x.rowCount ?? 0).catch(() => 0);
  }
  // An ask captured from its words: closed by the member (askKind.ts closeAsk). A goal: set aside (goal_states "stale", never done).
  const K = await import("./askKind.js");
  const askIds: string[] = [];
  for (const r of await rows(`SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = $1 AND ${inWindow} AND resolved_at IS NULL`, args)) {
    if (!fromTheText(r.ask_text, w.texts)) continue;
    if (await K.closeAsk(userId, String(r.ask_id), "member", TAKE_BACK_WHY).catch(() => false)) { out.asks++; askIds.push(String(r.ask_id)); }
  }
  const intent = await rows(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const entries = Array.isArray(intent[0]?.intent) ? intent[0].intent : [];
  const [G, PW] = await Promise.all([import("./goalEdges.js"), import("../harness/profileWrite.js")]);
  for (const e of entries) {
    const at = e?.created_at ? Date.parse(e.created_at) : NaN;
    if (!PW.isActiveGoal(e) || !(at >= w.from.getTime() && at < w.until.getTime()) || !fromTheText(e.text, w.texts)) continue;
    if (await G.setGoalState(userId, String(e.text), "stale", TAKE_BACK_WHY, "member", { told: true }).catch(() => false)) out.goals++;
  }
  // A task the reply started or promised from its words: only a text turn's (no call job, never a call's owed link or commitment).
  const L = await import("./commitmentLog.js");
  const taskIds: number[] = [];
  for (const t of await rows(`SELECT id, their_words, source, kind, followup, goal, dispatch_key FROM co_tasks WHERE user_id = $1 AND ${inWindow} AND status = 'open'`, args)) {
    if (t.dispatch_key || /said on a call/i.test(String(t.their_words ?? "")) || !["ask", "promise"].includes(String(t.source)) || !fromTheText(t.their_words, w.texts)) continue;
    const n = await db.query(`UPDATE co_tasks SET status = 'dropped', outcome = COALESCE(outcome, $2), closed_at = COALESCE(closed_at, NOW()), updated_at = NOW() WHERE id = $1 AND status = 'open'`, [t.id, TAKE_BACK_WHY]).then((x) => x.rowCount ?? 0).catch(() => 0);
    if (!n) continue;
    out.tasks++;
    taskIds.push(Number(t.id));
    if (L.isCommitment(t)) await L.logCommitment("outcome", { userId, taskId: Number(t.id), outcome: "withdrawn", why: TAKE_BACK_WHY, source: t.source ?? null }).catch(() => {});
  }
  // A thread opened from its words (its opening quote is in the taken-back text): closed as changed, with no quote (none of theirs says how
  // it landed; the reason is the decision row's).
  const threadIds: string[] = [];
  for (const t of await rows(`SELECT id, opened_quote FROM member_threads WHERE user_id = $1 AND opened_at >= $2 AND opened_at < $3 AND status IN ('open', 'waiting')`, args)) {
    if (!w.texts.some((x) => flat(x).includes(flat(String(t.opened_quote ?? ""))) && flat(String(t.opened_quote ?? "")).length > 0)) continue;
    const n = await db.query(`UPDATE member_threads SET status = 'changed', closed_quote = NULL, closed_at = NOW(), last_touched_at = NOW() WHERE id = $1 AND status IN ('open', 'waiting')`, [t.id]).then((x) => x.rowCount ?? 0).catch(() => 0);
    if (n) { out.threads++; threadIds.push(String(t.id)); }
  }
  // The loops of what was settled above, and only those.
  const refs = [...askIds.map((id) => `ask:${id}`), ...taskIds.map((id) => `task:${id}`)];
  if (refs.length) out.loops = await db.query(`UPDATE open_loops SET status = 'dropped', status_by = 'code', closed_at = NOW(), closed_reason = $3, updated_at = NOW(), changed_at = NOW() WHERE user_id = $1 AND (source || ':' || source_ref) = ANY($2::text[]) AND status IN ('open', 'pending')`, [userId, refs, TAKE_BACK_WHY]).then((x) => x.rowCount ?? 0).catch(() => 0);
  // The follow-ups queued for what was settled (a thread's, a task's, an ask's), never a call's, a sweep's or an event's.
  const keys = [...threadIds.map((id) => `thread:${id}`), ...taskIds.map((id) => `task:${id}`), ...askIds.map((id) => `ask:${id}`)];
  if (keys.length) out.candidates = await db.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $4, updated_at = NOW() WHERE user_id = $1 AND status = 'pending' AND target_key = ANY($2::text[]) AND NOT (type = ANY($3::text[]))`, [userId, keys, NOT_FROM_A_REPLY, TAKE_BACK_WHY]).then((x) => x.rowCount ?? 0).catch(() => 0);
  return out;
}

// The inbound turn's one call (routes/sendblue.ts), before the reply: free unless their text reads as a take-back (DISOWNS), then one
// read of their last half hour of texts. Returns what was settled, or null when nothing was taken back.
export async function settleTakeBack(userId: string, message: string, now = new Date(), db: Q | null = null): Promise<Settled | null> {
  if (!DISOWNS.test(message)) return null;
  // Bounded: every settle query on one connection with a statement timeout (a test passes its own db).
  const client = db ? null : await pool.connect().catch(() => null);
  const q: Q = db ?? client ?? pool;
  try {
    if (client) await client.query(`SET statement_timeout = ${SETTLE_TIMEOUT_MS}`).catch(() => {});
    const { rows } = await q.query(
      `SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}
         AND created_at > $2::timestamptz - INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 8`,
      [userId, now],
    );
    const all = rows.reverse().map((r: any) => ({ exact: new Date(r.created_at), line: { at: new Date(r.created_at).toISOString().slice(0, 16), text: String(r.content).replace(/^User said:\s*/, ""), via: "text" as const } }));
    // This turn's own line (already logged, or not yet): the take-back is the latest line; anything after it isn't read.
    const mine = all.findIndex((x) => x.line.text.trim() === message.trim());
    const earlier = (mine >= 0 ? all.slice(0, mine) : all.filter((x) => x.exact.getTime() < now.getTime()));
    const takeBackAt = mine >= 0 ? all[mine].exact : now;
    const gone = takenBack([...earlier.map((x) => x.line), { at: takeBackAt.toISOString().slice(0, 16), text: message, via: "text" }]);
    if (!gone.length) return null;
    const goneIdx = earlier.map((x, i) => (gone.some((g) => g.at === x.line.at && g.text === x.line.text) ? i : -1)).filter((i) => i >= 0);
    const first = goneIdx[0], last = goneIdx[goneIdx.length - 1];
    // From the first taken-back text's own created_at to the next text of theirs after the last one (the take-back itself at the latest).
    const w: TakeBackWindow = { from: earlier[first].exact, until: earlier[last + 1]?.exact ?? takeBackAt, texts: goneIdx.map((i) => earlier[i].line.text) };
    const settled = await settleWindow(userId, w, q);
    await recordDecision({ layer: 4, decision: "turn.take_back", userId, outcome: "act", action: Object.entries(settled).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing to settle", proposal: { from: w.from.toISOString(), until: w.until.toISOString(), texts: w.texts.length, ...settled }, reason: TAKE_BACK_WHY }).catch(() => {});
    return settled;
  } finally {
    if (client) { await client.query(`RESET statement_timeout`).catch(() => {}); client.release(); }
  }
}
