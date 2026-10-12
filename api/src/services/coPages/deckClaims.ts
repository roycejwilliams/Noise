// Punch is fine, invention is not (Royce, 2026-10-11): Co can sharpen and reframe what a member said on a deck, but adds no new factual
// claim about them or their business: no plans, numbers, outcomes or statements they didn't make. "Expand the same playbook to new
// cities" fails; tightening their own words passes. Which is which is a judgment about meaning (a word-for-word check refused
// "Built for independent wellness studios"), so one small model call judges every line against their words for this deck.
// The names, numbers and places check (grounding.ts deckProblems) runs regardless. If this check can't run (twice), the deck isn't
// made and Co says so: a deck never ships unchecked (PR 6, after a call where failing open let invented lines through).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../../models.js";
import { parseModelJson } from "../modelJson.js";

export type Judge = (prompt: string) => Promise<string>;
const haiku: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "deck.claims" }, prompt, abortSignal: AbortSignal.timeout(20_000) })).text;

// Pure: the prompt.
export function claimsPrompt(lines: string[], theirWords: string): string {
  return `A member asked for a slide deck. Below is everything they said for it, then every line on the deck.

A line PASSES when it says what they said: rephrased, tightened, sharpened, reordered or combined, or when it's only a label ("The problem", "Why now", "The ask").
A line FAILS when it adds a factual claim about them or their business they never made: a plan, goal, number, result, customer, market, timeline or quality they didn't state (for example "Next: expand to new cities" when they never said so, or "Not a pilot" when they never said so).

What they said:
"""
${theirWords.slice(0, 6000)}
"""

Deck lines:
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Return ONLY JSON: {"fails": [{"n": <line number>, "why": "<the claim they didn't make, in a few words>"}]}. Empty list when every line passes.`;
}

// The lines that add a claim, or null when the check couldn't run.
// Tried twice before giving up (PR 6: on a call the check timed out and, failing open, let "no free tier, no trials" onto a deck).
export async function inventedLines(lines: string[], theirWords: string, judge: Judge = haiku): Promise<{ line: string; why: string }[] | null> {
  if (!lines.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseModelJson<{ fails?: { n?: number; why?: string }[] }>(await judge(claimsPrompt(lines, theirWords)));
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
