// Does Co write its own line while it searches? The search is faked; nothing is sent.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { baseReplyFacts, addFact } = await import("../../src/harness/replyGrounding.js");
for (const msg of ["any founder dinners this weekend?", "find me a run club in oakland", "what's happening in sf for tech week?"]) {
  let line: string | null | undefined;
  const f = baseReplyFacts();
  addFact(f, "known", "They live in San Francisco.");
  await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Noor", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true,
      searchAndSend: async (_what: string, whileLooking?: string | null) => { line = whileLooking; return { answered: false, sentCount: 0, briefing: "Nothing solid came up." }; } } as any,
    { dryRun: true, record: false, stubSearch: false },
  ).catch((e: any) => console.log("ERR", e?.message));
  console.log(`${JSON.stringify(msg)} -> while looking: ${line === undefined ? "(no search)" : JSON.stringify(line)}`);
}
