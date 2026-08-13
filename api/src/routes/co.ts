import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { sendEmail } from "../otpActions.js";
import { authenticateToken, userRole } from "../middleware/auth.js";
import { buildContextSummary } from "../services/callContext.js";
import { generateEmbedding, generateGoalEmbedding } from "../services/embeddings.js";
import { findBestCircle, findBestCircleWithScore, min_group_score } from "../services/matching.js";
import { findBestVenue } from "../services/places.js";
import { activateCircle, notifyModeratorOfPendingCircle } from "../services/circleApproval.js";
import { LOW_CONFIDENCE_VENUE_FIT_SCORE, requestVenueApprovalFromModerator } from "../services/booking.js";
import { generateCandidateWindows, type CandidateWindow } from "../services/scheduling.js";
import {
  assessConversationCoverage,
  captureIntent,
  extractPsychographicProfile,
  RAPPORT_TOPICS,
  storeProfile,
} from "../services/profileExtraction.js";
import { generateRecommendation } from "../services/recommendation.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import sendblue from "../services/sendblue.js";
import { generateVoiceNote } from "../services/voiceNote.js";

// io is injected by the server so call-status and webhook handlers can push
// real-time state transitions to the connected mobile client.
let _io: IOServer | null = null;
export function createCoRouter(io: IOServer) {
  _io = io;
  return router;
}

const router = express.Router();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

// Reject status callbacks that didn't come from Twilio. TWILIO_AUTH is this
// account's real Auth Token (one Twilio account — TWILIO_ACCOUNT_SID is
// actually an API Key SID used for authenticating outbound requests to
// Twilio's API, a separate credential from this; TWILIO_LIVE_SID is the real
// Account SID). Renamed from TWILIO_AUTH_TOKEN to match what's actually set
// in Railway — confirmed live against Twilio's own API (200 on a direct
// Basic Auth test) before this rename.
function validateTwilioSignature(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const sig = req.headers["x-twilio-signature"] as string | undefined;
  if (!sig) return false;
  const url = `${process.env.API_URL}/co/call-status`;
  return twilio.validateRequest(process.env.TWILIO_AUTH!, sig, url, req.body);
}

// Reject webhook calls that didn't come from Hume. Hume signs each webhook
// with a dedicated webhook signing key (separate from the API key, generated
// on Hume's Developers page, set here as HUME_SIGNIN_KEY) — the signature is
// HMAC-SHA256 over the exact string "${rawBody}.${timestamp}", hex-encoded,
// sent as X-Hume-AI-Webhook-Signature, with the timestamp itself sent as
// X-Hume-AI-Webhook-Timestamp (rejected if older than 180s, to block
// replay). Confirmed against Hume's own docs and their official verification
// example — the previous version of this function checked a different
// header entirely and compared it directly against the secret, which could
// never match anything Hume actually sends. Requires req.body to be the raw
// Buffer for this route (see server.ts's express.raw() on /co/webhook,
// mirroring the Stripe webhook's same need).
function validateHumeWebhook(req: Request): boolean {
  const secret = process.env.HUME_SIGNIN_KEY;
  if (!secret) return true; // skip when not configured (dev)

  const signature = req.headers["x-hume-ai-webhook-signature"] as string | undefined;
  const timestamp = req.headers["x-hume-ai-webhook-timestamp"] as string | undefined;
  if (!signature || !timestamp) return false;

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 180_000) return false;

  const rawBody = (req.body as Buffer).toString("utf-8");
  const expected = crypto.createHmac("sha256", secret).update(`${rawBody}.${timestamp}`).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Hume's chat_ended webhook only carries IDs (chat_id, chat_group_id,
// custom_session_id, end_reason, duration_seconds) — no transcript, no
// emotions, no recording. The actual conversation has to be pulled separately
// from the Chat Events API before anything can be extracted.
type HumeChatEvent = {
  role: string;
  type: string;
  message_text: string | null;
  emotion_features: string | null;
};

async function fetchHumeChatEvents(chatId: string): Promise<HumeChatEvent[]> {
  const events: HumeChatEvent[] = [];
  let page = 0;
  for (;;) {
    const res = await fetch(
      `https://api.hume.ai/v0/evi/chats/${chatId}?page_size=100&page_number=${page}`,
      { headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY! } },
    );
    if (!res.ok) throw new Error(`Hume chat-events fetch failed: ${res.status}`);
    const data: any = await res.json();
    events.push(...(data.events_page ?? []));
    if (page + 1 >= (data.total_pages ?? 1)) break;
    page += 1;
  }
  return events;
}

async function fetchHumeCallData(
  chatId: string,
): Promise<{ transcript: string; emotions: { name: string; score: number }[] | null }> {
  const events = await fetchHumeChatEvents(chatId);

  const transcript = events
    .filter((e) => e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE")
    .map((e) => `${e.role === "USER" ? "user" : "assistant"}: ${e.message_text ?? ""}`)
    .join("\n");

  const userEmotionSets = events
    .filter((e) => e.type === "USER_MESSAGE" && e.emotion_features)
    .map((e) => JSON.parse(e.emotion_features!) as Record<string, number>);

  let emotions: { name: string; score: number }[] | null = null;
  if (userEmotionSets.length > 0) {
    const totals = new Map<string, number>();
    for (const set of userEmotionSets) {
      for (const [name, score] of Object.entries(set)) {
        totals.set(name, (totals.get(name) ?? 0) + score);
      }
    }
    emotions = [...totals.entries()]
      .map(([name, sum]) => ({ name, score: sum / userEmotionSets.length }))
      .sort((a, b) => b.score - a.score);
  }

  return { transcript, emotions };
}

// Best-effort — Hume's audio reconstruction is an async job that may not be
// COMPLETE yet by the time chat_ended fires. A miss here just means no
// recording_url gets stored, same as today.
async function fetchHumeRecordingUrl(chatId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.hume.ai/v0/evi/chats/${chatId}/audio`, {
      headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY! },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.status === "COMPLETE" ? (data.signed_audio_url ?? null) : null;
  } catch {
    return null;
  }
}

// Shared by both the standard missed-call path (no-answer/busy/failed/
// canceled) and the voicemail-detected path — Claude drafts the copy,
// ElevenLabs is the "heavy worker" that turns it into a voice note (Hume is
// only ever used for the live call itself), falling back to plain text if
// voice generation fails so this never blocks the follow-up from sending.
async function sendMissedCallFollowUp(
  user: { id: string; first_name: string; phone_number: string },
  CallSid: string,
  CallStatus: string,
  situationPrompt: string,
): Promise<void> {
  let coMessage: string;
  try {
    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `You are Co, an exclusive life concierge. ${situationPrompt} Send a short iMessage letting ${user.first_name} know, and that they can reply here whenever they're ready or expect another call soon. Tone: calm, unhurried, like a private members club. No exclamation points. No em dashes. 2 sentences max.`,
    });
    coMessage = result.text;
  } catch (aiErr) {
    console.error("Co follow-up message generation failed, using fallback:", aiErr);
    coMessage = `Hey ${user.first_name}, Co tried to reach you. Reply here whenever you're ready, or expect another call soon.`;
  }

  let audioUrl: string | null = null;
  try {
    audioUrl = await generateVoiceNote(coMessage);
  } catch (voiceErr: any) {
    console.error("Voice note generation failed, falling back to text:", voiceErr?.message ?? voiceErr);
  }

  try {
    await sendblue.messages.send({
      number: user.phone_number,
      content: audioUrl ? "" : coMessage,
      ...(audioUrl ? { media_url: audioUrl } : {}),
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (smsErr: any) {
    console.error(`call-status: Sendblue failed for ${user.id}:`, smsErr?.message ?? smsErr);
  }

  const memContent = `Co called ${user.first_name} — ${CallStatus} (${CallSid}). Followed up via iMessage: "${coMessage}"`;
  const mem = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2) RETURNING id`,
    [user.id, memContent],
  );
  generateEmbedding(memContent)
    .then((emb) =>
      pool.query(
        `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
        [`[${emb.join(",")}]`, mem.rows[0].id],
      ),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
}

