import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";
import { issueStreamAuthToken, prewarmHumeConnection } from "./mediaStreamBridge.js";
import { recordDecision } from "../harness/core.js";
import { decideCall, gatherCallState, type CallAuthorization } from "../harness/callGate.js";

// Extracted from co.ts's POST /call/:user_id so a second call site (Co
// triggering a call from within a texting conversation, see sendblue.ts's
// call-offer handling) can reuse the exact same Twilio-dial-and-bridge logic
// — AMD/voicemail handling included — instead of a slimmer, divergent copy
// that could regress call quality (e.g. Co talking into a voicemail box with
// no AMD). jobs/index.ts's proactive/scheduled/auto-intake cron jobs also
// call this directly now, rather than each keeping its own copy of the dial
// logic.
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

export type TriggerCallResult =
  | { success: true; call_sid: string }
  | { success: false; error: string };

// Every dial goes through the Layer 8 gate (src/harness/callGate.ts): live
// call status (with the 30-minute reclaim for a status stuck after a missed
// chat_ended webhook), opt-out, subscription, local hours for calls Co starts
// itself, no call placed in the last few minutes, and something that
// actually authorizes this call. Pass `auth` when the caller knows why it is
// calling; otherwise the gate infers it from the database and records that.
export async function triggerCallForUser(
  userId: string,
  io: IOServer | null,
  auth: CallAuthorization | null = null,
): Promise<TriggerCallResult> {
  const userResult = await pool.query(
    `SELECT u.first_name, u.phone_number, u.subscription_status, u.call_status, u.call_status_updated_at
     FROM users u
     WHERE u.id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return { success: false, error: "User not found." };

  const callState = await gatherCallState(userId, user, auth);
  const gateResult = decideCall(callState, auth, new Date());
  await recordDecision({
    layer: 8,
    decision: "call.gate",
    userId,
    outcome: gateResult.allowed ? "act" : "skip",
    action: gateResult.allowed ? "place_call" : "blocked",
    proposal: { requested: auth, evidence: callState.evidence },
    checks: gateResult.checks,
    reason: gateResult.authorization ? `${gateResult.inferred ? "inferred " : ""}${gateResult.authorization}` : null,
  });
  if (!gateResult.allowed) {
    return { success: false, error: gateResult.error ?? "Call blocked." };
  }

  const statusCallbackUrl = `${process.env.API_URL}/co/call-status`;

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
  // confirmed live and via Twilio's own docs that Twilio strips query
  // parameters from Media Stream URLs entirely. <Parameter> values arrive in
  // the WebSocket's own "start" event as start.customParameters instead (see
  // mediaStreamBridge.ts), which is the only place this is actually reachable.
  const mediaStreamUrl = `${process.env.API_URL!.replace(/^http/, "ws")}/media-stream`;
  const twiml = new twilio.twiml.VoiceResponse();
  const stream = twiml.connect().stream({ url: mediaStreamUrl });
  stream.parameter({ name: "user_id", value: userId });
  // Security fix, 2026-09-17: the bridge no longer trusts user_id above on
  // its own — see mediaStreamBridge.ts's "media-stream auth" section. The
  // call's real CallSid doesn't exist yet at this point (Twilio only
  // assigns it once twilioClient.calls.create() below returns), so this
  // can't be bound to a callSid the way the inbound path can; a single-use,
  // short-lived opaque token tied only to userId is enough — it's never
  // derivable by anyone who isn't this server or the real Twilio media
  // stream for this exact call.
  stream.parameter({ name: "auth", value: issueStreamAuthToken(userId) });

  const call = await twilioClient.calls.create({
    to: user.phone_number,
    from: process.env.TWILIO_PHONE_NUMBER!,
    twiml: twiml.toString(),
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ["ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 20,
    // Without this, a voicemail pickup was indistinguishable from a human
    // answering — Hume just kept having its normal live conversation into
    // the answering machine instead of leaving a deliberate line and hanging
    // up. asyncAmd connects Hume immediately so a real human faces no delay;
    // the async result arrives as its own callback to /co/call-status,
    // handled there.
    machineDetection: "DetectMessageEnd",
    machineDetectionTimeout: 10,
    asyncAmd: "true",
    asyncAmdStatusCallback: statusCallbackUrl,
    asyncAmdStatusCallbackMethod: "POST",
  });

  // Start the Hume handshake now, during ring time, instead of waiting for
  // the Twilio media stream's "start" event after pickup — see
  // mediaStreamBridge.ts's prewarmHumeConnection for why that pause existed.
  // Passes this call's real CallSid so two overlapping calls to the same
  // user each get their own prewarmed connection instead of colliding.
  prewarmHumeConnection(userId, call.sid);

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

  await pool.query(
    `UPDATE users SET call_sid = $2, call_status = 'initiated', call_status_updated_at = NOW() WHERE id = $1`,
    [userId, call.sid],
  );

  io?.to(`user:${userId}`).emit("co:call_initiated", { call_sid: call.sid });

  return { success: true, call_sid: call.sid };
}
