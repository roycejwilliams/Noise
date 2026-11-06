// One send-time recheck (Cue Memory Spec step 8, Royce 2026-11-06). Anything Cue starts that waited (a queued ask, a deferred text, an
// in-room nudge) is read against the member as they are NOW, in one place, right before it goes: a safety hold, a hard stretch (mood
// hold), an away claim, and whether what it serves is still wanted. Before this, each path read its own slice: inRoomSendAllowed read
// the pause and the member's rule, sendExempt read opt-out, spacing and the rule, a deferred row read only correction marks, so a text
// queued before a bad night could go out after it. The task wake's holds (services/taskTurn.ts holds) are the same reads.
//
// Reads, never rewrites: the shared restraint read (services/memberKnowledge.ts realKnowledgeDeps.restraint: safety hold, emotional
// context, away claim, last inbound), services/moodHold.ts for the mood verdict, services/away.ts for away, harness/closedSubject.ts
// for a changed mind (an ask, goal, task, thread or loop they closed, at their word or not). No model call: a send never costs a read.
//
// Held, never dropped, except a changed mind. A hold says why and when to look again; it writes a decision row (proactive.sendRecheck,
// ids and kinds only, never their words) and nothing else: no memory, no preference, no kind restraint. Silence is not rejection, so a
// held send never reads as "they passed on this" anywhere (kindRestraint learns from unanswered LEDGER rows, and a held send writes none).
// A changed mind is the one drop: what it serves closed, so it would reopen it (the reason starts SUBJECT_CLOSED, which the deferred
// runner already treats as skipped).
//
// Who is held (the doctrine the pick already keeps, candidateChecks):
//   safety hold  Cue's own sends (unsolicited): no offers, nudges or asks. What they asked for (requested) and answers (reply) go.
//   mood hold    Cue's own sends and check-ins, capped (MOOD_HOLD_CAP_HOURS). Requested and replies go.
//   away         Cue's own sends that bring them into an event (eventBound), not the end-of-night close.
//   safety       A send whose PURPOSE is safety is never held by the safety hold (or anything else here).
// The end-of-night close is a goodbye (Royce 2026-10-14: one line, once): only the safety hold holds it.
import { recordDecision } from "./core.js";
import type { SendClass } from "./notifyGate.js";
import { closedReason, closedSubjectFor, droppedClosedDecision, loadClosedSubjects, subjectRefs, type ClosedSet, type ClosedSubject } from "./closedSubject.js";
import { awayHoldReason, LOCATION_BOUND_TYPES, type AwayState } from "../services/away.js";
import { MOOD_HOLD_CAP_HOURS, moodHold, type MoodHold } from "../services/moodHold.js";

export const SEND_RECHECK = "proactive.sendRecheck";

export type RecheckWhat = {
  // The send's kind (an ExemptType, "in_room", ...). Ids only in the log.
  kind: string;
  cls: SendClass;
  targetKey?: string | null;
  payload?: unknown;
  // It brings them into an event (an in-room nudge, an intro ask for an event).
  eventBound?: boolean;
  // It answers their latest message: the holds never apply (the changed-mind read still does).
  reply?: boolean;
  // The end-of-night goodbye.
  close?: boolean;
  // Its purpose is safety: never held here.
  safety?: boolean;
  // false: skip the changed-mind read (a caller with nothing it serves). Default true: closed subjects are read only when the send
  // names one (an ask, goal, task, thread or loop in its key or payload), so a send that serves nothing costs no query.
  changedMind?: boolean;
  // The event it is about (an in-room text, an intro ask for an event): arriving there ends an away hold for it.
  eventId?: string | null;
};

// Pure: whether an exempt send brings them into an event, from its own key (eventGuestMatchHandoff's directAskKey) or type.
export function eventBoundSend(type: string, targetKey: string | null | undefined): boolean {
  return LOCATION_BOUND_TYPES.has(type) || /^direct_ask:[^:]+:[^:]+:[^:]+$/.test(String(targetKey ?? ""));
}

// arrived: they have arrived at what.eventId (by location, their word or the door scan): the away claim doesn't hold a text about the
// place they are standing in. Absent: not read / not arrived.
export type HoldState = { safetyHold: boolean; mood: MoodHold; away: AwayState | null; arrived?: boolean };

// Pure: the event an intro ask is about, from its key direct_ask:<event>:<candidate>:<asker>, when the candidate is the member it is for.
export function directAskEvent(targetKey: string | null | undefined, userId: string): string | null {
  const m = String(targetKey ?? "").match(/^direct_ask:([^:]+):([^:]+):([^:]+)$/);
  return m && m[2] === userId ? m[1] : null;
}
export type Recheck =
  | { go: true }
  | { go: false; hold: "safety" | "mood" | "away" | "unreadable"; held: true; reason: string; retryAt: Date }
  | { go: false; hold: "changed_mind"; held: false; reason: string; hit: ClosedSubject; retryAt?: undefined };

const HOUR = 3_600_000;
// A safety hold's end isn't on the shared read (a flag only): look again in a few hours, which re-reads it.
export const SAFETY_RETRY_HOURS = 6;
export const MOOD_RETRY_HOURS = 3;
export const UNREADABLE_RETRY_MINUTES = 15;

// Pure: the restraint read as the holds. A mood verdict is the same moodHold() every other path calls.
export function holdsFrom(r: { safetyHold: boolean; emotional: Parameters<typeof moodHold>[0]; lastInboundAt: Date | null; away?: AwayState | null }, now: Date): HoldState {
  return { safetyHold: r.safetyHold, mood: moodHold(r.emotional, { now, lastInboundAt: r.lastInboundAt }), away: r.away ?? null };
}

