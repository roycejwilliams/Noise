import cron from "node-cron";
import { DateTime } from "luxon";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { isReasonableLocalHour } from "../services/localHours.js";
import { sweepAllOpenAsks } from "../services/relevance.js";
import { attemptEventSurfacing, PROFILE_ASK_ID } from "../services/eventSurfacingSweep.js";
import { attemptNetworkSurfacing } from "../services/networkIntroNudge.js";
import { scoreGuestListForEvent } from "../services/eventScoring.js";
import { listCalendarEvents, getEventDetails } from "../services/luma.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { enqueueDuePostCallFollowUps } from "./postCallFollowUp.js";
import { placeDueCalls, sendDueReminders } from "./scheduledCall.js";
import { placeDueProactiveCalls } from "./proactiveCheckinCall.js";
import { buildRecap, findUsersDueForRecap } from "../services/memoryCompaction.js";
import { enqueueDebrief, enqueueDueOutcomeFollowUps } from "../services/recommendationOutcome.js";
import { enqueueDueEventCheckinFollowUps } from "../services/eventCheckinFollowUp.js";
import { runEventChangeNotificationAgent } from "../agent/eventChangeNotification.js";
import type { AskCheckinPayload } from "../agent/askCheckin.js";
import { enqueueCandidate, runProactiveDispatch, sendExempt } from "../harness/proactive.js";
import { proactiveRegistry } from "../harness/proactiveRegistry.js";
import { runMonitor, runWeeklyReview } from "../harness/monitor.js";

