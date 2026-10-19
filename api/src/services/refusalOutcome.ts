// No refusal ends in silence (Royce, 2026-10-18). When a checker refuses a file Cue made for a member (a deck, a page, a doc, a task's
// document), rightly or wrongly, the member still gets one useful text. The writer gets ONE fix attempt with the refusal's reasons
// (each refusal names the line and what's missing). A fix that passes goes as normal. One that still fails ends in exactly one of three
// lines, approved word for word on 2026-10-18 (written for a deck; a page, doc or document swaps the word):
//   1. it needs one fact that's theirs (a time, a number, a detail they own): askLine, with the one question Cue's model writes from
//      the refusal; their answer finishes the file (services/pendingFiles.ts);
//   2. it's still useful without the lines it couldn't confirm: those lines are dropped, the file is checked again, and it goes with
//      droppedLine, naming the kind of line in plain words, never the made-up fact;
//   3. the check itself couldn't run: downLine; their yes tries again.
// Refused content is never sent: a dropped file is re-checked before it goes, and the two slots (the question, the kind of line) are
// written by a small model from the refusal and held in code to their shape, with nothing from a refused line that isn't theirs.
// Logs carry place and kind only (services/checkerRefusals.ts: forget by default): never a line, the question or the slot.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { OLD_FACT, problemKind, problemWhere, type Placed } from "./checkerRefusals.js";

export type FileWord = "deck" | "page" | "doc" | "document";

// ---------------------------------------------------------------- the three lines (Approved by Royce 2026-10-18)
// question: lowercase, no question mark (the line adds it). what: "the sponsorship line".
export const askLine = (word: FileWord, question: string): string => `Before I send the ${word}, there's one thing I want to get right: ${question}? Tell me and I'll finish it.`;
export const droppedLine = (word: FileWord, what: string): string => `Here's the ${word}. I left out ${what} because I couldn't confirm it from what you've told me; say the word and I'll add it back.`;
export const downLine = (word: FileWord): string => `Your ${word} didn't go through just now, so I haven't sent it. Want me to try again?`;
// Pure: whether a text is one of the three lines (for the thread and tests).
export const isRefusalLine = (text: string): boolean => /^Before I send the (?:deck|page|doc|document), there's one thing I want to get right: .+\? Tell me and I'll finish it\.$|^Here's the (?:deck|page|doc|document)\. I left out .+ because I couldn't confirm it from what you've told me; say the word and I'll add it back\.|^Your (?:deck|page|doc|document) didn't go through just now, so I haven't sent it\. Want me to try again\?$/.test(text.trim());

// ---------------------------------------------------------------- problems, placed and kinded
// A refusal as the flow reads it: the writer-facing text (it may quote the line: it goes to the writer, never the log), where it sits
// on the file, its kind, and whether it's the check that couldn't run.
export type Problem = { text: string; at: string; kind: string; down?: boolean };
export const DOWN_KIND = "the check couldn't run";
// Pure: a checker's problems as Problems (the kinds are checkerRefusals.ts's, read from the checkers' own wording).
// A time the word checks split into parts ("7:30 PM" read as "7, 30, pm", or "PM" as a name): still one time of theirs to give.
const AMPM = /^(?:a\.?m\.?|p\.?m\.?)$/i;
const TIMEISH = /^\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?$/i;
function readKind(t: string): string {
  const kind = problemKind(t);
  if (!/a name and a number or time/.test(kind)) return kind;
  const m = t.match(/\bnames (.+?), which they never|it has (.+?), which they never gave/);
  const items = (m?.[1] ?? m?.[2] ?? "").split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
  if (!items.length || !items.every((x) => AMPM.test(x) || TIMEISH.test(x) || /^\d+$/.test(x))) return kind;
  return items.some((x) => AMPM.test(x) || /:|[ap]m$/i.test(x)) ? "an unbacked time" : "an unbacked number";
}
export function asProblems(texts: string[], lines: Placed[] = []): Problem[] {
  return texts.filter((t) => t.trim()).map((t) => {
    const kind = readKind(t);
    const down = /judge unavailable/.test(kind) || /couldn't run/.test(t);
    return { text: t, at: problemWhere(t, lines), kind: down ? DOWN_KIND : kind, ...(down ? { down: true } : {}) };
  });
}
export const downProblem = (text = "the check couldn't run"): Problem => ({ text, at: "the file", kind: DOWN_KIND, down: true });

