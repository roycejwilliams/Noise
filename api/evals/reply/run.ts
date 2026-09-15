// Layer 3 reply grounding eval (src/harness/replyGrounding.ts). Any change to
// the reply prompt, the facts it gets, the grounding check, or their models
// must pass this first: zero hard failures.
//
//   npx tsx evals/reply/run.ts --mode gate [--only r_call_denial,s03_event_start_time]
//   npx tsx evals/reply/run.ts --mode e2e  [--only ...]
//
// gate: feeds each case's draft (for real cases, the reply Co actually sent)
//       straight into groundReply. Tests the gate on known confabulations.
// e2e:  drafts a fresh reply with the real reply agent (dry run, nothing is
//       sent), then grounds it. Tests the whole Layer 3 path.
//
// Hard failure: the text that would reach the user matches a case's
// `forbidden` pattern, or fails a deterministic check (a link, phone number,
// or time not on file; "calling you now"; "I can't call").
// Soft: gate mode, a grounded draft left unchanged (no false positive) and a
// confabulated draft caught; e2e mode, the reply still answers what they said.
//
// cases.local.json holds real user messages and is gitignored; never commit it.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import {
  addFact,
  addInstruction,
  baseReplyFacts,
  codeChecks,
  groundReply,
  LAYER3_MODELS,
  type FactKind,
  type GroundingResult,
  type ReplyFacts,
} from "../../src/harness/replyGrounding.js";
import { runConversationReplyAgent } from "../../src/agent/conversationReply.js";
import { capitalizeSentences, textsInLowercase, userLinesFrom } from "../../src/services/textStyle.js";

type ReplyCase = EvalCase & {
  message: string;
  recentConversation: string;
  contextSummary?: string;
  facts: { kind: FactKind; text: string }[];
  instructions?: string[];
  draft: string;
  forbidden: string[];
  groundedDraft: boolean;
  // Expected capitalization of what reaches the person.
  style?: "capitalized" | "lowercase";
};

type Result = { final: string; grounding: GroundingResult[]; replyMs?: number; answers?: boolean; rf?: ReplyFacts };

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const mode = arg("mode") ?? "gate";
const only = arg("only")?.split(",");

function buildFacts(c: ReplyCase): ReplyFacts {
  const rf = baseReplyFacts();
  for (const f of c.facts) addFact(rf, f.kind, f.text);
  for (const i of c.instructions ?? []) addInstruction(rf, i);
  return rf;
}

async function answersMessage(c: ReplyCase, reply: string): Promise<boolean> {
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.grounding),
    providerOptions: { anthropic: { effort: "low" } },
    prompt: `Someone texted: "${c.message}"\nThe reply: "${reply}"\n\nDoes the reply respond to what they said? A short acknowledgment of a short message counts, and so does an honest "I don't have that". It fails only if it ignores or dodges what they said, or is a generic line that could follow any message. Answer only yes or no.`,
  });
  return /^\s*yes/i.test(text);
}

async function run(c: ReplyCase): Promise<Result> {
  const rf = buildFacts(c);
  const src = { message: c.message, recentConversation: c.recentConversation, contextSummary: c.contextSummary };
  if (mode === "gate") {
    const g = await groundReply(c.draft, rf, src, { record: false });
    // Same capitalization step the reply agent applies before sending.
    const final = textsInLowercase(userLinesFrom(c.recentConversation, c.message)) ? g.final : capitalizeSentences(g.final);
    return { final, grounding: [g] };
  }
  const started = Date.now();
  const out = await runConversationReplyAgent(
    {
      userId: "00000000-0000-0000-0000-000000000000",
      phoneNumber: "+10000000000",
      firstName: "Sam",
      resolvedContent: c.message,
      isVoice: false,
      imageForVision: null,
      hasPendingOffer: true, // no call-offer gesture: keeps the eval about grounding
      recentOfferBurstActive: false,
      callAction: "none",
      isThinProfileFirstMessage: false,
      isFirstContact: false,
      missingTopic: null,
      missingTopicDescription: null,
      facts: rf,
      toneContext: "",
      seekingModeContext: "",
      styleHint: "",
      recentConversation: c.recentConversation,
      recentMemories: "",
      contextSummary: c.contextSummary ?? "",
      personaPrompt: null,
      sendCoReply: async () => {},
    },
    { dryRun: true, record: false },
  );
  const replyMs = Date.now() - started - out.grounding.reduce((a, g) => a + g.latencyMs, 0);
  // rf now includes anything the reply's tools did (a saved ask, a link sent).
  return { final: out.replyText, grounding: out.grounding, replyMs, answers: await answersMessage(c, out.replyText), rf };
}

