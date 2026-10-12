// What Co believes about a member, as claims with a label and a lifetime (Royce, 2026-10-06).
//
// Why: the nightly recap used to REVISE its own previous recap, so "preparing to pitch investors Friday" (said 9/29, for Friday
// 10/2) survived every night's revision until the 10/6 post-call text stated it back. Nothing ever expired it, and nothing said
// whether it was something they said or something Co made of it.
//
// Two labels on every claim:
//   provenance  user_said    they said it, and the claim carries their own words (a quote that is verifiably in what they sent)
//               co_inferred  Co concluded it: it can orient a draft, but is never stated back as "you told me" or "you've been prepping"
//   lifetime    enduring     who they are: what they're building, their city, their cofounder. Persists.
//               ephemeral    plans, deadlines, moods, explorations, worries, pending decisions. Expires on its own, in code,
//                            unless they say it again (re-confirmed) or it is dated, in which case it ends the day after the date.
// The model proposes a claim and its kind; CODE decides the lifetime from the kind, checks the quote is theirs (else the claim is
// downgraded to co_inferred), and resolves a relative day against when it was said.
import { DateTime } from "luxon";
// Days are the member's: callers pass their zone (services/memberTime.ts); the default is only the fallback.
import { FALLBACK_ZONE } from "./localHours.js";

export type Provenance = "user_said" | "co_inferred";
export type Lifetime = "enduring" | "ephemeral";

// kind -> lifetime, and how long an undated ephemeral claim lasts (days from when it was said or last re-confirmed).
export const KINDS = {
  identity: { lifetime: "enduring" },
  building: { lifetime: "enduring" },
  relationship: { lifetime: "enduring" },
  city: { lifetime: "enduring" },
  role: { lifetime: "enduring" },
  preference: { lifetime: "enduring" },
  plan: { lifetime: "ephemeral", ttlDays: 7 },
  deadline: { lifetime: "ephemeral", ttlDays: 3 },
  meeting: { lifetime: "ephemeral", ttlDays: 3 },
  mood: { lifetime: "ephemeral", ttlDays: 3 },
  exploring: { lifetime: "ephemeral", ttlDays: 10 },
  worry: { lifetime: "ephemeral", ttlDays: 10 },
  pending_decision: { lifetime: "ephemeral", ttlDays: 14 },
  // Away from home ("I'm traveling", "out of town until the 20th"), 2026-10-11: written the moment they say it (services/away.ts),
  // ends the day after a date they named, else a week on unless they say it again, and at once when they say they're back. While
  // it holds, finds tied to where they live wait.
  away: { lifetime: "ephemeral", ttlDays: 7 },
} as const;
export type Kind = keyof typeof KINDS;
export const KIND_LIST = Object.keys(KINDS) as Kind[];
// What Co concluded, rather than heard, decays faster than what they said.
export const INFERRED_MAX_DAYS = 7;

export type Claim = {
  text: string;
  provenance: Provenance;
  kind: Kind;
  quote: string | null;
  saidOn: string; // YYYY-MM-DD
  confirmedOn: string; // YYYY-MM-DD, last time they said it again
  expiresOn: string | null; // YYYY-MM-DD, null for enduring
};

const norm = (s: string) => ` ${String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;

// A user_said claim must carry their words, and the words must really be in what they sent. Otherwise it is Co's inference.
export function checkProvenance(p: Provenance, quote: string | null | undefined, theirText: string): { provenance: Provenance; quote: string | null } {
  const q = (quote ?? "").trim();
  if (p === "user_said" && q.length >= 8 && norm(theirText).includes(norm(q))) return { provenance: "user_said", quote: q };
  return { provenance: "co_inferred", quote: null };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// The date a claim is about, if its words name one, resolved against the day it was said ("Friday", said on a Tuesday, is the
// coming Friday; "Oct 9"; "2026-10-09"; "tomorrow"). Null when it names none.
export function resolveDate(words: string, saidOn: string, zone = FALLBACK_ZONE): string | null {
  const said = DateTime.fromISO(saidOn, { zone }).startOf("day");
  if (!said.isValid) return null;
  const t = words.toLowerCase();
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  // Real month names only ("decide 2 hires" and "marketing 3 channels" are not December 2 and March 3).
  const md = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const month = MONTHS.findIndex((m) => m.startsWith(md[1].slice(0, 3))) + 1;
    let d = DateTime.fromObject({ year: said.year, month, day: Number(md[2]) }, { zone });
    // A date already behind them is next year's only when it is close ("Jan 5", said in December); a date months back is simply past.
    if (d.isValid && d < said.minus({ days: 1 })) {
      const next = d.plus({ years: 1 });
      if (+next - +said <= 120 * 86_400_000) d = next;
    }
    if (d.isValid) return d.toISODate();
  }
  if (/\btomorrow\b/.test(t)) return said.plus({ days: 1 }).toISODate();
  if (/\b(today|tonight)\b/.test(t)) return said.toISODate();
  const wd = t.match(new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`));
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]); // 0 = sunday
    const have = said.weekday % 7;
    const ahead = (target - have + 7) % 7; // the same weekday means today
    return said.plus({ days: ahead }).toISODate();
  }
  return null;
}

