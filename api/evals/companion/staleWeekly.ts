// The stale-page watcher runs weekly, not hourly (efficiency audit, 2026-10-29: a month of hourly runs found 0 changes and told 0
// members), and carries its retirement date. Layer 1: reads the schedule from the source, no clock, no database.
//   npx tsx evals/companion/staleWeekly.ts
import { readFileSync } from "fs";
import nodeCron from "node-cron";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const jobs = src("jobs/index.ts");
// Every cron.schedule call whose job runs the watcher: its expression and options.
const calls = [...jobs.matchAll(/cron\.schedule\("([^"]+)",\s*async \(\) => \{([\s\S]*?)\n  \}(, \{[^}]*\})?\);/g)].filter((m) => /watchSentPages/.test(m[2]));
check("the watcher is scheduled exactly once", calls.length === 1, calls.map((m) => m[1]));
const expr = calls[0]?.[1] ?? "";
const [minute, hour, dom, month, dow] = expr.split(/\s+/);
check("a valid cron expression", nodeCron.validate(expr), expr);
check("weekly: one fixed minute, hour and weekday, every month", /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && dom === "*" && month === "*" && /^[0-6]$/.test(dow ?? ""), expr);
check("in Pacific time (not the server's UTC)", /timezone: "America\/Los_Angeles"/.test(calls[0]?.[3] ?? ""), calls[0]?.[3]);
check("the retirement date is in the code beside the schedule", /Retire on 2026-11-26 unless it has found something/.test(jobs) && /Retire on 2026-11-26 unless it has found something/.test(src("services/staleWatch.ts")));
// What a run does is unchanged: the same 3-day window, the same 25-page cap, the same "only the interested hear it".
const sw = src("services/staleWatch.ts");
check("a weekly run looks back a full week, so every send is seen once", /ro\.sent_at > NOW\(\) - INTERVAL '7 days'/.test(sw) && !/INTERVAL '3 days'/.test(sw));
check("a run is otherwise unchanged (25 pages, interested members only, event-change path)", /\.slice\(0, 25\)/.test(sw) && /result IN \('interested', 'acted'\)/.test(sw) && /sendExemptWhenAllowed/.test(sw));

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
