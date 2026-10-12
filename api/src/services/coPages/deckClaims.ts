// Punch is fine, invention is not (Royce, 2026-10-11), with the line redrawn the same evening ("A pitch deck's job is rhetoric"):
//   - positioning, framing, contrasts, taglines and rhetoric are punch, never invention;
//   - when they ask Co to figure out the positioning, that's an explicit grant to write it;
//   - a deck about Co itself (for the team): what Co knows about itself counts as fact;
//   - only verifiable hard claims they never made fail: partnerships, customer counts, numbers, named events, named people, and
//     (2026-10-12 intelligence audit) factual market or industry claims nothing they said or read backs ("Most retired EV
//     batteries are landfilled..."); a stance about the market is still rhetoric;
//   - elaborate is the bar: a full deck that passes beats a bare one; a risky line is rewritten safer, never gutted.
// One small model call judges every new line. The names, numbers and places check (grounding.ts deckProblems) runs regardless. If
// this check can't run (twice), the deck isn't made and Co says so: a deck never ships unchecked.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../../models.js";
import { parseModelJson } from "../modelJson.js";

export type Judge = (prompt: string) => Promise<string>;
const haiku: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "deck.claims" }, prompt, abortSignal: AbortSignal.timeout(20_000) })).text;

// Pure: the prompt. self: what Co knows about itself, when the deck is about Co (else empty).
export function claimsPrompt(lines: string[], theirWords: string, self = ""): string {
  return `A member asked for a slide deck. Below is everything they said for it${self ? ", what Co knows about itself (the deck is about Co)" : ""}, then every line on the deck.

A pitch deck's job is rhetoric. A line PASSES when it is:
- what they said, rephrased, tightened, sharpened, reordered or combined;
- positioning, framing, a contrast, a tagline, a stance, a mission or a call to action ("Not another social club", "Built on understanding, not a form", "The room is curated"), even in words they never used;
- any positioning at all when they asked Co to work out the positioning;
${self ? "- anything that matches what Co knows about itself, below;\n" : ""}- only a label ("The problem", "Why now", "The ask").

A line FAILS only when it states a verifiable hard fact they never gave${self ? " and Co doesn't know about itself" : ""}: a partnership or deal ("Partnering with X" when they only named X), a customer or user count, a number, price, metric or date, a named event ("our November launch"), a named person or company presented as fact, or a result or award. Also a FACTUAL claim
about the market, the industry or the world, with or without a number ("Most retired EV batteries are landfilled", "Demand is
doubling", "No one recycles X at scale", a market size, a share, a trend stated as fact) that nothing in what they said or what
was read for it backs: it fails even when it sounds like framing. A stance about the market ("The next wave of X needs Y") is still
rhetoric and passes; a statement of what is true out there needs their words or a source.

What they said (and what was read for this deck, when anything was):
"""
${theirWords.slice(0, 6000)}
"""
${self ? `
What Co knows about itself (facts):
"""
${self.slice(0, 3000)}
"""
` : ""}
Deck lines:
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Return ONLY JSON: {"fails": [{"n": <line number>, "why": "<the hard fact they didn't give, in a few words>"}]}. Empty list when every line passes.`;
}

// The lines that add a claim, or null when the check couldn't run.
// Tried twice before giving up (PR 6: on a call the check timed out and, failing open, let "no free tier, no trials" onto a deck).
export async function inventedLines(lines: string[], theirWords: string, judge: Judge = haiku, self = ""): Promise<{ line: string; why: string }[] | null> {
  if (!lines.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseModelJson<{ fails?: { n?: number; why?: string }[] }>(await judge(claimsPrompt(lines, theirWords, self)));
      return (out.fails ?? [])
        .filter((f) => typeof f?.n === "number" && f.n >= 1 && f.n <= lines.length)
        .map((f) => ({ line: lines[f.n! - 1], why: String(f.why ?? "").slice(0, 120) }));
    } catch {
      continue;
    }
  }
  return null;
}

// Pure: every line of a deck the check reads (the title is a name; the subtitle, headlines and bullets are claims).
export function deckClaimLines(d: { subtitle: string; slides: { headline: string; bullets: string[]; notes?: string }[] }): string[] {
  return [d.subtitle, ...d.slides.flatMap((s) => [s.headline, ...s.bullets, ...(s.notes ? [s.notes] : [])])];
}

// What Co knows about itself, for a deck the team makes about Co: who Co is (the opening of its own prompt,
// prompts/co-system-prompt.md) and what it can do (the capability sheet). Facts from Co's own code, never from a member.
export const CO_IS = "Co gets to know people over time and brings the right people and moments into their lives. Co is invite-only: being here means something. Co is a genuine, ongoing companion, by text and by phone call.";
export async function coSelfKnowledge(): Promise<string> {
  const { capabilitySheet } = await import("../capabilities.js");
  return [CO_IS, ...capabilitySheet()].join("\n");
}
