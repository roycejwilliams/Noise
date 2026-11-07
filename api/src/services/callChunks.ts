// Topic chunks of a stored call transcript, cut at READ time (Cue Memory Spec step 10). A call is stored whole (one co_memories row,
// average ~1,900 characters, longest ~17,800) and carries one vector, so a recall hit used to show the opening of a long call or a
// five-line window around a keyword. Here the call is split by topic and the hit returns the part that is about the question.
//
// No new storage and no model call: the split is a pure function of the lines already stored. A boundary falls where the words of the
// next few lines stop overlapping the words of the last few (a change of subject), and never makes a part too small or too large.
// The lines keep their speaker labels and their own words; nothing is rewritten.
import type { RecallLine } from "./conversationRecall.js";

export const CHUNK = { minLines: 4, maxLines: 14, maxChars: 1600, window: 3, minWords: 5, overlapBelow: 0.1 } as const;

const STOP = new Set("that this with have from they them then than just like what when where which about there their would could should really very okay yeah well also into over some more your you're i'm it's don't can't".split(" "));
// Pure: a line's content words (4+ letters, no filler), lowercased.
export const contentWords = (text: string): string[] => (String(text ?? "").toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? []).filter((w) => !STOP.has(w));

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 1; // too little to call a change of subject
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
};

// Pure: how much the words just before line i overlap the words from line i on (1 when either side has too little to tell).
function shiftScores(lines: Pick<RecallLine, "text">[]): number[] {
  return lines.map((_, i) => {
    if (i === 0) return 1;
    const before = new Set(lines.slice(Math.max(0, i - CHUNK.window), i).flatMap((l) => contentWords(l.text)));
    const after = new Set(lines.slice(i, i + CHUNK.window).flatMap((l) => contentWords(l.text)));
    return before.size >= CHUNK.minWords && after.size >= CHUNK.minWords ? overlap(before, after) : 1;
  });
}

// Pure: the call's lines as [from, to) ranges, in order, covering every line once. A boundary goes where the overlap between the lines
// before and after is lowest (a local minimum under overlapBelow), so it lands on the change of subject, not a line early.
export function chunkRanges(lines: Pick<RecallLine, "text">[]): [number, number][] {
  const score = shiftScores(lines);
  const out: [number, number][] = [];
  let start = 0;
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > start) {
      const size = i - start;
      const room = size >= CHUNK.maxLines || chars + lines[i].text.length > CHUNK.maxChars;
      const shift = !room && size >= CHUNK.minLines && lines.length - i >= CHUNK.minLines / 2 && score[i] < CHUNK.overlapBelow && score[i] < (score[i - 1] ?? 1) && score[i] <= (score[i + 1] ?? 1);
      if (room || shift) {
        out.push([start, i]);
        start = i;
        chars = 0;
      }
    }
    chars += lines[i].text.length;
  }
  if (lines.length) out.push([start, lines.length]);
  return out;
}

// Pure: how close a part is to a topic by shared word beginnings (5 letters), for a call matched by meaning with no topic word in it.
// 0 when nothing is shared.
export function chunkScore(lines: Pick<RecallLine, "text">[], terms: string[]): number {
  const stems = terms.flatMap((t) => t.toLowerCase().split("|")).map((t) => t.replace(/[^\p{L}\p{N}']/gu, "")).filter((t) => t.length >= 4).map((t) => t.slice(0, 5));
  if (!stems.length) return 0;
  const words = lines.flatMap((l) => contentWords(l.text));
  return words.filter((w) => stems.some((s) => w.startsWith(s))).length;
}
