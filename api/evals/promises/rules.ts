// Model-free checks for promise tracking (services/promises.ts and its hook in
// harness/replyGrounding.ts). No API calls, no database:
//   npx tsx evals/promises/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { promiseSentence, promiseHours, promiseGoal, theirWordsFor, promiseFact, promiseStays, trackPromise, MAX_OPEN_PROMISES, atPromiseCap } = await import("../../src/services/promises.js");
const { followupPromiseMatch, unbackedFollowup, baseReplyFacts, addFact } = await import("../../src/harness/replyGrounding.js");
const { TASK_LIMITS } = await import("../../src/services/coTasks.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

// ---- what a task can keep
for (const t of [
  "I'll flag you when it opens up.",
  "I'll dig into that and get back to you.",
  "I'll keep you posted.",
  "I'll text you when I hear back.",
  "I'll check back with you Thursday.",
  "I'll circle back on that tomorrow.",
  "Sounds good. I'll follow up on Friday.",
]) {
  check(`a promise a task can keep: ${t}`, promiseSentence(t) !== null);
}
// Not tracked (review of #67): they stay as the existing checks treat them.
for (const [t, why] of [
  ["I'll flag the second someone with real space turns up.", "instant"],
  ["I'll come back the moment someone with real space surfaces.", "instant"],
  ["I'll text you as soon as it opens.", "instant"],
  ["I'll keep an eye out.", "watching"],
  ["I'll keep looking and text you if something real comes up.", "watching"],
  ["Want me to flag you when one turns up?", "offer"],
  ["Should I dig into that?", "offer"],
  ["I'll flag you when it opens up, okay?", "question"],
  ["Will you send it over?", "question"],
  ["When will you check in?", "question"],
  ["Jordan will reach out tomorrow.", "someone else"],
  ["Luma will send you a confirmation.", "someone else"],
  ["Let me check on that.", "this turn"],
  ["Let me dig into that for you.", "this turn"],
  ["I will text you the details now.", "this turn"],
  ["I'll dig into sponsors for the event.", "can't do"],
  ["I'll reach out to the venue for you.", "can't do"],
  ["I'll email the investors tomorrow.", "can't do"],
  ["I flagged it for the team yesterday.", "past"],
  ["That's a good question.", "nothing"],
] as const) {
  check(`not tracked (${why}): ${t}`, promiseSentence(t) === null);
}
check("only the promising sentence is kept", promiseSentence("That sounds great. I'll flag you when it opens up. Talk soon.") === "I'll flag you when it opens up.");
// The old matcher missed two real ones (2026-10-03); the widened matcher flags them, so the existing timing rule still cuts them.
check("the instant ones are still caught by the follow-up check", followupPromiseMatch("Will do. I'll flag the second someone with real space turns up.") !== null && followupPromiseMatch("On it. I'll come back the moment someone with real space surfaces.") !== null);

// ---- when to look again
const wed = new Date("2026-10-07T18:00:00Z"); // Wednesday 11am Pacific
check("tomorrow is about a day", promiseHours("I'll get back to you tomorrow.", wed) === 20);
check("today is a few hours", promiseHours("I'll follow up later today.", wed) === 4);
check("this week is two days", promiseHours("I'll check back on that this week.", wed) === 48);
check("no time given is a day", promiseHours("I'll dig into that.", wed) === 24);
check("never under the task minimum", promiseHours("I'll follow up within the hour.", wed) >= TASK_LIMITS.minHours);
check("a named weekday waits until that morning, not a day", (() => { const h = promiseHours("I'll check back Friday.", wed); return h > 40 && h < 50; })());
check("a weekday that is today means next week's", promiseHours("I'll check back Wednesday.", wed) > 150);

// ---- the task it becomes
check("the goal carries the promise in Co's own words", promiseGoal("I'll flag you when it opens up.").includes("I'll flag you when it opens up."));
check("the goal fits a task goal", promiseGoal("x".repeat(500)).length <= 200);
check("their words are their message, trimmed", theirWordsFor("  we need real space  for the party  ") === "we need real space for the party");
check("the fact the reply cites is a started task", /^Started task #7:/.test(promiseFact({ id: 7, goal: "g", nextCheckAt: "2026-10-06T10:00:00.000Z" } as any)));

// ---- it never outlives a promise that wasn't made
check("a promise cut from the final text takes its task with it", promiseStays("I'll flag you when it opens up.") && !promiseStays("Nothing yet on that one.") && !promiseStays("That one's theirs to tell, not mine."));
{
  const base = { userId: "u1", theirMessage: "we need a space" };
  const r1: any = await trackPromise({ ...base, reply: "I'll flag you when it opens up.", discreet: true });
  check("not on a turn that kept a confidence", r1.ok === false && /confidence/.test(r1.why));
  const r2: any = await trackPromise({ ...base, reply: "I'll let you know when Sarah Hao replies.", privateNames: ["Sarah Hao"] });
  check("not when the sentence names the member a block is about", r2.ok === false && /names a member/.test(r2.why));
  const r3: any = await trackPromise({ ...base, reply: "Sounds good." });
  check("not when there is no promise a task can keep", r3.ok === false);
}

check("two open promises is the cap; work they asked for does not count against it", atPromiseCap([{ source: "promise" }, { source: "promise" }]) && !atPromiseCap([{ source: "promise" }, { source: "ask" }, { source: "ask" }, { source: "ask" }]));

// ---- backed or not
const bare = baseReplyFacts();
check("a promise with nothing behind it is unbacked", unbackedFollowup("I'll flag you when it opens up.", bare) !== null);
const backed = baseReplyFacts();
addFact(backed, "did_this_turn", promiseFact({ id: 7, goal: "g", nextCheckAt: "2026-10-06T10:00:00.000Z" } as any));
check("with the task started this turn it is backed", unbackedFollowup("I'll flag you when it opens up.", backed) === null);
check("an instant promise is still cut even with a task behind another thing", unbackedFollowup("I'll flag the second someone turns up.", bare) !== null);
const ongoing = baseReplyFacts();
addFact(ongoing, "ongoing", "Co's daily search is looking for: venue.");
check("keeping an eye out with an open ask is the sweep's (still backed)", unbackedFollowup("Nothing yet, I'll keep an eye out.", ongoing) === null);
check("keeping an eye out with nothing open is still unbacked", unbackedFollowup("Nothing yet, I'll keep an eye out.", bare) !== null);

// ---- wiring
const grounding = read("src/harness/replyGrounding.ts");
const tasks = read("src/services/coTasks.ts");
const migrations = read("src/db/migrations.ts");
const taskTurn = read("src/services/taskTurn.ts");
check("tracking only runs on a real send with a member", /opts\.userId && opts\.record !== false && unbackedFollowup\(draft, rf\)/.test(grounding));
check("it is told when the turn kept a confidence and who the block is about", /privateNames: rf\.privateNames, discreet: isDiscreetTurn\(rf\.instructions\)/.test(grounding));
check("the task is dropped when the final text lacks the promise", /!promiseStays\(result\.final\)/.test(grounding) && /dropPromise\(opts\.userId, promiseTaskId\)/.test(grounding));
check("a tracked or failed promise is logged for the review", /decision: "promise\.tracked"/.test(grounding) && /decision: "promise\.dropped"/.test(grounding));
check("a promise task is marked as one, and capped", /source: "promise"/.test(read("src/services/promises.ts")) && /source TEXT NOT NULL DEFAULT 'ask'/.test(migrations) && /input\.source \?\? "ask"/.test(tasks) && MAX_OPEN_PROMISES === 2);
check("when it wakes, it is told it is following through on its own promise", /following through on something you told/.test(taskTurn));

console.log(`promise rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
