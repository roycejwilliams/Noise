import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

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
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `Read this text message someone just sent Co, a life concierge. Is there a clear, strong emotional tone here that Co should genuinely respond differently because of (e.g. frustrated, anxious, excited, grieving, overwhelmed, discouraged)?

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
