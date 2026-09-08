import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { createHmac, timingSafeEqual } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import type { Server as IOServer } from "socket.io";
import pool from "../db/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { generateEmbedding } from "../services/embeddings.js";
import {
  assessConversationCoverage,
  captureIntent,
  extractPlannedEventMention,
  extractPsychographicProfile,
  persistCoveredTopics,
  RAPPORT_TOPICS,
  storeProfile,
  storeTranscriptMemory,
} from "../services/profileExtraction.js";
import { generateRecommendation } from "../services/recommendation.js";
import { buildContextSummary } from "../services/callContext.js";
import sendblue from "../services/sendblue.js";
import { generateHumeVoiceLine, generateVoiceNote } from "../services/voiceNote.js";
import { triggerCallForUser } from "../services/callTrigger.js";
import { prewarmHumeConnection, hasReceivedRealSpeech } from "../services/mediaStreamBridge.js";

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
function validateTwilioSignature(req: Request, path: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const sig = req.headers["x-twilio-signature"] as string | undefined;
  if (!sig) return false;
  const url = `${process.env.API_URL}${path}`;
  return twilio.validateRequest(process.env.TWILIO_AUTH!, sig, url, req.body);
}

// Reject webhook calls that didn't come from Hume. Hume signs each webhook
// with a dedicated webhook signing key (HUME_SIGNIN_KEY, generated on Hume's
// Developers page — separate from HUME_API_KEY) — HMAC-SHA256 over the exact
// string "${rawBody}.${timestamp}", hex-encoded, sent as
// X-Hume-AI-Webhook-Signature, with the timestamp itself sent as
// X-Hume-AI-Webhook-Timestamp (rejected if older than 180s, to block
// replay). Requires req.body to be the raw Buffer for this route (see
// server.ts's express.raw() on /co/webhook) — a re-serialized/parsed-then-
// stringified body isn't guaranteed byte-identical to what Hume actually
// signed.
function validateHumeWebhook(req: Request): boolean {
  const secret = process.env.HUME_SIGNIN_KEY;
  if (!secret) return true; // skip when not configured (dev)

  const signature = req.headers["x-hume-ai-webhook-signature"] as string | undefined;
  const timestamp = req.headers["x-hume-ai-webhook-timestamp"] as string | undefined;
  if (!signature || !timestamp) return false;

  const timestampMs = Number(timestamp) * 1000;
  const deltaMs = Date.now() - timestampMs;
  if (!Number.isFinite(timestampMs) || Math.abs(deltaMs) > 180_000) return false;

  const rawBody = (req.body as Buffer).toString("utf-8");
  const expected = createHmac("sha256", secret).update(`${rawBody}.${timestamp}`).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Best-effort call-start marker for elapsed_minutes below — Co has no other
// way to know how long a call has actually run (see the prompt's "start
// wrapping up around 15 minutes" instruction), and Hume's own max_duration
// timeout otherwise cuts her off silently mid-sentence with no chance to
// close gracefully. Deliberately not the full live-transcript/dashboard
// machinery co-test's version has — just enough state to answer "how long
// has this call been going," cleared once chat_ended fires or after a
// generous timeout so a crashed/never-ended call can't leak entries forever.
const callStartTimes = new Map<string, number>();
const CALL_START_TTL_MS = 60 * 60 * 1000;

function markCallStarted(userId: string): void {
  callStartTimes.set(userId, Date.now());
  setTimeout(() => {
    // Only clear if still the same start — chat_ended already deletes it
    // itself; this is just a backstop against an entry never getting
    // cleared at all.
    callStartTimes.delete(userId);
  }, CALL_START_TTL_MS).unref?.();
}

function getElapsedMinutes(userId: string): number | null {
  const startedAt = callStartTimes.get(userId);
  return startedAt ? (Date.now() - startedAt) / 60_000 : null;
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
  while (true) {
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
    const result = await propagateAttributes(
      { userId: user.id, traceName: "co.sendMissedCallFollowUp" },
      () =>
        generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          experimental_telemetry: { isEnabled: true, functionId: "co.sendMissedCallFollowUp" },
          prompt: `You are Co, an exclusive life concierge. ${situationPrompt} Send a short iMessage letting ${user.first_name} know, and that they can reply here whenever they're ready or expect another call soon. Tone: calm, unhurried, like a private members club. No exclamation points. No em dashes. 2 sentences max.`,
        }),
    );
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

      const result = await triggerCallForUser(user_id, _io);
      if (!result.success) {
        const status = result.error === "User not found." ? 404 : 403;
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
// Handles missed calls (no-answer, busy, failed, canceled) and voicemail
// pickups (via AnsweredBy from AMD) by sending a Co iMessage follow-up.
router.post(
  "/call-status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateTwilioSignature(req, "/co/call-status")) {
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

        // Real bug found live, 2026-09-07: Royce answered and said "hello,"
        // but Twilio's async AMD still came back "machine" — a known real
        // false-positive risk (short greetings can fool it) — and the code
        // had no way to know a live human had already spoken, so it cut a
        // genuine live call to the canned voicemail line below. Hume's own
        // STT is ground truth for whether a real person is actually
        // talking, and it's strictly more reliable than Twilio's guess —
        // if it already transcribed real speech on this call, trust that
        // over a late "machine" verdict and leave the live conversation
        // alone.
        if (hasReceivedRealSpeech(CallSid)) {
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

        // A fixed voicemail line every time reads as a canned system
        // message — vary it (Haiku, one short line, hard fallback), said
        // directly into the call's TwiML while it's still live, so
        // generation must never meaningfully delay the redirect.
        let voicemailLine = user
          ? `Hey ${user.first_name}, it's Co. Sorry I missed you — I'll try you again soon.`
          : `Hey, it's Co. Sorry I missed you — I'll try you again soon.`;
        try {
          const { text: variedLine } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            experimental_telemetry: { isEnabled: true, functionId: "co.callStatus.voicemailLine" },
            prompt: `You are Co, an exclusive life concierge. You just called ${user ? user.first_name : "someone"} and reached their voicemail. Leave a short, natural one-line voicemail greeting letting them know you'll try again soon — vary how you say it, don't just repeat "Sorry I missed you." Tone: calm, unhurried, like a private members club. No exclamation points, no em dashes. Under 140 characters.`,
          });
          const trimmed = variedLine.trim();
          if (trimmed) voicemailLine = trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
        } catch (genErr: any) {
          console.error("Voicemail-line generation failed (non-fatal, using default):", genErr?.message ?? genErr);
        }

        // Twilio's built-in <Say> voices are a different voice engine
        // entirely from Co's real Hume voice — a real caller hearing Co's
        // actual voice cut off mid-call and replaced by an unrelated one
        // reads as a hard glitch, not just a wrong-branch redirect.
        // generateHumeVoiceLine synthesizes this line with Co's own attached
        // voice via Hume's standalone TTS endpoint. Falls back to Twilio's
        // own <Say> only if that synthesis call itself fails.
        const voiceResponse = new twilio.twiml.VoiceResponse();
        try {
          const audioUrl = await generateHumeVoiceLine(voicemailLine);
          voiceResponse.play(audioUrl);
        } catch (ttsErr: any) {
          console.error("Hume voicemail-line TTS failed, falling back to Twilio Say (non-fatal):", ttsErr?.message ?? ttsErr);
          voiceResponse.say({ voice: "Polly.Matthew-Neural" }, voicemailLine);
        }
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
        // Previously unrecoverable — generated fresh every call but never
        // written down anywhere, so there was no way to review what Co
        // actually said on a real person's voicemail after the fact.
        if (user) {
          const voicemailMemContent = `Co left this voicemail: "${voicemailLine}"`;
          await pool
            .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2) RETURNING id`, [
              user.id,
              voicemailMemContent,
            ])
            .then((mem) =>
              generateEmbedding(voicemailMemContent)
                .then((emb) =>
                  pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
                    `[${emb.join(",")}]`,
                    mem.rows[0].id,
                  ]),
                )
                .catch((err: any) => console.error("Voicemail-line embedding failed (non-fatal):", err?.message ?? err)),
            )
            .catch((err: any) => console.error("Voicemail-line logging failed (non-fatal):", err?.message ?? err));
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
        await pool.query(
          `UPDATE users SET call_status = $2 WHERE phone_number = $1 AND call_sid = $3`,
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

// POST /co/incoming-call — Twilio's inbound Voice webhook for
// TWILIO_PHONE_NUMBER. A user can always reach Co by calling this number
// directly — the other half of "always lend an ear" alongside the proactive
// check-in cron. Generates the same <Connect><Stream> TwiML
// services/callTrigger.ts uses for outbound calls, into the same
// mediaStreamBridge.ts. Only a recognized caller (phone number matches a
// user) reaches that bridge at all — an unrecognized number is turned away
// here, before any stream connects, rather than being bridged into Hume
// with no identity (mediaStreamBridge.ts requires user_id and closes
// without it).
router.post(
  "/incoming-call",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateTwilioSignature(req, "/co/incoming-call")) {
        return res.status(401).send("Invalid Twilio signature.");
      }

      const from = req.body.From as string | undefined;
      const callSid = req.body.CallSid as string | undefined;
      const result = from
        ? await pool.query(`SELECT id FROM users WHERE phone_number = $1`, [from])
        : null;
      const userId: string | null = result?.rows[0]?.id ?? null;

      const twiml = new twilio.twiml.VoiceResponse();
      if (!userId) {
        twiml.say("Sorry, we don't recognize this number. Text us instead and we'll get you set up.");
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
      }

      // Start the Hume handshake now, while this TwiML response is still in
      // flight back to Twilio and its media stream is connecting — instead
      // of waiting for the stream's "start" event after that's already
      // done. See mediaStreamBridge.ts's prewarmHumeConnection. Twilio's
      // Voice webhook always includes CallSid — used to key the prewarm so
      // it can't collide with a concurrent outbound call to the same user.
      if (callSid) prewarmHumeConnection(userId, callSid);

      const mediaStreamUrl = `${process.env.API_URL!.replace(/^http/, "ws")}/media-stream`;
      const stream = twiml.connect().stream({ url: mediaStreamUrl });
      stream.parameter({ name: "user_id", value: userId });

      return res.type("text/xml").send(twiml.toString());
    } catch (err) {
      next(err);
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

// Two tools live here — surface_recommendation (an Intent-Layer real action,
// see recommendation.ts) and assess_conversation_coverage. userId (optional
// — custom_session_id, resolved with a phone-number fallback below since
// Hume doesn't always reliably return it) lets a topic confirmed mid-call
// get persisted to co_profiles.topics_covered, the same store the
// text-channel coverage nudge reads — best-effort only, EVI's own live
// behavior doesn't depend on either of these succeeding.
async function handleToolCall(
  chatId: string,
  toolCallMessage: HumeToolCallMessage | undefined,
  userId?: string,
): Promise<void> {
  if (!toolCallMessage) return;

  if (toolCallMessage.name === "surface_recommendation") {
    try {
      const result = userId
        ? await generateRecommendation(userId)
        : { available: false as const, reason: "no user resolved for this call" };
      await sendHumeToolResponse(chatId, toolCallMessage.tool_call_id, JSON.stringify(result));
    } catch (err: any) {
      console.error("co/webhook: surface_recommendation failed:", err?.message ?? err);
      await sendHumeToolResponse(
        chatId,
        toolCallMessage.tool_call_id,
        JSON.stringify({ available: false, reason: "lookup failed" }),
      ).catch(() => {});
    }
    return;
  }

  if (toolCallMessage.name !== "assess_conversation_coverage") return;

  try {
    const { transcript } = await fetchHumeCallData(chatId);
    // Confirmed live, 2026-09-06: this call never passed priorContext, so
    // every single call judged coverage purely off its own live transcript —
    // even when co_profiles already had a rich, recent profile from a call
    // minutes earlier. That's exactly the gap assessConversationCoverage's
    // own priorContext parameter exists to close (see its comment above);
    // it just wasn't being wired in at this, its only real call site. A
    // real back-to-back call re-ran the entire 9-topic Rapport discovery
    // from scratch as a result, with the model never marking anything
    // "already covered."
    const priorContext = userId ? await buildContextSummary(userId).catch(() => "") : "";
    const assessment = await assessConversationCoverage(transcript, priorContext);
    if (userId) persistCoveredTopics(userId, assessment);
    // elapsed_minutes rides along on the same tool result the prompt already
    // polls periodically, rather than a separate tool.
    const elapsedMinutes = userId ? getElapsedMinutes(userId) : null;
    await sendHumeToolResponse(
      chatId,
      toolCallMessage.tool_call_id,
      JSON.stringify({
        ...assessment,
        ...(elapsedMinutes !== null ? { elapsed_minutes: Math.round(elapsedMinutes * 10) / 10 } : {}),
      }),
    );
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
// Hume's Twilio integration does not reliably return custom_session_id
// (confirmed empty on real calls) even though it's passed on the handshake
// — fall back to resolving the user by the phone number Twilio actually
// dialed, which Hume does include on the Twilio leg. Shared by
// chat_started/tool_call/chat_ended so all three resolve the same way.
async function resolveUserId(
  custom_session_id: string | undefined,
  twilio_metadata: { to_number?: string } | undefined,
): Promise<string | null> {
  if (custom_session_id) return custom_session_id;
  if (twilio_metadata?.to_number) {
    const byPhone = await pool.query(`SELECT id FROM users WHERE phone_number = $1`, [twilio_metadata.to_number]);
    return byPhone.rows[0]?.id ?? null;
  }
  return null;
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
const VOICEMAIL_BOILERPLATE = /is not available at the tone|forwarded to voicemail|please record your message|record your message when you (have finished|are finished)/i;

function hasRealUserTurn(transcript: string): boolean {
  return transcript
    .split("\n")
    .filter((line) => /^user:/i.test(line.trim()))
    .map((line) => line.replace(/^user:\s*/i, "").trim())
    .some((line) => line.length > 0 && !VOICEMAIL_BOILERPLATE.test(line));
}

// Schedules the post-call reflection text instead of sending it immediately
// — landing the second the call ends read as a scripted status update, not
// something a person who was actually listening would send. send_at is
// randomized 2h-2d out; jobs/postCallFollowUp.ts polls for due rows and
// generates + sends the actual message at send time (not now), so it's a
// fresh LLM call per send and can never be the same script twice.
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

router.post(
  "/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!validateHumeWebhook(req)) {
        return res.status(401).send("Unauthorized.");
      }

      // req.body is the raw Buffer here (see server.ts's express.raw() on
      // this path, needed for signature verification above) — parse it now
      // that verification is done.
      const parsedBody = JSON.parse((req.body as Buffer).toString("utf-8"));
      const { event_name, custom_session_id, chat_id, chat_group_id, twilio_metadata, tool_call_message } = parsedBody;

      if (event_name === "chat_started") {
        res.status(200).send({ success: true });
        const userId = await resolveUserId(custom_session_id, twilio_metadata);
        if (userId) markCallStarted(userId);
        return;
      }

      if (event_name === "tool_call") {
        res.status(200).send({ success: true });
        const userId = await resolveUserId(custom_session_id, twilio_metadata);
        handleToolCall(chat_id, tool_call_message, userId ?? undefined).catch((err) =>
          console.error("co/webhook: unhandled tool_call error:", err?.message ?? err),
        );
        return;
      }

      if (event_name !== "chat_ended") {
        return res.status(200).send({ success: true, ignored: event_name });
      }

      const user_id = await resolveUserId(custom_session_id, twilio_metadata);
      if (!user_id || !chat_id) {
        console.error(`co/webhook: could not resolve user for chat ${chat_id} — body: ${JSON.stringify(parsedBody)}`);
        return res.status(400).send("Missing required fields.");
      }
      callStartTimes.delete(user_id);

      const byId = await pool.query(`SELECT id, first_name, phone_number, call_sid FROM users WHERE id = $1`, [user_id]);
      const callUser: { id: string; first_name: string; phone_number: string; call_sid: string | null } | null =
        byId.rows[0] ?? null;

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
          console.log(`co/webhook: skipping extraction/follow-up for voicemail call ${voicemailCallSid}`);
          return res.status(200).send({ success: true, skipped: "voicemail" });
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
        console.log(`co/webhook: chat_ended already processed for user ${user_id} (chat ${chat_id}) — ignoring duplicate delivery`);
        return res.status(200).send({ success: true, duplicate: true });
      }

      try {
        // Let the app know the call ended and Co is now extracting the profile
        _io?.to(`user:${user_id}`).emit("co:processing");

        const [{ transcript, emotions }, recording_url] = await Promise.all([
          fetchHumeCallData(chat_id),
          fetchHumeRecordingUrl(chat_id),
        ]);

        if (!transcript) {
          console.error(`co/webhook: empty transcript for chat ${chat_id} (user ${user_id})`);
          await pool.query(`UPDATE users SET call_status = 'failed' WHERE id = $1`, [user_id]);
          return res.status(200).send({ success: true, empty: true });
        }

        // Step 1 — Store raw transcript in co_memories immediately
        await storeTranscriptMemory(user_id, transcript, {
          emotionalContext: emotions,
          audioUrl: recording_url,
        });

        // Steps 2-5 — Extract psychographic data via Anthropic, sanitize against
        // DB CHECK constraints, generate goal embeddings, and upsert co_profiles.
        // Shared with the typed-intake fallback and the text channel — see
        // profileExtraction.ts.
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
        extractPlannedEventMention(user_id, transcript).catch(() => {});

        // The recap exists now (transcript + extraction persisted) — safe to
        // mark completed. Everything after this point (scheduling the
        // follow-up) is best-effort and must not affect retryability.
        await pool.query(`UPDATE users SET call_status = 'completed' WHERE id = $1`, [user_id]);

        // Profile is fully extracted and stored — tell the app to show the Ready state
        _io?.to(`user:${user_id}`).emit("co:profile_ready");

        // Step 8 — Follow-up iMessage, scheduled 2h-2d out (see
        // scheduleFollowUpText) rather than sent instantly. The app only
        // shows "Ready" if it happens to be open — most people have hung up
        // and moved on, so the scheduled text is the only confirmation they
        // actually get that the call did something.
        if (callUser && hasRealUserTurn(transcript)) {
          await scheduleFollowUpText(user_id, transcript);
        }

        return res.status(200).send({ success: true });
      } catch (pipelineErr) {
        await pool.query(`UPDATE users SET call_status = 'failed' WHERE id = $1`, [user_id]);
        throw pipelineErr;
      }
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
      extractPlannedEventMention(String(user_id), String(transcript)).catch(() => {});

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
