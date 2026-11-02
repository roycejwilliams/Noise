// How much of the text thread a reply reads (routes/sendblue.ts). Counted in their texts, not in rows (2026-11-02, a member's thread
// on dev): every one of Cue's bubbles is its own row, so the old 20-row window ("10 turns' worth", 2026-09-01) held a median of 4 of
// their texts over 785 turns in the last 30 days, and one six-bubble answer pushed out the news and feedback they had given three
// texts earlier. Cue then asked for that feedback again.
// Their last WINDOW_THEIR_TEXTS texts and everything Cue said between them, plus the lines of Cue's that the oldest one answered,
// newest first until WINDOW_CHARS, never more than WINDOW_MAX_ROWS rows. Their own texts are never cut: a long one that doesn't fit
// drops the older rows instead. Only Cue's long rows (a draft pasted into the thread) are cut, at a sentence end, to WINDOW_ROW_CHARS
// with a marker (review of #343: a cut mid-sentence of theirs, "he hasn' […]", could leave a quote whose tail took it back). On dev
// over the same 30 days: 1,242 characters at the median either way, p90 3,455 before and 4,984 now.
export const WINDOW_THEIR_TEXTS = 10;
export const WINDOW_MAX_ROWS = 60;
export const WINDOW_CHARS = 6_000;
export const WINDOW_ROW_CHARS = 1_200;
// What the old window was: the fallback when the guard read fails (routes/sendblue.ts), so an unguarded thread is never the longer one.
export const OLD_WINDOW_ROWS = 20;
export const TRIMMED = " [the rest of this message of Cue's is left out]";

// Pure: a row of Cue's cut to at most max characters, at the last sentence end inside it (else the last space), with the marker.
export function trimCueRow(content: string, max = WINDOW_ROW_CHARS): string {
  if (content.length <= max) return content;
  const head = content.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"), head.lastIndexOf("!\n"), head.lastIndexOf("?\n"));
  const cut = end > max / 3 ? head.slice(0, end + 1) : head.slice(0, Math.max(head.lastIndexOf(" "), max / 2)).trimEnd();
  return `${cut}${TRIMMED}`;
}

const THEIRS = /^User said:/;

// Pure: rows newest first, as the query returns them; the window oldest first. The newest row always stays, whole if it's theirs.
export function threadWindow<R extends { content: string }>(newestFirst: R[], o: { theirTexts?: number; maxRows?: number; chars?: number; rowChars?: number } = {}): R[] {
  const { theirTexts = WINDOW_THEIR_TEXTS, maxRows = WINDOW_MAX_ROWS, chars = WINDOW_CHARS, rowChars = WINDOW_ROW_CHARS } = o;
  const out: R[] = [];
  let theirs = 0;
  let used = 0;
  for (const row of newestFirst.slice(0, maxRows)) {
    const mine = THEIRS.test(row.content);
    if (mine) {
      if (theirs === theirTexts) break;
      theirs++;
    }
    const content = mine ? row.content : trimCueRow(row.content, rowChars);
    if (out.length && used + content.length > chars) break;
    used += content.length;
    out.push(content === row.content ? row : { ...row, content });
  }
  return out.reverse();
}
