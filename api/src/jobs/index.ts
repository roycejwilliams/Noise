import cron from "node-cron";
import twilio from "twilio";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import {
  confirmMoment,
  requestVenueApprovalFromModerator,
  retryVenueApprovalNotification,
} from "../services/booking.js";
import sendblue from "../services/sendblue.js";
import { CIRCLE_FACILITATION_ENABLED, findBestCircle } from "../services/circleFacilitation.js";
import { sweepAllOpenAsks } from "../services/relevance.js";
import { getCoverageNudge, markTopicAsked, RAPPORT_TOPIC_DESCRIPTIONS } from "../services/profileExtraction.js";
import type { RapportTopic } from "../services/profileExtraction.js";
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
                m.consensus_4hr_nudge_sent_at, m.consensus_8hr_notice_sent_at,
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
        const past4hrs = hoursSinceCreated >= 4;
        const past8hrs = hoursSinceCreated >= 8;
        const past48hrs = hoursSinceCreated >= 48;

        // "Responded" means selected at least one window for the
        // simultaneous-poll style, or gave a yes/no for the legacy style —
        // matches the same distinction used for thresholdMet above.
        const hasResponded = (r: any) =>
          candidateWindows.length ? !!(r.selected_windows && r.selected_windows.length) : r.response !== null;

        // 4hr checkpoint — nudge whoever hasn't responded yet, once, well
        // ahead of the harder 48hr force-lock.
        if (!thresholdMet && past4hrs && !moment.consensus_4hr_nudge_sent_at) {
          const nonResponders = responses.filter((r: any) => !hasResponded(r));
          for (const nr of nonResponders) {
            try {
              await sendblue.messages.send({
                number: nr.phone_number,
                content: `${nr.first_name}, still waiting on your availability for this circle's moment — reply when you get a chance.`,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`4hr consensus nudge failed for ${nr.user_id}:`, smsErr?.message ?? smsErr);
            }
          }
          await pool.query(`UPDATE moments SET consensus_4hr_nudge_sent_at = NOW() WHERE id = $1`, [moment.id]);
        }

        // 8hr checkpoint — an informational heads-up to the Moderator that
        // consensus is stalling. Not a decision request (no approve/reject
        // language, nothing gates on her reply) — the 48hr force-lock below
        // is still what actually resolves this.
        if (!thresholdMet && past8hrs && !moment.consensus_8hr_notice_sent_at) {
          try {
            await sendblue.messages.send({
              number: process.env.MODERATOR_PHONE_NUMBER!,
              content: `Heads up — consensus hasn't been reached yet for moment "${moment.moments_name ?? moment.id}" (8hrs in). No action needed, this force-locks at 48hrs if it's still unresolved.`,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (err: any) {
            console.error(`8hr consensus Moderator notice failed for moment ${moment.id}:`, err?.message ?? err);
          }
          await pool.query(`UPDATE moments SET consensus_8hr_notice_sent_at = NOW() WHERE id = $1`, [moment.id]);
        }

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

          // Anyone who didn't select the locked window (including a true
          // non-responder — they never confirmed they could make it either)
          // has a real schedule conflict with the actual time — remove them
          // from the circle rather than silently booking a moment they
          // can't attend, and try to backfill.
          const conflicted = responses.filter(
            (r: any) => !(r.selected_windows ?? []).includes(winningWindowIndex),
          );

          for (const person of conflicted) {
            await pool.query(
              `DELETE FROM circle_members WHERE circle_id = $1 AND member_id = $2`,
              [moment.circle_id, person.user_id],
            );
            try {
              await sendblue.messages.send({
                number: person.phone_number,
                content: `${person.first_name}, the group landed on a time that doesn't work for you, so Co's pulling you from this circle and will keep an eye out for a better fit.`,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Schedule-conflict removal notice failed for ${person.user_id}:`, smsErr?.message ?? smsErr);
            }
          }

          if (conflicted.length) {
            // Backend search only, not shown to the group — attempted
            // immediately rather than as a literal delayed/background job.
            const remainingResult = await pool.query(
              `SELECT member_id FROM circle_members WHERE circle_id = $1`,
              [moment.circle_id],
            );
            const remainingIds: string[] = remainingResult.rows.map((r: any) => r.member_id);
            const knownIds = [...remainingIds, ...conflicted.map((c: any) => c.user_id)];

            const ownerResult = await pool.query(`SELECT owner_id FROM circles WHERE id = $1`, [moment.circle_id]);
            const ownerId = ownerResult.rows[0]?.owner_id;
            let replaced = false;

            // Co Loop Stage 4 — off for now (see circleFacilitation.ts).
            // `replaced` stays false, falling through to the existing
            // !replaced Moderator-notify branch below unchanged.
            if (ownerId && CIRCLE_FACILITATION_ENABLED) {
              const replacementIds = await findBestCircle(ownerId, knownIds);
              const candidateId = (replacementIds ?? []).find((id: string) => !knownIds.includes(id));

              if (candidateId) {
                await pool.query(
                  `INSERT INTO circle_members (circle_id, member_id, status) VALUES ($1, $2, 'accepted') ON CONFLICT DO NOTHING`,
                  [moment.circle_id, candidateId],
                );
                await pool.query(
                  `INSERT INTO moment_responses (moment_id, user_id, selected_windows) VALUES ($1, $2, $3)
                   ON CONFLICT (moment_id, user_id) DO UPDATE SET selected_windows = $3`,
                  [moment.id, candidateId, [winningWindowIndex]],
                );

                const candidateResult = await pool.query(
                  `SELECT first_name, phone_number FROM users WHERE id = $1`,
                  [candidateId],
                );
                const candidate = candidateResult.rows[0];
                if (candidate) {
                  try {
                    await sendblue.messages.send({
                      number: candidate.phone_number,
                      content: `Co found you a spot in a circle — the group's already locked in ${winner.label}. You're in.`,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (smsErr: any) {
                    console.error(`Replacement invite failed for ${candidateId}:`, smsErr?.message ?? smsErr);
                  }
                }
                replaced = true;
              }
            }

            if (!replaced) {
              const finalCountResult = await pool.query(
                `SELECT COUNT(*) FROM circle_members WHERE circle_id = $1 AND status != 'declined'`,
                [moment.circle_id],
              );
              const finalCount = parseInt(finalCountResult.rows[0].count, 10);

              if (finalCount < 4) {
                try {
                  await sendblue.messages.send({
                    number: process.env.MODERATOR_PHONE_NUMBER!,
                    content: `Circle for moment "${moment.moments_name ?? moment.id}" dropped below minimum size after a schedule conflict and no replacement was found. Manual review needed.`,
                    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                  });
                } catch (err: any) {
                  console.error(`Schedule-conflict Moderator notice failed for moment ${moment.id}:`, err?.message ?? err);
                }
              }
            }
          }
        }

        // Consensus reached — gate on the Moderator approving the venue/time
        // before confirming the moment to the group. The moment's status
        // still updates to pending_venue_approval regardless of whether the
        // notification send itself succeeds — but unlike a true "best
        // effort" send, a failed notification is tracked (see
        // requestVenueApprovalFromModerator in booking.ts) and retried until
        // it actually reaches the Moderator, rather than silently starting
        // an auto-approve clock she never saw.
        //
        // A resolution forced at the 48hr cutoff without ever reaching a real
        // majority (thresholdMet false) is a low-confidence pick, same idea
        // as a circle score barely clearing its floor — see
        // LOW_CONFIDENCE_VENUE_FIT_SCORE / requires_moderator_reply in
        // booking.ts.
        await requestVenueApprovalFromModerator({
          ...moment,
          consensus_low_confidence: !thresholdMet && past48hrs,
        });
      }
    } catch (error) {
      console.error("Consensus cron error:", error);
    }
  });

  // Every 30 min — auto-approve a venue the Moderator hasn't responded to within 4
  // hours, mirroring the circle-placement auto-approve cron in server.ts.
  // Without this, pending_venue_approval would just be a differently-named
  // version of the manual_review dead end it replaced. Approval is the last
  // gate — this goes straight to confirming the moment, no booking step.
  //
  // requires_moderator_reply = true (low venue fit and/or a forced,
  // non-majority consensus pick — see requestVenueApprovalFromModerator in
  // booking.ts) is excluded here on purpose: those never auto-approve.
  cron.schedule("*/30 * * * *", async () => {
    try {
      // A moment whose initial notification never actually reached the Moderator
      // (Sendblue send failed) sits here with moderator_venue_notified_at still
      // NULL — status/confidence fields are already set, only the send
      // itself needs retrying. Runs first so a send that succeeds this tick
      // isn't immediately swept as stale below (it won't be, since NOW() -
      // 4 hours can't already be past, but this keeps the intent obvious).
      const unsentVenueApprovals = await pool.query(
        `SELECT id, moments_name, venue, suggested_time, requires_moderator_reply, confidence_note
         FROM moments
         WHERE status = 'pending_venue_approval' AND moderator_venue_notified_at IS NULL`,
      );
      for (const moment of unsentVenueApprovals.rows) {
        await retryVenueApprovalNotification(moment);
      }

      const staleVenues = await pool.query(
        `SELECT id, circle_id, moments_name, venue, venue_booking_url, venue_place_id, moment_start
         FROM moments
         WHERE status = 'pending_venue_approval'
         AND requires_moderator_reply = false
         AND moderator_venue_notified_at < NOW() - INTERVAL '4 hours'`,
      );

      for (const moment of staleVenues.rows) {
        await confirmMoment(moment, io);
      }

      // Low-confidence venues never auto-approve — instead, re-ping the Moderator on
      // the same 4hr cadence (bumping moderator_venue_notified_at resets the
      // clock for the next check, same as a fresh notification) so a
      // borderline pick doesn't just rot unresolved forever.
      const staleLowConfidenceVenues = await pool.query(
        `SELECT id, moments_name, venue, suggested_time, confidence_note
         FROM moments
         WHERE status = 'pending_venue_approval'
         AND requires_moderator_reply = true
         AND moderator_venue_notified_at < NOW() - INTERVAL '4 hours'`,
      );

      for (const moment of staleLowConfidenceVenues.rows) {
        try {
          await sendblue.messages.send({
            number: process.env.MODERATOR_PHONE_NUMBER!,
            content: `Still waiting on your call for moment "${moment.moments_name ?? moment.id}" (${moment.venue ?? "TBD"}, suggested ${moment.suggested_time ?? "TBD"}) — ${moment.confidence_note ?? "borderline pick"}. Reply APPROVE or REJECT whenever you can, this one won't auto-approve.`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (err: any) {
          console.error(`Venue low-confidence re-ping failed for moment ${moment.id}:`, err?.message ?? err);
        }
        await pool.query(`UPDATE moments SET moderator_venue_notified_at = NOW() WHERE id = $1`, [moment.id]);
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

  // Co Loop Stage 3 — daily at 3 AM, re-sweep every open stated ask against
  // the current network. This (not a per-event trigger on every profile
  // update) is what surfaces a new joiner to everyone with a standing ask —
  // sweepAllOpenAsks re-runs each ask and logRelevanceEdges de-dupes, so
  // running it daily is cheap and safe. Density-phase only: nothing
  // downstream acts on relevance_edges yet, this just builds and logs the
  // graph for Stage 6 to validate later.
  cron.schedule("0 3 * * *", async () => {
    try {
      await sweepAllOpenAsks();
    } catch (error) {
      console.error("Relevance sweep cron error:", error);
    }
  });

  // Co Loop Stage 5 — daily at 11 AM, check back in on a stated ask that's
  // gone quiet so it's never just a one-time snapshot. Cadence is adaptive,
  // not a flat 21 days: an ask with open relevance_edges (Stage 3 found
  // something) is checked every 14 days since it's more "live"; an ask with
  // no matches yet is checked every 30 days since there's nothing new to
  // report. Repeats until Stage 6 (assessResolvedItems, profileExtraction.ts)
  // marks it resolved. Message is generated fresh at send time, same
  // reasoning as the post-call follow-up cron above — not stored/reused.
  cron.schedule("0 11 * * *", async () => {
    try {
      const due = await pool.query(
        `SELECT ac.id, ac.ask_text, ac.checkin_count, u.id AS user_id, u.first_name, u.phone_number,
                COALESCE(re.match_count, 0) > 0 AS has_matches,
                cp.life_chapters, cp.goals, cp.blockers, cp.long_term_direction, cp.city,
                cp.topics_covered, cp.topics_asked
         FROM ask_checkins ac
         JOIN users u ON u.id = ac.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = ac.user_id
         LEFT JOIN (
           SELECT person_id, ask_id, COUNT(*) AS match_count
           FROM relevance_edges
           WHERE status = 'open'
           GROUP BY person_id, ask_id
         ) re ON re.person_id = ac.user_id AND re.ask_id = ac.ask_id
         WHERE ac.resolved_at IS NULL
         AND COALESCE(ac.last_checked_at, ac.created_at) <=
           NOW() - (CASE WHEN COALESCE(re.match_count, 0) > 0 THEN INTERVAL '14 days' ELSE INTERVAL '30 days' END)`,
      );

      for (const row of due.rows) {
        try {
          // Escalates after 2 prior check-ins with no resolution — an
          // explicit off-ramp instead of repeating the same question
          // indefinitely. Deliberately silent about matches existing (even
          // when has_matches is true) since Stage 4 is off — naming a match
          // without acting on it reads as an intro that's coming, which
          // isn't true right now. Absence of a match is safe to name, since
          // it sets no expectation.
          const isEscalating = row.checkin_count >= 2;
          const matchContext = !row.has_matches
            ? `\nCo hasn't found a strong match for this yet, so it's fine to let them know that honestly (e.g. "still keeping an eye out") — don't imply anything is imminent.`
            : "";
          const escalationContext = isEscalating
            ? `\nCo has already checked in on this ${row.checkin_count} times with no clear resolution. Instead of just re-asking, ask whether this is still actually a priority for them, and give them an easy way to say "stop asking about this" if it's not.`
            : "";

          // Co Loop Stage 1 via Stage 5 — same shared coverage-nudge helper
          // sendblue.ts's reply prompt uses (profileExtraction.ts's
          // getCoverageNudge), reused here since a check-in is itself a
          // real, already-scheduled touchpoint that can also work toward a
          // RAPPORT_TOPICS gap, not just re-ask about the same stated ask
          // forever. Skipped while escalating — that message already has a
          // delicate job (asking whether this is still a priority) and
          // shouldn't be diluted with an unrelated question.
          let topicContext = "";
          let nudgeTopic: RapportTopic | null = null;
          if (!isEscalating) {
            const { missingTopic } = await getCoverageNudge(row.user_id, "", {
              life_chapters: row.life_chapters,
              goals: row.goals,
              blockers: row.blockers,
              long_term_direction: row.long_term_direction,
              city: row.city,
              topics_covered: row.topics_covered,
              topics_asked: row.topics_asked,
            });
            nudgeTopic = missingTopic;
            topicContext = missingTopic
              ? `\nSeparately, Co doesn't yet have a good sense of ${RAPPORT_TOPIC_DESCRIPTIONS[missingTopic]}. If it fits naturally after the check-in question, you can gently work in one brief, genuine question toward that too — but never force it, and the check-in question always comes first and matters more.`
              : "";
          }

          const { text: message } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `You are Co, texting ${row.first_name} to check in on something they told you about a while back: "${row.ask_text}"

Write a short iMessage checking in on whether this is still true or still a priority. Tone: a thoughtful friend following up, not a survey. The check-in question about their ask is the priority and always comes first; only add a second question if the note below explicitly invites one. 1-3 sentences max. No em dashes.${matchContext}${escalationContext}${topicContext}`,
            experimental_telemetry: { isEnabled: true, functionId: "jobs.askCheckin" },
          });

          await sendblue.messages.send({
            number: row.phone_number,
            content: message.trim(),
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });

          if (nudgeTopic) markTopicAsked(row.user_id, nudgeTopic);

          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'check_in', $2)`,
            [row.user_id, `Co checked in on stated ask: "${row.ask_text}"`],
          );
        } catch (err: any) {
          console.error(`Ask check-in failed for ${row.user_id}:`, err?.message ?? err);
        }
        // Bumped regardless of send success — same reasoning as every other
        // *_sent_at guard in this file: a permanently-failing send should
        // not retry forever on every tick, it should wait for the next
        // cadence window like a successful send would. awaiting_response_since
        // starts the response-rate clock (cleared by the next inbound message
        // from this person — see sendblue.ts webhook).
        await pool.query(
          `UPDATE ask_checkins
           SET last_checked_at = NOW(), checkin_count = checkin_count + 1, awaiting_response_since = NOW()
           WHERE id = $1`,
          [row.id],
        );
      }
    } catch (error) {
      console.error("Ask check-in cron error:", error);
    }
  });

}
