const LUMA_BASE_URL = "https://public-api.luma.com";

// What a Luma call throws with no key: a setting, not a failure (tieredRecommendation.ts eventCandidates; review of #293).
export const LUMA_KEY_MISSING = "luma: LUMA_API_KEY is not configured";
function lumaHeaders(): Record<string, string> {
  const key = process.env.LUMA_API_KEY;
  if (!key) throw new Error(LUMA_KEY_MISSING);
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

// ---------------------------------------------------------------- public events we don't manage (Royce, 2026-10-19: "tier 2 should
// use the api"). Tier 2 through Exa (services/lumaViaExa.ts) checks every Luma link Exa finds through Luma's official API, never by
// reading the event's page: GET /v1/entities/lookup turns the link's slug into an event (or calendar) id, and GET /v1/events/get
// returns what a visitor to that event could see (access "view": start, end, timezone, visibility, location type, city and
// coordinates, hosts, description, registration). Both confirmed live 2026-10-19 on an event we don't manage (lu.ma/16nclyz5).
// One key for all of it (LUMA_API_KEY, Noise's calendar key): Luma allows 200 requests a minute per calendar, so these two stop at
// LUMA_PUBLIC_API.perMinute, leaving room for Noise's own calendar calls above. A 429 pauses the Exa search for refusalPauseMinutes.
export const LUMA_PUBLIC_API = { perMinute: 150, lookupCacheDays: 7, missCacheHours: 24, eventCacheMinutes: 60, failedCacheMinutes: 2, refusalPauseMinutes: 10, deniedPauseMinutes: 30, deniedPauseMaxMinutes: 24 * 60, timeoutMs: 6000 } as const;

export type LumaEntity = { type: "event"; id: string; slug: string; startAt: string | null; endAt: string | null } | { type: "calendar"; id: string };
export type LumaPublicEvent = {
  id: string;
  name: string;
  slug: string | null;
  startAt: string;
  endAt: string | null;
  timezone: string | null;
  visibility: string | null;
  locationType: string | null;
  locationVisibility: string | null;
  city: string | null;
  address: string | null;
  fullAddress: string | null;
  hosts: string[];
  description: string | null;
  registrationOpen: boolean | null;
  requireApproval: boolean | null;
  spotsRemaining: number | null;
};
// Why a call gave no answer, kept apart from Luma knowing no such event (null), which is only a 404 or a 200 naming no event
// (Royce, 2026-11-10: "a failed verification service must never become 'nothing found'"):
//   "refused": Luma said 429. "limited": our own per-minute stop. "off": no LUMA_API_KEY.
//   "denied": Luma refused the key itself (401 or 403; from 2026-10-31 every call answered 403 "Your calendar must have an active
//             Luma Plus plan to make API requests"). Source-wide: the API pauses (lumaApiDenied) instead of failing once per event.
//   "failed": no usable answer (timed out, unreachable, a 5xx, another 4xx, or a reply that couldn't be read). Not an answer about it.
export type LumaApiMiss = "refused" | "limited" | "off" | "denied" | "failed";

export const lumaApiConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.LUMA_API_KEY?.trim();
let apiCalls: number[] = [];
let apiRefusedAt = 0;
export const lumaApiRefusedRecently = (now: number = Date.now()): boolean => apiRefusedAt > 0 && now - apiRefusedAt < LUMA_PUBLIC_API.refusalPauseMinutes * 60_000;
// The key refused (401/403): when, what Luma said (its own message, never the key), and until when the API isn't asked again. Each
// denial in a row doubles the pause (30 minutes, up to a day); any other answer from Luma clears it. Recovery is tested by one free API
// call once the pause is over (lumaApiState), never by a paid search.
export type LumaApiDenial = { at: number; until: number; status: number; message: string; streak: number };
let apiDenied: LumaApiDenial | null = null;
// Pure: how long the pause is after this many denials in a row.
export const deniedPauseMs = (streak: number): number =>
  Math.min(LUMA_PUBLIC_API.deniedPauseMinutes * 2 ** Math.max(0, streak - 1), LUMA_PUBLIC_API.deniedPauseMaxMinutes) * 60_000;
// The denial still in force, or null.
export const lumaApiDenied = (now: number = Date.now()): LumaApiDenial | null => (apiDenied && now < apiDenied.until ? apiDenied : null);
// The last denial, in force or not (null once Luma answered the key again).
export const lastLumaApiDenial = (): LumaApiDenial | null => apiDenied;
// Pure: Luma's own message from an error body, short, for the log. Never a header, never the key.
export function lumaErrorMessage(body: unknown): string {
  const m = body && typeof body === "object" ? (body as any).message : typeof body === "string" ? body : null;
  return String(m ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}
// A denial while one is already in force (calls that were in flight together) doesn't lengthen the pause: only a new denial after the
// pause ran out does.
function noteDenied(now: number, status: number, message: string): void {
  if (apiDenied && now < apiDenied.until) return;
  const streak = (apiDenied?.streak ?? 0) + 1;
  apiDenied = { at: now, until: now + deniedPauseMs(streak), status, message, streak };
}
// For tests: forget the minute's calls, the last refusal and denial, and both caches.
export function resetLumaPublicApi(): void {
  apiCalls = [];
  apiRefusedAt = 0;
  apiDenied = null;
  lookupCache.clear();
  eventCache.clear();
}
function takeApiSlot(now: number): boolean {
  apiCalls = apiCalls.filter((t) => now - t < 60_000);
  if (apiCalls.length >= LUMA_PUBLIC_API.perMinute) return false;
  apiCalls.push(now);
  return true;
}

type ApiDeps = { fetchImpl?: typeof fetch; now?: () => number; env?: NodeJS.ProcessEnv };
async function apiGet(path: string, params: Record<string, string>, d: ApiDeps): Promise<{ status: number; body: any } | LumaApiMiss> {
  const env = d.env ?? process.env;
  if (!lumaApiConfigured(env)) return "off";
  const now = (d.now ?? Date.now)();
  // The key was refused and its pause isn't over: not asked again until then (one denial for the source, not one per event).
  if (lumaApiDenied(now)) return "denied";
  if (!takeApiSlot(now)) return "limited";
  const url = new URL(`${LUMA_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await (d.fetchImpl ?? fetch)(url, { headers: { "x-luma-api-key": String(env.LUMA_API_KEY).trim() }, signal: AbortSignal.timeout(LUMA_PUBLIC_API.timeoutMs) });
  } catch {
    // Timed out or unreachable: no answer about anything.
    return "failed";
  }
  if (res.status === 429) {
    apiRefusedAt = now;
    return "refused";
  }
  if (res.status === 401 || res.status === 403) {
    noteDenied(now, res.status, lumaErrorMessage(await res.json().catch(() => null)));
    return "denied";
  }
  // Any other answer means the key is accepted again.
  apiDenied = null;
  if (res.status >= 500) return "failed";
  if (!res.ok) return { status: res.status, body: null };
  const body = await res.json().catch(() => undefined);
  // A 200 whose body can't be read says nothing about the event.
  return body === undefined ? "failed" : { status: res.status, body };
}

// What the Luma search through Exa may expect of the API now: "ok", "denied" (a denial's pause is in force, or the one free probe made
// when it ran out was denied again: the pause starts again, longer), or "off" (no key). A probe that got no answer at all ("failed",
// "refused", "limited") is not proof the key works: "denied" stands until Luma answers. The probe is an entity lookup of a slug that
// names no event ("discover"): a 404 or a 200 is fine, only a 401/403 isn't. Free; never a paid search.
export async function lumaApiState(d: ApiDeps = {}): Promise<"ok" | "denied" | "off"> {
  if (!lumaApiConfigured(d.env ?? process.env)) return "off";
  const now = (d.now ?? Date.now)();
  if (lumaApiDenied(now)) return "denied";
  if (!apiDenied) return "ok";
  const probe = await apiGet("/v1/entities/lookup", { slug: "discover" }, d).catch(() => "failed" as const);
  return typeof probe === "string" ? (probe === "off" ? "off" : "denied") : "ok";
}

const lookupCache = new Map<string, { at: number; ttl: number; v: Promise<LumaEntity | null | LumaApiMiss> }>();
// The event or calendar a Luma slug (or link) names, or null when Luma knows none. A slug always names the same thing, so a found one
// is kept for days; a miss for a day; a failure for minutes. One request per slug at a time.
export async function lookupLumaEntity(slug: string, d: ApiDeps = {}): Promise<LumaEntity | null | LumaApiMiss> {
  const now = (d.now ?? Date.now)();
  const key = slug.toLowerCase();
  const hit = lookupCache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.v;
  const entry = { at: now, ttl: LUMA_PUBLIC_API.failedCacheMinutes * 60_000, v: null as unknown as Promise<LumaEntity | null | LumaApiMiss> };
  entry.v = (async (): Promise<LumaEntity | null | LumaApiMiss> => {
    const r = await apiGet("/v1/entities/lookup", { slug }, d).catch(() => "failed" as const);
    if (typeof r === "string") return r;
    const e = r.body?.entity;
    if (r.status === 200 && e?.type === "event" && typeof e.event?.id === "string") {
      entry.ttl = LUMA_PUBLIC_API.lookupCacheDays * 86_400_000;
      return { type: "event", id: e.event.id, slug: String(e.event.slug ?? slug), startAt: e.event.start_at ?? null, endAt: e.event.end_at ?? null };
    }
    if (r.status === 200 && e?.type === "calendar" && typeof e.calendar?.id === "string") {
      entry.ttl = LUMA_PUBLIC_API.lookupCacheDays * 86_400_000;
      return { type: "calendar", id: e.calendar.id };
    }
    // Luma knows no such slug: a 404, or a 200 naming no event or calendar. Any other status is no answer about it.
    if (r.status === 200 || r.status === 404) {
      entry.ttl = LUMA_PUBLIC_API.missCacheHours * 3_600_000;
      return null;
    }
    return "failed";
  })();
  if (lookupCache.size > 2000) lookupCache.clear();
  lookupCache.set(key, entry);
  const v = await entry.v;
  // A refusal, a denial, a failure or our own stop isn't an answer: not kept.
  if (typeof v === "string" && lookupCache.get(key) === entry) lookupCache.delete(key);
  return v;
}

const eventCache = new Map<string, { at: number; ttl: number; v: Promise<LumaPublicEvent | null | LumaApiMiss> }>();
// What a visitor to a public event could see, from Luma's API, kept an hour (a failure two minutes). null when Luma won't show it.
export async function getPublicLumaEvent(id: string, d: ApiDeps = {}): Promise<LumaPublicEvent | null | LumaApiMiss> {
  const now = (d.now ?? Date.now)();
  const hit = eventCache.get(id);
  if (hit && now - hit.at < hit.ttl) return hit.v;
  const entry = { at: now, ttl: LUMA_PUBLIC_API.failedCacheMinutes * 60_000, v: null as unknown as Promise<LumaPublicEvent | null | LumaApiMiss> };
  entry.v = (async (): Promise<LumaPublicEvent | null | LumaApiMiss> => {
    const r = await apiGet("/v1/events/get", { event_id: id }, d).catch(() => "failed" as const);
    if (typeof r === "string") return r;
    // Luma won't show it (a 404, or a 200 that isn't an event a visitor can see): null. Any other status is no answer.
    if (r.status !== 200 && r.status !== 404) return "failed";
    const e = r.body?.event ?? r.body;
    if (r.status !== 200 || typeof e?.id !== "string" || typeof e?.start_at !== "string") return null;
    entry.ttl = LUMA_PUBLIC_API.eventCacheMinutes * 60_000;
    const geo = e.geo_address_json ?? {};
    const slug = typeof e.url === "string" ? (String(e.url).replace(/[?#].*$/, "").match(/^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/([A-Za-z0-9_-]+)\/?$/i)?.[1] ?? null) : null;
    return {
      id: e.id,
      name: String(e.name ?? "").trim(),
      slug,
      startAt: e.start_at,
      endAt: typeof e.end_at === "string" ? e.end_at : null,
      timezone: typeof e.timezone === "string" ? e.timezone : null,
      visibility: typeof e.visibility === "string" ? e.visibility : null,
      locationType: typeof e.location_type === "string" ? e.location_type : null,
      locationVisibility: typeof e.location_visibility === "string" ? e.location_visibility : null,
      city: typeof geo.city === "string" && geo.city.trim() ? geo.city.trim() : null,
      address: typeof geo.address === "string" ? geo.address : null,
      fullAddress: typeof geo.full_address === "string" ? geo.full_address : null,
      hosts: Array.isArray(e.hosts) ? e.hosts.map((h: any) => h?.name).filter((n: unknown): n is string => typeof n === "string").slice(0, 4) : [],
      description: typeof e.description === "string" && e.description.trim() ? e.description.trim() : null,
      registrationOpen: typeof e.registration_open === "boolean" ? e.registration_open : null,
      requireApproval: typeof e.require_approval === "boolean" ? e.require_approval : null,
      spotsRemaining: typeof e.spots_remaining === "number" ? e.spots_remaining : null,
    };
  })();
  if (eventCache.size > 2000) eventCache.clear();
  eventCache.set(id, entry);
  const v = await entry.v;
  if (typeof v === "string" && eventCache.get(id) === entry) eventCache.delete(id);
  return v;
}
