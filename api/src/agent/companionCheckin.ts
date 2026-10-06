import { draftProactive, type OutputRules } from "../harness/proactive.js";
import { splitRecap } from "../services/claims.js";

export type CompanionCheckinPerson = {
  userId: string;
  firstName: string;
  phoneNumber: string;
};

// One of their open threads (harness/memberThreads.ts), as the cron hands it.
export type CompanionThread = { text: string; quote: string; dueDate: string | null; feeling: string | null };
// At most one useful thing, already checked against its own page.
export type CompanionItem = { kind: "web"; name: string; url: string; reason: string };

// Royce, 2026-09-03: "how can we make it a companion with what we have now."
// The one proactive text with no ask, event, or outcome behind it, seeded by
// the recap memoryCompaction.ts builds.
//
// Layer 7 (2026-09-14): jobs/index.ts queues a "companion" candidate; the
// proactive harness picks it only when nothing more timely is waiting, and at
// most every 14 days. The bar for sending is one specific open thread from
// the recap; SKIP is the expected answer most of the time.
//
// Threads (2026-09-22): when the member has an open thread on file, the text
// is about that one, in their words, and may carry one useful thing found for
// it. Without one, the recap path below is unchanged.
export async function draftCompanionCheckin(
  firstName: string,
  recap: string,
  thread?: CompanionThread | null,
  item?: CompanionItem | null,
  curious?: CompanionCurious | null,
  story?: CompanionStory | null,
  advice?: CompanionAdvice | null,
  heavy?: CompanionHeavy | null,
): Promise<{ text: string; rules: OutputRules } | null> {
  if (heavy) return draftFromHeavy(firstName, heavy);
  if (advice) return draftFromAdvice(firstName, advice);
  if (story) return draftFromStory(firstName, story);
  if (thread) return draftFromThread(firstName, recap, thread, item ?? null);
  if (curious) return draftFromCuriosity(firstName, recap, curious);
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: (() => { const r = splitRecap(recap.slice(0, 3000)); return { live_things_they_said_about_themselves: r.theySaid || null, recap_of_what_you_know_about_them: r.coRead || null }; })(),
    // The "barely knows them" case (2026-09-22): a member who stopped after
    // giving their name and email has no open thread, so this always
    // returned SKIP and they never heard from Co again.
    task: `Find ONE specific open thread in the recap: something they were in the middle of, deciding, or looking forward to, that they'd plausibly have news about now. Write a short text that names that exact thing and asks how it went or where it landed. No next steps, nothing operational. If the recap has no specific open thread like that, return SKIP; a generic "thinking of you" is never acceptable.

One exception: if the recap shows Co barely knows them yet (little beyond joining and their name), don't SKIP. Write one short, warm, low-pressure text that picks up where things actually left off (the last thing Co asked, if the recap says) and invites them to share what's on their plate these days. No events, no offers, no pitch, no promise of anything Co will do.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 240 } };
}

// Something hard they shared yesterday (services/heavyMoment.ts): one quiet
// check-in the next day. Described, not quoted, so it isn't parroted; the
// reading of what they shared is theirs alone.
export type CompanionHeavy = { about: string | null; quote: string | null; emotion: string; when: "yesterday"; endedAt?: string };

async function draftFromHeavy(firstName: string, heavy: CompanionHeavy): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: {
      what_they_went_through: heavy.about,
      their_own_words_for_context_only_never_quote_them_back: heavy.quote?.slice(0, 300),
      when_they_told_you: heavy.when,
      how_it_sat_with_them: heavy.emotion,
    },
    task: `They went through something hard (what_they_went_through) and you are checking on them the day after, the way a person from a close circle would who simply remembered. Write one short text tied to that specific thing, in their terms: ask how they are doing with it now, or how it sat overnight, in a few plain words. Let how_it_sat_with_them shape the tone only (gentler, lower pressure); never name the feeling or say what they must be feeling.
Do not list or recap what they vented about, do not analyze it, give advice, or offer anything (no events, links, suggestions or introductions). Make no promise. Never hint that you scheduled this, remembered on purpose, keep notes, or are checking in on a schedule; it should read as a thought you had. Do not mention any other person. when_they_told_you is when they told you about it, not when the thing itself happens or happened: never say when the thing itself was, will be, or took place (it may be an upcoming event), and use no time words except "yesterday" for the conversation itself. Never say you have been thinking about them or about it, and never open with a line that would fit any person; start with the specific thing, not a greeting like "Hey". Not a wellness app: a club checking on one of its own, plain and warm. If what they went through involves hurting themselves, or was frustration with Co itself (its calls, search, results or replies) and not something in their life, return SKIP.`,
    maxSentences: 2,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 220, forbidden: [{ pattern: /\b(?:thinking|thought) (?:about|of)\b|\bon my mind\b|\bcrossed my mind\b/i, reason: "a claim about what Co was doing, and a line that fits anyone" }] } };
}

// Advice Co gave a few days ago (services/advice.ts): asks how it went, once.
export type CompanionAdvice = { topic: string; gist: string; daysAgo: number };

async function draftFromAdvice(firstName: string, advice: CompanionAdvice): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: { what_you_advised_them_about: advice.topic, what_you_told_them: advice.gist, days_ago: String(advice.daysAgo) },
    task: `Ask how it went since you talked about what_you_advised_them_about, like an advisor who remembered. Name the thing itself in a few plain words. One short question: did they try it, or where did it land. Use only the facts given; don't add new advice, details or promises, and don't repeat the whole advice. Start with the thought itself, not a greeting like "Hey".`,
    maxSentences: 2,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 240 } };
}

// A moment worth marking (services/milestones.ts): said once, from the record
// only, looking back at where they started when it has their own words.
export type CompanionStory = { text: string; then: string | null; now: string | null };

async function draftFromStory(firstName: string, story: CompanionStory): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: {
      what_happened: story.text,
      ...(story.then ? { their_words_when_it_started: story.then.slice(0, 300) } : {}),
      ...(story.now ? { their_words_when_it_landed: story.now.slice(0, 300) } : {}),
    },
    task: `Mark this moment like a friend who has been beside them the whole way. Say what happened in a few plain words, and if their_words_when_it_started is there, let the contrast with where they are now show, in their terms. Use only what_happened and their words; add nothing that isn't there (no numbers, names, or time words like today or tonight of your own). Warm, not gushing, no exclamation-mark pile. Offer nothing, ask at most one short question, and never promise anything Co will do later. Start with the thought itself, not a greeting like "Hey".`,
    maxSentences: 3,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 3, maxChars: 320 } };
}

