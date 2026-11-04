// The nightly whole-exchange count (Royce, 2026-11-03: "a free nightly count of repeats, re-asks and reopenings in what Cue actually
// sent"). No model: what Cue sent in the window, read against the record. Logged with counts and ids, and flagged on the morning review
// (harness/devReview.ts reviewWindow) beside the rule check. Never anyone's words in the log.
//   repeat        a link Cue sent again within 7 days with no text of theirs between (so nothing asked for it), or the contact card twice
//   double_ask    a second "interested?" / "want me to ...?" while Cue's last one still had no answer
//   reask         a question of Cue's they had already answered (harness/repeatAsk.ts repeatedQuestion over the thread)
//   reopen        a link, offer or question about something they had closed (done or dropped at their word) before it went
//   after_close   a question in the reply to a turn whose read chose "close" (services/exchangeRecord.ts, logged as turn.move_read)
import { isReaction, LIGHT_CHECK } from "../services/reactionsIn.js";
import pool from "../db/db.js";
import { questionsIn, repeatedQuestion, type Turn } from "./repeatAsk.js";
import { about } from "./moveCheck.js";
import { INTEREST_Q, normUrl, OFFER_Q } from "../services/exchangeRecord.js";
import type { ReviewFlag } from "./devReview.js";

export type CountKind = "repeat" | "double_ask" | "reask" | "reopen" | "after_close";
export type Row = { from: "co" | "them"; text: string; at: Date };
export type Closed = { label: string; at: Date };
export type Hit = { kind: CountKind; at: Date };
const URL = /https?:\/\/[^\s)>\]"']+/g;
const WEEK = 7 * 86_400_000;
// Bubbles of one reply land within this of each other: one send, not a repeat.
const SAME_SEND_MS = 2 * 60_000;

