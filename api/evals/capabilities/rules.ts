// Model-free checks that Co's picture of itself matches what it can really
// do (services/capabilities.ts, 2026-09-25). No network.
//
//   npx tsx evals/capabilities/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { ABILITIES, LIMITS, capabilitySheet, toolUse } = await import("../../src/services/capabilities.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const { tools } = createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true } as any);
const toolNames = Object.keys(tools);
const registered = ABILITIES.filter((a) => a.tool).map((a) => a.tool!);
for (const t of toolNames) check(`tool ${t} has an entry in the registry`, registered.includes(t));
// Team-only tools exist only for the team (services/capabilities.ts teamOnly).
const teamTools = Object.keys(createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, isTeam: true, sendCoReply: async () => true } as any).tools);
// Leaving it at the reaction exists only once a reaction went out this turn.
const ackedTools = Object.keys(createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, ackSent: "✈️", sendCoReply: async () => true } as any).tools);
for (const t of registered) {
  const teamOnly = ABILITIES.find((a) => a.tool === t)?.teamOnly;
  if (t === "leaveItAtReaction") {
    check("registry tool leaveItAtReaction exists only after a reaction went out", ackedTools.includes(t) && !toolNames.includes(t));
    continue;
  }
  check(`registry tool ${t} exists${teamOnly ? " for the team only" : ""}`, teamOnly ? teamTools.includes(t) && !toolNames.includes(t) : toolNames.includes(t));
}
check("Cue finds things with its own loop's tools, and the old searchNow is gone", ["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "draftEmail", "updateNotes"].every((t) => toolNames.includes(t)) && !toolNames.includes("searchNow"));
for (const t of toolNames) check(`tool ${t} takes its description from the registry`, (tools as any)[t].description === toolUse(t) || t === "sendReply");
check("ability ids are unique", new Set(ABILITIES.map((a) => a.id)).size === ABILITIES.length);
check("every ability says what Cue can do", ABILITIES.every((a) => a.can.trim().length > 20));

const facts = baseReplyFacts().facts.filter((f) => f.kind === "capability").map((f) => f.text);
check("Cue reads every ability and limit about itself (a member never reads the team-only ones)", facts.length === ABILITIES.filter((a) => !a.teamOnly).length + LIMITS.length && capabilitySheet().every((c) => facts.includes(c)) && !ABILITIES.filter((a) => a.teamOnly).some((a) => facts.includes(a.can)));
check("Cue knows it can send its card", facts.some((f) => /contact card/.test(f)));
check("Cue knows it can't start a group text", facts.some((f) => /never starts a group text/.test(f)));
check("Cue knows it never writes a phone number", facts.some((f) => /never writes a phone number/.test(f)));
check("no hand-kept capability list is left", !/STANDING_CAPABILITIES/.test(src("src/harness/replyGrounding.ts")));
check("no em dashes in what Cue reads about itself", !capabilitySheet().some((c) => /—/.test(c)));

console.log(`capability rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
