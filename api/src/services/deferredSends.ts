// Durable held sends (2026-10-07). A text that comes due outside the member's hours (harness/proactive.ts
// sendExemptWhenAllowed: a passed-on message, a reminder, a heads-up, a direct intro ask; services/callFollowThrough.ts's
// after-call confirmation at night) used to wait in an in-process setTimeout until 9am. A restart or deploy lost it, and
// the callers had already written "sent" (the relay's status, the reminder's sent_at, the "Co replied:" line), so Co's
// memory said it went when it never did.
//
// Now it waits as a row in deferred_sends, and a minute cron (jobs/index.ts) sends due rows through sendExempt, which
// checks pause, hours and STOP again at send time. What a send means for the record (a relay's status, a reminder's
// sent_at, an intro ask's pending offer) is the row's after_kind, run only once it actually sent; sendExempt itself
// writes the text_exchange line and the co_facts "texted" fact on delivery.
//
// Idempotent twice over: a row is claimed by bumping attempts where attempts still has the value it was read with (two
// instances can't both win), and the send itself is keyed on proactive_sends (user_id, target_key), so a row re-claimed
// after a crash mid-send gets "already sent", never a second text.
import pool from "../db/db.js";
import { localHourOk, nextLocalHour, RULES, sendExempt, type ExemptType } from "../harness/proactive.js";
import { dropStaleAck } from "./speakable.js";
import { recordDecision } from "../harness/core.js";

export type AfterKind = "relay" | "reminder" | "network_intro_ask" | "event_direct_ask" | "call_confirm";
export type AfterSend = { kind: AfterKind; payload: Record<string, unknown> };
export type SendOutcome = "sent" | "skipped" | "failed";

export const DEFERRED_LIMITS = {
  perRun: 25,
  // A row claimed this long ago and never finished: the process died mid-send. Claimable again (the send is idempotent).
  staleClaimMs: 10 * 60_000,
  // Errors (not opt-out, not hours): retried this often, at most this many times.
  retryAfterMs: 5 * 60_000,
  maxAttempts: 3,
};

export type DeferredRow = {
  id: number;
  user_id: string;
  phone_number: string;
  type: ExemptType;
  target_key: string;
  messages: string[];
  timezone: string | null;
  after_kind: AfterKind | null;
  after_payload: Record<string, unknown> | null;
  due_at: Date;
  status: string;
  attempts: number;
  archived?: boolean;
  created_at?: Date | string | null;
};

// Queue a send for `dueAt`. One row per (user, target_key): queueing the same thing twice keeps the first.
export async function enqueueDeferredSend(o: {
  userId: string;
  phoneNumber: string;
  type: ExemptType;
  targetKey: string;
  messages: string[];
  timezone: string | null;
  dueAt: Date;
  after?: AfterSend;
}): Promise<{ queued: boolean; id?: number; reason?: string }> {
  const ins = await pool.query(
    `INSERT INTO deferred_sends (user_id, phone_number, type, target_key, messages, timezone, after_kind, after_payload, due_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)
     ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`,
    [o.userId, o.phoneNumber, o.type, o.targetKey, JSON.stringify(o.messages), o.timezone, o.after?.kind ?? null, o.after ? JSON.stringify(o.after.payload) : null, o.dueAt],
  );
  if (ins.rows[0]) {
    await recordDecision({ layer: 7, decision: "proactive.deferredSend", userId: o.userId, outcome: "act", action: "queued", proposal: { type: o.type, targetKey: o.targetKey, dueAt: o.dueAt.toISOString() } }).catch(() => {});
    return { queued: true, id: Number(ins.rows[0].id) };
  }
  const { rows } = await pool.query(`SELECT id, status FROM deferred_sends WHERE user_id = $1 AND target_key = $2`, [o.userId, o.targetKey]);
  const status = rows[0]?.status;
  if (status === "queued" || status === "sending") return { queued: true, id: Number(rows[0].id) };
  return { queued: false, reason: status === "sent" ? "already sent" : `already ${status ?? "handled"}` };
}

// What a send result means for the record. "already sent" from the cron is our own earlier attempt (same target key).
export function outcomeOf(r: { sent: boolean; reason?: string }, alreadyCounts: boolean): SendOutcome | "retry_hours" | "retry_paused" {
  if (r.sent || (alreadyCounts && r.reason === "already sent")) return "sent";
  if (r.reason === "outside local hours") return "retry_hours";
  if (r.reason === "proactive outreach is paused") return "retry_paused";
  if (r.reason === "opted out" || r.reason === "already sent" || r.reason === "archived" || r.reason === "event over") return "skipped";
  return "failed";
}

