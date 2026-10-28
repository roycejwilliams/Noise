// Structured outputs for the busiest judges (services/structuredJudge.ts, Royce 2026-10-27): what goes over the wire and what comes
// back. The installed @ai-sdk/anthropic doesn't know our model ids, so in "auto" mode it would fake this with a forced "json" tool;
// these checks pin that the real output_config.format is sent instead, for the model ids we use.
// Layer 1: the Anthropic endpoint answered by a local stub that records each request. Zero tokens, nothing sent.
//   npx tsx evals/llm/structuredJudge.ts
import fs from "node:fs";
import { anthropic } from "@ai-sdk/anthropic";
const S = await import("../../src/services/structuredJudge.js");
const { MODELS } = await import("../../src/models.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

const sent: any[] = [];
let reply = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (!String(url?.url ?? url).includes("api.anthropic.com")) throw new Error("no network in this test");
  sent.push({ body: JSON.parse(init.body), beta: new Headers(init.headers).get("anthropic-beta") });
  return new Response(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as any;

for (const model of [MODELS.sonnet, MODELS.haiku]) {
  sent.length = 0;
  reply = JSON.stringify({ results: [{ index: 0, score: 72, reason: "both building in climate", share_ask: "S1", hidden_only: false, mutual: true }] });
  const r = await S.judgeJson(S.SCORE_SCHEMA, { model: anthropic(model), prompt: "score these" });
  const b = sent[0]?.body ?? {};
  check(`${model}: output_config.format carries the JSON schema`, b.output_config?.format?.type === "json_schema" && !!b.output_config?.format?.schema?.properties?.results, b.output_config);
  check(`${model}: no forced "json" tool and no tool_choice (the newest models refuse forced tools)`, !b.tools && !b.tool_choice, { tools: b.tools, tool_choice: b.tool_choice });
  check(`${model}: the answer comes back as the object, and as its JSON text for the callers' parsers`, r.output.results[0].score === 72 && JSON.parse(r.text).results[0].share_ask === "S1");
}

// A provider option the caller set (the picker's effort) survives next to the structured mode.
sent.length = 0;
reply = JSON.stringify({ set: null, verdicts: [{ id: "C1", verdict: "send", rank: 1, forThem: null, whyMember: "x", cites: ["A1"], whyNow: "y", wow: false, lastDay: null, taste: "neutral", why: null, until: null, reason: null }] });
await S.judgeJson(S.SELECT_SCHEMA, { model: anthropic(MODELS.sonnet), prompt: "pick", providerOptions: { anthropic: { effort: "medium" } } });
check("the caller's own options (effort) are kept", sent[0]?.body?.output_config?.effort === "medium" && sent[0]?.body?.output_config?.format?.type === "json_schema", sent[0]?.body?.output_config);

// A malformed answer throws (each caller's existing fallback takes it); it never comes back as a half object.
reply = "stub";
const bad = await S.judgeJson(S.CLAIMS_SCHEMA, { model: anthropic(MODELS.sonnet), prompt: "claims" }).then(() => "no throw", (e: any) => e?.name ?? "threw");
check("an answer that isn't the shape throws", bad !== "no throw", bad);
reply = JSON.stringify({ claims: [{ text: "I sent it", type: "past_action", supported: "yes" }] });
const wrong = await S.judgeJson(S.CLAIMS_SCHEMA, { model: anthropic(MODELS.sonnet), prompt: "claims" }).then(() => "no throw", (e: any) => e?.name ?? "threw");
check("a wrong-typed field (supported: \"yes\") throws, never coerced", wrong !== "no throw", wrong);
// A cut-off answer (max_tokens) throws with its own text and usage on the error, for the caller's failure record.
reply = '{"verdicts":[{"id":"C1","verdict":"se';
const cut = await S.judgeJson(S.SELECT_SCHEMA, { model: anthropic(MODELS.sonnet), prompt: "pick" }).then(() => null, (e: any) => e);
check("a failed answer keeps its text and usage on the error", !!cut && typeof cut.text === "string" && cut.text.startsWith('{"verdicts"') && cut.usage != null, { text: cut?.text, usage: cut?.usage });
globalThis.fetch = realFetch;

// Wiring: the four judges go through it, each with its own schema.
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
check("match scorer", /judgeJson\(SCORE_SCHEMA, \{/.test(src("services/matching.ts")));
check("people-asks read (the room frame)", /judgeJson\(PEOPLE_ASKS_SCHEMA, \{/.test(src("services/peopleAsks.ts")));
check("morning picker", /judgeJson\(SELECT_SCHEMA, \{/.test(src("services/sweepSelect.ts")));
check("fact check claim read", /judgeJson\(CLAIMS_SCHEMA, \{/.test(src("harness/replyGrounding.ts")));
check("structured mode is forced, never left to 'auto'", /structuredOutputMode: "outputFormat"/.test(src("services/structuredJudge.ts")));

console.log(`structured judges: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
