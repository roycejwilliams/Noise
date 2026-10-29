// A dead model key is an outage (efficiency audit, 2026-10-29: the Anthropic key was rejected 10-23 to 10-27, every cost row read $0
// and nobody heard). Layer 1: no network (a mock model that fails, a fake stream), no database (rows captured before the write), no
// text sent (the alert's send is injected).
//
//   npx tsx evals/llmUsage/keyAlert.ts
import { readFileSync } from "fs";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { APICallError } from "@ai-sdk/provider";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LlmUsageSpanProcessor, captureUsageForTest, spanFailure, usageFromSpan, type UsageRow } from "../../src/services/llmUsage.js";
import {
  KEY_ALERT_EVERY_MS,
  KEY_DEAD_TEXT,
  classifyModelFailure,
  createKeyAlert,
  failureLabel,
  providerOf,
  setKeyAlertForTests,
  type ModelFailure,
  type Provider,
} from "../../src/services/modelKeyAlert.js";
import { anthropicStream, toAnthropic } from "../../src/services/callLlmProxy.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${info === undefined ? "" : ` :: ${JSON.stringify(info)}`}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- what kind of failure
{
  const k = (e: unknown) => classifyModelFailure(e).kind;
  check("401 is a refused key", k({ statusCode: 401, message: "whatever" }) === "auth");
  check("403 is a refused key", k({ status: 403, message: "" }) === "auth");
  check("Anthropic's own words, with no status: invalid x-api-key", k({ message: "invalid x-api-key" }) === "auth");
  check("the audit's log line (\"This API key is no longer valid\")", k("search loop failed (invalid x-api-key / This API key is no longer valid)") === "auth");
  check("authentication_error in a raw body", k({ message: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }) === "auth");
  check("OpenAI's words: Incorrect API key provided", k({ message: "Incorrect API key provided: sk-...abc" }) === "auth");
  check("the call proxy's thrown line (anthropic 401: ...) reads its status", classifyModelFailure("anthropic 401: {}").status === 401 && k("anthropic 401: {}") === "auth");
  check("429 is a rate limit, not a dead key", k({ statusCode: 429, message: "rate_limit_error" }) === "rate_limit");
  check("529 / overloaded is not a dead key", k({ statusCode: 529, message: "Overloaded" }) === "overloaded" && k({ message: "overloaded_error" }) === "overloaded");
  check("a timeout is not a dead key", k({ name: "AbortError", message: "This operation was aborted" }) === "timeout");
  check("a too-long prompt is an error, not a dead key", k({ statusCode: 400, message: "prompt is too long: 210000 tokens > 200000 maximum" }) === "error");
  check("a server error is an error", k({ statusCode: 500, message: "Internal server error" }) === "error");
  check("the label keeps kind and status only", failureLabel({ kind: "auth", status: 401 }) === "auth (401)" && failureLabel({ kind: "error", status: null }) === "error");
  check("providers by model and SDK provider name", providerOf("anthropic.messages") === "anthropic" && providerOf("claude-sonnet-5") === "anthropic" && providerOf("openai.embedding") === "openai" && providerOf("gateway") === "jev" && providerOf("mock-provider") === null);
}

