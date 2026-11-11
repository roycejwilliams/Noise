// The second-text checks (#444), pure and free of the tool layer's imports, so the golden hard rules (evals/lib/hardRules.ts) judge a
// second reply exactly as the send path does. Re-exported from agent/conversationTools.ts, where the send path uses them.
const STOP = new Set(["the", "and", "that", "this", "with", "for", "you", "your", "its", "it's", "are", "was", "but", "not", "just", "they", "them", "then", "there", "what", "when", "have", "has", "had", "from", "into", "about", "like", "really", "very", "also", "can", "will", "would", "could", "should"]);
// Numbers are kept whatever their length ("7:30" vs "8:30": the "30" and the "7" or "8" both count; review of #444).
// Digits split from letters, so "7:30pm" and "7:30 pm" read the same (re-review of #444).
const tokens = (t: string) => t.toLowerCase().replace(/[\u2019']/g, "").replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").match(/[a-z0-9]+/g) ?? [];
const contentWords = (t: string) => tokens(t).filter((w) => /\d/.test(w) || (w.length > 2 && !STOP.has(w)));
const numbersIn = (t: string) => new Set(tokens(t).filter((w) => /\d/.test(w)));
// Pure: a send that repeats what already went (or is going) this turn: the same words in a row (whole words, never inside another word:
// "Yes." isn't in "yesterday"), or nearly all of its words already said (85%). A text whose numbers differ from what went is never a
// repeat: that's a correction ("starts at 7:30" -> "starts at 8:30"). An actual duplicate is always held; a second take is held by the
// one-reply rule above.
// Pure: what a text adds after the reply went: its sentences already said word for word are taken out (re-review of #444: set aside but
// still sent, "The plan is dinner at Nopa Tuesday with Maya. Exactly." repeated the plan). dropped: some were.
// Abbreviations a period doesn't end a sentence after (re-review of #444: "Dr. Smith" was split and the halves matched another text).
const ABBREV = /(?:^|\s)(?:dr|st|mr|mrs|ms|vs|jr|sr|prof|etc|e\.g|i\.e|approx|no)\.$/i;
// Pure: a text as sentences, each with the separator that followed it (spaces, a newline, a paragraph break), so it can be rebuilt as
// written. A sentence ends at . ! or ? followed by whitespace, or at a line break; never after an abbreviation, a list number at the
// start of a line ("1.", "2)"), or inside a decimal or a link (no whitespace there).
export function sentencesOf(text: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = [];
  const re = /([.!?]+)([ \t]+)|(\r?\n+[ \t]*)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + (m[1] ? m[1].length : 0);
    const piece = text.slice(start, end);
    if (m[1]) {
      const lineStart = piece.slice(piece.lastIndexOf("\n") + 1);
      if (ABBREV.test(piece) || /^\s*\d{1,2}[.)]$/.test(lineStart)) continue;
    }
    out.push({ text: piece, sep: m[0].slice(m[1] ? m[1].length : 0) });
    start = m.index + m[0].length;
  }
  if (start < text.length || !out.length) out.push({ text: text.slice(start), sep: "" });
  return out;
}
const normSentence = (t: string) => tokens(t.replace(/^\s*(?:\d{1,2}[.)]|[-*\u2022])\s+/, "")).join(" ");
// Pure: what a text adds after the reply went (re-review of #444). A sentence is taken out only when it is a WHOLE earlier sentence
// (case and punctuation aside) of three or more words of substance; the rest is rebuilt with its own separators (line and paragraph
// breaks kept). dropped: something of substance was taken out.
export function freshPart(message: string, said: readonly string[]): { text: string; dropped: boolean } {
  const before = new Set(said.flatMap((t) => sentencesOf(t)).filter((x) => contentWords(x.text).length >= 3).map((x) => normSentence(x.text)));
  const parts = sentencesOf(message);
  let dropped = false;
  let out = "";
  for (const x of parts) {
    if (contentWords(x.text).length >= 3 && before.has(normSentence(x.text))) {
      dropped = true;
      continue;
    }
    out += x.text + x.sep;
  }
  return { text: dropped ? out.trim() : message, dropped };
}
// Fewer than three words of substance (numbers count): nothing worth a text of its own.
export const trivialText = (t: string): boolean => contentWords(t).length < 3;
export function repeatsSent(message: string, said: readonly string[]): boolean {
  if (!tokens(message).length) return true;
  const theirs = tokens(said.join(" "));
  const whole = ` ${theirs.join(" ")} `;
  const fresh = freshPart(message, said).text;
  const mine = tokens(fresh);
  if (!mine.length) return true;
  const had = new Set(theirs.filter((w) => /\d/.test(w)));
  if ([...numbersIn(fresh)].some((n) => !had.has(n))) return false;
  if (whole.includes(` ${mine.join(" ")} `)) return true;
  const words = contentWords(fresh);
  // Only little words ("ok", "yes"): a repeat only when each is already there as a whole word.
  if (!words.length) { const all = new Set(theirs); return mine.every((w) => all.has(w)); }
  const have = new Set(contentWords(said.join(" ")));
  return words.filter((w) => have.has(w)).length / words.length >= 0.85;
}
// Pure: their message asks for something (a question or a request), so the answer may run to a second text. A share or a reaction
// never does.
// Re-review of #444: requests only ("I need a nap", "so many thoughts", "I find these boring", "whichever works" ask nothing).
const ASKS = /\?|\b(?:tell me|explain|walk me|describe|show me|give me|send me|help me|find me|can you find|recommend|suggest|i need (?:help|someone|somebody|a recommendation|recommendations|ideas|advice|to find|you to)|any thoughts|your thoughts|ideas|how (?:do|does|did|should|would|can|could|to)|what (?:should|would|do|does|is|are|can)|why|which (?:one|is|should|would|do)|can you|could you|would you|should i|any (?:good |ideas|tips|advice))\b/i;
// Rhetorical openers and tags that ask nothing ("guess what? I got the job!", "you know what?", "right?"), and what they quoted or replied
// to (an inline reply's note, a ">" quoted line: Cue's words, not their ask).
const RHETORICAL = /\b(?:guess what|you know what|can you believe (?:it|that)|right|huh|isn'?t it|ya know|you know)\s*\?/gi;
const QUOTED = /\[(?:Replying to [^\]]*|They also sent[^\]]*|also sent[^\]]*|sent [^\]]*)\]|^\s*>.*$/gim;
// Pure: does their own message ask for something?
export const askedForSomething = (message: string | null | undefined): boolean => ASKS.test(String(message ?? "").replace(QUOTED, " ").replace(RHETORICAL, " "));
// An offer to do something for them, in its usual wordings. A second text that only offers again, after a text this turn that already
// offered, is a repeat whatever its words (2026-11-11, golden std-old-rec-not-new: "Want me to start on it?" went, then "If you want, I can
// start looking, whether that's events worth going to or something toward the founding engineer search." as a second text).
const OFFER = /\b(?:want me to|would you like me to|should i|shall i|i (?:can|could) (?:start|look|keep|dig|find|send|check|search|set|turn|pull|line|put)|happy to|say the word|let me know if you(?:'d)? (?:like|want))\b/i;
export const offers = (t: string): boolean => OFFER.test(t.replace(/[’]/g, "'"));
// Pure: every sentence of this text offers, and a text that went this turn already offered.
export function reOffers(message: string, said: readonly string[]): boolean {
  const parts = sentencesOf(message).map((x) => x.text.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(offers) && said.some(offers);
}
