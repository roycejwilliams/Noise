// Model-free checks for Co's own multi-day tasks (services/coTasks.ts, taskTurn.ts).
//
//   npx tsx evals/tasks/rules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const T = await import("../../src/services/coTasks.js");
const G = await import("../../src/harness/replyGrounding.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const now = new Date("2026-09-30T18:00:00Z");
const H = 3_600_000;

// Their words
check("a task needs a real quote of theirs", T.wordsAreTheirs("find me a venue for 60 people", "Can you find me a venue for 60 people by Friday?") && !T.wordsAreTheirs("book a venue", "Can you find me a venue for 60 people?") && !T.wordsAreTheirs("ok", "ok sure"));

// When: Co picks, code bounds
check("Co's next check-in is kept between 1 hour and 14 days", T.clampNextHours(0) === 1 && T.clampNextHours(10_000) === 336 && T.clampNextHours(48) === 48 && T.clampNextHours("soon") === 24);

// Steps
const steps = T.cleanSteps(["Search venues in SF", { text: "Check capacity and price" }, "", 5, ...Array(12).fill("step")]);
check("steps are cleaned and capped", steps.length === T.TASK_LIMITS.maxSteps && steps[1].text === "Check capacity and price" && steps.every((s) => !s.done));

// Bounds on a task's life
check("a task ends after its wake-ups or its days", T.isExhausted({ wakes: 12, createdAt: now.toISOString() }, now) && T.isExhausted({ wakes: 1, createdAt: new Date(now.getTime() - 31 * 24 * H).toISOString() }, now) && !T.isExhausted({ wakes: 3, createdAt: new Date(now.getTime() - 2 * 24 * H).toISOString() }, now));

// Texting limits
check("one text per task per 20 hours", !T.mayText({ lastTextedAt: new Date(now.getTime() - 5 * H).toISOString() }, 0, now).ok && T.mayText({ lastTextedAt: new Date(now.getTime() - 21 * H).toISOString() }, 0, now).ok);
check("two task texts per member a day", !T.mayText({ lastTextedAt: null }, 2, now).ok && T.mayText({ lastTextedAt: null }, 1, now).ok);

// What Co reads
const task: any = { id: 7, userId: "u", goal: "venue for the Oct 10 block party", theirWords: "can you find me a venue for 60 people", steps: [{ text: "search venues", done: true }, { text: "check prices", done: false }], planNext: "read the two venue pages", nextCheckAt: "2026-10-01T17:00:00.000Z", status: "open", wakes: 1, notes: [{ at: now.toISOString(), text: "Found two venues in SoMa." }], textsSent: 0, lastTextedAt: null, createdAt: now.toISOString() };
const line = T.taskFactLines([task, { ...task, id: 8, status: "done" }]).join("\n");
check("open tasks become one fact each, with what's done, what's next and when", /task #7/.test(line) && !/task #8/.test(line) && /Done: search venues/.test(line) && /Still to do: check prices/.test(line) && /next around 2026-10-01 17:00 UTC: read the two venue pages/.test(line));

// Promises backed by a task are kept
const rf = G.baseReplyFacts();
G.addFact(rf, "scheduled", line);
check("a follow-up promise is not cut when Co has an open task", /const tasked = rf\.facts\.some/.test(src("harness/replyGrounding.ts")) && /if \(found && !tasked &&/.test(src("harness/replyGrounding.ts")));

// Wiring
const tt = src("services/taskTurn.ts");
check("a wake-up must end with Co's decision, or it looks again in a day", /stopWhen: \[stepCountIs\(8\), \(\) => decided !== null\]/.test(tt) && /if \(!decided\) await scheduleTask\(userId, task\.id, 24/.test(tt));
check("a task text is drafted only from what the task found, and checked", /draftProactive\(/.test(tt) && /checkDraft\(text/.test(tt) && /mayText\(task, await taskTextsToday\(userId\)/.test(tt));
check("a task text only sends links the task actually found", /const known = \(links \?\? \[\]\)\.filter\(\(l\) => found\.some/.test(tt));
check("a task text goes out only inside their hours, never held in memory", /if \(!localHourOk\(new Date\(\), zone\)\) return/.test(tt) && /respectHours: true/.test(tt) && !/sendExemptWhenAllowed\(/.test(tt));
check("web results are kept only when their page really reads", /reserveWebSearch\(userId, "sweep", what\)/.test(tt) && /r\.status !== "ok"/.test(tt));
check("opted-out or archived members' tasks are dropped", /sms_opted_out \|\| person\.archived_at/.test(tt));
check("due tasks are claimed so two runs never work one", /FOR UPDATE SKIP LOCKED/.test(src("services/coTasks.ts")) && /\*\/15 \* \* \* \*/.test(src("jobs/index.ts")));
check("the tools are Co's, guarded like every other ability", ["startTask", "updateTask", "closeTask"].every((t) => new RegExp(`tool: "${t}"`).test(src("services/capabilities.ts")) && new RegExp(`${t}: tool\\(`).test(src("agent/conversationTools.ts"))));
check("replies read open tasks as scheduled facts", /openTasks\(userId\)\.then\(\(t\) => taskFactLines\(t\)\)/.test(src("services/turnContext.ts")) && /opts\.turn\?\.tasks \?\? \[\]\) addFact\(rf, "scheduled"/.test(src("harness/replyGrounding.ts")));

console.log(`task rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
