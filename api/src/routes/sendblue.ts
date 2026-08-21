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
import { detectTurnTone } from "../services/emotionalTone.js";
import { findOrCreateUserByPhone, hasPendingEmail, splitFullName } from "../services/identity.js";
import {
  captureIntent,
  extractPsychographicProfile,
  getCoverageNudge,
  markTopicAsked,
  RAPPORT_TOPIC_DESCRIPTIONS,
  storeProfile,
} from "../services/profileExtraction.js";
import {
  createMomentForCircle,
  getCircleBookingContext,
  notifyMemberOfMoment,
  proposeNewTimeForMoment,
  isCircleMember,
  selectVenueForCircle,
} from "./co.js";
import { activateCircle, attemptCircleRematch } from "../services/circleApproval.js";
import { CIRCLE_FACILITATION_ENABLED, findBestCircle } from "../services/circleFacilitation.js";
import type { CandidateWindow } from "../services/scheduling.js";
import { confirmMoment, requestVenueApprovalFromModerator } from "../services/booking.js";
import { triggerCallForUser } from "../services/callTrigger.js";
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

// Heuristic-only (no LLM call — this is directly observable, not something
// to infer) read of how the user themselves texts, from their own lines in
// the chronological window already fetched for the reply prompt. Nudges
// phrasing only (length/formality/emoji) — deliberately leaves Co's core
// brand-voice rules (no em dashes, no exclamation points) alone, since
// those aren't a per-user mirroring target. Needs at least 2 of the user's
// own messages before saying anything, so a first-ever text doesn't get a
// hint built off n=1.
function deriveStyleHint(chronological: { content: string }[]): string {
  const userLines = chronological
    .map((m) => m.content)
    .filter((c) => c.startsWith("User said: ") || c.startsWith("User sent a voice memo: "))
    .map((c) => c.replace(/^User (said|sent a voice memo): /, ""));

  if (userLines.length < 2) return "";

  const avgWords =
    userLines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0) / userLines.length;
  const emojiRate =
    userLines.filter((l) => /\p{Emoji_Presentation}/u.test(l)).length / userLines.length;
  const lowercaseRate =
    userLines.filter((l) => l === l.toLowerCase() && /[a-z]/.test(l)).length / userLines.length;

  const notes: string[] = [];
  if (avgWords <= 6) {
    notes.push("they text short and to the point — keep your replies just as brief, don't pad them out");
  } else if (avgWords >= 20) {
    notes.push("they text in longer, fuller messages — a slightly fuller reply than usual is fine here");
  }
  if (emojiRate >= 0.3) {
    notes.push("they use emoji — an occasional one back is fine, don't force it every message");
  }
  if (lowercaseRate >= 0.6) {
    notes.push("they text casually, lowercase, minimal punctuation — match that relaxed tone");
  }

  return notes.length ? `\nHow they text (match this energy, not their exact words): ${notes.join("; ")}.` : "";
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

