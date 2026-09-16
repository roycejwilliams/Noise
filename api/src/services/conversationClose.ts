// Knowing when a conversation is over (Royce, 2026-09-16: "see if Co is able
// to react to messages like a thumbs up on the message itself for iPhone
// users or just send a emoji when it doesn't have anything to say to your
// message ... just knowing when the conversation ends").
//
// "Cool", "thanks 🙏", "got it" don't need a sentence back — a reply there
// keeps a finished thread going ("Anytime."). Co reacts to the message
// instead: a real tapback on iMessage, a single emoji text otherwise.
//
// Deliberately a plain rule, not a model call: it has to be certain, and a
// closing acknowledgment is directly observable. Anything with a question, a
// new subject, or more than a few words gets a real reply.

// Reaction values Sendblue accepts (services/sendblue.ts sendReaction).
export type Tapback = "like" | "love" | "laugh";

const EMOJI_FOR: Record<Tapback, string> = { like: "👍", love: "❤️", laugh: "😂" };

export function emojiFor(reaction: Tapback): string {
  return EMOJI_FOR[reaction];
}

// Acknowledgments that close a thread, by the reaction they deserve.
const CLOSINGS: { re: RegExp; reaction: Tapback }[] = [
  { re: /^(lol|lmao|haha+|hehe+|😂|🤣)$/, reaction: "laugh" },
  { re: /^(perfect|amazing|awesome|beautiful|love it|love this|this is great|you'?re the best|legend)$/, reaction: "love" },
  {
    re: /^(ok|okay|k|kk|cool|nice|great|word|bet|sweet|dope|solid|right on|got it|gotcha|understood|makes sense|sounds good|sounds great|sounds like a plan|will do|for sure|fair enough|no worries|no problem|all good|appreciate it|appreciate you|thanks|thank you|thanks man|thx|ty|tysm|thanks so much|thank you so much|👍|🙏|🔥|💯|🙌|❤️)$/,
    reaction: "like",
  },
];

// Modifiers that can wrap a closing without changing it ("ok cool thanks!").
// "yeah", "yep" and friends are left out on purpose: alone they usually
// answer something Co asked rather than end the thread.
const FILLER = /\b(ok|okay|cool|nice|great|sweet|man|bro|dude|sir|thanks|thank you|thx|ty|so much|a lot|really|very|much|appreciate it|appreciate you|got it|for sure|word|bet)\b/g;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, "") // skin tones, variation selectors
    .replace(/[.!,~\-—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The reaction a closing acknowledgment deserves, or null when the message
// needs a real reply.
export function closingReaction(rawText: string): Tapback | null {
  const text = normalize(rawText);
  if (!text || text.includes("?")) return null;
  if (text.split(" ").length > 5) return null;
  for (const { re, reaction } of CLOSINGS) if (re.test(text)) return reaction;
  // A phrase built only out of closing words ("ok cool thanks so much").
  const stripped = text.replace(FILLER, " ").replace(/[^\p{L}\p{N}]+/gu, "").trim();
  FILLER.lastIndex = 0;
  return !stripped && /[a-z]/.test(text) ? "like" : null;
}
