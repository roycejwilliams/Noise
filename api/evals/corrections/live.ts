// Live check of the correction prompt + gate (Sonnet 5, about $0.05 a run).
// Made-up member; nothing is written.
//
//   railway run --service co-test --environment dev -- npx tsx evals/corrections/live.ts
import "../lib/requireMeter.js";
import "dotenv/config";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { buildCorrectionPrompt } from "../../src/services/profileExtraction.js";
import { gateCorrections, mightBeCorrection, PROFILE_JUDGMENT_MODEL, type OnFile } from "../../src/harness/profileWrite.js";
import { parseModelJson } from "../../src/services/modelJson.js";

const onFile: OnFile = {
  city: "San Francisco",
  life_chapters: ["founder building a startup", "new to the city"],
  goals: ["find a cofounder", "run a half marathon"],
  blockers: ["doesn't know many people in SF"],
  activity_preferences: ["running", "live music"],
  availability_pattern: "weeknights after 7",
};
const context = "Co replied: How's the cofounder search going?\nUser said: slowly lol";

// [what they said, the corrections that should come out as field:old, and
// any that are also acceptable]
const cases: [string, string[], string[]?][] = [
  ["haha no I'm not a founder, I'm a product designer at a startup", ["life_chapters:founder building a startup"]],
  ["oh I actually moved to Oakland last month", ["city:San Francisco"]],
  ["I don't really run anymore, my knee is shot", ["activity_preferences:running"], ["goals:run a half marathon"]],
  ["weeknights are tough now, weekends are better for me", ["availability_pattern:weeknights after 7"]],
  ["just finished the half marathon!!", []], // achieved, not a correction
  ["went to a great show at the fillmore last night", []], // new detail
  ["no worries, thursday works", []], // "no" but nothing corrected
  ["not sure yet, still thinking about it", []],
];

let right = 0;
for (const [said, want, alsoOk = []] of cases) {
  let got: string[] = [];
  if (mightBeCorrection(said)) {
    const { text } = await generateText({ model: anthropic(PROFILE_JUDGMENT_MODEL), prompt: buildCorrectionPrompt(onFile, said, context) });
    const parsed = parseModelJson(text.trim());
    const g = gateCorrections(parsed.corrections ?? [], onFile, said);
    got = g.accepted.map((c) => `${c.field}:${c.old}`);
    for (const r of g.rejected) console.log(`    rejected ${r.proposal.field}: ${r.reason}`);
  }
  const ok = want.every((w) => got.includes(w)) && got.every((x) => want.includes(x) || alsoOk.includes(x));
  if (ok) right++;
  console.log(`${ok ? "ok  " : "MISS"} "${said}" -> ${got.length ? got.join(", ") : "none"}`);
}
console.log(`\ncorrections live: ${right}/${cases.length}`);
process.exit(right === cases.length ? 0 : 1);
