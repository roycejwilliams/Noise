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
  check("answered_since only counts a reply after the failure (r.created_at > hd.created_at)", /AND r\.created_at > hd\.created_at/.test(sql));
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
// Set up a throwaway cluster, or say why not (no binaries, or they won't run here, e.g. as root): the database part is skipped then.
// postgres runs as this test's own child, in its process group, never daemonized: the layer-1 runner's timeout kills the whole group,
// so it can't be left running; a normal exit (or a crash) stops it and removes its folder here too. Folders a killed run left behind
// are swept on the next run.
type Cluster = { sock: string; stop: () => void };
async function startCluster(): Promise<Cluster | string> {
  if (!initdb || !postgres) return "no local postgres binaries";
  for (const old of fs.readdirSync(os.tmpdir()).filter((n) => /^cue-failrows-/.test(n))) {
    const at = path.join(os.tmpdir(), old);
    try { if (Date.now() - fs.statSync(at).mtimeMs > 60 * 60_000) fs.rmSync(at, { recursive: true, force: true }); } catch {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-failrows-"));
  const data = path.join(dir, "d");
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const init = spawnSync(initdb, ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"], { encoding: "utf8", timeout: 60_000 });
  if (init.status !== 0) { remove(); return `initdb didn't run here (${(init.stderr || init.error?.message || "").split("\n")[0].slice(0, 120)})`; }
  const child = spawn(postgres, ["-D", data, "-k", dir, "-c", "listen_addresses=", "-c", "fsync=off"], { stdio: "ignore" });
  const stop = () => { try { child.kill("SIGKILL"); } catch {} remove(); };
  process.on("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop(); process.exit(1); });
  const sockFile = path.join(dir, ".s.PGSQL.5432");
  for (let i = 0; i < 100 && !fs.existsSync(sockFile); i++) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(sockFile)) { stop(); return "postgres didn't start here"; }
  return { sock: dir, stop };
}
const cluster = await startCluster();
if (typeof cluster === "string") {
  console.log(`failureRowsSql: ${cluster}; the database part was skipped (text checks above still ran)`);
} else {
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
    const read = () => F.readFailureRows((sql, values) => c.query(sql, values as any[]), "member-a", notAnAnswer);

    await dec("member-a", "turn.failed", "told_member", { source: "turn_error" }, 5);
    await dec("member-a", "call.dial", "dial_failed", { requested: "auto_intake", status: 401 }, 6);
    await dec("member-a", "call.dial", "dial_failed", { requested: "router_decision" }, 40); // outside the window
    await dec("member-b", "turn.failed", "told_member", null, 2); // another member
    await dec("member-a", "router.decideActions", "place_call", null, 5); // not a failure
    await said("member-a", "Co replied: Here's what I found for Saturday.", 7); // a real reply BEFORE the failure
    await said("member-b", "Co replied: A real answer, to someone else.", 3); // a real reply to ANOTHER member after it
    await said("member-a", `Co replied: ${F.TURN_FAILED_NOTE}`, 4); // the "something broke" line after it
    await said("member-a", "Co replied: On it, give me a sec.", 4); // a hold line after it
    await said("member-a", "User said: what happened?", 3); // their own text after it

    let rows = await read();
    check("the read ran against the database", Array.isArray(rows), rows);
    rows ??= [];
    check("only this member's failures in the window, newest first", rows.map((r) => r.decision).join() === "turn.failed,call.dial", rows);
    check("who asked for the failed call comes back", rows.find((r) => r.decision === "call.dial")?.requested === "auto_intake", rows);
    const turn = () => rows!.find((r) => r.decision === "turn.failed");
    check("not answered: a reply before the failure, a reply to another member, the 'something broke' line, a hold line and their own text don't count", turn()?.answeredSince === false, turn());
    check("so the broken turn is still carried", F.failureRecordFacts(rows, { afterFailure: false, now: new Date() }).some((t) => /Cue's answer to their text/.test(t)));

    await said("member-a", "Co replied: Sorry about that. Here's the Saturday list again.", 2); // the replay's real answer
    rows = (await read()) ?? [];
    check("a real reply to this member after the failure counts as answered", turn()?.answeredSince === true, turn());
    check("so neither the broken turn nor the failed call (Cue-started) is carried any more", F.failureRecordFacts(rows, { afterFailure: false, now: new Date() }).length === 0, F.failureRecordFacts(rows, { afterFailure: false, now: new Date() }));
    await c.end();
  } catch (err: any) {
    check("the throwaway database ran", false, err?.message ?? err);
  } finally {
    cluster.stop();
  }
}

console.log(`failure rows sql: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
