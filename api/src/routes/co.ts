import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { sendEmail } from "../otpActions.js";
import { authenticateToken, userRole } from "../middleware/auth.js";
import { generateEmbedding } from "../services/embeddings.js";
import { findBestCircle } from "../services/matching.js";
import { findBestVenue } from "../services/places.js";
import { generateCandidateWindows, type CandidateWindow } from "../services/scheduling.js";
import {
  assessConversationCoverage,
  captureIntent,
  extractPsychographicProfile,
  RAPPORT_TOPICS,
  storeProfile,
  storeTranscriptMemory,
} from "../services/profileExtraction.js";
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

// Reject status callbacks that didn't come from Twilio
function validateTwilioSignature(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const sig = req.headers["x-twilio-signature"] as string | undefined;
  if (!sig) return false;
  const url = `${process.env.API_URL}/co/call-status`;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN!, sig, url, req.body);
}

// Reject webhook calls that didn't come from Hume (bearer token set in EVI config)
function validateHumeWebhook(req: Request): boolean {
  const secret = process.env.HUME_WEBHOOK_SECRET;
  if (!secret) return true; // skip when not configured (dev)
  const header = req.headers["x-hume-signature"] ?? req.headers["authorization"]?.toString().replace("Bearer ", "");
  if (!header) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header as string), Buffer.from(secret));
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

      const userResult = await pool.query(
        `SELECT u.first_name, u.phone_number, u.subscription_status, cp.hume_chat_group_id
         FROM users u
         LEFT JOIN co_profiles cp ON cp.user_id = u.id
         WHERE u.id = $1`,
        [user_id],
      );

      const user = userResult.rows[0];

      if (!user) return res.status(404).send("User not found.");

      if (process.env.NODE_ENV === "production" && user.subscription_status !== "active") {
        return res.status(403).send("User does not have an active subscription.");
      }

      // Inject user identity so Hume sends it back in the webhook (customSessionId → user_id)
      // first_name is available as {{first_name}} in the Hume EVI system prompt
      // Resume prior chat group if one exists so Co picks up the conversation where it left off
      const webhookParams = new URLSearchParams({
        config_id: process.env.HUME_CONFIG_ID!,
        api_key: process.env.HUME_API_KEY!,
        custom_session_id: user_id as string,
        first_name: user.first_name ?? "",
      });
      if (user.hume_chat_group_id) {
        webhookParams.set("resumed_chat_group_id", user.hume_chat_group_id);
      }
      const webhookUrl = `https://api.hume.ai/v0/evi/twilio?${webhookParams.toString()}`;
      const statusCallbackUrl = `${process.env.API_URL}/co/call-status`;

      const call = await twilioClient.calls.create({
        to: user.phone_number,
        from: process.env.TWILIO_PHONE_NUMBER!,
        url: webhookUrl,
        statusCallback: statusCallbackUrl,
        // Twilio's valid event names: initiated, ringing, answered, completed.
        // "completed" fires once for every terminal CallStatus (completed,
        // no-answer, busy, failed, canceled) — that's what drives the
        // immediate missed-call follow-up below.
        statusCallbackEvent: ["ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
        // Ring for 20s before declaring no-answer, so a missed call gets an
        // immediate follow-up instead of Twilio's 60s default.
        timeout: 20,
        // Without this, a voicemail pickup looks identical to a human
        // answering (CallStatus just becomes "in-progress" either way) — Co
        // would start talking into an answering machine. Must be ASYNC:
        // synchronous AMD (the default) holds the call in silence — no TwiML,
        // no Hume stream — until detection finishes, so a real human who
        // picks up hears nothing for up to machineDetectionTimeout seconds.
        // Async AMD lets Twilio call `url` (Hume) immediately, and delivers
        // AnsweredBy afterward to asyncAmdStatusCallback; see /co/call-status.
        machineDetection: "DetectMessageEnd",
        machineDetectionTimeout: 10,
        asyncAmd: "true",
        asyncAmdStatusCallback: statusCallbackUrl,
        asyncAmdStatusCallbackMethod: "POST",
      });

      // Store call attempt in co_memories so status callback has context
      const attemptContent = `Co initiated call to ${user.first_name} — call_sid: ${call.sid}`;
      const attemptMem = await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_transcript', $2) RETURNING id`,
        [user_id, attemptContent],
      );
      generateEmbedding(attemptContent)
        .then((emb) =>
          pool.query(
            `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
            [`[${emb.join(",")}]`, attemptMem.rows[0].id],
          ),
        )
        .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

      // Tell the app Co's call is on its way — transitions voice screen to Waiting state
      _io?.to(`user:${user_id}`).emit("co:call_initiated", { call_sid: call.sid });

      return res.status(200).send({
        success: true,
        call_sid: call.sid,
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

      // Async AMD result arrives as its own, differently-shaped callback —
      // only MachineDetectionDuration/CallSid/AnsweredBy/AccountSid, no
      // CallStatus or To at all. It MUST be handled before the CallStatus/To
      // guard below, which would otherwise silently discard it (confirmed
      // live: this previously left Hume talking into a real voicemail box
      // for the entire call, since neither the redirect nor the follow-up
      // ever ran).
      if (typeof AnsweredBy === "string") {
        if (!AnsweredBy.startsWith("machine")) {
          // human/fax/unknown — the live Hume conversation is already
          // proceeding correctly, nothing to do here.
          return res.sendStatus(204);
        }

        // This callback has no `To` — resolve the destination number from
        // Twilio's own call record instead.
        let toNumber: string | null = To ?? null;
        if (!toNumber) {
          try {
            const call = await twilioClient.calls(CallSid).fetch();
            toNumber = call.to;
          } catch (fetchErr: any) {
            console.error(`Failed to fetch call ${CallSid} for AMD user lookup:`, fetchErr?.message ?? fetchErr);
          }
        }

        const user = toNumber
          ? (
              await pool.query(
                `SELECT id, first_name, phone_number FROM users WHERE phone_number = $1`,
                [toNumber],
              )
            ).rows[0]
          : null;

        // AMD detected an answering machine/voicemail — Hume has already been
        // talking on the line for a few seconds (async AMD connects Hume
        // immediately so real humans face no delay; the tradeoff is Hume
        // doesn't yet know it's a machine). An abrupt hangup here just cuts
        // Hume off mid-sentence into the person's real voicemail box.
        // Instead, redirect the still-live call to our own TwiML so Co
        // leaves one deliberate, complete voicemail line before hanging up
        // cleanly.
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
        // Flag this call so the Hume chat_ended webhook (which still fires
        // normally since we hang up cleanly, not abruptly) skips the
        // full extraction/follow-up pipeline below.
        await pool.query(
          `INSERT INTO voicemail_calls (call_sid) VALUES ($1) ON CONFLICT DO NOTHING`,
          [CallSid],
        );
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

      // Calls that never connected to anything (no human, no machine) don't
      // get an instant follow-up — that reads as robotic. Queue it for the
      // delayed-follow-up cron (2hrs later, see jobs/index.ts) instead.
      if (!["no-answer", "busy", "failed", "canceled"].includes(CallStatus)) {
        return res.sendStatus(204);
      }

      // Unknown number — nothing to do, ack so Twilio doesn't retry
      if (!user) {
        console.warn(`call-status: no user found for number ${To} (${CallStatus})`);
        return res.sendStatus(204);
      }

      await pool.query(
        `INSERT INTO pending_call_followups (user_id, call_sid, call_status, due_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '2 hours')`,
        [user.id, CallSid, CallStatus],
      );

      return res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  },
);

type HumeToolCallMessage = {
  tool_call_id: string;
  name: string;
};

// Answers a pending tool_call via Hume's Control Plane — separate from the
// webhook's own HTTP response, since EVI is waiting on this over the live
// chat, not over the webhook connection. No parallel tool calls on EVI's
// side, so the live call is silent from the moment the tool_call event fires
// until this resolves — see assessConversationCoverage for why Haiku, not
// Sonnet.
async function sendHumeToolResponse(chatId: string, toolCallId: string, content: string): Promise<void> {
  const res = await fetch(`https://api.hume.ai/v0/evi/chat/${chatId}/send`, {
    method: "POST",
    headers: {
      "X-Hume-Api-Key": process.env.HUME_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "tool_response", tool_call_id: toolCallId, content }),
  });
  if (!res.ok) {
    console.error(`co/webhook: tool response POST failed (${res.status}) for chat ${chatId}, tool_call ${toolCallId}`);
  }
}

