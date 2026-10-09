// A corrected goal that's since done is history, never their current goal (Royce, 2026-10-09). Zero tokens.
// The proof on his record: after "partnering with Sequin AI for a November launch party" was marked done, calls and nudges still
// read 'goal, Oct 6: partnering with Sequin AI for a November launch party (not "...")' as current, from the corrections history.
//   npx tsx evals/member/doneGoalCorrections.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const { goalHash } = await import("../../src/services/goalEdges.js");
const { correctionRows } = await import("../../src/services/callContext.js");
const { memberDraftBlock } = await import("../../src/harness/proactive.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const DONE = "partnering with Sequin AI for a November launch party";
const ACTIVE = "pivoting to a partnership with Sequin AI after canceling the October launch date";
const corr = (now: string | null, field = "goal") => ({ field, was: "shifting focus to a November event partnership with House of AI", now, verifiedAt: "2026-10-06T18:00:00Z" });

// 1. The pure rule.
{
  const goals = [{ text: DONE, state: "done" as const }, { text: ACTIVE, state: "active" as const }, { text: "attend Tech Week this weekend", state: "stale" as const }];
  const [d] = MK.settleGoalCorrections([corr(DONE)], goals);
  check("a corrected goal that's since done says so", d.now === `(${MK.SETTLED_GOAL.done}) ${DONE}`, d);
  check("the old value stays corrected (the correction isn't dropped)", d.was === corr(DONE).was);
  const [s] = MK.settleGoalCorrections([corr("attend Tech Week this weekend")], goals);
  check("one set aside since says that", s.now?.startsWith(`(${MK.SETTLED_GOAL.stale})`) === true, s);
  const [a] = MK.settleGoalCorrections([corr(ACTIVE)], goals);
  check("a corrected goal that's still active is left alone", a.now === ACTIVE);
  const [w] = MK.settleGoalCorrections([corr("Partnering with Sequin AI for a November launch party ")], goals);
  check("the same goal in other case or spacing still matches", w.now?.includes(MK.SETTLED_GOAL.done) === true, w);
  const [both] = MK.settleGoalCorrections([corr(DONE)], [...goals, { text: DONE.toUpperCase(), state: "active" as const }]);
  check("if an active goal says the same thing, it's left alone (never hides a current goal)", both.now === DONE, both);
  const [city] = MK.settleGoalCorrections([corr(DONE, "city")], goals);
  check("only goal corrections are touched", city.now === DONE);
  const [none] = MK.settleGoalCorrections([corr(null)], goals);
  check("a correction that removed the value is left alone", none.now === null);
  const [other] = MK.settleGoalCorrections([corr("get into an accelerator")], goals);
  check("a goal that matches nothing on file is left alone", other.now === "get into an accelerator");
}

// 2. Through the shared layer, and into the call and nudge renderers.
{
  const deps: Partial<import("../../src/services/memberKnowledge.js").KnowledgeDeps> = {
    profile: async () => ({ firstName: "Royce", city: "Sacramento", goals: [DONE, ACTIVE], intent: [], updatedAt: new Date("2026-10-08T00:00:00Z") }),
    zone: async () => "America/Los_Angeles",
    linkedNames: async () => [],
    goalStates: async () => [{ goalHash: goalHash(DONE), goal: DONE, state: "done", reason: "they said it's done", source: "member", changedAt: new Date("2026-10-09T18:00:00Z"), toldAt: new Date("2026-10-09T18:00:00Z"), hints: 0 }],
    corrections: async () => [{ field: "goal", old_value: corr(DONE).was, new_value: DONE, corrected_at: "2026-10-06T18:00:00Z" }],
  };
  const onlyCorrections = await MK.memberKnowledge("u1", { include: ["corrections"] }, deps);
  check("settled even when a path reads corrections without goals (after-call, deliveries)", onlyCorrections.corrections[0]?.now?.includes(MK.SETTLED_GOAL.done) === true, onlyCorrections.corrections);
  const k = await MK.memberKnowledge("u1", { include: ["goals", "corrections"] }, deps);
  const rows = correctionRows(k);
  check("calls: the correction row carries it", rows[0]?.new_value?.includes(MK.SETTLED_GOAL.done) === true, rows);
  const block = memberDraftBlock(k, MK.memberRules(k));
  const line = block.split("\n").find((l) => /They corrected/.test(l)) ?? "";
  check("nudges: the corrections line says the goal is done, even capped", line.includes(MK.SETTLED_GOAL.done), line);
  check("nudges: the done goal isn't in where they're headed", !(block.split("\n").find((l) => /headed/.test(l)) ?? "").includes(DONE));
}

console.log(`done-goal corrections: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
