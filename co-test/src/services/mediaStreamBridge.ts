import { HumeClient } from "hume";
import type WebSocket from "ws";
import pool from "../../../api/src/db/db.js";
import { buildContextSummary } from "./callContext.js";
import { decodeMulawBuffer, encodeMulawBuffer, parseWav, resampleLinear, toMono } from "./audioCodec.js";

// Replaces the simple server-to-server /v0/evi/twilio bridge — that endpoint
// only accepts config_id/api_key as query params (confirmed against Hume's
// docs), so first_name/context_summary passed alongside it were always
// silently dropped; dynamic variables can only be set via a session_settings
// message sent over a live WebSocket connection to Hume, which requires
// something to actually hold that connection. This is that something: Twilio
// streams raw call audio to us (see callTrigger.ts's <Connect><Stream>), we
// open our own EVI connection via the same SDK method co-test's browser call
// page already uses (client.ts), and relay audio both directions.
//
// Twilio Media Streams speaks mulaw/8000; Hume only accepts linear16 PCM and
// returns 48kHz WAV — audioCodec.ts handles both directions.
const TWILIO_SAMPLE_RATE = 8000;

// Twilio sends one media frame per ~20ms of audio, so this caps the
// pre-connection buffer (see the "media" case below) at roughly 1.5s —
// comfortably past the DB round-trip + Hume handshake in
// startHumeConnection, but still bounded so an unusually slow setup falls
// back to dropping instead of flushing a stale backlog.
const PENDING_AUDIO_FRAME_CAP = 75;

export function bridgeTwilioMediaStream(twilioWs: WebSocket): void {
  const hume = new HumeClient({ apiKey: process.env.HUME_API_KEY! });
  let streamSid: string | null = null;
  let humeSocket: ReturnType<typeof hume.empathicVoice.chat.connect> | null = null;
  let closed = false;
  // Frames Twilio sends before humeSocket is open — see PENDING_AUDIO_FRAME_CAP.
  const pendingAudio: Buffer[] = [];

  function sendMulawFrame(mulawBuf: Buffer) {
    const pcm = decodeMulawBuffer(mulawBuf);
    const pcmBuf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    humeSocket!.sendAudioInput({ data: pcmBuf.toString("base64") });
  }

  function safeCloseAll() {
    if (closed) return;
    closed = true;
    try {
      humeSocket?.close();
    } catch (err: any) {
      console.error("mediaStreamBridge: error closing Hume socket (non-fatal):", err?.message ?? err);
    }
    try {
      twilioWs.close();
    } catch (err: any) {
      console.error("mediaStreamBridge: error closing Twilio socket (non-fatal):", err?.message ?? err);
    }
  }

  async function startHumeConnection(userId: string) {
    const [userResult, contextSummary] = await Promise.all([
      pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]),
      buildContextSummary(userId),
    ]);
    const firstName = userResult.rows[0]?.first_name ?? "";

    humeSocket = hume.empathicVoice.chat.connect({
      configId: process.env.HUME_CONFIG_ID!,
      sessionSettings: {
        customSessionId: userId,
        audio: { encoding: "linear16", sampleRate: TWILIO_SAMPLE_RATE, channels: 1 },
        // The actual, documented mechanism for {{first_name}}/{{context_summary}}
        // in the prompt (see api/prompts/co-system-prompt.md) — unlike the old
        // /v0/evi/twilio query params, this one really reaches EVI.
        variables: { first_name: firstName, context_summary: contextSummary },
      },
    });

    humeSocket.on("message", (m: any) => {
      if (m.type === "audio_output") {
        if (!streamSid) return;
        try {
          const wavBuf = Buffer.from(m.data, "base64");
          const { sampleRate, channels, samples } = parseWav(wavBuf);
          const mono = toMono(samples, channels);
          const resampled = resampleLinear(mono, sampleRate, TWILIO_SAMPLE_RATE);
          const mulawBuf = encodeMulawBuffer(resampled);
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: mulawBuf.toString("base64") },
            }),
          );
        } catch (err: any) {
          console.error("mediaStreamBridge: failed to relay audio_output (non-fatal):", err?.message ?? err);
        }
      } else if (m.type === "error") {
        console.error("mediaStreamBridge: Hume reported an error:", m);
      }
      // chat_started/chat_ended/tool_call/user_message/assistant_message are
      // deliberately not handled here — those still arrive at /co/webhook the
      // same way they always have (webhooks are a config-level Hume feature,
      // independent of which client opened the audio connection), so the
      // existing extraction/tool-call pipeline in webhooks.ts is untouched.
    });

    humeSocket.on("open", () => {
      // Flush whatever Twilio sent while we were still doing the DB lookup
      // + Hume handshake above — see the "media" case's buffering comment.
      while (pendingAudio.length) {
        sendMulawFrame(pendingAudio.shift()!);
      }
    });
    humeSocket.on("error", (err: unknown) => {
      console.error("mediaStreamBridge: Hume socket error:", err);
    });
    humeSocket.on("close", () => safeCloseAll());
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
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? null;
        // user_id arrives as a <Parameter> (see callTrigger.ts) — Twilio
        // strips query strings from Stream URLs entirely, so this is the
        // only place it's actually reachable, confirmed live. Only ever
        // absent if something upstream is broken — /co/incoming-call rejects
        // an unrecognized caller before ever reaching this bridge, and
        // callTrigger.ts always sets it for outbound calls — so closing here
        // is a real signal something's wrong, not an expected path.
        const userId: string | undefined = msg.start?.customParameters?.user_id;
        if (!userId) {
          console.error("mediaStreamBridge: start event with no user_id in customParameters, closing");
          safeCloseAll();
          break;
        }
        startHumeConnection(userId).catch((err: any) => {
          console.error("mediaStreamBridge: failed to start Hume connection:", err?.message ?? err);
          safeCloseAll();
        });
        break;
      }

      case "media": {
        const mulawBuf = Buffer.from(msg.media.payload, "base64");
        if (!humeSocket || humeSocket.readyState !== 1 /* WebSocket.OPEN */) {
          // Buffer briefly instead of dropping outright, so the caller's
          // actual opening words reach Hume once the socket opens — capped
          // at PENDING_AUDIO_FRAME_CAP so an unusually slow setup still
          // falls back to dropping rather than flushing a stale backlog.
          if (pendingAudio.length < PENDING_AUDIO_FRAME_CAP) pendingAudio.push(mulawBuf);
          return;
        }
        sendMulawFrame(mulawBuf);
        break;
      }

      case "stop":
        safeCloseAll();
        break;
    }
  });

  twilioWs.on("close", () => safeCloseAll());
  twilioWs.on("error", (err: unknown) => {
    console.error("mediaStreamBridge: Twilio socket error:", err);
    safeCloseAll();
  });
}
