// A member's first call (Royce, 2026-11-02, onboarding rulings 1-2; ~/cue-worktrees/notes/onboarding-proposal-1102.md).
//
// The first-call flag is real: no past call transcript (a call_transcript row that isn't the dial marker "Co initiated call ..."),
// the same read callGate.ts uses for "intake call already happened". It used to be an empty call context, so a member who texted
// a lot before their first call was treated as a returning caller.
//
// On a first call only, GPT-Live's opening also gets (services/gptLive.ts OpeningContext):
//   - one line of their own texted words: at most 160 characters, work or plans only, through callReason.ts SENSITIVE (whoever
//     answers hears the opening), never a line their removals took back (services/whatCoKnows.ts guardText);
//   - the member who brought them in, only when they wrote that name in their own texts. Otherwise the inviter is never given to
//     the call, and the existing rule stands: nothing another member said or did is named.
// And the thinking is told whether their email is on file, and whether it was already asked for once (ruling A).
import pool from "../db/db.js";
import { DateTime } from "luxon";
import { SENSITIVE } from "./callReason.js";
import { FIRST_CALL } from "./gptLive.js";
import type { FirstCallFacts } from "./gptLive.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

// Work or plans: what they do, are building, changing or planning. Not feelings, health, family or other people's business.
export const WORK_OR_PLANS =
  /\b(?:work(?:ing|s|ed)?|job|jobs|role|career|startup|company|business|founder|founding|launch\w*|build(?:ing)?|ship(?:ping)?|project|product|client|clients|freelanc\w*|studio|agency|hiring|hire|team|raise|raising|fundrais\w*|investor\w*|quit|notice|last day|new job|offer|interview\w*|promotion|moving|move to|relocat\w*|plan(?:s|ning)?|planning|trip|conference|event|class|course|degree|school|program|portfolio|pitch\w*|side project|consult\w*|contract\w*)\b/i;
// What never goes in the opening, whatever else the line says: an invite code, an email, a number, a link, a question about Cue.
const NOT_OPENING = /\b(?:code|invite|invited)\b|@|https?:\/\/|\bwww\.|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}|\bcue\b|\bco\b(?![-\w])/i;

// Pure: whether a line may go in the opening at all (work or plans, never sensitive, never a code/email/number/link/question about Cue).
const openable = (t: string, minWords: number): boolean => t.split(/\s+/).length >= minWords && WORK_OR_PLANS.test(t) && !SENSITIVE.test(t) && !NOT_OPENING.test(t);
const cutAtWord = (t: string, max: number): string => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > 40 ? cut.slice(0, at) : cut).replace(/[,;:]$/, "");
};

// Pure: the sentence of theirs the opening may build on, cut to at most `max` characters at a word. Newest first; null when none fits.
export function openingWords(theirTexts: string[], max: number = FIRST_CALL.wordsMax): string | null {
  for (const text of theirTexts) {
    const sentences = String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const t = s.trim();
      if (openable(t, 4)) return cutAtWord(t, max);
    }
  }
  return null;
}

