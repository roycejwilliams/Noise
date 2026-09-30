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
check("a wake-up must end with Co's decision, or it looks again in a day", /stopWhen: \[stepCountIs\(12\), \(\) => decided !== null\]/.test(tt) && /if \(!decided\) await deps\.schedule\(24,/.test(tt));
check("a task text is drafted only from verified facts, and checked", /draftProactive\(/.test(tt) && /checkDraft\(text/.test(tt) && /mayText\(task, await deps\.textsToday\(\)/.test(tt));
check("a task text only sends links from results that passed", /const known = \(links \?\? \[\]\)\.filter\(linkOk\)/.test(tt));
check("a task text goes out only inside their hours, never held in memory", /if \(!localHourOk\(deps\.now\(\), deps\.zone\)\) return/.test(tt) && /respectHours: true/.test(tt) && !/sendExemptWhenAllowed\(/.test(tt));
check("web searches reserve the shared budget and keep only results that prove themselves (evals/tasks/web.ts)", /reserveWebSearch\(userId, opts\.source \?\? "sweep", what\)/.test(src("services/taskWeb.ts")) && /web: \(what\) => taskWebSearch\(/.test(tt));
check("opted-out or archived members' tasks are dropped", /sms_opted_out \|\| person\.archived_at/.test(tt));
check("due tasks are claimed so two runs never work one", /FOR UPDATE SKIP LOCKED/.test(src("services/coTasks.ts")) && /\*\/15 \* \* \* \*/.test(src("jobs/index.ts")));
check("the tools are Co's, guarded like every other ability", ["startTask", "updateTask", "closeTask"].every((t) => new RegExp(`tool: "${t}"`).test(src("services/capabilities.ts")) && new RegExp(`${t}: tool\\(`).test(src("agent/conversationTools.ts"))));
check("replies read open tasks as scheduled facts", /openTasks\(userId\)\.then\(\(t\) => taskFactLines\(t\)\)/.test(src("services/turnContext.ts")) && /opts\.turn\?\.tasks \?\? \[\]\) addFact\(rf, "scheduled"/.test(src("harness/replyGrounding.ts")));

check("at most 3 web searches per wake-up", /filter\(\(d\) => d\.startsWith\("web:"\)\)\.length >= 3/.test(tt));

// Deadlines and waking on their reply (2026-09-30)
{
  const now = new Date("2026-09-30T18:00:00Z"); // Wed 11am in San Francisco
  const words = "I need a couple of options by Friday.";
  const d = T.planDeadline({ date: "2026-10-02", words: "by Friday" }, words, "America/Los_Angeles", now);
  check("a deadline in their words is kept, with the last check at 10am their time that day", d.ok && d.deadline === "2026-10-02" && d.finalCheckAt === "2026-10-02T17:00:00.000Z", JSON.stringify(d));
  check("a deadline not in their words is refused", !T.planDeadline({ date: "2026-10-02", words: "by Thursday" }, words, "America/Los_Angeles", now).ok);
  check("a past or far-off deadline is refused", !T.planDeadline({ date: "2026-09-28", words: "by Friday" }, words, "America/Los_Angeles", now).ok && !T.planDeadline({ date: "2027-01-02", words: "by Friday" }, words, "America/Los_Angeles", now).ok);
  const today = T.planDeadline({ date: "2026-09-30", words: "by Friday" }, words, "America/Los_Angeles", now);
  check("a deadline of today, already past 10am, gets its last check an hour from now", today.ok && today.finalCheckAt === new Date(now.getTime() + 3_600_000).toISOString());
  const f = { finalCheckAt: "2026-10-02T17:00:00.000Z", finalTold: false };
  check("no check-in is scheduled past the last one before the deadline", T.capToFinal(new Date("2026-10-05T17:00:00Z"), f).capped && T.capToFinal(new Date("2026-10-05T17:00:00Z"), f).at.toISOString() === f.finalCheckAt && !T.capToFinal(new Date("2026-10-01T17:00:00Z"), f).capped && !T.capToFinal(new Date("2026-10-05T17:00:00Z"), { ...f, finalTold: true }).capped);
  check("the last check is recognized, and only once", T.isFinalCheck(f, new Date("2026-10-02T17:00:00Z")) && !T.isFinalCheck(f, new Date("2026-10-01T17:00:00Z")) && !T.isFinalCheck({ ...f, finalTold: true }, new Date("2026-10-02T17:00:00Z")));
  check("the last check may always tell them, even within 20 hours of the last text", T.mayText({ lastTextedAt: "2026-10-02T15:00:00Z", ...f }, 5, new Date("2026-10-02T17:00:00Z")).ok);
  check("after they reply, Co may text again within 20 hours; without a reply it may not", T.mayText({ lastTextedAt: "2026-09-30T16:00:00Z", theirReplyAt: "2026-09-30T17:00:00Z" }, 1, now).ok && !T.mayText({ lastTextedAt: "2026-09-30T16:00:00Z", theirReplyAt: "2026-09-30T15:00:00Z" }, 1, now).ok);
  check("a task ends two days after its deadline was told", T.isExhausted({ wakes: 1, createdAt: now.toISOString(), finalCheckAt: "2026-09-27T17:00:00Z", finalTold: true }, now) && !T.isExhausted({ wakes: 1, createdAt: now.toISOString(), finalCheckAt: "2026-09-27T17:00:00Z", finalTold: false }, now));
}
check("their text wakes a task that texted them, and runs it once their reply is out", /const woke = await T\.wakeOnReply\(user\.id\)/.test(src("routes/sendblue.ts")) && /awaiting_reply = true/.test(src("services/coTasks.ts")));
check("the last check never goes quiet: if Co didn't tell them, code does", /if \(final && !texts\.length\) \{/.test(tt) && /if \(final && texts\.length\) await deps\.markFinalTold\(\)/.test(tt));
check("a deadline is checked against their words before it's kept", /T\.planDeadline\(\{ date: given\.date, words: given\.theirWords \}/.test(src("agent/conversationTools.ts")));

{
  const now = new Date("2026-09-30T18:00:00Z");
  check("a deadline in their words is found when Co leaves it off", JSON.stringify(T.deadlineFromWords("I need a couple of options by Friday.", "America/Los_Angeles", now)) === JSON.stringify({ date: "2026-10-02", words: "by Friday" }));
  check("an event's own date is never read as a deadline", T.deadlineFromWords("a caterer for my Oct 10 party", "America/Los_Angeles", now) === null);
  check("other deadline wordings work", T.deadlineFromWords("before next Tuesday", "America/Los_Angeles", now)?.date === "2026-10-06" && T.deadlineFromWords("no later than Oct 5", "America/Los_Angeles", now)?.date === "2026-10-05");
}
check("a draft that breaks a rule is redrafted once in code", /const again = await draftAgain\(/.test(tt) && /stepCountIs\(12\)/.test(tt));

console.log(`task rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
