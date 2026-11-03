// Goals and asks across the whole member journey (Royce, 2026-10-06).
//   DISCOVERY CALL  where goals are born. Two different questions ("what are you moving toward these next few months" / "what do you
//                   need right now"), then a playback ("here's what I'm carrying for you") the member corrects; the corrected list is the
//                   foundation (prompts/co-system-prompt.md, and the extraction in services/profileExtraction.ts). Goals are set once here
//                   and touched rarely after.
//   DAILY LIFE      asks flow in and get worked: searched, offered, checked on while fresh, closed on evidence (services/askLifecycle.ts).
//                   Goals stay silent: the LENS, not the conversation. Co judges every find and intro against them and almost never says
//                   them (LENS_RULE below, handed to every reply, call and offer judgment).
//   CHECK-INS       goal check-ins are rare and seasonal (GOAL_CHECKIN below): "still chasing the pre-seed, or has that shifted?", never on
//                   the 7-day ask clock, never a drumbeat.
//   THE SWEEP       goals drive ambient discovery on their own budget (services/goalSweep.ts); asks drive active hunting; offers are judged
//                   against both (services/sweepSelect.ts, the fit judge's goals).
//   EVENTS          goals frame who is worth meeting; asks write the specific reason. The brief is goals as frame, asks as bullets.
//   CLOSURE         a goal closes only at the member's word. When it does it is a companion moment (a goal_closed message that acknowledges
//                   the arc), not a status flip. Closed goals are kept: goal history is the autobiography; asks are disposable.
import pool from "../db/db.js";
import { goalEntries, isActiveGoal, type IntentEntry } from "../harness/profileWrite.js";
import { notToTeammate } from "./teamLines.js";

export const GOAL_CHECKIN = {
  // A goal is asked about only after it has gone this long without being confirmed (set, restated, or last checked in on).
  minAgeDays: 56,
  // And a member hears one such check-in at most this often, across ALL their goals: seasonal, never a drumbeat.
  everyDays: 56,
};

// What every reply, call and judgment is told about goals.
export const LENS_RULE =
  "Where they say they are headed (below) is the LENS, not the conversation. Judge every find, intro and suggestion against it, and almost never say it back. Do not recite it, do not tie things to it out loud unless they bring it up, and never ask about it in passing: a check-in on a goal is rare and seasonal and comes only from its own message.";

export function goalTexts(intent: unknown, profileGoals: string[] | null | undefined = []): string[] {
  return [...new Set([...(profileGoals ?? []), ...goalEntries(intent).map((g) => String(g.text).trim())].filter(Boolean))];
}

const DAY = 86_400_000;
const confirmedAt = (g: IntentEntry & { confirmed_at?: string | null }): number => new Date((g.confirmed_at ?? g.created_at ?? 0) as string).getTime();

// Pure: the one goal worth a seasonal check-in, or null. Oldest-unconfirmed first.
export function dueGoalCheckin(intent: unknown, lastGoalCheckinAt: Date | string | null, now = new Date()): (IntentEntry & { confirmed_at?: string | null }) | null {
  if (lastGoalCheckinAt && now.getTime() - new Date(lastGoalCheckinAt).getTime() < GOAL_CHECKIN.everyDays * DAY) return null;
  const old = (goalEntries(intent) as (IntentEntry & { confirmed_at?: string | null; checkin_done_at?: string | null })[])
    .filter((g) => confirmedAt(g) > 0 && now.getTime() - confirmedAt(g) >= GOAL_CHECKIN.minAgeDays * DAY)
    // Dropped because its state is done (goalCheckinState): never queued again, unless they confirm it again after that.
    .filter((g) => !g.checkin_done_at || confirmedAt(g) > new Date(g.checkin_done_at).getTime())
    .sort((a, b) => confirmedAt(a) - confirmedAt(b));
  return old[0] ?? null;
}

// The autobiography: every goal they have named, open or closed, in the order they named them. Never deleted.
export type GoalLine = { text: string; startedAt: string | null; closedAt: string | null; closedQuote: string | null };
export function goalHistory(intent: unknown): GoalLine[] {
  if (!Array.isArray(intent)) return [];
  return (intent as any[])
    .filter((e) => e?.kind === "goal" && typeof e?.text === "string" && e.text.trim())
    .map((e) => ({ text: String(e.text).trim(), startedAt: e.created_at ?? null, closedAt: e.status === "resolved" ? (e.resolved_at ?? null) : null, closedQuote: e.closed_quote ?? null }))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

const monthYear = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(+d) ? null : d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "America/Los_Angeles" });
};
export { monthYear };

