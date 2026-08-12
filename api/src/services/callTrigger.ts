import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";

// Extracted from co.ts's POST /call/:user_id so a second call site (Co
// triggering a call from within a texting conversation, see sendblue.ts's
// call-offer handling) can reuse the exact same Twilio-dial-and-bridge logic
// — AMD/voicemail handling included — instead of a slimmer, divergent copy
// that could regress call quality (e.g. Co talking into a voicemail box with
// no AMD). jobs/index.ts still has its own independent copy of this same
// logic; not touched here — out of scope for this change.
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

  const webhookParams = new URLSearchParams({
    config_id: process.env.HUME_CONFIG_ID!,
    api_key: process.env.HUME_API_KEY!,
    custom_session_id: userId,
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
    statusCallbackEvent: ["ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 20,
    machineDetection: "DetectMessageEnd",
    machineDetectionTimeout: 10,
    asyncAmd: "true",
    asyncAmdStatusCallback: statusCallbackUrl,
    asyncAmdStatusCallbackMethod: "POST",
  });

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

  io?.to(`user:${userId}`).emit("co:call_initiated", { call_sid: call.sid });

  return { success: true, call_sid: call.sid };
}