// ---------- the whole span words name (2026-10-12 intelligence audit: "Paris Oct 28 to Nov 6" expired Oct 29, and "Thanksgiving
// week", "in November" and "June 12 2027" fell back to a week, or ended a year early)
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monthNo = (m: string) => MONTHS.findIndex((x) => x.startsWith(m.slice(0, 3))) + 1;
const nthWeekday = (year: number, month: number, weekday: number, n: number, zone: string) => {
  // weekday: luxon's 1 = Monday .. 7 = Sunday; n = -1 for the last one.
  if (n > 0) {
    const first = DateTime.fromObject({ year, month, day: 1 }, { zone });
    return first.plus({ days: ((weekday - first.weekday + 7) % 7) + (n - 1) * 7 });
  }
  const last = DateTime.fromObject({ year, month, day: 1 }, { zone }).endOf("month").startOf("day");
  return last.minus({ days: (last.weekday - weekday + 7) % 7 });
};
// [month, day] or a rule for the year; "week"/"weekend" after it runs to the Sunday after.
const HOLIDAYS: { re: RegExp; on: (y: number, zone: string) => DateTime }[] = [
  { re: /\bthanksgiving\b/, on: (y, z) => nthWeekday(y, 11, 4, 4, z) },
  { re: /\bchristmas eve\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 12, day: 24 }, { zone: z }) },
  { re: /\b(christmas|xmas)\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 12, day: 25 }, { zone: z }) },
  { re: /\bnew year'?s eve\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 12, day: 31 }, { zone: z }) },
  { re: /\bnew year'?s(?: day)?\b/, on: (y, z) => DateTime.fromObject({ year: y + 1, month: 1, day: 1 }, { zone: z }) },
  { re: /\b(the )?holidays\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 12, day: 31 }, { zone: z }) },
  { re: /\bhalloween\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 10, day: 31 }, { zone: z }) },
  { re: /\bvalentine'?s\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 2, day: 14 }, { zone: z }) },
  { re: /\b(fourth of july|independence day)\b/, on: (y, z) => DateTime.fromObject({ year: y, month: 7, day: 4 }, { zone: z }) },
  { re: /\bmemorial day\b/, on: (y, z) => nthWeekday(y, 5, 1, -1, z) },
  { re: /\blabor day\b/, on: (y, z) => nthWeekday(y, 9, 1, 1, z) },
];

