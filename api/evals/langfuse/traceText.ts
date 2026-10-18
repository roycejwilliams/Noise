// Our own trace text (services/llmTraceText.ts): each model request's prompt and answer, kept 14 days for debugging, while
// Langfuse still gets none of it. Zero tokens and no database: Anthropic calls hit layer 1's stub, the rest use the AI SDK's
// mock model, the trace-text table is an in-memory fake that answers the module's own statements, and the dashboard route
// runs on a local port.
//
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/langfuse/traceText.ts
import { readFileSync } from "fs";
import type { AddressInfo } from "net";
import express from "express";
import cookieParser from "cookie-parser";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { langfuseWithoutText } from "../../src/services/langfuseNoText.js";
import * as T from "../../src/services/llmTraceText.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the fake trace-text table
type Stored = { trace_id: string; span_id: string; user_id: string | null; function_id: string; input: string | null; output: string | null; created_at: Date };
const table: Stored[] = [];
const sqls: { sql: string; args: any[] }[] = [];
let failWrites = false;
const fakeDb = {
  async query(sql: string, args: any[] = []) {
    sqls.push({ sql, args });
    if (/^INSERT INTO llm_trace_text/.test(sql.trim())) {
      if (failWrites) throw Object.assign(new Error(`relation "llm_trace_text" does not exist (row text: ${args[4]?.[0] ?? ""})`), { code: "42P01" });
      const [tr, sp, us, fn, inp, out, at] = args;
      for (let i = 0; i < tr.length; i++) table.push({ trace_id: tr[i], span_id: sp[i], user_id: us[i], function_id: fn[i], input: inp[i], output: out[i], created_at: new Date(at[i]) });
      return { rows: [], rowCount: tr.length };
    }
    if (/^DELETE FROM llm_trace_text WHERE created_at < \$1$/.test(sql.trim())) {
      const cut = new Date(args[0]);
      const before = table.length;
      for (let i = table.length - 1; i >= 0; i--) if (table[i].created_at < cut) table.splice(i, 1);
      return { rows: [], rowCount: before - table.length };
    }
    if (/^DELETE FROM llm_trace_text WHERE user_id = \$1$/.test(sql.trim())) {
      const before = table.length;
      for (let i = table.length - 1; i >= 0; i--) if (table[i].user_id === args[0]) table.splice(i, 1);
      return { rows: [], rowCount: before - table.length };
    }
    if (/FROM llm_trace_text WHERE trace_id = \$1/.test(sql)) return { rows: table.filter((r) => r.trace_id === args[0]).map((r, id) => ({ ...r, id })) };
    throw new Error(`fake trace-text table: unexpected SQL ${sql.slice(0, 80)}`);
  },
};
T.traceTextStore.db = async () => fakeDb;

// ---------------------------------------------------------------- stub Langfuse + the trace-text processor, as telemetry.ts builds them
const sent: string[] = [];
const exporter: SpanExporter = {
  export(spans: ReadableSpan[], done) {
    sent.push(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)!));
    done({ code: 0 });
  },
  async shutdown() {},
};
const langfuse = langfuseWithoutText("development", { exporter });
const sdk = new NodeSDK({ spanProcessors: [new T.TraceTextSpanProcessor(), langfuse] });
sdk.start();

const SECRET = "MAPLE-ORCHID-7731";
const USER = "00000000-0000-4000-8000-00000000c0de";
const USER_B = "00000000-0000-4000-8000-00000000b0b0";
const IMAGE = Buffer.from(`\x89PNG\r\n\x1a\n${"PHOTO-BYTES-".repeat(400)}`);
const IMAGE_B64 = IMAGE.toString("base64").slice(0, 60);
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const textModel = (text: string) => new MockLanguageModelV3({ modelId: "claude-mock", doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) as any });

