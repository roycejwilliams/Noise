import cron from "node-cron";
import twilio from "twilio";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import sendblue from "../services/sendblue.js";
import { activateCircle, retryCircleModeratorNotification } from "../services/circleApproval.js";
import { confirmMoment, retryVenueApprovalNotification } from "../services/booking.js";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

export function registerJobs(io: Server) {
  // Every 15 min — moment reminders (1-hour pre-event window)
  cron.schedule("*/15 * * * *", async () => {
    try {
      const windowStart = new Date(Date.now() + 55 * 60 * 1000).toISOString();
      const windowEnd = new Date(Date.now() + 69 * 60 * 1000).toISOString();

      const upcoming = await pool.query(
        `SELECT m.id AS moment_id, m.moments_name, m.location_name, m.moment_start, ia.attendee_id
         FROM moments m
         JOIN invite_attendees ia ON m.id = ia.moment_id
         WHERE m.moment_start >= $1
         AND m.moment_start < $2
         AND ia.status = 'accepted'
         AND m.close_moment IS NOT TRUE`,
        [windowStart, windowEnd],
      );

      for (const row of upcoming.rows) {
        const attendee = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [row.attendee_id],
        );
        if (!attendee.rows[0]) continue;

        const time = new Date(row.moment_start).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        const momentUrl = `https://app.copatible.com/moments/${row.moment_id}`;

        await sendEmail({
          email: attendee.rows[0].email,
          moment_reminder: {
            moments_name: row.moments_name,
            location_name: row.location_name,
            time,
          },
          action_url: momentUrl,
        });
        await sendSMS({
          phone_number: attendee.rows[0].phone_number,
          moment_reminder: {
            moments_name: row.moments_name,
            location_name: row.location_name,
            time,
          },
          action_url: momentUrl,
        });
      }
    } catch (error) {
      console.error("Reminder cron error:", error);
    }
  });

  // Daily at 10 AM — pending invite nudges
  cron.schedule("0 10 * * *", async () => {
    try {
      const yesterday = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();

      const pendingMoments = await pool.query(
        `SELECT ia.attendee_id, ia.moment_id, m.moments_name, m.moment_start
         FROM invite_attendees ia
         JOIN moments m ON ia.moment_id = m.id
         WHERE ia.status = 'pending'
         AND ia.created_at <= $1
         AND m.moment_start > NOW()`,
        [yesterday],
      );

      for (const row of pendingMoments.rows) {
        const attendee = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [row.attendee_id],
        );
        if (!attendee.rows[0]) continue;

        const time = new Date(row.moment_start).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        const momentUrl = `https://app.copatible.com/moments/${row.moment_id}`;

        await sendEmail({
          email: attendee.rows[0].email,
          moment_invite_reminder: { moments_name: row.moments_name, time },
          action_url: momentUrl,
        });
        await sendSMS({
          phone_number: attendee.rows[0].phone_number,
          moment_invite_reminder: { moments_name: row.moments_name, time },
          action_url: momentUrl,
        });
      }

      const pendingCircles = await pool.query(
        `SELECT im.member_id, im.circle_id, c.circle_name
         FROM invite_members im
         JOIN circles c ON im.circle_id = c.id
         WHERE im.status = 'pending'
         AND im.create_at <= $1`,
        [yesterday],
      );

      for (const row of pendingCircles.rows) {
        const member = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [row.member_id],
        );
        if (!member.rows[0]) continue;

        const circleUrl = `https://app.copatible.com/join?circle=${row.circle_id}`;

        await sendEmail({
          email: member.rows[0].email,
          circle_invite_reminder: { circle_name: row.circle_name },
          action_url: circleUrl,
        });
        await sendSMS({
          phone_number: member.rows[0].phone_number,
          circle_invite_reminder: { circle_name: row.circle_name },
          action_url: circleUrl,
        });
      }
    } catch (error) {
      console.error("Invite reminder cron error:", error);
    }
  });

  // Every 15 min — consensus threshold + 48hr cutoff
  cron.schedule("*/15 * * * *", async () => {
    try {
      const pollingMoments = await pool.query(
        `SELECT m.id, m.circle_id, m.moments_name, m.venue, m.venue_booking_url, m.venue_place_id,
                m.suggested_time, m.moment_start, m.created_at, m.consensus_nudge_sent_at
         FROM moments m
         JOIN circles c ON c.id = m.circle_id
         WHERE m.status = 'polling'
         AND c.status = 'active'
         AND EXISTS (SELECT 1 FROM moment_responses mr WHERE mr.moment_id = m.id)`,
      );

      for (const moment of pollingMoments.rows) {
        const responsesResult = await pool.query(
          `SELECT mr.user_id, mr.response, u.phone_number, u.first_name
           FROM moment_responses mr
           JOIN users u ON u.id = mr.user_id
           WHERE mr.moment_id = $1`,
          [moment.id],
        );
        const responses = responsesResult.rows;
        const total = responses.length;
        if (total === 0) continue;

        const yesCount = responses.filter(
          (r: any) => r.response === "yes",
        ).length;
        const thresholdMet = yesCount * 2 > total;

        const hoursSinceCreated =
          (Date.now() - new Date(moment.created_at).getTime()) /
          (1000 * 60 * 60);
        const past48hrs = hoursSinceCreated >= 48;

        if (!thresholdMet && !past48hrs) continue;

        if (past48hrs && !moment.consensus_nudge_sent_at) {
          const nonResponders = responses.filter(
            (r: any) => r.response === null,
          );
          for (const nr of nonResponders) {
            // Unlike every other Sendblue send in this codebase, this one
            // had no try/catch — an undeliverable number (confirmed: a
            // fictional seed number, but any real delivery failure works
            // the same way) threw here, aborted this iteration of the outer
            // loop, and skipped the consensus_nudge_sent_at UPDATE below.
            // With that guard column never set, the next run 15 minutes
            // later saw the exact same unmet condition and repeated the
            // same throw — confirmed via Sendblue's own log: the same
            // message re-sent every 15 minutes for over 3 weeks against one
            // moment. A delivery failure must never block this loop or the
            // guard-column write that stops it from re-running.
            try {
              await sendblue.messages.send({
                number: nr.phone_number,
                content: `${nr.first_name}, your circle's moment has been locked. Reply YES or suggest a time for future moments.`,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Consensus nudge failed for ${nr.user_id} (non-fatal):`, smsErr?.message ?? smsErr);
            }
            await pool.query(
              `UPDATE co_profiles SET trust_score = GREATEST(0, trust_score - 5) WHERE user_id = $1`,
              [nr.user_id],
            );
          }
          await pool.query(
            `UPDATE moments SET consensus_nudge_sent_at = NOW() WHERE id = $1`,
            [moment.id],
          );
        }

        // No Circle Connector step anymore — once consensus is reached (or
        // forced at the 48hr cutoff), Co confirms and locks in the moment
        // directly (booking.ts's confirmMoment), no human booking task.
        await confirmMoment(
          {
            id: moment.id,
            circle_id: moment.circle_id,
            moments_name: moment.moments_name,
            venue: moment.venue,
            venue_booking_url: moment.venue_booking_url,
            venue_place_id: moment.venue_place_id,
            suggested_time: moment.suggested_time,
            moment_start: moment.moment_start,
          },
          io,
        );
      }
    } catch (error) {
      console.error("Consensus cron error:", error);
    }
  });

  // Hourly 10am–8pm UTC — call newly subscribed users who haven't completed intake yet.
  // Limits to 5 calls per run to avoid Twilio rate limits.
  // Won't retry a user who had a call attempt in the last 24 hours.
  cron.schedule("0 10-20 * * *", async () => {
    try {
      const uncalled = await pool.query(
        `SELECT u.id, u.first_name, u.phone_number, cp.hume_chat_group_id
         FROM users u
         LEFT JOIN co_profiles cp ON cp.user_id = u.id
         WHERE u.subscription_status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM co_memories cm
             WHERE cm.user_id = u.id
               AND cm.memory_type = 'call_transcript'
               AND cm.created_at > NOW() - INTERVAL '24 hours'
           )
           AND (
             cp.user_id IS NULL
             OR cp.life_chapters IS NULL
             OR array_length(cp.life_chapters, 1) IS NULL
           )
         LIMIT 5`,
      );

      for (const user of uncalled.rows) {
        try {
          // Same media-stream bridge as co.ts's POST /co/call/:user_id
          // instead of Hume's direct /v0/evi/twilio bridge — that endpoint
          // only accepts config_id/api_key as query params, so
          // first_name/context_summary never actually reached Hume through
          // it. user_id travels as a <Parameter>, not a query string —
          // Twilio strips query params from Stream URLs entirely (confirmed
          // live against co-test, and via Twilio's own docs).
          const mediaStreamUrl = `${process.env.API_URL!.replace(/^http/, "ws")}/media-stream`;
          const twiml = new twilio.twiml.VoiceResponse();
          const stream = twiml.connect().stream({ url: mediaStreamUrl });
          stream.parameter({ name: "user_id", value: user.id });

          const statusCallbackUrl = `${process.env.API_URL}/co/call-status`;
          const call = await twilioClient.calls.create({
            to: user.phone_number,
            from: process.env.TWILIO_PHONE_NUMBER!,
            twiml: twiml.toString(),
            statusCallback: statusCallbackUrl,
            statusCallbackEvent: ["completed"],
            statusCallbackMethod: "POST",
            // Without this, a voicemail pickup looks identical to a human
            // answering and Co starts talking into a machine — same AMD
            // setup as co.ts's POST /co/call/:user_id, missing here before
            // (this cron had its own independent call-placing copy that
            // never got it). Must be async — sync AMD holds the call in
            // silence until detection finishes.
            machineDetection: "DetectMessageEnd",
            machineDetectionTimeout: 10,
            asyncAmd: "true",
            asyncAmdStatusCallback: statusCallbackUrl,
            asyncAmdStatusCallbackMethod: "POST",
          });

          // Source of truth for /co/webhook's voicemail-skip check.
          await pool.query(`UPDATE users SET call_sid = $2 WHERE id = $1`, [user.id, call.sid]);

          const attemptContent = `Co initiated call to ${user.first_name} — call_sid: ${call.sid}`;
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_transcript', $2)`,
            [user.id, attemptContent],
          );
        } catch (callErr: any) {
          console.error(`Auto-call failed for user ${user.id}:`, callErr?.message ?? callErr);
        }
      }
    } catch (err) {
      console.error("Auto-call cron error:", err);
    }
  });

  // Circle Connector concept removed — Co now confirms/locks in moments
  // directly (see the consensus cron above, confirmMoment). The connector-
  // timeout escalation cron that used to live here (4hr nudge → 8hr escalate
  // to the Moderator + demote trust_score) is gone along with it; no moment
  // reaches 'consensus_locked' anymore for it to have acted on.

  // Every 30 min — auto-approve any circle placement or venue selection the
  // Moderator hasn't responded to within 4 hours (low-confidence items that
  // require her explicit reply are excluded — see requires_moderator_reply).
  cron.schedule("*/30 * * * *", async () => {
    try {
      const staleCircles = await pool.query(
        `SELECT id, circle_name FROM circles
         WHERE status = 'pending_approval'
           AND requires_moderator_reply = false
           AND moderator_notified_at IS NOT NULL
           AND moderator_notified_at < NOW() - INTERVAL '4 hours'`,
      );
      for (const circle of staleCircles.rows) {
        await activateCircle({ circleId: circle.id, circleName: circle.circle_name, io });
      }

      const staleVenues = await pool.query(
        `SELECT id, circle_id, moments_name, venue, venue_booking_url, venue_place_id, suggested_time, moment_start
         FROM moments
         WHERE status = 'pending_venue_approval'
           AND requires_moderator_reply = false
           AND moderator_venue_notified_at IS NOT NULL
           AND moderator_venue_notified_at < NOW() - INTERVAL '4 hours'`,
      );
      for (const moment of staleVenues.rows) {
        await confirmMoment(moment, io);
      }
    } catch (error) {
      console.error("Moderator auto-approve sweep error:", error);
    }
  });

  // Every 15 min — retry the Moderator notification for any circle or venue
  // approval whose initial send never actually landed (moderator_notified_at
  // / moderator_venue_notified_at only ever get stamped on a genuine
  // success — see circleApproval.ts/booking.ts) — without this, a Sendblue
  // outage at notify-time would leave the item stuck, invisible to both the
  // Moderator and the auto-approve sweep above (which requires the
  // notified_at timestamp to even consider something stale).
  cron.schedule("*/15 * * * *", async () => {
    try {
      const unsentCircles = await pool.query(
        `SELECT id FROM circles WHERE status = 'pending_approval' AND moderator_notified_at IS NULL`,
      );
      for (const circle of unsentCircles.rows) {
        await retryCircleModeratorNotification(circle.id);
      }

      const unsentVenues = await pool.query(
        `SELECT id, moments_name, venue, suggested_time, requires_moderator_reply, confidence_note
         FROM moments WHERE status = 'pending_venue_approval' AND moderator_venue_notified_at IS NULL`,
      );
      for (const moment of unsentVenues.rows) {
        await retryVenueApprovalNotification(moment);
      }
    } catch (error) {
      console.error("Moderator notification retry sweep error:", error);
    }
  });

  // Every 15 min — "day of" reminder for confirmed moments starting within
  // the next 12 hours. Sent individually to each attendee — no group chat.
  cron.schedule("*/15 * * * *", async () => {
    try {
      const dayOfMoments = await pool.query(
        `SELECT id, venue, location_name, moment_start
         FROM moments
         WHERE status = 'confirmed'
         AND moment_start BETWEEN NOW() AND NOW() + INTERVAL '12 hours'
         AND day_of_reminder_sent_at IS NULL`,
      );

      for (const moment of dayOfMoments.rows) {
        const attendees = await pool.query(
          `SELECT u.id, u.phone_number FROM moment_attendees ma
           JOIN users u ON u.id = ma.attendee_id
           WHERE ma.moment_id = $1`,
          [moment.id],
        );
        if (!attendees.rows.length) continue;

        const timeStr = new Date(moment.moment_start).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        const dayOfMsg = `Tonight's the night. ${moment.venue ?? moment.location_name} at ${timeStr}. Show the QR code at the door.`;

        for (const attendee of attendees.rows) {
          try {
            await sendblue.messages.send({
              number: attendee.phone_number,
              content: dayOfMsg,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (smsErr: any) {
            console.error(`Day-of reminder failed for ${attendee.id}:`, smsErr?.message ?? smsErr);
          }
        }

        await pool.query(
          `UPDATE moments SET day_of_reminder_sent_at = NOW() WHERE id = $1`,
          [moment.id],
        );
      }
    } catch (error) {
      console.error("Day-of reminder cron error:", error);
    }
  });

}
