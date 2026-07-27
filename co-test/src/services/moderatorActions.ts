import pool from "../../../api/src/db/db.js";
import { findBestCircle } from "./matching.js";
import { createMomentForCircle } from "./venues.js";

// Ported from api/src/routes/sendblue.ts's Keana-approval-intercept block —
// the actual approve/reject DECISION logic, factored out from the
// classify-by-text framing around it, so both a real inbound text (from
// whoever is acting as Moderator — see webhooks.ts) and the internal
// simulate path (circlesSimulation.ts) run the identical logic. Only the
// trigger differs, per CIRCLES_SCOPING.md's stated goal.
//
// Not ported: Keana-specific notification copy/wording, and full
// booking.ts (confirmMoment's real implementation) — approveVenue below is
// a minimal, complete-enough equivalent (mark confirmed, seed attendees),
// not a byte-for-byte port of booking.ts, which was out of this task's
// scope.

export async function approveCirclePlacement(circleId: string): Promise<{ success: boolean; error?: string }> {
  const result = await pool.query(`UPDATE circles SET status = 'active' WHERE id = $1 RETURNING id`, [circleId]);
  if (!result.rows[0]) return { success: false, error: "Circle not found." };
  return { success: true };
}

// Rejects the circle and attempts one re-match excluding everyone already
// in it — mirrors production's replacement-matching-on-decline. Does not
// auto-create the replacement circle (that's a fresh approveCirclePlacement
// cycle) — just reports whether a viable replacement group was found.
export async function rejectCirclePlacement(
  circleId: string,
): Promise<{ success: boolean; replacementUserIds?: string[]; error?: string }> {
  const circleResult = await pool.query(`SELECT owner_id FROM circles WHERE id = $1`, [circleId]);
  const circle = circleResult.rows[0];
  if (!circle) return { success: false, error: "Circle not found." };

  const memberResult = await pool.query(`SELECT member_id FROM circle_members WHERE circle_id = $1`, [circleId]);
  const allKnownIds: string[] = memberResult.rows.map((r: any) => r.member_id);

  await pool.query(`UPDATE circles SET status = 'rejected' WHERE id = $1`, [circleId]);

  const replacementUserIds = await findBestCircle(circle.owner_id, allKnownIds);
  return { success: true, replacementUserIds: replacementUserIds ?? undefined };
}

// Venue approval — moves the moment from pending_venue_approval straight to
// confirmed and seeds moment_attendees from everyone who's an accepted
// circle member. Real booking.ts (not ported) does more (payment/deposit
// handling per co_venues.payment_tier, real notification copy) — this is
// the minimal complete equivalent needed to prove the pipeline resolves.
export async function approveVenue(momentId: string): Promise<{ success: boolean; error?: string }> {
  const momentResult = await pool.query(`SELECT circle_id FROM moments WHERE id = $1`, [momentId]);
  const moment = momentResult.rows[0];
  if (!moment) return { success: false, error: "Moment not found." };

  await pool.query(`UPDATE moments SET status = 'confirmed' WHERE id = $1`, [momentId]);

  const membersResult = await pool.query(
    `SELECT member_id FROM circle_members WHERE circle_id = $1 AND status = 'accepted'`,
    [moment.circle_id],
  );
  for (const row of membersResult.rows) {
    await pool.query(
      `INSERT INTO moment_attendees (moment_id, attendee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [momentId, row.member_id],
    );
  }

  return { success: true };
}

// Rejects the current venue and re-runs selection excluding it — mirrors
// production's reject-and-reselect path. Kept minimal: re-selects among
// co_venues only (the confirmed decision for this test is seeded venues,
// not live Google Places), so a rejection with no other qualifying seeded
// venue correctly reports failure rather than silently picking nothing.
export async function rejectVenue(momentId: string): Promise<{ success: boolean; error?: string }> {
  const momentResult = await pool.query(
    `SELECT id, circle_id, venue, venue_type, neighborhood, rejected_venues FROM moments WHERE id = $1`,
    [momentId],
  );
  const moment = momentResult.rows[0];
  if (!moment) return { success: false, error: "Moment not found." };

  const rejectedVenues: string[] = [...(moment.rejected_venues ?? []), ...(moment.venue ? [moment.venue] : [])];

  const nextVenue = await pool.query(
    `SELECT * FROM co_venues
     WHERE city = (SELECT city FROM co_profiles cp JOIN circle_members cm ON cm.member_id = cp.user_id WHERE cm.circle_id = $1 LIMIT 1)
     AND type = $2
     AND active = TRUE
     AND NOT (name = ANY($3::text[]))
     ORDER BY RANDOM() LIMIT 1`,
    [moment.circle_id, moment.venue_type, rejectedVenues],
  );

  if (!nextVenue.rows[0]) {
    await pool.query(`UPDATE moments SET status = 'manual_review', rejected_venues = $1 WHERE id = $2`, [
      rejectedVenues,
      momentId,
    ]);
    return { success: false, error: "No alternative seeded venue found." };
  }

  await pool.query(
    `UPDATE moments SET venue = $1, location_name = $2, rejected_venues = $3 WHERE id = $4`,
    [nextVenue.rows[0].name, nextVenue.rows[0].neighborhood, rejectedVenues, momentId],
  );
  return { success: true };
}

// Re-runs the same first-accepter-triggers-the-moment logic production's
// circle-accept branch uses (api/src/routes/sendblue.ts's Step 3.5) —
// factored here so both a real accept-by-text and the simulate path share
// it. Returns the created/existing moment id, or null if this member
// wasn't actually a pending member of this circle.
export async function acceptCircleMembership(
  circleId: string,
  memberId: string,
): Promise<{ success: boolean; momentId?: string; error?: string }> {
  const updateResult = await pool.query(
    `UPDATE circle_members SET status = 'accepted' WHERE circle_id = $1 AND member_id = $2 RETURNING member_id`,
    [circleId, memberId],
  );
  if (!updateResult.rows[0]) return { success: false, error: "Not a pending member of this circle." };

  const existingMoment = await pool.query(
    `SELECT id FROM moments WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [circleId],
  );
  if (existingMoment.rows[0]) {
    await pool.query(`INSERT INTO moment_responses (moment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      existingMoment.rows[0].id,
      memberId,
    ]);
    return { success: true, momentId: existingMoment.rows[0].id };
  }

  const created = await createMomentForCircle(circleId);
  if (!created) return { success: false, error: "createMomentForCircle returned null (no accepted members yet)." };

  // createMomentForCircle is an unmodified port (see venues.ts) and knows
  // nothing about is_simulated — propagate it from the circle explicitly
  // rather than teaching that shared function about a co-test-only concept.
  await pool.query(
    `UPDATE moments SET is_simulated = (SELECT is_simulated FROM circles WHERE id = $1) WHERE id = $2`,
    [circleId, created.moment.id],
  );

  return { success: true, momentId: created.moment.id };
}

export async function declineCircleMembership(circleId: string, memberId: string): Promise<{ success: boolean }> {
  await pool.query(`UPDATE circle_members SET status = 'declined' WHERE circle_id = $1 AND member_id = $2`, [
    circleId,
    memberId,
  ]);
  return { success: true };
}
