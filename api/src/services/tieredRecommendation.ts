import { generateText } from "ai";
import { searchCacheKey, shouldCacheSearch, xPostFitsWindow, xSearchBudget } from "./searchRules.js";
import { DateTime } from "luxon";
import { isBrowseAsk, MAX_ASK_DAYS_AHEAD, resolveAskWindow, withinWindow } from "./askWindow.js";
import { anthropic } from "@ai-sdk/anthropic";
import { listCalendarEvents, resolveCoEventPlace } from "./luma.js";
import { DEFAULT_FEED_DAYS, fetchPublicEvents } from "./lumaDiscovery.js";
import { rankEventsByDescription, type Closest } from "./eventRanking.js";
import { localDate, localToday, searchZone } from "./eventOrder.js";
import { fetchLumaEventDetails, type EventDetails, type OpportunityDetails } from "./eventDetails.js";
import { getTier3CategoryBias } from "./recommendationOutcome.js";
import { searchRecentPosts } from "./xSearch.js";
import { reserveWebSearch, searchWebForOpportunity } from "./webOpportunitySearch.js";
import { withinRadius } from "./geocoding.js";
import type { StatedIntent } from "./matching.js";
import { checkGrounding, checkTiming, gateMatches, type GatedOut } from "../harness/matchGate.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import pool from "../db/db.js";
import type { PoolClient } from "pg";

// Model policy (Royce, 2026-09-14): Haiku only for narrow work code checks
// afterwards (city extraction, query rewrite, opportunity extraction backed
// by matchGate's grounding check); Sonnet 5 for the relevance judgment,
// which nothing downstream re-checks.
const EXTRACT_MODEL = MODELS.haiku;
const JUDGE_MODEL = MODELS.sonnet;

// The actual "Tiered recommendation engine (Tier 1 event → Tier 2 community/
// meetup → Tier 3 opportunity fallback)" board item. Never invents something
// that doesn't exist, unlike the old generateRecommendation behavior this
// replaces internally (see recommendation.ts).
//
// Decision logic reworked 2026-08-30 (Royce): this used to be a strict
// waterfall — first non-null tier won, full stop — then briefly a single-
// winner LLM arbitration (decideBestMatch) when more than one tier found
// something real. Both are gone now: "I don't think there should be a
// 'winner'. All 3 tiers should be surfaced, not exclude our users from an
// opportunity if Co finds one." Tier 1 and Tier 2 are always checked (both
// cheap/free), Tier 3's actual paid step (the X search) only runs when the
// ask is clearly opportunity-shaped on its own merits, and every tier that
// independently clears its own relevance bar is returned — no comparison,
// no picking a favorite. See getTieredRecommendation below for how the
// results get bundled into a single tease/reveal rather than one text per
// match.
//
// Tier 3 redefined 2026-08-30 (Royce): not a generic nearby-venue fallback
// anymore — Co's actual audience is founders/builders/"high agency" people,
// so Tier 3 is real opportunities sourced from X's recent-search
// (xSearch.ts), not Google Places. A physical venue lookup isn't the
// fallback shape that matches who Co is actually for.
// Widened 2026-09-17 (Royce, "high agency people are looking for more than
// just that"): accelerators/fellowships/grants/communities were the first
// examples, not the ceiling — an investor actively looking to fund people,
// a mentor, a speaking slot, a co-founder or hire, or anything else a
// high-agency person could actually act on all count too, as long as it's a
// real, concrete, nameable thing grounded in one actual post, never vague
// hype and never invented.
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
type MatchExtras = { details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string; fits?: boolean; rightKind?: boolean; outsideTimeFrame?: boolean; outsidePlace?: boolean };
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
// Ceilings picked, not derived (Royce, 2026-08-30) — starting defaults, not
// researched numbers. They trade off "far enough out that a real event
// isn't missed" against "close enough that 'I was thinking about you' about
// something still reads as timely, not premature." Different per tier,
// deliberately: Co's own event cadence is unknown ("the ceiling doesn't
// make sense if it's dependent on how many times we host an event"), so
// rather than guess a single number and risk a real Tier 1 event silently
// losing to a closer-but-lesser Tier 2 match, Tier 1 gets a wider window —
// it's the priority channel, better to look further ahead than miss one.
// Tier 2 (not Co-curated, lower context per match) stays tighter, closer to
// "happening in your world right now."
const TIER1_MAX_LOOKAHEAD_DAYS = 30;
const TIER2_MAX_LOOKAHEAD_DAYS = 14;
// A widened search (someone frustrated with what Co has found, 2026-09-18)
// looks further ahead, keeps more candidates, and lowers the similarity bar a
// notch. The ask still decides what counts.
const WIDEN_TIER2_DAYS = 21;
const WIDEN_TIER2_LIMIT = 12;
const WIDEN_SIMILARITY_BAR = 0.25;

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


// Real judgment gate, take two (Royce, 2026-09-02) — the first attempt at
// this was reverted for being unreliable when judging from a bare event
// NAME alone (too strict in one wording, too lenient in another — genuinely
// not enough signal for any prompt to work with). Royce then pushed back
// correctly: "Look into what field Luma gives you about an event. It can't
// just stop at name" — confirmed live, a real description DOES exist on
// each event's own public page (lumaDiscovery.ts's fetchEventDescription),
// just not on the discovery LIST endpoint. With real substance to judge
// from instead of a handful of words, this is a fundamentally different,
// answerable question. Only called for the one already-top-ranked
// candidate (one extra page fetch, not per-candidate). No description
// available (fetch failed, or Tier 1 which has no url field yet) means no
// gate — fails open, same "don't drop a real candidate to an infra gap"
// philosophy as the radius/geocoding fallback.
// Whether a real event fits what they asked, reading its description, and
// in a few words why not when it doesn't. The reason is what Co tells them
// about a near miss (2026-09-16: "it's a hands-on build session, not a
// meetup", instead of a generic "not close enough").
export type RelevanceVerdict = { fit: boolean; why: string | null; eventKind?: string | null; askedKind?: string | null; related?: boolean };

