// Co writes its own short lines to members (Royce, 2026-09-25: "Co value is
// in it's intelligence"): the welcome, "your friend joined", the first call
// offer. It used to pick from fixed pools (services/onboardingLines.ts);
// those stay as the style it writes in and as the fallback whenever the
// written line is late, fails, or breaks a rule. Lines to people who aren't
// members yet (the invite-code gate) stay fixed, so a stranger or a bot
// never costs a model call.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { CO_VOICE } from "./coVoice.js";
import { cleanCoMessage } from "./sendblue.js";

export type LineAsk = {
  // What the line is for, plainly.
  purpose: string;
  // Everything it may state. Nothing else.
  facts: string[];
  // Approved lines in the spirit wanted (the old pool).
  examples: readonly string[];
  // Words that must appear (a name it has to use).
  mustInclude?: string[];
  // Used when anything goes wrong.
  fallback: string;
};

const TIMEOUT_MS = 4000;

// A written line is only used if it keeps to what it was given.
export function lineKeepsRules(line: string, ask: Pick<LineAsk, "facts" | "mustInclude">): boolean {
  const t = line.trim();
  if (!t || t.length > 320) return false;
  if (/[—–]/.test(t)) return false;
  // No numbers it wasn't given.
  const given = ask.facts.join(" ");
  for (const n of t.match(/\d+/g) ?? []) if (!given.includes(n)) return false;
  // No links, no addresses, no placeholders.
  if (/https?:\/\/|www\.|@|\{|\}/.test(t)) return false;
  for (const w of ask.mustInclude ?? []) if (w && !t.toLowerCase().includes(w.toLowerCase())) return false;
  return true;
}

export async function lineInVoice(ask: LineAsk): Promise<{ text: string; written: boolean }> {
  try {
    const out = await Promise.race([
      generateText({
        model: anthropic(MODELS.sonnet),
        maxOutputTokens: 200,
        experimental_telemetry: { isEnabled: true, functionId: "voiceLine" },
        prompt: `${CO_VOICE}

Write one text message from Co.
What it's for: ${ask.purpose}
What's true (state nothing beyond this):
${ask.facts.map((f) => `- ${f}`).join("\n")}
${ask.examples.length ? `Lines in the spirit wanted (don't copy them word for word):\n${ask.examples.map((e) => `- ${e}`).join("\n")}\n` : ""}Say it your own way, fresh, the way a person would in the moment. Short, plain, grown. No dashes. Read it back once for grammar. Return only the message.`,
      }).then((r) => r.text),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    const line = out ? cleanCoMessage(out.trim().replace(/^["']|["']$/g, "")) : "";
    if (line && lineKeepsRules(line, ask)) return { text: line, written: true };
  } catch (err: any) {
    console.error("voiceLine: writing failed, using the stock line:", err?.message ?? err);
  }
  return { text: ask.fallback, written: false };
}
