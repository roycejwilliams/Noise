// GPT-Live for Cue's own calls to the team (services/callTrigger.ts, routes/co.ts /co/el/outbound-twiml, services/gptLive.ts): the
// check before dialing, the dial itself left as it was, the TwiML when they answer, a call that reached voicemail or nobody, the
// silence cap, and two calls at once keeping to their own member. Everyone who isn't on the team: ElevenLabs, byte for byte.
// Layer 1: OpenAI, Twilio, ElevenLabs and the database are fakes; no network, no tokens. Invented members (Jordan, Noor).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveOutbound.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ELEVENLABS_TOOL_SECRET ||= "dummy-tool-secret";
process.env.TWILIO_ACCOUNT_SID ||= "SKtest";
process.env.TWILIO_CLIENT_SECRET ||= "test";
process.env.TWILIO_LIVE_SID ||= "ACtest";
process.env.TWILIO_AUTH = "dummy-twilio-auth";
process.env.API_URL = "https://cue.example.test";
process.env.TWILIO_PHONE_NUMBER = "+15550009999";
process.env.ELEVENLABS_AGENT_ID = "agent-x";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import twilio from "twilio";

const G = await import("../../src/services/gptLive.js");
const B = await import("../../src/services/gptLiveBridge.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const T = await import("../../src/services/callTrigger.js");
const R = await import("../../src/services/callReasons.js");
const KA = await import("../../src/services/modelKeyAlert.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");

// The database: Jordan is on the team, Noor isn't. Every write and every query is kept.
const people: Record<string, { name: string; phone: string; team: boolean }> = { "u-jordan": { name: "Jordan", phone: "+15550000001", team: true }, "u-noor": { name: "Noor", phone: "+15550000002", team: false } };
let loggedSecs = 0, recentRefusal: string | null = null;
const links = new Map<string, string>(); // call_links, by hash
const sqls: { sql: string; params: any[] }[] = [];
const decided = (decision: string, action?: string) => sqls.filter((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === decision && (action === undefined || w.params[4] === action));
const realQuery = pool.query.bind(pool);
(pool as any).query = async (sql: string, params: any[] = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  sqls.push({ sql: q, params });
  const p = people[params[0]];
  if (/SELECT u\.first_name, u\.phone_number/.test(q)) return { rows: p ? [{ first_name: p.name, phone_number: p.phone, subscription_status: "active", call_status: null, call_status_updated_at: null }] : [] };
  if (/^WITH prev AS/.test(q)) return { rows: [{ prev_status: null, prev_at: null }] };
  if (/SELECT mo_approver FROM users/.test(q)) return { rows: [{ mo_approver: p?.team === true }] };
  if (/FROM gpt_live_minutes/.test(q)) return { rows: [{ s: String(loggedSecs) }] };
  if (/decision = 'call\.gpt_live_unavailable'/.test(q)) return { rows: recentRefusal ? [{ action: recentRefusal }] : [] };
  if (/SELECT first_name(, phone_number)? FROM users WHERE id/.test(q) || /SELECT id, first_name, phone_number FROM users WHERE id/.test(q)) return { rows: p ? [{ id: params[0], first_name: p.name, phone_number: p.phone }] : [] };
  if (/content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%'/.test(q) || /action ILIKE '%place_call%'/.test(q)) return { rows: [{ "?column?": 1 }] };
  if (/sms_opted_out/.test(q)) return { rows: [{ sms_opted_out: false, identity_captured: true, city: null, checkin_call_cadence_days: null, has_real_profile: true, had_real_call: true }] };
  if (/INSERT INTO call_links/.test(q)) { links.set(params[0], params[1]); return { rows: [] }; }
  if (/DELETE FROM call_links WHERE id_hash = \$1 RETURNING/.test(q)) { const u = links.get(params[0]); links.delete(params[0]); return { rows: u ? [{ user_id: u, live: true }] : [] }; }
  // A missed-call text already waiting: the gate decides (and is logged) without sending anything, so no test reaches Sendblue.
  if (/FROM pending_call_followups WHERE user_id = \$1 AND sent_at IS NULL/.test(q)) return { rows: [{ "?column?": 1 }] };
  if (/INSERT INTO voicemail_calls/.test(q)) return { rows: [{ call_sid: params[0] }] };
  if (/INSERT INTO co_memories/.test(q)) return { rows: [{ id: "m1" }] };
  return { rows: [] };
};
(pool as any).connect = async () => ({ query: (pool as any).query, release() {} });
const reset = () => { sqls.length = 0; G.openSessions.clear(); loggedSecs = 0; recentRefusal = null; };

// ---------------------------------------------------------------- 1. the check before dialing (services/gptLive.ts outboundPreflight)
{
  const env = { OPENAI_API_KEY: "sk-test", API_URL: "https://cue.example.test" } as NodeJS.ProcessEnv;
  let fetched = 0;
  const ok = (async () => { fetched++; return new Response("{}", { status: 200 }); }) as any;
  const team = async () => true, notTeam = async () => false;
  reset();
  check("not on the team: no check at all (null), OpenAI never asked", (await G.outboundPreflight("u-noor", { team: notTeam, env, fetch: ok })) === null && fetched === 0);
  check("on the team, all clear: ok (the model read is free: GET /v1/models/gpt-live-1)", (await G.outboundPreflight("u-jordan", { team, env, fetch: ok }))?.ok === true && fetched === 1);
  check("no OpenAI key: unavailable no_key, nothing fetched", JSON.stringify(await G.outboundPreflight("u-jordan", { team, env: { API_URL: env.API_URL } as any, fetch: ok })) === JSON.stringify({ ok: false, kind: "unavailable", failClass: "no_key", status: null }) && fetched === 1);
  loggedSecs = 300 * 60;
  check("the month's team minutes used: budget (held)", (await G.outboundPreflight("u-jordan", { team, env, fetch: ok }) as any)?.why === "minutes_used");
  loggedSecs = 0;
  const teamErr = await G.outboundPreflight("u-jordan", { team: async () => { throw new Error("db down"); }, env, fetch: ok }) as any;
  check("the team read fails at dial time: can't place the call now (team_unreadable), never quietly ElevenLabs", teamErr?.ok === false && teamErr.kind === "unavailable" && teamErr.failClass === "team_unreadable");
  check("minutes that can't be read: budget (fails closed)", (await G.outboundPreflight("u-jordan", { team, env, fetch: ok, db: { query: async () => { throw new Error("db down"); } } }) as any)?.why === "unreadable");
  recentRefusal = "quota";
  const q = await G.outboundPreflight("u-jordan", { team, env, fetch: ok }) as any;
  check("OpenAI refused a session for balance in the last 15 minutes: unavailable quota, not dialed", q?.kind === "unavailable" && q.failClass === "quota" && fetched === 1, q);
  recentRefusal = null;
  const a = await G.outboundPreflight("u-jordan", { team, env, fetch: (async () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 })) as any }) as any;
  check("OpenAI refuses the key: unavailable auth with its status", a?.failClass === "auth" && a.status === 401, a);
  const c = await G.outboundPreflight("u-jordan", { team, env, fetch: (async () => { throw new Error("getaddrinfo ENOTFOUND api.openai.com"); }) as any }) as any;
  check("OpenAI unreachable: unavailable connect", c?.failClass === "connect", c);
}

// ---------------------------------------------------------------- 2. the dial (services/callTrigger.ts)
const dials: any[] = [];
T.setDialForTests(async (opts: any) => { dials.push(opts); return { sid: `CA-${dials.length}` }; });
const alerts: string[] = [];
KA.setKeyAlertForTests(KA.createKeyAlert({ send: async (t) => (alerts.push(t), true) }));
{
  reset();
  T.setPreflightForTests(null);
  const r: any = await T.triggerCallForUser("u-noor", null, { kind: "router_decision" });
  const d = dials[0];
  check("not on the team: dialed exactly as today (ElevenLabs' TwiML route, our number, status callbacks, 20 s)", r?.success === true && dials.length === 1 && d.to === "+15550000002" && d.from === "+15550009999" && /^https:\/\/cue\.example\.test\/co\/el\/outbound-twiml\?c=[^&]+$/.test(d.url) && d.method === "POST" && d.statusCallback === "https://cue.example.test/co/call-status" && JSON.stringify(d.statusCallbackEvent) === JSON.stringify(["ringing", "answered", "completed"]) && d.statusCallbackMethod === "POST" && d.timeout === 20 && Object.keys(d).length === 8, d);
  check("...and nothing of GPT-Live: no minutes read, no GPT-Live rows", !sqls.some((w) => /gpt_live/.test(w.sql) || /^call\.gpt_live/.test(String(w.params?.[1]))));

  reset(); dials.length = 0;
  T.setPreflightForTests(async () => ({ ok: true }));
  const j: any = await T.triggerCallForUser("u-jordan", null, { kind: "router_decision" });
  check("on the team, check passed: the same dial (the TwiML route picks GPT-Live when they answer)", j?.success === true && dials.length === 1 && /\/co\/el\/outbound-twiml\?c=/.test(dials[0].url) && dials[0].to === "+15550000001");
  check("...plus Twilio's async answering-machine detection, waiting for the greeting to end, posted to us", dials[0].machineDetection === "DetectMessageEnd" && dials[0].asyncAmd === "true" && dials[0].asyncAmdStatusCallback === "https://cue.example.test/co/gpt-live/amd" && dials[0].asyncAmdStatusCallbackMethod === "POST", dials[0]);

  reset(); dials.length = 0;
  T.setPreflightForTests(async () => ({ ok: false, kind: "budget", why: "unreadable" }));
  const unreadable: any = await T.triggerCallForUser("u-jordan", null, { kind: "router_decision" });
  check("minutes unreadable: held with an accurate reason (couldn't be placed right now), never \"used up\"", unreadable?.error === R.GPT_LIVE_CANT_PLACE && R.callNotPlacedReason(unreadable.error) === "Cue couldn't place the call right now; the problem was on Cue's side." && !/used up/.test(R.callNotPlacedReason(unreadable.error)));
  reset(); dials.length = 0;
  T.setPreflightForTests(async () => ({ ok: false, kind: "budget", why: "minutes_used" }));
  const h: any = await T.triggerCallForUser("u-jordan", null, { kind: "router_decision" });
  check("on the team, the month's minutes used: not dialed, held", h?.success === false && dials.length === 0 && h.error === R.GPT_LIVE_MINUTES_USED, h);
  check("...logged call.gpt_live_budget_reached minutes_used (outbound), no dial claim taken", decided("call.gpt_live_budget_reached", "minutes_used").filter((w) => JSON.parse(w.params[5]).direction === "outbound").length === 1 && !sqls.some((w) => /^WITH prev AS/.test(w.sql)));
  check("...and the reply is told why in plain words", R.callNotPlacedReason(h.error) === "Cue's call minutes for this month are used up, so calls are held until the team raises the limit or the month turns." && R.parseDialFailure(h.error) === null);

  reset(); dials.length = 0;
  T.setPreflightForTests(async () => ({ ok: false, kind: "unavailable", failClass: "quota", status: null }));
  const u: any = await T.triggerCallForUser("u-jordan", null, { kind: "router_decision" });
  const dial = R.parseDialFailure(u?.error);
  check("on the team, OpenAI out of balance: not dialed; reported as a call that never started (set-up on Cue's side), on record", u?.success === false && u.dialFailed === true && dials.length === 0 && dial?.stage === "link" && dial.reported === true, u);
  check("...logged call.gpt_live_unavailable quota and call.dial dial_failed (the morning review's call_never_started)", decided("call.gpt_live_unavailable", "quota").length === 1 && decided("call.dial", "dial_failed").length === 1 && JSON.parse(decided("call.dial")[0].params[5]).code === "gpt_live_quota");
  check("...the reply's facts say it failed on Cue's side before their phone rang (the #302/#303 path, unchanged)", R.callNotPlacedFacts(u.error).some((f) => f.text.startsWith(R.FAILURE_FACT_PREFIX) && /before their phone rang/.test(f.text)));

  reset(); dials.length = 0; alerts.length = 0;
  T.setPreflightForTests(async () => ({ ok: false, kind: "unavailable", failClass: "auth", status: 401 }));
  const k: any = await T.triggerCallForUser("u-jordan", null, { kind: "router_decision" });
  await sleep(10);
  check("a refused OpenAI key: not dialed, a call that never started on Cue's side, and the dead-key text to the team", k?.success === false && dials.length === 0 && R.parseDialFailure(k.error)?.stage === "link" && decided("call.gpt_live_unavailable", "auth").length === 1 && alerts.length === 1 && alerts[0] === KA.KEY_DEAD_TEXT.openai, { k, alerts });
  T.setPreflightForTests(null);
  check("the team's call isn't given a written opening while it rings (GPT-Live opens in its own words)", /if \(!live\) prebuildOpening\(/.test(src("services/callTrigger.ts")));
}

// ---------------------------------------------------------------- 3. they answer (routes/co.ts /co/el/outbound-twiml)
{
  const { createCoRouter } = await import("../../src/routes/co.js");
  const { issueCallLink } = await import("../../src/services/callLink.js");
  const EL_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.us.elevenlabs.io/v1/convai/twilio?agent_id=agent-x&amp;conversation_signature=sig"/></Connect></Response>';
  const tw = E.elevenLabs().conversationalAi.twilio as any;
  const realRegister = tw.registerCall;
  const registered: any[] = [];
  tw.registerCall = async (args: any) => { registered.push(args); return EL_TWIML; };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/co", createCoRouter(null as any));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const answer = async (userId: string, sid: string) => {
    const c = await issueCallLink(userId);
    const path = `/co/el/outbound-twiml?c=${encodeURIComponent(c)}`;
    const body = { CallSid: sid, From: "+15550009999", To: people[userId].phone, Direction: "outbound-api" };
    const sig = twilio.getExpectedTwilioSignature("dummy-twilio-auth", `${process.env.API_URL}${path}`, body);
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(body) });
    return { status: r.status, text: await r.text() };
  };
  const streamId = (t: string) => /<Parameter name="s" value="([^"]+)"\/>/.exec(t)?.[1] ?? null;

  reset(); registered.length = 0;
  const noor = await answer("u-noor", "CA-noor");
  check("not on the team, answered: ElevenLabs' TwiML byte for byte, registered outbound from our number to theirs", noor.text === EL_TWIML && registered.length === 1 && registered[0].direction === "outbound" && registered[0].fromNumber === "+15550009999" && registered[0].toNumber === "+15550000002" && registered[0].conversationInitiationClientData.dynamicVariables.user_id === "u-noor", { noor, reg: registered[0] });
  check("...nothing of GPT-Live touched", !sqls.some((w) => /gpt_live/.test(w.sql)) && G.openSessions.size === 0);

  reset(); registered.length = 0;
  const jordan = await answer("u-jordan", "CA-jordan");
  const jc = G.takeLiveLink(streamId(jordan.text));
  check("on the team, answered: GPT-Live's stream with the <Connect> action, ElevenLabs never registered", /<Connect action="https:\/\/cue\.example\.test\/co\/gpt-live\/after-stream"><Stream url="wss:\/\/cue\.example\.test\/co\/gpt-live\/stream">/.test(jordan.text) && registered.length === 0 && !/u-jordan|Jordan|15550000001/.test(jordan.text), jordan);
  check("...the call is outbound in both prompts, told to wait through a voicemail greeting (no set message)", jc?.direction === "outbound" && jc.instructions.includes("This call: you called them") && jc.backendSystem.includes("This call is outbound") && jc.instructions.includes(G.VOICEMAIL_WAIT) && !jc.instructions.includes(E.voicemailLeft("Jordan")), jc?.instructions.slice(0, 400));
  check("...no call status written here (the dial set it)", !sqls.some((w) => /UPDATE users SET call_sid/.test(w.sql)));
  check("...opening logged as GPT-Live's own words, outbound", decided("call.opening", "outbound").some((w) => JSON.parse(w.params[5]).mode === "own_words"));

  reset(); registered.length = 0;
  loggedSecs = 300 * 60;
  const late = await answer("u-jordan", "CA-late");
  const { CANT_CONNECT_LINE } = await import("../../src/services/elevenLabsCalls.js");
  check("on the team, minutes gone between dial and answer: the can't-connect line, never ElevenLabs", late.text.includes(CANT_CONNECT_LINE) && /<Hangup\/>/.test(late.text) && registered.length === 0 && decided("call.gpt_live_budget_reached", "minutes_used").filter((w) => JSON.parse(w.params[5]).stage === "answered").length === 1, late);
  check("...and the dialed call's status is released (scoped to its sid)", sqls.some((w) => /SET call_status = 'failed'/.test(w.sql) && w.params[0] === "u-jordan" && w.params[1] === "CA-late"));
  loggedSecs = 0;

  // Two at once: each its own path and its own member.
  reset(); registered.length = 0;
  const [j2, n2] = await Promise.all([answer("u-jordan", "CA-j2"), answer("u-noor", "CA-n2")]);
  const jc2 = G.takeLiveLink(streamId(j2.text));
  check("at once: Jordan on GPT-Live with only his own name, Noor on ElevenLabs with nothing of his", jc2?.userId === "u-jordan" && !/Noor/.test(jc2.instructions + jc2.backendSystem) && n2.text === EL_TWIML && registered.length === 1 && !/Jordan|u-jordan/.test(JSON.stringify(registered[0])));
  server.close();
  tw.registerCall = realRegister;
  G.openSessions.clear();
}

