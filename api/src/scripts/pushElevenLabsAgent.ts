import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildAgentConfig } from "../services/elevenLabsCalls.js";

// Creates or updates Co's ElevenLabs call agent. Its prompt is Co's shared core
// (services/coCore.ts, the same block texts use) plus the call's voice layer,
// api/prompts/co-system-prompt.md, put together by promptForElevenLabs (the code
// and that file stay the source of truth: never edit the prompt in ElevenLabs'
// dashboard).
//
//   npx tsx src/scripts/pushElevenLabsAgent.ts --dry-run   print the config, send nothing
//   npx tsx src/scripts/pushElevenLabsAgent.ts             create (no ELEVENLABS_AGENT_ID) or update it
//
// Reads ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, API_URL (the tools' webhook
// base) and, optionally, ELEVENLABS_AGENT_ID, ELEVENLABS_LLM,
// ELEVENLABS_TTS_MODEL, ELEVENLABS_TURN_EAGERNESS, ELEVENLABS_TEMPERATURE. Pushes to whichever
// environment those point at (dev locally; prod via `railway run`).
// Code-side parts of the call prompt (the voice-cue guide, services/voiceCues.ts)
// only reach the agent when this runs: push after any change, per environment.
// The post-call webhook (API_URL/co/el/post-call) and its secret
// (ELEVENLABS_WEBHOOK_SECRET) are set once in ElevenLabs' workspace settings.
const dryRun = process.argv.includes("--dry-run");

// The call brain's own endpoint (ELEVENLABS_LLM_PROXY=1): ElevenLabs holds our shared secret as a workspace secret and sends it as the
// bearer token. Created once; unset the variable and push again to go back to the direct Haiku path.
// ELEVENLABS_LLM_PROXY=voice: the endpoint in voice-only mode (speakable text, one question a turn; nothing else), 2026-10-08.
async function proxyConfig(apiUrl: string): Promise<{ url: string; secretId: string; voiceOnly?: boolean } | null> {
  if (process.env.ELEVENLABS_LLM_PROXY !== "1" && process.env.ELEVENLABS_LLM_PROXY !== "voice") return null;
  const voiceOnly = process.env.ELEVENLABS_LLM_PROXY === "voice";
  const secret = process.env.CALL_LLM_PROXY_SECRET;
  if (!secret) throw new Error("ELEVENLABS_LLM_PROXY=1 needs CALL_LLM_PROXY_SECRET (the same value on the API server).");
  const url = `${apiUrl.replace(/\/$/, "")}/co/el/llm`;
  if (dryRun) return { url, secretId: "(workspace secret co_call_llm_proxy)", voiceOnly };
  const key = process.env.ELEVENLABS_API_KEY!;
  const H = { "xi-api-key": key, "Content-Type": "application/json" };
  const list = await (await fetch("https://api.elevenlabs.io/v1/convai/secrets", { headers: H })).json();
  const found = (list.secrets ?? []).find((x: any) => x.name === "co_call_llm_proxy");
  if (found) return { url, secretId: found.secret_id, voiceOnly };
  const made = await fetch("https://api.elevenlabs.io/v1/convai/secrets", { method: "POST", headers: H, body: JSON.stringify({ type: "new", name: "co_call_llm_proxy", value: secret }) });
  const body = await made.json().catch(() => ({}));
  if (!made.ok || !body.secret_id) throw new Error(`creating the workspace secret failed: ${made.status} ${JSON.stringify(body).slice(0, 200)}`);
  return { url, secretId: body.secret_id, voiceOnly };
}

async function main() {
  const prompt = readFileSync(resolve(process.cwd(), "prompts/co-system-prompt.md"), "utf-8");
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiUrl = process.env.API_URL;
  if (!voiceId || !apiUrl) throw new Error("ELEVENLABS_VOICE_ID and API_URL must be set.");
  const config = buildAgentConfig({
    name: `Co (${new URL(apiUrl).hostname})`,
    prompt,
    voiceId,
    apiUrl,
    llm: process.env.ELEVENLABS_LLM || undefined,
    ttsModel: process.env.ELEVENLABS_TTS_MODEL || undefined,
    turnEagerness: process.env.ELEVENLABS_TURN_EAGERNESS || undefined,
    temperature: process.env.ELEVENLABS_TEMPERATURE ? Number(process.env.ELEVENLABS_TEMPERATURE) : undefined,
    proxy: await proxyConfig(apiUrl),
  });
  if (dryRun) {
    const shown = JSON.parse(JSON.stringify(config));
    shown.conversation_config.agent.prompt.prompt = `(${String(shown.conversation_config.agent.prompt.prompt).length} chars: the ${prompt.length}-char Hume voice layer in prompts/co-system-prompt.md plus facts, guides and safety)`;
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY must be set.");
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const res = await fetch(agentId ? `https://api.elevenlabs.io/v1/convai/agents/${agentId}` : "https://api.elevenlabs.io/v1/convai/agents/create", {
    method: agentId ? "PATCH" : "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs ${agentId ? "update" : "create"} failed: ${res.status} ${text.slice(0, 500)}`);
  const body = JSON.parse(text || "{}");
  console.log(agentId ? `Updated agent ${agentId}` : `Created agent ${body.agent_id}: set ELEVENLABS_AGENT_ID=${body.agent_id} in api/.env and on co-test`);
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
