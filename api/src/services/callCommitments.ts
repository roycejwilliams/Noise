// What Co says it will do after a call, made real (Royce, 2026-10-06: Co told him "I'll text you the links right after we hang up"
// and nothing tracked it; the after-call audit only ever searched for things). Same machinery as promise tracking (#67,
// services/promises.ts): a concrete first-person commitment to send something becomes a task Co owns (co_tasks.source = 'promise'),
// opened the moment it is said, with a due time shortly after the call. A later check verifies a text actually went out.
//
// What counts: "I'll text you those links", "I'll send you the PDF after we hang up", "I'll put together a summary tonight".
// What does not: questions and offers ("want me to text you?", "I can send"), what Co can't do (calling or emailing someone),
// and "I'll set that up and text you what I find": that is multi-day work the call-task read opens (services/callTasks.ts).
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { OFFERS_WHAT_CO_CANT } from "./taskWeb.js";
import { MAX_OPEN_PROMISES, promiseGoal, theirWordsFor } from "./promises.js";
import { noteOnTask, openTasks, startTask, type CoTask } from "./coTasks.js";

const VERB = String.raw`(?:text|send|put together|pull together|write up|draft|share|drop|shoot|forward)`;
export const COMMIT_RE = new RegExp(String.raw`\b(?:i'?ll|i will|i'?m going to|i'?m gonna)\s+(?:\w+\s+){0,2}?${VERB}\b`, "i");
// Covered elsewhere or not Co's to keep.
const MULTI_DAY = /\b(?:set (?:that|it|this) up|what i (?:find|turn up|come up with)|over the (?:next|coming) (?:few )?days|through the week)\b/i;
const CANT = /\b(?:sponsors?|investors?|funders?|funding|grants?|donors?)\b/i;
export const COMMIT_PREFIX = "Keep your word from the call: ";
// A call is still going when this is said: the task falls due this long after, so it is never due before they hang up.
export const DUE_AFTER_MINUTES = 25;
// How long after it fell due the check waits before it counts a commitment as unkept (the task wakes every 15 minutes).
const GRACE_MINUTES = 20;

const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: why a sentence is not a commitment a task can keep, or null when it is one.
export function commitmentProblem(s: string): string | null {
  if (!COMMIT_RE.test(s)) return "not a commitment to send something";
  if (/\?\s*$/.test(s)) return "a question";
  if (/^\s*(?:want me to|should i|would you like me to|do you want me to)\b/i.test(s)) return "an offer";
  if (MULTI_DAY.test(s)) return "multi-day work, opened from their own words";
  if (CANT.test(s) || OFFERS_WHAT_CO_CANT.test(s)) return "something Co can't do";
  return null;
}

// Pure: the commitments in some of Co's lines, each once.
export function commitmentsIn(coLines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of coLines) for (const s of sentencesOf(line)) {
    if (commitmentProblem(s) !== null) continue;
    const k = s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
    if (!seen.has(k)) { seen.add(k); out.push(s.slice(0, 220)); }
  }
  return out;
}

export const commitmentGoal = (sentence: string) => COMMIT_PREFIX + promiseGoal(sentence).replace(/^Keep your promise: /, "");

export type CommitDeps = {
  open: (userId: string) => Promise<{ source?: string }[]>;
  start: typeof startTask;
  setDue: (userId: string, taskId: number, due: Date) => Promise<void>;
  note: (userId: string, taskId: number, text: string) => Promise<unknown>;
};
const realCommitDeps: CommitDeps = {
  open: openTasks,
  start: startTask,
  setDue: async (userId, id, due) => { await pool.query(`UPDATE co_tasks SET next_check_at = $3 WHERE user_id = $1 AND id = $2`, [userId, id, due]); },
  note: noteOnTask,
};

