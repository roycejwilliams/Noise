// A file Cue held back on a refusal, waiting on the member (services/refusalOutcome.ts): the one question it asked (case 1), or "want me
// to try again?" when the check couldn't run (case 3). One co_tasks row of its own kind ("pending_file"), so it's an open loop
// (services/openLoops.ts reads it) and their reply wakes it (coTasks.ts wakeOnReply), the same way a task's text does. When they
// answer, the file is finished in the background from their answer and sent, through the very same tool and checks it came from
// (finishPendingFile): never a second question, and a check still down never asks "try again?" twice.
//   - the held file lives only on that row, and only while it waits: done, superseded, declined or expired, it's wiped (forget by
//     default), and it expires after PENDING_DAYS with no answer, before an open loop's own "still on your plate?" ask would come;
//   - a deck, page or doc of the same kind made in a reply meanwhile supersedes it (settlePending), so a file never goes twice;
//   - it goes inside their hours (8am to 9pm their time), on the task send path (harness/proactive.ts sendExempt), owed: they asked.
import pool from "../db/db.js";
import type { CoTask } from "./coTasks.js";
import type { FileWord } from "./refusalOutcome.js";
import { memberZone, nextSendable } from "./memberTime.js";
import { notToTeammate } from "./teamLines.js";

export type PendingType = "deck" | "deck_update" | "page" | "page_update" | "doc";
export type PendingMode = "answer" | "retry";
// tries: background runs after their reply (claimPending counts them); capped at MAX_FINISH_TRIES.
export type PendingFile = { type: PendingType; word: FileWord; mode: PendingMode; input: unknown; at: string; tries?: number };
// No answer in this many days: expired and wiped (an open loop's decay ask comes at 7, services/loopLifecycle.ts ASK_AFTER_DAYS).
export const PENDING_DAYS = 6;
const DAY = 86_400_000;

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// Pure: the row's goal, said of the file, never of what's on it (it's the open loop's title).
export const pendingGoal = (word: FileWord, mode: PendingMode): string => (mode === "answer" ? `Finish their ${word} once they answer Cue's question about it` : `Try their ${word} again if they say yes`);

// Tests only: where pending files are kept.
let store: Db | null = null;
export function usePendingDb(db: Db | null): void {
  store = db;
}
const db = (): Db => store ?? pool;

// Held: the file waits on their reply. An older one of the same kind is superseded (one at a time). Returns the row's id, or null.
export async function rememberPending(o: { userId: string; type: PendingType; word: FileWord; mode: PendingMode; input: unknown; theirWords: string; now?: Date }): Promise<number | null> {
  const now = o.now ?? new Date();
  await settlePending(o.userId, [o.type], "superseded by a newer one");
  const file: PendingFile = { type: o.type, word: o.word, mode: o.mode, input: o.input, at: now.toISOString() };
  const r = await db()
    .query(
      `INSERT INTO co_tasks (user_id, goal, their_words, steps, plan_next, next_check_at, notes, kind, followup, source, awaiting_reply, last_texted_at)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, $5, $6::jsonb, 'pending_file', $7::jsonb, 'ask', true, $8) RETURNING id`,
      [o.userId, pendingGoal(o.word, o.mode), (o.theirWords || "(their ask)").trim().slice(0, 400), o.mode === "answer" ? "finish it from their answer" : "try it again on their yes", new Date(now.getTime() + PENDING_DAYS * DAY), JSON.stringify([{ at: now.toISOString(), text: o.mode === "answer" ? "Asked them one question before sending it." : "Told them it didn't go through; asked if they want it tried again." }]), JSON.stringify({ pendingFile: file }), now],
    )
    .catch((err: any) => {
      console.error("pendingFiles: remembering a held file failed (non-fatal):", err?.message ?? err);
      return { rows: [] as any[] };
    });
  return r.rows[0]?.id != null ? Number(r.rows[0].id) : null;
}