// A fact that's theirs to give: a time, a number, a date, a count, or the missing piece a placeholder stands for. A name, a partner, a
// result or a market claim isn't asked about: a line resting on one is left out (the approved example: "the sponsorship line").
// And a line the judge read as an old fact that may have changed (#251, checkerRefusals.ts OLD_FACT): what they said once, long ago,
// about something that changes. Only they know whether it still holds, so it's the one question: is it still true.
export const ASKABLE_KINDS: ReadonlySet<string> = new Set(["an unbacked time", "an unbacked number", "an unbacked date", "an unbacked count", "a placeholder", OLD_FACT]);
export const isOldFact = (p: Problem): boolean => !p.down && p.kind === OLD_FACT;
export const askable = (p: Problem): boolean => !p.down && ASKABLE_KINDS.has(p.kind);
// A line that can come off the file whole: a bullet, a page line, a paragraph, a suggestion, speaker notes, or a slide (by its
// headline) or a page section (by its heading). Never the title, subtitle, context or a place, and never a problem that isn't placed.
export const droppableAt = (at: string): boolean => /^slide \d+ (?:headline|bullet \d+|notes)$|^section \d+ (?:heading|line \d+|paragraph \d+|bullet \d+)$|^suggestion \d+$/.test(at);

// ---------------------------------------------------------------- dropping lines (pure)
type DeckIn = { title?: string; subtitle?: string; slides?: { headline: string; bullets: string[]; notes?: string | null; [k: string]: unknown }[]; [k: string]: unknown };
// Pure: the deck without the lines at those places, or null when it would no longer be a deck (fewer than 2 content slides). A refused
// headline takes its slide; a slide left with no bullets goes too. Positions are deckPositions' (slide 2 is the first content slide).
export function dropDeckLines<T extends DeckIn>(d: T, at: string[]): T | null {
  const slides = (d.slides ?? [])
    .map((s, i) => {
      const n = i + 2;
      if (at.includes(`slide ${n} headline`)) return null;
      const bullets = s.bullets.filter((_b, k) => !at.includes(`slide ${n} bullet ${k + 1}`));
      if (!bullets.length) return null;
      return { ...s, bullets, ...(at.includes(`slide ${n} notes`) ? { notes: "" } : {}) };
    })
    .filter((s): s is NonNullable<typeof s> => !!s);
  return slides.length >= 2 ? { ...d, slides } : null;
}
export const deckSize = (d: DeckIn): number => (d.slides ?? []).reduce((n, s) => n + 1 + s.bullets.length, 0);

type PageBlock = { type: string; text?: string; items?: unknown[]; options?: unknown[] };
type PageIn = { sections: { heading: string; blocks: PageBlock[]; [k: string]: unknown }[]; [k: string]: unknown };
// Pure: the page without the lines at those places (pagePositions: "section 2 line 3" is the third content line of section 2, in the
// order pageLines reads them: a text block, each bullet, each compared option, each link). A refused heading takes its section; an
// emptied block or section goes; a comparison left with one option goes. Null when no section is left.
export function dropPageLines<T extends PageIn>(p: T, at: string[]): T | null {
  const sections = p.sections
    .map((s, i) => {
      const n = i + 1;
      if (at.includes(`section ${n} heading`)) return null;
      let k = 0;
      const gone = () => at.includes(`section ${n} line ${++k}`);
      const blocks = s.blocks
        .map((b) => {
          if (b.type === "text") return gone() ? null : b;
          if (b.type === "bullets" || b.type === "links") {
            const items = (b.items ?? []).filter(() => !gone());
            return items.length ? { ...b, items } : null;
          }
          if (b.type === "comparison") {
            const options = (b.options ?? []).filter(() => !gone());
            return options.length >= 2 ? { ...b, options } : null;
          }
          return b;
        })
        .filter((b): b is PageBlock => !!b);
      return blocks.length ? { ...s, blocks } : null;
    })
    .filter((s): s is NonNullable<typeof s> => !!s);
  return sections.length ? { ...p, sections } : null;
}
export const pageSize = (p: PageIn): number => p.sections.reduce((n, s) => n + s.blocks.reduce((m, b) => m + (b.type === "text" ? 1 : (b.items ?? b.options ?? []).length), 0), 0);

