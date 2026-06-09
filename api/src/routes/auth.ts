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

  router.post("/verify/:id", async (req, res, next) => {
    const { otp_code } = req.body;

    try {
      const isUserLocked = await pool.query(
        `SELECT locked FROM users WHERE id = $1`,
        [req.params.id],
      );

      const lockedUser: UserProp = isUserLocked.rows[0];

      if (lockedUser.locked) {
        return res.status(429).send("User Locked!");
      }

      const authUser = await pool.query(
        `SELECT email, phone_number, otp_code, otp_expiry, username, id, created_at, role FROM users WHERE id = $1 AND otp_code = $2 AND otp_expiry > NOW()`,
        [req.params.id, otp_code],
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
          [req.params.id],
        );

        const accountAge =
          Date.now() - new Date(UserAuthorize.created_at).getTime();
        if (accountAge < 24 * 60 * 60 * 1000) {
          await sendEmail({ email: UserAuthorize.email, welcome: true });
          await sendSMS({
            phone_number: UserAuthorize.phone_number,
            welcome: true,
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
        });
      }

      const attempts = await pool.query(
        `UPDATE users
           SET otp_attempts = otp_attempts + 1,
             locked = CASE
             WHEN otp_attempts + 1 >= 5 THEN true ELSE false END
           WHERE id = $1
           RETURNING otp_attempts, locked`,
        [req.params.id],
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

  router.post("/lookup", async (req, res, next) => {
    const updatedGeneratedOTP = generateOTP();
    const updatedExpiryAt = Date.now() + 300000;
    const updatedExpiryTimeStamp = new Date(updatedExpiryAt).toISOString();

    const { email } = req.body;
    try {
      const verifyEmail = await pool.query(
        `SELECT users.id FROM users INNER JOIN applications ON users.application_id = applications.id WHERE applications.email = $1`,
        [email],
      );

      const userEmail: UserProp = verifyEmail.rows[0];

      if (userEmail) {
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

  router.put("/resend/:id", async (req, res, next) => {
    const updatedGeneratedOTP = generateOTP();
    const updatedExpiryAt = Date.now() + 300000;
    const updatedExpiryTimeStamp = new Date(updatedExpiryAt).toISOString();

    try {
      const isUserLocked = await pool.query(
        `SELECT locked FROM users WHERE id = $1`,
        [req.params.id],
      );

      const lockedUser: UserProp = isUserLocked.rows[0];

      if (lockedUser.locked === true) {
        return res.status(429).send("User Locked!");
      }

      const updateOTP = await pool.query(
        "UPDATE users SET otp_code = $2, otp_expiry = $3 WHERE id = $1 RETURNING *",
        [req.params.id, updatedGeneratedOTP, updatedExpiryTimeStamp],
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
        .send(`User with id: ${req.params.id} doesn't exist.`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
