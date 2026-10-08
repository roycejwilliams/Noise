// LIVE (layer 2, metered): Co's own tools on a call, through the real endpoint code (services/callLlmProxy.ts runCallLlm with the
// real Anthropic stream, services/callTools.ts with the real texting tools and guard), on a clean test member (texts logged, never sent).
//   EVAL_REAL_MODELS=1 EVAL_COST_CAP_USD=2 EVAL_TOKEN_CAP=4000000 npm run eval:live -- evals/calls/callToolsLive.ts
// Needs CALL_TOOLS_LIVE_DB_PORT (a tunnel to the dev database) and a test member (src/scripts/testMember.ts reset). Never production.
import fs from "node:fs";
import "../lib/requireMeter.js";
const port = process.env.CALL_TOOLS_LIVE_DB_PORT;
if (!port) throw new Error("set CALL_TOOLS_LIVE_DB_PORT to your own dev tunnel's port");
// The dev database through this run's own tunnel; the rest of api/.env as usual (dotenv never overrides what is set).
const envText = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
const dbLine = envText.split("\n").find((l) => l.startsWith("DATABASE_URL="));
if (!dbLine) throw new Error("no DATABASE_URL in api/.env");
process.env.DATABASE_URL = dbLine.slice("DATABASE_URL=".length).replace(/^"|"$/g, "").replace(/localhost:\d+/, `localhost:${port}`);
await import("dotenv/config");
const pool = (await import("../../src/db/db.js")).default;
const { rows: dbRows } = await pool.query(`SELECT current_database() AS db, inet_server_port() AS p`);
if (dbRows[0].db !== "railway" || !/localhost:\d+/.test(process.env.DATABASE_URL!)) throw new Error("not the dev database through the tunnel");
console.log(`db: ${dbRows[0].db} via localhost:${port}`);

const E = await import("../../src/services/elevenLabsCalls.js");
const P = await import("../../src/services/callLlmProxy.js");
const CT = await import("../../src/services/callTools.js");
const R = await import("../../src/routes/callLlm.js");

const { rows: tm } = await pool.query(`SELECT id, first_name FROM users WHERE phone_number LIKE '+141555501%' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`);
if (!tm[0]) throw new Error("no test member: run src/scripts/testMember.ts reset");
const userId = String(tm[0].id);
const since = new Date();
console.log(`test member: ${tm[0].first_name} (${userId.slice(0, 8)})`);

const base = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const system = E.promptForElevenLabs(base).replace(/\{\{first_name\}\}/g, "Jordan").replace("{{context_summary}}", "Jordan is a founder in San Francisco who runs a small design community. New to Co.").replace(/\{\{[a-z_]+\}\}/g, "");
const elTools = [
  { type: "function", function: { name: "end_call", description: "End the call once you've said a warm goodbye and given them a beat to respond.", parameters: { type: "object", properties: { reason: { type: "string" }, message: { type: "string" } }, required: ["reason"] } } },
  { type: "function", function: { name: "voicemail_detection", description: "Only when you hear a recorded voicemail greeting, a carrier message or a beep.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } },
];
const callKey = `${userId}:live-${Date.now()}`;
const messages: any[] = [{ role: "system", content: system }, { role: "assistant", content: "Hey Jordan, it's Co. How's your week going?" }];

type TurnOut = { said: string; firstMs: number | null; upstreamMs: number | null; totalMs: number; tools: { name: string; ok: boolean; ms: number; timedOut: boolean; note: string }[]; elCalls: string[] };
async function turn(their: string, withTools = true): Promise<TurnOut> {
  messages.push({ role: "user", content: their });
  const body = { model: "co", stream: true, messages, tools: elTools } as any;
  const t0 = Date.now();
  const member = await CT.loadMemberOnCall(userId);
  const tools = withTools ? CT.buildCallTools({ userId, callKey, member, ...R.callWordsOf(body) }) : null;
  const out: TurnOut = { said: "", firstMs: null, upstreamMs: null, totalMs: 0, tools: [], elCalls: [] };
  const calls: any[] = [];
  for await (const c of P.runCallLlm(body, {
    stream: P.anthropicStream,
    tools,
    onFirstText: (m) => { out.firstMs = m.firstSentenceMs + (t0 ? 0 : 0); out.upstreamMs = m.upstreamFirstTokenMs; },
    onTool: (t) => out.tools.push({ name: t.name, ok: !t.timedOut && (t.result as any)?.ok !== false, ms: t.ms, timedOut: t.timedOut, note: JSON.stringify(t.result ?? "").slice(0, 220) }),
    onDropped: (s, why) => console.log(`  (kept from the voice: ${s.slice(0, 80)} | ${why})`),
  })) {
    const d: any = c.choices[0].delta;
    if (d.content) out.said += d.content;
    for (const tc of d.tool_calls ?? []) { const i = tc.index ?? 0; calls[i] = calls[i] ?? { name: "", args: "" }; if (tc.function?.name) calls[i].name = tc.function.name; calls[i].args += tc.function?.arguments ?? ""; }
  }
  out.totalMs = Date.now() - t0;
  out.elCalls = calls.map((c) => `${c.name}(${c.args})`);
  // What ElevenLabs would send back next turn: Co's words, and its own tool calls with their results.
  if (out.said.trim() || calls.length) messages.push({ role: "assistant", content: out.said.trim(), ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: `el${i}`, type: "function", function: { name: c.name, arguments: c.args } })) } : {}) });
  console.log(`\nMEMBER: ${their}\nCO: ${out.said.trim()}\n  first sentence ${out.firstMs}ms (model first token ${out.upstreamMs}ms), turn ${out.totalMs}ms${out.tools.length ? `\n  tools: ${out.tools.map((t) => `${t.name} ${t.ok ? "done" : "not done"} ${t.ms}ms ${t.note}`).join(" | ")}` : ""}${out.elCalls.length ? `\n  to ElevenLabs: ${out.elCalls.join(", ")}` : ""}`);
  return out;
}

