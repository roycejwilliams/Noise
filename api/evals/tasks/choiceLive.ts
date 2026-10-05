// Does Co take on a task when the ask needs days, and not otherwise? Dry: nothing
// is sent or written. 8 replies (~$0.25).
//   railway run npx tsx evals/tasks/choiceLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };
const cases: [string, boolean][] = [
  ["Can you find me a venue in SF for about 60 people for my Oct 10 block party? I need options by Friday.", true],
  ["I want to line up 3 sponsors for the block party over the next two weeks, can you help me work on that?", true],
  ["Help me get ready for my investor pitch on Friday, check in with me before then", true],
  ["Can you keep working on finding me a cofounder-type designer and update me as you go?", true],
  ["What's on tonight in SF?", false],
  ["thanks!", false],
  ["What do you think of my pitch opener: we help founders meet in the room?", false],
  ["Remind me what you sent me yesterday", false],
];
let right = 0;
for (const [msg, want] of cases) {
  const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Sam", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: G.baseReplyFacts(), toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "Sam is a founder in San Francisco building a community startup, hosting a block party Oct 10.", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false, stubSearch: true } as any);
  const started = (r.toolsCalled ?? []).includes("startTask");
  if (started === want) right++;
  orig(`${started === want ? "ok  " : "BAD "} task=${started} | "${msg.slice(0, 60)}"\n      -> ${r.replyText.replace(/\n+/g, " / ").slice(0, 260)}`);
}
orig(`task choice: ${right}/${cases.length} right`);
process.exit(0);