// Persists one side of a text exchange — same insert-then-embed pattern
// Step 3 (inbound) and Step 7 (Co's reply) use below for the main chat flow.
// Pulled out here because the identity-intake branch (Step 1.2) used to
// return early on every path without logging anything: a name/email mixup
// during intake left zero trace in co_memories, unlike every other exchange
// in the app. Embedding is fire-and-forget, matching Step 3/7's own
// non-blocking pattern — nothing here should delay Co's reply.
async function logTextExchange(userId: string, content: string): Promise<void> {
  const inserted = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2) RETURNING id`,
    [userId, content],
  );
  generateEmbedding(content)
    .then((emb) =>
      pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
        `[${emb.join(",")}]`,
        inserted.rows[0].id,
      ]),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
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

        // Step 1 — Find user by phone number, creating a bare placeholder row
        // if this number has never texted in before. CoPatible no longer
        // collects name/email through a separate form (Framer or otherwise)
        // ahead of time — the conversation with Co itself is the intake now,
        // so an unknown number can't just be dropped the way it used to be.
        let user = await findOrCreateUserByPhone(number);

        // Co Loop Stage 5 extension — response-rate tracking. Any inbound
        // message counts as a response to a pending check-in, regardless of
        // content or which branch below ends up handling it — this only
        // measures engagement, not resolution (that's Stage 6's job via
        // assessResolvedItems). Fire-and-forget, non-blocking.
        pool
          .query(
            `UPDATE ask_checkins
             SET responded_count = responded_count + 1, awaiting_response_since = NULL, last_response_at = NOW()
             WHERE user_id = $1 AND awaiting_response_since IS NOT NULL`,
            [user.id],
          )
          .catch((err: any) => console.error("ask_checkins response tracking failed (non-fatal):", err?.message ?? err));

        // Step 1.2 — Name/email intake for a brand-new contact. Gated on
        // identity_captured, not on user existence — the placeholder row
        // from findOrCreateUserByPhone above already exists by this point.
        // Texting in from their own number is itself proof of phone
        // ownership, so unlike Step 1.5 below there's no separate OTP here.
        if (!user.identity_captured) {
          if (!user.intake_asked) {
            // First contact ever from this number — greet, then ask. Nothing
            // in this inbound message is treated as an answer, since Co
            // hasn't asked the question yet.
            if (hasText) await logTextExchange(user.id, `User said: ${content}`);
            await pool.query(`UPDATE users SET intake_asked = true WHERE id = $1`, [user.id]);
            await sendSMS({ phone_number: number, welcome: true });
            await sendSMS({ phone_number: number, intro: true });
            await sendSMS({ phone_number: number, intake_ask: true });
            return res.status(200).send({ received: true, action: "intake_started" });
          }

          await logTextExchange(
            user.id,
            hasText ? `User said: ${content}` : "User sent a photo or voice memo (name/email intake)",
          );

          const { text: rawExtraction } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            experimental_telemetry: { isEnabled: true, functionId: "sendblue.intake.extractIdentity" },
            prompt: `Co asked a new contact for their full name and email. Extract both from their reply, combining with anything already known.

Already known — name: ${user.first_name || "not yet given"}, email: ${hasPendingEmail(user.email) ? "not yet given" : user.email}

Their reply: "${hasText ? content : "[no text — sent a photo or voice memo instead]"}"

