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

// Where a result actually came from, in plain words (Royce, 2026-09-16:
// "How don't you have a registration link when it's on Luma?" — the result
// was a post on X that mentioned Luma, and Co never said so).
export function sourceOf(match: { kind?: string; tier?: number; url?: string }): string {
  if (match.kind === "opportunity") return "a post on X";
  if (match.kind === "co_event") return "Co's own Luma calendar";
  if (match.url?.includes("lu.ma")) return "its Luma event page";
  return "a public event listing";
}
