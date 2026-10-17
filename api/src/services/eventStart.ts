// When an event can still be offered: not once it has started, and not when it starts too soon to get there (Royce, 2026-10-17:
// "Add a lead-time check wherever Cue offers an event ... An event that has started, or starts too soon to act on, is dropped, not
// offered. The day check isn't enough."). Pure, no database: the reply search's gate (harness/matchGate.ts checkTiming), a find as
// it's shared (agent/loopTools.ts shareFinds), a waiting offer at send (services/sendCheck.ts), the queue's own window
// (services/eventSurfacingSweep.ts offerExpiresAt), a tease's yes (routes/sendblue.ts) and a plan's event steps (services/planSheet.ts).
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";

// Royce, 2026-10-17: "Replies drop events that have already started, with a lead-time check on top of the day check." The day check
// below passes anything happening today; on 10-17 at 10:18 Cue offered "Builders who Run SF ... at Angel Island, is today", which had
// started at 9:30 and is a ferry ride away. An hour to get somewhere.
export const START_LEAD_MINUTES = 60;
// Online, there's nowhere to get to (Royce, 2026-10-17: "60 minutes for in-person events, 15 for online").
export const ONLINE_LEAD_MINUTES = 15;
// Pure: the lead for this event: the online one when it's online and a lead is asked for at all.
export const leadFor = (lead: number | null | undefined, online: boolean | null | undefined) => (lead && online ? Math.min(lead, ONLINE_LEAD_MINUTES) : lead);

// Pure: why an event with this start can't be offered now, or null. Started is always a no; too soon only when a lead is given.
export function startProblem(startAt: string | null | undefined, now: Date, leadMinutes: number | null | undefined, zone: string | null = null): string | null {
  if (!startAt) return null;
  const start = DateTime.fromISO(startAt, { setZone: true });
  if (!start.isValid) return null;
  const mins = (start.toMillis() - now.getTime()) / 60_000;
  const at = (zone ? start.setZone(zone) : start).toFormat("h:mm a");
  if (mins <= 0) return `it already started (${at})`;
  if (leadMinutes && mins < leadMinutes) return `it starts at ${at}, under ${leadMinutes} minutes from now: too soon to get there`;
  return null;
}

// An event that runs a day or more (a festival, a weekend conference) is still on until it ends, so only "over" counts for it, never
// "started": the rule services/sendCheck.ts recheckFind already had ("a festival that started yesterday still runs"). Below a day, the
// start decides (a 9:30 run that ends at noon is not still on at 10:18).
export const MULTI_DAY_HOURS = 24;

// Pure: startProblem for an event whose end may be known (its page's endAt). One rule for every place Cue offers an event
// (Royce, 2026-10-17: "wherever Cue offers an event ... an event that has started, or starts too soon to act on, is dropped").
export function eventStartProblem(e: { startAt?: string | null; endAt?: string | null; online?: boolean | null }, now: Date, leadMinutes: number | null | undefined, zone: string | null = null): string | null {
  const start = e.startAt ? DateTime.fromISO(e.startAt, { setZone: true }) : null;
  const end = e.endAt ? DateTime.fromISO(e.endAt, { setZone: true }) : null;
  if (start?.isValid && end?.isValid && end.diff(start, "hours").hours >= MULTI_DAY_HOURS) {
    return end.toMillis() <= now.getTime() ? `it already ended (${(zone ? end.setZone(zone) : end).toFormat("LLL d, h:mm a")})` : null;
  }
  return startProblem(e.startAt, now, leadFor(leadMinutes, e.online), zone);
}

// Pure: the same for a find. Its start is the feed's (startAt) or its page's (details.startAt); an opening has no start.
export function matchStartProblem(m: TierMatch | null | undefined, now: Date, leadMinutes: number | null | undefined, zone: string | null = null): string | null {
  if (!m || m.tier === 3 || (m as { kind?: string }).kind === "opportunity") return null;
  const d: any = m.details ?? null;
  return eventStartProblem({ startAt: m.startAt ?? d?.startAt ?? null, endAt: d?.endAt ?? null, online: !!(m.online || d?.online) }, now, leadMinutes, zone ?? d?.timezone ?? null);
}
