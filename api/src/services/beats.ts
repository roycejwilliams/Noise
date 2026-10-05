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
export function toBeats(message: string): string[] {
  const parts = message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
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
