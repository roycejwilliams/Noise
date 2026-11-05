// What Co can see: when they're busy over the next few days (free/busy only, no event titles), from their calendar grant
// (services/cueGrants.ts; Royce 2026-10-15: "rewire busy-times to read from the new calendar grant"). Cue reads no email. Read in the background and cached, never while they wait on a reply, and only ever for that member's own context.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
const DAYS_AHEAD = 4;

export type Busy = { start: string; end: string };
export type GoogleSnapshot = { busy: Busy[] | null; fetchedAt: Date };

// ------------------------------------------------------------ fetching (background)

// Refreshes one member's snapshot. Background only. Busy comes only from the calendar grant.
export async function refreshGoogleSnapshot(userId: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<void> {
  const { calendarConnected, calendarBusy } = await import("./cueGrants.js");
  const cal = await calendarConnected(userId).catch(() => null);
  if (!cal) return;
  const busy = await calendarBusy(userId, now, new Date(now.getTime() + DAYS_AHEAD * 86_400_000), fetchImpl).catch(() => null);
  await pool.query(
    `INSERT INTO google_snapshots (user_id, busy, fetched_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET busy = EXCLUDED.busy, waiting = NULL, fetched_at = NOW()`,
    [userId, busy ? JSON.stringify(busy) : null],
  );
  await recordDecision({ layer: 3, decision: "google.read", userId, outcome: "act", action: "refreshed", proposal: { busyBlocks: busy?.length ?? null } }).catch(() => {});
}

// ------------------------------------------------------------ for Co

const refreshing = new Set<string>();

// The member's own snapshot as facts, read from the cache; a stale or
// missing one is refreshed in the background for next time.
export async function googleFactsFor(userId: string, zone: string | null, now = new Date()): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT s.busy, s.fetched_at, EXISTS (SELECT 1 FROM calendar_grants WHERE user_id = $1) AS connected
       FROM (SELECT $1::uuid AS user_id) u LEFT JOIN google_snapshots s ON s.user_id = u.user_id`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const r = rows[0];
  if (!r?.connected) return [];
  const fetchedAt = r.fetched_at ? new Date(r.fetched_at) : null;
  if ((!fetchedAt || now.getTime() - fetchedAt.getTime() > SNAPSHOT_MAX_AGE_MS) && !refreshing.has(userId)) {
    refreshing.add(userId);
    refreshGoogleSnapshot(userId)
      .catch(() => {})
      .finally(() => refreshing.delete(userId));
  }
  if (!fetchedAt) return ["They connected their calendar, but Cue hasn't read it yet."];
  return describeSnapshot({ busy: r.busy, fetchedAt }, zone, now);
}

export function describeSnapshot(s: GoogleSnapshot, zone: string | null, now = new Date()): string[] {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const asOf = DateTime.fromJSDate(s.fetchedAt).setZone(z).toFormat("ccc h:mm a");
  const out: string[] = [];
  if (s.busy) {
    const blocks = s.busy
      .filter((b) => new Date(b.end).getTime() > now.getTime())
      .map((b) => {
        const st = DateTime.fromISO(b.start).setZone(z);
        const en = DateTime.fromISO(b.end).setZone(z);
        return `${st.toFormat("ccc MMM d h:mm a")}–${en.hasSame(st, "day") ? en.toFormat("h:mm a") : en.toFormat("ccc h:mm a")}`;
      });
    out.push(
      blocks.length
        ? `Their Google Calendar (busy times only, next ${DAYS_AHEAD} days, as of ${asOf}): busy ${blocks.slice(0, 12).join("; ")}. Any other time in that window shows free. Cue sees only busy or free, never what the events are.`
        : `Their Google Calendar shows them free for the next ${DAYS_AHEAD} days (as of ${asOf}). Cue sees only busy or free, never what the events are.`,
    );
  }
  return out;
}
