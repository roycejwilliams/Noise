import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildAgentConfig } from "../services/elevenLabsCalls.js";

// Creates or updates Co's ElevenLabs call agent from api/prompts/co-system-prompt.md
// (the prompt file stays the source of truth: never edit the prompt in
// ElevenLabs' dashboard).
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
  });
  if (dryRun) {
    const shown = JSON.parse(JSON.stringify(config));
    shown.conversation_config.agent.prompt.prompt = `(${prompt.length} chars from prompts/co-system-prompt.md)`;
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
