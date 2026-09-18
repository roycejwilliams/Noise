// Asks have a time limit (Royce, 2026-09-18: "Do we need to think about
// reformatting the asks to have a time limit?"). Without one, every ask ever
// said stayed open: "AI engineer meetups Thursday night" kept being searched
// after Thursday, and one tester had ten open asks competing for one daily
// text.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { resolveAskWindow } from "./askWindow.js";
import { CO_DEFAULT_TIMEZONE } from "./eventOrder.js";
import { getTimezoneForCity } from "./geocoding.js";

// An ask with no time frame stays open this long, renewed each time they
// restate it.
export const ASK_LIFESPAN_DAYS = 30;

// The end of the time frame they named (plus a day's grace, so an ask for
// "tonight" isn't closed before tonight's follow-up), else the default
// lifespan from when they said it.
export function askExpiresAt(askText: string, saidAt: DateTime): Date {
  const { window } = resolveAskWindow(askText, saidAt);
  if (window) return window.end.plus({ days: 1 }).toJSDate();
  return saidAt.plus({ days: ASK_LIFESPAN_DAYS }).toJSDate();
}

export async function askExpiresAtForUser(userId: string, askText: string, saidAt: Date = new Date()): Promise<Date> {
  const { rows } = await pool
    .query(`SELECT city FROM co_profiles WHERE user_id = $1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const zone = rows[0]?.city ? ((await getTimezoneForCity(rows[0].city).catch(() => null)) ?? CO_DEFAULT_TIMEZONE) : CO_DEFAULT_TIMEZONE;
  return askExpiresAt(askText, DateTime.fromJSDate(saidAt).setZone(zone));
}

// Fills in a time limit for open asks that predate this, then closes the
// ones past it. Run before each sweep so expired asks are never searched.
export async function expireStaleAsks(): Promise<{ backfilled: number; expired: number }> {
  const { rows: missing } = await pool.query(
    `SELECT id, user_id, ask_text, created_at FROM ask_checkins WHERE resolved_at IS NULL AND expires_at IS NULL LIMIT 500`,
  );
  for (const row of missing) {
    const expiresAt = await askExpiresAtForUser(row.user_id, row.ask_text, new Date(row.created_at));
    await pool.query(`UPDATE ask_checkins SET expires_at = $2 WHERE id = $1`, [row.id, expiresAt]);
  }
  const { rowCount } = await pool.query(
    `UPDATE ask_checkins SET resolved_at = NOW(), expired_at = NOW()
     WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW()`,
  );
  return { backfilled: missing.length, expired: rowCount ?? 0 };
}
