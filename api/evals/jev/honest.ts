// An honest test of Jev in Co (Royce, 2026-09-23: "Don't carry
// biases, give an honest test").
//
// PRE-REGISTERED before running (thresholds and code are frozen; nothing is
// tuned after seeing these results):
//   Co  (real member texts from co-test, Jev only through the zero-retention
//        gateway): Jev+Haiku PASSES if, on every one of the three checks, its
//        accuracy is not lower than Haiku alone (a loss of >=1 item that is
//        significant at p<0.05 fails; a gain only counts as real if p<0.05),
//        AND its median time per text is not slower than Haiku alone.
//   (The outreach agent's two parts were removed with it on 2026-10-14;
//   branch archive/mo-backup-2026-10-14 has them.)
// Labels come from Claude Opus, blind (it never sees Jev's or Haiku's answer),
// and are written to disk before either model runs. Opus is the same family
// as Haiku, which may favour Haiku; every case where Jev and Haiku disagree is
// written out for a person to judge.
//
//   railway run --service co-test --environment dev -- env HONEST_DIR=<dir> npx tsx evals/jev/honest.ts
import { GRADER_HEADERS, GRADER_MODEL as GRADER } from "../../src/models.js";
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { detectSeekingMode } from "../../src/services/emotionalTone.js";
import { classifyIssue } from "../../src/services/issueReports.js";
import { readTextEmotion } from "../../src/harness/emotion.js";
import { readTextSignals } from "../../src/services/jevGateway.js";
import { parseModelJson } from "../../src/services/modelJson.js";

const DIR = process.env.HONEST_DIR!;
const JUDGE = anthropic(GRADER); // was Opus; final grading is Sonnet (evals/README.md)
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

