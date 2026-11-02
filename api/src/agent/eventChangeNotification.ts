import { createHash } from "crypto";
import { draftProactive, checkDraft, sendExempt } from "../harness/proactive.js";
import { gate } from "../harness/core.js";
import { writeMemory } from "../services/memory.js";

export type EventChangeNotificationPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Tells an invited guest what actually changed about an event (or that it's
// canceled), grounded only in the diff passed in (eventChangeDetection.ts).
//
// Layer 7 (2026-09-14): transactional, so it doesn't compete for the daily
// proactive pick or count toward caps, but it goes through sendExempt: one
// send per (event, change), logged in the proactive ledger. Local hours are
// enforced by both callers (eventChangeDetection.ts queues off-hours changes
// for the jobs/index.ts cron, which checks the hour again).
export async function runEventChangeNotificationAgent(
  person: EventChangeNotificationPerson,
  eventId: string,
  eventName: string,
  fact: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean }> {
  let message = `Heads up about "${eventName}": ${fact}`;
  try {
    const drafted = await draftProactive({
      functionId: "agent.eventChangeNotification",
      firstName: person.firstName,
      facts: { event: eventName, what_changed: fact },
      task: `Tell them plainly what changed about "${eventName}". Use only what_changed, add nothing. No question unless they need to decide something.`,
    });
    if (drafted && gate(checkDraft(drafted, { maxSentences: 2, maxChars: 300, allowUrl: true })).ok) message = drafted;
  } catch (err: any) {
    console.error("eventChangeNotification: draft failed (non-fatal, sending plain):", err?.message ?? err);
  }

  if (opts.dryRun) {
    console.log(`[eventChangeNotification dryRun] would send to ${person.userId}: "${message}"`);
    return { sent: false };
  }
  // eventId included (code review, 2026-09-17): without it, two different
  // events that happen to share a name and get the same generic fact (e.g.
  // "it's been canceled.") hashed to the same key, so sendExempt's
  // idempotency check silently blocked the second event's real, distinct
  // cancellation notice.
  const changeKey = createHash("sha1").update(`${eventId}\n${eventName}\n${fact}`).digest("hex").slice(0, 16);
  const { sent } = await sendExempt({
    userId: person.userId,
    phoneNumber: person.phoneNumber,
    type: "event_change",
    targetKey: `event_change:${changeKey}`,
    messages: [message],
    // Held by their own rule: queued for when it may go (harness/notifyGate.ts), never dropped.
    queueIfHeld: true,
  });
  if (sent) {
    await writeMemory(person.userId, "event_change_notification", `Told them about a change to "${eventName}": ${fact}`).catch(() => {});
  }
  return { sent };
}
