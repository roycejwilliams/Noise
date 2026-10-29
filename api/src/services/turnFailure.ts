import { FAILURE_NOT_ON_RECORD, FAILURE_ON_RECORD } from "./callReasons.js";

// Never go silent (Royce, 2026-09-23). Co marks a text read the moment it
// arrives, so when a turn then crashes (Claude down, a database error, a
// search blowing up, a restart mid-turn), the member sees "Read" and nothing
// else. Instinct's Sep 21-22 outage did exactly this and a user called it
// "worse than an error message". This is the one honest line Co sends
// instead. It owns the miss without asking them to redo anything (2026-10-01:
// "never make the user redo work because you dropped something"). A crashed
// turn is replayed once from their saved text when that's safe
// (turnReplayBlocked); either way the note promises nothing, and their message
// stays owed (see OWED_AFTER) until a real answer lands.
export const TURN_FAILED_NOTE = "Sorry, something broke on my end on that last one.";

// ---------------------------------------------------------------- what Cue knows about its own failure
// 2026-10-28: "Call me" crashed (Twilio refused the dial), Royce asked "What happened?", and Cue said "I've flagged it so it gets
// looked at". Nothing had reported the failure: the only thing saved for the team that turn was his question, turned into a
// suggestion by saveFeedbackForTeam. A failure is reported where it happens (turn.failed with its cause, call.dial for a dial that
// never started; the morning review flags both). What the next reply is told comes from reading that record back, so "flagged" stands
// only when the report is really there, and when it isn't (or can't be read) Cue is told exactly that.
export const FAILURE_RECORD_PREFIX = "Cue's own failure, from the record:";
export const FAILURE_RECORD_UNKNOWN = "Whether the failure is on record for the team couldn't be checked.";
// How far back a failure is still the one they're asking about.
export const FAILURE_RECORD_WINDOW_MINUTES = 15;
export type FailureRow = { decision: string; at: Date };

// Pure. rows: the member's turn.failed and call.dial (dial_failed) rows in the window, newest first; null when the read failed.
// afterFailure: Cue's last line to them was a "something broke" line (owedFromRows).
export function failureRecordFacts(rows: FailureRow[] | null, o: { afterFailure: boolean; now: Date }): string[] {
  const ago = (at: Date) => {
    const m = Math.round((o.now.getTime() - at.getTime()) / 60_000);
    return m <= 1 ? "just now" : `${m} minutes ago`;
  };
  if (rows === null) return o.afterFailure ? [`${FAILURE_RECORD_PREFIX} something broke on Cue's side on their last text. ${FAILURE_RECORD_UNKNOWN}`] : [];
  const out: string[] = [];
  const dial = rows.find((r) => r.decision === "call.dial");
  const turn = rows.find((r) => r.decision === "turn.failed");
  if (dial) out.push(`${FAILURE_RECORD_PREFIX} the call they asked for ${ago(dial.at)} never started: it failed on Cue's side before their phone rang, nothing they did. ${FAILURE_ON_RECORD}`);
  if (turn) out.push(`${FAILURE_RECORD_PREFIX} Cue's answer to their text ${ago(turn.at)} broke on Cue's side before it finished. ${FAILURE_ON_RECORD}`);
  if (!out.length && o.afterFailure) out.push(`${FAILURE_RECORD_PREFIX} something broke on Cue's side on their last text, and nothing about it is in the record. ${FAILURE_NOT_ON_RECORD}`);
  return out;
}

// A failure of Cue's own is in this reply's facts (the record read back above, or this turn's own call that never started,
// services/callReasons.ts), and whether its report is verifiably on record.
export function failureInView(facts: { text: string }[]): { inView: boolean; onRecord: boolean } {
  const has = (x: string) => facts.some((f) => f.text.includes(x));
  const onRecord = has(FAILURE_ON_RECORD);
  return { inView: onRecord || has(FAILURE_NOT_ON_RECORD) || has(FAILURE_RECORD_UNKNOWN), onRecord };
}

