// What a find IS, read when it's captured (Royce, 2026-10-09): an event with a date, or an opening with a deadline (or open now,
// on a rolling basis). Web finds used to land as an undated "tier 3 opportunity" whatever they were (the Fleet Week air show, the
// Castro Street Fair, a chess meetup), so date checks, expiry and the urgency rule couldn't see them and Co pitched each one as "a
// real opportunity". The source (tier) still says where it came from; the form says what it is, and everything time-based reads it.
import { DateTime } from "luxon";
import type { TierMatch } from "./tieredRecommendation.js";

export type FindForm = "event" | "opening";
export type Classified = { form: FindForm; date: string | null; deadline: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (x: unknown): string | null => (typeof x === "string" && ISO.test(x.slice(0, 10)) ? x.slice(0, 10) : null);

// Pure: the date an event happens on, from any field a find carries it in (the start when it spans days).
export function eventDateOf(m: any): string | null {
  return day(m?.event_date) ?? day(m?.details?.startAt) ?? day(m?.statedDates?.start) ?? null;
}
// Pure: the last day of an event that spans days (its end), else its date.
export function eventEndOf(m: any): string | null {
  return day(m?.statedDates?.end) ?? day(m?.details?.endAt) ?? eventDateOf(m);
}

// Pure: the form a find already has, or null when it still needs classifying. Co's and public events are events; a find carrying an
// event date is an event; one carrying a deadline is an opening; one already classified keeps its form.
export function formOf(m: Pick<TierMatch, "kind"> & Record<string, any>): FindForm | null {
  if (m.form === "event" || m.form === "opening") return m.form;
  if (m.kind === "co_event" || m.kind === "public_event") return "event";
  if (eventDateOf(m)) return "event";
  if (day(m.deadline)) return "opening";
  return null;
}

// Pure: the date that ends its useful life: an event's last day, an opening's deadline, or null (a rolling opening).
export function lifeEndOf(m: any): string | null {
  const f = formOf(m);
  if (f === "event") return eventEndOf(m);
  if (f === "opening") return day(m.deadline);
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

// Pure: the model's reading, checked in code: real dates only, and each date has to appear on the page in some written form (the
// month name or number with the day), so a date the page doesn't state is never carried.
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
    const dt = DateTime.fromISO(d);
    const text = page.toLowerCase();
    const dd = String(dt.day);
    const forms = [dt.toFormat("LLLL").toLowerCase(), dt.toFormat("LLL").toLowerCase(), `${dt.month}/${dd}`, `${dt.month}-${dd}`, d];
    const named = forms.slice(0, 2).some((mn) => new RegExp(`\\b${mn}\\.?\\s+${dd}(?:st|nd|rd|th)?\\b|\\b${dd}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mn}\\b`).test(text));
    return named || forms.slice(2).some((f) => text.includes(f)) ? d : null;
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
  const page = url ? await deps.page(url).catch(() => null) : null;
  if (!page) return { match: m, result: "unknown" };
  const c = readClassification(await deps.model(classifyPrompt(m.name, page, today)).catch(() => ""), page);
  if (!c) return { match: m, result: "unknown" };
  if (c.form === "event") {
    if (!c.date) return { match: { ...m, form: "event" } as M, result: "undated" };
    return { match: { ...m, form: "event", statedDates: { start: c.date, end: c.end } } as M, result: "dated_event" };
  }
  return { match: { ...m, form: "opening", ...(c.deadline ? { deadline: c.deadline } : {}) } as M, result: "opening" };
}

// How Co names what it is (Royce, 2026-10-09: "an event Saturday" or "an application closing Friday", never "a real opportunity").
export function formLabel(m: any, zone: string | null, now = new Date()): string {
  if (m?.kind === "co_event") return `a Co event${whenWords(eventDateOf(m), zone, now)}`;
  const f = formOf(m);
  if (f === "event") return `an event${whenWords(eventDateOf(m), zone, now)}`;
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
