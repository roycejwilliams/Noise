// One door (Royce, 2026-11-02, notification grouping PR A: "a member's attention is a budget, and every message has to earn its place").
// Everything Cue sends on its own, unrequested or not urgent, goes through the daily pick (harness/proactive.ts dispatch) as a
// candidate. Task results, Cue's own event announcements, heads-ups about something they were interested in, and intro asks used to
// send themselves (sendExempt), which is how one member got five texts on 11-02 (8:02, 8:15, 9:10, 12:15, 3:30 Pacific).
//
// What still goes straight out (doorRoute): the turn's own reply to their text, a safety message, a notice about something within the
// next few hours (R2), and a delivery they're waiting on right now (it answers their latest message, or the caller marks it
// time-sensitive). Every one of those still passes the member's own rules (harness/notifyGate.ts) right before it goes.
//
// The picker then:
//   gathers   when something becomes ready it waits GATHER_MINUTES for anything else to arrive, then picks and composes once;
//   ranks     requested and within hours > a possible intro > requested results > a find > a check-in (doorBand), on top of the
//             picker's own priority, so lower items wait (matching first: an intro outranks a find);
//   expires   each candidate carries a valid-until (an event's start, a find's freshness, a check-in's relevance window); past it, it's
//             dropped and logged by id, never sent late or in a burst.
// Pure, apart from enterDoor (one enqueue).
import { DateTime } from "luxon";
import { NOTICE_SOON_HOURS, type SendClass } from "./notifyGate.js";

// How long a ready candidate waits for others before the pick composes (about 20-30 minutes, Royce). The dispatch runs every 15
// minutes (jobs/index.ts, at :10, :25, :40, :55), so a ready candidate goes 20-35 minutes after it arrived, with whatever else arrived meanwhile.
export const GATHER_MINUTES = 20;

// The exempt texts that now enter the door instead of sending themselves (ledgered under their own type, so every reader of the
// ledger sees them as before: task texts, followThrough.sendsSince, kind restraint).
export const DOOR_TYPES = ["task_update", "co_event", "event_change", "direct_ask"] as const;
export type DoorType = (typeof DOOR_TYPES)[number];
export const isDoorType = (t: string): t is DoorType => (DOOR_TYPES as readonly string[]).includes(t);

// Why a send goes straight out instead of through the door.
export type Bypass = "reply" | "safety" | "soon" | "answers_latest" | "time_sensitive";
export type DoorRoute = { door: true } | { door: false; why: Bypass };

// Pure: whether a send waits at the door. reply: the turn's own answer (never held, never counted, R1). safety: a safety message.
// soon: what it's about happens within NOTICE_SOON_HOURS (R2). answersLast: a delivery that answers their latest message, still fresh
// (proactive.ts answersLastText): they're waiting on it now. timeSensitive: the caller's own word that a delay breaks it (a reminder at
// the time they set, a window about to be missed). Everything else waits at the door.
export function doorRoute(o: { cls: SendClass; now: Date; soonAt?: Date | null; answersLast?: boolean; safety?: boolean; timeSensitive?: boolean }): DoorRoute {
  if (o.cls === "reply") return { door: false, why: "reply" };
  if (o.safety) return { door: false, why: "safety" };
  if (o.soonAt && noticeWithinHours(o.soonAt, o.now)) return { door: false, why: "soon" };
  if (o.answersLast) return { door: false, why: "answers_latest" };
  if (o.timeSensitive) return { door: false, why: "time_sensitive" };
  return { door: true };
}

// Pure: what it's about starts within the next few hours (and hasn't been over for long). The same window as the gate's R2.
export function noticeWithinHours(at: Date, now: Date): boolean {
  const ms = at.getTime() - now.getTime();
  return ms <= NOTICE_SOON_HOURS * 3_600_000 && ms >= -3 * 3_600_000;
}

// ---------------------------------------------------------------- priority bands (matching first)

// Higher goes first; within a band the picker's own ranking decides (priority, expiry, Cue's pick). A safety follow-up is above all.
export const BAND = { checkin: 1, find: 2, requested: 3, intro: 4, requestedSoon: 5, safety: 6 } as const;
export type Band = (typeof BAND)[keyof typeof BAND];
export const BAND_NAME: Record<Band, string> = { 1: "a check-in", 2: "a find", 3: "requested results", 4: "a possible intro", 5: "requested and within hours", 6: "safety" };

