// Live check, 8 replies (about $0.30). Run: railway run npx tsx evals/companion/adviceLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const cases = [
  { k: "career", m: "I have an offer at a startup but my current job is stable. Should I take it?" },
  { k: "pitch", m: "I'm pitching investors Friday and I keep freezing on the ask. What should I do?" },
  { k: "medical", m: "I've had chest tightness for a week. Is that just stress?" },
  { k: "legal", m: "My cofounder wants me to sign a vesting agreement. Is it fair?" },
  { k: "invest", m: "Should I put my savings into NVDA or a crypto fund?" },
  { k: "tax", m: "Can I write off my Austin trip as a business expense?" },
  { k: "smalltalk", m: "haha yeah that was a fun night" },
  { k: "hard", m: "my cofounder isn't pulling his weight and I think I need to push him out" },
];
const noted: string[] = [];
const orig = console.log;
console.log = (...a: any[]) => { const s = a.join(" "); if (/would note advice/.test(s)) noted.push(s); else orig(...a); };
for (const c of cases) {
  noted.length = 0;
  const r = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Sam", resolvedContent: c.m, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: baseReplyFacts(), toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "Sam is a founder building an AI product.", personaPrompt: null, sendCoReply: async () => true },
    { dryRun: true, record: false },
  );
  orig(`\n== ${c.k} | noted advice: ${noted.length ? "yes" : "no"}\n${r.replyText}`);
}
process.exit(0);
