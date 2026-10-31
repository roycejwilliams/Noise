// A throwaway Postgres for the snapshot's SQL tests: the same setup as evals/ledger/ledgerSql.ts (a cluster on a Unix socket in a temp
// folder, run as this test's own child, stopped with SIGINT so its shared memory is released). Missing binaries skip the database part
// visibly; binaries that are there but won't start fail the run. Not a test file itself (not in layer1.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export type Cluster = { sock: string; stop: () => Promise<void>; pid: number };
const PREFIX = "cue-snap-";

const bin = (name: string) => {
  for (const dir of [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/18/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"]) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export async function startCluster(): Promise<{ ok: Cluster } | { skip: string } | { fail: string }> {
  const initdb = bin("initdb"), postgres = bin("postgres");
  if (!initdb || !postgres) return { skip: "no local postgres binaries (initdb, postgres)" };
  for (const old of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX))) {
    const at = path.join(os.tmpdir(), old);
    try { if (Date.now() - fs.statSync(at).mtimeMs > 60 * 60_000) fs.rmSync(at, { recursive: true, force: true }); } catch {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const data = path.join(dir, "d");
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const init = spawnSync(initdb, ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"], { encoding: "utf8", timeout: 60_000 });
  if (init.status !== 0) { remove(); return { fail: `initdb is installed but failed (${(init.stderr || init.error?.message || "").split("\n").filter(Boolean)[0]?.slice(0, 160) ?? "no output"})` }; }
  const child = spawn(postgres, ["-D", data, "-k", dir, "-c", "listen_addresses=", "-c", "fsync=off", "-c", "max_connections=60"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  const alive = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (alive()) {
      child.kill("SIGINT");
      for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      if (alive()) child.kill("SIGKILL");
    }
    remove();
  };
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

// SysV shared-memory segments this cluster's postgres created, still there (null where ipcs isn't there).
export const shmSegmentsOf = (pid: number) => {
  const r = spawnSync("ipcs", ["-m", "-p"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const head = r.stdout.split("\n").find((l) => /\bCPID\b/.test(l));
  const col = head ? head.trim().split(/\s+/).indexOf("CPID") : -1;
  if (col < 0) return null;
  return r.stdout.split("\n").filter((l) => /^\s*m\s/.test(l)).filter((l) => Number(l.trim().split(/\s+/)[col]) === pid).length;
};

// The DDL of one table as db/migrations.ts writes it (its CREATE TABLE IF NOT EXISTS, matched to its closing parenthesis), with the
// pgvector column left out; and every "ALTER TABLE <t> ADD COLUMN" in the file for it.
export function tableDdl(mig: string, table: string): string | null {
  const at = mig.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = mig.indexOf("(", at); i < mig.length; i++) {
    if (mig[i] === "(") depth++;
    else if (mig[i] === ")" && --depth === 0) return mig.slice(at, i + 1).replace(/\n\s*\w+ vector\(\d+\),?/g, "").replace(/,(\s*)\)$/, "$1)");
  }
  return null;
}
export function tableAlters(mig: string, table: string): string[] {
  return [...mig.matchAll(new RegExp(`\`(ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS [^\`]*)\``, "g"))].map((m) => m[1]).filter((s) => !/\bvector\(/.test(s));
}
