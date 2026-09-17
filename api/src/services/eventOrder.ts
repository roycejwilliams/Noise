// Kept free of imports that need API keys, so the code evals can test it.
import { DateTime } from "luxon";
import type { EventDetails } from "./eventDetails.js";

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