// ---------------------------------------------------------------- 4. after the call: voicemail, nobody, or a conversation
{
  const { runGptLivePostCall } = await import("../../src/routes/co.js");
  const callOf = (direction: "inbound" | "outbound") => G.buildLiveCall({ userId: "u-jordan", callSid: "CA-vm", firstName: "Jordan", direction, team: true, voiceLayer: VOICE, contextSummary: "x", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  const result = (direction: "inbound" | "outbound", turns: { who: "member" | "cue"; text: string }[]) => ({ call: callOf(direction), sessionId: "live_vm", turns: turns.map((t, i) => ({ ...t, startMs: i * 1000, endMs: i * 1000 + 800 })), startedAt: new Date(), endedAt: new Date(), seconds: 30, reason: "caller hung up", endedBy: "caller_hangup" as const });
  reset();
  await runGptLivePostCall(result("outbound", [{ who: "cue", text: "Hey, I wanted to check in about yesterday." }, { who: "member", text: "You have reached the voicemail of Jordan. Please leave a message after the tone." }, { who: "cue", text: "Hey Jordan, it's Cue. Sorry I missed you. I'll send you a text." }]));
  await sleep(50);
  check("outbound to a voicemail: the ElevenLabs path's missed-call handling (claimed once, call.voicemail voicemail), not the conversation steps", sqls.some((w) => /INSERT INTO voicemail_calls/.test(w.sql) && w.params[0] === "CA-vm") && decided("call.voicemail", "voicemail").length === 1 && !sqls.some((w) => /INSERT INTO call_processing/.test(w.sql)));
  check("...the gated missed-call text is decided the same way (call.gate missed_call_followup:voicemail)", decided("call.gate", "missed_call_followup:voicemail").length === 1);
  reset();
  await runGptLivePostCall(result("outbound", [{ who: "cue", text: "Hey, how did the pitch go?" }]));
  await sleep(50);
  check("outbound, nobody spoke: missed as silent, as on ElevenLabs", decided("call.gate", "missed_call_followup:silent").length === 1 && !sqls.some((w) => /INSERT INTO call_processing/.test(w.sql)));
  reset();
  await runGptLivePostCall(result("inbound", [{ who: "cue", text: "Hey, what's up?" }]));
  await sleep(50);
  check("inbound with nobody speaking: never a missed call (goes through the conversation steps as before)", !sqls.some((w) => /INSERT INTO voicemail_calls/.test(w.sql)) && sqls.some((w) => /INSERT INTO call_processing/.test(w.sql)));
  reset();
  await runGptLivePostCall(result("outbound", [{ who: "cue", text: "Hey, how did the pitch go?" }, { who: "member", text: "It went really well, they want a second meeting next week." }]));
  await sleep(50);
  check("outbound, a real conversation: the conversation steps, no missed call", sqls.some((w) => /INSERT INTO call_processing/.test(w.sql)) && !sqls.some((w) => /INSERT INTO voicemail_calls/.test(w.sql)) && decided("call.voicemail").length === 0);
}

// ---------------------------------------------------------------- 4b. Twilio's machine verdict: GPT-Live leaves its message in its own words
{
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: any[] = [];
    send(d: unknown) { this.sent.push(JSON.parse(String(d))); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
    in(m: unknown) { this.emit("message", JSON.stringify(m)); }
  }
  const textEv = (t: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, { type: "content_block_stop", index: 0 }];
  const run = (callSid: string, o: { openWaitMs?: number; answer?: string; delayMs?: number } = {}) => {
    const tw = new FakeSocket(), ai = new FakeSocket(), records: any[] = [];
    const call = G.buildLiveCall({ userId: "u-jordan", callSid, firstName: "Jordan", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "x", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
    const id = G.issueLiveLink(call);
    B.setLiveDeps({ connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; }, apiKey: () => "sk-test", upstream: () => (async function* () { if (o.delayMs) await sleep(o.delayMs); for (const e of textEv(o.answer ?? "How did the pitch go?")) yield e as any; })(), record: (d) => records.push(d), postCall: async () => {}, minutes: () => {}, log: () => {}, now: Date.now, maxSessionMs: 60_000, startTimeoutMs: 60_000, heartbeatMs: 60_000, silenceEndMs: 60_000, endGraceMs: 40, openWaitMs: o.openWaitMs ?? 60_000, guardRows: async () => [] });
    B.handleGptLiveStream(tw as any);
    B.setLiveDeps(null);
    tw.in({ event: "start", streamSid: "MZ1", start: { customParameters: { s: id } } });
    return { tw, ai, records };
  };
  const vm = run("CA-amd");
  await sleep(5);
  vm.ai.in({ type: "session.started", session: { id: "live_amd" } });
  vm.ai.in({ type: "session.input_transcript.delta", delta: "You have reached the voicemail of Jordan. Please leave a message after the tone.", start_ms: 0, end_ms: 4000 });
  // Twilio's verdict, through the signed route.
  const { createCoRouter } = await import("../../src/routes/co.js");
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/co", createCoRouter(null as any));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const amd = async (body: Record<string, string>, signed = true) => {
    const sig = signed ? twilio.getExpectedTwilioSignature("dummy-twilio-auth", `${process.env.API_URL}/co/gpt-live/amd`, body) : "bogus";
    return (await fetch(`http://127.0.0.1:${port}/co/gpt-live/amd`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(body) })).status;
  };
  check("an unsigned machine verdict is refused", (await amd({ CallSid: "CA-amd", AnsweredBy: "machine_end_beep" }, false)) === 401 && vm.ai.sent.filter((m) => m.event_id === "voicemail").length === 0);
  check("a signed one is taken", (await amd({ CallSid: "CA-amd", AnsweredBy: "machine_end_beep" })) === 204 && G.answeredByFor("CA-amd") === "machine_end_beep");
  const told = vm.ai.sent.find((m) => m.event_id === "voicemail");
  check("the voicemail instruction limits what's said (someone else may hear it): first name, that it's Cue, sorry, a text coming; never why or anything about them", /someone else may hear it/.test(G.VOICEMAIL_NOW) && /saying only this: their first name, that it's Cue, that you're sorry you missed them, and that you'll text them/.test(G.VOICEMAIL_NOW) && /Never say why you called, and nothing about them or their life/.test(G.VOICEMAIL_NOW));
  check("machine, greeting over: GPT-Live is told to leave a short message in its own words (no set line), once", told?.type === "session.instructions.append" && told.content === G.VOICEMAIL_NOW && !/it's Cue\./.test(G.VOICEMAIL_NOW) && vm.records.some((r) => r.decision === "call.gpt_live_amd" && r.action === "leave_message"));
  vm.ai.in({ type: "session.output_transcript.delta", delta: "Hi Jordan, sorry I missed you. I'll text you in a bit.", start_ms: 5000, end_ms: 8000 });
  await sleep(20);
  check("...not ended while the message is still being said", vm.ai.sent.filter((m) => m.type === "session.close").length === 0);
  await sleep(80);
  check("...then, once it's said, the call ends (as the ElevenLabs voicemail tool ends it)", vm.ai.sent.filter((m) => m.type === "session.close").length === 1);
  vm.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 12 } });
  check("...recorded as ended by voicemail", vm.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "voicemail");

  const person = run("CA-person");
  await sleep(5);
  person.ai.in({ type: "session.started", session: { id: "live_person" } });
  person.ai.in({ type: "session.input_transcript.delta", delta: "Hello? Oh hey, yeah I can talk.", start_ms: 0, end_ms: 2000 });
  G.noteAnsweredBy("CA-person", "machine_end_other");
  check("a machine verdict after a person really spoke is a misfire: logged, ignored, no message", !person.ai.sent.some((m) => m.event_id === "voicemail") && person.records.some((r) => r.decision === "call.gpt_live_amd" && r.action === "misfire"));
  G.noteAnsweredBy("CA-human", "human");
  const human = run("CA-human");
  await sleep(5);
  human.ai.in({ type: "session.started", session: { id: "live_human" } });
  check("a human verdict does nothing", !human.ai.sent.some((m) => m.event_id === "voicemail"));
  for (const b of [person, human]) b.tw.close();
  server.close();

  // After the call: Twilio's verdict makes it a voicemail even with no greeting in the transcript, and the note is what Cue said.
  const { runGptLivePostCall } = await import("../../src/routes/co.js");
  reset();
  const call = G.buildLiveCall({ userId: "u-jordan", callSid: "CA-amd", firstName: "Jordan", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "x", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  await runGptLivePostCall({ call, sessionId: "live_amd", turns: [{ who: "cue", text: "Hey, how did the pitch go?", startMs: 0, endMs: 2000 }, { who: "cue", text: "Hi Jordan, sorry I missed you. I'll text you in a bit.", startMs: 5000, endMs: 8000 }], startedAt: new Date(), endedAt: new Date(), seconds: 12, reason: "voicemail", endedBy: "voicemail", voicemail: { fromMs: 4500 } });
  await sleep(50);
  check("post-call: Twilio's machine verdict is the voicemail verdict (missed call, gated text)", decided("call.voicemail", "voicemail").length === 1 && decided("call.gate", "missed_call_followup:voicemail").length === 1);
  check("...and the note is the message Cue actually left, in its words, not the ElevenLabs set line", sqls.some((w) => /INSERT INTO co_memories/.test(w.sql) && w.params.some((p: any) => typeof p === "string" && p === 'Cue left this voicemail: "Hi Jordan, sorry I missed you. I\'ll text you in a bit."')) && !sqls.some((w) => w.params.some((p: any) => typeof p === "string" && p.includes(E.voicemailLeft("Jordan")))));
  reset();
  await runGptLivePostCall({ call, sessionId: "live_nomsg", turns: [{ who: "member", text: "You have reached the voicemail of Jordan. Please leave a message after the tone.", startMs: 0, endMs: 3000 }], startedAt: new Date(), endedAt: new Date(), seconds: 8, reason: "caller hung up", endedBy: "caller_hangup", voicemail: null });
  await sleep(50);
  check("a voicemail reached without the message being asked for: noted as reached, no message left (never a claimed message)", sqls.some((w) => /INSERT INTO co_memories/.test(w.sql) && w.params.some((p: any) => p === "Cue reached Jordan's voicemail and left no message.")) && !sqls.some((w) => w.params.some((p: any) => typeof p === "string" && p.startsWith("Cue left this voicemail"))));

  // Privacy: once the voicemail is recording, no thinking answer is ever spoken, pending or new (review of #333).
  const pend = run("CA-pend", { answer: "Your pitch to the second fund was Thursday, how did it go?", delayMs: 40 });
  await sleep(5);
  pend.ai.in({ type: "session.started", session: { id: "live_pend" } });
  pend.ai.in({ type: "session.input_transcript.delta", delta: "You have reached the voicemail of Jordan.", start_ms: 0, end_ms: 3000 });
  pend.ai.in({ type: "session.delegation.created", offset_ms: 3100, delegation: { id: "p1", target: "client" } });
  await sleep(5);
  G.noteAnsweredBy("CA-pend", "machine_end_beep");
  await sleep(80);
  pend.ai.in({ type: "session.delegation.created", offset_ms: 9000, delegation: { id: "p2", target: "client" } });
  await sleep(550); // the delegation waits up to catchUpMs (400) for the transcript to reach its offset
  check("voicemail: a thinking answer pending when it began, and one asked for after, are never sent to GPT-Live", pend.ai.sent.some((m) => m.event_id === "voicemail") && !pend.ai.sent.some((m) => m.event_id === "answer_p1" || m.event_id === "answer_p2") && !JSON.stringify(pend.ai.sent).includes("second fund"));
  check("...and each is logged as dropped", pend.records.filter((r) => r.decision === "call.gpt_live_answer_dropped" && r.action === "voicemail").length === 2, pend.records.map((r) => r.decision + ":" + r.action));
  pend.tw.close();

  // Outbound opening (review of #333): never at session start; on their first words, AMD's human verdict, or after the wait.
  const outStart: any = G.sessionStart(G.buildLiveCall({ userId: "u-jordan", callSid: "CA-x", firstName: "Jordan", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "x", rightNow: "", findsNow: "", callReason: "", timeOfDay: null }), "sage");
  const inStart: any = G.sessionStart(G.buildLiveCall({ userId: "u-jordan", callSid: "CA-y", firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: "x", rightNow: "", findsNow: "", callReason: "", timeOfDay: null }), "sage");
  check("outbound: nothing asks GPT-Live to open at session start, and it's told to open when they answer; inbound unchanged", !("input" in outStart.session) && outStart.session.instructions.includes(G.OPEN_WHEN_THEY_ANSWER) && !outStart.session.instructions.includes(G.OPEN_IN_OWN_WORDS) && inStart.session.input[0].content[0].text === `${G.OPEN_NOW} ${G.OPEN_NO_STOCK}` && inStart.session.instructions.includes(G.OPEN_IN_OWN_WORDS));
  const words = run("CA-words", { openWaitMs: 60 });
  await sleep(5);
  words.ai.in({ type: "session.started", session: { id: "live_words" } });
  words.ai.in({ type: "session.input_transcript.delta", delta: "Hello?", start_ms: 0, end_ms: 600 });
  await sleep(100);
  check("outbound: they say \"Hello?\" first: GPT-Live answers them, no open instruction sent (even after the wait)", !words.ai.sent.some((m) => m.event_id === "open") && words.records.some((r) => r.decision === "call.gpt_live_open" && r.action === "their_first_words"));
  words.tw.close();
  const hum2 = run("CA-hum2", { openWaitMs: 60_000 });
  await sleep(5);
  hum2.ai.in({ type: "session.started", session: { id: "live_hum2" } });
  check("outbound: nothing sent before they speak or AMD answers", !hum2.ai.sent.some((m) => m.event_id === "open"));
  G.noteAnsweredBy("CA-hum2", "human");
  check("outbound: AMD says a human answered: GPT-Live is told to open now", hum2.ai.sent.filter((m) => m.event_id === "open").length === 1 && hum2.ai.sent.find((m) => m.event_id === "open").content === `${G.OPEN_NOW} ${G.OPEN_NO_STOCK}` && hum2.ai.sent.find((m) => m.event_id === "open").type === "session.thinking.append");
  hum2.tw.close();
  const quiet = run("CA-quiet2", { openWaitMs: 40 });
  await sleep(5);
  quiet.ai.in({ type: "session.started", session: { id: "live_quiet2" } });
  await sleep(80);
  check("outbound: nothing heard and no verdict within the wait: GPT-Live opens anyway", quiet.ai.sent.filter((m) => m.event_id === "open").length === 1 && quiet.records.some((r) => r.decision === "call.gpt_live_open" && r.action === "no_words_in_time"));
  quiet.tw.close();
}

// ---------------------------------------------------------------- 5. the silence cap (as the ElevenLabs agent's silence_end_call_timeout)
{
  check("silence cap is the ElevenLabs agent's own 120 s", G.GPT_LIVE.silenceEndMs === E.AGENT_DEFAULTS.silenceEndCallSecs * 1000 && E.AGENT_DEFAULTS.silenceEndCallSecs === 120);
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: any[] = [];
    send(d: unknown) { this.sent.push(JSON.parse(String(d))); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
    in(m: unknown) { this.emit("message", JSON.stringify(m)); }
  }
  const tw = new FakeSocket(), ai = new FakeSocket();
  const records: any[] = [];
  const call = G.buildLiveCall({ userId: "u-jordan", callSid: "CA-quiet", firstName: "Jordan", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "x", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  const id = G.issueLiveLink(call);
  B.setLiveDeps({ connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; }, apiKey: () => "sk-test", upstream: () => (async function* () {})(), record: (d) => records.push(d), postCall: async () => {}, minutes: () => {}, log: () => {}, now: Date.now, maxSessionMs: 60_000, startTimeoutMs: 60_000, heartbeatMs: 60_000, silenceEndMs: 60 });
  B.handleGptLiveStream(tw as any);
  B.setLiveDeps(null);
  tw.in({ event: "start", streamSid: "MZ1", start: { customParameters: { s: id } } });
  await sleep(5);
  ai.in({ type: "session.started", session: { id: "live_quiet" } });
  ai.in({ type: "session.output_transcript.delta", delta: "Hey Jordan, it's Cue. Sorry I missed you. I'll send you a text.", start_ms: 0, end_ms: 3000 });
  await sleep(30);
  check("a line still talking isn't cut", ai.sent.filter((m) => m.type === "session.close").length === 0);
  await sleep(120);
  check("nothing said either way past the cap: the session is closed", ai.sent.filter((m) => m.type === "session.close").length === 1);
  ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 125 } });
  check("...recorded as ended by silence", records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "silence");
  G.takeCallState("CA-quiet");
}

KA.setKeyAlertForTests(null);
T.setDialForTests(null);
(pool as any).query = realQuery;
console.log(`gpt-live outbound: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
