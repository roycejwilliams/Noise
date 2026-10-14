// How Co's texts read (Royce, 2026-09-24: "make Co's texts to members and
// Mo's texts to the team and prospects read like a real person texting:
// specific, short, and natural on a phone"). Blind Opus grading against the
// seven criteria below; the grader never sees which prompt wrote a reply.
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

export const GRADER_MODEL = GRADER; // was Opus; final grading is Sonnet (evals/README.md)

export const CRITERIA = {
  specific: "Specific to this person and this conversation, not a line that could be sent to anyone.",
  length_fit:
    "Matches the length of what they sent: a short or casual message gets 1-2 sentences, unless they asked for depth (a plan, advice, detail, a walkthrough), in which case longer is right.",
  one_idea_per_paragraph: "Each paragraph carries one idea; no wall of text mixing several.",
  one_question: "At most one question, and never re-asks a question Cue already asked that they skipped or moved past.",
  no_restating_opener: 'Does not open by restating what they said back to them ("That [noun phrase]...", "So you\'re...", "Sounds like you...").',
  real_position:
    "When giving advice or an opinion, takes a real position (picks one, says why) instead of hedging or listing options. Mark n/a if the reply gives no advice or opinion.",
  honest: "Honest about what Cue does and doesn't know or do: no invented facts, no promises of work it won't do, no pretending.",
} as const;
export type Criterion = keyof typeof CRITERIA;
export type Verdict = "pass" | "fail" | "na";
export type Grade = Record<Criterion, Verdict> & { notes: string };

export type TextCase = { person: string; at: string; message: string; recentConversation: string; contextSummary: string; reply: string };

export function gradePrompt(c: Pick<TextCase, "message" | "recentConversation"> & { contextSummary?: string }, reply: string): string {
  return `You're grading one text message from Cue, an AI companion that texts members of a private club over iMessage. Grade only the reply below, against each criterion. Be strict and consistent; a pass should read like a thoughtful real person texting on a phone.

What Cue knew about them before this reply (from earlier texts and calls; a fact from here is not invented):
${(c.contextSummary ?? "").slice(0, 2500) || "(nothing)"}

The conversation so far (oldest first):
${c.recentConversation.slice(-3000) || "(none)"}

What they just sent:
"${c.message}"

Cue's reply:
"${reply}"

Criteria:
${Object.entries(CRITERIA).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Return ONLY JSON: {${Object.keys(CRITERIA).map((k) => `"${k}": "pass"|"fail"${k === "real_position" ? '|"na"' : ""}`).join(", ")}, "notes": "one short sentence on the biggest problem, or empty"}`;
}

export async function grade(c: Pick<TextCase, "message" | "recentConversation"> & { contextSummary?: string }, reply: string): Promise<Grade> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({ model: anthropic(GRADER_MODEL), headers: GRADER_HEADERS, prompt: gradePrompt(c, reply) });
      const g = parseModelJson<Grade>(text);
      if (Object.keys(CRITERIA).every((k) => ["pass", "fail", "na"].includes((g as any)[k]))) return g;
    } catch {}
  }
  throw new Error("grader failed twice");
}

// Pass rate per criterion (n/a left out of that criterion's count).
export function summarize(grades: Grade[]): Record<Criterion, { pass: number; of: number; rate: number }> {
  const out = {} as Record<Criterion, { pass: number; of: number; rate: number }>;
  for (const k of Object.keys(CRITERIA) as Criterion[]) {
    const rated = grades.filter((g) => g[k] !== "na");
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
  const grades = await pool(replies, 6, async (r) => ({ id: r.id, ...(await grade(cases[r.id], r.reply)) }));
  const s = summarize(grades);
  const words = replies.map((r) => r.reply.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  console.log(`graded ${grades.length} replies (${mode === "file" ? path.split("/").pop() : "baseline: Cue's actual replies"})`);
  for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(24)} ${String(Math.round(v.rate * 100)).padStart(3)}%  (${v.pass}/${v.of})`);
  const all = Object.values(s);
  console.log(`  ${"overall".padEnd(24)} ${String(Math.round((all.reduce((a, v) => a + v.pass, 0) / all.reduce((a, v) => a + v.of, 0)) * 100)).padStart(3)}%   median ${words[Math.floor(words.length / 2)]} words`);
  mkdirSync(`${here}results`, { recursive: true });
  const out = `${here}results/${mode === "file" ? path.split("/").pop()!.replace(/\.local\.json$/, "") : "baseline"}-graded-${new Date().toISOString().replace(/[:.]/g, "-")}.local.json`;
  writeFileSync(out, JSON.stringify({ summary: s, grades }, null, 2));
  process.exit(0);
}
