import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";

// One cheap classification per inbound text, advisory only — folded into
// that same turn's reply prompt as a soft tone nudge, never a rule Co must
// follow and never accumulated across turns (that's a different, larger
// problem — see co_profiles.emotional_state, which is deliberately scoped
// "as of this call/text" for matching, not for shaping the current reply).
// Single-message sentiment is easy to misread (sarcasm, brevity, all-caps),
// so this only fires when the model is actually confident there's a real,
// respond-worthy emotional signal — "none" is the expected answer most of
// the time, by design.
export async function detectTurnTone(message: string, functionId: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `Read this text message someone just sent Co. Is there a clear, strong emotional tone here that Co should genuinely respond differently because of (e.g. frustrated, anxious, excited, grieving, overwhelmed, discouraged)?

Ignore mild or ambiguous tone, tone you're not confident about, sarcasm, or ordinary neutral conversation — "none" should be your answer far more often than not.

Message: "${message}"

If there's a clear strong tone, return ONLY a short lowercase word or phrase for it. Otherwise return ONLY the word "none".`,
    });
    const tone = text.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");
    return tone && tone !== "none" ? tone : null;
  } catch (err: any) {
    console.error("detectTurnTone failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// Same shape and philosophy as detectTurnTone above — one cheap advisory
// classification, folded into the reply prompt as a nudge, never a rule.
// Answers a different question though: not how they feel, but what they
// need right now — to be heard, or to be helped toward an actual answer.
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
