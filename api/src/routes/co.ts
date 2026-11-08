import { stockReport, coLinesOf } from "../harness/stockLines.js";
import { anthropic } from "@ai-sdk/anthropic";
import { cueAudit } from "../services/voiceCues.js";
import { recordSafetyConcern, soundsLikeCrisis } from "../services/safety.js";
import { generateText } from "ai";
import { noteTraceUser } from "../services/llmTraceText.js";
import { propagateAttributes } from "@langfuse/tracing";
import express, { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { generateEmbedding } from "../services/embeddings.js";
import {
  captureIntent,
  cityChangeAllowed,
  extractPlannedEventMention,
  extractPsychographicProfile,
  storeProfile,
  storeTranscriptMemory,
} from "../services/profileExtraction.js";
import { voiceFinds } from "../services/voiceFinds.js";
import { takeCallBriefing } from "../services/callBriefing.js";
import { buildCallContextSummary, buildCallKnowledge, summarizeCallForTextContext } from "../services/callContext.js";
import { learnFromCall } from "../services/callLearning.js";
import { writeMemory } from "../services/memory.js";
import sendblue from "../services/sendblue.js";
import { generateVoiceNote } from "../services/voiceNote.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { takeCallLink } from "../services/callLink.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { recordDecision } from "../harness/core.js";
import {
  decideMissedCallFollowUp,
  gatherMissedCallState,
  hasRealUserTurn,
  isVoicemailGreeting,
  hadContactSince,
  inboundCallerVerified,
  inboundCallMember,
  stripVoicemailGreetingLines,
} from "../harness/callGate.js";
import { MODELS } from "../models.js";
import { surfaceNewAsksNow } from "../services/eventSurfacingSweep.js";
import { refreshPersonSnapshot } from "../harness/personSnapshot.js";
import { AUDIT_SECTIONS, auditCall, knownBeforeFrom, type OfferFlag } from "../harness/callGrounding.js";
import { elTurnMetrics } from "../services/callLatency.js";
import { memberKnowledge } from "../services/memberKnowledge.js";
import { callEmotionMoments, checkNoEmotionLabelOnCall, frustrationMoments, frustrationScores, recordEmotionSignals, type EmotionSignal, type ScoredLine } from "../harness/emotion.js";
import { callKeyOf, takeVoiceMoments } from "../services/mediaStreamBridge.js";
import { callerTurnsFrom, momentSignals } from "../services/voiceRead.js";
import { narratesInternalState } from "../services/speakable.js";
import { forgetAfterCall, transcriptHash } from "../services/elevenLabsForget.js";
import { flagNotStored, recordCallHealth } from "../services/callHealth.js";
import { CANT_CONNECT_LINE, chooseOpening, conversationLink, withTimeout, fetchConversationTurns, hitVoicemail, memberNumberOf, missedKind, voicemailLeft, noteCallFailure, takeCallContext, voicemailVerdict, registerElevenLabsCall, transcriptFromTurns, verifyCallToken, verifyPostCallWebhook, withCallSituation } from "../services/elevenLabsCalls.js";
import { OPENING_WRITER, recordOpening, takeOpening, writeOpening } from "../services/callOpening.js";
import { withMember } from "../services/llmUsage.js";

// One-line drafts (missed-call text, voicemail line): narrow work, Haiku.
const DRAFT_MODEL = MODELS.haiku;

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

// Reject status callbacks that didn't come from Twilio. Calls are placed
// under the TWILIO_LIVE_SID subaccount (see twilioClient above), and Twilio
// signs status callbacks with the OWNING account's Auth Token — a
// subaccount's callbacks are never valid against the parent account's
// TWILIO_AUTH_TOKEN, so this needs the subaccount's own token, not the
// parent's (confirmed the hard way: every real call's status callback 401'd
// once signature validation was added, despite a perfectly valid account).
// Fixed 2026-09-17 (security): this only ever checked in production, so a
// deployment with NODE_ENV unset or mis-set to anything else accepted
// unsigned webhook calls to /co/call-status and /co/incoming-call — both of
// which load and act on a real person's account. Now: verify whenever
// TWILIO_AUTH is actually configured, in ANY environment; only skip when
// it's genuinely absent, and then fail CLOSED (reject) in production —
// missing the secret in prod is a real misconfiguration, not a reason to
// wave every request through — while logging loudly and allowing it
// elsewhere so local dev without the secret set still works.
function validateTwilioSignature(req: Request, path: string): boolean {
  const secret = process.env.TWILIO_AUTH;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error(`validateTwilioSignature: TWILIO_AUTH not set in production — rejecting ${path} (fail closed)`);
      return false;
    }
    console.warn(`validateTwilioSignature: TWILIO_AUTH not set — skipping signature check for ${path} (this would reject in production)`);
    return true;
  }
  const sig = req.headers["x-twilio-signature"] as string | undefined;
  if (!sig) return false;
  const url = `${process.env.API_URL}${path}`;
  return twilio.validateRequest(secret, sig, url, req.body);
}

// Shared by both the standard missed-call path (no-answer/busy/failed/
// canceled) and the voicemail-detected path — Claude drafts the copy,
// ElevenLabs is the "heavy worker" that turns it into a voice note (Hume is
// only ever used for the live call itself), falling back to plain text if
// voice generation fails so this never blocks the follow-up from sending.
// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
async function sendMissedCallFollowUp(...a: Parameters<typeof sendMissedCallFollowUpInScope>): ReturnType<typeof sendMissedCallFollowUpInScope> {
  return withMember(a[0].id, () => sendMissedCallFollowUpInScope(...a));
}
async function sendMissedCallFollowUpInScope(
  user: { id: string; first_name: string; phone_number: string },
  CallSid: string,
  CallStatus: string,
  situationPrompt: string,
): Promise<void> {
  // The member's own rules (harness/notifyGate.ts): a follow-up to a call they didn't pick up is Cue's own text, claimed on the ledger
  // under their lock (it counts) before it goes. Held, it isn't sent (nothing they asked for is lost: the call was Cue's), logged with ids.
  const P = await import("../harness/proactive.js");
  const claim = await P.claimCoInitiatedSend({ userId: user.id, type: "missed_call", targetKey: `missed_call_followup:${CallSid}`, message: "[missed-call follow-up]", kind: null, timezone: null, ruleOnly: true, cls: "unsolicited" });
  if (!claim.ok) {
    await recordDecision({ layer: 8, decision: "call.missed_followup", userId: user.id, outcome: "skip", action: /held/.test(claim.reason) ? "held_member_rule" : "not_claimed", proposal: { callSid: CallSid } }).catch(() => {});
    return;
  }
  let coMessage: string;
  try {
    const result = await propagateAttributes(
      { userId: user.id, traceName: "co.sendMissedCallFollowUp" },
      () =>
        generateText({
          model: anthropic(DRAFT_MODEL),
          experimental_telemetry: { isEnabled: true, functionId: "co.sendMissedCallFollowUp" },
          prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} ${situationPrompt} Send a short iMessage letting ${user.first_name} know, and that they can reply here whenever they're ready or expect another call soon. Tone: calm, unhurried, like a private members club. No em dashes. 2 sentences max.`,
        }),
    );
    coMessage = result.text;
  } catch (aiErr) {
    console.error("Cue follow-up message generation failed, using fallback:", aiErr);
    coMessage = `Hey ${user.first_name}, Cue tried to reach you. Reply here whenever you're ready, or expect another call soon.`;
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
    // Nothing went: the claim comes off the ledger.
    await P.releaseCoInitiatedClaim(user.id, claim.ledgerId).catch(() => {});
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
// Dial/AMD/logging logic lives in services/callTrigger.ts, shared with
// sendblue.ts's texting-triggered call path — this route is now just the
// HTTP/auth wrapper around it.
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

      const result = await triggerCallForUser(user_id, _io, { kind: "user_initiated" });
      if (!result.success) {
        // A dial that never started is the phone service's or Cue's own failure, not a refusal of this member.
        const status = result.error === "User not found." ? 404 : result.dialFailed ? 502 : 403;
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
// Handles missed calls (no-answer, busy, failed, canceled) by sending a Co
// follow-up. Voicemail is the call agent's own (it leaves the line and ends
// the call); the post-call webhook sends that follow-up (/co/el/post-call).
router.post(
  "/call-status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateTwilioSignature(req, "/co/call-status")) {
        return res.status(401).send("Invalid Twilio signature.");
      }

      const { CallStatus, CallSid } = req.body;
      // The member's number: To on calls Co places, From on calls they place to Co.
      const { number: To, inbound } = memberNumberOf(req.body);


      // Validate Twilio sent the required fields
      if (!CallStatus || !To) {
        console.error("call-status webhook missing CallStatus or To; its keys (never the numbers):", Object.keys(req.body ?? {}).join(", "));
        return res.sendStatus(204);
      }

      const userResult = await pool.query(
        `SELECT id, first_name, phone_number FROM users WHERE phone_number = $1`,
        [To],
      );
      const user = userResult.rows[0];

      // 'processing'/'completed'/'failed' are the chat_ended handler's own
      // terminal states (its idempotency claim reads call_status to decide
      // whether extraction already ran) — Twilio's "completed" is a
      // DIFFERENT event (the call itself hung up) that fires independently
      // of and usually right around the same time as Hume's chat_ended.
      // Forwarding it here could land first and get misread as "extraction
      // already finished," silently skipping the real pipeline. Only
      // forward the early, Twilio-owned states; chat_ended is the sole
      // writer of the terminal ones.
      if (CallStatus !== "completed" && CallSid) {
        // call_status_updated_at stamped alongside every live-state
        // transition (see callTrigger.ts's dial-time write and its reclaim
        // guard) — this is the clock that lets a wedged call_status recover
        // on its own if chat_ended's webhook is ever missed for this call.
        await pool.query(
          `UPDATE users SET call_status = $2, call_status_updated_at = NOW() WHERE phone_number = $1 AND call_sid = $3`,
          [To, CallStatus, CallSid],
        );
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

      // Calls that never connected to anything (no human, no machine) don't
      // get an instant follow-up — that reads as robotic. Queue it for the
      // delayed-follow-up cron (2hrs later, see jobs/index.ts) instead.
      // Missed-call texts are for calls Co placed; a caller hanging up on Co's line isn't one.
      if (inbound || !["no-answer", "busy", "failed", "canceled"].includes(CallStatus)) {
        return res.sendStatus(204);
      }

      // Unknown number — nothing to do, ack so Twilio doesn't retry
      if (!user) {
        console.warn(`call-status: no user found for the called number (${CallStatus})`);
        return res.sendStatus(204);
      }

      // One missed-call text, not one per missed call (Layer 8 harness): a
      // run of unanswered calls used to queue a text for each.
      const missed = decideMissedCallFollowUp(await gatherMissedCallState(user.id, CallSid), new Date());
      await recordDecision({
        layer: 8,
        decision: "call.gate",
        userId: user.id,
        outcome: missed.send ? "act" : "skip",
        action: `missed_call_followup:${CallStatus}`,
        checks: missed.checks,
      });
      if (missed.send) {
        await pool.query(
          `INSERT INTO pending_call_followups (user_id, call_sid, call_status, due_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '2 hours')`,
          [user.id, CallSid, CallStatus],
        );
      }

      return res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/incoming-call — Twilio's inbound Voice webhook for
// TWILIO_PHONE_NUMBER. A user can always reach Co by calling this number
// directly — the other half of "always lend an ear" alongside the proactive
// check-in cron. Answered by GPT-Live (gptLiveAnswer below), as outbound calls
// are; the old ElevenLabs answer (elevenLabsInboundTwiml) is no longer called.
// Only a recognized, carrier-verified caller reaches Cue at all.
//
// Fixed 2026-09-17 (security): matching on From alone trusted caller ID,
// which is trivially spoofed — a spoofed number got that person's full
// private context read to a stranger and could write into their profile.
// StirVerstat is Twilio's own read of the ORIGINATING carrier's STIR/SHAKEN
// attestation — "TN-Validation-Passed-A" is the one value that actually
// means the carrier vouches this caller owns the number; anything else
// (lower attestation, unverified, or simply absent on a carrier that
// doesn't support it) is treated exactly like an unrecognized number: a
// generic decline, no context loaded, no memory written. See
// harness/callGate.ts's inboundCallerVerified. ALLOW_UNVERIFIED_INBOUND_CALLERS=true
// is a local/dev escape hatch for testing on lines whose carrier never
// attests — never set in production.
router.post(
  "/incoming-call",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateTwilioSignature(req, "/co/incoming-call")) {
        return res.status(401).send("Invalid Twilio signature.");
      }

      const from = req.body.From as string | undefined;
      const callSid = req.body.CallSid as string | undefined;
      const stirVerstat = (req.body.StirVerstat as string | undefined) ?? null;
      // Only a member reaches the call agent (harness/callGate.ts inboundCallMember): a guest or applicant with a users row doesn't.
      const caller = await inboundCallMember(from);
      const userId: string | null = caller.userId;
      if (!userId && caller.why !== "no account" && caller.why !== "no caller number") {
        await recordDecision({ layer: 1, decision: "call.inbound", userId: null, outcome: "skip", action: "not_a_member", reason: caller.why }).catch(() => {});
      }
      const allowUnverified = process.env.ALLOW_UNVERIFIED_INBOUND_CALLERS === "true";
      const verified = inboundCallerVerified(stirVerstat, allowUnverified);

      const twiml = new twilio.twiml.VoiceResponse();
      if (!userId || !verified) {
        if (userId && !verified) {
          console.warn(
            `incoming-call: caller ID for ${from} matched a user but wasn't carrier-verified (StirVerstat: ${stirVerstat ?? "none"}) — treating as unrecognized`,
          );
        }
        twiml.say("Sorry, we don't recognize this number. Text us instead and we'll get you set up.");
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
      }

      // Every verified member's call answers with GPT-Live (Royce, 2026-10-31; gptLiveAnswer below), never ElevenLabs: minutes used is
      // busy, GPT-Live unavailable is the can't-connect line. The ElevenLabs answer is elevenLabsInboundTwiml, no longer called.
      const live = await gptLiveAnswer({ userId, callSid: callSid ?? null, direction: "inbound" });
      if ("twiml" in live) return res.type("text/xml").send(live.twiml);
      return res.type("text/xml").send(await gptLiveRefusalTwiml(userId, callSid ?? null, live));
    } catch (err) {
      next(err);
    }
  },
);

