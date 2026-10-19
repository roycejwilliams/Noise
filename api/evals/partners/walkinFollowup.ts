// A member checked in at a partner night writes event_walkin_checkins with the night's "partner-…" id (routes/sendblue.ts). The walk-in
// follow-up job (jobs/index.ts, every 15 minutes) looks each event's end up on Luma; a partner night isn't on Luma, so it used to call
// Luma for that id every 15 minutes forever and never resolve the row (review of #212). Partner nights are now left out: the query
// skips them and the loop never asks Luma about one.
// Layer 1: registerJobs runs against a recording scheduler, a fake store and a recording fetch. Nothing is scheduled, nothing is sent,
// no network. Zero tokens.
//   npx tsx evals/partners/walkinFollowup.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.LUMA_API_KEY = "unused-in-tests";
delete process.env.MONITORING_ENABLED;
delete process.env.DEV_REVIEW;

const PARTNER = "partner-0123456789abcdef";
const LUMA = "evt-luma-walkin";
const { default: pool } = await import("../../src/db/db.js");
const queries: string[] = [];
// The due-rows read answers with one partner-night row and one Luma row whatever its filter says, so the loop itself is tested too.
(pool as any).query = async (sql: string) => {
  const q = String(sql).replace(/\s+/g, " ").trim();
  queries.push(q);
  if (q.includes("FROM event_walkin_checkins ewc")) {
    return {
      rows: [
        { id: "w1", event_api_id: PARTNER, ask_text: null, user_id: "00000000-0000-0000-0000-0000000000a1", city: null },
        { id: "w2", event_api_id: LUMA, ask_text: null, user_id: "00000000-0000-0000-0000-0000000000a2", city: null },
      ],
      rowCount: 2,
    };
  }
  return { rows: [] as any[], rowCount: 0 };
};
(pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });

// Every outbound request is recorded and answered "not found": the Luma row then waits for the next tick, as when Luma can't confirm.
const fetched: string[] = [];
(globalThis as any).fetch = async (url: unknown) => {
  fetched.push(String(url));
  return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
};

const { default: cron } = await import("../../src/jobs/cron.js");
const jobs = await import("../../src/jobs/index.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

const scheduled: { expr: string; fn: (...a: any[]) => unknown; body: string }[] = [];
const realSchedule = (cron as any).schedule;
(cron as any).schedule = (expr: string, fn: (...a: any[]) => unknown) => { scheduled.push({ expr, fn, body: String(fn) }); return { stop() {} }; };
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (() => 0) as any;
try {
  jobs.registerJobs({ to: () => ({ emit() {} }), emit() {} } as any);
} finally {
  (cron as any).schedule = realSchedule;
  globalThis.setTimeout = realSetTimeout;
}

const job = scheduled.filter((j) => j.expr === "*/15 * * * *" && j.body.includes("event_walkin_checkins ewc"));
check("the walk-in follow-up job is scheduled every 15 minutes (sanity)", job.length === 1, scheduled.map((j) => j.expr));
if (job.length === 1) {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  try {
    await job[0].fn();
  } finally {
    console.error = realError;
  }
  const read = queries.find((q) => q.includes("FROM event_walkin_checkins ewc")) ?? "";
  check("the due-rows read leaves partner nights out", read.includes("ewc.event_api_id NOT LIKE 'partner-%'"), read);
  check("a partner night's check-in never calls Luma", !fetched.some((u) => u.includes(PARTNER)), fetched);
  check("a partner night's check-in logs no Luma failure", !errors.some((e) => e.includes(PARTNER)), errors);
  check("a Luma event's check-in still looks its end up on Luma", fetched.some((u) => u.includes(LUMA)), fetched);
}

console.log(`\npartner walk-in follow-up: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
