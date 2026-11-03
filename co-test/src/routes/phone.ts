import { isTestCase, TEST_CASES } from "../testCases.js";
import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";
import { getLiveSnapshot, issueSocketToken } from "../services/liveCallState.js";
import { triggerCallForUser } from "../../../api/src/services/callTrigger.js";
import { requireOwnOrTeam, requireTesterLoginApi } from "../middleware/requireTesterLogin.js";

const router = express.Router();

// Every route below is the actual tester-facing tool — requires the
// phone-verified tool-access login from routes/login.ts. This does not
// change or replace phone.ts's own text-in-first name/email intake flow
// below, which tests production's real onboarding UX; it just gates who can
// reach it.
router.use(requireTesterLoginApi);

// POST /api/phone/session — the tester is already logged in by the time this
// is reachable (router-wide requireTesterLoginApi below), and that login is
// keyed on their real phone number (see testerAuth.ts) — so their identity
// is already known here, not anonymous. This used to mint a second,
// disconnected placeholder row (phone_pending=true, a synthetic number) for
// /sendblue/webhook's contact_verified bootstrap to "claim" once the real
// text arrived. That claim could never actually fire in practice: the
// webhook looks a user up by (phone_number, test_channel='phone') first, and
// the login row already occupies that exact key — so every real inbound
// text updated the login row's identity_captured, while this route hands
// the browser a *different* row's id to poll, which never changed. The
// status step-through on /phone would sit on "Waiting for text-in" forever
// no matter how many texts actually arrived. Just reuse the login row
// directly — it's the same identity.
router.post("/session", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).testerId as string;
    return res.status(200).json({
      success: true,
      user_id: userId,
      // Credential for this session's live-call socket room — see
      // liveCallState.ts's issueSocketToken/verifySocketToken.
      socket_token: issueSocketToken(userId),
      text_in_number: process.env.SENDBLUE_PHONE_NUMBER,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/phone/:user_id/status — polled by the phone-test page through
// every step: text-in-first (name/email intake), call state, and the smoke
// test's own round-trip timestamps.
//
// recap_ready is its own explicit check (not inferred from call_status)
// so the "View Results" link's visibility can never drift out of sync with
// whether a recap actually exists, regardless of what call_status happens
// to mean at any point — call_status='completed' already implies this today
// (see webhooks.ts's chat_ended handler), but the client checks this field
// directly rather than trusting that invariant to hold forever.
router.get("/:user_id/status", requireOwnOrTeam("user_id"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT u.identity_captured, (COALESCE(u.invite_verified, false) AND u.archived_at IS NULL) AS call_ready, u.call_sid, u.call_status, u.test_case,
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
router.get("/:user_id/live-state", requireOwnOrTeam("user_id"), (req: Request, res: Response) => {
  const snapshot = getLiveSnapshot(String(req.params.user_id));
  return res.status(200).json({ success: true, ...snapshot });
});

// POST /api/phone/:user_id/tag — tags this session with which test case it
// belongs to. Works for both real-phone sessions and the original browser-EVI
// sessions (same users table either way) — see also the /api/session route's
// generic tag handling for the browser flow.
router.post("/:user_id/tag", requireOwnOrTeam("user_id"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { test_case } = req.body as { test_case?: string };
    if (!isTestCase(test_case)) {
      return res.status(400).json({ success: false, error: `test_case must be one of: ${TEST_CASES.map((t) => t.value).join(", ")}.` });
    }
    await pool.query(`UPDATE users SET test_case = $2 WHERE id = $1`, [req.params.user_id, test_case]);
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/phone/:user_id/call — real-call trigger (Part 1, item 3). Same
// pattern as production's POST /co/call/:user_id (api/src/routes/co.ts):
// Twilio dials out through api/src/services/callTrigger.ts, the leg is
// answered by GPT-Live (api/src/routes/co.ts gptLiveAnswer), and its
// post-call steps run in THIS service, writing to co-test's own DB. Gated on
// membership: invite-verified and not archived. Name and email on file aren't
// a condition (ruling A, 2026-11-02: asked once, never held hostage), the same
// line production's inbound calls use (api/src/harness/callGate.ts inboundCallMember).
router.post("/:user_id/call", requireOwnOrTeam("user_id"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userResult = await pool.query(
      `SELECT invite_verified, archived_at FROM users WHERE id = $1`,
      [req.params.user_id],
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, error: "Session not found." });
    if (user.invite_verified !== true || user.archived_at) {
      return res.status(403).json({ success: false, error: "Text in with an invite code before requesting a call." });
    }

    // io is null here — this dashboard has its own live-call view
    // (liveCallState.ts), not api's JWT-authed socket rooms, so there's no
    // real consumer for triggerCallForUser's optional io?.emit calls.
    const result = await triggerCallForUser(String(req.params.user_id), null);
    // A call that never started (the phone service refused the dial, or its setup failed) is a failure on Cue's side, not a missing
    // session: 502, like the app's own call route (api/src/routes/co.ts).
    if (!result.success) return res.status(result.dialFailed ? 502 : 404).json({ success: false, error: result.error });
    return res.status(200).json({ success: true, call_sid: result.call_sid });
  } catch (error) {
    next(error);
  }
});

export default router;
