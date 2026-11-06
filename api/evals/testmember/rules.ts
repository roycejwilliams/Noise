// Test members never text anyone (services/testNumbers.ts).
//   npx tsx evals/testmember/rules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
import fs from "node:fs";
const T = await import("../../src/services/testNumbers.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const coTest = { RAILWAY_ENVIRONMENT_NAME: "dev" } as any;
const prod = { RAILWAY_ENVIRONMENT_NAME: "production", NODE_ENV: "production" } as any;
check("555-0100 to 555-0199 are test numbers on co-test", T.isTestNumber("+14155550123", coTest) && T.isTestNumber("(212) 555-0199", coTest) && T.isTestNumber("+12125550100", coTest));
check("a real-looking number never is", !T.isTestNumber("+14155551234", coTest) && !T.isTestNumber("+14155550200", coTest) && !T.isTestNumber("+15550123000", coTest) && !T.isTestNumber(undefined, coTest));
check("production never treats any number as a test number", !T.isTestNumber("+14155550123", prod) && !T.testNumbersEnabled(prod));
check("locally (no Railway), test numbers work unless NODE_ENV is production", T.isTestNumber("+14155550123", {} as any) && !T.isTestNumber("+14155550123", { NODE_ENV: "production" } as any));
check("test handles are recognized", T.isTestHandle(T.testHandle()) && !T.isTestHandle("0b1f-real-handle"));

// Behavior: a send to a test number returns a test handle without calling Sendblue.
{
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async (...a: any[]) => { called++; return realFetch(...(a as [any])); }) as any;
  const { default: sendblue, sendReaction, markRead } = await import("../../src/services/sendblue.js");
  const res: any = await sendblue.messages.send({ number: "+14155550142", content: "hello test", from_number: "+10000000000" } as any);
  const reacted = await sendReaction(res.message_handle, "👀");
  await markRead("+14155550142");
  globalThis.fetch = realFetch;
  check("a text to a test number is not sent, and gets a test handle", T.isTestHandle(res?.message_handle) && res?.test === true);
  check("a tapback on a test message counts as given without a network call, and read receipts are skipped", reacted === true && called === 0);
}
check("calls are never placed to a test number", /if \(isTestNumber\(user\.phone_number\)\) return \{ success: false/.test(src("services/callTrigger.ts")));
check("an inline reply on a test member reads Cue's own send log", /if \(isTestHandle\(handle\)\) \{/.test(src("services/inlineReply.ts")));
check("the reset archives, never deletes", /UPDATE users SET archived_at = NOW\(\)/.test(src("scripts/testMember.ts")) && !/DELETE FROM/i.test(src("scripts/testMember.ts")));

// The reset's slot (11-06: 150 looked free beside an archived "+14155550150#a1" whose jordan.test50 email was taken; the insert failed)
check("a number rewritten with an archive marker counts as used", T.freeTestSlot(["+14155550100#a1"], [])?.phone === "+14155550101");
check("a taken reset email skips that number", T.freeTestSlot([], ["jordan.test00@example.test"])?.phone === "+14155550101");
check("a taken username skips that number", T.freeTestSlot([], [], ["jordan_test_00"])?.phone === "+14155550101");
check("the 11-06 case picks a number whose phone, email and username are all free", (() => { const s = T.freeTestSlot(["+14155550150#a1", ...Array.from({ length: 50 }, (_, i) => `+1415555${String(100 + i).padStart(4, "0")}`)], ["jordan.test50@example.test"]); return s?.phone === "+14155550151" && s.tag === "51"; })());
check("all used: no slot", T.freeTestSlot(Array.from({ length: 100 }, (_, i) => `+1415555${String(100 + i).padStart(4, "0")}`), []) === null);
check("the reset archives only when the new member is created (one transaction)", /BEGIN[\s\S]*UPDATE users SET archived_at[\s\S]*INSERT INTO users[\s\S]*COMMIT[\s\S]*ROLLBACK/.test(src("scripts/testMember.ts")));

console.log(`test member rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