// What never goes in an opening because it names or points at another person: a capitalized name past the first word (weekdays, months and
// the member's own "I" aside; a company name is dropped too, the safe side), or a relation ("my sister", "my cofounder").
const NAMES_SOMEONE = /(?<=\s)(?!(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|I|I'm|I'll|I've)\b)[A-Z][a-z]{1,}\b|\b(?:my|his|her|their)\s+(?:wife|husband|partner|spouse|girlfriend|boyfriend|fianc\w+|sister|brother|mom|mother|dad|father|son|daughter|kid|kids|boss|manager|cofounder|co-founder|friend|friends|ex|roommate|landlord)\b/;
// Cue's own offers, intros and sends are never the member's thread.
const COS_OWN = /^\s*(?:sent|shared|offered|intro(?:duc\w*)?|emailed|texted|forwarded|delivered|follow(?:ed)? up|nudge\w*)\b/i;
// A message that is itself a cancellation or a drop.
const CANCELLED = /\b(?:cancel\w*|called off|call(?:ing)? it off|never ?mind|scrapp\w*|no longer|not (?:doing|going|happening|moving forward)|won'?t be|forget (?:it|that|about)|postpon\w*|fell through|dropped|dropping|abandon\w*|gave up|giving up)\b/i;
export const THREAD_DAYS = 14;
const content = (t: string): string[] => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !["that", "this", "with", "from", "have", "about", "their", "they", "them", "what", "when", "plan", "need", "want"].includes(w));
// Pure: a line shares a subject with something closed (two content words, or the closed label inside the line).
export const aboutClosed = (line: string, closed: string[]): boolean => {
  const l = line.toLowerCase();
  const lw = new Set(content(line));
  return closed.some((c) => { const cl = c.toLowerCase().trim(); if (!cl) return false; if (cl.length >= 6 && l.includes(cl)) return true; return content(c).filter((w) => lw.has(w)).length >= 2; });
};
const threadable = (t: string, closed: string[]): boolean => openable(t, 2) && !NAMES_SOMEONE.test(t) && !CANCELLED.test(t) && !COS_OWN.test(t) && !aboutClosed(t, closed);

// Pure: the one line a later call's opening may build on (Royce's 2026-11-04 review: three calls opened with the same "what's on your
// mind"). The most recent fresh open thread first (loopLifecycle isDraftable has already vetted these), then the latest sentence of
// theirs from the last THREAD_DAYS days; the same work-or-plans and SENSITIVE filters as a first call's words, and never a line that
// names another person, is Cue's own offer, is a cancellation, or is about something they closed. At most FIRST_CALL.wordsMax
// characters. Null when none fits: the opening then has no thread (and still avoids the stock opener).
export function threadLine(openThreads: string[], theirTexts: string[], max: number = FIRST_CALL.wordsMax, closed: string[] = []): string | null {
  for (const raw of openThreads) {
    const t = String(raw).replace(/\s+/g, " ").trim();
    if (threadable(t, closed)) return cutAtWord(t, max);
  }
  for (const text of theirTexts) {
    for (const s of String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (!openable(t, 4) || !threadable(t, closed)) continue;
      if (CANCELLED.test(String(text))) continue;
      return cutAtWord(t, max);
    }
  }
  return null;
}

// Pure: the inviter's first name, only when it appears as a word in their own texts (ruling 2). Never anyone else's name.
export function inviterNamedByThem(inviter: string | null | undefined, theirTexts: string[]): string | null {
  const name = String(inviter ?? "").trim();
  if (name.length < 2) return null;
  const re = new RegExp(`(?<![\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu");
  return theirTexts.some((t) => re.test(String(t))) ? name : null;
}

// Pure: the first-call flag from the past-call read.
export const isFirstCall = (pastRealCalls: number): boolean => pastRealCalls === 0;

// Everything a first call needs, read for one member. Any read that fails leaves its piece out; the flag failing is not a first call
// (the four phases, as before).
export async function firstCallFacts(userId: string, db: Db = pool): Promise<FirstCallFacts> {
  const past = await db
    .query(`SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND content NOT LIKE 'Co initiated call%' LIMIT 1`, [userId])
    .then((r) => r.rows.length)
    .catch(() => 1);
  if (!isFirstCall(past)) return { firstCall: false };
  const { notToTeammate } = await import("./teamLines.js");
  const { NAME_EMAIL } = await import("./onboardingLines.js");
  const [texts, inviter, user, removed, oldLine] = await Promise.all([
    db
      .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 20`, [userId])
      .then((r) => r.rows.map((x: any) => String(x.content).replace(/^User said:\s*/, "")))
      .catch(() => [] as string[]),
    db
      .query(`SELECT u.first_name FROM invite_codes ic JOIN users u ON u.id = ic.created_by WHERE ic.used_by = $1 AND ic.created_by IS NOT NULL LIMIT 1`, [userId])
      .then((r) => (r.rows[0]?.first_name ? String(r.rows[0].first_name) : null))
      .catch(() => null),
    db.query(`SELECT email, intake_retries FROM users WHERE id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
    import("./whatCoKnows.js").then((W) => W.forgottenRows(userId, db as any).then((rows) => ({ W, rows: rows.filter((g) => g.removed) }))).catch(() => null),
    // The old door's name-and-email line counts as the one ask (members mid-intake when the 2026-11-02 change shipped).
    db
      .query(`SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content = ANY($2::text[]) LIMIT 1`, [userId, NAME_EMAIL.map((l) => `Co replied: ${l}`)])
      .then((r) => r.rows.length > 0)
      .catch(() => false),
  ]);
  // What their removals took back never reaches the call (Royce, 10-14 ruling B).
  const kept = removed?.rows.length ? texts.map((t) => removed.W.guardText(t, removed.rows)).filter((t): t is string => !!t && !!t.trim()) : texts;
  const { hasPendingEmail } = await import("./identity.js");
  const email = String(user?.email ?? "");
  return {
    firstCall: true,
    theirWords: openingWords(kept),
    inviter: inviterNamedByThem(inviter, kept),
    emailOnFile: !!email && !hasPendingEmail(email),
    emailAsked: Number(user?.intake_retries ?? 0) > 0 || oldLine,
  };
}

// A later call's thread (see threadLine), read for one member: open loops that are still fresh (loopLifecycle isDraftable) and their texts
// from the last THREAD_DAYS days, minus anything their removals took back and anything about a closed subject (the exchange record's
// closed items). Any read that fails leaves its piece out; null when nothing fresh fits.
export async function laterCallThread(userId: string, db: Db = pool, now: Date = new Date()): Promise<string | null> {
  const { notToTeammate } = await import("./teamLines.js");
  const { isDraftable } = await import("./loopLifecycle.js");
  const zone = await import("./memberTime.js").then((m) => m.memberZoneOrFallback(userId)).catch(() => "America/Los_Angeles");
  const today = DateTime.fromJSDate(now).setZone(zone).toISODate() ?? now.toISOString().slice(0, 10);
  const [loops, texts, removed, closed] = await Promise.all([
    db
      .query(`SELECT title, status, due_date, last_confirmed_at, decay_asked_at FROM open_loops WHERE user_id = $1 AND closed_at IS NULL ORDER BY changed_at DESC LIMIT 8`, [userId])
      .then((r) =>
        r.rows
          .filter((x: any) =>
            isDraftable({ status: String(x.status ?? "open"), closedAt: null, closedReason: null, dueDate: x.due_date ? String(x.due_date).slice(0, 10) : null, lastConfirmedAt: x.last_confirmed_at ? new Date(x.last_confirmed_at) : null, decayAskedAt: x.decay_asked_at ? new Date(x.decay_asked_at) : null }, now, today),
          )
          .map((x: any) => String(x.title ?? "")),
      )
      .catch(() => [] as string[]),
    db
      .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND created_at > $2 AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 20`, [userId, new Date(now.getTime() - THREAD_DAYS * 86_400_000)])
      .then((r) => r.rows.map((x: any) => String(x.content).replace(/^User said:\s*/, "")))
      .catch(() => [] as string[]),
    import("./whatCoKnows.js").then((W) => W.forgottenRows(userId, db as any).then((rows) => ({ W, rows: rows.filter((g) => g.removed) }))).catch(() => null),
    import("./exchangeRecord.js").then((X) => X.closedLately(userId, db as any)).then((rows) => rows.map((r) => r.label)).catch(() => [] as string[]),
  ]);
  const keep = (xs: string[]) => (removed?.rows.length ? xs.map((t) => removed.W.guardText(t, removed.rows)).filter((t): t is string => !!t && !!t.trim()) : xs);
  return threadLine(keep(loops), keep(texts), FIRST_CALL.wordsMax, closed);
}
