// An "add to calendar" file, only where it serves matching (Royce, 2026-11-04): when a member says they're going to a Noise event
// (updateGoing). General plans get none (the plan sheet was removed). Nothing else builds, offers or attaches one.
// The .ics holds the event's real instant (UTC, so any calendar shows it at the right local time), its name, place and link. It goes by
// email to the member's own address on file, and to nobody else. Pure builder first; sending is gated like every real send.
import { DateTime } from "luxon";

export type CalendarEvent = { id: string; name: string; startAt: string; endAt?: string | null; timezone?: string | null; venue?: string | null; address?: string | null; url?: string | null };

// RFC 5545 TEXT escaping: backslash first, then semicolon and comma, and every line break (CRLF, LF or a lone CR) as \n.
export const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
// Lines are folded at 75 octets, continuation lines start with a space (RFC 5545).
function fold(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}
const utc = (d: DateTime) => d.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");

// Pure: the .ics for one event, or null when its start can't be read. An event with no end is held for two hours.
export function buildEventIcs(e: CalendarEvent, now: Date): string | null {
  const zone = e.timezone && DateTime.now().setZone(e.timezone).isValid ? e.timezone : "UTC";
  const start = DateTime.fromISO(e.startAt, { zone });
  if (!e.name?.trim() || !start.isValid) return null;
  const parsedEnd = e.endAt ? DateTime.fromISO(e.endAt, { zone }) : null;
  const end = parsedEnd?.isValid && parsedEnd > start ? parsedEnd : start.plus({ hours: 2 });
  const where = [e.venue, e.address].filter(Boolean).join(", ");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cue//Event//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:event-${e.id}@copatible.com`,
    `DTSTAMP:${utc(DateTime.fromJSDate(now))}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${esc(e.name.trim())}`,
    ...(where ? [`LOCATION:${esc(where)}`] : []),
    ...(e.url && /^https:\/\/\S+$/.test(e.url) ? [`URL:${e.url}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export type GoingCalendar = { sent: boolean; why?: string };
type Deps = {
  loadEvent: (eventApiId: string) => Promise<CalendarEvent | null>;
  loadEmail: (userId: string) => Promise<string | null>;
  send: (o: { to: string; subject: string; text: string; ics: string; filename: string }) => Promise<boolean>;
  // Once per member per event: a ledger key claimed before the send and given back if it fails.
  claim: (userId: string, key: string) => Promise<boolean>;
  release: (userId: string, key: string) => Promise<void>;
  now?: () => Date;
};

const realDeps: Deps = {
  loadEvent: async (id) => {
    const e = (await (await import("./eventPresence.js")).presenceEvents()).find((x) => x.api_id === id);
    return e ? { id: e.api_id, name: e.name, startAt: e.start_at, endAt: e.end_at, timezone: e.timezone ?? null, venue: e.venue ?? null, address: (e as any).address ?? null, url: e.url } : null;
  },
  loadEmail: async (userId) => {
    const { default: pool } = await import("../db/db.js");
    const { usableEmail } = await import("./identity.js");
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    return usableEmail(rows[0]?.email);
  },
  claim: async (userId, key) => {
    const { default: pool } = await import("../db/db.js");
    const r = await pool.query(`INSERT INTO proactive_sends (user_id, type, target_key, exempt) VALUES ($1, 'event_calendar', $2, true) ON CONFLICT (user_id, target_key) DO NOTHING RETURNING id`, [userId, key]);
    return !!r.rows[0];
  },
  release: async (userId, key) => {
    const { default: pool } = await import("../db/db.js");
    await pool.query(`DELETE FROM proactive_sends WHERE user_id = $1 AND target_key = $2 AND type = 'event_calendar'`, [userId, key]).catch(() => {});
  },
  send: async ({ to, subject, text, ics, filename }) => {
    const [{ ALLOW_REAL_SENDS }, { CO_EMAIL_FROM }] = await Promise.all([import("../otpActions.js"), import("./emailFrom.js")]);
    if (!ALLOW_REAL_SENDS || !process.env.RESEND_API_KEY) return false;
    const { Resend } = await import("resend");
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: CO_EMAIL_FROM, to: [to], subject, text, attachments: [{ filename, content: Buffer.from(ics, "utf8"), contentType: "text/calendar" }] });
    return !error;
  },
};

// They said they're going to this Noise event: the calendar file to their own email. Only that; never a plan, never another person.
export async function sendGoingCalendar(userId: string, eventApiId: string, deps: Partial<Deps> = {}): Promise<GoingCalendar> {
  const d = { ...realDeps, ...deps };
  const now = d.now?.() ?? new Date();
  const [event, to] = await Promise.all([d.loadEvent(eventApiId).catch(() => null), d.loadEmail(userId).catch(() => null)]);
  if (!event) return { sent: false, why: "no such event" };
  if (!to) return { sent: false, why: "no email on file" };
  const ics = buildEventIcs(event, now);
  if (!ics) return { sent: false, why: "no readable start time" };
  // At most once per member per event, however many times they say they're going.
  const key = `event_calendar:${eventApiId}`;
  if (!(await d.claim(userId, key).catch(() => false))) return { sent: false, why: "already sent" };
  const ok = await d.send({ to, subject: `${event.name} on your calendar`, text: `The calendar file for ${event.name} is attached.`, ics, filename: "event.ics" }).catch(() => false);
  if (!ok) await d.release(userId, key).catch(() => {});
  return ok ? { sent: true } : { sent: false, why: "couldn't send" };
}