// ElevenLabs is out of the call path (2026-10-31): /co/incoming-call's old ElevenLabs answer, unchanged and no longer called (kept for
// the deletion PR, with registerElevenLabsCall, /co/el/* and the agent).
async function elevenLabsInboundTwiml(req: Request, res: Response, userId: string, callSid: string | undefined, from: string | undefined) {
  const twiml = new twilio.twiml.VoiceResponse();

  // Fixed 2026-09-17: this never set call_sid/call_status for an inbound
  // call, so the LEFTOVER state from whatever call last touched this
  // user's row (often 'completed', set by the previous call's own
  // chat_ended) was still sitting there. /webhook's chat_ended handler
  // reads call_status to decide if a call was "already processed" — so
  // after any finished call, every later inbound call looked already
  // done and got silently skipped: no transcript, no profile update, no
  // follow-up. Mirrors what callTrigger.ts already does for outbound.
  if (callSid) {
    await pool.query(
      `UPDATE users SET call_sid = $2, call_status = 'initiated', call_status_updated_at = NOW() WHERE id = $1`,
      [userId, callSid],
    );
  }

  // Register the call with Co's ElevenLabs agent and hand Twilio the
  // TwiML that connects it (services/elevenLabsCalls.ts).
  const [{ rows: u }, contextSummary, briefing] = await Promise.all([
    pool.query(`SELECT first_name, phone_number FROM users WHERE id = $1`, [userId]),
    buildCallContextSummary(userId).catch(() => ""),
    takeCallBriefing(userId),
  ]);
  try {
    const elTwiml = await registerElevenLabsCall({
      userId,
      firstName: u[0]?.first_name ?? "",
      opening: await openingForCall(userId, u[0]?.first_name ?? "", "inbound", contextSummary),
      contextSummary,
      rightNow: briefing.rightNow,
      findsNow: briefing.findsNow,
      from: from!,
      to: (req.body.To as string | undefined) ?? process.env.TWILIO_PHONE_NUMBER!,
      direction: "inbound",
    });
    return res.type("text/xml").send(elTwiml);
  } catch (regErr: any) {
    console.error("incoming-call: ElevenLabs registration failed:", regErr?.message ?? regErr);
    noteCallFailure(userId, "registration");
    await releaseFailedCall(userId, callSid);
    twiml.say(CANT_CONNECT_LINE);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
}
void elevenLabsInboundTwiml;

// ---------- ElevenLabs calls (services/elevenLabsCalls.ts)

// The opening line: written from what Co knows (services/callOpening.ts), the
// pool's greeting if it can't be. Outbound it was written while the phone rang;
// inbound it gets a short wait, since the caller is already on the line.
async function openingForCall(userId: string, firstName: string, direction: "inbound" | "outbound", contextSummary: string): Promise<string> {
  const written =
    direction === "outbound"
      ? await takeOpening(userId)
      : await withTimeout(writeOpening({ firstName, direction, summary: contextSummary, timeoutMs: OPENING_WRITER.inboundBudgetMs, userId }), OPENING_WRITER.inboundBudgetMs, { line: null, why: "not ready in time" });
  recordOpening(userId, direction, written);
  return written.line ?? (await chooseOpening(userId, firstName, direction));
}

// Outbound: Twilio fetches this once the call connects (callTrigger.ts
// dials with this url); we register the call with ElevenLabs and return its
// TwiML. The url carries only a one-time call id (services/callLink.ts,
// 2026-10-18): never the member's id or a token, since Twilio logs the url.
// The whole url (query included) is what Twilio signs; the signature is
// checked first, so an unsigned request can't use up a call's id.
router.post("/el/outbound-twiml", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateTwilioSignature(req, req.originalUrl)) return res.status(401).send("Invalid Twilio signature.");
    // Good once, within the call's window: a second fetch, an old link or a made-up one gets nothing.
    const userId = await takeCallLink(typeof req.query.c === "string" ? req.query.c : null);
    if (!userId) return res.status(401).send("Invalid call link.");
    // Every member's call runs on GPT-Live (Royce, 2026-10-31; gptLiveAnswer below), with the context prebuilt while it rang. It was
    // only dialed after its check passed (services/callTrigger.ts); if GPT-Live still can't take it now that they've answered, they
    // hear the can't-connect line, never ElevenLabs. The ElevenLabs answer is elevenLabsOutboundTwiml, no longer called.
    const live = await gptLiveAnswer({ userId, callSid: (req.body.CallSid as string | undefined) ?? null, direction: "outbound", context: () => takeCallContext(userId, buildCallContextSummary).then((c) => c.summary) });
    if ("twiml" in live) return res.type("text/xml").send(live.twiml);
    return res.type("text/xml").send(await gptLiveRefusalTwiml(userId, (req.body.CallSid as string | undefined) ?? null, live, "outbound"));
  } catch (err) {
    next(err);
  }
});

// ElevenLabs is out of the call path (2026-10-31): /co/el/outbound-twiml's old ElevenLabs answer, unchanged and no longer called (kept
// for the deletion PR).
async function elevenLabsOutboundTwiml(req: Request, res: Response, userId: string) {
  const [{ rows: u }, ctx, briefing] = await Promise.all([
    pool.query(`SELECT first_name, phone_number FROM users WHERE id = $1`, [userId]),
    takeCallContext(userId, buildCallContextSummary),
    takeCallBriefing(userId),
  ]);
  const contextSummary = ctx.summary;
  if (!u[0]) return res.status(404).send("Unknown user.");
  try {
    const twiml = await registerElevenLabsCall({
      userId,
      firstName: u[0].first_name ?? "",
      opening: await openingForCall(userId, u[0].first_name ?? "", "outbound", contextSummary),
      contextSummary,
      rightNow: briefing.rightNow,
      findsNow: briefing.findsNow,
      from: (req.body.From as string | undefined) ?? process.env.TWILIO_PHONE_NUMBER!,
      to: (req.body.To as string | undefined) ?? u[0].phone_number,
      direction: "outbound",
    });
    return res.type("text/xml").send(twiml);
  } catch (regErr: any) {
    console.error("el/outbound-twiml: ElevenLabs registration failed:", regErr?.message ?? regErr);
    noteCallFailure(userId, "registration");
    await releaseFailedCall(userId, req.body.CallSid as string | undefined);
    const fallback = new twilio.twiml.VoiceResponse();
    fallback.say(CANT_CONNECT_LINE);
    fallback.hangup();
    return res.type("text/xml").send(fallback.toString());
  }
}
void elevenLabsOutboundTwiml;

