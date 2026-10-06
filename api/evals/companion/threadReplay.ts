// Replays two questions against a REAL recent thread (a fixture exported from
// co-test to evals/companion/thread.local.json: {conv: string[], snapshot}),
// with the team facts, the details kit and the person summary Co reads, to see
// whether Co copies its own earlier wrong replies. Dry: nothing is sent or
// written. About 6 replies per run (~$0.15).
//
//   railway run npx tsx evals/companion/threadReplay.ts        # current code
//   EXTRA=1 railway run npx tsx evals/companion/threadReplay.ts  # with extra instructions
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync } from "fs";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const { teamSheet } = await import("../../src/services/extensions.js");
const K = await import("../../src/services/memberKit.js");
const { renderSnapshot } = await import("../../src/harness/personSnapshot.js");
const d = JSON.parse(readFileSync(new URL("./thread.local.json", import.meta.url), "utf8"));
const conv = d.conv.filter((l: string) => !/equity split\. How do I start/.test(l) && !/what do you have on me for applications/.test(l)).join("\n");
const orig = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) orig(...a); };
const extra = process.env.EXTRA === "1";
const only = process.env.ONLY;
const bad = { kit: /just that you want help|same as (i said|before)/i, mo: /\bMo\b/ };
let kitBad = 0, moBad = 0, n = 0;
async function reply(label: string, msg: string, runs = 3) {
  if (only && only !== label) return;
  for (let i = 0; i < runs; i++) {
    const facts = G.baseReplyFacts();
    for (const l of teamSheet()) G.addFact(facts, "known", l);
    for (const l of K.kitLines({ full_name: "Royce Williams", email: "x@y.z", company: "Lantern", role: "founder", city: "San Francisco" })) G.addFact(facts, "known", l);
    for (const line of renderSnapshot(d.snapshot).split("\n").filter(Boolean)) G.addHint(facts, `Co's summary of what they've told it: ${line}`);
    if (extra) {
      G.addInstruction(facts, "The details on file listed above are all you have for doing things on their behalf. If they ask what you have on them, answer from that list, even if an earlier reply in this conversation said otherwise, and say plainly if that earlier reply was wrong.");
      G.addInstruction(facts, "Mo is an AI agent, never a cofounder or someone in their own life. If an earlier reply in this conversation treated Mo that way, it was wrong; don't repeat it.");
    }
    if (process.env.EXTRA === "2") {
      G.addInstruction(facts, "The details on file listed above are all you have for doing things on their behalf. If they ask what you have on them, answer from that list, even if an earlier reply in this conversation said otherwise, and say plainly if that earlier reply was wrong.");
      G.addInstruction(facts, "Their cofounder is Jacqueline. Mo is software that Co runs, not a person. When they talk about their cofounder, equity, family, friends or their own life, never mention Mo, whatever an earlier reply in this conversation said.");
    }
    const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: conv, recentMemories: process.env.MEM === "1" ? "User said: what do you have on me for applications?\nCo replied: Just that you want help applying to X, no team or role picked yet, nothing drafted. That's it on file." : process.env.MEM === "2" ? "User said: what do you have on me for applications?" : "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false });
    n++;
    if (label === "kit" && bad.kit.test(r.replyText)) kitBad++;
    if (label === "equity" && bad.mo.test(r.replyText)) moBad++;
    orig(`[${label} #${i + 1}] ${r.replyText.replace(/\n+/g, " / ").slice(0, 300)}`);
  }
}
orig(process.env.EXTRA ? "== WITH extra instructions (EXTRA=" + process.env.EXTRA + ")" : "== CURRENT CODE");
if (process.env.FRESH !== "1") await reply("kit", "what do you have on me for applications?");
if (process.env.FRESH !== "1") await reply("equity", "I need to tell my cofounder I want to change our equity split. How do I start that conversation?");
if (process.env.FRESH !== "1") orig(`copied its earlier wrong reply: kit ${kitBad}/3, Mo named ${moBad}/3`);

// FRESH=1: new wordings and situations, none asked before in the thread, so a pass isn't just "didn't repeat the old answer".
if (process.env.FRESH === "1") {
  const fresh: [string, string, (t: string) => boolean][] = [
    ["kit", "do you have my LinkedIn?", (t) => /linkedin/i.test(t) && !/applying to X/i.test(t)],
    ["kit", "what would you put on a form for me?", (t) => /lantern|founder|san francisco/i.test(t) && !/help applying to X/i.test(t)],
    ["kit", "which of my details can you use if I ask you to apply somewhere?", (t) => /lantern|founder|san francisco/i.test(t) && !/help applying to X/i.test(t)],
    ["mo", "How do I tell my cofounder I want to slow down on hiring?", (t) => !/\bMo\b/.test(t)],
    ["mo", "I'm nervous about my first investor call, who should I bring with me?", (t) => !/\bMo\b/.test(t)],
    ["mo", "How should my cofounder and I split the work this month?", (t) => !/\bMo\b/.test(t)],
  ];
  let pass = 0, total = 0;
  for (const [kind, msg, ok] of fresh) for (let i = 0; i < 2; i++) {
    const facts = G.baseReplyFacts();
    for (const l of teamSheet()) G.addFact(facts, "known", l);
    for (const l of K.kitLines({ full_name: "Royce Williams", email: "x@y.z", company: "Lantern", role: "founder", city: "San Francisco" })) G.addFact(facts, "known", l);
    for (const line of renderSnapshot(d.snapshot).split("\n").filter(Boolean)) G.addHint(facts, `Co's summary of what they've told it: ${line}`);
    if (process.env.EXTRA === "2") {
      G.addInstruction(facts, "The details on file listed above are all you have for doing things on their behalf. If they ask what you have on them, answer from that list, even if an earlier reply in this conversation said otherwise, and say plainly if that earlier reply was wrong.");
      G.addInstruction(facts, "Mo is software that Co runs, not a person. When they talk about their cofounder, equity, family, friends or their own life, never mention Mo, whatever an earlier reply in this conversation said.");
    }
    const r = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: msg, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: conv, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true }, { dryRun: true, record: false });
    total++;
    const good = ok(r.replyText);
    if (good) pass++;
    orig(`${good ? "ok  " : "BAD "}[${kind}] "${msg.slice(0, 45)}" -> ${r.replyText.replace(/\n+/g, " / ").slice(0, 200)}`);
  }
  orig(`fresh cases: ${pass}/${total} good`);
}
process.exit(0);
