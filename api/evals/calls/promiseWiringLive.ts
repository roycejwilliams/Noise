// Live check (Layer 2, metered, Sonnet, a few cents): every promise Co makes on a call opens a real thread after it (#113).
// Three real simulated calls (fictional Jordan, 2026-10-08 call eval), read by the same post-call readers a real call gets:
//   - the member's own asks become tasks (services/callTasks.ts): the caterer/photographer request must open one
//   - Co's own casual promises ("you'll hear from me", "keep an ear out") must each open a promise thread, never one search
// Nothing is written: tasks are stubbed, and the audit runs dry.
//   railway run --service co-test --environment dev -- npm run -s eval:live -- evals/calls/promiseWiringLive.ts
import "../lib/requireMeter.js";
import "dotenv/config";
import fs from "node:fs";
const T = await import("../../src/services/callTasks.js");
const G = await import("../../src/harness/callGrounding.js");
const { COMMIT_PREFIX } = await import("../../src/services/callCommitments.js");
const calls: Record<string, string> = JSON.parse(fs.readFileSync(new URL("./fixtures/promiseCalls.json", import.meta.url), "utf8"));
const known = "Jordan runs a small brand design studio (3 people) in SF, in Hayes Valley. Planning a November open house for about 40 people at the studio. Likes small dinners, hates big networking mixers. Climbs on weekends.";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 900)}` : ""}`); } else console.log(`ok   ${label}`); };

// 1. The caterer/photographer request opens a task.
const started: { goal: string; theirWords: string }[] = [];
const goals = await T.tasksFromCall("eval-user", calls.help_over_days, {
  read: T.readWanted,
  start: (async (i: any) => { started.push({ goal: i.goal, theirWords: i.theirWords }); return { ok: true, task: { id: started.length } }; }) as any,
  alreadyDone: async () => false,
  record: async () => {},
  existing: async () => [],
});
check(`help_over_days: their caterer/photographer request opens a task (${goals.join(" | ")})`, started.some((s) => /cater|photograph/i.test(s.goal)), started);

// 2. Every keepable promise Co made, on each call, maps to something that opens.
for (const [id, transcript] of Object.entries(calls)) {
  const plan = await G.auditCall("eval-user", transcript, known, { dryRun: true, tasks: id === "help_over_days" ? started.map((s, i) => ({ id: i + 1, goal: s.goal, theirWords: s.theirWords, createdAt: new Date().toISOString() })) : [] });
  if (!plan) { check(`${id}: the audit ran`, false); continue; }
  const opens = plan.promises.map((p) => ({ what: p.what, said: p.quotes[0]?.slice(0, 90), opens: G.promiseOpens(p) }));
  console.log(`  ${id}: ${JSON.stringify(opens)}`);
  check(`${id}: Cue's promises were found (${plan.promises.length})`, plan.promises.length > 0);
  if (id === "help_over_days") check("help_over_days: the caterer/photographer commitment, said several ways, is the one task, never a second thread", plan.promises.filter((p) => /cater|photograph/i.test(p.what)).every((p) => G.promiseOpens(p) === "task_from_call"), opens);
  for (const p of plan.promises.filter((x) => G.promiseOpens(x) === "promise_thread")) {
    const t = G.promiseThreadTask(p, "");
    check(`${id}: "${p.what.slice(0, 60)}" opens a look-out thread, never mistaken for a send due after the call`, t.goal.startsWith(G.PROMISE_THREAD_PREFIX) && !t.goal.startsWith(COMMIT_PREFIX) && t.source === "lookout");
  }
}
const playful = await G.auditCall("eval-user", calls.playful, known, { dryRun: true, tasks: [] });
check(`playful: "you'll hear from me" is caught as Cue's own promise and opens a thread`, !!playful?.promises.some((p) => G.promiseOpens(p) === "promise_thread"), playful?.promises);

console.log(`promise wiring (live): ${total - failed}/${total} passed`);
if (failed) process.exit(1);
