// Never go silent (Royce, 2026-09-23). Co marks a text read the moment it
// arrives, so when a turn then crashes (Claude down, a database error, a
// search blowing up, a restart mid-turn), the member sees "Read" and nothing
// else. Instinct's Sep 21-22 outage did exactly this and a user called it
// "worse than an error message". This is the one honest line Co sends
// instead. It owns the miss without asking them to redo anything (2026-10-01:
// "never make the user redo work because you dropped something"), and promises
// no retry, because nothing retries the turn on its own yet.
export const TURN_FAILED_NOTE = "Sorry, something broke on my end on that last one.";

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
};

// Why not to send, or null to send.
export function turnFailedNoteBlocked(c: TurnFailedCheck): string | null {
  if (!c.member) return "no_member";
  if (c.member.optedOut) return "opted_out";
  if (c.member.archived) return "archived";
  if (c.coRepliedSince) return "already_answered";
  if (c.now.getTime() - c.receivedAt.getTime() > TURN_FAILED_NOTE_MAX_AGE_MS) return "too_old";
  if (c.lastNoteAt && c.now.getTime() - c.lastNoteAt.getTime() < TURN_FAILED_NOTE_COOLDOWN_MS) return "just_told_them";
  return null;
}
