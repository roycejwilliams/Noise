// Member-local time for Co's commitments (Royce, 2026-10-08: "Every commitment carries a window in member-local time, and a miss
// warns BEFORE the window passes"). One helper the commitment code shares: what "tonight", "in an hour", "tomorrow morning" or
// "by Friday" means for them, the last moment Co can still text them inside that window, and whether a next check lands past it.
//
// Their zone: co_profiles.city through geocoding.getTimezoneForCity (no zone is stored).
// The one fallback, when no zone is known: their words are read in Pacific time (FALLBACK_ZONE, where the club is), and whether a
// moment is sendable is the existing send gate's own answer (services/localHours.ts isReasonableLocalHour: 9am-8pm local, or the
// conservative 16:00-24:00 UTC window with no zone). The send rule itself is not changed here; deadline math only asks it.
import { DateTime } from "luxon";
import { isReasonableLocalHour, nextReasonableHour } from "./localHours.js";

export const FALLBACK_ZONE = "America/Los_Angeles";
// The task cron wakes every 15 minutes: the warn-by sits this far inside the last sendable moment, so a check due at the
// warn-by still runs (and can still text) before the window's texting closes.
export const WARN_MARGIN_MIN = 20;
const STEP_MS = 5 * 60_000;
const HOUR = 3_600_000;

export const validZone = (zone: string | null | undefined): string | null => (zone && DateTime.now().setZone(zone).isValid ? zone : null);
// The zone their words are read in: theirs, else the fallback.
export const wordsZone = (zone: string | null | undefined): string => validZone(zone) ?? FALLBACK_ZONE;
export const localOf = (at: Date, zone: string | null | undefined): DateTime => DateTime.fromJSDate(at).setZone(wordsZone(zone));

// The send gate's answer for this moment (9am-8pm their time; unchanged).
export const sendableAt = (at: Date, zone: string | null | undefined): boolean => isReasonableLocalHour(validZone(zone), at);
export const nextSendable = (after: Date, zone: string | null | undefined): Date => nextReasonableHour(validZone(zone), after);

// Their zone from their city, or null. Never throws.
export async function memberZone(userId: string): Promise<string | null> {
  try {
    const pool = (await import("../db/db.js")).default;
    const { rows } = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]);
    const city = rows[0]?.city;
    if (!city) return null;
    const { getTimezoneForCity } = await import("./geocoding.js");
    return validZone(await getTimezoneForCity(String(city)).catch(() => null));
  } catch {
    return null;
  }
}

// A moment, in their words, for a model or a fact line: "Tue Oct 7, 7:30pm PDT".
export function localStamp(at: Date | string, zone: string | null | undefined): string {
  const d = DateTime.fromJSDate(typeof at === "string" ? new Date(at) : at).setZone(wordsZone(zone));
  return `${d.toFormat("ccc LLL d, h:mma").replace(/:00(?=[AP]M)/, "").replace("AM", "am").replace("PM", "pm")} ${d.offsetNameShort ?? ""}${validZone(zone) ? "" : " (their zone isn't known; Pacific)"}`.trim();
}

export type CommitWindow = {
  words: string; // what Co said, or the default it stands for ("tonight", "in an hour", "by Friday", "within a day")
  deadline: string; // ISO instant: the end of the window
  warnBy: string; // ISO instant: the last moment Co can still text them inside the window and inside their hours (less a margin)
  zone: string | null; // their zone when it was set (null: unknown, read in FALLBACK_ZONE)
  stated: boolean; // the words were said; false = the default
  warnedFor?: string[]; // deadlines a miss warning already went out for (once per missed window)
  startsAt?: string; // a window set by a miss warning: when the deliverable can first go out (their morning); a turn before it is held to it, not warned again
  previous?: { words: string; deadline: string }[];
  closedAt?: string | null;
};

const at = (d: DateTime) => d.toJSDate();
const hm = (d: DateTime, hour: number, minute = 0) => d.set({ hour, minute, second: 0, millisecond: 0 });
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, "a few": 3, "a couple": 2, "a couple of": 2, few: 3 };

