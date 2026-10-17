// The two numbers the raise story needs from day one (Royce, 2026-10-14: "The graph is the moat, and the raise story needs two
// numbers from day one at House of AI: connections that happened that wouldn't have (intro, met, outcome) and 30-day member
// engagement. Define and log both now - measurement, not a member-facing feature").
//
// 1. Connections Cue made: two real members introduced after both said yes, where the introduction was Cue's idea and they weren't
//    already connected. Counted from what is already recorded:
//      - in a room: co_pairs with intro_sent_at, origin 'co' (a pair a member asked for by name is counted apart, not as Cue's)
//      - between events: network_introductions with introduced_at (Cue proposes every one) whose email went: email_sent_at, or
//        made before the send claim existed (2e5c9c13, 2026-10-12); a claim no send confirmed is set when the send is claimed, so it isn't one
//    "Wouldn't have happened": no member_connections row for the pair from before this introduction, and the first introduction of
//    that pair only (a second intro of the same two people is not a new connection). The funnel after it, from co_pairs:
//      met:   met_at (either of them said they met)
//      good:  either of them said it went well (a_outcome or b_outcome = 'met_good')
//    Network introductions record no meeting or outcome yet: their met and good stay unknown (counted apart, never as zero) until
//    the one pair store lands in the double opt-in work.
// 2. 30-day engagement: of members who joined at least 30 days ago, how many wrote to Cue themselves (a text or a voice memo, never a
//    line to a teammate) in the last 30 days, and on how many separate days, as a median.
//
// Real members only: through intake, not archived, not simulated. Logged once a day (metrics.north_star, team-only, no message and
// no email of its own) so the series exists from day one, and shown in the Monday review and in `npm run metrics`.
import pool from "../db/db.js";
import { recordDecision } from "./core.js";
import { notToTeammate } from "../services/teamLines.js";
import { rate } from "./metrics.js";

// Test members use the fictional 555-01xx range (feedback: live tests never use a real number): never counted.
export const TEST_NUMBER = "^\\+1[0-9]{3}55501[0-9]{2}$";
const MEMBER = (alias: string) => `${alias}.identity_captured = true AND ${alias}.archived_at IS NULL AND coalesce(${alias}.is_simulated, false) = false AND ${alias}.phone_number IS NOT NULL AND ${alias}.phone_number !~ '${TEST_NUMBER}'`;

export type NorthStar = {
  days: number;
  connections: {
    // Cue's own introductions in the window: in a room and between events.
    room: number;
    network: number;
    // Of the room ones: met, and went well (network ones: not recorded yet).
    roomMet: number;
    roomGood: number;
    // Introductions a member asked for by name: real, but not Cue's idea.
    memberAsked: number;
  };
  // eligible/active30: members who joined 30+ days ago (the cohort definition). allMembers/allActive30: every member, so a number
  // exists from day one.
  engagement: { eligible: number; active30: number; medianActiveDays: number; allMembers: number; allActive30: number };
};

async function one(sql: string, params: unknown[]): Promise<Record<string, number>> {
  const { rows } = await pool.query(sql, params);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rows[0] ?? {})) out[k] = Number(v ?? 0);
  return out;
}

// The SQL, exported so layer 1 can pin the definitions.
export const ROOM_SQL = `
  WITH first_intro AS (
    SELECT DISTINCT ON (p.a_id, p.b_id) p.*
    FROM co_pairs p
    JOIN users ua ON ua.id = p.a_id JOIN users ub ON ub.id = p.b_id
    WHERE p.intro_sent_at IS NOT NULL AND ${MEMBER("ua")} AND ${MEMBER("ub")}
    ORDER BY p.a_id, p.b_id, p.intro_sent_at)
  SELECT count(*) FILTER (WHERE f.origin = 'co') AS room,
         count(*) FILTER (WHERE f.origin = 'co' AND f.met_at IS NOT NULL) AS room_met,
         count(*) FILTER (WHERE f.origin = 'co' AND (f.a_outcome = 'met_good' OR f.b_outcome = 'met_good')) AS room_good,
         count(*) FILTER (WHERE f.origin = 'member') AS member_asked
  FROM first_intro f
  WHERE f.intro_sent_at > NOW() - ($1 || ' days')::interval
    AND NOT EXISTS (SELECT 1 FROM member_connections mc WHERE mc.person_a = f.a_id AND mc.person_b = f.b_id
                    AND mc.created_at < COALESCE(f.both_yes_at, f.intro_sent_at) - INTERVAL '1 minute')`;

