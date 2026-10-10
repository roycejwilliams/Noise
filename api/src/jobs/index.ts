import { goalTexts } from "../services/goalJourney.js";
import { runGoalSweep } from "../services/goalSweep.js";
import cron from "./cron.js";
import { sendDueCoEventAnnouncements } from "../services/coEventAnnouncement.js";
import { DateTime } from "luxon";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { hoursZone, isReasonableLocalHour } from "../services/localHours.js";
import { sweepAllOpenAsks } from "../services/relevance.js";
import { attemptEventSurfacing, PROFILE_ASK_ID } from "../services/eventSurfacingSweep.js";
import { attemptNetworkSurfacing } from "../services/networkIntroNudge.js";
import { scoreGuestListForEvent } from "../services/eventScoring.js";
import { runArrivalAsks, runPresencePoll } from "../services/eventPresence.js";
import { runEventBriefs } from "../services/eventBrief.js";
import { releaseStrandedClaims } from "../services/strandedClaims.js";
import { listCalendarEvents, getEventDetails } from "../services/luma.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { enqueueDuePostCallFollowUps } from "./postCallFollowUp.js";
import { placeDueCalls, sendDueReminders } from "./scheduledCall.js";
import { placeDueProactiveCalls } from "./proactiveCheckinCall.js";
import { buildRecap, expireRecaps, findUsersDueForRecap } from "../services/memoryCompaction.js";
import { enqueueDebrief, enqueueDueOutcomeFollowUps } from "../services/recommendationOutcome.js";
import { enqueueDueEventCheckinFollowUps } from "../services/eventCheckinFollowUp.js";
import { processDueUnmatchedFollowUps } from "../services/eventUnmatchedFollowUp.js";
import { runEventChangeNotificationAgent } from "../agent/eventChangeNotification.js";
import type { AskCheckinPayload } from "../agent/askCheckin.js";
import { enqueueCandidate, runProactiveDispatch, sendExempt } from "../harness/proactive.js";
import { proactiveRegistry } from "../harness/proactiveRegistry.js";
import { runMonitor, runWeeklyReview } from "../harness/monitor.js";
import { typesWithPurpose } from "../harness/proactivePurpose.js";
import { reviewEnabled } from "../harness/devReview.js";
import { expireStaleAsks } from "../services/askExpiry.js";
import { classifyOpenAsks, syncClosedAsks } from "../services/askKind.js";
import { companionPayloadFor } from "../harness/memberThreads.js";
import { queueHeavyCheckins } from "../services/heavyMoment.js";
import { gapDescription, lastLearned, QUIET_UNDERSTANDING_DAYS, understandingGaps } from "../services/understanding.js";
import { recordDecision } from "../harness/core.js";
import { missedCallText } from "../harness/callGate.js";
import { runAdviceFollowUps, runWeeklyReflections } from "../harness/memberReflection.js";
import { runMembershipLapse } from "../services/membershipLapse.js";
import { extensionJobs } from "../services/extensions.js";

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

