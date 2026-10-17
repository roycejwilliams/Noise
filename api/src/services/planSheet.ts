// The plan Co sends by email (Royce, 2026-10-05): when a member asks Co to plan
// something, Co can hand them a one-page sheet and calendar holds, by email, as
// a private club would: small, composed, theirs. Nothing here guesses a fact.
// A step tied to an event Co found takes its time, place and address from that
// event's own record; a free step has to back its places, names and numbers with
// what the member said or a page Co read this turn. Times Co proposes itself
// (dinner afterwards) are the member's to change and are written as given.
//
// Pure: validation, the calendar file and the page. Sending is planEmail.ts.
import { DateTime } from "luxon";
import { EMAIL_COLORS as C, escapeHtml, quietEmail } from "./emailDesign.js";
import { placesBacked } from "./taskWeb.js";
import { START_LEAD_MINUTES, eventStartProblem } from "./eventStart.js";

export const PLAN_LIMITS = { maxSteps: 8, maxNotes: 4, titleChars: 60, noteChars: 220, textChars: 160, daysAhead: 90, perDay: 2 };

export type PlanStepInput = {
  // An event Co found this turn (its link): its time, place and address come from its record.
  link?: string;
  // Local time in the member's zone, "2026-10-11T16:30". Absent for a step with no time.
  when?: string;
  until?: string;
  what: string;
  where?: string;
  address?: string;
  detail?: string;
};
export type PlanInput = { title: string; note: string; steps: PlanStepInput[]; notes?: string[] };

// src is the step as the model gave it, kept with the resolved step so checks pair the right one after sorting.
export type PlanStep = { start: DateTime | null; end: DateTime | null; what: string; where: string | null; address: string | null; detail: string | null; src: PlanStepInput };
export type Plan = { title: string; note: string; steps: PlanStep[]; notes: string[]; zone: string };

// What an event's own record gives a step: filled by code, never by the model.
// blocked: why it can't go on a plan (sold out, turned away). hasRecord: it has a real event page record (not a web result or a post).
export type EventRecord = { name: string; startAt?: string | null; endAt?: string | null; timezone?: string | null; venue?: string | null; address?: string | null; blocked?: string | null; hasRecord?: boolean };

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, max);

// Pure: the plan as it will be shown, times resolved in the member's zone, event steps filled
// from their records. Never throws; planProblems says what's wrong.
export function resolvePlan(input: PlanInput, zone: string, records: (link: string) => EventRecord | null): Plan {
  const steps: PlanStep[] = (input.steps ?? []).slice(0, PLAN_LIMITS.maxSteps).map((src) => {
    const rec = src.link ? records(src.link) : null;
    // A step tied to an event takes its time, place and address from that event's record, and nothing
    // from the model's own where, address or time; a free step takes what it was given (planProblems backs it).
    const linked = !!src.link;
    const z = linked ? (rec?.timezone || zone) : zone;
    const startRaw = linked ? rec?.startAt ?? null : src.when ?? null;
    const endRaw = linked ? rec?.endAt ?? null : src.until ?? null;
    const at = (iso: string | null) => (iso ? DateTime.fromISO(iso, { zone: z }) : null);
    const start = at(startRaw);
    const end = at(endRaw);
    return {
      start: start?.isValid ? start.setZone(zone) : null,
      end: end?.isValid ? end.setZone(zone) : null,
      what: clean(src.what || rec?.name, PLAN_LIMITS.textChars),
      where: clean(linked ? rec?.venue : src.where, PLAN_LIMITS.textChars) || null,
      address: clean(linked ? rec?.address : src.address, PLAN_LIMITS.textChars) || null,
      detail: clean(src.detail, PLAN_LIMITS.textChars) || null,
      src,
    };
  });
  steps.sort((a, b) => (a.start?.toMillis() ?? Infinity) - (b.start?.toMillis() ?? Infinity));
  return {
    title: clean(input.title, PLAN_LIMITS.titleChars),
    note: clean(input.note, PLAN_LIMITS.noteChars),
    steps,
    notes: (input.notes ?? []).slice(0, PLAN_LIMITS.maxNotes).map((n) => clean(n, PLAN_LIMITS.textChars)).filter(Boolean),
    zone,
  };
}

