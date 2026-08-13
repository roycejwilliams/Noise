import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";

// Extracted from co.ts's POST /call/:user_id so a second call site (Co
// triggering a call from within a texting conversation, see sendblue.ts's
// call-offer handling) can reuse the exact same dial/bridge logic instead of
// a slimmer, divergent copy that could regress call quality (e.g. missing
// AMD, or the media-stream <Parameter> user_id delivery).
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

export type TriggerCallResult =
  | { success: true; call_sid: string }
  | { success: false; error: string };

export async function triggerCallForUser(userId: string, io: IOServer | null): Promise<TriggerCallResult> {
  const userResult = await pool.query(
    `SELECT u.first_name, u.phone_number, u.subscription_status, cp.hume_chat_group_id
     FROM users u
     LEFT JOIN co_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return { success: false, error: "User not found." };

  if (process.env.NODE_ENV === "production" && user.subscription_status !== "active") {
    return { success: false, error: "User does not have an active subscription." };
  }

  // Routes the call's audio through our own media-stream WebSocket (see
  // server.ts + services/mediaStreamBridge.ts) instead of Hume's built-in
  // /v0/evi/twilio server-to-server bridge. That endpoint only accepts
  // config_id/api_key as query params — confirmed against Hume's docs — so
  // first_name/context_summary passed alongside it were always silently
  // dropped. Dynamic variables only work via a session_settings message on a
  // live WebSocket connection, which requires something to actually hold
  // that connection; mediaStreamBridge.ts is that something, on our side.
  //
  // user_id travels as a <Parameter>, NOT a query string on the Stream url —
  // confirmed live (and via Twilio's own docs) that Twilio strips query
  // parameters from Media Stream URLs entirely. <Parameter> values arrive in
  // the WebSocket's own "start" event as start.customParameters instead (see
  // mediaStreamBridge.ts).
  //
  // resumed_chat_group_id (hume_chat_group_id) is not carried forward here —
  // chat.connect()'s ConnectSessionSettings has no equivalent field; a call
  // resuming a prior chat group loses that specific continuity mechanism,
  // though buildContextSummary's context_summary variable now covers the
  // same underlying need (picking up from prior context) through a different
  // path.
  const mediaStreamUrl = `${process.env.API_URL!.replace(/^http/, "ws")}/media-stream`;
  const twiml = new twilio.twiml.VoiceResponse();
  const stream = twiml.connect().stream({ url: mediaStreamUrl });
  stream.parameter({ name: "user_id", value: userId });
  const statusCallbackUrl = `${process.env.API_URL}/co/call-status`;

  const call = await twilioClient.calls.create({
    to: user.phone_number,
    from: process.env.TWILIO_PHONE_NUMBER!,
    twiml: twiml.toString(),
    statusCallback: statusCallbackUrl,
    // Twilio's valid event names: initiated, ringing, answered, completed.
    // "completed" fires once for every terminal CallStatus (completed,
    // no-answer, busy, failed, canceled) — that's what drives the immediate
    // missed-call follow-up in co.ts's /co/call-status.
    statusCallbackEvent: ["ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    // Ring for 20s before declaring no-answer, so a missed call gets an
    // immediate follow-up instead of Twilio's 60s default.
    timeout: 20,
    // Without this, a voicemail pickup looks identical to a human answering
    // (CallStatus just becomes "in-progress" either way) — Co would start
    // talking into an answering machine. Must be ASYNC: synchronous AMD (the
    // default) holds the call in silence — no TwiML, no Hume stream — until
    // detection finishes, so a real human who picks up hears nothing for up
    // to machineDetectionTimeout seconds. Async AMD lets Twilio call `url`
    // (Hume) immediately, and delivers AnsweredBy afterward to
    // asyncAmdStatusCallback; see co.ts's /co/call-status.
    machineDetection: "DetectMessageEnd",
    machineDetectionTimeout: 10,
    asyncAmd: "true",
    asyncAmdStatusCallback: statusCallbackUrl,
    asyncAmdStatusCallbackMethod: "POST",
  });

  // Source of truth for /co/webhook's voicemail-skip check now that Hume no
  // longer reliably tells us the call_sid via twilio_metadata (see
  // migrations.ts's users.call_sid column).
  await pool.query(`UPDATE users SET call_sid = $2 WHERE id = $1`, [userId, call.sid]);

  // Store call attempt in co_memories so the status callback has context.
  const attemptContent = `Co initiated call to ${user.first_name} — call_sid: ${call.sid}`;
  const attemptMem = await pool.query(
    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_transcript', $2) RETURNING id`,
    [userId, attemptContent],
  );
  generateEmbedding(attemptContent)
    .then((emb) =>
      pool.query(
        `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
        [`[${emb.join(",")}]`, attemptMem.rows[0].id],
      ),
    )
    .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

  // Tell the app Co's call is on its way — transitions voice screen to Waiting state.
  io?.to(`user:${userId}`).emit("co:call_initiated", { call_sid: call.sid });

  return { success: true, call_sid: call.sid };
}