// Pure: the end of the window their words name, in their local time, or null when the words name none.
// After midnight and before 5am, "tonight" is the night already under way and "tomorrow" is the day about to start.
export function windowFromWords(text: string, now: Date, zone: string | null | undefined): { words: string; deadline: Date } | null {
  const s = String(text ?? "").toLowerCase().replace(/[’‘]/g, "'");
  const L = localOf(now, zone);
  const lateNight = L.hour < 5;
  const floor = (d: DateTime, words: string) => ({ words, deadline: new Date(Math.max(at(d).getTime(), now.getTime() + HOUR)) });

  if (/\b(?:in|within) (?:an|one|the next) hour\b|\bwithin the hour\b/.test(s)) return { words: "in an hour", deadline: new Date(now.getTime() + HOUR) };
  const rel = s.match(/\b(?:in|within) (?:the next )?(\d+|an?|one|two|three|four|five|six|a few|a couple(?: of)?|few) (minutes?|mins?|hours?|hrs?)\b/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : (NUM[rel[1]] ?? 1);
    const ms = /^m/.test(rel[2]) ? n * 60_000 : n * HOUR;
    return { words: rel[0].trim(), deadline: new Date(now.getTime() + Math.max(ms, 15 * 60_000)) };
  }
  if (/\b(?:right after (?:we hang up|the call|this call|we get off)|after we hang up|shortly|in a bit|in a little bit)\b/.test(s)) return { words: "right after the call", deadline: new Date(now.getTime() + HOUR) };
  if (/\btomorrow (?:night|evening)\b/.test(s)) return { words: "tomorrow night", deadline: at((lateNight ? L : L.plus({ days: 1 })).endOf("day")) };
  if (/\btomorrow morning\b|\bfirst thing (?:tomorrow|in the morning)\b|\bin the morning\b/.test(s)) return { words: "tomorrow morning", deadline: at(hm(lateNight ? L : L.plus({ days: 1 }), 12)) };
  if (/\btomorrow afternoon\b/.test(s)) return { words: "tomorrow afternoon", deadline: at(hm(lateNight ? L : L.plus({ days: 1 }), 17)) };
  if (/\btomorrow\b/.test(s)) return { words: "tomorrow", deadline: at(hm(lateNight ? L : L.plus({ days: 1 }), 20)) };
  if (/\b(?:tonight|this evening|later tonight)\b/.test(s)) return { words: "tonight", deadline: at(lateNight ? hm(L, 5) : L.endOf("day")) };
  if (/\bthis morning\b/.test(s)) return floor(hm(L, 12), "this morning");
  if (/\bthis afternoon\b/.test(s)) return floor(hm(L, 17), "this afternoon");
  if (/\b(?:later today|today|end of (?:the )?day|eod)\b/.test(s)) return floor(hm(L, 20), "today");
  // A full weekday name, or a short one after by/on/before/this/next ("sat" and "sun" alone are other words).
  const day = s.match(/\b(?:(by|on|before|this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)\b(\s+morning)?/);
  if (day && (day[1] || day[2].length > 5)) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(day[2].slice(0, 3))) + 1;
    let d = L.startOf("day");
    let add = (idx - d.weekday + 7) % 7;
    if (day[1] === "next" && add < 3) add += 7;
    d = d.plus({ days: add });
    const end = day[3] ? hm(d, 12) : hm(d, 20);
    // The day itself, already past its end: the same day next week.
    const target = end <= L ? end.plus({ days: 7 }) : end;
    const name = WEEKDAYS[idx - 1][0].toUpperCase() + WEEKDAYS[idx - 1].slice(1);
    return { words: `by ${name}${day[3] ? " morning" : ""}`, deadline: at(target) };
  }
  if (/\bthis week\b/.test(s)) {
    const fri = L.plus({ days: (5 - L.weekday + 7) % 7 });
    const end = hm(fri, 20);
    return { words: "this week", deadline: at(end <= L ? hm(L.plus({ days: (7 - L.weekday) || 7 }), 20) : end) };
  }
  if (/\bnext week\b/.test(s)) return { words: "next week", deadline: at(hm(L.plus({ days: 7 - L.weekday + 5 }), 20)) };
  return null;
}

// Pure: the last moment Co can still text them inside the window and inside their hours, less the margin. When nothing inside the
// window is sendable (a "tonight" said at 10:30pm), it is the first moment they can be told at all: the start of their next morning.
export function warnByFor(deadline: Date, now: Date, zone: string | null | undefined): Date {
  let t = new Date(Math.floor(deadline.getTime() / STEP_MS) * STEP_MS);
  if (t.getTime() >= deadline.getTime()) t = new Date(t.getTime() - STEP_MS);
  while (t.getTime() > now.getTime()) {
    if (sendableAt(t, zone)) {
      const w = new Date(t.getTime() + STEP_MS - WARN_MARGIN_MIN * 60_000);
      return w.getTime() > now.getTime() ? w : now;
    }
    t = new Date(t.getTime() - STEP_MS);
  }
  return sendableAt(now, zone) ? now : nextSendable(now, zone);
}

