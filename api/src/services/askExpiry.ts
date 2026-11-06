// Asks close on evidence, not a clock (Royce, 2026-11-04/05: silence is not rejection). Royce, 2026-09-18 gave asks a time limit
// ("AI engineer meetups Thursday night" kept being searched after Thursday); that stays for an ask that NAMED its time: when the
// time it was for has passed, that is evidence. An ask with no time frame has no clock: it stays open until they say it's done, a
// find came true, or the one light check the goal recheck already runs (askRetire.ts, an existing message) closes it on their word.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { resolveAskWindow } from "./askWindow.js";
import { memberZoneOrFallback } from "./memberTime.js";

// The end of the time frame they named (plus a day's grace, so an ask for "tonight" isn't closed before tonight's follow-up), else
// null: no clock.
export function askExpiresAt(askText: string, saidAt: DateTime): Date | null {
  const { window } = resolveAskWindow(askText, saidAt);
  if (window) return window.end.plus({ days: 1 }).toJSDate();
  return null;
}

export async function askExpiresAtForUser(userId: string, askText: string, saidAt: Date = new Date()): Promise<Date | null> {
  // Their zone, or the fallback (services/memberTime.ts).
  const zone = await memberZoneOrFallback(userId);
  return askExpiresAt(askText, DateTime.fromJSDate(saidAt).setZone(zone));
}

// Fills in the named time limit for open asks that predate this, then closes the ones whose named time passed. Run before each sweep
// so an ask for a day that is over is never searched. An ask with no named time is never closed here, and an old 30-day clock on one
// is taken off (the clock was never evidence).
export async function expireStaleAsks(): Promise<{ backfilled: number; expired: number }> {
  // Once per ask: each row read here is marked (expiry_checked_at), whether or not it names a time, so a row with no named time (it
  // stays null) is never read again.
  let backfilled = 0;
  for (;;) {
    const { rows: missing } = await pool.query(
      `SELECT id, user_id, ask_text, created_at FROM ask_checkins WHERE resolved_at IS NULL AND expires_at IS NULL AND expiry_checked_at IS NULL LIMIT 500`,
    );
    for (const row of missing) {
      const expiresAt = await askExpiresAtForUser(row.user_id, row.ask_text, new Date(row.created_at));
      await pool.query(`UPDATE ask_checkins SET expires_at = $2, expiry_checked_at = NOW() WHERE id = $1`, [row.id, expiresAt]);
      if (expiresAt) backfilled++;
    }
    if (missing.length < 500) break;
  }
  // Each one leaves the working set with its fact in their record first (services/workingSet.ts): the date it was tied to passed.
  const { rows: due } = await pool.query(
    `SELECT id, user_id, ask_text, expires_at, created_at FROM ask_checkins WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW() LIMIT 500`,
  );
  const { writeExitFact } = await import("./workingSet.js");
  let expired = 0;
  for (const r of due) {
    // No named time of its own (an old 30-day clock): not evidence of anything. The clock comes off; the ask stays open.
    const named = !!resolveAskWindow(String(r.ask_text ?? ""), DateTime.fromJSDate(new Date(r.created_at ?? r.expires_at))).window;
    if (!named) {
      await pool.query(`UPDATE ask_checkins SET expires_at = NULL WHERE id = $1 AND resolved_at IS NULL`, [r.id]);
      const { recordDecision } = await import("../harness/core.js");
      await recordDecision({ layer: 5, decision: "ask.expiry_held", userId: r.user_id, outcome: "skip", action: "no_clock", reason: "this ask names no time frame: it doesn't close on a clock, only on their word or evidence", proposal: { askId: r.id } }).catch(() => {});
      continue;
    }
    const ok = await writeExitFact({ userId: r.user_id, kind: "ask", itemKey: `ask:${r.id}`, label: String(r.ask_text ?? ""), state: "expired", reason: `the time it was for passed (${new Date(r.expires_at).toISOString().slice(0, 10)})`, scope: "this ask only; saying it again opens a new one" });
    if (!ok) continue;
    const { rowCount } = await pool.query(
      `UPDATE ask_checkins SET resolved_at = NOW(), expired_at = NOW(), closed_reason = COALESCE(closed_reason, 'expired') WHERE id = $1 AND resolved_at IS NULL`,
      [r.id],
    );
    expired += rowCount ?? 0;
  }
  // Conditions said with a time limit ("not investors right now") run out 60 days after they were last said (services/wantCriteria.ts).
  await expireTimeBoundCriteria().catch((err: any) => console.error("expireTimeBoundCriteria failed (non-fatal):", err?.message ?? err));
  return { backfilled, expired };
}

// Takes expired time-worded conditions off each want they were on (they already stopped applying: wantCriteria.ts criteriaOf), and logs
// each member's expiry with want ids and counts only, never their words. Only that want's conditions change.
export async function expireTimeBoundCriteria(now: Date = new Date()): Promise<number> {
  const { pruneExpiredCriteria } = await import("./wantCriteria.js");
  const { recordDecision } = await import("../harness/core.js");
  // Every profile with conditions, a page at a time in user_id order (a cursor), so each row is read once per pass, never the same
  // first page again (review of bb6c5372).
  const PAGE = 500;
  let n = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await pool.query(
      `SELECT user_id, intent FROM co_profiles WHERE intent::text LIKE '%"criteria"%' AND user_id > $1::uuid ORDER BY user_id LIMIT ${PAGE}`,
      [after],
    );
    for (const r of rows) {
      const { intent, expired } = pruneExpiredCriteria(r.intent, now);
      if (!expired.length) continue;
      // Only if the intent is still the one read (a turn may have written since): the next day's pass takes whatever is left.
      const { rowCount } = await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1 AND intent = $3::jsonb`, [r.user_id, JSON.stringify(intent), JSON.stringify(r.intent)]);
      if (!rowCount) continue;
      n += expired.reduce((a, x) => a + x.n, 0);
      await recordDecision({ layer: 5, decision: "want_criteria.expired", userId: r.user_id, outcome: "act", action: "expired", reason: "conditions said with a time limit ran past 60 days since last said", proposal: { wants: expired } }).catch(() => {});
    }
    if (rows.length < PAGE) break;
    after = String(rows[rows.length - 1].user_id);
  }
  return n;
}
