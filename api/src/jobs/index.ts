import cron from "node-cron";
import type { Server } from "socket.io";
import pool from "../db/db.js";
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
  // Hourly 10am–8pm UTC — call newly subscribed users who haven't completed intake yet.
  // Limits to 5 calls per run to avoid Twilio rate limits.
  // Won't retry a user who had a call attempt in the last 24 hours. Dials via
  // triggerCallForUser (the media-stream bridge) rather than a third
  // independent copy of the dial logic — this used to hit Hume's native
  // /v0/evi/twilio integration directly, which silently drops
  // first_name/context_summary.
  cron.schedule("0 10-20 * * *", async () => {
    try {
      const uncalled = await pool.query(
        `SELECT u.id
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
  cron.schedule("0 9 * * *", async () => {
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
        `SELECT ac.id, ac.ask_text, u.id AS user_id, u.first_name, u.phone_number, cp.city,
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
        for (const row of userRows) {
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
          // A normal cadence-cleared cycle always bumps regardless of outcome
          // (same reasoning as last_checked_at above: a miss should wait for
          // the next window, not retry every tick) — UNLESS the only reason
          // nothing sent was the unrelated cross-mechanism daily nudge cap
          // (Royce, 2026-08-30), which isn't a fact about this ask and
          // shouldn't cost it a 3-day wait. A day where the cooldown hadn't
          // cleared only bumps if the urgent check actually found and sent
          // something — a quiet urgent-check miss must NOT touch the clock,
          // or it would silently reset someone's normal 3-day cadence early.
          if (!throttled && (row.cooldown_cleared || sent)) {
            await pool.query(`UPDATE ask_checkins SET last_surfaced_at = NOW() WHERE id = $1`, [row.id]);
          }
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
