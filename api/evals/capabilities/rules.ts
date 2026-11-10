// Model-free checks that Co's picture of itself matches what it can really
// do (services/capabilities.ts, 2026-09-25). No network.
//
//   npx tsx evals/capabilities/rules.ts
import { readFileSync } from "fs";
import { createHash } from "node:crypto";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { ABILITIES, LIMITS, capabilitySheet, toolUse } = await import("../../src/services/capabilities.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400));
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
  if (t === "askedWalkin") {
    // The walk-in receipt exists only on a turn with the walk-in question due (routes/sendblue.ts walkinAskDue).
    const walkinTools = Object.keys(createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, walkinAsk: { eventId: "e", asked: false }, sendCoReply: async () => true } as any).tools);
    check("registry tool askedWalkin exists only on a turn with the walk-in question due", walkinTools.includes(t) && !toolNames.includes(t));
    continue;
  }
  if (t === "voiceRead") {
    // The voice read's answers exist only where the read can run at all (services/voiceRead.ts voiceReadPrereqs; never in production).
    const keep = { HUME_API_KEY: process.env.HUME_API_KEY, API_URL: process.env.API_URL, TWILIO_AUTH: process.env.TWILIO_AUTH, RAILWAY_ENVIRONMENT_NAME: process.env.RAILWAY_ENVIRONMENT_NAME };
    Object.assign(process.env, { HUME_API_KEY: "dummy", API_URL: "https://co-test.example.app", TWILIO_AUTH: "dummy", RAILWAY_ENVIRONMENT_NAME: "co-test" });
    const voiceTools = Object.keys(createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true } as any).tools);
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    check("registry tool voiceRead exists only where the voice read can run", voiceTools.includes(t) && !toolNames.includes(t));
    continue;
  }
  if (t === "anythingForMe") {
    // The pull exists only on a turn with something waiting for them (harness/waiting.ts; TurnContext.waiting).
    const waitingTools = Object.keys(createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, turn: { waiting: [{ id: "1", type: "event_offer", band: 2, label: "a find for you: X", intro: false, expiresAt: null }] }, sendCoReply: async () => true } as any).tools);
    check("registry tool anythingForMe exists only on a turn with something waiting", waitingTools.includes(t) && !toolNames.includes(t));
    continue;
  }
  if (t === "leaveItAtReaction") {
    check("registry tool leaveItAtReaction exists only after a reaction went out", ackedTools.includes(t) && !toolNames.includes(t));
    continue;
  }
  check(`registry tool ${t} exists${teamOnly ? " for the team only" : ""}`, teamOnly ? teamTools.includes(t) && !toolNames.includes(t) : toolNames.includes(t));
}
check("Cue finds things with its own loop's tools, and the old searchNow is gone", ["searchEvents", "webSearch", "searchPosts", "readPage", "shareFinds", "updateNotes"].every((t) => toolNames.includes(t)) && !toolNames.includes("searchNow"));
for (const t of toolNames) check(`tool ${t} takes its description from the registry`, (tools as any)[t].description === toolUse(t) || t === "sendReply");
check("ability ids are unique", new Set(ABILITIES.map((a) => a.id)).size === ABILITIES.length);
check("every ability says what Cue can do", ABILITIES.every((a) => a.can.trim().length > 20));

const facts = baseReplyFacts().facts.filter((f) => f.kind === "capability").map((f) => f.text);
// The sheet (capability-sheet trim, 2026-10-31): each member ability carries its own `sheet` line, or null when another line covers it.
// The walk-in ask is listed only on a turn known to have it due, the voice read only where it can run (services/capabilities.ts ONLY_WHEN_KNOWN).
const members = ABILITIES.filter((a) => !a.teamOnly);
check("every member ability carries a sheet line or null (a new ability can't be left out of the sheet by accident)", members.every((a) => "sheet" in a && (a.sheet === null || (typeof a.sheet === "string" && a.sheet.trim().length > 20))), members.filter((a) => !("sheet" in a) || (a.sheet !== null && typeof a.sheet !== "string")).map((a) => a.id));
check("Cue reads every sheet line and limit about itself (a member never reads the team-only ones)", facts.length === members.filter((a) => a.sheet !== null && a.tool !== "askedWalkin" && a.tool !== "voiceRead").length + LIMITS.length && capabilitySheet().every((c) => facts.includes(c)) && !ABILITIES.filter((a) => a.teamOnly).some((a) => facts.includes(a.can)));
// Fixed: the safety line (988) and the 11 limits are word for word what they were before the trim (the call audit numbers the limits).
const SAFETY_988 = "When someone may be thinking about hurting themselves or may not be safe, Cue stays with them, asks plainly whether they're safe, and shares crisis support: In the US, the 988 Suicide & Crisis Lifeline is free and open 24/7: call or text 988, or chat at 988lifeline.org. Anyone in immediate danger should call 911. Cue may check in on them the next day.";
check("the 988 line in the sheet is byte-identical", capabilitySheet().includes(SAFETY_988) && ABILITIES.find((a) => a.id === "safety")?.can === SAFETY_988);
// 2026-11-02 (review of #349): the first limit says "they ask for it, or say yes to Cue's offer of it", as the registry does.
check("the 11 limits are byte-identical, in order, at the end of the sheet", LIMITS.length === 11 && createHash("sha256").update(LIMITS.join("\n")).digest("hex") === "93b7b7be293b86818dc68b2de54ffa74f1b183f501a2125ddc287fa38aa15889" && JSON.stringify(capabilitySheet().slice(-11)) === JSON.stringify(LIMITS));
// The trim's borderline items 1 and 2 stay: the location line's privacy limits and the file line.
check("the save_ask line keeps that events where investors or sponsors show up are searched", capabilitySheet().some((c) => /events where investors or sponsors show up are searched/.test(c)));
check("the location line keeps its limits, and the PDF line keeps that Cue doesn't discuss what a PDF says", capabilitySheet().some((c) => /only for that event, only to notice arrival and leave/.test(c)) && capabilitySheet().some((c) => /Cue doesn't read or discuss what a PDF says in conversation/.test(c)));
// A line whose ability applies only sometimes carries its condition in its words, so the sheet stays the same on every turn.
check("the first read's line carries its conditions (first conversation only; when Cue can text them first)", capabilitySheet().some((c) => /first conversation only/.test(c) && /when Cue can text them first/.test(c)));
// Limit lines kept in short form (review of #341): a missing detail about something sent, a place on an ask, the details kit.
check("the sheet keeps the short limits: no digging up a sent item's missing detail, an ask's own place, never guessing a detail and asking once", capabilitySheet().some((c) => /can't dig up a missing detail about something already sent/.test(c) && /an ask that names a place keeps it, and their home city stays/.test(c)) && capabilitySheet().some((c) => /never guessing/.test(c) && /asks for whatever is missing once/.test(c)));
check("the trimmed sheet is under 2,400 tokens (estimate: 3.5 characters a token)", Math.ceil(capabilitySheet().join("\n").length / 3.5) < 2400, Math.ceil(capabilitySheet().join("\n").length / 3.5));
check("Cue knows it can send its card", facts.some((f) => /contact card/.test(f)));
check("Cue knows it can't start a group text", facts.some((f) => /never starts a group text/.test(f)));
check("Cue knows it never writes a phone number", facts.some((f) => /never writes a phone number/.test(f)));
check("no hand-kept capability list is left", !/STANDING_CAPABILITIES/.test(src("src/harness/replyGrounding.ts")));
check("no em dashes in what Cue reads about itself", !capabilitySheet().some((c) => /—/.test(c)));

console.log(`capability rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