// Real call sites: captureIntent carries its user through propagateAttributes; describeImage has no user of its own.
const { captureIntent } = await import("../../src/services/profileExtraction.js");
const { describeImage } = await import("../../src/services/imageRead.js");
await captureIntent(USER, `user: I'm leaving my job in March. ${SECRET}`);
await describeImage(IMAGE, "image/png");
// A text turn marks its member once (routes/sendblue.ts noteTraceUser); a call after that is filed under them.
await (async () => {
  T.noteTraceUser(USER_B);
  await generateText({ model: textModel(`answer for ${SECRET}`), experimental_telemetry: { isEnabled: true, functionId: "eval.turn" }, prompt: `turn prompt ${SECRET}` });
})();
// Two turns at once, each marking its own member after its first await (as the webhook does): each call is filed under its own.
const turn = async (user: string, fn: string) => {
  await new Promise((r) => setTimeout(r, 5));
  T.noteTraceUser(user);
  await new Promise((r) => setTimeout(r, 5));
  await generateText({ model: textModel("ok"), experimental_telemetry: { isEnabled: true, functionId: fn }, prompt: `p ${fn}` });
};
await Promise.all([turn(USER, "eval.concurrentA"), turn(USER_B, "eval.concurrentB")]);
// A call site that turned recording off keeps nothing.
await generateText({ model: textModel(`private ${SECRET}`), experimental_telemetry: { isEnabled: true, functionId: "eval.private", recordInputs: false, recordOutputs: false }, prompt: `private ${SECRET}` });
// A long prompt is capped, start and end kept.
const LONG = `START-${"what they said about the move. ".repeat(Math.ceil((T.TRACE_TEXT.maxChars * 2) / 31))}-END ${SECRET}`;
await generateText({ model: textModel("ok"), experimental_telemetry: { isEnabled: true, functionId: "eval.long" }, prompt: LONG });
// A failed call keeps what it was asked and why it failed.
await generateText({
  model: new MockLanguageModelV3({ modelId: "claude-mock", doGenerate: async () => { throw new TypeError(`bad reply for ${SECRET}`); } }),
  maxRetries: 0,
  experimental_telemetry: { isEnabled: true, functionId: "eval.error" },
  prompt: `fail ${SECRET}`,
}).catch(() => {});
await langfuse.forceFlush();
await T.flushTraceText();

const byFn = (fn: string) => table.filter((r) => r.function_id === fn);
const body = sent.join("\n");
check("Langfuse got spans", sent.length > 0);
check("Langfuse still gets no member words", !body.includes(SECRET));
check("Langfuse still gets no image bytes", !body.includes(IMAGE_B64));
check("the prompt is stored on our side", byFn("profileExtraction.captureIntent").some((r) => r.input?.includes(SECRET)));
check("the answer is stored on our side", byFn("eval.turn").some((r) => r.output?.includes(`answer for ${SECRET}`)));
check("one row per model request, with the trace and span ids Langfuse shows", table.every((r) => /^[0-9a-f]{32}$/.test(r.trace_id) && /^[0-9a-f]{16}$/.test(r.span_id)) && table.every((r) => body.includes(r.trace_id)));
check("the propagated user id is on the row", byFn("profileExtraction.captureIntent").every((r) => r.user_id === USER) && byFn("profileExtraction.captureIntent").length > 0);
check("a member marked at the entry point is on the row", byFn("eval.turn").length === 1 && byFn("eval.turn")[0].user_id === USER_B);
const img = byFn("sendblue.describeImage");
check("the photo's call is stored", img.length === 1);
check("the photo is a marker, not its bytes", !!img[0] && !img[0].input?.includes(IMAGE_B64) && /\[image not stored: image\/png, ~\d+ bytes\]/.test(img[0].input ?? ""));
check("two turns at once: each call under its own member", byFn("eval.concurrentA")[0]?.user_id === USER && byFn("eval.concurrentB")[0]?.user_id === USER_B);
check("a call that turned recording off stores nothing", byFn("eval.private").length === 0);
const long = byFn("eval.long")[0];
check("a long prompt is capped near the limit", !!long && long.input!.length <= T.TRACE_TEXT.maxChars + 60 && /chars cut/.test(long.input!));
check("the cap keeps the start and the end", !!long && long.input!.includes("START-") && long.input!.includes(SECRET));
check("a failed call stores its error class and message", byFn("eval.error").some((r) => /\[error TypeError\] bad reply for/.test(r.output ?? "")));

