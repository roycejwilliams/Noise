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
  url: string | null;
  // Venue coordinates and time zone (2026-09-23, arrival detection in
  // services/eventPresence.ts). Luma leaves the coordinates null when an
  // event has no mappable place, so either can be missing.
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string | null;
  venue?: string | null;
  // Full street address, for looking up the venue's coordinates when Luma
  // doesn't give them (its API left them null on every event, 2026-09-23).
  address?: string | null;
};

// A coordinate from Luma: a number or numeric string, else null.
function coord(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// GET /v1/calendars/events/list — resolves which event_id to pull a guest
// list for. Paginated; follows next_cursor until Luma reports has_more: false.
//
// Two real field-name bugs found live, 2026-09-09 (Royce, confirmed via a
// real event that got a wrong start time and location told to him, and no
// link sent at all): this endpoint's raw event object uses `id`, not
// `api_id` — a DIFFERENT field name than /v1/event/get (which genuinely
// does use api_id, see getEventDetails below) — so event_api_id has been
// undefined for every single event this function has ever returned, and
// everything downstream keyed off it (Tier 1 recommendation dedup,
// recordSurfacedEventAndMatch, the in-room match-nudge retry cron) has been
// silently broken since it shipped. Second: city read `geo_address_info`,
// the exact wrong field name already found and fixed in getEventDetails
// below on 2026-08-30 — that fix was never carried over here. `url` is a
// real field on the raw response (confirmed live) that was never captured
// at all, which is why Tier 1 recommendations never had a real link to send.
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
        api_id: event.id,
        name: event.name,
        start_at: event.start_at,
        end_at: event.end_at ?? null,
        city: event.geo_address_json?.city ?? null,
        url: event.url ?? null,
        latitude: coord(event.geo_latitude ?? event.coordinate?.latitude),
        longitude: coord(event.geo_longitude ?? event.coordinate?.longitude),
        timezone: event.timezone ?? null,
        venue: event.geo_address_json?.address ?? event.geo_address_json?.full_address ?? null,
        address:
          event.geo_address_json?.full_address ??
          ([event.geo_address_json?.address, event.geo_address_json?.city_state ?? event.geo_address_json?.city].filter(Boolean).join(", ") || null),
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
  url: string | null;
  // The event's own IANA zone (Luma event.timezone), for a sane close when end_at is missing.
  timezone?: string | null;
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
    timezone: typeof event.timezone === "string" ? event.timezone : null,
    // Field is geo_address_json, not geo_address_info (confirmed live against
    // a real event) — the old field name never existed on Luma's response,
    // so this silently returned null for every event regardless of whether
    // it actually had a location.
    location: event.geo_address_json?.full_address ?? event.geo_address_json?.city ?? null,
    url: event.url ?? null,
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
//
// Field names fixed 2026-09-03 after live-testing against a real registered
// guest (previously only inferred, never confirmed against an actual
// response): a guest record's own id is `id`, not `api_id` (events use
// `api_id`, guests don't); email/name are `user_email`/`user_name` (with
// `user_first_name`/`user_last_name` as a fallback), not `email`/`name`.
// The old field names existed nowhere in Luma's real response, so every
// guest silently came back with a null id/email/name regardless of what
// Luma actually had on file.
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
      const fullName = [guest.user_first_name, guest.user_last_name].filter(Boolean).join(" ") || null;
      guests.push({
        api_id: guest.id,
        email: guest.user_email ?? null,
        name: guest.user_name ?? fullName,
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

// Where a Co event is, for deciding who's nearby (2026-09-16: every event on
// Co's calendar came back with no city, so the Tier 1 announcement and "Co
// events first" skipped all of them). In order: the calendar's own city, the
// city on the event's public page, the page's venue or address text, then Co's
// home city (CO_HOME_CITY, default San Francisco), since a Co event without
// an address is still Co's event.
export const CO_HOME_CITY_DEFAULT = "San Francisco";

export function resolveCoEventCity(
  calendarCity: string | null | undefined,
  pageCity: string | null | undefined,
  homeCity: string | null | undefined,
  // The page's venue or address text ("San Francisco, CA"), which geocodes
  // even when Luma leaves the city field empty.
  pagePlace?: string | null,
): { city: string; source: "calendar" | "event_page" | "event_address" | "home_city" } {
  if (calendarCity?.trim()) return { city: calendarCity.trim(), source: "calendar" };
  if (pageCity?.trim()) return { city: pageCity.trim(), source: "event_page" };
  if (pagePlace?.trim()) return { city: pagePlace.trim(), source: "event_address" };
  return { city: homeCity?.trim() || CO_HOME_CITY_DEFAULT, source: "home_city" };
}

// Where a Co event is, or that it's online, from what the event's page said
// (code review, 2026-09-17). resolveCoEventCity above had two gaps: an online
// Co event got Co's home city, so the nearby filter dropped it for anyone
// outside San Francisco and it was described as "in San Francisco"; and a
// page fetch that failed or timed out fell through to the home city too, so
// an out-of-town event whose page didn't load was labeled SF.
//   online       reachable by everyone: no city, no radius filter
//   unresolved   the page couldn't be read, so where it is isn't known yet;
//                the caller skips it for now and retries, never guesses
//   home_city    the page was read and genuinely has no address info
// page: the event page as read (services/eventDetails.ts), or null when the
// fetch failed. Pass pageAttempted false when there was no url to fetch.
export type CoEventPlace = {
  city: string | null;
  online: boolean;
  source: "calendar" | "event_page" | "event_address" | "online" | "home_city" | "unresolved";
};

export function resolveCoEventPlace(
  calendarCity: string | null | undefined,
  page: { city?: string | null; address?: string | null; venue?: string | null; online?: boolean } | null | undefined,
  homeCity: string | null | undefined,
  pageAttempted = true,
): CoEventPlace {
  if (page?.online) return { city: null, online: true, source: "online" };
  if (calendarCity?.trim()) return { city: calendarCity.trim(), online: false, source: "calendar" };
  if (!page) {
    return pageAttempted
      ? { city: null, online: false, source: "unresolved" }
      : { city: homeCity?.trim() || CO_HOME_CITY_DEFAULT, online: false, source: "home_city" };
  }
  const r = resolveCoEventCity(null, page.city, homeCity, page.address ?? page.venue);
  return { city: r.city, online: false, source: r.source };
}
