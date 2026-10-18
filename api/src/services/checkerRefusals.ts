// Every refusal a file checker makes is logged with a short reason (Royce, 2026-10-18: "log a short reason for every refusal, so I can
// tell a right refusal from a wrong one without replaying anything"). One row in harness_decisions per refusal: the checker as the
// decision, outcome skip, action "refused", and a one-line reason.
//
// The row carries NO member text (forget by default: when a member removes something, its raw lines are deleted, and a log must not
// keep a copy). Each refused line is named by its position on the file ("slide 3 headline", "section 2 bullet 1", "suggestion 1")
// and the kind of problem ("a name not in their words", "an unbacked number", "a third-party claim"), never by quoting it. What the
// writer is told can still quote the line: that goes to the writer, not the log. What the checker had on file is counts only.
import type { HarnessDecision, Layer } from "../harness/core.js";
import { recordSeen, type MemberRecord } from "./memberRecord.js";

export const REASON_CHARS = 600;

// A line on the file and where it sits. The text is used only to place a problem, never logged.
export type Placed = { where: string; text: string };

// Pure: where each line of a deck sits.
export function deckPositions(d: { title?: string; subtitle?: string; slides?: { headline?: string; bullets?: string[]; notes?: string | null }[] } | null | undefined): Placed[] {
  if (!d) return [];
  const out: Placed[] = [{ where: "title", text: d.title ?? "" }, { where: "subtitle", text: d.subtitle ?? "" }];
  (d.slides ?? []).forEach((s, i) => {
    out.push({ where: `slide ${i + 2} headline`, text: s.headline ?? "" });
    (s.bullets ?? []).forEach((b, k) => out.push({ where: `slide ${i + 2} bullet ${k + 1}`, text: b }));
    if (s.notes) out.push({ where: `slide ${i + 2} notes`, text: s.notes });
  });
  return out.filter((p) => p.text.trim());
}

// Pure: where each line of a page sits (coPages/grounding.ts pageLines gives the block, numbered here by its line in the block).
export function pagePositions(lines: { where: string; text: string }[]): Placed[] {
  const n = new Map<string, number>();
  return lines.map((l) => {
    if (!/^section \d+$/.test(l.where)) return l;
    const k = (n.get(l.where) ?? 0) + 1;
    n.set(l.where, k);
    return { where: `${l.where} line ${k}`, text: l.text };
  });
}

// Pure: where each line of a document sits.
export function docPositions(doc: { title?: string; note?: string; sections?: { heading?: string | null; paragraphs?: string[]; bullets?: string[] }[]; suggestions?: string[] } | null | undefined): Placed[] {
  if (!doc) return [];
  const out: Placed[] = [{ where: "title", text: doc.title ?? "" }, { where: "note", text: doc.note ?? "" }];
  (doc.sections ?? []).forEach((s, i) => {
    if (s.heading) out.push({ where: `section ${i + 1} heading`, text: s.heading });
    (s.paragraphs ?? []).forEach((p, k) => out.push({ where: `section ${i + 1} paragraph ${k + 1}`, text: p }));
    (s.bullets ?? []).forEach((b, k) => out.push({ where: `section ${i + 1} bullet ${k + 1}`, text: b }));
  });
  (doc.suggestions ?? []).forEach((x, k) => out.push({ where: `suggestion ${k + 1}`, text: x }));
  return out.filter((p) => p.text.trim());
}