// A file of the same kind went out (made in a reply, or finished here): the held ones are closed and wiped. Returns how many.
export async function settlePending(userId: string, types: PendingType[], why: string, status: "done" | "dropped" | "expired" = "done"): Promise<number> {
  const r = await db()
    .query(
      `UPDATE co_tasks SET status = $3, outcome = $4, closed_at = NOW(), next_check_at = NULL, updated_at = NOW(), followup = COALESCE(followup, '{}'::jsonb) - 'pendingFile'
       WHERE user_id = $1 AND kind = 'pending_file' AND status = 'open' AND followup->'pendingFile'->>'type' = ANY($2::text[]) RETURNING id`,
      [userId, types, status, why.slice(0, 300)],
    )
    .catch((err: any) => {
      console.error("pendingFiles: settling held files failed (non-fatal):", err?.message ?? err);
      return { rows: [] as any[], rowCount: 0 };
    });
  return r.rows.length;
}
// One held file, closed and wiped, only if it's still open (so two runs never finish it twice). True when this call closed it.
export async function closePending(userId: string, id: number, status: "done" | "dropped" | "expired", why: string): Promise<boolean> {
  const r = await db()
    .query(
      `UPDATE co_tasks SET status = $3, outcome = $4, closed_at = NOW(), next_check_at = NULL, updated_at = NOW(), followup = COALESCE(followup, '{}'::jsonb) - 'pendingFile'
       WHERE user_id = $1 AND id = $2 AND kind = 'pending_file' AND status = 'open' RETURNING id`,
      [userId, id, status, why.slice(0, 300)],
    )
    .catch(() => ({ rows: [] as any[] }));
  return r.rows.length > 0;
}
async function waitUntil(userId: string, id: number, at: Date): Promise<void> {
  await db().query(`UPDATE co_tasks SET next_check_at = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`, [userId, id, at]).catch(() => {});
}

// A task's own document, held on a refusal (services/documentDelivery.ts realDocRefusals): on the task itself, which now waits on their
// reply (awaiting it, so the reply wakes it) to the hold's end; its next turn writes the document from their answer (taskTurn.ts).
export async function holdOnTask(o: { userId: string; taskId: number; mode: PendingMode; input: unknown; word: FileWord; now: Date }): Promise<void> {
  const file: PendingFile = { type: "doc", word: o.word, mode: o.mode, input: o.input, at: o.now.toISOString() };
  await db().query(
    `UPDATE co_tasks SET followup = jsonb_set(COALESCE(followup, '{}'::jsonb), '{pendingFile}', $3::jsonb, true), awaiting_reply = true, last_texted_at = $4, texts_sent = texts_sent + 1,
       next_check_at = $5, plan_next = $6, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`,
    [o.userId, o.taskId, JSON.stringify(file), o.now, new Date(o.now.getTime() + PENDING_DAYS * DAY), o.mode === "answer" ? "They answered your one question about the document: write it now with their answer and send it." : "They answered whether to try the document again: if it's a yes, write it and send it; otherwise close the task with their words."],
  );
}

// A task's own document held on a refusal (services/documentDelivery.ts realDocRefusals): a wake before their reply only waits again,
// to the hold's end, and isn't counted; past it, the hold is cleared and the task runs as it would.
export async function waitForAnswer(t: Pick<CoTask, "id" | "userId" | "followup">, now = new Date()): Promise<void> {
  const at = new Date(t.followup?.pendingFile?.at ?? now);
  const until = new Date(at.getTime() + PENDING_DAYS * DAY);
  if (now.getTime() >= until.getTime()) {
    await db().query(`UPDATE co_tasks SET followup = COALESCE(followup, '{}'::jsonb) - 'pendingFile', awaiting_reply = false, next_check_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`, [t.userId, t.id]).catch(() => {});
    return;
  }
  await db().query(`UPDATE co_tasks SET next_check_at = $3, wakes = GREATEST(wakes - 1, 0), updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`, [t.userId, t.id, until]).catch(() => {});
}

