// Member-local time (Royce, 2026-10-07: "Co is time-aware at all times. Every decision that touches time runs against the member's
// local time, not the server's"). The one helper every time decision reads a member's zone through, plus Co's commitment windows
// (Royce, 2026-10-08: "Every commitment carries a window in member-local time, and a miss warns BEFORE the window passes").
//
// Their zone: stored on co_profiles.timezone, set from their city (geocoding.getTimezoneForCity) and refreshed whenever the city
// changes: co_profiles.timezone_city records the city the zone came from, so a city that differs from it (whichever path wrote it)
// re-derives the zone on the next read, and the two city writers (routes/co.ts, services/profileExtraction.ts) refresh it at once.
// The city on file is the only travel signal; there is no travel detection.
// The one fallback, when no zone is known: Pacific (FALLBACK_ZONE, services/localHours.ts; the club is in San Francisco), applied
// as a zone so it follows DST. Their words are read in it, their day is its day, and the send rule (8am-9pm since 2026-10-08) is measured
// in it, for texts and calls alike.
import { DateTime } from "luxon";
import { FALLBACK_ZONE, isReasonableLocalHour, nextReasonableHour, REASONABLE_HOUR_END, REASONABLE_HOUR_START } from "./localHours.js";

export { FALLBACK_ZONE };
// The task cron wakes every 15 minutes: the warn-by sits this far inside the last sendable moment, so a check due at the
// warn-by still runs (and can still text) before the window's texting closes.
export const WARN_MARGIN_MIN = 20;
const STEP_MS = 5 * 60_000;
const HOUR = 3_600_000;

export const validZone = (zone: string | null | undefined): string | null => (zone && DateTime.now().setZone(zone).isValid ? zone : null);
// The zone their words are read in: theirs, else the fallback.
export const wordsZone = (zone: string | null | undefined): string => validZone(zone) ?? FALLBACK_ZONE;
export const localOf = (at: Date, zone: string | null | undefined): DateTime => DateTime.fromJSDate(at).setZone(wordsZone(zone));
// Their calendar day (YYYY-MM-DD) at a moment: what "today", "yesterday" and "per day" mean for them.
export const localDay = (at: Date | string, zone: string | null | undefined): string => localOf(typeof at === "string" ? new Date(at) : at, zone).toISODate()!;
// The last moment of a calendar day (YYYY-MM-DD) in their zone.
export const endOfLocalDay = (day: string, zone: string | null | undefined): Date => DateTime.fromISO(day, { zone: wordsZone(zone) }).endOf("day").toJSDate();

// The send gate's answer for this moment (8am-9pm their time, or the fallback zone's; one rule for texts and calls).
export const sendableAt = (at: Date, zone: string | null | undefined): boolean => isReasonableLocalHour(validZone(zone), at);
export const nextSendable = (after: Date, zone: string | null | undefined): Date => nextReasonableHour(validZone(zone), after);

