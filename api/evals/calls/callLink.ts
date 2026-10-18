// One-time call links (services/callLink.ts, 2026-10-18): the outbound call's
// TwiML URL carries an opaque call id, never the member's user id or a call
// token (Twilio keeps the URL in its request logs). Twilio, ElevenLabs and the
// database are all stubbed: no real call, no tokens, nothing sent.
//   npx tsx evals/calls/callLink.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ELEVENLABS_TOOL_SECRET = "dummy-tool-secret";
process.env.ELEVENLABS_AGENT_ID = "dummy-agent";
process.env.TWILIO_AUTH = "dummy-twilio-auth";
process.env.TWILIO_PHONE_NUMBER = "+15550000000";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import twilio from "twilio";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};

const L = await import("../../src/services/callLink.js");
const { default: pool } = await import("../../src/db/db.js");

const ALICE = "11111111-2222-4333-8444-555555555555";
const BOB = "99999999-8888-4777-8666-555555555555";
const TOKEN_SHAPE = /\d{10}\.[0-9a-f]{64}/;

// An in-memory store with the same contract as the pg one.
function memStore() {
  const rows = new Map<string, { userId: string; expiresAt: Date }>();
  const store: import("../../src/services/callLink.js").CallLinkStore = {
    async put(hash, userId, expiresAt) { rows.set(hash, { userId, expiresAt }); },
    async take(hash, now) { const r = rows.get(hash); if (!r) return null; rows.delete(hash); return { userId: r.userId, live: r.expiresAt > now }; },
    async drop(hash) { rows.delete(hash); },
  };
  return { rows, store };
}

// ---- the link itself
{
  const { rows, store } = memStore();
  const t0 = new Date("2026-10-18T17:00:00Z");
  const id = await L.issueCallLink(ALICE, store, t0);
  check("the id is 43 url-safe characters (32 random bytes)", /^[A-Za-z0-9_-]{43}$/.test(id), id);
  check("the id has nothing of the member in it", !id.includes(ALICE) && !id.includes(ALICE.replace(/-/g, "")));
  check("only the id's hash is stored, never the id", rows.size === 1 && !rows.has(id) && rows.has(L.callLinkHash(id)));
  check("it lasts the call token's 2 hours", (rows.get(L.callLinkHash(id))?.expiresAt.getTime() ?? 0) - t0.getTime() === 2 * 3600 * 1000 && L.CALL_LINK_TTL_SECS === 7200);
  check("taken once: it gives the member", (await L.takeCallLink(id, store, new Date(t0.getTime() + 20_000))) === ALICE);
  check("taken again: nothing (single use)", (await L.takeCallLink(id, store, new Date(t0.getTime() + 21_000))) === null);
  check("...and the row is gone", rows.size === 0);

  const late = await L.issueCallLink(ALICE, store, t0);
  check("past 2 hours: refused", (await L.takeCallLink(late, store, new Date(t0.getTime() + 7200_000 + 1000))) === null);
  check("...and the expired row is gone too", rows.size === 0);
  const edge = await L.issueCallLink(ALICE, store, t0);
  check("just inside 2 hours: still good", (await L.takeCallLink(edge, store, new Date(t0.getTime() + 7200_000 - 1000))) === ALICE);

  check("an unknown id: refused", (await L.takeCallLink("A".repeat(43), store, t0)) === null);
  let touched = 0;
  const spy = { ...store, take: async (h: string, n: Date) => { touched++; return store.take(h, n); } };
  check("malformed, empty or missing ids: refused without a lookup", (await L.takeCallLink("short", spy, t0)) === null && (await L.takeCallLink("", spy, t0)) === null && (await L.takeCallLink(null, spy, t0)) === null && (await L.takeCallLink(ALICE, spy, t0)) === null && touched === 0);

  const a = await L.issueCallLink(ALICE, store, t0);
  const b = await L.issueCallLink(BOB, store, t0);
  check("two members' links each resolve to their own member", a !== b && (await L.takeCallLink(b, store, t0)) === BOB && (await L.takeCallLink(a, store, t0)) === ALICE);
  const d = await L.issueCallLink(ALICE, store, t0);
  await L.dropCallLink(d, store);
  check("a dropped link is refused", (await L.takeCallLink(d, store, t0)) === null);
}

