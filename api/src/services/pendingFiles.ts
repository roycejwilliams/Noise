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
export type PendingFile = { type: PendingType; word: FileWord; mode: PendingMode; input: unknown; at: string };
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

export type FinishDeps = {
  now: () => Date;
  person: { phone: string; firstName: string; zone: string | null; optedOut: boolean; archived: boolean } | null;
  // Their texts after the ask, oldest first.
  theirLinesSince: (since: Date) => Promise<string[]>;
  hoursOk: (at: Date, zone: string | null) => boolean;
  nextOpen: (at: Date, zone: string | null) => Date;
  // The same tool it came from, run again with the held file and their answer (finishing: never a second question).
  run: (p: PendingFile, answer: string) => Promise<{ sent: boolean; what: string }>;
  close: (status: "done" | "dropped" | "expired", why: string) => Promise<boolean>;
  wait: (at: Date) => Promise<void>;
  log: (action: string, extra?: Record<string, string | number | boolean | null>) => Promise<void>;
};

// The wake of a held file: their reply came (or its time ran out).
export async function finishPendingFile(task: Pick<CoTask, "id" | "userId" | "createdAt" | "theirReplyAt" | "followup">, deps: FinishDeps): Promise<{ action: string }> {
  const p: PendingFile | undefined = task.followup?.pendingFile;
  const end = async (status: "done" | "dropped" | "expired", why: string, action: string) => {
    await deps.close(status, why);
    await deps.log(action, p ? { type: p.type, mode: p.mode } : {});
    return { action };
  };
  if (!p?.type) return end("dropped", "nothing held", "nothing_held");
  if (!deps.person || deps.person.optedOut || deps.person.archived) return end("dropped", "member opted out or left", "member_gone");
  const now = deps.now();
  const askedAt = new Date(p.at || task.createdAt);
  const replied = !!task.theirReplyAt && new Date(task.theirReplyAt).getTime() > askedAt.getTime();
  if (!replied) {
    if (now.getTime() - askedAt.getTime() >= PENDING_DAYS * DAY) return end("expired", "no answer", "expired");
    await deps.wait(new Date(askedAt.getTime() + PENDING_DAYS * DAY));
    return { action: "waiting" };
  }
  const lines = await deps.theirLinesSince(askedAt).catch(() => [] as string[]);
  if (!lines.length) return { action: "reply_unread" };
  if (p.mode === "retry" && !TRY_AGAIN_YES.test(lines[0].trim())) return end("dropped", "they didn't ask for it again", "declined");
  // Inside their hours only: their answer at 11pm is finished at their 8am.
  if (!deps.hoursOk(now, deps.person.zone)) {
    const at = deps.nextOpen(now, deps.person.zone);
    await deps.wait(at);
    await deps.log("held_hours", { type: p.type, mode: p.mode });
    return { action: "held_hours" };
  }
  // Claimed before it runs: whatever happens next, it runs once.
  if (!(await deps.close("done", "finished from their answer"))) return { action: "already_settled" };
  const r = await deps.run(p, lines.join("\n")).catch((err: any) => ({ sent: false, what: `threw: ${String(err?.message ?? err).slice(0, 80)}` }));
  await deps.log(r.sent ? "finished" : "not_sent", { type: p.type, mode: p.mode, what: r.what.slice(0, 120) });
  return { action: r.sent ? "finished" : "not_sent" };
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
  return finishPendingFile(task, {
    now: () => new Date(),
    person: u ? { phone: String(u.phone_number), firstName: String(u.first_name ?? ""), zone, optedOut: !!u.sms_opted_out, archived: !!u.archived_at } : null,
    theirLinesSince: async (since) =>
      (await pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > $2 ORDER BY created_at ASC LIMIT 6`, [task.userId, since])).rows.map((r: any) => String(r.content).replace(/^User said:\s*/i, "")),
    hoursOk: (at, z) => P.localHourOk(at, z),
    nextOpen: (at, z) => nextSendable(at, z),
    run: (p, answer) => runHeld(task, p, answer, { phone: String(u.phone_number), firstName: String(u.first_name ?? ""), zone }),
    close: (status, why) => closePending(task.userId, task.id, status, why),
    wait: (at) => waitUntil(task.userId, task.id, at),
    // Kind and mode only: never the file, the question or their answer.
    log: (action, extra) => recordDecision({ layer: 7, decision: "file.pending", userId: task.userId, outcome: action === "finished" ? "act" : "skip", action, proposal: { taskId: task.id, ...(extra ?? {}) } }).then(() => {}).catch(() => {}),
  });
}

async function runHeld(task: CoTask, p: PendingFile, answer: string, who: { phone: string; firstName: string; zone: string | null }): Promise<{ sent: boolean; what: string }> {
  const { sendExempt } = await import("../harness/proactive.js");
  const { writeMemory } = await import("./memory.js");
  let n = 0;
  let sent = false;
  // One line at a time on the task path, owed (they asked), each with its own key so nothing goes twice.
  const say = async (text: string, record: string): Promise<boolean> => {
    const r = await sendExempt({ userId: task.userId, phoneNumber: who.phone, type: "task_update", targetKey: `pending_file:${task.id}:${n++}`, messages: [text], timezone: who.zone, respectHours: true }).catch(() => ({ sent: false }));
    if (!r.sent) return false;
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
    const r = await D.sendDocumentForTask(p.input as any, { userId: task.userId, taskId: task.id, firstName: who.firstName, phone: who.phone, zone: who.zone, taskTheirWords: answer, read: "", finishing: { mode: p.mode }, word: p.word, onHold: async (h) => void (await rememberPending({ userId: task.userId, type: "doc", word: h.word, mode: h.mode, input: h.input, theirWords: answer })) }, D.realTaskDocDeps);
    return { sent: r.ok || !!(r as any).told, what: r.ok ? `sent (${r.via})` : (r as any).told ? `told: ${(r as any).told}` : "not sent" };
  }
  const tools: any = p.type === "deck" || p.type === "deck_update" ? (await import("../agent/deckTools.js")).deckTools(ctx, o) : (await import("../agent/pageTools.js")).pageTools(ctx, o);
  const name = p.type === "deck" ? "makeDeck" : p.type === "deck_update" ? "updateDeck" : p.type === "page" ? "makePage" : "updatePage";
  const r = await tools[name].execute(p.input, { toolCallId: `pending-${task.id}`, messages: [] });
  return { sent, what: r?.ok ? "sent" : String(r?.error ?? "not sent").slice(0, 80) };
}