// POST /co/call/:user_id — initiate outbound call to user
router.post(
  "/call/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;

      if (req.user?.id !== user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      // Actual dial/bridge logic lives in services/callTrigger.ts now — a
      // second call site (Co triggering a call from within a texting
      // conversation, see sendblue.ts's call-offer handling) needs the exact
      // same behavior (AMD, media-stream bridge, call_sid stamping), not a
      // slimmer, divergent copy.
      const result = await triggerCallForUser(user_id, _io);
      if (!result.success) {
        const status = result.error === "User not found." ? 404 : 403;
        return res.status(status).send(result.error);
      }

      return res.status(200).send({
        success: true,
        call_sid: result.call_sid,
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/call-status — Twilio status callback, fires when call reaches terminal state
// Handles missed calls (no-answer, busy, failed, canceled) and voicemail
// pickups (via AnsweredBy from AMD) by sending a Co iMessage follow-up.
router.post(
  "/call-status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateTwilioSignature(req)) {
        return res.status(401).send("Invalid Twilio signature.");
      }

      const { CallStatus, To, CallSid, AnsweredBy } = req.body;

      // Validate Twilio sent the required fields
      if (!CallStatus || !To) {
        console.error("call-status webhook missing CallStatus or To:", req.body);
        return res.sendStatus(204);
      }

      const userResult = await pool.query(
        `SELECT id, first_name, phone_number FROM users WHERE phone_number = $1`,
        [To],
      );
      const user = userResult.rows[0];

      // AMD detected an answering machine/voicemail — this arrives as its own
      // callback, typically alongside CallStatus=in-progress. Without this
      // check the call looks identical to a human answering, and Co would
      // start talking into a voicemail box. Rather than an abrupt silent
      // hangup, redirect the still-live call to a deliberate spoken line
      // before ending it — an abrupt hangup here leaves nothing on the
      // person's actual voicemail, which reads as a dropped/failed call
      // rather than an intentional one.
      if (typeof AnsweredBy === "string" && AnsweredBy.startsWith("machine")) {
        if (user) {
          _io?.to(`user:${user.id}`).emit("co:call_completed", { call_sid: CallSid, status: "voicemail" });
        }
        const voiceResponse = new twilio.twiml.VoiceResponse();
        voiceResponse.say(
          { voice: "Polly.Matthew-Neural" },
          user
            ? `Hey ${user.first_name}, it's Co. Sorry I missed you — I'll try you again soon.`
            : `Hey, it's Co. Sorry I missed you — I'll try you again soon.`,
        );
        voiceResponse.hangup();
        try {
          await twilioClient.calls(CallSid).update({ twiml: voiceResponse.toString() });
        } catch (redirectErr: any) {
          console.error("Failed to redirect call to voicemail TwiML (non-fatal):", redirectErr?.message ?? redirectErr);
        }
        // Flag so /co/webhook's chat_ended handler skips the full extraction
        // pipeline below — a few seconds of Hume talking into a machine
        // isn't a real conversation worth building a profile from.
        await pool
          .query(`INSERT INTO voicemail_calls (call_sid) VALUES ($1) ON CONFLICT DO NOTHING`, [CallSid])
          .catch((err: any) => console.error("voicemail_calls flag write failed (non-fatal):", err?.message ?? err));
        if (user) {
          await sendMissedCallFollowUp(
            user,
            CallSid,
            "voicemail",
            `You just tried to call ${user.first_name} and reached voicemail.`,
          );
        }
        return res.sendStatus(204);
      }

      // Push real-time call state to the app regardless of whether it's a missed call.
      // The voice screen listens for these to drive its state machine.
      if (user) {
        if (CallStatus === "ringing") {
          _io?.to(`user:${user.id}`).emit("co:call_ringing", { call_sid: CallSid });
        } else if (CallStatus === "in-progress") {
          _io?.to(`user:${user.id}`).emit("co:call_answered", { call_sid: CallSid });
        } else if (["completed", "no-answer", "busy", "failed", "canceled"].includes(CallStatus)) {
          _io?.to(`user:${user.id}`).emit("co:call_completed", { call_sid: CallSid, status: CallStatus });
        }
      }

      // Only send missed-call follow-up iMessage for calls that never connected
      if (!["no-answer", "busy", "failed", "canceled"].includes(CallStatus)) {
        return res.sendStatus(204);
      }

      // Unknown number — nothing to do, ack so Twilio doesn't retry
      if (!user) {
        console.warn(`call-status: no user found for number ${To} (${CallStatus})`);
        return res.sendStatus(204);
      }

      await sendMissedCallFollowUp(
        user,
        CallSid,
        CallStatus,
        `You just tried to call ${user.first_name} but they didn't pick up.`,
      );

      return res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  },
);

// Answers a pending tool_call via Hume's Control Plane — separate from the
// webhook's own HTTP response, since EVI is waiting on this over the live
// chat, not over the webhook connection. EVI blocks the live conversation on
// a pending tool response, so every millisecond here is dead air — Haiku,
// not Sonnet, no DB writes beyond the coverage check itself.
async function sendHumeToolResponse(chatId: string, toolCallId: string, content: string): Promise<void> {
  const res = await fetch(`https://api.hume.ai/v0/evi/chat/${chatId}/send`, {
    method: "POST",
    headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "tool_response", tool_call_id: toolCallId, content }),
  });
  if (!res.ok) {
    console.error(`co/webhook: tool response POST failed (${res.status}) for chat ${chatId}, tool_call ${toolCallId}`);
  }
}

