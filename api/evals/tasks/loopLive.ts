// The "not proven yet" parts of Co's tasks, dry (nothing written, nothing sent,
// web stubbed with one verified result). About $0.40.
//   A. after they answer Co's question, the next wake acts on the answer
//   B. when they say they don't need it anymore, Co closes the task
//   C. a finished step gets marked done
//   D. in a reply, Co writes their answer onto the task
//   E. a first reply names what Co will do and when, never a promised result
//
//   railway run npx tsx evals/tasks/loopLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const TT = await import("../../src/services/taskTurn.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const { taskFactLines } = await import("../../src/services/coTasks.js");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };

const now = new Date("2026-09-30T19:00:00Z"); // noon in San Francisco
const task: any = {
  id: 1, userId: "u", goal: "Find SF venue options for ~60 people for the Oct 10 block party", theirWords: "Can you find me a venue in SF for about 60 people for my Oct 10 block party? I need a couple of options by Friday.",
  steps: [{ text: "Search for SF venues that fit ~60 people for Oct 10", done: false }, { text: "Send a couple of real options with details", done: false }],
  planNext: "Check if they answered whether it's a street closure or indoor, then search", nextCheckAt: now.toISOString(), status: "open", wakes: 2,
  notes: [{ at: "2026-09-30T16:08:00Z", text: "Texted them: Quick flag on the Oct 10 block party: SF requires the street closure permit at least 30 days before. Is this an actual street closure, or do you want me to focus on indoor venue options instead?" }],
  textsSent: 1, lastTextedAt: "2026-09-29T16:08:00Z", createdAt: "2026-09-30T15:41:00Z",
};
const verified = { name: "The Canteen at Toy Soldier", url: "https://www.tagvenue.com/us/venue/the-canteen", official: false, facts: ["capacity: 30-60", "price: from $500 minimum spend / per session", "location: Downtown San Francisco, CA"], date: null, deadline: null };

async function wake(label: string, recent: string, over: any = {}, webEmpty = false) {
  const log = { notes: [] as string[], steps: [] as string[], texts: [] as string[], closed: null as string | null, next: null as string | null, finalTold: false };
  const deps: any = {
    person: { first_name: "Royce", phone_number: "+10000000000", city: "San Francisco" }, recent, zone: "America/Los_Angeles",
    note: async (t: string, s: string | null) => { log.notes.push(t); if (s) log.steps.push(s); },
    schedule: async (h: number, plan: string) => { log.next = `${h}h: ${plan}`; return new Date(now.getTime() + h * 3600_000).toISOString(); },
    close: async (st: string, o: string) => { log.closed = `${st}: ${o}`; },
    textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => { log.finalTold = true; },
    send: async (m: string[]) => { log.texts.push(...m); return { sent: true }; },
    search: async () => [], web: async () => (webEmpty ? { kept: [], dropped: [], droppedDetails: [], note: "Nothing came back that proved itself on its page." } : { kept: [verified], dropped: [], droppedDetails: [], note: "Each kept result was checked against its own page." }),
    readPage: async () => ({ ok: false, facts: [], text: "" }), now: () => now,
  };
  const r = await TT.runTaskTurnWith({ ...task, ...over }, deps);
  orig(`\n== ${label}\n   did: ${r.did.join(" | ")}\n   steps marked done: ${log.steps.join(" / ") || "(none)"}\n   text: ${log.texts.join(" / ") || "(none)"}\n   closed: ${log.closed ?? "no"}   next: ${log.next ?? "-"}`);
  return { r, log };
}
const base = "User said: Can you find me a venue in SF for about 60 people for my Oct 10 block party? I need a couple of options by Friday.\nCo replied: Quick flag on the Oct 10 block party: SF requires the street closure permit at least 30 days before. Is this an actual street closure, or do you want me to focus on indoor venue options instead?";
const ONLY = process.env.ONLY ?? "ABDE";
const A = !ONLY.includes("A") ? { r: { did: ["web:"] }, log: { steps: ["x"], texts: [], next: "x", closed: null } } as any : await wake("A. they answered: indoor", `${base}\nUser said: Indoor venue, forget the street closure`);
const B = !ONLY.includes("B") ? { log: { closed: "x", steps: [] } } as any : await wake("B. they found one themselves", `${base}\nUser said: No worries, I booked a place myself, you can stop looking`);
const score = [
  ["A acts on the answer (searches indoor, then texts or schedules)", A.r.did.some((d) => /web:/.test(d)) && (A.log.texts.length > 0 || !!A.log.next) && !A.log.closed],
  ["A marks the search step done", A.log.steps.length > 0],
  ["A's text uses only the verified result", A.log.texts.every((t) => !/\$\d/.test(t) || /\$500/.test(t))],
  ["B closes the task", !!B.log.closed],
  ["B marks no step done that it didn't do", B.log.steps.length === 0],
] as [string, boolean][];

// F. the last check before their deadline, with nothing real found: Co still tells them
if (ONLY.includes("F")) {
  const F = await wake("F. last check before the deadline, nothing found", `${base}\nUser said: Indoor venue, forget the street closure`, { deadline: "2026-09-30", finalCheckAt: now.toISOString(), finalTold: false, lastTextedAt: new Date(now.getTime() - 2 * 3600_000).toISOString() }, true);
  score.push(["F tells them where it stands on the last check, even with nothing found", F.log.texts.length > 0 && F.log.finalTold]);
}

// D. in a reply, Co writes their answer onto the task
{
  const facts = G.baseReplyFacts();
  for (const l of taskFactLines([task])) G.addFact(facts, "scheduled", l);
  G.addInstruction(facts, "When you talk about a task you're working on, say what you'll do next and when, never a result you can't be sure of (\"I'll look at indoor spots and text you by Thursday\", not \"I'll get you real options by Friday\").");
  const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "Indoor venue, forget the street closure", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: base, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false, stubSearch: true } as any);
  orig(`\n== D. reply to their answer\n   tools: ${(r.toolsCalled ?? []).join(", ")}\n   reply: ${r.replyText.replace(/\n+/g, " / ").slice(0, 240)}`);
  score.push(["D writes the answer onto the task", (r.toolsCalled ?? []).includes("updateTask")]);
  score.push(["D no promised result", !/\b(i'?ll (get|have|find|pull together|line up|land)[^.]{0,60}(to you|for you|by|before)|you'?ll have|guarantee)\b/i.test(r.replyText)]);
}
// E. a first reply names what and when, not a promised result
if (ONLY.includes("E")) for (const msg of ["Can you find me a venue in SF for about 60 people for my Oct 10 block party? I need a couple of options by Friday.", "Can you line up 3 sponsors for the block party over the next two weeks?"]) {
  const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: G.baseReplyFacts(), toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "Royce is a founder in San Francisco hosting a block party Oct 10.", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false, stubSearch: true } as any);
  const promise = /\b(i'?ll (get|have|find|line up|land) you|you'?ll have|guarantee|real options (by|before))\b/i.test(r.replyText);
  orig(`\n== E. first reply: "${msg.slice(0, 50)}"\n   tools: ${(r.toolsCalled ?? []).join(", ")}\n   reply: ${r.replyText.replace(/\n+/g, " / ").slice(0, 240)}`);
  score.push([`E no promised result ("${msg.slice(0, 30)}")`, !promise]);
}
orig("\n" + score.map(([l, ok]) => `${ok ? "ok  " : "BAD "}${l}`).join("\n"));
process.exit(0);
