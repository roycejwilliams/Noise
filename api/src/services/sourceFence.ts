// The one boundary for what Co reads to ground a reply, check a lesson, or build what's running and what's ahead for a member
// (Royce, 2026-10-13: "anything Co reads to ground a reply, verify a lesson, or build context for a member comes only from (a) Co's
// own conversation with that member and (b) sources the member explicitly connected to Co. Never my texts with other people, never
// another member's conversation or memories. One shared fence, not five separate checks").
//
// Every read here is scoped to one member's own rows, and every line goes through the same two gates before anyone sees it:
//   1. whose words: a line the member sent to someone other than Co (a teammate agent, "[to Mo]"), and that agent's replies, are
//      never theirs-to-Co (services/teamLines.ts); dropped in SQL and again in code, so lines handed in from elsewhere are fenced too
//   2. other members: another member's name or details are stripped (services/memberSafeMemories.ts memberSafeLine). When the names
//      can't be read, every line is withheld (fails closed)
// What each reader may touch is declared in SOURCES. The modules that use it (searchCoverage, whatsAhead, lessonCheck, memberWorld) read member
// data only through here; layer 1 (evals/guards/rules.ts, section 5) fails any of them that queries a table itself.
import pool from "../db/db.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";

// (a) Co's own conversation with the member, and Co's own record of its work for them; (b) what they connected. No reader here
// touches another member's rows, the member's talk with anyone else, or a connected source (none of these paths needs one yet).
export const SOURCES = {
  theirTexts: "a: their texts to Cue (text_exchange, 'User said:', never to a teammate)",
  replyLog: "a: Cue's replies to them as drafted and as sent (reply.grounding); a draft is withheld when it carried another member's details",
  openFindAsks: "a: what they asked Cue to find (ask_checkins, kind 'find')",
  lastDailyRun: "a: what Cue's daily search did for them (sweep.daily)",
  scheduled: "a: Cue's open tasks and check-ins for them (co_tasks)",
  queuedFinds: "a: finds queued to them (proactive_candidates, a count only)",
  lessonOriginals: "a: the lessons Cue already checked for them (lesson.check, the guessed lesson only)",
  exchange: "a: their recent texts with Cue, both sides, as sent (text_exchange, never to or from a teammate); the member-world read (services/memberWorld.ts)",
  recall: "a: their own older conversation, text_exchange and stored call_transcript rows, searched by topic and date on ask (services/conversationRecall.ts); read through the removal guards and this fence, returned as history",
  activity: "a: when they were last active on any channel (their texts, voice memos, calls, texts to a teammate): timestamps only, never what was said",
} as const;
// The two other paths the 10-13 fixes added read no member data at all, so they have nothing to fence:
//   - offer detection (harness/replyGrounding.ts offersAlready): reads only the reply Co is about to send
//   - page re-read (services/sendCheck.ts readOpenNow): reads only the find's own public page and its name; nothing about any member
//     goes into it or comes out of it
export const NO_MEMBER_DATA = ["offersAlready", "readOpenNow"] as const;

export type Strip = (s: string) => string | null;
// failed: the names couldn't be read, so strip withholds every line. Callers count what it withheld, never treat it as nothing.
export type Fence = { userId: string; strip: Strip; failed?: boolean };

// One fence per member per turn (turnContext builds it and hands it on). Names read strictly; a failure withholds everything rather
// than letting anything through.
export async function memberFence(userId: string, linked?: string[]): Promise<Fence> {
  return fenceFrom(userId, await import("./memberSafeMemories.js").then((m) => m.memberSafeLine(userId, linked)).catch(() => null));
}
// Pure: the fence from a strip already read (turnContext reads it once per turn), or a failed fence when there's none.
export function fenceFrom(userId: string, line: Strip | null): Fence {
  return line ? { userId, strip: line } : { userId, strip: () => null, failed: true };
}

// Pure: their own lines to Co, fenced. Lines to or from a teammate go first; then other members' details. A line the strip blanks
// is dropped, never sent on as a hole.
export type TheirText = { at: Date; text: string };
export function fenceTheirTexts(f: Pick<Fence, "strip">, lines: TheirText[]): TheirText[] {
  return lines.flatMap((l) => {
    const own = withoutTeammateLines(l.text).trim();
    if (!own || own !== l.text.trim()) return [];
    const kept = f.strip(own);
    return kept ? [{ at: l.at, text: kept }] : [];
  });
}

