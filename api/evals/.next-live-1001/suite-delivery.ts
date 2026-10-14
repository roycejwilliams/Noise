// Suite 5: Sendblue delivery plumbing. Model-free except where the status route
// embeds an error line (OpenAI embedding, a fraction of a cent).
import { H } from "./boot.js";
import { settle } from "./db.js";
import { member, rows, ck, wait, PHONE, ID, type Case } from "./fixtures.js";
import { inbound, mountRouter } from "./router.js";

const NONTEST = "+19995550201"; // area code 999 is unassigned; 555-02xx is outside the test range; never leaves the process
const sbSends = (from: number) => H.captured.slice(from).filter((c) => c.transport === "sendblue");

export const delivery: Case[] = [
  {
    suite: "delivery", id: "delivery-sendSMS-stub", mode: "model-free", runs1: true,
    run: async () => {
      const { sendSMS, ALLOW_REAL_SENDS } = await import("../../src/otpActions.js");
      const cap = H.captured.length;
      const r = await sendSMS({ phone_number: PHONE.A, intro: true, save_contact: true, intake_ask: true, welcome: true } as any);
      const { HOW_IT_WORKS, CARD, NAME_EMAIL, WELCOME } = await import("../../src/services/onboardingLines.js");
      const inSet = (line: string, set: readonly string[] | string) => (Array.isArray(set) ? set : [set]).includes(line);
      return {
        checks: [
          ck("ALLOW_REAL_SENDS is false from import", ALLOW_REAL_SENDS === false),
          ck("ok, four lines returned in order", r.ok && r.sent.length === 4, r),
          ck("each line is an approved onboarding line", inSet(r.sent[0], HOW_IT_WORKS as any) && inSet(r.sent[1], CARD as any) && inSet(r.sent[2], NAME_EMAIL as any) && inSet(r.sent[3], WELCOME as any), r.sent),
          ck("zero SDK/provider calls", H.captured.length === cap, H.captured.slice(cap)),
        ],
        observed: { sent: r.sent, note: "The stub drops media_url, so the vCard attachment shape is not observable on this path." },
      };
    },
  },
  {
    suite: "delivery", id: "delivery-wrapper", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const sendblue = (await import("../../src/services/sendblue.js")).default as any;
      const cap = H.captured.length;
      const res = await sendblue.messages.send({ number: PHONE.A, from_number: process.env.SENDBLUE_PHONE_NUMBER, content: "“Hi there — good to see you”" });
      await settle();
      const out = await rows(`SELECT message_handle, user_id, content, sender FROM outbound_messages`);
      return {
        checks: [
          ck("test number returns a test handle", /^test-|harness|test/i.test(String(res?.message_handle)) && res?.test === true, res),
          ck("one TEMP outbound row, right owner and sender", out.length === 1 && out[0].user_id === ID.A && out[0].sender === "co" && out[0].message_handle === res.message_handle, out),
          ck("content cleaned (quotes and dash)", out[0]?.content === "Hi there, good to see you", out[0]?.content),
          ck("zero provider calls", H.captured.length === cap, H.captured.slice(cap)),
        ],
        observed: { res, out },
      };
    },
  },
  {
    suite: "delivery", id: "delivery-sdk-envelope", mode: "model-free", runs1: true,
    replaced: ["Sendblue HTTP endpoint: captured by the harness fetch adapter, mock 200 {message_handle}"],
    run: async () => {
      const { isTestNumber } = await import("../../src/services/testNumbers.js");
      const sendblue = (await import("../../src/services/sendblue.js")).default as any;
      const cap = H.captured.length;
      const r1 = await sendblue.messages.send({ number: NONTEST, from_number: process.env.SENDBLUE_PHONE_NUMBER, content: "Plain line." });
      const r2 = await sendblue.messages.send({ number: NONTEST, from_number: process.env.SENDBLUE_PHONE_NUMBER, content: "Card.", media_url: "https://co.invalid/co.vcf" });
      await settle();
      const env = sbSends(cap);
      const out = await rows(`SELECT message_handle, user_id, content FROM outbound_messages ORDER BY sent_at`);
      return {
        checks: [
          ck("synthetic number is not a test number", !isTestNumber(NONTEST)),
          ck("two envelopes captured at the HTTP boundary, none left the process", env.length === 2 && H.unexpectedNet.filter((x) => x.caseId === H.caseId).length === 0, env),
          ck("envelope fields: number, from_number, content", env[0]?.body?.number === NONTEST && env[0]?.body?.from_number === process.env.SENDBLUE_PHONE_NUMBER && env[0]?.body?.content === "Plain line.", env[0]?.body),
          ck("media_url carried on the card send", env[1]?.body?.media_url === "https://co.invalid/co.vcf", env[1]?.body),
          ck("mock handles recorded (no user for this number)", out.length === 2 && out.every((o: any) => o.user_id === null), out),
        ],
        observed: { envelopes: env.map((e) => ({ path: e.path, keys: Object.keys(e.body ?? {}) })), r1, r2 },
      };
    },
  },
  {
    suite: "delivery", id: "delivery-reject-vs-uncertain", mode: "model-free", runs1: true,
    replaced: ["Sendblue HTTP responses programmed: 400, then 500"],
    run: async () => {
      const sendblue = (await import("../../src/services/sendblue.js")).default as any;
      const { SEND_LIMIT } = await import("../../src/services/sendLimiter.js");
      const num = "+19995550202";
      H.respond = () => ({ status: 400, body: { error_message: "invalid number" } });
      let rejected = 0;
      for (let i = 0; i < SEND_LIMIT.unprompted + 3; i++) await sendblue.messages.send({ number: num, from_number: process.env.SENDBLUE_PHONE_NUMBER, content: `Try ${i}` }).catch((e: any) => { if (/400|invalid/i.test(String(e?.message ?? e?.status))) rejected++; });
      // Every 4xx was released, so the unprompted breaker never trips.
      H.respond = () => ({ status: 500, body: { error_message: "upstream" } });
      const before = H.captured.length;
      let uncertain = 0;
      await sendblue.messages.send({ number: num, from_number: process.env.SENDBLUE_PHONE_NUMBER, content: "After 500" }).catch(() => { uncertain++; });
      const sdkRetries = H.captured.length - before;
      H.respond = null;
      await settle();
      const out = await rows(`SELECT count(*)::int AS n FROM outbound_messages`);
      return {
        checks: [
          ck(`all ${SEND_LIMIT.unprompted + 3} 4xx sends rejected, none tripped the breaker`, rejected === SEND_LIMIT.unprompted + 3, { rejected }),
          ck("a 500 is a failure the caller sees", uncertain === 1),
          ck("no outbound receipt recorded for any failed send", out[0].n === 0, out),
          ck("SDK retries on 500 are bounded (recorded, not hidden)", sdkRetries >= 1 && sdkRetries <= 4, { sdkRetries }),
        ],
        observed: { rejected, uncertain, sdkAttemptsOn500: sdkRetries, note: "Caption-after-link is a caller pattern (two sends); not exercised here, see report." },
      };
    },
  },
  {
    suite: "delivery", id: "delivery-breaker", mode: "model-free", runs1: true,
    run: async () => {
      const { createSendLimiter, SEND_LIMIT } = await import("../../src/services/sendLimiter.js");
      const L = createSendLimiter();
      const t0 = Date.parse("2026-10-02T17:00:00Z");
      const n = "+19995550203";
      let firstTrip = -1, trips = 0;
      for (let i = 0; i < SEND_LIMIT.unprompted + 4; i++) { const r = L.check(n, t0 + i * 1000); if (!r.ok && r.tripped) { trips++; if (firstTrip < 0) firstTrip = i; } }
      const held = L.check(n, t0 + 29 * 60 * 1000);
      const resumed = L.check(n, t0 + 31 * 60 * 1000 + 20 * 1000);
      // Total limit: inbound resets the unprompted run but not the 10-minute count.
      const T = createSendLimiter();
      let totalTripAt = -1;
      for (let i = 0; i < SEND_LIMIT.max + 2; i++) { if (i % 5 === 0) T.noteInbound(n); const r = T.check(n, t0 + i * 1000); if (!r.ok && r.tripped && totalTripAt < 0) totalTripAt = i; }
      // Through the real wrapper: the breaker notice goes out once (team alert captured, held note in TEMP).
      await member("B");
      const sendblue = (await import("../../src/services/sendblue.js")).default as any;
      const cap = H.captured.length;
      let refused = 0;
      for (let i = 0; i < SEND_LIMIT.unprompted + 4; i++) await sendblue.messages.send({ number: PHONE.B, from_number: process.env.SENDBLUE_PHONE_NUMBER, content: `Line ${i}` }).catch(() => { refused++; });
      await settle(800);
      const held2 = await rows(`SELECT count(*)::int AS n FROM co_memories WHERE memory_type = 'send_held' AND user_id = $1`, [ID.B]);
      const alerts = H.captured.slice(cap).filter((x) => x.transport === "email");
      const { sendLimiter } = await import("../../src/services/sendLimiter.js");
      sendLimiter.noteInbound(PHONE.B);
      return {
        checks: [
          ck(`unprompted breaker trips on send ${SEND_LIMIT.unprompted + 1}, exactly once`, firstTrip === SEND_LIMIT.unprompted && trips === 1, { firstTrip, trips }),
          ck("held at 29 minutes, resumes after the 30-minute cooldown", !held.ok && resumed.ok, { held, resumed }),
          ck(`total limit trips at ${SEND_LIMIT.max + 1} in 10 minutes even with replies`, totalTripAt === SEND_LIMIT.max, { totalTripAt }),
          ck("wrapper refuses after the limit", refused === 4, { refused }),
          ck("one held-sends note for the member (TEMP)", held2[0].n === 1, held2),
          ck("at most one team alert, captured not sent", alerts.length <= 1, alerts.map((a) => a.path)),
        ],
        observed: { defaults: SEND_LIMIT, alertsCaptured: alerts.length },
      };
    },
  },
  {
    suite: "delivery", id: "delivery-webhook-status", mode: "model-free", runs1: true,
    replaced: ["express app mounting the real sendblueRouter on 127.0.0.1 with a fake socket.io"],
    run: async () => {
      await member("C");
      await mountRouter();
      const bad = await inbound(PHONE.C, "hello", { secret: "wrong" });
      const status = await inbound(PHONE.C, "", { extra: { is_outbound: true, status: "ERROR", error_code: 30003, error_message: "Unreachable" } });
      await settle(1500);
      const errMem = await rows(`SELECT content FROM co_memories WHERE user_id = $1 AND content LIKE 'Cue message failed to deliver%'`, [ID.C]);
      const turns = await rows(`SELECT count(*)::int AS n FROM inbound_webhook_handles`);
      const replies = await rows(`SELECT count(*)::int AS n FROM outbound_messages`);
      // Duplicate inbound handle: second delivery is a duplicate, not a second turn.
      const h = `harness-dup-${Date.now()}`;
      await raw0(`INSERT INTO inbound_webhook_handles (handle) VALUES ($1)`, [h]);
      await inbound(PHONE.C, "hi again", { handle: h });
      await settle(1200);
      const dup = await rows(`SELECT count(*)::int AS n FROM harness_decisions WHERE decision = 'turn.duplicate'`);
      return {
        checks: [
          ck("wrong signing secret rejected with 401", bad.status === 401, bad),
          ck("outbound ERROR status acked and kept as a TEMP note", status.status === 200 && errMem.length === 1 && /30003/.test(errMem[0].content), errMem),
          ck("outbound status never starts a turn or a reply", turns[0].n === 0 && replies[0].n === 0, { turns, replies }),
          ck("a redelivered handle is a duplicate, not a second turn", dup[0].n === 1, dup),
        ],
        observed: { note: "Sendblue SENT/ERROR is acceptance status, not proof of delivery or read." },
      };
    },
  },
  {
    suite: "delivery", id: "delivery-meta-and-secondary", mode: "model-free", runs1: true,
    replaced: ["Sendblue/Resend/ElevenLabs HTTP: captured, mock responses"],
    run: async () => {
      const S = await import("../../src/services/sendblue.js");
      const sendblue = S.default as any;
      const cap = H.captured.length;
      let metaRefused = false;
      await sendblue.messages.send({ number: "+19995550204", from_number: process.env.SENDBLUE_PHONE_NUMBER, content: "I don't have access to your messages, but here's a draft: hey!" }).catch((e: any) => { metaRefused = /meta-commentary/.test(String(e?.message)); });
      const metaSent = H.captured.slice(cap).filter((x) => x.transport === "sendblue").length;
      const c2 = H.captured.length;
      await S.markRead("+19995550204");
      const tap = await S.sendReaction("real-handle-xyz", "love");
      const blocked = await S.blockSender("+19995550204");
      const sec = H.captured.slice(c2).map((x) => `${x.transport}:${x.path}`);
      const { sendEmail } = await import("../../src/otpActions.js");
      const c3 = H.captured.length;
      await (sendEmail as any)({ email: "someone@co.invalid", welcome: true, firstName: "Avery" }).catch(() => {});
      const mail = H.captured.slice(c3).map((x) => `${x.transport}:${x.path}`);
      await settle();
      return {
        checks: [
          ck("meta-commentary refused before any send", metaRefused && metaSent === 0, { metaRefused, metaSent }),
          ck("read receipt, tapback, block are captured at the boundary", sec.filter((s) => s.startsWith("sendblue:")).length === 3, sec),
          ck("email never reaches a provider (sendEmail stubs when real sends are off)", mail.length === 0, mail),
          ck("zero unexpected network", H.unexpectedNet.filter((x) => x.caseId === H.caseId).length === 0, H.unexpectedNet),
        ],
        observed: { secondary: sec, mail, tapbackReturned: tap, blockReturned: blocked },
      };
    },
  },
];

async function raw0(sql: string, v: any[]) { const { raw } = await import("./db.js"); return raw(sql, v); }
export { wait, ID };
