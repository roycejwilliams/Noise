// A check-in after a time frame they searched (Royce, 2026-09-16: "if they are
// searching between a time frame and even the day of. We offer them a follow
// maybe next week like a check in or nudge"), with his own guardrail: keep it
// about them ("how'd this weekend go?"), never another pitch, and under the
// same caps as every other proactive text.
import { draftProactive } from "../harness/proactive.js";
import type { OutputRules } from "../harness/proactive.js";
import { mentionsUnknownDay } from "../services/askWindow.js";

export type WindowFollowUpPayload = {
  // "commitment" (2026-09-22): something they said they'd do by a date, from
  // their open threads (harness/memberThreads.ts). Absent = a searched time frame.
  kind?: "commitment";
  // Their time frame in their words ("this weekend", "thursday").
  label: string;
  // What they asked Co to look for.
  asked: string;
  // What Co actually sent them for it, if anything.
  sent: string[];
  // The real dates behind the label ("Saturday (Saturday, September 19)"), so
  // the follow-up never has to guess which day it means.
  dates?: string;
};

export async function draftWindowFollowUp(firstName: string, p: WindowFollowUpPayload): Promise<{ text: string; rules: OutputRules } | null> {
  const text = p.kind === "commitment" ? await draftCommitment(firstName, p) : await draftProactive({
    functionId: "agent.windowFollowUp",
    firstName,
    facts: {
      time_frame_they_asked_about: p.dates ?? p.label,
      what_they_asked_co_to_look_for: p.asked,
      what_co_sent_them: p.sent.length ? p.sent.join("; ") : "nothing that fit",
    },
    task: `That time frame has passed. Write a short, warm text asking how it went for them, like a friend would ("how'd ${p.label} end up going?"). It arrives out of the blue, so say which day it was and what it was about in a few words ("Saturday the 19th, the day you asked me to look for something on. How'd it go?"), using only the dates in time_frame_they_asked_about and never any other date or day number. It's about them and their time, not about Co's suggestions. You may mention something Co sent only if it's natural to ask whether they made it. Never suggest anything new, never offer to search, never pitch an event. Start with the question itself, not a greeting like "Hey".`,
  });
  if (!text) return null;
  // A date the follow-up names must be one of the real ones (2026-09-21: "How'd
  // Saturday the 10th end up going?" about a Saturday that hadn't happened).
  if (mentionsUnknownDay(text, p.dates ?? p.label)) return null;
  return { text, rules: { maxSentences: 2, maxChars: 260 } };
}

// Their own words, their own date: "I'll send the deck Friday" → the morning
// after, how it went. About them, never a pitch (Royce, 2026-09-22).
function draftCommitment(firstName: string, p: WindowFollowUpPayload): Promise<string | null> {
  return draftProactive({
    functionId: "agent.commitmentFollowUp",
    firstName,
    facts: {
      what_they_said_they_would_do: p.asked,
      the_day_they_named: p.dates ?? p.label,
    },
    task: `They told Co they'd do this by that day, and the day has passed. Write a short, warm text asking how it went, like a friend who remembered ("How'd sending the deck go on Friday?"). Name the thing in a few words and the day, using only the_day_they_named and never any other date or day number. No advice, no suggestions, no events, no offer to help, nothing Co will do. Start with the question itself, not a greeting like "Hey".`,
  });
}
