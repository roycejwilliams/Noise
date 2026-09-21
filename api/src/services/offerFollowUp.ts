// Event and opening offers go out as a link, then a description, for every tier
// that has something (2026-09-21, Royce: "it should always surface the 3 tiers
// if they are available"). The descriptions don't end with a question; one
// follow-up text after the last of them asks if any interest the member.
// Kept free of imports so the harness and the drafting agent can both use it.

export const OFFER_FOLLOWUP_MANY = [
  "Do any of these interest you?",
  "Does anything here catch your eye?",
  "Any of these sound like your kind of thing?",
];

export const OFFER_FOLLOWUP_ONE = [
  "Does that one interest you?",
  "Is that one your kind of thing?",
  "Does that sound like something you'd want to go to?",
];

export function offerFollowUp(count: number, rng: () => number = Math.random): string {
  const lines = count > 1 ? OFFER_FOLLOWUP_MANY : OFFER_FOLLOWUP_ONE;
  return lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))];
}

// The follow-up carries the question, so a description that ends by asking one
// ("Want me to grab you a spot?", "Want this on your radar?") loses that last
// sentence. A description that is only a question is kept as is.
export function stripClosingQuestion(text: string): string {
  const t = (text ?? "").trim();
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [t];
  if (sentences.length < 2) return t;
  const last = sentences[sentences.length - 1].trim();
  if (!last.endsWith("?")) return t;
  return sentences.slice(0, -1).join("").trim();
}
