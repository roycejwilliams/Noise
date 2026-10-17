// Co's own events come first (Royce, 2026-09-16: "Tier 1 is a priority no
// matter what, it's a Co-sponsored event, so on creation that needs to be the
// immediate thing users see").
//
//   who     every user whose city is near the event, whatever their profile
//           or asks (his call: "Everyone near the event")
//   when    right away, bypassing the one-proactive-text-a-day cap, but only
//           8am-9pm in their time zone; off-hours it waits for the next run
//           inside their hours (jobs/index.ts, every 10 minutes)
//   never   to someone who opted out, or twice for the same event
//   how     the link first, then a short caption (the format everywhere
//           else), through sendExempt so it's logged but not counted
//   record  tier1.announce per person: sent, waiting_for_hours, not_nearby
import pool from "../db/db.js";
import { listCalendarEvents, getEventDetails, resolveCoEventCity, type LumaEvent } from "./luma.js";
import { withinRadius } from "./geocoding.js";
import { memberZone } from "./memberTime.js";
import { fetchLumaEventDetails, renderEventDetails } from "./eventDetails.js";
import { draftProactive, checkDraft, localHourOk, sendExempt } from "../harness/proactive.js";
import { gate, recordDecision } from "../harness/core.js";
import { writeMemory } from "./memory.js";
import { START_LEAD_MINUTES, startProblem } from "./eventStart.js";

type Person = { id: string; first_name: string | null; phone_number: string; city: string | null };

// Pure: whether this person should get the announcement at all.
export function announcementAudience(people: { id: string; city: string | null; optedOut: boolean; identityCaptured: boolean }[], nearby: (city: string) => boolean) {
  return people.filter((p) => !p.optedOut && p.identityCaptured && !!p.city && nearby(p.city));
}

