import { enqueueCandidate, draftProactive, type OutputRules } from "../harness/proactive.js";

export type CalendarFollowPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// "Calendar-follow signal": someone followed the Co Presents calendar before
// ever RSVPing. Only reachable when they're already a matched Co user (see
// routes/luma.ts).
//
// Layer 7 (2026-09-14): queues a "calendar_follow" candidate (once ever per
// person, see TYPE_POLICY) instead of sending; the proactive harness sends it.
export async function runCalendarFollowReachOutAgent(
  person: CalendarFollowPerson,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean }> {
  if (opts.dryRun) {
    console.log(`[calendarFollowReachOut dryRun] would queue calendar-follow reach-out for ${person.userId}`);
    return { sent: false };
  }
  const { queued } = await enqueueCandidate({
    userId: person.userId,
    type: "calendar_follow",
    targetKey: "calendar_follow",
    topicKey: "calendar_follow",
    summary: "They just followed the Co Presents calendar on Luma but haven't RSVPed to anything",
    payload: {},
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
  });
  return { sent: queued };
}

export async function draftCalendarFollow(firstName: string): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.calendarFollowReachOut",
    firstName,
    facts: { what_happened: "they followed the Co Presents calendar on Luma", rsvps: "none yet" },
    task: "Acknowledge that they followed the calendar, and ask one question about what kind of night or people they'd want, so you can point them to the right event. Not a sales pitch.",
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 260 } };
}
