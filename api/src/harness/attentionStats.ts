// How a member's attention is going (Royce, 2026-11-02, notification grouping part C, item 11: "Measure. Per member: reply rate per
// message, less/stop requests, expired items, messages arriving close together"). Logged once a day with the day's other numbers
// (jobs/index.ts, beside the daily failure count), per member, so the series exists and a change to the door, the back-off or the
// send hour shows in the numbers. LOG ONLY: nothing here sends, alerts or emails, changes what Cue sends, or reads a member's words.
//   replyRate   of the messages Cue sent them over the window that are old enough to have had a day to be answered, how many got a
//               message from them (a text, or a call where they spoke) within ANSWER_HOURS. One message is one send however many
//               bubbles it had (harness/notifyGate.ts countedRows); what rode inside another send isn't a message of its own.
//   lessStop    rules they set in the window about how often or when Cue contacts them or checks in (the preference store: contact and
//               check-ins areas), by count: a "less", a "stop", a quiet hour. Their words are never read here.
//   expired     items that passed their valid-until at the door without being sent (proactive_candidates status expired).
//   closeTogether messages that arrived within CLOSE_MINUTES of the one before.
// Counts only, by member id: no text, no names, no labels. Days are Pacific (the failure count's day).
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "./core.js";
import { MEMBER } from "./northStar.js";
import { answeredWithin } from "./attention.js";
import { countedRows } from "./notifyGate.js";
import { FAILURE_ZONE } from "./failureCount.js";

export const STATS_WINDOW_DAYS = 7;
export const ANSWER_HOURS = 24;
export const CLOSE_MINUTES = 60;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type MemberAttentionDay = {
  windowDays: number;
  // Messages Cue sent in the window, and the ones old enough to have had ANSWER_HOURS to be answered, with how many were.
  sent: number;
  answerable: number;
  answered: number;
  // answered / answerable, or null when none was old enough yet.
  replyRate: number | null;
  lessStop: number;
  expired: number;
  closeTogether: number;
};

// Pure: one member's numbers from what is recorded. sends: their proactive_sends rows in the window (type, time, notify_class);
// inbound: their own message times from the window start to ANSWER_HOURS past its end.
export function tallyMember(o: { now: Date; windowDays?: number; sends: { sentAt: Date; type: string; cls?: string | null }[]; inbound: Date[]; lessStop: number; expired: number }): MemberAttentionDay {
  const windowDays = o.windowDays ?? STATS_WINDOW_DAYS;
  const since = o.now.getTime() - windowDays * DAY;
  const messages = countedRows(o.sends.filter((s) => s.sentAt.getTime() >= since && s.sentAt.getTime() <= o.now.getTime())).sort((a, b) => a.at.getTime() - b.at.getTime());
  const answerable = messages.filter((m) => m.at.getTime() <= o.now.getTime() - ANSWER_HOURS * HOUR);
  const answered = answerable.filter((m) => answeredWithin(m.at, o.inbound, ANSWER_HOURS * HOUR)).length;
  const closeTogether = messages.filter((m, i) => i > 0 && m.at.getTime() - messages[i - 1].at.getTime() < CLOSE_MINUTES * 60_000).length;
  return { windowDays, sent: messages.length, answerable: answerable.length, answered, replyRate: answerable.length ? answered / answerable.length : null, lessStop: o.lessStop, expired: o.expired, closeTogether };
}

// Pure: whether a member's numbers are worth a row (something happened, or something went to them).
export const worthLogging = (d: MemberAttentionDay) => d.sent > 0 || d.lessStop > 0 || d.expired > 0;