// The agent's tools. Answered in the response (ElevenLabs waits on it), with
// the call's user id checked against its token.
router.post("/el/tool/:name", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const userId = String(b.user_id ?? "");
  if (!verifyCallToken(userId, b.call_token)) return res.status(401).json({ error: "invalid call token" });
  const name = req.params.name;
  try {
    if (name === "surface_recommendation") {
      return res.json(await voiceFinds(userId));
    }
    // The coverage check went with the interview
    // script (2026-10-08): calls decide from what Co knows, as texts do.
    return res.status(404).json({ error: `unknown tool ${name}` });
  } catch (err: any) {
    console.error(`co/el/tool/${name} failed:`, err?.message ?? err);
    return res.json({ available: false, reason: "lookup failed" });
  }
});

// After the call: ElevenLabs posts the transcript (signed; raw body, see
// server.ts). A voicemail goes the missed-call way; a real call runs the
// post-call steps (processEndedCall).
router.post("/el/post-call", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body ?? {});
    const event = await verifyPostCallWebhook(raw, req.headers["elevenlabs-signature"] as string | undefined);
    if (!event) return res.status(401).send("Invalid signature.");
    if (event.type === "call_initiation_failure") {
      const fv = event.data?.conversation_initiation_client_data?.dynamic_variables ?? {};
      const fid = String(fv.user_id ?? "");
      if (fid && verifyCallToken(fid, fv.call_token)) noteCallFailure(fid, "initiation");
      console.error(`co/el/post-call: call initiation failed (${event.data?.failure_reason ?? "no reason given"})`);
      return res.status(200).send({ success: true, noted: "initiation_failure" });
    }
    if (event.type !== "post_call_transcription") return res.status(200).send({ success: true, ignored: event.type });
    const data = event.data ?? {};
    const vars = data.conversation_initiation_client_data?.dynamic_variables ?? {};
    const userId = String(vars.user_id ?? "");
    // Checked as of the call's start: a retried delivery can come hours later.
    const startedSecs = Number(data.metadata?.start_time_unix_secs) || Math.floor(Date.now() / 1000);
    if (!verifyCallToken(userId, vars.call_token, startedSecs)) {
      console.error(`co/el/post-call: no valid user for conversation ${data.conversation_id}`);
      return res.status(200).send({ success: false, reason: "unknown user" });
    }
    const conversationId = String(data.conversation_id ?? "");
    // ElevenLabs graded the call against our criteria (services/callEvals.ts); the failures go where the morning review reads.
    // Its judge sees only the call: a source failure is re-checked against their texts and Co's records first (2026-10-08).
    const gradeContext = { transcript: transcriptFromTurns(Array.isArray(data.transcript) ? data.transcript : []), given: [vars.context_summary, vars.finds_now].filter((x) => typeof x === "string" && x).join("\n") };
    import("../services/callEvals.js").then((m) => m.recordCallEvaluation(userId, conversationId, data.analysis, undefined, gradeContext)).catch(() => {});
    // Whether every event, place and time Co named had a source row (the grader above can't see the finds list).
    import("../services/offerGuard.js").then((m) => m.recordOfferSourceCheck(userId, conversationId, Array.isArray(data.transcript) ? data.transcript : [], { firstName: String(vars.first_name ?? ""), contextSummary: String(vars.context_summary ?? ""), findsNow: String(vars.finds_now ?? ""), rightNow: String(vars.right_now ?? "") })).catch(() => {});
    const turns = Array.isArray(data.transcript) ? data.transcript : [];
    const { rows: u } = await pool.query(`SELECT id, first_name, phone_number, call_sid, mo_approver FROM users WHERE id = $1`, [userId]);
    // The call's own sid: ElevenLabs sends it on Twilio calls. Never the member's
    // latest call_sid (it can belong to a later call); without one, key on the conversation.
    const callSid: string = data.metadata?.phone_call?.call_sid ?? vars.system__call_sid ?? `el:${conversationId}`;
    const personTalked = hasRealUserTurn(transcriptFromTurns(turns));
    const verdict = voicemailVerdict(hitVoicemail(turns, data.metadata?.termination_reason), personTalked);
    const kind = missedKind(verdict, personTalked, typeof vars.direction === "string" ? vars.direction : undefined);
    if (verdict !== "conversation") {
      recordDecision({ layer: 8, decision: "call.voicemail", userId, outcome: verdict === "voicemail" ? "act" : "skip", action: verdict, proposal: { conversationId: data.conversation_id, termination: data.metadata?.termination_reason ?? null } }).catch(() => {});
    }
    // A call with nothing of ours stored still leaves a conversation at ElevenLabs: queued on the same window, nothing to verify.
    const queueUnstored = () => {
      if (u[0]) forgetAfterCall({ userId, conversationId, transcriptSha256: null, phone: u[0].phone_number, team: u[0].mo_approver === true }).catch(() => {});
    };
    if (kind && u[0]) {
      const r = await handleMissedVoiceCall(u[0], callSid, kind, conversationId);
      queueUnstored();
      return res.status(200).send({ success: true, missed: kind, ...r });
    }
    const callStart = Number(data.metadata?.start_time_unix_secs) ? new Date(Number(data.metadata.start_time_unix_secs) * 1000) : null;
    const callEnd = callStart && Number(data.metadata?.call_duration_secs) ? new Date(callStart.getTime() + Number(data.metadata.call_duration_secs) * 1000) : null;
    let ended: Awaited<ReturnType<typeof processEndedCall>>;
    try {
      ended = await processEndedCall({
      userId,
      callKey: `el:${conversationId}`,
      offered: typeof vars.finds_now === "string" ? vars.finds_now : undefined,
      // The same source check as above, run again for the audit once the call's ledger is read (what its searches found mid-call is a
      // source too): a sentence it flags can become a correction the follow-up text carries.
      offerSource: { turns, given: { firstName: String(vars.first_name ?? ""), contextSummary: String(vars.context_summary ?? ""), findsNow: String(vars.finds_now ?? ""), rightNow: String(vars.right_now ?? "") } },
      startedAt: Number(data.metadata?.start_time_unix_secs) ? new Date(Number(data.metadata.start_time_unix_secs) * 1000) : null,
      endedAt: Number(data.metadata?.start_time_unix_secs) && Number(data.metadata?.call_duration_secs) ? new Date((Number(data.metadata.start_time_unix_secs) + Number(data.metadata.call_duration_secs)) * 1000) : null,
      twilioMetadata: callSid ? { call_sid: callSid } : null,
      // Feelings come from the text read over what they said, plus ElevenLabs'
      // per-line frustration score (harness/emotion.ts frustrationMoments).
      load: async () => ({
        transcript: transcriptFromTurns(turns),
        recordingUrl: conversationLink(conversationId),
        // The webhook's own turns when they carry the scores, else the conversation fetched once.
        frustration: async () => {
          const here = frustrationScores(turns);
          const scored = here.length ? here : frustrationScores(await fetchConversationTurns(conversationId));
          // Which path supplied the scores, so the webhook's shape is known (review of #61).
          console.log(`post-call: ${scored.length} frustration scores for ${conversationId} from ${here.length ? "the webhook" : "the conversation fetch"}`);
          return scored;
        },
        // The live voice read's moments for this call, by its own call token (services/mediaStreamBridge.ts).
        voice: async () => momentSignals(await takeVoiceMoments(callKeyOf(userId, String(vars.call_token ?? "")), callerTurnsFrom(turns))),
      }),
    });
    } catch (err) {
      // Processing failed: nothing stored yet. A retried delivery that stores it turns the row into a verified one. Flagged
      // not_stored, so ElevenLabs' copy (maybe the only one) is held until someone has looked (on production, at most
      // FORGET.prodHoldDays after the call).
      if (u[0]) flagNotStored({ userId, conversationId, startedAt: callStart, endedAt: callEnd }).catch(() => {});
      queueUnstored();
      throw err;
    }
    // ElevenLabs' own per-turn numbers (its LLM's time to first token and first sentence, its voice's time to first audio), for
    // every call: the direct path's baseline beside the call brain's own call.turn_latency. Numbers only. Not awaited.
    {
      const m = elTurnMetrics(turns);
      if (m.turns) recordDecision({ layer: 8, decision: "call.el_turn_metrics", userId, outcome: "act", action: m.keys.length ? "measured" : "no_metrics", proposal: { conversationId, ...m } }).catch(() => {});
    }
    // The after-call health check (services/callHealth.ts): facts only, codes stored, never anyone's words. A flagged call is held at
    // ElevenLabs until reviewed and shows in the morning review. Not awaited and never throws.
    if (u[0])
      recordCallHealth({
        userId,
        conversationId,
        turns,
        durationSecs: Number.isFinite(Number(data.metadata?.call_duration_secs)) && data.metadata?.call_duration_secs != null ? Number(data.metadata.call_duration_secs) : null,
        terminationReason: typeof data.metadata?.termination_reason === "string" ? data.metadata.termination_reason : null,
        status: typeof data.status === "string" ? data.status : null,
        startedAt: Number(data.metadata?.start_time_unix_secs) ? new Date(Number(data.metadata.start_time_unix_secs) * 1000) : null,
        endedAt: Number(data.metadata?.start_time_unix_secs) && Number(data.metadata?.call_duration_secs) ? new Date((Number(data.metadata.start_time_unix_secs) + Number(data.metadata.call_duration_secs)) * 1000) : null,
      }).catch(() => {});
    // Forget by default (services/elevenLabsForget.ts): with the transcript stored on our side and the call's processing completed,
    // ElevenLabs' copy (audio and transcript) is queued for deletion: 7 days for a member, 30 for the team and test numbers, held
    // while the health check's flag is unreviewed. Not awaited and never throws: the member-facing steps above are done.
    if (ended.stored && u[0]) forgetAfterCall({ userId, conversationId, transcriptSha256: ended.stored.transcriptSha256, phone: u[0].phone_number, team: u[0].mo_approver === true }).catch(() => {});
    else if (ended.unstored) queueUnstored();
    // Co never tells a member what they feel. Speech can't be filtered mid-call
    // (ElevenLabs speaks its model's reply directly), so every call is checked
    // after: a line that names their feeling is logged for the review.
    const labelled = turns.filter((t: any) => t?.role !== "user" && typeof t?.message === "string").map((t: any) => t.message as string).filter((m: string) => !checkNoEmotionLabelOnCall(m).pass);
    if (labelled.length) recordDecision({ layer: 8, decision: "call.emotion_label", userId, outcome: "skip", action: "named_their_feeling", proposal: { conversationId, lines: labelled.slice(0, 5) }, reason: checkNoEmotionLabelOnCall(labelled[0]).reason ?? null }).catch(() => {});
    // Co's voice cues can't be filtered mid-call (ElevenLabs speaks its model's
    // reply directly), so every call is audited: a cue outside the allowed set,
    // or two in one reply, shows up in the review (services/voiceCues.ts).
    const cueUse = cueAudit(turns.filter((t: any) => t?.role !== "user").map((t: any) => String(t?.message ?? "")));
    // One voice standard with texts (services/speakable.ts): a spoken line that narrates Co's own state ("I'm starting on it",
    // "once it's worth sending") is logged for the review, the way texts are checked before they go.
    const narrated = turns.filter((t: any) => t?.role !== "user" && typeof t?.message === "string").map((t: any) => t.message as string).filter((m: string) => narratesInternalState(m));
    if (narrated.length) recordDecision({ layer: 8, decision: "call.narration", userId, outcome: "skip", action: "narrated_state", proposal: { conversationId, lines: narrated.slice(0, 5) }, reason: narratesInternalState(narrated[0]) }).catch(() => {});
    if (cueUse.cued) recordDecision({ layer: 8, decision: "call.cues", userId, outcome: cueUse.outside.length || cueUse.overOne ? "skip" : "act", action: cueUse.outside.length || cueUse.overOne ? "cue_rules_broken" : "cues_ok", proposal: { conversationId, ...cueUse } }).catch(() => {});
    return res.status(ended.status).send(ended.body);
  } catch (err) {
    next(err);
  }
});

