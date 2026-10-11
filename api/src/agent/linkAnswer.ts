// A page, deck or share link and the answer to anything else they asked, in ONE text (Royce, 2026-10-11: "Never drop it silently:
// deliver the link AND answer the question in one text"). The link's tools take alsoAnswer; it goes after the link in the same
// message, through the same fact check and brand guard as any reply (ctx.checkAnswer, set by conversationTools.ts).
//
// And the net under it (afterLinkAnswers): when Co still drafts a separate reply after a link, a small model check reads whether
// that reply answers something else in their message. An answer goes; commentary on the link ("Done, the deck's built around the
// navy and gold") doesn't, since the link's text is the whole delivery. If the check can't run, the reply goes: a second text is
// better than a dropped answer.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { z } from "zod";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import type { ConversationToolContext } from "./conversationTools.js";

export const ALSO_ANSWER = z
  .string()
  .nullable()
  .optional()
  .describe("Only if their message also asked or said something else that needs an answer: your answer to it, in a sentence or two. It goes in the same text, after the link. Never about the page or deck itself.");

// The text with the answer after the link, checked like any reply; the bare text when there's no answer, no check to run it through,
// or nothing survives the check. confirm() is called only once the text actually sent: then, and only then, Co's record says it
// answered (review of PR 1: a receipt written before a failed send would let Co claim an answer that never went).
export async function withAnswer(ctx: ConversationToolContext, text: string, answer: string | null | undefined): Promise<{ text: string; confirm: () => void }> {
  const a = answer?.trim();
  const checked = a && ctx.checkAnswer ? (await ctx.checkAnswer(a).catch(() => "")).trim() : "";
  if (!checked) return { text, confirm: () => {} };
  return {
    text: `${text}\n\n${checked}`,
    confirm: () => {
      ctx.facts?.add("did_this_turn", `Answered the other thing they asked in the same text as the link: "${checked.slice(0, 160)}"`);
      ctx.noteAnswerSent?.(checked);
    },
  };
}

export type Judge = (prompt: string) => Promise<string>;
const haiku: Judge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "reply.afterLink" }, prompt, abortSignal: AbortSignal.timeout(15_000) })).text;

// Pure: the prompt.
export function afterLinkPrompt(theirMessage: string, linkText: string, draft: string): string {
  return `A member texted: """${theirMessage.slice(0, 2000)}"""

Co already sent them this, with a link to what it made: """${linkText.slice(0, 600)}"""

Co now wants to send a second text: """${draft.slice(0, 1200)}"""

Does the second text answer a question they asked, or respond to something they said, beyond the request to make or change it, and say something the first text didn't already say? Answering a question about how to use, send or present it counts. Describing what Co made (what's in it, how it looks, that it's done or ready) does not count.

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
