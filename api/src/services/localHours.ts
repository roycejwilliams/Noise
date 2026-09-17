import { DateTime } from "luxon";

// 9am-8pm local (Royce, 2026-09-02, after a real "thinking about you" text
// arrived at 2am Pacific) — a strict subset of TCPA's 8am-9pm safe-harbor
// window for outbound automated/prerecorded calls in the US, so this one
// shared gate is compliant for the auto-call cron and comfortably
// courteous for the texting crons that also use it (jobs/index.ts).
export const REASONABLE_HOUR_START = 9;
export const REASONABLE_HOUR_END = 20;

// With no usable time zone, only the UTC hours when every continental US zone
// is inside 9am-8pm count: 16:00-24:00 UTC (9am Pacific to 8pm Eastern, give
// or take DST). Same window as the proactive harness's localHourOk.
export const NO_TIMEZONE_UTC_START_HOUR = 16;

// Used to fail OPEN when timezone was null/unresolvable (code review,
// 2026-09-17): the missed-call text, event-change texts, and the auto-intake
// call gate all went out at any hour for someone with no city on file, which
// is exactly the 2am contact this gate exists to stop. Now a missing or
// invalid zone gets the conservative US-safe UTC window instead.
//
// No DST edge case here: `now` is a real, already-resolved UTC instant; the
// classic DST ambiguities only occur when constructing an instant FROM a
// local wall-time, which this never does.
export function isReasonableLocalHour(timezone: string | null, now: Date = new Date()): boolean {
  if (timezone) {
    const local = DateTime.fromJSDate(now).setZone(timezone);
    if (local.isValid) return local.hour >= REASONABLE_HOUR_START && local.hour < REASONABLE_HOUR_END;
  }
  return now.getUTCHours() >= NO_TIMEZONE_UTC_START_HOUR;
}

// The next instant (on the hour) that isReasonableLocalHour allows, at or
// after `after`. Used to queue a text for the morning instead of sending it
// at night.
export function nextReasonableHour(timezone: string | null, after: Date = new Date()): Date {
  if (isReasonableLocalHour(timezone, after)) return after;
  const t = new Date(after);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (isReasonableLocalHour(timezone, t)) return t;
  }
  return t;
}
