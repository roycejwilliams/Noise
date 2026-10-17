import { xSearchBudget } from "./searchRules.js";
import { DateTime } from "luxon";
import { MAX_ASK_DAYS_AHEAD, resolveAskWindow, whenForWindow, withinWindow } from "./askWindow.js";
import { listCalendarEvents, resolveCoEventPlace } from "./luma.js";
import { DEFAULT_FEED_DAYS, fetchPublicEvents } from "./lumaDiscovery.js";
import { rankEventsByDescription } from "./eventRanking.js";
import { localDate, searchZone } from "./eventOrder.js";
import { fetchLumaEventDetails, renderEventDetails as renderEventDetailsLines, type EventDetails, type OpportunityDetails } from "./eventDetails.js";
import { withinRadius } from "./geocoding.js";
import { gateMatches, START_LEAD_MINUTES, type GatedOut } from "../harness/matchGate.js";
import { eventStartProblem } from "./eventStart.js";
import pool from "../db/db.js";
import type { PoolClient } from "pg";


// Co's three tiers, as candidates for its own loop (agent/loop.ts, 2026-10-01):
// Tier 1 Co's own events, Tier 2 the public event feed, Tier 3 openings
// (web results, X posts, and what the daily sweep already found). Nothing here
// judges fit any more; Co does, with the whole person in view. What stays is
// fact-checking (matchGate.ts), the X budget, and the shapes the rest of Co
// reads.
//
// event_api_id is carried through on the two real-event tiers (not Tier 3 —
// an "opportunity" isn't a shared event two people would both attend) so
// callers can key exact same-event matching off it (see eventMatching.ts's
// recordSurfacedEventAndMatch) — if Co surfaces the identical event to two
// different people, that's a certain match, no fuzzy embedding/date-window
// guessing needed the way self-reported mentions require.
// event_date (the event's own date, ISO) travels alongside event_api_id so
// cross-matching against planned_event_mentions' date-windowed fuzzy search
// is possible (see eventMatching.ts) — surfaced_events needs the EVENT's
// date, not merely when Co happened to recommend it.
// deadline (Royce, 2026-08-30, optional, ISO date) — set only when the
// source post itself states an explicit application deadline. Lets
// eventSurfacingSweep.ts's backlog re-check a queued Tier 3 opportunity for
// staleness the same way it does event_date for Tier 1/2, instead of only
// catching an expired window at the moment it was first extracted. Absent
// for rolling admissions or posts with no stated deadline — there's nothing
// to re-check in that case, same as today.
// city (Tier 1/2) and evidence (Tier 3, the source post's text) are what
// harness/matchGate.ts checks location and grounding against. Optional so
// backlog items queued before 2026-09-14 still parse; the gate treats a
// missing value as unverified.
// details / opportunity / whyItFits (2026-09-15, services/eventDetails.ts):
// the real record (event page or source post) and a personal reason, so Co
// can answer "tell me more" and say why it fits this person.
// fits: false when the personal read says it doesn't fit what they asked.
// online (2026-09-17): an online event, reachable from anywhere, so it has no
// city and skips the nearby filter.
// rightKind: the fit check's read of whether it's even the kind of thing they
// asked for, separate from whether it fits on date, place, or stage.
// outsideTimeFrame: the fit check read it as happening outside the dates
// they asked about (2026-09-26), so it never goes out as a "closest thing".
// outsidePlace: somewhere other than where they asked, and not online (2026-09-27).
// audience: who it is for when it names a group ("women"), as Co judged it (services/eventAudience.ts); absent when open to everyone.
// checkedAt (Phase B, 2026-10-10): when its own page was last read (services/sendCheck.ts recheckFind). Details without it are as
// old as the find, and are never said as current (services/asOf.ts). pageNow: a web find's page text at that read, kept apart from the
// post or evidence it was found from.
// searchedIn: where the search that found it looked (services/wantPlace.ts via eventSurfacingSweep.ts searchPlace): the want's own
// place, or the home city; read by the send to say once where their finds come from.
// startAt: the feed's own start time (ISO), when known, so the gate can tell an event that already started from one later today.
type MatchExtras = { startAt?: string; searchedIn?: import("./eventSurfacingSweep.js").SearchedIn; details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string; fits?: boolean; rightKind?: boolean; outsideTimeFrame?: boolean; outsidePlace?: boolean; audience?: string; checkedAt?: string; pageNow?: string };
export type TierMatch =
  | ({ tier: 1; kind: "co_event"; event_api_id: string; event_date: string; name: string; url?: string; reason: string; city?: string | null; online?: boolean } & MatchExtras)
  | ({ tier: 2; kind: "public_event"; event_api_id: string; event_date: string; name: string; url: string; reason: string; city?: string | null; online?: boolean } & MatchExtras)
  | ({ tier: 3; kind: "opportunity"; name: string; url: string; reason: string; deadline?: string; evidence?: string; source?: "x" | "web"; statedDates?: { start: string; end?: string | null }; online?: undefined; category?: string | null } & MatchExtras);

