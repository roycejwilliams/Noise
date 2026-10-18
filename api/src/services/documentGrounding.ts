// A document is a record of what THEY said (Royce, 2026-10-07: "write the document from the member's own words only").
// The event/name/time check (services/offerGuard.ts) caught an invented event but not a loose claim: "Dallas leans Partiful, Luma is
// close to nonexistent there" and "each event funds the next" were Co's own, written into his record as if he had said them.
//
// So every sentence in the member's sections must be backed by their own words: most of its distinctive words (and every number)
// appear in what they said. Co's own reasoning goes only in the separate, visibly marked suggestions, which are not held to this
// (they still can't name an unbacked event, place or time). The check is lexical on purpose: it can't judge whether a paraphrase is
// fair, but a claim whose own words never appear in anything they said is Co's.
//
// Short lines (2026-10-07): a line with fewer than three longer words used to go unjudged, so "Rooftop needed" or "Budget 10k" passed
// when they never said a rooftop or 10k. Now a short line (four or fewer words that carry meaning, or fewer than three longer words) is
// held to their words word by word: every word in it that carries meaning (not glue like "needs", "about", "the") must be one of
// theirs, in one stretch of what they said, with plurals and tenses folded ("guests" and "people" are one word). And in every line, long or short,
// each number (by value: "$6k", "6k", "6,000", "six thousand" are one number) and each name or place (a capitalized word inside the
// line) must be one they said.
//
// Pure.

const STOP = new Set(
  ("about above after again against almost already also always among another around because been before being between both cannot could does doing done down during each either else even ever every first from further have having here into itself just keep kind like make many might more most much must never next only other over really right same should since some still such take than that their them then there these they thing think this those through today under until upon very want well were what when where which while will with within without would your yours you're they're that's it's don't doesn't "
    + "document documents notes point points section sections called based means mean makes made makes using used uses help helps work works working getting going gets come comes").split(" "),
);
// Glue: words a short line may carry without them being theirs. Function words, the framing a record uses ("needs", "wants"), hedges
// ("roughly"), the plainest verbs and question words ("how long it should run") and the record's own scaffolding ("next step"). Nothing here names a thing, a number, a place or a feature: an invented
// specific ("rooftop", "catering", "skyline") is never glue.
const GLUE = new Set([
  ...STOP,
  ...("a an the and or but nor of to in on at by for as is are was be am it its i me my we us our you he him his she her who whom whose how why if so no not yes do did has had can may shall too yet up out off per via vs etc all any few less least own "
    + "need needs needed want wants wanted would like likes looking hoping hope ideally rather prefer prefers preferred priority important "
    + "roughly approximately approx ish maybe probably "
    + "i'm i've i'd i'll we're we've we'd let's can't won't isn't aren't "
    + "long soon often far run go goes get set start meet talk talks ask say "
    + "step steps question questions item items note idea ideas plan plans things detail details also co").split(" "),
]);
const words = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
// First five letters: "matching", "matches" and "match" are one word; "funds" and "funded" too.
// A contraction's tail is not part of the word: "RSVP'd" is "RSVP", "chef's" is "chef" (2026-10-12: "at RSVP" was refused when they
// wrote "when they RSVP'd").
const bare = (w: string) => w.replace(/'(?:s|d|ll|re|ve)$/, "");
const stem = (w: string) => bare(w).slice(0, 5);
// The same people, said any of these ways ("40 guests" backs "40 people").
const SAME: Record<string, string> = Object.fromEntries(["person", "persons", "people", "peoples", "ppl", "guest", "guests", "folks", "attendees", "attendee", "heads", "pax"].map((w) => [w, "people"]));
// A plural or a tense, folded: "bars"/"bar", "parties"/"party", "hosted"/"hosting"/"hosts"/"host", "invited"/"invite", "planned"/"plan".
function fold(w0: string): string {
  let w = bare(w0).replace(/'/g, "");
  if (SAME[w]) return SAME[w];
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:sh|ch|x|ss|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && /[^su]s$/.test(w)) w = w.slice(0, -1);
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (/([b-df-hj-km-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w) && w.length > 3) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}
// A word matches when its first five letters do (as before) or its folded form does.
const keys = (w: string) => [`o:${stem(w)}`, `n:${fold(w)}`];
const has = (set: Set<string>, w: string) => keys(w).some((k) => set.has(k));

// ---------------------------------------------------------------- numbers, by value
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, dozen: 12 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, grand: 1e3, hundred: 100, million: 1e6, mil: 1e6, mm: 1e6, billion: 1e9, bn: 1e9 };
const isNumberWord = (w: string) => w in UNITS || w in TENS || w in SCALE;
// Pure: every number in a text, by value. "$6k", "6k", "6,000", "6 thousand", "six thousand" are all 6000; "1.5k" is 1500;
// "15 hundred" is 1500; "5pm" is 5; "10/22" is 10 and 22.
export function numberValues(text: string): number[] {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const out: number[] = [];
  const re = /(\$)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(k|thousand|grand|hundred|million|mil|mm|billion|bn|m)\b)?/g;
  for (const m of t.matchAll(re)) {
    let v = Number(m[2].replace(/,/g, ""));
    const s = m[3];
    if (s && (s !== "m" || m[1])) v *= s === "m" ? 1e6 : SCALE[s];
    if (Number.isFinite(v)) out.push(v);
  }
  // Spelled out: "forty", "forty five", "twelve hundred", "six thousand".
  const ws = t.replace(/[^a-z ]+/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < ws.length; i++) {
    let v: number | null = null;
    if (ws[i] in TENS) { v = TENS[ws[i]]; if (ws[i + 1] in UNITS && UNITS[ws[i + 1]] < 10) { v += UNITS[ws[i + 1]]; i++; } }
    else if (ws[i] in UNITS) v = UNITS[ws[i]];
    else if ((ws[i] === "a" || ws[i] === "one") && ws[i + 1] in SCALE && ws[i + 1] !== "k") { out.push(SCALE[ws[i + 1]]); i++; continue; }
    if (v === null) continue;
    if (ws[i + 1] in SCALE && ws[i + 1] !== "k") { v *= SCALE[ws[i + 1]]; i++; }
    out.push(v);
  }
  return out;
}