// Pure: when they'll have something started now, in their day: the words the after-call confirmation says when Co named no time
// on the call (services/callFollowThrough.ts), and so the window a call commitment holds itself to.
export function deliveryWords(now: Date, zone: string | null | undefined): "this morning" | "this afternoon" | "tonight" | "in the morning" {
  const h = localOf(now, zone).hour;
  const words = h >= 5 && h < 12 ? "this morning" : h >= 5 && h < 17 ? "this afternoon" : "tonight";
  // Tonight with no texting time left in it (a call that ends at 7:45pm, or 2am): say the morning up front, so the confirmation
  // and the window agree and a warning doesn't follow the confirmation a minute later (Royce, 2026-10-08).
  if (words === "tonight") {
    const w = windowFromWords("tonight", now, zone);
    const wb = w ? warnByFor(w.deadline, now, zone).getTime() : 0;
    if (w && (wb <= now.getTime() || wb >= w.deadline.getTime())) return "in the morning";
  }
  return words;
}

// The default when Co named no time: within a day.
export const DEFAULT_WINDOW_HOURS = 24;

// Pure: the window of a commitment. Its words when it names one; else `fallbackWords` (the after-call confirmation's own words, so
// what Co confirms and what it holds itself to are the same); else the default.
export function commitmentWindow(text: string, now: Date, zone: string | null | undefined, fallbackWords?: string | null): CommitWindow {
  const said = windowFromWords(text, now, zone);
  const fb = !said && fallbackWords ? windowFromWords(fallbackWords, now, zone) : null;
  const w = said ?? fb ?? { words: "within a day", deadline: new Date(now.getTime() + DEFAULT_WINDOW_HOURS * HOUR) };
  return { words: w.words, deadline: w.deadline.toISOString(), warnBy: warnByFor(w.deadline, now, zone).toISOString(), zone: validZone(zone), stated: !!said };
}

// Pure: would a next check at `nextAt` miss telling them inside the window (or has the warn-by already passed)?
export function missesWindow(w: Pick<CommitWindow, "warnBy">, nextAt: Date, now: Date): boolean {
  const by = new Date(w.warnBy).getTime();
  return nextAt.getTime() > by || now.getTime() >= by;
}

// Pure: a new time in their words, as Co would say it at `now`: "in the morning", "by 3pm", "tomorrow by 3pm", "Friday morning".
export function whenWords(target: Date, now: Date, zone: string | null | undefined): string {
  const T = localOf(target, zone);
  const N = localOf(now, zone);
  const time = T.toFormat(T.minute ? "h:mma" : "ha").toLowerCase();
  const morning = T.hour < 12 || (T.hour === 12 && T.minute === 0);
  const days = Math.round(T.startOf("day").diff(N.startOf("day"), "days").days);
  if (days <= 0) return morning && N.hour < 5 ? "in the morning" : `by ${time}`;
  if (days === 1) return morning ? (N.hour >= 17 ? "in the morning" : "tomorrow morning") : `tomorrow by ${time}`;
  if (days < 7) return morning ? `${T.toFormat("cccc")} morning` : `on ${T.toFormat("cccc")}`;
  return `on ${T.toFormat("LLLL d")}`;
}

// Pure: after a miss, the new window: the deliverable can go out at the first sendable moment at or after the next check. A
// morning one is due by noon; any other by three hours later, inside their day.
// Never later than their next morning: a check Co left at the one-day default doesn't push the new time to tomorrow night.
export function rescheduledWindow(nextAt: Date, now: Date, zone: string | null | undefined, prior: CommitWindow): { window: CommitWindow; checkAt: Date; when: string } {
  const N = localOf(now, zone);
  const morning = at(hm(N.hour >= 9 ? N.plus({ days: 1 }) : N, 9));
  const s = nextSendable(new Date(Math.min(nextAt.getTime(), morning.getTime())), zone);
  const S = localOf(s, zone);
  const end = S.hour < 12 ? hm(S, 12) : DateTime.min(S.plus({ hours: 3 }), hm(S, 20));
  const deadline = at(end);
  const when = whenWords(deadline, now, zone);
  return {
    window: {
      words: when,
      deadline: deadline.toISOString(),
      warnBy: warnByFor(deadline, s, zone).toISOString(),
      zone: validZone(zone),
      stated: true,
      warnedFor: [...(prior.warnedFor ?? []), prior.deadline],
      startsAt: s.toISOString(),
      previous: [...(prior.previous ?? []), { words: prior.words, deadline: prior.deadline }].slice(-5),
    },
    checkAt: s,
    when,
  };
}

// Pure: one line for a model or a fact sheet: what Co told them and the time it holds itself to, in their time.
export function windowLine(w: CommitWindow | null | undefined): string {
  if (!w || w.closedAt) return "";
  return `Co told them they'd have it ${w.words} (by ${localStamp(w.deadline, w.zone)}); if it can't be done by then, Co tells them before ${localStamp(w.warnBy, w.zone)}, with the new time.`;
}
