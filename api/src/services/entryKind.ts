// Errand or direction? (Royce, 2026-10-06.) Every new thing a member says they want is typed BEFORE it lands (services/profileExtraction.ts
// persistCapturedIntent), and the reclassify pass uses the same definition on what is already stored.
//   ask   an errand with an end: "Find me weekend events", "the link to Pitch Protocol", "who should I talk to about a seed round".
//         Something Co can find, answer or do, and then it is done.
//   goal  direction with no end of its own: "Get Co in front of users", "Plan out the event and take lead", "build a founder community".
//         Where they are headed. It is never "done" by one answer, and nothing should search or check in on it as if it were.
// When unsure it is an ask, because an ask has a lifecycle and a time limit; a goal with none is the riskier mistake to make by default.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import type { EntryKind } from "../harness/profileWrite.js";

export const KIND_DEFINITIONS = `ASK: an errand with an end. Something Co can find, answer, write or do, after which it is done. "Find me weekend events." "Send me the link to Pitch Protocol." "Draft an intro to a VC I met." "How do I start the equity conversation with my cofounder?" "Who should I meet at tech week?"
GOAL: direction with no end of its own. Where they are headed, or a role or mission they are taking on: "Get Co in front of users." "Plan out the event and take lead." "Build a community of founders." "Raise a pre-seed round before the new year." "Make friends who build things." A goal is never finished by one answer.
If you cannot tell, it is an ASK.`;

export function classifyPrompt(text: string): string {
  return `Someone told Co: "${text.slice(0, 300)}"

${KIND_DEFINITIONS}

Answer with one word: ask or goal.`;
}

export type Classify = (text: string) => Promise<EntryKind>;

let classifier: Classify = async (text) => {
  try {
    const { text: out } = await Promise.race([
      generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 10, experimental_telemetry: { isEnabled: true, functionId: "entryKind.classify" }, prompt: classifyPrompt(text) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    return out.trim().toLowerCase().startsWith("goal") ? "goal" : "ask";
  } catch {
    return "ask";
  }
};
// Whatever goes wrong, the answer is "ask".
export const classifyEntryKind: Classify = async (text) => {
  try {
    return (await classifier(text)) === "goal" ? "goal" : "ask";
  } catch {
    return "ask";
  }
};
export function setEntryClassifierForTests(c: Classify | null): void {
  classifier = c ?? (async () => "ask");
}

// The reclassify pass over what is already stored: Sonnet, in one batch, with a reason for each so the list can be read and corrected.
export type ReclassifyItem = { n: string; text: string; status: string; said: string };
export function reclassifyPrompt(items: ReclassifyItem[]): string {
  return `Type each entry below as ASK or GOAL.

${KIND_DEFINITIONS}

Entries (what a member told Co they want):
${items.map((i) => `${i.n}. [${i.said}, ${i.status}] ${i.text}`).join("\n")}

Return ONLY JSON: {"entries": [{"n": "E1", "kind": "ask", "why": "five words"}]}`;
}
export async function reclassify(items: ReclassifyItem[]): Promise<{ n: string; kind: EntryKind; why: string }[]> {
  const out: { n: string; kind: EntryKind; why: string }[] = [];
  for (let i = 0; i < items.length; i += 30) {
    const batch = items.slice(i, i + 30);
    const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, experimental_telemetry: { isEnabled: true, functionId: "entryKind.reclassify", recordInputs: false, recordOutputs: false }, prompt: reclassifyPrompt(batch) });
    const got = parseModelJson<{ entries?: { n?: string; kind?: string; why?: string }[] }>(text).entries ?? [];
    for (const b of batch) {
      const g = got.find((x) => x.n === b.n);
      out.push({ n: b.n, kind: g?.kind === "goal" ? "goal" : "ask", why: String(g?.why ?? "").slice(0, 80) });
    }
  }
  return out;
}
