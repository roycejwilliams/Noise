import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

export type EventChangeNotificationPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// "Proactive event-change/cancellation texts" — Co tells an invited guest
// what actually changed (or that it's canceled), grounded only in the real
// diff/fact passed in (see eventChangeDetection.ts), never guessing at
// details. Same tool-calling pattern as the other proactive-text agents.
export async function runEventChangeNotificationAgent(
  person: EventChangeNotificationPerson,
  eventName: string,
  fact: string,
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
          console.log(`[eventChangeNotification dryRun] would send to ${person.userId}: "${cleaned}"`);
          return { delivered: false, dryRun: true, message: cleaned };
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
          console.error("eventChangeNotification: text_exchange log failed (non-fatal):", err?.message ?? err),
        );
        return { delivered: true, message: cleaned };
      },
    }),
    writeMemory: tool({
      description: "Log what happened, once, after sending.",
      inputSchema: z.object({
        content: z.string().describe("Short factual note of what was communicated."),
      }),
      execute: async ({ content }: { content: string }) => {
        if (dryRun) {
          console.log(`[eventChangeNotification dryRun] would write memory for ${person.userId}: "${content}"`);
        } else {
          await writeMemory(person.userId, "event_change_notification", content);
        }
        return { ok: true };
      },
    }),
  };

  const system = `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.firstName} about "${eventName}", which they're on the guest list for.

Real fact to communicate, exactly as given, no additions: ${fact}

Draft a short, warm, direct message (1-3 sentences, no em dashes, no exclamation points) telling them this. Then send it with sendSms. Always finish by calling writeMemory once.`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Draft and send the notification, then log it.",
    tools,
    stopWhen: stepCountIs(4),
    experimental_telemetry: { isEnabled: true, functionId: "agent.eventChangeNotification" },
  });

  return { sent: state.sent };
}
