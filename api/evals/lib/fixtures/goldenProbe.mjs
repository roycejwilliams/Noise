// Test fixture: drives the golden recorder (evals/lib/goldenReplay.mjs) over the fake network (fakeAnthropic.mjs), so record and replay
// can be checked with zero tokens. Run once with GOLDEN_MODE=record, then again with GOLDEN_MODE=replay against the same folder.
// Replay also plays the ways a miss could hide: a call outside any case, a late call after its case returned, a repeat past what was
// recorded, and a worker started by one case serving another.
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";

const G = globalThis.__GOLDEN__;
const replay = G.mode === "replay";
const text = (r) => r.json().then((j) => j.content?.[0]?.text ?? "?");
const call = (content, extra = {}) =>
  fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content }], ...extra }) })
    .then(text)
    .catch((e) => `threw: ${String(e.message).slice(0, 80)}`);
// The stream path the way production reads it: the ai SDK over SSE.
const stream = async () => {
  try {
    const r = streamText({ model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "none" })("claude-sonnet-5"), prompt: "stream me", maxOutputTokens: 50, maxRetries: 0 });
    return await r.text;
  } catch (e) {
    return `threw: ${String(e?.message ?? e).slice(0, 80)}`;
  }
};
const out = { mode: G?.mode, now: new Date().toISOString(), dateNow: Date.now(), tz: process.env.TZ, instance: new Date() instanceof Date };

const a = await G.attempt("probe-case", G.mode, async () => {
  out.recorded = await call("hello");
  // Same words, keys in another order: the same request, so the same recording.
  out.reordered = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], max_tokens: 100, model: "claude-sonnet-5" }) }).then(text).catch((e) => `threw: ${String(e.message).slice(0, 80)}`);
  out.streamed = await stream();
  if (replay) {
    out.unrecorded = await call("a prompt nobody recorded");
    // Recorded twice above; a third ask is a miss, never the last answer again.
    out.repeat = await call("hello");
    // (b) fire and forget: settles after the case has returned; the error is swallowed by the code.
    setTimeout(() => { call("a late call nobody recorded"); }, 30);
  }
  try { await fetch("https://api.resend.com/emails", { method: "POST" }); out.otherHost = "allowed"; } catch { out.otherHost = "refused"; }
  return { ok: true, misses: [], observed: "" };
});
out.misses = a.misses.length;
out.missTexts = a.misses;
out.served = a.served;
out.written = a.recorded;

if (replay) {
  // (c) a worker started by one case, fed by the next: its calls are billed to the case that started it.
  const queue = [];
  let stop = false;
  await G.attempt("probe-worker", "replay", async () => {
    (async () => { while (!stop) { const job = queue.shift(); if (job) { await call(job.words); job.finish(); } else await new Promise((r) => setTimeout(r, 5)); } })();
    return { ok: true, misses: [], observed: "" };
  });
  const b = await G.attempt("probe-b", "replay", async () => {
    await new Promise((finish) => queue.push({ words: "queued by probe-b", finish }));
    return { ok: true, misses: [], observed: "" };
  });
  stop = true;
  out.bMisses = b.misses.length;
  // (a) outside any case, caught by the code.
  out.outside = await call("hello");
}
await G.settle(100);
out.all = G.allMisses().map((m) => ({ case: m.case, miss: m.miss.split("\n")[0] }));
console.log("GOLDEN " + JSON.stringify(out));
