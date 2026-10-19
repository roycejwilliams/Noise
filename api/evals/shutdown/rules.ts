// Model-free checks for graceful restarts (services/shutdown.ts) and the
// stranded-claim sweep (services/strandedClaims.ts). No network, no DB.
//
//   npx tsx evals/shutdown/rules.ts
import { readFileSync } from "fs";
import { gracefulShutdown, inflightCount, isShuttingDown, onShutdown, onStopAccepting, track, trackedJob } from "../../src/services/shutdown.js";
import { STRANDED_AFTER_MINUTES, strandedArrivalAsksSql, strandedMatchNudgesSql } from "../../src/services/strandedClaims.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the shutdown sequence, for real (short grace so the check is fast)
const order: string[] = [];
let slowDone = false;
let stuckDone = false;
const slowJob = trackedJob("slow", async () => {
  await wait(150);
  slowDone = true;
});
const failingJob = trackedJob("failing", async () => {
  throw new Error("boom");
});
let ranAfter = false;
const lateJob = trackedJob("late", async () => {
  ranAfter = true;
});
onStopAccepting(() => order.push("stop crons"));
onShutdown(() => order.push("flush"));

await failingJob().then(
  () => check("a failing job is logged, never thrown into the scheduler", true),
  () => check("a failing job is logged, never thrown into the scheduler", false),
);
void slowJob();
track(wait(5_000).then(() => (stuckDone = true))); // longer than the grace period
check("running work is tracked", inflightCount() === 2);

let closed = false;
const started = Date.now();
const done = gracefulShutdown("SIGTERM", { close: () => { closed = true; order.push("close server"); } }, 400);
check("shutdown is flagged right away", isShuttingDown());
await lateJob();
check("no new job runs start once shutdown begins", !ranAfter);
await done;
const took = Date.now() - started;
check("a running job is waited for and finishes", slowDone);
check("the server stops taking connections", closed);
check("work stuck past the grace period doesn't hold the exit forever", !stuckDone && took < 1_500);
check("order: stop crons, close server, then flush last", order.join(",") === "stop crons,close server,flush");
await gracefulShutdown("SIGTERM", null, 10);
check("a second signal doesn't run it twice", order.length === 3);

// ---- the sweep's queries
const asks = strandedArrivalAsksSql();
const nudges = strandedMatchNudgesSql();
check("arrival sweep only touches asks still pending", /WHERE ask_pending AND asked_at < NOW\(\) - INTERVAL/.test(asks));
check("arrival sweep resets the ask so the day-of run asks again", /SET asked_at = NULL, ask_pending = false/.test(asks));
check("nudge sweep only removes claims still pending", /DELETE FROM event_guest_match_nudges\s+WHERE pending AND sent_at < NOW\(\) - INTERVAL/.test(nudges));
check("stranded means minutes old, not an in-flight send", STRANDED_AFTER_MINUTES >= 5);

// ---- wiring
const presence = src("src/services/eventPresence.ts");
// The day-of ask became the pre-arrival text (2026-09-30), which goes through the
// proactive queue: marked sent in the same transaction as the send, so a crash
// can't leave it "done" with nothing delivered.
check("the pre-arrival text goes through the queue, not a claim-then-send of its own", /type: "pre_arrival",/.test(presence) && !/sendblue\.messages\.send\(\{ number: m\.phone_number, content: message/.test(presence));
const scoring = src("src/services/eventScoring.ts");
check("nudge claim marks itself pending", /score, pending\)\s+VALUES \(\$1, \$2, \$3, \$4, true\)/.test(scoring));
check("nudge clears pending after the send, before anything else", /return false;\n\s+\}\n\n\s+\/\/ Sent:[^\n]*\n\s+await pool\n\s+\.query\(`UPDATE event_guest_match_nudges SET pending = false/.test(scoring));
const migrations = src("src/db/migrations.ts");
check("old rows count as sent (default false)", /ask_pending BOOLEAN NOT NULL DEFAULT false/.test(migrations) && /ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false/.test(migrations));
const jobs = src("src/jobs/index.ts");
check("every scheduled job goes through the tracked scheduler", /^import cron from "\.\/cron\.js";/m.test(jobs) && !/node-cron/.test(jobs));
check("the sweep is scheduled", /releaseStrandedClaims\(\)/.test(jobs));
check("the scheduler wrapper tracks and stops each task", /trackedJob\(/.test(src("src/jobs/cron.ts")) && /task\.stop\(\)/.test(src("src/jobs/cron.ts")));
// The turn runs inside its trace-text scope (services/llmTraceText.ts traceTurn); it's still the same tracked turn.
check("a text mid-reply is waited for", /await track\(lockKey \? withPhoneLock\(lockKey, \(\) => traceTurn\(run\)\) : traceTurn\(run\)\);/.test(src("src/routes/sendblue.ts")));
for (const [name, file] of [["api", "src/server.ts"], ["co-test", "../co-test/src/server.ts"]] as const) {
  const s = src(file);
  check(`${name} server installs the shutdown handler`, /installGracefulShutdown\(httpServer\)/.test(s));
  check(`${name} server tracks requests`, /app\.use\(trackRequests\)/.test(s));
}
for (const [name, file] of [["api", "src/telemetry.ts"], ["co-test", "../co-test/src/telemetry.ts"]] as const) {
  check(`${name} flushes the cost log and traces on shutdown`, /onShutdown\(\(\) => sdk\.shutdown\(\)\)/.test(src(file)));
}
for (const [name, file] of [["co-test", "../railway.toml"], ["api", "railway.toml"]] as const) {
  check(`${name} railway.toml gives the old server time to finish`, /^drainingSeconds = 30$/m.test(src(file)));
}

console.log(`shutdown rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
