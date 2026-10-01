// The time frame someone names in an ask (Royce, 2026-09-16: "if I ask it to
// check for things this weekend it should conduct a sweep during a time frame
// a user gives it. Doesn't matter if it's a weekend or weekday").
//
// "anything this weekend", "what's on tonight", "next Tuesday", "the week of
// the 20th" all scope the search to those days instead of the default
// lookahead. Plain rules rather than a model call: a date range is
// mechanical, it has to be right, and this runs on the hot path of every
// search.
import { DateTime } from "luxon";

export type AskWindow = { start: DateTime; end: DateTime; label: string };

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Their whole day, in their own zone.
function day(d: DateTime): { start: DateTime; end: DateTime } {
  return { start: d.startOf("day"), end: d.endOf("day") };
}

function nextWeekday(from: DateTime, weekday: number, allowToday: boolean): DateTime {
  let d = from.startOf("day");
  if (!allowToday || d.weekday !== weekday) {
    do {
      d = d.plus({ days: 1 });
    } while (d.weekday !== weekday);
  }
  return d;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_RE = "(\\d{1,2})(?:st|nd|rd|th)?";

// A calendar date they typed, in their zone. A date already behind them this
// year means next year ("Jan 5" said in September).
function calendarDate(now: DateTime, month: string, dayOfMonth: string): DateTime | null {
  const m = MONTHS[month.toLowerCase()];
  const d = Number(dayOfMonth);
  if (!m || !d) return null;
  let date = DateTime.fromObject({ year: now.year, month: m, day: d }, { zone: now.zone });
  if (!date.isValid) return null;
  if (date.endOf("day") < now.startOf("day")) date = date.plus({ years: 1 });
  return date;
}

// Explicit dates (Royce, 2026-09-16: "can we give it a date period like for
// example 'Oct 5 - Oct 14th'?"): "Oct 5 - Oct 14th", "Oct 5-14",
// "October 5 to 14", "between Oct 5 and Oct 14", or a single "Oct 5".
function explicitDates(t: string, now: DateTime): AskWindow | null {
  const range = t.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+${DAY_RE}\\s*(?:-|–|to|through|thru|until|and)\\s*(?:${MONTH_RE}\\.?\\s+)?${DAY_RE}\\b`, "i"));
  if (range) {
    const start = calendarDate(now, range[1], range[2]);
    let end = calendarDate(now, range[3] ?? range[1], range[4]);
    if (start && end) {
      if (end < start) end = end.plus({ years: 1 });
      return { start: start.startOf("day"), end: end.endOf("day"), label: `${start.toFormat("LLL d")} to ${end.toFormat("LLL d")}` };
    }
  }
  const single = t.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+${DAY_RE}\\b`, "i"));
  if (single) {
    const d = calendarDate(now, single[1], single[2]);
    if (d) return { start: d.startOf("day"), end: d.endOf("day"), label: d.toFormat("LLL d") };
  }
  return null;
}