// assess_conversation_coverage and surface_recommendation — see
// api/src/scripts/registerCoverageTool.ts for registering both on the live
// Hume config (not run automatically — needs explicit review first).
async function handleToolCall(
  chatId: string,
  userId: string | null,
  toolCallMessage: { tool_call_id: string; name: string } | undefined,
): Promise<void> {
  if (!toolCallMessage) return;

  if (toolCallMessage.name === "surface_recommendation") {
    try {
      const result = userId
        ? await generateRecommendation(userId)
        : { available: false as const, reason: "no user resolved for this call" };
      await sendHumeToolResponse(chatId, toolCallMessage.tool_call_id, JSON.stringify(result));
    } catch (err: any) {
      console.error("co/webhook: surface_recommendation failed:", err?.message ?? err);
      await sendHumeToolResponse(
        chatId,
        toolCallMessage.tool_call_id,
        JSON.stringify({ available: false, reason: "lookup failed" }),
      ).catch(() => {});
    }
    return;
  }

  if (toolCallMessage.name !== "assess_conversation_coverage") return;

  try {
    const events = await fetchHumeChatEvents(chatId);
    const transcript = events
      .filter((e) => e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE")
      .map((e) => `${e.role === "USER" ? "user" : "assistant"}: ${e.message_text ?? ""}`)
      .join("\n");
    const priorContext = userId ? await buildContextSummary(userId).catch(() => "") : "";
    const assessment = await assessConversationCoverage(transcript, priorContext);
    await sendHumeToolResponse(chatId, toolCallMessage.tool_call_id, JSON.stringify(assessment));
  } catch (err: any) {
    console.error("co/webhook: assess_conversation_coverage failed, falling back to nothing-covered:", err?.message ?? err);
    await sendHumeToolResponse(
      chatId,
      toolCallMessage.tool_call_id,
      JSON.stringify({ missing_topics: [...RAPPORT_TOPICS], ready_to_summarize: false }),
    ).catch(() => {});
  }
}

// POST /co/webhook — Hume calls this for chat_started, chat_ended, and
// tool_call (all three are registered on the config). chat_ended has the
// full extraction pipeline — the payload itself carries no transcript, so
// it's fetched separately from Hume's Chat Events API using chat_id.
// tool_call is answered asynchronously via the Control Plane (see
// handleToolCall above) — this route just acks Hume's webhook and kicks it
// off, since EVI is blocked on the live chat socket, not this HTTP request.
router.post(
  "/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateHumeWebhook(req)) {
        return res.status(401).send("Unauthorized.");
      }

      // req.body is the raw Buffer here (see server.ts's express.raw() on
      // this path, needed for signature verification above) — parse it now
      // that verification is done. Kept as its own variable (not reassigned
      // onto req.body) so the "missing required fields" log below still
      // shows something readable rather than JSON.stringify-ing a Buffer.
      const parsedBody = JSON.parse((req.body as Buffer).toString("utf-8"));
      const { event_name, custom_session_id, chat_id, chat_group_id, twilio_metadata, tool_call_message } = parsedBody;

      if (event_name === "tool_call") {
        res.status(200).send({ success: true });
        // custom_session_id is reliably present now that calls are bridged
        // through our own WebSocket (see mediaStreamBridge.ts, which sets it
        // itself at connect time) rather than Hume's own Twilio integration,
        // which was documented unreliable about relaying it. twilio_metadata
        // fallback kept for defense in depth.
        (async () => {
          let toolCallUserId: string | null = custom_session_id ?? null;
          if (!toolCallUserId && twilio_metadata?.to_number) {
            const byPhone = await pool.query(`SELECT id FROM users WHERE phone_number = $1`, [twilio_metadata.to_number]);
            toolCallUserId = byPhone.rows[0]?.id ?? null;
          }
          await handleToolCall(chat_id, toolCallUserId, tool_call_message);
        })().catch((err) => console.error("co/webhook: unhandled tool_call error:", err?.message ?? err));
        return;
      }

      if (event_name !== "chat_ended") {
        return res.status(200).send({ success: true, ignored: event_name });
      }

      // Hume's Twilio integration does not reliably return custom_session_id
      // (confirmed empty on real calls) even though it's passed on the
      // handshake URL — fall back to resolving the user by the phone number
      // Twilio actually dialed, which Hume does include on the Twilio leg.
      let user_id = custom_session_id;
      let callUser: { id: string; first_name: string; phone_number: string } | null = null;
      if (!user_id && twilio_metadata?.to_number) {
        const byPhone = await pool.query(
          `SELECT id, first_name, phone_number FROM users WHERE phone_number = $1`,
          [twilio_metadata.to_number],
        );
        callUser = byPhone.rows[0] ?? null;
        user_id = callUser?.id ?? null;
      }

      if (!user_id || !chat_id) {
        console.error(`co/webhook: could not resolve user for chat ${chat_id} — body: ${JSON.stringify(parsedBody)}`);
        return res.status(400).send("Missing required fields.");
      }

      if (!callUser) {
        const byId = await pool.query(`SELECT id, first_name, phone_number FROM users WHERE id = $1`, [user_id]);
        callUser = byId.rows[0] ?? null;
      }

      // AMD already flagged this call as an answering machine/voicemail (see
      // /co/call-status's AnsweredBy branch) and hung up immediately — skip
      // the full extraction pipeline below so a few seconds of Hume talking
      // into a machine doesn't get treated as a real conversation worth
      // building a profile from. Sourced from users.call_sid, not
      // twilio_metadata.call_sid — Hume no longer populates twilio_metadata
      // reliably now that calls are bridged through our own WebSocket rather
      // than Hume's native Twilio integration (same regression confirmed and
      // fixed in co-test first).
      let voicemailCallSid: string | null = twilio_metadata?.call_sid ?? null;
      if (!voicemailCallSid) {
        const callSidResult = await pool.query(`SELECT call_sid FROM users WHERE id = $1`, [user_id]);
        voicemailCallSid = callSidResult.rows[0]?.call_sid ?? null;
      }
      if (voicemailCallSid) {
        const flagged = await pool.query(`SELECT 1 FROM voicemail_calls WHERE call_sid = $1`, [voicemailCallSid]);
        if (flagged.rows.length > 0) {
          console.log(`co/webhook: skipping extraction for voicemail call ${voicemailCallSid}`);
          return res.status(200).send({ success: true, skipped: "voicemail" });
        }
      }

      // Let the app know the call ended and Co is now extracting the profile
      _io?.to(`user:${user_id}`).emit("co:processing");

      const [{ transcript, emotions }, recording_url] = await Promise.all([
        fetchHumeCallData(chat_id),
        fetchHumeRecordingUrl(chat_id),
      ]);

      if (!transcript) {
        console.error(`co/webhook: empty transcript for chat ${chat_id} (user ${user_id})`);
        return res.status(200).send({ success: true, empty: true });
      }

      // Step 1 — Store raw transcript in co_memories immediately
      const callMemory = await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content, emotional_context, audio_url)
         VALUES ($1, 'call_transcript', $2, $3, $4) RETURNING id`,
        [user_id, transcript, JSON.stringify(emotions), recording_url ?? null],
      );
      generateEmbedding(transcript)
        .then((emb) =>
          pool.query(
            `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
            [`[${emb.join(",")}]`, callMemory.rows[0].id],
          ),
        )
        .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

      // Step 2 — Extract + store psychographic data. Now unions list fields
      // (goals/blockers/activity_preferences/life_chapters) with what's
      // already on file instead of overwriting on every call — a goal
      // mentioned on call 1 but not call 2 no longer silently vanishes (see
      // profileExtraction.ts's storeProfile for the full merge behavior).
      const { extracted } = await extractPsychographicProfile(transcript);
      await storeProfile(user_id, extracted, transcript, { emotions });

      // Step 3 — Persist Hume chat group ID so the next call resumes this conversation
      if (chat_group_id) {
        await pool.query(
          `UPDATE co_profiles SET hume_chat_group_id = $1 WHERE user_id = $2`,
          [chat_group_id, user_id],
        );
      }

      // Step 4 — Ambient intent capture (non-blocking — runs in background)
      captureIntent(user_id, transcript).catch(() => {});

      // Profile is fully extracted and stored — tell the app to show the Ready state
      _io?.to(`user:${user_id}`).emit("co:profile_ready");

      // Step 5 — Follow-up iMessage. The app only shows "Ready" if it happens
      // to be open — most people have hung up and moved on, so this is the
      // only confirmation they actually get that the call did something.
      // Grounded in the actual transcript, not the extracted fields — the
      // point is to show Co was genuinely listening, not to close a ticket.
      console.log(`co/webhook: follow-up gate — custom_session_id=${custom_session_id} user_id=${user_id} callUser=${JSON.stringify(callUser)}`);
      if (callUser) {
        try {
          const { text: followUpMessage } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            prompt: `You are Co. You just got off a call with ${callUser.first_name}. Here's what they told you:

"${transcript}"

Text them something short that proves you were actually listening — pick one real, specific thing they said (a feeling, a struggle, a detail) and respond to that, not a summary of the whole call. This should read like it came from someone who resonated with what they heard, not someone closing out a form.

Do not say "I have what I need," "I'll be in touch," "your circle is ready/next," or anything that sounds like a status update. No exclamation points. No em dashes. 1-2 sentences, text-message length.`,
          });

          await sendblue.messages.send({
            number: callUser.phone_number,
            content: followUpMessage,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });

          const followUpContent = `Co replied: ${followUpMessage}`;
          const followUpMem = await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2) RETURNING id`,
            [user_id, followUpContent],
          );
          generateEmbedding(followUpContent)
            .then((emb) =>
              pool.query(
                `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                [`[${emb.join(",")}]`, followUpMem.rows[0].id],
              ),
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
        } catch (followUpErr: any) {
          console.error("Post-call follow-up text failed (non-fatal):", followUpErr?.message ?? followUpErr);
        }
      }

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// GET /co/profile/:user_id
router.get(
  "/profile/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.user?.id !== req.params.user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      const result = await pool.query(
        `SELECT cp.*, COUNT(cm.id)::int AS check_in_count
         FROM co_profiles cp
         LEFT JOIN co_memories cm ON cm.user_id = cp.user_id AND cm.memory_type = 'check_in'
         WHERE cp.user_id = $1
         GROUP BY cp.user_id`,
        [req.params.user_id],
      );

      if (!result.rows[0]) return res.status(404).send("Profile not found.");

      return res.status(200).send({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

// PUT /co/profile/:user_id — self-service edit of a user's own psychographic
// profile. trust_score/trust_components are computed by Co, not user-editable.
router.put(
  "/profile/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.user?.id !== req.params.user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      const allowed = [
        "life_chapters",
        "social_energy",
        "connection_style",
        "activity_preferences",
        "emotional_state",
        "goals",
        "blockers",
        "availability_pattern",
        "city",
      ];

      const filteredKeys = Object.keys(req.body).filter((key) =>
        allowed.includes(key),
      );

      const values = filteredKeys.map((key) => req.body[key]);

      const setClause = filteredKeys
        .map((key, index) => `${key} = $${index + 2}`)
        .join(", ");

      const result = await pool.query(
        `UPDATE co_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
        [req.params.user_id, ...values],
      );

      if (!result.rows[0]) return res.status(404).send("Profile not found.");

      return res.status(200).send({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/place — runs matching algorithm, creates Circle autonomously, notifies members
// This is the core of CoPatible — Co decides who belongs together
router.post(
  "/place/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user_id = req.params.user_id as string;

      if (req.user?.id !== user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      // Pre-flight — skip placement if user is already in an active circle
      const existingMembership = await pool.query(
        `SELECT circle_id FROM circle_members WHERE member_id = $1 LIMIT 1`,
        [user_id],
      );
      if (existingMembership.rows[0]) {
        return res.status(200).send({
          success: false,
          message: "User is already in an active circle.",
        });
      }

      // Step 1 — Run matching algorithm
      // Returns user IDs + final group score, or null if no valid group found
      const matchResult = await findBestCircleWithScore(user_id);
      const groupUserIds = matchResult?.userIds ?? null;

      // Step 2 — No match found — flag for manual placement by the Moderator
      if (!groupUserIds || groupUserIds.length < 4) {
        return res.status(200).send({
          success: false,
          manual_placement: true,
          message: "No qualifying circle found. Flagged for manual placement.",
        });
      }

      // Step 3 — Create a Circle autonomously using existing Circles API
      // Co names the circle based on the shared life chapter
      const userProfile = await pool.query(
        `SELECT life_chapters, city FROM co_profiles WHERE user_id = $1`,
        [user_id],
      );
      const profile = userProfile.rows[0];
      const primaryChapter = profile.life_chapters[0] ?? "new_to_city";
      const circleName = `Co Circle — ${primaryChapter.replace(/_/g, " ")}`;

      const circleResult = await pool.query(
        `INSERT INTO circles (owner_id, circle_name, status) VALUES ($1, $2, 'pending_approval') RETURNING *`,
        [user_id, circleName],
      );
      const circle = circleResult.rows[0];

      // Step 4 — Add all matched members to the circle immediately — no
      // gating. owner_id (set above) stays purely for attribution — the
      // requester is also inserted here as a normal row so every feature
      // that queries circle_members (notifications, invites, polls) treats
      // them the same as anyone else in the circle.
      for (const memberId of groupUserIds) {
        await pool.query(
          `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [circle.id, memberId],
        );
      }

      // Step 5 — Co decides on its own above the confidence floor: activate
      // and invite immediately, no Moderator step (no Circle Connector
      // either — Co now handles venue booking itself, see /moment below).
      // Only a genuinely below-threshold group (Co can't confidently decide)
      // goes to the Moderator.
      if (matchResult!.finalScore >= min_group_score) {
        await activateCircle({ circleId: circle.id, circleName, io: _io ?? undefined });
      } else {
        await notifyModeratorOfPendingCircle({
          circleId: circle.id,
          finalScore: matchResult!.finalScore,
        });

        // Step 6 — Store pending-approval memory for each member (only the
        // Moderator-review path needs this — activateCircle already writes
        // its own per-member memory for the immediate-invite path).
        for (const memberId of groupUserIds) {
          const placementContent = `Circle placement pending Moderator approval`;
          const placementMemory = await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'check_in', $2) RETURNING id`,
            [memberId, placementContent],
          );
          generateEmbedding(placementContent)
            .then((emb) =>
              pool.query(
                `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                [`[${emb.join(",")}]`, placementMemory.rows[0].id],
              ),
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
        }
      }

      return res.status(201).send({
        success: true,
        data: {
          circle_id: circle.id,
          circle_name: circleName,
          members: groupUserIds,
          member_count: groupUserIds.length,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/moment/:circle_id — Co creates a Moment for a placed circleß
// Uses member activity preferences to suggest the best experience
router.post(
  "/moment/:circle_id",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circle_id } = req.params;

      // Step 1 — Fetch all members of the associated circle
      const membersResult = await pool.query(
        `SELECT cm.member_id, cp.activity_preferences, cp.connection_style, cp.life_chapters, cp.city,
                ST_Y(cp.coordinates) AS lat, ST_X(cp.coordinates) AS lng
         FROM circle_members cm
         JOIN co_profiles cp ON cp.user_id = cm.member_id
         WHERE cm.circle_id = $1`,
        [circle_id],
      );

      const members = membersResult.rows;
      if (!members.length) return res.status(404).send("Circle not found.");

      // Step 2 — Get the circle owner
      const circleResult = await pool.query(
        `SELECT owner_id FROM circles WHERE id = $1`,
        [circle_id],
      );
      const circle = circleResult.rows[0];
      if (!circle) return res.status(404).send("Circle not found.");

      // Step 3 — Find most common activity preferences across the group
      //combines the array of all members activity preferences
      const allActivities = members.flatMap((m) => m.activity_preferences);
      //acc holds the record pair
      const activityCount = allActivities.reduce(
        (acc: Record<string, number>, activity: string) => {
          acc[activity] = (acc[activity] || 0) + 1;
          return acc;
        },
        // starts with a empty object
        {},
      );

      ///Converts the object into an array of [key, value] pairs:
      const topActivities = Object.entries(activityCount)
        //If b is bigger than a → positive → b goes first → highest numbers first
        //If a is bigger than b → negative → a goes first
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 3)
        //Because the word activity is placed before the comma, JavaScript automatically assigns whatever is at index 0 to that variable.
        .map(([activity]) => activity);

      // Step 4 — Get dominant connection style
      const connectionStyles = members.map((m) => m.connection_style);
      //After checking all items, the array is rearranged so the most frequent styles are first:
      const dominantStyle =
        connectionStyles.sort(
          (a: string, b: string) =>
            connectionStyles.filter((s: string) => s === b).length -
            connectionStyles.filter((s: string) => s === a).length,
        )[0] || "small_group";

      // Step 5 — Get shared life chapters
      const allChapters = members.flatMap((m) => m.life_chapters);
      const uniqueChapters = [...new Set(allChapters)];

      // Step 6 — Use Anthropic to generate Moment context
      const city = members[0].city ?? "San Francisco";
      const groupSize = members.length + 1;

      // Center point for venue search — averages member coordinates so the
      // Google Places lookup is geographically biased and hard-filtered near
      // where the circle actually lives, instead of trusting a free-text city
      // string alone (e.g. "San Francisco Bay Area" isn't a precise Places
      // location and previously let wildly out-of-area results slip through).
      const memberCoords = members.filter((m: any) => m.lat != null && m.lng != null);
      const geoCenter = memberCoords.length
        ? {
            lat: memberCoords.reduce((sum: number, m: any) => sum + m.lat, 0) / memberCoords.length,
            lng: memberCoords.reduce((sum: number, m: any) => sum + m.lng, 0) / memberCoords.length,
          }
        : null;

      const { text: rawMoment } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt: `You are Co, a life concierge creating a curated real-world experience for a small circle of people.

Circle details:
- Group size: ${groupSize} people
- City: ${city}
- Shared activities they enjoy: ${topActivities.join(", ")}
- Life chapters they are navigating: ${uniqueChapters.join(", ")}
- Connection style: ${dominantStyle}

Create a specific, curated Moment for this group. Return ONLY valid JSON with no preamble:

{
  "moments_name": "short evocative name for the experience",
  "description": "1-2 sentences MAX. Keep under 300 characters.",
  "venue_type": "one of: dinner | coworking | outdoor | social | experience",
  "neighborhood": "specific ${city} neighborhood that fits the vibe",
  "vibe": "3-4 words describing the atmosphere",
  "suggested_time": "day and time suggestion (e.g. Thursday 7pm)",
  "vibes": ["vibe1", "vibe2", "vibe3"]
}

Make it feel intimate, specific, and intentional. Not generic.`,
      });

      // Step 7 — Parse Anthropic response
      let momentData: any = {};
      try {
        const clean = rawMoment.replace(/```json|```/g, "").trim();
        momentData = JSON.parse(clean);
      } catch {
        console.error("Failed to parse moment data:", rawMoment);
        return res.status(500).send("Failed to generate moment.");
      }

      // Truncate description as safety measure
      momentData.description = momentData.description?.slice(0, 390) ?? "";

      // Step 7.5 — Find best venue
      // Priority: partner venues first, then Google Places
      let selectedVenue: any = null;

      const partnerVenue = await pool.query(
        `SELECT * FROM co_venues 
         WHERE city = $1 
         AND type = $2
         AND active = TRUE
         AND (capacity_max IS NULL OR capacity_max >= $3)
         ORDER BY RANDOM()
         LIMIT 1`,
        [city, momentData.venue_type, groupSize],
      );

      if (partnerVenue.rows[0]) {
        // Use CoPatible partner venue
        const contact: string = partnerVenue.rows[0].contact ?? "";
        const partnerBookingUrl = contact.startsWith("http")
          ? contact
          : `https://resy.com/cities/sf?query=${encodeURIComponent(partnerVenue.rows[0].name)}`;

        selectedVenue = {
          name: partnerVenue.rows[0].name,
          formatted_address: partnerVenue.rows[0].neighborhood,
          co_reason: "CoPatible partner venue",
          booking_method: partnerVenue.rows[0].booking_method,
          contact: partnerVenue.rows[0].contact,
          payment_tier: partnerVenue.rows[0].payment_tier,
          venue_booking_url: partnerBookingUrl,
        };
      } else {
        // Fall back to Google Places + Co scoring — co_fit_score (0-1, Co's
        // own self-rated confidence in this specific pick) feeds the
        // Moderator-approval gate below; a partner venue has no equivalent
        // score and is treated as trusted by default (null never counts as
        // "low fit").
        selectedVenue = await findBestVenue(
          momentData.venue_type,
          momentData.neighborhood,
          city,
          {
            vibe: momentData.vibe,
            life_chapters: uniqueChapters,
            connection_style: dominantStyle,
            group_size: groupSize,
          },
          geoCenter,
        );
      }

      // Step 7.6 — Real candidate time windows grounded in the venue's
      // actual opening hours + each member's stated availability, instead of
      // a single AI-guessed suggested_time. Only worth the extra LLM call
      // for groups large enough to actually run the poll below. Falls back
      // to an empty array (and the single-time poll) if this fails or the
      // venue's hours were never resolved (e.g. a partner venue, which has
      // no opening_hours_periods).
      const candidateWindows: CandidateWindow[] =
        groupSize >= 4
          ? await generateCandidateWindows(
              selectedVenue?.opening_hours_periods,
              members.map((m: any) => m.availability_pattern),
              momentData.venue_type,
            )
          : [];

      // Step 8 — Create the Moment
      const momentStart = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const venueFitScore: number | null = selectedVenue?.co_fit_score ?? null;
      const lowVenueFit = venueFitScore != null && venueFitScore < LOW_CONFIDENCE_VENUE_FIT_SCORE;

      const momentResult = await pool.query(
        `INSERT INTO moments
         (creator_id, moments_name, location, location_name, moment_start, visibility_type, description, circle_id, vibes, venue, suggested_time, status, venue_booking_url, venue_place_id, venue_type, vibe, neighborhood, candidate_windows, venue_fit_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          circle.owner_id,
          momentData.moments_name,
          "(0,0)",
          selectedVenue?.formatted_address ??
            `${momentData.neighborhood} — ${momentData.venue_type}`,
          momentStart,
          "circle",
          momentData.description,
          circle_id,
          momentData.vibes ?? [],
          selectedVenue?.name ?? null,
          momentData.suggested_time ?? null,
          lowVenueFit ? "pending_venue_approval" : "polling",
          selectedVenue?.venue_booking_url ?? null,
          selectedVenue?.place_id ?? null,
          momentData.venue_type ?? null,
          momentData.vibe ?? null,
          momentData.neighborhood ?? null,
          candidateWindows.length ? JSON.stringify(candidateWindows) : null,
          venueFitScore,
        ],
      );

      const moment = momentResult.rows[0];

      // Pre-warm OG image before any iMessage links go out — avoids preview timeout
      fetch(`https://app.copatible.com/api/og/moments/${moment.id}`).catch(() => {});

      // Step 8.5 — Seed moment_responses for each circle member + the owner (null = awaiting reply)
      // The owner is excluded from circle_members (implicit via owner_id), so seed them separately.
      const responseUserIds = [circle.owner_id, ...members.map((m: any) => m.member_id)];
      for (const userId of responseUserIds) {
        await pool.query(
          `INSERT INTO moment_responses (moment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [moment.id, userId],
        );
      }

      // Step 8.6 — A venue Co isn't confident about goes to the Moderator
      // for approve/reject before any member is told anything, same
      // "Moderator sees it before members do" principle as circle placement.
      // Nobody gets notified below in this case; sendblue.ts's Moderator
      // reply handler picks this up from here.
      if (lowVenueFit) {
        await requestVenueApprovalFromModerator({
          id: moment.id,
          circle_id: circle_id as string,
          moments_name: moment.moments_name,
          venue: moment.venue,
          venue_booking_url: moment.venue_booking_url,
          venue_place_id: moment.venue_place_id,
          suggested_time: moment.suggested_time,
          moment_start: moment.moment_start,
          venue_fit_score: venueFitScore,
          consensus_low_confidence: false,
        });

        return res.status(201).send({
          success: true,
          data: {
            moment_id: moment.id,
            moments_name: moment.moments_name,
            status: "pending_venue_approval",
            circle_id,
          },
        });
      }

      // Step 9 — Notify all circle members individually. CoPatible has no
      // group chat — every member gets their own thread with Co, not a
      // shared one, so this is always a 1:1 send per person.
      const momentDateStr = new Date(moment.moment_start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      const momentTimeStr = new Date(moment.moment_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const momentInviteMsg = `Co arranged something for your circle. ${moment.moments_name} at ${selectedVenue?.name ?? momentData.neighborhood}, ${momentData.suggested_time ?? `${momentDateStr} at ${momentTimeStr}`}.\n\nhttps://app.copatible.com/moments/${moment.id}`;

      const memberPhones: string[] = [];
      for (const member of members) {
        const userResult = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [member.member_id],
        );
        const user = userResult.rows[0];
        if (!user) continue;

        memberPhones.push(user.phone_number);

        await sendEmail({
          email: user.email,
          invite_type: "received",
          invite_target: "moment",
          action_url: `https://app.copatible.com/moments/${moment.id}`,
        });

        try {
          await sendblue.messages.send({
            number: user.phone_number,
            content: momentInviteMsg,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error(`Moment invite message failed for ${member.member_id}:`, smsErr?.message ?? smsErr);
        }
      }

      // Step 9.5 — Consensus poll, sent individually to each member
      if (memberPhones.length >= 4) {
        const pollMessage = `Does ${momentData.suggested_time ?? "this time"} work for you? Reply YES or NO.`;
        for (const phone of memberPhones) {
          try {
            await sendblue.messages.send({
              number: phone,
              content: pollMessage,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (smsErr: any) {
            console.error(`Consensus poll message failed for ${phone}:`, smsErr?.message ?? smsErr);
          }
        }
      }

      // Step 10 — Store co_memory for each member
      for (const member of members) {
        const momentContent = `Co created a Moment for your circle: ${momentData.moments_name} at ${selectedVenue?.name ?? momentData.neighborhood}. ${momentData.suggested_time}.`;
        const momentMemory = await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'intent', $2) RETURNING id`,
          [member.member_id, momentContent],
        );
        generateEmbedding(momentContent)
          .then((emb) =>
            pool.query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${emb.join(",")}]`, momentMemory.rows[0].id],
            ),
          )
          .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
      }

      return res.status(201).send({
        success: true,
        data: {
          moment_id: moment.id,
          moments_name: moment.moments_name,
          venue: selectedVenue?.name ?? null,
          venue_type: momentData.venue_type,
          neighborhood: momentData.neighborhood,
          vibe: momentData.vibe,
          suggested_time: momentData.suggested_time,
          location_name: moment.location_name,
          moment_start: moment.moment_start,
          circle_id,
          member_count: members.length,
          co_reason: selectedVenue?.co_reason ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/moment/:moment_id/propose-time — the Circle Connector picks a
// specific date/time from the app (mirrors what a "time: X" iMessage reply
// does over text). Sets it as the new candidate time, clears prior yes/no
// responses since they were for the old time, and re-asks every member
// individually — no group chat.
router.post(
  "/moment/:moment_id/propose-time",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { moment_id } = req.params;
      const { moment_start } = req.body as { moment_start?: string };
      const user_id = req.user?.id;

      if (!user_id) return res.status(401).send("Unauthorized.");
      if (!moment_start) return res.status(400).send("moment_start is required.");

      const momentResult = await pool.query(
        `SELECT circle_id FROM moments WHERE id = $1`,
        [moment_id],
      );
      const momentRow = momentResult.rows[0];
      if (!momentRow) return res.status(404).send("Moment not found.");
      const { circle_id } = momentRow;

      // Any circle member may propose a time — no single gatekeeper (the
      // Circle Connector role this used to require no longer exists; Co
      // books directly now, see services/booking.ts). First one to suggest
      // a workable time moves it, same as the equivalent text-reply path in
      // sendblue.ts.
      const membershipCheck = await pool.query(
        `SELECT 1 WHERE
           EXISTS (SELECT 1 FROM circles c WHERE c.id = $2 AND c.owner_id = $1)
           OR EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = $2 AND cm.member_id = $1)`,
        [user_id, circle_id],
      );
      if (!membershipCheck.rows[0]) {
        return res.status(403).send("Only a member of this circle can propose a time.");
      }

      const dateObj = new Date(moment_start);
      if (Number.isNaN(dateObj.getTime())) {
        return res.status(400).send("moment_start must be a valid date.");
      }
      const suggestedTime = `${dateObj.toLocaleDateString("en-US", { weekday: "long" })} ${dateObj.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`;

      await pool.query(
        `UPDATE moments SET moment_start = $1, suggested_time = $2 WHERE id = $3`,
        [dateObj.toISOString(), suggestedTime, moment_id],
      );

      // New proposal supersedes old responses — everyone re-confirms against the new time
      await pool.query(
        `UPDATE moment_responses SET response = NULL, responded_at = NULL WHERE moment_id = $1`,
        [moment_id],
      );

      const membersResult = await pool.query(
        `SELECT u.id, u.phone_number FROM moment_responses mr
         JOIN users u ON u.id = mr.user_id
         WHERE mr.moment_id = $1`,
        [moment_id],
      );
      const pollMessage = `Does ${suggestedTime} work for you? Reply YES or NO.`;
      for (const member of membersResult.rows) {
        try {
          await sendblue.messages.send({
            number: member.phone_number,
            content: pollMessage,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error(`Propose-time message failed for ${member.id}:`, smsErr?.message ?? smsErr);
        }
      }

      _io?.to(`moment:${moment_id}`).emit("moment:time_proposed", {
        moment_id,
        moment_start: dateObj.toISOString(),
        suggested_time: suggestedTime,
      });

      return res.status(200).send({
        success: true,
        moment_start: dateObj.toISOString(),
        suggested_time: suggestedTime,
      });
    } catch (error) {
      next(error);
    }
  },
);

//POST /co/message/:user_id - Co sends a message to a user
router.post(
  "/message/:user_id",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;
      const { message_type, context } = req.body;

      // 2. Fetch the user from the database
      const userInfo = await pool.query(`SELECT * FROM users WHERE id = $1`, [
        user_id,
      ]);
      const user: UserProp = userInfo.rows[0];

      if (!user) {
        return res.status(404).send("User not found.");
      }

      let lifeConcieregeContext = "";
      if (message_type === "life_concierge" && context?.user_message) {
        try {
          const lcEmbedding = await generateEmbedding(context.user_message);
          const lcMemories = await pool.query(
            `SELECT content FROM co_memories
             WHERE user_id = $1 AND content_embedding IS NOT NULL AND memory_type != 'intent'
             ORDER BY content_embedding <=> $2::vector
             LIMIT 5`,
            [user_id, `[${lcEmbedding.join(",")}]`],
          );
          lifeConcieregeContext = lcMemories.rows.map((m: any) => m.content).join("\n");
        } catch (lcErr) {
          console.error("Semantic memory fetch failed for life_concierge (non-fatal):", lcErr);
        }
      }

      // For circle_placement: look up momentId for the user's circle to build a preview URL
      let momentId: string | null = null;
      if (message_type === "circle_placement") {
        try {
          const momentResult = await pool.query(
            `SELECT id FROM moments WHERE circle_id = (
               SELECT circle_id FROM circle_members WHERE member_id = $1
               ORDER BY created_at DESC LIMIT 1
             ) AND status != 'rejected' ORDER BY created_at DESC LIMIT 1`,
            [user_id],
          );
          momentId = momentResult.rows[0]?.id ?? null;
        } catch {
          // non-fatal — send without URL
        }
      }
      const circlePageUrl = momentId ? `https://app.copatible.com/moments/${momentId}` : null;

      // circle_placement and moment_invite use fixed copy for consistency —
      // no headcount or group framing, since each person gets their own
      // individual thread with Co, not a shared one.
      const fixedCopy: Record<string, string> = {
        circle_placement: "I placed you in a circle. Co found people navigating the same chapter as you. Your first moment is coming.",
        moment_invite: `Co arranged something for your circle. ${context?.moments_name} at ${context?.venue}, ${context?.suggested_time}.`,
      };

      const prompts: Record<string, string> = {
        payment_link: `You are Co. Write a short iMessage to ${user.first_name} to secure their spot for ${context?.moments_name}. Include the payment link: ${context?.payment_url}. Tone: matter of fact, not salesy. Like confirming a dinner reservation deposit. 2 sentences max. No em dashes.`,

        check_in: `You are Co. Write a short iMessage to ${user.first_name} following up after their circle experience. Tone: like a thoughtful friend checking in, not a survey. One question only. 1 sentence max. No em dashes.`,

        life_concierge: `You are Co. ${user.first_name} said: "${context?.user_message}".${lifeConcieregeContext ? `\n\nContext from past conversations:\n${lifeConcieregeContext}` : ""} Respond as Co — specific, warm, actionable. Co knows ${user.first_name} well. No filler phrases. 2 sentences max. No em dashes.`,
      };

      // Unrecognized message_type defaults to the fixed circle_placement copy
      // (not a Claude prompt) — matches the previous fallback behavior.
      let coMessage: string;
      if (prompts[message_type]) {
        const result = await generateText({
          model: anthropic("claude-sonnet-4-6"),
          prompt: prompts[message_type],
        });
        coMessage = result.text;
      } else {
        coMessage = fixedCopy[message_type] ?? fixedCopy.circle_placement;
      }

      const coMsgMemory = await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content)
   VALUES ($1, 'text_exchange', $2) RETURNING id`,
        [user_id, coMessage],
      );
      generateEmbedding(coMessage)
        .then((emb) =>
          pool.query(
            `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
            [`[${emb.join(",")}]`, coMsgMemory.rows[0].id],
          ),
        )
        .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

      // Voice notes for premium touchpoints — payment_link stays text since it carries a URL
      const useVoiceNote = ["circle_placement", "moment_invite", "check_in", "life_concierge"].includes(message_type);
      let audioUrl: string | null = null;
      if (useVoiceNote) {
        try {
          audioUrl = await generateVoiceNote(coMessage);
        } catch (voiceErr: any) {
          console.error("Voice note generation failed, falling back to text:", voiceErr?.message ?? voiceErr);
        }
      }

      // vCard — circle_placement only, sent as a separate preceding message on first contact.
      // Wait 3 seconds after sending so iMessage has time to register Co as a saved contact
      // before the placement message (with link preview) arrives. Skip delay if already sent.
      if (message_type === "circle_placement" && process.env.CO_VCARD_URL) {
        const vcardCheck = await pool.query(
          `SELECT id FROM co_memories WHERE user_id = $1 AND content = 'Co vCard sent to user — contact saved' LIMIT 1`,
          [user_id],
        );
        if (!vcardCheck.rows[0]) {
          try {
            await sendblue.messages.send({
              number: user.phone_number,
              content: "Co is your life concierge. Save this contact.",
              media_url: process.env.CO_VCARD_URL,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content)
               VALUES ($1, 'system', 'Co vCard sent to user — contact saved')`,
              [user_id],
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
          } catch (vcardErr: any) {
            console.error("vCard send failed (non-fatal):", vcardErr?.message ?? vcardErr);
          }
        }
      }

      // For text messages, URL goes inline at the end (no text after it — iMessage preview rule).
      // For voice notes, URL can't be embedded in audio; send as a separate text follow-up.
      const finalMessage = !audioUrl && circlePageUrl
        ? `${coMessage}\n\n${circlePageUrl}`
        : coMessage;

      let sendResult: any = null;
      try {
        sendResult = await sendblue.messages.send({
          number: user.phone_number,
          content: audioUrl ? "" : finalMessage,
          ...(audioUrl ? { media_url: audioUrl } : {}),
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        const errMsg = smsErr?.message ?? String(smsErr);
        console.error(`Sendblue failed to send to ${user_id}:`, errMsg);
        const failContent = `Co failed to send message to ${user_id}: ${errMsg}`;
        const failMemory = await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2) RETURNING id`,
          [user_id, failContent],
        );
        generateEmbedding(failContent)
          .then((emb) =>
            pool.query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${emb.join(",")}]`, failMemory.rows[0].id],
            ),
          )
          .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
      }

      // Voice note was sent — now send URL as a clean standalone message for iMessage preview
      if (audioUrl && circlePageUrl && sendResult) {
        try {
          await sendblue.messages.send({
            number: user.phone_number,
            content: circlePageUrl,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (urlErr: any) {
          console.error("Circle page URL follow-up failed (non-fatal):", urlErr?.message ?? urlErr);
        }
      }

      return res.status(200).send({
        success: true,
        text_dateCreated: sendResult?.date_created ?? null,
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /message/circle/:circle_id — Co sends the same announcement to every
// circle member, individually. CoPatible launches with individual iMessage
// threads only — there is no group chat, so this always fans out to each
// member's own thread with Co rather than creating any shared conversation.
router.post(
  "/message/circle/:circle_id",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circle_id } = req.params;
      const { message_type, context } = req.body;

      const circleMembers = await pool.query(
        `SELECT u.id, u.first_name, u.phone_number
         FROM circle_members cm
         JOIN users u ON cm.member_id = u.id
         WHERE cm.circle_id = $1`,
        [circle_id],
      );

      const members = circleMembers.rows;

      if (members.length < 4) {
        return res.status(400).send("Not enough members in the circle.");
      }

      // circle_placement and moment_invite use fixed copy for consistency —
      // everything else is still drafted by Co per the situation.
      const fixedCopy: Record<string, string> = {
        circle_placement: "I placed you in a circle. Co found people navigating the same chapter as you. Your first moment is coming.",
        moment_invite: `Co arranged something for your circle. ${context?.moments_name} at ${context?.venue}, ${context?.suggested_time}.`,
      };

      const prompts: Record<string, string> = {
        payment_link: `You are Co. Write a short iMessage to secure a spot for ${context?.moments_name}. Payment link: ${context?.payment_url}. Matter of fact, not salesy. 2 sentences max. No em dashes.`,

        check_in: `You are Co. Write a short iMessage following up after a circle experience. One question only. Warm but brief. 1 sentence max. No em dashes.`,
      };

      // Unrecognized message_type defaults to the fixed circle_placement copy
      // (not a Claude prompt) — matches the previous fallback behavior.
      let coMessage: string;
      if (prompts[message_type]) {
        const result = await generateText({
          model: anthropic("claude-sonnet-4-6"),
          prompt: prompts[message_type],
        });
        coMessage = result.text;
      } else {
        coMessage = fixedCopy[message_type] ?? fixedCopy.circle_placement;
      }

      // Voice notes for emotional touchpoints — payment_link stays text (carries a URL)
      const useVoice = ["circle_placement", "moment_invite", "check_in"].includes(message_type);
      let audioUrl: string | null = null;
      if (useVoice) {
        try {
          audioUrl = await generateVoiceNote(coMessage);
        } catch (voiceErr: any) {
          console.error("Voice note generation failed, falling back to text:", voiceErr?.message ?? voiceErr);
        }
      }

      // Send to each member individually, then log per-member outcome
      let deliveredCount = 0;
      for (const member of members) {
        try {
          await sendblue.messages.send({
            number: member.phone_number,
            content: audioUrl ? "" : coMessage,
            ...(audioUrl ? { media_url: audioUrl } : {}),
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
          deliveredCount++;
        } catch (smsErr: any) {
          const errMsg = smsErr?.message ?? String(smsErr);
          console.error(`Message failed for ${member.id}:`, errMsg);
          const failContent = `Co failed to send message to ${member.id}: ${errMsg}`;
          const failMemory = await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'text_exchange', $2) RETURNING id`,
            [member.id, failContent],
          );
          generateEmbedding(failContent)
            .then((emb) =>
              pool.query(
                `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                [`[${emb.join(",")}]`, failMemory.rows[0].id],
              ),
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
          continue;
        }

        const memMemory = await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2) RETURNING id`,
          [member.id, coMessage],
        );
        generateEmbedding(coMessage)
          .then((emb) =>
            pool.query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${emb.join(",")}]`, memMemory.rows[0].id],
            ),
          )
          .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
      }

      return res.status(200).send({
        success: true,
        status: deliveredCount > 0 ? "sent" : "failed",
        member_count: members.length,
        delivered_count: deliveredCount,
        message: coMessage,
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/typed-intake/:user_id — mobile "I'd rather type" path.
// Accepts a free-text transcript from the pre-call screen, runs the same
// psychographic extraction as the Hume webhook, and emits co:profile_ready.
// Requires JWT auth (unlike the public Hume webhook endpoint).
router.post(
  "/typed-intake/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;
      const { transcript } = req.body as { transcript?: string };

      if (req.user?.id !== user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      if (!user_id || !transcript?.trim()) {
        return res.status(400).send("Missing required fields.");
      }

      _io?.to(`user:${user_id}`).emit("co:processing");

      // Store raw text as a call_transcript memory so it feeds into future sessions
      const memRow = await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content)
         VALUES ($1, 'call_transcript', $2) RETURNING id`,
        [user_id, transcript],
      );
      generateEmbedding(transcript)
        .then((emb) =>
          pool.query(
            `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
            [`[${emb.join(",")}]`, memRow.rows[0].id],
          ),
        )
        .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

      const { text: rawExtraction } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt: `You are extracting psychographic profile data from a conversation transcript.

        Based on this transcript, extract the following fields and return ONLY valid JSON with no preamble or markdown:

        {
          "life_chapters": [], // array of applicable values from: new_to_city, building_solo, career_pivot, starting_over
          "social_energy": 0, // number 0-100 (0 = very introverted/quiet preference, 100 = very extroverted/high energy)
          "connection_style": "", // one of: small_group, medium_group, large_social
          "activity_preferences": [], // array of activities they mentioned or implied enjoying
          "goals": [], // array of things they are working toward
          "blockers": [], // array of challenges or struggles they mentioned
          "availability_pattern": "", // how often and when they want to connect (e.g. "weekday evenings", "weekends")
          "city": "", // city they are in or moving to
          "emotional_state": "" // one word describing their current emotional state
        }

        Transcript:
        "${transcript}"`,
      });

      let extracted: any = {};
      try {
        const clean = rawExtraction.replace(/```json|```/g, "").trim();
        extracted = JSON.parse(clean);
      } catch {
        console.error("Failed to parse psychographic extraction:", rawExtraction);
      }

      const ALLOWED_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
      const ALLOWED_STYLES = ["small_group", "medium_group", "large_social"];
      const safeChapters = (extracted.life_chapters ?? []).filter((c: string) => ALLOWED_CHAPTERS.includes(c));
      const safeStyle = ALLOWED_STYLES.includes(extracted.connection_style) ? extracted.connection_style : "small_group";

      let goalEmbedding: number[] | null = null;
      if (extracted.goals && extracted.goals.length > 0) {
        goalEmbedding = await generateGoalEmbedding(extracted.goals);
      }

      await pool.query(
        `INSERT INTO co_profiles (
          user_id, life_chapters, social_energy, connection_style,
          activity_preferences, emotional_state, goals, blockers,
          availability_pattern, city, goal_embeddings, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          life_chapters = EXCLUDED.life_chapters,
          social_energy = EXCLUDED.social_energy,
          connection_style = EXCLUDED.connection_style,
          activity_preferences = EXCLUDED.activity_preferences,
          emotional_state = EXCLUDED.emotional_state,
          goals = EXCLUDED.goals,
          blockers = EXCLUDED.blockers,
          availability_pattern = EXCLUDED.availability_pattern,
          city = EXCLUDED.city,
          goal_embeddings = EXCLUDED.goal_embeddings,
          updated_at = NOW()`,
        [
          user_id,
          safeChapters,
          extracted.social_energy ?? 50,
          safeStyle,
          extracted.activity_preferences ?? [],
          extracted.emotional_state ?? null,
          extracted.goals ?? [],
          extracted.blockers ?? [],
          extracted.availability_pattern ?? null,
          extracted.city ?? null,
          goalEmbedding ? `[${goalEmbedding.join(",")}]` : null,
        ],
      );

      // Ambient intent capture (non-blocking)
      captureIntent(String(user_id), String(transcript)).catch(() => {});

      _io?.to(`user:${user_id}`).emit("co:profile_ready");

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// GET /co/notifications/:user_id — recent Co activity for the app notification surface
router.get(
  "/notifications/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;

      if (req.user?.id !== user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      const result = await pool.query(
        `SELECT id, memory_type, content, created_at
         FROM co_memories
         WHERE user_id = $1
           AND memory_type IN ('placement', 'moment_invite', 'booking_confirmed')
         ORDER BY created_at DESC
         LIMIT 10`,
        [user_id],
      );
      return res.status(200).send({ success: true, data: result.rows });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/location/:user_id — store GPS coordinates from the app
router.post(
  "/location/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;
      const { latitude, longitude } = req.body as { latitude?: number; longitude?: number };

      if (req.user?.id !== user_id) {
        return res
          .status(403)
          .send("Unauthorized: You can only access your own account");
      }

      if (typeof latitude !== "number" || typeof longitude !== "number") {
        return res.status(400).send("Missing required fields: latitude and longitude (numbers).");
      }

      await pool.query(
        `UPDATE co_profiles
         SET coordinates = ST_SetSRID(ST_MakePoint($1, $2), 4326)
         WHERE user_id = $3`,
        [longitude, latitude, user_id],
      );

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/circles/:circle_id/leave — user leaves a circle; remaining members stay
router.post(
  "/circles/:circle_id/leave",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circle_id } = req.params;
      const user_id = req.user?.id;
      if (!user_id) return res.status(401).send("Unauthorized.");

      const userResult = await pool.query(
        `SELECT first_name, phone_number FROM users WHERE id = $1`,
        [user_id],
      );
      const user = userResult.rows[0];
      if (!user) return res.status(404).send("User not found.");

      await pool.query(
        `DELETE FROM circle_members WHERE circle_id = $1 AND member_id = $2`,
        [circle_id, user_id],
      );

      await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'check_in', $2)`,
        [user_id, `User left circle ${circle_id}`],
      );

      // Notify remaining members via socket and iMessage
      const remainingResult = await pool.query(
        `SELECT u.id, u.phone_number FROM circle_members cm JOIN users u ON u.id = cm.member_id WHERE cm.circle_id = $1`,
        [circle_id],
      );
      const remaining = remainingResult.rows;

      for (const m of remaining) {
        _io?.to(`user:${m.id}`).emit("circle:member_left", { circle_id, user_id });
      }

      // No group chat — each remaining member gets their own text.
      for (const m of remaining) {
        try {
          await sendblue.messages.send({
            number: m.phone_number,
            content: "Your circle is adjusting. Co is on it.",
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error(`Leave-circle message failed for ${m.id}:`, smsErr?.message ?? smsErr);
        }
      }

      // Notify the Moderator
      try {
        await sendblue.messages.send({
          number: process.env.MODERATOR_PHONE_NUMBER!,
          content: `${user.first_name} left circle ${circle_id}. ${remaining.length} members remaining.`,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        console.error("Moderator leave notify failed (non-fatal):", smsErr?.message ?? smsErr);
      }

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
