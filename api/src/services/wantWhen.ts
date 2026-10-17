// When a want is for, and when they're free (Royce, 2026-10-15, the bounce: "Windows on wants. A want can carry a solve-by window set
// in conversation, the same way 219 sets place. 'I'm in Chicago til Friday' sets the place AND the window. No form fields, no profile
// surgery." And: "Stated availability as knowledge... Stated gaps can be proposed against. Never plan against an inferred gap").
//
// Both come only from what the member said, and code checks their words say it (the model proposes; code keeps):
//   - a window: the day it ends ("til Friday", "through the 17th", "tomorrow") must be in their words, and it must be soon;
//   - a free time: the day and both times ("Tuesday 4 to 5:30") must be in their words. "Afternoons" or "sometime" is never a gap.
// Nothing here is inferred: a quiet afternoon in their patterns is something Cue may ask about ("free afternoon coming up?"), never a
// gap it plans against. A calendar gap (services/googleData.ts, once they grant free/busy) is the only kind that may hold a slot.
// Both are knowledge they can see, correct and remove (whatCoKnows.ts: the want's place line carries its window; free times are lines
// of their own).
import pool from "../db/db.js";
import { DateTime } from "luxon";

export const WHEN_LIMITS = { windowMaxDays: 60, gapMinMinutes: 15, gapMaxMinutes: 12 * 60, freeTimesShown: 12 } as const;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const weekdayOf = (d: string) => WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7];
// A whole word ("fri" never matches inside "fridge", "wed" never inside "wedding"); a plural or a trailing dot is fine.
const said = (quote: string, word: string) => new RegExp(`\\b(?:${word})s?\\.?(?![a-z])`, "i").test(quote);
const SHORT: Record<(typeof WEEKDAYS)[number], string> = { monday: "mon", tuesday: "tues?", wednesday: "wed", thursday: "thu(?:rs?)?", friday: "fri", saturday: "sat", sunday: "sun" };
// A short form counts only where it reads as a day: after "til", "on", "this"... ("til Fri") or right before a time ("Sat 4-6").
// "I sat around 4" and "the sun is out" are not Saturday and Sunday (review of #220).
const saidShort = (quote: string, wd: (typeof WEEKDAYS)[number]) =>
  new RegExp(`\\b(?:til|till|until|thru|through|on|this|next|by|from|before|after)\\s+(?:${SHORT[wd]})s?\\.?(?![a-z])|\\b(?:${SHORT[wd]})s?\\.?\\s*\\d`, "i").test(quote);

// Pure: the day a window ends, kept only when their words say that day and it's soon (today to WHEN_LIMITS.windowMaxDays out).
// Their words may name its weekday ("til Friday"), its date ("through Oct 17", "the 17th"), or say tomorrow / tonight / today.
export function windowBacked(end: string | null | undefined, quote: string, today: string): string | null {
  const e = String(end ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e) || !Number.isFinite(Date.parse(`${e}T00:00:00Z`))) return null;
  const ahead = days(today, e);
  if (ahead < 0 || ahead > WHEN_LIMITS.windowMaxDays) return null;
  const q = quote.toLowerCase();
  if (ahead === 0 && /\b(today|tonight|this evening)\b/.test(q)) return e;
  if (ahead === 1 && /\btomorrow\b/.test(q)) return e;
  if (ahead <= 7 && (said(q, weekdayOf(e)) || saidShort(q, weekdayOf(e)))) return e;
  const [, mm, dd] = e.split("-");
  const month = MONTHS[Number(mm) - 1];
  const day = Number(dd);
  const abbr = month === "september" ? "sept?" : month.slice(0, 3);
  if (new RegExp(`\\b(${month}|${abbr})\\.?\\s+${day}(st|nd|rd|th)?\\b|\\b${day}(st|nd|rd|th)?\\s+(of\\s+)?(${month}|${abbr})\\b|\\b0?${Number(mm)}/0?${day}\\b`).test(q)) return e;
  // "the 17th" alone: only inside the coming month, so it can only be this one day.
  if (ahead <= 31 && new RegExp(`\\bthe\\s+${day}(st|nd|rd|th)\\b`).test(q)) return e;
  return null;
}

