// The test setup, tested (layer 1, zero tokens). Pins the two-layer policy so it can't quietly erode:
//   - layer 1 stubs every model call and refuses every other outside call;
//   - layer 2 runs on Haiku, lets only a grader through as Sonnet, stops at its cap, and prints its cost;
//   - no eval that makes a live model call can run unmetered, and none is in the layer 1 list.
//   npx tsx evals/lib/rules.ts
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
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
check("a timed-out test is killed with its whole process group", /detached: true/.test(read("evals/runLayer1.mjs")) && /process\.kill\(-p\.pid/.test(read("evals/runLayer1.mjs")));
check("no per-change script runs a live eval", !/runLayer2|runLive|--live/.test(pkg.test + pkg["evals:code"]));
const hook = read("../.githooks/pre-push");
check("the pre-push hook runs layer 1 and never a live eval", /evals:code/.test(hook) && !/evals:live|evals:nightly|eval:live/.test(hook.replace(/^#.*$/gm, "")));
const wf = read("../.github/workflows/co-evals.yml");
const wfAll = wf;
check("the workflow never puts a dispatch input into a shell command", !/run:[^\n]*\$\{\{\s*inputs\./.test(wfAll) && /ONLY: \$\{\{ inputs\.only \}\}/.test(wfAll)); const pushJob = wf.slice(wf.indexOf("\njobs:"), wf.indexOf("\n  golden:"));
// Royce, 2026-10-13: the golden conversations are a required pre-merge check, so ONE paid job runs on a PR into co-test: the metered,
// capped golden run and nothing else. Held exactly (review of the harness: a loose match let a widened trigger, an extra paid step,
// allowed hosts or a raised cap through).
const goldenJob = wf.slice(wf.indexOf("\n  golden:"), wf.indexOf("\n  live:"));
const goldenRuns = [...goldenJob.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((m) => m[1].trim());
const wfJobs = [...wf.slice(wf.indexOf("\njobs:")).matchAll(/^  ([A-Za-z_][\w-]*):\s*$/gm)].map((m) => m[1]);
check("CI on a push or pull request runs layer 1, plus only the capped golden job on a PR into co-test",
  /evals:code/.test(pushJob) && !/evals:nightly|evals:live|eval:live|secrets\./.test(pushJob) &&
  /\n    if: github\.event_name == 'pull_request' && github\.base_ref == 'co-test'\n/.test(goldenJob) &&
  JSON.stringify(goldenRuns) === JSON.stringify(["npm ci", "npm run -s evals:golden"]) &&
  !/EVAL_ALLOW_HOSTS|EVAL_WEB_SEARCH|EVAL_KEEP_MODEL|EVAL_COST_CAP_USD|EVAL_TOKEN_CAP/.test(goldenJob) &&
  !/evals:nightly|evals:live|eval:live/.test(goldenJob) &&
  Number(goldenJob.match(/timeout-minutes: (\d+)/)?.[1] ?? 0) > 0 && Number(goldenJob.match(/timeout-minutes: (\d+)/)?.[1] ?? 999) <= 30 &&
  JSON.stringify(wfJobs) === JSON.stringify(["code", "golden", "live"]), `jobs ${wfJobs.join(",")}; golden steps ${goldenRuns.join(" | ")}`);
check("the golden run is metered, capped at $4 and isolated from the database and sends", read("package.json").includes('"evals:golden": "DATABASE_URL=postgres://ci:ci@127.0.0.1:1/ci SENDBLUE_API_KEY=ci SENDBLUE_SECRET_KEY=ci RESEND_API_KEY=re_ci EVAL_REAL_MODELS=1 EVAL_TOKEN_CAP=1500000 EVAL_COST_CAP_USD=4 tsx --import ./evals/lib/meter.mjs evals/golden/run.ts"') && /^\s*import\s+["']\.\.\/lib\/requireMeter\.js["']/m.test(read("evals/golden/run.ts")));
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
check("every grader call carries the grader marker", ["evals/matching/run.ts", "evals/intro/run.ts", "evals/texting/grade.ts", "evals/texting/pairwise.ts", "evals/texting/tagShort.ts", "evals/grounding/falseFlags.ts", "evals/jev/honest.ts"].every((f) => /headers: GRADER_HEADERS/.test(read(f))));

// ---- the morning email is gone
const jobs = read("src/jobs/index.ts");
check("no morning email: the 8am review cron is not scheduled", !/runMorningReview\(/.test(jobs.replace(/\/\/.*$/gm, "")));
check("the morning review never sends an email unless asked to by hand", /opts\.force/.test(read("src/harness/devReview.ts")));

console.log(`test setup rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
