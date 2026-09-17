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

// Co's most recent message in the thread, so a short reply can be read
// against the question it's answering. In the full prompt that question sits
// far above "They just said" and was getting lost (confirmed live,
// 2026-09-10: "Before the event and at check-in", an answer to Co's own
// question, got "Go ahead."). Moved here from agent/conversationReply.ts
// 2026-09-17 so the closing rule can use it too.
export function lastCoLine(recentConversation: string): string | null {
  const lines = recentConversation.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("Co replied: ")) continue;
    const parts = [lines[i].slice("Co replied: ".length)];
    for (let j = i + 1; j < lines.length && !/^(User said|User sent|Co replied|\[)/.test(lines[j]); j++) parts.push(lines[j]);
    const text = parts.join(" ").trim();
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  return null;
}

// Whether Co's last message asked them something or offered to do something
// (2026-09-17 code review: Co asked "Want me to keep an eye out?", they said
// "sounds good", and got a thumbs up with nothing saved). Co's own questions
// aren't open items, so the router doesn't see them; a short "ok" after one
// is an answer, not the end of the thread.
const OFFER =
  /\b(want me to|should i|shall i|would you like|do you want|if you want,? i can|if you'?d like,? i can|happy to [^.!]{0,60} if you|let me know if you'?d like|i can [^.!]{0,60} if you want|if you'?d? (ever )?want(ed)? to|i'?m here if you)\b/i;

export function coAskedQuestion(lastCoMessage: string | null | undefined): boolean {
  if (!lastCoMessage) return false;
  const text = lastCoMessage.replace(/https?:\/\/\S+/gi, " ");
  return text.includes("?") || OFFER.test(text);
}

// The reaction a closing acknowledgment deserves, or null when the message
// needs a real reply. lastCoMessage is Co's last message in the thread: when
// it asked something, their short reply answers it and gets a real reply.
export function closingReaction(rawText: string, lastCoMessage?: string | null): Tapback | null {
  if (coAskedQuestion(lastCoMessage)) return null;
  const text = normalize(rawText);
  if (!text || text.includes("?")) return null;
  if (text.split(" ").length > 5) return null;
  for (const { re, reaction } of CLOSINGS) if (re.test(text)) return reaction;
  // A phrase built only out of closing words ("ok cool thanks so much").
  const stripped = text.replace(FILLER, " ").replace(/[^\p{L}\p{N}]+/gu, "").trim();
  FILLER.lastIndex = 0;
  return !stripped && /[a-z]/.test(text) ? "like" : null;
}

// A real request for Co's own contact details, not for something else Co
// should send (2026-09-16: "You send it over", meaning a link, produced the
// contact card).
export function asksForContactCard(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(your|you'?re|co'?s|ur)\b/.test(t) && !/\bcontact card\b/.test(t)) return false;
  return /\bcontact card\b|\bvcard\b|\bcontact info\b|\bcontact details\b|\byour (number|contact|info|details|card)\b|\bsave (you|your number|your contact|co)\b|\badd you to my contacts\b/.test(t);
}

// A real, live incident (2026-09-17): Jacqueline asked for the contact
// card, it (apparently) didn't arrive, and "I dont see it" — a plain
// non-receipt report, not a fresh ask — failed asksForContactCard's own
// current-message-only check. The tool correctly declined to resend, but
// the reply agent then claimed "trying again" anyway, a false claim that
// slipped past grounding too (see replyGrounding.ts's CLAIM_SHAPED fix).
// The actual fix is upstream of both: recognize this shape of follow-up so
// a genuine resend happens for real, instead of either silently doing
// nothing or lying about doing something.
export function reportsCardNotReceived(text: string): boolean {
  const t = text.toLowerCase().trim();
  return /\b(i )?(don'?t|do not|didn'?t|did not|never|still (don'?t|didn'?t)) (see|get|got|receive[d]?|have)\b.*\b(it|that|card|contact)\b|\b(it|that|card)\b.*\b(didn'?t|did not|never|hasn'?t|has n[o']?t) (come|arrive|show(ed)? up|land(ed)?)\b|\bnothing (came|showed up|landed)\b|\bnot (there|showing|coming through)\b/.test(t);
}
