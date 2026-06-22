import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { NextFunction, Request, Response, Router } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import elevenlabs from "../services/elevenlabs.js";
import { generateEmbedding } from "../services/embeddings.js";
import { findBestCircle } from "../services/matching.js";
import sendblue from "../services/sendblue.js";
import { generateVoiceNote } from "../services/voiceNote.js";

// Detect whether a media_url is a voice memo by checking its Content-Type
async function isAudioUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    const contentType = res.headers.get("content-type") ?? "";
    return contentType.startsWith("audio/");
  } catch {
    return false;
  }
}

// Transcribe a voice memo by downloading it first, then sending to ElevenLabs Scribe
// Download-first ensures ElevenLabs can access the audio regardless of Sendblue URL auth
async function transcribeVoiceMemo(audioUrl: string): Promise<string> {
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(10000) });
  if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
  const arrayBuffer = await audioRes.arrayBuffer();
  const file = new File([arrayBuffer], "voice_memo.m4a", { type: "audio/mp4" });

  const result = await elevenlabs.speechToText.convert({
    modelId: "scribe_v2",
    file,
  });
  return (result as { text: string }).text ?? "";
}

// Send Co's reply — voice note if user sent audio, text if they sent text
async function sendCoReply(params: {
  phone: string;
  message: string;
  asVoice: boolean;
}): Promise<void> {
  const { phone, message, asVoice } = params;

  let audioUrl: string | null = null;
  if (asVoice) {
    try {
      audioUrl = await generateVoiceNote(message);
    } catch (err: any) {
      console.error("Voice note generation failed, falling back to text:", err?.message ?? err);
    }
  }

  await sendblue.messages.send({
    number: phone,
    content: audioUrl ? "" : message,
    ...(audioUrl ? { media_url: audioUrl } : {}),
    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
  });
}

