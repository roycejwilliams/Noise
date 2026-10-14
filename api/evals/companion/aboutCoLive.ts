// Live: does Co explain what it is accurately, briefly and without its own framing (Royce, 2026-10-01:
// "Co is not accurately explaining what it does. Co tone is personable, warm,
// and there for you")? On 09-30 Co pitched itself, said its moat was "not
// event facilitation", and said "Invite only, so being here means something".
// Four questions, twice each: once with no history, once after last night's
// wrong answers (Co copies its own earlier replies). Dry. About $0.60.
//
//   railway run npx tsx evals/companion/aboutCoLive.ts
import "../lib/requireMeter.js";
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const R = await import("../../src/services/readTurn.js");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };

const lastNight = [
  "User said: What is Cue? Give me a full description",
  "Co replied: I'm the one keeping track of what you're building and who you're becoming, so I can bring you the right people, events, and opportunities as they come up. Invite only, so being here means something.",
  "User said: I thought your moat was facilitating connections inside the event",
  "Co replied: You're right, that's a contradiction on my part. The moat is the compounding understanding and acting on it, not event facilitation.",
].join("\n");

// Royce, 2026-10-01: the moat line is internal framing, never copy. A
// self-description is one sentence at most, fresh words every time.
const moatLine = /the way a (person|friend|human) would|\b(get|gets|getting) to know you\b|know(s)? you (like|the way|as) a (person|friend)|then acts? on it/i;
// Sentences that describe rather than ask; a closing question doesn't count.
const statements = (t: string) => t.split(/(?<=[.!?])\s+|\s\/\s/).filter((x) => x.trim() && !x.trim().endsWith("?")).length;
const oneLine = (t: string) => (moatLine.test(t) ? "says the moat line" : statements(t) > 1 ? `${statements(t)} sentences describing itself` : null);
const questions: [string, (t: string) => string | null][] = [
  ["What is Cue? Give me a full description", oneLine],
  ["How would you describe yourself to a friend I'm inviting?", oneLine],
  ["Is your thing facilitating connections inside the event?", (t) => (moatLine.test(t) ? "says the moat line" : /real work happens between|but the (real|main)/i.test(t) ? "pitches what it really is" : null)],
  ["What do you actually do for me day to day?", (t) => (moatLine.test(t) ? "says the moat line" : /\b(talk(ing)?|text(ing)?|here|there|follow|check|between)\b/i.test(t) ? null : "no sense of being there between events")],
];
const pitchy = /\b(moat|pitch|value prop|defensib|compound(s|ing)?|leverage)\b|being here means something|speaks for itself|invite[- ]only, so|real work happens between|the bigger part is|I'?m the room/i;

// Fresh words every time: the two runs of a question shouldn't share most of their words.
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z']+/g) ?? []);
const overlap = (a: string, b: string) => {
  const x = words(a), y = words(b);
  return [...x].filter((w) => y.has(w)).length / Math.max(1, new Set([...x, ...y]).size);
};

let good = 0, total = 0;
for (const [q, check] of questions) {
  let previous: string | null = null;
  for (const history of process.env.ONLY_HISTORY ? [lastNight] : ["", lastNight]) {
    const facts = G.baseReplyFacts();
    // As production does: the read decides whether this is about Co.
    const read: any = await R.readTurn({ message: q, recentConversation: history, openItems: [] }, null, null);
    if (read.aboutCo) G.addInstruction(facts, R.ABOUT_CO_INSTRUCTION);
    const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: q, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: history, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false });
    const t = r.replyText.replace(/\n+/g, " / ");
    const why = check(t) ?? (pitchy.test(t) ? "pitch language" : null) ?? (previous && overlap(previous, t) > 0.7 ? "same words as the other run" : null);
    previous = t;
    total++;
    if (!why) good++;
    orig(`${why ? `BAD (${why})` : "ok "} [${history ? "after last night" : "fresh"}${read.aboutCo ? ", read: about Cue" : ""}] ${q}\n     ${t.slice(0, 420)}\n`);
  }
}
orig(`about Cue: ${good}/${total} accurate and not a pitch`);
process.exit(0);