// What brings two members toward each other: a tease about someone in their network, a guest match, the follow-up on an intro, and an
// intro ask to the other side (a door item marked intro).
export const INTRO_TYPES: ReadonlySet<string> = new Set(["network_tease", "event_match_nudge", "intro_nudge"]);

export type Banded = { type: string; payload: unknown; expiresAt: Date | null; cls: SendClass; purpose?: string | null };

// Pure: a candidate's band. cls is its class for the member's rules (notifyGate.candidateClass), purpose its PROACTIVE_PURPOSE.
// Ops texts Cue starts (a name notice, an announcement, a product update, a permission ask) sit with the check-ins: lowest.
export function doorBand(c: Banded, now: Date): Band {
  const p = (c.payload ?? {}) as { safetyFollowUp?: boolean; intro?: boolean; soonAt?: string | null };
  if (p.safetyFollowUp === true) return BAND.safety;
  if (c.cls === "requested") {
    const soon = p.soonAt ? new Date(p.soonAt) : c.expiresAt;
    if (soon && !Number.isNaN(soon.getTime()) && noticeWithinHours(soon, now) && soon.getTime() > now.getTime()) return BAND.requestedSoon;
  }
  // A possible intro, whatever its class (a network tease answers an ask they made, and still ranks as the intro it is).
  if (INTRO_TYPES.has(c.type) || p.intro === true) return BAND.intro;
  if (c.cls === "requested") return BAND.requested;
  if (c.cls === "checkin" || c.purpose === "ops") return BAND.checkin;
  return BAND.find;
}

// Pure: only the highest band present goes to the pick; the rest wait (Royce: "lower items wait; unrequested ones may never send").
export function topBand<T>(items: T[], bandOf: (x: T) => Band): { band: Band | null; items: T[] } {
  if (!items.length) return { band: null, items: [] };
  const top = Math.max(...items.map(bandOf)) as Band;
  return { band: top, items: items.filter((x) => bandOf(x) === top) };
}

// ---------------------------------------------------------------- the gathering window

export type Gatherable = { id: string; dueAt: Date; createdAt: Date; expiresAt: Date | null; payload: unknown };

// Pure: when the pick may compose. Null: now. Otherwise the end of the window opened by the earliest-ready candidate (ready: queued and
// due). A safety follow-up never waits, nor does anything that would expire inside the window (or within a tick of its end).
export function gatherUntil(eligible: Gatherable[], now: Date, o: { minutes?: number; skip?: boolean } = {}): Date | null {
  if (o.skip || !eligible.length) return null;
  const windowMs = (o.minutes ?? GATHER_MINUTES) * 60_000;
  const readyAt = Math.min(...eligible.map((c) => Math.max(c.createdAt.getTime(), c.dueAt.getTime())));
  const until = readyAt + windowMs;
  if (now.getTime() >= until) return null;
  const cantWait = eligible.some((c) => (c.payload as { safetyFollowUp?: boolean } | null)?.safetyFollowUp === true || (c.expiresAt && c.expiresAt.getTime() <= until + 15 * 60_000));
  return cantWait ? null : new Date(until);
}

// ---------------------------------------------------------------- valid-until

// How long a door item stays worth sending. Requested results (something they asked for): their own rule or the spacing may hold it
// as long as the thing in it is still live: it ends when the earliest dated thing inside it is moot (cap: an event's start, a date's
// end), and in any case after REQUESTED_BACKSTOP_DAYS, so nothing waits forever and goes out stale (review of #361, round 2). A drop is
// noted on the task as never told. An intro ask: through the end of the next local day. A find: the end of its own day. A check-in:
// two days. A cap always wins when it comes first.
export const REQUESTED_BACKSTOP_DAYS = 14;
export function doorValidUntil(cls: SendClass | "intro", now: Date, zone: string | null, cap?: Date | null): Date {
  if (cls === "requested") {
    const backstop = new Date(now.getTime() + REQUESTED_BACKSTOP_DAYS * 86_400_000);
    return cap && cap.getTime() < backstop.getTime() ? cap : backstop;
  }
  const local = DateTime.fromJSDate(now).setZone(zone || "America/Los_Angeles");
  const base = cls === "intro" ? local.plus({ days: 1 }).endOf("day") : cls === "checkin" ? local.plus({ hours: 48 }) : local.endOf("day");
  const at = base.toJSDate();
  return cap && cap.getTime() < at.getTime() ? cap : at;
}

