// A document Co writes for a member (Royce, 2026-10-07: asked for a PDF of where he and Jacqueline were landing and Co could only
// make a plan sheet). Free-form: a title, a line under it, and sections of paragraphs and bullets, laid out like the plan sheet
// (same page, same type) and sent as a PDF attached in their thread. Phase 1 of two: the PDF. A "save to my Google Docs" step slots
// in later through DELIVERERS (services/documentDelivery.ts) without touching what is written here.
//
// Pure: validation and the page. Nothing here guesses a fact: a sentence that names an event, a place or a time must be backed by
// what the member said or what Co read (the same check a call's sentences get, services/offerGuard.ts).
import { EMAIL_COLORS as C, escapeHtml } from "./emailDesign.js";
import { SANS, SERIF } from "./planSheet.js";
import { unsourced } from "./offerGuard.js";

export const DOC_LIMITS = { maxSections: 10, maxParagraphs: 6, maxBullets: 10, titleChars: 70, noteChars: 240, headingChars: 70, paragraphChars: 700, bulletChars: 220, totalChars: 6500, minChars: 80 };

export type DocSectionInput = { heading?: string; paragraphs?: string[]; bullets?: string[] };
export type DocInput = { title: string; note?: string; sections: DocSectionInput[] };
export type DocSection = { heading: string | null; paragraphs: string[]; bullets: string[] };
export type Doc = { title: string; note: string; sections: DocSection[] };

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
  return { title: clean(input.title, L.titleChars), note: clean(input.note, L.noteChars), sections };
}

export const docText = (d: Doc): string => [d.title, d.note, ...d.sections.flatMap((s) => [s.heading ?? "", ...s.paragraphs, ...s.bullets])].filter(Boolean).join("\n");
const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: what is wrong with a document, in words Co can act on. `source` is what it may rest on: what they said and what Co read.
export function documentProblems(doc: Doc, source: string): string[] {
  const L = DOC_LIMITS;
  const out: string[] = [];
  if (doc.title.length < 3) out.push("it needs a title");
  if (!doc.sections.length) out.push("it has nothing in it: give it sections with paragraphs or bullets");
  const body = docText(doc);
  if (body.length < L.minChars) out.push("it is too thin to be a document: say what they need written up");
  if (body.length > L.totalChars) out.push(`it is too long (${body.length} characters; ${L.totalChars} at most): cut it to what matters`);
  if (/\b(lorem ipsum|tbd|to be determined|xxx)\b|\[(?:insert|your)/i.test(body)) out.push("it has a placeholder in it");
  for (const s of sentencesOf(body)) {
    const bad = unsourced(s, source);
    if (bad.length) out.push(`"${s.slice(0, 80)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  return out.slice(0, 6);
}

export const docSlug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "document";

// Pure: the page. The plan sheet's card, with sections instead of steps.
export function documentHtml(doc: Doc, firstName: string): string {
  const e = escapeHtml;
  const section = (s: DocSection) =>
    `<div class="sec">${s.heading ? `<h2>${e(s.heading)}</h2>` : ""}${s.paragraphs.map((p) => `<p>${e(p)}</p>`).join("")}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : ""}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${e(doc.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;1,300;1,400&display=swap" rel="stylesheet">
<style>
@page { size: Letter; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: ${C.cream}; color: ${C.body}; font-family: ${SANS}; font-size: 12.5px; line-height: 1.6; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 8.5in; min-height: 11in; padding: 0.9in 1in 0.8in 1in; display: flex; flex-direction: column; }
.card { flex: 1; border: 1px solid ${C.gold}; padding: 0.55in 0.6in 0.5in 0.6in; background: ${C.white}; display: flex; flex-direction: column; }
.eyebrow { font-family: ${SANS}; font-size: 10px; font-weight: 500; letter-spacing: 2px; text-transform: uppercase; color: ${C.gold}; }
h1 { font-family: ${SERIF}; font-weight: 300; font-size: 34px; line-height: 1.12; color: ${C.ink}; margin: 10px 0 6px 0; letter-spacing: -0.2px; }
.lede { font-family: ${SERIF}; font-style: italic; font-weight: 300; font-size: 14.5px; color: ${C.soft}; margin: 0 0 22px 0; }
.rule { border: 0; border-top: 1px solid ${C.line}; margin: 0 0 6px 0; }
.sec { padding: 12px 0 4px 0; page-break-inside: avoid; }
h2 { font-family: ${SERIF}; font-weight: 400; font-size: 19px; line-height: 1.25; color: ${C.ink}; margin: 8px 0 6px 0; }
p { margin: 0 0 9px 0; color: ${C.body}; }
ul { margin: 2px 0 8px 0; padding-left: 18px; }
li { margin: 0 0 5px 0; color: ${C.body}; }
.spacer { flex: 1; }
.close { text-align: center; padding-top: 26px; font-family: ${SERIF}; font-style: italic; font-weight: 300; font-size: 14px; color: ${C.soft}; }
.close .co { display: block; margin-top: 6px; font-size: 18px; color: ${C.ink}; }
</style></head><body><div class="page"><div class="card">
<div class="eyebrow">Written for ${e(firstName || "you")}</div>
<h1>${e(doc.title)}</h1>
${doc.note ? `<p class="lede">${e(doc.note)}</p>` : ""}
<hr class="rule">
${doc.sections.map(section).join("")}
<div class="spacer"></div>
<div class="close">Tell me what to change and I'll rework it.<span class="co">Co</span></div>
</div></div></body></html>`;
}
