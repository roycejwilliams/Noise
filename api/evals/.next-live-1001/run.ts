// Next live-test harness (untracked, local). Usage, from api/:
//   SUITE=delivery ONLY=all RUNS=1 npx --no-install tsx evals/.next-live-1001/run.ts > <fresh log> 2>&1
//   PREFLIGHT_ONLY=1 npx --no-install tsx evals/.next-live-1001/run.ts
// SUITE: matching|events|loops|onboarding|delivery|search|tiers|all. ONLY: case ids, or "all".
import "../lib/requireMeter.js";
import { H, secretsPresent, dbEndpoint, pg } from "./boot.js";
import { execSync } from "node:child_process";

const out = (tag: string, o: unknown) => process.stdout.write(`${tag} ${JSON.stringify(o)}\n`);
const quiet = { log: console.log, error: console.error, warn: console.warn, info: console.info };
const prodLogs: string[] = [];
let caseLogStart = 0;
(globalThis as any).__harnessProdLogs = () => prodLogs.slice(caseLogStart);
console.log = console.info = console.warn = console.error = (...a: any[]) => { if (prodLogs.length < 20000) prodLogs.push(a.map((x) => (typeof x === "string" ? x : x?.message ?? String(x))).join(" ").slice(0, 400)); };

const SUITES = ["matching", "events", "loops", "onboarding", "delivery", "search", "tiers", "context"] as const;
const suiteArg = (process.env.SUITE || "").trim();
const onlyArg = (process.env.ONLY || "").trim();
const runsArg = process.env.RUNS ?? "2";

async function preflight() {
  const checks: Record<string, unknown> = {};
  const fail = (why: string) => { out("NEXT_PREFLIGHT", { ok: false, why, checks }); process.exit(3); };
  // 1. checkout
  const git = (c: string) => execSync(`git ${c}`, { cwd: new URL("../../..", import.meta.url).pathname }).toString().trim();
  checks.head = git("rev-parse HEAD");
  checks.branch = git("rev-parse --abbrev-ref HEAD");
  checks.trackedChanges = git("status --short --untracked-files=no") || "none";
  // NEXT_BRANCH / NEXT_ALLOW_DIRTY: an explicit, logged override for checking a PR branch's uncommitted work.
  const wantBranch = process.env.NEXT_BRANCH || "co-test";
  checks.branchOverride = process.env.NEXT_BRANCH ?? null;
  checks.dirtyAllowed = process.env.NEXT_ALLOW_DIRTY === "1";
  if (checks.branch !== wantBranch) fail(`not on ${wantBranch}`);
  if (checks.trackedChanges !== "none" && !checks.dirtyAllowed) fail("tracked files modified");
  // 3. secrets present (never values)
  checks.secrets = secretsPresent;
  if (!secretsPresent.DATABASE_URL || !secretsPresent.ANTHROPIC_API_KEY || !secretsPresent.OPENAI_API_KEY) fail("missing secret");
  // 4. database destination: local endpoint + the tunnel's own target
  checks.dbEndpoint = { host: dbEndpoint.host, port: dbEndpoint.port, db: dbEndpoint.db };
  try {
    const pid = execSync("lsof -nP -iTCP:55432 -sTCP:LISTEN -t").toString().trim().split("\n")[0];
    const ppid = execSync(`ps -o ppid= -p ${pid}`).toString().trim();
    const parent = execSync(`ps -o command= -p ${ppid}`).toString().trim();
    const child = execSync(`ps -o command= -p ${pid}`).toString().trim();
    const devTunnel = /railway connect Postgres-J3wd\b/.test(parent) && /-p 769e31e2-f831-4ed9-a158-4536cc3556bc\b/.test(parent) && /-e dev\b/.test(parent) && /-L 127\.0\.0\.1:55432:127\.0\.0\.1:5432\b/.test(child) && /@ssh\.railway\.com\b/.test(child);
    checks.tunnel = { devTunnel, parent: parent.replace(/\s+/g, " ").slice(0, 160) };
    if (!devTunnel) fail("tunnel on 55432 is not railway connect Postgres-J3wd -e dev (helpful-stillness)");
  } catch { fail("no tunnel listening on 55432"); }
  // 5. environment
  checks.env = { NODE_ENV: process.env.NODE_ENV, RAILWAY_ENVIRONMENT_NAME: process.env.RAILWAY_ENVIRONMENT_NAME, ALLOW_REAL_SMS: process.env.ALLOW_REAL_SMS };
  // 9. models in code
  const { MODELS } = await import("../../src/models.js");
  checks.models = MODELS;
  // 10. selection
  const runs = Number(runsArg);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) fail(`RUNS must be an integer 1-5 (got ${runsArg})`);
  checks.runs = runs;
  checks.costCapUsd = H.costCapUsd;
  return { checks, runs };
}

