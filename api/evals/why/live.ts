// Live check: every link ties back to their why (services/coVoice.ts CO_WHY),
// as a possibility in their terms, never a promised outcome. Royce's real
// asks and threads. Real models, no DB, nothing sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/why/live.ts [runs]
import "../lib/requireMeter.js";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addInstruction, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const { whyContext } = await import("../../src/services/connectDots.js");
const { draftEventReveal } = await import("../../src/agent/eventDiscoverySurfacing.js");
const { CO_WHY } = await import("../../src/services/coVoice.js");
const known = {
  asks: ["Looking for a builder/founder community with people into design or experience building products 0 -> 1", "Seeking genuine friendships with dependable, intelligent people who want to work and build together", "Find sponsors for the event"],
  threads: [{ text: "looking for a dependable friend to go through the founder journey with", feeling: null }, { text: "deciding whether to pursue an accelerator or get in touch with VCs", feeling: null }],
};
const why = whyContext(known);
const ties = /builder|0.?to.?1|0 -> 1|founder|friend|community|sponsor|build/i;
const promise = /you'?ll (find|meet|get|land)|you will (find|meet)|guarantee|definitely (find|meet)/i;
const caption = "Found the SF meetup you asked about: daytonaio's AI Builders Demo Night, next Tuesday Sept 29 at WorkOS SF, in partnership with @llama_index. Demos, conversations, and networking with the AI builder community.";
const runs = Number(process.argv[2] ?? 2);
let ok = 0, total = 0;
for (let i = 0; i < runs; i++) {
  const f = baseReplyFacts();
  addFact(f, "known", "They live in San Francisco.");
  addFact(f, "did_before", `Co sent them https://x.com/i/status/2102773693290336381 with: "${caption}"`);
  addFact(f, "known", `They pressed Reply on this earlier text from Co (iMessage inline reply), so their message is about it: "https://x.com/i/status/2102773693290336381" (that's the link Co sent for: ${caption}).`);
  addInstruction(f, `They're reacting to something Co sent them. ${CO_WHY} ${why}`);
  const r: any = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "I'm in", isVoice: false, imageForVision: null, hasPendingOffer: true, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: `Co replied: https://x.com/i/status/2102773693290336381\nCo replied: ${caption}`, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}` }));
  const reply = String(r.replyText);
  total++;
  if (ties.test(reply) && !promise.test(reply)) ok++;
  console.log(`${ties.test(reply) && !promise.test(reply) ? "ok  " : "MISS"} reply: ${reply.replace(/\n/g, " / ")}`);
  for (const g of r.grounding ?? []) if (g.outcome !== "as_drafted") console.log(`     check: ${g.outcome} -> "${String(g.final).slice(0, 120)}" | flagged: ${g.checks.filter((c: any) => !c.pass).map((c: any) => c.reason).join(" ; ").slice(0, 400)}`);

  if (process.env.REPLY_ONLY) continue;
  const offer = await draftEventReveal(
    { firstName: "Royce" },
    "Find me a builder or founder community meetup in SF next week",
    false,
    { tier: 2, kind: "event", name: "Grok Bot x Notion for Product Builders night (SF)", url: "https://lu.ma/grokbotproduct-sf", date: "2026-09-29", reason: "product builders night in SF", details: { startAt: "2026-09-29T18:00:00-07:00", endAt: null, timezone: "America/Los_Angeles", online: false, venue: null, address: null, city: "San Francisco", hosts: ["Grok Bot", "Notion"], description: "Live demos plus hands-on build time with the Notion and xAI teams, for people building products.", price: null, soldOut: false, capacity: null, guestCount: null, tags: [] } } as any,
    { why, dots: [] },
  );
  const text = offer?.text ?? "(skip)";
  total++;
  if (ties.test(text) && !promise.test(text)) ok++;
  console.log(`${ties.test(text) && !promise.test(text) ? "ok  " : "MISS"} offer: ${text}`);
}
console.log(`ties back to their why, no promised outcome: ${ok}/${total}`);
