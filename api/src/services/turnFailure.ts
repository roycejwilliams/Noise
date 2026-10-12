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
};
export function turnReplayBlocked(c: TurnReplayCheck): string | null {
  if (!c.member) return "no_member";
  if (c.member.optedOut) return "opted_out";
  if (c.member.archived) return "archived";
  if (c.coRepliedSince && !c.neverRan) return "already_answered";
  if (c.now.getTime() - c.receivedAt.getTime() > TURN_REPLAY_MAX_AGE_MS) return "too_old";
  // Their own stamp lands a moment after the text arrives; past that, it's a newer text.
  if (!c.neverRan && c.lastInboundAt && c.lastInboundAt.getTime() > c.receivedAt.getTime() + 5_000) return "newer_text";
  if (c.callAt && c.callAt.getTime() > c.receivedAt.getTime()) return "call_placed";
  return null;
}
