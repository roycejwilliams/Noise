// Runs every golden case (evals/golden/cases/*.ts, each exporting CASES: GoldenCase[]). See evals/golden/README.md.
//   npm run evals:golden                                   replay: every model call answered from recordings/, zero network (CI)
//   npm run evals:golden:record -- --only running-work     record: real calls, capped, the case's recordings rewritten
//   npm run evals:golden:record -- --missing               record only the cases whose replay misses (a new or changed case)
//   npm run evals:golden:live                              live: real calls, nothing written (the manual drift check)
// --only takes ids or numbers, comma-separated (ONLY= works too). Every mode runs through the meter (evals/lib/meter.mjs) and the
// golden recorder (evals/lib/goldenReplay.mjs): no database, no sends, no web; searches and pages are stubbed per case.
// Exit 1 when a live case misses, or when any case makes a model call that has no recording; pending cases never fail on their result.
import "../lib/requireMeter.js";
import "dotenv/config";
import "../testEnv.js";
import { readdirSync, writeFileSync } from "node:fs";
import type { GoldenCase, GoldenResult } from "./types.js";

type Mode = "replay" | "record" | "live";
type Attempt = { value: GoldenResult; attempt: number; misses: string[]; served: number; recorded: number; unused: string[] };
type Miss = { case: string | null; attempt: number | null; miss: string };
type Hooks = {
  mode: Mode; now: string; realNow: () => number; dir: string; hasRecordings: (id: string) => boolean;
  attempt: (id: string, mode: Mode, fn: () => Promise<GoldenResult>) => Promise<Attempt>;
  settle: () => Promise<void>; allMisses: () => Miss[]; stats: () => { served: number; written: number; inflight: number };
};
const golden = (globalThis as { __GOLDEN__?: Hooks }).__GOLDEN__;
if (!golden) {
  console.error("\nThe golden cases run through the recorder (evals/lib/goldenReplay.mjs): npm run evals:golden (replay), evals:golden:record or evals:golden:live.\n");
  process.exit(2);
}

