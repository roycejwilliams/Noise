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
//   - at night for them, no confirmation (2026-10-08: a "Got it" held to 9am read like Co had only just heard): the task's own
//     check is set for 8am their time, and the delivery says what they asked for and when (services/speakable.ts deliveryLine).
//     Rows held under the old flow still run their work once sent (afterConfirmSent).
// Co drafts the confirmation; code checks its voice (services/speakable.ts narratesInternalState, harness/proactive.ts checkDraft)
// and its shape, redrafts once, and falls back to Co's own words from the call rather than send nothing.
import pool from "../db/db.js";
import { COMMIT_PREFIX, trackCommitmentsFromTranscript } from "./callCommitments.js";
import { narratesInternalState } from "./speakable.js";
import { cleanCoMessage } from "./sendblue.js";
import { checkDraft, draftAgain, draftProactive, localHourOk, nextLocalHour, RULES, sendExempt } from "../harness/proactive.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { callKey } from "./callKey.js";
import { deliveryWords, nextDeliveryTime } from "./memberTime.js";
import type { Sent } from "./followThrough.js";
import type { CallLedger } from "./callLedger.js";

// Pure: the owed promise tasks from this call (services/callLedger.ts) that are settled: every link one was for landed for this member
// at any point since the call started (on the call, late, or just now). Nothing else is ever closed here: every other promise from
// the call stays open for its own follow-through (review of #320: closing by shared words closed promises nothing had kept).
export function settledOwedTasks(owed: { taskId?: number | null; items: { url: string }[] }[], landed: (url: string) => boolean): number[] {
  return [...new Set(owed.filter((o) => typeof o.taskId === "number" && o.items.length && o.items.every((i) => landed(i.url))).map((o) => o.taskId as number))];
}

export const CONFIRM_TYPE = "call_confirm" as const;
export const confirmKey = (key: string) => `call_confirm:${key}`;

// goal, theirWords, createdAt: what it promised and when, so one kept on the call (or by what went out right after it) is closed,
// never done twice (Royce, 2026-10-29).
export type Commitment = { taskId: number; sentence: string; wakes: number; goal?: string; theirWords?: string | null; createdAt?: string };

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
  if (!words(text).some((w) => said.has(w.slice(0, 4)))) missing.push("what Cue understood (name the actual thing from the call)");
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
  // skip: Cue's lines from a turn whose tool already did it on the call (services/callLedger.ts).
  track: (userId: string, transcript: string, o?: { skip?: string[]; jobs?: string[] }) => Promise<unknown>;
  // What the call did and still owes (services/callLedger.ts), what went out since it started (services/followThrough.ts
  // sendsSince), the owed send itself (each link as its own text, then its name), and closing a promise already kept. Left out
  // (older tests), the follow-through runs as before.
  ledger?: (userId: string, since: Date, until: Date) => Promise<CallLedger>;
  sends?: (userId: string, since: Date) => Promise<Sent[]>;
  deliver?: (o: { userId: string; phone: string; item: { name: string; url: string }; key: string; endedAt?: Date }) => Promise<{ sent: boolean; reason?: string }>;
  close?: (userId: string, taskId: number, outcome: string) => Promise<unknown>;
  commitments: (userId: string, since: Date) => Promise<Commitment[]>;
  person: (userId: string) => Promise<{ firstName: string; phone: string; zone: string | null; reachable: boolean } | null>;
  draft: (o: { firstName: string; facts: Record<string, string>; redo?: { draft: string; failed: string } }) => Promise<string | null>;
  send: (o: { userId: string; phone: string; key: string; text: string; zone: string | null }) => Promise<{ sent: boolean; reason?: string }>;
  // The task's own turn, now: claimed first so the cron can't run it at the same time. Resolves when the turn is done.
  runTask: (userId: string, c: Commitment) => Promise<{ ran: boolean; action?: string }>;
  hold: (userId: string, taskIds: number[], until: Date) => Promise<void>;
  record: typeof recordDecision;
  // The promise guard on calls (services/promiseBinding.ts bindCallPromises): every timed promise Co spoke binds to the ledger, and
  // what can't is admitted to them in one text (admit). Left out (tests), the call's follow-through runs as before.
  bind?: (userId: string, transcript: string) => Promise<{ unbound: { sentence: string; why: string }[]; verdicts: unknown[] }>;
  admit?: (o: { userId: string; transcript: string; unbound: { sentence: string; why: string }[] }) => Promise<{ sent: boolean; queued?: boolean; reason?: string; text?: string }>;
  ledgerUnbound?: (userId: string, p: { sentence: string; why: string; admitted: boolean }) => Promise<number | null>;
};

