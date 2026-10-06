// Live check of the merged turn read (services/turnLearning.ts) on real
// co-test turns, exported to a JSON file (turns, profile, open asks) by psql.
// Runs only the model call and parse; writes nothing.
//
//   npx tsx evals/turnLearning/live.ts <file>
import "../lib/requireMeter.js";
import { readFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
const { turnLearningPrompt, parseTurnLearning } = await import("../../src/services/turnLearning.js");
const { PROFILE_JUDGMENT_MODEL, mightBeCorrection } = await import("../../src/harness/profileWrite.js");
const { lastCoLine } = await import("../../src/services/conversationClose.js");
const [turnsLine, profileLine, asksLine] = readFileSync(process.argv[2], "utf8").trim().split("\n");
const turns = JSON.parse(turnsLine);
const onFile = JSON.parse(profileLine);
const openAsks = JSON.parse(asksLine ?? "[]") ?? [];
let inTok = 0, outTok = 0;
for (const t of turns) {
  const transcript = `${t.history}\nuser: ${t.message}\nassistant: ${t.reply ?? ""}`.trim();
  const r = await generateText({
    model: anthropic(PROFILE_JUDGMENT_MODEL),
    maxOutputTokens: 2500,
    prompt: turnLearningPrompt({ transcript, message: t.message, today: String(t.at).slice(0, 10), onFile, openAsks, styleNotes: [], coSaidBefore: lastCoLine(t.history) }),
  });
  inTok += r.usage?.inputTokens ?? 0;
  outTok += r.usage?.outputTokens ?? 0;
  const L = parseTurnLearning(r.text);
  console.log(`\n== ${String(t.at).slice(11, 16)} "${String(t.message).slice(0, 70)}"`);
  if (!L) { console.log("  PARSE FAILED"); continue; }
  const p: any = L.profile;
  console.log(`  profile: city=${p.city || "-"} state=${p.emotional_state || "-"} goals+=${JSON.stringify(p.goals ?? []).slice(0, 160)}`);
  console.log(`  resolved: ${JSON.stringify(L.resolved).slice(0, 200)}`);
  console.log(`  corrections: ${mightBeCorrection(t.message) ? JSON.stringify(L.corrections).slice(0, 200) : "(pre-filter: not a correction)"}`);
  console.log(`  cadence: ${L.cadence} | intent asks: ${JSON.stringify(L.intent?.asks ?? [])} | wants: ${JSON.stringify(L.intent?.wants ?? [])}`);
  console.log(`  planned_event: ${JSON.stringify(L.planned_event)}`);
  console.log(`  style: ${JSON.stringify(L.style)}`);
}
console.log(`\ntokens in ${inTok}, out ${outTok}`);