// Numbers: fictional, and outside the 555-01xx test range so the dial path runs (services/testNumbers.ts); Twilio is stubbed.
// ---- a stubbed database: call_links in memory, the member rows, everything else empty
const links = new Map<string, { user_id: string; expires_at: Date }>();
const users: Record<string, any> = {
  [ALICE]: { id: ALICE, first_name: "Jordan", phone_number: "+14155550201", subscription_status: "active", call_status: null, call_status_updated_at: null, sms_opted_out: false, identity_captured: true, has_real_profile: true, had_real_call: true },
  [BOB]: { id: BOB, first_name: "Ellis", phone_number: "+14155550202", subscription_status: "active", call_status: null, call_status_updated_at: null, sms_opted_out: false, identity_captured: true, has_real_profile: true, had_real_call: true },
};
const sqlSeen: string[] = [];
(pool as any).query = async (sql: string, params: any[] = []) => {
  sqlSeen.push(sql);
  if (/INSERT INTO call_links/.test(sql)) { links.set(params[0], { user_id: params[1], expires_at: params[2] }); return { rows: [] }; }
  if (/DELETE FROM call_links WHERE expires_at < NOW\(\)/.test(sql)) { for (const [k, v] of links) if (v.expires_at < new Date()) links.delete(k); return { rows: [] }; }
  if (/DELETE FROM call_links WHERE id_hash = \$1 RETURNING/.test(sql)) { const r = links.get(params[0]); if (!r) return { rows: [] }; links.delete(params[0]); return { rows: [{ user_id: r.user_id, live: r.expires_at > params[1] }] }; }
  if (/DELETE FROM call_links WHERE id_hash = \$1/.test(sql)) { links.delete(params[0]); return { rows: [] }; }
  if (/FROM users/.test(sql) && typeof params[0] === "string" && users[params[0]]) return { rows: [users[params[0]]] };
  if (/WITH prev AS/.test(sql)) return { rows: [{ prev_status: null, prev_at: null }] };
  if (/INSERT INTO co_memories/.test(sql)) return { rows: [{ id: 1 }] };
  // A text from them a moment ago: what lets a call they asked for through the gate.
  if (/memory_type = 'text_exchange'/.test(sql)) return { rows: [{ "?column?": 1 }] };
  return { rows: [] };
};
(pool as any).connect = async () => ({ query: (pool as any).query, release() {} });

// ---- stubbed Twilio: every REST request the client makes is answered here, never sent.
const twilioReqs: any[] = [];
let twilioFails = false;
(twilio.Twilio.prototype as any).request = async function (opts: any) {
  twilioReqs.push(opts);
  if (twilioFails) return { statusCode: 500, body: JSON.stringify({ code: 20500, message: "stub failure", status: 500 }) };
  return { statusCode: 201, body: JSON.stringify({ sid: `CA${"0".repeat(31)}${twilioReqs.length}`, status: "queued" }) };
};

// ---- stubbed ElevenLabs (register call): records what it was told, answers with TwiML.
const elBodies: any[] = [];
const guarded = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (/api\.elevenlabs\.io/.test(url)) {
    elBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(`<Response><Connect><Stream url="wss://stub.elevenlabs/ws"/></Connect></Response>`, { status: 200, headers: { "content-type": "text/xml" } });
  }
  return guarded(input, init);
}) as typeof fetch;

process.env.API_URL = "https://api.cue.example";
const { triggerCallForUser } = await import("../../src/services/callTrigger.js");

// ---- the dial: what Twilio is given
let aliceId = "";
{
  const r = await triggerCallForUser(ALICE, null, { kind: "user_initiated" } as any);
  const create = twilioReqs.find((o) => /\/Calls\.json$/.test(String(o.uri)) && o.method === "post");
  const url = String(create?.data?.Url ?? "");
  check("the dial goes out (through the stubbed Twilio)", r.success === true && !!create, JSON.stringify(r));
  check("the TwiML URL has no user id", !!url && !url.includes(ALICE) && !url.includes(encodeURIComponent(ALICE)), url);
  check("the TwiML URL has no call token, and no u= or t=", !TOKEN_SHAPE.test(decodeURIComponent(url)) && !/[?&](u|t)=/.test(url), url);
  check("nothing else sent to Twilio carries the user id or a token", !JSON.stringify(create?.data ?? {}).includes(ALICE) && !TOKEN_SHAPE.test(JSON.stringify(create?.data ?? {})));
  const m = url.match(/^https:\/\/api\.cue\.example\/co\/el\/outbound-twiml\?c=([A-Za-z0-9_-]{43})$/);
  check("the TwiML URL is the route and a one-time call id", !!m, url);
  aliceId = m?.[1] ?? "";
  check("the id maps to this member on our side (by its hash)", links.get(L.callLinkHash(aliceId))?.user_id === ALICE && !links.has(aliceId));
  check("the status callback is unchanged (no member data in it)", create?.data?.StatusCallback === "https://api.cue.example/co/call-status");
}
{
  twilioFails = true;
  const before = links.size;
  const reqsBefore = twilioReqs.length;
  let peak = 0;
  const realPut = links.set.bind(links);
  (links as any).set = (k: string, v: any) => { const out = realPut(k, v); peak = Math.max(peak, links.size); return out; };
  const r = await triggerCallForUser(BOB, null, { kind: "user_initiated" } as any).catch((e: any) => ({ success: false, error: String(e?.message ?? e) }));
  twilioFails = false;
  (links as any).set = realPut;
  check("a dial Twilio refuses drops its link (it was issued, Twilio was asked, then it was gone)", r.success === false && twilioReqs.length === reqsBefore + 1 && peak === before + 1 && links.size === before, `links ${before} -> peak ${peak} -> ${links.size}, twilio ${reqsBefore} -> ${twilioReqs.length}`);
}

