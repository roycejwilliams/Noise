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

export const TIER_LOOKAHEAD_DAYS: Record<1 | 2, number> = { 1: 30, 2: 14 };

// ---------- helpers

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function sameCityName(a: string, b: string): boolean {
  const first = (s: string) => norm(s.split(",")[0]);
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
};

export function checkLocation(match: TierMatch, facts: MatchFacts): GateCheck {
  const name = "location";
  if (match.tier === 3) return { name, pass: true, reason: "opportunity, not a place" };
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
  const today = todayUtc(facts.now);
  if (match.tier === 3) {
    if (!match.deadline) return { name, pass: true, reason: "no stated deadline" };
    return daysBetween(today, match.deadline) >= 0
      ? { name, pass: true, reason: `deadline ${match.deadline}` }
      : { name, pass: false, reason: `deadline ${match.deadline} already passed` };
  }
  if (!match.event_date) return { name, pass: false, reason: "event has no date" };
  const days = daysBetween(today, match.event_date);
  if (days < 0) return { name, pass: false, reason: `event on ${match.event_date} already happened` };
  const max = TIER_LOOKAHEAD_DAYS[match.tier];
  if (days > max) return { name, pass: false, reason: `event is ${days} days out, past the ${max}-day window` };
  return { name, pass: true, reason: `in ${days} day(s)` };
}

// Place words in a reason ("in Fargo", "near Oakland", "close to X") must
// name the match's own city. Tier 1/2 reasons are built in code; Tier 3
// reasons are written by a model from a post, so their numbers, dates, and
// name have to appear in that post.
const PLACE_PHRASE = /\b(?:in|near|close to|around|nearby)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/g;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function placesClaimed(text: string): string[] {
  return [...text.matchAll(PLACE_PHRASE)].map((m) => m[1]).filter((p) => !MONTHS.includes(p.toLowerCase().split(" ")[0]));
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

  // Tier 3
  if (!/^https:\/\/x\.com\/i\/status\/\d+$/.test(match.url ?? "")) {
    return { name, pass: false, reason: `not a real post link: ${match.url}` };
  }
  const evidence = facts.evidence ? norm(facts.evidence) : null;
  if (!evidence) return { name, pass: false, reason: "no source post text to check the opportunity against" };

  const nameWords = norm(match.name).split(" ").filter((w) => w.length > 2 && !["the", "and", "for", "program", "fellowship", "accelerator"].includes(w));
  if (nameWords.length && nameWords.filter((w) => evidence.includes(w)).length / nameWords.length < 0.5) {
    return { name, pass: false, reason: `"${match.name}" isn't named in the post` };
  }
  const numbersInReason = (match.reason.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, ""));
  const missingNumber = numbersInReason.find((n) => !evidence.includes(n.replace(/,/g, "")) && !facts.evidence!.includes(n));
  if (missingNumber) return { name, pass: false, reason: `reason mentions "${missingNumber}", which isn't in the post` };
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
    if (!stated) return { name, pass: false, reason: `deadline ${match.deadline} isn't stated for ${match.name} in the post` };
  }
  const wrongPlace = placesClaimed(match.reason).find((p) => !evidence.includes(norm(p)));
  if (wrongPlace) return { name, pass: false, reason: `reason says "${wrongPlace}", which isn't in the post` };
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

export async function wasAlreadyOffered(userId: string, match: TierMatch): Promise<boolean> {
  const eventId = "event_api_id" in match ? match.event_api_id : null;
  const { rows } = await pool.query(
    `SELECT 1 FROM co_memories
     WHERE user_id = $1
       AND memory_type IN ('recommendation_offered', 'event_offer_pending')
       AND (
         ($2::text IS NOT NULL AND (content::jsonb ->> 'event_api_id' = $2 OR content::jsonb -> 'match' ->> 'event_api_id' = $2))
         OR lower(coalesce(content::jsonb ->> 'name', content::jsonb -> 'match' ->> 'name')) = lower($3)
       )
     UNION ALL
     SELECT 1 FROM surfaced_events WHERE user_id = $1 AND $2::text IS NOT NULL AND event_api_id = $2
     UNION ALL
     SELECT 1 FROM tier3_offered_opportunities WHERE user_id = $1 AND lower(name) = lower($3)
     LIMIT 1`,
    [userId, eventId, match.name],
  ).catch(() => ({ rows: [] as unknown[] }));
  return rows.length > 0;
}

