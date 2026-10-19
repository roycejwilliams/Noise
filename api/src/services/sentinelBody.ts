// No text Cue sends is ever a placeholder (2026-10-19, found by the room simulation: the direct ask's draft came back as the model's
// "SKIP" and nothing between the draft and Sendblue stopped it). A body that is empty, only whitespace, or a word a model or a code
// path returns for "nothing to send" (SKIP, NONE, null, undefined, [object Object]...) is refused at the send layer: sendWithLedger and
// sendExempt (harness/proactive.ts) refuse it before claiming the ledger and log the rule with the kind of text, and the one wrapper
// every message passes through (services/sendblue.ts) refuses it too, for every other path. Pure.

// The error code the send wrapper (services/sendblue.ts) puts on a placeholder it refuses, so callers can tell it from a failed send
// without reading the message (routes/sendblue.ts sendCoReply gives up on it: a plain retry would be refused the same way).
export const SENTINEL_REFUSAL = "sentinel_body";

// The words that mean "nothing to send", alone (a full stop, quotes or markdown around them don't change that).
const SENTINELS = new Set(["skip", "skipped", "none", "null", "undefined", "nil", "n/a", "[object object]", "{}", "[]", "nan"]);

// Pure: why this body is a placeholder and not a text, or null when it's a real text.
export function sentinelRule(body: unknown): string | null {
  if (typeof body !== "string") return "not text";
  const t = body.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  if (!t) return "empty";
  // "SKIP", "SKIP.", "**SKIP**", "\"skip\"", "(none)".
  const core = t.replace(/^[\s"'\u201C\u201D\u2018\u2019`*_(<]+|[\s"'\u201C\u201D\u2018\u2019`*_)>.!]+$/g, "").trim();
  if (!core) return "empty";
  if (SENTINELS.has(core.toLowerCase())) return `placeholder "${core.slice(0, 20)}"`;
  // A model's skip with its reason ("SKIP: nothing specific to say", "SKIP - no reason"): only SKIP in capitals. "Skip: the 7pm is
  // sold out", "Skip - it's a bargain-bin crowd" and "Skip (honestly) and go..." are advice, and go (review of #265).
  if (/^SKIP[*_\s]*[:\-–—(]/.test(core)) return `placeholder "${core.slice(0, 20)}"`;
  return null;
}

// Pure: the first message of a send that is a placeholder, with why; null when every one is a real text.
export function sentinelIn(messages: unknown[]): { index: number; rule: string } | null {
  if (!messages.length) return { index: 0, rule: "no messages" };
  for (const [index, m] of messages.entries()) {
    const rule = sentinelRule(m);
    if (rule) return { index, rule };
  }
  return null;
}
