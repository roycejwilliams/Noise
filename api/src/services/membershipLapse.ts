// Members Co knows nothing about (Royce, 2026-09-22: "if a user is missing a
// profile we should tell them. Once a week and to give them a time limit then
// kick them off"). A member who joined and then went quiet before telling Co
// anything about themselves can't be helped, and a referral-only club
// shouldn't carry them forever.
//
// The clock, once they qualify:
//   weeks 1, 2, 3: a short text saying Co doesn't know them yet, and the date
//                  their membership closes if nothing changes;
//   week 4:        one last notice, a week out;
//   a week later:  the account is archived (services/accountArchive.ts:
//                  nothing deleted, phone opted out).
// Each step goes out through the proactive harness (hours and caps apply),
// and the next step waits until the previous one was actually sent, so no one
// is closed without having been told. Any real reply stops the clock.
// Team accounts (users.lapse_exempt) never start it.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { enqueueCandidate } from "../harness/proactive.js";
import { recordDecision } from "../harness/core.js";
import { archiveAccount } from "./accountArchive.js";

export const LAPSE = {
  // Joined at least this long ago, and quiet at least this long.
  minAccountDays: 7,
  quietDays: 7,
  nudges: 3,
  stepGapDays: 7,
  // Close date = start + this; the final notice always gives at least a week.
  closeAfterDays: 28,
};

export type LapseStep = { step: number; final: boolean };

// Pure: what the next step is, given which steps went out and when.
// sentAt[i] = when step i+1 was sent (null = not yet). Returns null when
// nothing is due now.
export function nextLapseStep(sentAt: (Date | null)[], now: Date, closeAt: Date): { enqueue: LapseStep } | { archive: true } | null {
  const total = LAPSE.nudges + 1;
  const sentCount = sentAt.findIndex((d) => d == null);
  const done = sentCount === -1 ? Math.min(sentAt.length, total) : sentCount;
  if (done >= total) {
    const finalAt = sentAt[total - 1]!;
    const weekAfterFinal = finalAt.getTime() + LAPSE.stepGapDays * 86400_000;
    return now.getTime() >= Math.max(weekAfterFinal, closeAt.getTime()) ? { archive: true } : null;
  }
  if (done === 0) return { enqueue: { step: 1, final: false } };
  const last = sentAt[done - 1]!;
  if (now.getTime() - last.getTime() < LAPSE.stepGapDays * 86400_000) return null;
  const step = done + 1;
  return { enqueue: { step, final: step === total } };
}

// Private-club voice (Royce, 2026-09-22: "private luxury... grown, sexy,
// professional"): assured, never apologetic.
export function lapseText(firstName: string, closeDate: string, final: boolean): string {
  const name = firstName?.trim() || "Hi";
  return final
    ? `${name}, a quick note: your membership closes ${closeDate} unless we pick things up. Tell me what you're working toward and it stays open.`
    : `${name}, I'd like to know you properly before I start bringing people and rooms your way. Tell me what you're building and what you're looking for. Your membership stays open until ${closeDate}.`;
}

// "Missing a profile": nothing beyond intake. No call, no open ask, no open
// thread, and a person snapshot with nothing about their work or wants.
const BARELY_KNOWN = `
  NOT EXISTS (SELECT 1 FROM co_memories m WHERE m.user_id = u.id AND m.memory_type = 'call_transcript' AND m.content NOT LIKE 'Co initiated call%')
  AND NOT EXISTS (SELECT 1 FROM ask_checkins a WHERE a.user_id = u.id AND a.resolved_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM member_threads t WHERE t.user_id = u.id AND t.status IN ('open', 'waiting'))
  AND NOT EXISTS (SELECT 1 FROM person_snapshots s WHERE s.user_id = u.id
                  AND (COALESCE(s.snapshot->>'work', '') <> '' OR jsonb_array_length(COALESCE(s.snapshot->'wantsNow', '[]'::jsonb)) > 0))`;

function lastSaidSql(alias = "u"): string {
  return `(SELECT MAX(m.created_at) FROM co_memories m WHERE m.user_id = ${alias}.id AND m.memory_type = 'text_exchange' AND m.content LIKE 'User said:%')`;
}

