// What a golden quality run will cost, from the committed recordings (no model call): each recorded answer's real usage, priced the way
// the meter prices a real-models run (the model the call used; a grader on Sonnet), times the runs, plus the rubric judge's call per
// reply turn. A case with no recordings yet (a new case) is counted at the median recorded reply case. Cache reads were whatever they
// were when the case was recorded, so a run's 2nd and 3rd pass usually costs a little less than this says.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRICES } from "../../src/services/llmUsage.js";

const DIR = new URL("./recordings/", import.meta.url).pathname;
// One rubric grade (evals/lib/replyRubric.ts): ~2,700 tokens in (facts, thread, rubric), ~250 out, on Sonnet.
export const RUBRIC_CALL_USD = (2700 * PRICES["claude-sonnet-5"].input + 250 * PRICES["claude-sonnet-5"].output) / 1e6;

export type CaseCost = { id: string; usd: number; calls: number; replyTurns: number; recorded: boolean };

export function recordedCost(id: string): CaseCost | null {
  const d = join(DIR, id.replace(/[^\w.-]+/g, "-"));
  if (!existsSync(d)) return null;
  let usd = 0;
  let calls = 0;
  let replyTurns = 0;
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(join(d, f), "utf8"));
    if ((r.request?.tools ?? []).includes("sendReply") && r.request?.messages === 1) replyTurns++;
    for (const resp of r.responses ?? []) {
      const model = r.request?.grader ? "claude-sonnet-5" : /haiku-4-5/.test(resp.model ?? "") ? "claude-haiku-4-5" : /haiku/.test(resp.model ?? r.model ?? "") ? "claude-haiku-5-5" : "claude-sonnet-5";
      const p = PRICES[model];
      const u = resp.usage ?? {};
      usd += ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
      calls++;
    }
  }
  return { id, usd, calls, replyTurns, recorded: true };
}

// cases: what the run covers. A case with no recordings that is live makes no model call (it costs nothing); one waiting on its first
// recording is counted at the median recorded reply case, once per reply turn it runs (GoldenCase.turns, default 1).
export function estimateQuality(cases: { id: string; awaiting: boolean; turns?: number }[], runs: number): { cases: CaseCost[]; perRun: number; total: number; unrecorded: string[] } {
  const known = cases.map((c) => recordedCost(c.id));
  // The median one-turn reply case over every recording, not only the picked ones (a run of new cases alone has none of its own).
  const replyCases = (existsSync(DIR) ? readdirSync(DIR) : []).map((id) => recordedCost(id)).filter((c): c is CaseCost => !!c && c.replyTurns === 1).map((c) => c.usd).sort((a, b) => a - b);
  const median = replyCases.length ? replyCases[Math.floor(replyCases.length / 2)] : 0.1;
  const out = cases.map((c, i) => known[i] ?? (c.awaiting ? { id: c.id, usd: median * (c.turns ?? 1), calls: 0, replyTurns: c.turns ?? 1, recorded: false } : { id: c.id, usd: 0, calls: 0, replyTurns: 0, recorded: true }));
  const perRun = out.reduce((a, c) => a + c.usd + c.replyTurns * RUBRIC_CALL_USD, 0);
  return { cases: out, perRun, total: perRun * runs, unrecorded: out.filter((c) => !c.recorded).map((c) => c.id) };
}
