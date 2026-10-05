// Model-free checks for how Co's texts are prompted (2026-09-24). The
// measured result lives in evals/texting (grade.ts, pairwise.ts): on 40 real
// co-test texts, blind Opus preferred this prompt over the old one 29 to 10.
//
//   npx tsx evals/texting/rules.ts
import { readFileSync } from "fs";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const reply = src("agent/conversationReply.ts");
// What shapes Co's replies: the listening summary and the reply prompt
// itself (not the yes/no classifier prompts elsewhere in the file).
const listening = reply.slice(reply.indexOf("export const TEXT_LISTENING"), reply.indexOf("`;", reply.indexOf("export const TEXT_LISTENING")));
const template = reply.slice(reply.indexOf("  const system = `You are replying"), reply.indexOf("const userText ="));
const prompt = `${listening}\n${template}`;
const sentences = prompt.replace(/\$\{[^}]*\}/g, "X").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
check("no dashes in the reply prompt (Co copies its instructions' style)", !/[—–]/.test(prompt));
check("the reply prompt is written in short sentences", sentences.filter((s) => s.split(/\s+/).length > 45).length === 0);
check("no quoted bad openers for Co to copy", !/"That's a big call\."|"That \[noun phrase\]/.test(prompt));
check("texts get how Co listens, not the full call guide", /const sharedSystem = `\$\{CO_VOICE\}\n\n\$\{MOVES_GUIDE\}\n\n\$\{TEXT_LISTENING\}\n\n\$\{MESSAGE_RHYTHM\}\n\n\$\{COACHING\}`;/.test(reply) && !/\$\{input\.personaPrompt\}/.test(reply));
check("the call guide isn't fetched from Hume on every text", !/renderCoPersonaPrompt\(/.test(src("routes/sendblue.ts")));
check("the length rule is concrete", /under about 15 words and doesn't ask for a plan or detail, reply in one or two sentences/.test(reply));
check("say each thing once", /Say each thing once\. Don't repeat a point, an offer or a question from your last message\./.test(reply));

check("the reply starts with Co's own answer or reaction", /Always respond genuinely to what they said first: start with your answer or your own reaction, in your own words\./.test(reply));
check("the length line is said last, right before Co writes", /const userText = lengthLine \? `\$\{baseUserText\} \$\{lengthLine\}` : baseUserText;/.test(reply));
check("no test switches or example block left in", !/process\.env\.CO_TEXT_|SHORT_EXAMPLES/.test(reply));
{
  process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
  process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
  process.env.OPENAI_API_KEY ||= "unused-in-tests";
  const { replyLengthLine } = await import("../../src/agent/conversationReply.js");
  check("length line: a short message gets it", replyLengthLine("we still can't find a venue") === "Their message was 6 words and doesn't ask for detail. Reply in one or two sentences.");
  check("length line: a request for detail doesn't", replyLengthLine("can you walk me through the plan?") === null && replyLengthLine("take the lead on this") === null);
  check("length line: a long message doesn't", replyLengthLine("so here is the thing, we had the permit lined up for the street and then the city came back and said no") === null);
}
console.log(`texting rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