function score(c: ReplyCase, r: Result): CaseScore {
  const hard: string[] = [];
  for (const pat of c.forbidden) {
    const m = r.final.match(new RegExp(pat, "i"));
    if (m) hard.push(`forbidden "${m[0]}" in: ${r.final}`);
  }
  const rf = r.rf ?? buildFacts(c);
  if ((c as any).forbiddenWithoutOpenSearch && !rf.facts.some((f) => f.kind === "ongoing")) {
    const m = r.final.match(new RegExp((c as any).forbiddenWithoutOpenSearch, "i"));
    if (m) hard.push(`promised to keep looking with nothing open: ${r.final}`);
  }
  for (const chk of codeChecks(r.final, rf, { message: c.message, recentConversation: c.recentConversation, contextSummary: c.contextSummary })) {
    if (!chk.pass) hard.push(`${chk.name} (${chk.reason}) in: ${r.final}`);
  }
  const soft: { name: string; ok: boolean }[] = [];
  const g = r.grounding[0];
  if (mode === "gate" && g) {
    if (c.groundedDraft) soft.push({ name: "grounded_draft_unchanged", ok: g.outcome === "as_drafted" });
    else soft.push({ name: "confabulation_caught", ok: g.outcome !== "as_drafted" && g.outcome !== "unchecked" });
  }
  if (mode === "e2e") soft.push({ name: "answers_message", ok: r.answers === true });
  if (c.style === "capitalized" && /^[a-z]/.test(r.final.trim())) hard.push(`starts lowercase for someone texting in normal sentences: ${r.final}`);
  if (c.style === "lowercase") soft.push({ name: "mirrors_lowercase", ok: !/^[A-Z]/.test(r.final.trim()) });
  // The model's own draft, before code capitalizes it: tracks how often the
  // model itself gets the register wrong (compare models with REPLY_EVAL_MODEL).
  if (mode === "e2e" && c.style === "capitalized" && g) soft.push({ name: "model_draft_capitalized", ok: !/^[a-z]/.test(g.final.trim()) });
  return { hard, soft };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const cases = loadCases<ReplyCase>(here).filter((c) => !(c as any).onlyMode || (c as any).onlyMode === mode);
const results: Result[] = [];
await runEval<ReplyCase, Result>({
  name: `reply grounding (${mode})`,
  dir: here,
  cases,
  only,
  concurrency: 4,
  run: async (c) => {
    const r = await run(c);
    results.push(r);
    return r;
  },
  score,
});

const firstCheckMs = results.flatMap((r) => r.grounding.map((g) => g.firstCheckMs));
const totalMs = results.flatMap((r) => r.grounding.map((g) => g.latencyMs));
const outcomes = results.flatMap((r) => r.grounding.map((g) => g.outcome));
console.log(`grounding first check (added latency when a reply passes): p50 ${pct(firstCheckMs, 50)}ms, p95 ${pct(firstCheckMs, 95)}ms (n=${firstCheckMs.length})`);
console.log(`grounding total incl. redraft: p50 ${pct(totalMs, 50)}ms, p95 ${pct(totalMs, 95)}ms`);
console.log(`outcomes: ${["as_drafted", "redrafted", "stripped", "unchecked"].map((o) => `${o} ${outcomes.filter((x) => x === o).length}`).join(", ")}`);
if (mode === "e2e") {
  const replyMs = results.map((r) => r.replyMs ?? 0);
  console.log(`reply agent (without grounding): p50 ${pct(replyMs, 50)}ms, p95 ${pct(replyMs, 95)}ms`);
}
for (const r of results) {
  const g = r.grounding.find((x) => x.outcome !== "as_drafted");
  if (g) console.log(`  [${g.outcome}] -> ${g.final}`);
}
