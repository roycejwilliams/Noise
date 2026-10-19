// Langfuse records no text (Royce, 2026-10-18: "forget by default"). Langfuse
// used to keep the full prompt and output of almost every traced call: whole
// reply prompts, call transcripts, member photos, matching prompts holding
// other members' private asks. Most traces had no user id, so a member's words
// could not be found there to forget them, and cost is already in our own
// llm_usage table (services/llmUsage.ts, which reads the unfiltered span in
// process and stores only names and counts).
//
// So every span is cut down here, in one place, before Langfuse sees it. This
// is an allowlist: only the keys below leave the process, so a new call site,
// a new AI SDK attribute or a new tool cannot add text by forgetting a flag.
// What goes: trace and span ids, names (functionId, trace name), model,
// token counts, settings that are numbers, latency (span times), status code
// and the error's class. What never goes: prompts, messages, tool args and
// results, outputs, schemas, images, provider metadata, request headers,
// free-form metadata, and error messages or stack traces (those can quote the
// member's words, e.g. a parse error that echoes the reply).
//
// There is no switch to turn text back on (no feature toggles). If debugging
// ever needs text in Langfuse, that is a separate decision for Royce.
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Kept whatever the value's type: ids, names and model strings.
const KEEP = new Set([
  // AI SDK: which call, which model, how it ended.
  "operation.name",
  "ai.operationId",
  "resource.name",
  "ai.telemetry.functionId",
  "ai.telemetry.metadata.userId",
  "ai.telemetry.metadata.sessionId",
  "ai.model.id",
  "ai.model.provider",
  "ai.response.id",
  "ai.response.model",
  "ai.response.finishReason",
  "ai.response.timestamp",
  "ai.toolCall.name",
  "ai.toolCall.id",
  "gen_ai.system",
  "gen_ai.request.model",
  "gen_ai.response.id",
  "gen_ai.response.model",
  "gen_ai.response.finish_reasons",
  // Langfuse's own: trace name, user, session, environment, root markers.
  "langfuse.trace.name",
  "user.id",
  "session.id",
  "langfuse.user.id",
  "langfuse.session.id",
  "langfuse.environment",
  "langfuse.release",
  "langfuse.version",
  "langfuse.internal.as_root",
  "langfuse.internal.is_app_root",
  "langfuse.observation.type",
  "langfuse.observation.level",
  "langfuse.observation.model.name",
  "langfuse.observation.completion_start_time",
  "langfuse.observation.usage_details",
  "langfuse.observation.cost_details",
  // Streaming latency (numbers).
  "ai.response.msToFirstChunk",
  "ai.response.msToFinish",
  "ai.response.avgOutputTokensPerSecond",
  "ai.stream.msToFirstChunk",
]);
// Kept only when the value is a number or a boolean: token counts and settings
// like temperature or maxOutputTokens (stop sequences and the like are dropped).
const NUMERIC_PREFIXES = ["ai.usage.", "gen_ai.usage.", "ai.settings.", "gen_ai.request."];

export function keptAttribute(key: string, value: unknown): boolean {
  if (KEEP.has(key)) return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  if (NUMERIC_PREFIXES.some((p) => key.startsWith(p))) return typeof value === "number" || typeof value === "boolean";
  return false;
}

export function withoutTextAttributes(attrs: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (keptAttribute(k, v)) out[k] = v;
  return out;
}

// An error's class (e.g. "AI_APICallError") is kept; its message never is.
export function errorClass(name: unknown): string | undefined {
  return typeof name === "string" && /^[A-Za-z0-9_.$-]{1,80}$/.test(name) ? name : name == null ? undefined : "Error";
}

// Only events the AI SDK sends with no text: any other event (its name could be anything) is dropped.
const KNOWN_EVENTS = new Set(["exception", "ai.stream.firstChunk", "ai.stream.finish"]);
function withoutTextEvents(events: TimedEvent[]): TimedEvent[] {
  return (events ?? []).filter((e) => KNOWN_EVENTS.has(e.name)).map((e) =>
    e.name === "exception"
      ? { name: e.name, time: e.time, droppedAttributesCount: 0, attributes: { "exception.type": errorClass(e.attributes?.["exception.type"]) ?? "Error" } }
      : { name: e.name, time: e.time, droppedAttributesCount: 0, attributes: withoutTextAttributes((e.attributes ?? {}) as Record<string, unknown>) },
  );
}

// A view of the span with the text left out. The original is not changed, so
// the cost log (or any other processor) still reads its own numbers from it.
export function withoutText(span: ReadableSpan): ReadableSpan {
  const view = Object.create(span) as ReadableSpan;
  const exception = (span.events ?? []).find((e) => e.name === "exception");
  Object.defineProperties(view, {
    attributes: { value: withoutTextAttributes(span.attributes as Record<string, unknown>), enumerable: true, writable: true },
    events: { value: withoutTextEvents(span.events as TimedEvent[]), enumerable: true },
    // A link carries another span's attributes; none is sent.
    links: { value: [], enumerable: true },
    status: {
      value: { code: span.status?.code, message: exception ? errorClass(exception.attributes?.["exception.type"]) : undefined },
      enumerable: true,
    },
  });
  return view;
}

// Wraps the Langfuse processor: spans start as normal (Langfuse adds its
// environment and propagated user id there) and are cut down when they end.
export class NoTextSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}
  onStart(span: Span, ctx: Context): void {
    this.inner.onStart(span, ctx);
  }
  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(withoutText(span));
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

// The only way telemetry.ts (api and co-test) builds the Langfuse processor.
// `exporter` is for tests (a stub that captures what would be sent).
export function langfuseWithoutText(environment: string, opts: { exporter?: SpanExporter } = {}): SpanProcessor {
  return new NoTextSpanProcessor(
    new LangfuseSpanProcessor({
      environment,
      // No media is ever uploaded (member photos went up as Langfuse media).
      mediaUploadEnabled: false,
      ...(opts.exporter ? { exporter: opts.exporter, exportMode: "immediate" as const } : {}),
    }),
  );
}