// Pure: Co's replies, fenced. What went out was already member-safe for them, and goes through the strip again. A draft that differs
// from what went out is kept only if the strip leaves it whole: a draft the check cut for another member's details never leaves.
// failed: the checks that failed on that reply (name, and the check's own reason, which for a claim check quotes the cut words).
export type FailedCheck = { name: string; reason?: string | null };
export type ReplyLog = { at: Date; outcome: string; draft: string; sent: string; why: string | null; failed?: (string | FailedCheck)[] };
export const LINE_WITHHELD = "[a line withheld]";
// A cut draft reaches a reader only as far as the checks that cut it were about Co's own wording: its work, promises, capabilities,
// timing, links or repeats. Any other claim check that cut it (a detail or claim that may be about someone else) has its own quoted
// words withheld from the draft; if those words can't be found there, or the cut wasn't a claim check (discretion, a private fact, a
// claim read that failed), the whole draft is withheld. The strip knows only linked members' names, so this is an allowlist: a new
// check name withholds until it's added here (review of the fence).
const OWN_WORDING_CUTS = new Set([
  "claim_work_status", "claim_future_promise", "claim_capability", "claim_prediction",
  "no_followup_promise", "no_result_promise", "no_internal_narration", "no_capability_denial", "no_prediction",
  "no_repeat_question", "no_duplicate_ask", "no_repeat", "no_link_offer_without_link", "no_emotion_label", "local_hours", "time_on_file",
  "no_invite_sent_claim", "no_call_placed_claim", "no_handover_claim", "no_group_chat_claim", "no_thread_report",
]);
export const DRAFT_WITHHELD = "(draft withheld: it carried another member's details)";
export function fenceReplyLog(f: Pick<Fence, "strip">, logs: ReplyLog[]): ReplyLog[] {
  return logs.flatMap((l) => {
    const sent = l.sent.trim() ? f.strip(l.sent) : "";
    if (sent === null) return [];
    let draft = sent;
    if (l.draft.trim() !== l.sent.trim()) {
      const redacted = redactCuts(l.draft, (l.failed ?? []).map((c) => (typeof c === "string" ? { name: c } : c)));
      const d = redacted === null ? null : f.strip(redacted);
      draft = d !== null && redacted !== null && d.trim() === redacted.trim() ? redacted : DRAFT_WITHHELD;
    }
    return [{ at: l.at, outcome: l.outcome, draft, sent, why: l.why ? f.strip(l.why) : null }];
  });
}

// Pure: the draft with every non-own-wording claim check's quoted words withheld, or null when the whole draft must be withheld.
export function redactCuts(draft: string, failed: FailedCheck[]): string | null {
  if (!failed.length) return null;
  let out = draft;
  for (const c of failed) {
    if (OWN_WORDING_CUTS.has(c.name)) continue;
    if (!/^claim_/.test(c.name) || c.name === "claim_read" || c.name === "claim_read_failed") return null;
    // The check's reason is `type: "<the claim's words>"`, sometimes with a note after. Read to the last quote; claim words that hold a
    // quote of their own can't be told apart from the reason's, so that draft is withheld whole (review: "Dana said "..."" leaked).
    const quote = String(c.reason ?? "").match(/^[a-z_]+: "([\s\S]{6,})"(?:\s*\([\s\S]*\))?$/)?.[1];
    if (!quote || quote.includes('"') || !out.includes(quote)) return null;
    out = out.split(quote).join(LINE_WITHHELD);
  }
  return out;
}

