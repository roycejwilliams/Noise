// Jev as a fast first pass for person-to-person matching (2026-09-21, back
// 2026-09-25 through the zero-retention gateway). At a Co event, each arrival
// is compared with everyone in the room, which grows with the square of the
// headcount. Jev reads each candidate on its own, in parallel, and rules out
// only the clear no's; Claude then scores who is left, so scores, reasons and
// share-reasons downstream are unchanged. Anything Jev can't read is kept, so
// the worst case is how it worked before.
//
// Candidates' profile lines (shareable asks, goals and likes only, matching.ts candidateLines) go to TypeSafe only through Vercel's gateway
// with zero data retention (services/jevGateway.ts), and only where member
// text may go to Jev at all (JEV_MEMBER=on). JEV_PRUNE=off turns this off.
import { askJevZdr, jevForMemberText } from "./jevGateway.js";
import { candidateLines } from "./matching.js";

// Below this, Claude reads everyone anyway: pruning isn't worth a round trip.
export const PRUNE_MIN_CANDIDATES = 7;
// Only a clear no is dropped.
export const PRUNE_BELOW = 0.15;

export function pruneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevForMemberText(env) && env.JEV_PRUNE !== "off";
}

type Cand = { user_id: string; goals?: string[]; blockers?: string[]; activity_preferences?: string[]; intent?: unknown };

// Probability each candidate fits the ask, in order; null when Jev couldn't
// read one. One request per chunk of the room, one question per candidate
// (2026-09-25: one request per candidate hit the gateway's rate limit even
// two at a time; 40 in one request came back in about 260ms).
export const PRUNE_CHUNK = 40;
// askerFirstName: the member the prune is for; their name is left out of every candidate's line, as in Claude's (matching.ts).
export async function jevMatchScores(askText: string, candidates: Cand[], askerFirstName?: string): Promise<(number | null)[]> {
  const out: (number | null)[] = new Array(candidates.length).fill(null);
  const chunks: number[][] = [];
  for (let i = 0; i < candidates.length; i += PRUNE_CHUNK) chunks.push(Array.from({ length: Math.min(PRUNE_CHUNK, candidates.length - i) }, (_, j) => i + j));
  // The same member-safe, capped lines Claude reads (matching.ts candidateLines) without their hidden part: no private ask, no
  // blocker, no memory row. A fit only the hidden part supports is never proposed, so the prune has no use for it.
  const lines = candidateLines(candidates, undefined, undefined, { withHidden: false, askerFirstName });
  await Promise.all(
    chunks.map(async (idx) => {
      const listed: Record<string, string> = {};
      const questions: Record<string, { type: "boolean"; instructions: string }> = {};
      for (const i of idx) {
        const key = `c${i}`;
        listed[key] = lines[i];
        questions[key] = { type: "boolean", instructions: `Does what is listed for candidates.${key} plausibly fit what asked_for is looking for? No only if nothing listed supports it.` };
      }
      // One retry: the gateway is sometimes busy (503) for a moment.
      const ask = () => askJevZdr({ asked_for: askText, candidates: listed }, questions, 10_000).catch(() => null);
      const r = (await ask()) ?? (await new Promise((res) => setTimeout(res, 500)).then(ask));
      for (const i of idx) out[i] = typeof r?.[`c${i}`] === "number" ? r[`c${i}`] : null;
    }),
  );
  return out;
}

// Indexes to keep for Claude: anything that isn't a clear no, or couldn't be read.
export function keepAfterPrune(ps: (number | null)[], below = PRUNE_BELOW): number[] {
  return ps.map((p, i) => (p === null || p >= below ? i : -1)).filter((i) => i >= 0);
}
