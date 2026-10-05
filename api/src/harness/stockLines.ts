// Stock lines on a call (Royce, 2026-10-04: "it should never say the scripted
// things"). Measured on real transcripts: 27% of Co's lines on ElevenLabs calls
// carried one ("I hear you", "that's a lot to carry"), against 1% under Hume and
// 0 of 373 on texts. A stock line is comfort that fits any answer, so it shows
// the member was not listened to. Pure detection, shared by the post-call audit
// (logged as call.stock_lines) and the simulated-call evals.

const STOCK: RegExp[] = [
  /\bi hear (?:you|that)\b/i,
  /\bi(?:'m| am) (?:so )?glad you (?:told|shared with) me\b/i,
  /\bthank(?:s| you) for (?:sharing|telling me|opening up|trusting me)/i,
  /\bthat takes (?:real )?(?:courage|strength|bravery)\b/i,
  /\bthat sounds like it changed a lot of things\b/i,
  /\bthat'?s a lot happening at once\b/i,
  /\bthat'?s a real shift\b/i,
  /\bthat(?:'s| is) a lot to (?:carry|hold|sit with|process)\b/i,
  /\bi can only imagine\b/i,
  /\bthat must be (?:so |really |incredibly )?(?:hard|tough|difficult|exhausting|heavy)\b/i,
  /\bnot the polished version\b/i,
  /\bwhat'?s actually (?:going on|happening)\b/i,
  /\bwhere you'?re at right now\b/i,
];

const norm = (s: string) => s.replace(/[’‘]/g, "'");

// Pure: the stock phrase a line contains, or null.
export function stockLine(line: string): string | null {
  const t = norm(line);
  for (const re of STOCK) {
    const m = t.match(re);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

const openerOf = (line: string) => norm(line).toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ");

// Pure: the same first three words opening 3 or more of Co's lines in one call.
export function repeatedOpeners(lines: string[]): string[] {
  const n = new Map<string, number>();
  for (const l of lines) {
    const o = openerOf(l);
    if (o.split(" ").length === 3) n.set(o, (n.get(o) ?? 0) + 1);
  }
  return [...n].filter(([, c]) => c >= 3).map(([o]) => o);
}

export function stockReport(lines: string[]): { stock: { line: string; phrase: string }[]; repeated: string[] } {
  const stock = lines.flatMap((line) => { const phrase = stockLine(line); return phrase ? [{ line, phrase }] : []; });
  return { stock, repeated: repeatedOpeners(lines) };
}

// Pure: Co's lines from a stored transcript ("assistant: ..." / "Co: ...").
export function coLinesOf(transcript: string): string[] {
  return transcript.split("\n").map((l) => l.match(/^(?:assistant|co):\s*(.+)$/i)?.[1]?.trim() ?? "").filter(Boolean);
}

// What the call prompt carries. Described, never quoted: a quoted bad example gets
// parroted (the texting eval, 2026-10-02).
export const VARIETY_GUIDE = `Never sound scripted. Answer what this person just said, in words that could only follow it. A sentence that would fit after any answer is a stock sentence: comfort that sums up how heavy things are, gratitude for their opening up, praise for their honesty, a claim that you can only guess, a line that names the size of what happened. Don't say those. Instead say something specific back (a detail they gave, a name, a number, what it changes for them) or ask the one question that follows from it. Don't open two replies in a row the same way, and don't reuse a phrase you already said earlier in this call.`;
