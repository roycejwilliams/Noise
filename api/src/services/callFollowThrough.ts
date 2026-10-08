// Following through the moment a call ends (Royce, 2026-10-08). On a call Co promised a planning doc ("text you what I put
// together"); after he hung up nothing came: the promise task was due 25 minutes out and woke on the 15-minute task cron, the
// after-call text went into the dispatch queue (every 30 minutes, 20 minutes after the call at the earliest) and landed 75 minutes
// later saying "Starting the post-event branding plan ... once it's worth sending".
//
// Now the call ending is the trigger, not a poll:
//   - post-call processing (routes/co.ts processEndedCall) calls followThroughOnCallEnd as soon as it knows a person talked
//   - each "I'll text you X" from the call (an open promise task, services/callCommitments.ts) gets one short confirmation text,
//     in the shape: what Co understood, what they get, when. Exempt from the usual spacing (they just hung up), inside their hours.
//   - then the work itself runs right away (services/taskTurn.ts, the task's own turn), and the deliverable is sent when that turn
//     finishes: its own completion event, never a scheduled sweep
//   - at night for them, both wait for their morning (9am their time): an in-process timer, with the task's own next check set just
//     after it as the backstop if the process restarts
// Co drafts the confirmation; code checks its voice (services/speakable.ts narratesInternalState, harness/proactive.ts checkDraft)
// and its shape, redrafts once, and falls back to Co's own words from the call rather than send nothing.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { COMMIT_PREFIX, trackCommitmentsFromTranscript } from "./callCommitments.js";
import { narratesInternalState } from "./speakable.js";
import { cleanCoMessage } from "./sendblue.js";
import { checkDraft, draftAgain, draftProactive, localHourOk, nextLocalHour, RULES, sendExempt } from "../harness/proactive.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { callKey } from "./callKey.js";
import { deliveryWords, wordsZone } from "./memberTime.js";

export const CONFIRM_TYPE = "call_confirm" as const;
export const confirmKey = (key: string) => `call_confirm:${key}`;
// The held morning send goes first; the task's own check is set this long after it, as the backstop.
const BACKSTOP_AFTER_MS = 10 * 60_000;

export type Commitment = { taskId: number; sentence: string; wakes: number };

// The sentence Co said, back out of a commitment task's goal (callCommitments.ts commitmentGoal).
export function sentenceOfGoal(goal: string): string {
  const rest = goal.startsWith(COMMIT_PREFIX) ? goal.slice(COMMIT_PREFIX.length) : goal;
  return rest.replace(/^"|"$/g, "").trim();
}

// Pure: when they'll have it, in their day. The work starts now, so this under-promises: a draft that lands in minutes is early.
// The same words the commitment's own window was set from (services/memberTime.ts deliveryWords), so what Co confirms is what it holds
// itself to.
export function deliveryWindow(now: Date, zone: string | null): string {
  return deliveryWords(now, zone);
}

