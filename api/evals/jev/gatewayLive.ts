// End to end: Co's three real checks with Jev through Vercel's gateway (zero
// data retention) vs Haiku only (JEV_MEMBER=off), on the 32 labelled texts.
//
//   railway run --service co-test --environment dev -- npx tsx evals/jev/gatewayLive.ts
import "../lib/requireMeter.js";
import "dotenv/config";
import { CASES, type Feel } from "./cases.js";
import { detectSeekingMode } from "../../src/services/emotionalTone.js";
import { classifyIssue } from "../../src/services/issueReports.js";
import { readTextEmotion } from "../../src/harness/emotion.js";
import { JEV_MODEL_ID, jevForMemberText, setJevGatewayForTests, type JevBool } from "../../src/services/jevGateway.js";
import { experimental_evaluate as evaluate } from "ai7";
import { createGateway } from "@ai-sdk/gateway";

// Test only: retry when TypeSafe is busy (429), so the run measures Jev's
// answers, not its capacity. Co itself never retries (straight to Haiku).
const gw = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
const stats = { asked: 0, answered: 0, busy: 0 };
setJevGatewayForTests(async (state: unknown, questions: Record<string, JevBool>) => {
  stats.asked++;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r: any = await evaluate({ model: gw.evaluationModel(JEV_MODEL_ID), state: state as any, questions: questions as any, maxRetries: 0, providerOptions: { gateway: { zeroDataRetention: true } } });
      stats.answered++;
      return Object.fromEntries(Object.keys(questions).map((k) => [k, r.answers[k].probability]));
    } catch (e: any) {
      if (e?.statusCode !== 429) return null;
      stats.busy++;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  return null;
});
// JEV_NO_TEST_RETRY=1: call Jev exactly as Co does (no retries).
if (process.env.JEV_NO_TEST_RETRY) setJevGatewayForTests(null);

async function run(mode: "jev" | "haiku") {
  process.env.JEV_MEMBER = mode === "jev" ? "on" : "off";
  const score = { s: 0, i: 0, f: 0, feelingPresent: 0 };
  let ms = 0;
  for (const c of CASES) {
    const t = Date.now();
    const [s, i, f] = await Promise.all([
      detectSeekingMode(c.msg, c.convo, "eval.gateway.seeking").then((m) => m === "solving"),
      classifyIssue(c.msg, c.convo).then((r) => r !== null).catch(() => false),
      readTextEmotion(c.msg, c.convo, "eval.gateway.emotion").then((e): Feel => (e ? (e.target === "co" ? "co" : "life") : "none")),
    ]);
    ms += Date.now() - t;
    if (s === c.solving) score.s++;
    if (i === c.issue) score.i++;
    if (f === c.feel) score.f++;
    if ((f !== "none") === (c.feel !== "none")) score.feelingPresent++;
  }
  return { ...score, ms: Math.round(ms / CASES.length) };
}

process.env.JEV_MEMBER = "on";
if (!jevForMemberText()) {
  console.log("Jev isn't available for member text here (needs AI_GATEWAY_API_KEY).");
  process.exit(0);
}
const jev = await run("jev");
const haiku = await run("haiku");
const n = CASES.length;
const row = (name: string, a: number, b: number) => console.log(`${name.padEnd(28)} ${`${b}/${n}`.padEnd(12)} ${a}/${n}`);
console.log(`${n} labelled texts                 Haiku only   Jev (zero retention) + Haiku`);
row("Seeking mode", jev.s, haiku.s);
row("Issue report", jev.i, haiku.i);
row("Feeling present?", jev.feelingPresent, haiku.feelingPresent);
row("Feeling + about Co/life", jev.f, haiku.f);
console.log(`${"Time per text (3 checks)".padEnd(28)} ${`${haiku.ms}ms`.padEnd(12)} ${jev.ms}ms (includes test-only retries)`);
console.log(`Jev asked ${stats.asked}, answered ${stats.answered}, busy responses retried ${stats.busy}`);
process.exit(0);