// The SQL, exported so layer 1 can pin the definitions. $1, $2: the window; $3: the end plus ANSWER_HOURS (their answers to the last sends).
export const SENDS_SQL = `SELECT ps.user_id::text AS user_id, ps.type, ps.sent_at, ps.notify_class FROM proactive_sends ps JOIN users u ON u.id = ps.user_id WHERE ${MEMBER("u")} AND ps.sent_at >= $1 AND ps.sent_at < $2`;
export const INBOUND_SQL = `SELECT m.user_id::text AS user_id, m.created_at FROM co_memories m JOIN users u ON u.id = m.user_id WHERE ${MEMBER("u")} AND m.memory_type = 'text_exchange' AND (m.content LIKE 'User %' OR m.content LIKE '[Call]%') AND m.created_at >= $1 AND m.created_at < $3`;
export const EXPIRED_SQL = `SELECT c.user_id::text AS user_id, count(*)::int AS n FROM proactive_candidates c JOIN users u ON u.id = c.user_id WHERE ${MEMBER("u")} AND c.status = 'expired' AND c.decided_at >= $1 AND c.decided_at < $2 GROUP BY c.user_id`;
export const LESS_STOP_SQL = `SELECT f.owner_user_id::text AS user_id, count(*)::int AS n FROM co_facts f JOIN users u ON u.id = f.owner_user_id WHERE ${MEMBER("u")} AND f.relation = 'prefers' AND f.happened_at >= $1 AND f.happened_at < $2 AND f.meta->>'area' IN ('contact', 'checkins') GROUP BY f.owner_user_id`;

export const attentionDayKey = (now: Date) => DateTime.fromJSDate(now).setZone(FAILURE_ZONE).toISODate()!;

// Each morning, once per member per day: the window's numbers, logged (metrics.attention). Never throws into the caller's cron.
export async function recordDailyAttention(now = new Date()): Promise<number> {
  const day = attentionDayKey(now);
  const end = DateTime.fromJSDate(now).setZone(FAILURE_ZONE).startOf("day").toJSDate();
  const start = new Date(end.getTime() - STATS_WINDOW_DAYS * DAY);
  const answersBy = new Date(end.getTime() + ANSWER_HOURS * HOUR);
  const [done, sends, inbound, expired, lessStop] = await Promise.all([
    pool.query(`SELECT user_id::text AS user_id FROM harness_decisions WHERE decision = 'metrics.attention' AND action = 'daily' AND proposal->>'day' = $1`, [day]),
    pool.query(SENDS_SQL, [start, end]),
    pool.query(INBOUND_SQL, [start, end, answersBy]),
    pool.query(EXPIRED_SQL, [start, end]),
    pool.query(LESS_STOP_SQL, [start, end]),
  ]);
  const already = new Set((done.rows as any[]).map((r) => r.user_id));
  const by = <T>(rows: any[], f: (r: any) => T) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.user_id) ?? m.set(r.user_id, []).get(r.user_id)!).push(f(r));
    return m;
  };
  const sendsBy = by(sends.rows, (r) => ({ sentAt: new Date(r.sent_at), type: String(r.type), cls: r.notify_class ?? null }));
  const inboundBy = by(inbound.rows, (r) => new Date(r.created_at));
  const expiredBy = new Map((expired.rows as any[]).map((r) => [r.user_id, Number(r.n)]));
  const lessBy = new Map((lessStop.rows as any[]).map((r) => [r.user_id, Number(r.n)]));
  const ids = new Set([...sendsBy.keys(), ...expiredBy.keys(), ...lessBy.keys()]);
  let logged = 0;
  for (const userId of ids) {
    if (already.has(userId)) continue;
    // The window ends at the day's start, so "now" for the tally is that moment: the messages that were old enough by then.
    const d = tallyMember({ now: end, sends: sendsBy.get(userId) ?? [], inbound: inboundBy.get(userId) ?? [], lessStop: lessBy.get(userId) ?? 0, expired: expiredBy.get(userId) ?? 0 });
    if (!worthLogging(d)) continue;
    await recordDecision({ layer: 3, decision: "metrics.attention", userId, outcome: "act", action: "daily", proposal: { day, ...d } }).catch((err: any) => console.error("attention stats: a row failed to log (non-fatal):", err?.message ?? err));
    logged++;
  }
  return logged;
}
