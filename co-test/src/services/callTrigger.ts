import twilio from "twilio";
import pool from "../../../api/src/db/db.js";
import { prewarmHumeConnection } from "./mediaStreamBridge.js";

// The only real Twilio-dial-and-bridge-to-Hume logic in co-test, extracted
// out of phone.ts's POST /:user_id/call so a second call site (Co
// triggering/offering a call from within an iMessage conversation) can reuse
// it instead of a third copy-pasted implementation — production itself has
// three independent copies of this same logic (api/src/routes/co.ts,
// api/src/jobs/index.ts, and co-test's old inline version here), none
// sharing a helper. This does not replicate production's JWT/subscription
// gate or AMD (machineDetection) options — same intentionally-simplified
// scope the original co-test route had (see phone.ts's route comment):
// proving the dial/bridge/webhook mechanism, not production call quality.
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

export type TriggerCallResult =
  | { success: true; call_sid: string }
  | { success: false; error: string };

export async function triggerCall(userId: string): Promise<TriggerCallResult> {
  const userResult = await pool.query(
    `SELECT phone_number FROM users WHERE id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return { success: false, error: "Session not found." };

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
    // up (confirmed live: same failure mode production's callTrigger.ts
    // documents fixing). asyncAmd connects Hume immediately so a real human
    // faces no delay; the async result arrives as its own callback to
    // /co/call-status, handled there.
    machineDetection: "DetectMessageEnd",
    machineDetectionTimeout: 10,
    asyncAmd: "true",
    asyncAmdStatusCallback: statusCallbackUrl,
    asyncAmdStatusCallbackMethod: "POST",
  });

  // Start the Hume handshake now, during ring time, instead of waiting for
  // the Twilio media stream's "start" event after pickup — see
  // mediaStreamBridge.ts's prewarmHumeConnection for why that pause existed.
  prewarmHumeConnection(userId);

  await pool.query(
    `UPDATE users SET call_sid = $2, call_status = 'initiated' WHERE id = $1`,
    [userId, call.sid],
  );

  return { success: true, call_sid: call.sid };
}
