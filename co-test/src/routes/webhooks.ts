import { anthropic } from "@ai-sdk/anthropic";
import { propagateAttributes } from "@langfuse/tracing";
import { generateText } from "ai";
import { createHmac, timingSafeEqual } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { DateTime } from "luxon";
import type { Server } from "socket.io";
import twilio from "twilio";
import pool from "../../../api/src/db/db.js";
import { detectSeekingMode, detectTurnTone } from "../../../api/src/services/emotionalTone.js";
import { isOptInKeyword, isOptOutKeyword } from "../../../api/src/services/optOut.js";
import { hasPendingEmail, splitFullName } from "../../../api/src/services/identity.js";
import { sendSMS } from "../../../api/src/otpActions.js";
import {
  assessConversationCoverage,
  captureIntent,
  extractPsychographicProfile,
  persistCoveredTopics,
  RAPPORT_TOPIC_DESCRIPTIONS,
  RAPPORT_TOPICS,
  storeProfile,
  storeTranscriptMemory,
} from "../../../api/src/services/profileExtraction.js";
import sendblue from "../../../api/src/services/sendblue.js";
import elevenlabs from "../../../api/src/services/elevenlabs.js";
import { buildContextSummary } from "../services/callContext.js";
import { triggerCall } from "../services/callTrigger.js";
import { simulateModeratorApproval } from "../services/circlesSimulation.js";
import { getCoPersonaPrompt } from "../services/coPersona.js";
import {
  endLiveCall,
  getElapsedMinutes,
  getLiveSnapshot,
  getTranscriptLinesSeen,
  pushLiveEvent,
  setTranscriptLinesSeen,
  startLiveCall,
  startPolling,
} from "../services/liveCallState.js";
import { generateRecommendation } from "../services/recommendation.js";
import { generateHumeVoiceLine } from "../../../api/src/services/voiceNote.js";
import { findRealVenues } from "../services/venueLookup.js";
import { runConversationReplyAgent } from "../agent/conversationReply.js";

// Needed here (not just in callTrigger.ts) to redirect a still-live call to
// a voicemail TwiML line once AMD detects an answering machine — see the
// AnsweredBy branch in /co/call-status below.
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_CLIENT_SECRET!,
  { accountSid: process.env.TWILIO_LIVE_SID! },
);

// Mounted at the SAME paths production uses (/sendblue/webhook, /co/call-status,
// /co/webhook) — see api/src/server.ts and api/src/routes/co.ts for the
// production originals. Because the paths match, "point the shared Sendblue
// webhook / dev Hume config webhook at co-test" and "point it back at
// production" are both a plain host swap:
//   prod:    https://copatible-production.up.railway.app/sendblue/webhook
//   co-test: https://test.copatible.com/sendblue/webhook
// Sendblue's webhook is a single account-level setting (confirmed — see
// task notes), so only one of {production, co-test} can receive inbound
// iMessages at a time. This must be flipped manually in Sendblue's dashboard
// before a real-iMessage test session, and flipped back to the prod URL
// afterward — the phone-test page surfaces this as a checklist reminder
// rather than trying to automate it (no evidence Sendblue exposes webhook
// config via API).

// Heuristic-only (no LLM call — this is directly observable, not something
// to infer) read of how the user themselves texts, from their own lines in
// the chronological window already fetched for the reply prompt. Nudges
// phrasing only (length/formality/emoji) — deliberately leaves Co's core
// brand-voice rules (no em dashes, no exclamation points) alone, since those
// aren't a per-user mirroring target. Needs at least 2 of the user's own
// messages before saying anything, so a first-ever text doesn't get a hint
// built off n=1. Mirrors api/src/routes/sendblue.ts's version exactly, kept
// in sync manually since the two webhook handlers are separate
// implementations by design (see the header comment on this file).
function deriveStyleHint(chronological: { content: string }[]): string {
  const userLines = chronological
    .map((m) => m.content)
    .filter(
      (c) =>
        c.startsWith("User said: ") || c.startsWith("User sent a voice memo: "),
    )
    .map((c) => c.replace(/^User (said|sent a voice memo): /, ""));

  if (userLines.length < 2) return "";

  const avgWords =
    userLines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0) /
    userLines.length;
  const emojiRate =
    userLines.filter((l) => /\p{Emoji_Presentation}/u.test(l)).length /
    userLines.length;
  const lowercaseRate =
    userLines.filter((l) => l === l.toLowerCase() && /[a-z]/.test(l)).length /
    userLines.length;

  const notes: string[] = [];
  if (avgWords <= 6) {
    notes.push(
      "they text short and to the point — keep your replies just as brief, don't pad them out",
    );
  } else if (avgWords >= 20) {
    notes.push(
      "they text in longer, fuller messages — a slightly fuller reply than usual is fine here",
    );
  }
  if (emojiRate >= 0.3) {
    notes.push(
      "they use emoji — an occasional one back is fine, don't force it every message",
    );
  }
  if (lowercaseRate >= 0.6) {
    notes.push(
      "they text casually, lowercase, minimal punctuation — match that relaxed tone",
    );
  }

  return notes.length
    ? `\nHow they text (match this energy, not their exact words): ${notes.join("; ")}.`
    : "";
}

type HumeChatEvent = {
  role: string;
  type: string;
  message_text: string | null;
  emotion_features: string | null;
  timestamp?: number;
};

async function fetchHumeChatEvents(chatId: string): Promise<HumeChatEvent[]> {
  const events: HumeChatEvent[] = [];
  let page = 0;
  for (;;) {
    const res = await fetch(
      `https://api.hume.ai/v0/evi/chats/${chatId}?page_size=100&page_number=${page}`,
      { headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY! } },
    );
    if (!res.ok)
      throw new Error(`Hume chat-events fetch failed: ${res.status}`);
    const data: any = await res.json();
    events.push(...(data.events_page ?? []));
    if (page + 1 >= (data.total_pages ?? 1)) break;
    page += 1;
  }
  return events;
}

function buildTranscript(events: HumeChatEvent[]): string {
  return events
    .filter((e) => e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE")
    .map(
      (e) =>
        `${e.role === "USER" ? "user" : "assistant"}: ${e.message_text ?? ""}`,
    )
    .join("\n");
}

// Hume's prosody model scores every USER_MESSAGE across ~48 emotions
// (confirmed against a real call's raw events) — this was being fetched
// into `events` already but thrown away entirely by buildTranscript above,
// which only ever kept message_text. That's the actual unused signal:
// extractPsychographicProfile currently infers "blockers"/emotional_state
// from the TEXT alone, so a topic mentioned calmly and a topic that made
// someone genuinely anxious read identically to it. This surfaces the
// moments Hume's own voice analysis flagged as most emotionally loaded, so
// the profile can weight toward what actually carried real feeling, not
// just what came up most.
const PAIN_SIGNAL_EMOTIONS = [
  "Anxiety",
  "Distress",
  "Sadness",
  "Fear",
  "Disappointment",
  "Shame",
  "Guilt",
  "Embarrassment",
  "Pain",
  "Doubt",
  "Empathic Pain",
  "Tiredness",
] as const;

function extractEmotionalHighlights(events: HumeChatEvent[]): string {
  const scored = events
    .filter((e) => e.type === "USER_MESSAGE" && e.message_text && e.emotion_features)
    .map((e) => {
      let features: Record<string, number>;
      try {
        features = JSON.parse(e.emotion_features!);
      } catch {
        return null;
      }
      let topEmotion = "";
      let topScore = 0;
      for (const emotion of PAIN_SIGNAL_EMOTIONS) {
        const score = features[emotion] ?? 0;
        if (score > topScore) {
          topScore = score;
          topEmotion = emotion;
        }
      }
      return topScore > 0.3 ? { text: e.message_text!, emotion: topEmotion, score: topScore } : null;
    })
    .filter((x): x is { text: string; emotion: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!scored.length) return "";
  return scored
    .map((s) => `Highest ${s.emotion.toLowerCase()} (${s.score.toFixed(2)}): "${s.text}"`)
    .join("\n");
}

function buildMessages(
  events: HumeChatEvent[],
): { role: "user" | "assistant"; content: string; timestamp: string }[] {
  return events
    .filter(
      (e) =>
        (e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE") &&
        e.message_text,
    )
    .map((e) => ({
      role: e.role === "USER" ? "user" : ("assistant" as const),
      content: e.message_text!,
      timestamp: e.timestamp
        ? new Date(e.timestamp).toISOString()
        : new Date().toISOString(),
    }));
}

// Turn-taking latency straight from Hume's own event timestamps (Part 2, item
// 6) — how long Co took to respond after each user turn, distinct from the
// coverage-tool round-trip latency we already time ourselves in
// handleToolCall below. Best-effort: if events are missing timestamps this
// just comes back empty rather than throwing — this is dashboard
// observability, never on the path that answers Hume.
function buildTurnLatencies(
  events: HumeChatEvent[],
): { turn: number; latency_ms: number }[] {
  const turns = events.filter(
    (e) =>
      (e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE") &&
      typeof e.timestamp === "number",
  );
  const out: { turn: number; latency_ms: number }[] = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role === "USER" && turns[i + 1].role !== "USER") {
      out.push({
        turn: out.length + 1,
        latency_ms: turns[i + 1].timestamp! - turns[i].timestamp!,
      });
    }
  }
  return out;
}

async function fetchHumeRecordingUrl(chatId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.hume.ai/v0/evi/chats/${chatId}/audio`,
      {
        headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY! },
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.status === "COMPLETE" ? (data.signed_audio_url ?? null) : null;
  } catch {
    return null;
  }
}

async function sendHumeToolResponse(
  chatId: string,
  toolCallId: string,
  content: string,
): Promise<void> {
  const res = await fetch(`https://api.hume.ai/v0/evi/chat/${chatId}/send`, {
    method: "POST",
    headers: {
      "X-Hume-Api-Key": process.env.HUME_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "tool_response",
      tool_call_id: toolCallId,
      content,
    }),
  });
  if (!res.ok) {
    console.error(
      `webhooks: tool response POST failed (${res.status}) for chat ${chatId}, tool ${toolCallId}`,
    );
  }
}

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Voice memo handling — this file previously had NONE at all: the inbound
// guard below only ever checked for text content, so a voice memo (empty
// content, a media_url) was silently dropped with a bare 200 before any of
// this ran. Confirmed for real: a voice memo Sendblue genuinely received
// and forwarded produced zero trace anywhere — no transcript, no fallback
// text, no error log — because the request never got past that guard.
// Mirrors api/src/routes/sendblue.ts's identical isAudioUrl/AUDIO_EXTENSIONS/
// transcribeVoiceMemo, duplicated rather than imported to match this file's
// existing "mirrors production" convention for the rest of the pipeline.
async function isAudioUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    const contentType = res.headers.get("content-type") ?? "";
    return contentType.startsWith("audio/");
  } catch {
    return false;
  }
}

// iMessage voice memos are real-world always audio/x-caf (Apple's Core
// Audio Format) — hardcoding a different type/extension makes ElevenLabs
// try to decode CAF bytes as the wrong format and fail every real memo.
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/x-caf": "caf",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

async function transcribeVoiceMemo(audioUrl: string): Promise<string> {
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(10000) });
  if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
  const contentType = audioRes.headers.get("content-type")?.split(";")[0].trim() ?? "audio/mp4";
  const extension = AUDIO_EXTENSIONS[contentType] ?? "m4a";
  const arrayBuffer = await audioRes.arrayBuffer();
  const file = new File([arrayBuffer], `voice_memo.${extension}`, { type: contentType });
  const result = await elevenlabs.speechToText.convert({ modelId: "scribe_v2", file });
  return (result as { text: string }).text ?? "";
}

// How long to hold off Co's free-form reply after an inbound message, in
// case the same person is mid-thought and about to send a follow-up.
// Matches api/src/routes/sendblue.ts's tuned value (started at 5s, bumped
// to 8s after checking a real conversation's actual gaps between related
// messages).
const DEBOUNCE_MS = 8000;

// Arrival-time table for the debounce above — same design as production's
// phone_debounce (migrations.ts, shared via the api/src/db import below),
// same reasoning: this must be stamped BEFORE withPhoneLock's queue, not
// inside run(), since once a phone's lock is held (in-memory here, not
// Postgres — see withPhoneLock below), a second inbound message for that
// phone can't run any code, including this stamp, until the first
// message's run() finishes. Stamping here decouples "record that a message
// arrived" from "wait in line to be processed," so a message queued behind
// the lock is still visible to the request currently waiting out its
// debounce window.
async function stampPhoneDebounce(phone: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `INSERT INTO phone_debounce (phone, last_inbound_at) VALUES ($1, NOW())
       ON CONFLICT (phone) DO UPDATE SET last_inbound_at = NOW()
       RETURNING last_inbound_at`,
      [phone],
    );
    return result.rows[0].last_inbound_at;
  } catch (err: any) {
    // Fail open — a UX nicety, not a correctness requirement.
    console.error("co-test webhooks: phone_debounce stamp failed (non-fatal, debounce skipped):", err?.message ?? err);
    return null;
  }
}

