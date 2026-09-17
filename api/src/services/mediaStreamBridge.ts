import { randomBytes } from "crypto";
import { HumeClient } from "hume";
import type WebSocket from "ws";
import pool from "../db/db.js";
import { buildContextSummary } from "./callContext.js";
import { decodeMulawBuffer, encodeMulawBuffer, parseWav, resampleLinear, toMono } from "./audioCodec.js";
import { isRealUserUtterance } from "../harness/callGate.js";

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
  callSid: string | null;
  // Set true only once the caller has actually responded to Co with
  // something real — not the moment Hume transcribes ANY audio. Fixed
  // 2026-09-17: this used to flip true on the very first "user_message"
  // event, which included a transcribed voicemail greeting ("you've reached
  // ... leave a message"). That made voicemail detection effectively a
  // no-op — Co kept talking into the voicemail box, and the greeting itself
  // got treated as a real person turn in the profile. Now it only flips once
  // Co has said something (coHasSpoken) AND the caller's own words aren't a
  // greeting/carrier-message/bare filler (isRealUserUtterance, shared with
  // callGate.ts's post-call version of the same test).
  receivedUserMessage: boolean;
  // True once any audio_output has actually gone out on this call — the
  // signal that Co has started talking, which receivedUserMessage needs
  // before it will count the caller's reply as real (see above).
  coHasSpoken: boolean;
  // Caller audio (mulaw) arriving before humeSocket is open.
  pendingInbound: Buffer[];
  // Co's own audio (mulaw) arriving before a Twilio stream is attached to
  // forward it to — only a real path once prewarming lets Hume start
  // talking (its opening line) while the phone is still ringing.
  pendingOutbound: Buffer[];
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

// Pre-warmed connections, keyed by Twilio's CallSid — not userId. Fixed
// 2026-09-07 (Royce, "would that affect the concurrent calls?" — confirmed
// live via code trace): keying by bare userId meant two overlapping calls to
// the same person collided — the second prewarm was a no-op, and whichever
// Twilio stream attached first adopted the wrong call's Hume session,
// regardless of which physical call it actually belonged to. Both call sites
// (callTrigger.ts, co.ts's /incoming-call) already have a real CallSid before
// they ever call prewarmHumeConnection, so keying on it instead makes two
// concurrent calls to the same user get two independent, correctly-attached
// connections.
const pendingConnections = new Map<string, HumeConnectionHandle>();

// Live (already-claimed) connections, keyed by Twilio's CallSid — separate
// from pendingConnections above, which only covers the pre-warm window and
// is deleted once a stream attaches. Real bug found live, 2026-09-07: Royce
// answered a real call and said "hello," but Twilio's async AMD still came
// back "machine" (a known real false-positive risk — short greetings can
// fool it), and co.ts's AMD handler had no way to know a live human had
// already spoken, so it cut the call to a canned voicemail line anyway.
// hasReceivedRealSpeech lets that handler check Hume's own ground truth
// before trusting AMD's verdict.
const callsBySid = new Map<string, HumeConnectionHandle>();

export function hasReceivedRealSpeech(callSid: string): boolean {
  return callsBySid.get(callSid)?.receivedUserMessage ?? false;
}

// ---- media-stream auth ---------------------------------------------------
// Fixed 2026-09-17 (security): the /media-stream WebSocket had no auth at
// all and trusted whatever user_id arrived in the "start" event's
// customParameters — anyone who could guess or enumerate a user id could
// open a stream claiming to be them and hear Co talk through that person's
// private context, and have their own words written into that person's
// profile. Twilio's <Connect><Stream> can only carry <Parameter> values,
// and (for outbound calls specifically) the TwiML is built and handed to
// Twilio BEFORE the call's own CallSid exists, so the token can't be bound
// to a callSid up front — instead it's a single-use, short-lived opaque
// token issued server-side (never derived from anything the client sends)
// right before the TwiML is built, consumed exactly once when the stream's
// "start" event arrives. The authenticated userId comes ONLY from this
// token from that point on; the client-supplied user_id parameter is never
// trusted on its own.
const STREAM_AUTH_TTL_MS = 60_000;
const streamAuthTokens = new Map<string, { userId: string; expiresAt: number }>();

export function issueStreamAuthToken(userId: string): string {
  const token = randomBytes(24).toString("hex");
  streamAuthTokens.set(token, { userId, expiresAt: Date.now() + STREAM_AUTH_TTL_MS });
  return token;
}