// ---------- GPT-Live calls (services/gptLive.ts, Royce 2026-10-31): every member's calls run on GPT-Live; ElevenLabs is out of the call path.
// Royce, 10-31: no call falls back to ElevenLabs (the goal is to leave it; its credits run out fast). So for any member:
//   - the month's minutes used: refused busy, logged call.gpt_live_budget_reached (the morning review shows it, so the cap can rise);
//   - GPT-Live unavailable (no OpenAI key or API_URL here, the answer couldn't be built, or OpenAI refused before the session started):
//     the existing CANT_CONNECT_LINE, the failure noted as on the ElevenLabs path, logged call.gpt_live_unavailable with its class (a
//     refused key also raises the existing dead-key text, services/modelKeyAlert.ts).
// The processor line in what Cue knows (services/whatCoKnows.ts) is the disclosure; the team flag only shapes the prompt.

// The TwiML that answers a verified caller with GPT-Live, or why not. Any verified member (the route verified them); the team flag
// only adds the team line to the prompt. Then the month's minutes, shared by every call (admitSession: none left, or a total that
// can't be read, is "budget_used"). Then TwiML that streams the call to the bridge (services/gptLiveBridge.ts) with a one-time id only
// (the member's id never goes to Twilio), and a <Connect> action for when the stream ends. GPT-Live opens in its own words from the
// opening's background (gptLive.ts OpeningContext): no written or template opening line on this path.
type GptLiveAnswer = { twiml: string } | { refused: "budget_used"; why: "minutes_used" | "unreadable" } | { refused: "unavailable"; failClass: "no_key" | "no_api_url" | "build_error" };
export const gptLiveAnswerForTests = (...a: Parameters<typeof gptLiveAnswer>) => gptLiveAnswer(...a);
async function gptLiveAnswer(o: { userId: string; callSid: string | null; direction: "inbound" | "outbound"; context?: () => Promise<string> }): Promise<GptLiveAnswer> {
  // Every verified member (Royce, 2026-10-31, with the processor line in what Cue knows). Team only shapes the prompt (TEAM_BUILDER_LINE).
  const team = await import("../services/extensions.js").then((m) => m.isTeamMember(o.userId)).catch(() => false);
  const G = await import("../services/gptLive.js");
  if (!process.env.OPENAI_API_KEY?.trim()) return { refused: "unavailable", failClass: "no_key" };
  const streamUrl = G.gptLiveStreamUrl(process.env.API_URL);
  if (!streamUrl) return { refused: "unavailable", failClass: "no_api_url" };
  const slot = await G.admitSession();
  if (!G.admitted(slot)) return { refused: "budget_used", why: slot.refused };
  const admitted = slot;
  try {
    // An inbound call is marked on the member's row (with or without a sid), so anything that reads whether a call is on sees it
    // (harness/momentFit.ts callContextFor: a check-in is never judged or sent mid-call).
    if (o.direction === "inbound") await pool.query(`UPDATE users SET call_sid = COALESCE($2, call_sid), call_status = 'initiated', call_status_updated_at = NOW() WHERE id = $1`, [o.userId, o.callSid]);
    const [{ rows: u }, contextSummary, briefing, voiceLayer, zone] = await Promise.all([
      pool.query(`SELECT first_name FROM users WHERE id = $1`, [o.userId]),
      (o.context ?? (() => buildCallContextSummary(o.userId)))().catch(() => ""),
      takeCallBriefing(o.userId),
      import("../services/coPersona.js").then((m) => m.getCoPersonaPrompt()),
      import("../services/memberTime.js").then((m) => m.memberZoneOrFallback(o.userId)).catch(() => "America/Los_Angeles"),
    ]);
    const firstName = u[0]?.first_name ?? "";
    const callReason = await import("../services/callReason.js").then((m) => m.callReasonVariable(o.userId, o.direction)).catch(() => "");
    // The Hume voice read (services/mediaStreamBridge.ts startVoiceTee), as on ElevenLabs: only where it may run for them (their yes on
    // file and not taken back, or a test number; voiceReadConsent.ts voiceReadOnFor). Read again when the session starts.
    const voiceOn = await import("../services/voiceReadConsent.js").then((m) => m.voiceReadOnFor(o.userId)).catch(() => false);
    // A first call (no past call transcript) gets the first-conversation guidance and, in its opening, a line of their own texted words
    // and the inviter they named themselves (services/firstCall.ts). A failed read is a later call: the four phases, as before.
    const first = await import("../services/firstCall.js").then((m) => m.firstCallFacts(o.userId)).catch(() => ({ firstCall: false }));
    // A later call opens from where they left off: one line, the most recent open thread or topic (services/firstCall.ts laterCallThread).
    // Outbound, only when they asked for the call: on Cue's own unrequested calls whoever is confirmed on the line may not be them.
    const held = o.direction === "outbound" ? await import("../services/callReason.js").then((m) => ({ h: m.heldCallReason(o.userId), m })).catch(() => null) : null;
    const memberAsked = o.direction === "inbound" || held?.h?.result.reason?.kind === "member_asked";
    // Who asked for an outbound call, said plainly for the opening and the close (2026-11-07 call review: Cue framed a call they asked
    // for as its own idea). From the gate's held kind: a member-asked kind or reason is theirs, a Cue-initiated kind is Cue's; nothing
    // held is not known, said as before.
    const askedBy = held ? held.m.callAskedBy(o.direction, held.h) : null;
    const thread = (first as { firstCall?: boolean }).firstCall || !memberAsked ? null : await import("../services/firstCall.js").then((m) => m.laterCallThread(o.userId)).catch(() => null);
    const call = G.buildLiveCall({ userId: o.userId, callSid: o.callSid, firstName, direction: o.direction, team, voiceOn, callKey: `${o.userId}:gl:${admitted.id}`, voiceLayer: voiceLayer ?? "", contextSummary, rightNow: briefing.rightNow, findsNow: briefing.findsNow, callReason, timeOfDay: G.timeOfDay(new Date(), zone), first, thread, askedBy });
    const id = G.issueLiveLink({ ...call, capMs: admitted.capMs, budgetLimited: admitted.budgetLimited }, Date.now(), admitted.id);
    G.markCall(o.callSid, o.userId, "pending");
    // What the opening had to go on (which pieces, never their words): GPT-Live writes the line itself.
    recordDecision({ layer: 8, decision: "call.opening", userId: o.userId, outcome: "act", action: o.direction, proposal: { provider: "gpt-live", mode: "own_words", had: { firstName: !!firstName, timeOfDay: !!call.opening.timeOfDay, reason: !!call.opening.reason, firstCall: !!call.opening.firstCall, theirWords: !!call.opening.theirWords, inviter: !!call.opening.inviter, thread: !!call.opening.thread, askedBy: call.opening.askedBy ?? null } } }).catch(() => {});
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.connect({ action: `${process.env.API_URL}/co/gpt-live/after-stream` }).stream({ url: streamUrl }).parameter({ name: "s", value: id });
    return { twiml: twiml.toString() };
  } catch (err: any) {
    G.releaseSession(admitted.id);
    // The inbound mark set above, cleared: no call will follow it (with or without a sid).
    if (o.direction === "inbound") await releaseLiveCallMark(o.userId, o.callSid);
    console.error(`gpt-live: answer not built for ${o.userId.slice(0, 8)} (${String(err?.message ?? err).slice(0, 120)})`);
    return { refused: "unavailable", failClass: "build_error" };
  }
}

// A member GPT-Live can't take (Royce, 10-31: never ElevenLabs). Minutes used: busy. Unavailable: the existing
// can't-connect line, the failure noted and the call's status released, as when ElevenLabs can't register a call.
async function gptLiveRefusalTwiml(userId: string, callSid: string | null, r: Exclude<GptLiveAnswer, { twiml: string }>, direction: "inbound" | "outbound" = "inbound"): Promise<string> {
  const twiml = new twilio.twiml.VoiceResponse();
  if (r.refused === "budget_used" && direction === "inbound") {
    await recordDecision({ layer: 8, decision: "call.gpt_live_budget_reached", userId, outcome: "skip", action: r.why, proposal: { direction: "inbound" }, reason: r.why === "unreadable" ? "GPT-Live's minutes couldn't be read, so the call was refused (fails closed)" : "GPT-Live's minutes for the month are used" }).catch(() => {});
    twiml.reject({ reason: "busy" });
    return twiml.toString();
  }
  // Outbound, they've already answered: the minutes ran out between the check and the pickup (rare) is told like a failure to connect.
  if (r.refused === "budget_used") await recordDecision({ layer: 8, decision: "call.gpt_live_budget_reached", userId, outcome: "skip", action: r.why, proposal: { direction: "outbound", stage: "answered" }, reason: "GPT-Live's minutes ran out (or couldn't be read) between the dial and the answer" }).catch(() => {});
  else await recordDecision({ layer: 8, decision: "call.gpt_live_unavailable", userId, outcome: "skip", action: r.failClass, proposal: { direction, failClass: r.failClass, stage: "answer" } }).catch(() => {});
  noteCallFailure(userId, "registration");
  // Only a call whose status was set (inbound: the build failed after this path set it; outbound: the dial set it) has one to release,
  // scoped to this call's sid.
  if (callSid && (direction === "outbound" || (r.refused === "unavailable" && r.failClass === "build_error"))) await releaseFailedCall(userId, callSid);
  twiml.say(CANT_CONNECT_LINE);
  twiml.hangup();
  return twiml.toString();
}

