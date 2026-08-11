import { randomInt } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";
import { sendSMS } from "../../../api/src/otpActions.js";
import { getLiveSnapshot, issueSocketToken } from "../services/liveCallState.js";
import { triggerCall } from "../services/callTrigger.js";
import { resetRealTestUser } from "../services/dynamicPlacementTest.js";

const router = express.Router();

// POST /api/phone/reset — clears every real (non-simulated) phone-test
// user's own account (profile, memories, captured intent, any circle they
// own) plus any abandoned, never-claimed phone_pending row. co-test is
// explicitly single-tester-at-a-time (see phone_pending's migration
// comment) — this is what makes that safe across multiple different real
// testers over time: whoever finishes a session runs this before handing
// the tool to the next person, instead of them building on a stranger's
// leftover data.
router.post("/reset", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resetRealTestUser();
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/phone/session — entry screen is a single "Message Co to start"
// button (Ditto pattern, no name/phone form), so there's no phone number to
// key a row on yet. Creates an anonymous placeholder row (phone_pending=true,
// a synthetic unique placeholder in the NOT NULL phone_number column) that
// /sendblue/webhook's contact_verified bootstrap claims — attaching the real
// number — the moment an inbound text arrives from a number it doesn't
// already recognize. See phone_pending's migration comment for the
// one-tester-at-a-time tradeoff this implies.
router.post("/session", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const suffix = Math.random().toString(36).slice(2, 8);
    const created = await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone_number, username, test_channel, phone_pending)
       VALUES ('Tester', 'Tester', $1, $2, $3, 'phone', true) RETURNING id`,
      [
        `co-test-phone-${suffix}@copatible.test`,
        `+1000${suffix}`,
        `co_test_phone_${suffix}`,
      ],
    );

    return res.status(200).json({
      success: true,
      user_id: created.rows[0].id,
      // Credential for this session's live-call socket room — see
      // liveCallState.ts's issueSocketToken/verifySocketToken.
      socket_token: issueSocketToken(created.rows[0].id),
      text_in_number: process.env.SENDBLUE_PHONE_NUMBER,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/phone/:user_id/status — polled by the phone-test page through
// every step: text-in-first, OTP verification, call state, and the smoke
// test's own round-trip timestamps.
//
// recap_ready is its own explicit check (not inferred from call_status)
// so the "View Results" link's visibility can never drift out of sync with
// whether a recap actually exists, regardless of what call_status happens
// to mean at any point — call_status='completed' already implies this today
// (see webhooks.ts's chat_ended handler), but the client checks this field
// directly rather than trusting that invariant to hold forever.
router.get("/:user_id/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT u.contact_verified, u.otp_verified, u.call_sid, u.call_status, u.test_case,
              u.smoke_test_tool_call_at, u.smoke_test_tool_response_at,
              EXISTS (
                SELECT 1 FROM co_memories cm WHERE cm.user_id = u.id AND cm.memory_type = 'recap'
              ) AS recap_ready
       FROM users u WHERE u.id = $1`,
      [req.params.user_id],
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: "Session not found." });
    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/phone/:user_id/live-state — snapshot for a (re)connecting
// browser to catch up on (requirement 5: reconnects must not silently skip
// the gap). The client applies every event here with seq greater than
// whatever it's already rendered, so calling this redundantly (e.g. right
// after a socket reconnect even if nothing was actually missed) is always
// safe — events are idempotent by seq, never re-applied.
router.get("/:user_id/live-state", (req: Request, res: Response) => {
  const snapshot = getLiveSnapshot(String(req.params.user_id));
  return res.status(200).json({ success: true, ...snapshot });
});

