// Model-free checks for the pure call-harness pieces fixed 2026-09-17 (code
// review findings: idempotency, voicemail detection, auto-intake looping,
// unknown-timezone call hours, inbound caller verification, call grounding).
//   npx tsx evals/calls/rules.ts
import "dotenv/config";
import {
  AUTO_INTAKE_MAX_ATTEMPTS,
  AUTO_INTAKE_MIN_GAP_HOURS,
  callHourOk,
  decideAutoIntake,
  hasRealUserTurn,
  inboundCallerVerified,
  isVoicemailGreeting,
  isRealUserUtterance,
  nextAllowedCallTime,
  stripVoicemailGreetingLines,
} from "../../src/harness/callGate.js";
import { cityChangeAllowed } from "../../src/services/profileExtraction.js";
import { personAskedForThis } from "../../src/harness/callGrounding.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label} ${detail}`);
  }
};

// ---- voicemail detection / real-user-turn (findings 2, 3) -----------------

check("greeting detected", isVoicemailGreeting("you've reached the voicemail of Alex, please leave a message after the tone"));
check("carrier message detected", isVoicemailGreeting("the person you are trying to reach is not available"));
check("real reply isn't a greeting", !isVoicemailGreeting("yeah I'm doing okay, just busy with work"));

check(
  "voicemail greeting alone isn't a real turn",
  !hasRealUserTurn(`assistant: Hey it's Co, just calling to check in!\nuser: you've reached the voicemail of Alex, please leave a message after the tone`),
);
check(
  "a bare hello isn't a real turn",
  !hasRealUserTurn(`assistant: Hey it's Co, just calling to check in!\nuser: hello?`),
);
check(
  "a real reply after Co spoke is a real turn",
  hasRealUserTurn(`assistant: Hey it's Co, just calling to check in!\nuser: hey, yeah things have been good, work's been busy`),
);
check(
  "user speaking before Co ever does isn't enough on its own",
  !hasRealUserTurn(`user: hello?\nassistant: Hey it's Co!`),
);
check(
  "only Co talking is not a real turn",
  !hasRealUserTurn(`assistant: Hey it's Co, just calling to check in!\nassistant: Guess you're not around, I'll try again later.`),
);

check("isRealUserUtterance requires Co to have spoken first", !isRealUserUtterance("hey what's up", false));
check("isRealUserUtterance accepts a real reply once Co has spoken", isRealUserUtterance("hey what's up", true));
check("isRealUserUtterance rejects a greeting even after Co has spoken", !isRealUserUtterance("please leave a message after the tone", true));

check(
  "stripVoicemailGreetingLines drops only the greeting line",
  stripVoicemailGreetingLines(`assistant: hi there\nuser: please leave a message after the tone\nuser: actually hey it's me, go ahead`) ===
    `assistant: hi there\nuser: actually hey it's me, go ahead`,
);

// ---- auto-intake done / attempt cap (finding 4) ----------------------------

const NOW = new Date("2026-09-17T18:00:00Z");
check(
  "no subscription isn't eligible",
  !decideAutoIntake({ subscriptionActive: false, identityCaptured: true, hadRealCall: false, hasRealProfile: false, attempts: 0, lastAttemptAt: null }, NOW).eligible,
);
check(
  "still doing name/email intake isn't eligible",
  !decideAutoIntake({ subscriptionActive: true, identityCaptured: false, hadRealCall: false, hasRealProfile: false, attempts: 0, lastAttemptAt: null }, NOW).eligible,
);
check(
  "a real intake call already happened, even with sparse life_chapters",
  !decideAutoIntake({ subscriptionActive: true, identityCaptured: true, hadRealCall: true, hasRealProfile: false, attempts: 1, lastAttemptAt: null }, NOW).eligible,
);
check(
  "a real profile on file (goals/activities/blockers/direction) counts as done",
  !decideAutoIntake({ subscriptionActive: true, identityCaptured: true, hadRealCall: false, hasRealProfile: true, attempts: 0, lastAttemptAt: null }, NOW).eligible,
);
check(
  "brand new subscriber with nothing on file is eligible",
  decideAutoIntake({ subscriptionActive: true, identityCaptured: true, hadRealCall: false, hasRealProfile: false, attempts: 0, lastAttemptAt: null }, NOW).eligible,
);
check(
  `caps at ${AUTO_INTAKE_MAX_ATTEMPTS} attempts`,
  !decideAutoIntake(
    { subscriptionActive: true, identityCaptured: true, hadRealCall: false, hasRealProfile: false, attempts: AUTO_INTAKE_MAX_ATTEMPTS, lastAttemptAt: new Date(NOW.getTime() - 1000 * 3600 * 24 * 30) },
    NOW,
  ).eligible,
);
check(
  `doesn't retry within ${AUTO_INTAKE_MIN_GAP_HOURS}h of the last attempt`,
  !decideAutoIntake(
    { subscriptionActive: true, identityCaptured: true, hadRealCall: false, hasRealProfile: false, attempts: 1, lastAttemptAt: new Date(NOW.getTime() - 1000 * 3600) },
    NOW,
  ).eligible,
);
check(
  `retries once the gap has passed and under the cap`,
  decideAutoIntake(
    { subscriptionActive: true, identityCaptured: true, hadRealCall: false, hasRealProfile: false, attempts: 1, lastAttemptAt: new Date(NOW.getTime() - 1000 * 3600 * (AUTO_INTAKE_MIN_GAP_HOURS + 1)) },
    NOW,
  ).eligible,
);

