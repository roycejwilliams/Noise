// A Tier 2 offer over the length limit is redrafted once, told by how much,
// before it can be lost (2026-10-08: seven dropped 10-04..10-06 at 359 to 507
// chars, max 300). The model is a fake (setProactiveModelForTests): zero tokens.
//   npx tsx evals/events/revealLength.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const D = await import("../../src/agent/eventDiscoverySurfacing.js");
const P = await import("../../src/harness/proactive.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};

const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const match = { tier: 2, kind: "public_event", source: "luma", name: "Founders Supper Club", url: "https://lu.ma/founders-supper", event_date: future, reason: "a dinner for early founders", whyItFits: "a small dinner with other early founders" } as any;
const LONG = "Founders Supper Club is a small seated dinner for early founders in the city, hosted by a group of operators who have built and sold companies, with long tables, a set menu and a short talk on hiring the first ten people, and it is the kind of founder dinner you asked for, with room to meet a few people properly over the course of the evening.";
const SHORT = "Founders Supper Club is a small seated dinner for early founders, the kind of founder dinner you asked for.";

async function run(answers: string[]) {
  const prompts: string[] = [];
  let i = 0;
  P.setProactiveModelForTests(async (prompt) => {
    prompts.push(prompt);
    return answers[Math.min(i++, answers.length - 1)];
  });
  try {
    const r = await D.draftEventReveal({ firstName: "Jordan" }, "founder dinners", false, match);
    return { r, prompts };
  } finally {
    P.setProactiveModelForTests(null);
  }
}

check("the limit is 300 and Cue is told it up front", D.REVEAL_MAX_CHARS === 300 && /Keep it under 260 characters/.test(D.REVEAL_LENGTH));
check("LONG is over the limit (the case being tested)", LONG.length > D.REVEAL_MAX_CHARS);

{
  const { r, prompts } = await run([LONG, SHORT]);
  check("an over-long draft is redrafted once", prompts.length === 2, `${prompts.length} model calls`);
  check("the redraft is told what broke and by how much", /It broke: draft_length: \d+ chars \(max 300\)/.test(prompts[1] ?? "") && prompts[1].includes(LONG));
  check("the first prompt carries the length guidance", (prompts[0] ?? "").includes(D.REVEAL_LENGTH));
  check("the shorter draft is what goes out", r?.text === SHORT, r?.text);
  check("the link is its own message and not counted", r?.messages[0] === match.url && r?.messages[1] === SHORT && !r.text.includes("lu.ma"));
  check("and it passes the dispatch's draft checks", !!r && P.checkDraft(r.text, r.rules).filter((c) => !c.pass).length === 0, JSON.stringify(r && P.checkDraft(r.text, r.rules).filter((c) => !c.pass)));
}

{
  const { r, prompts } = await run([SHORT]);
  check("a draft within the limit is not redrafted", prompts.length === 1 && r?.text === SHORT);
}

{
  const { r, prompts } = await run([LONG, "SKIP"]);
  check("a redraft that skips keeps the first draft (the dispatch's own retry still applies)", prompts.length === 2 && r?.text === LONG);
}

{
  const { r, prompts } = await run(["SKIP"]);
  check("Cue's SKIP is still final", prompts.length === 1 && r === null);
}

console.log(`event reveal length: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
