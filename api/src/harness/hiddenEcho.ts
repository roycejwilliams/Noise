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

// Pure: why a text echoes one of these hidden texts, or null.
// allowedTexts: words the text may carry whoever else said them (the other member's shared asks, the reader's own asks and goals).
// allow: phrases taken out first (the event, the venue, first names). sensitive: matchGate.ts SENSITIVE, passed in.
// Echo is any of:
//   - a sensitive topic the hidden text carries, unless an allowed text carries it too
//   - three words in a row from the hidden text that no allowed text has
//   - its distinctive words (4+ letters, not common, stemmed, in no allowed text): two of them, or its only one
export function hiddenEcho(text: string, hidden: string[], allowedTexts: string[] = [], allow: string[] = [], sensitive: RegExp[] = []): string | null {
  let t = ` ${fold(text)} `;
  for (const a of allow.map(fold).filter((x) => x.length > 1).sort((x, y) => y.length - x.length)) t = t.split(` ${a} `).join(" zzsep ");
  const allowedStems = new Set(allowedTexts.flatMap((x) => [...stemsOf(x)]));
  const allowedShingles = shingles(words(allowedTexts.join(" . ")), 3);
  const textStems = stemsOf(t);
  const textShingles = shingles(words(t), 3);
  let tj = ` ${fold(joinHyphens(text))} `;
  for (const a of allow.map((x) => fold(joinHyphens(x))).filter((x) => x.length > 1).sort((x, y) => y.length - x.length)) tj = tj.split(` ${a} `).join(" zzsep ");
  const allowedJoined = allowedTexts.map((x) => ` ${fold(joinHyphens(x))} `);
  for (const h of hidden.map(String).filter((x) => x.trim())) {
    const hn = ` ${fold(joinHyphens(h))} `;
    for (const re of sensitive) {
      // Quoted as the text has it: the redraft feedback names only words the draft itself already carried.
      const said = re.test(hn) ? tj.match(re)?.[0] : undefined;
      if (said && !allowedJoined.some((x) => re.test(x))) return `touches something they keep private ("${said.trim()}")`;
    }
    for (const sh of shingles(words(h), 3)) if (!sh.includes("zzsep") && textShingles.has(sh) && !allowedShingles.has(sh)) return `quotes something they keep private ("${sh}")`;
    const distinct = [...stemsOf(h)].filter((w) => !allowedStems.has(w));
    const hits = distinct.filter((w) => textStems.has(w));
    if (distinct.length && hits.length >= Math.min(2, distinct.length)) return `echoes something they keep private (${hits.map((w) => `"${w}"`).join(", ")})`;
  }
  return null;
}

export type EchoCheck = { name: string; pass: boolean; reason?: string };
export function checkNoHiddenEcho(text: string, hidden: string[], allowedTexts: string[] = [], allow: string[] = [], name = "no_hidden_echo", sensitive: RegExp[] = []): EchoCheck {
  const why = hiddenEcho(text, hidden, allowedTexts, allow, sensitive);
  return why ? { name, pass: false, reason: why } : { name, pass: true };
}