// What Co is still figuring out about them, with their own recent words
// (services/understanding.ts). Only asked where the conversation leads
// (Royce, 2026-09-28: "Co should always be figuring out something, but only
// if the conversation leads them there").
export type CompanionCurious = { topic: string; about: string; theirWords: string };

async function draftFromCuriosity(firstName: string, recap: string, curious: CompanionCurious): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: {
      something_co_is_still_figuring_out_about_them: curious.about,
      your_recent_texts_with_them: curious.theirWords,
      ways_co_can_help: "search now for events, communities or opportunities for something they want; point them to people worth meeting at Co events; a quick call to think something through",
      what_co_cannot_do: "find sponsors, investors or funders themselves (only events where they show up); promise to keep watching or keep an eye out",
      recap_for_background_only: recap.slice(0, 1500),
    },
    task: `Text them first, like a friend who was paying attention. Look for one specific thing THEY said in your recent texts that naturally leads somewhere: either toward something_co_is_still_figuring_out_about_them, or toward one concrete way Co could help with it (only from ways_co_can_help, never what_co_cannot_do). Pick it up in their terms and ask one short, warm question, or offer that one way to help as a question. It has to feel like the next step of that conversation, never an interview question out of nowhere. If nothing they said leads there, return SKIP.`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 2, maxChars: 240 } };
}

async function draftFromThread(
  firstName: string,
  recap: string,
  thread: CompanionThread,
  item: CompanionItem | null,
): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.companionCheckin",
    firstName,
    facts: {
      the_thing_they_are_in_the_middle_of: thread.text,
      their_own_words_about_it: thread.quote.slice(0, 300),
      ...(thread.dueDate ? { the_date_they_gave: thread.dueDate } : {}),
      // Feelings shape how it's said, never whether (standing rule).
      ...(thread.feeling ? { how_they_felt_saying_it: thread.feeling } : {}),
      ...(item ? { one_thing_found_for_it: `${item.name}: ${item.reason} ${item.url}` } : {}),
      recap_for_background_only: recap.slice(0, 1500),
    },
    task: `Write a short text about the_thing_they_are_in_the_middle_of, like a friend who remembered: ask how it's going or where it landed, in a few plain words that show you remember what they said. Let how_they_felt_saying_it shape the tone (gentler if it was weighing on them), without naming the feeling.${
      item
        ? ` Then mention one_thing_found_for_it in one short sentence with its link, as something you came across that might help with it. If it wouldn't actually help with this, leave it out and offer nothing. Nothing else offered.`
        : ` Offer nothing: no events, no links, no suggestions.`
    } Never promise anything Co will do later. Don't mention any other person. Start with the thought itself, not a greeting like "Hey".`,
    maxSentences: item ? 3 : 2,
  });
  if (!text) return null;
  // The item goes out only with its own link; a text that left it out is
  // held to the no-item rules (no link at all).
  const carriesItem = Boolean(item) && text.includes(item!.url);
  return {
    text,
    rules: carriesItem
      ? { maxSentences: 3, maxChars: 360, allowUrl: true, mustIncludeAny: [item!.url] }
      : { maxSentences: 2, maxChars: 240 },
  };
}
