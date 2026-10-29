// The daily failure count (Royce, 2026-10-17: "Count every fallback line and every cut-to-nothing reply per day, and send me that
// number. Alert me if it's above zero on a member-facing day. Changes nothing Cue sends."). Before it, the 10-17 "Anything you have
// for me in SF?" fallback was found only by texting it, and 42 fallback lines on 10-12 raised no alert: the hourly monitor
// (harness/monitor.ts) watches rates against their week, into the decision log.
// Counted from what is recorded; nothing changes what Cue sends. A failure is a member not getting an answer:
//   fallback lines  a text Cue sent that is one of the lines that answer nothing (services/turnFailure.ts OWED_AFTER), as logged
//                   ("Co replied: <line>", the internal prefix)
//   no reply at all a reply the fact check left empty while nothing had answered them, and nothing else went to them in the next
//                   3 minutes. The deliberate empty end (an answer already went: alreadyAnswered) isn't one (Royce: "counting them makes
//                   the number noise"). A cut whose turn went on to a real reply is "redrafted fine", its own number, never a failure
//                   (Royce: "A cut that got redrafted fine doesn't count as a failure. Track it as its own number."); one followed by a
//                   fallback line or the "not sure" line is counted there, once.
//   couldn't help   (Royce: "a separate bucket. Those are members not getting help") the fact check's own "not sure" line
//                   (reply.grounding notSure), a call that couldn't connect because of Cue's own voice setup (call_failure
//                   'registration'; a member not picking up Cue's call is never one, Royce), and a call turn that ended on its
//                   last-resort line (call.last_resort)
// Who: members (harness/northStar.ts MEMBER, not the team), the team (users.mo_approver), and test or archived members, each apart.
// A member-facing day: a member wrote to Cue that day (the team doesn't make one). Days are Pacific.
// To Royce only, by text, and only when there's something to say (Royce: "No daily email. Alert text only when the count is above
// zero."): the first time on a member-facing day that a member (never the team or a test member) hit a failure, once a day, between 8am and 9pm Pacific
// ("The alert respects 8am to 9pm"); a failure late at night is told at 8am. Each day's numbers are also logged (metrics.failures,
// no message) so the redrafted-fine number is kept even on days nothing alerts.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "./core.js";
import { MEMBER } from "./northStar.js";
import { notToTeammate } from "../services/teamLines.js";
import { OWED_AFTER } from "../services/turnFailure.js";
import { REASONABLE_HOUR_END, REASONABLE_HOUR_START } from "../services/localHours.js";
import { ALLOW_REAL_SENDS } from "../otpActions.js";

export const FAILURE_ZONE = "America/Los_Angeles";
export const FALLBACK_LOGGED = OWED_AFTER.map((l) => `Co replied: ${l}`);
// How long after a cut the turn's own next text can still land (the reply's deadline is 75s plus 30s grace).
export const CUT_FOLLOW_MINUTES = 3;

export type Who = "member" | "team" | "test";
export type FailureKind = "fallback" | "cut" | "nohelp";
// line: a fallback's line, a couldn't-help's kind, or for a cut what followed it: nothing, redrafted (a real reply went) or covered
// (a fallback or the "not sure" line went, counted there).
export type FailureRow = { kind: FailureKind; line: string | null; who: Who; user_id?: string | null };
type Counts = Record<Who, number>;
export type FailureDay = {
  day: string;
  fallbacks: Counts & { byLine: Record<Who, Record<string, number>> };
  // Left with no reply at all.
  cuts: Counts;
  // Cut, then the turn went on to a real reply: not a failure, its own number.
  redrafted: Counts;
  noHelp: Counts & { byLine: Record<Who, Record<string, number>> };
  // Members (not the team) who got any failure.
  membersHit: number;
  // Texts members (not the team) sent Cue that day: above zero makes it a member-facing day.
  memberTexts: number;
};

