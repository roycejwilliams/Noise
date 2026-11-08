// Milestones and the story back (Royce, 2026-09-29: "Co should feel like it's
// beside you for the whole stretch"). The moments worth marking, taken from
// Co's own record and never from a model: a thread they closed in their own
// words, something Co sent that they said they went to and how it was (a
// stated helped or didn't help only, never a plan to go; services/provenance.ts), and the time they've been with
// Co. Each is stored once with the evidence it came from. Co marks one at
// most every 7 days, in its own voice, using only that evidence (a companion
// text, harness/memberReflection.ts), and knows them in every reply so it can
// say "you started with X, and now Y" without inventing the arc.
//
// Read only with the owner's user id; nothing here reaches another member.
import pool from "../db/db.js";
import { UNCONFIRMED_RULE } from "./provenance.js";
import { classifyScope } from "../harness/scope.js";

// "with_co" (N days with Cue) is gone: that was Cue talking about itself (Royce, 2026-11-04). Only what happened for them is marked.
export type MilestoneKind = "went" | "thread_done";
export type Milestone = {
  key: string; // days:30 | went:<item_key> | thread:<id>
  kind: MilestoneKind;
  text: string; // plain statement of what happened
  then: string | null; // their words when it started, if any
  now: string | null; // their words when it landed, if any
  happenedAt: string; // ISO
  markedAt: string | null;
  // A "went" moment stands only on their own stated "going" (services/provenance.ts, 2026-10-12). One stored before that, from a
  // word-match read, is unconfirmed at read time: never marked, never said, only asked about.
  confirmed?: boolean;
};

// How far back their own lines are read to trace a quote (newest first, harness/memberThreads.ts ownLines).
export const OWN_LINES_DAYS = 120;
// Older than this when first found: known to Co's story, never announced.
export const ANNOUNCE_WITHIN_DAYS = 14;
// Co marks a moment at most this often.
export const MARK_EVERY_DAYS = 7;

export type Source = {
  joinedAt: string;
  now: string;
  went: { itemKey: string; name: string; at: string }[];
  closed: { id: string; text: string; openedQuote: string; closedQuote: string | null; at: string }[];
  // Their own lines as stored now (texts and call lines, harness/memberThreads.ts ownLines). Given: a quote that isn't in them is
  // never carried as theirs. Absent: not read (the quotes stand as the thread's gate checked them when it opened and closed).
  lines?: string[];
};

// 2026-11-07 review (candidate 854): a thread "deciding how to position the concept" closed on "I like that." became a milestone, and the
// check-in said 'You went from "We are really a social club" to "I like that."' A closing line that says nothing about the thread
// (a bare reaction) doesn't establish how it landed, so it isn't a moment; and a quote is carried only when it traces to a line of theirs.
// A bare reaction ("I like that.", "sounds good", "love it", "yeah totally"): agreement with something said, never how their thread
// landed. Anything else of theirs ("we found one", "we moved it to November") still stands as a close.
const REACTION = new Set("i i'm im we you it it's its that this so yeah yes yep ok okay sure totally really like love liked loved sounds sound good great nice cool agree agreed true makes make sense fair perfect amazing awesome interesting right exactly".split(" "));
export function closeSaysHowItLanded(_threadText: string, closedQuote: string): boolean {
  const w = closedQuote.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  return !(w.length > 0 && w.length <= 5 && w.every((x) => REACTION.has(x)));
}
const flatQ = (t: string) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export function tracesToTheirLine(quote: string, lines: string[]): boolean {
  const q = flatQ(quote);
  return !!q && lines.some((l) => flatQ(l).includes(q));
}

const dayMs = 86_400_000;