export type FollowThroughResult = {
  action: "none" | "unreachable" | "sent" | "held" | "send_failed" | "no_text" | "working";
  // What was owed from the call and went out the moment it ended, and the promises closed because the call (or that) kept them.
  owedSent?: string[];
  keptOnCall?: number[];
  text?: string;
  fallback?: boolean;
  heldUntil?: string;
  confirmMs?: number;
  // Resolves when every deliverable turn has finished (tests and the live check wait on it; the call path never does).
  work?: Promise<{ taskId: number; ran: boolean; action?: string }[]>;
};

// The call ended: confirm what Co said it would send, then do it. Never throws; the call's own processing never waits on it.
export async function followThroughOnCallEnd(o: { userId: string; transcript: string; startedAt?: Date | null; endedAt?: Date | null }, deps: FollowThroughDeps = realDeps): Promise<FollowThroughResult> {
  const t0 = deps.now();
  try {
    const since = new Date((o.startedAt ?? new Date(t0.getTime() - 2 * 3_600_000)).getTime() - 60_000);
    // What the call itself did and still owes (services/callLedger.ts). A failed read is an empty ledger: nothing is skipped or sent
    // on its account, and the promises run as before.
    const empty: CallLedger = { done: [], owed: [], covered: [] };
    const ledger = deps.ledger ? await deps.ledger(o.userId, since, new Date((o.endedAt ?? t0).getTime() + 2 * 60_000)).catch(() => empty) : empty;
    // A commitment said on the direct path has no task yet: open it (the same words never open twice), unless a tool already kept
    // it on the call.
    // Nor one a job started on the call carries (a task or a saved ask, by what it was for).
    await deps.track(o.userId, o.transcript, { skip: ledger.covered, jobs: ledger.done.filter((d) => d.kind === "start").flatMap((d) => d.labels) }).catch(() => null);
    // Bind or admit: each timed promise Co spoke is on the ledger now, or it's taken back in one text. Before anything else, so a
    // call with no send commitments still has its promises held to.
    if (deps.bind) {
      const b = await deps.bind(o.userId, o.transcript).catch((err: any) => {
        console.error("callFollowThrough: promise binding failed (non-fatal):", err?.message ?? err);
        return null;
      });
      if (b?.verdicts.length) await deps.record({ layer: 8, decision: "call.promise_binding", userId: o.userId, outcome: b.unbound.length ? "skip" : "act", action: b.unbound.length ? "unbound" : "bound", proposal: { verdicts: b.verdicts }, reason: b.unbound.map((u) => u.why).join("; ") || null }).catch(() => {});
      if (b?.unbound.length && deps.admit) {
        const a = await deps.admit({ userId: o.userId, transcript: o.transcript, unbound: b.unbound }).catch((err: any) => ({ sent: false, queued: false, reason: String(err?.message ?? err), text: undefined as string | undefined }));
        // Made and missed, on the ledger, admitted or not (commitmentLog.ts recordUnboundCallPromise).
        if (deps.ledgerUnbound) for (const u of b.unbound) await deps.ledgerUnbound(o.userId, { ...u, admitted: !!(a.sent || a.queued) }).catch(() => null);
        await deps.record({ layer: 8, decision: "call.promise_admitted", userId: o.userId, outcome: a.sent || a.queued ? "act" : "skip", action: a.sent ? "sent" : a.queued ? "queued" : "not_sent", proposal: { unbound: b.unbound, text: a.text ?? null }, reason: a.reason ?? null }).catch(() => {});
      }
    }
    // Owed from the call (a send that didn't reach them on it): the actual link goes now, the moment the call ends, unless the late
    // send already landed. Each link its own text, then its name (as on file). Opted out or archived: nothing.
    const owedSent: string[] = [];
    let person: Awaited<ReturnType<FollowThroughDeps["person"]>> | undefined;
    // Landed for this member since the call started: what's gone out (texts and Cue's own record), or a send done on the call.
    const wentSince = ledger.owed.length && deps.sends ? await deps.sends(o.userId, since).catch(() => [] as Sent[]) : [];
    const doneOnCall = new Set(ledger.done.flatMap((d) => d.urls));
    const landed = (url: string) => doneOnCall.has(url) || owedSent.includes(url) || wentSince.some((s) => s.text.includes(url));
    if (ledger.owed.length && deps.deliver) {
      person = await deps.person(o.userId);
      const items = [...new Map(ledger.owed.flatMap((x) => x.items).map((x) => [x.url, x])).values()];
      for (const item of items) {
        if (landed(item.url)) {
          await deps.record({ layer: 8, decision: "call.owed_delivery", userId: o.userId, outcome: "skip", action: "already_sent", proposal: { url: item.url }, reason: "the send from the call landed late" }).catch(() => {});
          continue;
        }
        if (!person || !person.reachable) {
          await deps.record({ layer: 8, decision: "call.owed_delivery", userId: o.userId, outcome: "skip", action: "unreachable", proposal: { url: item.url }, reason: "opted out, archived or no number" }).catch(() => {});
          continue;
        }
        const r = await deps.deliver({ userId: o.userId, phone: person.phone, item, key: `call_owed:${since.toISOString().slice(0, 16)}:${item.url}`.slice(0, 300), endedAt: o.endedAt ?? t0 }).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }));
        if (r.sent) owedSent.push(item.url);
        await deps.record({ layer: 8, decision: "call.owed_delivery", userId: o.userId, outcome: r.sent ? "act" : "skip", action: r.sent ? "sent" : "not_sent", proposal: { url: item.url, msSinceEnd: deps.now().getTime() - (o.endedAt ?? t0).getTime() }, reason: r.sent ? null : r.reason ?? null }).catch(() => {});
      }
    }
    const all = await deps.commitments(o.userId, since);
    // Only an owed link's own promise closes, and only when that exact link landed for them since the call started (so the late
    // landing of a send that timed out on the call is never sent twice). Every other promise runs as before.
    const keptOnCall = deps.close ? settledOwedTasks(ledger.owed, landed) : [];
    for (const id of keptOnCall) await deps.close!(o.userId, id, "Kept: the link it was for reached them on the call or the moment it ended.").catch(() => null);
    if (keptOnCall.length) await deps.record({ layer: 8, decision: "call.followthrough", userId: o.userId, outcome: "act", action: "kept_on_call", proposal: { tasks: keptOnCall }, reason: null }).catch(() => {});
    const commitments = all.filter((c) => !keptOnCall.includes(c.taskId));
    const done = { ...(owedSent.length ? { owedSent } : {}), ...(keptOnCall.length ? { keptOnCall } : {}) };
    if (!commitments.length) return { action: owedSent.length ? "sent" : "none", ...done };
    person ??= await deps.person(o.userId);
    if (!person || !person.reachable) return { action: "unreachable", ...done };

    const deliver = async (): Promise<FollowThroughResult> => {
      // No "got it, I'll have it this afternoon" text (Royce, 2026-10-08 evening, after his real call: three texts in a minute,
      // two of them "nothing yet"): silence until there's something real, then one message. The delivery says what they asked
      // for and when (services/speakable.ts deliveryLine), so it is the confirmation too.
      const confirmMs = deps.now().getTime() - (o.endedAt ?? t0).getTime();
      await deps.record({ layer: 8, decision: "call.followthrough", userId: o.userId, outcome: "act", action: "work_started", proposal: { tasks: commitments.map((c) => c.taskId), confirmMs }, reason: null }).catch(() => {});
      // The deliverable: each task's own turn, started now, sent when it finishes.
      const work = Promise.all(
        commitments.map((c) =>
          deps.runTask(o.userId, c).then((r) => ({ taskId: c.taskId, ...r })).catch((err: any) => {
            console.error("callFollowThrough: task turn failed (non-fatal):", err?.message ?? err);
            return { taskId: c.taskId, ran: false };
          }),
        ),
      );
      return { action: "working", confirmMs, work, ...done };
    };

    if (!localHourOk(t0, person.zone)) {
      // Night for them: no confirmation at all (Royce, 2026-10-08). A "Got it" written now and sent at 9am reads like Co only just
      // heard about it. The work waits for their morning and the delivery itself says what they asked for and when ("Here's the
      // plan you asked for last night": services/speakable.ts deliveryLine), so the task's own check is set for their 8am.
      // Their delivery hours start at 8am (services/memberTime.ts DELIVERY_HOURS): a plan promised at night lands at 8am.
      const at = nextDeliveryTime(t0, person.zone);
      await deps.hold(o.userId, commitments.map((c) => c.taskId), at).catch(() => {});
      await deps.record({ layer: 8, decision: "call.followthrough", userId: o.userId, outcome: "skip", action: "confirm_skipped_night", proposal: { until: at.toISOString(), tasks: commitments.map((c) => c.taskId) }, reason: "outside their hours: the morning delivery says what was asked and when" }).catch(() => {});
      return { action: "held", heldUntil: at.toISOString(), ...done };
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
        `SELECT id, goal, wakes, their_words, created_at FROM co_tasks WHERE user_id = $1 AND source = 'promise' AND status = 'open' AND goal LIKE $2 AND created_at >= $3 ORDER BY id`,
        [userId, `${COMMIT_PREFIX}%`, since],
      )
    ).rows.map((r: any) => ({ taskId: Number(r.id), sentence: sentenceOfGoal(String(r.goal)), wakes: Number(r.wakes), goal: String(r.goal), theirWords: r.their_words ?? null, createdAt: new Date(r.created_at).toISOString() })),
  ledger: async (userId, since, until) => (await import("./callLedger.js")).readCallLedger(userId, since, until),
  sends: async (userId, since) => (await import("./followThrough.js")).sendsSince(userId, since),
  // The owed link, as a direct answer to what they asked on the call: it goes now, at any hour (they were just on the phone), never
  // past an opt-out (sendExempt re-reads it), once per call and link (its target key).
  deliver: async ({ userId, phone, item, key, endedAt }) => {
    const caption = item.name.replace(/\s+/g, " ").trim().slice(0, 200);
    // A delivery of what they asked for on the call (requested, never a reply: R1). Asked at the call's end, so right after the call it
    // skips the spacing (answersLastText); their own rule holds it like any delivery.
    const r = await sendExempt({ userId, phoneNumber: phone, type: "direct_ask", targetKey: key, messages: caption ? [item.url, caption] : [item.url], answers: { askedAt: endedAt ?? null }, cls: "requested" });
    if (r.sent) await import("./coFacts.js").then((F) => F.recordSentItems(userId, [{ name: item.name, url: item.url }], "call.owed")).catch(() => {});
    return { sent: r.sent, reason: r.reason };
  },
  close: async (userId, taskId, outcome) => (await import("./coTasks.js")).closeTask(userId, taskId, "done", outcome),
  person: async (userId) => {
    const { rows } = await pool.query(`SELECT u.first_name, u.phone_number, u.sms_opted_out, u.archived_at, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]);
    const p = rows[0];
    if (!p) return null;
    const zone = await (await import("./memberTime.js")).memberZone(userId).catch(() => null);
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
  record: recordDecision,
  bind: async (userId, transcript) => (await import("./promiseBinding.js")).bindCallPromises(userId, transcript),
  ledgerUnbound: async (userId, p) => (await import("./commitmentLog.js")).recordUnboundCallPromise(userId, p),
  admit: async ({ userId, transcript, unbound }) => {
    const { rows } = await pool.query(`SELECT first_name, phone_number, sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]);
    const p = rows[0];
    if (!p || p.sms_opted_out || p.archived_at || !p.phone_number) return { sent: false, reason: "unreachable" };
    const zone = await (await import("./memberTime.js")).memberZone(userId).catch(() => null);
    const { admissionFallback } = await import("./promiseBinding.js");
    const facts = { what_you_said_on_the_call: unbound.map((u) => u.sentence).join(" | "), why_you_cant_hold_it: unbound.map((u) => u.why).join(" | ") };
    const task = `On the call you told them something you can't actually hold yourself to (what_you_said_on_the_call, and why_you_cant_hold_it). Text them one or two plain sentences that take it back honestly, in your own voice: what you said, and that it isn't something you can do or hold; if it's something only they can do, say it's theirs. No new promise or time, no excuse, no apology spiral, no question, no sign-off.`;
    const bad = (t: string) => checkDraft(t, { maxSentences: 3, maxChars: 320 }).filter((c) => !c.pass);
    let text = await draftProactive({ functionId: "call.promise.admit", firstName: p.first_name || "them", facts, task, maxSentences: 3 }).catch(() => null);
    if (text && bad(text).length) text = await draftAgain({ draft: text, failed: bad(text).map((c) => c.reason ?? c.name).join("; ") }, () => draftProactive({ functionId: "call.promise.admit", firstName: p.first_name || "them", facts, task, maxSentences: 3 })).catch(() => null);
    if (!text || bad(text).length) text = admissionFallback(unbound);
    // The existing after-call send type (never counted as the promised thing), once per call, held to their morning at night.
    const { sendExemptWhenAllowed } = await import("../harness/proactive.js");
    const r = await sendExemptWhenAllowed({ userId, phoneNumber: p.phone_number, type: CONFIRM_TYPE, targetKey: `call_admit:${callKey(transcript)}`, messages: [text], timezone: zone });
    return { sent: r.sent, queued: r.queued, reason: r.reason, text };
  },
};

