import { Router } from "express";
import type { RequestHandler } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";

export function createCirclesRouter(
  io: Server,
  authenticateToken: RequestHandler,
): Router {
  const router = Router();

  // Public endpoint — no auth, used by app.copatible.com/circles/:id (the
  // link texted when a circle is found — also the App Clip entry point).
  // Must be registered before GET "/:id" below, which would otherwise
  // shadow this route (Express matches "/public/xyz" against "/:id" first
  // if that's registered earlier, treating "public" as the :id param).
  router.get("/public/:id", async (req, res, next) => {
    try {
      const circleResult = await pool.query(
        `SELECT id, circle_name, status FROM circles WHERE id = $1`,
        [req.params.id],
      );
      const circle = circleResult.rows[0];
      if (!circle) return res.status(404).send("Circle not found.");

      // Member identities stay hidden on this unauthenticated page until
      // scheduling is confirmed — matches the privacy rule the individual
      // placement text already follows (see circleApproval.ts's prompt).
      const confirmedMomentResult = await pool.query(
        `SELECT 1 FROM moments WHERE circle_id = $1 AND status = 'confirmed'`,
        [circle.id],
      );
      const schedulingConfirmed = confirmedMomentResult.rows.length > 0;

      const membersResult = await pool.query(
        `SELECT u.first_name, cp.city, cp.life_chapters
         FROM circle_members cm
         JOIN users u ON u.id = cm.member_id
         LEFT JOIN co_profiles cp ON cp.user_id = cm.member_id
         WHERE cm.circle_id = $1 AND cm.status != 'declined'`,
        [circle.id],
      );
      // city/chapter/member_count are candidate-identifying signal the same
      // way names are (general life-stage + location + group size, before
      // anyone has consented to placement) — withhold them pre-consent too.
      const members = membersResult.rows;
      const city = schedulingConfirmed ? members.find((m: any) => m.city)?.city ?? null : null;
      const chapter = schedulingConfirmed
        ? members.find((m: any) => m.life_chapters?.length)?.life_chapters?.[0] ?? null
        : null;

      return res.status(200).send({
        success: true,
        data: {
          id: circle.id,
          circle_name: circle.circle_name,
          status: circle.status,
          city,
          chapter,
          member_count: schedulingConfirmed ? members.length : null,
          member_first_names: schedulingConfirmed ? members.map((m: any) => m.first_name) : [],
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:id",
    authenticateToken,
    async (req, res, next) => {
      if (!req.body) return res.status(400).send("Request body cannot be empty.");

      const { circle_name } = req.body;

      if (!circle_name) {
        return res.status(400).send(`"circle_name" is required.`);
      }

      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(400)
            .send("Unauthorized: You can only access your own account");
        }
        const insertCircle = await pool.query(
          "INSERT INTO circles (owner_id, circle_name) VALUES ($1, $2) RETURNING *",
          [req.params.id, circle_name],
        );

        const createCircle: CircleProp = await insertCircle.rows[0];

        if (createCircle) {
          return res.status(201).send({
            success: true,
            data: createCircle,
          });
        }

        return res.status(400).send("Unable to Create Circle");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(400)
            .send("Unauthorized: You can only access your own account");
        }

        const getCircleById = await pool.query(
          `SELECT * FROM circles WHERE owner_id = $1`,
          [req.params.id],
        );

        const retrieveCircle: CircleProp[] = getCircleById.rows;

        if (retrieveCircle) {
          return res.status(200).send({
            success: true,
            data: retrieveCircle,
          });
        }

        return res.status(400).send("Unable to retrieve circles");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/member",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(400)
            .send("Unauthorized: You can only access your own account");
        }

        const retrieveCirclebyMember = await pool.query(
          `SELECT * FROM circles INNER JOIN
        circle_members ON circles.id = circle_members.circle_id
        WHERE circle_members.member_id = $1`,
          [req.params.id],
        );

        const getCircle: CircleProp[] = retrieveCirclebyMember.rows;

        if (getCircle) {
          return res.status(200).send({
            success: true,
            data: getCircle,
          });
        }

        return res.status(400).send("Unable to Retrive request");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:user_id/with-members",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.user_id) {
          return res
            .status(400)
            .send("Unauthorized: You can only access your own account");
        }

        const getCirclesWithMembers = await pool.query(
          `SELECT
  c.id,
  c.circle_name,
  c.circle_image,
  c.status,
  COALESCE(
    json_agg(
      json_build_object(
        'id', u.id,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'username', u.username,
        'profile_image', u.profile_image
      )
    ) FILTER (WHERE u.id IS NOT NULL),
    '[]'
  ) AS members
FROM circles c
LEFT JOIN circle_members cm ON c.id = cm.circle_id
LEFT JOIN users u ON cm.member_id = u.id
WHERE c.owner_id = $1
GROUP BY c.id`,
          [req.params.user_id],
        );

        return res.status(200).send({
          success: true,
          data: getCirclesWithMembers.rows,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/:id/:circle_id",
    authenticateToken,
    async (req, res, next) => {
      if (!req.body) return res.status(400).send("Request body cannot be empty");

      const allowed = ["circle_name", "circle_image"];

      const filterKeys = Object.keys(req.body).filter((key) => {
        return allowed.includes(key);
      });

      const values = filterKeys.map((value) => req.body[value]);

      const circleKeys = filterKeys
        .map((circle, index) => {
          return `${circle} = $${index + 3}`;
        })
        .join(", ");

      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only delete your own circle");
        }
        const updateCircle = await pool.query(
          `UPDATE circles SET ${circleKeys} WHERE owner_id = $1 AND id = $2 RETURNING *`,
          [req.params.id, req.params.circle_id, ...values],
        );

        const circleUpdated: CircleProp = updateCircle.rows[0];

        if (circleUpdated) {
          io.to(`user:${req.params.id}`).emit("circle:updated");
          return res.status(200).send({
            success: true,
            data: {
              circle_name: circleUpdated.circle_name,
              circle_image: circleUpdated.circle_image,
            },
          });
        }

        return res.status(404).send("Desired Circle doesn't exist");
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/:id/:circle_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only delete your own circle");
        }

        const deleteCircleByUser = await pool.query(
          `DELETE FROM circles WHERE owner_id = $1 AND id = $2 RETURNING *`,
          [req.params.id, req.params.circle_id],
        );

        const deleteCircle: CircleProp = deleteCircleByUser.rows[0];

        if (deleteCircle) {
          return res.status(200).send({
            success: true,
            message: `Circle named ${deleteCircle.circle_name} successfully deleted`,
          });
        }

        return res.status(400).send("Unable to handle request");
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/:circle_id/members/:member_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        const selectOwnerOfCircle = await pool.query(
          `SELECT owner_id FROM circles WHERE id = $1`,
          [req.params.circle_id],
        );

        const ownerOfCircle: CircleProp = selectOwnerOfCircle.rows[0];

        if (
          req.user?.id !== ownerOfCircle.owner_id &&
          req.user?.id !== req.params.member_id
        ) {
          return res.status(403).send("Unauthorized");
        }

        const removeMemberFromCircle = await pool.query(
          `DELETE FROM circle_members WHERE circle_id = $1 AND member_id = $2 RETURNING *`,
          [req.params.circle_id, req.params.member_id],
        );

        const removeMember = removeMemberFromCircle.rows[0];

        if (removeMember) {
          io.to(`user:${ownerOfCircle.owner_id}`).emit("member:removed");
          return res.status(200).send({
            success: true,
            message: `Removed ${removeMember.member_id}`,
          });
        }

        return res.status(400).send("Unable to delete user");
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/invite/:member_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        const invitedBy = await pool.query(
          "SELECT owner_id FROM circles WHERE id = $1",
          [req.params.id],
        );

        const owner: CircleProp = invitedBy.rows[0];

        if (req.user?.id !== owner.owner_id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const inviteMemberToCircle = await pool.query(
          "INSERT INTO invite_members (circle_id, member_id, invited_by) VALUES ($1, $2, $3) RETURNING *",
          [req.params.id, req.params.member_id, owner.owner_id],
        );

        const invitedMember: InviteMembersProp = inviteMemberToCircle.rows[0];

        if (invitedMember) {
          const getInvitedUser = await pool.query(
            `SELECT email, phone_number FROM users WHERE id = $1`,
            [req.params.member_id],
          );

          const invitedUser: UserProp = getInvitedUser.rows[0];

          io.to(`user:${req.params.member_id}`).emit("invite:circle");
          await sendEmail({
            email: invitedUser.email,
            invite_type: "received",
            invite_target: "circle",
            action_url: `https://app.copatible.com/join?circle=${invitedMember.circle_id}`,
          });
          await sendSMS({
            phone_number: invitedUser.phone_number,
            invite_type: "received",
            invite_target: "circle",
            action_url: `https://app.copatible.com/join?circle=${invitedMember.circle_id}`,
          });
          return res.status(201).send({
            success: true,
            data: invitedMember,
          });
        }

        return res.status(404).send("User not found");
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/invite-external",
    authenticateToken,
    async (req, res, next) => {
      try {
        const { recipient } = req.body;
        if (!recipient) return res.status(400).send("recipient is required.");

        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
        const isPhone = /^[\+]?[\d\s\-\(\)]{7,15}$/.test(recipient);
        if (!isEmail && !isPhone)
          return res
            .status(400)
            .send("recipient must be an email or phone number.");

        const existingUser = await pool.query(
          `SELECT id FROM users WHERE email = $1 OR phone_number = $1`,
          [recipient],
        );
        if (existingUser.rows.length > 0) {
          return res
            .status(400)
            .send("User is already on CoPatible. Use the standard invite.");
        }

        const ownerCheck = await pool.query(
          `SELECT owner_id FROM circles WHERE id = $1`,
          [req.params.id],
        );
        if (ownerCheck.rows[0]?.owner_id !== req.user?.id) {
          return res.status(403).send("Unauthorized");
        }

        const inviterResult = await pool.query(
          `SELECT first_name, last_name FROM users WHERE id = $1`,
          [req.user?.id],
        );
        const inviter = inviterResult.rows[0];
        const inviterName = inviter
          ? `${inviter.first_name} ${inviter.last_name}`.trim()
          : "Someone";

        const circleResult = await pool.query(
          `SELECT circle_name FROM circles WHERE id = $1`,
          [req.params.id],
        );
        const targetName = circleResult.rows[0]?.circle_name as
          | string
          | undefined;

        if (isEmail) {
          await sendEmail({
            email: recipient,
            external_invite: {
              inviter_name: inviterName,
              invite_type: "circle",
              target_name: targetName,
            },
          });
        } else {
          await sendSMS({
            phone_number: recipient,
            external_invite: {
              inviter_name: inviterName,
              invite_type: "circle",
              target_name: targetName,
            },
          });
        }

        return res.status(200).send({ success: true, external: true });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:circle_id/join",
    authenticateToken,
    async (req, res, next) => {
      try {
        const { circle_id } = req.params;

        const result = await pool.query(
          `UPDATE invite_members
         SET status = 'accepted', accepted_at = NOW()
         WHERE circle_id = $1 AND member_id = $2
         RETURNING *`,
          [circle_id, req.user?.id],
        );

        if (result.rows.length === 0) {
          return res.status(404).send("Invite not found.");
        }

        await pool.query(
          `INSERT INTO circle_members (circle_id, member_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [circle_id, req.user?.id],
        );

        const ownerResult = await pool.query(
          `SELECT owner_id FROM circles WHERE id = $1`,
          [circle_id],
        );
        if (ownerResult.rows[0]) {
          io.to(`user:${ownerResult.rows[0].owner_id}`).emit("member:added");
        }

        return res.status(200).send({ success: true, data: result.rows[0] });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
