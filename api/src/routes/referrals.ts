import { Router } from "express";
import type { RequestHandler } from "express";
import pool from "../db/db.js";

export function createReferralsRouter(authenticateToken: RequestHandler): Router {
  const router = Router();

  router.post(
    "/",
    authenticateToken,
    async (req, res, next) => {
      const { recipient, reason } = req.body;
      const referrer_id = req.user?.id;

      if (!recipient || !reason) {
        return res.status(400).send("recipient and reason are required.");
      }

      // All statements share one client so BEGIN/COMMIT/ROLLBACK apply to the
      // same transaction — pool.query() alone can hand each call a different
      // pooled connection. FOR UPDATE locks the row so two concurrent
      // requests can't both pass the availability check and double-spend.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const userResult = await client.query(
          "SELECT referrals_available FROM users WHERE id = $1 FOR UPDATE",
          [referrer_id],
        );

        if (!userResult.rows[0] || userResult.rows[0].referrals_available <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).send("No referrals available.");
        }

        await client.query(
          "INSERT INTO referrals (referrer_id, recipient, reason) VALUES ($1, $2, $3)",
          [referrer_id, recipient, reason],
        );

        await client.query(
          "UPDATE users SET referrals_available = referrals_available - 1 WHERE id = $1",
          [referrer_id],
        );

        await client.query("COMMIT");

        return res.status(201).send({ success: true });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        next(error);
      } finally {
        client.release();
      }
    },
  );

  return router;
}
