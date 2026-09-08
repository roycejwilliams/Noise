import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { tryClaimProactiveNudge } from "../services/proactiveThrottle.js";

export type EventAskSolicitationPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Product decision (2026-08-30): a guest with no stated ask does NOT get an
// embedding-similarity fallback nudge — that tier was judged too weak to
// actually nudge someone toward. Instead, before this person is eligible for
// any ranking at all, Co tries once to get a real stated ask out of them,
// the same way it already does everywhere else (captureIntent). Only once
// that lands does eventScoring.ts's scoreAgainstStatedAsk path apply to them.
export async function runEventAskSolicitationAgent(
  person: EventAskSolicitationPerson,
  eventName: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean }> {
  const state = { sent: false };
  const dryRun = opts.dryRun ?? false;

  const tools = {
    sendSms: tool({
      description:
        "Send the drafted message to the user via iMessage. Call this once you've drafted something worth sending.",
      inputSchema: z.object({
        message: z.string().describe("The message to send. 1-3 sentences, no em dashes."),
      }),
      execute: async ({ message }: { message: string }) => {
        const cleaned = cleanCoMessage(message);
        if (dryRun) {
          console.log(`[eventAskSolicitation dryRun] would send to ${person.userId}: "${cleaned}"`);
          return { delivered: false, dryRun: true, message: cleaned };
        }
        if (!(await tryClaimProactiveNudge(person.userId))) {
          console.log(`eventAskSolicitation: throttled — ${person.userId} was proactively nudged in the last 24h`);
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
          console.error("eventAskSolicitation: text_exchange log failed (non-fatal):", err?.message ?? err),
        );
        return { delivered: true, message: cleaned };
      },
    }),
    writeMemory: tool({
      description: "Log what happened, once, after sending (or after deciding not to send).",
      inputSchema: z.object({
        content: z.string().describe("Short factual note, e.g. what was asked or why it was skipped."),
      }),
      execute: async ({ content }: { content: string }) => {
        if (dryRun) {
          console.log(`[eventAskSolicitation dryRun] would write memory for ${person.userId}: "${content}"`);
        } else {
          await writeMemory(person.userId, "event_ask_solicitation", content);
        }
        return { ok: true };
      },
    }),
  };

  const system = `You are Co, texting ${person.firstName} by iMessage. They're on the guest list for "${eventName}", but Co doesn't yet know what they're actually hoping to get out of it — no stated ask on file.

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points) asking what they're hoping for from this one — who they'd want to meet, what would make it worth their time. Not a form question, a genuine one, in Co's own voice. Then send it with sendSms.

If for some reason a message doesn't make sense right now, it's fine to skip sendSms — but that should be rare; this is the default case, not an edge case.

Always finish by calling writeMemory once with a short factual note of what you asked (or why you skipped).`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Draft and send the ask-solicitation message, then log it.",
    tools,
    stopWhen: stepCountIs(4),
    experimental_telemetry: { isEnabled: true, functionId: "agent.eventAskSolicitation" },
  });

  return { sent: state.sent };
}
