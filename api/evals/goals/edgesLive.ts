// LIVE (layer 2, metered, one Haiku call, under $0.01): the findable edges of real goals (Royce's, 2026-10-08), nothing written.
//   npm run eval:live -- evals/goals/edgesLive.ts
import "dotenv/config";
import "../lib/requireMeter.js";
const G = await import("../../src/services/goalEdges.js");
const CC = await import("../../src/services/callContext.js");
const goals = [
  "pivoting to a partnership with Sequin AI after canceling the October launch date",
  "partnering with Sequin AI for a November launch party",
  "build alignment with Sequin AI for event partnership",
  "have Co draft planning docs for branding and launch strategy with Sequin AI",
  "maintain Co's presence after the November event",
  "find a builder or founder community in SF",
];
const logs: any[] = [];
const p = await G.planGoalSweep("u-live", goals, { city: "San Francisco", zone: "America/Los_Angeles", now: new Date("2026-10-08T17:00:00Z") }, {
  ...G.realGoalDeps, states: async () => new Map(), setState: async () => {}, corrections: async () => [], retired: CC.retiredBy, findAsks: async () => [], helpAsk: async () => {}, log: async (d) => { logs.push(d); },
});
let total = 0, failed = 0;
const check = (l: string, ok: boolean, d?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${l}${d !== undefined ? `\n  ${JSON.stringify(d).slice(0, 600)}` : ""}`); } };
for (const e of p.active) console.log(`  ${e.kind.padEnd(8)} ${e.goal.slice(0, 60)}  ->  ${e.edges.join(" | ")}`);
for (const x of p.passed) console.log(`  passed   ${x.goal.slice(0, 60)}  (${x.why})`);
console.log(`  search: ${p.searchText}`);
check("never a goal's own words in the search", !!p.searchText && !goals.some((g) => p.searchText!.toLowerCase().includes(g.toLowerCase())), p.searchText);
check("Co's own tasks are co_task", [...p.active, ...p.passed.map((x) => ({ goal: x.goal, kind: x.why.split(":")[0] }))].filter((e: any) => /have Co draft|maintain Co's/.test(e.goal)).every((e: any) => e.kind === "co_task"));
check("the findable goal has a findable edge", p.active.some((e) => /builder or founder community/.test(e.goal)));
console.log(`goal edges (live): ${total - failed}/${total} passed`);
if (failed) process.exit(1);