// What a send changes in the record, by kind. Run once the outcome is known: on "sent" it writes what Co did; on
// "skipped"/"failed" it records that it didn't. Each handler is idempotent (a row re-claimed after a crash may run it twice).
export type AfterHandlers = Record<AfterKind, (payload: any, outcome: SendOutcome) => Promise<void>>;

export const afterHandlers: AfterHandlers = {
  relay: async (p, outcome) => (await import("./relay.js")).relayDelivered(Number(p.relayId), outcome),
  reminder: async (p, outcome) => (await import("./relay.js")).reminderDelivered(Number(p.reminderId), outcome),
  network_intro_ask: async (p, outcome) => {
    if (outcome === "sent") await (await import("./networkIntroNudge.js")).afterDirectAskSent(p as any);
    else await noteIntroAskNotSent(p);
  },
  event_direct_ask: async (p, outcome) => {
    if (outcome === "sent") await (await import("./eventGuestMatchHandoff.js")).afterDirectAskSent(p as any);
    else await noteIntroAskNotSent(p);
  },
  call_confirm: async (p, outcome) => {
    await (await import("./callFollowThrough.js")).afterConfirmSent(p as any, outcome);
  },
};

// Whether an event has ended by `now` (its end, or the end of that evening when Luma has none: introConsent.effectiveEnd).
export async function eventIsOver(eventId: string, now: Date): Promise<boolean> {
  if (!eventId) return false;
  const { getEventDetails } = await import("./luma.js");
  const { effectiveEnd } = await import("../harness/introConsent.js");
  const d = await getEventDetails(eventId).catch(() => null);
  if (!d?.start_at) return false;
  return new Date(effectiveEnd({ start_at: d.start_at, end_at: d.end_at ?? null, timezone: (d as any).timezone ?? null })).getTime() <= now.getTime();
}

