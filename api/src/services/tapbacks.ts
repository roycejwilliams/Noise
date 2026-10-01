// How often Co reacts to a text, and with what (Royce, 2026-10-01: "The
// tapbacks are too frequent and there's not a variety of them being used. It's
// almost being used for every single reply."). In the 7 days before: 44
// reactions on 244 texts, 27 of them 👀, plus a 👀 on every search, five texts
// in a row one night.
//
// Co decides whether and which, seeing its own recent reactions (services/
// readTurn.ts "ack"; Royce, same day: "we want Co to decide when to use
// things"). Code keeps only a backstop on the facts: never two of their texts
// in a row, and not a pile of them in a couple of hours.
import pool from "../db/db.js";

export const TAPBACK_LIMITS = {
  // At least this many of their texts between two reactions.
  textsBetween: 1,
  // No more than this many in a couple of hours.
  maxInWindow: 3,
  windowHours: 2,
};

export type RecentTapback = { emoji: string; at: Date };
export type TapbackHistory = { recent: RecentTapback[]; textsSinceLast: number | null };

const bare = (s: string) => s.replace(/️/g, "").trim();

export function ackAllowed(emoji: string, h: TapbackHistory, now: Date = new Date()): { ok: boolean; why: string | null } {
  const hours = (d: Date) => (now.getTime() - d.getTime()) / 3_600_000;
  // Never the same one twice in a row (Royce, 2026-10-01 decisions).
  if (h.recent.length && sameReaction(h.recent[0].emoji, emoji)) return { ok: false, why: `same as the last reaction (${h.recent[0].emoji})` };
  if (h.recent.length && h.textsSinceLast !== null && h.textsSinceLast < TAPBACK_LIMITS.textsBetween) return { ok: false, why: "reacted to their last text" };
  const inWindow = h.recent.filter((t) => hours(t.at) < TAPBACK_LIMITS.windowHours).length;
  if (inWindow >= TAPBACK_LIMITS.maxInWindow) return { ok: false, why: `${inWindow} reactions in the last ${TAPBACK_LIMITS.windowHours} hours` };
  return { ok: true, why: null };
}

// What Co sees before it decides: its own recent reactions, newest first.
export function describeTapbacks(h: TapbackHistory, now: Date = new Date()): string | null {
  if (!h.recent.length) return null;
  const ago = (d: Date) => {
    const m = Math.round((now.getTime() - d.getTime()) / 60_000);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)}h ago`;
  };
  const lines = h.recent.map((t, i) => `${t.emoji} ${ago(t.at)}${i === 0 && h.textsSinceLast !== null ? ` (${h.textsSinceLast === 0 ? "on their last text" : `${h.textsSinceLast} of their texts since`})` : ""}`);
  return lines.join(", ");
}

export function sameReaction(a: string, b: string): boolean {
  return bare(a) === bare(b);
}

// The standard iMessage tapbacks go by name so they look native; the rest as emoji.
export function reactionFor(emoji: string): string {
  const e = bare(emoji);
  return e === bare("❤️") ? "love" : e === "😂" ? "laugh" : e === "👍" ? "like" : emoji;
}

// Closing tapbacks were logged by name before they could be any emoji.
const LEGACY_TAPBACK: Record<string, string> = { like: "👍", love: "❤️", laugh: "😂" };

// Every reaction Co gave them recently (the "on it" read and the closing
// tapback alike: to them it's the same thing), newest first, and how many of
// their texts came after the latest. Texts from the last 20 seconds don't
// count: that's this turn and anything sent in the same burst.
export async function tapbackHistory(userId: string): Promise<TapbackHistory> {
  const { rows } = await pool.query(
    `SELECT action, created_at FROM harness_decisions
     WHERE user_id = $1 AND outcome = 'act' AND created_at > NOW() - interval '24 hours'
       AND (decision = 'turn.ack' OR (decision = 'turn.closing' AND action LIKE 'tapback:%'))
     ORDER BY created_at DESC LIMIT 6`,
    [userId],
  );
  const recent: RecentTapback[] = rows.map((r: any) => {
    const emoji = String(r.action).replace(/^tapback:/, "");
    return { emoji: LEGACY_TAPBACK[emoji] ?? emoji, at: new Date(r.created_at) };
  });
  if (!recent.length) return { recent, textsSinceLast: null };
  const { rows: c } = await pool.query(
    `SELECT count(*)::int AS n FROM co_memories
     WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User %'
       AND created_at > $2 AND created_at < NOW() - interval '20 seconds'`,
    [userId, recent[0].at],
  );
  return { recent, textsSinceLast: c[0]?.n ?? 0 };
}
