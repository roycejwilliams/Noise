// LAYER 1 (logic tests): the model is fully stubbed. Preloaded into every logic test with `node --import`.
//
// A logic test must spend zero tokens. This replaces the network for model hosts with canned, deterministic answers
// (a one-word "stub" reply; a zero vector for embeddings) and refuses every other outside call. Nothing here ever
// reaches a real API, so a layer 1 run costs nothing, whatever the code under test does. Each stubbed call is counted
// (MODEL_GUARD_LOG) so the runner can show which tests lean on the stub: a test whose result depends on what a model
// says belongs in layer 2 or must inject its own fake, not read the canned answer.
import { appendFileSync } from "node:fs";

const log = (kind, host) => {
  try {
    if (process.env.MODEL_GUARD_LOG) appendFileSync(process.env.MODEL_GUARD_LOG, `${process.env.MODEL_GUARD_FILE ?? "?"}\t${kind}\t${host}\n`);
  } catch {}
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

function stubAnthropic(init) {
  let body = {};
  try { body = JSON.parse(init?.body ?? "{}"); } catch {}
  const model = body.model ?? "claude-stub";
  const usage = { input_tokens: 0, output_tokens: 0 };
  if (body.stream) {
    return sse([
      { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stub" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]);
  }
  return json({ id: "msg_stub", type: "message", role: "assistant", model, content: [{ type: "text", text: "stub" }], stop_reason: "end_turn", stop_sequence: null, usage });
}

function stubEmbeddings(init) {
  let body = {};
  try { body = JSON.parse(init?.body ?? "{}"); } catch {}
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  return json({ object: "list", model: body.model ?? "stub", data: inputs.map((_, index) => ({ object: "embedding", index, embedding: new Array(body.dimensions ?? 1536).fill(0) })), usage: { prompt_tokens: 0, total_tokens: 0 } });
}

const real = globalThis.fetch;
globalThis.__LAYER1_GUARD__ = true;
globalThis.fetch = async function stubbedFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let host = "";
  try { host = new URL(url).host; } catch { return real(input, init); }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) return real(input, init);
  if (/api\.anthropic\.com$/.test(host)) { log("stubbed", host); return stubAnthropic(init); }
  if (/api\.openai\.com$/.test(host) && /\/embeddings/.test(url)) { log("stubbed", host); return stubEmbeddings(init); }
  log("refused", host);
  throw new Error(`LAYER 1: a logic test tried a real call to ${host}. Layer 1 makes no outside calls: inject a fake for it, or move the test to layer 2 (evals/live).`);
};
