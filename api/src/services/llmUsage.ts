// What each Claude call costs (Royce, 2026-09-23: "add the logging then
// caching"). Every generateText call already carries experimental_telemetry,
// so the AI SDK emits one "ai.generateText.doGenerate" span per request to
// Claude (one per step in a tool loop), with the token counts split by how
// they're billed. This span processor reads those numbers off the span and
// writes one llm_usage row per request. No prompt or reply text is read or
// stored, only the call's name, the model and the counts.
//
// Runs alongside Langfuse (telemetry.ts) and works without it.
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// USD per million tokens (Anthropic list prices, checked 2026-09-23).
// Cache writes are the 5-minute kind (1.25x input); reads are 0.1x input.
// Web search is billed per search, not per token: $10 per 1,000.
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
export const WEB_SEARCH_USD = 0.01;

export function priceFor(model: string) {
  // "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
}

export type UsageRow = {
  functionId: string;
  // The whole generateText call; a tool loop writes one row per step under
  // the same id, so a reply's full cost is the sum over its trace.
  traceId: string | null;
  model: string;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  webSearches: number;
  costUsd: number | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Pure, so the mapping can be checked without a span (evals/llmUsage/rules.ts).
export function usageFromSpan(name: string, attrs: Record<string, unknown>, traceId: string | null = null): UsageRow | null {
  if (!/^ai\.(generateText|streamText|generateObject|streamObject)\.do(Generate|Stream)$/.test(name)) return null;
  const model = String(attrs["ai.response.model"] ?? attrs["ai.model.id"] ?? "unknown");
  const cacheRead = num(attrs["ai.usage.inputTokenDetails.cacheReadTokens"]);
  const cacheWrite = num(attrs["ai.usage.inputTokenDetails.cacheWriteTokens"]);
  const total = num(attrs["ai.usage.inputTokens"]);
  const noCache = attrs["ai.usage.inputTokenDetails.noCacheTokens"];
  const inputUncached = typeof noCache === "number" ? noCache : Math.max(0, total - cacheRead - cacheWrite);
  const output = num(attrs["ai.usage.outputTokens"]);
  let webSearches = 0;
  try {
    const meta = JSON.parse(String(attrs["ai.response.providerMetadata"] ?? "{}"));
    webSearches = num(meta?.anthropic?.usage?.server_tool_use?.web_search_requests);
  } catch {}
  const p = priceFor(model);
  const costUsd = p
    ? (inputUncached * p.input + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + output * p.output) / 1_000_000 +
      webSearches * WEB_SEARCH_USD
    : null;
  return {
    functionId: String(attrs["ai.telemetry.functionId"] ?? "unnamed"),
    traceId,
    model,
    inputUncached,
    cacheRead,
    cacheWrite,
    output,
    webSearches,
    costUsd,
  };
}

// Rows are written in batches so a reply never waits on the database.
const buffer: UsageRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  timer = null;
  const rows = buffer.splice(0, buffer.length);
  if (!rows.length) return;
  try {
    const { default: pool } = await import("../db/db.js");
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(r.functionId, r.traceId, r.model, r.inputUncached, r.cacheRead, r.cacheWrite, r.output, r.webSearches, r.costUsd);
      const b = i * 9;
      return `(${Array.from({ length: 9 }, (_, k) => `$${b + k + 1}`).join(",")})`;
    });
    await pool.query(
      `INSERT INTO llm_usage (function_id, trace_id, model, input_uncached, cache_read, cache_write, output, web_searches, cost_usd) VALUES ${tuples.join(",")}`,
      values,
    );
  } catch (err: any) {
    console.error(`llmUsage: write failed (non-fatal): ${err?.message ?? err}`);
  }
}

export function recordUsage(row: UsageRow): void {
  buffer.push(row);
  if (buffer.length >= 50) void flush();
  else if (!timer) {
    timer = setTimeout(() => void flush(), 10_000);
    timer.unref?.();
  }
}

export class LlmUsageSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _ctx: Context): void {}
  onEnd(span: ReadableSpan): void {
    const row = usageFromSpan(span.name, span.attributes as Record<string, unknown>, span.spanContext().traceId);
    if (row) recordUsage(row);
  }
  async forceFlush(): Promise<void> {
    await flush();
  }
  async shutdown(): Promise<void> {
    await flush();
  }
}