// Only assess_conversation_coverage exists today — if more tools land here,
// switch on tool_call_message.name rather than growing this function.
async function handleToolCall(chatId: string, toolCallMessage: HumeToolCallMessage | undefined): Promise<void> {
  if (!toolCallMessage || toolCallMessage.name !== "assess_conversation_coverage") return;

  try {
    const { transcript } = await fetchHumeCallData(chatId);
    const assessment = await assessConversationCoverage(transcript);
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
// tool_call (all three are registered on the config). chat_ended drives the
// full post-call extraction pipeline below — the payload itself carries no
// transcript, so it's fetched separately from Hume's Chat Events API using
// chat_id. tool_call is answered asynchronously via the Control Plane (see
// handleToolCall) — this route just acks Hume's webhook and kicks it off.
// chat_started stays acknowledged-and-ignored; nothing to do at call start.
router.post(
  "/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateHumeWebhook(req)) {
        return res.status(401).send("Unauthorized.");
      }

      const { event_name, custom_session_id, chat_id, chat_group_id, twilio_metadata, tool_call_message } = req.body;

      if (event_name === "tool_call") {
        res.status(200).send({ success: true });
        handleToolCall(chat_id, tool_call_message).catch((err) =>
          console.error("co/webhook: unhandled tool_call error:", err?.message ?? err),
        );
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
        console.error(`co/webhook: could not resolve user for chat ${chat_id} — body: ${JSON.stringify(req.body)}`);
        return res.status(400).send("Missing required fields.");
      }

      if (!callUser) {
        const byId = await pool.query(`SELECT id, first_name, phone_number FROM users WHERE id = $1`, [user_id]);
        callUser = byId.rows[0] ?? null;
      }

      // The AMD callback already flagged this call as an answering
      // machine/voicemail and sent its own instant follow-up — skip the
      // extraction/follow-up pipeline below so we don't hallucinate a
      // "reflection" on lines Co said to a voicemail box.
      if (twilio_metadata?.call_sid) {
        const flagged = await pool.query(
          `SELECT 1 FROM voicemail_calls WHERE call_sid = $1`,
          [twilio_metadata.call_sid],
        );
        if (flagged.rows.length > 0) {
          console.log(`co/webhook: skipping extraction/follow-up for voicemail call ${twilio_metadata.call_sid}`);
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
      await storeTranscriptMemory(user_id, transcript, {
        emotionalContext: emotions,
        audioUrl: recording_url,
      });

      // Steps 2-5 — Extract psychographic data via Anthropic, sanitize against
      // DB CHECK constraints, generate goal embeddings, and upsert co_profiles.
      // Shared with the typed-intake fallback and co-test — see profileExtraction.ts.
      const { extracted } = await extractPsychographicProfile(transcript);
      await storeProfile(user_id, extracted, transcript, { emotions });

      // Step 6 — Persist Hume chat group ID so the next call resumes this conversation
      if (chat_group_id) {
        await pool.query(
          `UPDATE co_profiles SET hume_chat_group_id = $1 WHERE user_id = $2`,
          [chat_group_id, user_id],
        );
      }

      // Step 7 — Ambient intent capture (non-blocking — runs in background)
      captureIntent(user_id, transcript).catch(() => {});

      // Profile is fully extracted and stored — tell the app to show the Ready state
      _io?.to(`user:${user_id}`).emit("co:profile_ready");

      // Step 8 — Follow-up iMessage. The app only shows "Ready" if it happens
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
      // Returns array of user IDs or null if no valid group found
      const groupUserIds = await findBestCircle(user_id);

      // Step 2 — No match found — flag for manual placement by Keana
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

      // Step 5 — Notify Keana via iMessage for approval before any member is contacted
      const memberNamesResult = await pool.query(
        `SELECT first_name FROM users WHERE id = ANY($1::uuid[])`,
        [groupUserIds],
      );
      const memberNames = memberNamesResult.rows.map((r: any) => r.first_name).join(", ");
      const city = profile.city ?? "unknown city";
      const chapter = primaryChapter.replace(/_/g, " ");

      try {
        await sendblue.messages.send({
          number: process.env.KEANA_PHONE_NUMBER!,
          content: `New circle ready for review. ${groupUserIds.length} people, ${city}, ${chapter}. Members: ${memberNames}. Reply APPROVE or REJECT within 4 hours — Co will auto-approve if no response.`,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
        await pool.query(
          `UPDATE circles SET keana_notified_at = NOW() WHERE id = $1`,
          [circle.id],
        );
      } catch (keanaErr: any) {
        console.error("Failed to notify Keana of pending circle:", keanaErr?.message ?? keanaErr);
      }

      // Step 6 — Store pending-approval memory for each member
      for (const memberId of groupUserIds) {
        const placementContent = `Circle placement pending Keana approval`;
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

// Venue selection — partner venues first, then Google Places. Pulled out of
// createMomentForCircle so the Keana venue-approval reject path (sendblue.ts)
// can re-run it after a rejection, excluding whatever's already been turned
// down for this moment instead of just re-rolling the exact same pick.
export async function selectVenueForCircle(
  city: string,
  venueType: string,
  neighborhood: string,
  groupSize: number,
  circleProfile: {
    vibe: string;
    life_chapters: string[];
    connection_style: string;
    group_size: number;
  },
  excludeNames: string[] = [],
): Promise<any | null> {
  const partnerVenue = await pool.query(
    `SELECT * FROM co_venues
     WHERE city = $1
     AND type = $2
     AND active = TRUE
     AND (capacity_max IS NULL OR capacity_max >= $3)
     AND NOT (name = ANY($4::text[]))
     ORDER BY RANDOM()
     LIMIT 1`,
    [city, venueType, groupSize, excludeNames],
  );

  if (partnerVenue.rows[0]) {
    const contact: string = partnerVenue.rows[0].contact ?? "";
    const partnerBookingUrl = contact.startsWith("http") ? contact : null;

    return {
      name: partnerVenue.rows[0].name,
      formatted_address: partnerVenue.rows[0].neighborhood,
      co_reason: "CoPatible partner venue",
      booking_method: partnerVenue.rows[0].booking_method,
      contact: partnerVenue.rows[0].contact,
      payment_tier: partnerVenue.rows[0].payment_tier,
      venue_booking_url: partnerBookingUrl,
    };
  }

  // Fall back to Google Places + Co scoring — city string only, no
  // GPS-based geo bias/filter (see note above findBestVenue call site).
  return findBestVenue(venueType, neighborhood, city, circleProfile, undefined, excludeNames);
}

// Steps 1-6 of createMomentForCircle's setup — pulled out so the Keana
// venue-rejection path (sendblue.ts) can rebuild the same circle context
// (city, group size, dominant style, shared chapters) without duplicating
// this aggregation when it needs to re-run venue selection.
export async function getCircleBookingContext(circle_id: string) {
  // Fetch only members who've actually accepted their circle invite. Anyone
  // still 'pending' hasn't opted in yet and was never notified of this
  // moment — including them here would inflate the consensus denominator
  // with people who don't even know the moment exists.
  const membersResult = await pool.query(
    `SELECT cm.member_id, cp.activity_preferences, cp.connection_style, cp.life_chapters, cp.city, cp.availability_pattern
     FROM circle_members cm
     JOIN co_profiles cp ON cp.user_id = cm.member_id
     WHERE cm.circle_id = $1 AND cm.status = 'accepted'`,
    [circle_id],
  );

  const members = membersResult.rows;
  if (!members.length) return null;

  const circleResult = await pool.query(
    `SELECT owner_id FROM circles WHERE id = $1`,
    [circle_id],
  );
  const circle = circleResult.rows[0];
  if (!circle) return null;

  // Find most common activity preferences across the group
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

  // Get dominant connection style
  const connectionStyles = members.map((m) => m.connection_style);
  //After checking all items, the array is rearranged so the most frequent styles are first:
  const dominantStyle =
    connectionStyles.sort(
      (a: string, b: string) =>
        connectionStyles.filter((s: string) => s === b).length -
        connectionStyles.filter((s: string) => s === a).length,
    )[0] || "small_group";

  // Get shared life chapters
  const allChapters = members.flatMap((m) => m.life_chapters);
  const uniqueChapters = [...new Set(allChapters)];

  const city = members[0].city ?? "San Francisco";
  const groupSize = members.length;

  return { members, circle, topActivities, dominantStyle, uniqueChapters, city, groupSize };
}

// Creates a Moment for a circle without texting anyone — used both by the
// admin-triggered route below (which notifies everyone immediately after)
// and by the circle-accept flow in sendblue.ts (which only reveals the
// moment to members as they individually accept their circle invite).
export async function createMomentForCircle(circle_id: string) {
  const context = await getCircleBookingContext(circle_id);
  if (!context) return null;
  const { members, circle, topActivities, dominantStyle, uniqueChapters, city, groupSize } = context;

      // City (the text string, not GPS coordinates) is the sole geographic
      // authority for venue search — a member's coordinates are never used
      // to bias or hard-filter this. Confirmed for real: a single stale
      // coordinate (leftover test data pointing at NYC for an SF user) sent
      // an entire circle's venue search across the country, and the "hard"
      // distance filter didn't catch it because it enforced proximity to
      // that same bad point, not the circle's actual city.

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
        return null;
      }

      // Truncate description as safety measure
      momentData.description = momentData.description?.slice(0, 390) ?? "";

      // Step 7.5 — Find best venue (partner venues first, then Google Places)
      const selectedVenue = await selectVenueForCircle(
        city,
        momentData.venue_type,
        momentData.neighborhood,
        groupSize,
        {
          vibe: momentData.vibe,
          life_chapters: uniqueChapters,
          connection_style: dominantStyle,
          group_size: groupSize,
        },
      );

      // Step 8 — Create the Moment
      const momentStart = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // Simultaneous availability poll's candidate windows — computed here
      // (once, shared by every member) from the venue's real opening hours
      // plus the circle's stated schedule preferences, so it's grounded
      // instead of the single free-text suggested_time guess above. Only
      // worth the extra LLM call for groups large enough to actually get a
      // poll (see the groupSize >= 4 gate downstream in notifyMemberOfMoment).
      // Falls back to an empty array (and the old single-time poll) if this
      // fails or the venue's hours were never resolved.
      const candidateWindows: CandidateWindow[] =
        groupSize >= 4
          ? await generateCandidateWindows(
              selectedVenue?.opening_hours_periods,
              members.map((m: any) => m.availability_pattern),
              momentData.venue_type,
            )
          : [];

      const momentResult = await pool.query(
        `INSERT INTO moments
         (creator_id, moments_name, location, location_name, moment_start, visibility_type, description, circle_id, vibes, venue, suggested_time, status, venue_booking_url, venue_place_id, venue_type, vibe, neighborhood, candidate_windows)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
          "polling",
          selectedVenue?.venue_booking_url ?? null,
          selectedVenue?.place_id ?? null,
          momentData.venue_type ?? null,
          momentData.vibe ?? null,
          momentData.neighborhood ?? null,
          candidateWindows.length ? JSON.stringify(candidateWindows) : null,
        ],
      );

      const moment = momentResult.rows[0];

      // Pre-warm OG image before any iMessage links go out — avoids preview timeout
      fetch(`https://app.copatible.com/api/og/moments/${moment.id}`).catch(() => {});

      // Step 8.5 — Seed moment_responses for each circle member, including the
      // owner (now a normal circle_members row too) — null = awaiting reply.
      const responseUserIds = members.map((m: any) => m.member_id);
      for (const userId of responseUserIds) {
        await pool.query(
          `INSERT INTO moment_responses (moment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [moment.id, userId],
        );
      }

  return { moment, selectedVenue, momentData, members, circle };
}

// Reveals a moment to exactly one member — used per-member as each person
// accepts their circle invite, and by the admin route below (looped over
// every member) for the direct manual-trigger path. CoPatible has no group
// chat, so this is always a 1:1 send, never broadcast to the whole circle
// at once.
export async function notifyMemberOfMoment(
  moment: any,
  selectedVenue: any,
  momentData: any,
  member: { member_id: string },
  groupSize: number,
) {
  const momentDateStr = new Date(moment.moment_start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const momentTimeStr = new Date(moment.moment_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const momentInviteMsg = `Co arranged something for your circle. ${moment.moments_name} at ${selectedVenue?.name ?? momentData.neighborhood}, ${momentData.suggested_time ?? `${momentDateStr} at ${momentTimeStr}`}.\nhttps://app.copatible.com/moments/${moment.id}`;

  const userResult = await pool.query(
    `SELECT email, phone_number FROM users WHERE id = $1`,
    [member.member_id],
  );
  const user = userResult.rows[0];
  if (!user) return;

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

  // Consensus poll — only meaningful once the group's actually large enough.
  // Simultaneous availability poll when candidate_windows exist (the normal
  // case); falls back to the original single-time yes/no poll for older
  // in-flight moments, or if window generation failed at creation time.
  if (groupSize >= 4) {
    const candidateWindows: CandidateWindow[] = moment.candidate_windows ?? [];
    const pollMessage = candidateWindows.length
      ? `Which of these work for your circle's ${moment.moments_name} at ${selectedVenue?.name ?? momentData.neighborhood}?\n${candidateWindows
          .map((w, i) => `${i + 1}. ${w.label}`)
          .join("\n")}\nReply with the number(s), or NO if none work.`
      : `Does ${momentData.suggested_time ?? "this time"} work for you? Reply YES or NO.`;
    try {
      await sendblue.messages.send({
        number: user.phone_number,
        content: pollMessage,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (smsErr: any) {
      console.error(`Consensus poll message failed for ${member.member_id}:`, smsErr?.message ?? smsErr);
    }
  }

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

// POST /co/moment/:circle_id — Co creates a Moment for a placed circle and
// notifies every member immediately (manual admin trigger — the organic
// path is per-member reveal on circle acceptance, in sendblue.ts).
router.post(
  "/moment/:circle_id",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const circle_id = req.params.circle_id as string;
      const created = await createMomentForCircle(circle_id);
      if (!created) return res.status(404).send("Circle not found.");

      const { moment, selectedVenue, momentData, members } = created;

      for (const member of members) {
        await notifyMemberOfMoment(moment, selectedVenue, momentData, member, members.length);
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

// Shared by the app-driven propose-time route below and the "time: X"
// iMessage reply path in sendblue.ts — both are gated to the Circle
// Connector only. Sets the new candidate time, clears prior yes/no
// responses since they were for the old time, and re-asks every member
// individually — no group chat.
export async function proposeNewTimeForMoment(moment_id: string, dateObj: Date) {
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

  return { moment_start: dateObj.toISOString(), suggested_time: suggestedTime };
}

// Checks whether user_id is actually part of circle_id (owner or accepted
// member) — shared by the propose-time route and the "time: X" text-reply
// path, both of which are open to any circle member.
export async function isCircleMember(user_id: string, circle_id: string): Promise<boolean> {
  const memberCheck = await pool.query(
    `SELECT 1 WHERE
       EXISTS (SELECT 1 FROM circles c WHERE c.id = $2 AND c.owner_id = $1)
       OR EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = $2 AND cm.member_id = $1)`,
    [user_id, circle_id],
  );
  return !!memberCheck.rows[0];
}

// POST /co/moment/:moment_id/propose-time — any circle member can pick a
// specific date/time from the app (mirrors what a "time: X" iMessage reply
// does over text, in sendblue.ts).
router.post(
  "/moment/:moment_id/propose-time",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const moment_id = req.params.moment_id as string;
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

      if (!(await isCircleMember(user_id, circle_id))) {
        return res.status(403).send("You're not a member of this circle.");
      }

      const dateObj = new Date(moment_start);
      if (Number.isNaN(dateObj.getTime())) {
        return res.status(400).send("moment_start must be a valid date.");
      }

      const result = await proposeNewTimeForMoment(moment_id, dateObj);
      return res.status(200).send({ success: true, ...result });
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
        ? `${coMessage}\n${circlePageUrl}`
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
      await storeTranscriptMemory(user_id, transcript);

      // Same extraction + sanitize + upsert used by the Hume webhook — see profileExtraction.ts
      const { extracted } = await extractPsychographicProfile(transcript);
      await storeProfile(user_id, extracted, transcript);

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

      // Notify Keana
      try {
        await sendblue.messages.send({
          number: process.env.KEANA_PHONE_NUMBER!,
          content: `${user.first_name} left circle ${circle_id}. ${remaining.length} members remaining.`,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        console.error("Keana leave notify failed (non-fatal):", smsErr?.message ?? smsErr);
      }

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