// The trial number's Voice webhook, kept as a second way in for the team. The same member check as /co/incoming-call (a verified
// member's number, else the same decline), then gptLiveAnswer: every member gets what the main number gives them.
router.post("/gpt-live/incoming-call", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateTwilioSignature(req, "/co/gpt-live/incoming-call")) return res.status(401).send("Invalid Twilio signature.");
    const from = req.body.From as string | undefined;
    const callSid = (req.body.CallSid as string | undefined) ?? null;
    const caller = await inboundCallMember(from);
    const userId = caller.userId;
    if (!userId && caller.why !== "no account" && caller.why !== "no caller number") await recordDecision({ layer: 1, decision: "call.inbound", userId: null, outcome: "skip", action: "not_a_member", reason: caller.why }).catch(() => {});
    const twiml = new twilio.twiml.VoiceResponse();
    if (!userId || !inboundCallerVerified((req.body.StirVerstat as string | undefined) ?? null, process.env.ALLOW_UNVERIFIED_INBOUND_CALLERS === "true")) {
      twiml.say("Sorry, we don't recognize this number. Text us instead and we'll get you set up.");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }
    const live = await gptLiveAnswer({ userId, callSid, direction: "inbound" });
    if ("twiml" in live) return res.type("text/xml").send(live.twiml);
    return res.type("text/xml").send(await gptLiveRefusalTwiml(userId, callSid, live));
  } catch (err) {
    next(err);
  }
});

// The <Connect> action: Twilio asks for what comes next when the stream ends. A call whose session started just hangs up (its
// post-call steps run from the bridge). One that never got going hears the ElevenLabs path's own can't-connect line (approved
// copy), has the failure noted the way that path notes it and its call_status released so the next call isn't blocked, and is
// logged call.gpt_live_unavailable with why (a refused key also raises the existing dead-key text).
router.post("/gpt-live/after-stream", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateTwilioSignature(req, "/co/gpt-live/after-stream")) return res.status(401).send("Invalid Twilio signature.");
    const G = await import("../services/gptLive.js");
    const st = G.takeCallState(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    if (st && st.state !== "started") {
      const failClass = st.failClass ?? "no_stream";
      await recordDecision({ layer: 8, decision: "call.gpt_live_unavailable", userId: st.userId, outcome: "skip", action: failClass, proposal: { failClass, stage: "session" } }).catch(() => {});
      if (failClass === "auth") import("../services/modelKeyAlert.js").then((m) => m.noteModelFailure("openai", { kind: "auth", status: null })).catch(() => {});
      noteCallFailure(st.userId, "initiation");
      await releaseFailedCall(st.userId, req.body.CallSid as string | undefined);
      twiml.say(CANT_CONNECT_LINE);
    }
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    next(err);
  }
});

// Twilio's async answering-machine verdict on a GPT-Live call Cue placed (services/callTrigger.ts dials it with amdDialOptions). Kept by
// call sid for the post-call steps; a machine whose greeting has ended tells the call's bridge to leave its message (gptLive.ts).
router.post("/gpt-live/amd", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateTwilioSignature(req, "/co/gpt-live/amd")) return res.status(401).send("Invalid Twilio signature.");
    const callSid = typeof req.body.CallSid === "string" ? req.body.CallSid : "";
    const by = typeof req.body.AnsweredBy === "string" ? req.body.AnsweredBy : "";
    if (callSid && by) (await import("../services/gptLive.js")).noteAnsweredBy(callSid, by);
    return res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// After a GPT-Live call (services/gptLiveBridge.ts): the same steps as /co/el/post-call, fed from GPT-Live's transcript in
// ElevenLabs' turn shape. The conversation id is "gpt-live:<session>" so call_health and the decision rows compare the two by source.
// ElevenLabs grades its own calls; this one is graded here against the same criteria (gptLive.ts gradeLiveCall).
export async function runGptLivePostCall(r: import("../services/gptLiveBridge.js").LiveResult): Promise<unknown> {
  const G = await import("../services/gptLive.js");
  const userId = r.call.userId;
  const conversationId = `gpt-live:${r.sessionId}`;
  const turns = G.elTurnsOf(r.turns);
  const transcript = transcriptFromTurns(turns);
  const given = r.call.given;
  // A call Cue placed that reached voicemail, or where nobody spoke: the ElevenLabs webhook's own missed-call path (verdict, the gated
  // missed-call text), read from GPT-Live's transcript since GPT-Live has no voicemail tool (gptLive.ts liveVoicemailHeard). A call
  // they placed never takes this path.
  if (r.call.direction === "outbound") {
    const personTalked = hasRealUserTurn(transcript);
    // Twilio's AMD heard a machine, or the transcript holds a recorded greeting: the voicemail tool's verdict, checked the same way.
    const verdict = voicemailVerdict(G.isMachine(G.answeredByFor(r.call.callSid)) || G.liveVoicemailHeard(r.turns, isVoicemailGreeting), personTalked);
    const kind = missedKind(verdict, personTalked, "outbound");
    if (verdict !== "conversation") recordDecision({ layer: 8, decision: "call.voicemail", userId, outcome: verdict === "voicemail" ? "act" : "skip", action: verdict, proposal: { conversationId, termination: r.reason } }).catch(() => {});
    if (kind) {
      const { rows: u } = await pool.query(`SELECT id, first_name, phone_number FROM users WHERE id = $1`, [userId]);
      // What Cue actually said into the box (its own words, after the greeting), not the ElevenLabs path's set message.
      // Only when GPT-Live was told to leave a message: what Cue said from then on. A voicemail reached without one: null (no message left).
      const left = kind !== "voicemail" ? undefined : r.voicemail ? r.turns.filter((t) => t.who === "cue" && t.startMs >= r.voicemail!.fromMs).map((t) => t.text).join(" ").trim() || null : null;
      if (u[0]) return handleMissedVoiceCall(u[0], r.call.callSid ?? conversationId, kind, conversationId, left);
    }
  }
  G.gradeLiveCall(transcript).then((analysis) => import("../services/callEvals.js").then((m) => m.recordCallEvaluation(userId, conversationId, analysis, undefined, { transcript, given: [given.contextSummary, given.findsNow].filter(Boolean).join("\n") }))).catch(() => {});
  import("../services/offerGuard.js").then((m) => m.recordOfferSourceCheck(userId, conversationId, turns, given)).catch(() => {});
  let ended: Awaited<ReturnType<typeof processEndedCall>>;
  try {
    // The voice read's moments for this call (the tee's session, by the call's own key), checked against their consent again inside,
    // as on ElevenLabs; the ask after the call is queued as there too, now that the read runs on GPT-Live calls.
    ended = await processEndedCall({ userId, callKey: conversationId, offered: given.findsNow, offerSource: { turns, given }, startedAt: r.startedAt, endedAt: r.endedAt, twilioMetadata: r.call.callSid ? { call_sid: r.call.callSid } : null, load: async () => ({ transcript, recordingUrl: null, voice: async () => momentSignals(await takeVoiceMoments(r.call.callKey, callerTurnsFrom(turns))) }) });
  } catch (err) {
    flagNotStored({ userId, conversationId, startedAt: r.startedAt, endedAt: r.endedAt }).catch(() => {});
    throw err;
  }
  // OpenAI ending the session itself (its safety filter, a lost connection, its own time limit) is an abnormal end, as an ElevenLabs
  // error is (gptLive.ts liveTermination).
  recordCallHealth({ userId, conversationId, turns, durationSecs: r.seconds, terminationReason: G.liveTermination(r.endedBy, r.reason), status: null, startedAt: r.startedAt, endedAt: r.endedAt }).catch(() => {});
  const cueLines = turns.filter((t) => t.role !== "user").map((t) => t.message);
  const labelled = cueLines.filter((m) => !checkNoEmotionLabelOnCall(m).pass);
  if (labelled.length) recordDecision({ layer: 8, decision: "call.emotion_label", userId, outcome: "skip", action: "named_their_feeling", proposal: { conversationId, lines: labelled.slice(0, 5) }, reason: checkNoEmotionLabelOnCall(labelled[0]).reason ?? null }).catch(() => {});
  const narrated = cueLines.filter((m) => narratesInternalState(m));
  if (narrated.length) recordDecision({ layer: 8, decision: "call.narration", userId, outcome: "skip", action: "narrated_state", proposal: { conversationId, lines: narrated.slice(0, 5) }, reason: narratesInternalState(narrated[0]) }).catch(() => {});
  return ended.body;
}

// Root-cause guard (Royce, 2026-09-02, "check the recent text messages
// through sendblue" — Co had fired off 4 texts once the postCallFollowUp
// cron came alive for the first time in co-test): chat_ended fires for
// EVERY Hume session regardless of whether the other side ever said
// anything real — a call that went to voicemail, or was answered and hung
// up immediately, still produces a "transcript" that's just Co's own
// opening line, or the voicemail system's robotic prompt captured as if it
// were the user talking. Confirmed live: several queued follow-ups had
// transcripts with zero real user turns, and the model — told "here's what
// they told you" with nothing to reference — broke character and explained
// what it was missing instead of writing a message ("I don't have a record
// of a completed call..."), which then got sent as the actual text. Voicemail
// calls already have their own real follow-up path (the delayed missed-call
// SMS via pending_call_followups) — this only needs to stop scheduling a
// SECOND, content-less one on top of that.
//
// hasRealUserTurn now lives in harness/callGate.ts (2026-09-17) — the same
// "did a person actually talk" test is needed there too (auto-intake's
// "did an intake call happen" check), and the old version here only caught
// a few literal voicemail phrases, not greetings/carrier messages/bare
// fillers (see callGate.ts's isVoicemailGreeting).

