// Open threads: a check-in may carry Cue's own take on what they were stuck on, once per problem, never chasing an unanswered one
// (Royce, 2026-11-09). Layer 1: synthetic member, the draft model stubbed through its own seam, no database, no network.
//   npx tsx evals/followThrough/threadTake.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const CC = await import("../../src/agent/companionCheckin.js");
const P = await import("../../src/harness/proactive.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };

const thread = { text: "deciding whether to move to Austin for the new role", quote: "I can't decide if Austin is worth leaving my whole crew here for. What would you weigh?", dueDate: null, feeling: "torn" };
const prompts: string[] = [];
const draft = async (answer: string, t: typeof thread & { lastSaid?: string | null } = thread) => {
  P.setProactiveModelForTests(async (p) => { prompts.push(p); return answer; });
  try { return await CC.draftCompanionCheckin("Ellis", "", t); } finally { P.setProactiveModelForTests(null); }
};

// ---------------------------------------------------------------- 1. the task: a take in place of the question, when they wanted one
{
  const t = CC.THREAD_TAKE_TASK;
  check("works out what they were weighing and whether they wanted help", /what they were actually weighing or stuck on, if anything, and whether they wanted help with it/.test(t));
  check("a grounded take or a step that's theirs may replace the question; a take is enough", /give your own grounded take or one next step that's theirs to take, in place of the question\. A take is enough on its own\./.test(t));
  check("tentative, theirs to correct, from their words; no deeper problem; no solution pushed on venting", /theirs to correct/.test(t) && /never name a deeper problem they didn't express/.test(t) && /never push a solution on something they were only getting off their chest/.test(t));
}

// ---------------------------------------------------------------- 2. a worthwhile later contribution on a thread goes through its checks
{
  const take = "On Austin, I'd weigh how often you'd realistically see your crew against what the role opens up in two years. If the answer to the second is a lot, a standing monthly trip back keeps the first.";
  const r = await draft(take);
  check("the take comes back whole", r?.text === take, r);
  const bad = r ? P.checkDraft(r.text, r.rules).filter((c) => !c.pass) : ["no draft"];
  check("and passes the check-in draft checks (no question required, within the take's room)", bad.length === 0, bad);
  check("the draft offers nothing to go to: no events, links or people", /Offer nothing to go to or look at: no events, no links, no people\./.test(prompts.at(-1)!));
}

// ---------------------------------------------------------------- 3. once per problem, no chasing
{
  check("no earlier check-in on the thread: it may go", CC.threadChase(null, false).ok);
  check("an earlier check-in with nothing of theirs since: not chased", !CC.threadChase({ sentAt: new Date() }, false).ok);
  check("they've texted or called since (new information): it may go again", CC.threadChase({ sentAt: new Date() }, true).ok);
  check("since-read failed: held, never assumed fine", !CC.threadChase({ sentAt: new Date() }, null).ok);
  await draft("SKIP", { ...thread, lastSaid: "On Austin, I'd weigh how often you'd see your crew." });
  const p = prompts.at(-1)!;
  check("the last check-in's words ride as a fact, with the rule never to repeat them", /what_you_last_said_about_it/.test(p) && p.includes(CC.THREAD_NO_REPEAT));
  const reg = src("harness/proactiveRegistry.ts");
  check("the registry reads the last check-in on the thread (both queue keys) and anything of theirs after it", /companion:thread:\$\{threadId\}:%/.test(reg) && /companion:reflection:\$\{threadId\}:%/.test(reg) && /memory_type = 'call_transcript' OR \(memory_type = 'text_exchange' AND content LIKE 'User said:%'/.test(reg));
  check("a chase skip is code's (never a mood wait or the fallback line)", /return skip\(`not chased: \$\{chase\.why\}`\)/.test(reg));
}

// ---------------------------------------------------------------- 4. a find that can't be checked isn't offered
{
  // Only an item already checked against its own page may ride (the cron's thread item); with none, the draft may carry no link.
  const r = await draft("On Austin, this might help: https://example.com/austin-founders");
  const bad = r ? P.checkDraft(r.text, r.rules).filter((c) => !c.pass).map((c) => c.name) : [];
  check("a thread check-in with no checked item can't carry a link to something unverified", bad.includes("draft_no_url"), bad);
  // Known gap, not code-guarded: a named room or person with no link in a thread check-in relies on the task ("no events, no links,
  // no people") and the send-time read. Said in the PR.
}

console.log(`thread take: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
