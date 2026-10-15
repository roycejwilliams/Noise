// Knowing when a member is actually at a Co event (Royce, 2026-09-23: "if we
// can get the details and location of the event + ask the user to share
// location that's how we know they checked in", and "why can't the user
// just text 'I'm here'"). No QR code per event.
//
// 1. The day of the event, Co asks each registered member once: share your
//    location with me until the end of the day, or text "I'm here" when you
//    arrive (runArrivalAsks).
// 2. During the event, a job reads the locations members have shared with
//    Co's number through Find My (Sendblue's location API) and notices when
//    someone has been at the venue for a few minutes, or has left
//    (runPresencePoll).
// 3. "I'm here" (and similar) counts as arriving too (arrivedByText).
// 4. A member who shares their location gets their in-room nudge when they
//    arrive, not at the start time (arrivalWaitCheck); anyone else still
//    gets it at the start, as before.
//
// Privacy: coordinates are only ever compared in memory. event_presence
// stores times (asked, near, arrived, left), never where someone was, and
// nothing here is ever told to another member.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { listCalendarEvents, getEventGuestList, type LumaEvent } from "./luma.js";
import { recordInRoomSend } from "../harness/proactive.js";
import { geocodeVenue, type GeoPoint } from "./geocoding.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { effectiveEnd } from "../harness/introConsent.js";

// ---------------------------------------------------------------- rules (pure)

// Within this distance of the venue counts as there. Find My is often off by
// a block in dense parts of the city, so the fix's own accuracy (capped)
// widens it.
export const ARRIVE_RADIUS_M = 150;
export const MAX_ACCURACY_ALLOWANCE_M = 100;
// Near the venue this long before it counts, so walking or driving past
// doesn't.
export const ARRIVE_DWELL_MS = 4 * 60_000;
// Away this long after arriving counts as left.
export const LEAVE_AFTER_MS = 15 * 60_000;
// A fix older than this is ignored.
export const MAX_FIX_AGE_MS = 10 * 60_000;
// A member who shares their location gets their nudge on arrival; if they
// haven't arrived by this long after the start, the nudge goes anyway.
export const ARRIVAL_WAIT_AFTER_START_MS = 60 * 60_000;
// Presence is only read from this long before the start until the end.
export const WATCH_BEFORE_START_MS = 30 * 60_000;

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function isNearVenue(distanceM: number, accuracyM: number | null): boolean {
  const allowance = Math.min(Math.max(accuracyM ?? 0, 0), MAX_ACCURACY_ALLOWANCE_M);
  return distanceM - allowance <= ARRIVE_RADIUS_M;
}

export type PresenceState = {
  near_since: Date | null;
  arrived_at: Date | null;
  away_since: Date | null;
  left_at: Date | null;
};

// One step of the arrive/leave rules for one fresh location fix.
export function nextPresence(prev: PresenceState, near: boolean, now: Date): { state: PresenceState; change: "arrived" | "left" | null } {
  const s = { ...prev };
  if (s.left_at) return { state: s, change: null };
  if (!s.arrived_at) {
    if (!near) return { state: { ...s, near_since: null }, change: null };
    s.near_since ??= now;
    if (now.getTime() - s.near_since.getTime() >= ARRIVE_DWELL_MS) return { state: { ...s, arrived_at: now }, change: "arrived" };
    return { state: s, change: null };
  }
  if (near) return { state: { ...s, away_since: null }, change: null };
  s.away_since ??= now;
  if (now.getTime() - s.away_since.getTime() >= LEAVE_AFTER_MS) return { state: { ...s, left_at: now }, change: "left" };
  return { state: s, change: null };
}

// The event's end is always introConsent.effectiveEnd (the one end every in-room reader uses, 2026-10-12).
const endOf = (e: { start_at: string; end_at: string | null; timezone?: string | null }) => new Date(effectiveEnd(e)).getTime();

export function isWatchWindow(event: { start_at: string; end_at: string | null; timezone?: string | null }, now: Date): boolean {
  const start = new Date(event.start_at).getTime();
  const end = endOf(event);
  return now.getTime() >= start - WATCH_BEFORE_START_MS && now.getTime() <= end;
}

