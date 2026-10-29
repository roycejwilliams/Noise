import { notToTeammate } from "./teamLines.js";
import { FAILURE_FACT_PREFIX, FAILURE_ON_RECORD, FAILURE_REPORT_PREFIX, FAILURE_RECORD_UNKNOWN, failureReportFact } from "./callReasons.js";
export { FAILURE_FACT_PREFIX, FAILURE_REPORT_PREFIX, FAILURE_RECORD_UNKNOWN };

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
// suggestion by saveFeedbackForTeam, and that receipt backed the claim. A failure is reported where it happens (turn.failed with its
// cause, call.dial for a dial that never started; the morning review flags both). The next reply is told about it as a plain fact read
// back from that record: what failed, that Cue tried, and whether a report of it is on record. The fact check judges Cue's words
// against that fact like any other (harness/replyGrounding.ts): an honest admission cites it, and "I've flagged it" is supported only
// when it says a report is on record. No phrasing of Cue's is classified here.
// How far back a failure can still be the one they're asking about: an upper bound only (a failure leaves view as soon as a real reply
// goes out after it). The same window owedAnswer (routes/sendblue.ts) looks back over for a "something broke" line, so when Cue's last
// line is that note, its turn.failed row is always inside the read, and the facts never say "no report" while one exists.
export const FAILURE_RECORD_WINDOW_MINUTES = 30;
// action: the row's action (turn.failed's told_member / already_answered / ...). requested: what asked for the call (call.dial's
// proposal.requested). answeredSince: a real Cue reply (not a hold or "something broke" line) answered a text of theirs sent after the row.
export type FailureRow = { decision: string; at: Date; action?: string | null; requested?: string | null; answeredSince?: boolean };
// Calls the member asked for: a "call me" text, the app's call button, or a call they scheduled. The rest Cue started on its own
// (auto intake, the check-in cadence).
const MEMBER_ASKED_CALL = new Set(["router_decision", "user_initiated", "scheduled_call"]);

// Pure. rows: the member's turn.failed and call.dial (dial_failed) rows in the window, newest first; null when the read failed.
// afterFailure: Cue's last line to them was a "something broke" line (owedFromRows).
export function failureRecordFacts(rows: FailureRow[] | null, o: { afterFailure: boolean; now: Date }): string[] {
  const ago = (at: Date) => {
    const m = Math.round((o.now.getTime() - at.getTime()) / 60_000);
    return m <= 1 ? "just now" : `${m} minutes ago`;
  };
  if (rows === null) return o.afterFailure ? [`${FAILURE_FACT_PREFIX} something broke on Cue's side on their last text.`, failureReportFact("unknown")] : [];
  // A failure their follow-up has had a real reply to is over, a failed call too (whoever started it): it isn't carried into later replies.
  const live = rows.filter((r) => !r.answeredSince && r.action !== "already_answered");
  const dial = live.find((r) => r.decision === "call.dial");
  // While their last line from Cue is still the "something broke" note, that text's failure is the one in front of them.
  const turn = live.find((r) => r.decision === "turn.failed") ?? (o.afterFailure ? rows.find((r) => r.decision === "turn.failed") : undefined);
  const out: string[] = [];
  if (dial) {
    const which = dial.requested && MEMBER_ASKED_CALL.has(dial.requested) ? `Cue tried to place the call they asked for ${ago(dial.at)}` : dial.requested ? `Cue tried to place a call to them on its own ${ago(dial.at)} (they didn't ask for it)` : `Cue tried to place a call to them ${ago(dial.at)}`;
    out.push(`${FAILURE_FACT_PREFIX} ${which}, and the call didn't go through: it failed on Cue's side before their phone rang, nothing they did.`);
  }
  if (turn) out.push(`${FAILURE_FACT_PREFIX} Cue's answer to their text ${ago(turn.at)} broke on Cue's side before it finished.`);
  if (out.length) return [...out, failureReportFact("on_record")];
  return o.afterFailure ? [`${FAILURE_FACT_PREFIX} something broke on Cue's side on their last text.`, failureReportFact("not_on_record")] : [];
}

// The member's failures in the window, newest first, read from the decision log (sendblue.ts, every text). requested: who asked for a
// failed call. answered_since: a real Cue reply to THIS member went out after a text of theirs that itself came after the failure, never
// one of the lines that answer nothing (notAnAnswer: the hold lines and the "something broke" lines, said as logged, "Co replied: ...").
// So the first follow-up still sees the failure (4th review: a dial fails, Cue says so honestly that turn, and "What happened?" must
// still get the facts); the reply to that follow-up ends it. Null when the read fails.
export const FAILURE_ROWS_SQL = `SELECT hd.decision, hd.created_at, hd.action, hd.proposal->>'requested' AS requested,
       EXISTS (
         SELECT 1 FROM co_memories r
         WHERE r.user_id = hd.user_id AND r.memory_type = 'text_exchange' AND r.content LIKE 'Co replied:%'
           AND r.content <> ALL($3::text[])
           AND r.created_at > (
             SELECT MIN(u.created_at) FROM co_memories u
             WHERE u.user_id = hd.user_id AND u.memory_type = 'text_exchange'
               AND (u.content LIKE 'User said:%' OR u.content LIKE 'User sent a voice memo:%') AND ${notToTeammate("u")} AND u.created_at > hd.created_at
           )
       ) AS answered_since
FROM harness_decisions hd
WHERE hd.user_id = $1 AND hd.created_at > NOW() - make_interval(mins => $2)
  AND ((hd.decision = 'call.dial' AND hd.action = 'dial_failed') OR hd.decision = 'turn.failed')
ORDER BY hd.created_at DESC LIMIT 5`;
type Query = (sql: string, values: unknown[]) => Promise<{ rows: any[] }>;
export async function readFailureRows(query: Query, userId: string, notAnAnswer: readonly string[]): Promise<FailureRow[] | null> {
  return query(FAILURE_ROWS_SQL, [userId, FAILURE_RECORD_WINDOW_MINUTES, notAnAnswer.map((l) => `Co replied: ${l}`)])
    .then((r) =>
      r.rows.map((x: { decision: string; created_at: string | Date; action: string | null; requested: string | null; answered_since: boolean }): FailureRow => ({
        decision: x.decision,
        at: new Date(x.created_at),
        action: x.action,
        requested: x.requested,
        answeredSince: !!x.answered_since,
      })),
    )
    .catch(() => null);
}

// Pure. A fact about a failure of Cue's own (the record read back above, or this turn's own call that didn't go through,
// services/callReasons.ts).
export function isFailureFact(f: { text: string }): boolean {
  return f.text.startsWith(FAILURE_FACT_PREFIX);
}
// Pure. Its report status: on record, no report, or couldn't be checked.
export function isFailureReportFact(f: { text: string }): boolean {
  return f.text.startsWith(FAILURE_REPORT_PREFIX);
}
// A status fact backs a claim only when it says a report IS on record: one saying there's no report, or that it couldn't be checked,
// is a fact about an absence and supports nothing.
export function reportFactBacks(f: { text: string }): boolean {
  return isFailureReportFact(f) && f.text.includes(FAILURE_ON_RECORD);
}
// Whether a failure is in this reply's facts, and whether every report status says a report of it is on record.
export function failureInView(facts: { text: string }[]): { inView: boolean; onRecord: boolean } {
  const inView = facts.some(isFailureFact);
  const statuses = facts.filter(isFailureReportFact);
  return { inView, onRecord: inView && statuses.length > 0 && statuses.every(reportFactBacks) };
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
