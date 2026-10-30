// How Co's texts read (Royce, 2026-09-24: "make Co's texts to members and
// Mo's texts to the team and prospects read like a real person texting:
// specific, short, and natural on a phone"). Blind Sonnet grading against the
// shared reply rubric (evals/lib/replyRubric.ts), plus the hard rules in code
// (evals/lib/hardRules.ts); the grader never sees which prompt wrote a reply.
//
// Cases are real co-test exchanges, kept local (cases.local.json, gitignored):
//   npx tsx evals/texting/grade.ts baseline          grades Co's actual replies
//   npx tsx evals/texting/grade.ts file <path>        grades a {id, reply}[] file
// Results go to evals/texting/results/*.local.json.
import { GRADER_HEADERS, GRADER_MODEL as GRADER } from "../../src/models.js";
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { parseModelJson } from "../../src/services/modelJson.js";
import { RUBRIC, completeGrade, rubricPrompt, type RubricKey } from "../lib/replyRubric.js";
import { hardRuleMisses, turnKind } from "../lib/hardRules.js";

export const GRADER_MODEL = GRADER; // was Opus; final grading is Sonnet (evals/README.md)

// The rubric is shared with the golden quality run (evals/lib/replyRubric.ts, 2026-10-29): moment-aware depth and questions (a share
// or feedback turn has no length cap and may ask questions that build on each other), contribute rather than mirror, check-ins as
// presence. The hard lines (invented facts, status talk, stock phrases, machinery, quoting itself) are code: evals/lib/hardRules.ts.
export const CRITERIA = Object.fromEntries(Object.entries(RUBRIC).map(([k, v]) => [k, v.text])) as Record<RubricKey, string>;
export type Criterion = RubricKey;
export type Verdict = "pass" | "fail" | "na";
export type Grade = Partial<Record<Criterion, Verdict>> & { notes: string };

// mode: the turn's moment read when the case carries one (generate.ts cases: "sharing", "feedback"...), so the rubric fits the turn.
export type TextCase = { person: string; at: string; message: string; recentConversation: string; contextSummary: string; reply: string; mode?: string };
type GradeInput = Pick<TextCase, "message" | "recentConversation"> & { contextSummary?: string; person?: string; mode?: string };
export const kindOf = (c: GradeInput) => turnKind(c.message, c.mode);

export function gradePrompt(c: GradeInput, reply: string): string {
  return rubricPrompt({ kind: kindOf(c), message: c.message, recent: c.recentConversation, known: c.contextSummary, firstName: c.person }, reply);
}

export async function grade(c: GradeInput, reply: string): Promise<Grade> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({ model: anthropic(GRADER_MODEL), headers: GRADER_HEADERS, prompt: gradePrompt(c, reply) });
      const g = parseModelJson<Grade>(text);
      if (completeGrade(g, kindOf(c))) return g;
    } catch {}
  }
  throw new Error("grader failed twice");
}

// The hard rules for one texting reply (code, free): what the case gave is its context, conversation and message.
export function hardMisses(c: GradeInput, reply: string): string[] {
  const theirs = c.recentConversation.split("\n").filter((l) => l.startsWith("User said:")).map((l) => l.slice(10).trim());
  const cue = c.recentConversation.split("\n").filter((l) => /^(Co|Cue) replied:/.test(l)).map((l) => l.replace(/^\w+ replied: ?/, ""));
  return hardRuleMisses({ text: reply, kind: kindOf(c), facts: c.contextSummary ?? "", theirLines: [c.message, ...theirs], coLines: cue, firstName: c.person });
}

// Pass rate per criterion (n/a left out of that criterion's count).
export function summarize(grades: Grade[]): Record<Criterion, { pass: number; of: number; rate: number }> {
  const out = {} as Record<Criterion, { pass: number; of: number; rate: number }>;
  for (const k of Object.keys(CRITERIA) as Criterion[]) {
    const rated = grades.filter((g) => g[k] === "pass" || g[k] === "fail");
    const pass = rated.filter((g) => g[k] === "pass").length;
    out[k] = { pass, of: rated.length, rate: rated.length ? pass / rated.length : 1 };
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = new URL(".", import.meta.url).pathname;
  const cases: TextCase[] = JSON.parse(readFileSync(`${here}cases.local.json`, "utf8")).cases;
  const [mode, path] = process.argv.slice(2);
  const replies: { id: number; reply: string }[] =
    mode === "file" ? JSON.parse(readFileSync(path, "utf8")) : cases.map((c, id) => ({ id, reply: c.reply }));
  const grades = await pool(replies, 6, async (r) => ({ id: r.id, ...(await grade(cases[r.id], r.reply)), hard: hardMisses(cases[r.id], r.reply) }));
  const s = summarize(grades);
  const hard = grades.filter((g) => g.hard.length);
  const words = replies.map((r) => r.reply.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  console.log(`graded ${grades.length} replies (${mode === "file" ? path.split("/").pop() : "baseline: Cue's actual replies"})`);
  for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(24)} ${String(Math.round(v.rate * 100)).padStart(3)}%  (${v.pass}/${v.of})`);
  const all = Object.values(s);
  console.log(`  ${"hard rules (code)".padEnd(24)} ${String(Math.round(((grades.length - hard.length) / Math.max(1, grades.length)) * 100)).padStart(3)}%  (${grades.length - hard.length}/${grades.length} with no hard-rule miss)`);
  for (const g of hard) console.log(`    #${g.id}: ${g.hard.join("; ")}`);
  console.log(`  ${"overall".padEnd(24)} ${String(Math.round((all.reduce((a, v) => a + v.pass, 0) / all.reduce((a, v) => a + v.of, 0)) * 100)).padStart(3)}%   median ${words[Math.floor(words.length / 2)]} words`);
  mkdirSync(`${here}results`, { recursive: true });
  const out = `${here}results/${mode === "file" ? path.split("/").pop()!.replace(/\.local\.json$/, "") : "baseline"}-graded-${new Date().toISOString().replace(/[:.]/g, "-")}.local.json`;
  writeFileSync(out, JSON.stringify({ summary: s, grades }, null, 2));
  process.exit(0);
}