async function safetyProbes(DB: typeof import("./db.js")) {
  const r: Record<string, boolean> = {};
  const refused = async (f: () => Promise<any>) => { try { await f(); return false; } catch (e: any) { return e?.code === "HARNESS_REFUSED" || /blocked|refused/i.test(String(e?.message)); } };
  const pool = (await import("../../src/db/db.js")).default as any;
  DB.DBC.probing = true;
  await DB.caseBegin("probe:safety");
  r.publicWriteRefused = await refused(() => pool.query(`INSERT INTO public.harness_decisions (layer, decision, outcome) VALUES (1,'probe','skip')`));
  r.publicReadRefused = await refused(() => pool.query(`SELECT count(*) FROM public.users`));
  r.publicCteRefused = await refused(() => pool.query(`WITH d AS (DELETE FROM public.co_memories WHERE false RETURNING 1) SELECT * FROM d`));
  r.sequenceRefused = await refused(() => pool.query(`SELECT nextval('co_memories_id_seq')`));
  r.unknownSqlRefused = await refused(() => pool.query(`EXPLAIN SELECT 1`));
  r.multiStatementRefused = await refused(() => pool.query(`SELECT 1; SELECT 2`));
  r.ddlRefused = await refused(() => pool.query(`CREATE TABLE x (a int)`));
  r.copyRefused = await refused(() => pool.query(`COPY users TO STDOUT`));
  // Postgres itself refuses a permanent write even if the gate were bypassed.
  r.postgresReadOnlyRefuses = await refused(() => DB.raw(`UPDATE public.users SET first_name = first_name WHERE false`));
  r.rawClientBlocked = await refused(() => new pg.Client({ connectionString: process.env.DATABASE_URL }).connect());
  // A brand-new Pool anywhere (e.g. advisoryLock.ts) still goes through the adapter.
  const p2 = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  r.newPoolRoutedToTemp = (await p2.query(`SELECT relnamespace = pg_my_temp_schema() AS t FROM pg_class WHERE oid = to_regclass('users')`)).rows[0]?.t === true;
  DB.DBC.probing = false;
  // TEMP write and read work; unqualified names are the shadows.
  await pool.query(`INSERT INTO harness_decisions (layer, decision, outcome) VALUES (1, 'probe', 'skip')`);
  r.tempWriteRead = (await pool.query(`SELECT count(*)::int AS n FROM harness_decisions WHERE decision = 'probe'`)).rows[0].n === 1;
  r.shadowStartsEmpty = (await pool.query(`SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM co_memories) AS n`)).rows[0].n == 0;
  // An error doesn't poison the session.
  await pool.query(`SELECT * FROM no_such_table_xyz`).catch(() => {});
  r.errorDoesNotPoison = (await pool.query(`SELECT 1 AS one`)).rows[0].one === 1;
  // Row locks on TEMP shadows work inside the read-only transaction (invite redemption, task claiming use them).
  r.tempRowLockWorks = await pool.query(`SELECT 1 FROM harness_decisions LIMIT 1 FOR UPDATE SKIP LOCKED`).then(() => true).catch(() => false);
  // A production transaction is a savepoint scope: ROLLBACK undoes only it; COMMIT can't end the outer transaction.
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query(`INSERT INTO harness_decisions (layer, decision, outcome) VALUES (1, 'probe_tx', 'skip')`);
  await c.query("ROLLBACK");
  r.nestedRollbackScoped = (await pool.query(`SELECT count(*)::int AS n FROM harness_decisions WHERE decision = 'probe_tx'`)).rows[0].n === 0 && (await pool.query(`SELECT count(*)::int AS n FROM harness_decisions WHERE decision = 'probe'`)).rows[0].n === 1;
  await c.query("BEGIN");
  await c.query(`INSERT INTO harness_decisions (layer, decision, outcome) VALUES (1, 'probe_tx2', 'skip')`);
  await c.query("COMMIT");
  c.release();
  r.nestedCommitStaysInOuter = (await DB.raw("SHOW transaction_read_only")).rows[0].transaction_read_only === "on" && (await pool.query(`SELECT count(*)::int AS n FROM harness_decisions WHERE decision = 'probe_tx2'`)).rows[0].n === 1;
  await DB.caseEnd();
  r.lateQueryRefusedBetweenCases = await refused(() => pool.query(`SELECT 1`));
  DB.DBC.lateQueries = 0;
  await DB.caseBegin("probe:after");
  r.caseRollbackClears = (await pool.query(`SELECT count(*)::int AS n FROM harness_decisions`)).rows[0].n === 0;
  r.nowDefaultsUseWallClock = DB.DBC.nowDefaultsRewritten > 0 && (await pool.query(`SELECT pg_get_expr(d.adbin, d.adrelid) AS def FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = to_regclass('co_memories') AND a.attname = 'created_at'`)).rows[0]?.def?.includes("clock_timestamp");
  await DB.caseEnd();
  // Network: non-allowlisted fetch and raw sockets are blocked; transports are captured, not sent.
  const before = H.unexpectedNet.length;
  r.fetchBlocked = await refused(() => fetch("https://example.com/"));
  const net = await import("node:net");
  r.socketBlocked = await new Promise<boolean>((res) => { const s = net.connect(443, "93.184.215.14"); s.on("error", () => res(true)); s.on("connect", () => { s.destroy(); res(false); }); setTimeout(() => res(false), 4000); });
  H.unexpectedNet.splice(before); // the two deliberate probes above
  const capBefore = H.captured.length;
  const sb = await fetch("https://api.sendblue.co/api/send-message", { method: "POST", body: JSON.stringify({ number: "+14155550100", content: "probe" }) });
  r.sendblueCapturedNotSent = sb.status === 200 && H.captured.length === capBefore + 1 && H.unexpectedNet.length === before;
  H.captured.splice(capBefore);
  const { isTestNumber } = await import("../../src/services/testNumbers.js");
  r.fixturePhonesAreTestNumbers = isTestNumber("+14155550100") && isTestNumber("+14155550101") && isTestNumber("+14155550102");
  r.semanticHarnessPhoneIsNot = !isTestNumber("+10000000000");
  const { ALLOW_REAL_SENDS } = await import("../../src/otpActions.js").catch(() => ({ ALLOW_REAL_SENDS: "unexported" as any }));
  r.allowRealSendsFalse = ALLOW_REAL_SENDS === false || ALLOW_REAL_SENDS === "unexported";
  return r;
}

