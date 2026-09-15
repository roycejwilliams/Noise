import { enqueueCandidate, draftProactive, type OutputRules } from "../harness/proactive.js";

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
): Promise<{ sent: boolean }> {
  if (opts.dryRun) {
    console.log(`[eventAskSolicitation dryRun] would queue ask solicitation for ${person.userId} (${eventName})`);
    return { sent: false };
  }
  const { queued } = await enqueueCandidate({
    userId: person.userId,
    type: "ask_solicitation",
    targetKey: `ask_solicitation:${eventName.toLowerCase()}`,
    summary: `Ask what they're hoping to get out of "${eventName}", which they're on the guest list for (no stated ask on file)`,
    payload: { eventName },
    // This signature has no event date; a week is the outer bound for an
    // upcoming guest list to still be relevant.
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return { sent: queued };
}

export async function draftAskSolicitation(firstName: string, eventName: string): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.eventAskSolicitation",
    firstName,
    facts: { event_they_registered_for: eventName, what_co_knows_about_their_goals_for_it: "nothing yet" },
    task: `Ask, as one real question, who they'd want to meet or what would make "${eventName}" worth their time, so you can point them to the right people there. Name the event.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 260 } };
}
