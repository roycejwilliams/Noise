// A document is a record of what THEY said (Royce, 2026-10-07: "write the document from the member's own words only").
// The event/name/time check (services/offerGuard.ts) caught an invented event but not a loose claim: "Dallas leans Partiful, Luma is
// close to nonexistent there" and "each event funds the next" were Co's own, written into his record as if he had said them.
//
// So every sentence in the member's sections must be backed by their own words: most of its distinctive words (and every number)
// appear in what they said. Co's own reasoning goes only in the separate, visibly marked suggestions, which are not held to this
// (they still can't name an unbacked event, place or time). The check is lexical on purpose: it can't judge whether a paraphrase is
// fair, but a claim whose own words never appear in anything they said is Co's.
//
// Pure.

const STOP = new Set(
  ("about above after again against almost already also always among another around because been before being between both cannot could does doing done down during each either else even ever every first from further have having here into itself just keep kind like make many might more most much must never next only other over really right same should since some still such take than that their them then there these they thing think this those through today under until upon very want well were what when where which while will with within without would your yours you're they're that's it's don't doesn't "
    + "document documents notes point points section sections called based means mean makes made makes using used uses help helps work works working getting going gets come comes").split(" "),
);
const words = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
// First five letters: "matching", "matches" and "match" are one word; "funds" and "funded" too.
const stem = (w: string) => w.replace(/'s$/, "").slice(0, 5);

// A claim is backed when most of its distinctive words sit close together in what they said: within a short run of their sentences
// (a window), not scattered across two weeks of talk. Scattered words are how a claim of Co's own passes ("each event funds the next":
// every one of those words appears somewhere in a fortnight of messages).
export const GROUNDING = { minShare: 0.6, minWords: 3, window: 3 };

const splitSentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => words(x).length >= 2);

export type SourceWindows = { windows: Set<string>[]; text: string };
export function sourceWindows(source: string): SourceWindows {
  const sents = splitSentences(source).map((x) => new Set(words(x).filter((w) => w.length >= 3).map(stem)));
  const windows: Set<string>[] = [];
  for (let i = 0; i < sents.length; i++) {
    const w = new Set<string>();
    for (let j = i; j < Math.min(sents.length, i + GROUNDING.window); j++) for (const x of sents[j]) w.add(x);
    windows.push(w);
  }
  return { windows, text: source };
}

export type Unbacked = { text: string; share: number; missing: string[] };

// Pure: how much of a sentence rests on one stretch of what they said.
export function support(sentence: string, src: SourceWindows): Unbacked | null {
  const ws = words(sentence);
  const distinct = [...new Set(ws.filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d/.test(w)))];
  const nums = ws.filter((w) => /\d/.test(w));
  const flat = ` ${words(src.text).join(" ")} `;
  const missingNums = nums.filter((n) => !flat.includes(` ${n} `));
  let best = 0;
  let bestMissing = distinct;
  for (const w of src.windows) {
    const missing = distinct.filter((d) => !w.has(stem(d)));
    const covered = distinct.length - missing.length;
    if (covered > best) { best = covered; bestMissing = missing; }
  }
  const share = distinct.length ? best / distinct.length : 1;
  const judged = distinct.length >= GROUNDING.minWords;
  if (missingNums.length || (judged && share < GROUNDING.minShare)) return { text: sentence, share, missing: [...missingNums, ...bestMissing].slice(0, 6) };
  return null;
}

const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: the member's sections, sentence by sentence and bullet by bullet, against what they said. (Suggestions are not passed in.)
export function unbackedClaims(parts: string[], source: string): Unbacked[] {
  const src = sourceWindows(source);
  const out: Unbacked[] = [];
  for (const p of parts) for (const s of sentencesOf(p)) {
    const u = support(s, src);
    if (u) out.push(u);
  }
  return out;
}
