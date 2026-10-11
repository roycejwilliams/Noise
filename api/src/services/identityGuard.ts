// Co must not tell someone what they are unless they told it so (2026-09-21):
// a search reply said "Given you're French" about an X post aimed at French
// founders, and nothing in the profile says it. An event being aimed at a group
// does not put the person in it. This catches claims about who someone is
// (nationality, where they're from, gender, parent or spouse, veteran, immigrant), with or without a describing word ("as a new dad") and
// drops the sentence unless the same word is in what Co was given about them.
// No imports, so any drafting path can use it.

const DEMONYMS = [
  "french", "american", "british", "english", "german", "indian", "chinese", "japanese", "korean", "canadian", "mexican", "brazilian",
  "italian", "spanish", "russian", "israeli", "irish", "australian", "dutch", "swiss", "swedish", "nigerian", "kenyan", "turkish",
  "iranian", "vietnamese", "filipino", "pakistani", "colombian", "argentinian", "polish", "ukrainian", "greek", "portuguese", "egyptian",
  "african", "asian", "european", "latino", "latina", "hispanic", "jewish", "muslim", "christian", "catholic", "immigrant", "veteran",
];
const OTHER = ["woman", "man", "mom", "mother", "dad", "father", "parent", "student", "husband", "wife", "widow", "widower", "grandparent", "grandmother", "grandfather", "retiree", "newlywed"];

const D = DEMONYMS.join("|");
const O = OTHER.join("|");
// Up to two describing words between the article and the word ("as a new dad", "you're a proud Nigerian", "as a single working mom"):
// the claim is the same with or without them (2026-10-11, the "as a new dad" gap).
const ADJ = "(?:[a-z][\\w'’-]*\\s+){0,2}";
const CLAIMS: { re: RegExp; group: number }[] = [
  { re: new RegExp(`\\byou(?:'|’)?re\\s+(?:a\\s+|an\\s+|also\\s+|fellow\\s+|actually\\s+)*(${D})\\b`, "gi"), group: 1 },
  { re: new RegExp(`\\byou\\s+are\\s+(?:a\\s+|an\\s+|also\\s+|fellow\\s+)*(${D})\\b`, "gi"), group: 1 },
  { re: new RegExp(`\\b(?:as|being)\\s+(?:a|an)\\s+${ADJ}(${D}|${O})s?\\b`, "gi"), group: 1 },
  { re: new RegExp(`\\b(?:as|being)\\s+(${D}|${O})s\\b`, "gi"), group: 1 },
  // "dads like you", "a new mom like yourself", "for parents like you": the same claim, said sideways.
  { re: new RegExp(`\\b(${D}|${O})s?\\s+like\\s+(?:you|yourself)\\b`, "gi"), group: 1 },
  { re: /\byou(?:'|’)?re\s+(?:originally\s+)?from\s+([A-Z][A-Za-z]+)/g, group: 1 },
  { re: new RegExp(`\\byou(?:'|’)?re\\s+(?:a|an)\\s+${ADJ}(${D}|${O})\\b`, "gi"), group: 1 },
  { re: new RegExp(`\\byou\\s+are\\s+(?:a|an)\\s+${ADJ}(${D}|${O})\\b`, "gi"), group: 1 },
];

export function ungroundedIdentityClaims(text: string, knownAboutThem: string): string[] {
  const known = (knownAboutThem ?? "").toLowerCase();
  const found: string[] = [];
  for (const { re, group } of CLAIMS) {
    re.lastIndex = 0;
    for (const m of (text ?? "").matchAll(re)) {
      const word = m[group].toLowerCase();
      if (!known.includes(word)) found.push(m[group]);
    }
  }
  return [...new Set(found)];
}

// Drops every sentence that makes an unsupported claim. Returns the rest, or
// null when nothing is left.
export function stripUngroundedIdentity(text: string, knownAboutThem: string): string | null {
  const t = (text ?? "").trim();
  if (!ungroundedIdentityClaims(t, knownAboutThem).length) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [t];
  const kept = sentences.filter((s) => !ungroundedIdentityClaims(s, knownAboutThem).length).join("").trim();
  return kept || null;
}

export const IDENTITY_RULE =
  "Never say what the person is (nationality, where they're from, gender, whether they're a parent, veteran or immigrant) unless it is written in what you were given about them. An event or post being aimed at a group (French founders, women in tech) does not mean they belong to it: say who it is for without saying they are one.";
