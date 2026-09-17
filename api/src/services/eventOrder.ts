// Kept free of imports that need API keys, so the code evals can test it.
import { DateTime } from "luxon";
import type { EventDetails } from "./eventDetails.js";

// Pure: order scored events for offering. Open before sold out, then score.
export function orderForOffering<T extends { similarity: number; details?: EventDetails }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const aSold = a.details?.soldOut === true ? 1 : 0;
    const bSold = b.details?.soldOut === true ? 1 : 0;
    return aSold - bSold || b.similarity - a.similarity;
  });
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
  return startAt.slice(0, 10);
}
