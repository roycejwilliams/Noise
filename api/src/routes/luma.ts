import { createHmac, timingSafeEqual } from "crypto";
import { announceCoEvent } from "../services/coEventAnnouncement.js";
import express, { Request, Response } from "express";
import pool from "../db/db.js";
import { runCalendarFollowReachOutAgent } from "../agent/calendarFollowReachOut.js";
import { handleEventCanceled, handleEventUpdated } from "../services/eventChangeDetection.js";
import { scoreGuestListForEvent } from "../services/eventScoring.js";
import { sendEmail } from "../otpActions.js";

const router = express.Router();

// Matches by email (not phone — that's all a calendar-follow webhook gives
// us) against an existing Co user. A match gets the real SMS reach-out
// (runCalendarFollowReachOutAgent). No match still gets a reach-out, just
// over email instead (Royce, 2026-08-30: "if the person isn't in our
// follow calendar we should reach out via email") — Co has no phone number
// for a non-user, but the webhook itself already gave us their email, so
// there's no reason to do nothing. `name` is a best-effort guess at the
// field Luma's payload uses (unconfirmed against a real delivery, same
// caveat as `email` below) — the email still sends without it, just with a
// generic greeting.
async function reachOutToSubscriber(email: string, name?: string): Promise<void> {
  const { rows } = await pool.query(`SELECT id, first_name, phone_number FROM users WHERE email = $1`, [email]);
  const user = rows[0];
  if (!user) {
    console.log(`luma/webhook: calendar.person_subscribed (${email}) — not a Co user, reaching out by email instead`);
    await sendEmail({ email, calendarFollow: true, firstName: name }).catch((err: any) =>
      console.error(`luma/webhook: calendar.person_subscribed (${email}) — sendEmail failed:`, err?.message ?? err),
    );
    return;
  }
  await runCalendarFollowReachOutAgent({ userId: user.id, firstName: user.first_name, phoneNumber: user.phone_number });
}

// A captured (or Luma-retried) delivery replayed later must not re-trigger
// scoring/announce. 5 minutes, generous for real network delivery delay,
// narrow for a replay attempt (code review, 2026-09-17).
const WEBHOOK_TIMESTAMP_WINDOW_SECONDS = 5 * 60;

// Pure: whether a webhook timestamp (unix seconds, as a string, per Luma's
// t= field) is close enough to now to accept. Exported for evals/proactive's
// model-free rules.
export function lumaTimestampInWindow(timestampSeconds: string, now: Date = new Date()): boolean {
  const t = Number(timestampSeconds);
  if (!Number.isFinite(t)) return false;
  return Math.abs(now.getTime() - t * 1000) <= WEBHOOK_TIMESTAMP_WINDOW_SECONDS * 1000;
}