// Pure: what moments the record holds.
export function deriveMilestones(s: Source): Omit<Milestone, "markedAt">[] {
  const out: Omit<Milestone, "markedAt">[] = [];
  const joined = new Date(s.joinedAt).getTime();
  const now = new Date(s.now).getTime();
  for (const w of s.went) {
    out.push({ key: `went:${w.itemKey}`, kind: "went", text: `They went to ${w.name}, which Cue had sent them.`, then: null, now: null, happenedAt: new Date(w.at).toISOString() });
  }
  for (const t of s.closed) {
    // Only with their own closing words: without them there's nothing to say it in.
    if (!t.closedQuote) continue;
    // A thread about something outside the purpose boundary (an errand, a purchase) isn't a moment in their story with Cue.
    if (classifyScope(t.text).scope === "out") continue;
    if (!closeSaysHowItLanded(t.text, t.closedQuote)) continue;
    // Their closing words must still be theirs on file; the opening words are kept only when they are (else no quote, never a guess).
    if (s.lines && !tracesToTheirLine(t.closedQuote, s.lines)) continue;
    const then = t.openedQuote && (!s.lines || tracesToTheirLine(t.openedQuote, s.lines)) ? t.openedQuote : null;
    out.push({ key: `thread:${t.id}`, kind: "thread_done", text: `They were in the middle of: ${t.text}. It came through.`, then, now: t.closedQuote, happenedAt: new Date(t.at).toISOString() });
  }
  return out;
}

// Pure: the one to mark now, if any. Newest that's still fresh, nothing if one
// was marked lately.
export function pickToMark(all: Milestone[], now: Date): Milestone | null {
  // A row already stored is judged now, at pick time, not only when it was derived: a thread_done for something outside the purpose
  // boundary (an errand, a purchase) is never marked, and "N days with Cue" rows from before they were removed are never picked.
  all = all.filter((m) => m.confirmed !== false && (m.kind as string) !== "with_co" && !(m.kind === "thread_done" && classifyScope(`${m.text}\n${m.then ?? ""}\n${m.now ?? ""}`).scope === "out") && !(m.kind === "thread_done" && m.now && !closeSaysHowItLanded(m.text.replace(/^They were in the middle of: |\. It came through\.$/g, ""), m.now)));
  const lastMarked = all.filter((m) => m.markedAt).map((m) => new Date(m.markedAt!).getTime()).sort((a, b) => b - a)[0];
  if (lastMarked && now.getTime() - lastMarked < MARK_EVERY_DAYS * dayMs) return null;
  const fresh = all
    .filter((m) => !m.markedAt && now.getTime() - new Date(m.happenedAt).getTime() <= ANNOUNCE_WITHIN_DAYS * dayMs)
    .sort((a, b) => new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime());
  return fresh[0] ?? null;
}

// What Co knows of their story, for replies: dated statements and their own
// words. Facts, since each comes straight from the record.
export function storyLines(all: Milestone[], limit = 6): string[] {
  const recent = [...all].sort((a, b) => new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime()).slice(0, limit);
  return recent.map((m) => {
    const when = m.happenedAt.slice(0, 10);
    if (m.confirmed === false) return `Unconfirmed (${when}; ${UNCONFIRMED_RULE}): Cue once read a text of theirs as going to something it sent them. ${m.text.replace(/^They went to /, "It was ").replace(/, which (?:Co|Cue) had sent them\.$/, ".")}`;
    const words = m.then || m.now ? ` They first said: "${(m.then ?? "").slice(0, 160)}"${m.now ? ` and later: "${m.now.slice(0, 160)}"` : ""}.` : "";
    return `In their story with Cue (${when}): ${m.text}${words}`;
  });
}

function rowTo(r: any): Milestone {
  return { key: r.key, kind: r.kind, text: r.text, then: r.then_quote, now: r.now_quote, happenedAt: new Date(r.happened_at).toISOString(), markedAt: r.marked_at ? new Date(r.marked_at).toISOString() : null, confirmed: r.confirmed !== false };
}

