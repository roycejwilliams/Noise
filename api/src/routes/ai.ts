import { Router } from "express";
import type { RequestHandler } from "express";
import type { Server } from "socket.io";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many AI requests, please try again in 15 minutes.",
  statusCode: 429,
});

export function createAiRouter(
  io: Server,
  authenticateToken: RequestHandler,
): Router {
  const router = Router();

  router.post(
    "/generate",
    authenticateToken,
    aiLimiter,
    async (req, res, next) => {
      try {
        const { description } = req.body;

        const { output } = await generateText({
          model: anthropic("claude-sonnet-4-6"),
          maxOutputTokens: 1024,
          output: Output.object({
            schema: z.object({
              generate: z.object({
                principles: z.array(z.string()),
                expectations: z.array(z.string()),
                faqs: z.array(
                  z.object({ question: z.string(), answer: z.string() }),
                ),
                vibes: z.array(z.string()),
              }),
            }),
          }),
          prompt: `Based on this event description: "${description}"

        Return ONLY a JSON object with no preamble or markdown:
        {
          "principles": [...],
          "expectations": [...],
          "faqs": [{ "question": "...", "answer": "..." }],
          "vibes": ["vibe 1", "vibe 2"]
        }

        Generate between 3 and 6 items for each array. Vibes between 5 and 10 with 1 word describing the event.
        Keep each item to 1-2 sentences. Match the tone of the description.`,
        });

        const data = await output;
        const text = data.generate;

        return res.status(200).send({ success: true, data: text });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/recap",
    authenticateToken,
    aiLimiter,
    async (req, res, next) => {
      try {
        const {
          moment_id,
          moments_name,
          description,
          location_name,
          vibes,
          principles,
        } = req.body;

        const [attendeeResult, photoResult, momentResult] = await Promise.all([
          pool.query(
            `SELECT COUNT(*) FROM moment_attendees WHERE moment_id = $1`,
            [moment_id],
          ),
          pool.query(`SELECT COUNT(*) FROM moment_photos WHERE moment_id = $1`, [
            moment_id,
          ]),
          pool.query(
            `SELECT moment_start, moment_end, recap FROM moments WHERE id = $1`,
            [moment_id],
          ),
        ]);

        const attendeeCount = parseInt(attendeeResult.rows[0].count);
        const photoCount = parseInt(photoResult.rows[0].count);
        const moment = momentResult.rows[0];

        if (moment?.recap) {
          return res
            .status(200)
            .json({ success: true, data: { recap: moment.recap } });
        }

        const endTime = moment?.moment_end;
        const durationHours =
          moment?.moment_start && endTime
            ? Math.round(
                ((new Date(endTime).getTime() -
                  new Date(moment.moment_start).getTime()) /
                  (1000 * 60 * 60)) *
                  10,
              ) / 10
            : null;

        const { text: recap } = await generateText({
          model: anthropic("claude-sonnet-4-6"),
          prompt: `Write a short, evocative 2-3 sentence recap of this event. Make it feel like a memory — cinematic, sensory, present tense. Do not use clichés.
              Event: ${moments_name}
              Location: ${location_name}
              Description: ${description}
              Vibes: ${vibes?.join(", ")}
              Principles: ${principles?.join(", ")}
              Attendees: ${attendeeCount} people
              ${durationHours ? `Duration: ${durationHours} hours` : ""}
              ${photoCount > 0 ? `Photos captured: ${photoCount}` : ""}

              Return ONLY the recap text, no preamble, no quotes.`,
        });

        await pool.query("UPDATE moments SET recap = $1 WHERE id = $2", [
          recap,
          moment_id,
        ]);

        const momentUrl = `https://br3w.app/moments/${moment_id}`;

        const getCreator = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [req.user?.id],
        );
        const creator = getCreator.rows[0];

        await sendEmail({
          email: creator.email,
          moment_recap: { moments_name, recap },
          action_url: momentUrl,
        });
        await sendSMS({
          phone_number: creator.phone_number,
          moment_recap: { moments_name },
          action_url: momentUrl,
        });

        const attendees = await pool.query(
          `SELECT u.email, u.phone_number
         FROM moment_attendees ma
         JOIN users u ON u.id = ma.attendee_id
         WHERE ma.moment_id = $1 AND ma.attendee_id != $2`,
          [moment_id, req.user?.id],
        );
        for (const attendee of attendees.rows) {
          await sendEmail({
            email: attendee.email,
            moment_recap: { moments_name, recap },
            action_url: momentUrl,
          });
          await sendSMS({
            phone_number: attendee.phone_number,
            moment_recap: { moments_name },
            action_url: momentUrl,
          });
        }

        io.to(`moment:${moment_id}`).emit("recap:ready", { recap });
        return res.status(200).send({ success: true, data: { recap } });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
