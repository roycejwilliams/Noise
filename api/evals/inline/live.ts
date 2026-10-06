// Read-only live check of inline-reply lookups (services/inlineReply.ts):
// the latest real texts, read back through Sendblue, and blocked for anyone else.
//   railway run --service co-test --environment dev -- npx tsx evals/inline/live.ts
import "../lib/requireMeter.js";
const { SendblueAPI } = await import("sendblue");
const { repliedTo } = await import("../../src/services/inlineReply.js");
const c = new SendblueAPI({ apiKey: process.env.SENDBLUE_API_KEY!, apiSecret: process.env.SENDBLUE_SECRET_KEY! });
const arr = (l: any) => l.data ?? l.messages ?? l;
const inn = arr(await c.messages.list({ is_outbound: false, order_by: "createdAt", order_direction: "desc", limit: 1 } as any))[0];
const phone = inn.from_number ?? inn.number;
const out = arr(await c.messages.list({ number: phone, is_outbound: true, order_by: "createdAt", order_direction: "desc", limit: 1 } as any))[0];
console.log("fields:", Object.keys(out ?? {}).join(","));
for (const [label, m] of [["Co's text", out], ["their text", inn]] as const) {
  const r = await repliedTo({ reply_to: { message_handle: m?.message_handle } }, phone);
  console.log(label, "->", r ? `fromCo=${r.fromCo}, ${r.text.length} chars` : "null");
  const other = await repliedTo({ reply_to: { message_handle: m?.message_handle } }, "+15550001111");
  console.log(label, "as another member ->", other ? "LEAK" : "null (blocked)");
}
