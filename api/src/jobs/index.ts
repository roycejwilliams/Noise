import cron from "node-cron";
import twilio from "twilio";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import {
  confirmMoment,
  requestVenueApprovalFromKeana,
} from "../services/booking.js";
import sendblue from "../services/sendblue.js";
import type { CandidateWindow } from "../services/scheduling.js";

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
        `SELECT m.id, m.circle_id, m.moments_name, m.suggested_time, m.created_at, m.consensus_nudge_sent_at,
                m.venue, m.venue_booking_url, m.venue_place_id, m.candidate_windows, m.venue_fit_score
         FROM moments m
         JOIN circles c ON c.id = m.circle_id
         WHERE m.status = 'polling'
         AND c.status = 'active'
         AND EXISTS (SELECT 1 FROM moment_responses mr WHERE mr.moment_id = m.id)`,
      );

      for (const moment of pollingMoments.rows) {
        const responsesResult = await pool.query(
          `SELECT mr.user_id, mr.response, mr.selected_windows, u.phone_number, u.first_name
           FROM moment_responses mr
           JOIN users u ON u.id = mr.user_id
           WHERE mr.moment_id = $1`,
          [moment.id],
        );
        const responses = responsesResult.rows;
        const total = responses.length;
        if (total === 0) continue;

        // Simultaneous availability poll (candidate_windows present) tallies
        // per-window reply overlap instead of a single yes count — a member
        // can pick more than one window, so "consensus" here means whichever
        // window the most people can actually make, not a single yes/no
        // majority. Older in-flight moments with no candidate_windows (or a
        // failed window-generation at creation time) fall back to the
        // original yes-count check, unchanged.
        const candidateWindows: CandidateWindow[] = moment.candidate_windows ?? [];
        let thresholdMet: boolean;
        let winningWindowIndex: number | null = null; // 1-based, into candidateWindows

        if (candidateWindows.length) {
          const counts = new Array(candidateWindows.length).fill(0);
          for (const r of responses) {
            for (const idx of r.selected_windows ?? []) {
              if (idx >= 1 && idx <= counts.length) counts[idx - 1]++;
            }
          }
          let winningCount = 0;
          counts.forEach((c, i) => {
            if (c > winningCount) {
              winningCount = c;
              winningWindowIndex = i + 1;
            }
          });
          thresholdMet = winningCount * 2 > total;
        } else {
          const yesCount = responses.filter(
            (r: any) => r.response === "yes",
          ).length;
          thresholdMet = yesCount * 2 > total;
        }

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
            try {
              await sendblue.messages.send({
                number: nr.phone_number,
                content: `${nr.first_name}, your circle's moment has been locked. Reply with your availability or suggest a time for future moments.`,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Consensus nudge failed for ${nr.user_id}:`, smsErr?.message ?? smsErr);
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

        // Lock in the winning window (best-fit overlap, met early via the
        // threshold above or picked as the current plurality at the 48hr
        // cutoff) — same "must eventually resolve" behavior the original
        // yes/no cutoff already had, just writing a real window's time
        // instead of leaving the original suggested_time guess in place.
        if (candidateWindows.length && winningWindowIndex !== null) {
          const winner = candidateWindows[winningWindowIndex - 1];
          await pool.query(
            `UPDATE moments SET moment_start = $1, suggested_time = $2 WHERE id = $3`,
            [winner.start, winner.label, moment.id],
          );
          moment.suggested_time = winner.label;
        }

        // Consensus reached — gate on Keana approving the venue/time before
        // confirming the moment to the group. This send is best-effort, same
        // as every other cron notification here: a delivery failure must
        // never block the moment's actual state from updating.
        //
        // A resolution forced at the 48hr cutoff without ever reaching a real
        // majority (thresholdMet false) is a low-confidence pick, same idea
        // as a circle score barely clearing its floor — see
        // LOW_CONFIDENCE_VENUE_FIT_SCORE / requires_moderator_reply in
        // booking.ts.
        await requestVenueApprovalFromKeana({
          ...moment,
          consensus_low_confidence: !thresholdMet && past48hrs,
        });
      }
    } catch (error) {
      console.error("Consensus cron error:", error);
    }
  });

  // Every 30 min — auto-approve a venue Keana hasn't responded to within 4
  // hours, mirroring the circle-placement auto-approve cron in server.ts.
  // Without this, pending_venue_approval would just be a differently-named
  // version of the manual_review dead end it replaced. Approval is the last
  // gate — this goes straight to confirming the moment, no booking step.
  //
  // requires_moderator_reply = true (low venue fit and/or a forced,
  // non-majority consensus pick — see requestVenueApprovalFromKeana in
  // booking.ts) is excluded here on purpose: those never auto-approve.
  cron.schedule("*/30 * * * *", async () => {
    try {
      const staleVenues = await pool.query(
        `SELECT id, circle_id, moments_name, venue, venue_booking_url, venue_place_id, moment_start
         FROM moments
         WHERE status = 'pending_venue_approval'
         AND requires_moderator_reply = false
         AND keana_venue_notified_at < NOW() - INTERVAL '4 hours'`,
      );

      for (const moment of staleVenues.rows) {
        await confirmMoment(moment, io);
      }

      // Low-confidence venues never auto-approve — instead, re-ping Keana on
      // the same 4hr cadence (bumping keana_venue_notified_at resets the
      // clock for the next check, same as a fresh notification) so a
      // borderline pick doesn't just rot unresolved forever.
      const staleLowConfidenceVenues = await pool.query(
        `SELECT id, moments_name, venue, suggested_time, confidence_note
         FROM moments
         WHERE status = 'pending_venue_approval'
         AND requires_moderator_reply = true
         AND keana_venue_notified_at < NOW() - INTERVAL '4 hours'`,
      );

      for (const moment of staleLowConfidenceVenues.rows) {
        try {
          await sendblue.messages.send({
            number: process.env.KEANA_PHONE_NUMBER!,
            content: `Still waiting on your call for moment "${moment.moments_name ?? moment.id}" (${moment.venue ?? "TBD"}, suggested ${moment.suggested_time ?? "TBD"}) — ${moment.confidence_note ?? "borderline pick"}. Reply APPROVE or REJECT whenever you can, this one won't auto-approve.`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (err: any) {
          console.error(`Venue low-confidence re-ping failed for moment ${moment.id}:`, err?.message ?? err);
        }
        await pool.query(`UPDATE moments SET keana_venue_notified_at = NOW() WHERE id = $1`, [moment.id]);
      }
    } catch (error) {
      console.error("Venue auto-approve cron error:", error);
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
          const webhookParams = new URLSearchParams({
            config_id: process.env.HUME_CONFIG_ID!,
            api_key: process.env.HUME_API_KEY!,
            custom_session_id: user.id,
            first_name: user.first_name ?? "",
          });
          if (user.hume_chat_group_id) {
            webhookParams.set("resumed_chat_group_id", user.hume_chat_group_id);
          }

          const call = await twilioClient.calls.create({
            to: user.phone_number,
            from: process.env.TWILIO_PHONE_NUMBER!,
            url: `https://api.hume.ai/v0/evi/twilio?${webhookParams.toString()}`,
            statusCallback: `${process.env.API_URL}/co/call-status`,
            statusCallbackEvent: ["completed"],
            statusCallbackMethod: "POST",
          });

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

  // Every 15 min — delayed missed-call follow-up (2hr after a true
  // no-answer/busy/failed/canceled — nobody and nothing picked up). Plain
  // text, no AI drafting or voice note — voicemail-detected calls are
  // handled instantly elsewhere (co.ts call-status handler).
  cron.schedule("*/15 * * * *", async () => {
    try {
      const due = await pool.query(
        `SELECT pcf.id, pcf.call_status, u.id AS user_id, u.first_name, u.phone_number
         FROM pending_call_followups pcf
         JOIN users u ON u.id = pcf.user_id
         WHERE pcf.due_at <= NOW() AND pcf.sent_at IS NULL`,
      );

      for (const row of due.rows) {
        try {
          await sendblue.messages.send({
            number: row.phone_number,
            content: `${row.first_name}, I tried calling but must have missed you. I'll try again soon, or reply here whenever works.`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error(`Delayed missed-call follow-up failed for ${row.user_id}:`, smsErr?.message ?? smsErr);
        }
        await pool.query(
          `UPDATE pending_call_followups SET sent_at = NOW() WHERE id = $1`,
          [row.id],
        );
      }
    } catch (error) {
      console.error("Delayed missed-call follow-up cron error:", error);
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
