import cron from "node-cron";
import twilio from "twilio";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import sendblue from "../services/sendblue.js";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

export function registerJobs() {
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

        const momentUrl = `https://copatible.com/moments/${row.moment_id}`;

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

        const momentUrl = `https://copatible.com/moments/${row.moment_id}`;

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

        const circleUrl = `https://copatible.com/join?circle=${row.circle_id}`;

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
        `SELECT m.id, m.circle_id, m.suggested_time, m.created_at, m.consensus_nudge_sent_at
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
            await sendblue.messages.send({
              number: nr.phone_number,
              content: `${nr.first_name}, your circle's moment has been locked. Reply YES or suggest a time for future moments.`,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
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

        const connectorResult = await pool.query(
          `SELECT u.id, u.phone_number, u.first_name
           FROM circle_members cm
           JOIN users u ON u.id = cm.member_id
           JOIN co_profiles cp ON cp.user_id = cm.member_id
           WHERE cm.circle_id = $1 AND cp.is_circle_connector = TRUE
           LIMIT 1`,
          [moment.circle_id],
        );

        const circlePageUrl = `https://copatible.com/circles/${moment.circle_id}`;

        if (connectorResult.rows[0]) {
          const connector = connectorResult.rows[0];
          await sendblue.messages.send({
            number: connector.phone_number,
            content: `${connector.first_name}, your circle is confirmed. Tap to book: ${circlePageUrl}`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
          await pool.query(
            `UPDATE moments SET status = 'consensus_locked', booking_link_sent_at = NOW() WHERE id = $1`,
            [moment.id],
          );
        } else {
          const responsesSummary = responses
            .map((r: any) => `${r.first_name}: ${r.response ?? "no reply"}`)
            .join(", ");
          await sendblue.messages.send({
            number: process.env.KEANA_PHONE_NUMBER!,
            content: `Circle consensus needed for moment ${moment.id}. Suggested: ${moment.suggested_time ?? "TBD"}. Responses: ${responsesSummary}. Circle: ${circlePageUrl}`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
          await pool.query(
            `UPDATE moments SET status = 'manual_review' WHERE id = $1`,
            [moment.id],
          );
        }
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

  // Every hour — connector timeout: 4hr nudge → 8hr escalate to Keana
  cron.schedule("0 * * * *", async () => {
    try {
      const fourHoursAgo = new Date(
        Date.now() - 4 * 60 * 60 * 1000,
      ).toISOString();
      const eightHoursAgo = new Date(
        Date.now() - 8 * 60 * 60 * 1000,
      ).toISOString();

      const overdueResult = await pool.query(
        `SELECT m.id, m.circle_id, m.booking_link_sent_at, m.connector_nudge_sent_at
         FROM moments m
         WHERE m.status = 'consensus_locked'
         AND m.booking_link_sent_at < $1`,
        [fourHoursAgo],
      );

      for (const moment of overdueResult.rows) {
        const connectorResult = await pool.query(
          `SELECT u.id, u.phone_number, u.first_name
           FROM circle_members cm
           JOIN users u ON u.id = cm.member_id
           JOIN co_profiles cp ON cp.user_id = cm.member_id
           WHERE cm.circle_id = $1 AND cp.is_circle_connector = TRUE
           LIMIT 1`,
          [moment.circle_id],
        );
        const connector = connectorResult.rows[0];
        const circlePageUrl = `https://copatible.com/circles/${moment.circle_id}`;
        const past8hrs =
          new Date(moment.booking_link_sent_at) < new Date(eightHoursAgo);

        if (past8hrs) {
          await sendblue.messages.send({
            number: process.env.KEANA_PHONE_NUMBER!,
            content: `Connector unresponsive for 8hrs on moment ${moment.id}. Needs manual booking. Circle: ${circlePageUrl}`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
          if (connector) {
            await pool.query(
              `UPDATE co_profiles SET trust_score = GREATEST(0, trust_score - 10), is_circle_connector = FALSE WHERE user_id = $1`,
              [connector.id],
            );
          }
        } else if (!moment.connector_nudge_sent_at) {
          if (connector) {
            await sendblue.messages.send({
              number: connector.phone_number,
              content: `${connector.first_name}, your circle is still waiting. Tap to book: ${circlePageUrl}`,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
            await pool.query(
              `UPDATE moments SET connector_nudge_sent_at = NOW() WHERE id = $1`,
              [moment.id],
            );
          }
        }
      }
    } catch (error) {
      console.error("Connector timeout cron error:", error);
    }
  });
}
