import { Router } from "express";
import type { RequestHandler } from "express";
import pool from "../db/db.js";
import { SAFE_USER_FIELDS, UPDATABLE_USER_FIELDS, buildUserUpdate, pickSafeUser } from "./accountRules.js";

export function createUsersRouter(authenticateToken: RequestHandler): Router {
  const router = Router();

  router.get(
    "/:id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }
        const getUser = await pool.query("SELECT * FROM users WHERE id = $1", [
          req.params.id,
        ]);

        const user: UserProp = await getUser.rows[0];

        if (user) {
          return res.status(200).send({
            success: true,
            data: {
              username: user.username,
              id: user.id,
              created_at: user.created_at,
              first_name: user.first_name,
              last_name: user.last_name,
              description: user.description,
              email: user.email,
              phone_number: user.phone_number,
              location: user.location,
              instagram: user.instagram,
              twitter: user.twitter,
              linkedin: user.linkedin,
              role: user.role,
              profile_image: user.profile_image,
            },
          });
        }

        return res.status(404).send({
          failed: true,
          message: `User Doesn't Exist: ${req.params.id}`,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/:id",
    authenticateToken,
    async (req, res, next) => {
      if (req.user?.id !== req.params.id) {
        return res
          .status(403)
          .send("Unauthorized: You can only update your own account");
      }

      // phone_number is no longer accepted here (2026-09-17): nothing
      // verified the new number, so an account could be pointed at someone
      // else's phone. A body with nothing updatable is a 400 now; it used to
      // build "UPDATE users SET  WHERE" and 500.
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, "phone_number")) {
        return res
          .status(400)
          .send("phone_number can't be changed here.");
      }
      const update = buildUserUpdate(req.body);
      if (!update) {
        return res
          .status(400)
          .send(`Nothing to update. Allowed fields: ${UPDATABLE_USER_FIELDS.join(", ")}`);
      }

      const setClause = update.columns
        .map((key, index) => `${key} = $${index + 2}`)
        .join(", ");

      try {
        // Only safe columns come back (2026-09-17): RETURNING * sent otp_code,
        // lock state and stripe_customer_id to the client.
        const updateUserInformation = await pool.query(
          `UPDATE users SET ${setClause} WHERE id = $1 RETURNING ${SAFE_USER_FIELDS.join(", ")}`,
          [req.params.id, ...update.values],
        );

        const updatedUser = updateUserInformation.rows[0];

        if (updatedUser) {
          return res.status(200).send({
            success: true,
            data: pickSafeUser(updatedUser),
          });
        }

        return res
          .status(404)
          .send(`User with id: ${req.params.id} doesn't exist.`);
      } catch (error: any) {
        // email and username are UNIQUE: a taken one is the caller's problem,
        // not a server error.
        if (error?.code === "23505") {
          return res.status(409).send("That email or username is already taken.");
        }
        next(error);
      }
    },
  );

  router.delete(
    "/:id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only delete your own account");
        }

        // Their calls' copies at ElevenLabs go first (services/elevenLabsForget.ts): one that fails stays queued and is retried by the
        // scheduled pass after the account is gone (the queue has no foreign key on users). Never throws.
        const { forgetCallsNow } = await import("../services/elevenLabsForget.js");
        await forgetCallsNow(req.params.id, () => true);

        const userDeletion = await pool.query(
          `DELETE FROM users WHERE id = $1 RETURNING *`,
          [req.params.id],
        );
        // No pinned snapshot of theirs stays in this process (services/memberSnapshot.ts dropPin).
        await import("../services/memberSnapshot.js").then((S) => S.dropPin(String(req.params.id))).catch(() => {});

        const deleteUser: UserProp = userDeletion.rows[0];

        if (deleteUser) {
          return res.status(200).send({
            success: true,
            message: `User Deleted: ${req.params.id}`,
          });
        }

        return res.status(404).send({
          failed: true,
          message: `User Doesn't Exist: ${req.params.id}`,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
