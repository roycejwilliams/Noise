// Live check of the one picture per turn (services/turnContext.ts) on a
// member's real sends, exported from co-test (the DB isn't reachable from a
// laptop): the Grok Bot night's Luma start time is on file, daytonaio's time
// comes from the Luma page its X post links to (or is said to be missing),
// Co's reaction tool finds a first offer, and a reply to "are they around
// the same time?" answers from the details. Nothing is sent.
//
//   CONTEXT_SENT=/path/sent.json railway run --service co-test --environment dev -- npx tsx evals/context/live.ts [runs]
import "../lib/requireMeter.js";
import { readFileSync } from "fs";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const T = await import("../../src/services/turnContext.js");
const data = JSON.parse(readFileSync(process.env.CONTEXT_SENT!, "utf8"));
const sent = T.mergeSent(data.revealed ?? [], data.offers ?? [], []);
// The export is hours old; treat its sends as just now so the recent window applies.
for (const s of sent.slice(0, 5)) s.sentAt = new Date();
await T.fillDetails(sent);
const lines = T.sentDetailLines({ sent });
for (const l of lines) console.log("fact:", l.slice(0, 200));
const grok = lines.find((l) => /Grok Bot/.test(l)) ?? "";
console.log(/5:00 PM/.test(grok) ? "ok   Grok start time on file" : "MISS Grok start time");
const dayt = lines.find((l) => /daytonaio/i.test(l)) ?? "";
console.log(/starts|no start time/.test(dayt) ? `ok   daytonaio: ${/starts/.test(dayt) ? "time found via Luma" : "said to be missing"}` : "MISS daytonaio");
const found = T.findSent(sent, "daytonaio AI Builders Demo Night");
console.log(found ? `ok   noteReaction finds the first offer under key ${found.key}` : "MISS noteReaction lookup");

const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const runs = Number(process.argv[2] ?? 1);
for (let i = 0; i < runs; i++) {
  const f = baseReplyFacts();
  addFact(f, "known", "They live in San Francisco.");
  for (const l of lines) addFact(f, "known", l);
  const convo = ["Co replied: https://lu.ma/grokbotproduct-sf", "Co replied: Short notice, but Grok Bot x Notion is throwing a product builders night in SF on Tuesday the 29th.", "Co replied: https://x.com/i/status/2102773693290336381", "Co replied: Found the SF meetup you asked about: daytonaio's AI Builders Demo Night, next Tuesday Sept 29 at WorkOS SF.", "User said: I'm in", "Co replied: Good. Should be a solid room of people building."].join("\n");
  const r: any = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "Are they around the same time?", isVoice: false, imageForVision: null, hasPendingOffer: true, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: convo, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}` }));
  const text = String(r.replyText);
  const knowsGrok = /5(:00)?\s?(pm|PM)/.test(text);
  const noFalseMissing = !/no start time listed|don'?t have (exact )?start times? (on file )?for either|on you/i.test(text);
  console.log(`${knowsGrok && noFalseMissing ? "ok  " : "MISS"} reply: ${text.replace(/\n/g, " / ")}`);
}
