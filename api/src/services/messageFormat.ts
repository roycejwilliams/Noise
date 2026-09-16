// How several real things read in one text (Royce, 2026-09-16: "if there's
// more than 1 present them correctly like how we do for the updates push").
//
// One thing: the sentence as drafted, and its link follows as its own
// message. Several: a short lead-in and one bullet each, the same shape the
// product update texts use, then every link on its own so each one previews.
export function renderMatchList(descriptions: string[]): string {
  if (descriptions.length === 1) return descriptions[0];
  const lead = descriptions.length === 2 ? "Two that fit:" : `${descriptions.length} that fit:`;
  return `${lead}\n\n${descriptions.map((d) => `• ${d}`).join("\n\n")}`;
}
