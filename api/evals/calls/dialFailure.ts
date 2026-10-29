// A dial the phone service refuses is a call that never started, reported, never a crashed turn (2026-10-28: Royce's "Call me" hit
// Twilio's 401 "actor doesn't have any assertions", code 8001, from a restricted API key with no permissions; the error was thrown up
// through the text turn, Cue sent "something broke", replayed the turn and dialed again, and nothing told the team).
// Layer 1: no model, no network; the database and Twilio are stubbed.
//   TZ=UTC node evals/runLayer1.mjs evals/calls/dialFailure.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.TWILIO_ACCOUNT_SID ||= "SKtest";
process.env.TWILIO_CLIENT_SECRET ||= "test";
process.env.TWILIO_LIVE_SID ||= "ACtest";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const T = await import("../../src/services/callTrigger.js");
const R = await import("../../src/services/callReasons.js");
const D = await import("../../src/harness/devReview.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

// Twilio's own error for that key, the shape the SDK throws (RestException).
const twilio401 = Object.assign(new Error("actor doesn't have any assertions"), { status: 401, code: 8001, moreInfo: "https://www.twilio.com/docs/errors/8001" });

type Row = Record<string, unknown>;
let decisions: { decision: string; action: string | null; proposal: any; reason: string | null }[] = [];
let released = 0;
let failDecisionWrite = false;
(pool as any).query = async (sql: string, params: unknown[] = []) => {
  if (/SELECT u\.first_name, u\.phone_number/.test(sql)) return { rows: [{ first_name: "Jordan", phone_number: "+14155550200", subscription_status: "active", call_status: null, call_status_updated_at: null }] as Row[] };
  if (/^WITH prev AS/.test(sql.trim())) return { rows: [{ prev_status: null, prev_at: null }] };
  if (/UPDATE users SET call_status = \$2/.test(sql)) { released++; return { rows: [] }; }
  if (/INSERT INTO harness_decisions/.test(sql)) {
    if (failDecisionWrite && params[1] === "call.dial") throw new Error("connection refused");
    decisions.push({ decision: String(params[1]), action: (params[4] as string) ?? null, proposal: params[5] ? JSON.parse(String(params[5])) : null, reason: (params[8] as string) ?? null });
    return { rows: [] };
  }
  // A "call me" just now, and the router's place_call: what authorizes a router_decision call (harness/callGate.ts).
  if (/content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%'/.test(sql) || /action ILIKE '%place_call%'/.test(sql)) return { rows: [{ "?column?": 1 }] };
  if (/sms_opted_out/.test(sql)) return { rows: [{ sms_opted_out: false, identity_captured: true, city: null, checkin_call_cadence_days: null, has_real_profile: true, had_real_call: true }] };
  return { rows: [] };
};

// ---- 1. a refused dial returns a plain failure, never throws
{
  T.setDialForTests(async () => { throw twilio401; });
  let threw: unknown = null;
  let r: any = null;
  try { r = await T.triggerCallForUser("u-dial", null, { kind: "router_decision" }); } catch (e) { threw = e; }
  check("a refused dial doesn't throw up through the text turn", threw === null, threw);
  check("it returns success: false, marked as a dial that never started", r?.success === false && r?.dialFailed === true, r);
  check("the error says the call never started and the phone service refused it, with Twilio's status and code", /^Call never started: the phone service turned the dial down \(HTTP 401, code 8001\)\./.test(r?.error ?? ""), r?.error);
  check("the dial claim is let go, so the next 'call me' isn't blocked as a live call", released === 1, released);
  const d = decisions.find((x) => x.decision === "call.dial");
  check("the failure is reported in the decision log as call.dial dial_failed", d?.action === "dial_failed", decisions.map((x) => x.decision));
  check("the report carries the vendor's status, code and message, and what asked for the call", d?.proposal?.status === 401 && d?.proposal?.code === "8001" && d?.proposal?.message === "actor doesn't have any assertions" && d?.proposal?.requested === "router_decision" && d?.proposal?.stage === "dial", d?.proposal);
  check("and nothing private: no phone number, no name", !/555|Jordan/.test(JSON.stringify(d)), d);
  check("the report landed, so the error says it's on record", r?.error?.endsWith(R.FAILURE_ON_RECORD), r?.error);
}

// ---- 2. a report that didn't land is never said to have landed
{
  decisions = []; released = 0; failDecisionWrite = true;
  T.setDialForTests(async () => { throw twilio401; });
  const r: any = await T.triggerCallForUser("u-dial", null, { kind: "router_decision" });
  check("when the call.dial row didn't land, the error says it isn't on record", r?.success === false && r?.error?.endsWith(R.FAILURE_NOT_ON_RECORD) && !r?.error?.includes(R.FAILURE_ON_RECORD), r?.error);
  failDecisionWrite = false;
}

// ---- 3. a dial that went through is unchanged
{
  decisions = []; released = 0;
  T.setDialForTests(async () => ({ sid: "CAtest" }));
  const r: any = await T.triggerCallForUser("u-dial", null, { kind: "router_decision" });
  check("a dial Twilio accepted still returns its call sid", r?.success === true && r?.call_sid === "CAtest", r);
  check("and records no dial failure", !decisions.some((x) => x.decision === "call.dial"));
  T.setDialForTests(null);
}

// ---- 4. what Cue is told, from the error
{
  const on = R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, true);
  const off = R.dialFailureError({ stage: "dial", status: 401, code: "8001", message: "x" }, false);
  const why = R.callNotPlacedReason(on);
  check("the reason says the call never went out and their phone never rang", /never went out/.test(why) && /never rang/.test(why), why);
  check("a 401 is a setup problem: asking again right away would hit the same problem", /same problem/.test(why), why);
  check("the reason says it's on record only when it is", why.includes(R.FAILURE_ON_RECORD) && R.callNotPlacedReason(off).includes(R.FAILURE_NOT_ON_RECORD) && !R.callNotPlacedReason(off).includes(R.FAILURE_ON_RECORD));
  const transient = R.callNotPlacedReason(R.dialFailureError({ stage: "dial", status: 503, code: "20500", message: "x" }, true));
  check("a 503 isn't called a setup problem", !/same problem/.test(transient), transient);
  check("the facts carry the same reason, as a call that was never placed", R.callNotPlacedFacts(on).some((f) => f.kind === "known" && /^No call was placed this turn\. The call never went out/.test(f.text)));
  check("the gate's own reasons are unchanged", /isn't clear/.test(R.callNotPlacedReason("weird")) && /8am to 9pm/.test(R.callNotPlacedReason("Call blocked: outside 8am-9pm their time")));
  const detail = R.failureDetail(Object.assign(new Error("The 'To' number +1 415 555 0200 is not valid for jordan@example.com"), { status: 400, code: 21211 }));
  check("an error's phone numbers, emails and quoted values never reach the report", !/555|jordan@|'To'/.test(detail.message) && detail.status === 400 && detail.code === "21211", detail);
  const curly = R.failureDetail(new Error("Call to “Sarah Kim” at ‘home’ refused"));
  check("curly-quoted values never reach the report either", !/Sarah|Kim|home/.test(curly.message) && /Call to \[quoted\] at \[quoted\] refused/.test(curly.message), curly);
  check("contractions aren't mistaken for quotes", R.failureDetail(new Error("actor doesn't have any assertions and can't dial")).message === "actor doesn't have any assertions and can't dial");
}

// ---- 5. the morning review flags it
{
  const flags = D.logFlags({ userId: "u-dial", firstName: "Jordan", messages: [], decisions: [{ id: 1, at: new Date().toISOString(), decision: "call.dial", outcome: "skip", action: "dial_failed", reason: "actor doesn't have any assertions", proposal: { requested: "router_decision", stage: "dial", status: 401, code: "8001", message: "actor doesn't have any assertions" }, checks: [] } as any], emotions: [], issues: [] });
  const f = flags.find((x) => x.type === "call_never_started");
  check("a call that never started is a high flag in the morning review, with the vendor's cause", f?.severity === "high" && /HTTP 401, code 8001, actor doesn't have any assertions/.test(f?.cause ?? ""), flags);
}

// ---- 6. wiring
{
  const sb = src("routes/sendblue.ts");
  check("the text turn still grounds a failed call in its reason, never 'calling you now'", /const why = callNotPlacedReason\(callResult\.error\);/.test(sb) && /if \(callResult\.success\) \{\s*const confirmation = "Calling you now\.";/.test(sb));
  const co = src("routes/co.ts");
  check("the app's call button answers 502 for a dial that never started", /result\.dialFailed \? 502 : 403/.test(co));
}

console.log(`dial failure: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
