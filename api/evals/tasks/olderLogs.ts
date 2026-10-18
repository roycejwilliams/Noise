// Older logs without member text (2026-10-18, Royce's yes; forget by default): the document and brief rows in harness_decisions and
// the brief's close notes hold the rule and the kind of thing only, never a title, a quote or the member's words. The brief's note is
// read back to Cue (coTasks.ts briefFactLines), so it keeps its meaning: no brief, and why, as kinds. Zero tokens, no DB.
//   npx tsx evals/tasks/olderLogs.ts
import fs from "node:fs";
const S = await import("../../src/services/documentSheet.js");
const R = await import("../../src/services/researchBrief.js");
const CT = await import("../../src/services/coTasks.js");
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
const kinds = R.problemKinds(problems);
check(`the refusal note names kinds and counts ("${kinds}")`, /\(\d+\)/.test(kinds) && /not in their words/.test(kinds), kinds);
check("the refusal note carries none of the document's words or title", carries(kinds).length === 0 && !kinds.includes(TITLE), { kinds, hits: carries(kinds) });
check("the refusal note has no quote and no number from the document", !/["“”]/.test(kinds) && !/7pm|8:30|Thursday/i.test(kinds), kinds);
check("counts add up to every problem, not just the first three", [...kinds.matchAll(/\((\d+)\)/g)].reduce((n, m) => n + Number(m[1]), 0) === problems.length, { kinds, n: problems.length });

// Each kind from the checkers' own wording.
const one = (p: string) => R.problemKinds([p]);
check("kind: times they never gave", one(`"Doors at 7pm, close at 11pm" isn't something they said: it has 7pm, 11pm, which they never gave. Leave that out`) === "unbacked time (1)", one(`"x" isn't something they said: it has 7pm, 11pm, which they never gave.`));
check("kind: two unbacked times read as \"unbacked time (2)\"", R.problemKinds([`"Doors at 7pm" names 7pm, which they never said`, `"Close at 11pm" names 11pm, which they never said`]) === "unbacked time (2)");
check("kind: a number", one(`"A budget of $4,000" isn't something they said: it has 4000, which they never gave.`) === "unbacked number (1)");
check("kind: a name", one(`"Lena Okafor hosts" isn't something they said: it has okafor, which they never gave.`) === "name not in their words (1)");
check("kind: a name and a time", one(`"Priya at 8pm" names 8pm, Priya, which they never said`) === "name and number or time not in their words (1)");
check("kind: a judged line", one(`"The terrace seats sixty" isn't something they said (it adds a capacity): rewrite it from their own words, or move it to suggestions`) === "line not in their words (1)");
check("kind: a placeholder", one("it has a placeholder in it") === "placeholder (1)");
check("kind: the document's shape", one('a paragraph runs 120 words ("Confirm the florist..."): put its points in bullets') === "document shape (1)");
const brief = R.buildBrief({ title: "Venue options: rooftop dinner for Halcyon", asked: "rooftop dinner for Halcyon", finds: [{ name: "Spruce", url: "http://spruce.example", checkedAt: "", reader: "scripted", fields: [] }], memberContext: [] });
const rp = R.researchProblems(brief);
check("kind: research sourcing, from the real research check", rp.length > 0 && R.problemKinds(rp) === `research sourcing (${rp.length})` && !/Spruce|Halcyon/.test(R.problemKinds(rp)), { rp, k: R.problemKinds(rp) });
check("kind: anything else is \"other check\", and none is \"no reason given\"", one("something new went wrong with Halcyon") === "other check (1)" && R.problemKinds([]) === "no reason given");

// Read back to Cue: the line still says there was no brief and why, in kinds.
const [back] = CT.briefFactLines([{ id: 7, goal: "venues for a rooftop dinner", theirWords: "find me a rooftop for the launch", status: "done", createdAt: "2026-10-18T16:00:00Z", closedAt: "2026-10-18T17:00:00Z", outcome: `no brief: ${kinds}`, held: null }], "America/Los_Angeles");
check("read back: Cue's line keeps its meaning (finished, no brief, the kinds)", /finished/.test(back) && back.includes(`no brief: ${kinds}`), back);

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
check("brief: its row says whether the venue brief was sent, never the title", /action: sent \? "venue brief sent" : "venue brief not sent"/.test(briefRow), briefRows);
check("brief: no row in the task carries a title or their words", briefRows.length >= 2 && briefRows.every((r) => !/title|theirWords|p\.what|problems/.test(r)), briefRows);
const closes = calls(runBrief, "closeTask");
const tells = calls(runBrief, "tellThenClose").map((n) => n.replace(/^\s*briefOptionsText\([^)]*\),/, ""));
check("brief: no close note carries a title", closes.length >= 3 && closes.every((n) => !/\.title|theirWords|p\.what/.test(n)) && !/sent the brief "/.test(runBrief), closes);
check("brief: no told-then-closed note carries a title or the problems' text", tells.length >= 5 && tells.every((n) => !/\.title|problems\.(slice|join)|theirWords|p\.what/.test(n)) && !/problems\.slice\(0, 3\)\.join/.test(runBrief), tells);
check("brief: the refusal note goes through problemKinds", /tellThenClose\(line, "done", `no brief: \$\{problemKinds\(problems\)\}`\)/.test(runBrief));

console.log(`older logs: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
