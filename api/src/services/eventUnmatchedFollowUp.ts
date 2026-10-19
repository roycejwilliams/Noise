import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./coVoice.js";
import { MODELS } from "../models.js";
import sendblue, { cleanCoMessage } from "./sendblue.js";
import { writeMemory } from "./memory.js";
import { inRoomSendAllowed, recordInRoomSend } from "../harness/proactive.js";
import { draftWithConsent, eventPromptLine } from "../harness/introConsent.js";
import { MATCH_NUDGE_END_CUTOFF_MINUTES, withEnd } from "../harness/introConsent.js";
import type { ScorableGuest } from "./eventScoring.js";
import { withTraceUser } from "./llmTraceText.js";

// The end-of-night close (Royce, 2026-10-14). "Everyone gets the same end-of-night close, and it says nothing about matching. A real
// host finds the person before they leave and says 'glad you came' - they don't add 'sorry nobody was right for you.' Same warmth for
// everyone, no scoreboard for anyone. Your 9/22 principle survives; the wording is what dies. Below-bar pairing stays dead either way."
// And: "Sparse rooms: never lower the bar, never force a match. Members get silence; the shortfall goes to the host read."
//   - Every guest in the room near the end gets the same short, warm close, matched or not. It never mentions matches, introductions,
//     who they met or how the night went for them.
//   - "Glad you came" is a fact, so it only goes to someone with evidence they came: arrived (event_presence.arrived_at), checked in
//     at the door, or texted during the event. A registered no-show gets nothing.
//   - The below-the-bar pairing ("worth a quick hello") and the "nothing stood out" text are gone. What the room was thin on goes to
//     the host readout instead (services/partnerReadout.ts thinOn), as a category, never a member.
// (The file keeps its name and tables: event_unmatched_followups schedules the close, event_unmatched_notices records it once.)
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