const NOT_NAMES = new Set(["i", "i'm", "i'll", "i've", "co", "cue", "the", "a", "an", "and", "or", "but", "to", "for", "at", "on", "in", "if", "it", "it's", "we", "you", "your", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "am", "pm"]);

// Pure: capitalised words (names, places) in the text: any not at the start of a sentence, and the first
// word of a sentence when a capitalised word follows it ("Zuni Cafe for dinner"). A lone sentence-opening
// word is left alone; lowercase names can't be told from words.
export function namedThings(text: string): string[] {
  const out: string[] = [];
  const clean1 = (w: string) => w.replace(/[^A-Za-z0-9'’&-]/g, "").replace(/['’]s$/i, "");
  const isName = (w: string) => w.length >= 2 && /^[A-Z]/.test(w) && !NOT_NAMES.has(w.toLowerCase());
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    const words = sentence.split(/\s+/).map(clean1);
    for (let i = 0; i < words.length; i++) {
      if (!isName(words[i])) continue;
      if (i > 0 || (words[1] && /^[A-Z]/.test(words[1]))) out.push(words[i]);
    }
  }
  return [...new Set(out)];
}

const wordRe = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
// A whole word or phrase in what was read or said, never a piece of another word ("Oak" in "Oakland").
export const backed = (thing: string, have: string) => wordRe(thing).test(have);
// A number as a whole figure ("60" is not in "601 19th St"). Commas in the facts don't matter.
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?/g;
export function numbersUnbacked(text: string, have: string): string[] {
  const h = have.replace(/(?<=\d),(?=\d)/g, "");
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/^\$/, "").replace(/,/g, "").replace(/\.$/, "")).filter((n) => n && !new RegExp(`(?<![\\d.])${n.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`).test(h));
}
// "sixty dollars", "twelve people": spelled-out amounts say as much as digits.
const WORD_AMOUNT = /\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|couple of|few)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine|hundred|thousand))?) (?:dollars|bucks|people|guests|friends|minutes|hours|miles|blocks|stops|seats|spots)\b/gi;
export const wordAmounts = (text: string) => text.match(WORD_AMOUNT) ?? [];