// Gate a list of matches for one person. userId null = no repeat check
// (the proactive sweep keeps its own dedup) and no decision log.
export async function gateMatches(
  matches: TierMatch[],
  ctx: { userId: string | null; searchCity: string | null; checkRepeat?: boolean; evidenceByUrl?: Map<string, string>; now?: Date },
): Promise<TierMatch[]> {
  const now = ctx.now ?? new Date();
  const kept: TierMatch[] = [];
  for (const match of matches) {
    const distance =
      ctx.searchCity && match.tier !== 3 && match.city ? await distanceBetween(ctx.searchCity, match.city) : null;
    const facts: MatchFacts = {
      searchCity: ctx.searchCity,
      distanceMiles: distance,
      evidence: match.tier === 3 ? (match.evidence ?? ctx.evidenceByUrl?.get(match.url) ?? null) : null,
      alreadyOffered: ctx.userId && ctx.checkRepeat !== false ? await wasAlreadyOffered(ctx.userId, match) : false,
      now,
    };
    const { ok, checks } = evaluateMatch(match, facts);
    if (ok) kept.push(match);
    if (ctx.userId) {
      await recordDecision({
        layer: 5,
        decision: "match.gate",
        userId: ctx.userId,
        outcome: ok ? "act" : "skip",
        action: ok ? `offer:tier${match.tier}` : null,
        proposal: { tier: match.tier, name: match.name, city: match.tier !== 3 ? match.city ?? null : null, url: match.url ?? null },
        checks,
      });
    }
  }
  return kept;
}

// ---------- Network candidates

// Words that point at something private about a person. A share reason may
// only use one of these if the candidate's own stated ask/offering does.
const SENSITIVE = [
  "burnout", "burned out", "burnt out", "quit", "quitting", "unemployed", "laid off", "fired", "lost a co-founder",
  "lost their co-founder", "lost co-founder", "cofounder conflict", "co-founder conflict", "equity", "divorce", "breakup",
  "anxiety", "anxious", "depress", "therapy", "therapist", "grief", "health", "illness", "debt", "visa", "pregnan",
  "lonely", "loneliness", "isolated", "isolation", "struggling", "stuck", "manager", "goalposts", "salary", "months unemployed",
  "doubt", "debating whether", "almost quit", "hit a wall",
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

export type NetworkFacts = {
  shareReason: string | null | undefined;
  // The candidate's own active stated asks/offerings: the only allowed source.
  candidateStatedAsks: string[];
  // Everything else known about the candidate: goals, blockers, activity
  // preferences, memory text. None of it may be quoted.
  candidatePrivateTexts: string[];
  alreadySuggestedOrDeclined: boolean;
  askerActive: boolean;
  candidateActive: boolean;
};

export function checkShareReason(f: NetworkFacts): GateCheck {
  const name = "share_reason_private";
  const reason = f.shareReason?.trim();
  if (!reason) return { name, pass: false, reason: "no shareable reason" };
  const allowed = norm(f.candidateStatedAsks.join(" "));
  const hit = SENSITIVE.find((w) => norm(reason).includes(norm(w)) && !allowed.includes(norm(w)));
  if (hit) return { name, pass: false, reason: `mentions "${hit}", which isn't in their stated ask` };

  const allowedShingles = shingles(contentWords(f.candidateStatedAsks.join(" . ")), 3);
  const reasonShingles = shingles(contentWords(reason), 3);
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
  const [profile, memories, suggested, active] = await Promise.all([
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
  ]);
  const p = profile.rows[0] ?? {};
  const stated = Array.isArray(p.intent)
    ? (p.intent as any[]).filter((i) => i?.status === "active" && i?.text).map((i) => String(i.text))
    : [];
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

