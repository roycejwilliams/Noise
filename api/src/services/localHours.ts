import { DateTime } from "luxon";

// 9am-8pm local (Royce, 2026-09-02, after a real "thinking about you" text
// arrived at 2am Pacific) — a strict subset of TCPA's 8am-9pm safe-harbor
// window for outbound automated/prerecorded calls in the US, so this one
// shared gate is compliant for the auto-call cron and comfortably
// courteous for the texting crons that also use it (jobs/index.ts).
export const REASONABLE_HOUR_START = 9;
export const REASONABLE_HOUR_END = 20;

// Fails OPEN when timezone is null/unresolvable — same "an infra/data gap
// shouldn't silently drop a real action" philosophy as geocoding.ts's
// withinRadius. A user with no city on file, or a city geo-tz can't place,
// still gets contacted at any hour, exactly like before this fix existed.
//
// No DST edge case here: DateTime.now() is a real, already-resolved UTC
// instant — the classic DST ambiguities (a nonexistent or repeated local
// wall-time) only occur when constructing an instant FROM a local
// wall-time, which this never does.
export function isReasonableLocalHour(timezone: string | null): boolean {
  if (!timezone) return true;
  const local = DateTime.now().setZone(timezone);
  if (!local.isValid) return true;
  return local.hour >= REASONABLE_HOUR_START && local.hour < REASONABLE_HOUR_END;
}