// Pure: the first and last day words name, resolved against the day they were said, or null when they name none. Covers what
// resolveDate reads plus: every month-and-day in the words (a range "Oct 28 to Nov 6" spans both; "Oct 28-30" ends the 30th), an
// explicit year ("June 12 2027"), a month alone ("in November", "first week of November": the month, or its part), common
// holidays ("Thanksgiving week" runs to the Sunday after), a year alone ("in 2027": the year), "next week/month/year".
// exactEnd: the last day named exactly (a month and day, an ISO date, a weekday, tomorrow), or null when every day it names is
// fuzzy (a month alone, a holiday, a year, next week). Only an exact day may end a claim before its kind's lifetime would.
// One roll-forward window for every bare date (ROLL_DAYS): a date behind them is next year's only when that is close. A month
// alone in past-tense words ("moved here in March") is never rolled forward.
export const ROLL_DAYS = 120;
const PAST_TENSE = /\b(moved|went|was|were|did|had|started|began|joined|left|graduated|got|came|met|finished|launched|raised|quit|ago|used to)\b/;
export function dateSpan(words: string, saidOn: string, zone = FALLBACK_ZONE): { start: string; end: string; exactEnd: string | null } | null {
  const said = DateTime.fromISO(saidOn, { zone }).startOf("day");
  if (!said.isValid) return null;
  const t = words.toLowerCase().replace(/[’‘]/g, "'");
  const spans: [DateTime, DateTime][] = [];
  const exact: DateTime[] = [];
  const day = (d: DateTime) => [d, d] as [DateTime, DateTime];
  // A date already behind them is next year's only when it is close (the same rule as resolveDate).
  const ahead = (d: DateTime) => (d < said.minus({ days: 1 }) && +d.plus({ years: 1 }) - +said <= ROLL_DAYS * 86_400_000 ? d.plus({ years: 1 }) : d);
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = DateTime.fromISO(m[0], { zone });
    if (d.isValid) { spans.push(day(d)); exact.push(d); }
  }
  const mdRe = new RegExp(`\\b(${MONTH_RE})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?::|am\\b|pm\\b))(?:,?\\s+(20\\d{2})\\b)?(?:\\s*(?:-|–|to|through|thru|until|till)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?::|am\\b|pm\\b))(?!\\s+(?:${MONTH_RE})\\b))?`, "g");
  for (const m of t.matchAll(mdRe)) {
    const month = monthNo(m[1]);
    const year = m[3] ? Number(m[3]) : said.year;
    let d: DateTime = DateTime.fromObject({ year, month, day: Number(m[2]) }, { zone });
    if (!d.isValid) continue;
    if (!m[3]) d = ahead(d);
    let e: DateTime = m[4] ? d.set({ day: Number(m[4]) }) : d;
    if (!e.isValid || e < d) e = d;
    spans.push([d, e]);
    exact.push(e);
  }
  // A month alone, after a word that makes it a time ("in may", not "I may"): the month, or the part of it they named.
  // "May" alone is the month only as they wrote it, capitalized ("this may slip" is not May).
  const monthRe = new RegExp(`\\b(?:(first|1st|second|2nd|third|3rd|last|final) (?:week|weekend) of|(early|mid|late|end of|beginning of|start of)|in|of|by|during|until|till|through|this|next|for)(?:\\s*-\\s*|\\s+)(${MONTH_RE})\\b(?!\\.?\\s*\\d)`, "g");
  const past = PAST_TENSE.test(t);
  for (const m of t.matchAll(monthRe)) {
    if (m[3] === "may" && words.slice((m.index ?? 0) + m[0].length - 3, (m.index ?? 0) + m[0].length) !== "May") continue;
    const month = monthNo(m[3]);
    let s = DateTime.fromObject({ year: said.year, month, day: 1 }, { zone });
    // A month behind them is next year's only within the roll window ("in January", said in October), and never in past-tense words.
    if (!past && s.endOf("month") < said && +s.plus({ years: 1 }) - +said <= ROLL_DAYS * 86_400_000) s = s.plus({ years: 1 });
    const end = s.endOf("month").startOf("day");
    const part = m[1] ?? m[2] ?? "";
    if (/^(first|1st)/.test(part)) spans.push([s, s.plus({ days: 6 })]);
    else if (/^(second|2nd)/.test(part)) spans.push([s.plus({ days: 7 }), s.plus({ days: 13 })]);
    else if (/^(third|3rd)/.test(part)) spans.push([s.plus({ days: 14 }), s.plus({ days: 20 })]);
    else if (/^(last|final)/.test(part)) spans.push([end.minus({ days: 6 }), end]);
    else if (/^(early|beginning|start)/.test(part)) spans.push([s, s.plus({ days: 9 })]);
    else if (part === "mid") spans.push([s.plus({ days: 9 }), s.plus({ days: 19 })]);
    else if (/^(late|end)/.test(part)) spans.push([s.plus({ days: 19 }), end]);
    else spans.push([s, end]);
  }
  for (const h of HOLIDAYS) {
    const m = t.match(new RegExp(`${h.re.source}(\\s+(?:week|weekend|break))?`));
    if (!m) continue;
    let d = h.on(said.year, zone);
    if (d < said.minus({ days: 1 })) d = h.on(said.year + 1, zone);
    // "Thanksgiving week": Monday to Sunday of it; "Thanksgiving weekend": through the Sunday after.
    const around = m[m.length - 1]?.trim();
    spans.push(around ? [around === "week" ? d.startOf("week") : d, d.endOf("week").startOf("day")] : day(d));
  }
  // A year alone: only this year or next ("raising a round by 2030" is a horizon, not a date that holds a claim for years).
  for (const m of t.matchAll(/\b(?:in|during|for|early|mid|late|end of)\s+(20\d{2})\b(?![-/]\d)/g)) {
    const y = Number(m[1]);
    if (y < said.year - 1 || y > said.year + 1) continue;
    spans.push([DateTime.fromObject({ year: y, month: 1, day: 1 }, { zone }), DateTime.fromObject({ year: y, month: 12, day: 31 }, { zone })]);
  }
  if (/\bnext week\b/.test(t)) spans.push([said.plus({ weeks: 1 }).startOf("week"), said.plus({ weeks: 1 }).endOf("week").startOf("day")]);
  if (/\b(this|the) weekend\b/.test(t)) { const sat = said.plus({ days: (6 - said.weekday + 7) % 7 }); spans.push([sat, sat.plus({ days: 1 })]); }
  if (/\bnext month\b/.test(t)) spans.push([said.plus({ months: 1 }).startOf("month"), said.plus({ months: 1 }).endOf("month").startOf("day")]);
  if (/\bnext year\b/.test(t)) spans.push([said.plus({ years: 1 }).startOf("year"), said.plus({ years: 1 }).endOf("year").startOf("day")]);
  const first = resolveDate(words, saidOn, zone);
  if (first) { const f = DateTime.fromISO(first, { zone }); exact.push(f); if (!spans.length) spans.push(day(f)); }
  if (!spans.length) return null;
  const start = spans.reduce((a, s) => (s[0] < a ? s[0] : a), spans[0][0]);
  const end = spans.reduce((a, s) => (s[1] > a ? s[1] : a), spans[0][1]);
  const exactEnd = exact.length ? exact.reduce((a, d) => (d > a ? d : a), exact[0]).toISODate()! : null;
  return { start: start.toISODate()!, end: end.toISODate()!, exactEnd };
}

