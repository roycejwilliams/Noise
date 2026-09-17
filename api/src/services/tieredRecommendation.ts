import { generateText } from "ai";
import { shouldCacheSearch, xPostFitsWindow } from "./searchRules.js";
import { DateTime } from "luxon";
import { isBrowseAsk, parseAskWindow, withinWindow } from "./askWindow.js";
import { anthropic } from "@ai-sdk/anthropic";
import { listCalendarEvents } from "./luma.js";
import { fetchPublicEvents } from "./lumaDiscovery.js";
import { rankEventsByDescription, type Closest } from "./eventRanking.js";
import { localDate } from "./eventOrder.js";
import { fetchLumaEventDetails, type EventDetails, type OpportunityDetails } from "./eventDetails.js";
import { searchRecentPosts } from "./xSearch.js";
import { withinRadius } from "./geocoding.js";
import type { StatedIntent } from "./matching.js";
import { gateMatches, type GatedOut } from "../harness/matchGate.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import pool from "../db/db.js";

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
// so Tier 3 is specifically accelerators, fellowships, and similar real
// opportunities, sourced from X's recent-search (xSearch.ts), not Google
// Places. A physical venue lookup isn't the fallback shape that matches who
// Co is actually for.
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
type MatchExtras = { details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string; fits?: boolean };
export type TierMatch =
  | ({ tier: 1; kind: "co_event"; event_api_id: string; event_date: string; name: string; url?: string; reason: string; city?: string | null } & MatchExtras)
  | ({ tier: 2; kind: "public_event"; event_api_id: string; event_date: string; name: string; url: string; reason: string; city?: string | null } & MatchExtras)
  | ({ tier: 3; kind: "opportunity"; name: string; url: string; reason: string; deadline?: string; evidence?: string; statedDates?: { start: string; end?: string | null } } & MatchExtras);

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
async function filterByRadius<T extends { city?: string | null }>(
  candidates: T[],
  userCity: string | null,
): Promise<T[]> {
  if (!userCity) return candidates;
  // An event with no city on file can't be claimed as nearby (2026-09-14:
  // a city-less Co event in SF passed this filter and got described to
  // someone asking about Fargo as "close to Fargo"). Only drop it when we
  // do know where the person wants to be; ungeocodable strings still pass.
  const withinFlags = await Promise.all(candidates.map((c) => (c.city ? withinRadius(userCity, c.city) : false)));
  return candidates.filter((_, i) => withinFlags[i]);
}

