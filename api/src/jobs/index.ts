import cron from "node-cron";
import { DateTime } from "luxon";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { getTimezoneForCity } from "../services/geocoding.js";
import { isReasonableLocalHour } from "../services/localHours.js";
import sendblue from "../services/sendblue.js";
import { sweepAllOpenAsks } from "../services/relevance.js";
import { runAskCheckinAgent } from "../agent/askCheckin.js";
import { attemptEventSurfacing } from "../services/eventSurfacingSweep.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { sendDueFollowUps } from "./postCallFollowUp.js";
import { placeDueCalls, sendDueReminders } from "./scheduledCall.js";
import { placeDueProactiveCalls } from "./proactiveCheckinCall.js";
import { buildRecap, findUsersDueForRecap } from "../services/memoryCompaction.js";
import { sendDueOutcomeFollowUps } from "../services/recommendationOutcome.js";

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
          const result = await triggerCallForUser(user.id, io);
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

  // Every 10 min — delayed post-call reflection text (2h-2d out, rotating
  // shape). Scheduled rather than sent instantly at chat_ended — landing the
  // second the call ends read as a scripted status update, not something a
  // person who was actually listening would send.
  cron.schedule("*/10 * * * *", () => {
    sendDueFollowUps().catch((err) => console.error("postCallFollowUp: poll failed:", err?.message ?? err));
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

  // Co Loop Stage 5 — was fixed at 11am UTC (3am Pacific — the same class
  // of bug as the auto-call and event-surfacing crons, Royce 2026-09-02),
  // now hourly and gated on the recipient's own local hour (localHours.ts)
  // instead. Cadence is adaptive, not a flat 21 days: an ask with open
  // relevance_edges (Stage 3 found something) is checked every 14 days
  // since it's more "live"; an ask with no matches yet is checked every 30
  // days since there's nothing new to report. Repeats until Stage 6
  // (assessResolvedItems, profileExtraction.ts) marks it resolved. Message
  // is generated fresh at send time, same reasoning as the post-call
  // follow-up cron above — not stored/reused.
  cron.schedule("0 * * * *", async () => {
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
        const timezone = row.city ? await getTimezoneForCity(row.city) : null;
        if (!isReasonableLocalHour(timezone)) continue; // wrong hour for them — last_checked_at untouched, retried next hourly tick

        // Escalation framing, whether to mention match-absence, and whether
        // to fold in a topic nudge are no longer decided here — the agent
        // weighs those itself (agent/askCheckin.ts) using the raw
        // checkin_count/has_matches signals below instead of a hardcoded
        // threshold, and owns sending + logging the outcome.
        let sent = false;
        try {
          ({ sent } = await runAskCheckinAgent(row));
        } catch (err: any) {
          console.error(`Ask check-in failed for ${row.user_id}:`, err?.message ?? err);
        }
        // last_checked_at always bumps — same reasoning as every other
        // *_sent_at guard in this file: a permanently-failing (or
        // intentionally-skipped) cycle should not retry on every tick, it
        // should wait for the next cadence window like a successful send
        // would. checkin_count/awaiting_response_since only advance on an
        // actual send — a deliberate agent skip isn't a check-in attempt and
        // shouldn't count toward the escalation threshold the same way a
        // real (or failed) send does.
        await pool.query(
          sent
            ? `UPDATE ask_checkins
               SET last_checked_at = NOW(), checkin_count = checkin_count + 1, awaiting_response_since = NOW()
               WHERE id = $1`
            : `UPDATE ask_checkins SET last_checked_at = NOW() WHERE id = $1`,
          [row.id],
        );
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
  // Runs for EVERY open ask now, not just cadence-cleared ones (Royce,
  // 2026-08-30) — the urgency pre-check ("something cheap that scans for
  // something relevant to their wants/ask/intent") needs a daily look at
  // everyone so a time-sensitive match doesn't wait out someone else's
  // 3-day clock. cooldown_cleared tells attemptEventSurfacing whether to run
  // the full tiered engine or just the cheap urgent check — see
  // eventSurfacingSweep.ts.
  // Was fixed at 9am UTC = 2am Pacific — confirmed live, Royce 2026-09-02,
  // this is the exact cron that sent a "thinking about you" text at 2am to
  // a Walnut Creek user. Now hourly, gated per-user on their own local hour
  // (localHours.ts). Real cost gap caught before shipping this: this cron
  // already runs attemptEventSurfacing for EVERY open ask EVERY day
  // unconditionally (the urgency pre-check below), which calls real
  // embedding/Luma/LLM APIs on every invocation — naively adding an hour
  // gate and going hourly would re-run that expensive check on every one of
  // the ~11 hourly ticks inside a user's reasonable-hours window, not once.
  // last_attempted_at (new column, separate from last_surfaced_at's 3-day
  // cadence) gates "have we already run today's check for this ask",
  // independent of "is it currently a reasonable hour" — so the expensive
  // path still only actually runs once per local calendar day.
  cron.schedule("0 * * * *", async () => {
    try {
      // ORDER BY added (Royce, 2026-09-02: "Co is not prioritizing the
      // unresolved ask from the start") — a user with more than one open ask
      // had no defined processing order at all, and the one-nudge-per-day
      // cap (tryClaimProactiveNudge, claimed inside runEventDiscoverySurfacingAgent)
      // means whichever ask happens to process first in a given run wins
      // that day's single message; every ask after it just gets throttled.
      // A throttled ask doesn't lose its own cadence (see the update below),
      // so it isn't penalized in isolation — but if Postgres keeps returning
      // rows in the same order run after run (likely for a plain unindexed
      // scan), the same ask could keep winning indefinitely, starving the
      // others regardless of relevance or how long they've been waiting.
      // last_surfaced_at ASC NULLS FIRST gives the ask that's gone longest
      // without a successful send first crack each day — real rotation
      // instead of an accidental permanent winner.
      const due = await pool.query(
        `SELECT ac.id, ac.ask_text, ac.last_attempted_at, u.id AS user_id, u.first_name, u.phone_number, cp.city,
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

          let sent = false;
          let throttled = false;
          try {
            ({ sent, throttled } = await attemptEventSurfacing({
              askId: row.id,
              userId: row.user_id,
              firstName: row.first_name,
              phoneNumber: row.phone_number,
              askText: row.ask_text,
              city: row.city ?? null,
              goals: row.goals ?? null,
              activityPreferences: row.activity_preferences ?? null,
              cooldownCleared: row.cooldown_cleared,
            }));
          } catch (err: any) {
            console.error(`Event surfacing sweep failed for ${row.user_id}:`, err?.message ?? err);
          }
          // last_attempted_at always bumps on a real attempt — it's a "did
          // we run today's check" marker, separate from the cadence clock.
          // last_surfaced_at (the 3-day cadence) only bumps under the same
          // condition as before: a normal cadence-cleared cycle always
          // advances it regardless of outcome, UNLESS the only reason
          // nothing sent was the unrelated cross-mechanism daily nudge cap
          // (Royce, 2026-08-30) — a quiet urgent-check miss must not touch
          // that clock, or it would silently reset someone's 3-day cadence
          // early.
          await pool.query(
            !throttled && (row.cooldown_cleared || sent)
              ? `UPDATE ask_checkins SET last_attempted_at = NOW(), last_surfaced_at = NOW() WHERE id = $1`
              : `UPDATE ask_checkins SET last_attempted_at = NOW() WHERE id = $1`,
            [row.id],
          );
        }
      });
    } catch (error) {
      console.error("Event surfacing sweep cron error:", error);
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

  // Outcome-learning loop (Royce, 2026-09-02: "Co follows up" + shared
  // signal classifier + wiring weighting into future matching — Notion V1
  // board rows 7/12/13). Every 15 min, same cadence as the other lightweight
  // polling crons (scheduledCall, proactiveCheckinCall) — this just polls
  // for due rows and claims atomically, cheap even run often.
  cron.schedule("*/15 * * * *", () => {
    sendDueOutcomeFollowUps().catch((err) => console.error("recommendationOutcome: poll failed:", err?.message ?? err));
  });
}
