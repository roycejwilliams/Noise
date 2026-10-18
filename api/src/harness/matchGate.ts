// Layer 5 harness: the match gate (2026-09-14). Every real event,
// opportunity, or person Co is about to queue or show goes through these
// checks first. The model can rank and describe; code decides whether a
// match is real, nearby, still actionable, not a repeat, and safe to share.
//
// The check functions are pure (no DB, no network) so evals/matching can run
// them without a model or a database. gather* functions below fetch the
// facts they need.
import pool from "../db/db.js";
import { geocodeCity, haversineMiles, SAME_METRO_MAX_MILES } from "../services/geocoding.js";
import type { TierMatch } from "../services/tieredRecommendation.js";
import { gate, recordDecision, type GateCheck } from "./core.js";
import { isOpenAsk } from "./profileWrite.js";
import { localToday } from "../services/eventOrder.js";

export const TIER_LOOKAHEAD_DAYS: Record<1 | 2, number> = { 1: 30, 2: 14 };

// ---------- helpers

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Short names people and pages use for the same city (2026-09-18: a YC
// result was rejected because its reason said "SF" and the page said "San
// Francisco").
const CITY_ALIASES = [["san francisco", "sf"], ["new york", "new york city", "nyc"], ["los angeles", "la"], ["washington dc", "dc"]];

function placeForms(place: string): string[] {
  const n = norm(place);
  return CITY_ALIASES.find((group) => group.includes(n)) ?? [n];
}

// Whole words only, so "la" doesn't match inside "place".
function mentionsPlace(text: string, place: string): boolean {
  const padded = ` ${norm(text)} `;
  return placeForms(place).some((form) => padded.includes(` ${form} `));
}

// Amounts a page writes out in words, as digits ("nineteen thousand
// dollars" -> 19000), so a reason saying "$19k" can be checked against it
// (2026-09-18: a real SF event fund was rejected over exactly that).
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

export function spelledNumbers(text: string): number[] {
  const found: number[] = [];
  let total = 0;
  let current = 0;
  let inRun = false;
  const end = () => {
    if (inRun) found.push(total + current);
    total = current = 0;
    inRun = false;
  };
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  words.forEach((w, i) => {
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w === "hundred" && inRun) current *= 100;
    else if (w in SCALES && inRun) {
      total += current * SCALES[w];
      current = 0;
    } else if (w === "a" && (words[i + 1] === "hundred" || words[i + 1] in SCALES)) current += 1;
    else if (w === "and" && inRun) return;
    else return end();
    inRun = true;
  });
  end();
  return found;
}

function sameCityName(a: string, b: string): boolean {
  const first = (s: string) => norm(s.split(",")[0]);
  if (placeForms(first(a)).includes(first(b))) return true;
  return first(a) === first(b) || norm(a).includes(first(b)) || norm(b).includes(first(a));
}

// ---------- Tier matches

export type MatchFacts = {
  // Where they want it: the ask's own place if it named one, else profile city.
  searchCity: string | null;
  // Distance in miles between searchCity and the match's city, when both
  // geocoded. null = not computed / couldn't geocode.
  distanceMiles: number | null;
  // Tier 3 only: the X post text the opportunity was extracted from.
  evidence?: string | null;
  // Already offered to this person (conversation or proactive).
  alreadyOffered: boolean;
  now: Date;
  // The last day of a time frame they named ("Oct 5 - Oct 14th"), YYYY-MM-DD.
  // Replaces the fixed lookahead for this search: they asked about those days.
  askedUntil?: string | null;
  // How far out this search looked, when it looked further than the tier's
  // usual lookahead (a widened search pages 21 days of the feed). Without it,
  // events the widened search found 15-21 days out were all thrown out here
  // (2026-09-18).
  lookaheadDays?: number | null;
  // The person's time zone. "Today" is their calendar day, since event_date is
  // their local date too (code review, 2026-09-17: today was UTC, so after
  // about 5pm Pacific every same-evening event read as already happened).
  // UTC only when no zone is known.
  zone?: string | null;
  // How soon before its start an event can still be offered (START_LEAD_MINUTES), when this caller checks it. Whether it already
  // started is checked for every caller that knows the start.
  leadMinutes?: number | null;
};