// The SQL, exported so layer 1 can pin the definitions. $1, $2: the day's bounds; $3: the fallback lines as logged.
const WHO = (col: string) => `CASE WHEN ${col} IN (SELECT id FROM team) THEN 'team' WHEN ${col} IN (SELECT id FROM real) THEN 'member' ELSE 'test' END`;
const AFTER = (alias: string) => `${alias}.user_id = d.user_id AND ${alias}.created_at >= d.created_at AND ${alias}.created_at < d.created_at + INTERVAL '${CUT_FOLLOW_MINUTES} minutes'`;
export const FAILURES_SQL = `
  WITH real AS (SELECT u.id FROM users u WHERE ${MEMBER("u")}),
       team AS (SELECT u.id FROM users u WHERE ${MEMBER("u")} AND u.mo_approver = true)
  SELECT 'fallback' AS kind, m.content AS line, m.user_id::text AS user_id, ${WHO("m.user_id")} AS who
  FROM co_memories m
  WHERE m.memory_type = 'text_exchange' AND m.content = ANY($3::text[]) AND m.created_at >= $1 AND m.created_at < $2
  UNION ALL
  SELECT 'cut',
    CASE
      WHEN EXISTS (SELECT 1 FROM co_memories f WHERE f.memory_type = 'text_exchange' AND f.content = ANY($3::text[]) AND ${AFTER("f")}) THEN 'covered'
      WHEN EXISTS (SELECT 1 FROM harness_decisions n WHERE n.layer = 3 AND n.decision = 'reply.grounding' AND n.proposal->>'notSure' = 'true' AND ${AFTER("n")}) THEN 'covered'
      WHEN EXISTS (SELECT 1 FROM co_memories r WHERE r.memory_type = 'text_exchange' AND r.content LIKE 'Co replied:%' AND NOT (r.content = ANY($3::text[])) AND ${AFTER("r")}) THEN 'redrafted'
      ELSE 'nothing'
    END,
    d.user_id::text, ${WHO("d.user_id")}
  FROM harness_decisions d
  WHERE d.layer = 3 AND d.decision = 'reply.grounding' AND btrim(COALESCE(d.proposal->>'final', '')) = ''
    AND COALESCE(d.proposal->>'alreadyAnswered', 'false') <> 'true' AND d.created_at >= $1 AND d.created_at < $2
  UNION ALL
  SELECT 'nohelp', 'the fact check''s "not sure" line', d.user_id::text, ${WHO("d.user_id")}
  FROM harness_decisions d
  WHERE d.layer = 3 AND d.decision = 'reply.grounding' AND d.action = 'stripped' AND d.proposal->>'notSure' = 'true'
    AND d.created_at >= $1 AND d.created_at < $2
  UNION ALL
  SELECT 'nohelp', 'a call that couldn''t connect (Cue''s own voice setup)', m.user_id::text, ${WHO("m.user_id")}
  FROM co_memories m
  WHERE m.memory_type = 'call_failure' AND m.content LIKE '%own voice setup%' AND m.created_at >= $1 AND m.created_at < $2
  UNION ALL
  SELECT 'nohelp', 'a call turn that ended on its last-resort line', d.user_id::text, ${WHO("d.user_id")}
  FROM harness_decisions d
  WHERE d.layer = 8 AND d.decision = 'call.last_resort' AND d.created_at >= $1 AND d.created_at < $2`;
export const MEMBER_TEXTS_SQL = `
  SELECT count(*) AS n FROM co_memories m JOIN users u ON u.id = m.user_id
  WHERE ${MEMBER("u")} AND u.mo_approver = false AND m.memory_type = 'text_exchange' AND (m.content LIKE 'User said:%' OR m.content LIKE 'User sent a voice memo:%')
    AND ${notToTeammate("m")} AND m.created_at >= $1 AND m.created_at < $2`;

// Pure: a Pacific day's bounds.
export function dayBounds(day: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(day, { zone: FAILURE_ZONE }).startOf("day");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}
export const pacificDay = (now: Date) => DateTime.fromJSDate(now).setZone(FAILURE_ZONE).toISODate()!;
// Pure: inside 8am to 9pm Pacific (services/localHours.ts, the one window), Royce's own hours.
export const alertHours = (now: Date) => {
  const h = DateTime.fromJSDate(now).setZone(FAILURE_ZONE).hour;
  return h >= REASONABLE_HOUR_START && h < REASONABLE_HOUR_END;
};

