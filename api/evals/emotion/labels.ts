// Model-free checks for the no-emotion-label rule (Royce, 2026-10-04: "Co
// never tells members what they feel"): the check that guards texts, the call
// prompt's rule, and the post-call audit. No API calls, no database:
//   npx tsx evals/emotion/labels.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const { checkNoEmotionLabel } = await import("../../src/harness/emotion.js");

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
  "I hear a lot of stress in that.",
  "I can sense some sadness.",
  "I can hear the tension.",
  "I'm picking up some tension.",
  "I notice some disappointment.",
  "There's frustration in your voice.",
  "There's a lot of stress in your tone.",
  "I'm sensing excitement!",
  "You sound stressed.",
  "It sounds like you're feeling overwhelmed.",
]) check(`names their feeling: "${s}"`, flags(s));

// Not a label: about the situation, about a thing, or a plain acknowledgment.
for (const s of [
  "That sounds frustrating.",
  "I'm hearing great things about that event.",
  "I hear the launch moved again.",
  "I hear you.",
  "Sounds like the stress of the move is real.",
  "That's a lot to carry.",
  "What's been the hardest part?",
]) check(`not a label: "${s}"`, !flags(s));

// The rule is in the prompt both calls and texts read, without quoting a bad example.
const prompt = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const rule = prompt.split("\n").find((l) => /Never tells them what they're feeling/.test(l)) ?? "";
check("the prompt says Co never tells them what they're feeling, and what to do instead", /names the emotion it notices in them/.test(rule) && /Speak to what happened/.test(rule));
check("the rule doesn't quote a bad example (Co copies quoted examples)", !/"/.test(rule) && !/hearing frustration/i.test(prompt));
// Measured (evals/emotion/labelSim.ts, 20 simulated calls each, a frustrated caller who never says how they feel):
// the lines that primed it were removed, not just a rule added. The rule alone left 9 of 20 calls with a label.
check("nothing in the prompt tells Co to read the energy under their words or models the stock lines", !/read the energy underneath/.test(prompt) && !/Not "I hear you\."/.test(prompt) && !/Never says "I hear you"/.test(prompt));
check("the rule sits in What Co never does", prompt.indexOf(rule) > prompt.indexOf("WHAT CO NEVER DOES") && prompt.indexOf(rule) < prompt.indexOf("─── SILENCE"));

// Calls can't be filtered mid-call: every call is checked after it ends.
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
const post = co.slice(co.indexOf('event.type !== "post_call_transcription"'));
check("every call's Co lines are checked after it ends, and a label is logged", /const labelled = turns\.filter\([^;]*role !== "user"[^;]*checkNoEmotionLabel\(m\)\.pass\)/.test(post) && /if \(labelled\.length\) recordDecision\(\{[^}]*decision: "call\.emotion_label"/.test(post));
check("the audit never fails or slows the webhook", /decision: "call\.emotion_label"[\s\S]*?\}\)\.catch\(\(\) => \{\}\);/.test(post) && !/await recordDecision\(\{ layer: 8, decision: "call\.emotion_label"/.test(post));

console.log(`emotion label rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
