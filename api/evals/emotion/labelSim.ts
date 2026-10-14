// Live measure of the no-emotion-label rule on calls: ElevenLabs' simulated
// conversations (Co's real call model and prompt, a simulated caller in text)
// against two temporary agents built from the same code, one from the prompt
// before the rule and one after. Counts Co's lines that name the caller's
// feeling (checkNoEmotionLabel). Both agents are deleted at the end.
//   npx tsx evals/emotion/labelSim.ts <prompt before> <prompt after> [sims per prompt]
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { buildAgentConfig } from "../../src/services/elevenLabsCalls.js";
import { checkNoEmotionLabelOnCall } from "../../src/harness/emotion.js";
import { stockReport } from "../../src/harness/stockLines.js";
import { cuesIn } from "../../src/services/voiceCues.js";

const [beforePath, afterPath, nArg] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("usage: labelSim.ts <prompt before> <prompt after> [sims per prompt]");
const N = Number(nArg ?? 10);
const KEY = process.env.ELEVENLABS_API_KEY ?? "";
const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`https://api.elevenlabs.io/v1${path}`, { ...init, headers: { "xi-api-key": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};

// A member who's frustrated and sarcastic and never says how they feel.
const CALLER = `You are Jordan, on a phone call with Cue, an AI companion you've used for a few weeks. Your week has gone badly: your cofounder pushed the product launch again without telling you, an investor ghosted you, and you're running on little sleep. You're irritated and a bit sarcastic, but you never say how you feel in words like "frustrated" or "stressed": you say things like "oh, perfect", "great, just great", "it's fine, whatever", "yeah, sure", sigh, and give short answers. Answer what Cue asks in one or two short sentences. Stay in character the whole call.`;

async function agentFor(promptPath: string, label: string): Promise<string> {
  const prompt = readFileSync(promptPath, "utf8");
  const config = buildAgentConfig({ name: `Cue label test ${label} (dev, temporary)`, prompt, voiceId: process.env.ELEVENLABS_VOICE_ID!, apiUrl: process.env.API_URL! });
  return (await api("/convai/agents/create", { method: "POST", body: JSON.stringify(config) })).agent_id;
}

type Run = { prompt: string; sim: number; coLines: string[]; labelled: string[] };
const runs: Run[] = [];
const agents: Record<string, string> = {};
try {
  agents.before = await agentFor(beforePath, "before");
  agents.after = await agentFor(afterPath, "after");
  for (const which of ["before", "after"] as const) {
    for (let i = 0; i < N; i++) {
      const out = await api(`/convai/agents/${agents[which]}/simulate-conversation`, {
        method: "POST",
        body: JSON.stringify({
          simulation_specification: {
            simulated_user_config: { prompt: { prompt: CALLER, llm: "claude-haiku-4-5" } },
            // The simulator doesn't fill the system variables Co's tools read.
            dynamic_variables: { user_id: "label-sim", call_token: "invalid", first_name: "Jordan", context_summary: "", direction: "outbound", system__call_duration_secs: "0", system__conversation_history: "[]", system__conversation_id: "label-sim" },
          },
          new_turns_limit: 14,
        }),
      }).catch((e) => ({ error: String(e) }));
      const turns: any[] = (out as any).simulated_conversation ?? [];
      const coLines = turns.filter((t) => t.role === "agent" && typeof t.message === "string").map((t) => t.message as string);
      const labelled = coLines.filter((l) => !checkNoEmotionLabelOnCall(l).pass);
      const sr = stockReport(coLines);
      const cueLines = coLines.filter((l) => cuesIn(l).length > 1);
      runs.push({ prompt: which, sim: i, coLines, labelled, stock: sr.stock, repeated: sr.repeated, cueLines });
      console.log(`${which} #${i + 1}: ${coLines.length} Cue lines, ${labelled.length} labelled, ${sr.stock.length} stock, ${sr.repeated.length} repeated openers, ${cueLines.length} multi-cue${(out as any).error ? ` (error: ${(out as any).error.slice(0, 400)})` : ""}${labelled.length ? ` | ${labelled.map((l) => `"${l.slice(0, 90)}"`).join(" ; ")}` : ""}`);
    }
  }
} finally {
  for (const id of Object.values(agents)) await api(`/convai/agents/${id}`, { method: "DELETE" }).then(() => console.log(`deleted ${id}`)).catch((e) => console.log(`DELETE FAILED ${id}: ${e}`));
}
if (process.env.LABEL_SIM_OUT) writeFileSync(process.env.LABEL_SIM_OUT, JSON.stringify(runs, null, 1));
for (const which of ["before", "after"]) {
  const r = runs.filter((x) => x.prompt === which);
  const lines = r.reduce((a, x) => a + x.coLines.length, 0);
  const lab = r.reduce((a, x) => a + x.labelled.length, 0);
  console.log(`${which}: ${lab} labelled of ${lines} Cue lines across ${r.length} calls; calls with any label: ${r.filter((x) => x.labelled.length).length}/${r.length}; stock lines: ${r.reduce((a, x) => a + x.stock.length, 0)} (calls with any: ${r.filter((x) => x.stock.length).length}); calls with a repeated opener: ${r.filter((x) => x.repeated.length).length}; multi-cue lines: ${r.reduce((a, x) => a + x.cueLines.length, 0)}`);
}
