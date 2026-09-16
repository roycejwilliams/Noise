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

// How far ahead a named time frame can reach. The default search looks two
// weeks out; asking for a later range extends it, up to this (Royce,
// 2026-09-16: "Can it have a limit but still have a stated ask to look
// ahead?").
export const MAX_ASK_DAYS_AHEAD = 90;

// Returns the window they named, or null when they didn't name one.
export function parseAskWindow(text: string, now: DateTime): AskWindow | null {
  const w = parseAskWindowUncapped(text, now);
  if (!w) return null;
  const ceiling = now.plus({ days: MAX_ASK_DAYS_AHEAD }).endOf("day");
  if (w.start > ceiling) return null; // too far to search; treat as no window
  return w.end > ceiling ? { ...w, end: ceiling } : w;
}

function parseAskWindowUncapped(text: string, now: DateTime): AskWindow | null {
  const t = text.toLowerCase();
  const mk = (start: DateTime, end: DateTime, label: string): AskWindow => ({ start, end, label });

  const dates = explicitDates(t, now);
  if (dates) return dates;

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
