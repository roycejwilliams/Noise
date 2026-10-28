// The event tier is a kind of page, not a source (Royce, 2026-10-28). Tiers were by where a find came from: 1 Noise's own events, 2
// Luma's feed, 3 everything the web and X turned up. Now any page that carries its own record of being ONE event (Luma's, Partiful's,
// Eventbrite's, Meetup's, or any page with one schema.org Event in its data) is an event, in tier 2, checked against that record the way
// a Luma feed event is checked against Luma's: its start, its end, where it is, who hosts it, its price, whether it's sold out. Everything
// else stays a web find (tier 3) with the web's own checks. That morning MemoryBox's and Vast.ai's launch parties (Luma pages a web
// search found) were checked as web pages and dropped as "nothing about it was verified on its page".
//
// What a page's record must say to count, read by code from the page itself, never from what a search or a post said about it:
//   - one event, named, with a start (a page listing several events is a list, not an event);
//   - public: a Luma or Partiful page says it in its own data (visibility "public"; Partiful's isPublic, and no password). A private
//     invite link is never an event find, however it was found;
//   - a zone its time can be said in: the page's own (Luma's and Partiful's records carry one), else the zone of the city it's in.
//     A time Cue can't say in the right zone isn't an event find (it stays a web find);
//   - for a Partiful page, only its city: Partiful shows the street address to confirmed guests only, while its data carries it.
import { DateTime } from "luxon";
import type { EventDetails } from "./eventDetails.js";
import type { TierMatch } from "./tieredRecommendation.js";

// The page's event record, with its own name.
export type PageEvent = EventDetails & { name: string };
// one: the page is ONE event's own page by its own record, public or not, with a zone or not (what decides that a found page is never
// swapped for a homepage, taskWeb.ts pickPage); event: the record, when it may be an event find.
// private: the page's own record says it isn't public (a private Luma event, a Partiful invite or a password-locked page): never a find
// at all, in any tier (batched review of #299). Not the same as a page that couldn't be read, or one that doesn't say.
// public: a Luma or Partiful page's own record says it's public (the only way a link to either may be a find or shared: final review
// of #299, fail closed, shareableRead).
export type PageEventRead = { event: PageEvent | null; why: string | null; one: boolean; private?: boolean; public?: boolean };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
export const isLumaHost = (url: string) => ["lu.ma", "luma.com"].includes(hostOf(url));
export const isPartifulHost = (url: string) => hostOf(url) === "partiful.com";

// Pure: the page's embedded app data (Luma and Partiful are Next.js pages), or null.
export function nextData(html: string): any | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Pure: every schema.org Event object in the page's JSON-LD.
export function jsonLdEvents(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : data?.["@graph"] ?? [data]).flat();
    for (const x of items) if (/Event$/.test(String(Array.isArray(x?.["@type"]) ? x["@type"].join(" ") : x?.["@type"] ?? ""))) out.push(x);
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const placeOf = (ev: any) => (Array.isArray(ev?.location) ? ev.location[0] : ev?.location) ?? null;

