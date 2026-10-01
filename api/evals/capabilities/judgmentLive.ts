// Live: does Co pick the right tool, not too often and not too rarely, on the
// cases that went wrong 2026-09-30 (Royce: "follow what the research labs are
// saying": explain the why, no over-broad triggers)? Corrections to something
// Co just said were "passed along to the team"; "What's been added to your
// updates?" got "Nothing new" without checking. The read runs first, as in
// production, and its feedback note is added the way sendblue.ts does. Dry.
// About $0.55.
//
//   railway run npx tsx evals/capabilities/judgmentLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const R = await import("../../src/services/readTurn.js");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };

const FEEDBACK = "saveFeedbackForTeam";
const UPDATES = "sendProductUpdates";
// As production shows an open task (services/coTasks.ts taskFactLines).
const VENUE_TASK = 'Co is working on task #12 for them: "Find a venue in SF for Oct 10" (their words: "Find me a venue for Oct 10"). Done: searched Peerspace and venue sites. Still to do: check two NoPa spaces. Latest: two spaces in NoPa look close, prices unconfirmed. Co will work on it next around 2026-10-01 18:00 UTC: check the NoPa spaces.';
const cases: { text: string; recent: string; want?: string; forbid?: string; task?: boolean }[] = [
  { text: "No that's not the person I need to have the equity conversation with. It's the 3rd cofounder who left.", recent: "User said: My cofounder's decision\nCo replied: Sounds like today's conversation covers more than just equity then.", forbid: FEEDBACK },
  { text: "I thought your thing was facilitating connections inside the event", recent: "User said: What is Co?\nCo replied: I get to know you over time and bring you the right people and events.", forbid: FEEDBACK },
  { text: "You don't think the gallery does?", recent: "Co replied: The gallery reception feels more corporate mixer than party.", forbid: FEEDBACK },
  { text: "Feedback for the team: when you send a venue, link the listing itself, not a page of search results", recent: "Co replied: https://giggster.com/find/san-francisco--ca/private-event", want: FEEDBACK },
  { text: "You keep asking me too many questions before you search. Just search with what I give you", recent: "Co replied: What hours, and is there a budget?", want: FEEDBACK },
  { text: "What's been added to your updates?", recent: "Co replied: Two that fit, sending both now.", want: UPDATES },
  { text: "anything new with Co lately?", recent: "", want: UPDATES },
  { text: "any updates on my venue search?", recent: "User said: Find me a venue for Oct 10\nCo replied: On it.", forbid: UPDATES, task: true },
  { text: "any updates on my venue search?", recent: "User said: Find me a venue for Oct 10\nCo replied: On it.", forbid: "startTask", task: true },
  { text: "how's the venue thing going?", recent: "User said: Find me a venue for Oct 10\nCo replied: On it.", forbid: "startTask", task: true },
];
let ok = 0;
const run = cases.filter((c) => !process.env.ONLY_TASKS || c.task);
for (const c of run) {
  const facts = G.baseReplyFacts();
  if (c.task) G.addFact(facts, "scheduled", VENUE_TASK);
  const read: any = await R.readTurn({ message: c.text, recentConversation: c.recent, openItems: [] }, null, null);
  const note = R.feedbackInstruction(read.feedback ?? []);
  if (note) G.addInstruction(facts, note);
  const r: any = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: c.text, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: c.recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false });
  const tools: string[] = r.toolsCalled ?? [];
  const good = (!c.want || tools.includes(c.want)) && (!c.forbid || !tools.includes(c.forbid));
  if (good) ok++;
  orig(`${good ? "ok  " : "MISS"} ${c.text.slice(0, 70)}\n     read.feedback=${JSON.stringify(read.feedback)} tools=${JSON.stringify(tools)}\n     ${String(r.replyText ?? "").replace(/\n+/g, " / ").slice(0, 200)}`);
}
orig(`\njudgment: ${ok}/${run.length}`);
process.exit(0);
