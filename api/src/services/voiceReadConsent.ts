// The member's own yes to the voice read on calls (services/voiceRead.ts), kept as a fact (Royce, 2026-10-28): "members need a
// clear opt-in and an easy way to withdraw. A database switch isn't consent. Check permission for anyone already enabled too;
// knowing about it isn't automatically agreeing to it. Withdrawal should stop future analysis immediately."
//
// - Consent is their own words, quoted, with the time (voice_read_consents.yes_quote, answered_at), given after Cue told them
//   what the read is and what it keeps (VOICE_READ_ASK). users.voice_read_ok, the hand-set flag, is never read: the one member
//   who had it is off until he says yes through this flow.
// - Cue asks once, ever (voiceReadAskDue): after their first call, through the proactive queue (its quiet hours, caps and
//   spacing, and the hard-day and safety holds, which delay it and never drop it), or in a reply when they ask about it by text.
//   It counts as asked only once the question has actually gone to them (the queue's onSent, or the reply that carried it). A no,
//   or no answer, means off, and Cue never asks again on its own.
// - Never a yes on a call: there Cue says it will text the question (VOICE_READ_CALL_LINE), the question goes by text through the
//   same queue, and only a yes by text after it counts.
// - Withdrawal, in their own words, read by the model through the voiceRead tool (agent/conversationTools.ts), never a regex: the
//   yes is marked taken back at once, any live read of theirs ends (this call included), the read is refused at the next stream
//   and after the call, and what it noted (emotion_signals rows with basis "voice", and the call.voice_read read logs) is deleted.
//   A post-call insert racing the stop can't land (keepVoiceIfStillOn and recordEmotionSignals' guard). Their yes's words go too; the
//   times stay, as the fingerprint (forget by default: removed means the raw rows are deleted).
// - It shows in what Cue knows (ref grant:voice_read) while it's on, where removing it is the same withdrawal.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { voiceReadAllowed, voiceReadState, voiceReadTextDue, type VoiceReadConsent, type VoiceReadState } from "./voiceRead.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
// Tests only (evals/review/voiceReadConsent.ts): the database and the queue the reply tool's calls use, so a turn runs against fakes.
let testDb: Db | null = null;
let testEnqueue: ((input: import("../harness/proactive.js").EnqueueInput) => Promise<{ queued: boolean }>) | null = null;
export function setVoiceReadDepsForTests(d: { db?: Db | null; enqueue?: typeof testEnqueue } | null): void {
  testDb = d?.db ?? null;
  testEnqueue = d?.enqueue ?? null;
}
const dbOr = (): Db => testDb ?? pool;

// ---------------------------------------------------------------- the words (Copy: Royce approves each before it ships)

// The one question, approved by Royce 2026-10-28 word for word. What it is, what it keeps and for how long, who hears it, that it's
// off unless they say yes, and that they can stop it. Facts behind it: Hume Expression Measurement hears the caller's side live
// (zero data retention, Hume told us, 2026-10-21); Cue never stores audio; after a call a few moments are kept in emotion_signals
// (a feeling's label and the words they were saying then), which nothing expires, so "until you ask me to drop them" is the true
// length.
export const VOICE_READ_ASK =
  "One thing about our calls. If you'd like, I can listen to how you sound while we talk, not just your words, so I notice when something sits heavier than you let on. Your side of the call goes to Hume, a service that reads tone as it happens and has told us it keeps none of it. I don't keep the audio either, just a few short notes on moments that stood out, until you ask me to drop them. It's off unless you say yes, and you can tell me to stop anytime. Want me to?";
// The send's own checks (harness/proactive.ts checkDraft), as the queue runs them.
export const VOICE_READ_ASK_RULES = { maxChars: 600, maxSentences: 7, allowGreeting: false, mustIncludeAny: ["stop anytime"] };
// On a call, when they bring it up or say yes there: no yes is taken on a call; the question goes by text (Copy: pending Royce).
export const VOICE_READ_CALL_LINE = "I'll text you how it works, and you can answer there.";
// Model-facing only, never said to them: after a stop or a no on a call, the rest of that call uses no voice notes.
export const VOICE_READ_OFF_ON_CALL_NOTE = "For the rest of this call, don't use or mention anything in your context about how they sounded on calls (voice notes); treat it as gone.";
// Model-facing only, in a call's starting context while the read is on for them. With the call brain endpoint (routes/callLlm.ts) the
// voiceRead tool stops it; on the direct path (no endpoint, voice-only, or tools off) Cue has no tool on the call and can't stop it
// there, so it must not say it did: a text saying stop turns it off at once.
export const VOICE_READ_CALL_RULE = "How they sound on calls is being read on this call (they said yes to it). If they ask you to stop listening to how they sound, only your voiceRead tool stops it. If you don't have that tool, don't say it's stopped or that you'll stop: tell them a text saying stop turns it off right away.";
// The call's starting context line that carries the last call's moments (harness/emotion.ts renderEmotionalContext), voice-read
// moments among them. After a stop or a no on a call it is taken out of every later turn's messages (stripVoiceReadLines).
const LAST_CALL_MOMENTS_LINE = /^[ \t]*On your call [^\n]*?, their voice showed: [^\n]*(\r?\n|$)/gm;
// Pure: the call's messages with the last call's moments and the voice-read rule taken out (strings and text parts alike).
export function stripVoiceReadLines<M extends { role: string; content?: unknown }>(messages: M[]): M[] {
  const clean = (t: string) => t.replace(LAST_CALL_MOMENTS_LINE, "").split(VOICE_READ_CALL_RULE).join("");
  return messages.map((m) => {
    if (typeof m.content === "string") return { ...m, content: clean(m.content) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map((part: any) => (part && typeof part.text === "string" ? { ...part, text: clean(part.text) } : part)) };
    return m;
  });
}
// After their yes.
export const VOICE_READ_YES_LINE = "Thank you. It starts on our next call, and you can tell me to stop anytime.";
// After "stop": the one confirming line. True whether or not anything had been noted yet.
export const VOICE_READ_STOP_LINE = "Done. I won't listen to how you sound on our calls anymore, and anything I noted from it is deleted.";
// Their what-Cue-knows line while it's on.
export const voiceReadKnownLine = (since: string) =>
  `how you sound on our calls, since you said yes on ${since}: a few short notes on moments that stood out, never the audio`;