// CALL_TOOLS_LIVE_LATENCY=1: only the cost of offering the tools at all: the same plain turn, alternately with and without them.
if (process.env.CALL_TOOLS_LIVE_LATENCY === "1") {
  const on: number[] = [], off: number[] = [];
  for (let k = 0; k < 5; k++) {
    for (const withTools of [true, false]) {
      messages.splice(2);
      const r = await turn(["How's your week been so far?", "What do you think makes a dinner like that work?", "Any thoughts on keeping a talk short?", "How are you doing today?", "What's a good way to open a dinner?"][k], withTools);
      if (r.firstMs) (withTools ? on : off).push(r.firstMs);
    }
  }
  const md = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  console.log(`\nfirst sentence, Co's tools offered: ${JSON.stringify(on)} (median ${md(on)}ms); not offered: ${JSON.stringify(off)} (median ${md(off)}ms)`);
  await pool.end();
  process.exit(0);
}
const plain: number[] = [], withTool: number[] = [];
const a = await turn("Pretty good, busy week. How are you?");
if (a.firstMs) plain.push(a.firstMs);
const b = await turn("So we're doing a partner event with a design studio in November, about 60 people, a dinner and a short talk. Can you take the lead on a planning doc for it?");
if (b.firstMs) (b.tools.length ? withTool : plain).push(b.firstMs);
let c = b;
if (!b.tools.some((t) => t.ok)) {
  c = await turn("Yes, please, go ahead and take the lead on it.");
  if (c.firstMs) (c.tools.length ? withTool : plain).push(c.firstMs);
}
const d = await turn("Perfect, that's all I needed today. Thanks Co, talk soon.");
let ended = d.elCalls.some((x) => x.startsWith("end_call"));
if (!ended) { const e = await turn("Bye!"); ended = e.elCalls.some((x) => x.startsWith("end_call")); }

// Latency: a second plain turn and a second tool turn, as a second short call (the first one ended).
messages.splice(1, messages.length - 1, { role: "assistant", content: "Hey Jordan, it's Co again." }, { role: "user", content: "Hey Co. Following up on the partner dinner." }, { role: "assistant", content: "Good, I'm on it. What's on your mind?" });
const extra = await turn("Oh, one more thing. How do you think dinners like that usually go?");
if (extra.firstMs) (extra.tools.length ? withTool : plain).push(extra.firstMs);
const extra2 = await turn("Also, note that the studio is called Ellis Works and the date's not locked yet, so keep that open on your side.");
if (extra2.firstMs) (extra2.tools.length ? withTool : plain).push(extra2.firstMs);

await new Promise((r) => setTimeout(r, 1500));
const facts = await pool.query(`SELECT relation, object_label AS label, source, happened_at FROM co_facts WHERE owner_user_id = $1 AND happened_at >= $2 ORDER BY happened_at`, [userId, since]);
const tasks = await pool.query(`SELECT id, goal, status, kind, source FROM co_tasks WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at`, [userId, since]);
const decisions = await pool.query(`SELECT decision, action, outcome FROM harness_decisions WHERE user_id = $1 AND created_at >= $2 AND (decision LIKE 'tool.%' OR decision LIKE 'call.%' OR decision LIKE 'loop.%') ORDER BY created_at`, [userId, since]);
const outbound = await pool.query(`SELECT LEFT(content, 80) AS content FROM outbound_messages WHERE user_id = $1 AND sent_at >= $2 ORDER BY sent_at`, [userId, since]).catch(() => ({ rows: [] as any[] }));
console.log("\nco_facts rows:", JSON.stringify(facts.rows.map((r) => ({ relation: r.relation, label: r.label, source: r.source }))));
console.log("co_tasks rows:", JSON.stringify(tasks.rows));
// The Ellis Works turn (2026-10-08): the name they gave is on an open task, by Co's own updateTask or the backstop in their words.
const notes = await pool.query(`SELECT id, notes FROM co_tasks WHERE user_id = $1 AND updated_at >= $2 ORDER BY id`, [userId, since]);
const ellis = notes.rows.flatMap((r: any) => (Array.isArray(r.notes) ? r.notes : []).filter((n: any) => /ellis works/i.test(String(n?.text ?? ""))).map((n: any) => ({ task: r.id, note: String(n.text).slice(0, 200) })));
console.log(`Ellis Works on a task: ${ellis.length ? "yes" : "NO"} ${JSON.stringify(ellis)}`);
console.log(`Ellis turn: Co's own tools ${JSON.stringify(extra2.tools.map((t) => t.name))}; said "${extra2.said.trim()}"`);
const backstop = decisions.rows.filter((r: any) => r.decision === "call.task_fact_backstop");
console.log(`backstop wrote: ${backstop.length ? JSON.stringify(backstop) : "no (not needed or not taken)"}`);
console.log("decisions:", JSON.stringify(decisions.rows));
console.log("texts logged for the test member (never sent):", JSON.stringify(outbound.rows));
const med = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null);
console.log(`\nfirst sentence, no tool in the turn: ${JSON.stringify(plain)} (median ${med(plain)}ms); with a tool in the turn: ${JSON.stringify(withTool)} (median ${med(withTool)}ms)`);
console.log(`end_call emitted: ${ended}`);
await pool.end();
