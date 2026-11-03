#!/usr/bin/env node
// LAYER 1: every logic test, with the model fully stubbed. Zero tokens, no outside calls, on every change.
//   npm test            (also: npm run evals:code, the pre-push hook and CI)
// Each file runs under evals/lib/modelGuard.mjs, which answers model calls with a canned stub (only for the files on
// evals/lib/modelStubAllowed.json; any other file must fake its own) and refuses every other outside call, by fetch or by socket
// (model, voice, telephony, texting, search hosts: a test never places a real call or a paid request). Any refused call fails the
// run, even when the code under test swallowed the error. The summary shows how many checks ran, how long it took, and which tests
// leaned on the stub.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { files } = JSON.parse(readFileSync(join(root, "evals/layer1.json"), "utf8"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const list = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;
const log = join(tmpdir(), `layer1-guard-${process.pid}.log`);
if (existsSync(log)) rmSync(log);
const env = {
  ...process.env,
  // Placeholders: clients read these at import; the guard answers anything that tries to use them.
  SENDBLUE_API_API_KEY: "ci", SENDBLUE_API_API_SECRET: "ci", SENDBLUE_API_KEY: "ci", SENDBLUE_SECRET_KEY: "ci",
  ANTHROPIC_API_KEY: "ci", OPENAI_API_KEY: "ci", GOOGLE_API_KEY: "ci", GOOGLE_PLACES_API_KEY: "ci", RESEND_API_KEY: "re_ci", ELEVENLABS_API_KEY: "ci",
  DATABASE_URL: "postgres://ci:ci@127.0.0.1:1/ci", MODEL_GUARD_LOG: log,
  // dotenv must not fill anything from the real api/.env (Twilio, Stripe, Langfuse... use node http, which the guard cannot see).
  DOTENV_CONFIG_PATH: "/dev/null",
};
delete env.EVAL_LAYER2; delete env.EVAL_SAMPLE;

const run = (cmd, args, extra = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    // 360s a file (was 180): evals/coPages/tools.ts takes ~120s alone on a laptop and ran past 180s on GitHub's runner, so the
    // now-required layer 1 check failed on time, not on a test (2026-10-13).
    const timer = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } }, 360_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - t0 }); });
  });

const t0 = Date.now();
if (!only.length) {
  const tsc = await run("npx", ["tsc", "--noEmit"]);
  if (tsc.code !== 0) { console.log(tsc.out.split("\n").slice(0, 25).join("\n")); console.log("\nLAYER 1: typecheck failed."); process.exit(1); }
  // The golden harness and the eval policy files are typechecked too (evals/tsconfig.golden.json); the rest of evals/ is not yet.
  const evalTsc = await run("npx", ["tsc", "-p", "evals/tsconfig.golden.json"]);
  if (evalTsc.code !== 0) { console.log(evalTsc.out.split("\n").slice(0, 25).join("\n")); console.log("\nLAYER 1: typecheck of evals/golden and evals/lib failed."); process.exit(1); }
}
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < list.length) {
    const f = list[next++];
    const r = await run("npx", ["tsx", "--import", "./evals/lib/modelGuard.mjs", f], { MODEL_GUARD_FILE: f });
    const checks = [...r.out.matchAll(/(\d+)\/(\d+) passed/g)].reduce((a, m) => a + Number(m[2]), 0);
    results.push({ f, ...r, checks });
  }
}));
const stubbed = {};
const refused = [];
if (existsSync(log)) for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) { const [f, kind, host] = line.split("\t"); if (kind === "stubbed") stubbed[f] = (stubbed[f] ?? 0) + 1; else refused.push(`${f} -> ${host}`); }
const bad = results.filter((r) => r.code !== 0 || /^FAIL /m.test(r.out) || /HARD /.test(r.out));
for (const r of bad.sort((a, b) => a.f.localeCompare(b.f))) {
  console.log(`\n--- ${r.f} (exit ${r.code})`);
  console.log(r.out.split("\n").filter((l) => /FAIL|HARD|Error|error|LAYER 1/.test(l)).slice(0, 12).join("\n") || r.out.split("\n").slice(-8).join("\n"));
}
const checks = results.reduce((a, r) => a + r.checks, 0);
const totalStubbed = Object.values(stubbed).reduce((a, n) => a + n, 0);
console.log(`\nLAYER 1: ${list.length - bad.length}/${list.length} files passed, ${checks.toLocaleString()} checks, ${((Date.now() - t0) / 1000).toFixed(1)}s | model calls: 0 real, ${totalStubbed} stubbed | tokens: 0 | cost: $0.00`);
if (totalStubbed) console.log(`  stubbed (the test got a canned answer, so it must not depend on what a model says): ${Object.entries(stubbed).map(([f, n]) => `${f} x${n}`).join(", ")}`);
if (refused.length) console.log(`  REFUSED outside calls (a logic test must make none; stub it in the test, see evals/lib/modelGuard.mjs): ${[...new Set(refused)].join(", ")}`);
// A part of a test that couldn't run here (e.g. no local postgres for evals/silence/failureRowsSql.ts) says so with a "SKIP " line; it's
// listed, never hidden behind a green run.
const skipped = results.flatMap((r) => r.out.split("\n").filter((l) => /^SKIP /.test(l)).map((l) => `${r.f}: ${l.slice(5)}`));
if (skipped.length) console.log(`  SKIPPED parts (didn't run here):\n    ${skipped.join("\n    ")}`);
process.exit(bad.length || refused.length ? 1 : 0);
