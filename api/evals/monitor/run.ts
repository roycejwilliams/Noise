// Model-free checks for alert thresholds (harness/monitor.ts) and the call
// audit's rules (harness/callGrounding.ts).
//   npx tsx evals/monitor/run.ts
import "dotenv/config";
import { SIGNALS, shouldAlert, type SignalReading } from "../../src/harness/monitor.js";
import { callAuditChecks } from "../../src/harness/callGrounding.js";

let failed = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const sig = SIGNALS.find((s) => s.key === "reply_redrafted")!;
const reading = (recentBad: number, recentTotal: number, baselineRate: number): SignalReading => ({
  signal: sig, recentBad, recentTotal, recentRate: recentTotal ? recentBad / recentTotal : 0, baselineRate,
});
check("spike alerts", shouldAlert(reading(8, 20, 0.1)));
check("normal rate doesn't", !shouldAlert(reading(3, 30, 0.1)));
check("too few events doesn't", !shouldAlert(reading(2, 3, 0)));
check("high but steady doesn't", !shouldAlert(reading(12, 30, 0.35)));
check("new signal with no baseline alerts", shouldAlert(reading(6, 10, 0)));

const checks = callAuditChecks([
  { quote: "I'll look for designers after we hang up", type: "promise_keepable", what: "a logo designer" },
  { quote: "I'll have three designers for you by Friday", type: "promise_unkeepable", what: "" },
  { quote: "The mixer starts at 6", type: "invented_fact", what: "" },
  { quote: "Great to talk", type: "ok", what: "" },
]);
check("keepable promise passes", checks.find((c) => c.name === "call_promise_keepable")?.pass === true);
check("unkeepable promise fails", checks.find((c) => c.name === "call_promise_unkeepable")?.pass === false);
check("invented fact fails", checks.find((c) => c.name === "call_invented_fact")?.pass === false);
check("ok claims not listed", checks.length === 3);

console.log(`monitor + call audit rules: ${9 - failed}/9 passed`);
if (failed) process.exitCode = 1;
