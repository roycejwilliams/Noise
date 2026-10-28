// One reading of the name a member gives for someone they met (review of #294, 2026-10-28). The guest-list lookup
// (eventGuestMatchHandoff.ts resolveNamedEventGuest) and the guard's once-per-person key (agent/toolGuard.ts personKey) both read
// names through this, so they agree on who a name is: "Mary-Kate Olsen" and "Mary-Kate" + "Olsen" are one person, Mary-Ann Olsen
// is another. Pure, no imports beyond the punctuation fold, so the guard can use it without loading the intro machinery.
import { plainPunctuation } from "./safetyText.js";

// Apostrophe and dash look-alikes first (plainPunctuation): an iPhone types "O’Brien" with a curly apostrophe, which folded to a
// space and never matched a stored "O'Brien". Then accents off, lowercase, anything but letters, apostrophes, spaces and hyphens
// to a space.
export const foldName = (s: unknown): string =>
  plainPunctuation(String(s ?? ""))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The first word of what they called the person, and the last name: the one they gave, or else the rest of the name.
export function guestName(nameGuess: unknown, lastNameGuess?: unknown): { first: string; last: string } {
  const parts = foldName(nameGuess).split(" ").filter(Boolean);
  return { first: parts[0] ?? "", last: foldName(lastNameGuess ?? "") || parts.slice(1).join(" ") };
}
