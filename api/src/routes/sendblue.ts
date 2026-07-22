import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { randomInt } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { sendSMS } from "../otpActions.js";
import elevenlabs from "../services/elevenlabs.js";
import { generateEmbedding } from "../services/embeddings.js";
import {
  createMomentForCircle,
  getCircleBookingContext,
  notifyMemberOfMoment,
  proposeNewTimeForMoment,
  isCircleConnector,
  selectVenueForCircle,
} from "./co.js";
import { findBestCircle } from "../services/matching.js";
import { getVenueContactInfo } from "../services/places.js";
import { proceedToConnectorBooking, requestVenueApprovalFromKeana } from "../services/booking.js";
import sendblue from "../services/sendblue.js";
import { generateVoiceNote } from "../services/voiceNote.js";

// Serializes webhook processing per phone number. Without this, two
// messages sent seconds apart from the same person can be handled
// concurrently — the second one's queries can run before the first one's
// writes (e.g. a moment being created) have committed, so it falls through
// to the wrong branch entirely (confirmed: a rapid double "Yes" caused the
// second reply to skip the actionable-response handler and hit the general
// fallback instead, producing a hallucinated, unrelated reply).
const phoneLocks = new Map<string, Promise<unknown>>();

function withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const prior = phoneLocks.get(phone) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  phoneLocks.set(
    phone,
    result.catch(() => {}),
  );
  return result;
}

const ALLOWED_LIFE_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];

// Unlike typed-intake/chat_ended (which extract a full profile from a
// complete transcript and overwrite every field), this only changes fields
// the model finds explicitly communicated in this one message — everything
// else in co_profiles is left untouched, so a casual reply can't wipe out
// previously-known life_chapters/goals with empty arrays. Only runs if a
// profile already exists; the conversational path still doesn't create one
// from nothing (that stays a call/typed-intake job).
async function updateProfileFromMessage(user_id: string, message: string): Promise<void> {
  try {
    const existing = await pool.query(
      `SELECT life_chapters, emotional_state, goals, blockers FROM co_profiles WHERE user_id = $1`,
      [user_id],
    );
    const current = existing.rows[0];
    if (!current) return;

    const { text: rawUpdate } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `You are Co, tracking what you know about a user across conversations.

Current known profile:
- life_chapters: ${current.life_chapters?.join(", ") || "none"} (allowed values: new_to_city, building_solo, career_pivot, starting_over)
- emotional_state: ${current.emotional_state ?? "unknown"}
- goals: ${current.goals?.join(", ") || "none"}
- blockers: ${current.blockers?.join(", ") || "none"}

The user just said: "${message}"

Does this message indicate a REAL, EXPLICIT change to any of the above? Only include a field if the message clearly communicates a change to it — do not guess or infer beyond what's stated.

Return ONLY valid JSON. Omit any field that hasn't changed:
{
  "life_chapters": ["..."],
  "emotional_state": "...",
  "goals": ["..."],
  "blockers": ["..."]
}

If nothing has changed, return {}.`,
    });

    // Haiku occasionally adds a trailing sentence after the JSON object —
    // extract just the {...} block instead of assuming the whole response
    // is strictly valid JSON.
    const jsonMatch = rawUpdate.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const updates = JSON.parse(jsonMatch[0]);
    if (!updates || typeof updates !== "object" || Object.keys(updates).length === 0) return;

    const values: any[] = [user_id];
    const sets: string[] = [];

    if (Array.isArray(updates.life_chapters)) {
      const safe = updates.life_chapters.filter((c: string) => ALLOWED_LIFE_CHAPTERS.includes(c));
      if (safe.length) {
        values.push(safe);
        sets.push(`life_chapters = $${values.length}`);
      }
    }
    if (typeof updates.emotional_state === "string" && updates.emotional_state) {
      values.push(updates.emotional_state);
      sets.push(`emotional_state = $${values.length}`);
    }
    if (Array.isArray(updates.goals) && updates.goals.length) {
      values.push(updates.goals);
      sets.push(`goals = $${values.length}`);
    }
    if (Array.isArray(updates.blockers) && updates.blockers.length) {
      values.push(updates.blockers);
      sets.push(`blockers = $${values.length}`);
    }

    if (!sets.length) return;

    await pool.query(
      `UPDATE co_profiles SET ${sets.join(", ")}, updated_at = NOW() WHERE user_id = $1`,
      values,
    );
  } catch (err: any) {
    console.error("updateProfileFromMessage failed (non-fatal):", err?.message ?? err);
  }
}

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

