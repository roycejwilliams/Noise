// The hidden part (Royce, 2026-10-18: "It should never be mentioned to another user what that person is going through").
// A member's private asks and blockers reach the matching scorer as a hidden signal (services/matching.ts). They may raise a
// match and are never its basis; and no text another member reads (a share reason, a value line, a nudge, a direct ask, a
// reveal, an intro email) may echo them, word for word or near it. Pure, no imports: matchGate.ts, roomMatching.ts and
// introConsent.ts all read it.
const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "who", "that", "is", "are", "their", "they", "them", "at", "as", "by", "be", "it", "this"]);
const GENERIC = new Set([
  ...STOP, "about", "after", "also", "been", "being", "from", "have", "into", "just", "like", "looking", "make", "more", "need",
  "really", "some", "someone", "people", "person", "want", "would", "could", "should", "find", "meet", "help", "good", "great",
  "work", "then", "than", "what", "when", "where", "which", "while", "will", "your", "other", "over", "thing", "time", "year",
  "still", "much", "many", "very", "well", "best", "right", "around", "through", "going", "doing", "know", "keep", "here",
  "there", "these", "those", "tonight", "today", "week", "month", "worth", "able", "next", "first", "last",
]);
const fold = (s: string) =>
  String(s ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[\u2019\u2018]/g, "'").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