export function relevancePrompt(askText: string, candidateName: string, candidateCity: string | null, description: string): string {
  return `Someone said: "${askText}"

Co is considering recommending this real event: "${candidateName}"${candidateCity ? ` in ${candidateCity}` : ""}.

Its actual description: "${description}"

Answer three things, in order:
1. eventKind: what kind of event this is, in 2 to 6 words, from its format and main activity (e.g. "chess social night", "hands-on hackathon", "panel conference", "founder networking mixer", "AI research talk").
2. askedKind: what kind of event they asked for, in 2 to 6 words, from their words.
3. fit: true if the event's real purpose serves what they asked for. Two different tests depending on what they named:
   - They named an ACTIVITY (chess, pottery, yoga): the event's own main activity has to be that activity. Who attends, who hosts, or who sponsors never changes what kind of event it is — a chess night full of AI researchers is still a chess night.
   - They named a PEOPLE/AUDIENCE instead (founders, builders, developers, a specific community): the test is whether the event brings that audience together to do what that audience does — pitch, demo, build, work alongside each other, or just meet — not whether it's literally labeled "meetup" or "mixer". A pitch night, a demo night, a community meetup, or a hands-on work/build session all fit an ask for founders or builders exactly as much as a mixer does, since it's the same room for the same reason (confirmed live, 2026-09-17: "Hardware Pitch Night," "Codex Community Meetup," and "Side-Project Party" were wrongly rejected as "not a meetup" for a founder/builder ask, when the actual founders-and-builders room was the whole point).
   Any format counts when that audience is the point of it: a one-off talk, fireside chat, panel, demo or pitch night, hackathon, conference or mixer fits as much as a recurring meetup, because what they want is to be around those people and hear from them (Royce, 2026-09-21: anything that aligns with what they're looking for should be surfaced). Being a single event, or a talk instead of a mixer, is never a reason to say no.
   Close variants of the same kind are fine either way (an AI demo night fits "AI meetup"; a founder dinner fits "founder meetup"; a build day or hackathon fits an ask for builders, since building together is the point). Also false if it's clearly somewhere other than where they asked, if it's aimed at a different audience or topic, or if it's closed to them (private, employees only, invite-only).

If fit is false, "why" says it plainly in a few words, like you'd tell a friend (e.g. "it's a hands-on build session, not a meetup"). No names, about 12 words at most. And "related" is true only when it serves the same purpose they asked for, the same people to meet or the same thing to do, just in a different format or setting (a hands-on build day full of founders for someone wanting a founder meetup: true; a general-interest run, a shopping market, or a tarot night: false, even if some founders might turn up).

Return ONLY JSON: {"eventKind": "...", "askedKind": "...", "fit": true or false, "why": "..." or null, "related": true or false}`;
}

