// A guest checked in at the door of one of Noise's own Luma events (Royce, 2026-11-04). The door is scanned, so this is the one firm
// evidence a member went: they count as arrived at once (services/eventPresence.ts markArrived, the same arrival a shared location or
// "I'm here" makes), which starts the in-room matching for them, and the morning after they get the debrief (harness/proactiveRegistry
// draftDebrief reads the arrival). Only events on Noise's own calendar send these: another host's event never sends us a webhook.
//
// The exact payload Luma sends for a check-in has never been seen (the route's own comment: no live webhook has fired yet), so every
// field is read from every shape it could plausibly have, and the first delivery of each type logs its raw type and the field names
// and kinds (never values, which carry guests' details), so the first real check-in settles it.
import pool from "../db/db.js";
import { matchablePhone } from "../utils/phone.js";

export type CheckInRead = { eventId: string | null; guestKey: string | null; email: string | null; phone: string | null; checkedIn: boolean };

// Pure: what a guest webhook says, from any of the shapes it might come in (the guest itself, or nested under guest / user).
export function readGuestWebhook(data: any): CheckInRead {
  const g = data?.guest && typeof data.guest === "object" ? { ...data, ...data.guest } : (data ?? {});
  const eventId = g.event_api_id ?? g.event?.api_id ?? g.event_id ?? null;
  const email = g.user_email ?? g.email ?? g.user?.email ?? null;
  const phone = g.phone_number ?? g.phone ?? g.user?.phone_number ?? null;
  const at = g.checked_in_at ?? g.check_in?.checked_in_at ?? g.checked_in?.at ?? null;
  const key = g.id ?? g.api_id ?? g.guest_api_id ?? (email ? String(email).toLowerCase() : null);
  return {
    eventId: typeof eventId === "string" && eventId ? eventId : null,
    guestKey: key ? String(key) : null,
    email: typeof email === "string" && email ? email.toLowerCase() : null,
    phone: matchablePhone(typeof phone === "string" ? phone : null),
    checkedIn: typeof at === "string" ? at.trim().length > 0 : at === true,
  };
}

// Pure: the shape of a payload for the first-delivery log: names and kinds only, one level of nesting. Never a value.
export function payloadShape(data: any): string {
  const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  return Object.entries(data ?? {})
    .map(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? `${k}{${Object.entries(v).map(([k2, v2]) => `${k2}:${kind(v2)}`).join(",")}}` : `${k}:${kind(v)}`))
    .join(", ");
}

// A webhook handle claimed once, however many times Luma (or a replay) delivers it. True only for the first claim.
export async function claimOnce(handle: string): Promise<boolean> {
  const { rows } = await pool
    .query(`INSERT INTO inbound_webhook_handles (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING RETURNING handle`, [handle])
    .catch((err: any) => {
      console.error("lumaCheckIn: claim failed (non-fatal, treated as already claimed):", err?.message ?? err);
      return { rows: [] as any[] };
    });
  return rows.length > 0;
}

// The first delivery of each type logs what it carried (names and kinds only), so a guessed field name is found out at once.
export async function logFirstDelivery(type: string, payload: any): Promise<void> {
  if (!(await claimOnce(`luma:first-delivery:${type}`))) return;
  console.log(`luma/webhook: first "${type}" delivery; top-level keys: ${Object.keys(payload ?? {}).join(", ")}; data fields (names and kinds only): ${payloadShape(payload?.data)}`);
}

export type CheckInDeps = {
  ours?: (eventId: string) => Promise<boolean>;
  arrive?: (eventId: string, userId: string) => Promise<boolean>;
  rescore?: (eventId: string, eventName: string | undefined) => void;
  // Whether this member is on the event's guest list or registration. The webhook's own email or phone is only a claim about who the
  // guest is; the member must also be someone the event already knows (matchGuestsToUsers over its list, or its event_presence /
  // event_checkin_followups rows).
  onGuestList?: (eventId: string, userId: string) => Promise<boolean>;
  // Whether a "test-" event id is ours. Only layer-1 stubs pass this; production never treats a "test-" id as ours for a check-in.
  allowTestEvents?: boolean;
};
export type CheckInResult = "arrived" | "already_arrived" | "duplicate" | "not_a_checkin" | "no_event" | "not_ours" | "not_a_member" | "identity_conflict" | "not_on_guest_list";