// When a claim ends. Enduring: never. A dated claim ends the day after the LAST day it names (never before its own date). An
// undated ephemeral claim ends its kind's ttl after it was last said, and what Co only inferred ends sooner. Saying it again moves
// the clock.
export function expiresOn(c: { kind: Kind; provenance: Provenance; text: string; quote: string | null; saidOn: string; confirmedOn: string }, zone = FALLBACK_ZONE): string | null {
  const k = KINDS[c.kind];
  if (k.lifetime === "enduring") return null;
  const words = `${c.text} ${c.quote ?? ""}`;
  const span = dateSpan(words, c.saidOn, zone);
  const after = (d: string) => DateTime.fromISO(d, { zone }).plus({ days: 1 }).toISODate()!;
  const ttl = Math.min((k as { ttlDays: number }).ttlDays, c.provenance === "co_inferred" ? INFERRED_MAX_DAYS : 365);
  const byTtl = DateTime.fromISO(c.confirmedOn, { zone }).plus({ days: ttl }).toISODate()!;
  // A day named exactly ends it the day after the last day named (a past one ends it now: "Redo the Mar 3 deck").
  if (span?.exactEnd) return after(span.end > span.exactEnd ? span.end : span.exactEnd);
  // Only fuzzy days (a month, a holiday, a year): they can lengthen its life, never shorten it.
  if (span) return after(span.end) > byTtl ? after(span.end) : byTtl;
  return byTtl;
}

export function isLive(c: { expiresOn: string | null }, now: Date, zone = FALLBACK_ZONE): boolean {
  if (!c.expiresOn) return true;
  return DateTime.fromJSDate(now).setZone(zone).startOf("day") < DateTime.fromISO(c.expiresOn, { zone }).startOf("day");
}

