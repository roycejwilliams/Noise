// Co's voice regression suite on ElevenLabs (services/callTests.ts).
//   npx tsx src/scripts/agentTests.ts sync                  create or update every test (matched by name)
//   npx tsx src/scripts/agentTests.ts run [--repeat 3] [--candidate]
//        run them against the live agent, or with --candidate against the agent config THIS CODE builds (prompt, model) without pushing it
// Exit 1 when any test fails. Tests grade the agent's very next reply; a few credits per run.
import "dotenv/config";
import { CALL_TESTS, testBody } from "../services/callTests.js";
import { buildAgentConfig } from "../services/elevenLabsCalls.js";
import fs from "node:fs";

const key = process.env.ELEVENLABS_API_KEY!;
const agentId = process.env.ELEVENLABS_AGENT_ID!;
if (!key || !agentId) { console.error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required"); process.exit(2); }
const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`https://api.elevenlabs.io${path}`, { ...init, headers: { "xi-api-key": key, "content-type": "application/json", ...(init.headers ?? {}) } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

async function existing(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const j: any = await api(`/v1/convai/agent-testing?page_size=100${cursor ? `&cursor=${cursor}` : ""}`).catch(() => ({ tests: [] }));
    for (const t of j.tests ?? []) m.set(t.name, t.id);
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return m;
}

async function sync() {
  const have = await existing();
  for (const t of CALL_TESTS) {
    const old = have.get(t.name);
    // A test's type can't be edited in place, so a changed test is replaced (same name).
    if (old) await api(`/v1/convai/agent-testing/${old}`, { method: "DELETE" });
    const j = await api("/v1/convai/agent-testing/create", { method: "POST", body: JSON.stringify(testBody(t)) });
    console.log(`${old ? "replaced" : "created "} ${t.name} (${j.id})`);
  }
}

async function run(repeat: number, candidate: boolean) {
  const have = await existing();
  const tests = CALL_TESTS.map((t) => ({ name: t.name, id: have.get(t.name) }));
  const missing = tests.filter((t) => !t.id);
  if (missing.length) { console.error(`not synced yet: ${missing.map((m) => m.name).join("; ")}. Run sync first.`); process.exit(2); }
  // The agent under test: the live one (read back from ElevenLabs) or the config THIS CODE builds, either way with the webhook tools
  // removed so the next thing Co does is speak. (Simulation tests ignore overrides, so these are single-reply tests.)
  let cfg: any;
  if (candidate) cfg = buildAgentConfig({ name: "Co", prompt: process.env.CALL_TEST_PROMPT_REPLACE ?? fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8"), voiceId: process.env.ELEVENLABS_VOICE_ID ?? "jzMiJCYezeDWXr1X4jwM", apiUrl: process.env.API_URL ?? "https://test.copatible.com" });
  else cfg = await api(`/v1/convai/agents/${agentId}`);
  const conversation_config = JSON.parse(JSON.stringify(cfg.conversation_config));
  const p = conversation_config.agent.prompt;
  p.tools = (p.tools ?? []).filter((t: any) => t.type !== "webhook");
  delete p.tool_ids;
  const body: any = { tests: tests.map((t) => ({ test_id: t.id })), repeat_count: repeat, agent_config_override: { conversation_config, platform_settings: cfg.platform_settings } };
  const inv = await api(`/v1/convai/agents/${agentId}/run-tests`, { method: "POST", body: JSON.stringify(body) });
  let res: any = inv;
  for (let i = 0; i < 90; i++) {
    res = await api(`/v1/convai/test-invocations/${inv.id}`);
    if ((res.test_runs ?? []).length && (res.test_runs ?? []).every((r: any) => r.status === "passed" || r.status === "failed")) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  let failed = 0, credits = 0;
  for (const r of res.test_runs ?? []) {
    const ok = r.status === "passed";
    if (!ok) failed++;
    credits += Number(r.credits_used ?? 0);
    console.log(`${ok ? "PASS" : "FAIL"}  ${r.test_name}`);
    if (!ok || process.argv.includes("--verbose")) console.log(`      said: ${(r.agent_responses ?? []).map((a: any) => a.message).filter(Boolean).join(" ").slice(0, 220)}\n      why:  ${String(r.condition_result?.rationale?.summary ?? r.condition_result?.rationale?.messages?.join(" ") ?? "").slice(0, 300)}`);
  }
  console.log(`\n${(res.test_runs ?? []).length - failed}/${(res.test_runs ?? []).length} passed${repeat > 1 ? ` (x${repeat})` : ""} | ${credits} credits | ${candidate ? "candidate config (not pushed)" : "live agent"}`);
  process.exit(failed ? 1 : 0);
}

// CALL_TEST_PROMPT_REPLACE swaps the candidate prompt for a deliberately bad one: for proving the tests FAIL on bad behaviour.
const cmd = process.argv[2];
const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1]) || 1;
if (cmd === "sync") await sync();
else if (cmd === "run") await run(repeat, process.argv.includes("--candidate"));
else { console.error("usage: agentTests.ts sync | run [--repeat N] [--candidate]"); process.exit(2); }
