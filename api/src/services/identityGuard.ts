// Co must not tell someone what they are unless they told it so (2026-09-21):
// a search reply said "Given you're French" about an X post aimed at French
// founders, and nothing in the profile says it. An event being aimed at a group
// does not put the person in it. This catches claims about who someone is
// (nationality, where they're from, gender, parent, veteran, immigrant) and
// drops the sentence unless the same word is in what Co was given about them.
// No imports, so any drafting path can use it.

const DEMONYMS = [
  "french", "american", "british", "english", "german", "indian", "chinese", "japanese", "korean", "canadian", "mexican", "brazilian",
  "italian", "spanish", "russian", "israeli", "irish", "australian", "dutch", "swiss", "swedish", "nigerian", "kenyan", "turkish",
  "iranian", "vietnamese", "filipino", "pakistani", "colombian", "argentinian", "polish", "ukrainian", "greek", "portuguese", "egyptian",
  "african", "asian", "european", "latino", "latina", "hispanic", "jewish", "muslim", "christian", "catholic", "immigrant", "veteran",
];
const OTHER = ["woman", "man", "mom", "mother", "dad", "father", "parent", "student"];

const D = DEMONYMS.join("|");
const O = OTHER.join("|");
const CLAIMS: { re: RegExp; group: number }[] = [
  { re: new RegExp(`\\byou(?:'|’)?re\\s+(?:a\\s+|an\\s+|also\\s+|fellow\\s+|actually\\s+)*(${D})\\b`, "gi"), group: 1 },
  { re: new RegExp(`\\byou\\s+are\\s+(?:a\\s+|an\\s+|also\\s+|fellow\\s+)*(${D})\\b`, "gi"), group: 1 },
  { re: new RegExp(`\\b(?:as|being)\\s+(?:a|an)\\s+(${D}|${O})\\b`, "gi"), group: 1 },
  { re: /\byou(?:'|’)?re\s+(?:originally\s+)?from\s+([A-Z][A-Za-z]+)/g, group: 1 },
  { re: new RegExp(`\\byou(?:'|’)?re\\s+a\\s+(${O})\\b`, "gi"), group: 1 },
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
