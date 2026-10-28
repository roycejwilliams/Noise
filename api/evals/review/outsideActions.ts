// Outside actions say what actually happened (Royce, 2026-10-27: "after execution, verify against the service and show what actually
// happened; don't present a draft, preview or attempted action as completed"). Layer 1: the real shareLink with a fake send, zero tokens.
//   npx tsx evals/review/outsideActions.ts
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [] });
const { createConversationTools } = await import("../../src/agent/conversationTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
const URL1 = "https://lu.ma/abc123";
const make = (sendOk: boolean) => {
  const facts: { kind: string; text: string }[] = [];
  const t = createConversationTools({
    userId: "00000000-0000-4000-8000-000000000001", phoneNumber: "+10000000000", resolvedContent: "send me that link", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
    sendCoReply: async () => sendOk, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => `the find: ${URL1}` },
  } as any);
  return { tools: t.tools as any, facts };
};
const log = console.log;
console.log = () => {};
console.error = () => {};
const sent = make(true);
const okR = await sent.tools.shareLink.execute({ urls: [URL1], why: "they asked for the link" }, { toolCallId: "t1", messages: [] });
const failedSend = make(false);
const badR = await failedSend.tools.shareLink.execute({ urls: [URL1], why: "they asked for the link" }, { toolCallId: "t2", messages: [] });
console.log = log;
check("shareLink: a link that went is recorded as sent", okR?.ok === true && sent.facts.some((f) => f.kind === "did_this_turn" && f.text.includes(URL1)), { okR, facts: sent.facts });
check("shareLink: a link whose send failed is never recorded as sent, and the tool says so", badR?.ok === false && !failedSend.facts.some((f) => f.kind === "did_this_turn" && /^Sent the link/.test(f.text)), { badR, facts: failedSend.facts });

// requestEventIntro: a failed request is logged as failed (after one retry), never "requested"; the member's line stays neutral.
const ct = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
check("requestEventIntro: a throw retried once, a false never; the outcome follows the send (not_sent, not requested)", /for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(ct) && /went === false \?/.test(ct) && /action: failure \? "not_sent" : "requested"/.test(ct) && !/requestIntroToNamedGuest\([\s\S]{0,300}\)\.catch\(\(err: any\) => console\.error\("requestEventIntro/.test(ct));
check("requestEventIntro: not sent is not ok (the guard never records it as started), with the neutral line", /if \(failure\) \{\s*return \{\s*ok: false,\s*error: "Not requested right now\. Tell them the same neutral thing/.test(ct));

console.log(`outside actions: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
