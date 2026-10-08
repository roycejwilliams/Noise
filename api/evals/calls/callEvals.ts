// Call grading by ElevenLabs (services/callEvals.ts), the two free guardrails, and the voice regression suite's definitions
// (services/callTests.ts, scripts/agentTests.ts). Layer 1: no model, no network.   npx tsx evals/calls/callEvals.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const V = await import("../../src/services/callEvals.js");
const T = await import("../../src/services/callTests.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

// ---- criteria and settings
const ids = V.CALL_CRITERIA.map((c) => c.id);
check("ten criteria, unique ids, inside ElevenLabs' limit of 30", V.CALL_CRITERIA.length === 10 && new Set(ids).size === ids.length && ids.length <= 30);
check("they cover the real failures: invented specifics, false refusals, impossible promises, known questions, long replies, unsaid attribution, names/voice", ["no_invented_specifics", "no_false_refusals", "no_impossible_promises", "no_known_questions", "short_spoken_replies", "no_unsaid_attribution", "names_and_voice"].every((i) => ids.includes(i)));
check("each is written so SUCCESS is the good outcome, with a failure case named", V.CALL_CRITERIA.every((c) => /^.*Success if/.test(c.conversation_goal_prompt) && /Failure if/.test(c.conversation_goal_prompt)));
check("the refusal criterion names what Co CAN do (so a real 'I can't' is caught) and the promise criterion what it CANNOT", /Co CAN:[^]*multi-day work/.test(V.CALL_CRITERIA.find((c) => c.id === "no_false_refusals")!.conversation_goal_prompt) && /Co CANNOT:[^]*investors, sponsors or funders/.test(V.CALL_CRITERIA.find((c) => c.id === "no_impossible_promises")!.conversation_goal_prompt));
const ps = V.CALL_PLATFORM_SETTINGS as any;
check("guardrails: Focus and Manipulation (prompt injection) on, nothing blocking: no Content or Custom guardrail, so no added wait", ps.guardrails.focus.is_enabled === true && ps.guardrails.prompt_injection.is_enabled === true && !("content" in ps.guardrails) && !("custom" in ps.guardrails));
check("grading is Sonnet: post-call, nobody waits", ps.analysis_llm === "claude-sonnet-4-6");
const cfg: any = E.buildAgentConfig({ name: "Co", prompt: "p", voiceId: "v", apiUrl: "https://x.test" });
check("the agent config carries the criteria and guardrails, and keeps the per-call first-message override", cfg.platform_settings.evaluation.criteria.length === 10 && cfg.platform_settings.guardrails.focus.is_enabled === true && cfg.platform_settings.overrides.conversation_config_override.agent.first_message === true);

// ---- reading the grade
const analysis = { evaluation_criteria_results: { no_invented_specifics: { criteria_id: "no_invented_specifics", result: "failure", rationale: "Co called tomorrow's event 'tonight'." }, no_false_refusals: { criteria_id: "no_false_refusals", result: "success", rationale: "ok" }, short_spoken_replies: { criteria_id: "short_spoken_replies", result: "unknown", rationale: "" } } };
const f = V.failedCriteria(analysis);
check("only real failures count ('unknown' is not a failure), with the criterion's name and the reason", f.length === 1 && f[0].id === "no_invented_specifics" && /Haunted|tomorrow's event/.test(f[0].rationale) && /invented/i.test(f[0].name));
check("the list form works too", V.failedCriteria({ evaluation_criteria_results_list: [{ criteria_id: "no_known_questions", result: "failure", rationale: "asked weekends" }] }).length === 1);
{
  const seen: any[] = [];
  const rec = async (d: any) => { seen.push(d); };
  const n = await V.recordCallEvaluation("u1", "conv_1", analysis, rec as any);
  check("a failed call is recorded for the morning review: layer 8, call.evaluation, outcome skip, the failures as failed checks with their reasons", n === 1 && seen.length === 1 && seen[0].layer === 8 && seen[0].decision === "call.evaluation" && seen[0].outcome === "skip" && seen[0].checks[0].pass === false && /tonight/.test(seen[0].checks[0].reason) && /1 call criteria failed/.test(seen[0].reason));
  const ok: any[] = [];
  await V.recordCallEvaluation("u1", "conv_2", { evaluation_criteria_results: { no_false_refusals: { criteria_id: "no_false_refusals", result: "success", rationale: "" } } }, (async (d: any) => { ok.push(d); }) as any);
  check("a call that passed everything is recorded as passed", ok.length === 1 && ok[0].outcome === "act" && ok[0].action === "all_passed");
  const none: any[] = [];
  const z = await V.recordCallEvaluation("u1", "conv_3", { transcript_summary: "x" }, (async (d: any) => { none.push(d); }) as any);
  check("a call with no grade (criteria not set yet) records nothing", z === 0 && none.length === 0 && (await V.recordCallEvaluation("u1", "c", undefined, (async (d: any) => { none.push(d); }) as any)) === 0 && none.length === 0);
  const orig = console.error; console.error = () => {};
  const r = await V.recordCallEvaluation("u1", "conv_4", analysis, (async () => { throw new Error("db down"); }) as any);
  console.error = orig;
  check("a failure to record never throws into the call's processing", r === 0);
}
check("the post-call webhook records the grade, never awaited, with the call and what Co was given for the re-check", /recordCallEvaluation\(userId, conversationId, data\.analysis, undefined, gradeContext\)\)\.catch\(\(\) => \{\}\)/.test(src("routes/co.ts")) && /const gradeContext = \{ transcript: transcriptFromTurns\(/.test(src("routes/co.ts")));

// ---- the voice regression suite
const names = T.CALL_TESTS.map((t) => t.name);
check("eight tests, unique names, one per way the first call went wrong plus safety and the cross-member rule", T.CALL_TESTS.length === 8 && new Set(names).size === 8 && /safe/.test(names.join()) && /other members/.test(names.join()) && /tomorrow, not tonight/.test(names.join()) && /memos/.test(names.join()));
check("every test ends on the member's line, so Co's next words are what is graded", T.CALL_TESTS.every((t) => t.history[t.history.length - 1].role === "user"));
check("every condition says exactly when to PASS or FAIL, and has a good and a bad example", T.CALL_TESTS.every((t) => /(PASS|FAIL)/.test(t.success) && t.good.length > 10 && t.bad.length > 10));
check("the member is fictional (Jordan, Sam), never a real person", !/Royce|Jacqueline/.test(src("services/callTests.ts")));
const b: any = T.testBody(T.CALL_TESTS[0]);
check("a test's body is a next-reply test with the call's variables, so the prompt renders as on a call", b.type === "llm" && b.success_examples[0].type === "success" && b.failure_examples[0].type === "failure" && ["first_name", "context_summary", "right_now", "finds_now"].every((k) => k in b.dynamic_variables));
check("the tomorrow test hands Co tomorrow's event and the clock", /starts tomorrow, Tuesday, October 6 at 6:30 PM/.test(String(T.testBody(T.CALL_TESTS.find((t) => /tomorrow/.test(t.name))!).dynamic_variables && (T.testBody(T.CALL_TESTS.find((t) => /tomorrow/.test(t.name))!) as any).dynamic_variables.finds_now)) && /9:48 PM on Monday, October 5/.test(b.dynamic_variables.right_now));
const sc = src("scripts/agentTests.ts");
check("the runner tests the live agent or the candidate config this code builds (no push), with the webhook tools stripped so a tool call can't stand in for a reply", /--candidate/.test(sc) && /t\.type !== "webhook"/.test(sc) && /buildAgentConfig\(/.test(sc));
check("it exits 1 when any test fails, and a deliberately bad prompt can be swapped in to prove the tests can fail", /process\.exit\(failed \? 1 : 0\)/.test(sc) && /CALL_TEST_PROMPT_REPLACE/.test(sc));

{
  // #113: a source failure is judged again with the call context; correct recall is overturned, a real invention stays failed.
  const fail = (id: string) => ({ evaluation_criteria_results: { [id]: { criteria_id: id, result: "failure", rationale: "Co said three people in the studio, not on the call." } } });
  const ctx = (result: "success" | "failure") => ({ transcript: "assistant: Slow with three of you in the studio?\nuser: yeah", given: "runs a small studio (3 people)", records: async () => "", judge: (async () => [{ id: "no_invented_specifics", result, rationale: "r" }]) as any });
  const seen: any[] = [];
  const n1 = await V.recordCallEvaluation("u1", "conv_ctx1", fail("no_invented_specifics"), (async (d: any) => { seen.push(d); }) as any, ctx("success"));
  check("a source failure the context backs is overturned (correct recall passes)", n1 === 0 && seen[0]?.outcome === "act" && /the call context/.test(JSON.stringify(seen[0]?.checks)));
  const n2 = await V.recordCallEvaluation("u1", "conv_ctx2", fail("no_invented_specifics"), (async () => {}) as any, ctx("failure"));
  check("a source failure the context doesn't back still counts", n2 === 1);
  let judged = 0;
  await V.recordCallEvaluation("u1", "conv_ctx3", fail("no_false_refusals"), (async () => {}) as any, { ...ctx("success"), judge: (async () => { judged++; return []; }) as any });
  check("other criteria are never re-judged", judged === 0);
}

console.log(`call grading and voice tests: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
