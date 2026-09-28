// Does the read's feedback reminder get Co to save it with its tool? Dry run.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addInstruction, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const { feedbackInstruction } = await import("../../src/services/readTurn.js");
const f = baseReplyFacts();
addFact(f, "known", "Nothing they've said has been saved for the team in the last day, including this message. If this message is feedback for the team, save it with saveFeedbackForTeam; otherwise don't say anything was noted for, passed to, or sent to the team.");
addInstruction(f, feedbackInstruction(["When surfacing an event, include its date and time."])!);
const r: any = await runConversationReplyAgent(
  { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "We should find time and date for any event we surface", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
  { dryRun: true, record: false, stubSearch: true },
);
console.log("tools:", r.toolsCalled.join(","), "| reply:", r.replyText);
