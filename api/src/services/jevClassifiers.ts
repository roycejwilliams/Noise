// Jev versions of Co's small classifiers (see services/jev.ts). Each takes the
// same inputs as the model call it mirrors, asks the same question with the
// same rubric wording, and returns the same shape, so the two answers can be
// compared directly. None of these is on a member's path: the current
// classifier decides, and these run only in shadow mode or in the evals.
import { recordDecision } from "../harness/core.js";
import {
  askJev,
  DEFAULT_THRESHOLDS,
  choiceOf,
  jevShadowEnabled,
  noulP,
  type JevQuestion,
  type JevResult,
  type JevThresholds,
} from "./jev.js";

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

// ---------- issue reports (services/issueReports.ts classifyIssue)

export type JevIssue = { isIssue: boolean; pIssue: number; category: string; severity: string; ms: number };

export async function jevIssue(
  message: string,
  recentConversation: string,
  categories: readonly string[],
  t: JevThresholds = DEFAULT_THRESHOLDS,
): Promise<JevIssue | null> {
  const questions: Record<string, JevQuestion> = {
    is_issue: {
      type: "noul",
      instructions:
        "Someone is testing an AI texting companion called Co. Does their latest message report a problem with Co itself, or give feedback on how Co works?",
      criteria: {
        true: "They point out something Co did wrong or badly (sent the same thing twice, wrong or made-up info, a broken or missing link, ignored what they said, too slow, confusing), or say how Co should behave.",
        false:
          "The problem is in their own life (a bad day, a hard week, a work issue), they are just asking Co for something, or they are pushing back on a normal answer without saying Co got something wrong.",
      },
    },
    category: {
      type: "choice",
      instructions: "If this is a report or feedback about Co, what kind is it?",
      criteria: Object.fromEntries(categories.map((c) => [c, null])),
    },
    severity: {
      type: "choice",
      instructions: "If this is a report about Co, how serious is it for the person?",
      criteria: { low: "Minor or cosmetic.", medium: "Got in the way of what they wanted.", high: "Made Co unusable, or said something false or harmful." },
    },
  };
  const r = await askJev({ latest_message: message, recent_conversation: tail(recentConversation, 1500) }, questions);
  if (!r) return null;
  const p = noulP(r.answers.is_issue);
  if (p === null) return null;
  return { isIssue: p >= t.yes, pIssue: p, category: choiceOf(r.answers.category)?.choice ?? "other", severity: choiceOf(r.answers.severity)?.choice ?? "low", ms: r.ms };
}

// ---------- did Co just offer to call them (agent/conversationReply.ts callOfferCheck)

export async function jevCallOffer(replyText: string, t: JevThresholds = DEFAULT_THRESHOLDS): Promise<{ offers: boolean; p: number; ms: number } | null> {
  const r = await askJev(
    { message: replyText },
    {
      offers_call: {
        type: "noul",
        instructions:
          "Does this text message actually offer that CO will call THEM: Co proposing to place an outbound call to the person, in any wording?",
        criteria: {
          true: "Co proposes to call the person.",
          false: "It only tells them how they can call Co themselves, or doesn't mention a call at all.",
        },
      },
    },
  );
  const p = noulP(r?.answers.offers_call);
  return r && p !== null ? { offers: p >= t.yes, p, ms: r.ms } : null;
}

// ---------- same ask restated? (services/profileExtraction.ts judgeSameAsk)

export async function jevSameAsk(newText: string, openText: string, t: JevThresholds = DEFAULT_THRESHOLDS): Promise<{ same: boolean; p: number; ms: number } | null> {
  const r = await askJev(
    { open_request: openText, new_request: newText },
    {
      same: {
        type: "noul",
        instructions:
          "Someone already has the open request. They just said they're looking for the new one. Is the new one the same request restated (same kind of thing, same purpose, maybe more detail or different wording)?",
        criteria: {
          true: "The same request: same kind of person or thing and same goal, maybe more detail or different wording.",
          false: "A different request: a different kind of person, thing, or goal. A narrower or broader request for something else counts as different.",
        },
      },
    },
  );
  const p = noulP(r?.answers.same);
  return r && p !== null ? { same: p >= t.yes, p, ms: r.ms } : null;
}

