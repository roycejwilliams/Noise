import { randomInt } from "crypto";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import express, { Request, Response, NextFunction } from "express";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { Server } from "socket.io";
import pool from "../../../api/src/db/db.js";
import { sendSMS } from "../../../api/src/otpActions.js";
import sendblue from "../../../api/src/services/sendblue.js";
import {
  assessConversationCoverage,
  captureIntent,
  extractPsychographicProfile,
  RAPPORT_TOPICS,
  storeProfile,
  storeTranscriptMemory,
} from "../../../api/src/services/profileExtraction.js";
import {
  endLiveCall,
  getLiveSnapshot,
  getTranscriptLinesSeen,
  pushLiveEvent,
  setTranscriptLinesSeen,
  startLiveCall,
  startPolling,
} from "../services/liveCallState.js";
import { generateRecommendation } from "../services/recommendation.js";
import { triggerCall } from "../services/callTrigger.js";
import { simulateModeratorApproval } from "../services/circlesSimulation.js";
import { getCoPersonaPrompt } from "../services/coPersona.js";
import { findRealVenues } from "../services/venueLookup.js";

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
    if (!res.ok) throw new Error(`Hume chat-events fetch failed: ${res.status}`);
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
    .map((e) => `${e.role === "USER" ? "user" : "assistant"}: ${e.message_text ?? ""}`)
    .join("\n");
}

function buildMessages(events: HumeChatEvent[]): { role: "user" | "assistant"; content: string; timestamp: string }[] {
  return events
    .filter((e) => (e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE") && e.message_text)
    .map((e) => ({
      role: e.role === "USER" ? "user" : ("assistant" as const),
      content: e.message_text!,
      timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString(),
    }));
}

// Turn-taking latency straight from Hume's own event timestamps (Part 2, item
// 6) — how long Co took to respond after each user turn, distinct from the
// coverage-tool round-trip latency we already time ourselves in
// handleToolCall below. Best-effort: if events are missing timestamps this
// just comes back empty rather than throwing — this is dashboard
// observability, never on the path that answers Hume.
function buildTurnLatencies(events: HumeChatEvent[]): { turn: number; latency_ms: number }[] {
  const turns = events.filter(
    (e) => (e.type === "USER_MESSAGE" || e.type === "AGENT_MESSAGE") && typeof e.timestamp === "number",
  );
  const out: { turn: number; latency_ms: number }[] = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role === "USER" && turns[i + 1].role !== "USER") {
      out.push({ turn: out.length + 1, latency_ms: turns[i + 1].timestamp! - turns[i].timestamp! });
    }
  }
  return out;
}

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

