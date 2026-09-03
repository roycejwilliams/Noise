const LUMA_BASE_URL = "https://public-api.luma.com";

function lumaHeaders(): Record<string, string> {
  const key = process.env.LUMA_API_KEY;
  if (!key) throw new Error("luma: LUMA_API_KEY is not configured");
  return { "x-luma-api-key": key };
}

export type LumaEvent = {
  api_id: string;
  name: string;
  start_at: string;
  end_at: string | null;
  city: string | null;
};

// GET /v1/calendars/events/list — resolves which event_id to pull a guest
// list for. Paginated; follows next_cursor until Luma reports has_more: false.
//
// city added 2026-08-30 (Royce: "city and the proximity to each user
// matter") — getEventDetails() below already proves the underlying Luma
// event object carries geo_address_info; this list endpoint just never
// extracted it, leaving Tier 1 (tieredRecommendation.ts) ranking Co's own
// events on name alone, with zero location signal, unlike Tier 2 (which
// does have city from the discover feed). Same field, same fallback shape
// as getEventDetails uses.
export async function listCalendarEvents(): Promise<LumaEvent[]> {
  const events: LumaEvent[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`${LUMA_BASE_URL}/v1/calendars/events/list`);
    if (cursor) url.searchParams.set("pagination_cursor", cursor);

    const res = await fetch(url, { headers: lumaHeaders() });
    if (!res.ok) {
      throw new Error(`luma: listCalendarEvents failed (${res.status}): ${await res.text()}`);
    }
    const data: any = await res.json();
    for (const entry of data.entries ?? []) {
      const event = entry.event ?? entry;
      events.push({
        api_id: event.api_id,
        name: event.name,
        start_at: event.start_at,
        end_at: event.end_at ?? null,
        city: event.geo_address_info?.city ?? null,
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return events;
}

export type LumaEventDetail = {
  api_id: string;
  name: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
};

// GET /v1/event/get — a single event's current details, for diffing against
// a stored snapshot when an Event Updated webhook fires (see
// eventChangeNotification.ts). Cheaper and more direct than filtering
// listCalendarEvents() by id for a single lookup.
//
// Was calling GET /v1/calendars/events/lookup (confirmed live, 2026-09-02:
// every real call 400'd with "platform: Invalid discriminator value" —
// every event.updated webhook was silently failing this lookup). That
// endpoint is semantically wrong for this anyway: Luma's own docs describe
// it as "see if an event already exists on the calendar" (a pre-submission
// dedup check, response shape is just {id, status, submitted_by}), not a
// full-detail fetch. /v1/event/get with api_id is the actual "return
// details about an event" endpoint and is what listCalendarEvents/
// getEventGuestList's sibling calls in this file expect — confirmed live
// against a real event and matches LumaEventDetail's shape below.
export async function getEventDetails(eventId: string): Promise<LumaEventDetail | null> {
  const url = new URL(`${LUMA_BASE_URL}/v1/event/get`);
  url.searchParams.set("api_id", eventId);

  const res = await fetch(url, { headers: lumaHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`luma: getEventDetails failed (${res.status}): ${await res.text()}`);
  }
  const data: any = await res.json();
  const event = data.event ?? data;
  return {
    api_id: event.api_id,
    name: event.name,
    start_at: event.start_at,
    end_at: event.end_at ?? null,
    // Field is geo_address_json, not geo_address_info (confirmed live against
    // a real event) — the old field name never existed on Luma's response,
    // so this silently returned null for every event regardless of whether
    // it actually had a location.
    location: event.geo_address_json?.full_address ?? event.geo_address_json?.city ?? null,
  };
}

export type LumaGuest = {
  api_id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  approval_status: string;
  registered_at: string | null;
  checked_in_at: string | null;
};

// GET /v1/events/guests/list — the actual guest-list pull for a given event.
// approval_status/registered_at are populated ahead of the event (not gated
// on check-in), which is what makes pre-event scoring possible at all — see
// the "Standing profile scored against full Luma guest list" board item.
export async function getEventGuestList(eventId: string): Promise<LumaGuest[]> {
  const guests: LumaGuest[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`${LUMA_BASE_URL}/v1/events/guests/list`);
    url.searchParams.set("event_id", eventId);
    if (cursor) url.searchParams.set("pagination_cursor", cursor);

    const res = await fetch(url, { headers: lumaHeaders() });
    if (!res.ok) {
      throw new Error(`luma: getEventGuestList failed (${res.status}): ${await res.text()}`);
    }
    const data: any = await res.json();
    for (const entry of data.entries ?? []) {
      const guest = entry.guest ?? entry;
      guests.push({
        api_id: guest.api_id,
        email: guest.email ?? null,
        name: guest.name ?? null,
        phone: guest.phone_number ?? guest.phone ?? null,
        approval_status: guest.approval_status,
        registered_at: guest.registered_at ?? null,
        checked_in_at: guest.checked_in_at ?? null,
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return guests;
}
