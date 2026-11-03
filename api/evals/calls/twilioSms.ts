// A text to Cue's calling line (services/twilioInboundSms.ts, routes/co.ts /co/incoming-sms, 2026-11-02). Layer 1: the database is a
// fake, nothing is sent, no tokens. Checks: a bad or missing Twilio signature is refused and nothing is handed in; a signed text goes
// into the SAME inbound handler a Sendblue text goes through (its one-text-once table, its saved payload), shaped as the member's own
// text; Twilio always gets an empty <Response/> (the calling line never answers anyone); the same MessageSid twice is one turn; an
// unknown number takes the same path as a member (the handler decides, not this route). Invented numbers (555-01xx).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/twilioSms.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ELEVENLABS_TOOL_SECRET ||= "dummy-tool-secret";
process.env.TWILIO_ACCOUNT_SID ||= "SKtest";
process.env.TWILIO_CLIENT_SECRET ||= "test";
process.env.TWILIO_LIVE_SID ||= "ACtest";
process.env.TWILIO_AUTH = "dummy-twilio-auth";
process.env.API_URL = "https://cue.example.test";
process.env.SENDBLUE_WEBHOOK_SECRET = "sb-test-secret";
import fs from "node:fs";
import twilio from "twilio";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

// The database: the one-text-once table is real-shaped (a handle is taken once); anything after it never answers, so a turn stops
// right there (nothing is looked up, nothing is sent) and what reached the handler is on record.
const handles = new Set<string>();
const queries: { sql: string; params: any[] }[] = [];
const pool = (await import("../../src/db/db.js")).default as any;
pool.query = (sql: string, params: any[] = []) => {
  const q = flat(String(sql));
  queries.push({ sql: q, params });
  if (/^INSERT INTO inbound_webhook_handles \(handle\) VALUES \(\$1\) ON CONFLICT \(handle\) DO NOTHING RETURNING handle/.test(q)) {
    const fresh = !handles.has(params[0]);
    handles.add(params[0]);
    return Promise.resolve({ rows: fresh ? [{ handle: params[0] }] : [] });
  }
  if (/^UPDATE inbound_webhook_handles SET payload/.test(q)) return Promise.resolve({ rows: [] });
  return new Promise(() => {});
};
const settle = () => new Promise((r) => setTimeout(r, 30));

const T = await import("../../src/services/twilioInboundSms.js");
const S = await import("../../src/routes/sendblue.js");
const { createCoRouter } = await import("../../src/routes/co.js");

// ---------------------------------------------------------------- 1. the shape
const MEMBER = "+14155550123", STRANGER = "+14155550188";
const form = (from: string, sid: string, body = "Is Thursday still on?") => ({ ToCountry: "US", From: from, To: "+14155550199", Body: body, MessageSid: sid, SmsMessageSid: sid, AccountSid: "ACtest", NumMedia: "0", NumSegments: "1", ApiVersion: "2010-04-01" });
const p = T.payloadFromTwilio(form(MEMBER, "SM111"), new Date("2026-11-02T18:00:00Z"));
check("shaped as their own inbound text: their number, their words, inbound, 1:1", p?.number === MEMBER && p?.content === "Is Thursday still on?" && p?.is_outbound === false && p?.message_type === "message" && p?.date_sent === "2026-11-02T18:00:00.000Z", p);
check("its handle is the MessageSid (one text, one handle)", p?.message_handle === "twilio:SM111");
check("a picture or voice memo carries its media", T.payloadFromTwilio({ ...form(MEMBER, "SM112", ""), NumMedia: "1", MediaUrl0: "https://api.twilio.example/Media/ME1" })?.media_url === "https://api.twilio.example/Media/ME1");
check("no sender or no MessageSid: nothing to hand in", T.payloadFromTwilio({ Body: "hi", MessageSid: "SM1" }) === null && T.payloadFromTwilio({ From: MEMBER, Body: "hi" }) === null && T.payloadFromTwilio(undefined) === null);
check("membership is never read here: the handler decides for a stranger exactly as for a Sendblue text", !/pool|users|identity_captured|invite/.test(src("services/twilioInboundSms.ts").replace(/^\s*\/\/.*$/gm, "")));