type DocIn = { sections?: { heading?: string; paragraphs?: string[]; bullets?: string[] }[]; suggestions?: string[]; [k: string]: unknown };
// Pure: the document without the lines at those places (docPositions, on the document as resolveDocument shows it: the caller passes
// the input in that shape, docInputOf). An emptied section goes; null when none is left.
export function dropDocLines<T extends DocIn>(d: T, at: string[]): T | null {
  const sections = (d.sections ?? [])
    .map((s, i) => {
      const n = i + 1;
      const paragraphs = (s.paragraphs ?? []).filter((_p, k) => !at.includes(`section ${n} paragraph ${k + 1}`));
      const bullets = (s.bullets ?? []).filter((_b, k) => !at.includes(`section ${n} bullet ${k + 1}`));
      return paragraphs.length || bullets.length ? { ...s, paragraphs, bullets } : null;
    })
    .filter((s): s is NonNullable<typeof s> => !!s);
  const suggestions = (d.suggestions ?? []).filter((_x, k) => !at.includes(`suggestion ${k + 1}`));
  return sections.length ? { ...d, sections, suggestions } : null;
}
export const docSize = (d: DocIn): number => (d.sections ?? []).reduce((n, s) => n + (s.paragraphs ?? []).length + (s.bullets ?? []).length, 0) + (d.suggestions ?? []).length;
// Pure: a document's input in the shape it's shown (resolveDocument's), so positions read off the shown document fit the input.
export function docInputOf<T extends Record<string, unknown>>(input: T, doc: { title: string; note: string; sections: { heading: string | null; paragraphs: string[]; bullets: string[] }[]; suggestions: string[]; kind?: string }): T {
  return { ...input, title: doc.title, note: doc.note, sections: doc.sections.map((s) => ({ ...(s.heading ? { heading: s.heading } : {}), paragraphs: s.paragraphs, bullets: s.bullets })), suggestions: doc.suggestions, kind: doc.kind };
}

// "Most lines pass": a file is still useful without the refused lines when at least this share of its lines stays.
export const KEEP_SHARE = 0.6;

// ---------------------------------------------------------------- the two slots, written by a small model, held in code
export type SlotWriter = { ask: (prompt: string) => Promise<string>; what: (prompt: string) => Promise<string> };
const haiku = async (prompt: string, functionId: string) =>
  (await generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId }, prompt, maxOutputTokens: 200, abortSignal: AbortSignal.timeout(12_000) })).text;
const realSlots: SlotWriter = { ask: (p) => haiku(p, "refusal.ask"), what: (p) => haiku(p, "refusal.what") };