// The start check (START_LEAD_MINUTES, startProblem, eventStartProblem, matchStartProblem) lives in services/eventStart.ts, pure, so
// every place Cue offers an event uses the one rule; re-exported here for the gate's callers.
export { START_LEAD_MINUTES, MULTI_DAY_HOURS, startProblem, eventStartProblem, matchStartProblem } from "../services/eventStart.js";
import { matchStartProblem } from "../services/eventStart.js";

export function checkLocation(match: TierMatch, facts: MatchFacts): GateCheck {
  const name = "location";
  if (match.tier === 3) return { name, pass: true, reason: "opportunity, not a place" };
  // An online event is reachable from anywhere (code review, 2026-09-17).
  if (match.online || match.details?.online) return { name, pass: true, reason: "online" };
  if (!facts.searchCity) return { name, pass: true, reason: "no place to be near" };
  if (!match.city) return { name, pass: false, reason: `event has no city on file, can't be claimed as near ${facts.searchCity}` };
  if (facts.distanceMiles !== null) {
    return facts.distanceMiles <= SAME_METRO_MAX_MILES
      ? { name, pass: true, reason: `${Math.round(facts.distanceMiles)}mi from ${facts.searchCity}` }
      : { name, pass: false, reason: `${match.city} is ${Math.round(facts.distanceMiles)}mi from ${facts.searchCity}` };
  }
  return sameCityName(match.city, facts.searchCity)
    ? { name, pass: true, reason: "same city name (not geocoded)" }
    : { name, pass: false, reason: `couldn't confirm ${match.city} is near ${facts.searchCity}` };
}

export function checkTiming(match: TierMatch, facts: MatchFacts): GateCheck {
  const name = "timing";
  const today = localToday(facts.now, facts.zone);
  if (match.tier === 3) {
    // The post's own dates count too: a demo day last week was offered as
    // live because only the deadline was checked (code review, 2026-09-17).
    const isDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const statedLast = isDate(match.statedDates?.end) ? match.statedDates!.end : isDate(match.statedDates?.start) ? match.statedDates!.start : null;
    if (statedLast && daysBetween(today, statedLast) < 0) {
      return { name, pass: false, reason: `it happened on ${statedLast}, already past` };
    }
    if (!match.deadline) return { name, pass: true, reason: statedLast ? `happens through ${statedLast}` : "no stated deadline" };
    return daysBetween(today, match.deadline) >= 0
      ? { name, pass: true, reason: `deadline ${match.deadline}` }
      : { name, pass: false, reason: `deadline ${match.deadline} already passed` };
  }
  if (!match.event_date) return { name, pass: false, reason: "event has no date" };
  const days = daysBetween(today, match.event_date);
  if (days < 0) return { name, pass: false, reason: `event on ${match.event_date} already happened` };
  // On top of the day check: the start itself, when it's known.
  const late = matchStartProblem(match, facts.now, facts.leadMinutes ?? null, facts.zone ?? null);
  if (late) return { name, pass: false, reason: late };
  // A time frame they named sets how far out is fine (2026-09-16: an Oct 6
  // event inside the "Oct 5 - Oct 14th" they asked about was rejected as past
  // the 14-day lookahead, and Co told them it was outside their range).
  const max = facts.askedUntil ? Math.max(daysBetween(today, facts.askedUntil), 0) : Math.max(TIER_LOOKAHEAD_DAYS[match.tier], facts.lookaheadDays ?? 0);
  if (days > max) {
    return { name, pass: false, reason: facts.askedUntil ? `event on ${match.event_date} is after the time frame they asked about` : `event is ${days} days out, past the ${max}-day window` };
  }
  return { name, pass: true, reason: `in ${days} day(s)` };
}

// Place words in a reason ("in Fargo", "near Oakland", "close to X") must
// name the match's own city. Tier 1/2 reasons are built in code; Tier 3
// reasons are written by a model from a post, so their numbers, dates, and
// name have to appear in that post.
const PLACE_PHRASE = /\b(?:in|near|close to|around|nearby)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/g;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const isMonthWord = (w: string) => {
  const head = w.toLowerCase().split(/[-.]/)[0];
  return MONTHS.includes(head) || MONTHS.some((m) => m.slice(0, 3) === head) || head === "sept";
};

// A place phrase ends at a month: "in SF Jan-March" claims SF.
export function placesClaimed(text: string): string[] {
  return [...text.matchAll(PLACE_PHRASE)]
    .map((m) => {
      const words = m[1].split(" ");
      const cut = words.findIndex(isMonthWord);
      return (cut === -1 ? words : words.slice(0, cut)).join(" ");
    })
    .filter(Boolean);
}

