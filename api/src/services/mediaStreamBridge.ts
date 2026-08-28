import { HumeClient } from "hume";
import type WebSocket from "ws";
import pool from "../db/db.js";
import { buildContextSummary } from "./callContext.js";
import { decodeMulawBuffer, encodeMulawBuffer, parseWav, resampleLinear, toMono } from "./audioCodec.js";

// Replaces the simple server-to-server /v0/evi/twilio bridge — that endpoint
// only accepts config_id/api_key as query params (confirmed against Hume's
// docs), so first_name/context_summary passed alongside it were always
// silently dropped; dynamic variables can only be set via a session_settings
// message sent over a live WebSocket connection to Hume, which requires
// something to actually hold that connection. This is that something: Twilio
// streams raw call audio to us (see callTrigger.ts's <Connect><Stream>), we
// open our own EVI connection via the Hume SDK, and relay audio both
// directions.
//
// Twilio Media Streams speaks mulaw/8000; Hume only accepts linear16 PCM and
// returns 48kHz WAV — audioCodec.ts handles both directions.
const TWILIO_SAMPLE_RATE = 8000;

// Twilio sends one media frame per ~20ms of audio, so this caps both
// pre-connection buffers (caller audio waiting on Hume to open, and Co's own
// audio waiting on a Twilio stream to forward to — see prewarmHumeConnection)
// at roughly 1.5s each — comfortably past the DB round-trip + Hume handshake,
// but still bounded so an unusually slow setup falls back to dropping
// instead of flushing a stale backlog.
const PENDING_AUDIO_FRAME_CAP = 75;

// How long a pre-warmed Hume connection can sit unclaimed before it's closed
// — covers a call that never actually connects (busy/no-answer/failed/
// canceled outbound, or an abandoned inbound attempt). Comfortably past
// Twilio's own 20s outbound ring timeout (see callTrigger.ts's `timeout: 20`).
const PREWARM_CLAIM_TIMEOUT_MS = 30_000;

const hume = new HumeClient({ apiKey: process.env.HUME_API_KEY! });

type HumeSocket = ReturnType<typeof hume.empathicVoice.chat.connect>;

type HumeConnectionHandle = {
  userId: string;
  humeSocket: HumeSocket | null;
  closed: boolean;
  twilioWs: WebSocket | null;
  streamSid: string | null;
  // Caller audio (mulaw) arriving before humeSocket is open.
  pendingInbound: Buffer[];
  // Co's own audio (mulaw) arriving before a Twilio stream is attached to
  // forward it to — only a real path once prewarming lets Hume start
  // talking (its opening line) while the phone is still ringing.
  pendingOutbound: Buffer[];
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

// Pre-warmed connections, keyed by userId — see prewarmHumeConnection.
// Known limitation: two simultaneous calls to the same user would collide
// (the second prewarm is a no-op, the first's connection gets adopted by
// whichever stream starts first) — not worth solving given call volume.
const pendingConnections = new Map<string, HumeConnectionHandle>();

function forwardCallerAudio(handle: HumeConnectionHandle, mulawBuf: Buffer) {
  if (!handle.humeSocket || handle.humeSocket.readyState !== 1 /* WebSocket.OPEN */) {
    if (handle.pendingInbound.length < PENDING_AUDIO_FRAME_CAP) handle.pendingInbound.push(mulawBuf);
    return;
  }
  const pcm = decodeMulawBuffer(mulawBuf);
  const pcmBuf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  handle.humeSocket.sendAudioInput({ data: pcmBuf.toString("base64") });
}

function closeHandle(handle: HumeConnectionHandle) {
  if (handle.closed) return;
  handle.closed = true;
  if (handle.evictionTimer) clearTimeout(handle.evictionTimer);
  if (pendingConnections.get(handle.userId) === handle) pendingConnections.delete(handle.userId);
  try {
    handle.humeSocket?.close();
  } catch (err: any) {
    console.error("mediaStreamBridge: error closing Hume socket (non-fatal):", err?.message ?? err);
  }
  try {
    handle.twilioWs?.close();
  } catch (err: any) {
    console.error("mediaStreamBridge: error closing Twilio socket (non-fatal):", err?.message ?? err);
  }
}

// Opens the Hume EVI connection for a user and wires its audio/error/close
// handling immediately — independent of whether a Twilio call has actually
// connected yet. Called either early (prewarmHumeConnection, while the phone
// is still ringing / the inbound TwiML round-trip is happening) or, as a
// fallback, on-demand from bridgeTwilioMediaStream's "start" handler if no
// prewarmed connection was found for that user.
function createHumeConnection(userId: string): HumeConnectionHandle {
  const handle: HumeConnectionHandle = {
    userId,
    humeSocket: null,
    closed: false,
    twilioWs: null,
    streamSid: null,
    pendingInbound: [],
    pendingOutbound: [],
    evictionTimer: null,
  };

  (async () => {
    try {
      const [userResult, profileResult, contextSummary] = await Promise.all([
        pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]),
        pool.query(`SELECT hume_chat_group_id FROM co_profiles WHERE user_id = $1`, [userId]),
        buildContextSummary(userId),
      ]);
      if (handle.closed) return;
      const firstName = userResult.rows[0]?.first_name ?? "";
      const resumedChatGroupId: string | undefined = profileResult.rows[0]?.hume_chat_group_id ?? undefined;

      const humeSocket = hume.empathicVoice.chat.connect({
        configId: process.env.HUME_CONFIG_ID!,
        // Resumes the same Hume chat group across calls (persisted by
        // co.ts's chat_ended handler) so a returning caller's conversation
        // actually continues rather than starting cold every time — the old
        // native /v0/evi/twilio integration passed this as a query param
        // (resumed_chat_group_id); the bridge's chat.connect() takes it here.
        ...(resumedChatGroupId ? { resumedChatGroupId } : {}),
        sessionSettings: {
          customSessionId: userId,
          audio: { encoding: "linear16", sampleRate: TWILIO_SAMPLE_RATE, channels: 1 },
          // The actual, documented mechanism for {{first_name}}/{{context_summary}}
          // in the prompt — unlike the old /v0/evi/twilio query params, this
          // one really reaches EVI.
          variables: { first_name: firstName, context_summary: contextSummary },
        },
      });
      handle.humeSocket = humeSocket;

      humeSocket.on("message", (m: any) => {
        if (m.type === "audio_output") {
          try {
            const wavBuf = Buffer.from(m.data, "base64");
            const { sampleRate, channels, samples } = parseWav(wavBuf);
            const mono = toMono(samples, channels);
            const resampled = resampleLinear(mono, sampleRate, TWILIO_SAMPLE_RATE);
            const mulawBuf = encodeMulawBuffer(resampled);
            if (handle.twilioWs && handle.streamSid) {
              handle.twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid: handle.streamSid,
                  media: { payload: mulawBuf.toString("base64") },
                }),
              );
            } else if (handle.pendingOutbound.length < PENDING_AUDIO_FRAME_CAP) {
              // No Twilio stream attached yet — most likely Co's opening
              // line generating while the phone is still ringing (see
              // prewarmHumeConnection). Buffer it instead of dropping it so
              // it still plays once a stream attaches, same reasoning as
              // pendingInbound but for the reverse direction.
              handle.pendingOutbound.push(mulawBuf);
            }
          } catch (err: any) {
            console.error("mediaStreamBridge: failed to relay audio_output (non-fatal):", err?.message ?? err);
          }
        } else if (m.type === "error") {
          console.error("mediaStreamBridge: Hume reported an error:", m);
        }
        // chat_started/chat_ended/tool_call/user_message/assistant_message are
        // deliberately not handled here — those still arrive at /webhook the
        // same way they always have (webhooks are a config-level Hume feature,
        // independent of which client opened the audio connection), so the
        // existing extraction/tool-call pipeline in co.ts is untouched.
      });

      humeSocket.on("open", () => {
        while (handle.pendingInbound.length) {
          forwardCallerAudio(handle, handle.pendingInbound.shift()!);
        }
      });
      humeSocket.on("error", (err: unknown) => {
        console.error("mediaStreamBridge: Hume socket error:", err);
      });
      humeSocket.on("close", () => closeHandle(handle));
    } catch (err: any) {
      console.error("mediaStreamBridge: failed to open Hume connection:", err?.message ?? err);
      closeHandle(handle);
    }
  })();

  return handle;
}