// Schedules the post-call reflection text instead of sending it immediately
// — landing the second the call ends read as a scripted status update, not
// something a person who was actually listening would send. send_at is
// randomized 2h-2d out; jobs/postCallFollowUp.ts polls for due rows and
// generates + sends the actual message at send time (not now), so it's a
// fresh LLM call per send and can never be the same script twice.
// One claim per Hume chat (2026-09-22) — see the chat_ended handler. Wins
// the first time a chat is seen, and again only if its last attempt failed
// or has been stuck in processing past any real pipeline run (a crash).
// A completed chat can never be claimed again.
async function claimCallProcessing(chatId: string, userId: string): Promise<boolean> {
  const { rows } = await pool
    .query(
      `INSERT INTO call_processing (chat_id, user_id, status, claimed_at) VALUES ($1, $2, 'processing', NOW())
       ON CONFLICT (chat_id) DO UPDATE SET status = 'processing', claimed_at = NOW()
         WHERE call_processing.status = 'failed'
            OR (call_processing.status = 'processing' AND call_processing.claimed_at < NOW() - INTERVAL '10 minutes')
       RETURNING chat_id`,
      [chatId, userId],
    )
    .catch((err: any) => {
      // Fail open on a DB error: the user-level claim still runs, so this
      // never blocks a real first delivery the way failing closed would.
      console.error("claimCallProcessing failed (non-fatal, falling back to the user-level claim):", err?.message ?? err);
      return { rows: [{ chat_id: chatId }] };
    });
  return rows.length > 0;
}

async function finishCallProcessing(chatId: string, status: "completed" | "failed"): Promise<void> {
  await pool
    .query(`UPDATE call_processing SET status = $2, finished_at = NOW() WHERE chat_id = $1`, [chatId, status])
    .catch((err: any) => console.error("finishCallProcessing failed (non-fatal):", err?.message ?? err));
}

// The call never reached the agent (registration failed): no post-call webhook
// will come to clear the live status, and "call me" would stay blocked until
// the 30-minute reclaim. Scoped to this call's sid.
// A GPT-Live call's live mark, cleared when the call ends without its post-call (the answer couldn't be built, the session never
// started, or the post-call failed), so "call me" isn't blocked for the 30-minute reclaim and check-ins aren't held for liveCallHours
// (harness/momentFit.ts). Only a mark still live; scoped to this call's sid when there is one.
export async function releaseLiveCallMark(userId: string, callSid: string | null | undefined): Promise<void> {
  await pool
    .query(`UPDATE users SET call_status = 'failed', call_status_updated_at = NOW() WHERE id = $1 AND call_status IN ('initiated', 'dialing', 'ringing', 'in-progress', 'processing') AND ($2::text IS NULL OR call_sid = $2)`, [userId, callSid ?? null])
    .catch((err: any) => console.error("releaseLiveCallMark failed (non-fatal):", err?.message ?? err));
}
async function releaseFailedCall(userId: string, callSid: string | undefined): Promise<void> {
  await pool
    .query(`UPDATE users SET call_status = 'failed', call_status_updated_at = NOW() WHERE id = $1 AND ($2::text IS NULL OR call_sid = $2)`, [userId, callSid ?? null])
    .catch((err: any) => console.error("releaseFailedCall failed (non-fatal):", err?.message ?? err));
}

// A call Co placed that never became a conversation: a voicemail, or nobody
// spoke. Claimed once per call (voicemail_calls also keeps processEndedCall
// from treating it as a conversation), then the same gate the old machine-
// detection path used (once per call, none queued, none in the last day),
// and a note of what Co left so it knows later. If the send fails the claim
// is released, so ElevenLabs' retry can send it instead of finding it taken.
async function handleMissedVoiceCall(
  user: { id: string; first_name: string; phone_number: string },
  callSid: string,
  kind: "voicemail" | "silent",
  conversationId: string,
  // GPT-Live: the message Cue left in its own words (the ElevenLabs agent leaves VOICEMAIL_MESSAGE, so it's left out there).
  // undefined: the ElevenLabs agent left VOICEMAIL_MESSAGE; null: a voicemail was reached and no message was left.
  left?: string | null,
): Promise<{ sent: boolean; gate: string }> {
  const claim = await pool.query(`INSERT INTO voicemail_calls (call_sid) VALUES ($1) ON CONFLICT DO NOTHING RETURNING call_sid`, [callSid]);
  if (!claim.rows[0]) return { sent: false, gate: "already_claimed" };
  _io?.to(`user:${user.id}`).emit("co:call_completed", { call_sid: callSid, status: kind === "voicemail" ? "voicemail" : "no_answer" });
  await pool.query(`UPDATE users SET call_status = 'completed', call_status_updated_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});
  try {
    const note = kind === "voicemail" ? (left === null ? `Cue reached ${user.first_name}'s voicemail and left no message.` : `Cue left this voicemail: "${left ?? voicemailLeft(user.first_name)}"`) : `Co called ${user.first_name} but there was no real conversation (chat el:${conversationId}).`;
    const seen = await pool.query(`SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'system' AND content = $2 LIMIT 1`, [user.id, note]);
    if (!seen.rows[0]) await writeMemory(user.id, "system", note).catch((err: any) => console.error("post-call: failed to log the missed call (non-fatal):", err?.message ?? err));
    const missed = decideMissedCallFollowUp(await gatherMissedCallState(user.id, callSid), new Date());
    await recordDecision({ layer: 8, decision: "call.gate", userId: user.id, outcome: missed.send ? "act" : "skip", action: `missed_call_followup:${kind}`, checks: missed.checks });
    if (!missed.send) return { sent: false, gate: "gate_closed" };
    await sendMissedCallFollowUp(
      user,
      callSid,
      "voicemail",
      kind === "voicemail" ? `You just tried to call ${user.first_name} and reached voicemail.` : `You just tried to call ${user.first_name}. The line connected but nobody spoke, so you don't know if they heard you.`,
    );
    return { sent: true, gate: "sent" };
  } catch (err) {
    await pool.query(`DELETE FROM voicemail_calls WHERE call_sid = $1`, [callSid]).catch(() => {});
    throw err;
  }
}

