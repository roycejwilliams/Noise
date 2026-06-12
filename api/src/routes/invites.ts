import { Router } from "express";
import type { RequestHandler } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";

export function createInvitesRouter(
  io: Server,
  authenticateToken: RequestHandler,
): Router {
  const router = Router();

  router.get(
    "/members/:member_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.member_id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const getAllInvitesByUser = await pool.query(
          `SELECT im.*, c.circle_name, c.circle_image, u.username AS invited_by_username
         FROM invite_members im
         JOIN circles c ON c.id = im.circle_id
         LEFT JOIN users u ON u.id = im.invited_by
         WHERE im.member_id = $1`,
          [req.params.member_id],
        );

        const invitesForUser: InviteMembersProp[] = getAllInvitesByUser.rows;

        if (invitesForUser) {
          return res.status(200).send({
            success: true,
            data: invitesForUser,
          });
        }

        return res.status(404).send("Cannot find user");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/members/sent/:invited_by",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.invited_by) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const getAllInvitesByOwner = await pool.query(
          "SELECT * FROM invite_members WHERE invited_by = $1",
          [req.params.invited_by],
        );

        const invitesFromOwner: InviteMembersProp[] = getAllInvitesByOwner.rows;

        if (invitesFromOwner) {
          return res.status(200).send({
            success: true,
            data: invitesFromOwner,
          });
        }

        return res.status(404).send("Cannot find user");
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/members/:id",
    authenticateToken,
    async (req, res, next) => {
      if (!req.body) return res.status(400).send("Request body cannot be empty.");

      const { status } = req.body;

      try {
        const getMemberId = await pool.query(
          "SELECT member_id, circle_id FROM invite_members WHERE id = $1",
          [req.params.id],
        );

        const memberId: InviteMembersProp = getMemberId.rows[0];

        if (req.user?.id !== memberId.member_id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const now = status === "accepted" ? new Date().toISOString() : null;

        const statusDecision = await pool.query(
          `UPDATE invite_members SET status = $2, accepted_at = $3 WHERE id = $1 RETURNING *`,
          [req.params.id, status, now],
        );

        const decision: InviteMembersProp = statusDecision.rows[0];

        const getOwner = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [decision.invited_by],
        );

        const owner: UserProp = getOwner.rows[0];

        if (decision.status === "accepted") {
          if (owner) {
            await sendEmail({
              email: owner.email,
              invite_type: "accepted",
              invite_target: "circle",
            });
            await sendSMS({
              phone_number: owner.phone_number,
              invite_type: "accepted",
              invite_target: "circle",
            });
          }
          const addToCircleQuery = await pool.query(
            `INSERT INTO circle_members (member_id, circle_id) VALUES ($1, $2) RETURNING *`,
            [memberId.member_id, memberId.circle_id],
          );

          const path: InviteMembersProp = addToCircleQuery.rows[0];

          if (path) {
            io.to(`user:${decision.invited_by}`).emit("invite:decision", {
              target: "circle",
              status: "accepted",
              circle_id: memberId.circle_id,
            });
            io.to(`user:${decision.invited_by}`).emit("member:added");
            return res.status(201).send({
              success: true,
              data: path,
              message: `${path.member_id} added to ${path.circle_id}`,
            });
          }
        }

        if (decision.status === "rejected") {
          if (owner) {
            await sendEmail({
              email: owner.email,
              invite_type: "rejected",
              invite_target: "circle",
            });
            await sendSMS({
              phone_number: owner.phone_number,
              invite_type: "rejected",
              invite_target: "circle",
            });
          }
          return res.status(200).send({
            failed: true,
            message: `${decision.member_id} rejected by ${decision.circle_id}`,
          });
        }

        return res.status(400).send("Unable to handle request");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/attendees/:attendee_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.attendee_id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const getAllInvitesByUser = await pool.query(
          `SELECT ia.*, m.moments_name, m.image, m.moment_start, m.location_name,
                u.username AS invited_by_username
         FROM invite_attendees ia
         JOIN moments m ON m.id = ia.moment_id
         LEFT JOIN users u ON u.id = ia.invited_by
         WHERE ia.attendee_id = $1`,
          [req.params.attendee_id],
        );

        const invitesForUser: InviteAttendeesProp[] = getAllInvitesByUser.rows;

        if (invitesForUser) {
          return res.status(200).send({
            success: true,
            data: invitesForUser,
          });
        }

        return res.status(404).send("Cannot find user");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/attendees/sent/:invited_by",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.invited_by) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const getAllInvitesByOwner = await pool.query(
          "SELECT * FROM invite_attendees WHERE invited_by = $1",
          [req.params.invited_by],
        );

        const invitesFromOwner: InviteAttendeesProp[] = getAllInvitesByOwner.rows;

        if (invitesFromOwner) {
          return res.status(200).send({
            success: true,
            data: invitesFromOwner,
          });
        }

        return res.status(404).send("Cannot find user");
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/attendees/:id",
    authenticateToken,
    async (req, res, next) => {
      if (!req.body) return res.status(400).send("Request body cannot be empty.");

      const { status } = req.body;

      try {
        const getAttendeeId = await pool.query(
          "SELECT attendee_id, moment_id FROM invite_attendees WHERE id = $1",
          [req.params.id],
        );

        const attendeeId: InviteAttendeesProp = getAttendeeId.rows[0];

        if (req.user?.id !== attendeeId.attendee_id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        const now = status === "accepted" ? new Date().toISOString() : null;

        const statusDecision = await pool.query(
          `UPDATE invite_attendees SET status = $2, accepted_at = $3 WHERE id = $1 RETURNING *`,
          [req.params.id, status, now],
        );

        const decision: InviteAttendeesProp = statusDecision.rows[0];

        const getOwner = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [decision.invited_by],
        );

        const owner: UserProp = getOwner.rows[0];

        if (decision.status === "accepted") {
          const capacityCheck = await pool.query(
            `SELECT cap_attendance,
            (SELECT COUNT(*) FROM moment_attendees WHERE moment_id = $1) AS confirmed
           FROM moments WHERE id = $1`,
            [attendeeId.moment_id],
          );

          const { cap_attendance, confirmed } = capacityCheck.rows[0];
          if (cap_attendance && parseInt(confirmed) >= cap_attendance) {
            return res.status(409).send("This moment is at capacity.");
          }

          if (owner) {
            await sendEmail({
              email: owner.email,
              invite_type: "accepted",
              invite_target: "moment",
            });
            await sendSMS({
              phone_number: owner.phone_number,
              invite_type: "accepted",
              invite_target: "moment",
            });
          }
          const addToCircleQuery = await pool.query(
            `INSERT INTO moment_attendees (attendee_id, moment_id) VALUES ($1, $2) RETURNING *`,
            [attendeeId.attendee_id, attendeeId.moment_id],
          );

          const path: InviteAttendeesProp = addToCircleQuery.rows[0];

          if (path) {
            io.to(`user:${decision.invited_by}`).emit("invite:decision", {
              target: "moment",
              status: "accepted",
              moment_id: attendeeId.moment_id,
            });
            return res.status(201).send({
              success: true,
              data: path,
              message: `${path.attendee_id} added to ${path.moment_id}`,
            });
          }
        }

        if (decision.status === "rejected") {
          if (owner) {
            await sendEmail({
              email: owner.email,
              invite_type: "rejected",
              invite_target: "moment",
            });
            await sendSMS({
              phone_number: owner.phone_number,
              invite_type: "rejected",
              invite_target: "moment",
            });
          }
          return res.status(200).send({
            failed: true,
            message: `${decision.attendee_id} rejected by ${decision.invited_by}`,
          });
        }

        return res.status(400).send("Unable to handle request");
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
