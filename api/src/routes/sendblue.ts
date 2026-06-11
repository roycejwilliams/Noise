import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { NextFunction, Request, Response, Router } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";

export function sendblueRouter(io: Server): Router {
  const router = Router();

  // POST /sendblue/webhook
  // Handles: inbound messages, outbound delivery status, typing indicators
  router.post(
    "/webhook",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          number,
          content,
          is_outbound,
          status,
          error_code,
          error_message,
          type,
        } = req.body;

        // Handle typing indicators
        if (type === "typing") {
          const userResult = await pool.query(
            `SELECT id FROM users WHERE phone_number = $1`,
            [number],
          );
          const user = userResult.rows[0];

          if (user) {
            io.to(`user:${user.id}`).emit("co:user_typing", { number });
          }

          return res.status(200).send({ received: true });
        }

        // Handle outbound delivery status
        if (is_outbound) {
          if (status === "ERROR") {
            console.error(
              `Message to ${number} failed: ${error_code} — ${error_message}`,
            );
            const userResult = await pool.query(
              `SELECT id FROM users WHERE phone_number = $1`,
              [number],
            );
            const user = userResult.rows[0];

            if (user) {
              await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content)
                 VALUES ($1, 'text_exchange', $2)`,
                [
                  user.id,
                  `Co message failed to deliver: ${error_code} — ${error_message}`,
                ],
              );
            }
          }

          return res.status(200).send({ received: true });
        }

        // Handle inbound messages — user replied to Co
        if (!number || !content) {
          return res.status(400).send("Missing required fields.");
        }

        // Step 1 — Find the user by phone number
        const userResult = await pool.query(
          `SELECT * FROM users WHERE phone_number = $1`,
          [number],
        );
        const user = userResult.rows[0];

        if (!user) {
          console.log(`Inbound message from unknown number: ${number}`);
          return res.status(200).send({ received: true });
        }

        // Step 2 — Store inbound message as co_memory
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2)`,
          [user.id, `User said: ${content}`],
        );

        // Step 2.5 — Check if this is a Moment response
        // User may be replying to a consensus poll or confirming a booking
        const pendingMoment = await pool.query(
          `SELECT mr.moment_id, m.moments_name, m.suggested_time
           FROM moment_responses mr
           JOIN moments m ON m.id = mr.moment_id
           WHERE mr.user_id = $1 AND mr.response IS NULL
           ORDER BY mr.created_at DESC
           LIMIT 1`,
          [user.id],
        );

        if (pendingMoment.rows[0]) {
          const { moment_id, moments_name, suggested_time } =
            pendingMoment.rows[0];

          // Use Anthropic to interpret natural language reply
          const { text: interpretation } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            prompt: `A user replied to a circle event invitation. Interpret their response.

              User's message: "${content}"
              Proposed time: ${suggested_time ?? "TBD"}

              Classify their response as ONE of:
              - "yes" — they confirmed the proposed time
              - "no" — they can't make it
              - "time: [their suggestion]" — they suggested a specific alternative time
              - "booked" — they confirmed they booked the venue
              - "unclear" — can't determine intent

              Return ONLY the classification, nothing else.`,
          });

          const parsedResponse = interpretation.trim().toLowerCase();

          // Handle booking confirmation from Circle Connector
          if (parsedResponse === "booked") {
            await pool.query(
              `UPDATE moments SET status = 'confirmed' WHERE id = $1`,
              [moment_id],
            );

            // Store in co_memories
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content)
               VALUES ($1, 'intent', $2)`,
              [
                user.id,
                `Connector confirmed booking for moment: ${moments_name}`,
              ],
            );

            // Emit socket event so app updates
            io.to(`moment:${moment_id}`).emit("moment:confirmed", {
              moment_id,
            });

            return res
              .status(200)
              .send({ received: true, action: "booking_confirmed" });
          }

          // Handle YES/NO/time suggestion
          await pool.query(
            `UPDATE moment_responses 
             SET response = $1, responded_at = NOW()
             WHERE user_id = $2 AND moment_id = $3`,
            [parsedResponse, user.id, moment_id],
          );

          // Emit so app can show updated response count
          io.to(`moment:${moment_id}`).emit("moment:response", {
            user_id: user.id,
            response: parsedResponse,
          });

          return res
            .status(200)
            .send({ received: true, action: "moment_response_captured" });
        }

        // Step 3 — No pending moment — fetch recent memories for Co's context
        const memoriesResult = await pool.query(
          `SELECT content FROM co_memories 
           WHERE user_id = $1 
           ORDER BY created_at DESC 
           LIMIT 5`,
          [user.id],
        );
        const recentMemories = memoriesResult.rows
          .map((m: any) => m.content)
          .join("\n");

        // Step 4 — Co generates a general response
        const { text: coReply } = await generateText({
          model: anthropic("claude-sonnet-4-6"),
          prompt: `You are Co, an exclusive life concierge.

          User: ${user.first_name}
          Recent context:
          ${recentMemories}

          They just said: "${content}"

          Respond as Co. Warm, specific, brief. Use their context to make it personal.
          2 sentences max. No em dashes. No exclamation points.`,
        });

        // Step 5 — Store Co's reply as co_memory
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2)`,
          [user.id, `Co replied: ${coReply}`],
        );

        // Step 6 — Emit to socket so app shows reply in real time
        io.to(`user:${user.id}`).emit("co:message", { message: coReply });

        return res.status(200).send({ received: true, reply: coReply });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
