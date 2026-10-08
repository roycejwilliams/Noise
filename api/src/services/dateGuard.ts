// Is this still true today? (Royce, 2026-09-26: "fixed once instead of case
// by case".) One read of any event, offer or follow-up against today's date
// and the dates the member asked about, in their own time zone, from every
// date source a thing can carry: a real event date, the event page's start
// and end, the dates a post states, an application deadline.
//
// It guards facts, not intent: its verdict is written into what Co is told
// ("already over: it was Saturday, September 26"), the proactive path checks
// it before sending, and the claim check holds "come to this" and "how did
// it go" to it. Nothing here reads Co's wording.
//
//   past      over: never offered as something to go to
//   today     happening today
//   upcoming  still ahead: never followed up on as if it happened
//   undated   no date known: neither rule applies
import { DateTime } from "luxon";
import { FALLBACK_ZONE, hoursZone } from "./localHours.js";

// The one fallback (services/localHours.ts): Pacific, as a zone. Callers pass the member's zone (services/memberTime.ts).
export const DEFAULT_ZONE = FALLBACK_ZONE;

export type DateStatus = "past" | "today" | "upcoming" | "undated";
export type Days = { start: string | null; end: string | null };
export type DateRead = { status: DateStatus; start: string | null; end: string | null; outsideAsked: boolean | null };

const day = (v: unknown, zone: string): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = DateTime.fromISO(v.trim(), { setZone: true });
  return d.isValid ? d.setZone(zone).toISODate() : null;
};

export function localToday(zone: string | null = DEFAULT_ZONE, now = new Date()): string {
  return DateTime.fromJSDate(now).setZone(hoursZone(zone)).toISODate()!;
}

// Every date a thing can carry, as local days.
export function itemDays(m: any, zoneIn: string | null = DEFAULT_ZONE): Days {
  const zone = hoursZone(zoneIn);
  const start =
    day(m?.details?.startAt, zone) ?? day(m?.event_date, zone) ?? day(m?.statedDates?.start, zone) ?? day(m?.when, zone) ?? day(m?.deadline, zone);
  const end = day(m?.details?.endAt, zone) ?? day(m?.statedDates?.end, zone) ?? null;
  return { start, end: end && start && end >= start ? end : start };
}

export function readDates(days: Days, today: string, asked?: Days | null): DateRead {
  const { start, end } = days;
  if (!start) return { status: "undated", start: null, end: null, outsideAsked: null };
  const last = end ?? start;
  const status: DateStatus = last < today ? "past" : start > today ? "upcoming" : "today";
  let outsideAsked: boolean | null = null;
  if (asked?.start) {
    const aEnd = asked.end ?? asked.start;
    outsideAsked = last < asked.start || start > aEnd;
  }
  return { status, start, end: last, outsideAsked };
}

const label = (iso: string) => DateTime.fromISO(iso).toFormat("cccc, LLLL d");
const span = (r: DateRead) => (r.start && r.end && r.end !== r.start ? `${label(r.start)} to ${label(r.end)}` : r.start ? label(r.start) : "");

// The words that go into Co's facts next to the thing.
export function dateNote(r: DateRead): string {
  if (r.status === "undated") return "";
  const when =
    r.status === "past" ? `already over: it was ${span(r)}` : r.status === "today" ? `happening today, ${span(r)}` : `coming up: ${span(r)}, so it hasn't happened yet`;
  return ` (${when}${r.outsideAsked ? ", which is outside the dates they asked about" : ""})`;
}

// For the proactive path: may this be offered as something to go to?
export function offerable(r: DateRead): { ok: boolean; why?: string } {
  if (r.status === "past") return { ok: false, why: `it was on ${span(r)}, which has passed` };
  if (r.outsideAsked) return { ok: false, why: `it's on ${span(r)}, outside the dates they asked about` };
  return { ok: true };
}

// ...and may Co ask how it went?
export function followable(r: DateRead): { ok: boolean; why?: string } {
  if (r.status === "upcoming" || r.status === "today") return { ok: false, why: `it's on ${span(r)}, which hasn't finished yet` };
  return { ok: true };
}