// Pure: why the plan can't go out, or []. `facts` is what Co has really seen this turn (pages, event
// records, what the member's notes hold); `theirs` is what the member said. Times are not checked as facts:
// they are the plan's own, except those taken from an event's record, which code filled.
export function planProblems(input: PlanInput, plan: Plan, o: { facts: string; theirs: string; now: Date; recordFor: (link: string) => EventRecord | null }): string[] {
  const out: string[] = [];
  if (!plan.title) out.push("a plan needs a title");
  if (!input.steps?.length) out.push("a plan needs at least one step");
  if ((input.steps?.length ?? 0) > PLAN_LIMITS.maxSteps) out.push(`at most ${PLAN_LIMITS.maxSteps} steps`);
  if (/[\[\]{}<>]|https?:\/\//.test(`${plan.title} ${plan.note} ${plan.notes.join(" ")}`)) out.push("no links, brackets or markup in the title, note or notes");
  const have = `${o.facts}\n${o.theirs}`;
  const horizon = DateTime.fromJSDate(o.now).plus({ days: PLAN_LIMITS.daysAhead });
  const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
  plan.steps.forEach((s, i) => {
    const raw = s.src;
    const label = `step ${i + 1}`;
    if (!s.what) out.push(`${label} needs to say what it is`);
    if (raw.link) {
      const rec = o.recordFor(raw.link);
      if (!rec || !rec.hasRecord) out.push(`${label}: that link isn't an event with its own page record from this turn (a web result or a post has no time or place to fill in)`);
      else {
        if (rec.blocked) out.push(`${label}: that event can't go on a plan (${rec.blocked})`);
        if (!rec.startAt) out.push(`${label}: that event's record has no start time`);
        // An event on a plan is an event offered: started, or starting too soon to get there, it can't go on (START_LEAD_MINUTES;
        // Royce, 2026-10-17). The hour's grace below is for their own steps, not an event's.
        const late = eventStartProblem({ startAt: rec.startAt, endAt: rec.endAt }, o.now, START_LEAD_MINUTES, rec.timezone ?? null);
        if (late) out.push(`${label}: that event can't go on a plan (${late})`);
      }
    } else {
      if (raw.when && !LOCAL.test(raw.when)) out.push(`${label}: the time must be their local date and time like 2026-10-11T16:30, with no zone and never a date alone`);
      if (raw.until && !LOCAL.test(raw.until)) out.push(`${label}: the end time must be like 2026-10-11T18:00`);
      if (raw.until && !raw.when) out.push(`${label}: an end time needs a start time`);
      if (raw.when && LOCAL.test(raw.when) && !s.start) out.push(`${label}: the time isn't a real date and time`);
      if (raw.until && LOCAL.test(raw.until) && !s.end) out.push(`${label}: the end time isn't a real date and time`);
      // What a free step states has to be something read or said.
      for (const field of [s.where, s.address]) if (field && !backed(field, have)) out.push(`${label}: "${field}" isn't something a page you read or the member said`);
    }
    if (s.start && s.start.toMillis() < o.now.getTime() - 3_600_000) out.push(`${label}: that time has already passed`);
    if (s.start && s.start > horizon) out.push(`${label}: more than ${PLAN_LIMITS.daysAhead} days out`);
    if (s.start && s.end && s.end < s.start) out.push(`${label}: it ends before it starts`);
    const text = [s.what, s.detail].filter(Boolean).join("\n");
    for (const n of numbersUnbacked(text, have)) out.push(`${label}: "${n}" isn't in what you read or what they said (put times in the time field)`);
    for (const w of wordAmounts(text)) if (!backed(w, have)) out.push(`${label}: "${w}" isn't in what you read or what they said`);
    for (const p of placesBacked(text, have).missing) out.push(`${label}: "${p}" isn't in what you read or what they said`);
    for (const w of namedThings(text)) if (!backed(w, have)) out.push(`${label}: "${w}" isn't a name you read or the member said`);
  });
  // The title, note and notes are held to the same rule: the title is also the text and the email subject.
  const rest = [plan.title, plan.note, ...plan.notes].join("\n");
  for (const n of numbersUnbacked(rest, have)) out.push(`"${n}" in the title or note isn't in what you read or what they said`);
  for (const w of wordAmounts(rest)) if (!backed(w, have)) out.push(`"${w}" in the title or note isn't in what you read or what they said`);
  for (const w of namedThings(rest)) if (!backed(w, have)) out.push(`"${w}" in the title or note isn't a name you read or the member said`);
  return out;
}

// ---------- the calendar file

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Lines are folded at 75 octets, continuation lines start with a space (RFC 5545).
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}
const utc = (d: DateTime) => d.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");