export function checkGrounding(match: TierMatch, facts: MatchFacts): GateCheck {
  const name = "grounding";
  if (!match.name?.trim()) return { name, pass: false, reason: "no name" };

  if (match.tier === 2 && !/^https:\/\/(lu\.ma|luma\.com)\/[\w-]+$/.test(match.url ?? "")) {
    return { name, pass: false, reason: `not a real Luma link: ${match.url}` };
  }
  if (match.tier === 1 && match.url && !/^https:\/\//.test(match.url)) {
    return { name, pass: false, reason: `bad link: ${match.url}` };
  }

  if (match.tier !== 3) {
    const wrongPlace = placesClaimed(match.reason).find((p) => !match.city || !sameCityName(p, match.city));
    if (wrongPlace) return { name, pass: false, reason: `reason says "${wrongPlace}" but the event is in ${match.city ?? "an unknown city"}` };
    if (/\bclose to\b|\bnearby\b|\bnear you\b/i.test(match.reason)) {
      return { name, pass: false, reason: "reason claims closeness the data doesn't state" };
    }
    return { name, pass: true };
  }

  // Tier 3. A web result is checked against the text of its own page the
  // same way an X result is checked against its post (2026-09-18: every web
  // result was failing the X-only link check, so none could ever send).
  const web = match.source === "web";
  const where = web ? "page" : "post";
  if (web ? !/^https:\/\/[^\s/]+\.[^\s/]+/.test(match.url ?? "") : !/^https:\/\/x\.com\/i\/status\/\d+$/.test(match.url ?? "")) {
    return { name, pass: false, reason: `not a real ${where} link: ${match.url}` };
  }
  const spelled = facts.evidence ? spelledNumbers(facts.evidence) : [];
  const evidence = facts.evidence ? norm(`${facts.evidence} ${spelled.join(" ")}`) : null;
  if (!evidence) return { name, pass: false, reason: `no source ${where} text to check the opportunity against` };

  const nameWords = norm(match.name).split(" ").filter((w) => w.length > 2 && !["the", "and", "for", "program", "fellowship", "accelerator"].includes(w));
  if (nameWords.length && nameWords.filter((w) => evidence.includes(w)).length / nameWords.length < 0.5) {
    return { name, pass: false, reason: `"${match.name}" isn't named in the ${where}` };
  }
  const numbersInReason = (match.reason.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, ""));
  const missingNumber = numbersInReason.find((n) => !evidence.includes(n.replace(/,/g, "")) && !facts.evidence!.includes(n));
  if (missingNumber) return { name, pass: false, reason: `reason mentions "${missingNumber}", which isn't in the ${where}` };
  if (match.deadline) {
    const [, mm, dd] = match.deadline.split("-").map(Number);
    const month = MONTHS[mm - 1];
    // Posts often list several programs; the deadline has to be stated in the
    // part of the post about this one, not borrowed from its neighbor.
    const segments = facts.evidence!.split(/\n+|(?:^|[.!?]\s+)\d{1,2}[.)]\s+(?=[A-Z])|•|;/).map(norm).filter(Boolean);
    const own = segments.filter((seg) => nameWords.some((w) => seg.includes(w)));
    const stated = (own.length ? own : [evidence]).some((seg) => {
      const hasMonth = seg.includes(month) || new RegExp(`\\b${month.slice(0, 3)}`).test(seg);
      const hasDay = new RegExp(`\\b0?${dd}(st|nd|rd|th)?\\b`).test(seg);
      return (hasMonth && hasDay) || new RegExp(`\\b0?${mm} 0?${dd}\\b`).test(seg);
    });
    if (!stated) return { name, pass: false, reason: `deadline ${match.deadline} isn't stated for ${match.name} in the ${where}` };
  }
  const wrongPlace = placesClaimed(match.reason).find((p) => !mentionsPlace(facts.evidence!, p));
  if (wrongPlace) return { name, pass: false, reason: `reason says "${wrongPlace}", which isn't in the ${where}` };
  return { name, pass: true };
}

export function checkNoRepeat(facts: MatchFacts): GateCheck {
  return facts.alreadyOffered
    ? { name: "no_repeat", pass: false, reason: "already offered to this person" }
    : { name: "no_repeat", pass: true };
}

