// Model-free checks for alert thresholds (harness/monitor.ts) and the call
// audit's rules (harness/callGrounding.ts).
//   npx tsx evals/monitor/run.ts
import { ABILITIES } from "../../src/services/capabilities.js";
import { EXTENSIONS } from "../../src/services/extensions.js";
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


// Every signal reads a decision the code actually writes (2026-09-16: new
// records for the city guard, the contact card and held-back reactions).
const WRITTEN_DECISIONS = [
  "reply.grounding", "proactive.dailyPick", "recommendation.search", "turn.latency", "call.grounding",
  "profile.snapshotCheck", "profile.city", "turn.closing", "router.decideActions",
  "proactive.windowFollowUp", "proactive.exemptSend", "tier1.announce", "call.gate",
  // Written by the companion cron (jobs/index.ts, services/understanding.ts).
  "understanding.check",
  // Written by the daily sweep's finding (services/sweepFind.ts).
  "sweep.find",
  // Cold start (services/coldStart.ts): a new member's sweep, a hit or a miss; what a reply to an unseeded member did with steering.
  "sweep.cold_start_miss", "coldstart.reply",
  // A picker claim check that couldn't run (services/sweepShadow.ts, 2026-10-14).
  "picker.claim_check_failed",
  // Every tool Co chooses writes tool.<name> (agent/toolGuard.ts, 2026-09-25).
  "tool.%", ...ABILITIES.filter((a) => a.tool).map((a) => `tool.${a.tool}`),
  // Extensions' tools write the same, per team turn (services/extensions.ts).
  ...EXTENSIONS.flatMap((e) => [`${e.id}.teamTurn`, ...e.abilities.filter((a) => a.tool).map((a) => `tool.${a.tool}`)]),
];
for (const signal of SIGNALS) {
  const named = WRITTEN_DECISIONS.find((d) => signal.bad.includes(`'${d}'`));
  // How often each tool is used is measured per reply on purpose.
  if (named && signal.key.startsWith("tool_use_") && signal.total.includes("'turn.latency'")) continue;
  if (named && signal.key.startsWith("tool_use_") && EXTENSIONS.some((e) => signal.total.includes(`'${e.id}.teamTurn'`))) continue;
  if (!named) {
    failed++;
    console.log(`FAIL signal ${signal.key}: watches a decision nothing writes`);
  }
  if (!signal.total.includes(`'${named}'`)) {
    failed++;
    console.log(`FAIL signal ${signal.key}: its share is measured against a different decision`);
  }
}

console.log(`monitor + call audit rules: ${9 + SIGNALS.length * 2 - failed}/${9 + SIGNALS.length * 2} passed`);
if (failed) process.exitCode = 1;
