import { Router } from "express";
import type { RequestHandler } from "express";
import pool from "../db/db.js";

export function createNotificationsRouter(
  authenticateToken: RequestHandler,
): Router {
  const router = Router();

  router.get(
    "/:user_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.user_id)
          return res.status(403).send("Unauthorized.");

        const { type, read } = req.query;
        const conditions: string[] = ["user_id = $1"];
        const values: unknown[] = [req.params.user_id];

        if (type) {
          values.push(type);
          conditions.push(`type = $${values.length}`);
        }
        if (read !== undefined) {
          values.push(read === "true");
          conditions.push(`read = $${values.length}`);
        }

        const result = await pool.query(
          `SELECT * FROM notifications WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 50`,
          values,
        );

        return res.status(200).send({ success: true, data: result.rows });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:notification_id/read",
    authenticateToken,
    async (req, res, next) => {
      try {
        const result = await pool.query(
          `UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id`,
          [req.params.notification_id, req.user?.id],
        );
        if (!result.rows.length)
          return res.status(404).send("Notification not found.");
        return res.status(200).send({ success: true });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
