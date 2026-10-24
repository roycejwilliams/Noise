// Who each model call was for (cost per member, Phase A, 2026-10-23). Layer 1: no network (a mock model, a fake stream and the
// stubbed Anthropic host), no database (rows are captured before the write).
//
//   npx tsx evals/llmUsage/attribution.ts
import { readFileSync } from "fs";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  LlmUsageSpanProcessor,
  NO_MEMBER,
  captureUsageForTest,
  recordAnthropicUsage,
  scopeMember,
  setScopeMember,
  usageFromSpan,
  withMember,
  type UsageRow,
} from "../../src/services/llmUsage.js";
import { anthropicStream, toAnthropic } from "../../src/services/callLlmProxy.js";
import { summarize, classOf } from "../../src/scripts/costPerMember.js";

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

const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const rows: UsageRow[] = [];
captureUsageForTest((r) => rows.push(r));

// ---------------------------------------------------------------- the span mapping
{
  const base = { "ai.telemetry.functionId": "x", "ai.response.model": "claude-haiku-5-5", "ai.usage.inputTokens": 10, "ai.usage.outputTokens": 2 };
  const said = usageFromSpan("ai.generateText.doGenerate", { ...base, "ai.telemetry.metadata.userId": A }, "t")!;
  check("userId from the call's telemetry metadata lands on the row", said.userId === A);
  check("the call's own id wins over the scope's", usageFromSpan("ai.generateText.doGenerate", { ...base, "ai.telemetry.metadata.userId": A }, "t", B)!.userId === A);
  check("NO_MEMBER stays null even inside a member's scope", usageFromSpan("ai.generateText.doGenerate", { ...base, "ai.telemetry.metadata.noMember": true }, "t", B)!.userId === null);
  check("a missing id (\"\") falls back to the scope", usageFromSpan("ai.generateText.doGenerate", { ...base, "ai.telemetry.metadata.userId": "" }, "t", B)!.userId === B);
  check("something that isn't an id is never written as one", usageFromSpan("ai.generateText.doGenerate", { ...base, "ai.telemetry.metadata.userId": "royce" })!.userId === null);
  check("no metadata and no scope: null", usageFromSpan("ai.generateText.doGenerate", base)!.userId === null);
}

// ---------------------------------------------------------------- the scope
check("outside any scope there is no member", scopeMember() === null);
await withMember(A, async () => {
  await new Promise((r) => setTimeout(r, 1));
  check("a scope's member survives an await", scopeMember() === A);
  await withMember(null, async () => {
    check("a scope opened before the member is known starts empty", scopeMember() === null);
    setScopeMember(B);
    await Promise.resolve();
    check("setScopeMember names it for the rest of that scope", scopeMember() === B);
  });
  check("the outer scope is untouched by an inner one", scopeMember() === A);
});
setScopeMember(A);
check("setScopeMember outside a scope does nothing", scopeMember() === null);

// ---------------------------------------------------------------- a real AI SDK call through the span processor
{
  const provider = new BasicTracerProvider({ spanProcessors: [new LlmUsageSpanProcessor()] });
  const tracer = provider.getTracer("t");
  const model = () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" } as any,
        usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } as any,
        warnings: [],
      }),
    });
  rows.length = 0;
  await generateText({ model: model(), prompt: "p", experimental_telemetry: { isEnabled: true, functionId: "t.metadata", metadata: { userId: A }, tracer } });
  await withMember(B, () => generateText({ model: model(), prompt: "p", experimental_telemetry: { isEnabled: true, functionId: "t.scope", tracer } }));
  await withMember(B, () => generateText({ model: model(), prompt: "p", experimental_telemetry: { isEnabled: true, functionId: "t.none", metadata: NO_MEMBER, tracer } }));
  await generateText({ model: model(), prompt: "p", experimental_telemetry: { isEnabled: true, functionId: "t.bare", tracer } });
  const by = (f: string) => rows.find((r) => r.functionId === f);
  check("AI SDK call with metadata { userId }: the row names the member", by("t.metadata")?.userId === A && by("t.metadata")?.inputUncached === 7);
  check("AI SDK call inside withMember with no metadata: the scope's member", by("t.scope")?.userId === B);
  check("a member-less call (NO_MEMBER) records null on purpose, even inside a scope", !!by("t.none") && by("t.none")!.userId === null);
  check("an unmarked call outside any scope records null", !!by("t.bare") && by("t.bare")!.userId === null);
}

