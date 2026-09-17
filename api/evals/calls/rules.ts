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
  UNKNOWN_TZ_WINDOW_UTC,
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

for (let h = 0; h < 24; h++) {
  const t = new Date(Date.UTC(2026, 8, 17, h, 0, 0));
  const expected = h >= UNKNOWN_TZ_WINDOW_UTC.start && h < UNKNOWN_TZ_WINDOW_UTC.end;
  check(`unknown timezone, ${h}:00 UTC ${expected ? "allowed" : "blocked"}`, callHourOk(null, t) === expected);
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

console.log(`call rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