// Pure: what a page's own data says the event is, or why it isn't one. No zone lookup here (settleZone does that).
export function pageEventData(html: string, url: string, parseLuma: (html: string) => EventDetails | null): PageEventRead {
  if (isLumaHost(url)) {
    const data = nextData(html)?.props?.pageProps?.initialData?.data ?? null;
    const visibility = str(data?.event?.visibility);
    const d = parseLuma(html);
    if (visibility && visibility !== "public") return { event: null, why: `its Luma page says it's ${visibility}, not public`, one: !!d, private: true };
    // Public only when it says so (batched review of #299), the way a Partiful page must say isPublic: a page that doesn't say isn't an
    // event find (it's checked as a web page, as before).
    if (visibility !== "public") return { event: null, why: "its Luma page doesn't say it's public", one: !!d || !!data?.event };
    const name = str(data?.event?.name) ?? str(jsonLdEvents(html)[0]?.name);
    if (!d?.startAt || !name) return { event: null, why: "its Luma page has no event record with a start", one: !!d, public: true };
    return { event: { ...d, name, visibility }, why: null, one: true, public: true };
  }
  const evs = jsonLdEvents(html);
  if (!evs.length) return { event: null, why: null, one: false };
  if (evs.length > 1) return { event: null, why: `the page lists ${evs.length} events (a list, not one event)`, one: false };
  const ev = evs[0];
  const name = str(ev.name);
  const startAt = str(ev.startDate);
  if (!name || !startAt || !Number.isFinite(Date.parse(startAt))) return { event: null, why: "its event record has no name or start", one: true };
  const loc = placeOf(ev);
  const addr = loc?.address;
  const locality = typeof addr === "object" && addr ? str(addr.addressLocality) : null;
  const street = typeof addr === "string" ? str(addr) : typeof addr === "object" && addr ? [addr.streetAddress, addr.addressLocality, addr.addressRegion].map(str).filter(Boolean).join(", ") || null : null;
  const offer = Array.isArray(ev.offers) ? ev.offers[0] : ev.offers;
  const org = Array.isArray(ev.organizer) ? ev.organizer : ev.organizer ? [ev.organizer] : [];
  const mode = String(ev.eventAttendanceMode ?? "");
  const base: PageEvent = {
    name,
    startAt,
    endAt: str(ev.endDate),
    timezone: null,
    online: /OnlineEventAttendanceMode/.test(mode),
    venue: str(loc?.name),
    address: street,
    city: locality,
    hosts: org.map((o: any) => str(o?.name)).filter((x: string | null): x is string => !!x).slice(0, 4),
    price: offer?.price !== undefined && offer?.price !== null ? (String(offer.price) === "0" ? "free" : `${offer.price} ${offer.priceCurrency ?? ""}`.trim()) : null,
    spotsRemaining: null,
    requiresApproval: null,
    soldOut: /SoldOut/i.test(String(offer?.availability ?? "")) ? true : null,
    guestCount: null,
    description: null,
    visibility: null,
  };
  if (/EventCancelled/i.test(String(ev.eventStatus ?? ""))) return { event: null, why: "its page says it was cancelled", one: true };
  if (isPartifulHost(url)) {
    const pp = nextData(html)?.props?.pageProps ?? null;
    const pe = pp?.event ?? null;
    if (pp?.passwordRequired === true || pe?.isPublic !== true || (str(pe?.visibility) && pe.visibility !== "public")) return { event: null, why: "not a public Partiful event (a private invite)", one: true, private: true };
    // Only the city: the street is for confirmed guests (the #298 rule).
    return { event: { ...base, venue: null, address: null, timezone: str(pe?.timezone), soldOut: pe?.atCapacity === true ? true : base.soldOut, visibility: "public" }, why: null, one: true, public: true };
  }
  return { event: base, why: null, one: true };
}

// The zone its time is said in: its own, else its city's (geocoding.ts getTimezoneForCity, a cached lookup). None: not an event find.
// Looked up from its city (the record's locality) only: never a street or a venue, which would send an address out and into the lookup
// cache (batched review of #299), and never for an online event (no place to take a zone from).
export async function settleZone(ev: PageEvent, zoneOf: (place: string) => Promise<string | null>): Promise<PageEvent | null> {
  if (ev.timezone) return ev;
  const place = ev.online ? null : ev.city;
  if (!place) return null;
  const zone = await zoneOf(place).catch(() => null);
  return zone ? { ...ev, timezone: zone } : null;
}

// ---------------------------------------------------------------- reading a page for its event record

export type EventPageRead = { html: string | null; text: string | null; event: PageEvent | null; why: string | null; one: boolean; private?: boolean; public?: boolean; error?: string | null };
export type EventPageDeps = {
  fetchHtml: (url: string) => Promise<{ html: string | null; error: string | null }>;
  zoneOf: (place: string) => Promise<string | null>;
  parseLuma: (html: string) => EventDetails | null;
  toText: (html: string) => string;
};
export const realEventPageDeps = async (): Promise<EventPageDeps> => {
  const [L, G, E, W] = await Promise.all([import("./linkReader.js"), import("./geocoding.js"), import("./eventDetails.js"), import("./webOpportunitySearch.js")]);
  return {
    // Every redirect hop checked (linkReader.ts safeFetch), the way every page read is.
    fetchHtml: async (url) => {
      const got = await L.safeFetch(url);
      if ("error" in got) return { html: null, error: got.error };
      if (got.status < 200 || got.status >= 300 || !/text\/html/.test(got.contentType)) return { html: null, error: `HTTP ${got.status}` };
      return { html: got.body, error: null };
    },
    zoneOf: (place) => G.getTimezoneForCity(place),
    parseLuma: E.parseLumaEventPage,
    toText: W.htmlToText,
  };
};

// One read per page: kept an hour when it was an event, two minutes otherwise (the event-detail cache's rule, eventDetails.ts).
export const EVENT_PAGE_CACHE = { okMs: 60 * 60_000, failMs: 2 * 60_000, max: 500 } as const;
const cache = new Map<string, { at: number; read: EventPageRead }>();
// A read already under way is shared (final review of #299: a second check of the same link never fetches it again).
const inFlight = new Map<string, Promise<EventPageRead>>();
export const clearEventPageCache = () => (cache.clear(), inFlight.clear());

