import pool from "../db/db.js";
import { getEventDetails, getEventGuestList, type LumaEventDetail } from "./luma.js";
import { matchGuestsToUsers } from "./eventScoring.js";
import { runEventChangeNotificationAgent } from "../agent/eventChangeNotification.js";

// "Proactive event-change/cancellation texts" board item. Event Updated
// carries the event's current full state, not a diff — this stores the
// last-known snapshot (luma_event_snapshots) so Co can say specifically
// what changed ("the time moved to 8pm") instead of a generic "something
// changed, check the link," per the 2026-08-30 decision to aim for the more
// complete version.

type Snapshot = { name: string; start_at: string; end_at: string | null; location: string | null };

async function getSnapshot(eventId: string): Promise<Snapshot | null> {
  const { rows } = await pool.query(
    `SELECT name, start_at, end_at, location FROM luma_event_snapshots WHERE event_id = $1`,
    [eventId],
  );
  return rows[0] ?? null;
}

async function storeSnapshot(eventId: string, detail: LumaEventDetail): Promise<void> {
  await pool.query(
    `INSERT INTO luma_event_snapshots (event_id, name, start_at, end_at, location)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id) DO UPDATE SET
       name = EXCLUDED.name, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
       location = EXCLUDED.location, updated_at = NOW()`,
    [eventId, detail.name, detail.start_at, detail.end_at, detail.location],
  );
}

// Plain-English list of what actually changed, comparing only fields that
// differ — never claims something changed that didn't.
function diffSnapshot(previous: Snapshot, current: LumaEventDetail): string[] {
  const changes: string[] = [];
  if (previous.name !== current.name) changes.push(`the name changed to "${current.name}"`);
  if (previous.start_at !== current.start_at) {
    changes.push(`the start time moved to ${new Date(current.start_at).toLocaleString()}`);
  }
  if (previous.end_at !== current.end_at && current.end_at) {
    changes.push(`the end time moved to ${new Date(current.end_at).toLocaleString()}`);
  }
  if (previous.location !== current.location && current.location) {
    changes.push(`the location changed to ${current.location}`);
  }
  return changes;
}

async function notifyMatchedGuests(eventId: string, eventName: string, message: string): Promise<void> {
  const guests = await getEventGuestList(eventId);
  const matched = await matchGuestsToUsers(guests);
  await Promise.all(
    matched.map((person) =>
      runEventChangeNotificationAgent(
        { userId: person.user_id, firstName: person.first_name, phoneNumber: person.phone_number },
        eventName,
        message,
      ).catch((err: any) =>
        console.error(`eventChangeDetection: notification failed for ${person.user_id} (non-fatal):`, err?.message ?? err),
      ),
    ),
  );
}

export async function handleEventUpdated(eventId: string): Promise<void> {
  const [current, previous] = await Promise.all([getEventDetails(eventId), getSnapshot(eventId)]);
  if (!current) return;

  if (!previous) {
    // First time seeing this event via an update — nothing to diff against,
    // so store it and skip notifying rather than falsely imply "everything
    // just changed."
    await storeSnapshot(eventId, current);
    return;
  }

  const changes = diffSnapshot(previous, current);
  await storeSnapshot(eventId, current);
  if (!changes.length) return; // Luma sent an update with no fields we track actually different

  await notifyMatchedGuests(eventId, current.name, `Here's what changed: ${changes.join("; ")}.`);
}

export async function handleEventCanceled(eventId: string): Promise<void> {
  const snapshot = await getSnapshot(eventId);
  const eventName = snapshot?.name ?? "the event";
  await notifyMatchedGuests(eventId, eventName, "it's been canceled.");
}
