// Layer 4 eval: profile write gates (src/harness/profileWrite.ts).
//
//   npx tsx evals/profile/run.ts           # code gates only
//   npx tsx evals/profile/run.ts --live    # real embeddings + Sonnet 5 same-ask and resolution calls
//   npx tsx evals/profile/run.ts --only a03,r02
//
// Hard failures: opening a duplicate ask for a restated one, folding a
// genuinely different ask into an old one, retiring a goal/blocker/ask the
// person didn't say is done, or letting an invalid value into the profile.
import "dotenv/config";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import {
  PROFILE_JUDGMENT_MODEL,
  decideAskWrite,
  gateResolutions,
  sanitizeExtractedProfile,
  type ProposedResolution,
} from "../../src/harness/profileWrite.js";
import { buildResolutionPrompt, gateResolutionOutput, sameAskPrompt } from "../../src/services/profileExtraction.js";
import { generateEmbedding } from "../../src/services/embeddings.js";
// --live makes real model calls: only through the meter (evals/README.md).
if (process.argv.includes("--live")) await import("../lib/requireMeter.js");

type AskCase = EvalCase & { kind: "ask"; newAsk: string; openAsks: string[]; expect: { same: boolean; asAsk?: string } };
type ResolveCase = EvalCase & {
  kind: "resolve";
  transcript: string;
  goals: string[];
  blockers: string[];
  asks: string[];
  // Code mode: what a model proposed. Live mode ignores this and asks Sonnet 5.
  proposals?: ProposedResolution[];
  expect: { resolved: string[] };
};
type SanitizeCase = EvalCase & { kind: "sanitize"; raw: Record<string, unknown>; expect: Record<string, unknown> };
type Case = AskCase | ResolveCase | SanitizeCase;

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const live = args.includes("--live");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx === -1 ? undefined : args[onlyIdx + 1]?.split(",");

const embedCache = new Map<string, Promise<number[]>>();
const embed = (t: string) => {
  if (!embedCache.has(t)) embedCache.set(t, generateEmbedding(t));
  return embedCache.get(t)!;
};

type Result = { same?: boolean; matched?: string | null; path?: string; resolved?: string[]; sanitized?: Record<string, unknown> };

async function run(c: Case): Promise<Result> {
  if (c.kind === "sanitize") return { sanitized: sanitizeExtractedProfile(c.raw).profile as Record<string, unknown> };

  if (c.kind === "ask") {
    const open = await Promise.all(
      c.openAsks.map(async (text, i) => ({ askId: `ask${i}`, text, embedding: live ? await embed(text) : null })),
    );
    const d = decideAskWrite({ text: c.newAsk, embedding: live ? await embed(c.newAsk) : null }, open);
    if (d.action === "needs_judgment") {
      if (!live) return { same: false, matched: null, path: "needs_judgment(no model)" };
      const match = open.find((a) => a.askId === d.askId)!;
      const { text } = await generateText({ model: anthropic(PROFILE_JUDGMENT_MODEL), prompt: sameAskPrompt(c.newAsk, match.text) });
      const same = /"same"\s*:\s*true/.test(text);
      return { same, matched: same ? match.text : null, path: `judged ${d.similarity.toFixed(3)}` };
    }
    if (d.action === "update_existing") {
      return { same: true, matched: open.find((a) => a.askId === d.askId)!.text, path: `auto ${d.similarity.toFixed(3)}` };
    }
    return { same: false, matched: null, path: d.reason };
  }

  const asks = c.asks.map((text, i) => ({ id: `ask${i}`, text }));
  const nameOf = (p: ProposedResolution) => (p.kind === "ask" ? asks.find((a) => a.id === p.item)?.text ?? p.item : p.item);
  if (live) {
    const askListBlock = asks.length ? `\nOpen asks (numbered):\n${asks.map((a, i) => `${i}. ${a.text}`).join("\n")}\n` : "";
    const { text } = await generateText({
      model: anthropic(PROFILE_JUDGMENT_MODEL),
      prompt: buildResolutionPrompt(c.transcript, c.goals, c.blockers, askListBlock),
    });
    const g = gateResolutionOutput(text, c.transcript, c.goals, c.blockers, asks);
    return { resolved: g.accepted.map(nameOf), path: g.rejected.map((r) => `rejected ${nameOf(r.proposal)}: ${r.reason}`).join("; ") };
  }
  const proposals = (c.proposals ?? []).map((p) =>
    p.kind === "ask" ? { ...p, item: asks.find((a) => a.text === p.item)?.id ?? p.item } : p,
  );
  const g = gateResolutions(proposals, { goals: c.goals, blockers: c.blockers, asks }, c.transcript);
  return { resolved: g.accepted.map(nameOf) };
}

function score(c: Case, r: Result): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  if (c.kind === "sanitize") {
    for (const [k, v] of Object.entries(c.expect)) {
      if (JSON.stringify(r.sanitized![k] ?? null) !== JSON.stringify(v)) hard.push(`${k}: got ${JSON.stringify(r.sanitized![k])}, expected ${JSON.stringify(v)}`);
    }
    return { hard, soft };
  }
  if (c.kind === "ask") {
    if (c.expect.same && !r.same) {
      // Code mode can't see paraphrases; only a live miss is a real failure.
      if (live || normalizeEq(c)) hard.push(`opened a duplicate ask (${r.path})`);
      else soft.push({ name: "paraphrase_needs_live", ok: false });
    }
    if (!c.expect.same && r.same) hard.push(`folded a different ask into "${r.matched}" (${r.path})`);
    if (c.expect.same && r.same && c.expect.asAsk && r.matched !== c.expect.asAsk) hard.push(`merged into the wrong open ask "${r.matched}"`);
    soft.push({ name: "ask_same", ok: !!r.same === c.expect.same });
    return { hard, soft };
  }
  const got = new Set(r.resolved);
  for (const item of got) if (!c.expect.resolved.includes(item)) hard.push(`retired "${item}" without them saying it's done${r.path ? ` (${r.path})` : ""}`);
  for (const item of c.expect.resolved) soft.push({ name: "resolution_recall", ok: got.has(item) });
  if (!c.expect.resolved.length) soft.push({ name: "resolution_recall", ok: got.size === 0 });
  return { hard, soft };
}

function normalizeEq(c: AskCase): boolean {
  const n = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\b(a|an|the|some|any|to|for|i'?m|im|looking|find|me|my|please|really|just)\b/g, " ").replace(/\s+/g, " ").trim();
  return c.openAsks.some((a) => n(a) === n(c.newAsk));
}

const cases = loadCases<Case>(dir);
await runEval({ name: `profile${live ? " (live)" : ""}`, dir, cases, run, score, only, concurrency: 4 });
process.exit();
