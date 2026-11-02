// No member call reaches ElevenLabs (Royce, 2026-11-02: ElevenLabs is no longer in use). Every call entry point, driven for real:
//   inbound to the main number (/co/incoming-call), inbound to the trial number (/co/gpt-live/incoming-call), and every outbound
//   call (a "call me" from the app, a "call me" text, a scheduled call, a check-in call, an intake call: all through
//   triggerCallForUser, whose one dial points Twilio at /co/el/outbound-twiml), each with GPT-Live open, its minutes used, and OpenAI
//   unavailable. ElevenLabs' register-call and outbound-call are spied, and every fetch to elevenlabs.io is counted: none may happen.
//   The old ElevenLabs answers stay in routes/co.ts for the deletion PR, uncalled.
// Layer 1: OpenAI, Twilio, ElevenLabs and the database are fakes; no network, no tokens. Invented members (Jordan, Noor).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/noElevenLabsCalls.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ELEVENLABS_TOOL_SECRET ||= "dummy-tool-secret";
process.env.TWILIO_ACCOUNT_SID ||= "SKtest";
process.env.TWILIO_CLIENT_SECRET ||= "test";
process.env.TWILIO_LIVE_SID ||= "ACtest";
process.env.TWILIO_AUTH = "dummy-twilio-auth";
process.env.API_URL = "https://cue.example.test";
process.env.TWILIO_PHONE_NUMBER = "+15550009999";
// Set, so an ElevenLabs registration would go ahead if anything reached it (the spy below would then see it).
process.env.ELEVENLABS_AGENT_ID = "agent-x";
process.env.ALLOW_UNVERIFIED_INBOUND_CALLERS = "false";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import twilio from "twilio";

const G = await import("../../src/services/gptLive.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const T = await import("../../src/services/callTrigger.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };

// ---------------------------------------------------------------- the spies: ElevenLabs' call APIs and any request to elevenlabs.io
const el: string[] = [];
const tw = E.elevenLabs().conversationalAi.twilio as any;
const realRegister = tw.registerCall, realOutbound = tw.outboundCall;
tw.registerCall = async () => { el.push("registerCall"); return "<Response/>"; };
tw.outboundCall = async () => { el.push("outboundCall"); return { success: true }; };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (/elevenlabs\.io/i.test(url)) { el.push(`fetch ${url}`); return new Response("{}", { status: 200 }); }
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------- the database: Jordan on the team, Noor not; all evidence present
const people: Record<string, { name: string; phone: string; team: boolean }> = { "u-jordan": { name: "Jordan", phone: "+15550000001", team: true }, "u-noor": { name: "Noor", phone: "+15550000002", team: false } };
const byPhone = (n: unknown) => Object.entries(people).find(([, p]) => p.phone === n)?.[0];
let loggedSecs = 0;
const links = new Map<string, string>();
const realQuery = pool.query.bind(pool), realConnect = (pool as any).connect;
(pool as any).query = async (sql: string, params: any[] = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  const p = people[params[0]];
  if (/FROM users WHERE phone_number/.test(q)) { const id = byPhone(params[0]); return { rows: id ? [{ id, invite_verified: true, identity_captured: true, archived_at: null }] : [] }; }
  if (/SELECT u\.first_name, u\.phone_number/.test(q)) return { rows: p ? [{ first_name: p.name, phone_number: p.phone, subscription_status: "active", call_status: null, call_status_updated_at: null }] : [] };
  if (/^WITH prev AS/.test(q)) return { rows: [{ prev_status: null, prev_at: null }] };
  if (/SELECT mo_approver FROM users/.test(q)) return { rows: [{ mo_approver: p?.team === true }] };
  if (/FROM gpt_live_minutes/.test(q)) return { rows: [{ s: String(loggedSecs) }] };
  if (/SELECT first_name(, phone_number)? FROM users WHERE id/.test(q) || /SELECT id, first_name, phone_number FROM users WHERE id/.test(q)) return { rows: p ? [{ id: params[0], first_name: p.name, phone_number: p.phone }] : [] };
  if (/FROM scheduled_calls/.test(q)) return { rows: [{ "?column?": 1 }] };
  if (/content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%'/.test(q) || /action ILIKE '%place_call%'/.test(q)) return { rows: [{ "?column?": 1 }] };
  if (/sms_opted_out/.test(q)) return { rows: [{ sms_opted_out: false, identity_captured: true, city: null, checkin_call_cadence_days: 7, has_real_profile: false, had_real_call: false }] };
  if (/COUNT\(\*\)::int AS n, MAX\(created_at\) AS at FROM harness_decisions/.test(q)) return { rows: [{ n: 0, at: null }] };
  if (/INSERT INTO call_links/.test(q)) { links.set(params[0], params[1]); return { rows: [] }; }
  if (/DELETE FROM call_links WHERE id_hash = \$1 RETURNING/.test(q)) { const u = links.get(params[0]); links.delete(params[0]); return { rows: u ? [{ user_id: u, live: true }] : [] }; }
  if (/INSERT INTO co_memories/.test(q)) return { rows: [{ id: "m1" }] };
  return { rows: [] };
};
(pool as any).connect = async () => ({ query: (pool as any).query, release() {} });

const { createCoRouter } = await import("../../src/routes/co.js");
const { issueCallLink } = await import("../../src/services/callLink.js");
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use("/co", createCoRouter(null as any));
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const post = async (path: string, body: Record<string, string>) => {
  const sig = twilio.getExpectedTwilioSignature("dummy-twilio-auth", `${process.env.API_URL}${path}`, body);
  const r = await realFetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(body) });
  return { status: r.status, text: await r.text() };
};
const isLive = (t: string) => /<Stream url="wss:\/\/cue\.example\.test\/co\/gpt-live\/stream">/.test(t);
const { CANT_CONNECT_LINE } = E;
// The three ways GPT-Live can stand: open, the month's minutes used, OpenAI unavailable (no key).
const states = ["open", "minutes used", "no OpenAI key"] as const;
const inState = async <R>(s: (typeof states)[number], f: () => Promise<R>): Promise<R> => {
  G.openSessions.clear();
  loggedSecs = s === "minutes used" ? G.GPT_LIVE.monthlyMinutes * 60 : 0;
  const key = process.env.OPENAI_API_KEY;
  if (s === "no OpenAI key") delete process.env.OPENAI_API_KEY;
  try { return await f(); } finally { process.env.OPENAI_API_KEY = key; loggedSecs = 0; G.openSessions.clear(); }
};
const expectFor = (s: (typeof states)[number], t: string, direction: "inbound" | "outbound") =>
  s === "open" ? isLive(t) : s === "minutes used" && direction === "inbound" ? /<Reject reason="busy"\/>/.test(t) : t.includes(CANT_CONNECT_LINE) && /<Hangup\/>/.test(t) && !isLive(t);