// The same claim said again (same kind, mostly the same words): it is re-confirmed, not a new claim.
export function sameClaim(a: { kind: Kind; text: string }, b: { kind: Kind; text: string }): boolean {
  if (a.kind !== b.kind) return false;
  const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length >= 4));
  const x = words(a.text), y = words(b.text);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

// What a recap or a draft is allowed to hold: only live claims, labelled. Expired ones are gone, not carried.
export function renderLive(claims: (Claim & { id?: string })[], now: Date, zone = FALLBACK_ZONE): { theySaid: string[]; coInferred: string[]; enduring: string[] } {
  const live = claims.filter((c) => isLive(c, now, zone));
  const fmt = (c: Claim) => {
    const day = DateTime.fromISO(c.saidOn, { zone }).toFormat("LLL d");
    const until = c.expiresOn ? `, until ${DateTime.fromISO(c.expiresOn, { zone }).minus({ days: 1 }).toFormat("LLL d")}` : "";
    return `${c.text} (${c.provenance === "user_said" ? `they said, ${day}` : `Co's read, ${day}`}${until})`;
  };
  return {
    enduring: live.filter((c) => c.kind && KINDS[c.kind].lifetime === "enduring" && c.provenance === "user_said").map(fmt),
    theySaid: live.filter((c) => KINDS[c.kind].lifetime === "ephemeral" && c.provenance === "user_said").map(fmt),
    coInferred: live.filter((c) => c.provenance === "co_inferred").map(fmt),
  };
}

// ---------- stamps on stored rows (Royce, 2026-10-06)
// The 10/6 call: Co asked about "your first paying customer" from a thread last touched 9/28, because the call briefing printed the
// thread's text and dropped its date. The text-side fix (labels and lifetimes on claims) never reached that pipe. The stamp is made
// where the row is READ for any purpose, from the dates the row already carries, so a recap, a draft, a call briefing and the sweep
// all say when it was said and whether it can still be stated as current. One function, every reader.
export const STALE_AFTER_DAYS = 7; // untouched this long: ask whether it is still true, never state it
export const DROP_AFTER_DAYS = 21; // untouched this long: a call briefing leaves it out altogether

export type Stampable = { saidOn?: string | Date | null; confirmedOn?: string | Date | null; dueOn?: string | Date | null };

const dayOf = (x: string | Date | null | undefined, zone: string): DateTime | null => {
  if (!x) return null;
  const d = x instanceof Date ? DateTime.fromJSDate(x).setZone(zone) : /^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? DateTime.fromISO(String(x), { zone }) : DateTime.fromISO(String(x)).setZone(zone);
  return d.isValid ? d.startOf("day") : null;
};

export type StampRead = { label: string; ageDays: number | null; stale: boolean; drop: boolean; datePassed: boolean };

// Pure: how old a row is and what may be said about it, from its own dates.
export function stampOf(s: Stampable, now: Date, zone = FALLBACK_ZONE): StampRead {
  const today = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  const said = dayOf(s.saidOn, zone);
  const confirmed = dayOf(s.confirmedOn, zone) ?? said;
  const due = dayOf(s.dueOn, zone);
  const ageDays = confirmed ? Math.max(0, Math.round(today.diff(confirmed, "days").days)) : null;
  const datePassed = !!due && due < today;
  const stale = datePassed || ageDays === null || ageDays >= STALE_AFTER_DAYS;
  const drop = ageDays !== null && ageDays >= DROP_AFTER_DAYS;
  const parts = [
    said ? `they said ${said.toFormat("LLL d")}` : "undated",
    confirmed && said && +confirmed !== +said ? `last came up ${confirmed.toFormat("LLL d")}` : null,
    ageDays !== null && ageDays >= 2 ? `${ageDays} days ago` : null,
    due ? `${datePassed ? "its date, " : "date "}${due.toFormat("LLL d")}${datePassed ? ", has passed" : ""}` : null,
  ].filter(Boolean);
  const warn = stale ? "; OLD, so ask whether it is still true and never state it as current" : "";
  return { label: `${parts.join(", ")}${warn}`, ageDays, stale, drop, datePassed };
}

// A row's text with its stamp.
export const stampedLine = (text: string, s: Stampable, now: Date, zone = FALLBACK_ZONE) => `${text} (${stampOf(s, now, zone).label})`;
