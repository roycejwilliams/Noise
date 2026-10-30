// What Cue may say about its own sends and saves on a call (Royce, 2026-10-29: Cue says it did something only after the tool
// returns). Pure: regexes over Cue's own speech, read by the call brain endpoint (services/callLlmProxy.ts say) sentence by sentence.
// Families, not example lists:
//   sent       a past or perfect send verb about the member ("Texted it.", "Sent it over.", "I put it in your texts.", "that's sent")
//   location   a delivery place said as true now ("Link's in your texts.", "it's on your phone")
//   arrival    an arrival said as true now ("You should have it now.", "Check your texts.", "It's on its way.", "You've got it."),
//              counted when the turn is about sending (a send was tried, or their words or Cue's are about texting a link)
//   now        a send said as happening ("texting it to you now"): true only while a send is in flight
//   saved      a save said as done ("I've saved it"): true only once a tool came back done
// A send claim stands only when a send that really texted them came back done this turn, and only for what went: a claim naming an
// item that didn't go, or "both" after one send, is held. Questions, negations, future or conditional words and earlier sends
// ("yesterday") are never claims.
const QUESTION = /\?\s*["')\]]*\s*$/;
const NEGATED = /\b(?:not|never|haven'?t|hasn'?t|didn'?t|wasn'?t|isn'?t|aren'?t|won'?t|couldn'?t|can'?t|no longer)\b|n't\b/i;
const FUTURE = /\b(?:will|'ll|shall|going to|gonna|about to|once|when|whenever|if|as soon as|after|afterwards|later|soon|shortly|in a (?:minute|sec|second|bit|moment|few)|in (?:a couple|a few|\d+) (?:minutes|mins|seconds)|tonight|tomorrow|next)\b/i;
const EARLIER = /\b(?:yesterday|earlier|last (?:night|week|time|month)|this morning|before|the other day|ago|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
// Someone else did the sending ("the deck you sent", "what they texted").
const OTHER_SUBJECT = /\b(?:you|they|he|she|we|someone|somebody|who|people|your \w+)\s+(?:just\s+|already\s+|had\s+|have\s+|has\s+)?(?:sent|texted|shot|popped|dropped|put|fired|messaged|forwarded|shared)\b/i;
const PLACE = String.raw`(?:texts?|text messages|messages|imessages?|inbox|phone|dms?|messages app)`;
const SENT_STRONG = /\b(?:sent|texted|messaged|forwarded|fired (?:it |that |them |those |this )?off|shot (?:it|that|them|those|this|both|you|the \w+|over|across)|pinged (?:it|that|them|you)|shared (?:it|that|them|those|this|the \w+) with you|hit send)\b/i;
const SENT_WEAK = new RegExp(String.raw`\b(?:put|popped|dropped|stuck|slid|shared|got|pushed)\b[^.!?]{0,30}\b(?:in|into|to|on|over to|onto)\s+your\s+${PLACE}\b|\b(?:put|popped|dropped|shared|got)\b\s+(?:it|that|them|those|this|both)\s+(?:over|across|through|your way|to you)\b`, "i");
const LOCATION = new RegExp(String.raw`\b(?:in|into|on|to)\s+your\s+${PLACE}\b|\byour\s+${PLACE}\s+(?:now|should)\b`, "i");
const ARRIVAL = /\byou should (?:have|see|get|be (?:seeing|getting)) (?:it|that|them|those|the \w+)\b|\b(?:check|look at|open) your (?:texts?|phone|messages|inbox)\b|\b(?:it'?s|that'?s|they'?re|this is|it is|that is|they are) (?:on (?:its|their|the) way(?=\s*(?:to you|over|now)?\s*[.!]?\s*$)|coming through|gone (?:out|over|through)|out to you|through|done|sent|over to you)(?![a-z])|\byou'?ve (?:got|received) (?:it|them|that|those|the \w+)\b|\byou(?:'ve| have) (?:it|them) now\b|\b(?:there you go|there it is|all set)\b|\b(?:it|that|they|the (?:link|text|message))\s+(?:went|has gone|have gone|got) through\b|\b(?:should(?:'ve| have)?|ought to)\s+(?:be\s+)?(?:there|landed|arrived|come through|gotten there)\b|\b(?:it|that|they)'?s? (?:is |are )?(?:there|landed|arrived) now\b|\b(?:your |the )?(?:link|text|message)(?:'s| is) (?:there|out|in|through)\b/i;
// Said as already there, with a "will" that's really a "now" ("You'll see it in your texts now"): a claim whatever the tense.
const THERE_NOW = /\byou'?ll (?:see|find|have) (?:it|that|them|the \w+)\b[^.!?]*\bnow\b/i;
// Said as happening: "I'm texting it to you now", "sending it over", "I'll text it right now".
const NOW = /\b(?:sending|texting|shooting|dropping|firing|popping|messaging|forwarding|pushing)\b(?:[^.!?]{0,30}\b(?:now|right now|as we speak|over|across|through|your way)\b|\s+(?:it|that|them|this|those)\s+(?:to you|your way)\b)|\bi'?ll (?:send|text|shoot|drop|fire|pop)\b[^.!?]{0,30}\b(?:now|right now|right away|this second)\b/i;
const SAVED = /\b(?:i(?:'ve| have)? (?:just |already )?(?:saved|set (?:it|that|this) up|added (?:it|that|this)|started (?:a task|on (?:it|that|this))|noted (?:it|that|this) down)\b|(?:it'?s|that'?s) (?:saved|set up|noted)\b)/i;
// More than one thing, said as sent.
const PLURAL = /\b(?:both|all (?:of them|three|two|of those|the links)|each (?:of them|one)|the links|both links|everything|them all|all of it)\b/i;
const PRONOUN_PLURAL = /\b(?:them|those|these|they)\b/i;
// Their words or Cue's this turn are about texting a link.
export const SEND_TALK = /\b(?:text|texts|texting|texted|send|sending|sent|link|links|shoot|message)\b/i;

export type ClaimState = {
  // Items a send that really texted them delivered this turn (names and links), and how many.
  delivered: string[];
  deliveredCount: number;
  // Items a send this turn tried and that didn't go (failed, or not back in time).
  undelivered: string[];
  // A send is in flight: the model called a send tool in this response and it hasn't come back.
  inFlight: boolean;
  // Any of Cue's tools came back done this turn.
  acted: boolean;
  // The turn is about sending: a send was tried, or the words are about texting a link.
  sendContext: boolean;
};
export const emptyClaimState = (): ClaimState => ({ delivered: [], deliveredCount: 0, undelivered: [], inFlight: false, acted: false, sendContext: false });

export type ClaimKind = "sent" | "location" | "arrival" | "now" | "saved";

// Pure: which family a sentence claims, if any. Read clause by clause ("Sent it, let me know if it doesn't come through" still claims
// the send): a clause that's a question, negated, in the future or conditional, or about an earlier send isn't a claim, and someone
// else's sending isn't Cue's.
const CLAUSES = /\s*(?:[,;:.!]|\s[-–—]\s|\b(?:and|but|so|because)\b)\s*/i;
export function claimKind(sentence: string, sendContext: boolean): ClaimKind | null {
  const s = sentence.replace(/[’‘]/g, "'");
  if (QUESTION.test(s)) return null;
  if (EARLIER.test(s)) return null;
  for (const c of s.split(CLAUSES).map((x) => x.trim()).filter(Boolean)) {
    if (NEGATED.test(c)) continue;
    if (NOW.test(c) && !FUTURE.test(c.replace(/\bi'?ll\b/i, ""))) return "now";
    if (THERE_NOW.test(c)) return "location";
    if (FUTURE.test(c)) continue;
    if (!OTHER_SUBJECT.test(c) && (SENT_STRONG.test(c) || SENT_WEAK.test(c))) return "sent";
    if (LOCATION.test(c)) return "location";
    if (sendContext && ARRIVAL.test(c)) return "arrival";
    if (SAVED.test(c)) return "saved";
  }
  return null;
}

const words = (x: string) => (x.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((w) => !["the", "and", "for", "with", "link", "links", "your", "you", "this", "that", "event", "night"].includes(w));
// An item's distinctive words (and a claim's): never the words every claim or item shares.
const COMMON = new Set(["the", "and", "for", "with", "link", "links", "your", "you", "this", "that", "event", "night", "one", "ones", "just", "sent", "texted", "text", "texts", "send", "over", "into", "it's", "its", "there", "now", "too", "also", "both", "them", "those", "the", "okay", "alright", "messages", "message", "phone", "inbox", "shot", "popped", "dropped", "put", "got", "thing", "things", "stuff", "place", "spot", "texted", "saved", "added", "started", "noted", "i've", "i'll", "already", "https", "lu.ma", "com", "www"]);
export const itemWords = (x: string): string[] => [...new Set((x.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).map((w) => w.replace(/'s$/, "")).filter((w) => w.length > 2 && !COMMON.has(w)))];

// Pure: the sentence names this item (its link, or most of its own words).
export function namesItem(sentence: string, item: string): boolean {
  const s = sentence.toLowerCase();
  if (/^https?:\/\//.test(item)) return s.includes(item.toLowerCase());
  const w = [...new Set(words(item))];
  if (!w.length) return false;
  const hit = w.filter((x) => new RegExp(`\\b${x.replace(/[^a-z0-9'-]/g, "")}\\b`).test(s)).length;
  return w.length === 1 ? hit === 1 : hit / w.length >= 0.6;
}

// Pure: why a sentence can't be said now, or null when it can.
export function claimHeld(sentence: string, st: ClaimState): string | null {
  const k = claimKind(sentence, st.sendContext);
  if (!k) return null;
  if (k === "saved") return st.acted || st.deliveredCount > 0 ? null : "says it saved something before a tool came back done";
  if (k === "now") return st.inFlight ? null : "says a send is happening when none is in flight";
  if (!st.deliveredCount) return "says it sent something before a send came back done";
  // Any distinctive word of an item that didn't go, shared by no item that did ("the gallery one" when only jazz went), holds it.
  const deliveredWords = new Set(st.delivered.filter((d) => !/^https?:\/\//.test(d)).flatMap(itemWords));
  const missedWords = new Set(st.undelivered.filter((u) => !/^https?:\/\//.test(u)).flatMap(itemWords).filter((w) => !deliveredWords.has(w)));
  const said = new Set(itemWords(sentence));
  if ([...missedWords].some((w) => said.has(w)) || st.undelivered.some((u) => /^https?:\/\//.test(u) && sentence.includes(u))) return "says an item went that didn't";
  if (PLURAL.test(sentence) && st.deliveredCount < 2) return "says more went than did";
  if (PRONOUN_PLURAL.test(sentence) && st.deliveredCount < 2 && st.undelivered.length) return "says more went than did";
  return null;
}
