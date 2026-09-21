// Jev as a fast pruner for person-to-person matching (2026-09-21). scoreAgainstStatedAsk
// sends every candidate to Claude in one call, which gets slower and dearer as the list
// grows (a guest list at an event can be hundreds). Jev reads each candidate on its own,
// in parallel, and rules out the clear no's; Claude then scores only who is left, so the
// scores, reasons and share-reasons downstream are unchanged. A candidate Jev can't read
// (error, timeout) is kept, so the worst case is today's behaviour.
//
// Sends candidates' profile text to TypeSafe, so it stays behind JEV_DECIDE=matching, which
// is not set anywhere until Royce approves that for other members' data.
import { askJev, noulP } from "./jev.js";
import { JEV_SURE } from "./jevClassifiers.js";
import { formatCandidateDigest } from "./matching.js";

type Cand = { user_id: string; goals?: string[]; blockers?: string[]; activity_preferences?: string[]; intent?: unknown };

// Probability each candidate satisfies the ask, in the same order; null when Jev could not read one.
export async function jevMatchScores(askText: string, candidates: Cand[], concurrency = 8): Promise<(number | null)[]> {
  const out: (number | null)[] = new Array(candidates.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      // The digest line is what Claude reads too, minus its list number.
      const line = formatCandidateDigest([candidates[i]], new Map()).replace(/^0\.\s*/, "");
      const r = await askJev(
        { asked_for: askText, candidate: line },
        {
          satisfies_ask: {
            type: "noul",
            instructions: "Does what is listed about `candidate` satisfy what `asked_for` is looking for? Answer no if nothing listed supports it.",
          },
        },
      );
      out[i] = noulP(r?.answers.satisfies_ask);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return out;
}

// Indexes to keep for Claude: anything Jev is not sure is a no, or could not read.
export function keepAfterPrune(ps: (number | null)[]): number[] {
  return ps.map((p, i) => (p === null || p > JEV_SURE.low ? i : -1)).filter((i) => i >= 0);
}