// The close is claimed before it's drafted (review of #208/#218): two passes at once (a slow pass overlapping the next tick, two
// containers during a deploy) can't both send it. A close that was held or failed gives its claim back, so a later pass sends it.
async function claimClose(eventId: string, personId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO event_unmatched_notices (event_id, person_id, paired_with_id) VALUES ($1, $2, NULL)
     ON CONFLICT (event_id, person_id) DO NOTHING RETURNING 1`,
    [eventId, personId],
  );
  return rows.length > 0;
}

async function releaseClose(eventId: string, personId: string): Promise<void> {
  await pool
    .query(`DELETE FROM event_unmatched_notices WHERE event_id = $1 AND person_id = $2`, [eventId, personId])
    .catch((err: any) => console.error("releaseClose: delete failed (the close won't be retried):", err?.message ?? err));
}

// What a close may never talk about: matching, introductions, who they met, how the night went for them.
export const MATCH_TALK = /\b(match(es|ed)?|intro(duc\w*)?|connect(ed|ion)?s?|met\b|meet(ing)?\b|nobody|no one|stood out|strong pull|right for you|worth (knowing|meeting)|people you)\b/i;
export const CLOSE_FALLBACK = "Glad you came tonight.";
// Pure: the close that goes out: the draft if it says nothing about matching and has words in it, else the plain fallback.
export function closeText(draft: string | null): string {
  const t = (draft ?? "").trim();
  return t && !MATCH_TALK.test(t) ? t : CLOSE_FALLBACK;
}

// Evidence they came: Co saw them arrive (their location, or "I'm here"), they checked in at the door as a walk-in, or Luma's door
// check-in has them. A text during the event is not evidence: a guest at home texting about their week would be told "glad you came"
// (review of #208). Read fresh; a failed read is no evidence.
export type CheckedIn = { emails: Set<string>; phones: Set<string> };
export async function cameTonight(eventId: string, person: Pick<ScorableGuest, "user_id" | "email" | "phone_number">, lumaIn: CheckedIn): Promise<boolean> {
  if ((person.email && lumaIn.emails.has(person.email.toLowerCase())) || (person.phone_number && lumaIn.phones.has(person.phone_number))) return true;
  const [presence, walkin] = await Promise.all([
    pool.query(`SELECT 1 FROM event_presence WHERE event_api_id = $1 AND user_id = $2 AND arrived_at IS NOT NULL`, [eventId, person.user_id]).then((r) => r.rows.length > 0).catch(() => false),
    pool.query(`SELECT 1 FROM event_walkin_checkins WHERE event_api_id = $1 AND person_id = $2`, [eventId, person.user_id]).then((r) => r.rows.length > 0).catch(() => false),
  ]);
  return presence || walkin;
}

// Who Luma's door check-in has, by email and phone (the stored E.164 form). A test event has no Luma list; a failed read has nobody.
async function lumaCheckedIn(eventId: string): Promise<CheckedIn> {
  const out: CheckedIn = { emails: new Set(), phones: new Set() };
  const { isTestEvent } = await import("./roomMatching.js");
  if (isTestEvent(eventId)) return out;
  const [{ getEventGuestList }, { matchablePhone }] = await Promise.all([import("./luma.js"), import("../utils/phone.js")]);
  const guests = await getEventGuestList(eventId).catch(() => []);
  for (const g of guests.filter((x) => x.checked_in_at)) {
    if (g.email) out.emails.add(g.email.toLowerCase());
    const p = matchablePhone(g.phone);
    if (p) out.phones.add(p);
  }
  return out;
}

// "held" (paused, matching stopped, or a dry run) and "failed" are tried again by a later pass while the room is open.
async function sendClose(eventId: string, eventName: string, person: ScorableGuest, opts: { dryRun?: boolean }): Promise<"sent" | "held" | "failed"> {
  if (opts.dryRun) {
    console.log(`[eventUnmatchedFollowUp dryRun] would send the end-of-night close to ${person.user_id} at ${eventId}`);
    return "held";
  }
  // Past the in-room text limit: one line, once, always. Only the pause and the matching kill switch hold it, read before drafting so
  // a held close costs no draft (review of #208), and again right before it goes.
  if (!(await inRoomSendAllowed(person.user_id, eventId, { close: true }))) {
    console.log(`eventUnmatchedFollowUp: close held for ${person.user_id} (texts paused or matching stopped)`);
    return "held";
  }
  // The event as it really is (harness/introConsent.ts checkInventedSpecifics): the only source of a day or time in the text.
  const info = await (await import("./roomMatching.js")).eventTiming(eventId).catch(() => null);
  const introEvent = { name: eventName, start_at: info?.start_at ?? null, end_at: info?.end_at ?? null, timezone: info?.timezone ?? null, venue: info?.venue ?? null };
  const draft = await draftWithConsent(
    {
      decision: "eventUnmatchedFollowUp.close",
      recipientId: person.user_id,
      preChecks: [{ name: "not_already_closed", pass: true }],
      facts: { otherFirstName: "", otherOptedIn: false, recipientOptedIn: false, recipientFirstName: person.first_name },
      event: introEvent,
    },
    async (feedback) => {
      const { text } = await generateText({
        model: anthropic(MODELS.haiku),
        experimental_telemetry: { isEnabled: true, functionId: "eventUnmatchedFollowUp.close.draft" },
        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting ${person.first_name} near the end of "${eventName}." ${eventPromptLine(introEvent, eventName)} Every guest gets this same close tonight.

Write the goodbye a good host gives at the door: one short, warm line (no em dashes, normal sentence capitalization), glad they came. Say nothing about matches, introductions, who they met or how the night went for them, and ask nothing. Return ONLY the message text.${feedback ? `\n\n${feedback}` : ""}`,
      });
      return cleanCoMessage(text.trim());
    },
  );
  const message = closeText(draft);
  if (!(await inRoomSendAllowed(person.user_id, eventId, { close: true }))) {
    console.log(`eventUnmatchedFollowUp: close held for ${person.user_id} (texts paused or matching stopped)`);
    return "held";
  }
  try {
    await sendblue.messages.send({ number: person.phone_number, content: message, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
  } catch (err: any) {
    console.error(`eventUnmatchedFollowUp: close send failed for ${person.user_id} (non-fatal, tried again next pass):`, err?.message ?? err);
    return "failed";
  }
  await recordInRoomSend(person.user_id, `in_room:close:${eventId}`, message);
  await writeMemory(person.user_id, "text_exchange", `Co replied: ${message}`).catch((err: any) =>
    console.error("eventUnmatchedFollowUp: close text_exchange log failed (non-fatal):", err?.message ?? err),
  );
  return "sent";
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

  // Everyone in the room gets the same close, matched or not, once; "glad you came" only with evidence they came. Claimed first, so
  // overlapping passes send it once; a held or failed close gives its claim back and stays due, tried again next pass while the room is
  // open (once it closes, nobody is in it and the row is done).
  const lumaIn = matched.length ? await lumaCheckedIn(eventId) : { emails: new Set<string>(), phones: new Set<string>() };
  const retry = new Set<string>();
  for (const person of matched) {
    if (!(await cameTonight(eventId, person, lumaIn))) continue;
    if (!(await claimClose(eventId, person.user_id).catch(() => false))) continue;
    const r = await withTraceUser(person.user_id, () => sendClose(eventId, eventName, person, {})).catch(() => "failed" as const); // under their own trace-text mark
    if (r !== "sent") {
      await releaseClose(eventId, person.user_id);
      retry.add(person.user_id);
    }
  }

  const done = [...dueUserIds].filter((id) => !retry.has(id));
  if (done.length) await pool.query(`UPDATE event_unmatched_followups SET sent_at = NOW() WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [eventId, done]);
}