// Their answer to "try again?": a plain yes. Anything else (no, not now, another subject) closes it quietly: their reply already got
// its answer in the reply.
export const TRY_AGAIN_YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|try again|try it again|yes please|please do|go for it|absolutely|definitely)\b/i;

// How a background run ended (review of #243): a line went; a send wasn't made (paused, held, failed: kept for a retry); the tool
// couldn't make it at all (the deck is gone, a picture was deleted, another change landed); or nothing more is said by design (their
// yes found the check still down: never "try again?" twice).
export type RunOutcome = "sent" | "send_failed" | "tool_error" | "nothing_more";
export type FinishDeps = {
  now: () => Date;
  person: { phone: string; firstName: string; zone: string | null; optedOut: boolean; archived: boolean } | null;
  // Their texts after the ask, oldest first.
  theirLinesSince: (since: Date) => Promise<string[]>;
  hoursOk: (at: Date, zone: string | null) => boolean;
  nextOpen: (at: Date, zone: string | null) => Date;
  // Texts Cue starts are paused (harness/proactivePause.ts PROACTIVE_PAUSED): nothing runs, nothing is stored, it waits.
  paused: () => boolean;
  // A safety concern in the last few days (services/safety.ts safetyHoldActive): nothing is asked of them or sent for it; it waits.
  safetyHold: () => Promise<boolean>;
  // The row, marked as running so two runs never finish it at once; false when it's settled or already running.
  claim: () => Promise<boolean>;
  release: () => Promise<void>;
  // The same tool it came from, run again with the held file and their answer (finishing: never a second question).
  run: (p: PendingFile, answer: string) => Promise<{ outcome: RunOutcome }>;
  // Case 3, the approved line, when the tool couldn't make it at all: sent on the task path; true when it went.
  tellDown: (word: FileWord) => Promise<boolean>;
  // After case 3 went: the row waits for their yes.
  toRetry: (word: FileWord) => Promise<void>;
  close: (status: "done" | "dropped" | "expired", why: string) => Promise<boolean>;
  wait: (at: Date) => Promise<void>;
  // Kinds only (forget by default): never the file, the question, their answer or a tool's error text.
  log: (action: string, extra?: Record<string, string | number | boolean | null>) => Promise<void>;
};
export const RETRY_AFTER_MS = 3_600_000;
// Background runs after their reply, at most (each is the whole tool: the fix, the judge, the slots). Whichever comes first, this or
// PENDING_DAYS from the hold, ends it: the held file is wiped and it closes without a message (listed for Royce).
export const MAX_FINISH_TRIES = 3;
export const SAFETY_WAIT_MS = 24 * 3_600_000;

