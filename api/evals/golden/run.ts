// Runs every golden case (evals/golden/cases/*.ts, each exporting CASES: GoldenCase[]). See evals/golden/README.md.
//   npm run evals:golden                                   replay (the merge gate): recordings only, zero network, $0
//   npm run evals:golden:record -- --only running-work     record: real calls, capped, the case's recordings rewritten
//   npm run evals:golden:record -- --missing               record only the cases whose replay misses (a new or changed case)
//   npm run evals:golden:record -- --moved                 ...and the cases that replayed on a moved prompt (wording changed)
//   npm run evals:golden -- --ledger <PR>                   replay that records each tone move it sees in moved-ledger.json
//   npm run evals:golden:live                              live: real calls, nothing written (the manual drift check)
//   npm run evals:golden:quality                           quality: each case 3 times, real calls, scored by majority (manual or cron)
//   npm run evals:golden -- --estimate                     what a quality run would cost, from the recordings (no call)
//   npm run evals:golden:stamp                             replay that stamps each recording with its skeleton (no call)
// --only takes ids or numbers, comma-separated (ONLY= works too). Every mode runs through the meter (evals/lib/meter.mjs) and the
// golden recorder (evals/lib/goldenReplay.mjs): no database, no sends, no web; searches and pages are stubbed per case.
// Every reply a case produces also passes the hard rules in code (evals/lib/hardRules.ts, via replies.ts), in every mode.
// Exit 1 when a live case misses, or when any case makes a model call that has no recording; pending cases never fail on their result.
import "../lib/requireMeter.js";
import "dotenv/config";
import "../testEnv.js";
import { readdirSync, writeFileSync } from "node:fs";
import { AWAITING_RECORDING, type GoldenCase, type GoldenResult } from "./types.js";
import { takeReplies, type NotedReply } from "./replies.js";
import { wordingRegistry } from "./wording.js";
import { estimateQuality } from "./estimate.js";
import { failedCriteria, gradeReply } from "../lib/replyRubric.js";
import { moveProblem, readLedger, writeLedger, type LedgerEntry, type Move } from "./ledger.js";

type Mode = "replay" | "record" | "live";
type Moved = { hash: string; model: string | null; moved: Move[] };
type Attempt = { value: GoldenResult; attempt: number; misses: string[]; served: number; recorded: number; unused: string[]; moved: Moved[] };
type Miss = { case: string | null; attempt: number | null; miss: string };
type Hooks = {
  mode: Mode; now: string; realNow: () => number; dir: string; hasRecordings: (id: string) => boolean;
  attempt: (id: string, mode: Mode, fn: () => Promise<GoldenResult>) => Promise<Attempt>;
  settle: () => Promise<void>; allMisses: () => Miss[]; stats: () => { served: number; written: number; inflight: number; moved: number; stamped: number };
  setWording: (w: { signature: string; chunks: { id: string; text: string }[] }) => void; strict: boolean; stamping: boolean;
};
const golden = (globalThis as { __GOLDEN__?: Hooks }).__GOLDEN__;
if (!golden) {
  console.error("\nThe golden cases run through the recorder (evals/lib/goldenReplay.mjs): npm run evals:golden (replay), evals:golden:record or evals:golden:live.\n");
  process.exit(2);
}
const spend = () => ((globalThis as any).__EVAL_METER_SPEND__?.() ?? { cost: 0, calls: 0, capUsd: 0 }) as { cost: number; calls: number; capUsd: number };