// One-time use — deletes on read whether or not it was valid, so a captured
// token can't be replayed into a second stream.
function consumeStreamAuthToken(token: string | undefined): string | null {
  if (!token) return null;
  const entry = streamAuthTokens.get(token);
  streamAuthTokens.delete(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.userId;
}


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
  if (handle.callSid && pendingConnections.get(handle.callSid) === handle) pendingConnections.delete(handle.callSid);
  if (handle.callSid && callsBySid.get(handle.callSid) === handle) callsBySid.delete(handle.callSid);
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
function createHumeConnection(userId: string, callSid: string | null = null): HumeConnectionHandle {
  const handle: HumeConnectionHandle = {
    userId,
    humeSocket: null,
    closed: false,
    twilioWs: null,
    streamSid: null,
    callSid,
    receivedUserMessage: false,
    coHasSpoken: false,
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
          handle.coHasSpoken = true;
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
        } else if (m.type === "user_message") {
          // Ground truth that a live human is actually talking — see
          // hasReceivedRealSpeech above. Fixed 2026-09-17: only counts once
          // Co has actually spoken AND the transcribed text isn't a
          // voicemail greeting/carrier message/bare filler — see
          // isRealUserUtterance (harness/callGate.ts, shared with the
          // post-call transcript version of the same test). Only a flag
          // flip, not a transcript hook: the real extraction/tool-call
          // pipeline stays on /webhook.
          const text = typeof m.message?.content === "string" ? m.message.content : "";
          if (isRealUserUtterance(text, handle.coHasSpoken)) {
            handle.receivedUserMessage = true;
          }
        } else if (m.type === "user_interruption") {
          // Fixed 2026-09-17: nothing handled Hume's own interruption event,
          // so Twilio kept playing whatever of Co's audio was already queued
          // even after the person started talking over her — Co kept
          // talking over them. Hume has already stopped generating; this
          // just needs to stop what Twilio is about to play and drop
          // anything still buffered for a not-yet-attached stream.
          handle.pendingOutbound = [];
          if (handle.twilioWs && handle.streamSid) {
            try {
              handle.twilioWs.send(JSON.stringify({ event: "clear", streamSid: handle.streamSid }));
            } catch (err: any) {
              console.error("mediaStreamBridge: failed to send Twilio clear on interruption (non-fatal):", err?.message ?? err);
            }
          }
        }
        // chat_started/chat_ended/tool_call/assistant_message are
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

// Called from callTrigger.ts (right after placing an outbound call, with
// that call's real CallSid) and co.ts's /incoming-call (right after
// resolving the caller, with Twilio's inbound CallSid) — as early as
// possible, so the DB lookup + Hume handshake happen during ring time
// instead of only starting after the person has already picked up. No-ops
// if a connection is already pending for this exact call.
export function prewarmHumeConnection(userId: string, callSid: string): void {
  if (pendingConnections.has(callSid)) return;
  const handle = createHumeConnection(userId, callSid);
  handle.evictionTimer = setTimeout(() => closeHandle(handle), PREWARM_CLAIM_TIMEOUT_MS);
  pendingConnections.set(callSid, handle);
}

export function bridgeTwilioMediaStream(twilioWs: WebSocket): void {
  let handle: HumeConnectionHandle | null = null;

  // authenticatedUserId comes ONLY from consumeStreamAuthToken — see the
  // "media-stream auth" section above. The client-supplied user_id
  // parameter is logged for a mismatch but never trusted on its own.
  function attach(authenticatedUserId: string, streamSid: string, callSid: string | null) {
    const prewarmed = callSid ? pendingConnections.get(callSid) : undefined;
    if (prewarmed && !prewarmed.closed) {
      if (prewarmed.userId !== authenticatedUserId) {
        // The prewarmed connection (opened server-side, with a trusted
        // userId — see prewarmHumeConnection's call sites) disagrees with
        // what this token authorizes. Never happens on a legitimate call;
        // refuse rather than bridge the wrong person's context.
        console.error("mediaStreamBridge: token/prewarm userId mismatch, closing");
        twilioWs.close();
        return;
      }
      pendingConnections.delete(callSid!);
      if (prewarmed.evictionTimer) clearTimeout(prewarmed.evictionTimer);
      handle = prewarmed;
    } else {
      // Fallback — no usable prewarmed connection found for this exact
      // CallSid (shouldn't normally happen since both call sites prewarm
      // with the real CallSid before this attaches, but keeps this working
      // on its own if that's ever not the case, or if callSid was somehow
      // absent from the "start" event). authenticatedUserId is still the
      // token's userId, never the client-supplied one.
      handle = createHumeConnection(authenticatedUserId, callSid);
    }
    handle.twilioWs = twilioWs;
    handle.streamSid = streamSid;
    if (callSid) {
      handle.callSid = callSid;
      callsBySid.set(callSid, handle);
    }
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
        // only place it's actually reachable, confirmed live. Kept for
        // logging a mismatch only — see the security fix below.
        const claimedUserId: string | undefined = msg.start?.customParameters?.user_id;
        // Fixed 2026-09-17 (security): this endpoint had no auth at all —
        // anyone who could open a WebSocket to /media-stream and send a
        // "start" event with someone else's user_id got bridged straight
        // into that person's private context, and their own words got
        // written into that person's profile. "auth" is a single-use,
        // short-lived token issued server-side (issueStreamAuthToken) right
        // before the TwiML is built (see callTrigger.ts, co.ts's
        // /incoming-call) and never derivable by a client — the
        // authenticated userId comes only from it, not from the
        // customParameters user_id above.
        const authToken: string | undefined = msg.start?.customParameters?.auth;
        const authenticatedUserId = consumeStreamAuthToken(authToken);
        // Twilio's own call SID, native to every Media Streams "start" event
        // — used only to correlate against the /call-status AMD callback
        // (see callsBySid above), never relied on as a required field.
        const callSid: string | null = msg.start?.callSid ?? null;
        if (!authenticatedUserId || !streamSid) {
          console.error(
            `mediaStreamBridge: start event missing a valid auth token or streamSid, closing (claimed user_id: ${claimedUserId ?? "none"})`,
          );
          twilioWs.close();
          break;
        }
        if (claimedUserId && claimedUserId !== authenticatedUserId) {
          console.error(`mediaStreamBridge: claimed user_id ${claimedUserId} didn't match the token's ${authenticatedUserId} — using the token`);
        }
        attach(authenticatedUserId, streamSid, callSid);
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
