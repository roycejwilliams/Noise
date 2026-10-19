// Langfuse records no text (services/langfuseNoText.ts). Zero tokens: the
// Anthropic calls hit layer 1's stub (evals/lib/modelGuard.mjs), the rest use
// the AI SDK's mock model, and the Langfuse exporter is a stub that keeps the
// exact JSON the real OTLP exporter would send. Nothing leaves the process.
//
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/langfuse/noText.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { generateText, streamText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { langfuseWithoutText, withoutText, withoutTextAttributes } from "../../src/services/langfuseNoText.js";
import { usageFromSpan } from "../../src/services/llmUsage.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// ---------------------------------------------------------------- the stub Langfuse
// Every batch is serialized exactly as @langfuse/otel's OTLPTraceExporter does
// (JsonTraceSerializer), so `sent` is the request body Langfuse would receive.
const sent: string[] = [];
const exporter: SpanExporter = {
  export(spans: ReadableSpan[], done) {
    sent.push(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)!));
    done({ code: 0 });
  },
  async shutdown() {},
};
// What the cost log and any other processor sees: the untouched span.
const local: ReadableSpan[] = [];
const localTap: SpanProcessor = { onStart() {}, onEnd: (s) => void local.push(s), forceFlush: async () => {}, shutdown: async () => {} };
const langfuse = langfuseWithoutText("development", { exporter });
const sdk = new NodeSDK({ spanProcessors: [localTap, langfuse] });
sdk.start();

// Member words that must never reach Langfuse.
const SECRET = "MAPLE-ORCHID-7731";
const SECRET_B = "QUINCE-HARBOR-4402"; // another member's private ask (matching)
const IMAGE = Buffer.from(`\x89PNG\r\n\x1a\n${"PHOTO-BYTES-".repeat(40)}${SECRET}`);
const IMAGE_B64 = IMAGE.toString("base64").slice(0, 40);
const USER = "00000000-0000-4000-8000-00000000c0de";

const usage = { inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } };
const finish = (unified: "stop" | "tool-calls") => ({ unified, raw: unified });

// ---------------------------------------------------------------- real call sites (Anthropic, stubbed)
const { captureIntent } = await import("../../src/services/profileExtraction.js");
const { describeImage } = await import("../../src/services/imageRead.js");
const { scoreAgainstStatedAsk } = await import("../../src/services/matching.js");
await captureIntent(USER, `user: I'm leaving my job in March and moving to Lisbon. ${SECRET}`);
await describeImage(IMAGE, "image/png");
await scoreAgainstStatedAsk({ type: "seeking", text: `someone who knows Lisbon rentals ${SECRET}` } as any, [
  { user_id: "u-b", goals: [`open a bakery`], intent: [{ type: "seeking", text: `private: ${SECRET_B}`, status: "active" }] },
]);

// ---------------------------------------------------------------- a tool loop, a stream, an error
const toolSteps = [
  { content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookUp", input: JSON.stringify({ q: `rentals ${SECRET}` }) }], finishReason: finish("tool-calls"), usage, warnings: [] },
  { content: [{ type: "text", text: `Here is what I found for you: ${SECRET}` }], finishReason: finish("stop"), usage, warnings: [] },
];
let toolStep = 0;
const toolModel = new MockLanguageModelV3({ modelId: "claude-mock", doGenerate: async () => toolSteps[Math.min(toolStep++, 1)] as any });
const looped = await generateText({
  model: toolModel,
  experimental_telemetry: { isEnabled: true, functionId: "eval.toolLoop", metadata: { userId: USER, note: SECRET } },
  system: `You are Cue. Member profile: ${SECRET}`,
  messages: [{ role: "user", content: `help me with ${SECRET}` }],
  tools: { lookUp: tool({ description: "look something up", inputSchema: z.object({ q: z.string() }), execute: async ({ q }) => ({ found: `result for ${q}` }) }) },
  stopWhen: stepCountIs(3),
});
check("the tool loop really called its tool", looped.steps.length === 2 && JSON.stringify(looped.steps[0].content).includes("tool-result"));

const streamModel = new MockLanguageModelV3({
  modelId: "claude-mock",
  doStream: {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: `streamed ${SECRET}` },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: finish("stop"), usage },
      ] as any,
    }),
  } as any,
});
const streamed = streamText({ model: streamModel, experimental_telemetry: { isEnabled: true, functionId: "eval.stream" }, prompt: `stream ${SECRET}` });
await streamed.text;