// A claim is backed when most of its distinctive words sit close together in what they said: within a short run of their sentences
// (a window), not scattered across two weeks of talk. Scattered words are how a claim of Co's own passes ("each event funds the next":
// every one of those words appears somewhere in a fortnight of messages).
// strictUpTo: a line with this many meaning-carrying words or fewer is short, and every one of them must be theirs ("Understand
// your response with rooftop" has three longer words, two of them theirs: 60% let the rooftop ride along). Five was measured too
// strict: "...at The Battery on Friday at 7pm to meet the team" is a fair line when they never said "team".
export const GROUNDING = { minShare: 0.6, minWords: 3, window: 3, strictUpTo: 4 };

const splitSentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => words(x).length >= 2);

export type SourceWindows = { windows: Set<string>[]; text: string; all: Set<string>; values: number[] };
export function sourceWindows(source: string): SourceWindows {
  const sents = splitSentences(source).map((x) => new Set(words(x).filter((w) => w.length >= 2).flatMap(keys)));
  const windows: Set<string>[] = [];
  for (let i = 0; i < sents.length; i++) {
    const w = new Set<string>();
    for (let j = i; j < Math.min(sents.length, i + GROUNDING.window); j++) for (const x of sents[j]) w.add(x);
    windows.push(w);
  }
  return { windows, text: source, all: new Set(words(source).flatMap(keys)), values: numberValues(source) };
}

// hard: the numbers and names in it they never gave. Those are facts, refused in code whatever a judge says (documentClaims.ts).
export type Unbacked = { text: string; share: number; missing: string[]; hard: string[] };