export function sendblueRouter(io: Server): Router {
  const router = Router();

  // POST /sendblue/webhook
  // Handles: inbound messages (text + voice memos), outbound delivery status, typing indicators
  router.post(
    "/webhook",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          number,
          content,
          media_url,
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
              const delivErrContent = `Co message failed to deliver: ${error_code} — ${error_message}`;
              const delivErrMemory = await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content)
                 VALUES ($1, 'text_exchange', $2) RETURNING id`,
                [user.id, delivErrContent],
              );
              generateEmbedding(delivErrContent)
                .then((emb) =>
                  pool.query(
                    `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                    [`[${emb.join(",")}]`, delivErrMemory.rows[0].id],
                  ),
                )
                .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
            }
          }
          return res.status(200).send({ received: true });
        }

        // Inbound — require phone number and at least one of: text content or media
        const hasText = typeof content === "string" && content.trim().length > 0;
        const hasMedia = typeof media_url === "string" && media_url.length > 0;

        if (!number || (!hasText && !hasMedia)) {
          return res.status(400).send("Missing required fields.");
        }

        // Keana approval intercept — must run before user lookup since Keana may not be in users table
        const keanaPhone = process.env.KEANA_PHONE_NUMBER;
        if (keanaPhone && number === keanaPhone && hasText) {
          const pendingResult = await pool.query(
            `SELECT c.id, c.circle_name, c.owner_id
             FROM circles c
             WHERE c.status = 'pending_approval'
             ORDER BY c.created_at ASC
             LIMIT 1`,
          );

          if (!pendingResult.rows[0]) {
            // No pending circles — nothing to approve
            return res.status(200).send({ received: true });
          }

          const pendingCircle = pendingResult.rows[0];

          const { text: classification } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
          });

          const action = classification.trim().toLowerCase();

          if (action === "approve") {
            await pool.query(
              `UPDATE circles SET status = 'active' WHERE id = $1`,
              [pendingCircle.id],
            );

            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)`,
              [pendingCircle.owner_id, `Keana manually approved circle ${pendingCircle.id}`],
            );

            const circleMembers = await pool.query(
              `SELECT u.id, u.phone_number, cp.city, cp.life_chapters
               FROM circle_members cm
               JOIN users u ON cm.member_id = u.id
               LEFT JOIN co_profiles cp ON cp.user_id = cm.member_id
               WHERE cm.circle_id = $1`,
              [pendingCircle.id],
            );
            const members = circleMembers.rows;
            const memberCount = members.length;
            const city = members.find((m: any) => m.city)?.city ?? "your city";
            const chapter = (members.find((m: any) => m.life_chapters?.length)?.life_chapters?.[0] ?? "").replace(/_/g, " ");

            // Check if a moment already exists for this circle (for the link)
            const momentResult = await pool.query(
              `SELECT id FROM moments WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [pendingCircle.id],
            );
            const momentId = momentResult.rows[0]?.id ?? null;

            for (const member of members) {
              // vCard — send on first contact if CO_VCARD_URL is set
              if (process.env.CO_VCARD_URL) {
                const vcardCheck = await pool.query(
                  `SELECT id FROM co_memories WHERE user_id = $1 AND content = 'Co vCard sent to user — contact saved' LIMIT 1`,
                  [member.id],
                );
                if (!vcardCheck.rows[0]) {
                  try {
                    await sendblue.messages.send({
                      number: member.phone_number,
                      content: "Co is your life concierge. Save this contact.",
                      media_url: process.env.CO_VCARD_URL,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                    await pool.query(
                      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', 'Co vCard sent to user — contact saved')`,
                      [member.id],
                    );
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                  } catch (vcardErr: any) {
                    console.error("vCard send failed (non-fatal):", vcardErr?.message ?? vcardErr);
                  }
                }
              }

              // Placement iMessage — individual, not group
              const placementMsg = momentId
                ? `I placed you in a circle. ${memberCount} people, same chapter, same city.\n\nhttps://copatible.app/moments/${momentId}`
                : `I placed you in a circle. ${memberCount} people, same chapter, same city.`;

              try {
                await sendblue.messages.send({
                  number: member.phone_number,
                  content: placementMsg,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (smsErr: any) {
                console.error(`Placement message failed for ${member.id}:`, smsErr?.message ?? smsErr);
              }

              const placementContent = `Co placed user in circle ${pendingCircle.id}`;
              const placementMem = await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'placement', $2) RETURNING id`,
                [member.id, placementContent],
              );
              generateEmbedding(placementContent)
                .then((emb) =>
                  pool.query(
                    `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                    [`[${emb.join(",")}]`, placementMem.rows[0].id],
                  ),
                )
                .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

              io.to(`user:${member.id}`).emit("circle:placed", {
                circle_id: pendingCircle.id,
                circle_name: pendingCircle.circle_name,
                member_count: memberCount,
                city,
                chapter,
              });
            }
          } else if (action === "reject") {
            await pool.query(
              `UPDATE circles SET status = 'rejected' WHERE id = $1`,
              [pendingCircle.id],
            );

            const rejectedMembersResult = await pool.query(
              `SELECT member_id FROM circle_members WHERE circle_id = $1`,
              [pendingCircle.id],
            );
            const rejectedMemberIds: string[] = rejectedMembersResult.rows.map((r: any) => r.member_id);
            const allRejectedIds = [pendingCircle.owner_id, ...rejectedMemberIds];

            for (const memberId of allRejectedIds) {
              const rejectContent = "Circle rejected — Co will attempt new matching";
              const rejectMem = await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'check_in', $2) RETURNING id`,
                [memberId, rejectContent],
              );
              generateEmbedding(rejectContent)
                .then((emb) =>
                  pool.query(
                    `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                    [`[${emb.join(",")}]`, rejectMem.rows[0].id],
                  ),
                )
                .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
            }

            const newGroupIds = await findBestCircle(pendingCircle.owner_id, rejectedMemberIds);

            if (!newGroupIds || newGroupIds.length < 4) {
              const ownerRes = await pool.query(
                `SELECT first_name FROM users WHERE id = $1`,
                [pendingCircle.owner_id],
              );
              const ownerName = ownerRes.rows[0]?.first_name ?? pendingCircle.owner_id;
              try {
                await sendblue.messages.send({
                  number: keanaPhone,
                  content: `No alternative match found for ${ownerName}. Manual review needed.`,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (err: any) {
                console.error("Failed to notify Keana of no-match:", err?.message ?? err);
              }
            } else {
              const ownerProfile = await pool.query(
                `SELECT life_chapters, city FROM co_profiles WHERE user_id = $1`,
                [pendingCircle.owner_id],
              );
              const ownerProf = ownerProfile.rows[0];
              const primaryChapter = ownerProf?.life_chapters?.[0] ?? "new_to_city";
              const city = ownerProf?.city ?? "";
              const circleName = `Co Circle — ${primaryChapter.replace(/_/g, " ")}`;

              const newCircleResult = await pool.query(
                `INSERT INTO circles (owner_id, circle_name, status) VALUES ($1, $2, 'pending_approval') RETURNING *`,
                [pendingCircle.owner_id, circleName],
              );
              const newCircle = newCircleResult.rows[0];

              for (const memberId of newGroupIds) {
                if (memberId === pendingCircle.owner_id) continue;
                await pool.query(
                  `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                  [newCircle.id, memberId],
                );
              }

              const existingConnector = await pool.query(
                `SELECT user_id FROM co_profiles
                 WHERE user_id = ANY($1::uuid[]) AND is_circle_connector = TRUE LIMIT 1`,
                [newGroupIds],
              );
              if (!existingConnector.rows[0]) {
                const topTrust = await pool.query(
                  `SELECT user_id FROM co_profiles
                   WHERE user_id = ANY($1::uuid[]) ORDER BY trust_score DESC LIMIT 1`,
                  [newGroupIds],
                );
                if (topTrust.rows[0]) {
                  const connectorId = topTrust.rows[0].user_id;
                  await pool.query(
                    `UPDATE co_profiles SET is_circle_connector = TRUE WHERE user_id = $1`,
                    [connectorId],
                  );
                  const connContent = `Co selected you as Circle Connector for circle ${newCircle.id}`;
                  const connMem = await pool.query(
                    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'check_in', $2) RETURNING id`,
                    [connectorId, connContent],
                  );
                  generateEmbedding(connContent)
                    .then((emb) =>
                      pool.query(
                        `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                        [`[${emb.join(",")}]`, connMem.rows[0].id],
                      ),
                    )
                    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
                }
              }

              for (const memberId of newGroupIds) {
                const pendingContent = "Circle placement pending Keana approval";
                const pendingMem = await pool.query(
                  `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'check_in', $2) RETURNING id`,
                  [memberId, pendingContent],
                );
                generateEmbedding(pendingContent)
                  .then((emb) =>
                    pool.query(
                      `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                      [`[${emb.join(",")}]`, pendingMem.rows[0].id],
                    ),
                  )
                  .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
              }

              const newMemberNamesResult = await pool.query(
                `SELECT first_name FROM users WHERE id = ANY($1::uuid[])`,
                [newGroupIds],
              );
              const newMemberNames = newMemberNamesResult.rows.map((r: any) => r.first_name).join(", ");

              try {
                await sendblue.messages.send({
                  number: keanaPhone,
                  content: `New circle ready for review. ${newGroupIds.length} people, ${city}, ${primaryChapter.replace(/_/g, " ")}. Members: ${newMemberNames}. Reply APPROVE or REJECT within 4 hours — Co will auto-approve if no response.`,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
                await pool.query(
                  `UPDATE circles SET keana_notified_at = NOW() WHERE id = $1`,
                  [newCircle.id],
                );
              } catch (err: any) {
                console.error("Failed to notify Keana of new proposal:", err?.message ?? err);
              }
            }
          }

          return res.status(200).send({ received: true });
        }

        // Step 1 — Find user by phone number
        const userResult = await pool.query(
          `SELECT * FROM users WHERE phone_number = $1`,
          [number],
        );
        const user = userResult.rows[0];
        if (!user) {
          console.log(`Inbound message from unknown number: ${number}`);
          return res.status(200).send({ received: true });
        }

        // Step 2 — Detect if inbound is a voice memo; if so, transcribe it
        // Co matches energy: voice in → voice out, text in → text out
        let resolvedContent = content ?? "";
        let isVoice = false;

        if (hasMedia) {
          isVoice = await isAudioUrl(media_url);
          if (isVoice) {
            try {
              resolvedContent = await transcribeVoiceMemo(media_url);
              console.log(`Transcribed voice memo from ${number}: "${resolvedContent}"`);
            } catch (transcribeErr: any) {
              console.error("Voice memo transcription failed:", transcribeErr?.message ?? transcribeErr);
              // Fall back to treating as a media message with no text content
              resolvedContent = "[voice memo]";
            }
          }
        }

        // Step 3 — Store inbound message, generate embedding, check for pending moment (in parallel)
        const inboundContent = isVoice
          ? `User sent a voice memo: ${resolvedContent}`
          : `User said: ${resolvedContent}`;

        const [inboundMemory, queryEmbedding, pendingMoment] = await Promise.all([
          pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'text_exchange', $2) RETURNING id`,
            [user.id, inboundContent],
          ),
          generateEmbedding(inboundContent).catch((err) => {
            console.error("Inbound embedding failed (non-fatal):", err);
            return null;
          }),
          pool.query(
            `SELECT mr.moment_id, m.moments_name, m.suggested_time
             FROM moment_responses mr
             JOIN moments m ON m.id = mr.moment_id
             WHERE mr.user_id = $1 AND mr.response IS NULL
             ORDER BY mr.created_at DESC
             LIMIT 1`,
            [user.id],
          ),
        ]);

        if (queryEmbedding) {
          pool
            .query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${queryEmbedding.join(",")}]`, inboundMemory.rows[0].id],
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
        }

        // Step 4 — Pending moment response handling (runs for both voice and text)
        if (pendingMoment.rows[0]) {
          const { moment_id, moments_name, suggested_time } = pendingMoment.rows[0];

          const { text: interpretation } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            prompt: `A user replied to a circle event invitation. Interpret their response.

              User's message: "${resolvedContent}"
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

          if (parsedResponse === "booked") {
            await pool.query(
              `UPDATE moments SET status = 'confirmed' WHERE id = $1`,
              [moment_id],
            );

            const bookingContent = `Connector confirmed booking for moment: ${moments_name}`;
            const bookingMemory = await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content)
               VALUES ($1, 'intent', $2) RETURNING id`,
              [user.id, bookingContent],
            );
            generateEmbedding(bookingContent)
              .then((emb) =>
                pool.query(
                  `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                  [`[${emb.join(",")}]`, bookingMemory.rows[0].id],
                ),
              )
              .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

            io.to(`moment:${moment_id}`).emit("moment:confirmed", { moment_id });
            return res.status(200).send({ received: true, action: "booking_confirmed" });
          }

          await pool.query(
            `UPDATE moment_responses
             SET response = $1, responded_at = NOW()
             WHERE user_id = $2 AND moment_id = $3`,
            [parsedResponse, user.id, moment_id],
          );
          io.to(`moment:${moment_id}`).emit("moment:response", {
            user_id: user.id,
            response: parsedResponse,
          });
          return res.status(200).send({ received: true, action: "moment_response_captured" });
        }

        // Step 5 — No pending moment — fetch semantically relevant memories
        let memoriesResult;
        if (queryEmbedding) {
          try {
            memoriesResult = await pool.query(
              `SELECT content FROM co_memories
               WHERE user_id = $1 AND content_embedding IS NOT NULL
               ORDER BY content_embedding <=> $2::vector
               LIMIT 5`,
              [user.id, `[${queryEmbedding.join(",")}]`],
            );
          } catch (vecErr) {
            console.error("Vector search failed, falling back to recency:", vecErr);
            memoriesResult = await pool.query(
              `SELECT content FROM co_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
              [user.id],
            );
          }
        } else {
          memoriesResult = await pool.query(
            `SELECT content FROM co_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [user.id],
          );
        }
        const recentMemories = memoriesResult.rows
          .map((m: any) => m.content)
          .join("\n");

        // Step 6 — Generate Co's reply — Haiku for speed
        const { text: coReply } = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          prompt: `You are Co, an exclusive life concierge.

          User: ${user.first_name}
          Recent context:
          ${recentMemories}

          They just said: "${resolvedContent}"

          Respond as Co. Warm, specific, brief. Use their context to make it personal.
          2 sentences max. No em dashes. No exclamation points.`,
        });

        // Step 7 — Store Co's reply in co_memories
        const replyContent = `Co replied: ${coReply}`;
        const replyMemory = await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2) RETURNING id`,
          [user.id, replyContent],
        );
        generateEmbedding(replyContent)
          .then((emb) =>
            pool.query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${emb.join(",")}]`, replyMemory.rows[0].id],
            ),
          )
          .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

        // Step 8 — Send reply matching the user's medium, emit to socket
        await sendCoReply({ phone: user.phone_number, message: coReply, asVoice: isVoice });
        io.to(`user:${user.id}`).emit("co:message", { message: coReply });

        return res.status(200).send({ received: true, reply: coReply });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
