// The voice read's relay (2026-10-23): Twilio forks the caller's audio to us (<Start><Stream track="inbound_track">,
// added to ElevenLabs' TwiML in services/elevenLabsCalls.ts), and we pass it one way to Hume's Expression Measurement
// realtime endpoint. Listen-only: nothing goes back to Twilio or the call, the call itself runs on ElevenLabs as before.
//
// Rebuilt from the Hume EVI bridge removed in 48e970a6 (the stream protocol, the frame buffering cap, the per-call
// stats line), cut down to one direction. What changed: Hume's v1 endpoint, not EVI; 16 kHz s16le in
// (services/audioCodec.ts); who the stream belongs to comes only from its one-time stream link (the opaque id in the
// fork's <Parameter>, services/voiceStreamLink.ts: never the member's id or call token, since Twilio logs TwiML), on top
// of Twilio's signature on the WebSocket handshake (voiceStreamSignatureOk, checked in server.ts before the upgrade).
//
// Never in the way of the call:
// - Hume is opened when the stream starts and never awaited by anything on the call's path. The call brain reads
//   whatever score is already here (voiceReadLineFor, synchronous); a slow, failing or dropped Hume means no line.
// - Every handler is wrapped: an error ends the read for that call, nothing else.
// - No audio is kept: frames are converted, batched to ~100 ms and sent; the batch and the small pre-connect buffer are
//   cleared as they go and when the session ends. Nothing is written to disk or the database except the session log
//   (ids, timings, counts, which signals passed the bar) and, after the call, the few moments (services/voiceRead.ts).
import { createHmac, timingSafeEqual } from "crypto";
import WebSocket from "ws";
import { mulaw8kToPcm16k, pcm16kMs } from "./audioCodec.js";
import { sessionHashOf, takeVoiceStreamLink } from "./voiceStreamLink.js";
import {
  newSessionStats,
  rollingRead,
  sessionSummary,
  voiceCrosstalk,
  voiceLine,
  judgeVoiceMoments,
  voiceMomentJudge,
  voiceStreamUrl,
  VOICE_STREAM_PATH,
  type CallerTurn,
  type LineDecision,
  type VoiceMoment,
  type VoiceMomentJudge,
  type VoiceSessionStats,
  type VoiceWindow,
} from "./voiceRead.js";

export const HUME_REALTIME_URL = "wss://api.cloud.hume.ai/v1/expression/audio/realtime";
// Exactly the documented fields (Hume validates session.update strictly: unknown fields are rejected).
export const HUME_SESSION_UPDATE = { type: "session.update", audio: { type: "audio/pcm", encoding: "s16le", sample_rate: 16000, channels: 1 }, measurement_timer_ms: 3000 };

export const BRIDGE = {
  batchBytes: 3200, // 100 ms of 16 kHz s16le, Hume's suggested frame size
  pendingCap: 30, // 100 ms batches held while Hume opens (3 s); older ones drop past this
  openTimeoutMs: 5000, // Hume's handshake; past this the read is absent for the call
  closeWaitMs: 3000, // after session.close, how long to wait for the last scores and session.closed
  keepFinishedMs: 15 * 60_000, // a finished session waits this long for the post-call webhook
  maxWindows: 2000,
};

// ---------------------------------------------------------------- Twilio's signature on the stream

