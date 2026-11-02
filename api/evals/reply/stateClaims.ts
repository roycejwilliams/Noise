// Where things stand, and what Cue did, are claims (2026-11-02, a founder's thread on dev, replayed with invented names and paraphrased
// texts): the member had given someone a trial login, and Cue said "right now you've got him testing it hands on". That went out with
// no claim read at all (nothing in it was claim-shaped), and on a later turn the claim read let "he's seeing it work firsthand" stand
// on "I gave him a trial login". Here:
//   1. a reply saying where something stands, or what someone else is doing, gets the claim read;
//   2. the claim read is told a stage must match its source (offered, planned, set up, under way and done are different);
//   3. what the read finds unsupported is cut; an action Cue says it took ("passed both to the team", "started on it") stands only on a
//      receipt from a tool that did it this turn.
// Layer 1: zero tokens, no database. The model is a fake fetch. Which stage the real read assigns is the model's judgment and is
// unverified until a paid run; what's checked here is that the read is asked, what it's told, and what code does with its answer.
//   npx tsx evals/reply/stateClaims.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

let claims: unknown[] = [];
const prompts: string[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const raw = String(init?.body ?? "");
  let text = "{}";
  if (/You check a text message Cue is about to send/.test(raw)) {
    prompts.push(JSON.parse(raw).messages?.map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("\n"))).join("\n") ?? raw);
    text = JSON.stringify({ claims });
  } else if (/Does this line assert anything that happened/.test(raw)) text = JSON.stringify({ onlyAdmission: false });
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const G = await import("../../src/harness/replyGrounding.js");
const { feedbackReceipt } = await import("../../src/agent/conversationTools.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) {
    failed++;
    process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`);
  }
};
const quietLog = console.log;
const quietErr = console.error;
const muted = async <T>(f: () => Promise<T>): Promise<T> => {
  console.log = () => {};
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.log = quietLog;
    console.error = quietErr;
  }
};

const RECENT = [
  "User said: Coffee with Theo went well. He's curious about my repo but I'm not sure yet.\n\nHe had two notes: the voice replies feel slow, and the intro call feels a lot like a rival app's",
  "Co replied: Hesitating on the repo is fair.",
  "User said: I set him up with a trial login so he can poke at it himself",
  "Co replied: Smart move.",
  "User said: ok sum up my issue",
].join("\n");
const src = { message: "ok sum up my issue", recentConversation: RECENT };

// ------------------------------------------------------------------ 1. a status sentence gets the read
{
  const BEFORE = "Matching works and that's your leverage. Settle roles and equity before code access, and right now you've got him trying it on his own without the repo, which is the right move.";
  check("the 11-02 shape of reply is claim-shaped now", G.needsClaimCheck(BEFORE));
  check("…only because of where-it-stands words: without them it still isn't (so this is the line that went out unread)", !G.needsClaimCheck("Matching works and that's your leverage. Settle roles and equity before code access."));
  for (const t of ["So far she's only seen the demo.", "He's already signed it.", "She hasn't replied yet.", "As it stands, the venue is holding the date.", "You've got her reviewing the deck."]) check(`read: "${t}"`, G.needsClaimCheck(t));
  for (const t of ["That sounds like a lot to carry.", "Settle roles before anything moves.", "Take the time you need on it."]) check(`not read, as before: "${t}"`, !G.needsClaimCheck(t));
}

// ------------------------------------------------------------------ 2. the read is told stages differ
{
  prompts.length = 0;
  claims = [];
  await muted(() => G.claimChecksOnly("Right now you've got him trying it on his own.", G.createReplyFacts(), src));
  const p = prompts[0] ?? "";
  check("the claim read ran", prompts.length === 1);
  check("its rules say a stage must match its source, with an access-given example", /A claim about where something stands must match the stage its source gives: offered, planned, set up \(access given, an account made, an intro sent\), under way, and done are different/.test(p) && /"I gave her a login" never backs "she's trying it" or "she's seen it work"/.test(p), p.slice(0, 400));
  check("the member's words it would judge against are in front of it", p.includes("I set him up with a trial login so he can poke at it himself"));
}

// ------------------------------------------------------------------ 3. what code does with the read's answer
{
  const DRAFT = "Matching works and that's your leverage. Right now you've got him trying it on his own.";
  const run = async (c: unknown[], rf = G.createReplyFacts(), draft = DRAFT) => {
    claims = c;
    return muted(() => G.groundReply(draft, rf, src, { userId: null, record: false }));
  };
  // Before (what the real read answered on a later turn of that thread): supported, quoting the trial login. Code can't tell a stage,
  // so it stands; this documents that the stage is the read's to judge.
  const before = await run([{ text: "you've got him trying it on his own", type: "other_person", supported: true, factId: null, quote: "I set him up with a trial login so he can poke at it himself" }]);
  check("before: a read that upgrades the stage lets it through (the stage is the read's call)", before.final === DRAFT, before);
  const after = await run([{ text: "you've got him trying it on his own", type: "other_person", supported: false, factId: null, quote: null }]);
  check("after: a read that holds the stage cuts it, and the rest goes out", !/trying it/.test(after.final) && /leverage/.test(after.final) && after.checks.some((c) => c.name === "claim_other_person" && !c.pass), after);

  const TEAM = "Both notes land somewhere real. I've passed both to the team.";
  const noReceipt = await run([{ text: "I've passed both to the team.", type: "past_action", supported: true, factId: null, quote: "He had two notes" }], G.createReplyFacts(), TEAM);
  check("\"passed both to the team\" with no save this turn is cut, whatever the read quoted", !/passed both to the team/.test(noReceipt.final), noReceipt);
  const rf = G.createReplyFacts();
  G.addFact(rf, "did_this_turn", feedbackReceipt("The voice replies feel slow."));
  G.addFact(rf, "did_this_turn", feedbackReceipt("The intro call feels like a rival app's."));
  const withReceipt = await run([{ text: "I've passed both to the team.", type: "past_action", supported: true, factId: "F1", quote: null }], rf, TEAM);
  check("with the save's receipt this turn, it stands", withReceipt.final === TEAM, withReceipt);
  const failedSave = G.createReplyFacts();
  G.addFact(failedSave, "not_done", 'Their feedback wasn\'t saved for the team: "The voice replies feel slow."');
  const notSaved = await run([{ text: "I've passed both to the team.", type: "past_action", supported: true, factId: "F1", quote: null }], failedSave, TEAM);
  check("a save that failed backs nothing: cut", !/passed both to the team/.test(notSaved.final), notSaved);
  const STARTED = "Good call. I've started pulling the agreement templates.";
  const started = await run([{ text: "I've started pulling the agreement templates.", type: "past_action", supported: true, factId: null, quote: "Thinking about an NDA" }], G.createReplyFacts(), STARTED);
  check("\"I've started\" with no tool behind it this turn is cut", !/started pulling/.test(started.final), started);
}

console.log(`state claims: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