// Lead-time window (Royce, 2026-08-30) — "how far out in advance are we
// searching?" Neither listCalendarEvents() nor fetchPublicEvents() take a
// date parameter at all — the raw candidate lists could contain events that
// already happened (wasted ranking effort, and a real risk of surfacing
// something dead) all the way out to whatever the API happens to return.
// Applied as a baseline in tryTier1/tryTier2 below, always — not just for
// the urgent path — so a past event never even reaches rankByRelevance.
//
function isWithinLookaheadWindow(startAt: string, maxDays: number): boolean {
  const days = (new Date(startAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return days >= 0 && days <= maxDays;
}

// Hard geo filter (Royce, 2026-09-02: "we can strict them" — then, catching
// the real failure mode himself, "what if I want to find out what's going
// on around the Bay Area or just San Francisco in general"). A literal
// city-string match would have broken exactly that case for a Walnut Creek
// user; a real ~50mi radius (geocoding.ts's withinRadius) covers the whole
// metro instead. Applied here, before rankByRelevance, so ranking itself
// goes back to pure topic relevance — see lumaDiscovery.ts's rankByRelevance
// comment. No userCity means no filter (nothing to be near); an
// ungeocodable city on either side also passes through rather than
// dropping a real candidate to a geocoding gap (see withinRadius).
async function filterByRadius<T extends { city?: string | null; online?: boolean }>(
  candidates: T[],
  userCity: string | null,
): Promise<T[]> {
  if (!userCity) return candidates;
  // Online events are reachable from anywhere (2026-09-17).
  // An event with no city on file can't be claimed as nearby (2026-09-14:
  // a city-less Co event in SF passed this filter and got described to
  // someone asking about Fargo as "close to Fargo"). Only drop it when we
  // do know where the person wants to be; ungeocodable strings still pass.
  const withinFlags = await Promise.all(candidates.map((c) => (c.online ? true : c.city ? withinRadius(userCity, c.city) : false)));
  return candidates.filter((_, i) => withinFlags[i]);
}


// Tier 1 — Co's own calendar. Reuses the same ranking core as Tier 2
// (lumaDiscovery.rankByRelevance) since both are "rank real events against an
// ask" with the same signal (name + city) available — Co's own events
// just come from luma.ts's sanctioned API instead of the unofficial
// discovery feed. `userCity` now drives a hard radius filter (filterByRadius
// above) before ranking, not a ranking bias; optional `filter` (by event
// start_at) is reused by checkForUrgentMatch below to further restrict to a
// near-term window on top of the lookahead baseline, rather than
// duplicating this construction a second time.
// Event lists are the same for everyone, so fetch them at most every 15
// minutes instead of once per search.
const LIST_TTL_MS = 15 * 60 * 1000;
// When a Co event's page couldn't be read, the list is only reused for a
// minute, so the event comes back as soon as its page loads.
const LIST_RETRY_TTL_MS = 60 * 1000;
type CoCalendarEvent = Awaited<ReturnType<typeof listCalendarEvents>>[number] & { online?: boolean };
let calendarCache: { at: number; ttl: number; events: CoCalendarEvent[] } | null = null;
async function cachedCalendarEvents(): Promise<CoCalendarEvent[]> {
  if (calendarCache && Date.now() - calendarCache.at < calendarCache.ttl) return calendarCache.events;
  // Every Co event gets a place (luma.ts resolveCoEventPlace), or the nearby
  // filter drops it and Tier 1 never shows up. Online events are reachable by
  // everyone; an event whose page couldn't be read is left out until it can
  // be, instead of being guessed into Co's home city (2026-09-17).
  let unresolved = 0;
  const resolved = await Promise.all(
    (await listCalendarEvents()).map(async (e): Promise<CoCalendarEvent | null> => {
      if (e.city) return e;
      const page = e.url ? await fetchLumaEventDetails(e.url).catch(() => null) : null;
      const place = resolveCoEventPlace(e.city, page, process.env.CO_HOME_CITY, !!e.url);
      if (place.source === "unresolved") {
        unresolved++;
        return null;
      }
      return { ...e, city: place.city, online: place.online };
    }),
  );
  const events = resolved.filter((e): e is CoCalendarEvent => e !== null);
  calendarCache = { at: Date.now(), ttl: unresolved ? LIST_RETRY_TTL_MS : LIST_TTL_MS, events };
  return events;
}
// Cached per city, since the feed is city-scoped now.
const publicCacheByCity = new Map<string, { at: number; events: Awaited<ReturnType<typeof fetchPublicEvents>> }>();

async function cachedPublicEvents(city: string | null, until: Date) {
  // Cached by the day the fetch has to reach.
  const key = `${(city ?? "").toLowerCase()}|${until.toISOString().slice(0, 10)}`;
  const cached = publicCacheByCity.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.events;
  const events = await fetchPublicEvents(50, city ?? null, until);
  if (publicCacheByCity.size > 20) publicCacheByCity.clear();
  publicCacheByCity.set(key, { at: Date.now(), events });
  return events;
}

// X search has a budget: all X searches together stop at X_SEARCH_DAILY_CAP a
// day, and the sweep stops X_SEARCH_REQUEST_RESERVE short of it so live asks
// still get one (2026-09-17).
const X_SEARCH_DAILY_CAP = Number(process.env.X_SEARCH_DAILY_CAP ?? 100);
const X_SEARCH_REQUEST_RESERVE = Number(process.env.X_SEARCH_REQUEST_RESERVE ?? 30);

// Reserves one X search against the daily budget, or says why not. Count and
// insert happen under one transaction-scoped advisory lock, so two searches
// can't both see room for the last slot (2026-09-17: the count and the log
// insert were separate statements). Fails closed: if the budget can't be
// checked (table missing, database error) there is no X search, where it used
// to allow unlimited ones.
export async function reserveXSearch(userId: string | null, source: "sweep" | "request", query: string): Promise<{ ok: boolean; reason: string | null }> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('x_search_budget'))");
    const { rows } = await client.query(`SELECT COUNT(*)::int AS today FROM x_search_log WHERE created_at > NOW() - INTERVAL '1 day'`);
    const decision = xSearchBudget(Number(rows[0]?.today ?? 0), source, X_SEARCH_DAILY_CAP, X_SEARCH_REQUEST_RESERVE);
    if (!decision.ok) {
      await client.query("ROLLBACK");
      return decision;
    }
    await client.query(`INSERT INTO x_search_log (user_id, source, query) VALUES ($1, $2, $3)`, [userId, source, query]);
    await client.query("COMMIT");
    return decision;
  } catch (err: any) {
    await client?.query("ROLLBACK").catch(() => {});
    console.error("tieredRecommendation: X budget check failed (no X search):", err?.message ?? err);
    return { ok: false, reason: `the X search budget couldn't be checked (${err?.message ?? "error"}), so no X search` };
  } finally {
    client?.release();
  }
}