const zero = (): Counts => ({ member: 0, team: 0, test: 0 });
// Pure: the day's count from its rows.
export function tally(day: string, rows: FailureRow[], memberTexts: number): FailureDay {
  const out: FailureDay = {
    day,
    fallbacks: { ...zero(), byLine: { member: {}, team: {}, test: {} } },
    cuts: zero(),
    redrafted: zero(),
    noHelp: { ...zero(), byLine: { member: {}, team: {}, test: {} } },
    membersHit: 0,
    memberTexts,
  };
  const hit = new Set<string>();
  for (const r of rows) {
    const who: Who = r.who === "member" || r.who === "team" ? r.who : "test";
    let failed = true;
    if (r.kind === "cut") {
      if (r.line === "redrafted") out.redrafted[who] += 1;
      else if (r.line !== "covered") out.cuts[who] += 1;
      failed = r.line !== "redrafted" && r.line !== "covered";
    } else {
      const bucket = r.kind === "fallback" ? out.fallbacks : out.noHelp;
      bucket[who] += 1;
      const line = (r.line ?? "").replace(/^Co replied: /, "");
      bucket.byLine[who][line] = (bucket.byLine[who][line] ?? 0) + 1;
    }
    if (failed && who === "member" && r.user_id) hit.add(r.user_id);
  }
  out.membersHit = hit.size;
  return out;
}

// Failures for members and the team (never test members). Redrafted-fine cuts are never failures.
export const realFailures = (d: FailureDay) => (["member", "team"] as const).reduce((n, w) => n + d.fallbacks[w] + d.cuts[w] + d.noHelp[w], 0);
export const memberFacing = (d: FailureDay) => d.memberTexts > 0;
// Pure: whether the day calls for the alert: a member hit a failure, on a day a member wrote to Cue. The team's and test members'
// counts are on the dashboard, never in the text (Royce, 2026-10-17: "Keep team and test counts off the text and on the dashboard").
export const failureAlertDue = (d: FailureDay) => memberFacing(d) && d.membersHit > 0;

// Pure: the alert text, in Royce's words (2026-10-17): "Cue alert: 2 members hit a failure today. Fallback lines 1, no reply at all 1.
// Team and test counts on the dashboard." Members' numbers only; couldn't-help joins the line only when there was one.
export function alertText(d: FailureDay, today: boolean): string {
  const n = d.membersHit;
  return `Cue alert: ${n} ${n === 1 ? "member" : "members"} hit a failure ${today ? "today" : "yesterday"}. Fallback lines ${d.fallbacks.member}, no reply at all ${d.cuts.member}${d.noHelp.member ? `, couldn't help ${d.noHelp.member}` : ""}. Team and test counts on the dashboard.`;
}

// The dashboard's rows (co-test /sweeps, team only): each of the last days, every group, newest first.
export async function failureDays(days: number, now = new Date()): Promise<FailureDay[]> {
  const out: FailureDay[] = [];
  for (let i = 0; i < days; i++) out.push(await countFailures(DateTime.fromJSDate(now).setZone(FAILURE_ZONE).minus({ days: i }).toISODate()!));
  return out;
}

export async function countFailures(day: string): Promise<FailureDay> {
  const { start, end } = dayBounds(day);
  const [rows, texts] = await Promise.all([pool.query(FAILURES_SQL, [start, end, FALLBACK_LOGGED]), pool.query(MEMBER_TEXTS_SQL, [start, end])]);
  return tally(day, rows.rows as FailureRow[], Number(texts.rows[0]?.n ?? 0));
}