// Pure: the earliest dated thing in a text's facts ("date: 2026-11-04", "a date its page mentions: ...", "deadline: ..."), as the end
// of that day in their zone; days already past are ignored (the item is judged by what's still ahead in it). Null: nothing dated.
export function earliestDated(facts: string[], now: Date, zone: string | null): Date | null {
  const z = zone || "America/Los_Angeles";
  const ends = facts
    .flatMap((f) => [...String(f).matchAll(/\b(?:date|deadline)\b[^:]*:\s*(\d{4}-\d{2}-\d{2})/gi)].map((m) => DateTime.fromISO(m[1], { zone: z }).endOf("day")))
    .filter((d) => d.isValid && d.toMillis() > now.getTime())
    .map((d) => d.toJSDate().getTime());
  return ends.length ? new Date(Math.min(...ends)) : null;
}

// Pure: a deferred door item's valid-until (a paused intro ask): never ending before a day past where it was deferred to, so however
// long matching stays paused, the pause itself never makes it expire (the asker is never told it failed because of a pause).
export function deferredDoorExpiry(expiresAt: Date | null, deferTo: Date): Date | null {
  if (!expiresAt) return null;
  return new Date(Math.max(expiresAt.getTime(), deferTo.getTime() + 86_400_000));
}

// What a door item carries for the picker: the text as its own path wrote and checked it, its class, and what it does once it went.
export type DoorPayload = {
  door: true;
  messages: string[];
  cls: SendClass;
  // The restraint kind a Co-initiated text counts as (services/kindRestraint.ts), when it has one.
  restraintKind?: string | null;
  // An intro ask to the other side: ranked as a possible intro.
  intro?: boolean;
  // When what it's about happens (an event they're in): within hours of it, it ranks first.
  soonAt?: string | null;
  // What sending (or dropping) it means for the record (services/deferredSends.ts AfterSend).
  after?: { kind: string; payload: Record<string, unknown> } | null;
  // The task that wrote it (services/taskTurn.ts): it's marked texted, and its links recorded, once the pick sends it; a drop is noted
  // on the task (open or closed) so nothing later says it went.
  taskId?: number | null;
  // Close the task once it went (a research brief's last line): the task stays open until then (review of #361).
  close?: { status: "done" | "dropped"; outcome: string } | null;
  // Whether the text asks them something (a goal check-in's question): the task waits on their reply once it went.
  awaitingReply?: boolean;
  // When it was written, in their zone's day (a text from an earlier day is re-read before it goes).
  writtenAt: string;
};

// Queue a written text at the door: one candidate under its own type and target key (the same key the direct send would have used, so
// the ledger and every reader of it are unchanged, and queueing twice is one candidate).
export async function enterDoor(o: { userId: string; type: DoorType; targetKey: string; messages: string[]; cls: SendClass; summary: string; validUntil: Date; now?: Date; restraintKind?: string | null; intro?: boolean; soonAt?: Date | null; after?: DoorPayload["after"]; taskId?: number | null; close?: DoorPayload["close"]; awaitingReply?: boolean; priority?: number }): Promise<{ queued: boolean }> {
  const P = await import("./proactive.js");
  const now = o.now ?? new Date();
  const payload: DoorPayload = {
    door: true,
    messages: o.messages,
    cls: o.cls,
    ...(o.restraintKind ? { restraintKind: o.restraintKind } : {}),
    ...(o.intro ? { intro: true } : {}),
    ...(o.soonAt ? { soonAt: o.soonAt.toISOString() } : {}),
    ...(o.after ? { after: o.after } : {}),
    ...(o.taskId != null ? { taskId: o.taskId } : {}),
    ...(o.close ? { close: o.close } : {}),
    ...(o.awaitingReply !== undefined ? { awaitingReply: o.awaitingReply } : {}),
    writtenAt: now.toISOString(),
  };
  return P.enqueueCandidate({ userId: o.userId, type: o.type, targetKey: o.targetKey, summary: o.summary, payload, dueAt: now, expiresAt: o.validUntil, ...(o.priority !== undefined ? { priority: o.priority } : {}) });
}