// The person who asked for the intro was told "I'll ask them". When that ask never went out, it's written on THEIR side so Co can
// say plainly that it didn't happen. Never why: the other person's opt-out or absence is theirs, not the asker's (no cross-member
// leaks).
export async function noteIntroAskNotSent(p: { askerId?: string; candidateId?: string }): Promise<void> {
  if (!p?.askerId || !p?.candidateId) return;
  const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [p.candidateId]).catch(() => ({ rows: [] as any[] }));
  const name = String(rows[0]?.first_name ?? "").trim() || "them";
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)`, [
      p.askerId,
      `The intro ask Co said it would send ${name} didn't go out, so that intro isn't happening this time. If they ask, say so plainly, without any reason.`,
    ])
    .catch((err: any) => console.error("deferredSends: noting an unsent intro ask failed (non-fatal):", err?.message ?? err));
}

export async function runAfter(after: AfterSend | null | undefined, outcome: SendOutcome, handlers: AfterHandlers = afterHandlers): Promise<void> {
  if (!after) return;
  const h = handlers[after.kind];
  if (!h) return;
  await h(after.payload ?? {}, outcome).catch((err: any) => console.error(`deferredSends: after-send (${after.kind}) failed (non-fatal):`, err?.message ?? err));
}

export type DeferredDeps = {
  send: typeof sendExempt;
  handlers: AfterHandlers;
};

// The minute cron: send what's due. Returns what happened to each claimed row.
export async function runDueDeferredSends(now: Date = new Date(), deps: DeferredDeps = { send: sendExempt, handlers: afterHandlers }): Promise<{ claimed: number; sent: number; requeued: number; skipped: number; failed: number }> {
  const out = { claimed: 0, sent: 0, requeued: 0, skipped: 0, failed: 0 };
  const { rows } = await pool.query(
    `SELECT d.id, d.user_id, COALESCE(u.phone_number, d.phone_number) AS phone_number, d.type, d.target_key, d.messages, d.timezone,
            d.after_kind, d.after_payload, d.due_at, d.status, d.attempts, d.created_at, (u.archived_at IS NOT NULL) AS archived
     FROM deferred_sends d JOIN users u ON u.id = d.user_id
     WHERE (d.status = 'queued' AND d.due_at <= $1) OR (d.status = 'sending' AND d.claimed_at < $2)
     ORDER BY d.due_at LIMIT ${DEFERRED_LIMITS.perRun}`,
    [now, new Date(now.getTime() - DEFERRED_LIMITS.staleClaimMs)],
  );
  for (const row of rows as DeferredRow[]) {
    // The claim: only one caller moves attempts from the value it read.
    const claim = await pool.query(
      `UPDATE deferred_sends SET status = 'sending', claimed_at = $3, attempts = attempts + 1
       WHERE id = $1 AND attempts = $2 AND status IN ('queued', 'sending') RETURNING id`,
      [row.id, row.attempts, now],
    );
    if (!claim.rows[0]) continue;
    out.claimed++;
    const attempts = row.attempts + 1;
    const after: AfterSend | null = row.after_kind ? { kind: row.after_kind, payload: row.after_payload ?? {} } : null;
    const raw: string[] = Array.isArray(row.messages) ? row.messages : JSON.parse(String(row.messages));
    // Held, so no longer seconds old: a "Got it" written when it was queued would read like Co only just heard (services/speakable.ts).
    const queuedAt = row.created_at ? new Date(row.created_at) : null;
    const messages = queuedAt ? raw.map((m, i) => (i === 0 ? dropStaleAck(m, { askedAt: queuedAt, sendAt: now }) : m)) : raw;
    const finish = (status: string, error: string | null, sentAt: Date | null) =>
      pool.query(`UPDATE deferred_sends SET status = $2, error = $3, sent_at = $4 WHERE id = $1 AND attempts = $5`, [row.id, status, error, sentAt, attempts]);
    const requeue = (dueAt: Date, error: string | null) =>
      pool.query(`UPDATE deferred_sends SET status = 'queued', due_at = $2, error = $3 WHERE id = $1 AND attempts = $4`, [row.id, dueAt, error, attempts]);

    let result: { sent: boolean; reason?: string };
    if (row.archived) result = { sent: false, reason: "archived" };
    // An in-room intro ask held overnight is pointless once the event is over: dropped, never sent the next morning.
    else if (row.after_kind === "event_direct_ask" && (await eventIsOver(String((row.after_payload as any)?.eventId ?? ""), now))) result = { sent: false, reason: "event over" };
    else if (!localHourOk(now, row.timezone)) result = { sent: false, reason: "outside local hours" };
    else {
      result = await deps
        .send({ userId: row.user_id, phoneNumber: row.phone_number, type: row.type, targetKey: row.target_key, messages, timezone: row.timezone, respectHours: true, now })
        .catch((err: any) => ({ sent: false, reason: `error: ${String(err?.message ?? err)}` }));
    }
    const o = outcomeOf(result, true);
    if (o === "retry_hours") {
      await requeue(nextLocalHour(now, row.timezone, RULES.startHour), null);
      out.requeued++;
      continue;
    }
    if (o === "retry_paused") {
      await requeue(new Date(now.getTime() + DEFERRED_LIMITS.retryAfterMs), result.reason ?? null);
      out.requeued++;
      continue;
    }
    if (o === "failed" && attempts < DEFERRED_LIMITS.maxAttempts) {
      await requeue(new Date(now.getTime() + DEFERRED_LIMITS.retryAfterMs), result.reason ?? "send failed");
      out.requeued++;
      continue;
    }
    await finish(o, o === "sent" ? null : (result.reason ?? null), o === "sent" ? now : null);
    out[o]++;
    await runAfter(after, o, deps.handlers);
    await recordDecision({ layer: 7, decision: "proactive.deferredSend", userId: row.user_id, outcome: o === "sent" ? "act" : "skip", action: o, reason: o === "sent" ? undefined : result.reason, proposal: { type: row.type, targetKey: row.target_key, attempts } }).catch(() => {});
  }
  return out;
}

// Whether a send for this key is waiting (queued or mid-send). Readers use it to say "queued", never "sent".
export async function isQueued(userId: string, targetKey: string): Promise<boolean> {
  const { rows } = await pool
    .query(`SELECT 1 FROM deferred_sends WHERE user_id = $1 AND target_key = $2 AND status IN ('queued', 'sending')`, [userId, targetKey])
    .catch(() => ({ rows: [] as any[] }));
  return rows.length > 0;
}

// Whether any send of this kind (by key prefix, e.g. "direct_ask:") is waiting for them.
export async function hasQueuedWithPrefix(userId: string, prefix: string): Promise<boolean> {
  const { rows } = await pool
    .query(`SELECT 1 FROM deferred_sends WHERE user_id = $1 AND starts_with(target_key, $2) AND status IN ('queued', 'sending') LIMIT 1`, [userId, prefix])
    .catch(() => ({ rows: [] as any[] }));
  return rows.length > 0;
}
