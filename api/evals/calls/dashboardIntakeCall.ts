// The co-test dashboard's call button still places an auto-intake call after the hourly job was parked (Royce, 2026-10-17: "Keep the
// dashboard call button placing auto-intake calls. It's a manual button, not Cue calling on its own. Add a test that the button still
// works after the schedule is removed."). The real route handler (co-test/src/routes/phone.ts POST /:user_id/call) calls
// triggerCallForUser(id, null); the call gate (harness/callGate.ts) infers auto_intake for a member with no profile yet, and the dial
// goes. registerJobs is never run here, so nothing depends on the removed cron.
// Layer 1: a fake store, a stubbed Twilio dial, the clock pinned inside their hours. Zero tokens; nothing dials, nothing is written.
//   npx tsx evals/calls/dashboardIntakeCall.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
// The call token the TwiML URL carries is signed with this (services/elevenLabsCalls.ts issueCallToken); a placeholder here.
process.env.ELEVENLABS_TOOL_SECRET ||= "layer1-placeholder";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const { default: twilio } = await import("twilio");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

// 11:00 in San Francisco: inside the 8am-9pm window a call Cue starts needs.
const RealDate = Date;
const FIXED = new RealDate("2026-10-17T18:00:00Z").getTime();
globalThis.Date = class extends RealDate {
  constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(FIXED); }
  static now() { return FIXED; }
} as DateConstructor;

// The dial: Twilio's calls.create, stubbed on the client class (callTrigger.ts builds its client at import).
const dials: any[] = [];
Object.defineProperty((twilio as any).Twilio.prototype, "calls", { configurable: true, get() { return { create: async (o: any) => { dials.push(o); return { sid: "CA_test_dashboard" }; } }; } });

// GPT-Live's check before dialing passes here (its own tests: evals/calls/gptLiveOutbound.ts).
(await import("../../src/services/callTrigger.js")).setPreflightForTests(async () => ({ ok: true }));

// One member, the shape a brand-new member has: identity captured, subscription active, no profile content, no call yet.
const member = { profile: false, realCall: false, attempts: 0 };
const gate: any[] = [];
const writes: string[] = [];
(pool as any).query = async (sql: string, params: any[] = []) => {
  const q = String(sql).replace(/\s+/g, " ").trim();
  if (/^INSERT INTO harness_decisions/i.test(q)) { gate.push(params); return { rows: [], rowCount: 1 }; }
  if (/^SELECT identity_captured FROM users WHERE id = \$1/i.test(q)) return { rows: [{ identity_captured: true }] };
  if (/SELECT u\.first_name, u\.phone_number, u\.subscription_status, u\.call_status/i.test(q)) return { rows: [{ first_name: "Ellis", phone_number: "+14150110142", subscription_status: "active", call_status: null, call_status_updated_at: null }] };
  if (/AS has_real_profile/i.test(q)) return { rows: [{ sms_opted_out: false, identity_captured: true, city: "San Francisco", checkin_call_cadence_days: null, has_real_profile: member.profile, had_real_call: member.realCall }] };
  if (/COUNT\(\*\)::int AS n, MAX\(created_at\) AS at FROM harness_decisions/i.test(q)) return { rows: [{ n: member.attempts, at: null }] };
  if (/^WITH prev AS \(SELECT call_status/i.test(q)) { writes.push("dial claim"); return { rows: [{ prev_status: null, prev_at: null }] }; }
  if (/^INSERT INTO co_memories/i.test(q)) { writes.push("call record"); return { rows: [{ id: 1 }] }; }
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) { writes.push(q.slice(0, 60)); return { rows: [], rowCount: 1 }; }
  return { rows: [], rowCount: 0 };
};
(pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });
const quietErr = console.error;
console.error = () => {};

// The button's own handler, from the real co-test router (the login middleware in front of it is left out: it's the session check).
const { default: router } = await import("../../../co-test/src/routes/phone.js");
const layer = (router as any).stack.find((l: any) => l.route?.path === "/:user_id/call" && l.route.methods?.post);
check("the co-test dashboard has the call button route (POST /:user_id/call)", !!layer);
const handler = layer?.route.stack[layer.route.stack.length - 1].handle;
const press = async () => {
  const res: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
  let err: any = null;
  await handler({ params: { user_id: "u-ellis" } }, res, (e: any) => { err = e; });
  await new Promise((r) => setImmediate(r));
  return { res, err };
};

{
  dials.length = 0; gate.length = 0;
  const { res, err } = await press();
  check("pressed for a member with no profile yet: the call is placed", res.code === 200 && res.body?.success === true && res.body?.call_sid === "CA_test_dashboard", { code: res.code, body: res.body, err: err?.message });
  check("one dial, to their number", dials.length === 1 && dials[0].to === "+14150110142", dials);
  const placed = gate.find((p) => p.includes("place_call"));
  check("the call gate authorized it as an inferred auto_intake (the button passes no kind)", !!placed && placed.includes("inferred auto_intake"), gate.map((p) => p.filter((x: any) => typeof x === "string" && x.length < 40)));
}
{
  // The same gate still says no when there's nothing to authorize: a member whose intake already happened.
  dials.length = 0; gate.length = 0;
  member.realCall = true;
  const { res } = await press();
  check("a member whose intake call already happened: nothing authorizes it, no dial", res.code !== 200 && dials.length === 0, { code: res.code, body: res.body });
  member.realCall = false;
}

// Nothing here ran the jobs: the button path never reaches jobs/index.ts.
const phone = fs.readFileSync(new URL("../../../co-test/src/routes/phone.ts", import.meta.url), "utf8");
check("the button calls triggerCallForUser with no kind, and the route never imports the jobs", /triggerCallForUser\(String\(req\.params\.user_id\), null\)/.test(phone) && !/jobs\/index/.test(phone));

console.error = quietErr;
globalThis.Date = RealDate;
console.log(`\ndashboard intake call: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
