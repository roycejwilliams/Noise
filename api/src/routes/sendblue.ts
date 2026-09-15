import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { randomInt } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { DateTime } from "luxon";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { withAdvisoryLock } from "../db/advisoryLock.js";
import { sendSMS } from "../otpActions.js";
import { renderCoPersonaPrompt } from "../services/coPersona.js";
import elevenlabs from "../services/elevenlabs.js";
import { generateEmbedding } from "../services/embeddings.js";
import { detectSeekingMode } from "../services/emotionalTone.js";
import { getEmotionalContext, readTextEmotion, recordEmotionSignals, renderEmotionalContext } from "../harness/emotion.js";
import { buildContextSummary } from "../services/callContext.js";
import { findOrCreateUserByPhone, hasPendingEmail, splitFullName } from "../services/identity.js";
import { claimTextLogin } from "../services/textLogin.js";
import {
  INTAKE_EXTRACT_MODEL,
  buildIntakeExtractionPrompt,
  decideIntake,
  gatherIntakeState,
  isEmailOnOtherAccount,
  isValidEmail,
  parseIntakeProposal,
  type IntakeProposal,
} from "../harness/intake.js";
import { isOptInKeyword, isOptOutKeyword } from "../services/optOut.js";
import {
  captureIntent,
  extractPlannedEventMention,
  extractPsychographicProfile,
  getCoverageNudge,
  RAPPORT_TOPIC_DESCRIPTIONS,
  storeProfile,
} from "../services/profileExtraction.js";
import { generateRecommendation } from "../services/recommendation.js";
import { detectCheckinPhrase, recordCheckin, hasActiveAsk, recordWalkinAsk } from "../services/eventWalkinCheckin.js";
import { scheduleOutcomeFollowUp, recordOutcome } from "../services/recommendationOutcome.js";
import { recordEventCheckinOutcome } from "../services/eventCheckinFollowUp.js";
import { handleMatchNudgeReply, handleGroupMessage, handleMethodChoiceReply } from "../services/eventGuestMatchHandoff.js";
import { resolveNetworkTeaseReply, resolveNetworkIntroReply } from "../services/networkIntroNudge.js";
import { NO_ROUTE, decideActions, gatherOpenItems, routeMessage, type RouterOutput } from "../services/messageRouter.js";
import { recordDecision } from "../harness/core.js";
import { routerGateChecks } from "../harness/routerChecks.js";
import { addEventFacts, addFact, addInstruction, gatherReplyFacts } from "../harness/replyGrounding.js";
import { findRealVenues } from "../services/venueLookup.js";
import { runConversationReplyAgent, filterRelevantMemories, CALL_OFFER_EXPIRY_DAYS } from "../agent/conversationReply.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { generateVoiceNote } from "../services/voiceNote.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { enrichMatch, renderEventDetails } from "../services/eventDetails.js";

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

// How long to hold off Co's free-form reply after an inbound message, in
// case the same person is mid-thought and about to send a follow-up.
// Started at 5s; bumped to 8s after checking a real conversation's actual
// gaps between related messages (16s in one case) — 5s was catching only
// the fastest bursts. Not pushed further toward 16s itself: that would
// make every single-message reply feel sluggish for the common case just
// to fully cover one slower outlier.
const DEBOUNCE_MS = 4000;

// Heuristic-only (no LLM call — this is directly observable, not something
// to infer) read of how the user themselves texts, from their own lines in
// the chronological window already fetched for the reply prompt. Nudges
// phrasing only (length/formality/emoji) — deliberately leaves Co's core
// brand-voice rules (no em dashes) alone, since
// those aren't a per-user mirroring target. Needs at least 2 of the user's
// own messages before saying anything, so a first-ever text doesn't get a
// hint built off n=1.
// Recency-weighted, not a flat average over the whole window (Royce,
// 2026-09-08, confirmed live: "capitalization is no longer working,
// everything being texted back is lowercase") — this used to average
// lowercaseRate/avgWords/emojiRate over every user line in the 10-turn
// window with equal weight, so a real register shift (e.g. today's texts
// switching to normal capitalization) stayed invisible for turns, outvoted
// by older, more casual test messages earlier in the window. Only the
// last STYLE_HINT_RECENT_LINES user messages are considered now, so an
// actual shift in how someone's texting dominates within a message or two
// instead of a full window's worth.
const STYLE_HINT_RECENT_LINES = 4;

