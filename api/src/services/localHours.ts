import { DateTime } from "luxon";

// 9am-8pm local (Royce, 2026-09-02, after a real "thinking about you" text
// arrived at 2am Pacific) — a strict subset of TCPA's 8am-9pm safe-harbor
// window for outbound automated/prerecorded calls in the US, so this one
// shared gate is compliant for the auto-call cron and comfortably
// courteous for the texting crons that also use it (jobs/index.ts).
export const REASONABLE_HOUR_START = 9;
export const REASONABLE_HOUR_END = 20;

// The one fallback when a member's zone isn't known (Royce, 2026-10-07: "Co is time-aware at all times... against the member's local
// time, not the server's"): Pacific, where the club is (San Francisco), applied as a ZONE so it follows DST. It replaced two fixed-UTC
// guesses (texts 16:00-24:00 UTC, calls 17:00-24:00 UTC), which were Pacific in summer only: after DST ends, 16:00 UTC is 8am PST.
// Every reader of a member's zone goes through services/memberTime.ts, which re-exports this.
export const FALLBACK_ZONE = "America/Los_Angeles";

// The zone a moment is measured in: theirs when it's a real zone, else the fallback.
export function hoursZone(timezone: string | null | undefined): string {
  return timezone && DateTime.now().setZone(timezone).isValid ? timezone : FALLBACK_ZONE;
}

// 9am-8pm in their zone (or the fallback zone). One rule for texts and calls (harness/proactive.ts localHourOk and
// harness/callGate.ts callHourOk both call this).
//
// No DST edge case here: `now` is a real, already-resolved UTC instant; the
// classic DST ambiguities only occur when constructing an instant FROM a
// local wall-time, which this never does.
export function isReasonableLocalHour(timezone: string | null | undefined, now: Date = new Date()): boolean {
  const local = DateTime.fromJSDate(now).setZone(hoursZone(timezone));
  return local.hour >= REASONABLE_HOUR_START && local.hour < REASONABLE_HOUR_END;
}

// The next instant (on the hour) that isReasonableLocalHour allows, at or
// after `after`. Used to queue a text for the morning instead of sending it
// at night.
export function nextReasonableHour(timezone: string | null | undefined, after: Date = new Date()): Date {
  if (isReasonableLocalHour(timezone, after)) return after;
  const t = new Date(after);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (isReasonableLocalHour(timezone, t)) return t;
  }
  return t;
}
