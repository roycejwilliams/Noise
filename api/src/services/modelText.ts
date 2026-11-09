// Text that goes into a model request, made safe to send (2026-11-09: the morning sweep's search loop failed for one member on four
// days in a row with "The request body is not valid JSON: unexpected end of hex escape"). A JavaScript string is UTF-16: an emoji or a
// styled letter (𝗯𝗼𝗹𝗱 in an X post) is two code units, a surrogate pair. A .slice() that ends between the two keeps half of it, a
// lone surrogate. JSON.stringify writes that as a bare \ud83d escape, which the model API refuses as invalid JSON, so the whole
// request fails. Postgres jsonb refuses it too, so a record carrying one is silently lost.
//
// clip() cuts on code points (never inside a pair) and wellFormed() drops a lone surrogate wherever one came from. wellFormedPrompt is
// the same guard at the request: every string in a model call's prompt (the brief, the member's record, tool results) is made well
// formed before it is sent, whichever cut or source broke it.
import type { LanguageModelMiddleware } from "ai";

// A high surrogate with no low one after it, or a low surrogate with no high one before it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE.source);

// Pure: whether the text holds a lone surrogate (it would not survive JSON to the model API or a jsonb column).
export const hasLoneSurrogate = (s: string): boolean => HAS_LONE_SURROGATE.test(s);

// Pure: the text with any lone surrogate removed. Whole pairs (every emoji) are kept as they are.
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, "");
}

// Pure: at most max UTF-16 code units (the same budget .slice(0, max) kept), cut on a code point: a pair the cut would split is left
// out whole, never halved. Any lone surrogate already in the text is removed.
export function clip(s: string, max: number): string {
  let cut = s.length > max ? s.slice(0, Math.max(0, max)) : s;
  if (cut.length < s.length && /[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return wellFormed(cut);
}

// Pure: every string in a plain object or array made well formed (wellFormed); anything else (numbers, bytes, URLs, dates) as it is.
// Returns the same value when nothing in it needed a change.
export function wellFormedDeep<T>(v: T): T {
  if (typeof v === "string") return (hasLoneSurrogate(v) ? wellFormed(v) : v) as T;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = wellFormedDeep(x);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : v) as T;
  }
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = wellFormedDeep(x);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return (changed ? out : v) as T;
  }
  return v;
}

// The guard on a model call (wrapLanguageModel): the prompt, every message and tool result in it, made well formed before each step's
// request is built. A prompt with no lone surrogate goes out byte for byte as it was.
export const wellFormedPrompt: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    const prompt = wellFormedDeep(params.prompt);
    return prompt === params.prompt ? params : { ...params, prompt };
  },
};
