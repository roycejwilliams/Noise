// Whose data can be on a page (security review, 2026-10-11, finding H2): only the page owner's own words and what Co read for them.
// A page is published to anyone with its link, so it gets the document path's grounding (services/documentSheet.ts
// documentProblems), applied to every line on the page: each one must rest on the owner's own texts and calls (loadTheirWords: their
// user id only, teammate texts left out) or on pages Co read this turn. Anything else in Co's context (another member, the people
// graph, a teammate's note) has no source here, so it can't reach a page. The store refuses a page that fails this (store.ts).
import type { CoPageData } from "./schema.js";
import { unsourced } from "../offerGuard.js";
import { unbackedClaims } from "../documentGrounding.js";

export type PageSource = { theirs: string; read: string };

// Pure: every line of text a page shows, with where it is (for the problem message).
export function pageLines(d: CoPageData): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [{ where: "title", text: d.title }, { where: "context", text: d.context }];
  d.sections.forEach((s, i) => {
    const at = `section ${i + 1}`;
    out.push({ where: `${at} heading`, text: s.heading });
    for (const b of s.blocks) {
      if (b.type === "text") out.push({ where: at, text: b.text });
      if (b.type === "bullets") for (const it of b.items) out.push({ where: at, text: it.lead ? `${it.lead}: ${it.text}` : it.text });
      // A fact's label ("Price") is Co's column name, like a heading; its value is the claim.
      if (b.type === "comparison") for (const o of b.options) out.push({ where: at, text: [o.name, ...o.facts.map((f) => f.value), o.note ?? ""].filter(Boolean).join(". ") });
      if (b.type === "links") for (const it of b.items) out.push({ where: at, text: [it.name, it.note ?? ""].filter(Boolean).join(". ") });
    }
  });
  for (const s of d.sources) out.push({ where: "sources", text: s.label });
  return out.filter((l) => l.text.trim());
}

// Pure: what on the page nothing backs. Empty means the page may be stored.
// Pure: one way of writing a time and a date, so the same fact matches however it was typed (live runs, 2026-10-11: a member's "7pm"
// refused the page's "7:00 PM", and "Oct 24" refused "October 24"). Review of PR 2 kept it narrow:
//   - times keep their am/pm ("7:00 PM" and "7 pm" are both "7pm"); only in the member's words (sameTimes(s, "theirs")) does a bare
//     time ("at 7", "7:45") also stand for 7am and 7pm. A page's "7 AM" never matches their "7pm";
//   - only a capitalized short month or weekday next to a date expands ("Oct 24", "Sat Oct 24"), so "I sat" or "the sun" never do.
const MONTHS: Record<string, string> = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Sept: "September", Oct: "October", Nov: "November", Dec: "December" };
const DAYS: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Tues: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Thur: "Thursday", Thurs: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const MON = Object.keys(MONTHS).join("|");
export function sameTimes(s: string, side: "page" | "theirs" = "page"): string {
  let out = s
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi, (_m, h: string, mm: string | undefined, ap: string) => `${Number(h)}${mm && mm !== "00" ? `:${mm}` : ""}${ap.toLowerCase().startsWith("p") ? "pm" : "am"}`)
    .replace(new RegExp(`\\b(${MON})\\.?(?=\\s+\\d)`, "g"), (_m, w: string) => MONTHS[w])
    .replace(new RegExp(`\\b(${Object.keys(DAYS).join("|")})\\.?(?=,?\\s+(\\d|${MON}|${Object.values(MONTHS).join("|")}))`, "g"), (_m, w: string) => DAYS[w]);
  if (side === "theirs") out = out.replace(/\b(at|by|from|until|til|around)\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:am|pm|:\d))/gi, (m, _p, h: string, mm: string | undefined) => `${m} ${h}${mm ? `:${mm}` : ""}am ${h}${mm ? `:${mm}` : ""}pm`).replace(/\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm|:\d))/gi, (m, h: string, mm: string) => `${m} ${h}:${mm}am ${h}:${mm}pm`);
  return out;
}
// Pure: Co's own short labels before a colon ("Schedule: cocktails at 7") are labels, like a heading, not claims. Only these words:
// anything else before a colon (a name, "Ellis Park:") is read as part of the line (review of PR 2).
const LABELS = /^\s*(schedule|timing|time|when|where|details|notes|dress|dress code|address|getting there|cost|price|budget|plan|food|drinks|the plan|the night)\s*:\s+/i;
const unlabeled = (s: string) => s.replace(LABELS, "");

export function pageProblems(d: CoPageData, source: PageSource): string[] {
  // A bare time stands for am and pm only in their own words, never in a page Co read ("open until 11"): review of PR 2.
  const corpus = `${sameTimes(source.theirs, "theirs")}\n${sameTimes(source.read)}`;
  const out: string[] = [];
  for (const l of pageLines(d)) {
    const bad = unsourced(sameTimes(l.text), corpus);
    if (bad.length) out.push(`${l.where}: "${l.text.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  // Headings and the title are Co's labels; the content lines are the claims.
  const claims = pageLines(d).filter((l) => !/heading$|^title$/.test(l.where));
  for (const u of unbackedClaims(claims.map((l) => unlabeled(sameTimes(l.text))), corpus).slice(0, 4)) {
    out.push(`"${u.text.slice(0, 90)}" isn't backed by what they said or what you read (nothing puts ${u.missing.slice(0, 4).join(", ")} together)`);
  }
  return out.slice(0, 7);
}

// A deck (deck.ts): every name, number and place on it rests on the owner's own words or what Co read for them, so a deck can't
// invent a customer, a figure or another member. A deck is their story in Co's words ("Built for independent studios"), so the
// word-for-word claim check pages use is left off (live run, 2026-10-11: it refused "Built for..." and "No-shows eat a fifth of
// bookings", both said in their own text); facts are guarded, phrasing isn't.
export function deckProblems(d: import("./deck.js").DeckData, source: PageSource): string[] {
  const corpus = `${source.theirs}\n${source.read}`;
  const lines: { where: string; text: string }[] = [
    { where: "title", text: d.title },
    { where: "subtitle", text: d.subtitle },
    ...d.slides.flatMap((s, i) => [{ where: `slide ${i + 2} headline`, text: s.headline }, ...s.bullets.map((b) => ({ where: `slide ${i + 2}`, text: b }))]),
  ];
  const out: string[] = [];
  for (const l of lines) {
    const bad = unsourced(l.text, corpus);
    if (bad.length) out.push(`${l.where}: "${l.text.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  return out.slice(0, 7);
}
