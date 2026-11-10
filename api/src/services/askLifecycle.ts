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
// Questions and lookouts (Royce, 2026-10-13: "When Co answers an ask fully in the reply (a question), close the ask. When the ask is a
// lookout ... it stays open as a standing lookout until the date passes, the member says stop, or it's fulfilled"): Co reads each ask
// once, from the member's own words, as a question or a lookout (askIntent; kept on ask_checkins.intent, logged as ask.intent with
// why). A question closes as above. A lookout never closes as answered or delivered: only expired, or at their word (moved_on: they
// said stop, or that they found it). An ask Co couldn't read yet closes on nothing but their word until it's read.
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
import { notToTeammate } from "./teamLines.js";
import { withMember } from "./llmUsage.js";

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
  intent?: string | null;
};
export type AskIntent = "question" | "lookout";

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
// Weariness or a pause in their words, and phrases that really end it (review of #441: "done" alone closed "I'm done looking for now,
// too tired"; "found" closed "I found it draining"). A pause always wins: nothing that says for now, a break, pause, later or for a bit
// closes a search.
export const PAUSE = /\b(?:for now|a break|take a break|taking a break|pause|paus(?:e|ing)|later|for a bit|for a while|not right now|hold off|step back)\b/i;
export const WEARY = /\b(?:tired|exhausted|worn out|drain(?:ed|ing)|burn(?:ed|t) out|sick of|over it|frustrat\w*)\b/i;
export const FINISHED = /\b(?:found (?:one|someone|somebody|an? \w+|my \w+|our \w+)|hired|done looking|all done|stop looking)\b/i;

const norm = (s: string) => String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export type Msg = { at: Date | string; side: "member" | "co"; text: string };

