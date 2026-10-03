import { isTestNumber } from "./testNumbers.js";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";
import { issueCallToken, prebuildCallContext } from "./elevenLabsCalls.js";
import { buildCallContextSummary } from "./callContext.js";
import { recordDecision } from "../harness/core.js";
import { decideCall, gatherCallState, type CallAuthorization } from "../harness/callGate.js";

// Extracted from co.ts's POST /call/:user_id so a second call site (Co
// triggering a call from within a texting conversation, see sendblue.ts's
// call-offer handling) can reuse the exact same Twilio dial, instead of a
// slimmer, divergent copy that could regress call quality. jobs/index.ts's proactive/scheduled/auto-intake cron jobs also
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
  // A test member's number is fictional (services/testNumbers.ts): never dial it.
  if (isTestNumber(user.phone_number)) return { success: false, error: "Test member: calls aren't placed." };

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

  // Calls run on Co's ElevenLabs agent (services/elevenLabsCalls.ts): Twilio
  // fetches the TwiML from us once the call connects, and we register it with
  // the agent then. No Twilio machine detection: the agent's own voicemail
  // tool leaves the message, and the post-call webhook sends the missed-call text.
  // Context built while it rings, ready the moment they answer.
  prebuildCallContext(userId, buildCallContextSummary);
  const call = await twilioClient.calls.create({
    to: user.phone_number,
    from: process.env.TWILIO_PHONE_NUMBER!,
    url: `${process.env.API_URL}/co/el/outbound-twiml?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(issueCallToken(userId))}`,
    method: "POST",
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ["ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 20,
  });
  await recordCallPlaced(userId, user.first_name, call.sid, io);
  return { success: true, call_sid: call.sid };
}

// The call record, live status and app event, the same for either provider.
async function recordCallPlaced(userId: string, firstName: string, callSid: string, io: IOServer | null): Promise<void> {
  const call = { sid: callSid };
  const user = { first_name: firstName };
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

}
