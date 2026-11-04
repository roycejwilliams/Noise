// Older logs without member text (2026-10-18, Royce's yes; forget by default): the document and brief rows in harness_decisions and
// the brief's close notes hold the rule and the kind of thing only, never a title, a quote or the member's words. The brief's note is
// read back to Cue (coTasks.ts briefFactLines), so it keeps its meaning: no brief, and why, as kinds. Zero tokens, no DB.
//   npx tsx evals/tasks/olderLogs.ts
import fs from "node:fs";
const S = await import("../../src/services/documentSheet.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

// An invented document whose lines carry things they never said: two times, a name with a time, a name, a day.
const TITLE = "Rooftop dinner for the Halcyon launch";
const doc = S.resolveDocument({
  title: TITLE,
  sections: [
    { heading: "The night", bullets: ["Doors open at 7pm", "Dinner for Priya's investors starts at 8:30pm", "Lena Okafor hosts the toast"] },
    { heading: "Before", paragraphs: ["Confirm the florist and the string quartet with Marguerite before Thursday so the terrace looks right."] },
  ],
});
const theirs = "I want a rooftop dinner for our launch, investors coming, terrace would be nice";
const problems = S.documentProblems(doc, { theirs });
// Every word of the document a log could carry (title, headings, bullets, paragraphs), four letters or more, minus what the kinds say.
const KIND_WORDS = new Set(["name", "number", "time", "their", "words", "unbacked", "line", "placeholder", "document", "shape", "research", "sourcing", "other", "check", "opening", "word", "reason", "given", "brief", "sent", "venue"]);
const docWords = [...new Set(S.docText(doc).concat(" ", TITLE).toLowerCase().match(/[a-z][a-z']{3,}/g) ?? [])].filter((w) => !KIND_WORDS.has(w.replace(/'s$/, "")));
const carries = (s: string) => docWords.filter((w) => new RegExp(`\\b${w.replace(/'/g, "['’]")}\\b`, "i").test(s));

check("setup: the real checks refuse this document, quoting its lines", problems.length >= 3 && problems.some((p) => /Halcyon|Priya|Okafor|Marguerite|7pm/.test(p)), problems);

// Source: the rows and notes in the functions this fixed carry no title, problem text or words.
const lt = src("agent/loopTools.ts");
const rb = src("services/researchBrief.ts");
const writeDoc = lt.slice(lt.indexOf("writeDocument: tool({"), lt.indexOf("readDocument: tool({"));
const runBrief = rb.slice(rb.indexOf("export async function runResearchBriefTask"));
const calls = (body: string, fn: string) => [...body.matchAll(new RegExp(`\\b${fn}\\(([\\s\\S]*?)\\)(?:\\.catch\\([^\\n]*?\\))?;\\s*\\n`, "g"))].map((m) => m[1]);
const docRows = calls(writeDoc, "recordDecision");
check("writeDocument: its one row says \"document sent\" and the kind, never the title", docRows.length === 1 && /action: "document sent"/.test(docRows[0]) && /kind: doc\.kind/.test(docRows[0]) && !/title|theirWords|input\./.test(docRows[0]), docRows);
const briefRows = calls(runBrief, "recordDecision");
const briefRow = briefRows.find((r) => /decision: "task\.researchBrief"/.test(r)) ?? "";
check("brief: its row says the venue finds were texted, never the title", /action: "venue finds texted"/.test(briefRow), briefRows);
check("brief: no row in the task carries a title or their words", briefRows.length >= 1 && briefRows.every((r) => !/title|theirWords|p\.what|problems/.test(r)), briefRows);
const closes = calls(runBrief, "closeTask");
const tells = calls(runBrief, "tellThenClose");
check("brief: no close note carries a title", closes.length >= 1 && closes.every((n) => !/\.title|theirWords|p\.what/.test(n)), closes);
check("brief: no told-then-closed note carries a title or the problems' text", tells.length >= 3 && tells.every((n) => !/\.title|problems\.(slice|join)|theirWords|p\.what/.test(n)) && !/problems\.slice\(0, 3\)\.join/.test(runBrief), tells);

console.log(`older logs: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
