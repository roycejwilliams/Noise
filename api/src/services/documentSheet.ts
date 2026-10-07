// A document Co writes for a member (Royce, 2026-10-07: asked for a PDF of where he and Jacqueline were landing and Co could only
// make a plan sheet). Free-form: a title, a line under it, and sections of paragraphs and bullets, laid out like the plan sheet
// (same page, same type) and sent as a PDF attached in their thread. Phase 1 of two: the PDF. A "save to my Google Docs" step slots
// in later through DELIVERERS (services/documentDelivery.ts) without touching what is written here.
//
// Pure: validation and the page. Nothing here guesses a fact: a sentence that names an event, a place or a time must be backed by
// what the member said or what Co read (the same check a call's sentences get, services/offerGuard.ts).
import { EMAIL_COLORS as C, escapeHtml } from "./emailDesign.js";
import { unsourced } from "./offerGuard.js";
import { unbackedClaims } from "./documentGrounding.js";

export const DOC_LIMITS = { maxSections: 10, maxParagraphs: 6, maxBullets: 10, titleChars: 70, noteChars: 240, headingChars: 70, paragraphChars: 700, bulletChars: 220, totalChars: 6500, minChars: 80, maxParagraphWords: 60, bulletsExpectedAfterChars: 600, maxSuggestions: 5, suggestionChars: 220 };

