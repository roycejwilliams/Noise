// Issue reports (services/issueReports.ts): the dev-only switch.
//
//   npx tsx evals/issues/run.ts
//
// Feedback is flagged by the turn's one read and saved by Co's own tool (saveFeedbackForTeam → saveFeedback); the old
// word-filter gate and Haiku confirm step were removed with the READ_TURN=off path (2026-10-29).
import { captureEnabled } from "../../src/services/issueReports.js";

// Dev only: never on in production, whatever the flag says.
const guard: [boolean, string][] = [
  [captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test", CAPTURE_USER_ISSUES: "true" }), "on for co-test in dev with the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "co-test" }), "off for co-test without the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "Noise", CAPTURE_USER_ISSUES: "true" }), "off in production even with the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "co-test", CAPTURE_USER_ISSUES: "true" }), "off in production even named co-test"],
  [!captureEnabled({ CAPTURE_USER_ISSUES: "true" }), "off locally or anywhere without Railway's dev environment"],
  [captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "cue-test", CAPTURE_USER_ISSUES: "true" }), "on for cue-test (the renamed service) in dev with the flag"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "cue-test", CAPTURE_USER_ISSUES: "true" }), "off in production even named cue-test"],
  [!captureEnabled({ RAILWAY_ENVIRONMENT_NAME: "dev", RAILWAY_SERVICE_NAME: "api", CAPTURE_USER_ISSUES: "true" }), "off for any other dev service"],
];
const guardFailures = guard.filter(([ok]) => !ok);
for (const [, label] of guardFailures) console.log(`FAIL dev-only guard: ${label}`);
console.log(`issue reports dev-only guard: ${guard.length - guardFailures.length}/${guard.length} passed`);
if (guardFailures.length) process.exitCode = 1;
