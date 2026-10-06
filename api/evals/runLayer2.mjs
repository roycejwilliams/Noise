#!/usr/bin/env node
// LAYER 2: the live evals. Nightly, or when asked. A small sample of the highest-signal cases per suite, Haiku for
// everything and Sonnet only for grading, a hard token and dollar cap for the whole run, and the cost printed at the end.
//   npm run evals:nightly [-- --only router,intro] [-- --sample 3] [-- --cap-tokens 200000] [-- --cap-usd 0.25]
// These calls are real and paid: they never run on a commit, a push or a pull request.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(join(root, "evals/live.json"), "utf8"));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = (arg("only") ?? "").split(",").filter(Boolean);
const sampleOverride = arg("sample");
const capTokens = arg("cap-tokens") ?? process.env.EVAL_TOKEN_CAP ?? String(cfg.caps.tokens);
const capUsd = arg("cap-usd") ?? process.env.EVAL_COST_CAP_USD ?? String(cfg.caps.usd);
const ledger = join(tmpdir(), `eval-ledger-${Date.now()}.jsonl`);
if (existsSync(ledger)) rmSync(ledger);
process.env.EVAL_LEDGER = ledger; process.env.EVAL_TOKEN_CAP = String(capTokens); process.env.EVAL_COST_CAP_USD = String(capUsd); process.env.EVAL_QUIET = "1";
const { summary } = await import("./lib/meter.mjs");

const suites = cfg.suites.filter((s) => !only.length || only.includes(s.name));
const rows = [];
let capHit = false;
console.log(`LAYER 2 (live evals): ${suites.length} suites | Haiku for everything, Sonnet only to grade | cap ${Number(capTokens).toLocaleString()} tokens / $${Number(capUsd).toFixed(2)}\n`);
for (const s of suites) {
  if (capHit) { rows.push({ name: s.name, skipped: true }); continue; }
  const t0 = Date.now();
  const env = { ...process.env, EVAL_LAYER2: "1", EVAL_SAMPLE: String(sampleOverride ?? s.sample), EVAL_LEDGER: ledger, EVAL_QUIET: "1", EVAL_TOKEN_CAP: String(capTokens), EVAL_COST_CAP_USD: String(capUsd), DATABASE_URL: process.env.DATABASE_URL ?? "postgres://ci:ci@127.0.0.1:1/ci" };
  const out = await new Promise((resolve) => {
    const p = spawn("npx", ["tsx", "--import", "./evals/lib/meter.mjs", ...s.args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 600_000);
    p.stdout.on("data", (d) => (buf += d));
    p.stderr.on("data", (d) => (buf += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, buf }); });
  });
  let head = out.buf.match(/(\d+) cases, (\d+) hard failures?, ([\d.]+)% soft/);
  if (!head) { const c = out.buf.match(/"cases":\s*(\d+)/); const h = out.buf.match(/"hardFailures":\s*(\d+)/); const sft = out.buf.match(/"softOverall":\s*"\d+\/\d+ \(([\d.]+)%\)"/); if (c && h) head = [null, c[1], h[1], sft ? sft[1] : "100"]; }
  const cap = /EVAL CAP:/.test(out.buf) || out.code === 3;
  if (cap) capHit = true;
  rows.push({ name: s.name, cases: head ? Number(head[1]) : null, hard: head ? Number(head[2]) : null, soft: head ? Number(head[3]) : null, code: out.code, cap, secs: ((Date.now() - t0) / 1000).toFixed(0), tail: out.buf.split("\n").filter((l) => /HARD|FAIL|Error/.test(l)).slice(0, 6) });
  const r = rows[rows.length - 1];
  console.log(`${r.cap ? "CAP " : r.code === 0 ? "ok  " : "FAIL"} ${s.name.padEnd(12)} ${r.cases ?? "?"} cases | hard ${r.hard ?? "?"} | soft ${r.soft ?? "?"}% | ${r.secs}s`);
  if (r.cases === 0) console.log("       WARNING: this suite ran 0 cases (it has none here), so it covered nothing tonight");
  for (const l of r.tail) console.log(`       ${l.trim().slice(0, 170)}`);
}
const hard = rows.reduce((a, r) => a + (r.hard ?? 0), 0);
console.log(`\n${summary()}`);
if (capHit) console.log("The run hit its cap and stopped early; the suites after it did not run.");
process.exit(capHit ? 3 : hard || rows.some((r) => r.code && r.code !== 0 && !r.cap) ? 1 : 0);
