// Tier 2 through Exa (Royce, 2026-10-17: "Finish the Tier 2 Exa build. I'm approving it ... it finds the Luma events the feed misses").
// Luma's public Discover feed holds only the city's featured events (55 for San Francisco, 19 for Chicago on 10-17), the same few for
// every want. One Exa search limited to Luma's own pages, written from the want, the city and the asked dates, finds the rest: on 10-17
// it found 7 SF founder events in the asked week that the feed didn't have (the feed's names fit 2), and 8 SF supper clubs in late
// October (the feed: 0).
// Each Luma link Exa finds is checked through Luma's official API, never by reading its page (Royce, 2026-10-19: "tier 2 should use
// the api"): GET /v1/entities/lookup turns its slug into an event id (calendars are skipped), and GET /v1/events/get gives what a
// visitor could see (services/luma.ts). It's kept only when public, upcoming, inside the asked window and with a place (or online);
// it then joins the feed's events (services/tieredRecommendation.ts eventCandidates) and goes through the same nearby filter, ranking,
// gate and start check (#229) as a feed event, with the API's details in place of a page read, and goes out as a Luma link, tier 2.
// When the API can't be used (2026-10-31 on: 403, no active Luma Plus plan on Noise's calendar; or no key, or a 429 pause), each link is
// checked on its own public page instead, by the same rules (the page route below, Royce 2026-11-10); when neither can check, no paid
// Exa search runs, and the report says so once as a source-wide failure.
// Exa's index keeps old pages too, so most results are past (71 of 106 on 10-17): the lookup's start and end decide that first.
// Cost: one Exa search per want, city and dates, $0.022 measured (25 results, no page text); the Luma API calls are free, cached
// (a slug's id for days, an event an hour) and stopped at LUMA_PUBLIC_API.perMinute. What Exa found is kept for CACHE_HOURS, so a
// sweep and a reply on the same want don't pay twice; a search that failed isn't kept. Off without EXA_API_KEY or LUMA_API_KEY, and
// skipped where a turn can't wait for it (calls).
import { nearestPlace, type DiscoveredEvent, type DiscoverPlace } from "./lumaDiscovery.js";
import type { GeoPoint } from "./geocoding.js";
import type { EventDetails } from "./eventDetails.js";
import type { LumaApiDenial, LumaApiMiss, LumaEntity, LumaPublicEvent } from "./luma.js";
import type { LumaPageRecord } from "./eventDetails.js";
import type { ExaSearch } from "./exaSearch.js";
import { skipsPaidSearch } from "./testMemberSpend.js";

export const LUMA_VIA_EXA = { results: 25, timeoutMs: 10_000, cacheHours: 6 } as const;
export const LUMA_DOMAINS = ["lu.ma", "luma.com"];