// What the call (or a text) is told about how far they have come: closed goals, newest few. Orientation only.
export function arcLine(intent: unknown): string | null {
  const done = goalHistory(intent).filter((g) => g.closedAt).slice(-3);
  return done.length ? `Goals they have closed (their arc; never recite, bring up only when it fits): ${done.map((g) => `${g.text} (${monthYear(g.startedAt) ?? "earlier"} to ${monthYear(g.closedAt)})`).join("; ")}` : null;
}

// ---- the same open list the resolution pass reads: errands AND goals, so a goal can close at their word
// And Cue's open tasks for them (closure audit, 2026-11-02: "the Sequin AI launch party is off, so drop that" retired one goal and one
// ask; a task carried for the launch could never close there, since the read never saw it). A task's id is "task:<id>", so it never
// collides with an ask's or a goal's. kind labels each line for the read: an ask, a look-out (an ask they asked Cue to watch for), a
// goal, or Cue's task.
export type OpenItemKind = "ask" | "lookout" | "goal" | "task";
export const TASK_ITEM = "task:";
export async function openErrandsAndGoals(userId: string): Promise<{ ask_id: string; ask_text: string; kind: OpenItemKind; link?: string | null; owned?: boolean }[]> {
  const [asks, prof, tasks] = await Promise.all([
    pool.query(`SELECT ask_id, ask_text, intent FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`, [userId]),
    pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]),
    // A task read that fails leaves tasks out of this read (nothing closes from a list it didn't see); asks and goals still read.
    pool
      .query(`SELECT id, goal, target_key, followup->>'goalId' AS goal_id FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind IN ('work', 'followup', 'research_brief') ORDER BY created_at DESC LIMIT 20`, [userId])
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const goals = goalEntries(prof.rows[0]?.intent).map((g) => ({ ask_id: String(g.id), ask_text: String(g.text), kind: "goal" as const }));
  const open = asks.rows.map((a: any) => ({ ask_id: String(a.ask_id), ask_text: String(a.ask_text), kind: (a.intent === "lookout" ? "lookout" : "ask") as OpenItemKind }));
  // What a task serves, for code only: the ask an ask check-in is for (its target key), and whether it's a piece of a goal Cue carries.
  const work = (tasks.rows ?? [])
    .map((t: any) => ({ ask_id: `${TASK_ITEM}${t.id}`, ask_text: String(t.goal ?? ""), kind: "task" as const, link: /^ask_checkin:/.test(String(t.target_key ?? "")) ? String(t.target_key).slice("ask_checkin:".length) : null, owned: t.goal_id != null }))
    .filter((t: { ask_text: string }) => t.ask_text.trim());
  return [...open, ...goals, ...work];
}

// ---- closing a goal: only at the member's word, and a companion moment
// quiet: a goal that closed only because it went with something they dropped (profileExtraction.ts, the related read). It closes the
// same way, set aside rather than done, and no goal_closed moment goes: they said the thing it served is off, and Cue already answered
// that in the reply; a second message about a goal they didn't name would be noise.
export async function closeGoal(userId: string, goalId: string, quote: string | null, o: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
    const intent: any[] = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
    const goal = intent.find((e) => e?.id === goalId && isActiveGoal(e));
    if (!goal) return false;
    const now = new Date().toISOString();
    const next = intent.map((e) => (e === goal ? { ...e, status: "resolved", resolved_at: now, closed_by: "member", closed_quote: quote ? String(quote).slice(0, 240) : null } : e));
    await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
    // The goal's state (services/goalEdges.ts): done at their word, so it stops generating searches and stays on file.
    if (o.quiet) {
      await import("./goalEdges.js").then((m) => m.setGoalState(userId, String(goal.text), "stale", "went with something they dropped", "member")).catch(() => {});
      return true;
    }
    await import("./goalEdges.js").then((m) => m.setGoalState(userId, String(goal.text), "done", quote ? `they said: "${String(quote).slice(0, 160)}"` : "they closed it", "member")).catch(() => {});
    const { enqueueCandidate } = await import("../harness/proactive.js");
    await enqueueCandidate({
      userId,
      type: "goal_closed",
      targetKey: `goal_closed:${goalId}`,
      topicKey: `goal:${goalId}`,
      summary: `A goal closed at their word: "${String(goal.text).slice(0, 100)}"`,
      payload: { goalId, text: String(goal.text), startedIn: monthYear(goal.created_at ?? null), closedIn: monthYear(now), quote: quote ? String(quote).slice(0, 240) : null },
      dueAt: new Date(Date.now() + 5 * 60_000),
      expiresAt: new Date(Date.now() + 3 * DAY),
    }).catch((err: any) => console.error("goal closed: moment not queued (non-fatal):", err?.message ?? err));
    return true;
  } catch (err: any) {
    console.error("goalJourney: closing a goal failed (non-fatal):", err?.message ?? err);
    return false;
  }
}

