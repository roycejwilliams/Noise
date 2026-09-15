import { randomInt } from "crypto";
import { Router } from "express"; // isolated, modular instance of routes and middleware
import jwt from "jsonwebtoken";
import pool from "../db/db.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { Resend } from "resend";
import { ALLOW_REAL_SENDS, sendEmail, sendSMS } from "../otpActions.js";
import { normalizePhone } from "../utils/phone.js";

function generateOTP() {
  return randomInt(100000, 1000000);
}

// A lock after 5 wrong codes used to be permanent (Royce, 2026-09-14): no
// code path ever cleared users.locked and nobody was told it happened, so
// the only way back in was a manual database edit. Now a lock lifts itself
// after LOCK_MINUTES — long enough to blunt brute-forcing a 6-digit code,
// short enough that a real person who fat-fingered it isn't shut out. A
// lock with no locked_at predates this column, so it's treated as expired
// rather than left permanent.
const LOCK_MINUTES = 15;

async function isStillLocked(userId: string): Promise<boolean> {
  await pool.query(
    `UPDATE users SET locked = false, otp_attempts = 0, locked_at = NULL
     WHERE id = $1 AND locked = true
       AND (locked_at IS NULL OR locked_at < NOW() - ($2 || ' minutes')::interval)`,
    [userId, LOCK_MINUTES],
  );
  const { rows } = await pool.query(`SELECT locked FROM users WHERE id = $1`, [userId]);
  return rows[0]?.locked === true;
}

// Email the team when an account locks, so a real person stuck at sign-in
// is visible instead of silent. Non-fatal: a failed alert must never break
// the auth response itself.
async function alertTeamAccountLocked(userId: string): Promise<void> {
  try {
    const { rows } = await pool.query(`SELECT first_name, email, phone_number FROM users WHERE id = $1`, [userId]);
    const u = rows[0];
    const to = process.env.TEAM_ALERT_EMAIL ?? "hello@copatible.com";
    const subject = `Co account locked: ${u?.first_name ?? "unknown"} (${u?.phone_number ?? userId})`;
    const html = `<p>An account hit 5 wrong verification codes and is locked for ${LOCK_MINUTES} minutes. It unlocks on its own after that.</p><p>Name: ${u?.first_name ?? "—"}<br>Email: ${u?.email ?? "—"}<br>Phone: ${u?.phone_number ?? "—"}<br>User id: ${userId}</p>`;
    if (!ALLOW_REAL_SENDS) {
      console.log(`[alertTeamAccountLocked stub] to ${to}: ${subject}`);
      return;
    }
    await new Resend(process.env.RESEND_API_KEY).emails.send({ from: "Co <hello@copatible.com>", to: [to], subject, html });
  } catch (err: any) {
    console.error("auth: account-locked team alert failed (non-fatal):", err?.message ?? err);
  }
}

