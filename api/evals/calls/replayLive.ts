// LIVE replay (layer 2, metered: ~40 Haiku calls on a cached ~7k-token prompt, about $0.15). Not in layer 1.
//   npx tsx evals/calls/replayLive.ts            direct Haiku vs through the proxy, on the member's 8 turns from the 10/6 call, then the drained-member close
// Everything goes through the real code path (services/callLlmProxy.ts runCallLlm with the real Anthropic stream), with the agent's real prompt.
import "dotenv/config";
import "../lib/requireMeter.js";
import fs from "node:fs";
const E = await import("../../src/services/elevenLabsCalls.js");
const P = await import("../../src/services/callLlmProxy.js");
const S = await import("../../src/services/speakable.js");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/call-2026-10-06.json", import.meta.url), "utf8"));
const g = fixture.given;
const base = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const fill = (p: string) => p.replace(/\{\{first_name\}\}/g, g.firstName).replace("{{context_summary}}", g.contextSummary).replace("{{right_now}}", g.rightNow).replace("{{finds_now}}", g.findsNow).replace(/\{\{[a-z_]+\}\}/g, "");
const NEW = fill(E.promptForElevenLabs(base));
const OLD = NEW.replace(/# Their state comes first[\s\S]*$/, "").replace(/# Cadence[\s\S]*?(?=Speech can't be skimmed)/, "");
// The coverage tool went with the interview script (2026-10-08); the agent carries no tool of its own here.
const tools: any[] = [];
const turns: { role: string; message: string }[] = fixture.turns.map((t: any) => ({ role: t.role === "agent" ? "assistant" : "user", message: String(t.message).replace(/^\[[a-z ]+\]\s*/i, "") }));
const messagesUpTo = (sys: string, idx: number) => [{ role: "system", content: sys }, ...turns.slice(0, idx + 1).map((t) => ({ role: t.role, content: t.message }))];

type Turn = { text: string; firstMs: number | null; upstreamMs: number | null };
async function oneTurn(messages: any[], clean: boolean): Promise<Turn> {
  let text = "", firstMs: number | null = null, upstreamMs: number | null = null;
  let msgs = messages;
  for (let round = 0; round < 3; round++) {
    const t0 = Date.now();
    let toolId = "", sawTool = false, content = "";
    for await (const c of P.runCallLlm({ model: "claude-haiku-4-5", stream: true, temperature: 0.8, messages: msgs, tools } as any, { stream: P.anthropicStream, clean, onFirstText: (m) => { if (firstMs === null) { firstMs = m.firstSentenceMs; upstreamMs = m.upstreamFirstTokenMs; } } })) {
      const d: any = c.choices[0].delta;
      if (d.content) content += d.content;
      for (const tc of d.tool_calls ?? []) if (tc.id) { toolId = tc.id; sawTool = true; }
    }
    void t0;
    text += content;
    if (!sawTool) break;
    msgs = [...msgs, { role: "assistant", content: content || "", tool_calls: [{ id: toolId, type: "function", function: { name: "tool", arguments: "{}" } }] }, { role: "tool", tool_call_id: toolId, content: "{}" }];
    if (content.trim()) break;
  }
  return { text: text.replace(/\[[a-z][a-z ]*\]\s*/gi, "").trim(), firstMs, upstreamMs };
}
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

// ---------- 1. the member's turns, direct vs through the proxy
const userIdx = turns.map((t, i) => ({ t, i })).filter((x) => x.t.role === "user").map((x) => x.i);
const picks = userIdx.filter((_, n) => n % 2 === 1).slice(0, 8);
const direct: Turn[] = [], proxied: Turn[] = [];
for (const i of picks) {
  direct.push(await oneTurn(messagesUpTo(NEW, i), false));
  proxied.push(await oneTurn(messagesUpTo(NEW, i), true));
}
const stat = (ts: Turn[]) => S.speechStats(ts.map((t) => t.text).join(" "));
const d = stat(direct), p = stat(proxied);
console.log("\n=== REPLAY: the member's 8 turns from the 10/6 call (same prompt; direct = the model's own words, proxy = through the cleaner) ===");
console.log(`direct : ${d.words} words | dashes ${d.dashes} | semicolons ${d.semicolons} | parens ${d.parens} | sentences ${d.sentences} (avg ${d.avg.toFixed(1)} words) | past 15 words: ${d.over}`);
console.log(`proxy  : ${p.words} words | dashes ${p.dashes} | semicolons ${p.semicolons} | parens ${p.parens} | sentences ${p.sentences} (avg ${p.avg.toFixed(1)} words) | past 15 words: ${p.over}`);
console.log(`latency (ms from request to the first words the voice can speak):`);
console.log(`  model's first token (direct path, what ElevenLabs waits on)   median ${median(direct.map((t) => t.upstreamMs ?? NaN).filter(Number.isFinite))}  ${direct.map((t) => t.upstreamMs).join(",")}`);
console.log(`  first complete sentence out of the proxy                      median ${median(proxied.map((t) => t.firstMs ?? NaN).filter(Number.isFinite))}  ${proxied.map((t) => t.firstMs).join(",")}`);
console.log(`  first complete sentence, direct (no cleaning, same boundary)  median ${median(direct.map((t) => t.firstMs ?? NaN).filter(Number.isFinite))}  ${direct.map((t) => t.firstMs).join(",")}`);
console.log("\nproxy replies, each after the member's line:");
proxied.forEach((t, k) => console.log(` ${k + 1}. member: ${turns[picks[k]].message.replace(/\s+/g, " ").slice(0, 120)}\n    Co: ${t.text.replace(/\n+/g, " / ").slice(0, 320)}`));

// ---------- 2. the drained member
const drainedAt = turns.findIndex((t) => t.role === "user" && /long day/i.test(t.message));
const RUNS = 5;
// A pitch, a recap or a list: the events and what Co was carrying. (One clause saying it will have something easy is fine.)
const bad = /dance|workshop|BlackPink|fair|Oakland|South Park|PDF|Sequent|links|summary|carrying|event/i;
async function drained(sys: string, label: string, clean: boolean) {
  let ok = 0; const shown: string[] = [];
  for (let n = 0; n < RUNS; n++) {
    const r = await oneTurn(messagesUpTo(sys, drainedAt), clean);
    const sentences = r.text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const pass = sentences.length <= 2 && !bad.test(r.text) && !/\?$/.test(r.text.trim());
    if (pass) ok++;
    if (n < 3) shown.push(`   ${pass ? "PASS" : "FAIL"} (${sentences.length} sentences): ${r.text.replace(/\n+/g, " / ").slice(0, 260)}`);
  }
  console.log(`\n=== DRAINED MEMBER: "${turns[drainedAt].message.slice(0, 90)}..." — ${label}: ${ok}/${RUNS} close in two sentences with no pitch, list, recap or new question ===`);
  shown.forEach((x) => console.log(x));
  return ok;
}
await drained(OLD, "before: the old prompt, direct", false);
await drained(NEW, "prompt rule alone: new prompt, direct", false);
await drained(NEW, "after: new prompt through the endpoint (note + two-sentence cap)", true);
