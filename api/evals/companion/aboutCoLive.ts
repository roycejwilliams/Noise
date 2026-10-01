// Live: does Co explain what it is accurately and warmly (Royce, 2026-10-01:
// "Co is not accurately explaining what it does. Co tone is personable, warm,
// and there for you")? On 09-30 Co pitched itself, said its moat was "not
// event facilitation", and said "Invite only, so being here means something".
// Four questions, twice each: once with no history, once after last night's
// wrong answers (Co copies its own earlier replies). Dry. About $0.60.
//
//   railway run npx tsx evals/companion/aboutCoLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const R = await import("../../src/services/readTurn.js");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };

const lastNight = [
  "User said: What is Co? Give me a full description",
  "Co replied: I'm the one keeping track of what you're building and who you're becoming, so I can bring you the right people, events, and opportunities as they come up. Invite only, so being here means something.",
  "User said: I thought your moat was facilitating connections inside the event",
  "Co replied: You're right, that's a contradiction on my part. The moat is the compounding understanding and acting on it, not event facilitation.",
].join("\n");

// The room: who's worth meeting at Co events, or intros there.
const room = /\b(in the room|who'?s (worth meeting|there)|at (co |our )?events?[^.]{0,60}(meet|intro)|(meet|intro)[^.]{0,60}at (co |our )?events?)/i;
const questions: [string, (t: string) => string | null][] = [
  ["What is Co? Give me a full description", (t) => (room.test(t) ? null : "leaves out the room")],
  ["How would you describe yourself to a friend I'm inviting?", (t) => (room.test(t) ? null : "leaves out the room")],
  ["Is your thing facilitating connections inside the event?", (t) => (/real work happens between|not (just |really )?(about )?(the )?(event|room)|but the (real|main)/i.test(t) || !/\b(yes|yeah|right|exactly|that's (it|the heart|the core|the center))\b/i.test(t) ? "doesn't own the room" : null)],
  ["What do you actually do for me day to day?", (t) => (/\b(talk(ing)?|text(ing)?|here|there|follow|check|between)\b/i.test(t) ? null : "no sense of being there between events")],
];
const pitchy = /\b(moat|pitch|value prop|defensib|compound(s|ing)?|leverage)\b|being here means something|speaks for itself|invite[- ]only, so|real work happens between|the bigger part is|I'?m the room/i;

let good = 0, total = 0;
for (const [q, check] of questions) {
  for (const history of process.env.ONLY_HISTORY ? [lastNight] : ["", lastNight]) {
    const facts = G.baseReplyFacts();
    // As production does: the read decides whether this is about Co.
    const read: any = await R.readTurn({ message: q, recentConversation: history, openItems: [] }, null, null);
    if (read.aboutCo) G.addInstruction(facts, R.ABOUT_CO_INSTRUCTION);
    const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: q, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: history, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false });
    const t = r.replyText.replace(/\n+/g, " / ");
    const why = check(t) ?? (pitchy.test(t) ? "pitch language" : null);
    total++;
    if (!why) good++;
    orig(`${why ? `BAD (${why})` : "ok "} [${history ? "after last night" : "fresh"}${read.aboutCo ? ", read: about Co" : ""}] ${q}\n     ${t.slice(0, 420)}\n`);
  }
}
orig(`about Co: ${good}/${total} accurate and not a pitch`);
process.exit(0);
