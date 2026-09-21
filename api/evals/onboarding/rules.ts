// Model-free checks for the approved onboarding lines (services/
// onboardingLines.ts, 2026-09-19). No API calls, no database:
//   npx tsx evals/onboarding/rules.ts
import { CALL_OFFER, CARD, GATE_ASK, HOW_IT_WORKS, NAME_EMAIL, WELCOME, WRONG_CODE, pickLine } from "../../src/services/onboardingLines.js";
import { GATE_REPLY_BUDGET, decideGateReply, looksAutomated } from "../../src/services/gateGuard.js";

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

// Loop protection at the invite gate (2026-09-21): on 09-20 an automated reply
// service answered Co's invite prompts with unsubscribe and auto-reply text and
// Co replied "that code didn't take" 32 times in 3 minutes.
for (const auto of [
  "Reply STOP to unsubscribe.",
  "You have been unsubscribed from Hotplate messages. Msg&data rates may apply.",
  "This number is not monitored. Do not reply.",
  "Auto-reply: I'm out of the office until Monday.",
  "Your verification code is 482913",
  "STOP",
  "unsubscribe",
  "482913 is your login code",
  "This is an automated message, please do not respond.",
  "We don't accept inbound messages. These are the commands you can use: UNSUB CHEFNAME, RESUB CHEFNAME, UNSUBALL, RESUBALL",
  "Spellbound Sourdough is about to drop!\n\nOrder now: https://go.hotplate.com/ATRe02\n\nUNSUB SPELLBOUNDSOURDOUGH to stop. UNSUBALL to stop all SMS\nPwd by Hotplate",
]) check(`reads as automated: ${auto}`, looksAutomated(auto));
for (const human of [
  "hey",
  "Hi Co, Sam invited me. Code: 6VGF76VK",
  "my code is 7JQ2K9XM",
  "can you help me get an invite?",
  "yes",
  "who is this?",
  "please stop by later, I'm trying to get an invite from a friend",
  "",
]) check(`reads as a person: ${JSON.stringify(human)}`, !looksAutomated(human));
check("an automated message is never answered, even with budget left", decideGateReply({ text: "Reply STOP to unsubscribe.", recentGateReplies: 0 }) === "silent_automated");
check("a person with budget left is answered", decideGateReply({ text: "hey", recentGateReplies: 0 }) === "send");
check("a person can retry a code a few times", decideGateReply({ text: "ABCD2345", recentGateReplies: GATE_REPLY_BUDGET.max - 1 }) === "send");
check("past the budget Co goes quiet", decideGateReply({ text: "ABCD2345", recentGateReplies: GATE_REPLY_BUDGET.max }) === "silent_budget");
{
  // Replay of the 09-20 loop: 32 inbound messages, each answered by Co in turn.
  let sends = 0;
  let replies = 0;
  for (let i = 0; i < 32; i++) {
    if (decideGateReply({ text: "Reply STOP to unsubscribe.", recentGateReplies: replies }) === "send") { sends++; replies++; }
  }
  check("the 32-message auto-reply loop gets zero replies", sends === 0);
  sends = 0;
  replies = 0;
  for (let i = 0; i < 32; i++) {
    if (decideGateReply({ text: "ok", recentGateReplies: replies }) === "send") { sends++; replies++; }
  }
  check("even a non-obvious bot loop is capped at the budget", sends === GATE_REPLY_BUDGET.max);
}

console.log(`onboarding rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
