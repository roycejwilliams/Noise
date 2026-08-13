// Registers the assess_conversation_coverage and surface_recommendation
// FUNCTION tools on a Hume EVI config, and attaches whichever are missing to
// that config's tools array — the backend (handleToolCall in
// api/src/routes/co.ts) already answers both tool_calls if Hume ever sends
// one, but Hume will never send either until the tool is actually
// registered here. Read-modify-write against the config, same pattern as
// pushHumePrompt.ts, carrying every other field forward unchanged.
//
// NOT run automatically — this creates new tools + a new config version on
// whichever HUME_CONFIG_ID/HUME_API_KEY are loaded from api/.env (prod's
// values via `railway run --environment production -- npx tsx
// api/src/scripts/registerCoverageTool.ts`), a live change to the real
// product's config. Run explicitly, after review, not as part of a deploy.
//
// Idempotency: any tool whose name already exists on this config's tools
// array is skipped, not duplicated — safe to re-run, including after only
// one of the two tools was previously registered.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "api/.env") });

// Exact schemas already live on co-test's "Co (dev)" config, kept identical
// here so both environments' Co behaves the same way when using these tools.
const TOOL_DEFINITIONS = [
  {
    name: "assess_conversation_coverage",
    description:
      "Silently check your own progress through the Rapport phase. Returns which required topics are still uncovered so you can decide what to ask next and whether you have enough to move into Confirm Understanding. Never mention that you are checking anything or calling a tool - just let the result quietly guide your next question.",
    parameters: JSON.stringify({ type: "object", properties: {}, required: [] }),
    fallback_content: JSON.stringify({
      missing_topics: [
        "current_situation",
        "major_transition",
        "goals_challenges",
        "looking_for",
        "people_to_meet",
        "ways_to_help",
        "personality",
        "location_availability",
        "boundaries_preferences",
      ],
      ready_to_summarize: false,
    }),
  },
  {
    name: "surface_recommendation",
    description:
      "Call this when you have a real, specific, stated preference or want from this person and a genuine moment to offer something concrete, not during early rapport-building. Returns one grounded recommendation with a reason, or not-yet-available if there is not enough real signal. Never mention checking or calling a tool. Offer any result naturally as your own suggestion.",
    parameters: JSON.stringify({ type: "object", properties: {}, required: [] }),
    fallback_content: JSON.stringify({
      available: false,
      reason: "not enough concrete preference data on file yet",
    }),
  },
];

async function main() {
  const configId = process.env.HUME_CONFIG_ID;
  const apiKey = process.env.HUME_API_KEY;
  if (!configId || !apiKey) {
    throw new Error("HUME_CONFIG_ID and HUME_API_KEY must be set.");
  }

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

  const existingTools: any[] = current.tools ?? [];
  const missing = TOOL_DEFINITIONS.filter((t) => !existingTools.some((existing) => existing.name === t.name));

  if (missing.length === 0) {
    console.log(`All tools already registered on config ${current.name} v${current.version} — nothing to do.`);
    return;
  }

  // Create each missing tool — POST /v0/evi/tools is a separate resource
  // from the config; the config's tools array only references tools that
  // already exist.
  const createdTools: any[] = [];
  for (const toolDef of missing) {
    const createToolRes = await fetch("https://api.hume.ai/v0/evi/tools", {
      method: "POST",
      headers: { "X-Hume-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(toolDef),
    });
    if (!createToolRes.ok) {
      throw new Error(`Failed to create tool "${toolDef.name}": ${createToolRes.status} ${await createToolRes.text()}`);
    }
    const createdTool: any = await createToolRes.json();
    console.log(`Created tool "${toolDef.name}" — id ${createdTool.id}, version ${createdTool.version}`);
    createdTools.push(createdTool);
  }

  // Attach the newly created tools to the config, carrying every other
  // field forward unchanged — same read-modify-write shape pushHumePrompt.ts
  // uses for the prompt text.
  const newVersionBody = {
    evi_version: current.evi_version,
    voice: current.voice,
    language_model: current.language_model,
    ellm_model: current.ellm_model,
    tools: [...existingTools, ...createdTools],
    builtin_tools: current.builtin_tools,
    webhooks: current.webhooks,
    event_messages: current.event_messages,
    timeouts: current.timeouts,
    turn_detection: current.turn_detection,
    prompt: current.prompt,
    version_description: `Registered ${createdTools.map((t) => t.name).join(", ")} at ${new Date().toISOString()}`,
  };

  const pushRes = await fetch(`https://api.hume.ai/v0/evi/configs/${configId}`, {
    method: "POST",
    headers: { "X-Hume-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(newVersionBody),
  });
  if (!pushRes.ok) {
    throw new Error(`Failed to push new config version: ${pushRes.status} ${await pushRes.text()}`);
  }
  const pushed: any = await pushRes.json();
  console.log(
    `Attached [${createdTools.map((t) => t.name).join(", ")}] to config: ${current.name} v${current.version} -> v${pushed.version}`,
  );
}

main().catch((err) => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