// Pure: the prompt for the one question (case 1). problems: the writer-facing refusals, which name the line and what's missing.
export function askPrompt(word: FileWord, problems: string[]): string {
  return `Cue made a member a ${word}. Before sending it, a check refused these lines, because each states something the member never told Cue:
${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Write the ONE question Cue asks the member so it can finish the ${word}: the one fact of their own these lines need (a time, a number, a date, a count, a detail they own, like when supper starts or how many guests are coming).
${problems.some((p) => /an old fact that may have changed/.test(p)) ? `A line marked "an old fact that may have changed" rests on something they told Cue long ago: ask whether it still holds, naming what it's about but never the old value or any word of it (like "is the supper still on the same schedule" or "is the funding still where it was").
` : ""}Rules:
- One question about one fact. If these lines need more than one fact, or the fact isn't theirs to give (a partner, a sponsor, a customer, an award, a result, something about the market, unless it's an old fact of theirs to confirm), return null.
- Never state or guess the answer: no numbers, times, dates or names from the refused lines, and no either/or choices.
- Plain words, at most 15 words, starting lowercase, with no question mark at the end. It is read inside: "there's one thing I want to get right: <your question>?"
Return ONLY JSON: {"question": "..."} or {"question": null}`;
}
// Pure: the prompt for the kind of line left out (case 2).
export function whatPrompt(word: FileWord, problems: string[]): string {
  return `Cue made a member a ${word} and left out these lines, because each states something the member never told Cue:
${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Name what was left out as one short plain phrase: "the", then at most four lowercase words, ending with the word "line" (for example "the sponsorship line"). It's read in: "I left out <your phrase> because I couldn't confirm it from what you've told me". One phrase covers everything left out.
Never repeat what the lines claim: no names, numbers, times or dates from them.
Return ONLY JSON: {"what": "..."}`;
}

