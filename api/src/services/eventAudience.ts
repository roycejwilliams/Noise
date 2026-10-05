// Who an event is for (Royce, 2026-10-05: Co sent a man "HOT GIRL HIKE"; and
// "it could work for someone else, especially a woman using our product, I
// wouldn't want it to be shielded"). So nothing is held back for anyone. The
// event's audience is a plain fact Co can see and say, and what Co knows about
// a member comes only from their own words, never from a name, a voice or a guess.
//
// Co judges the audience itself when it keeps an event in the sweep (the `keep`
// tool's audience field) and when it reads results in a reply. Code adds one
// literal fact it can't miss: the words the page uses to address its guests.
// That fact never blocks a send; it makes the offer say who it is for.

// The words an event page uses to speak to its guests, found literally in its own
// name and text: "see you on the trail, girls", "ladies night", "men's group".
// Plural and vocative forms only: "Gone Girl" and "Men in Black" are titles, "see you on the trail, girls" is an address.
const ADDRESSED_AS = /\b(girls|gals|ladies|women(?:'s)?|womxn|queens|moms|mamas|boys|guys|gentlemen|men(?:'s)?|dudes|bros|dads|fellas)\b/gi;

// Pure: the audience words an event's own name and page use, lowercased, in order, once each.
export function addressedAs(name: string, description: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of `${name}\n${description ?? ""}`.matchAll(ADDRESSED_AS)) {
    const w = m[1].toLowerCase().replace(/'s$/, "");
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// Pure: the line Co reads with the event, or null when the page names no group.
export function audienceLine(name: string, description: string | null | undefined): string | null {
  const words = addressedAs(name, description);
  if (!words.length) return null;
  return `Who it's for: the page speaks to its guests as "${words.join('", "')}". That may mean it is meant for a particular group. Co does not know whether this member is in it unless they have said so in their own words, and never guesses from a name, a voice or anything else.`;
}

// Pure: words a text should use to say who an event is for, from Co's judgment of
// the audience (a short phrase like "women") or the words the page uses.
// Co's own judgment, plus the words the page's description addresses its guests with (the
// name alone never forces a note: a title can say "girl" or "men" and be for everyone).
export function audienceTokens(audience: string | null | undefined, _name: string, description: string | null | undefined): string[] {
  const own = (audience ?? "").toLowerCase().split(/[^a-z']+/).map((w) => w.replace(/'s$/, "")).filter((w) => w.length >= 3 && !["for", "the", "and", "only", "who", "open", "all"].includes(w));
  return [...new Set([...own, ...addressedAs("", description)])];
}

// Co's judgment of the audience: anything but open to everyone.
export function isGroupAimed(audience: string | null | undefined): boolean {
  const a = (audience ?? "").trim().toLowerCase();
  return !!a && !/^(open|everyone|all|anyone|none|n\/a|no one in particular)\b/.test(a);
}

// Pure: every way a text could fairly say who an event is for, given the audience words.
// "girls" on the page can be said back as "women" or "women's", and the reverse.
const SAYINGS: { match: RegExp; says: string[] }[] = [
  { match: /^(girls?|gals?|ladies|lady|women|woman|womxn|queens?)$/, says: ["women", "woman", "women's", "girls", "ladies", "gals", "female"] },
  { match: /^(boys?|guys?|men|man|dudes?|bros?|gentlemen|fellas?)$/, says: ["men", "man", "men's", "guys", "gentlemen", "male"] },
  { match: /^(moms?|mamas?|mothers?)$/, says: ["moms", "mom", "mothers", "mamas", "parents"] },
  { match: /^(dads?|fathers?)$/, says: ["dads", "dad", "fathers", "parents"] },
];
export function audienceSayings(words: string[]): string[] {
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    out.add(w.endsWith("s") ? w.slice(0, -1) : `${w}s`);
    for (const f of SAYINGS) if (f.match.test(w)) f.says.forEach((x) => out.add(x));
  }
  return [...out].filter((x) => x.length >= 3);
}