// Consistent with the gate-side attempt cap the calls agent is adding to
// src/harness/callGate.ts (code review, 2026-09-17) — this cron's own
// selection query stops offering a user up once they've hit it, rather than
// relying solely on the gate to keep rejecting an endless stream of
// attempts.
const MAX_AUTO_INTAKE_ATTEMPTS = 3;

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
      // Selection rewritten (code review, 2026-09-17): "empty life_chapters"
      // isn't the same thing as "intake isn't done" — life_chapters can stay
      // empty even after a real intake call or a profile with real content
      // (a goals/activity_preferences/intent extraction gap, not a reason to
      // keep calling someone who already came through intake). Now excludes
      // anyone whose identity isn't captured yet (a text-first placeholder
      // row, not someone to cold-call) or who already has a completed call
      // transcript (not just an attempt marker — callTrigger.ts's own
      // "Co initiated call to..." row) or a profile with any real content.
      // MAX_AUTO_INTAKE_ATTEMPTS caps attempts consistent with the gate-side
      // cap the calls agent is adding to src/harness/callGate.ts (not owned
      // here) — attempts counted the same way callGate.ts already counts
      // them, via the "Co initiated call to..." attempt-marker rows.
      const uncalled = await pool.query(
        `SELECT u.id, cp.city
         FROM users u
         LEFT JOIN co_profiles cp ON cp.user_id = u.id
         WHERE u.subscription_status = 'active'
           AND COALESCE(u.identity_captured, true) = true
           AND NOT EXISTS (
             SELECT 1 FROM co_memories cm
             WHERE cm.user_id = u.id
               AND cm.memory_type = 'call_transcript'
               AND cm.created_at > NOW() - INTERVAL '24 hours'
           )
           AND NOT EXISTS (
             SELECT 1 FROM co_memories cm2
             WHERE cm2.user_id = u.id AND cm2.memory_type = 'call_transcript'
               AND cm2.content NOT LIKE 'Co initiated call%'
           )
           AND (
             cp.user_id IS NULL
             OR (
               (cp.life_chapters IS NULL OR array_length(cp.life_chapters, 1) IS NULL)
               AND (cp.goals IS NULL OR array_length(cp.goals, 1) IS NULL)
               AND (cp.activity_preferences IS NULL OR array_length(cp.activity_preferences, 1) IS NULL)
               AND jsonb_array_length(COALESCE(cp.intent, '[]'::jsonb)) = 0
             )
           )
           AND (
             SELECT COUNT(*) FROM co_memories cm3
             WHERE cm3.user_id = u.id AND cm3.memory_type = 'call_transcript'
               AND cm3.content LIKE 'Co initiated call%'
           ) < ${MAX_AUTO_INTAKE_ATTEMPTS}
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
  // under the gates in src/harness/proactive.ts and sends it: local hours; per
  // lane (rooms and people vs. everything else) 1/day, and 4/week or 3/week;
  // a pause after an unanswered text, 24h after one and 72h after two in a row
  // (one-way: check-ins never pause events); no repeats.
  let dispatchRunning = false;
  const runDispatch = async () => {
    if (dispatchRunning) return;
    dispatchRunning = true;
    try {
      await runProactiveDispatch(proactiveRegistry);
    } catch (err: any) {
      console.error("proactive dispatch cron error:", err?.message ?? err);
    } finally {
      dispatchRunning = false;
    }
  };
  // Not on the hour or half hour: the surfacing sweeps run then, and each one
  // calls runDispatch itself when it finishes queueing. Dispatching at the same
  // minute sent one tier's offer three seconds before the sweep had queued the
  // others (2026-09-21), so the offers of every tier could not go out together.
  cron.schedule("15,45 * * * *", runDispatch);

  // Texts whose turn never finished, or whose retry a restart cut off, run
  // again from their saved copy when it's safe (routes/sendblue.ts
  // reportUnfinishedTurns). Also run once at startup (server.ts).
  cron.schedule("*/2 * * * *", async () => {
    try {
      const { reportUnfinishedTurns } = await import("../routes/sendblue.js");
      await reportUnfinishedTurns();
    } catch (err: any) {
      console.error("unfinished turn cron error (non-fatal):", err?.message ?? err);
    }
  });

  // Reminders members asked for ("remind me Thursday to follow up with…"),
  // sent to them only (services/relay.ts). Every 5 minutes; nothing's due unless asked.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { sendDueReminders } = await import("../services/relay.js");
      await sendDueReminders();
    } catch (err: any) {
      console.error("reminder cron error (non-fatal):", err?.message ?? err);
    }
  });

  // Texts held for the member's hours (services/deferredSends.ts: relays, reminders, heads-ups, intro asks, the after-call
  // confirmation at night), sent once due through sendExempt (STOP, pause, hours checked again). Every minute; rows are
  // claimed, so overlapping runs or instances never send one twice.
  cron.schedule("* * * * *", async () => {
    try {
      const { runDueDeferredSends } = await import("../services/deferredSends.js");
      await runDueDeferredSends();
    } catch (err: any) {
      console.error("deferred send cron error (non-fatal):", err?.message ?? err);
    }
  });

  // A document whose PDF failed went as text (services/documentDelivery.ts); the PDF it promised follows from here, inside their
  // delivery hours, with backoff, never the text again (deliveryReceipts.ts receipts in pdf_pending).
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { retryPendingPdfs } = await import("../services/documentDelivery.js");
      await retryPendingPdfs();
    } catch (err: any) {
      console.error("pdf retry cron error (non-fatal):", err?.message ?? err);
    }
  });

  // What Co said on a call it would send (services/callCommitments.ts): once it has had time to fall due, was a text actually sent?
  cron.schedule("*/10 * * * *", async () => {
    try {
      const { checkCallCommitments } = await import("../services/callCommitments.js");
      await checkCallCommitments();
    } catch (err: any) {
      console.error("call commitment check error (non-fatal):", err?.message ?? err);
    }
  });

  // Things Co sent in the last 3 days are re-read every few hours
  // (services/linkReader.ts); if one that someone was interested in sold out,
  // moved or disappeared, they hear it once (services/staleWatch.ts). Luma
  // reads are free; others about $0.007 each.
  // Co's own tasks (services/coTasks.ts): each wakes when Co said it would.
  cron.schedule("*/15 * * * *", async () => {
    try {
      // Loops that changed while they were away wake their task first
      // (services/openLoops.ts), so this same pass decides whether to speak.
      const { runLoopSync } = await import("../services/openLoops.js");
      await runLoopSync().catch((err: any) => console.error("loop sync error:", err?.message ?? err));
      const { runDueTasks } = await import("../services/taskTurn.js");
      await runDueTasks();
      const { runLoopDecay } = await import("../services/openLoops.js");
      await runLoopDecay().catch((err: any) => console.error("loop decay error:", err?.message ?? err));
      // Finds shown and never reacted to become "ignored" after their window (services/researchQuality.ts): a ranking signal too.
      const { markIgnoredFinds } = await import("../services/researchQuality.js");
      await markIgnoredFinds().catch((err: any) => console.error("ignored finds error:", err?.message ?? err));
    } catch (err: any) {
      console.error("task wake cron error:", err?.message ?? err);
    }
  });

  // Hourly: Co acts on what it's carrying for each member when something changed (services/memberStateNudges.ts): an intro they
  // haven't brought up, a deadline on something they said yes to, a goal gone quiet, something they said they'd do coming due. It
  // only queues candidates; the :15/:45 dispatch decides if and when (hours, pause, opt-out, caps, spacing, restraint). Then the
  // learned kind preferences are brought up to date (services/kindRestraint.ts), so a member who keeps letting one kind of text pass
  // is recorded even when nothing is waiting for them.
  cron.schedule("5 * * * *", async () => {
    try {
      const { runMemberStateNudges } = await import("../services/memberStateNudges.js");
      await runMemberStateNudges().catch((err: any) => console.error("member-state nudges error:", err?.message ?? err));
      const { runKindRestraintSync } = await import("../services/kindRestraint.js");
      await runKindRestraintSync().catch((err: any) => console.error("kind restraint sync error:", err?.message ?? err));
    } catch (err: any) {
      console.error("member-state cron error:", err?.message ?? err);
    }
  });

  cron.schedule("40 * * * *", async () => {
    try {
      const { watchSentPages } = await import("../services/staleWatch.js");
      await watchSentPages();
    } catch (err: any) {
      console.error("stale watch cron error (non-fatal):", err?.message ?? err);
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
      // sms_opted_out filter added here as a cheap first pass (code review,
      // 2026-09-17: this cron never checked it at all); sendExempt below is
      // the real, race-safe enforcement since it re-reads the row inside the
      // send transaction.
      const due = await pool.query(
        `SELECT pcf.id, pcf.call_status, u.id AS user_id, u.first_name, u.phone_number, cp.city
         FROM pending_call_followups pcf
         JOIN users u ON u.id = pcf.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = pcf.user_id
         WHERE pcf.due_at <= NOW() AND pcf.sent_at IS NULL AND COALESCE(u.sms_opted_out, false) = false`,
      );

      for (const row of due.rows) {
        const timezone = row.city ? await getTimezoneForCity(row.city) : null;
        if (!isReasonableLocalHour(timezone)) continue;

        // No retry is scheduled after a miss, so the text invites rather than promises (harness/callGate.ts missedCallText).
        const text = missedCallText(row.first_name);
        try {
          // Transactional: one per missed call through the proactive ledger
          // (sendExempt logs text_exchange), outside the daily pick.
          await sendExempt({
            userId: row.user_id,
            phoneNumber: row.phone_number,
            type: "missed_call",
            targetKey: `missed_call:${row.id}`,
            messages: [text],
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
      // sms_opted_out filter added here as a cheap first pass (code review,
      // 2026-09-17: this cron never checked it at all); sendExempt inside
      // runEventChangeNotificationAgent is the real, race-safe enforcement.
      // ecn.event_id comes from migrations.ts (added 2026-09-18; before that
      // this query failed every run). COALESCE covers rows queued without one.
      const due = await pool.query(
        `SELECT ecn.id, ecn.user_id, COALESCE(ecn.event_id, '') AS event_id, ecn.event_name, ecn.message, u.first_name, u.phone_number, cp.city
         FROM event_change_notifications ecn
         JOIN users u ON u.id = ecn.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = ecn.user_id
         WHERE ecn.sent_at IS NULL AND COALESCE(u.sms_opted_out, false) = false`,
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
            row.event_id,
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

  // Goal check-ins: rare and seasonal, never on the 7-day ask clock (services/goalJourney.ts). Daily is only how often it LOOKS.
  cron.schedule("0 11 * * *", async () => {
    try {
      await (await import("../services/goalJourney.js")).runGoalCheckins();
    } catch (error) {
      console.error("Goal check-in cron error:", error);
    }
  }, { timezone: "America/Los_Angeles" });

  // Co Loop Stage 5 check-in on an open ask. Layer 7 (2026-09-14): queues an
  // "ask_checkin" candidate only when there's movement (a new possible match
  // logged for this ask since the last check-in, at least 3 days on) or 7
  // days have passed (14 until 2026-09-22); the harness decides when it goes out. The target key
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
             COALESCE(ac.last_checked_at, ac.created_at) <= NOW() - INTERVAL '7 days'
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
  const MAX_ASK_SEARCHES_PER_USER_PER_DAY = 4;
  // The working set's daily pass (services/workingSet.ts), before the morning sweep: factual exits for everyone, each with its fact.
  cron.schedule("30 7 * * *", async () => {
    try {
      const [W, S] = await Promise.all([import("../services/workingSet.js"), import("../services/sweepShadow.js")]);
      const r = await W.pruneAllWorkingSets(S.realPruneDeps as any);
      console.log(`Working set: ${r.goneAsks} ask(s) and ${r.goneItems} item(s) of gone members closed, ${r.pruned} backlog item(s) exited`);
    } catch (err: any) {
      console.error("Working set daily pass failed (non-fatal):", err?.message ?? err);
    }
  }, { timezone: "America/Los_Angeles" });
  cron.schedule("0 * * * *", async () => {
    try {
      // Asks past their time limit are closed before anything searches them
      // (services/askExpiry.ts).
      const expiry = await expireStaleAsks().catch((err: any) => {
        console.error("expireStaleAsks failed (non-fatal):", err?.message ?? err);
        return null;
      });
      if (expiry?.expired) console.log(`Ask expiry: closed ${expiry.expired} ask(s) past their time limit`);
      // Living asks (services/askKind.ts, 2026-09-26): only asks a search can
      // find are searched; what they brought up in the last few days goes
      // first, then the rest by oldest-searched, so one ask can't win every day.
      // Asks Co has answered or delivered close here, on evidence (services/askLifecycle.ts), before anything searches them.
      await import("../services/askLifecycle.js").then((m) => m.closeAnsweredAsksAll()).catch((err: any) => console.error("Ask lifecycle: closing answered asks failed (non-fatal):", err?.message ?? err));
      await classifyOpenAsks().catch((err: any) => console.error("Ask kinds: classify failed (non-fatal):", err?.message ?? err));
      // The working set (services/workingSet.ts): a member who's gone has nothing live; an ask that came back empty too many times
      // exits as "searched, nothing found". Each exit writes its fact to the member's record first.
      await import("../services/workingSet.js")
        .then(async (W) => {
          const gone = await W.exitGoneMembersAsks();
          if (gone) console.log(`Working set: closed ${gone} ask(s) of members who are gone`);
          const { rows: tired } = await pool.query(`SELECT id, ask_id, user_id, ask_text, empty_runs FROM ask_checkins WHERE resolved_at IS NULL AND kind = 'find' AND empty_runs >= $1`, [W.ASK_BACKOFF.exitAfter]);
          for (const t of tired) await W.exitAsk({ userId: t.user_id, askRowId: String(t.id), askId: String(t.ask_id), text: String(t.ask_text ?? ""), state: "expired", closedReason: "nothing_found", reason: `searched ${t.empty_runs} times, nothing found`, scope: "this ask; saying it again opens a new search" });
        })
        .catch((err: any) => console.error("Working set: exits failed (non-fatal):", err?.message ?? err));
      await syncClosedAsks().catch((err: any) => console.error("Ask sync failed (non-fatal):", err?.message ?? err));
      const due = await pool.query(
        `SELECT ac.id, ac.ask_id, ac.ask_text, ac.last_attempted_at, ac.kind, ac.empty_runs, u.id AS user_id, u.first_name, u.phone_number, cp.city,
                cp.goals, cp.intent, cp.activity_preferences,
                (ac.last_surfaced_at IS NULL OR ac.last_surfaced_at <= NOW() - INTERVAL '3 days') AS cooldown_cleared
         FROM ask_checkins ac
         JOIN users u ON u.id = ac.user_id
         LEFT JOIN co_profiles cp ON cp.user_id = ac.user_id
         -- Only live items of live members (services/workingSet.ts): an archived or opted-out member is swept zero times. Person asks
         -- go to intros below, never to the event and page search.
         WHERE ac.resolved_at IS NULL AND ac.kind IN ('find', 'person')
           AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false AND u.phone_number IS NOT NULL
         ORDER BY (COALESCE(ac.last_mentioned_at, ac.created_at) > NOW() - INTERVAL '3 days') DESC,
                  ac.last_attempted_at ASC NULLS FIRST, ac.last_surfaced_at ASC NULLS FIRST`,
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

        // Zero sweeps for a member dispatch would hold every find for (harness/proactive.ts sweepHold, Phase A3): opted out, a hold,
        // the space after a task, a safety hold. An answer to their ask skips the discovery pace, so only these stop it. Today's
        // check counts as done (each due ask is marked), so it's looked at again tomorrow, not every hour.
        const fresh = userRows.filter((r) => !r.last_attempted_at || DateTime.fromJSDate(r.last_attempted_at).setZone(hoursZone(timezone)).toISODate() !== DateTime.now().setZone(hoursZone(timezone)).toISODate());
        if (fresh.length) {
          const { sweepHold } = await import("../harness/proactive.js");
          const held = await sweepHold(userRows[0].user_id, "ask").catch(() => ["gate_unreadable"]);
          if (held.length) {
            await pool.query(`UPDATE ask_checkins SET last_attempted_at = NOW() WHERE id = ANY($1::uuid[])`, [fresh.map((r) => r.id)]).catch(() => {});
            await recordDecision({ layer: 5, decision: "sweep.held", userId: userRows[0].user_id, outcome: "skip", action: held.join(","), proposal: { asks: fresh.length } }).catch(() => {});
            return;
          }
        }

        const localToday = DateTime.now().setZone(hoursZone(timezone)).toISODate(); // their day, or Pacific's (never the server's UTC day)
        const localDayOf = (d: Date | null) => (d ? DateTime.fromJSDate(d).setZone(hoursZone(timezone)).toISODate() : null);
        // At most this many of one person's asks get a full search per day
        // (2026-09-18: one tester's ten overlapping asks each ran a full
        // three-tier search every morning and kept finding the same events).
        // Rows come least-recently-searched first, so every ask gets its turn.
        let searchedToday = userRows.filter((r) => localDayOf(r.last_attempted_at) === localToday).length;

        for (const row of userRows) {
          if (localDayOf(row.last_attempted_at) === localToday) continue; // already ran today's check for this ask — don't re-run every hourly tick inside the window
          // An ask that keeps coming back empty backs off (services/workingSet.ts askSearchDue): every few days, not every morning.
          const { askSearchDue } = await import("../services/workingSet.js");
          if (!askSearchDue(row)) continue;
          if (searchedToday >= MAX_ASK_SEARCHES_PER_USER_PER_DAY) break;
          searchedToday++;

          // A person to meet or talk to is met by an intro, never by searching events and pages (askKind.ts "person").
          if (row.kind === "person") {
            await pool.query(`UPDATE ask_checkins SET last_attempted_at = NOW() WHERE id = $1`, [row.id]);
            await attemptNetworkSurfacing(row.user_id, row.first_name, row.phone_number, row.ask_id).catch((err: any) => console.error(`Network surfacing for a person ask failed for ${row.user_id}:`, err?.message ?? err));
            continue;
          }

          try {
            await attemptEventSurfacing({
              askId: row.id,
              userId: row.user_id,
              firstName: row.first_name,
              phoneNumber: row.phone_number,
              askText: row.ask_text,
              city: row.city ?? null,
              // Offers are judged against the ask AND where they are headed: profile goals plus goal-typed entries (services/goalJourney.ts).
              goals: goalTexts(row.intent, row.goals).length ? goalTexts(row.intent, row.goals) : null,
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
      // Queueing is done; send whatever tiers are waiting, together.
      await runDispatch();
    } catch (error) {
      console.error("Event surfacing sweep cron error:", error);
    }
  });

  // Goal-based discovery (Royce, 2026-09-14: "it should be actively searching for all 3 tiers"; 2026-10-06: split from asks).
  // Search text comes from where they are headed (goals, interests, direction), never from an ask; the drafts say so instead of
  // claiming they asked, and there is no network surfacing (that needs a real ask). Every member with a direction has their own budget
  // (one attempt per 20 hours, one find per 3 days, services/goalSweep.ts), whether or not they have open asks.
  cron.schedule("30 * * * *", async () => {
    try {
      // Goal-based discovery (services/goalSweep.ts): every member with a direction has their own budget; open asks neither block it
      // nor boost it (2026-10-06: it used to run only for members with NO open ask, so engaged members got less discovery).
      await runGoalSweep(runWithConcurrency);
      await runDispatch();
    } catch (error) {
      console.error("Goal sweep cron error:", error);
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

  // Frees arrival asks and match nudges a restart or crash marked as sent
  // without sending (services/strandedClaims.ts), so the runs above and
  // below retry them.
  cron.schedule("*/5 * * * *", async () => {
    await releaseStrandedClaims();
  });

  // Day-of arrival ask (services/eventPresence.ts, 2026-09-23): from 10am
  // local on the event day, each registered member is asked once to share
  // their location or text "I'm here" when they arrive.
  cron.schedule("*/15 * * * *", async () => {
    try {
      const sent = await runArrivalAsks();
      if (sent) console.log(`eventPresence: sent ${sent} arrival ask(s)`);
    } catch (error: any) {
      console.error("Arrival ask cron error:", error?.message ?? error);
    }
  });

  // The member brief (services/eventBrief.ts, 2026-10-05): the one RSVP question that lets it name them, and the
  // brief itself the day before. Both only queue; the daily pick sends within their hours and caps.
  cron.schedule("*/15 * * * *", async () => {
    try {
      const r = await runEventBriefs();
      if (r.asks || r.briefs) console.log(`eventBrief: queued ${r.asks} name question(s), ${r.briefs} brief(s)`);
    } catch (error: any) {
      console.error("Event brief cron error:", error?.message ?? error);
    }
  });

  // The partner readout's draft, 12 hours after a Co event ends (services/partnerReadoutSend.ts). Drafts only: the team is emailed
  // that it's ready, and nothing reaches a host until a person approves and sends it.
  cron.schedule("25 * * * *", async () => {
    try {
      const { runReadoutDrafts } = await import("../services/partnerReadoutSend.js");
      const n = await runReadoutDrafts();
      if (n) console.log(`partnerReadout: drafted ${n} readout(s)`);
    } catch (error: any) {
      console.error("Partner readout cron error:", error?.message ?? error);
    }
  });

  // Arrivals and departures from shared locations, every 2 minutes, only
  // while a Co event is on (it returns right away otherwise). An arrival
  // re-runs that event's in-room scoring so their nudge goes out now.
  let presenceRunning = false;
  cron.schedule("*/2 * * * *", async () => {
    if (presenceRunning) return;
    presenceRunning = true;
    try {
      for (const eventId of await runPresencePoll()) {
        await scoreGuestListForEvent(eventId).catch((err: any) =>
          console.error(`Presence re-score failed for ${eventId}:`, err?.message ?? err),
        );
      }
    } catch (error: any) {
      console.error("Presence poll cron error:", error?.message ?? error);
    } finally {
      presenceRunning = false;
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
        //
        // Code review, 2026-09-17: this used to discard enqueueDebrief's
        // result. When it came back {queued:false} (the debrief candidate
        // for this event had already resolved via another source before
        // this row got its turn), this row's id never made it into any
        // payload, so followup_sent_at never got set by the harness either
        // — the WHERE clause above kept matching it and this cron called
        // Luma's getEventDetails for it again every 15 minutes, forever.
        // Marking followup_sent_at here directly on a non-queue mirrors the
        // registry's own onDropped convention for this table (a resolved
        // slot, not literally "a text was sent" — see proactiveRegistry.ts).
        for (const row of eventRows) {
          try {
            const timezone = row.city ? await getTimezoneForCity(row.city).catch(() => null) : null;
            const result = await enqueueDebrief({
              userId: row.user_id,
              eventApiId: eventApiId,
              eventName: details.name,
              eventEnd: new Date(details.end_at),
              timezone,
              part: { walkinCheckinIds: [row.id], askText: row.ask_text ?? null },
            });
            if (!result.queued) {
              await pool.query(`UPDATE event_walkin_checkins SET followup_sent_at = NOW() WHERE id = $1`, [row.id]);
            }
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
      // And, with no model call, what has expired leaves every recap whether or not they said anything new (services/claims.ts).
      await expireRecaps();
    } catch (error) {
      console.error("Memory compaction cron error:", error);
    }
  });

  // Decision log monitoring: hourly spike alerts, weekly review email
  // (harness/monitor.ts). Paused (Royce, 2026-09-15: "Pause 4 for now");
  // set MONITORING_ENABLED=true to turn it back on.
  // The morning "what broke" email is OFF (Royce, 2026-10-06: "No more morning emails"): no 8am run, no email, and no
  // daily model spend on it. Read the same digest on demand with `npm run broke` (prints, never sends).
  if (reviewEnabled()) {
    // The shadow week (services/sweepShadow.ts): Co's sweep selection on
    // Royce's real candidates, after the 9am sweep, sending nothing. Read with
    // `npm run shadow`.
    cron.schedule("0 10 * * *", () => {
      import("../services/sweepShadow.js")
        .then((m) => m.runSweepShadowAll())
        .catch((err: any) => console.error("sweep shadow cron error:", err?.message ?? err));
    }, { timezone: "America/Los_Angeles" });
  }

  if (process.env.MONITORING_ENABLED === "true") {
    cron.schedule("23 * * * *", () => {
      runMonitor().catch((err: any) => console.error("monitor cron error:", err?.message ?? err));
    });
    cron.schedule("7 16 * * 1", () => {
      runWeeklyReview().catch((err: any) => console.error("weekly review cron error:", err?.message ?? err));
    });
  }

  // Weekly reflection per member (2026-09-22, harness/memberReflection.ts):
  // Sunday evening Pacific, so a queued check-in can go out Monday.
  cron.schedule("0 18 * * 0", () => {
    runWeeklyReflections().catch((err: any) => console.error("weekly reflection cron error:", err?.message ?? err));
  }, { timezone: "America/Los_Angeles" });

  // Advice Co gave a few days ago, asked about once (services/advice.ts).
  cron.schedule("30 17 * * *", () => {
    runAdviceFollowUps().catch((err: any) => console.error("advice follow-up cron error:", err?.message ?? err));
  }, { timezone: "America/Los_Angeles" });

  // Extensions' schedules (services/extensions.ts), each only while that
  // extension is enabled. Mo (src/mo/, off unless MO_ENABLED=true) finds
  // people weekly, brings approvers the next person daily, and acts on
  // approved prospects and replies in Co's X DMs.
  extensionJobs()
    .then((jobs) => {
      for (const job of jobs) {
        cron.schedule(job.cron, () => {
          job.run().catch((err: any) => console.error(`${job.name} cron error:`, err?.message ?? err));
        }, job.timezone ? { timezone: job.timezone } : undefined);
      }
    })
    .catch((err: any) => console.error("extension jobs failed to register:", err?.message ?? err));

  // Members Co knows nothing about (2026-09-22, services/membershipLapse.ts):
  // once a day; each step still waits for the proactive harness to send it.
  cron.schedule("30 9 * * *", () => {
    runMembershipLapse().catch((err: any) => console.error("membership lapse cron error:", err?.message ?? err));
  }, { timezone: "America/Los_Angeles" });

  // Co's own events: send announcements that were waiting for the person's
  // daytime hours (services/coEventAnnouncement.ts).
  cron.schedule("*/10 * * * *", () => {
    sendDueCoEventAnnouncements().catch((err: any) => console.error("co event announcement cron error:", err?.message ?? err));
  });

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

  // "No one should feel left out" (Royce, 2026-09-22) — same lightweight
  // polling cadence as the two crons right above; due rows fire near the end
  // of the event, not hours later, so 15 minutes stays close enough to still
  // read as "at the event."
  cron.schedule("*/15 * * * *", () => {
    processDueUnmatchedFollowUps().catch((err: any) => console.error("eventUnmatchedFollowUp: process failed:", err?.message ?? err));
  });

  // The next-day check-in after something hard (services/heavyMoment.ts):
  // queued here, sent by the proactive harness under its usual caps.
  cron.schedule("30 * * * *", () => {
    queueHeavyCheckins().catch((err: any) => console.error("heavy check-in queue failed:", err?.message ?? err));
  });

  // Companion check-in (Royce, 2026-09-03: "how can we make it a companion
  // with what we have now" — every other proactive text has a reason
  // attached (an ask, an event, an outcome); this is the one that
  // doesn't). Seeded by the recap memoryCompaction.ts already builds —
  // previously pure internal bookkeeping, never surfaced to the user.
  // No paid subscription needed (2026-09-22, Royce): it was gated on
  // subscription_status = 'active', which no co-test member has, so not one
  // had ever been queued. The companion is the product, not a paid extra.
  // Also queued early after a stretch of offers with nothing about the
  // person (see the query). Sent first when it's eligible (proactive.ts
  // codePick).
  // Needs a recap, not life chapters (2026-09-22): the check-in is written
  // from the recap, and life chapters mostly come from calls, so a member who
  // only texts could never qualify. (Earlier note, kept for history:)
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
                 ORDER BY cm.created_at DESC LIMIT 1) AS recap,
                cp.topics_covered, cp.topics_asked
         FROM users u
         JOIN co_profiles cp ON cp.user_id = u.id
         WHERE u.sms_opted_out = false
           AND u.archived_at IS NULL
           AND u.identity_captured = true
           AND cp.last_recap_at IS NOT NULL
           AND (
             (cp.last_companion_checkin_at IS NULL OR cp.last_companion_checkin_at <= NOW() - INTERVAL '4 days')
             -- A stretch of offers with nothing about them: 3+ days with an
             -- offer and no companion message in the last 7 (2026-09-22).
             OR (
               (SELECT count(DISTINCT date_trunc('day', ps.sent_at)) FROM proactive_sends ps
                 WHERE ps.user_id = u.id AND ps.sent_at > NOW() - INTERVAL '7 days' AND ps.type = ANY($1::text[])) >= 3
               AND NOT EXISTS (SELECT 1 FROM proactive_sends ps
                 WHERE ps.user_id = u.id AND ps.sent_at > NOW() - INTERVAL '7 days' AND ps.type = ANY($2::text[]))
             )
           )
         LIMIT 50`,
        [typesWithPurpose("offer"), typesWithPurpose("companion")],
      );

      // Layer 7 (2026-09-14): queued, not sent. Lowest priority in the
      // harness, so it only goes out on a day nothing more timely is waiting.
      for (const row of due.rows) {
        if (!row.recap) continue;
        // Already waiting in the queue: leave it (the hourly re-enqueue would
        // otherwise run a new web lookup every hour).
        const pending = await pool.query(
          `SELECT 1 FROM proactive_candidates WHERE user_id = $1 AND type = 'companion' AND status = 'pending' LIMIT 1`,
          [row.user_id],
        );
        if (pending.rows[0]) continue;
        // One open thread and at most one useful thing for it (2026-09-22,
        // harness/memberThreads.ts); the recap alone when nothing's open.
        const parts = await companionPayloadFor(row.user_id).catch(() => null);
        // Nothing open to ask about: the one thing Co is still figuring out
        // about them, with their own recent words, so the check-in only asks
        // where the conversation leads (services/understanding.ts).
        const gaps = understandingGaps(row.topics_covered, row.topics_asked);
        const learned = lastLearned(row.topics_covered);
        await recordDecision({
          layer: 7,
          decision: "understanding.check",
          userId: row.user_id,
          outcome: learned && Date.now() - new Date(learned).getTime() < QUIET_UNDERSTANDING_DAYS * 86_400_000 ? "act" : "skip",
          action: gaps.length ? `gaps:${gaps.length}` : "no_gaps",
          proposal: { lastLearned: learned, gaps: gaps.slice(0, 4).map((g) => `${g.kind}:${g.topic}`) },
        }).catch(() => {});
        let curious: { topic: string; about: string; theirWords: string } | null = null;
        if (!parts?.thread && gaps.length) {
          const { rows: said } = await pool.query(
            `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' ORDER BY created_at DESC LIMIT 14`,
            [row.user_id],
          );
          const convo = said.reverse().map((r: any) => String(r.content)).join("\n").slice(-2000);
          if (convo.includes("User said:")) curious = { topic: gaps[0].topic, about: gapDescription(gaps[0]), theirWords: convo };
        }
        await recordDecision({
          layer: 7,
          decision: "proactive.companionPayload",
          userId: row.user_id,
          outcome: parts?.thread ? "act" : "skip",
          action: parts?.item ? "thread_with_item" : parts?.thread ? "thread" : "recap_only",
          proposal: { threadId: parts?.threadId ?? null, thread: parts?.thread ?? null, item: parts?.item ?? null },
          checks: parts?.checks ?? [],
        }).catch(() => {});
        await enqueueCandidate({
          userId: row.user_id,
          type: "companion",
          targetKey: parts?.threadId ? `companion:thread:${parts.threadId}:${row.recap_id}` : `companion:${row.recap_id}`,
          topicKey: "companion",
          summary: parts?.thread
            ? `Check in on "${parts.thread.text.slice(0, 80)}"${parts.item ? " with one thing found for it" : ""}`
            : curious
              ? `Pick up something they said that leads to ${curious.about.slice(0, 80)}, or one way Co could help (skip if nothing they said leads there)`
              : "No-reason check-in about one specific open thread from their recent recap (skip if there isn't one)",
          payload: { recap: row.recap, threadId: parts?.threadId ?? null, thread: parts?.thread ?? null, item: parts?.item ?? null, curious },
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        }).catch((err: any) => console.error(`Companion check-in enqueue failed for ${row.user_id}:`, err?.message ?? err));
      }
    } catch (error) {
      console.error("Companion check-in cron error:", error);
    }
  });
}
