import { Router } from "express";
import type { RequestHandler } from "express";
import pool from "../db/db.js";
import { normalizePhone } from "../utils/phone.js";

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
      if (!req.body) return res.status(400).send("Request body cannot be empty");

      const allowed = [
        "first_name",
        "last_name",
        "phone_number",
        "email",
        "description",
        "username",
        "location",
        "instagram",
        "twitter",
        "linkedin",
        "profile_image",
      ];

      const filterKeys = Object.keys(req.body).filter((key) => {
        return allowed.includes(key);
      });

      const values = filterKeys.map((key) =>
        key === "phone_number" ? normalizePhone(req.body[key]) : req.body[key],
      );

      const userKeys = filterKeys
        .map((key, index) => {
          return `${key} = $${index + 2}`;
        })
        .join(", ");

      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only update your own account");
        }

        const updateUserInformation = await pool.query(
          `UPDATE users SET ${userKeys} WHERE id = $1 RETURNING *`,
          [req.params.id, ...values],
        );

        const updatedUser: UserProp = updateUserInformation.rows[0];

        if (updatedUser) {
          return res.status(200).send({
            success: true,
            data: updatedUser,
          });
        }

        return res
          .status(404)
          .send(`User with id: ${req.params.id} doesn't exist.`);
      } catch (error) {
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

        const userDeletion = await pool.query(
          `DELETE FROM users WHERE id = $1 RETURNING *`,
          [req.params.id],
        );

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

  router.get(
    "/:id/connections",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const getActiveConnections = await pool.query(
          `SELECT DISTINCT
        u.id,
        u.first_name,
        u.last_name,
        u.username,
        u.profile_image,
        c.id as circle_id,
        c.circle_name
      FROM circle_members cm1
      JOIN circle_members cm2 ON cm1.circle_id = cm2.circle_id
      JOIN users u ON cm2.member_id = u.id
      JOIN circles c ON cm1.circle_id = c.id
      WHERE cm1.member_id = $1 AND cm2.member_id != $1
         `,
          [req.params.id],
        );

        const activeConnections: UserProp[] = getActiveConnections.rows;

        if (activeConnections) {
          return res.status(200).send({
            success: true,
            data: activeConnections,
          });
        }

        return res.status(404).send("User not found.");
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
