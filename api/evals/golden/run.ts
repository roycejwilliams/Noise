// Runs every golden case (evals/golden/cases/*.ts, each exporting CASES: GoldenCase[]).
//   npm --prefix api run evals:golden                 all cases
//   ONLY=running-work npm --prefix api run evals:golden
// Real model calls on the models production uses, through the meter (evals/lib/meter.mjs): a hard token and dollar cap
// (evals:golden sets it), the cost printed at the end. No database, no sends, no web: searches and pages are stubbed per case.
// Exit 1 when a live case misses; pending cases are reported, never fail the run.
import "../lib/requireMeter.js";
import "dotenv/config";
import "../testEnv.js";
import { readdirSync, writeFileSync } from "node:fs";
import type { GoldenCase } from "./types.js";

const quiet = console.log;
console.log = (...a: any[]) => { if (process.env.GOLDEN_VERBOSE) quiet(...a); };
const dir = new URL("./cases/", import.meta.url);
const all: GoldenCase[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) all.push(...((await import(new URL(f, dir).href)).CASES as GoldenCase[]));
all.sort((a, b) => a.n - b.n);
const only = process.env.ONLY;
const dupes = all.map((c) => c.n).filter((n, i, xs) => xs.indexOf(n) !== i);
if (dupes.length) { quiet(`golden: duplicate case numbers ${dupes.join(", ")}`); process.exit(1); }

const CASE_TIMEOUT_MS = 150_000;
// A miss caused by the model provider or the cap, not by Co: labelled so it isn't read as a regression.
const INFRA = /\b(401|402|429|529|overloaded|credit balance|rate limit|EVAL CAP|cap reached|ECONNRESET|ETIMEDOUT)\b/i;
let failed = 0;
const rows: any[] = [];
for (const c of all.filter((x) => !only || x.id.includes(only) || String(x.n) === only)) {
  const t0 = Date.now();
  // A stalled call never holds the check: each attempt has a hard time limit, a timeout is a miss.
  const once = () => Promise.race([
    c.run().catch((e: any) => ({ ok: false, misses: [`threw: ${e?.message ?? e}`], observed: "" })),
    new Promise<{ ok: false; misses: string[]; observed: string }>((res) => setTimeout(() => res({ ok: false, misses: [`timed out after ${CASE_TIMEOUT_MS / 1000}s`], observed: "" }), CASE_TIMEOUT_MS).unref()),
  ]);
  let r = await once();
  // A live miss gets one retry, so model variance doesn't block a deploy; a pass on the retry is reported as flaky with the first
  // miss, never hidden (last.local.json keeps it). Two misses fail.
  let flaky: string[] | null = null;
  if (c.status.live && !r.ok) { const first = r; r = await once(); if (r.ok) flaky = first.misses; }
  const infra = !r.ok && r.misses.some((m) => INFRA.test(m));
  const tag = c.status.live ? (r.ok ? (flaky ? "ok~ " : "ok  ") : infra ? "FAIL(infra)" : "FAIL") : r.ok ? "pend(ok)" : "pend";
  // On GitHub, a pass on the retry shows as a warning on the run, not only in the log.
  if (flaky && process.env.GITHUB_ACTIONS) quiet(`::warning title=golden case ${c.n} passed on a retry::${c.id}: first run missed: ${flaky.join("; ").replace(/\n/g, " ").slice(0, 300)}`);
  if (c.status.live && !r.ok) failed++;
  rows.push({ n: c.n, id: c.id, live: c.status.live, ok: r.ok, flaky, misses: r.misses, observed: r.observed, ms: Date.now() - t0 });
  quiet(`${tag} ${String(c.n).padStart(2)} ${c.id}${r.misses.length ? `  (${r.misses.join("; ")})` : ""}${flaky ? `  [flaky: first run missed: ${flaky.join("; ")}]` : ""}${c.status.live ? "" : `  [until ${c.status.until}]`}\n      ${r.observed.replace(/\n+/g, " / ").slice(0, 260)}`);
}
writeFileSync(new URL("./last.local.json", import.meta.url), JSON.stringify(rows, null, 2));
const live = rows.filter((r) => r.live);
const flakes = rows.filter((r) => r.flaky).map((r) => r.id);
quiet(`\ngolden: ${live.length - failed}/${live.length} live cases passed${flakes.length ? ` (${flakes.length} on a retry: ${flakes.join(", ")})` : ""}, ${rows.length - live.length} pending`);
// The meter prints the run's cost on exit through console.log: give it back first, so the cost line always shows.
console.log = quiet;
process.exit(failed ? 1 : 0);
