// The goal recheck (Royce, 2026-10-13: "Lookouts end on a date, inferred interests lapse, but goals only end as done, replaced or
// dropped, so a quiet goal gets searched every morning forever. Give goals a recheck: no new signal inside a set window, Co asks me
// once, no answer moves the goal to idle and it stops being searched. Any reply brings it back."):
//   1. A signal is their own text naming the goal (read only through services/sourceFence.ts: never their talk with a teammate,
//      never another member's data), a reaction to a find served for that goal, or a goal action (markGoal, pickGoalItems). It
//      moves goal_states.last_signal_at. A goal on file with no row gets one (active) the first time the goal sweep sees it.
//   2. RECHECK_AFTER_DAYS with no signal: the recheck is due, for a goal the sweep is actually searching. It is raised once, in the
//      next natural reply (the set-aside hint, harness/replyGrounding.ts); with no exchange for RECHECK_TEXT_AFTER_DAYS after it came
//      due, one short text (goal_recheck, harness/proactiveRegistry.ts), under every send gate. Asked means sent: recheck_asked_at is
//      set only when a text that went out raised the goal.
//   3. RECHECK_ANSWER_DAYS after the ask with no signal: idle (stale, RECHECK_IDLE_REASON, already told, so never asked again). The
//      sweeps stop searching it (goalEdges.ts planGoalSweep reads active goals only); it stays on file.
//   4. Any text of theirs naming an idle goal brings it back (active, the ask cleared); markGoal still works.
// Every decision (due, ask, idle, revive) is made in one pure function, recheckDecide. Every read and write is one member's own.
import pool from "../db/db.js";
import { goalHash, setGoalState, fromStateRow, type GoalState, type GoalStateRow } from "./goalEdges.js";

export const RECHECK_AFTER_DAYS = 14;
export const RECHECK_ANSWER_DAYS = 7;
export const RECHECK_TEXT_AFTER_DAYS = 3;
export const RECHECK_IDLE_REASON = "no answer to the recheck";
// The reply raises a due recheck at most this many times; after that it's left to the one text (review of the build, 2026-10-13).
export const RECHECK_REPLY_HINTS = 2;
// How far back the run reads their texts and reactions: a whole quiet stretch plus the answer window.
export const RECHECK_LOOKBACK_DAYS = RECHECK_AFTER_DAYS + RECHECK_ANSWER_DAYS;
const DAY = 86_400_000;
// Pure: a recheck question is still out (asked inside the answer window). After that it no longer holds back other goal messages: an
// unsearched goal is never idled, so a stale ask on it would otherwise silence its check-ins and nudges for good (review of the recheck).
export function recheckAskOpen(askedAt: Date | null | undefined, now = new Date()): boolean {
  return !!askedAt && now.getTime() - askedAt.getTime() < RECHECK_ANSWER_DAYS * DAY;
}

// ---------- pure

