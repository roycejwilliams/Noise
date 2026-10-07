// Round 1, re-scored with the scripted Peerspace date step (services/peerspaceSlot.ts) as the old reader: no model calls.
// Writes a results file with old = scripted, sdk = the round-1 SDK answers, for score.ts.
//   npm run eval:live -- evals/browserPilot/runScripted.ts <round-1 results file>
import "../lib/requireMeter.js";
import { readFileSync, writeFileSync } from "node:fs";
const P = await import("../../src/services/peerspaceSlot.js");
const R = await import("../../src/services/browserRead.js");
const round1 = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cases = [];
for (const c of round1.cases) {
  const t0 = Date.now();
  const r = await P.readPeerspaceSlot(c.url, { date: "2026-10-22", start: "6:00 pm" });
  const ms = Date.now() - t0;
  console.log(`${c.url.slice(-24)} ${ms}ms ${JSON.stringify(r?.facts ?? null)}`);
  cases.push({ url: c.url, old: { facts: r?.facts ?? null, ms, usd: 0, usage: { input: 0, output: 0 }, gotText: !!r }, sdk: c.sdk });
}
const out = new URL(`./results/scripted-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ when: round1.when, total: round1.cases.reduce((a: number, c: any) => a + c.sdk.usd, 0), cases }, null, 2));
console.log(out.pathname);
await R.closeBrowser();