// "I'm here", "here!", "just got here", "just arrived", "I'm at the event".
// A short message only, so "I'm here in SF this week" isn't an arrival.
export function isImHere(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[^a-z' ]+$/g, "").trim();
  if (t.length > 40) return false;
  return (
    /^(ok(ay)?,? |alright,? )?(i'?m|im|i am|we'?re|we are) (here|at the event|at the venue)( now| already)?$/.test(t) ||
    /^(here|made it|arrived|just (got|arrived)( here)?|i('?ve| have) arrived|i made it|we made it)( now)?$/.test(t)
  );
}

// The day-of ask goes out from 10am local on the event day until 30 minutes
// before it starts.
export const ASK_FROM_LOCAL_HOUR = 10;
export const ASK_UNTIL_BEFORE_START_MS = 30 * 60_000;
export function askWindowOpen(event: { start_at: string; timezone?: string | null }, now: Date): boolean {
  const zone = event.timezone || "America/Los_Angeles";
  const start = DateTime.fromISO(event.start_at, { zone });
  const local = DateTime.fromJSDate(now, { zone });
  if (!start.isValid || !local.hasSame(start, "day")) return false;
  if (local.hour < ASK_FROM_LOCAL_HOUR) return false;
  return now.getTime() <= start.toMillis() - ASK_UNTIL_BEFORE_START_MS;
}

export function arrivalAskText(event: { name: string; start_at: string; timezone?: string | null; venue?: string | null }, canUseLocation: boolean): string {
  const zone = event.timezone || "America/Los_Angeles";
  const start = DateTime.fromISO(event.start_at, { zone });
  const when = start.hour >= 17 ? "Tonight" : "Today";
  const at = event.venue ? ` at ${event.venue}` : "";
  const lead = `${when}: ${event.name}${at}.`;
  return canUseLocation
    ? `${lead} If you share your location with me until the end of the day, I'll tell you who to find the moment you walk in. Or just text me "I'm here" when you arrive.`
    : `${lead} Text me "I'm here" when you arrive and I'll tell you who to find.`;
}

// In-room nudge gate: someone sharing their location is waiting to be told
// on arrival, so their nudge holds until they arrive (or the wait runs out).
// Someone who stopped sharing isn't waiting: Cue can't see them arrive, so their nudge goes like anyone's (review of #215).
export function arrivalWaitCheck(
  presence: { sharing_seen_at: Date | null; arrived_at: Date | null; location_stopped_at?: Date | null } | null,
  startAt: string,
  now: Date,
): GateCheck {
  const name = "arrived_or_not_waiting";
  if (!presence?.sharing_seen_at || presence.arrived_at || presence.location_stopped_at) return { name, pass: true };
  if (now.getTime() >= new Date(startAt).getTime() + ARRIVAL_WAIT_AFTER_START_MS) {
    return { name, pass: true, reason: "shared their location but hasn't arrived an hour in; nudging anyway" };
  }
  return { name, pass: false, reason: "sharing their location; waiting until they arrive" };
}

// ---------------------------------------------------------------- data

export async function getPresence(eventId: string, userId: string) {
  const { rows } = await pool
    .query(`SELECT sharing_seen_at, arrived_at, location_stopped_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2`, [eventId, userId])
    .catch(() => ({ rows: [] as any[] }));
  const at = (v: unknown) => (v ? new Date(v as string) : null);
  return rows[0] ? { sharing_seen_at: at(rows[0].sharing_seen_at), arrived_at: at(rows[0].arrived_at), location_stopped_at: at(rows[0].location_stopped_at) } : null;
}

// Marks them arrived once. True only the first time.
// via "door": the event's door-only code, texted in its check-in window (services/doorCodes.ts, Royce's ruling on #213).
export async function markArrived(eventId: string, userId: string, via: "location" | "text" | "door"): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO event_presence (event_api_id, user_id, arrived_at, arrived_via) VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (event_api_id, user_id) DO UPDATE SET arrived_at = NOW(), arrived_via = $3
       WHERE event_presence.arrived_at IS NULL
     RETURNING user_id`,
    [eventId, userId, via],
  );
  const isNew = rows.length > 0;
  if (isNew) {
    await recordDecision({ layer: 6, decision: "event.arrived", userId, outcome: "act", action: via, proposal: { eventId } }).catch(() => {});
  }
  return isNew;
}

// Short-lived caches so a 2-minute job doesn't call Luma every tick.
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
// Co's calendar, plus test events for test members on co-test (services/testNumbers.ts).
const events = () =>
  cached("events", 5 * 60_000, async () => {
    const real = await listCalendarEvents();
    const { testNumbersEnabled } = await import("./testNumbers.js");
    if (!testNumbersEnabled()) return real;
    const { rows } = await pool.query(`SELECT * FROM co_test_events`).catch(() => ({ rows: [] as any[] }));
    return [
      ...real,
      ...rows.map((r: any): LumaEvent => ({ api_id: r.api_id, name: r.name, start_at: new Date(r.start_at).toISOString(), end_at: r.end_at ? new Date(r.end_at).toISOString() : null, city: "San Francisco", url: r.url, latitude: r.latitude, longitude: r.longitude, timezone: r.timezone, venue: r.venue, address: r.address })),
    ];
  });
export const presenceEvents = events;
export function clearPresenceCache(): void {
  cache.clear();
}

// Where the venue is: Luma's coordinates when it has them (its API has
// returned none so far), else a street-level lookup of the address. Null for
// an event with only a city, so those get "I'm here" only.
export async function venueFor(event: LumaEvent): Promise<GeoPoint | null> {
  if (event.latitude != null && event.longitude != null) return { lat: event.latitude, lng: event.longitude };
  if (!event.address) return null;
  return cached(`venue:${event.address}`, 60 * 60_000, () => geocodeVenue(event.address!));
}

// Registered (approved) Co members for an event.
export async function eventMembers(eventId: string): Promise<{ user_id: string; first_name: string; phone_number: string }[]> {
  return cached(`members:${eventId}`, 10 * 60_000, async () => {
    if (eventId.startsWith("test-")) {
      const { rows } = await pool.query(
        `SELECT u.id AS user_id, u.first_name, u.phone_number FROM co_test_events e JOIN users u ON u.id = ANY(e.guest_user_ids)
         WHERE e.api_id = $1 AND u.archived_at IS NULL AND coalesce(u.sms_opted_out, false) = false`,
        [eventId],
      );
      return rows;
    }
    const guests = (await getEventGuestList(eventId)).filter((g) => g.approval_status === "approved");
    const { matchablePhone } = await import("../utils/phone.js");
    const phones = [...new Set(guests.flatMap((g) => [g.phone, matchablePhone(g.phone)]).filter((p): p is string => Boolean(p)))];
    const emails = guests.map((g) => g.email?.toLowerCase()).filter((e): e is string => Boolean(e));
    if (!phones.length && !emails.length) return [];
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.first_name, u.phone_number FROM users u
       WHERE (u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[]))
         AND coalesce(u.sms_opted_out, false) = false AND u.archived_at IS NULL AND u.phone_number IS NOT NULL`,
      [phones, emails],
    );
    return rows;
  });
}

