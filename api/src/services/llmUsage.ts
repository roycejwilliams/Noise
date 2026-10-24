// What each Claude call costs (Royce, 2026-09-23: "add the logging then
// caching"). Every generateText call already carries experimental_telemetry,
// so the AI SDK emits one "ai.generateText.doGenerate" span per request to
// Claude (one per step in a tool loop), with the token counts split by how
// they're billed. This span processor reads those numbers off the span and
// writes one llm_usage row per request. No prompt or reply text is read or
// stored, only the call's name, the model and the counts.
//
// Runs alongside Langfuse (telemetry.ts) and works without it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// USD per million tokens (Anthropic list prices, checked 2026-09-23).
// Cache writes are the 5-minute kind (1.25x input); reads are 0.1x input.
// Web search is billed per search, not per token: $10 per 1,000.
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Prompts up to 100k tokens (the rate is 5x above that; no Co prompt comes near it).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};
export const WEB_SEARCH_USD = 0.01;

export function priceFor(model: string) {
  // "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
}

export type UsageRow = {
  functionId: string;
  // Who the call was for (2026-10-23, cost per member): the member's users.id, or null for a call that isn't about one member
  // (a room-level read, a review across members) and for one nobody marked yet. Only the id, never a name.
  userId: string | null;
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

// ---------------------------------------------------------------- who a call was for
// A call site that has the member's id says so in its telemetry (`metadata: { userId }`); one that is deliberately about no
// single member says `metadata: NO_MEMBER` (an id that may be missing passes `?? ""`, which means "the scope's"). Everything else (the many small readers that only see text) is
// attributed by the scope it runs in: the inbound text, the call, a member's task or dispatch each run inside withMember, and
// every model call started inside it (awaited or fire-and-forget) belongs to that member.
// A separate key, not a fake id, so Langfuse never shows a made-up "user" for these.
export const NO_MEMBER = { noMember: true } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asMemberId = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);

const memberScope = new AsyncLocalStorage<{ userId: string | null }>();
// Runs fn with every model call inside it attributed to userId (null: a scope whose member is learned later, see setScopeMember).
export function withMember<T>(userId: string | null | undefined, fn: () => T): T {
  return memberScope.run({ userId: asMemberId(userId) }, fn);
}
// For a scope opened before the member is known (the inbound text: the number is looked up inside it). Outside a scope it does
// nothing.
export function setScopeMember(userId: string | null | undefined): void {
  const s = memberScope.getStore();
  if (s) s.userId = asMemberId(userId);
}
export const scopeMember = (): string | null => memberScope.getStore()?.userId ?? null;

// The span's own say wins (an explicit NO_MEMBER stays null even inside a member's scope); then the scope it started in.
function userIdOf(attrs: Record<string, unknown>, fromScope: string | null): string | null {
  if (attrs["ai.telemetry.metadata.noMember"] === true) return null;
  return asMemberId(attrs["ai.telemetry.metadata.userId"]) ?? fromScope;
}

// Pure, so the mapping can be checked without a span (evals/llmUsage/rules.ts).
export function usageFromSpan(name: string, attrs: Record<string, unknown>, traceId: string | null = null, scopeUserId: string | null = null): UsageRow | null {
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
    userId: userIdOf(attrs, scopeUserId),
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
      values.push(r.functionId, r.traceId, r.model, r.inputUncached, r.cacheRead, r.cacheWrite, r.output, r.webSearches, r.costUsd, r.userId);
      const b = i * 10;
      return `(${Array.from({ length: 10 }, (_, k) => `$${b + k + 1}`).join(",")})`;
    });
    await pool.query(
      `INSERT INTO llm_usage (function_id, trace_id, model, input_uncached, cache_read, cache_write, output, web_searches, cost_usd, user_id) VALUES ${tuples.join(",")}`,
      values,
    );
  } catch (err: any) {
    console.error(`llmUsage: write failed (non-fatal): ${err?.message ?? err}`);
  }
}

// Layer 1 tests read rows here instead of the database.
let sink: ((row: UsageRow) => void) | null = null;
export function captureUsageForTest(fn: ((row: UsageRow) => void) | null): void {
  sink = fn;
}

export function recordUsage(row: UsageRow): void {
  if (sink) return sink(row);
  buffer.push(row);
  if (buffer.length >= 50) void flush();
  else if (!timer) {
    timer = setTimeout(() => void flush(), 10_000);
    timer.unref?.();
  }
}

// A direct @anthropic-ai/sdk messages.create (or the call proxy's raw stream) has no telemetry span: its response's usage is
// written here the same way. userId left out (or not an id) means "whoever's scope this runs in"; null means no single member.
export function recordAnthropicUsage(functionId: string, model: string, usage: any, userId?: string | null): void {
  if (!usage || typeof usage !== "object") return;
  const inputUncached = num(usage.input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);
  const webSearches = num(usage.server_tool_use?.web_search_requests);
  const p = priceFor(model);
  recordUsage({
    functionId,
    userId: userId === null ? null : (asMemberId(userId) ?? scopeMember()),
    traceId: null,
    model,
    inputUncached,
    cacheRead,
    cacheWrite,
    output,
    webSearches,
    costUsd: p
      ? (inputUncached * p.input + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + output * p.output) / 1_000_000 + webSearches * WEB_SEARCH_USD
      : null,
  });
}

export class LlmUsageSpanProcessor implements SpanProcessor {
  // The member scope a request span started in, read back when it ends (bounded: a span that never ends can't grow this).
  private started = new Map<string, string | null>();
  onStart(span: Span, _ctx: Context): void {
    if (!/\.do(Generate|Stream)$/.test(span.name ?? "")) return;
    if (this.started.size > 5000) this.started.clear();
    this.started.set(span.spanContext().spanId, scopeMember());
  }
  onEnd(span: ReadableSpan): void {
    const id = span.spanContext().spanId;
    const fromScope = this.started.get(id) ?? null;
    this.started.delete(id);
    const row = usageFromSpan(span.name, span.attributes as Record<string, unknown>, span.spanContext().traceId, fromScope);
    if (row) recordUsage(row);
  }
  async forceFlush(): Promise<void> {
    await flush();
  }
  async shutdown(): Promise<void> {
    await flush();
  }
}