// One verdict per ask and event per day, so asking the same thing twice gets
// the same answer (2026-09-16: Claude Fable 5.1 Build Day was accepted on some
// runs and rejected on another; a chess night was rejected, then accepted).
const relevanceCache = new Map<string, { at: number; verdict: RelevanceVerdict }>();
const RELEVANCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function relevanceCacheKey(askText: string, candidateName: string, description: string): string {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${norm(askText)}|${norm(candidateName)}|${description.length}`;
}

async function isGenuinelyRelevant(askText: string, candidateName: string, candidateCity: string | null, description: string | null): Promise<RelevanceVerdict> {
  if (!description) return { fit: true, why: null };
  const key = relevanceCacheKey(askText, candidateName, description);
  const cached = relevanceCache.get(key);
  if (cached && Date.now() - cached.at < RELEVANCE_CACHE_TTL_MS) return cached.verdict;
  try {
    const { text: raw } = await generateText({
      model: anthropic(JUDGE_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.relevanceGate" },
      prompt: relevancePrompt(askText, candidateName, candidateCity, description),
    });
    const parsed = parseModelJson<{ fit?: boolean; why?: string | null; eventKind?: string; askedKind?: string; related?: boolean }>(raw);
    if (typeof parsed?.fit !== "boolean") return { fit: /"fit":\s*true/i.test(raw), why: null };
    const verdict: RelevanceVerdict = {
      fit: parsed.fit,
      why: parsed.fit ? null : typeof parsed.why === "string" && parsed.why.trim() ? parsed.why.trim().slice(0, 140) : null,
      eventKind: parsed.eventKind ?? null,
      askedKind: parsed.askedKind ?? null,
      related: parsed.fit ? true : parsed.related === true,
    };
    if (relevanceCache.size > 2000) relevanceCache.clear();
    relevanceCache.set(key, { at: Date.now(), verdict });
    return verdict;
  } catch (err: any) {
    console.error("tieredRecommendation: isGenuinelyRelevant failed (non-fatal, allowing match through):", err?.message ?? err);
    return { fit: true, why: null };
  }
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

// What one search saw, filled in as it runs (2026-09-17: this was module-level
// "last*" state reset and filled across awaits, so two people searching at
// once overwrote each other's record, and recommendation.ts read it after
// another database await). One per getTieredRecommendation call now.
type SearchTrace = {
  tierDrop: TierDrop | null;
  fetchedThrough: string | null;
  topScores: { name: string; similarity: number; profile?: number | null }[];
  nearbyCount: number | null;
  closest: (Closest & { why: string }) | null;
  relevanceRejected: { name: string; why: string; related?: boolean }[];
  xDropped: { name: string; reason: string } | null;
  xQuery: string | null;
  xBlocked: string | null;
  // General-web fallback, tried only when X found nothing (2026-09-17).
  webQuery: string | null;
  webBlocked: string | null;
  // Which Tier 3 categories have (or haven't) gone anywhere for this person
  // before, per getTier3CategoryBias — for an optional reply mention, not
  // forced (2026-09-17).
  categoryInsight: { worked: string[]; flopped: string[] } | null;
  timings: { tiersMs?: number; tier3Ms?: number; relevanceMs?: number };
};

function newTrace(): SearchTrace {
  return { tierDrop: null, fetchedThrough: null, topScores: [], nearbyCount: null, closest: null, relevanceRejected: [], xDropped: null, xQuery: null, xBlocked: null, webQuery: null, webBlocked: null, categoryInsight: null, timings: {} };
}

// "Thursday, September 17" in their zone. toLocaleDateString() used the
// server's zone (UTC), so a Thursday 7pm Pacific event read as Friday
// (2026-09-17).
function localDayLabel(startAt: string, zone: string): string {
  const d = DateTime.fromISO(startAt, { zone: "utc" }).setZone(zone);
  return d.isValid ? d.toFormat("cccc, LLLL d") : startAt.slice(0, 10);
}

async function tryTier1(ask: StatedIntent, userCity: string | null, filter: ((startAt: string) => boolean) | undefined, opts: { browse?: boolean; maxDays?: number; zone: string; profileText?: string | null }): Promise<TierMatch | null> {
  const events = await cachedCalendarEvents().catch((err: any) => {
    console.error("tieredRecommendation: tryTier1 listCalendarEvents failed (non-fatal):", err?.message ?? err);
    return [] as CoCalendarEvent[];
  });
  const inWindow = events.filter((e) => isWithinLookaheadWindow(e.start_at, opts.maxDays ?? TIER1_MAX_LOOKAHEAD_DAYS) && (!filter || filter(e.start_at)));
  const nearby = await filterByRadius(inWindow, userCity);
  // They asked what's on in a window, not for a topic: the soonest one in
  // that window is the answer, so relevance ranking would only reject it.
  // Co's own events come first no matter what (Royce, 2026-09-16): not
  // filtered by what they asked or by their profile. The soonest nearby one in
  // the window; the gate still checks place, timing, availability and repeats.
  const match = soonest(nearby);
  if (!match) return null;
  const details = match.url ? ((await fetchLumaEventDetails(match.url)) ?? undefined) : undefined;
  const online = !!match.online || !!details?.online;
  return {
    details,
    tier: 1,
    kind: "co_event",
    event_api_id: match.api_id,
    event_date: localDate(match.start_at, opts.zone),
    name: match.name,
    reason: `Matches a Co event happening ${localDayLabel(match.start_at, opts.zone)}${online ? ", online" : match.city ? ` in ${match.city}` : ""}.`,
    city: online ? null : (match.city ?? null),
    ...(online ? { online: true } : {}),
    // Real gap found live, 2026-09-09: this never set url at all, so
    // Tier 1 recommendations never had a real link to send, and the
    // follow-up "give me the details" reply (agent.conversationReply, not
    // grounded in any real Luma fields) fabricated a start time, location,
    // and headcount instead. listCalendarEvents() now actually captures
    // the real url Luma returns for every event.
    ...(match.url ? { url: match.url } : {}),
  };
}

// Tier 2 — any public Luma event, not just Co's own. "Recurring community"
// isn't a confirmed, filterable signal from the discovery feed (see
// lumaDiscovery.ts's header) — approximated here as "a real public event
// that isn't ours," not strictly filtered to recurring-only. Noted as a
// simplification, not hidden. Calls fetchPublicEvents + rankByRelevance
// directly (rather than lumaDiscovery's findEventMatchingAsk wrapper) so an
// optional near-term `filter` can be applied before ranking — same reuse
// reasoning as tryTier1 above. `userCity` drives the same hard radius filter.

function soonest<T extends { start_at: string }>(events: T[]): T | null {
  return [...events].sort((a, b) => a.start_at.localeCompare(b.start_at))[0] ?? null;
}

// The last part of a Luma link, which is the same for lu.ma and luma.com.
function lumaSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const slug = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();
  return slug ? slug.toLowerCase() : null;
}

// Returns the candidates worth offering, best first — the gate
// (harness/matchGate.ts) makes the final call, and it needs more than one to
// choose from (2026-09-16: the single candidate it got was sold out, so the
// search ended with nothing while other real events were available).
async function tryTier2(ask: StatedIntent, userCity: string | null, filter: ((startAt: string) => boolean) | undefined, trace: SearchTrace, opts: { browse?: boolean; maxDays?: number; until: Date; zone: string; profileText?: string | null; widen?: boolean }): Promise<TierMatch[]> {
  const [feed, coEvents] = await Promise.all([
    cachedPublicEvents(userCity, opts.until).catch((err: any) => {
      console.error("tieredRecommendation: tryTier2 fetchPublicEvents failed (non-fatal):", err?.message ?? err);
      return [];
    }),
    cachedCalendarEvents().catch(() => [] as CoCalendarEvent[]),
  ]);
  // Co's own events are Tier 1; the same event showing up in the public feed
  // was offered twice (2026-09-17).
  const coIds = new Set(coEvents.map((e) => e.api_id).filter(Boolean));
  const coSlugs = new Set(coEvents.map((e) => lumaSlug(e.url)).filter((x): x is string => !!x));
  const events = feed.filter((e) => !coIds.has(e.api_id) && !coSlugs.has(lumaSlug(e.url) ?? ""));
  // How far the fetched feed actually reached, so a search that asked about
  // Oct 5-14 but only got events through Oct 9 says so instead of reporting a
  // clean "nothing found".
  trace.fetchedThrough = feed.reduce<string | null>((latest, e) => (!latest || e.start_at > latest ? e.start_at : latest), null);
  const inWindow = events.filter((e) => isWithinLookaheadWindow(e.start_at, opts.maxDays ?? (opts.widen ? WIDEN_TIER2_DAYS : TIER2_MAX_LOOKAHEAD_DAYS)) && (!filter || filter(e.start_at)));
  const nearby = await filterByRadius(inWindow, userCity);
  // The best few, not just the top one: a single odd top pick used to take
  // the whole search down when the relevance check rejected it, with real
  // matches sitting further down the same list (2026-09-16).
  trace.nearbyCount = nearby.length;
  // Ranked on each event's description, open events first
  // (services/eventRanking.ts); the closest one is kept for a near miss.
  // With a profile, even a "what's on?" ask is ordered by what fits them,
  // not by what's soonest (Royce, 2026-09-16: "give them things that match
  // their profile").
  const ranking =
    opts.browse && !opts.profileText
      ? { ranked: [soonest(nearby)].filter((m): m is (typeof nearby)[number] => !!m).map((m) => ({ ...m, similarity: 1, details: undefined as EventDetails | undefined })), closest: null }
      : await rankEventsByDescription(nearby, opts.browse ? "" : ask.text ?? "", {
          limit: opts.widen ? WIDEN_TIER2_LIMIT : 6,
          bar: opts.widen ? WIDEN_SIMILARITY_BAR : undefined,
          topScores: trace.topScores,
          zone: opts.zone,
          profileText: opts.profileText,
          browse: opts.browse,
        });
  // The near miss comes only from events the relevance check actually read
  // and judged related; an unread best score is never named on its own.
  const candidates = ranking.ranked;
  const rejected: string[] = [];
  const kept: TierMatch[] = [];
  // A page Co couldn't read is not verified: no description to judge fit
  // and no sold-out status, so it isn't offered (2026-09-17: a failed read
  // passed the relevance check automatically).
  const UNREAD: RelevanceVerdict = { fit: false, why: "couldn't read the event page to check it", related: false };
  // Every candidate is read at the same time, then handled in ranked order
  // exactly as before (2026-09-16: reading up to six one after another was
  // most of an 18-second search).
  const relevanceStarted = Date.now();
  const reads = await Promise.all(
    candidates.map(async (match) => {
      const details = match.details ?? (await fetchLumaEventDetails(match.url)) ?? undefined;
      const verdict: RelevanceVerdict = !details
        ? UNREAD
        : ask.text && !opts.browse
          ? await isGenuinelyRelevant(ask.text, match.name, match.city, details.description ?? null)
          : { fit: true, why: null };
      return { details, verdict };
    }),
  );
  trace.timings.relevanceMs = Date.now() - relevanceStarted;
  const publicMatch = (e: (typeof nearby)[number], details: EventDetails): TierMatch => ({
    details,
    tier: 2,
    kind: "public_event",
    event_api_id: e.api_id,
    event_date: localDate(e.start_at, opts.zone),
    name: e.name,
    url: e.url,
    reason: details.online ? "A public online event that looks like a real fit." : `A public event that looks like a real fit${e.city ? ` in ${e.city}` : ""}.`,
    city: details.online ? null : (e.city ?? null),
    ...(details.online ? { online: true } : {}),
  });
  for (const [i, match] of candidates.entries()) {
    const { details, verdict } = reads[i];
    if (!verdict.fit || !details) {
      rejected.push(match.name);
      trace.relevanceRejected.push({ name: match.name, why: verdict.why ?? "doesn't match what they asked", related: verdict.related ?? false });
      // The nearest miss is the best-scoring one the check turned down, not
      // the first one it read: candidates are ordered open-first, so the first
      // read can be a weaker open event (2026-09-16: Maum Market was named
      // over Claude Fable 5.1 Build Day).
      const similarity = Math.round(match.similarity * 1000) / 1000;
      // Only something they might still consider is worth naming as a near
      // miss (2026-09-16: a shopping market was offered as the closest thing
      // to a founder meetup).
      if (verdict.related && (!trace.closest || similarity > trace.closest.similarity)) {
        trace.closest = {
          name: match.name,
          url: match.url ?? null,
          date: localDate(match.start_at, opts.zone),
          similarity,
          why: `${verdict.why ?? "on reading what it's about, it isn't quite what they asked for"}${details?.soldOut ? ", and it's sold out" : ""}`,
        };
      }
      continue;
    }
    kept.push(publicMatch(match, details));
  }
  // Nothing cleared the bar: read the closest one anyway. If it really fits,
  // offer it (the bar only cuts noise); if not, its reason is what the person
  // hears about the near miss, not a generic "not close enough".
  if (!kept.length && !candidates.length && ask.text && !opts.browse && ranking.closest) {
    const near = nearby.find((e) => e.name === ranking.closest!.name);
    if (near) {
      const details = (await fetchLumaEventDetails(near.url)) ?? undefined;
      const verdict = details ? await isGenuinelyRelevant(ask.text, near.name, near.city, details.description ?? null) : UNREAD;
      if (verdict.fit && details) {
        kept.push(publicMatch(near, details));
        trace.closest = null;
      } else {
        trace.relevanceRejected.push({ name: near.name, why: verdict.why ?? "doesn't match what they asked", related: verdict.related ?? false });
        if (verdict.related) {
          trace.closest = { ...ranking.closest!, why: `${verdict.why ?? "on reading what it's about, it isn't quite what they asked for"}${details?.soldOut ? ", and it's sold out" : ""}` };
        }
      }
    }
  }
  if (rejected.length && !kept.length) {
    trace.tierDrop = { tier: 2, name: rejected.join("; "), reason: `the relevance check rejected ${rejected.length === 1 ? "it" : "all of them"} as not matching what they asked` };
  }
  return kept;
}

// Tier 3 — a real opportunity (accelerator, fellowship, program), via X's
// recent search (xSearch.ts). The raw ask text isn't a good search query on
// its own ("climate tech founders" won't surface accelerator posts), so this
// asks the model to propose a real search query first, same "ground it,
// never invent one" discipline as before — the difference from the old
// venue version is the grounding element is a real post URL, not a
// place_id.
type OpportunityQuery = { query: string | null; worked: string[]; flopped: string[] };

async function proposeOpportunityQuery(ask: StatedIntent, city: string | null, profile: string | null | undefined, zone: string, userId?: string | null): Promise<OpportunityQuery> {
  if (!ask.text) return { query: null, worked: [], flopped: [] };
  try {
    // What's actually gone somewhere for this person before, not a guess
    // (2026-09-17, closing the outcome loop — see
    // recommendationOutcome.ts's getTier3CategoryBias). Genuinely empty for
    // a while: a Tier 3 outcome follow-up is deliberately delayed days, so
    // this has nothing to say for anyone new. That's fine — the hint is
    // just omitted, same prompt as today, until real signal exists.
    const categoryBias: Record<string, number> = userId ? await getTier3CategoryBias(userId).catch(() => ({})) : {};
    const worked = Object.entries(categoryBias).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const flopped = Object.entries(categoryBias).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    // Today's date, explicit (Royce, 2026-09-02) — confirmed live: without
    // this, the model defaulted to a plausible-sounding but wrong year from
    // its training data ("SF accelerator program applications open 2024"),
    // and that literal wrong year in the query killed recall entirely (0
    // results from X's own 7-day recent-search, which will never contain a
    // stale year string). extractRealOpportunity already gets today's date
    // for its own deadline check; this step needs it too, for the same
    // reason.
    // Their local date, not UTC (2026-09-17).
    const todayStr = localToday(new Date(), zone);
    const { text: raw } = await generateText({
      model: anthropic(EXTRACT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.proposeOpportunityQuery" },
      prompt: `Someone wants: "${ask.text}"${city ? ` (based in ${city})` : ""}
${profile ? `\nWho they are right now (use it to aim the query at opportunities suited to their stage and situation, e.g. Series A programs rather than beginner ones; their ask still decides the topic):\n${profile}\n` : ""}${worked.length ? `\nFor this person, ${worked.join(", ")} opportunities have actually led somewhere before — lean toward that kind of thing when their ask is open enough to allow it, but never instead of what they actually asked for.\n` : ""}${flopped.length ? `\n${flopped.join(", ")} opportunities haven't gone anywhere for this person before — still search if their ask is specifically that, just don't reach for it when the ask is open.\n` : ""}
Today's date: ${todayStr}

Propose a short X search query (2-4 broad, distinctive keywords, not a question) likely to surface real, recent posts about a concrete opportunity that fits what they want. That opportunity can be an accelerator, fellowship, cohort-based program, residency, grant, a named community/club/recurring group to join, an investor or fund actively looking to back people like them, a mentor or advisor, a speaking or demo slot, a co-founder or hire, or anything else concrete a high-agency person could actually act on — those are examples of the shape of thing to search for, not an exhaustive list, so read their actual ask and go after what THEY specifically want, even if it doesn't fit neatly into one of these labels. Always propose one when there's any topic to search on; social or hobby asks map to communities and groups. Never include a specific year in the query unless the person's own ask text stated one — a wrong or stale year keyword will filter out real current posts that don't happen to mention that exact year. Never include the person's own city/region as a keyword either (confirmed live: adding "SF Bay Area" to an otherwise-good query dropped real matching posts to zero) — a real opportunity post almost never mentions the seeker's own location, only the program's own name and field.

The single phrase they used isn't the only real wording people post with — "founder meetup" misses a post that says "builder night" or "startup mixer" even though it's the same thing. Where there's a genuinely equivalent, commonly-used phrasing for the same core topic (2-3 real variants, not invented ones), combine them with X's OR operator, grouped in parentheses: (founder meetup OR builder night OR startup mixer). Only group phrasings someone would actually use for the same thing — don't pad the query with a loosely related second topic just to widen it. A single distinctive phrase with no real synonym is fine as-is.

Return null only when there's no topic at all to search on.

Return ONLY valid JSON: {"query": "..." or null}`,
    });
    // Same robustness fix as extractRealOpportunity below — a preamble/
    // trailing-commentary wrap around the JSON isn't caught by stripping
    // code fences alone.
    const parsed = parseModelJson(raw);
    return { query: typeof parsed?.query === "string" ? parsed.query : null, worked, flopped };
  } catch (err: any) {
    console.error("tieredRecommendation: proposeOpportunityQuery failed (non-fatal):", err?.message ?? err);
    return { query: null, worked: [], flopped: [] };
  }
}

// Picks ONE real, concrete opportunity out of the raw search results —
// grounded in an actual post's real text and URL, never a summary that
// drifts from what any single post actually said. Returns null rather than
// force a weak pick if nothing in the results is actually concrete/credible.
//
// Deadline floor, same spirit as Tier 1/2's lookahead window (Royce,
// 2026-08-30): "imagine an opportunity for our user that may pass because
// the applications closed." Tier 3 has no structured date field — a post
// might say "apply by March 1," "rolling admissions," or nothing at all —
// so there's no field to filter on the way event_date works for Tier 1/2.
// The only place that context exists is the post's own text, so the
// deadline check has to live in this same grounding step: today's date is
// given directly, and the model is told to skip a post whose own text
// makes clear the window's already shut, rather than bolting on a second
// pass over something already-extracted.
async function extractRealOpportunity(
  ask: StatedIntent,
  posts: { id: string; text: string; url: string }[],
  profile: string | null | undefined,
  zone: string,
): Promise<TierMatch | null> {
  if (!posts.length) return null;
  try {
    const digest = posts.map((p, i) => `${i}. ${p.text.replace(/\n+/g, " ")}`).join("\n");
    // Their local date, not UTC (2026-09-17).
    const todayStr = localToday(new Date(), zone);
    const { text: raw } = await generateText({
      model: anthropic(EXTRACT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.extractRealOpportunity" },
      prompt: `Someone wants: "${ask.text}"
${profile ? `\nWho they are right now:\n${profile}\n\nAmong posts that fit what they want, pick the one best suited to who they are (their stage, what they're working on, what they want now). Skip an opportunity clearly aimed at a different stage or audience than theirs.\n` : ""}
Today's date: ${todayStr}

Here are real recent posts from X, one per line:
${digest}

Pick the ONE post (if any) that names a real, concrete opportunity genuinely relevant to what they want — a specific accelerator, fellowship, program, residency, grant, community/club/recurring group, an investor or fund actively backing people, a mentor, a speaking slot, a co-founder or hire lead, or anything else a high-agency person could actually act on. Those are examples of the shape of thing, not the only things that count — what matters is it's a real, nameable thing someone could actually do something with, not vague hype and not an unrelated post. Name the opportunity using only what's actually in that post — never add details that aren't there.

Skip anything that reads as hype, clickbait, or an engagement-bait "BREAKING" post without real concrete substance behind it (a specific program name, a real application process) — prefer a plainly-stated, verifiable opportunity over a dramatic-sounding one. A repost/retweet of someone else's claim is not independently more credible just because it's been shared multiple times.

Some posts list SEVERAL distinct opportunities in one message (e.g. "1. Slush 100 — Deadline: Sept 7 ... 2. Techstars Anywhere ..."). If you pick a post like that, attribute every detail — especially the deadline — ONLY to the specific opportunity you're naming, never a detail stated for a different program listed in the same post. If the one you're actually naming has no deadline of its own stated, leave deadline out entirely even if another program mentioned right next to it has one.

If a post's own text gives a deadline or application window that has clearly already closed relative to today's date, don't pick it — there's nothing left to act on. Rolling admissions, no stated deadline, or a deadline still ahead are all fine to pick. If the post states an explicit application deadline date for the SPECIFIC opportunity you're naming, include it as "deadline" in YYYY-MM-DD form — only if that opportunity itself actually states one, never estimate, infer, or borrow one from a different program in the same post.

Write "reason" the way Co would say it to a friend over text — one short, casual sentence. Keep exactly one concrete, grounded detail that proves it's real (not vague hype), but never in analyst language ("demonstrates," "concrete evidence of," "showcasing") — say it plainly, the way a person would, not a scoring rationale. E.g. "Real accelerator, and there's a founder spotlight from someone who actually went through it — not just marketing copy," not "A named, specific accelerator program with a concrete founder spotlight demonstrating active participation and real companies."

If the post itself states when the thing happens (an event date or date range for the opportunity you're naming), include it as "dates" with "start" and optional "end" in YYYY-MM-DD form. Only dates the post actually states for that opportunity; never estimate.

Also give "category": one short word or two for the kind of thing this is (e.g. "accelerator", "fellowship", "grant", "investor", "mentor", "community", "speaking", "hiring", "other") — used later to notice which kinds of things actually work out for people, not shown to them.

Return ONLY valid JSON: {"index": 0, "name": "the specific opportunity name", "reason": "one short grounded sentence", "category": "...", "deadline": "YYYY-MM-DD" or null, "dates": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD" or null} or null} or {"index": null}`,
    });
    // Robust extraction (Royce, 2026-09-02, confirmed live: "Unexpected
    // token 'I', "I can see "..." — the model ignored "Return ONLY valid
    // JSON" and wrapped it in prose. Stripping code fences alone (the old
    // behavior) doesn't help when there's no fence at all, just a preamble/
    // trailing commentary around the object. Grabbing the outermost {...}
    // span handles both that case and the plain-JSON case identically.
    const parsed = parseModelJson(raw);
    if (typeof parsed?.index !== "number" || !posts[parsed.index]) return null;
    return {
      tier: 3,
      kind: "opportunity",
      name: parsed.name ?? posts[parsed.index].text.slice(0, 80),
      url: posts[parsed.index].url,
      reason: parsed.reason ?? "Found via a real, recent post.",
      category: typeof parsed?.category === "string" ? parsed.category.trim().toLowerCase().slice(0, 40) : null,
      ...(typeof parsed?.deadline === "string" ? { deadline: parsed.deadline } : {}),
      ...(parsed?.dates && typeof parsed.dates.start === "string" ? { statedDates: { start: parsed.dates.start, end: typeof parsed.dates.end === "string" ? parsed.dates.end : null } } : {}),
      evidence: posts[parsed.index].text,
      opportunity: { postText: posts[parsed.index].text },
    };
  } catch (err: any) {
    console.error("tieredRecommendation: extractRealOpportunity failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// query is pre-computed by the caller (proposeOpportunityQuery) so that
// classification — cheap, LLM-only — and the actual paid X search stay two
// separately-gateable steps, not one bundled call.
// A good match buried past X's default top-10 was never even seen by the
// extraction step (code review, 2026-09-17). extractRealOpportunity already
// reads every post in one digest, so the LLM step isn't the bottleneck —
// the raw fetch was. Doubled, not maxed out: X bills per post read
// regardless of the shared daily search-count budget (reserveXSearch caps
// how many SEARCHES happen, not how many posts each one reads), so this is
// a real cost increase per search, picked as a reasonable middle ground.
const TIER3_MAX_RESULTS = 20;

async function tryTier3(ask: StatedIntent, query: string, profile: string | null | undefined, zone: string): Promise<TierMatch | null> {
  // English originals only: retweets and other-language spam crowded out real
  // posts (2026-09-18 live check).
  const q = /-is:retweet/.test(query) ? query : `${query} -is:retweet lang:en`;
  const posts = await searchRecentPosts(q, TIER3_MAX_RESULTS).catch((err: any) => {
    console.error("tieredRecommendation: tryTier3 searchRecentPosts failed (non-fatal):", err?.message ?? err);
    return [];
  });
  return extractRealOpportunity(ask, posts, profile, zone);
}

// No winner-picking (Royce, 2026-08-30): "I don't think there should be a
// 'winner'. All 3 tiers should be surfaced, not exclude our users from an
// opportunity if Co finds one." decideBestMatch (the old LLM arbitration
// step) is gone — every tier that independently clears its own relevance bar
// (rankByRelevance's threshold for 1/2, extractRealOpportunity's groundedness
// requirement for 3) is a real, valid match and gets surfaced. Nothing is
// dropped for "losing" a comparison that no longer happens. This also closes
// a real bug the old design had: since decideBestMatch picked one match per
// cycle and eventSurfacingSweep.ts's dedup check ran AFTER that pick, a Co
// event that kept winning the comparison could permanently block a genuinely
// fresh Luma event from ever reaching the person once the Co event itself
// had already been offered — the whole attempt just bailed out instead of
// falling through to what was still new. Per-match dedup in
// eventSurfacingSweep.ts now filters the array before anything is sent, so a
// repeat-offered Tier 1 event no longer starves out a fresh Tier 2/3 one.
// Bundling multiple real matches into one tease/reveal (rather than one text
// per match) is eventDiscoverySurfacing.ts's job, not this file's — this
// module's only responsibility is finding what's real.

// Tier 1 + Tier 2 always run (both cheap/free). Tier 3's paid step (the X
// search) only runs when proposeOpportunityQuery — a cheap, LLM-only
// classification, always run alongside 1&2 — decides the ask is clearly
// opportunity-shaped on its own merits. If it isn't, there's no query to
// search for anyway, whether or not 1&2 found something. Empty array means
// nothing grounded was found anywhere — the caller (recommendation.ts) still
// has its own generic fallback for that case, same as before this existed.
// Every match goes through harness/matchGate.ts before it's returned
// (location, timing, grounding; plus no-repeat and a decision log when
// userId is given), so no caller can queue or show one the gate rejects.
// Speed and cost (2026-09-15). The same search within a few hours reuses its
// raw results; gating still runs per person. Tier 3 is the only paid search
// (X), so it has a budget: all X searches together stop at X_SEARCH_DAILY_CAP
// a day, and the background sweep stops X_SEARCH_REQUEST_RESERVE short of it
// so people asking directly still get Tier 3 (2026-09-17: the per-person sweep
// limit was gone, so a sweep could use the whole cap).
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// A cached result's events get their sold-out status re-read if the page read
// is older than this.
const CACHED_AVAILABILITY_MAX_AGE_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; found: TierMatch[]; trace: SearchTrace }>();
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

// What a search actually covered, for the decision record: which
// city Luma was asked about, the time frame from their own words, and
// whether it was a "what's on?" browse. Without it a "nothing found" record
// can't be told apart from "searched the wrong place".
export type SearchScope = {
  city: string | null;
  // Searched wider because they're frustrated with what Co has found.
  widened?: boolean;
  window: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  // A time frame they named that's past how far Co searches (askWindow.ts
  // MAX_ASK_DAYS_AHEAD). The search returns nothing instead of quietly
  // searching the default window (2026-09-17).
  windowOutOfRange?: { label: string; start: string; reason: string } | null;
  // The zone dates were read in, and whether it's Co's default because they
  // have no city or zone on file (2026-09-17).
  timezone?: string;
  timezoneDefaulted?: boolean;
  // Latest event start in the Luma feed this search saw, and whether that
  // covers the whole window they asked about.
  fetchedThrough?: string | null;
  windowCovered?: boolean | null;
  // The text actually searched (after the message was rewritten into a
  // request), how many nearby events were in the window, and the best Tier 2
  // relevance scores against the 0.35 bar, so an empty search shows why.
  searchText?: string | null;
  tier2Nearby?: number | null;
  tier2TopScores?: { name: string; similarity: number; profile?: number | null }[];
  // Whether their profile ordered the results.
  profileUsed?: boolean;
  // The best real event that didn't make it, with why, for a near miss.
  closest?: (Closest & { why: string }) | null;
  // Their own message, the rewrite into a search, which one was searched, and
  // why the rewrite was set aside if it was.
  rewrite?: { original: string; rewritten: string; used: string; rejectedBecause: string | null } | null;
  // Everything the relevance check turned down, with its reason.
  relevanceRejected?: { name: string; why: string; related?: boolean }[];
  // An X post that was found but kept out, and why.
  xDropped?: { name: string; reason: string } | null;
  // The X search query actually used (shaped by the ask and their profile).
  xQuery?: string | null;
  // Why Tier 3 didn't search X at all (budget), when it didn't.
  xBlocked?: string | null;
  // The general-web fallback query, tried only when X found nothing, and
  // why it didn't run (budget) when it didn't (2026-09-17).
  webQuery?: string | null;
  webBlocked?: string | null;
  // Which Tier 3 categories have (or haven't) worked out for this person
  // before, for an optional reply mention — never forced (2026-09-17).
  categoryInsight?: { worked: string[]; flopped: string[] } | null;
  // Whether these results were reused from an earlier identical search.
  cached?: boolean;
  // Milliseconds: all tiers together, Tier 3 on its own, Tier 2's relevance reads.
  timings?: { tiersMs?: number; tier3Ms?: number; relevanceMs?: number }; browse: boolean; tiers: number[]; dropped?: TierDrop | null; gatedOut?: GatedOut[] };
export type TierDrop = { tier: number; name: string; reason: string };

export type TieredResult = { matches: TierMatch[]; scope: SearchScope };

// A cached result's events, with sold-out status re-read, since it can change
// in the hours a result is reused (2026-09-17). A public event whose page
// can't be re-read now is dropped, same as an unread page in a fresh search.
async function refreshAvailability(found: TierMatch[]): Promise<TierMatch[]> {
  const refreshed = await Promise.all(
    found.map(async (m): Promise<TierMatch | null> => {
      if (m.tier === 3 || !m.url) return { ...m };
      const details = await fetchLumaEventDetails(m.url, { maxAgeMs: CACHED_AVAILABILITY_MAX_AGE_MS });
      if (details) return { ...m, details };
      return m.tier === 2 ? null : { ...m };
    }),
  );
  return refreshed.filter((m): m is TierMatch => m !== null);
}

// Every place the ask names, in the order it names them (the ask's own place
// wins over the profile city: "founder meetups near Fargo" from someone whose
// profile says SF), falling back to the profile city (2026-09-27: "this weekend in Sacramento or SF" became
// an SF-only search while Royce was in Sacramento). At most two.
const askCitiesCache = new Map<string, string[]>();
export function parseCities(parsed: any): string[] {
  const list = Array.isArray(parsed?.cities) ? parsed.cities : typeof parsed?.city === "string" ? [parsed.city] : [];
  return [...new Set(list.filter((c: unknown): c is string => typeof c === "string" && c.trim().length > 1).map((c: string) => c.trim()))].slice(0, 2) as string[];
}
export async function resolveSearchCities(askText: string | undefined, profileCity: string | null): Promise<(string | null)[]> {
  if (!askText) return [profileCity];
  if (!askCitiesCache.has(askText)) {
    let cities: string[] = [];
    try {
      const { text: raw } = await generateText({
        model: anthropic(EXTRACT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.resolveSearchCities" },
        prompt: `Which specific cities, metros, or regions does this request name as places they want to find something? "${askText}"

List every one, in the order named ("in Sacramento or SF" is two), each as a full name, never an abbreviation ("San Francisco, California", not "SF"). Return ONLY valid JSON: {"cities": ["City, State/Country", ...]} or {"cities": []} if no place is named or it's only "near me"/"online".`,
      });
      cities = parseCities(parseModelJson(raw));
    } catch (err: any) {
      console.error("tieredRecommendation: resolveSearchCities failed (non-fatal, using profile city):", err?.message ?? err);
      return [profileCity];
    }
    if (askCitiesCache.size > 500) askCitiesCache.clear();
    askCitiesCache.set(askText, cities);
  }
  const named = askCitiesCache.get(askText)!;
  return named.length ? named : [profileCity];
}

// Pure: one result from several cities' searches, the first city's first,
// each thing once.
export function mergeCityResults(results: TieredResult[]): TieredResult {
  const seen = new Set<string>();
  const matches: TierMatch[] = [];
  for (const r of results) {
    for (const m of r.matches) {
      const key = ("url" in m && m.url ? m.url : m.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(m);
    }
  }
  const scope = { ...results[0].scope, city: results.map((r) => r.scope.city).filter(Boolean).join(" + ") || results[0].scope.city };
  return { matches, scope };
}

export async function getTieredRecommendation(
  ask: StatedIntent,
  profileCity: string | null,
  opts: Parameters<typeof getTieredRecommendationFor>[2] = {},
): Promise<TieredResult> {
  const cities = await resolveSearchCities(ask.text, profileCity);
  if (cities.length < 2) return getTieredRecommendationFor(ask, cities[0] ?? null, opts);
  const results = await Promise.all(cities.map((c, i) => getTieredRecommendationFor(ask, c, { ...opts, skipTier3: i > 0 })));
  return mergeCityResults(results);
}

async function getTieredRecommendationFor(
  ask: StatedIntent,
  city: string | null,
  // rawMessage: their own words, used for the time frame and for spotting a
  // "what's on?" ask, since the search text is a rewrite that can drop both.
  // profile: what Co knows they want right now (personSnapshot.ts
  // profileForSearch); orders what matches the ask.
  // widen: they're frustrated with what Co has found; look further and keep more.
  // coreAsk: the member's own ask, for Tier 3. The sweep searches events with
  // a widened brief, but openings follow what they actually asked (2026-09-18:
  // "AI engineer meetups Thursday night" became a pre-seed funding X query).
  opts: { userId?: string; checkRepeat?: boolean; source?: "sweep" | "request"; timezone?: string | null; rawMessage?: string; profile?: string | null; widen?: boolean; coreAsk?: string | null; skipTier3?: boolean } = {},
): Promise<TieredResult> {
  const { zone, defaulted: timezoneDefaulted } = searchZone(opts.timezone);
  const trace = newTrace();
  // A time frame they named ("this weekend", "next Tuesday") scopes the
  // search to those days, whatever the default lookahead is.
  const asked = opts.rawMessage ?? ask.text ?? "";
  const now = DateTime.now().setZone(zone);
  const resolution = asked ? resolveAskWindow(asked, now) : { window: null, outOfRange: null };
  const window = resolution.window;
  const browse = !!asked && isBrowseAsk(asked);
  const baseScope = { city, window: window?.label ?? null, windowStart: window?.start.toISO() ?? null, windowEnd: window?.end.toISO() ?? null, timezone: zone, timezoneDefaulted, searchText: ask.text ?? null, profileUsed: !!opts.profile, browse, widened: !!opts.widen };

  // A time frame past what Co searches: say so, don't search next week instead.
  if (resolution.outOfRange) {
    const start = resolution.outOfRange.start.toISODate()!;
    return {
      matches: [],
      scope: {
        ...baseScope,
        windowOutOfRange: { label: resolution.outOfRange.label, start, reason: `${resolution.outOfRange.label} (${start}) is more than ${MAX_ASK_DAYS_AHEAD} days out, past how far ahead Co searches` },
        tiers: [],
      },
    };
  }

  const windowFilter = window ? (startAt: string) => withinWindow(startAt, window) : undefined;
  const maxDays = window ? Math.max(1, Math.ceil(window.end.diffNow("days").days) + 1) : undefined;
  const cacheKey = searchCacheKey({
    userId: opts.userId,
    city,
    askText: ask.text,
    windowStart: window?.start.toISODate() ?? null,
    windowEnd: window?.end.toISODate() ?? null,
    today: now.toISODate()!,
    zone,
    browse,
    // A widened search is a different search; don't serve the narrow one's cache.
    profile: opts.widen ? `${opts.profile ?? ""}|widen` : opts.profile,
  });
  const cached = searchCache.get(cacheKey);
  let found: TierMatch[];
  let usedCache = false;
  let t = trace;
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    found = await refreshAvailability(cached.found);
    // The record of what the original search saw, marked as reused.
    t = { ...cached.trace, xBlocked: null, webBlocked: null };
    usedCache = true;
  } else {
    const source = opts.source ?? "request";
    const tierStarted = Date.now();
    // Tier 3 runs alongside Tiers 1 and 2 instead of after them (2026-09-16:
    // it used to wait for both to finish).
    const tier3Ask: StatedIntent = opts.coreAsk?.trim() ? { ...ask, text: opts.coreAsk.trim() } : ask;
    const runTier3 = async (): Promise<TierMatch | null> => {
      // A second city in the same ask (getTieredRecommendation): posts aren't
      // tied to a city, so the first city's X search already covered them.
      if (opts.skipTier3) return null;
      const started = Date.now();
      try {
        // Every ask searches Tier 3 too (Royce, 2026-09-16: "Asks should always
        // include tier 2 and 3"). A post for a time-frame ask still has to
        // state a date inside it (below), and results name their source.
        const { query: opportunityQuery, worked, flopped } = await proposeOpportunityQuery(tier3Ask, city, opts.profile, zone, opts.userId);
        // Surfaced so a reply can OPTIONALLY mention the pattern instead of
        // only ever adjusting the search silently underneath them
        // (2026-09-17, "make the outcome-learning visible, not just
        // silent" — Royce, after noting Co's depth of awareness vs. Boardy's
        // more surface-level context). Never forced into every reply — the
        // reply agent decides if it's natural, same as every other fact.
        if (worked.length || flopped.length) trace.categoryInsight = { worked, flopped };
        if (!opportunityQuery) return null;
        const budget = await reserveXSearch(opts.userId ?? null, source, opportunityQuery);
        if (!budget.ok) {
          trace.xBlocked = budget.reason ?? "X search budget";
          return null;
        }
        trace.xQuery = opportunityQuery;
        let found = await tryTier3(tier3Ask, opportunityQuery, opts.profile, zone);
        // A named time frame: an X post only counts when the post itself
        // states a date inside it (the thing's own dates, or its deadline).
        // Posts with no date are kept out, with the reason recorded.
        if (found && found.kind === "opportunity" && window) {
          const stated = found.statedDates ?? (found.deadline ? { start: found.deadline } : null);
          const fits = xPostFitsWindow(stated, { start: window.start.toISO()!, end: window.end.toISO()! });
          if (!fits.ok) {
            trace.xDropped = { name: found.name, reason: fits.reason ?? "outside the time frame" };
            found = null;
          }
        }
        // A post the gate is going to reject counts as nothing, so the web
        // still gets its turn (2026-09-18: an a16z post with a deadline it
        // never stated blocked the web search, and the ask got nothing).
        if (found && found.tier === 3) {
          const facts = { searchCity: null, distanceMiles: null, alreadyOffered: false, now: new Date(), evidence: found.evidence ?? null, zone };
          const failed = [checkGrounding(found, facts), checkTiming(found, facts)].find((c) => !c.pass);
          if (failed) {
            trace.xDropped = { name: found.name, reason: failed.reason ?? failed.name };
            found = null;
          }
        }
        // X's recent-search only sees the last 7 days — a real fit for a
        // just-announced thing, a bad fit for the evergreen program pages
        // most grants/credits/city programs actually live on. Tried only
        // when X found nothing usable, so this doesn't double the cost of
        // every Tier 3 search (2026-09-17, "fold something like that into Co").
        if (!found) {
          const webBudget = await reserveWebSearch(opts.userId ?? null, source, opportunityQuery);
          if (!webBudget.ok) {
            trace.webBlocked = webBudget.reason ?? "web search budget";
          } else {
            trace.webQuery = opportunityQuery;
            // Their own ask, not the X query string it was being handed.
            found = await searchWebForOpportunity(tier3Ask.text ?? opportunityQuery, city, opts.profile, localToday(new Date(), zone), { source });
          }
        }
        return found;
      } finally {
        trace.timings.tier3Ms = Date.now() - started;
      }
    };
    // Always page the public feed to the end of the days being searched: the
    // window they named, or the default lookahead (2026-09-17).
    const until = window ? window.end.toJSDate() : new Date(Date.now() + (opts.widen ? WIDEN_TIER2_DAYS : DEFAULT_FEED_DAYS) * 24 * 60 * 60 * 1000);
    const [tier1, tier2, tier3] = await Promise.all([
      tryTier1(ask, city, windowFilter, { browse, maxDays, zone, profileText: opts.profile }),
      tryTier2(ask, city, windowFilter, trace, { browse, maxDays, until, zone, profileText: opts.profile, widen: opts.widen }),
      // Openings are searched by the daily sweep only (Royce, 2026-09-18:
      // "Take the openings search out of live replies"). The web search,
      // official-page lookup and reason rewrite were the slowest and flakiest
      // part of a reply; live replies send openings the sweep already found
      // (services/recommendation.ts alreadyFoundOpenings).
      source === "sweep" ? runTier3() : Promise.resolve(null),
    ]);
    trace.timings.tiersMs = Date.now() - tierStarted;
    // Every tier's candidates go to the gate, which keeps what's actually
    // offerable; one per tier survives below.
    found = [tier1, ...tier2, tier3].filter((m): m is TierMatch => m != null);
    // A live reply's named-event lookup (services/namedEventLookup.ts) runs later, in
    // sendblue.ts, after the real per-candidate fit check — not here. Tier 2's own coarse
    // relevance gate above often lets through things that are merely topic-adjacent (2026-09-21:
    // 8 unrelated SF Tech Week events passed this gate for "What's happening at AfroTech?" and
    // `found` was non-empty), so a check here that only fires when `found` is truly empty missed
    // that case entirely. sendblue.ts fires it once, only when nothing survived either check.
    if (searchCache.size > 300) searchCache.clear();
    // A "nothing" is never reused: events get added, and a cached empty
    // result hid them for six hours.
    if (shouldCacheSearch(found)) searchCache.set(cacheKey, { at: Date.now(), found, trace });
  }

  const gatedOut: GatedOut[] = [];
  const scope: SearchScope = {
    ...baseScope,
    fetchedThrough: t.fetchedThrough,
    tier2Nearby: t.nearbyCount,
    tier2TopScores: t.topScores,
    closest: t.closest,
    relevanceRejected: t.relevanceRejected,
    xDropped: t.xDropped,
    xQuery: t.xQuery,
    xBlocked: t.xBlocked,
    webQuery: t.webQuery,
    webBlocked: t.webBlocked,
    categoryInsight: t.categoryInsight,
    timings: t.timings,
    cached: usedCache,
    windowCovered: window && t.fetchedThrough ? new Date(t.fetchedThrough) >= window.end.toJSDate() : null,
    tiers: found.map((m) => m.tier),
    dropped: t.tierDrop,
    gatedOut,
  };
  const gated = await gateMatches(found, { userId: opts.userId ?? null, searchCity: city, checkRepeat: opts.checkRepeat, gatedOut, askedUntil: window ? window.end.toISODate() : null, lookaheadDays: opts.widen && !window ? WIDEN_TIER2_DAYS : null, zone });
  // Every offerable candidate, best first. Collapsing to one per tier here
  // threw the right event away (2026-09-16: "Voice AI Happy Hour" passed the
  // gate but lost the Tier 2 slot to a higher-ranked event the fit check then
  // rejected). The caller picks one per tier after the fit check.
  // A web result's whole page was only needed for the gate; what gets queued
  // and saved to backlogs keeps the short excerpt Co drafts from.
  const trimmed = gated.map((m) => (m.tier === 3 && m.source === "web" && m.evidence ? { ...m, evidence: m.opportunity?.postText ?? m.evidence.slice(0, 2500) } : m));
  return { matches: trimmed, scope };
}

// The daily urgent-only Tier 1/2 pre-check (checkForUrgentMatch) was removed
// 2026-09-14 (Royce: "it should be actively searching for all 3 tiers"): the
// sweep now runs the full engine every day and paces sends separately.

// For evals.
export { isGenuinelyRelevant };