// ---------------------------------------------------------------- the dashboard lookup
const someTrace = byFn("eval.turn")[0]?.trace_id ?? "";
const looked = await T.traceTextFor(someTrace);
check("a trace id returns its exact prompt and answer", looked.length === 1 && looked[0].input!.includes(`turn prompt ${SECRET}`) && looked[0].output!.includes(SECRET));
check("a malformed trace id reads nothing", (await T.traceTextFor("'; DROP TABLE users; --")).length === 0);

// ---------------------------------------------------------------- a write failure never breaks the call
failWrites = true;
const errs: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
let r: string | null = null;
try {
  r = (await generateText({ model: textModel("still answered"), experimental_telemetry: { isEnabled: true, functionId: "eval.writeFails" }, prompt: `p ${SECRET}` })).text;
  await T.flushTraceText();
} catch {
  r = null;
}
console.error = origErr;
failWrites = false;
check("the call still answers when the write fails", r === "still answered");
check("the failed write is logged without the text", errs.some((e) => /llmTraceText: write failed/.test(e)) && !errs.some((e) => e.includes(SECRET)));
{
  const p = new T.TraceTextSpanProcessor();
  let threw = false;
  try {
    p.onEnd({ name: "ai.generateText.doGenerate", get attributes(): any { throw new Error("broken span"); }, spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) }), events: [] } as any);
    p.onStart({} as any, undefined as any);
  } catch {
    threw = true;
  }
  check("a span that can't be read never throws into the call", !threw);
}
{
  const before = table.length;
  failWrites = true;
  console.error = () => {};
  for (let i = 0; i < T.TRACE_TEXT.maxBuffered + 50; i++) T.recordTraceText({ traceId: "c".repeat(32), spanId: "d".repeat(16), userId: null, functionId: "eval.flood", input: "x", output: null, at: new Date() });
  await T.flushTraceText();
  await new Promise((r) => setTimeout(r, 50));
  console.error = origErr;
  failWrites = false;
  check("with the database down, nothing piles up in memory (rows dropped, the buffer is empty after a flush)", table.length === before);
}

