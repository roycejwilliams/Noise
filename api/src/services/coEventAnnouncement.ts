// Co's own events come first (Royce, 2026-09-16: "Tier 1 is a priority no
// matter what, it's a Co-sponsored event, so on creation that needs to be the
// immediate thing users see").
//
//   who     every user whose city is near the event, whatever their profile
//           or asks (his call: "Everyone near the event")
//   when    right away, bypassing the one-proactive-text-a-day cap, but only
//           9am-8pm in their time zone; off-hours it waits for the next run
//           inside their hours (jobs/index.ts, every 10 minutes)
//   never   to someone who opted out, or twice for the same event
//   how     the link first, then a short caption (the format everywhere
//           else), through sendExempt so it's logged but not counted
//   record  tier1.announce per person: sent, waiting_for_hours, not_nearby
import pool from "../db/db.js";
import { listCalendarEvents, type LumaEvent } from "./luma.js";
import { withinRadius, getTimezoneForCity } from "./geocoding.js";
import { fetchLumaEventDetails, renderEventDetails } from "./eventDetails.js";
import { draftProactive, checkDraft, localHourOk, sendExempt } from "../harness/proactive.js";
import { gate, recordDecision } from "../harness/core.js";
import { writeMemory } from "./memory.js";

type Person = { id: string; first_name: string | null; phone_number: string; city: string | null };

// Pure: whether this person should get the announcement at all.
export function announcementAudience(people: { id: string; city: string | null; optedOut: boolean; identityCaptured: boolean }[], nearby: (city: string) => boolean) {
  return people.filter((p) => !p.optedOut && p.identityCaptured && !!p.city && nearby(p.city));
}

async function findEvent(eventId: string): Promise<LumaEvent | null> {
  const events = await listCalendarEvents().catch(() => []);
  return events.find((e) => e.api_id === eventId) ?? null;
}

// Queue the announcement for everyone near the event, then send what can go
// out now. Called from the Luma event.created webhook.
export async function announceCoEvent(eventId: string): Promise<{ queued: number; sent: number }> {
  const event = await findEvent(eventId);
  if (!event || !event.city || new Date(event.start_at).getTime() < Date.now()) {
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

// Send every queued announcement whose person is inside their daytime hours.
export async function sendDueCoEventAnnouncements(onlyEventId?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT a.id, a.event_api_id, u.id AS user_id, u.first_name, u.phone_number, p.city, COALESCE(u.sms_opted_out, false) AS opted_out
     FROM co_event_announcements a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN co_profiles p ON p.user_id = u.id
     WHERE a.sent_at IS NULL AND a.gave_up_at IS NULL AND ($1::text IS NULL OR a.event_api_id = $1)
     ORDER BY a.created_at`,
    [onlyEventId ?? null],
  );
  if (!rows.length) return 0;
  const events = await listCalendarEvents().catch(() => []);
  let sent = 0;
  for (const r of rows) {
    const event = events.find((e) => e.api_id === r.event_api_id);
    if (!event || new Date(event.start_at).getTime() < Date.now() || r.opted_out) {
      await pool.query(`UPDATE co_event_announcements SET gave_up_at = NOW() WHERE id = $1`, [r.id]);
      continue;
    }
    const timezone = r.city ? await getTimezoneForCity(r.city).catch(() => null) : null;
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
      await writeMemory(r.user_id, "event_discovery_surfacing", `Announced Co's own event "${event.name}" when it was created`).catch(() => {});
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
  let caption = `Co's hosting "${event.name}". Wanted you to see it first.`;
  try {
    const drafted = await draftProactive({
      functionId: "tier1.announce",
      firstName: person.first_name ?? "there",
      facts: { event_co_is_hosting: record },
      task: `Co is hosting this event and wants them to see it first. The link preview is already showing above this message, so this is its caption: say it's Co's own event, when and where, and the one detail that makes it worth coming. Use only event_co_is_hosting. Don't mention the link or sending it.`,
    });
    if (drafted && gate(checkDraft(drafted, { maxSentences: 3, maxChars: 320 })).ok) caption = drafted;
  } catch (err: any) {
    console.error("coEventAnnouncement: caption draft failed (non-fatal, sending plain):", err?.message ?? err);
  }
  return url ? [url, caption] : [caption];
}
