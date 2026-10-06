// Call -> task bridge (services/callTasks.ts). Layer 1: fake model, fake store, zero tokens.
//   npx tsx evals/calls/callTasks.ts
// Replays last night's call: he asked "I would love for you to guide me ... throw different memos or resources or links". Co said "not how I work".
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const T = await import("../../src/services/callTasks.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const ASK = "So I would love for you to, like, kind of guide me, you know, just kind of throughout the week, just throw, like, different memos or different, you know, encouraging words that I, I may, you know, need, or ideas or resources or links that could be helpful for me";
const TRANSCRIPT = `assistant: Hey Royce, it's Co. Any movement on the November event partnership?
user: Uh, not yet. We're just waiting and seeing, and coding different features this week.
assistant: What kind of VC are you looking for?
user: Yeah, definitely, uh, pre-seed. Um, we're definitely a pre-seed company. ${ASK}
assistant: I hear that. The daily check-ins and resource drops, that's not really how I work.
user: Uh, I mean, I see it actually acquired.`;

const mk = (give: any[], o: { done?: boolean; startOk?: boolean } = {}) => {
  const calls: any[] = []; const recorded: string[] = []; let prompt = "";
  const deps: any = {
    read: async (p: string) => { prompt = p; return give; },
    start: async (i: any) => { calls.push(i); return o.startOk === false ? { ok: false, why: "already working on that" } : { ok: true, task: { id: calls.length } }; },
    alreadyDone: async () => !!o.done,
    record: async (_u: string, _k: string, c: string) => { recorded.push(c); },
  };
  return { deps, calls, recorded, prompt: () => prompt };
};

{
  const m = mk([{ goal: "Send pre-seed fundraising resources, ideas and links through the week", quote: "different memos or different, you know, encouraging words that I, I may, you know, need, or ideas or resources or links" }]);
  const got = await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check("replay: what he asked for on the call becomes a task, with his own words as the quote", got.length === 1 && m.calls.length === 1 && /memos or different/.test(m.calls[0].theirWords) && m.calls[0].userId === "u1" && m.calls[0].source === "ask");
  check("the task opens like a text's would: no steps, a first plan that texts only when there's something real", Array.isArray(m.calls[0].steps) && m.calls[0].steps.length === 0 && /text them only when you have something real/.test(m.calls[0].firstPlan));
  check("the after-call text is told it started, with no promise of what or when", m.recorded.length === 1 && /^Started working on "Send pre-seed/.test(m.recorded[0]) && /no promise of what or when/.test(m.recorded[0]));
  check("the model reads only HIS lines: Co's 'not how I work' never reaches it", !/not really how I work/.test(m.prompt()) && /guide me/.test(m.prompt()));
}
{
  const m = mk([{ goal: "Send a weekly investor memo", quote: "I will send you a weekly investor memo every Monday" }]);
  const got = await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check("a quote that isn't in his words opens nothing (the model invented it)", got.length === 0 && m.calls.length === 0 && m.recorded.length === 0);
}
{
  const m = mk([{ goal: "Look into the daily check-ins and resource drops", quote: "The daily check-ins and resource drops, that's not really how I work" }]);
  const got = await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check("a quote from Co's own line opens nothing: only what the member asked", got.length === 0 && m.calls.length === 0);
}
{
  const many = ["one", "two", "three", "four"].map((n) => ({ goal: `Work on thing ${n} for them`, quote: "kind of guide me, you know, just kind of throughout the week" }));
  const m = mk(many);
  await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check(`at most ${T.MAX_TASKS_PER_CALL} tasks from one call`, m.calls.length === T.MAX_TASKS_PER_CALL);
}
{
  const m = mk([{ goal: "x", quote: "kind of guide me, you know, just kind of throughout the week" }, { goal: "Resources through the week", quote: "" }]);
  await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check("a goal too thin to work on, or an empty quote, is skipped", m.calls.length === 0);
}
{
  const m = mk([{ goal: "Send resources and links through the week", quote: "kind of guide me, you know, just kind of throughout the week" }], { done: true });
  const got = await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check("once per call: a retried delivery opens nothing and doesn't even read the transcript again", got.length === 0 && m.calls.length === 0 && m.prompt() === "");
}
{
  const m = mk([{ goal: "Send resources and links through the week", quote: "kind of guide me, you know, just kind of throughout the week" }], { startOk: false });
  const got = await T.tasksFromCall("u1", TRANSCRIPT, m.deps);
  check("a task that couldn't start (limit, or already on it) is not reported as started", got.length === 0 && m.recorded.length === 0);
}
{
  const m = mk([]);
  const got = await T.tasksFromCall("u1", "assistant: Hey.\nuser: Good, you?\nassistant: Great, talk soon.", m.deps);
  check("a short call with nothing asked of Co reads nothing and opens nothing", got.length === 0 && m.calls.length === 0 && m.prompt() === "");
  const none = mk([]);
  check("a call where they asked for nothing like that opens nothing", (await T.tasksFromCall("u1", TRANSCRIPT, none.deps)).length === 0 && none.calls.length === 0);
}
{
  const deps: any = { read: async () => { throw new Error("model down"); }, start: async () => { throw new Error("no"); }, alreadyDone: async () => false, record: async () => {} };
  const orig = console.error; console.error = () => {};
  const got = await T.tasksFromCall("u1", TRANSCRIPT, deps);
  console.error = orig;
  check("a failure never throws into the call's post-processing", Array.isArray(got) && got.length === 0);
}

// ---- wiring
const co = src("routes/co.ts"), ct = src("services/callTasks.ts");
check("the post-call step runs it, alongside the audit, never awaited", /tasksFromCall\(user_id, cleanTranscript\)\)\.catch\(\(\) => \{\}\)/.test(co));
check("it uses the same task machinery as a text (so every limit holds), Sonnet to read, and keeps the transcript out of traces", /startTask\b/.test(ct) && /MODELS\.sonnet/.test(ct) && /recordInputs: false, recordOutputs: false/.test(ct));
check("the after-call text knows what to say when a task started, without a day or a promise", /If it says Co started working on something they asked for, say in a few plain words that you're on it/.test(src("jobs/postCallFollowUp.ts")));
check("the call brain is told yes: it'll set it up when they hang up", /Right after you hang up, Co sets up what they asked for as a task/.test(src("services/callBriefing.ts")) && /say yes, that you'll set it up when you hang up/.test(src("services/elevenLabsCalls.ts")));
console.log(`call tasks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
