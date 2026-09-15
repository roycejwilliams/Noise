import { draftProactive, type OutputRules } from "../harness/proactive.js";

export type AskCheckinPayload = {
  askCheckinId: string;
  askId: string;
  askText: string;
  checkinCount: number;
  hasMatches: boolean;
};

// Co Loop Stage 5 check-in on an open ask. Layer 7 (2026-09-14): jobs/index.ts
// only queues an "ask_checkin" candidate when there's movement (open leads
// for the ask) or 14 days have passed; the proactive harness decides when it
// goes out. Never "no match yet" as the whole message.
export async function draftAskCheckin(firstName: string, p: AskCheckinPayload): Promise<{ text: string; rules: OutputRules } | null> {
  const escalate = p.checkinCount >= 2;
  const text = await draftProactive({
    functionId: "agent.askCheckin",
    firstName,
    facts: {
      what_they_told_you_they_want: p.askText,
      times_you_have_checked_in_on_this: p.checkinCount,
      open_leads: p.hasMatches ? "Co has some possible leads but nothing to introduce yet" : "none yet",
    },
    task: escalate
      ? `You've checked in on this ${p.checkinCount} times already. Ask, lightly, whether it's still something they want, and make it easy to say no. Name what it is in plain words.`
      : `Check that this is still what they want, naming it in plain words, so Co keeps looking for the right thing ("Still looking for Series A operators, or has that changed?"). Don't imply anything is lined up. If there's nothing worth asking right now, return SKIP.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 260 } };
}