export type DocSectionInput = { heading?: string; paragraphs?: string[]; bullets?: string[] };
// suggestions: anything of Co's own (ideas, options, recommendations), marked as Co's on the page and kept out of the member's points.
// kind: what the document is for. The shared working artifacts around events and partnerships (a venue brief, a partnership plan, a
// readout) are the ones that may become a shared Google Doc (services/documentDelivery.ts); everything else ("other") stays a PDF.
export const DOC_KINDS = ["venue_brief", "partnership_plan", "readout", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export type DocInput = { title: string; note?: string; sections: DocSectionInput[]; suggestions?: string[]; kind?: string };
// research: a section built by code from one verified find (services/researchBrief.ts), not from the member's words. It is exempt
// from the member-words rule and held to its own: every line from that source, with its link and when it was checked.
export type ResearchSource = { url: string; checkedAt: string; reader: "scripted" | "sdk" };
export type DocSection = { heading: string | null; paragraphs: string[]; bullets: string[]; research?: ResearchSource };
export type Doc = { title: string; note: string; sections: DocSection[]; suggestions: string[]; kind?: DocKind };

// Co writes plain words: no dash for a pause (a comma), no markdown that would print as stray symbols.
const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// Pure: the document as it will be shown. Empty paragraphs and bullets drop; limits cut, never throw.
export function resolveDocument(input: DocInput): Doc {
  const L = DOC_LIMITS;
  const sections = (input.sections ?? [])
    .slice(0, L.maxSections)
    .map((s) => ({
      heading: clean(s.heading, L.headingChars) || null,
      paragraphs: (s.paragraphs ?? []).map((p) => clean(p, L.paragraphChars)).filter(Boolean).slice(0, L.maxParagraphs),
      bullets: (s.bullets ?? []).map((b) => clean(b, L.bulletChars)).filter(Boolean).slice(0, L.maxBullets),
    }))
    .filter((s) => s.paragraphs.length || s.bullets.length);
  const suggestions = (input.suggestions ?? []).map((x) => clean(x, L.suggestionChars)).filter(Boolean).slice(0, L.maxSuggestions);
  const kind: DocKind = (DOC_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as DocKind) : "other";
  return { title: clean(input.title, L.titleChars), note: clean(input.note, L.noteChars), sections, suggestions, kind };
}

export const docText = (d: Doc): string => [d.title, d.note, ...d.sections.flatMap((s) => [s.heading ?? "", ...s.paragraphs, ...s.bullets]), ...d.suggestions].filter(Boolean).join("\n");
// Their points only: what must rest on their own words.
export const memberParts = (d: Doc): string[] => d.sections.filter((s) => !s.research).flatMap((s) => [...s.paragraphs, ...s.bullets]);
const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: what is wrong with a document, in words Co can act on.
//   theirs: everything they said (their texts and calls). Their points must rest on it, claim by claim.
//   read:   what Co read this turn. Only Co's own suggestions may lean on it, for an event or a place (never for a claim about them).
export function documentProblems(doc: Doc, source: { theirs: string; read?: string }): string[] {
  const L = DOC_LIMITS;
  const out: string[] = [];
  if (doc.title.length < 3) out.push("it needs a title");
  if (!doc.sections.length) out.push("it has nothing in it: give it sections with paragraphs or bullets");
  const body = docText(doc);
  if (body.length < L.minChars) out.push("it is too thin to be a document: say what they need written up");
  if (body.length > L.totalChars) out.push(`it is too long (${body.length} characters; ${L.totalChars} at most): cut it to what matters`);
  if (/\b(lorem ipsum|tbd|to be determined|xxx)\b|\[(?:insert|your)/i.test(body)) out.push("it has a placeholder in it");
  // Scannable: a record, not a chat. Points go in bullets; a paragraph is a few sentences, not a block.
  const long = doc.sections.flatMap((x) => x.paragraphs).find((x) => x.split(/\s+/).length > L.maxParagraphWords);
  if (long) out.push(`a paragraph runs ${long.split(/\s+/).length} words ("${long.slice(0, 40)}..."): put its points in bullets and keep paragraphs to two or three sentences`);
  if (!long && body.length > L.bulletsExpectedAfterChars && !doc.sections.some((x) => x.bullets.length)) out.push("it has no bullets: put the points of each section in bullets so it can be scanned");
  // Their record is their words: an event, place or time must be one they gave (or one of Co's marked suggestions, from what Co read).
  const mine = memberParts(doc).join("\n");
  for (const s of sentencesOf(mine)) {
    const bad = unsourced(s, source.theirs);
    if (bad.length) out.push(`"${s.slice(0, 80)}" names ${bad.map((m) => m.text).join(", ")}, which they never said`);
  }
  for (const s of sentencesOf(doc.suggestions.join("\n"))) {
    const bad = unsourced(s, `${source.theirs}\n${source.read ?? ""}`);
    if (bad.length) out.push(`the suggestion "${s.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  // And every claim in their sections rests on their words, close together: Co's own reasoning is a suggestion, not their point.
  for (const u of unbackedClaims(memberParts(doc), source.theirs).slice(0, 4)) {
    out.push(`"${u.text.slice(0, 90)}" isn't something they said (their words never put ${u.missing.slice(0, 4).join(", ")} together): rewrite it from their own words, or move it to suggestions`);
  }
  return out.slice(0, 7);
}

// ---------------------------------------------------------------- the file's name

const SMALL = new Set(["a", "an", "and", "or", "of", "the", "to", "for", "in", "on", "at", "with", "vs"]);
// "Product positioning and scaling notes" on 2026-10-07 becomes "Co-Product-Positioning-and-Scaling-Notes-2026-10-07.pdf":
// a real name from the title, Co first so it sorts together, the day last so a folder of them reads in order.
export function docFilename(title: string, dateIso: string): string {
  const words = title.replace(/[^A-Za-z0-9' ]+/g, " ").replace(/'/g, "").split(/\s+/).filter(Boolean);
  // "Co: Product Positioning" is not "Co-Co-Product-Positioning": the name already starts with Co.
  if (words.length > 1 && words[0].toLowerCase() === "co") words.shift();
  const named = words.map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)));
  let base = named.join("-").slice(0, 70).replace(/-+$/, "");
  if (!base) base = "Document";
  return `Co-${base}-${/^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : "undated"}.pdf`;
}

// ---------------------------------------------------------------- the page

// Short documents get more air and larger type, long ones tighter, so any length looks intended.
export type Density = "airy" | "standard" | "dense";
// How much page a document takes, in lines: each paragraph and bullet by its length (about 62 characters a line in the points column),
// a few lines of room for each section and for the suggestions block. Characters alone ignored the room headings and bullets take.
export function docUnits(doc: Doc): number {
  const lines = (t: string) => Math.max(1, Math.ceil(t.length / 62));
  const points = doc.sections.reduce((n, s) => n + [...s.paragraphs, ...s.bullets].reduce((m, t) => m + lines(t), 0) + 3, 0);
  const sug = doc.suggestions.length ? doc.suggestions.reduce((n, t) => n + lines(t), 0) + 4 : 0;
  return points + sug + Math.ceil((doc.note.length + 40) / 80);
}
export function docDensity(doc: Doc): Density {
  const u = docUnits(doc);
  return u <= 24 ? "airy" : u <= 40 ? "standard" : "dense";
}

// Only plain characters reach the page margin boxes (CSS strings): no quote, backslash or control character can end the string.
const cssText = (s: string, max: number) => s.replace(/[^A-Za-z0-9 ,.'&:-]/g, "").trim().slice(0, max);

export const PAPER = { paper: "#F6F2EA", ink: "#241418", body: "#3C2F33", soft: "#6E6159", muted: "#968A80", line: "#DDD5C8", gold: "#B79B74" } as const;
const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "'Instrument Sans', -apple-system, 'Helvetica Neue', Arial, sans-serif";

// Pure: the page. Two typefaces and nothing else: Fraunces for the title and section headings, Instrument Sans for everything
// read and everything small. Paper, ink, one quiet gold. Sections are units: a numbered serif heading on the left, its points on
// the right. The footer is the page's own margin (title and page number), so it sits at the bottom of every page at any length.
export function documentHtml(doc: Doc, o: { firstName: string; date: string }): string {
  const e = escapeHtml;
  const C = PAPER;
  const density = docDensity(doc);
  const name = o.firstName.trim() || "you";
  const section = (s: DocSection) =>
    `<section class="sec${s.heading ? "" : " bare"}">${s.heading ? `<h2>${e(s.heading)}</h2>` : ""}<div class="body">${s.paragraphs.map((p) => `<p>${e(p)}</p>`).join("")}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : ""}</div></section>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${e(doc.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
@page {
  size: Letter; margin: 0.8in 1in 0.95in 1in; background: ${C.paper};
  @bottom-left { content: "${cssText(doc.title, 60)}"; font-family: ${SANS}; font-size: 7.5px; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.muted}; vertical-align: top; padding-top: 0.28in; }
  @bottom-right { content: counter(page) " / " counter(pages); font-family: ${SANS}; font-size: 7.5px; letter-spacing: 0.16em; color: ${C.muted}; vertical-align: top; padding-top: 0.28in; }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: ${C.paper}; }
body { color: ${C.body}; font-family: ${SANS}; -webkit-print-color-adjust: exact; print-color-adjust: exact; counter-reset: sec; }
body.airy { --title: 52px; --text: 14.5px; --lead: 16.5px; --pad: 34px; --h2: 23px; }
body.standard { --title: 40px; --text: 13px; --lead: 14.5px; --pad: 22px; --h2: 19px; }
body.dense { --title: 31px; --text: 11.3px; --lead: 12.5px; --pad: 13px; --h2: 16px; }
.mast { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 12px; border-bottom: 1px solid ${C.ink}; }
.mark { font-family: ${SERIF}; font-weight: 400; font-size: 24px; line-height: 1; letter-spacing: 0.01em; color: ${C.ink}; }
.date { font-size: 8.5px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; color: ${C.soft}; }
.head { padding: calc(var(--pad) * 2.2) 0 calc(var(--pad) * 1.3) 0; }
h1 { font-family: ${SERIF}; font-weight: 300; font-size: var(--title); line-height: 1.08; letter-spacing: -0.012em; color: ${C.ink}; margin: 0; max-width: 5.7in; }
.for { margin-top: 14px; font-size: 8.5px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; color: ${C.muted}; }
.lede { margin: calc(var(--pad) * 0.9) 0 0 0; max-width: 4.9in; font-size: var(--lead); line-height: 1.5; color: ${C.soft}; }
.sec { display: grid; grid-template-columns: 1.75in 1fr; column-gap: 0.4in; padding: var(--pad) 0; border-top: 1px solid ${C.line}; break-inside: avoid; counter-increment: sec; }
.sec.bare { grid-template-columns: 1fr; }
h2 { font-family: ${SERIF}; font-weight: 400; font-size: var(--h2); line-height: 1.22; color: ${C.ink}; margin: 0; }
h2::before { content: counter(sec, decimal-leading-zero); display: block; font-family: ${SANS}; font-size: 8.5px; font-weight: 600; letter-spacing: 0.2em; color: ${C.gold}; margin-bottom: 7px; }
.body p { margin: 0 0 0.6em 0; font-size: var(--text); line-height: 1.5; color: ${C.body}; }
.body p:last-child { margin-bottom: 0; }
ul { margin: 0; padding: 0 0 0 1.1em; }
li { font-size: var(--text); line-height: 1.5; color: ${C.body}; margin: 0 0 0.45em 0; padding-left: 0.2em; }
li:last-child { margin-bottom: 0; }
li::marker { color: ${C.gold}; font-size: 0.95em; }
p + ul { margin-top: 0.35em; }
.sug { margin-top: var(--pad); padding: calc(var(--pad) * 0.8) 0 calc(var(--pad) * 0.8) 0.22in; border-left: 2px solid ${C.gold}; break-inside: avoid; }
h3 { margin: 0 0 8px 0; font-family: ${SANS}; font-size: 8.5px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: ${C.gold}; }
.sug li { color: ${C.soft}; }
.end { border-top: 1px solid ${C.line}; }
</style></head><body class="${density}">
<div class="mast"><div class="mark">Co</div><div class="date">${e(o.date)}</div></div>
<div class="head"><h1>${e(doc.title)}</h1><div class="for">Prepared for ${e(name)}</div>${doc.note ? `<p class="lede">${e(doc.note)}</p>` : ""}</div>
${doc.sections.map(section).join("")}
${doc.suggestions.length ? `<section class="sug"><h3>Co's suggestions</h3><ul>${doc.suggestions.map((x) => `<li>${e(x)}</li>`).join("")}</ul></section>` : ""}
<div class="end"></div>
</body></html>`;
}