// Hyphenated words joined ("trans-pacific" -> "transpacific", "anti-abuse" -> "antiabuse"), for the sensitive-topic test only: a
// prefix is never read as the word.
export const joinHyphens = (s: string) => String(s ?? "").replace(/(\p{L})[-\u2010\u2011](?=\p{L})/gu, "$1");
// The sensitive patterns read with hyphens joined (matchGate.ts marks its 2026-10-18 words). The older ones are read as before,
// so "anti-anxiety" still carries "anxiety" for them.
export const PREFIX_SAFE = new WeakSet<RegExp>();
// Pure: the text a sensitive pattern reads, plain (folded) or with hyphens joined.
export const sensitiveForm = (re: RegExp, plain: string, joined: string) => (PREFIX_SAFE.has(re) ? joined : plain);
const words = (s: string) => fold(s).split(" ").filter((w) => w && !STOP.has(w));
// "move", "moving" and "moved" are one word; "divorce" and "divorced" too.
const stem = (w: string) => w.replace(/ies$/, "y").replace(/(?:ing|edly|ed|ly|es|s)$/, "").replace(/e$/, "");
function stemsOf(s: string): Set<string> {
  return new Set(fold(s).split(" ").filter((w) => w.length >= 4 && !GENERIC.has(w)).map(stem).filter((w) => w.length >= 3));
}
function shingles(ws: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

// Every match of a pattern, trimmed (the patterns are not global).
const matchesOf = (re: RegExp, s: string) => [...s.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].map((m) => m[0].trim());
// Pure: the text folded and padded (" a b c "), with each of these texts, quoted word for word, taken out. joined: hyphens
// joined first (sensitiveForm reads which form a pattern wants).
export function stripQuoted(text: string, quotes: string[], joined = false): string {
  const f = (s: string) => fold(joined ? joinHyphens(s) : s);
  let t = ` ${f(text)} `;
  for (const q of quotes.map(f).filter((x) => x.length > 1).sort((x, y) => y.length - x.length)) t = t.split(` ${q} `).join(" zzsep ");
  return t;
}
// Pure: the sensitive words a text carries that their own shareable text doesn't let through (decided 2026-10-19). A word is
// allowed about a member only if THAT member's own shareable text carries it, and a word their private material carries only
// where the text quotes that shareable text word for word (the own-ask verbatim rule). Words in anyone else's text (the
// reader's, the other member's, a value line) never let one through. family: a pattern counts once private material carries
// any of its words (the hidden part); otherwise only the same word does.
export function unconsentedSensitive(text: string, privateTexts: string[], ownShareable: string[], sensitive: RegExp[], family = true, allow: string[] = []): string | null {
  const own = ownShareable.map(String).filter((x) => x.trim());
  const priv = privateTexts.map(String).filter((x) => x.trim());
  if (!priv.length) return null;
  const t = stripQuoted(text, allow), tj = stripQuoted(text, allow, true);
  const rest = stripQuoted(text, [...allow, ...own]), restj = stripQuoted(text, [...allow, ...own], true);
  for (const re of sensitive) {
    const privWords = new Set(priv.flatMap((h) => matchesOf(re, sensitiveForm(re, ` ${fold(h)} `, ` ${fold(joinHyphens(h))} `))));
    if (!privWords.size) continue;
    const ownWords = new Set(own.flatMap((o) => matchesOf(re, sensitiveForm(re, ` ${fold(o)} `, ` ${fold(joinHyphens(o))} `))));
    const left = new Set(matchesOf(re, sensitiveForm(re, rest, restj)));
    for (const w of matchesOf(re, sensitiveForm(re, t, tj))) {
      if (!family && !privWords.has(w)) continue;
      if (!ownWords.has(w) || (privWords.has(w) && left.has(w))) return w;
    }
  }
  return null;
}

// Pure: why a text echoes one of these hidden texts, or null.
// allowedTexts: words the text may carry whoever else said them (the other member's shared asks, the reader's own asks and
// goals), for the word-for-word and distinctive-word tests. They never let a sensitive word through (decided 2026-10-19).
// allow: phrases taken out first (the event, the venue, first names). sensitive: matchGate.ts SENSITIVE, passed in.
// ownShareable: the shareable asks of the member whose hidden texts these are: the only text that may let a sensitive word
// through (unconsentedSensitive), and allowed for the other tests too.
// Echo is any of:
//   - a sensitive topic the hidden text carries, unless their own shareable text consents to that word (unconsentedSensitive)
//   - three words in a row from the hidden text that no allowed text has
//   - its distinctive words (4+ letters, not common, stemmed, in no allowed text): two of them, or its only one
export function hiddenEcho(text: string, hidden: string[], allowedTexts: string[] = [], allow: string[] = [], sensitive: RegExp[] = [], ownShareable: string[] = []): string | null {
  let t = ` ${fold(text)} `;
  for (const a of allow.map(fold).filter((x) => x.length > 1).sort((x, y) => y.length - x.length)) t = t.split(` ${a} `).join(" zzsep ");
  const allowedAll = [...allowedTexts, ...ownShareable];
  const allowedStems = new Set(allowedAll.flatMap((x) => [...stemsOf(x)]));
  const allowedShingles = shingles(words(allowedAll.join(" . ")), 3);
  const textStems = stemsOf(t);
  const textShingles = shingles(words(t), 3);
  for (const h of hidden.map(String).filter((x) => x.trim())) {
    // Quoted as the text has it (folded): the redraft feedback names only words the draft itself already carried.
    const said = unconsentedSensitive(text, [h], ownShareable, sensitive, true, allow);
    if (said) return `touches something they keep private ("${said}")`;
    for (const sh of shingles(words(h), 3)) if (!sh.includes("zzsep") && textShingles.has(sh) && !allowedShingles.has(sh)) return `quotes something they keep private ("${sh}")`;
    const distinct = [...stemsOf(h)].filter((w) => !allowedStems.has(w));
    const hits = distinct.filter((w) => textStems.has(w));
    if (distinct.length && hits.length >= Math.min(2, distinct.length)) return `echoes something they keep private (${hits.map((w) => `"${w}"`).join(", ")})`;
  }
  return null;
}

export type EchoCheck = { name: string; pass: boolean; reason?: string };
export function checkNoHiddenEcho(text: string, hidden: string[], allowedTexts: string[] = [], allow: string[] = [], name = "no_hidden_echo", sensitive: RegExp[] = [], ownShareable: string[] = []): EchoCheck {
  const why = hiddenEcho(text, hidden, allowedTexts, allow, sensitive, ownShareable);
  return why ? { name, pass: false, reason: why } : { name, pass: true };
}