// After a call ends (ElevenLabs, /co/el/post-call): voicemail skip, the per-call
// and per-user claims, transcript, audit, emotion, learning, intents, safety,
// the text-side summary and the follow-up. Moved here unchanged from the
// Hume chat_ended handler (2026-10-03) when calls moved off Hume; only where
// the transcript comes from changed (o.load).
type EndedCallData = {
  transcript: string;
  recordingUrl: string | null;
  // ElevenLabs' per-line frustration scores for the caller (harness/emotion.ts
  // frustrationMoments), read when the call's feelings are recorded.
  frustration?: () => Promise<ScoredLine[]>;
  // The live voice read's strongest moments (services/voiceRead.ts voiceMoments, basis "voice"): none when the call had no
  // read, or it was noisy.
  voice?: () => Promise<Omit<EmotionSignal, "at">[]>;
};
// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
async function processEndedCall(...a: Parameters<typeof processEndedCallInScope>): ReturnType<typeof processEndedCallInScope> {
  return withMember(a[0].userId, () => processEndedCallInScope(...a));
}
async function processEndedCallInScope(o: {
  userId: string;
  callKey: string;
  twilioMetadata?: { call_sid?: string } | null;
  load: () => Promise<EndedCallData>;
  // What Co had found for them going in (the call's finds_now): an event offered from it is on file, not invented (2026-10-05: the audit flagged a real offer as an invented fact).
  offered?: string;
  // When the call started and ended (the webhook's metadata): which commitments were this call's, and the confirmation's latency.
  startedAt?: Date | null;
  endedAt?: Date | null;
  // What the offer source check reads (services/offerGuard.ts unsourcedInCall): the call's turns and what it was given. Run for the
  // audit with the finds from the call's ledger added (harness/callGrounding.ts offerSourceCorrections).
  offerSource?: { turns: { role?: string; message?: string | null }[]; given: { firstName?: string; contextSummary?: string; findsNow?: string; rightNow?: string } };
  // false: don't queue the voice read's ask after this call (GPT-Live calls, 2026-10-31: the read can't run on them yet, so the ask
  // would offer something that doesn't happen). Default: asked as before.
  askVoiceRead?: boolean;
}): Promise<{ status: number; body: unknown; stored?: { transcriptSha256: string }; unstored?: true }> {
  const user_id = o.userId;
  const chat_id = o.callKey;
  const twilio_metadata = o.twilioMetadata ?? undefined;
    const byId = await pool.query(`SELECT id, first_name, phone_number, call_sid FROM users WHERE id = $1`, [user_id]);
    const callUser: { id: string; first_name: string; phone_number: string; call_sid: string | null } | null =
      byId.rows[0] ?? null;

    // Every model call after the call (extraction, learning, follow-up) is filed under them in our trace text (services/llmTraceText.ts).
    noteTraceUser(callUser?.id ?? user_id);

    // The AMD callback already flagged this call as an answering
    // machine/voicemail and sent its own instant follow-up — skip the
    // extraction/follow-up pipeline below so we don't hallucinate a
    // "reflection" on lines Co said to a voicemail box. users.call_sid
    // (stamped by callTrigger.ts when the call is placed) is the real
    // source of truth now that calls go through the media-stream bridge
    // rather than Hume's own /v0/evi/twilio integration — twilio_metadata
    // is only ever populated by that old path, kept here as a fallback in
    // case that ever changes back.
    const voicemailCallSid: string | null = callUser?.call_sid ?? twilio_metadata?.call_sid ?? null;
    if (voicemailCallSid) {
      const flagged = await pool.query(`SELECT 1 FROM voicemail_calls WHERE call_sid = $1`, [voicemailCallSid]);
      if (flagged.rows.length > 0) {
        console.log(`post-call: skipping extraction/follow-up for voicemail call ${voicemailCallSid}`);
        return { status: 200, body: { success: true, skipped: "voicemail" }, unstored: true };
      }
    }

    // Idempotency guard — Hume (or something in the Twilio-bridged path
    // specifically) has been observed delivering chat_ended more than once
    // for the same real call, moments apart. Without this, the full
    // extraction pipeline re-ran from scratch each time (non-deterministic
    // re-extraction, since it's an LLM call on the same transcript) and
    // scheduled a fresh follow-up every time. Atomic claim: only the
    // delivery that actually flips call_status to 'processing' gets a row
    // back and proceeds; every later delivery for the same call sees it
    // already 'processing'/'completed' and is a no-op ack. Second clause
    // covers the server process dying mid-pipeline (crash/restart), which
    // never reaches the catch block to reset to 'failed' — a row stuck in
    // 'processing' for longer than any real extraction takes is
    // reclaimable rather than permanently wedged.
    // Per-call claim keyed on Hume's chat id (2026-09-22). The user-level
    // claim below only blocks a duplicate while call_status still reads
    // processing/completed; once the member's NEXT call moves call_status
    // on, a late redelivery for the OLD chat used to pass it and re-run
    // extraction and the post-call follow-up for a call already handled.
    // The transcript-content match further down only ever protected the
    // stored transcript, not everything after it.
    if (chat_id && !(await claimCallProcessing(chat_id, user_id))) {
      console.log(`post-call: chat ${chat_id} already processed or in progress — ignoring duplicate delivery`);
      return { status: 200, body: { success: true, duplicate: true } };
    }

    const claimResult = await pool.query(
      `UPDATE users SET call_status = 'processing', updated_at = NOW()
       WHERE id = $1
         AND (
           call_status IS NULL
           OR call_status NOT IN ('processing', 'completed')
           OR (call_status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
         )
       RETURNING id`,
      [user_id],
    );
    if (!claimResult.rows[0]) {
      console.log(`post-call: chat_ended already processed for user ${user_id} (chat ${chat_id}) — ignoring duplicate delivery`);
      // Free this chat's claim so a genuine retry isn't blocked by it.
      if (chat_id) await finishCallProcessing(chat_id, "failed");
      return { status: 200, body: { success: true, duplicate: true } };
    }

    try {
      // Let the app know the call ended and Co is now extracting the profile
      _io?.to(`user:${user_id}`).emit("co:processing");

      const { transcript, recordingUrl: recording_url, frustration, voice } = await o.load();

      if (!transcript) {
        console.error(`post-call: empty transcript for chat ${chat_id} (user ${user_id})`);
        await pool.query(`UPDATE users SET call_status = 'failed' WHERE id = $1`, [user_id]);
        if (chat_id) await finishCallProcessing(chat_id, "failed");
        return { status: 200, body: { success: true, empty: true }, unstored: true };
      }

      // Fixed 2026-09-17 (finding 2) — AMD-based voicemail detection only
      // catches calls Twilio itself flagged as a machine; a transcribed
      // voicemail/carrier greeting can still slip through on a call that
      // wasn't (a borderline AMD result, a slow pickup). Strip any
      // greeting-like lines before anything downstream reads them as the
      // person's own words. The raw transcript (unstripped) is still what
      // gets stored to co_memories — this only affects what extraction,
      // grounding, and the follow-up draft see.
      const cleanTranscript = stripVoicemailGreetingLines(transcript);

      // Fixed 2026-09-17 (finding 3) — a call where only Co ever spoke
      // (nobody picked up, or picked up and said nothing substantive) used
      // to still run the full pipeline below: the transcript got treated
      // as a real conversation, "[Call] ..." became a text-context summary
      // as if the person said it, a profile got extracted from Co's own
      // lines, and captureIntent/auditCall ran against nothing. Stop here
      // instead, with one short factual note — hasRealUserTurn requires an
      // actual back-and-forth (Co spoke, then the person said something
      // that isn't a greeting/filler), same test the live bridge itself
      // uses for voicemail detection.
      if (!hasRealUserTurn(transcript)) {
        if (callUser) {
          // memory_type 'system' (not 'call_transcript') so this never
          // gets misread as "a real intake call happened" by
          // callGate.ts's decideAutoIntake, which looks for a genuine
          // call_transcript row to know intake is done. Keyed on the
          // note's own content (not the raw transcript) since that's what
          // actually gets inserted — a redelivered chat_ended would
          // otherwise write a second note every time.
          const noteContent = `Co called ${callUser.first_name} but there was no real conversation (chat ${chat_id}).`;
          const already = await pool.query(
            `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'system' AND content = $2 LIMIT 1`,
            [user_id, noteContent],
          );
          if (!already.rows[0]) {
            await writeMemory(user_id, "system", noteContent).catch((err: any) =>
              console.error("post-call: failed to log no-conversation call (non-fatal):", err?.message ?? err),
            );
          }
        }
        await pool.query(`UPDATE users SET call_status = 'completed', call_status_updated_at = NOW() WHERE id = $1`, [user_id]);
        if (chat_id) await finishCallProcessing(chat_id, "completed");
        _io?.to(`user:${user_id}`).emit("co:profile_ready");
        return { status: 200, body: { success: true, noRealConversation: true }, unstored: true };
      }

      // The call ending is the trigger (services/callFollowThrough.ts): what Co said it would send is confirmed now, then done, and
      // the deliverable goes out when its own turn finishes. First thing once a person talked, never waiting on the steps below.
      // It also opens the commitment tasks the call brain didn't (callCommitments.ts trackCommitmentsFromTranscript): the direct
      // path, and the same words never open twice.
      import("../services/callFollowThrough.js").then((m) => m.followThroughOnCallEnd({ userId: user_id, transcript: cleanTranscript, startedAt: o.startedAt ?? null, endedAt: o.endedAt ?? null })).catch(() => {});

      // Step 1 — Store raw transcript in co_memories immediately.
      // Idempotent on exact transcript content (2026-09-17, finding 14): a
      // partial-failure retry (chat_ended redelivered after a mid-pipeline
      // crash) used to re-insert this — and duplicate the emotion_signals
      // rows below — every time it reclaimed a 'failed' call_status.
      // What Co had going in, split into facts and Co's own impressions, so
      // the audit never takes a summary as proof (callContext.ts). The member's
      // goals with state, asks, delivered items, corrections and claims come from
      // the shared layer (services/memberKnowledge.ts), the same truth every path
      // reads; the call picture adds sent-page details, ledger lines and impressions.
      const [callPicture, auditKnowledge] = await Promise.all([
        buildCallKnowledge(user_id).catch(() => ({ summary: "", facts: "", impressions: "", thread: "" })),
        memberKnowledge(user_id, { include: AUDIT_SECTIONS }).catch(() => null),
      ]);
      const knownBeforeCall0 = knownBeforeFrom(auditKnowledge, callPicture);
      const knownBeforeCall = o.offered ? { ...knownBeforeCall0, facts: `${knownBeforeCall0.facts}\n\nWhat Cue had found for them before the call (anything offered from this list is on file):\n${o.offered}` } : knownBeforeCall0;
      const existingTranscriptMem = await pool.query(
        `SELECT id FROM co_memories WHERE user_id = $1 AND memory_type = 'call_transcript' AND content = $2 LIMIT 1`,
        [user_id, transcript],
      );
      let transcriptMemoryId: string;
      if (existingTranscriptMem.rows[0]) {
        transcriptMemoryId = existingTranscriptMem.rows[0].id;
      } else {
        transcriptMemoryId = await storeTranscriptMemory(user_id, transcript, { audioUrl: recording_url });
      }
      // Calls can't be gated live (Hume speaks as it generates), so every
      // call is audited right after: keepable promises are kept, the rest
      // become corrections for the next text (harness/callGrounding.ts).
      // Ongoing help they asked for on the call becomes a task, same as a text would (services/callTasks.ts).
      // What Co said it would send after the call is opened the moment the call ends, with its confirmation text
      // (services/callFollowThrough.ts, above); said live it already was one, and the same commitment never opens twice.
      // One after another, then the audit (2026-10-08): run side by side, each missed what the other opened, so one commitment
      // became two tasks and three searches. Now a promise a task from this call already carries is that task's.
      // What Cue already did on the call with its tools (services/callLedger.ts): the audit holds "I just sent it" to it, and never
      // reopens what's done as a promise.
      (async () => {
        await import("../services/callTasks.js").then((m) => m.tasksFromCall(user_id, cleanTranscript)).catch(() => {});
        const L = await import("../services/callLedger.js");
        const start = o.startedAt ?? new Date(Date.now() - 2 * 3_600_000);
        const ledger = await L.readCallLedger(user_id, new Date(start.getTime() - 60_000), new Date((o.endedAt ?? new Date()).getTime() + 2 * 60_000)).catch(() => null);
        const doneOnCall = ledger ? L.doneItems(ledger) : [];
        // What its searches found on the call: a correction never takes back a real find (and the offer source check's flags, which
        // can't see what a search found mid-call, are held to it too).
        const foundOnCall = ledger ? L.foundOnCall(ledger) : [];
        const offerFlags: OfferFlag[] = o.offerSource ? await import("../services/offerGuard.js").then((m) => m.unsourcedInCall(o.offerSource!.turns, { ...o.offerSource!.given, foundOnCall: L.foundLines(foundOnCall).join("\n") })).catch(() => []) : [];
        // The ledger unread: nothing to check a correction against, so none is written (a real send or find could be "taken back"); the
        // promises are still kept.
        const correctionsHeld = ledger ? undefined : "the call's done list couldn't be read";
        await auditCall(user_id, cleanTranscript, knownBeforeCall, { doneOnCall, foundOnCall, offerFlags, correctionsHeld });
      })().catch(() => {});
      // How scripted it sounded: stock comfort lines and repeated openers, logged for the morning review.
      {
        const r = stockReport(coLinesOf(cleanTranscript));
        if (r.stock.length || r.repeated.length) {
          recordDecision({ layer: 8, decision: "call.stock_lines", userId: user_id, outcome: "skip", action: "audit", proposal: { stock: r.stock.slice(0, 6), repeated: r.repeated } }).catch(() => {});
        }
      }

      // Emotion loop: the feelings in what they said on the call, read with the
      // text path's own read (harness/emotion.ts callEmotionMoments), once per
      // call (not again on a retried delivery). Overlaps the profile read below
      // and can never fail the call.
      const emotionDone = (async () => {
        if (existingTranscriptMem.rows[0]) {
          const had = await pool.query(`SELECT 1 FROM emotion_signals WHERE memory_id = $1 LIMIT 1`, [transcriptMemoryId]);
          if (had.rows.length) return;
        }
        // Beside the text read: ElevenLabs' frustration score on lines it didn't
        // already call negative. Fetched alongside the read, not after it.
        const scoring = frustration ? frustration().catch(() => [] as ScoredLine[]) : Promise.resolve([] as ScoredLine[]);
        // And the voice read's few moments, beside both (never in place of the text read).
        const voicing = voice ? voice().catch(() => [] as Omit<EmotionSignal, "at">[]) : Promise.resolve([] as Omit<EmotionSignal, "at">[]);
        const moments = await callEmotionMoments(cleanTranscript);
        const scored = await scoring;
        const frustrated = frustrationMoments(scored, moments); // mood: records the read (call frustration moments)
        // Read again right before the write: a stop during the read above keeps nothing of the voice (services/voiceReadConsent.ts).
        const voiced = await import("../services/voiceReadConsent.js").then((c) => voicing.then((v) => c.keepVoiceIfStillOn(user_id, v))).catch(() => [] as Omit<EmotionSignal, "at">[]);
        await recordEmotionSignals(user_id, [...moments, ...frustrated, ...voiced].map((m) => ({ ...m, memoryId: transcriptMemoryId }))); // mood: records the read
      })().catch((err: any) => console.error("post-call: reading the call's feelings failed (non-fatal):", err?.message ?? err));

      // Steps 2-5 — Extract psychographic data via Anthropic, sanitize against
      // DB CHECK constraints, generate goal embeddings, and upsert co_profiles.
      // Shared with the typed-intake fallback and the text channel — see
      // profileExtraction.ts.
      // One read for the profile, resolutions, corrections, cadence, planned
      // event and lessons from moments they corrected Co (callLearning.ts),
      // through the same gates and writes. Awaited, so a failure still marks
      // the call failed and it's retried. CALL_LEARNING=off: the old calls.
      if (process.env.CALL_LEARNING === "off") {
        const { extracted } = await extractPsychographicProfile(cleanTranscript);
        await storeProfile(user_id, extracted, cleanTranscript);
        extractPlannedEventMention(user_id, cleanTranscript).catch(() => {});
      } else {
        await learnFromCall({ userId: user_id, transcript: cleanTranscript, callRef: transcriptMemoryId ? `call_transcript:${transcriptMemoryId}` : null, callKey: o.callKey });
      }

      await emotionDone;

      // Step 7 — Ambient intent capture (non-blocking — runs in background)
      // A real ask from the call is searched right away (paced by the
      // proactive harness), not left for the next sweep.
      // scope: the whole call is new, so every ask stated anywhere in it
      // counts — a member who says what they're looking for in the first
      // 30 seconds and signs off on logistics ("I'll just text you the
      // rest") used to have the whole call captured as nothing at all.
      captureIntent(user_id, cleanTranscript, { scope: "whole_transcript", via: "call" })
        .then(() => surfaceNewAsksNow(user_id))
        .catch(() => {});
      // Their email, when it isn't on file and they gave it on the call (services/callEmail.ts): the intake extraction, then one text
      // confirming the address. Non-blocking; a member with an email on file is a single read.
      import("../services/callEmail.js").then((m) => m.captureEmailFromCall(user_id, cleanTranscript)).catch((err: any) => console.error("post-call: email capture failed (non-fatal):", err?.message ?? err));
      // Crisis wording on their side of the call (services/safety.ts): the
      // call prompt tells Co what to do in the moment; this makes sure the
      // team hears about it and offers are held afterward.
      const theirLines = cleanTranscript.split("\n").filter((l: string) => /^user:/i.test(l)).join("\n");
      if (soundsLikeCrisis(theirLines)) {
        pool
          .query(`SELECT first_name FROM users WHERE id = $1`, [user_id])
          .then((r) => recordSafetyConcern(user_id, r.rows[0]?.first_name ?? null, "phrase", "crisis wording on a call"))
          .catch(() => {});
      }
      // Bridges this call into the text side's own conversation log (Royce,
      // 2026-09-07) — see summarizeCallForTextContext for the gap this closes.
      // Call summary first (it feeds the picture), then rebuild the picture.
      summarizeCallForTextContext(user_id, cleanTranscript)
        .then(() => refreshPersonSnapshot(user_id, { force: true }))
        .catch(() => {});

      // The recap exists now (transcript + extraction persisted) — safe to
      // mark completed. Everything after this point (scheduling the
      // follow-up) is best-effort and must not affect retryability.
      await pool.query(`UPDATE users SET call_status = 'completed', call_status_updated_at = NOW() WHERE id = $1`, [user_id]);
      if (chat_id) await finishCallProcessing(chat_id, "completed");

      // Profile is fully extracted and stored — tell the app to show the Ready state
      _io?.to(`user:${user_id}`).emit("co:profile_ready");

      // Step 8 — Follow-up iMessage, scheduled 2h-2d out (see
      // scheduleFollowUpText) rather than sent instantly. The app only
      // shows "Ready" if it happens to be open — most people have hung up
      // and moved on, so the scheduled text is the only confirmation they
      // actually get that the call did something. hasRealUserTurn already
      // confirmed above, so this always fires when callUser is known.
      if (callUser) {
        await scheduleFollowUpText(user_id, cleanTranscript);
      }
      // After their first call: the voice read's one question, queued once ever, only where the read can run and only if it was
      // never asked or answered (services/voiceReadConsent.ts). Sent by the proactive queue; no answer means it stays off.
      if (callUser && o.askVoiceRead !== false) import("../services/voiceReadConsent.js").then((m) => m.queueVoiceReadAsk(user_id)).catch(() => {});

      // The transcript is stored and the processing completed: what ElevenLabs' copy may be deleted against (the raw transcript,
      // the one stored above).
      return { status: 200, body: { success: true }, stored: { transcriptSha256: transcriptHash(transcript) } };
    } catch (pipelineErr) {
      await pool.query(`UPDATE users SET call_status = 'failed' WHERE id = $1`, [user_id]);
      if (chat_id) await finishCallProcessing(chat_id, "failed");
      throw pipelineErr;
    }
}

