import { randomInt, randomUUID } from "crypto";
import { Router } from "express"; // isolated, modular instance of routes and middleware
import jwt from "jsonwebtoken";
import pool from "../db/db.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { Resend } from "resend";
import { ALLOW_REAL_SENDS, sendEmail, sendSMS } from "../otpActions.js";
import { normalizePhone } from "../utils/phone.js";
import { recordDecision } from "../harness/core.js";
import {
  OTP_TTL_SECONDS,
  TOKEN_LIFETIME_DAYS,
  decideOtpIssue,
  decideOtpVerify,
  otpLockMinutes,
} from "./accountRules.js";
import { CO_EMAIL_FROM } from "../services/emailFrom.js";

function generateOTP() {
  return randomInt(100000, 1000000);
}

// Email the team when an account locks, so a real person stuck at sign-in
// is visible instead of silent. Non-fatal: a failed alert must never break
// the auth response itself.
async function alertTeamAccountLocked(userId: string, lockMinutes: number): Promise<void> {
  try {
    const { rows } = await pool.query(`SELECT first_name, email, phone_number FROM users WHERE id = $1`, [userId]);
    const u = rows[0];
    const to = process.env.TEAM_ALERT_EMAIL ?? "team@copatible.com";
    const subject = `Co account locked: ${u?.first_name ?? "unknown"} (${u?.phone_number ?? userId})`;
    const html = `<p>An account hit 5 wrong verification codes and is locked for ${lockMinutes} minutes. It unlocks on its own after that.</p><p>Name: ${u?.first_name ?? "—"}<br>Email: ${u?.email ?? "—"}<br>Phone: ${u?.phone_number ?? "—"}<br>User id: ${userId}</p>`;
    if (!ALLOW_REAL_SENDS) {
      console.log(`[alertTeamAccountLocked stub] to ${to}: ${subject}`);
      return;
    }
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: CO_EMAIL_FROM, to: [to], subject, html });
    if (error) throw new Error(error.message);
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

    const client = await pool.connect();
    try {
      // One locked read of the OTP state, a pure decision (accountRules.ts's
      // decideOtpVerify), and one write, so two wrong guesses racing each
      // other can't both skip the lock or alert the team twice.
      await client.query("BEGIN");
      const { rows: stateRows } = await client.query(
        `SELECT email, phone_number, otp_code, otp_expiry, otp_attempts, otp_attempts_window_start,
                locked, locked_at, lock_count, token_version, username, id, created_at, role
         FROM users WHERE id = $1 FOR UPDATE`,
        [user_id],
      );
      const row = stateRows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(400).send(`Authentication failed`);
      }
      const otp = decideOtpVerify(
        {
          storedCode: row.otp_code == null ? null : String(row.otp_code),
          expiresAt: row.otp_expiry ? new Date(row.otp_expiry) : null,
          sentAt: null,
          attempts: row.otp_attempts ?? 0,
          attemptsWindowStart: row.otp_attempts_window_start ? new Date(row.otp_attempts_window_start) : null,
          locked: row.locked === true,
          lockedAt: row.locked_at ? new Date(row.locked_at) : null,
          lockCount: row.lock_count ?? 0,
        },
        String(otp_code ?? ""),
        new Date(),
      );

      if (otp.result === "verified") {
        await client.query(
          `UPDATE users SET otp_code = null, otp_expiry = null, otp_attempts = 0, otp_attempts_window_start = null,
                  locked = false, locked_at = NULL, lock_count = 0 WHERE id = $1`,
          [user_id],
        );
      } else if (otp.result === "wrong" && otp.lockNow) {
        // Bumping token_version here too (2026-09-17): a wrong-code streak
        // severe enough to lock the account also revokes any token already
        // issued for it, not just future guesses.
        await client.query(
          `UPDATE users SET otp_code = null, otp_expiry = null, otp_attempts = 0, otp_attempts_window_start = null,
                  locked = true, locked_at = NOW(), lock_count = $2, token_version = COALESCE(token_version, 0) + 1
           WHERE id = $1`,
          [user_id, otp.lockCount],
        );
      } else if (otp.result === "wrong") {
        await client.query(
          `UPDATE users SET otp_attempts = $2, otp_attempts_window_start = $3, locked = false, locked_at = NULL WHERE id = $1`,
          [user_id, otp.attempts, otp.attemptsWindowStart],
        );
      } else if (otp.clearExpiredLock) {
        await client.query(
          `UPDATE users SET locked = false, locked_at = NULL, otp_attempts = 0, otp_attempts_window_start = NULL WHERE id = $1`,
          [user_id],
        );
      }
      await client.query("COMMIT");
      recordDecision({
        layer: 1,
        decision: "auth.otp",
        userId: user_id,
        outcome: otp.result === "verified" ? "act" : "skip",
        action: otp.result,
        checks: otp.checks,
        reason: otp.lockNow ? `locked after too many wrong codes (lock #${otp.lockCount})` : null,
      });

      if (otp.result === "locked") {
        return res.status(429).send("User Locked!");
      }

      const UserAuthorize: UserProp | undefined = otp.result === "verified" ? row : undefined;

      if (UserAuthorize) {
        const authorize = jwt.sign(
          {
            username: UserAuthorize.username,
            id: UserAuthorize.id,
            created_at: UserAuthorize.created_at,
            role: UserAuthorize.role,
            // token_version at issue time (2026-09-17) — middleware/auth.ts
            // refuses a token whose tv doesn't match the user's current
            // value, so a logout or an OTP lock invalidates every token
            // already issued, not just the credential being used right now.
            tv: row.token_version ?? 0,
          },
          `${process.env.JWT_SECRET_KEY}`,
          {
            // Was 1 year with no way to revoke a token early (2026-09-17) —
            // tv above now covers early revocation; this just bounds how
            // long a token no one ever revoked stays usable at all.
            expiresIn: `${TOKEN_LIFETIME_DAYS}d`,
          },
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
          maxAge: TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
        });

        return res.status(200).send({
          success: true,
          token: authorize,
        });
      }

      if (otp.alertTeam) {
        await alertTeamAccountLocked(user_id, otpLockMinutes(otp.lockCount));
        return res.status(423).send({
          success: true,
          message: "Exceeded the number of Sign in request",
          data: {
            locked: true,
            attempts: otp.attempts,
          },
        });
      }

      return res.status(400).send(`Authentication failed`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
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
    const { email } = req.body;
    try {
      const { rows } = await pool.query(
        `SELECT id, contact_verified, otp_expiry, locked, locked_at, lock_count FROM users WHERE email = $1`,
        [email],
      );
      const userEmail = rows[0];

      // Same response whether or not the email is registered (2026-09-17) —
      // this used to 404 "User not found." for an unknown email and 200 with
      // the real id for a known one, which let anyone check which emails
      // have a Co account. An unknown email still gets a 200 with an id;
      // it's just not a real one, so the next step (verify-otp) fails the
      // same way a wrong/no-code attempt would.
      if (!userEmail) {
        return res.status(200).send({ success: true, data: { id: randomUUID() } });
      }

      // Edge case: registered but never texted in to complete verification.
      // Sending an OTP now would silently fail (Sendblue can't reach an
      // unverified contact) — send them back to the text-in step instead.
      // (This branch does still reveal the email is registered — it's the
      // same capability-token design verify-status above documents; closing
      // it fully would need the app's registration flow to change too.)
      if (!userEmail.contact_verified) {
        return res.status(403).send({
          message: "Text to verify",
          user_id: userEmail.id,
          verify_number: process.env.SENDBLUE_PHONE_NUMBER,
        });
      }

      // Per-account lock/cooldown (2026-09-17) — this route used to hand out
      // a brand-new code with no regard for either, so a locked account (or
      // one that just got a code seconds ago) could always just be asked
      // again here, bypassing verify-otp's own lock and cooldown entirely.
      const issue = decideOtpIssue(
        {
          expiresAt: userEmail.otp_expiry ? new Date(userEmail.otp_expiry) : null,
          sentAt: null,
          locked: userEmail.locked === true,
          lockedAt: userEmail.locked_at ? new Date(userEmail.locked_at) : null,
          lockCount: userEmail.lock_count ?? 0,
        },
        new Date(),
      );
      if (!issue.send) {
        // Same success shape either way — this endpoint doesn't announce a
        // lock; only a real verify-otp guess does.
        return res.status(200).send({ success: true, data: { id: userEmail.id } });
      }

      const updatedGeneratedOTP = generateOTP();
      const updatedExpiryTimeStamp = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

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
    } catch (error) {
      next(error);
    }
  });

  // POST /auth/send-otp — resends the OTP code for an existing user
  router.post("/send-otp", authLimiter, async (req, res, next) => {
    const { user_id } = req.body;

    try {
      const { rows } = await pool.query(
        `SELECT otp_expiry, locked, locked_at, lock_count FROM users WHERE id = $1`,
        [user_id],
      );
      const row = rows[0];
      if (!row) {
        return res.status(404).send(`User with id: ${user_id} doesn't exist.`);
      }

      const issue = decideOtpIssue(
        {
          expiresAt: row.otp_expiry ? new Date(row.otp_expiry) : null,
          sentAt: null,
          locked: row.locked === true,
          lockedAt: row.locked_at ? new Date(row.locked_at) : null,
          lockCount: row.lock_count ?? 0,
        },
        new Date(),
      );
      if (!issue.send) {
        if (issue.reason === "locked") return res.status(429).send("User Locked!");
        // Cooldown: a code went out seconds ago — same success response,
        // don't mint and text another one.
        return res.status(200).send({ success: true, message: "OTP resent successfully" });
      }

      const updatedGeneratedOTP = generateOTP();
      const updatedExpiryTimeStamp = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

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

  // POST /auth/logout — best-effort token revocation (2026-09-17, replacing
  // the "tokens last a year with no way to revoke one" gap). Bumps
  // token_version so every token already issued for this user — including
  // whichever one is used to call this — fails middleware/auth.ts's tv
  // check from now on. Verifies the token's signature (ignoring expiry, so
  // an already-expired token can still be used to log out) rather than just
  // decoding it, so this can't be used to force-logout an arbitrary user by
  // POSTing an unsigned token shaped like a JWT with someone else's id.
  router.post("/logout", async (req, res, next) => {
    try {
      const bearer = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null;
      const token = bearer ?? req.cookies?.token;
      if (token) {
        try {
          const decoded = jwt.verify(token, `${process.env.JWT_SECRET_KEY}`, {
            ignoreExpiration: true,
          }) as { id?: string };
          if (decoded?.id) {
            await pool.query(
              `UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1`,
              [decoded.id],
            );
          }
        } catch {
          // Invalid/unsigned token — nothing legitimate to revoke.
        }
      }
      res.clearCookie("token");
      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
