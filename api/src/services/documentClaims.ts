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
import { partlyBacked, unbackedClaims, unknownOpeners } from "./documentGrounding.js";

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
- a closing ask or next step they asked Co to write, when it states no fact they never gave ("Pour at the launch dinner on the same terms");
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

// The judge's read: the lines it read as theirs, and why each other line fails. Null when it couldn't run. Tried twice.
export type Verdict = { backed: Set<string>; why: Map<string, string> };
export async function judgeLines(lines: string[], theirWords: string, judge: Judge = haikuJudge): Promise<Verdict | null> {
  if (!lines.length) return { backed: new Set(), why: new Map() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseModelJson<{ backed?: unknown[]; fails?: { n?: number; why?: string }[] }>(await judge(documentClaimsPrompt(lines, theirWords)));
      if (!Array.isArray(out?.backed)) continue;
      const ok = (n: unknown): n is number => typeof n === "number" && n >= 1 && n <= lines.length;
      const fails = (out.fails ?? []).filter((f) => ok(f?.n));
      const failed = new Set(fails.map((f) => f.n));
      const why = new Map(fails.map((f) => [lines[f.n! - 1], String(f.why ?? "").slice(0, 120) || "it adds something they never said"]));
      return { backed: new Set(out.backed.filter((n): n is number => ok(n) && !failed.has(n)).map((n) => lines[n - 1])), why };
    } catch {
      continue;
    }
  }
  return null;
}

// What is wrong with a document, with paraphrase of their own words let through: documentProblems, then one judge call for the lines
// the word check couldn't place, and for long lines it passed with some words not theirs (where a claim of Co's own can hide in their
// vocabulary). Numbers and names they never gave are never sent to it. Fail safe: if the judge can't run, the word check's verdict
// stands. problems: documentProblems(doc, source) already run by the caller.
export async function judgedDocumentProblems(doc: Doc, source: { theirs: string; read?: string }, problems: string[] = documentProblems(doc, source), judge: Judge = haikuJudge): Promise<string[]> {
  const parts = memberParts(doc);
  const soft = unbackedClaims(parts, source.theirs, { strict: true }).filter((u) => !u.hard.length).map((u) => u.text);
  const partial = partlyBacked(parts, source.theirs, { strict: true });
  // A line opening on a capitalized word they never used may open on a name: the judge reads it, and without a judge it's held.
  const openers = unknownOpeners(parts, source.theirs);
  const judged = [...new Set([...partial, ...openers.map((x) => x.line)])];
  const lines = [...new Set([...soft, ...judged])];
  if (!lines.length) return problems;
  const v = await judgeLines(lines, source.theirs, judge);
  if (!v) return [...problems, ...openers.filter((x) => !problems.some((p) => p.includes(x.line.slice(0, 60)))).map((x) => `"${x.line.slice(0, 90)}" opens on ${x.word}, which they never said: if it's a name, leave it out or ask them`)].slice(0, 7);
  const judgedOut = new Map(judged.filter((l) => !v.backed.has(l)).map((l) => [l, v.why.get(l) ?? "it adds something they never said"] as [string, string]));
  return documentProblems(doc, source, { backed: v.backed, judgedOut });
}