// ---- the TwiML route, as Twilio calls it (signed), through the real router
const { createCoRouter } = await import("../../src/routes/co.js");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/co", createCoRouter(null as any));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.API_URL = base; // the URL Twilio signs is API_URL + the path

const params = { CallSid: "CA_stub_1", From: "+15550000000", To: "+14155550201" };
async function twiml(query: string, sign = true) {
  const path = `/co/el/outbound-twiml${query}`;
  const sig = twilio.getExpectedTwilioSignature(sign ? "dummy-twilio-auth" : "wrong-auth", `${base}${path}`, params);
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params).toString() });
  return { status: res.status, body: await res.text() };
}

try {
  const unsigned = await twiml(`?c=${aliceId}`, false);
  check("a request Twilio didn't sign is refused, before the id is touched", unsigned.status === 401 && /Twilio signature/.test(unsigned.body) && links.has(L.callLinkHash(aliceId)));
  const first = await twiml(`?c=${aliceId}`);
  check("the valid id, once: the call is connected (ElevenLabs TwiML returned)", first.status === 200 && /stub\.elevenlabs/.test(first.body), `${first.status} ${first.body.slice(0, 200)}`);
  const vars = elBodies.at(-1)?.conversation_initiation_client_data?.dynamic_variables ?? {};
  check("...for the right member: ElevenLabs is told this member's id and name", vars.user_id === ALICE && vars.first_name === "Jordan", JSON.stringify(vars).slice(0, 200));
  check("...and the hand-off to ElevenLabs keeps its own call token (unchanged)", TOKEN_SHAPE.test(String(vars.call_token ?? "")) && elBodies.at(-1)?.conversation_initiation_client_data?.custom_llm_extra_body?.user_id === ALICE);
  check("...and the id is used up", !links.has(L.callLinkHash(aliceId)));
  const again = await twiml(`?c=${aliceId}`);
  check("the same id again: refused", again.status === 401 && /Invalid call link/.test(again.body));
  const unknown = await twiml(`?c=${"Z".repeat(43)}`);
  check("an unknown id: refused", unknown.status === 401);
  const none = await twiml("");
  check("no id at all: refused", none.status === 401);
  const old = await twiml(`?u=${ALICE}&t=${encodeURIComponent("1790000000." + "a".repeat(64))}`);
  check("the old user id + token form: refused", old.status === 401);
  const expiredId = await L.issueCallLink(BOB, undefined, new Date(Date.now() - 2 * 3600 * 1000 - 5000));
  const expired = await twiml(`?c=${expiredId}`);
  check("an expired id: refused, and its row is gone", expired.status === 401 && !links.has(L.callLinkHash(expiredId)));
  const bobId = await L.issueCallLink(BOB);
  const bob = await twiml(`?c=${bobId}`);
  const bobVars = elBodies.at(-1)?.conversation_initiation_client_data?.dynamic_variables ?? {};
  check("another member's id connects that member, not the first", bob.status === 200 && bobVars.user_id === BOB && bobVars.first_name === "Ellis");
} finally {
  server.close();
}

// ---- pinned in the source
{
  const read = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
  const trig = read("services/callTrigger.ts");
  const co = read("routes/co.ts");
  const route = co.slice(co.indexOf('router.post("/el/outbound-twiml"'), co.indexOf('router.post("/el/tool/:name"'));
  check("callTrigger no longer issues a call token into the Twilio URL", !/issueCallToken/.test(trig) && /url: `\$\{process\.env\.API_URL\}\/co\/el\/outbound-twiml\?c=\$\{encodeURIComponent\(callId\)\}`,/.test(trig));
  check("the route checks Twilio's signature before it takes the id", route.indexOf("validateTwilioSignature(req, req.originalUrl)") > 0 && route.indexOf("validateTwilioSignature(") < route.indexOf("takeCallLink("));
  check("the route reads neither u nor t", !/req\.query\.(u|t)\b/.test(route) && !/verifyCallToken/.test(route));
  const mig = read("db/migrations.ts");
  check("the migration is additive and idempotent", /CREATE TABLE IF NOT EXISTS call_links \(/.test(mig) && /CREATE INDEX IF NOT EXISTS call_links_expires/.test(mig));
}

globalThis.fetch = guarded;
console.log(`call links: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