// Pure: one member's hits among Cue's rows inside [since, until). rows: their thread, oldest first, from a week before since;
// closes: what they closed and when; closeTurns: when a turn read chose "close".
export function countMember(o: { rows: Row[]; closed: Closed[]; closeTurns: Date[]; since: Date; until: Date }): Hit[] {
  const hits: Hit[] = [];
  const inWin = (d: Date) => d >= o.since && d < o.until;
  const lastUrl = new Map<string, number>();
  let lastCard = -1;
  let openInterest: number | null = null;
  for (let i = 0; i < o.rows.length; i++) {
    const r = o.rows[i];
    if (r.from === "them") {
      // A tapback leaves a question as open as it was (services/reactionsIn.ts).
      if (!isReaction(r.text)) openInterest = null;
      continue;
    }
    const theirsSince = (j: number) => o.rows.slice(j + 1, i).some((x) => x.from === "them" && x.text.trim() && !isReaction(x.text));
    for (const u of (r.text.match(URL) ?? []).map(normUrl)) {
      const j = lastUrl.get(u);
      if (j != null && !theirsSince(j) && r.at.getTime() - o.rows[j].at.getTime() > SAME_SEND_MS && r.at.getTime() - o.rows[j].at.getTime() < WEEK && inWin(r.at)) hits.push({ kind: "repeat", at: r.at });
      lastUrl.set(u, i);
    }
    if (/\[sent (?:Cue|Co)'s contact card\]/i.test(r.text)) {
      if (lastCard >= 0 && !theirsSince(lastCard) && inWin(r.at)) hits.push({ kind: "repeat", at: r.at });
      lastCard = i;
    }
    const qs = questionsIn(r.text.replace(URL, ""));
    if (qs.some((q) => !LIGHT_CHECK.test(q) && (INTEREST_Q.test(q) || OFFER_Q.test(q)))) {
      if (openInterest != null && r.at.getTime() - openInterest < 86_400_000 && inWin(r.at)) hits.push({ kind: "double_ask", at: r.at });
      openInterest = r.at.getTime();
    }
    if (inWin(r.at) && qs.length) {
      const prior: Turn[] = o.rows.slice(0, i).filter((x) => r.at.getTime() - x.at.getTime() < 3 * 86_400_000).map((x) => ({ from: x.from, text: x.text }));
      if (repeatedQuestion(r.text, prior)) hits.push({ kind: "reask", at: r.at });
      if (o.closeTurns.some((t) => r.at.getTime() >= t.getTime() && r.at.getTime() - t.getTime() < 10 * 60_000 && !o.rows.slice(0, i).some((x) => x.from === "them" && x.at > t))) hits.push({ kind: "after_close", at: r.at });
    }
    if (inWin(r.at) && ((r.text.match(URL) ?? []).length || qs.length) && o.closed.some((c) => c.at < r.at && about(r.text, c.label))) hits.push({ kind: "reopen", at: r.at });
  }
  return hits;
}

type Q = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export async function loadMember(userId: string, since: Date, until: Date, db: Q = pool): Promise<{ rows: Row[]; closed: Closed[]; closeTurns: Date[] }> {
  const from = new Date(since.getTime() - WEEK);
  const [m, c, t] = await Promise.all([
    db.query(`SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at >= $2 AND created_at < $3 ORDER BY created_at, id`, [userId, from, until]),
    db.query(
      `SELECT title AS label, closed_at AS at FROM open_loops WHERE user_id = $1 AND status IN ('done','dropped') AND COALESCE(closed_reason,'') NOT IN ('stale','archived') AND closed_at >= $2 AND closed_at < $3
       UNION ALL SELECT text AS label, closed_at AS at FROM member_threads WHERE user_id = $1 AND status = 'resolved' AND closed_at >= $2 AND closed_at < $3`,
      [userId, new Date(since.getTime() - 2 * WEEK), until],
    ),
    db.query(`SELECT created_at FROM harness_decisions WHERE user_id = $1 AND decision = 'turn.move_read' AND action = 'close' AND created_at >= $2 AND created_at < $3`, [userId, since, until]),
  ]);
  const rows: Row[] = m.rows
    .map((r: any) => ({ text: String(r.content ?? ""), at: new Date(r.created_at) }))
    .filter((r: any) => /^(User said|Co replied):/.test(r.text))
    .map((r: any) => ({ from: r.text.startsWith("User said:") ? ("them" as const) : ("co" as const), text: r.text.replace(/^(User said|Co replied):\s*/, ""), at: r.at }));
  return { rows, closed: c.rows.filter((r: any) => r.label).map((r: any) => ({ label: String(r.label), at: new Date(r.at) })), closeTurns: t.rows.map((r: any) => new Date(r.created_at)) };
}

export async function exchangeCounts(since: Date, until: Date, o: { userIds?: string[]; db?: Q } = {}): Promise<{ userId: string; hits: Hit[] }[]> {
  const db = o.db ?? pool;
  const ids = o.userIds ?? (await db.query(`SELECT DISTINCT user_id FROM co_memories WHERE memory_type = 'text_exchange' AND created_at >= $1 AND created_at < $2`, [since, until])).rows.map((r: any) => r.user_id);
  const out: { userId: string; hits: Hit[] }[] = [];
  for (const userId of ids) {
    const hits = countMember({ ...(await loadMember(userId, since, until, db)), since, until });
    if (hits.length) out.push({ userId, hits });
  }
  return out;
}

const KIND_WHY: Record<CountKind, string> = {
  repeat: "a link or card sent again with nothing asking for it",
  double_ask: "a second interest question while the last had no answer",
  reask: "a question they had already answered",
  reopen: "a find, offer or question about something they had closed",
  after_close: "a question after the turn's move was close",
};
// Pure: one hit as a review flag (kinds and times only).
export function hitFlag(userId: string, h: Hit): ReviewFlag {
  return { userId, at: h.at.toISOString(), type: "exchange_miss", severity: h.kind === "reopen" || h.kind === "reask" ? "medium" : "low", snippet: h.kind, decisionIds: [], cause: `whole-exchange count: ${KIND_WHY[h.kind]}`, causeConfirmed: false, source: "conversation" };
}

// The nightly run: the last 24 hours, logged with counts by kind and member ids, and stored as review flags where the review is on.
export async function runNightlyExchangeCount(now: Date = new Date()): Promise<Record<CountKind, number>> {
  const since = new Date(now.getTime() - 86_400_000);
  const { recordDecision } = await import("./core.js");
  const totals: Record<CountKind, number> = { repeat: 0, double_ask: 0, reask: 0, reopen: 0, after_close: 0 };
  try {
    const per = await exchangeCounts(since, now);
    for (const p of per) for (const h of p.hits) totals[h.kind]++;
    const D = await import("./devReview.js");
    const stored = await D.storeFlags(per.flatMap((p) => p.hits.map((h) => hitFlag(p.userId, h)))).catch(() => 0);
    await recordDecision({ layer: 3, decision: "exchange.nightly_count", userId: null, outcome: per.length ? "act" : "skip", action: per.length ? "counted" : "clean", proposal: { since: since.toISOString(), until: now.toISOString(), totals, stored, members: per.slice(0, 50).map((p) => ({ userId: p.userId, kinds: p.hits.map((h) => h.kind) })) } }).catch(() => {});
  } catch (err: any) {
    await recordDecision({ layer: 3, decision: "exchange.nightly_count", userId: null, outcome: "skip", action: "failed", reason: String(err?.name ?? "Error") }).catch(() => {});
  }
  return totals;
}