// A sold-out event isn't something to pitch (2026-09-15: Co pitched a sold-out,
// approval-only meetup as a fit).
export function checkAvailable(match: TierMatch): GateCheck {
  return match.details?.soldOut
    ? { name: "available", pass: false, reason: "sold out" }
    : { name: "available", pass: true, reason: match.details?.requiresApproval ? "needs host approval" : undefined };
}

export function evaluateMatch(match: TierMatch, facts: MatchFacts): { ok: boolean; checks: GateCheck[] } {
  const checks = [checkLocation(match, facts), checkTiming(match, facts), checkGrounding(match, facts), checkNoRepeat(facts), checkAvailable(match)];
  return { ok: gate(checks).ok, checks };
}

// ---------- gather (DB / geocoding)

export async function distanceBetween(cityA: string, cityB: string): Promise<number | null> {
  const [a, b] = await Promise.all([geocodeCity(cityA).catch(() => null), geocodeCity(cityB).catch(() => null)]);
  return a && b ? haversineMiles(a, b) : null;
}

// ---------- Repeats (2026-09-18)
//
// Whether something already shown comes back depends on what happened, not
// just that it was shown (it used to be never, forever):
//   - declined, or they went/applied ("helped"/"didn't help"): never again.
//   - showed interest: not re-pitched; an opening with a stated deadline gets
//     one reminder in the last OPPORTUNITY_REMINDER_DAYS before it.
//   - their reaction is read from their reply (services/offerReactions.ts)
//     and saved as the outcome above. For something shown before reactions
//     were recorded, any text to Co within a day of it counts as answered,
//     so an unrecorded "not for me" never comes back.
//   - never answered: can come back once, RESURFACE_AFTER_DAYS later, while
//     it's still open (the sweep's fit check runs on it again).
//   - an event within a day keeps its one day-before reminder unless declined.
// Different cycles of a program (YC W27 vs S27) are different names, so
// they're different things here too.
export const RESURFACE_AFTER_DAYS = 30;
export const OPPORTUNITY_REMINDER_DAYS = 5;
const SAME_SHOWING_DAYS = 3;
const ANSWERED_WITHIN_HOURS = 24;

export type OfferOutcome = "declined" | "interested" | "acted" | null;
export type OfferHistory = { shownAt: Date[]; outcome: OfferOutcome; answered: boolean };
export type RepeatAction = "new" | "remind" | "resurface" | "blocked";

// One showing can leave several records (the offer, the dedup row, a texted
// search) on the same day; count those as one.
export function countShowings(shownAt: Date[]): Date[] {
  const sorted = [...shownAt].sort((a, b) => a.getTime() - b.getTime());
  const out: Date[] = [];
  for (const d of sorted) {
    if (!out.length || d.getTime() - out[out.length - 1].getTime() > SAME_SHOWING_DAYS * 86_400_000) out.push(d);
  }
  return out;
}

export function repeatRule(
  h: OfferHistory,
  m: { isEvent: boolean; date: string | null; shortNotice: boolean },
  today: string,
  now: Date,
): { action: RepeatAction; reason: string } {
  const showings = countShowings(h.shownAt);
  if (!showings.length && !h.outcome) return { action: "new", reason: "never shown" };
  if (h.outcome === "declined") return { action: "blocked", reason: "they passed on it" };
  if (h.outcome === "acted") return { action: "blocked", reason: "they already went or applied" };
  const daysLeft = m.date ? daysBetween(today, m.date) : null;
  if (daysLeft !== null && daysLeft < 0) return { action: "blocked", reason: "no longer open" };
  if (m.isEvent && m.shortNotice) return { action: "remind", reason: "shown before and it's within a day" };
  if (h.outcome === "interested") {
    return !m.isEvent && daysLeft !== null && daysLeft >= 1 && daysLeft <= OPPORTUNITY_REMINDER_DAYS
      ? { action: "remind", reason: `they were interested and the deadline is ${daysLeft} day(s) out` }
      : { action: "blocked", reason: "they were interested; only a reminder before the deadline" };
  }
  if (h.answered) return { action: "blocked", reason: "they replied after seeing it" };
  if (showings.length >= 2) return { action: "blocked", reason: "already came back once" };
  const since = Math.floor((now.getTime() - showings[0].getTime()) / 86_400_000);
  if (since < RESURFACE_AFTER_DAYS) return { action: "blocked", reason: `shown ${since} day(s) ago, can come back after ${RESURFACE_AFTER_DAYS}` };
  return { action: "resurface", reason: `shown ${since} days ago, never answered, still open` };
}

