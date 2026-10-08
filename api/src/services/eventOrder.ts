// Kept free of imports that need API keys, so the code evals can test it.
import { DateTime } from "luxon";
import type { EventDetails } from "./eventDetails.js";
import { FALLBACK_ZONE } from "./localHours.js";

// Pure: order scored events for offering. Open before sold out, then by the
// offer score when there is one (ask plus profile), else the ask score.
export function orderForOffering<T extends { similarity: number; offerScore?: number; details?: EventDetails }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const aSold = a.details?.soldOut === true ? 1 : 0;
    const bSold = b.details?.soldOut === true ? 1 : 0;
    return aSold - bSold || (b.offerScore ?? b.similarity) - (a.offerScore ?? a.similarity);
  });
}

// How much the person's profile counts when ordering events that already
// match what they asked (Royce, 2026-09-16: "we align users with the intent we
// gather. We actually give them things that match their profile"). The ask
// decides what counts; the profile decides which of those come first. With no
// subject in the ask ("what's on this weekend?"), the profile is the order.
export const PROFILE_WEIGHT = 0.4;

export function offerScore(askSimilarity: number, profileSimilarity: number | null, browse: boolean): number {
  if (profileSimilarity === null) return askSimilarity;
  if (browse) return profileSimilarity;
  return (1 - PROFILE_WEIGHT) * askSimilarity + PROFILE_WEIGHT * profileSimilarity;
}

// Co's home time zone, used when a person has no city or zone on file. The
// server runs in UTC on Railway, so falling back to "local" made an evening
// ask in San Francisco search tomorrow's calendar (code review, 2026-09-17).
export const CO_DEFAULT_TIMEZONE = FALLBACK_ZONE;

export function searchZone(zone: string | null | undefined): { zone: string; defaulted: boolean } {
  if (zone && DateTime.now().setZone(zone).isValid) return { zone, defaulted: false };
  const fallback = process.env.CO_HOME_TIMEZONE && DateTime.now().setZone(process.env.CO_HOME_TIMEZONE).isValid ? process.env.CO_HOME_TIMEZONE : CO_DEFAULT_TIMEZONE;
  return { zone: fallback, defaulted: true };
}

// Today's date where they are, YYYY-MM-DD; with no zone known, the fallback zone's (Pacific), never the server's UTC day.
export function localToday(now: Date, zone?: string | null): string {
  if (zone) {
    const d = DateTime.fromJSDate(now).setZone(zone);
    if (d.isValid) return d.toISODate()!;
  }
  return DateTime.fromJSDate(now).setZone(FALLBACK_ZONE).toISODate()!;
}

// Pure: at most `max` events, spread across the days they fall on (round
// robin, feed order within a day). Taking the first 40 in feed order meant a
// long window ("Oct 5 - Oct 14") only ever ranked its first couple of days
// (code review, 2026-09-17).
export function spreadAcrossDays<T extends { start_at: string }>(events: T[], max: number, zone?: string | null): T[] {
  if (events.length <= max) return events;
  const byDay = new Map<string, T[]>();
  for (const e of events) {
    const d = localDate(e.start_at, zone);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }
  const days = [...byDay.keys()].sort().map((d) => byDay.get(d)!);
  const out: T[] = [];
  for (let i = 0; out.length < max; i++) {
    let added = false;
    for (const list of days) {
      if (i < list.length && out.length < max) {
        out.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

// The event's calendar date where they are. start_at is UTC, so a 7pm
// Thursday event in San Francisco is already Friday in UTC; using that date
// turned Thursday-night events away as "after the time frame" and named the
// wrong day for a near miss (2026-09-16).
export function localDate(startAt: string, zone?: string | null): string {
  if (zone) {
    const d = DateTime.fromISO(startAt, { zone: "utc" }).setZone(zone);
    if (d.isValid) return d.toISODate()!;
  }
  const d = DateTime.fromISO(startAt, { zone: "utc" }).setZone(FALLBACK_ZONE);
  return d.isValid && /T/.test(startAt) ? d.toISODate()! : startAt.slice(0, 10);
}
