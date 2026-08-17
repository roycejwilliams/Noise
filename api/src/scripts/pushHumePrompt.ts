// Write counterpart to the read-only prompt fetch in co-test/src/routes/api.ts
// (GET /api/prompt). That route only ever mirrors the live config for
// display; this script is the only thing that should ever write to it.
// api/prompts/co-system-prompt.md is the source of truth from here on —
// edit the file, run this script, do not edit the prompt in Hume's dashboard.
//
// Reads whichever HUME_CONFIG_ID/HUME_API_KEY are loaded from api/.env, so
// this pushes to whatever environment that .env points at (dev locally).
// To push to prod, run with prod's HUME_CONFIG_ID/HUME_API_KEY loaded
// instead (e.g. `railway run --environment production -- npx tsx
// api/src/scripts/pushHumePrompt.ts`) — there is deliberately one prompt
// file for both environments, not one per environment (see co-test/.env.example's
// "reused as-is, not forked" note on HUME_CONFIG_ID).
import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "api/.env") });

const PROMPT_PATH = resolve(process.cwd(), "api/prompts/co-system-prompt.md");

async function main() {
  const configId = process.env.HUME_CONFIG_ID;
  const apiKey = process.env.HUME_API_KEY;
  if (!configId || !apiKey) {
    throw new Error("HUME_CONFIG_ID and HUME_API_KEY must be set.");
  }

  const promptText = readFileSync(PROMPT_PATH, "utf-8");

  // Read-modify-write against the current version rather than relying on
  // undocumented field inheritance on POST /v0/evi/configs/:id — carries
  // voice, language_model, tools, builtin_tools, webhooks, event_messages,
  // etc. forward unchanged, only replacing the prompt text.
  const currentRes = await fetch(
    `https://api.hume.ai/v0/evi/configs/${configId}?restrict_to_most_recent=true`,
    { headers: { "X-Hume-Api-Key": apiKey } },
  );
  if (!currentRes.ok) {
    throw new Error(`Failed to fetch current config: ${currentRes.status} ${await currentRes.text()}`);
  }
  const currentData: any = await currentRes.json();
  const current = currentData.configs_page?.[0];
  if (!current) {
    throw new Error(`No config found for ${configId}`);
  }

  const newVersionBody = {
    evi_version: current.evi_version,
    voice: current.voice,
    language_model: current.language_model,
    ellm_model: current.ellm_model,
    tools: current.tools,
    builtin_tools: current.builtin_tools,
    webhooks: current.webhooks,
    event_messages: current.event_messages,
    timeouts: current.timeouts,
    turn_detection: current.turn_detection,
    prompt: { text: promptText },
    version_description: `Prompt pushed from api/prompts/co-system-prompt.md at ${new Date().toISOString()}`,
  };

  const pushRes = await fetch(`https://api.hume.ai/v0/evi/configs/${configId}`, {
    method: "POST",
    headers: {
      "X-Hume-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(newVersionBody),
  });
  if (!pushRes.ok) {
    throw new Error(`Failed to push new config version: ${pushRes.status} ${await pushRes.text()}`);
  }
  const pushed: any = await pushRes.json();
  console.log(`Pushed new config version: ${current.name} v${current.version} -> v${pushed.version}`);
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
