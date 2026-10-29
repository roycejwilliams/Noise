// The failure-record read (services/turnFailure.ts FAILURE_ROWS_SQL) run against a real Postgres: a throwaway cluster on a Unix socket in
// a temp folder, started from the local postgres binaries, removed after. No network, no shared database. Where the binaries aren't
// installed or won't run here (e.g. as root), the SQL's three answered_since conditions are still checked in its text, and the run
// says the database part was skipped.
//   TZ=UTC node evals/runLayer1.mjs evals/silence/failureRowsSql.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const F = await import("../../src/services/turnFailure.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

// ---- the SQL's text: each answered_since condition is there
{
  const sql = F.FAILURE_ROWS_SQL.replace(/\s+/g, " ");
  check("answered_since is scoped to this member (r.user_id = hd.user_id)", /WHERE r\.user_id = hd\.user_id/.test(sql));
  check("answered_since only counts a reply after a text of theirs that came after the failure", /AND r\.created_at > \( SELECT MIN\(u\.created_at\) FROM co_memories u WHERE u\.user_id = hd\.user_id AND u\.memory_type = 'text_exchange' AND \(u\.content LIKE 'User said:%' OR u\.content LIKE 'User sent a voice memo:%'\) AND u\.content !~ ' \\\[to \[A-Za-z\]\+\\\]\$' AND u\.created_at > hd\.created_at \)/.test(sql));
  check("answered_since skips the lines that answer nothing ($3)", /AND r\.content <> ALL\(\$3::text\[\]\)/.test(sql));
  check("the rows are this member's, in the window, newest first", /WHERE hd\.user_id = \$1 AND hd\.created_at > NOW\(\) - make_interval\(mins => \$2\)/.test(sql) && /ORDER BY hd\.created_at DESC/.test(sql));
  const sb = fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("each text reads it with the hold lines and the 'something broke' lines as what answers nothing", /readFailureRows\(\(sql, values\) => pool\.query\(sql, values\), user\.id, \[\.\.\.HOLD_LINES, \.\.\.OWED_AFTER\]\)/.test(sb));
}

