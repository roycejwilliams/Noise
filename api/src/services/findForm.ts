// What a find IS, read when it's captured (Royce, 2026-10-09): an event with a date, or an opening with a deadline (or open now,
// on a rolling basis). Web finds used to land as an undated "tier 3 opportunity" whatever they were (the Fleet Week air show, the
// Castro Street Fair, a chess meetup), so date checks, expiry and the urgency rule couldn't see them and Co pitched each one as "a
// real opportunity". The source (tier) still says where it came from; the form says what it is, and everything time-based reads it.
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";

export type FindForm = "event" | "opening";
export type Classified = { form: FindForm; date: string | null; deadline: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PACIFIC = "America/Los_Angeles";
const zoneOr = (zone: string | null | undefined) => (zone && DateTime.now().setZone(zone).isValid ? zone : PACIFIC);
// A date as the member lives it (review of #133: a timestamp was cut to its UTC date, so an Oct 9 7pm Pacific event read as Oct 10).
// A plain date stays as written; a timestamp is read in their zone, the way dateGuard.itemDays does.
export function dayIn(x: unknown, zone: string | null = null): string | null {
  if (typeof x !== "string" || !x.trim()) return null;
  const t = x.trim();
  if (ISO.test(t)) return t;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return null;
  const d = DateTime.fromISO(t, { setZone: true });
  return d.isValid ? d.setZone(zoneOr(zone)).toISODate() : null;
}
const day = dayIn;

// Pure: the date an event happens on, from any field a find carries it in (the start when it spans days).
export function eventDateOf(m: any, zone: string | null = null): string | null {
  return day(m?.event_date, zone) ?? day(m?.details?.startAt, zone) ?? day(m?.statedDates?.start, zone) ?? null;
}
// Pure: the last day of an event that spans days (its end), else its date.
export function eventEndOf(m: any, zone: string | null = null): string | null {
  return day(m?.statedDates?.end, zone) ?? day(m?.details?.endAt, zone) ?? eventDateOf(m, zone);
}

// Pure: the form a find already has, or null when it still needs classifying. Co's and public events are events; a find carrying an
// event date is an event; one carrying a deadline is an opening; one already classified keeps its form.
// A deadline makes it an opening, whatever start date it also carries (review of #133: a fellowship with a deadline of Oct 5 and a start
// of Nov 1 read as "an event on Nov 1" and stayed past its deadline).
export function formOf(m: Pick<TierMatch, "kind"> & Record<string, any>): FindForm | null {
  if (m.form === "event" || m.form === "opening") return m.form;
  if (m.kind === "co_event" || m.kind === "public_event") return "event";
  if (day(m.deadline)) return "opening";
  if (eventDateOf(m)) return "event";
  return null;
}

// Pure: the date that ends its useful life: an event's last day, an opening's deadline, or null (a rolling opening).
export function lifeEndOf(m: any, zone: string | null = null): string | null {
  const f = formOf(m);
  if (f === "event") return eventEndOf(m, zone);
  if (f === "opening") return day(m.deadline, zone);
  return null;
}

export function classifyPrompt(name: string, page: string, today: string): string {
  return `Today is ${today}. A page Co found is titled "${name}". From the page text below, say what it is:
- "event": something that happens at a time (a gathering, show, festival, meetup, dinner, talk). Give its date (YYYY-MM-DD), and its last day if it spans days.
- "opening": something to apply to or join (a program, cohort, fellowship, grant, residency, job, open call, a place or community you can join any time). Give its application deadline (YYYY-MM-DD) if the page states one, else null.
Only dates the page states. If it's an event and the page gives no date, the date is null.

Page text:
${page.slice(0, 6000)}

Answer only with JSON: {"form": "event" | "opening", "date": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null, "deadline": "YYYY-MM-DD" | null}`;
}

// Pure: every date a page states, as YYYY-MM-DD (review of #133: "Oct 06", "10/06/2026", "06 Oct 2026", "Sept 12" and "18.10.2026"
// were missed while "Doors 10/12" and a phone number passed as substrings). Whole tokens only: a month name (or Sept) with a day,
// either order, with an optional year; US m/d or m/d/yyyy with slashes; d.m.yyyy with dots; ISO. A bare dash pair (a phone number)
// is never a date. A date with no year takes the year of `around` (the date being checked), so "Oct 10" on a page counts for 2026-10-10.
const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
export function datesOnPage(page: string, aroundYear: number): Set<string> {
  const out = new Set<string>();
  const text = page.toLowerCase();
  const add = (y: number, m: number, d: number) => {
    const dt = DateTime.fromObject({ year: y, month: m, day: d });
    if (dt.isValid) out.add(dt.toISODate()!);
  };
  const year = (y: string | undefined) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : aroundYear);
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"))) add(year(m[3]), MONTHS[m[1]], Number(m[2]));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?\\b(?:,?\\s+(\\d{4}))?`, "g"))) add(year(m[3]), MONTHS[m[2]], Number(m[1]));
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) add(year(m[3]), Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d.])/g)) add(Number(m[3]), Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  return out;
}

