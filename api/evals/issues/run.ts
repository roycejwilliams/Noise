// Issue reports eval (services/issueReports.ts).
//
//   npx tsx evals/issues/run.ts          the plain-rule gate
//   npx tsx evals/issues/run.ts --live   also the model's confirm step
//
// Hard: a real report the gate lets past (it would never be saved), or a
// person's own life problem saved as a report about Co.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { captureEnabled, classifyIssue, mayBeIssueReport } from "../../src/services/issueReports.js";
import { runEval, type CaseScore, type EvalCase } from "../lib.js";

type Case = EvalCase & { message: string; recentConversation?: string; isIssue: boolean; category?: string };

const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");

const cases: Case[] = [
  { id: "i01_sent_twice", message: "You sent the same thing twice", isIssue: true, category: "bug" },
  { id: "i02_wrong_link", message: "That link you sent is broken, it goes nowhere", isIssue: true, category: "bug" },
  { id: "i03_made_up", message: "Co that event doesn't exist, you made it up", isIssue: true, category: "wrong_info" },
  { id: "i04_slow", message: "why did that take you so long to answer", isIssue: true, category: "speed" },
  { id: "i05_feedback", message: "Feedback: it'd be nice if you sent the time with the link", isIssue: true, category: "feature_request" },
  { id: "i06_ignored", message: "you didn't answer what I actually asked", isIssue: true, category: "behavior" },
  { id: "i07_repeat_event", message: "What was the reason for you repeating the same event?", isIssue: true, category: "bug" },
  { id: "i08_own_bad_day", message: "Rough day, my cofounder and I had a problem with the deck", isIssue: false },
  { id: "i09_normal_ask", message: "Can you find me AI meetups this weekend?", isIssue: false },
  { id: "i10_thanks", message: "Thanks Co!", isIssue: false },
  { id: "i11_work_bug", message: "Spent all day fixing a bug in our payments code", isIssue: false },
];

async function run(c: Case) {
  const gate = mayBeIssueReport(c.message);
  const report = live && gate ? await classifyIssue(c.message, c.recentConversation ?? `User said: ${c.message}`) : null;
  return { gate, report };
}

function score(c: Case, r: { gate: boolean; report: Awaited<ReturnType<typeof classifyIssue>> }): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  if (c.isIssue && !r.gate) hard.push(`the gate let a real report past: "${c.message}"`);
  if (live) {
    const saved = !!r.report;
    if (c.isIssue && !saved) hard.push(`real report not saved: "${c.message}"`);
    if (!c.isIssue && saved) hard.push(`saved a non-report as an issue: "${c.message}" -> ${r.report?.summary}`);
    if (c.isIssue && c.category && r.report) soft.push({ name: "category", ok: r.report.category === c.category });
    if (r.report) console.log(`  [${c.id}] ${r.report.category}/${r.report.severity}: ${r.report.summary}`);
  } else {
    soft.push({ name: "gate skips obvious non-reports", ok: c.isIssue || !r.gate });
  }
  return { hard, soft };
}

// Dev only: never on in production, whatever the flag says.
const guard: [boolean, string][] = [
  [captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test", CAPTURE_USER_ISSUES: "true" }), "on for co-test in dev with the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test" }), "off for co-test without the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "CoPatible", CAPTURE_USER_ISSUES: "true" }), "off in production even with the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "co-test", CAPTURE_USER_ISSUES: "true" }), "off in production even named co-test"],
  [!captureEnabled({ CAPTURE_USER_ISSUES: "true" }), "off locally or anywhere without Railway's dev environment"],
];
const guardFailures = guard.filter(([ok]) => !ok);
for (const [, label] of guardFailures) console.log(`FAIL dev-only guard: ${label}`);
console.log(`issue reports dev-only guard: ${guard.length - guardFailures.length}/${guard.length} passed`);
if (guardFailures.length) process.exitCode = 1;

await runEval<Case, any>({ name: live ? "issue reports (live)" : "issue reports (gate)", dir: here, cases, concurrency: 4, run, score });