// ---------------------------------------------------------------- once an hour per provider
{
  let t = 1_000_000;
  const sent: string[] = [];
  const recorded: string[] = [];
  let sendOk = true;
  const a = createKeyAlert({ send: async (text) => (sent.push(text), sendOk), record: async (p) => void recorded.push(p), now: () => t });
  const auth: ModelFailure = { kind: "auth", status: 401 };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  check("a non-auth failure never alerts", a.note("anthropic", { kind: "rate_limit", status: 429 }) === false && sent.length === 0);
  check("the first refused request alerts", a.note("anthropic", auth) === true);
  await flush();
  check("one text, the fixed line, and one decision row", sent.length === 1 && sent[0] === KEY_DEAD_TEXT.anthropic && recorded.join() === "anthropic");
  t += 10 * 60_000;
  for (let i = 0; i < 40; i++) a.note("anthropic", auth);
  await flush();
  check("40 more refused requests inside the hour: still one text", sent.length === 1);
  check("another provider has its own hour", a.note("openai", auth) === true);
  await flush();
  check("its own fixed line", sent.length === 2 && sent[1] === KEY_DEAD_TEXT.openai);
  t += KEY_ALERT_EVERY_MS;
  check("an hour later, still failing: one more", a.note("anthropic", auth) === true);
  await flush();
  check("the hourly repeat went", sent.length === 3);
  // A text that didn't go doesn't use up the hour.
  t += KEY_ALERT_EVERY_MS;
  sendOk = false;
  a.note("anthropic", auth);
  await flush();
  sendOk = true;
  check("after a send that didn't go, the next refused request tries again", a.note("anthropic", auth) === true);
  await flush();
  check("so the alert isn't lost", sent.length === 5);
  // The decision row: once an hour per provider, whether or not the text went.
  {
    let t2 = 5_000_000;
    const rows2: string[] = [];
    const texts: string[] = [];
    const b = createKeyAlert({ send: async (text) => (texts.push(text), false), record: async (p) => void rows2.push(p), now: () => t2 });
    for (let i = 0; i < 30; i++) {
      b.note("anthropic", auth);
      await flush();
    }
    check("no team phone (the text never goes): 30 refused requests write one decision row, not 30", rows2.length === 1, rows2);
    check("and the text is still retried on each refused request (a failed send doesn't burn the hour)", texts.length === 30, texts.length);
    t2 += KEY_ALERT_EVERY_MS;
    b.note("anthropic", auth);
    b.note("openai", auth);
    await flush();
    check("an hour later: one more row; another provider has its own", rows2.join() === "anthropic,anthropic,openai", rows2);
  }
  for (const [p, line] of Object.entries(KEY_DEAD_TEXT) as [Provider, string][]) {
    check(`${p}: the line is team-facing, names the key, carries no member data`, /^Cue alert: /.test(line) && /_KEY\)/.test(line) && !/\$\{/.test(line));
  }
}

// ---------------------------------------------------------------- a real AI SDK call that the provider refuses
const rows: UsageRow[] = [];
captureUsageForTest((r) => rows.push(r));
const noted: { provider: Provider; f: ModelFailure }[] = [];
setKeyAlertForTests({ note: (provider: Provider, f: ModelFailure) => (noted.push({ provider, f }), f.kind === "auth") });
{
  const provider = new BasicTracerProvider({ spanProcessors: [new LlmUsageSpanProcessor()] });
  const tracer = provider.getTracer("t");
  const refusing = (statusCode: number, message: string) =>
    new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-5",
      doGenerate: async () => {
        throw new APICallError({ message, url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode, isRetryable: false });
      },
    });
  const ok = new MockLanguageModelV3({
    provider: "anthropic.messages",
    modelId: "claude-sonnet-5",
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" } as any,
      usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } as any,
      warnings: [],
    }),
  });
  rows.length = 0;
  noted.length = 0;
  const threw = await generateText({ model: refusing(401, "invalid x-api-key"), prompt: "p", maxRetries: 0, experimental_telemetry: { isEnabled: true, functionId: "t.dead", tracer } }).then(() => false, () => true);
  check("the refused call still fails for its caller (nothing else changes)", threw);
  const dead = rows.find((r) => r.functionId === "t.dead");
  check("the cost row says the request failed, and why (kind and status class only)", dead?.error === "auth" && dead?.costUsd === 0 && dead?.inputUncached === 0, dead);
  check("no silent $0 row: every row of the refused call carries its error", rows.length >= 1 && rows.every((r) => !!r.error), rows);
  check("the refused key reached the alert, as Anthropic's", noted.length === 1 && noted[0].provider === "anthropic" && noted[0].f.kind === "auth", noted);
  check("the error's message is never stored on the row", !JSON.stringify(rows).includes("x-api-key"));

  rows.length = 0;
  noted.length = 0;
  await generateText({ model: refusing(500, "Internal server error"), prompt: "p", maxRetries: 0, experimental_telemetry: { isEnabled: true, functionId: "t.500", tracer } }).catch(() => null);
  check("a server error is recorded as a failure too, without an alert", rows.find((r) => r.functionId === "t.500")?.error === "error" && noted.every((n) => n.f.kind !== "auth"), { rows, noted });

  rows.length = 0;
  noted.length = 0;
  await generateText({ model: ok, prompt: "p", experimental_telemetry: { isEnabled: true, functionId: "t.ok", tracer } });
  check("a call that went through: error null, its tokens as before, no alert", rows.find((r) => r.functionId === "t.ok")?.error === null && rows[0]?.inputUncached === 7 && noted.length === 0, rows);

  // The pure mapping: only request spans in error, never the call around them (it fails with the same error: counted once).
  check("spanFailure: the request span in error", spanFailure("ai.generateText.doGenerate", { code: 2, message: "invalid x-api-key" })?.kind === "auth");
  check("spanFailure: the wrapping call span is not counted again", spanFailure("ai.generateText", { code: 2, message: "invalid x-api-key" }) === null);
  check("spanFailure: an embedding request in error counts (OpenAI's key)", spanFailure("ai.embed.doEmbed", { code: 2, message: "Incorrect API key provided" })?.kind === "auth");
  check("spanFailure: a span that went through is no failure", spanFailure("ai.generateText.doGenerate", { code: 1 }) === null && spanFailure("ai.generateText.doGenerate", undefined) === null);
  check("usageFromSpan without an error keeps error null", usageFromSpan("ai.generateText.doGenerate", { "ai.response.model": "claude-haiku-5-5" })?.error === null);
}

