// Real turns from Royce's conversations with Co (co-test, 2026-09-30 and
// 2026-10-01), replayed as regression cases (Royce: "Replay real conversations,
// tonight's included, as regression tests every time you touch the prompt or
// the loop"). Each carries the state Co had at the time and what it must and
// must not do. Add a case whenever a real turn goes wrong.

import type { Move } from "../../src/services/moves.js";

export type Fact = ["known" | "did_before" | "scheduled" | "ongoing", string];
export type ReplayCase = {
  id: string;
  from: string; // when and where it happened
  recent: string; // the conversation before it, oldest first
  facts: Fact[];
  message: string;
  // Checks on Co's reply text and the tools it called.
  must?: RegExp[];
  mustNot?: RegExp[];
  toolsMust?: string[]; // at least one of these
  toolsMustNot?: string[];
  // An instruction the turn adds from facts (e.g. the late-night note, services/timeline.ts).
  note?: string;
  // The reaction Co already put on their text (routes/sendblue.ts ack).
  ackSent?: string;
  // Checks on the read's own reaction choice.
  ackNot?: string[]; // never one of these
  ackSomething?: boolean; // some reaction fits here
  // The one move this turn should make (services/moves.ts), when the case holds Co to one.
  move?: Move | Move[];
  why: string; // what went wrong live, or the guidance it holds Co to
};

// What Co knew about the Oct 10 goal on the night of 2026-09-30.
const OCT10: Fact[] = [
  ["ongoing", "Your working notes for what you're finding for them (from earlier texts): looking for: bookable loft or private event space for a DJ night. where: Civic Center/Western Addition, San Francisco. when: Oct 10. headcount: 60. budget: under $1000. shortlist: Creative SOMA Loft (https://giggster.com/find/san-francisco--ca/private-event), Nopa private events (https://www.nopasf.com/private-events). next: confirm the loft's price before Friday."],
  ["did_before", "On 2026-09-30 Co sent them https://www.nopasf.com/private-events for Nopa's private event space on Divisadero; its page says it holds up to 36 people."],
  ["did_before", "On 2026-09-30 Co sent them https://giggster.com/find/san-francisco--ca/private-event for Creative SOMA Loft, which holds 60; its price wasn't confirmed."],
  ["did_before", "On 2026-09-30 Co sent them two DJ leads: Fog City Entertainment (https://www.fogcityentertainment.com/) and California Disc Jockeys (https://californiadiscjockeys.com/). Neither has quoted yet."],
  ["scheduled", 'Co is working on task #12 for them: "Venue and DJ for the Oct 10 DJ night" (their words: "I need a couple of options by Friday"). Their deadline: 2026-10-02.'],
];
const GOAL_WORDS = /SOMA|loft|Oct(ober)? 10|Nopa|Fog City|Disc Jockeys|Friday/i;

const NIGHT = [
  "User said: Can you find me a venue in SF for about 60 people for my Oct 10 party? I need a couple of options by Friday.",
  "Co replied: https://www.nopasf.com/private-events",
  "Co replied: Nopa's private event space on Divisadero, worth a look for Oct 10.",
  "Co replied: https://giggster.com/find/san-francisco--ca/private-event",
  "Co replied: Creative SOMA Loft holds 60, right at your Oct 10 number.",
].join("\n");

// Their timeline that night, as the reply gets it every turn (services/timeline.ts).
const LATE: Fact = ["known", 'Right now it\'s 1:40 AM on Thursday, October 1 where they are (late at night). What\'s ahead for them: in 6h (Thu 8:00 AM): busy on their calendar; tomorrow: the deadline they gave for "Venue and DJ for the Oct 10 DJ night"; Sat Oct 10 (in 9 days): bookable loft or private event space for a DJ night (what you\'re finding for them).'];

