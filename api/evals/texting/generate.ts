// Drafts a fresh reply to every case with whatever reply prompt this checkout
// has, so two prompts can be compared on the same real messages (dry run:
// nothing is sent, nothing is written).
//
//   npx tsx evals/texting/generate.ts <out.local.json>
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { renderCoPersonaPrompt } = await import("../../src/services/coPersona.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");

const here = new URL(".", import.meta.url).pathname;
const casesPath = process.env.TEXTING_CASES ?? `${here}cases.local.json`;
const cases: { person: string; message: string; recentConversation: string; contextSummary: string }[] = JSON.parse(readFileSync(casesPath, "utf8")).cases;
const out = process.argv[2];

async function one(c: (typeof cases)[number], id: number) {
  const personaPrompt = process.env.TEXTING_NO_PERSONA ? null : await renderCoPersonaPrompt(c.person, c.contextSummary).catch(() => null);
  const r = await runConversationReplyAgent(
    {
      userId: "00000000-0000-0000-0000-000000000000",
      phoneNumber: "+10000000000",
      firstName: c.person,
      resolvedContent: c.message,
      isVoice: false,
      imageForVision: null,
      hasPendingOffer: true,
      recentOfferBurstActive: false,
      callAction: "none",
      isThinProfileFirstMessage: false,
      isFirstContact: false,
      missingTopic: null,
      missingTopicDescription: null,
      facts: baseReplyFacts(),
      toneContext: "",
      seekingModeContext: "",
      styleHint: "",
      recentConversation: c.recentConversation,
      recentMemories: "",
      contextSummary: c.contextSummary,
      personaPrompt,
      sendCoReply: async () => true,
    },
    { dryRun: true, record: false },
  );
  return { id, reply: r.replyText };
}

const results: { id: number; reply: string }[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < cases.length) {
      const i = next++;
      try {
        results[i] = await one(cases[i], i);
      } catch (err: any) {
        results[i] = { id: i, reply: "" };
        console.error(`case ${i} failed: ${err?.message ?? err}`);
      }
    }
  }),
);
writeFileSync(out, JSON.stringify(results.filter((r) => r.reply), null, 2));
console.log(`wrote ${results.filter((r) => r.reply).length}/${cases.length} replies to ${out}`);
process.exit(0);