// Serializes /sendblue/webhook processing per phone number — same pattern
// production's sendblue.ts already uses (withPhoneLock), for the same
// reason: without it, a person re-sending the same message because the
// first reply feels slow gets each message processed fully independently
// and concurrently, since nothing makes the second one wait for the first
// to actually finish. Confirmed in a real conversation: the same message
// sent 3 times ~10s apart produced 3 full independent pipeline runs (3
// searches, 3 deliveries) instead of one.
const phoneLocks = new Map<string, Promise<unknown>>();

function withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const prior = phoneLocks.get(phone) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  phoneLocks.set(
    phone,
    result.catch(() => {}),
  );
  return result;
}

// 160 (and even the old 200 default) turned out too tight once replies
// started carrying real content (a venue name, a reason, a link) instead of
// pure small talk — real conversations showed it chopping mid-sentence and
// mid-word constantly. iMessage has no technical length limit like SMS
// segments do; this was always a style choice, not a real constraint, so
// it's loosened to something that fits an actual thought instead of
// fighting the model to cram everything into one SMS-segment-sized window.
const TEXT_MESSAGE_CHAR_CAP = 320;

// A prompt instruction like "1-2 sentences" was found to not actually be a
// length constraint — the model reliably satisfied it by sentence count
// while still packing 2-3 clauses/observations into those sentences,
// producing dense paragraph-length texts. This enforces real brevity
// regardless of what the model returns. Trims at the last natural boundary
// at or before the cap so a shortened reply still reads as a complete
// thought rather than being cut mid-word — sentence endings first, but also
// colons and dashes, since real replies (a venue name followed by a link)
// often break there rather than at a period; falls back to a word boundary
// + ellipsis only if none of those are found early enough to be useful.
function findNaturalBoundary(window: string): number {
  return Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf(": "),
    window.lastIndexOf(" — "),
    window.lastIndexOf(" - "),
  );
}

