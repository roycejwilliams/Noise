// The search cadence of a goal whose recheck went unanswered. No imports: both the hourly goal sweep (goalEdges.ts) and the 9am floor
// (dailySweep.ts) read it.
// A goal whose one recheck went unanswered for this long is searched weekly, not daily: less contact and less spend, never dropped
// (Royce, 2026-11-04). It keeps its own day of the week, so the searches spread out; any signal clears recheck_asked_at and the daily
// search is back (services/goalRecheck.ts).
export const QUIET_GOAL_DAYS = 7;
export function restingToday(row: { recheckAskedAt?: Date | null } | null | undefined, hash: string, now: Date): boolean {
  const asked = row?.recheckAskedAt;
  if (!asked || now.getTime() - asked.getTime() < QUIET_GOAL_DAYS * 86_400_000) return false;
  return (Math.floor(now.getTime() / 86_400_000) + parseInt(hash.slice(0, 6), 16)) % 7 !== 0;
}

