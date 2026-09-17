// Plain rules for the search path, kept free of imports that need API keys so
// the code evals can test them directly (Royce, 2026-09-16).
import { DateTime } from "luxon";
import { parseAskWindow } from "./askWindow.js";

// ---------------------------------------------------------------------------
// Caching: a "nothing" is never reused. An empty result cached for six hours
// kept missing events added after the first search.
export function shouldCacheSearch(found: readonly unknown[]): boolean {
  return found.length > 0;
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
export function messageIsOnlyTheAsk(original: string, rewritten: string): boolean {
  if (/\?.*\?/s.test(original)) return false; // two questions
  const originalContent = contentWords(original);
  if (!originalContent.length) return true;
  const rewriteWords = new Set(words(rewritten));
  return originalContent.every((w) => rewriteWords.has(w) || rewriteWords.has(w.replace(/s$/, "")) || rewriteWords.has(`${w}s`));
}
