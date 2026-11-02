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
export async function openErrandsAndGoals(userId: string): Promise<{ ask_id: string; ask_text: string; kind: OpenItemKind }[]> {
  const [asks, prof, tasks] = await Promise.all([
    pool.query(`SELECT ask_id, ask_text, intent FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`, [userId]),
    pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]),
    // A task read that fails leaves tasks out of this read (nothing closes from a list it didn't see); asks and goals still read.
    pool
      .query(`SELECT id, goal FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind IN ('work', 'followup', 'research_brief') ORDER BY created_at DESC LIMIT 20`, [userId])
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const goals = goalEntries(prof.rows[0]?.intent).map((g) => ({ ask_id: String(g.id), ask_text: String(g.text), kind: "goal" as const }));
  const open = asks.rows.map((a: any) => ({ ask_id: String(a.ask_id), ask_text: String(a.ask_text), kind: (a.intent === "lookout" ? "lookout" : "ask") as OpenItemKind }));
  const work = (tasks.rows ?? []).map((t: any) => ({ ask_id: `${TASK_ITEM}${t.id}`, ask_text: String(t.goal ?? ""), kind: "task" as const })).filter((t: { ask_text: string }) => t.ask_text.trim());
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
      await import("./goalEdges.js").then((m) => m.setGoalState(userId, String(goal.text), "stale", quote ? `went with what they dropped: "${String(quote).slice(0, 160)}"` : "went with what they dropped", "member")).catch(() => {});
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
    const q = String(g.quote ?? "").slice(0, 160);
    const ok = await G.setGoalState(userId, g.goal, g.related ? "stale" : "done", g.related ? `went with what they dropped: "${q}"` : `they said: "${q}"`, "member").catch(() => false);
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