// The wake of a held file: their reply came (or its time ran out).
export async function finishPendingFile(task: Pick<CoTask, "id" | "userId" | "createdAt" | "theirReplyAt" | "followup">, deps: FinishDeps): Promise<{ action: string }> {
  const p: PendingFile | undefined = task.followup?.pendingFile;
  const kinds: Record<string, string> = p ? { type: p.type, mode: p.mode } : {};
  const end = async (status: "done" | "dropped" | "expired", why: string, action: string) => {
    await deps.close(status, why);
    await deps.log(action, kinds);
    return { action };
  };
  if (!p?.type) return end("dropped", "nothing held", "nothing_held");
  if (!deps.person || deps.person.optedOut || deps.person.archived) return end("dropped", "member opted out or left", "member_gone");
  const now = deps.now();
  const askedAt = new Date(p.at || task.createdAt);
  const replied = !!task.theirReplyAt && new Date(task.theirReplyAt).getTime() > askedAt.getTime();
  // Its days run from the hold, answered or not: a finish that keeps failing never retries past them.
  if (now.getTime() - askedAt.getTime() >= PENDING_DAYS * DAY) return end("expired", replied ? "its days ran out before it could go" : "no answer", replied ? "expired_after_reply" : "expired");
  if (!replied) {
    await deps.wait(new Date(askedAt.getTime() + PENDING_DAYS * DAY));
    return { action: "waiting" };
  }
  if ((p.tries ?? 0) >= MAX_FINISH_TRIES) return end("expired", `tried ${MAX_FINISH_TRIES} times`, "tries_used");
  const lines = await deps.theirLinesSince(askedAt).catch(() => [] as string[]);
  if (!lines.length) return { action: "reply_unread" };
  if (p.mode === "retry" && !TRY_AGAIN_YES.test(lines[0].trim())) return end("dropped", "they didn't ask for it again", "declined");
  // Inside their hours only: their answer at 11pm is finished at their 8am.
  if (!deps.hoursOk(now, deps.person.zone)) {
    await deps.wait(deps.nextOpen(now, deps.person.zone));
    await deps.log("held_hours", kinds);
    return { action: "held_hours" };
  }
  // Paused: checked before anything runs or is stored; not a try.
  if (deps.paused()) {
    await deps.wait(new Date(now.getTime() + RETRY_AFTER_MS));
    await deps.log("held_paused", kinds);
    return { action: "held_paused" };
  }
  // A safety hold: nothing goes for it; it waits a day (the same hold a task's document line waits on).
  if (await deps.safetyHold().catch(() => true)) {
    await deps.wait(new Date(now.getTime() + SAFETY_WAIT_MS));
    await deps.log("held_safety", kinds);
    return { action: "held_safety" };
  }
  // Marked as running, never closed before it has gone: a run that sends nothing keeps the row.
  if (!(await deps.claim())) return { action: "already_settled" };
  const r = await deps.run(p, lines.join("\n")).catch(() => ({ outcome: "tool_error" as RunOutcome }));
  if (r.outcome === "sent") return end("done", "finished from their answer", "finished");
  if (r.outcome === "nothing_more") return end("dropped", "their yes found the check still down", "nothing_more");
  if (r.outcome === "send_failed") {
    await deps.release();
    await deps.wait(new Date(now.getTime() + RETRY_AFTER_MS));
    await deps.log("send_failed_kept", kinds);
    return { action: "send_failed_kept" };
  }
  // The tool couldn't make it at all. On their answer, they still get one useful text: case 3, the approved line, and their yes tries
  // again. On their yes, nothing more (never "try again?" twice; listed for Royce).
  if (p.mode === "retry") return end("dropped", "the file still couldn't be made on their yes", "tool_error_on_yes");
  if (await deps.tellDown(p.word).catch(() => false)) {
    await deps.toRetry(p.word);
    await deps.log("tool_error_told", kinds);
    return { action: "tool_error_told" };
  }
  await deps.release();
  await deps.wait(new Date(now.getTime() + RETRY_AFTER_MS));
  await deps.log("tool_error_kept", kinds);
  return { action: "tool_error_kept" };
}