// Pure: the model's reading, checked in code: a real date only when the page states it (datesOnPage), so a date the page doesn't
// state is never carried.
export function readClassification(raw: string, page: string): (Classified & { end: string | null }) | null {
  let j: any;
  try {
    j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  if (j?.form !== "event" && j?.form !== "opening") return null;
  const onPage = (d: string | null) => {
    if (!d || !ISO.test(d) || !DateTime.fromISO(d).isValid) return null;
    return datesOnPage(page, DateTime.fromISO(d).year).has(d) ? d : null;
  };
  return { form: j.form, date: onPage(j.date ?? null), end: onPage(j.end ?? null), deadline: onPage(j.deadline ?? null) };
}

export type ClassifyDeps = { page: (url: string) => Promise<string | null>; model: (prompt: string) => Promise<string> };
export const realClassifyDeps: ClassifyDeps = {
  page: async (url) => (await import("./webOpportunitySearch.js")).readPageText(url),
  model: async (prompt) => {
    const { generateText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");
    const { MODELS } = await import("../models.js");
    const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 120, experimental_telemetry: { isEnabled: true, functionId: "findForm.classify" }, prompt });
    return text;
  },
};

// A find with its form and its dates, read from its own page when it doesn't carry them. "unknown": the page couldn't be read or
// said nothing usable; an event whose date the page doesn't state is "undated". Callers keep a dated event or an opening, and exit
// the rest on that fact.
export async function classifyFind<M extends TierMatch>(m: M, today: string, deps: ClassifyDeps = realClassifyDeps): Promise<{ match: M; result: "dated_event" | "opening" | "undated" | "unknown" }> {
  const known = formOf(m as any);
  if (known === "event" && eventDateOf(m)) return { match: { ...m, form: "event" } as M, result: "dated_event" };
  if (known === "opening") return { match: { ...m, form: "opening" } as M, result: "opening" };
  const url = "url" in m ? (m as any).url : null;
  // The page the sweep already read (its evidence) is used first; it's fetched again only when there isn't enough of it (review of #133).
  const read = String((m as any).evidence ?? "");
  const page = read.length >= 400 ? read : url ? await deps.page(url).catch(() => null) : null;
  if (!page) return { match: m, result: "unknown" };
  const c = readClassification(await deps.model(classifyPrompt(m.name, page, today)).catch(() => ""), page);
  if (!c) return { match: m, result: "unknown" };
  if (c.form === "event") {
    if (!c.date) return { match: { ...m, form: "event" } as M, result: "undated" };
    return { match: { ...m, form: "event", statedDates: { start: c.date, end: c.end } } as M, result: "dated_event" };
  }
  return { match: { ...m, form: "opening", ...(c.deadline ? { deadline: c.deadline } : {}) } as M, result: "opening" };
}

// The key a find exits under (services/workingSet.ts): an event by its own id; a web find by its name plus the date it's for (or its
// link), so a weekly meetup that exits once can come back next week and a reject tied to one date doesn't block every later one
// (review of #133: the name alone blocked all of them, stronger than the fact's "this find").
export function exitKey(m: any): string {
  if (m?.event_api_id) return `event:${m.event_api_id}`;
  const name = String(m?.name ?? "").toLowerCase().trim();
  const when = eventDateOf(m) ?? (typeof m?.deadline === "string" ? m.deadline.slice(0, 10) : null);
  return `opportunity:${name}|${when ?? String(m?.url ?? "").trim().toLowerCase()}`;
}

// How Co names what it is (Royce, 2026-10-09: "an event Saturday" or "an application closing Friday", never "a real opportunity").
export function formLabel(m: any, zone: string | null, now = new Date()): string {
  if (m?.kind === "co_event") return `a Co event${whenWords(eventDateOf(m, zone), zone, now)}`;
  const f = formOf(m);
  if (f === "event") return `an event${whenWords(eventDateOf(m, zone), zone, now)}`;
  if (f === "opening") {
    const d = day(m?.deadline);
    return d ? `an opening, applications close ${dayWords(d, zone, now)}` : "an opening you can apply to or join now";
  }
  return "something worth a look";
}
function dayWords(d: string, zone: string | null, now: Date): string {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const target = DateTime.fromISO(d, { zone: z }).startOf("day");
  const today = DateTime.fromJSDate(now).setZone(z).startOf("day");
  const n = Math.round(target.diff(today, "days").days);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1 && n < 7) return target.toFormat("cccc");
  return target.toFormat("LLL d");
}
function whenWords(d: string | null, zone: string | null, now: Date): string {
  return d ? ` ${(() => { const w = dayWords(d, zone, now); return w === "today" || w === "tomorrow" ? w : `on ${w}`; })()}` : "";
}