// The ask's own place wins over the profile city ("founder meetups near
// Fargo" from someone whose profile says SF). Cached per ask text since the
// urgent pre-check re-runs the same asks every day.
const askCityCache = new Map<string, string | null>();
async function resolveSearchCity(askText: string | undefined, profileCity: string | null): Promise<string | null> {
  if (!askText) return profileCity;
  if (!askCityCache.has(askText)) {
    let city: string | null = null;
    try {
      const { text: raw } = await generateText({
        model: anthropic(EXTRACT_MODEL),
        experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.resolveSearchCity" },
        prompt: `Does this request name a specific city, metro, or region where they want to find something? "${askText}"

Return ONLY valid JSON: {"city": "City, State/Country" or null}. null if no place is named or it's only "near me"/"online".`,
      });
      const parsed = parseModelJson(raw);
      city = typeof parsed?.city === "string" && parsed.city.trim() ? parsed.city.trim() : null;
    } catch (err: any) {
      console.error("tieredRecommendation: resolveSearchCity failed (non-fatal, using profile city):", err?.message ?? err);
      return profileCity;
    }
    if (askCityCache.size > 500) askCityCache.clear();
    askCityCache.set(askText, city);
  }
  return askCityCache.get(askText) ?? profileCity;
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
3. fit: true only if the event's own main activity is the kind they asked for. Who attends, who hosts, or who sponsors never changes what kind of event it is: a chess night full of AI researchers is still a chess night. Close variants of the same kind are fine (an AI demo night fits "AI meetup"; a founder dinner fits "founder meetup"; a build day or hackathon fits an ask for builders, since building together is the point). Also false if it's clearly somewhere other than where they asked.

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
// (lumaDiscovery.rankByRelevance) since both are "rank real events against
// an ask" with the same signal (name + city) available — Co's own events
// just come from luma.ts's sanctioned API instead of the unofficial
// discovery feed. `userCity` now drives a hard radius filter (filterByRadius
// above) before ranking, not a ranking bias; optional `filter` (by event
// start_at) is reused by checkForUrgentMatch below to further restrict to a
// near-term window on top of the lookahead baseline, rather than
// duplicating this construction a second time.
// Event lists are the same for everyone, so fetch them at most every 15
// minutes instead of once per search.
const LIST_TTL_MS = 15 * 60 * 1000;
let calendarCache: { at: number; events: Awaited<ReturnType<typeof listCalendarEvents>> } | null = null;
async function cachedCalendarEvents() {
  if (calendarCache && Date.now() - calendarCache.at < LIST_TTL_MS) return calendarCache.events;
  const events = await listCalendarEvents();
  calendarCache = { at: Date.now(), events };
  return events;
}
// Cached per city, since the feed is city-scoped now.
const publicCacheByCity = new Map<string, { at: number; events: Awaited<ReturnType<typeof fetchPublicEvents>> }>();

async function cachedPublicEvents(city?: string | null, until?: Date | null) {
  // A far window needs a deeper fetch, cached separately by the day it reaches.
  const key = `${(city ?? "").toLowerCase()}|${until ? until.toISOString().slice(0, 10) : ""}`;
  const cached = publicCacheByCity.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.events;
  const events = await fetchPublicEvents(50, city ?? null, until ?? null);
  if (publicCacheByCity.size > 20) publicCacheByCity.clear();
  publicCacheByCity.set(key, { at: Date.now(), events });
  return events;
}

async function tryTier1(ask: StatedIntent, userCity: string | null, filter?: (startAt: string) => boolean, opts: { browse?: boolean; maxDays?: number; zone?: string | null; profileText?: string | null } = {}): Promise<TierMatch | null> {
  const events = await cachedCalendarEvents().catch((err: any) => {
    console.error("tieredRecommendation: tryTier1 listCalendarEvents failed (non-fatal):", err?.message ?? err);
    return [];
  });
  const inWindow = events.filter((e) => isWithinLookaheadWindow(e.start_at, opts.maxDays ?? TIER1_MAX_LOOKAHEAD_DAYS) && (!filter || filter(e.start_at)));
  const nearby = await filterByRadius(inWindow, userCity);
  // They asked what's on in a window, not for a topic: the soonest one in
  // that window is the answer, so relevance ranking would only reject it.
  const match =
    opts.browse && !opts.profileText
      ? soonest(nearby)
      : (await rankEventsByDescription(nearby, opts.browse ? "" : ask.text ?? "", { limit: 1, profileText: opts.profileText, browse: opts.browse })).ranked[0] ?? null;
  if (!match) return null;
  const details = ("details" in match ? (match.details as EventDetails | undefined) : undefined) ?? (match.url ? ((await fetchLumaEventDetails(match.url)) ?? undefined) : undefined);
  return {
    details,
    tier: 1,
    kind: "co_event",
    event_api_id: match.api_id,
    event_date: localDate(match.start_at, opts.zone),
    name: match.name,
    reason: `Matches a Co event happening ${new Date(match.start_at).toLocaleDateString()}${match.city ? ` in ${match.city}` : ""}.`,
    city: match.city ?? null,
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

// Returns the candidates worth offering, best first — the gate
// (harness/matchGate.ts) makes the final call, and it needs more than one to
// choose from (2026-09-16: the single candidate it got was sold out, so the
// search ended with nothing while other real events were available).
async function tryTier2(ask: StatedIntent, userCity: string | null, filter?: (startAt: string) => boolean, opts: { browse?: boolean; maxDays?: number; until?: Date | null; zone?: string | null; profileText?: string | null } = {}): Promise<TierMatch[]> {
  // Only page deep when the window reaches past what a normal fetch covers.
  const farUntil = opts.until && opts.until.getTime() - Date.now() > 8 * 24 * 60 * 60 * 1000 ? opts.until : null;
  const events = await cachedPublicEvents(userCity, farUntil).catch((err: any) => {
    console.error("tieredRecommendation: tryTier2 fetchPublicEvents failed (non-fatal):", err?.message ?? err);
    return [];
  });
  // How far the fetched feed actually reached, so a search that asked about
  // Oct 5-14 but only got events through Oct 9 says so instead of reporting a
  // clean "nothing found".
  lastFetchedThrough = events.reduce<string | null>((latest, e) => (!latest || e.start_at > latest ? e.start_at : latest), null);
  const inWindow = events.filter((e) => isWithinLookaheadWindow(e.start_at, opts.maxDays ?? TIER2_MAX_LOOKAHEAD_DAYS) && (!filter || filter(e.start_at)));
  const nearby = await filterByRadius(inWindow, userCity);
  // The best few, not just the top one: a single odd top pick used to take
  // the whole search down when the relevance check rejected it, with real
  // matches sitting further down the same list (2026-09-16).
  lastTopScores = [];
  lastNearbyCount = nearby.length;
  // Ranked on each event's description, open events first
  // (services/eventRanking.ts); the closest one is kept for a near miss.
  // With a profile, even a "what's on?" ask is ordered by what fits them,
  // not by what's soonest (Royce, 2026-09-16: "give them things that match
  // their profile").
  const ranking =
    opts.browse && !opts.profileText
      ? { ranked: [soonest(nearby)].filter((m): m is (typeof nearby)[number] => !!m).map((m) => ({ ...m, similarity: 1, details: undefined as EventDetails | undefined })), closest: null }
      : await rankEventsByDescription(nearby, opts.browse ? "" : ask.text ?? "", { limit: 6, topScores: lastTopScores, zone: opts.zone, profileText: opts.profileText, browse: opts.browse });
  // The near miss comes only from events the relevance check actually read
  // and judged related; an unread best score is never named on its own.
  const candidates = ranking.ranked;
  const rejected: string[] = [];
  const kept: TierMatch[] = [];
  // Every candidate is read at the same time, then handled in ranked order
  // exactly as before (2026-09-16: reading up to six one after another was
  // most of an 18-second search).
  const relevanceStarted = Date.now();
  const reads = await Promise.all(
    candidates.map(async (match) => {
      const details = match.details ?? (await fetchLumaEventDetails(match.url)) ?? undefined;
      const verdict: RelevanceVerdict =
        ask.text && !opts.browse ? await isGenuinelyRelevant(ask.text, match.name, match.city, details?.description ?? null) : { fit: true, why: null };
      return { details, verdict };
    }),
  );
  lastTimings.relevanceMs = Date.now() - relevanceStarted;
  for (const [i, match] of candidates.entries()) {
    const { details, verdict } = reads[i];
    if (!verdict.fit) {
      rejected.push(match.name);
      lastRelevanceRejected.push({ name: match.name, why: verdict.why ?? "doesn't match what they asked", related: verdict.related ?? false });
      // The nearest miss is the best-scoring one the check turned down, not
      // the first one it read: candidates are ordered open-first, so the first
      // read can be a weaker open event (2026-09-16: Maum Market was named
      // over Claude Fable 5.1 Build Day).
      const similarity = Math.round(match.similarity * 1000) / 1000;
      // Only something they might still consider is worth naming as a near
      // miss (2026-09-16: a shopping market was offered as the closest thing
      // to a founder meetup).
      if (verdict.related && (!lastClosest || similarity > lastClosest.similarity)) {
        lastClosest = {
          name: match.name,
          url: match.url ?? null,
          date: localDate(match.start_at, opts.zone),
          similarity,
          why: `${verdict.why ?? "on reading what it's about, it isn't quite what they asked for"}${details?.soldOut ? ", and it's sold out" : ""}`,
        };
      }
      continue;
    }
    kept.push({
      details,
      tier: 2,
      kind: "public_event",
      event_api_id: match.api_id,
      event_date: localDate(match.start_at, opts.zone),
      name: match.name,
      url: match.url,
      reason: `A public event that looks like a real fit${match.city ? ` in ${match.city}` : ""}.`,
      city: match.city ?? null,
    });
  }
  // Nothing cleared the bar: read the closest one anyway. If it really fits,
  // offer it (the bar only cuts noise); if not, its reason is what the person
  // hears about the near miss, not a generic "not close enough".
  if (!kept.length && !candidates.length && ask.text && !opts.browse && ranking.closest) {
    const near = nearby.find((e) => e.name === ranking.closest!.name);
    if (near) {
      const details = (await fetchLumaEventDetails(near.url)) ?? undefined;
      const verdict = await isGenuinelyRelevant(ask.text, near.name, near.city, details?.description ?? null);
      if (verdict.fit) {
        kept.push({
          details,
          tier: 2,
          kind: "public_event",
          event_api_id: near.api_id,
          event_date: localDate(near.start_at, opts.zone),
          name: near.name,
          url: near.url,
          reason: `A public event that looks like a real fit${near.city ? ` in ${near.city}` : ""}.`,
          city: near.city ?? null,
        });
        lastClosest = null;
      } else {
        lastRelevanceRejected.push({ name: near.name, why: verdict.why ?? "doesn't match what they asked", related: verdict.related ?? false });
        if (verdict.related) {
          lastClosest = { ...ranking.closest!, why: `${verdict.why ?? "on reading what it's about, it isn't quite what they asked for"}${details?.soldOut ? ", and it's sold out" : ""}` };
        }
      }
    }
  }
  if (rejected.length && !kept.length) {
    lastTierDrop = { tier: 2, name: rejected.join("; "), reason: `the relevance check rejected ${rejected.length === 1 ? "it" : "all of them"} as not matching what they asked` };
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
async function proposeOpportunityQuery(ask: StatedIntent, city: string | null, profile?: string | null): Promise<string | null> {
  if (!ask.text) return null;
  try {
    // Today's date, explicit (Royce, 2026-09-02) — confirmed live: without
    // this, the model defaulted to a plausible-sounding but wrong year from
    // its training data ("SF accelerator program applications open 2024"),
    // and that literal wrong year in the query killed recall entirely (0
    // results from X's own 7-day recent-search, which will never contain a
    // stale year string). extractRealOpportunity already gets today's date
    // for its own deadline check; this step needs it too, for the same
    // reason.
    const todayStr = new Date().toISOString().slice(0, 10);
    const { text: raw } = await generateText({
      model: anthropic(EXTRACT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.proposeOpportunityQuery" },
      prompt: `Someone wants: "${ask.text}"${city ? ` (based in ${city})` : ""}
${profile ? `\nWho they are right now (use it to aim the query at opportunities suited to their stage and situation, e.g. Series A programs rather than beginner ones; their ask still decides the topic):\n${profile}\n` : ""}
Today's date: ${todayStr}

Propose a short X search query (2-4 broad, distinctive keywords, not a question) likely to surface real, recent posts about a concrete opportunity that fits what they want: an accelerator, fellowship, cohort-based program, residency, grant, or a named community, club, or recurring group they could join. Always propose one when there's any topic to search on; social or hobby asks map to communities and groups. Never include a specific year in the query unless the person's own ask text stated one — a wrong or stale year keyword will filter out real current posts that don't happen to mention that exact year. Never include the person's own city/region as a keyword either (confirmed live: adding "SF Bay Area" to an otherwise-good query dropped real matching posts to zero) — a real opportunity post almost never mentions the seeker's own location, only the program's own name and field. Return null only when there's no topic at all to search on.

Return ONLY valid JSON: {"query": "..." or null}`,
    });
    // Same robustness fix as extractRealOpportunity below — a preamble/
    // trailing-commentary wrap around the JSON isn't caught by stripping
    // code fences alone.
    const parsed = parseModelJson(raw);
    return typeof parsed?.query === "string" ? parsed.query : null;
  } catch (err: any) {
    console.error("tieredRecommendation: proposeOpportunityQuery failed (non-fatal):", err?.message ?? err);
    return null;
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
  profile?: string | null,
): Promise<TierMatch | null> {
  if (!posts.length) return null;
  try {
    const digest = posts.map((p, i) => `${i}. ${p.text.replace(/\n+/g, " ")}`).join("\n");
    const todayStr = new Date().toISOString().slice(0, 10);
    const { text: raw } = await generateText({
      model: anthropic(EXTRACT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.extractRealOpportunity" },
      prompt: `Someone wants: "${ask.text}"
${profile ? `\nWho they are right now:\n${profile}\n\nAmong posts that fit what they want, pick the one best suited to who they are (their stage, what they're working on, what they want now). Skip an opportunity clearly aimed at a different stage or audience than theirs.\n` : ""}
Today's date: ${todayStr}

Here are real recent posts from X, one per line:
${digest}

Pick the ONE post (if any) that names a real, concrete opportunity (a specific accelerator, fellowship, program, residency, grant, or a named community, club, or recurring group someone can actually join — not vague hype, not an unrelated post) genuinely relevant to what they want. Name the opportunity using only what's actually in that post — never add details that aren't there.

Skip anything that reads as hype, clickbait, or an engagement-bait "BREAKING" post without real concrete substance behind it (a specific program name, a real application process) — prefer a plainly-stated, verifiable opportunity over a dramatic-sounding one. A repost/retweet of someone else's claim is not independently more credible just because it's been shared multiple times.

Some posts list SEVERAL distinct opportunities in one message (e.g. "1. Slush 100 — Deadline: Sept 7 ... 2. Techstars Anywhere ..."). If you pick a post like that, attribute every detail — especially the deadline — ONLY to the specific opportunity you're naming, never a detail stated for a different program listed in the same post. If the one you're actually naming has no deadline of its own stated, leave deadline out entirely even if another program mentioned right next to it has one.

If a post's own text gives a deadline or application window that has clearly already closed relative to today's date, don't pick it — there's nothing left to act on. Rolling admissions, no stated deadline, or a deadline still ahead are all fine to pick. If the post states an explicit application deadline date for the SPECIFIC opportunity you're naming, include it as "deadline" in YYYY-MM-DD form — only if that opportunity itself actually states one, never estimate, infer, or borrow one from a different program in the same post.

Write "reason" the way Co would say it to a friend over text — one short, casual sentence. Keep exactly one concrete, grounded detail that proves it's real (not vague hype), but never in analyst language ("demonstrates," "concrete evidence of," "showcasing") — say it plainly, the way a person would, not a scoring rationale. E.g. "Real accelerator, and there's a founder spotlight from someone who actually went through it — not just marketing copy," not "A named, specific accelerator program with a concrete founder spotlight demonstrating active participation and real companies."

If the post itself states when the thing happens (an event date or date range for the opportunity you're naming), include it as "dates" with "start" and optional "end" in YYYY-MM-DD form. Only dates the post actually states for that opportunity; never estimate.

Return ONLY valid JSON: {"index": 0, "name": "the specific opportunity name", "reason": "one short grounded sentence", "deadline": "YYYY-MM-DD" or null, "dates": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD" or null} or null} or {"index": null}`,
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
async function tryTier3(ask: StatedIntent, query: string, profile?: string | null): Promise<TierMatch | null> {
  const posts = await searchRecentPosts(query).catch((err: any) => {
    console.error("tieredRecommendation: tryTier3 searchRecentPosts failed (non-fatal):", err?.message ?? err);
    return [];
  });
  return extractRealOpportunity(ask, posts, profile);
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
// Speed and cost (2026-09-15). The same search (text + city) within a few
// hours reuses its raw results; gating still runs per person. Tier 3 is the
// only paid search (X), so it has a budget: the background sweep gets one X
// search per person every X_SEARCH_SWEEP_DAYS, and all X searches together
// stop at X_SEARCH_DAILY_CAP a day. Someone asking directly always counts
// toward the daily cap but isn't held to the per-person sweep limit.
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const searchCache = new Map<string, { at: number; found: TierMatch[] }>();
const X_SEARCH_SWEEP_DAYS = Number(process.env.X_SEARCH_SWEEP_DAYS ?? 3);
const X_SEARCH_DAILY_CAP = Number(process.env.X_SEARCH_DAILY_CAP ?? 100);

async function paidSearchAllowed(userId: string | null, source: "sweep" | "request"): Promise<{ ok: boolean; reason: string }> {
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM x_search_log WHERE created_at > NOW() - INTERVAL '1 day') AS today,
         (SELECT COUNT(*)::int FROM x_search_log WHERE user_id = $1 AND source = 'sweep' AND created_at > NOW() - ($2 || ' days')::interval) AS mine`,
      [userId, X_SEARCH_SWEEP_DAYS],
    );
    if (rows[0].today >= X_SEARCH_DAILY_CAP) return { ok: false, reason: `daily X search cap (${X_SEARCH_DAILY_CAP}) reached` };
    if (source === "sweep" && userId && rows[0].mine > 0) return { ok: false, reason: `already searched X for them in the last ${X_SEARCH_SWEEP_DAYS} days` };
    return { ok: true, reason: "within budget" };
  } catch {
    return { ok: true, reason: "budget check unavailable" };
  }
}

// What the last search actually covered, for the decision record: which
// city Luma was asked about, the time frame from their own words, and
// whether it was a "what's on?" browse. Without it a "nothing found" record
// can't be told apart from "searched the wrong place".
export type SearchScope = {
  city: string | null;
  window: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
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
  // Milliseconds: all tiers together, Tier 3 on its own, Tier 2's relevance reads.
  timings?: { tiersMs?: number; tier3Ms?: number; relevanceMs?: number }; browse: boolean; tiers: number[]; dropped?: TierDrop | null; gatedOut?: GatedOut[] };
export type TierDrop = { tier: number; name: string; reason: string };
let lastSearchScope: SearchScope | null = null;
let lastTierDrop: TierDrop | null = null;
let lastFetchedThrough: string | null = null;
let lastTopScores: { name: string; similarity: number; profile?: number | null }[] = [];
let lastClosest: (Closest & { why: string }) | null = null;
let lastRelevanceRejected: { name: string; why: string; related?: boolean }[] = [];
let lastXDropped: { name: string; reason: string } | null = null;
let lastXQuery: string | null = null;
// Where the search time goes, for turn.latency-style reading of one search.
let lastTimings: { tiersMs?: number; tier3Ms?: number; relevanceMs?: number } = {};
let lastNearbyCount: number | null = null;

export function takeLastSearchScope(): SearchScope | null {
  const scope = lastSearchScope;
  lastSearchScope = null;
  return scope;
}

export async function getTieredRecommendation(
  ask: StatedIntent,
  profileCity: string | null,
  // rawMessage: their own words, used for the time frame and for spotting a
  // "what's on?" ask, since the search text is a rewrite that can drop both.
  // profile: what Co knows they want right now (personSnapshot.ts
  // profileFocusText); orders what matches the ask.
  opts: { userId?: string; checkRepeat?: boolean; source?: "sweep" | "request"; timezone?: string | null; rawMessage?: string; profile?: string | null } = {},
): Promise<TierMatch[]> {
  const city = await resolveSearchCity(ask.text, profileCity);
  // A time frame they named ("this weekend", "next Tuesday") scopes the
  // search to those days, whatever the default lookahead is.
  lastTierDrop = null;
  lastFetchedThrough = null;
  lastTopScores = [];
  lastNearbyCount = null;
  lastClosest = null;
  lastRelevanceRejected = [];
  lastXDropped = null;
  lastXQuery = null;
  lastTimings = {};
  const asked = opts.rawMessage ?? ask.text ?? "";
  const window = asked ? parseAskWindow(asked, DateTime.now().setZone(opts.timezone ?? "local")) : null;
  const browse = !!asked && isBrowseAsk(asked);
  const windowFilter = window ? (startAt: string) => withinWindow(startAt, window) : undefined;
  const maxDays = window ? Math.max(1, Math.ceil(window.end.diffNow("days").days) + 1) : undefined;
  const cacheKey = `${(city ?? "").toLowerCase()}|${(ask.text ?? "").trim().toLowerCase()}|${window?.label ?? ""}|${opts.profile ? opts.profile.length + ":" + opts.profile.slice(0, 40) : ""}`;
  const cached = searchCache.get(cacheKey);
  let found: TierMatch[];
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    found = cached.found;
  } else {
    const source = opts.source ?? "request";
    const tierStarted = Date.now();
    // Tier 3 runs alongside Tiers 1 and 2 instead of after them (2026-09-16:
    // it used to wait for both to finish).
    const runTier3 = async (): Promise<TierMatch | null> => {
      const started = Date.now();
      try {
        // Asking what's on the calendar is a question about events, not about
        // posts on X (2026-09-16: "what's been surfacing on Luma this weekend"
        // came back with an X post, and Co never said where it came from).
        if (browse) return null;
        const budget = await paidSearchAllowed(opts.userId ?? null, source);
        if (!budget.ok) return null;
        const opportunityQuery = await proposeOpportunityQuery(ask, city, opts.profile);
        if (!opportunityQuery) return null;
        await pool
          .query(`INSERT INTO x_search_log (user_id, source, query) VALUES ($1, $2, $3)`, [opts.userId ?? null, source, opportunityQuery])
          .catch(() => {});
        lastXQuery = opportunityQuery;
        let found = await tryTier3(ask, opportunityQuery, opts.profile);
        // A named time frame: an X post only counts when the post itself
        // states a date inside it (the thing's own dates, or its deadline).
        // Posts with no date are kept out, with the reason recorded.
        if (found && found.kind === "opportunity" && window) {
          const stated = found.statedDates ?? (found.deadline ? { start: found.deadline } : null);
          const fits = xPostFitsWindow(stated, { start: window.start.toISO()!, end: window.end.toISO()! });
          if (!fits.ok) {
            lastXDropped = { name: found.name, reason: fits.reason ?? "outside the time frame" };
            found = null;
          }
        }
        return found;
      } finally {
        lastTimings.tier3Ms = Date.now() - started;
      }
    };
    const [tier1, tier2, tier3] = await Promise.all([
      tryTier1(ask, city, windowFilter, { browse, maxDays, zone: opts.timezone, profileText: opts.profile }),
      tryTier2(ask, city, windowFilter, { browse, maxDays, until: window ? window.end.toJSDate() : null, zone: opts.timezone, profileText: opts.profile }),
      runTier3(),
    ]);
    lastTimings.tiersMs = Date.now() - tierStarted;
    // Every tier's candidates go to the gate, which keeps what's actually
    // offerable; one per tier survives below.
    const gateable = [tier1, ...tier2, tier3].filter((m): m is TierMatch => m != null);
    found = gateable;
    if (searchCache.size > 300) searchCache.clear();
    // A "nothing" is never reused: events get added, and a cached empty
    // result hid them for six hours.
    if (shouldCacheSearch(found)) searchCache.set(cacheKey, { at: Date.now(), found });
  }

  lastSearchScope = { city, window: window?.label ?? null, windowStart: window?.start.toISO() ?? null, windowEnd: window?.end.toISO() ?? null,
    fetchedThrough: lastFetchedThrough,
    searchText: ask.text ?? null,
    tier2Nearby: lastNearbyCount,
    tier2TopScores: lastTopScores,
    closest: lastClosest,
    profileUsed: !!opts.profile,
    relevanceRejected: lastRelevanceRejected,
    xDropped: lastXDropped,
    xQuery: lastXQuery,
    timings: lastTimings,
    windowCovered: window && lastFetchedThrough ? new Date(lastFetchedThrough) >= window.end.toJSDate() : null, browse, tiers: found.map((m) => m.tier), dropped: lastTierDrop };
  lastTierDrop = null;
  const gatedOut: GatedOut[] = [];
  const gated = await gateMatches(found, { userId: opts.userId ?? null, searchCity: city, checkRepeat: opts.checkRepeat, gatedOut, askedUntil: window ? window.end.toISODate() : null });
  if (lastSearchScope) lastSearchScope.gatedOut = gatedOut;
  // Every offerable candidate, best first. Collapsing to one per tier here
  // threw the right event away (2026-09-16: "Voice AI Happy Hour" passed the
  // gate but lost the Tier 2 slot to a higher-ranked event the fit check then
  // rejected). The caller picks one per tier after the fit check.
  return gated;
}

// The daily urgent-only Tier 1/2 pre-check (checkForUrgentMatch) was removed
// 2026-09-14 (Royce: "it should be actively searching for all 3 tiers"): the
// sweep now runs the full engine every day and paces sends separately.

// For evals.
export { isGenuinelyRelevant };
