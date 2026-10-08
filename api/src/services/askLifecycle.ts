// The life of an ask (Royce, 2026-10-06: "Close the ask loop"). Asks never closed when Co dealt with them, so a week later Co checked
// in on things it had already answered. An ask now has the same states as a loop (services/loopLifecycle.ts) and one way to close:
//
//   open     Co has it, nothing sent yet
//   waiting  a check-in went out and Co is waiting on their reply (awaiting_response_since)
//   closed   done: at their word, or because the evidence says so (below)
//   expired  the window they named ended, or 30 days passed with no restatement (services/askExpiry.ts)
//
// It closes when ANY of these fires, and the reason is kept (closed_reason, closed_evidence):
//   member     they said it's done, found, or moved on (profileExtraction resolutions, the closeAsk tool, a loop closed at their word)
//   answered   Co answered it in conversation: a model reads the exchange since the ask and must QUOTE the Co message that did it, and
//              code checks the quote is really there. Evidence closes without waiting for them to confirm.
//   delivered  Co sent the thing they asked for (a find that went out for this ask)
//   moved_on   they said, after the ask, that it's off or no longer wanted (quoted from THEIR words, verified)
//   expired    the dated window ended, or 30 days with no restatement
// A closed ask produces nothing: no check-in, no searching, no offers (every producer reads resolved_at IS NULL, and the check-in
// re-checks at send time). A closed ask never reopens by itself; their restating it makes a NEW ask.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { stateOf, type LoopState } from "./loopLifecycle.js";
import { closeAsk } from "./askKind.js";
import { localDay, localStamp, memberZone } from "./memberTime.js";

export type AskRow = {
  id: string;
  user_id: string;
  ask_id: string;
  ask_text: string;
  kind: string | null;
  created_at: Date | string;
  last_mentioned_at: Date | string | null;
  resolved_at: Date | string | null;
  expired_at: Date | string | null;
  closed_reason: string | null;
  awaiting_response_since: Date | string | null;
};

// The same four states a loop has.
export function askState(a: Pick<AskRow, "resolved_at" | "expired_at" | "closed_reason" | "awaiting_response_since">): LoopState {
  const closed = !!a.resolved_at;
  return stateOf({
    status: closed ? "done" : a.awaiting_response_since ? "waiting_on_reply" : "open",
    closedAt: closed ? new Date(a.resolved_at as any) : null,
    closedReason: a.expired_at ? "expired" : a.closed_reason ?? null,
  });
}
export const askIsLive = (a: Parameters<typeof askState>[0]): boolean => ["open", "waiting"].includes(askState(a));
// Dated like a loop: the last time they said it.
export const askLastConfirmed = (a: Pick<AskRow, "created_at" | "last_mentioned_at">): Date => new Date((a.last_mentioned_at ?? a.created_at) as any);

// An ask that is meant to keep going ("keep an eye out", "let me know when") is not closed by one answer or one find.
export const ONGOING = /\b(keep (an eye|looking|me posted|watching)|on(-|\s)?going|every (day|week|month)|weekly|daily|whenever|each time|going forward|let me know when|updates?)\b/i;

export type Closure = { askId: string; ask: string; how: "answered" | "delivered" | "moved_on"; evidence: string };

const norm = (s: string) => String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export type Msg = { at: Date | string; side: "member" | "co"; text: string };

