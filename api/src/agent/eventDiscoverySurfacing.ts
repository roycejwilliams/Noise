import type { TierMatch } from "../services/tieredRecommendation.js";
import { draftProactive, nameTokens, type Facts, type OutputRules } from "../harness/proactive.js";
import { renderEventDetails } from "../services/eventDetails.js";

export type EventDiscoverySurfacingPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// Layer 7 (2026-09-14): this file only drafts. The event/opportunity found by
// the sweep (eventSurfacingSweep.ts) becomes an "event_offer" candidate, and
// src/harness/proactive.ts decides whether it goes out today and sends it.
//
// One match per text, always (Royce, 2026-08-30): a friend mentions ONE
// thing, not a list. Ask-first by default: the tease hints and asks, and the
// name/link only go out once they say yes (routes/sendblue.ts). Short notice
// (today or tomorrow) skips the tease and reveals directly: link as its own
// message first for the iMessage preview, then the drafted line.

// No stated ask means askText was built from their profile; the draft must
// not claim they said it.
export function describeAsk(askText: string, fromProfile: boolean): string {
  return fromProfile
    ? `They haven't asked for anything specific. From what they've shared with you over time: ${askText}`
    : `What they told you they're looking for: "${askText}"`;
}

function kindLabel(match: TierMatch): string {
  return match.kind === "co_event" ? "a Co event" : match.kind === "public_event" ? "a public event" : "a real opportunity";
}

function matchFacts(askText: string, fromProfile: boolean, match: TierMatch): Facts {
  return {
    why_you_are_texting: describeAsk(askText, fromProfile),
    kind: kindLabel(match),
    name: match.name,
    date: "event_date" in match ? match.event_date : null,
    application_deadline: "deadline" in match ? (match.deadline ?? null) : null,
    why_it_fits: match.whyItFits ?? match.reason,
  };
}

// The reveal can use the real record; the tease can't (it names nothing).
function revealFacts(askText: string, fromProfile: boolean, match: TierMatch): Facts {
  return {
    ...matchFacts(askText, fromProfile, match),
    details: match.details ? renderEventDetails(match.name, match.details) : null,
    source_post: match.opportunity?.postText ?? null,
  };
}

// Tease: hint without naming it, one yes/no question.
export async function draftEventTease(
  person: { firstName: string },
  askText: string,
  fromProfile: boolean,
  match: TierMatch,
): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.eventDiscoverySurfacing",
    firstName: person.firstName,
    facts: matchFacts(askText, fromProfile, match),
    task: `Something came up that fits them: ${kindLabel(match)}. Write a short text saying you came across something that made you think of them, tied to one concrete detail of what they're looking for (in plain words), without naming it, its host, its date, or what kind of gathering it is (don't say mixer, dinner, office hours, meetup, or any word from its name that they didn't use themselves). End with one yes/no question asking if they want the details. If it doesn't actually fit what they're looking for, return SKIP.`,
  });
  if (!text) return null;
  // Withhold the name and every word of it they didn't use themselves, so
  // "climate founders" can still describe what they want but "mixer" or
  // "office hours" can't give the event away (eval l01/l02, 2026-09-15).
  const distinctive = nameTokens(match.name).filter((t) => !askText.toLowerCase().includes(t));
  return {
    text,
    rules: {
      maxSentences: 2,
      maxChars: 260,
      mustNotInclude: [match.name, ...distinctive],
      // The date is step two as well ("something's happening on the 18th",
      // eval l01).
      forbidden: [{ pattern: /\b(\d{1,2}(st|nd|rd|th)|\d{1,2}\/\d{1,2}|(mon|tues|wednes|thurs|fri|satur|sun)day|tonight|tomorrow)\b/i, reason: "reveals when it is in a tease" }],
    },
  };
}

// Short-notice reveal: name it, when, and why it fits, upfront that it's
// short notice. The link (if any) goes out first as its own message.
export async function draftEventReveal(
  person: { firstName: string },
  askText: string,
  fromProfile: boolean,
  match: TierMatch,
): Promise<{ messages: string[]; text: string; rules: OutputRules } | null> {
  const url: string | undefined = "url" in match ? match.url : undefined;
  const text = await draftProactive({
    functionId: "agent.eventDiscoverySurfacing.revealNowDraft",
    firstName: person.firstName,
    facts: revealFacts(askText, fromProfile, match),
    task: `It's short notice, so skip the "want to hear more?" step. Name it and when it is, say in plain words why it fits them, and be upfront that it's short notice so there's no pressure.${url ? " The link goes out as its own message right before yours; don't mention a link." : ""} If it doesn't actually fit, return SKIP.`,
  });
  if (!text) return null;
  const tokens = nameTokens(match.name);
  return {
    messages: url ? [url, text] : [text],
    text,
    rules: { maxSentences: 2, maxChars: 300, mustIncludeAny: tokens.length ? tokens : [match.name] },
  };
}