// ---- unknown-timezone call window (finding 5) ------------------------------

// A known timezone still uses the real local-hours window regardless of the
// unknown-tz fallback.
check("known timezone, daytime there, allowed", callHourOk("America/New_York", new Date("2026-09-17T18:00:00Z"))); // 2pm ET
check("known timezone, 3am there, blocked", !callHourOk("America/Los_Angeles", new Date("2026-09-17T10:00:00Z"))); // 3am PT

// Unknown zone (2026-10-07): the texts' rule, 8am-9pm Pacific as a zone (PDT on Sep 17: 15:00-04:00 UTC).
for (let h = 0; h < 24; h++) {
  const t = new Date(Date.UTC(2026, 8, 17, h, 0, 0));
  const pacificHour = (h + 24 - 7) % 24;
  const expected = pacificHour >= 8 && pacificHour < 21;
  check(`unknown timezone, ${h}:00 UTC (${pacificHour}:00 PDT) ${expected ? "allowed" : "blocked"}`, callHourOk(null, t) === expected);
}
check("nextAllowedCallTime is a no-op when already in the window", nextAllowedCallTime(null, new Date("2026-09-17T18:00:00Z")).getTime() === new Date("2026-09-17T18:00:00Z").getTime());
check("nextAllowedCallTime rolls forward to the window when outside it", callHourOk(null, nextAllowedCallTime(null, new Date("2026-09-17T10:00:00Z"))));

// ---- inbound caller verification (finding 15) ------------------------------

check("full carrier attestation verified", inboundCallerVerified("TN-Validation-Passed-A"));
check("lower attestation rejected", !inboundCallerVerified("TN-Validation-Passed-B"));
check("no attestation rejected", !inboundCallerVerified(null));
check("empty string rejected", !inboundCallerVerified(""));
check("dev override allows unverified", inboundCallerVerified(null, true));

// ---- city guard (finding 6) — see evals/profile/lists.ts for full coverage

check(
  "a role preference doesn't move them (calls.rules smoke test)",
  !cityChangeAllowed("San Francisco", "NYC", "user: also looking at roles in NYC"),
);
check(
  "saying they're there moves them (calls.rules smoke test)",
  cityChangeAllowed("San Francisco", "NYC", "user: I'm in NYC now"),
);

// ---- call grounding: only the person's own ask gets saved (finding 13) ----

check(
  "Co's own unprompted promise isn't the person's ask",
  !personAskedForThis(`assistant: I'll look for some events for you while we're at it\nuser: sounds good, thanks`, "look for events for them"),
);
check(
  "a promise matching what the person actually asked for is their ask",
  personAskedForThis(`user: can you look for a technical co-founder for me\nassistant: absolutely, I'll look for a technical co-founder`, "look for a technical co-founder"),
);

