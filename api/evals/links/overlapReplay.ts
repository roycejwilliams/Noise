// Replays Royce's 09-28 "Are they around the same time?" with both events'
// real page reads as facts (services/linkReader.ts). Nothing is sent.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { readPage, describeRead } = await import("../../src/services/linkReader.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addHint, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const grok = await readPage("https://lu.ma/grokbotproduct-sf");
const dayt = await readPage("https://x.com/i/status/2102773693290336381");
const runs = Number(process.argv[2] ?? 3);
for (let i = 0; i < runs; i++) {
  const f = baseReplyFacts();
  addFact(f, "known", "They live in San Francisco.");
  for (const [name, r] of [["Grok Bot x Notion for Product Builders night (SF)", grok], ["daytonaio AI Builders Demo Night", dayt]] as const) {
    const d = describeRead(name, r);
    addFact(f, "did_before", `Co sent them "${name}" today.`);
    d.facts.forEach((x) => addFact(f, "known", x));
    d.hints.forEach((x) => addHint(f, x));
  }
  const convo = "Co replied: https://lu.ma/grokbotproduct-sf\nCo replied: Short notice, but Grok Bot x Notion is throwing a product builders night in SF on Tuesday.\nCo replied: https://x.com/i/status/2102773693290336381\nCo replied: Found the SF meetup you asked about: daytonaio's AI Builders Demo Night, next Tuesday.\nUser said: I'm in [Replying to Co's text about the Grok Bot night]\nCo replied: Good. A room full of people building 0 to 1.";
  const r: any = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "Are they around the same time?", isVoice: false, imageForVision: null, hasPendingOffer: true, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: convo, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}` }));
  const g = (r.grounding ?? []).map((x: any) => x.outcome).join(",");
  console.log(`Co [${g}]: ${String(r.replyText).replace(/\n/g, " / ")}`);
  for (const x of r.grounding ?? []) if (x.outcome !== "as_drafted") console.log(`   flagged: ${x.checks.filter((c: any) => !c.pass).map((c: any) => c.reason).join(" ; ").slice(0, 500)}`);
}