export async function runMembershipLapse(now = new Date()): Promise<void> {
  // 1. A reply (or Co learning something) stops the clock.
  const stopped = await pool.query(
    `UPDATE users u SET lapse_started_at = NULL, lapse_close_at = NULL
     WHERE u.lapse_started_at IS NOT NULL AND u.archived_at IS NULL
       AND (COALESCE(${lastSaidSql()} > u.lapse_started_at, false) OR NOT (${BARELY_KNOWN}) OR u.lapse_exempt OR u.sms_opted_out)
     RETURNING u.id, u.lapse_started_at`,
  );
  for (const r of stopped.rows) {
    await pool.query(
      `UPDATE proactive_candidates SET status = 'skipped', updated_at = NOW() WHERE user_id = $1 AND type = 'membership_lapse' AND status = 'pending'`,
      [r.id],
    );
    await recordDecision({ layer: 7, decision: "membership.lapse", userId: r.id, outcome: "skip", action: "clock_stopped", reason: "they replied or Co knows them now" });
  }

  // 2. Start the clock for anyone who newly qualifies.
  const started = await pool.query(
    `UPDATE users u SET lapse_started_at = $1, lapse_close_at = $1::timestamptz + make_interval(days => $2)
     WHERE u.lapse_started_at IS NULL AND u.archived_at IS NULL AND u.lapse_exempt = false AND u.sms_opted_out = false
       AND u.identity_captured = true
       AND u.created_at < $1::timestamptz - make_interval(days => $3)
       AND COALESCE(${lastSaidSql()}, '-infinity') < $1::timestamptz - make_interval(days => $4)
       AND ${BARELY_KNOWN}
     RETURNING u.id`,
    [now, LAPSE.closeAfterDays, LAPSE.minAccountDays, LAPSE.quietDays],
  );
  for (const r of started.rows) {
    await recordDecision({ layer: 7, decision: "membership.lapse", userId: r.id, outcome: "act", action: "clock_started" });
  }

  // 3. Advance everyone on the clock.
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, u.lapse_started_at, u.lapse_close_at, cp.city FROM users u
     LEFT JOIN co_profiles cp ON cp.user_id = u.id
     WHERE u.lapse_started_at IS NOT NULL AND u.archived_at IS NULL`,
  );
  for (const u of rows) {
    const key = `lapse:${new Date(u.lapse_started_at).toISOString().slice(0, 10)}`;
    const sends = await pool.query(`SELECT target_key, sent_at FROM proactive_sends WHERE user_id = $1 AND target_key LIKE $2`, [u.id, `${key}:%`]);
    const sentAt: (Date | null)[] = Array.from({ length: LAPSE.nudges + 1 }, (_, i) => {
      const hit = sends.rows.find((s: any) => s.target_key === `${key}:${i + 1}`);
      return hit ? new Date(hit.sent_at) : null;
    });
    const next = nextLapseStep(sentAt, now, new Date(u.lapse_close_at));
    if (!next) continue;
    if ("archive" in next) {
      const r = await archiveAccount(u.id);
      await recordDecision({ layer: 7, decision: "membership.lapse", userId: u.id, outcome: r.archived ? "act" : "skip", action: r.archived ? "archived" : "archive_failed", proposal: { key, sentAt } });
      continue;
    }
    await enqueueCandidate({
      userId: u.id,
      type: "membership_lapse",
      targetKey: `${key}:${next.enqueue.step}`,
      topicKey: key,
      summary: next.enqueue.final ? "Last notice: membership closes in a week unless they reply" : `Co doesn't know them yet; membership closes on the close date unless they reply (${next.enqueue.step} of ${LAPSE.nudges})`,
      payload: { step: next.enqueue.step, final: next.enqueue.final },
      expiresAt: new Date(now.getTime() + 6 * 86400_000),
    });
  }
}

// The close date the text names: the stored one, or a week from now for the
// final notice if sends were delayed (a final notice always gives a week).
export async function lapseCloseDate(userId: string, final: boolean, zone: string | null): Promise<{ date: Date; label: string } | null> {
  const { rows } = await pool.query(`SELECT lapse_close_at FROM users WHERE id = $1 AND lapse_started_at IS NOT NULL`, [userId]);
  if (!rows[0]?.lapse_close_at) return null;
  let date = new Date(rows[0].lapse_close_at);
  const weekOut = new Date(Date.now() + LAPSE.stepGapDays * 86400_000);
  if (final && date < weekOut) date = weekOut;
  return { date, label: DateTime.fromJSDate(date).setZone(zone ?? "America/Los_Angeles").toFormat("cccc, LLLL d") };
}