// When they were shown it, what they said about it, and whether they texted
// Co right after. extraShownAt: showings found another way (the sweep's
// fuzzy name match on openings).
export async function offerHistory(userId: string, match: TierMatch, extraShownAt: Date[] = []): Promise<OfferHistory> {
  const eventId = "event_api_id" in match ? match.event_api_id : null;
  const shown = await pool
    .query(
      `SELECT created_at AS at FROM co_memories
       WHERE user_id = $1
         AND memory_type IN ('recommendation_offered', 'event_offer_pending')
         AND (
           ($2::text IS NOT NULL AND (content::jsonb ->> 'event_api_id' = $2 OR content::jsonb -> 'match' ->> 'event_api_id' = $2))
           OR lower(coalesce(content::jsonb ->> 'name', content::jsonb -> 'match' ->> 'name')) = lower($3)
         )
       UNION ALL
       SELECT surfaced_at FROM surfaced_events WHERE user_id = $1 AND $2::text IS NOT NULL AND event_api_id = $2
       UNION ALL
       SELECT created_at FROM tier3_offered_opportunities WHERE user_id = $1 AND lower(name) = lower($3)`,
      [userId, eventId, match.name],
    )
    .then((r) => r.rows.map((row: { at: Date }) => new Date(row.at)))
    .catch(() => [] as Date[]);
  const shownAt = [...shown, ...extraShownAt];
  const outcomeRow = await pool
    .query(
      `SELECT result FROM suggestion_outcomes
       WHERE user_id = $1 AND result IN ('declined', 'interested', 'acted', 'helped', 'didnt_help')
         AND (item_key = $2 OR item_key = $3 OR lower(item_name) = lower($4))
       ORDER BY (result = 'declined') DESC, created_at DESC LIMIT 1`,
      [userId, eventId ? `event:${eventId}` : "", `name:${match.name.toLowerCase()}`, match.name],
    )
    .then((r) => r.rows[0]?.result as string | undefined)
    .catch(() => undefined);
  const outcome: OfferOutcome = outcomeRow === "declined" ? "declined" : outcomeRow === "interested" ? "interested" : outcomeRow ? "acted" : null;
  // Shown since reactions were recorded: the outcome above is the answer.
  const tracked = await pool
    .query(`SELECT 1 FROM revealed_offers WHERE user_id = $1 AND (item_key = $2 OR item_key = $3) LIMIT 1`, [userId, eventId ? `event:${eventId}` : "", `name:${match.name.toLowerCase()}`])
    .then((r) => r.rows.length > 0)
    .catch(() => false);
  let answered = false;
  if (shownAt.length && !tracked) {
    answered = await pool
      .query(
        `SELECT 1 FROM co_memories m, unnest($2::timestamptz[]) AS shown(at)
         WHERE m.user_id = $1 AND m.memory_type = 'text_exchange' AND m.content LIKE 'User %'
           AND m.created_at > shown.at AND m.created_at <= shown.at + ($3 || ' hours')::interval
         LIMIT 1`,
        [userId, shownAt.map((d) => d.toISOString()), ANSWERED_WITHIN_HOURS],
      )
      .then((r) => r.rows.length > 0)
      .catch(() => false);
  }
  return { shownAt, outcome, answered };
}

export function repeatInput(match: TierMatch, shortNotice: boolean): { isEvent: boolean; date: string | null; shortNotice: boolean } {
  return {
    isEvent: "event_api_id" in match,
    date: "event_date" in match && match.event_date ? match.event_date : match.tier === 3 ? (match.deadline ?? null) : null,
    shortNotice,
  };
}

// For a texted search: anything but a fresh or resurfacing item counts as
// already offered (a reminder isn't something to pitch as new).
export async function wasAlreadyOffered(userId: string, match: TierMatch, now = new Date(), zone: string | null = null): Promise<boolean> {
  const h = await offerHistory(userId, match);
  const input = repeatInput(match, false);
  const r = repeatRule(h, input, localToday(now, zone), now);
  return r.action === "blocked" || r.action === "remind";
}

// Gate a list of matches for one person. userId null = no repeat check
// (the proactive sweep keeps its own dedup) and no decision log.
// Real matches the gate turned away, and the plain reason, so the reply can
// say "the ones I found are sold out" instead of inventing a generic idea
// (2026-09-16).
export type GatedOut = { name: string; tier: number; reasons: string[]; url: string | null; date: string | null };