// Pure: their recent exchange with Co, both sides, fenced. Lines to or from a teammate go first (in SQL and here), then other members'
// details; a line the strip blanks is dropped, never sent on as a hole. Only Co's own texts (a reply, a hold text) and theirs count.
export type ExchangeLine = { at: Date; from: "member" | "co"; text: string };
// The row headers the exchange takes: theirs, then Cue's.
export const EXCHANGE_ROW = /^(User said|User sent a voice memo|Co replied|Co is looking|Cue replied|Cue is looking):\s*([\s\S]*)$/;
// How any text_exchange row starts, these and every other (a call's follow-up "Co called Jordan — …", an old "Mo replied:", a
// "[Call] …" note): a speaker word or a bracket. Read on a joined thread, a line like this starts someone else's row, never more of
// theirs (replyGrounding.ts theirOwnWords). Errs toward ending their text: a paragraph of theirs that opens "Co-…" is dropped, never
// someone else's line taken as theirs.
export const ROW_START = /^\s*(?:\[|(?:User|Co|Cue|Mo|Assistant)\b)/;
export function fenceExchange(f: Pick<Fence, "strip">, rows: { at: Date; content: string }[]): ExchangeLine[] {
  return rows.flatMap((r) => {
    const c = String(r.content ?? "");
    const own = withoutTeammateLines(c).trim();
    if (!own || own !== c.trim()) return [];
    const m = own.match(EXCHANGE_ROW);
    if (!m || !m[2].trim()) return [];
    const kept = f.strip(m[2].trim());
    return kept ? [{ at: r.at, from: m[1].startsWith("User") ? ("member" as const) : ("co" as const), text: kept }] : [];
  });
}

// ---------------------------------------------------------------- the readers (the only member-data SQL these paths run)

export async function readTheirTexts(f: Fence, minutes: number, limit: number): Promise<TheirText[]> {
  const { rows } = await pool.query(
    `SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > NOW() - ($2 || ' minutes')::interval ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    [f.userId, String(minutes)],
  );
  return fenceTheirTexts(f, rows.reverse().map((r: any) => ({ at: new Date(r.created_at), text: String(r.content).replace(/^User said:\s*/, "") })));
}

export async function readReplyLog(f: Fence, minutes: number, limit: number): Promise<ReplyLog[]> {
  const { rows } = await pool.query(
    `SELECT created_at, action, proposal, reason, checks FROM harness_decisions WHERE user_id = $1 AND decision = 'reply.grounding' AND created_at > NOW() - ($2 || ' minutes')::interval ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    [f.userId, String(minutes)],
  );
  return fenceReplyLog(f, rows.reverse().map((r: any) => ({ at: new Date(r.created_at), outcome: String(r.action ?? ""), draft: String(r.proposal?.draft ?? ""), sent: String(r.proposal?.final ?? ""), why: r.reason ? String(r.reason) : null, failed: (Array.isArray(r.checks) ? r.checks : []).filter((c: any) => c && c.pass === false).map((c: any) => ({ name: String(c.name ?? ""), reason: c.reason ? String(c.reason) : null })) })));
}

// Open find asks, stripped; hidden counts the ones the strip blanked (still asked, so still searched).
export async function readOpenFindAsks(f: Fence): Promise<{ asks: string[]; hidden: number }> {
  const { rows } = await pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'find' ORDER BY COALESCE(last_mentioned_at, created_at) DESC`, [f.userId]);
  const raw = rows.map((x: any) => String(x.ask_text ?? "").trim()).filter(Boolean);
  const asks = raw.map(f.strip).filter((x): x is string => !!x);
  return { asks, hidden: raw.length - asks.length };
}

// The proposal of their latest sweep.daily within maxAgeHours, or null.
export async function readLastDailyRun(f: Fence, maxAgeHours: number): Promise<any | null> {
  const { rows } = await pool.query(`SELECT proposal FROM harness_decisions WHERE decision = 'sweep.daily' AND user_id = $1 AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT 1`, [f.userId, String(maxAgeHours)]);
  return rows[0]?.proposal ?? null;
}

export type ScheduledRow = { id: number; goal: string | null; kind: string | null; source: string | null; followup: any; nextCheckAt: string; deadline: string | null };
// Open tasks with a next time ahead. goal is null when the strip blanked it (still counted by the caller, never shown).
export async function readScheduled(f: Fence, now: Date, limit: number): Promise<ScheduledRow[]> {
  const { rows } = await pool.query(
    `SELECT id, goal, kind, source, followup, next_check_at, deadline FROM co_tasks WHERE user_id = $1 AND status = 'open' AND next_check_at IS NOT NULL AND next_check_at > $2 ORDER BY next_check_at LIMIT ${Math.max(1, Math.floor(limit))}`,
    [f.userId, now],
  );
  return rows.map((x: any) => ({ id: Number(x.id), goal: f.strip(String(x.goal ?? "")), kind: x.kind ?? null, source: x.source ?? null, followup: x.followup ?? null, nextCheckAt: new Date(x.next_check_at).toISOString(), deadline: x.deadline ? String(x.deadline instanceof Date ? x.deadline.toISOString().slice(0, 10) : x.deadline) : null }));
}

export async function readQueuedFindCount(f: Fence): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM proactive_candidates WHERE user_id = $1 AND status = 'pending' AND type = 'event_offer'`, [f.userId]);
  return Number(rows[0]?.n ?? 0);
}

// Their recent exchange with Co, oldest first, fenced (fenceExchange).
export async function readExchange(f: Fence, hours: number, limit: number): Promise<ExchangeLine[]> {
  const { rows } = await pool.query(
    `SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} AND created_at > NOW() - ($2 || ' hours')::interval ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    [f.userId, String(hours)],
  );
  return fenceExchange(f, rows.reverse().map((r: any) => ({ at: new Date(r.created_at), content: String(r.content ?? "") })));
}

// When they were active lately on any channel, newest first: timestamps only. Their texts to a teammate count here (they were around),
// which is why this read returns no content at all; nothing they said reaches anyone through it.
export async function readActivityTimes(f: Fence, hours: number): Promise<Date[]> {
  const { rows } = await pool.query(
    `SELECT created_at FROM co_memories WHERE user_id = $1 AND created_at > NOW() - ($2 || ' hours')::interval AND ((memory_type = 'text_exchange' AND (content LIKE 'User said:%' OR content LIKE 'User sent a voice memo:%' OR content LIKE '[Call]%')) OR memory_type = 'call_transcript') ORDER BY created_at DESC LIMIT 300`,
    [f.userId, String(hours)],
  );
  return rows.map((r: any) => new Date(r.created_at));
}

export async function readLessonOriginals(f: Fence, days: number): Promise<string[]> {
  const { rows } = await pool.query(`SELECT proposal->>'original' AS original FROM harness_decisions WHERE user_id = $1 AND decision = 'lesson.check' AND created_at > NOW() - ($2 || ' days')::interval`, [f.userId, String(days)]);
  return rows.map((x: any) => String(x.original ?? ""));
}

// Pure: the teammate-line test the fence applies, for callers that hold text from elsewhere.
export { withoutTeammateLines };