Return ONLY strict JSON: {"full_name": string or null, "email": string or null}. Only set a field you're actually confident about — carry forward an already-known value if this reply doesn't repeat it, and don't guess at one that's still missing.`,
          });

          let extracted: { full_name: string | null; email: string | null };
          try {
            extracted = JSON.parse(rawExtraction.trim().replace(/^```(?:json)?\n?|\n?```$/g, ""));
          } catch {
            extracted = { full_name: null, email: null };
          }

          const emailValid = !!extracted.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extracted.email);
          const finalName = extracted.full_name?.trim() || user.first_name || null;
          const finalEmail = emailValid ? extracted.email!.trim() : hasPendingEmail(user.email) ? null : user.email;

          if (finalName && finalEmail) {
            const { first_name, last_name } = splitFullName(finalName);
            try {
              const updated = await pool.query(
                `UPDATE users SET first_name = $2, last_name = $3, email = $4, username = $5, identity_captured = true
                 WHERE id = $1 RETURNING *`,
                [user.id, first_name, last_name, finalEmail, finalEmail.split("@")[0]],
              );
              user = updated.rows[0];
            } catch (err: any) {
              if (err?.code === "23505") {
                const conflictMsg = "Looks like that email's already on file. Mind sending a different one?";
                await sendCoReply({ phone: number, message: conflictMsg, asVoice: false });
                await logTextExchange(user.id, `Co replied: ${conflictMsg}`);
                return res.status(200).send({ received: true, action: "intake_email_conflict" });
              }
              throw err;
            }

            let kickoffMsg = `Good to meet you, ${first_name}. What's been on your mind lately?`;
            try {
              const { text } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.intake.kickoff" },
                prompt: `You are Co, an exclusive life concierge. ${first_name} just gave you their name and email to get started. Write a short, warm iMessage welcoming them in and opening the real conversation — invite them to share what's on their mind or going on in their life right now. Tone: like a thoughtful friend, genuine warmth, real personality. No exclamation points. No em dashes. 2 sentences max.`,
              });
              kickoffMsg = text;
            } catch (genErr: any) {
              console.error("Intake kickoff message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
            }
            await sendCoReply({ phone: number, message: kickoffMsg, asVoice: false });
            await logTextExchange(user.id, `Co replied: ${kickoffMsg}`);
            return res.status(200).send({ received: true, action: "identity_captured" });
          }

          if (finalName && finalName !== user.first_name) {
            const { first_name, last_name } = splitFullName(finalName);
            await pool.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = $1`, [
              user.id,
              first_name,
              last_name,
            ]);
          }
          const missingReply = !finalName
            ? extracted.email && !emailValid
              ? "That email didn't look quite right — mind double-checking it?"
              : "Sorry, didn't catch that. What's your full name and email?"
            : "Got your name — what's the best email for you?";
          await sendCoReply({ phone: number, message: missingReply, asVoice: false });
          await logTextExchange(user.id, `Co replied: ${missingReply}`);
          return res.status(200).send({ received: true, action: "intake_incomplete" });
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

        const [inboundMemory, queryEmbedding, pendingMoment, pendingCircleInvite, turnTone] = await Promise.all([
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
          // Run alongside everything else above rather than after it — this
          // is a pure add-on signal for the reply prompt built in Step 6, not
          // something anything else here depends on. hasText guards it so a
          // photo/voice-memo-only message (resolvedContent is a placeholder
          // like "[sent a photo]") doesn't burn a classification call on
          // text that was never really there.
          hasText ? detectTurnTone(resolvedContent, "sendblue.detectTurnTone") : Promise.resolve(null),
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
              // Co Loop Stage 4 — off for now (see circleFacilitation.ts).
              // Same Moderator-notify fallback as hitting the replacement
              // attempt limit, just with a message that says why.
              if (declinedCount > MAX_REPLACEMENT_ATTEMPTS || !CIRCLE_FACILITATION_ENABLED) {
                try {
                  await sendblue.messages.send({
                    number: moderatorPhone!,
                    content: CIRCLE_FACILITATION_ENABLED
                      ? `Circle ${circle_id} dropped below minimum size after ${declinedCount} declines — hit the replacement attempt limit. Manual review needed.`
                      : `Circle ${circle_id} dropped below minimum size after a decline — circle placement is paused right now, no automatic replacement was attempted. Manual review needed.`,
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

        // Step 4.6 — Call-trigger detection. Two cases, per explicit product
        // decision: an explicit ask ("call me") triggers immediately;
        // anything that only SIGNALS voice would help gets OFFERED, and
        // actually placing that call requires a following "yes" — never
        // silently placed. Must compare timestamps, not just existence of a
        // pending offer, or a later unrelated "yeah" could get misread as
        // consenting to a call that was already resolved.
        const pendingOfferResult = await pool.query(
          `SELECT p.id, p.content FROM co_memories p
           WHERE p.user_id = $1 AND p.memory_type = 'call_offer_pending'
           AND NOT EXISTS (
             SELECT 1 FROM co_memories r
             WHERE r.user_id = $1 AND r.memory_type = 'call_offer_resolved' AND r.created_at > p.created_at
           )
           ORDER BY p.created_at DESC LIMIT 1`,
          [user.id],
        );
        const pendingOffer = pendingOfferResult.rows[0] ?? null;
        const hasPendingOffer = !!pendingOffer;

        // Feeds the thin-profile first-message call offer below. Count-based
        // rather than existence-based on purpose — unlike co-test's version
        // of this same check, this message's own text_exchange row was
        // already written above (Step 3), before this point, so "any prior
        // activity exists" would always be true even for a genuine first
        // message. count <= 1 means the only row on file is this message's
        // own.
        const [profileResult, activityCountResult] = await Promise.all([
          pool.query(
            `SELECT life_chapters, goals, blockers, long_term_direction, city, topics_covered, topics_asked
             FROM co_profiles WHERE user_id = $1`,
            [user.id],
          ),
          pool.query(
            `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript')`,
            [user.id],
          ),
        ]);
        const profile = profileResult.rows[0];
        const hasProfile = !!profile?.life_chapters?.length;
        const isFirstRealMessage = parseInt(activityCountResult.rows[0].count, 10) <= 1;

        // Topic-aware, not a permanent opt-out and not a blanket timer either
        // — per explicit product decision, Co should stay free to offer a
        // call about a genuinely new situation at any time, but never
        // re-offer about something already declined. Each declined offer's
        // own text is stored (see the call_offer_pending write near the end
        // of this handler — it captures what the USER described, not just
        // Co's own offer text, since Co's gesture is often deliberately
        // generic and makes a weak fingerprint on its own), and the
        // classifier is given that list directly so the SAME call decides
        // both "would voice help" and "haven't we already asked about this"
        // in one pass.
        const declinedTopicsResult = await pool.query(
          `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_declined_topic' ORDER BY created_at DESC LIMIT 20`,
          [user.id],
        );
        const declinedTopicsContext = declinedTopicsResult.rows.length
          ? `\n\nCo has previously offered a call about the following, and the user said no each time:\n${declinedTopicsResult.rows.map((r: any) => `- ${r.content}`).join("\n")}\nIf what they're describing now is essentially the same situation as any of these, classify as "none" instead of "would_benefit" — don't re-offer about something already declined. A genuinely different, new situation is free to classify as "would_benefit" regardless of these.`
          : "";

        const { text: rawCallClassification } = await propagateAttributes(
          { userId: user.id, traceName: "sendblue.callOffer.classify" },
          () =>
            generateText({
              model: anthropic("claude-haiku-4-5-20251001"),
              experimental_telemetry: { isEnabled: true, functionId: "sendblue.callOffer.classify" },
              prompt: `A user is texting Co, a life concierge.${hasPendingOffer ? " Co just offered them a phone call and is waiting for a yes or no." : ""}

Their message: "${resolvedContent}"

Classify as ONE of:
- "explicit_request" — they are directly asking Co to call them, or asking to talk by phone
${hasPendingOffer ? '- "accepts_offer" — they are saying yes to the call Co just offered\n- "declines_offer" — they are saying no to the call Co just offered\n' : ""}- "would_benefit" — none of the above, but what they're describing is complex, emotional, or hard to unpack over short texts, and voice would genuinely help
- "none" — normal conversation, no call is relevant${declinedTopicsContext}

Return ONLY the classification, nothing else.`,
            }),
        );
        const callAction = rawCallClassification.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

        if (hasPendingOffer && (callAction === "accepts_offer" || callAction === "declines_offer")) {
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_resolved', $2)`,
            [user.id, callAction],
          ).catch((err: any) => console.error("sendblue: call_offer_resolved memory write failed (non-fatal):", err?.message ?? err));

          if (callAction === "declines_offer" && pendingOffer.content) {
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_declined_topic', $2)`,
              [user.id, pendingOffer.content],
            ).catch((err: any) => console.error("sendblue: call_offer_declined_topic memory write failed (non-fatal):", err?.message ?? err));
          }
        }

        const shouldTriggerCall = callAction === "explicit_request" || (hasPendingOffer && callAction === "accepts_offer");

        // Burst limiter — separate from, and in addition to, the topic-aware
        // suppression above. Topic-matching only stops Co re-offering about
        // the SAME thing; on its own it does nothing to stop several
        // DIFFERENT heavy topics in a row each triggering their own offer.
        // Short and topic-blind on purpose: it only needs to cover a burst,
        // not stand in for the topic check above.
        const recentOfferCountResult = await pool.query(
          `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_pending' AND created_at > NOW() - INTERVAL '10 minutes'`,
          [user.id],
        );
        const recentOfferBurstActive = parseInt(recentOfferCountResult.rows[0].count, 10) > 0;

        if (shouldTriggerCall) {
          const callResult = await triggerCallForUser(user.id, io);
          if (callResult.success) {
            const confirmation = "Calling you now.";
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
              [user.id, `Co replied: ${confirmation}`],
            );
            try {
              await sendblue.messages.send({
                number,
                content: confirmation,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(`Sendblue call-confirmation send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
            }
            return res.status(200).send({ received: true, action: "call_triggered", call_sid: callResult.call_sid });
          }
          console.error(`sendblue: call trigger failed for user ${user.id} (non-fatal, falling through to normal reply):`, callResult.error);
          // Falls through to the normal reply flow below on failure — a
          // failed dial attempt should never leave the conversation silent.
        }

        // Two independent reasons to make the same secondary, folded-in
        // gesture — never a standalone question, per the note below. One is
        // content-driven (would_benefit) and can fire on any message from
        // anyone. The other is channel-driven, not content-driven: someone
        // with no profile yet, on their first real message, gets the
        // gesture regardless of what that message actually is — a real
        // voice call just produces a far richer initial profile than short
        // texts ever will, and this is the one moment to offer that before
        // the conversation settles into text. Fires at most once per person
        // (isFirstRealMessage is only ever true for message #1), so it
        // can't collide with the topic-aware/burst-limiter rules above that
        // govern everyone's ongoing conversations.
        const isThinProfileFirstMessage = !hasProfile && isFirstRealMessage && callAction === "none";
        const shouldOfferCall =
          !hasPendingOffer && !recentOfferBurstActive && (callAction === "would_benefit" || isThinProfileFirstMessage);

        // Folded into the main reply below, not a separate message that
        // replaces one — "want to hop on a call?" should never be the ENTIRE
        // response to something significant, with no acknowledgment of what
        // was actually said. The offer is secondary; genuinely responding is
        // the priority, per explicit product decision.
        const callOfferContext = !shouldOfferCall
          ? ""
          : isThinProfileFirstMessage
            ? `\nThis is the first real thing they've shared and nothing is known about them yet — first, actually respond to what they said. Then offer a quick call as a warm, low-pressure way to actually get to know them — a real conversation just gets Co so much further than texting back and forth. Keep it brief and secondary, never in place of a real response.`
            : `\nWhat they just shared could genuinely benefit from a real conversation by voice — but that is not the priority. First, actually respond to what they said: reflect it. Only if it still feels right after that, offer a call as a warm gesture, not a logistics question — the way someone says "I'm here if you ever want to actually talk this through," not "are you free for a call today or tomorrow." Keep it brief and secondary, never in place of a real response.`;

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
        const styleHint = deriveStyleHint(chronologicalResult.rows);

        // Co Loop Stage 1 — same coverage-nudge logic the Stage 5 check-in
        // cron uses (jobs/index.ts), shared via profileExtraction.ts's
        // getCoverageNudge so a text-only relationship also works toward
        // RAPPORT_TOPICS instead of only ever reactively answering whatever
        // comes up — matches co-test/src/routes/webhooks.ts's already-proven
        // approach for this. Persisted topics_covered/topics_asked (read as
        // part of `profile` above) mean a topic answered on a prior call or
        // text doesn't get re-judged or re-asked here.
        const { missingTopic } = await getCoverageNudge(user.id, recentConversation, profile);

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

        // Gated the same way callOfferContext is — never stack two secondary
        // asks in one short text. Skipped entirely while a call offer is
        // pending or about to go out; that already has the reply's one
        // "extra" slot for this message.
        const usingTopicNudge = !shouldOfferCall && !hasPendingOffer && !!missingTopic;
        const topicContext = usingTopicNudge
          ? `\nCo doesn't yet have a good sense of ${RAPPORT_TOPIC_DESCRIPTIONS[missingTopic!]}. First, actually respond to what they just said. Then, only if it fits naturally, work in one brief, genuine question toward that — never force it or make it feel like an interview; skip it entirely this reply if nothing natural comes up.`
            : "";
        if (usingTopicNudge) markTopicAsked(user.id, missingTopic!);

        // Not gated like callOfferContext/topicContext above — this isn't a
        // competing "extra ask" for the reply's one secondary slot, it's an
        // instruction about HOW to say whatever Co was already going to say.
        // Advisory only (see detectTurnTone) and never named back to the
        // user — a good friend responds differently to someone who's upset,
        // they don't announce "you sound upset."
        const toneContext = turnTone
          ? `\nThey sound ${turnTone} right now. Let that genuinely shape your tone and pacing, not just your words — don't be breezy, joke, or rush past it if it doesn't fit. Never name the emotion back at them like a label.`
          : "";

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
          ${callOfferContext}
          ${topicContext}
          ${toneContext}
          ${styleHint}

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

        // Fire-and-forget, same real pipeline a call uses (extractPsychographicProfile
        // + storeProfile + captureIntent), fed the accumulated text thread instead of
        // a call transcript — matches co-test/src/routes/webhooks.ts's already-proven
        // approach, ported here since prod previously had only a thin 4-field patch
        // (life_chapters/emotional_state/goals/blockers) that couldn't create a
        // profile row at all and never touched intent, so a text-only user's stated
        // ask never reached co_profiles.intent for matching.filterByStatedAsk to use.
        const textTranscript = `${recentConversation}\nuser: ${resolvedContent}\nassistant: ${coReply}`.trim();
        extractPsychographicProfile(textTranscript)
          .then(({ extracted }) => storeProfile(user.id, extracted, textTranscript))
          .catch((err: any) => console.error("sendblue: text-based profile extraction failed (non-fatal):", err?.message ?? err));
        captureIntent(user.id, textTranscript).catch((err: any) =>
          console.error("sendblue: text-based intent capture failed (non-fatal):", err?.message ?? err),
        );

        // Step 8 — Send reply matching the user's medium, emit to socket
        await sendCoReply({ phone: user.phone_number, message: coReply, asVoice: isVoice });
        io.to(`user:${user.id}`).emit("co:message", { message: coReply });

        // Step 9 — Records that an offer went out, so a later "yes"/"no" is
        // correctly read as answering it, and the burst limiter/topic list
        // above have something to count. Must confirm the reply actually
        // contains an offer before recording one — shouldOfferCall being
        // true going in isn't a guarantee the model actually included it.
        if (shouldOfferCall) {
          try {
            const { text: rawOfferCheck } = await propagateAttributes(
              { userId: user.id, traceName: "sendblue.callOfferCheck" },
              () =>
                generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  experimental_telemetry: { isEnabled: true, functionId: "sendblue.callOfferCheck" },
                  prompt: `Does this text message actually offer, invite, or gesture toward a phone call — in any wording, even indirectly (e.g. "I'm here if you want to talk this through")? Not just related to talking or listening in general — specifically about a phone call.

Message: "${coReply}"

Return ONLY "yes" or "no".`,
                }),
            );
            const actuallyOffered = rawOfferCheck.trim().toLowerCase().startsWith("yes");
            if (actuallyOffered) {
              // Stores what the USER actually described, not just Co's own
              // offer text — see the comment near declinedTopicsContext
              // above for why. This same row's content is what gets copied
              // into call_offer_declined_topic on a decline.
              await pool
                .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
                  user.id,
                  `User described: ${resolvedContent} | Co offered: ${coReply}`,
                ])
                .catch((err: any) => console.error("sendblue: call_offer_pending memory write failed (non-fatal):", err?.message ?? err));
            }
          } catch (err: any) {
            console.error("sendblue: call-offer verification failed (non-fatal, not recording a pending offer):", err?.message ?? err);
          }
        }

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
