// Does a queued check-in belong now (Royce, 2026-11-07). Asked by the dispatch (harness/proactive.ts) after the draft passes its checks,
// beside the free send-time recheck (harness/sendTimeRecheck.ts), which stays model-free.
import { recordDecision } from "./core.js";
import type { SendClass } from "./notifyGate.js";
import { SEND_RECHECK } from "./sendTimeRecheck.js";
import { notToTeammate } from "../services/teamLines.js";

const HOUR = 3_600_000;
// ---------------------------------------------------------------- does it belong now (Royce, 2026-11-07)
// A queued check-in is judged against what they just talked about, right before it goes: the one model read here (the reads above stay
// free). 2026-11-07: a milestone queued 11-02 went six days later, five minutes after a call on a different, weighty topic, and opened an
// unrelated old thread. Being queued is not a reason to send, and silence is a valid outcome. The model decides send, wait or drop with
// one line of why; code guards the answer:
//   - a failed read, or context that couldn't be read, is wait: never send (and never counted as a wait it chose);
//   - wait re-queues it MOMENT_FIT.waitHours later, with the reason, keeping its draft (re-judged first next time, drafted fresh only on
//     send); a check-in that has waited MOMENT_FIT.maxWaits times, or couldn't be read MOMENT_FIT.maxUnread times, is dropped with the
//     reason, so waiting is never endless; it also still expires on its own;
//   - drop closes it with the reason;
//   - only OPTIONAL check-ins are read. What they asked to receive (SendClass "requested": a reminder they set, a promise's delivery,
//     a post-call text, a deadline or commitment nudge), the follow-up on their own dated commitment, a check-in on an ask of theirs,
//     a reply and a safety follow-up never come through here: they keep their own timing (a reminder late is useless);
//   - the latest call is always in view (its summary, or its last turns, with when). A call that just ended whose summary isn't
//     written yet, or one going on, means wait a few minutes (CALL_CONTEXT): never judged as if that call never happened.
// Every verdict is a decision row (proactive.sendRecheck, action moment_<verdict>), so it shows in the dev review.
// maxWaits: the read's own waits before an optional check-in is let go; maxUnread: reads that failed or had no context to read (a model
// outage, a call's summary that never came), after which it is let go too, with the reason recorded. A check-in is read at most
// maxWaits + 1 times with an answer (twice more when a kept draft said send and the fresh draft differs), plus maxUnread failed or
// no-context reads (a no-context wait spends no model call); a wait for a call spends none and counts toward neither.
export const MOMENT_FIT = { waitHours: 3, maxWaits: 2, maxUnread: 6, timeoutMs: 10_000 } as const;
// The latest call: a summary not yet written this long after its transcript was stored means the context isn't ready (the summary is
// written seconds after, routes/co.ts); a call placed or going on holds the read; while not ready it looks again in retryMinutes.
// lastTurns: how much of a call with no summary (an older one whose summary failed) is shown.
export const CALL_CONTEXT = { summaryWaitMinutes: 30, liveCallHours: 2, retryMinutes: 10, lastTurns: 6 } as const;
export type MomentVerdict = { verdict: "send" | "wait" | "drop"; why: string; read: "model" | "failed" | "no_context" | "call_not_ready" };

// Pure: which sends the moment read covers: Cue's optional check-ins only.
export function momentFitApplies(cls: SendClass, payload: unknown, o: { pulled?: boolean; type?: string } = {}): boolean {
  const p = (payload ?? {}) as { safetyFollowUp?: boolean; kind?: string };
  if (cls !== "checkin" || p.safetyFollowUp === true || o.pulled) return false;
  // Obligations, never optional: the follow-up on their own dated commitment, and a check-in on something they asked Cue for.
  if (o.type === "window_followup" && p.kind === "commitment") return false;
  if (o.type === "ask_checkin") return false;
  return true;
}

