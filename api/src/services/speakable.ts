// Making Co's words speakable (Royce, 2026-10-06: "It sounds like it's reading a run on sentence"; "we want a certain cadence and
// rhythm to her voice"). Haiku joins thoughts with dashes however the prompt asks it not to, and a voice reading a dash-joined
// 30-word sentence has nowhere to breathe. So the call brain's text goes through here on its way to the voice, in code:
//   - an unspaced or spaced dash becomes a full stop and a capital ("That's smart—keeping it warm" -> "That's smart. Keeping it warm.")
//   - a semicolon, a parenthesis, a line break becomes a plain stop
//   - a sentence past 15 words closes at the nearest comma or conjunction (a comma break drops the "and" after it)
//   - a reply past the word cap is truncated at a sentence boundary, keeping its closing question
// It works on a stream: text goes in as it arrives, and each COMPLETE sentence comes out the moment it is complete, so the first
// sentence reaches the voice at the model's own speed and the voice never gets half a sentence. Pure; no I/O.

export const MAX_SENTENCE_WORDS = 15;
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
const SLACK_WORDS = 3;
function chooseBreak(ws: string[], max: number): Break | null {
  let comma: Break | null = null;
  let conj: Break | null = null;
  let weak: Break | null = null; // a comma after an introductory clause: only when the sentence is too long to leave whole
  for (let k = 1; k < ws.length; k++) {
    const left = countWords(ws.slice(0, k));
    if (left > max) break;
    if (left < 3 || countWords(ws.slice(k)) < 3) continue;
    if (/,$/.test(ws[k - 1])) { if (opensSubordinate(ws.slice(0, k))) weak = { k, kind: "comma" }; else comma = { k, kind: "comma" }; }
    else if (CONJ.has(bare(ws[k]))) conj = { k, kind: "conj" };
  }
  const natural = comma ?? conj;
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
