import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { tryClaimProactiveNudge } from "../services/proactiveThrottle.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

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
        message: z.string().describe("The message to send. 1-3 sentences, no em dashes, normal sentence capitalization."),
      }),
      execute: async ({ message }: { message: string }) => {
        const cleaned = cleanCoMessage(message);
        if (dryRun) {
          console.log(`[calendarFollowReachOut dryRun] would send to ${person.userId}: "${cleaned}"`);
          return { delivered: false, dryRun: true, message: cleaned };
        }
        if (!(await tryClaimProactiveNudge(person.userId))) {
          console.log(`calendarFollowReachOut: throttled — ${person.userId} was proactively nudged in the last 24h`);
          return { delivered: false, throttled: true };
        }
        await sendblue.messages.send({
          number: person.phoneNumber,
          content: cleaned,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
        state.sent = true;
        // Hooked here, not left to the agent's own writeMemory tool call
        // below (Royce, 2026-09-08 sweep) — recentConversation (routes/
        // sendblue.ts) only ever reads text_exchange rows, and this
        // agent's own writeMemory tool writes a different, descriptive
        // type. Doing it here guarantees it happens exactly once, right
        // alongside the real send, regardless of what the model logs.
        await writeMemory(person.userId, "text_exchange", `Co replied: ${cleaned}`).catch((err: any) =>
          console.error("calendarFollowReachOut: text_exchange log failed (non-fatal):", err?.message ?? err),
        );
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

  const system = `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.firstName}. Co noticed they just followed the Co Presents calendar on Luma — interest, but no RSVP yet.

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points, normal sentence capitalization) acknowledging that and inviting them to say more about what they're hoping for, so Co can point them toward the right one when the time comes. Not pushy, not a sales pitch. Then send it with sendSms.

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