// ---- one acknowledgment (Royce, 2026-11-03: "got the venue" / "perfect, thanks" become the close: acknowledge once)
// The goal_closed moment goes 5 minutes after the close, and the reply in the turn that closed it may already have said it. Decided from
// Cue's own reply in that turn, never their words: the turn's move was close (#368: the reply was checked to acknowledge it once), or
// Cue's reply said so. A warm word ("congrats", "so glad", "you did it") is enough; a plain one ("got it", "makes sense") counts only
// when the line also names the goal (most of its words).
export const ACK_WARM = /\b(?:congrat\w*|you did it|you made it|well done|nice work|great work|so (?:glad|happy) for you|happy for you|proud of you|well earned|that's (?:huge|great news|amazing|wonderful|a big (?:one|step|deal))|big (?:step|win|deal)|love (?:that|this|to hear)|good for you)\b/i;
export const ACK_PLAIN = /\b(?:got it|noted|understood|makes sense|fair enough|good call|no problem|i'll stop|stop(?:ping)? (?:looking|searching)|let(?:ting)? (?:it|that) go|off (?:the|your) list|closing (?:it|that))\b/i;
const goalWords = (t: string) => new Set(String(t).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w.length > 3));
export function namesGoal(line: string, goal: string): boolean {
  const g = goalWords(goal);
  if (!g.size) return false;
  const l = goalWords(line);
  let n = 0;
  for (const w of g) if (l.has(w) || l.has(w.replace(/s$/, "")) || l.has(`${w}s`)) n++;
  return n / g.size >= 0.5;
}
// Pure: the reply in the closing turn already acknowledged the close. moves: that turn's logged moves (turn.move_read); lines: Cue's own
// sent lines in that turn (text bubbles, or Cue's side of the call that closed it).
export function replyAcknowledgedClose(o: { moves: string[]; lines: string[]; goal: string }): { acknowledged: boolean; why: string } {
  if (o.moves.includes("close")) return { acknowledged: true, why: "the reply's move was close" };
  // Only Cue's statements: a line that ends in a question isn't an acknowledgment.
  const said = o.lines.flatMap((l) => String(l).split(/(?<=[.!?])\s+/)).filter((x) => x.trim() && !/\?\s*$/.test(x));
  if (said.some((x) => ACK_WARM.test(x))) return { acknowledged: true, why: "the reply said it warmly" };
  if (said.some((x) => ACK_PLAIN.test(x) && namesGoal(x, o.goal))) return { acknowledged: true, why: "the reply named it and let it go" };
  return { acknowledged: false, why: "the reply didn't acknowledge it" };
}
export const ACKNOWLEDGED_IN_REPLY = "the reply that closed it already acknowledged it";
type DbQ = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
// Cue's own reply in the turn that closed the goal at closedAt (the goal_closed candidate's own time): their last text up to then (within
// two hours), and what Cue sent and decided after it until their next text. With no text, the call that closed it (Cue's lines).
export async function closingTurnReply(userId: string, closedAt: Date, db: DbQ = pool): Promise<{ moves: string[]; lines: string[] }> {
  const since = new Date(closedAt.getTime() - 2 * 3_600_000);
  const { rows: inb } = await db.query(`SELECT created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at <= $2 AND created_at > $3 ORDER BY created_at DESC LIMIT 1`, [userId, closedAt, since]);
  if (inb[0]?.created_at) {
    const from = new Date(inb[0].created_at);
    const { rows: next } = await db.query(`SELECT created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > $2 ORDER BY created_at LIMIT 1`, [userId, from]);
    const to = next[0]?.created_at ? new Date(next[0].created_at) : new Date();
    const [replies, moves] = await Promise.all([
      db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} AND created_at > $2 AND created_at < $3 ORDER BY created_at`, [userId, from, to]),
      db.query(`SELECT action FROM harness_decisions WHERE user_id = $1 AND decision = 'turn.move_read' AND created_at >= $2 AND created_at < $3`, [userId, from, to]),
    ]);
    // Cue's own bubbles (the stored prefix), never their words.
    const cue = replies.rows.map((r: any) => String(r.content ?? "")).filter((t: string) => /^Co replied:/i.test(t));
    return { moves: moves.rows.map((r: any) => String(r.action ?? "")), lines: cue.map((t: string) => t.replace(/^Co replied:\s*/i, "")) };
  }
  const { rows: call } = await db.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND created_at <= $2 AND created_at > $3 ORDER BY created_at DESC LIMIT 1`, [userId, new Date(closedAt.getTime() + 60_000), since]);
  const cue = String(call[0]?.content ?? "").split(/\n+/).filter((l) => /^\s*(?:agent|assistant|co|cue|ai)\s*:/i.test(l)).map((l) => l.replace(/^\s*\w+\s*:\s*/, ""));
  return { moves: [], lines: cue.slice(-6) };
}

// A profile goal that came off their list at their word (profileExtraction.ts applyRetirements) takes its goal state with it, so it
// never reads as an active goal "no longer on file" (services/memberKnowledge.ts goalsOf): done when they said it's over, set aside
// when it only went with something they dropped. Only a row that's there and still active moves; none is made for a goal that never
// had one. No moment: a profile goal is direction they mentioned, not one they set with Cue.
export async function retireGoalStates(userId: string, goals: { goal: string; related: boolean; quote: string | null }[]): Promise<string[]> {
  if (!goals.length) return [];
  const G = await import("./goalEdges.js");
  const { rows } = await pool
    .query(`SELECT goal_hash FROM goal_states WHERE user_id = $1 AND state = 'active' AND goal_hash = ANY($2::text[])`, [userId, goals.map((x) => G.goalHash(x.goal))])
    .catch(() => ({ rows: [] as any[] }));
  const live = new Set(rows.map((x: any) => String(x.goal_hash)));
  const done: string[] = [];
  for (const g of goals) {
    if (!live.has(G.goalHash(g.goal))) continue;
    // Their words stay out of the row (the read's decision has the ids; review of #351).
    const ok = await G.setGoalState(userId, g.goal, g.related ? "stale" : "done", g.related ? "went with something they dropped" : "they said it's over", "member").catch(() => false);
    if (ok) done.push(g.goal);
  }
  return done;
}

// ---- the seasonal check-in cron (daily): at most one candidate per member per season
export async function runGoalCheckins(now = new Date()): Promise<number> {
  const { rows } = await pool.query(
    `SELECT cp.user_id, cp.intent,
            (SELECT max(sent_at) FROM proactive_sends s WHERE s.user_id = cp.user_id AND s.type = 'goal_checkin') AS last_checkin
     FROM co_profiles cp JOIN users u ON u.id = cp.user_id
     WHERE u.archived_at IS NULL AND u.sms_opted_out = false AND jsonb_typeof(cp.intent) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(cp.intent) e WHERE e->>'kind' = 'goal' AND e->>'status' = 'active')
     LIMIT 200`,
  );
  const { enqueueCandidate } = await import("../harness/proactive.js");
  let n = 0;
  for (const r of rows) {
    const g = dueGoalCheckin(r.intent, r.last_checkin, now);
    if (!g) continue;
    const res = await enqueueCandidate({
      userId: r.user_id,
      type: "goal_checkin",
      targetKey: `goal_checkin:${g.id}:${now.toISOString().slice(0, 7)}`,
      topicKey: `goal:${g.id}`,
      summary: `Seasonal check-in on a goal: "${String(g.text).slice(0, 100)}"`,
      payload: { goalId: g.id, text: String(g.text), since: monthYear((g.confirmed_at ?? g.created_at) as string) },
      expiresAt: new Date(now.getTime() + 10 * DAY),
    }).catch(() => ({ queued: false }));
    if (res.queued) n++;
  }
  return n;
}

// Pure: the goal check-in's context from what Co knows about them (services/memberKnowledge.ts, goals with state, read once by the
// dispatch): this goal's state there, or null when it isn't on file there (then the profile entry alone decides, as before). A goal
// whose state is done (closed at their word, services/goalEdges.ts) is history and never asked about as current direction.
export function goalCheckinState(goals: readonly { text: string; state: "active" | "done" | "stale" }[], text: string): "active" | "done" | "stale" | null {
  const key = text.trim().toLowerCase();
  return goals.find((g) => g.text.trim().toLowerCase() === key)?.state ?? null;
}

// A check-in dropped because the goal's state is done (the profile entry still reads active): marked on the entry so the cron
// (dueGoalCheckin) stops re-queuing it every month. Only confirming the goal again after this re-arms it.
export const GOAL_DONE_SKIP = "that goal is done";
export async function markGoalCheckinDone(userId: string, goalId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const intent: any[] = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
  if (!intent.some((e) => e?.id === goalId)) return;
  const next = intent.map((e) => (e?.id === goalId ? { ...e, checkin_done_at: new Date().toISOString() } : e));
  await pool.query(`UPDATE co_profiles SET intent = $2::jsonb WHERE user_id = $1`, [userId, JSON.stringify(next)]);
}

// Sending a seasonal check-in resets that goal's clock, so the next one is a season away.
export async function markGoalCheckedIn(userId: string, goalId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const intent: any[] = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
  if (!intent.some((e) => e?.id === goalId)) return;
  const next = intent.map((e) => (e?.id === goalId ? { ...e, confirmed_at: new Date().toISOString() } : e));
  await pool.query(`UPDATE co_profiles SET intent = $2::jsonb WHERE user_id = $1`, [userId, JSON.stringify(next)]);
}
