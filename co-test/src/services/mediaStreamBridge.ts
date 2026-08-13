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

type BridgeContext = {
  userId: string;
};

export function bridgeTwilioMediaStream(twilioWs: WebSocket, ctx: BridgeContext): void {
  const hume = new HumeClient({ apiKey: process.env.HUME_API_KEY! });
  let streamSid: string | null = null;
  let humeSocket: ReturnType<typeof hume.empathicVoice.chat.connect> | null = null;
  let closed = false;

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

  async function startHumeConnection() {
    const [userResult, contextSummary] = await Promise.all([
      pool.query(`SELECT first_name FROM users WHERE id = $1`, [ctx.userId]),
      buildContextSummary(ctx.userId),
    ]);
    const firstName = userResult.rows[0]?.first_name ?? "";

    humeSocket = hume.empathicVoice.chat.connect({
      configId: process.env.HUME_CONFIG_ID!,
      sessionSettings: {
        customSessionId: ctx.userId,
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
      case "start":
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? null;
        startHumeConnection().catch((err: any) => {
          console.error("mediaStreamBridge: failed to start Hume connection:", err?.message ?? err);
          safeCloseAll();
        });
        break;

      case "media": {
        // Frames arriving in the brief window before Hume's socket opens are
        // dropped rather than buffered — at most a few hundred ms of the
        // very start of the call, an acceptable loss given the alternative
        // (unbounded buffering) risks a worse problem: a backlog that plays
        // back out of sync with the live conversation.
        if (!humeSocket || humeSocket.readyState !== 1 /* WebSocket.OPEN */) return;
        const mulawBuf = Buffer.from(msg.media.payload, "base64");
        const pcm = decodeMulawBuffer(mulawBuf);
        const pcmBuf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        humeSocket.sendAudioInput({ data: pcmBuf.toString("base64") });
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
