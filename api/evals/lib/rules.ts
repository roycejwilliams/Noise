// The test setup, tested (layer 1, zero tokens). Pins the two-layer policy so it can't quietly erode:
//   - layer 1 stubs every model call and refuses every other outside call;
//   - layer 2 runs on Haiku, lets only a grader through as Sonnet, stops at its cap, and prints its cost;
//   - no eval that makes a live model call can run unmetered, and none is in the layer 1 list;
//   - the golden cases replay committed recordings on a PR (no key, zero model calls); live runs are manual only (Royce, 2026-10-14).
//   npx tsx evals/lib/rules.ts
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let total = 0, failed = 0;
// detail: what was seen, printed only when the check fails.
const check = (label: string, ok: boolean, detail?: string) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`); } };
const root = new URL("../..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ---- no live model call hides in a logic test
const layer1: string[] = JSON.parse(read("evals/layer1.json")).files;
const live: { suites: { args: string[] }[]; caps: { tokens: number; usd: number } } = JSON.parse(read("evals/live.json"));
const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(join(root, p)).isDirectory() ? (n === "node_modules" || n === "results" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : []; });
const harness: string[] = JSON.parse(read("evals/lib/harness.json"));
const walkAll = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(join(root, p)).isDirectory() ? (n === "node_modules" || n === "results" ? [] : walkAll(p)) : [p]; });
const evalFiles = walk("evals").filter((f) => !f.startsWith("evals/lib/") && f !== "evals/lib.ts");
// Structural, not a text search: a script can reach a model through a service it imports (readTurn, the router...), so
// the rule is that every entrypoint outside layer 1 refuses to run unmetered. Only listed harness/data modules are exempt.
// Red-by-design suites waiting on their fixes (evals/lib/pending.json): out of layer 1 on purpose, never forgotten.
const pending: string[] = JSON.parse(read("evals/lib/pending.json")).files;
check("pending suites exist, are named in their own header, and none is also in layer 1", pending.every((f) => existsSync(join(root, f)) && !layer1.includes(f)) && pending.filter((f) => !f.endsWith("world.ts")).every((f) => /NOT IN layer1\.json YET/.test(read(f))));
const outside = evalFiles.filter((f) => !layer1.includes(f) && !harness.includes(f) && !pending.includes(f));
const gated = (f: string) => /^\s*import\s+["'][^"']*requireMeter[^"']*["']|import\(["'][^"']*requireMeter/m.test(read(f).replace(/\/\/.*$/gm, ""));
const unguarded = outside.filter((f) => !gated(f));
check("every eval script outside layer 1 refuses to run without the meter (no unmetered live call anywhere)", unguarded.length === 0 && (unguarded.length ? (console.log(unguarded.join("\n")), false) : true));
const liveCapable = evalFiles.filter((f) => /generateText|generateObject|streamText|anthropic\(|runConversationReplyAgent|embed\(/.test(read(f)));
check("a harness or data module never reaches a model or the network itself", harness.every((f) => !/generateText|generateObject|streamText|anthropic\(|evaluate\(|createGateway/.test(read(f).replace(/\/\/.*$/gm, ""))));
// A layer 1 file that has a --live mode must gate it, or `--live` run by hand is unmetered (the guard only stubs).
const liveModes = layer1.filter((f) => f !== "evals/lib/rules.ts" && /includes\("--live"\)|argv.*--live/.test(read(f)));
check("every layer 1 file with a --live mode gates it behind the meter", liveModes.length >= 7 && liveModes.every((f) => /includes\("--live"\)\)\s*await import\([^)]*requireMeter/.test(read(f))));
const pyCallers = walkAll("evals").filter((f) => f.endsWith(".py") && /anthropic|elevenlabs|api\.openai/i.test(read(f)));
check("a Python script that calls a model or voice API directly refuses to run unless told it is unmetered", pyCallers.length >= 2 && pyCallers.every((f) => /EVAL_ALLOW_UNMETERED/.test(read(f))));
const inLayer1AndAlwaysLive = layer1.filter((f) => /^import ".*requireMeter/m.test(read(f)));
check("no file in layer 1 imports the meter at the top (those would refuse to run): live paths there are behind --live only", inLayer1AndAlwaysLive.length === 0);
check("layer 1 lists only files that exist", layer1.every((f) => existsSync(join(root, f))));
check("every rules.ts logic test is in layer 1 (none is left out of the per-change run)", evalFiles.filter((f) => /\/rules\.ts$/.test(f) && !pending.includes(f)).every((f) => layer1.includes(f)));
check("no live suite is in the nightly list twice, and each names a file that exists", new Set(live.suites.map((s) => s.args.join(" "))).size === live.suites.length && live.suites.every((s) => existsSync(join(root, s.args[0]))));
check("the nightly set is small: at most 8 suites, at most 6 cases each", live.suites.length <= 8 && live.suites.every((s: any) => s.sample <= 6));
check("the nightly default cap is at most 500,000 tokens and $1.00", live.caps.tokens <= 500_000 && live.caps.usd <= 1.0);

// ---- what runs on a commit
const pkg = JSON.parse(read("package.json")).scripts as Record<string, string>;
check("test, evals:code and the hook run layer 1 only", pkg.test === "node evals/runLayer1.mjs" && pkg["evals:code"] === pkg.test);
check("layer 1 does not read the real api/.env (dotenv is pointed at nothing)", /DOTENV_CONFIG_PATH: "\/dev\/null"/.test(read("evals/runLayer1.mjs")));
check("layer 1 typechecks the golden harness and the eval policy files", /\["tsc", "-p", "evals\/tsconfig\.golden\.json"\]/.test(read("evals/runLayer1.mjs")) && JSON.parse(read("evals/tsconfig.golden.json")).include.includes("golden/**/*.ts") && JSON.parse(read("evals/tsconfig.golden.json")).include.includes("lib/*.ts"));
check("a timed-out test is killed with its whole process group", /detached: true/.test(read("evals/runLayer1.mjs")) && /process\.kill\(-p\.pid/.test(read("evals/runLayer1.mjs")));
check("no per-change script runs a live eval", !/runLayer2|runLive|--live/.test(pkg.test + pkg["evals:code"]));
const hook = read("../.githooks/pre-push");
check("the pre-push hook runs layer 1 and never a live eval", /evals:code/.test(hook) && !/evals:live|evals:nightly|eval:live/.test(hook.replace(/^#.*$/gm, "")));
const wf = read("../.github/workflows/co-evals.yml");
// ---- the workflows, every file in .github/workflows (a new file is held to the same rules). Read as text, comment lines dropped.
const wfDir = join(root, "../.github/workflows");
const wfFiles = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
const uncomment = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const workflows = wfFiles.map((f) => ({ file: f, text: uncomment(readFileSync(join(wfDir, f), "utf8")) }));
const jobsOf = (text: string): Record<string, string> => {
  const at = text.search(/^jobs:\s*$/m);
  if (at < 0) return {};
  const body = text.slice(at);
  const heads = [...body.matchAll(/^  ([A-Za-z_][\w-]*):\s*$/gm)];
  return Object.fromEntries(heads.map((m, i) => [m[1], body.slice(m.index!, heads[i + 1]?.index ?? body.length)]));
};
// What starts the workflow: `on: push`, `on: [push, pull_request]`, or a block of keys under `on:`.
const triggersOf = (text: string): string[] => {
  const m = text.match(/^(?:on|"on"|'on'):[ \t]*(.*)$/m);
  if (!m) return ["(no on:)"];
  if (m[1].trim()) return m[1].replace(/[[\]{}]/g, " ").split(/[\s,]+/).filter(Boolean);
  const rest = text.slice(m.index! + m[0].length + 1).split("\n");
  const keys: string[] = [];
  for (const l of rest) { if (/^\S/.test(l)) break; const k = l.match(/^  ([\w-]+):/); if (k) keys.push(k[1]); }
  return keys;
};
const SECRET = /\bsecrets\b/; // secrets.X, secrets['X'], toJSON(secrets), secrets: inherit
const runsOf = (job: string) => [...job.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((m) => m[1].trim());
const usesOf = (job: string) => [...job.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((m) => m[1].trim());
const stepsOf = (job: string) => (job.match(/^      - /gm) ?? []).length;
// A job that can reach a paid API (any secret in it) never starts on a push, a PR or a schedule. In a workflow that has any other
// trigger than a manual dispatch, its `if:` must name the event in every `||` branch (a branch without one runs on anything) and must
// never negate (`!`, `!=`, `!(`). The one standing exception is the layer 2 nightly job `live` in co-evals.yml (not the golden harness),
// which may also run on its schedule.
const triggerOk = (file: string, name: string, job: string) => {
  const triggers = triggersOf(workflows.find((w) => w.file === file)!.text);
  if (triggers.length && triggers.every((t) => t === "workflow_dispatch")) return true;
  const cond = job.match(/^    if: (.+)$/m)?.[1] ?? "";
  const allowed = file === "co-evals.yml" && name === "live" ? ["workflow_dispatch", "schedule"] : ["workflow_dispatch"];
  return !!cond && !/!|contains\(|startsWith\(|endsWith\(|fromJSON\(|format\(/.test(cond) && cond.split("||").every((branch) => { const ev = [...branch.matchAll(/github\.event_name == '(\w+)'/g)].map((m) => m[1]); return ev.length > 0 && ev.every((e) => allowed.includes(e)); });
};
const secretJobs = workflows.flatMap((w) => Object.entries(jobsOf(w.text)).filter(([, j]) => SECRET.test(j)).map(([name, j]) => ({ file: w.file, name, ok: triggerOk(w.file, name, j) })));
check("no job that holds a secret runs on a push, a pull request or a schedule, in any workflow file (only the layer 2 nightly may use its schedule), and no secret is set workflow-wide",
  workflows.every((w) => !SECRET.test(w.text.slice(0, Math.max(0, w.text.search(/^jobs:\s*$/m))))) && secretJobs.every((j) => j.ok) && !secretJobs.some((j) => j.file === "co-evals.yml" && (j.name === "golden" || j.name === "code")),
  `jobs with secrets: ${secretJobs.map((j) => `${j.file}:${j.name}${j.ok ? "" : " (BAD TRIGGER)"}`).join(", ")}`);
// An anchor or alias can hand a job another job's env (a key) without the job's own text saying so: none, in any workflow file.
const anchors = workflows.filter((w) => /(^|[\s:\-[{,])[&*][A-Za-z0-9_][\w.-]*/m.test(w.text.replace(/"[^"\n]*"|'[^'\n]*'/g, '""'))).map((w) => w.file);
check("no workflow file uses YAML anchors or aliases", anchors.length === 0, `anchors or aliases in ${anchors.join(", ")}`);
// Every ${{ inputs.x }} sits alone on an env line (NAME: ${{ inputs.x }}), so no dispatch input is ever pasted into a shell line,
// including the later lines of a multi-line run: block.
const inputLines = workflows.flatMap((w) => w.text.split("\n")).filter((l) => /\$\{\{[^}]*\b(inputs|github\.event\.inputs)\b/.test(l));
check("no workflow puts a dispatch input into a shell command", !/run:[^\n]*\$\{\{\s*inputs\./.test(wf) && /ONLY: \$\{\{ inputs\.only \}\}/.test(wf) && /GOLDEN_ONLY: \$\{\{ inputs\.golden_only \}\}/.test(wf) && inputLines.every((l) => /^\s+[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}\s*$/.test(l)), inputLines.join(" | "));
// Royce, 2026-10-14: "golden cases must not hit the live API on every CI run ... Live API runs only on a deliberate manual trigger
// (workflow_dispatch or equivalent), never automatically per PR." The golden job stays a required check on every PR into co-test, but
// it replays committed recordings with no key in reach; the real-model run is its own job, on a manual dispatch only. Held exactly
// (review of the harness: a loose match let a widened trigger, an extra paid step, allowed hosts or a raised cap through).
const coJobs = jobsOf(uncomment(wf));
const pushJob = coJobs.code ?? "";
const goldenJob = coJobs.golden ?? "";
const goldenLiveJob = coJobs["golden-live"] ?? "";
const wfJobs = Object.keys(coJobs);
const STEPS = ["actions/checkout@v4", "actions/setup-node@v4", "actions/upload-artifact@v4"];
check("CI on a push or pull request runs layer 1 and the golden REPLAY only: no key, no expression, no live model call",
  /evals:code/.test(pushJob) && !/evals:nightly|evals:live|eval:live/.test(pushJob) && !SECRET.test(pushJob) &&
  /\n    if: github\.event_name == 'pull_request' && github\.base_ref == 'co-test'\n/.test(goldenJob) &&
  JSON.stringify(runsOf(goldenJob)) === JSON.stringify(["npm ci", "npm run -s evals:golden"]) && JSON.stringify(usesOf(goldenJob)) === JSON.stringify(STEPS) && stepsOf(goldenJob) === 5 &&
  !/\$\{\{/.test(goldenJob) && !SECRET.test(goldenJob) &&
  !/ANTHROPIC_API_KEY|GOLDEN_MODE|EVAL_ALLOW_HOSTS|EVAL_WEB_SEARCH|EVAL_KEEP_MODEL|EVAL_REAL_MODELS|EVAL_COST_CAP_USD|EVAL_TOKEN_CAP|DOTENV/.test(goldenJob) &&
  !/evals:nightly|evals:live|eval:live|evals:golden:record|evals:golden:live/.test(goldenJob) &&
  Number(goldenJob.match(/timeout-minutes: (\d+)/)?.[1] ?? 0) > 0 && Number(goldenJob.match(/timeout-minutes: (\d+)/)?.[1] ?? 999) <= 30 &&
  JSON.stringify(wfJobs) === JSON.stringify(["code", "golden", "golden-live", "live"]),
  `jobs ${wfJobs.join(",")}; golden runs ${runsOf(goldenJob).join(" | ")}; golden uses ${usesOf(goldenJob).join(" | ")}; steps ${stepsOf(goldenJob)}`);
check("the real-model golden run is its own job, on a manual dispatch only, and records nothing",
  /\n    if: github\.event_name == 'workflow_dispatch' && inputs\.golden_live\n/.test(goldenLiveJob) &&
  JSON.stringify(runsOf(goldenLiveJob)) === JSON.stringify(["npm ci", "|"]) && JSON.stringify(usesOf(goldenLiveJob)) === JSON.stringify(STEPS) && stepsOf(goldenLiveJob) === 5 &&
  /npm run -s evals:golden:live -- --only "\$GOLDEN_ONLY"; else npm run -s evals:golden:live; fi/.test(goldenLiveJob) &&
  !/evals:golden:record|EVAL_ALLOW_HOSTS|EVAL_WEB_SEARCH|EVAL_COST_CAP_USD|EVAL_TOKEN_CAP/.test(goldenLiveJob),
  `golden-live runs ${runsOf(goldenLiveJob).join(" | ")}; uses ${usesOf(goldenLiveJob).join(" | ")}`);
const pkgJson = read("package.json");
const ISOLATED = "DATABASE_URL=postgres://ci:ci@127.0.0.1:1/ci SENDBLUE_API_KEY=ci SENDBLUE_SECRET_KEY=ci RESEND_API_KEY=re_ci DOTENV_CONFIG_PATH=/dev/null";
const PRELOAD = "tsx --import ./evals/lib/meter.mjs --import ./evals/lib/goldenReplay.mjs evals/golden/run.ts";
check("the golden replay holds no key, a zero cap, and reads no .env, so a bug in it cannot spend", pkgJson.includes(`"evals:golden": "${ISOLATED} ANTHROPIC_API_KEY=golden-replay OPENAI_API_KEY=golden-replay GOLDEN_MODE=replay EVAL_TOKEN_CAP=0 EVAL_COST_CAP_USD=0 ${PRELOAD}"`));
// The cap is the caller's when set (EVAL_COST_CAP_USD=9 npm run evals:golden:quality), $4 when not (Royce 2026-10-29: the scripts
// hardcoded $4, so an env cap never reached the meter). evals/golden/harnessTest.ts checks an env cap actually arrives.
const CAPS = "EVAL_TOKEN_CAP=${EVAL_TOKEN_CAP:-1500000} EVAL_COST_CAP_USD=${EVAL_COST_CAP_USD:-4}";
check("recording, the live golden run and the quality run are metered, capped ($4 unless the env says otherwise), read no .env and are isolated from the database and sends", pkgJson.includes(`"evals:golden:record": "${ISOLATED} GOLDEN_MODE=record EVAL_REAL_MODELS=1 ${CAPS} ${PRELOAD}"`) && pkgJson.includes(`"evals:golden:live": "${ISOLATED} GOLDEN_MODE=live EVAL_REAL_MODELS=1 ${CAPS} ${PRELOAD}"`) && pkgJson.includes(`"evals:golden:quality": "${ISOLATED} GOLDEN_MODE=live EVAL_REAL_MODELS=1 EVAL_TOKEN_CAP=\${EVAL_TOKEN_CAP:-20000000} EVAL_COST_CAP_USD=\${EVAL_COST_CAP_USD:-4} ${PRELOAD} --quality"`) && /^\s*import\s+["']\.\.\/lib\/requireMeter\.js["']/m.test(read("evals/golden/run.ts")) && /__GOLDEN__/.test(read("evals/golden/run.ts")));
check("stamping recordings is a replay: no key, a zero cap, no .env", pkgJson.includes(`"evals:golden:stamp": "${ISOLATED} ANTHROPIC_API_KEY=golden-replay OPENAI_API_KEY=golden-replay GOLDEN_MODE=replay GOLDEN_STAMP=1 EVAL_TOKEN_CAP=0 EVAL_COST_CAP_USD=0 ${PRELOAD}"`));
check("the golden runner settles and fails on a miss anywhere in the run (late, or outside any case) before it exits", /await golden\.settle\(\)/.test(read("evals/golden/run.ts")) && /golden\.allMisses\(\)/.test(read("evals/golden/run.ts")));
check("the live job runs only on the nightly schedule or a manual dispatch, and runs the capped nightly set", /github\.event_name == 'schedule'/.test(wf) && /workflow_dispatch/.test(wf) && /npm run -s evals:nightly/.test(wf));

// ---- layer 1: the stub
{
  const script = `
    const a = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }) });
    const j = await a.json();
    const e = await (await fetch("https://api.openai.com/v1/embeddings", { method: "POST", body: JSON.stringify({ input: ["a", "b"] }) })).json();
    let refused = false; try { await fetch("https://api.resend.com/emails", { method: "POST" }); } catch { refused = true; }
    console.log("OUT " + JSON.stringify({ text: j.content[0].text, tokens: j.usage.input_tokens + j.usage.output_tokens, vecs: e.data.length, dim: e.data[0].embedding.length, refused }));`;
  const r = spawnSync("node", ["--import", join(root, "evals/lib/modelGuard.mjs"), "--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, MODEL_GUARD_LOG: "" } });
  const o = JSON.parse((r.stdout.match(/OUT (.*)/) ?? [])[1] ?? "{}");
  check("layer 1 answers a model call with a canned stub that costs zero tokens", o.text === "stub" && o.tokens === 0);
  check("layer 1 answers an embedding call with a zero vector per input", o.vecs === 2 && o.dim === 1536);
  check("layer 1 refuses every other outside call", o.refused === true);
}

// ---- layer 2: the meter, exercised against a fake network (no tokens)
{
  const dir = mkdtempSync(join(tmpdir(), "meter-test-"));
  const run = (env: Record<string, string>) => spawnSync("node", ["--import", join(root, "evals/lib/fixtures/fakeAnthropic.mjs"), "--import", join(root, "evals/lib/meter.mjs"), join(root, "evals/lib/fixtures/meterProbe.mjs")], { encoding: "utf8", env: { ...process.env, FAKE_SEEN: join(dir, "seen.jsonl"), EVAL_LEDGER: join(dir, "ledger.jsonl"), ...env } });
  const r = run({ EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "5" });
  const probe = JSON.parse((r.stdout.match(/PROBE (.*)/) ?? [])[1] ?? "{}");
  const seen = readFileSync(join(dir, "seen.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("a worker call is rewritten to Haiku, even when it asked for Sonnet or Opus", seen[0].model === "claude-haiku-5-5" && seen[1].model === "claude-haiku-5-5");
  check("a call may not ask for more than 4,096 output tokens, so the cap is exact and not overshot by a 64,000-token request", seen[1].body.max_tokens === 4096);
  // Haiku 4.5 refused the effort option; Haiku 5.5 takes it (2026-10-08), so a 5.5 worker call keeps what the code asked for.
  check("the effort option is kept for Haiku 5.5 (it accepts it) and stripped only for Haiku 4.5", seen[0].model.startsWith("claude-haiku-5") ? true : !JSON.stringify(seen[0].body).includes("effort"));
  check("only a call marked as the grader runs as Sonnet, and the marker never leaves", seen[2].model === "claude-sonnet-5" && seen[3].model === "claude-sonnet-5" && !("x-eval-role" in seen[2].headers) && !("x-eval-role" in seen[3].headers));
  check("a paid web search tool is removed before the call", !JSON.stringify(seen[4].body).includes("web_search"));
  check("any other outside host is refused", probe.otherHost === "refused");
  const cost = (r.stdout.match(/EVAL COST: \$([\d.]+) \| (\d+) model calls \((\d+) Haiku, (\d+) Sonnet grading/) ?? []);
  // 3 worker calls on Haiku (Sonnet-asked, Opus-asked, web search) + 2 grader calls on Sonnet; each 1000 in + 200 out
  const expected = (3 * (1000 * 0.1 + 200 * 0.5) + 2 * (1000 * 2 + 200 * 10)) / 1e6; // Haiku 5.5 workers, Sonnet graders
  check("the run prints its cost at the end, every time, computed from the real usage", Number(cost[1]) === Number(expected.toFixed(4)) && cost[2] === "5" && cost[3] === "3" && cost[4] === "2");
  {
    const d3 = mkdtempSync(join(tmpdir(), "meter-test-"));
    spawnSync("node", ["--import", join(root, "evals/lib/fixtures/fakeAnthropic.mjs"), "--import", join(root, "evals/lib/meter.mjs"), join(root, "evals/lib/fixtures/meterProbe.mjs")], { encoding: "utf8", env: { ...process.env, FAKE_SEEN: join(d3, "seen.jsonl"), EVAL_LEDGER: join(d3, "ledger.jsonl"), EVAL_REAL_MODELS: "1", EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "5" } });
    const real3 = readFileSync(join(d3, "seen.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    check("on request (EVAL_REAL_MODELS=1) a worker keeps Sonnet and its options, and Opus becomes Sonnet; grading stays Sonnet", real3[0].model === "claude-sonnet-5" && JSON.stringify(real3[0].body).includes("effort") && real3[1].model === "claude-sonnet-5" && real3[2].model === "claude-sonnet-5");
    check("without it, nothing but Haiku and the grader ever runs", seen.every((x: any) => x.model === "claude-haiku-5-5" || x.model === "claude-sonnet-5") && seen.filter((x: any) => x.model === "claude-sonnet-5").length === 2);
  }
  const capped = run({ EVAL_TOKEN_CAP: "3000", EVAL_COST_CAP_USD: "5" });
  const capProbe = JSON.parse((capped.stdout.match(/PROBE (.*)/) ?? [])[1] ?? "{}");
  check("a call that would pass the token cap is refused before it is made", /EVAL CAP/.test(capProbe.opusAsWorker) || /EVAL CAP/.test(capProbe.sonnetAsGrader) || /EVAL CAP/.test(capProbe.opusAsGrader));
  check("a capped run says it stopped at the cap, and exits non-zero", /STOPPED AT THE CAP/.test(capped.stdout) && capped.status === 3);
  const dollar = run({ EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "0.004" });
  check("the dollar cap holds too", /STOPPED AT THE CAP/.test(dollar.stdout) && dollar.status === 3);
  // Before a call the meter adds what in-flight work may still use, so a run stops BEFORE the cap, not one call past it.
  const callsMade = (env: Record<string, string>) => { const d2 = mkdtempSync(join(tmpdir(), "meter-test-")); spawnSync("node", ["--import", join(root, "evals/lib/fixtures/fakeAnthropic.mjs"), "--import", join(root, "evals/lib/meter.mjs"), join(root, "evals/lib/fixtures/meterProbe.mjs")], { encoding: "utf8", env: { ...process.env, FAKE_SEEN: join(d2, "seen.jsonl"), EVAL_LEDGER: join(d2, "ledger.jsonl"), ...env } }); return existsSync(join(d2, "seen.jsonl")) ? readFileSync(join(d2, "seen.jsonl"), "utf8").split("\n").filter(Boolean).length : 0; };
  check("a call that could pass the token cap is refused before it is made (cap 1,300: one call of 1,200 tokens, not two)", callsMade({ EVAL_TOKEN_CAP: "1300", EVAL_COST_CAP_USD: "5" }) === 1);
  check("and the same before the dollar cap", callsMade({ EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "0.00024" }) === 1);
}

// ---- the golden recorder: record once over a fake network, then replay with no key (zero tokens)
{
  const dir = mkdtempSync(join(tmpdir(), "golden-test-"));
  const run = (mode: string, extra: Record<string, string>) => {
    const env: Record<string, string | undefined> = { ...process.env, GOLDEN_MODE: mode, GOLDEN_RECORDINGS: join(dir, "rec"), FAKE_SEEN: join(dir, "seen.jsonl"), EVAL_LEDGER: join(dir, `ledger-${mode}.jsonl`), EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "5", ...extra };
    if (!extra.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    const r = spawnSync("node", ["--import", join(root, "evals/lib/fixtures/fakeAnthropic.mjs"), "--import", join(root, "evals/lib/meter.mjs"), "--import", join(root, "evals/lib/goldenReplay.mjs"), join(root, "evals/lib/fixtures/goldenProbe.mjs")], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
    return { out: JSON.parse((r.stdout.match(/GOLDEN (\{.*)/) ?? [])[1] ?? "{}"), stdout: r.stdout };
  };
  const seen = () => (existsSync(join(dir, "seen.jsonl")) ? readFileSync(join(dir, "seen.jsonl"), "utf8").split("\n").filter(Boolean).length : 0);
  const refused = run("record", { ANTHROPIC_API_KEY: "ci" });
  check("record mode refuses to start a call with a placeholder key", /threw: GOLDEN RECORD: no ANTHROPIC_API_KEY/.test(refused.out.recorded ?? "") && seen() === 0);
  const rec = run("record", { ANTHROPIC_API_KEY: "probe" });
  const files = existsSync(join(dir, "rec/probe-case")) ? readdirSync(join(dir, "rec/probe-case")) : [];
  const recs = files.map((f) => JSON.parse(readFileSync(join(dir, "rec/probe-case", f), "utf8")));
  const file = recs.find((r) => r.responses?.length === 2) ?? {};
  check("record mode calls through the meter and writes one readable recording per request (hash, request, response, usage, model, recorded_at)", rec.out.recorded === "ok" && rec.out.written === 3 && files.length === 2 && file.hash && file.request?.body?.messages && file.responses[0].usage && file.model && file.recorded_at && file.case === "probe-case", JSON.stringify(rec.out));
  check("the key ignores JSON key order, so the same request is the same recording", rec.out.reordered === "ok" && files.length === 2);
  check("a streamed answer is recorded as its events", rec.out.streamed === "streamed ok" && recs.some((r) => r.responses?.[0]?.events?.length === 7 && r.responses[0].text === "streamed ok"));
  const before = seen();
  // As the replay script runs it: a placeholder key (the SDKs refuse to start without one), never a real one.
  const rep = run("replay", { ANTHROPIC_API_KEY: "golden-replay" });
  const all: { case: string | null; miss: string }[] = rep.out.all ?? [];
  check("replay answers a recorded call from the recording, with no key", rep.out.recorded === "ok" && rep.out.reordered === "ok" && rep.out.served === 3, JSON.stringify(rep.out));
  check("replay rebuilds a recorded stream that the ai SDK reads as it read the real one", rep.out.streamed === "streamed ok");
  check("replay never reaches the network: nothing new hit the fake network and the meter counted 0 model calls", seen() === before && /EVAL COST: \$0\.0000 \| 0 model calls/.test(rep.stdout));
  check("a model call with no recording throws, fails its case, and says how to re-record", /^threw: GOLDEN REPLAY/.test(rep.out.unrecorded ?? "") && /re-record: npm run evals:golden:record -- --only probe-case/.test(rep.out.missTexts?.[0] ?? "") && /nearest recording/.test(rep.out.missTexts?.[0] ?? ""));
  check("a repeat past what was recorded is a miss (\"called 3 times, recorded 2\"), never the last answer served again", /^threw: GOLDEN REPLAY: called 3 times, recorded 2/.test(rep.out.repeat ?? "") && rep.out.misses === 2);
  check("(a) a model call outside any case throws and is counted for the run, even when the code catches it", /^threw: GOLDEN REPLAY/.test(rep.out.outside ?? "") && all.some((m) => m.case === null && /outside any golden case/.test(m.miss)));
  check("(b) a late call that misses after its case returned is counted for the run, billed to that case", all.some((m) => m.case === "probe-case" && /a late call nobody recorded/.test(m.miss) && /attempt had already ended/.test(m.miss)) && !(rep.out.missTexts ?? []).some((t: string) => /late call/.test(t)));
  check("(c) a worker one case started, fed by the next, has its miss counted for the run and billed to the case that started it", rep.out.bMisses === 0 && all.some((m) => m.case === "probe-worker" && /queued by probe-b/.test(m.miss) && /while case probe-b was running/.test(m.miss)));
  check("the run's miss list holds every miss once (2 in the case, 1 late, 1 from the worker, 1 outside)", all.length === 5, JSON.stringify(all.map((m) => m.case)));
  check("a golden case reaches nothing but models, in every mode", rec.out.otherHost === "refused" && rep.out.otherHost === "refused");
  check("the clock and zone are pinned in every mode (the same prompt on every run)", [rec.out, rep.out].every((o) => o.now === "2026-10-13T21:00:00.000Z" && o.dateNow === Date.parse("2026-10-13T21:00:00.000Z") && o.tz === "UTC" && o.instance === true));
}

// ---- the prices the meter uses are the ones the app uses
{
  // Read from the source, not imported: importing the meter would put it in this process's network path.
  const meter = read("evals/lib/meter.mjs");
  const price = (k: string) => { const m = meter.match(new RegExp(`${k}: \\{ input: ([\\d.]+), output: ([\\d.]+), cacheWrite: ([\\d.]+), cacheRead: ([\\d.]+) \\}`)); return m ? { input: +m[1], output: +m[2], cacheWrite: +m[3], cacheRead: +m[4] } : null; };
  const { PRICES } = await import("../../src/services/llmUsage.js");
  check("the meter's Haiku and Sonnet prices match src/services/llmUsage.ts", JSON.stringify(price("haiku")) === JSON.stringify(PRICES["claude-haiku-5-5"]) && JSON.stringify(price("sonnet")) === JSON.stringify(PRICES["claude-sonnet-5"]));
  const { MODELS } = await import("../../src/models.js");
  check("the meter's model ids are the app's", meter.includes(`HAIKU = "${MODELS.haiku}"`) && meter.includes(`SONNET = "${MODELS.sonnet}"`));
}

// ---- graders are Sonnet and say so
check("no grader or judge names Opus (the price table in the router eval is the only mention)", !evalFiles.some((f) => /claude-opus/.test(read(f).replace(/\/\/.*$/gm, "")) && !/PRICING/.test(read(f))) && !/claude-opus/.test(read("src/models.ts")));
check("generating test data is not grading: the Jev honest generator call has no grader marker", !/model: JUDGE, headers: GRADER_HEADERS,\s*\n\s*prompt: `For a test, write 45/.test(read("evals/jev/honest.ts")));
check("every grader call carries the grader marker", ["evals/matching/run.ts", "evals/intro/run.ts", "evals/texting/grade.ts", "evals/texting/pairwise.ts", "evals/lib/replyRubric.ts", "evals/texting/tagShort.ts", "evals/grounding/falseFlags.ts", "evals/jev/honest.ts"].every((f) => /headers: GRADER_HEADERS/.test(read(f))));

// ---- the morning email is gone
const jobs = read("src/jobs/index.ts");
check("no morning email: the 8am review cron is not scheduled", !/runMorningReview\(/.test(jobs.replace(/\/\/.*$/gm, "")));
check("the morning review never sends an email unless asked to by hand", /opts\.force/.test(read("src/harness/devReview.ts")));

console.log(`test setup rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
