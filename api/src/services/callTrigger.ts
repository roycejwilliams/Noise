import { proactivePaused } from "./proactivePause.js";
import { isTestNumber } from "./testNumbers.js";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { generateEmbedding } from "./embeddings.js";
import { prebuildCallContext } from "./elevenLabsCalls.js";
import { dropCallLink, issueCallLink } from "./callLink.js";
import { prebuildCallBriefing } from "./callBriefing.js";
import { prebuildOpening } from "./callOpening.js";
import { buildCallContextSummary } from "./callContext.js";
import { recordDecision, recordDecisionLanded } from "../harness/core.js";
import { dialFailureError, failureDetail, GPT_LIVE_CANT_PLACE, GPT_LIVE_MINUTES_USED, type DialFailure } from "./callReasons.js";
import { amdDialOptions, outboundPreflight, type Preflight } from "./gptLive.js";
import { noteModelFailure } from "./modelKeyAlert.js";
import { decideCall, gatherCallState, LIVE_CALL_RECLAIM_MINUTES, LIVE_CALL_STATUSES, type CallAuthorization } from "../harness/callGate.js";

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
  // dialFailed: the gate allowed it but the call never started (the call link or Twilio's create threw); the error then says whether
  // the call.dial report landed (services/callReasons.ts dialFailureError).
  | { success: false; error: string; dialFailed?: true };

// Twilio's create, swappable in layer-1 tests (no test may reach Twilio).
type Dial = (opts: Parameters<typeof twilioClient.calls.create>[0]) => Promise<{ sid: string }>;
const twilioDial: Dial = (opts) => twilioClient.calls.create(opts);
let dial: Dial = twilioDial;
export function setDialForTests(fn: Dial | null): void {
  dial = fn ?? twilioDial;
}

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
  // Paused: no call Co starts on its own (auto intake, check-in cadence). A call they asked for is not paused.
  if (proactivePaused() && (auth?.kind === "auto_intake" || auth?.kind === "checkin_cadence")) return { success: false, error: "Proactive outreach is paused." };
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

  // The team's calls run on GPT-Live and never on ElevenLabs (Royce, 2026-10-31; routes/co.ts gptLiveAnswer answers them when they
  // pick up). A team call GPT-Live can't take isn't dialed: the month's team minutes used is held, OpenAI unavailable is a call that
  // never started (reported like a refused dial). Everyone else: null, and the dial below is today's.
  const live = await preflight(userId).catch(() => ({ ok: false, kind: "unavailable", failClass: "refused", status: null }) as const);
  if (live && !live.ok) return gptLiveNotPlaced(userId, auth, live);

  // One dial at a time (concurrency audit, 2026-10-12): the gate above reads call_status, which used to be written only after Twilio
  // placed the call, so two triggers at once (the */5 and */15 jobs together, or a "call me" text) both passed and both dialed. The
  // dial is claimed first; the claim is let go if the dial fails, back to the status it replaced.
  const claim = await claimDial(userId);
  if (!claim) {
    await recordDecision({ layer: 8, decision: "call.gate", userId, outcome: "skip", action: "blocked", reason: "another dial claimed it first", checks: [{ name: "no_live_call", pass: false, reason: "a call is already being placed" }] }).catch(() => {});
    return { success: false, error: "A call is already being placed." };
  }

  const statusCallbackUrl = `${process.env.API_URL}/co/call-status`;

  // Calls run on Co's ElevenLabs agent (services/elevenLabsCalls.ts): Twilio
  // fetches the TwiML from us once the call connects, and we register it with
  // the agent then. No Twilio machine detection: the agent's own voicemail
  // tool leaves the message, and the post-call webhook sends the missed-call text.
  // Context built while it rings, ready the moment they answer.
  const summary = prebuildCallContext(userId, buildCallContextSummary);
  // And the opening line, written from that context while it rings (services/callOpening.ts). Not for a GPT-Live call: it opens in
  // its own words (services/gptLive.ts).
  if (!live) prebuildOpening(userId, user.first_name ?? "", "outbound", summary);
  // And the clock and what Co has found for them, so the call never waits on a lookup (services/callBriefing.ts).
  prebuildCallBriefing(userId);
  let call: { sid: string };
  // The TwiML URL carries a one-time call id only (services/callLink.ts), never the member's id or a token: Twilio keeps the URL in its logs.
  let callId: string | null = null;
  try {
    callId = await issueCallLink(userId);
    call = await dial({
    to: user.phone_number,
    from: process.env.TWILIO_PHONE_NUMBER!,
    url: `${process.env.API_URL}/co/el/outbound-twiml?c=${encodeURIComponent(callId)}`,
    method: "POST",
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ["ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
    timeout: 20,
    // A GPT-Live call (the team's) also gets Twilio's async answering-machine detection: GPT-Live has no voicemail tool, so the
    // verdict tells it when to leave its message (services/gptLive.ts). Everyone else's dial is today's, unchanged.
    ...(live ? amdDialOptions(process.env.API_URL) : {}),
    });
  } catch (err) {
    if (callId) await dropCallLink(callId).catch(() => {});
    await releaseDial(userId, claim).catch(() => {});
    // A refused dial is a call that never started, not a crash (2026-10-28: Twilio's 401 "actor doesn't have any assertions", a
    // restricted API key with no permissions, was thrown up through the text turn, which then sent "something broke", replayed the
    // turn and dialed again). It's reported in the decision log (call.dial, flagged by the morning review), with the vendor's status,
    // code and message and nothing private; the caller gets the plain reason, including whether that report landed.
    const failure: DialFailure = { stage: callId ? "dial" : "link", ...failureDetail(err) };
    console.error(`callTrigger: the call never started for user ${userId} (${failure.stage}): ${[failure.status, failure.code, failure.message].filter((x) => x !== null).join(" ")}`);
    const reported = await recordDecisionLanded({
      layer: 8,
      decision: "call.dial",
      userId,
      outcome: "skip",
      action: "dial_failed",
      proposal: { requested: auth?.kind ?? null, ...failure },
      checks: [{ name: "dial_started", pass: false, reason: failure.stage === "dial" ? "the phone service refused the dial" : "the call link couldn't be issued" }],
      reason: failure.message,
    });
    return { success: false, error: dialFailureError(failure, reported), dialFailed: true };
  }
  await recordCallPlaced(userId, user.first_name, call.sid, io);
  return { success: true, call_sid: call.sid };
}

