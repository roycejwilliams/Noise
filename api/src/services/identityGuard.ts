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
// Never a function word ("as a reminder the man…", "a husband and wife team").
const ADJ = "(?:(?!(?:the|and|or|a|an|my|our|your|their|his|her|its|this|that|of|at|in|on|for|to|with)\\b)[a-z][\\w'’-]*\\s+){0,2}";
// "as a …" is a claim only when the word ends the phrase ("as a new dad, you…", "as a mom you…", "as a father of two"), never when
// it describes a thing ("as a quiet French bistro", "as a great Italian spot"). A hyphen after it is never one ("woman-led").
const ENDS = "(?![\\w-])(?=\\s*(?:[,.;:!?]|$|you\\b|and\\s+(?:a|an)\\s|of\\s+(?:two|three|four|five|\\d)))";
const NOHYPHEN = "(?![\\w-])";
const CLAIMS: { re: RegExp; group: number }[] = [
  { re: new RegExp(`\\byou(?:'|’)?re\\s+(?:a\\s+|an\\s+|also\\s+|fellow\\s+|actually\\s+)*(${D})${NOHYPHEN}`, "gi"), group: 1 },
  { re: new RegExp(`\\byou\\s+are\\s+(?:a\\s+|an\\s+|also\\s+|fellow\\s+)*(${D})${NOHYPHEN}`, "gi"), group: 1 },
  // Where "as a …" sits decides it (review of #145): opening a sentence or clause and said to them ("As a French founder, you'd…",
  // "As a mom who loves jazz, you…"), or ending the phrase; or after "you" ("for you as a new dad"). Mid-sentence after a verb it
  // describes a place ("pitched as a new Italian", "as a quiet French bistro") and is never a claim about them.
  { re: new RegExp(`(?<=^|[.!?;:,\\n]\\s*)(?:as|being)\\s+(?:a|an)\\s+${ADJ}(${D}|${O})(?![\\w])(?=\\s+you\\b|[^.!?,;]*,\\s*you\\b)`, "gi"), group: 1 },
  { re: new RegExp(`(?<=^|[.!?;:,\\n]\\s*)(?:as|being)\\s+(?:a|an)\\s+${ADJ}(${D}|${O})${ENDS}`, "gi"), group: 1 },
  { re: new RegExp(`\\byou\\b[^.!?]{0,40}?\\b(?:as|being)\\s+(?:a|an)\\s+${ADJ}(${D}|${O})${ENDS}`, "gi"), group: 1 },
  { re: new RegExp(`\\b(?:as|being)\\s+(${D}|${O})s${ENDS}`, "gi"), group: 1 },
  // "dads like you", "a new mom like yourself", "for women like you": the same claim, said sideways.
  { re: new RegExp(`\\b(${D}|${O}|women|men)s?\\s+like\\s+(?:you|yourself)\\b`, "gi"), group: 1 },
  { re: /\byou(?:'|’)?re\s+(?:originally\s+)?from\s+([A-Z][A-Za-z]+)/g, group: 1 },
  { re: new RegExp(`\\byou(?:'|’)?re\\s+(?:a|an)\\s+${ADJ}(${D}|${O})${NOHYPHEN}`, "gi"), group: 1 },
  { re: new RegExp(`\\byou\\s+are\\s+(?:a|an)\\s+${ADJ}(${D}|${O})${NOHYPHEN}`, "gi"), group: 1 },
];

export function ungroundedIdentityClaims(text: string, knownAboutThem: string): string[] {
  const known = (knownAboutThem ?? "").toLowerCase();
  const found: string[] = [];
  for (const { re, group } of CLAIMS) {
    re.lastIndex = 0;
    for (const m of (text ?? "").matchAll(re)) {
      const word = m[group].toLowerCase().replace(/^women$/, "woman").replace(/^men$/, "man");
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
