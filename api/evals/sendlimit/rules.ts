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

const cfg = { max: 30, unprompted: 12, windowMs: 10 * 60 * 1000, cooldownMs: 30 * 60 * 1000 };
const T0 = Date.UTC(2026, 8, 21, 16, 0, 0);
const min = (n: number) => n * 60 * 1000;
const sec = (n: number) => n * 1000;
const N = "+14155550100";

check("defaults: 30 in 10 minutes, 12 with no reply, 30 minute cooldown", SEND_LIMIT.max === 30 && SEND_LIMIT.unprompted === 12 && SEND_LIMIT.windowMs === min(10) && SEND_LIMIT.cooldownMs === min(30));

{
  // Royce's chat, 2026-09-24 3:18 to 3:28 PM: nine quick exchanges, then a
  // search reply of six texts, then the weekend question. The old single
  // cap blocked the 16th text for 30 minutes.
  const l = createSendLimiter(cfg);
  let ok = true;
  let t = T0;
  for (let i = 0; i < 9; i++) {
    l.noteInbound(N);
    t += sec(40);
    ok = ok && l.check(N, t).ok;
  }
  l.noteInbound(N);
  for (let i = 0; i < 6; i++) ok = ok && l.check(N, (t += sec(2))).ok;
  l.noteInbound(N);
  ok = ok && l.check(N, (t += min(2))).ok;
  check("the 09-24 conversation (16 texts in 10 minutes, all answering them) is never blocked", ok);
}
{
  const l = createSendLimiter(cfg);
  let ok = true;
  for (let i = 0; i < 8; i++) ok = ok && l.check(N, T0 + i * 5000).ok;
  check("a busy real reply (8 texts in 40s) is never blocked", ok);
}
{
  // A loop on Co's side: nothing from them in between.
  const l = createSendLimiter(cfg);
  let sent = 0;
  let trips = 0;
  let reason = "";
  for (let i = 0; i < 32; i++) {
    const r = l.check(N, T0 + i * 5600);
    if (r.ok) sent++;
    else if (r.tripped) {
      trips++;
      reason = r.reason;
    }
  }
  check("a one-sided loop is cut off at 12", sent === 12 && reason === "unprompted");
  check("the breaker reports the trip exactly once", trips === 1);
}
{
  // The 09-20 loop: two bots answering each other, a reply every time.
  const l = createSendLimiter(cfg);
  let sent = 0;
  let reason = "";
  for (let i = 0; i < 40; i++) {
    l.noteInbound(N);
    const r = l.check(N, T0 + i * 5600);
    if (r.ok) sent++;
    else if (r.tripped) reason = r.reason;
  }
  check("two bots answering each other are cut off at 30", sent === 30 && reason === "total");
}
{
  const l = createSendLimiter(cfg);
  for (let i = 0; i < 12; i++) l.check(N, T0 + i * 1000);
  const r = l.check(N, T0 + 20000);
  check("the 13th unanswered text trips the breaker", !r.ok && r.tripped && r.count === 12);
  check("blocked() reports the hold", l.blocked(N, T0 + 21000)?.reason === "unprompted" && l.blocked("+14155550199", T0) === null);
  l.noteInbound(N);
  check("a reply from them doesn't lift a breaker that already tripped", !l.check(N, T0 + 22000).ok);
  check("other numbers are unaffected", l.check("+14155550199", T0 + 21000).ok);
  check("still blocked 11 minutes later (inside the cooldown)", !l.check(N, T0 + min(11)).ok);
  check("a blocked attempt does not extend the cooldown", l.check(N, T0 + 20000 + min(30) + 1).ok);
  check("blocked() clears after the cooldown", l.blocked(N, T0 + 20000 + min(31)) === null);
}
{
  const l = createSendLimiter(cfg);
  for (let i = 0; i < 12; i++) l.check(N, T0 + i * 1000);
  check("same number in another format shares the count", !l.check("(415) 555-0100", T0 + 16000).ok);
  check("a missing number is never blocked", l.check(null, T0).ok && l.check("", T0).ok);
}
{
  // Steady proactive traffic with replies now and then never trips.
  const l = createSendLimiter(cfg);
  let ok = true;
  for (let i = 0; i < 300; i++) {
    if (i % 10 === 0) l.noteInbound(N);
    ok = ok && l.check(N, T0 + i * min(1)).ok;
  }
  check("one text a minute for five hours, with a reply every ten, never trips", ok);
}