// The held confirmation's send settled (services/deferredSends.ts): sent, the work starts now, as it would have right after a
// daytime confirmation; not sent, the task's own backstop check (just after 8am) still runs it.
export async function afterConfirmSent(p: { userId: string; tasks: Commitment[] }, outcome: "sent" | "skipped" | "failed", deps: Pick<FollowThroughDeps, "runTask" | "record"> = realDeps): Promise<{ work: Promise<unknown> | null }> {
  await deps.record({ layer: 8, decision: "call.followthrough", userId: p.userId, outcome: outcome === "sent" ? "act" : "skip", action: `confirm_${outcome === "sent" ? "sent" : "send_failed"}`, proposal: { held: true, tasks: (p.tasks ?? []).map((c) => c.taskId) }, reason: outcome === "sent" ? null : outcome }).catch(() => {});
  if (outcome !== "sent") return { work: null };
  // Not awaited by the cron: a task turn can take a while, and the next held send shouldn't wait on it.
  const work = Promise.all(
    (p.tasks ?? []).map((c) =>
      deps.runTask(p.userId, c).catch((err: any) => {
        console.error("callFollowThrough: task turn failed (non-fatal):", err?.message ?? err);
        return { ran: false };
      }),
    ),
  );
  return { work };
}

// The confirmation that went out for a call, if one did: the after-call reflection text reads it so it never says the same thing twice.
export async function confirmationSentFor(userId: string, transcript: string): Promise<string | null> {
  const { rows } = await pool
    .query(`SELECT message FROM proactive_sends WHERE user_id = $1 AND target_key = $2 LIMIT 1`, [userId, confirmKey(callKey(transcript))])
    .catch(() => ({ rows: [] as any[] }));
  return rows[0]?.message ?? null;
}
