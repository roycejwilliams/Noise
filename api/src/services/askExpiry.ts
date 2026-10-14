// Asks have a time limit (Royce, 2026-09-18: "Do we need to think about
// reformatting the asks to have a time limit?"). Without one, every ask ever
// said stayed open: "AI engineer meetups Thursday night" kept being searched
// after Thursday, and one tester had ten open asks competing for one daily
// text.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { resolveAskWindow } from "./askWindow.js";
import { memberZoneOrFallback } from "./memberTime.js";

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
  // Their zone, or the fallback (services/memberTime.ts).
  const zone = await memberZoneOrFallback(userId);
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
  // Each one leaves the working set with its fact in their record first (services/workingSet.ts): the date it was tied to passed.
  const { rows: due } = await pool.query(
    `SELECT id, user_id, ask_text, expires_at, created_at FROM ask_checkins WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW() LIMIT 500`,
  );
  const { writeExitFact } = await import("./workingSet.js");
  let expired = 0;
  const { memberSilence } = await import("./dailySweep.js");
  for (const r of due) {
    // A tapered member (their own silence past a week): an ask with no time frame of its own doesn't run out on its 30 days while
    // they're quiet; it's pushed a day and said, once a day (Royce, 2026-10-14: the taper "never deletes goals, plans, or finds"). One
    // whose named time passed does expire, said as "passed while quiet".
    const silence = await memberSilence(r.user_id).catch(() => "unknown" as const);
    const quiet = silence !== "engaged";
    const named = !!resolveAskWindow(String(r.ask_text ?? ""), DateTime.fromJSDate(new Date(r.created_at ?? r.expires_at))).window;
    if (quiet && !named) {
      await pool.query(`UPDATE ask_checkins SET expires_at = NOW() + INTERVAL '1 day' WHERE id = $1 AND resolved_at IS NULL`, [r.id]);
      const { recordDecision } = await import("../harness/core.js");
      await recordDecision({ layer: 5, decision: "ask.expiry_held", userId: r.user_id, outcome: "skip", action: silence === "quiet" ? "tapered" : "silence_unread", reason: silence === "quiet" ? "they've been quiet over a week: this ask with no time frame of its own is held, not expired, until they write" : "their last message couldn't be read: this ask is held, not expired, on a failed read", proposal: { askId: r.id } }).catch(() => {});
      continue;
    }
    const ok = await writeExitFact({ userId: r.user_id, kind: "ask", itemKey: `ask:${r.id}`, label: String(r.ask_text ?? ""), state: "expired", reason: `the time it was for passed (${new Date(r.expires_at).toISOString().slice(0, 10)})${silence === "quiet" ? " while quiet" : ""}`, scope: "this ask only; saying it again opens a new one" });
    if (!ok) continue;
    const { rowCount } = await pool.query(
      `UPDATE ask_checkins SET resolved_at = NOW(), expired_at = NOW(), closed_reason = COALESCE(closed_reason, 'expired') WHERE id = $1 AND resolved_at IS NULL`,
      [r.id],
    );
    expired += rowCount ?? 0;
  }
  return { backfilled: missing.length, expired };
}