export function capMessageLength(
  text: string,
  maxChars = TEXT_MESSAGE_CHAR_CAP,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const window = trimmed.slice(0, maxChars);
  const lastBoundary = findNaturalBoundary(window);
  if (lastBoundary > maxChars * 0.4)
    return window.slice(0, lastBoundary + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  return `${window.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}…`;
}

// Schedules the post-call reflection text instead of sending it immediately
// — landing the second the call ends read as a scripted status update, not
// something a person who was actually listening would send. send_at is
// randomized 2h-2d out; postCallFollowUpJob.ts polls for due rows and
// generates + sends the actual message at send time (not now), so it's a
// fresh LLM call per send and can never be the same script twice. Failure
// here is deliberately swallowed — it must never affect call_status/
// retryability, since the recap (the actual result) is already persisted by
// the time this runs.
async function scheduleFollowUpText(
  userId: string,
  transcript: string,
): Promise<void> {
  try {
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const delayMs = TWO_HOURS_MS + Math.random() * (TWO_DAYS_MS - TWO_HOURS_MS);
    await pool.query(
      `INSERT INTO post_call_follow_ups (user_id, transcript, send_at) VALUES ($1, $2, NOW() + $3 * INTERVAL '1 millisecond')`,
      [userId, transcript, delayMs],
    );
  } catch (scheduleErr: any) {
    console.error(
      "Post-call follow-up scheduling failed (non-fatal):",
      scheduleErr?.message ?? scheduleErr,
    );
  }
}

// Pushes any transcript lines not yet live-pushed for this user, given an
// already-fetched events array — pure, no network call, so both the
// periodic poller and handleToolCall/chat_ended (which already have events
// in hand) can call it without double-fetching Hume. Always called before
// any coverage-check event for the same tool_call, so a coverage result can
// never render ahead of the transcript line that triggered it (requirement 6).
function emitNewTranscriptLines(
  io: Server,
  userId: string,
  events: HumeChatEvent[],
): void {
  const messages = buildMessages(events);
  const alreadySeen = getTranscriptLinesSeen(userId);
  if (messages.length <= alreadySeen) return;
  for (const message of messages.slice(alreadySeen)) {
    pushLiveEvent(io, userId, { type: "transcript", message });
  }
  setTranscriptLinesSeen(userId, messages.length);
}

async function pollAndEmitTranscript(
  io: Server,
  userId: string,
  chatId: string,
): Promise<void> {
  try {
    const events = await fetchHumeChatEvents(chatId);
    emitNewTranscriptLines(io, userId, events);
  } catch (err: any) {
    console.error(
      `webhooks: live transcript poll failed for chat ${chatId} (non-fatal):`,
      err?.message ?? err,
    );
  }
}

// Answers a tool_call over the Control Plane, and (Part 1, item 4) marks the
// round-trip smoke-test timestamps on the user's row regardless of which
// tool fired — assess_conversation_coverage is reused as the smoke vehicle
// (see task notes: it's already attached to the dev config with its own
// Hume-side fallback_content, so this proves the exact tool_call ->
// Control-Plane-response mechanism a coverage check will use, without adding
// a new tool to the shared dev Hume config).
async function handleToolCall(
  io: Server,
  chatId: string,
  userId: string | null,
  toolCallMessage: { tool_call_id: string; name: string } | undefined,
): Promise<void> {
  if (!toolCallMessage) return;

  if (toolCallMessage.name === "surface_recommendation") {
    try {
      const result = userId
        ? await generateRecommendation(userId)
        : {
            available: false as const,
            reason: "no user resolved for this call",
          };
      await sendHumeToolResponse(
        chatId,
        toolCallMessage.tool_call_id,
        JSON.stringify(result),
      );
    } catch (err: any) {
      console.error(
        "webhooks: surface_recommendation failed:",
        err?.message ?? err,
      );
      await sendHumeToolResponse(
        chatId,
        toolCallMessage.tool_call_id,
        JSON.stringify({ available: false, reason: "lookup failed" }),
      ).catch(() => {});
    }
    return;
  }

  if (toolCallMessage.name !== "assess_conversation_coverage") return;

  if (userId) {
    pool
      .query(`UPDATE users SET smoke_test_tool_call_at = NOW() WHERE id = $1`, [
        userId,
      ])
      .catch((err) =>
        console.error(
          "smoke_test_tool_call_at update failed (non-fatal):",
          err,
        ),
      );
  }

  try {
    const events = await fetchHumeChatEvents(chatId);
    // Flush any transcript lines that led up to this tool call FIRST, so the
    // browser never sees the coverage result before the lines that caused it.
    if (userId) emitNewTranscriptLines(io, userId, events);

    const transcript = buildTranscript(events);
    // Lets an already-known fact (from a prior call or text) count as
    // covered so Co doesn't re-ask something it genuinely already knows —
    // see assessConversationCoverage's priorContext param.
    const priorContext = userId
      ? await buildContextSummary(userId).catch(() => "")
      : "";
    const start = Date.now();
    const assessment = await assessConversationCoverage(
      transcript,
      priorContext,
    );
    // Persists to co_profiles.topics_covered — the same store the text
    // channel's coverage nudge and the Stage 5 check-in cron read, so a
    // topic confirmed on a call is remembered there too. This was computed
    // and sent back to Hume already (right below) without ever being
    // persisted — confirmed missing after a real call correctly asked
    // through Rapport-phase topics but left topics_covered empty in the DB.
    if (userId) persistCoveredTopics(userId, assessment);
    const latency_ms = Date.now() - start;
    // elapsed_minutes rides along on the same tool result the prompt already
    // polls periodically, rather than a separate tool — Co has no other way
    // to know how long a call has actually run (see the prompt's "start
    // wrapping up around 15 minutes" instruction), and Hume's own
    // max_duration timeout otherwise cuts her off silently mid-sentence
    // with no chance to close gracefully.
    const elapsedMinutes = userId ? getElapsedMinutes(userId) : null;
    await sendHumeToolResponse(
      chatId,
      toolCallMessage.tool_call_id,
      JSON.stringify({
        ...assessment,
        ...(elapsedMinutes !== null ? { elapsed_minutes: Math.round(elapsedMinutes * 10) / 10 } : {}),
      }),
    );

    if (userId) {
      pool
        .query(
          `UPDATE users SET smoke_test_tool_response_at = NOW() WHERE id = $1`,
          [userId],
        )
        .catch((err) =>
          console.error(
            "smoke_test_tool_response_at update failed (non-fatal):",
            err,
          ),
        );
    }

    const covered_topics = RAPPORT_TOPICS.filter(
      (t) => !assessment.missing_topics.includes(t),
    );
    if (userId) {
      const priorChecks = getLiveSnapshot(userId).events.filter(
        (e) => e.type === "coverage",
      ).length;
      pushLiveEvent(io, userId, {
        type: "coverage",
        check: {
          call_number: priorChecks + 1,
          timestamp: new Date().toISOString(),
          missing_topics: assessment.missing_topics,
          covered_topics,
          ready_to_summarize: assessment.ready_to_summarize,
          latency_ms,
        },
      });
    }
  } catch (err: any) {
    console.error(
      "webhooks: assess_conversation_coverage failed, falling back to nothing-covered:",
      err?.message ?? err,
    );
    await sendHumeToolResponse(
      chatId,
      toolCallMessage.tool_call_id,
      JSON.stringify({
        missing_topics: [...RAPPORT_TOPICS],
        ready_to_summarize: false,
      }),
    ).catch(() => {});
  }
}

// Reject status callbacks that didn't come from Twilio — same check
// production's validateTwilioSignature (api/src/routes/co.ts) performs.
// Without it, anyone could POST arbitrary CallStatus/To/CallSid values and
// corrupt call_status for a guessed/observed call_sid.
//
// One Twilio account (TWILIO_LIVE_SID is its real Account SID;
// TWILIO_ACCOUNT_SID is a same-account API Key SID, not a second account) —
// TWILIO_AUTH just needs to hold that account's current Auth Token. Confirmed
// live: it previously held a stale value (401'd against Twilio's own API),
// now holds the verified-current one (200'd the same check).
function validateTwilioSignature(req: Request, path: string): boolean {
  const sig = req.headers["x-twilio-signature"] as string | undefined;
  if (!sig) return false;
  const url = `${process.env.API_URL}${path}`;
  return twilio.validateRequest(process.env.TWILIO_AUTH!, sig, url, req.body);
}

// Reject webhook calls that didn't come from Hume — same check production's
// validateHumeWebhook (api/src/routes/co.ts) performs, reusing the same
// bearer secret. Without it, this route resolved the acting user from a
// client-suppliable custom_session_id with no cross-check against who
// actually holds the chat_id, so anyone who started their own real call
// through co-test's public /call page could forge a chat_ended event
// pointing at a different tester's user_id and overwrite that tester's
// profile/recap with the attacker's own transcript.
// Hume signs each webhook with a dedicated webhook signing key (separate
// from the API key, generated on Hume's Developers page) — HMAC-SHA256 over
// the exact string "${rawBody}.${timestamp}", hex-encoded, sent as
// X-Hume-AI-Webhook-Signature, with the timestamp itself sent as
// X-Hume-AI-Webhook-Timestamp (rejected if older than 180s, to block
// replay). Confirmed against Hume's own docs — the previous version checked
// a different header entirely and compared it directly against the secret,
// which could never match anything Hume actually sends, which is why this
// was disabled instead of just left broken. Requires req.body to be the raw
// Buffer for this route (see server.ts's express.raw() on /co/webhook).
function validateHumeWebhook(req: Request): boolean {
  // Real webhook signing key generated on Hume's Developers page — set in
  // Railway as HUME_SIGNIN_KEY (not HUME_WEBHOOK_SECRET, an older placeholder
  // value that was never actually a real Hume-issued key, which is why this
  // 401'd every real delivery even after the algorithm itself was fixed).
  const secret = process.env.HUME_SIGNIN_KEY;
  if (!secret) return true; // skip when not configured (dev) — matches production's fallback

  // Diagnostic logging (2026-08-13) — real deliveries started 401ing after
  // this was re-enabled; never logs the secret or the actual signature
  // values, just enough to tell which specific check is failing.
  const signature = req.headers["x-hume-ai-webhook-signature"] as
    | string
    | undefined;
  const timestamp = req.headers["x-hume-ai-webhook-timestamp"] as
    | string
    | undefined;
  if (!signature || !timestamp) {
    console.error(
      `validateHumeWebhook: missing header(s) — signature present: ${!!signature}, timestamp present: ${!!timestamp}, all headers: ${JSON.stringify(Object.keys(req.headers))}`,
    );
    return false;
  }

  const timestampMs = Number(timestamp) * 1000;
  const deltaMs = Date.now() - timestampMs;
  if (!Number.isFinite(timestampMs) || Math.abs(deltaMs) > 180_000) {
    console.error(
      `validateHumeWebhook: timestamp check failed — raw timestamp: "${timestamp}", parsed ms: ${timestampMs}, delta from now: ${deltaMs}ms`,
    );
    return false;
  }

  const rawBody = (req.body as Buffer).toString("utf-8");
  const expected = createHmac("sha256", secret)
    .update(`${rawBody}.${timestamp}`)
    .digest("hex");

  let matched = false;
  try {
    matched = timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (err: any) {
    console.error(
      `validateHumeWebhook: signature comparison threw (likely length mismatch) — received length: ${signature.length}, expected length: ${expected.length}, error: ${err?.message ?? err}`,
    );
    return false;
  }
  if (!matched) {
    console.error(
      `validateHumeWebhook: signature mismatch — content-type: ${req.headers["content-type"]}, body is Buffer: ${Buffer.isBuffer(req.body)}, body length: ${rawBody.length}, body starts with: ${JSON.stringify(rawBody.slice(0, 40))}`,
    );
  }
  return matched;
}

export function createWebhooksRouter(io: Server): express.Router {
  const router = express.Router();

  // POST /co/incoming-call — Twilio's inbound Voice webhook for
  // TWILIO_PHONE_NUMBER. Ported from feature/prod-inbound-calls (PR #45, not
  // yet merged to main) so this can be tested on co-test first. Same shared
  // Twilio number as prod — inbound calls previously went straight to
  // Hume's old native Twilio integration, bypassing our app entirely (no
  // first_name/context_summary, no reliable custom_session_id). Generates
  // the same <Connect><Stream> TwiML callTrigger.ts uses for outbound calls,
  // into the same mediaStreamBridge.ts. Only a recognized caller (phone
  // number matches a user) reaches that bridge at all — an unrecognized
  // number is turned away here, before any stream connects, rather than
  // being bridged into Hume with no identity (mediaStreamBridge.ts requires
  // user_id and closes without it).
  router.post(
    "/co/incoming-call",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!validateTwilioSignature(req, "/co/incoming-call")) {
          return res.status(401).send("Invalid Twilio signature.");
        }

        const from = req.body.From as string | undefined;
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

        const mediaStreamUrl = `${process.env.API_URL!.replace(/^http/, "ws")}/media-stream`;
        const stream = twiml.connect().stream({ url: mediaStreamUrl });
        stream.parameter({ name: "user_id", value: userId });

        res.type("text/xml").send(twiml.toString());
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /co/call-status — Twilio status callback for the real-call trigger in
  // phone.ts. Also receives the async AMD (answering-machine-detection)
  // result — see the AnsweredBy branch below — ported from production's
  // version (api/src/routes/co.ts) after confirming live that without it, a
  // voicemail pickup went straight into Hume's normal live conversation
  // instead of a deliberate voicemail line, since nothing ever told Hume it
  // was talking to a machine.
  router.post(
    "/co/call-status",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Re-enabled 2026-08-13 — TWILIO_AUTH previously held a stale/wrong Auth
        // Token, confirmed directly against Twilio's API (Basic Auth against
        // /Accounts/{TWILIO_LIVE_SID}.json returned 401). Now holds the current,
        // verified-correct token (confirmed 200 against the same check).
        if (!validateTwilioSignature(req, "/co/call-status")) {
          return res.status(401).send("Invalid Twilio signature.");
        }

        const { CallStatus, To, CallSid, AnsweredBy } = req.body;

        // Async AMD result arrives as its own, differently-shaped callback —
        // only MachineDetectionDuration/CallSid/AnsweredBy/AccountSid, no
        // CallStatus or To at all. Must be handled before the CallStatus/To
        // guard below, which would otherwise silently discard it — same
        // failure mode production's version documents hitting for real.
        if (typeof AnsweredBy === "string") {
          if (!AnsweredBy.startsWith("machine")) {
            // human/fax/unknown — the live Hume conversation is already
            // proceeding correctly, nothing to do here.
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
              console.error(
                `Failed to fetch call ${CallSid} for AMD user lookup:`,
                fetchErr?.message ?? fetchErr,
              );
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
            io.to(`user:${user.id}`).emit("co:call_completed", {
              call_sid: CallSid,
              status: "voicemail",
            });
          }
          // A fixed voicemail line every time reads as a canned system
          // message. Vary it (Haiku, one short line, hard fallback) — this
          // is said directly into the call's TwiML while it's still live,
          // so generation must never meaningfully delay the redirect.
          let voicemailLine = user
            ? `Hey ${user.first_name}, it's Co. Sorry I missed you — I'll try you again soon.`
            : `Hey, it's Co. Sorry I missed you — I'll try you again soon.`;
          try {
            const { text: variedLine } = await generateText({
              model: anthropic("claude-haiku-4-5-20251001"),
              experimental_telemetry: { isEnabled: true, functionId: "co-test.webhooks.voicemailLine" },
              prompt: `You are Co, an exclusive life concierge. You just called ${user ? user.first_name : "someone"} and reached their voicemail. Leave a short, natural one-line voicemail greeting letting them know you'll try again soon — vary how you say it, don't just repeat "Sorry I missed you." Tone: calm, unhurried, like a private members club. No exclamation points, no em dashes. Under 140 characters.`,
            });
            const trimmed = variedLine.trim();
            if (trimmed) voicemailLine = trimmed.length > 160 ? trimmed.slice(0, 159) + "…" : trimmed;
          } catch (genErr: any) {
            console.error("Voicemail-line generation failed (non-fatal, using default):", genErr?.message ?? genErr);
          }

          // Confirmed live: a real person answered and Twilio's AMD misfired
          // anyway — this redirect still fires regardless, so whoever's on
          // the line hears whatever voice this TwiML uses. Twilio's built-in
          // <Say> voices are a different voice engine entirely from Co's
          // real Hume voice; a real caller hearing Co's actual voice cut off
          // mid-call and replaced by an unrelated one reads as a hard
          // glitch, not just a wrong-branch redirect. generateHumeVoiceLine
          // synthesizes this line with Co's own attached voice (HUME_VOICE_ID)
          // via Hume's standalone TTS endpoint, so an AMD false positive is
          // at least not also a jarring voice swap. Falls back to Twilio's
          // own <Say> only if that synthesis call itself fails.
          const voiceResponse = new twilio.twiml.VoiceResponse();
          try {
            const audioUrl = await generateHumeVoiceLine(voicemailLine);
            voiceResponse.play(audioUrl);
          } catch (ttsErr: any) {
            console.error("Hume voicemail-line TTS failed, falling back to Twilio Say (non-fatal):", ttsErr?.message ?? ttsErr);
            voiceResponse.say({ voice: "Polly.Joanna-Neural" }, voicemailLine);
          }
          voiceResponse.hangup();
          try {
            await twilioClient
              .calls(CallSid)
              .update({ twiml: voiceResponse.toString() });
          } catch (redirectErr: any) {
            console.error(
              "Failed to redirect call to voicemail TwiML (non-fatal):",
              redirectErr?.message ?? redirectErr,
            );
          }
          // Flag this call so the Hume chat_ended webhook (which still fires
          // normally since we hang up cleanly, not abruptly) skips the full
          // extraction pipeline below — a one-line Hume monologue to a machine
          // isn't a real conversation worth extracting a profile from.
          await pool.query(
            `INSERT INTO voicemail_calls (call_sid) VALUES ($1) ON CONFLICT DO NOTHING`,
            [CallSid],
          );
          // Previously unrecoverable — generated fresh every call but never
          // written down anywhere, so there was no way to review what Co
          // actually said on a real person's voicemail after the fact.
          if (user) {
            await pool
              .query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)`,
                [user.id, `Co left this voicemail: "${voicemailLine}"`],
              )
              .catch((err: any) =>
                console.error("Voicemail-line logging failed (non-fatal):", err?.message ?? err),
              );
          }
          return res.sendStatus(204);
        }

        if (!CallStatus || !To) return res.sendStatus(204);

        // 'processing'/'completed'/'failed' are the chat_ended handler's own
        // terminal states below (its idempotency claim reads call_status to
        // decide whether extraction already ran) — Twilio's "completed" is a
        // DIFFERENT event (the call itself hung up) that fires independently
        // of and usually right around the same time as Hume's chat_ended.
        // Forwarding it here let it land first and get misread as "extraction
        // already finished," silently skipping the real pipeline (confirmed
        // live: call_status='completed' with zero co_memories/co_profiles
        // rows for the call). Only forward the early, Twilio-owned states;
        // chat_ended is the sole writer of the terminal ones.
        if (CallStatus !== "completed") {
          await pool.query(
            `UPDATE users SET call_status = $2 WHERE phone_number = $1 AND call_sid = $3`,
            [To, CallStatus, CallSid],
          );
        }
        return res.sendStatus(204);
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /co/webhook — Hume calls this for chat_started/chat_ended/tool_call,
  // same three events production's config registers. Only reachable for
  // co-test's OWN chats once the dev Hume config's webhook is repointed here
  // (see server.ts / the one-time repoint noted in phone.ts task notes) —
  // production's separate Hume config and its webhook are never touched.
  router.post(
    "/co/webhook",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Re-enabled 2026-08-13 — validateHumeWebhook previously checked the
        // wrong header entirely (see its own comment); now implements Hume's
        // actual HMAC scheme, confirmed against their docs.
        if (!validateHumeWebhook(req)) {
          return res.status(401).send("Unauthorized.");
        }

        // req.body is the raw Buffer here (see server.ts's express.raw() on
        // this path, needed for signature verification above) — parse it now
        // that verification is done. Kept as its own variable (not reassigned
        // onto req.body) so the "could not resolve user" log below still shows
        // something readable rather than JSON.stringify-ing a Buffer.
        const parsedBody = JSON.parse((req.body as Buffer).toString("utf-8"));
        const {
          event_name,
          custom_session_id,
          chat_id,
          twilio_metadata,
          tool_call_message,
        } = parsedBody;

        const resolveUserId = async (): Promise<string | null> => {
          if (custom_session_id) return custom_session_id;
          if (twilio_metadata?.to_number) {
            const byPhone = await pool.query(
              `SELECT id FROM users WHERE phone_number = $1`,
              [twilio_metadata.to_number],
            );
            return byPhone.rows[0]?.id ?? null;
          }
          return null;
        };

        if (event_name === "chat_started") {
          res.status(200).send({ success: true });
          const userId = await resolveUserId();
          if (userId) {
            // Live-push layer only — persistence of the final transcript/
            // extraction at chat_ended (below) is unconditional and does not
            // depend on this, or on any browser being connected (requirement 4).
            startLiveCall(userId);
            startPolling(userId, () => {
              pollAndEmitTranscript(io, userId, chat_id).catch((err) =>
                console.error(
                  "webhooks: transcript poll error (non-fatal):",
                  err?.message ?? err,
                ),
              );
            });
          }
          return;
        }

        if (event_name === "tool_call") {
          res.status(200).send({ success: true });
          const userId = await resolveUserId();
          handleToolCall(io, chat_id, userId, tool_call_message).catch((err) =>
            console.error(
              "webhooks: unhandled tool_call error:",
              err?.message ?? err,
            ),
          );
          return;
        }

        if (event_name !== "chat_ended") {
          return res.status(200).send({ success: true, ignored: event_name });
        }

        const user_id = await resolveUserId();
        if (!user_id || !chat_id) {
          console.error(
            `webhooks: could not resolve user for chat ${chat_id} — body: ${JSON.stringify(parsedBody)}`,
          );
          return res.status(400).send("Missing required fields.");
        }

        // The AMD callback above already flagged this call as an answering
        // machine/voicemail and left its own deliberate line — skip the full
        // extraction pipeline below so a one-line Hume monologue to a machine
        // doesn't get treated as a real conversation worth building a profile from.
        //
        // twilio_metadata only ever gets populated by Hume when the chat came
        // in through Hume's OWN /v0/evi/twilio integration — since we now hold
        // the Twilio leg ourselves and open Hume via a plain chat.connect()
        // (see mediaStreamBridge.ts), Hume has no idea Twilio is involved at
        // all, so this field is never present anymore and the check below was
        // silently dead (confirmed: no other code path sets it either). users.call_sid
        // (stamped by callTrigger.ts when the call is placed) is the real
        // source of truth for this call's SID now; twilio_metadata is kept as
        // a fallback in case that ever changes back.
        let voicemailCallSid: string | null = twilio_metadata?.call_sid ?? null;
        if (!voicemailCallSid) {
          const callSidResult = await pool.query(
            `SELECT call_sid FROM users WHERE id = $1`,
            [user_id],
          );
          voicemailCallSid = callSidResult.rows[0]?.call_sid ?? null;
        }
        if (voicemailCallSid) {
          const flagged = await pool.query(
            `SELECT 1 FROM voicemail_calls WHERE call_sid = $1`,
            [voicemailCallSid],
          );
          if (flagged.rows.length > 0) {
            console.log(
              `webhooks: skipping extraction for voicemail call ${voicemailCallSid}`,
            );
            return res
              .status(200)
              .send({ success: true, skipped: "voicemail" });
          }
        }

        // Idempotency guard — Hume (or something in the Twilio-bridged path
        // specifically) has been observed delivering chat_ended more than once
        // for the same real call, moments apart. Without this, the full
        // extraction pipeline re-ran from scratch each time (non-deterministic
        // re-extraction, since it's an LLM call on the same transcript) and
        // sent a fresh, differently-worded follow-up text every time —
        // confirmed directly: three near-identical call_transcript/intent/recap
        // triples 15-20 seconds apart for one real call. Atomic claim: only the
        // delivery that actually flips call_status to 'processing' gets rows
        // back and proceeds; every later delivery for the same call sees it
        // already 'processing'/'completed' and is a no-op ack.
        //
        // Claiming 'processing' here — not 'completed' directly — matters: the
        // extraction pipeline below (Hume fetch, transcript build, two LLM
        // calls, recap insert) can fail partway through, and 'completed' must
        // only ever mean "the recap actually exists." Confirmed for real: a
        // pipeline failure previously left call_status='completed' with no
        // recap ever written, permanently wedging the call — every later
        // delivery (including a legitimate retry) saw 'completed' and no-op'd
        // forever, with no way to recover except manually resetting the row.
        // On failure below, call_status resets to 'failed' so the next
        // delivery (or a manual replay) can claim and retry it.
        //
        // Second clause covers the one failure mode a try/catch can't:
        // the server process dying mid-pipeline (crash/restart), which never
        // reaches the catch block to reset to 'failed' at all — the row would
        // otherwise sit in 'processing' forever, unreclaimable, same dead end
        // as the original bug. A row stuck in 'processing' for longer than any
        // real extraction takes (normally well under a minute) is reclaimable.
        // updated_at is set explicitly here rather than relied on from a
        // trigger, since none exists on this table.
        const claimResult = await pool.query(
          `UPDATE users SET call_status = 'processing', updated_at = NOW()
         WHERE id = $1
           AND (
             call_status NOT IN ('processing', 'completed')
             OR (call_status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
           )
         RETURNING id`,
          [user_id],
        );
        if (!claimResult.rows[0]) {
          console.log(
            `webhooks: chat_ended already processed for user ${user_id} (chat ${chat_id}) — ignoring duplicate delivery`,
          );
          return res.status(200).send({ success: true, duplicate: true });
        }

        try {
          const [events, recording_url] = await Promise.all([
            fetchHumeChatEvents(chat_id),
            fetchHumeRecordingUrl(chat_id),
          ]);
          const transcript = buildTranscript(events);
          const messages = buildMessages(events);
          const turn_latency_ms = buildTurnLatencies(events);

          // Flush any last transcript lines live, then hand off — the coverage
          // history for the recap below comes from the same live event log
          // (not re-derived), so what a connected browser saw live and what the
          // static results page shows afterward are exactly the same data.
          emitNewTranscriptLines(io, user_id, events);
          const coverage_history = getLiveSnapshot(user_id)
            .events.filter((e) => e.type === "coverage")
            .map((e) => (e as Extract<typeof e, { type: "coverage" }>).check);
          pushLiveEvent(io, user_id, { type: "call_ended" });
          endLiveCall(user_id);

          if (!transcript.trim()) {
            console.error(
              `webhooks: empty transcript for chat ${chat_id} (user ${user_id})`,
            );
            // Not a hard failure, but there's no recap to show either — reset
            // so a later delivery with a fully-synced transcript can retry,
            // same as the catch block below.
            await pool.query(
              `UPDATE users SET call_status = 'failed' WHERE id = $1`,
              [user_id],
            );
            return res.status(200).send({ success: true, empty: true });
          }

          await storeTranscriptMemory(user_id, transcript, {
            audioUrl: recording_url,
          });
          const emotionalHighlights = extractEmotionalHighlights(events);
          const { raw, extracted } =
            await extractPsychographicProfile(transcript, emotionalHighlights);
          await storeProfile(user_id, extracted, transcript);
          const intent = await captureIntent(user_id, transcript);

          const data = {
            profile: extracted,
            intent,
            raw_model_output: raw,
            transcript,
            messages,
            coverage_history,
            turn_latency_ms,
            channel: "phone",
          };
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recap', $2)`,
            [user_id, JSON.stringify(data)],
          );

          // The recap exists now — safe to mark completed. Everything after
          // this point (the follow-up text) is best-effort and must not affect
          // retryability; it already has its own non-fatal try/catch below.
          await pool.query(
            `UPDATE users SET call_status = 'completed' WHERE id = $1`,
            [user_id],
          );

          await scheduleFollowUpText(user_id, transcript);
          return res.status(200).send({ success: true });
        } catch (pipelineErr) {
          await pool.query(
            `UPDATE users SET call_status = 'failed' WHERE id = $1`,
            [user_id],
          );
          throw pipelineErr;
        }
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /sendblue/webhook — real text-in-first + OTP flow (Part 1, item 2),
  // mirroring the contact_verified gate in api/src/routes/sendblue.ts. Voice
  // memos now transcribe (see isAudioUrl/transcribeVoiceMemo above) — this
  // used to be text-only by deliberate scope, but a real voice memo was
  // confirmed silently dropped with zero trace, which is worse than not
  // supporting it at all. Image vision and moment/circle response handling
  // are still out of scope (co-test has neither).
  router.post(
    "/sendblue/webhook",
    async (req: Request, res: Response, next: NextFunction) => {
      const { number, is_outbound, type, media_url } = req.body;
      let content = req.body.content;
      if (type === "typing" || is_outbound)
        return res.status(200).send({ received: true });

      const hasText = typeof content === "string" && content.trim().length > 0;
      const hasMedia = typeof media_url === "string" && media_url.length > 0;
      if (!number || (!hasText && !hasMedia)) return res.status(200).send({ received: true });

      // A malformed inbound `number` (confirmed: Sendblue can deliver one,
      // e.g. a bare 5-digit value) was flowing straight through to a real,
      // billed sendSMS call via the session-claim branch below — nothing on
      // this path validated shape before either claiming a session or
      // sending. Reject before either happens.
      if (!parsePhoneNumberFromString(number, "US")?.isValid()) {
        console.error(
          `co-test sendblue webhook: malformed inbound number "${number}" — ignoring`,
        );
        return res.status(200).send({ received: true });
      }

      // Stamped before withPhoneLock — see stampPhoneDebounce's comment for
      // why. Only for a message that will actually reach the free-form
      // reply path; genuinely empty/malformed ones already returned above.
      const myInboundAt = await stampPhoneDebounce(number);

      if (!hasText && hasMedia) {
        if (await isAudioUrl(media_url)) {
          try {
            content = await transcribeVoiceMemo(media_url);
            console.log(`co-test sendblue webhook: transcribed voice memo from ${number}: "${content}"`);
          } catch (transcribeErr: any) {
            console.error("co-test sendblue webhook: voice memo transcription failed:", transcribeErr?.message ?? transcribeErr);
            content = "[voice memo]";
          }
        } else {
          content = "[sent a photo]";
        }
      }

      const run = async () => {
        try {
          // The tester's row already exists by the time they can text in — login
          // (testerAuth.ts) creates it, keyed on this same real phone number,
          // before /phone is even reachable (see phone.ts's /session route,
          // which reuses that same login row rather than creating a separate
          // one).
          const userResult = await pool.query(
            `SELECT id, first_name, email, contact_verified, identity_captured, intake_asked, sms_opted_out FROM users WHERE phone_number = $1 AND test_channel = 'phone'`,
            [number],
          );
          let user = userResult.rows[0];

          if (!user) {
            console.log(
              `co-test sendblue webhook: no phone-test session for ${number} — ignoring`,
            );
            return res.status(200).send({ received: true });
          }

          // STOP/START handling — previously nothing honored this at all, so
          // a user who texted STOP just got a normal Co reply and kept
          // receiving texts and calls. Checked before anything else (intake,
          // duplicate guard, real reply) so it works regardless of account
          // state, and short-circuits everything below for an opted-out user
          // except START/UNSTOP itself.
          if (isOptOutKeyword(content)) {
            await pool.query(`UPDATE users SET sms_opted_out = true WHERE id = $1`, [user.id]);
            try {
              await sendblue.messages.send({
                number,
                content: "You've been unsubscribed and won't receive further messages or calls from Co. Text START to resubscribe.",
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (err: any) {
              console.error("co-test sendblue webhook: opt-out confirmation send failed (non-fatal):", err?.message ?? err);
            }
            return res.status(200).send({ received: true, action: "opted_out" });
          }
          if (isOptInKeyword(content)) {
            await pool.query(`UPDATE users SET sms_opted_out = false WHERE id = $1`, [user.id]);
            try {
              await sendblue.messages.send({
                number,
                content: "You're resubscribed — welcome back.",
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (err: any) {
              console.error("co-test sendblue webhook: opt-in confirmation send failed (non-fatal):", err?.message ?? err);
            }
            return res.status(200).send({ received: true, action: "opted_in" });
          }
          if (user.sms_opted_out) {
            return res.status(200).send({ received: true, action: "opted_out_ignored" });
          }

          // Duplicate-message guard — reliable now that processing is
          // serialized above (withPhoneLock), so by the time this runs, a truly
          // prior identical message has either already fully completed or isn't
          // running concurrently with this one anymore. Confirmed in a real
          // conversation: the same exact message sent 3 times within ~20s
          // (impatient re-sends while the first was still processing) produced
          // 3 full independent searches and deliveries. If this exact content
          // was already recorded as sent by this user in the last minute,
          // treat it as a re-send of something already answered, not a new ask.
          const recentDuplicateResult = await pool.query(
            `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content = $2 AND created_at > NOW() - INTERVAL '60 seconds' LIMIT 1`,
            [user.id, `User said: ${content}`],
          );
          if (recentDuplicateResult.rows[0]) {
            console.log(
              `co-test sendblue webhook: duplicate message from user ${user.id} within 60s, skipping reprocessing`,
            );
            return res.status(200).send({ received: true, duplicate: true });
          }

          // Name/email intake — mirrors the identity_captured gate in
          // api/src/routes/sendblue.ts. Texting in from a real phone is
          // proof enough of ownership on its own (matches production), so
          // there's no separate OTP step here anymore either — dropped along
          // with production's, not a co-test-only simplification.
          if (!user.identity_captured) {
            if (!user.intake_asked) {
              await pool.query(`UPDATE users SET intake_asked = true WHERE id = $1`, [user.id]);
              // Paced, not fired all at once — back-to-back sends with no gap
              // arrive as a stacked wall of texts on the recipient's end even
              // though each individual message is legitimate content.
              await sendSMS({ phone_number: number, welcome: true, first_name: user.first_name });
              await pause(2500);
              await sendSMS({ phone_number: number, intro: true });
              await pause(2500);
              await sendSMS({ phone_number: number, save_contact: true });
              await pause(2500);
              await sendSMS({ phone_number: number, intake_ask: true });
              if (hasText) {
                await pool.query(
                  `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
                  [user.id, `User said: ${content}`],
                );
              }
              return res.status(200).send({ received: true, action: "intake_started" });
            }

            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
              [user.id, hasText ? `User said: ${content}` : "User sent a photo or voice memo (name/email intake)"],
            );

            const { text: rawExtraction } = await generateText({
              model: anthropic("claude-haiku-4-5-20251001"),
              experimental_telemetry: { isEnabled: true, functionId: "co-test.webhooks.intake.extractIdentity" },
              prompt: `Co asked a new contact for their full name and email. Extract both from their reply, combining with anything already known.

Already known — name: ${user.first_name || "not yet given"}, email: ${hasPendingEmail(user.email) ? "not yet given" : user.email}

Their reply: "${content}"

Return ONLY strict JSON: {"full_name": string or null, "email": string or null, "is_acknowledgment": boolean}. Only set full_name/email when you're actually confident — carry forward an already-known value if this reply doesn't repeat it, and don't guess at one that's still missing. Set is_acknowledgment true when the reply is just a social acknowledgment of Co's welcome (e.g. "thanks", "ok", "sounds good") with no attempt to give a name or email — false otherwise, including when they did attempt an answer that just didn't parse.`,
            });

            let extracted: { full_name: string | null; email: string | null; is_acknowledgment?: boolean };
            try {
              extracted = JSON.parse(rawExtraction.trim().replace(/^```(?:json)?\n?|\n?```$/g, ""));
            } catch {
              extracted = { full_name: null, email: null };
            }

            const emailValid = !!extracted.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extracted.email);
            const finalName = extracted.full_name?.trim() || user.first_name || null;
            const finalEmail = emailValid ? extracted.email!.trim() : hasPendingEmail(user.email) ? null : user.email;

            if (finalName && finalEmail) {
              const { first_name, last_name } = splitFullName(finalName);
              try {
                const updated = await pool.query(
                  `UPDATE users SET first_name = $2, last_name = $3, email = $4, username = $5, identity_captured = true
                   WHERE id = $1 RETURNING id, first_name, email, contact_verified, identity_captured, intake_asked`,
                  [user.id, first_name, last_name, finalEmail, finalEmail.split("@")[0]],
                );
                user = updated.rows[0];
              } catch (err: any) {
                if (err?.code === "23505") {
                  const conflictMsg = "Looks like that email's already on file. Mind sending a different one?";
                  try {
                    await sendblue.messages.send({
                      number,
                      content: conflictMsg,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (smsErr: any) {
                    console.error("co-test intake email-conflict send failed (non-fatal):", smsErr?.message ?? smsErr);
                  }
                  await pool.query(
                    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
                    [user.id, `Co replied: ${conflictMsg}`],
                  );
                  return res.status(200).send({ received: true, action: "intake_email_conflict" });
                }
                throw err;
              }
              await pause(2000);
              const kickoffMsg = `Good to meet you, ${first_name}. What's been on your mind lately?`;
              try {
                await sendblue.messages.send({
                  number,
                  content: kickoffMsg,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (smsErr: any) {
                console.error("co-test intake kickoff send failed (non-fatal):", smsErr?.message ?? smsErr);
              }
              await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
                [user.id, `Co replied: ${kickoffMsg}`],
              );
              return res.status(200).send({ received: true, action: "identity_captured" });
            }

            if (finalName && finalName !== user.first_name) {
              const { first_name, last_name } = splitFullName(finalName);
              await pool.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = $1`, [
                user.id,
                first_name,
                last_name,
              ]);
            }
            // A bare "thanks" or "ok" after the welcome sequence isn't a
            // failed attempt to answer — it's a normal reaction to being
            // welcomed in, and this only had the name/email question to
            // compare it against. "Sorry, didn't catch that" is right for a
            // genuinely garbled attempt, but wrong here: nothing was missed.
            const missingReply = !finalName
              ? extracted.is_acknowledgment
                ? "Of course. So, what's your full name and email?"
                : extracted.email && !emailValid
                  ? "That email didn't look quite right — mind double-checking it?"
                  : "Sorry, didn't catch that. What's your full name and email?"
              : "Got your name — what's the best email for you?";
            try {
              await sendblue.messages.send({
                number,
                content: missingReply,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error("co-test intake re-ask send failed (non-fatal):", smsErr?.message ?? smsErr);
            }
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
              [user.id, `Co replied: ${missingReply}`],
            );
            return res.status(200).send({ received: true, action: "intake_incomplete" });
          }

          // Used later to tell the reply-generation prompt this is the very
          // first real exchange, not just another turn in an ongoing one —
          // decoupled from contact_verified/identity_captured, both of which
          // are now already true by the time any message reaches here.
          const priorActivity = await pool.query(
            `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' LIMIT 1`,
            [user.id],
          );
          const isFirstContact = !priorActivity.rows[0];

          // Moderator-by-text — the Circles pipeline test's confirmed decision
          // is "the tester acts as their own dev Moderator," not a second real
          // phone number or reuse of production's KEANA_PHONE_NUMBER. Any
          // verified real texter can approve/reject the most recent pending
          // simulated circle/venue this way; real Intent-Layer sessions never
          // have one pending, so this only ever actually fires during a Circles
          // pipeline test. Same classify-by-text pattern as production's Keana
          // intercept, factored into moderatorActions.ts so this and the
          // internal simulate buttons run identical logic.
          const pendingCircleApproval = await pool.query(
            `SELECT id FROM circles WHERE status = 'pending_approval' AND is_simulated = true ORDER BY created_at DESC LIMIT 1`,
          );
          const pendingVenueApproval = !pendingCircleApproval.rows[0]
            ? await pool.query(
                `SELECT id FROM moments WHERE status = 'pending_venue_approval' AND is_simulated = true ORDER BY created_at DESC LIMIT 1`,
              )
            : { rows: [] as any[] };

          if (pendingCircleApproval.rows[0] || pendingVenueApproval.rows[0]) {
            const { text: modClassification } = await generateText({
              model: anthropic("claude-haiku-4-5-20251001"),
              experimental_telemetry: {
                isEnabled: true,
                functionId: "co-test.webhooks.moderatorApproval.classify",
              },
              prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
            });
            const modAction = modClassification
              .trim()
              .toLowerCase()
              .replace(/^[`"']+|[`"']+$/g, "");

            if (modAction === "approve" || modAction === "reject") {
              const result = pendingCircleApproval.rows[0]
                ? await simulateModeratorApproval(
                    {
                      type: "circle",
                      circleId: pendingCircleApproval.rows[0].id,
                    },
                    modAction,
                  )
                : await simulateModeratorApproval(
                    {
                      type: "venue",
                      momentId: pendingVenueApproval.rows[0].id,
                    },
                    modAction,
                  );

              const ack = result.success
                ? `Got it — ${modAction}d.`
                : `Couldn't ${modAction}: ${result.error ?? "unknown error"}`;
              try {
                await sendblue.messages.send({
                  number,
                  content: capMessageLength(ack, 160),
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (smsErr: any) {
                console.error(
                  `Moderator ack send failed for ${number} (non-fatal):`,
                  smsErr?.message ?? smsErr,
                );
              }
              return res
                .status(200)
                .send({ received: true, action: `moderator_${modAction}` });
            }
            // "unclear" classification — fall through to normal conversation below.
          }

          // Real-test-placement circle invite response — the counterpart to
          // dynamicPlacementTest.ts's approveRealPlacementAndNotify, which sends
          // the real member their real invite text but never had anything
          // listening for what they replied. Confirmed for real: a member's
          // "Yes!" fell straight through to the generic conversation handler
          // below and Co responded as if it were answering an unrelated
          // question, never recognizing the invite was being accepted. Mirrors
          // production's pendingCircleInvite handling in api/src/routes/
          // sendblue.ts (same classify-by-text pattern, same circle_members
          // status transitions) — scoped to real_test_placement circles so it
          // never collides with the simulated Moderator-approval check above,
          // which only ever matches is_simulated circles.
          //
          // Also matches a row already resolved in the last 30 minutes (not
          // just 'pending') — double-texting ("Yes" sent twice, or resent
          // because the first reply felt slow) means the second delivery lands
          // after circle_members.status already flipped, so a plain
          // status='pending' match alone would miss it and let the same
          // fall-through-to-confused-conversation bug happen again on the
          // resend. withPhoneLock serializes same-number deliveries, so there's
          // no race between the two — this only handles them arriving in
          // sequence. The 30-minute bound keeps this from misclassifying an
          // unrelated yes/no reply days later, once the row is old.
          const pendingRealInvite = await pool.query(
            `SELECT cm.circle_id, cm.status, c.circle_name
         FROM circle_members cm
         JOIN circles c ON c.id = cm.circle_id
         WHERE cm.member_id = $1 AND c.real_test_placement = true
           AND (cm.status = 'pending' OR cm.joined_at > NOW() - INTERVAL '30 minutes')
         ORDER BY cm.joined_at DESC
         LIMIT 1`,
            [user.id],
          );

          if (pendingRealInvite.rows[0]) {
            const {
              circle_id,
              circle_name,
              status: currentStatus,
            } = pendingRealInvite.rows[0];

            const { text: inviteClassification } = await propagateAttributes(
              {
                userId: user.id,
                traceName: "co-test.webhooks.circleInviteResponse.classify",
              },
              () =>
                generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  experimental_telemetry: {
                    isEnabled: true,
                    functionId:
                      "co-test.webhooks.circleInviteResponse.classify",
                  },
                  prompt: `A user replied to a circle invite. Classify their response as ONE of: "yes" — they want to join, "no" — they want to pass, "unclear" — can't tell.\n\nMessage: "${content}"\n\nReturn ONLY the classification, nothing else.`,
                }),
            );
            const inviteAction = inviteClassification
              .trim()
              .toLowerCase()
              .replace(/^[`"']+|[`"']+$/g, "");

            if (inviteAction === "yes" || inviteAction === "no") {
              let ack: string;
              if (currentStatus === "pending") {
                await pool.query(
                  `UPDATE circle_members SET status = $1 WHERE circle_id = $2 AND member_id = $3`,
                  [
                    inviteAction === "yes" ? "accepted" : "declined",
                    circle_id,
                    user.id,
                  ],
                );
                ack =
                  inviteAction === "yes"
                    ? `You're in — welcome to ${circle_name}.`
                    : "No worries — thanks for letting me know.";
              } else {
                // Already resolved — an idempotent ack for the resend, not a
                // re-process. Whatever the new reply says, the earlier decision
                // stands; nothing to update.
                ack =
                  currentStatus === "accepted"
                    ? `Already got you down for ${circle_name} — you're all set.`
                    : "Already noted — no further action needed.";
              }

              try {
                await sendblue.messages.send({
                  number,
                  content: capMessageLength(ack, 160),
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (smsErr: any) {
                console.error(
                  `Real-placement invite ack send failed for ${number} (non-fatal):`,
                  smsErr?.message ?? smsErr,
                );
              }
              return res.status(200).send({
                received: true,
                action: `real_invite_${inviteAction}`,
                already_resolved: currentStatus !== "pending",
              });
            }
            // "unclear" classification — fall through to normal conversation below.
          }

          // Already verified — ongoing conversational texting, proving the
          // "does texting with Co keep working after verification" half of item 2.
          //
          // Two separate sources, not one pooled recency query: a plain "last 6
          // co_memories rows of any type" query was found to silently evict the
          // call's own call_transcript/intent/recap rows once ~2 text exchanges
          // piled up (each exchange writes 2 more rows), so Co would confidently
          // use real captured data in early replies, then flatly deny having any
          // context a few messages later — confirmed directly against a real
          // test user's row timestamps. co_profiles is the durable, structured
          // record the call already wrote (goals/blockers/city/intent) and isn't
          // subject to that eviction, so it's queried directly instead of being
          // re-derived from a shrinking memory window.
          const [profileResult, recentTextResult, priorActivityResult, turnTone] =
            await Promise.all([
              pool.query(
                `SELECT life_chapters, goals, blockers, availability_pattern, city, emotional_state, intent
           FROM co_profiles WHERE user_id = $1`,
                [user.id],
              ),
              pool.query(
                `SELECT content FROM co_memories
           WHERE user_id = $1 AND memory_type = 'text_exchange'
           ORDER BY created_at DESC LIMIT 8`,
                [user.id],
              ),
              // Feeds the thin-profile first-topic call offer below — must be read
              // before this message's own "User said" row is inserted, so it
              // reflects state as of BEFORE this message, not including it.
              pool.query(
                `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') LIMIT 1`,
                [user.id],
              ),
              // Mirrors api/src/routes/sendblue.ts's Step 3 addition — a pure
              // add-on signal for the reply prompt below, run alongside
              // everything else here rather than after it.
              detectTurnTone(content, "co-test.webhooks.detectTurnTone"),
            ]);

          const profile = profileResult.rows[0] ?? null;
          const hasProfile = !!profile?.life_chapters?.length;
          const isFirstRealMessage = !priorActivityResult.rows[0];
          const latestIntent =
            Array.isArray(profile?.intent) && profile.intent.length
              ? profile.intent[profile.intent.length - 1]
              : null;

          const profileContext = profile
            ? [
                profile.life_chapters?.length
                  ? `Life chapter: ${profile.life_chapters.join(", ")}`
                  : null,
                profile.city ? `City: ${profile.city}` : null,
                profile.goals?.length
                  ? `Goals: ${profile.goals.join("; ")}`
                  : null,
                profile.blockers?.length
                  ? `Blockers: ${profile.blockers.join("; ")}`
                  : null,
                profile.availability_pattern
                  ? `Availability: ${profile.availability_pattern}`
                  : null,
                profile.emotional_state
                  ? `Emotional state as of the last call: ${profile.emotional_state}`
                  : null,
                latestIntent?.text
                  ? `Stated ask (${latestIntent.type}): ${latestIntent.text}`
                  : null,
                latestIntent?.concrete_preferences?.length
                  ? `Concrete preferences: ${latestIntent.concrete_preferences.join(", ")}`
                  : null,
                latestIntent?.wants?.length
                  ? `Things they want or miss: ${latestIntent.wants.join(", ")}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n")
            : null;

          const recentConversation = recentTextResult.rows
            .map((r: any) => r.content)
            .reverse()
            .join("\n");
          const styleHint = deriveStyleHint(recentTextResult.rows);

          // Runs alongside the write, not blocking on it — a second advisory
          // read on this same message, this time on what they need (heard
          // vs. helped toward an answer) rather than how they feel. See
          // detectSeekingMode's own comment for why this needs the
          // conversation, not just the one message, unlike detectTurnTone.
          const [, seekingMode] = await Promise.all([
            pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
              [user.id, `User said: ${content}`],
            ),
            detectSeekingMode(content, recentConversation, "co-test.webhooks.detectSeekingMode"),
          ]);

          // Show the animated "..." on the sender's device while Co "thinks" —
          // this branch runs a call-detection classification, possibly a
          // recommendation classification, and a reply generation before
          // anything gets sent back, which is real, visible latency without
          // this. Never sent at all in co-test before now (production has this,
          // co-test's port of the ongoing-chat handler never picked it up).
          // Best-effort, matching every other Sendblue send in this file.
          try {
            await sendblue.typingIndicators.send({
              number,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (typingErr: any) {
            console.error(
              `Typing indicator failed for ${number} (non-fatal):`,
              typingErr?.message ?? typingErr,
            );
          }

          // Call-trigger detection — reuses the same Twilio-dial-and-bridge
          // mechanism phone.ts's dashboard call button uses (services/callTrigger.ts),
          // just reached from a different trigger. Two cases, per explicit
          // product decision: an explicit ask ("call me") triggers immediately;
          // anything that only SIGNALS voice would help gets OFFERED, and
          // actually placing that call requires a following "yes" — never
          // silently placed. Gated on identity_captured only (already true
          // here, or this message would have been consumed by the intake
          // block above instead). The "User said" row above is already
          // written regardless of outcome, so nothing below re-inserts it.
          // Bug found the hard way: this used to just check whether an offer was
          // EVER made, not whether it was still unresolved — so once someone
          // answered (accept or decline), the classifier prompt below kept
          // telling the model "Co is waiting on a yes/no" forever afterward, and
          // an unrelated later "yeah"/"true" would get misread as consenting to
          // a call that was already resolved. Confirmed against a real
          // conversation: this placed 4 real Twilio calls after the user had
          // explicitly said "don't call me" multiple times. Must compare
          // timestamps, not just existence.
          //
          // Second bug, same shape, found the same way: an offer could sit
          // unresolved for days (a test session that never restarted, or
          // just someone who went quiet) and still count as "waiting for a
          // yes/no" — confirmed live, a 4-day-old offer from a single
          // "Hello" got treated as still pending, and an unrelated "Hi Co,
          // it's [name]" re-engaging days later got misread as accepting it,
          // triggering a real call. A "want to hop on a call about this?"
          // gesture only makes sense in the conversation it was offered in —
          // past 24h, it stops counting as pending, and treats it the same
          // as any other unresolved offer (no decline recorded, no
          // call_offer_declined_topic entry) rather than resolving it.
          const pendingOfferResult = await pool.query(
            `SELECT p.id, p.content FROM co_memories p
         WHERE p.user_id = $1 AND p.memory_type = 'call_offer_pending'
         AND p.created_at > NOW() - INTERVAL '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM co_memories r
           WHERE r.user_id = $1 AND r.memory_type = 'call_offer_resolved' AND r.created_at > p.created_at
         )
         ORDER BY p.created_at DESC LIMIT 1`,
            [user.id],
          );
          const pendingOffer = pendingOfferResult.rows[0] ?? null;
          const hasPendingOffer = !!pendingOffer;

          // Topic-aware, not a permanent opt-out and not a blanket timer either —
          // per explicit product decision, Co should stay free to offer a call
          // about a genuinely new situation at any time, but never re-offer about
          // something already declined. Each declined offer's own text (it
          // already reflects what was being discussed, see callOfferContext
          // below) is stored, and the classifier is given that list directly so
          // the SAME call decides both "would voice help" and "haven't we
          // already asked about this" in one pass, instead of a second
          // similarity check.
          const declinedTopicsResult = await pool.query(
            `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_declined_topic' ORDER BY created_at DESC LIMIT 20`,
            [user.id],
          );
          const declinedTopicsContext = declinedTopicsResult.rows.length
            ? `\n\nCo has previously offered a call about the following, and the user said no each time:\n${declinedTopicsResult.rows.map((r: any) => `- ${r.content}`).join("\n")}\nIf what they're describing now is essentially the same situation as any of these, classify as "none" instead of "would_benefit" — don't re-offer about something already declined. A genuinely different, new situation is free to classify as "would_benefit" regardless of these.`
            : "";

          const { text: rawCallClassification } = await propagateAttributes(
            {
              userId: user.id,
              traceName: "co-test.webhooks.callOffer.classify",
            },
            () =>
              generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: {
                  isEnabled: true,
                  functionId: "co-test.webhooks.callOffer.classify",
                },
                prompt: `A user is texting Co, a life concierge.${hasPendingOffer ? ` Co already offered them a call about this: "${pendingOffer.content}", and is waiting for a yes or no on THAT specific offer. If their latest message is still about that same underlying problem or theme — even just continuing to describe it, elaborating, or venting further, in different words — that is NOT a new reason to offer again; classify it as accepts_offer/declines_offer/none as usual, never would_benefit. Only classify "would_benefit" here if what they're describing now is a clearly different problem or situation from the one already offered on — a still-open offer on one topic doesn't block a fresh offer on a genuinely unrelated one.` : ""}

Recent conversation, in order (their latest message may only make sense combined with what came before — e.g. a time given in one message and a date/timezone confirmed in a later one is still a single schedule request, not two separate things):
${recentConversation || "(start of the conversation)"}

Their latest message: "${content}"

Classify their LATEST message, read in light of the recent conversation above, as ONE of:
- "explicit_request" — they are directly asking Co to call them RIGHT NOW, or asking to talk by phone with no specific future time attached. This is a command, not a question — "call me", "let's talk on the phone", "can you call me right now". It is NOT this if they are asking whether or how calling works rather than asking for one — see "asks_about_calling" below for that. It is also NOT this if their message only mentions "call" while questioning, declining, or complaining about one that already happened or was offered (e.g. "why did you call me", "I didn't ask you to call me", "stop calling me") — those are "none", never a request. When in doubt whether something is a request or a question about the feature, treat it as the question.
- "asks_about_calling" — they are asking whether, or how, calling works — as a question about the feature, not a command to place one. Examples: "can I just call you?", "is it true I can call you now?", "can I initiate a call?", "can I call you whenever I want?", "do you call people?". This is never triggered by their phrasing containing the word "call" alone — it's specifically a question rather than an instruction.
- "schedule_request" — they want a call at a specific future date/time, whether that time was fully stated just now ("call me tomorrow at 3") or is only complete once combined with what they said earlier in this conversation (e.g. they gave a time a few messages ago and are now confirming the date or timezone Co asked for) — not right now
- "cancel_scheduled_call" — they want to cancel a call they'd previously scheduled, with no new time given ("actually never mind about that call", "can we skip the call Thursday")
${hasPendingOffer ? '- "accepts_offer" — they are clearly and affirmatively saying yes to the call Co just offered (e.g. "yes", "sure", "call me now", "go ahead"). A bare acknowledgment with no clear yes/no of its own — "thanks", "ok", "got it", "sounds good" — is NOT this; classify it as "none" unless it unambiguously affirms the offer.\n- "declines_offer" — they are saying no to the call Co just offered\n' : ""}- "would_benefit" — none of the above, but what they're describing is complex, emotional, or hard to unpack over short texts, and voice would genuinely help
- "none" — normal conversation, no call is relevant${declinedTopicsContext}

Return ONLY the classification, nothing else.`,
              }),
          );
          const callAction = rawCallClassification
            .trim()
            .toLowerCase()
            .replace(/^[`"']+|[`"']+$/g, "");

          if (
            hasPendingOffer &&
            (callAction === "accepts_offer" || callAction === "declines_offer")
          ) {
            // Bookkeeping write — must never be able to take down the whole
            // reply. Confirmed the hard way: this and the call_offer_pending
            // insert below were unguarded, the memory_type CHECK constraint
            // hadn't been widened for these new values yet, and the resulting
            // exception aborted the request before any reply was generated —
            // Sendblue kept retrying into the same crash, so the user got no
            // reply at all rather than a slow one.
            await pool
              .query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_resolved', $2)`,
                [user.id, callAction],
              )
              .catch((err: any) =>
                console.error(
                  "webhooks: call_offer_resolved memory write failed (non-fatal):",
                  err?.message ?? err,
                ),
              );

            if (callAction === "declines_offer" && pendingOffer.content) {
              await pool
                .query(
                  `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_declined_topic', $2)`,
                  [user.id, pendingOffer.content],
                )
                .catch((err: any) =>
                  console.error(
                    "webhooks: call_offer_declined_topic memory write failed (non-fatal):",
                    err?.message ?? err,
                  ),
                );
            }
          }

          const shouldTriggerCall =
            callAction === "explicit_request" ||
            (hasPendingOffer && callAction === "accepts_offer");

          // Schedule-a-call — a specific future time, not "call me now"
          // (shouldTriggerCall above). Extracted as structured date/time/
          // timezone rather than asking the model to do timezone math
          // itself (unreliable) — luxon does the actual UTC conversion once
          // all three pieces are present. Nothing gets scheduled on a
          // partial extraction; the reply below asks for whatever's
          // missing instead of guessing a timezone, which would silently
          // call someone at the wrong time.
          let scheduleCallContext = "";
          if (callAction === "schedule_request") {
            try {
              const nowUtc = DateTime.now().toUTC();
              const { text: rawSchedule } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: {
                  isEnabled: true,
                  functionId: "co-test.webhooks.scheduleCallExtract",
                },
                prompt: `A user is texting Co to schedule a call for later. The date, time, and timezone can be spread across several messages (e.g. they gave a time earlier and are only now confirming the date/timezone Co asked for) — read the whole conversation, not just the latest message, to piece it together.

Recent conversation, in order:
${recentConversation || "(start of the conversation)"}

Their latest message: "${content}"

For resolving anything relative ("tomorrow", "next Tuesday"), the current UTC date/time is ${nowUtc.toFormat("cccc, LLLL d, yyyy 'at' HH:mm 'UTC'")}.

Extract, combining information from the whole conversation above:
- date: the requested date, as YYYY-MM-DD. null if not stated anywhere or genuinely ambiguous.
- time: the requested time of day, as 24-hour HH:MM. null if not stated anywhere.
- timezone: the IANA timezone name they stated or unambiguously implied (e.g. "America/New_York", "America/Los_Angeles", "America/Chicago", "America/Denver"). null if not stated and not clearly implied — never guess one.

Return ONLY valid JSON, no preamble: {"date": "YYYY-MM-DD or null", "time": "HH:MM or null", "timezone": "IANA name or null"}`,
              });

              const clean = rawSchedule.replace(/```json|```/g, "").trim();
              const parsed = JSON.parse(clean) as {
                date: string | null;
                time: string | null;
                timezone: string | null;
              };

              if (parsed.date && parsed.time && parsed.timezone) {
                const local = DateTime.fromISO(`${parsed.date}T${parsed.time}`, {
                  zone: parsed.timezone,
                });
                if (local.isValid && local.toUTC() > DateTime.utc()) {
                  // A new successfully-scheduled call supersedes any earlier
                  // one still pending, rather than both eventually firing —
                  // asking again means instead of, not also. Only cancels
                  // 'pending' rows; one already claimed/'processing' by the
                  // cron is left alone rather than raced.
                  const superseded = await pool.query(
                    `UPDATE scheduled_calls SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
                    [user.id],
                  );
                  await pool.query(
                    `INSERT INTO scheduled_calls (user_id, requested_text, timezone, scheduled_for) VALUES ($1, $2, $3, $4)`,
                    [user.id, content, parsed.timezone, local.toUTC().toISO()],
                  );
                  const formattedTime = local.toFormat("cccc, LLLL d 'at' h:mm a");
                  scheduleCallContext = superseded.rows.length
                    ? `\nThey just rescheduled — this replaces a call they'd already booked, now moved to ${formattedTime} (${parsed.timezone}). Confirm the NEW time back to them naturally, making clear this is a change from before, not a new addition. Do not place a call now, it's scheduled for later.`
                    : `\nThey just successfully scheduled a call for ${formattedTime} (${parsed.timezone}) — confirm that back to them naturally, referencing the actual day and time so they know it landed correctly. Do not place a call now, it's scheduled for later.`;
                } else {
                  scheduleCallContext = `\nThey tried to schedule a call, but the time they gave (${parsed.date} ${parsed.time}, ${parsed.timezone}) is invalid or already in the past — let them know naturally and ask for a time that hasn't passed yet. Do not place a call now.`;
                }
              } else {
                const missing = [
                  !parsed.date && "the date",
                  !parsed.time && "the time",
                  !parsed.timezone && "their timezone",
                ]
                  .filter(Boolean)
                  .join(" and ");
                scheduleCallContext = `\nThey want to schedule a call for later but haven't given ${missing} yet — ask for exactly that, specifically. Never guess or assume a timezone. Do not place a call now.`;
              }
            } catch (err: any) {
              console.error(
                "webhooks: schedule_request extraction failed (non-fatal):",
                err?.message ?? err,
              );
              scheduleCallContext = `\nThey want to schedule a call for a specific time but something went wrong figuring out when — ask them to state the day, time, and their timezone clearly. Do not place a call now.`;
            }
          } else if (callAction === "cancel_scheduled_call") {
            // No new time to extract here — just clear whatever's pending.
            // Only touches 'pending' rows, same reasoning as the supersede
            // logic above: one already claimed/'processing' by the cron is
            // left alone rather than raced with a cancel.
            try {
              const cancelled = await pool.query(
                `UPDATE scheduled_calls SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
                [user.id],
              );
              scheduleCallContext = cancelled.rows.length
                ? `\nThey just cancelled their scheduled call — confirm that naturally. Do not place a call now.`
                : `\nThey're trying to cancel a scheduled call, but nothing is actually scheduled right now — let them know that naturally, there's nothing to cancel. Do not place a call now.`;
            } catch (err: any) {
              console.error(
                "webhooks: cancel_scheduled_call failed (non-fatal):",
                err?.message ?? err,
              );
              scheduleCallContext = `\nThey want to cancel a scheduled call but something went wrong doing that — let them know you'll sort it out. Do not place a call now.`;
            }
          }

          // Burst limiter — separate from, and in addition to, the topic-aware
          // suppression above. Topic-matching only stops Co re-offering about the
          // SAME thing; on its own it does nothing to stop several DIFFERENT
          // heavy topics in a row each triggering their own offer. This is what
          // originally caused a real problem here: Co offered a call 4 times in
          // one real conversation, once directly in response to "why is it
          // always a phone call?" — a complaint about the pattern itself,
          // misread as more evidence a call would help. Short and topic-blind on
          // purpose: it only need cover a burst, not stand in for the topic
          // check above.
          const recentOfferCountResult = await pool.query(
            `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_pending' AND created_at > NOW() - INTERVAL '10 minutes'`,
            [user.id],
          );
          const recentOfferBurstActive =
            parseInt(recentOfferCountResult.rows[0].count, 10) > 0;

          // Two independent reasons to make the same secondary, folded-in
          // gesture — never a standalone question, per the note below. One is
          // content-driven (would_benefit) and can fire on any message from
          // anyone. The other is channel-driven, not content-driven: someone
          // with no profile yet, on their first real message, gets the gesture
          // regardless of what that message actually is — a real voice call
          // just produces a far richer initial profile than short texts ever
          // will, and this is the one moment to offer that before the
          // conversation settles into text. Fires at most once per person
          // (isFirstRealMessage is only ever true for message #1), so it can't
          // collide with the topic-aware/burst-limiter rules above that govern
          // everyone's ongoing conversations.
          // Two independent reasons Co might fold in a secondary call-offer
          // gesture: content-driven (would_benefit) or channel-driven —
          // someone with no profile yet, on their first real message,
          // regardless of what that message actually is. Fires at most once
          // per person (isFirstRealMessage is only ever true for message #1).
          // Eligibility (this signal + hasPendingOffer/recentOfferBurstActive
          // as hard gates) is now weighed by the reply agent below, not
          // pre-decided here — see agent/conversationReply.ts.
          const isThinProfileFirstMessage =
            !hasProfile && isFirstRealMessage && callAction === "none";

          // They asked a plain question about the calling feature — answer it
          // truthfully, don't place a call and don't pretend one is
          // happening. Confirmed live: without this, the classifier alone
          // wasn't a strong enough signal on its own to stop the reply from
          // improvising "calling you now" language, and separately, this
          // question being misread as explicit_request was actually placing
          // real outbound Twilio calls to people who were just asking how
          // the feature works, not requesting one.
          const callFeatureQuestionContext =
            callAction === "asks_about_calling"
              ? `\nThey just asked a plain question about how calling works — answer it directly and honestly, don't place a call, and don't say or imply a call is happening. The true answer: Co can call them — by text right now ("call me") or scheduled for later — and that's real and live. They can also call Co directly at this same number anytime — that connects to a real, live conversation with Co. Only mention this second part if it's actually what they're asking about; don't volunteer it unprompted.`
              : "";

          if (shouldTriggerCall) {
            const callResult = await triggerCall(user.id);
            if (callResult.success) {
              // A fixed "Calling you now." every time reads as a canned system
              // message, not someone actually reacting to what was just asked
              // for. Kept fast (Haiku, one short line, hard fallback) since the
              // real call is already dialing — this must never add meaningful
              // delay or block on a slow/failed generation.
              let confirmation = "Calling you now.";
              try {
                const { text: variedConfirmation } = await generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  experimental_telemetry: {
                    isEnabled: true,
                    functionId: "co-test.webhooks.callConfirmation",
                  },
                  prompt: `You are Co. ${user.first_name} just texted: "${content}" — asking you to call them. You're calling them right now. Send a short, natural one-line text confirming that — vary how you say it, don't just say "Calling you now." No exclamation points, no em dashes. Under 40 characters.`,
                });
                const trimmed = variedConfirmation.trim();
                if (trimmed)
                  confirmation =
                    trimmed.length > 60 ? trimmed.slice(0, 59) + "…" : trimmed;
              } catch (genErr: any) {
                console.error(
                  "Call-confirmation generation failed (non-fatal, using default):",
                  genErr?.message ?? genErr,
                );
              }
              await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
                [user.id, `Co replied: ${confirmation}`],
              );
              try {
                await sendblue.messages.send({
                  number,
                  content: confirmation,
                  from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                });
              } catch (smsErr: any) {
                console.error(
                  `Sendblue call-confirmation send failed for ${number} (non-fatal):`,
                  smsErr?.message ?? smsErr,
                );
              }
              return res.status(200).send({
                received: true,
                action: "call_triggered",
                call_sid: callResult.call_sid,
              });
            }
            console.error(
              `webhooks: call trigger failed for user ${user.id} (non-fatal, falling through to normal reply):`,
              callResult.error,
            );
            // Falls through to the normal reply flow below on failure — a
            // failed dial attempt should never leave the conversation silent.
          }

          // Real action-triggering, iMessage side (Intent Layer only) — mirrors
          // the surface_recommendation Hume tool on the voice path, but iMessage
          // has no tool_call plane to invoke it through, so this is a direct
          // call to the same shared generateRecommendation() gated by a cheap
          // classification step instead. Folded into the one reply below (never
          // sent as a second message) to stay consistent with the pacing fix
          // above.
          let recommendationContext = "";
          try {
            const { text: wantsClassification } = await propagateAttributes(
              {
                userId: user.id,
                traceName: "co-test.webhooks.wantsRecommendation.classify",
              },
              () =>
                generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  experimental_telemetry: {
                    isEnabled: true,
                    functionId: "co-test.webhooks.wantsRecommendation.classify",
                  },
                  prompt: `Classify this message as either "wants_something_concrete" or "normal_conversation".

"wants_something_concrete" means they're asking Co to actually suggest, recommend, help find, or surface something specific right now (e.g. "what can you surface for me", "find me something", "what should I do about this").
"normal_conversation" means anything else — small talk, questions about Co, answering a question, general chat.

Message: "${content}"

Return ONLY the classification, nothing else.`,
                }),
            );
            const wantsSomethingConcrete = wantsClassification
              .trim()
              .toLowerCase()
              .replace(/^[`"']+|[`"']+$/g, "")
              .includes("wants_something_concrete");

            if (wantsSomethingConcrete) {
              const recommendation = await generateRecommendation(
                user.id,
                content,
              );
              if (recommendation.available) {
                // This is a category/type suggestion, never a specific real
                // venue with a link — that's the venue lookup below, a
                // different mechanism. Found a real case where Co said
                // "sending that over now" for exactly this kind of abstract
                // suggestion, with no link anywhere, because there was never
                // anything concrete to send in the first place.
                recommendationContext = `\nYou just thought of a real recommendation for them: "${recommendation.match}" — ${recommendation.reason}. Work this into your reply naturally, as your own suggestion. This is an idea, not a specific place with a link — never say you're "sending" or "sharing" anything for this, you have nothing to send.`;
              }
            }
          } catch (err: any) {
            console.error(
              "webhooks: recommendation classification failed (non-fatal):",
              err?.message ?? err,
            );
          }

          // Real venue lookup — distinct from the abstract recommendation above.
          // When someone mentions wanting a specific CATEGORY of place (a gym, a
          // cafe, a climbing spot), search Google Places for real, and send an
          // actual Google Maps link — not a description of what Co would send.
          // Built after a real conversation showed Co naming a specific gym
          // ("Dogpatch Boulders") with zero real data behind it, from general
          // knowledge rather than a lookup. Needs a known city to search against;
          // silently skipped if none is on file yet rather than guessing one.
          let venueContext = "";
          let venueDeliveryMessage: string | null = null;
          if (profile?.city) {
            try {
              // Must see the conversation, not just this one message — found a
              // real case where "send some my way, maybe 2-5" (a pure follow-up
              // to "climbing gyms" mentioned earlier) didn't mention any place
              // category on its own, so an isolated-message classifier missed
              // it entirely and it fell through to the abstract recommendation
              // path instead, which then claimed to be "sending" something it
              // structurally can never send.
              const { text: rawVenueClassification } =
                await propagateAttributes(
                  {
                    userId: user.id,
                    traceName: "co-test.webhooks.venueRequest.classify",
                  },
                  () =>
                    generateText({
                      model: anthropic("claude-haiku-4-5-20251001"),
                      experimental_telemetry: {
                        isEnabled: true,
                        functionId: "co-test.webhooks.venueRequest.classify",
                      },
                      prompt: `Recent text conversation, in order:
${recentConversation || "(start of the conversation)"}

Their latest message: "${content}"

In light of the conversation above, is their latest message wanting, looking for, or asking about a specific CATEGORY of physical place — a gym, a cafe, a climbing spot, a coworking space, a restaurant, a bar, etc.? This includes a plain follow-up like "send me some" or "yes please" if the category was already established earlier in the conversation. Not a person, not an abstract idea, an actual type of place someone could visit.

If yes, how many did they ask for? Default to 1 if they didn't say a number or range; if they gave a range (e.g. "2-5"), use the upper end, capped at 5.

Return ONLY valid JSON, no preamble: {"wants_venue": true or false, "venue_type": "the category, in a few words" or null, "count": a number from 1 to 5}`,
                    }),
                );
              const cleanVenue = rawVenueClassification
                .replace(/```json|```/g, "")
                .trim();
              const parsedVenue = JSON.parse(cleanVenue);
              if (
                parsedVenue?.wants_venue &&
                typeof parsedVenue.venue_type === "string" &&
                parsedVenue.venue_type
              ) {
                const venueType: string = parsedVenue.venue_type;
                const requestedCount = Math.max(
                  1,
                  Math.min(Number(parsedVenue.count) || 1, 5),
                );

                // The real Places search below has genuine network latency on
                // top of the classification calls already run this turn — a
                // real conversation showed Co claiming "sending that now" with
                // no link actually in the message, because the search hadn't
                // even happened yet when that reply was written. Send a real,
                // personalized acknowledgment now, before the search, then
                // deliver the actual result as the reply below — never claim
                // delivery before there's something real to deliver.
                try {
                  const { text: rawHold } = await propagateAttributes(
                    {
                      userId: user.id,
                      traceName: "co-test.webhooks.venueRequest.holdMessage",
                    },
                    () =>
                      generateText({
                        model: anthropic("claude-haiku-4-5-20251001"),
                        experimental_telemetry: {
                          isEnabled: true,
                          functionId:
                            "co-test.webhooks.venueRequest.holdMessage",
                        },
                        prompt: `You are Co, texting someone. They just asked about finding ${requestedCount > 1 ? `${requestedCount} ${venueType}s` : `a ${venueType}`}. You're about to go actually look them up for them — send a brief, warm, personalized "give me a sec" acknowledgment, referencing what they're actually looking for, not generic. Don't claim you've found anything yet. One short sentence. No exclamation points, no em dashes. Under 100 characters.`,
                      }),
                  );
                  const holdMessage = capMessageLength(rawHold, 100);
                  await pool.query(
                    `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
                    [user.id, `Co replied: ${holdMessage}`],
                  );
                  try {
                    await sendblue.messages.send({
                      number,
                      content: holdMessage,
                      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
                    });
                  } catch (smsErr: any) {
                    console.error(
                      `Sendblue venue-lookup hold message failed for ${number} (non-fatal):`,
                      smsErr?.message ?? smsErr,
                    );
                  }
                } catch (err: any) {
                  console.error(
                    "webhooks: venue hold-message generation failed (non-fatal, proceeding to search anyway):",
                    err?.message ?? err,
                  );
                }

                const venues = await findRealVenues(
                  venueType,
                  profile.city,
                  requestedCount,
                );
                if (venues.length) {
                  // Sent as its own dedicated, complete message instead of
                  // folded into the general reply — a real conversation showed
                  // a multi-venue list getting mangled by the generic char-cap
                  // split (a name separated from its own link, later venues
                  // silently dropped past the cutoff). A list of real, named
                  // things needs the room to actually say all of them, not a
                  // fight against an SMS-length budget meant for small talk.
                  try {
                    const { text: rawIntro } = await propagateAttributes(
                      {
                        userId: user.id,
                        traceName: "co-test.webhooks.venueRequest.introMessage",
                      },
                      () =>
                        generateText({
                          model: anthropic("claude-haiku-4-5-20251001"),
                          experimental_telemetry: {
                            isEnabled: true,
                            functionId:
                              "co-test.webhooks.venueRequest.introMessage",
                          },
                          prompt: `You are Co, texting someone. You just found ${venues.length} real ${venueType}${venues.length > 1 ? "s" : ""} for them${venues.length < requestedCount ? ` — they asked for ${requestedCount}, this is genuinely all that came back as a solid match, say so honestly` : ""}. Write ONE short, warm intro sentence to go right before a list (the list itself follows separately after your sentence — do not write the list yourself, do not include any links). No exclamation points, no em dashes. Under 150 characters.`,
                        }),
                    );
                    const introLine = capMessageLength(rawIntro, 150);
                    const listBlock = venues
                      .map((v) => `${v.name} — ${v.mapsUrl}`)
                      .join("\n\n");
                    venueDeliveryMessage = `${introLine}\n\n${listBlock}`;
                  } catch (err: any) {
                    console.error(
                      "webhooks: venue delivery intro generation failed (non-fatal, sending list plainly):",
                      err?.message ?? err,
                    );
                    venueDeliveryMessage = venues
                      .map((v) => `${v.name} — ${v.mapsUrl}`)
                      .join("\n\n");
                  }
                  await pool
                    .query(
                      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2)`,
                      [
                        user.id,
                        `Co surfaced ${venues.length} real venue(s) — ${venues.map((v) => `${v.name} (${v.address}): ${v.mapsUrl}`).join("; ")}`,
                      ],
                    )
                    .catch((err: any) =>
                      console.error(
                        "webhooks: venue memory write failed (non-fatal):",
                        err?.message ?? err,
                      ),
                    );
                } else {
                  // Must not repeat the "claimed to deliver, delivered nothing"
                  // failure — if the search genuinely came up empty, the reply
                  // has to say so honestly, not go quiet or invent a name.
                  venueContext = `\nYou looked for a real ${venueType} but didn't find a solid match nearby. Say so honestly in your reply — don't invent a name or pretend you found one.`;
                }
              }
            } catch (err: any) {
              console.error(
                "webhooks: venue lookup classification failed (non-fatal):",
                err?.message ?? err,
              );
            }
          }

          // ACK Sendblue's webhook now, before the debounce sleep below.
          // Holding the HTTP response open for the full DEBOUNCE_MS was
          // confirmed live to cause Sendblue to retry the webhook delivery
          // (same message, same content, a second call to this route) —
          // that retry re-stamps phone_debounce with a fresh timestamp,
          // which then makes the ORIGINAL request think a newer message
          // arrived and silently bail without ever replying, even though
          // nothing new was actually said. Everything from here on
          // (debounce wait, reply generation, actually sending the SMS) is
          // a separate outbound call to Sendblue's API, not tied to this
          // webhook's own response — so ack'ing early doesn't skip any of
          // it, it just stops this response from being the thing that
          // times out.
          res.status(200).send({ received: true, action: "processing" });

          // Debounce the free-form reply only. Every deterministic branch
          // above this point (opt-out/in, intake, moderator approval, call
          // offer/schedule, recommendation/venue classification) has already
          // returned by now — this is the point where a still-forming
          // thought getting cut off actually matters. myInboundAt is set
          // before withPhoneLock, precisely so this check can see a message
          // that arrived and is now queued behind this request's lock (see
          // stampPhoneDebounce's comment).
          if (myInboundAt) {
            await pause(DEBOUNCE_MS);
            const latest = await pool.query(
              `SELECT last_inbound_at FROM phone_debounce WHERE phone = $1`,
              [number],
            );
            const latestInboundAt = latest.rows[0]?.last_inbound_at ?? null;
            if (latestInboundAt && new Date(latestInboundAt).getTime() > new Date(myInboundAt).getTime()) {
              // A newer message arrived while this one waited. This
              // message's content is already stored above, so the newer
              // message's request — next in line behind this one's phone
              // lock — will see it as context and can respond to both at
              // once. Bail out here without generating or sending anything.
              // Already ack'd above, so just return.
              return;
            }
          }

          // If a venue list already went out as its own dedicated message above,
          // that IS the response to what they asked for — running the general
          // persona reply on top of it would mean a 3rd message every time
          // (hold + list + generic reply), which is exactly the "too many
          // messages" problem this was built to avoid. Only generate a normal
          // reply when nothing was already delivered.
          let cappedReply: string;
          if (venueDeliveryMessage) {
            cappedReply = venueDeliveryMessage;
            await pool.query(
              `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
              [user.id, `Co replied: ${venueDeliveryMessage}`],
            );
            try {
              await sendblue.messages.send({
                number,
                content: venueDeliveryMessage,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
            } catch (smsErr: any) {
              console.error(
                `Sendblue venue delivery send failed for ${number} (non-fatal):`,
                smsErr?.message ?? smsErr,
              );
            }
          } else {
            // Same persona the real call uses, not a separate thinner one — Co
            // should be the same entity whether someone's talking by voice or
            // text, capable of picking up a genuine back-and-forth either way.
            // The anti-fabrication grounding rule and the text-length cap below
            // are additions specific to this channel, layered on top, not a
            // replacement for anything in the real prompt.
            const personaPrompt = await getCoPersonaPrompt();

            // A call actively works toward covering RAPPORT_TOPICS (via the
            // live assess_conversation_coverage tool — see handleToolCall
            // above); text had no equivalent at all, so it just answered
            // reactively and never actually worked toward filling in a real
            // profile (confirmed for real: city stayed null through an entire
            // text-only conversation that built out life_chapters, goals, and
            // activity_preferences just fine, because nothing ever prompted for
            // it). Reuses the exact same assessConversationCoverage function
            // and RAPPORT_TOPICS the call uses — same coverage goal, same
            // topic set, just fed into this single reply-generation call
            // directly instead of a live tool_call loop.
            const coverageSoFar =
              `${recentConversation}\nUser said: ${content}`.trim();
            const coverage = await assessConversationCoverage(
              coverageSoFar,
              profileContext ?? undefined,
            );
            // Same gap as handleToolCall's call-channel version had — this
            // assessment was only ever used to shape the reply below, never
            // persisted to co_profiles.topics_covered. Confirmed missing the
            // same way: a real text exchange correctly worked new ground,
            // but topics_covered stayed empty in the DB afterward.
            persistCoveredTopics(user.id, coverage);
            const missingTopicsContext =
              coverage.missing_topics.length && !coverage.ready_to_summarize
                ? `\nStill missing from what you know about them: ${coverage.missing_topics.map((t) => RAPPORT_TOPIC_DESCRIPTIONS[t]).join("; ")}. If it fits naturally off what they just said, work ONE of these in as a genuine follow-up question — not a survey, and don't force it if the conversation is clearly headed somewhere else right now.\n`
                : "";
            // Text has no hang_up tool call to mark "this is the closing turn"
            // the way a live call does, so nothing ever told Co this reply might
            // BE the close — it would just keep asking another question forever,
            // or trail off with nothing when there was genuinely nothing left to
            // ask. ready_to_summarize (same signal Phase 2 uses on a call) is
            // the actual "we have enough" moment; only surface the option to
            // close when there's also nothing left missing, so this never fires
            // while a real gap is still open.
            const closingContext =
              coverage.ready_to_summarize && !coverage.missing_topics.length
                ? `\nYou likely have what you need from them now. If what they just said makes this feel like a natural close — not if it doesn't, don't force it — deliver a real closing turn: reference something specific and real from this conversation (not a generic "got it, thanks"), and be precise about what happens next, the same spirit as the end of a call: circle placement isn't instant, it happens in waves as the right people are ready; other things can move faster; never promise a specific date. Do not close on a question you haven't answered — if their last message asked you something directly, answer it first, even briefly, before any close.\n`
                : "";

            // Mirrors api/src/routes/sendblue.ts — advisory only, never named
            // back to the user, and not gated against the other context
            // strings above since it's an instruction about HOW to say
            // whatever Co was already going to say, not a competing ask.
            const toneContext = turnTone
              ? `\nThey sound ${turnTone} right now. Let that genuinely shape your tone and pacing, not just your words — don't be breezy, joke, or rush past it if it doesn't fit. Never name the emotion back at them like a label.\n`
              : "";

            // Advisory only, same as toneContext above — reading a shift the
            // person never actually asked you to notice, not a rule.
            const seekingModeContext =
              seekingMode === "solving"
                ? `\nThey've moved from sharing into wanting a real answer or help deciding — meet that directly. Give them your actual read, grounded in what you know about them, instead of another reflective question or a line that waits for them to ask first.\n`
                : "";

            // Step 6 — Decide + send Co's reply via the conversation-reply
            // agent (agent/conversationReply.ts). Replaces the old fixed
            // callOfferContext branching and the separate post-hoc
            // callOfferCheck verification call — the agent now decides
            // whether to fold in a call-offer gesture and records that
            // decision itself via a tool call (offerCall), rather than code
            // pre-deciding and a second LLM call inferring after the fact
            // whether the drafted text happened to include one.
            const { replyText } = await propagateAttributes(
              { userId: user.id, traceName: "co-test.webhooks.generateReply" },
              () =>
                runConversationReplyAgent({
                  userId: user.id,
                  phoneNumber: number,
                  firstName: user.first_name,
                  content,
                  hasPendingOffer,
                  recentOfferBurstActive,
                  callAction,
                  isThinProfileFirstMessage,
                  personaPrompt,
                  profileContext,
                  missingTopicsContext,
                  recentConversation,
                  isFirstContact,
                  recommendationContext,
                  venueContext,
                  callFeatureQuestionContext,
                  scheduleCallContext,
                  closingContext,
                  toneContext,
                  seekingModeContext,
                  styleHint,
                }),
            );
            cappedReply = replyText;
          }

          // Text-only conversations used to never build a co_profile at all —
          // only a call transcript ran through extraction, so choosing "text"
          // over the call offer above would otherwise be a dead end. Fire-and-
          // forget, the same real pipeline a call uses (extractPsychographicProfile
          // + storeProfile + captureIntent), fed the accumulated text thread
          // instead of a call transcript. Never blocks the reply already sent
          // above; a failure here just means this message didn't add anything
          // new to the profile.
          const textTranscript =
            `${recentConversation}\nuser: ${content}\nassistant: ${cappedReply}`.trim();
          extractPsychographicProfile(textTranscript)
            .then(({ extracted }) =>
              storeProfile(user.id, extracted, textTranscript),
            )
            .catch((err: any) =>
              console.error(
                "webhooks: text-based profile extraction failed (non-fatal):",
                err?.message ?? err,
              ),
            );
          captureIntent(user.id, textTranscript).catch((err: any) =>
            console.error(
              "webhooks: text-based intent capture failed (non-fatal):",
              err?.message ?? err,
            ),
          );

          // Already ack'd above (before the debounce wait) — cappedReply was
          // delivered via the sendblue.messages.send() calls above, not via
          // this HTTP response, so there's nothing left to send here.
          return;
        } catch (error) {
          // A path earlier in this function may have already ack'd the
          // webhook (see the res.status(200).send() before the debounce
          // wait) before an error occurred further down — calling next(error)
          // at that point would throw trying to set headers a second time.
          if (res.headersSent) {
            console.error("co-test sendblue webhook: error after early ack (non-fatal, response already sent):", error);
          } else {
            next(error);
          }
        }
      };
      await withPhoneLock(number, run);
    },
  );

  return router;
}
