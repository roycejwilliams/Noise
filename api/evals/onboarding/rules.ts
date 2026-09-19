// Model-free checks for the approved onboarding lines (services/
// onboardingLines.ts, 2026-09-19). No API calls, no database:
//   npx tsx evals/onboarding/rules.ts
import { CALL_OFFER, CARD, GATE_ASK, HOW_IT_WORKS, NAME_EMAIL, WELCOME, WRONG_CODE, pickLine } from "../../src/services/onboardingLines.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const pools = { GATE_ASK, WRONG_CODE, WELCOME, HOW_IT_WORKS, CARD, NAME_EMAIL, CALL_OFFER };
for (const [name, pool] of Object.entries(pools)) {
  check(`${name} has at least 3 options, so onboardings vary`, pool.length >= 3);
  for (const line of pool) {
    const filled = pickLine([line], { name: "Royce" });
    check(`${name}: no em dash: "${line.slice(0, 40)}"`, !/[—–]/.test(line));
    check(`${name}: Co is only ever Co: "${line.slice(0, 40)}"`, !/copatible|matchmaker|assistant|concierge|\bAI\b/i.test(line));
    check(`${name}: starts with a capital: "${line.slice(0, 40)}"`, /^[A-Z]/.test(filled));
    check(`${name}: short enough for a text: "${line.slice(0, 40)}"`, filled.length <= 320);
    check(`${name}: never announces exclusivity: "${line.slice(0, 40)}"`, !/exclusive|invite-only|vip|elite/i.test(line));
  }
}
check("every first text asks for the invite code", GATE_ASK.every((l) => /invite code/i.test(l)));
check("every first text says who Co is", GATE_ASK.every((l) => /\bCo\b/.test(l)));
check("every call offer uses their name", CALL_OFFER.every((l) => l.includes("{name}")));
check("every call offer keeps texting an option", CALL_OFFER.every((l) => /text/i.test(l)));
check("every call offer offers now or a time", CALL_OFFER.every((l) => /now/i.test(l) && /time/i.test(l)));
check("the name is filled in", pickLine(CALL_OFFER, { name: "Jacqueline" }, () => 0).startsWith("Good to meet you, Jacqueline."));
check("no name falls back to 'there', never a blank", !pickLine(CALL_OFFER, { name: "" }, () => 0).includes(", ."));
const seen = new Set([0, 0.34, 0.67, 0.999].map((r) => pickLine(WELCOME, {}, () => r)));
check("every option can be picked", seen.size === WELCOME.length);

console.log(`onboarding rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
