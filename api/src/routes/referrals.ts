import { Router } from "express";
import type { RequestHandler } from "express";
import pool from "../db/db.js";

export function createReferralsRouter(authenticateToken: RequestHandler): Router {
  const router = Router();

  router.post(
    "/",
    authenticateToken,
    async (req, res, next) => {
      try {
        const { recipient, reason } = req.body;
        const referrer_id = req.user?.id;

        if (!recipient || !reason) {
          return res.status(400).send("recipient and reason are required.");
        }

        const userResult = await pool.query(
          "SELECT referrals_available FROM users WHERE id = $1",
          [referrer_id],
        );

        if (userResult.rows[0].referrals_available <= 0) {
          return res.status(400).send("No referrals available.");
        }

        await pool.query("BEGIN");

        await pool.query(
          "INSERT INTO referrals (referrer_id, recipient, reason) VALUES ($1, $2, $3)",
          [referrer_id, recipient, reason],
        );

        await pool.query(
          "UPDATE users SET referrals_available = referrals_available - 1 WHERE id = $1",
          [referrer_id],
        );

        await pool.query("COMMIT");

        return res.status(201).send({ success: true });
      } catch (error) {
        await pool.query("ROLLBACK");
        next(error);
      }
    },
  );

  return router;
}