// The GPT-Live check before a team member's dial (services/gptLive.ts outboundPreflight), swappable in layer-1 tests.
type PreflightFn = (userId: string) => Promise<Preflight | null>;
let preflight: PreflightFn = (userId) => outboundPreflight(userId);
export function setPreflightForTests(fn: PreflightFn | null): void {
  preflight = fn ?? ((userId) => outboundPreflight(userId));
}
// A team call GPT-Live can't take. Minutes used: held, logged call.gpt_live_budget_reached (the morning review shows it), and the
// reason the reply reads (services/callReasons.ts GPT_LIVE_MINUTES_USED). OpenAI unavailable: logged call.gpt_live_unavailable, and
// reported exactly as a dial that never started (call.dial dial_failed, stage "link": set-up failed on Cue's side before their phone
// rang), so the reply's honesty rules for a failed call (#302/#303) apply as they are; a refused key also raises the dead-key text.
async function gptLiveNotPlaced(userId: string, auth: CallAuthorization | null, p: Exclude<Preflight, { ok: true }>): Promise<TriggerCallResult> {
  if (p.kind === "budget") {
    await recordDecision({ layer: 8, decision: "call.gpt_live_budget_reached", userId, outcome: "skip", action: p.why, proposal: { direction: "outbound", requested: auth?.kind ?? null }, reason: p.why === "unreadable" ? "the team's GPT-Live minutes couldn't be read, so the call was held (fails closed)" : "the team's GPT-Live minutes for the month are used, so the call was held" }).catch(() => {});
    return { success: false, error: p.why === "unreadable" ? GPT_LIVE_CANT_PLACE : GPT_LIVE_MINUTES_USED };
  }
  await recordDecision({ layer: 8, decision: "call.gpt_live_unavailable", userId, outcome: "skip", action: p.failClass, proposal: { direction: "outbound", failClass: p.failClass, status: p.status, stage: "preflight", requested: auth?.kind ?? null } }).catch(() => {});
  if (p.failClass === "auth") noteModelFailure("openai", { kind: "auth", status: p.status });
  const failure: DialFailure = { stage: "link", status: p.status, code: `gpt_live_${p.failClass}`, message: `GPT-Live unavailable: ${p.failClass}` };
  const reported = await recordDecisionLanded({ layer: 8, decision: "call.dial", userId, outcome: "skip", action: "dial_failed", proposal: { requested: auth?.kind ?? null, ...failure }, checks: [{ name: "dial_started", pass: false, reason: "GPT-Live couldn't take the call, so it wasn't dialed" }], reason: failure.message });
  return { success: false, error: dialFailureError(failure, reported), dialFailed: true };
}

// The dial claim: call_status 'dialing' (a live status to the gate, harness/callGate.ts), set only when no live call holds it. A live
// status older than the gate's reclaim window is stale and can be claimed over, as the gate itself allows; one with no timestamp at
// all (older rows) is stale too, or the member could never be called again.
export const DIAL_CLAIM_SQL = `WITH prev AS (SELECT call_status, call_status_updated_at FROM users WHERE id = $1 FOR UPDATE)
   UPDATE users u SET call_status = 'dialing', call_status_updated_at = NOW() FROM prev
   WHERE u.id = $1 AND NOT (COALESCE(prev.call_status, '') = ANY($2::text[]) AND COALESCE(prev.call_status_updated_at, '-infinity'::timestamptz) > NOW() - make_interval(mins => $3))
   RETURNING prev.call_status AS prev_status, prev.call_status_updated_at AS prev_at`;
type DialClaim = { prevStatus: string | null; prevAt: Date | null };
async function claimDial(userId: string): Promise<DialClaim | null> {
  const { rows } = await pool.query(DIAL_CLAIM_SQL, [userId, LIVE_CALL_STATUSES, LIVE_CALL_RECLAIM_MINUTES]);
  return rows[0] ? { prevStatus: rows[0].prev_status ?? null, prevAt: rows[0].prev_at ? new Date(rows[0].prev_at) : null } : null;
}
// The dial failed: back to what it was, unless something has moved it on since.
async function releaseDial(userId: string, c: DialClaim): Promise<void> {
  await pool.query(`UPDATE users SET call_status = $2, call_status_updated_at = $3 WHERE id = $1 AND call_status = 'dialing'`, [userId, c.prevStatus, c.prevAt]);
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