// Cue saying it reported something: "I've flagged it", "it's been logged", "I passed it along". Only a claim of reporting; a
// negation ("I haven't flagged it") is an admission, not this.
export const FLAG_CLAIM = /\b(?:flagg(?:ed|ing)|report(?:ed|ing)|logg(?:ed|ing)|escalat(?:ed|ing)|raised (?:it|this|that)|on record|let (?:the team|someone|them) know|pass(?:ed|ing) (?:it|this|that) (?:along|on)|(?:sent|sending) (?:it|this|that) to the team)\b/i;
const NEGATED = /\b(?:not|never|haven'?t|hasn'?t|didn'?t|did not|wasn'?t|isn'?t|no one|nobody|nothing)\b/i;
export function flagClaim(text: string): boolean {
  return FLAG_CLAIM.test(text) && !NEGATED.test(text);
}

// Cue saying plainly that it failed: "the call didn't go through", "I couldn't get the call out", "something broke on my end".
// True whenever a failure is in view, whether or not its report landed, so it's never cut as machinery talk or as an unbacked past
// action (2026-10-28: "the call just didn't go through on my end" was cut and only "I've flagged it" went out).
export const FAILURE_ADMISSION = /\b(?:call|it|that)\b[^.!?]{0,40}?\b(?:didn'?t|did not|never|couldn'?t|could not|wasn'?t|failed to)\b[^.!?]{0,25}?\b(?:go(?:ing)? (?:through|out)|went (?:through|out)|ring|connect|placed|start|work)\b|\bsomething (?:broke|went wrong|failed)\b|\b(?:couldn'?t|could not|wasn'?t able to) (?:get (?:the|a) call (?:out|through)|place (?:the|a) call|call you|ring you)\b/i;
export function failureAdmitted(facts: { text: string }[], sentence: string): boolean {
  return failureInView(facts).inView && FAILURE_ADMISSION.test(sentence) && !flagClaim(sentence);
}

// When a reply comes out empty (a timeout, no text), Co keeps their message
// and tries again a minute later from it (agent/conversationReply.ts, 2026-10-01
// code review: the old line, "What's on your mind?", made them say it again).
//   DELAYED: said now, and backed by the retry the reply schedules.
//   GAVE_UP: the retry came out empty too.
//   NO_RETRY: nothing can retry this reply (tests, other callers).
export const REPLY_DELAYED_NOTE = "Sorry, that one's taking me longer than it should. Give me a minute and I'll come back to it.";
export const REPLY_GAVE_UP_NOTE = "Sorry, I still couldn't get that one to work on my end.";
export const REPLY_NO_RETRY_NOTE = "Sorry, I got tangled up on that one.";
// PARTIAL: the first part of a reply went out and the rest couldn't, even after Co tried again (2026-10-12 audit: a bare "Fair."
// was all that arrived). Never a bare filler: they're told the rest didn't come through, and their message stays owed.
export const REPLY_PARTIAL_NOTE = "Sorry, the rest of that didn't come through on my end.";

// What a reply turn owes them after its sends: the fallback line when nothing went out, the partial line when only part did,
// nothing when it all went or when the send breaker holds every text (the breaker's own note covers that, replyGrounding.ts).
export function deliveryFallback(s: { sent: boolean; sendsHeld: boolean; partialUnsent: string | null }): "fallback" | "partial" | null {
  if (s.sendsHeld) return null;
  if (!s.sent) return "fallback";
  return s.partialUnsent ? "partial" : null;
}
export const RESUME_AFTER_MS = 60_000;

// Co lines that don't answer anything: after one of these, their message is
// still owed, so the next reply answers it (routes/sendblue.ts owedAnswer).
export const OWED_AFTER = [TURN_FAILED_NOTE, REPLY_DELAYED_NOTE, REPLY_GAVE_UP_NOTE, REPLY_NO_RETRY_NOTE, REPLY_PARTIAL_NOTE];

// At most one of these per member in this window, so an outage that fails
// every turn doesn't turn into a string of apologies.
export const TURN_FAILED_NOTE_COOLDOWN_MS = 10 * 60_000;

// A turn that died over an hour ago is stale; a restart that late just
// reports it (reportUnfinishedTurns) instead of texting out of nowhere.
export const TURN_FAILED_NOTE_MAX_AGE_MS = 60 * 60_000;

export type TurnFailedCheck = {
  member: { optedOut: boolean; archived: boolean } | null;
  coRepliedSince: boolean;
  lastNoteAt: Date | null;
  receivedAt: Date;
  now: Date;
  // The text's turn never ran (its phone's lock never came free): a Co reply since answered another text, not this one.
  neverRan?: boolean;
};

// Why not to send, or null to send.
export function turnFailedNoteBlocked(c: TurnFailedCheck): string | null {
  if (!c.member) return "no_member";
  if (c.member.optedOut) return "opted_out";
  if (c.member.archived) return "archived";
  if (c.coRepliedSince && !c.neverRan) return "already_answered";
  if (c.now.getTime() - c.receivedAt.getTime() > TURN_FAILED_NOTE_MAX_AGE_MS) return "too_old";
  if (c.lastNoteAt && c.now.getTime() - c.lastNoteAt.getTime() < TURN_FAILED_NOTE_COOLDOWN_MS) return "just_told_them";
  return null;
}

// Why a saved text's turn must not run again, or null to run it. Running it
// twice is only safe when nothing from the first run reached them: no Co text
// since (beyond the lines above), no call, and no newer text of theirs (that
// turn already has this one in front of it). Within an hour, like the note.
export const TURN_REPLAY_MAX_AGE_MS = 60 * 60_000;
export type TurnReplayCheck = {
  member: { optedOut: boolean; archived: boolean } | null;
  coRepliedSince: boolean;
  lastInboundAt: Date | null;
  callAt: Date | null;
  receivedAt: Date;
  now: Date;
  // The text's turn never ran (its phone's lock never came free, concurrency review 2026-10-12): nothing answered it, and a newer
  // text's turn never saw it, so neither a Co reply since nor a newer text of theirs stops it from being answered now.
  neverRan?: boolean;
  // A text an outage held back or that Sendblue's list recovered (services/inboundRecovery.ts RECOVERED_MAX_AGE_MS): it may be up
  // to a day old, and Cue says first that it's late. Every other check is the same.
  maxAgeMs?: number;
};
export function turnReplayBlocked(c: TurnReplayCheck): string | null {
  if (!c.member) return "no_member";
  if (c.member.optedOut) return "opted_out";
  if (c.member.archived) return "archived";
  if (c.coRepliedSince && !c.neverRan) return "already_answered";
  if (c.now.getTime() - c.receivedAt.getTime() > (c.maxAgeMs ?? TURN_REPLAY_MAX_AGE_MS)) return "too_old";
  // Their own stamp lands a moment after the text arrives; past that, it's a newer text.
  if (!c.neverRan && c.lastInboundAt && c.lastInboundAt.getTime() > c.receivedAt.getTime() + 5_000) return "newer_text";
  if (c.callAt && c.callAt.getTime() > c.receivedAt.getTime()) return "call_placed";
  return null;
}

// Pure: their previous message, when Co never really answered it (routes/sendblue.ts owedAnswer). rows newest first; rows[0] is the
// message being handled now. A hold line or a "something broke" line isn't an answer. REPLY_PARTIAL_NOTE leaves it owed even though
// the first part of the reply was logged ("Co replied: Fair."), since that part alone never answered them (2026-10-12 review).
export function owedFromRows(rows: string[], holdLines: readonly string[]): { text: string; afterFailure: boolean } | null {
  const earlier = rows.slice(1);
  const prevUser = earlier.findIndex((r) => r.startsWith("User said:"));
  if (prevUser === -1) return null;
  const since = earlier.slice(0, prevUser);
  const notAnAnswer = [...holdLines, ...OWED_AFTER].map((l) => `Co replied: ${l}`);
  const partial = since.includes(`Co replied: ${REPLY_PARTIAL_NOTE}`);
  const answered = !partial && since.some((r) => (r.startsWith("Co replied:") && !notAnAnswer.includes(r)) || r.startsWith("Mo replied:"));
  if (answered) return null;
  // Co told them something broke: answering it is now this reply's job. (Without
  // that, the earlier message may just be mid-reply in its own turn.)
  const afterFailure = since.some((r) => OWED_AFTER.some((l) => r === `Co replied: ${l}`));
  return { text: earlier[prevUser].replace(/^User said:\s*/, ""), afterFailure };
}