// Twilio signs the stream's WebSocket handshake with X-Twilio-Signature (Media Streams docs: "configure your application
// to validate the X-Twilio-Signature header"): HMAC-SHA1 with the auth token over the URL, with no body params. The URL is
// the one in our TwiML (wss://), and the https:// form of the same URL is accepted too, since the docs don't say which
// scheme is signed; both are under our own host and our own secret. Unlike the HTTP webhooks, this fails closed when
// TWILIO_AUTH is missing in any environment: the read is optional, so there is no reason to accept an unsigned stream.
export function twilioSignatureFor(secret: string, url: string): string {
  return createHmac("sha1", secret).update(Buffer.from(url, "utf-8")).digest("base64");
}
export function voiceStreamSignatureOk(signature: string | string[] | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.TWILIO_AUTH;
  const sig = Array.isArray(signature) ? signature[0] : signature;
  const wss = voiceStreamUrl(env.API_URL);
  if (!secret || !sig || !wss) return false;
  const candidates = [wss, wss.replace(/^wss:/, "https:").replace(/^ws:/, "http:")];
  const given = Buffer.from(sig);
  return candidates.some((url) => {
    const want = Buffer.from(twilioSignatureFor(secret, url));
    return want.length === given.length && timingSafeEqual(want, given);
  });
}
export const isVoiceStreamPath = (url: string | undefined): boolean => {
  try {
    return new URL(url ?? "", "http://x").pathname === VOICE_STREAM_PATH;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- sessions

export type SocketLike = {
  readyState: number;
  send(data: unknown): void;
  close(): void;
  on(event: string, fn: (...args: any[]) => void): unknown;
};
export type BridgeDeps = {
  connectHume: (apiKey: string) => SocketLike;
  // The stream's one-time link: who it is for and its session, or null (services/voiceStreamLink.ts).
  takeLink: (streamId: string) => Promise<{ userId: string; sessionHash: string } | null>;
  now: () => number;
  log: (line: string) => void;
  // The session's summary, for the audit (harness_decisions). Never audio, never their words.
  record: (userId: string, summary: ReturnType<typeof sessionSummary>) => void;
  apiKey: () => string | undefined;
  // May the read run for this member now (services/voiceReadConsent.ts voiceReadOnFor: their yes on file and not taken back, or a
  // test number). Read again when the stream starts and after the call, so a withdrawal since the call began counts. Fails closed.
  allowed: (userId: string) => Promise<boolean>;
};

const OPEN = 1;

type Session = {
  key: string; // the session hash (voiceStreamLink.ts sessionHashOf)
  userId: string;
  verified: boolean; // its stream link was taken; until then nothing is sent or logged
  stats: VoiceSessionStats;
  windows: VoiceWindow[];
  openUtterances: Map<number, number>;
  hume: SocketLike | null;
  ready: boolean;
  closed: boolean;
  finishedAt: number | null;
  batch: Buffer[];
  batchBytes: number;
  pending: Buffer[];
  // [audio ms sent so far, wall clock] per batch, for read latency.
  sent: { endMs: number; at: number }[];
  noisy: string | null;
  done: Promise<void>;
  resolveDone: () => void;
  openTimer: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, Session>();
// The call's key, as routes/callLlm.ts builds it; sessions are held under its hash (voiceStreamLink.ts sessionHashOf).
export const callKeyOf = (userId: string, callToken: string): string => `${userId}:${callToken}`;

function prune(now: number) {
  for (const [k, s] of sessions) if (s.finishedAt != null && now - s.finishedAt > BRIDGE.keepFinishedMs) sessions.delete(k);
}

function defaultDeps(): BridgeDeps {
  return {
    connectHume: (apiKey) => new WebSocket(HUME_REALTIME_URL, { headers: { "X-Hume-Api-Key": apiKey }, handshakeTimeout: BRIDGE.openTimeoutMs }) as unknown as SocketLike,
    takeLink: (id) => takeVoiceStreamLink(id),
    now: Date.now,
    log: (l) => console.log(l),
    record: (userId, summary) => {
      void import("../harness/core.js")
        .then((c) => c.recordDecision({ layer: 8, decision: "call.voice_read", userId, outcome: summary.error ? "skip" : "act", action: summary.noisy ? "ignored_noisy" : summary.windows ? "read" : "no_scores", proposal: summary }))
        .catch(() => {});
    },
    apiKey: () => process.env.HUME_API_KEY,
    allowed: (userId) => import("./voiceReadConsent.js").then((c) => c.voiceReadOnFor(userId)).catch(() => false),
  };
}
let deps: BridgeDeps | null = null;
const D = (): BridgeDeps => (deps ??= defaultDeps());
// Tests swap the outside world (Hume, the token check, the clock, the log) for fakes.
export function setBridgeDeps(d: Partial<BridgeDeps> | null): void {
  deps = d ? { ...defaultDeps(), ...d } : null;
}
export function resetVoiceSessions(): void {
  sessions.clear();
}

function sendBatch(s: Session, buf: Buffer) {
  const d = D();
  if (s.closed) { s.stats.framesDropped++; return; }
  if (!s.ready || !s.hume || s.hume.readyState !== OPEN) {
    s.pending.push(buf);
    if (s.pending.length > BRIDGE.pendingCap) { s.pending.shift(); s.stats.framesDropped++; }
    return;
  }
  try {
    s.hume.send(buf);
    s.stats.framesSent++;
    s.stats.audioSentMs += pcm16kMs(buf.length);
    s.sent.push({ endMs: s.stats.audioSentMs, at: d.now() });
    if (s.sent.length > 1200) s.sent.splice(0, s.sent.length - 1200);
  } catch {
    s.stats.framesDropped++;
  }
}

function flushPending(s: Session) {
  const p = s.pending;
  s.pending = [];
  for (const b of p) sendBatch(s, b);
}

// The caller's audio, one Twilio media frame (base64 mulaw 8 kHz, ~20 ms) at a time.
function onMedia(s: Session, payloadB64: string) {
  s.stats.framesIn++;
  if (s.closed) return;
  const pcm = mulaw8kToPcm16k(Buffer.from(payloadB64, "base64"));
  s.batch.push(pcm);
  s.batchBytes += pcm.length;
  if (s.batchBytes >= BRIDGE.batchBytes) {
    const buf = Buffer.concat(s.batch, s.batchBytes);
    s.batch = [];
    s.batchBytes = 0;
    sendBatch(s, buf);
  }
}

function latencyFor(s: Session, audioEndMs: number, at: number): number | null {
  const hit = s.sent.find((x) => x.endMs >= audioEndMs);
  return hit ? Math.max(0, at - hit.at) : null;
}

function onHumeMessage(s: Session, raw: unknown) {
  const d = D();
  let m: any;
  try {
    m = JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    return;
  }
  const at = d.now();
  switch (m?.type) {
    case "session.created":
      s.stats.humeSessionId = typeof m.session_id === "string" ? m.session_id : s.stats.humeSessionId;
      return;
    case "session.updated":
      s.ready = true;
      s.stats.humeOpenMs = at - s.stats.startedAt;
      if (s.openTimer) { clearTimeout(s.openTimer); s.openTimer = null; }
      flushPending(s);
      return;
    case "utterance.start":
      if (Number.isFinite(m.utterance_id) && Number.isFinite(m.audio_start_ms)) s.openUtterances.set(m.utterance_id, m.audio_start_ms);
      return;
    case "utterance.end": {
      const start = s.openUtterances.get(m.utterance_id);
      s.openUtterances.delete(m.utterance_id);
      if (Number.isFinite(m.audio_end_ms) && Number.isFinite(start ?? m.audio_start_ms)) s.stats.heardSpeechMs += Math.max(0, m.audio_end_ms - (start ?? m.audio_start_ms));
      s.stats.utterances++;
      return;
    }
    case "measurement.result": {
      const w: VoiceWindow = {
        utteranceId: Number(m.utterance_id) || 0,
        startMs: Number(m.audio_start_ms) || 0,
        endMs: Number(m.audio_end_ms) || 0,
        receivedAt: at,
        expressions: Array.isArray(m.expressions) ? m.expressions.map((x: any) => ({ name: String(x?.name ?? ""), probability: Number(x?.probability) || 0 })) : [],
        voiceAttributes: Array.isArray(m.voice_attributes) ? m.voice_attributes.map((x: any) => ({ name: String(x?.name ?? ""), probability: Number(x?.probability) || 0 })) : [],
      };
      if (s.windows.length < BRIDGE.maxWindows) s.windows.push(w);
      s.stats.windows++;
      const lat = latencyFor(s, w.endMs, at);
      if (lat != null && s.stats.latencies.length < 1000) s.stats.latencies.push(lat);
      return;
    }
    case "error": {
      const code = String(m.code ?? m.error?.code ?? "error");
      if (code === "rate_limited" || code === "invalid_audio_frame") { s.stats.framesDropped++; return; }
      s.stats.error = code;
      return;
    }
    case "session.closed":
      s.stats.closedBy = String(m.reason ?? "closed");
      endHume(s);
      return;
  }
}

function endHume(s: Session) {
  s.ready = false;
  s.closed = true;
  s.pending = [];
  s.batch = [];
  s.batchBytes = 0;
  if (s.openTimer) { clearTimeout(s.openTimer); s.openTimer = null; }
  try { s.hume?.close(); } catch { /* already closed */ }
  s.hume = null;
}

function openHume(s: Session) {
  const d = D();
  const key = d.apiKey();
  if (!key) { s.stats.error = "no key"; endHume(s); return; }
  let ws: SocketLike;
  try {
    ws = d.connectHume(key);
  } catch (err: any) {
    s.stats.error = `connect: ${String(err?.message ?? err).slice(0, 80)}`;
    endHume(s);
    return;
  }
  s.hume = ws;
  s.openTimer = setTimeout(() => {
    if (!s.ready && !s.closed) { s.stats.error = "hume not ready in time"; endHume(s); }
  }, BRIDGE.openTimeoutMs);
  (s.openTimer as any).unref?.();
  ws.on("open", () => {
    try { ws.send(JSON.stringify(HUME_SESSION_UPDATE)); } catch { /* the close handler ends it */ }
  });
  ws.on("message", (raw: unknown) => {
    try { onHumeMessage(s, raw); } catch { /* one bad message never ends the call's read */ }
  });
  ws.on("error", (err: any) => {
    if (!s.stats.error) s.stats.error = `hume: ${String(err?.message ?? err).slice(0, 80)}`;
    endHume(s);
  });
  ws.on("close", () => {
    if (!s.closed) { s.stats.closedBy ??= "hume dropped"; endHume(s); }
  });
}

function finish(s: Session, by: string) {
  if (s.finishedAt != null) return;
  const d = D();
  s.finishedAt = d.now();
  // Finished sessions older than the post-call wait go now, so one whose webhook never comes doesn't linger.
  prune(s.finishedAt);
  if (!s.verified) { endHume(s); s.resolveDone(); return; }
  s.stats.closedBy ??= by;
  let closedOnce = false;
  const close = () => {
    if (closedOnce) return;
    closedOnce = true;
    endHume(s);
    const summary = sessionSummary(s.stats, d.now());
    d.log(`voiceRead: session ${JSON.stringify({ user: s.userId.slice(0, 8), ...summary })}`);
    try { d.record(s.userId, summary); } catch { /* the log line above is the fallback */ }
    s.resolveDone();
  };
  // Send what's left, ask Hume to close, and give its last scores a moment to land.
  if (s.hume && s.ready && s.hume.readyState === OPEN && !s.closed) {
    if (s.batchBytes) { const buf = Buffer.concat(s.batch, s.batchBytes); s.batch = []; s.batchBytes = 0; sendBatch(s, buf); }
    try { s.hume.send(JSON.stringify({ type: "session.close" })); } catch { /* closing anyway */ }
    const t = setTimeout(close, BRIDGE.closeWaitMs);
    (t as any).unref?.();
    s.hume.on("close", () => { clearTimeout(t); close(); });
  } else close();
}

// One Twilio stream (the fork). Everything about who it is comes from the token in its own start message.
export function handleTwilioStream(ws: SocketLike): void {
  let s: Session | null = null;
  let ended = false;
  ws.on("message", (raw: unknown) => {
    try {
      const m = JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
      if (m?.event === "start") {
        if (s) return;
        const d = D();
        let resolveDone = () => {};
        const done = new Promise<void>((r) => (resolveDone = r));
        const stats = newSessionStats(d.now());
        stats.callSid = typeof m.start?.callSid === "string" ? m.start.callSid : null;
        stats.streamSid = typeof m.streamSid === "string" ? m.streamSid : null;
        // Audio that arrives while the link is checked waits in the capped buffer; nothing is sent until it is.
        const pendingSession: Session = { key: "", userId: "", verified: false, stats, windows: [], openUtterances: new Map(), hume: null, ready: false, closed: false, finishedAt: null, batch: [], batchBytes: 0, pending: [], sent: [], noisy: null, done, resolveDone, openTimer: null };
        s = pendingSession;
        // Who the stream is for comes only from its one-time link (services/voiceStreamLink.ts), never from the stream.
        const refuse = (why: string) => { d.log(`voiceRead: stream refused (${why})`); endHume(pendingSession); s = null; ended = true; try { ws.close(); } catch { /* gone */ } };
        d.takeLink(String(m.start?.customParameters?.stream ?? ""))
          .then((link) => {
            if (!link) return refuse("no live stream link");
            if (ended || s !== pendingSession) return;
            prune(d.now());
            // One stream per call.
            if (sessions.has(link.sessionHash)) return refuse("this call already has one");
            // Their consent, read again now: taken back since the call's TwiML was made means no read at all.
            return d.allowed(link.userId).catch(() => false).then((ok) => {
              if (!ok) return refuse("not consented");
              if (ended || s !== pendingSession) return;
              if (sessions.has(link.sessionHash)) return refuse("this call already has one");
              pendingSession.userId = link.userId;
              pendingSession.key = link.sessionHash;
              pendingSession.verified = true;
              sessions.set(link.sessionHash, pendingSession);
              // Read once more now that a stop can reach the session (endVoiceSessionsFor): a stop that landed during the read above
              // ended nothing, so Hume opens only if it's still on and the session wasn't ended meanwhile.
              return d.allowed(link.userId).catch(() => false).then((still) => {
                if (ended || s !== pendingSession || sessions.get(link.sessionHash) !== pendingSession) return;
                if (!still) {
                  sessions.delete(link.sessionHash);
                  return refuse("not consented");
                }
                openHume(pendingSession);
              });
            });
          })
          .catch(() => refuse("link check failed"));
      } else if (m?.event === "media" && s) {
        // Only the caller's side (the fork asks for inbound_track; anything else is ignored, never sent).
        if (m.media?.track && m.media.track !== "inbound") return;
        if (typeof m.media?.payload === "string") onMedia(s, m.media.payload);
      } else if (m?.event === "stop" && s) {
        ended = true;
        finish(s, "call ended");
      }
    } catch (err: any) {
      if (s && !s.stats.error) s.stats.error = `stream: ${String(err?.message ?? err).slice(0, 80)}`;
    }
  });
  ws.on("close", () => { ended = true; if (s) finish(s, "stream closed"); });
  ws.on("error", () => { ended = true; if (s) finish(s, "stream error"); });
}

// ---------------------------------------------------------------- readers

// The call brain's line for this turn (routes/callLlm.ts). Synchronous: reads only what Hume has already sent.
// `callerLines` are the member's lines so far (for the noisy-call rule); once noisy, the read stays off for the call.
export function voiceReadLineFor(callKey: string, turnWords: string, callerLines: string[], o: { safety: boolean }): LineDecision | null {
  const s = sessions.get(sessionHashOf(callKey));
  if (!s || s.finishedAt != null) return null;
  const d = D();
  if (!s.noisy) {
    const n = voiceCrosstalk({ heardSpeechMs: s.stats.heardSpeechMs, callerLines });
    if (n.noisy) s.noisy = s.stats.noisy = n.why;
  }
  const read = rollingRead(s.windows, d.now());
  const decision = voiceLine(read, turnWords, { noisy: !!s.noisy, safety: o.safety });
  if (decision.dim && read.strongest) s.stats.passed[decision.dim] = (s.stats.passed[decision.dim] ?? 0) + 1;
  if (decision.line) s.stats.linesOffered++;
  return decision;
}

// After the call (routes/co.ts post-call): the moments to keep, once. Waits a few seconds at most for the session to
// finish (its last scores land just after the call ends); a call without a session, or a noisy one, gives none.
export async function takeVoiceMoments(callKey: string, callerTurns: CallerTurn[], waitMs = 5000, judge: VoiceMomentJudge = voiceMomentJudge()): Promise<VoiceMoment[]> {
  const key = sessionHashOf(callKey);
  const s = sessions.get(key);
  if (!s) return [];
  if (s.finishedAt == null || !s.closed) {
    let t: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([s.done, new Promise<void>((r) => { t = setTimeout(r, waitMs); })]);
    if (t) clearTimeout(t);
  }
  sessions.delete(key);
  // Taken back during or since the call: nothing from it is judged or kept.
  if (!(await D().allowed(s.userId).catch(() => false))) {
    s.windows = [];
    D().log(`voiceRead: after call ${JSON.stringify({ user: s.userId.slice(0, 8), callSid: s.stats.callSid, dropped: "not consented" })}`);
    return [];
  }
  const noisy = s.noisy ?? voiceCrosstalk({ heardSpeechMs: s.stats.heardSpeechMs, callerLines: callerTurns.map((t) => t.text) }).why;
  // One judge call for the whole call (services/voiceRead.ts judgeVoiceMoments; the rule unless a Jev judge is plugged in).
  const judged = noisy ? { moments: [] as VoiceMoment[], judgedBy: "none (noisy)", candidates: 0 } : await judgeVoiceMoments(s.windows, callerTurns, judge);
  const moments = judged.moments;
  D().log(`voiceRead: after call ${JSON.stringify({ user: s.userId.slice(0, 8), callSid: s.stats.callSid, windows: s.windows.length, noisy: noisy ?? null, candidates: judged.candidates, judgedBy: judged.judgedBy, moments: moments.map((m) => ({ dim: m.dim, kind: m.kind, p: Math.round(m.p * 1000) / 1000, intensity: m.intensity, mismatch: m.mismatch, judge: m.judge })) })}`); // mood: logs which moments the judge kept (labels only, no words), decides nothing
  s.windows = [];
  return moments;
}

// They took their yes back (services/voiceReadConsent.ts turnVoiceReadOff): every read of theirs ends now, this call's included.
// Hume is closed, the scores so far are dropped, and the session is gone, so the call brain gets no further line and nothing is
// kept after the call. Returns how many were ended.
export function endVoiceSessionsFor(userId: string): number {
  let n = 0;
  for (const [k, s] of sessions) {
    if (s.userId !== userId) continue;
    endHume(s);
    s.windows = [];
    s.stats.closedBy ??= "consent withdrawn";
    if (s.finishedAt == null) s.finishedAt = D().now();
    s.resolveDone();
    sessions.delete(k);
    n++;
  }
  return n;
}

// For tests and the audit: what a session holds (never audio; the buffers are listed by size only).
export function sessionShape(callKey: string): { pendingBytes: number; batchBytes: number; windows: number; finished: boolean } | null {
  const s = sessions.get(sessionHashOf(callKey));
  if (!s) return null;
  return { pendingBytes: s.pending.reduce((a, b) => a + b.length, 0), batchBytes: s.batchBytes, windows: s.windows.length, finished: s.finishedAt != null };
}
