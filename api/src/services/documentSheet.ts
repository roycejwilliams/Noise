// A document Co writes for a member (Royce, 2026-10-07: asked for a PDF of where he and Jacqueline were landing and Co could only
// make a plan sheet). Free-form: a title, a line under it, and sections of paragraphs and bullets, laid out like the plan sheet
// (same page, same type) and sent as a PDF attached in their thread. Phase 1 of two: the PDF. A "save to my Google Docs" step slots
// in later through DELIVERERS (services/documentDelivery.ts) without touching what is written here.
//
// Pure: validation and the page. Nothing here guesses a fact: a sentence that names an event, a place or a time must be backed by
// what the member said or what Co read (the same check a call's sentences get, services/offerGuard.ts).
import { contrast, type DeckStyle } from "./coPages/style.js";
import { inkFor } from "./designQa.js";
import { fontLinks, fontStack } from "./designFonts.js";
import { z } from "zod";
import { EMAIL_COLORS as C, escapeHtml } from "./emailDesign.js";
import { unsourced } from "./offerGuard.js";
import { unbackedClaims, type Unbacked } from "./documentGrounding.js";
import { isOwnName, ownName, type MemberRecord } from "./memberRecord.js";

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

// The writeDocument tool's input, one definition for every place Co can write a document: a reply (agent/loopTools.ts) and a task
// keeping a promise (the task runner). The tool's description is the registry's (services/capabilities.ts write_document).
export const WRITE_DOCUMENT_INPUT = z.object({
  title: z.string().describe("A short title, in plain words they would recognize."),
  note: z.string().optional().describe("One line under the title: what this is, in your voice."),
  sections: z
    .array(
      z.object({
        heading: z.string().optional(),
        paragraphs: z.array(z.string()).max(6).optional(),
        bullets: z.array(z.string()).max(10).optional(),
      }),
    )
    .min(1)
    .max(10)
    .describe("Each a heading, a sentence or two of framing, then the points as short bullets: scannable, not dense paragraphs. ONLY what they said, in their words; your own ideas go in suggestions, never here."),
  suggestions: z.array(z.string()).max(5).optional().describe("Anything of your own: an idea, an option, a recommendation, a framing you wrote for them, written out in full. It appears on the page marked as Cue's suggestions, apart from their points. Each is the idea itself, never a note about the document or about Cue. Leave it out when you have none."),
  kind: z.enum(["venue_brief", "partnership_plan", "readout", "other"]).optional().describe("What it is for: venue_brief (for a venue or space around an event), partnership_plan (working with a partner, sponsor or host), readout (what came of an event, for a host or partner), or other (anything else: their goals, a plan for themselves, a summary). Leave it out for other."),
  saveTo: z.enum(["pdf", "google_doc", "both"]).optional().describe("Leave this out: it comes as a PDF in this conversation. Only when they ask for a Google Doc in their own words set google_doc (or both, if they want the PDF too)."),
  revises: z.number().int().optional().describe("Only when they asked to change a document you already delivered: its doc number from \"Documents you've delivered\". Write the whole new version (start from readDocument), and it goes as the next version."),
  changed: z.string().optional().describe("With revises: what changed, in a few words they'd recognize (\"updated the budget section\"). It becomes the one line sent with the new version."),
  // The tool owns its one delivery line (Royce, 2026-10-08: one delivery is the attachment and one line, nothing else repeating it).
  line: z.string().optional().describe("The one sentence that goes with the attachment, in your voice: what it is (\"Here's the plan for keeping Cue present after the launch.\"). Sent later than they asked, it says when they asked (\"Here's the plan you asked for last night.\"). No dashes, no exclamation points. Leave it out and a plain line goes. Nothing else about it is sent, so don't repeat it in a reply."),
});
export type WriteDocumentInput = z.infer<typeof WRITE_DOCUMENT_INPUT>;

