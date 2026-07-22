// Shared helpers for the circle-to-moment booking flow, used by both the
// consensus/timeout crons (jobs/index.ts) and the Keana reply intercept
// (routes/sendblue.ts) so venue approval and Connector reassignment go
// through one code path regardless of whether they're triggered by a text
// reply or a cron timeout.
import pool from "../db/db.js";
import { getVenueContactInfo } from "./places.js";
import sendblue from "./sendblue.js";

export type ConnectorContact = { id: string; phone_number: string; first_name: string };

export type BookingMoment = {
  id: string;
  circle_id: string;
  moments_name?: string;
  venue: string | null;
  venue_booking_url: string | null;
  venue_place_id: string | null;
  suggested_time?: string | null;
  tried_connector_ids?: string[] | null;
};

// Promotes the next untried circle member (by trust_score) to
// is_circle_connector — demoting whoever currently holds it, if anyone — and
// records them on the moment's tried_connector_ids so this moment's
// reassignment loop never retries the same person twice. Returns null once
// every circle member has already been tried.
export async function assignNextConnector(
  momentId: string,
  circleId: string,
  triedConnectorIds: string[],
): Promise<ConnectorContact | null> {
  const candidate = await pool.query(
    `SELECT u.id, u.phone_number, u.first_name
     FROM circle_members cm
     JOIN users u ON u.id = cm.member_id
     JOIN co_profiles cp ON cp.user_id = cm.member_id
     WHERE cm.circle_id = $1 AND NOT (u.id = ANY($2::uuid[]))
     ORDER BY cp.trust_score DESC
     LIMIT 1`,
    [circleId, triedConnectorIds],
  );
  const connector = candidate.rows[0];
  if (!connector) return null;

  await pool.query(
    `UPDATE co_profiles SET is_circle_connector = FALSE
     WHERE user_id IN (SELECT member_id FROM circle_members WHERE circle_id = $1)`,
    [circleId],
  );
  await pool.query(`UPDATE co_profiles SET is_circle_connector = TRUE WHERE user_id = $1`, [connector.id]);
  await pool.query(
    `UPDATE moments SET tried_connector_ids = array_append(tried_connector_ids, $1) WHERE id = $2`,
    [connector.id, momentId],
  );

  return connector;
}

// Texts the assigned Connector the venue/phone/booking-link and locks the
// moment in. Resets connector_nudge_sent_at so the 4hr-nudge/8hr-escalate
// cron starts its clock fresh — this fires both for the first assignment and
// every reassignment.
export async function textConnectorBookingTask(
  moment: BookingMoment,
  connector: ConnectorContact,
): Promise<void> {
  let bookingDetails = "";
  if (moment.venue_place_id) {
    const { phone } = await getVenueContactInfo(moment.venue_place_id);
    const bookingLink = moment.venue_booking_url;
    bookingDetails = [
      moment.venue ? ` ${moment.venue}.` : "",
      phone ? ` Call ${phone}` : "",
      phone && bookingLink ? " or" : "",
      bookingLink ? ` book at ${bookingLink}` : "",
    ].join("");
  }

  try {
    await sendblue.messages.send({
      number: connector.phone_number,
      content: `${connector.first_name}, your circle is confirmed.${bookingDetails} Once it's booked, text me "Booked!" and I'll let everyone know.`,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (smsErr: any) {
    console.error(`Booking-link message failed for ${connector.id}:`, smsErr?.message ?? smsErr);
  }

  await pool.query(
    `UPDATE moments SET status = 'consensus_locked', booking_link_sent_at = NOW(), connector_nudge_sent_at = NULL WHERE id = $1`,
    [moment.id],
  );
}

// Called once a venue is approved (by Keana's reply or the 4hr auto-approve
// timeout) and whenever the current Connector needs to be replaced. Prefers
// whichever circle member already holds is_circle_connector; if nobody does
// (or they've already been tried on this moment), promotes the next untried
// top-trust member. Only once the whole circle has been tried does this hit
// the genuine last-resort: escalate to Keana for manual booking.
export async function proceedToConnectorBooking(moment: BookingMoment): Promise<void> {
  const triedIds = moment.tried_connector_ids ?? [];

  const existing = await pool.query(
    `SELECT u.id, u.phone_number, u.first_name
     FROM circle_members cm
     JOIN users u ON u.id = cm.member_id
     JOIN co_profiles cp ON cp.user_id = cm.member_id
     WHERE cm.circle_id = $1 AND cp.is_circle_connector = TRUE AND NOT (u.id = ANY($2::uuid[]))
     LIMIT 1`,
    [moment.circle_id, triedIds],
  );

  let connector: ConnectorContact | null = existing.rows[0] ?? null;
  if (connector) {
    await pool.query(
      `UPDATE moments SET tried_connector_ids = array_append(tried_connector_ids, $1) WHERE id = $2`,
      [connector.id, moment.id],
    );
  } else {
    connector = await assignNextConnector(moment.id, moment.circle_id, triedIds);
  }

  if (!connector) {
    try {
      await sendblue.messages.send({
        number: process.env.KEANA_PHONE_NUMBER!,
        content: `No one left in the circle to assign booking for moment ${moment.id}. Needs manual booking.`,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (err: any) {
      console.error(`Manual-booking escalation to Keana failed for moment ${moment.id}:`, err?.message ?? err);
    }
    await pool.query(`UPDATE moments SET status = 'manual_booking_required' WHERE id = $1`, [moment.id]);
    return;
  }

  await textConnectorBookingTask(moment, connector);
}

// Sends Keana the selected venue for approval and gates the moment on her
// reply — same approve/reject-by-text pattern already used for circle
// placement (co.ts's /place route + sendblue.ts's Keana intercept), just for
// venue choice instead of circle membership.
export async function requestVenueApprovalFromKeana(moment: BookingMoment): Promise<void> {
  try {
    await sendblue.messages.send({
      number: process.env.KEANA_PHONE_NUMBER!,
      content: `Venue selected for moment "${moment.moments_name ?? moment.id}": ${moment.venue ?? "TBD"}, suggested ${moment.suggested_time ?? "TBD"}. Reply APPROVE or REJECT within 4 hours — Co will auto-approve if no response.`,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error(`Failed to notify Keana of venue approval for moment ${moment.id}:`, err?.message ?? err);
  }

  await pool.query(
    `UPDATE moments SET status = 'pending_venue_approval', keana_venue_notified_at = NOW() WHERE id = $1`,
    [moment.id],
  );
}