export const NETWORK_SQL = `
  SELECT count(*) AS network
  FROM network_introductions n
  JOIN users ua ON ua.id = n.person_a_id JOIN users ub ON ub.id = n.person_b_id
  WHERE n.introduced_at IS NOT NULL AND (n.email_sent_at IS NOT NULL OR n.email_claimed_at IS NULL) AND n.introduced_at > NOW() - ($1 || ' days')::interval AND ${MEMBER("ua")} AND ${MEMBER("ub")}
    AND NOT EXISTS (SELECT 1 FROM member_connections mc WHERE mc.person_a = n.person_a_id AND mc.person_b = n.person_b_id
                    AND mc.created_at < n.introduced_at - INTERVAL '1 minute')
    AND NOT EXISTS (SELECT 1 FROM co_pairs p WHERE p.a_id = n.person_a_id AND p.b_id = n.person_b_id AND p.intro_sent_at < n.introduced_at)`;

export const ENGAGEMENT_SQL = `
  WITH members AS (SELECT u.id, u.created_at <= NOW() - INTERVAL '30 days' AS eligible FROM users u WHERE ${MEMBER("u")}),
       days AS (
         SELECT m.user_id, count(DISTINCT date_trunc('day', m.created_at)) AS active_days
         FROM co_memories m JOIN members e ON e.id = m.user_id
         WHERE m.memory_type = 'text_exchange' AND (m.content LIKE 'User said:%' OR m.content LIKE 'User sent a voice memo:%')
           AND ${notToTeammate("m")} AND m.created_at > NOW() - INTERVAL '30 days'
         GROUP BY m.user_id)
  SELECT (SELECT count(*) FROM members WHERE eligible) AS eligible,
         (SELECT count(*) FROM days d JOIN members e ON e.id = d.user_id WHERE e.eligible) AS active30,
         COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(d.active_days, 0))
                   FROM members e LEFT JOIN days d ON d.user_id = e.id WHERE e.eligible), 0) AS median_active_days,
         (SELECT count(*) FROM members) AS all_members,
         (SELECT count(*) FROM days) AS all_active30`;

export async function computeNorthStar(days = 30): Promise<NorthStar> {
  const w = [String(days)];
  const [room, network, eng] = await Promise.all([one(ROOM_SQL, w), one(NETWORK_SQL, w), one(ENGAGEMENT_SQL, [])]);
  return {
    days,
    connections: { room: room.room, network: network.network, roomMet: room.room_met, roomGood: room.room_good, memberAsked: room.member_asked },
    engagement: { eligible: eng.eligible, active30: eng.active30, medianActiveDays: eng.median_active_days, allMembers: eng.all_members, allActive30: eng.all_active30 },
  };
}

// Pure: the two numbers, in plain words. A rate always carries its counts.
export function northStarLines(n: NorthStar): string[] {
  const c = n.connections;
  const made = c.room + c.network;
  return [
    `Connections Cue made (last ${n.days} days, both said yes, Cue's idea, not already connected): ${made} (${c.room} in a room, ${c.network} between events). Of the room ones, met: ${rate(c.roomMet, c.room)}; went well: ${rate(c.roomGood, c.room)}. Between-events meetings aren't recorded yet.${c.memberAsked ? ` Plus ${c.memberAsked} a member asked for by name (not counted as Cue's).` : ""}`,
    `30-day engagement (members who joined 30+ days ago and wrote to Cue in the last 30): ${rate(n.engagement.active30, n.engagement.eligible)}; median active days: ${n.engagement.medianActiveDays}. All members, any join date: ${rate(n.engagement.allActive30, n.engagement.allMembers)} wrote in the last 30 days.`,
  ];
}

export function renderNorthStarHtml(n: NorthStar): string {
  return [`<h3>The two numbers</h3>`, `<ul>`, ...northStarLines(n).map((l) => `<li>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`), `</ul>`].join("\n");
}

// Once a day: the numbers as they stand, so the series exists from day one. Team-only; no message, no email.
export async function recordNorthStar(now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const [done] = (await pool.query(`SELECT 1 FROM harness_decisions WHERE decision = 'metrics.north_star' AND proposal->>'day' = $1 LIMIT 1`, [day])).rows;
  if (done) return;
  const [d30, all] = await Promise.all([computeNorthStar(30), computeNorthStar(3650)]);
  await recordDecision({ layer: 7, decision: "metrics.north_star", userId: null, outcome: "act", action: "snapshot", proposal: { day, last30: d30, allTime: all } });
}
