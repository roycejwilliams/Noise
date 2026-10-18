// Where a reply's search looks (Royce, 2026-10-18: "The situation decides what Cue looks for and which helpers run. What we know
// about a member shapes how, never which helper."). The sweep already looks where the want is (eventSurfacingSweep.ts searchPlace,
// #219); this is the same for the reply path's webSearch and searchEvents (agent/loopTools.ts). Pure: no model, no database.
//
// The place comes from the ask, in this order:
//   1. a place the search's own words name (the web query, or the event search's "what"): "in Lisbon", "near Oakland", SF, NYC; or a
//      place their message this turn names ("any founder dinners in Lisbon?") that the search's words repeat ("Lisbon founder
//      dinners"). The words carry it: the web search adds nothing on top, the event search looks there;
//   2. else the place the tool call carries from the ask (searchEvents' city, webSearch's theirs.city);
//   3. else, when the ask names no place, their home city (the profile city) stands in, as the sweep does for a want with no place,
//      and only when the search needs a place: an event search always does (the feed is by city); a web search does unless its words
//      say it has none (online, remote, virtual, anywhere). A search with no place of its own and no home city looks with none.
// So the profile city never decides where to look when the ask names a place, and it never adds or removes a search or picks a tool:
// it only fills in "where" for an ask that left it empty.
import { placesClaimed } from "../harness/matchGate.js";
import { ALIASES } from "./wantPlace.js";

export type AskPlaceFrom = "words" | "tool" | "home" | "none";
export type AskPlace = { place: string | null; from: AskPlaceFrom };

// Words a capitalized phrase after "in"/"near" can start with that make it not a place ("founders in AI", "talks in Spanish").
const NOT_A_PLACE = new Set(["ai", "tech", "vc", "vcs", "yc", "web3", "crypto", "fintech", "climate", "health", "product", "design", "person", "english", "spanish", "french", "portuguese", "german", "mandarin", "q1", "q2", "q3", "q4"]);
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
  if (named) return { place: named, from: "words" };
  const tool = String(o.toolCity ?? "").trim();
  if (tool) return { place: tool, from: "tool" };
  const needsPlace = o.kind === "events" || !NO_PLACE_WORDS.test(o.words);
  const home = String(o.home ?? "").trim();
  return needsPlace && home ? { place: home, from: "home" } : { place: null, from: "none" };
}

// Pure: what the web search is handed as its city: nothing when the query already says where (nothing added on top), else the place.
export const webSearchCity = (p: AskPlace): string | null => (p.from === "words" ? null : p.place);