const failingModel = new MockLanguageModelV3({
  modelId: "claude-mock",
  doGenerate: async () => {
    // Errors often quote what the model or the member said.
    throw new TypeError(`could not parse reply "${SECRET}"`);
  },
});
let threw = false;
try {
  await generateText({ model: failingModel, maxRetries: 0, experimental_telemetry: { isEnabled: true, functionId: "eval.error" }, prompt: `fail on ${SECRET}` });
} catch {
  threw = true;
}
check("the failing call really failed", threw);

await langfuse.forceFlush();
await sdk.shutdown();

// ---------------------------------------------------------------- nothing with text was sent
const body = sent.join("\n");
const spans = sent.flatMap((s) => JSON.parse(s).resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((x: any) => x.spans)));
const attr = (s: any, k: string) => {
  const a = s.attributes.find((x: any) => x.key === k)?.value;
  return a?.stringValue ?? a?.intValue ?? a?.doubleValue ?? a?.boolValue;
};
const byFn = (fn: string) => spans.filter((s: any) => attr(s, "ai.telemetry.functionId") === fn);

check("spans were sent to the stub Langfuse at all", spans.length >= 8);
// The words below really were on the spans in process, so "not sent" means filtered, not absent.
const localText = local.map((s) => JSON.stringify(s.attributes) + JSON.stringify(s.events) + JSON.stringify(s.status)).join("\n");
check("the in-process span still holds the member's words (the cost log reads it untouched)", localText.includes(SECRET));
check("the in-process matching span holds the other member's private ask", localText.includes(SECRET_B));
check("the in-process image span holds the photo", localText.includes(IMAGE_B64));
check("the in-process tool span holds its args and result", local.some((s) => s.name === "ai.toolCall" && String(s.attributes["ai.toolCall.args"]).includes(SECRET) && String(s.attributes["ai.toolCall.result"]).includes(SECRET)));
check("the in-process error span holds the message", local.some((s) => String(s.status?.message).includes(SECRET)));
check("no member words in anything sent", !body.includes(SECRET));
check("no other member's private ask in anything sent (matching)", !body.includes(SECRET_B));
check("no image bytes in anything sent", !body.includes(IMAGE_B64) && !/data:image\//.test(body));
for (const k of [
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.prompt.toolChoice",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.providerMetadata",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "ai.telemetry.metadata.note",
  "gen_ai.prompt",
  "gen_ai.completion",
  "langfuse.observation.input",
  "langfuse.observation.output",
  "langfuse.trace.input",
  "langfuse.trace.output",
  "exception.message",
  "exception.stacktrace",
])
  check(`no ${k} attribute is sent`, !body.includes(`"key":"${k}"`));

// ---------------------------------------------------------------- what Langfuse still gets
for (const fn of ["profileExtraction.captureIntent", "sendblue.describeImage", "matching.scoreAgainstStatedAsk", "eval.toolLoop", "eval.stream", "eval.error"])
  check(`${fn}: still traced by name`, byFn(fn).length > 0);
check("trace and span ids are sent", spans.every((s: any) => /^[0-9a-f]{32}$/.test(s.traceId) && /^[0-9a-f]{16}$/.test(s.spanId)));
check("latency is sent (start and end times)", spans.every((s: any) => Number(s.endTimeUnixNano) >= Number(s.startTimeUnixNano) && Number(s.startTimeUnixNano) > 0));
check("the model is sent", byFn("sendblue.describeImage").some((s: any) => /^claude-/.test(String(attr(s, "ai.model.id")))));
check("token counts are sent", byFn("eval.toolLoop").some((s: any) => Number(attr(s, "ai.usage.inputTokens")) === 120 && Number(attr(s, "ai.usage.outputTokens")) === 7));
check("the propagated user id is sent (so a member's traces can be found)", byFn("profileExtraction.captureIntent").some((s: any) => attr(s, "user.id") === USER));
check("an AI SDK metadata user id is sent", byFn("eval.toolLoop").some((s: any) => attr(s, "ai.telemetry.metadata.userId") === USER));
check("tool calls are still visible by name", spans.some((s: any) => s.name === "ai.toolCall" && attr(s, "ai.toolCall.name") === "lookUp"));
check("the environment is sent", spans.every((s: any) => attr(s, "langfuse.environment") === "development"));
const errSpans = byFn("eval.error").filter((s: any) => s.status?.code === 2);
check("a failed call is sent as an error", errSpans.length > 0);
check("its status message is the error class only", errSpans.every((s: any) => s.status.message === "TypeError"));
check("its exception event keeps only the type", errSpans.some((s: any) => s.events?.some((e: any) => e.name === "exception" && e.attributes.length === 1 && attr(e, "exception.type") === "TypeError")));

// The cost log reads the same spans and still gets its numbers.
const rows = local.map((s) => usageFromSpan(s.name, s.attributes as any, s.spanContext().traceId)).filter(Boolean);
check("llm_usage rows still come from the same spans", rows.some((r) => r!.functionId === "eval.toolLoop" && r!.inputUncached === 100));

// ---------------------------------------------------------------- hardening (review, 2026-10-18)
{
  // Number-only prefixes keep numbers and booleans, never a string (a stop sequence, a note).
  const kept = withoutTextAttributes({ "ai.settings.stopSequences": SECRET, "ai.settings.note": SECRET, "ai.usage.note": SECRET, "gen_ai.request.stop": SECRET, "gen_ai.usage.note": SECRET, "ai.usage.inputTokens": 5, "ai.settings.maxRetries": 2, "gen_ai.request.temperature": 0.3 });
  check("strings under number-only prefixes are dropped", !JSON.stringify(kept).includes(SECRET));
  check("numbers under them are kept", kept["ai.usage.inputTokens"] === 5 && kept["ai.settings.maxRetries"] === 2 && kept["gen_ai.request.temperature"] === 0.3);
  // A span with a link and an event nobody listed: neither reaches Langfuse.
  const fake: any = {
    name: "ai.generateText",
    attributes: { "ai.telemetry.functionId": "eval.fake", "ai.prompt": SECRET },
    events: [{ name: `custom ${SECRET}`, time: [0, 0], attributes: { note: SECRET } }, { name: "ai.stream.firstChunk", time: [0, 0], attributes: { "ai.response.msToFirstChunk": 12, "ai.response.text": SECRET } }],
    links: [{ context: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }, attributes: { note: SECRET } }],
    status: { code: 0 },
    spanContext: () => ({ traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 }),
  };
  const v = withoutText(fake) as any;
  check("links are never sent", Array.isArray(v.links) && v.links.length === 0);
  check("an event that isn't on the known list is dropped", !v.events.some((e: any) => e.name.includes("custom")) && v.events.length === 1);
  check("a known event keeps only allowlisted keys", v.events[0].name === "ai.stream.firstChunk" && v.events[0].attributes["ai.response.msToFirstChunk"] === 12 && !JSON.stringify(v.events).includes(SECRET));
  check("the view of a hand-built span has no text at all", !JSON.stringify({ a: v.attributes, e: v.events, l: v.links, s: v.status }).includes(SECRET));
}