const quiet = console.log;
console.log = (...a: any[]) => { if (process.env.GOLDEN_VERBOSE) quiet(...a); };
// Every exit gives console.log back first, so the meter's cost line (printed on exit) always shows.
const exit = (code: number): never => { console.log = quiet; process.exit(code); };
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = (flag("--only") ?? process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const missingOnly = argv.includes("--missing");
const movedToo = argv.includes("--moved");
const quality = argv.includes("--quality");
const estimateOnly = argv.includes("--estimate");
const RUNS = Math.max(1, Number(flag("--runs") ?? process.env.GOLDEN_RUNS ?? 3) || 3);
// --ledger <PR>: record each move this replay sees in evals/golden/moved-ledger.json, dated today (the PR commits the file).
const ledgerPr = flag("--ledger");
const ledger: LedgerEntry[] = readLedger();
const ledgerUsed = new Set<LedgerEntry>();
const today = new Date(golden?.realNow() ?? 0).toISOString().slice(0, 10);
if ((missingOnly || movedToo) && golden.mode !== "record") { quiet("golden: --missing and --moved are record options (npm run evals:golden:record -- --missing)"); exit(2); }
if (quality && golden.mode !== "live") { quiet("golden: --quality makes real calls: npm run evals:golden:quality"); exit(2); }

const dir = new URL("./cases/", import.meta.url);
const all: GoldenCase[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) all.push(...((await import(new URL(f, dir).href)).CASES as GoldenCase[]));
all.sort((a, b) => a.n - b.n);
const dupes = [...all.map((c) => c.n).filter((n, i, xs) => xs.indexOf(n) !== i), ...all.map((c) => c.id).filter((n, i, xs) => xs.indexOf(n) !== i)];
if (dupes.length) { quiet(`golden: duplicate case numbers or ids ${dupes.join(", ")}`); exit(1); }
const picked = all.filter((x) => !only.length || only.some((o) => x.id.includes(o) || String(x.n) === o));
if (only.length && !picked.length) { quiet(`golden: no case matches --only ${only.join(",")}`); exit(1); }

// The wording a prompt may change without a re-record (evals/golden/wording.ts), for the skeleton match and the stamps.
golden.setWording(wordingRegistry());

// The cases a quality run covers: the live ones, and the pending ones that make model calls (recorded, or waiting on their first
// recording: status.until "its first recording"). A pending case whose phase isn't built makes no call and isn't run.
const modelCases = (cs: GoldenCase[]) => cs.filter((c) => c.status.live || golden.hasRecordings(c.id) || c.status.until.startsWith(AWAITING_RECORDING));
if (estimateOnly || quality) {
  const e = estimateQuality(modelCases(picked).map((c) => ({ id: c.id, awaiting: !c.status.live && !golden.hasRecordings(c.id), turns: c.turns })), RUNS);
  const cap = spend().capUsd;
  quiet(`golden quality estimate: ${e.cases.length} cases x ${RUNS} runs = $${e.total.toFixed(2)} ($${e.perRun.toFixed(2)} a run, rubric judge included; cap $${cap.toFixed(2)})${e.unrecorded.length ? `; ${e.unrecorded.length} not recorded yet, counted at the median reply case: ${e.unrecorded.join(", ")}` : ""}`);
  if (estimateOnly) {
    for (const c of [...e.cases].sort((a, b) => b.usd - a.usd)) quiet(`  ${c.id.padEnd(32)} $${c.usd.toFixed(4)} a run${c.recorded ? "" : " (estimated)"}`);
    exit(0);
  }
  // The cap is the meter's and always holds; this only refuses to start a run that can't finish under it.
  if (e.total > cap) { quiet(`golden quality: the estimate is over the cap ($${cap.toFixed(2)}). Raise it on purpose (EVAL_COST_CAP_USD=${Math.ceil(e.total * 1.25)} npm run evals:golden:quality) or narrow the run (--only, --runs).`); exit(2); }
}

const CASE_TIMEOUT_MS = 150_000;
// A miss caused by the model provider or the cap, not by Co: labelled so it isn't read as a regression.
const INFRA = /\b(401|402|429|529|overloaded|credit balance|rate limit|EVAL CAP|cap reached|ECONNRESET|ETIMEDOUT)\b/i;
let failed = 0;
let noRecording = 0;
const rows: any[] = [];
const t00 = golden.realNow();
quiet(`golden: ${quality ? `quality (${RUNS} runs a case)` : golden.mode} mode, clock pinned at ${golden.now}${golden.mode === "replay" ? `, recordings only (no network)${golden.strict ? ", strict (a moved prompt is a miss)" : ""}${golden.stamping ? ", stamping skeletons" : ""}` : golden.mode === "record" ? `, writing ${golden.dir.replace(/^.*\/api\//, "api/")}` : ", real calls, nothing written"}`);

// One try of one case, with the replies it noted (each already through the hard rules).
async function once(c: GoldenCase, mode: Mode): Promise<{ a: Attempt; replies: NotedReply[] }> {
  takeReplies();
  const a = await golden!.attempt(c.id, mode, () => Promise.race([
    c.run().catch((e: any) => ({ ok: false, misses: [`threw: ${e?.message ?? e}`], observed: "" })),
    new Promise<GoldenResult>((res) => setTimeout(() => res({ ok: false, misses: [`timed out after ${CASE_TIMEOUT_MS / 1000}s`], observed: "" }), CASE_TIMEOUT_MS).unref()),
  ]));
  return { a, replies: takeReplies() };
}
const hardOf = (replies: NotedReply[]) => replies.flatMap((n) => n.hard.map((m) => `hard rule: ${m}`));
// A pending case nobody has recorded yet (a new case): its model calls can't be answered, and it isn't run for a result. Reported as
// "not recorded", never as a pass.
const unrecordedPending = (c: GoldenCase) => !c.status.live && golden!.mode === "replay" && !golden!.hasRecordings(c.id);

if (quality) {
  // ---- the quality run: each case RUNS times, real calls; an attempt passes on its own checks, the hard rules and the rubric judge.
  let capped = false;
  for (const c of modelCases(picked)) {
    if (capped) { rows.push({ n: c.n, id: c.id, live: c.status.live, skipped: "the cost cap stopped the run" }); continue; }
    const t0 = golden.realNow();
    const before = spend().cost;
    const tries: any[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { a, replies } = await once(c, "live");
      const hard = hardOf(replies);
      const rubric: { reply: string; failed: string[]; notes: string }[] = [];
      for (const n of replies.filter((x) => x.text.trim() && !/^ERROR /.test(x.text))) {
        const g = await gradeReply({ kind: n.kind, message: n.message, recent: n.recent, known: n.facts, firstName: n.firstName }, n.text);
        rubric.push({ reply: n.text, failed: g ? failedCriteria(g) : ["(the judge's answer didn't parse twice)"], notes: g?.notes ?? "" });
      }
      const ok = a.value.ok && !hard.length && rubric.every((r) => !r.failed.length);
      tries.push({ ok, own: a.value.ok, misses: a.value.misses, hard, rubric, observed: a.value.observed });
      if (a.value.misses.some((m) => /EVAL CAP/.test(m))) { capped = true; break; }
    }
    const passes = tries.filter((t) => t.ok).length;
    const row = { n: c.n, id: c.id, live: c.status.live, runs: tries.length, passes, majority: passes * 2 > tries.length, flaky: passes > 0 && passes < tries.length, own: tries.filter((t) => t.own).length, hardClean: tries.filter((t) => !t.hard.length).length, rubricClean: tries.filter((t) => t.rubric.every((r: any) => !r.failed.length)).length, usd: spend().cost - before, tries, ms: golden.realNow() - t0 };
    rows.push(row);
    const why = [...new Set(tries.flatMap((t) => [...t.misses, ...t.hard, ...t.rubric.flatMap((r: any) => r.failed.map((f: string) => `rubric: ${f}${r.notes ? ` (${r.notes})` : ""}`))]))];
    quiet(`${row.majority ? "pass" : "FAIL"} ${String(c.n).padStart(2)} ${c.id}  ${passes}/${tries.length}${row.flaky ? " flaky" : ""}  [own ${row.own}/${tries.length}, hard rules ${row.hardClean}/${tries.length}, rubric ${row.rubricClean}/${tries.length}]  $${row.usd.toFixed(4)}${c.status.live ? "" : "  [pending]"}${why.length ? `\n      ${why.slice(0, 6).join("\n      ").slice(0, 900)}` : ""}`);
  }
  await golden.settle();
  writeFileSync(new URL("./quality.local.json", import.meta.url), JSON.stringify(rows, null, 2));
  const ran = rows.filter((r) => !r.skipped);
  const live = ran.filter((r) => r.live);
  const s = spend();
  quiet(`\ngolden quality (${RUNS} runs a case, majority): ${live.filter((r) => r.majority).length}/${live.length} live cases pass, ${ran.length - live.length} pending | flaky: ${ran.filter((r) => r.flaky).map((r) => r.id).join(", ") || "none"} | attempts passing: own checks ${ran.reduce((a, r) => a + r.own, 0)}/${ran.reduce((a, r) => a + r.runs, 0)}, hard rules ${ran.reduce((a, r) => a + r.hardClean, 0)}, rubric ${ran.reduce((a, r) => a + r.rubricClean, 0)} | cost $${s.cost.toFixed(4)} of a $${s.capUsd.toFixed(2)} cap${capped ? " | STOPPED AT THE CAP" : ""} | ${((golden.realNow() - t00) / 1000).toFixed(1)}s | detail: evals/golden/quality.local.json`);
  console.log = quiet;
  // A report, never the merge gate: exit 1 only so a scheduled run can alert on a live case failing by majority.
  process.exit(capped ? 3 : live.some((r) => !r.majority) ? 1 : 0);
}

for (const c of picked) {
  const t0 = golden.realNow();
  let mode: Mode = golden.mode;
  let run: { a: Attempt; replies: NotedReply[] };
  if (missingOnly || movedToo) {
    // Record only what replay can't answer: a new case, or one whose prompts changed since it was recorded (--moved: wording too).
    run = await once(c, "replay");
    if (run.a.misses.length || (movedToo && run.a.moved.length)) { mode = "record"; run = await once(c, "record"); }
    else mode = "replay";
  } else run = await once(c, mode);
  const value = () => { const hard = hardOf(run.replies); return { ...run.a.value, ok: run.a.value.ok && !hard.length, misses: [...run.a.value.misses, ...hard] }; };
  let v = value();
  // A live miss on a real call gets one retry, so model variance doesn't block a deploy; a pass on the retry is reported as flaky
  // with the first miss, never hidden (last.local.json keeps it). Two misses fail. Replay is deterministic, so it never retries.
  let flaky: string[] | null = null;
  if (c.status.live && !v.ok && mode !== "replay") { const first = v; run = await once(c, mode); v = value(); if (v.ok) flaky = first.misses; }
  const a = run.a;
  const notRecorded = unrecordedPending(c) && a.misses.length > 0;
  // A model call with no recording fails the case whatever it returned (code that catches the error must not hide it).
  const r: GoldenResult = notRecorded ? { ok: false, misses: [`not recorded yet: ${a.misses.length} model call(s) have no recording (record it: npm run evals:golden:record -- --only ${c.id})`], observed: "" } : a.misses.length ? { ok: false, misses: [`${a.misses.length} model call(s) with no recording:`, ...a.misses], observed: v.observed } : v;
  if (a.misses.length && !notRecorded) noRecording++;
  const infra = !r.ok && r.misses.some((m) => INFRA.test(m));
  const moved = mode === "replay" ? a.moved : [];
  // A move passes only on its ledger entry (evals/golden/ledger.ts): exact, and under 14 days old.
  const moves = [...new Map(moved.flatMap((m) => m.moved).map((x) => [`${x.id}:${x.from}:${x.to}`, x])).values()];
  if (ledgerPr) for (const x of moves) if (x.from && !ledger.some((e) => e.chunk === x.id && e.from === x.from && e.to === x.to)) ledger.push({ chunk: x.id, from: x.from, to: x.to, pr: ledgerPr, date: today });
  for (const x of moves) { const e = ledger.find((l) => l.chunk === x.id && l.from === x.from && l.to === x.to); if (e) ledgerUsed.add(e); }
  const moveMisses = moves.map((x) => moveProblem(x, ledger, golden.realNow())).filter((x): x is string => !!x);
  if (moveMisses.length) { r.ok = false; r.misses = [...r.misses, ...moveMisses.map((m) => `moved: ${m}`)]; }
  const tag = notRecorded ? "pend(not recorded)" : a.misses.length ? "FAIL(no recording)" : c.status.live ? (r.ok ? (flaky ? "ok~ " : moved.length ? "ok(moved)" : "ok  ") : infra ? "FAIL(infra)" : moveMisses.length ? "FAIL(moved)" : "FAIL") : r.ok ? "pend(ok)" : "pend";
  // On GitHub, a pass on the retry or on a moved prompt shows as a warning on the run, not only in the log.
  if (flaky && process.env.GITHUB_ACTIONS) quiet(`::warning title=golden case ${c.n} passed on a retry::${c.id}: first run missed: ${flaky.join("; ").replace(/\n/g, " ").slice(0, 300)}`);
  if (moved.length && process.env.GITHUB_ACTIONS) quiet(`::warning title=golden case ${c.n} replayed on a moved prompt::${c.id}: ${[...new Set(moves.map((m) => m.id))].join(", ").slice(0, 300)}. Its model answers predate the change: re-record it or run the quality run.`);
  if ((c.status.live && !r.ok) || (a.misses.length && !notRecorded)) failed++;
  const movedNames = [...new Set(moves.map((m) => m.id))];
  const calls = mode === "replay" ? `${a.served} replayed${moved.length ? `, ${moved.length} on a moved prompt (${movedNames.join(", ")})` : ""}${a.unused.length ? `, ${a.unused.length} recording(s) unused` : ""}` : mode === "record" ? `${a.recorded} recorded` : "live";
  rows.push({ n: c.n, id: c.id, attempt: a.attempt, live: c.status.live, ok: r.ok, mode, flaky, moved: movedNames, notRecorded, misses: r.misses, observed: r.observed, replies: run.replies.map((x) => ({ kind: x.kind, text: x.text, sends: x.sends?.length ?? 0, hard: x.hard })), calls: { served: a.served, recorded: a.recorded, unused: a.unused }, ms: golden.realNow() - t0 });
  quiet(`${tag} ${String(c.n).padStart(2)} ${c.id}  [${calls}]${r.misses.length ? `  (${r.misses.join(a.misses.length ? "\n      " : "; ")})` : ""}${flaky ? `  [flaky: first run missed: ${flaky.join("; ")}]` : ""}${c.status.live ? "" : `  [until ${c.status.until}]`}\n      ${r.observed.replace(/\n+/g, " / ").slice(0, 260)}`);
  if (mode === "record" && !r.ok && c.status.live) quiet(`      (recorded a miss: replay will miss the same way until this case is re-recorded green)`);
}
// Late work gets its turn, then every miss of the run is read again: one that landed after its case returned (a timer, a queue or
// worker started by an earlier case) or outside any case fails the run here, named with the case it was billed to.
await golden.settle();
const late = golden.allMisses().filter((m) => !rows.some((r) => r.attempt === m.attempt && (r.misses.includes(m.miss) || r.notRecorded)));
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
const movedCases = rows.filter((r) => r.moved?.length && r.ok).map((r) => r.id);
const unrecorded = rows.filter((r) => r.notRecorded).map((r) => r.id);
const s = golden.stats();
if (ledgerPr) writeLedger(ledger);
const staleEntries = ledger.filter((e) => !ledgerUsed.has(e));
// merge-gated.sh keeps the first 50 characters of the line that has "golden (replay)": a run with moved cases starts it with MOVED.
quiet(`\n${movedCases.length ? `MOVED: ${movedCases.length} case(s) on ledgered wording | ` : ""}golden (${golden.mode}${missingOnly ? ", --missing" : ""}${movedToo ? ", --moved" : ""}): ${live.length - liveFailed}/${live.length} live cases passed${flakes.length ? ` (${flakes.length} on a retry: ${flakes.join(", ")})` : ""}, ${rows.length - live.length} pending${unrecorded.length ? ` (${unrecorded.length} not recorded yet: ${unrecorded.join(", ")})` : ""}${noRecording ? `, ${noRecording} case(s) with model calls that have no recording` : ""}${late.length ? `, ${late.length} late miss(es)` : ""} | ${rows.reduce((n, r) => n + (r.replies?.length ?? 0), 0)} replies through the hard rules | ${s.served} model calls replayed, ${s.written} recorded${s.stamped ? `, ${s.stamped} recordings stamped` : ""} | ${((golden.realNow() - t00) / 1000).toFixed(1)}s`);
if (golden.mode === "replay" && !only.length && staleEntries.length) quiet(`LEDGER: ${staleEntries.length} entr${staleEntries.length === 1 ? "y" : "ies"} no case uses any more (re-recorded): remove ${staleEntries.map((e) => `${e.chunk} (${e.pr})`).join(", ")} from evals/golden/moved-ledger.json`);
if (movedCases.length) quiet(`PROMPT MOVED: ${movedCases.length} case(s) passed on recorded answers to an older wording of their prompt (${movedCases.join(", ")}). The code paths ran; how the model answers the new wording is untested until a quality run (npm run evals:golden:quality) or a re-record (npm run evals:golden:record -- --moved).`);
// The meter prints the run's cost on exit through console.log: give it back first, so the cost line always shows.
console.log = quiet;
process.exit(failed ? 1 : 0);
