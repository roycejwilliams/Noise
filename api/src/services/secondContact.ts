// Second contact (Royce, 2026-10-11, the outcome number for investors: "X% of Co introductions lead to a second meeting"). When a
// member tells Co they saw or talked with someone Co introduced them to again, or that they haven't, Co records it (the
// noteMetAgain tool, agent/conversationTools.ts): one fact in THEIR record (co_facts, owner-only), never told to the other person and
// never a claim about the other side. The metric counts intros whose email went (member_connections) and the ones either side says
// led to meeting or talking again within SECOND_CONTACT_DAYS.
import pool from "../db/db.js";

export const SECOND_CONTACT_DAYS = 30;
export const SECOND_CONTACT_RELATION = "second_contact";
export const OUTCOMES = ["met_again", "talked_again", "not_yet", "not_going_to"] as const;
export type SecondContactOutcome = (typeof OUTCOMES)[number];
export const MET = new Set<SecondContactOutcome>(["met_again", "talked_again"]);

export type Introduced = { otherId: string; firstName: string; introducedAt: Date };

// The people Co introduced this member to (the email went), newest first. Archived members are left out (never named back).
export async function introducedTo(userId: string): Promise<Introduced[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name, c.created_at FROM member_connections c
       JOIN users u ON u.id = CASE WHEN c.person_a = $1 THEN c.person_b ELSE c.person_a END
     WHERE (c.person_a = $1 OR c.person_b = $1) AND u.archived_at IS NULL ORDER BY c.created_at DESC LIMIT 50`,
    [userId],
  );
  return rows.map((r: any) => ({ otherId: String(r.id), firstName: String(r.first_name ?? "").trim(), introducedAt: new Date(r.created_at) })).filter((r) => r.firstName);
}

// Pure: which intro they mean, by first name. Null when none or more than one fits (Co asks which).
export function pickIntro(list: Introduced[], name: string): Introduced | null | "ambiguous" {
  const first = String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first) return null;
  const hits = list.filter((i) => i.firstName.toLowerCase() === first);
  if (hits.length > 1 && new Set(hits.map((h) => h.otherId)).size > 1) return "ambiguous";
  return hits[0] ?? null;
}

// Pure: the fact's label, in the member's record. Their side only.
export function secondContactLabel(firstName: string, outcome: SecondContactOutcome, on: Date): string {
  const day = on.toISOString().slice(0, 10);
  const what = { met_again: `Saw ${firstName} again`, talked_again: `Talked with ${firstName} again`, not_yet: `Hasn't seen ${firstName} again yet`, not_going_to: `Doesn't plan to see ${firstName} again` }[outcome];
  return `${what} (said ${day}; Co introduced them)`;
}

export async function recordSecondContact(userId: string, intro: Introduced, outcome: SecondContactOutcome, note: string | null, now = new Date()): Promise<void> {
  const { recordFactChecked } = await import("./coFacts.js");
  await recordFactChecked({
    ownerUserId: userId, subject: "member", relation: SECOND_CONTACT_RELATION, label: secondContactLabel(intro.firstName, outcome, now), visibility: "owner",
    source: "noteMetAgain", happenedAt: now,
    meta: { otherId: intro.otherId, introducedAt: intro.introducedAt.toISOString(), outcome, note: note?.slice(0, 200) ?? null },
  });
}

// The investor number. intros: emails that went in the window, old enough to have had SECOND_CONTACT_DAYS (or all, with
// includeRecent). answered: either side told Co. metAgain: either side said they met or talked again within the window of the intro.
export async function secondContactRate(o: { sinceDays?: number; includeRecent?: boolean } = {}): Promise<{ intros: number; answered: number; metAgain: number; rate: number | null; answeredRate: number | null }> {
  const { rows } = await pool.query(
    `WITH intros AS (
       SELECT person_a, person_b, created_at FROM member_connections
       WHERE created_at > NOW() - make_interval(days => $1) AND ($2::boolean OR created_at < NOW() - make_interval(days => $3))
     ), said AS (
       SELECT i.person_a, i.person_b,
              bool_or(f.meta->>'outcome' IN ('met_again', 'talked_again') AND f.happened_at <= i.created_at + make_interval(days => $3)) AS met,
              count(f.*) > 0 AS answered
       FROM intros i
       LEFT JOIN co_facts f ON f.relation = $4 AND f.retired_at IS NULL
         AND ((f.owner_user_id = i.person_a AND f.meta->>'otherId' = i.person_b::text) OR (f.owner_user_id = i.person_b AND f.meta->>'otherId' = i.person_a::text))
       GROUP BY i.person_a, i.person_b
     )
     SELECT count(*)::int AS intros, count(*) FILTER (WHERE answered)::int AS answered, count(*) FILTER (WHERE met)::int AS met FROM said`,
    [o.sinceDays ?? 180, !!o.includeRecent, SECOND_CONTACT_DAYS, SECOND_CONTACT_RELATION],
  );
  const r = rows[0] ?? { intros: 0, answered: 0, met: 0 };
  return { intros: r.intros, answered: r.answered, metAgain: r.met, rate: r.intros ? r.met / r.intros : null, answeredRate: r.answered ? r.met / r.answered : null };
}
