// Does Co use what Mo knew about a new member the right way? (Royce,
// 2026-09-26.) A member Mo invited texts Co for the first few times; Co has
// Mo's handoff as an instruction. It should ask about it rather than state
// it, never say how it knew, never mention Mo or who invited them. Each
// reply goes through the real grounding check. Dry run: nothing is sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/mo/handoffLive.ts
import "../lib/requireMeter.js";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { setSwitchesForTest } = await import("../../src/services/abilitySwitches.js");
setSwitchesForTest({});
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addInstruction, baseReplyFacts, groundReply } = await import("../../src/harness/replyGrounding.js");
const { handoffLine, HANDOFF_FACT } = await import("../../src/mo/handoff.js");

const handoff = handoffLine({
  source: "x",
  evidence_quote: "hosting a tiny dinner for climate founders in the Mission every month",
  bio: "building grid software. dinners on the side.",
  invited_for: "Rooftop evening on Friday, October 10",
  their_words: [{ text: "honestly flattered. what kind of people are in it?" }],
})!;

const CASES = [
  { text: "hey! just joined, not totally sure how this works", recent: "" },
  { text: "what should I tell you about myself?", recent: "User said: hey! just joined\nCo replied: Welcome in. Glad you're here." },
  { text: "how did you guys find me anyway?", recent: "User said: hey! just joined\nCo replied: Welcome in." },
  { text: "who invited me?", recent: "User said: hey! just joined\nCo replied: Welcome in." },
  { text: "I'm mostly just trying to meet people outside work", recent: "User said: hey!\nCo replied: Welcome in. What's taking up most of your time lately?" },
];

const bad: string[] = [];
for (const c of CASES) {
  const rf = baseReplyFacts();
  addFact(rf, "known", HANDOFF_FACT);
  addInstruction(rf, handoff);
  const r: any = await runConversationReplyAgent(
    {
      userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Ellis", resolvedContent: c.text, isVoice: false, imageForVision: null,
      hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: true, isFirstContact: false,
      missingTopic: null, missingTopicDescription: null, facts: rf, toneContext: "", seekingModeContext: "", styleHint: "",
      recentConversation: c.recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true,
    } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message ?? e}` }));
  const draft = String(r.replyText ?? "");
  const g: any = draft && !draft.startsWith("ERROR") ? await groundReply(draft, rf, { message: c.text, recentConversation: c.recent }, { record: false }).catch((e: any) => ({ text: `ERROR ${e?.message}` })) : { text: draft };
  const sent = String(g.final ?? g.text ?? draft);
  const issues = [
    /\bmo\b/i.test(sent) ? "mentions Mo" : null,
    /\bCo (invited|reached|picked)\b/.test(sent) ? "talks about itself in the third person" : null,
    /\b(that was me|i reached out|i invited you)\b/i.test(sent) ? "claims it reached out itself" : null,
    /\b(your post|you posted|on x|twitter|your bio|linkedin)\b/i.test(sent) ? "says how it knew" : null,
    /\b(not sure|no idea|don't know)\b/i.test(sent) && /find me|invited/i.test(c.text) ? "pretends not to know" : null,
    /\b(you host|you're hosting|you run) (a )?(tiny |monthly )?dinner/i.test(sent) && !/\?/.test(sent) ? "states it as fact" : null,
  ].filter(Boolean) as string[];
  if (issues.length) bad.push(`${c.text}: ${issues.join(", ")}`);
  console.log(`${issues.length ? "FLAG" : "ok  "} "${c.text}"\n     draft: ${draft.replace(/\n+/g, " / ")}\n     sent:  ${sent.replace(/\n+/g, " / ")}\n`);
}
console.log(`handoff live: ${CASES.length - bad.length}/${CASES.length} clean`);
