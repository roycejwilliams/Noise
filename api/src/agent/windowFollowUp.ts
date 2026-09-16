// A check-in after a time frame they searched (Royce, 2026-09-16: "if they are
// searching between a time frame and even the day of. We offer them a follow
// maybe next week like a check in or nudge"), with his own guardrail: keep it
// about them ("how'd this weekend go?"), never another pitch, and under the
// same caps as every other proactive text.
import { draftProactive } from "../harness/proactive.js";
import type { OutputRules } from "../harness/proactive.js";

export type WindowFollowUpPayload = {
  // Their time frame in their words ("this weekend", "thursday").
  label: string;
  // What they asked Co to look for.
  asked: string;
  // What Co actually sent them for it, if anything.
  sent: string[];
};

export async function draftWindowFollowUp(firstName: string, p: WindowFollowUpPayload): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.windowFollowUp",
    firstName,
    facts: {
      time_frame_they_asked_about: p.label,
      what_they_asked_co_to_look_for: p.asked,
      what_co_sent_them: p.sent.length ? p.sent.join("; ") : "nothing that fit",
    },
    task: `That time frame has passed. Write a short, warm text asking how it went for them, like a friend would ("how'd ${p.label} end up going?"). It's about them and their time, not about Co's suggestions. You may mention something Co sent only if it's natural to ask whether they made it. Never suggest anything new, never offer to search, never pitch an event. Start with the question itself, not a greeting like "Hey".`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 200 } };
}