// ---------------------------------------------------------------- 2. the real route, the real signature check, the real handler
check("before the inbound handler exists, nothing runs", (await S.deliverInboundText({ number: MEMBER })) === false);
const sb: any = S.sendblueRouter({ to: () => ({ emit: () => {} }) } as any);
const co: any = createCoRouter({ to: () => ({ emit: () => {} }) } as any);
const layer = co.stack.find((l: any) => l.route?.path === "/incoming-sms");
check("POST /co/incoming-sms exists", !!layer && layer.route.methods.post === true);
const post = layer.route.stack[0].handle;
const URL_ = `${process.env.API_URL}/co/incoming-sms`;
const call = async (body: Record<string, string>, sig: string | null) => {
  const out: { status: number; body: string; headers: Record<string, string> } = { status: 0, body: "", headers: {} };
  const res: any = { status: (c: number) => ((out.status = c), res), send: (b: string) => ((out.body = String(b)), res), setHeader: (k: string, v: string) => ((out.headers[k.toLowerCase()] = v), res) };
  const headers: Record<string, string> = sig ? { "x-twilio-signature": sig } : {};
  await post({ body, headers, get: (h: string) => headers[h.toLowerCase()] } as any, res, () => {});
  await settle();
  return out;
};
const signed = (body: Record<string, string>) => twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH!, URL_, body);
const handed = (handle: string) => queries.filter((q) => /^UPDATE inbound_webhook_handles SET payload/.test(q.sql) && q.params[0] === handle);

{
  const body = form(MEMBER, "SMbad");
  const bad = await call(body, "not-a-signature");
  const none = await call(body, null);
  const forged = await call({ ...body, Body: "STOP" }, signed(body));
  check("a wrong signature: 401, nothing handed in", bad.status === 401 && handed("twilio:SMbad").length === 0 && !handles.has("twilio:SMbad"));
  check("no signature: 401, nothing handed in", none.status === 401 && !handles.has("twilio:SMbad"));
  check("a signature for other words (the body changed in flight): 401", forged.status === 401 && !handles.has("twilio:SMbad"));
  check("a refused request gets no TwiML message either", ![bad, none, forged].some((r) => /<Message/i.test(r.body)));
}
{
  const body = form(MEMBER, "SM200");
  const r = await call(body, signed(body));
  const saved = handed("twilio:SM200");
  check("a signed text from a member: 200", r.status === 200, r);
  check("Twilio's reply is an empty <Response/>, as XML: the calling line never answers", r.body === T.EMPTY_TWIML && r.headers["content-type"] === "text/xml" && !/<Message|<Redirect/i.test(r.body), r);
  check("it went into the same inbound handler a Sendblue text goes through (its one-text-once table)", handles.has("twilio:SM200"));
  check("... with their number and their words, as their own text (Cue answers from the texting number)", saved.length === 1 && JSON.parse(saved[0].params[1]).number === MEMBER && JSON.parse(saved[0].params[1]).content === "Is Thursday still on?" && JSON.parse(saved[0].params[1]).is_outbound === false, saved.map((q) => q.params));
  const again = await call(body, signed(body));
  check("Twilio delivering the same MessageSid again: one turn, not two", again.status === 200 && handed("twilio:SM200").length === 1 && queries.filter((q) => /^INSERT INTO inbound_webhook_handles/.test(q.sql) && q.params[0] === "twilio:SM200").length === 2);
  check("... and still no reply body", again.body === T.EMPTY_TWIML);
}
{
  const body = form(STRANGER, "SM300", "who is this");
  const r = await call(body, signed(body));
  check("an unknown number: handed to the same handler (it gets what an unknown number texting Sendblue gets), no Twilio reply", r.body === T.EMPTY_TWIML && handed("twilio:SM300").length === 1 && JSON.parse(handed("twilio:SM300")[0].params[1]).number === STRANGER);
}
{
  const r = await call({ AccountSid: "ACtest" }, signed({ AccountSid: "ACtest" }));
  check("a signed post that isn't a text: empty response, nothing handed in", r.status === 200 && r.body === T.EMPTY_TWIML && queries.every((q) => !/twilio:undefined/.test(JSON.stringify(q.params))));
}

// ---------------------------------------------------------------- 3. the Sendblue door is unchanged
{
  const wl = sb.stack.find((l: any) => l.route?.path === "/webhook");
  let status = 0;
  const res: any = { status: (c: number) => ((status = c), res), send: () => res, json: () => res, sendStatus: () => res };
  await wl.route.stack[0].handle({ body: { number: MEMBER, content: "hi", message_handle: "sb-1", is_outbound: false }, get: () => undefined, ip: "test" }, res, () => {});
  check("the Sendblue webhook still refuses a delivery without its secret", status === 401 && !handles.has("sb-1"));
}
const sbSrc = src("routes/sendblue.ts");
check("only the Twilio hand-in skips the Sendblue secret, and only because it was signature-checked first", (sbSrc.match(/, "twilio"\);/g) ?? []).length === 1 && /inboundHandler = async[\s\S]{0,600}null, "twilio"\);/.test(sbSrc));
check("the route checks the signature with the existing helper, for its own path", /validate: \(req\) => validateTwilioSignature\(req, "\/co\/incoming-sms"\)/.test(src("routes/co.ts")));
check("no new pipeline: the route only reaches deliverInboundText", /deliver: async \(payload\) => \(await import\("\.\/sendblue\.js"\)\)\.deliverInboundText\(payload\)/.test(src("routes/co.ts")) && !/sendblue\.messages|twilioClient|messages\.create/.test(src("services/twilioInboundSms.ts")));

console.log(`twilioSms: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