// Co writes plain words: no dash for a pause (a comma), no markdown that would print as stray symbols.
// A line over its limit ends at its last whole sentence or word, never mid-word (2026-10-12: a suggestion went out ending "a typical
// sponsored pour lo").
const clip = (t: string, max: number) => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (end > max * 0.5) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(" ");
  return sp > max * 0.5 ? cut.slice(0, sp).replace(/[,;:]$/, "") : cut;
};
const clean = (s: unknown, max: number) =>
  clip(
    String(s ?? "")
      .replace(/\s*[—–]\s*/g, ", ")
      .replace(/[*_`#]+/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );

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

// Their own words asking for a gap to fill in later.
export const ASKED_FOR_A_SPOT = /\b(?:leave|hold|save|keep|put)\b[^.!?\n]{0,20}\b(?:spot|space|room|blank|gap|placeholder|slot)\b|\bplaceholders?\b|\bfill (?:it |that |this )?in (?:later|myself)\b/i;

export const docText = (d: Doc): string => [d.title, d.note, ...d.sections.flatMap((s) => [s.heading ?? "", ...s.paragraphs, ...s.bullets]), ...d.suggestions].filter(Boolean).join("\n");
// Their points only: what must rest on their own words.
export const memberParts = (d: Doc): string[] => d.sections.filter((s) => !s.research).flatMap((s) => [...s.paragraphs, ...s.bullets]);
const sentencesOf = (t: string) => (t.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Pure: what is wrong with a document, in words Co can act on.
//   theirs: everything they said (their texts and calls). Their points must rest on it, claim by claim.
//   read:   what Co read this turn. Only Co's own suggestions may lean on it, for an event or a place (never for a claim about them).
//   o.backed: claims a judge read as their own words, rephrased (services/documentClaims.ts): not refused for wording. Their numbers
//             and names are still checked here, whatever the judge said.
//   o.judgedOut: lines the word check passed that a judge read as adding a claim, with why.
//   member: their own record (services/memberRecord.ts): a missing name that is exactly their own first name is cleared, and nothing
//           else from it (ruling iii: a name in a goal is not one they gave; Royce 2026-10-18 A+H).
export function documentProblems(doc: Doc, source: { theirs: string; read?: string; member?: MemberRecord | null }, o: { backed?: ReadonlySet<string>; judgedOut?: ReadonlyMap<string, string> } = {}): string[] {
  const L = DOC_LIMITS;
  const theirs = source.theirs;
  const own = ownName(source.member);
  const named = (s: string, src: string) => unsourced(s, src).filter((m) => !(m.kind === "name" && isOwnName(m.text, own)));
  const out: string[] = [];
  if (doc.title.length < 3) out.push("it needs a title");
  if (!doc.sections.length) out.push("it has nothing in it: give it sections with paragraphs or bullets");
  const body = docText(doc);
  if (body.length < L.minChars) out.push("it is too thin to be a document: say what they need written up");
  if (body.length > L.totalChars) out.push(`it is too long (${body.length} characters; ${L.totalChars} at most): cut it to what matters`);
  // A bracketed gap ("[Example to drop in: ...]") is a placeholder too: one goes out only when they asked for a spot to fill in
  // themselves ("leave a spot for the example"), never on Co's own and never a document of gaps (2026-10-12).
  const gaps = body.match(/\[[^\]\n]{2,}\]/g) ?? [];
  if (/\b(lorem ipsum|tbd|to be determined|xxx)\b|\[(?:insert|your)/i.test(body)) out.push("it has a placeholder in it");
  else if (gaps.length && !(gaps.length === 1 && ASKED_FOR_A_SPOT.test(source.theirs))) out.push(`it has ${gaps.length > 1 ? `${gaps.length} placeholders` : "a placeholder"} in it (a bracketed gap): leave the missing piece out and write the point as it stands, or ask them for it${gaps.length > 1 ? "; at most one spot, and only one they asked for" : ""}`);
  // Scannable: a record, not a chat. Points go in bullets; a paragraph is a few sentences, not a block.
  const long = doc.sections.flatMap((x) => x.paragraphs).find((x) => x.split(/\s+/).length > L.maxParagraphWords);
  if (long) out.push(`a paragraph runs ${long.split(/\s+/).length} words ("${long.slice(0, 40)}..."): put its points in bullets and keep paragraphs to two or three sentences`);
  if (!long && body.length > L.bulletsExpectedAfterChars && !doc.sections.some((x) => x.bullets.length)) out.push("it has no bullets: put the points of each section in bullets so it can be scanned");
  // Their record is their words: an event, place or time must be one they gave (or one of Co's marked suggestions, from what Co read).
  const mine = memberParts(doc).join("\n");
  for (const s of sentencesOf(mine)) {
    const bad = named(s, theirs);
    if (bad.length) out.push(`"${s.slice(0, 80)}" names ${bad.map((m) => m.text).join(", ")}, which they never said`);
  }
  for (const s of sentencesOf(doc.suggestions.join("\n"))) {
    const bad = named(s, `${theirs}\n${source.read ?? ""}`);
    if (bad.length) out.push(`the suggestion "${s.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  // And every claim in their sections rests on their words, close together: Co's own reasoning is a suggestion, not their point.
  for (const u of unbackedClaims(memberParts(doc), theirs, { strict: true, own }).filter((x) => x.hard.length || !o.backed?.has(x.text)).slice(0, 4)) {
    out.push(claimProblem(u));
  }
  // Lines the word check passed but a judge read as adding a claim (documentClaims.ts).
  for (const [text, why] of o.judgedOut ?? []) out.push(`"${text.slice(0, 90)}" isn't something they said (${why}): rewrite it from their own words, or move it to suggestions`);
  // Bare fragments are not a document (2026-10-12: after refusals, the last try was bullets that only repeated their headings, "QR
  // table cards." under "QR table cards"). A point says something its heading doesn't.
  const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(a|an|the)\b/g, " ").replace(/\s+/g, " ").trim();
  const echoes = doc.sections.filter((x) => !x.research && x.heading).flatMap((x) => x.bullets.filter((b) => plain(b) === plain(x.heading!)));
  if (echoes.length >= 2) out.push(`its points only repeat their headings ("${echoes[0].slice(0, 40)}"): write each bullet as a short line that says what they told you about it, or leave the section out`);
  return out.slice(0, 7);
}

// The line Co gets for a claim of theirs that isn't backed (documentProblems). Shared so a judged claim drops exactly its line.
export function claimProblem(u: Unbacked): string {
  // A number or a name they never gave is said as one, so the fix is plain: leave it out (2026-10-12: "never put 4 together" for a
  // count of the four things they listed, twice).
  if (u.hard.length) return `"${u.text.slice(0, 90)}" isn't something they said: it has ${u.hard.slice(0, 3).join(", ")}, which they never gave. Leave that out (or ask them), or move the line to suggestions`;
  return `"${u.text.slice(0, 90)}" isn't something they said (their words never put ${u.missing.slice(0, 4).join(", ")} together): rewrite it from their own words, or move it to suggestions`;
}

// Pure: what a refusal was, for the decision log, with no member text (Royce, 2026-10-18: "Logs hold the rule and the kind of thing,
// never member text"). Each problem becomes its place and the rule it broke ("section 2 line 3: a line their words don't back"); the
// quoted line is used only to find its place and never leaves this function. The writer still gets the quoted problems.
// (#241 has the shared helper for every checker, services/checkerRefusals.ts; this is the minimal one for the task-document row.)
export function refusalKinds(problems: string[], doc: Doc): string[] {
  const where = (p: string): string => {
    const quoted = p.match(/"([^"]{8,})/)?.[1]?.slice(0, 40);
    if (!quoted) return "the document";
    for (const [i, x] of doc.sections.entries()) {
      if ((x.heading ?? "").includes(quoted)) return `section ${i + 1} heading`;
      const j = [...x.paragraphs, ...x.bullets].findIndex((t) => t.includes(quoted));
      if (j >= 0) return `section ${i + 1} line ${j + 1}`;
    }
    const k = doc.suggestions.findIndex((t) => t.includes(quoted));
    return k >= 0 ? `suggestion ${k + 1}` : doc.title.includes(quoted) ? "title" : "the document";
  };
  const kind = (p: string): string => {
    if (/^the suggestion .* which they never said and you never read/.test(p)) return "a name or time they never gave";
    if (/which they never gave/.test(p)) return "a name or number they never gave";
    if (/which they never said/.test(p)) return "a name, place or time they never said";
    if (/isn't something they said \(their words never put/.test(p)) return "a line their words don't back";
    if (/isn't something they said/.test(p)) return "a line the judge read as not theirs";
    if (/placeholder/.test(p)) return "a placeholder";
    if (/needs a title/.test(p)) return "no title";
    if (/has nothing in it/.test(p)) return "no sections";
    if (/too thin/.test(p)) return "too thin";
    if (/too long/.test(p)) return "too long";
    if (/a paragraph runs/.test(p)) return "a paragraph too long";
    if (/no bullets/.test(p)) return "no bullets";
    if (/only repeat their headings/.test(p)) return "points that repeat their headings";
    return "another document rule";
  };
  return problems.map((p) => `${where(p)}: ${kind(p)}`);
}

// ---------------------------------------------------------------- the file's name

const SMALL = new Set(["a", "an", "and", "or", "of", "the", "to", "for", "in", "on", "at", "with", "vs"]);
// "Product positioning and scaling notes" on 2026-10-07 becomes "Co-Product-Positioning-and-Scaling-Notes-2026-10-07.pdf":
// a real name from the title, Co first so it sorts together, the day last so a folder of them reads in order.
export function docFilename(title: string, dateIso: string): string {
  const words = title.replace(/[^A-Za-z0-9' ]+/g, " ").replace(/'/g, "").split(/\s+/).filter(Boolean);
  // "Co: Product Positioning" is not "Co-Co-Product-Positioning": the name already starts with Co.
  if (words.length > 1 && ["co", "cue"].includes(words[0].toLowerCase())) words.shift();
  const named = words.map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)));
  let base = named.join("-").slice(0, 70).replace(/-+$/, "");
  if (!base) base = "Document";
  return `Cue-${base}-${/^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : "undated"}.pdf`;
}