const STOP = new Set(["text", "send", "sent", "share", "draft", "together", "what", "after", "call", "hang", "with", "your", "that", "this", "them", "they", "then", "will", "i'll", "you'll", "just", "over", "some", "tonight", "today", "tomorrow", "right", "later", "morning", "afternoon", "evening", "minutes", "put", "pull", "write", "into", "from", "about", "have", "make", "sure", "got"]);
const words = (s: string) => (s.toLowerCase().replace(/[’']/g, "'").match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const WHEN = /\b(?:tonight|today|tomorrow|this (?:morning|afternoon|evening)|later (?:today|tonight|this \w+)|in (?:a|an|a few|a couple of|\d+) (?:minutes?|hours?)|shortly|right after|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|end of (?:the )?day|\d))\b/i;
const GETS = /\b(?:i'?ll|i will|you'?ll (?:have|get))\b/i;

// Pure: what the confirmation is missing from its shape (what Co understood, what they get, when).
// "Understood" is the thing named from the call: a word from what Co said it would send, or from what they said.
export function confirmationShape(text: string, commitments: { sentence: string }[], theirLines = ""): string[] {
  const missing: string[] = [];
  const said = new Set([...commitments.flatMap((c) => words(c.sentence)), ...words(theirLines)].map((w) => w.slice(0, 4)));
  if (!words(text).some((w) => said.has(w.slice(0, 4)))) missing.push("what Co understood (name the actual thing from the call)");
  if (!GETS.test(text.replace(/[’]/g, "'"))) missing.push("what they get (\"I'll send you…\")");
  if (!WHEN.test(text)) missing.push("when they'll have it");
  return missing;
}

// Pure: every check the confirmation must pass. The usual "no promise of a later action" rule is the one exception: this text IS
// the promise, made real by the work that starts right after it.
export function confirmationChecks(text: string, commitments: { sentence: string }[], theirLines = ""): GateCheck[] {
  const base = checkDraft(text, { maxSentences: 2, maxChars: 320 }).filter((c) => !(c.name === "draft_forbidden" && /promise of a later action/.test(c.reason ?? "")));
  const missing = confirmationShape(text, commitments, theirLines);
  return [...base, { name: "confirm_shape", pass: !missing.length, reason: missing.length ? `missing ${missing.join("; ")}` : undefined }];
}

// Pure: Co's own words from the call, as the text when two drafts both break the rules. Better than nothing landing at all.
export function fallbackConfirmation(commitments: { sentence: string }[], window: string): string | null {
  const s = commitments.map((c) => c.sentence).find((x) => !narratesInternalState(x));
  if (!s) return null;
  let body = s.replace(/\s+/g, " ").trim().replace(/[\s,;:]+$/, "");
  body = body.replace(/\s*,?\s*(?:right )?after (?:we hang up|this call|the call)\b/i, "");
  if (!WHEN.test(body)) body = `${body.replace(/[.!]+$/, "")} ${window}`;
  if (!/[.!?]$/.test(body)) body += ".";
  return cleanCoMessage(`Got it, ${body[0].toLowerCase()}${body.slice(1)}`.replace(/^Got it, i'll/, "Got it, I'll").replace(/^Got it, i /, "Got it, I "));
}

export function confirmationTask(): string {
  return `They just hung up a call with you. On it you told them you'd send them something (co_commitment_on_call). Text them one short confirmation, in this shape: what you understood they want (name the actual thing, specifically, in their terms), what they'll get from you, and when (delivery_window, or the time you named on the call if you named one). The shape, not the words: "Got it, I'll put together the plan for keeping the brand visible after the launch and text you the draft tonight." One or two sentences. No question, no sign-off, no recap of the call. Never narrate your own state or process ("starting", "working on", "on it", "looking into", "in progress"), and never make sending it depend on your judgment ("once it's worth sending", "if it's good enough"): you send it when it's done, or say plainly what's still missing. If you told them two things, confirm both in the same text.`;
}

export type FollowThroughDeps = {
  now: () => Date;
  track: (userId: string, transcript: string) => Promise<unknown>;
  commitments: (userId: string, since: Date) => Promise<Commitment[]>;
  person: (userId: string) => Promise<{ firstName: string; phone: string; zone: string | null; reachable: boolean } | null>;
  draft: (o: { firstName: string; facts: Record<string, string>; redo?: { draft: string; failed: string } }) => Promise<string | null>;
  send: (o: { userId: string; phone: string; key: string; text: string; zone: string | null }) => Promise<{ sent: boolean; reason?: string }>;
  // The task's own turn, now: claimed first so the cron can't run it at the same time. Resolves when the turn is done.
  runTask: (userId: string, c: Commitment) => Promise<{ ran: boolean; action?: string }>;
  hold: (userId: string, taskIds: number[], until: Date) => Promise<void>;
  later: (at: Date, fn: () => Promise<unknown>) => void;
  record: typeof recordDecision;
};

export type FollowThroughResult = {
  action: "none" | "unreachable" | "sent" | "held" | "send_failed" | "no_text";
  text?: string;
  fallback?: boolean;
  heldUntil?: string;
  confirmMs?: number;
  // Resolves when every deliverable turn has finished (tests and the live check wait on it; the call path never does).
  work?: Promise<{ taskId: number; ran: boolean; action?: string }[]>;
};

// Drafts, checks, redrafts once, falls back. Returns the text and whether it was the fallback.
export async function writeConfirmation(o: { firstName: string; commitments: Commitment[]; theirLines: string; now: Date; zone: string | null }, draft: FollowThroughDeps["draft"]): Promise<{ text: string; fallback: boolean } | null> {
  const window = deliveryWindow(o.now, o.zone);
  const local = DateTime.fromJSDate(o.now).setZone(wordsZone(o.zone));
  const facts: Record<string, string> = {
    co_commitment_on_call: o.commitments.map((c) => c.sentence).join(" | "),
    their_words_on_the_call: o.theirLines.slice(-1500),
    delivery_window: window,
    their_local_time: local.isValid ? local.toFormat("h:mma cccc").toLowerCase() : "",
  };
  const bad = (t: string) => confirmationChecks(t, o.commitments, o.theirLines).filter((c) => !c.pass);
  const first = await draft({ firstName: o.firstName, facts }).catch(() => null);
  if (first && !bad(first).length) return { text: first, fallback: false };
  if (first) {
    const failed = bad(first).map((c) => c.reason ?? c.name).join("; ");
    const second = await draft({ firstName: o.firstName, facts, redo: { draft: first, failed } }).catch(() => null);
    if (second && !bad(second).length) return { text: second, fallback: false };
  }
  const fb = fallbackConfirmation(o.commitments, window);
  return fb ? { text: fb, fallback: true } : null;
}

// The call ended: confirm what Co said it would send, then do it. Never throws; the call's own processing never waits on it.
export async function followThroughOnCallEnd(o: { userId: string; transcript: string; startedAt?: Date | null; endedAt?: Date | null }, deps: FollowThroughDeps = realDeps): Promise<FollowThroughResult> {
  const t0 = deps.now();
  try {
    // A commitment said on the direct path has no task yet: open it (the same words never open twice).
    await deps.track(o.userId, o.transcript).catch(() => null);
    const since = new Date((o.startedAt ?? new Date(t0.getTime() - 2 * 3_600_000)).getTime() - 60_000);
    const commitments = await deps.commitments(o.userId, since);
    if (!commitments.length) return { action: "none" };
    const person = await deps.person(o.userId);
    if (!person || !person.reachable) return { action: "unreachable" };
    const theirLines = o.transcript.split("\n").filter((l) => /^\s*user\s*:/i.test(l)).map((l) => l.replace(/^\s*user\s*:\s*/i, "")).join("\n");
    const key = confirmKey(callKey(o.transcript));

    const deliver = async (): Promise<FollowThroughResult> => {
      const now = deps.now();
      const w = await writeConfirmation({ firstName: person.firstName, commitments, theirLines, now, zone: person.zone }, deps.draft);
      let action: FollowThroughResult["action"] = "no_text";
      let reason: string | undefined;
      if (w) {
        const r = await deps.send({ userId: o.userId, phone: person.phone, key, text: w.text, zone: person.zone }).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }));
        action = r.sent || r.reason === "already sent" ? "sent" : "send_failed";
        reason = r.reason;
      }
      const confirmMs = deps.now().getTime() - (o.endedAt ?? t0).getTime();
      await deps.record({ layer: 8, decision: "call.followthrough", userId: o.userId, outcome: action === "sent" ? "act" : "skip", action: `confirm_${action}`, proposal: { text: w?.text ?? null, fallback: w?.fallback ?? false, tasks: commitments.map((c) => c.taskId), confirmMs }, reason: reason ?? null }).catch(() => {});
      // The deliverable: each task's own turn, started now, sent when it finishes.
      const work = Promise.all(
        commitments.map((c) =>
          deps.runTask(o.userId, c).then((r) => ({ taskId: c.taskId, ...r })).catch((err: any) => {
            console.error("callFollowThrough: task turn failed (non-fatal):", err?.message ?? err);
            return { taskId: c.taskId, ran: false };
          }),
        ),
      );
      return { action, text: w?.text, fallback: w?.fallback, confirmMs, work };
    };

    if (!localHourOk(t0, person.zone)) {
      const at = nextLocalHour(t0, person.zone, RULES.startHour);
      await deps.hold(o.userId, commitments.map((c) => c.taskId), new Date(at.getTime() + BACKSTOP_AFTER_MS)).catch(() => {});
      deps.later(at, deliver);
      await deps.record({ layer: 8, decision: "call.followthrough", userId: o.userId, outcome: "skip", action: "confirm_held", proposal: { until: at.toISOString(), tasks: commitments.map((c) => c.taskId) }, reason: "outside their hours" }).catch(() => {});
      return { action: "held", heldUntil: at.toISOString() };
    }
    return await deliver();
  } catch (err: any) {
    console.error("callFollowThrough: failed (non-fatal):", err?.message ?? err);
    return { action: "send_failed" };
  }
}

const realDeps: FollowThroughDeps = {
  now: () => new Date(),
  track: trackCommitmentsFromTranscript,
  commitments: async (userId, since) =>
    (
      await pool.query(
        `SELECT id, goal, wakes FROM co_tasks WHERE user_id = $1 AND source = 'promise' AND status = 'open' AND goal LIKE $2 AND created_at >= $3 ORDER BY id`,
        [userId, `${COMMIT_PREFIX}%`, since],
      )
    ).rows.map((r: any) => ({ taskId: Number(r.id), sentence: sentenceOfGoal(String(r.goal)), wakes: Number(r.wakes) })),
  person: async (userId) => {
    const { rows } = await pool.query(`SELECT u.first_name, u.phone_number, u.sms_opted_out, u.archived_at, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]);
    const p = rows[0];
    if (!p) return null;
    const { getTimezoneForCity } = await import("./geocoding.js");
    const zone = p.city ? await getTimezoneForCity(p.city).catch(() => null) : null;
    return { firstName: p.first_name || "them", phone: p.phone_number, zone, reachable: !!p.phone_number && !p.sms_opted_out && !p.archived_at };
  },
  draft: ({ firstName, facts, redo }) => {
    const run = () => draftProactive({ functionId: "call.followthrough.confirm", firstName, facts, task: confirmationTask(), maxSentences: 2, freshKeys: ["their_words_on_the_call"] });
    return redo ? draftAgain(redo, run) : run();
  },
  send: ({ userId, phone, key, text, zone }) => sendExempt({ userId, phoneNumber: phone, type: CONFIRM_TYPE, targetKey: key, messages: [text], timezone: zone, respectHours: true }),
  runTask: async (userId, c) => {
    // Claimed the way the cron claims (coTasks.ts claimDueTasks), only if the cron hasn't woken it since it was read.
    const claimed = await pool.query(
      `UPDATE co_tasks SET next_check_at = NOW() + INTERVAL '45 minutes', wakes = wakes + 1, updated_at = NOW()
       WHERE user_id = $1 AND id = $2 AND status = 'open' AND wakes = $3 RETURNING id`,
      [userId, c.taskId, c.wakes],
    );
    if (!claimed.rows[0]) return { ran: false, action: "already_claimed" };
    const { getTask } = await import("./coTasks.js");
    const task = await getTask(userId, c.taskId);
    if (!task) return { ran: false };
    const { runTaskTurn } = await import("./taskTurn.js");
    const r = await runTaskTurn(task);
    return { ran: true, action: r.action };
  },
  hold: async (userId, ids, until) => {
    await pool.query(`UPDATE co_tasks SET next_check_at = $3, updated_at = NOW() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND status = 'open'`, [userId, ids, until]);
  },
  later: (at, fn) => {
    setTimeout(() => void fn().catch((err: any) => console.error("callFollowThrough: morning send failed (non-fatal):", err?.message ?? err)), Math.max(0, at.getTime() - Date.now()));
  },
  record: recordDecision,
};

// The confirmation that went out for a call, if one did: the after-call reflection text reads it so it never says the same thing twice.
export async function confirmationSentFor(userId: string, transcript: string): Promise<string | null> {
  const { rows } = await pool
    .query(`SELECT message FROM proactive_sends WHERE user_id = $1 AND target_key = $2 LIMIT 1`, [userId, confirmKey(callKey(transcript))])
    .catch(() => ({ rows: [] as any[] }));
  return rows[0]?.message ?? null;
}
