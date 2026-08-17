import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { randomInt } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { withAdvisoryLock } from "../db/advisoryLock.js";
import { sendSMS } from "../otpActions.js";
import elevenlabs from "../services/elevenlabs.js";
import { generateEmbedding } from "../services/embeddings.js";
import { findBestCircle } from "../services/matching.js";
import { getCoverageNudge, markTopicAsked, RAPPORT_TOPIC_DESCRIPTIONS } from "../services/profileExtraction.js";
import { activateCircle, attemptCircleRematch } from "../services/circleApproval.js";
import { confirmMoment } from "../services/booking.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import sendblue from "../services/sendblue.js";
import { generateVoiceNote } from "../services/voiceNote.js";

// Serializes webhook processing per phone number. Without this, two
// messages sent seconds apart from the same person can be handled
// concurrently — the second one's queries can run before the first one's
// writes (e.g. a moment being created) have committed, so it falls through
// to the wrong branch entirely (confirmed in co-test: a rapid double "Yes"
// caused the second reply to skip the actionable-response handler and hit
// the general fallback instead, producing a hallucinated, unrelated reply).
//
// Backed by a Postgres advisory lock (db/advisoryLock.ts), not an in-memory
// map — a same-process-only lock silently stops protecting anything the
// moment this service runs as more than one replica.
function withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(`phone:${phone}`, fn);
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

          const { text: classification } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            experimental_telemetry: { isEnabled: true, functionId: "sendblue.moderatorApproval.classify" },
            prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
          });

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
            //
            // Scoping note: unlike co-test's version, a reject here does NOT
            // automatically re-select and re-propose a different venue — that
            // requires reusable venue-search context (getCircleBookingContext/
            // selectVenueForCircle) this port deliberately didn't extract from
            // the existing /moment route to keep this change contained. A
            // reject just flags the moment for manual venue selection and
            // notifies the Moderator, same as the "no qualifying match" path
            // already does elsewhere in this pipeline.
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
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.venueApproval.classify" },
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
                await pool.query(
                  `UPDATE moments SET status = 'manual_venue_required', rejected_venues = $1 WHERE id = $2`,
                  [rejectedVenues, pendingMomentApproval.id],
                );
                try {
                  await sendblue.messages.send({
                    number: moderatorPhone,
                    content: `Venue rejected for moment ${pendingMomentApproval.id}. Needs manual venue selection.`,
                    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                  });
                } catch (err: any) {
                  console.error("Failed to notify Moderator of venue rejection:", err?.message ?? err);
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

          await sendSMS({
            phone_number: user.phone_number,
            otp_code: otp.toString(),
            register: true,
          });

          return res.status(200).send({ received: true, action: "contact_verified" });
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

        const [inboundMemory, queryEmbedding, pendingMoment, profileResult, priorActivityResult] = await Promise.all([
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
            `SELECT mr.moment_id, m.moments_name, m.suggested_time, m.venue, m.moment_start
             FROM moment_responses mr
             JOIN moments m ON m.id = mr.moment_id
             WHERE mr.user_id = $1 AND mr.response IS NULL
             ORDER BY mr.created_at DESC
             LIMIT 1`,
            [user.id],
          ),
          // Feeds the thin-profile first-message call offer below. Run in the
          // same batch as the inbound insert above (not strictly after it),
          // so a genuine first message doesn't see its own just-inserted row.
          // Also carries the fields Co Loop Stage 1's getCoverageNudge needs
          // (goals/blockers/long_term_direction/city/topics_covered/
          // topics_asked) so a text-only relationship works toward
          // RAPPORT_TOPICS too, not just calls.
          pool.query(
            `SELECT life_chapters, goals, blockers, long_term_direction, city, topics_covered, topics_asked
             FROM co_profiles WHERE user_id = $1`,
            [user.id],
          ),
          pool.query(
            `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') LIMIT 1`,
            [user.id],
          ),
        ]);
        const profile = profileResult.rows[0];
        const hasProfile = !!profile?.life_chapters?.length;
        const isFirstRealMessage = !priorActivityResult.rows[0];

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
          const { moment_id, moments_name, suggested_time, venue, moment_start } = pendingMoment.rows[0];

          const { text: interpretation } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            experimental_telemetry: { isEnabled: true, functionId: "sendblue.momentResponse.classify" },
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
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.momentResponseAck" },
                prompt: `You are Co. A moment just got booked: ${venue ?? moments_name} on ${dateStr} at ${timeStr}. Text confirming it's locked in, in your own words — not a template. Mention you'll follow up with details closer to the day. No exclamation points, no em dashes. 1-2 sentences.`,
              });
              confirmedMsg = text;
            } catch (genErr: any) {
              console.error("Booking-confirmed message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
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

        // Topic-aware, not a permanent opt-out and not a blanket timer either
        // — Co should stay free to offer a call about a genuinely new
        // situation at any time, but never re-offer about something already
        // declined. Each declined offer's own text is stored, and the
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

        const { text: rawCallClassification } = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          experimental_telemetry: { isEnabled: true, functionId: "sendblue.callOffer.classify" },
          prompt: `A user is texting Co, a life concierge.${hasPendingOffer ? " Co just offered them a phone call and is waiting for a yes or no." : ""}

Their message: "${resolvedContent}"

Classify as ONE of:
- "explicit_request" — they are directly asking Co to call them, or asking to talk by phone
${hasPendingOffer ? '- "accepts_offer" — they are saying yes to the call Co just offered\n- "declines_offer" — they are saying no to the call Co just offered\n' : ""}- "would_benefit" — none of the above, but what they're describing is complex, emotional, or hard to unpack over short texts, and voice would genuinely help
- "none" — normal conversation, no call is relevant${declinedTopicsContext}

Return ONLY the classification, nothing else.`,
        });
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
        const recentOfferCountResult = await pool.query(
          `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_pending' AND created_at > NOW() - INTERVAL '10 minutes'`,
          [user.id],
        );
        const recentOfferBurstActive = parseInt(recentOfferCountResult.rows[0].count, 10) > 0;

        // Two independent reasons to make the same secondary, folded-in
        // gesture — never a standalone question. One is content-driven
        // (would_benefit) and can fire on any message from anyone. The other
        // is channel-driven: someone with no profile yet, on their first real
        // message, gets the gesture regardless of what that message actually
        // is — a real voice call produces a far richer initial profile than
        // short texts ever will. Fires at most once per person, so it can't
        // collide with the topic-aware/burst-limiter rules above.
        const isThinProfileFirstMessage = !hasProfile && isFirstRealMessage && callAction === "none";
        const shouldOfferCall =
          !hasPendingOffer && !recentOfferBurstActive && (callAction === "would_benefit" || isThinProfileFirstMessage);

        // Folded into the main reply below, not a separate message that
        // replaces one — the offer is secondary; genuinely responding to
        // what was said is the priority.
        const callOfferContext = !shouldOfferCall
          ? ""
          : isThinProfileFirstMessage
            ? `\nThis is the first real thing they've shared and nothing is known about them yet — first, actually respond to what they said. Then offer a quick call as a warm, low-pressure way to actually get to know them — a real conversation gets Co so much further than texting back and forth. Keep it brief and secondary, never in place of a real response. Do not place any call, just make the gesture.`
            : `\nWhat they just shared could genuinely benefit from a real conversation by voice — but that is not the priority. First, actually respond to what they said. Only if it still feels right after that, offer a call as a warm gesture, not a logistics question — the way someone says "I'm here if you ever want to actually talk this through," not "are you free for a call today or tomorrow." Keep it brief and secondary, never in place of a real response. Do not place any call, just make the gesture.`;

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

        // Step 5 — No pending moment — fetch semantically relevant memories
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

        // Co Loop Stage 1 — same coverage-nudge logic the Stage 5 check-in
        // cron uses (jobs/index.ts), shared via profileExtraction.ts's
        // getCoverageNudge so a text-only relationship also works toward
        // RAPPORT_TOPICS instead of only ever reactively answering whatever
        // comes up. Persisted topics_covered/topics_asked (read as part of
        // `profile` above) mean a topic answered on a prior call or text
        // doesn't get re-judged or re-asked here. recentMemories stands in
        // for a full chronological transcript — this file doesn't build one.
        const { missingTopic } = await getCoverageNudge(user.id, recentMemories, profile);

        // Gated the same way callOfferContext is — never stack two secondary
        // asks in one short text. Skipped entirely while a call offer is
        // pending or about to go out; that already has the reply's one
        // "extra" slot for this message.
        const usingTopicNudge = !shouldOfferCall && !hasPendingOffer && !!missingTopic;
        const topicContext = usingTopicNudge
          ? `\nCo doesn't yet have a good sense of ${RAPPORT_TOPIC_DESCRIPTIONS[missingTopic!]}. First, actually respond to what they just said. Then, only if it fits naturally, work in one brief, genuine question toward that — never force it or make it feel like an interview; skip it entirely this reply if nothing natural comes up.`
          : "";
        if (usingTopicNudge) markTopicAsked(user.id, missingTopic!);

        // Step 6 — Generate Co's reply — Haiku for speed
        const { text: coReply } = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          experimental_telemetry: { isEnabled: true, functionId: "sendblue.generateReply" },
          prompt: `You are Co, an exclusive life concierge.

          User: ${user.first_name}
          Recent context:
          ${recentMemories}

          They just said: "${resolvedContent}"
          ${callOfferContext}
          ${topicContext}

          Respond as Co. Warm, specific, brief. Use their context to make it personal. Co has a real personality — genuine warmth, a real sense of humor, room for a light "haha" or a playful line when something actually calls for it, not forced into every reply.
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

        // Records that an offer went out, so a later "yes"/"no" is correctly
        // read as answering it, and the burst limiter/topic list above have
        // something to count. Must confirm the reply actually contains an
        // offer before recording one — shouldOfferCall being true going in
        // isn't a guarantee the model actually included it.
        if (shouldOfferCall) {
          try {
            const { text: rawOfferCheck } = await generateText({
              model: anthropic("claude-haiku-4-5-20251001"),
              experimental_telemetry: { isEnabled: true, functionId: "sendblue.callOfferCheck" },
              prompt: `Does this text message actually offer, invite, or gesture toward a phone call — in any wording, even indirectly (e.g. "I'm here if you want to talk this through")? Not just related to talking or listening in general — specifically about a phone call.

Message: "${coReply}"

Return ONLY "yes" or "no".`,
            });
            const actuallyOffered = rawOfferCheck.trim().toLowerCase().startsWith("yes");
            if (actuallyOffered) {
              // Stores what the USER actually described, not just Co's own
              // offer text — Co's gesture is often deliberately generic,
              // which makes a weak fingerprint for later topic-matching. This
              // same row's content is what gets copied into
              // call_offer_declined_topic on a decline.
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