// The latest call as it stands (loadCallContext): its status on the member row, its stored transcript, its summary for texts.
// Call statuses that are over (routes/co.ts, services/callTrigger.ts); every other one is a call placed, ringing, on, or being processed.
// Twilio's own terminal statuses are listed too (its status callback forwards only its early ones, but a stray one is never "live").
export const FINISHED_CALL: ReadonlySet<string> = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);
export type CallContextRead = { status: string | null; statusAt: Date | null; transcript: { at: Date; text: string } | null; summary: { at: Date; text: string } | null };
// Pure: the latest call for the read, or why it isn't ready. stamp: when, in their zone.
export function callContextFor(r: CallContextRead, now: Date, stamp: (d: Date) => string): { ready: true; line: string | null } | { ready: false; why: string } {
  const ago = (d: Date | null) => (d ? now.getTime() - d.getTime() : Infinity);
  // Live: any status but a finished one (Twilio's ringing / in-progress, the dial's dialing / initiated, an inbound call's initiated, the
  // post-call pipeline's processing), within liveCallHours (a status never cleared stops holding after that).
  if (r.status && !FINISHED_CALL.has(r.status) && ago(r.statusAt) < CALL_CONTEXT.liveCallHours * HOUR) return { ready: false, why: "a call with them is going on or was just placed" };
  const summaryCurrent = !!r.summary && (!r.transcript || r.summary.at.getTime() >= r.transcript.at.getTime());
  if (r.transcript && !summaryCurrent) {
    if (ago(r.transcript.at) < CALL_CONTEXT.summaryWaitMinutes * 60_000) return { ready: false, why: "the call that just ended isn't summarized yet" };
    const turns = r.transcript.text.split("\n").filter((l) => /^\s*(user|assistant)\s*:/i.test(l)).slice(-CALL_CONTEXT.lastTurns).map((l) => l.replace(/^\s*user\s*:/i, "Them:").replace(/^\s*assistant\s*:/i, "Cue:").trim().slice(0, 240));
    return { ready: true, line: turns.length ? `[${stamp(r.transcript.at)}] The call's last turns:\n${turns.join("\n")}` : null };
  }
  // A completed call with no transcript stored yet (the post-call pipeline still running).
  if (r.status === "completed" && ago(r.statusAt) < CALL_CONTEXT.summaryWaitMinutes * 60_000 && (!r.transcript || r.transcript.at.getTime() < (r.statusAt?.getTime() ?? 0) - CALL_CONTEXT.liveCallHours * HOUR) && !summaryCurrent) return { ready: false, why: "the call that just ended isn't stored yet" };
  return { ready: true, line: r.summary ? `[${stamp(r.summary.at)}] ${r.summary.text.slice(0, 900)}` : null };
}
// The one read of the latest call (three rows), only for a check-in the moment read covers. A failed read: not ready (wait).
export async function loadCallContext(userId: string): Promise<CallContextRead> {
  const { default: pool } = await import("../db/db.js");
  const { rows } = await pool.query(
    `SELECT u.call_status, CASE WHEN u.call_status = 'processing' THEN GREATEST(u.call_status_updated_at, u.updated_at) ELSE u.call_status_updated_at END AS call_status_updated_at,
       (SELECT jsonb_build_object('at', m.created_at, 'text', m.content) FROM co_memories m WHERE m.user_id = u.id AND m.memory_type = 'call_transcript' ORDER BY m.created_at DESC LIMIT 1) AS transcript,
       (SELECT jsonb_build_object('at', m.created_at, 'text', m.content) FROM co_memories m WHERE m.user_id = u.id AND m.memory_type = 'text_exchange' AND m.content LIKE '[Call] %' ORDER BY m.created_at DESC LIMIT 1) AS summary
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw new Error("no member row");
  const row = (j: any) => (j && j.at ? { at: new Date(j.at), text: String(j.text ?? "") } : null);
  return { status: r.call_status ?? null, statusAt: r.call_status_updated_at ? new Date(r.call_status_updated_at) : null, transcript: row(r.transcript), summary: row(r.summary) };
}

export function momentPrompt(o: { firstName: string; message: string; recent: string; call?: string | null; queuedAt: Date; now: Date }): string {
  const days = Math.max(0, Math.round((o.now.getTime() - o.queuedAt.getTime()) / 86_400_000));
  return `Cue is about to text ${o.firstName || "a member"} on its own, unprompted. Decide whether this text belongs right now.

The text:
"${o.message.slice(0, 900)}"

It was queued ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}.

Their latest call with Cue:
${o.call?.trim() || "(none)"}

Their latest texts with Cue, oldest first, with when:
${o.recent.trim() || "(nothing yet)"}

Weigh: is what it's about still open; did something more important just happen; was it already answered or covered; what does it add now. Being queued is not a reason to send, and sending nothing is a fine outcome.
send: it fits now. wait: it could fit later, once this moment has passed. drop: it no longer fits.

Return ONLY JSON: {"verdict": "send" | "wait" | "drop", "why": "one short line"}`;
}
// Pure: the read's answer. Null: no usable answer.
export function parseMoment(text: string): { verdict: "send" | "wait" | "drop"; why: string } | null {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (j?.verdict !== "send" && j?.verdict !== "wait" && j?.verdict !== "drop") return null;
    return { verdict: j.verdict, why: String(j.why ?? "").replace(/\s+/g, " ").trim().slice(0, 200) };
  } catch {
    return null;
  }
}
let momentModel: ((prompt: string) => Promise<string>) | null = null;
export function setMomentModelForTests(f: ((prompt: string) => Promise<string>) | null): void {
  momentModel = f;
}
// The read. recent: the dispatch's own stamped exchange (the context the draft was written from), or null when it couldn't be read.
// call: the latest call (callContextFor over loadCallContext), or null when it couldn't be read.
export async function momentFit(o: { userId: string; firstName: string; message: string; recent: string | null; call: ReturnType<typeof callContextFor> | null; queuedAt: Date; now: Date }): Promise<MomentVerdict> {
  if (o.recent === null || o.call === null) return { verdict: "wait", why: "their latest texts and calls couldn't be read, so this waits", read: "no_context" };
  if (!o.call.ready) return { verdict: "wait", why: `${o.call.why}, so this waits for it`, read: "call_not_ready" };
  const gen = momentModel ?? (async (p: string) => {
    const [{ generateText }, { anthropic }, { MODELS }, { withMember }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js"), import("../services/llmUsage.js")]);
    return withMember(o.userId, () => generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 150, abortSignal: AbortSignal.timeout(MOMENT_FIT.timeoutMs), experimental_telemetry: { isEnabled: true, functionId: "sendRecheck.momentFit" }, prompt: p })).then((r) => r.text);
  });
  const answer = parseMoment(await gen(momentPrompt({ ...o, recent: o.recent, call: o.call.line })).catch(() => ""));
  return answer ? { ...answer, read: "model" } : { verdict: "wait", why: "the read of whether it fits now didn't answer, so this waits", read: "failed" };
}
// Pure: what code does with the verdict. waits: how many times the read already chose wait for it.
// counted: which cap the wait counts toward (null: none; a wait through a call is never read trouble and never drops it: a call is
// bounded by liveCallHours and its summary by summaryWaitMinutes, then it is judged). gaveUp: dropped because a cap was reached (the
// monitor's moment_read_trouble signal).
export type MomentAction = { act: "send" } | { act: "wait"; retryAt: Date; why: string; counted: "wait" | "unread" | null } | { act: "drop"; why: string; gaveUp?: "waits" | "unread" };
export function momentAction(v: MomentVerdict, c: { waits: number; unread?: number }, now: Date): MomentAction {
  // Waiting for a call (on, or just ended and not summarized): minutes, counted toward nothing.
  if (v.read === "call_not_ready") return { act: "wait", retryAt: new Date(now.getTime() + CALL_CONTEXT.retryMinutes * 60_000), why: v.why, counted: null };
  if (v.read !== "model") {
    if ((c.unread ?? 0) >= MOMENT_FIT.maxUnread) return { act: "drop", why: `couldn't judge whether it fits after ${c.unread} tries: ${v.why}`, gaveUp: "unread" };
    return { act: "wait", retryAt: new Date(now.getTime() + MOMENT_FIT.waitHours * HOUR), why: v.why, counted: "unread" };
  }
  if (v.verdict === "send") return { act: "send" };
  if (v.verdict === "drop") return { act: "drop", why: v.why };
  if (c.waits >= MOMENT_FIT.maxWaits) return { act: "drop", why: `waited ${c.waits} times and still doesn't fit: ${v.why}`, gaveUp: "waits" };
  return { act: "wait", retryAt: new Date(now.getTime() + MOMENT_FIT.waitHours * HOUR), why: v.why, counted: "wait" };
}
export function momentDecision(o: { userId: string; candidateId: string; kind: string; targetKey: string; v: MomentVerdict; action: MomentAction; waits: number; unread?: number }): Parameters<typeof recordDecision>[0] {
  return {
    layer: 7,
    decision: SEND_RECHECK,
    userId: o.userId,
    outcome: o.action.act === "send" ? "act" : "skip",
    action: `moment_${o.action.act}`,
    reason: o.v.why.slice(0, 300),
    proposal: { kind: o.kind, targetKey: o.targetKey, candidate: o.candidateId, verdict: o.v.verdict, read: o.v.read, waits: o.waits, unread: o.unread ?? 0, ...(o.action.act === "wait" ? { retryAt: o.action.retryAt.toISOString() } : {}), ...(o.action.act === "drop" && o.action.gaveUp ? { gaveUp: o.action.gaveUp } : {}) },
  };
}
// The one read the send lock asks after the judgment (harness/proactive.ts sendWithLedger): did anything of theirs arrive since (a text,
// a call, a correction)? Then the judged text is stale: it isn't sent, and the next pick judges it again.
export const NEWER_SINCE_SQL = `SELECT 1 FROM co_memories WHERE user_id = $1 AND created_at > $2 AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}))
  UNION ALL SELECT 1 FROM profile_corrections WHERE user_id = $1 AND corrected_at > $2 LIMIT 1`;
// Whether nothing of theirs arrived since `at` (the context read's database time). A failed read: not current (it waits).
export async function momentStillCurrent(db: { query: (sql: string, args: unknown[]) => Promise<{ rows: unknown[] }> }, userId: string, at: Date): Promise<boolean> {
  return db.query(NEWER_SINCE_SQL, [userId, at]).then((r) => r.rows.length === 0).catch(() => false);
}
// Pure: the same text, whitespace aside.
export const sameDraft = (a: string | null, b: string): boolean => !!a && a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
