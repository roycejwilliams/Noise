import { randomInt } from "crypto";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import express, { Request, Response, NextFunction } from "express";
import type { Server } from "socket.io";
import pool from "../../../api/src/db/db.js";
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
  if (!toolCallMessage || toolCallMessage.name !== "assess_conversation_coverage") return;

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

      await pool.query(`UPDATE users SET call_status = 'completed' WHERE id = $1`, [user_id]);

      if (!transcript.trim()) {
        console.error(`webhooks: empty transcript for chat ${chat_id} (user ${user_id})`);
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

      // Best-effort follow-up text, same intent as production's — proves the
      // real iMessage round trip works post-call, not just the phone call.
      if (callUser) {
        try {
          const { text: followUpMessage } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `You are Co. You just got off a test call with ${callUser.first_name}. Here's what they said:\n\n"${transcript}"\n\nText them one short line proving you were listening — reference one specific real thing they said. Prefix nothing, this is a dev/test environment so keep it brief. 1 sentence, no exclamation points, no em dashes.`,
          });
          await sendblue.messages.send({
            number: callUser.phone_number,
            content: `[co-test] ${followUpMessage}`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (followUpErr: any) {
          console.error("Post-call follow-up text failed (non-fatal):", followUpErr?.message ?? followUpErr);
        }
      }

      return res.status(200).send({ success: true });
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
    try {
      const { number, content, is_outbound, type } = req.body;
      if (type === "typing" || is_outbound) return res.status(200).send({ received: true });

      const hasText = typeof content === "string" && content.trim().length > 0;
      if (!number || !hasText) return res.status(200).send({ received: true });

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

      // First inbound text — satisfies text-in-first, send the OTP as a reply.
      if (!user.contact_verified) {
        const otp = randomInt(100000, 1000000);
        await pool.query(
          `UPDATE users SET contact_verified = true, otp_code = $2, otp_expiry = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
          [user.id, otp],
        );
        try {
          await sendblue.messages.send({
            number,
            content: `[co-test] Thanks for texting in. This is CoPatible's dev/test environment, not production. Your verification code: ${otp}`,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          // Non-fatal, matching every other Sendblue send in this codebase — a
          // delivery failure must never surface as a 4xx/5xx to Sendblue's own
          // webhook (which would trigger a retry) or crash this request.
          // contact_verified/otp_code are already committed above; the tester
          // can use "Resend code" if this particular send didn't land.
          console.error(`Sendblue OTP send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
        }
        return res.status(200).send({ received: true, action: "contact_verified" });
      }

      // Already verified — ongoing conversational texting, proving the
      // "does texting with Co keep working after verification" half of item 2.
      const recentResult = await pool.query(
        `SELECT content FROM co_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 6`,
        [user.id],
      );
      const recent = recentResult.rows.map((r: any) => r.content).reverse().join("\n");

      await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
        [user.id, `User said: ${content}`],
      );

      const { text: reply } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        prompt: `You are Co, in CoPatible's dev/test environment (not production). Recent context:\n${recent || "(start of conversation)"}\n\n${user.first_name} just said: "${content}"\n\nReply briefly and warmly, like Co would. 1-2 sentences, no exclamation points, no em dashes.`,
      });

      await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'text_exchange', $2)`,
        [user.id, `Co replied: ${reply}`],
      );

      try {
        await sendblue.messages.send({
          number,
          content: `[co-test] ${reply}`,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        console.error(`Sendblue reply send failed for ${number} (non-fatal):`, smsErr?.message ?? smsErr);
      }

      return res.status(200).send({ received: true, reply });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
