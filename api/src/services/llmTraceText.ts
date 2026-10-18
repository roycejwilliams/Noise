// Our own copy of each model request's text, for debugging (Royce, 2026-10-18: "losing debuggability is not acceptable").
// Langfuse gets no text (services/langfuseNoText.ts); the trace id it shows is looked up here, on the co-test dashboard
// (team only), to read the exact prompt and answer. Kept on our side so forgetting reaches it:
//   - 14 days, then a daily job deletes it (TRACE_TEXT.retentionDays: a constant, not a switch);
//   - every row carries the member's user id where the call has one, and goes with them: deleting the user cascades,
//     archiving an account deletes it, and any removal they ask for deletes all of their trace text (a prompt holds many
//     facts at once, so a row can't be matched to the one thing removed);
//   - rows with no user id expire on the same 14 days.
// One row per request to the model (the AI SDK's doGenerate/doStream span, one per step of a tool loop), read from the
// original span in process. Images are stored as a marker, never their bytes. Calls that turned recording off
// (recordInputs/recordOutputs false) carry no text on the span, so nothing is stored for them.
// Writing is best-effort: batched off the request path, every failure caught, a bounded buffer. A call never waits on it
// and never fails because of it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const TRACE_TEXT = {
  retentionDays: 14,
  // Per field (input and output each): about 16k tokens, enough for the whole reply prompt (~13k tokens). Longer text keeps
  // its start and its end (instructions first, the latest messages last) with the cut marked in the middle.
  maxChars: 64_000,
  batchRows: 25,
  flushMs: 5_000,
  // If the database is down, the oldest unwritten rows are dropped rather than held in memory.
  maxBuffered: 400,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_SPAN = /^ai\.(generateText|streamText|generateObject|streamObject)\.do(Generate|Stream)$/;

// ---------------------------------------------------------------- whose call it is
// Entry points that know the member mark it once (the text turn, post-call processing, the live call); every model call
// after that in the same async flow carries it. A user on the span itself wins: AI SDK metadata, or propagateAttributes
// (which reaches the span through the Langfuse processor, so only while Langfuse keys are set; the marks don't need them).
const traceUser = new AsyncLocalStorage<string>();
export function noteTraceUser(userId: string | null | undefined): void {
  if (typeof userId === "string" && UUID.test(userId)) traceUser.enterWith(userId);
}
export function currentTraceUser(): string | null {
  return traceUser.getStore() ?? null;
}

export function userIdFor(attrs: Record<string, unknown>, fromContext: string | null): string | null {
  for (const v of [attrs["user.id"], attrs["langfuse.user.id"], attrs["ai.telemetry.metadata.userId"], fromContext]) {
    if (typeof v === "string" && UUID.test(v)) return v;
  }
  return null;
}

// ---------------------------------------------------------------- what is kept
const imageMarker = (mediaType: unknown, data: unknown) =>
  `[image not stored: ${typeof mediaType === "string" ? mediaType : "image"}${typeof data === "string" ? `, ~${Math.round((data.length * 3) / 4)} bytes` : ""}]`;