function deriveStyleHint(chronological: { content: string }[]): string {
  const userLines = chronological
    .map((m) => m.content)
    .filter((c) => c.startsWith("User said: ") || c.startsWith("User sent a voice memo: "))
    .map((c) => c.replace(/^User (said|sent a voice memo): /, ""))
    .slice(-STYLE_HINT_RECENT_LINES);

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

// Marks a visible gap between conversation lines whenever there's a real
// pause since the previous one — without this, two lines sitting next to
// each other in this block read as equally "just now" to the reply model,
// regardless of whether they were 30 seconds or 2 days apart. Confirmed
// live, 2026-09-04: a real "Call me" from 2 days earlier sat directly above
// an unrelated "For sure" from today with nothing marking the gap, and the
// reply model (told this whole block is "the actual thread") stitched them
// into one exchange — producing a reply that confidently, and wrongly,
// claimed the user had just said "call me" today. Threshold-gated, not
// shown on every line, so an ordinary back-and-forth doesn't get cluttered
// with markers for normal reply-time pauses.
const CONVERSATION_GAP_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function annotateConversationGaps(rows: { content: string; created_at: Date }[]): string {
  const lines: string[] = [];
  let prevTime: Date | null = null;
  for (const row of rows) {
    const time = new Date(row.created_at);
    if (prevTime && time.getTime() - prevTime.getTime() > CONVERSATION_GAP_THRESHOLD_MS) {
      lines.push(`[— ${formatGap(time.getTime() - prevTime.getTime())} later —]`);
    }
    lines.push(row.content);
    prevTime = time;
  }
  return lines.join("\n");
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
  const { phone, asVoice } = params;
  // Confirmed live, 2026-09-08 sweep: this, the actual send function behind
  // the main conversational reply path (by far the highest-volume path in
  // the app), never applied cleanCoMessage — despite a since-corrected
  // comment elsewhere (conversationTools.ts) claiming it ran "inside
  // sendCoReply's send call." git history confirms cleanCoMessage has never
  // appeared in this file at all: not just the em dash/en dash cleanup, the
  // LEAKED_METACOMMENTARY safety guard bundled into the same function never
  // applied here either, on the single highest-traffic send path.
  const message = cleanCoMessage(params.message);

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

      // Stamped here, before withPhoneLock, not inside run() below. Once a
      // phone's advisory lock is held, a second inbound message for that
      // same phone can't run ANY code — including this very stamp — until
      // the first message's run() has finished and released the lock. If
      // this write lived inside run(), a message that arrived during the
      // first request's debounce wait would be queued behind that same
      // lock and could never become visible during the wait. Stamping out
      // here, ahead of the lock, decouples "record that a message arrived"
      // from "wait in line to be processed."
      let myInboundAt: string | null = null;
      const bodyForStamp = req.body ?? {};
      if (lockKey && !bodyForStamp.is_outbound && typeof bodyForStamp.content === "string") {
        bodyForStamp.content = await claimTextLogin(lockKey, bodyForStamp.content);
      }
      const isGenuineInbound =
        bodyForStamp.type !== "typing" &&
        !bodyForStamp.is_outbound &&
        ((typeof bodyForStamp.content === "string" && bodyForStamp.content.trim().length > 0) ||
          (typeof bodyForStamp.media_url === "string" && bodyForStamp.media_url.length > 0));
      if (lockKey && isGenuineInbound) {
        try {
          const stampResult = await pool.query(
            `INSERT INTO phone_debounce (phone, last_inbound_at) VALUES ($1, NOW())
             ON CONFLICT (phone) DO UPDATE SET last_inbound_at = NOW()
             RETURNING last_inbound_at`,
            [lockKey],
          );
          myInboundAt = stampResult.rows[0].last_inbound_at;
        } catch (err: any) {
          // Fail open — if the stamp can't be written, just skip the
          // debounce for this request rather than blocking or crashing on
          // what is a UX nicety, not a correctness requirement.
          console.error("sendblue: phone_debounce stamp failed (non-fatal, debounce skipped):", err?.message ?? err);
          myInboundAt = null;
        }
      }

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
          group_id,
          message_type,
        } = req.body;

        // Group messages (event intro handoff, services/eventGuestMatchHandoff.ts)
        // — entirely separate from the normal 1:1 conversation pipeline below.
        // Co only ever speaks in a group when directly mentioned by name; every
        // other group message (including this same send's own outbound delivery
        // status) is just acknowledged and never treated as a personal
        // conversational turn the way a 1:1 text would be.
        if (message_type === "group" || group_id) {
          if (!is_outbound && typeof content === "string" && content.trim() && group_id) {
            handleGroupMessage(group_id, number, content).catch((err: any) =>
              console.error("sendblue webhook: handleGroupMessage failed (non-fatal):", err?.message ?? err),
            );
          }
          return res.status(200).send({ received: true });
        }

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

        // A malformed inbound `number` (confirmed: Sendblue can deliver one,
        // e.g. a bare 5-digit value) was flowing straight through to a real,
        // billed sendSMS call via findOrCreateUserByPhone below — nothing on
        // this path validated shape before either creating a user row or
        // sending. Reject before either happens.
        if (!parsePhoneNumberFromString(number, "US")?.isValid()) {
          console.error(`sendblue webhook: malformed inbound number "${number}" — ignoring`);
          return res.status(200).send({ received: true });
        }

        // Step 1 — Find user by phone number, creating a bare placeholder row
        // if this number has never texted in before. CoPatible no longer
        // collects name/email through a separate form (Framer or otherwise)
        // ahead of time — the conversation with Co itself is the intake now,
        // so an unknown number can't just be dropped the way it used to be.
        let user = await findOrCreateUserByPhone(number);

        // STOP/START handling — checked before anything else (intake,
        // duplicate/debounce, the real reply) so it works regardless of
        // account state, and short-circuits everything below for an
        // opted-out user except START/UNSTOP itself.
        if (hasText && isOptOutKeyword(content)) {
          await pool.query(`UPDATE users SET sms_opted_out = true WHERE id = $1`, [user.id]);
          try {
            await sendblue.messages.send({
              number,
              content: "You've been unsubscribed and won't receive further messages or calls from Co. Text START to resubscribe.",
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (err: any) {
            console.error("sendblue webhook: opt-out confirmation send failed (non-fatal):", err?.message ?? err);
          }
          return res.status(200).send({ received: true, action: "opted_out" });
        }
        if (hasText && isOptInKeyword(content)) {
          await pool.query(`UPDATE users SET sms_opted_out = false WHERE id = $1`, [user.id]);
          try {
            await sendblue.messages.send({
              number,
              content: "You're resubscribed — welcome back.",
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (err: any) {
            console.error("sendblue webhook: opt-in confirmation send failed (non-fatal):", err?.message ?? err);
          }
          return res.status(200).send({ received: true, action: "opted_in" });
        }
        if (user.sms_opted_out) {
          return res.status(200).send({ received: true, action: "opted_out_ignored" });
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

        // Day-of QR check-in (Royce, 2026-09-10) — detected before the
        // brand-new-contact intake branch below, which returns early: a
        // walk-in's very first-ever message to Co can BE the check-in text
        // itself, and the row needs to exist regardless of whether identity
        // capture has happened yet. Fire-and-forget on the write; never let
        // this block or fail the real reply below.
        let walkinCheckinEventName: string | null = null;
        if (hasText) {
          const checkin = await detectCheckinPhrase(content).catch((err: any) => {
            console.error("sendblue: detectCheckinPhrase failed (non-fatal):", err?.message ?? err);
            return null;
          });
          if (checkin) {
            await recordCheckin(checkin.eventApiId, user.id).catch((err: any) =>
              console.error("sendblue: recordCheckin failed (non-fatal):", err?.message ?? err),
            );
            walkinCheckinEventName = checkin.eventName;
          }
        }

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
            // Contact card (Royce, 2026-09-14): otpActions.ts has always had
            // a save_contact send with the vCard attached, but nothing ever
            // called it, so new people never got Co saved in their phone.
            await sendSMS({ phone_number: number, save_contact: true });
            await sendSMS({ phone_number: number, intake_ask: true });
            return res.status(200).send({ received: true, action: "intake_started" });
          }

          await logTextExchange(
            user.id,
            hasText ? `User said: ${content}` : "User sent a photo or voice memo (name/email intake)",
          );

          // Layer 1 harness (src/harness/intake.ts): the model only proposes
          // name/email; code decides whether to capture, hold a partial
          // email, or ask, and never re-asks for something already on file.
          const intakeState = await gatherIntakeState(user);
          let extracted: IntakeProposal = { full_name: null, email: null };
          try {
            const { text: rawExtraction } = await generateText({
              model: anthropic(INTAKE_EXTRACT_MODEL),
              experimental_telemetry: { isEnabled: true, functionId: "sendblue.intake.extractIdentity" },
              prompt: buildIntakeExtractionPrompt(intakeState, hasText ? content : null),
            });
            extracted = parseIntakeProposal(rawExtraction);
          } catch (err: any) {
            console.error("sendblue intake: identity extraction failed (non-fatal, asking again):", err?.message ?? err);
          }

          const proposedEmail = extracted.email?.trim() || null;
          const emailTaken = isValidEmail(proposedEmail) ? await isEmailOnOtherAccount(proposedEmail, user.id) : false;
          let intake = decideIntake(intakeState, extracted, {
            emailTakenByOtherAccount: emailTaken,
            replyText: hasText ? content : null,
          });

          if (intake.action === "capture") {
            const { first_name, last_name } = splitFullName(intake.name!);
            const captureIdentity = (username: string) =>
              pool.query(
                `UPDATE users SET first_name = $2, last_name = $3, email = $4, username = $5, identity_captured = true,
                   intake_partial_email = NULL, intake_retries = 0
                 WHERE id = $1 RETURNING *`,
                [user.id, first_name, last_name, intake.email, username],
              );
            const localPart = intake.email!.split("@")[0];
            try {
              let updated;
              try {
                updated = await captureIdentity(localPart);
              } catch (err: any) {
                // usernames are UNIQUE too; two people can share an email
                // local part, which isn't an email conflict at all.
                if (err?.code !== "23505" || !String(err?.constraint ?? "").includes("username")) throw err;
                updated = await captureIdentity(`${localPart}_${user.id.slice(0, 6)}`);
              }
              user = updated.rows[0];
            } catch (err: any) {
              if (err?.code !== "23505") throw err;
              // Lost a race with another account for the same email (or a
              // held partial email was taken since): drop it and ask again.
              intake = decideIntake(
                { ...intakeState, knownName: intake.name, partialEmail: null, knownEmail: null },
                { full_name: intake.name, email: intake.email },
                { emailTakenByOtherAccount: true },
              );
            }
          }

          await recordDecision({
            layer: 1,
            decision: "intake.identity",
            userId: user.id,
            outcome: intake.outcome,
            action: intake.action,
            proposal: extracted,
            checks: intake.checks,
            reason: intake.reason,
          });

          if (intake.action === "capture") {
            const first_name = user.first_name;
            let kickoffMsg = `Good to meet you, ${first_name}. What's been on your mind lately?`;
            try {
              const { text } = await generateText({
                model: anthropic(INTAKE_EXTRACT_MODEL),
                experimental_telemetry: { isEnabled: true, functionId: "sendblue.intake.kickoff" },
                prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} ${first_name} just gave you their name and email to get started. Write a short message welcoming them in and opening the real conversation: invite them to share what's on their mind or going on in their life right now. 2 sentences max.`,
              });
              if (text.trim()) kickoffMsg = cleanCoMessage(text.trim());
            } catch (genErr: any) {
              console.error("Intake kickoff message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
            }
            await sendCoReply({ phone: number, message: kickoffMsg, asVoice: false });
            await logTextExchange(user.id, `Co replied: ${kickoffMsg}`);
            return res.status(200).send({ received: true, action: "identity_captured" });
          }

          const nameChanged = intake.name && intake.name !== intakeState.knownName;
          const nameParts = intake.name ? splitFullName(intake.name) : null;
          await pool.query(
            `UPDATE users SET
               first_name = COALESCE($2, first_name),
               last_name = COALESCE($3, last_name),
               intake_partial_email = COALESCE($4, intake_partial_email),
               intake_retries = intake_retries + 1
             WHERE id = $1`,
            [user.id, nameChanged ? nameParts!.first_name : null, nameChanged ? nameParts!.last_name : null, intake.savePartialEmail],
          );
          const missingReply = intake.reply!;
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
          await sendSMS({ phone_number: user.phone_number, save_contact: true });
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

        // Step 3 — Store inbound message, generate embedding (in parallel)
        const inboundContent = isVoice
          ? `User sent a voice memo: ${resolvedContent}`
          : `User said: ${resolvedContent}`;

        const [inboundMemory, queryEmbedding] = await Promise.all([
          pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'text_exchange', $2) RETURNING id`,
            [user.id, inboundContent],
          ),
          generateEmbedding(inboundContent).catch((err) => {
            console.error("Inbound embedding failed (non-fatal):", err);
            return null;
          }),
        ]);

        // Same text sent again within a couple of minutes (confirmed live:
        // people resend when a reply is slow). The reply agent is told so it
        // answers once instead of treating each copy as a new message.
        let repeatContext = "";
        if (hasText) {
          const repeats = await pool
            .query(
              `SELECT COUNT(*)::int AS n FROM co_memories
               WHERE user_id = $1 AND memory_type = 'text_exchange' AND content = $2
                 AND id <> $3 AND created_at > NOW() - INTERVAL '2 minutes'`,
              [user.id, inboundContent, inboundMemory.rows[0].id],
            )
            .then((r) => r.rows[0]?.n ?? 0)
            .catch(() => 0);
          if (repeats > 0) {
            repeatContext = `\nThey've sent this exact message ${repeats + 1} times in the last couple of minutes, probably because your reply felt slow. Answer it once, as a single reply. Don't treat it as new, and don't point out that they repeated it.`;
          }
        }

        if (queryEmbedding) {
          pool
            .query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${queryEmbedding.join(",")}]`, inboundMemory.rows[0].id],
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
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
        // Moved up from the old "Step 5" position — the call-offer/schedule
        // classifier below needs the actual conversation thread (a time
        // given in one message and a timezone confirmed in a later one is
        // still a single schedule request), not just this message alone.
        //
        // Bug fix, 2026-09-01 (Royce, diagnosing a real memory-continuity
        // gap live with Co — see callContext.ts's buildContextSummary for
        // the fuller writeup): 8 rows is only 4 conversational turns. A
        // longer real exchange (exactly the kind where continuity matters
        // most) could already be losing its own early turns to this same
        // window mid-conversation, on top of the separate cross-conversation
        // gap buildContextSummary had. Raised to 10 turns' worth; safe for
        // deriveStyleHint below too, which only gets more representative
        // (not worse) with a bigger sample of someone's normal texting style.
        const chronologicalResult = await pool.query(
          `SELECT content, created_at FROM co_memories
           WHERE user_id = $1 AND memory_type = 'text_exchange'
           ORDER BY created_at DESC
           LIMIT 20`,
          [user.id],
        );
        const chronologicalRows = chronologicalResult.rows.reverse();
        const recentConversation = annotateConversationGaps(chronologicalRows);
        const styleHint = deriveStyleHint(chronologicalRows);

        // Emotion loop (harness/emotion.ts): read how this message feels in
        // the context of the conversation, record it, then load the shared
        // picture (this text, recent calls, what keeps coming up) that the
        // reply reasons from. Alongside: whether they want to be heard or
        // helped toward an answer.
        const [seekingMode, textEmotion] = hasText
          ? await Promise.all([
              detectSeekingMode(resolvedContent, recentConversation, "sendblue.detectSeekingMode"),
              readTextEmotion(resolvedContent, recentConversation, "sendblue.readTextEmotion"),
            ])
          : [null, null];
        if (textEmotion) {
          await recordEmotionSignals(user.id, [{ source: "text", ...textEmotion, quote: resolvedContent.slice(0, 140), memoryId: inboundMemory.rows[0].id }]);
        }
        const emotional = await getEmotionalContext(user.id);

        const pendingOfferResult = await pool.query(
          `SELECT p.id, p.content, p.created_at FROM co_memories p
           WHERE p.user_id = $1 AND p.memory_type = 'call_offer_pending'
           AND p.created_at > NOW() - ($2 || ' days')::interval
           AND NOT EXISTS (
             SELECT 1 FROM co_memories r
             WHERE r.user_id = $1 AND r.memory_type = 'call_offer_resolved' AND r.created_at > p.created_at
           )
           ORDER BY p.created_at DESC LIMIT 1`,
          [user.id, CALL_OFFER_EXPIRY_DAYS],
        );
        const pendingOffer = pendingOfferResult.rows[0] ?? null;
        const hasPendingOffer = !!pendingOffer;

        // Real event fields for follow-up questions ("what time does it
        // start?") now come from gatherReplyFacts (harness/replyGrounding.ts),
        // along with the details Co explicitly doesn't have. Confirmed live
        // 2026-09-09: without them the reply invented a start time, a
        // neighborhood, and a headcount.

        // Day-of QR check-in — the ask-question step. Looked up independently
        // of walkinCheckinEventName above (which only reflects THIS turn's
        // message) since a brand-new contact's check-in text is entirely
        // consumed by the intake-start branch above, which returns early —
        // the ask can only happen once identity capture completes, on a
        // later turn, once event_walkin_checkins already has the row but no
        // ask_text yet.
        const pendingWalkinCheckinResult = await pool.query(
          `SELECT event_api_id FROM event_walkin_checkins
           WHERE person_id = $1 AND ask_text IS NULL
             AND checked_in_at > NOW() - INTERVAL '1 day'
           ORDER BY checked_in_at DESC LIMIT 1`,
          [user.id],
        );
        const pendingWalkinCheckin = pendingWalkinCheckinResult.rows[0] ?? null;
        let walkinAskInstruction = "";
        if (pendingWalkinCheckin && walkinCheckinEventName) {
          // This turn's message IS the fresh check-in trigger itself (set
          // above) — nothing to capture as an answer yet, so decide whether
          // to ask based on whatever's already on file.
          const alreadyHasAsk = await hasActiveAsk(user.id).catch((err: any) => {
            console.error("sendblue: hasActiveAsk failed (non-fatal):", err?.message ?? err);
            return true; // fail toward not re-asking rather than risk a duplicate ask on error
          });
          if (!alreadyHasAsk) {
            walkinAskInstruction = `They just checked in at "${walkinCheckinEventName}" and don't have a stated ask on file yet. Ask them directly, once, in their own words: "what are you hoping to find here / who'd be good to meet?" Keep it to that one question this turn, don't pad it with anything else.`;
          }
        }
        // Not a fresh check-in this turn and the row is still missing
        // ask_text: the walkin_ask open item below lets the router decide
        // whether this message actually answers it (recorded after routing).

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
        // generic and makes a weak fingerprint on its own), and the router
        // is given that list directly so the SAME call decides both "would
        // voice help" and "haven't we already asked about this" in one pass.
        const declinedTopicsResult = await pool.query(
          `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_declined_topic' ORDER BY created_at DESC LIMIT 20`,
          [user.id],
        );

        // Layer 2 router (Royce, 2026-09-14). Replaces the separate call-offer,
        // event-tease, outcome, check-in, match-nudge, network, method-choice,
        // updates, recommendation and venue classifiers, which each decided on
        // their own whether this message was "theirs" — one "yes" could accept
        // a stale call offer AND opt into an intro. Now one call sees every
        // open item, and decideActions (plain code) decides what runs: at most
        // one item resolved, and irreversible actions (placing a call, opting
        // into an intro, a connection method) only on a clear, high-confidence
        // read of something Co actually just asked. Otherwise nothing resolves
        // and clarifyContext has the reply ask which they meant. Any change to
        // the router must pass evals/router/run.ts first.
        const openItems = await gatherOpenItems(user.id, { skipWalkinAsk: !!walkinCheckinEventName }).catch((err: any) => {
          console.error("sendblue: gatherOpenItems failed (non-fatal, routing with no open items):", err?.message ?? err);
          return [];
        });
        let routerOutput: RouterOutput = NO_ROUTE;
        let routerFailed = false;
        let routerLatencyMs: number | null = null;
        try {
          const routed = await propagateAttributes({ userId: user.id, traceName: "sendblue.router.route" }, () =>
            routeMessage({
              message: resolvedContent,
              recentConversation,
              openItems,
              declinedCallTopics: declinedTopicsResult.rows.map((r: any) => r.content),
            }),
          );
          routerOutput = routed.output;
          routerLatencyMs = routed.latencyMs;
        } catch (err: any) {
          routerFailed = true;
          // Fail safe: act on nothing rather than guess.
          console.error("sendblue: message router failed (non-fatal, taking no actions this turn):", err?.message ?? err);
        }
        const decision = decideActions(routerOutput, openItems, { message: resolvedContent, recentConversation });
        // Items other than a call offer only ever resolved on real text, same
        // as the classifiers this replaces.
        const resolvedItem = decision.resolve && (hasText || decision.resolve.item.kind === "call_offer") ? decision.resolve : null;
        const resolvedAs = <K extends string>(kind: K) => (resolvedItem?.item.kind === kind ? resolvedItem : null);

        // Layer 2 harness record: the router's proposal, the code gates it
        // went through, and what was allowed to run.
        {
          const checks = routerGateChecks(routerOutput, openItems, decision, { message: resolvedContent, recentConversation }, routerFailed);
          const acted = [
            resolvedItem ? `resolve:${resolvedItem.item.kind}=${resolvedItem.value}` : null,
            decision.placeCall ? "place_call" : null,
            decision.scheduleCall ? "schedule_call" : null,
            decision.cancelCall ? "cancel_call" : null,
            decision.wantsRecommendation ? "recommendation" : null,
            decision.asksForUpdates ? "updates" : null,
            decision.venue ? "venue" : null,
          ].filter(Boolean);
          recordDecision({
            layer: 2,
            decision: "router.decideActions",
            userId: user.id,
            outcome: acted.length ? "act" : decision.clarifyContext ? "ask" : "skip",
            action: acted.join(",") || (decision.clarifyAbout ? `clarify:${decision.clarifyAbout}` : null),
            proposal: { ...routerOutput, openItems: openItems.map((i) => i.id), latencyMs: routerLatencyMs },
            checks,
            confidence: routerOutput.confidence,
            reason: routerFailed ? "router unavailable" : routerOutput.reason,
          });
        }

        // Layer 3 harness facts: what's actually true this turn. Branches
        // below add what they did (a link sent, a call that failed) as they
        // act; the reply can only claim what ends up here.
        const replyFacts = await gatherReplyFacts(user.id, {
          pendingDescriptions: openItems.filter((i) => i.id !== resolvedItem?.item.id).map((i) => i.description),
        });
        if (repeatContext) addInstruction(replyFacts, repeatContext);
        if (walkinAskInstruction) addInstruction(replyFacts, walkinAskInstruction);
        if (decision.clarifyContext) addInstruction(replyFacts, decision.clarifyContext);

        // Same strings downstream code (and the reply agent) already key on.
        const callAction =
          resolvedAs("call_offer")?.value === "accept"
            ? "accepts_offer"
            : resolvedAs("call_offer")?.value === "decline"
              ? "declines_offer"
              : decision.placeCall
                ? "explicit_request"
                : decision.scheduleCall
                  ? "schedule_request"
                  : decision.cancelCall
                    ? "cancel_scheduled_call"
                    : decision.answerCallingQuestion
                      ? "asks_about_calling"
                      : decision.callWouldBenefit
                        ? "would_benefit"
                        : "none";

        const resolvedCallOffer = resolvedAs("call_offer");
        if (resolvedCallOffer?.item.ref?.kind === "call_offer") {
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_resolved', $2)`,
            [user.id, callAction],
          ).catch((err: any) => console.error("sendblue: call_offer_resolved memory write failed (non-fatal):", err?.message ?? err));

          if (callAction === "declines_offer" && resolvedCallOffer.item.ref.content) {
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_declined_topic', $2)`,
              [user.id, resolvedCallOffer.item.ref.content],
            ).catch((err: any) => console.error("sendblue: call_offer_declined_topic memory write failed (non-fatal):", err?.message ?? err));
          }
        }

        // Walk-in check-in answer. Captured directly rather than checking
        // hasActiveAsk: profile extraction only runs AFTER a reply is sent,
        // so hasActiveAsk would still read false for this exact message and
        // Co would ask the same question a second time.
        const walkinAnswer = resolvedAs("walkin_ask");
        if (walkinAnswer?.item.ref?.kind === "walkin_ask") {
          await recordWalkinAsk(walkinAnswer.item.ref.eventApiId, user.id, content).catch((err: any) =>
            console.error("sendblue: recordWalkinAsk failed (non-fatal):", err?.message ?? err),
          );
        }

        // Resolve the ask-first event/opportunity tease, if one's pending.
        // Only classifies when there's actually something pending — no
        // reason to spend a call checking on every message otherwise.
        // Folded into the SAME reply below via eventOfferContext, never a
        // second message — same reasoning as recommendationContext.
        const resolvedEventTease = resolvedAs("event_tease");
        if (resolvedEventTease?.item.ref?.kind === "event_tease") {
          const pendingEventOffer = resolvedEventTease.item.ref;
          try {
            const eventReplyAction = resolvedEventTease.value === "yes" ? "interested" : "not_interested";

            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'event_offer_resolved', $2)`,
              [user.id, eventReplyAction],
            ).catch((err: any) => console.error("sendblue: event_offer_resolved memory write failed (non-fatal):", err?.message ?? err));

            const parsed = JSON.parse(pendingEventOffer.content) as { askText: string; match: any };
            // Real details and a personal reason for the reveal (filled in on
            // demand for offers queued before details existed).
            const match: any = await enrichMatch(parsed.match, {
              firstName: user.first_name,
              askText: parsed.askText,
              goals: profile?.goals ?? null,
              city: profile?.city ?? null,
              feeling: renderEmotionalContext(emotional),
            });
            // Staleness check (Royce, 2026-08-30) — Tier 1/2 carry the
            // event's own date; if they said yes days after the tease and
            // the event's already passed, revealing it as if it's still
            // live would be misleading. Tier 3 opportunities have an
            // optional `deadline` (set only when the source post stated
            // one explicitly — see tieredRecommendation.ts's TierMatch)
            // checked the same way; a Tier 3 match with no stated deadline
            // (rolling admissions, or the post just didn't say) has
            // nothing to check here. Bug fix, 2026-08-30 (code review):
            // this used to only ever check event_date, so an expired Tier
            // 3 opportunity that had been sitting pending for days could
            // still get revealed as if the application window were open —
            // exactly what `deadline` was added to prevent, just not
            // wired into this reply-resolution path yet.
            // Date-only comparison, not a timestamp one (bug fix,
            // 2026-08-30) — event_date/deadline are bare YYYY-MM-DD with
            // no time component, so `new Date(x) < new Date()` treats ANY
            // time past midnight UTC on that day as already stale,
            // wrongly flagging a same-day evening event as "already
            // passed" hours before it happens. Comparing calendar dates
            // instead means today's date is never stale.
            const todayStr = new Date().toISOString().slice(0, 10);
            const relevantDate: string | undefined = match.event_date ?? match.deadline;
            const isStale = relevantDate && relevantDate < todayStr;
            if (eventReplyAction === "interested" && isStale) {
              const passedPhrase = match.event_date ? `it was on ${relevantDate}` : `the application window closed on ${relevantDate}`;
              addFact(replyFacts, "known", `The thing Co teased earlier already passed (${passedPhrase}).`);
              addInstruction(replyFacts, `They just said yes to hearing more about the thing you teased earlier, but it's already passed (${passedPhrase}). Let them know honestly that it's already happened so there's nothing to share, no pressure or apology needed. Never reveal the name "${match.name}" since there's nothing to act on now.`);
            } else if (eventReplyAction === "interested") {
              // Sent deterministically, not via agent tool-calling (Royce,
              // 2026-09-02, confirmed live on a DIFFERENT reveal path that
              // clumped a link mid-sentence into one paragraph) — same fix
              // applied here: the link goes out as its own bare message
              // (real iMessage preview) BEFORE the agent's reply, which
              // then only has to explain why it fits, never repeat the link.
              if (match.url) {
                await sendCoReply({ phone: user.phone_number, message: match.url, asVoice: false });
                await logTextExchange(user.id, `Co replied: ${match.url}`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                addFact(replyFacts, "did_this_turn", `Sent the link ${match.url} for "${match.name}" as its own message just before this reply.`);
              }
              addEventFacts(replyFacts, match);
              if (!match.whyItFits) addFact(replyFacts, "known", `Why "${match.name}" fits them: ${match.reason}`);
              addInstruction(replyFacts, `They just said yes to hearing more about the thing you teased earlier. Share why it fits now, naturally, as part of your reply: "${match.name}". Be honest it's a suggestion, not a guarantee it's right for them.${match.url ? " Don't repeat the link or say you're \"sending\" or \"sharing\" anything, it already went out." : " There's no link for it, so don't mention one."}`);
              // Outcome-learning loop (Royce, 2026-09-02) — schedule the
              // "who did you meet?" follow-up right at the moment real
              // details are actually revealed, same trigger point the
              // Figma board shows. No-op for Tier 3 (no event_date) — see
              // scheduleOutcomeFollowUp.
              scheduleOutcomeFollowUp(user.id, parsed.askText, match).catch((err: any) =>
                console.error("sendblue: scheduleOutcomeFollowUp failed (non-fatal):", err?.message ?? err),
              );
            } else {
              addInstruction(replyFacts, `They just passed on hearing more about the thing you teased earlier (internal only, never say this name to them: "${match.name}"). Acknowledge lightly, no pressure, don't explain what it was.`);
            }
          } catch (err: any) {
            console.error("sendblue: event offer reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Resolve the "who did you meet?" outcome follow-up, if one's
        // pending (Royce, 2026-09-02 — Notion V1 board rows 7/12/13, "Co
        // follows up" + shared classifier + signal weighting loop-back).
        // Same "only classify when something's actually pending, fold into
        // the SAME reply" reasoning as eventOfferContext above.
        const resolvedOutcome = resolvedAs("outcome_followup");
        if (resolvedOutcome?.item.ref?.kind === "outcome_followup") {
          try {
            const pendingOutcomeFollowUp = resolvedOutcome.item.ref.pending;
            const outcome = resolvedOutcome.value as "named_positive" | "named_critical" | "not_mentioned";
            await recordOutcome(user.id, pendingOutcomeFollowUp.id, pendingOutcomeFollowUp.tier, outcome);
            addFact(replyFacts, "did_this_turn", `Recorded what they said about how "${pendingOutcomeFollowUp.match_name}" went.`);
            // Stay-scoped clause (Royce, 2026-09-07, confirmed live) —
            // without this, a name or detail from a DIFFERENT,
            // already-resolved outcome follow-up sitting in
            // recentMemories (e.g. someone named a few messages ago
            // about an unrelated event) got blended into this reply as
            // if it belonged to the outcome actually being resolved here.
            const stayScoped = ` Keep this reply scoped to "${pendingOutcomeFollowUp.match_name}" specifically — don't pull in a name or detail from a different, already-resolved outcome or an unrelated recent memory, even if one is sitting in context.`;
            if (outcome === "named_positive") {
              addInstruction(replyFacts, `They just told you something good came out of "${pendingOutcomeFollowUp.match_name}" — someone worthwhile they met or a good outcome. Respond warmly to what they specifically shared, genuinely glad for them.${stayScoped}`);
            } else if (outcome === "named_critical") {
              addInstruction(replyFacts, `They just told you "${pendingOutcomeFollowUp.match_name}" wasn't worthwhile or didn't go well. Acknowledge that honestly and warmly, no forced positivity, no apologizing on behalf of the thing itself.${stayScoped}`);
            } else {
              addInstruction(replyFacts, `They answered about "${pendingOutcomeFollowUp.match_name}" but didn't name anyone specific or describe a real outcome. Acknowledge lightly, no pressure to elaborate.${stayScoped}`);
            }
          } catch (err: any) {
            console.error("sendblue: outcome follow-up reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Resolve the end-of-night check-in, if one's pending (Notion V1
        // board row 8 — sibling to the outcome follow-up above, but gated on
        // a real Luma check-in at one of Co's own curated events rather than
        // Co merely having recommended something). Same reuse-the-shared-
        // classifier, fold-into-the-same-reply reasoning throughout this file.
        const resolvedCheckin = resolvedAs("event_checkin");
        if (resolvedCheckin?.item.ref?.kind === "event_checkin") {
          try {
            const pendingCheckin = resolvedCheckin.item.ref.pending;
            const outcome = resolvedCheckin.value as "named_positive" | "named_critical" | "not_mentioned";
            await recordEventCheckinOutcome(user.id, pendingCheckin.id, pendingCheckin.event_api_id, outcome);
            addFact(replyFacts, "did_this_turn", `Recorded what they said about "${pendingCheckin.event_name}".`);
            // Same stay-scoped fix as the outcome follow-up above — a
            // name/detail from a different, already-resolved follow-up
            // could otherwise blend into this reply.
            const stayScoped = ` Keep this reply scoped to "${pendingCheckin.event_name}" specifically — don't pull in a name or detail from a different, already-resolved outcome or an unrelated recent memory, even if one is sitting in context.`;
            if (outcome === "named_positive") {
              addInstruction(replyFacts, `They just told you something good came out of "${pendingCheckin.event_name}" — someone worthwhile they met or a good moment from tonight. Respond warmly to what they specifically shared, genuinely glad for them.${stayScoped}`);
            } else if (outcome === "named_critical") {
              addInstruction(replyFacts, `They just told you "${pendingCheckin.event_name}" wasn't worthwhile or didn't go well. Acknowledge that honestly and warmly, no forced positivity, no apologizing on behalf of the event itself.${stayScoped}`);
            } else {
              addInstruction(replyFacts, `They answered about "${pendingCheckin.event_name}" but didn't name anyone specific or describe a real moment. Acknowledge lightly, no pressure to elaborate.${stayScoped}`);
            }
          } catch (err: any) {
            console.error("sendblue: event check-in reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Double opt-in event-guest handoff (Royce, 2026-09-07 — sibling to
        // the two blocks above, same shared-classifier/fold-into-the-same-
        // reply reasoning, but resolving a match nudge rather than an
        // outcome). See services/eventGuestMatchHandoff.ts for the actual
        // opt-in/reciprocal-ask/group-creation logic — this block only
        // classifies the reply and hands it off.
        const resolvedMatchNudge = resolvedAs("match_nudge");
        if (resolvedMatchNudge?.item.ref?.kind === "match_nudge") {
          try {
            const pendingMatchNudge = resolvedMatchNudge.item.ref.pending;
            const classification = resolvedMatchNudge.value === "yes" ? "interested" : "not_interested";
            await handleMatchNudgeReply(
              pendingMatchNudge.event_id,
              pendingMatchNudge.event_name,
              classification,
              { user_id: user.id, first_name: user.first_name, phone_number: user.phone_number, email: user.email },
              {
                user_id: pendingMatchNudge.candidate_id,
                first_name: pendingMatchNudge.candidate_first_name,
                phone_number: pendingMatchNudge.candidate_phone,
                email: pendingMatchNudge.candidate_email,
              },
            );
            if (classification === "interested") {
              addFact(replyFacts, "did_this_turn", `Recorded that they want to be connected with ${pendingMatchNudge.candidate_first_name}. No introduction has been made yet; it depends on ${pendingMatchNudge.candidate_first_name} saying yes too.`);
              addInstruction(replyFacts, `They just said yes to being connected with ${pendingMatchNudge.candidate_first_name}. Acknowledge it warmly and briefly. You may have already asked them a separate follow-up question about how they'd like to connect (text or email), or you're still waiting on ${pendingMatchNudge.candidate_first_name} to answer. Don't promise a specific thing is happening, and don't say what ${pendingMatchNudge.candidate_first_name} thinks or wants.`);
            } else {
              addFact(replyFacts, "did_this_turn", `Recorded that they passed on being connected with ${pendingMatchNudge.candidate_first_name}.`);
              addInstruction(replyFacts, `They just passed on being connected with ${pendingMatchNudge.candidate_first_name} (internal only, never say this name back to them as a pressure tactic). Acknowledge lightly, no pressure, don't explain further.`);
            }
          } catch (err: any) {
            console.error("sendblue: match nudge reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Network intro shortlist, redesigned (Royce, 2026-09-07: "how would
        // you implement the networking recommendation... if you just didn't
        // get fed this information but only know about my product purpose").
        // Two-stage reply, mirroring event-surfacing's tease-then-reveal
        // pattern instead of the old bundled 1-5-name shortlist: (1) a reply
        // to the nameless tease ("want to hear who?"), (2) a reply to the
        // reveal+ask ("it's Celine — want an intro?"). Only one of these two
        // is ever pending for a given person at a time, so — unlike the old
        // design — there's no multi-candidate disambiguation needed at all.
        const resolvedTease = resolvedAs("network_tease");
        if (resolvedTease?.item.ref?.kind === "network_tease") {
          try {
            const classification = resolvedTease.value === "yes" ? "interested" : "not_interested";
            const context = await resolveNetworkTeaseReply(user.id, user.first_name, user.phone_number, resolvedTease.item.ref.pending, classification);
            if (context) {
              addInstruction(replyFacts, context);
              if (classification === "interested") {
                addFact(replyFacts, "did_this_turn", `Sent a separate message just before this reply naming ${resolvedTease.item.ref.pending.candidate.first_name} and asking if they want an intro.`);
              }
            }
          } catch (err: any) {
            console.error("sendblue: network tease reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        const resolvedIntro = resolvedAs("network_intro");
        if (resolvedIntro?.item.ref?.kind === "network_intro") {
          try {
            const classification = resolvedIntro.value === "yes" ? "interested" : "not_interested";
            const context = await resolveNetworkIntroReply(
              { user_id: user.id, first_name: user.first_name, phone_number: user.phone_number, email: user.email },
              resolvedIntro.item.ref.pending,
              classification,
            );
            if (context) {
              addInstruction(replyFacts, context);
              const other = resolvedIntro.item.ref.pending.candidate.first_name;
              if (classification === "not_interested") addFact(replyFacts, "did_this_turn", `Recorded that they passed on an intro to ${other}.`);
              else if (/intro email/i.test(context)) addFact(replyFacts, "did_this_turn", `${other} had already said yes, so Co sent an intro email to both of them.`);
              else addFact(replyFacts, "did_this_turn", `Asked ${other} whether they're open to an intro. Waiting to hear back; no intro has been made. If ${other} says yes, Co emails an intro to both of them.`);
            }
          } catch (err: any) {
            console.error("sendblue: network intro-offer reply handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // Connection-method choice (phone vs email) once both sides have
        // opted in — see services/eventGuestMatchHandoff.ts. Separate
        // pending-check from the opt-in block above since it's a genuinely
        // different question asked at a later moment.
        const resolvedMethod = resolvedAs("method_choice");
        if (resolvedMethod?.item.ref?.kind === "method_choice") {
          try {
            const pendingMethodChoice = resolvedMethod.item.ref.pending;
            const methodClassification = resolvedMethod.value === "email" ? "email" : "phone";
            await handleMethodChoiceReply(pendingMethodChoice, methodClassification);
            const otherFirstName = pendingMethodChoice.a.user_id === user.id ? pendingMethodChoice.b.first_name : pendingMethodChoice.a.first_name;
            addFact(
              replyFacts,
              "did_this_turn",
              methodClassification === "phone" ? `Started a group text with them and ${otherFirstName}.` : `Sent an intro email to them and ${otherFirstName}.`,
            );
            addInstruction(replyFacts, `They just chose to be connected with ${otherFirstName} by ${methodClassification === "phone" ? "text" : "email"}. That's already handled separately. Acknowledge briefly, don't repeat details or promise a specific timing.`);
          } catch (err: any) {
            console.error("sendblue: method choice handling failed (non-fatal):", err?.message ?? err);
          }
        }

        // "Any updates?" reactive reply (Royce, 2026-08-31: "once someone
        // joins the test copatible account, if they ask 'any updates' or
        // something similar just send them that" — and, if nothing's been
        // posted yet, "make sure ... just say that" rather than leaving the
        // question unanswered). Decided by the router on every message with
        // text — it can't be gated on an update already existing, since "nothing new
        // right now" is itself a valid, honest answer this needs to give.
        // product_updates is written by scripts/notifyTesters.ts every
        // time a real update goes out, independent of who was on that
        // broadcast — this works for ANY co-test user, not just the named
        // testers the script itself texts.
        if (hasText && decision.asksForUpdates) {
          try {
            const latestUpdateResult = await pool.query(`SELECT content FROM product_updates ORDER BY created_at DESC LIMIT 1`);
            const latestUpdate = latestUpdateResult.rows[0];
            if (latestUpdate) {
              // Sent deterministically, not via agent tool-calling (Royce,
              // 2026-09-07, confirmed live) — asking the agent to relay
              // this "as part of your reply" let it paraphrase the bullets
              // despite being told not to, and blend in an unrelated past
              // recommendation from contextSummary as if it were part of
              // the same update. Sending the real content verbatim here
              // removes both failure modes; the agent only has to
              // acknowledge it, same pattern as recommendationContext/
              // eventOfferContext above.
              const updateMessage = `Here's what's new:\n\n${latestUpdate.content}`;
              await sendCoReply({ phone: user.phone_number, message: updateMessage, asVoice: false });
              await logTextExchange(user.id, `Co replied: ${updateMessage}`);
              addFact(replyFacts, "did_this_turn", "Sent the latest product update list as its own message just before this reply.");
              addInstruction(replyFacts, "They just asked what's new, and the real update list already went out separately, verbatim. Don't repeat, paraphrase, or re-list it, and don't blend in anything else (like a past recommendation) as if it were part of that list. If it's natural, briefly acknowledge you just sent it, then respond to whatever else they said. Keep this reply short.");
            } else {
              addFact(replyFacts, "known", "There are no product updates posted.");
              addInstruction(replyFacts, "They're asking what's new, but there's genuinely nothing posted yet. Let them know honestly, briefly, that there's nothing new to report right now. Don't invent something or brush past the question.");
            }
          } catch (err: any) {
            console.error("sendblue: asks-for-updates reply failed (non-fatal):", err?.message ?? err);
          }
        }

        const shouldTriggerCall = decision.placeCall;

        // Schedule-a-call — a specific future time, not "call me now"
        // (shouldTriggerCall above). Extracted as structured date/time/
        // timezone rather than asking the model to do timezone math itself
        // (unreliable) — luxon does the actual UTC conversion once all three
        // pieces are present. Nothing gets scheduled on a partial
        // extraction; the reply below asks for whatever's missing instead
        // of guessing a timezone, which would silently call someone at the
        // wrong time.
        if (callAction === "schedule_request") {
          try {
            const nowUtc = DateTime.now().toUTC();
            const { text: rawSchedule } = await generateText({
              model: anthropic(MODELS.haiku),
              experimental_telemetry: { isEnabled: true, functionId: "sendblue.scheduleCallExtract" },
              prompt: `A user is texting Co to schedule a call for later. The date, time, and timezone can be spread across several messages (e.g. they gave a time earlier and are only now confirming the date/timezone Co asked for) — read the whole conversation, not just the latest message, to piece it together.

Recent conversation, in order:
${recentConversation || "(start of the conversation)"}

Their latest message: "${resolvedContent}"

For resolving anything relative ("tomorrow", "next Tuesday"), the current UTC date/time is ${nowUtc.toFormat("cccc, LLLL d, yyyy 'at' HH:mm 'UTC'")}.

Extract, combining information from the whole conversation above:
- date: the requested date, as YYYY-MM-DD. null if not stated anywhere or genuinely ambiguous.
- time: the requested time of day, as 24-hour HH:MM. null if not stated anywhere.
- timezone: the IANA timezone name they stated or unambiguously implied (e.g. "America/New_York", "America/Los_Angeles", "America/Chicago", "America/Denver"). null if not stated and not clearly implied — never guess one.

Return ONLY valid JSON, no preamble: {"date": "YYYY-MM-DD or null", "time": "HH:MM or null", "timezone": "IANA name or null"}`,
            });

            const parsed = parseModelJson<{ date: string | null; time: string | null; timezone: string | null }>(rawSchedule);

            if (parsed.date && parsed.time && parsed.timezone) {
              const local = DateTime.fromISO(`${parsed.date}T${parsed.time}`, { zone: parsed.timezone });
              if (local.isValid && local.toUTC() > DateTime.utc()) {
                // A new successfully-scheduled call supersedes any earlier
                // one still pending, rather than both eventually firing —
                // asking again means instead of, not also. Only cancels
                // 'pending' rows; one already claimed/'processing' by the
                // cron is left alone rather than raced.
                const superseded = await pool.query(
                  `UPDATE scheduled_calls SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
                  [user.id],
                );
                await pool.query(
                  `INSERT INTO scheduled_calls (user_id, requested_text, timezone, scheduled_for) VALUES ($1, $2, $3, $4)`,
                  [user.id, resolvedContent, parsed.timezone, local.toUTC().toISO()],
                );
                const formattedTime = local.toFormat("cccc, LLLL d 'at' h:mm a");
                addFact(
                  replyFacts,
                  "did_this_turn",
                  `${superseded.rows.length ? "Rescheduled their call (replacing the earlier booking)" : "Scheduled a call"} for ${formattedTime} (${parsed.timezone}). Co will call them then.`,
                );
                addInstruction(
                  replyFacts,
                  superseded.rows.length
                    ? `They just rescheduled. Confirm the NEW time (${formattedTime}, ${parsed.timezone}) back to them naturally, making clear this is a change from before, not a new addition. Do not place a call now, it's scheduled for later.`
                    : `They just scheduled a call for ${formattedTime} (${parsed.timezone}). Confirm that back to them naturally, referencing the actual day and time so they know it landed correctly. Do not place a call now, it's scheduled for later.`,
                );
              } else {
                addFact(replyFacts, "did_this_turn", `No call was scheduled: the time they gave (${parsed.date} ${parsed.time}, ${parsed.timezone}) is invalid or already past.`);
                addInstruction(replyFacts, "They tried to schedule a call, but the time they gave is invalid or already in the past. Let them know naturally and ask for a time that hasn't passed yet. Do not place a call now.");
              }
            } else {
              const missing = [!parsed.date && "the date", !parsed.time && "the time", !parsed.timezone && "their timezone"]
                .filter(Boolean)
                .join(" and ");
              addFact(replyFacts, "did_this_turn", `No call was scheduled yet: still missing ${missing}.`);
              addInstruction(replyFacts, `They want to schedule a call for later but haven't given ${missing} yet. Ask for exactly that, specifically. Never guess or assume a timezone. Do not place a call now.`);
            }
          } catch (err: any) {
            console.error("sendblue: schedule_request extraction failed (non-fatal):", err?.message ?? err);
            addFact(replyFacts, "did_this_turn", "No call was scheduled: Co couldn't work out the time they meant.");
            addInstruction(replyFacts, "They want to schedule a call for a specific time but something went wrong figuring out when. Ask them to state the day, time, and their timezone clearly. Do not place a call now.");
          }
        } else if (callAction === "cancel_scheduled_call") {
          // No new time to extract here — just clear whatever's pending.
          // Only touches 'pending' rows, same reasoning as the supersede
          // logic above: one already claimed/'processing' by the cron is
          // left alone rather than raced with a cancel.
          try {
            const cancelled = await pool.query(
              `UPDATE scheduled_calls SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
              [user.id],
            );
            addFact(replyFacts, "did_this_turn", cancelled.rows.length ? "Cancelled their scheduled call." : "They asked to cancel a call, but nothing was scheduled.");
            addInstruction(
              replyFacts,
              cancelled.rows.length
                ? "They just cancelled their scheduled call. Confirm that naturally. Do not place a call now."
                : "They're trying to cancel a scheduled call, but nothing is actually scheduled right now. Let them know that naturally, there's nothing to cancel. Do not place a call now.",
            );
          } catch (err: any) {
            console.error("sendblue: cancel_scheduled_call failed (non-fatal):", err?.message ?? err);
            addFact(replyFacts, "did_this_turn", "Trying to cancel their scheduled call failed; it may still be scheduled.");
            addInstruction(replyFacts, "They want to cancel a scheduled call but cancelling it failed. Tell them it didn't go through and ask them to try again in a minute. Don't promise you'll fix it. Do not place a call now.");
          }
        }

        // They asked a plain question about the calling feature — answer it
        // truthfully, don't place a call and don't pretend one is
        // happening. Without this, the classifier alone isn't a strong
        // enough signal on its own to stop the reply from improvising
        // "calling you now" language, and separately, this question being
        // misread as explicit_request would place real outbound Twilio
        // calls to people who were just asking how the feature works.
        if (callAction === "asks_about_calling") {
          addInstruction(replyFacts, `They just asked a plain question about how calling works — answer it directly and honestly, don't place a call, and don't say or imply a call is happening. The true answer: Co can call them — by text right now ("call me") or scheduled for later — and that's real and live. They can also call Co directly anytime, from this exact number — that connects to a real, live conversation with Co. Refer to it only as "this number" or "this exact number," never write out or guess actual digits — you are not given the real number here, and a specific-looking one you invent will be wrong and won't work. Only mention this second part if it's actually what they're asking about; don't volunteer it unprompted.`);
        }

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

        // Real gap found live, 2026-09-14 (Royce: "Call me" got back "This
        // is text, I can't actually call" — false; Co genuinely can and the
        // classifier correctly recognized the request, but the actual dial
        // attempt failed and the fallthrough reply below had zero context
        // about what happened, so the model invented its own — wrong —
        // explanation). Same fix shape as callFeatureQuestionContext below:
        // ground the reply in the real reason instead of leaving the model
        // to guess why nothing happened.
        if (shouldTriggerCall) {
          const callResult = await triggerCallForUser(user.id, io, { kind: "router_decision" });
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
          const alreadyInProgress = callResult.error === "A call is already in progress for this user.";
          addFact(
            replyFacts,
            "did_this_turn",
            alreadyInProgress
              ? "Tried to call them just now; it didn't go through because a call already shows as in progress for them."
              : "Tried to call them just now; the call attempt failed. The reason isn't known.",
          );
          addInstruction(
            replyFacts,
            alreadyInProgress
              ? `They just asked you to call them, and Co genuinely can (this is real and live) — but a call attempt just failed because a call is already showing as in progress for them. Be honest that something's not letting the call go through right now and you're not sure why, rather than saying calling isn't possible at all. Don't place a call, and don't say "calling you now."`
              : `They just asked you to call them, and Co genuinely can (this is real and live) — but the call attempt just failed. Be honest that something went wrong placing it, without inventing a specific reason you don't actually have, and never claim calling isn't possible. Don't place a call, and don't say "calling you now."`,
          );
        }

        // Two independent reasons Co might fold in a secondary call-offer
        // gesture: content-driven (would_benefit, from the classifier above)
        // or channel-driven — someone with no profile yet, on their first
        // real message, regardless of what that message actually is (a real
        // voice call produces a far richer initial profile than short texts
        // ever will). Fires at most once per person (isFirstRealMessage is
        // only ever true for message #1). Eligibility (this signal +
        // hasPendingOffer/recentOfferBurstActive as hard gates) is now
        // weighed by the reply agent below, not pre-decided here — see
        // agent/conversationReply.ts.
        const isThinProfileFirstMessage = !hasProfile && isFirstRealMessage && callAction === "none";

        // Real action-triggering — mirrors the surface_recommendation Hume
        // tool on the voice path, but iMessage has no tool_call plane to
        // invoke it through, so this is a direct call to the same shared
        // generateRecommendation() gated by the router's wantsRecommendation
        // instead. Folded into the one reply below (never sent as a second
        // message).
        try {
          // Emotion loop: someone who's struggling and just wants to be heard
          // doesn't get an event or opportunity pitched in the same reply.
          const holdRecommendationForFeelings = emotional.needsCare && seekingMode !== "solving";
          if (holdRecommendationForFeelings && decision.wantsRecommendation) {
            addInstruction(replyFacts, "They asked for a suggestion, but they've been struggling. Respond to how they're doing first; offer to look for something once they want it, without naming anything now.");
          }
          if (decision.wantsRecommendation && !holdRecommendationForFeelings) {
            const recommendation = await generateRecommendation(user.id, resolvedContent);
            if (recommendation.available && recommendation.matches?.length) {
              // Sent DETERMINISTICALLY, not via agent tool-calling (Royce,
              // 2026-09-02, confirmed live) — the previous version asked the
              // conversational agent to execute a multi-step sendReply
              // sequence (link, then description, per match) via prose
              // instructions in its system prompt. Real failure: with two
              // matches AND another context block (updatesContext) active in
              // the same turn, the model correctly sent the first match's
              // link, then gave up on the sequence and crammed the second
              // match's description, its MISSING link, and the unrelated
              // updates content into one giant paragraph — "too wordy and
              // it didn't even send the link for the accelerator." Relying
              // on an LLM to perfectly execute 4+ sequential tool calls
              // while also juggling other simultaneous context isn't
              // reliable enough for something this mechanical. Sending the
              // link and description directly here removes that failure
              // mode entirely — same sendCoReply/logTextExchange helpers
              // and 2s pacing convention conversationTools.ts's sendReply
              // already uses for a real second message.
              for (const m of recommendation.matches) {
                if ("url" in m && m.url) {
                  await sendCoReply({ phone: user.phone_number, message: m.url, asVoice: false });
                  await logTextExchange(user.id, `Co replied: ${m.url}`);
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                }
                // Drafted in Co's voice from the real record and a personal
                // reason, not the matching engine's raw "name — reason" line.
                const em = await enrichMatch(m, {
                  firstName: user.first_name,
                  askText: resolvedContent,
                  goals: profile?.goals ?? null,
                  city: profile?.city ?? null,
                  feeling: renderEmotionalContext(emotional),
                });
                let description = `${m.name}. ${em.whyItFits ?? m.reason}`;
                try {
                  const record = em.details ? renderEventDetails(em.name, em.details).join("\n") : em.opportunity ? `What the post says: ${em.opportunity.postText}` : "";
                  const { text: drafted } = await generateText({
                    model: anthropic(MODELS.sonnet),
                    experimental_telemetry: { isEnabled: true, functionId: "sendblue.recommendation.describe" },
                    prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're telling ${user.first_name ?? "them"} about "${m.name}"${"url" in m && m.url ? ". You sent the link a moment ago; this message goes right under it" : ""}.\n\nWhy it fits them: ${em.whyItFits ?? m.reason}\n${record ? `\nWhat's actually known about it:\n${record}\n` : ""}\nWrite 1-3 sentences naming it, the one or two details that matter most to them (when, where, who), and why it fits, in your own words. Only use what's written above. No link. Return ONLY the message.`,
                  });
                  if (drafted.trim()) description = cleanCoMessage(drafted.trim());
                } catch (err: any) {
                  console.error("sendblue: recommendation description drafting failed (non-fatal, sending plain):", err?.message ?? err);
                }
                await sendCoReply({ phone: user.phone_number, message: description, asVoice: isVoice });
                await logTextExchange(user.id, `Co replied: ${description}`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                addFact(
                  replyFacts,
                  "did_this_turn",
                  `Sent "${m.name}"${"url" in m && m.url ? ` (link ${m.url})` : " (no link)"} as separate messages just before this reply: "${description}"`,
                );
              }
              // The agent still runs after this (see below) to genuinely
              // respond to what they said — this just tells it the
              // recommendation itself already went out, so it doesn't
              // repeat the details or the link.
              addInstruction(replyFacts, `You already sent them ${recommendation.matches.length > 1 ? "a couple of real things" : "something real"} you thought of, separately from this reply. Don't repeat the name, link, or details in this reply. If it's natural, you can briefly acknowledge you just sent those, but keep this reply focused on genuinely responding to what they just said.`);
            } else if (recommendation.available) {
              // Generic fallback path (no tiered match found) — a
              // category/type suggestion, never a specific real venue with
              // a link, since there's genuinely nothing to link to here.
              addFact(replyFacts, "known", `An idea to suggest (a type of thing, not a specific place, and there's no link): "${recommendation.match}". Why: ${recommendation.reason}`);
              addInstruction(replyFacts, `You just thought of a real recommendation for them: "${recommendation.match}". Work this into your reply naturally, as your own suggestion. This is an idea, not a specific place with a link — never say you're "sending" or "sharing" anything for this, you have nothing to send. Never name a specific real company, program, or organization as an example (e.g. "YC", "On Deck") unless that exact name is literally what's written in "${recommendation.match}" above — if the match itself is generic, describe only the general type of thing, don't dress it up with real names you're not actually sure fit.`);
            }
          }
        } catch (err: any) {
          console.error("sendblue: recommendation failed (non-fatal):", err?.message ?? err);
        }

        // Real venue lookup — distinct from the abstract recommendation
        // above. When someone mentions wanting a specific CATEGORY of place
        // (a gym, a cafe, a climbing spot), search Google Places for real,
        // and send an actual Google Maps link — not a description of what
        // Co would send. Needs a known city to search against; silently
        // skipped if none is on file yet rather than guessing one.
        let venueDeliveryMessage: string | null = null;
        if (profile?.city) {
          try {
            if (decision.venue) {
              const venueType: string = decision.venue.type;
              const requestedCount = decision.venue.count;

              // The real Places search below has genuine network latency on
              // top of the classification calls already run this turn —
              // send a real, personalized acknowledgment now, before the
              // search, then deliver the actual result as the reply below —
              // never claim delivery before there's something real to
              // deliver.
              try {
                const { text: rawHold } = await propagateAttributes(
                  { userId: user.id, traceName: "sendblue.venueRequest.holdMessage" },
                  () =>
                    generateText({
                      model: anthropic(MODELS.haiku),
                      experimental_telemetry: { isEnabled: true, functionId: "sendblue.venueRequest.holdMessage" },
                      prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} They just asked about finding ${requestedCount > 1 ? `${requestedCount} ${venueType}s` : `a ${venueType}`}. You're about to go actually look them up for them — send a brief "give me a sec" acknowledgment that names what they're looking for (the ${venueType}), not generic. Normal capitalization. Don't claim you've found anything yet. One short sentence. No em dashes. Under 100 characters.`,
                    }),
                );
                const trimmedHold = rawHold.trim().slice(0, 100);
                const holdMessage = trimmedHold.charAt(0).toUpperCase() + trimmedHold.slice(1);
                await logTextExchange(user.id, `Co replied: ${holdMessage}`);
                try {
                  await sendblue.messages.send({
                    number,
                    content: holdMessage,
                    from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                  });
                } catch (smsErr: any) {
                  console.error(`Sendblue venue-lookup hold message failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
                }
              } catch (err: any) {
                console.error("sendblue: venue hold-message generation failed (non-fatal, proceeding to search anyway):", err?.message ?? err);
              }

              const venues = await findRealVenues(venueType, profile.city, requestedCount);
              if (venues.length) {
                // Sent as its own dedicated, complete message instead of
                // folded into the general reply — a list of real, named
                // things needs the room to actually say all of them.
                try {
                  const { text: rawIntro } = await propagateAttributes(
                    { userId: user.id, traceName: "sendblue.venueRequest.introMessage" },
                    () =>
                      generateText({
                        model: anthropic(MODELS.haiku),
                        experimental_telemetry: { isEnabled: true, functionId: "sendblue.venueRequest.introMessage" },
                        prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You just found ${venues.length} real ${venueType}${venues.length > 1 ? "s" : ""} for them${venues.length < requestedCount ? ` — they asked for ${requestedCount}, this is genuinely all that came back as a solid match, say so honestly` : ""}. Write ONE short, warm intro sentence to go right before a list (the list itself follows separately after your sentence — do not write the list yourself, do not include any links). No em dashes. Under 150 characters.`,
                      }),
                  );
                  const introLine = rawIntro.trim().slice(0, 150);
                  const listBlock = venues.map((v) => `${v.name} — ${v.mapsUrl}`).join("\n\n");
                  venueDeliveryMessage = `${introLine}\n\n${listBlock}`;
                } catch (err: any) {
                  console.error("sendblue: venue delivery intro generation failed (non-fatal, sending list plainly):", err?.message ?? err);
                  venueDeliveryMessage = venues.map((v) => `${v.name} — ${v.mapsUrl}`).join("\n\n");
                }
                {
                  const venueMemoryContent = `Co surfaced ${venues.length} real venue(s) — ${venues.map((v) => `${v.name} (${v.address}): ${v.mapsUrl}`).join("; ")}`;
                  await pool
                    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2) RETURNING id`, [
                      user.id,
                      venueMemoryContent,
                    ])
                    .then((mem) =>
                      generateEmbedding(venueMemoryContent)
                        .then((emb) =>
                          pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
                            `[${emb.join(",")}]`,
                            mem.rows[0].id,
                          ]),
                        )
                        .catch((err) => console.error("Venue memory embedding failed (non-fatal):", err)),
                    )
                    .catch((err: any) => console.error("sendblue: venue memory write failed (non-fatal):", err?.message ?? err));
                }
              } else {
                // Must not repeat the "claimed to deliver, delivered
                // nothing" failure — if the search genuinely came up empty,
                // the reply has to say so honestly, not go quiet or invent
                // a name.
                addFact(replyFacts, "did_this_turn", `Searched for a real ${venueType} near them and found no solid match.`);
                addInstruction(replyFacts, `You looked for a real ${venueType} but didn't find a solid match nearby. Say so honestly in your reply. Don't invent a name or pretend you found one.`);
              }
            }
          } catch (err: any) {
            console.error("sendblue: venue lookup classification failed (non-fatal):", err?.message ?? err);
          }
        }

        // Step 4.7 — Debounce the free-form reply only. Every deterministic
        // branch above this point (identity intake, OTP, call-trigger) has
        // already returned by now — those are typically single-word confirmations
        // where added latency has no upside, and some (OTP, call-triggering)
        // are actively time-sensitive, so they're deliberately never
        // delayed. Only the conversational reply below is worth waiting on,
        // since it's the one case where replying to a still-incomplete
        // thought reads as Co cutting the user off. myInboundAt is set in
        // the outer handler, before withPhoneLock, precisely so this check
        // can see a message that arrived and is now queued behind this
        // request's phone lock (see the comment there for why).
        // Ack Sendblue's webhook now, before the debounce wait and reply
        // generation below — both can legitimately take longer than
        // Sendblue's own webhook response timeout (~10s observed live).
        // Letting that timeout happen made Sendblue retry the same
        // delivery, and each retry re-ran this entire expensive path from
        // scratch — confirmed live, one inbound text produced ~5 separate
        // replies. The actual reply still goes out via sendCoReply's real
        // Sendblue send call further down, completely independent of this
        // response; this only stops Sendblue from thinking the delivery
        // itself failed. withPhoneLock below is unaffected — it still wraps
        // this whole function and still serializes same-phone processing
        // exactly as before, this just responds to the webhook earlier.
        res.status(200).send({ received: true, action: "processing" });

        if (myInboundAt) {
          await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
          const latestStampResult = await pool.query(
            `SELECT last_inbound_at FROM phone_debounce WHERE phone = $1`,
            [number],
          );
          const latestInboundAt = latestStampResult.rows[0]?.last_inbound_at ?? null;
          if (latestInboundAt && new Date(latestInboundAt).getTime() > new Date(myInboundAt).getTime()) {
            // A newer message arrived while this one waited. This
            // message's own content is already safely stored in
            // co_memories (Step 3, above), so the newer message's request
            // — next in line behind this one's phone lock — will see it as
            // conversational context and can respond to both at once. This
            // request bails out without generating or sending anything, so
            // the user doesn't get two overlapping replies. (Webhook already
            // ack'd above, nothing left to send back here.)
            return;
          }
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
        // Filtered for genuine relevance to what they just said before the
        // reply agent ever sees it — see filterRelevantMemories in
        // conversationReply.ts. Vector similarity alone isn't enough of a
        // relevance signal to hand this to the model as foreground context;
        // this is what makes it safe to do so.
        const rawMemoryCandidates = memoriesResult.rows.map((m: any) => m.content).filter(Boolean);
        const recentMemories = rawMemoryCandidates.length
          ? await filterRelevantMemories(resolvedContent, rawMemoryCandidates)
          : "";

        // Co Loop Stage 1 — same coverage-nudge logic the Stage 5 check-in
        // cron uses (jobs/index.ts), shared via profileExtraction.ts's
        // getCoverageNudge so a text-only relationship also works toward
        // RAPPORT_TOPICS instead of only ever reactively answering whatever
        // comes up — matches co-test/src/routes/webhooks.ts's already-proven
        // approach for this. Persisted topics_covered/topics_asked (read as
        // part of `profile` above) mean a topic answered on a prior call or
        // text doesn't get re-judged or re-asked here.
        const { missingTopic } = await getCoverageNudge(user.id, recentConversation, profile);


        // Not gated like the reply-agent's secondary gestures above — this
        // isn't a competing "extra ask" for the reply's one secondary slot,
        // it's an instruction about HOW to say whatever Co was already going
        // to say. Advisory only (see harness/emotion.ts) and never named back to
        // the user — a good friend responds differently to someone who's
        // upset, they don't announce "you sound upset."
        const toneContext = renderEmotionalContext(emotional);

        // Advisory only, same reasoning as toneContext above — reading a
        // shift the person never actually asked you to notice, not a rule.
        const seekingModeContext =
          seekingMode === "solving"
            ? `They've moved from sharing into wanting a real answer or help deciding — meet that directly. Give them your actual read, grounded in what you know about them, instead of another reflective question or a line that waits for them to ask first.`
            : "";

        let coReply: string;
        if (venueDeliveryMessage) {
          // A venue list already went out as its own dedicated message above
          // — that IS the response to what they asked for. Running the
          // general persona reply on top of it would mean a 3rd message
          // every time (hold + list + generic reply).
          coReply = venueDeliveryMessage;
          await logTextExchange(user.id, `Co replied: ${venueDeliveryMessage}`);
          try {
            await sendblue.messages.send({
              number,
              content: venueDeliveryMessage,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (smsErr: any) {
            console.error(`Sendblue venue delivery send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
          }
        } else {
          // Same persona the real call uses, not a separate thinner one —
          // Co should be the same entity whether someone's talking by voice
          // or text. contextSummary reuses buildContextSummary (the exact
          // same "what Co knows about this person" builder the call channel
          // uses for its own {{context_summary}} fill), so both channels
          // stay genuinely in sync rather than each maintaining their own
          // summary of the same underlying profile.
          const contextSummary = await buildContextSummary(user.id);
          const personaPrompt = await renderCoPersonaPrompt(user.first_name, contextSummary);

          // Step 6 — Decide + send Co's reply via the conversation-reply
          // agent (agent/conversationReply.ts). Replaces the old fixed
          // callOfferContext/topicContext branching and the separate
          // post-hoc callOfferCheck verification call — the agent now
          // decides whether to fold in a call-offer/topic-nudge gesture and
          // records that decision itself via tool calls
          // (offerCall/markTopicAsked), rather than code pre-deciding and a
          // second LLM call inferring after the fact whether the drafted
          // text happened to include one.
          const { replyText } = await propagateAttributes(
            { userId: user.id, traceName: "sendblue.generateReply" },
            () =>
              runConversationReplyAgent({
                userId: user.id,
                phoneNumber: user.phone_number,
                firstName: user.first_name,
                resolvedContent,
                isVoice,
                imageForVision,
                hasPendingOffer,
                recentOfferBurstActive,
                callAction,
                isThinProfileFirstMessage,
                isFirstContact: isFirstRealMessage,
                missingTopic,
                missingTopicDescription: missingTopic ? RAPPORT_TOPIC_DESCRIPTIONS[missingTopic] : null,
                facts: replyFacts,
                toneContext,
                seekingModeContext,
                styleHint,
                recentConversation,
                recentMemories,
                contextSummary,
                personaPrompt,
                sendCoReply,
              }),
          );
          coReply = replyText;
        }

        // Fire-and-forget, same real pipeline a call uses (extractPsychographicProfile
        // + storeProfile + captureIntent), fed the accumulated text thread instead of
        // a call transcript — matches production's post-call pipeline, ported here
        // since this previously had only a thin 4-field patch (life_chapters/
        // emotional_state/goals/blockers) that couldn't create a profile row at all
        // and never touched intent, so a text-only user's stated ask never reached
        // co_profiles.intent for matching to use.
        const textTranscript = `${recentConversation}\nuser: ${resolvedContent}\nassistant: ${coReply}`.trim();
        extractPsychographicProfile(textTranscript)
          .then(({ extracted }) => storeProfile(user.id, extracted, textTranscript))
          .catch((err: any) => console.error("sendblue: text-based profile extraction failed (non-fatal):", err?.message ?? err));
        captureIntent(user.id, textTranscript).catch((err: any) =>
          console.error("sendblue: text-based intent capture failed (non-fatal):", err?.message ?? err),
        );
        extractPlannedEventMention(user.id, textTranscript).catch((err: any) =>
          console.error("sendblue: text-based event-mention capture failed (non-fatal):", err?.message ?? err),
        );

        io.to(`user:${user.id}`).emit("co:message", { message: coReply });

        // Webhook already ack'd early, above — nothing left to send back.
        return;
      } catch (error) {
        // If the early ack above already went out, the response is done —
        // next(error) would try to send a second response and throw
        // ERR_HTTP_HEADERS_SENT. Only fall through to the normal error
        // path for a failure that happened before that ack.
        if (res.headersSent) {
          console.error("sendblue: error after early webhook ack (non-fatal, already ack'd):", (error as any)?.message ?? error);
          return;
        }
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
