import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import { authenticateToken, userRole } from "../middleware/auth.js";
import { generateEmbedding, generateGoalEmbedding } from "../services/embeddings.js";
import { findBestCircle } from "../services/matching.js";
import { findBestVenue } from "../services/places.js";
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
  return twilio.validateRequest(process.env.TWILIO_CLIENT_SECRET!, sig, url, req.body);
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

// Extract intent from a transcript and persist it to co_profiles.intent.
// Called after the psychographic extraction in both webhook and typed-intake paths.
async function captureIntent(user_id: string, transcript: string): Promise<void> {
  try {
    const { text: rawIntent } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `Does this person mention something specific they are actively seeking or could offer to others — a connection, an introduction, a resource, expertise? If yes, extract it as a single clear sentence and classify as 'seeking' or 'offering'. If no specific ask is present, return null.

Return ONLY valid JSON or the word null:
{"text": "Looking for climate tech founders at $1M+ ARR", "type": "seeking"}

Transcript:
"${transcript}"`,
    });

    const clean = rawIntent.replace(/```json|```/g, "").trim();
    if (!clean || clean === "null") return;

    let intentData: { text: string; type: "seeking" | "offering" } | null = null;
    try { intentData = JSON.parse(clean); } catch { return; }
    if (!intentData?.text || !intentData?.type) return;

    const intentId = crypto.randomUUID();
    const embedding = await generateEmbedding(intentData.text).catch(() => null);

    const newIntent = {
      id: intentId,
      text: intentData.text,
      type: intentData.type,
      status: "active",
      embedding,
      created_at: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE co_profiles
       SET intent = COALESCE(intent, '[]'::jsonb) || $1::jsonb
       WHERE user_id = $2`,
      [JSON.stringify([newIntent]), user_id],
    );

    const memContent = `Co captured intent: ${intentData.text}`;
    const mem = await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'intent', $2) RETURNING id`,
      [user_id, memContent],
    );
    generateEmbedding(memContent)
      .then((emb) => pool.query(
        `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
        [`[${emb.join(",")}]`, mem.rows[0].id],
      ))
      .catch((err) => console.error("Intent memory embedding failed:", err));
  } catch (err: any) {
    console.error("captureIntent failed (non-fatal):", err?.message ?? err);
  }
}

// Normalize Hume EVI webhook payload — handles snake_case vs camelCase and
// assembles a flat transcript string from message-array payloads
function normalizeHumePayload(body: any) {
  const customSessionId = body.customSessionId ?? body.custom_session_id ?? body.user_id;
  const chatGroupId = body.chatGroupId ?? body.chat_group_id;

  let transcript = "";
  if (typeof body.transcript === "string") {
    transcript = body.transcript;
  } else {
    const messages: any[] = body.messages ?? (Array.isArray(body.transcript) ? body.transcript : []);
    if (messages.length > 0) {
      transcript = messages
        .map((m) => {
          const role = m.role ?? m.type ?? "unknown";
          const content = m.content ?? m.message?.content ?? m.text ?? "";
          return `${role}: ${content}`;
        })
        .join("\n");
    }
  }

  const emotions = body.emotions ?? body.inferences ?? body.prosody?.scores ?? null;
  const recording_url = body.recording_url ?? body.recordingUrl ?? null;

  return { customSessionId, chatGroupId, transcript, emotions, recording_url };
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
      // start talking into a voicemail box. Hang up immediately and treat it
      // like a missed call rather than letting Hume proceed.
      if (typeof AnsweredBy === "string" && AnsweredBy.startsWith("machine")) {
        if (user) {
          _io?.to(`user:${user.id}`).emit("co:call_completed", { call_sid: CallSid, status: "voicemail" });
        }
        try {
          await twilioClient.calls(CallSid).update({ status: "completed" });
        } catch (hangupErr: any) {
          console.error("Failed to hang up after voicemail detection (non-fatal):", hangupErr?.message ?? hangupErr);
        }
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

// POST /co/webhook — Hume sends call transcript + emotions after call ends
router.post(
  "/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateHumeWebhook(req)) {
        return res.status(401).send("Unauthorized.");
      }

      // Normalize field names — Hume EVI may send snake_case or camelCase,
      // and transcript may be a string or an array of message objects
      const { customSessionId, chatGroupId, transcript, emotions, recording_url } =
        normalizeHumePayload(req.body);
      const user_id = customSessionId;

      if (!user_id || !transcript) {
        return res.status(400).send("Missing required fields.");
      }

      // Let the app know the call ended and Co is now extracting the profile
      _io?.to(`user:${user_id}`).emit("co:processing");

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

      // Step 2 — Extract psychographic data from transcript using Anthropic
      // This is what populates co_profiles so the matching algorithm has data to work with
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
          "emotional_state": "" // one word describing their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout)
        }

        Transcript:
        "${transcript}"`,
      });

      // Step 3 — Parse extracted data
      let extracted: any = {};
      try {
        const clean = rawExtraction.replace(/```json|```/g, "").trim();
        extracted = JSON.parse(clean);
      } catch {
        console.error(
          "Failed to parse psychographic extraction:",
          rawExtraction,
        );
      }

      // Sanitize against DB CHECK constraints before upsert
      const ALLOWED_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
      const ALLOWED_STYLES = ["small_group", "medium_group", "large_social"];
      const safeChapters = (extracted.life_chapters ?? []).filter((c: string) => ALLOWED_CHAPTERS.includes(c));
      const safeStyle = ALLOWED_STYLES.includes(extracted.connection_style) ? extracted.connection_style : "small_group";

      // Step 4 — Generate goal embeddings via OpenAI
      let goalEmbedding: number[] | null = null;
      if (extracted.goals && extracted.goals.length > 0) {
        goalEmbedding = await generateGoalEmbedding(extracted.goals);
      }

      // Step 5 — Update co_profiles with extracted psychographic data
      // Use UPSERT — create profile if it doesn't exist, update if it does
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
          extracted.emotional_state ?? emotions?.[0]?.name ?? null,
          extracted.goals ?? [],
          extracted.blockers ?? [],
          extracted.availability_pattern ?? null,
          extracted.city ?? null,
          goalEmbedding ? `[${goalEmbedding.join(",")}]` : null,
        ],
      );

      // Step 6 — Persist Hume chat group ID so the next call resumes this conversation
      if (chatGroupId) {
        await pool.query(
          `UPDATE co_profiles SET hume_chat_group_id = $1 WHERE user_id = $2`,
          [chatGroupId, user_id],
        );
      }

      // Step 7 — Ambient intent capture (non-blocking — runs in background)
      captureIntent(user_id, transcript).catch(() => {});

      // Profile is fully extracted and stored — tell the app to show the Ready state
      _io?.to(`user:${user_id}`).emit("co:profile_ready");

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

      // Step 4 — Add all matched members to the circle immediately — no gating
      for (const memberId of groupUserIds) {
        if (memberId === user_id) continue; // owner is implicit via owner_id
        await pool.query(
          `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [circle.id, memberId],
        );
      }

      // Step 4.5 — Assign Circle Connector before notifications fire
      const existingConnector = await pool.query(
        `SELECT user_id FROM co_profiles
         WHERE user_id = ANY($1::uuid[]) AND is_circle_connector = TRUE
         LIMIT 1`,
        [groupUserIds],
      );

      if (!existingConnector.rows[0]) {
        const topTrust = await pool.query(
          `SELECT user_id FROM co_profiles
           WHERE user_id = ANY($1::uuid[])
           ORDER BY trust_score DESC
           LIMIT 1`,
          [groupUserIds],
        );

        if (topTrust.rows[0]) {
          const connectorId = topTrust.rows[0].user_id;
          await pool.query(
            `UPDATE co_profiles SET is_circle_connector = TRUE WHERE user_id = $1`,
            [connectorId],
          );
          const connectorContent = `Co selected you as Circle Connector for circle ${circle.id}`;
          const connectorMemory = await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'check_in', $2) RETURNING id`,
            [connectorId, connectorContent],
          );
          generateEmbedding(connectorContent)
            .then((emb) =>
              pool.query(
                `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                [`[${emb.join(",")}]`, connectorMemory.rows[0].id],
              ),
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
        }
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
        `SELECT cm.member_id, cp.activity_preferences, cp.connection_style, cp.life_chapters, cp.city
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
        // Fall back to Google Places + Co scoring
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
        );
      }

      // Step 8 — Create the Moment
      const momentStart = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const momentResult = await pool.query(
        `INSERT INTO moments
         (creator_id, moments_name, location, location_name, moment_start, visibility_type, description, circle_id, vibes, venue, suggested_time, status, venue_booking_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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

      // Step 9 — Notify all circle members, collect phones for consensus poll
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

        await sendSMS({
          phone_number: user.phone_number,
          invite_type: "received",
          invite_target: "moment",
          action_url: `https://app.copatible.com/moments/${moment.id}`,
        });
      }

      // Step 9.5 — Send consensus poll to the group via Sendblue iMessage
      if (memberPhones.length >= 4) {
        const pollMessage = `${momentData.suggested_time ?? "This week"} — does that work for everyone? Reply YES or suggest another time.`;
        try {
          await sendblue.groups.sendMessage({
            numbers: memberPhones,
            content: pollMessage,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error("Sendblue group message failed (non-fatal):", smsErr?.message ?? smsErr);
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

      const prompts: Record<string, string> = {
        circle_placement: `You are Co, an exclusive life concierge. Write a short iMessage to ${user.first_name}. Co has selected their circle. Tone: quiet confidence, like a private members club reaching out. No excitement, no exclamation points. Just certainty. 2 sentences max. No em dashes. Example tone: "Your circle is ready. Five people, same chapter, same city."`,

        moment_invite: `You are Co. Write a short iMessage to ${user.first_name}. Co has arranged an experience: ${context?.moments_name} at ${context?.venue}, ${context?.suggested_time}. Tone: like a personal concierge confirming a reservation. Brief, confident, specific. 2 sentences max. No em dashes.`,

        payment_link: `You are Co. Write a short iMessage to ${user.first_name} to secure their spot for ${context?.moments_name}. Include the payment link: ${context?.payment_url}. Tone: matter of fact, not salesy. Like confirming a dinner reservation deposit. 2 sentences max. No em dashes.`,

        check_in: `You are Co. Write a short iMessage to ${user.first_name} following up after their circle experience. Tone: like a thoughtful friend checking in, not a survey. One question only. 1 sentence max. No em dashes.`,

        life_concierge: `You are Co. ${user.first_name} said: "${context?.user_message}".${lifeConcieregeContext ? `\n\nContext from past conversations:\n${lifeConcieregeContext}` : ""} Respond as Co — specific, warm, actionable. Co knows ${user.first_name} well. No filler phrases. 2 sentences max. No em dashes.`,
      };

      const prompt = prompts[message_type] ?? prompts.circle_placement;

      const { text: coMessage } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt,
      });

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

//POST /message/group/:circle_id - Co sends a message to the whole circle
router.post(
  "/message/group/:circle_id",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circle_id } = req.params;
      const { message_type, context } = req.body;

      // Fetch all members with phone numbers
      const groupMembers = await pool.query(
        `SELECT u.id, u.first_name, u.phone_number 
         FROM circle_members cm
         JOIN users u ON cm.member_id = u.id
         WHERE cm.circle_id = $1`,
        [circle_id],
      );

      const members = groupMembers.rows;

      if (members.length < 4) {
        return res.status(400).send("Not enough members in the group.");
      }

      const prompts: Record<string, string> = {
        circle_placement: `You are Co, an exclusive life concierge. Write a short group iMessage welcoming this circle of ${members.length} people. They were selected for each other. Tone: quiet confidence. No exclamation points. 2 sentences max. No em dashes.`,

        moment_invite: `You are Co. Write a short group iMessage to this circle about their upcoming experience: ${context?.moments_name} at ${context?.venue}, ${context?.suggested_time}. Tone: like a personal concierge confirming a reservation. 2 sentences max. No em dashes.`,

        payment_link: `You are Co. Write a short group iMessage to this circle to secure their spots for ${context?.moments_name}. Payment link: ${context?.payment_url}. Split ${members.length} ways. Matter of fact, not salesy. 2 sentences max. No em dashes.`,

        check_in: `You are Co. Write a short group iMessage following up with this circle after their experience together. One question only. Warm but brief. 1 sentence max. No em dashes.`,
      };

      const prompt = prompts[message_type] ?? prompts.circle_placement;

      // Generate Co's group message
      const { text: coMessage } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt: prompt,
      });

      // Voice notes for emotional touchpoints — payment_link stays text (carries a URL)
      const useGroupVoice = ["circle_placement", "moment_invite", "check_in"].includes(message_type);
      let groupAudioUrl: string | null = null;
      if (useGroupVoice) {
        try {
          groupAudioUrl = await generateVoiceNote(coMessage);
        } catch (voiceErr: any) {
          console.error("Group voice note generation failed, falling back to text:", voiceErr?.message ?? voiceErr);
        }
      }

      // Send as group message via Sendblue
      const numbers = members.map((m: any) => m.phone_number);

      let groupMessage: any = null;
      try {
        groupMessage = await sendblue.groups.sendMessage({
          numbers,
          content: groupAudioUrl ? "" : coMessage,
          ...(groupAudioUrl ? { media_url: groupAudioUrl } : {}),
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        const errMsg = smsErr?.message ?? String(smsErr);
        console.error(`Sendblue group message failed for circle ${circle_id}:`, errMsg);
        for (const member of members) {
          const grpFailContent = `Co failed to send message to ${member.id}: ${errMsg}`;
          const grpFailMemory = await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'text_exchange', $2) RETURNING id`,
            [member.id, grpFailContent],
          );
          generateEmbedding(grpFailContent)
            .then((emb) =>
              pool.query(
                `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
                [`[${emb.join(",")}]`, grpFailMemory.rows[0].id],
              ),
            )
            .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
        }
      }

      // Store in co_memories for each member
      for (const member of members) {
        const grpMemory = await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2) RETURNING id`,
          [member.id, coMessage],
        );
        generateEmbedding(coMessage)
          .then((emb) =>
            pool.query(
              `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
              [`[${emb.join(",")}]`, grpMemory.rows[0].id],
            ),
          )
          .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
      }

      return res.status(200).send({
        success: true,
        message_handle: groupMessage?.message_handle ?? null,
        status: groupMessage?.status ?? "send_failed",
        member_count: members.length,
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

      const remainingPhones = remaining.map((m: any) => m.phone_number);
      if (remainingPhones.length > 0) {
        try {
          await sendblue.groups.sendMessage({
            numbers: remainingPhones,
            content: "Your circle is adjusting. Co is on it.",
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error("Leave-circle group message failed (non-fatal):", smsErr?.message ?? smsErr);
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