// ---------------------------------------------------------------- reads

const at = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
export function consentFromRow(r: any): VoiceReadConsent | null {
  if (!r) return null;
  return { askedAt: at(r.asked_at), answer: r.answer === "yes" || r.answer === "no" ? r.answer : null, answeredAt: at(r.answered_at), withdrawnAt: at(r.withdrawn_at) };
}

export async function readVoiceReadConsent(userId: string, db: Db = dbOr()): Promise<VoiceReadConsent | null> {
  const { rows } = await db.query(`SELECT asked_at, answer, answered_at, withdrawn_at FROM voice_read_consents WHERE user_id = $1`, [userId]);
  return consentFromRow(rows[0]);
}

// May the read run for them right now? Read fresh every time it's asked (the call's start, the stream's start, after the call),
// so a withdrawal counts from the moment it's recorded. Fails closed.
export async function voiceReadOnFor(userId: string, db: Db = dbOr(), env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const [{ rows: u }, consent] = await Promise.all([db.query(`SELECT phone_number FROM users WHERE id = $1`, [userId]), readVoiceReadConsent(userId, db)]);
    if (!u[0]) return false;
    return voiceReadAllowed({ memberPhone: u[0].phone_number, consent }, env);
  } catch {
    return false;
  }
}

// The what-Cue-knows view: the day they said yes, while it's on.
export async function voiceReadOnSince(userId: string, db: Db = dbOr()): Promise<{ since: string } | null> {
  const { rows } = await db.query(`SELECT asked_at, answer, answered_at, withdrawn_at FROM voice_read_consents WHERE user_id = $1`, [userId]);
  const c = consentFromRow(rows[0]);
  if (voiceReadState(c) !== "yes" || !c?.answeredAt) return null;
  return { since: c.answeredAt.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------- writes

// The question went to them (or its words went in a reply when they asked about it).
export async function noteVoiceReadAsked(userId: string, db: Db = dbOr()): Promise<void> {
  await db.query(
    `INSERT INTO voice_read_consents (user_id, asked_at) VALUES ($1, NOW())
     ON CONFLICT (user_id) DO UPDATE SET asked_at = COALESCE(voice_read_consents.asked_at, NOW()), updated_at = NOW()`,
    [userId],
  );
}

export type YesResult = { ok: true } | { ok: false; why: "not_asked" };
// Their yes, in their words. Only after they've had the question: a yes to something never explained isn't consent.
// receivedAt: when their message arrived. A yes already on its way before the question went (asked_at after it) isn't an answer to it.
export async function recordVoiceReadYes(userId: string, quote: string, db: Db = dbOr(), receivedAt: Date = new Date()): Promise<YesResult> {
  const r = await db.query(
    `UPDATE voice_read_consents SET answer = 'yes', answered_at = NOW(), yes_quote = $2, withdrawn_at = NULL, updated_at = NOW()
     WHERE user_id = $1 AND asked_at IS NOT NULL AND asked_at <= $3`,
    [userId, quote.slice(0, 200), receivedAt],
  );
  if (!r.rowCount) return { ok: false, why: "not_asked" };
  await recordDecision({ layer: 6, decision: "voice_read.consent", userId, outcome: "act", action: "yes" }).catch(() => {});
  return { ok: true };
}

// Every voice-read result of theirs: the moments kept after calls (emotion_signals, basis "voice"). Deleted, not hidden.
export async function forgetVoiceReadResults(userId: string, db: Db = dbOr()): Promise<number> {
  const r = await db.query(`DELETE FROM emotion_signals WHERE user_id = $1 AND basis = 'voice'`, [userId]);
  return r.rowCount ?? 0;
}

export type StopDeps = { endLive?: (userId: string) => number | Promise<number>; forgetTrace?: (userId: string, why: string) => Promise<number> };
const forgetTraceDefault = async (userId: string, why: string) => (await import("./llmTraceText.js")).forgetTraceText(userId, why);
const endLiveReads = async (userId: string) => (await import("./mediaStreamBridge.js")).endVoiceSessionsFor(userId);

// A no (to the question) or a stop (taking a yes back): off from now, never asked again, live reads ended, results deleted.
// A no without a yes on file is stored as a no; a stop of a yes keeps the yes's time and drops its words.
export async function turnVoiceReadOff(userId: string, kind: "no" | "stop", db: Db = dbOr(), d: StopDeps = {}): Promise<{ was: VoiceReadState; deleted: number; endedLive: number }> {
  const was = voiceReadState(await readVoiceReadConsent(userId, db));
  if (was === "yes") {
    await db.query(`UPDATE voice_read_consents SET withdrawn_at = NOW(), yes_quote = NULL, updated_at = NOW() WHERE user_id = $1`, [userId]);
  } else if (was !== "no" && was !== "withdrawn") {
    await db.query(
      `INSERT INTO voice_read_consents (user_id, answer, answered_at) VALUES ($1, 'no', NOW())
       ON CONFLICT (user_id) DO UPDATE SET answer = 'no', answered_at = NOW(), yes_quote = NULL, updated_at = NOW()`,
      [userId],
    );
  }
  const endedLive = await Promise.resolve((d.endLive ?? endLiveReads)(userId)).catch(() => 0);
  const deleted = await forgetVoiceReadResults(userId, db);
  // Each call's read log (mediaStreamBridge.ts call.voice_read: per-feeling counts and timings) goes too.
  await db.query(`DELETE FROM harness_decisions WHERE user_id = $1 AND decision = 'call.voice_read'`, [userId]).catch(() => {});
  // And our own copy of their model calls' text (services/llmTraceText.ts, 14 days): prompts that carried voice moments, and the
  // voiceRead tool call with their words. The same forget the what-Cue-knows removal runs (whatCoKnows.ts). Later reply prompts read
  // voice moments only from emotion_signals (harness/emotion.ts getEmotionalContext, read fresh each turn), deleted above.
  await (d.forgetTrace ?? forgetTraceDefault)(userId, "voice read off").catch(() => 0);
  // The fingerprint: what changed and how many rows went, never their words.
  await recordDecision({ layer: 6, decision: "voice_read.consent", userId, outcome: "act", action: kind === "stop" ? "withdrawn" : "no", proposal: { was, deleted, endedLive } }).catch(() => {});
  return { was, deleted, endedLive };
}

// After a call (routes/co.ts), just before its moments are written: read again, so a stop that landed while the call's feelings were
// being read keeps nothing of the voice (the insert's own guard, harness/emotion.ts recordEmotionSignals, covers the last instant).
export async function keepVoiceIfStillOn<T>(userId: string, voiced: T[], db: Db = dbOr(), env: NodeJS.ProcessEnv = process.env): Promise<T[]> {
  if (!voiced.length) return voiced;
  return (await voiceReadOnFor(userId, db, env)) ? voiced : [];
}

// ---------------------------------------------------------------- the question

// The one question, by text, through the proactive queue (proactiveRegistry.ts voice_read_ask), which reads the state again before it
// goes. After a call ends (routes/co.ts): queued once per member ever (its own target key), only when nothing is on file. When they
// ask on a call (theyAsked; no yes is taken there): queued for soon after, under that day's key, also only when nothing is on file.
// Either way it goes once: whichever sends first, the other's draft sees it on file and skips.
// True when the question will go (queued now, or already waiting under that key); false when it won't (already sent, or not due).
export async function queueVoiceReadAsk(
  userId: string,
  d: { db?: Db; env?: NodeJS.ProcessEnv; now?: Date; theyAsked?: boolean; enqueue?: (input: import("../harness/proactive.js").EnqueueInput) => Promise<{ queued: boolean }> } = {},
): Promise<boolean> {
  const env = d.env ?? process.env;
  const theyAsked = !!d.theyAsked;
  if (!voiceReadTextDue(await readVoiceReadConsent(userId, d.db ?? dbOr()), theyAsked, env)) return false;
  const enqueue = d.enqueue ?? testEnqueue ?? (await import("../harness/proactive.js")).enqueueCandidate;
  const now = d.now ?? new Date();
  const r = await enqueue({
    userId,
    type: "voice_read_ask",
    targetKey: theyAsked ? `voice_read_ask:asked:${now.toISOString().slice(0, 10)}` : "voice_read_ask",
    topicKey: "voice_read_ask",
    summary: theyAsked ? "They asked on a call: the voice read's question, by text, so they can answer there" : "After their first call: ask once whether Cue may listen to how they sound on calls",
    payload: theyAsked ? { theyAsked: true } : {},
    // Not on top of the call's own follow-up; their own ask goes soon after the call.
    dueAt: new Date(now.getTime() + (theyAsked ? 10 * 60_000 : 2 * 3600_000)),
    expiresAt: null,
  });
  return r.queued;
}
