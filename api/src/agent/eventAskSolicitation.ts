import { enqueueCandidate, draftProactive, type OutputRules } from "../harness/proactive.js";

// The one queued ask per member per event (proactive_candidates.target_key), also read by the walk-in check-in (eventWalkinCheckin.ts).
export const solicitationKey = (eventName: string) => `ask_solicitation:${eventName.toLowerCase()}`;

export type EventAskSolicitationPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Product decision (2026-08-30): a guest with no stated ask does NOT get an
// embedding-similarity fallback nudge. Before this person can be ranked, Co
// asks once what they're hoping to get out of the event; once that lands,
// eventScoring.ts's scoreAgainstStatedAsk path applies to them.
//
// Layer 7 (2026-09-14): this no longer sends. It queues an "ask_solicitation"
// candidate and the proactive harness decides when (or whether) it goes out.
// `sent` means queued, which is what eventScoring.ts's markSolicited needs:
// the ask is in motion, don't queue it again for this event.
export async function runEventAskSolicitationAgent(
  person: EventAskSolicitationPerson,
  eventName: string,
  opts: { dryRun?: boolean } = {},
  // The event's real end time, when known (eventScoring.ts's scoreMatchedGroup
  // has it for a real Luma event; null for the self-reported path). Code
  // review, 2026-09-17: this had no event date at all before, so "who do you
  // want to meet at X" could go out and sit unsent past the event actually
  // ending. With a real end_at, expire there instead of the generic 7-day
  // fallback (kept for when there's no real timing to expire against).
  eventEndAt: string | null = null,
): Promise<{ sent: boolean }> {
  if (opts.dryRun) {
    console.log(`[eventAskSolicitation dryRun] would queue ask solicitation for ${person.userId} (${eventName})`);
    return { sent: false };
  }
  const weekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const eventEnd = eventEndAt ? new Date(eventEndAt) : null;
  const expiresAt = eventEnd && eventEnd.getTime() < weekOut.getTime() ? eventEnd : weekOut;
  const { queued } = await enqueueCandidate({
    userId: person.userId,
    type: "ask_solicitation",
    targetKey: solicitationKey(eventName),
    summary: `Ask what they're hoping to get out of "${eventName}", which they're on the guest list for (no stated ask on file)`,
    payload: { eventName },
    expiresAt,
  });
  return { sent: queued };
}

// Where they say they're headed, from their own record (services/memberKnowledge.ts: active goals only, other people's details already
// stripped), newest first, at most three. Null when it can't be read: the draft then says nothing about their goals either way.
// (Decided 2026-10-19 on Royce's delegation, review of #254: the draft used to say Cue knew "nothing yet" about their goals, which is
// false for a member with goals but no ask.)
export async function solicitationGoals(
  userId: string,
  read: (userId: string) => Promise<{ goals: { text: string; state: string; verifiedAt?: string | Date | null }[] }> = async (id) => (await import("../services/memberKnowledge.js")).memberKnowledge(id, { include: ["goals"] }),
): Promise<string[] | null> {
  try {
    const k = await read(userId);
    // The picker's own reading of active goals (services/sweepSelectContext.ts activeGoals: active only, newest first).
    const { activeGoals } = await import("../services/sweepSelectContext.js");
    return activeGoals(k.goals as any, 3).goals;
  } catch (err: any) {
    console.error("eventAskSolicitation: reading their goals failed (non-fatal, the draft says nothing about them):", err?.message ?? err);
    return null;
  }
}

// goals: where they say they're headed (solicitationGoals). It shapes how the question is put, never what's asked: what they want from
// this event is still unknown, which is why Cue asks.
export async function draftAskSolicitation(firstName: string, eventName: string, goals: string[] | null = null): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.eventAskSolicitation",
    firstName,
    facts: {
      event_they_registered_for: eventName,
      ...(goals?.length ? { where_they_say_they_are_headed: goals.join("; ") } : {}),
      what_they_want_from_this_event: "unknown: that's what you're asking",
    },
    // Their answer is how they get matched in the room. It waits on hard days like any text Cue starts (2026-10-19,
    // harness/proactive.ts HOLD_WHILE_STRUGGLING); the feelings block softens it when it goes.
    task: `Ask, as one real question, who they'd want to meet or what would make "${eventName}" worth their time, so you can point them to the right people there. Name the event. Keep it easy to answer in a few words.${goals?.length ? " Where they say they're headed may shape how you ask; never assume it's what they want from this event." : ""}`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 260 } };
}
