// Live check: the anonymous heads-up for an outside event names no one and
// asks (Sonnet 5, a few cents). Nothing is sent.
//
//   railway run --service co-test --environment dev -- npx tsx evals/outsideEvents/live.ts
import "dotenv/config";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "../../src/models.js";
import { checkNamesWithheld } from "../../src/harness/introConsent.js";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
const { anonymousHeadsUpPrompt } = await import("../../src/services/eventScoring.js");
const cases = [
  { other: "Sam", reason: "Sam runs a climate hardware startup and you're looking for a hardware cofounder", event: "Climate Week mixer" },
  { other: "Noor", reason: "you both moved to SF this year and love trail running", event: "SF Tech Week opening party" },
  { other: "Ellis", reason: "Ellis is a designer at Figma who mentors early-career designers, and you want a design mentor", event: "Config after-party" },
];
let ok = 0;
for (const c of cases) {
  // The reason Co is handed has already passed the share gate; here it still
  // names the other person, so the prompt must keep it out of the text.
  const { text } = await generateText({ model: anthropic(MODELS.sonnet), prompt: anonymousHeadsUpPrompt({ recipientFirstName: "Jordan", eventName: c.event, shareReason: c.reason, feedback: null }) });
  const named = !checkNamesWithheld(text, [c.other]).pass;
  const identifying = /figma|startup called|\bat [A-Z][a-z]+\b/i.test(text) && /figma/i.test(c.reason) && /figma/i.test(text);
  const asks = /\?/.test(text);
  const pass = !named && !identifying && asks;
  if (pass) ok++;
  console.log(`${pass ? "ok  " : "FAIL"} ${text}`);
}
console.log(`\nanonymous heads-up live: ${ok}/${cases.length}`);
process.exit(ok === cases.length ? 0 : 1);
