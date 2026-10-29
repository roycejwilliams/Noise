// Plain rules for the search path, kept free of imports that need API keys so
// the code evals can test them directly (Royce, 2026-09-16).
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { parseAskWindow } from "./askWindow.js";

// ---------------------------------------------------------------------------
// Caching: a "nothing" is never reused. An empty result cached for six hours
// kept missing events added after the first search.
export function shouldCacheSearch(found: readonly unknown[]): boolean {
  return found.length > 0;
}

// What makes two searches the same (code review, 2026-09-17). The key used
// the window's label ("tomorrow", "thursday"), so Monday's "tomorrow" results
// answered Wednesday's; it left out the time zone and browse, and told
// profiles apart only by length and first 40 characters, so two people with
// similar profiles shared results. Now: the resolved dates of the window (or
// today's local date when none was named), the zone, browse, and a hash of the
// whole profile text.
// userId is part of the key (2026-09-22): a cached search carries per-person
// data in its trace (categoryInsight comes from that person's own outcome
// history), and two members with the same city, ask and an empty profile used
// to share one cache entry, so one could be told about the other's history.
export function searchCacheKey(k: {
  userId: string | null | undefined;
  city: string | null;
  askText: string | null | undefined;
  windowStart: string | null;
  windowEnd: string | null;
  today: string;
  zone: string;
  browse: boolean;
  profile: string | null | undefined;
}): string {
  const profileHash = k.profile ? createHash("sha256").update(k.profile).digest("hex").slice(0, 24) : "";
  return [
    k.userId ?? "anon",
    (k.city ?? "").trim().toLowerCase(),
    (k.askText ?? "").trim().toLowerCase(),
    k.windowStart ?? "",
    k.windowEnd ?? "",
    k.windowStart ? "" : k.today,
    k.zone,
    k.browse ? "browse" : "",
    profileHash,
  ].join("|");
}

