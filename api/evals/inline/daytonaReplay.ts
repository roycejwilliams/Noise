// Replays Royce's 09-28 "I'm in" under the daytonaio X link through the reply
// agent (with the fact check), to confirm Co no longer turns @llama_index into
// "the llama_index people" or says "that's your crowd". Nothing is sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/inline/daytonaReplay.ts [runs]
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addInstruction, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const { dotsInstruction, findDots } = await import("../../src/services/connectDots.js");
const caption = "Found the SF meetup you asked about: daytonaio's AI Builders Demo Night, next Tuesday Sept 29 at WorkOS SF, with llama_index. It's demos, conversations, and networking with the AI builder community.";
const post = "Excited for next Tuesday, Sept 29, and our monthly @daytonaio AI Builders Demo Night in SF! We're hosting at @WorkOS SF Office in partnership with @llama_index. Join us for an evening of great demos, conversations, and networking with the AI builder community.";
const bad = /llama_?index people|your crowd|your people|their people|your kind of people/i;
const runs = Number(process.argv[2] ?? 3);
let ok = 0;
for (let i = 0; i < runs; i++) {
  const f = baseReplyFacts();
  addFact(f, "known", "They live in San Francisco.");
  addFact(f, "did_before", `Co sent them https://x.com/i/status/2102773693290336381 with: "${caption}" The post it came from: "${post}"`);
  addFact(f, "known", `They pressed Reply on this earlier text from Co (iMessage inline reply), so their message is about it: "https://x.com/i/status/2102773693290336381" (that's the link Co sent for: ${caption}).`);
  const dots = await findDots({
    now: `They just texted Co: "I'm in" [Replying to Co's text: "https://x.com/i/status/2102773693290336381" (${caption})]`,
    asks: ["Looking for a builder/founder community with people into design or experience building products 0 -> 1", "Seeking genuine friendships with dependable, intelligent people who want to work and build together", "Find sponsors for the event"],
    threads: [{ text: "considering taking a break from building the product, feeling his worth is tied to output", feeling: "burned out (medium)" }],
    offersThisWeek: 7,
  });
  const note = dotsInstruction(dots);
  if (note) addInstruction(f, note);
  const r: any = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "I'm in", isVoice: false, imageForVision: null, hasPendingOffer: true, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: `Co replied: https://x.com/i/status/2102773693290336381\nCo replied: ${caption}`, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}` }));
  const text = String(r.replyText);
  const pass = !bad.test(text);
  if (pass) ok++;
  console.log(`${pass ? "ok  " : "MISS"} Co: ${text.replace(/\n/g, " / ")}`);
}
console.log(`no handle-as-people, no "your crowd": ${ok}/${runs}`);
