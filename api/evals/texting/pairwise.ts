// Head-to-head, blind: for each real case, Opus sees two replies in random
// order and picks the one that reads more like a thoughtful person texting
// on a phone. More sensitive than absolute scores, whose run-to-run swing on
// 40 cases is about as big as the differences between prompts.
//
//   npx tsx evals/texting/pairwise.ts <a.local.json> <b.local.json>
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync } from "fs";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { parseModelJson } from "../../src/services/modelJson.js";
import { CRITERIA, GRADER_MODEL, type TextCase } from "./grade.js";
import { GRADER_HEADERS } from "../../src/models.js";

const here = new URL(".", import.meta.url).pathname;
const cases: TextCase[] = JSON.parse(readFileSync(`${here}cases.local.json`, "utf8")).cases;
const [aPath, bPath] = process.argv.slice(2);
const a = new Map<number, string>(JSON.parse(readFileSync(aPath, "utf8")).map((r: any) => [r.id, r.reply]));
const b = new Map<number, string>(JSON.parse(readFileSync(bPath, "utf8")).map((r: any) => [r.id, r.reply]));

async function judge(c: TextCase, first: string, second: string): Promise<"1" | "2" | "tie"> {
  const { text } = await generateText({
    model: anthropic(GRADER_MODEL),
    headers: GRADER_HEADERS,
    prompt: `Two possible replies from Co, an AI companion that texts members of a private club over iMessage. Pick the one that reads more like a thoughtful real person texting on a phone, judged on:
${Object.values(CRITERIA).map((v) => `- ${v}`).join("\n")}

What Co knew about them: ${c.contextSummary.slice(0, 2000) || "(nothing)"}

The conversation so far:
${c.recentConversation.slice(-2500)}

What they just sent: "${c.message}"

Reply 1: "${first}"

Reply 2: "${second}"

Return ONLY JSON: {"better": "1" | "2" | "tie"}`,
  });
  const v = String(parseModelJson<{ better?: string }>(text).better ?? "tie");
  return v === "1" || v === "2" ? v : "tie";
}

let aWins = 0, bWins = 0, ties = 0;
const ids = [...a.keys()].filter((id) => b.has(id));
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const aFirst = Math.random() < 0.5; // blind: order is random per case
      const v = await judge(cases[id], aFirst ? a.get(id)! : b.get(id)!, aFirst ? b.get(id)! : a.get(id)!).catch(() => "tie" as const);
      if (v === "tie") ties++;
      else if ((v === "1") === aFirst) aWins++;
      else bWins++;
    }
  }),
);
const name = (p: string) => p.split("/").pop()!.replace(".local.json", "");
console.log(`${name(aPath)} ${aWins}  vs  ${name(bPath)} ${bWins}  (ties ${ties}, ${ids.length} cases)`);
process.exit(0);
