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

// The six standard iMessage tapbacks go by name so they look native (the names Sendblue's send-reaction takes); any other single
// emoji goes as the emoji itself. See sendableReaction for what is allowed out.
export const SENDBLUE_REACTIONS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
const NAMED: Record<string, (typeof SENDBLUE_REACTIONS)[number]> = { "❤": "love", "👍": "like", "👎": "dislike", "😂": "laugh", "‼": "emphasize", "❗": "emphasize", "❓": "question", "❔": "question" };
export function reactionFor(emoji: string): string {
  return NAMED[bare(emoji)] ?? emoji;
}

// Whether a reaction may go to Sendblue: one of its six names, or exactly one emoji. Anything else (words, several emoji, an empty
// string) is not sent as a reaction at all, so the caller falls back to the plain text it already has.
export function sendableReaction(reaction: string): boolean {
  const r = bare(String(reaction ?? ""));
  if ((SENDBLUE_REACTIONS as readonly string[]).includes(r)) return true;
  return /^\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?(\u200D\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?)*$/u.test(r);
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

// One reaction per message (Royce, 2026-10-03: a duplicate tapback landed on
// one of his messages). Three paths can react to the same incoming text: the
// early "on it" read, the closing tapback tool, and a teammate's acknowledgement.
// Each could pass its own checks, and the closing tool only had to differ from
// the last emoji, so ack-then-closing put two on one message. Every send goes
// through this ledger, keyed by the message's handle.
//
// A reaction is claimed (pending) when it starts and confirmed when Sendblue
// accepts it. Only a confirmed one counts as "already reacted", and the closing
// tool waits for a pending one to settle: if the early reaction fails, the
// closing tool still reacts or replies instead of assuming it went (review of #59).
type Entry = { at: number; state: "pending" | "sent"; settled: Promise<boolean>; settle: (ok: boolean) => void };
const reacted = new Map<string, Entry>();
export const REACTION_LEDGER_MS = 24 * 3_600_000;
export const REACTION_LEDGER_MAX = 500;
export const REACTION_WAIT_MS = 4000;

// True the first time a message is claimed; false if Co has reacted, or is reacting, to it.
export function claimReaction(handle: string, now: number = Date.now()): boolean {
  for (const [h, e] of reacted) if (now - e.at > REACTION_LEDGER_MS) reacted.delete(h);
  if (reacted.has(handle)) return false;
  if (reacted.size >= REACTION_LEDGER_MAX) reacted.delete(reacted.keys().next().value as string);
  let settle: (ok: boolean) => void = () => {};
  const settled = new Promise<boolean>((resolve) => (settle = resolve));
  reacted.set(handle, { at: now, state: "pending", settled, settle });
  return true;
}
// Sendblue accepted it: the message now has Co's reaction.
export function confirmReaction(handle: string): void {
  const e = reacted.get(handle);
  if (!e) return;
  e.state = "sent";
  e.settle(true);
}
// A send that didn't go through frees the message for another try.
export function releaseReaction(handle: string): void {
  const e = reacted.get(handle);
  reacted.delete(handle);
  e?.settle(false);
}
// Whether the message has a reaction from Co. A pending one is waited for (up
// to ms) and counts only if it lands.
export async function reactedTo(handle: string | null | undefined, now: number = Date.now(), ms: number = REACTION_WAIT_MS): Promise<boolean> {
  const e = handle ? reacted.get(handle) : undefined;
  if (!e || now - e.at > REACTION_LEDGER_MS) return false;
  if (e.state === "sent") return true;
  return Promise.race([e.settled, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}
export function resetReactionLedger(): void {
  for (const e of reacted.values()) e.settle(false);
  reacted.clear();
}
