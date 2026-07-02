import { randomInt } from "crypto";
import { Router } from "express"; // isolated, modular instance of routes and middleware
import jwt from "jsonwebtoken";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";

function generateOTP() {
  return randomInt(100000, 1000000);
}

export function createAuthRouter(): Router {
  const router = Router();

  // POST /auth/verify-otp — validates the 6-digit code and returns a JWT in the body
  // for mobile clients (SecureStore). Also sets a cookie for web clients.
  router.post("/verify-otp", async (req, res, next) => {
    const { user_id, otp_code } = req.body;

    try {
      const isUserLocked = await pool.query(
        `SELECT locked FROM users WHERE id = $1`,
        [user_id],
      );

      const lockedUser: UserProp = isUserLocked.rows[0];

      if (lockedUser.locked) {
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
          await sendEmail({ email: UserAuthorize.email, welcome: true });
          await sendSMS({
            phone_number: UserAuthorize.phone_number,
            welcome: true,
          });
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
             WHEN otp_attempts + 1 >= 5 THEN true ELSE false END
           WHERE id = $1
           RETURNING otp_attempts, locked`,
        [user_id],
      );

      const lockAttempts: UserProp = attempts.rows[0];

      if (lockAttempts.otp_attempts === 5) {
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
  router.post("/register", async (req, res, next) => {
    if (!req.body) return res.status(400).send("Request body cannot be empty.");

    const { first_name, last_name, email, phone_number } = req.body;

    if (!first_name || !last_name || !email || !phone_number) {
      const missing = ["first_name", "last_name", "email", "phone_number"].find(
        (field) => !req.body[field],
      );
      return res.status(400).send(`${missing} is required.`);
    }

    try {
      const existing = await pool.query(
        `SELECT id FROM users WHERE email = $1 OR phone_number = $2`,
        [email, phone_number],
      );

      if (existing.rows[0]) {
        return res.status(409).send("A user with that email or phone number already exists.");
      }

      const created = await pool.query(
        `INSERT INTO users (first_name, last_name, email, phone_number, username, subscription_status, role)
         VALUES ($1, $2, $3, $4, $5, 'inactive', 'user')
         RETURNING *`,
        [first_name, last_name, email, phone_number, email.split("@")[0]],
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
  router.post("/login", async (req, res, next) => {
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
  router.post("/send-otp", async (req, res, next) => {
    const updatedGeneratedOTP = generateOTP();
    const updatedExpiryAt = Date.now() + 300000;
    const updatedExpiryTimeStamp = new Date(updatedExpiryAt).toISOString();
    const { user_id } = req.body;

    try {
      const isUserLocked = await pool.query(
        `SELECT locked FROM users WHERE id = $1`,
        [user_id],
      );

      const lockedUser: UserProp = isUserLocked.rows[0];

      if (lockedUser.locked === true) {
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
