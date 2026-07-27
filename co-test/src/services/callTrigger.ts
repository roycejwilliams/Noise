import twilio from "twilio";
import pool from "../../../api/src/db/db.js";

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
    `SELECT first_name, phone_number FROM users WHERE id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return { success: false, error: "Session not found." };

  const webhookParams = new URLSearchParams({
    config_id: process.env.HUME_CONFIG_ID!,
    api_key: process.env.HUME_API_KEY!,
    custom_session_id: String(userId),
    first_name: user.first_name ?? "",
  });
  const webhookUrl = `https://api.hume.ai/v0/evi/twilio?${webhookParams.toString()}`;
  const statusCallbackUrl = `${process.env.API_URL}/co/call-status`;

  const call = await twilioClient.calls.create({
    to: user.phone_number,
    from: process.env.TWILIO_PHONE_NUMBER!,
    url: webhookUrl,
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ["ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 20,
  });

  await pool.query(
    `UPDATE users SET call_sid = $2, call_status = 'initiated' WHERE id = $1`,
    [userId, call.sid],
  );

  return { success: true, call_sid: call.sid };
}
