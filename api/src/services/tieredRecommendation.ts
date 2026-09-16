import { generateText } from "ai";
import { DateTime } from "luxon";
import { isBrowseAsk, parseAskWindow, withinWindow } from "./askWindow.js";
import { anthropic } from "@ai-sdk/anthropic";
import { listCalendarEvents } from "./luma.js";
import { fetchPublicEvents, rankByRelevance } from "./lumaDiscovery.js";
import { fetchLumaEventDetails, type EventDetails, type OpportunityDetails } from "./eventDetails.js";
import { searchRecentPosts } from "./xSearch.js";
import { withinRadius } from "./geocoding.js";
import type { StatedIntent } from "./matching.js";
import { gateMatches } from "../harness/matchGate.js";
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
  | ({ tier: 3; kind: "opportunity"; name: string; url: string; reason: string; deadline?: string; evidence?: string } & MatchExtras);

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
async function isGenuinelyRelevant(askText: string, candidateName: string, candidateCity: string | null, description: string | null): Promise<boolean> {
  if (!description) return true;
  try {
    const { text: raw } = await generateText({
      model: anthropic(JUDGE_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.relevanceGate" },
      prompt: `Someone said: "${askText}"

Co is considering recommending this real event: "${candidateName}"${candidateCity ? ` in ${candidateCity}` : ""}.

Its actual description: "${description}"

Based on the real description, not just the name, is this genuinely a strong, specific fit for what they're actually asking for? Reject it only if the real description makes clear this is a meaningfully different kind of thing than what they want — a loose, plausible topical connection is fine to accept, but a clear mismatch once you read what it's actually about should be rejected.

Return ONLY "yes" or "no".`,
    });
    return raw.trim().toLowerCase().startsWith("yes");
  } catch (err: any) {
    console.error("tieredRecommendation: isGenuinelyRelevant failed (non-fatal, allowing match through):", err?.message ?? err);
    return true;
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

async function cachedPublicEvents(city?: string | null) {
  const key = (city ?? "").toLowerCase();
  const cached = publicCacheByCity.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.events;
  const events = await fetchPublicEvents(50, city ?? null);
  if (publicCacheByCity.size > 20) publicCacheByCity.clear();
  publicCacheByCity.set(key, { at: Date.now(), events });
  return events;
}

async function tryTier1(ask: StatedIntent, userCity: string | null, filter?: (startAt: string) => boolean, opts: { browse?: boolean; maxDays?: number } = {}): Promise<TierMatch | null> {
  const events = await cachedCalendarEvents().catch((err: any) => {
    console.error("tieredRecommendation: tryTier1 listCalendarEvents failed (non-fatal):", err?.message ?? err);
    return [];
  });
  const inWindow = events.filter((e) => isWithinLookaheadWindow(e.start_at, opts.maxDays ?? TIER1_MAX_LOOKAHEAD_DAYS) && (!filter || filter(e.start_at)));
  const nearby = await filterByRadius(inWindow, userCity);
  // They asked what's on in a window, not for a topic: the soonest one in
  // that window is the answer, so relevance ranking would only reject it.
  const match = opts.browse ? soonest(nearby) : await rankByRelevance(nearby, ask);
  if (!match) return null;
  const details = match.url ? ((await fetchLumaEventDetails(match.url)) ?? undefined) : undefined;
  return {
    details,
    tier: 1,
    kind: "co_event",
    event_api_id: match.api_id,
    event_date: match.start_at.slice(0, 10),
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

async function tryTier2(ask: StatedIntent, userCity: string | null, filter?: (startAt: string) => boolean, opts: { browse?: boolean; maxDays?: number } = {}): Promise<TierMatch | null> {
  const events = await cachedPublicEvents(userCity).catch((err: any) => {
    console.error("tieredRecommendation: tryTier2 fetchPublicEvents failed (non-fatal):", err?.message ?? err);
    return [];
  });
  const inWindow = events.filter((e) => isWithinLookaheadWindow(e.start_at, opts.maxDays ?? TIER2_MAX_LOOKAHEAD_DAYS) && (!filter || filter(e.start_at)));
  const nearby = await filterByRadius(inWindow, userCity);
  const match = opts.browse ? soonest(nearby) : await rankByRelevance(nearby, ask);
  if (!match) return null;
  const details = (await fetchLumaEventDetails(match.url)) ?? undefined;
  if (ask.text && !opts.browse) {
    if (!(await isGenuinelyRelevant(ask.text, match.name, match.city, details?.description ?? null))) return null;
  }
  return {
    details,
    tier: 2,
    kind: "public_event",
    event_api_id: match.api_id,
    event_date: match.start_at.slice(0, 10),
    name: match.name,
    url: match.url,
    reason: `A public event that looks like a real fit${match.city ? ` in ${match.city}` : ""}.`,
    city: match.city ?? null,
  };
}

// Tier 3 — a real opportunity (accelerator, fellowship, program), via X's
// recent search (xSearch.ts). The raw ask text isn't a good search query on
// its own ("climate tech founders" won't surface accelerator posts), so this
// asks the model to propose a real search query first, same "ground it,
// never invent one" discipline as before — the difference from the old
// venue version is the grounding element is a real post URL, not a
// place_id.
async function proposeOpportunityQuery(ask: StatedIntent, city: string | null): Promise<string | null> {
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
): Promise<TierMatch | null> {
  if (!posts.length) return null;
  try {
    const digest = posts.map((p, i) => `${i}. ${p.text.replace(/\n+/g, " ")}`).join("\n");
    const todayStr = new Date().toISOString().slice(0, 10);
    const { text: raw } = await generateText({
      model: anthropic(EXTRACT_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "tieredRecommendation.extractRealOpportunity" },
      prompt: `Someone wants: "${ask.text}"

Today's date: ${todayStr}

Here are real recent posts from X, one per line:
${digest}

Pick the ONE post (if any) that names a real, concrete opportunity (a specific accelerator, fellowship, program, residency, grant, or a named community, club, or recurring group someone can actually join — not vague hype, not an unrelated post) genuinely relevant to what they want. Name the opportunity using only what's actually in that post — never add details that aren't there.

Skip anything that reads as hype, clickbait, or an engagement-bait "BREAKING" post without real concrete substance behind it (a specific program name, a real application process) — prefer a plainly-stated, verifiable opportunity over a dramatic-sounding one. A repost/retweet of someone else's claim is not independently more credible just because it's been shared multiple times.

Some posts list SEVERAL distinct opportunities in one message (e.g. "1. Slush 100 — Deadline: Sept 7 ... 2. Techstars Anywhere ..."). If you pick a post like that, attribute every detail — especially the deadline — ONLY to the specific opportunity you're naming, never a detail stated for a different program listed in the same post. If the one you're actually naming has no deadline of its own stated, leave deadline out entirely even if another program mentioned right next to it has one.

If a post's own text gives a deadline or application window that has clearly already closed relative to today's date, don't pick it — there's nothing left to act on. Rolling admissions, no stated deadline, or a deadline still ahead are all fine to pick. If the post states an explicit application deadline date for the SPECIFIC opportunity you're naming, include it as "deadline" in YYYY-MM-DD form — only if that opportunity itself actually states one, never estimate, infer, or borrow one from a different program in the same post.

Write "reason" the way Co would say it to a friend over text — one short, casual sentence. Keep exactly one concrete, grounded detail that proves it's real (not vague hype), but never in analyst language ("demonstrates," "concrete evidence of," "showcasing") — say it plainly, the way a person would, not a scoring rationale. E.g. "Real accelerator, and there's a founder spotlight from someone who actually went through it — not just marketing copy," not "A named, specific accelerator program with a concrete founder spotlight demonstrating active participation and real companies."

Return ONLY valid JSON: {"index": 0, "name": "the specific opportunity name", "reason": "one short grounded sentence", "deadline": "YYYY-MM-DD" or null} or {"index": null}`,
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
async function tryTier3(ask: StatedIntent, query: string): Promise<TierMatch | null> {
  const posts = await searchRecentPosts(query).catch((err: any) => {
    console.error("tieredRecommendation: tryTier3 searchRecentPosts failed (non-fatal):", err?.message ?? err);
    return [];
  });
  return extractRealOpportunity(ask, posts);
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
export type SearchScope = { city: string | null; window: string | null; browse: boolean; tiers: number[] };
let lastSearchScope: SearchScope | null = null;

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
  opts: { userId?: string; checkRepeat?: boolean; source?: "sweep" | "request"; timezone?: string | null; rawMessage?: string } = {},
): Promise<TierMatch[]> {
  const city = await resolveSearchCity(ask.text, profileCity);
  // A time frame they named ("this weekend", "next Tuesday") scopes the
  // search to those days, whatever the default lookahead is.
  const asked = opts.rawMessage ?? ask.text ?? "";
  const window = asked ? parseAskWindow(asked, DateTime.now().setZone(opts.timezone ?? "local")) : null;
  const browse = !!asked && isBrowseAsk(asked);
  const windowFilter = window ? (startAt: string) => withinWindow(startAt, window) : undefined;
  const maxDays = window ? Math.max(1, Math.ceil(window.end.diffNow("days").days) + 1) : undefined;
  const cacheKey = `${(city ?? "").toLowerCase()}|${(ask.text ?? "").trim().toLowerCase()}|${window?.label ?? ""}`;
  const cached = searchCache.get(cacheKey);
  let found: TierMatch[];
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    found = cached.found;
  } else {
    const source = opts.source ?? "request";
    const [tier1, tier2, budget] = await Promise.all([
      tryTier1(ask, city, windowFilter, { browse, maxDays }),
      tryTier2(ask, city, windowFilter, { browse, maxDays }),
      paidSearchAllowed(opts.userId ?? null, source),
    ]);
    let tier3: TierMatch | null = null;
    // Asking what's on the calendar is a question about events, not about
    // posts on X (2026-09-16: "what's been surfacing on Luma this weekend"
    // came back with an X post, and Co never said where it came from).
    if (budget.ok && !browse) {
      const opportunityQuery = await proposeOpportunityQuery(ask, city);
      if (opportunityQuery) {
        await pool
          .query(`INSERT INTO x_search_log (user_id, source, query) VALUES ($1, $2, $3)`, [opts.userId ?? null, source, opportunityQuery])
          .catch(() => {});
        tier3 = await tryTier3(ask, opportunityQuery);
      }
    }
    found = [tier1, tier2, tier3].filter((m): m is TierMatch => m !== null);
    if (searchCache.size > 300) searchCache.clear();
    searchCache.set(cacheKey, { at: Date.now(), found });
  }

  lastSearchScope = { city, window: window?.label ?? null, browse, tiers: found.map((m) => m.tier) };
  return gateMatches(found, { userId: opts.userId ?? null, searchCity: city, checkRepeat: opts.checkRepeat });
}

// The daily urgent-only Tier 1/2 pre-check (checkForUrgentMatch) was removed
// 2026-09-14 (Royce: "it should be actively searching for all 3 tiers"): the
// sweep now runs the full engine every day and paces sends separately.