// ---------------------------------------------------------------- a call turn the provider refuses
{
  const fakeFetch = (async () => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 })) as unknown as typeof fetch;
  const req = toAnthropic({ messages: [{ role: "user", content: "hello" }] } as any);
  rows.length = 0;
  noted.length = 0;
  const threw = await (async () => {
    try {
      for await (const _ of anthropicStream(req, "k", fakeFetch, "11111111-2222-4333-8444-555555555555")) { /* drain */ }
      return false;
    } catch {
      return true;
    }
  })();
  check("a refused call turn still throws as before", threw);
  check("a refused call turn writes its failed call.turn row (auth (401), $0)", rows.length === 1 && rows[0].functionId === "call.turn" && rows[0].error === "auth (401)" && rows[0].costUsd === 0 && rows[0].userId === "11111111-2222-4333-8444-555555555555", rows);
  check("and raises the alert as Anthropic's", noted.length === 1 && noted[0].provider === "anthropic", noted);
}

// ---------------------------------------------------------------- an embedding request OpenAI refuses (the openai SDK, no AI SDK span)
{
  // A real openai client, answered by a stub server response: a 401 with OpenAI's own error body.
  const { default: OpenAI } = await import("openai");
  let embedCalls = 0;
  const stubFetch = (async () => {
    embedCalls++;
    return new Response(JSON.stringify({ error: { message: "Incorrect API key provided: ci", type: "invalid_request_error", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const EM = await import("../../src/services/embeddings.js");
  EM.setEmbeddingsClientForTests(new OpenAI({ apiKey: "ci", fetch: stubFetch, maxRetries: 0 }));
  try {
    noted.length = 0;
    const one = await EM.generateEmbedding("hello").then(() => "ok", (err: any) => String(err?.status ?? err?.message ?? err));
    check("a refused embedding still fails for its caller, as before", one === "401", one);
    check("and raises the alert as OpenAI's", noted.length === 1 && noted[0].provider === "openai" && noted[0].f.kind === "auth" && noted[0].f.status === 401, noted);
    noted.length = 0;
    const many = await EM.generateEmbeddings(["a", "b"]).then(() => "ok", (err: any) => String(err?.status ?? err?.message ?? err));
    check("the batch embedding too", many === "401" && noted.length === 1 && noted[0].provider === "openai", { many, noted });
    check("the stub was what answered (no real request)", embedCalls === 2, embedCalls);
  } finally {
    EM.setEmbeddingsClientForTests(null);
  }
}

// ---------------------------------------------------------------- wiring
{
  check("migration: the error column is added idempotently", /ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS error TEXT/.test(src("db/migrations.ts")));
  check("the writer inserts the error column", /cost_usd, user_id, error\) VALUES/.test(src("services/llmUsage.ts")));
  check("the Jev gateway's refused key reaches the alert", /noteModelFailure\("jev", classifyModelFailure\(err\)\)/.test(src("services/jevGateway.ts")));
  const mk = src("services/modelKeyAlert.ts");
  check("the alert goes through the team-alert text path, never an email", /sendAlertText/.test(mk) && !/sendReportEmail|alertTeamNow|Resend/.test(mk));
}

setKeyAlertForTests(null);
captureUsageForTest(null);
console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
