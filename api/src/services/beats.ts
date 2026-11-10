// How Co texts (Royce, 2026-10-01): "Text in beats. Each distinct thought - the
// reaction, the answer, the question, the offer - is its own short message ...
// Read bursts as one message ... a few seconds of quiet, or a text that clearly
// closes the thought."

// A reply's paragraphs, each its own text, at most five (Royce, 2026-10-05: never stack four or more
// paragraphs into one message). Past that the middle stays together, and a closing question always goes
// alone, never buried at the bottom of a wall.
export const MAX_BEATS = 5;
// A closing paragraph that asks them something, in any form: a straight or curly quote, an emoji or a
// short line after the question mark.
export const asksThem = (p: string) => /\?/.test(p);
// A list item: a number, a bullet or "Step N" at its start. Consecutive items, and the line that introduces them (ending in a colon),
// are one connected explanation: one text, never a fragment per step (Royce, 2026-11-10: split only when it helps them read or use it).
const FILLER = new Set(["the", "and", "that", "thats", "this", "its", "it", "is", "are", "was", "with", "for", "you", "your", "just", "really", "very", "also", "but", "has", "have"]);
const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*\u2022]|step \d{1,2}\b)/i;
// Pure: a reply's paragraphs with each list kept whole and a paragraph that only repeats an earlier one left out (Royce, 2026-11-10: a
// link, its description, the description restated, a question). Repeats: nearly every word of substance in it (85%, five words or
// more) is in one earlier paragraph, and it carries no link and no question of its own.
export function keepTogether(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && LIST_ITEM.test(p) && (LIST_ITEM.test(prev.split("\n").pop() ?? "") || /:\s*$/.test(prev))) out[out.length - 1] = `${prev}\n${p}`;
    else out.push(p);
  }
  const words = (t: string) => new Set((t.toLowerCase().replace(/[\u2019']/g, "").match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !FILLER.has(w)));
  return out.filter((p, i) => {
    if (/https?:\/\//.test(p) || /\?/.test(p)) return true;
    const w = words(p);
    if (w.size < 5) return true;
    return !out.slice(0, i).some((q) => { const qw = words(q); return [...w].filter((x) => qw.has(x)).length / w.size >= 0.85; });
  });
}
export function toBeats(message: string): string[] {
  const parts = keepTogether(message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean));
  if (parts.length <= MAX_BEATS) return parts.length ? parts : [message.trim()];
  const last = parts[parts.length - 1];
  const keepLast = asksThem(last);
  const body = keepLast ? parts.slice(0, -1) : parts;
  const room = keepLast ? MAX_BEATS - 1 : MAX_BEATS;
  // The paragraphs spread as evenly as they can across the messages, so no message takes the whole overflow
  // (nine paragraphs are three, two, two, two, not four alone and five in the last).
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < room; i++) {
    const size = Math.ceil((body.length - at) / (room - i));
    out.push(body.slice(at, at + size).join("\n\n"));
    at += size;
  }
  return [...out, ...(keepLast ? [last] : [])];
}
// The gap between beats, like someone typing the next one.
export const BEAT_GAP_MS = 1200;

// How long to wait for the rest of a burst before replying, from when their
// text arrived. A text that looks like more is coming ("so", "and", "...", a
// comma, a one-word opener) gets longer; anything else the usual short window.
export const BURST_WAIT_MS = 4000;
export const BURST_WAIT_UNFINISHED_MS = 8000;
export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(\.\.\.|…|,|:|\band|\bbut|\bso|\bor|\balso|\bplus|\bthen|\bbecause|\blike)$/i.test(t)) return true;
  // One or two words that open a thought rather than finish one.
  return /^(so|ok|okay|well|also|and|but|wait|hmm+|um+|actually|quick question|question|one more thing)[.!,]?$/i.test(t);
}
export function burstWaitMs(text: string): number {
  return looksUnfinished(text) ? BURST_WAIT_UNFINISHED_MS : BURST_WAIT_MS;
}
