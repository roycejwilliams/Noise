// The business numbers (Royce, 2026-09-22: investors want a metric of
// value). Everything here is already in the database; this only counts it.
// Every rate is shown with its counts, so a small sample never passes for a
// trend. Sent weekly with the Monday review (harness/monitor.ts
// runWeeklyReview) and on demand: npm run metrics [-- --days 30].
//
// Not here, on purpose: cost per intro (model spend lives in Langfuse, not
// this database) and venue willingness to pay (that's from conversations,
// not logs).
import pool from "../db/db.js";
import { typesWithPurpose } from "./proactivePurpose.js";

export type Metrics = {
  days: number;
  members: { total: number; newInWindow: number; joinedByInvite: number };
  invites: { issued: number; redeemed: number };
  engagement: { activeLast7: number; retainedEligible: number; retainedActive: number };
  offers: { sent: number; reacted: number; interested: number; notInterested: number; alreadyDid: number };
  outcomes: { acted: number; helped: number; didntHelp: number };
  intros: { inRoomYes: number; inRoomNo: number; introEmails: number; networkIntroduced: number };
  debriefs: { total: number; positive: number; critical: number };
  // The relationship, not the offers (2026-09-22 audit: Co is a companion first).
  relationship: {
    memberStarts: number;
    coStarts: number;
    companionSent: number;
    companionReplied: number;
    offerSent: number;
    offerReplied: number;
    sharedPersonal14d: number;
  };
};

// Real members only: through intake, not archived, not a simulated test user.
const MEMBER = `u.identity_captured = true AND u.archived_at IS NULL AND coalesce(u.is_simulated, false) = false`;

// Below this many, a percentage reads as a trend it isn't, so it's just "n of d".
export const MIN_FOR_PERCENT = 20;

export function rate(n: number, d: number): string {
  if (d <= 0) return "none yet";
  return d < MIN_FOR_PERCENT ? `${n} of ${d}` : `${Math.round((n / d) * 100)}% (${n} of ${d})`;
}

async function one(sql: string, params: unknown[]): Promise<Record<string, number>> {
  const { rows } = await pool.query(sql, params);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rows[0] ?? {})) out[k] = Number(v ?? 0);
  return out;
}