// Bounded-concurrency worker pool (Royce, 2026-08-30) — the event surfacing
// sweep now runs for every open ask daily (see below), and a plain
// sequential for-await over potentially hundreds of rows wastes most of the
// 9am window waiting on one person's Luma/embedding calls before starting
// the next. This runs up to `limit` rows concurrently instead of one at a
// time. Not used for the other, smaller crons in this file (they cap total
// row count via SQL LIMIT instead, a different tool for a different reason
// — avoiding placing many outbound calls at once, not a throughput problem).
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function registerJobs(io: Server) {
  // Hourly, every hour (Royce, 2026-09-02: was "10am-8pm UTC" — 3am-1pm
  // Pacific, wrong for exactly the users this product is built around; a
  // real "thinking about you" text from a DIFFERENT cron arrived at 2am
  // Pacific the same day). Now gated per-user on their own local hour
  // (localHours.ts) instead of a single fixed UTC window — LIMIT widened
  // 5->25 since the hour gate filters most candidates out on any given
  // tick, but the actual-dial cap stays at 5 via the `placed` counter, same
  // Twilio-rate-limit reasoning as before.
  // Won't retry a user who had a call attempt in the last 24 hours. Dials via
  // triggerCallForUser (the media-stream bridge) rather than a third
  // independent copy of the dial logic — this used to hit Hume's native
  // /v0/evi/twilio integration directly, which silently drops
  // first_name/context_summary.
  cron.schedule("0 * * * *", async () => {
    try {
      const uncalled = await pool.query(
        `SELECT u.id, cp.city
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
         LIMIT 25`,
      );

      let placed = 0;
      for (const user of uncalled.rows) {
        if (placed >= 5) break;
        const timezone = user.city ? await getTimezoneForCity(user.city) : null;
        if (!isReasonableLocalHour(timezone)) continue; // wrong hour for them — no state touched, retried next hourly tick
        placed++;
        try {
          const result = await triggerCallForUser(user.id, io, { kind: "auto_intake" });
          if (!result.success) {
            console.error(`Auto-call failed for user ${user.id}:`, result.error);
          }
        } catch (callErr: any) {
          console.error(`Auto-call failed for user ${user.id}:`, callErr?.message ?? callErr);
        }
      }
    } catch (err) {
      console.error("Auto-call cron error:", err);
    }
  });

  // Layer 7 proactive harness (2026-09-14): the ONE place Co texts first.
  // Every sweep/scheduler below only queues candidates; this picks at most
  // one per person per local day under the gates in src/harness/proactive.ts
  // (local hours, 1/day, 3/week, 72h pause after an unanswered text, no
  // repeats) and sends it.
  let dispatchRunning = false;
  cron.schedule("*/15 * * * *", async () => {
    if (dispatchRunning) return;
    dispatchRunning = true;
    try {
      await runProactiveDispatch(proactiveRegistry);
    } catch (err: any) {
      console.error("proactive dispatch cron error:", err?.message ?? err);
    } finally {
      dispatchRunning = false;
    }
  });

  // Every 10 min — queue the post-call text for recent calls (sent within
  // local hours by the harness, dropped if it would land >24h after the call).
  cron.schedule("*/10 * * * *", () => {
    enqueueDuePostCallFollowUps().catch((err: any) => console.error("postCallFollowUp: enqueue failed:", err?.message ?? err));
  });

  // Every 5 min — place calls booked via the schedule-a-call text flow, and
  // send the ~15-min heads-up reminder for one coming up soon.
  cron.schedule("*/5 * * * *", () => {
    placeDueCalls(io).catch((err) => console.error("scheduledCall: poll failed:", err?.message ?? err));
    sendDueReminders().catch((err) => console.error("scheduledCall: reminder poll failed:", err?.message ?? err));
  });

  // Every 15 min — "always lend an ear," the other half: Co reaching out on
  // its own, on the cadence a user set post-call, unconditionally once due.
  cron.schedule("*/15 * * * *", () => {
    placeDueProactiveCalls(io).catch((err) => console.error("proactiveCheckinCall: poll failed:", err?.message ?? err));
  });

  // Every 15 min — delayed missed-call follow-up (2hr after a true
  // no-answer/busy/failed/canceled — nobody and nothing picked up). Plain
  // text, no AI drafting or voice note — voicemail-detected calls are
  // handled instantly elsewhere (co.ts call-status handler).
  //
  // Gated on local hour (Royce, 2026-09-03) — same reasoning as the other
  // three crons above and postCallFollowUp.ts's reflection text: a call
  // attempt near the 8pm window edge plus this 2hr delay could otherwise
  // push a send past it. due_at is left untouched on a skip, so it's
  // re-checked next tick instead of dropped.
  cron.schedule("*/15 * * * *", async () => {
    try {
      const due = await pool.query(
        `SELECT pcf.id, pcf.call_status, u.id AS user_id, u.first_name, u.phone_number, cp.city
         FROM pending_call_followups pcf
         JOIN users u ON u.id = pcf.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = pcf.user_id
         WHERE pcf.due_at <= NOW() AND pcf.sent_at IS NULL`,
      );

      for (const row of due.rows) {
        const timezone = row.city ? await getTimezoneForCity(row.city) : null;
        if (!isReasonableLocalHour(timezone)) continue;

        const missedCallText = `${row.first_name}, I tried calling but must have missed you. I'll try again soon, or reply here whenever works.`;
        try {
          // Transactional: one per missed call through the proactive ledger
          // (sendExempt logs text_exchange), outside the daily pick.
          await sendExempt({
            userId: row.user_id,
            phoneNumber: row.phone_number,
            type: "missed_call",
            targetKey: `missed_call:${row.id}`,
            messages: [missedCallText],
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

  // Every 15 min — deferred event-change/cancellation notifications
  // (Royce, 2026-09-03). eventChangeDetection.ts's notifyMatchedGuests
  // sends immediately when it's a reasonable hour for the recipient, and
  // only queues a row here when a host's edit/cancel lands off-hours for
  // them. Row is left untouched on a skip, so it's re-checked next tick.
  cron.schedule("*/15 * * * *", async () => {
    try {
      const due = await pool.query(
        `SELECT ecn.id, ecn.user_id, ecn.event_name, ecn.message, u.first_name, u.phone_number, cp.city
         FROM event_change_notifications ecn
         JOIN users u ON u.id = ecn.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = ecn.user_id
         WHERE ecn.sent_at IS NULL`,
      );

      for (const row of due.rows) {
        const timezone = row.city ? await getTimezoneForCity(row.city) : null;
        if (!isReasonableLocalHour(timezone)) continue;

        const claim = await pool.query(
          `UPDATE event_change_notifications SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING id`,
          [row.id],
        );
        if (!claim.rows[0]) continue;

        try {
          await runEventChangeNotificationAgent(
            { userId: row.user_id, firstName: row.first_name, phoneNumber: row.phone_number },
            row.event_name,
            row.message,
          );
        } catch (err: any) {
          console.error(`Deferred event-change notification failed for ${row.user_id} (non-fatal, already claimed):`, err?.message ?? err);
        }
      }
    } catch (error) {
      console.error("Deferred event-change notification cron error:", error);
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

  // Co Loop Stage 5 check-in on an open ask. Layer 7 (2026-09-14): queues an
  // "ask_checkin" candidate only when there's movement (a new possible match
  // logged for this ask since the last check-in, at least 3 days on) or 14
  // days have passed; the harness decides when it goes out. The target key
  // includes the check-in number, so re-running this hourly never queues a
  // second copy.
  cron.schedule("0 * * * *", async () => {
    try {
      const due = await pool.query(
        `SELECT ac.id, ac.ask_id, ac.ask_text, ac.checkin_count, ac.user_id,
                COALESCE(re.match_count, 0) > 0 AS has_matches
         FROM ask_checkins ac
         JOIN users u ON u.id = ac.user_id
         LEFT JOIN (
           SELECT person_id, ask_id, COUNT(*) AS match_count, MAX(created_at) AS newest
           FROM relevance_edges
           WHERE status = 'open'
           GROUP BY person_id, ask_id
         ) re ON re.person_id = ac.user_id AND re.ask_id = ac.ask_id
         WHERE ac.resolved_at IS NULL AND u.sms_opted_out = false
           AND (
             COALESCE(ac.last_checked_at, ac.created_at) <= NOW() - INTERVAL '14 days'
             OR (re.newest > COALESCE(ac.last_checked_at, ac.created_at)
                 AND COALESCE(ac.last_checked_at, ac.created_at) <= NOW() - INTERVAL '3 days')
           )`,
      );

      for (const row of due.rows) {
        const payload: AskCheckinPayload = {
          askCheckinId: row.id,
          askId: row.ask_id,
          askText: row.ask_text,
          checkinCount: row.checkin_count,
          hasMatches: row.has_matches,
        };
        await enqueueCandidate({
          userId: row.user_id,
          type: "ask_checkin",
          targetKey: `ask_checkin:${row.ask_id}:${row.checkin_count + 1}`,
          topicKey: `ask:${row.ask_id}`,
          summary: `Check in on what they told you they want: "${String(row.ask_text).slice(0, 140)}" (${row.checkin_count} earlier check-ins${row.has_matches ? ", some possible leads" : ""})`,
          payload,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }).catch((err: any) => console.error(`Ask check-in enqueue failed for ${row.user_id}:`, err?.message ?? err));
      }
    } catch (error) {
      console.error("Ask check-in cron error:", error);
    }
  });

  // "Luma & X asks need to surface periodically" (Royce, 2026-08-30) —
  // replaces the old instant-fire-on-every-captured-ask behavior, which had
  // no cooldown and could text someone multiple times a day. Same shape as
  // the ask check-in cron above, different cadence (every 3 days, not
  // 14-30) since "is there a new event right now" is more time-sensitive
  // than a life-goal check-in — first-guess interval, not tuned. Reuses the
  // same ask_checkins row every active seeking ask already gets, tracked on
  // its own last_surfaced_at column so this cadence is independent of the
  // check-in cadence above.
  //
  // Layer 7 (2026-09-14): searches all three tiers for every open ask once
  // per local day (last_attempted_at) and QUEUES the front match; the
  // proactive harness decides whether it goes out. Hour-gated only so the
  // expensive search runs during the day, not to protect the send.
  cron.schedule("0 * * * *", async () => {
    try {
      // Oldest-surfaced ask first, so one ask can't win every day.
      const due = await pool.query(
        `SELECT ac.id, ac.ask_id, ac.ask_text, ac.last_attempted_at, u.id AS user_id, u.first_name, u.phone_number, cp.city,
                cp.goals, cp.activity_preferences,
                (ac.last_surfaced_at IS NULL OR ac.last_surfaced_at <= NOW() - INTERVAL '3 days') AS cooldown_cleared
         FROM ask_checkins ac
         JOIN users u ON u.id = ac.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = ac.user_id
         WHERE ac.resolved_at IS NULL
         ORDER BY ac.last_surfaced_at ASC NULLS FIRST`,
      );

      // Grouped by user, not run flat (Royce, 2026-08-30) — attemptEventSurfacing's
      // per-user state (the event backlog's read-modify-write, and the
      // cross-mechanism daily nudge cap) is keyed per-user, so two rows for
      // the SAME user running truly concurrently could race on the same
      // backlog or both pass the nudge-cap check before either claims it,
      // sending two teases in one run. Rows for the same user still process
      // one at a time; different users run in parallel.
      const rowsByUser = new Map<string, typeof due.rows>();
      for (const row of due.rows) {
        const list = rowsByUser.get(row.user_id) ?? [];
        list.push(row);
        rowsByUser.set(row.user_id, list);
      }

      await runWithConcurrency(Array.from(rowsByUser.values()), 5, async (userRows) => {
        // Resolved once per user (all their rows share the same profile
        // city), not once per ask — cheap either way since getTimezoneForCity
        // is cache-backed, but no reason to repeat it per row.
        const timezone = userRows[0].city ? await getTimezoneForCity(userRows[0].city) : null;
        if (!isReasonableLocalHour(timezone)) return; // wrong hour for this user — nothing touched, retried next hourly tick

        const localToday = (timezone ? DateTime.now().setZone(timezone) : DateTime.now()).toISODate();

        for (const row of userRows) {
          const lastAttemptedLocalDay = row.last_attempted_at
            ? DateTime.fromJSDate(row.last_attempted_at).setZone(timezone ?? "utc").toISODate()
            : null;
          if (lastAttemptedLocalDay === localToday) continue; // already ran today's check for this ask — don't re-run every hourly tick inside the window

          try {
            await attemptEventSurfacing({
              askId: row.id,
              userId: row.user_id,
              firstName: row.first_name,
              phoneNumber: row.phone_number,
              askText: row.ask_text,
              city: row.city ?? null,
              goals: row.goals ?? null,
              activityPreferences: row.activity_preferences ?? null,
              cooldownCleared: row.cooldown_cleared,
            });
          } catch (err: any) {
            console.error(`Event surfacing sweep failed for ${row.user_id}:`, err?.message ?? err);
          }
          // "Did we run today's search" marker. last_surfaced_at (the 3-day
          // cadence) now moves only when a text actually goes out, in the
          // harness's onSent hook.
          await pool.query(`UPDATE ask_checkins SET last_attempted_at = NOW() WHERE id = $1`, [row.id]);

          // Network intro candidates for the same ask. ac.ask_id, not ac.id:
          // relevance_edges and network_backlogs are keyed by the intent's
          // ask id (found 2026-09-14).
          try {
            await attemptNetworkSurfacing(row.user_id, row.first_name, row.phone_number, row.ask_id);
          } catch (err: any) {
            console.error(`Network surfacing sweep failed for ${row.user_id}:`, err?.message ?? err);
          }
        }
      });
    } catch (error) {
      console.error("Event surfacing sweep cron error:", error);
    }
  });

  // Active search for people with NO open stated ask (Royce, 2026-09-14: "it
  // should be actively searching for all 3 tiers"). Search text is built
  // from what they've shared (goals, interests, direction, wants), the
  // drafts say so instead of claiming they asked, and there's no network
  // surfacing (that needs a real ask). Same daily/3-day pacing as the ask
  // sweep, kept per person in profile_surfacing_state.
  cron.schedule("30 * * * *", async () => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id AS user_id, u.first_name, u.phone_number, cp.city, cp.goals, cp.activity_preferences,
                cp.long_term_direction, cp.intent, pss.last_attempted_at,
                (pss.last_surfaced_at IS NULL OR pss.last_surfaced_at <= NOW() - INTERVAL '3 days') AS cooldown_cleared
         FROM users u
         JOIN co_profiles cp ON cp.user_id = u.id
         LEFT JOIN profile_surfacing_state pss ON pss.user_id = u.id
         WHERE u.sms_opted_out = false AND u.phone_number IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ask_checkins ac WHERE ac.user_id = u.id AND ac.resolved_at IS NULL)
           AND (array_length(cp.goals, 1) > 0 OR array_length(cp.activity_preferences, 1) > 0
                OR COALESCE(cp.long_term_direction, '') <> '' OR jsonb_array_length(COALESCE(cp.intent, '[]'::jsonb)) > 0)
           AND (pss.last_attempted_at IS NULL OR pss.last_attempted_at <= NOW() - INTERVAL '20 hours')
         LIMIT 50`,
      );
      await runWithConcurrency(rows, 3, async (row: any) => {
        const intents = Array.isArray(row.intent) ? row.intent : [];
        const latest = intents[intents.length - 1] ?? {};
        const parts = [
          row.goals?.length ? `goals: ${row.goals.join("; ")}` : null,
          row.activity_preferences?.length ? `enjoys: ${row.activity_preferences.join(", ")}` : null,
          row.long_term_direction ? `direction: ${row.long_term_direction}` : null,
          latest.wants?.length ? `wants: ${latest.wants.join(", ")}` : null,
          latest.concrete_preferences?.length ? `specifics: ${latest.concrete_preferences.join(", ")}` : null,
        ].filter(Boolean);
        if (!parts.length) return;
        await pool.query(
          `INSERT INTO profile_surfacing_state (user_id, last_attempted_at) VALUES ($1, NOW())
           ON CONFLICT (user_id) DO UPDATE SET last_attempted_at = NOW()`,
          [row.user_id],
        );
        try {
          await attemptEventSurfacing({
            askId: PROFILE_ASK_ID,
            userId: row.user_id,
            firstName: row.first_name,
            phoneNumber: row.phone_number,
            askText: parts.join(". ").slice(0, 600),
            fromProfile: true,
            city: row.city ?? null,
            goals: row.goals ?? null,
            activityPreferences: row.activity_preferences ?? null,
            cooldownCleared: row.cooldown_cleared,
          });
        } catch (err: any) {
          console.error(`Profile surfacing sweep failed for ${row.user_id}:`, err?.message ?? err);
        }
      });
    } catch (error) {
      console.error("Profile surfacing sweep cron error:", error);
    }
  });

  // In-room match nudge retry (Royce, 2026-09-07: "we want to facilitate the
  // nudge as the event is happening" + "add the periodic retry") —
  // eventScoring.ts's maybeSendMatchNudge now withholds a match found before
  // an event's real start_at instead of firing immediately, so it lands
  // while the person is actually there instead of days early. That withheld
  // match only naturally retries if some OTHER real Luma webhook (a late
  // registration, an update) happens to fire after start_at — for an event
  // whose registration traffic has gone quiet by the time it starts, nothing
  // would otherwise ever re-check it. This re-runs the real scoring pass for
  // any Co-calendar event that started in the last 20 minutes, a narrow
  // window matching this cron's own 15-min cadence (not "poll for the whole
  // event") — one retry shortly after start_at is all a withheld match
  // needs; wasAlreadyNudgedForMatch already makes a repeat retry harmless.
  cron.schedule("*/15 * * * *", async () => {
    try {
      const events = await listCalendarEvents();
      const now = Date.now();
      const justStarted = events.filter((e) => {
        const startMs = new Date(e.start_at).getTime();
        return startMs <= now && now - startMs <= 20 * 60 * 1000;
      });
      for (const event of justStarted) {
        try {
          await scoreGuestListForEvent(event.api_id, event.name);
        } catch (err: any) {
          console.error(`In-room match nudge retry failed for event ${event.api_id}:`, err?.message ?? err);
        }
      }
    } catch (error) {
      console.error("In-room match nudge retry cron error:", error);
    }
  });

  // Deferred call-offer follow-up for day-of QR check-ins (Royce, 2026-09-10)
  // — a walk-in's check-in flow deliberately skips deep profile-building in
  // the moment (only a name/email + a single one-line ask, if either was
  // even needed). This is the other half: once the event they checked into
  // has actually wrapped, proactively offer a call framed around getting
  // them stronger matches, so the real profile-building conversation
  // happens when they have real attention to give it, not mid-event.
  // Queued into the morning-after debrief (see below); followup_sent_at is
  // set by the harness once that text goes out.
  const WALKIN_FOLLOWUP_BUFFER_MINUTES = 45;
  cron.schedule("*/15 * * * *", async () => {
    try {
      const { rows } = await pool.query(
        `SELECT ewc.id, ewc.event_api_id, ewc.ask_text, u.id AS user_id, cp.city
         FROM event_walkin_checkins ewc
         JOIN users u ON u.id = ewc.person_id
         LEFT JOIN co_profiles cp ON cp.user_id = ewc.person_id
         WHERE ewc.followup_sent_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM proactive_candidates pc
             WHERE pc.user_id = ewc.person_id AND pc.target_key = 'debrief:' || ewc.event_api_id
               AND pc.payload -> 'walkinCheckinIds' ? ewc.id::text
           )`,
      );
      if (!rows.length) return;

      // Group by event so each event's real end_at is only looked up once,
      // not once per checked-in person.
      const rowsByEvent = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = rowsByEvent.get(row.event_api_id) ?? [];
        list.push(row);
        rowsByEvent.set(row.event_api_id, list);
      }

      for (const [eventApiId, eventRows] of rowsByEvent) {
        const details = await getEventDetails(eventApiId).catch((err: any) => {
          console.error(`Walk-in follow-up: getEventDetails failed for ${eventApiId} (non-fatal):`, err?.message ?? err);
          return null;
        });
        if (!details?.end_at) continue; // can't confirm the event has wrapped yet — retry next tick

        const endedAt = new Date(details.end_at).getTime();
        if (Date.now() - endedAt < WALKIN_FOLLOWUP_BUFFER_MINUTES * 60 * 1000) continue; // hasn't cleared the buffer yet

        // Layer 7 (2026-09-14): the walk-in call offer is part of the
        // morning-after debrief for this event, not a second text the same
        // night. The harness marks followup_sent_at when it goes out.
        for (const row of eventRows) {
          try {
            const timezone = row.city ? await getTimezoneForCity(row.city).catch(() => null) : null;
            await enqueueDebrief({
              userId: row.user_id,
              eventApiId: eventApiId,
              eventName: details.name,
              eventEnd: new Date(details.end_at),
              timezone,
              part: { walkinCheckinIds: [row.id], askText: row.ask_text ?? null },
            });
          } catch (err: any) {
            console.error(`Walk-in follow-up enqueue failed for ${row.user_id}:`, err?.message ?? err);
          }
        }
      }
    } catch (error) {
      console.error("Walk-in follow-up cron error:", error);
    }
  });

  // Memory compaction (Royce, 2026-09-01: "go ahead and have that built" —
  // Co's own suggestion while diagnosing a real memory-continuity gap live
  // with Royce). Daily at 4am, off-peak from the other crons. Bounded
  // concurrency, same reasoning as the event surfacing sweep above — this
  // could run for every active user, not just a handful.
  cron.schedule("0 4 * * *", async () => {
    try {
      const userIds = await findUsersDueForRecap();
      await runWithConcurrency(userIds, 5, async (userId) => {
        try {
          await buildRecap(userId);
        } catch (err: any) {
          console.error(`Memory compaction failed for ${userId}:`, err?.message ?? err);
        }
      });
    } catch (error) {
      console.error("Memory compaction cron error:", error);
    }
  });

  // Decision log monitoring: hourly spike alerts, weekly review email
  // (harness/monitor.ts). Paused (Royce, 2026-09-15: "Pause 4 for now");
  // set MONITORING_ENABLED=true to turn it back on.
  if (process.env.MONITORING_ENABLED === "true") {
    cron.schedule("23 * * * *", () => {
      runMonitor().catch((err: any) => console.error("monitor cron error:", err?.message ?? err));
    });
    cron.schedule("7 16 * * 1", () => {
      runWeeklyReview().catch((err: any) => console.error("weekly review cron error:", err?.message ?? err));
    });
  }

  // Harness decision log retention: keep 60 days. Every reply, route, and
  // skipped send writes a row, so without this the table only grows.
  cron.schedule("17 4 * * *", async () => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM harness_decisions WHERE created_at < NOW() - INTERVAL '60 days'`);
      if (rowCount) console.log(`harness_decisions: removed ${rowCount} rows older than 60 days`);
      await pool.query(`DELETE FROM inbound_webhook_handles WHERE received_at < NOW() - INTERVAL '3 days'`);
    } catch (error) {
      console.error("harness_decisions retention cron error:", error);
    }
  });

  // Outcome-learning loop (Royce, 2026-09-02: "Co follows up" + shared
  // signal classifier + wiring weighting into future matching — Notion V1
  // board rows 7/12/13). Every 15 min, same cadence as the other lightweight
  // polling crons (scheduledCall, proactiveCheckinCall) — this just polls
  // for due rows and claims atomically, cheap even run often.
  cron.schedule("*/15 * * * *", () => {
    enqueueDueOutcomeFollowUps().catch((err: any) => console.error("recommendationOutcome: enqueue failed:", err?.message ?? err));
  });

  // End-of-night check-in (Notion V1 board row 8) — same lightweight polling
  // cadence as the outcome-followup cron right above; sibling mechanism, gated
  // on a real Luma check-in instead of a mere recommendation.
  cron.schedule("*/15 * * * *", () => {
    enqueueDueEventCheckinFollowUps().catch((err: any) => console.error("eventCheckinFollowUp: enqueue failed:", err?.message ?? err));
  });

  // Companion check-in (Royce, 2026-09-03: "how can we make it a companion
  // with what we have now" — every other proactive text has a reason
  // attached (an ask, an event, an outcome); this is the one that
  // doesn't). Seeded by the recap memoryCompaction.ts already builds —
  // previously pure internal bookkeeping, never surfaced to the user.
  // Targets users PAST onboarding (life_chapters populated) — the auto-call
  // cron above only calls users who AREN'T past onboarding yet, so together
  // these cover before/after without overlap. 7-day cadence is a first
  // guess, not tuned. Hourly + hour-gated, same shape as ask-checkin/event
  // surfacing; last_companion_checkin_at always bumps on an attempt (sent
  // or the model deciding to skip) so a skip doesn't retry every tick.
  cron.schedule("0 * * * *", async () => {
    try {
      const due = await pool.query(
        `SELECT u.id AS user_id,
                (SELECT id FROM co_memories cm
                 WHERE cm.user_id = u.id AND cm.memory_type = 'recap'
                 ORDER BY cm.created_at DESC LIMIT 1) AS recap_id,
                (SELECT content FROM co_memories cm
                 WHERE cm.user_id = u.id AND cm.memory_type = 'recap'
                 ORDER BY cm.created_at DESC LIMIT 1) AS recap
         FROM users u
         JOIN co_profiles cp ON cp.user_id = u.id
         WHERE u.subscription_status = 'active'
           AND u.sms_opted_out = false
           AND cp.life_chapters IS NOT NULL AND array_length(cp.life_chapters, 1) IS NOT NULL
           AND cp.last_recap_at IS NOT NULL
           AND (cp.last_companion_checkin_at IS NULL OR cp.last_companion_checkin_at <= NOW() - INTERVAL '14 days')
         LIMIT 50`,
      );

      // Layer 7 (2026-09-14): queued, not sent. Lowest priority in the
      // harness, so it only goes out on a day nothing more timely is waiting.
      for (const row of due.rows) {
        if (!row.recap) continue;
        await enqueueCandidate({
          userId: row.user_id,
          type: "companion",
          targetKey: `companion:${row.recap_id}`,
          topicKey: "companion",
          summary: "No-reason check-in about one specific open thread from their recent recap (skip if there isn't one)",
          payload: { recap: row.recap },
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        }).catch((err: any) => console.error(`Companion check-in enqueue failed for ${row.user_id}:`, err?.message ?? err));
      }
    } catch (error) {
      console.error("Companion check-in cron error:", error);
    }
  });
}