export function judgePrompt(asks: { n: string; text: string; kind: string | null; since: string }[], convo: Msg[], zone: string | null = null): string {
  const lines = convo.map((m) => `[${localStamp(new Date(m.at), zone)}] ${m.side === "co" ? "Co" : "Member"}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n").slice(-14000);
  return `A member asked Co for things. For each ask below, decide from the conversation AFTER it whether it is finished, and say how, with a QUOTE.

Asks:
${asks.map((a) => `${a.n}. (said ${a.since}) ${a.text}`).join("\n")}

How an ask is finished:
- "answered": Co's own message gave what the ask wanted (the answer, the guidance, the link, the draft, the shortlist). The quote is copied from that Co message. A question back, an offer to help, or a partial answer does not count.
- "moved_on": the MEMBER said after the ask that it is done, found, cancelled, off, or no longer wanted. The quote is copied from the member's message.
An ask that asks Co to keep watching or keep looking ("keep an eye out", "let me know when") is never finished by one answer. If you are not sure, leave it out. Never use a message from before the ask was said.

Conversation:
${lines}

Return ONLY JSON: {"closures": [{"ask": "A1", "how": "answered", "quote": "..."}]}`;
}

// Pure: only closures whose quote is really in a message of the right side, said after the ask; ongoing asks never answered.
export function verifyClosures(raw: { ask?: unknown; how?: unknown; quote?: unknown }[], asks: { n: string; row: Pick<AskRow, "id" | "ask_id" | "ask_text" | "created_at"> }[], convo: Msg[]): Closure[] {
  const out: Closure[] = [];
  for (const r of raw ?? []) {
    const a = asks.find((x) => x.n === String(r.ask));
    const how = r.how === "answered" || r.how === "moved_on" ? r.how : null;
    const quote = typeof r.quote === "string" ? r.quote.trim() : "";
    if (!a || !how || norm(quote).length < 12) continue;
    if (how === "answered" && ONGOING.test(a.row.ask_text)) continue;
    const side = how === "answered" ? "co" : "member";
    const q = norm(quote);
    const hit = convo.find((m) => m.side === side && +new Date(m.at) > +new Date(a.row.created_at) && norm(m.text).includes(q));
    if (!hit) continue;
    out.push({ askId: a.row.ask_id, ask: a.row.ask_text, how, evidence: quote.slice(0, 280) });
  }
  // one closure per ask
  return out.filter((c, i) => out.findIndex((d) => d.askId === c.askId) === i);
}

export type AskDeps = {
  openAsks: (userId: string) => Promise<AskRow[]>;
  conversation: (userId: string, since: Date) => Promise<Msg[]>;
  delivered: (userId: string, ask: AskRow) => Promise<string | null>; // what was sent for this ask, or null
  judge: (prompt: string) => Promise<{ ask?: unknown; how?: unknown; quote?: unknown }[]>;
  close: (userId: string, askId: string, how: Closure["how"], evidence: string) => Promise<void>;
  markChecked: (userId: string, ids: string[]) => Promise<void>;
  zone?: (userId: string) => Promise<string | null>; // their zone (services/memberTime.ts): the judge sees their times, named
};

// What would close, without closing anything (the dead-ask list, and the first half of closeAnswered).
export async function proposeClosures(userId: string, deps: AskDeps = realDeps, only?: string[]): Promise<Closure[]> {
  const open = (await deps.openAsks(userId)).filter((a) => askIsLive(a) && (!only || only.includes(a.ask_id)));
  if (!open.length) return [];
  const out: Closure[] = [];
  // Code-only evidence first: Co sent the thing for this ask.
  const rest: AskRow[] = [];
  for (const a of open) {
    const sent = ONGOING.test(a.ask_text) ? null : await deps.delivered(userId, a);
    if (sent) out.push({ askId: a.ask_id, ask: a.ask_text, how: "delivered", evidence: sent.slice(0, 280) });
    else rest.push(a);
  }
  if (rest.length) {
    const since = new Date(Math.min(...rest.map((a) => +new Date(a.created_at))));
    const convo = await deps.conversation(userId, since);
    if (convo.length) {
      const numbered = rest.map((a, i) => ({ n: `A${i + 1}`, row: a }));
      const zone = deps.zone ? await deps.zone(userId) : null;
      const raw = await deps.judge(judgePrompt(numbered.map((x) => ({ n: x.n, text: x.row.ask_text, kind: x.row.kind, since: localDay(new Date(x.row.created_at), zone) })), convo, zone));
      out.push(...verifyClosures(raw, numbered, convo));
    }
  }
  return out;
}

// Closes what the evidence closes, with its reason and proof. Never throws into a caller.
export async function closeAnsweredAsks(userId: string, deps: AskDeps = realDeps, only?: string[]): Promise<Closure[]> {
  try {
    const closures = await proposeClosures(userId, deps, only);
    for (const c of closures) await deps.close(userId, c.askId, c.how, c.evidence);
    const checked = (await deps.openAsks(userId)).filter((a) => !only || only.includes(a.ask_id)).map((a) => a.id);
    await deps.markChecked(userId, checked);
    return closures;
  } catch (err: any) {
    console.error("askLifecycle: closing answered asks failed (non-fatal):", err?.message ?? err);
    return [];
  }
}

// The gate every check-in passes at send time: closed asks and asks Co already answered make nothing.
export async function checkinGate(userId: string, askCheckinId: string, deps: AskDeps = realDeps): Promise<{ ok: true } | { ok: false; why: string }> {
  const ask = (await deps.openAsks(userId)).find((a) => a.id === askCheckinId);
  if (!ask) return { ok: false, why: "ask closed: it is no longer open" };
  if (!askIsLive(ask)) return { ok: false, why: `ask closed: ${askState(ask)}` };
  const closed = await closeAnsweredAsks(userId, deps, [ask.ask_id]);
  if (closed.length) return { ok: false, why: `ask closed: ${closed[0].how} (${closed[0].evidence.slice(0, 80)})` };
  return { ok: true };
}

// An ask referred to by either id: closed means it produces nothing. No row (a call's promise, an older shape) does not block.
export async function askIsOpenRef(userId: string, ref: string | null | undefined, db: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<boolean> {
  if (!ref) return true;
  const { rows } = await db.query(`SELECT resolved_at IS NULL AS open FROM ask_checkins WHERE user_id = $1 AND (id::text = $2 OR ask_id = $2) LIMIT 1`, [userId, ref]).catch(() => ({ rows: [] as any[] }));
  return rows.length ? rows[0].open === true : true;
}

// ---------------------------------------------------------------- the real thing
let realDeps: AskDeps = defaultDeps();
export function setAskDepsForTests(d: AskDeps | null): void { realDeps = d ?? defaultDeps(); }
export function defaultDeps(): AskDeps { return {
  zone: (userId) => memberZone(userId),
  openAsks: async (userId) => (await pool.query(`SELECT id, user_id, ask_id, ask_text, kind, created_at, last_mentioned_at, resolved_at, expired_at, closed_reason, awaiting_response_since FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at`, [userId])).rows,
  conversation: async (userId, since) => {
    const { rows } = await pool.query(
      `SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at > $2 AND content NOT LIKE '%[to Mo]%' ORDER BY created_at DESC LIMIT 200`,
      [userId, since],
    );
    return rows
      .reverse()
      .map((r: any): Msg | null => (/^User said:/i.test(r.content) ? { at: r.created_at, side: "member", text: r.content.replace(/^User said:\s*/i, "") } : /^Co replied:/i.test(r.content) ? { at: r.created_at, side: "co", text: r.content.replace(/^Co replied:\s*/i, "") } : null))
      .filter((m: Msg | null): m is Msg => !!m);
  },
  delivered: async (userId, ask) => {
    const { rows } = await pool.query(
      `SELECT payload FROM proactive_candidates WHERE user_id = $1 AND status = 'sent' AND type IN ('event_offer', 'event_match_nudge') AND (payload->>'askId' = $2 OR payload->>'askId' = $3) ORDER BY decided_at DESC LIMIT 1`,
      [userId, ask.id, ask.ask_id],
    );
    const name = rows[0]?.payload?.match?.name;
    return rows[0] ? `Sent them ${name ? `"${String(name).slice(0, 120)}"` : "a find"} for this ask` : null;
  },
  judge: async (prompt) => {
    const { text } = await generateText({ model: anthropic(MODELS.sonnet), providerOptions: { anthropic: { effort: "low" } }, experimental_telemetry: { isEnabled: true, functionId: "ask.lifecycle.judge", recordInputs: false, recordOutputs: false }, prompt });
    return parseModelJson<{ closures?: any[] }>(text).closures ?? [];
  },
  close: async (userId, askId, how, evidence) => { await closeAsk(userId, askId, how, evidence); },
  markChecked: async (userId, ids) => { if (ids.length) await pool.query(`UPDATE ask_checkins SET answered_checked_at = NOW() WHERE user_id = $1 AND id::text = ANY($2::text[])`, [userId, ids]); },
}; }

// Hourly, with the sweep: members with an open ask and new talk since the last look. At most 12 members a run.
export async function closeAnsweredAsksAll(limit = 12, deps: AskDeps = realDeps): Promise<number> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ac.user_id FROM ask_checkins ac JOIN users u ON u.id = ac.user_id
     WHERE ac.resolved_at IS NULL AND u.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM co_memories m WHERE m.user_id = ac.user_id AND m.memory_type = 'text_exchange' AND m.created_at > COALESCE(ac.answered_checked_at, ac.created_at))
     LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const r of rows) n += (await closeAnsweredAsks(r.user_id, deps)).length;
  return n;
}
