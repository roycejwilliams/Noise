// Model-free checks for promise tracking (services/promises.ts and its hook in
// harness/replyGrounding.ts). No API calls, no database:
//   npx tsx evals/promises/rules.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { promiseSentence, promiseHours, promiseGoal, theirWordsFor, promiseFact } = await import("../../src/services/promises.js");
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

// ---- what counts as a promise (the two real ones from 2026-10-03, and the audited phrasings)
for (const t of [
  "Will do. I'll flag the second someone with real space turns up.",
  "On it. I'll come back the moment someone with real space surfaces.",
  "I'll flag you when it opens up.",
  "I'll dig into that and get back to you.",
  "I'll keep you posted.",
  "Let me circle back on that tomorrow.",
  "I'll text you when I hear back.",
  "I'll check back with you Thursday.",
]) {
  check(`a promise is found: ${t}`, promiseSentence(t) !== null);
}
// The old matcher missed the first two.
check("the old matcher missed the real ones; the widened one catches them", followupPromiseMatch("Will do. I'll flag the second someone with real space turns up.") !== null && followupPromiseMatch("On it. I'll come back the moment someone with real space surfaces.") !== null);
for (const t of [
  "I'll keep an eye out.",
  "I'll keep looking and text you if something real comes up.",
  "Want me to flag you when one turns up?",
  "Should I dig into that?",
  "I flagged it for the team yesterday.",
  "Sounds like a hard week.",
  "That's a good question.",
]) {
  check(`not a task-worthy promise: ${t}`, promiseSentence(t) === null);
}
check("only the promising sentence is kept", promiseSentence("That sounds great. I'll flag you when it opens up. Talk soon.") === "I'll flag you when it opens up.");

// ---- when to look again
check("an event-driven promise is checked every few hours", promiseHours("I'll flag the second someone turns up.") === 3);
check("tomorrow is about a day", promiseHours("I'll get back to you tomorrow.") === 20);
check("today is a few hours", promiseHours("I'll follow up later today.") === 4);
check("this week is two days", promiseHours("I'll check back on that this week.") === 48);
check("no time given is a day", promiseHours("I'll dig into that.") === 24);
check("never under the task minimum", promiseHours("I'll follow up within the hour.") >= TASK_LIMITS.minHours);

// ---- the task it becomes
check("the goal carries the promise in Co's own words", promiseGoal("I'll flag you when it opens up.").includes("I'll flag you when it opens up."));
check("the goal fits a task goal", promiseGoal("x".repeat(500)).length <= 200);
check("their words are their message, trimmed", theirWordsFor("  we need real space  for the party  ") === "we need real space for the party");
check("the fact the reply cites is a started task", /^Started task #7:/.test(promiseFact({ id: 7, goal: "g", nextCheckAt: "2026-10-06T10:00:00.000Z" } as any)));

// ---- backed or not
const bare = baseReplyFacts();
check("a promise with nothing behind it is unbacked", unbackedFollowup("I'll flag the second someone turns up.", bare) !== null);
const backed = baseReplyFacts();
addFact(backed, "did_this_turn", promiseFact({ id: 7, goal: "g", nextCheckAt: "2026-10-06T10:00:00.000Z" } as any));
check("with the task started this turn it is backed", unbackedFollowup("I'll flag the second someone turns up.", backed) === null);
const ongoing = baseReplyFacts();
addFact(ongoing, "ongoing", "Co's daily search is looking for: venue.");
check("keeping an eye out with an open ask is the sweep's (still backed)", unbackedFollowup("Nothing yet, I'll keep an eye out.", ongoing) === null);
check("keeping an eye out with nothing open is still unbacked", unbackedFollowup("Nothing yet, I'll keep an eye out.", bare) !== null);

// ---- wiring
const grounding = read("src/harness/replyGrounding.ts");
const tasks = read("src/services/coTasks.ts");
const migrations = read("src/db/migrations.ts");
check("tracking only runs on a real send with a member", /opts\.userId && opts\.record !== false && unbackedFollowup\(draft, rf\)/.test(grounding));
check("the task fact is added before the checks read the facts", grounding.indexOf('addFact(rf, "did_this_turn", promiseFact') > 0 && grounding.indexOf('addFact(rf, "did_this_turn", promiseFact') < grounding.indexOf("const first = await check(draft, rf, src);"));
check("a tracked or failed promise is logged for the review", /decision: "promise\.tracked"/.test(grounding));
check("a promise task is owned by Co", /owner: "co"/.test(read("src/services/promises.ts")) && /owner TEXT NOT NULL DEFAULT 'co'/.test(migrations) && /input\.owner \?\? "co"/.test(tasks));
check("the member's own id is the only one used", /userId: o\.userId/.test(read("src/services/promises.ts")));

console.log(`promise rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