// ---------------------------------------------------------------------------
// X search budget (code review, 2026-09-17). All X searches share one daily
// cap; the background sweep may only use the part of it not held back for
// people texting Co directly, so a big sweep can't leave a live ask with no
// Tier 3 at all.
export function xSearchBudget(usedToday: number, source: "sweep" | "request", dailyCap: number, requestReserve: number): RewriteCheck {
  const reserve = Math.max(0, Math.min(requestReserve, dailyCap));
  if (usedToday >= dailyCap) return { ok: false, reason: `daily X search cap (${dailyCap}) reached` };
  if (source === "sweep" && usedToday >= dailyCap - reserve) {
    return { ok: false, reason: `the sweep's share of the daily X search cap is used (${dailyCap - reserve} of ${dailyCap}; the rest is held for direct asks)` };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// The message-to-search rewrite may only drop filler. It must keep the
// person's topic, place and time frame in their own words, and never add
// details from anywhere else (2026-09-16: "that founder/builder meetup this
// weekend" became "a weekend founder/builder meetup at a casual cafe setting",
// words Co itself had invented a message earlier).

// Words a rewrite can add without changing what's being asked for.
const FILLER = new Set(
  "a an the and or of for to in on at near around by with from into about find finding look looking search searching for show get some any anything something me my i you your can could would please help want wanted need needed like maybe just really that this these those there here it its is are be been event events meetup meetups group groups thing things one ones kind type sort also too happening going on up coming next week weekend today tonight tomorrow what's whats what where when who how hey co thanks thank sounds interesting cool ok okay so if i'd i'm i'll i've love know wondering curious think".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

function contentWords(text: string): string[] {
  return words(text).filter((w) => !FILLER.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));
}

// Place words they typed: SF / NYC / LA style abbreviations and capitalized
// words after the first ("in Oakland", "near Palo Alto").
function placeWords(text: string): string[] {
  const out: string[] = [];
  const tokens = text.split(/\s+/);
  tokens.forEach((raw, i) => {
    const w = raw.replace(/[^A-Za-z]/g, "");
    if (!w) return;
    if (/^(SF|NYC|LA|DC|ATX|NY)$/.test(w)) out.push(w.toLowerCase());
    else if (i > 0 && /^[A-Z][a-z]+$/.test(w) && /^(in|near|around|at)$/i.test(tokens[i - 1]?.replace(/[^A-Za-z]/g, "") ?? "")) out.push(w.toLowerCase());
  });
  return out;
}

export type RewriteCheck = { ok: boolean; reason: string | null };

export function rewriteKeepsAsk(original: string, rewrite: string, now: DateTime = DateTime.now()): RewriteCheck {
  const originalWindow = parseAskWindow(original, now)?.label ?? null;
  const rewriteWindow = parseAskWindow(rewrite, now)?.label ?? null;
  if (originalWindow !== rewriteWindow) return { ok: false, reason: `time frame changed ("${originalWindow ?? "none"}" became "${rewriteWindow ?? "none"}")` };

  const rewriteLower = rewrite.toLowerCase();
  const lostPlace = placeWords(original).find((p) => !new RegExp(`\\b${p}\\b`).test(rewriteLower));
  if (lostPlace) return { ok: false, reason: `dropped the place "${lostPlace}"` };

  const originalContent = contentWords(original);
  // No topic of their own ("what's going on this weekend?"): borrowing one
  // from what they've told Co they're looking for is the point.
  if (!originalContent.length) return { ok: true, reason: null };

  const originalSet = new Set(words(original));
  const added = contentWords(rewrite).filter((w) => !originalSet.has(w) && !originalSet.has(w.replace(/s$/, "")) && !originalSet.has(`${w}s`));
  if (added.length) return { ok: false, reason: `added words they didn't say: ${added.slice(0, 5).join(", ")}` };

  const lostTopic = originalContent.filter((w) => !new RegExp(`\\b${w.replace(/'/g, "'")}`).test(rewriteLower));
  if (lostTopic.length > Math.max(1, Math.floor(originalContent.length / 3))) {
    return { ok: false, reason: `dropped words that carry the ask: ${lostTopic.slice(0, 5).join(", ")}` };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// X posts for a time-frame ask: only through when the post itself states a
// date inside that window. Posts with no stated date stay out, with a reason.
export type StatedDates = { start: string; end?: string | null } | null;

export function xPostFitsWindow(stated: StatedDates, window: { start: string; end: string } | null): RewriteCheck {
  if (!window) return { ok: true, reason: null };
  if (!stated?.start || !/^\d{4}-\d{2}-\d{2}$/.test(stated.start)) {
    return { ok: false, reason: "the post doesn't state a date, and they asked about a specific time" };
  }
  const start = stated.start;
  const end = stated.end && /^\d{4}-\d{2}-\d{2}$/.test(stated.end) ? stated.end : start;
  const winStart = window.start.slice(0, 10);
  const winEnd = window.end.slice(0, 10);
  if (end < winStart || start > winEnd) {
    return { ok: false, reason: `the post's date (${start === end ? start : `${start} to ${end}`}) is outside ${winStart} to ${winEnd}` };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Whether their message was nothing but the search ask. Then the link and its
// caption already answer it, and a third message repeating them is noise
// (2026-09-16: "Just sent you one, actually, Codex Community Meetup this
// Tuesday..." after the link and a full caption). Anything more in the
// message (a feeling, a second question, news) still gets a reply.
// Emoji or anything beyond words and ordinary punctuation is extra: a
// feeling can be just "😭" (code review, 2026-09-16).
function hasEmojiOrSymbols(text: string): boolean {
  return /[^\p{L}\p{N}\s.,!?'’"“”\-–:;()&/$#%@+]/u.test(text);
}

export function messageIsOnlyTheAsk(original: string, rewritten: string): boolean {
  if (/\?.*\?/s.test(original)) return false; // two questions
  if (hasEmojiOrSymbols(original)) return false;
  const originalContent = contentWords(original);
  if (!originalContent.length) return true;
  const rewriteWords = new Set(words(rewritten));
  return originalContent.every((w) => rewriteWords.has(w) || rewriteWords.has(w.replace(/s$/, "")) || rewriteWords.has(`${w}s`));
}

// Whether the reply after sent results can be skipped. Only when the message
// was nothing but the ask, the search ruled nothing out (that correction goes
// out in the reply), and it isn't their first real message (opening the
// conversation and the first-contact call offer live in the reply).
// beyondAsk is the router's read of everything else in the message: null
// means only the ask (2026-09-18: "What does SF tech week look like? Oct 5th
// - Oct 11th?" and "Did you see anything about VC looking to fund?" each got
// a message restating the result, because the word-match below failed on a
// date range and on "looking"/"look"). Undefined falls back to that match.
export function canSkipReplyAfterResults(t: {
  sentResults: number;
  original: string | null;
  rewritten: string | null;
  ruledOut: number;
  firstRealMessage: boolean;
  beyondAsk?: string | null;
}): boolean {
  if (!t.sentResults) return false;
  if (t.ruledOut > 0 || t.firstRealMessage) return false;
  if (t.original && hasEmojiOrSymbols(t.original)) return false;
  if (t.beyondAsk === null) return true;
  if (typeof t.beyondAsk === "string") return false;
  if (!t.original || !t.rewritten) return false;
  return messageIsOnlyTheAsk(t.original, t.rewritten);
}

// Which results a late search answer tries, in order: each tier's best first,
// then the rest, at most five (2026-09-18: a grants ask tried three events and
// never reached the grant in fifth place).
export function triesInOrder<T extends { tier: number }>(matches: T[], limit = 5): T[] {
  const seenTier = new Set<number>();
  const firsts = matches.filter((m) => !seenTier.has(m.tier) && seenTier.add(m.tier));
  return [...firsts, ...matches.filter((m) => !firsts.includes(m))].slice(0, limit);
}

// Matches the search found that were already sent to this person, by name (max 3). When
// every good match is one already offered, the honest answer is "those are the ones I sent,
// nothing new since", not "nothing came up" (2026-09-21).
export function alreadySentNames(gatedOut: { name: string; reasons: string[] }[] | null | undefined): string[] {
  const names = (gatedOut ?? []).filter((g) => g.reasons.some((r) => /already offered/i.test(r))).map((g) => g.name);
  return [...new Set(names)].slice(0, 3);
}

// A message that only asks what's new with Co ("Updates?", "any updates",
// "what's new?"), with nothing else to answer.
export function isOnlyUpdatesAsk(text: string): boolean {
  return /^\s*(hey\s*,?\s*|yo\s*,?\s*)?(any\s+(new\s+)?updates|updates|what'?s\s+new|anything\s+new)(\s+(with|on)\s+(you|co|cue))?\s*[?!.]*\s*$/i.test(text);
}

// ---------- A named event in an ask (2026-09-21)
//
// Live replies don't run the web search (the sweep does), so "What's going on at AfroTech?"
// could only ever say "nothing turned up". When the ask names ONE specific event and the
// public Luma search found nothing, one web lookup for that event's own page runs
// (services/namedEventLookup.ts, never wired in and removed 2026-10-29). These are its checks on what the models say.

const compactText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const GENERIC_EVENT_NAMES = /^(events?|meetups?|conferences?|hackathons?|mixers?|parties|party|things|stuff|tech events?|networking)$/i;

// The one event an ask names, as they wrote it. A name that isn't in their own message never
// counts, so a name from earlier in the chat can't be swapped in.
export function namedEventFromModel(parsed: unknown, askText: string): string | null {
  const name = typeof (parsed as { name?: unknown } | null)?.name === "string" ? (parsed as { name: string }).name.trim() : "";
  if (name.length < 3 || name.length > 60 || GENERIC_EVENT_NAMES.test(name)) return null;
  return compactText(askText).includes(compactText(name)) ? name : null;
}

export type EventLookup = { name: string; url: string; start: string | null; end: string | null; reason: string };

// What the web lookup found: a real https page, a name, a reason, and dates only when they're
// well-formed.
export function eventLookupFromModel(parsed: unknown): EventLookup | null {
  const p = parsed as { found?: unknown; name?: unknown; url?: unknown; reason?: unknown; start?: unknown; end?: unknown } | null;
  if (!p?.found || typeof p.name !== "string" || typeof p.url !== "string" || typeof p.reason !== "string") return null;
  if (!p.name.trim() || !p.reason.trim() || !/^https:\/\/[^\s/]+\.[^\s/]+/.test(p.url)) return null;
  const date = (d: unknown) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  return { name: p.name.trim(), url: p.url, reason: p.reason.trim(), start: date(p.start), end: date(p.end) };
}

// Ticketing pages an event's own organizers use, alongside a site that carries its name.
export function isTicketingHost(url: string): boolean {
  try {
    return /(^|\.)(lu\.ma|luma\.com|eventbrite\.com|partiful\.com|meetup\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
