// One question a turn on a call (callLlmProxy.ts say), decided by meaning (Royce, 2026-11-07): a follow-on that asks for the SAME answer
// as the turn's question (a clarification, an example, the same thing put another way) is that question and is said; one that asks for a
// DIFFERENT answer is a second question and is held, whatever word it starts with. Royce's dev calls (2026-10-31 to 11-04) cut Cue off
// on "What's the part you're still figuring out? Like if you woke up tomorrow and you knew, what would you have figured out?".
// The model judges; code guards only the structure: one follow-on a turn is judged, and with no read (none given, a failure, or past
// the time bound) the follow-on is held, as before. No word list decides it.
export type SameQuestion = (first: string, next: string) => Promise<boolean | null>;

export const SAME_QUESTION_TIMEOUT_MS = 1500;

export function sameQuestionPrompt(first: string, next: string): string {
  return `On a phone call, Cue asked the member a question and then, in the same breath, said a second one.

First: "${first}"
Then: "${next}"

Does the second ask for the SAME answer as the first (it clarifies it, gives an example of what's meant, or asks it again another way), or does it ask for a DIFFERENT answer (a new question, even a related one)?

Return ONLY JSON: {"same": true} or {"same": false}`;
}

export function parseSameQuestion(raw: string): boolean | null {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return typeof j.same === "boolean" ? j.same : null;
  } catch {
    return null;
  }
}

// Haiku, bounded: it runs while the voice is still saying the first question, and a slow or failed read holds the follow-on.
export const haikuSameQuestion: SameQuestion = async (first, next) => {
  const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 20, abortSignal: AbortSignal.timeout(SAME_QUESTION_TIMEOUT_MS), experimental_telemetry: { isEnabled: true, functionId: "call.sameQuestion" }, prompt: sameQuestionPrompt(first, next) });
  return parseSameQuestion(text);
};

// What both call paths ask (routes/callLlm.ts, gptLive.ts thinkOnCall): Haiku, or a test's stand-in.
let sameQuestionImpl: SameQuestion = haikuSameQuestion;
export const callSameQuestion: SameQuestion = (first, next) => sameQuestionImpl(first, next);
export function setSameQuestionForTest(f: SameQuestion | null): void {
  sameQuestionImpl = f ?? haikuSameQuestion;
}