export type FreeTime = { weekday: (typeof WEEKDAYS)[number] | null; date: string | null; from: string; to: string };

const minutes = (hhmm: string) => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
// The ways a time can be said: "4", "4pm", "4:00", "16:00", "5:30", "5.30" (the hour in 12h or 24h, with its minutes when they aren't :00).
// An am/pm they said has to agree: "4am" never backs 16:00.
function timeSaid(q: string, hhmm: string): boolean {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mins = m ? `[:.]${String(m).padStart(2, "0")}` : `(?:[:.]00)?`;
  for (const x of q.matchAll(new RegExp(`(?:^|[^0-9])(?:${h12}|${h})${mins}(?![0-9])\\s*([ap])?\\.?m?\\b`, "g"))) {
    if (!x[1] || (x[1] === "a") === h < 12) return true;
  }
  return (m === 30 && new RegExp(`half\\s+past\\s+${h12}\\b`).test(q)) || (h === 12 && m === 0 && /\bnoon\b/.test(q));
}

// Pure: a free time they stated, kept only when their words say its day (a weekday, or a date this side of WHEN_LIMITS.windowMaxDays)
// and both of its times, and it's a real span. Anything vaguer ("afternoons", "after lunch") is no gap.
export function freeTimeBacked(f: Partial<FreeTime>, quote: string, today: string): FreeTime | null {
  const from = String(f.from ?? ""), to = String(f.to ?? "");
  const a = minutes(from), b = minutes(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < WHEN_LIMITS.gapMinMinutes || b - a > WHEN_LIMITS.gapMaxMinutes) return null;
  const q = quote.toLowerCase();
  if (!timeSaid(q, from) || !timeSaid(q, to)) return null;
  const wd = f.weekday && (WEEKDAYS as readonly string[]).includes(String(f.weekday).toLowerCase()) ? (String(f.weekday).toLowerCase() as FreeTime["weekday"]) : null;
  const date = f.date && /^\d{4}-\d{2}-\d{2}$/.test(String(f.date)) ? String(f.date) : null;
  if (date) {
    if (!windowBacked(date, quote, today)) return null;
    return { weekday: null, date, from, to };
  }
  if (wd && (said(q, wd) || saidShort(q, wd))) return { weekday: wd, date: null, from, to };
  return null;
}

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};
export function describeFreeTime(f: FreeTime): string {
  const day = f.date ? DateTime.fromISO(f.date).toFormat("cccc, LLLL d") : `${f.weekday![0].toUpperCase()}${f.weekday!.slice(1)}s`;
  return `${day}, ${clock(f.from)} to ${clock(f.to)}`;
}
export function describeWindow(start: string | null, end: string): string {
  return `${start ? `from ${DateTime.fromISO(start).toFormat("ccc LLL d")} ` : ""}until ${DateTime.fromISO(end).toFormat("cccc, LLLL d")}`;
}

// Pure: whether a stated free time falls on this day (its weekday, or its date), and not past.
export function freeOn(f: FreeTime, day: string): boolean {
  return f.date ? f.date === day : weekdayOf(day) === f.weekday;
}

// ---------------------------------------------------------------- data

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// The place and window a want was recorded with, in the same breath as the want (their words). Overrides anything read before: they
// just said it.
export async function saveWantWhere(db: Db, userId: string, key: string, text: string, w: { place: string | null; placeQuote: string | null; windowStart: string | null; windowEnd: string | null; windowQuote: string | null }): Promise<void> {
  await db.query(
    `INSERT INTO want_places (user_id, want_key, want_text, place, source, quote, noted_at, window_start, window_end, window_quote)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4::text IS NOT NULL THEN NOW() END, $7, $8, $9)
     ON CONFLICT (user_id, want_key) DO UPDATE SET
       place = COALESCE(EXCLUDED.place, want_places.place), source = CASE WHEN EXCLUDED.place IS NOT NULL THEN EXCLUDED.source ELSE want_places.source END,
       quote = COALESCE(EXCLUDED.quote, want_places.quote), noted_at = COALESCE(want_places.noted_at, EXCLUDED.noted_at),
       window_start = COALESCE(EXCLUDED.window_start, want_places.window_start), window_end = COALESCE(EXCLUDED.window_end, want_places.window_end),
       window_quote = COALESCE(EXCLUDED.window_quote, want_places.window_quote), updated_at = NOW()`,
    [userId, key, text.slice(0, 300), w.place, w.place ? "their_words" : "unread", w.placeQuote, w.windowStart, w.windowEnd, w.windowQuote],
  );
}

