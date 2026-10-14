// Weekly review, local (Royce, 2026-09-15: "pull the week's conversations,
// turn every bad moment into an eval case, and fix only what the evals show").
//
//   npm run weekly-review            (points at whatever DATABASE_URL is loaded)
//
// Writes evals/review/<date>.local.json (gitignored): each flagged moment with
// the conversation around it and a suggested eval case. Triage them into the
// right evals/<layer>/cases.local.json, then fix what the evals show.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { gatherWeekMoments } from "../harness/monitor.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";

async function main() {
  const moments = await gatherWeekMoments(Number(process.argv[2] ?? 7));
  const out = [];
  for (const m of moments) {
    let suggestion: unknown = null;
    try {
      const { text } = await generateText({
        model: anthropic(MODELS.sonnet),
        providerOptions: { anthropic: { effort: "low" } },
        prompt: `A Cue decision was flagged: ${m.decision} ${m.action ?? ""} (${m.reason ?? ""}).\nConversation around it:\n${m.around.join("\n")}\n\nWhat went wrong for the person, in one sentence, and which eval should cover it (reply, router, proactive, matching, intro, emotion, capture, details, voice)? Suggest the eval case: the message, the recent conversation, and what must never reach the person.\nReturn ONLY JSON: {"whatWentWrong": "...", "eval": "...", "case": {"message": "...", "recentConversation": "...", "forbidden": ["regex"]}}`,
      });
      suggestion = parseModelJson(text);
    } catch {
      suggestion = null;
    }
    out.push({ ...m, suggestion });
  }
  mkdirSync("evals/review", { recursive: true });
  const file = `evals/review/${new Date().toISOString().slice(0, 10)}.local.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`weekly review: ${moments.length} moments -> ${file}`);
  // Whether matching at events Co doesn't run is paying off (2026-09-23).
  const { outsideEventOverlapStats } = await import("../services/eventMatching.js");
  const o = await outsideEventOverlapStats(30).catch(() => null);
  if (o) console.log(`outside events, last 30 days: ${o.eventsWithOverlap} with 2+ members going, ${o.headsUps} heads-ups sent, ${o.bothSaidYes} pairs both said yes`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