// ---------------------------------------------------------------- call turns: usage read off the raw stream
{
  const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
  const body = [
    ev({ type: "message_start", message: { model: "claude-haiku-5-5", usage: { input_tokens: 30, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000, output_tokens: 1 } } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } }),
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }),
    ev({ type: "message_stop" }),
  ].join("");
  const fakeFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const req = toAnthropic({ messages: [{ role: "user", content: "hello" }] } as any);
  rows.length = 0;
  for await (const _ of anthropicStream(req, "k", fakeFetch, A)) { /* drain */ }
  const r = rows.find((x) => x.functionId === "call.turn");
  check("a call turn writes one call.turn row for the call's member", rows.length === 1 && r?.userId === A);
  check("call.turn: input from message_start, output from the last message_delta", r?.inputUncached === 30 && r?.cacheWrite === 400 && r?.cacheRead === 5000 && r?.output === 42);
  check("call.turn: priced with the model the stream named", r?.model === "claude-haiku-5-5" && Math.abs((r?.costUsd ?? 0) - (30 * 0.1 + 400 * 0.125 + 5000 * 0.01 + 42 * 0.5) / 1e6) < 1e-12);
  rows.length = 0;
  const it = anthropicStream(req, "k", fakeFetch, null);
  await it.next();
  await it.return(undefined);
  check("a turn cut off mid-stream still writes what it used (null member: no verified token)", rows.length === 1 && rows[0].userId === null);
  const route = src("routes/callLlm.ts");
  check("the call route hands the verified member to the upstream and scopes the turn", /stream: \(r\) => upstream\(r, userId\)/.test(route) && /withMember\(null, \(\) => handleTurn\(req, res\)\)/.test(route) && /setScopeMember\(userId\)/.test(route));
}

// ---------------------------------------------------------------- the direct SDK calls
{
  rows.length = 0;
  recordAnthropicUsage("x.direct", "claude-haiku-5-5", { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } }, A);
  check("recordAnthropicUsage maps the SDK's usage and prices web searches", rows[0]?.userId === A && rows[0].inputUncached === 100 && rows[0].webSearches === 1 && Math.abs(rows[0].costUsd! - (100 * 0.1 + 10 * 0.5) / 1e6 - 0.01) < 1e-12);
  rows.length = 0;
  withMember(B, () => recordAnthropicUsage("x.direct", "claude-haiku-5-5", { input_tokens: 1 }));
  recordAnthropicUsage("x.direct", "claude-haiku-5-5", { input_tokens: 1 }, null);
  check("no id given: the scope's member; null given: no member", rows[0]?.userId === B && rows[1]?.userId === null);
  const sites: [string, string][] = [
    ["services/sweepSelect.ts", "sweep.select.claimCheck"],
    ["services/memberLimits.ts", "memberLimits.judge"],
    ["services/callOpening.ts", "call.writeOpening"],
    ["services/sdkBrowserReader.ts", "sdkBrowserReader.read"],
    ["services/sdkGeneralReader.ts", "sdkGeneralReader.read"],
    ["services/goalEdges.ts", "goal.edges"],
    ["services/theirYes.ts", "theirYes.read"],
    ["services/askSplit.ts", "askSplit.read"],
  ];
  for (const [f, id] of sites) {
    const s = src(f);
    const creates = (s.match(/messages\.create\(/g) ?? []).length;
    const records = (s.match(new RegExp(`recordAnthropicUsage\\("${id.replace(/\./g, "\\.")}"`, "g")) ?? []).length;
    check(`${f}: every messages.create is followed by its usage row`, creates > 0 && creates === records);
  }
  // Behavioral: a real direct call (theirYes) through the stubbed Anthropic host, inside a member's scope.
  rows.length = 0;
  const { judgeYes } = await import("../../src/services/theirYes.js");
  await withMember(A, () => judgeYes({ recent: "Cue: want me to draft it?", message: "yes", ability: "draft" }));
  check("a direct messages.create call writes its row for the scope's member", rows.some((r) => r.functionId === "theirYes.read" && r.userId === A));
}

