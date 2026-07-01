import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import type { RequestHandler } from "express";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { Server } from "socket.io";
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

        //promise.all runs everything in parallel
        const [attendeeResult, photoResult, momentResult] = await Promise.all([
          pool.query(
            `SELECT COUNT(*) FROM moment_attendees WHERE moment_id = $1`,
            [moment_id],
          ),
          pool.query(
            `SELECT COUNT(*) FROM moment_photos WHERE moment_id = $1`,
            [moment_id],
          ),
          pool.query(
            `SELECT moment_start, moment_end, recap FROM moments WHERE id = $1`,
            [moment_id],
          ),
        ]);

        //How many checked into this moment
        const attendeeCount = parseInt(attendeeResult.rows[0].count);
        //how many photos were uploaded
        const photoCount = parseInt(photoResult.rows[0].count);
        //whats the moment's start/end time and exisitng recap
        const moment = momentResult.rows[0];

        //iIf a recap already exists for this moment return it immediately.
        if (moment?.recap) {
          return res
            .status(200)
            .json({ success: true, data: { recap: moment.recap } });
        }

        //how long the experience lasted in hours
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

        //Co writes the memory
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

        //Co saves it
        await pool.query("UPDATE moments SET recap = $1 WHERE id = $2", [
          recap,
          moment_id,
        ]);

        // Update co_profiles for each attendee based on the experience
        const attendeeProfiles = await pool.query(
          `SELECT ma.attendee_id, cp.goals, cp.blockers, cp.activity_preferences, cp.emotional_state
   FROM moment_attendees ma
   JOIN co_profiles cp ON cp.user_id = ma.attendee_id
   WHERE ma.moment_id = $1`,
          [moment_id],
        );

        for (const profile of attendeeProfiles.rows) {
          // Extract psychographic updates from the recap
          const { text: rawUpdates } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            prompt: `You are Co analyzing what was learned about a user from their recent circle experience.

          Experience recap: "${recap}"
          Experience vibes: ${vibes?.join(", ")}
          User's current goals: ${profile.goals?.join(", ")}
          User's current blockers: ${profile.blockers?.join(", ")}
          User's current emotional state: ${profile.emotional_state}

          Based on this experience, suggest subtle updates to this user's psychographic profile.
          Return ONLY valid JSON:
          {
            "emotional_state": "one word describing likely emotional state after this experience",
            "activity_preferences_to_add": ["any new activities confirmed by this experience"],
            "goals_reinforced": ["any goals this experience helped with"],
            "blockers_reduced": ["any blockers this experience addressed"]
          }`,
          });

          try {
            const clean = rawUpdates.replace(/```json|```/g, "").trim();
            const updates = JSON.parse(clean);

            // Co updates what it knows about you
            if (updates.emotional_state) {
              await pool.query(
                `UPDATE co_profiles SET emotional_state = $1, updated_at = NOW() WHERE user_id = $2`,
                [updates.emotional_state, profile.attendee_id],
              );
            }

            // Add new activity preferences
            //if the array has at least one item in it
            //it would be added to the activity preferences for the attendees
            if (updates.activity_preferences_to_add?.length) {
              await pool.query(
                `UPDATE co_profiles 
         SET activity_preferences = array_cat(activity_preferences, $1::text[]),
             updated_at = NOW()
         WHERE user_id = $2`,
                [updates.activity_preferences_to_add, profile.attendee_id],
              );
            }

            // Store recap as co_memory
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content)
       VALUES ($1, 'recap', $2)`,
              [
                profile.attendee_id,
                `Experience recap: ${recap}. Emotional state after: ${updates.emotional_state}`,
              ],
            );
          } catch {
            console.error(
              `Failed to update co_profile for ${profile.attendee_id}`,
            );
          }
        }

        //url to be sent
        const momentUrl = `https://app.copatible.com/moments/${moment_id}`;

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