// POST /api/phone/:user_id/verify-otp — validates the code Sendblue sent as
// a reply once the tester texted in first (see webhooks.ts's /sendblue/webhook).
// No JWT/session issued — co-test has no auth system — this just flips
// otp_verified so the call-trigger route below can gate on it.
router.post("/:user_id/verify-otp", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { otp_code } = req.body as { otp_code?: string };
    if (!otp_code) return res.status(400).json({ success: false, error: "otp_code is required." });

    // Lockout mirrors production's (api/src/routes/auth.ts) — without it,
    // the 6-digit code has no attempt ceiling and someone who knows/guesses
    // a user_id could brute-force in and trigger a real call to that
    // tester's real phone via the otp_verified-gated /call route below.
    const attemptsCheck = await pool.query(`SELECT otp_attempts FROM users WHERE id = $1`, [req.params.user_id]);
    if (!attemptsCheck.rows[0]) return res.status(404).json({ success: false, error: "Session not found." });
    if (attemptsCheck.rows[0].otp_attempts >= 5) {
      return res.status(423).json({ success: false, error: "Too many incorrect attempts — request a new code." });
    }

    const result = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND otp_code = $2 AND otp_expiry > NOW()`,
      [req.params.user_id, otp_code],
    );

    if (!result.rows[0]) {
      await pool.query(`UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [req.params.user_id]);
      return res.status(400).json({ success: false, error: "Incorrect or expired code." });
    }

    await pool.query(
      `UPDATE users SET otp_verified = true, otp_code = NULL, otp_expiry = NULL, otp_attempts = 0 WHERE id = $1`,
      [req.params.user_id],
    );
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/phone/:user_id/resend-otp — same code path the webhook uses on
// first contact, callable again if the original code expired (5 min).
router.post("/:user_id/resend-otp", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userResult = await pool.query(
      `SELECT phone_number, contact_verified FROM users WHERE id = $1`,
      [req.params.user_id],
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "Session not found." });
    if (!user.contact_verified) {
      return res.status(409).json({ success: false, error: "Text the number in first — see instructions." });
    }

    const otp = randomInt(100000, 1000000);
    await pool.query(
      `UPDATE users SET otp_code = $2, otp_expiry = NOW() + INTERVAL '5 minutes', otp_attempts = 0 WHERE id = $1`,
      [req.params.user_id, otp],
    );
    // Same copy production's resend uses (see api/src/routes/auth.ts's
    // /send-otp) — sendSMS catches its own errors internally and never
    // throws, matching every other Sendblue send in this codebase.
    await sendSMS({ phone_number: user.phone_number, otp_code: otp.toString(), resent: true });
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/phone/:user_id/tag — tags this session with which test case it
// belongs to. Works for both real-phone sessions and the original browser-EVI
// sessions (same users table either way) — see also the /api/session route's
// generic tag handling for the browser flow.
router.post("/:user_id/tag", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { test_case } = req.body as { test_case?: string };
    if (test_case !== "intent_layer" && test_case !== "circles") {
      return res.status(400).json({ success: false, error: "test_case must be 'intent_layer' or 'circles'." });
    }
    await pool.query(`UPDATE users SET test_case = $2 WHERE id = $1`, [req.params.user_id, test_case]);
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/phone/:user_id/call — real-call trigger (Part 1, item 3). Same
// pattern as production's POST /co/call/:user_id (api/src/routes/co.ts):
// Twilio dials out, `url` hands the leg to Hume's own Twilio bridge using
// this service's dev HUME_CONFIG_ID, and the dev config's own webhook (see
// the repoint noted in webhooks.ts) delivers chat_started/tool_call/
// chat_ended back to THIS service, writing to co-test's own DB. Gated on
// otp_verified — text-in-first, then OTP, only then a real call unlocks.
router.post("/:user_id/call", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userResult = await pool.query(
      `SELECT otp_verified FROM users WHERE id = $1`,
      [req.params.user_id],
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "Session not found." });
    if (!user.otp_verified) {
      return res.status(403).json({ success: false, error: "Verify OTP before requesting a call." });
    }

    const result = await triggerCall(String(req.params.user_id));
    if (!result.success) return res.status(404).json({ success: false, error: result.error });
    return res.status(200).json({ success: true, call_sid: result.call_sid });
  } catch (error) {
    next(error);
  }
});

export default router;