// ---------------------------------------------------------------- for Co's own loop
// The raw candidates for an event search, for Co to judge itself (agent/
// loopTools.ts searchEvents, 2026-10-01: "Co runs fixed pipelines outside its
// own reasoning"). Co's calendar and the public feed, inside the window and
// nearby, ranked by how close each description is to what was asked, with each
// page's details. No model gates here: fit is Co's call. Only facts are
// checked, by the same gate as before (sold out, already sent, already over,
// too far), and what it turns away comes back with the reason.
export type EventCandidate = { match: TierMatch; lines: string[] };

// The weekday is worked out from the date here, never left to the model
// (2026-10-01 next-live run: Co called Oct 2 "Thursday"; it's a Friday).
export function eventLine(name: string, date: string | null, city: string | null): string {
  const d = date ? DateTime.fromISO(String(date).slice(0, 10)) : null;
  const when = d?.isValid ? `${d.toFormat("cccc, LLLL d")} (${d.toISODate()})` : (date ?? "");
  return `${name}, ${when}${city ? `, ${city}` : ""}`;
}
export async function eventCandidates(
  what: string,
  city: string | null,
  opts: { when?: string | null; userId?: string | null; timezone?: string | null; limit?: number } = {},
): Promise<{ candidates: EventCandidate[]; turnedAway: GatedOut[]; window: string | null; feedSize: number; inWindow: number; outOfRange: string | null }> {
  const { zone } = searchZone(opts.timezone ?? null);
  const now = DateTime.now().setZone(zone);
  const when = whenForWindow(opts.when);
  const resolution = when ? resolveAskWindow(when, now) : { window: null, outOfRange: null };
  if (resolution.outOfRange) return { candidates: [], turnedAway: [], window: null, feedSize: 0, inWindow: 0, outOfRange: `${resolution.outOfRange.label} is more than ${MAX_ASK_DAYS_AHEAD} days out` };
  const window = resolution.window;
  const until = window ? window.end.toJSDate() : new Date(Date.now() + DEFAULT_FEED_DAYS * 24 * 60 * 60 * 1000);
  const inRange = (startAt: string) => (window ? withinWindow(startAt, window) : isWithinLookaheadWindow(startAt, DEFAULT_FEED_DAYS));
  const [feed, coEvents] = await Promise.all([cachedPublicEvents(city, until).catch(() => []), cachedCalendarEvents().catch(() => [] as CoCalendarEvent[])]);
  const coIds = new Set(coEvents.map((e) => e.api_id).filter(Boolean));
  const ours = await filterByRadius(coEvents.filter((e) => inRange(e.start_at)), city);
  const theirs = await filterByRadius(feed.filter((e) => !coIds.has(e.api_id) && inRange(e.start_at)), city);
  const ranking = await rankEventsByDescription(theirs, what, { limit: opts.limit ?? 8, bar: 0, zone, browse: false }).catch(() => ({ ranked: theirs.slice(0, opts.limit ?? 8).map((e) => ({ ...e, details: undefined as EventDetails | undefined })) }));
  const asMatch = (e: any, tier: 1 | 2): TierMatch => ({
    tier,
    kind: tier === 1 ? "co_event" : "public_event",
    event_api_id: e.api_id,
    event_date: localDate(e.start_at, zone),
    startAt: e.start_at,
    name: e.name,
    url: e.url,
    reason: tier === 1 ? "A Noise event." : "A public event.",
    city: e.city ?? null,
    ...(e.online ? { online: true } : {}),
  }) as TierMatch;
  const raw: TierMatch[] = [...ours.slice(0, 2).map((e) => asMatch(e, 1)), ...ranking.ranked.map((e: any) => asMatch(e, 2))];
  const turnedAway: GatedOut[] = [];
  // A reply never offers what already started, or what starts too soon to get to (Royce, 2026-10-17: the Angel Island run was offered at
  // 10:18, 48 minutes after it started, inside "this weekend"). Judged once each event's own page is read: the feed has no end time and
  // no online flag, so a festival under way (offerable until it ends) and an online event (15 minutes, not 60) are only known from the
  // page (review of #229). The gate below checks the day; the start is checked after it, by the one rule (services/eventStart.ts).
  const gated = await gateMatches(raw.map((m) => ({ ...m, startAt: undefined }) as TierMatch), { userId: opts.userId ?? null, searchCity: city, checkRepeat: true, gatedOut: turnedAway, askedUntil: window ? window.end.toISODate() : null, lookaheadDays: null, zone });
  const feedStart = new Map(raw.map((m) => [("url" in m && m.url) || m.name, m.startAt ?? null]));
  const read = await Promise.all(
    gated.map(async (m) => {
      const details = "url" in m && m.url ? ((await fetchLumaEventDetails(m.url).catch(() => null)) ?? undefined) : undefined;
      const startAt = details?.startAt ?? feedStart.get(("url" in m && m.url) || m.name) ?? null;
      const late = eventStartProblem({ startAt, endAt: details?.endAt ?? null, online: !!(m.online || details?.online) }, new Date(), START_LEAD_MINUTES, details?.timezone ?? zone);
      if (late) {
        turnedAway.push({ name: m.name, tier: m.tier, reasons: [late], url: ("url" in m && m.url) || null, date: m.tier === 3 ? null : (m.event_date ?? null) });
        return null;
      }
      const withDetails = { ...m, ...(startAt ? { startAt } : {}), details } as TierMatch;
      const e = m as { name: string; event_date?: string; city?: string | null };
      const lines = details ? renderEventDetailsLines(m.name, details) : [eventLine(e.name, e.event_date ?? null, e.city ?? null)];
      return { match: withDetails, lines };
    }),
  );
  const candidates = read.filter((c): c is EventCandidate => c !== null);
  return { candidates, turnedAway, window: window?.label ?? null, feedSize: feed.length, inWindow: theirs.length + ours.length, outOfRange: null };
}
