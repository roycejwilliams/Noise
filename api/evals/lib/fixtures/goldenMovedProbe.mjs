// Test fixture: one golden case over the fake network (fakeAnthropic.mjs), for the skeleton match (evals/lib/goldenSkeleton.mjs). Its
// request carries a wording chunk (PROBE_GUIDE), a fact line (PROBE_FACT) and a tool whose description is PROBE_TOOL_DESC, so a test can
// record once and replay with only the wording moved, the fact changed, or the description changed (evals/golden/harnessTest.ts).
const G = globalThis.__GOLDEN__;
const GUIDE = process.env.PROBE_GUIDE ?? "";
G.setWording({ signature: "probe-signature", chunks: [{ id: "probe.ts:GUIDE#0", text: GUIDE }] });
const text = (r) => r.json().then((j) => j.content?.[0]?.text ?? "?");
const body = {
  model: "claude-sonnet-5",
  max_tokens: 100,
  system: [{ type: "text", text: `${GUIDE}\n\nWhat's true right now.\n[F1] ${process.env.PROBE_FACT ?? ""}` }],
  messages: [{ role: "user", content: [{ type: "text", text: `${GUIDE}\nThey just said: "hello"` }] }],
  tools: [{ name: "sendReply", description: process.env.PROBE_TOOL_DESC ?? "Send the reply.", input_schema: { type: "object", properties: { message: { type: "string", description: "the text" } }, required: ["message"] } }],
};
const out = {};
const a = await G.attempt("moved-case", G.mode, async () => {
  out.reply = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(text)
    .catch((e) => `threw: ${String(e.message).slice(0, 200)}`);
  return { ok: true, misses: [], observed: "" };
});
out.misses = a.misses;
out.moved = a.moved;
out.served = a.served;
out.stats = G.stats();
console.log("GOLDEN " + JSON.stringify(out));
