// Drafts a fresh reply to every case with whatever reply prompt this checkout
// has, so two prompts can be compared on the same real messages (dry run:
// nothing is sent, nothing is written).
//
//   npx tsx evals/texting/generate.ts <out.local.json>
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { renderCoPersonaPrompt } = await import("../../src/services/coPersona.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");

const here = new URL(".", import.meta.url).pathname;
const casesPath = process.env.TEXTING_CASES ?? `${here}cases.local.json`;
const { momentInstruction } = await import("../../src/services/connectDots.js");
const { addInstruction } = await import("../../src/harness/replyGrounding.js");
// mode/pushback (optional): the turn's moment read, as the text route hands it over (routes/sendblue.ts), so a case can exercise the
// sharing and feedback guidance (services/connectDots.ts) and the reply check's share rewrite. A case without them runs as before.
const cases: { person: string; message: string; recentConversation: string; contextSummary: string; mode?: string; topic?: string; pushback?: string | null }[] = JSON.parse(readFileSync(casesPath, "utf8")).cases;
function factsFor(c: (typeof cases)[number]) {
  const f = baseReplyFacts();
  if (!c.mode) return f;
  Object.assign(f, { moment: c.mode }); // read by the reply check's share rewrite (fix/grounding-cut-keeps-reply-whole); ignored before it
  const note = momentInstruction({ mode: c.mode as any, topic: c.topic ?? "", pushback: c.pushback ?? null, lesson: null, dots: [] });
  if (note) addInstruction(f, note);
  return f;
}
const out = process.argv[2];

async function one(c: (typeof cases)[number], id: number) {
  const t0 = Date.now();
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
      facts: factsFor(c),
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
  return { id, reply: r.replyText, ms: Date.now() - t0 };
}

const results: { id: number; reply: string; ms?: number }[] = new Array(cases.length);
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
const times = results.filter((r) => r.reply && r.ms).map((r) => r.ms!).sort((x, y) => x - y);
console.log(`wrote ${results.filter((r) => r.reply).length}/${cases.length} replies to ${out}; median ${times[Math.floor(times.length / 2)]}ms, p90 ${times[Math.floor(times.length * 0.9)]}ms`);
process.exit(0);
