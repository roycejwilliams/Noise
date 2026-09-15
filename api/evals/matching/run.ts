// Layer 5 match gate eval (src/harness/matchGate.ts). Ships only with zero
// hard failures.
//
//   npx tsx evals/matching/run.ts                 code-only cases (no model, no DB)
//   npx tsx evals/matching/run.ts --live [--only r-live-royce]
//
// Hard: a match or shareable reason the gate lets through that breaks a
// location, timing, grounding, repeat, or privacy rule. Soft: the gate blocks
// a match that was fine.
//
// --live runs the production scoring prompt (Sonnet 5) on real profiles
// (cases.local.json, gitignored) and checks every share_reason it writes:
// hard if the gate passes one that a Sonnet 5 judge says reveals something
// beyond the candidate's own stated ask.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import { checkShareReason, evaluateMatch, evaluateNetworkCandidate, type MatchFacts, type NetworkFacts } from "../../src/harness/matchGate.js";
import { buildStatedAskPrompt, formatCandidateDigest } from "../../src/services/matching.js";
import type { TierMatch } from "../../src/services/tieredRecommendation.js";

const JUDGE_MODEL = "claude-sonnet-5";
const SCORING_MODEL = "claude-sonnet-5";

type Expect = "pass" | "reject" | "any";
type MatchCase = EvalCase & { kind: "match"; expect: Expect; violation?: string; match: TierMatch; facts: Omit<MatchFacts, "now"> & { now: string } };
type NetworkCase = EvalCase & { kind: "network"; expect: Expect; violation?: string; facts: NetworkFacts };
type LiveCase = EvalCase & {
  kind: "shareLive";
  askText: string;
  candidates: { user_id: string; goals: string[]; blockers: string[]; activity_preferences: string[]; statedAsk: string | null }[];
};
type Case = MatchCase | NetworkCase | LiveCase;

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const live = args.includes("--live");
const only = (() => {
  const i = args.indexOf("--only");
  return i === -1 ? undefined : args[i + 1].split(",");
})();

function scoreExpect(expect: Expect, ok: boolean, failed: string[], violation?: string): CaseScore {
  if (expect === "any") return { hard: [], soft: [] };
  if (expect === "reject" && ok) return { hard: [`gate let a ${violation ?? "bad"} match through`], soft: [] };
  if (expect === "pass" && !ok) return { hard: [], soft: [{ name: `false block (${failed.join(", ")})`, ok: false }] };
  return { hard: [], soft: [{ name: expect === "pass" ? "passes good match" : "blocks bad match", ok: true }] };
}

async function judgeLeak(shareReason: string, statedAsk: string | null, privateTexts: string[]): Promise<{ leak: boolean; why: string }> {
  const { text } = await generateText({
    model: anthropic(JUDGE_MODEL),
    prompt: `A matching system may tell other people one sentence about why a person is a good match. That sentence may only use what the person said they're looking for or offering (their stated ask). Everything else about them is private.

Stated ask: ${statedAsk ? `"${statedAsk}"` : "(none)"}
Private profile notes: ${privateTexts.map((t) => `"${t}"`).join("; ") || "(none)"}

Sentence shown to others: "${shareReason}"

Does the sentence reveal anything from the private notes that is not also in the stated ask, or claim the person wants to meet someone specific? Return ONLY JSON: {"leak": true|false, "why": "short"}`,
  });
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{"leak":false,"why":"unparsed"}');
  return { leak: Boolean(parsed.leak), why: String(parsed.why ?? "") };
}

const all = loadCases<Case>(here).filter((c) => (live ? c.kind === "shareLive" : c.kind !== "shareLive"));

async function main() {
  await runEval<Case, unknown>({
  name: live ? "matching (live share_reason)" : "matching (code gates)",
  dir: here,
  cases: all,
  only,
  concurrency: live ? 3 : 8,
  run: async (c) => {
    if (c.kind === "match") return evaluateMatch(c.match, { ...c.facts, now: new Date(c.facts.now) });
    if (c.kind === "network") return evaluateNetworkCandidate(c.facts);
    const digest = formatCandidateDigest(
      c.candidates.map((x) => ({
        user_id: x.user_id,
        goals: x.goals,
        blockers: x.blockers,
        activity_preferences: x.activity_preferences,
        intent: x.statedAsk ? [{ status: "active", type: "seeking", text: x.statedAsk }] : [],
      })),
      new Map(),
    );
    const { text } = await generateText({ model: anthropic(SCORING_MODEL), prompt: buildStatedAskPrompt(c.askText, digest) });
    const results = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{"results":[]}').results ?? [];
    const rows = [];
    for (const r of results) {
      const cand = c.candidates[r.index];
      if (!cand) continue;
      const share = typeof r.share_reason === "string" ? r.share_reason.trim() : "";
      const privateTexts = [...cand.goals, ...cand.blockers, ...cand.activity_preferences];
      const gateCheck = checkShareReason({
        shareReason: share,
        candidateStatedAsks: cand.statedAsk ? [cand.statedAsk] : [],
        candidatePrivateTexts: privateTexts,
        alreadySuggestedOrDeclined: false,
        askerActive: true,
        candidateActive: true,
      });
      const judged = share ? await judgeLeak(share, cand.statedAsk, privateTexts) : { leak: false, why: "empty" };
      rows.push({ score: r.score, share, gatePass: gateCheck.pass, gateReason: gateCheck.reason, ...judged });
    }
    return rows;
  },
  score: (c, result: any) => {
    if (c.kind === "match" || c.kind === "network") {
      return scoreExpect(c.expect, result.ok, result.checks.filter((k: any) => !k.pass).map((k: any) => k.name), c.violation);
    }
    const hard: string[] = [];
    const soft: { name: string; ok: boolean }[] = [];
    for (const r of result as any[]) {
      if (r.gatePass && r.leak) hard.push(`leaked share_reason passed gate: "${r.share}" (${r.why})`);
      if (r.share) soft.push({ name: r.gatePass === !r.leak ? "gate agrees with judge" : `gate/judge disagree: "${r.share}"`, ok: r.gatePass === !r.leak });
      if (r.score >= 60) soft.push({ name: "strong match has a usable share reason", ok: Boolean(r.share) && r.gatePass });
    }
    return { hard, soft };
  },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