async function memberIdBy(column: "email" | "phone", value: string | null): Promise<string | null> {
  if (!value) return null;
  const { rows } = await pool.query(
    column === "email"
      ? `SELECT id FROM users WHERE archived_at IS NULL AND LOWER(email) = $1 LIMIT 2`
      : `SELECT id FROM users WHERE archived_at IS NULL AND phone_number = $1 LIMIT 2`,
    [value],
  );
  return rows.length === 1 ? String(rows[0].id) : null;
}

// Pure-ish: who the guest is. Email first; phone only when the guest has no email. A guest whose email and phone name different
// members is refused (a mixed-up identity must never mark the wrong person arrived).
export async function resolveCheckInMember(r: Pick<CheckInRead, "email" | "phone">): Promise<{ userId: string | null; conflict: boolean }> {
  const byEmail = await memberIdBy("email", r.email);
  if (r.email) {
    const byPhone = await memberIdBy("phone", r.phone);
    if (byEmail && byPhone && byEmail !== byPhone) return { userId: null, conflict: true };
    return { userId: byEmail, conflict: false };
  }
  return { userId: await memberIdBy("phone", r.phone), conflict: false };
}

async function onEventGuestList(eventId: string, userId: string): Promise<boolean> {
  const { rows } = await pool
    .query(`SELECT 1 FROM event_checkin_followups WHERE event_api_id = $1 AND user_id = $2 UNION ALL SELECT 1 FROM event_presence WHERE event_api_id = $1 AND user_id = $2 LIMIT 1`, [eventId, userId])
    .catch(() => ({ rows: [] as any[] }));
  if (rows.length) return true;
  const guests = await (await import("./luma.js")).getEventGuestList(eventId);
  const matched = await (await import("./eventScoring.js")).matchGuestsToUsers(guests);
  return matched.some((m: any) => String(m.user_id) === userId);
}

export async function handleGuestCheckIn(data: any, eventName: string | undefined, deps: CheckInDeps = {}): Promise<CheckInResult> {
  const r = readGuestWebhook(data);
  if (!r.checkedIn) return "not_a_checkin";
  if (!r.eventId) return "no_event";
  const ours = deps.ours ?? (async (id: string) => (deps.allowTestEvents && id.startsWith("test-")) || (await (await import("./eventPresence.js")).presenceEvents()).some((e) => e.api_id === id));
  if (!(await ours(r.eventId))) return "not_ours";
  // Once per guest per event, however many times it's delivered (Luma retries; guest.updated also fires for other edits).
  const handle = `luma:checkin:${r.eventId}:${r.guestKey ?? r.email ?? r.phone ?? "unknown"}`;
  if (!(await claimOnce(handle))) return "duplicate";
  try {
    const { userId, conflict } = await resolveCheckInMember(r);
    if (conflict) {
      // Never the email, phone or ids: only that it happened.
      console.error("lumaCheckIn: the guest's email and phone belong to different members; refused");
      return "identity_conflict";
    }
    if (!userId) return "not_a_member";
    const onList = deps.onGuestList ?? onEventGuestList;
    if (!(await onList(r.eventId, userId))) {
      // Not claimed for good: a later edit of the same guest (once the list catches up) may be processed.
      await pool.query(`DELETE FROM inbound_webhook_handles WHERE handle = $1`, [handle]).catch(() => {});
      return "not_on_guest_list";
    }
    const arrive = deps.arrive ?? (async (eventId: string, uid: string) => (await import("./eventPresence.js")).markArrived(eventId, uid, "door"));
    const isNew = await arrive(r.eventId, userId);
    if (!isNew) return "already_arrived";
    // Arrival starts the in-room matching for them: the same re-score every other arrival makes.
    const rescore = deps.rescore ?? ((eventId, name) => {
      import("./eventScoring.js")
        .then((E) => E.scoreGuestListForEvent(eventId, name))
        .catch((err: any) => console.error("lumaCheckIn: arrival re-score failed (non-fatal):", err?.message ?? err));
    });
    rescore(r.eventId, eventName);
    return "arrived";
  } catch (err) {
    // Not done: let Luma's retry (or the next edit) try again.
    await pool.query(`DELETE FROM inbound_webhook_handles WHERE handle = $1`, [handle]).catch(() => {});
    throw err;
  }
}