// Opens the task for one spoken commitment. Never throws (a call must not suffer for it). Capped like any promise.
export async function trackCallCommitment(o: { userId: string; sentence: string; theirLine?: string; now?: Date }, deps: CommitDeps = realCommitDeps): Promise<{ ok: true; task: CoTask } | { ok: false; why: string }> {
  try {
    const why = commitmentProblem(o.sentence);
    if (why) return { ok: false, why };
    const open = await deps.open(o.userId);
    if (open.filter((t) => t.source === "promise").length >= MAX_OPEN_PROMISES + 2) return { ok: false, why: "already keeping several promises" };
    const r = await deps.start({
      userId: o.userId,
      goal: commitmentGoal(o.sentence),
      theirWords: theirWordsFor(o.theirLine ?? "(said on a call)"),
      steps: [{ text: "Send what you said you would, in a text, with the links or the document itself" }],
      firstPlan: "You told them this on a call: send it now by text, with what they were looking at (the links, the summary). If you can't, tell them plainly where it stands.",
      inHours: 1,
      source: "promise",
    });
    if (!r.ok) return r;
    // Due shortly after the call, not an hour or more later: set directly (startTask's own floor is an hour).
    const due = new Date((o.now ?? new Date()).getTime() + DUE_AFTER_MINUTES * 60_000);
    await deps.setDue(o.userId, r.task.id, due);
    await deps.note(o.userId, r.task.id, `Said on a call; due ${due.toISOString().slice(11, 16)} UTC, shortly after they hang up.`).catch(() => null);
    return { ok: true, task: { ...r.task, nextCheckAt: due.toISOString() } };
  } catch (err: any) {
    console.error("callCommitments: tracking failed (non-fatal):", err?.message ?? err);
    return { ok: false, why: "failed" };
  }
}

// The post-call fallback (the direct-Haiku path says these with nothing watching): the same, from the transcript, once each.
export async function trackCommitmentsFromTranscript(userId: string, transcript: string): Promise<number> {
  const co = transcript.split("\n").filter((l) => /^assistant:/i.test(l.trim())).map((l) => l.replace(/^assistant:\s*/i, ""));
  const theirs = transcript.split("\n").filter((l) => /^user:/i.test(l.trim())).map((l) => l.replace(/^user:\s*/i, ""));
  let n = 0;
  for (const s of commitmentsIn(co)) if ((await trackCallCommitment({ userId, sentence: s, theirLine: theirs[theirs.length - 1] })).ok) n++;
  return n;
}

export type CheckDeps = {
  due: (olderThan: Date, newerThan: Date) => Promise<{ id: string; user_id: string; goal: string; created_at: Date }[]>;
  sentSince: (userId: string, since: Date) => Promise<Date | null>;
  note: (userId: string, taskId: number, text: string) => Promise<unknown>;
  record: typeof recordDecision;
};
const realCheckDeps: CheckDeps = {
  due: async (olderThan, newerThan) =>
    (await pool.query(
      `SELECT id, user_id, goal, created_at FROM co_tasks
       WHERE source = 'promise' AND status = 'open' AND goal LIKE $1 AND notes::text NOT LIKE '%Checked:%' AND created_at <= $2 AND created_at > $3
       ORDER BY id LIMIT 40`,
      [`${COMMIT_PREFIX}%`, olderThan, newerThan],
    )).rows,
  sentSince: async (userId, since) => {
    const r = await pool.query(`SELECT sent_at FROM outbound_messages WHERE user_id = $1 AND sender = 'co' AND sent_at > $2 ORDER BY sent_at LIMIT 1`, [userId, since]);
    return r.rows[0] ? new Date(r.rows[0].sent_at) : null;
  },
  note: noteOnTask,
  record: recordDecision,
};

// The check: commitments that fell due, was a text actually sent? Marked once (the note); a miss goes to the morning review,
// and the task is still open, so Co does what it said when it wakes.
export async function checkCallCommitments(now: Date = new Date(), deps: CheckDeps = realCheckDeps): Promise<{ kept: number; unkept: number }> {
  let kept = 0, unkept = 0;
  const rows = await deps.due(new Date(now.getTime() - (DUE_AFTER_MINUTES + GRACE_MINUTES) * 60_000), new Date(now.getTime() - 24 * 3_600_000));
  for (const t of rows) {
    const sentAt = await deps.sentSince(t.user_id, new Date(t.created_at));
    const ok = !!sentAt;
    ok ? kept++ : unkept++;
    await deps.note(t.user_id, Number(t.id), ok ? `Checked: a text went out at ${sentAt!.toISOString().slice(0, 16)} UTC.` : "Checked: nothing has been sent since they said it. Send it now.").catch(() => null);
    await deps.record({
      layer: 8,
      decision: "call.commitment",
      userId: t.user_id,
      outcome: ok ? "act" : "skip",
      action: ok ? "kept" : "unkept",
      proposal: { taskId: String(t.id), goal: String(t.goal).slice(0, 200) },
      reason: ok ? null : "Co said on a call it would send something; nothing went out by the time it fell due",
    }).catch(() => {});
  }
  return { kept, unkept };
}