// Names and places: a capitalized word that doesn't open the line ("Harbor Hall", "Dallas", "Noor"), or a short all-caps one ("SF").
const namesIn = (sentence: string) =>
  [...sentence.replace(/[’‘]/g, "'").matchAll(/(?<![A-Za-z0-9'])([A-Z][A-Za-z']*)/g)]
    .filter((m) => (m.index ?? 0) > 0 && !/^\W*$/.test(sentence.slice(0, m.index)))
    .map((m) => m[1].toLowerCase().replace(/'s$/, ""))
    .filter((w) => w.length >= 2 && !GLUE.has(w) && !isNumberWord(w));

// Counts said as words (review of this branch, 2026-10-12): "a second dinner", "twice the rate", "half the table". Each must be a word
// they said. "Both" is too often just "you both" to refuse in code: a line with it they never said goes to the judge (partlyBacked).
const QUANTITY: Record<string, number | null> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, twice: 2, double: 2, doubled: 2, half: 0.5, several: null };
// A capital opening a line is usually just the start of a sentence (unknownOpeners).
const STARTERS = new Set(("every each one some most many all no not our their your his her its this that these those there here it it's they we you he she i "
  + "a an the and but so if when while after before since until once now then also still just only even both either neither "
  + "what why how who where which proof format partnership partner launch dinner dinners guests guest people members member seating seats seat table "
  + "pairings pairing wine host hosts chef chefs ask next step steps goal goals plan plans why how where").split(/\s+/).filter(Boolean));

// own: their own first name (services/memberRecord.ts ownName). Code clears a missing name only when it is exactly that word (ruling
// iii; review of #241: their name is never added to their words, where "Ellis Capital" would have passed on "capital").
export type SupportOptions = { strict?: boolean; own?: string | null };
// Their name read the way these checks read words (a-z only: "Zoë" is "zo" here, as in namesIn and unknownOpeners).
const ownWord = (own: string | null | undefined) => (own ? words(own)[0] ?? null : null);
const notOwn = (o: SupportOptions) => {
  const me = ownWord(o.own);
  return (w: string) => !me || w.replace(/'s$/, "") !== me;
};

// Pure: how much of a sentence rests on one stretch of what they said.
//   o.strict (documents): counts said as words ("both", "twice", "a second dinner") are held as numbers.
export function support(sentence: string, src: SourceWindows, o: SupportOptions = {}): Unbacked | null {
  const ws = words(sentence);
  // Every number, by value, must be one they gave.
  const missingNums = [...new Set(numberValues(sentence).filter((v) => !src.values.some((x) => Math.abs(x - v) < 1e-9)).map(String))];
  if (o.strict) {
    for (const w of new Set(ws)) {
      if (!(w in QUANTITY) || has(src.all, w)) continue;
      missingNums.push(w);
    }
  }
  // Every name or place must be one they said, anywhere.
  const missingNames = [...new Set(namesIn(sentence).filter((n) => !has(src.all, n)).filter(notOwn(o)))];
  const distinct = [...new Set(ws.filter((w) => w.length >= 5 && !STOP.has(w) && !/\d/.test(w) && !isNumberWord(w)).filter(notOwn(o)))];
  const meaning = [...new Set(ws.filter((w) => w.length >= 2 && !GLUE.has(w) && !/\d/.test(w) && !isNumberWord(w)).filter(notOwn(o)))];
  const judgedLong = distinct.length >= GROUNDING.minWords && meaning.length > GROUNDING.strictUpTo;
  // Long lines: most of their distinctive words, close together. Short lines: every word that carries meaning, close together.
  const need = judgedLong ? distinct : meaning;
  let best = 0;
  let bestMissing = need;
  for (const w of src.windows) {
    const missing = need.filter((d) => !has(w, d));
    const covered = need.length - missing.length;
    if (covered > best) { best = covered; bestMissing = missing; }
  }
  const share = need.length ? best / need.length : 1;
  const wordsFail = judgedLong ? share < GROUNDING.minShare : share < 1;
  if (missingNums.length || missingNames.length || wordsFail) {
    return { text: sentence, share, missing: [...missingNums, ...missingNames, ...(wordsFail ? bestMissing : [])].filter((x, i, a) => a.indexOf(x) === i).slice(0, 6), hard: [...missingNums, ...missingNames] };
  }
  return null;
}

// A point between digits ("1.5k", "$1,500.00") doesn't end a sentence.
const sentencesOf = (t: string) => (t.match(/(?:[^.!?\n]|\.(?=\d))+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: the member's sections, sentence by sentence and bullet by bullet, against what they said. (Suggestions are not passed in.)
export function unbackedClaims(parts: string[], source: string, o: SupportOptions = {}): Unbacked[] {
  const src = sourceWindows(source);
  const out: Unbacked[] = [];
  for (const p of parts) for (const s of sentencesOf(p)) {
    const u = support(s, src, o);
    if (u) out.push(u);
  }
  return out;
}

// Pure: the word opening a line, when it is capitalized, never in their words and not an ordinary starter: it may be a name ("Pelletier
// pours for every dinner"). Ordinary words open lines too ("Reserved for...", "Open: ..."), so these go to the judge, never refused
// on the capital alone; only when the judge can't run is the line held (documentClaims.ts).
export function unknownOpeners(parts: string[], source: string, own: string | null = null): { line: string; word: string }[] {
  const all = sourceWindows(source).all;
  const out: { line: string; word: string }[] = [];
  for (const p of parts) for (const s of sentencesOf(p)) {
    const opener = s.replace(/[’‘]/g, "'").match(/^\W*([A-Z][A-Za-z']+)/)?.[1];
    const w = opener?.toLowerCase().replace(/'s$/, "");
    if (w && w.length >= 3 && w !== ownWord(own) && !GLUE.has(w) && !STARTERS.has(w) && !isNumberWord(w) && !(w in QUANTITY) && !has(all, w)) out.push({ line: s, word: opener! });
  }
  return out;
}

// Pure: long lines the word check let through with some of their words not theirs (most, but not all, of them sit together in what
// they said). Those are where a claim of Co's own hides in their vocabulary ("The importer saw sales go up after the last dinner"),
// so a judge reads them (documentClaims.ts).
export function partlyBacked(parts: string[], source: string, o: SupportOptions = {}): string[] {
  const src = sourceWindows(source);
  const out: string[] = [];
  for (const p of parts) for (const s of sentencesOf(p)) {
    if (support(s, src, o)) continue;
    // Every word that carries meaning, short ones too ("came back", "sales go up"): the long-line check only weighs longer words.
    const meaning = [...new Set(words(s).filter((w) => w.length >= 2 && !GLUE.has(w) && !/\d/.test(w) && !isNumberWord(w)).filter(notOwn(o)))];
    if (!meaning.length) continue;
    const best = Math.max(0, ...src.windows.map((w) => meaning.filter((d) => has(w, d)).length));
    if (best < meaning.length) out.push(s);
  }
  return out;
}
