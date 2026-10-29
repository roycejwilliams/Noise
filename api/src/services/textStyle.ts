// Capitalization enforced in code, not left to the prompt (2026-09-15).
// Replies were going out lowercase ("hey! good to hear from you. so, ...")
// because the model copied Co's own earlier lowercase texts in the thread.
// Since 2026-09-16 Co always writes in sentence case, whatever the person's
// own style: services/sendblue.ts cleanCoMessage applies this to every
// message on its way out. textsInLowercase is kept only for reading style
// hints, never for casing.

// Uppercases the first letter of the message and of each sentence. Leaves
// links, handles, and words with their own internal capitals ("iPhone")
// alone.
export function capitalizeSentences(text: string): string {
  // "i", "i'm", "i'll", "i've", "i'd" anywhere (2026-09-16: "so i can get
  // started"), then the first word of each sentence.
  text = text.replace(/(^|[^\p{L}\p{N}_'’])i(?=$|[\s,.!?;:)]|['’](m|ll|ve|d|s)\b)/gu, "$1I");
  return text.replace(/(^|[.!?]\s+|\n\s*)([a-z][^\s.!?]*)/g, (whole, lead: string, word: string, offset: number, str: string) => {
    const token = str.slice(offset + lead.length).split(/\s/)[0];
    if (/^(https?:|www\.|@)/i.test(token) || /[A-Z]/.test(word.slice(1))) return whole;
    return lead + word[0].toUpperCase() + word.slice(1);
  });
}

// True when the person's own recent texts are mostly all-lowercase,
// including their latest one (a switch to capitals wins right away). One
// text isn't enough to call it a style.
export function textsInLowercase(userLines: string[]): boolean {
  const lines = userLines.map((l) => l.trim()).filter((l) => /[a-z]/i.test(l)).slice(-4);
  if (lines.length < 2) return false;
  const isLower = (l: string) => l === l.toLowerCase();
  if (!isLower(lines[lines.length - 1])) return false;
  return lines.filter(isLower).length / lines.length >= 0.6;
}

// A drafted line that answers the drafting instruction instead of the person
// (2026-09-16, onboarding: "I'm ready to be Co. Send me what you'd like me to
// say, and I'll write a single message."). Short generated lines are checked
// against this and fall back to fixed copy.
// Only talk ABOUT the reply, never a reply that delivers something (2026-10-12 audit: "Here's a version that doesn't lean on
// Sequin AI" was refused at the send wrapper, and payload-first drafts and revisions go out exactly that way). "Here's the
// draft", "here's a version", "I'll draft the message to Alex" are deliveries and offers; what's blocked is the instruction
// leaking (being Co, asking what to say, a single message) or a reply addressed to "the user" instead of to them.
export function looksLikeMetaReply(text: string): boolean {
  return /\b(i'?m ready to be (?:co|cue)(?![-\w])|ready to be (?:co|cue)(?![-\w])|(to|i) be (?:co|cue)(?![-\w])|as (?:co|cue)(?![-\w])(?! (knows|sees|said))|send me what you'?d like|what you'?d like me to (say|write)|i'?ll (write|draft|compose) (a|one) single (message|text|reply)|(write|draft) (a|the|one) single (message|text))|\b(?:here(?:'|’)?s|here is) (a|the|my) (draft(ed)? |revised |new )?(reply|response|message|text) (to|for) (the user|the member|this (person|user|member))\b|^\s*(?:here(?:'|’)?s|here is) (my|a|the) (draft(ed)? )?(reply|response)\s*:/i.test(text);
}

// Readable on a phone (Royce, 2026-09-22: "fix the text format so it's
// digestible to a user who reads in paragraphs rather than large blocks").
// The reply prompt asks for short paragraphs; this is the safety net for a
// long reply that still came back as one block. Only touches text with no
// line breaks at all and over PARAGRAPHIZE_MIN chars: it starts a new
// paragraph before a labeled part ("Arrival:") and otherwise every two
// sentences. Links and anything already broken into lines are left alone.
export const PARAGRAPHIZE_MIN = 320;
export function paragraphize(text: string): string {
  if (text.length <= PARAGRAPHIZE_MIN || /\n/.test(text)) return text;
  const sentences = text.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/);
  if (sentences.length < 3) return text;
  const isLabel = (s: string) => /^[A-Z][A-Za-z ]{1,24}:\s/.test(s);
  const paras: string[][] = [];
  for (const s of sentences) {
    const cur = paras[paras.length - 1];
    if (!cur || isLabel(s) || (cur.length >= 2 && !isLabel(cur[0])) || (isLabel(cur[0]) && cur.length >= 3)) paras.push([s]);
    else cur.push(s);
  }
  return paras.map((p) => p.join(" ")).join("\n\n");
}

// A question Co already asked in one of its last two texts isn't asked again
// (2026-09-23: "Want to start with the venue types to call, or the questions
// to ask..." went out four times in a row while the member was trying to get
// calls working). Drops the repeated question sentence; keeps the text as is
// if that would leave almost nothing.
export function dropRepeatedQuestion(draft: string, recentConversation: string): string {
  // A text's later paragraphs belong to the same Co message (code review,
  // 2026-09-24: reading only the first line missed questions in the last
  // paragraph, which is where Co usually asks them).
  const coMessages: string[] = [];
  let inCo = false;
  for (const l of recentConversation.split("\n")) {
    if (/^\s*(?:co|cue) replied:/i.test(l)) {
      const text = l.replace(/^\s*(?:co|cue) replied:\s*/i, "");
      // Co's reply is several texts, one line each: with no member line between them they are one message,
      // so "the last two messages" is two turns, not two beats.
      if (inCo && coMessages.length) coMessages[coMessages.length - 1] += `\n${text}`;
      else coMessages.push(text);
      inCo = true;
    } else if (/^\s*(user (said|sent)\b|(?:co|cue) (replied|called)\b|user:|assistant:|\[)/i.test(l)) inCo = false;
    else if (inCo) coMessages[coMessages.length - 1] += `\n${l}`;
  }
  const coLines = coMessages.slice(-2);
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !REPEAT_STOPWORDS.has(w)));
  const asked = coLines.flatMap((l) => l.match(/[^.!?\n]+\?/g) ?? []).map(words).filter((w) => w.size >= 3);
  if (!asked.length) return draft;
  const repeats = (q: string) => {
    const w = words(q);
    if (w.size < 3) return false;
    return asked.some((a) => {
      let shared = 0;
      for (const x of w) if (a.has(x)) shared++;
      // Share of THIS question already asked: a new question that only
      // contains an earlier short one ("How's the permit going, and did the
      // venue get back about Saturday?") isn't a repeat.
      // 0.8, not 0.6 (prompt sweep 2026-10-29): at 0.6 a building follow-up on the same subject was cut (a next question about the
      // launch-party venue search right after they answered how it was going); the 09-23 repeat still clears 0.8 (evals/calls/sep23Bugs.ts).
      return shared / w.size >= 0.8;
    });
  };
  const kept = draft.replace(/[^.!?\n]*\?/g, (q) => (repeats(q) ? "" : q)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return kept.split(/\s+/).filter(Boolean).length >= 3 ? kept : draft;
}
const REPEAT_STOPWORDS = new Set(["want", "with", "that", "this", "what", "your", "have", "just", "like", "would", "could", "should", "when", "there", "about", "from", "they", "them", "then", "into", "some", "more"]);
