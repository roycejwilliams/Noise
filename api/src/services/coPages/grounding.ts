// Whose data can be on a page (security review, 2026-10-11, finding H2): only the page owner's own words and what Co read for them.
// A page is published to anyone with its link, so it gets the document path's grounding (services/documentSheet.ts
// documentProblems), applied to every line on the page: each one must rest on the owner's own texts and calls (loadTheirWords: their
// user id only, teammate texts left out) or on pages Co read this turn. Anything else in Co's context (another member, the people
// graph, a teammate's note) has no source here, so it can't reach a page. The store refuses a page that fails this (store.ts).
import type { CoPageData } from "./schema.js";
import { placeholderIn } from "./art.js";
import { unsourced } from "../offerGuard.js";
import * as OG from "../offerGuard.js";
import { unbackedClaims } from "../documentGrounding.js";

export type PageSource = { theirs: string; read: string };

// Pure: every line of text a page shows, with where it is (for the problem message).
export function pageLines(d: CoPageData): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [{ where: "title", text: d.title }, { where: "context", text: d.context }];
  d.sections.forEach((s, i) => {
    const at = `section ${i + 1}`;
    out.push({ where: `${at} heading`, text: s.heading });
    if (s.place) out.push({ where: `${at} place`, text: s.place });
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
    // A bracketed gap never ships on a page either (the deck rule below; review: "[Gallery]" in a title).
    if (placeholderIn(l.text)) out.push(`${l.where}: "${placeholderIn(l.text)}" is a placeholder, and a page never ships one: ask them for the missing piece, or write it without it`);
    const bad = unsourced(sameTimes(l.text), corpus);
    if (bad.length) out.push(`${l.where}: "${l.text.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  // Headings and the title are Co's labels; the content lines are the claims.
  const claims = pageLines(d).filter((l) => !/heading$|^title$|place$/.test(l.where));
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
    ...d.slides.flatMap((s, i) => [{ where: `slide ${i + 2} headline`, text: s.headline }, ...s.bullets.map((b) => ({ where: `slide ${i + 2}`, text: b })), ...(s.notes ? [{ where: `slide ${i + 2} notes`, text: s.notes }] : []), ...(s.place ? [{ where: `slide ${i + 2} place`, text: s.place }] : [])]),
  ];
  const out: string[] = [];
  for (const l of lines) {
    // A bracketed gap is a live placeholder on a shareable link (2026-10-12: "[Example seat to drop in: who sat where...]" went to
    // the importer). It never ships: ask them for the missing piece, or make the slide the point without it.
    if (placeholderIn(l.text)) out.push(`${l.where}: "${placeholderIn(l.text)}" is a placeholder, and a deck never ships one: ask them for the missing piece, or write the slide as the point itself without the example`);
    const bad = unsourced(l.text, corpus);
    if (bad.length) out.push(`${l.where}: "${l.text.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read`);
  }
  return out.slice(0, 7);
}

// ---------------------------------------------------------------- headline case (2026-10-12)
// The deck composer wrote Title Case headlines ("Why Co Wins Against Parties"), and the name check above read every capitalized run as
// a name nobody gave; asking for sentence case over-corrected into all lowercase ("why co wins against parties"). Headlines are put
// in sentence case here, in code, before any check: the first word capitalized, every common word lowercase, and a word kept
// capitalized when it's a name (capitalized mid-sentence in what they said, an acronym, or "I"). A capitalized word that is neither
// common nor theirs stays capitalized, so the name check still catches a name the member never gave ("Backed by Sequoia").
export const COMMON = new Set(
  (
    "a about above across after again against all almost alone along already also always am among an and another any anyone anything are around as at away back be because been before being below best better between beyond big both bring build built but by can can't change clear come comes coming could cut day days deal does doing done don't down each early easy end enough even every everyone everything fast few find first for from full get gets give go goes going good great grow growth had has have having help her here high his how if in inside instead into is it it's its just keep kind know last later lead less let like little live long look love made make makes making many matter matters may me meet more most move much must my need needs never new next no not nothing now of off on once one only open or other our out over own part people place plan play point power pro real really right room rooms run same say see set should show side simple small so some start stay still stop such take than that the their them then there these they thing things think this those through time to today together too top true turn under up us use very want was way ways we well what when where which while who why will win wins winning with without work works world would year years yet you your " +
    "ask audience better bigger business case clients community company cost costs customer customers data demand design event events experience focus future guest guests idea ideas impact intro intros market members model moment money night nights offer outcome party parties pitch premium price private problem product proof question reason results revenue roadmap scale service social solution space story strategy team tech the then traction value why yes raise raising round seed investors investor second third opening open table tables seat seats chef chefs menu loop format city month monthly week weekly night nightly dinner dinners host hosts venue venues ticket tickets"
  ).split(/\s+/).filter(Boolean),
);
// Pure: is a headline in Title Case (most words after the first capitalized) or all lowercase. Only these are recased: a headline
// already in sentence case keeps its capitals, which are names the writer meant (review of the design system PR).
const JOINERS = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "vs", "&"]);
export function needsCasing(text: string): "title" | "lower" | null {
  const ws = text.split(/\s+/).map((w) => w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "")).filter((w) => /^[A-Za-z]/.test(w));
  if (ws.length && ws.every((w) => w === w.toLowerCase())) return "lower";
  const rest = ws.slice(1).filter((w) => !JOINERS.has(w.toLowerCase()) && !/^[A-Z0-9&]{2,}$/.test(w));
  const capped = rest.filter((w) => /^[A-Z]/.test(w));
  if (rest.length >= 3 && capped.length / rest.length >= 0.75) return "title";
  // Two words after the first, both capitalized: Title Case only when both are common words ("One Long Table"), else a name
  // ("Partnering with Founders Club").
  if (rest.length === 2 && capped.length === 2 && rest.every((w) => COMMON.has(w.toLowerCase()))) return "title";
  return null;
}