// ---------------------------------------------------------------- stats
function wilson(k: number, n: number): string {
  if (!n) return "n/a";
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${Math.round(100 * p)}% (95% range ${Math.round(100 * (c - h))}–${Math.round(100 * (c + h))}%)`;
}
function binomTwoSided(b: number, c: number): number {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c); let p = 0;
  const choose = (n: number, r: number) => { let x = 1; for (let i = 1; i <= r; i++) x = (x * (n - r + i)) / i; return x; };
  for (let i = 0; i <= k; i++) p += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * p);
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const p90 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)] ?? 0; };

// ---------------------------------------------------------------- Co
type Txt = { id: string; content: string; convo: string | null };
type CoLabel = { solving: boolean; issue: boolean; feeling: boolean };

async function labelCo(t: Txt): Promise<CoLabel | null> {
  const msg = t.content.replace(/^User said:\s*/, "");
  const { text } = await generateText({
    model: JUDGE, headers: GRADER_HEADERS,
    prompt: `You're labelling one text a member sent to Co, an AI texting companion, for a test. Read it with the conversation before it.

Conversation before it, oldest first:
${(t.convo ?? "").split("\n").reverse().join("\n") || "(none)"}

Latest message: "${msg}"

Answer three separate questions:
1. solving: Right now, do they clearly want a real answer or help deciding something, not just to be listened to? True when they're weighing options out loud, stuck on a decision, or asking what to do (even without a question mark). False for ordinary sharing, updates, venting, reactions, logistics, or asking Co to find, look up or do something.
2. issue: Does the latest message report a problem with Co itself (something Co did wrong or badly: repeated itself, wrong or made-up info, broken or missing link, ignored them, too slow, confusing) or say how Co should work differently? False when the problem is in their own life, they're asking Co for something, or they're pushing back on a normal answer.
3. feeling: Does the latest message carry a real feeling Co should respond to (stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use the conversation: "fine" after bad news isn't fine. False for plain logistics, greetings, short acknowledgments, or tone you can't be confident about.

Return ONLY JSON: {"solving": true|false, "issue": true|false, "feeling": true|false}`,
  });
  const p = parseModelJson<Partial<CoLabel>>(text);
  return typeof p.solving === "boolean" && typeof p.issue === "boolean" && typeof p.feeling === "boolean" ? (p as CoLabel) : null;
}

async function runCoArm(texts: Txt[], jev: boolean) {
  process.env.JEV_MEMBER = jev ? "on" : "off";
  const res: Record<string, { solving: boolean; issue: boolean; feeling: boolean; ms: number; jevP?: unknown }> = {};
  for (const t of texts) {
    const msg = t.content.replace(/^User said:\s*/, "");
    const convo = (t.convo ?? "").split("\n").reverse().join("\n");
    const t0 = Date.now();
    const [s, i, f] = await Promise.all([
      detectSeekingMode(msg, convo, "eval.honest.seeking").then((m) => m === "solving"),
      classifyIssue(msg, convo).then((r) => r !== null).catch(() => false),
      readTextEmotion(msg, convo, "eval.honest.emotion").then((e) => e !== null),
    ]);
    const ms = Date.now() - t0;
    res[t.id] = { solving: s, issue: i, feeling: f, ms, ...(jev ? { jevP: await readTextSignals(msg, convo) } : {}) };
  }
  return res;
}

async function partCo() {
  const texts: Txt[] = JSON.parse(readFileSync(`${DIR}/realtexts.json`, "utf8"));
  const lf = `${DIR}/co_labels.json`;
  let labels: Record<string, CoLabel> = existsSync(lf) ? JSON.parse(readFileSync(lf, "utf8")) : {};
  if (!Object.keys(labels).length) {
    for (const t of texts) { const l = await labelCo(t); if (l) labels[t.id] = l; }
    writeFileSync(lf, JSON.stringify(labels, null, 1)); // frozen before either arm runs
  }
  const used = texts.filter((t) => labels[t.id]);
  const haiku = await runCoArm(used, false);
  const jev = await runCoArm(used, true);
  writeFileSync(`${DIR}/co_results.json`, JSON.stringify({ haiku, jev }, null, 1));
  say(`\n=== CO: ${used.length} real member texts, labels by Claude Opus (blind) ===`);
  say(`Label counts: wants real help ${used.filter((t) => labels[t.id].solving).length}, problem with Co ${used.filter((t) => labels[t.id].issue).length}, real feeling ${used.filter((t) => labels[t.id].feeling).length}`);
  let pass = true;
  const disagreements: string[] = [];
  for (const k of ["solving", "issue", "feeling"] as const) {
    let hr = 0, jr = 0, b = 0, c = 0;
    for (const t of used) {
      const L = labels[t.id][k], H = haiku[t.id][k] === L, J = jev[t.id][k] === L;
      if (H) hr++; if (J) jr++;
      if (H && !J) b++; if (!H && J) c++;
      if (haiku[t.id][k] !== jev[t.id][k]) disagreements.push(`[${k}] "${t.content.replace(/^User said:\s*/, "").slice(0, 140)}" | Opus=${L} Haiku=${haiku[t.id][k]} Jev+Haiku=${jev[t.id][k]} | Jev p=${JSON.stringify((jev[t.id].jevP as any)?.[k] ?? null)}`);
    }
    const p = binomTwoSided(b, c);
    const verdict = jr < hr && p < 0.05 ? "WORSE (significant)" : jr > hr && p < 0.05 ? "BETTER (significant)" : jr === hr ? "same" : jr > hr ? "slightly better, not significant" : "slightly worse, not significant";
    if (jr < hr && p < 0.05) pass = false;
    say(`${k.padEnd(8)} Haiku ${wilson(hr, used.length)} | Jev+Haiku ${wilson(jr, used.length)} | Jev-only-right ${c}, Haiku-only-right ${b}, p=${p.toFixed(3)} → ${verdict}`);
  }
  const hm = used.map((t) => haiku[t.id].ms), jm = used.map((t) => jev[t.id].ms);
  say(`Time per text: Haiku median ${median(hm)}ms (p90 ${p90(hm)}), Jev+Haiku median ${median(jm)}ms (p90 ${p90(jm)})`);
  const jevAnswered = used.filter((t) => jev[t.id].jevP).length;
  say(`Jev answered ${jevAnswered} of ${used.length} (the rest: busy/failed, Haiku decided)`);
  if (median(jm) > median(hm)) pass = false;
  say(`CO VERDICT: ${pass ? "PASS" : "FAIL"} against the pre-registered criteria`);
  writeFileSync(`${DIR}/co_disagreements.txt`, disagreements.join("\n"));
  say(`${disagreements.length} Jev-vs-Haiku disagreements written for a person to judge: ${DIR}/co_disagreements.txt`);
}

await partCo();
writeFileSync(`${DIR}/summary.txt`, out.join("\n"));
process.exit(0);
