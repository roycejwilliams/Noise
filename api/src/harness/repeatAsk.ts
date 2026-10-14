// Co never asks again what it already asked and they already answered
// (Royce, 2026-10-03). Two loops in one day: "Want me to dig into whether they'd
// fit as an accelerator/VC lead instead?" asked again as "...whether Pitch
// Protocol fits as an accelerator/VC lead?" after their "Es", and "Want to hear
// who?" sent again after a yes that delivered nothing. The second asks weren't
// word for word, so after a yes (typos like "Es" count) a question about the
// same thing is blocked even reworded; without a yes only a near-copy is. A
// reworded clarification after a non-answer isn't.
//
// Pure: takes the conversation as text and returns what repeats.

export type Turn = { from: "co" | "them"; text: string };

const COMMON = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "it", "this", "that", "you", "your", "i", "me", "my", "do", "does", "so", "just", "if", "at", "as", "be", "we", "us"]);

// They said yes (or its typos and its everyday forms).
const YES_WORDS = new Set(["yes", "yeah", "yea", "yep", "yup", "sure", "ok", "okay", "please", "definitely", "absolutely", "ya", "yess", "yees", "es", "ys", "ye"]);
export function saidYes(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/\[replying[^\]]*\]/g, "")
    .replace(/[^a-z' ]+/g, " ")
    .trim();
  if (!t) return false;
  const first = t.split(/\s+/)[0];
  return YES_WORDS.has(first) || /^(do it|go ahead|send it|sounds good|i wanna try|i want to try|let'?s do it|try it|that works)\b/.test(t);
}

// "Co replied: ..." / "User said: ..." (how the thread is stored) and
// "Co: ..." / "User: ..." (how it's often shown). A reply-to note on their
// text ("[Replying to Co's text: ...]") isn't part of what they said.
export function turnsFromConversation(conversation: string): Turn[] {
  const out: Turn[] = [];
  for (const raw of conversation.split("\n")) {
    const line = raw.trim();
    const co = line.match(/^(?:Co replied|Cue replied|Co|Cue):\s*(.*)$/i);
    const them = line.match(/^(?:User said|User|Them):\s*(.*)$/i);
    if (co) out.push({ from: "co", text: co[1] });
    else if (them) out.push({ from: "them", text: them[1].replace(/\s*\[Replying to[^\]]*\]\s*$/i, "") });
    else if (line && out.length) out[out.length - 1].text += ` ${line}`;
  }
  return out;
}

// The questions in a text, each as the sentence that ends in "?".
export function questionsIn(text: string): string[] {
  return (text.match(/[^.!?\n]*\?/g) ?? []).map((q) => q.trim()).filter((q) => q.length > 1);
}

function wordsOf(q: string): Set<string> {
  return new Set(
    q
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w && !COMMON.has(w))
      .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)),
  );
}

// The words of how an offer is phrased ("Want me to look into ..."), not what
// it's about. Two offers that share only these are different questions.
const FRAME = new Set(["want", "wanna", "like", "would", "should", "can", "could", "shall", "let", "look", "looking", "dig", "digging", "into", "check", "see", "find", "send", "share", "help", "whether", "about", "there", "any", "some", "now", "yet", "still", "also", "too", "more", "other", "ask", "tell", "know", "get", "try"]);

// near: the share of the shorter question's subject words that must be in the
// other, for a copy; afterYes: the same once they said yes (the same thing
// asked in other words). Short questions ("Want to hear who?") have no room to
// drop the template, so they're compared whole and must match fully.
export const SAME_QUESTION = { minSubject: 2, near: 0.85, afterYes: 0.6, shortWords: 4 };

export function sameQuestion(a: string, b: string, afterYes = false): boolean {
  const A = wordsOf(a);
  const B = wordsOf(b);
  const short = Math.min(A.size, B.size) <= SAME_QUESTION.shortWords;
  // A short question ("Want to hear who?", "How are you holding up?") only counts
  // as asked-again when they said yes to it: without a yes, asking it again is
  // an ordinary check-in, not the loop (review of #59).
  if (short && !afterYes) return false;
  const subj = (w: Set<string>) => (short ? w : new Set([...w].filter((x) => !FRAME.has(x))));
  const SA = subj(A);
  const SB = subj(B);
  let both = 0;
  for (const w of SA) if (SB.has(w)) both++;
  if (both < (short ? 3 : SAME_QUESTION.minSubject) || Math.min(SA.size, SB.size) === 0) return false;
  const need = short ? 1 : afterYes ? SAME_QUESTION.afterYes : SAME_QUESTION.near;
  return both / Math.min(SA.size, SB.size) >= need;
}

// Questions that may always be asked again: safety, consent, and call offers.
// Re-asking "are you safe right now?" after a deflection is care, not a loop.
export const ALWAYS_ASKABLE = /\b(safe|safety|hurt(?:ing)? (?:yourself|your ?self)|harm|suicid\w*|kill\w*|end (?:your|it all)|in danger|crisis|ok(?:ay)? if i|is it ok|is that ok|mind if|permission|consent|opt(?:ed)? out|stop (?:texting|messaging)|call|phone|ring you|hop on|jump on)\b/i;

export const LOOKBACK_TURNS = 14;

// A question in the draft that Co already asked in the last turns, after which
// they wrote back.
export function repeatedQuestion(draft: string, turns: Turn[]): { question: string; earlier: string } | null {
  const recent = turns.slice(-LOOKBACK_TURNS);
  for (const q of questionsIn(draft)) {
    if (ALWAYS_ASKABLE.test(q)) continue;
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].from !== "co") continue;
      const theirs = recent.slice(i + 1).filter((t) => t.from === "them" && t.text.trim().length > 0);
      if (!theirs.length) continue;
      const yes = theirs.some((t) => saidYes(t.text));
      const earlier = questionsIn(recent[i].text).find((e) => sameQuestion(q, e, yes));
      if (earlier) return { question: q, earlier };
    }
  }
  return null;
}

export function repeatQuestionCheck(draft: string, conversation: string): { name: "no_repeat_question"; pass: boolean; reason?: string } {
  const r = repeatedQuestion(draft, turnsFromConversation(conversation));
  return r ? { name: "no_repeat_question", pass: false, reason: `asks again what they already answered: "${r.question}"` } : { name: "no_repeat_question", pass: true };
}