const cityKey = (c: string | null | undefined) => String(c ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Pure: the zone a profile row stands for, and what to store when the stored one is missing or came from another city.
// - A stored zone derived from the city on file is used as is (no lookup).
// - No zone stored, or the city changed since it was derived: the zone is looked up from the city and stored with that city.
// - No city: a stored zone (the last one known) is kept; else none (callers use the fallback).
// - A lookup that fails keeps the stored zone (the last known) and isn't marked refreshed, so the next read tries again.
export async function zoneFromProfile(
  p: { city?: string | null; timezone?: string | null; timezone_city?: string | null },
  lookup: (city: string) => Promise<string | null>,
): Promise<{ zone: string | null; store: { timezone: string; timezone_city: string } | null }> {
  const stored = validZone(p.timezone);
  const city = String(p.city ?? "").trim();
  if (!city) return { zone: stored, store: null };
  if (stored && cityKey(p.timezone_city) === cityKey(city)) return { zone: stored, store: null };
  const found = validZone(await lookup(city).catch(() => null));
  if (!found) return { zone: stored, store: null };
  return { zone: found, store: { timezone: found, timezone_city: String(p.city) } };
}

type Db = { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> };
// A bare city is read in their own state (from their phone's area code, services/areaCodes.ts) when it's known: "Cambridge" for a
// 617 number is Cambridge, Massachusetts, not England (2026-10-12 intelligence audit).
// The local place table first (services/placeResolve.ts: GeoNames' populated places, offline and free), then the geocoder when the
// table can't settle it (no such place, or same-named places in different zones with none clearly the one).
const lookupCity = async (city: string, region: string | null = null) => (await localZoneFor(city, region)) ?? (await import("./geocoding.js")).getTimezoneForCity(city, { region });

// The zone of their home city from the local place table, or null when it can't say (Royce, 2026-11-02: "derive each member's zone
// from their home city, which Cue already resolves"). Deterministic, no outside call: the same-named places that fit what the city
// says ("Portland, ME" is Maine) and their state when one is known (region: the 2-letter code from areaCodes.ts regionFor); the
// zone is the one every clearly-sized candidate agrees on. Two comparable places in different zones (Portland, OR and Portland, ME
// for a member with no state) is the geocoder's to settle, never a guess.
export async function localZoneFor(city: string, region: string | null = null): Promise<string | null> {
  try {
    const P = await import("./placeResolve.js");
    const { STATE_NAMES } = await import("./areaCodes.js");
    const q = P.parseQualified(city);
    if (!q.name) return null;
    if (!q.region && region && STATE_NAMES[region]) {
      q.region = STATE_NAMES[region].toLowerCase();
      q.country = q.country ?? "US";
    }
    const all = P.localLookup(q.name).filter((c) => P.matchesQualifier(c, q));
    if (!all.length) return null;
    const { find } = await import("geo-tz");
    const top = all[0].population ?? 0;
    // Every candidate within the dominance ratio of the biggest must agree on the zone.
    const contenders = all.filter((c) => (c.population ?? 0) * P.PLACE_RESOLVE.dominance >= top);
    const zones = new Set(contenders.map((c) => find(c.lat, c.lng)[0] ?? null));
    if (zones.size !== 1) return null;
    return validZone([...zones][0]);
  } catch {
    return null;
  }
}

// Their zone, or null when none is known (a time decision then measures in FALLBACK_ZONE: wordsZone / memberZoneOrFallback).
// Reads the stored zone; derives and stores it when it's missing or the city changed. Never throws.
export async function memberZone(userId: string, deps: { db?: Db; lookup?: (city: string) => Promise<string | null> } = {}): Promise<string | null> {
  try {
    const db: Db = deps.db ?? (await import("../db/db.js")).default;
    const { rows } = await db
      .query(`SELECT city, timezone, timezone_city FROM co_profiles WHERE user_id = $1`, [userId])
      // Before the column migration has run: the city alone.
      .catch(() => db.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId]));
    if (!rows[0]) return null;
    // Their state, read only when a lookup is needed; a failed read is no bias. What they said or have on file (their city, their
    // snapshot's place, a city claim) wins; the phone's area code is only a guess (services/areaCodes.ts regionFor).
    const regionOf = async () => {
      const q = (sql: string) => db.query(sql, [userId]).then((r) => r.rows).catch(() => [] as any[]);
      const [u, snap, claims] = await Promise.all([
        q(`SELECT phone_number FROM users WHERE id = $1`),
        q(`SELECT snapshot->>'place' AS place FROM person_snapshots WHERE user_id = $1`),
        q(`SELECT text FROM member_claims WHERE user_id = $1 AND kind = 'city' ORDER BY confirmed_on DESC LIMIT 3`),
      ]);
      const { regionFor } = await import("./areaCodes.js");
      return regionFor({ city: rows[0].city, places: [snap[0]?.place, ...claims.map((c: any) => c.text)], phone: u[0]?.phone_number });
    };
    const r = await zoneFromProfile(rows[0], deps.lookup ?? (async (city: string) => lookupCity(city, await regionOf())));
    if (r.store) {
      // Only if the city is still the one it came from (a concurrent city write re-derives on its own).
      await db
        .query(`UPDATE co_profiles SET timezone = $2, timezone_city = $3 WHERE user_id = $1 AND city = $3`, [userId, r.store.timezone, r.store.timezone_city])
        .catch((err: any) => console.error("memberZone: storing the zone failed (non-fatal):", err?.message ?? err));
    }
    return r.zone;
  } catch {
    return null;
  }
}

// Right after a city write: re-derive and store the zone now. Never throws.
export const refreshMemberZone = (userId: string): Promise<string | null> => memberZone(userId);

