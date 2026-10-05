// No silent outcomes (Royce, 2026-09-29, from Instinct: "Hit a snag: the
// application site is rejecting uploads. Nothing's gone out half-finished.
// I'm working around it and will tell you when they're in"). When Mo can't do
// what the team approved, they hear it once, in plain words, grouped by cause,
// with what state things are in and what happens next, and again when it
// clears. Before this, each failure was texted as its own raw-error line on
// every hourly run, and a failing reply-reader said nothing at all.
//
// Pure logic here; mo/outreach.ts reads and writes the state.
import pool from "../db/db.js";

export type Cause = "auth" | "rate_limit" | "network" | "other";

export function causeOf(err: string): Cause {
  const e = err.toLowerCase();
  if (/\b(401|403)\b|unauthor|forbidden|invalid (token|credentials?|key)|not authenticated|permission/.test(e)) return "auth";
  if (/\b429\b|rate.?limit|too many requests|quota/.test(e)) return "rate_limit";
  if (/timeout|timed out|etimedout|econn|enotfound|fetch failed|network|socket|\b5\d\d\b|bad gateway|unavailable/.test(e)) return "network";
  return "other";
}

export function causeWords(cause: Cause, service = "X"): string {
  switch (cause) {
    case "auth":
      return `${service} isn't accepting Co's login right now`;
    case "rate_limit":
      return `${service} is limiting how much Co can send`;
    case "network":
      return `${service} isn't responding`;
    default:
      return `${service} is returning errors`;
  }
}

export type Health = { cause: Cause | null; runs: number; since: string | null; notifiedAt: string | null; backoffUntil: string | null };
export const EMPTY_HEALTH: Health = { cause: null, runs: 0, since: null, notifiedAt: null, backoffUntil: null };

export type RunResult = { ok: number; failed: { cause: Cause; who: string }[] };
export type HealthOpts = {
  kind: "sending" | "replies";
  // Failing runs in a row before anyone is told (a blip isn't news).
  notifyAfterRuns?: number;
  // Failing runs in a row before retries pause for a while.
  backoffRuns?: number;
  backoffMs?: number;
  // A still-stuck reminder, at most this often.
  remindMs?: number;
};

const HOUR = 3_600_000;

export function nextHealth(prev: Health, run: RunResult, now: Date, opts: HealthOpts): { health: Health; message: string | null } {
  const notifyAfter = opts.notifyAfterRuns ?? 1;
  const backoffRuns = opts.backoffRuns ?? 3;
  const backoffMs = opts.backoffMs ?? 3 * HOUR;
  const remindMs = opts.remindMs ?? 24 * HOUR;

  if (!run.failed.length) {
    // Something worked after it had been failing: say so, once.
    if (prev.cause && run.ok > 0) {
      const done = opts.kind === "sending" ? "Sending is working again" : "I can read replies again";
      return { health: { ...EMPTY_HEALTH }, message: `Back on: ${done}${prev.notifiedAt ? "" : ", after a short blip"}.` };
    }
    // Nothing was tried, so nothing is known: keep the state as it was.
    return { health: prev.cause ? prev : { ...EMPTY_HEALTH }, message: null };
  }

  const counts = new Map<Cause, number>();
  for (const f of run.failed) counts.set(f.cause, (counts.get(f.cause) ?? 0) + 1);
  const cause = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const same = prev.cause === cause;
  const runs = same ? prev.runs + 1 : 1;
  const since = same && prev.since ? prev.since : now.toISOString();
  const backoffUntil = runs >= backoffRuns ? new Date(now.getTime() + backoffMs).toISOString() : null;

  const told = same ? prev.notifiedAt : null;
  const shouldTell = told === null ? runs >= notifyAfter : now.getTime() - new Date(told).getTime() >= remindMs;
  let message: string | null = null;
  if (shouldTell) {
    const names = [...new Set(run.failed.map((f) => f.who))];
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
    const next = backoffUntil ? `I'll hold off retrying for a few hours` : `I'll try again on the next run`;
    if (told === null) {
      message =
        opts.kind === "sending"
          ? `Mo hit a snag sending: ${causeWords(cause)}. That affects ${names.length === 1 ? shown : `${names.length} people (${shown})`}. Nothing went out half-done. ${next} and tell you when it clears.`
          : `Mo can't read replies right now: ${causeWords(cause)}. Anyone who writes back will be picked up as soon as it clears. ${next} and tell you when it does.`;
    } else {
      const hours = Math.max(1, Math.round((now.getTime() - new Date(since).getTime()) / HOUR));
      message = `Still stuck: ${causeWords(cause)}, for about ${hours} hours now. Nothing has gone out half-done, and I'll tell you the moment it clears.`;
    }
  }
  return { health: { cause, runs, since, notifiedAt: shouldTell ? now.toISOString() : told, backoffUntil }, message };
}

export function inBackoff(h: Health, now: Date): boolean {
  return Boolean(h.backoffUntil) && new Date(h.backoffUntil!).getTime() > now.getTime();
}

export async function getHealth(key: string): Promise<Health> {
  const { rows } = await pool.query(`SELECT value FROM mo_settings WHERE key = $1`, [key]).catch(() => ({ rows: [] as any[] }));
  const v = rows[0]?.value;
  return v && typeof v === "object" ? { ...EMPTY_HEALTH, ...v } : { ...EMPTY_HEALTH };
}

export async function setHealth(key: string, h: Health): Promise<void> {
  await pool
    .query(
      `INSERT INTO mo_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(h)],
    )
    .catch(() => {});
}
