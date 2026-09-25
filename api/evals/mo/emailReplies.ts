// Model-free checks for Mo reading replies to its emails (mo/emailReplies.ts,
// 2026-09-25). No network, no database: the checks that need one stop before
// it (bad signature, wrong event type).
//
//   npx tsx evals/mo/emailReplies.ts
import { createHmac } from "crypto";
import { readFileSync } from "fs";

process.env.MO_UNSUBSCRIBE_SECRET ||= "test-secret-for-evals";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { emailRepliesConfigured, moReplyAddress, prospectFromReplyAddress } = await import("../../src/mo/outreach.js");
const { handleInboundEmail, isAutoReply, stripQuotedReply } = await import("../../src/mo/emailReplies.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ---- reply addresses
const id = "3f2c1a9e-5b7d-4c8e-9f10-2a3b4c5d6e7f";
check("no reply domain, no reply address (hello@ as before)", moReplyAddress(id, {} as any) === null);
const addr = moReplyAddress(id, { MO_REPLY_DOMAIN: "abc123.resend.app" } as any)!;
check("a signed per-prospect address on the receiving domain", /^reply-[0-9a-f-]{36}-[0-9a-f]{12}@abc123\.resend\.app$/.test(addr));
check("the address maps back to its prospect", prospectFromReplyAddress(addr) === id);
check("…inside a display name too", prospectFromReplyAddress(`Mo <${addr.toUpperCase()}>`.toLowerCase()) === id);
check("a tampered signature is rejected", prospectFromReplyAddress(addr.replace(/-([0-9a-f]{12})@/, "-000000000000@")) === null);
check("another prospect's id with this signature is rejected", prospectFromReplyAddress(addr.replace(id, "3f2c1a9e-5b7d-4c8e-9f10-2a3b4c5d6e70")) === null);
check("an ordinary address isn't a reply address", prospectFromReplyAddress("hello@copatible.com") === null);
check("a bad domain is refused", moReplyAddress(id, { MO_REPLY_DOMAIN: "not a domain" } as any) === null);

// ---- only the new words
check("Gmail quote cut", stripQuotedReply("Yes, I'd love an invite.\n\nOn Tue, Sep 23, 2026 at 4:02 PM Mo <mo@co.com> wrote:\n> Want to know why?") === "Yes, I'd love an invite.");
check("quoted lines dropped", stripQuotedReply("Sure\n> earlier\n> text") === "Sure");
check("Outlook original-message cut", stripQuotedReply("What is Co exactly?\n\n-----Original Message-----\nFrom: Mo") === "What is Co exactly?");
check("Outlook header block cut", stripQuotedReply("No thanks.\n\nFrom: Mo <mo@x.com>\nSent: Tuesday") === "No thanks.");
check("signature line cut", stripQuotedReply("Tell me more\n\nSent from my iPhone") === "Tell me more");
check("a plain reply is kept whole", stripQuotedReply("Who else is in it?\nAnd where is it?") === "Who else is in it?\nAnd where is it?");

// ---- machine replies get nothing
check("out of office by subject", isAutoReply("Out of Office: back Monday", {}));
check("automatic reply by subject", isAutoReply("Automatic reply: Re: hello", {}));
check("auto-submitted header", isAutoReply("Re: hello", { "Auto-Submitted": "auto-replied" }));
check("bounce", isAutoReply("Undeliverable: Re: hello", {}));
check("a real reply isn't auto", !isAutoReply("Re: A quick hello from Co", { "Auto-Submitted": "no" }));

// ---- the webhook refuses anything unsigned
const secretBytes = Buffer.from("mo-inbound-test-secret-32-bytes!!");
process.env.RESEND_WEBHOOK_SECRET = `whsec_${secretBytes.toString("base64")}`;
process.env.RESEND_API_KEY ||= "re_unused_in_tests";
const sign = (msgId: string, ts: string, body: string) => `v1,${createHmac("sha256", secretBytes).update(`${msgId}.${ts}.${body}`).digest("base64")}`;
const now = String(Math.floor(Date.now() / 1000));
const other = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: "x" } });
check("a forged post is refused", (await handleInboundEmail(other, { id: "msg_1", timestamp: now, signature: "v1,Zm9yZ2Vk" })).status === 400);
check("a post with no signature is refused", (await handleInboundEmail(other, {})).status === 400);
const ok = await handleInboundEmail(other, { id: "msg_2", timestamp: now, signature: sign("msg_2", now, other) });
check("a correctly signed post is accepted (other event types are ignored)", ok.status === 200 && ok.action === "ignored");
const tampered = await handleInboundEmail(other.replace("email.sent", "email.received"), { id: "msg_2", timestamp: now, signature: sign("msg_2", now, other) });
check("a body changed after signing is refused", tampered.status === 400);
delete process.env.RESEND_WEBHOOK_SECRET;
check("without the secret nothing is accepted", (await handleInboundEmail(other, { id: "msg_2", timestamp: now, signature: sign("msg_2", now, other) })).status === 400);

// ---- status line and wiring
check("replies count as set up only with both the domain and the secret", !emailRepliesConfigured({ MO_REPLY_DOMAIN: "a.resend.app" } as any) && !emailRepliesConfigured({ RESEND_WEBHOOK_SECRET: "whsec_x" } as any) && emailRepliesConfigured({ MO_REPLY_DOMAIN: "a.resend.app", RESEND_WEBHOOK_SECRET: "whsec_x" } as any));
check("Mo tells the team when replies aren't read yet", /Replies to my emails still go to the hello@ inbox/.test(src("src/mo/outreach.ts")));
const outreach = src("src/mo/outreach.ts");
check("Mo's emails set the signed reply address", /replyTo: moReplyAddress\(p\.id\) \?\? "hello@copatible\.com"/.test(outreach));
check("DM and email replies share one reader", /handleProspectReply\(p, e\.text, \(msg\) => sendDm\(p\.x_user_id, msg\)\)/.test(outreach) && /handleProspectReply\(prospect, text, \(msg\) => sendMoEmailReply\(prospect, msg\)\)/.test(src("src/mo/emailReplies.ts")));
check("the reader still goes clear words, then Jev, then Claude", /if \(clearStop\(text\)\) return "no";\n\s+if \(clearYes\(text\)\) return "yes";[\s\S]{0,200}readReplyWithJev\(text\)/.test(outreach));
check("an approver's answer goes back by email to email prospects", /if \(byEmail\) await sendMoEmailReply\(p, text\);/.test(src("src/mo/review.ts")));
check("Mo's answer lands in the same thread", /"In-Reply-To": p\.last_email_message_id/.test(outreach));
check("each email is handled once", /INSERT INTO mo_email_inbound \(email_id\) VALUES \(\$1\) ON CONFLICT DO NOTHING RETURNING/.test(src("src/mo/emailReplies.ts")));
for (const [name, file] of [["api", "src/server.ts"], ["co-test", "../co-test/src/server.ts"]] as const) {
  check(`${name}: the inbound route gets the raw body`, /app\.use\("\/mo\/email\/inbound", express\.raw\(\{ type: "application\/json" \}\)\)/.test(src(file)));
  check(`${name}: Mo's routes are served`, /app\.use\("\/mo", createMoRouter\(\)\)/.test(src(file)));
}

console.log(`mo email reply rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
