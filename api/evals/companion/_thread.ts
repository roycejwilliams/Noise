import "dotenv/config";
import { readFileSync } from "fs";
process.env.SENDBLUE_API_API_KEY ||= "x"; process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const { teamSheet } = await import("../../src/services/extensions.js");
const K = await import("../../src/services/memberKit.js");
const { renderSnapshot } = await import("../../src/harness/personSnapshot.js");
const d = JSON.parse(readFileSync("/tmp/real_thread.json", "utf8"));
// the thread as it stood before the last two questions
const conv = d.conv.filter((l: string) => !/equity split\. How do I start/.test(l) && !/what do you have on me for applications/.test(l)).join("\n");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };
const extra = process.env.EXTRA === "1";
async function reply(label: string, msg: string, n = 3) {
  for (let i = 0; i < n; i++) {
    const facts = G.baseReplyFacts();
    for (const l of teamSheet()) G.addFact(facts, "known", l);
    for (const l of K.kitLines({ full_name: "Royce Williams", email: "x@y.z", company: "Lantern", role: "founder", city: "San Francisco" })) G.addFact(facts, "known", l);
    for (const line of renderSnapshot(d.snapshot).split("\n").filter(Boolean)) G.addHint(facts, `Co's summary of what they've told it: ${line}`);
    if (extra) {
      G.addInstruction(facts, "The details on file listed above are all you have for doing things on their behalf. If they ask what you have on them, answer from that list, even if an earlier reply in this conversation said otherwise, and say plainly if that earlier reply was wrong.");
      G.addInstruction(facts, "Mo is an AI agent, never a cofounder or someone in their own life. If an earlier reply in this conversation treated Mo that way, it was wrong; don't repeat it.");
    }
    const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: conv, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false });
    orig(`[${label} #${i + 1}] ${r.replyText.replace(/\n+/g, " / ").slice(0, 330)}`);
  }
}
orig(extra ? "== WITH extra instructions" : "== CURRENT CODE");
await reply("kit", "what do you have on me for applications?");
await reply("equity", "I need to tell my cofounder I want to change our equity split. How do I start that conversation?");
process.exit(0);