// Pure: whether this send goes, against the member's state now. `closed` is the member's closed subjects (null: not read / nothing).
export function recheckVerdict(what: RecheckWhat, state: HoldState | null, closed: ClosedSet | null, now: Date): Recheck {
  if (what.safety) return { go: true };
  // What they closed or dropped since it was queued: nothing to wait for, it would reopen it. Only closed subjects drop; a narrowed ask
  // (changed, not closed) keeps its subject open and is never read here.
  if (what.changedMind !== false && closed) {
    const hit = closedSubjectFor({ type: what.kind, targetKey: what.targetKey ?? null, payload: what.payload }, closed, what.cls);
    if (hit) return { go: false, hold: "changed_mind", held: false, reason: closedReason(hit), hit };
  }
  if (what.cls === "reply" || what.reply) return { go: true };
  const own = what.cls === "unsolicited";
  if (state === null) {
    // Could not be read: Cue's own sends wait a little (the same fail-closed the mood fallback keeps on a safety read).
    if (own || what.cls === "checkin") return { go: false, hold: "unreadable", held: true, reason: "the member's state couldn't be read; waits", retryAt: new Date(now.getTime() + UNREADABLE_RETRY_MINUTES * 60_000) };
  } else {
    if (state.safetyHold && own) return { go: false, hold: "safety", held: true, reason: "a safety hold is on: Cue's own texts wait", retryAt: new Date(now.getTime() + SAFETY_RETRY_HOURS * HOUR) };
    if (state.mood.hold && (own || what.cls === "checkin") && !what.close) {
      return { go: false, hold: "mood", held: true, reason: `they're in a hard stretch (mood hold, at most ${MOOD_HOLD_CAP_HOURS}h): this waits`, retryAt: new Date(now.getTime() + MOOD_RETRY_HOURS * HOUR) };
    }
    if (state.away && own && what.eventBound && !what.close && !(what.eventId && state.arrived)) {
      const until = state.away.until ? Date.parse(`${state.away.until}T12:00:00Z`) + 24 * HOUR : NaN;
      return { go: false, hold: "away", held: true, reason: awayHoldReason(state.away), retryAt: new Date(until > now.getTime() ? until : now.getTime() + 24 * HOUR) };
    }
  }
  return { go: true };
}

// The one read of the member's state. Replaced in tests only.
type Reader = (userId: string, now: Date, eventId?: string | null) => Promise<HoldState>;
let reader: Reader | null = null;
export function setSendHoldReaderForTests(r: Reader | null): void {
  reader = r;
}
const readHolds: Reader = async (userId, now, eventId) => {
  if (reader) return reader(userId, now, eventId);
  const MK = await import("../services/memberKnowledge.js");
  const holds = holdsFrom(await MK.realKnowledgeDeps.restraint(userId, now), now);
  // Arrival ends an away hold for that event only, and only when an away claim is what would hold it (no extra read otherwise).
  if (eventId && holds.away) holds.arrived = !!(await (await import("../services/eventPresence.js")).getPresence(eventId, userId).catch(() => null))?.arrived_at;
  return holds;
};

// closed: the member's closed subjects, called only when the send names a subject (a caller inside a lock passes its own client's read).
// stage: where it was asked, for the dropped_closed log. quiet: a peek ahead of a real attempt writes no decision row.
export type RecheckDeps = { now?: Date; closed?: (userId: string) => Promise<ClosedSet | null>; record?: typeof recordDecision; stage?: string; quiet?: boolean };

// The recheck every Cue-started send asks right before it goes. Records a decision when it doesn't go (ids and kinds only).
export async function sendTimeRecheck(userId: string, what: RecheckWhat, deps: RecheckDeps = {}): Promise<Recheck> {
  const now = deps.now ?? new Date();
  if (what.safety) return { go: true };
  const reply = what.cls === "reply" || !!what.reply;
  const state = reply ? null : await readHolds(userId, now, what.eventId ?? null).catch(() => null);
  // The closed read only when the send names a subject; a failed read stands for nothing closed.
  let closed: ClosedSet | null = null;
  if (what.changedMind !== false && subjectRefs({ type: what.kind, targetKey: what.targetKey ?? null, payload: what.payload }).length) {
    closed = await (deps.closed ?? loadClosedSubjects)(userId).catch(() => null);
  }
  return finish(userId, what, recheckVerdict(what, state, closed, now), deps);
}

async function finish(userId: string, what: RecheckWhat, v: Recheck, deps: RecheckDeps): Promise<Recheck> {
  if (!v.go && !deps.quiet) {
    // A drop for a closed subject is the same row every path writes (proactive.dropped_closed, ids and states only).
    if (!v.held) {
      await (deps.record ?? recordDecision)(droppedClosedDecision({ userId, stage: deps.stage ?? "send_recheck", candidate: { type: what.kind, targetKey: what.targetKey ?? null }, hit: v.hit })).catch(() => {});
      return v;
    }
    await (deps.record ?? recordDecision)({
      layer: 7,
      decision: SEND_RECHECK,
      userId,
      outcome: "skip",
      action: `held_${v.hold}`,
      reason: v.reason.slice(0, 300),
      proposal: { kind: what.kind, targetKey: what.targetKey ?? null, cls: what.cls, held: true, ...(v.retryAt ? { retryAt: v.retryAt.toISOString() } : {}) },
    }).catch(() => {});
  }
  return v;
}