async function resolveCityFor(event: LumaEvent): Promise<LumaEvent> {
  if (event.city) return event;
  const url = event.url ? (/^https?:\/\//.test(event.url) ? event.url : `https://lu.ma/${event.url}`) : null;
  const page = url ? await fetchLumaEventDetails(url).catch(() => null) : null;
  const resolved = resolveCoEventCity(event.city, page?.city, process.env.CO_HOME_CITY, page?.address ?? page?.venue);
  await recordDecision({ layer: 6, decision: "tier1.eventCity", userId: null, outcome: "act", action: resolved.source, proposal: { eventId: event.api_id, city: resolved.city } }).catch(() => {});
  return { ...event, city: resolved.city };
}

// Returns the event, null when it's confirmed gone (a real 404, or found in
// the list but genuinely absent), or undefined when neither lookup could
// confirm either way (a transient error) — the caller must not treat
// undefined as "doesn't exist" (code review, 2026-09-17).
//
// Tries the single-event endpoint (getEventDetails) first, not the calendar
// list scan: the list lags event.created (confirmed live, 2026-09-07, in
// eventScoring.ts's own resolveEventName), so scanning it for a
// just-created event used to reliably return "not found" with nothing to
// retry. getEventDetails looks the event up directly by id instead. Falls
// back to the list scan only if the direct lookup itself fails.
async function findEvent(eventId: string): Promise<LumaEvent | null | undefined> {
  const details = await getEventDetails(eventId).catch(() => undefined);
  if (details === null) return null; // confirmed 404
  if (details) {
    return resolveCityFor({ api_id: details.api_id, name: details.name, start_at: details.start_at, end_at: details.end_at, city: null, url: details.url });
  }
  // getEventDetails itself failed (network/API error) — fall back to the
  // list scan rather than give up immediately.
  const events = await listCalendarEvents().catch(() => null);
  if (events === null) return undefined; // both lookups failed
  const event = events.find((e) => e.api_id === eventId);
  if (!event) return undefined; // not confirmed either way yet
  return event.city ? event : resolveCityFor(event);
}

// A few retries a few seconds apart (code review, 2026-09-17) — event.created
// fires the instant Luma creates the event, and getEventDetails can lag that
// by a few seconds. Called only from the webhook path (announceCoEvent),
// which is already fire-and-forget after the HTTP response is sent, so
// waiting here doesn't block anything.
async function findEventWithRetry(eventId: string, attempts = 5, delayMs = 4000): Promise<LumaEvent | null> {
  for (let i = 0; i < attempts; i++) {
    const event = await findEvent(eventId);
    if (event !== undefined) return event;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null; // genuinely couldn't resolve it after retrying
}

// Queue the announcement for everyone near the event, then send what can go
// out now. Called from the Luma event.created webhook.
export async function announceCoEvent(eventId: string): Promise<{ queued: number; sent: number }> {
  const event = await findEventWithRetry(eventId);
  // Started, or starting too soon to get there (START_LEAD_MINUTES; Royce, 2026-10-17): not announced.
  if (!event || startProblem(event.start_at, new Date(), START_LEAD_MINUTES) !== null) {
    await recordDecision({ layer: 6, decision: "tier1.announce", userId: null, outcome: "skip", action: "no_event_or_past", proposal: { eventId } }).catch(() => {});
    return { queued: 0, sent: 0 };
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, u.phone_number, p.city, COALESCE(u.sms_opted_out, false) AS opted_out, COALESCE(u.identity_captured, false) AS identity_captured
     FROM users u LEFT JOIN co_profiles p ON p.user_id = u.id
     WHERE u.phone_number IS NOT NULL`,
  );
  const distances = new Map<string, boolean>();
  for (const r of rows) {
    if (r.city && !distances.has(r.city)) distances.set(r.city, await withinRadius(event.city, r.city).catch(() => false));
  }
  const audience = announcementAudience(
    rows.map((r: any) => ({ id: r.id, city: r.city, optedOut: r.opted_out, identityCaptured: r.identity_captured })),
    (city) => distances.get(city) === true,
  );
  for (const r of rows) {
    if (!audience.some((a) => a.id === r.id)) {
      await recordDecision({ layer: 6, decision: "tier1.announce", userId: r.id, outcome: "skip", action: r.opted_out ? "opted_out" : "not_nearby", proposal: { eventId, eventCity: event.city, theirCity: r.city } }).catch(() => {});
    }
  }
  let queued = 0;
  for (const a of audience) {
    const ins = await pool.query(
      `INSERT INTO co_event_announcements (event_api_id, user_id) VALUES ($1, $2) ON CONFLICT (event_api_id, user_id) DO NOTHING RETURNING id`,
      [eventId, a.id],
    );
    if (ins.rows[0]) queued++;
  }
  const sent = await sendDueCoEventAnnouncements(eventId);
  return { queued, sent };
}

// A Luma outage shouldn't cost anyone their announcement (code review,
// 2026-09-17: a single failed listCalendarEvents() call used to mark every
// pending row gave_up_at, permanently, in one shot). Past this many hours
// with still no send, give up regardless — the same bound a retry-count
// column would give, without needing a schema change; the event's own
// start_at (checked per row below) is the tighter, more common bound.
const ANNOUNCEMENT_MAX_AGE_HOURS = 24;

// Send every queued announcement whose person is inside their daytime hours.
export async function sendDueCoEventAnnouncements(onlyEventId?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT a.id, a.event_api_id, a.created_at, u.id AS user_id, u.first_name, u.phone_number, p.city, COALESCE(u.sms_opted_out, false) AS opted_out
     FROM co_event_announcements a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN co_profiles p ON p.user_id = u.id
     WHERE a.sent_at IS NULL AND a.gave_up_at IS NULL AND ($1::text IS NULL OR a.event_api_id = $1)
     ORDER BY a.created_at`,
    [onlyEventId ?? null],
  );
  if (!rows.length) return 0;
  const events = await listCalendarEvents().catch((err: any) => {
    console.error("coEventAnnouncement: listCalendarEvents failed (non-fatal, skipping this run, not giving up on anyone):", err?.message ?? err);
    return null;
  });
  if (events === null) return 0; // list failed — retry next tick, touch nothing
  let sent = 0;
  for (const r of rows) {
    let event = events.find((e) => e.api_id === r.event_api_id);
    if (!event) {
      // Not (yet) in the list scan — confirm via the single-event endpoint
      // before giving up (code review, 2026-09-17): the list lags
      // event.created, so "not in the list" isn't "doesn't exist."
      const details = await getEventDetails(r.event_api_id).catch(() => undefined);
      if (details === undefined) {
        // Couldn't confirm either way — try again next tick, unless this
        // row has been stuck long enough that it's not worth it anymore.
        if (Date.now() - new Date(r.created_at).getTime() > ANNOUNCEMENT_MAX_AGE_HOURS * 3600_000) {
          await pool.query(`UPDATE co_event_announcements SET gave_up_at = NOW() WHERE id = $1`, [r.id]);
          await recordDecision({ layer: 6, decision: "tier1.announce", userId: r.user_id, outcome: "skip", action: "gave_up_stale_lookup", proposal: { eventId: r.event_api_id } }).catch(() => {});
        }
        continue;
      }
      if (details === null) {
        // Confirmed gone.
        await pool.query(`UPDATE co_event_announcements SET gave_up_at = NOW() WHERE id = $1`, [r.id]);
        await recordDecision({ layer: 6, decision: "tier1.announce", userId: r.user_id, outcome: "skip", action: "gave_up_event_gone", proposal: { eventId: r.event_api_id } }).catch(() => {});
        continue;
      }
      event = { api_id: details.api_id, name: details.name, start_at: details.start_at, end_at: details.end_at, city: r.city ?? null, url: details.url };
    }
    // One held for their hours that would now land after the start, or inside the hour before it, is given up (Royce, 2026-10-17).
    const late = startProblem(event.start_at, new Date(), START_LEAD_MINUTES);
    if (late || r.opted_out) {
      await pool.query(`UPDATE co_event_announcements SET gave_up_at = NOW() WHERE id = $1`, [r.id]);
      await recordDecision({ layer: 6, decision: "tier1.announce", userId: r.user_id, outcome: "skip", action: r.opted_out ? "gave_up_opted_out" : /already started/.test(late ?? "") ? "gave_up_event_past" : "gave_up_too_soon", proposal: { eventId: r.event_api_id } }).catch(() => {});
      continue;
    }
    const timezone = await memberZone(r.user_id);
    if (!localHourOk(new Date(), timezone)) {
      await recordDecision({ layer: 6, decision: "tier1.announce", userId: r.user_id, outcome: "skip", action: "waiting_for_hours", proposal: { eventId: r.event_api_id, timezone } }).catch(() => {});
      continue;
    }
    const messages = await draftAnnouncement({ id: r.user_id, first_name: r.first_name, phone_number: r.phone_number, city: r.city }, event);
    const result = await sendExempt({
      userId: r.user_id,
      phoneNumber: r.phone_number,
      type: "co_event",
      targetKey: `co_event:${r.event_api_id}`,
      messages,
      timezone,
      respectHours: true,
    }).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }));
    if (result.sent) {
      sent++;
      await pool.query(`UPDATE co_event_announcements SET sent_at = NOW() WHERE id = $1`, [r.id]);
      // So the ask path and the sweep don't pitch the same Co event again.
      await pool
        .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation_offered', $2)`, [r.user_id, JSON.stringify({ name: event.name, event_api_id: event.api_id })])
        .catch(() => {});
      await writeMemory(r.user_id, "event_discovery_surfacing", `Announced Noise's own event "${event.name}" when it was created`).catch(() => {});
    } else if ((result as any).reason === "already sent") {
      await pool.query(`UPDATE co_event_announcements SET sent_at = NOW() WHERE id = $1`, [r.id]);
    }
    await recordDecision({
      layer: 6,
      decision: "tier1.announce",
      userId: r.user_id,
      outcome: result.sent ? "act" : "skip",
      action: result.sent ? "sent" : `not_sent: ${(result as any).reason ?? "unknown"}`,
      proposal: { eventId: r.event_api_id, name: event.name, messages },
    }).catch(() => {});
  }
  return sent;
}