export async function computeMetrics(days = 30): Promise<Metrics> {
  const w = [String(days)];
  const companionTypes = typesWithPurpose("companion");
  const offerTypes = typesWithPurpose("offer");
  const [members, invites, engagement, offers, outcomes, intros, debriefs, starts, replies, shared] = await Promise.all([
    one(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE u.created_at > NOW() - ($1 || ' days')::interval) AS new_in_window,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM invite_codes ic WHERE ic.used_by = u.id AND ic.used_at > NOW() - ($1 || ' days')::interval)) AS joined_by_invite
       FROM users u WHERE ${MEMBER}`,
      w,
    ),
    one(
      `SELECT count(*) FILTER (WHERE created_at > NOW() - ($1 || ' days')::interval) AS issued,
              count(*) FILTER (WHERE used_at > NOW() - ($1 || ' days')::interval) AS redeemed
       FROM invite_codes`,
      w,
    ),
    one(
      `WITH texted AS (
         SELECT m.user_id, max(m.created_at) AS last_at FROM co_memories m
         WHERE m.memory_type = 'text_exchange' AND m.content LIKE 'User %' GROUP BY m.user_id)
       SELECT count(*) FILTER (WHERE t.last_at > NOW() - INTERVAL '7 days') AS active_last7,
              count(*) FILTER (WHERE u.created_at < NOW() - INTERVAL '14 days') AS retained_eligible,
              count(*) FILTER (WHERE u.created_at < NOW() - INTERVAL '14 days' AND t.last_at > NOW() - INTERVAL '14 days') AS retained_active
       FROM users u LEFT JOIN texted t ON t.user_id = u.id WHERE ${MEMBER}`,
      [],
    ),
    one(
      `SELECT count(*) AS sent,
              count(*) FILTER (WHERE ro.reaction IS NOT NULL) AS reacted,
              count(*) FILTER (WHERE ro.reaction = 'interested') AS interested,
              count(*) FILTER (WHERE ro.reaction = 'not_interested') AS not_interested,
              count(*) FILTER (WHERE ro.reaction = 'already_did_it') AS already_did
       FROM revealed_offers ro JOIN users u ON u.id = ro.user_id
       WHERE ro.sent_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}`,
      w,
    ),
    one(
      `SELECT count(*) FILTER (WHERE so.result = 'acted') AS acted,
              count(*) FILTER (WHERE so.result = 'helped') AS helped,
              count(*) FILTER (WHERE so.result = 'didnt_help') AS didnt_help
       FROM suggestion_outcomes so JOIN users u ON u.id = so.user_id
       WHERE so.created_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}`,
      w,
    ),
    one(
      `SELECT (SELECT count(*) FROM event_guest_match_opt_ins o JOIN users u ON u.id = o.person_id WHERE o.status = 'interested' AND o.decided_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}) AS in_room_yes,
              (SELECT count(*) FROM event_guest_match_opt_ins o JOIN users u ON u.id = o.person_id WHERE o.status = 'declined' AND o.decided_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}) AS in_room_no,
              -- Each intro email writes a memory to both people.
              (SELECT count(*) / 2 FROM co_memories m WHERE m.memory_type = 'event_intro_email_sent' AND m.created_at > NOW() - ($1 || ' days')::interval) AS intro_emails,
              (SELECT count(*) FROM network_introductions n WHERE n.introduced_at > NOW() - ($1 || ' days')::interval) AS network_introduced`,
      w,
    ),
    one(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE m.content::jsonb ->> 'outcome' = 'named_positive') AS positive,
              count(*) FILTER (WHERE m.content::jsonb ->> 'outcome' = 'named_critical') AS critical
       FROM co_memories m JOIN users u ON u.id = m.user_id
       WHERE m.memory_type = 'event_checkin_outcome' AND m.created_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}`,
      w,
    ),
    // Who starts the conversation: a member text after 6+ hours of quiet
    // (either side) is them starting it; each proactive pick is Co starting
    // one (a batch sent in the same minute counts once).
    one(
      `WITH t AS (
         SELECT m.user_id, m.created_at, m.content LIKE 'User %' AS from_member,
                LAG(m.created_at) OVER (PARTITION BY m.user_id ORDER BY m.created_at) AS prev_at
         FROM co_memories m JOIN users u ON u.id = m.user_id
         WHERE m.memory_type = 'text_exchange' AND ${MEMBER})
       SELECT (SELECT count(*) FROM t WHERE from_member AND (prev_at IS NULL OR created_at - prev_at > INTERVAL '6 hours')
                 AND created_at > NOW() - ($1 || ' days')::interval) AS member_starts,
              (SELECT count(DISTINCT (ps.user_id, date_trunc('minute', ps.sent_at))) FROM proactive_sends ps JOIN users u ON u.id = ps.user_id
                 WHERE ps.sent_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}) AS co_starts`,
      w,
    ),
    // Replies within a day to what Co sent first, split by what it was for.
    one(
      `WITH picks AS (
         SELECT ps.user_id, date_trunc('minute', ps.sent_at) AS at, min(ps.type) AS type
         FROM proactive_sends ps JOIN users u ON u.id = ps.user_id
         WHERE ps.sent_at > NOW() - ($1 || ' days')::interval AND ${MEMBER}
         GROUP BY ps.user_id, date_trunc('minute', ps.sent_at)),
       answered AS (
         SELECT p.type, EXISTS (
           SELECT 1 FROM co_memories m WHERE m.user_id = p.user_id AND m.memory_type = 'text_exchange' AND m.content LIKE 'User %'
             AND m.created_at > p.at AND m.created_at <= p.at + INTERVAL '24 hours') AS replied
         FROM picks p)
       SELECT count(*) FILTER (WHERE type = ANY($2::text[])) AS companion_sent,
              count(*) FILTER (WHERE type = ANY($2::text[]) AND replied) AS companion_replied,
              count(*) FILTER (WHERE type = ANY($3::text[])) AS offer_sent,
              count(*) FILTER (WHERE type = ANY($3::text[]) AND replied) AS offer_replied
       FROM answered`,
      [String(days), companionTypes, offerTypes],
    ),
    // Shared how something in their life is going, not a request: a feeling
    // about their life (not about Co) read from their own texts or calls.
    one(
      `SELECT count(DISTINCT es.user_id) AS shared FROM emotion_signals es JOIN users u ON u.id = es.user_id
       WHERE es.target = 'life' AND es.basis IS NULL AND es.created_at > NOW() - INTERVAL '14 days' AND ${MEMBER}`,
      [],
    ),
  ]);
  return {
    days,
    members: { total: members.total, newInWindow: members.new_in_window, joinedByInvite: members.joined_by_invite },
    invites: { issued: invites.issued, redeemed: invites.redeemed },
    engagement: { activeLast7: engagement.active_last7, retainedEligible: engagement.retained_eligible, retainedActive: engagement.retained_active },
    offers: { sent: offers.sent, reacted: offers.reacted, interested: offers.interested, notInterested: offers.not_interested, alreadyDid: offers.already_did },
    outcomes: { acted: outcomes.acted, helped: outcomes.helped, didntHelp: outcomes.didnt_help },
    intros: { inRoomYes: intros.in_room_yes, inRoomNo: intros.in_room_no, introEmails: intros.intro_emails, networkIntroduced: intros.network_introduced },
    debriefs: { total: debriefs.total, positive: debriefs.positive, critical: debriefs.critical },
    relationship: {
      memberStarts: starts.member_starts,
      coStarts: starts.co_starts,
      companionSent: replies.companion_sent,
      companionReplied: replies.companion_replied,
      offerSent: replies.offer_sent,
      offerReplied: replies.offer_replied,
      sharedPersonal14d: shared.shared,
    },
  };
}

