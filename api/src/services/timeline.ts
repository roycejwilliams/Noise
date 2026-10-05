// Where they are in time, every turn (Royce, 2026-10-01: "Every turn you know
// the current date and time and their open commitments ... You have to inject
// the current time and their open loops into context every turn, or it's
// aware of nothing"). Their local time, and what's ahead in the next days from
// what Co already holds: calls with Co, deadlines on Co's tasks for them, busy
// blocks on their calendar (when Google is connected), plans they've
// mentioned, and the date in Co's working notes. One fact the reply reads; how
// to use it lives in CO_VOICE.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { getTimezoneForCity } from "./geocoding.js";
import { SNAPSHOT_MAX_AGE_MS } from "./googleData.js";
import { loadBrief } from "./searchIntent.js";
import { resolveAskWindow, whenForWindow } from "./askWindow.js";

export type TimelineItem = { at: string; allDay: boolean; what: string };

// Pure, so it can be checked without a database.
// Late at night with something early ahead: a fact worth Co's attention, so it
// rides along as a note (Royce, 2026-10-01: "still up at 1:40 before an early
// call - say it once, warmly, then let it go"). Facts only; Co decides.
export function lateNightNote(now: DateTime, items: TimelineItem[]): string | null {
  if (!(now.hour < 5 || now.hour >= 23)) return null;
  const soon = items
    .filter((i) => !i.allDay)
    .map((i) => ({ ...i, dt: DateTime.fromISO(i.at, { zone: now.zone }) }))
    .filter((i) => i.dt.isValid && i.dt > now && i.dt.diff(now, "hours").hours <= 10)
    .sort((a, b) => a.dt.toMillis() - b.dt.toMillis())[0];
  if (!soon) return null;
  const hours = Math.max(1, Math.round(soon.dt.diff(now, "hours").hours));
  return `It's ${now.toFormat("h:mm a")} for them and they have something at ${soon.dt.toFormat("h:mm a")} (in ${hours}h: ${soon.what}). If they're asking for more work or keeping the conversation going tonight, say so once in this reply, warmly and in a few words (that it's late and the ${soon.dt.toFormat("h a")} is coming), then do what they asked; don't bring it up again after this. A friend who remembers would notice, and it's what they'll care about in the morning.`;
}

// zoneKnown false: their city isn't known, so the time shown is Pacific and
// says so, rather than passing for their local time (2026-10-01 code review).
export function renderTimeline(now: DateTime, items: TimelineItem[], zoneKnown = true): string {
  const h = now.hour;
  const part = h < 5 ? "late at night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  const head = zoneKnown
    ? `Right now it's ${now.toFormat("h:mm a")} on ${now.toFormat("cccc, LLLL d")} where they are (${part}).`
    : `Right now it's ${now.toFormat("h:mm a")} on ${now.toFormat("cccc, LLLL d")} Pacific time. Their time zone isn't known, so don't assume that's their local time.`;
  const ahead = items
    .map((i) => ({ ...i, dt: DateTime.fromISO(i.at, { zone: now.zone }) }))
    .filter((i) => i.dt.isValid && (i.allDay ? i.dt.endOf("day") >= now : i.dt >= now))
    .sort((a, b) => a.dt.toMillis() - b.dt.toMillis())
    .slice(0, 6)
    .map((i) => {
      if (i.allDay) {
        const days = Math.round(i.dt.startOf("day").diff(now.startOf("day"), "days").days);
        const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `${i.dt.toFormat("ccc LLL d")} (in ${days} days)`;
        return `${when}: ${i.what}`;
      }
      const hours = i.dt.diff(now, "hours").hours;
      const when = hours < 24 ? `in ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${Math.round(hours)}h`} (${i.dt.toFormat("ccc h:mm a")})` : i.dt.toFormat("ccc LLL d, h:mm a");
      return `${when}: ${i.what}`;
    });
  return ahead.length ? `${head} What's ahead for them: ${ahead.join("; ")}.` : head;
}

export async function timelineFor(userId: string, city: string | null, now: Date = new Date()): Promise<{ fact: string; note: string | null }> {
  const found = city ? await getTimezoneForCity(city).catch(() => null) : null;
  const zone = found ?? "America/Los_Angeles";
  const local = DateTime.fromJSDate(now).setZone(zone);
  const q = (sql: string, args: unknown[]) => pool.query(sql, args).then((r) => r.rows).catch(() => [] as any[]);
  const [calls, tasks, busy, plans, brief] = await Promise.all([
    q(`SELECT scheduled_for FROM scheduled_calls WHERE user_id = $1 AND status = 'pending' AND scheduled_for > NOW() AND scheduled_for < NOW() + interval '3 days' ORDER BY scheduled_for LIMIT 2`, [userId]),
    q(`SELECT goal, deadline FROM co_tasks WHERE user_id = $1 AND status = 'open' AND deadline IS NOT NULL AND deadline >= CURRENT_DATE - 1 AND deadline < CURRENT_DATE + 14 ORDER BY deadline LIMIT 3`, [userId]),
    // Only a fresh calendar read counts as what's ahead: an old snapshot can
    // miss what they added or cancelled since (2026-10-01 code review).
    q(`SELECT s.busy FROM google_snapshots s JOIN google_connections c ON c.user_id = s.user_id WHERE s.user_id = $1 AND s.fetched_at > NOW() - make_interval(secs => $2)`, [userId, SNAPSHOT_MAX_AGE_MS / 1000]),
    q(`SELECT event_name_raw, event_date FROM planned_event_mentions WHERE user_id = $1 AND event_date >= CURRENT_DATE AND event_date < CURRENT_DATE + 14 ORDER BY event_date LIMIT 3`, [userId]),
    loadBrief(userId).catch(() => null),
  ]);
  const items: TimelineItem[] = [
    ...calls.map((c: any) => ({ at: new Date(c.scheduled_for).toISOString(), allDay: false, what: "a call with you (Co) they scheduled" })),
    ...tasks.map((t: any) => ({ at: String(t.deadline instanceof Date ? t.deadline.toISOString() : t.deadline).slice(0, 10), allDay: true, what: `the deadline they gave for "${String(t.goal).slice(0, 80)}"` })),
    ...((busy[0]?.busy ?? []) as { start: string; end: string }[])
      .filter((b) => new Date(b.start).getTime() - now.getTime() < 24 * 3600_000)
      .slice(0, 3)
      .map((b) => ({ at: b.start, allDay: false, what: "busy on their calendar" })),
    ...plans.map((p: any) => ({ at: String(p.event_date instanceof Date ? p.event_date.toISOString() : p.event_date).slice(0, 10), allDay: true, what: `${String(p.event_name_raw).slice(0, 80)} (they mentioned it)` })),
  ];
  const when = whenForWindow(brief?.when);
  const w = when ? resolveAskWindow(when, local).window : null;
  if (brief?.what && w) items.push({ at: w.start.toISODate()!, allDay: true, what: `${brief.what.slice(0, 80)} (what you're finding for them)` });
  // The late-night note needs their real clock.
  return { fact: renderTimeline(local, items, !!found), note: found ? lateNightNote(local, items) : null };
}
