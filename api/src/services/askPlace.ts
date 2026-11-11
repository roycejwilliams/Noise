// Where a reply's search looks (Royce, 2026-10-18: "The situation decides what Cue looks for and which helpers run. What we know
// about a member shapes how, never which helper."). The sweep already looks where the want is (eventSurfacingSweep.ts searchPlace,
// #219); this is the same for the reply path's webSearch and searchEvents (agent/loopTools.ts). Pure: no model, no database.
//
// What counts as "the search's words name a place" (placesNamed), and nothing else: a capitalized phrase after in / near / around /
// close to / nearby (the grounding gate's detector, harness/matchGate.ts placesClaimed; "in Lisbon", "near Union Square") whose first
// word isn't a topic (NOT_A_PLACE: "in AI", "in Venture", "in Real Estate"), and the cities in wantPlace.ts ALIASES (short names like
// SF, NYC, LA only in capitals; full names like San Francisco, New York in any case). Also a place their message this turn names that
// way and the search's words repeat. Not seen: a place without one of those words ("visiting Lisbon", "Lisbon founder dinners" when
// their message doesn't name it), or in lowercase ("in lisbon"); those searches get the home city, as before.
//
// webSearch (each query):
//   1. the query names a place: nothing is added on top (the query carries it);
//   2. else the place the tool call carries (theirs.city);
//   3. else their home city (the profile city), unless the query says it's for no place (online, remote, virtual, anywhere).
// searchEvents:
//   1. the city the model passed (its argument is the place for this search), unless that city is their home city and the search's
//      words name another place (the fix: the model fell back to the home city while the ask named somewhere else);
//   2. else a place the words name;
//   3. else their home city (an event feed is by city).
// A search with no place of its own and no home city looks with none. The profile city never adds or removes a search or picks a tool.
import { placesClaimed } from "../harness/matchGate.js";
import { ALIASES, samePlace } from "./wantPlace.js";

export type AskPlaceFrom = "words" | "tool" | "home" | "none";
export type AskPlace = { place: string | null; from: AskPlaceFrom };

// Words a capitalized phrase after "in"/"near" can start with that make it a topic, not a place ("founders in AI", "talks in Spanish",
// "women in Venture", "talks in Real Estate").
const NOT_A_PLACE = new Set([
  "ai", "ml", "tech", "vc", "vcs", "yc", "venture", "ventures", "web3", "crypto", "blockchain", "fintech", "climate", "health", "healthcare", "biotech",
  "medtech", "edtech", "robotics", "hardware", "software", "saas", "data", "security", "product", "design", "marketing", "sales", "finance",
  "real", "law", "policy", "education", "media", "music", "art", "arts", "fashion", "film", "gaming", "sports", "science", "research",
  "engineering", "python", "javascript", "typescript", "rust", "java", "love", "life", "business", "startups", "consumer", "enterprise",
  "person", "english", "spanish", "french", "portuguese", "german", "mandarin", "q1", "q2", "q3", "q4",
]);
// Words a place phrase ends before ("in Lisbon Saturday" is Lisbon).
const TIME_WORDS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tonight", "tomorrow", "this", "next", "weekend", "morning", "afternoon", "evening", "night", "nights", "mornings"]);
// A search that is for no place.
export const NO_PLACE_WORDS = /\b(?:online|virtual|virtually|remote|remotely|zoom|anywhere|worldwide|nationwide|globally|global)\b/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const hasWords = (text: string, phrase: string) => !!norm(phrase) && ` ${norm(text)} `.includes(` ${norm(phrase)} `);

// Pure: the places a piece of text names, in its own spelling: a capitalized place after in/near/around (the grounding gate's own
// detector, harness/matchGate.ts placesClaimed), and the short names and full names of the cities Cue knows by alias (SF, NYC, LA;
// a short name only in capitals, so "la" or "chi" in a sentence is no place).
export function placesNamed(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];
  for (const raw of placesClaimed(t)) {
    const words = raw.replace(/[.,;:!?)"'’]+$/, "").split(/\s+/);
    const cut = words.findIndex((w) => TIME_WORDS.has(w.toLowerCase()));
    const kept = (cut === -1 ? words : words.slice(0, cut)).join(" ").trim();
    if (kept && !NOT_A_PLACE.has(kept.split(/\s+/)[0].toLowerCase())) out.push(kept);
  }
  for (const [short, full] of Object.entries(ALIASES)) {
    const shortHit = short.length <= 4 ? new RegExp(`(^|[^A-Za-z0-9])${short.toUpperCase()}(?=$|[^A-Za-z0-9])`).test(t) : hasWords(t, short);
    if (shortHit) out.push(short.length <= 4 ? short.toUpperCase() : short);
    else if (hasWords(t, full)) out.push(full);
  }
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(norm(p)) && !!seen.add(norm(p)));
}

// Pure: the one place a goal's search plan names (Royce, 2026-11-10: a goal with no place of its own is searched where its own plan
// names; "look for: small founder dinners SF" from a Sacramento member searched events in Sacramento while its web search said SF).
// Read with placesNamed, the same detector the reply searches use. Two different places, or none: null, never a pick between them
// (the goal looks where it did before). A place joined to another capitalized name by or/and/& or a slash ("Oakland or Berkeley",
// "SF/Oakland", where the detector reads only the first) is two places too (review of #450).
export function planNamesPlace(text: string | null | undefined): string | null {
  const t = String(text ?? "");
  const named = placesNamed(t);
  const distinct = named.filter((p, i) => !named.slice(0, i).some((q) => samePlace(p, q)));
  if (distinct.length !== 1) return null;
  // The place in any case (an alias can come back lowercase), the other name capitalized as written.
  const esc = distinct[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).replace(/\s+/g, "\\s+");
  const join = "\\s*,?\\s+(?:or|and|&)\\s+|\\s*\\/\\s*";
  const paired = new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?:${join})[A-Z]|[A-Z][A-Za-z]*(?:${join})${esc}(?=$|[^A-Za-z0-9])`);
  return paired.test(t) ? null : distinct[0];
}

// Pure: the place one search names: one its own words name, or one their message names that its words repeat.
export function searchNamesPlace(words: string, message?: string | null): string | null {
  const own = placesNamed(words);
  if (own.length) return own[0];
  const fromMessage = placesNamed(message ?? "").find((p) => hasWords(words, p));
  return fromMessage ?? null;
}

// Pure: where one reply search looks (the rule above). kind: "events" always needs a place; "web" needs one unless its words say none.
export function replySearchPlace(o: { kind: "web" | "events"; words: string; toolCity?: string | null; message?: string | null; home?: string | null }): AskPlace {
  const named = searchNamesPlace(o.words, o.message);
  const tool = String(o.toolCity ?? "").trim();
  // The event search: the model's city first; the words win only over a city that is just their home city (review of #252: a topic
  // after "in" read as a place, "women in Venture", must never override the city the model passed).
  if (o.kind === "events" && tool && !(named && samePlace(tool, o.home))) return { place: tool, from: "tool" };
  if (named) return { place: named, from: "words" };
  if (tool) return { place: tool, from: "tool" };
  const needsPlace = o.kind === "events" || !NO_PLACE_WORDS.test(o.words);
  const home = String(o.home ?? "").trim();
  return needsPlace && home ? { place: home, from: "home" } : { place: null, from: "none" };
}

// Pure: what the web search is handed as its city: nothing when the query already says where (nothing added on top), else the place.
export const webSearchCity = (p: AskPlace): string | null => (p.from === "words" ? null : p.place);
