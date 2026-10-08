// A delivered document that's gone stale (2026-10-08 review A1). A plan or brief Co sent can stop matching what's true: the headcount
// or the date in their working notes changed after it went, they passed on an option it lists (findReaction "no"), and the event it's
// for is close. Code works out THAT it drifted and how, as a fact; Co decides whether this message is the moment to raise it, offers
// at most once per document version (recorded in document_offers, services/documentOffer.ts), and never in a heavy moment. On a yes
// it reads the document (readDocument) and sends the next version (writeDocument with revises and changed).
//
// Pure: no reads here. The turn (services/turnContext.ts) loads the receipts, the working notes and their reactions, each scoped to
// the one member.
import type { Doc } from "./documentSheet.js";

export type DriftDoc = { id: number; version: number; title: string; doc: Doc; deliveredAt: Date };
export type NowTrue = {
  // Co's working notes for them (services/searchIntent.ts search_briefs), with when they last changed.
  notes?: { headcount?: number | null; when?: string | null; updatedAt?: Date | null } | null;
  // Options they said no to (research_finds outcome 'no'), with when.
  rejected?: { name: string; at: Date }[];
  // The event it's about, when one is on file (their Co event today).
  eventStartsAt?: Date | null;
};
export type Drift = { docId: number; version: number; title: string; reasons: string[]; urgent: boolean; key: string };

export const DRIFT = { urgentHours: 48 };

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_DAY = new RegExp(String.raw`\b(${MONTHS})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "gi");
const WEEKDAY = /\b(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/gi;
const PEOPLE = /\b(\d{1,4})\s*(?:people|guests|attendees|seats|seated|persons?|founders|heads|pax|ppl)\b|\bfor (\d{1,4})\b(?!\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|dollars|\$|%|am|pm|:))/gi;

const textOf = (d: Doc) => [d.title, d.note, ...d.sections.flatMap((s) => [s.heading ?? "", ...s.paragraphs, ...s.bullets]), ...d.suggestions].join("\n");
const monthDays = (t: string) => [...t.matchAll(MONTH_DAY)].map((m) => `${m[1].slice(0, 3).toLowerCase()} ${Number(m[2])}`);
const weekdays = (t: string) => [...t.matchAll(WEEKDAY)].map((m) => m[1].slice(0, 3).toLowerCase());
const headcounts = (t: string) => [...t.matchAll(PEOPLE)].map((m) => Number(m[1] ?? m[2])).filter((n) => n >= 2 && n <= 5000);

// Pure: how a delivered document no longer matches what's true now, or null when it still does.
export function receiptDrift(d: DriftDoc, now: NowTrue, at: Date = new Date()): Drift | null {
  const text = textOf(d.doc);
  const reasons: string[] = [];
  const notes = now.notes ?? null;
  const changedSince = !!notes?.updatedAt && notes.updatedAt.getTime() > d.deliveredAt.getTime();
  if (changedSince && notes?.headcount) {
    const said = [...new Set(headcounts(text))];
    if (said.length && !said.includes(notes.headcount)) reasons.push(`it says ${said.join(" or ")} people, and it's ${notes.headcount} now`);
  }
  if (changedSince && notes?.when) {
    const wantMd = monthDays(notes.when);
    const wantWd = weekdays(notes.when);
    const docMd = [...new Set(monthDays(text))];
    const docWd = [...new Set(weekdays(text))];
    if (wantMd.length && docMd.length && !wantMd.some((x) => docMd.includes(x))) reasons.push(`it says ${docMd[0]}, and the date is now ${notes.when}`);
    else if (!wantMd.length && wantWd.length && docWd.length && !wantWd.some((x) => docWd.includes(x))) reasons.push(`it's built around ${docWd[0]}, and it's now ${notes.when}`);
  }
  const lower = text.toLowerCase();
  for (const r of now.rejected ?? []) {
    const name = r.name.trim();
    if (name.length >= 3 && r.at.getTime() > d.deliveredAt.getTime() && lower.includes(name.toLowerCase())) reasons.push(`it lists ${name}, which they passed on after it went`);
  }
  const hoursOut = now.eventStartsAt ? (now.eventStartsAt.getTime() - at.getTime()) / 3_600_000 : null;
  const urgent = hoursOut !== null && hoursOut > 0 && hoursOut <= DRIFT.urgentHours;
  if (!reasons.length && urgent && changedSince) reasons.push("their plans changed after it went (the working notes were updated since)");
  if (!reasons.length) return null;
  return { docId: d.id, version: d.version, title: d.title, reasons: reasons.slice(0, 3), urgent, key: driftKey(d.id, d.version) };
}

// The offer's record key: one offer per document version.
export const driftKey = (id: number, version: number) => `doc #${id} v${version}`;

// Pure: the fact line Co reads.
export function driftLine(x: Drift): string {
  return `Doc #${x.docId} ("${x.title}", version ${x.version}) may be out of date: ${x.reasons.join("; ")}.${x.urgent ? " The event it's for is within 48 hours." : ""}`;
}