// "Saturday on the 10th", "for the 26th": a day of the month with no month.
// It is the next date with that day, and with that weekday when they gave one
// (2026-09-21: "What about Saturday on the 10th?" said on Sat Sept 19 became
// Saturday Sept 19, and the follow-up asked how a Saturday still three weeks
// away had gone). Needs "on/for/by/before/around/until/of the" or a weekday
// right before it, so "the 1st time" and "my 3rd startup" are not dates.
function dayOfMonthDate(t: string, now: DateTime): AskWindow | null {
  const wd = t.match(new RegExp(`\\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?,?\\s+(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b`));
  const bare = t.match(/\b(?:on|for|by|before|around|until|of)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  const dayNum = wd ? Number(wd[2]) : bare ? Number(bare[1]) : 0;
  if (!dayNum || dayNum > 31) return null;
  const weekday = wd ? WEEKDAYS.indexOf(wd[1]) + 1 : 0;
  for (let i = 0; i < 14; i++) {
    const d = now.startOf("month").plus({ months: i }).set({ day: dayNum });
    if (!d.isValid || d.day !== dayNum) continue;
    if (d.endOf("day") < now.startOf("day")) continue;
    if (weekday && d.weekday !== weekday) continue;
    return { start: d.startOf("day"), end: d.endOf("day"), label: d.toFormat(weekday ? "cccc, LLL d" : "LLL d") };
  }
  return null;
}

// "the week of Oct 5th", "week starting the 20th", "week beginning Oct 5": the
// seven days from that date (2026-09-21: "the week of Oct 5th" was read as
// Oct 5 alone, so a fit event on Oct 7 was never looked at). A range they
// typed ("the week of Oct 5 - Oct 11") keeps its own end.
function weekOfDate(t: string, now: DateTime): AskWindow | null {
  const m = t.match(/\bweek\s+(?:of|starting|beginning|commencing|from)\s+(.+)/);
  if (!m) return null;
  const rest = m[1];
  const own = explicitDates(rest, now);
  let start: DateTime | null = null;
  if (own) {
    if (own.label.includes(" to ")) return { ...own, label: `week of ${own.label}` };
    start = own.start;
  } else {
    const dom = rest.match(/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
    const dayNum = dom ? Number(dom[1]) : 0;
    if (dayNum >= 1 && dayNum <= 31) {
      for (let i = 0; i < 14 && !start; i++) {
        const d = now.startOf("month").plus({ months: i }).set({ day: dayNum });
        if (d.isValid && d.day === dayNum && d.endOf("day") >= now.startOf("day")) start = d;
      }
    }
  }
  if (!start) return null;
  const from = start.startOf("day");
  return { start: from, end: from.plus({ days: 6 }).endOf("day"), label: `week of ${from.toFormat("LLL d")}` };
}

// How far ahead a named time frame can reach. The default search looks two
// weeks out; asking for a later range extends it, up to this (Royce,
// 2026-09-16: "Can it have a limit but still have a stated ask to look
// ahead?").
export const MAX_ASK_DAYS_AHEAD = 90;

// Returns the window they named, or null when they didn't name one (or named
// one too far out to search; resolveAskWindow says which).
export function parseAskWindow(text: string, now: DateTime): AskWindow | null {
  return resolveAskWindow(text, now).window;
}

// The window they named, plus whether they named one Co can't search. A date
// past the 90-day limit (or a date already behind them this year, which rolls
// to next year) used to come back as "no time frame", so the search ran the
// default two-week lookahead and "anything Jan 20?" got next week's events
// (code review, 2026-09-17). outOfRange lets the search say so and stop.
export type AskWindowResolution = { window: AskWindow | null; outOfRange: { label: string; start: DateTime } | null };

export function resolveAskWindow(text: string, now: DateTime): AskWindowResolution {
  const w = parseAskWindowUncapped(text, now);
  if (!w) return { window: null, outOfRange: null };
  const ceiling = now.plus({ days: MAX_ASK_DAYS_AHEAD }).endOf("day");
  if (w.start > ceiling) return { window: null, outOfRange: { label: w.label, start: w.start } };
  return { window: w.end > ceiling ? { ...w, end: ceiling } : w, outOfRange: null };
}

function parseAskWindowUncapped(text: string, now: DateTime): AskWindow | null {
  const t = text.toLowerCase();
  const mk = (start: DateTime, end: DateTime, label: string): AskWindow => ({ start, end, label });

  const weekOf = weekOfDate(t, now);
  if (weekOf) return weekOf;
  const dates = explicitDates(t, now);
  if (dates) return dates;
  const dayOfMonth = dayOfMonthDate(t, now);
  if (dayOfMonth) return dayOfMonth;

  if (/\b(tonight|this evening)\b/.test(t)) {
    const d = day(now);
    return mk(now, d.end, "tonight");
  }
  if (/\btoday\b/.test(t)) {
    const d = day(now);
    return mk(now, d.end, "today");
  }
  if (/\btomorrow\b/.test(t)) {
    const d = day(now.plus({ days: 1 }));
    return mk(d.start, d.end, "tomorrow");
  }
  if (/\bnext weekend\b/.test(t)) {
    const sat = nextWeekday(now.plus({ days: 7 }), 6, true);
    return mk(sat.startOf("day"), sat.plus({ days: 1 }).endOf("day"), "next weekend");
  }
  if (/\b(this weekend|the weekend|weekend)\b/.test(t)) {
    // Saturday and Sunday of the week they're in; on a Sunday it means today.
    const sat = now.weekday === 7 ? now.minus({ days: 1 }) : nextWeekday(now, 6, true);
    const start = sat.startOf("day") < now.startOf("day") ? now.startOf("day") : sat.startOf("day");
    return mk(start, sat.plus({ days: 1 }).endOf("day"), "this weekend");
  }
  if (/\bnext week\b/.test(t)) {
    const start = now.plus({ weeks: 1 }).startOf("week");
    return mk(start, start.plus({ days: 6 }).endOf("day"), "next week");
  }
  if (/\b(this week|rest of the week)\b/.test(t)) {
    return mk(now, now.endOf("week"), "this week");
  }
  if (/\b(this month)\b/.test(t)) {
    return mk(now, now.endOf("month"), "this month");
  }
  const inDays = t.match(/\bnext (\d{1,2}) days\b/) ?? t.match(/\bin the next (\d{1,2}) days\b/);
  if (inDays) {
    const n = Math.min(90, Number(inDays[1]));
    return mk(now, now.plus({ days: n }).endOf("day"), `the next ${n} days`);
  }
  // "next tuesday", "on friday", "this thursday", and a bare "thursday" or
  // "thursday night" (2026-09-16: "anything happening Thursday?" had no
  // window and got an event nine days out). A bare day means the coming one,
  // today included.
  const weekday = t.match(/\b(?:(next|this|on|coming)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/);
  if (weekday) {
    const idx = WEEKDAYS.indexOf(weekday[2]) + 1;
    const allowToday = weekday[1] !== "next";
    const d = nextWeekday(now, idx, allowToday);
    const { start, end } = day(d);
    return mk(start, end, weekday[1] ? `${weekday[1]} ${weekday[2]}` : weekday[2]);
  }
  return null;
}

// Whether a start time falls inside the window.
export function withinWindow(startAt: string, w: AskWindow): boolean {
  const t = DateTime.fromISO(startAt, { zone: w.start.zone });
  // No slack before the start: six hours of it let a Wednesday-evening event
  // into a Thursday window (2026-09-16).
  return t.isValid && t >= w.start && t <= w.end;
}

// An ask with a time frame but no subject ("what's on this weekend?",
// "anything on Luma coming up?"): they want to see what's there, so results
// shouldn't be held to topical relevance.
export function isBrowseAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(luma|events?|anything|what's|whats|what is|what has|surfacing|going on|happening|coming up|on the calendar)\b/.test(t)) return false;
  // A real subject means it's a normal search ("climate events this weekend").
  const subject = t
    .replace(/\d+(?:st|nd|rd|th)?\b/g, " ")
    .replace(/\b(luma|event|events|anything|something|what's|whats|what|is|has|been|surfacing|going|on|happening|coming|up|this|next|the|weekend|week|weekday|today|tonight|tomorrow|month|for|me|you|any|got|do|have|there|calendar|in|a|new|see|show|find|check|look|at|your|around|near|to|of|us|we|i|and|or|it|that|right|now|soon|please|hey|co|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|night|evening|morning|afternoon|between|from|to|through|and|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|st|nd|rd|th)\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
  return subject.length === 0;
}

// A what's-on follow-up with no time frame of its own keeps the one they just
// asked about (2026-09-18: "What's the vibes for Sunday?" then "Anything
// happening?" got events on Wednesday, Sep 30 and Oct 5). Returns the text to
// read the time frame from: the earlier message when it named one and this
// one is only "what's on", else this one. A message with its own subject
// ("any design engineer leads?") never inherits it.
export function carryTimeFrame(current: string, previous: string | null, now: DateTime): string {
  if (!previous || !isBrowseAsk(current)) return current;
  const own = resolveAskWindow(current, now);
  if (own.window || own.outOfRange) return current;
  const prior = resolveAskWindow(previous, now);
  return prior.window ? `${current} (${previous})` : current;
}

// True when the text names a day of the month (the 10th, 19th) that is not in
// the real dates it is about.
export function mentionsUnknownDay(text: string, dates: string): boolean {
  const known = new Set([...dates.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1])));
  return [...text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi)].some((m) => !known.has(Number(m[1])));
}


// A time written with weekday names ("Saturday Oct 3 - Sunday Oct 4") read as
// its first day only, so "this weekend" was searched as Saturday (2026-09-30).
// Weekday names are dropped when the text also has real dates; their own words
// ("this weekend", "Friday night") are left alone.
export function whenForWindow(when: string | null | undefined): string | null {
  if (!when?.trim()) return null;
  const hasDate = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b/i.test(when);
  return hasDate ? when.replace(/\b(mon|tues|wednes|thurs|fri|satur|sun)day,?\s*/gi, "").replace(/\s+/g, " ").trim() : when.trim();
}
