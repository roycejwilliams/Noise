import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { MODELS } from "../models.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { writeMemory } from "./memory.js";
import { inRoomSendAllowed, recordInRoomSend } from "../harness/proactive.js";
import { draftWithConsent } from "../harness/introConsent.js";
import { MATCH_NUDGE_END_CUTOFF_MINUTES, withEnd } from "../harness/introConsent.js";
import { wasAlreadyNudgedForMatch, scoreMatchedGroup, type ScorableGuest } from "./eventScoring.js";

// "No one should feel left out" (Royce, 2026-09-22). Two things, both
// scoped to people the real scoring pass (eventScoring.ts's
// MATCH_NUDGE_MIN_SCORE) never matched by the time an event is winding
// down:
//   1. If two or more are in that boat, give them a shot at each other —
//      scoreMatchedGroup again, restricted to just this pool, with the
//      score gate bypassed and an honestly-framed message (see
//      eventScoring.ts's unmatchedPairPrompt) — never presented as a real
//      recommendation, because it didn't clear the bar that framing is
//      earned by.
//   2. Whoever's left (alone in the pool, or no shareable reason even
//      there) gets a plain, honest "nothing stood out tonight" instead of
//      silence — silence at an event they came to is exactly the
//      isolate-a-member failure mode Co has already learned to avoid for
//      proactive sends generally.
//
// Scheduled the same way as eventCheckinFollowUp.ts's end-of-night
// check-in — one row per matched guest, idempotent on
// UNIQUE(event_api_id, user_id). Due UNMATCHED_SEND_BEFORE_END_MINUTES
// before end_at (2026-10-07): it used to be due at the exact minute the
// in-room window closes (end - MATCH_NUDGE_END_CUTOFF_MINUTES), so by the
// first cron tick after it every pair nudge was refused and everyone got
// the solo text. Now it runs with room to spare: the cutoff, one full
// 15-minute cron period, and 5 minutes to draft and deliver. It still
// reads as "still at the event," not a next-day afterthought.
export const UNMATCHED_CRON_MINUTES = 15;
export const UNMATCHED_SEND_BEFORE_END_MINUTES = MATCH_NUDGE_END_CUTOFF_MINUTES + UNMATCHED_CRON_MINUTES + 5;

export async function scheduleUnmatchedFollowUp(
  eventId: string,
  eventName: string,
  matched: ScorableGuest[],
  eventTiming: { start_at: string; end_at: string | null } | null,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  if (!matched.length || !eventTiming) return;
  const sendAt = new Date(new Date(withEnd(eventTiming).end_at).getTime() - UNMATCHED_SEND_BEFORE_END_MINUTES * 60_000);
  if (opts.dryRun) {
    console.log(`[eventUnmatchedFollowUp dryRun] would schedule ${matched.length} guest(s) at ${eventId} for ${sendAt.toISOString()}`);
    return;
  }
  for (const person of matched) {
    await pool
      .query(
        `INSERT INTO event_unmatched_followups (user_id, event_api_id, event_name, send_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_api_id, user_id) DO NOTHING`,
        [person.user_id, eventId, eventName, sendAt.toISOString()],
      )
      .catch((err: any) => console.error("scheduleUnmatchedFollowUp: insert failed (non-fatal):", err?.message ?? err));
  }
}

