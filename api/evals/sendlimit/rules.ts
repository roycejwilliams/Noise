// Model-free checks for the per-number send breaker (services/sendLimiter.ts,
// 2026-09-21). No API calls, no database:
//   npx tsx evals/sendlimit/rules.ts
import { SEND_LIMIT, createSendLimiter } from "../../src/services/sendLimiter.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const cfg = { max: 15, windowMs: 10 * 60 * 1000, cooldownMs: 30 * 60 * 1000 };
const T0 = Date.UTC(2026, 8, 21, 16, 0, 0);
const min = (n: number) => n * 60 * 1000;

check("default limit is 15 in 10 minutes with a 30 minute cooldown", SEND_LIMIT.max === 15 && SEND_LIMIT.windowMs === min(10) && SEND_LIMIT.cooldownMs === min(30));

{
  // A busy real turn: a search reply with results, well under the limit.
  const l = createSendLimiter(cfg);
  let ok = true;
  for (let i = 0; i < 8; i++) ok = ok && l.check("+14155550100", T0 + i * 5000).ok;
  check("a busy real reply (8 texts in 40s) is never blocked", ok);
}
{
  // The 09-20 loop: 32 texts to one number in 3 minutes.
  const l = createSendLimiter(cfg);
  let sent = 0;
  let trips = 0;
  for (let i = 0; i < 32; i++) {
    const r = l.check("+14155550100", T0 + i * 5600);
    if (r.ok) sent++;
    else if (r.tripped) trips++;
  }
  check("the 32-text loop is cut off at 15", sent === 15);
  check("the breaker reports the trip exactly once", trips === 1);
}
{
  const l = createSendLimiter(cfg);
  for (let i = 0; i < 15; i++) l.check("+14155550100", T0 + i * 1000);
  const r = l.check("+14155550100", T0 + 20000);
  check("the 16th text trips the breaker", !r.ok && r.tripped && r.count === 15);
  check("other numbers are unaffected", l.check("+14155550199", T0 + 21000).ok);
  check("still blocked 11 minutes later (past the window, inside the cooldown)", !l.check("+14155550100", T0 + min(11)).ok);
  check("a blocked attempt does not extend the cooldown", l.check("+14155550100", T0 + 20000 + min(30) + 1).ok);
  check("after the cooldown the number gets a fresh window", (() => { let ok = true; for (let i = 0; i < 14; i++) ok = ok && l.check("+14155550100", T0 + min(31) + i * 1000).ok; return ok; })());
}
{
  const l = createSendLimiter(cfg);
  for (let i = 0; i < 15; i++) l.check("+14155550100", T0 + i * 1000);
  check("same number in another format shares the count", !l.check("(415) 555-0100", T0 + 16000).ok);
  check("a missing number is never blocked", l.check(null, T0).ok && l.check("", T0).ok);
}
{
  // Steady, normal traffic: one text a minute all day never trips.
  const l = createSendLimiter(cfg);
  let ok = true;
  for (let i = 0; i < 300; i++) ok = ok && l.check("+14155550100", T0 + i * min(1)).ok;
  check("one text a minute for five hours never trips", ok);
}

console.log(`send limit rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
