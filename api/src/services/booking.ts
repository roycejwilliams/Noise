// Shared helpers for the circle-to-moment scheduling flow, used by both the
// consensus/auto-approve crons (jobs/index.ts) and the Keana reply intercept
// (routes/sendblue.ts) so venue/time approval and final confirmation go
// through one code path regardless of whether they're triggered by a text
// reply or a cron timeout. There is no reservation step here — Co arranges
// the group and the venue, nobody secures a table on the app's behalf.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { getVenueContactInfo } from "./places.js";
import sendblue from "./sendblue.js";

export type BookingMoment = {
  id: string;
  circle_id: string;
  moments_name?: string;
  venue: string | null;
  venue_booking_url: string | null;
  venue_place_id: string | null;
  suggested_time?: string | null;
  moment_start: string;
  // Co's own self-rated fit for the selected venue (0-1, see
  // scoreVenuesWithCo in places.ts) and whether the consensus cron had to
  // force-lock a time window at the 48hr cutoff without a real majority.
  // Both feed requestVenueApprovalFromKeana's low-confidence gate below.
  venue_fit_score?: number | null;
  consensus_low_confidence?: boolean;
};

// A venue Co isn't confident fits is a low-confidence placement just like a
// borderline circle score — see LOW_CONFIDENCE_GROUP_SCORE in matching.ts.
export const LOW_CONFIDENCE_VENUE_FIT_SCORE = 0.6;

// Sends Keana the selected venue for approval and gates the moment on her
// reply — same approve/reject-by-text pattern already used for circle
// placement (co.ts's /place route + sendblue.ts's Keana intercept), just for
// venue+time choice instead of circle membership. Her approval is the last
// gate before the group is told it's happening — see confirmMoment below.
//
// Low confidence (weak venue fit and/or a time window forced at the 48hr
// consensus cutoff without a real majority) must never silently auto-approve
// — the venue auto-approve cron in jobs/index.ts checks requires_moderator_reply
// before sweeping a stale item, and re-pings instead of approving it.
export async function requestVenueApprovalFromKeana(moment: BookingMoment): Promise<void> {
  const lowFit = moment.venue_fit_score != null && moment.venue_fit_score < LOW_CONFIDENCE_VENUE_FIT_SCORE;
  const forcedWithoutMajority = !!moment.consensus_low_confidence;
  const lowConfidence = lowFit || forcedWithoutMajority;

  let confidenceNote: string | null = null;
  if (lowFit && forcedWithoutMajority) {
    confidenceNote = `Low venue fit (${moment.venue_fit_score!.toFixed(2)}) and no clear majority on timing.`;
  } else if (lowFit) {
    confidenceNote = `Low venue fit (${moment.venue_fit_score!.toFixed(2)}).`;
  } else if (forcedWithoutMajority) {
    confidenceNote = `Locked in at the 48hr cutoff without a clear majority.`;
  }

  const base = `Venue selected for moment "${moment.moments_name ?? moment.id}": ${moment.venue ?? "TBD"}, suggested ${moment.suggested_time ?? "TBD"}.`;
  const message = lowConfidence
    ? `${base} ${confidenceNote} This one needs your call — reply APPROVE or REJECT, no auto-approval.`
    : `${base} Reply APPROVE or REJECT within 4 hours — Co will auto-approve if no response.`;

  try {
    await sendblue.messages.send({
      number: process.env.KEANA_PHONE_NUMBER!,
      content: message,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error(`Failed to notify Keana of venue approval for moment ${moment.id}:`, err?.message ?? err);
  }

  await pool.query(
    `UPDATE moments
     SET status = 'pending_venue_approval', keana_venue_notified_at = NOW(),
         requires_moderator_reply = $2, confidence_note = $3
     WHERE id = $1`,
    [moment.id, lowConfidence, confidenceNote],
  );
}

// Called once Keana approves the venue/time (by reply or the 4hr
// auto-approve timeout) — the last step. No reservation, no Connector: this
// just marks the moment confirmed, seeds attendees, and tells every member
// individually (CoPatible has no group chat) that it's happening, with the
// venue's real contact info attached if Places has it.
export async function confirmMoment(moment: BookingMoment, io?: Server): Promise<void> {
  await pool.query(`UPDATE moments SET status = 'confirmed' WHERE id = $1`, [moment.id]);

  // Anyone with a moment_response (i.e. was actually polled) gets an
  // attendee row so check-in works.
  await pool.query(
    `INSERT INTO moment_attendees (moment_id, attendee_id)
     SELECT moment_id, user_id FROM moment_responses
     WHERE moment_id = $1
     ON CONFLICT DO NOTHING`,
    [moment.id],
  );

  const dateStr = new Date(moment.moment_start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const timeStr = new Date(moment.moment_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  let confirmedMsg = `You're confirmed. ${moment.venue ?? moment.moments_name} on ${dateStr} at ${timeStr}. Co will send details closer to the day.`;
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `You are Co. A moment just got confirmed: ${moment.venue ?? moment.moments_name} on ${dateStr} at ${timeStr}. Text confirming it's locked in, in your own words — not a template. No exclamation points, no em dashes. 1-2 sentences.`,
    });
    confirmedMsg = text;
  } catch (genErr: any) {
    console.error("Confirmation message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
  }

  // Real Maps link/phone for attendees heading there — appended as a plain
  // line rather than left to the generated text, so it's never invented or
  // dropped.
  if (moment.venue_place_id) {
    const { phone, mapsUrl } = await getVenueContactInfo(moment.venue_place_id);
    const extra = [mapsUrl ? `Directions: ${mapsUrl}` : "", phone ? `Venue: ${phone}` : ""]
      .filter(Boolean)
      .join(" · ");
    if (extra) confirmedMsg = `${confirmedMsg}\n${extra}`;
  }

  const members = await pool.query(
    `SELECT u.id, u.phone_number FROM moment_responses mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.moment_id = $1`,
    [moment.id],
  );
  for (const member of members.rows) {
    try {
      await sendblue.messages.send({
        number: member.phone_number,
        content: confirmedMsg,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (smsErr: any) {
      console.error(`Confirmation message failed for ${member.id}:`, smsErr?.message ?? smsErr);
    }
  }

  io?.to(`moment:${moment.id}`).emit("moment:confirmed", { moment_id: moment.id });
}
