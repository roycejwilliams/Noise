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

// Returns the window they named, or null when they didn't name one.
export function parseAskWindow(text: string, now: DateTime): AskWindow | null {
  const t = text.toLowerCase();
  const mk = (start: DateTime, end: DateTime, label: string): AskWindow => ({ start, end, label });

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
  // "next tuesday", "on friday", "this thursday"
  const weekday = t.match(/\b(?:next|this|on|coming)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekday) {
    const idx = WEEKDAYS.indexOf(weekday[1]) + 1;
    const allowToday = !/\bnext\b/.test(weekday[0]);
    const d = nextWeekday(now, idx, allowToday);
    const { start, end } = day(d);
    return mk(start, end, weekday[0].replace(/\s+/g, " "));
  }
  return null;
}

// Whether a start time falls inside the window.
export function withinWindow(startAt: string, w: AskWindow): boolean {
  const t = DateTime.fromISO(startAt, { zone: w.start.zone });
  return t.isValid && t >= w.start.minus({ hours: 6 }) && t <= w.end;
}

// An ask with a time frame but no subject ("what's on this weekend?",
// "anything on Luma coming up?"): they want to see what's there, so results
// shouldn't be held to topical relevance.
export function isBrowseAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(luma|events?|anything|what's|whats|what is|what has|surfacing|going on|happening|coming up|on the calendar)\b/.test(t)) return false;
  // A real subject means it's a normal search ("climate events this weekend").
  const subject = t
    .replace(/\b(luma|event|events|anything|something|what's|whats|what|is|has|been|surfacing|going|on|happening|coming|up|this|next|the|weekend|week|weekday|today|tonight|tomorrow|month|for|me|you|any|got|do|have|there|calendar|in|a|new|see|show|find|check|look|at|your|around|near|to|of|us|we|i|and|or|it|that|right|now|soon|please|hey|co)\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
  return subject.length === 0;
}
