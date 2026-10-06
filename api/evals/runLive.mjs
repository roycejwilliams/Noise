#!/usr/bin/env node
// One live eval or probe, metered: Haiku, a hard cap, the cost printed.
//   npm run eval:live -- evals/capabilities/probe.ts [args]
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
if (!args.length) { console.error("usage: npm run eval:live -- evals/<suite>/<file>.ts [args]"); process.exit(2); }
const env = { ...process.env, EVAL_LAYER2: "1", EVAL_LEDGER: process.env.EVAL_LEDGER ?? join(tmpdir(), `eval-ledger-${Date.now()}.jsonl`), EVAL_TOKEN_CAP: process.env.EVAL_TOKEN_CAP ?? "300000", EVAL_COST_CAP_USD: process.env.EVAL_COST_CAP_USD ?? "0.75" };
const p = spawn("npx", ["tsx", "--import", "./evals/lib/meter.mjs", ...args], { cwd: root, env, stdio: "inherit" });
p.on("close", (code) => process.exit(code ?? 1));