// Once per key, across instances and restarts (harness_alerts, the monitor's claim table). Claimed only after the count is in hand, and
// let go when nothing went (it threw), so a failure never loses the day's alert: the next run sends it (review of this change).
async function claimOnce(key: string): Promise<boolean> {
  const { rows } = await pool.query(`INSERT INTO harness_alerts (signal_key, sent_at) VALUES ($1, NOW()) ON CONFLICT (signal_key) DO NOTHING RETURNING signal_key`, [key]);
  return rows.length > 0;
}
async function release(key: string): Promise<void> {
  await pool.query(`DELETE FROM harness_alerts WHERE signal_key = $1`, [key]).catch((err: any) => console.error(`failure count: releasing ${key} failed (that day's alert may be lost):`, err?.message ?? err));
}
// Whether this process can text the alert at all: real sends on and the team number set. A process that can't never claims, so it
// can't make a server that can skip its run (review of this change: a local run with sends off held the claim long enough).
export const canAlert = () => ALLOW_REAL_SENDS && !!process.env.TEAM_ALERT_PHONE?.trim();
const claimed = async (key: string) => (await pool.query(`SELECT 1 FROM harness_alerts WHERE signal_key = $1`, [key])).rows.length > 0;
// Claim, send, keep the claim only if it went.
async function sendOnce(key: string, send: () => Promise<boolean>): Promise<boolean> {
  if (!(await claimOnce(key))) return false;
  const went = await send().catch((err: any) => {
    console.error(`failure count: ${key} failed to go (non-fatal, retried next run):`, err?.message ?? err);
    return false;
  });
  if (!went) await release(key);
  return went;
}

// The alert by text: to TEAM_ALERT_PHONE, the number Royce sets on the server, from Cue's number. Recorded as a team text
// (outbound_messages sender 'ops'), so Cue never reads it as a line of its own: an inline reply to it isn't quoted to Cue
// (inlineReply.ts), and it isn't one of Cue's sends to that member (followThrough.ts, callCommitments.ts read sender 'co').
export async function sendAlertText(text: string): Promise<boolean> {
  const to = process.env.TEAM_ALERT_PHONE?.trim();
  if (!to || !ALLOW_REAL_SENDS) {
    console.log(`[team alert text, not sent] ${text}`);
    return false;
  }
  const { default: sendblue } = await import("../services/sendblue.js");
  const res: any = await sendblue.messages.send({ number: to, content: text, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  // The wrapper records it as Cue's (sender 'co'), in the background: whichever lands first, the row ends as 'ops'.
  if (res?.message_handle)
    await pool
      .query(
        `INSERT INTO outbound_messages (message_handle, user_id, content, sender)
         SELECT $1, (SELECT id FROM users WHERE right(regexp_replace(phone_number, '\\D', '', 'g'), 10) = right(regexp_replace($2, '\\D', '', 'g'), 10) LIMIT 1), $3, 'ops'
         ON CONFLICT (message_handle) DO UPDATE SET sender = 'ops'`,
        [String(res.message_handle), to, text.slice(0, 2000)],
      )
      .catch((err: any) => console.error("failure count: marking the alert as a team text failed:", err?.message ?? err));
  return true;
}

// Each morning: yesterday's numbers logged, no message (the redrafted-fine number is tracked every day, not only when it alerts).
export async function recordDailyFailures(now = new Date()): Promise<void> {
  const day = DateTime.fromJSDate(now).setZone(FAILURE_ZONE).minus({ days: 1 }).toISODate()!;
  const [done] = (await pool.query(`SELECT 1 FROM harness_decisions WHERE decision = 'metrics.failures' AND action = 'daily' AND proposal->>'day' = $1 LIMIT 1`, [day])).rows;
  if (done) return;
  await recordDecision({ layer: 3, decision: "metrics.failures", userId: null, outcome: "act", action: "daily", proposal: await countFailures(day) });
}

// Through the day: the first time a member (never the team or a test member) hit a failure on a member-facing day, once, by text, inside 8am to 9pm
// Pacific. Yesterday too, until its alert went: a failure just before midnight is told at 8am.
export async function checkFailureAlert(now = new Date()): Promise<void> {
  if (!canAlert() || !alertHours(now)) return;
  const today = pacificDay(now);
  const yesterday = DateTime.fromJSDate(now).setZone(FAILURE_ZONE).minus({ days: 1 }).toISODate()!;
  for (const day of [yesterday, today]) {
    const key = `failures:alert:${day}`;
    if (await claimed(key)) continue;
    const d = await countFailures(day);
    if (!failureAlertDue(d)) continue;
    const went = await sendOnce(key, () => sendAlertText(alertText(d, day === today)));
    if (went) await recordDecision({ layer: 3, decision: "metrics.failures", userId: null, outcome: "act", action: "alert", proposal: d }).catch(() => {});
  }
}
