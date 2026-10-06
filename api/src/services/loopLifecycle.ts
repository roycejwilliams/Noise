// The life of an open loop (Royce, 2026-10-06: "open loops are write-only: things go in, nothing comes out"). The 9/29 pitch stayed
// open after its date passed, and a check-in grabbed it as if it were live.
//
// States:      open     Co is carrying it and it is the member's move or Co's
//              waiting  waiting on a reply (theirs or someone's)
//              closed   finished: they said so, or evidence did (the date passed, the reply came, the thing happened)
//              expired  nobody signalled for a set period: Co asked once, got nothing, and let it go
// Every loop carries lastConfirmedAt: the last time the member said or did something about it (it was created from their words, they
// replied, Co updated it at their word). Not "the row was touched": a sync of the same task does not confirm anything.
//
// Three ways out:
//   the member says it's done   -> closed   (setLoopStatus, closed_reason 'co': the tombstone the sync never reopens)
//   evidence closes it          -> closed   (source done, the loop's date has passed: closed_reason 'source_done' / 'date_passed')
//   decay                       -> after ASK_AFTER_DAYS with no signal Co asks the member ONCE (decay_asked_at); if still nothing
//                                  EXPIRE_AFTER_ASK_DAYS later it expires (closed_reason 'expired'), quietly.
// Enduring context (cofounder, city, what they are building) is not a loop. It lives in member_claims (services/factLabels.ts) and
// never expires.
//
// Drafting reads only loops that are OPEN and RECENTLY CONFIRMED (isDraftable). Everything else may orient a draft as background but
// can't be stated as current.

export const LOOP_STATES = ["open", "waiting", "closed", "expired"] as const;
export type LoopState = (typeof LOOP_STATES)[number];

export const FRESH_DAYS = 7; // confirmed within this many days = recent enough to be stated as current
export const ASK_AFTER_DAYS = 7; // no signal this long: ask once
export const EXPIRE_AFTER_ASK_DAYS = 5; // asked and still nothing: expire
export const HARD_EXPIRE_DAYS = 30; // no signal this long: expires even if the ask could never be sent

// What the lifecycle reads of a row. closedReason: 'co' | 'source_done' | 'source_dropped' | 'stale' | 'date_passed' | 'expired'.
export type LifecycleRow = {
  status: string;
  closedAt: Date | null;
  closedReason: string | null;
  dueDate: string | null;
  lastConfirmedAt: Date | null;
  decayAskedAt: Date | null;
  // Co has the work scheduled right now (an open task with a check coming): it is in motion, not abandoned, so it is never asked about.
  inMotion?: boolean;
};

const DAY = 86_400_000;
const WAITING = new Set(["waiting_on_reply"]);

export function stateOf(r: Pick<LifecycleRow, "status" | "closedAt" | "closedReason">): LoopState {
  if (r.closedAt || r.status === "done" || r.status === "dropped") return r.closedReason === "expired" ? "expired" : "closed";
  return WAITING.has(r.status) ? "waiting" : "open";
}

// A loop's date has passed once the day after it has begun (in the member's zone, as a local date string).
export function datePassed(dueDate: string | null, today: string): boolean {
  return !!dueDate && dueDate < today;
}

const daysSince = (at: Date | null, now: Date) => (at ? (now.getTime() - at.getTime()) / DAY : Infinity);

// The one place that decides whether a loop may be stated as current.
export function isDraftable(r: LifecycleRow, now: Date, today: string): boolean {
  if (stateOf(r) !== "open") return false;
  if (datePassed(r.dueDate, today)) return false;
  return daysSince(r.lastConfirmedAt, now) <= FRESH_DAYS;
}

export type DecayAction = { kind: "none" } | { kind: "close_date_passed" } | { kind: "ask" } | { kind: "expire" };

// What the daily pass does with one live loop. Evidence first (a passed date closes it whatever else is true), then decay.
export function decayAction(r: LifecycleRow, now: Date, today: string): DecayAction {
  const s = stateOf(r);
  if (s === "closed" || s === "expired") return { kind: "none" };
  // Co has it scheduled right now: in motion, not abandoned. Its own deadline is the task's business, not a reason to drop the loop.
  if (r.inMotion) return { kind: "none" };
  if (datePassed(r.dueDate, today)) return { kind: "close_date_passed" };
  // Nothing at all for a month: it goes, whether or not an ask ever made it out.
  if (daysSince(r.lastConfirmedAt, now) >= HARD_EXPIRE_DAYS) return { kind: "expire" };
  // Waiting on someone else's reply: asking the member "still on your plate?" is the wrong question; evidence or the hard limit ends it.
  if (s === "waiting") return { kind: "none" };
  // Asked once already: the clock for the answer runs from the ask. A signal after the ask (they replied) restarts everything.
  if (r.decayAskedAt && (!r.lastConfirmedAt || r.decayAskedAt >= r.lastConfirmedAt)) {
    return daysSince(r.decayAskedAt, now) >= EXPIRE_AFTER_ASK_DAYS ? { kind: "expire" } : { kind: "none" };
  }
  return daysSince(r.lastConfirmedAt, now) >= ASK_AFTER_DAYS ? { kind: "ask" } : { kind: "none" };
}

// How a loop reads to a draft: only draftable loops are stated as current; the rest is background, labelled so.
export function loopLine(title: string, state: LoopState, draftable: boolean, lastConfirmedAt: Date | null, now: Date): string {
  if (draftable) return `${title} (${state}, confirmed ${Math.max(0, Math.floor(daysSince(lastConfirmedAt, now)))}d ago)`;
  return `${title} (${state === "open" || state === "waiting" ? "not confirmed lately" : state})`;
}
