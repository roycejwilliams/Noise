// The morning sweep's search loop sent the model API a body it refused (2026-11-05 to 11-08, one member, every retry): "The request
// body is not valid JSON: unexpected end of hex escape". What Cue looked at on earlier mornings (seenBefore) was re-cut to 60 code
// units, and an X post's styled letters (𝗯𝗼𝗹𝗱, two code units each) left half a pair at the cut: a lone surrogate that JSON.stringify
// writes as a bare \ud835 escape. Model-free, no outside calls:
//   npx tsx evals/sweepFind/wellFormed.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
const SF = await import("../../src/services/sweepFind.js");
const MT = await import("../../src/services/modelText.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};
// What the model API checks: the body as JSON, read back, holds no lone surrogate (JSON.parse in JavaScript accepts one; the API's
// parser doesn't, so this is checked on what comes back, and on the escapes written).
const BARE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;
const sendable = (body: unknown) => {
  const json = JSON.stringify(body);
  const back = JSON.stringify(JSON.parse(json));
  return back === json && !BARE_ESCAPE.test(json) && !MT.hasLoneSurrogate(JSON.parse(json) as never);
};
const deepLone = (v: unknown): boolean =>
  typeof v === "string" ? MT.hasLoneSurrogate(v) : Array.isArray(v) ? v.some(deepLone) : v && typeof v === "object" ? Object.values(v).some(deepLone) : false;

// The post, as dev's record has it (2026-11-03): its 59th and 60th code units are one styled letter.
const POST = `@builder: Looking for a cofounder who ships fast, come by: 𝗳𝗿𝗲𝗲 demo night 🚀 open to all`;
const at60 = POST.slice(0, 60);

// ---- clip: cut on a code point, never inside a pair
{
  check("the old cut leaves half a pair (the bug, reproduced)", MT.hasLoneSurrogate(at60) && !sendable({ text: at60 }) && BARE_ESCAPE.test(JSON.stringify(at60)), JSON.stringify(at60.slice(-4)));
  const c = MT.clip(POST, 60);
  check("clip leaves the split pair out whole", c.length === 59 && POST.startsWith(c) && !MT.hasLoneSurrogate(c), JSON.stringify(c.slice(-4)));
  check("an emoji right at the boundary: kept when it fits, left out when it doesn't", MT.clip("ab😀", 4) === "ab😀" && MT.clip("ab😀", 3) === "ab" && MT.clip("ab😀c", 3) === "ab");
  check("shorter text is unchanged", MT.clip("plain words", 60) === "plain words" && MT.clip("🚀🚀", 60) === "🚀🚀");
  check("a lone surrogate already in the text is removed", MT.clip("a\ud83db", 10) === "ab" && MT.wellFormed("x\udc00y") === "xy" && MT.wellFormed("ok 😀") === "ok 😀");
  check("every cut of an emoji-heavy line is sendable", Array.from({ length: POST.length + 1 }, (_, n) => MT.clip(POST, n)).every((s) => sendable({ text: s })));
}

// ---- the real path: what the sweep saw on earlier mornings, into the brief, into the request body
{
  const db = { query: async () => ({ rows: [{ kept: [], passed: [{ name: POST.slice(0, 80), url: "https://x.com/i/status/1" }] }] }) };
  const seen = await SF.seenBefore("u", "Seeking to find another engineer to work with", db);
  check("seenBefore's name is cut on a code point", seen.length === 1 && !MT.hasLoneSurrogate(seen[0].name) && seen[0].name.length <= 60, JSON.stringify(seen[0]?.name.slice(-4)));
  const prompt = SF.sweepPrompt({ userId: "u", firstName: "Jordan", askText: "Seeking to find another engineer to work with", city: "San Francisco" }, { today: "2026-11-08", record: SF.emptySweepRecord(), allSources: true, seen });
  const body = { model: "claude", max_tokens: 4000, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
  check("the morning brief with what it saw before is a sendable request body", prompt.includes("Already looked at on earlier mornings") && sendable(body));
  const rec = SF.sweepRecord({ person: { text: `${"x".repeat(SF.SWEEP_RECORD_LIMITS.person - 1)}🚀 more` }, goals: [], asks: [], delivered: [], lessons: [], corrections: [], preferences: [], claims: [], restraint: null, limits: null } as any, "a");
  check("the member's record is cut on a code point too", !MT.hasLoneSurrogate(rec.person) && rec.person.length === SF.SWEEP_RECORD_LIMITS.person - 1);
  const passed = SF.passedOver([{ source: "x", name: `${"y".repeat(79)}🚀`, url: "https://x.com/i/status/2" }], new Set(), new Map([["https://x.com/i/status/2", `${"z".repeat(119)}🚀`]]));
  check("what it passed over is written well formed (a lone surrogate would sink the sweep.find record in jsonb)", !deepLone(passed) && passed[0].name.length === 79 && passed[0].why.length === 119);
}

// ---- the guard at the request: every string in each step's prompt, tool results too
{
  const params = {
    prompt: [
      { role: "user", content: [{ type: "text", text: `brief ${at60}` }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "searchPosts", input: { query: "(cofounder OR engineer)" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "searchPosts", output: { type: "json", value: { posts: [{ text: at60, links: ["https://a.example"] }] } } }] },
    ],
  } as any;
  const out = await MT.wellFormedPrompt.transformParams!({ type: "generate", params, model: {} as any });
  check("a lone surrogate anywhere in the prompt is removed before the request", deepLone(params.prompt) && !deepLone(out.prompt) && sendable(out.prompt));
  check("nothing else in the prompt changes", JSON.stringify(out.prompt) === JSON.stringify(params.prompt).replace(/\\ud835(?!\\ud[c-f])/gi, ""));
  const clean = { prompt: [{ role: "user", content: [{ type: "text", text: "plain 🚀" }] }] } as any;
  check("a well-formed prompt goes out exactly as it was (same object, so recorded hashes hold)", (await MT.wellFormedPrompt.transformParams!({ type: "generate", params: clean, model: {} as any })) === clean);
}

// ---- end to end through the ai SDK's tool loop: a tool result carrying half a pair reaches the model's next step whole-only
{
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const finish = (unified: "stop" | "tool-calls") => ({ unified, raw: unified });
  const seenPrompts: unknown[] = [];
  let step = 0;
  const mock = new MockLanguageModelV3({
    modelId: "claude-mock",
    doGenerate: async (o: any) => {
      seenPrompts.push(o.prompt);
      return (step++ === 0
        ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "readPage", input: JSON.stringify({ url: "https://a.example" }) }], finishReason: finish("tool-calls"), usage, warnings: [] }
        : { content: [{ type: "text", text: "done" }], finishReason: finish("stop"), usage, warnings: [] }) as any;
    },
  });
  await generateText({
    model: wrapLanguageModel({ model: mock, middleware: MT.wellFormedPrompt }),
    prompt: `find for them: ${at60}`,
    tools: { readPage: tool({ description: "read", inputSchema: z.object({ url: z.string() }), execute: async () => ({ text: at60 }) }) },
    stopWhen: stepCountIs(3),
  });
  check("both steps reached the model, and neither carried a lone surrogate", seenPrompts.length === 2 && !seenPrompts.some(deepLone) && seenPrompts.every((p) => sendable(p)), `${seenPrompts.length} steps`);
}

// ---- wiring: the sweep's one model call goes through the guard, and its text cuts are code-point cuts
{
  const sf = fs.readFileSync(new URL("../../src/services/sweepFind.ts", import.meta.url), "utf8");
  check("the sweep loop's model is wrapped with wellFormedPrompt", /model: wrapLanguageModel\(\{ model: anthropic\(MODELS\.sonnet\), middleware: wellFormedPrompt \}\)/.test(sf) && (sf.match(/generateText\(/g) ?? []).length === 1);
  check("no string cut by code units is left where text reaches the model or the record", !/(name|text|person\?\.text \?\? ""\)|askText|why|audience\.trim\(\)|refusal\([^)]*\)|join\(" "\))\.slice\(0, \d{2,}\)/.test(sf));
}

console.log(`sweepFind well-formed text: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