async function wasAlreadyNoticed(eventId: string, personId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_unmatched_notices WHERE event_id = $1 AND person_id = $2`, [eventId, personId]);
  return rows.length > 0;
}

async function markNoticed(eventId: string, personId: string, pairedWithId: string | null): Promise<void> {
  await pool
    .query(
      `INSERT INTO event_unmatched_notices (event_id, person_id, paired_with_id) VALUES ($1, $2, $3)
       ON CONFLICT (event_id, person_id) DO NOTHING`,
      [eventId, personId, pairedWithId],
    )
    .catch((err: any) => console.error("markNoticed: insert failed (non-fatal):", err?.message ?? err));
}

async function sendSoloAcknowledgment(eventId: string, eventName: string, person: ScorableGuest, opts: { dryRun?: boolean }): Promise<void> {
  if (opts.dryRun) {
    console.log(`[eventUnmatchedFollowUp dryRun] would send solo acknowledgment to ${person.user_id} at ${eventId}`);
    return;
  }
  const message = await draftWithConsent(
    {
      decision: "eventUnmatchedFollowUp.soloAck",
      recipientId: person.user_id,
      preChecks: [{ name: "not_already_noticed", pass: true }],
      facts: { otherFirstName: "", otherOptedIn: false, recipientOptedIn: false, recipientFirstName: person.first_name },
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(MODELS.haiku),
        experimental_telemetry: { isEnabled: true, functionId: "eventUnmatchedFollowUp.soloAck.draft" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.first_name} near the end of "${eventName}." Nothing came up as a strong match for them tonight — no one specific worth introducing them to.

Draft a short, honest, warm text (1-2 sentences, no em dashes, normal sentence capitalization) telling them plainly that nothing stood out as a strong pull tonight. Don't apologize, don't over-explain, don't invent a reason or promise anything specific — just honest and warm, still glad they came. Return ONLY the message text.${feedback ? `\n\n${feedback}` : ""}`,
      });
      return cleanCoMessage(text.trim());
    },
  );
  if (!message) return;
  if (!(await inRoomSendAllowed(person.user_id, eventId))) {
    console.log(`eventUnmatchedFollowUp: solo acknowledgment throttled for ${person.user_id} (in-room text limit for this event reached)`);
    return;
  }
  try {
    await sendblue.messages.send({ number: person.phone_number, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error(`eventUnmatchedFollowUp: solo acknowledgment send failed for ${person.user_id} (non-fatal):`, err?.message ?? err);
    return;
  }
  await recordInRoomSend(person.user_id, `in_room:unmatched:${eventId}`, message);
  await writeMemory(person.user_id, "event_guest_match_nudge", `Told ${person.first_name} plainly that nothing stood out as a strong match at "${eventName}".`);
  await writeMemory(person.user_id, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
    console.error("eventUnmatchedFollowUp: solo acknowledgment text_exchange log failed (non-fatal):", err?.message ?? err),
  );
}

// Cron entry point (jobs/index.ts, */15 * * * *, same lightweight-polling
// cadence as eventCheckinFollowUp.ts's own due-queue). Groups by event since
// the pairing pass needs the whole due pool for one event at once, not one
// person at a time.
export async function processDueUnmatchedFollowUps(): Promise<void> {
  const { rows: due } = await pool.query(
    `SELECT DISTINCT event_api_id, event_name FROM event_unmatched_followups
     WHERE sent_at IS NULL AND send_at <= NOW() LIMIT 25`,
  );
  for (const { event_api_id: eventId, event_name: eventName } of due) {
    await processOneEvent(eventId, eventName).catch((err: any) =>
      console.error(`processDueUnmatchedFollowUps: failed for ${eventId} (non-fatal):`, err?.message ?? err),
    );
  }
}

async function processOneEvent(eventId: string, eventName: string): Promise<void> {
  const { rows: dueRows } = await pool.query(
    `SELECT user_id FROM event_unmatched_followups WHERE event_api_id = $1 AND sent_at IS NULL AND send_at <= NOW()`,
    [eventId],
  );
  const dueUserIds = new Set<string>(dueRows.map((r) => r.user_id));
  if (!dueUserIds.size) return;

  const RM = await import("./roomMatching.js");
  const details = await RM.eventTiming(eventId).catch(() => null);
  const eventTiming = details ? withEnd({ start_at: details.start_at, end_at: details.end_at, timezone: details.timezone ?? null }) : null;

  // Who is in the room right now (services/roomMatching.ts inRoomNow): the current roster (it can have grown since this
  // was scheduled), minus anyone who left; nobody at all once the room is closed. A person due here may already have a
  // real match from a scoring pass that ran after scheduling but before now.
  const room = await RM.inRoomNow(eventId, { timing: eventTiming }).catch(() => ({ people: [] as ScorableGuest[] }));
  const matched = room.people.filter((p) => dueUserIds.has(p.user_id));

  const stillUnmatched: ScorableGuest[] = [];
  for (const person of matched) {
    if (!(await wasAlreadyNudgedForMatch(eventId, person.user_id)) && !(await wasAlreadyNoticed(eventId, person.user_id))) {
      stillUnmatched.push(person);
    }
  }

  // Give the leftovers a shot at each other first — reuses scoreMatchedGroup
  // as-is (per-person top pick, ask solicitation for anyone with no stated
  // ask yet, storeRanking), just scoped to this smaller pool and with the
  // score gate bypassed (eventScoring.ts's honestLowConfidence).
  if (stillUnmatched.length >= 2) {
    await scoreMatchedGroup(eventId, eventName, stillUnmatched, eventTiming, { honestLowConfidence: true });
  }

  // Whoever scoreMatchedGroup didn't pair off (alone in the pool, no
  // shareable reason, or still waiting on their first stated ask) gets the
  // plain acknowledgment instead of silence.
  for (const person of stillUnmatched) {
    const nudgeRow = await pool
      .query(`SELECT candidate_id FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2`, [eventId, person.user_id])
      .then((r) => r.rows[0]?.candidate_id ?? null)
      .catch(() => null);
    if (nudgeRow) {
      // Paired off by scoreMatchedGroup above — the real reply-handling
      // record is event_guest_match_nudges (reused as-is), this row is
      // purely for the solo-ack gate, so it's fine either way.
      await markNoticed(eventId, person.user_id, nudgeRow);
      continue;
    }
    await sendSoloAcknowledgment(eventId, eventName, person, {});
    await markNoticed(eventId, person.user_id, null);
  }

  await pool.query(`UPDATE event_unmatched_followups SET sent_at = NOW() WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [
    eventId,
    [...dueUserIds],
  ]);
}