// Pure: what a slot may never carry (review of #243: a refused fact must never ride in the question or the kind of line, whatever its
// case or place). From each refused line (the quoted line itself): every word that isn't in their words, wherever it sits (a name
// opening the line is still a name), and for an old fact that may have changed, every word of its value even if they said it once
// (the question asks whether it still holds, never restates it). From the judge's reason: every capitalized word they never used,
// after "(" too. From the code checks' own wording: what they "never said" or "never gave". Plus, in carries: any digit, and any
// number spelled out that isn't in their words.
const STOP = new Set(["the", "and", "for", "with", "from", "into", "onto", "this", "that", "these", "those", "our", "your", "their", "they", "you", "are", "was", "were", "has", "have", "had", "its", "it's", "not", "but", "all", "any", "each", "every", "per", "via", "line", "lines", "slide", "section", "still"]);
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|dozens|half|double|twice|triple)\b/gi;
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordIn = (w: string, text: string) => new RegExp(`(?<![A-Za-z0-9'-])${esc(w)}(?![A-Za-z0-9'-])`, "i").test(text);
const wordsOf = (t: string) => (t.match(/[A-Za-z][A-Za-z0-9'&-]*|\d[\d:.,]*/g) ?? []).map((w) => w.replace(/['-]+$/, ""));
export function factTokens(refused: string[], theirs: string): string[] {
  const out = new Set<string>();
  const add = (w: string, always = false) => {
    const k = w.toLowerCase();
    if (k.length < 3 || STOP.has(k)) return;
    if (always || !wordIn(k, theirs)) out.add(k);
  };
  for (const t of refused) {
    const old = /an old fact that may have changed/.test(t);
    // The refused line itself: what's in quotes.
    for (const m of t.matchAll(/"([^"]{2,})"?/g)) for (const w of wordsOf(m[1])) add(w, old);
    // The judge's reason: a capitalized word they never used is a name, wherever it sits (after "(" too).
    for (const m of t.matchAll(/\(([^)]*)\)/g)) for (const w of m[1].match(/\b[A-Z][A-Za-z0-9'&-]+\b/g) ?? []) add(w);
    // The code checks' own wording: the names, numbers and times they named.
    for (const m of t.matchAll(/\bnames (.+?), which they never|it has (.+?), which they never gave/g)) for (const x of (m[1] ?? m[2]).split(/,\s*|\s+and\s+/)) {
      if (!x.trim()) continue;
      if (!wordIn(x.trim(), theirs)) out.add(x.trim().toLowerCase());
      for (const w of wordsOf(x)) add(w);
    }
  }
  return [...out];
}
const carries = (s: string, tokens: string[], theirs = "") =>
  /\d/.test(s) || tokens.some((t) => wordIn(t, s)) || (s.match(NUMBER_WORDS) ?? []).some((n) => !wordIn(n, theirs));
const QUESTION_START = /^(?:what|what's|which|when|where|who|whose|how|is|are|do|does|did|will|would|can|could|should|has|have)\b/;
// Pure: the question as it goes in askLine, or null when it isn't one plain question about one fact, or carries a refused fact.
export function cleanQuestion(raw: unknown, tokens: string[], theirs: string): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim().replace(/[?.\s]+$/, "");
  if (!q || q.length > 140 || q.split(/\s+/).length > 18) return null;
  if (!QUESTION_START.test(q) || /[?!;:"“”—–\n]/.test(q)) return null;
  // One fact: never "X and Y", never "X or Y".
  if (/\b(?:and|or|also|plus)\b|&/i.test(q)) return null;
  // A capitalized word is only one of theirs (a name they gave); a refused fact never rides in it.
  if ((q.match(/\b[A-Z][A-Za-z'-]*\b/g) ?? []).some((w) => w !== "I" && !new RegExp(`\\b${esc(w)}\\b`).test(theirs))) return null;
  return carries(q, tokens, theirs) ? null : q;
}
// Pure: the kind of line as it goes in droppedLine, or null.
export function cleanWhat(raw: unknown, tokens: string[], theirs = ""): string | null {
  if (typeof raw !== "string") return null;
  const w = raw.trim().replace(/[.\s]+$/, "");
  if (!/^the [a-z][a-z' -]{0,40} line$/.test(w) || w.split(/\s+/).length > 6) return null;
  return carries(w, tokens, theirs) ? null : w;
}
// Pure: the words in a slot that the guards block (a refused fact, any digit, a number spelled out that isn't theirs).
export function blockedIn(s: string, tokens: string[], theirs = ""): string[] {
  const out = tokens.filter((t) => wordIn(t, s));
  if (/\d/.test(s)) out.push("any digit");
  for (const n of s.match(NUMBER_WORDS) ?? []) if (!wordIn(n, theirs)) out.push(n.toLowerCase());
  return [...new Set(out)];
}
// The slot, written once and, when only its words were blocked, once more with those words named (review of #243: "what time do
// doors open" was blocked for "doors"; the retry writes it around them). Still held by the same guards: a refused fact never rides.
async function slotTwice(write: (p: string) => Promise<string>, prompt: string, key: "question" | "what", clean: (raw: unknown) => string | null, tokens: string[], theirs: string): Promise<string | null> {
  const raw = await slotFrom(write, prompt, key);
  const first = clean(raw);
  if (first || typeof raw !== "string") return first;
  const blocked = blockedIn(raw, tokens, theirs);
  if (!blocked.length) return null;
  return clean(await slotFrom(write, `${prompt}\n\nThese words can't be in it: ${blocked.join(", ")}. Write it again without them, naming what the line is about in other words.`, key));
}
async function slotFrom(write: (p: string) => Promise<string>, prompt: string, key: "question" | "what"): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseModelJson<Record<string, unknown>>(await write(prompt));
      if (out && key in out) return out[key];
    } catch {
      /* tried twice */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- the one fix attempt
export type Fixer = (prompt: string) => Promise<string>;
const sonnet: Fixer = async (prompt) => (await generateText({ model: anthropic(MODELS.sonnet), experimental_telemetry: { isEnabled: true, functionId: "refusal.fix" }, prompt, abortSignal: AbortSignal.timeout(60_000) })).text;
// Pure: the prompt for the writer's one fix: the file as written, the refusals (each names its line and what's missing), and their
// words. The fix is to those lines only.
export function fixPrompt(word: FileWord, theirWords: string, file: unknown, problems: string[]): string {
  return `Cue wrote a member a ${word}, and a check refused some of its lines because they state something the member never said.

What the member said (their own words; the only source of facts):
"""
${theirWords.slice(-8000)}
"""

The ${word} as written, as JSON:
${JSON.stringify(file).slice(0, 12000)}

What the check refused (each names the line and what's missing):
${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Fix ONLY those lines. Write each one from what they said: the stance, not the fact ("Built for live rooms" instead of "Partnering with X"), or with the fact as they gave it when it is in their words. If a line can't be written without a fact they never gave, leave that one line out. Never put in a different made-up fact. Keep every other line exactly as it is, in the same order, and keep the same JSON shape and fields.
Return ONLY the whole ${word} as JSON.`;
}

// Tests only: the models stood in for (zero tokens).
let models: { slots: SlotWriter; fix: Fixer } = { slots: realSlots, fix: sonnet };
export function setRefusalModelsForTests(m: { slots?: SlotWriter; fix?: Fixer } | null): void {
  models = m ? { slots: m.slots ?? realSlots, fix: m.fix ?? sonnet } : { slots: realSlots, fix: sonnet };
}
export const refusalModels = () => models;
// The fix, as a parsed file of the same shape, or null when the writer's answer isn't one.
export async function fixWith<F>(word: FileWord, theirWords: string, file: unknown, problems: Problem[], parse: (raw: unknown) => F | null): Promise<F | null> {
  try {
    const raw = parseModelJson<unknown>(await models.fix(fixPrompt(word, theirWords, file, problems.map((p) => p.text))));
    return raw ? parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the flow
export type Checked<F, D> = { ok: true; file: F; data: D } | { ok: false; problems: Problem[] };
export type FlowDeps<F, D> = {
  word: FileWord;
  // The very checks the file goes through (schema, names, numbers, places, the claims judge).
  check: (f: F) => Promise<Checked<F, D>>;
  // The writer's one fix attempt; null when it already had it (a deck written from a brief is rewritten once with the refusal).
  fix: ((f: F, p: Problem[]) => Promise<F | null>) | null;
  drop: (f: F, at: string[]) => F | null;
  size: (f: F) => number;
  // Their words, for what a slot may name.
  theirs: string;
  // Finishing a file from their answer (services/pendingFiles.ts): never a second question.
  noAsk?: boolean;
  slots?: SlotWriter;
};
// How it ends: pass (send as normal), dropped (send this file with its line), ask or down (send only the line).
export type FlowEnd<F, D> =
  | { case: "pass"; file: F; data: D; trace: Trace }
  | { case: "dropped"; file: F; data: D; line: string; dropped: string[]; trace: Trace }
  | { case: "ask"; line: string; file: F; problems: Problem[]; trace: Trace }
  | { case: "down"; line: string; file: F; trace: Trace };
// What's logged of it: places and kinds, never a line or a slot.
export type Trace = { fixed: boolean; refused: { at: string; kind: string }[]; dropped?: string[]; why?: string };
const parts = (ps: Problem[]) => ps.slice(0, 12).map((p) => ({ at: p.at, kind: p.kind }));

export async function afterRefusal<F, D>(file: F, first: Problem[], d: FlowDeps<F, D>): Promise<FlowEnd<F, D>> {
  const slots = d.slots ?? models.slots;
  const down = (f: F, ps: Problem[], fixed: boolean, why: string): FlowEnd<F, D> => ({ case: "down", line: downLine(d.word), file: f, trace: { fixed, refused: parts(ps), why } });
  // A check that couldn't run isn't worth a rewrite: nothing is known about the lines.
  if (first.some((p) => p.down)) return down(file, first, false, "check down");
  let cur = file;
  let problems = first;
  let fixed = false;
  // Only old facts that may have changed (#251): no rewrite. A writer can't know whether it still holds; only they can, so it's the
  // one question.
  const onlyOld = first.length > 0 && first.every(isOldFact);
  if (d.fix && !onlyOld) {
    const f = await d.fix(cur, problems).catch(() => null);
    if (f) {
      fixed = true;
      const r = await d.check(f);
      if (r.ok) return { case: "pass", file: r.file, data: r.data, trace: { fixed, refused: parts(first) } };
      if (r.problems.some((p) => p.down)) return down(f, r.problems, fixed, "check down after the fix");
      cur = f;
      problems = r.problems;
    }
  }
  const trace = (extra: Partial<Trace> = {}): Trace => ({ fixed, refused: parts(problems), ...extra });
  const refusedTexts = problems.map((p) => p.text);
  const tokens = factTokens(refusedTexts, d.theirs);
  // The question is written once at most (one small call), whichever step asks for it.
  let asked: Promise<string | null> | null = null;
  const ask = async (): Promise<FlowEnd<F, D> | null> => {
    const mine = problems.filter(askable);
    if (d.noAsk || !mine.length) return null;
    asked ??= slotTwice(slots.ask, askPrompt(d.word, mine.map((p) => p.text)), "question", (raw) => cleanQuestion(raw, tokens, d.theirs), tokens, d.theirs);
    const q = await asked;
    return q ? { case: "ask", line: askLine(d.word, q), file: cur, problems, trace: trace({ why: problems.every(askable) ? "their fact" : "their fact, the rest not droppable" }) } : null;
  };
  // 1. Every problem is one fact of theirs: ask for it.
  if (problems.every(askable)) {
    const a = await ask();
    if (a) return a;
  }
  // 2. Still useful without the refused lines: drop them, check again, send with the line.
  const at = [...new Set(problems.map((p) => p.at))];
  const dropped = at.every(droppableAt) ? d.drop(cur, at) : null;
  const again = dropped ? await d.check(dropped) : null;
  if (again && !again.ok && again.problems.some((p) => p.down)) return down(cur, again.problems, fixed, "check down on the dropped version");
  const sendDropped = async (why: string): Promise<FlowEnd<F, D> | null> => {
    if (!dropped || !again?.ok) return null;
    const what = await slotTwice(slots.what, whatPrompt(d.word, refusedTexts), "what", (raw) => cleanWhat(raw, tokens, d.theirs), tokens, d.theirs);
    return what ? { case: "dropped", file: again.file, data: again.data, line: droppedLine(d.word, what), dropped: at, trace: trace({ dropped: at, why }) } : null;
  };
  const useful = !!dropped && d.size(dropped) >= KEEP_SHARE * d.size(cur);
  if (useful) {
    const s = await sendDropped("most lines pass");
    if (s) return s;
  }
  // 3. Not useful without them: ask, when one of them is theirs to answer.
  const a = await ask();
  if (a) return a;
  // 4. Otherwise the minimum that passes, with the line.
  if (!useful) {
    const s = await sendDropped("the minimum that passes");
    if (s) return s;
  }
  // Nothing that passes can go, and there's nothing to ask: said plainly, and their yes tries again.
  return down(cur, problems, fixed, dropped ? "the dropped version didn't pass, or its line couldn't be written" : "nothing droppable or askable");
}

// A refusal past the checks (the store's own check, after pictures were placed): nothing that passes is in hand, so it's case 3.
export const downEnd = <F>(word: FileWord, file: F, problems: Problem[] = [], why = "the store refused it"): Extract<FlowEnd<F, never>, { case: "down" }> => ({ case: "down", line: downLine(word), file, trace: { fixed: false, refused: parts(problems), why } });

// Pure: the row for how a refusal ended (harness_decisions): places and kinds only.
export function outcomeRow(o: { place: string; userId: string; end: Pick<FlowEnd<unknown, unknown>, "case" | "trace">; sent: boolean; extra?: Record<string, string | number | boolean | null>; layer?: 3 | 7 }) {
  return {
    layer: o.layer ?? 3,
    decision: "file.refusal_end",
    userId: o.userId,
    outcome: o.sent ? ("act" as const) : ("skip" as const),
    action: o.end.case,
    reason: `${o.place}: ${o.end.case}${o.end.trace.why ? ` (${o.end.trace.why})` : ""}${o.end.trace.fixed ? ", after one fix" : ""}`,
    proposal: { place: o.place, refused: o.end.trace.refused, dropped: o.end.trace.dropped ?? [], fixed: o.end.trace.fixed, sent: o.sent, ...(o.extra ?? {}) },
  };
}
export async function logOutcome(o: Parameters<typeof outcomeRow>[0]): Promise<void> {
  try {
    await (await import("../harness/core.js")).recordDecision(outcomeRow(o) as any);
  } catch (err: any) {
    console.error("refusal outcome log failed (non-fatal):", err?.message ?? err);
  }
}