// ---------------------------------------------------------------- the page

// Short documents get more air and larger type, long ones tighter, so any length looks intended. Body text is never under 10pt
// (13.33px), dense included (design audit, 2026-10-12: dense set it at 8.5pt).
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

export const PAPER = { paper: "#F6F2EA", ink: "#241418", body: "#3C2F33", soft: "#6E6159", muted: "#73675F", line: "#DDD5C8", gold: "#B79B74" } as const;
const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "'Instrument Sans', -apple-system, 'Helvetica Neue', Arial, sans-serif";

// Pure: the page. Two typefaces and nothing else: Fraunces for the title and section headings, Instrument Sans for everything
// read and everything small. Paper, ink, one quiet gold. Sections are units: a numbered serif heading on the left, its points on
// the right. The footer is the page's own margin (title and page number), so it sits at the bottom of every page at any length.
export function documentHtml(doc: Doc, o: { firstName: string; date: string; look?: DeckStyle | null }): string {
  const e = escapeHtml;
  // The member's design system (services/designSystem.ts), when they have one: their fonts, their ink, their accent where it reads
  // on the paper. Print keeps a light paper, so a dark look keeps Co's paper and takes only their fonts and accent.
  const look = o.look ?? null;
  const lightPaper = look ? contrast(look.background, "#000000") > contrast(look.background, "#FFFFFF") : false;
  const paper = look && lightPaper ? look.background : PAPER.paper;
  const ink = look && lightPaper ? look.text : PAPER.ink;
  const C = look
    ? { ...PAPER, paper, ink, body: ink, gold: contrast(look.accent, paper) >= 3 ? look.accent : ink, line: `${ink}26`, soft: `${ink}B3`, muted: `${ink}B3` }
    : PAPER;
  // The small labels (the section numbers, "Cue's suggestions") read at 4.5:1 on the paper: the gold was 2.36:1 on Co's paper and a
  // member's accent is allowed at 3:1, so design QA flagged every document and nothing fixed it (S1-a, 2026-10-17). The gold, deepened
  // only as far as it has to go (#B79B74 becomes #77654B on Co's paper). The list markers and the suggestions rule stay gold.
  const label = inkFor(C.gold, C.paper, 4.5);
  const SER = look?.display ? fontStack(look.display) : SERIF;
  const SAN = look?.body ? fontStack(look.body) : SANS;
  const fonts = look ? fontLinks([look.display, look.body].filter((x): x is NonNullable<typeof x> => !!x)).map((h) => `<link href="${e(h)}" rel="stylesheet">`).join("") : "";
  const density = docDensity(doc);
  const name = o.firstName.trim() || "you";
  const section = (s: DocSection) =>
    `<section class="sec${s.heading ? "" : " bare"}">${s.heading ? `<h2>${e(s.heading)}</h2>` : ""}<div class="body">${s.paragraphs.map((p) => `<p>${e(p)}</p>`).join("")}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : ""}</div></section>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${e(doc.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">${fonts}
<style>
@page {
  size: Letter; margin: 0.8in 1in 0.95in 1in; background: ${C.paper};
  @bottom-left { content: "${cssText(doc.title, 60)}"; font-family: ${SAN}; font-size: 7.5px; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.muted}; vertical-align: top; padding-top: 0.28in; }
  @bottom-right { content: counter(page) " / " counter(pages); font-family: ${SAN}; font-size: 7.5px; letter-spacing: 0.16em; color: ${C.muted}; vertical-align: top; padding-top: 0.28in; }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: ${C.paper}; }
body { color: ${C.body}; font-family: ${SANS}; -webkit-print-color-adjust: exact; print-color-adjust: exact; counter-reset: sec; }
body.airy { --title: 52px; --text: 14.5px; --lead: 16.5px; --pad: 34px; --h2: 23px; }
body.standard { --title: 40px; --text: 13.5px; --lead: 15px; --pad: 22px; --h2: 19px; }
body.dense { --title: 31px; --text: 13.4px; --lead: 14.5px; --pad: 13px; --h2: 16.5px; }
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
h2::before { content: counter(sec, decimal-leading-zero); display: block; font-family: ${SANS}; font-size: 8.5px; font-weight: 600; letter-spacing: 0.2em; color: ${label}; margin-bottom: 7px; }
.body p { margin: 0 0 0.6em 0; font-size: var(--text); line-height: 1.5; color: ${C.body}; }
.body p:last-child { margin-bottom: 0; }
ul { margin: 0; padding: 0 0 0 1.1em; }
li { font-size: var(--text); line-height: 1.5; color: ${C.body}; margin: 0 0 0.45em 0; padding-left: 0.2em; }
li:last-child { margin-bottom: 0; }
li::marker { color: ${C.gold}; font-size: 0.95em; }
p + ul { margin-top: 0.35em; }
.sug { margin-top: var(--pad); padding: calc(var(--pad) * 0.8) 0 calc(var(--pad) * 0.8) 0.22in; border-left: 2px solid ${C.gold}; break-inside: avoid; }
h3 { margin: 0 0 8px 0; font-family: ${SANS}; font-size: 8.5px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: ${label}; }
.sug li { color: ${C.soft}; }
.end { border-top: 1px solid ${C.line}; }
</style></head><body class="${density}">
<div class="mast"><div class="mark">Cue</div><div class="date">${e(o.date)}</div></div>
<div class="head"><h1>${e(doc.title)}</h1><div class="for">Prepared for ${e(name)}</div>${doc.note ? `<p class="lede">${e(doc.note)}</p>` : ""}</div>
${doc.sections.map(section).join("")}
${doc.suggestions.length ? `<section class="sug"><h3>Cue's suggestions</h3><ul>${doc.suggestions.map((x) => `<li>${e(x)}</li>`).join("")}</ul></section>` : ""}
<div class="end"></div>
</body></html>`;
}
