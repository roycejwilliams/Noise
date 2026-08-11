import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { randomInt } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { withAdvisoryLock } from "../db/advisoryLock.js";
import { sendSMS } from "../otpActions.js";
import elevenlabs from "../services/elevenlabs.js";
import { generateCircleTitle, generateWarmCircleInviteMessage } from "../services/circleInvite.js";
import { generateEmbedding } from "../services/embeddings.js";
import {
  createMomentForCircle,
  getCircleBookingContext,
  notifyMemberOfMoment,
  proposeNewTimeForMoment,
  isCircleMember,
  selectVenueForCircle,
} from "./co.js";
import { activateCircle, attemptCircleRematch } from "../services/circleApproval.js";
import { findBestCircle } from "../services/matching.js";
import type { CandidateWindow } from "../services/scheduling.js";
import { confirmMoment, requestVenueApprovalFromModerator } from "../services/booking.js";
import sendblue from "../services/sendblue.js";
import { generateVoiceNote } from "../services/voiceNote.js";

// Serializes webhook processing per phone number. Without this, two
// messages sent seconds apart from the same person can be handled
// concurrently — the second one's queries can run before the first one's
// writes (e.g. a moment being created) have committed, so it falls through
// to the wrong branch entirely (confirmed: a rapid double "Yes" caused the
// second reply to skip the actionable-response handler and hit the general
// fallback instead, producing a hallucinated, unrelated reply).
//
// Backed by a Postgres advisory lock (db/advisoryLock.ts), not an in-memory
// map — a same-process-only lock silently stops protecting anything the
// moment this service runs as more than one replica.
function withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(`phone:${phone}`, fn);
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

    const { text: rawUpdate } = await propagateAttributes(
      { userId: user_id, traceName: "sendblue.updateProfileFromMessage" },
      () =>
        generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          experimental_telemetry: { isEnabled: true, functionId: "sendblue.updateProfileFromMessage" },
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
        }),
    );

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

        // Moderator approval intercept — must run before user lookup since the Moderator may not be in users table.
        // Only intercepts when there's an actual circle to approve/reject — the Moderator is
        // also a normal registered user/contact (e.g. completing her own text-in-first
        // verification, or chatting with Co), and those texts must fall through to the
        // standard user flow below instead of being silently swallowed here.
        const moderatorPhone = process.env.MODERATOR_PHONE_NUMBER;
        if (moderatorPhone && number === moderatorPhone && hasText) {
          const pendingResult = await pool.query(
            `SELECT c.id, c.circle_name, c.owner_id
             FROM circles c
             WHERE c.status = 'pending_approval'
             ORDER BY c.created_at ASC
             LIMIT 1`,
          );

          const pendingCircle = pendingResult.rows[0];
          if (pendingCircle) {

          const { text: classification } = await propagateAttributes(
            { userId: pendingCircle.owner_id, traceName: "sendblue.moderatorApproval.classify" },
            () =>
              generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.moderatorApproval.classify" },
                prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
              }),
          );

          // Same backtick/quote-stripping as the other classification
          // parses in this file — the model doesn't always return bare text.
          const action = classification.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

          if (action === "approve") {
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)`,
              [pendingCircle.owner_id, `Moderator manually approved circle ${pendingCircle.id}`],
            );

            await activateCircle({
              circleId: pendingCircle.id,
              circleName: pendingCircle.circle_name,
              io,
            });
          } else if (action === "reject") {
            const rejectedMembersResult = await pool.query(
              `SELECT member_id FROM circle_members WHERE circle_id = $1`,
              [pendingCircle.id],
            );
            const rejectedMemberIds: string[] = rejectedMembersResult.rows.map((r: any) => r.member_id);

            await attemptCircleRematch({
              staleCircleId: pendingCircle.id,
              ownerId: pendingCircle.owner_id,
              excludeMemberIds: rejectedMemberIds,
              newStatus: "rejected",
              memberNoticeContent: "Circle rejected — Co will attempt new matching",
              io,
            });
          }

            return res.status(200).send({ received: true });
          } else {
            // No pending circle to approve — check for a moment awaiting
            // the Moderator's venue approval instead. Same approve/reject-by-text
            // pattern as the circle-placement approval above, just gating
            // venue choice rather than circle membership.
            const pendingMomentResult = await pool.query(
              `SELECT id, circle_id, moments_name, venue, venue_booking_url, venue_place_id,
                      venue_type, neighborhood, vibe, suggested_time, moment_start, rejected_venues,
                      consensus_low_confidence
               FROM moments
               WHERE status = 'pending_venue_approval'
               ORDER BY created_at ASC
               LIMIT 1`,
            );
            const pendingMomentApproval = pendingMomentResult.rows[0];

            if (pendingMomentApproval) {
              const { text: venueClassification } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.moderatorVenueApproval.classify" },
                prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
              });
              const venueAction = venueClassification
                .trim()
                .toLowerCase()
                .replace(/^[`"']+|[`"']+$/g, "");

              if (venueAction === "approve") {
                await confirmMoment(pendingMomentApproval, io);
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
                      number: moderatorPhone,
                      content: `No alternative venue found for moment ${pendingMomentApproval.id}. Needs manual venue selection.`,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (err: any) {
                    console.error("Failed to notify Moderator of no-alternative-venue:", err?.message ?? err);
                  }
                  await pool.query(
                    `UPDATE moments SET status = 'manual_venue_required', rejected_venues = $1 WHERE id = $2`,
                    [rejectedVenues, pendingMomentApproval.id],
                  );
                } else {
                  await pool.query(
                    `UPDATE moments
                     SET venue = $1, venue_booking_url = $2, venue_place_id = $3,
                         location_name = $4, rejected_venues = $5, venue_fit_score = $6
                     WHERE id = $7`,
                    [
                      nextVenue.name ?? null,
                      nextVenue.venue_booking_url ?? null,
                      nextVenue.place_id ?? null,
                      nextVenue.formatted_address ?? pendingMomentApproval.neighborhood ?? null,
                      rejectedVenues,
                      nextVenue.co_fit_score ?? null,
                      pendingMomentApproval.id,
                    ],
                  );
                  await requestVenueApprovalFromModerator({
                    ...pendingMomentApproval,
                    venue: nextVenue.name ?? null,
                    venue_fit_score: nextVenue.co_fit_score ?? null,
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
            // A genuinely unanswered availability poll — response IS NULL.
            `SELECT mr.moment_id, m.moments_name, m.suggested_time, m.venue, m.moment_start, m.circle_id, m.venue_place_id, m.candidate_windows
             FROM moment_responses mr
             JOIN moments m ON m.id = mr.moment_id
             WHERE mr.user_id = $1
             AND mr.response IS NULL
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
          const { circle_id, owner_id } = pendingCircleInvite.rows[0];

          const { text: circleInterpretation } = await propagateAttributes(
            { userId: user.id, traceName: "sendblue.circleInviteResponse.classify" },
            () =>
              generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.circleInviteResponse.classify" },
                prompt: `A user replied to a circle invite. Classify their response as ONE of: "yes" — they want to join, "no" — they want to pass, "unclear" — can't tell.

Message: "${resolvedContent}"

Return ONLY the classification, nothing else.`,
              }),
          );
          const circleAction = circleInterpretation.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

          if (circleAction === "yes") {
            await pool.query(
              `UPDATE circle_members SET status = 'accepted' WHERE circle_id = $1 AND member_id = $2`,
              [circle_id, user.id],
            );

            // withPhoneLock only serializes messages from this one member's
            // own number — two different members accepting within
            // milliseconds of each other run on separate phone locks and
            // can both see "no moment yet" here. Locking by circle_id (not
            // phone) closes that gap: only one accepter at a time can be in
            // this check-then-create section for a given circle, regardless
            // of whose phone triggered it.
            let moment: any;
            let selectedVenue: any = null;
            let momentData: any = null;
            await withAdvisoryLock(`circle-moment:${circle_id}`, async () => {
              const existingMoment = await pool.query(
                `SELECT * FROM moments WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [circle_id],
              );
              moment = existingMoment.rows[0];

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
            });

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
                    number: moderatorPhone!,
                    content: `Circle ${circle_id} dropped below minimum size after ${declinedCount} declines — hit the replacement attempt limit. Manual review needed.`,
                    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                  });
                } catch (err: any) {
                  console.error("Failed to notify Moderator of exhausted attempts:", err?.message ?? err);
                }
              } else {
                // findBestCircle assembles a whole fresh group (up to
                // target_size), but this is a top-up, not a full rematch —
                // existing active members stay put. Its returned order is
                // already score-sorted (best match first), so capping to 2
                // keeps only the best new candidates rather than everyone
                // the matcher would otherwise fill a brand-new circle with.
                const MAX_NEW_CANDIDATES_PER_DECLINE = 2;
                const replacementIds = await findBestCircle(owner_id, everyKnownId);
                const newCandidates = (replacementIds ?? [])
                  .filter((id: string) => !everyKnownId.includes(id))
                  .slice(0, MAX_NEW_CANDIDATES_PER_DECLINE);

                for (const candidateId of newCandidates) {
                  await pool.query(
                    `INSERT INTO circle_members (circle_id, member_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
                    [circle_id, candidateId],
                  );

                  const candidateResult = await pool.query(
                    `SELECT u.first_name, u.phone_number, cp.city, cp.life_chapters, cp.goals
                     FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id
                     WHERE u.id = $1`,
                    [candidateId],
                  );
                  const candidate = candidateResult.rows[0];
                  if (!candidate) continue;

                  const candidateCity = candidate.city ?? "your city";
                  const candidateChapter = (candidate.life_chapters?.[0] ?? "").replace(/_/g, " ");
                  const candidateCircleTitle = await generateCircleTitle(candidateCity, candidateChapter, candidate.goals ?? []);
                  const candidateInviteMsg = await generateWarmCircleInviteMessage({
                    firstName: candidate.first_name,
                    circleTitle: candidateCircleTitle,
                    chapter: candidateChapter,
                    city: candidateCity,
                    goals: candidate.goals ?? [],
                  });

                  try {
                    await sendblue.messages.send({
                      number: candidate.phone_number,
                      content: candidateInviteMsg,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (smsErr: any) {
                    console.error(`Replacement circle invite failed for ${candidateId}:`, smsErr?.message ?? smsErr);
                  }
                }

                if (!newCandidates.length) {
                  try {
                    await sendblue.messages.send({
                      number: moderatorPhone!,
                      content: `Circle ${circle_id} dropped below minimum size after a decline and no replacement was found. Manual review needed.`,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (err: any) {
                    console.error("Failed to notify Moderator of no-replacement:", err?.message ?? err);
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
          const { moment_id, moments_name, suggested_time, moment_start, circle_id, candidate_windows } = pendingMoment.rows[0];
          const candidateWindows: CandidateWindow[] = candidate_windows ?? [];
          const windowsListText = candidateWindows.length
            ? candidateWindows.map((w, i) => `${i + 1}. ${w.label}`).join("\n")
            : null;

          // Two prompt shapes depending on whether this moment got a
          // simultaneous availability poll (candidate_windows present) or the
          // original single-time poll (older in-flight moments, or window
          // generation failed at creation time) — same classifier, just
          // asked to recognize numbered-window replies when there are any.
          const { text: interpretation } = await propagateAttributes(
            { userId: user.id, traceName: "sendblue.momentAvailabilityResponse.classify" },
            () =>
              generateText({
                model: anthropic("claude-sonnet-4-6"),
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.momentAvailabilityResponse.classify" },
                prompt: windowsListText
              ? `A user replied to a circle event's availability poll. Interpret their response.

              User's message: "${resolvedContent}"

              Candidate time windows offered:
              ${windowsListText}

              Classify their response as ONE of:
              - "windows: [comma-separated numbers]" — the window number(s) they said work, e.g. "windows: 1,3"
              - "no" — none of the windows work for them
              - "time: [their suggestion]" — they proposed a completely different specific time
              - "unclear" — can't determine intent

              Return ONLY the classification, nothing else.`
              : `A user replied to a circle event invitation. Interpret their response.

              User's message: "${resolvedContent}"
              Proposed time: ${suggested_time ?? "TBD"}

              Classify their response as ONE of:
              - "yes" — they confirmed the proposed time
              - "no" — they can't make it
              - "time: [their suggestion]" — they suggested a specific alternative time
              - "unclear" — can't determine intent

              Return ONLY the classification, nothing else.`,
              }),
          );

          // Strip wrapping backticks/quotes — the model sometimes formats
          // its classification as `yes` or "yes" instead of plain text,
          // which fails a strict equality check against parsedResponse below.
          const parsedResponse = interpretation
            .trim()
            .toLowerCase()
            .replace(/^[`"']+|[`"']+$/g, "");

          // Only intercept for classifications that are actually actionable —
          // "unclear" means this wasn't really a moment response at all (e.g.
          // small talk like "hey, how are you?"), and previously got silently
          // recorded with no reply ever sent. Falling through lets Co have a
          // normal conversation instead of going silent on anything ambiguous.
          const isWindowsResponse = parsedResponse.startsWith("windows:");
          const selectedWindows = isWindowsResponse
            ? (parsedResponse.replace(/^windows:\s*/i, "").match(/\d+/g) ?? []).map(Number)
            : [];

          const isActionableResponse =
            parsedResponse === "yes" ||
            parsedResponse === "no" ||
            parsedResponse.startsWith("time:") ||
            (isWindowsResponse && selectedWindows.length > 0);

          if (isActionableResponse) {
            // Any circle member's time proposal reschedules the moment and
            // re-polls everyone — first one to suggest a workable time moves
            // it, no single gatekeeper. Still gated on actually being part of
            // this circle, and on Co being able to parse a real date/time out
            // of what they said.
            let rescheduled = false;
            if (parsedResponse.startsWith("time:") && circle_id && (await isCircleMember(user.id, circle_id))) {
              const rawSuggestion = parsedResponse.replace(/^time:\s*/i, "");
              try {
                const { text: isoGuess } = await propagateAttributes(
                  { userId: user.id, traceName: "sendblue.momentReschedule.parseTime" },
                  () =>
                    generateText({
                      model: anthropic("claude-haiku-4-5-20251001"),
                      experimental_telemetry: { isEnabled: true, functionId: "sendblue.momentReschedule.parseTime" },
                      prompt: `The moment is currently scheduled for ${moment_start} (ISO 8601). A circle member just proposed a new time: "${rawSuggestion}". Return ONLY the new date/time as a single ISO 8601 datetime string, keeping the same timezone offset as the current schedule. No explanation.`,
                    }),
                );
                const newDate = new Date(isoGuess.trim());
                if (!Number.isNaN(newDate.getTime())) {
                  await proposeNewTimeForMoment(moment_id, newDate);
                  rescheduled = true;
                }
              } catch (genErr: any) {
                console.error("Time-reschedule failed (non-fatal):", genErr?.message ?? genErr);
              }
            }

            if (!rescheduled) {
              if (isWindowsResponse) {
                await pool.query(
                  `UPDATE moment_responses
                   SET response = 'windows', selected_windows = $1, responded_at = NOW()
                   WHERE user_id = $2 AND moment_id = $3`,
                  [selectedWindows, user.id, moment_id],
                );
              } else {
                await pool.query(
                  `UPDATE moment_responses
                   SET response = $1, responded_at = NOW()
                   WHERE user_id = $2 AND moment_id = $3`,
                  [parsedResponse, user.id, moment_id],
                );
              }
              io.to(`moment:${moment_id}`).emit("moment:response", {
                user_id: user.id,
                response: isWindowsResponse ? "windows" : parsedResponse,
                selected_windows: isWindowsResponse ? selectedWindows : undefined,
              });
            }

            // Acknowledge — recording the response silently reads as Co
            // ignoring the message entirely.
            let ackMsg = "Got it.";
            try {
              const chosenLabels = isWindowsResponse
                ? selectedWindows
                    .map((i) => candidateWindows[i - 1]?.label)
                    .filter(Boolean)
                    .join(" and ")
                : "";
              const ackContext = rescheduled
                ? `You just rescheduled ${moments_name} to "${parsedResponse.replace(/^time:\s*/i, "")}" and re-asked the rest of the circle to confirm.`
                : isWindowsResponse
                  ? `They said ${chosenLabels || "one of the offered windows"} works for them for ${moments_name}.`
                  : parsedResponse === "yes"
                    ? `They confirmed they can make it to ${moments_name} at ${suggested_time ?? "the proposed time"}.`
                    : parsedResponse === "no"
                      ? `They said they can't make it to ${moments_name}.`
                      : `They proposed a different time for ${moments_name}: "${parsedResponse.replace(/^time:\s*/i, "")}", but Co couldn't pin down a specific date/time from that. Let them know you'll need something more specific, like a day and time.`;
              const { text } = await propagateAttributes(
                { userId: user.id, traceName: "sendblue.momentResponseAck" },
                () =>
                  generateText({
                    model: anthropic("claude-haiku-4-5-20251001"),
                    experimental_telemetry: { isEnabled: true, functionId: "sendblue.momentResponseAck" },
                    prompt: `You are Co, an exclusive life concierge. ${ackContext} Reply to them briefly, warm and specific. 1 sentence. No exclamation points, no em dashes.`,
                  }),
              );
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
           WHERE mr.user_id = $1 AND m.status IN ('polling', 'pending_venue_approval', 'confirmed')
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

        const { text: coReply } = await propagateAttributes(
          { userId: user.id, traceName: "sendblue.generateReply" },
          () =>
            generateText(
              imageForVision
                ? {
                    model: anthropic("claude-haiku-4-5-20251001"),
                    experimental_telemetry: { isEnabled: true, functionId: "sendblue.generateReply" },
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
                    experimental_telemetry: { isEnabled: true, functionId: "sendblue.generateReply" },
                    prompt: promptText,
                  },
            ),
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