// ---- against a real Postgres
const bin = (name: string) => {
  for (const dir of [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin"]) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
};
const initdb = bin("initdb"), postgres = bin("postgres");
// Set up a throwaway cluster. Missing binaries skip the database part, visibly (a SKIP line the layer-1 summary lists); binaries that
// are there but won't set up or start a cluster fail the run, so a full shared-memory table (or anything else) never turns into a
// quiet skip behind a green layer 1.
// postgres runs as this test's own child, in its process group, never daemonized: the layer-1 runner's timeout kills the whole group,
// so it can't be left running. It is stopped with SIGINT (a fast shutdown that releases its SysV shared memory; SIGKILL leaks one
// segment per run, and macOS allows 32), waited for, and killed only if it doesn't stop in time. Folders a killed run left behind are
// swept on the next run.
type Cluster = { sock: string; stop: () => Promise<void> };
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
async function startCluster(): Promise<{ ok: Cluster } | { skip: string } | { fail: string }> {
  if (!initdb || !postgres) return { skip: "no local postgres binaries (initdb, postgres)" };
  for (const old of fs.readdirSync(os.tmpdir()).filter((n) => /^cue-failrows-/.test(n))) {
    const at = path.join(os.tmpdir(), old);
    try { if (Date.now() - fs.statSync(at).mtimeMs > 60 * 60_000) fs.rmSync(at, { recursive: true, force: true }); } catch {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-failrows-"));
  const data = path.join(dir, "d");
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const init = spawnSync(initdb, ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"], { encoding: "utf8", timeout: 60_000 });
  if (init.status !== 0) { remove(); return { fail: `initdb is installed but failed (${(init.stderr || init.error?.message || "").split("\n").filter(Boolean)[0]?.slice(0, 160) ?? "no output"})` }; }
  const child = spawn(postgres, ["-D", data, "-k", dir, "-c", "listen_addresses=", "-c", "fsync=off"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  const alive = () => child.exitCode === null && child.signalCode === null;
  // A normal stop: fast shutdown, then SIGKILL only if it hasn't exited in 10s.
  const stop = async () => {
    if (alive()) {
      child.kill("SIGINT");
      for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      if (alive()) child.kill("SIGKILL");
    }
    remove();
  };
  // An exit that skips the finally below: the same, synchronously.
  process.on("exit", () => {
    if (alive()) {
      try { child.kill("SIGINT"); } catch {}
      for (let i = 0; i < 50; i++) { try { process.kill(child.pid!, 0); } catch { break; } sleepSync(100); }
      try { process.kill(child.pid!, 0); child.kill("SIGKILL"); } catch {}
    }
    remove();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(1));
  const sockFile = path.join(dir, ".s.PGSQL.5432");
  for (let i = 0; i < 100 && !fs.existsSync(sockFile); i++) {
    if (!alive()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(sockFile)) { await stop(); return { fail: `postgres is installed but didn't start (${stderr.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? "no output"})` }; }
  return { ok: { sock: dir, stop, pid: child.pid! } };
}
// SysV shared-memory segments this cluster's postgres created (CPID), still there (null where ipcs isn't there). Counting only
// its own keeps the check true when another layer-1 run (another worktree's merge gate) has a cluster up at the same time.
const shmSegmentsOf = (pid: number) => {
  const r = spawnSync("ipcs", ["-m", "-p"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const head = r.stdout.split("\n").find((l) => /\bCPID\b/.test(l));
  const col = head ? head.trim().split(/\s+/).indexOf("CPID") : -1;
  if (col < 0) return null;
  return r.stdout.split("\n").filter((l) => /^\s*m\s/.test(l)).filter((l) => Number(l.trim().split(/\s+/)[col]) === pid).length;
};
const started = await startCluster();
if ("skip" in started) {
  console.log(`SKIP failureRowsSql: ${started.skip}; the database part didn't run (the SQL text checks above did)`);
} else if ("fail" in started) {
  check(`the throwaway database starts where postgres is installed: ${started.fail}`, false);
} else {
  const cluster = started.ok;
  try {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ host: cluster.sock, user: "postgres", database: "postgres" });
    await c.connect();
    await c.query(`CREATE TABLE harness_decisions (id bigserial PRIMARY KEY, decision text, user_id text, action text, proposal jsonb, created_at timestamptz)`);
    await c.query(`CREATE TABLE co_memories (id bigserial PRIMARY KEY, user_id text, memory_type text, content text, created_at timestamptz)`);
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const dec = (user: string, decision: string, action: string, proposal: object | null, m: number) =>
      c.query(`INSERT INTO harness_decisions (decision, user_id, action, proposal, created_at) VALUES ($1, $2, $3, $4, $5)`, [decision, user, action, proposal ? JSON.stringify(proposal) : null, ago(m)]);
    const said = (user: string, content: string, m: number) => c.query(`INSERT INTO co_memories (user_id, memory_type, content, created_at) VALUES ($1, 'text_exchange', $2, $3)`, [user, content, ago(m)]);
    const notAnAnswer = ["On it, give me a sec.", F.TURN_FAILED_NOTE, ...F.OWED_AFTER];
    const read = (who = "member-a") => F.readFailureRows((sql, values) => c.query(sql, values as any[]), who, notAnAnswer);
    const facts = (rows: Awaited<ReturnType<typeof read>>) => F.failureRecordFacts(rows ?? [], { afterFailure: false, now: new Date() });

    // The main flow (4th review): "Call me" (member-a), the dial fails, Cue says so honestly in that same turn.
    await said("member-a", "User said: Call me", 10.2); // their text BEFORE the failure
    await dec("member-a", "call.dial", "dial_failed", { requested: "router_decision", status: 401 }, 10);
    await said("member-a", "Co replied: The call didn't go through, it's a problem on my side.", 9.9); // Cue's honest reply, same turn
    await dec("member-a", "call.dial", "dial_failed", { requested: "auto_intake" }, 40); // outside the window
    await dec("member-a", "router.decideActions", "place_call", null, 10); // not a failure
    // Another member's texts and replies after it never count for member-a.
    await said("member-b", "User said: hey", 9);
    await said("member-b", "Co replied: A real answer, to someone else.", 8.9);

    let rows = await read();
    check("the read ran against the database", Array.isArray(rows), rows);
    const dial = () => rows?.find((r) => r.decision === "call.dial");
    check("only this member's failures in the window", rows?.length === 1 && dial()?.requested === "router_decision", rows);
    check("Cue's honest reply in the failure's own turn doesn't end it (no text of theirs came after the failure yet)", dial()?.answeredSince === false, dial());

    // Their follow-up, "What happened?": the failure facts are still there for this reply.
    await said("member-a", "User said: What happened?", 8);
    await said("member-a", "Co replied: On it, give me a sec.", 7.9); // a hold line
    await said("member-a", `Co replied: ${F.TURN_FAILED_NOTE}`, 7.8); // a "something broke" line
    await said("member-b", "Co replied: Another real answer, to someone else.", 7.7); // after their follow-up, but to another member
    rows = await read();
    check("'What happened?' still sees the failed call (a hold line, a 'something broke' line and a reply to another member answer nothing)", dial()?.answeredSince === false && facts(rows).some((t) => /the call they asked for/.test(t)), rows);

    // Cue answers the follow-up: the failure is over for the reply after that.
    await said("member-a", "Co replied: The phone service turned the call down on my side; a report of it is on record.", 7.5);
    rows = await read();
    check("once their follow-up got a real reply, the failure is answered", dial()?.answeredSince === true, dial());
    check("so the reply after that gets no failure facts", facts(rows).length === 0, facts(rows));

    // member-c: a broken turn. The replay's answer alone (no text of theirs after the failure) doesn't end it; a reply to their next does.
    await said("member-c", "User said: what's on saturday?", 5.2);
    await dec("member-c", "turn.failed", "told_member", { source: "turn_error" }, 5);
    await said("member-c", `Co replied: ${F.TURN_FAILED_NOTE}`, 4.9);
    await said("member-c", "Co replied: Here's the Saturday list.", 4); // the replay's answer
    let c1 = await read("member-c");
    check("a replayed answer alone doesn't end a broken turn", c1?.[0]?.answeredSince === false && facts(c1).some((t) => /Cue's answer to their text/.test(t)), c1);
    await said("member-c", "User said: thanks, what broke?", 3);
    await said("member-c", "Co replied: My answer broke before it finished; a report of it is on record.", 2.5);
    c1 = await read("member-c");
    check("the reply to their next text does", c1?.[0]?.answeredSince === true && facts(c1).length === 0, c1);
    await c.end();
  } catch (err: any) {
    check("the throwaway database ran", false, err?.message ?? err);
  } finally {
    await cluster.stop();
  }
  const leftBehind = shmSegmentsOf(cluster.pid);
  if (leftBehind !== null) check("stopping the cluster leaks no shared memory (SIGINT, not SIGKILL)", leftBehind === 0, { leftBehind, pid: cluster.pid });
}

console.log(`failure rows sql: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