// iMessage voice memos are real-world always audio/x-caf (Apple's Core
// Audio Format) — this previously hardcoded audio/mp4 + a .m4a filename
// regardless of the actual format, so ElevenLabs tried to decode CAF bytes
// as MP4 and every real iMessage voice memo failed transcription (confirmed
// with a real voice memo: content-type was genuinely audio/x-caf).
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/x-caf": "caf",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

// Transcribe a voice memo by downloading it first, then sending to ElevenLabs Scribe
// Download-first ensures ElevenLabs can access the audio regardless of Sendblue URL auth
async function transcribeVoiceMemo(audioUrl: string): Promise<string> {
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(10000) });
  if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
  const contentType = audioRes.headers.get("content-type")?.split(";")[0].trim() ?? "audio/mp4";
  const extension = AUDIO_EXTENSIONS[contentType] ?? "m4a";
  const arrayBuffer = await audioRes.arrayBuffer();
  const file = new File([arrayBuffer], `voice_memo.${extension}`, { type: contentType });

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

  try {
    await sendblue.messages.send({
      number: phone,
      content: audioUrl ? "" : message,
      ...(audioUrl ? { media_url: audioUrl } : {}),
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    // A real delivery failure (e.g. recipient hasn't texted in first) must
    // never crash the whole request — the reply was already generated and
    // stored; this only means Sendblue couldn't deliver it. Confirmed: this
    // was previously an uncaught 500, unlike every other send in this file.
    console.error(`sendCoReply failed for ${phone}:`, err?.message ?? err);
  }
}

export function sendblueRouter(io: Server): Router {
  const router = Router();

  // POST /sendblue/webhook
  // Handles: inbound messages (text + voice memos), outbound delivery status, typing indicators
  router.post(
    "/webhook",
    async (req: Request, res: Response, next: NextFunction) => {
      const lockKey: string | undefined = req.body?.number;
      const run = async () => {
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

        // Keana approval intercept — must run before user lookup since Keana may not be in users table.
        // Only intercepts when there's an actual circle to approve/reject — Keana is
        // also a normal registered user/contact (e.g. completing her own text-in-first
        // verification, or chatting with Co), and those texts must fall through to the
        // standard user flow below instead of being silently swallowed here.
        const keanaPhone = process.env.KEANA_PHONE_NUMBER;
        if (keanaPhone && number === keanaPhone && hasText) {
          const pendingResult = await pool.query(
            `SELECT c.id, c.circle_name, c.owner_id
             FROM circles c
             WHERE c.status = 'pending_approval'
             ORDER BY c.created_at ASC
             LIMIT 1`,
          );

          const pendingCircle = pendingResult.rows[0];
          if (pendingCircle) {

          const { text: classification } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
          });

          // Same backtick/quote-stripping as the other classification
          // parses in this file — the model doesn't always return bare text.
          const action = classification.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

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
              `SELECT u.id, u.first_name, u.phone_number, cp.city, cp.life_chapters
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

            for (const member of members) {
              // vCard — send on first contact if CO_VCARD_URL is set
              if (process.env.CO_VCARD_URL) {
                const vcardCheck = await pool.query(
                  `SELECT id FROM co_memories WHERE user_id = $1 AND content = 'Co vCard sent to user — contact saved' LIMIT 1`,
                  [member.id],
                );
                if (!vcardCheck.rows[0]) {
                  try {
                    const { text: vcardMsg } = await generateText({
                      model: anthropic("claude-haiku-4-5-20251001"),
                      prompt: `You are Co, texting ${member.first_name} for the first time. Ask them to save your contact, briefly, in your own words. No exclamation points, no em dashes. 1 sentence.`,
                    });
                    await sendblue.messages.send({
                      number: member.phone_number,
                      content: vcardMsg,
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

              // Circle-invite iMessage — always individual, one thread per
              // person. Placement is no longer announced as a fait accompli:
              // the member has to accept before their moment is revealed
              // (see the pending-circle-invite handling below). Never
              // mentions headcount — this is their own thread, not a group
              // announcement.
              let circleTitle = chapter ? `Your ${chapter} circle` : "Your circle";
              try {
                const { text: titleText } = await generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  prompt: `Give a short, warm, specific name (3-5 words, no quotes) for a small circle of people in ${city} all navigating "${chapter || "a new chapter"}". Not generic. Return only the name.`,
                });
                circleTitle = titleText.trim();
              } catch (genErr: any) {
                console.error("Circle title generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
              }

              let inviteMsg = `Co found your circle: ${circleTitle}. There's already a moment curated and waiting if you're in. Reply YES to join or NO to pass.`;
              try {
                const { text } = await generateText({
                  model: anthropic("claude-sonnet-4-6"),
                  prompt: `You are Co. You just found ${member.first_name} a circle called "${circleTitle}" — people in the same ${chapter || "chapter of life"}, based in ${city}. Tell them, and mention there's already a moment curated and waiting for them if they're in. Ask them to reply YES to join or NO to pass. Never mention how many people are in it — this is their own thread, not a group announcement. No exclamation points, no em dashes. 2-3 sentences.`,
                });
                inviteMsg = text;
              } catch (genErr: any) {
                console.error("Circle invite message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
              }

              try {
                await sendblue.messages.send({
                  number: member.phone_number,
                  content: inviteMsg,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (smsErr: any) {
                console.error(`Circle invite message failed for ${member.id}:`, smsErr?.message ?? smsErr);
              }

              const placementContent = `Co invited user to circle ${pendingCircle.id} ("${circleTitle}") — awaiting accept/decline`;
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
          } else {
            // No pending circle to approve — check for a moment awaiting
            // Keana's venue approval instead. Same approve/reject-by-text
            // pattern as the circle-placement approval above, just gating
            // venue choice rather than circle membership.
            const pendingMomentResult = await pool.query(
              `SELECT id, circle_id, moments_name, venue, venue_booking_url, venue_place_id,
                      venue_type, neighborhood, vibe, suggested_time, rejected_venues, tried_connector_ids
               FROM moments
               WHERE status = 'pending_venue_approval'
               ORDER BY created_at ASC
               LIMIT 1`,
            );
            const pendingMomentApproval = pendingMomentResult.rows[0];

            if (pendingMomentApproval) {
              const { text: venueClassification } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
              });
              const venueAction = venueClassification
                .trim()
                .toLowerCase()
                .replace(/^[`"']+|[`"']+$/g, "");

              if (venueAction === "approve") {
                await proceedToConnectorBooking(pendingMomentApproval);
              } else if (venueAction === "reject") {
                const rejectedVenues: string[] = [
                  ...(pendingMomentApproval.rejected_venues ?? []),
                  ...(pendingMomentApproval.venue ? [pendingMomentApproval.venue] : []),
                ];

                const context = await getCircleBookingContext(pendingMomentApproval.circle_id);
                const nextVenue = context
                  ? await selectVenueForCircle(
                      context.city,
                      pendingMomentApproval.venue_type,
                      pendingMomentApproval.neighborhood,
                      context.groupSize,
                      {
                        vibe: pendingMomentApproval.vibe ?? "",
                        life_chapters: context.uniqueChapters,
                        connection_style: context.dominantStyle,
                        group_size: context.groupSize,
                      },
                      rejectedVenues,
                    )
                  : null;

                if (!nextVenue) {
                  try {
                    await sendblue.messages.send({
                      number: keanaPhone,
                      content: `No alternative venue found for moment ${pendingMomentApproval.id}. Needs manual venue selection.`,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (err: any) {
                    console.error("Failed to notify Keana of no-alternative-venue:", err?.message ?? err);
                  }
                  await pool.query(
                    `UPDATE moments SET status = 'manual_booking_required', rejected_venues = $1 WHERE id = $2`,
                    [rejectedVenues, pendingMomentApproval.id],
                  );
                } else {
                  await pool.query(
                    `UPDATE moments
                     SET venue = $1, venue_booking_url = $2, venue_place_id = $3,
                         location_name = $4, rejected_venues = $5
                     WHERE id = $6`,
                    [
                      nextVenue.name ?? null,
                      nextVenue.venue_booking_url ?? null,
                      nextVenue.place_id ?? null,
                      nextVenue.formatted_address ?? pendingMomentApproval.neighborhood ?? null,
                      rejectedVenues,
                      pendingMomentApproval.id,
                    ],
                  );
                  await requestVenueApprovalFromKeana({
                    ...pendingMomentApproval,
                    venue: nextVenue.name ?? null,
                  });
                }
              }

              return res.status(200).send({ received: true });
            }
          }
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

        // Step 1.5 — First contact from an unverified self-serve registration.
        // Our Sendblue plan only allows replying to contacts who've texted in
        // first, so the OTP couldn't be sent at registration time. This is
        // that first inbound text — mark verified and send the OTP now as a
        // reply, which the plan permits. Nothing else in this handler applies
        // to a user who hasn't completed signup yet, so return early.
        if (!user.contact_verified) {
          const otp = randomInt(100000, 1000000);
          const expiryTimeStamp = new Date(Date.now() + 300000).toISOString();

          await pool.query(
            `UPDATE users SET contact_verified = true, otp_code = $2, otp_expiry = $3 WHERE id = $1`,
            [user.id, otp, expiryTimeStamp],
          );

          // Three-message introduction: welcome, then what CoPatible is (with
          // the contact card attached), then the verification code — so the
          // code doesn't land as a bare 6-digit text from an unknown number.
          await sendSMS({ phone_number: user.phone_number, welcome: true });
          await sendSMS({ phone_number: user.phone_number, intro: true });
          await sendSMS({
            phone_number: user.phone_number,
            otp_code: otp.toString(),
            register: true,
          });

          return res.status(200).send({ received: true, action: "contact_verified" });
        }

        // Step 2 — Detect if inbound is a voice memo; if so, transcribe it.
        // If it's an image, download it for the vision-enabled reply below.
        // Co matches energy: voice in → voice out, text in → text out
        let resolvedContent = content ?? "";
        let isVoice = false;
        let imageForVision: { data: Buffer; mediaType: string } | null = null;

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
          } else {
            try {
              const imageRes = await fetch(media_url, { signal: AbortSignal.timeout(10000) });
              if (!imageRes.ok) throw new Error(`Image fetch failed: ${imageRes.status}`);
              const mediaType = imageRes.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
              const buffer = Buffer.from(await imageRes.arrayBuffer());
              imageForVision = { data: buffer, mediaType };
              if (!resolvedContent) resolvedContent = "[sent a photo]";
            } catch (imgErr: any) {
              console.error("Image fetch for vision failed (non-fatal):", imgErr?.message ?? imgErr);
              if (!resolvedContent) resolvedContent = "[sent a photo — couldn't load it]";
            }
          }
        }

        // Step 3 — Store inbound message, generate embedding, check for pending moment (in parallel)
        const inboundContent = isVoice
          ? `User sent a voice memo: ${resolvedContent}`
          : `User said: ${resolvedContent}`;

        const [inboundMemory, queryEmbedding, pendingMoment, pendingCircleInvite] = await Promise.all([
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
            // Two situations land here: a genuinely unanswered yes/no/time
            // poll (response IS NULL), OR the Circle Connector following up
            // with "Booked!" after consensus already locked in their 'yes' —
            // by then their response is no longer NULL, so without this
            // second clause a "Booked!" text could never match anything and
            // would silently fall through to the generic reply instead of
            // ever confirming the booking (confirmed: this was happening).
            `SELECT mr.moment_id, m.moments_name, m.suggested_time, m.venue, m.moment_start, m.circle_id, m.venue_place_id
             FROM moment_responses mr
             JOIN moments m ON m.id = mr.moment_id
             LEFT JOIN co_profiles cp ON cp.user_id = mr.user_id
             WHERE mr.user_id = $1
             AND (
               mr.response IS NULL
               OR (m.status = 'consensus_locked' AND cp.is_circle_connector = TRUE)
             )
             ORDER BY mr.created_at DESC
             LIMIT 1`,
            [user.id],
          ),
          pool.query(
            `SELECT cm.circle_id, c.circle_name, c.owner_id
             FROM circle_members cm
             JOIN circles c ON c.id = cm.circle_id
             WHERE cm.member_id = $1 AND cm.status = 'pending'
             ORDER BY cm.joined_at DESC
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

        // Step 3.5 — Pending circle invite response handling. Runs before
        // moment handling since a member has to accept their circle before
        // any moment for it exists to respond to.
        if (pendingCircleInvite.rows[0]) {
          const { circle_id, circle_name, owner_id } = pendingCircleInvite.rows[0];

          const { text: circleInterpretation } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `A user replied to a circle invite. Classify their response as ONE of: "yes" — they want to join, "no" — they want to pass, "unclear" — can't tell.

Message: "${resolvedContent}"

Return ONLY the classification, nothing else.`,
          });
          const circleAction = circleInterpretation.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

          if (circleAction === "yes") {
            await pool.query(
              `UPDATE circle_members SET status = 'accepted' WHERE circle_id = $1 AND member_id = $2`,
              [circle_id, user.id],
            );

            const existingMoment = await pool.query(
              `SELECT * FROM moments WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [circle_id],
            );
            let moment = existingMoment.rows[0];
            let selectedVenue: any = null;
            let momentData: any = null;

            if (!moment) {
              const created = await createMomentForCircle(circle_id);
              if (created) {
                ({ moment, selectedVenue, momentData } = created);
              }
            } else {
              // Moment already exists (an earlier accepter triggered it) —
              // reconstruct the minimal fields notifyMemberOfMoment needs.
              momentData = { neighborhood: moment.location_name, suggested_time: moment.suggested_time };
              selectedVenue = moment.venue ? { name: moment.venue } : null;
            }

            if (moment) {
              const memberCountResult = await pool.query(
                `SELECT COUNT(*) FROM circle_members WHERE circle_id = $1 AND status = 'accepted'`,
                [circle_id],
              );
              const groupSize = parseInt(memberCountResult.rows[0].count, 10);

              await pool.query(
                `INSERT INTO moment_responses (moment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [moment.id, user.id],
              );

              await notifyMemberOfMoment(moment, selectedVenue, momentData, { member_id: user.id }, groupSize);
            }

            return res.status(200).send({ received: true, action: "circle_accepted" });
          } else if (circleAction === "no") {
            const MAX_REPLACEMENT_ATTEMPTS = 2;

            // Kept as a 'declined' row (not deleted) so it doubles as the
            // attempt counter below, and so findBestCircle never re-suggests
            // someone who already passed on this circle.
            await pool.query(
              `UPDATE circle_members SET status = 'declined' WHERE circle_id = $1 AND member_id = $2`,
              [circle_id, user.id],
            );

            try {
              await sendblue.messages.send({
                number: user.phone_number,
                content: `No worries. Co will keep looking for a better fit.`,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Circle decline ack failed for ${user.id}:`, smsErr?.message ?? smsErr);
            }

            const allRows = await pool.query(
              `SELECT member_id, status FROM circle_members WHERE circle_id = $1`,
              [circle_id],
            );
            const activeIds: string[] = allRows.rows
              .filter((r: any) => r.status !== "declined")
              .map((r: any) => r.member_id);
            const everyKnownId: string[] = allRows.rows.map((r: any) => r.member_id);
            const declinedCount = allRows.rows.filter((r: any) => r.status === "declined").length;

            if (activeIds.length < 4) {
              if (declinedCount > MAX_REPLACEMENT_ATTEMPTS) {
                try {
                  await sendblue.messages.send({
                    number: keanaPhone!,
                    content: `Circle ${circle_id} dropped below minimum size after ${declinedCount} declines — hit the replacement attempt limit. Manual review needed.`,
                    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                  });
                } catch (err: any) {
                  console.error("Failed to notify Keana of exhausted attempts:", err?.message ?? err);
                }
              } else {
                const replacementIds = await findBestCircle(owner_id, everyKnownId);
                const newCandidates = (replacementIds ?? []).filter(
                  (id: string) => !everyKnownId.includes(id),
                );

                for (const candidateId of newCandidates) {
                  await pool.query(
                    `INSERT INTO circle_members (circle_id, member_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
                    [circle_id, candidateId],
                  );

                  const candidateResult = await pool.query(
                    `SELECT first_name, phone_number FROM users WHERE id = $1`,
                    [candidateId],
                  );
                  const candidate = candidateResult.rows[0];
                  if (!candidate) continue;

                  try {
                    await sendblue.messages.send({
                      number: candidate.phone_number,
                      content: `Co found your circle: ${circle_name}. There's already a moment curated and waiting if you're in. Reply YES to join or NO to pass.`,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (smsErr: any) {
                    console.error(`Replacement circle invite failed for ${candidateId}:`, smsErr?.message ?? smsErr);
                  }
                }

                if (!newCandidates.length) {
                  try {
                    await sendblue.messages.send({
                      number: keanaPhone!,
                      content: `Circle ${circle_id} dropped below minimum size after a decline and no replacement was found. Manual review needed.`,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (err: any) {
                    console.error("Failed to notify Keana of no-replacement:", err?.message ?? err);
                  }
                }
              }
            }

            return res.status(200).send({ received: true, action: "circle_declined" });
          }
          // "unclear" — fall through to the general conversational reply below
        }

        // Step 4 — Pending moment response handling (runs for both voice and text)
        if (pendingMoment.rows[0]) {
          const { moment_id, moments_name, suggested_time, venue, moment_start, circle_id, venue_place_id } = pendingMoment.rows[0];

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

          // Strip wrapping backticks/quotes — the model sometimes formats
          // its one-word answer as `booked` or "booked" instead of plain
          // text, which fails a strict equality check (confirmed: this
          // silently dropped a real "Booked!" confirmation into the
          // generic reply path instead of ever confirming the booking).
          const parsedResponse = interpretation
            .trim()
            .toLowerCase()
            .replace(/^[`"']+|[`"']+$/g, "");

          if (parsedResponse === "booked") {
            await pool.query(
              `UPDATE moments SET status = 'confirmed' WHERE id = $1`,
              [moment_id],
            );

            // Populate moment_attendees from moment_responses so check-in works.
            // Anyone who replied 'yes' (or has any response) gets an attendee row.
            await pool.query(
              `INSERT INTO moment_attendees (moment_id, attendee_id)
               SELECT moment_id, user_id FROM moment_responses
               WHERE moment_id = $1
               ON CONFLICT DO NOTHING`,
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

            // Tell every member individually — CoPatible has no group chat, so
            // each person gets their own confirmation text, not a shared thread.
            const dateStr = new Date(moment_start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
            const timeStr = new Date(moment_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
            let confirmedMsg = `You're confirmed. ${venue ?? moments_name} on ${dateStr} at ${timeStr}. Co will send details closer to the day.`;
            try {
              const { text } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                prompt: `You are Co. A moment just got booked: ${venue ?? moments_name} on ${dateStr} at ${timeStr}. Text confirming it's locked in, in your own words — not a template. Mention you'll follow up with details closer to the day. No exclamation points, no em dashes. 1-2 sentences.`,
              });
              confirmedMsg = text;
            } catch (genErr: any) {
              console.error("Booking-confirmed message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
            }

            // Real Maps link/phone for attendees heading there — appended as
            // a plain line rather than left to the generated text, so it's
            // never invented or dropped.
            if (venue_place_id) {
              const { phone, mapsUrl } = await getVenueContactInfo(venue_place_id);
              const extra = [mapsUrl ? `Directions: ${mapsUrl}` : "", phone ? `Venue: ${phone}` : ""]
                .filter(Boolean)
                .join(" · ");
              if (extra) confirmedMsg = `${confirmedMsg}\n${extra}`;
            }

            const confirmedMembers = await pool.query(
              `SELECT u.id, u.phone_number FROM moment_responses mr
               JOIN users u ON u.id = mr.user_id
               WHERE mr.moment_id = $1`,
              [moment_id],
            );
            for (const member of confirmedMembers.rows) {
              try {
                await sendblue.messages.send({
                  number: member.phone_number,
                  content: confirmedMsg,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (confirmErr: any) {
                console.error(`Booking-confirmed message failed for ${member.id}:`, confirmErr?.message ?? confirmErr);
              }
            }

            io.to(`moment:${moment_id}`).emit("moment:confirmed", { moment_id });
            return res.status(200).send({ received: true, action: "booking_confirmed" });
          }

          // Only intercept for classifications that are actually actionable —
          // "unclear" means this wasn't really a moment response at all (e.g.
          // small talk like "hey, how are you?"), and previously got silently
          // recorded with no reply ever sent. Falling through lets Co have a
          // normal conversation instead of going silent on anything ambiguous.
          const isActionableResponse =
            parsedResponse === "yes" ||
            parsedResponse === "no" ||
            parsedResponse.startsWith("time:");

          if (isActionableResponse) {
            // A time proposal only actually reschedules the moment (and
            // re-polls everyone) if it comes from the Circle Connector —
            // matches the same rule as the app's propose-time endpoint.
            // Anyone else's time proposal is just noted, not acted on.
            let rescheduled = false;
            if (parsedResponse.startsWith("time:") && circle_id && (await isCircleConnector(user.id, circle_id))) {
              const rawSuggestion = parsedResponse.replace(/^time:\s*/i, "");
              try {
                const { text: isoGuess } = await generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  prompt: `The moment is currently scheduled for ${moment_start} (ISO 8601). The Circle Connector just proposed a new time: "${rawSuggestion}". Return ONLY the new date/time as a single ISO 8601 datetime string, keeping the same timezone offset as the current schedule. No explanation.`,
                });
                const newDate = new Date(isoGuess.trim());
                if (!Number.isNaN(newDate.getTime())) {
                  await proposeNewTimeForMoment(moment_id, newDate);
                  rescheduled = true;
                }
              } catch (genErr: any) {
                console.error("Connector time-reschedule failed (non-fatal):", genErr?.message ?? genErr);
              }
            }

            if (!rescheduled) {
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
            }

            // Acknowledge — recording the response silently reads as Co
            // ignoring the message entirely.
            let ackMsg = "Got it.";
            try {
              const ackContext = rescheduled
                ? `You just rescheduled ${moments_name} to "${parsedResponse.replace(/^time:\s*/i, "")}" and re-asked the rest of the circle to confirm.`
                : parsedResponse === "yes"
                  ? `They confirmed they can make it to ${moments_name} at ${suggested_time ?? "the proposed time"}.`
                  : parsedResponse === "no"
                    ? `They said they can't make it to ${moments_name}.`
                    : `They proposed a different time for ${moments_name}: "${parsedResponse.replace(/^time:\s*/i, "")}", but they're not the Circle Connector so it doesn't change the schedule. Let them know you've noted their preference and the Connector has the final say on timing.`;
              const { text } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                prompt: `You are Co, an exclusive life concierge. ${ackContext} Reply to them briefly, warm and specific. 1 sentence. No exclamation points, no em dashes.`,
              });
              ackMsg = text;
            } catch (genErr: any) {
              console.error("Moment response ack generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
            }

            try {
              await sendblue.messages.send({
                number: user.phone_number,
                content: ackMsg,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Moment response ack failed for ${user.id}:`, smsErr?.message ?? smsErr);
            }

            return res.status(200).send({ received: true, action: rescheduled ? "moment_rescheduled" : "moment_response_captured" });
          }
        }

        // Step 4.5 — Show the animated "..." on the user's device while Co
        // "thinks" — the Claude call below can take a few seconds, and a bare
        // gap before the reply lands reads as broken rather than considered.
        // Non-fatal: a failed typing indicator should never block the reply.
        try {
          await sendblue.typingIndicators.send({
            number: user.phone_number,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (typingErr: any) {
          console.error("Typing indicator failed (non-fatal):", typingErr?.message ?? typingErr);
        }

        // Step 5 — Two separate context sources, since they answer different
        // questions. Topical similarity search answers "what's relevant to
        // what they just said" but has no sense of recency or conversation
        // flow — on its own it can just as easily surface something said
        // weeks ago in an unrelated exchange as it can the actual last thing
        // discussed (confirmed: this produced a reply referencing an
        // unrelated "3pm" proposal from a different circle entirely). The
        // chronological block below answers "what did we just say," in
        // order, so the model can actually follow the thread.
        let memoriesResult;
        if (queryEmbedding) {
          try {
            memoriesResult = await pool.query(
              `SELECT content FROM co_memories
               WHERE user_id = $1 AND content_embedding IS NOT NULL AND memory_type != 'intent'
               ORDER BY content_embedding <=> $2::vector
               LIMIT 5`,
              [user.id, `[${queryEmbedding.join(",")}]`],
            );
          } catch (vecErr) {
            console.error("Vector search failed, falling back to recency:", vecErr);
            memoriesResult = await pool.query(
              `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type != 'intent' ORDER BY created_at DESC LIMIT 5`,
              [user.id],
            );
          }
        } else {
          memoriesResult = await pool.query(
            `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type != 'intent' ORDER BY created_at DESC LIMIT 5`,
            [user.id],
          );
        }
        const recentMemories = memoriesResult.rows
          .map((m: any) => m.content)
          .join("\n");

        const chronologicalResult = await pool.query(
          `SELECT content, created_at FROM co_memories
           WHERE user_id = $1 AND memory_type = 'text_exchange'
           ORDER BY created_at DESC
           LIMIT 8`,
          [user.id],
        );
        const recentConversation = chronologicalResult.rows
          .reverse()
          .map((m: any) => m.content)
          .join("\n");

        // Ground replies in the user's actual upcoming moment (real venue,
        // description, vibes) instead of only loose free-text memory
        // snippets — without this, a question like "what should I expect"
        // has nothing but the moment's name to go on, and the model
        // fabricates a plausible-sounding but false description from it.
        const upcomingMoment = await pool.query(
          `SELECT m.moments_name, m.description, m.venue, m.location_name, m.vibes, m.suggested_time, m.status
           FROM moment_responses mr
           JOIN moments m ON m.id = mr.moment_id
           WHERE mr.user_id = $1 AND m.status IN ('polling', 'consensus_locked', 'confirmed')
           ORDER BY mr.created_at DESC
           LIMIT 1`,
          [user.id],
        );
        const moment = upcomingMoment.rows[0];
        const momentContext = moment
          ? `Their actual upcoming moment (use ONLY these real details — never invent activities, themes, or descriptions beyond what's listed here; if they ask something this doesn't cover, say you'll find out rather than guessing):
          - Name: ${moment.moments_name}
          - Venue: ${moment.venue ?? moment.location_name ?? "TBD"}
          - Description: ${moment.description ?? "(none yet)"}
          - Vibe: ${(moment.vibes ?? []).join(", ") || "(none yet)"}
          - Time: ${moment.suggested_time ?? "TBD"}`
          : "They have no upcoming moment scheduled right now.";

        // Step 6 — Generate Co's reply — Haiku for speed. Vision-enabled:
        // if they sent a photo, it's attached as an actual image input, not
        // just a placeholder string — Co can genuinely see and react to it.
        const promptText = `You are Co, an exclusive life concierge.

          User: ${user.first_name}

          Recent conversation, in order (this is the actual thread — follow it; don't jump to older topics from "other context" below unless they bring it up again):
          ${recentConversation || "(this is the start of the conversation)"}

          Other context that might be relevant, but may be from a different time or topic — use only if it actually applies to what they just said:
          ${recentMemories}

          ${momentContext}

          ${imageForVision ? "They just sent the attached photo." : `They just said: "${resolvedContent}"`}

          Respond as Co. Warm, specific, brief.${imageForVision ? " React to what's actually in the photo." : " Use their context to make it personal."}
          2 sentences max. No em dashes. No exclamation points.`;

        const { text: coReply } = await generateText(
          imageForVision
            ? {
                model: anthropic("claude-haiku-4-5-20251001"),
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "image", image: imageForVision.data, mediaType: imageForVision.mediaType },
                      { type: "text", text: promptText },
                    ],
                  },
                ],
              }
            : {
                model: anthropic("claude-haiku-4-5-20251001"),
                prompt: promptText,
              },
        );

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

        // Non-blocking — updates co_profiles only if this message explicitly
        // communicates a change (see updateProfileFromMessage for why this
        // doesn't just reuse the typed-intake extraction).
        updateProfileFromMessage(user.id, resolvedContent).catch(() => {});

        // Step 8 — Send reply matching the user's medium, emit to socket
        await sendCoReply({ phone: user.phone_number, message: coReply, asVoice: isVoice });
        io.to(`user:${user.id}`).emit("co:message", { message: coReply });

        return res.status(200).send({ received: true, reply: coReply });
      } catch (error) {
        next(error);
      }
      };

      if (lockKey) {
        await withPhoneLock(lockKey, run);
      } else {
        await run();
      }
    },
  );

  return router;
}