async function scheduleFollowUpText(userId: string, transcript: string): Promise<void> {
  try {
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const delayMs = TWO_HOURS_MS + Math.random() * (TWO_DAYS_MS - TWO_HOURS_MS);
    await pool.query(
      `INSERT INTO post_call_follow_ups (user_id, transcript, send_at) VALUES ($1, $2, NOW() + $3 * INTERVAL '1 millisecond')`,
      [userId, transcript, delayMs],
    );
  } catch (scheduleErr: any) {
    console.error("Post-call follow-up scheduling failed (non-fatal):", scheduleErr?.message ?? scheduleErr);
  }
}

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

      let filteredKeys = Object.keys(req.body).filter((key) =>
        allowed.includes(key),
      );

      // Fixed 2026-09-17 (finding 17): an empty body (or one with no
      // recognized fields) built `SET , updated_at = NOW()` — invalid SQL,
      // a 500 with no useful message. Reject it plainly instead.
      if (filteredKeys.length === 0) {
        return res.status(400).send("No valid fields to update.");
      }

      // Fixed 2026-09-17 (finding 17): this let a self-service edit set
      // `city` with no check at all — every OTHER writer of co_profiles.city
      // (calls, texts) has to go through cityChangeAllowed, gated on the
      // person's own words actually placing them somewhere, specifically so
      // an unrelated mention can't silently move someone's city. A direct
      // PUT to this field bypassed that entirely. The person explicitly
      // naming their own city in this field IS itself first-person
      // evidence — stronger than a transcript inference — so this runs it
      // through the same gate (and the same audit trail) rather than a
      // separate, weaker rule, using a synthesized line so it reads as
      // their own words the same way a transcript-sourced one would.
      if (filteredKeys.includes("city")) {
        const requestedCity = typeof req.body.city === "string" ? req.body.city.trim() : "";
        if (!requestedCity) {
          filteredKeys = filteredKeys.filter((k) => k !== "city");
        } else {
          const existing = await pool.query(`SELECT city FROM co_profiles WHERE user_id = $1`, [req.params.user_id]);
          const existingCity: string | null = existing.rows[0]?.city ?? null;
          const cityAllowed = cityChangeAllowed(existingCity, requestedCity, `user: I'm in ${requestedCity}`);
          await recordDecision({
            layer: 4,
            decision: "profile.city",
            userId: req.params.user_id,
            outcome: cityAllowed ? "act" : "skip",
            action: cityAllowed ? "moved" : "kept_existing",
            proposal: { from: existingCity, to: requestedCity, via: "self_service_edit" },
            checks: [{ name: "they_said_they_live_there", pass: cityAllowed, reason: cityAllowed ? "self-service edit, their own field" : "named as a preference, not a move" }],
          }).catch(() => {});
          if (!cityAllowed) {
            filteredKeys = filteredKeys.filter((k) => k !== "city");
          }
        }
        if (filteredKeys.length === 0) {
          return res.status(400).send("No valid fields to update.");
        }
      }

      const values = filteredKeys.map((key) => req.body[key]);

      const setClause = filteredKeys
        .map((key, index) => `${key} = $${index + 2}`)
        .join(", ");

      const result = await pool.query(
        `UPDATE co_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
        [req.params.user_id, ...values],
      );

      if (!result.rows[0]) return res.status(404).send("Profile not found.");
      // A city change moves their stored zone with it (services/memberTime.ts).
      if (filteredKeys.includes("city")) await (await import("../services/memberTime.js")).refreshMemberZone(req.params.user_id);

      return res.status(200).send({ success: true, data: result.rows[0] });
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
      // Whole-transcript scope for the same reason as the Hume webhook
      // above — this is a finished conversation, not one text turn.
      captureIntent(String(user_id), String(transcript), { scope: "whole_transcript", via: "intake" }).catch(() => {});
      extractPlannedEventMention(String(user_id), String(transcript)).catch(() => {});
      summarizeCallForTextContext(String(user_id), String(transcript)).catch(() => {});

      _io?.to(`user:${user_id}`).emit("co:profile_ready");

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/location/:user_id removed (Royce, 2026-09-02) — its only caller
// was the app's profile.tsx GPS-permission flow, and the app itself is
// being sunset. It wrote to co_profiles.coordinates via PostGIS functions
// (ST_SetSRID/ST_MakePoint), which nothing ever read back downstream even
// while this was live — see db/migrations.ts's postgis teardown migration,
// which drops the column and the extension itself.

export default router;
