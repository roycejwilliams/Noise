// Which cases truly call for a short reply (2026-09-24: many "short"
// messages sat inside planning threads where Royce had asked Co to lead, so
// a longer reply was right). Opus labels each case once; the labels are
// saved into cases.local.json as wantsShort.
//
//   npx tsx evals/texting/tagShort.ts
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { parseModelJson } from "../../src/services/modelJson.js";
import { GRADER_MODEL } from "./grade.js";
import { GRADER_HEADERS } from "../../src/models.js";

const path = new URL("./cases.local.json", import.meta.url).pathname;
const data = JSON.parse(readFileSync(path, "utf8"));
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < data.cases.length) {
      const c = data.cases[next++];
      const { text } = await generateText({
        model: anthropic(GRADER_MODEL),
        headers: GRADER_HEADERS,
        prompt: `A member is texting Cue, an AI companion. Decide what length of reply their latest text calls for, given the conversation.

"short": a quick reply of one or two sentences is right (a reaction, a quick question, small talk, a confirmation, a correction, logistics).
"depth": a longer reply is right, because they asked for a plan, advice, detail, a walkthrough or for Cue to lead, or they're mid-way through something where Cue was asked to lay out the full answer, or they shared something heavy that deserves real room.

The conversation so far:
${c.recentConversation.slice(-2500)}

Their latest text: "${c.message}"

Return ONLY JSON: {"length": "short" | "depth", "why": "a few words"}`,
      });
      const r = parseModelJson<{ length?: string; why?: string }>(text);
      c.wantsShort = r.length === "short";
      c.lengthWhy = String(r.why ?? "").slice(0, 120);
    }
  }),
);
writeFileSync(path, JSON.stringify(data, null, 2));
const short = data.cases.filter((c: any) => c.wantsShort);
console.log(`${short.length} of ${data.cases.length} call for a short reply`);
for (const c of data.cases) console.log(`${c.wantsShort ? "SHORT" : "depth"}  ${String(c.message.split(/\s+/).length).padStart(3)}w  ${c.lengthWhy}`);
process.exit(0);