const timeLike = (s: string) => /^\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*$/i.test(s);
const numberLike = (s: string) => /\d/.test(s) || /^(?:first|second|third|twice|double|half|several|both|[a-z]+teen|[a-z]+ty|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)$/i.test(s.trim());
const itemsOf = (s: string) => s.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
const mentionKind = (list: string) => {
  const items = itemsOf(list);
  if (items.length && items.every(timeLike)) return "an unbacked time";
  if (items.length && items.every(numberLike)) return "an unbacked number";
  if (items.some((x) => timeLike(x) || numberLike(x))) return "a name and a number or time not in their words";
  return "a name not in their words";
};
// The judge's own kind for a line backed only by something they said long ago, about something that changes (coPages/deckClaims.ts
// EXCERPT_RULES "stale"): not a pass and not invented. G (#243) turns it into its one question to the member.
export const OLD_FACT = "an old fact that may have changed";
// The kind of hard fact a judge named, read from its own reason, which is never logged.
export function judgedKind(why: string): string {
  const w = why.toLowerCase();
  if (/partner|sponsor|deal|confirm|signed|agreed|invest|backer|backed|funded|fund|co-?host|customer|client/.test(w)) return "a third-party claim";
  if (/market|industry|trend|demand|world/.test(w)) return "a market claim";
  if (/\b(?:date|day|month|year|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(w)) return "an unbacked date";
  if (/\bcount\b|how many|users|members|attendees|guests/.test(w)) return "an unbacked count";
  if (/\$|\d|%|percent|price|number|metric|figure|revenue/.test(w)) return "an unbacked number";
  if (/name|person|company|event/.test(w)) return "a name not in their words";
  if (/result|award|won|proven|tested/.test(w)) return "an unbacked result";
  return "a hard fact they never gave";
}

// Pure: one problem as its kind, from the checkers' own wording (coPages/grounding.ts, documentSheet.ts, documentClaims.ts,
// researchBrief.ts, store.ts). Never the problem's text.
export function problemKind(p: string): string {
  const names = p.match(/\bnames (.+?), which they never said/);
  if (names) return mentionKind(names[1]);
  const gave = p.match(/it has (.+?), which they never gave/);
  if (gave) return mentionKind(gave[1]).replace("not in their words", "they never gave");
  if (/placeholder/.test(p)) return "a placeholder";
  if (/isn't backed by what they said|their words never put/.test(p)) return "a claim not in their words";
  if (/isn't something they said \(/.test(p)) return "a claim the judge read as added";
  if (/opens on .*, which they never said/.test(p)) return "an opening word not in their words (judge unavailable)";
  if (/aren't theirs|no longer saved/.test(p)) return "an image not theirs";
  if (/too thin|too long|needs a title|nothing in it|paragraph runs|no bullets|only repeat their headings/.test(p)) return "the document's shape";
  if (/source link|time it was checked|general reader|free text|source and check time|isn't a sourced field|researched option/.test(p)) return "a research section's sourcing";
  if (/needs at least|required|must be|is not one of|invalid|expected/i.test(p)) return "the file's shape";
  return "another check";
}

// Pure: where a problem sits: the position it opens with ("slide 3 headline: ..."), else the line its quote comes from, else unplaced.
export function problemWhere(p: string, lines: Placed[] = []): string {
  const lead = p.match(/^(slide \d+(?: headline| notes| place)?|section \d+(?: heading| place)?|title|subtitle|context|place|sources)\s*:/);
  if (lead) {
    // A page's "section 2:" is a block: the quote names its line.
    if (/^section \d+$/.test(lead[1])) {
      const q = quoted(p);
      const hit = q ? lines.find((l) => l.where.startsWith(`${lead[1]} `) && l.text.includes(q)) : null;
      if (hit) return hit.where;
    }
    // A deck's "slide 3:" is a bullet: the quote names which.
    if (/^slide \d+$/.test(lead[1])) {
      const q = quoted(p);
      const hit = q ? lines.find((l) => l.where.startsWith(`${lead[1]} bullet`) && l.text.includes(q)) : null;
      if (hit) return hit.where;
    }
    return lead[1];
  }
  const q = quoted(p);
  if (q) {
    const hit = lines.find((l) => l.text.includes(q)) ?? lines.find((l) => q.includes(l.text.slice(0, 40)) && l.text.length >= 8);
    if (hit) return /^the suggestion /.test(p) && !hit.where.startsWith("suggestion") ? "a suggestion" : hit.where;
  }
  return "the file";
}
// The start of the first quoted line in a problem (problems cut their quote at 60 to 90 characters), for placing only.
function quoted(p: string): string | null {
  const m = p.match(/"([^"]{4,})/);
  if (!m) return null;
  const q = m[1].replace(/^then /, "").replace(/\.\.\.$/, "");
  return q.slice(0, Math.min(40, q.length));
}

export type RefusalPart = { at: string; kind: string };
// Pure: the problems as positions and kinds, the only thing logged.
export const refusalParts = (problems: string[], lines: Placed[] = []): RefusalPart[] => problems.filter((p) => p.trim()).map((p) => ({ at: problemWhere(p, lines), kind: problemKind(p) }));

// Pure: the one-line reason, from positions and kinds only.
export function refusalReason(parts: RefusalPart[]): string {
  if (!parts.length) return "refused (no reason given)";
  const line = `${parts.length === 1 ? "1 problem" : `${parts.length} problems`}: ${parts.map((x) => `${x.at}: ${x.kind}`).join(" | ")}`;
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 3)}...` : line;
}

// Pure: the row. extra must be ids, counts and labels, never member text.
export function refusalRow(o: { checker: string; userId: string; problems: string[]; lines?: Placed[]; layer?: Layer; member?: MemberRecord | null; extra?: Record<string, string | number | boolean | null> }): HarnessDecision {
  const parts = refusalParts(o.problems, o.lines ?? []).slice(0, 12);
  return {
    layer: o.layer ?? 3,
    decision: o.checker,
    userId: o.userId,
    outcome: "skip",
    action: "refused",
    reason: refusalReason(parts),
    proposal: { refused: parts, saw: recordSeen(o.member), ...(o.extra ?? {}) },
  };
}

// Logged, never thrown: a refusal is still a refusal when its log row can't be written.
export async function logRefusal(o: Parameters<typeof refusalRow>[0], log?: (d: HarnessDecision) => Promise<unknown>): Promise<void> {
  try {
    const write = log ?? (await import("../harness/core.js")).recordDecision;
    await write(refusalRow(o));
  } catch (err: any) {
    console.error(`logRefusal(${o.checker}) failed (non-fatal):`, err?.message ?? err);
  }
}