// A "went" row is confirmed only by a stated outcome for the same item (its key is went:<item_key>).
// Their stated word that they went and how it was (helped / didn't help); a stated "going" is a plan, never "they went" (2026-10-12
// review: "I'm going" on Monday became "you went" on Tuesday, before the event). A check-in at the door is recorded the same way
// (routes/sendblue.ts event_checkin).
export const WENT_CONFIRMED_SQL = `(m.kind <> 'went' OR EXISTS (SELECT 1 FROM suggestion_outcomes so WHERE so.user_id = m.user_id AND 'went:' || so.item_key = m.key AND so.result IN ('helped', 'didnt_help') AND so.provenance = 'stated'))`;

export async function loadMilestones(userId: string): Promise<Milestone[]> {
  const { rows } = await pool.query(`SELECT m.*, ${WENT_CONFIRMED_SQL} AS confirmed FROM member_milestones m WHERE m.user_id = $1 AND m.kind <> 'with_co' ORDER BY m.happened_at DESC LIMIT 60`, [userId]);
  return rows.map(rowTo);
}

// One moment, read fresh before it is said (a queued companion text, harness/proactiveRegistry.ts).
export async function milestoneConfirmed(userId: string, key: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT ${WENT_CONFIRMED_SQL} AS confirmed FROM member_milestones m WHERE m.user_id = $1 AND m.key = $2 AND m.kind <> 'with_co'`, [userId, key]);
  return rows[0]?.confirmed === true;
}

async function loadSource(userId: string, now: Date): Promise<Source | null> {
  const lines = await import("../harness/memberThreads.js").then((T) => T.ownLines(userId, OWN_LINES_DAYS, { newest: true })).then((ls) => ls.map((l) => l.text)).catch(() => null);
  const [u, went, closed] = await Promise.all([
    pool.query(`SELECT created_at FROM users WHERE id = $1`, [userId]),
    pool.query(`SELECT item_key, item_name, created_at FROM suggestion_outcomes WHERE user_id = $1 AND result IN ('helped', 'didnt_help') AND provenance = 'stated' ORDER BY created_at DESC LIMIT 30`, [userId]),
    pool.query(`SELECT id, text, opened_quote, closed_quote, closed_at FROM member_threads WHERE user_id = $1 AND status = 'resolved' AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 30`, [userId]),
  ]);
  if (!u.rows[0]) return null;
  return {
    joinedAt: new Date(u.rows[0].created_at).toISOString(),
    now: now.toISOString(),
    went: went.rows.map((r: any) => ({ itemKey: r.item_key, name: r.item_name, at: new Date(r.created_at).toISOString() })),
    closed: closed.rows.map((r: any) => ({ id: r.id, text: r.text, openedQuote: r.opened_quote, closedQuote: r.closed_quote, at: new Date(r.closed_at).toISOString() })),
    // A failed read: not given (the quotes as the thread's gate checked them).
    ...(lines ? { lines } : {}),
  };
}

// Stores anything new. Moments already older than the announce window are
// stored as marked, so turning this on never sends a backlog.
export async function syncMilestones(userId: string, now = new Date()): Promise<Milestone[]> {
  const src = await loadSource(userId, now);
  if (!src) return [];
  const have = new Set((await loadMilestones(userId)).map((m) => m.key));
  const fresh = deriveMilestones(src).filter((m) => !have.has(m.key));
  if (!fresh.length) return loadMilestones(userId);
  await pool.query(
    `INSERT INTO member_milestones (user_id, key, kind, text, then_quote, now_quote, happened_at, marked_at)
     SELECT $1, k, kd, tx, th, nw, hp::timestamptz, CASE WHEN $8::timestamptz - hp::timestamptz > ($9 || ' days')::interval THEN $8::timestamptz END
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(k, kd, tx, th, nw, hp)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, fresh.map((m) => m.key), fresh.map((m) => m.kind), fresh.map((m) => m.text), fresh.map((m) => m.then), fresh.map((m) => m.now), fresh.map((m) => m.happenedAt), now, String(ANNOUNCE_WITHIN_DAYS)],
  );
  return loadMilestones(userId);
}

export async function markMilestone(userId: string, key: string): Promise<void> {
  await pool.query(`UPDATE member_milestones SET marked_at = NOW() WHERE user_id = $1 AND key = $2`, [userId, key]);
}
