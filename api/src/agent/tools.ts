import { z } from "zod";
import { tool } from "ai";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import {
  getCoverageNudge,
  markTopicAsked as persistTopicAsked,
  RAPPORT_TOPICS,
  RAPPORT_TOPIC_DESCRIPTIONS,
  type CoverageNudgeProfile,
} from "../services/profileExtraction.js";

export type AskCheckinToolContext = {
  userId: string;
  phoneNumber: string;
  profile: CoverageNudgeProfile | null;
  dryRun: boolean;
};

// Side-effecting tools are bound to server-known context (userId, phoneNumber)
// rather than letting the model supply them — the model only ever controls
// message content and topic choice, never who the message goes to.
export function createAskCheckinTools(ctx: AskCheckinToolContext) {
  // Mutable out-of-band signal so the caller (askCheckin.ts) can tell whether
  // a real send happened, independent of the model's own final text —
  // generateText's return value doesn't cleanly expose "which tool executed,"
  // so this is simpler than parsing tool-call history after the fact.
  const state = { sent: false };

  const tools = {
    checkTopicGap: tool({
      description:
        "Check whether there's a rapport topic Co doesn't have a good read on yet for this person, worth gently working into the check-in if it fits naturally. Returns null if there's nothing worth asking (profile already complete, or everything open was asked too recently).",
      inputSchema: z.object({}),
      execute: async () => {
        const { missingTopic } = await getCoverageNudge(ctx.userId, "", ctx.profile);
        if (!missingTopic) return { missingTopic: null };
        return { missingTopic, description: RAPPORT_TOPIC_DESCRIPTIONS[missingTopic] };
      },
    }),

    sendSms: tool({
      description:
        "Send the drafted check-in text to the user via iMessage. Call this once you've decided to actually check in this cycle — if you decide not to check in right now, don't call this at all.",
      inputSchema: z.object({
        message: z.string().describe("The check-in message to send. 1-3 sentences, no em dashes."),
      }),
      execute: async ({ message }) => {
        const cleaned = cleanCoMessage(message);
        if (ctx.dryRun) {
          console.log(`[askCheckin dryRun] would send to ${ctx.userId}: "${cleaned}"`);
          return { delivered: false, dryRun: true, message: cleaned };
        }
        await sendblue.messages.send({
          number: ctx.phoneNumber,
          content: cleaned,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
        state.sent = true;
        return { delivered: true, message: cleaned };
      },
    }),

    markTopicAsked: tool({
      description:
        "Record that Co actually asked about a rapport topic in the message you sent. Only call this if you used checkTopicGap's suggested topic in the message you sent via sendSms — don't call it if you didn't end up asking, or didn't send anything.",
      inputSchema: z.object({
        topic: z.enum(RAPPORT_TOPICS),
      }),
      execute: async ({ topic }) => {
        persistTopicAsked(ctx.userId, topic);
        return { ok: true };
      },
    }),

    writeMemory: tool({
      description:
        "Log what happened this cycle to Co's memory of this person — call this once, after sending (or after deciding not to send), with a short factual note of what you did and why.",
      inputSchema: z.object({
        content: z.string().describe("Short factual note, e.g. what was asked or why the check-in was skipped."),
      }),
      execute: async ({ content }) => {
        if (ctx.dryRun) {
          console.log(`[askCheckin dryRun] would write memory for ${ctx.userId}: "${content}"`);
        } else {
          await writeMemory(ctx.userId, "check_in", content);
        }
        return { ok: true };
      },
    }),
  };

  return { tools, state };
}
