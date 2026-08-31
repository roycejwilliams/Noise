import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import type { TierMatch } from "../services/tieredRecommendation.js";

export type EventDiscoverySurfacingPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Periodic surfacing (jobs/index.ts's cadence sweep, see eventSurfacingSweep.ts)
// — if the tiered recommendation engine found something worth mentioning
// (Tier 1 Co event, Tier 2 public Luma event, or Tier 3 real X-sourced
// opportunity), Co texts about it unprompted. Generalized 2026-08-30 to take
// any TierMatch, not just a Luma event — "Luma & X asks" both need to
// surface through the same agent, not two parallel ones. Same tool-calling
// pattern as askCheckin.ts/eventAskSolicitation.ts.
export async function runEventDiscoverySurfacingAgent(
  person: EventDiscoverySurfacingPerson,
  askText: string,
  match: TierMatch,
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
          console.log(`[eventDiscoverySurfacing dryRun] would send to ${person.userId}: "${cleaned}"`);
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
        content: z.string().describe("Short factual note, e.g. what was surfaced or why it was skipped."),
      }),
      execute: async ({ content }: { content: string }) => {
        if (dryRun) {
          console.log(`[eventDiscoverySurfacing dryRun] would write memory for ${person.userId}: "${content}"`);
        } else {
          await writeMemory(person.userId, "event_discovery_surfacing", content);
        }
        return { ok: true };
      },
    }),
  };

  const kindLabel = match.kind === "co_event" ? "a Co event" : match.kind === "public_event" ? "a public event" : "a real opportunity";
  const linkLine = "url" in match && match.url ? `Link: ${match.url}` : "";

  const system = `You are Co, texting ${person.firstName} by iMessage. They recently told you: "${askText}"

Co found ${kindLabel} that might genuinely fit: "${match.name}"
${linkLine}
Grounding: ${match.reason}

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points) surfacing this — grounded in what they actually said they wanted, not generic enthusiasm. Include the link if there is one. It's fine to be honest that it's a suggestion, not a guarantee it's right for them. Then send it with sendSms.

If on reflection this doesn't actually fit well enough to mention, skip sendSms — don't force it.

Always finish by calling writeMemory once with a short factual note of what you did.`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Decide whether to surface this, draft if so, send, then log.",
    tools,
    stopWhen: stepCountIs(4),
    experimental_telemetry: { isEnabled: true, functionId: "agent.eventDiscoverySurfacing" },
  });

  return { sent: state.sent };
}