async function main() {
  const { checks, runs } = await preflight();
  const DB = await import("./db.js");
  let setup: any;
  try { setup = await DB.open(); } catch (e: any) { out("NEXT_PREFLIGHT", { ok: false, why: `db open: ${e?.message}`, checks }); process.exit(3); }
  // 7. schema: required types/operators, read-only metadata
  const meta = (await DB.raw(`SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = to_regclass('co_memories') AND a.attname = 'content_embedding'`)).rows[0]?.t;
  const cosine = (await DB.raw(`SELECT count(*)::int AS n FROM pg_operator WHERE oprname = '<=>'`)).rows[0].n > 0;
  checks.schema = { tables: setup.tables, sequencesRebuilt: setup.sequencesRebuilt, readOnly: setup.readOnly, embedding: meta, cosine };
  if (meta !== "vector(1536)" || !cosine) { out("NEXT_PREFLIGHT", { ok: false, why: "schema", checks }); process.exit(3); }
  const probes = await safetyProbes(DB);
  const probesOk = Object.values(probes).every(Boolean);
  out("NEXT_PREFLIGHT", { ok: probesOk, checks, probes, probeRefusals: DB.DBC.probeRefusals, unexpectedRefusals: DB.DBC.refusedWrites });
  if (!probesOk) { await DB.close(); process.exit(3); }
  if (process.env.PREFLIGHT_ONLY) { out("NEXT_CLEANUP", { ...(await DB.close()), unexpectedNet: H.unexpectedNet, expectedBlocked: H.expectedBlocked.length }); process.exit(0); }

  // Selection
  const suites = suiteArg === "all" ? [...SUITES] : suiteArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (!suites.length || suites.some((s) => !(SUITES as readonly string[]).includes(s))) { out("NEXT_ERROR", { stage: "selection", why: `unknown SUITE ${suiteArg}` }); await DB.close(); process.exit(3); }
  const { loadSuite } = await import("./suites.js");
  const all = (await Promise.all(suites.map((s) => loadSuite(s)))).flat();
  const only = onlyArg === "all" ? all.map((c) => c.id) : onlyArg.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((id) => !all.some((c) => c.id === id));
  if (!only.length || unknown.length) { out("NEXT_ERROR", { stage: "selection", why: only.length ? `unknown ONLY ids: ${unknown.join(",")}` : "ONLY is required" }); await DB.close(); process.exit(3); }
  const chosen = all.filter((c) => only.includes(c.id));
  out("NEXT_SETUP", { suites, cases: chosen.map((c) => `${c.suite}/${c.id}`), runs, anchor: new Date().toISOString(), costCapUsd: H.costCapUsd });

  let passed = 0, failed = 0, blocked = 0;
  for (const c of chosen) {
    for (let run = 1; run <= (c.runs1 ? 1 : runs); run++) {
      if (H.stopReason) break;
      const t0 = Date.now();
      caseLogStart = prodLogs.length;
      const capBefore = H.captured.length, netBefore = H.unexpectedNet.length, refusedBefore = DB.DBC.refusedWrites, costBefore = H.costUsd, logBefore = prodLogs.length, errBefore = DB.DBC.errors.length;
      await DB.caseBegin(`${c.suite}/${c.id}#${run}`);
      H.respond = null;
      // Fresh process-local limiter state per case.
      const SL = await import("../../src/services/sendLimiter.js");
      Object.assign(SL.sendLimiter, SL.createSendLimiter());
      (await import("../../src/services/eventPresence.js")).clearPresenceCache();
      let res: any;
      try { res = await c.run({ run, DB }); } catch (e: any) { res = { status: "fail", checks: [{ name: "case threw", pass: false, reason: String(e?.message ?? e).slice(0, 300) }] }; }
      await Promise.all(H.pendingUsage.splice(0));
      await DB.caseEnd();
      const unexpectedNet = H.unexpectedNet.slice(netBefore);
      const refused = DB.DBC.refusedWrites - refusedBefore;
      const checks = res.checks ?? [];
      if (unexpectedNet.length) checks.push({ name: "no unexpected network", pass: false, reason: JSON.stringify(unexpectedNet) });
      if (refused && !c.allowRefusals) checks.push({ name: "no refused permanent writes", pass: false, reason: JSON.stringify(DB.DBC.refusedSamples.filter((x) => x.caseId?.startsWith(`${c.suite}/${c.id}#${run}`))) });
      const status = res.status === "blocked" ? "blocked" : checks.every((k: any) => k.pass) ? "pass" : "fail";
      if (status === "pass") passed++; else if (status === "blocked") blocked++; else failed++;
      out("NEXT_CASE", {
        suite: c.suite, id: c.id, run, mode: c.mode ?? "fixture-live", status, ms: Date.now() - t0,
        checks, observed: res.observed, texts: res.texts, captured: H.captured.slice(capBefore).map((x) => ({ transport: x.transport, method: x.method, path: x.path, body: x.body })),
        refusedWrites: refused, unexpectedNet, dbErrors: DB.DBC.errors.slice(errBefore), costUsd: +(H.costUsd - costBefore).toFixed(4), replaced: c.replaced, prodLog: prodLogs.slice(logBefore).filter((l) => /error|fail|refused|blocked/i.test(l)).slice(0, 12),
      });
    }
  }
  await Promise.all(H.pendingUsage.splice(0));
  const cleanup = await DB.close();
  out("NEXT_CLEANUP", { ...cleanup, refusedWritesUnexpected: DB.DBC.refusedWrites, probeRefusals: DB.DBC.probeRefusals, unexpectedNet: H.unexpectedNet, expectedBlocked: H.expectedBlocked.length, capturedTotal: H.captured.length });
  const byModel: Record<string, any> = {};
  for (const u of H.usage) { const k = u.model; byModel[k] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUsd: 0 }; const b = byModel[k]; b.calls++; b.input += u.input; b.output += u.output; b.cacheRead += u.cacheRead; b.cacheWrite += u.cacheWrite; b.webSearches += u.webSearches; b.costUsd += u.costUsd ?? 0; }
  out("NEXT_USAGE", { requests: H.providerRequests, byModel, estimatedUsd: +H.costUsd.toFixed(4), unknownCostCalls: H.unknownCostCalls, stopReason: H.stopReason });
  out("NEXT_RESULT", { passed, failed, blocked, total: passed + failed + blocked });
  process.exit(0);
}

main().catch((e) => { out("NEXT_ERROR", { stage: "main", name: e?.name, msg: String(e?.message ?? "").slice(0, 300) }); process.exit(1); });
