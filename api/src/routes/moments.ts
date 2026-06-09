import type { RequestHandler } from "express";
import { Router } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";

export function createMomentsRouter(
  io: Server,
  authenticateToken: RequestHandler,
): Router {
  const router = Router();

  router.post("/moments/:id", authenticateToken, async (req, res, next) => {
    if (!req.body) return res.status(400).send("Request body cannot be empty.");

    const {
      moments_name,
      location,
      location_name,
      moment_start,
      visibility_type,
      description,
      circle_id,
      image,
      principles,
      expectations,
      faqs,
      vibes,
      cap_attendance,
    } = req.body;

    if (
      !moments_name ||
      !location ||
      !location_name ||
      !moment_start ||
      !visibility_type ||
      !description
    ) {
      const missing = [
        "moments_name",
        "location",
        "location_name",
        "moment_start",
        "visibility_type",
        "description",
      ].find((key) => !req.body[key]);

      return res.status(400).send(`${missing} is required.`);
    }

    try {
      if (req.user?.id !== req.params.id) {
        return res
          .status(400)
          .send("Unauthorized: You can only access your own account");
      }

      const createMomentsById = await pool.query(
        `INSERT INTO moments
    (creator_id, moments_name, location, location_name, moment_start, visibility_type, description, circle_id, image, principles, expectations, faqs, vibes, cap_attendance)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
   RETURNING *`,
        [
          req.params.id,
          moments_name,
          location,
          location_name,
          moment_start,
          visibility_type,
          description,
          circle_id || null,
          image,
          principles,
          expectations,
          JSON.stringify(faqs),
          vibes,
          cap_attendance || null,
        ],
      );

      const createMoment: MomentProp = createMomentsById.rows[0];

      if (createMoment) {
        if (createMoment.visibility_type === "nearby") {
          io.emit("moment:created", { visibility_type: "nearby" });
        } else if (createMoment.visibility_type === "circle" && circle_id) {
          const members = await pool.query(
            `SELECT member_id FROM circle_members WHERE circle_id = $1`,
            [circle_id],
          );
          for (const { member_id } of members.rows) {
            io.to(`user:${member_id}`).emit("moment:created", {
              visibility_type: "circle",
            });
          }
        }
        return res.status(201).send({
          success: true,
          data: createMoment,
        });
      }

      return res.status(400).send("Unable to Create Moment");
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/moments/moment/:moment_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        const getMoment = await pool.query(
          `SELECT * FROM moments WHERE id = $1`,
          [req.params.moment_id],
        );

        const moment: MomentProp = getMoment.rows[0];
        if (!moment) return res.status(404).send("Moment not found.");

        const userId = req.user?.id;
        const isCreator = moment.creator_id === userId;

        if (isCreator)
          return res.status(200).send({ success: true, data: moment });

        if (moment.visibility_type === "nearby") {
          return res.status(200).send({ success: true, data: moment });
        }

        if (moment.visibility_type === "circle") {
          const memberCheck = await pool.query(
            `SELECT 1 FROM circle_members WHERE circle_id = $1 AND member_id = $2`,
            [moment.circle_id, userId],
          );
          if (!memberCheck.rows.length)
            return res.status(403).send("Unauthorized.");
          return res.status(200).send({ success: true, data: moment });
        }

        if (moment.visibility_type === "people") {
          const inviteCheck = await pool.query(
            `SELECT 1 FROM invite_attendees WHERE moment_id = $1 AND attendee_id = $2`,
            [moment.id, userId],
          );
          if (!inviteCheck.rows.length)
            return res.status(403).send("Unauthorized.");
          return res.status(200).send({ success: true, data: moment });
        }

        return res.status(403).send("Unauthorized.");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/moments/nearby", authenticateToken, async (req, res, next) => {
    try {
      const {
        lng,
        lat,
        radius = 10000,
        filter = "tonight",
        search,
      } = req.query;

      const userId = req.user?.id;

      if (search && !lng && !lat) {
        const result = await pool.query(
          `SELECT m.* FROM moments m
           WHERE (
             LOWER(m.moments_name) ILIKE $1
             OR LOWER(m.location_name) ILIKE $1
           )
           AND m.close_moment IS NOT TRUE
           AND (
             m.visibility_type = 'nearby'
             OR m.creator_id = $2
             OR (m.visibility_type = 'circle' AND EXISTS (
               SELECT 1 FROM circle_members WHERE circle_id = m.circle_id AND member_id = $2
             ))
             OR (m.visibility_type = 'people' AND EXISTS (
               SELECT 1 FROM invite_attendees WHERE moment_id = m.id AND attendee_id = $2
             ))
           )
           ORDER BY m.moment_start ASC
           LIMIT 10`,
          [`%${(search as string).toLowerCase()}%`, userId],
        );
        return res.status(200).send({ success: true, data: result.rows });
      }

      const lngNum = parseFloat(lng as string);
      const latNum = parseFloat(lat as string);
      const radNum = parseFloat(radius as string);

      if (isNaN(lngNum) || isNaN(latNum)) {
        return res.status(400).send("Valid coordinates are required.");
      }

      let startTime: string;
      let endTime: string;

      const now = new Date();

      if (filter === "tonight") {
        const start = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        startTime = start.toISOString();
        const end = new Date(now);
        end.setUTCDate(end.getUTCDate() + 1);
        end.setUTCHours(11, 0, 0, 0);
        endTime = end.toISOString();
      } else if (filter === "tomorrow") {
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() + 1);
        start.setUTCHours(7, 0, 0, 0);
        const end = new Date(start);
        end.setUTCHours(6, 59, 59, 0);
        end.setUTCDate(end.getUTCDate() + 1);
        startTime = start.toISOString();
        endTime = end.toISOString();
      } else {
        startTime = now.toISOString();
        const end = new Date(now);
        end.setUTCDate(end.getUTCDate() + 7);
        end.setUTCHours(6, 59, 59, 0);
        endTime = end.toISOString();
      }

      const result = await pool.query(
        `SELECT m.*,
          ST_Distance(
            ST_SetSRID(ST_MakePoint(m.location[0], m.location[1]), 4326)::geography,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
          ) as distance
        FROM moments m
        WHERE
          m.location IS NOT NULL
          AND (
            m.visibility_type = 'nearby'
            OR m.creator_id = $6
            OR (m.visibility_type = 'circle' AND EXISTS (
              SELECT 1 FROM circle_members
              WHERE circle_id = m.circle_id AND member_id = $6
            ))
            OR (m.visibility_type = 'people' AND EXISTS (
              SELECT 1 FROM invite_attendees
              WHERE moment_id = m.id AND attendee_id = $6
            ))
          )
          AND ST_DWithin(
            ST_SetSRID(ST_MakePoint(m.location[0], m.location[1]), 4326)::geography,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
          )
          AND m.moment_start >= $4
          AND m.moment_start <= $5
          AND m.close_moment IS NOT TRUE
        ORDER BY distance ASC
        LIMIT 20`,
        [lngNum, latNum, radNum, startTime, endTime, userId],
      );

      return res.status(200).send({ success: true, data: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/moments/:moment_id/knock",
    authenticateToken,
    async (req, res, next) => {
      const { requester_id } = req.body;
      if (!requester_id)
        return res.status(400).send("requester_id is required.");
      if (req.user?.id !== requester_id)
        return res.status(403).send("Unauthorized.");

      try {
        const momentResult = await pool.query(
          `SELECT creator_id, moments_name, close_moment FROM moments WHERE id = $1`,
          [req.params.moment_id],
        );
        const moment = momentResult.rows[0];
        if (!moment) return res.status(404).send("Moment not found.");
        if (moment.close_moment)
          return res.status(403).send("This moment is closed.");
        if (moment.creator_id === requester_id)
          return res.status(400).send("You are the host.");

        const existing = await pool.query(
          `SELECT id FROM invite_attendees WHERE moment_id = $1 AND attendee_id = $2 AND invited_by = $2`,
          [req.params.moment_id, requester_id],
        );
        if (existing.rows.length)
          return res.status(409).send("Knock already sent.");

        const insert = await pool.query(
          `INSERT INTO invite_attendees (moment_id, attendee_id, invited_by) VALUES ($1, $2, $2) RETURNING *`,
          [req.params.moment_id, requester_id],
        );
        const knock = insert.rows[0];

        io.to(`user:${moment.creator_id}`).emit("knock:received", {
          knock_id: knock.id,
          moment_id: req.params.moment_id,
        });

        const [hostResult, requesterResult] = await Promise.all([
          pool.query(`SELECT email, phone_number FROM users WHERE id = $1`, [
            moment.creator_id,
          ]),
          pool.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [
            requester_id,
          ]),
        ]);
        const host = hostResult.rows[0];
        const requester = requesterResult.rows[0];
        if (host && requester) {
          const requesterName =
            `${requester.first_name} ${requester.last_name}`.trim();
          const momentUrl = `https://br3w.app/moments/${req.params.moment_id}`;
          await sendEmail({
            email: host.email,
            knock_received: {
              moments_name: moment.moments_name,
              requester_name: requesterName,
            },
            action_url: momentUrl,
          });
          await sendSMS({
            phone_number: host.phone_number,
            knock_received: {
              moments_name: moment.moments_name,
              requester_name: requesterName,
            },
            action_url: momentUrl,
          });
        }

        return res.status(201).send({ success: true, data: knock });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/moments/knocks/received/:owner_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.owner_id)
          return res.status(403).send("Unauthorized.");

        const result = await pool.query(
          `SELECT ia.id, ia.attendee_id AS requester_id, ia.status, ia.created_at,
                m.id AS moment_id, m.moments_name, m.image,
                u.first_name AS requester_first_name,
                u.last_name  AS requester_last_name,
                u.username   AS requester_username,
                u.profile_image AS requester_profile_image
         FROM invite_attendees ia
         JOIN moments m ON m.id = ia.moment_id
         JOIN users   u ON u.id = ia.attendee_id
         WHERE m.creator_id = $1
           AND ia.invited_by = ia.attendee_id
         ORDER BY ia.created_at DESC`,
          [req.params.owner_id],
        );

        return res.status(200).send({ success: true, data: result.rows });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/moments/:id", authenticateToken, async (req, res, next) => {
    try {
      if (req.user?.id !== req.params.id) {
        return res
          .status(400)
          .send("Unauthorized: You can only access your own account");
      }

      const getMomentbyId = await pool.query(
        `SELECT * FROM moments WHERE creator_id = $1`,
        [req.params.id],
      );

      const getMoments: MomentProp[] = getMomentbyId.rows;

      if (getMoments) {
        return res.status(200).send({
          success: true,
          data: getMoments,
        });
      }

      return res.status(400).send("Unable to retrieve moments");
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/moments/:id/member",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(400)
            .send("Unauthorized: You can only access your own account");
        }

        const retrieveMomentsforMember = await pool.query(
          `SELECT * FROM moments
        INNER JOIN moment_attendees
        ON moments.id = moment_attendees.moment_id WHERE moment_attendees.attendee_id = $1`,
          [req.params.id],
        );

        const getMoment: MomentProp[] = retrieveMomentsforMember.rows;

        if (getMoment) {
          return res.status(200).send({
            success: true,
            data: getMoment,
          });
        }

        return res.status(400).send("Unable to Retrive request");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/moments/:moment_id/attendees/details",
    authenticateToken,
    async (req, res, next) => {
      try {
        const { moment_id } = req.params;
        const result = await pool.query(
          `SELECT
  u.id,
  u.username,
  u.first_name,
  u.last_name,
  u.profile_image,
  COALESCE(ma.checked_in, false) as checked_in,
  ma.checked_in_at,
  CASE
    WHEN ma.attendee_id IS NOT NULL THEN 'attending'
    ELSE ia.status
  END as status
FROM (
  SELECT attendee_id FROM moment_attendees WHERE moment_id = $1
  UNION
  SELECT attendee_id FROM invite_attendees WHERE moment_id = $1
) combined
JOIN users u ON u.id = combined.attendee_id
LEFT JOIN moment_attendees ma ON ma.attendee_id = u.id AND ma.moment_id = $1
LEFT JOIN invite_attendees ia ON ia.attendee_id = u.id AND ia.moment_id = $1`,
          [moment_id],
        );
        return res.status(200).send({ success: true, data: result.rows });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/moments/:moment_id/attendees",
    authenticateToken,
    async (req, res, next) => {
      try {
        const getAttendees = await pool.query(
          `SELECT u.id, u.first_name, u.last_name, u.username, u.profile_image
        FROM moment_attendees ma
        JOIN users u ON ma.attendee_id = u.id
        WHERE ma.moment_id = $1`,
          [req.params.moment_id],
        );

        const attendees = getAttendees.rows;

        return res.status(200).send({
          success: true,
          data: attendees,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/moments/knocks/:knock_id",
    authenticateToken,
    async (req, res, next) => {
      const { status } = req.body;
      if (status !== "accepted" && status !== "rejected")
        return res.status(400).send("status must be accepted or rejected.");

      try {
        const knockResult = await pool.query(
          `SELECT ia.id, ia.attendee_id AS requester_id, ia.moment_id, ia.status AS current_status,
                m.creator_id, m.moments_name, m.image AS moment_image, m.cap_attendance
         FROM invite_attendees ia
         JOIN moments m ON m.id = ia.moment_id
         WHERE ia.id = $1 AND ia.invited_by = ia.attendee_id`,
          [req.params.knock_id],
        );
        const knock = knockResult.rows[0];
        if (!knock) return res.status(404).send("Knock not found.");
        if (knock.creator_id !== req.user?.id)
          return res.status(403).send("Unauthorized.");
        if (knock.current_status !== "pending")
          return res.status(409).send("Knock already decided.");

        await pool.query(
          `UPDATE invite_attendees SET status = $1, accepted_at = $2 WHERE id = $3`,
          [
            status,
            status === "accepted" ? new Date().toISOString() : null,
            req.params.knock_id,
          ],
        );

        const momentUrl = `https://br3w.app/moments/${knock.moment_id}`;

        if (status === "accepted") {
          const capacityResult = await pool.query(
            `SELECT COUNT(*) FROM moment_attendees WHERE moment_id = $1`,
            [knock.moment_id],
          );
          const confirmed = parseInt(capacityResult.rows[0].count);
          if (knock.cap_attendance && confirmed >= knock.cap_attendance) {
            return res.status(409).send("This moment is at capacity.");
          }

          await pool.query(
            `INSERT INTO moment_attendees (attendee_id, moment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [knock.requester_id, knock.moment_id],
          );

          io.to(`user:${knock.requester_id}`).emit("knock:decided", {
            status: "accepted",
            moment_id: knock.moment_id,
          });

          const requesterResult = await pool.query(
            `SELECT email, phone_number, first_name, last_name, username, profile_image FROM users WHERE id = $1`,
            [knock.requester_id],
          );
          const requester = requesterResult.rows[0];
          if (requester) {
            await sendEmail({
              email: requester.email,
              knock_decided: {
                moments_name: knock.moments_name,
                approved: true,
              },
              action_url: momentUrl,
            });
            await sendSMS({
              phone_number: requester.phone_number,
              knock_decided: {
                moments_name: knock.moments_name,
                approved: true,
              },
              action_url: momentUrl,
            });
          }

          const rippleResult = await pool.query(
            `SELECT DISTINCT u.id, u.first_name, u.last_name, u.username, u.profile_image
           FROM circle_members cm
           JOIN users u ON u.id = cm.member_id
           WHERE cm.circle_id IN (SELECT id FROM circles WHERE owner_id = $1)
             AND cm.member_id != $2
             AND cm.member_id NOT IN (
               SELECT attendee_id FROM moment_attendees WHERE moment_id = $3
             )
             AND cm.member_id NOT IN (
               SELECT attendee_id FROM invite_attendees
               WHERE moment_id = $3 AND status IN ('pending', 'accepted')
             )`,
            [knock.creator_id, knock.requester_id, knock.moment_id],
          );

          for (const member of rippleResult.rows) {
            await pool.query(
              `INSERT INTO notifications
               (user_id, type, moment_id, moments_name, moment_image,
                friend_id, friend_first_name, friend_last_name, friend_username, friend_profile_image)
             VALUES ($1, 'moment_nearby_friend', $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                member.id,
                knock.moment_id,
                knock.moments_name,
                knock.moment_image ?? null,
                knock.requester_id,
                requester?.first_name ?? null,
                requester?.last_name ?? null,
                requester?.username ?? null,
                requester?.profile_image ?? null,
              ],
            );
            io.to(`user:${member.id}`).emit("nearby:friend", {
              moment_id: knock.moment_id,
              moments_name: knock.moments_name,
            });
          }
        } else {
          io.to(`user:${knock.requester_id}`).emit("knock:decided", {
            status: "rejected",
            moment_id: knock.moment_id,
          });

          const requesterResult = await pool.query(
            `SELECT email, phone_number FROM users WHERE id = $1`,
            [knock.requester_id],
          );
          const requester = requesterResult.rows[0];
          if (requester) {
            await sendEmail({
              email: requester.email,
              knock_decided: {
                moments_name: knock.moments_name,
                approved: false,
              },
            });
            await sendSMS({
              phone_number: requester.phone_number,
              knock_decided: {
                moments_name: knock.moments_name,
                approved: false,
              },
            });
          }
        }

        return res.status(200).send({ success: true, data: { status } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/moments/:id/:moment_id",
    authenticateToken,
    async (req, res, next) => {
      if (!req.body)
        return res.status(400).send("Request body cannot be empty");

      const formatLocation = (loc: any): string | null => {
        if (!loc) return null;
        if (typeof loc === "string") return loc;
        if (typeof loc === "object" && loc.x !== undefined) {
          return `(${loc.x},${loc.y})`;
        }
        return null;
      };

      const allowed = [
        "image",
        "moments_name",
        "moment_start",
        "moment_end",
        "description",
        "location",
        "location_name",
        "cap_attendance",
        "close_moment",
        "visibility_type",
      ];

      const filteredKeys = Object.keys(req.body).filter((key) => {
        return allowed.includes(key);
      });

      const valueOfKeys = filteredKeys.map((key) => {
        if (key === "location") return formatLocation(req.body[key]);
        return req.body[key];
      });

      const momentKeys = filteredKeys
        .map((key, index) => {
          return `${key} = $${index + 3}`;
        })
        .join(", ");

      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(400)
            .send("Unauthorized: You can only access your own account");
        }

        const updateMoment = await pool.query(
          `UPDATE moments SET ${momentKeys} WHERE creator_id = $1 and id = $2 RETURNING *`,
          [req.params.id, req.params.moment_id, ...valueOfKeys],
        );

        const momentUpdated: MomentProp = updateMoment.rows[0];

        if (momentUpdated) {
          io.to(`moment:${req.params.moment_id}`).emit(
            "moment:updated",
            momentUpdated,
          );
          return res.status(200).send({
            success: true,
            data: momentUpdated,
          });
        }

        return res.status(400).send("Unable to update moment");
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/moments/:id/:moment_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        if (req.user?.id !== req.params.id) {
          return res
            .status(403)
            .send("Unauthorized: You can only delete your own circle");
        }
        const deleteMomentbyOwner = await pool.query(
          `DELETE FROM moments WHERE creator_id = $1 AND id = $2 RETURNING *`,
          [req.params.id, req.params.moment_id],
        );

        const deletedMoment: MomentProp = await deleteMomentbyOwner.rows[0];

        if (deletedMoment) {
          return res.status(200).send({
            success: true,
            message: `Moment ${deletedMoment.moments_name} was deleted`,
          });
        }

        return res.status(404).send("Moment doesn't exist");
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/moments/:moment_id/attendees/:attendee_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        const selectOwnerOfMoment = await pool.query(
          "SELECT creator_id FROM moments WHERE id = $1",
          [req.params.moment_id],
        );

        const ownerOfMoment: MomentProp = selectOwnerOfMoment.rows[0];

        if (
          req.user?.id !== ownerOfMoment.creator_id &&
          req.user?.id !== req.params.attendee_id
        ) {
          return res.status(403).send("Unauthorized");
        }

        const removeAttendeeFromMoment = await pool.query(
          `DELETE FROM moment_attendees WHERE moment_id = $1 AND attendee_id = $2 RETURNING *`,
          [req.params.moment_id, req.params.attendee_id],
        );

        const removeAttendee = removeAttendeeFromMoment.rows[0];

        if (removeAttendee) {
          return res.status(200).send({
            success: true,
            message: `Removed ${removeAttendee.attendee_id}`,
          });
        }

        return res.status(404).send("Attendee doesn't exist");
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/moments/:moment_id/photos",
    authenticateToken,
    async (req, res, next) => {
      try {
        const result = await pool.query(
          `SELECT mp.*, u.username, u.profile_image
        FROM moment_photos mp
        JOIN users u ON mp.uploader_id = u.id
        WHERE mp.moment_id = $1
        ORDER BY mp.created_at ASC`,
          [req.params.moment_id],
        );
        return res.status(200).send({ success: true, data: result.rows });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/moments/:moment_id/photos",
    authenticateToken,
    async (req, res, next) => {
      const { image_url } = req.body;
      if (!image_url) return res.status(400).send("image_url is required.");
      try {
        const result = await pool.query(
          `INSERT INTO moment_photos (moment_id, uploader_id, image_url)
        VALUES ($1, $2, $3) RETURNING *`,
          [req.params.moment_id, req.user?.id, image_url],
        );

        const getMomentCreator = await pool.query(
          `SELECT m.creator_id, m.moments_name, u.email, u.phone_number
        FROM moments m
        JOIN users u ON m.creator_id = u.id
        WHERE m.id = $1`,
          [req.params.moment_id],
        );
        const creator = getMomentCreator.rows[0];

        const getUploader = await pool.query(
          `SELECT username FROM users WHERE id = $1`,
          [req.user?.id],
        );
        const uploader = getUploader.rows[0];

        if (creator && creator.creator_id !== req.user?.id) {
          await sendEmail({
            email: creator.email,
            photo_uploaded: {
              moments_name: creator.moments_name,
              uploader_username: uploader.username,
            },
            action_url: `https://br3w.app/moments/${req.params.moment_id}`,
          });
          await sendSMS({
            phone_number: creator.phone_number,
            photo_uploaded: {
              moments_name: creator.moments_name,
              uploader_username: uploader.username,
            },
            action_url: `https://br3w.app/moments/${req.params.moment_id}`,
          });
        }

        io.to(`moment:${req.params.moment_id}`).emit(
          "photo:new",
          result.rows[0],
        );
        return res.status(201).send({ success: true, data: result.rows[0] });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/moments/:moment_id/photos/:photo_id",
    authenticateToken,
    async (req, res, next) => {
      try {
        const check = await pool.query(
          `SELECT uploader_id FROM moment_photos WHERE id = $1`,
          [req.params.photo_id],
        );
        if (!check.rows.length) return res.status(404).send("Photo not found.");
        if (check.rows[0].uploader_id !== req.user?.id)
          return res.status(403).send("Unauthorized.");

        await pool.query(`DELETE FROM moment_photos WHERE id = $1`, [
          req.params.photo_id,
        ]);
        io.to(`moment:${req.params.moment_id}`).emit("photo:deleted", {
          photo_id: req.params.photo_id,
        });
        return res.status(200).send({ success: true });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/moments/:moment_id/checkin",
    authenticateToken,
    async (req, res, next) => {
      try {
        const { moment_id } = req.params;
        const { attendee_id } = req.body;

        if (!attendee_id) {
          return res.status(400).send("attendee_id is required.");
        }

        const momentResult = await pool.query(
          "SELECT creator_id, close_moment, moments_name FROM moments WHERE id = $1",
          [moment_id],
        );

        if (momentResult.rows.length === 0) {
          return res.status(404).send("Moment not found.");
        }

        if (momentResult.rows[0].creator_id !== req.user?.id) {
          return res.status(403).send("Only the creator can check people in.");
        }

        if (momentResult.rows[0].close_moment) {
          return res.status(403).send("This moment is closed.");
        }

        const attendeeResult = await pool.query(
          "SELECT * FROM moment_attendees WHERE moment_id = $1 AND attendee_id = $2",
          [moment_id, attendee_id],
        );

        if (attendeeResult.rows.length === 0) {
          return res.status(404).send("Attendee not found for this moment.");
        }

        if (attendeeResult.rows[0].checked_in) {
          return res.status(400).send("Attendee already checked in.");
        }

        const result = await pool.query(
          "UPDATE moment_attendees SET checked_in = TRUE, checked_in_at = NOW() WHERE moment_id = $1 AND attendee_id = $2 RETURNING *",
          [moment_id, attendee_id],
        );

        const getAttendee = await pool.query(
          `SELECT username, email, phone_number FROM users WHERE id = $1`,
          [attendee_id],
        );
        const attendee = getAttendee.rows[0];

        const getCreator = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [momentResult.rows[0].creator_id],
        );
        const creator = getCreator.rows[0];

        const checkInUrl = `https://br3w.app/moments/${moment_id}`;
        const checkInPayload = {
          moments_name: momentResult.rows[0].moments_name,
          attendee_username: attendee.username,
        };

        await sendEmail({
          email: attendee.email,
          checked_in_self: { moments_name: momentResult.rows[0].moments_name },
          action_url: checkInUrl,
        });
        await sendSMS({
          phone_number: attendee.phone_number,
          checked_in_self: { moments_name: momentResult.rows[0].moments_name },
          action_url: checkInUrl,
        });

        await sendEmail({
          email: creator.email,
          check_in: checkInPayload,
          action_url: checkInUrl,
        });
        await sendSMS({
          phone_number: creator.phone_number,
          check_in: checkInPayload,
          action_url: checkInUrl,
        });

        const otherAttendees = await pool.query(
          `SELECT u.email, u.phone_number
         FROM moment_attendees ma
         JOIN users u ON u.id = ma.attendee_id
         WHERE ma.moment_id = $1 AND ma.attendee_id != $2 AND ma.attendee_id != $3`,
          [moment_id, attendee_id, momentResult.rows[0].creator_id],
        );
        for (const other of otherAttendees.rows) {
          await sendEmail({
            email: other.email,
            check_in: checkInPayload,
            action_url: checkInUrl,
          });
          await sendSMS({
            phone_number: other.phone_number,
            check_in: checkInPayload,
            action_url: checkInUrl,
          });
        }

        // Increment trust score on check-in — showing up compounds trust
        await pool.query(
          `UPDATE co_profiles 
   SET trust_score = LEAST(trust_score + 5, 100),
       trust_components = jsonb_set(
         COALESCE(trust_components, '{}'),
         '{last_checkin}',
         $2::jsonb
       ),
       updated_at = NOW()
   WHERE user_id = $1`,
          [
            attendee_id,
            JSON.stringify({
              moment_id,
              checked_in_at: new Date().toISOString(),
            }),
          ],
        );

        // Store check-in as co_memory
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
   VALUES ($1, 'check_in', $2)`,
          [attendee_id, `Attended moment ${moment_id}. Trust score increased.`],
        );

        io.to(`moment:${moment_id}`).emit("checkin:update");
        return res.status(200).send({ success: true, data: result.rows[0] });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/moment/:id/invite",
    authenticateToken,
    async (req, res, next) => {
      const { recipient } = req.body;

      try {
        const ownerCheck = await pool.query(
          `SELECT creator_id, close_moment FROM moments WHERE id = $1`,
          [req.params.id],
        );

        const ownerOfMoment: MomentProp = ownerCheck.rows[0];
        const isOwner = req.user?.id === ownerOfMoment.creator_id;

        if (ownerOfMoment.close_moment) {
          return res.status(403).send("This moment is closed.");
        }

        const attendeeCheck = await pool.query(
          `SELECT attendee_id FROM moment_attendees WHERE moment_id = $1 AND attendee_id = $2`,
          [req.params.id, req.user?.id],
        );

        const isAttendee = attendeeCheck.rows[0];

        if (!isOwner && !isAttendee) {
          return res.status(403).send("Unauthorized");
        }

        const findRecipient = await pool.query(
          `SELECT id, email, phone_number FROM users WHERE username = $1 OR email = $1 OR phone_number = $1`,
          [recipient],
        );

        const recipientUser: UserProp = findRecipient.rows[0];

        if (!recipientUser) {
          const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
          const isPhone = /^[\+]?[\d\s\-\(\)]{7,15}$/.test(recipient);
          if (!isEmail && !isPhone)
            return res.status(404).send("Recipient not found.");

          const inviterResult = await pool.query(
            `SELECT first_name, last_name FROM users WHERE id = $1`,
            [req.user?.id],
          );
          const inviter = inviterResult.rows[0];
          const inviterName = inviter
            ? `${inviter.first_name} ${inviter.last_name}`.trim()
            : "Someone";

          const momentResult = await pool.query(
            `SELECT moments_name FROM moments WHERE id = $1`,
            [req.params.id],
          );
          const targetName = momentResult.rows[0]?.moments_name as
            | string
            | undefined;

          if (isEmail) {
            await sendEmail({
              email: recipient,
              external_invite: {
                inviter_name: inviterName,
                invite_type: "moment",
                target_name: targetName,
              },
            });
          } else {
            await sendSMS({
              phone_number: recipient,
              external_invite: {
                inviter_name: inviterName,
                invite_type: "moment",
                target_name: targetName,
              },
            });
          }
          return res.status(200).send({ success: true, external: true });
        }

        const inviteAttendeeToMoment = await pool.query(
          "INSERT INTO invite_attendees (moment_id, attendee_id, invited_by) VALUES ($1, $2, $3) RETURNING *",
          [req.params.id, recipientUser.id, req.user?.id],
        );

        const invitedAttendee: InviteAttendeesProp =
          inviteAttendeeToMoment.rows[0];

        if (invitedAttendee) {
          io.to(`user:${recipientUser.id}`).emit("invite:moment");
          await sendEmail({
            email: recipientUser.email,
            invite_type: "received",
            invite_target: "moment",
            action_url: `https://br3w.app/moments/${req.params.id}`,
          });
          await sendSMS({
            phone_number: recipientUser.phone_number,
            invite_type: "received",
            invite_target: "moment",
            action_url: `https://br3w.app/moments/${req.params.id}`,
          });
          return res.status(201).send({
            success: true,
            data: invitedAttendee,
          });
        }

        return res.status(404).send("User not found");
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/attendee/:attendee_id/transfer/:moment_id",
    authenticateToken,
    async (req, res, next) => {
      if (!req.body)
        return res.status(400).send("Request body cannot be empty.");

      const { recipient } = req.body;

      try {
        const getTicketOwner = await pool.query(
          `SELECT * FROM invite_attendees
        WHERE attendee_id = $1 AND moment_id = $2 AND status = 'accepted'`,
          [req.params.attendee_id, req.params.moment_id],
        );

        const owner: UserProp = getTicketOwner.rows[0];

        if (!owner) {
          return res.status(403).send("You do not own this ticket.");
        }

        if (req.user?.id !== req.params.attendee_id) {
          return res.status(403).send("Unauthorized");
        }

        const findRecipient = await pool.query(
          `SELECT * FROM users WHERE username = $1 OR phone_number = $1 OR email = $1`,
          [recipient],
        );

        const getRecipient: UserProp = findRecipient.rows[0];

        if (getRecipient) {
          const sendTicket = await pool.query(
            `UPDATE invite_attendees SET attendee_id = $1 WHERE attendee_id = $2 AND moment_id = $3 RETURNING *`,
            [getRecipient.id, req.params.attendee_id, req.params.moment_id],
          );

          await sendEmail({
            email: getRecipient.email,
            transfer_ticket: true,
            action_url: `https://br3w.app/moments/${req.params.moment_id}`,
          });
          await sendSMS({
            phone_number: getRecipient.phone_number,
            transfer_ticket: true,
            action_url: `https://br3w.app/moments/${req.params.moment_id}`,
          });
          return res.status(200).send({
            success: true,
            data: sendTicket.rows[0],
          });
        }
        return res.status(404).send("Cannot find recipient");
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