async function sendHumeToolResponse(chatId: string, toolCallId: string, content: string): Promise<void> {
  const res = await fetch(`https://api.hume.ai/v0/evi/chat/${chatId}/send`, {
    method: "POST",
    headers: { "X-Hume-Api-Key": process.env.HUME_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "tool_response", tool_call_id: toolCallId, content }),
  });
  if (!res.ok) {
    console.error(`webhooks: tool response POST failed (${res.status}) for chat ${chatId}, tool ${toolCallId}`);
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function capMessageLength(text: string, maxChars = TEXT_MESSAGE_CHAR_CAP): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const window = trimmed.slice(0, maxChars);
  const lastBoundary = findNaturalBoundary(window);
  if (lastBoundary > maxChars * 0.4) return window.slice(0, lastBoundary + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  return `${window.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}…`;
}

// Best-effort follow-up text, same intent as production's — proves the real
// iMessage round trip works post-call, not just the phone call. "1-2
// sentences" alone wasn't a real length constraint — the model packed
// multiple observations into those 1-2 sentences, and a duplicate chat_ended
// delivery (fixed by the call_status claim in the webhook handler) used to
// fire this three times in a row on top of that. Now: one detail, an
// explicit char budget in the prompt, and capMessageLength as a hard
// backstop. Failure here is deliberately swallowed — it must never affect
// call_status/retryability, since the recap (the actual result) is already
// persisted by the time this runs.
async function sendFollowUpText(
  callUser: { first_name: string; phone_number: string } | null,
  transcript: string,
): Promise<void> {
  if (!callUser) return;
  try {
    const followUpPersona = await getCoPersonaPrompt();
    const { text: followUpMessage } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      prompt: `${followUpPersona ?? "You are Co."} You just got off a call with ${callUser.first_name}. Here's what they told you:\n\n"${transcript}"\n\nText them something short that proves you were actually listening. Pick exactly ONE real, specific thing they said (a feeling, a struggle, a detail) and respond to only that — nothing else. No second observation, no forward-looking plan, no summary of the call.\n\nDo not say "I have what I need," "I'll be in touch," "your circle is ready/next," or anything that sounds like a status update. No exclamation points. No em dashes.\n\nThis is a text message, not the call — keep it short, one text-message-length turn. Under 160 characters.`,
    });
    const cappedFollowUp = capMessageLength(followUpMessage, 160);
    await sendblue.messages.send({
      number: callUser.phone_number,
      content: cappedFollowUp,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (followUpErr: any) {
    console.error("Post-call follow-up text failed (non-fatal):", followUpErr?.message ?? followUpErr);
  }
}

// When a genuinely long reply doesn't fit in one text, capMessageLength
// used to just cut it off with an ellipsis — silently losing whatever
// didn't fit. Real texting behavior is to send it as two messages instead
// of truncating, so this splits at the same kind of natural boundary and
// returns both parts (capped again if the remainder is itself still long,
// so this is at most one follow-up, not an open-ended chain).
function splitIntoMessages(text: string, maxChars = TEXT_MESSAGE_CHAR_CAP): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  const window = trimmed.slice(0, maxChars);
  const lastBoundary = findNaturalBoundary(window);
  const splitAt = lastBoundary > maxChars * 0.4 ? lastBoundary + 1 : (window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : maxChars);

  const first = trimmed.slice(0, splitAt).trim();
  const rest = trimmed.slice(splitAt).trim();
  if (!rest) return [first];
  return [first, capMessageLength(rest, maxChars)];
}

// Pushes any transcript lines not yet live-pushed for this user, given an
// already-fetched events array — pure, no network call, so both the
// periodic poller and handleToolCall/chat_ended (which already have events
// in hand) can call it without double-fetching Hume. Always called before
// any coverage-check event for the same tool_call, so a coverage result can
// never render ahead of the transcript line that triggered it (requirement 6).
function emitNewTranscriptLines(io: Server, userId: string, events: HumeChatEvent[]): void {
  const messages = buildMessages(events);
  const alreadySeen = getTranscriptLinesSeen(userId);
  if (messages.length <= alreadySeen) return;
  for (const message of messages.slice(alreadySeen)) {
    pushLiveEvent(io, userId, { type: "transcript", message });
  }
  setTranscriptLinesSeen(userId, messages.length);
}

async function pollAndEmitTranscript(io: Server, userId: string, chatId: string): Promise<void> {
  try {
    const events = await fetchHumeChatEvents(chatId);
    emitNewTranscriptLines(io, userId, events);
  } catch (err: any) {
    console.error(`webhooks: live transcript poll failed for chat ${chatId} (non-fatal):`, err?.message ?? err);
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
        : { available: false as const, reason: "no user resolved for this call" };
      await sendHumeToolResponse(chatId, toolCallMessage.tool_call_id, JSON.stringify(result));
    } catch (err: any) {
      console.error("webhooks: surface_recommendation failed:", err?.message ?? err);
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
      .query(`UPDATE users SET smoke_test_tool_call_at = NOW() WHERE id = $1`, [userId])
      .catch((err) => console.error("smoke_test_tool_call_at update failed (non-fatal):", err));
  }

  try {
    const events = await fetchHumeChatEvents(chatId);
    // Flush any transcript lines that led up to this tool call FIRST, so the
    // browser never sees the coverage result before the lines that caused it.
    if (userId) emitNewTranscriptLines(io, userId, events);

    const transcript = buildTranscript(events);
    const start = Date.now();
    const assessment = await assessConversationCoverage(transcript);
    const latency_ms = Date.now() - start;
    await sendHumeToolResponse(chatId, toolCallMessage.tool_call_id, JSON.stringify(assessment));

    if (userId) {
      pool
        .query(`UPDATE users SET smoke_test_tool_response_at = NOW() WHERE id = $1`, [userId])
        .catch((err) => console.error("smoke_test_tool_response_at update failed (non-fatal):", err));
    }

    const covered_topics = RAPPORT_TOPICS.filter((t) => !assessment.missing_topics.includes(t));
    if (userId) {
      const priorChecks = getLiveSnapshot(userId).events.filter((e) => e.type === "coverage").length;
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
    console.error("webhooks: assess_conversation_coverage failed, falling back to nothing-covered:", err?.message ?? err);
    await sendHumeToolResponse(
      chatId,
      toolCallMessage.tool_call_id,
      JSON.stringify({ missing_topics: [...RAPPORT_TOPICS], ready_to_summarize: false }),
    ).catch(() => {});
  }
}

export function createWebhooksRouter(io: Server): express.Router {
  const router = express.Router();

  // POST /co/call-status — Twilio status callback for the real-call trigger in
  // phone.ts. Simplified relative to production's version (api/src/routes/co.ts):
  // tracks ringing/answered/completed state on the user row for the phone-test
  // page to poll; does not implement the AMD/voicemail-redirect handling
  // production has, since that's a delivery-quality concern, not part of
  // proving the call/webhook mechanism out.
  router.post("/co/call-status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { CallStatus, To, CallSid } = req.body;
      if (!CallStatus || !To) return res.sendStatus(204);

      await pool.query(
        `UPDATE users SET call_status = $2 WHERE phone_number = $1 AND call_sid = $3`,
        [To, CallStatus, CallSid],
      );
      return res.sendStatus(204);
    } catch (error) {
      next(error);
    }
  });

  // POST /co/webhook — Hume calls this for chat_started/chat_ended/tool_call,
  // same three events production's config registers. Only reachable for
  // co-test's OWN chats once the dev Hume config's webhook is repointed here
  // (see server.ts / the one-time repoint noted in phone.ts task notes) —
  // production's separate Hume config and its webhook are never touched.
  router.post("/co/webhook", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { event_name, custom_session_id, chat_id, twilio_metadata, tool_call_message } = req.body;

      const resolveUserId = async (): Promise<string | null> => {
        if (custom_session_id) return custom_session_id;
        if (twilio_metadata?.to_number) {
          const byPhone = await pool.query(`SELECT id FROM users WHERE phone_number = $1`, [twilio_metadata.to_number]);
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
              console.error("webhooks: transcript poll error (non-fatal):", err?.message ?? err),
            );
          });
        }
        return;
      }

      if (event_name === "tool_call") {
        res.status(200).send({ success: true });
        const userId = await resolveUserId();
        handleToolCall(io, chat_id, userId, tool_call_message).catch((err) =>
          console.error("webhooks: unhandled tool_call error:", err?.message ?? err),
        );
        return;
      }

      if (event_name !== "chat_ended") {
        return res.status(200).send({ success: true, ignored: event_name });
      }

      const user_id = await resolveUserId();
      if (!user_id || !chat_id) {
        console.error(`webhooks: could not resolve user for chat ${chat_id} — body: ${JSON.stringify(req.body)}`);
        return res.status(400).send("Missing required fields.");
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
        console.log(`webhooks: chat_ended already processed for user ${user_id} (chat ${chat_id}) — ignoring duplicate delivery`);
        return res.status(200).send({ success: true, duplicate: true });
      }

      try {
        const callUserResult = await pool.query(`SELECT first_name, phone_number FROM users WHERE id = $1`, [user_id]);
        const callUser = callUserResult.rows[0] ?? null;

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
          console.error(`webhooks: empty transcript for chat ${chat_id} (user ${user_id})`);
          // Not a hard failure, but there's no recap to show either — reset
          // so a later delivery with a fully-synced transcript can retry,
          // same as the catch block below.
          await pool.query(`UPDATE users SET call_status = 'failed' WHERE id = $1`, [user_id]);
          return res.status(200).send({ success: true, empty: true });
        }

        await storeTranscriptMemory(user_id, transcript, { audioUrl: recording_url });
        const { raw, extracted } = await extractPsychographicProfile(transcript);
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
        await pool.query(`UPDATE users SET call_status = 'completed' WHERE id = $1`, [user_id]);

        await sendFollowUpText(callUser, transcript);
        return res.status(200).send({ success: true });
      } catch (pipelineErr) {
        await pool.query(`UPDATE users SET call_status = 'failed' WHERE id = $1`, [user_id]);
        throw pipelineErr;
      }
    } catch (error) {
      next(error);
    }
  });

  // POST /sendblue/webhook — real text-in-first + OTP flow (Part 1, item 2),
  // mirroring the contact_verified gate in api/src/routes/sendblue.ts. Kept
  // deliberately smaller than production's: text-only (no voice-memo
  // transcription or image vision — this is proving the verification sequence
  // and the ongoing-chat channel out, not re-implementing every media type),
  // and no moment/circle response handling (co-test has neither).
  router.post("/sendblue/webhook", async (req: Request, res: Response, next: NextFunction) => {
    const { number, content, is_outbound, type } = req.body;
    if (type === "typing" || is_outbound) return res.status(200).send({ received: true });

    const hasText = typeof content === "string" && content.trim().length > 0;
    if (!number || !hasText) return res.status(200).send({ received: true });

    // A malformed inbound `number` (confirmed: Sendblue can deliver one,
    // e.g. a bare 5-digit value) was flowing straight through to a real,
    // billed sendSMS call via the session-claim branch below — nothing on
    // this path validated shape before either claiming a session or
    // sending. Reject before either happens.
    if (!parsePhoneNumberFromString(number, "US")?.isValid()) {
      console.error(`co-test sendblue webhook: malformed inbound number "${number}" — ignoring`);
      return res.status(200).send({ received: true });
    }

    const run = async () => {
    try {
      const userResult = await pool.query(
        `SELECT id, first_name, contact_verified FROM users WHERE phone_number = $1 AND test_channel = 'phone'`,
        [number],
      );
      let user = userResult.rows[0];

      // Not a number we already know — claim the most recent still-anonymous
      // session (see phone.ts's /session route: the entry screen is a single
      // "Message Co to start" button, so no phone number was collected up
      // front). Attaches the real number here, on first contact. Assumes one
      // tester at a time; see phone_pending's migration comment.
      if (!user) {
        const pending = await pool.query(
          `SELECT id, first_name FROM users
           WHERE test_channel = 'phone' AND phone_pending = true
           ORDER BY created_at DESC LIMIT 1`,
        );
        if (pending.rows[0]) {
          await pool.query(
            `UPDATE users SET phone_number = $2, phone_pending = false WHERE id = $1`,
            [pending.rows[0].id, number],
          );
          user = { ...pending.rows[0], contact_verified: false };
        }
      }

      if (!user) {
        console.log(`co-test sendblue webhook: no phone-test session for ${number} — ignoring`);
        return res.status(200).send({ received: true });
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
        console.log(`co-test sendblue webhook: duplicate message from user ${user.id} within 60s, skipping reprocessing`);
        return res.status(200).send({ received: true, duplicate: true });
      }

      // First inbound text — satisfies text-in-first. Same three-message
      // onboarding production's self-serve registration sends (see
      // api/src/routes/sendblue.ts's contact_verified branch) — welcome,
      // then what CoPatible is (with the vCard, if CO_VCARD_URL is set),
      // then the code — reusing sendSMS directly rather than a flat custom
      // string, so this is genuinely Co's voice/copy, not a placeholder.
      // sendSMS catches its own errors internally (never throws), matching
      // every other Sendblue send in this codebase: a delivery failure must
      // never surface as a 4xx/5xx to Sendblue's own webhook or crash this
      // request.
      if (!user.contact_verified) {
        const otp = randomInt(100000, 1000000);
        await pool.query(
          `UPDATE users SET contact_verified = true, otp_code = $2, otp_expiry = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
          [user.id, otp],
        );
        // Paced, not fired all at once — three back-to-back sends with no
        // gap arrive as a stacked wall of texts on the recipient's end even
        // though each individual message is legitimate content.
        await sendSMS({ phone_number: number, welcome: true });
        await pause(2500);
        await sendSMS({ phone_number: number, intro: true });
        await pause(2500);
        await sendSMS({ phone_number: number, otp_code: otp.toString(), register: true });
        return res.status(200).send({ received: true, action: "contact_verified" });
      }

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
          prompt: `Classify this message as either 'approve' or 'reject'. Return ONLY the word approve or reject.\n\nMessage: "${content}"`,
        });
        const modAction = modClassification.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

        if (modAction === "approve" || modAction === "reject") {
          const result = pendingCircleApproval.rows[0]
            ? await simulateModeratorApproval(
                { type: "circle", circleId: pendingCircleApproval.rows[0].id },
                modAction,
              )
            : await simulateModeratorApproval(
                { type: "venue", momentId: pendingVenueApproval.rows[0].id },
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
            console.error(`Moderator ack send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
          }
          return res.status(200).send({ received: true, action: `moderator_${modAction}` });
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
      const [profileResult, recentTextResult, priorActivityResult] = await Promise.all([
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
        // Determines whether to ask the call-or-text question below — must
        // be read before this message's own "User said" row is inserted,
        // so it reflects state as of BEFORE this message, not including it.
        pool.query(
          `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type IN ('text_exchange', 'call_transcript') LIMIT 1`,
          [user.id],
        ),
      ]);

      const profile = profileResult.rows[0] ?? null;
      const hasProfile = !!profile?.life_chapters?.length;
      const isFirstContact = !priorActivityResult.rows[0];
      const latestIntent = Array.isArray(profile?.intent) && profile.intent.length
        ? profile.intent[profile.intent.length - 1]
        : null;

      const profileContext = profile
        ? [
            profile.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
            profile.city ? `City: ${profile.city}` : null,
            profile.goals?.length ? `Goals: ${profile.goals.join("; ")}` : null,
            profile.blockers?.length ? `Blockers: ${profile.blockers.join("; ")}` : null,
            profile.availability_pattern ? `Availability: ${profile.availability_pattern}` : null,
            profile.emotional_state ? `Emotional state as of the last call: ${profile.emotional_state}` : null,
            latestIntent?.text ? `Stated ask (${latestIntent.type}): ${latestIntent.text}` : null,
            latestIntent?.concrete_preferences?.length
              ? `Concrete preferences: ${latestIntent.concrete_preferences.join(", ")}`
              : null,
            latestIntent?.wants?.length ? `Things they want or miss: ${latestIntent.wants.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : null;

      const recentConversation = recentTextResult.rows.map((r: any) => r.content).reverse().join("\n");

      await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
        [user.id, `User said: ${content}`],
      );

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
        console.error(`Typing indicator failed for ${number} (non-fatal):`, typingErr?.message ?? typingErr);
      }

      // Call-trigger detection — reuses the same Twilio-dial-and-bridge
      // mechanism phone.ts's dashboard call button uses (services/callTrigger.ts),
      // just reached from a different trigger. Two cases, per explicit
      // product decision: an explicit ask ("call me") triggers immediately;
      // anything that only SIGNALS voice would help gets OFFERED, and
      // actually placing that call requires a following "yes" — never
      // silently placed. Gated on contact_verified only (already true here)
      // — otp_verified stays a dashboard-flow-only gate, unrelated to
      // identity over this channel. The "User said" row above is already
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
      const pendingOfferResult = await pool.query(
        `SELECT p.id FROM co_memories p
         WHERE p.user_id = $1 AND p.memory_type = 'call_offer_pending'
         AND NOT EXISTS (
           SELECT 1 FROM co_memories r
           WHERE r.user_id = $1 AND r.memory_type = 'call_offer_resolved' AND r.created_at > p.created_at
         )
         ORDER BY p.created_at DESC LIMIT 1`,
        [user.id],
      );
      const hasPendingOffer = !!pendingOfferResult.rows[0];

      const { text: rawCallClassification } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        prompt: `A user is texting Co, a life concierge.${hasPendingOffer ? " Co just offered them a phone call and is waiting for a yes or no." : ""}

Their message: "${content}"

Classify as ONE of:
- "explicit_request" — they are directly asking Co to call them, or asking to talk by phone
${hasPendingOffer ? '- "accepts_offer" — they are saying yes to the call Co just offered\n- "declines_offer" — they are saying no to the call Co just offered\n' : ""}- "would_benefit" — none of the above, but what they're describing is complex, emotional, or hard to unpack over short texts, and voice would genuinely help
- "none" — normal conversation, no call is relevant

Return ONLY the classification, nothing else.`,
      });
      const callAction = rawCallClassification.trim().toLowerCase().replace(/^[`"']+|[`"']+$/g, "");

      if (hasPendingOffer && (callAction === "accepts_offer" || callAction === "declines_offer")) {
        // Bookkeeping write — must never be able to take down the whole
        // reply. Confirmed the hard way: this and the call_offer_pending
        // insert below were unguarded, the memory_type CHECK constraint
        // hadn't been widened for these new values yet, and the resulting
        // exception aborted the request before any reply was generated —
        // Sendblue kept retrying into the same crash, so the user got no
        // reply at all rather than a slow one.
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_resolved', $2)`,
          [user.id, callAction],
        ).catch((err: any) => console.error("webhooks: call_offer_resolved memory write failed (non-fatal):", err?.message ?? err));
      }

      // Cooldown — nothing previously throttled how often a call could be
      // offered, and a real conversation showed it firing repeatedly within
      // minutes, including once directly in response to "Why is it always
      // a phone call?" (a complaint about the pattern itself, misread as
      // more evidence a call would help). Not a permanent "never ask again"
      // — that's not what was asked for either — just a minimum real gap
      // between offers regardless of how many messages qualify in between.
      const recentOfferCountResult = await pool.query(
        `SELECT count(*) FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_pending' AND created_at > NOW() - INTERVAL '10 minutes'`,
        [user.id],
      );
      const recentOfferCooldownActive = parseInt(recentOfferCountResult.rows[0].count, 10) > 0;

      const shouldTriggerCall = callAction === "explicit_request" || (hasPendingOffer && callAction === "accepts_offer");
      // Folded into the main reply below now, not a separate message that
      // replaces one — a real conversation showed this short-circuiting the
      // reply entirely, so "want to hop on a call?" was the ENTIRE response
      // to something significant, with no acknowledgment of what was
      // actually said. The offer is secondary now; genuinely responding
      // (reflecting, surfacing a real recommendation/venue if one exists)
      // is the priority, per explicit product decision.
      const shouldOfferCall = !hasPendingOffer && !recentOfferCooldownActive && callAction === "would_benefit";
      const callOfferContext = shouldOfferCall
        ? `\nWhat they just shared could genuinely benefit from a real conversation by voice — but that is not the priority. First, actually respond to what they said: reflect it, and if you have something concrete to offer below (a real recommendation or a real place you found), lead with that instead of a call. Only if it still feels right after that, offer a call as a warm gesture, not a logistics question — the way someone says "I'm here if you ever want to actually talk this through," not "are you free for a call today or tomorrow." Keep it brief and secondary, never in place of a real response. Do not place any call, just make the gesture.`
        : "";

      if (shouldTriggerCall) {
        const callResult = await triggerCall(user.id);
        if (callResult.success) {
          const confirmation = "Calling you now.";
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
            console.error(`Sendblue call-confirmation send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
          }
          return res.status(200).send({ received: true, action: "call_triggered", call_sid: callResult.call_sid });
        }
        console.error(`webhooks: call trigger failed for user ${user.id} (non-fatal, falling through to normal reply):`, callResult.error);
        // Falls through to the normal reply flow below on failure — a
        // failed dial attempt should never leave the conversation silent.
      }

      // First real exchange, nothing on file yet (no call ever happened, no
      // profile built from text yet either) — ask up front rather than
      // silently defaulting to one channel. Skipped if this message already
      // triggered/offered a call above (callAction !== "none"), since that
      // already resolves the question. Text isn't a lesser fallback here:
      // choosing it actually builds the profile too, see the fire-and-forget
      // extraction at the end of this handler below.
      if (!hasProfile && isFirstContact && callAction === "none") {
        const askMessage =
          "Want to hop on a quick call, or keep going by text? Either way works, just want to actually get to know you.";
        const capped = capMessageLength(askMessage, 160);
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
          [user.id, `Co replied: ${capped}`],
        );
        try {
          await sendblue.messages.send({
            number,
            content: capped,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error(`Sendblue channel-preference-ask send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
        }
        return res.status(200).send({ received: true, action: "channel_preference_asked" });
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
        const { text: wantsClassification } = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          prompt: `Classify this message as either "wants_something_concrete" or "normal_conversation".

"wants_something_concrete" means they're asking Co to actually suggest, recommend, help find, or surface something specific right now (e.g. "what can you surface for me", "find me something", "what should I do about this").
"normal_conversation" means anything else — small talk, questions about Co, answering a question, general chat.

Message: "${content}"

Return ONLY the classification, nothing else.`,
        });
        const wantsSomethingConcrete = wantsClassification
          .trim()
          .toLowerCase()
          .replace(/^[`"']+|[`"']+$/g, "")
          .includes("wants_something_concrete");

        if (wantsSomethingConcrete) {
          const recommendation = await generateRecommendation(user.id, content);
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
        console.error("webhooks: recommendation classification failed (non-fatal):", err?.message ?? err);
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
          const { text: rawVenueClassification } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `Recent text conversation, in order:
${recentConversation || "(start of the conversation)"}

Their latest message: "${content}"

In light of the conversation above, is their latest message wanting, looking for, or asking about a specific CATEGORY of physical place — a gym, a cafe, a climbing spot, a coworking space, a restaurant, a bar, etc.? This includes a plain follow-up like "send me some" or "yes please" if the category was already established earlier in the conversation. Not a person, not an abstract idea, an actual type of place someone could visit.

If yes, how many did they ask for? Default to 1 if they didn't say a number or range; if they gave a range (e.g. "2-5"), use the upper end, capped at 5.

Return ONLY valid JSON, no preamble: {"wants_venue": true or false, "venue_type": "the category, in a few words" or null, "count": a number from 1 to 5}`,
          });
          const cleanVenue = rawVenueClassification.replace(/```json|```/g, "").trim();
          const parsedVenue = JSON.parse(cleanVenue);
          if (parsedVenue?.wants_venue && typeof parsedVenue.venue_type === "string" && parsedVenue.venue_type) {
            const venueType: string = parsedVenue.venue_type;
            const requestedCount = Math.max(1, Math.min(Number(parsedVenue.count) || 1, 5));

            // The real Places search below has genuine network latency on
            // top of the classification calls already run this turn — a
            // real conversation showed Co claiming "sending that now" with
            // no link actually in the message, because the search hadn't
            // even happened yet when that reply was written. Send a real,
            // personalized acknowledgment now, before the search, then
            // deliver the actual result as the reply below — never claim
            // delivery before there's something real to deliver.
            try {
              const { text: rawHold } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                prompt: `You are Co, texting someone. They just asked about finding ${requestedCount > 1 ? `${requestedCount} ${venueType}s` : `a ${venueType}`}. You're about to go actually look them up for them — send a brief, warm, personalized "give me a sec" acknowledgment, referencing what they're actually looking for, not generic. Don't claim you've found anything yet. One short sentence. No exclamation points, no em dashes. Under 100 characters.`,
              });
              const holdMessage = capMessageLength(rawHold, 100);
              await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
                [user.id, `Co replied: ${holdMessage}`],
              );
              try {
                await sendblue.messages.send({ number, content: holdMessage, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
              } catch (smsErr: any) {
                console.error(`Sendblue venue-lookup hold message failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
              }
            } catch (err: any) {
              console.error("webhooks: venue hold-message generation failed (non-fatal, proceeding to search anyway):", err?.message ?? err);
            }

            const venues = await findRealVenues(venueType, profile.city, requestedCount);
            if (venues.length) {
              // Sent as its own dedicated, complete message instead of
              // folded into the general reply — a real conversation showed
              // a multi-venue list getting mangled by the generic char-cap
              // split (a name separated from its own link, later venues
              // silently dropped past the cutoff). A list of real, named
              // things needs the room to actually say all of them, not a
              // fight against an SMS-length budget meant for small talk.
              try {
                const { text: rawIntro } = await generateText({
                  model: anthropic("claude-haiku-4-5-20251001"),
                  prompt: `You are Co, texting someone. You just found ${venues.length} real ${venueType}${venues.length > 1 ? "s" : ""} for them${venues.length < requestedCount ? ` — they asked for ${requestedCount}, this is genuinely all that came back as a solid match, say so honestly` : ""}. Write ONE short, warm intro sentence to go right before a list (the list itself follows separately after your sentence — do not write the list yourself, do not include any links). No exclamation points, no em dashes. Under 150 characters.`,
                });
                const introLine = capMessageLength(rawIntro, 150);
                const listBlock = venues.map((v) => `${v.name} — ${v.mapsUrl}`).join("\n\n");
                venueDeliveryMessage = `${introLine}\n\n${listBlock}`;
              } catch (err: any) {
                console.error("webhooks: venue delivery intro generation failed (non-fatal, sending list plainly):", err?.message ?? err);
                venueDeliveryMessage = venues.map((v) => `${v.name} — ${v.mapsUrl}`).join("\n\n");
              }
              await pool
                .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recommendation', $2)`, [
                  user.id,
                  `Co surfaced ${venues.length} real venue(s) — ${venues.map((v) => `${v.name} (${v.address}): ${v.mapsUrl}`).join("; ")}`,
                ])
                .catch((err: any) => console.error("webhooks: venue memory write failed (non-fatal):", err?.message ?? err));
            } else {
              // Must not repeat the "claimed to deliver, delivered nothing"
              // failure — if the search genuinely came up empty, the reply
              // has to say so honestly, not go quiet or invent a name.
              venueContext = `\nYou looked for a real ${venueType} but didn't find a solid match nearby. Say so honestly in your reply — don't invent a name or pretend you found one.`;
            }
          }
        } catch (err: any) {
          console.error("webhooks: venue lookup classification failed (non-fatal):", err?.message ?? err);
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
          await sendblue.messages.send({ number, content: venueDeliveryMessage, from_number: process.env.SENDBLUE_PHONE_NUMBER! });
        } catch (smsErr: any) {
          console.error(`Sendblue venue delivery send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
        }
      } else {
        // Same persona the real call uses, not a separate thinner one — Co
        // should be the same entity whether someone's talking by voice or
        // text, capable of picking up a genuine back-and-forth either way.
        // The anti-fabrication grounding rule and the text-length cap below
        // are additions specific to this channel, layered on top, not a
        // replacement for anything in the real prompt.
        const personaPrompt = await getCoPersonaPrompt();

        const { text: reply } = await generateText({
          model: anthropic("claude-haiku-4-5-20251001"),
          prompt: `${personaPrompt ?? "You are Co, an exclusive life concierge."}

You are having this specific exchange over text message, not a phone call — the phase structure and pacing above describe a live call; over text, just be genuinely Co: the same listening style, the same voice, the same principles, picking up wherever this conversation actually is.

What you already know about ${user.first_name} from a prior call:
${profileContext || "(nothing on file yet from a call — this is effectively a first conversation)"}

Recent text conversation, in order:
${recentConversation || "(start of the text conversation)"}

${user.first_name} just said: "${content}"
${recommendationContext}${venueContext}${callOfferContext}
Ground everything ONLY in the information above and what has actually been said in this conversation — never state or imply a specific personal detail, preference, or fact about them that isn't listed above or wasn't actually said in this thread. This includes real venues and businesses: never name a specific one unless it's given to you above as something you actually found — if you don't have a real one, describe what you'd look for, don't guess a plausible-sounding name. If you don't have something, ask rather than assume.

Keep THIS reply short — one text-message-length turn, not a call-length response. A sentence or two. No exclamation points, no em dashes. This is a text message, not a paragraph — but if you're relaying a real find (a name, a reason, a link), give it the room it actually needs rather than cutting it short.`,
        });
        // A genuinely long reply gets sent as two natural texts (a real
        // pause between them) instead of being hard-truncated and silently
        // losing whatever didn't fit — see splitIntoMessages.
        const replyParts = splitIntoMessages(reply);
        cappedReply = replyParts.join(" ");

        for (let i = 0; i < replyParts.length; i++) {
          const part = replyParts[i];
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
            [user.id, `Co replied: ${part}`],
          );
          try {
            await sendblue.messages.send({
              number,
              content: part,
              from_number: process.env.SENDBLUE_PHONE_NUMBER!,
            });
          } catch (smsErr: any) {
            console.error(`Sendblue reply send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
          }
          if (i < replyParts.length - 1) await pause(2000);
        }
      }

      // Records that an offer went out (folded into the reply above, not a
      // separate message) so a later "yes"/"no" is still correctly read as
      // answering it, and so the cooldown above has something to count.
      // Must confirm the reply actually contains an offer before recording
      // one — asking the model to include it isn't a guarantee it did.
      // Found the hard way: a reply that was just a clarifying question,
      // with no mention of a call anywhere, still got recorded as a pending
      // offer because shouldOfferCall had been true going in — the system
      // then thought it had offered something the user was never shown.
      if (shouldOfferCall) {
        try {
          const { text: rawOfferCheck } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `Does this text message actually offer, invite, or gesture toward a phone call — in any wording, even indirectly (e.g. "I'm here if you want to talk this through")? Not just related to talking or listening in general — specifically about a phone call.

Message: "${cappedReply}"

Return ONLY "yes" or "no".`,
          });
          const actuallyOffered = rawOfferCheck.trim().toLowerCase().startsWith("yes");
          if (actuallyOffered) {
            await pool
              .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
                user.id,
                cappedReply,
              ])
              .catch((err: any) => console.error("webhooks: call_offer_pending memory write failed (non-fatal):", err?.message ?? err));
          }
        } catch (err: any) {
          console.error("webhooks: call-offer verification failed (non-fatal, not recording a pending offer):", err?.message ?? err);
        }
      }

      // Text-only conversations used to never build a co_profile at all —
      // only a call transcript ran through extraction, so choosing "text"
      // over the call offer above would otherwise be a dead end. Fire-and-
      // forget, the same real pipeline a call uses (extractPsychographicProfile
      // + storeProfile + captureIntent), fed the accumulated text thread
      // instead of a call transcript. Never blocks the reply already sent
      // above; a failure here just means this message didn't add anything
      // new to the profile.
      const textTranscript = `${recentConversation}\nuser: ${content}\nassistant: ${cappedReply}`.trim();
      extractPsychographicProfile(textTranscript)
        .then(({ extracted }) => storeProfile(user.id, extracted, textTranscript))
        .catch((err: any) => console.error("webhooks: text-based profile extraction failed (non-fatal):", err?.message ?? err));
      captureIntent(user.id, textTranscript).catch((err: any) =>
        console.error("webhooks: text-based intent capture failed (non-fatal):", err?.message ?? err),
      );

      return res.status(200).send({ received: true, reply: cappedReply });
    } catch (error) {
      next(error);
    }
    };
    await withPhoneLock(number, run);
  });

  return router;
}
