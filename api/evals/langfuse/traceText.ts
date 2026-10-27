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
    if (/FROM llm_trace_text WHERE trace_id = \$1 AND created_at >= \$2/.test(sql)) return { rows: table.filter((r) => r.trace_id === args[0] && r.created_at >= new Date(args[1])).map((r, id) => ({ ...r, id })) };
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
const USER_C = "00000000-0000-4000-8000-00000000c0c0";
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

// ---------------------------------------------------------------- review fixes (2026-10-18)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (fn: string, text = "ok", delayMs = 0) =>
  generateText({
    model: new MockLanguageModelV3({ modelId: "claude-mock", doGenerate: async () => { if (delayMs) await sleep(delayMs); return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] } as any; } }),
    experimental_telemetry: { isEnabled: true, functionId: fn },
    prompt: `prompt for ${fn} ${SECRET}`,
  });
T.traceTextStore.db = async () => fakeDb;

// 1. A's turn starts a timer that runs every member's due tasks (routes/sendblue.ts -> taskTurn.runDueTasks): each task's rows
//    are its own member's, never A's, and A's turn keeps A.
{
  table.length = 0;
  await T.traceTurn(async () => {
    T.noteTraceUser(USER);
    await new Promise<void>((done) =>
      setTimeout(
        () =>
          void T.withTraceUser(null, async () => {
            await call("eval.task.beforeMark");
            for (const u of [USER_B, USER_C, "not-a-uuid"]) await T.withTraceUser(u, () => call(`eval.task.${u.slice(-4)}`));
            await call("eval.task.afterLoop");
          }).then(done),
        1,
      ),
    );
    await call("eval.turnAfterTimer");
  });
  await T.flushTraceText();
  const u = (fn: string) => byFn(fn)[0]?.user_id;
  check("a timer started in A's turn carries nobody's mark, not A's", byFn("eval.task.beforeMark").length === 1 && u("eval.task.beforeMark") === null);
  check("each due task's model calls are filed under its own member", u("eval.task.b0b0") === USER_B && u("eval.task.c0c0") === USER_C);
  check("a task with no valid member is nobody's, never the previous task's", byFn("eval.task.uuid").length === 1 && u("eval.task.uuid") === null);
  check("each task's mark is scoped: after the loop the timer is nobody's again", byFn("eval.task.afterLoop").length === 1 && u("eval.task.afterLoop") === null);
  check("A's turn keeps A after the timer", u("eval.turnAfterTimer") === USER);
  check("the reply turn's timer runs due tasks under nobody's mark", /setTimeout\(\(\) => withTraceUser\(null, \(\) => import\("\.\.\/services\/taskTurn\.js"\)\.then\(\(t\) => t\.runDueTasks\(\)\)\)/.test(src("routes/sendblue.ts")));
  check("runDueTasks runs each task under its own member, scoped", /for \(const t of await claim\(\)\) await withTraceUser\(t\.userId, \(\) => withMember\(t\.userId, \(\) => runOne\(t\)\)\);/.test(src("services/taskTurn.ts")));
  check("every text turn runs inside traceTurn", /withPhoneLock\(lockKey, \(\) => traceTurn\(run\)\) : traceTurn\(run\)/.test(src("routes/sendblue.ts")));
}

// 2. A removal inside the turn (the reply's tool loop): nothing from that turn is written after it. A later step, a call already
//    running, a learning call that ends after the turn; and the turn deletes again when it ends. Another member's turn running
//    at the same time keeps its rows.
{
  table.length = 0;
  const other = T.traceTurn(async () => {
    T.noteTraceUser(USER_B);
    await sleep(15);
    await call("eval.otherTurn");
  });
  let lateDone: Promise<unknown> = Promise.resolve();
  await T.traceTurn(async () => {
    T.noteTraceUser(USER);
    await call("eval.beforeForget");
    await T.flushTraceText();
    const running = call("eval.inFlight", "old answer", 30);
    await sleep(5);
    await T.forgetTraceText(USER, "removal");
    await call("eval.afterForget", "the next step re-read the old profile");
    await running;
    lateDone = (async () => {
      await sleep(25);
      await call("eval.lateLearning");
    })();
    // A row that reached the table some other way after the delete: the turn's end deletes again.
    table.push({ trace_id: "b".repeat(32), span_id: "c".repeat(16), user_id: USER, function_id: "eval.slippedIn", input: "old", output: null, created_at: new Date() });
  });
  check("the turn's end deletes again", !byFn("eval.slippedIn").length);
  await other;
  await lateDone;
  await T.flushTraceText();
  check("a removal deletes what was already written", !byFn("eval.beforeForget").length);
  check("a call running during the removal is not written after it", !byFn("eval.inFlight").length);
  check("a later step in the same turn is not written", !byFn("eval.afterForget").length);
  check("a learning call that ends after the turn is not written", !byFn("eval.lateLearning").length);
  check("nothing of the member is left from that turn", !table.some((r) => r.user_id === USER));
  check("another member's turn at the same time keeps its rows", byFn("eval.otherTurn")[0]?.user_id === USER_B);
  await T.traceTurn(async () => {
    T.noteTraceUser(USER);
    await call("eval.nextTurn");
  });
  await T.flushTraceText();
  check("their next turn is kept again", byFn("eval.nextTurn")[0]?.user_id === USER);
}

// 3. A write in flight when the forget runs (taken from the buffer, not yet committed): it lands, then is deleted. A row made
//    before the forget that arrives after it is dropped at write time; one made after it is kept.
{
  table.length = 0;
  const slowDb = { query: async (sql: string, args: any[] = []) => { if (/^INSERT/.test(sql.trim())) await sleep(40); return fakeDb.query(sql, args); } };
  T.traceTextStore.db = async () => slowDb;
  const row = (fn: string, at = new Date()) => ({ traceId: "d".repeat(32), spanId: "e".repeat(16), userId: USER_C, functionId: fn, input: "old", output: null, at });
  T.recordTraceText(row("eval.raceInFlight"));
  const writing = T.flushTraceText();
  await sleep(5);
  await T.forgetTraceText(USER_C, "removal");
  await writing;
  check("a write in flight during the forget is deleted with the rest", !byFn("eval.raceInFlight").length);
  T.traceTextStore.db = async () => fakeDb;
  T.recordTraceText(row("eval.lateOld", new Date(Date.now() - 1_000)));
  T.recordTraceText(row("eval.afterForgetNew", new Date(Date.now() + 1_000)));
  await T.flushTraceText();
  check("a row made before the forget, arriving after it, is dropped at write time", !byFn("eval.lateOld").length);
  check("a row made after the forget is kept", byFn("eval.afterForgetNew").length === 1);
}
{
  // Their rows still waiting in memory are dropped at the forget itself (not only at write time).
  await T.flushTraceText();
  T.recordTraceText({ traceId: "7".repeat(32), spanId: "8".repeat(16), userId: USER_B, functionId: "eval.waiting", input: "old", output: null, at: new Date() });
  const before = T.traceTextBuffered().rows;
  await T.forgetTraceText(USER_B, "removal");
  check("a forget drops their rows waiting in memory right away", before === 1 && T.traceTextBuffered().rows === 0);
}

// 4. "Delete the photos I sent you" (memberAssets.deleteAssets): their trace text goes, the photo descriptions included.
{
  const A = await import("../../src/services/memberAssets.js");
  A.useAssetDb({ query: async () => ({ rows: [], rowCount: 1 }) });
  table.length = 0;
  table.push({ trace_id: "f".repeat(32), span_id: "1".repeat(16), user_id: USER_B, function_id: "sendblue.describeImage", input: "[image not stored]", output: "a photo of their storefront", created_at: new Date() });
  await A.deleteAssets(USER_B, [1]);
  A.useAssetDb(null);
  check("deleting their images deletes their trace text", !table.some((r) => r.user_id === USER_B));
}

// ---------------------------------------------------------------- background jobs carry their member (Q3, decided 2026-10-19)
{
  // The jobs' own runner (jobs/index.ts runWithConcurrency, same code), wrapped the way the jobs wrap it.
  async function runWithConcurrency<X>(items: X[], limit: number, fn: (item: X) => Promise<void>): Promise<void> {
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const item = items[cursor++];
        await fn(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }
  table.length = 0;
  const members = [USER, USER_B, USER_C];
  const items = [0, 1, 2, 3, 4, 5].map((i) => ({ user_id: members[i % 3], i }));
  // Started from inside A's own turn: no job item may inherit A.
  await T.traceTurn(async () => {
    T.noteTraceUser(USER);
    await T.perMember(runWithConcurrency)(items, 3, async (it: any) => {
      await sleep(3 * ((it.i * 7) % 5));
      await call(`eval.job.${it.i}.a`);
      await sleep(3 * ((it.i * 3) % 4));
      await call(`eval.job.${it.i}.b`, "ok", 2);
    });
    // The hourly sweep's items are arrays of one member's rows.
    await T.perMember(runWithConcurrency, (rows: any[]) => rows[0]?.user_id)([[{ user_id: USER_B }], [{ user_id: USER_C }]], 2, async (rows: any[]) => {
      await call(`eval.jobRows.${rows[0].user_id.slice(-4)}`);
    });
  });
  await T.flushTraceText();
  const wrong = items.flatMap((it) => ["a", "b"].map((k) => ({ it, r: byFn(`eval.job.${it.i}.${k}`)[0] }))).filter(({ it, r }) => !r || r.user_id !== it.user_id);
  check(`concurrent job items: every row under its own member, none crossed${wrong.length ? `: ${wrong.map(({ it }) => it.i).join(",")}` : ""}`, wrong.length === 0);
  check("a job item keyed by its rows carries that member", byFn("eval.jobRows.b0b0")[0]?.user_id === USER_B && byFn("eval.jobRows.c0c0")[0]?.user_id === USER_C);
}
{
  // Inside a member's own turn after a forget, a unit of work for the same member keeps the turn's mark (still dropped); one
  // for another member gets its own mark (kept).
  table.length = 0;
  await T.traceTurn(async () => {
    T.noteTraceUser(USER);
    await T.forgetTraceText(USER, "removal");
    await sleep(5); // a later moment than the forget, so only the flow's flag (not the write-time check) can drop it
    await T.withTraceUser(USER, () => call("eval.sameMemberAfterForget"));
    await T.withTraceUser(USER_B, () => call("eval.otherMemberInside"));
    // Before the turn's own end-of-turn delete: the drop alone must hold.
    await T.flushTraceText();
    check("the same member's work after the forget is dropped at once, not only by the turn-end delete", !byFn("eval.sameMemberAfterForget").length);
  });
  await T.flushTraceText();
  check("the same member's work inside their forgetting turn is still dropped", !byFn("eval.sameMemberAfterForget").length);
  check("another member's work inside that turn is kept under them", byFn("eval.otherMemberInside")[0]?.user_id === USER_B);
}
{
  // askKind.classifyOpenAsks, for real (its database injected): each ask's classification under that ask's member.
  table.length = 0;
  const K = await import("../../src/services/askKind.js");
  const asks = [
    { id: "k1", user_id: USER_B, ask_text: "find me a climbing partner in Oakland", kind: null, intent: null },
    { id: "k2", user_id: USER_C, ask_text: "intro to a seed investor in climate", kind: null, intent: null },
  ];
  const db = { query: async (sql: string) => (/FROM ask_checkins/.test(sql) && /SELECT/.test(sql) ? { rows: asks, rowCount: asks.length } : { rows: [], rowCount: 0 }) };
  await T.traceTurn(async () => {
    T.noteTraceUser(USER);
    await K.classifyOpenAsks(25, { db: db as any });
  });
  await T.flushTraceText();
  const rows = byFn("askKind.classify");
  check("askKind: each ask's model call is filed under that ask's member, not the caller's", rows.length === 2 && rows.some((r) => r.user_id === USER_B) && rows.some((r) => r.user_id === USER_C));
}
{
  // Every job named in the ruling runs each member's unit of work under a scoped withTraceUser (never enterWith).
  const J = src("jobs/index.ts");
  check("jobs: the hourly ask sweep runs each member's rows under their mark", /await perMember\(runWithConcurrency, \(userRows: any\[\]\) => userRows\[0\]\?\.user_id\)\(Array\.from\(rowsByUser\.values\(\)\), 5,/.test(J));
  check("jobs: the 9am daily sweep runs each member under their mark", /D\.runDailySweepAll\(perMember\(runWithConcurrency\)\)/.test(J));
  check("jobs: the goal sweep runs each member under their mark", /runGoalSweep\(perMember\(runWithConcurrency\)\)/.test(J));
  check("jobs: the nightly memory recap runs each member under their mark", /await withTraceUser\(userId, \(\) => withMember\(userId, \(\) => buildRecap\(userId\)\)\);/.test(J));
  check("proactive dispatch: each member's drafts under their mark", /await withTraceUser\(id, \(\) => dispatchForUser\(registry, id\)\);/.test(src("harness/proactive.ts")));
  check("3 AM relevance sweep: each member under their mark", /for \(const row of rows\)\n\s*await withTraceUser\(row\.user_id, async \(\) => \{\n\s*await sweepAskAgainstNetwork\(row\.user_id/.test(src("services/relevance.ts")));
  const E = src("services/eventScoring.ts");
  check("room scoring: each person's scoring under their mark", /const scored = await withTraceUser\(person\.user_id, \(\) =>\n\s*scoreAgainstRoomFrame\(/.test(E));
  check("room scoring: each person's match nudge and additive offer under their mark", /withTraceUser\(person\.user_id, \(\) => maybeSendMatchNudge\(/.test(E) && /withTraceUser\(person\.user_id, \(\) => maybeSendAdditiveOffer\(/.test(E));
  check("weekly reflections: each member under their mark", /await withTraceUser\(r\.id, \(\) => reflectOnMember\(r\.id\)\)/.test(src("harness/memberReflection.ts")));
  check("askKind: the open-ask classifier reads each ask's member", /SELECT id, user_id, ask_text, kind, intent FROM ask_checkins/.test(src("services/askKind.ts")) && /await withTraceUser\(r\.user_id, \(\) => withMember\(r\.user_id, \(\) => classify\(r\.ask_text\)\)\)/.test(src("services/askKind.ts")));
  check("the end-of-night close: each person under their mark", /await withTraceUser\(person\.user_id, \(\) => sendClose\(eventId, eventName, person, \{\}\)\)\.catch/.test(src("services/eventUnmatchedFollowUp.ts")));
  check("dev review: each member's model reads under their mark", /await withTraceUser\(userId, async \(\) => \[\.\.\.\(await modelFlags\(data\)\)/.test(src("harness/devReview.ts")));
  check("scheduled call reminders: under the member's mark", /await withTraceUser\(row\.user_id, \(\) => withMember\(row\.user_id, \(\) =>\n\s*generateText\(\{/.test(src("jobs/scheduledCall.ts")));
  check("network reveals run inside proactive dispatch (covered there)", /prepareReveal\(c\.userId/.test(src("harness/proactiveRegistry.ts")));
  check("no job uses enterWith: the only enterWith calls are the entry-point marks", (src("services/llmTraceText.ts").match(/enterWith\(/g) ?? []).length === 1);
}

// Smaller ones.
{
  table.length = 0;
  const id = "2".repeat(32);
  table.push({ trace_id: id, span_id: "3".repeat(16), user_id: null, function_id: "old", input: "i", output: "o", created_at: new Date(Date.now() - 15 * 86_400_000) });
  table.push({ trace_id: id, span_id: "4".repeat(16), user_id: null, function_id: "fresh", input: "i", output: "o", created_at: new Date() });
  const got = await T.traceTextFor(id);
  check("the lookup only reads inside the 14 days, even before the daily job runs", got.length === 1 && got[0].functionId === "fresh");
}
{
  failWrites = true;
  console.error = () => {};
  for (let i = 0; i < 20; i++) T.recordTraceText({ traceId: "5".repeat(32), spanId: "6".repeat(16), userId: null, functionId: "eval.big", input: "x".repeat(300_000), output: null, at: new Date() });
  const b = T.traceTextBuffered();
  check("the memory buffer is capped by size, not just rows", b.chars <= T.TRACE_TEXT.maxBufferedChars && b.rows < 20);
  await T.flushTraceText();
  console.error = origErr;
  failWrites = false;
}
{
  table.length = 0;
  // In its own flow: the top level of this file carries marks from the checks above.
  await T.withTraceUser(null, () => call("eval.nul", "an answer with a \u0000 in it"));
  await T.flushTraceText();
  const r = byFn("eval.nul")[0];
  check("a NUL character is stripped before the insert", !!r && !r.output!.includes("\u0000") && r.output!.includes("an answer with a"));
}

await sdk.shutdown().catch(() => {});
console.log(`\ntrace text: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