// ---- wiring
import { readFileSync } from "fs";
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const route = src("src/routes/sendblue.ts");
check("a real text from them resets the unprompted count", /markRead\(lockKey\)[^\n]*\n[^\n]*\n\s+sendLimiter\.noteInbound\(lockKey\);/.test(route));
const sb = src("src/services/sendblue.ts");
check("a trip emails the team right away", /alertTeamNow\(\s*`send_breaker:/.test(sb));
check("a trip leaves a note on the member for Co", /'send_held'/.test(sb));
const tools = src("src/agent/conversationTools.ts");
check("sendReply stops when sends are held or failed twice", /sendLimiter\.blocked\(ctx\.phoneNumber\) \|\| state\.failedSends >= 2/.test(tools));
const reply = src("src/agent/conversationReply.ts");
check("the agent loop stops on a held send", /stopWhen: \[stepCountIs\(LOOP_BUDGET\.steps\), \(\) => state\.sendStopped[,\]]/.test(reply));
check("no plain-text retry or fallback while held", (reply.match(/if \(!state\.sent && !state\.sendStopped\)/g) ?? []).length === 2);
const grounding = src("src/harness/replyGrounding.ts");
check("Co is told its texts were held, and not to deny it", /memory_type = 'send_held'/.test(grounding) && /Never deny it or give another reason/.test(grounding));

// ---- the held note itself
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { sendHeldNote } = await import("../../src/services/sendblue.js");
const note = sendHeldNote(Date.parse("2026-09-24T22:28:00Z"), Date.parse("2026-09-24T22:58:00Z"));
check("the note names the window in Pacific time", /3:28 PM to 3:58 PM Pacific/.test(note));
check("the note has no em dashes", !/[—–]/.test(note));

// ---- captured intent: only what's new
const { dropKnownExtras } = await import("../../src/services/profileExtraction.js");
const onFile = [{ availability: "balancing a 9-5", concrete_preferences: ["indoor venue"], wants: [] }];
const again = dropKnownExtras({ concrete_preferences: ["Indoor venue."], wants: [], availability: "Balancing a 9-5" }, onFile);
check("a line said once isn't saved again every turn", !again.availability && again.concrete_preferences.length === 0);
const fresh = dropKnownExtras({ concrete_preferences: ["rooftop"], wants: ["meet VCs"], availability: "free weekends" }, onFile);
check("new details still get saved", fresh.availability === "free weekends" && fresh.concrete_preferences[0] === "rooftop" && fresh.wants[0] === "meet VCs");
const extraction = src("src/services/profileExtraction.ts");
check("capture filters against what's on file before writing", /dropKnownExtras\(\{ concrete_preferences, wants, availability \}/.test(extraction));

// A send Sendblue rejected doesn't count (2026-09-28).
{
  const lim = createSendLimiter({ max: 3, unprompted: 2, windowMs: 600_000, cooldownMs: 1_800_000 });
  lim.check("+15551234567", 1);
  lim.release("+15551234567");
  lim.check("+15551234567", 2);
  check("a rejected send is released, so the resend doesn't trip the limit", lim.check("+15551234567", 3).ok === true);
  check("releasing with nothing recorded is harmless", (() => { lim.release("+15550000000"); lim.release(null); return true; })());
  const sb = readFileSync(new URL("../../src/services/sendblue.ts", import.meta.url), "utf8");
  check("only an outright rejection (4xx) is released", /err\.status >= 400 && err\.status < 500\) sendLimiter\.release\(to\)/.test(sb));
}

console.log(`send limit rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
