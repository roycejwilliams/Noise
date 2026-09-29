// Advice Co gave, and whether it landed (Royce, 2026-09-29: "we also want to
// see if we can become an advisor"). An advisor remembers what it told you and
// asks how it went. Co records a piece of advice in its own words (a fact about
// what it said, not about the member), and a few days later asks how it went,
// once, through the companion path. What they answer flows into the normal
// thread and learning reads.
//
// Owner-scoped: rows are read and written only with the member's own id.
import pool from "../db/db.js";

export type Advice = { id: number; topic: string; gist: string; givenAt: string; followedUpAt: string | null };

// Follow up after this long, and not after it has gone stale.
export const FOLLOW_UP_AFTER_DAYS = 3;
export const STALE_AFTER_DAYS = 21;
// A follow-up or story text is a companion text, and companion texts wait 4 days
// after the last one (harness/proactive.ts TYPE_POLICY). One queued right after a
// check-in must outlive that wait, or it expires unsent (2026-09-29: queued for
// 4 days, gap of 4 days: never sent). Used for advice follow-ups and story texts.
export const FOLLOW_UP_EXPIRES_DAYS = 7;
// A topic already noted this recently is the same advice, not new.
export const SAME_TOPIC_DAYS = 7;

const dayMs = 86_400_000;
// Words too general to say two pieces of advice are the same thing.
const GENERIC = new Set(["about", "advice", "should", "decision", "their", "thing", "things", "plan", "having"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Pure: is this a topic already noted lately?
export function isRepeat(topic: string, recent: Pick<Advice, "topic" | "givenAt">[], now: Date): boolean {
  const words = (x: string) => norm(x).split(" ").filter((w) => w.length >= 5 && !GENERIC.has(w));
  const mine = words(topic);
  return recent.some((r) => now.getTime() - new Date(r.givenAt).getTime() < SAME_TOPIC_DAYS * dayMs && words(r.topic).some((w) => mine.includes(w)));
}

// Pure: the one to ask about now, if any. Old enough to have been tried, not
// stale, not asked yet.
export function dueAdvice(all: Advice[], now: Date): Advice | null {
  const due = all
    .filter((a) => !a.followedUpAt)
    .filter((a) => {
      const age = now.getTime() - new Date(a.givenAt).getTime();
      return age >= FOLLOW_UP_AFTER_DAYS * dayMs && age <= STALE_AFTER_DAYS * dayMs;
    })
    .sort((a, b) => new Date(b.givenAt).getTime() - new Date(a.givenAt).getTime());
  return due[0] ?? null;
}

// For replies: what Co told them lately, as things Co did.
export function adviceLines(all: Advice[], now = new Date(), limit = 4): string[] {
  return all
    .filter((a) => now.getTime() - new Date(a.givenAt).getTime() <= STALE_AFTER_DAYS * dayMs)
    .slice(0, limit)
    .map((a) => `Co advised them on ${a.givenAt.slice(0, 10)} about ${a.topic}: ${a.gist}${a.followedUpAt ? " (Co has asked how it went)" : ""}`);
}

function rowTo(r: any): Advice {
  return { id: Number(r.id), topic: r.topic, gist: r.gist, givenAt: new Date(r.given_at).toISOString(), followedUpAt: r.followed_up_at ? new Date(r.followed_up_at).toISOString() : null };
}

export async function loadAdvice(userId: string): Promise<Advice[]> {
  const { rows } = await pool.query(`SELECT * FROM member_advice WHERE user_id = $1 AND given_at > NOW() - INTERVAL '30 days' ORDER BY given_at DESC LIMIT 20`, [userId]);
  return rows.map(rowTo);
}

export async function recordAdvice(userId: string, topic: string, gist: string, now = new Date()): Promise<boolean> {
  const t = topic.trim().slice(0, 80);
  const g = gist.trim().slice(0, 300);
  if (t.length < 3 || g.length < 10) return false;
  if (isRepeat(t, await loadAdvice(userId), now)) return false;
  await pool.query(`INSERT INTO member_advice (user_id, topic, gist) VALUES ($1, $2, $3)`, [userId, t, g]);
  return true;
}

export async function markFollowedUp(userId: string, id: number): Promise<void> {
  await pool.query(`UPDATE member_advice SET followed_up_at = NOW() WHERE user_id = $1 AND id = $2`, [userId, id]);
}
