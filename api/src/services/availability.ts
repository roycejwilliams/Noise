// When a member said they're usually free ("weeknights only", "weekday
// evenings", "no weekends"), checked against an event's real start time in
// plain rules (2026-09-22). The fit check's model got the time of day right
// but called a Saturday brunch fine for "weeknights only" every time (9 of
// 9), and day-of-week is mechanical, the same reasoning as askWindow.ts.
// Anything it doesn't recognize is no constraint at all: the model's own
// read in eventDetails.ts fitPrompt still covers unusual phrasing.
import { DateTime } from "luxon";

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];
const ALL = [1, 2, 3, 4, 5, 6, 7];
const HOURS = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24], any: [0, 24] } as const;

type Window = { days: number[]; from: number; to: number; label: string };

function part(word: string): keyof typeof HOURS | null {
  if (/^morning/.test(word)) return "morning";
  if (/^afternoon/.test(word)) return "afternoon";
  if (/^(evening|night)/.test(word)) return "evening";
  return null;
}

// The windows a phrase allows, or null when nothing in it is recognized.
export function availabilityWindows(text: string): Window[] | null {
  let t = ` ${text.toLowerCase().replace(/[^a-z\s]/g, " ")} `;
  const windows: Window[] = [];
  const add = (days: number[], p: keyof typeof HOURS, label: string) => windows.push({ days, from: HOURS[p][0], to: HOURS[p][1], label });

  const noWeekends = /\b(no|not|never|except|without)\s+(on\s+)?weekends?\b/.test(t);
  t = t.replace(/\b(no|not|never|except|without)\s+(on\s+)?weekends?\b/g, " ");

  // Compound first: "weekday evenings", "weekend mornings".
  t = t.replace(/\b(weekday|weekend)s?\s+(mornings?|afternoons?|evenings?|nights?)\b/g, (_, d: string, w: string) => {
    add(d === "weekday" ? WEEKDAYS : WEEKEND, part(w)!, `${d} ${w}`);
    return " ";
  });
  t = t.replace(/\bweeknights?\b/g, () => (add(WEEKDAYS, "evening", "weeknights"), " "));
  t = t.replace(/\bweekdays?\b/g, () => (add(WEEKDAYS, "any", "weekdays"), " "));
  t = t.replace(/\bweekends?\b/g, () => (add(WEEKEND, "any", "weekends"), " "));
  t = t.replace(/\b(after work)\b/g, () => (add(WEEKDAYS, "evening", "after work"), " "));
  t = t.replace(/\b(mornings?|afternoons?|evenings?|nights?)\b/g, (w: string) => (add(ALL, part(w)!, w), " "));

  if (noWeekends) {
    if (!windows.length) add(WEEKDAYS, "any", "not weekends");
    for (const w of windows) w.days = w.days.filter((d) => !WEEKEND.includes(d));
  }
  const usable = windows.filter((w) => w.days.length);
  return usable.length ? usable : null;
}

// A preference is not a limit (Phase A, 2026-10-10: "more flexible on weekends" read as "free only on weekends", so every weekday
// event was a misfit, and the sweep would have dropped them all). Only words that restrict make it a rule in code: "only", "just",
// "no weekends", "can't do weekdays". Words that lean ("more flexible", "prefer", "ideally", "easier") stay with the model, as context.
const LEANS = /\b(more flexible|flexible|prefer(?:ably|red|s)?|ideally|easier|better|mostly|usually more|tend to|if possible|when possible|works best)\b/i;
const RESTRICTS = /\b(only|just|can'?t|cannot|can not|no|not|never|except|without|unavailable|busy)\b/i;
export function availabilityIsLimit(availability: string | null | undefined): boolean {
  const t = availability?.trim() ?? "";
  if (!t) return false;
  if (LEANS.test(t) && !/\bonly\b/i.test(t)) return false;
  // A bare window ("weeknights", "evenings", "weekends") is what they said they're free for: a limit, as it always was.
  return RESTRICTS.test(t) || !LEANS.test(t);
}

// A plain sentence saying why the event is outside when they're free, or
// null when it's inside, the phrase isn't recognized, it's a preference rather than a limit, or the time is unknown.
export function availabilityConflict(availability: string | null | undefined, startAt: string | null | undefined, zone: string | null | undefined): string | null {
  if (!availability?.trim() || !startAt) return null;
  if (!availabilityIsLimit(availability)) return null;
  const windows = availabilityWindows(availability);
  if (!windows) return null;
  const start = DateTime.fromISO(startAt, { setZone: true }).setZone(zone || "America/Los_Angeles");
  if (!start.isValid) return null;
  const hour = start.hour + start.minute / 60;
  const inside = windows.some((w) => w.days.includes(start.weekday) && hour >= w.from && hour < w.to);
  return inside ? null : `It's ${start.toFormat("cccc 'at' h:mm a")}, outside when they said they're usually free ("${availability.trim()}").`;
}