export function createAuthRouter(): Router {
  const router = Router();

  // POST /auth/verify-otp — validates the 6-digit code and returns a JWT in the body
  // for mobile clients (SecureStore). Also sets a cookie for web clients.
  // Rate limited (brute-force protection on a 6-digit code) — verify-status
  // below is deliberately NOT under this limiter since the app polls it
  // every few seconds while waiting for text-in verification.
  router.post("/verify-otp", authLimiter, async (req, res, next) => {
    const { user_id, otp_code } = req.body;

    try {
      if (await isStillLocked(user_id)) {
        return res.status(429).send("User Locked!");
      }

      const authUser = await pool.query(
        `SELECT email, phone_number, otp_code, otp_expiry, username, id, created_at, role FROM users WHERE id = $1 AND otp_code = $2 AND otp_expiry > NOW()`,
        [user_id, otp_code],
      );

      const UserAuthorize: UserProp = authUser.rows[0];

      if (UserAuthorize) {
        const authorize = jwt.sign(
          {
            username: UserAuthorize.username,
            id: UserAuthorize.id,
            created_at: UserAuthorize.created_at,
            role: UserAuthorize.role,
          },
          `${process.env.JWT_SECRET_KEY}`,
          {
            expiresIn: "1y",
          },
        );

        await pool.query(
          `UPDATE users SET otp_code = null, otp_expiry = null, otp_attempts = 0 WHERE id = $1 RETURNING *`,
          [user_id],
        );

        const accountAge =
          Date.now() - new Date(UserAuthorize.created_at).getTime();
        if (accountAge < 24 * 60 * 60 * 1000) {
          // Welcome SMS already sent at first-contact (see sendblue.ts webhook)
          // — only the email repeats here.
          await sendEmail({ email: UserAuthorize.email, welcome: true });
        } else {
          await sendSMS({
            phone_number: UserAuthorize.phone_number,
            welcome_back: true,
          });
        }

        res.cookie("token", authorize, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 365 * 24 * 60 * 60 * 1000,
        });

        return res.status(200).send({
          success: true,
          token: authorize,
        });
      }

      const attempts = await pool.query(
        `UPDATE users
           SET otp_attempts = otp_attempts + 1,
             locked = CASE
             WHEN otp_attempts + 1 >= 5 THEN true ELSE false END,
             locked_at = CASE
             WHEN otp_attempts + 1 >= 5 THEN NOW() ELSE locked_at END
           WHERE id = $1
           RETURNING otp_attempts, locked`,
        [user_id],
      );

      const lockAttempts: UserProp = attempts.rows[0];

      if (lockAttempts.otp_attempts === 5) {
        await alertTeamAccountLocked(user_id);
        return res.status(423).send({
          success: true,
          message: "Exceeded the number of Sign in request",
          data: {
            locked: lockAttempts.locked,
            attempts: lockAttempts.otp_attempts,
          },
        });
      }

      return res.status(400).send(`Authentication failed`);
    } catch (error) {
      next(error);
    }
  });

  // POST /auth/register — self-serve signup, independent of the /applications
  // admin-approval pipeline. Creates a user row, but does NOT send an OTP yet —
  // our Sendblue plan can only reply to contacts who've texted in first, so the
  // user must text the Sendblue number before Co can message them at all. The
  // OTP is sent from the inbound webhook once that text arrives (see sendblue.ts).
  router.post("/register", authLimiter, async (req, res, next) => {
    if (!req.body) return res.status(400).send("Request body cannot be empty.");

    const { first_name, last_name, email, phone_number } = req.body;

    if (!first_name || !last_name || !email || !phone_number) {
      const missing = ["first_name", "last_name", "email", "phone_number"].find(
        (field) => !req.body[field],
      );
      return res.status(400).send(`${missing} is required.`);
    }

    const normalizedPhone = normalizePhone(phone_number);

    try {
      const existing = await pool.query(
        `SELECT id FROM users WHERE email = $1 OR phone_number = $2`,
        [email, normalizedPhone],
      );

      if (existing.rows[0]) {
        return res.status(409).send("A user with that email or phone number already exists.");
      }

      const created = await pool.query(
        `INSERT INTO users (first_name, last_name, email, phone_number, username, subscription_status, role)
         VALUES ($1, $2, $3, $4, $5, 'inactive', 'user')
         RETURNING *`,
        [first_name, last_name, email, normalizedPhone, email.split("@")[0]],
      );

      const newUser: UserProp = created.rows[0];

      return res.status(200).send({
        message: "Text to verify",
        user_id: newUser.id,
        verify_number: process.env.SENDBLUE_PHONE_NUMBER,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /auth/verify-status/:user_id — polled by the app while showing the
  // "text us to continue" screen. No auth — there's no JWT yet at this point
  // in the flow, and user_id (a UUID) already acts as the capability token.
  router.get("/verify-status/:user_id", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT contact_verified FROM users WHERE id = $1`,
        [req.params.user_id],
      );
      if (!result.rows[0]) return res.status(404).send("User not found.");
      return res.status(200).send({ contact_verified: !!result.rows[0].contact_verified });
    } catch (error) {
      next(error);
    }
  });

  // POST /auth/login — looks up existing user by email, sends OTP.
  // Queries users.email directly so this works for both applications-accepted
  // accounts and self-serve /auth/register accounts (which have no application_id).
  router.post("/login", authLimiter, async (req, res, next) => {
    const updatedGeneratedOTP = generateOTP();
    const updatedExpiryAt = Date.now() + 300000;
    const updatedExpiryTimeStamp = new Date(updatedExpiryAt).toISOString();

    const { email } = req.body;
    try {
      const verifyEmail = await pool.query(
        `SELECT id, contact_verified FROM users WHERE email = $1`,
        [email],
      );

      const userEmail: UserProp = verifyEmail.rows[0];

      if (userEmail) {
        // Edge case: registered but never texted in to complete verification.
        // Sending an OTP now would silently fail (Sendblue can't reach an
        // unverified contact) — send them back to the text-in step instead.
        if (!userEmail.contact_verified) {
          return res.status(403).send({
            message: "Text to verify",
            user_id: userEmail.id,
            verify_number: process.env.SENDBLUE_PHONE_NUMBER,
          });
        }

        const updateOTP = await pool.query(
          "UPDATE users SET otp_code = $2, otp_expiry = $3 WHERE id = $1 RETURNING *",
          [userEmail.id, updatedGeneratedOTP, updatedExpiryTimeStamp],
        );

        const updatedOTP: UserProp = updateOTP.rows[0];
        await sendSMS({
          phone_number: updatedOTP.phone_number,
          otp_code: updatedOTP.otp_code,
          login: true,
        });
        await sendEmail({
          email: updatedOTP.email,
          otp_code: updatedOTP.otp_code,
          login: true,
        });
        return res.status(200).send({
          success: true,
          data: { id: updatedOTP.id },
        });
      }

      res.status(404).send("User not found.");
    } catch (error) {
      next(error);
    }
  });

  // POST /auth/send-otp — resends the OTP code for an existing user
  router.post("/send-otp", authLimiter, async (req, res, next) => {
    const updatedGeneratedOTP = generateOTP();
    const updatedExpiryAt = Date.now() + 300000;
    const updatedExpiryTimeStamp = new Date(updatedExpiryAt).toISOString();
    const { user_id } = req.body;

    try {
      if (await isStillLocked(user_id)) {
        return res.status(429).send("User Locked!");
      }

      const updateOTP = await pool.query(
        "UPDATE users SET otp_code = $2, otp_expiry = $3 WHERE id = $1 RETURNING *",
        [user_id, updatedGeneratedOTP, updatedExpiryTimeStamp],
      );

      const updatedOTP: UserProp = updateOTP.rows[0];

      if (updatedOTP) {
        await sendSMS({
          phone_number: updatedOTP.phone_number,
          otp_code: updatedOTP.otp_code,
          resent: true,
        });
        await sendEmail({
          email: updatedOTP.email,
          otp_code: updatedOTP.otp_code,
          resent: true,
        });
        return res.status(200).send({
          success: true,
          message: "OTP resent successfully",
        });
      }

      return res
        .status(404)
        .send(`User with id: ${user_id} doesn't exist.`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