export function judgePrompt(asks: { n: string; text: string; kind: string | null; since: string }[], convo: Msg[], zone: string | null = null): string {
  const lines = convo.map((m) => `[${localStamp(new Date(m.at), zone)}] ${m.side === "co" ? "Cue" : "Member"}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n").slice(-14000);
  return `A member asked Cue for things. For each ask below, decide from the conversation AFTER it whether it is finished, and say how, with a QUOTE.

Asks:
${asks.map((a) => `${a.n}. (said ${a.since}) ${a.text}`).join("\n")}

How an ask is finished:
- "answered": Cue's own message gave what the ask wanted (the answer, the guidance, the link, the draft, the shortlist). The quote is copied from that Cue message. A question back, an offer to help, or a partial answer does not count.
- "moved_on": the MEMBER said after the ask that it is done, found, cancelled, off, or no longer wanted. The quote is copied from the member's message.
An ask that asks Cue to keep watching or keep looking ("keep an eye out", "let me know when") is never finished by one answer. If you are not sure, leave it out. Never use a message from before the ask was said.

Conversation:
${lines}

Return ONLY JSON: {"closures": [{"ask": "A1", "how": "answered", "quote": "..."}]}`;
}

// Pure: only closures whose quote is really in a message of the right side, said after the ask; ongoing asks never answered.
export function verifyClosures(raw: { ask?: unknown; how?: unknown; quote?: unknown }[], asks: { n: string; row: Pick<AskRow, "id" | "ask_id" | "ask_text" | "created_at"> }[], convo: Msg[], atTheirWordOnly?: ReadonlySet<string>): Closure[] {
  const out: Closure[] = [];
  for (const r of raw ?? []) {
    const a = asks.find((x) => x.n === String(r.ask));
    const how = r.how === "answered" || r.how === "moved_on" ? r.how : null;
    const quote = typeof r.quote === "string" ? r.quote.trim() : "";
    if (!a || !how || norm(quote).length < 12) continue;
    if (how === "answered" && (atTheirWordOnly ? atTheirWordOnly.has(a.row.id) : ONGOING.test(a.row.ask_text))) continue;
    // Tired of it, or a break, is not finished (Royce, 2026-11-10): "I'm tired of looking" keeps the search, gentler; only their word
    // that it's done, found, off or no longer wanted closes it.
    if (how === "moved_on" && (PAUSE.test(quote) || (WEARY.test(quote) && !FINISHED.test(quote)))) continue;
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
  // Each ask as a question or a lookout (by ask row id); null when it couldn't be read yet. Without it, the ONGOING words decide.
  intent?: (userId: string, asks: AskRow[]) => Promise<Map<string, AskIntent | null>>;
};

// Pure: the intent to act on: Co's reading when there is one; with no reader (tests), the ONGOING words; an unread ask is null.
export function intentFor(a: Pick<AskRow, "id" | "ask_text">, read: Map<string, AskIntent | null> | null): AskIntent | null {
  if (!read) return ONGOING.test(a.ask_text) ? "lookout" : "question";
  return read.get(a.id) ?? null;
}

export function intentPrompt(asks: { n: string; ask: string; words: string[] }[]): string {
  return `A member asked Cue for things. For each ask, read THEIR OWN WORDS and say which it is:
- "question": they want an answer or a thing now, and one good reply finishes it (what's a good spot for dinner tonight, how do I word this, send me the link).
- "lookout": they want Cue to keep watching and tell them when something comes up (look out for, find me, keep an eye out, let me know when, any X coming up). It stays open until its date passes, they say stop, or they have what they wanted.
Judge from their words, not from Cue's summary of the ask. If their words don't show it either way, leave that ask out.

${asks.map((a) => `${a.n}. Cue's summary: ${a.ask}\n   Their words: ${a.words.length ? a.words.map((w) => `"${w.slice(0, 300)}"`).join(" ") : "(not found)"}`).join("\n")}

Return ONLY JSON: {"asks": [{"ask": "A1", "intent": "question" or "lookout", "why": "a few words, quoting them"}]}`;
}

// What would close, without closing anything (the dead-ask list, and the first half of closeAnswered).
export async function proposeClosures(userId: string, deps: AskDeps = realDeps, only?: string[]): Promise<Closure[]> {
  const open = (await deps.openAsks(userId)).filter((a) => askIsLive(a) && (!only || only.includes(a.ask_id)));
  if (!open.length) return [];
  const out: Closure[] = [];
  const read = deps.intent ? await deps.intent(userId, open).catch(() => new Map<string, AskIntent | null>()) : null;
  // Only a question closes as answered or delivered; a lookout, or an ask not read yet, only at their word.
  const atTheirWordOnly = new Set(open.filter((a) => intentFor(a, read) !== "question").map((a) => a.id));
  // Code-only evidence first: Co sent the thing for this ask.
  const rest: AskRow[] = [];
  for (const a of open) {
    const sent = atTheirWordOnly.has(a.id) ? null : await deps.delivered(userId, a);
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
      out.push(...verifyClosures(raw, numbered, convo, atTheirWordOnly));
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

// Their closed asks, by both ids, as of `asOf`: closed is resolved either way (done, answered, delivered, moved on, declined,
// expired). The member's ask state (ask_checkins.resolved_at) is the one source (Royce, 2026-10-12: 4 of 7 picks on Oct 9 were for
// asks already closed).
export async function closedAskRefs(userId: string, asOf: Date = new Date(), db: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<Set<string>> {
  const { rows } = await db.query(`SELECT id::text AS id, ask_id FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NOT NULL AND resolved_at <= $2`, [userId, asOf]);
  return new Set(rows.flatMap((r: any) => [String(r.id), String(r.ask_id)]));
}

// Pure: a find waiting for an ask that has closed is dead: it leaves the pool and the queue. A reminder (a heads-up about something
// already shown to them) is exempt, and so is a find with no ask (a goal find, a call's promise with no row).
export function servesClosedAsk(item: { askId?: string | null; reminder?: boolean | null }, closed: ReadonlySet<string>): boolean {
  return !!item.askId && !item.reminder && closed.has(String(item.askId));
}

// ---------------------------------------------------------------- the real thing
let realDeps: AskDeps = defaultDeps();
export function setAskDepsForTests(d: AskDeps | null): void { realDeps = d ?? defaultDeps(); }
export function defaultDeps(): AskDeps { return {
  zone: (userId) => memberZone(userId),
  intent: (userId, asks) => readIntents(userId, asks),
  openAsks: async (userId) => (await pool.query(`SELECT id, user_id, ask_id, ask_text, kind, intent, created_at, last_mentioned_at, resolved_at, expired_at, closed_reason, awaiting_response_since FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at`, [userId])).rows,
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

// Pure: the member's own lines from a call transcript (Co's lines left out), the last few, for the intent read.
export function memberSideOf(transcript: string): string[] {
  return transcript
    .split(/\n+/)
    .filter((l) => /^\s*(user|member|caller|them)\s*:/i.test(l))
    .map((l) => l.replace(/^\s*\w+\s*:\s*/, "").trim())
    .filter(Boolean)
    .slice(-6)
    .map((l) => l.slice(0, 300));
}

// Each ask as a question or a lookout, read once (kept on the row, logged as ask.intent with why). The member's own words are the
// texts they sent in the minutes up to the ask (Co's ask_text is its summary, which loses "keep an eye out"). A read that fails
// leaves the ask unread (null), which closes only at their word, and it's read again next time.
// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
async function readIntents(...a: Parameters<typeof readIntentsInScope>): ReturnType<typeof readIntentsInScope> {
  return withMember(a[0], () => readIntentsInScope(...a));
}
async function readIntentsInScope(userId: string, asks: AskRow[]): Promise<Map<string, AskIntent | null>> {
  const out = new Map<string, AskIntent | null>();
  const todo: AskRow[] = [];
  for (const a of asks) {
    if (a.intent === "question" || a.intent === "lookout") out.set(a.id, a.intent);
    else todo.push(a);
  }
  if (!todo.length) return out;
  const { recordDecision } = await import("../harness/core.js");
  const numbered = await Promise.all(todo.map(async (a, i) => {
    const at = new Date(a.created_at as any);
    const { rows } = await pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at BETWEEN $2 AND $3 ORDER BY created_at DESC LIMIT 3`,
      [userId, new Date(at.getTime() - 20 * 60_000), new Date(at.getTime() + 60_000)],
    );
    // An ask from a call is captured from the call afterwards (review, 2026-10-13): their side of the transcript, around then.
    const { rows: calls } = await pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND created_at BETWEEN $2 AND $3 ORDER BY created_at DESC LIMIT 1`,
      [userId, new Date(at.getTime() - 3 * 3_600_000), new Date(at.getTime() + 10 * 60_000)],
    );
    const callWords = calls.length ? memberSideOf(String(calls[0].content)) : [];
    return { n: `A${i + 1}`, row: a, words: [...rows.reverse().map((r: any) => String(r.content).replace(/^User said:\s*/i, "")), ...callWords] };
  }));
  // No words of theirs to read: left unread (closes only at their word), never guessed from Co's summary.
  for (const x of numbered.filter((y) => !y.words.length)) {
    out.set(x.row.id, null);
    await recordDecision({ layer: 5, decision: "ask.intent", userId, outcome: "skip", action: "unread", reason: "none of their own words were found near the ask (text or call); left open until they say it's done", proposal: { askId: x.row.id, ask: x.row.ask_text.slice(0, 200) } });
  }
  const toRead = numbered.filter((y) => y.words.length);
  if (!toRead.length) return out;
  try {
    const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 800, experimental_telemetry: { isEnabled: true, functionId: "ask.intent", recordInputs: false, recordOutputs: false }, prompt: intentPrompt(toRead.map((x) => ({ n: x.n, ask: x.row.ask_text, words: x.words }))) });
    const raw = parseModelJson<{ asks?: { ask?: unknown; intent?: unknown; why?: unknown }[] }>(text).asks ?? [];
    for (const x of toRead) {
      const r = raw.find((y) => String(y.ask) === x.n);
      const intent = r?.intent === "question" || r?.intent === "lookout" ? (r.intent as AskIntent) : null;
      const why = typeof r?.why === "string" ? r.why.slice(0, 300) : "";
      out.set(x.row.id, intent);
      if (!intent) {
        await recordDecision({ layer: 5, decision: "ask.intent", userId, outcome: "skip", action: "unread", reason: "Cue's reading of the ask came back without a clear answer; read again next time", proposal: { askId: x.row.id, ask: x.row.ask_text.slice(0, 200) } });
        continue;
      }
      // The one way an ask becomes a lookout: this read of their own words (laneMoves.ts settleAskIntent, Royce 2026-10-13).
      await (await import("./laneMoves.js")).settleAskIntent(String(x.row.id), intent, why);
      await recordDecision({ layer: 5, decision: "ask.intent", userId, outcome: "act", action: intent, reason: why || null, proposal: { askId: x.row.id, ask: x.row.ask_text.slice(0, 200), words: x.words.map((w) => w.slice(0, 300)) } });
    }
  } catch (err: any) {
    console.error("askLifecycle: reading ask intents failed (non-fatal, read again next time):", err?.message ?? err);
    for (const x of toRead) out.set(x.row.id, null);
    await recordDecision({ layer: 5, decision: "ask.intent", userId, outcome: "skip", action: "error", reason: `reading failed: ${String(err?.message ?? err).slice(0, 200)}`, proposal: { asks: toRead.map((x) => x.row.id) } });
  }
  return out;
}

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