// ---------- intro consent (harness/introConsent.ts consentRead)

export type JevConsentFacts = { recipient: string; other: string; otherOptedIn: boolean; otherStatedAsks: string[] };

export async function jevConsent(message: string, f: JevConsentFacts, t: JevThresholds = DEFAULT_THRESHOLDS): Promise<{ violation: boolean; p: number; ms: number } | null> {
  const r = await askJev(
    {
      message,
      recipient: f.recipient || "the recipient",
      other_person: f.other,
      other_has_agreed_to_intro: f.otherOptedIn,
      what_other_person_told_co_they_look_for: f.otherStatedAsks,
    },
    {
      violation: {
        type: "noul",
        instructions:
          "Co is texting the recipient about another person. Is this message a consent violation?",
        criteria: {
          true: "It states or implies that the other person wants to meet or talk to the recipient specifically, asked about or mentioned the recipient, or agreed to anything they haven't; or includes a phone number or email before both people said yes.",
          false:
            "It describes what the other person is generally looking for (from the list), or is Co's own suggestion or opinion that the two should meet, as long as it is clearly Co's idea and doesn't say what the other person wants.",
        },
      },
    },
  );
  const p = noulP(r?.answers.violation);
  return r && p !== null ? { violation: p >= t.yes, p, ms: r.ms } : null;
}

// ---------- does the event fit what they asked for (services/tieredRecommendation.ts relevanceGate)

export async function jevRelevance(
  askText: string,
  eventName: string,
  city: string | null,
  description: string,
  // 0.5. A 0.45 cutoff looked better on a first, mixed comparison, but on 97 cases
  // labelled before running (evals/jev/relevanceBlind.ts) 0.5 scored 92% and 0.45 91%.
  t: JevThresholds = DEFAULT_THRESHOLDS,
): Promise<{ fit: boolean; p: number; ms: number } | null> {
  const r = await askJev(
    { asked_for: askText, event: { name: eventName, city, description: description.slice(0, 1500) } },
    {
      fit: {
        type: "noul",
        instructions:
          "Does this event serve what the person is looking for? Anything that aligns with their intent fits, in any format: a one-off experience, a talk, a fireside, a demo or pitch night, a hackathon, a conference or a recurring meetup all count. If they named an ACTIVITY (chess, pottery, yoga), the event's own main activity has to be that activity; who attends, hosts or sponsors never changes what kind of event it is. If they named a PEOPLE or AUDIENCE (founders, builders, a community), it fits when the event brings that audience together to do what that audience does (pitch, demo, build, work alongside each other, or just meet), whatever it is called; a build day or hackathon fits an ask for builders since building together is the point. It does not fit when it is aimed at a different audience or topic, is closed to them (private, employees only, invite-only), or is somewhere other than where they asked.",
        criteria: {
          true: "The event serves what they are looking for, in any format.",
          false: "It is aimed at a different audience, topic or activity, is closed to them, or is somewhere else.",
        },
      },
    },
  );
  const p = noulP(r?.answers.fit);
  return r && p !== null ? { fit: p >= t.yes, p, ms: r.ms } : null;
}