// A window that has ended (Royce, 2026-10-16: "in Chicago til Friday" stops searching Chicago after Friday, and their words about
// the window are deleted): the window and its words go, and so does a place read from what they said (their words with the want, or
// what they told Cue, which is how "I'm in Chicago til Friday" is often read); the home city stands in. A place they corrected stays.
// The want itself stays.
const END_WINDOW = `UPDATE want_places SET
    place = CASE WHEN source IN ('their_words', 'told') THEN NULL ELSE place END, quote = CASE WHEN source IN ('their_words', 'told') THEN NULL ELSE quote END,
    source = CASE WHEN source IN ('their_words', 'told') THEN 'none' ELSE source END,
    window_start = NULL, window_end = NULL, window_quote = NULL, updated_at = NOW()
  WHERE window_end IS NOT NULL AND `;
// One want's window, once their own day is past it (wantPlace.ts placeFor, before every search).
export async function endWindow(db: Db, userId: string, key: string): Promise<void> {
  await db.query(`${END_WINDOW}user_id = $1 AND want_key = $2`, [userId, key]);
}
// Every window past on any clock (a day's slack covers every zone): the hourly backstop for wants no search reads (jobs/index.ts).
export async function endPastWindows(db: Db = pool): Promise<number> {
  const { rowCount } = await db.query(`${END_WINDOW}window_end < CURRENT_DATE - 1`);
  return rowCount ?? 0;
}

export async function saveFreeTime(db: Db, userId: string, f: FreeTime, quote: string): Promise<string> {
  // Said twice, kept once: the same day and span already standing is that row.
  const same = await db.query(
    `SELECT id FROM member_free_times WHERE user_id = $1 AND removed_at IS NULL AND weekday IS NOT DISTINCT FROM $2 AND on_date IS NOT DISTINCT FROM $3::date
       AND start_time = $4::time AND end_time = $5::time LIMIT 1`,
    [userId, f.weekday, f.date, f.from, f.to],
  );
  if (same.rows[0]?.id) return String(same.rows[0].id);
  const { rows } = await db.query(
    `INSERT INTO member_free_times (user_id, weekday, on_date, start_time, end_time, quote) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, f.weekday, f.date, f.from, f.to, quote.slice(0, 300)],
  );
  return String(rows[0]?.id ?? "");
}

// Their stated free times still standing: recurring ones, and dated ones not yet past.
export async function freeTimesOf(userId: string, today: string, db: Db = pool): Promise<(FreeTime & { id: string; quote: string })[]> {
  const { rows } = await db.query(
    `SELECT id, weekday, on_date, start_time, end_time, quote FROM member_free_times WHERE user_id = $1 AND removed_at IS NULL AND (on_date IS NULL OR on_date >= $2::date)
     ORDER BY created_at DESC LIMIT $3`,
    [userId, today, WHEN_LIMITS.freeTimesShown],
  );
  const hm = (t: unknown) => String(t ?? "").slice(0, 5);
  return rows.map((r: any) => ({ id: String(r.id), weekday: r.weekday ?? null, date: r.on_date ? (r.on_date instanceof Date ? r.on_date.toISOString().slice(0, 10) : String(r.on_date).slice(0, 10)) : null, from: hm(r.start_time), to: hm(r.end_time), quote: String(r.quote ?? "") }));
}
