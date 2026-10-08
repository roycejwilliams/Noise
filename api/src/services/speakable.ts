// Making Co's words speakable (Royce, 2026-10-06: "It sounds like it's reading a run on sentence"; "we want a certain cadence and
// rhythm to her voice"). Haiku joins thoughts with dashes however the prompt asks it not to, and a voice reading a dash-joined
// 30-word sentence has nowhere to breathe. So the call brain's text goes through here on its way to the voice, in code:
//   - an unspaced or spaced dash becomes a full stop and a capital ("That's smart—keeping it warm" -> "That's smart. Keeping it warm.")
//   - a semicolon, a parenthesis, a line break becomes a plain stop
//   - a sentence past 24 words closes where two whole clauses join (", and" / ", but"), else at a real mid-sentence comma; never after
//     a short lead-in ("From where I sit,"), never after a "when ..." clause, never inside "you and Jacqueline" (2026-10-08: the 15-word
//     cut made "From where I sit. The most useful role..." and "When we hang up. I'll set up...", a dropped, finished tone mid-thought)
//   - a reply past the word cap is truncated at a sentence boundary, keeping its closing question
// It works on a stream: text goes in as it arrives, and each COMPLETE sentence comes out the moment it is complete, so the first
// sentence reaches the voice at the model's own speed and the voice never gets half a sentence. Pure; no I/O.

export const MAX_SENTENCE_WORDS = 24;
export const MAX_REPLY_WORDS = 90;
// A question that closes a reply is kept past the cap, if it is short enough not to be the reply running on.
const CLOSING_QUESTION_EXTRA_WORDS = 25;

const BREAK = "\u0001";
const TAG_ONLY = /^\[[a-z][a-z ]*\][.,!?]*$/i;
// Titles and "e.g."-style forms only: "7pm." or "3 p.m." before a capital is a sentence end.
const ABBREV = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "e.g", "i.e", "inc", "jr", "sr", "approx"]);
// Where a long sentence may close: before one of these (not "because", "which", "while": those would start a fragment).
const CONJ = new Set(["and", "but", "so", "or", "then"]);
const PREP = new Set(["with", "for", "to", "about", "from", "into", "on", "at", "in", "around", "through", "over"]);

const countWords = (ws: string[]) => ws.filter((w) => !TAG_ONLY.test(w)).length;
export const wordCount = (s: string) => countWords(s.split(/\s+/).filter(Boolean));

