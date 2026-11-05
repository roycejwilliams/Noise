// The net under a delivered text that is the turn's whole answer (anythingForMe): when Co still drafts a separate reply after it, a small model check reads whether
// that reply answers something else in their message. An answer goes; commentary on the link ("Done, the deck's built around the
// navy and gold") doesn't, since the link's text is the whole delivery. If the check can't run, the reply goes: a second text is
// better than a dropped answer.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";

export type Judge = (prompt: string) => Promise<string>;
const haiku: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "reply.afterLink" }, prompt, abortSignal: AbortSignal.timeout(15_000) })).text;

// Pure: the prompt.
export function afterLinkPrompt(theirMessage: string, linkText: string, draft: string): string {
  return `A member texted: """${theirMessage.slice(0, 2000)}"""

Cue already sent them this, with a link to what it made: """${linkText.slice(0, 600)}"""

Cue now wants to send a second text: """${draft.slice(0, 1200)}"""

Does the second text answer a question they asked, or respond to something they said, beyond the request to make or change it, and say something the first text didn't already say? Answering a question about how to use, send or present it counts. Describing what Cue made (what's in it, how it looks, that it's done or ready) does not count.

Return ONLY JSON: {"answersSomethingElse": true or false}`;
}

// True: send it. False: it's only about the link. An error counts as true (never drop an answer).
export async function afterLinkAnswers(theirMessage: string, linkText: string, draft: string, judge: Judge = haiku): Promise<boolean> {
  try {
    return parseModelJson<{ answersSomethingElse?: boolean }>(await judge(afterLinkPrompt(theirMessage, linkText, draft))).answersSomethingElse !== false;
  } catch {
    return true;
  }
}
