// LAYER 1 (logic tests): the model is fully stubbed. Preloaded into every logic test with `node --import`.
//
// A logic test must spend zero tokens. This replaces the network for model hosts with canned, deterministic answers
// (a one-word "stub" reply; a zero vector for embeddings) and refuses every other outside fetch. Nothing here ever
// reaches a real API through fetch, so a layer 1 run costs nothing. Below fetch, every outside socket is refused too (node
// http/https, websockets, SDKs on axios: Twilio, Sendblue, ElevenLabs, OpenAI realtime, Exa...): a test can never place a real call
// or a paid request, whatever key it finds (follow-up to #361, 2026-11-03). Loopback and unix sockets (a local postgres) still
// connect. The runner also gives every client a placeholder key and a dead database, and sets DOTENV_CONFIG_PATH to /dev/null.
// A refused call throws (or errors its socket) AND is logged, and the runner fails the run on any refused line, so a swallowed
// error still fails loudly. Each stubbed call is counted (MODEL_GUARD_LOG) so the runner can show which tests lean on the stub:
// a test whose result depends on what a model says belongs in layer 2 or must inject its own fake, not read the canned answer.
// A model call from a test not on evals/lib/modelStubAllowed.json (the files that leaned on the canned answer when this rule
// landed) is refused the same way: a new test injects its own fake for anything that would call a model.
import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";

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

// The paid hosts named in the refusal, so the line says what it would have cost (model, voice, telephony, texting, search).
const PAID = /(^|\.)(anthropic\.com|openai\.com|twilio\.com|sendblue\.(co|com)|elevenlabs\.io|exa\.ai|hume\.ai)$/;
const refusal = (host, how) => {
  log("refused", host);
  const msg = `LAYER 1: a logic test tried a real ${how} to ${host}${PAID.test(host.replace(/:\d+$/, "")) ? " (a paid model, voice, telephony or texting host)" : ""}. Layer 1 makes no outside calls: inject a fake for it, or move the test to layer 2 (evals/live).`;
  try { process.stderr.write(`\n${msg}\n`); } catch {}
  return new Error(msg);
};

// Files allowed to lean on the canned model answer (grandfathered when the rule landed; shrink it, never grow it).
let stubAllowed = null;
const mayStub = () => {
  if (stubAllowed === null) {
    try { stubAllowed = new Set(JSON.parse(readFileSync(new URL("./modelStubAllowed.json", import.meta.url), "utf8")).files); } catch { stubAllowed = new Set(); }
  }
  const f = process.env.MODEL_GUARD_FILE;
  // Run outside the runner (no file named): the canned answer, as before; the socket guard below still holds.
  return !f || stubAllowed.has(f);
};

const real = globalThis.fetch;
globalThis.__LAYER1_GUARD__ = true;
globalThis.fetch = async function stubbedFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let host = "";
  try { host = new URL(url).host; } catch { return real(input, init); }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) return real(input, init);
  const model = /api\.anthropic\.com$/.test(host) || (/api\.openai\.com$/.test(host) && /\/embeddings/.test(url));
  if (model && !mayStub()) throw refusal(host, "model call (not stubbed by the test)");
  if (/api\.anthropic\.com$/.test(host)) { log("stubbed", host); return stubAnthropic(init); }
  if (/api\.openai\.com$/.test(host) && /\/embeddings/.test(url)) { log("stubbed", host); return stubEmbeddings(init); }
  throw refusal(host, "call");
};

// Below fetch: every outside socket (http/https agents, websockets, axios SDKs, raw net/tls) goes through net.Socket.connect, so
// it's refused here. Loopback and unix sockets connect as before.
const LOOPBACK = /^(localhost|127(\.\d+){3}|::1|\[::1\]|0\.0\.0\.0)$/i;
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0]; // net.connect passes its normalized [options, cb]
  const opts = o && typeof o === "object" ? o : typeof o === "number" || /^\d+$/.test(String(o)) ? { port: o, host: typeof args[1] === "string" ? args[1] : undefined } : { path: o };
  if (opts.path) return realConnect.apply(this, args);
  const host = String(opts.host ?? "localhost");
  if (LOOPBACK.test(host)) return realConnect.apply(this, args);
  const err = refusal(`${host}:${opts.port ?? "?"}`, "connection");
  process.nextTick(() => this.destroy(err));
  return this;
};
