// Model-free checks for how Co's texts are prompted (2026-09-24). The
// measured result lives in evals/texting (grade.ts, pairwise.ts): on 40 real
// co-test texts, blind Opus preferred this prompt over the old one 29 to 10.
//
//   npx tsx evals/texting/rules.ts
import { readFileSync } from "fs";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const reply = src("agent/conversationReply.ts");
// What shapes Co's replies: the listening summary and the reply prompt
// itself (not the yes/no classifier prompts elsewhere in the file).
// How Co listens is in the shared core since 2026-10-08 (services/coCore.ts), the same block a call gets.
const { CO_LISTENING: listening } = await import("../../src/services/coCore.js");
const template = reply.slice(reply.indexOf("  const system = `You are replying"), reply.indexOf("const userText ="));
const prompt = `${listening}\n${template}`;
const sentences = prompt.replace(/\$\{[^}]*\}/g, "X").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
check("no dashes in the reply prompt (Cue copies its instructions' style)", !/[—–]/.test(prompt));
check("the reply prompt is written in short sentences", sentences.filter((s) => s.split(/\s+/).length > 45).length === 0);
check("no quoted bad openers for Cue to copy", !/"That's a big call\."|"That \[noun phrase\]/.test(prompt));
check("texts get Cue's shared core (how Cue listens included), not the full call guide", /const sharedSystem = `\$\{CO_CORE\}\n\n\$\{MOVES_GUIDE\}\n\n\$\{MESSAGE_RHYTHM\}\n\n\$\{COACHING\}`;/.test(reply) && !/\$\{input\.personaPrompt\}/.test(reply));
check("the call guide isn't fetched from Hume on every text", !/renderCoPersonaPrompt\(/.test(src("routes/sendblue.ts")));
check("the length rule is concrete", /under about 15 words and doesn't ask for a plan or detail, reply in one or two sentences/.test(reply));
check("say each thing once", /Say each thing once\. Don't repeat a point, an offer or a question from your last message\./.test(reply));

check("the reply starts with Cue's own answer or reaction", /Always respond genuinely to what they said first: start with your answer or your own reaction, in your own words\./.test(reply));
// Scoped to shares and feedback (Royce 2026-10-29): the length line is said last on every other turn, never on a share or feedback.
check("the length line is said last, right before Cue writes, from the turn's moment", /const lengthLine = lengthLineFor\(input\.resolvedContent, input\.facts\.moment, !!input\.imageForVision\);\s+const userText = lengthLine \? `\$\{baseUserText\} \$\{lengthLine\}` : baseUserText;/.test(reply));
check("no test switches or example block left in", !/process\.env\.CO_TEXT_|SHORT_EXAMPLES/.test(reply));
// ---- Prompt sweep 2026-10-29 (Royce: "go with your recommendation"), then scoped the same day: the rules every text gets are
// co-test's again (CO_TEXT_CHANNEL's cap, "Say less than you could", match the weight, the fragment line, the first-words sample);
// the sweep items below stay.
{
  const voice = src("services/coVoice.ts");
  check("global: CO_TEXT_CHANNEL keeps its cap and CO_VOICE says less than it could (co-test's)", /Keep it short, the way a person actually texts\. Two or three short sentences is a long reply\. If they asked/.test(voice) && /Calm, unhurried, specific\. Say less than you could\. One real thought beats three filler lines\./.test(voice));
  check("sweep: frustrated gets where it stands first and their decision if there is one; no 'or vague', no sentence count, no exactly-one-question", /When they're frustrated about it, skip the apology paragraph: lead with where it stands, and if a decision is theirs, ask it\./.test(voice) && !/frustrated or vague|exactly one question|end on it|in two sentences/.test(voice));
  check("global: match the weight, the fragment line, the stalling and sharpening bullets are co-test's", /Match the weight of your reply to theirs\./.test(reply) && /The length limit covers the whole reply, however many things are listed under "For this reply"\. Develop the single most important one\. Keep the rest to a fragment or save them for later\./.test(reply) && /Keep a stalling conversation going with a question, an observation or a related thought\./.test(reply) && /ask one specific follow-up that sharpens it\./.test(reply) && !/However many things are listed/.test(reply));
  const offerLine = reply.split("\n").find((l) => l.includes("What they shared could benefit from talking it through by voice")) ?? "";
  check("sweep: no 1-2 sentence cap before a gesture, no 'respond briefly even if heavy', no quoted call line", !/keep the response to what they shared to one or two sentences/.test(reply) && !/Respond briefly first, even if it was heavy/.test(offerLine) && !/hop on a call|are you free today or tomorrow|I'm here if you want to talk/.test(offerLine) && /Offer a call as a warm gesture, not a logistics question\. Make it a warm, open invitation rather than a scheduling question, and name a call or the phone plainly so it's clear what you mean\./.test(reply));
  check("global: the first-words rule keeps its sample exchange (co-test's)", /never their words handed back\. They: "should I raise now or wait\?" You: "I'd wait until Monday\. You'll have the numbers\."/.test(reply));
  const { COACHING } = await import("../../src/services/textRhythm.js");
  // Texts' COACHING only; CALL_COACHING (calls only) is left as it is.
  check("sweep: coaching asks what most shapes the advice, not 'the one question'", /then ask what most shapes the right advice, and give no advice yet/.test(COACHING) && !/the one question/.test(COACHING));
  // Global = co-test (scoped 2026-10-29): the style hint's length notes are back word for word; on a share or feedback turn the
  // moment's guide says it overrides the general length rules, so "keep your replies just as brief" never caps those turns.
  check("global: the style hint keeps co-test's length notes for short and long texters", /if \(avgWords <= 6\) \{\s+notes\.push\("they text short and to the point — keep your replies just as brief, don't pad them out"\);\s+\} else if \(avgWords >= 20\) \{\s+notes\.push\("they text in longer, fuller messages — a slightly fuller reply than usual is fine here"\);/.test(src("routes/sendblue.ts")));
  {
    const D = await import("../../src/services/connectDots.js");
    const OVERRIDE = /On this turn this overrides the general length and question rules: [^.]*with no length cap\./;
    const brief = /keep your replies just as brief/.test(src("routes/sendblue.ts"));
    check("when the style hint says brief, a share or feedback turn still carries its guide's override of the length rules", brief && OVERRIDE.test(D.SHARING_GUIDE) && OVERRIDE.test(D.FEEDBACK_GUIDE) && (D.momentInstruction({ mode: "sharing", topic: "a trip", pushback: null, lesson: null, dots: [] } as any) ?? "").includes(D.SHARING_GUIDE) && (D.momentInstruction({ mode: "feedback", topic: "tone", pushback: "dry", lesson: null, dots: [] } as any) ?? "").includes(D.FEEDBACK_GUIDE));
  }
  check("sweep: one reply prompt, no REPLY_PROMPT=flow copy", !/systemFlow|REPLY_PROMPT/.test(reply));
  process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
  process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
  process.env.OPENAI_API_KEY ||= "unused-in-tests";
  const { replyLengthLine, lengthLineFor } = await import("../../src/agent/conversationReply.js");
  check("length line: a short message gets it", replyLengthLine("we still can't find a venue") === "Their message was 6 words and doesn't ask for detail. Reply in one or two sentences.");
  check("length line: a request for detail doesn't", replyLengthLine("can you walk me through the plan?") === null && replyLengthLine("take the lead on this") === null);
  check("length line: a long message doesn't", replyLengthLine("so here is the thing, we had the permit lined up for the street and then the city came back and said no") === null);
  // Scoped (Royce 2026-10-29): a share or feedback turn is never capped; every other moment, and no moment read, keeps the line.
  const short = "just got back from lisbon";
  check("length line: never on a sharing or a feedback turn", lengthLineFor(short, "sharing", false) === null && lengthLineFor("you're dry", "feedback", false) === null);
  check("length line: every other moment, and no moment read, keeps it; a photo never gets it", ["small_talk", "asking", "logistics", "planning", "reacting", null, undefined].every((m) => lengthLineFor(short, m as any, false) === replyLengthLine(short)) && lengthLineFor(short, "small_talk", true) === null);
  const { dropRepeatedQuestion } = await import("../../src/services/textStyle.js");
  const thread = "Co replied: How's the venue search for the launch party going?\nUser said: slow, two places said no";
  const building = "Two no's this early is normal. What's left on the launch party venue search?";
  check("sweep: a building follow-up on the same subject isn't dropped as a repeat (bar 0.8)", dropRepeatedQuestion(building, thread) === building, dropRepeatedQuestion(building, thread));
  const again = "Two no's this early is normal. How's the venue search for the launch party going?";
  check("…a real repeat still is", dropRepeatedQuestion(again, thread) === "Two no's this early is normal.", dropRepeatedQuestion(again, thread));
}
console.log(`texting rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