// ---------------------------------------------------------------- calls on the shared picture (2026-09-28)
{
  const { readFileSync } = await import("fs");
  const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
  const CL = await import("../../src/services/callLearning.js");
  const call = `assistant: Both are the same night, so it's one or the other.
user: This has nothing to do with Oct 10th, I was just asking about Tuesday.
assistant: Got it.
user: I'm heading to the Grok night either way.`;
  check("a lesson backed by their own words on the call is kept", CL.callLessonsFrom({ lessons: [{ lesson: "When he asks about logistics, answer the logistics.", quote: "this has nothing to do with Oct 10th" }] }, call).length === 1);
  check("a lesson quoting Co, or quoting nothing, is dropped", CL.callLessonsFrom({ lessons: [{ lesson: "x", quote: "same night, so it's one or the other" }, { lesson: "y", quote: "" }] }, call).length === 0);
  check("their lines are the user lines only", CL.theirLines(call).split("\n").length === 2 && !/one or the other/.test(CL.theirLines(call)));
  const prompt = CL.callLearningPrompt({ transcript: call, today: "2026-09-28", onFile: null, openAsks: [] });
  check("one call read covers profile, resolutions, corrections, cadence, planned event and lessons", ["\"profile\"", "\"resolved\"", "\"corrections\"", "\"cadence\"", "\"planned_event\"", "\"lessons\""].every((k) => prompt.includes(k)) && /The whole call is new: every "user" line counts/.test(prompt));
  check("the call read writes about them as \"they\"", /never "he" or "she"/.test(prompt) && (() => { const n = CL.neutralLearning({ profile: { long_term_direction: "proving to himself he belongs", goals: ["help his cofounder"] } }).profile as any; return !/\b(he|him|himself|his)\b/i.test(`${n.long_term_direction} ${n.goals.join(" ")}`); })());
  const cl = src("services/callLearning.ts");
  check("a failed read still fails the call (retried), an unreadable one falls back to the old calls", !/generateText\(\{[\s\S]{0,40}\}\)\.catch/.test(cl) && /extractPsychographicProfile\(input\.transcript\)/.test(cl) && /await storeProfile\(input\.userId, learned\.profile as any, input\.transcript, \{\s*precomputed:/.test(cl));
  check("lessons from calls use the same store and dedupe as texts, one member only", /memory_type = 'co_lesson'/.test(cl) && /WHERE user_id = \$1 AND memory_type = 'co_lesson'/.test(cl));
  const co = src("routes/co.ts");
  check("after a call: the merged read runs before the call is marked complete", co.indexOf("await learnFromCall({ userId: user_id") > 0 && co.indexOf("await learnFromCall({ userId: user_id") < (co.match(/if \(chat_id\) await finishCallProcessing\(chat_id, "completed"\);\n\n\s*\/\/ Profile is fully extracted/)?.index ?? -1));
  check("after a call: ask capture stays whole-call and separate", /captureIntent\(user_id, cleanTranscript, \{ scope: "whole_transcript" \}\)\s*\.then\(\(\) => surfaceNewAsksNow\(user_id\)\)/.test(co));
  check("after a call: summary, snapshot, crisis backstop and follow-up text still run", /summarizeCallForTextContext\(user_id, cleanTranscript\)\s*\.then\(\(\) => refreshPersonSnapshot\(user_id, \{ force: true \}\)\)/.test(co) && /if \(soundsLikeCrisis\(theirLines\)\)/.test(co) && /await scheduleFollowUpText\(user_id, cleanTranscript\);/.test(co));
  check("the old separate calls stay one switch away", /process\.env\.CALL_LEARNING === "off"/.test(co));
  check("a call opens with the shared picture (inbound and outbound registration)", /buildCallContextSummary\(userId\)\.catch\(\(\) => ""\)/.test(src("routes/co.ts")) && /takeCallContext\(userId, buildCallContextSummary\)/.test(src("routes/co.ts")) && /context_summary: withCallSituation\(o\.contextSummary, /.test(src("services/elevenLabsCalls.ts")));
  const cc = src("services/callContext.ts");
  check("the call picture: lessons and what Co sent (with what's on file) come first", cc.indexOf("How to be with them, from times they corrected you") < cc.indexOf("What you sent them lately") && /sentDetailLines\(\{ sent \}, 7\)/.test(cc) && /fillDetails\(items\)/.test(cc) && !/assembleContext\(/.test(cc));
  check("a call never waits on slow page reads", /CALL_CONTEXT_WAIT_MS = 3000/.test(cc));
  const { callAuditPrompt } = await import("../../src/harness/callGrounding.js");
  const ap = callAuditPrompt("assistant: hi", "Co sent them X.", "Who they are: a builder.");
  check("the audit: facts and impressions are separate, and an impression is never proof", /What Co knew going into the call \(facts\):\nCo sent them X\./.test(ap) && /never as proof/.test(ap) && /Who they are: a builder\./.test(ap));
  check("the audit still reads a plain summary the old way", !/impressions going in/.test(callAuditPrompt("assistant: hi", "known")));
  check("the audit gets facts and impressions from the call picture", /auditCall\(user_id, cleanTranscript, knownBeforeCall\)/.test(co) && /buildCallKnowledge\(user_id\)/.test(co));
  const prompt2 = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
  // Since 2026-10-08 these are Co's shared grounding rules (services/coCore.ts), on texts and calls alike.
  const { CO_GROUNDING } = await import("../../src/services/coCore.js");
  const { promptForElevenLabs } = await import("../../src/services/elevenLabsCalls.js");
  check("the call prompt: facts vs. impressions, in spoken terms", /If it isn't there, you don't have it/.test(CO_GROUNDING) && /impression, so say it like one/.test(CO_GROUNDING) && /Two events only clash if you have both start times and they overlap/.test(CO_GROUNDING) && !/[—–]/.test(CO_GROUNDING) && promptForElevenLabs(prompt2).includes(CO_GROUNDING));
}

console.log(`call rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
