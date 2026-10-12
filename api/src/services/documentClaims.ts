// Their words, said another way, are still theirs (2026-10-12, the Ellis artifacts test): the word-by-word check in
// documentGrounding.ts refused 13 of 15 documents for close paraphrase of what he told Co: "the Fieldhouse chef" for "our chef",
// "Guest list is about half full" for "about half full" (his answer to Co's guest-list question), "from what guests told us at RSVP" for
// "what people told me when they RSVP'd". The founder never got his positioning doc.
//
// So the word check is a first pass, not the verdict. A line it can't place in their words goes to one small model call, the way
// deck lines do (coPages/deckClaims.ts): is this what they said, in other words, or does it add something? Hard facts stay in code:
// a number or a name they never gave is refused whatever the judge says. Fail safe: when the judge can't run (twice), the word
// check's verdict stands and the document waits; nothing ships unchecked.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { documentProblems, memberParts, type Doc } from "./documentSheet.js";
import { unbackedClaims } from "./documentGrounding.js";

export type Judge = (prompt: string) => Promise<string>;
export const haikuJudge: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 600, experimental_telemetry: { isEnabled: true, functionId: "document.claims" }, prompt, abortSignal: AbortSignal.timeout(20_000) })).text;

// Their words a judge reads: the newest part when there's a lot, never cut mid-text at the start.
export const JUDGE_WORDS_CHARS = 9000;
const recent = (t: string) => {
  if (t.length <= JUDGE_WORDS_CHARS) return t;
  const cut = t.slice(-JUDGE_WORDS_CHARS);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < 400 ? cut.slice(nl + 1) : cut;
};

// Pure: the prompt.
export function documentClaimsPrompt(lines: string[], theirWords: string): string {
  return `A member asked Co for a document. Its main sections are THEIR points: a record of what they told Co. Co's own ideas go in a separate, marked suggestions box, not here. Below is everything they said, oldest first, then the lines to judge from their sections.

A line PASSES when it is what they said, in other words:
- rephrased, shortened, tightened, or put in the document's voice ("we", "our", "they", their name or their club's name in place of "I" or "my");
- two or more of their own statements put together, even from different texts (an answer and the question it answered count together);
- a plain label or framing of their own point ("The format", "What we're asking for").

- when they asked Co to frame, position or make the case for something: a framing, contrast or stance that rests on their facts ("Not a sponsored tasting: the pairings are picked for a table already seated on purpose"). Framing states no new fact about them.
- a contrast with the alternative they named, in general terms ("A sponsored tasting is the same pour for everyone"): that's framing too, not a fact about them.

A line FAILS when it adds a fact they never gave:
- a number, count, price, date, name, partner or deal, an event, a result or outcome, a metric;
- something presented as true about them, their guests, partner, process or results that they never said ("guests rebook more", "the importer saw sales go up", "each pairing is planned for its table" when they never said how pairings are planned);
- a missing piece written as if it were there (an example, a quote, a detail they said they don't have yet).

What they said:
"""
${recent(theirWords)}
"""

Lines to judge:
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Return ONLY JSON: {"backed": [<numbers of the lines that PASS>], "fails": [{"n": <line number>, "why": "<what it adds, in a few words>"}]}.`;
}

// The lines a judge read as theirs, or null when it couldn't run. Tried twice.
export async function backedLines(lines: string[], theirWords: string, judge: Judge = haikuJudge): Promise<Set<string> | null> {
  if (!lines.length) return new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseModelJson<{ backed?: unknown[]; fails?: { n?: number }[] }>(await judge(documentClaimsPrompt(lines, theirWords)));
      if (!Array.isArray(out?.backed)) continue;
      const failed = new Set((out.fails ?? []).map((f) => f?.n));
      return new Set(out.backed.filter((n): n is number => typeof n === "number" && n >= 1 && n <= lines.length && !failed.has(n)).map((n) => lines[n - 1]));
    } catch {
      continue;
    }
  }
  return null;
}

// What is wrong with a document, with paraphrase of their own words let through: documentProblems, then a judge for the lines the
// word check couldn't place (numbers and names they never gave are never sent to it). No judge call when nothing needs one.
// problems: documentProblems(doc, source) already run by the caller.
export async function judgedDocumentProblems(doc: Doc, source: { theirs: string; read?: string }, problems: string[] = documentProblems(doc, source), judge: Judge = haikuJudge): Promise<string[]> {
  if (!problems.length) return problems;
  const soft = unbackedClaims(memberParts(doc), source.theirs).filter((u) => !u.hard.length).map((u) => u.text);
  if (!soft.length) return problems;
  const backed = await backedLines([...new Set(soft)], source.theirs, judge);
  if (!backed) return problems;
  return documentProblems(doc, source, { backed });
}
