// The auto-intake call job is parked (Royce, 2026-10-17: "Park the auto-intake call job." / "Auto-intake call job: park it. All 14
// calls were ones members asked for."). jobs/index.ts registerJobs no longer schedules it, so it never dials; its code is kept
// (runAutoIntakeCalls), and the other call jobs (scheduled calls, check-in cadence calls) still run.
// Layer 1: registerJobs runs against a recording scheduler and a fake store. Nothing is scheduled for real, nothing dials. Zero tokens.
//   npx tsx evals/calls/autoIntakeParked.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.MONITORING_ENABLED;
delete process.env.DEV_REVIEW;
const { default: pool } = await import("../../src/db/db.js");
const queries: string[] = [];
(pool as any).query = async (sql: string) => { queries.push(String(sql).replace(/\s+/g, " ").trim()); return { rows: [] as any[], rowCount: 0 }; };
(pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });
const { default: cron } = await import("../../src/jobs/cron.js");
const jobs = await import("../../src/jobs/index.js");
const G = await import("../../src/harness/callGate.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

// Every job registerJobs schedules, with its body's source, captured instead of scheduled. Its startup timer is captured too.
const scheduled: { expr: string; body: string }[] = [];
const realSchedule = (cron as any).schedule;
(cron as any).schedule = (expr: string, fn: (...a: any[]) => unknown) => { scheduled.push({ expr, body: String(fn) }); return { stop() {} }; };
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (() => 0) as any;
try {
  jobs.registerJobs({ to: () => ({ emit() {} }), emit() {} } as any);
} finally {
  (cron as any).schedule = realSchedule;
  globalThis.setTimeout = realSetTimeout;
}

check("registerJobs ran and scheduled the jobs (sanity)", scheduled.length >= 30, scheduled.length);
const dialsIntake = scheduled.filter((j) => /auto_intake|runAutoIntakeCalls/.test(j.body));
check("no scheduled job places an auto-intake call", dialsIntake.length === 0, dialsIntake.map((j) => j.expr));
check("scheduled calls still run (every 5 minutes)", scheduled.some((j) => j.expr === "*/5 * * * *" && /placeDueCalls\(io\)/.test(j.body)));
check("check-in cadence calls (a cadence the member set) still run", scheduled.some((j) => /placeDueProactiveCalls\(io\)/.test(j.body)));

// The code is kept: the job still exists and runs as before when called (here with nobody to call, so it dials no one).
check("the job's code is kept (runAutoIntakeCalls)", typeof (jobs as any).runAutoIntakeCalls === "function");
queries.length = 0;
await (jobs as any).runAutoIntakeCalls?.({ to: () => ({ emit() {} }), emit() {} });
check("called by hand, it still selects members with no intake yet, the same way", queries.some((q) => /FROM users u LEFT JOIN co_profiles cp ON cp\.user_id = u\.id WHERE u\.subscription_status = 'active'/.test(q) && /LIMIT 25/.test(q)), queries.slice(0, 2));

// The call gate is unchanged: auto_intake is still a kind it knows (a call started with no kind can still be inferred as one).
check("the call gate still knows the auto_intake kind", G.RECENT_CALL_MINUTES.auto_intake === 60 * 24 && G.decideAutoIntake({ subscriptionActive: true, member: true, hadRealCall: false, hasRealProfile: false, attempts: 0, lastAttemptAt: null }, new Date()).eligible === true);

console.log(`\nauto-intake parked: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