// ---------------------------------------------------------------- one place, every call site
const srcRoot = new URL("../../src/", import.meta.url).pathname;
const coTestRoot = new URL("../../../co-test/src/", import.meta.url).pathname;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
const files = [...walk(srcRoot), ...walk(coTestRoot)].map((p) => ({ p, t: readFileSync(p, "utf8") }));
const rel = (p: string) => p.replace(/^.*\/(api|co-test)\/src\//, "$1/src/");
const traced = files.filter((f) => /experimental_telemetry/.test(f.t));
check("there are traced call sites to cover", traced.length > 40);
for (const f of files) {
  if (/new LangfuseSpanProcessor\(/.test(f.t) && !f.p.endsWith("services/langfuseNoText.ts")) check(`${rel(f.p)}: builds Langfuse only through langfuseWithoutText`, false);
  if (/new (NodeSDK|BasicTracerProvider|NodeTracerProvider)\(|setGlobalTracerProvider\(|addSpanProcessor\(/.test(f.t) && !/(api|co-test)\/src\/telemetry\.ts$/.test(f.p))
    check(`${rel(f.p)}: no second tracer setup outside telemetry.ts`, false);
  // A call site with its own tracer would bypass the global one (and the filter).
  if (/experimental_telemetry[^}]*\btracer\s*:/.test(f.t)) check(`${rel(f.p)}: no per-call tracer`, false);
  // Only propagateAttributes (ids and names) from @langfuse/tracing; its other calls set input and output.
  const m = f.t.match(/import\s*\{([^}]*)\}\s*from\s*"@langfuse\/tracing"/);
  if (m && m[1].split(",").map((x) => x.trim()).some((x) => x && x !== "propagateAttributes")) check(`${rel(f.p)}: only propagateAttributes from @langfuse/tracing`, false);
}
for (const p of ["telemetry.ts", "../../co-test/src/telemetry.ts"]) {
  const t = readFileSync(join(srcRoot, p), "utf8");
  check(`${p}: Langfuse is built with langfuseWithoutText`, /spanProcessors\.push\(langfuseWithoutText\(/.test(t) && !/new LangfuseSpanProcessor\(/.test(t));
}
check("no switch turns text back on", !/process\.env/.test(readFileSync(join(srcRoot, "services/langfuseNoText.ts"), "utf8")));

console.log(`\nlangfuse no-text: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
