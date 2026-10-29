// Stock lines on a call (Royce, 2026-10-04: "it should never say the scripted
// things"). Measured on real transcripts: 27% of Co's lines on ElevenLabs calls
// carried one ("I hear you", "that's a lot to carry"), against 1% under Hume and
// 0 of 373 on texts. A stock line is comfort that fits any answer, so it shows
// the member was not listened to. Pure detection, shared by the post-call audit
// (logged as call.stock_lines) and the simulated-call evals.

const END = String.raw`\s*(?:[.,!;?]|$|and\b|but\b)`;
const re = (src: string) => new RegExp(src, "i");
const STOCK: RegExp[] = [
  re(String.raw`\bi hear (?:you|that)` + END),
  re(String.raw`\bi(?:'m| am) (?:so )?glad you (?:told|shared with) me\b`),
  re(String.raw`\bthank(?:s| you) for (?:sharing|opening up|trusting me)\b`),
  re(String.raw`\bthank(?:s| you) for telling me` + END),
  re(String.raw`\bthat takes (?:real )?(?:courage|strength|bravery)\b`),
  re(String.raw`\bthat sounds like it changed a lot of things\b`),
  re(String.raw`\bthat'?s a lot happening at once\b`),
  re(String.raw`\bthat'?s a real shift\b`),
  re(String.raw`\bthat(?:'s| is) a lot to (?:carry|hold|sit with|process)\b`),
  re(String.raw`\bi can only imagine\b`),
  re(String.raw`\bthat must be (?:so |really |incredibly )?(?:hard|tough|difficult|exhausting|heavy)` + END),
  re(String.raw`\bnot the polished version\b`),
  re(String.raw`\bwhat'?s actually (?:going on|happening)(?: (?:right now|with you|for you))?\s*[?.!]`),
  re(String.raw`\bwhere you'?re at right now` + END),
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

// Pure: a sentence that is nothing but a stock phrase ("And I hear you.", "I hear that."), not a question, the kind the voice can drop without losing
// anything said (2026-10-08 call eval, safety_hint: "And I hear you." mid-reply). A sentence that goes on to say something
// specific is kept: the model's words, not the check's, decide what the member hears.
export function stockSentence(sentence: string): boolean {
  const t = norm(sentence).replace(/\[[a-z ]+\]\s*/gi, "").trim();
  // A question is never dropped: it may be the turn's only one (review of #112: "What's actually going on with you?").
  if (/\?["')\]]*$/.test(t)) return false;
  const phrase = stockLine(t);
  if (!phrase) return false;
  // Nothing may be left but a leading "and"/"but"/"yeah": "I hear you, but no." keeps its "no".
  const rest = t.toLowerCase().replace(phrase, " ").replace(/^[^a-z']*(?:(?:and|but|yeah|okay|ok|so)\b[^a-z']*)*/, "").replace(/[^a-z']+/g, " ").trim();
  return rest === "";
}

// Pure: a text reply without its stock-only sentences (Royce, 2026-10-28: "I hear you" and "Makes sense" reached his texts once the
// filter existed only for calls). The same rule as a call: only a sentence that is nothing but a stock phrase is dropped, never a
// question, never a sentence that goes on to say something. If every sentence is stock, the reply is left as it was, so they're never
// left with nothing. Paragraph breaks are kept.
// Texts only: a sentence that is nothing but "Makes sense." (or "That makes sense.", "Yeah, totally makes sense."), agreement that fits
// any answer (Royce's text, 2026-10-28: "I was honestly burnt out before" got "Makes sense. Glad you got the break..."). Not in the call
// list above: a call's "That makes sense." is left to the call's own rules (evals/calls/llmProxy.ts times its first sentence on it).
const BARE_MAKES_SENSE = /^(?:(?:and|but|yeah|okay|ok|so)\b[\s,]*)*(?:that |it |totally |that totally )?makes (?:total |complete |a lot of )?sense\s*[.!]*["')\]]*$/i;
export function textStockSentence(sentence: string): boolean {
  const t = norm(sentence).trim();
  return stockSentence(t) || BARE_MAKES_SENSE.test(t);
}
const TEXT_SENTENCE = /[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g;
export function dropStockSentences(text: string): string {
  const parts = text.split(/(\n+)/);
  let dropped = false;
  const kept = parts.map((p) => {
    if (/^\n+$/.test(p) || !p.trim()) return p;
    const sentences = p.match(TEXT_SENTENCE) ?? [p];
    const keep = sentences.filter((x) => !textStockSentence(x.trim()));
    if (keep.length !== sentences.length) dropped = true;
    return keep.join("").trim();
  });
  if (!dropped) return text;
  const out = kept.join("").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "").trim();
  return out || text;
}

export function stockReport(lines: string[]): { stock: { line: string; phrase: string }[]; repeated: string[] } {
  const stock = lines.flatMap((line) => { const phrase = stockLine(line); return phrase ? [{ line, phrase }] : []; });
  return { stock, repeated: repeatedOpeners(lines) };
}

// Pure: Co's lines from a stored transcript ("assistant: ..." / "Co: ...").
// A line with no speaker label continues the turn before it.
export function coLinesOf(transcript: string): string[] {
  const out: string[] = [];
  let inCo = false;
  for (const l of transcript.split("\n")) {
    const m = l.match(/^(\w+):\s*(.*)$/);
    if (m && /^(?:assistant|co|cue|user|caller|member|human)$/i.test(m[1])) {
      inCo = /^(?:assistant|co|cue)$/i.test(m[1]);
      if (inCo && m[2].trim()) out.push(m[2].trim());
    } else if (inCo && l.trim()) out[out.length - 1] = `${out[out.length - 1] ?? ""} ${l.trim()}`.trim();
  }
  return out;
}

// What the call prompt carries. Described, never quoted: a quoted bad example gets
// parroted (the texting eval, 2026-10-02).
export const VARIETY_GUIDE = `Never sound scripted. Answer what this person just said, in words that could only follow it. A sentence that would fit after any answer is a stock sentence: comfort that sums up how heavy things are, gratitude for their opening up, praise for their honesty, a claim that you can only guess, a line that names the size of what happened. Don't say those. Instead say something specific back (a detail they gave, a name, a number, what it changes for them) or ask the one question that follows from it. Don't open two replies in a row the same way, and don't reuse a phrase you already said earlier in this call (the discretion lines above are the one exception).`;