// Their zone or the fallback: the zone a time decision is measured in.
export async function memberZoneOrFallback(userId: string): Promise<string> {
  return wordsZone(await memberZone(userId));
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
  if (/\btomorrow\b/.test(s)) return { words: "tomorrow", deadline: at(hm(lateNight ? L : L.plus({ days: 1 }), REASONABLE_HOUR_END)) };
  if (/\b(?:tonight|this evening|later tonight)\b/.test(s)) return { words: "tonight", deadline: at(lateNight ? hm(L, 5) : L.endOf("day")) };
  if (/\bthis morning\b/.test(s)) return floor(hm(L, 12), "this morning");
  if (/\bthis afternoon\b/.test(s)) return floor(hm(L, 17), "this afternoon");
  if (/\b(?:later today|today|end of (?:the )?day|eod)\b/.test(s)) return floor(hm(L, REASONABLE_HOUR_END), "today");
  // A full weekday name, or a short one after by/on/before/this/next ("sat" and "sun" alone are other words).
  const day = s.match(/\b(?:(by|on|before|this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)\b(\s+morning)?/);
  if (day && (day[1] || day[2].length > 5)) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(day[2].slice(0, 3))) + 1;
    let d = L.startOf("day");
    let add = (idx - d.weekday + 7) % 7;
    if (day[1] === "next" && add < 3) add += 7;
    d = d.plus({ days: add });
    const end = day[3] ? hm(d, 12) : hm(d, REASONABLE_HOUR_END);
    // The day itself, already past its end: the same day next week.
    const target = end <= L ? end.plus({ days: 7 }) : end;
    const name = WEEKDAYS[idx - 1][0].toUpperCase() + WEEKDAYS[idx - 1].slice(1);
    return { words: `by ${name}${day[3] ? " morning" : ""}`, deadline: at(target) };
  }
  if (/\bthis week\b/.test(s)) {
    const fri = L.plus({ days: (5 - L.weekday + 7) % 7 });
    const end = hm(fri, REASONABLE_HOUR_END);
    return { words: "this week", deadline: at(end <= L ? hm(L.plus({ days: (7 - L.weekday) || 7 }), REASONABLE_HOUR_END) : end) };
  }
  if (/\bnext week\b/.test(s)) return { words: "next week", deadline: at(hm(L.plus({ days: 7 - L.weekday + 5 }), REASONABLE_HOUR_END)) };
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
  // Tonight with no texting time left in it (a call that ends at 8:45pm, or 2am): say the morning up front, so the confirmation
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
  const morning = at(hm(N.hour >= REASONABLE_HOUR_START ? N.plus({ days: 1 }) : N, REASONABLE_HOUR_START));
  const s = nextSendable(new Date(Math.min(nextAt.getTime(), morning.getTime())), zone);
  const S = localOf(s, zone);
  const end = S.hour < 12 ? hm(S, 12) : DateTime.min(S.plus({ hours: 3 }), hm(S, REASONABLE_HOUR_END));
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
  return `Cue told them they'd have it ${w.words} (by ${localStamp(w.deadline, w.zone)}); if it can't be done by then, Cue tells them before ${localStamp(w.warnBy, w.zone)}, with the new time.`;
}

// ---------- delivery hours (Royce, 2026-10-08)
// A document Co delivers on its own (a promise kept, a PDF that follows a text) goes inside the promised window but never in their
// quiet hours, 9pm to 8am their time, unless they asked for it right away ("send it tonight even if it's late"). A plan due
// overnight lands at 8am, not 2:14am. The same window as every text and call Co starts (services/localHours.ts).
export const DELIVERY_HOURS = { start: REASONABLE_HOUR_START, end: REASONABLE_HOUR_END } as const;

// Pure: whether a delivery may go at this moment, their time.
export function deliverableAt(at: Date, zone: string | null | undefined): boolean {
  const h = DateTime.fromJSDate(at).setZone(validZone(zone) ?? FALLBACK_ZONE).hour;
  return h >= DELIVERY_HOURS.start && h < DELIVERY_HOURS.end;
}

// Pure: the moment a delivery may go: now when inside their hours, else their next 8am.
export function nextDeliveryTime(after: Date, zone: string | null | undefined): Date {
  if (deliverableAt(after, zone)) return after;
  const local = DateTime.fromJSDate(after).setZone(validZone(zone) ?? FALLBACK_ZONE);
  let t = local.set({ hour: DELIVERY_HOURS.start, minute: 0, second: 0, millisecond: 0 });
  if (t <= local) t = t.plus({ days: 1 });
  return t.toJSDate();
}

// Pure: they asked for it right away, whatever the hour, in their own words. "Tonight" alone is a window, not leave to text at 2am.
const IMMEDIATE = /\b(?:right (?:now|away)|asap|immediately|as soon as (?:it'?s|you'?re|you have it|you can)(?: (?:ready|done|finished))?|whenever it'?s (?:ready|done)|even if it'?s (?:late|the middle of the night)|(?:no matter|whatever) (?:the time|how late)|don'?t wait (?:until|till|for) (?:the )?morning|send it (?:now|tonight) (?:even|no matter)|i'?ll be up)\b/i;
export const askedForImmediate = (theirWords: string | null | undefined): boolean => IMMEDIATE.test(String(theirWords ?? ""));
