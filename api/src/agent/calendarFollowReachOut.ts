import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";

export type CalendarFollowPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// "Calendar-follow signal" — someone followed the Co Presents calendar
// before ever RSVPing. Only reachable when they're already a matched Co
// user (see calendarFollowReachOut.ts's caller) — Co has no way to contact
// someone who followed but isn't a Co user at all, no phone on file.
export async function runCalendarFollowReachOutAgent(
  person: CalendarFollowPerson,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean }> {
  const state = { sent: false };
  const dryRun = opts.dryRun ?? false;

  const tools = {
    sendSms: tool({
      description: "Send the drafted message to the user via iMessage.",
      inputSchema: z.object({
        message: z.string().describe("The message to send. 1-3 sentences, no em dashes."),
      }),
      execute: async ({ message }: { message: string }) => {
        const cleaned = cleanCoMessage(message);
        if (dryRun) {
          console.log(`[calendarFollowReachOut dryRun] would send to ${person.userId}: "${cleaned}"`);
          return { delivered: false, dryRun: true, message: cleaned };
        }
        await sendblue.messages.send({
          number: person.phoneNumber,
          content: cleaned,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
        state.sent = true;
        return { delivered: true, message: cleaned };
      },
    }),
    writeMemory: tool({
      description: "Log what happened, once, after sending (or after deciding not to send).",
      inputSchema: z.object({
        content: z.string().describe("Short factual note."),
      }),
      execute: async ({ content }: { content: string }) => {
        if (dryRun) {
          console.log(`[calendarFollowReachOut dryRun] would write memory for ${person.userId}: "${content}"`);
        } else {
          await writeMemory(person.userId, "calendar_follow_reach_out", content);
        }
        return { ok: true };
      },
    }),
  };

  const system = `You are Co, texting ${person.firstName} by iMessage. Co noticed they just followed the Co Presents calendar on Luma — interest, but no RSVP yet.

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points) acknowledging that and inviting them to say more about what they're hoping for, so Co can point them toward the right one when the time comes. Not pushy, not a sales pitch. Then send it with sendSms.

Always finish by calling writeMemory once.`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Draft and send the reach-out, then log it.",
    tools,
    stopWhen: stepCountIs(4),
    experimental_telemetry: { isEnabled: true, functionId: "agent.calendarFollowReachOut" },
  });

  return { sent: state.sent };
}