// ---------------------------------------------------------------- the real run
// A tool context for a background run: their answer is this turn's words; nothing is a reply to a text in flight, so every line goes
// by the task send path inside their hours.
export async function realFinish(task: CoTask): Promise<{ action: string }> {
  const { rows } = await pool.query(`SELECT first_name, phone_number, sms_opted_out, archived_at FROM users WHERE id = $1`, [task.userId]).catch(() => ({ rows: [] as any[] }));
  const u = rows[0];
  const zone = u ? await memberZone(task.userId).catch(() => null) : null;
  const P = await import("../harness/proactive.js");
  const { recordDecision } = await import("../harness/core.js");
  const { downLine } = await import("./refusalOutcome.js");
  return finishPendingFile(task, {
    now: () => new Date(),
    person: u ? { phone: String(u.phone_number), firstName: String(u.first_name ?? ""), zone, optedOut: !!u.sms_opted_out, archived: !!u.archived_at } : null,
    theirLinesSince: async (since) =>
      (await pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > $2 ORDER BY created_at ASC LIMIT 6`, [task.userId, since])).rows.map((r: any) => String(r.content).replace(/^User said:\s*/i, "")),
    hoursOk: (at, z) => P.localHourOk(at, z),
    nextOpen: (at, z) => nextSendable(at, z),
    paused: () => P.proactivePaused(),
    // Fails closed: a hold that can't be read is a hold.
    safetyHold: async () => (await import("./safety.js")).safetyHoldActive(task.userId).catch(() => true),
    claim: () => claimPending(task.userId, task.id),
    release: () => releasePending(task.userId, task.id),
    run: (p, answer) => runHeld(task, p, answer, { phone: String(u.phone_number), firstName: String(u.first_name ?? ""), zone }),
    tellDown: async (word) => {
      const text = downLine(word);
      const r = await P.sendExempt({ userId: task.userId, phoneNumber: String(u.phone_number), type: "task_update", targetKey: `pending_file:${task.id}:down`, messages: [text], timezone: zone, respectHours: true }).catch(() => ({ sent: false }));
      if (r.sent) await import("./memory.js").then((m) => m.writeMemory(task.userId, "text_exchange", `Co replied: ${text}`)).catch(() => {});
      return r.sent;
    },
    toRetry: (word) => toRetryPending(task.userId, task.id, word),
    close: (status, why) => closePending(task.userId, task.id, status, why),
    wait: (at) => waitUntil(task.userId, task.id, at),
    log: (action, extra) => recordDecision({ layer: 7, decision: "file.pending", userId: task.userId, outcome: action === "finished" ? "act" : "skip", action, proposal: { taskId: task.id, ...(extra ?? {}) } }).then(() => {}).catch(() => {}),
  });
}

// The row marked as running (a run that died frees it after 15 minutes); false when it's settled or another run has it.
export async function claimPending(userId: string, id: number): Promise<boolean> {
  const r = await db()
    .query(
      `UPDATE co_tasks SET followup = jsonb_set(jsonb_set(followup, '{pendingFile,runningAt}', to_jsonb(NOW()), true), '{pendingFile,tries}', to_jsonb(COALESCE((followup->'pendingFile'->>'tries')::int, 0) + 1), true), updated_at = NOW()
       WHERE user_id = $1 AND id = $2 AND kind = 'pending_file' AND status = 'open' AND followup ? 'pendingFile'
         AND (followup->'pendingFile'->>'runningAt' IS NULL OR (followup->'pendingFile'->>'runningAt')::timestamptz < NOW() - INTERVAL '15 minutes') RETURNING id`,
      [userId, id],
    )
    .catch(() => ({ rows: [] as any[] }));
  return r.rows.length > 0;
}
async function releasePending(userId: string, id: number): Promise<void> {
  await db().query(`UPDATE co_tasks SET followup = followup #- '{pendingFile,runningAt}', updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`, [userId, id]).catch(() => {});
}
// Case 3 went after the tool couldn't make it: the row now waits for their yes, from now.
async function toRetryPending(userId: string, id: number, word: FileWord): Promise<void> {
  await db()
    .query(
      `UPDATE co_tasks SET followup = jsonb_set(jsonb_set(followup #- '{pendingFile,runningAt}', '{pendingFile,mode}', '"retry"'), '{pendingFile,at}', to_jsonb(NOW())),
         goal = $3, awaiting_reply = true, last_texted_at = NOW(), next_check_at = NOW() + make_interval(days => $4), updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'open'`,
      [userId, id, pendingGoal(word, "retry"), PENDING_DAYS],
    )
    .catch(() => {});
}

async function runHeld(task: CoTask, p: PendingFile, answer: string, who: { phone: string; firstName: string; zone: string | null }): Promise<{ outcome: RunOutcome }> {
  const { sendExempt } = await import("../harness/proactive.js");
  const { writeMemory } = await import("./memory.js");
  let n = 0;
  let sent = false;
  let sendFailed = false;
  // One line at a time on the task path, owed (they asked), each with its own key so nothing goes twice. A send that isn't made
  // (paused, held, failed) is remembered: the row is kept for a retry.
  const say = async (text: string, record: string): Promise<boolean> => {
    const r = await sendExempt({ userId: task.userId, phoneNumber: who.phone, type: "task_update", targetKey: `pending_file:${task.id}:${n++}`, messages: [text], timezone: who.zone, respectHours: true }).catch(() => ({ sent: false }));
    if (!r.sent) {
      sendFailed = true;
      return false;
    }
    sent = true;
    await writeMemory(task.userId, "text_exchange", record).catch(() => {});
    return true;
  };
  const ctx: any = {
    userId: task.userId,
    phoneNumber: who.phone,
    resolvedContent: answer,
    isVoice: false,
    hasPendingOffer: false,
    recentOfferBurstActive: false,
    dryRun: false,
    sendCoReply: async () => false,
    facts: { add: () => {}, text: () => "" },
    firstName: who.firstName,
    finishing: { mode: p.mode, taskId: task.id },
  };
  const source = async () => {
    const { loadTheirWords } = await import("./documentDelivery.js");
    const { loadMemberRecord } = await import("./memberRecord.js");
    const [words, member] = await Promise.all([loadTheirWords(task.userId).catch(() => ""), loadMemberRecord(task.userId).catch(() => null)]);
    return { theirs: [words, answer].join("\n"), read: "", member };
  };
  const o = { say, notDone: () => {}, source };
  if (p.type === "doc") {
    const D = await import("./documentDelivery.js");
    // A reply's held doc is still a "doc"; a check still down on their answer holds it again here, as its own held file.
    const r: any = await D.sendDocumentForTask(p.input as any, { userId: task.userId, taskId: task.id, firstName: who.firstName, phone: who.phone, zone: who.zone, taskTheirWords: answer, read: "", finishing: { mode: p.mode }, word: p.word, onHold: async (h) => void (await rememberPending({ userId: task.userId, type: "doc", word: h.word, mode: h.mode, input: h.input, theirWords: answer })) }, D.realTaskDocDeps);
    return { outcome: docOutcome(r) };
  }
  const tools: any = p.type === "deck" || p.type === "deck_update" ? (await import("../agent/deckTools.js")).deckTools(ctx, o) : (await import("../agent/pageTools.js")).pageTools(ctx, o);
  const name = p.type === "deck" ? "makeDeck" : p.type === "deck_update" ? "updateDeck" : p.type === "page" ? "makePage" : "updatePage";
  const r = await tools[name].execute(p.input, { toolCallId: `pending-${task.id}`, messages: [] });
  // A new deck or page stored for a text that didn't go is taken down at once: a retry never leaves one behind.
  const orphan = !sent && sendFailed && (p.type === "deck" || p.type === "page") ? orphanId(r) : null;
  if (orphan) await (await import("./coPages/store.js")).takeDownCoPage(orphan, task.userId).catch(() => false);
  return { outcome: toolOutcome(r, { sent, sendFailed }) };
}
// Pure: the id of a new deck or page that was made but whose text didn't go (agent/linkAnswer.ts unsentLink), else null.
export function orphanId(r: any): string | null {
  return r?.ok === false && typeof r?.made === "string" ? String(r?.url ?? "").match(/\/d\/(?:v\/)?([A-Za-z0-9_-]{24})(?![A-Za-z0-9_-])/)?.[1] ?? null : null;
}
// Pure: a held deck's or page's run, as how it ended.
export function toolOutcome(r: any, s: { sent: boolean; sendFailed: boolean }): RunOutcome {
  if (s.sent) return "sent";
  if (s.sendFailed) return "send_failed";
  if (r?.ok === false && /still couldn't run, so nothing was sent/.test(String(r?.error ?? ""))) return "nothing_more";
  return "tool_error";
}
// Pure: a held doc's run, as how it ended.
export function docOutcome(r: any): RunOutcome {
  if (r?.ok || r?.told) return "sent";
  if (r?.duplicate) return "sent";
  if (/the check still couldn't run/.test(String(r?.why ?? ""))) return "nothing_more";
  if (r?.blocked || /didn't go|didn't send|text telling them so/.test(String(r?.why ?? ""))) return "send_failed";
  return "tool_error";
}