// Pure: the name check on a headline as the composer wrote it, before any casing (review of the design system PR: casing must never
// hide a name). Every capitalized run after the first word, in their words or not: in sentence case each is a name the writer meant;
// in Title Case a run counts as a name only when it holds a word that isn't a common word, so "Why Co Wins Against Parties" passes
// and "Partnering With Founders Club And Signal" does not. Unlike the event check, this runs on every headline.
export function headlineNameProblems(headline: string, theirWords: string, where: string): string | null {
  const { mentionsIn } = OG;
  const casing = needsCasing(headline);
  if (casing === "lower") return null;
  const hay = ` ${theirWords.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `;
  const bad = mentionsIn(headline)
    .filter((m) => m.kind === "name")
    .filter((m) => {
      const parts = m.text.toLowerCase().split(/\s+/).filter((p) => p.length > 1 && !JOINERS.has(p));
      if (!parts.length) return false;
      if (casing === "title" && parts.every((p) => COMMON.has(p) || hay.includes(` ${p} `))) return false;
      return !parts.every((p) => hay.includes(` ${p} `) || hay.includes(` ${p}s `) || (p.endsWith("s") && hay.includes(` ${p.slice(0, -1)} `)));
    });
  return bad.length ? `${where}: "${headline.slice(0, 70)}" names ${bad.map((m) => m.text).join(", ")}, which they never said and you never read` : null;
}

export function headlineCase(text: string, theirWords: string): string {
  if (!needsCasing(text)) return text.replace(/^(\W*)([a-z])/, (_m, a: string, b: string) => `${a}${b.toUpperCase()}`);
  const words = text.split(/(\s+)/);
  // Words they capitalize mid-sentence (not after . ! ? or a line start): their names, in their spelling.
  const named = new Map<string, string>();
  const lowerSeen = new Set<string>();
  const startCaps = new Map<string, string>();
  for (const sentence of theirWords.split(/(?<=[.!?\n])\s+/)) {
    sentence.split(/\s+/).forEach((w, i) => {
      const bare = w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "");
      if (!bare) return;
      if (/^[a-z]/.test(bare)) lowerSeen.add(bare.toLowerCase());
      else if (i > 0 && /^[A-Z]/.test(bare)) named.set(bare.toLowerCase(), bare);
      else if (i === 0 && /^[A-Z]/.test(bare)) startCaps.set(bare.toLowerCase(), bare);
    });
  }
  // Capitalized only at the start of their sentences, never written lowercase and not a common word: still their name ("Co is great").
  for (const [k, v] of startCaps) if (!named.has(k) && !lowerSeen.has(k) && !COMMON.has(k) && k.length > 1) named.set(k, v);
  let first = true;
  return words
    .map((w) => {
      if (/^\s+$/.test(w) || !w) return w;
      const m = w.match(/^([("'“]*)(.*?)([)"'”.,!?;:]*)$/)!;
      const [, pre, core, post] = m;
      if (!core) return w;
      const lower = core.toLowerCase();
      let out = core;
      if (/^[A-Z0-9&]{2,}$/.test(core) && /[A-Z]/.test(core)) out = core; // an acronym: AI, SF, B2B
      else if (lower === "i" || lower.startsWith("i'")) out = `I${core.slice(1)}`;
      else if (named.has(lower) && !(lowerSeen.has(lower) && COMMON.has(lower))) out = named.get(lower)!;
      else if (first) out = core[0].toUpperCase() + core.slice(1);
      else if (/^[A-Z][a-z'’-]*$/.test(core) && (COMMON.has(lower) || lowerSeen.has(lower))) out = lower;
      else if (/^[a-z]/.test(core)) out = core;
      if (first) out = out[0].toUpperCase() + out.slice(1);
      // A second sentence in the headline ("Down to collaborate? We're ready") starts with a capital too.
      first = /[.?!:]$/.test(post);
      return `${pre}${out}${post}`;
    })
    .join("");
}