// ---------------------------------------------------------------- what Exa is sent (Royce, 2026-10-18, option (d): "Send Exa only a
// generic search, never the member's words.") Exa's API terms (1.2(c)) license Exa to keep and use whatever it's sent, forever. So
// the query is built only from fixed parts: kinds of event from this list (matched in the want, never copied from it), the city,
// the dates Cue worked out, and online or in person. No name, company, goal, plan or any other word of theirs. A want with no kind
// on the list searches plain "events" for the city and dates.
// Matches are narrow on purpose: a word that's also everyday talk ("talk about her raise", "book a table", "no energy") isn't one.
export const EVENT_KINDS: readonly { kind: string; match: RegExp }[] = [
  { kind: "startup founder", match: /\b(founders?|startups?|entrepreneurs?)\b/i },
  { kind: "investor", match: /\b(investors?|vcs?|venture capital|angels? investors?|lps?)\b/i },
  { kind: "climate tech", match: /\b(climate|clean ?tech|sustainab\w*|renewables?|clean energy)\b/i },
  { kind: "hardware", match: /\b(hardware|robotics?|deep ?tech|hard ?tech)\b/i },
  { kind: "AI", match: /\b(ai|a\.i\.|machine learning|llms?|artificial intelligence)\b/i },
  { kind: "tech", match: /\b(tech|engineers?|developers?|devtools|software|coding)\b/i },
  { kind: "design", match: /\b(design|designers?|ux)\b/i },
  { kind: "hackathon", match: /\bhackathons?\b/i },
  { kind: "demo day", match: /\b(demo days?|pitch (nights?|events?))\b/i },
  { kind: "networking", match: /\b(networking|mixers?)\b/i },
  { kind: "meetup", match: /\bmeet-?ups?\b/i },
  { kind: "talk", match: /\b(talks|panels?|fireside chats?|lectures?|speaker series|speaker events?)\b/i },
  { kind: "conference", match: /\b(conferences?|summits?)\b/i },
  { kind: "workshop", match: /(?<![-\w])(workshops?|class(?:es)?)(?![-\w])/i },
  { kind: "supper club", match: /\bsupper clubs?\b/i },
  { kind: "chef's table dinner", match: /\bchef'?s tables?\b/i },
  { kind: "dinner", match: /\b(dinners?|dining)\b/i },
  { kind: "wine tasting", match: /\b(wine|tastings?)\b/i },
  { kind: "happy hour", match: /\b(happy hours?|drinks|cocktails?)\b/i },
  { kind: "live music", match: /\b(live music|concerts?|gigs?|live shows?|music shows?)\b/i },
  { kind: "jazz", match: /\bjazz\b/i },
  { kind: "art gallery opening", match: /\b(galler(y|ies)|art openings?|art receptions?|exhibitions?|exhibits?)\b/i },
  { kind: "art", match: /(?<![-\w])(art|artists?)(?![-\w])/i },
  { kind: "film screening", match: /\b(films?|screenings?|movies?|cinema)\b/i },
  { kind: "comedy", match: /\b(comedy|stand-?up)\b/i },
  { kind: "book club", match: /\b(book clubs?|author talks?|book readings?|poetry readings?|literary)\b/i },
  { kind: "run club", match: /\b(run clubs?|running clubs?|group runs?|5k|10k)\b/i },
  { kind: "hiking", match: /\b(hik(e|es|ing)|trails?|outdoors?)\b/i },
  { kind: "yoga", match: /\byoga\b/i },
  { kind: "wellness", match: /\b(wellness|meditation|breathwork|sound baths?)\b/i },
  { kind: "dance", match: /\b(danc(e|es|ing)|club nights?|djs?)\b/i },
  { kind: "party", match: /\bpart(y|ies)\b/i },
  { kind: "community", match: /\bcommunity\b/i },
  { kind: "fundraiser", match: /\b(fundraisers?|galas?|charity)\b/i },
];
const MAX_KINDS = 3;
// The city is only ever a name from Luma's own catalog of discover cities (services/lumaDiscovery.ts discoverPlaceFor: the
// catalog's place.name, matched by name or by distance), never the string it was given: "Jordan's place", "my ex's house" or
// "Mount Sinai Hospital" become the catalog city they're near, or no city at all. The shape check stays as a last line.
const CITY = /^[A-Za-z][A-Za-z .'-]{1,39}$/;
// The dates as eventCandidates writes them ("October 19 to October 25, 2026"), with real month names; anything else is left out.
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const DATES = new RegExp(`^${MONTH} \\d{1,2} to ${MONTH} \\d{1,2}, \\d{4}$`);

// Pure: the catalog place for a city, by the catalog's own rule (lumaDiscovery.ts nearestPlace): the name a search may use, or null.
export function catalogCity(places: DiscoverPlace[], city: string | null, point: GeoPoint | null = null): { name: string } | null {
  if (!city?.trim()) return null;
  const p = nearestPlace(places, city, point);
  return p ? { name: p.name } : null;
}

// Pure: the one Exa query for a Luma event search, from fixed parts only, and the kinds it used. place is a catalog place
// (catalogCity / discoverPlaceFor), never a string the member or the model wrote.
export function lumaExaQuery(what: string, place: { name: string } | null, dates: string): { query: string; kinds: string[] } {
  const text = String(what ?? "");
  const kinds = EVENT_KINDS.filter((k) => k.match.test(text)).map((k) => k.kind);
  // "supper club" and "chef's table dinner" already say dinner; "art gallery opening" already says art.
  const shown = kinds.filter((k) => !(k === "dinner" && kinds.some((x) => /dinner|supper/.test(x) && x !== "dinner")) && !(k === "art" && kinds.includes("art gallery opening"))).slice(0, MAX_KINDS);
  const how = /\b(online|virtual|zoom|remote)\b/i.test(text) ? " online" : /\bin[- ]person\b/i.test(text) ? " in person" : "";
  const where = place?.name && CITY.test(place.name.trim()) ? ` in ${place.name.trim()}` : "";
  const when = DATES.test(dates.trim()) ? `, ${dates.trim()}` : "";
  return { query: `${shown.length ? `${shown.join(", ")} ` : ""}events${how}${where}${when}`, kinds: shown };
}
// Luma paths that are never one event's page (also read by taskWeb.ts eventPageUrl). about, blog, terms, signup and search: review of
// #293. A city page (lu.ma/sf) or a calendar's own name (lu.ma/genai-sf) has the same shape as an event's: only its page tells.
export const LUMA_NOT_EVENTS = new Set(["discover", "home", "signin", "signup", "login", "create", "calendar", "explore", "pricing", "user", "u", "settings", "help", "about", "blog", "terms", "search"]);

// Pure: the event's slug when the url is one Luma event page (lu.ma/abc123, luma.com/abc123), else null.
export function lumaEventSlug(url: string): string | null {
  const m = String(url).replace(/[?#].*$/, "").match(/^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/([A-Za-z0-9_-]+)\/?$/i);
  if (!m || LUMA_NOT_EVENTS.has(m[1].toLowerCase())) return null;
  return m[1];
}
// Pure: Exa's page title without Luma's own suffix.
export const eventTitle = (title: string | null | undefined) => String(title ?? "").replace(/\s*[·|–—-]\s*Luma\s*$/i, "").trim();

// An event Exa found, as Luma's API describes it: details are the event's own (from /v1/events/get), so nothing after this reads its
// page.
export type ViaExaEvent = DiscoveredEvent & { online?: boolean; details: EventDetails };
// Luma's location types that are a known online platform (its spec's enum: discord, meet, twitch, twitter, youtube, zoom; plus "online"
// should Luma send it). Everything else is treated as not online.
export const ONLINE_LOCATION_TYPES: ReadonlySet<string> = new Set(["online", "zoom", "meet", "google_meet", "discord", "twitch", "twitter", "youtube"]);
// Luma's in-person location type. Only this, with a city, is a confirmed place; see the keep step in lumaEventsViaExa.
export const IN_PERSON_LOCATION_TYPE = "offline";
// What one search did, for the log (counts only: the query is the member's want).
// pages: Luma links Exa returned. looked: links Luma's API resolved (lookup). calendars: links that were a calendar, not an event
// (skipped). past: events the lookup already showed are over or outside the window (not read further). read: events read from the
// API. notPublic: read but not listed as public by their host (dropped). noLocation: no confirmed place (not a named online platform, nor in person with a city; dropped). refused:
// lookups or reads Luma answered 429. limited: left unread because our own per-minute stop was reached. denied: Luma refused the key
// (401/403: the API itself is down for us, never "no such event"). failed: no usable answer (timed out, unreachable, unreadable).
// kept: public, upcoming, inside the window, with a place.
// sourceDown: the check every candidate needs couldn't run at all (the key refused): said once per search, never once per event.
// error: what failed and what to do about it, for the log (never the member: they get the feed's events as before).
// kinds: the fixed kinds the search used (from EVENT_KINDS, never their words).
export type ViaExaReport = {
  cached: boolean;
  error: string | null;
  pages: number;
  looked?: number;
  calendars?: number;
  past?: number;
  read: number;
  notPublic: number;
  noLocation?: number;
  refused?: number;
  limited?: number;
  denied?: number;
  failed?: number;
  // The page route (when Luma's API can't be used): missing: the link's page isn't there (404/410); cancelled: its own record says so;
  // blocked: Luma didn't serve the page to us (403/429/503 or an access check), and the rest of the search was left unread.
  missing?: number;
  cancelled?: number;
  blocked?: number;
  kept: number;
  kinds?: string[];
  sourceDown?: boolean;
  // How the links were checked: Luma's API, or each event's own public page.
  route?: "api" | "page";
  // Why the API wasn't used, when the page route stood in (for the log; not a failure while the pages answer).
  apiDown?: string;
};

// Pure: why a Luma search through Exa failed, said with its fix, from exaSearch's error (or what a call threw). Timed out, refused
// with an HTTP status, unreachable, unreadable: each its own line. Every one ends the same way, because that's what the member got.
const FEED_ALONE = "tier 2 went out from Luma's feed alone";
export function exaFailureReason(error: string | null): string | null {
  if (!error) return null;
  const status = error.match(/^Exa (\d{3})\b\s*(.*)$/);
  if (/timed out/i.test(error)) return `Exa timed out (no answer in ${LUMA_VIA_EXA.timeoutMs / 1000}s); ${FEED_ALONE}; the next search for this want asks Exa again (a failed search isn't kept)`;
  if (status) {
    const s = Number(status[1]);
    const tag = status[2] ? ` ${status[2]}` : "";
    if (s === 401 || s === 403) return `Exa refused the key (HTTP ${s}${tag}): check EXA_API_KEY on this service; ${FEED_ALONE}`;
    if (s === 402) return `Exa says the account is out of credit (HTTP 402${tag}): add credit in Exa's dashboard; ${FEED_ALONE}`;
    if (s === 429) return `Exa rate-limited the search (HTTP 429${tag}); ${FEED_ALONE}; the next search asks again`;
    if (s >= 500) return `Exa's own side failed (HTTP ${s}${tag}); ${FEED_ALONE}; the next search asks again`;
    return `Exa rejected the request (HTTP ${s}${tag}): the request services/lumaViaExa.ts builds needs fixing; ${FEED_ALONE}`;
  }
  if (/couldn't be reached/i.test(error)) return `Exa couldn't be reached (network): check this service's outbound connection to api.exa.ai; ${FEED_ALONE}`;
  if (/couldn't be read/i.test(error)) return `Exa answered with a reply that couldn't be read; ${FEED_ALONE}; the next search asks again`;
  if (/isn't configured/i.test(error)) return EXA_OFF;
  return `the Luma search through Exa threw (${error.replace(/^threw:\s*/, "").slice(0, 120)}); ${FEED_ALONE}`;
}
// Luma's API refused this search's checks (429), or our own per-minute stop was reached: said with the counts, and what happens next.
export const lumaRefusedReason = (refused: number, limited: number, pages: number, pauseMinutes: number) =>
  `${refused ? `Luma's API refused ${refused} of ${pages} checks (429)` : ""}${refused && limited ? "; " : ""}${limited ? `${limited} of ${pages} were left unchecked at the per-minute stop` : ""}: those events couldn't be checked, so they were left out${refused ? `; the Luma search through Exa pauses for ${pauseMinutes} minutes` : ""}`;
// Luma's API refusing in the last few minutes: no Exa search at all (its results couldn't be checked, so it would be paid for nothing).
export const lumaRefusingReason = (pauseMinutes: number) =>
  `Luma's API refused a request (429) in the last ${pauseMinutes} minutes, so no Luma search through Exa (its results couldn't be checked); ${FEED_ALONE}; it searches again once ${pauseMinutes} minutes pass without a refusal`;
// Luma's API refused the key (401/403, e.g. no active Luma Plus plan): its checks can't run, so what Exa would find can't be told from
// "no such event". Said once per search, with Luma's own words and when it's tried again (one free API call, never a paid search).
const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));
export const lumaDeniedReason = (d: Pick<LumaApiDenial, "status" | "message" | "until"> | null, now: number, counts?: { denied: number; pages: number }) =>
  `Luma's API refused the key (HTTP ${d?.status ?? 403}${d?.message ? `: "${d.message}"` : ""})${counts ? `, so ${counts.denied} of ${counts.pages} Luma links went unchecked (not "no such event")` : ""}; no Luma search through Exa runs while its results can't be checked; ${FEED_ALONE}; ${d ? `a free API check runs again in ${mins(d.until - now)} minutes` : "a free API check runs on the next search"}`;
// Luma didn't serve its pages to us (an access check, a 403, 429 or 503): the page route stops and pauses, the way the API does; nothing
// is retried quickly and no paid search runs while neither route can check what it finds.
export const lumaPagesBlockedReason = (why: string, until: number, now: number, apiWhy: string | null, counts?: { blocked: number; pages: number }) =>
  `Luma's event pages weren't served to us (${why})${counts ? `, so ${counts.blocked} of ${counts.pages} Luma links went unchecked (not "no such event")` : ""}${apiWhy ? `, and its API can't be used (${apiWhy})` : ""}; no Luma search through Exa runs while its results can't be checked; ${FEED_ALONE}; the pages are tried again (one free read) in ${mins(until - now)} minutes`;
// Some checks got no answer at all (timed out, unreachable, unreadable): those events are unchecked, not missing.
export const lumaFailedReason = (failed: number, pages: number) =>
  `${failed} of ${pages} Luma checks got no usable answer (timed out, unreachable or unreadable): those events went unchecked, not "no such event"`;
// No Luma API key: Exa's links can't be checked, so Exa isn't asked (it would be paid for nothing).
export const LUMA_API_OFF = `LUMA_API_KEY isn't set on this service, so Exa's Luma links can't be checked and no Luma search through Exa runs; ${FEED_ALONE}; set LUMA_API_KEY to turn it on`;

// ---------------------------------------------------------------- the daily budget (Royce, 2026-10-18: "60 a day, 20 held for member asks")
// All members together: LUMA_EXA_DAILY_CAP Exa searches in any 24 hours, LUMA_EXA_REQUEST_RESERVE of them held for what a member
// asked for (replies and tasks); the sweep stops at the cap minus the reserve. Limits, not switches. A cache hit makes no Exa call,
// so it doesn't count. The same shape and lock as the web search budget (services/webOpportunitySearch.ts reserveWebSearch).
const envLimit = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
export const LUMA_EXA_BUDGET = { dailyCap: envLimit(process.env.LUMA_EXA_DAILY_CAP, 60), requestReserve: envLimit(process.env.LUMA_EXA_REQUEST_RESERVE, 20) };
export type LumaExaSource = "request" | "sweep";

// Pure: whether one more Luma search through Exa fits today's budget, and why not, with what the member got.
export function lumaExaBudget(usedToday: number, source: LumaExaSource, dailyCap: number = LUMA_EXA_BUDGET.dailyCap, requestReserve: number = LUMA_EXA_BUDGET.requestReserve): { ok: boolean; reason: string | null } {
  const reserve = Math.max(0, Math.min(requestReserve, dailyCap));
  if (usedToday >= dailyCap) return { ok: false, reason: `the daily cap of ${dailyCap} Luma searches through Exa is reached; ${FEED_ALONE}; it frees up as the 24-hour window rolls` };
  if (source === "sweep" && usedToday >= dailyCap - reserve)
    return { ok: false, reason: `the sweep's share of Luma searches through Exa is used (${dailyCap - reserve} of ${dailyCap}; the rest is held for member asks); ${FEED_ALONE}; it frees up as the 24-hour window rolls` };
  return { ok: true, reason: null };
}

// Reserves one search against the budget, or says why not. The count and the insert happen under one transaction-scoped advisory
// lock, so two searches can't both take the last slot. Fails closed: if the budget can't be checked, there's no Exa search. The log
// keeps who, which share and when: never the query (it's the member's want).
export async function reserveLumaExaSearch(userId: string | null, source: LumaExaSource, db?: { connect: () => Promise<any> }): Promise<{ ok: boolean; reason: string | null }> {
  // A test account never spends on a paid search (services/testMemberSpend.ts, #271): no slot is taken, no Exa search runs.
  if (await skipsPaidSearch(userId, "lumaViaExa")) return { ok: false, reason: TEST_ACCOUNT };
  let client: any = null;
  try {
    client = await (db ?? (await import("../db/db.js")).default).connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('luma_exa_search_budget'))");
    const { rows } = await client.query(`SELECT COUNT(*)::int AS today FROM luma_exa_search_log WHERE created_at > NOW() - INTERVAL '1 day'`);
    const decision = lumaExaBudget(Number(rows[0]?.today ?? 0), source);
    if (!decision.ok) {
      await client.query("ROLLBACK");
      return decision;
    }
    await client.query(`INSERT INTO luma_exa_search_log (user_id, source) VALUES ($1, $2)`, [userId, source]);
    await client.query("COMMIT");
    return decision;
  } catch (err: any) {
    await client?.query("ROLLBACK").catch(() => {});
    return { ok: false, reason: `the daily budget for Luma searches through Exa couldn't be checked (${String(err?.message ?? err).slice(0, 80)}), so no Exa search; ${FEED_ALONE}` };
  } finally {
    client?.release?.();
  }
}

// Off, not failed: said once per start of the service (services/tieredRecommendation.ts), not on every search.
export const EXA_OFF = "EXA_API_KEY isn't set on this service, so tier 2 is Luma's feed alone; set EXA_API_KEY to turn on the Luma search through Exa";

export type LumaViaExaDeps = {
  exa: (query: string, o: { purpose: string; userId: string | null; pages: number; text: false; includeDomains: string[]; timeoutMs: number }) => Promise<ExaSearch>;
  // Luma's official API (services/luma.ts): a slug to an event or calendar, and a public event's visitor-visible details. Never a page
  // read.
  lookup: (slug: string) => Promise<LumaEntity | null | LumaApiMiss>;
  event: (id: string) => Promise<LumaPublicEvent | null | LumaApiMiss>;
  lumaApi: () => boolean;
  // Whether the API answers this key now (services/luma.ts lumaApiState: a denial pauses it, recovery is one free call), and the
  // denial in force, for the report.
  apiState: () => Promise<"ok" | "denied" | "off">;
  denial: () => LumaApiDenial | null;
  // An event's own public page (services/eventDetails.ts readLumaPage + lumaPageRecord), read when the API can't be used: what the
  // page's embedded record says, or why there's no answer. A plain page fetch: no browser, no key, no model.
  page: (slug: string) => Promise<LumaPageCheck>;
  configured: () => boolean;
  now: () => Date;
  // Luma's API answered 429 in the last LUMA_PUBLIC_API.refusalPauseMinutes (services/luma.ts).
  refusing: () => boolean;
  pauseMinutes: number;
  reserve: (userId: string | null, source: LumaExaSource) => Promise<{ ok: boolean; reason: string | null }>;
  // The catalog place for the city (lumaDiscovery.ts discoverPlaceFor), or null: the only city a query may name.
  place: (city: string | null) => Promise<{ name: string } | null>;
};

// ---------------------------------------------------------------- the page route (Royce, 2026-11-10: "add a public-page verification
// route using existing fetching capabilities"). Luma's API needs Luma Plus on Noise's calendar (403 from 2026-10-31). An event's own
// page carries the same record a visitor sees, in its embedded data (2026-11-10 sample of 17 real lu.ma links, read with readLumaPage):
// visibility ("public", or "private" = anyone with the link, never listed; a private page also asks search engines not to index it and
// has no schema.org record), start, end and zone, location type and city, whether the street is shown, registration ("open",
// "waitlist", "sold-out"), approval, spots, and (schema.org eventStatus) whether it's cancelled. What it doesn't say stays unknown.
// Same rules as the API: public only (fails closed), a confirmed place, upcoming, inside the window.
export type LumaPageCheck =
  | { kind: "event"; record: LumaPageRecord }
  | { kind: "not_event" }
  | { kind: "missing" }
  | { kind: "blocked"; why: string }
  // served: the page came back as Luma's app (its __NEXT_DATA__), even though it isn't a readable event: Luma is serving us pages.
  | { kind: "failed"; why: string; served?: boolean };
// Luma's (Cloudflare's) access-check pages: never read as an answer.
const CHALLENGE = /cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required|cf-browser-verification/i;
// Pure: what one page read says. A 404/410 is a page that isn't there; a 403/429/503 or an access check is Luma not serving it to us
// (blocked, never "no such event"); no answer or an unreadable page is failed; a page with no event record is a calendar's or a city's.
export function classifyLumaPage(r: { html: string | null; status: number | null; error: string | null }, record: (html: string) => LumaPageRecord | null): LumaPageCheck {
  if (r.status === 404 || r.status === 410) return { kind: "missing" };
  if (r.status === 403 || r.status === 429 || r.status === 503) return { kind: "blocked", why: `HTTP ${r.status}` };
  if (!r.html) return { kind: "failed", why: r.error ?? "no page" };
  const app = /<script id="__NEXT_DATA__"/.test(r.html);
  if (!app && CHALLENGE.test(r.html)) return { kind: "blocked", why: "an access check page" };
  if (!app) return { kind: "failed", why: "a page without Luma's event data" };
  // By the parsed path only (review of #447: a loose "event": { match read lu.ma/discover's and lu.ma/sf's listings as a broken event
  // page): no initialData.data.event is a calendar's, a city's or a listing page; an event there with no readable record is failed.
  const m = r.html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let data: any = undefined;
  try {
    data = m ? JSON.parse(m[1])?.props?.pageProps?.initialData?.data : undefined;
  } catch {
    return { kind: "failed", why: "Luma's page data couldn't be read", served: true };
  }
  if (!data?.event || typeof data.event !== "object") return { kind: "not_event" };
  const rec = record(r.html);
  if (rec) return { kind: "event", record: rec };
  return { kind: "failed", why: "its event record has no start", served: true };
}
export const LUMA_PAGES = { concurrency: 5, blockedPauseMinutes: 30, blockedPauseMaxMinutes: 24 * 60, okCacheMinutes: 60, okProbeMinutes: 10 } as const;
let pagesBlocked: { at: number; until: number; why: string; streak: number } | null = null;
export const lumaPagesBlocked = (now: number = Date.now()) => (pagesBlocked && now < pagesBlocked.until ? pagesBlocked : null);
function notePagesBlocked(now: number, why: string): void {
  if (pagesBlocked && now < pagesBlocked.until) return;
  const streak = (pagesBlocked?.streak ?? 0) + 1;
  const pause = Math.min(LUMA_PAGES.blockedPauseMinutes * 2 ** (streak - 1), LUMA_PAGES.blockedPauseMaxMinutes) * 60_000;
  pagesBlocked = { at: now, until: now + pause, why, streak };
}
// For tests.
export const resetLumaPages = () => ((pagesBlocked = null), (pagesOkAt = 0), pageCache.clear());
// A page read that found the event (or that it isn't there) is kept an hour; a failure or a block isn't kept.
const pageCache = new Map<string, { at: number; v: LumaPageCheck }>();
async function checkPage(slug: string, deps: LumaViaExaDeps, now: number): Promise<LumaPageCheck> {
  const key = slug.toLowerCase();
  const hit = pageCache.get(key);
  if (hit && now - hit.at < LUMA_PAGES.okCacheMinutes * 60_000) return hit.v;
  const v = await deps.page(slug).catch((err: any): LumaPageCheck => ({ kind: "failed", why: String(err?.message ?? err).slice(0, 80) }));
  if (v.kind === "event" || v.kind === "missing" || v.kind === "not_event") {
    if (pageCache.size > 2000) pageCache.clear();
    pageCache.set(key, { at: now, v });
  }
  return v;
}
// Whether the page route can be used now: blocked while its pause is in force. Otherwise, unless a page was served in the last
// okProbeMinutes, one free read of Luma's own discover page shows whether pages are served (before any paid search depends on it).
let pagesOkAt = 0;
async function pagesUsable(deps: LumaViaExaDeps, now: number): Promise<boolean> {
  if (lumaPagesBlocked(now)) return false;
  if (!pagesBlocked && now - pagesOkAt < LUMA_PAGES.okProbeMinutes * 60_000) return true;
  const probe = await deps.page("discover").catch((): LumaPageCheck => ({ kind: "failed", why: "threw" }));
  if (probe.kind === "blocked") {
    notePagesBlocked(now, probe.why);
    return false;
  }
  // Any 200 page carrying Luma's app data counts as served (review of #447). No answer at all: unknown, so no paid search this time
  // (nothing is paused; the next search reads it again).
  if (probe.kind === "failed" && !probe.served) return false;
  pagesBlocked = null;
  pagesOkAt = now;
  return true;
}

type Found = { slug: string; title: string };
// reason: a refusal already said in full (the budget), not an Exa error to explain.
type Searched = { found: Found[]; error: string | null; reason?: string };
const cache = new Map<string, { at: number; found: Promise<Searched> }>();
export const clearLumaViaExaCache = () => cache.clear();

// Why an Exa search didn't run for want of a place, with its fix (said in the report, like every other failure).
export const NO_PLACE = `no city Luma's catalog confirms for this ask, so no search through Exa; ${FEED_ALONE}`;
export const CATALOG_DOWN = `Luma's city catalog couldn't be read, so no search through Exa; ${FEED_ALONE}`;
export const TEST_ACCOUNT = `a test account: paid search is off for it; ${FEED_ALONE}`;

// Luma events Exa finds for this want, each checked through Luma's official API (never its page): public, upcoming, inside the window
// (inRange decides, the same test the feed's events get), with a place or online, and with the start, end, city and details Luma's
// API gives. null when Exa isn't configured or there's no want. Never throws: a failed search or check is fewer events, and says so.
export async function lumaEventsViaExa(
  what: string,
  city: string | null,
  o: { userId?: string | null; source?: LumaExaSource; inRange: (startAt: string) => boolean; dates: string; deps?: Partial<LumaViaExaDeps> },
): Promise<{ events: ViaExaEvent[]; report: ViaExaReport } | null> {
  const deps = await realDeps(o.deps);
  if (!deps.configured() || !what.trim()) return null;
  // How Exa's links are checked: Luma's API when it answers this key, else each event's own public page. Neither: no paid search whose
  // results couldn't be checked, said once as a source-wide failure, never "nothing found".
  const nowMs = deps.now().getTime();
  const apiState = deps.lumaApi() ? await deps.apiState().catch(() => "denied" as const) : "off";
  const apiWhy = apiState === "off" ? "LUMA_API_KEY isn't set" : apiState === "denied" ? lumaDeniedReason(deps.denial(), nowMs).split(";")[0] : deps.refusing() ? `it answered 429 in the last ${deps.pauseMinutes} minutes` : null;
  const route: "api" | "page" = apiWhy ? "page" : "api";
  if (route === "page" && !(await pagesUsable(deps, nowMs))) {
    const b = lumaPagesBlocked(nowMs) ?? pagesBlocked;
    return { events: [], report: { cached: false, error: lumaPagesBlockedReason(b?.why ?? "no answer", b?.until ?? nowMs, nowMs, apiWhy), pages: 0, read: 0, notPublic: 0, kept: 0, sourceDown: true, route } };
  }
  // A test account never spends on a paid search (services/testMemberSpend.ts, #271): checked before the shared cache, so its refusal
  // is never another member's answer. reserveLumaExaSearch checks again.
  if (o.userId && (await skipsPaidSearch(o.userId, "lumaViaExa"))) return { events: [], report: { cached: false, error: TEST_ACCOUNT, pages: 0, read: 0, notPublic: 0, kept: 0 } };
  // Never their words: the query (and so the cache key) is built from fixed parts only.
  let catalogDown = false;
  const place = await deps.place(city).catch(() => ((catalogDown = true), null));
  // No place Cue can confirm from Luma's catalog: no Exa search for in-person events, since the query would search everywhere for
  // events they can't get to; the feed alone answers. An online ask needs no place: it searches, and keeps online events only.
  const onlineOnly = !place && lumaExaQuery(what, null, o.dates).query.includes(" online");
  if (!place && !onlineOnly) return { events: [], report: { cached: false, error: catalogDown ? CATALOG_DOWN : NO_PLACE, pages: 0, read: 0, notPublic: 0, kept: 0 } };
  const { query, kinds } = lumaExaQuery(what, place, o.dates);
  const key = query.toLowerCase();
  const now = deps.now();
  const hit = cache.get(key);
  const fresh = hit && now.getTime() - hit.at < LUMA_VIA_EXA.cacheHours * 3_600_000;
  let entry = fresh ? hit : null;
  if (!entry) {
    // Only a search that will call Exa takes a slot of the daily budget; the sweep is the default share (the stricter one).
    const userId = o.userId ?? null;
    entry = {
      at: now.getTime(),
      found: deps
        .reserve(userId, o.source ?? "sweep")
        .catch((err: any) => ({ ok: false, reason: `the daily budget for Luma searches through Exa couldn't be checked (${String(err?.message ?? err).slice(0, 80)}), so no Exa search; ${FEED_ALONE}` }))
        .then((b): Promise<Searched> => (b.ok ? search(query, userId, deps) : Promise.resolve({ found: [], error: "budget", reason: b.reason ?? "no budget" }))),
    };
    if (cache.size > 200) cache.clear();
    cache.set(key, entry);
  }
  const mine = entry;
  const { found, error, reason } = await mine.found;
  // A failed search is never kept: the next ask searches again.
  if (error && cache.get(key) === mine) cache.delete(key);
  const n = { looked: 0, calendars: 0, past: 0, read: 0, notPublic: 0, noLocation: 0, refused: 0, limited: 0, denied: 0, failed: 0, missing: 0, cancelled: 0, blocked: 0 };
  const miss = (m: LumaApiMiss) => {
    if (m === "refused") n.refused++;
    else if (m === "limited") n.limited++;
    else if (m === "denied") n.denied++;
    else if (m === "failed" || m === "off") n.failed++;
  };
  // Over, or outside the asked window, by its own start and end.
  const pastOrOutside = (startAt: string | null, endAt: string | null) =>
    (endAt ? new Date(endAt).getTime() <= now.getTime() : false) || (!!startAt && (new Date(startAt).getTime() <= now.getTime() || !o.inRange(startAt)));
  // The same keep rules whichever route read the event. extra: what only the page says (price, headcount, registration state).
  const keep = (e: LumaPublicEvent, slug: string, title: string, extra: Partial<EventDetails> = {}): ViaExaEvent | null => {
    // A host's private or members-only event never goes to strangers; unknown is not public (fails closed).
    if (e.visibility !== "public") return n.notPublic++, null;
    // A confirmed place only (Royce 2026-10-23, "unknown" ruling): online on a meeting platform Luma's spec names (location_type
    // enum, docs.luma.com Get Event), or in person ("offline") with a city in its own record. Anything else ("unknown", which Luma
    // uses for an online link it doesn't recognize; no type; values outside the spec) is dropped even when it carries a city: its
    // place can't be confirmed, so it is never offered as in the member's city, and there is no "location unconfirmed" caption.
    const online = !!e.locationType && ONLINE_LOCATION_TYPES.has(e.locationType);
    const inPerson = e.locationType === IN_PERSON_LOCATION_TYPE && !!e.city;
    if (!online && !inPerson) return n.noLocation++, null;
    // With no confirmed place (an online ask), only an online event is kept: an in-person one could be anywhere.
    if (onlineOnly && !online) return n.noLocation++, null;
    const shown = e.locationVisibility === "public";
    const details: EventDetails = {
      startAt: e.startAt,
      endAt: e.endAt,
      timezone: e.timezone,
      online,
      // The address only when the host shows it to everyone; otherwise the city alone (as the event page does).
      venue: shown ? e.address : null,
      address: shown ? e.fullAddress : null,
      city: e.city,
      hosts: e.hosts,
      price: null,
      spotsRemaining: e.spotsRemaining,
      requiresApproval: e.requireApproval,
      // Closed to new registrations, or no spots left: the gate says no, as it does for a sold-out page.
      soldOut: e.registrationOpen === false || e.spotsRemaining === 0 ? true : false,
      guestCount: null,
      description: e.description ? e.description.slice(0, 900) : null,
      apiId: e.id,
      name: e.name || title,
      visibility: e.visibility,
      ...extra,
    };
    return { api_id: e.id, name: e.name || title, start_at: e.startAt, city: e.city, url: `https://lu.ma/${e.slug ?? slug}`, ...(online ? { online: true } : {}), details };
  };
  const viaApi = async ({ slug, title }: Found): Promise<ViaExaEvent | null> => {
    const entity = await deps.lookup(slug).catch(() => "failed" as const);
    if (typeof entity === "string") return miss(entity), null;
    if (!entity) return n.missing++, null;
    n.looked++;
    if (entity.type === "calendar") return n.calendars++, null;
    // The lookup gives the start and end: one that's over or outside the window isn't read any further.
    if (pastOrOutside(entity.startAt, entity.endAt)) return n.past++, null;
    const e = await deps.event(entity.id).catch(() => "failed" as const);
    if (typeof e === "string") return miss(e), null;
    if (!e) return n.missing++, null;
    n.read++;
    return keep(e, entity.slug ?? slug, title);
  };
  let stopped: string | null = null;
  const viaPage = async ({ slug, title }: Found): Promise<ViaExaEvent | null> => {
    // Luma stopped serving pages to us earlier in this search: the rest is left unread (no hammering), and counted.
    if (stopped) return n.blocked++, null;
    const r = await checkPage(slug, deps, now.getTime());
    if (r.kind === "blocked") {
      stopped = r.why;
      notePagesBlocked(now.getTime(), r.why);
      return n.blocked++, null;
    }
    if (r.kind === "failed") return n.failed++, null;
    if (r.kind === "missing") return n.missing++, null;
    n.looked++;
    if (r.kind === "not_event") return n.calendars++, null;
    const rec = r.record;
    // Cancelled by its own record: gone, not "no such event".
    if (rec.cancelled) return n.cancelled++, null;
    if (pastOrOutside(rec.startAt, rec.endAt)) return n.past++, null;
    n.read++;
    // A page that asks search engines not to list it isn't for public discovery, whatever else it says (fails closed).
    if (rec.noindex) return n.notPublic++, null;
    const d = rec.details;
    return keep(rec, rec.slug ?? slug, title, {
      price: d.price,
      guestCount: d.guestCount,
      // The page's own flags: sold out by any of them. A waitlist (Luma marks it sold out and not open too) is kept, as waitlist only
      // (Royce, 2026-11-10: offered honestly, never turned away as sold out).
      soldOut: d.waitlist ? false : d.soldOut === true || rec.registrationOpen === false || rec.spotsRemaining === 0,
      ...(rec.registration ? { registration: rec.registration } : {}),
      ...(d.waitlist ? { waitlist: true } : {}),
    });
  };
  // The API answers many at once; pages are read a few at a time, so a block stops the search early instead of after every read.
  const checked: (ViaExaEvent | null)[] = [];
  if (route === "api") checked.push(...(await Promise.all(found.map(viaApi))));
  else for (let i = 0; i < found.length; i += LUMA_PAGES.concurrency) checked.push(...(await Promise.all(found.slice(i, i + LUMA_PAGES.concurrency).map(viaPage))));
  const events = checked.filter((e): e is ViaExaEvent => e !== null && new Date(e.start_at).getTime() > now.getTime() && o.inRange(e.start_at));
  const why =
    reason ??
    exaFailureReason(error) ??
    (n.denied ? lumaDeniedReason(deps.denial(), now.getTime(), { denied: n.denied, pages: found.length }) : null) ??
    (n.blocked ? lumaPagesBlockedReason(stopped ?? "no answer", lumaPagesBlocked(now.getTime())?.until ?? now.getTime(), now.getTime(), apiWhy, { blocked: n.blocked, pages: found.length }) : null) ??
    (n.refused || n.limited ? lumaRefusedReason(n.refused, n.limited, found.length, deps.pauseMinutes) : null) ??
    (n.failed ? lumaFailedReason(n.failed, found.length) : null);
  return { events, report: { cached: !!fresh, error: why, pages: found.length, ...n, kept: events.length, kinds, route, ...(apiWhy ? { apiDown: apiWhy } : {}), ...(n.denied || n.blocked ? { sourceDown: true } : {}) } };
}

async function search(query: string, userId: string | null, deps: LumaViaExaDeps): Promise<{ found: Found[]; error: string | null }> {
  const r = await deps
    .exa(query, { purpose: "luma_events", userId, pages: LUMA_VIA_EXA.results, text: false, includeDomains: LUMA_DOMAINS, timeoutMs: LUMA_VIA_EXA.timeoutMs })
    .catch((err: any): ExaSearch => ({ pages: [], cost: null, error: `threw: ${String(err?.message ?? err).slice(0, 80)}` }));
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const p of r.pages) {
    const slug = lumaEventSlug(p.url);
    const title = eventTitle(p.title);
    if (!slug || !title || seen.has(slug.toLowerCase())) continue;
    seen.add(slug.toLowerCase());
    found.push({ slug, title });
  }
  return { found, error: r.error };
}

async function realDeps(d: Partial<LumaViaExaDeps> = {}): Promise<LumaViaExaDeps> {
  const [X, A, L] = await Promise.all([import("./exaSearch.js"), import("./luma.js"), import("./lumaDiscovery.js")]);
  return {
    exa: d.exa ?? ((q, o) => X.exaSearch(q, o)),
    lookup: d.lookup ?? ((slug) => A.lookupLumaEntity(slug)),
    event: d.event ?? ((id) => A.getPublicLumaEvent(id)),
    lumaApi: d.lumaApi ?? (() => A.lumaApiConfigured()),
    // A test that says only whether there's a key gets "ok" or "off" from it.
    apiState: d.apiState ?? (d.lumaApi ? async () => (d.lumaApi!() ? "ok" : "off") : () => A.lumaApiState()),
    denial: d.denial ?? (() => A.lumaApiDenied()),
    page:
      d.page ??
      (async (slug) => {
        const E = await import("./eventDetails.js");
        return classifyLumaPage(await E.readLumaPage(`https://lu.ma/${slug}`, fetch, { lane: "sweep" }), E.lumaPageRecord);
      }),
    configured: d.configured ?? (() => X.exaConfigured()),
    now: d.now ?? (() => new Date()),
    refusing: d.refusing ?? (() => A.lumaApiRefusedRecently()),
    pauseMinutes: d.pauseMinutes ?? A.LUMA_PUBLIC_API.refusalPauseMinutes,
    reserve: d.reserve ?? ((userId, source) => reserveLumaExaSearch(userId, source)),
    place: d.place ?? ((city) => L.discoverPlaceFor(city).then((p) => (p ? { name: p.name } : null))),
  };
}

// Pure: the feed's events plus the ones Exa found that the feed doesn't have (the same Luma slug, or the same Luma event id when the
// page gave one), feed first.
export function withExaEvents<T extends { url: string; api_id?: string }>(feed: T[], viaExa: T[]): T[] {
  const slugs = new Set(feed.map((e) => lumaEventSlug(e.url)?.toLowerCase()).filter(Boolean));
  const ids = new Set(feed.map((e) => e.api_id).filter(Boolean));
  const out = [...feed];
  for (const e of viaExa) {
    const slug = lumaEventSlug(e.url)?.toLowerCase();
    if ((slug && slugs.has(slug)) || (e.api_id && ids.has(e.api_id))) continue;
    if (slug) slugs.add(slug);
    if (e.api_id) ids.add(e.api_id);
    out.push(e);
  }
  return out;
}
