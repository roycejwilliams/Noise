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
            // Flag failed delivery — store in co_memories for visibility
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

        // Step 3 — Fetch user's recent memories for context
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

        // Step 4 — Co generates a response
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
