// When each member actually engages, MEASURED ONLY (Royce, 2026-10-14: "Learn when each member actually engages and weight presence
// toward it instead of a flat schedule for everyone. Measure first: log engagement times before changing any send timing. The silence
// pacing we built stays the guardrail - presence is earned, a member who goes quiet gets less, not more").
//
// Nothing reads this to time a send. It is a read-only view for the team on the co-test dashboard (co-test/src/routes/sweeps.ts
// /api/sweeps/rhythm), computed on demand from rows that already exist, so there is no new table, no daily job and nothing new to
// keep or forget: the timestamps are the log. A daily harness decision per member would copy those same timestamps into a second
// place every day; this reads them where they are. Layer 1 (evals/checkins/rules.ts) fails if any send-timing code imports it.
//   started   their texts that opened a conversation (nothing from either side in the START_GAP_HOURS before), by their local hour
//             and weekday
//   replies   Co's proactive texts (proactive_sends) and how long until their next text, within REPLY_WINDOW_HOURS
// Only timestamps and who sent each line are read, never what anyone said. Team only: it names members.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { hoursZone } from "./localHours.js";
import { memberZone } from "./memberTime.js";
import { notToTeammate } from "./teamLines.js";

export const START_GAP_HOURS = 3;
export const REPLY_WINDOW_HOURS = 48;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type RhythmLine = { at: Date; theirs: boolean };
export type RhythmRow = {
  userId: string;
  name: string;
  zone: string;
  // Conversations they opened, by their local hour (0-23) and weekday (Mon first).
  started: number;
  byHour: number[];
  byWeekday: number[];
  // Their three busiest opening hours ("9pm, 10pm, 8am") and day, or null with too little to say.
  peakHours: string | null;
  peakDay: string | null;
  // Co's proactive texts in the window, how many got a text back within REPLY_WINDOW_HOURS, and the median minutes until it did.
  proactive: number;
  replied: number;
  medianReplyMin: number | null;
};

const hourWords = (h: number) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);

// Pure: one member's rhythm from their exchange (who sent each line, when) and Co's proactive sends, in their zone.
export function rhythmOf(lines: RhythmLine[], sends: Date[], zone: string): Omit<RhythmRow, "userId" | "name" | "zone"> {
  const xs = [...lines].sort((a, b) => a.at.getTime() - b.at.getTime());
  const byHour = Array(24).fill(0) as number[];
  const byWeekday = Array(7).fill(0) as number[];
  let started = 0;
  xs.forEach((l, i) => {
    if (!l.theirs) return;
    const prev = xs[i - 1];
    if (prev && l.at.getTime() - prev.at.getTime() < START_GAP_HOURS * 3_600_000) return;
    const local = DateTime.fromJSDate(l.at).setZone(zone);
    byHour[local.hour]++;
    byWeekday[local.weekday - 1]++;
    started++;
  });
  const top = byHour.map((n, h) => ({ n, h })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.h - b.h).slice(0, 3);
  const dayMax = Math.max(...byWeekday);
  const waits: number[] = [];
  for (const s of sends) {
    const next = xs.find((l) => l.theirs && l.at.getTime() > s.getTime());
    if (next && next.at.getTime() - s.getTime() <= REPLY_WINDOW_HOURS * 3_600_000) waits.push((next.at.getTime() - s.getTime()) / 60_000);
  }
  waits.sort((a, b) => a - b);
  const median = waits.length ? (waits.length % 2 ? waits[(waits.length - 1) / 2] : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2) : null;
  return {
    started,
    byHour,
    byWeekday,
    peakHours: started >= 3 ? top.map((x) => hourWords(x.h)).join(", ") : null,
    peakDay: started >= 3 && dayMax > 0 ? WEEKDAYS[byWeekday.indexOf(dayMax)] : null,
    proactive: sends.length,
    replied: waits.length,
    medianReplyMin: median === null ? null : Math.round(median),
  };
}

// The team's view: every live member, over the last `days`. Read-only.
export async function engagementRhythm(days = 28): Promise<RhythmRow[]> {
  const d = String(Math.min(90, Math.max(1, Math.floor(days))));
  const { rows: members } = await pool.query(`SELECT u.id, u.first_name, u.last_name FROM users u WHERE u.archived_at IS NULL AND u.phone_number IS NOT NULL AND u.phone_number NOT LIKE '%#%' AND u.invite_verified = true ORDER BY u.created_at`);
  const { rows: lines } = await pool.query(
    `SELECT user_id, created_at, (content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%') AS theirs FROM co_memories
      WHERE memory_type = 'text_exchange' AND ${notToTeammate()} AND (content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%' OR content LIKE 'Co replied:%' OR content LIKE 'Co is looking:%')
        AND created_at > NOW() - ($1 || ' days')::interval`,
    [d],
  );
  const { rows: sends } = await pool.query(`SELECT user_id, sent_at FROM proactive_sends WHERE sent_at > NOW() - ($1 || ' days')::interval`, [d]);
  const out: RhythmRow[] = [];
  for (const m of members) {
    const zone = hoursZone(await memberZone(m.id).catch(() => null));
    const mine = lines.filter((l: any) => l.user_id === m.id).map((l: any) => ({ at: new Date(l.created_at), theirs: !!l.theirs }));
    const sent = sends.filter((s: any) => s.user_id === m.id).map((s: any) => new Date(s.sent_at));
    if (!mine.length && !sent.length) continue;
    out.push({ userId: m.id, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || "(no name)", zone, ...rhythmOf(mine, sent, zone) });
  }
  return out.sort((a, b) => b.started - a.started || a.name.localeCompare(b.name));
}
