// Golden conversations (Royce, 2026-10-13: "A small set of golden conversations replayed on each release ... would have caught most
// of today before you saw it"). Each case is a scripted member exchange or a discovery step, run through Co's real code path, with
// assertions on what Co said or decided. Fixtures live here, versioned in the repo; one command runs them locally and the same
// command is the pre-merge CI check (evals/golden/run.ts, .github/workflows/co-evals.yml job "golden").
//
// The plan's case list (docs: "Discovery as its own subsystem", final case list) is the source of truth for ids and intent.

// live: runs now and fails the run on a miss. pending: its phase hasn't landed; the case still runs when it can (reported, never
// fails the run), so a pending case's first green run is visible. Each pending case names the phase that makes it live.
export type GoldenStatus = { live: true } | { live: false; until: string; why: string };

export type GoldenResult = {
  ok: boolean;
  // What failed, in plain words, one line each. Empty when ok.
  misses: string[];
  // What Co actually said or decided, for the log (the reply text, the decision, the stored lesson).
  observed: string;
};

export type GoldenCase = {
  n: number; // the plan's case number (1-22)
  id: string; // short slug, e.g. "running-work"
  title: string;
  status: GoldenStatus;
  // Where it came from: the live incident or the amendment that asked for it.
  from: string;
  run: () => Promise<GoldenResult>;
};

export const pass = (observed: string): GoldenResult => ({ ok: true, misses: [], observed });
export const result = (misses: string[], observed: string): GoldenResult => ({ ok: misses.length === 0, misses, observed });
