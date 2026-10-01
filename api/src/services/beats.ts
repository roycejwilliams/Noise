// How Co texts (Royce, 2026-10-01): "Text in beats. Each distinct thought - the
// reaction, the answer, the question, the offer - is its own short message ...
// Read bursts as one message ... a few seconds of quiet, or a text that clearly
// closes the thought."

// A reply's paragraphs, each its own text, at most three: past that the rest
// stays together in the last one, so a long walkthrough doesn't become a flood.
export const MAX_BEATS = 3;
export function toBeats(message: string): string[] {
  const parts = message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= MAX_BEATS) return parts.length ? parts : [message.trim()];
  return [...parts.slice(0, MAX_BEATS - 1), parts.slice(MAX_BEATS - 1).join("\n\n")];
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
