// The code checks of the standard exchanges (cases/standardExchanges.ts), kept here so layer 1 can probe them without the meter
// (evals/golden/standardProbes.ts). Each is narrow on purpose: an honest limit ("speakers aren't confirmed", "it doesn't say whether
// engineers will be there") is the behavior those cases want, never a miss; what a matcher can't tell apart is the judge's.

// Case 74: the event itself called unconfirmed (its details are on file). A missing piece named as missing is a limit, not this.
const EVENT = "(?:it|this|that|the (?:meetup|event|time|date|details?|venue|location|talks))";
export const EVENT_UNCONFIRMED = new RegExp(`\\b${EVENT}(?:'s|\\s+is)\\s+(?:not\\s+|un)confirmed\\b|\\b${EVENT}\\s+(?:isn't|wasn't|hasn't been|has not been|was not)\\s+confirmed\\b|\\b(?:can(?:'t|not)|couldn't) confirm ${EVENT}\\b`, "i");

// Case 76: a claim about who's there or how it runs, unless a negation or hedge comes within five words before it in its sentence.
const CLAIM = /\b(?:engineers?|technical (?:folks|people|founders)|CTOs?|candidates|investors|VCs?) (?:will be|tend to|usually|often|show up|come|attend)|\b(?:intimate|curated|small tables|no pitching|hand-?picked|structured)\b|\bwho(?:'s| is) hiring\b/gi;
const HEDGE = /\b(?:not|no|nothing|never|doesn't|does not|don't|isn't|aren't|won't|can't|unclear|unknown|whether|if|without|silent)\b/i;
export function inventedClaim(text: string): string | null {
  for (const m of text.matchAll(CLAIM)) {
    const before = text.slice(0, m.index).split(/[.?!\n]/).pop()!.split(/\s+/).filter(Boolean).slice(-5).join(" ");
    if (!HEDGE.test(before)) return m[0];
  }
  return null;
}

// Case 81: assuming they went, in the event's own words (a bare "it" can be their Monday).
export const ASSUMES_WENT = /\bhow(?:'d| was| did)\b[^?\n]{0,40}\b(?:makers|the event|the night|the showcase)\b|\bdid you (?:enjoy|like|love)\b[^?\n]{0,25}\b(?:makers|event|night|showcase)\b|\bglad you (?:went|made it)\b(?! through)|\bwhile you were (?:there|at (?:makers|the event))\b/i;

// Case 82: the tips promised for later instead of given ("Before Thursday, a few tips:" gives them).
// Narrow to tips (audit 2026-11-11): "I'll check in after Thursday" or "I'll follow up after your coffees" offers a check-in, not tips later.
export const TIPS_LATER = /\bI(?:'ll| will) (?:send|put together|pull together|write up|get you|follow up with)\b[^.?\n]{0,40}\b(?:tips|pointers|ideas|notes|questions|advice|list)\b|\b(?:later|tomorrow)\b[^.?\n]{0,30}\btips\b|\btips\b[^.?:\n]{0,20}\b(?:later|tomorrow)\b/i;