export async function gateMatches(
  matches: TierMatch[],
  ctx: { userId: string | null; searchCity: string | null; checkRepeat?: boolean; evidenceByUrl?: Map<string, string>; now?: Date; gatedOut?: GatedOut[]; askedUntil?: string | null; lookaheadDays?: number | null; zone?: string | null; leadMinutes?: number | null },
): Promise<TierMatch[]> {
  const now = ctx.now ?? new Date();
  const kept: TierMatch[] = [];
  // Facts for every match gathered at once, not one match after another
  // (2026-09-22: a search spent ~11s outside the tiers themselves, several
  // database round trips per match in a row). The search city is geocoded
  // once first so the parallel lookups all hit the cache instead of each
  // calling the geocoding API. Evaluation and the kept/gatedOut order below
  // are unchanged.
  if (ctx.searchCity) await geocodeCity(ctx.searchCity).catch(() => null);
  const allFacts = await Promise.all(
    matches.map(async (match): Promise<MatchFacts> => {
      const [distance, alreadyOffered] = await Promise.all([
        ctx.searchCity && match.tier !== 3 && match.city && !match.online ? distanceBetween(ctx.searchCity, match.city) : Promise.resolve(null),
        ctx.userId && ctx.checkRepeat !== false ? wasAlreadyOffered(ctx.userId, match) : Promise.resolve(false),
      ]);
      return {
        searchCity: ctx.searchCity,
        distanceMiles: distance,
        evidence: match.tier === 3 ? (match.evidence ?? ctx.evidenceByUrl?.get(match.url) ?? null) : null,
        alreadyOffered,
        now,
        askedUntil: ctx.askedUntil ?? null,
        lookaheadDays: ctx.lookaheadDays ?? null,
        zone: ctx.zone ?? null,
        leadMinutes: ctx.leadMinutes ?? null,
      };
    }),
  );
  const logs: Promise<unknown>[] = [];
  for (const [i, match] of matches.entries()) {
    const facts = allFacts[i];
    const { ok, checks } = evaluateMatch(match, facts);
    if (ok) kept.push(match);
    else
      ctx.gatedOut?.push({
        name: match.name,
        tier: match.tier,
        reasons: checks.filter((c) => !c.pass).map((c) => c.reason ?? c.name),
        url: match.url ?? null,
        date: match.tier === 3 ? (match.deadline ?? null) : (match.event_date ?? null),
      });
    if (ctx.userId) {
      logs.push(
        recordDecision({
          layer: 5,
          decision: "match.gate",
          userId: ctx.userId,
          outcome: ok ? "act" : "skip",
          action: ok ? `offer:tier${match.tier}` : null,
          proposal: { tier: match.tier, name: match.name, city: match.tier !== 3 ? match.city ?? null : null, url: match.url ?? null },
          checks,
        }),
      );
    }
  }
  await Promise.all(logs);
  return kept;
}

// ---------- Network candidates

// Words that point at something private about a person. A share reason may
// only use one of these if the candidate's own stated ask/offering does.
// A backstop, not the control: the control is the member marking an ask shareable (services/matching.ts). This catches
// a private topic in an ask that was marked anyway. Whole words only, so "manager", "equity", "quite" and "health-tech"
// pass; a match on any of these means the ask is not shared. When in doubt, don't share.
export const SENSITIVE: RegExp[] = [
  /\b(?:burn(?:ed|t)? ?out|burnout|quit|quitting|unemployed|laid off|fired|lost (?:a |their |my )?co ?founder|co ?founder conflict|almost quit|hit a wall|goalposts)\b/,
  /\b(?:anxiety|anxious|depress\w*|therap\w*|psychiatr\w*|psycholog\w*|counsel(?:or|ors|ing|ling)|mental health|adhd|ocd|bipolar|ptsd|grief|griev\w*|lonely|loneliness|isolated|isolation|struggling|stuck|doubt|debating whether)\b/,
  /\b(?:illness|sick|cancer|chemo\w*|diagnos\w*|disease|chronic|surgery|disabilit\w*|health (?:issue|issues|problem|problems|scare)|pregnan\w*|fertility|ivf|miscarr\w*)\b/,
  /\b(?:sober|sobriety|rehab|addict\w*|alcoholi\w*|recovering)\b/,
  /\b(?:debt|debts|bankrupt\w*|broke|running out of money|money (?:trouble|problems)|evict\w*|homeless|salary|months unemployed)\b/,
  /\b(?:divorc\w*|breakup|broke up|separation|custody|couples?)\b/,
  /\b(?:immigration|h ?1 ?b|green card|visa (?:status|sponsorship|issue|issues)|deport\w*|asylum|lawsuit|sued|arrest\w*|criminal)\b/,
  /\b(?:new job|job search|interviewing|quietly|secretly|while still employed|without my (?:boss|employer) knowing)\b/,
];


