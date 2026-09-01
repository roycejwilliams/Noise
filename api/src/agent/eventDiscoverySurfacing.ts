import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { tryClaimProactiveNudge } from "../services/proactiveThrottle.js";
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
//
// One match per text, always (Royce, 2026-08-30) — briefly bundled every
// real match from a cycle into one tease, but that broke Co's own voice:
// "Oh I was thinking about you... here's..." is a friend mentioning ONE
// thing, not a matching engine handing over a list. Nothing found is
// dropped — eventSurfacingSweep.ts's backlog paces the rest out one at a
// time on the normal cadence instead. This function only ever sees a
// single match.
export async function runEventDiscoverySurfacingAgent(
  person: EventDiscoverySurfacingPerson,
  askText: string,
  match: TierMatch,
  opts: { dryRun?: boolean; revealNow?: boolean } = {},
): Promise<{ sent: boolean; throttled: boolean }> {
  const state = { sent: false, throttled: false };
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
        if (!(await tryClaimProactiveNudge(person.userId))) {
          console.log(`eventDiscoverySurfacing: throttled — ${person.userId} was proactively nudged in the last 24h`);
          state.throttled = true;
          return { delivered: false, throttled: true };
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
  const revealNow = opts.revealNow ?? false;

  // Ask-first (Royce, 2026-08-30) — "for each event that surfaces we should
  // ask the user if they'd be interested; if they are, THEN they get the
  // details/summary." This used to reveal name/link/reason directly in the
  // unprompted text; now it teases and asks, and the real details only go
  // out once they say yes (sendblue.ts's eventOfferContext handles that
  // follow-up, drawing from the event_offer_pending row eventSurfacingSweep.ts
  // writes right after this sends).
  //
  // Short-notice exception (Royce, 2026-08-30) — "will [a lead-time floor]
  // risk users missing an event?" The tease-then-wait-for-a-reply round trip
  // is itself what eats the lead time on something happening today or
  // tomorrow. When eventSurfacingSweep.ts flags revealNow, Co skips the
  // ask-first step entirely and shares the real details straight away —
  // still framed as "I was thinking about you," just compressed into one
  // message instead of two, with the short notice itself named up front so
  // it doesn't read as a normal recommendation. "Still have a message
  // attached to that" (Royce, 2026-08-30) — this is never a bare data dump
  // of name/link, always a real message in Co's voice that happens to
  // include the details.
  const linkLine = "url" in match && match.url ? ` Link: ${match.url}.` : "";
  const system = revealNow
    ? `You are Co, texting ${person.firstName} by iMessage. They recently told you: "${askText}"

Co found ${kindLabel} that fits, but it's short notice: "${match.name}" — ${match.reason}.${linkLine}

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points) in the same "I was thinking about you" register Co always uses, but skip the usual "want to hear more?" step — there isn't time for a back-and-forth. Name it and share the real details (including the link if there is one) directly in this one message, while being upfront that it's short notice so there's no pressure if the timing doesn't work. Then send it with sendSms.

If on reflection this doesn't actually fit well enough to even bring up, skip sendSms — don't force it.

Always finish by calling writeMemory once with a short factual note of what you actually shared (this log is internal, never shown to the user).`
    : `You are Co, texting ${person.firstName} by iMessage. They recently told you: "${askText}"

Co found ${kindLabel} that might genuinely fit — internal-only, do not reveal this in the message: "${match.name}" — ${match.reason}

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points) that hints something crossed your mind for them, without naming what it is, and asks if they'd like to hear more. The register is "I was thinking about you, and this made me think of you" — Co bringing them something because it had them in mind, not delivering a match result or a recommendation-engine output. Don't mention the specific name, link, or event details yet — that's step two, only if they say yes. Then send it with sendSms.

If on reflection this doesn't actually fit well enough to even bring up, skip sendSms — don't force it.

Always finish by calling writeMemory once with a short factual note of what you actually found (name it here — this log is internal, never shown to the user).`;

  await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Decide whether to surface this, draft if so, send, then log.",
    tools,
    stopWhen: stepCountIs(4),
    experimental_telemetry: { isEnabled: true, functionId: "agent.eventDiscoverySurfacing" },
  });

  return { sent: state.sent, throttled: state.throttled };
}
