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
{
  // 2026-10-29: the alert starts with the turn's read and is awaited where it joins the reply's facts, so the turn waits on the
  // slower of the two instead of readTurn and then the alert in a row. Same alert, same 1.5s cap, same line in the reply.
  const sb = src("src/routes/sendblue.ts");
  const start = sb.indexOf("const privacyP = hasText ? privacyAlert(resolvedContent).catch(() => null) : null;");
  check("the alert starts right after the read starts, before the read is awaited", start > sb.indexOf("const readP: Promise<TurnRead> | null =") && start < sb.indexOf("turnRead = await readP;"));
  check("the alert is added before Cue replies", /if \(privacyP\) \{\s*const alert = await privacyP;\s*if \(alert\) \{\s*addInstruction\(replyFacts, alert\.instruction\);\s*recordDecision\(\{ layer: 3, decision: "jev\.privacy"/.test(sb));
  check("nothing awaits the alert on its own any more (one start, one await)", (sb.match(/privacyAlert\(/g) ?? []).length === 1 && !/await privacyAlert\(/.test(sb));
  check("the alert keeps its 1.5s cap", /\},\s*1500,\s*\)\.catch\(\(\) => null\);/.test(src("src/services/privacyAlert.ts")));

  // Measured with stubbed timers (virtual clock): readTurn takes 3.6s (the 10-29 median) and Jev answers at its 1.5s cap. The
  // turn's order, as routes/sendblue.ts runs it (pinned by the checks above): start the read, start the alert, await the read
  // (the ack, routing and the reply's facts happen here), then await the alert where it joins the facts.
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const after = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const drive = async (p: Promise<number>) => {
    let done = false;
    p.then(() => (done = true), () => (done = true));
    for (let i = 0; i < 400 && !done; i++) {
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(25);
    }
    return p;
  };
  setJevGatewayForTests(async () => (await after(1500), { other_person: 0.94, contact_someone: 0.02 }));
  const readTurnStub = () => after(3600);
  const before = await drive((async () => {
    const t0 = Date.now();
    await readTurnStub();
    const alert = await privacyAlert("what did Noor tell you", on);
    return alert ? Date.now() - t0 : -1;
  })());
  let alertNow: Awaited<ReturnType<typeof privacyAlert>> = null;
  const now = await drive((async () => {
    const t0 = Date.now();
    const readP = readTurnStub();
    const privacyP = privacyAlert("what did Noor tell you", on).catch(() => null);
    await readP;
    alertNow = await privacyP;
    return alertNow ? Date.now() - t0 : -1;
  })());
  mock.timers.reset();
  setJevGatewayForTests(null);
  console.log(`  privacy alert timing (virtual clock): read then alert ${before}ms, together ${now}ms`);
  check("before: the turn waited readTurn + the alert in a row (~5.1s)", before >= 5100 && before < 5200);
  check("now: the turn waits only for the slower of the two (~3.6s, 1.5s saved)", now >= 3600 && now < 3700);
  check("...with the same alert and the same 'share nothing about others' line", (alertNow as any)?.kind === "other_person" && /Share nothing about anyone else/.test((alertNow as any)?.instruction ?? ""));
}

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
