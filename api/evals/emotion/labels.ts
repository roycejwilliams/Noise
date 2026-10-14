// Model-free checks for the no-emotion-label rule (Royce, 2026-10-04: "Co
// never tells members what they feel"): the check that guards texts, the call
// prompt's rule, and the post-call audit. No API calls, no database:
//   npx tsx evals/emotion/labels.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const { checkNoEmotionLabel, checkNoEmotionLabelOnCall } = await import("../../src/harness/emotion.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const flags = (s: string) => !checkNoEmotionLabel(s).pass;

// What a call actually said, and its kin.
for (const s of [
  "I'm hearing frustration there. What's not landing right?",
  "I'm hearing some frustration.",
  "I'm hearing some real frustration.",
  "I'm picking up on some frustration.",
  "I can sense some sadness.",
  "I can hear some tension.",
  "I'm picking up some tension.",
  "There's frustration in your voice.",
  "There's a lot of stress in your tone.",
  "There's some frustration in your words.",
  "I'm sensing excitement!",
  "You sound stressed.",
  "You sound irritated.",
  "You seem a bit annoyed.",
  "Sounds like you're frustrated.",
  "It sounds like you're feeling overwhelmed.",
  "I hear you're frustrated.",
  "I notice you're stressed.",
]) check(`names their feeling: "${s}"`, flags(s));

// Not a label. The text gate drops whole sentences, so "I hear ..." as hearsay
// about an event or a topic must pass it (review of #64: these were all cut).
for (const s of [
  "I hear the excitement around Friday's show is real",
  "I hear a lot of excitement about the new chef",
  "I sense a lot of excitement about the rooftop party",
  "I can hear the excitement in the crowd from here",
  "I hear the tension between the two founders got worse",
  "I notice the tension in the plan is the dates",
  "I can feel the tension in the room when those two talk",
  "I hear pain points come up a lot with hosts",
  "I hear anxiety is a big theme at that talk",
  "I hear grief groups meet Tuesdays",
  "I hear fear is the theme of the panel",
  "I notice some excitement around this event",
  'You said "I\'m hearing frustration from my team" in your note.',
  "There's excitement in your voice note about Friday!",
  "I hear the launch got pushed",
  "I'm hearing good things",
  "I hear a lot of people are going",
  "I can feel the energy building",
  "there's tension in the schedule",
  "I sense some interest from the host",
  "That sounds frustrating.",
  "I'm hearing great things about that event.",
  "I hear the launch moved again.",
  "I hear you.",
  "Sounds like the stress of the move is real.",
  "That's a lot to carry.",
  "What's been the hardest part?",
]) check(`not a label: "${s}"`, !flags(s));

// The call audit only logs, so it also takes the plain "I hear the X" Co used
// on real calls, and still doesn't flag hearsay about a thing.
check("call audit flags the 'about' form the text gate leaves alone: \"I'm hearing frustration about the sponsors.\"", !checkNoEmotionLabelOnCall("I'm hearing frustration about the sponsors.").pass && checkNoEmotionLabel("I'm hearing frustration about the sponsors.").pass);
for (const s of ["I hear the exhaustion underneath that.", "I hear the frustration. What's the reason?", "I hear a lot of stress in that.", "I can hear the tension.", "I notice some tension there."]) check(`call audit flags: "${s}"`, !checkNoEmotionLabelOnCall(s).pass);
check("the text gate leaves the plain 'I hear the X' alone (hearsay), the call audit doesn't", flags("I hear the exhaustion underneath that.") === false);
check("the call audit doesn't flag hearsay about a thing", checkNoEmotionLabelOnCall("I hear the launch got pushed").pass && checkNoEmotionLabelOnCall("I hear good things about it").pass);

// The rule is in Co's shared core (services/coCore.ts), which both calls and texts carry, without quoting a bad example.
const { CO_LISTENING } = await import("../../src/services/coCore.js");
const { promptForElevenLabs } = await import("../../src/services/elevenLabsCalls.js");
const prompt = promptForElevenLabs(readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8"));
const rule = CO_LISTENING.split("\n").find((l) => /never name the feeling you notice in them/.test(l)) ?? "";
check("the core says Cue never names the feeling it notices, and what to do instead", !!rule && /Show you got it by how you respond/.test(rule));
check("the rule doesn't quote a bad example (Cue copies quoted examples)", !/"/.test(rule) && !/hearing frustration/i.test(prompt));
// Measured (evals/emotion/labelSim.ts, 20 simulated calls each, a frustrated caller who never says how they feel):
// the lines that primed it were removed, not just a rule added. The rule alone left 9 of 20 calls with a label.
check("nothing in the prompt tells Cue to read the energy under their words or models the stock lines", !/read the energy underneath/.test(prompt) && !/Not "I hear you\."/.test(prompt) && !/Never says "I hear you"/.test(prompt));
check("no example in the prompt is itself a label frame (\"It sounds like you're ...\")", !/"It sounds like you're/.test(prompt));
// 2026-10-08: the call's voice is Hume's prompt, which carries its own form of the rule (the text listening block stays out of calls).
check("the call prompt carries the rule, in Hume's words", /Never tells them what they're feeling or names the emotion it notices in them/.test(prompt));

// Calls can't be filtered mid-call: every call is checked after it ends.
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
const post = co.slice(co.indexOf('event.type !== "post_call_transcription"'));
check("every call's Cue lines are checked after it ends, and a label is logged", /const labelled = turns\.filter\([^;]*role !== "user"[^;]*checkNoEmotionLabelOnCall\(m\)\.pass\)/.test(post) && /if \(labelled\.length\) recordDecision\(\{[^}]*decision: "call\.emotion_label"/.test(post));
check("the audit never fails or slows the webhook", /decision: "call\.emotion_label"[\s\S]*?\}\)\.catch\(\(\) => \{\}\);/.test(post) && !/await recordDecision\(\{ layer: 8, decision: "call\.emotion_label"/.test(post));

console.log(`emotion label rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