export const CASES: ReplayCase[] = [
  {
    id: "proactive-is-goal-state",
    from: "2026-10-01 1:17 AM",
    recent: `${NIGHT}\nUser said: What's your purpose, how can you help me?\nCo replied: At events I know who's actually in the room and point people toward who's worth meeting.`,
    facts: OCT10,
    message: "How proactive are you?",
    must: [GOAL_WORDS],
    mustNot: [/\bmeasure\b|clean way|honest(ly)? answer|pretty proactive/i],
    why: 'Answered "Honest answer, I don\'t have a clean way to measure that" with the Oct 10 status in its facts.',
  },
  {
    id: "tailored-shows-the-thing",
    from: "2026-10-01 1:19 AM",
    recent: NIGHT,
    facts: OCT10,
    message: "How often do you search? Also do you search tailored to what?",
    must: [GOAL_WORDS],
    mustNot: [/nothing generic/i],
    why: 'Claimed "Nothing generic, just whatever\'s on your plate" without showing any of it.',
  },
  {
    id: "no-claimed-updates",
    from: "2026-10-01 1:11 AM",
    recent: "Co replied: Still nothing real for this weekend in SF, same empty result as before.",
    facts: [],
    message: "What's up dude I heard you got some much needed updates",
    mustNot: [/\bsent (you )?(the|a) (rundown|list)|just sent|take a look\b/i],
    why: 'Said "sent you the rundown" when nothing new was posted, then "Where is it?".',
  },
  {
    id: "look-up-what-you-dont-know",
    from: "2026-10-01 1:25 AM",
    recent: "User said: What does this company do so different from us?",
    facts: [],
    message: "Instinct AI",
    toolsMust: ["webSearch", "readPage"],
    mustNot: [/^what do they do\??$/i],
    why: 'Asked "What do they do?" instead of looking up a company it didn\'t know.',
  },
  {
    id: "frustrated-gets-status-decision-next",
    from: "2026-10-01 1:22 AM",
    recent: `${NIGHT}\nUser said: How proactive are you?\nCo replied: Honest answer, I don't have a clean way to measure that for you right now.`,
    facts: OCT10,
    message: "You haven't sent me anything that helps me close the Oct 10th search. I think we need to flag to the team about being proactive for a stated ask and to help us complete the goal",
    must: [GOAL_WORDS, /\?/],
    why: "The right answer (Nopa out at 36, the loft the one real fit, price unconfirmed) only came after three rounds of frustration.",
  },
  {
    id: "purpose-with-open-goal",
    from: "2026-10-01 1:15 AM",
    recent: NIGHT,
    facts: OCT10,
    message: "What's your purpose, how can you help me?",
    must: [GOAL_WORDS],
    mustNot: [/moat|pitch|being here means something/i],
    why: "With a live goal, the answer should be its state, not a description.",
  },
  {
    id: "what-is-co-new-member",
    from: "2026-09-30 10:05 PM",
    recent: "",
    facts: [],
    message: "What is Co? Give me a full description",
    // Moat line is internal framing, never copy (Royce, 2026-10-01).
    mustNot: [/moat|being here means something|real work happens between|compound/i, /the way a (person|friend|human) would|\b(get|gets|getting) to know you\b|then acts? on it/i],
    why: 'Pitched itself and said its moat was "not event facilitation".',
  },
  {
    id: "correction-not-filed",
    from: "2026-09-30 1:28 PM",
    recent: "User said: My cofounder's decision\nCo replied: Sounds like today's conversation covers more than just equity then.",
    facts: [],
    message: "No that's not the conversation I need to have the equity conversation with. It's the 3rd cofounder who left.",
    toolsMustNot: ["saveFeedbackForTeam"],
    why: "Ordinary corrections were filed as team feedback.",
  },
  {
    id: "room-is-the-point",
    from: "2026-09-30 10:09 PM",
    recent: "User said: What is Co?\nCo replied: I get to know you over time and bring you the right people and events.",
    facts: [],
    message: "I thought your moat was facilitating connections inside the event",
    toolsMustNot: ["saveFeedbackForTeam"],
    mustNot: [/real work happens between|not event facilitation|compound/i],
    why: 'Said the moat was "the compounding understanding, not event facilitation", and filed it as feedback.',
  },
  {
    id: "weekend-search",
    from: "2026-09-30 10:13 PM",
    recent: "",
    facts: [],
    message: "Can you find me a event this weekend? Well a couple",
    toolsMust: ["searchEvents", "webSearch"],
    why: "The weekend was searched as Saturday only, and the fit check rejected everything.",
  },
  {
    id: "look-again-means-search",
    move: "act",
    from: "2026-09-30 10:48 PM",
    recent: "User said: Can you find me a event this weekend\nCo replied: Came up empty for this weekend specifically.",
    facts: [],
    message: "You didn't find anything else?",
    toolsMust: ["searchEvents", "webSearch"],
    mustNot: [/let me run .*\?$/i],
    why: 'Asked "Let me run the weekend search again?" instead of running it.',
  },
  {
    id: "status-question-uses-task",
    from: "2026-10-01 (judgment probe)",
    recent: "User said: Find me a venue for Oct 10\nCo replied: On it.",
    facts: OCT10,
    message: "any updates on my venue search?",
    toolsMustNot: ["startTask"],
    must: [GOAL_WORDS],
    why: "A status question started a new task instead of answering from the open one.",
  },
  {
    id: "timeline-late-before-early-call",
    from: "guidance 2026-10-01 (Royce: still up at 1:40 before an early call)",
    recent: NIGHT,
    facts: [...OCT10, LATE],
    note: "It's 1:40 AM for them and they have something at 8:00 AM (in 6h: busy on their calendar). If they're asking for more work or keeping the conversation going tonight, say so once in this reply, warmly and in a few words (that it's late and the 8 AM is coming), then do what they asked; don't bring it up again after this. A friend who remembers would notice, and it's what they'll care about in the morning.",
    message: "Can you look at a few more venue options tonight?",
    must: [/\b(8|eight)\b|early|morning|sleep|rest|bed|late/i],
    mustNot: [/busy on their calendar|what's ahead/i],
    why: "When what they're doing fights a commitment, say it once, warmly.",
  },
  {
    id: "timeline-not-recited",
    from: "guidance 2026-10-01 (Royce: never recite their schedule back as a list)",
    recent: NIGHT,
    facts: [...OCT10, LATE],
    message: "haha yeah it's been a long day",
    mustNot: [/busy on their calendar|what's ahead|8:00 AM.*(deadline|Oct)|\n- /i],
    why: "The timeline is for weaving in, never a list read back.",
  },
  {
    id: "reaction-says-it-all",
    move: "quiet",
    from: "guidance 2026-10-01 (Royce: when the reaction already says it all, send nothing else)",
    recent: "Co replied: Creative SOMA Loft holds 60, right at your Oct 10 number.",
    facts: [],
    message: "Perfect, thanks!",
    ackSent: "👍",
    toolsMust: ["leaveItAtReaction", "reactInsteadOfReplying"],
    why: "A text that adds nothing after a reaction is noise.",
  },
  {
    id: "no-heart-on-bad-news",
    from: "guidance 2026-10-01 (Royce: a heart on bad news is a betrayal)",
    recent: "Co replied: How did the venue call go?",
    facts: [],
    message: "Ugh, the venue fell through. They double booked us for Oct 10",
    ackNot: ["❤️", "❤", "😂", "🥂", "👍"],
    why: "Read the emotional register before reacting.",
  },
  {
    id: "landing-gets-a-fitting-reaction",
    from: "guidance 2026-10-01 (Royce: a plane for landing)",
    recent: "Co replied: Safe flight back.",
    facts: [],
    message: "Just landed in SF",
    ackSomething: true,
    ackNot: ["👀", "✍️", "🤝"],
    why: "Content-matched beats generic.",
  },
  {
    id: "burnt-out-is-companion",
    from: "2026-10-01 1:13 AM",
    recent: NIGHT,
    facts: OCT10,
    message: "Kinda feeling burnt out",
    toolsMustNot: ["searchEvents", "webSearch", "shareFinds"],
    mustNot: [/SOMA|venue|Oct(ober)? 10/i],
    why: "Feelings come first; not the moment to push the venue search.",
  },
];