// Reject webhook calls that didn't come from Luma. Luma signs each webhook
// with a secret generated when the webhook is created in the Luma UI
// (calendar → Settings → Developer → Webhooks), starting with "whsec_" —
// used raw, not decoded. Header is "Webhook-Signature: t=<timestamp>,v1=<hex
// signature>", HMAC-SHA256 over the exact string "${timestamp}.${rawBody}",
// hex-encoded. Requires req.body to be the raw Buffer for this route (see
// server.ts's express.raw() on /luma/webhook) — same reasoning as Hume's
// /co/webhook and Stripe's /payments/webhook.
//
// Code review, 2026-09-17: this used to skip verification entirely whenever
// LUMA_WEBHOOK_SECRET was unset (fine in dev, but the same fallback in
// production means anyone who ever captured one real signed delivery could
// replay it forever, re-running scoring and the Co event announcement) and
// never checked the timestamp even when a secret WAS configured, so a
// captured-and-still-correctly-signed payload could also be replayed
// forever. Now: missing secret fails CLOSED in production; the timestamp is
// checked whenever a signature is checked, valid or not, so a replay past
// the window is rejected before the signature is even compared.
function validateLumaWebhook(req: Request): boolean {
  const secret = process.env.LUMA_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // dev-only fallback; production fails closed

  const header = req.headers["webhook-signature"] as string | undefined;
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=") as [string, string]),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;
  if (!lumaTimestampInWindow(timestamp)) return false;

  const rawBody = (req.body as Buffer).toString("utf-8");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// event.created must only ever trigger scoring/the Co event announcement
// ONCE per event id, however many times Luma (or a replay) delivers it
// (code review, 2026-09-17) — the announcement queue already dedupes per
// PERSON, but nothing stopped scoring/announceCoEvent from re-running for
// the same event on a second delivery. Reuses inbound_webhook_handles (the
// existing generic webhook-dedup table, already cleaned up by the 3-day
// retention cron in jobs/index.ts) rather than adding a new table.
async function claimEventCreatedOnce(eventId: string): Promise<boolean> {
  const { rows } = await pool
    .query(`INSERT INTO inbound_webhook_handles (handle) VALUES ($1) ON CONFLICT (handle) DO NOTHING RETURNING handle`, [
      `luma:event.created:${eventId}`,
    ])
    .catch((err: any) => {
      console.error(`claimEventCreatedOnce: insert failed for ${eventId} (non-fatal, treated as already claimed):`, err?.message ?? err);
      return { rows: [] };
    });
  return rows.length > 0;
}

// POST /luma/webhook — Luma calls this for every subscribed action type
// (see the "Luma webhook route" board item for the full list: Guest Updated,
// Guest Registered, Event Created, Event Updated, Event Canceled, Calendar
// Person Subscribed, Calendar Event Added).
//
// The exact literal `type` string values below (e.g. "guest.updated") are
// inferred from Luma's docs/naming conventions, not confirmed against a real
// delivery — no live webhook has fired against this route yet. The default
// case logs the raw type so the first real delivery immediately reveals
// whether these guesses were right, rather than silently no-op'ing on a
// mismatched string.
//
// Fire-and-forget wrapper shared by all three triggers below — the webhook
// response is already sent by the time this runs, so this only ever logs,
// never affects the HTTP response.
function runScoringPass(eventId: string, eventName: string | undefined, triggeredBy: string): void {
  scoreGuestListForEvent(eventId, eventName)
    .then(({ scoredCount, solicitedCount, matchedCount }) => {
      console.log(
        `luma/webhook: ${triggeredBy} (${eventId}) — matched ${matchedCount} Co user(s), scored ${scoredCount}, solicited an ask from ${solicitedCount}`,
      );
    })
    .catch((err: any) => {
      console.error(`luma/webhook: ${triggeredBy} (${eventId}) — scoreGuestListForEvent failed:`, err?.message ?? err);
    });
}

// All 7 subscribed types are wired to real logic as of 2026-08-30:
// event.created/guest.registered/guest.updated trigger the scoring pipeline
// (services/eventScoring.ts); event.updated/event.canceled trigger guest
// notification (services/eventChangeDetection.ts); calendar.person_subscribed
// triggers a reach-out if the subscriber is already a Co user
// (reachOutToSubscriber below); calendar.event_added is capture-only (see
// its case below for why). One remaining real gap: the one-time nudge's
// presence filter (top-5 ranked card stack, Notion V1 board row 9) isn't
// built yet.
//
// Design note, 2026-09-07 (Royce, same reasoning as the end-of-night
// check-in fix in services/eventCheckinFollowUp.ts): this was originally
// planned to gate on guest.checked_in_at as the real check-in signal, but
// Luma's API has no way to ever set check-in status — only a real physical
// scan or the host manually toggling their own sign-in-gated page can
// populate it, which would make the presence filter structurally unreliable
// to depend on. Build it instead on registration (already confirmed via
// matchGuestsToUsers/services/eventScoring.ts's matched list) plus the
// event's real start_at having passed, not checked_in_at. Same trade-off as
// the check-in fix: gives up specifically excluding a no-show, in exchange
// for a signal that actually exists and fires reliably.
router.post("/webhook", (req: Request, res: Response) => {
  if (!validateLumaWebhook(req)) {
    return res.status(401).send("Invalid Luma signature.");
  }

  let payload: any;
  try {
    payload = JSON.parse((req.body as Buffer).toString("utf-8"));
  } catch (err: any) {
    console.error("luma/webhook: failed to parse body:", err?.message ?? err);
    return res.status(400).send("Invalid JSON.");
  }

  // Ack immediately — webhook handlers should respond fast, not block on
  // downstream work. Everything below is fire-and-forget logging/routing.
  res.sendStatus(200);

  const { type, data } = payload ?? {};
  switch (type) {
    case "event.created": {
      const eventId = data?.api_id;
      if (!eventId) {
        console.error("luma/webhook: event.created payload missing api_id:", JSON.stringify(data));
        break;
      }
      // Idempotent per event id (code review, 2026-09-17) — see
      // claimEventCreatedOnce above.
      claimEventCreatedOnce(eventId)
        .then((claimed) => {
          if (!claimed) {
            console.log(`luma/webhook: event.created (${eventId}) — already processed once, skipping (replay or duplicate delivery)`);
            return;
          }
          runScoringPass(eventId, data?.name, "event.created");
          // Co's own event: everyone near it sees it right away
          // (services/coEventAnnouncement.ts).
          announceCoEvent(eventId)
            .then((r) => console.log(`luma/webhook: event.created (${eventId}) — announced to ${r.sent}, queued ${r.queued}`))
            .catch((err: any) => console.error(`luma/webhook: event.created (${eventId}) — announceCoEvent failed:`, err?.message ?? err));
        })
        .catch((err: any) => console.error(`luma/webhook: event.created (${eventId}) — claim failed:`, err?.message ?? err));
      break;
    }
    case "guest.registered":
    case "guest.updated": {
      // The literal field linking a guest payload back to its event is
      // unconfirmed against a real delivery — trying every plausible shape
      // and logging clearly if none match, rather than guessing silently.
      const eventId = data?.event_api_id ?? data?.event?.api_id ?? data?.event_id;
      if (!eventId) {
        console.error(
          `luma/webhook: ${type} payload has no recognizable event id field — logging raw payload so the real shape can be confirmed:`,
          JSON.stringify(data),
        );
        break;
      }
      // guest.updated is also the check-in signal ("User checks in" on the
      // flow board) — TODO: the presence-filter logic that consumes
      // approval_status/checked_in_at for the one-time nudge isn't built yet;
      // this only re-triggers scoring, it doesn't yet act on check-in itself.
      runScoringPass(eventId, undefined, type);
      break;
    }
    case "event.updated": {
      const eventId = data?.api_id;
      if (!eventId) {
        console.error("luma/webhook: event.updated payload missing api_id:", JSON.stringify(data));
        break;
      }
      handleEventUpdated(eventId).catch((err: any) =>
        console.error(`luma/webhook: event.updated (${eventId}) — handleEventUpdated failed:`, err?.message ?? err),
      );
      break;
    }
    case "event.canceled": {
      const eventId = data?.api_id;
      if (!eventId) {
        console.error("luma/webhook: event.canceled payload missing api_id:", JSON.stringify(data));
        break;
      }
      handleEventCanceled(eventId).catch((err: any) =>
        console.error(`luma/webhook: event.canceled (${eventId}) — handleEventCanceled failed:`, err?.message ?? err),
      );
      break;
    }
    case "calendar.person_subscribed": {
      // A Co-user match gets texted; anyone else gets emailed instead (see
      // reachOutToSubscriber) — either way, something reaches them. Field
      // names guessed (data.email, data.name), unconfirmed against a real
      // delivery.
      const email = data?.email;
      const name = data?.name;
      if (!email) {
        console.error("luma/webhook: calendar.person_subscribed payload has no email field:", JSON.stringify(data));
        break;
      }
      reachOutToSubscriber(email, name).catch((err: any) =>
        console.error("luma/webhook: calendar.person_subscribed — reachOutToSubscriber failed:", err?.message ?? err),
      );
      break;
    }
    case "calendar.event_added": {
      // Capture-only (Royce, 2026-08-30) — Tier 2 of the recommendation
      // engine already live-searches Luma's public feed, so this doesn't
      // need to feed anything today. Just logs it so nothing's lost if a
      // real ingestion/caching decision gets made later.
      pool
        .query(`INSERT INTO external_luma_events_seen (event_id, raw_payload) VALUES ($1, $2::jsonb)`, [
          data?.api_id ?? "unknown",
          JSON.stringify(data),
        ])
        .catch((err: any) => console.error("luma/webhook: calendar.event_added capture failed:", err?.message ?? err));
      break;
    }
    default:
      console.log(`luma/webhook: received unrecognized type "${type}" — payload:`, JSON.stringify(payload));
  }
});

export function createLumaRouter() {
  return router;
}