// Everyone who has shared a live location with Co's number (Sendblue, Find
// My). Needs a dedicated Mac-backed Sendblue number; confirmed working on
// co-test 2026-09-23. Returns phone -> latest fix.
export type SharedFix = { lat: number; lng: number; accuracy: number | null; at: Date };
export async function fetchSharedLocations(): Promise<{ sharing: Set<string>; fixes: Map<string, SharedFix> }> {
  const from = process.env.SENDBLUE_PHONE_NUMBER;
  const res = await fetch(`https://api.sendblue.co/api/location?from_number=${encodeURIComponent(from ?? "")}`, {
    headers: { "sb-api-key-id": process.env.SENDBLUE_API_KEY ?? "", "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY ?? "" },
  });
  const out = res.ok ? parseSharedLocations(await res.json(), new Date()) : { sharing: new Set<string>(), fixes: new Map<string, SharedFix>() };
  // Test members' locations come from a test table, never Find My (co-test only).
  const { testNumbersEnabled } = await import("./testNumbers.js");
  if (testNumbersEnabled()) {
    const { rows } = await pool.query(`SELECT u.phone_number, l.latitude, l.longitude, l.accuracy, l.at FROM co_test_locations l JOIN users u ON u.id = l.user_id`).catch(() => ({ rows: [] as any[] }));
    for (const r of rows) {
      out.sharing.add(r.phone_number);
      out.fixes.set(r.phone_number, { lat: r.latitude, lng: r.longitude, accuracy: r.accuracy, at: new Date(r.at) });
    }
  }
  if (!res.ok && !out.sharing.size) throw new Error(`sendblue location: ${res.status}`);
  return out;
}

// Pure, for the checks in evals/presence.
export function parseSharedLocations(data: any, now: Date): { sharing: Set<string>; fixes: Map<string, SharedFix> } {
  const sharing = new Set<string>();
  const fixes = new Map<string, SharedFix>();
  for (const l of Array.isArray(data?.locations) ? data.locations : []) {
    const number = typeof l?.number === "string" ? l.number : null;
    if (!number || l?.state === "not_shared") continue;
    sharing.add(number);
    const loc = l?.location;
    const at = loc?.timestamp ? new Date(loc.timestamp) : null;
    if (l?.state !== "shared_with_fix" || typeof loc?.latitude !== "number" || typeof loc?.longitude !== "number" || !at) continue;
    if (now.getTime() - at.getTime() > MAX_FIX_AGE_MS) continue;
    if (loc.expiresAt && new Date(loc.expiresAt).getTime() < now.getTime()) continue;
    fixes.set(number, { lat: loc.latitude, lng: loc.longitude, accuracy: typeof loc.accuracy === "number" ? loc.accuracy : null, at });
  }
  return { sharing, fixes };
}

// ---------------------------------------------------------------- the day-of ask

// The pre-arrival text replaced this day-of ask (services/preArrival.ts,
// 2026-09-30): same people, one text per event, timed by Co 1 to 3 hours before
// the start and sent through the daily pick. This queues it.
export async function runArrivalAsks(now = new Date()): Promise<number> {
  const { preArrivalWindow, preArrivalEligible, presenceRow } = await import("./preArrival.js");
  const { enqueueCandidate } = await import("../harness/proactive.js");
  let queued = 0;
  for (const event of await events()) {
    const w = preArrivalWindow(event.start_at);
    if (now < w.from || now > w.until) continue;
    const canUseLocation = (await venueFor(event)) !== null;
    for (const m of await eventMembers(event.api_id)) {
      const row = await presenceRow(event.api_id, m.user_id);
      const ok = preArrivalEligible({ registered: true, notGoing: !!row?.not_going_at, alreadySent: !!row?.pre_arrival_sent_at, eventListed: true });
      if (!ok.ok) continue;
      const r = await enqueueCandidate({
        userId: m.user_id,
        type: "pre_arrival",
        targetKey: `pre_arrival:${event.api_id}`,
        topicKey: `event:${event.api_id}`,
        summary: `Before "${event.name}" (starts ${event.start_at}): logistics, who's worth finding, an opener, and the location offer`,
        payload: { eventId: event.api_id, name: event.name, startAt: event.start_at, timezone: event.timezone ?? null, venue: event.venue ?? null, address: event.address ?? null, url: event.url ?? null, canUseLocation, until: w.until.toISOString() },
        dueAt: now,
        expiresAt: new Date(new Date(event.start_at).getTime() - 30 * 60_000),
      }).catch(() => ({ queued: false }));
      if (r.queued) queued++;
    }
  }
  return queued;
}

// ---------------------------------------------------------------- the poll

// Returns the events whose in-room scoring should run again now: someone
// arrived, or the arrival wait just ran out for people still on their way.
export async function runPresencePoll(now = new Date(), tickMs = 2 * 60_000): Promise<Set<string>> {
  const rescore = new Set<string>();
  const live = (await events()).filter((e) => isWatchWindow(e, now));
  if (!live.length) return rescore;

  const { sharing, fixes } = await fetchSharedLocations();

  for (const event of live) {
    const members = await eventMembers(event.api_id);
    const waitEnds = new Date(event.start_at).getTime() + ARRIVAL_WAIT_AFTER_START_MS;
    if (now.getTime() >= waitEnds && now.getTime() - waitEnds < tickMs) rescore.add(event.api_id);
    const venue = await venueFor(event);

    const { mayReadLocation, farNoteDue, presenceRow } = await import("./preArrival.js");
    for (const m of members) {
      if (!sharing.has(m.phone_number)) continue;
      // Only with their yes for this event, quoted from their own message; never otherwise.
      const row = await presenceRow(event.api_id, m.user_id);
      if (!mayReadLocation(row ? { event_api_id: event.api_id, location_yes_at: row.location_yes_at, location_stopped_at: row.location_stopped_at } : null, event.api_id, true)) continue;
      await pool.query(
        `INSERT INTO event_presence (event_api_id, user_id, sharing_seen_at) VALUES ($1, $2, NOW())
         ON CONFLICT (event_api_id, user_id) DO UPDATE SET sharing_seen_at = COALESCE(event_presence.sharing_seen_at, NOW())`,
        [event.api_id, m.user_id],
      );
      const fix = fixes.get(m.phone_number);
      if (!venue || !fix) continue;
      const dist = distanceMeters(venue, fix);
      const near = isNearVenue(dist, fix.accuracy);
      // At most one no-pressure note if they're clearly still far away at the start.
      if (farNoteDue({ startAt: event.start_at, now, arrived: !!row?.arrived_at, noteSent: !!row?.far_note_sent_at, distanceM: dist })) {
        const claimed = await pool.query(`UPDATE event_presence SET far_note_sent_at = NOW() WHERE event_api_id = $1 AND user_id = $2 AND far_note_sent_at IS NULL RETURNING 1`, [event.api_id, m.user_id]);
        if (claimed.rows.length) {
          const { sendExempt } = await import("../harness/proactive.js");
          await sendExempt({ userId: m.user_id, phoneNumber: m.phone_number, type: "co_event", targetKey: `far_note:${event.api_id}`, messages: ["No rush, it's just getting going. I'll point you to people when you're there."], timezone: event.timezone ?? null, respectHours: true }).catch(() => {});
        }
      }
      const { rows } = await pool.query(
        `SELECT near_since, arrived_at, away_since, left_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2`,
        [event.api_id, m.user_id],
      );
      const r = rows[0] ?? {};
      const d = (v: any) => (v ? new Date(v) : null);
      const { state, change } = nextPresence({ near_since: d(r.near_since), arrived_at: d(r.arrived_at), away_since: d(r.away_since), left_at: d(r.left_at) }, near, now);
      if (change === "arrived") {
        await pool.query(`UPDATE event_presence SET near_since = $3 WHERE event_api_id = $1 AND user_id = $2`, [event.api_id, m.user_id, state.near_since]);
        if (await markArrived(event.api_id, m.user_id, "location")) rescore.add(event.api_id);
        continue;
      }
      await pool.query(
        `UPDATE event_presence SET near_since = $3, away_since = $4, left_at = $5 WHERE event_api_id = $1 AND user_id = $2`,
        [event.api_id, m.user_id, state.near_since, state.away_since, state.left_at],
      );
      if (change === "left") {
        // Left early: the end-of-night check-in comes 30 minutes after they
        // left instead of waiting for the event to end.
        await pool
          .query(
            `UPDATE event_checkin_followups SET send_at = LEAST(send_at, NOW() + INTERVAL '30 minutes')
             WHERE event_api_id = $1 AND user_id = $2 AND sent_at IS NULL`,
            [event.api_id, m.user_id],
          )
          .catch(() => {});
        await recordDecision({ layer: 6, decision: "event.left", userId: m.user_id, outcome: "act", action: "location", proposal: { eventId: event.api_id } }).catch(() => {});
      }
    }
  }
  return rescore;
}

// ---------------------------------------------------------------- "I'm here"

// The event they mean: one that's on now (from 3 hours before the start to
// the end) that they're registered for or were asked about. Null if none or
// more than one.
export async function arrivedByText(userId: string, message: string, now = new Date()): Promise<{ eventApiId: string; eventName: string; isNew: boolean } | null> {
  if (!isImHere(message)) return null;
  return recordTextArrival(userId, now);
}

// They told Co they've arrived (Co's judgment, conversationTools.ts
// markArrived, 2026-09-25): records it for the one Co event of theirs that's
// on now, or null when there isn't exactly one.
export async function recordTextArrival(userId: string, now = new Date()): Promise<{ eventApiId: string; eventName: string; isNew: boolean } | null> {
  const open = (await events()).filter((e) => {
    const start = new Date(e.start_at).getTime();
    return now.getTime() >= start - 3 * 3_600_000 && now.getTime() <= endOf(e);
  });
  const theirs: LumaEvent[] = [];
  for (const e of open) {
    const asked = await pool
      .query(`SELECT 1 FROM event_presence WHERE event_api_id = $1 AND user_id = $2`, [e.api_id, userId])
      .then((r) => r.rows.length > 0)
      .catch(() => false);
    if (asked || (await eventMembers(e.api_id)).some((m) => m.user_id === userId)) theirs.push(e);
  }
  if (theirs.length !== 1) return null;
  const isNew = await markArrived(theirs[0].api_id, userId, "text");
  return { eventApiId: theirs[0].api_id, eventName: theirs[0].name, isNew };
}

// The Co event they're registered for that's on today (from 6 hours before the
// start to the end), for replies on the way there. Null when none or several.
export async function todayEventFor(userId: string, now = new Date()): Promise<{ eventApiId: string; name: string; startAt: string; timezone: string | null } | null> {
  const on = (await events()).filter((e) => {
    const start = new Date(e.start_at).getTime();
    return now.getTime() >= start - 6 * 3_600_000 && now.getTime() <= endOf(e);
  });
  const theirs: LumaEvent[] = [];
  for (const e of on) if ((await eventMembers(e.api_id)).some((m) => m.user_id === userId)) theirs.push(e);
  return theirs.length === 1 ? { eventApiId: theirs[0].api_id, name: theirs[0].name, startAt: theirs[0].start_at, timezone: theirs[0].timezone ?? null } : null;
}
