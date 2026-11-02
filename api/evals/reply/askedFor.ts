// What they asked Cue to do decides the reply's shape (2026-11-02, a member's thread on dev; the scenario here is made up, with the same
// shape): "sum up my issue" got advice, "the problem with her" got a fragment, "give me the steps" got six messages ending on a question
// nobody needed, and a legal step was described as protecting them outright. The reply rules now:
//   1. a summary is the whole reply, one paragraph (one short line receiving a feeling may come first), from what they told Cue, each
//      thing only as far along as they said, about what they named after a correction;
//   2. steps stop at the last step, with a question only when the next step needs their answer (a decision for Royce: his 2026-09-22
//      rule ended walkthroughs on a gauging question);
//   3. a legal or money step is described by what it covers and what it leaves open, in Cue's own words (guidance, no line to quote).
// Layer 1: zero tokens, no database. The model is a fake fetch that records the reply prompt and answers with the shape of reply Cue
// sent before; whether the model follows the new rules is unverified until a paid run. What's checked: the rules reach the reply, and
// how a reply in each shape goes out as messages.
//   npx tsx evals/reply/askedFor.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

let replyText = "";
const systems: string[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const raw = String(init?.body ?? "");
  let body: any = {};
  try { body = JSON.parse(raw); } catch {}
  const sys = Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("\n") : String(body.system ?? "");
  let text = "{}";
  if (/You check a text message Cue is about to send/.test(raw)) text = JSON.stringify({ claims: [] });
  else if (/You are replying by iMessage/.test(sys + raw)) (systems.push(sys + raw), (text = replyText));
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const G = await import("../../src/harness/replyGrounding.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { toBeats, asksThem } = await import("../../src/services/beats.js");
const { momentInstruction } = await import("../../src/services/connectDots.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) {
    failed++;
    process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`);
  }
};

const RECENT = [
  "User said: Met Priya at her shop, it went well. We might do a weekend pop-up together to see if the candles sell. She asked about my scent recipes but I'm not sure I want to share them.\n\nMaybe a simple written agreement first.\n\nShe had two notes: checkout on my site is slow, and my labels look a lot like a big brand's",
  "Co replied: Holding back on the recipes is fair.",
  "User said: I dropped off a sample box so she can try them at home",
  "Co replied: Smart move.",
  "User said: ok sum up my issue",
  "Co replied: The candles sell and that's your leverage; agree terms before recipes.",
  "User said: No, I mean the problem with Priya",
].join("\n");
const promptFor = async (message: string, instructions: string[] = []) => {
  const rf = G.createReplyFacts();
  for (const i of instructions) G.addInstruction(rf, i);
  systems.length = 0;
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await runConversationReplyAgent({
      userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan", resolvedContent: message, isVoice: false, imageForVision: null,
      hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null,
      facts: rf, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: RECENT, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true,
    } as any, { dryRun: true, record: false });
  } finally {
    console.log = log;
    console.error = err;
  }
  return systems.join("\n");
};

// ------------------------------------------------------------------ 1. a summary: one paragraph, what they said, at the stage they said it
{
  replyText = "The core tension: prove the candles sell without handing over the recipes.\n\nRight now you're handling it well, samples over recipes, notes flowing.";
  const correction = momentInstruction({ mode: "asking", topic: "the problem with Priya specifically", pushback: "the last summary was about the recipes in general, not about Priya", lesson: null, dots: [] } as any) ?? "";
  const p = await promptFor("No, I mean the problem with Priya", [correction]);
  check("the reply ran on the fake model", systems.length > 0);
  check("a summary is the whole reply, in one paragraph", /When they ask you to sum something up \(a summary, their problem, what's going on with someone or something\), the summary is the whole reply, in one short paragraph\./.test(p), p.slice(0, 200));
  check("…with room for one short line receiving a feeling first, when they're struggling (meet the feeling first still holds)", /When they're struggling, one short line that receives the feeling can come first\./.test(p) && /meet the feeling first/.test(p));
  check("…from what they told Cue, who said or wants what, each thing only as far along as they said", /Build it from what they've told you, in this thread and before\. Say who said or wants what, and each thing only as far along as they said it is: planned is not started, started is not done\./.test(p));
  check("…with no advice, plan or question unless they asked for it", /No advice, plan or question unless they asked for that too\./.test(p));
  check("…and after a correction, about what they named", /If they say it's about someone or something else, sum up that\./.test(p));
  check("the correction itself reaches the reply: what it's about now, and that they pushed back", p.includes("Right now the conversation is about: the problem with Priya specifically") && p.includes("They're pushing back on what you said: the last summary was about the recipes in general, not about Priya."));
  const before = toBeats(replyText);
  check("before: that summary went out as two messages", before.length === 2, before);
  const after = toBeats("You and Priya might do a weekend pop-up to see if the candles sell. She asked about your recipes, and you're not sure about sharing them. Her notes: checkout on your site is slow, and the labels look close to a big brand's.");
  check("a one-paragraph summary goes out as one message", after.length === 1, after);
}

// ------------------------------------------------------------------ 2. steps stop at the last step
{
  const p = await promptFor("What should I do? Give me the steps");
  check("steps come whole and stop at the last step", /give the whole walkthrough in this one reply/.test(p) && /Stop after the last step\. Ask something only when you can't give the right next step without their answer\./.test(p));
  check("the old rule that ended every walkthrough on a question is gone", !/End with one question that gauges where they are with it/.test(p));
  const steps = ["Agree on the split before the pop-up.", "Ask what she needs to see to believe they'll sell.", "If she still wants recipes, put it in writing first.", "Bring your sister in before anything moves.", "Run the pop-up as the test."];
  const before = toBeats([...steps, "Which part feels least settled?"].join("\n\n"));
  check("before: five steps plus a closing question went out as five messages, the last a question", before.length === 5 && asksThem(before[before.length - 1]), before);
  const after = toBeats(steps.join("\n\n"));
  check("five steps and no question: five messages, the last a step", after.length === 5 && !asksThem(after[after.length - 1]), after);
}

// ------------------------------------------------------------------ 3. a legal or money step: what it covers and leaves open, in Cue's words
{
  const p = await promptFor("Maybe a simple written agreement before I show her anything");
  check("legal or money steps: think through what it covers and leaves open, and say both in Cue's own words", /On a legal or money step, think through what it actually covers and what it leaves open, and say both in your own words\./.test(p));
  check("guidance only: no line about a specific agreement for Cue to quote, and no \"never that it protects them\"", !/An NDA limits/.test(p) && !/never that it protects them/.test(p));
  check("the rule sits with advice, not with fact claims (the fact check still never cuts general know-how)", p.indexOf("On a legal or money step") > p.indexOf("challenge your own answer before you send it"));
}

console.log(`asked for: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