// ---------------------------------------------------------------- scopes at the member entry points
{
  const scoped: [string, RegExp][] = [
    ["routes/co.ts", /async function processEndedCall\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[0\]\.userId/],
    ["harness/proactive.ts", /async function dispatchForUser\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[1\]/],
    ["services/taskTurn.ts", /async function runTaskTurn\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[0\]\.userId/],
    ["services/followUps.ts", /async function runFollowUpTurn\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[0\]\.userId/],
    ["services/sweepFind.ts", /async function sweepFind\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[0\]\.userId/],
    ["services/relevance.ts", /async function sweepAskAgainstNetwork\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[0\]/],
    ["harness/personSnapshot.ts", /async function refreshPersonSnapshot\(\.\.\.a[^)]*\)[^{]*\{\s*return withMember\(a\[0\]/],
  ];
  for (const [f, re] of scoped) check(`${f}: its model calls run in the member's scope`, re.test(src(f)));
  const sb = src("routes/sendblue.ts");
  check("routes/sendblue.ts: the inbound text opens a scope and names the member once looked up", /const run = \(\) => withMember\(null, runTurn\);\n\s+const runTurn = async \(\) => \{/.test(sb) && /let user = await findOrCreateUserByPhone\(number\);\n\s+setScopeMember\(user\.id\);/.test(sb));
  // The four the report named, now marked at the call itself.
  check("turnLearning, followUp, personSnapshot and matching are attributed", /functionId: "turnLearning\.learn", metadata: \{ userId: input\.userId \}/.test(src("services/turnLearning.ts")) && /functionId: "personSnapshot\.check", metadata: \{ userId \}/.test(src("harness/personSnapshot.ts")) && /withMember\(person\.user_id, \(\) =>\s*scoreAgainstRoomFrame/.test(src("services/eventScoring.ts")));
  // Member-less calls say so in a comment beside NO_MEMBER.
  for (const f of ["harness/devReview.ts", "services/partnerReadout.ts", "services/roomMatching.ts", "services/entryKind.ts", "scripts/notifyTesters.ts"]) {
    check(`${f}: its member-less call is marked NO_MEMBER with a reason`, /\/\/ Not about one member: [^\n]+\n[^\n]*metadata: NO_MEMBER/.test(src(f)));
  }
  const m = src("db/migrations.ts");
  check("migration: nullable user_id added idempotently", /ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS user_id UUID`/.test(m));
  check("the writer inserts user_id", /cost_usd, user_id\) VALUES/.test(src("services/llmUsage.ts")));
}

// ---------------------------------------------------------------- the report
{
  const users = [
    { id: "r1", phone_number: "+14155550000", archived_phone: null, archived_at: null, invite_verified: true, mo_approver: false },
    { id: "t1", phone_number: "+14155550142", archived_phone: null, archived_at: null, invite_verified: true, mo_approver: false },
    { id: "t2", phone_number: "+19998887777", archived_phone: "+14155550101", archived_at: new Date(), invite_verified: true, mo_approver: false },
    { id: "f1", phone_number: "+14155551234", archived_phone: null, archived_at: null, invite_verified: true, mo_approver: true },
    { id: "g1", phone_number: "+14155559999", archived_phone: null, archived_at: null, invite_verified: false, mo_approver: false },
  ];
  check("classes: real, test (555-01xx now or archived), team, gate", ["real", "test", "test", "team", "gate"].every((c, i) => classOf(users[i]) === c));
  const r = summarize({
    days: 14,
    users,
    usage: [
      { user_id: "r1", function_id: "agent.conversationReply", calls: 4, cost: 2, web_searches: 0 },
      { user_id: "t1", function_id: "taskWeb.search", calls: 10, cost: 3, web_searches: 9 },
      { user_id: "f1", function_id: "agent.conversationReply", calls: 2, cost: 1, web_searches: 0 },
      { user_id: null, function_id: "devReview.modelFlags", calls: 1, cost: 0.5, web_searches: 0 },
    ],
    activeDays: [{ user_id: "r1", days: 4 }, { user_id: "t1", days: 2 }, { user_id: "f1", days: 1 }],
    exa: [{ user_id: "t1", n: 5, cost: 0.03 }],
    x: [{ user_id: "r1", n: 2 }],
    webLog: [],
  });
  check("report: cost per active day per class", r.classes.real.perActiveDay === 0.5 && r.classes.test.perActiveDay === 1.5 && r.classes.team.perActiveDay === 1);
  check("report: unattributed kept apart with its functions", r.unattributed.cost === 0.5 && r.unattributed.top[0]?.fn === "devReview.modelFlags" && r.total === 6.5);
  check("report: non-model counts land on the class", r.classes.test.exa === 5 && r.classes.real.x === 2 && r.classes.test.webSearches === 9);
  const script = src("scripts/costPerMember.ts");
  check("report script: one READ ONLY transaction, never selects names or text", /BEGIN READ ONLY/.test(script) && !/first_name|last_name|content|\bquery\b FROM|email/.test(script.replace(/\/\/[^\n]*/g, "")));
}

captureUsageForTest(null);
console.log(`llm usage attribution: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
