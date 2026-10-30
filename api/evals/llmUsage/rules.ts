// Model-free checks for the cost log (services/llmUsage.ts) and the reply
// prompt's cache layout (agent/conversationReply.ts). No network.
//
//   npx tsx evals/llmUsage/rules.ts
import { readFileSync } from "fs";
import { usageFromSpan, priceFor } from "../../src/services/llmUsage.js";

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

// ---------------------------------------------------------------- mapping a span to a row
const attrs = {
  "ai.telemetry.functionId": "agent.conversationReply",
  "ai.response.model": "claude-sonnet-5",
  "ai.usage.inputTokens": 12798,
  "ai.usage.inputTokenDetails.noCacheTokens": 2,
  "ai.usage.inputTokenDetails.cacheReadTokens": 12251,
  "ai.usage.inputTokenDetails.cacheWriteTokens": 545,
  "ai.usage.outputTokens": 9,
  "ai.prompt.messages": "[{\"role\":\"user\",\"content\":\"private\"}]",
  "ai.response.text": "private reply",
};
const r = usageFromSpan("ai.generateText.doGenerate", attrs, "t1")!;
check("a request span becomes a row with its name, model and trace", r.functionId === "agent.conversationReply" && r.model === "claude-sonnet-5" && r.traceId === "t1");
check("tokens split by how they're billed", r.inputUncached === 2 && r.cacheRead === 12251 && r.cacheWrite === 545 && r.output === 9);
// 2*$2 + 545*$2.50 + 12251*$0.20 + 9*$10, per million
check("cost uses Sonnet 5 prices", Math.abs(r.costUsd! - (2 * 2 + 545 * 2.5 + 12251 * 0.2 + 9 * 10) / 1e6) < 1e-9);
check("the row never carries prompt or reply text", !JSON.stringify(r).includes("private"));
check("the outer generateText span is not counted twice", usageFromSpan("ai.generateText", attrs) === null);
check("tool spans are ignored", usageFromSpan("ai.toolCall", attrs) === null);
check("Haiku's dated id gets Haiku prices", priceFor("claude-haiku-4-5-20251001")?.input === 1);
check("an unknown model logs tokens with no made-up cost", usageFromSpan("ai.generateText.doGenerate", { ...attrs, "ai.response.model": "mystery-1" })!.costUsd === null);
{
  const web = usageFromSpan("ai.generateText.doGenerate", {
    ...attrs,
    "ai.response.providerMetadata": JSON.stringify({ anthropic: { usage: { server_tool_use: { web_search_requests: 2 } } } }),
  })!;
  check("web searches are counted and priced at $0.01 each", web.webSearches === 2 && Math.abs(web.costUsd! - r.costUsd! - 0.02) < 1e-9);
}
{
  const noDetail = usageFromSpan("ai.generateText.doGenerate", { "ai.response.model": "claude-sonnet-5", "ai.usage.inputTokens": 100, "ai.usage.outputTokens": 5 })!;
  check("without a breakdown, all input counts as uncached", noDetail.inputUncached === 100 && noDetail.cacheRead === 0);
}

// ---------------------------------------------------------------- wiring
for (const p of ["telemetry.ts", "../../co-test/src/telemetry.ts"]) {
  const t = src(p);
  check(`${p}: the cost log runs even without Langfuse`, /spanProcessors: any\[\] = \[new LlmUsageSpanProcessor\(\)\]/.test(t) && !/return;\n/.test(t));
}
const m = src("db/migrations.ts");
check("llm_usage table has every column the writer uses", ["function_id", "trace_id", "model", "input_uncached", "cache_read", "cache_write", "output", "web_searches", "cost_usd"].every((c) => new RegExp(`\\b${c}\\b`).test(m.slice(m.indexOf("CREATE TABLE IF NOT EXISTS llm_usage")))));
check("writes are batched and never hold a script open", /timer\.unref\?\.\(\)/.test(src("services/llmUsage.ts")));

// ---------------------------------------------------------------- reply cache layout
const c = src("agent/conversationReply.ts");
check("reply prompt: the slow-changing part comes first, with its own breakpoint", /content: sharedSystem, providerOptions: \{ anthropic: \{ cacheControl: \{ type: "ephemeral" \} \} \}/.test(c) && /content: system \}/.test(c));
check("reply prompt: the loop caches up to the latest message", /anthropic: \{\n\s+cacheControl: \{ type: "ephemeral" \},/.test(c));
{
  const shared = c.slice(c.indexOf("const sharedSystem = `"), c.indexOf("const system = `You are replying"));
  check("nothing that changes per text sits in the cached part", !/recentConversation|resolvedContent|facts|toneContext|seekingMode|styleHint|recentMemories|Date|now\(/.test(shared));
}

console.log(`llm usage rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