// Called from callTrigger.ts (right after placing an outbound call) and
// co.ts's /incoming-call (right after resolving the caller) — as early as
// possible, so the DB lookup + Hume handshake happen during ring time
// instead of only starting after the person has already picked up. No-ops
// if a connection is already pending for this user.
export function prewarmHumeConnection(userId: string): void {
  if (pendingConnections.has(userId)) return;
  const handle = createHumeConnection(userId);
  handle.evictionTimer = setTimeout(() => closeHandle(handle), PREWARM_CLAIM_TIMEOUT_MS);
  pendingConnections.set(userId, handle);
}

export function bridgeTwilioMediaStream(twilioWs: WebSocket): void {
  let handle: HumeConnectionHandle | null = null;

  function attach(userId: string, streamSid: string) {
    const prewarmed = pendingConnections.get(userId);
    if (prewarmed && !prewarmed.closed) {
      pendingConnections.delete(userId);
      if (prewarmed.evictionTimer) clearTimeout(prewarmed.evictionTimer);
      handle = prewarmed;
    } else {
      // Fallback — no usable prewarmed connection found (shouldn't normally
      // happen since both call sites prewarm, but keeps this working on its
      // own if that's ever not the case).
      handle = createHumeConnection(userId);
    }
    handle.twilioWs = twilioWs;
    handle.streamSid = streamSid;
    while (handle.pendingOutbound.length) {
      const mulawBuf = handle.pendingOutbound.shift()!;
      twilioWs.send(
        JSON.stringify({ event: "media", streamSid, media: { payload: mulawBuf.toString("base64") } }),
      );
    }
  }

  twilioWs.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        const streamSid: string | null = msg.start?.streamSid ?? msg.streamSid ?? null;
        // user_id arrives as a <Parameter> (see callTrigger.ts) — Twilio
        // strips query strings from Stream URLs entirely, so this is the
        // only place it's actually reachable, confirmed live. Only ever
        // absent if something upstream is broken — /incoming-call rejects
        // an unrecognized caller before ever reaching this bridge, and
        // callTrigger.ts always sets it for outbound calls — so closing here
        // is a real signal something's wrong, not an expected path.
        const userId: string | undefined = msg.start?.customParameters?.user_id;
        if (!userId || !streamSid) {
          console.error("mediaStreamBridge: start event missing user_id or streamSid, closing");
          twilioWs.close();
          break;
        }
        attach(userId, streamSid);
        break;
      }

      case "media": {
        const mulawBuf = Buffer.from(msg.media.payload, "base64");
        if (!handle) return; // "start" hasn't arrived yet — shouldn't happen, Twilio always sends it first
        forwardCallerAudio(handle, mulawBuf);
        break;
      }

      case "stop":
        if (handle) closeHandle(handle);
        break;
    }
  });

  twilioWs.on("close", () => {
    if (handle) closeHandle(handle);
  });
  twilioWs.on("error", (err: unknown) => {
    console.error("mediaStreamBridge: Twilio socket error:", err);
    if (handle) closeHandle(handle);
  });
}