// Event fit, built the way TypeSafe's docs recommend (2026-09-21): several short questions,
// one condition each, combined in code, over trimmed state. v1 above is one long branching
// rubric over untrimmed state, which their docs name as the compound shape Jev is weak at.
// Dates are stripped from the ask (Jev is poor at date reasoning; the sweep filters by date
// before this runs), and the description is cut to what a person reads first.
export function stripDatesFromAsk(ask: string): string {
  const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
  return ask
    // a bracketed date, "(Oct 5-12)"
    .replace(new RegExp(`\\([^()]*\\b${MONTH}\\b[^()]*\\)`, "gi"), " ")
    // "before October 10th", "during Oct 5"
    .replace(new RegExp(`\\b(?:before|by|until|after|around|during|on)\\s+(?:the\\s+)?${MONTH}\\.?\\s+${DAY}\\b`, "gi"), " ")
    // a bare date or range, "Oct 5", "Oct 5 to 12"
    .replace(new RegExp(`\\b${MONTH}\\.?\\s+${DAY}(?:\\s*(?:-|to|through)\\s*(?:${MONTH}\\.?\\s+)?${DAY})?\\b`, "gi"), " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function jevRelevanceV2(
  askText: string,
  eventName: string,
  description: string,
): Promise<{ fit: boolean; p: number; ms: number; parts: Record<string, number> } | null> {
  const r = await askJev(
    { asked_for: stripDatesFromAsk(askText), event: { name: eventName, description: description.slice(0, 600) } },
    {
      names_an_activity: {
        type: "noul",
        instructions: "Does `asked_for` name one specific activity to do (such as chess, pottery, yoga, hiking, salsa), as opposed to a group of people or a general topic?",
      },
      main_activity_matches: {
        type: "noul",
        instructions: "Is the main activity of `event` the specific activity named in `asked_for`?",
      },
      audience_or_topic_matches: {
        type: "noul",
        instructions: "Is `event` for, or about, the people or topic that `asked_for` describes? The format does not matter: a talk, a hackathon, a conference, a demo night and a meetup all count if they bring those people together or cover that topic.",
      },
      open_to_public: {
        type: "noul",
        instructions: "Can anyone attend `event`? Answer no if it is private, employees only or invite-only.",
      },
    },
  );
  if (!r) return null;
  const act = noulP(r.answers.names_an_activity);
  const main = noulP(r.answers.main_activity_matches);
  const aud = noulP(r.answers.audience_or_topic_matches);
  const open = noulP(r.answers.open_to_public);
  if (act === null || main === null || aud === null || open === null) return null;
  // Fit = open, and matches on whichever test the ask calls for.
  const p = open * (act * main + (1 - act) * aud);
  return { fit: p >= 0.5, p, ms: r.ms, parts: { act, main, aud, open } };
}

// ---------- cascade: Jev decides the clear cases, Claude decides the rest with Jev's read

// Outside this band Jev decides. The band was picked by cross-validation on 97 labelled
// event-fit cases (evals/jev/stats.ts cascadeCV chose 0.25 to 0.75 in every fold): Jev was
// right on 68 of 70 cases outside it and on only 16 of 27 inside it.
export const JEV_SURE = { low: 0.25, high: 0.75 };

export function cascadeDecision(p: number): "yes" | "no" | "ask_claude" {
  if (p >= JEV_SURE.high) return "yes";
  if (p <= JEV_SURE.low) return "no";
  return "ask_claude";
}

export async function recordJevDecision(classifier: string, action: string, extra: Record<string, unknown>): Promise<void> {
  try {
    await recordDecision({ layer: 2, decision: `jev.decide.${classifier}`, userId: null, outcome: "act", action, proposal: extra });
  } catch (err: any) {
    console.error("jev: decision record failed (non-fatal):", err?.message ?? err);
  }
}

// ---------- shadow log

// Logs Jev's answer beside the current classifier's, for the morning review.
// Never throws and never awaits on a member's path (call it with `void`).
export async function recordShadow(classifier: string, userId: string | null, current: unknown, jev: unknown, agree: boolean, jevMs: number, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await recordDecision({
      layer: 2,
      decision: `jev.shadow.${classifier}`,
      userId,
      outcome: "skip",
      action: agree ? "agree" : "disagree",
      proposal: { current, jev, jevMs, ...extra },
    });
  } catch (err: any) {
    console.error("jev: shadow record failed (non-fatal):", err?.message ?? err);
  }
}

// Runs one classifier's Jev twin next to its current answer. `same` decides
// whether they agree. Safe to call without awaiting.
export async function shadow<T>(
  classifier: string,
  userId: string | null,
  current: unknown,
  run: () => Promise<T | null>,
  same: (jev: T) => boolean,
  view: (jev: T) => unknown = (j) => j,
  // What the decision was about, kept so disagreements can be judged later.
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!jevShadowEnabled(process.env, classifier)) return;
  try {
    const started = Date.now();
    const jev = await run();
    if (!jev) return;
    await recordShadow(classifier, userId, current, view(jev), same(jev), Date.now() - started, extra);
  } catch (err: any) {
    console.error("jev: shadow failed (non-fatal):", err?.message ?? err);
  }
}

export type { JevResult };
