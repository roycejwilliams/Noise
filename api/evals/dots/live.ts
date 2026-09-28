// Live check of connecting the dots (services/connectDots.ts) on Royce's own
// 09-28 asks and threads. Real models, no DB, nothing sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/dots/live.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { findDots, dotsInstruction } = await import("../../src/services/connectDots.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addInstruction, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const known = {
  asks: [
    "Find sponsors for the event",
    "Seeking genuine friendships with dependable, intelligent people who want to work and build together",
    "Looking for a builder/founder community with people into design or experience building products 0 -> 1",
    "Research founder, tech, design, and product communities in San Francisco for event outreach",
    "Looking for event recommendations during tech week (Oct 5-12)",
  ],
  threads: [
    { text: "looking for a dependable friend to go through the founder journey with", feeling: "contentment (medium)" },
    { text: "deciding whether to pursue an accelerator or get in touch with VCs", feeling: "avoidant (medium)" },
    { text: "considering taking a break from building the product, feeling his worth is tied to output", feeling: "burned out (medium)" },
  ],
  offersThisWeek: 7,
};
const grok = 'Short notice, but Grok Bot x Notion is throwing a product builders night in SF on Tuesday, Sep 29.';
const cases = [
  { name: "I'm in under the Grok link", now: `They just texted Co: "I'm in" [Replying to Co's text: "https://lu.ma/grokbotproduct-sf" (${grok})]`, expect: /builder|0.?to.?1|0 -> 1|sponsor|friend|outreach/i, reply: true },
  { name: "asks for more events while burned out", now: 'They just texted Co: "any events this week?"', expect: /break|burn|output|pace|low.?pressure|rest/i, reply: true },
  { name: "offering an investor breakfast", now: 'Co is about to offer them: Pre-seed founders x investors breakfast, SF, Oct 2 (it came up for their ask: "Looking for event recommendations during tech week")', expect: /accelerator|VC|investor/i, reply: false },
  { name: "control: thanks", now: 'They just texted Co: "thanks!"', expect: null, reply: false },
];
for (const c of cases) {
  const dots = await findDots({ ...known, now: c.now });
  const ok = c.expect ? dots.some((d) => c.expect!.test(`${d.link} ${d.why}`)) : dots.length === 0;
  console.log(`${ok ? "ok  " : "MISS"} ${c.name}: ${dots.map((d) => `[${d.kind}] ${d.link}`).join(" / ") || "(none)"}`);
  if (c.reply) {
    const f = baseReplyFacts();
    addFact(f, "did_before", `Co sent them https://lu.ma/grokbotproduct-sf with: "${grok}"`);
    addFact(f, "known", "They live in San Francisco.");
    const note = dotsInstruction(dots);
    if (note) addInstruction(f, note);
    const msg = c.name.startsWith("I'm in") ? "I'm in" : "any events this week?";
    if (msg === "I'm in") addFact(f, "known", `They pressed Reply on this earlier text from Co (iMessage inline reply), so their message is about it: "https://lu.ma/grokbotproduct-sf" (that's the link Co sent for: ${grok}).`);
    const r: any = await runConversationReplyAgent(
      { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: true, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
      { dryRun: true, record: false, stubSearch: true },
    ).catch((e: any) => ({ replyText: `ERROR ${e?.message}` }));
    console.log(`     Co: ${String(r.replyText).replace(/\n/g, " / ").slice(0, 300)}`);
  }
}
