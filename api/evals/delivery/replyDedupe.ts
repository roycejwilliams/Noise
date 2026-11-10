// A reply send that threw may still have gone (Royce, 2026-11-10: accidental duplicates at delivery). Zero tokens; Sendblue's record
// is faked. The guard is about one send, matched word for word: it never swallows a requested reminder, a correction or an answer to a
// repeated question (those are new texts, not this one).
//   npx tsx evals/delivery/replyDedupe.ts
import { readFileSync } from "node:fs";
import { wentDespiteError } from "../../src/services/sendblue.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

const q = { number: "+15035550123", since: new Date("2026-11-10T17:00:00Z"), content: "Here's the walkthrough, step by step." };
let reads = 0;
const record = (answer: boolean | null) => async () => {
  reads++;
  return answer;
};

check("a timeout that Sendblue's record shows went: reported sent (no second copy)", (await wentDespiteError(Object.assign(new Error("Request timed out"), {}), q, { went: record(true), settleMs: 0 })) === true);
check("a 503 that didn't go: not sent (the reply may try again)", (await wentDespiteError(Object.assign(new Error("503 Service Unavailable"), { status: 503 }), q, { went: record(false), settleMs: 0 })) === false);
check("unreadable record: unknown (null), never claimed sent", (await wentDespiteError(new Error("socket hang up"), q, { went: record(null), settleMs: 0 })) === null);
reads = 0;
check("a 4xx never went: false with no read", (await wentDespiteError(Object.assign(new Error("400 Bad Request"), { status: 400 }), q, { went: record(true), settleMs: 0 })) === false && reads === 0);
check("the send layer's own refusal (breaker, placeholder, bad number): false with no read", (await wentDespiteError(new Error("sendblue: send breaker open for ...0123, refusing to send"), q, { went: record(true), settleMs: 0 })) === false && reads === 0);

const route = readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
check("sendCoReply checks the record before the plain fallback of a failed inline reply", /inline[\s\S]{0,1600}wentDespiteError\(err, \{ number: phone, since, content: message \}\)\) === true[\s\S]{0,400}inline reply refused, sending it plain/.test(route));
check("sendCoReply checks the record before reporting a plain send failed", /await sendblue\.messages\.send\(body\);\s*\} catch \(err: any\) \{[\s\S]{0,400}wentDespiteError/.test(route));
const sb = readFileSync(new URL("../../src/services/sendblue.ts", import.meta.url), "utf8");
check("matched word for word on this exact text and number, never by similarity", /words\(d\?\.content\) === want/.test(sb) && !/similar/i.test(sb.slice(sb.indexOf("export async function wentDespiteError"), sb.indexOf("export async function wentDespiteError") + 1200).replace(/never a similar text/, "")));

console.log(`\nreply delivery dedupe: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