// Words that say nothing about which goal it is (openLoops.ts LOOP_STOP, plus the verbs a goal is phrased with).
const STOP = new Set(["that", "this", "with", "from", "about", "have", "will", "would", "could", "should", "what", "when", "then", "there", "their", "them", "your", "just", "some", "find", "finding", "look", "looking", "want", "wants", "need", "help", "thing", "things", "something", "anything", "still", "also", "into", "over", "very", "much", "like", "know", "think", "going", "been", "they", "were", "does", "really", "maybe", "today", "tomorrow", "week", "next", "good", "great", "more", "people", "meet", "make", "start", "keep", "able", "time", "year", "month"]);
// A light stem, the same on both sides: "clubs" and "club", "classes" and "class", "running" and "runn". "ed" comes off only when at
// least five letters stay ("booked" stays "booked", never "book").
const stem = (w: string) => {
  let x = w.length > 5 ? w.replace(/ing$/, "") : w;
  if (/ed$/.test(x) && x.length - 2 >= 5) x = x.slice(0, -2);
  x = x.replace(/(ss|x|ch|sh)es$/, "$1");
  return x.length > 3 && /[^s]s$/.test(x) ? x.slice(0, -1) : x;
};
const meaning = (s: string): string[] => [...new Set((String(s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 3 && !STOP.has(w)).map(stem))];

// Pure: whether a text of theirs names this goal (goalEdges.ts raisedGoal's rule without the question): at least three of its
// meaning words, or half of them when it has fewer, and never just one when it has two or more ("learn Spanish" is not named by
// "learn more about that gallery"). A goal with no meaning words ("AI", "5k") is never named by a word match.
export function mentionsGoal(text: string, goal: string): boolean {
  const g = new Set(meaning(goal));
  if (!g.size) return false;
  const shared = new Set(meaning(text).filter((w) => g.has(w))).size;
  return shared >= (g.size >= 2 ? Math.max(2, Math.min(3, Math.ceil(g.size / 2))) : 1);
}

// Whether a sent text asked the recheck (Royce: Haiku judges intent, not word matching). One short Haiku read, run only after the text
// went out (goalEdges.ts noteGoalHints, the goal_nudge and goal_checkin sends) or on the recheck text's draft, never on a reply's
// critical path. Strict JSON; anything else, an error or a timeout is "not asked" (the reply's hint is counted as used instead). The
// only code filter: a text with no question mark at all is never a question, so it costs no call.
export type RecheckJudge = (prompt: string) => Promise<string>;
export const RECHECK_JUDGE = { timeoutMs: 8000, maxOutputTokens: 1500 } as const;
// kind "ask": the same read for a find ask's retirement question (services/askRetire.ts): whether they still want Co looking for it.
export function recheckJudgePrompt(goal: string, sent: string, kind: "goal" | "ask" = "goal"): string {
  if (kind === "ask") return `A member of a private club asked Cue to look for this: "${goal.slice(0, 300)}".

Cue just sent them this text:
"""
${sent.slice(0, 1500)}
"""

Did this text ask them whether they still want Cue looking for it (so they can say yes or let it go)? It does NOT count when the question is an offer (to send, book or find something specific), when it asks about a different topic or plan, or when the thing is only mentioned in passing.

Answer only with JSON: {"asked": true or false, "reason": "a few words"}`;
  return `A member of a private club told Cue this goal: "${goal.slice(0, 300)}".

Cue just sent them this text:
"""
${sent.slice(0, 1500)}
"""

Did this text ask them whether they still want this goal, or are still pursuing it (so they can say yes or that it's over)? It does NOT count when the question is an offer (to send, book or find something), when it asks how it's going or about progress (that assumes they still want it), when it asks about a different topic or plan, or when the goal is only mentioned in passing.

Answer only with JSON: {"asked": true or false, "reason": "a few words"}`;
}
// Pure: the judge's answer, strictly. Only {"asked": true} is a yes.
export function readRecheckJudge(raw: string): { asked: boolean; reason: string } {
  try {
    const j = JSON.parse(String(raw ?? "").replace(/```(?:json)?/g, "").trim());
    if (!j || typeof j !== "object" || typeof j.asked !== "boolean") return { asked: false, reason: "unreadable answer" };
    return { asked: j.asked, reason: String(j.reason ?? "").slice(0, 160) };
  } catch {
    return { asked: false, reason: "unreadable answer" };
  }
}
export const haikuRecheckJudge: RecheckJudge = async (prompt) => {
  const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: RECHECK_JUDGE.maxOutputTokens, experimental_telemetry: { isEnabled: true, functionId: "goal.recheckAsked" }, prompt, abortSignal: AbortSignal.timeout(RECHECK_JUDGE.timeoutMs) });
  return text;
};
export async function judgeRecheckAsked(goal: string, sent: string, judge: RecheckJudge = haikuRecheckJudge, kind: "goal" | "ask" = "goal"): Promise<{ asked: boolean; reason: string }> {
  if (!/\?/.test(String(sent ?? ""))) return { asked: false, reason: "no question in it" };
  try {
    return readRecheckJudge(await judge(recheckJudgePrompt(goal, sent, kind)));
  } catch (err: any) {
    return { asked: false, reason: `the read failed: ${String(err?.message ?? err).slice(0, 80)}` };
  }
}

// Pure: the deploy backfill's offset for a goal, 0 to 6 days from its hash (the migration computes the same), so the goals that
// were on file at deploy don't all come due on one day.
export function backfillOffsetDays(hash: string): number {
  return parseInt(String(hash).slice(0, 7), 16) % 7 || 0;
}

// Pure: the edges a goal find searched ("look for: a; b. enjoys: ..." from goalEdges.ts edgeSearchText).
export function findEdges(askText: string): string[] {
  const m = String(askText ?? "").match(/^look for: ([\s\S]*?)(?:\. (?:enjoys|specifics): [\s\S]*)?$/);
  return m ? m[1].split("; ").map((e) => e.trim().toLowerCase()).filter(Boolean) : [];
}

// Pure: the one goal a find was served for, or null. A find belongs to a goal when every edge it searched is one of that goal's
// planned edges and no other goal's covers it too (the 9am sweep searches each goal on its own; the hourly sweep's mixed search
// belongs to no one goal, so a reaction to it moves none).
export function findGoalOf(askText: string, plans: { goalHash: string; edges: string[] }[]): string | null {
  const f = findEdges(askText);
  if (!f.length) return null;
  const byGoal = new Map<string, Set<string>>();
  for (const p of plans) for (const e of p.edges) (byGoal.get(p.goalHash) ?? byGoal.set(p.goalHash, new Set()).get(p.goalHash)!).add(String(e).trim().toLowerCase());
  const owners = [...byGoal.entries()].filter(([, edges]) => f.every((e) => edges.has(e))).map(([h]) => h);
  return owners.length === 1 ? owners[0] : null;
}

export type RecheckRow = {
  goalHash: string;
  goal: string;
  state: GoalState;
  reason: string;
  source: GoalStateRow["source"];
  changedAt: Date;
  lastSignalAt: Date;
  recheckAskedAt: Date | null;
  // The goal sweep's latest plan searches it (an edge to look for). A goal that isn't searched has nothing to recheck.
  searched: boolean;
  // Replies that carried the recheck and didn't raise it.
  hints?: number;
};
export type GoalSignal = { goalHash: string; at: Date; kind: "text" | "reaction" | "action" };
export type RecheckInput = {
  rows: RecheckRow[];
  now: Date;
  signals: GoalSignal[];
  // Their latest text to Co (fenced), or null: an exchange in RECHECK_TEXT_AFTER_DAYS means the reply raises it, not a text.
  lastExchangeAt: Date | null;
  // Why a goal text would be held for them now (harness/proactive.ts sweepHold); any reason means no recheck text.
  held: string[];
  // Goals with a recheck text already waiting to go: one recheck text in flight per member.
  pendingText: string[];
  // When a recheck question last went out to them, about any goal (their goal.recheck_asked decisions). Never cleared by an answer,
  // so the spacing between two questions survives one being answered.
  lastAskAt?: Date | null;
};
// signal: their newer signal is recorded (last_signal_at); due: the next natural reply asks; text: one short text is queued;
// asked: the question went out, waiting on them; idle: no answer, set aside; revive: an idle goal they brought up again.
export type RecheckAction = "none" | "signal" | "due" | "text" | "asked" | "idle" | "revive";
export type RecheckStep = { goalHash: string; goal: string; action: RecheckAction; signalAt: Date | null; clearAsk: boolean; dueAt: Date | null; why: string };

export const isRecheckIdle = (r: Pick<RecheckRow, "state" | "source" | "reason">) => r.state === "stale" && r.source === "context" && r.reason === RECHECK_IDLE_REASON;

// Unsure (closure audit, 2026-11-02; Royce: "when unsure, keep it, and ask once"): they dropped something, and the resolution read
// couldn't tell whether this goal went with it (services/profileExtraction.ts applyRetirements). It stays active and searched, and its
// recheck is due now instead of after RECHECK_AFTER_DAYS: the same one question (the next natural reply, or the one paced text), the
// same answer handling (markGoal), the same idle when a searched goal gets no answer. The mark lives on the row's reason (with the
// words they said) and goes the moment the question goes out (markRecheckAsked), or when they bring the goal up or act on it after it.
export const UNSURE_PREFIX = "unsure: ";
export const unsureReason = (quote: string) => `${UNSURE_PREFIX}they said "${String(quote ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}", and it may go with that`;
// The words they said, for the reply's question; null when the row isn't unsure.
export const unsureQuote = (reason: string | null | undefined): string | null => (String(reason ?? "").startsWith(UNSURE_PREFIX) ? (String(reason).match(/they said "(.*)", and it may go with that$/)?.[1] ?? null) : null);
export const isUnsure = (r: { state: GoalState; reason?: string | null; recheckAskedAt?: Date | null }): boolean =>
  r.state === "active" && !r.recheckAskedAt && String(r.reason ?? "").startsWith(UNSURE_PREFIX);
// Kept active and marked; a goal with a recheck already out, or one that isn't active, is left as it is (it was already asked, or it's
// already settled).
export async function markUnsure(userId: string, goal: string, quote: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO goal_states (user_id, goal_hash, goal_text, state, reason, source, changed_at, told_at, hints, last_signal_at)
     VALUES ($1, $2, $3, 'active', $4, 'context', NOW(), NOW(), 0, NOW())
     ON CONFLICT (user_id, goal_hash) DO UPDATE SET reason = EXCLUDED.reason, changed_at = NOW(), hints = 0
     WHERE goal_states.state = 'active' AND goal_states.recheck_asked_at IS NULL`,
    [userId, goalHash(goal), goal.slice(0, 500), unsureReason(quote)],
  );
  if (rowCount) await realRecheckDeps.log({ userId, decision: "goal.recheck_due", outcome: "act", action: "unsure_after_drop", reason: "they dropped something this goal may go with: kept, asked once", proposal: { goal: goal.slice(0, 200), goalHash: goalHash(goal) } }).catch(() => {});
  return !!rowCount;
}

// Pure: every recheck decision for one member's goals. At most one text per member per run (the goal due longest), none while held
// or while one is already waiting. A recheck asked once is never asked again for the same quiet stretch: a signal after it clears it
// (answered), no signal for RECHECK_ANSWER_DAYS idles the goal for good unless they bring it up.
export function recheckDecide(input: RecheckInput): RecheckStep[] {
  const { now } = input;
  const latest = new Map<string, Date>();
  for (const s of input.signals) {
    if (s.at.getTime() > now.getTime()) continue;
    const prev = latest.get(s.goalHash);
    if (!prev || s.at > prev) latest.set(s.goalHash, s.at);
  }
  const steps = input.rows.map((r): RecheckStep => {
    const seen = latest.get(r.goalHash) ?? null;
    const newer = seen && seen > r.lastSignalAt ? seen : null;
    const base = { goalHash: r.goalHash, goal: r.goal, signalAt: newer, clearAsk: false, dueAt: null as Date | null };
    if (isRecheckIdle(r)) {
      // Brought up again since it went idle: back.
      if (seen && seen > r.changedAt) return { ...base, signalAt: seen, action: "revive", clearAsk: true, why: "they brought it up again" };
      return { ...base, signalAt: null, action: "none", why: "idle" };
    }
    if (r.state !== "active") return { ...base, signalAt: null, action: "none", why: r.state };
    const last = newer ?? r.lastSignalAt;
    if (r.recheckAskedAt) {
      if (last > r.recheckAskedAt) return { ...base, signalAt: last, action: "signal", clearAsk: true, why: "answered: a signal since the recheck" };
      // No longer searched (it became a work plan, or has no findable side): nothing to idle, it costs no search.
      if (!r.searched) return { ...base, action: newer ? "signal" : "none", why: "asked, but no longer searched" };
      if (now.getTime() - r.recheckAskedAt.getTime() >= RECHECK_ANSWER_DAYS * DAY) return { ...base, action: "idle", why: `no signal in ${RECHECK_ANSWER_DAYS} days since the recheck` };
      return { ...base, action: "asked", why: "asked; waiting on them" };
    }
    // Unsure whether it went with something they dropped: due now, searched or not. They named it or acted on it since: it stays.
    if (isUnsure(r)) {
      if (last > r.changedAt) return { ...base, signalAt: last, action: "signal", why: "unsure, but they brought it up since: it stays" };
      return { ...base, dueAt: r.changedAt, action: "due", why: "unsure whether it went with something they dropped" };
    }
    const dueAt = new Date(last.getTime() + RECHECK_AFTER_DAYS * DAY);
    if (now < dueAt || !r.searched) return { ...base, action: newer ? "signal" : "none", why: now < dueAt ? "a recent signal" : "not searched, nothing to recheck" };
    return { ...base, dueAt, action: "due", why: `no signal in ${RECHECK_AFTER_DAYS} days` };
  });
  // One question at a time per member (review of the build, 2026-10-13): only the goal due longest stays due, and none while another
  // goal's recheck went out within RECHECK_TEXT_AFTER_DAYS. Covers the reply and the text alike.
  // The last ask is the newer of their logged asks (lastAskAt, which an answer never clears) and any ask still open on a row.
  const lastAsk = input.rows.reduce<Date | null>((m, r) => (r.recheckAskedAt && (!m || r.recheckAskedAt > m) ? r.recheckAskedAt : m), input.lastAskAt ?? null);
  const spaced = !lastAsk || now.getTime() - lastAsk.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY;
  const dues = steps.filter((s) => s.action === "due").sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
  // The reply's pick skips a goal whose reply attempts are used up (hints, RECHECK_REPLY_HINTS): that one waits for the text, and
  // never blocks the next goal. The text's pick is the goal due longest that's been due long enough, whatever its hints.
  const hintsOf = new Map(input.rows.map((r) => [r.goalHash, r.hints ?? 0]));
  const replyPick = dues.find((s) => (hintsOf.get(s.goalHash) ?? 0) < RECHECK_REPLY_HINTS) ?? null;
  const textPick = dues.find((s) => now.getTime() - s.dueAt!.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY) ?? null;
  for (const s of dues) {
    if (!spaced) Object.assign(s, { action: "none" as const, why: `another recheck went out within ${RECHECK_TEXT_AFTER_DAYS} days` });
    else if (s !== replyPick && s !== textPick) Object.assign(s, { action: "none" as const, why: "one question at a time: another goal is due longer" });
    else if (s !== replyPick) s.why = `its ${RECHECK_REPLY_HINTS} reply attempts are used; left to the text`;
  }
  // The one text, if any: due for RECHECK_TEXT_AFTER_DAYS, no exchange in that long, nothing holding it, none already waiting.
  const quiet = !input.lastExchangeAt || now.getTime() - input.lastExchangeAt.getTime() >= RECHECK_TEXT_AFTER_DAYS * DAY;
  if (spaced && textPick && quiet) {
    const pick = textPick;
    if (input.held.length) pick.why = `held: ${input.held.join(", ")}`;
    else if (input.pendingText.length) pick.why = "a recheck text is already waiting";
    else Object.assign(pick, { action: "text" as const, why: `due ${RECHECK_TEXT_AFTER_DAYS}+ days with no exchange` });
  }
  return steps;
}

// Pure: their own texts (already fenced) as signals for the goals they name.
export function textSignals(lines: { at: Date; text: string }[], goals: { goalHash: string; goal: string }[]): GoalSignal[] {
  return lines.flatMap((l) => goals.filter((g) => mentionsGoal(l.text, g.goal)).map((g) => ({ goalHash: g.goalHash, at: l.at, kind: "text" as const })));
}

// ---------- the run (one member)

export type RecheckDeps = {
  rows: (userId: string) => Promise<GoalStateRow[]>;
  // A row for a goal on file that has none, its clock starting now plus its backfill offset (backfillOffsetDays).
  ensure: (userId: string, goal: string) => Promise<void>;
  // Their own texts to Co in the last `days`, fenced (sourceFence.ts readTheirTexts); null when the fence failed (nothing is decided).
  texts: (userId: string, days: number) => Promise<{ at: Date; text: string }[] | null>;
  // Reactions to goal finds: the find's search text and when they reacted.
  reactions: (userId: string, days: number) => Promise<{ askText: string; at: Date }[]>;
  // The goal sweep's plans, newest first: each goal's edges, and whether the newest whole plan searches it.
  plans: (userId: string) => Promise<{ goalHash: string; edges: string[]; latest: boolean }[]>;
  held: (userId: string) => Promise<string[]>;
  // When their last recheck question went out (goal.recheck_asked, any goal), or null.
  lastAsk: (userId: string) => Promise<Date | null>;
  pendingText: (userId: string) => Promise<string[]>;
  signal: (userId: string, goalHashValue: string, at: Date, clearAsk: boolean) => Promise<void>;
  revive: (userId: string, goal: string, at: Date) => Promise<boolean>;
  idle: (userId: string, goal: string) => Promise<boolean>;
  queueText: (userId: string, step: RecheckStep, lastSignalAt: Date) => Promise<boolean>;
  log: (d: { userId: string; decision: string; outcome: "act" | "skip"; action: string; reason?: string | null; proposal: Record<string, unknown> }) => Promise<void>;
};

const toRecheckRow = (r: GoalStateRow, searched: Set<string>, now: Date): RecheckRow => ({
  goalHash: r.goalHash, goal: r.goal, state: r.state, reason: r.reason, source: r.source, changedAt: r.changedAt,
  lastSignalAt: r.lastSignalAt ?? now, recheckAskedAt: r.recheckAskedAt ?? null, searched: searched.has(r.goalHash), hints: r.hints ?? 0,
});

// What the run does with each step. only: the steps this caller may act on (the text route records signals and revives only).
export async function applySteps(userId: string, steps: RecheckStep[], rows: RecheckRow[], deps: Pick<RecheckDeps, "signal" | "revive" | "idle" | "queueText" | "log">, only?: Set<RecheckAction>): Promise<void> {
  const byHash = new Map(rows.map((r) => [r.goalHash, r]));
  for (const s of steps) {
    if (only && !only.has(s.action)) {
      if (s.signalAt && only.has("signal")) await deps.signal(userId, s.goalHash, s.signalAt, false).catch(() => {});
      continue;
    }
    const r = byHash.get(s.goalHash);
    const proposal = { goal: s.goal.slice(0, 200), goalHash: s.goalHash, lastSignalAt: r?.lastSignalAt ?? null, recheckAskedAt: r?.recheckAskedAt ?? null, why: s.why };
    if (s.action === "revive") {
      const ok = await deps.revive(userId, s.goal, s.signalAt!).catch(() => false);
      await deps.log({ userId, decision: "goal.revived", outcome: ok ? "act" : "skip", action: ok ? "active" : "not_changed", reason: s.why, proposal }).catch(() => {});
      continue;
    }
    if (s.signalAt) await deps.signal(userId, s.goalHash, s.signalAt, s.clearAsk).catch(() => {});
    if (s.action === "signal" && s.clearAsk) await deps.log({ userId, decision: "goal.recheck_asked", outcome: "act", action: "answered", reason: s.why, proposal }).catch(() => {});
    else if (s.action === "idle") {
      const ok = await deps.idle(userId, s.goal).catch(() => false);
      await deps.log({ userId, decision: "goal.idle", outcome: ok ? "act" : "skip", action: ok ? "stale" : "not_changed", reason: s.why, proposal }).catch(() => {});
    } else if (s.action === "due") {
      await deps.log({ userId, decision: "goal.recheck_due", outcome: /^held|already waiting/.test(s.why) ? "skip" : "act", action: /left to the text/.test(s.why) ? "left_to_text" : "ask_in_reply", reason: s.why, proposal }).catch(() => {});
    } else if (s.action === "text") {
      const queued = await deps.queueText(userId, s, s.signalAt ?? r?.lastSignalAt ?? new Date()).catch(() => false);
      await deps.log({ userId, decision: "goal.recheck_due", outcome: queued ? "act" : "skip", action: queued ? "text_queued" : "text_not_queued", reason: s.why, proposal }).catch(() => {});
    }
  }
}

// The goal sweep's pass for one member (services/goalSweep.ts runGoalSweep), before it plans: rows for goals on file, their signals
// read, every decision applied. goals: their goals on file in their own words (goalSweep.ts goalSweepGoals).
export async function runGoalRecheck(userId: string, goals: string[], now = new Date(), deps: RecheckDeps = realRecheckDeps): Promise<RecheckStep[]> {
  const onFile = new Map(goals.map((g) => g.trim()).filter(Boolean).map((g) => [goalHash(g), g]));
  if (!onFile.size) return [];
  const stored = await deps.rows(userId);
  const have = new Set(stored.map((r) => r.goalHash));
  // A goal on file with no row gets one now, active, its clock starting today (the deploy backfill does the same for existing rows).
  for (const [h, g] of onFile) if (!have.has(h)) await deps.ensure(userId, g);
  const fresh = [...onFile.keys()].every((h) => have.has(h)) ? stored : await deps.rows(userId);
  const texts = await deps.texts(userId, RECHECK_LOOKBACK_DAYS).catch(() => null);
  // Their texts couldn't be read through the fence: nothing is decided on a partial picture.
  if (!texts) return [];
  const [plans, reactions, lastAskAt] = await Promise.all([deps.plans(userId).catch(() => []), deps.reactions(userId, RECHECK_LOOKBACK_DAYS).catch(() => []), deps.lastAsk(userId).catch(() => new Date())]);
  const searched = new Set(plans.filter((p) => p.latest && p.edges.length).map((p) => p.goalHash));
  const rows = fresh.filter((r) => onFile.has(r.goalHash)).map((r) => toRecheckRow(r, searched, now));
  const signals = [
    ...textSignals(texts, rows),
    ...reactions.flatMap((x) => { const h = findGoalOf(x.askText, plans); return h ? [{ goalHash: h, at: x.at, kind: "reaction" as const }] : []; }),
  ];
  const lastExchangeAt = texts.reduce<Date | null>((m, t) => (!m || t.at > m ? t.at : m), null);
  const anyTextable = rows.some((r) => (r.state === "active" && !r.recheckAskedAt && r.searched && now.getTime() - r.lastSignalAt.getTime() >= (RECHECK_AFTER_DAYS + RECHECK_TEXT_AFTER_DAYS) * DAY) || isUnsure(r));
  const [held, pendingText] = anyTextable ? await Promise.all([deps.held(userId).catch(() => ["their send gates couldn't be read"]), deps.pendingText(userId).catch(() => ["unreadable"])]) : [[], []];
  const steps = recheckDecide({ rows, now, signals, lastExchangeAt, held, pendingText, lastAskAt });
  await applySteps(userId, steps, rows, deps);
  return steps;
}

// The text route (routes/sendblue.ts), as their text arrives: it names a goal, so the goal's clock moves now, and an idle goal comes
// back. Only signals and revives here; asks and idling are the goal sweep's.
export async function noteTextSignals(userId: string, text: string, now = new Date(), deps: RecheckDeps = realRecheckDeps): Promise<void> {
  // Cheap first: a text that names none of their live or idle goals needs no fence (the fence only ever removes words).
  const live = (await deps.rows(userId)).filter((r) => r.state === "active" || isRecheckIdle(r));
  if (!live.some((r) => mentionsGoal(text, r.goal))) return;
  const F = await import("./sourceFence.js");
  const fence = await F.memberFence(userId);
  if (fence.failed) return;
  const lines = F.fenceTheirTexts(fence, [{ at: now, text }]);
  if (!lines.length) return;
  const goals = await goalsOnFile(userId);
  const rows = live.filter((r) => goals.has(r.goalHash)).map((r) => toRecheckRow(r, new Set(), now));
  const signals = textSignals(lines, rows);
  if (!signals.length) return;
  const steps = recheckDecide({ rows, now, signals, lastExchangeAt: now, held: [], pendingText: [] });
  await applySteps(userId, steps, rows, deps, new Set<RecheckAction>(["signal", "revive"]));
}

// A goal action (markGoal on that goal, pickGoalItems on a goal it names) is a signal, and answers a recheck.
export async function noteGoalAction(userId: string, goals: string[]): Promise<void> {
  const hashes = [...new Set(goals.map((g) => goalHash(g)))];
  if (hashes.length) await pool.query(`UPDATE goal_states SET last_signal_at = NOW(), recheck_asked_at = NULL, hints = CASE WHEN state = 'active' THEN 0 ELSE hints END, reason = CASE WHEN reason LIKE '${UNSURE_PREFIX}%' THEN '' ELSE reason END WHERE user_id = $1 AND goal_hash = ANY($2::text[])`, [userId, hashes]);
}
// The goals on file a piece of their goal work names (pickGoalItems: the handed-over goal's title and their words).
export async function noteGoalActionText(userId: string, text: string): Promise<void> {
  const goals = await goalsOnFile(userId);
  const named = [...goals.values()].filter((g) => mentionsGoal(text, g));
  if (named.length) await noteGoalAction(userId, named);
}

// The reply's recheck (services/turnContext.ts): goals whose recheck is due, to raise once ("ask"), and ones already asked, so the
// reply can read their answer ("asked"). This message counts as a signal (a goal they just named is never asked about), and the
// exchange is now, so nothing here is a text. Fails closed: no fence, no recheck.
// One "ask" at most, and none once RECHECK_REPLY_HINTS replies carried it without raising it (the text takes it from there). Only goals
// still on file: a removed or renamed goal is never handed to the reply.
export async function recheckForTurn(userId: string, message: string, fence: import("./sourceFence.js").Fence | null, now = new Date(), deps: Pick<RecheckDeps, "rows" | "reactions" | "plans"> & { onFile?: (userId: string) => Promise<Set<string>>; lastAsk?: (userId: string) => Promise<Date | null> } = realTurnDeps): Promise<GoalStateRow[]> {
  if (!fence || fence.failed) return [];
  const stored = await deps.rows(userId);
  // One read on a normal turn: only a goal quiet long enough, or one already asked, goes further.
  const near = stored.filter((r) => r.state === "active" && (r.recheckAskedAt || isUnsure(r) || (r.lastSignalAt && now.getTime() - r.lastSignalAt.getTime() >= RECHECK_AFTER_DAYS * DAY)));
  if (!near.length) return [];
  const F = await import("./sourceFence.js");
  // A last-ask read that fails holds the ask (now): never a second question on a guess.
  const [plans, reactions, onFile, lastAskAt] = await Promise.all([
    deps.plans(userId).catch(() => []),
    deps.reactions(userId, RECHECK_LOOKBACK_DAYS).catch(() => []),
    deps.onFile ? deps.onFile(userId).catch(() => null) : Promise.resolve(null),
    deps.lastAsk ? deps.lastAsk(userId).catch(() => now) : Promise.resolve(null),
  ]);
  const searched = new Set(plans.filter((p) => p.latest && p.edges.length).map((p) => p.goalHash));
  // On file when the profile reads; if it can't, the latest plan (made from what was on file) stands in.
  const live = onFile ?? searched;
  const rows = near.filter((r) => live.has(r.goalHash)).map((r) => toRecheckRow(r, searched, now));
  if (!rows.length) return [];
  const signals = [
    ...textSignals(F.fenceTheirTexts(fence, [{ at: now, text: message }]), rows),
    ...reactions.flatMap((x) => { const h = findGoalOf(x.askText, plans); return h ? [{ goalHash: h, at: x.at, kind: "reaction" as const }] : []; }),
  ];
  const steps = recheckDecide({ rows, now, signals, lastExchangeAt: now, held: [], pendingText: [], lastAskAt });
  const byHash = new Map(stored.map((r) => [r.goalHash, r]));
  const ask = steps.filter((s) => s.action === "due" && (byHash.get(s.goalHash)!.hints ?? 0) < RECHECK_REPLY_HINTS).slice(0, 1);
  const asked = steps.filter((s) => s.action === "asked");
  return [...ask.map((s) => ({ ...byHash.get(s.goalHash)!, recheck: "ask" as const })), ...asked.map((s) => ({ ...byHash.get(s.goalHash)!, recheck: "asked" as const }))];
}

// Asked means sent: the recheck went out in a text that asked it (a reply, or the goal_recheck text). Once per quiet stretch.
// signalBefore: asked only if nothing moved the goal's clock since then (the turn's start): a goal they named or acted on this turn
// was answered, not asked. A goal_nudge or goal_checkin that went out about it is the same question (one covers both).
export async function markRecheckAsked(userId: string, hash: string, goal: string, via: "reply" | "text" | "goal_nudge" | "goal_checkin", o: { signalBefore?: Date | null } = {}): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE goal_states SET recheck_asked_at = NOW(), reason = CASE WHEN reason LIKE '${UNSURE_PREFIX}%' THEN '' ELSE reason END WHERE user_id = $1 AND goal_hash = $2 AND state = 'active' AND recheck_asked_at IS NULL AND ($3::timestamptz IS NULL OR last_signal_at <= $3::timestamptz)`,
    [userId, hash, o.signalBefore ?? null],
  );
  if (rowCount) await realRecheckDeps.log({ userId, decision: "goal.recheck_asked", outcome: "act", action: via, proposal: { goal: goal.slice(0, 200), goalHash: hash } }).catch(() => {});
  return !!rowCount;
}

// Pure: whether the goal_recheck text may still go at draft time: active, not asked, still on file, nothing on the goal since it was
// queued, and no text from them since it was queued (an exchange means the reply raises it, not a text). latestText: their latest
// fenced text to Co, "unreadable" when the fence failed (held: nothing goes on a guess).
export function recheckTextCheck(r: GoalStateRow | null, o: { onFile: boolean; queuedAt: Date | null; queuedSignalAt: Date | null; latestText: Date | null | "unreadable" }): { ok: true; goal: string } | { ok: false; why: string } {
  if (!r || !o.onFile) return { ok: false, why: "the goal isn't on file any more" };
  if (r.state !== "active") return { ok: false, why: `the goal is ${r.state} now` };
  if (r.recheckAskedAt) return { ok: false, why: "already asked" };
  if (o.queuedSignalAt && r.lastSignalAt && r.lastSignalAt.getTime() > o.queuedSignalAt.getTime() + 1000) return { ok: false, why: "they've said something about it since" };
  if (o.latestText === "unreadable") return { ok: false, why: "their texts couldn't be read through the fence" };
  if (o.latestText && o.queuedAt && o.latestText.getTime() > o.queuedAt.getTime()) return { ok: false, why: "they've texted since it was queued; the reply raises it" };
  return { ok: true, goal: r.goal };
}

// The goal_recheck text, at draft time (harness/proactiveRegistry.ts goal_recheck).
export async function recheckTextStillDue(userId: string, hash: string, payload: { queuedAt?: string | null; lastSignalAt?: string | null }): Promise<{ ok: true; goal: string } | { ok: false; why: string }> {
  const { rows } = await pool.query(`SELECT * FROM goal_states WHERE user_id = $1 AND goal_hash = $2`, [userId, hash]);
  const queuedAt = payload.queuedAt ? new Date(payload.queuedAt) : null;
  const F = await import("./sourceFence.js");
  const fence = await F.memberFence(userId);
  const minutes = queuedAt ? Math.max(1, Math.ceil((Date.now() - queuedAt.getTime()) / 60_000)) : 0;
  const latestText = fence.failed ? ("unreadable" as const) : minutes ? (await F.readTheirTexts(fence, minutes, 1)).map((t) => t.at).pop() ?? null : null;
  return recheckTextCheck(rows[0] ? fromStateRow(rows[0]) : null, { onFile: (await goalsOnFile(userId)).has(hash), queuedAt, queuedSignalAt: payload.lastSignalAt ? new Date(payload.lastSignalAt) : null, latestText });
}

async function goalsOnFile(userId: string): Promise<Map<string, string>> {
  const { goalTexts } = await import("./goalJourney.js");
  const { rows } = await pool.query(`SELECT goals, intent FROM co_profiles WHERE user_id = $1`, [userId]);
  return new Map(goalTexts(rows[0]?.intent, rows[0]?.goals).map((g) => [goalHash(g), g]));
}

// A goal_nudge or goal_checkin went out about a goal: it is the recheck's question too, but only when the judge reads it as asking
// whether they still want it (after the send; never a gate on it).
export async function noteRecheckSent(userId: string, hash: string, goal: string, sent: string, via: "goal_nudge" | "goal_checkin", judge: RecheckJudge = haikuRecheckJudge): Promise<boolean> {
  const j = await judgeRecheckAsked(goal, sent, judge);
  return j.asked ? markRecheckAsked(userId, hash, goal, via) : false;
}

// A reply carried the recheck and didn't ask it: one more hint used.
export async function noteRecheckHint(userId: string, hash: string): Promise<void> {
  await pool.query(`UPDATE goal_states SET hints = hints + 1 WHERE user_id = $1 AND goal_hash = $2 AND state = 'active' AND recheck_asked_at IS NULL`, [userId, hash]);
}

// ---------- real deps

export const realRecheckDeps: RecheckDeps = {
  rows: async (userId) => (await pool.query(`SELECT * FROM goal_states WHERE user_id = $1`, [userId])).rows.map(fromStateRow),
  ensure: async (userId, goal) => {
    await pool.query(
      `INSERT INTO goal_states (user_id, goal_hash, goal_text, state, reason, source, changed_at, told_at, hints, last_signal_at)
       VALUES ($1, $2, $3, 'active', '', 'context', NOW(), NOW(), 0, NOW() + ($4 || ' days')::interval) ON CONFLICT (user_id, goal_hash) DO NOTHING`,
      [userId, goalHash(goal), goal.slice(0, 500), String(backfillOffsetDays(goalHash(goal)))],
    );
  },
  texts: async (userId, days) => {
    const F = await import("./sourceFence.js");
    const fence = await F.memberFence(userId);
    if (fence.failed) return null;
    return F.readTheirTexts(fence, days * 24 * 60, 400);
  },
  reactions: async (userId, days) => {
    const { rows } = await pool.query(
      `SELECT r.reacted_at, pc.payload->>'askText' AS ask_text
         FROM revealed_offers r
         JOIN proactive_candidates pc ON pc.user_id = r.user_id AND pc.type = 'event_offer' AND pc.status = 'sent'
          AND pc.payload->>'askId' = 'profile' AND lower(pc.payload->'match'->>'name') = lower(r.item_name)
        WHERE r.user_id = $1 AND r.reacted_at IS NOT NULL AND r.reacted_at > NOW() - ($2 || ' days')::interval`,
      [userId, String(days)],
    );
    return rows.map((x: any) => ({ askText: String(x.ask_text ?? ""), at: new Date(x.reacted_at) }));
  },
  plans: async (userId) => {
    const { rows } = await pool.query(
      `SELECT proposal, action FROM harness_decisions WHERE decision = 'goal_sweep.plan' AND user_id = $1 AND created_at > NOW() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 40`,
      [userId, String(RECHECK_LOOKBACK_DAYS + RECHECK_AFTER_DAYS)],
    );
    // The newest plan that read their goals whole decides what is searched now; every plan's edges attribute finds.
    const latestIdx = rows.findIndex((r: any) => !["read_failed", "read_cut_off"].includes(String(r.action ?? "")));
    return rows.flatMap((r: any, i: number) => (Array.isArray(r.proposal?.edges) ? r.proposal.edges : []).map((e: any) => ({ goalHash: goalHash(String(e.goal ?? "")), edges: (Array.isArray(e.edges) ? e.edges : []).map(String), latest: i === latestIdx })));
  },
  held: async (userId) => (await import("../harness/proactive.js")).sweepHold(userId, "goal"),
  lastAsk: async (userId) => {
    const { rows } = await pool.query(`SELECT max(created_at) AS at FROM harness_decisions WHERE user_id = $1 AND decision IN ('goal.recheck_asked', 'ask.retire_asked') AND action <> 'answered' AND created_at > NOW() - INTERVAL '3 days'`, [userId]);
    return rows[0]?.at ? new Date(rows[0].at) : null;
  },
  pendingText: async (userId) => (await pool.query(`SELECT payload->>'goalHash' AS h FROM proactive_candidates WHERE user_id = $1 AND type = 'goal_recheck' AND status = 'pending'`, [userId])).rows.map((r: any) => String(r.h)),
  signal: async (userId, hash, at, clearAsk) => {
    await pool.query(
      `UPDATE goal_states SET hints = CASE WHEN $3 > last_signal_at THEN 0 ELSE hints END, last_signal_at = GREATEST(last_signal_at, $3), recheck_asked_at = CASE WHEN $4::boolean THEN NULL ELSE recheck_asked_at END,
         reason = CASE WHEN reason LIKE '${UNSURE_PREFIX}%' AND $3 > changed_at THEN '' ELSE reason END WHERE user_id = $1 AND goal_hash = $2 AND state = 'active'`,
      [userId, hash, at, clearAsk],
    );
  },
  // Only an idle goal, in one conditional write: a goal markGoal closed or set aside meanwhile is never flipped back by a word match.
  revive: async (userId, goal, at) => {
    const { rowCount } = await pool.query(
      `UPDATE goal_states SET state = 'active', reason = 'they brought it up again', source = 'context', changed_at = NOW(), told_at = NOW(), hints = 0,
         last_signal_at = GREATEST(last_signal_at, $3), recheck_asked_at = NULL
       WHERE user_id = $1 AND goal_hash = $2 AND state = 'stale' AND source = 'context' AND reason = $4`,
      [userId, goalHash(goal), at, RECHECK_IDLE_REASON],
    );
    // The asks that idled with it come back with it (askRetire.ts).
    if (rowCount) await import("./askRetire.js").then((A) => A.reviveAsksWithGoal(userId, goalHash(goal))).catch(() => 0);
    return !!rowCount;
  },
  // Already asked, so told: an idle goal is never raised again as a set-aside.
  // Not silent (Royce, 2026-10-13: "no silent expiries"): told_at stays NULL until the one stopped-looking note goes out with a reply
  // or a paced text (services/askRetire.ts stopNotes); untoldSetAsides leaves it out, so it is never asked about as a set-aside.
  // Its one line is written now, in Co's voice, and stored for the reply or the paced text that carries it (askRetire.ts).
  idle: async (userId, goal) => {
    const ok = await setGoalState(userId, goal, "stale", RECHECK_IDLE_REASON, "context", { told: false });
    if (ok) await import("./askRetire.js").then((A) => A.storeGoalNote(userId, goal)).catch((err: any) => console.error("goal recheck: writing the stopped-looking line failed (the fallback is used):", err?.message ?? err));
    return ok;
  },
  queueText: async (userId, step, lastSignalAt) => {
    const { enqueueCandidate } = await import("../harness/proactive.js");
    const { localDay, memberZone } = await import("./memberTime.js");
    const zone = await memberZone(userId).catch(() => null);
    const r = await enqueueCandidate({
      userId,
      type: "goal_recheck",
      // One a day at most per goal; an unsent one expires and a later run queues it again.
      targetKey: `goal_recheck:${step.goalHash}:${localDay(new Date(), zone)}`,
      topicKey: `goal:${step.goalHash}`,
      summary: `Ask once whether "${step.goal.slice(0, 60)}" is still something to look for`,
      payload: { goalHash: step.goalHash, goal: step.goal.slice(0, 300), lastSignalAt: lastSignalAt.toISOString(), queuedAt: new Date().toISOString() },
      dueAt: new Date(),
      expiresAt: new Date(Date.now() + RECHECK_TEXT_AFTER_DAYS * DAY),
    });
    return !!r.queued;
  },
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 7, decision: d.decision, userId: d.userId, outcome: d.outcome, action: d.action, reason: d.reason ?? null, proposal: d.proposal });
  },
};

// The reply's reads (recheckForTurn): the run's, plus what's on file.
export const realTurnDeps: Pick<RecheckDeps, "rows" | "reactions" | "plans" | "lastAsk"> & { onFile: (userId: string) => Promise<Set<string>> } = {
  rows: realRecheckDeps.rows,
  lastAsk: realRecheckDeps.lastAsk,
  reactions: realRecheckDeps.reactions,
  plans: realRecheckDeps.plans,
  onFile: async (userId) => new Set((await goalsOnFile(userId)).keys()),
};
