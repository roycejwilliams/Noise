// How much of the text thread a reply reads (routes/sendblue.ts). Counted in their texts, not in rows (2026-11-02, a founder's thread
// on dev): every one of Cue's bubbles is its own row, so the old 20-row window ("10 turns' worth", 2026-09-01) held a median of 4 of
// their texts over 785 turns in the last 30 days, and one six-bubble answer pushed out the news and feedback they had given three
// texts earlier. Cue then asked for that feedback again, and summed up "my issue" without the meeting it was about.
// Their last WINDOW_THEIR_TEXTS texts and everything Cue said between them, plus the lines of Cue's that the oldest one answered,
// never more than WINDOW_MAX_ROWS rows.
export const WINDOW_THEIR_TEXTS = 10;
export const WINDOW_MAX_ROWS = 60;

const THEIRS = /^User said:/;

// Pure: rows newest first, as the query returns them; the window oldest first.
export function threadWindow<R extends { content: string }>(newestFirst: R[], theirTexts = WINDOW_THEIR_TEXTS, maxRows = WINDOW_MAX_ROWS): R[] {
  const out: R[] = [];
  let theirs = 0;
  for (const row of newestFirst.slice(0, maxRows)) {
    if (THEIRS.test(row.content)) {
      if (theirs === theirTexts) break;
      theirs++;
    }
    out.push(row);
  }
  return out.reverse();
}