// ---------------------------------------------------------------- 14 days, then deleted
{
  const now = new Date("2026-10-18T12:00:00Z");
  const day = 86_400_000;
  table.length = 0;
  const row = (user: string | null, ageDays: number, fn: string): Stored => ({ trace_id: "e".repeat(32), span_id: "f".repeat(16), user_id: user, function_id: fn, input: "i", output: "o", created_at: new Date(now.getTime() - ageDays * day) });
  table.push(row(USER, 15, "old-member"), row(null, 20, "old-nouser"), row(USER, 13, "fresh-member"), row(null, 1, "fresh-nouser"), row(USER, 14.01, "just-past"));
  const n = await T.expireTraceText(now);
  check("the window is 14 days", T.TRACE_TEXT.retentionDays === 14);
  check("expiry deletes rows older than 14 days, with or without a member", n === 3 && table.map((r) => r.function_id).sort().join(",") === "fresh-member,fresh-nouser");
  const del = sqls.filter((s) => /created_at < \$1/.test(s.sql)).pop()!;
  check("the cutoff is exactly 14 days before now", del.args[0] === new Date(now.getTime() - 14 * day).toISOString());
}
const jobs = src("jobs/index.ts");
check("a daily job runs the expiry", /cron\.schedule\("35 4 \* \* \*", \(\) => \{\s*import\("\.\.\/services\/llmTraceText\.js"\)\s*\.then\(\(m\) => m\.expireTraceText\(\)\)/.test(jobs));
check("the window is a constant, never an env switch", !/process\.env/.test(src("services/llmTraceText.ts")));

// ---------------------------------------------------------------- removal, archive, member delete
{
  const now = new Date();
  table.length = 0;
  for (const u of [USER, USER, USER_B, null]) table.push({ trace_id: "1".repeat(32), span_id: "2".repeat(16), user_id: u, function_id: "x", input: "i", output: "o", created_at: now });
  // A row still waiting in memory for that member goes too.
  T.recordTraceText({ traceId: "3".repeat(32), spanId: "4".repeat(16), userId: USER, functionId: "pending", input: "i", output: null, at: now });
  const n = await T.forgetTraceText(USER, "removal");
  await T.flushTraceText();
  check("a removal deletes all of that member's trace text", n === 2 && !table.some((r) => r.user_id === USER));
  check("other members' rows and rows with no member stay", table.some((r) => r.user_id === USER_B) && table.some((r) => r.user_id === null));
  check("nothing of theirs waiting in memory is written after the delete", !table.some((r) => r.function_id === "pending"));
  T.traceTextStore.db = async () => ({ query: async () => { throw new Error("db down"); } });
  console.error = () => {};
  check("a failed forget never throws (returns 0)", (await T.forgetTraceText(USER, "removal")) === 0);
  console.error = origErr;
  T.traceTextStore.db = async () => fakeDb;
}
// archiveAccount and deleteFiles, with the pool faked: both delete the member's trace text.
{
  const pool = (await import("../../src/db/db.js")).default as any;
  const real = { query: pool.query, connect: pool.connect };
  pool.connect = async () => ({ query: async (sql: string) => (/^UPDATE users SET/.test(sql.trim()) ? { rowCount: 1, rows: [] } : { rowCount: 0, rows: [] }), release() {} });
  pool.query = async (sql: string) => (/DELETE FROM member_files/.test(sql) ? { rowCount: 1, rows: [] } : { rowCount: 0, rows: [] });
  const { archiveAccount } = await import("../../src/services/accountArchive.js");
  const { deleteFiles } = await import("../../src/services/memberFiles.js");
  table.push({ trace_id: "5".repeat(32), span_id: "6".repeat(16), user_id: USER, function_id: "a", input: "i", output: "o", created_at: new Date() });
  const a = await archiveAccount(USER);
  check("archiving an account deletes its trace text", a.archived && !table.some((r) => r.user_id === USER));
  table.push({ trace_id: "5".repeat(32), span_id: "6".repeat(16), user_id: USER_B, function_id: "a", input: "i", output: "o", created_at: new Date() });
  await deleteFiles(USER_B, 1);
  check("removing a file deletes their trace text", !table.some((r) => r.user_id === USER_B));
  // The archive still happens when the trace-text delete fails.
  T.traceTextStore.db = async () => ({ query: async () => { throw new Error("db down"); } });
  console.error = () => {};
  check("a failed trace-text delete never undoes the archive", (await archiveAccount(USER)).archived === true);
  console.error = origErr;
  T.traceTextStore.db = async () => fakeDb;
  pool.query = real.query;
  pool.connect = real.connect;
}
const what = src("services/whatCoKnows.ts");
{
  // Any applied change, a removal or a correction ("corrections delete the old value", Royce 2026-10-18), after the commit.
  const hook = what.indexOf("if (applied.length) await import(\"./llmTraceText.js\").then((T) => T.forgetTraceText(userId,");
  check("whatCoKnows: any applied removal or correction deletes their trace text", hook > 0);
  check("whatCoKnows: ...only after the change committed", hook > what.indexOf('await client.query("COMMIT");', what.indexOf("export async function applyKnowledgeChanges")));
  // A correction found in what they said (profileExtraction storeProfile): the old value goes from the trace text too.
  const pe = src("services/profileExtraction.ts");
  const block = pe.slice(pe.indexOf("  if (corrections.length) {"), pe.indexOf("  if (corrections.length) {") + 1400);
  check("a correction in conversation deletes their trace text", /if \(corrections\.length\) \{[\s\S]*?await import\("\.\/llmTraceText\.js"\)\.then\(\(T\) => T\.forgetTraceText\(user_id, "correction"\)\)\.catch\(\(\) => 0\);\n  \}/.test(block));
}
const mig = src("db/migrations.ts");
const block = mig.slice(mig.indexOf("CREATE TABLE IF NOT EXISTS llm_trace_text"), mig.indexOf('"llm_trace_text table init failed:"'));
check("migration: one additive, idempotent table", block.length > 0 && !/\b(ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/.test(block.replace("ON DELETE CASCADE", "")) && (block.match(/IF NOT EXISTS/g) ?? []).length === 4);
check("migration: user_id cascades when the member is deleted", /user_id UUID REFERENCES users\(id\) ON DELETE CASCADE/.test(block));
check("migration: the columns the writer uses", ["trace_id TEXT NOT NULL", "span_id TEXT NOT NULL", "function_id TEXT NOT NULL", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()", "input TEXT", "output TEXT"].every((c) => block.includes(c)));
check(
  "migration: indexes on trace id, member + time, and time, each IF NOT EXISTS",
  /CREATE INDEX IF NOT EXISTS idx_llm_trace_text_trace ON llm_trace_text \(trace_id\)/.test(block) && /CREATE INDEX IF NOT EXISTS idx_llm_trace_text_user ON llm_trace_text \(user_id, created_at\)/.test(block) && /CREATE INDEX IF NOT EXISTS idx_llm_trace_text_time ON llm_trace_text \(created_at\)/.test(block),
);
check("a member delete is a users row delete (the cascade does the rest)", /DELETE FROM users WHERE id = \$1/.test(src("routes/users.ts")));
for (const p of ["telemetry.ts", "../../co-test/src/telemetry.ts"]) check(`${p}: the trace-text processor runs on every span`, /spanProcessors\.push\(new TraceTextSpanProcessor\(\)\);/.test(src(p)));
check("the text turn marks its member", /let user = await findOrCreateUserByPhone\(number\);\n\s*\/\/[^\n]*\n\s*noteTraceUser\(user\?\.id\);/.test(src("routes/sendblue.ts")));
check("post-call processing marks its member", /noteTraceUser\(callUser\?\.id \?\? user_id\);/.test(src("routes/co.ts")));
check("the live call marks its member", /noteTraceUser\(userId\);/.test(src("routes/callLlm.ts")));

// ---------------------------------------------------------------- the dashboard route is team only
{
  const pool = (await import("../../src/db/db.js")).default as any;
  const realQuery = pool.query;
  const TEAM = "00000000-0000-4000-8000-0000000000aa";
  const MEMBER = "00000000-0000-4000-8000-0000000000bb";
  pool.query = async (sql: string, args: any[] = []) => {
    if (/login_session_token = \$1/.test(sql)) return { rows: args[0] === "team-tok" ? [{ id: TEAM, login_session_token: "team-tok" }] : args[0] === "member-tok" ? [{ id: MEMBER, login_session_token: "member-tok" }] : [] };
    if (/SELECT mo_approver FROM users WHERE id = \$1/.test(sql)) return { rows: [{ mo_approver: args[0] === TEAM }] };
    return { rows: [] };
  };
  table.length = 0;
  table.push({ trace_id: "7".repeat(32), span_id: "8".repeat(16), user_id: USER, function_id: "agent.conversationReply", input: `prompt ${SECRET}`, output: `answer ${SECRET}`, created_at: new Date() });
  const { default: sweeps } = await import("../../../co-test/src/routes/sweeps.js");
  const app = express();
  app.use(cookieParser());
  app.use("/api/sweeps", sweeps);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sweeps/trace/`;
  const get = (id: string, tok?: string) => fetch(base + id, { headers: tok ? { cookie: `co_test_session=${tok}` } : {} });
  const anon = await get("7".repeat(32));
  check("not signed in: 401, no text", anon.status === 401 && !(await anon.text()).includes(SECRET));
  const member = await get("7".repeat(32), "member-tok");
  check("a signed-in member who isn't team: 404, no text", member.status === 404 && !(await member.text()).includes(SECRET));
  const team = await get("7".repeat(32), "team-tok");
  const tj = (await team.json()) as any;
  check("the team: the exact prompt and answer", team.status === 200 && tj.rows?.[0]?.input === `prompt ${SECRET}` && tj.rows?.[0]?.output === `answer ${SECRET}` && tj.retentionDays === 14);
  check("the team, with a malformed id: 400", (await get("not-a-trace", "team-tok")).status === 400);
  server.close();
  pool.query = realQuery;
}
check("the dashboard page shows the lookup", /id="trace-form"/.test(readFileSync(new URL("../../../co-test/public/sweeps.html", import.meta.url), "utf8")) && /\/api\/sweeps\/trace\//.test(readFileSync(new URL("../../../co-test/src/client/sweeps.ts", import.meta.url), "utf8")));

await sdk.shutdown().catch(() => {});
console.log(`\ntrace text: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
