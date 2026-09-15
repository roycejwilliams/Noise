import { draftProactive, type OutputRules } from "../harness/proactive.js";

export type CompanionCheckinPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Royce, 2026-09-03: "how can we make it a companion with what we have now."
// The one proactive text with no ask, event, or outcome behind it, seeded by
// the recap memoryCompaction.ts builds.
//
// Layer 7 (2026-09-14): jobs/index.ts queues a "companion" candidate; the
// proactive harness picks it only when nothing more timely is waiting, and at
// most every 14 days. The bar for sending is one specific open thread from
// the recap; SKIP is the expected answer most of the time.
export async function draftCompanionCheckin(firstName: string, recap: string): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: { recap_of_what_you_know_about_them: recap.slice(0, 3000) },
    task: `Find ONE specific open thread in the recap: something they were in the middle of, deciding, or looking forward to, that they'd plausibly have news about now. Write a short text that names that exact thing and asks how it went or where it landed. No next steps, nothing operational. If the recap has no specific open thread like that, return SKIP; a generic "thinking of you" is never acceptable.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 240 } };
}
