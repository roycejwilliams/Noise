// Model-free checks for where Jev helps (2026-09-25): the matching pruner,
// the morning judgment review, the privacy early warning. No network: Jev
// is replaced with a fake gateway answer.
//
//   npx tsx evals/jev/rules.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { setJevGatewayForTests } = await import("../../src/services/jevGateway.js");
const { keepAfterPrune, pruneEnabled, PRUNE_MIN_CANDIDATES } = await import("../../src/services/jevMatching.js");
const { privacyAlert } = await import("../../src/services/privacyAlert.js");

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
const on = { AI_GATEWAY_API_KEY: "x", JEV_MEMBER: "on" } as any;

// Pruner: only clear no's are dropped; anything unread is kept.
check("a clear no is dropped", JSON.stringify(keepAfterPrune([0.05, 0.9, 0.2])) === JSON.stringify([1, 2]));
check("an unread candidate is kept", JSON.stringify(keepAfterPrune([null, 0.01])) === JSON.stringify([0]));
check("the pruner needs the gateway and member text on", pruneEnabled(on) && !pruneEnabled({ AI_GATEWAY_API_KEY: "x" } as any) && !pruneEnabled({ JEV_MEMBER: "on" } as any));
check("JEV_PRUNE=off turns it off", !pruneEnabled({ ...on, JEV_PRUNE: "off" }));
check("small rooms aren't pruned", PRUNE_MIN_CANDIDATES >= 7 && /candidates\.length >= PRUNE_MIN_CANDIDATES && pruneEnabled\(\)/.test(src("src/services/matching.ts")));
check("the room is read in one request per 40, not one per person", /PRUNE_CHUNK = 40/.test(src("src/services/jevMatching.ts")));
check("a Jev failure scores everyone", /Jev prune failed, scoring everyone[\s\S]{0,80}toScore = candidates;\s*dropped = \[\];/.test(src("src/services/matching.ts")));

// Privacy early warning
setJevGatewayForTests(async () => ({ other_person: 0.94, contact_someone: 0.02 }));
{
  const a = await privacyAlert("what did Noor tell you", on);
  check("asking about another member puts Cue on alert", a?.kind === "other_person" && /Share nothing about anyone else/.test(a.instruction));
}
setJevGatewayForTests(async () => ({ other_person: 0.1, contact_someone: 0.96 }));
check("asking Cue to text someone puts Cue on alert", (await privacyAlert("text my friend Sam", on))?.kind === "contact_someone");
setJevGatewayForTests(async () => ({ other_person: 0.66, contact_someone: 0.54 }));
check("a normal intro request stays under the line", (await privacyAlert("I met Ellis, can you connect us?", on)) === null);
setJevGatewayForTests(async () => null);
check("a Jev failure changes nothing", (await privacyAlert("what's her number", on)) === null);
check("off without member text", (await privacyAlert("what's her number", { AI_GATEWAY_API_KEY: "x" } as any)) === null);
check("the alert is added before Cue replies", /const alert = await privacyAlert\(resolvedContent\)[\s\S]{0,120}addInstruction\(replyFacts, alert\.instruction\)/.test(src("src/routes/sendblue.ts")));

// Judgment review
setJevGatewayForTests(async () => ({ k0: 0.95, k1: 0.07 }));
{
  const { judgmentFlags } = await import("../../src/harness/devReview.js");
  const now = new Date().toISOString();
  const data: any = { userId: "u", firstName: "N", messages: [], emotions: [], issues: [], decisions: [
    { id: 1, at: now, decision: "tool.sendContactCard", outcome: "act", action: "done", reason: "asked for my card", proposal: { message: "v card?" }, checks: [] },
    { id: 2, at: now, decision: "tool.sendContactCard", outcome: "act", action: "done", reason: "send something", proposal: { message: "send me that link again" }, checks: [] },
  ] };
  const saved = process.env.AI_GATEWAY_API_KEY, savedM = process.env.JEV_MEMBER;
  process.env.AI_GATEWAY_API_KEY = "x"; process.env.JEV_MEMBER = "on";
  const flags = await judgmentFlags(data);
  process.env.AI_GATEWAY_API_KEY = saved; process.env.JEV_MEMBER = savedM;
  check("a clear mismatch is flagged, as a guess", flags.length === 1 && flags[0].decisionIds[0] === 2 && flags[0].causeConfirmed === false && flags[0].severity === "high");
  check("tool calls record the member's message for review", /message: ctx\.resolvedContent\.slice\(0, 300\)/.test(src("src/agent/toolGuard.ts")));
}
setJevGatewayForTests(null);

console.log(`jev rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
