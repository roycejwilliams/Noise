// How several real things arrive (Royce, 2026-09-16, choosing the layout:
// "Paired: item then its link"). One thing is just its own message with the
// link under it. Several get a one-line heads-up, then each one as its own
// message with its own link right below it, so every preview sits under the
// thing it belongs to instead of stacking at the end.
const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five"];

export function renderMatchLead(count: number): string {
  const word = COUNT_WORDS[count] ?? String(count);
  return `${word} that fit, sending ${count === 2 ? "both" : "them"} now.`;
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