export async function readEventPage(url: string, o: { maxAgeMs?: number; deps?: EventPageDeps } = {}): Promise<EventPageRead> {
  const hit = cache.get(url);
  const ttl = hit?.read.event ? Math.min(o.maxAgeMs ?? EVENT_PAGE_CACHE.okMs, EVENT_PAGE_CACHE.okMs) : EVENT_PAGE_CACHE.failMs;
  if (hit && Date.now() - hit.at < ttl) return hit.read;
  const running = inFlight.get(url);
  if (running) return running;
  const p = readEventPageOnce(url, o).finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}
async function readEventPageOnce(url: string, o: { maxAgeMs?: number; deps?: EventPageDeps }): Promise<EventPageRead> {
  const d = o.deps ?? (await realEventPageDeps());
  const got = await d.fetchHtml(url).catch((err: any) => ({ html: null, error: String(err?.message ?? err) }));
  let read: EventPageRead;
  if (!got.html) read = { html: null, text: null, event: null, why: "its page couldn't be read", one: false, error: got.error };
  else {
    const p = pageEventData(got.html, url, d.parseLuma);
    const settled = p.event ? await settleZone(p.event, d.zoneOf) : null;
    read = { html: got.html, text: d.toText(got.html), event: settled, why: p.event && !settled ? "no zone its time can be said in" : p.why, one: p.one, ...(p.private ? { private: true } : {}), ...(p.public ? { public: true } : {}) };
  }
  if (cache.size > EVENT_PAGE_CACHE.max) cache.clear();
  cache.set(url, { at: Date.now(), read });
  return read;
}

// Pure: a link that may be a private event page (Luma's or Partiful's: the platforms whose own record says public or not), by its shape.
export function mayBePrivateEvent(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (isPartifulHost(url)) return /^\/e\/[^/]+$/.test(path);
  if (isLumaHost(url)) return /^\/[A-Za-z0-9_-]+$/.test(path);
  return false;
}

// Pure: whether a link may be a find or be shared, from its read (final review of #299: fail closed). A Luma or Partiful link only when
// its page's own record says it's public, or (Luma) the page was read and holds no event at all (a city or calendar page); unread,
// errored, private or not saying: no. Any other link isn't judged here.
export function shareableRead(url: string, r: { html?: string | null; public?: boolean; one?: boolean; private?: boolean } | null): boolean {
  if (!mayBePrivateEvent(url)) return true;
  if (!r || r.private) return false;
  if (r.public === true) return true;
  return isLumaHost(url) && !!r.html && r.one === false;
}

// The links among these that may not be a find or be shared: every Luma and Partiful link whose page's own record doesn't say public
// (a Partiful invite, a private Luma event), and every one that couldn't be read, errored or wasn't read inside PRIVATE_CHECK.deadlineMs
// (final review of #299: fail closed; all of them are read at once, none left unchecked). Wherever it was found (an X post's link in a
// reply, the sweep), and again before it's shared (agent/loopTools.ts shareFinds).
export const PRIVATE_CHECK = { deadlineMs: 4_000 } as const;
export async function unshareableEventLinks(urls: string[], read: (url: string) => Promise<EventPageRead | { html?: string | null; public?: boolean; one?: boolean; private?: boolean }> = (u) => readEventPage(u)): Promise<Set<string>> {
  const check = [...new Set(urls.filter(mayBePrivateEvent))];
  if (!check.length) return new Set();
  const deadline = new Promise<null>((r) => setTimeout(() => r(null), PRIVATE_CHECK.deadlineMs).unref?.());
  const reads = await Promise.all(check.map((u) => Promise.race([Promise.resolve().then(() => read(u)).catch(() => null), deadline])));
  return new Set(check.filter((u, i) => !shareableRead(u, reads[i])));
}

// For the send-time re-read (sendCheck.ts recheckFind): an event page's record now. Luma's through its own reader (same cache as
// before); any other event page through readEventPage. Null when it can't be read or isn't one event.
export async function eventPageDetails(url: string, maxAgeMs: number): Promise<EventDetails | null> {
  if (isLumaHost(url)) return (await import("./eventDetails.js")).fetchLumaEventDetails(url, { maxAgeMs });
  return (await readEventPage(url, { maxAgeMs })).event;
}

// Pure: an event page's record as an event find (tier 2), the shape the Luma feed's events have (tieredRecommendation.ts asMatch), so
// every reader of an event (the gate, the start check, the send-time re-read, the picker) reads it the same way. Its link stands as its
// id (the way an event on file is keyed, sendCheck.ts onFileMatch).
export function pageEventMatch(ev: PageEvent, url: string, extra: Record<string, unknown> = {}): TierMatch {
  const day = ev.startAt ? DateTime.fromISO(ev.startAt, { zone: "utc" }).setZone(ev.timezone ?? "utc").toISODate() : null;
  const { name, ...details } = ev;
  return { tier: 2, kind: "public_event", event_api_id: url, event_date: day, startAt: ev.startAt, name, url, reason: "A public event.", city: ev.city ?? null, details, ...extra } as unknown as TierMatch;
}