// Capitalize the first letter of a sentence that WE started (after a break or a split), never a word like "iPhone".
function capitalize(s: string): string {
  const m = s.match(/^((?:\[[a-z][a-z ]*\]\s*|["'(\[]+)*)([A-Za-z][A-Za-z']*)/);
  if (!m) return s;
  const word = m[2];
  if (word !== word.toLowerCase()) return s;
  return m[1] + word[0].toUpperCase() + word.slice(1) + s.slice(m[0].length);
}

// Close a piece as a sentence: no trailing comma, colon or dash; a stop if it has none.
function closeSentence(s: string): string {
  let t = s.trim().replace(/[\s,:;\-–—]+$/g, "").trim();
  if (!t) return "";
  if (!/[.!?]["')\]]*$/.test(t)) t += ".";
  return t;
}

// One sentence, made short enough: closes at the nearest comma or conjunction that leaves 3+ words each side, preferring the
// latest break that keeps the first part within the limit.
// Where a long run of words should close, so the first part is never past the limit. Natural breaks first: the latest comma (a real
// pause) that does not cut off an introductory "when ..." clause, else the latest conjunction. With none, a sentence only a little
// over the limit is left whole (a clean 17 words beats a broken 15); a longer one closes before a preposition, else at the limit.
type Break = { k: number; kind: "comma" | "conj" | "prep" | "hard" };
const bare = (w: string | undefined) => (w ?? "").toLowerCase().replace(/[^a-z]/g, "");
const INTRO = new Set(["when", "if", "once", "while", "because", "although", "though", "unless", "whenever"]);
// The clause before a comma opens with one of these ("so when you go in, ..."): its main clause is still to come, so do not cut there.
function opensSubordinate(left: string[]): boolean {
  let start = left.length - 1;
  while (start > 0 && !/,$/.test(left[start - 1])) start--;
  const seg = left.slice(start).map(bare);
  // "Before I close," is a short lead-in that stands alone; "Before I dig into what alignment might look like with them," does not.
  const lead = (w: string | undefined) => INTRO.has(w ?? "") || (["before", "after"].includes(w ?? "") && seg.length > 4);
  return lead(seg[0]) || (["so", "and", "but", "then"].includes(seg[0]) && lead(seg[1]));
}
const DANGLING = new Set(["a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "that", "which", "who", "based", "such", "like", "about", "how", "and", "or", "but", "so", "is", "are", "was", "were", "be", "it's", "that's"]);
const SLACK_WORDS = 6;
// A comma this close to the start ends a lead-in ("From where I sit,", "In a room,"): breaking there leaves a fragment.
const MIN_LEAD_WORDS = 6;
function chooseBreak(ws: string[], max: number): Break | null {
  let comma: Break | null = null;
  let conj: Break | null = null;
  let weak: Break | null = null; // a comma after an introductory clause: only when the sentence is too long to leave whole
  for (let k = 1; k < ws.length; k++) {
    const left = countWords(ws.slice(0, k));
    if (left > max) break;
    if (left < 3 || countWords(ws.slice(k)) < 3) continue;
    // ", and" / ", but": two whole clauses, the cleanest place to breathe. A bare "and" (no comma) is often inside a phrase
    // ("you and Jacqueline"), so it is never a break on its own.
    if (/,$/.test(ws[k - 1]) && CONJ.has(bare(ws[k])) && !opensSubordinate(ws.slice(0, k))) conj = { k, kind: "conj" };
    else if (/,$/.test(ws[k - 1])) { if (opensSubordinate(ws.slice(0, k)) || left < MIN_LEAD_WORDS) weak = { k, kind: "comma" }; else comma = { k, kind: "comma" }; }
  }
  const natural = conj ?? comma;
  if (natural) return natural;
  if (countWords(ws) <= max + SLACK_WORDS) return null;
  if (weak) return weak;
  const limit = Math.min(max, ws.length - 3);
  for (let k = limit; k >= 4; k--) if (PREP.has(bare(ws[k])) && !PREP.has(bare(ws[k + 1])) && !CONJ.has(bare(ws[k + 1])) && !DANGLING.has(bare(ws[k - 1]))) return { k, kind: "prep" };
  return { k: Math.max(3, limit), kind: "hard" };
}

// "X, and Y" closes as "X." then "Y"; "X and Y" with no comma too: the pause is the join. (A question's first half stays a question.)
const QSTART = new Set(["have", "has", "do", "does", "did", "are", "is", "was", "were", "will", "would", "can", "could", "should", "what", "who", "where", "when", "why", "how", "which"]);
function afterBreak(rest: string[], br: Break): string[] {
  return (br.kind === "comma" || br.kind === "conj") && rest.length > 3 && rest[0].toLowerCase() === "and" ? rest.slice(1) : rest;
}
function closeLeft(left: string[], asks: boolean): string {
  const closed = closeSentence(left.join(" "));
  return asks ? closed.replace(/\.$/, "?") : closed;
}

export function splitLong(sentence: string, max = MAX_SENTENCE_WORDS): string[] {
  const ws = sentence.trim().split(/\s+/).filter(Boolean);
  if (countWords(ws) <= max) return [sentence.trim()];
  const br = chooseBreak(ws, max);
  if (!br) return [sentence.trim()];
  const asks = /\?["')\]]*$/.test(sentence.trim());
  // Either/or: "Are you doing it on their phones or is someone talking to them?" keeps both halves questions.
  const opens = QSTART.has(bare(ws.find((w) => !TAG_ONLY.test(w))));
  // "Are you ... or does ...?": the first half is a question whether or not the end has arrived. Otherwise it follows the sentence's own end.
  const nextOr = bare(ws[br.k]) === "or";
  const left = closeLeft(ws.slice(0, br.k), (opens && (asks || nextOr)) || (asks && nextOr));
  return [left, ...splitLong(capitalize(afterBreak(ws.slice(br.k), br).join(" ")), max)];
}

// A pending text is normalized in place: dashes, semicolons, parentheses and line breaks become sentence breaks.
function normalize(s: string): string {
  return s
    .replace(/[*_#`]+/g, "")
    .replace(/\s*(?:—|–|--+)\s*/g, BREAK)
    .replace(/\s+-\s+/g, BREAK)
    .replace(/\s*;\s*/g, BREAK)
    .replace(/\s*[()]\s*/g, BREAK)
    .replace(/\s*\n+\s*(?:[-•]\s+)?/g, BREAK);
}

// The end of the first complete sentence in text, as {end: index after it, brk: it ended on a break we made}, or null.
function firstBoundary(text: string): { end: number; brk: boolean } | null {
  const b = text.indexOf(BREAK);
  const re = /[.!?]+["')\]]*(?=\s)/g;
  let m: RegExpExecArray | null;
  let stop: number | null = null;
  while ((m = re.exec(text))) {
    if (b >= 0 && m.index > b) break;
    const before = text.slice(0, m.index).match(/([A-Za-z.]+)$/)?.[1]?.toLowerCase().replace(/\.$/, "") ?? "";
    if (m[0][0] === "." && ABBREV.has(before)) continue;
    stop = m.index + m[0].length;
    break;
  }
  if (b >= 0 && (stop === null || b <= stop)) return { end: b, brk: true };
  return stop === null ? null : { end: stop, brk: false };
}

export class SpeakableStream {
  private buf = "";
  private emitted = 0;
  private held: string[] = [];
  private first = true;
  private capNext = false;
  private sentences = 0;
  constructor(private o: { maxSentenceWords?: number; maxReplyWords?: number; maxSentences?: number } = {}) {}

  private get maxS() { return this.o.maxSentenceWords ?? MAX_SENTENCE_WORDS; }
  private get maxR() { return this.o.maxReplyWords ?? MAX_REPLY_WORDS; }

  // Each finished sentence goes out now, or is held once the reply is past its word cap.
  private emit(sentences: string[], out: string[]) {
    for (const s of sentences) {
      if (!s) continue;
      const n = wordCount(s);
      // A hard limit on sentences (a drained member gets two): the rest is dropped, with no closing question kept either.
      if (this.o.maxSentences !== undefined && this.sentences >= this.o.maxSentences) continue;
      if (this.emitted >= this.maxR) { this.held.push(s); continue; }
      this.sentences++;
      this.emitted += n;
      out.push(s + " ");
    }
  }

  private finish(raw: string, madeBreak: boolean, out: string[]) {
    let s = closeSentence(raw.replace(new RegExp(BREAK, "g"), " "));
    if (!s || /^[.!?\s]+$/.test(s)) return;
    if (this.capNext) s = capitalize(s);
    this.capNext = madeBreak;
    this.first = false;
    this.emit(splitLong(s, this.maxS), out);
  }

  private drain(final: boolean, out: string[]) {
    for (;;) {
      const b = firstBoundary(this.buf);
      if (b) {
        const piece = this.buf.slice(0, b.end);
        this.buf = this.buf.slice(b.end).replace(new RegExp(`^${BREAK}+`), "").trimStart();
        this.finish(piece, b.brk, out);
        continue;
      }
      // No end yet, but already too long to wait for one: close it early at the best comma or conjunction seen so far.
      const upTo = this.buf.lastIndexOf(" ");
      if (!final && upTo > 0 && wordCount(this.buf.slice(0, upTo)) > this.maxS + 3) {
        const ws = this.buf.split(/\s+/).filter(Boolean);
        const br = chooseBreak(ws.slice(0, -1), this.maxS) ?? { k: this.maxS, kind: "hard" as const };
        let left = closeLeft(ws.slice(0, br.k), QSTART.has(bare(ws.find((w) => !TAG_ONLY.test(w)))) && bare(ws[br.k]) === "or");
        if (this.capNext) left = capitalize(left);
        this.capNext = false;
        this.buf = capitalize(afterBreak(ws.slice(br.k), br).join(" ")) + (/\s$/.test(this.buf) ? " " : "");
        this.emit([left], out);
        this.first = false;
        continue;
      }
      return;
    }
  }

  push(delta: string): string[] {
    const out: string[] = [];
    this.buf += delta;
    // A trailing "-" or " -" may be the start of a dash that hasn't finished arriving: leave it until more text comes.
    const hold = this.buf.match(/\s?-$/)?.[0] ?? "";
    const body = hold ? this.buf.slice(0, -hold.length) : this.buf;
    this.buf = normalize(body) + hold;
    this.drain(false, out);
    return out;
  }

  // The stream is over: whatever is left is the last sentence. Past the cap, only a short closing question is kept.
  end(): string[] {
    const out: string[] = [];
    this.buf = normalize(this.buf);
    this.drain(true, out);
    if (this.buf.trim()) { const rest = this.buf; this.buf = ""; this.finish(rest, false, out); }
    const last = this.o.maxSentences !== undefined ? undefined : this.held[this.held.length - 1];
    if (last && /\?$/.test(last) && this.emitted + wordCount(last) <= this.maxR + CLOSING_QUESTION_EXTRA_WORDS) out.push(last + " ");
    this.held = [];
    return out;
  }
}

// The whole text at once (tests, the post-call fallback).
export function speakable(text: string, o: { maxSentenceWords?: number; maxReplyWords?: number; maxSentences?: number } = {}): string {
  const s = new SpeakableStream(o);
  return [...s.push(text), ...s.end()].join("").trim();
}

// What a reply sounds like to the voice: for the replay and the tests.
export function speechStats(text: string): { words: number; dashes: number; semicolons: number; parens: number; sentences: number; over: number; avg: number } {
  const clean = text.replace(/\[[a-z][a-z ]*\]\s*/gi, "");
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean).map((x) => x.split(/\s+/).filter(Boolean).length);
  const words = sentences.reduce((a, b) => a + b, 0);
  return {
    words,
    dashes: (clean.match(/—|–|--| - /g) ?? []).length,
    semicolons: (clean.match(/;/g) ?? []).length,
    parens: (clean.match(/[()]/g) ?? []).length,
    sentences: sentences.length,
    over: sentences.filter((n) => n > MAX_SENTENCE_WORDS).length,
    avg: sentences.length ? words / sentences.length : 0,
  };
}

// ---------- one voice standard for calls and texts: Co never narrates its own state (Royce, 2026-10-08)
// After a call Co texted "On it. Starting the post-event branding plan ... and I'll text you what I put together once it's worth
// sending." That is task-tracker language in a companion's mouth: it reports Co's internal state ("starting", "working on") and
// holds the member's own thing behind Co's judgment ("once it's worth sending"). What Co says has a shape instead: what it
// understood, what they get, and when ("Got it, I'll put together the plan for keeping Co visible after the launch and text you
// the draft tonight."). Co sends when it is done, or says plainly what is still missing.
// Pure. The same rule reads Co's spoken lines (the after-call audit, routes/co.ts) and every text Co drafts (harness/proactive.ts
// checkDraft), so calls and texts are held to one standard. A question to them ("Working on anything fun?") is not narration.
export const NARRATION_RULES: { pattern: RegExp; why: string }[] = [
  // A sentence that opens on Co's own activity: "Starting the plan", "Working on it now", "Digging into it".
  { pattern: /^(?:(?:ok(?:ay)?|got it|on it|sure|great|perfect|alright)[,.!]?\s+)?(?:now\s+|already\s+|still\s+)?(?:starting|started|working on|beginning|kicking off|getting started on|digging into|looking into|in the middle of)\b/i, why: "opens on Co's own activity (task-tracker language)" },
  // First person, in progress: "I'm starting", "I've started on it", "I'm still working on the draft", "I started the plan".
  { pattern: /\b(?:i'?m|i am|i'?ve|i have|i)\s+(?:now\s+|just\s+|still\s+|already\s+|officially\s+)?(?:started|starting|begun|beginning|working on|kicking off|kicked off|getting started|in the middle of)\b/i, why: "narrates what Co is doing instead of what they get" },
  // Their own thing held behind Co's judgment: "once it's worth sending", "once it's in good shape", "nothing worth sending yet".
  { pattern: /\bonce (?:it'?s|it is|they'?re|they are|there'?s|i have|i'?ve got)\s+(?:\w+\s+){0,2}?(?:worth|good enough|ready to send|in good shape|solid)\b/i, why: "holds their own thing behind Co's judgment" },
  { pattern: /\b(?:worth (?:sending|sharing|passing along|texting)|good enough to (?:send|share))\b/i, why: "judges whether their own thing is worth sending" },
  // A status report on not having it yet (2026-10-08 live: "No confirmed details yet... Have a few leads, just nothing solid enough to
  // send you. I'll have it soon."): say what's missing or say nothing until it's done.
  { pattern: /\b(?:solid|good|strong|ready|concrete|firm|real) enough to (?:send|share|pass along|text)\b/i, why: "judges whether their own thing is ready to send" },
  { pattern: /^(?:so far,?\s+)?no (?:confirmed|solid|concrete|firm|real|good) (?:details|options|picks|results|leads|answers|news)?\s*(?:yet|so far)\b/i, why: "reports not having it yet" },
  { pattern: /\b(?:have|got|found) a (?:few|couple of|couple) (?:leads|options in the works)\b|\bi'?ll have (?:it|them|something|more) (?:soon|shortly|in a bit)\b|\bstill (?:looking|searching|checking|digging)\b/i, why: "a progress report instead of the thing" },
  // Co's own machinery, said aloud (2026-10-08 live call: "The search hit a limit on my end ... I'm retrying it now").
  { pattern: /\b(?:hit a (?:limit|snag|wall|cap)|ran into a (?:limit|snag|cap)|(?:on|at) my end)\b|\b(?:i'?m|i am)\s+(?:now\s+)?(?:retrying|re-?running|trying (?:it|that) again|still (?:searching|looking|loading))\b/i, why: "narrates Co's own machinery" },
  // Tracker words.
  { pattern: /\b(?:status update|in progress|on my (?:list|queue)|in my queue|queued (?:it|up)|my task list)\b/i, why: "task-tracker words" },
];

// Pure: why a line narrates Co's internal state, or null when it doesn't. Checked per sentence; questions pass.
export function narratesInternalState(text: string): string | null {
  const sentences = text
    .replace(/\[[a-z][a-z ]*\]\s*/gi, "")
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    if (/\?\s*["')\]]*$/.test(s)) continue;
    for (const r of NARRATION_RULES) if (r.pattern.test(s)) return `${r.why}: "${s.slice(0, 80)}"`;
  }
  return null;
}

// ---------- a line never contradicts itself (Royce, 2026-10-08: "A call opening can never contradict itself.")
// The opening written for him: "Have you had a chance to review that post-event branding plan I owe you, or still waiting on
// Jacqueline's input?" A plan Co still owes can't have been reviewed. Three shapes, each tied to the SAME thing so two true
// clauses about two different things ("the venue is booked, the date is still open") pass:
//   1. something Co owes (not delivered) is also something they reviewed, received, read or liked, or Co sent;
//   2. "still" with a completion verb ("still finished", "still sent");
//   3. two clauses asserting opposite states of one thing: done and not done, locked and open, heard back and still waiting.
// An either-or question ("Is the date locked, or still open?") asks; it doesn't assert both, so its alternatives are not compared.
// Pure, a few regexes over one or two sentences.
const OWED = /\b(?:i|co)\s+(?:still\s+)?owes?\s+you\b|\bi\s+(?:still\s+)?(?:haven't|have not|didn't|did not)\s+(?:yet\s+)?(?:sent|finished|shared|delivered|written|drafted)\b|\bstill\s+(?:owed|pending|to come|on (?:my|its) way)\b|\bnot (?:sent|finished|done|ready) yet\b/i;
const THEY_HAD = /\b(?:had|get|got|getting|have)\s+(?:a\s+)?(?:chance|minute|moment|time)\s+to\s+(?:review|read|look|go through|check|dig|open)\b|\b(?:did|have|has)\s+you\s+(?:get\s+to\s+|got\s+to\s+)?(?:review(?:ed)?|read|receive[d]?|get|got(?:ten)?|see|seen|like[d]?|love[d]?|look(?:ed)?\s+(?:at|over|through)|go(?:ne)?\s+through|check(?:ed)?\s+out|open(?:ed)?|sign(?:ed)?\s+off)\b|\byou(?:'ve| have)?\s+(?:already\s+)?(?:reviewed|received|gotten|seen|liked|loved|looked (?:at|over)|gone through|checked out|opened|signed off on)\b|\bwhat\s+did\s+you\s+think\s+of\b|\bhow\s+did\s+you\s+like\b|\b(?:your|any)\s+(?:feedback|notes|edits)\s+on\b/i;
const CO_SENT = /\bi(?:'ve| have)?\s+(?:already\s+|just\s+)?(?:sent|delivered|shared|finished|wrapped up|handed over)\b/i;
const STILL_DONE = /\bstill\s+(?:(?:been|being|have|has|had|is|are|was|were)\s+)?(?:already\s+)?(?:finished|completed|delivered|sent|reviewed|signed off|wrapped up)\b/i;
// Opposite states of one thing.
const STATES: { name: string; yes: RegExp; no: RegExp }[] = [
  {
    name: "done and not done",
    yes: /\b(?:is|was|it's|that's|now|all)\s+(?:all\s+)?(?:done|finished|ready|sent|wrapped up|complete)\b|\bi(?:'ve| have)\s+(?:already\s+)?(?:sent|finished|delivered)\b/i,
    no: new RegExp(`${OWED.source}|\\b(?:not|isn't|wasn't|hasn't been|is not)\\s+(?:done|finished|ready|sent)\\b|\\bstill\\s+(?:in progress|being (?:drafted|written|built|put together))\\b`, "i"),
  },
  {
    name: "locked and open",
    yes: /\b(?:is|was|it's|that's|now|got|been|all|are|they're)\s+(?:locked(?:\s+in)?|confirmed|booked|finalized|final|set in stone)\b/i,
    no: /\b(?:not|isn't|wasn't|aren't|hasn't been|haven't been|never)\s+(?:yet\s+)?(?:locked|confirmed|booked|final|finalized|set)\b|\bstill\s+(?:open|up in the air|undecided|tbd|unconfirmed|in flux)\b|\bup in the air\b|\bunconfirmed\b|\bstays open\b/i,
  },
  {
    name: "heard back and still waiting",
    yes: /\b(?:heard back|got back to (?:you|us)|replied|responded|came back to (?:you|us))\b/i,
    no: /\b(?:still\s+)?waiting (?:on|for)\b|\b(?:haven't|have not|hasn't|has not) (?:heard|replied|responded|gotten back)\b|\bno word (?:from|yet)\b/i,
  },
];
const CLAUSE_PLAIN = new Set("that this those these with your yours have been still about from into just over then they them their there what when where which while would could should will last talked chance review reviewed waiting owe owed sent done ready locked open confirmed booked heard back hear input thing things something anything since already yet it's that's you've you're i've i'm really".split(" "));
const nounsOf = (clause: string) => new Set(clause.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z' -]+/g, " ").split(/[\s-]+/).map((w) => w.replace(/'s$/, "")).filter((w) => w.length >= 4 && !CLAUSE_PLAIN.has(w)));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));
const POINTS_BACK = /^\s*(?:and\s+|but\s+|so\s+|or\s+)?(?:it|that|this|they|it's|that's|they're)\b|\b(?:it|that|this)\s*[?.!]?\s*$/i;

type Clause = { text: string; sentence: number; alt: boolean };
function clausesOf(line: string): Clause[] {
  const out: Clause[] = [];
  const sentences = line.replace(/[’‘]/g, "'").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  sentences.forEach((s, i) => {
    const asks = /\?\s*$/.test(s);
    // "..., or ..." and "... or ..." in a question start an alternative, not a second assertion.
    const SEP = /(,\s*(?:or|but|and|so)\s+|\s+(?:or|but)\s+|[,;:]\s*)/i;
    let alt = false;
    s.split(SEP).forEach((p, k) => {
      // split() with a captured separator: odd places are the separators.
      if (k % 2 === 1) { alt = asks && /\bor\b/i.test(p); return; }
      if (p.trim()) out.push({ text: p.trim(), sentence: i, alt });
      alt = false;
    });
  });
  return out;
}

// Pure: why a line contradicts itself, or null.
export function selfContradiction(line: string): string | null {
  const text = line.replace(/\[[a-z][a-z ]*\]\s*/gi, "").replace(/[’‘]/g, "'");
  if (STILL_DONE.test(text)) return `"still" with a completion verb: "${text.match(STILL_DONE)![0]}"`;
  const clauses = clausesOf(text);
  // 1. Owed, and also had or sent: in one clause ("review that plan I owe you"), or about the same thing in two.
  const owed = clauses.filter((c) => OWED.test(c.text));
  const had = clauses.filter((c) => THEY_HAD.test(c.text) || CO_SENT.test(c.text));
  for (const o of owed) for (const h of had) {
    if (o === h || shares(nounsOf(o.text), nounsOf(h.text)) || (h.sentence >= o.sentence && POINTS_BACK.test(h.text))) {
      return `something Co still owes is also something they had or Co sent: "${o === h ? o.text : `${o.text} / ${h.text}`}"`;
    }
  }
  // 3. Opposite states of one thing.
  for (const st of STATES) {
    for (let i = 0; i < clauses.length; i++) for (let j = 0; j < clauses.length; j++) {
      if (i === j) continue;
      const a = clauses[i], b = clauses[j];
      if (!st.yes.test(a.text) || !st.no.test(b.text)) continue;
      // Either-or alternatives in a question: asking which, not saying both.
      if (a.sentence === b.sentence && (a.alt || b.alt)) continue;
      const later = i < j ? b : a;
      if (shares(nounsOf(a.text), nounsOf(b.text)) || POINTS_BACK.test(later.text)) return `${st.name} at once: "${a.text}" / "${b.text}"`;
    }
  }
  return null;
}
