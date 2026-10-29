// Model-free checks for Jev through Vercel's gateway (services/jevGateway.ts):
// zero data retention on every request, member text only where allowed, and
// Haiku whenever Jev is unsure or unavailable. No network.
//
//   npx tsx evals/jev/gateway.ts
import "dotenv/config";
import { readFileSync } from "fs";
import { jevForMemberText, JEV_GATEWAY_PROVIDER_OPTIONS, setJevGatewayForTests, JEV_SURE } from "../../src/services/jevGateway.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- zero data retention
check("every Jev request sets zero data retention", JEV_GATEWAY_PROVIDER_OPTIONS.gateway.zeroDataRetention === true);
const g = src("services/jevGateway.ts");
check("the gateway call always passes those options", /providerOptions: JEV_GATEWAY_PROVIDER_OPTIONS/.test(g) && (g.match(/evaluate\(\{/g) ?? []).length === 1);
check("no retries, short timeout (a slow Jev never holds up a reply)", /maxRetries: 0/.test(g) && /AbortSignal\.timeout\(timeoutMs\)/.test(g) && /timeoutMs = 3000/.test(g));
check("errors log class and status only, never the request", /request failed \(non-fatal\): \$\{err\?\.constructor\?\.name/.test(g));

// ---------------------------------------------------------------- who may send member text
const coTest = { AI_GATEWAY_API_KEY: "k", RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test", JEV_MEMBER: "on" } as any;
check("member text goes to Jev only with the gateway key and JEV_MEMBER=on", jevForMemberText(coTest));
check("off by default, even on co-test with the key", !jevForMemberText({ ...coTest, JEV_MEMBER: undefined }));
check("never without the gateway key (no direct TypeSafe route for member text)", !jevForMemberText({ ...coTest, AI_GATEWAY_API_KEY: "", TYPESAFE_API_KEY: "t" }));
check("never in production unless explicitly turned on", !jevForMemberText({ AI_GATEWAY_API_KEY: "k", RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "Noise" } as any));
check("JEV_MEMBER=off turns it off anywhere", !jevForMemberText({ ...coTest, JEV_MEMBER: "off" }));
{
  const direct = src("services/emotionalTone.ts") + src("services/issueReports.ts") + src("harness/emotion.ts");
  check("Cue's checks only reach Jev through the zero-retention gateway", !/typesafe-ai\/sdk|TYPESAFE_API_KEY|jev_co|askJevZdr/.test(direct) && (direct.match(/readTextSignals\(message, recentConversation\)/g) ?? []).length === 3);
  check("each check races Jev against Haiku (never waits on one then the other)", (direct.match(/await raceWithJev</g) ?? []).length === 3);
  check("every Haiku call can be cancelled when Jev wins", (direct.match(/abortSignal,\n/g) ?? []).length === 3);
  check("the three questions go in ONE Jev request per text", /askJevZdr\(\{ latest_message: message, recent_conversation: convo \}, TEXT_SIGNAL_QUESTIONS\)/.test(g) && /memo\.set\(key/.test(g));
  check("readTextSignals only runs when member text is allowed", /if \(!jevForMemberText\(\)\) return Promise\.resolve\(null\);/.test(g));
}

// ---------------------------------------------------------------- the race
{
  const { raceWithJev } = await import("../../src/services/jevGateway.js");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let aborted = false;
  const slowHaiku = async (signal: AbortSignal) => { signal.addEventListener("abort", () => { aborted = true; }); await sleep(300); return "haiku"; };
  const t0 = Date.now();
  const a = await raceWithJev(sleep(20).then(() => ({ value: "jev" })), slowHaiku);
  check("a sure Jev answer wins without waiting for Haiku, and Haiku is cancelled", a.value === "jev" && a.from === "jev" && aborted && Date.now() - t0 < 200);
  const b = await raceWithJev(sleep(20).then(() => null), async () => { await sleep(60); return "haiku"; });
  check("an unsure Jev leaves Haiku's answer", b.value === "haiku" && b.from === "haiku");
  const c = await raceWithJev(Promise.reject(new Error("down")), async () => "haiku");
  check("a failed Jev leaves Haiku's answer", c.value === "haiku");
  const t1 = Date.now();
  const d = await raceWithJev(sleep(500).then(() => ({ value: "jev" })), async () => { await sleep(40); return "haiku"; });
  check("a slow Jev never delays Haiku's answer", d.value === "haiku" && Date.now() - t1 < 300);
}

// ---------------------------------------------------------------- Jev decides only when sure; Haiku otherwise
const { detectSeekingMode } = await import("../../src/services/emotionalTone.js");
const { classifyIssue } = await import("../../src/services/issueReports.js");
const { readTextEmotion } = await import("../../src/harness/emotion.js");
const saved = { ...process.env };
Object.assign(process.env, coTest);
{
  setJevGatewayForTests(async () => ({ solving: 0.95, issue: 0.5, feeling: 0.5 }));
  check("seeking: a sure yes from Jev decides", (await detectSeekingMode("raise now or wait? a", "", "t")) === "solving");
  setJevGatewayForTests(async () => ({ solving: 0.05, issue: 0.05, feeling: 0.05 }));
  check("seeking: a sure no from Jev decides", (await detectSeekingMode("thanks! b", "", "t")) === null);
  check("issue: a sure no from Jev decides without Haiku", (await classifyIssue("thanks! c", "")) === null);
  check("feeling: a sure 'no feeling' decides without Haiku", (await readTextEmotion("what time does it start? d", "", "t")) === null);
}
setJevGatewayForTests(null);
process.env = saved;
check("'sure' means below 0.2 or above 0.8", JEV_SURE.no === 0.2 && JEV_SURE.yes === 0.8);
// ---------------------------------------------------------------- the per-text log
{
  const { buildRaceLog } = await import("../../src/services/jevGateway.js");
  const row = buildRaceLog(
    { feeling: { from: "jev", answer: false }, solving: { from: "haiku", answer: true } },
    { solving: 0.61234, issue: 0.04, feeling: 0.1 },
    372,
  );
  check("log row: named jev.co.race, no user id", row.decision === "jev.co.race" && row.userId === null && row.layer === 2 && row.outcome === "act");
  check("log row: a readable one-line summary in check order", row.action === "solving:haiku feeling:jev");
  check("log row: each check's source and answer", JSON.stringify(row.proposal.checks) === JSON.stringify({ solving: { from: "haiku", answer: true }, feeling: { from: "jev", answer: false } }));
  check("log row: Jev's scores rounded, and how long Jev took", row.proposal.jevAnswered && row.proposal.jevScores?.solving === 0.612 && row.proposal.jevMs === 372);
  check("log row: when Jev didn't answer, that's recorded", buildRaceLog({ solving: { from: "haiku", answer: false } }, null, 3000).proposal.jevAnswered === false);
  check("log row: never carries the message text", !JSON.stringify(row).includes("latest_message") && !/message|convo/.test(Object.keys(row.proposal).join(",")));
  const g2 = src("services/jevGateway.ts");
  check("one row per text, written after the checks report (not three rows)", /setTimeout\(\(\) => void flush\(key\), 5000\)/.test(g2) && /pending\.delete\(key\)/.test(g2));
  const all = src("services/emotionalTone.ts") + src("services/issueReports.ts") + src("harness/emotion.ts");
  check("every check reports its outcome", (all.match(/noteRaceOutcome\(message, recentConversation, "(solving|issue|feeling)", from,/g) ?? []).length === 3);
}

console.log(`jev gateway rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