// Pure: the .ics for every timed step. A step with no end is held for an hour.
export function buildIcs(plan: Plan, o: { seed: string; now: Date }): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cue//Plan//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(plan.title)}`];
  plan.steps.forEach((s, i) => {
    if (!s.start) return;
    const end = s.end ?? s.start.plus({ hours: 1 });
    const where = [s.where, s.address].filter(Boolean).join(", ");
    const desc = [s.detail, ...(i === 0 ? [] : [])].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${o.seed}-${i + 1}@copatible.com`,
      `DTSTAMP:${utc(DateTime.fromJSDate(o.now))}`,
      `DTSTART:${utc(s.start)}`,
      `DTEND:${utc(end)}`,
      `SUMMARY:${esc(s.what)}`,
      ...(where ? [`LOCATION:${esc(where)}`] : []),
      ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []),
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
export const hasTimedSteps = (plan: Plan) => plan.steps.some((s) => s.start);

// ---------- the sheet

export const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
export const SANS = "'Satoshi', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

const dayHeading = (d: DateTime) => d.toFormat("cccc, LLLL d");
const clock = (d: DateTime) => d.toFormat("h:mm a").replace(":00 ", " ").toLowerCase();

// Pure: the one-page sheet, as HTML for the PDF. Cream paper, one hairline per step, no logo,
// no footer: "Prepared for", the plan, and Co's closing line.
export function planHtml(plan: Plan, firstName: string): string {
  const e = escapeHtml;
  const groups: { heading: string | null; steps: PlanStep[] }[] = [];
  for (const s of plan.steps) {
    const heading = s.start ? dayHeading(s.start) : null;
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.steps.push(s);
    else groups.push({ heading, steps: [s] });
  }
  const step = (s: PlanStep) => {
    const time = s.start ? `${clock(s.start)}${s.end ? `<span class="to"> to ${clock(s.end)}</span>` : ""}` : "";
    const place = [s.where, s.address].filter(Boolean).join(", ");
    return `<div class="step"><div class="time">${time}</div><div class="body"><div class="what">${e(s.what)}</div>${place ? `<div class="where">${e(place)}</div>` : ""}${s.detail ? `<div class="detail">${e(s.detail)}</div>` : ""}</div></div>`;
  };
  const body = groups.map((g) => `${g.heading ? `<div class="day">${e(g.heading)}</div>` : ""}${g.steps.map(step).join("")}`).join("");
  const notes = plan.notes.length ? `<div class="notes"><div class="eyebrow">Worth knowing</div>${plan.notes.map((n) => `<p>${e(n)}</p>`).join("")}</div>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${e(plan.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;1,300;1,400&display=swap" rel="stylesheet">
<style>
@page { size: Letter; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: ${C.cream}; color: ${C.body}; font-family: ${SANS}; font-size: 12.5px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 8.5in; min-height: 11in; padding: 0.9in 1in 0.8in 1in; display: flex; flex-direction: column; }
.card { flex: 1; border: 1px solid ${C.gold}; padding: 0.55in 0.6in 0.5in 0.6in; background: ${C.white}; display: flex; flex-direction: column; }
.eyebrow { font-family: ${SANS}; font-size: 10px; font-weight: 500; letter-spacing: 2px; text-transform: uppercase; color: ${C.gold}; }
h1 { font-family: ${SERIF}; font-weight: 300; font-size: 34px; line-height: 1.12; color: ${C.ink}; margin: 10px 0 6px 0; letter-spacing: -0.2px; }
.lede { font-family: ${SERIF}; font-style: italic; font-weight: 300; font-size: 14.5px; color: ${C.soft}; margin: 0 0 22px 0; }
.rule { border: 0; border-top: 1px solid ${C.line}; margin: 0 0 6px 0; }
.day { font-family: ${SANS}; font-size: 10px; font-weight: 500; letter-spacing: 1.6px; text-transform: uppercase; color: ${C.muted}; margin: 18px 0 4px 0; }
.step { display: flex; gap: 22px; padding: 11px 0; border-bottom: 1px solid ${C.line}; page-break-inside: avoid; }
.time { width: 1.15in; flex: none; font-family: ${SERIF}; font-size: 15px; color: ${C.ink}; padding-top: 1px; }
.time .to { font-size: 12px; color: ${C.muted}; }
.what { font-family: ${SERIF}; font-size: 17px; line-height: 1.3; color: ${C.ink}; }
.where { color: ${C.soft}; margin-top: 2px; }
.detail { color: ${C.muted}; margin-top: 3px; font-style: italic; }
.notes { margin-top: 24px; }
.notes p { margin: 7px 0 0 0; color: ${C.body}; }
.spacer { flex: 1; }
.close { text-align: center; padding-top: 26px; font-family: ${SERIF}; font-style: italic; font-weight: 300; font-size: 14px; color: ${C.soft}; }
.close .co { display: block; margin-top: 6px; font-size: 18px; color: ${C.ink}; }
</style></head><body><div class="page"><div class="card">
<div class="eyebrow">Prepared for ${e(firstName || "you")}</div>
<h1>${e(plan.title)}</h1>
${plan.note ? `<p class="lede">${e(plan.note)}</p>` : ""}
<hr class="rule">
${body}
${notes}
<div class="spacer"></div>
<div class="close">If anything shifts, tell me and I'll rework it.<span class="co">Cue</span></div>
</div></div></body></html>`;
}

// ---------- the email

// Pure: the email around the attachments, in Co's voice. Short; the sheet is the point.
export function planEmail(plan: Plan, o: { firstName: string; calendar: boolean }): { subject: string; html: string; text: string } {
  const attached = o.calendar ? "The sheet is attached, with a calendar hold for each time." : "The sheet is attached.";
  const lines = [plan.note || "Here it is, laid out."];
  return {
    subject: plan.title,
    html: quietEmail({ preview: plan.note || plan.title, headline: plan.title, lines: [...lines, attached] }),
    text: `${o.firstName ? `${o.firstName}, ` : ""}${lines.join(" ")}\n\n${attached}\n\nCue`,
  };
}
