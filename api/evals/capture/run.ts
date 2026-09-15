// Ask capture eval (profileExtraction.captureIntentPrompt), live: what
// counts as an ask. 2026-09-15: nearly every message in Royce's thread
// opened or rewrote an ask, including "your messaging seems smoother" and
// "how can your model improve", and those fed the sweep and matching.
//
//   npx tsx evals/capture/run.ts
//
// Hard: an ask captured from something that isn't one, or a real ask missed.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { loadCases, runEval, type EvalCase } from "../lib.js";
import { captureIntentPrompt } from "../../src/services/profileExtraction.js";
import { parseModelJson } from "../../src/services/modelJson.js";
import { MODELS } from "../../src/models.js";

type Case = EvalCase & { transcript: string; expectAsk: boolean };
const here = dirname(fileURLToPath(import.meta.url));

const T = (...lines: string[]) => lines.join("\n");
const thread = T(
  "user: Been looking at joining an accelerator. Maybe pre-seed accelerator.",
  "assistant: I don't have enough on where you're at to size that up.",
  "user: We are a series A company, building AI infrastructure for B2B companies. We recently landed a 35 million dollar deal on a team of 8",
  "assistant: What you're more likely to need now is Series A rooms, investors, and operators. Worth me thinking in that direction?",
);
const synthetic: Case[] = [
  { id: "c01_smoother", transcript: T(thread, "user: Your messaging seems a lot smoother"), expectAsk: false },
  { id: "c02_model_improve", transcript: T(thread, "user: How else do you think your model can be improved?"), expectAsk: false },
  { id: "c03_anything_to_ask", transcript: T(thread, "user: Anything you need to ask me?"), expectAsk: false },
  { id: "c04_new_number", transcript: T(thread, "user: I got a new number"), expectAsk: false },
  { id: "c05_answer_about_self", transcript: T(thread, "assistant: When you picture someone worth building with, what are they like?", "user: Cool, calm, collected. Urgency is important. Also someone who can see a life beyond just the computer"), expectAsk: false },
  { id: "c06_point_me", transcript: T(thread, "user: Yeah definitely, point me in the right direction"), expectAsk: true },
  { id: "c07_friends", transcript: T(thread, "user: In the mean time, I want to look for some friends"), expectAsk: true },
  { id: "c08_thanks", transcript: T(thread, "user: Cool."), expectAsk: false },
];

await runEval<Case, { ask: unknown }>({
  name: "ask capture (live)",
  dir: here,
  cases: [...loadCases<Case>(here), ...synthetic],
  concurrency: 4,
  run: async (c) => {
    const { text } = await generateText({ model: anthropic(MODELS.haiku), prompt: captureIntentPrompt(c.transcript) });
    const p = parseModelJson<{ ask: { text?: string } | null }>(text);
    return { ask: p?.ask?.text ? p.ask : null };
  },
  score: (c, r) => {
    const got = !!r.ask;
    const hard = got === c.expectAsk ? [] : [got ? `captured an ask from a non-ask: ${JSON.stringify(r.ask)}` : "missed a real ask"];
    return { hard, soft: [] };
  },
});
