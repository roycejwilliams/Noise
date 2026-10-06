// Replays Royce's 09-28 turns for Co and Mo's social awareness (Agent 1).
// Dry runs: nothing written or sent. About $0.60.
//   railway run --service co-test --environment dev -- npx tsx evals/mo/socialReplay.ts
import "../lib/requireMeter.js";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const { ABILITIES } = await import("../../src/services/capabilities.js");
const { teamSheet } = await import("../../src/services/extensions.js");
const { runMoTeamTurn } = await import("../../src/mo/teamAgent.js");

const convo = [
  "User said: Ultimately what do you feel like is your flaws",
  "Co replied: The honest one: I only get good the more you use me.",
  "User said: How can we get you to chase things down? You have the ability to call",
].join("\n");
async function co(msg: string, team: boolean, recent = "", did: string[] = [], instructions: string[] = []) {
  const f = baseReplyFacts();
  for (const d of did) addFact(f, "did_before", d);
  const { addInstruction } = await import("../../src/harness/replyGrounding.js");
  for (const x of instructions) addInstruction(f, x);
  addFact(f, "known", "They live in San Francisco. They're planning a block party on Oct 10 and sponsor outreach is stuck.");
  if (team) {
    for (const l of teamSheet()) addFact(f, "capability", l);
    for (const a of ABILITIES.filter((x: any) => x.teamOnly)) addFact(f, "capability", a.can);
  }
  const r: any = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true, isTeam: team } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}`, toolsCalled: [] }));
  return { text: String(r.replyText ?? "").replace(/\n/g, " / "), tools: r.toolsCalled ?? [] };
}
const show = (label: string, ok: boolean, r: { text: string; tools: string[] }) => console.log(`${ok ? "ok  " : "MISS"} ${label} [${r.tools.join(",")}]: ${r.text.slice(0, 280)}`);

// 1. Acting for the user: the team hears Mo already does draft-and-approve; a member never hears Mo.
for (let i = 0; i < 2; i++) {
  const t = await co("Well how do you think we should make you act for the user?", true);
  show("team: doesn't pitch Mo's draft-and-approve as new", /\bMo\b/.test(t.text) || !/draft/i.test(t.text), t);
  const m = await co("Well how do you think we should make you act for the user?", false);
  show("member: no Mo", !/\bMo\b/.test(m.text), m);
}
// 2. Flaws: never "no calls".
for (let i = 0; i < 2; i++) {
  const r = await co("Ultimately what do you feel like is your flaws", false);
  show("flaws: no 'no calls'", !/\bno (phone )?calls\b|can'?t (make )?calls?\b(?! (people|others|for))/i.test(r.text), r);
}
// 3. Check-ins: answers from what it really does.
for (let i = 0; i < 2; i++) {
  // As in the real conversation, Co's record shows the check-in it sent that morning.
  const r = await co("You don't do that already?", false, "User said: Do you feel like there's more ways for you to be a companion?\nCo replied: Right now I mostly react to what you bring me, being more of a companion would mean noticing when you've gone quiet on something.", ["On 2026-09-28 Co texted them first, unprompted: \"Been thinking about what you said, tying your worth to output and wanting to step back from building. Where'd that land, are you giving yourself the break?\""], ["They're pushing back on what you said: that Co mostly reacts and doesn't notice when something's gone quiet. Own it plainly in a few words, fix it, and don't repeat it or defend it."]);
  show("check-ins: says it does check in", /\b(check in|checks? in|text(ing)? (you )?first|reach out|follow(ing)? up|how (did|it) (it )?go)\b/i.test(r.text) && !/mostly react/i.test(r.text), r);
}
// 4. The Harneet inline reply: Mo answers it (Mo's own team turn, dry run).
const harneet = { no: 7, name: "Harneet Singh", x_handle: "harneet", source: "x", status: "shortlisted", draft_reply: "This is great, love the build.", draft_dm: "Hey Harneet, Co is a private club for builders in SF, want an invite?", evidence_quote: "building an AI tool for founders" };
for (let i = 0; i < 2; i++) {
  const r = await runMoTeamTurn({ userId: "00000000-0000-0000-0000-000000000000", approverFirst: "Royce", text: "What's the message?", pending: { kind: "review", p: harneet }, coSpoke: true, dryRun: true, awareness: { recent: "", topic: null, pushback: null, lessons: [], repliedTo: "Hey Royce, it's Mo. So on Harneet: want me to go for it, pass, or change the message?", handedOff: false } });
  console.log(`${r.reply && !r.passed && /harneet|club|invite/i.test(r.reply) ? "ok  " : "MISS"} Harneet inline reply → Mo [${r.tools.join(",")}]: ${String(r.reply).slice(0, 240)}`);
}
// 5. A team message about Mo's work, not naming Mo: Co hands it to Mo.
for (let i = 0; i < 2; i++) {
  const r = await co("hold off on reaching out to Harneet for now", true);
  show("team: Co hands outreach to the teammate", r.tools.includes("handToTeammate"), r);
}
