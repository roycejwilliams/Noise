// Words in quotation marks that Cue presents as the member's own (2026-11-07 review: a check-in five minutes after a call said 'You went
// from "we are really a social club" to "I like that."', and neither phrase was in the member's texts or call lines; "social club" was
// only ever in Cue's own replies). A factual check, the way the feeling read is (harness/attention.ts feelingCheck), never a veto on
// ordinary speech: only a quote said to be theirs, and only when nothing of theirs has it. Such a quote is redrafted without it (a
// proactive draft gets its one rewrite; a reply cuts the sentence).
//
// Theirs: their stored texts and call lines (harness/memberThreads.ts ownLines), the message being answered, and the quotes their
// threads recorded from their own words when the thread opened or closed (member_threads.opened_quote / closed_quote, gated there
// against their lines: gateThreadChanges). Pure.
import type { GateCheck } from "./core.js";

export const QUOTE_IS_THEIRS = "quote_is_theirs";

// A sentence that says the quoted words are theirs: "you said", "you told me", "you went from", "your words", "in your words", "you called it".
const ATTRIBUTED = /\byou(?:'ve|\s+have|'d|\s+had)?\s+(?:said|say|says|told me|wrote|write|texted|put it|called it|call it|described it as|mentioned|went from|were saying|kept saying|keep saying|started with|landed on|came back with)\b|\byour (?:own )?words\b|\bin your words\b|\bas you put it\b/i;
const QUOTED = /["“]([^"“”]{2,200})["”]/g;
// Pure: a text's sentences, each with its trailing space, never split inside quotation marks ("I like that." stays in its sentence).
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (ch === "“" || (ch === '"' && !inQuote)) inQuote = true;
    else if (ch === "”" || (ch === '"' && inQuote)) inQuote = false;
    const closesQuotedSentence = !inQuote && (ch === '"' || ch === "\u201d") && /[.!?]/.test(text[i - 1] ?? "") && /\s/.test(text[i + 1] ?? "");
    if (!inQuote && (ch === "\n" || closesQuotedSentence || (/[.!?]/.test(ch) && !/[.!?"\u201d]/.test(text[i + 1] ?? "")))) {
      while (i + 1 < text.length && text[i + 1] === " ") cur += text[++i];
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

const flat = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: the quotes a text presents as the member's own words (each quoted span in a sentence that attributes words to them).
export function quotesAsTheirs(text: string): string[] {
  const out: string[] = [];
  for (const sentence of sentencesOf(text)) {
    if (!ATTRIBUTED.test(sentence)) continue;
    for (const m of sentence.matchAll(QUOTED)) {
      const q = m[1].trim();
      if (flat(q)) out.push(q);
    }
  }
  return out;
}

// Pure: the quotes presented as theirs that none of their words hold.
export function unbackedQuotes(text: string, theirs: string[]): string[] {
  const pool = theirs.map(flat).filter(Boolean);
  return quotesAsTheirs(text).filter((q) => !pool.some((p) => p.includes(flat(q))));
}

// Pure: the check. Passes when nothing is quoted as theirs, or every such quote is in their words.
export function quoteCheck(text: string, theirs: string[]): GateCheck {
  const bad = unbackedQuotes(text, theirs);
  return bad.length
    ? { name: QUOTE_IS_THEIRS, pass: false, reason: `quote: "${bad[0]}" (quoted as their words, but no line of theirs says it: say it in your own words without quotation marks, only as far as what they actually said supports, or leave it out)` }
    : { name: QUOTE_IS_THEIRS, pass: true };
}

// Pure: the quotes a proactive candidate carries from their own words (a milestone's story, a thread's opening and closing quote).
export function recordedQuotes(payload: unknown): string[] {
  const p = (payload ?? {}) as { story?: { then?: unknown; now?: unknown }; thread?: { openedQuote?: unknown; closedQuote?: unknown; opened_quote?: unknown; closed_quote?: unknown } | null };
  return [p.story?.then, p.story?.now, p.thread?.openedQuote, p.thread?.closedQuote, p.thread?.opened_quote, p.thread?.closed_quote].filter((x): x is string => typeof x === "string" && !!x.trim());
}

// Pure: the sentences of a text without the ones that quote words as theirs that they never said. Null when nothing would be left.
export function withoutUnbackedQuotes(messages: string[], theirs: string[]): string[] | null {
  const out = messages
    .map((m) => sentencesOf(m).filter((s) => s.trim() && !unbackedQuotes(s, theirs).length).join("").trim())
    .filter((m) => m.length > 0);
  return out.length ? out : null;
}

// Pure: a text without the sentences that carry one of these quotes (the reply's cut, harness/replyGrounding.ts stripUnsupported).
export function withoutQuoted(text: string, quotes: string[]): string {
  const qs = quotes.map(flat).filter(Boolean);
  return sentencesOf(text).filter((s) => !quotesAsTheirs(s).some((q) => qs.includes(flat(q)))).join("").trim();
}
// Pure: the quotes a failed quoteCheck names.
export const quotesNamedIn = (reasons: (string | undefined)[]): string[] => reasons.map((r) => /^quote: "(.*)" \(quoted as their words/.exec(r ?? "")?.[1]).filter((x): x is string => !!x);

// How far back their own lines are read to trace a quote.
export const QUOTE_LINES_DAYS = 120;
// Their own lines on file, to trace a quote to (harness/memberThreads.ts ownLines: their texts and their side of calls, newest 200 over
// QUOTE_LINES_DAYS, what they took back or removed left out). Never a thread's or a story's saved quote, and never Cue's lines. A failed
// read: none, so a quote is never let through on a read that didn't happen.
export async function theirLinesForQuotes(userId: string): Promise<string[]> {
  return import("./memberThreads.js").then((T) => T.ownLines(userId, QUOTE_LINES_DAYS, { newest: true })).then((ls) => ls.map((l) => l.text)).catch(() => [] as string[]);
}