const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "who", "that", "is", "are", "their", "they", "them", "at", "as", "by", "be", "it", "this"]);

function contentWords(s: string): string[] {
  return norm(s).split(" ").filter((w) => w && !STOP.has(w));
}

function shingles(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

// ---------- the hidden part (Royce, 2026-10-18): see harness/hiddenEcho.ts. A share reason needs no echo check of its own: it is
// one of the asks the member marked shareable, word for word (checkShareReason), so it can carry nothing of a private ask or a
// blocker beyond what they chose to share, and a sensitive topic is refused even then. The texts drafted from it are checked
// (introConsent.ts hiddenEchoCheck, roomMatching.ts checkValueLines, networkIntroNudge.ts introEmailHiddenCheck).

// A member's hidden part as the checks read it: their private asks and blockers, and what they marked shareable. Throws on a
// failed read, so a caller fails closed.
export async function hiddenSideOf(userId: string): Promise<{ hidden: string[]; shared: string[] }> {
  const { rows } = await pool.query(`SELECT goals, blockers, activity_preferences, long_term_direction, intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const p = rows[0] ?? {};
  const open = Array.isArray(p.intent) ? (p.intent as any[]).filter((i) => isOpenAsk(i)) : [];
  return {
    hidden: [...open.filter((i) => i?.shareable !== true).map((i) => String(i.text)), ...(Array.isArray(p.blockers) ? p.blockers.map(String) : [])],
    shared: open.filter((i) => i?.shareable === true).map((i) => String(i.text)),
  };
}

export type NetworkFacts = {
  shareReason: string | null | undefined;
  // The candidate's open asks they marked shareable: the only allowed source, and the reason must be one of them.
  candidateStatedAsks: string[];
  // Everything else known about the candidate: goals, blockers, activity
  // preferences, memory text. None of it may be quoted.
  candidatePrivateTexts: string[];
  alreadySuggestedOrDeclined: boolean;
  askerActive: boolean;
  candidateActive: boolean;
};

// The words matching.ts puts in front of a quoted ask.
export const TEMPLATE_PREFIX = /^what they(?:'|\u2019)ve said they(?:(?:'|\u2019)re looking for| can offer):\s*/i;

export function checkShareReason(f: NetworkFacts): GateCheck {
  const name = "share_reason_private";
  const reason = f.shareReason?.trim();
  if (!reason) return { name, pass: false, reason: "no shareable reason" };
  // Sensitive even when it's in their own stated ask (burnout, health, money
  // trouble): they told Co, not everyone they might be introduced to
  // (2026-09-15, a pending intro quoted a tester's burnout).
  // The control: the quoted words must be one of the asks they marked shareable, word for word.
  const quoted = reason.replace(TEMPLATE_PREFIX, "").replace(/^"|"$/g, "").trim();
  if (!f.candidateStatedAsks.some((a) => norm(a) === norm(quoted))) return { name, pass: false, reason: "not an ask they marked shareable" };
  // The backstop: a private topic in an ask they marked anyway.
  const n = norm(reason);
  const sensitive = SENSITIVE.map((re) => n.match(re)?.[0]).find(Boolean);
  if (sensitive) return { name, pass: false, reason: `mentions "${sensitive}", which is too personal to share in an intro` };

  const allowedShingles = shingles(contentWords(f.candidateStatedAsks.join(" . ")), 3);
  // Our own wording ("what they've said they're looking for: ...", matching.ts)
  // isn't their private text: any memory of the candidate that holds Co's own
  // phrasing used to trip this at reveal time though the tease had passed it
  // (2026-10-03: "Sure" to a tease got "Sorry for the false start." because of
  // the shingle "what ve said"). Only the quoted ask is checked.
  const reasonShingles = shingles(contentWords(reason.replace(TEMPLATE_PREFIX, "")), 3);
  for (const text of f.candidatePrivateTexts) {
    for (const s of shingles(contentWords(text), 3)) {
      if (reasonShingles.has(s) && !allowedShingles.has(s)) {
        return { name, pass: false, reason: `quotes private profile text ("${s}")` };
      }
    }
  }
  return { name, pass: true };
}

export function evaluateNetworkCandidate(f: NetworkFacts): { ok: boolean; checks: GateCheck[] } {
  const checks: GateCheck[] = [
    checkShareReason(f),
    f.alreadySuggestedOrDeclined
      ? { name: "not_already_suggested", pass: false, reason: "pair already suggested, introduced, or declined" }
      : { name: "not_already_suggested", pass: true },
    f.askerActive ? { name: "asker_active", pass: true } : { name: "asker_active", pass: false, reason: "asker opted out or inactive" },
    f.candidateActive
      ? { name: "candidate_active", pass: true }
      : { name: "candidate_active", pass: false, reason: "candidate opted out or inactive" },
  ];
  return { ok: gate(checks).ok, checks };
}

const ACTIVE_WITHIN_DAYS = 90;

export async function gatherNetworkFacts(
  askerId: string,
  candidateId: string,
  shareReason: string | null | undefined,
): Promise<NetworkFacts> {
  const [a, b] = askerId < candidateId ? [askerId, candidateId] : [candidateId, askerId];
  const [profile, memories, suggested, active, graphFacts] = await Promise.all([
    pool.query(`SELECT goals, blockers, activity_preferences, long_term_direction, intent FROM co_profiles WHERE user_id = $1`, [candidateId]),
    pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type <> 'intent' ORDER BY created_at DESC LIMIT 300`,
      [candidateId],
    ),
    pool.query(`SELECT 1 FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2`, [a, b]),
    pool.query(
      `SELECT u.id FROM users u
       WHERE u.id = ANY($1::uuid[]) AND coalesce(u.sms_opted_out, false) = false AND u.phone_number IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM co_memories m WHERE m.user_id = u.id AND m.memory_type = 'text_exchange'
             AND m.content LIKE 'User %' AND m.created_at > NOW() - ($2 || ' days')::interval
         )`,
      [[askerId, candidateId], ACTIVE_WITHIN_DAYS],
    ),
    // Their owner-only facts (services/coFacts.ts): inferred wants and
    // offers are private too.
    import("../services/coFacts.js").then((m) => m.ownerOnlyFacts(candidateId)).catch(() => [] as string[]),
  ]);
  const p = profile.rows[0] ?? {};
  const stated = Array.isArray(p.intent) ? (p.intent as any[]).filter((i) => isOpenAsk(i) && i?.shareable === true).map((i) => String(i.text)) : [];
  const activeIds = new Set(active.rows.map((r: any) => r.id));
  return {
    shareReason,
    candidateStatedAsks: stated,
    candidatePrivateTexts: [
      ...(p.goals ?? []),
      ...(p.blockers ?? []),
      ...(p.activity_preferences ?? []),
      ...(p.long_term_direction ? [p.long_term_direction] : []),
      ...memories.rows.map((r: any) => String(r.content)),
      ...graphFacts,
    ],
    alreadySuggestedOrDeclined: suggested.rows.length > 0,
    askerActive: activeIds.has(askerId),
    candidateActive: activeIds.has(candidateId),
  };
}

// Privacy check alone, for places that already handle pairing and activity
// (the in-room match nudge): is this reason safe to show the other person?
export async function gateShareReason(recipientId: string, candidateId: string, shareReason: string | null | undefined, action: string): Promise<boolean> {
  const facts = await gatherNetworkFacts(recipientId, candidateId, shareReason);
  const check = checkShareReason(facts);
  await recordDecision({
    layer: 5,
    decision: "match.gate",
    userId: recipientId,
    outcome: check.pass ? "act" : "skip",
    action,
    proposal: { candidateId, shareReason: shareReason ?? null },
    checks: [check],
  });
  return check.pass;
}

export async function gateNetworkCandidate(
  askerId: string,
  candidateId: string,
  shareReason: string | null | undefined,
  stage: "queue" | "reveal",
): Promise<boolean> {
  const facts = await gatherNetworkFacts(askerId, candidateId, shareReason);
  const { ok, checks } = evaluateNetworkCandidate(facts);
  await recordDecision({
    layer: 5,
    decision: "match.gate",
    userId: askerId,
    outcome: ok ? "act" : "skip",
    action: ok ? `network:${stage}` : null,
    proposal: { candidateId, shareReason: shareReason ?? null, stage },
    checks,
  });
  return ok;
}