// One line per metric, in plain words.
export function metricLines(m: Metrics): string[] {
  const optIns = m.intros.inRoomYes + m.intros.inRoomNo;
  return [
    `Members: ${m.members.total} total, ${m.members.newInWindow} new in the last ${m.days} days, ${m.members.joinedByInvite} of them through an invite.`,
    `Invite codes redeemed: ${rate(m.invites.redeemed, m.invites.issued)} of those issued in the window.`,
    `Active (texted Co in the last 7 days): ${rate(m.engagement.activeLast7, m.members.total)} of members.`,
    `Still active after two weeks (joined 14+ days ago, texted in the last 14): ${rate(m.engagement.retainedActive, m.engagement.retainedEligible)}.`,
    `Offers sent: ${m.offers.sent}. Answered: ${rate(m.offers.reacted, m.offers.sent)}. Interested: ${rate(m.offers.interested, m.offers.reacted)} of answers (not interested ${m.offers.notInterested}, already did it ${m.offers.alreadyDid}).`,
    `What came of them: ${m.outcomes.acted} went or applied, ${m.outcomes.helped} said it helped, ${m.outcomes.didntHelp} said it didn't.`,
    `In-room intros: said yes to ${rate(m.intros.inRoomYes, optIns)} of the people Co suggested. Intro emails sent: ${m.intros.introEmails}. Network intros made: ${m.intros.networkIntroduced}.`,
    `Event debriefs: ${m.debriefs.total}, named someone positively in ${rate(m.debriefs.positive, m.debriefs.total)}, critically in ${m.debriefs.critical}.`,
    `Who starts the conversation: members started ${rate(m.relationship.memberStarts, m.relationship.memberStarts + m.relationship.coStarts)} of them; Co started the rest.`,
    `Replies within a day to companion messages (check-ins, reflections, follow-ups about their life): ${rate(m.relationship.companionReplied, m.relationship.companionSent)}.`,
    `Replies within a day to offers (events, openings, intros): ${rate(m.relationship.offerReplied, m.relationship.offerSent)}.`,
    `Shared how something in their life is going in the last 14 days (not an ask): ${rate(m.relationship.sharedPersonal14d, m.members.total)} of members.`,
  ];
}

export function renderMetricsHtml(m: Metrics): string {
  const lines = metricLines(m);
  const relationship = lines.slice(-4);
  const rest = lines.slice(0, -4);
  return [
    `<h3>The relationship (last ${m.days} days)</h3>`,
    `<ul>`,
    ...relationship.map((l) => `<li>${l}</li>`),
    `</ul>`,
    `<h3>Growth, offers and intros</h3>`,
    `<ul>`,
    ...rest.map((l) => `<li>${l}</li>`),
    `</ul>`,
  ].join("\n");
}