// Image and file parts keep their type and size, never their bytes.
function scrubValue(v: any): any {
  if (Array.isArray(v)) return v.map(scrubValue);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, any> = {};
  const isMedia = v.type === "image" || v.type === "file";
  for (const [k, x] of Object.entries(v)) {
    if (isMedia && (k === "image" || k === "data") && !(typeof x === "string" && /^https?:\/\//.test(x))) out[k] = imageMarker(v.mediaType ?? v.mimeType, x);
    else out[k] = scrubValue(x);
  }
  return out;
}
export function withoutImages(text: string): string {
  let s = text;
  try {
    s = JSON.stringify(scrubValue(JSON.parse(text)));
  } catch {}
  // Anything left: data URIs and long base64 runs.
  return s
    .replace(/data:([a-z]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=]+/gi, (_m, t) => imageMarker(t, null))
    .replace(/[A-Za-z0-9+/]{2000,}={0,2}/g, (m) => (/[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? imageMarker("binary", m) : m));
}

export function capped(text: string, max: number = TRACE_TEXT.maxChars): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} chars cut]…\n${text.slice(text.length - tail)}`;
}

export type TraceTextRow = { traceId: string; spanId: string; userId: string | null; functionId: string; input: string | null; output: string | null; at: Date };

// Pure: one request span to one row, or null when it isn't a request or carries no text.
export function traceTextFromSpan(
  name: string,
  attrs: Record<string, unknown>,
  ids: { traceId: string; spanId: string },
  o: { userId?: string | null; status?: { code?: number; message?: string }; errorType?: string | null; at?: Date } = {},
): TraceTextRow | null {
  if (!REQUEST_SPAN.test(name)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);
  const input = str(attrs["ai.prompt.messages"]) ?? str(attrs["ai.prompt"]);
  const parts = [str(attrs["ai.response.text"]), str(attrs["ai.response.object"])].filter(Boolean) as string[];
  const tools = str(attrs["ai.response.toolCalls"]);
  if (tools) parts.push(`[tool calls] ${tools}`);
  if (o.status?.code === 2) parts.push(`[error${o.errorType ? ` ${o.errorType}` : ""}] ${o.status.message ?? ""}`.trim());
  const output = parts.length ? parts.join("\n") : null;
  if (!input && !output) return null;
  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    userId: o.userId ?? null,
    functionId: String(attrs["ai.telemetry.functionId"] ?? "unnamed"),
    input: input ? capped(withoutImages(input)) : null,
    output: output ? capped(withoutImages(output)) : null,
    at: o.at ?? new Date(),
  };
}

// ---------------------------------------------------------------- writing, best-effort
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const defaultDb = async (): Promise<Db> => (await import("../db/db.js")).default;
// Swappable for tests (a fake database); production always uses the pool.
export const traceTextStore: { db: () => Promise<Db> } = { db: defaultDb };

const buffer: TraceTextRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export async function flushTraceText(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  while (buffer.length) {
    const rows = buffer.splice(0, TRACE_TEXT.batchRows);
    try {
      const db = await traceTextStore.db();
      // A user id with no users row (a test id, a member just deleted) is stored as no user, never a failed batch.
      await db.query(
        `INSERT INTO llm_trace_text (trace_id, span_id, user_id, function_id, input, output, created_at)
         SELECT t.trace_id, t.span_id, u.id, t.function_id, t.input, t.output, t.created_at
         FROM unnest($1::text[], $2::text[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::timestamptz[])
           AS t(trace_id, span_id, user_id, function_id, input, output, created_at)
         LEFT JOIN users u ON u.id = t.user_id`,
        [rows.map((r) => r.traceId), rows.map((r) => r.spanId), rows.map((r) => r.userId), rows.map((r) => r.functionId), rows.map((r) => r.input), rows.map((r) => r.output), rows.map((r) => r.at.toISOString())],
      );
    } catch (err: any) {
      // The class only: the message could quote the text being written.
      console.error(`llmTraceText: write failed (non-fatal, ${rows.length} rows dropped): ${err?.name ?? "Error"}${err?.code ? ` ${err.code}` : ""}`);
    }
  }
}

export function recordTraceText(row: TraceTextRow): void {
  buffer.push(row);
  if (buffer.length > TRACE_TEXT.maxBuffered) buffer.splice(0, buffer.length - TRACE_TEXT.maxBuffered);
  if (buffer.length >= TRACE_TEXT.batchRows) void flushTraceText();
  else if (!timer) {
    timer = setTimeout(() => void flushTraceText(), TRACE_TEXT.flushMs);
    timer.unref?.();
  }
}

// Reads the original span (before the Langfuse filter). Never throws.
export class TraceTextSpanProcessor implements SpanProcessor {
  private users = new WeakMap<object, string>();
  onStart(span: Span, _ctx: Context): void {
    try {
      const u = currentTraceUser();
      if (u) this.users.set(span, u);
    } catch {}
  }
  onEnd(span: ReadableSpan): void {
    try {
      const exception = (span.events ?? []).find((e) => e.name === "exception");
      const row = traceTextFromSpan(span.name, span.attributes as Record<string, unknown>, { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId }, {
        userId: userIdFor(span.attributes as Record<string, unknown>, this.users.get(span) ?? null),
        status: span.status,
        errorType: typeof exception?.attributes?.["exception.type"] === "string" ? (exception.attributes["exception.type"] as string) : null,
      });
      if (row) recordTraceText(row);
    } catch (err: any) {
      console.error(`llmTraceText: reading a span failed (non-fatal): ${err?.name ?? "Error"}`);
    }
  }
  async forceFlush(): Promise<void> {
    await flushTraceText();
  }
  async shutdown(): Promise<void> {
    await flushTraceText();
  }
}

// ---------------------------------------------------------------- forgetting
// The daily job (jobs/index.ts): everything older than the window, with or without a user id.
export async function expireTraceText(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRACE_TEXT.retentionDays * 86_400_000);
  const db = await traceTextStore.db();
  const r = await db.query(`DELETE FROM llm_trace_text WHERE created_at < $1`, [cutoff.toISOString()]);
  return r.rowCount ?? 0;
}

// All of one member's trace text: on archive, and on any removal they ask for. Best-effort; never throws.
// Rows still waiting in memory go too, so none is written after the delete.
export async function forgetTraceText(userId: string, why: string): Promise<number> {
  for (let i = buffer.length - 1; i >= 0; i--) if (buffer[i].userId === userId) buffer.splice(i, 1);
  try {
    const db = await traceTextStore.db();
    const r = await db.query(`DELETE FROM llm_trace_text WHERE user_id = $1`, [userId]);
    return r.rowCount ?? 0;
  } catch (err: any) {
    console.error(`llmTraceText: forgetting user ${userId}'s trace text (${why}) failed (non-fatal): ${err?.name ?? "Error"}`);
    return 0;
  }
}

// The dashboard's lookup (co-test /api/sweeps/trace/:traceId, team only). A Langfuse trace id is 32 hex characters.
export function validTraceId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}
export async function traceTextFor(traceId: string): Promise<{ spanId: string; userId: string | null; functionId: string; createdAt: string; input: string | null; output: string | null }[]> {
  if (!validTraceId(traceId)) return [];
  const db = await traceTextStore.db();
  const { rows } = await db.query(
    `SELECT span_id, user_id, function_id, created_at, input, output FROM llm_trace_text WHERE trace_id = $1 ORDER BY created_at, id LIMIT 200`,
    [traceId],
  );
  return rows.map((r) => ({ spanId: r.span_id, userId: r.user_id ?? null, functionId: r.function_id, createdAt: new Date(r.created_at).toISOString(), input: r.input ?? null, output: r.output ?? null }));
}