const quiet = console.log;
console.log = (...a: any[]) => { if (process.env.GOLDEN_VERBOSE) quiet(...a); };
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = (flag("--only") ?? process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const missingOnly = argv.includes("--missing");
if (missingOnly && golden.mode !== "record") { quiet("golden: --missing is a record option (npm run evals:golden:record -- --missing)"); process.exit(2); }

const dir = new URL("./cases/", import.meta.url);
const all: GoldenCase[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) all.push(...((await import(new URL(f, dir).href)).CASES as GoldenCase[]));
all.sort((a, b) => a.n - b.n);
const dupes = [...all.map((c) => c.n).filter((n, i, xs) => xs.indexOf(n) !== i), ...all.map((c) => c.id).filter((n, i, xs) => xs.indexOf(n) !== i)];
if (dupes.length) { quiet(`golden: duplicate case numbers or ids ${dupes.join(", ")}`); process.exit(1); }
const picked = all.filter((x) => !only.length || only.some((o) => x.id.includes(o) || String(x.n) === o));
if (only.length && !picked.length) { quiet(`golden: no case matches --only ${only.join(",")}`); process.exit(1); }

const CASE_TIMEOUT_MS = 150_000;
// A miss caused by the model provider or the cap, not by Co: labelled so it isn't read as a regression.
const INFRA = /\b(401|402|429|529|overloaded|credit balance|rate limit|EVAL CAP|cap reached|ECONNRESET|ETIMEDOUT)\b/i;
let failed = 0;
let noRecording = 0;
const rows: any[] = [];
const t00 = golden.realNow();
quiet(`golden: ${golden.mode} mode, clock pinned at ${golden.now}${golden.mode === "replay" ? ", recordings only (no network)" : golden.mode === "record" ? `, writing ${golden.dir.replace(/^.*\/api\//, "api/")}` : ", real calls, nothing written"}`);
for (const c of picked) {
  const t0 = golden.realNow();
  // A stalled call never holds the check: each attempt has a hard time limit, a timeout is a miss.
  const once = (mode: Mode) => golden.attempt(c.id, mode, () => Promise.race([
    c.run().catch((e: any) => ({ ok: false, misses: [`threw: ${e?.message ?? e}`], observed: "" })),
    new Promise<GoldenResult>((res) => setTimeout(() => res({ ok: false, misses: [`timed out after ${CASE_TIMEOUT_MS / 1000}s`], observed: "" }), CASE_TIMEOUT_MS).unref()),
  ]));
  let mode: Mode = golden.mode;
  let a: Attempt;
  if (missingOnly) {
    // Record only what replay can't answer: a new case, or one whose prompts changed since it was recorded.
    a = await once("replay");
    if (a.misses.length) { mode = "record"; a = await once("record"); }
    else mode = "replay";
  } else a = await once(mode);
  // A live miss on a real call gets one retry, so model variance doesn't block a deploy; a pass on the retry is reported as flaky
  // with the first miss, never hidden (last.local.json keeps it). Two misses fail. Replay is deterministic, so it never retries.
  let flaky: string[] | null = null;
  if (c.status.live && !a.value.ok && mode !== "replay") { const first = a.value; a = await once(mode); if (a.value.ok) flaky = first.misses; }
  // A model call with no recording fails the case whatever it returned (code that catches the error must not hide it).
  const r: GoldenResult = a.misses.length ? { ok: false, misses: [`${a.misses.length} model call(s) with no recording:`, ...a.misses], observed: a.value.observed } : a.value;
  if (a.misses.length) noRecording++;
  const infra = !r.ok && r.misses.some((m) => INFRA.test(m));
  const tag = a.misses.length ? "FAIL(no recording)" : c.status.live ? (r.ok ? (flaky ? "ok~ " : "ok  ") : infra ? "FAIL(infra)" : "FAIL") : r.ok ? "pend(ok)" : "pend";
  // On GitHub, a pass on the retry shows as a warning on the run, not only in the log.
  if (flaky && process.env.GITHUB_ACTIONS) quiet(`::warning title=golden case ${c.n} passed on a retry::${c.id}: first run missed: ${flaky.join("; ").replace(/\n/g, " ").slice(0, 300)}`);
  if ((c.status.live && !r.ok) || a.misses.length) failed++;
  const calls = mode === "replay" ? `${a.served} replayed${a.unused.length ? `, ${a.unused.length} recording(s) unused` : ""}` : mode === "record" ? `${a.recorded} recorded` : "live";
  rows.push({ n: c.n, id: c.id, attempt: a.attempt, live: c.status.live, ok: r.ok, mode, flaky, misses: r.misses, observed: r.observed, calls: { served: a.served, recorded: a.recorded, unused: a.unused }, ms: golden.realNow() - t0 });
  quiet(`${tag} ${String(c.n).padStart(2)} ${c.id}  [${calls}]${r.misses.length ? `  (${r.misses.join(a.misses.length ? "\n      " : "; ")})` : ""}${flaky ? `  [flaky: first run missed: ${flaky.join("; ")}]` : ""}${c.status.live ? "" : `  [until ${c.status.until}]`}\n      ${r.observed.replace(/\n+/g, " / ").slice(0, 260)}`);
  if (mode === "record" && !r.ok && c.status.live) quiet(`      (recorded a miss: replay will miss the same way until this case is re-recorded green)`);
}
// Late work gets its turn, then every miss of the run is read again: one that landed after its case returned (a timer, a queue or
// worker started by an earlier case) or outside any case fails the run here, named with the case it was billed to.
await golden.settle();
const late = golden.allMisses().filter((m) => !rows.some((r) => r.attempt === m.attempt && r.misses.includes(m.miss)));
for (const m of late) {
  const row = rows.find((r) => r.attempt === m.attempt);
  if (row) { row.ok = false; (row.lateMisses ??= []).push(m.miss); }
  failed++;
  quiet(`FAIL(no recording) late, billed to ${m.case ? `case ${m.case}` : "no case (outside any case)"}: ${m.miss}`);
}
writeFileSync(new URL("./last.local.json", import.meta.url), JSON.stringify(rows, null, 2));
const live = rows.filter((r) => r.live);
const liveFailed = live.filter((r) => !r.ok).length;
const flakes = rows.filter((r) => r.flaky).map((r) => r.id);
const s = golden.stats();
quiet(`\ngolden (${golden.mode}${missingOnly ? ", --missing" : ""}): ${live.length - liveFailed}/${live.length} live cases passed${flakes.length ? ` (${flakes.length} on a retry: ${flakes.join(", ")})` : ""}, ${rows.length - live.length} pending${noRecording ? `, ${noRecording} case(s) with model calls that have no recording` : ""}${late.length ? `, ${late.length} late miss(es)` : ""} | ${s.served} model calls replayed, ${s.written} recorded | ${((golden.realNow() - t00) / 1000).toFixed(1)}s`);
// The meter prints the run's cost on exit through console.log: give it back first, so the cost line always shows.
console.log = quiet;
process.exit(failed ? 1 : 0);
