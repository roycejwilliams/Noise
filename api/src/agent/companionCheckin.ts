import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { tryClaimProactiveNudge } from "../services/proactiveThrottle.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

export type CompanionCheckinPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Royce, 2026-09-03: "how can we make it a companion with what we have
// now" — every other proactive text Co sends has a reason attached (an
// ask, an event, an outcome to check on). This is the one that doesn't.
// It exists purely because Co has been thinking about this person, seeded
// by their own recap (memoryCompaction.ts) — an asset that was previously
// pure internal bookkeeping, never surfaced to the user at all.
//
// The model is explicitly allowed, and expected, to skip most cycles —
// unlike eventAskSolicitation (where sending is "the default case, not an
// edge case"), a generic "just checking in!" with nothing real behind it
// would read as exactly the scripted-status-update feeling postCallFollowUp
// was designed to avoid. Silence is the safe default here; a genuine,
// specific callback is the bar for actually sending.
export async function runCompanionCheckinAgent(
  person: CompanionCheckinPerson,
  recap: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean }> {
  const state = { sent: false };
  const dryRun = opts.dryRun ?? false;

  const tools = {
    sendSms: tool({
      description:
        "Send the drafted check-in to the user via iMessage. Only call this if you have something genuinely specific to say — never to send a generic 'just checking in!' with nothing behind it.",
      inputSchema: z.object({
        message: z.string().describe("The message to send. 1-3 sentences, no em dashes, normal sentence capitalization."),
      }),
      execute: async ({ message }: { message: string }) => {
        const cleaned = cleanCoMessage(message);
        if (dryRun) {
          console.log(`[companionCheckin dryRun] would send to ${person.userId}: "${cleaned}"`);
          return { delivered: false, dryRun: true, message: cleaned };
        }
        if (!(await tryClaimProactiveNudge(person.userId))) {
          console.log(`companionCheckin: throttled — ${person.userId} was proactively nudged in the last 24h`);
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
          console.error("companionCheckin: text_exchange log failed (non-fatal):", err?.message ?? err),
        );
        return { delivered: true, message: cleaned };
      },
    }),
    writeMemory: tool({
      description: "Log what happened, once, after sending (or after deciding to skip this cycle).",
      inputSchema: z.object({
        content: z.string().describe("Short factual note, e.g. what was said or why it was skipped."),
      }),
      execute: async ({ content }: { content: string }) => {
        if (dryRun) {
          console.log(`[companionCheckin dryRun] would write memory for ${person.userId}: "${content}"`);
        } else {
          await writeMemory(person.userId, "companion_checkin", content);
        }
        return { ok: true };
      },
    }),
  };

  const system = `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.firstName}. This is not tied to any ask, event, or update — you're reaching out simply because you've been thinking about them.

Here's what you know about them:
${recap}

Decide first whether there's actually something genuine and specific here worth bringing up — a real detail from the above, not a generic "thinking of you" template. If there is, draft a short, warm message (1-3 sentences, no em dashes, no exclamation points, normal sentence capitalization) that names that specific thing, in Co's own voice — calm, unhurried, like a private members club, not a survey. Never mention next steps, timing, or anything operational; this message's only job is proving you actually remember them. Then send it with sendSms.

If nothing above is specific or recent enough to say something real with, it's fine — expected, even — to skip sendSms entirely this cycle rather than send something generic.

Always finish by calling writeMemory once with a short factual note of what you said (or why you skipped).`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Decide whether to check in, act on that decision, then log it.",
    tools,
    stopWhen: stepCountIs(4),
    experimental_telemetry: { isEnabled: true, functionId: "agent.companionCheckin" },
  });

  return { sent: state.sent };
}