// The link first, then a short caption from the event's own page.
async function draftAnnouncement(person: Person, event: LumaEvent): Promise<string[]> {
  const url = event.url ? (/^https?:\/\//.test(event.url) ? event.url : `https://lu.ma/${event.url}`) : null;
  const details = url ? await fetchLumaEventDetails(url).catch(() => null) : null;
  const record = details ? renderEventDetails(event.name, details).join("\n") : `"${event.name}" starts ${event.start_at}.`;
  let caption = `Noise is hosting "${event.name}". Wanted you to see it first.`;
  try {
    const drafted = await draftProactive({
      functionId: "tier1.announce",
      firstName: person.first_name ?? "there",
      facts: { event_co_is_hosting: record },
      task: `Noise is hosting this event and wants them to see it first. The link preview is already showing above this message, so this is its caption: say it's Noise's own event, when and where, and the one detail that makes it worth coming. Use only event_co_is_hosting. Don't mention the link or sending it.`,
    });
    if (drafted && gate(checkDraft(drafted, { maxSentences: 3, maxChars: 320 })).ok) caption = drafted;
  } catch (err: any) {
    console.error("coEventAnnouncement: caption draft failed (non-fatal, sending plain):", err?.message ?? err);
  }
  return url ? [url, caption] : [caption];
}