// ---------------------------------------------------------------- inbound: the main number and the trial number
for (const [route, label] of [["/co/incoming-call", "main number"], ["/co/gpt-live/incoming-call", "trial number"]] as const) {
  for (const who of ["u-jordan", "u-noor"]) {
    for (const s of states) {
      el.length = 0;
      const r = await inState(s, () => post(route, { From: people[who].phone, To: "+15550009999", CallSid: `CA-${route}-${who}-${s}`, StirVerstat: "TN-Validation-Passed-A" }));
      check(`inbound, ${label}, ${people[who].team ? "team" : "member"}, GPT-Live ${s}: GPT-Live's answer, and nothing reaches ElevenLabs`, r.status === 200 && expectFor(s, r.text, "inbound") && !/elevenlabs/i.test(r.text) && el.length === 0, { r, el });
    }
  }
  el.length = 0;
  const unknown = await post(route, { From: "+15550007777", To: "+15550009999", CallSid: "CA-unknown", StirVerstat: "TN-Validation-Passed-A" });
  check(`inbound, ${label}, an unknown number: declined, nothing reaches ElevenLabs`, /we don't recognize this number/.test(unknown.text) && el.length === 0);
  const unverified = await post(route, { From: people["u-noor"].phone, To: "+15550009999", CallSid: "CA-unverified", StirVerstat: "TN-Validation-Failed" });
  check(`inbound, ${label}, a member's number not carrier-verified: declined, nothing reaches ElevenLabs`, /we don't recognize this number/.test(unverified.text) && el.length === 0);
}

// ---------------------------------------------------------------- outbound: every kind of call Cue places, then their answer
const dials: any[] = [];
T.setDialForTests(async (opts: any) => { dials.push(opts); return { sid: `CA-out-${dials.length}` }; });
T.setPreflightForTests(async () => ({ ok: true }));
const kinds = [
  ["user_initiated", "a \"call me\" from the app or the co-test phone page"],
  ["router_decision", "a \"call me\" text"],
  ["scheduled_call", "a scheduled call"],
  ["checkin_cadence", "a check-in call"],
  ["auto_intake", "an intake call"],
] as const;
for (const [kind, label] of kinds) {
  dials.length = 0; el.length = 0;
  const r: any = await T.triggerCallForUser("u-noor", null, { kind, ...(kind === "scheduled_call" ? { scheduledCallId: "s1" } : {}) } as any);
  const d = dials[0];
  // A call Cue starts itself can be held by the gate (local hours, a reason from their life): then nothing is dialed at all. Every dial
  // that does go out points Twilio at the GPT-Live answer.
  const ok = r?.success === true ? dials.length === 1 && /^https:\/\/cue\.example\.test\/co\/el\/outbound-twiml\?c=[^&]+$/.test(d.url) : dials.length === 0;
  check(`outbound, ${label} (${kind}): ${r?.success ? "dialed to the GPT-Live answer" : `held by the gate (${r?.error})`}, nothing reaches ElevenLabs`, ok && el.length === 0, { r, d, el });
  if (kind === "user_initiated" || kind === "router_decision" || kind === "scheduled_call") check(`...a call they asked for (${kind}) is dialed`, r?.success === true, r);
}
// Preflight refusing: nothing dialed at all (and so nothing for ElevenLabs).
for (const p of [{ ok: false, kind: "budget", why: "minutes_used" }, { ok: false, kind: "unavailable", failClass: "quota", status: null }] as const) {
  dials.length = 0; el.length = 0;
  T.setPreflightForTests(async () => p as any);
  const r: any = await T.triggerCallForUser("u-noor", null, { kind: "user_initiated" });
  check(`outbound, GPT-Live ${p.kind}: not dialed, never handed to ElevenLabs`, r?.success === false && dials.length === 0 && el.length === 0, { r, el });
}
T.setPreflightForTests(null);
T.setDialForTests(null);
// They pick up: Twilio fetches /co/el/outbound-twiml (the only TwiML any dial uses).
for (const who of ["u-jordan", "u-noor"]) {
  for (const s of states) {
    el.length = 0;
    const r = await inState(s, async () => {
      const c = await issueCallLink(who);
      return post(`/co/el/outbound-twiml?c=${encodeURIComponent(c)}`, { CallSid: `CA-ans-${who}-${s}`, From: "+15550009999", To: people[who].phone, Direction: "outbound-api" });
    });
    check(`outbound answered, ${people[who].team ? "team" : "member"}, GPT-Live ${s}: GPT-Live's answer or the can't-connect line, nothing reaches ElevenLabs`, r.status === 200 && expectFor(s, r.text, "outbound") && el.length === 0, { r, el });
  }
}

// ---------------------------------------------------------------- the code: one dial, one TwiML, the old answers uncalled
{
  const all = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const co = src("routes/co.ts"), trigger = src("services/callTrigger.ts");
  check("Twilio's calls.create is used only by callTrigger.ts (the one way any call is placed)", all.filter((f) => /\.calls\.create\(/.test(src(f))).join() === "services/callTrigger.ts", all.filter((f) => /\.calls\.create\(/.test(src(f))));
  check("...which dials once, always to /co/el/outbound-twiml", (trigger.match(/await dial\(\{/g) ?? []).length === 1 && (trigger.match(/url: `\$\{process\.env\.API_URL\}\/co\/el\/outbound-twiml\?c=/g) ?? []).length === 1);
  const callers = all.filter((f) => /\btriggerCallForUser\(/.test(src(f)) && f !== "services/callTrigger.ts").sort();
  check("every caller of triggerCallForUser is a known entry point (call-me route, texts, scheduled, check-in, intake)", JSON.stringify(callers) === JSON.stringify(["jobs/index.ts", "jobs/proactiveCheckinCall.ts", "jobs/scheduledCall.ts", "routes/co.ts", "routes/sendblue.ts"]), callers);
  check("the co-test phone page's call button goes through it too", /triggerCallForUser\(/.test(fs.readFileSync(new URL("../../../co-test/src/routes/phone.ts", import.meta.url), "utf8")));
  check("registerElevenLabsCall is called only inside the two old answers, and those are never called (only void-referenced)", (co.match(/registerElevenLabsCall\(\{/g) ?? []).length === 2 && (co.match(/\belevenLabsInboundTwiml\(/g) ?? []).length === 1 && (co.match(/\belevenLabsOutboundTwiml\(/g) ?? []).length === 1 && /void elevenLabsInboundTwiml;/.test(co) && /void elevenLabsOutboundTwiml;/.test(co));
  check("no other file calls registerElevenLabsCall or ElevenLabs' outbound call", all.filter((f) => f !== "services/elevenLabsCalls.ts" && f !== "routes/co.ts").every((f) => !/registerElevenLabsCall\(|\.outboundCall\(|\.registerCall\(/.test(src(f))));
}

server.close();
tw.registerCall = realRegister; tw.outboundCall = realOutbound;
globalThis.fetch = realFetch;
(pool as any).query = realQuery; (pool as any).connect = realConnect;
G.openSessions.clear();
console.log(`no ElevenLabs on any call: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
