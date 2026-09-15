import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { writeMemory } from "../services/memory.js";
import { tryClaimProactiveNudge } from "../services/proactiveThrottle.js";
import type { TierMatch } from "../services/tieredRecommendation.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";

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
  const dryRun = opts.dryRun ?? false;

  // revealNow sends deterministically, not via agent tool-calling (Royce,
  // 2026-09-02, confirmed live) — this is the exact path that produced the
  // 2am "thinking about you" text with the link embedded mid-sentence
  // ("...could be a good connection point for the accelerator path you
  // mentioned: https://lu.ma/jjys158h. It's short notice..."). Same fix
  // already applied to the conversational recommendation path
  // (routes/sendblue.ts): the link goes out as its own bare message first
  // (real iMessage preview), then a separate message with the warm
  // "short notice, here's why it fits" framing — the model only drafts
  // that second message's text (no tools, no link to embed), it never
  // owns the send sequence itself.
  if (opts.revealNow ?? false) {
    return runRevealNowDeterministic(person, askText, match, dryRun);
  }

  const state = { sent: false, throttled: false };

  const tools = {
    sendSms: tool({
      description: "Send the drafted message to the user via iMessage.",
      inputSchema: z.object({
        message: z.string().describe("The message to send. 1-3 sentences, no em dashes, normal sentence capitalization."),
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
        // Hooked here, not left to the agent's own writeMemory tool call
        // below (Royce, 2026-09-08 sweep) — recentConversation (routes/
        // sendblue.ts) only ever reads text_exchange rows, and this
        // agent's own writeMemory tool writes a different, descriptive
        // type. Doing it here guarantees it happens exactly once, right
        // alongside the real send, regardless of what the model logs.
        await writeMemory(person.userId, "text_exchange", `Co replied: ${cleaned}`).catch((err: any) =>
          console.error("eventDiscoverySurfacing: text_exchange log failed (non-fatal):", err?.message ?? err),
        );
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

  // Ask-first (Royce, 2026-08-30) — "for each event that surfaces we should
  // ask the user if they'd be interested; if they are, THEN they get the
  // details/summary." This used to reveal name/link/reason directly in the
  // unprompted text; now it teases and asks, and the real details only go
  // out once they say yes (sendblue.ts's eventOfferContext handles that
  // follow-up, drawing from the event_offer_pending row eventSurfacingSweep.ts
  // writes right after this sends). The revealNow (short-notice) case is
  // handled entirely by runRevealNowDeterministic below, before this point.
  const system = `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.firstName}. They recently told you: "${askText}"

Co found ${kindLabel} that might genuinely fit — internal-only, do not reveal this in the message: "${match.name}" — ${match.reason}

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points, normal sentence capitalization) that hints something crossed your mind for them, without naming what it is, and asks if they'd like to hear more. The register is "I was thinking about you, and this made me think of you" — Co bringing them something because it had them in mind, not delivering a match result or a recommendation-engine output. Don't mention the specific name, link, or event details yet — that's step two, only if they say yes. Then send it with sendSms.

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

// Deterministic short-notice reveal (Royce, 2026-09-02) — sends the bare
// link as its own message (real iMessage preview), then a separately
// drafted warm message with the "short notice, here's why it fits"
// framing — never the two combined into one paragraph. The model only
// drafts the second message's text (plain generateText, no tools, no send
// authority); it never owns the send sequence, matching the same
// reliability reasoning as routes/sendblue.ts's deterministic
// recommendation sending (an LLM asked to execute a precise multi-message
// sequence via tool-calling instructions proved unreliable once other
// context was competing for its attention in that case).
async function runRevealNowDeterministic(
  person: EventDiscoverySurfacingPerson,
  askText: string,
  match: TierMatch,
  dryRun: boolean,
): Promise<{ sent: boolean; throttled: boolean }> {
  if (!dryRun && !(await tryClaimProactiveNudge(person.userId))) {
    console.log(`eventDiscoverySurfacing: throttled — ${person.userId} was proactively nudged in the last 24h`);
    return { sent: false, throttled: true };
  }

  const kindLabel = match.kind === "co_event" ? "a Co event" : match.kind === "public_event" ? "a public event" : "a real opportunity";
  const url: string | undefined = "url" in match ? match.url : undefined;

  const { text: raw } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    experimental_telemetry: { isEnabled: true, functionId: "agent.eventDiscoverySurfacing.revealNowDraft" },
    prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.firstName}. They recently told you: "${askText}"

Co found ${kindLabel} that fits, but it's short notice: "${match.name}" — ${match.reason}.

${url ? "The real link is being sent as its own separate message right before this one — never mention a link, never say you're \"sharing\" or \"sending\" one, just reference the thing itself." : ""}

Draft a short, warm message (1-3 sentences, no em dashes, no exclamation points, normal sentence capitalization) in the same "I was thinking about you" register Co always uses, naming what it is and why it fits, while being upfront that it's short notice so there's no pressure if the timing doesn't work. Skip the usual "want to hear more?" step — there isn't time for a back-and-forth, and the details are already going out.

If on reflection this doesn't actually fit well enough to even bring up, return exactly the single word: SKIP

Return ONLY the message text (or SKIP), nothing else — no preamble, no quotes.`,
  });
  const draft = raw.trim();
  if (draft.toUpperCase() === "SKIP" || !draft) {
    return { sent: false, throttled: false };
  }
  const description = cleanCoMessage(draft);

  if (dryRun) {
    if (url) console.log(`[eventDiscoverySurfacing dryRun] would send link to ${person.userId}: "${url}"`);
    console.log(`[eventDiscoverySurfacing dryRun] would send to ${person.userId}: "${description}"`);
    await writeMemory(person.userId, "event_discovery_surfacing", `Revealed directly (short notice): ${match.name}`);
    return { sent: true, throttled: false };
  }

  if (url) {
    await sendblue.messages.send({
      number: person.phoneNumber,
      content: url,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
    await writeMemory(person.userId, "text_exchange", `Co replied: ${url}`).catch((err: any) =>
      console.error("eventDiscoverySurfacing: text_exchange log failed for url (non-fatal):", err?.message ?? err),
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await sendblue.messages.send({
    number: person.phoneNumber,
    content: description,
    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
  });
  await writeMemory(person.userId, "event_discovery_surfacing", `Revealed directly (short notice): ${match.name} — ${description}`);
  // Same gap as the tool-based path above (Royce, 2026-09-08 sweep) — this
  // deterministic path never called the writeMemory tool at all, so
  // recentConversation had no record of the actual message text either.
  await writeMemory(person.userId, "text_exchange", `Co replied: ${description}`).catch((err: any) =>
    console.error("eventDiscoverySurfacing: text_exchange log failed (non-fatal):", err?.message ?? err),
  );

  return { sent: true, throttled: false };
}
