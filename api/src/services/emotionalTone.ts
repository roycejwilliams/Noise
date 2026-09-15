import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";

// One cheap advisory classification, folded into the reply prompt as a
// nudge, never a rule. Not how they feel (that's harness/emotion.ts), but
// what they need right now — to be heard, or to be helped toward an actual answer.
// Most people who want a real answer never ask for one outright, they just
// stop describing their situation and start turning it over out loud —
// weighing options, circling the same decision. Reflection is still the
// right default; this only fires when the shift away from it looks real.
export async function detectSeekingMode(
  message: string,
  recentConversation: string,
  functionId: string,
): Promise<"solving" | null> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `Read this text conversation with Co, and their latest message.

Recent conversation, in order:
${recentConversation || "(start of the conversation)"}

Their latest message: "${message}"

Right now, do they clearly want a real answer or help deciding something — not just to be listened to or reflected back? This is true when they're weighing options out loud, stuck on a decision, asking what to do without phrasing it as a question, or have clearly moved past venting and are ready for something concrete. It is NOT true for ordinary sharing, updates, or venting where reflection is still the right response — that should be the answer far more often than not.

Return ONLY "solving" if you're genuinely confident. Otherwise return ONLY "none".`,
    });
    const mode = text.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");
    return mode === "solving" ? "solving" : null;
  } catch (err: any) {
    console.error("detectSeekingMode failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
