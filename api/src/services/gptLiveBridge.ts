// The GPT-Live trial's audio bridge (services/gptLive.ts): Twilio's bidirectional Media Stream on one side, OpenAI's Live
// WebSocket on the other. Both carry G.711 mu-law at 8 kHz, so audio bytes pass through unconverted; only the framing changes
// (Twilio: {event:"media", media:{payload}}; OpenAI: session.input_audio.append / session.output_audio.delta).
//
// Who the call is comes only from the stream's one-time id (the TwiML route issued it for the verified caller), on top of
// Twilio's signature on the WebSocket handshake (server.ts). Cue's audio goes to Twilio at most GPT_LIVE.leadMs ahead of real time,
// the rest queued here, so when the caller cuts in, little stale audio is left at Twilio.
//
// Per call it records: each delegated turn's latency (call.turn_latency, action gpt_live), each reply's gap after the call
// (call.turn_latency, action gpt_live_voice) and the session (call.gpt_live_session: seconds, why it ended), all numbers only.
import { timingSafeEqual } from "crypto";
import WebSocket from "ws";
import { recordDecision, type HarnessDecision } from "../harness/core.js";
import { anthropicStream } from "./callLlmProxy.js";
import { GPT_LIVE, greetingEvent, gptLiveVoice, openSessions, replyGaps, sessionStart, takeLiveLink, thinkOnCall, turnsFrom, type Frag, type LiveCall, type LiveTurn, type Upstream } from "./gptLive.js";
import { twilioSignatureFor, type SocketLike } from "./mediaStreamBridge.js";

// Twilio's signature on the stream's handshake, over the stream URL (wss://, or its https:// form), with TWILIO_AUTH. Fails closed.
export function twilioStreamSignatureOk(signature: string | string[] | undefined, wss: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const sig = Array.isArray(signature) ? signature[0] : signature;
  if (!env.TWILIO_AUTH || !sig || !wss) return false;
  const given = Buffer.from(sig);
  return [wss, wss.replace(/^wss:/, "https:").replace(/^ws:/, "http:")].some((url) => {
    const want = Buffer.from(twilioSignatureFor(env.TWILIO_AUTH!, url));
    return want.length === given.length && timingSafeEqual(want, given);
  });
}

export type LiveResult = { call: LiveCall; sessionId: string; turns: LiveTurn[]; startedAt: Date; endedAt: Date; seconds: number | null; reason: string };
export type LiveDeps = {
  connectOpenAI: (apiKey: string) => SocketLike;
  apiKey: () => string | undefined;
  takeLink: (id: unknown) => LiveCall | null;
  upstream: Upstream;
  record: (d: HarnessDecision) => void;
  postCall: (r: LiveResult) => Promise<unknown>;
  now: () => number;
  log: (line: string) => void;
  maxSessionMs: number;
};
const defaults = (): LiveDeps => ({
  connectOpenAI: (key) => new WebSocket(GPT_LIVE.url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10_000, perMessageDeflate: false }) as unknown as SocketLike,
  apiKey: () => process.env.OPENAI_API_KEY,
  takeLink: (id) => takeLiveLink(id),
  upstream: (req, userId) => anthropicStream(req, undefined, undefined, userId),
  record: (d) => void recordDecision(d).catch(() => {}),
  postCall: (r) => import("../routes/co.js").then((m) => m.runGptLivePostCall(r)),
  now: Date.now,
  log: (l) => console.log(l),
  maxSessionMs: GPT_LIVE.maxSessionMs,
});
let override: Partial<LiveDeps> | null = null;
export const setLiveDeps = (d: Partial<LiveDeps> | null): void => void (override = d);
const OPEN = 1;
const parse = (raw: unknown): any => { try { return JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return null; } };
const send = (ws: SocketLike | null, m: unknown) => { try { if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(m)); } catch { /* the close handler ends it */ } };

export function handleGptLiveStream(twilio: SocketLike): void {
  const d: LiveDeps = { ...defaults(), ...(override ?? {}) };
  let call: LiveCall | null = null;
  let ai: SocketLike | null = null;
  let streamSid = "", sessionId = "", reason = "", seconds: number | null = null;
  let started = false, finished = false, closing = false;
  const t0 = d.now();
  const frags: Frag[] = [];
  const early: string[] = []; // caller audio before session.started (3 s at most)
  const queue: Buffer[] = [];
  let queued = 0, playhead = 0, maxQueuedMs = 0, delegations = 0;
  let pump: ReturnType<typeof setInterval> | null = null;
  let cap: ReturnType<typeof setTimeout> | null = null;
  let closeWait: ReturnType<typeof setTimeout> | null = null;

  // Cue's audio to Twilio, never more than leadMs ahead of real time (8 bytes of mu-law per ms).
  const drain = () => {
    const now = d.now();
    while (queued && Math.max(playhead, now) - now < GPT_LIVE.leadMs) {
      const chunk = queue[0].subarray(0, 160);
      queue[0] = queue[0].subarray(chunk.length);
      if (!queue[0].length) queue.shift();
      queued -= chunk.length;
      playhead = Math.max(playhead, now) + chunk.length / 8;
      send(twilio, { event: "media", streamSid, media: { payload: chunk.toString("base64") } });
    }
  };

  const finish = (why: string) => {
    if (finished) return;
    finished = true;
    reason ||= why;
    for (const t of [cap, closeWait]) if (t) clearTimeout(t);
    if (pump) clearInterval(pump);
    if (sessionId) openSessions.delete(sessionId);
    try { ai?.close(); } catch { /* gone */ }
    try { if (twilio.readyState === OPEN) twilio.close(); } catch { /* gone */ }
    if (!call || !started) return void d.log(`gpt-live: session ended before it started (${reason})`);
    const turns = turnsFrom(frags);
    const secs = seconds ?? Math.round((d.now() - t0) / 1000);
    d.record({ layer: 8, decision: "call.gpt_live_session", userId: call.userId, outcome: "act", action: reason, proposal: { provider: "gpt-live", sessionId, seconds: secs, confirmed: seconds != null, delegations, maxQueuedMs, turns: turns.length } });
    for (const gapMs of replyGaps(turns)) d.record({ layer: 8, decision: "call.turn_latency", userId: call.userId, outcome: "act", action: "gpt_live_voice", proposal: { provider: "gpt-live", sessionId, gapMs } });
    d.log(`gpt-live: session ${sessionId} ended (${reason}) ${secs}s, ${turns.length} turns, ${delegations} delegations, max queued ${maxQueuedMs}ms`);
    d.postCall({ call, sessionId, turns, startedAt: new Date(t0), endedAt: new Date(d.now()), seconds: secs, reason }).catch((err: any) => d.log(`gpt-live: post-call failed for ${sessionId}: ${err?.message ?? err}`));
  };
  // Ask OpenAI to close, keep reading until session.closed (final usage), then finish.
  const close = (why: string) => {
    if (closing || finished) return;
    closing = true;
    reason ||= why;
    if (!ai || ai.readyState !== OPEN || !started) return finish(why);
    send(ai, { type: "session.close" });
    closeWait = setTimeout(() => finish(why), GPT_LIVE.closeWaitMs);
    (closeWait as any).unref?.();
  };

  // A delegated turn: the call brain answers from the caller's prompt and the transcript, and GPT-Live says it.
  const delegate = async (id: string, offsetMs: number) => {
    if (!call) return;
    delegations++;
    const at = d.now();
    // The transcript can trail the audio: wait briefly for it to reach where the turn was handed over.
    const latest = () => frags.reduce((m, f) => Math.max(m, f.endMs), 0);
    while (d.now() - at < GPT_LIVE.catchUpMs && latest() < offsetMs - 300) await new Promise((r) => setTimeout(r, 50));
    const waitMs = d.now() - at;
    let dropped = 0, error = false;
    const c = call;
    const out = await thinkOnCall(c, turnsFrom(frags), d.upstream, (s, why) => {
      dropped++;
      const claim = /^claim held: /.test(why);
      d.record({ layer: 8, decision: claim ? "call.claim_held" : "call.offer_unsourced", userId: c.userId, outcome: "skip", action: claim ? "held_claim" : "dropped_sentence", proposal: { provider: "gpt-live", sentence: s.slice(0, 240) }, reason: why });
    }).catch((err: any) => { error = true; d.log(`gpt-live: delegation ${id} failed: ${err?.message ?? err}`); return { text: "", timing: null }; });
    if (!finished)
      send(ai, out.text
        ? { type: "session.commentary.append", event_id: `answer_${id}`, delegation_id: id, content: out.text }
        : { type: "session.thinking.append", event_id: `answer_${id}`, delegation_id: id, content: "No answer came back this time. Don't guess: say you'll text them on it after the call, or ask them to say more." });
    if (error) d.record({ layer: 8, decision: "call.turn_health", userId: c.userId, outcome: "skip", action: "error", proposal: { provider: "gpt-live", slow: false, error: true } });
    d.record({ layer: 8, decision: "call.turn_latency", userId: c.userId, outcome: "act", action: "gpt_live", proposal: { provider: "gpt-live", sessionId, waitMs, firstTokenMs: out.timing?.upstreamFirstTokenMs ?? null, firstSentenceMs: out.timing?.firstSentenceMs ?? null, totalMs: d.now() - at, chars: out.text.length, dropped, error } });
  };

  const onAi = (raw: unknown) => {
    const m = parse(raw);
    switch (m?.type) {
      case "session.started":
        started = true;
        sessionId = String(m.session?.id ?? "");
        openSessions.set(sessionId, t0);
        send(ai, greetingEvent(call!));
        for (const a of early.splice(0)) send(ai, { type: "session.input_audio.append", audio: a });
        cap = setTimeout(() => close("session cap"), d.maxSessionMs);
        (cap as any).unref?.();
        return;
      case "session.output_audio.delta": {
        const b = Buffer.from(String(m.delta ?? ""), "base64");
        if (!b.length) return;
        queue.push(b);
        queued += b.length;
        maxQueuedMs = Math.max(maxQueuedMs, Math.round(queued / 8));
        return drain();
      }
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        if (typeof m.delta === "string") frags.push({ who: m.type === "session.input_transcript.delta" ? "member" : "cue", text: m.delta, startMs: Number(m.start_ms) || 0, endMs: Number(m.end_ms) || 0 });
        return;
      case "session.delegation.created":
        if (m.delegation?.target === "client" && m.delegation?.id) void delegate(String(m.delegation.id), Number(m.offset_ms) || 0);
        return;
      case "session.usage.updated":
      case "session.closed":
        if (Number.isFinite(Number(m.usage?.seconds))) seconds = Number(m.usage.seconds);
        if (m.type === "session.closed") { reason ||= String(m.reason ?? "closed"); finish(reason); }
        return;
      case "error":
        d.log(`gpt-live: error ${m.error?.code ?? "?"}: ${String(m.error?.message ?? "").slice(0, 160)}`);
        return;
    }
  };

  const openAi = (c: LiveCall) => {
    const key = d.apiKey();
    if (!key) return finish("no OpenAI key");
    try { ai = d.connectOpenAI(key); } catch (err: any) { return finish(`connect: ${String(err?.message ?? err).slice(0, 80)}`); }
    ai.on("open", () => send(ai, sessionStart(c, gptLiveVoice())));
    ai.on("message", (raw: unknown) => { try { onAi(raw); } catch { /* one bad event never ends the call */ } });
    ai.on("error", (err: any) => { reason ||= `openai: ${String(err?.message ?? err).slice(0, 80)}`; });
    ai.on("close", () => finish(started ? "openai closed" : reason || "openai refused"));
  };

  twilio.on("message", (raw: unknown) => {
    const m = parse(raw);
    if (m?.event === "start" && !call) {
      streamSid = String(m.streamSid ?? m.start?.streamSid ?? "");
      call = d.takeLink(m.start?.customParameters?.s);
      if (!call) { d.log("gpt-live: stream refused (no live stream id)"); finished = true; try { twilio.close(); } catch { /* gone */ } return; }
      pump = setInterval(drain, 20);
      (pump as any).unref?.();
      openAi(call);
    } else if (m?.event === "media" && call && typeof m.media?.payload === "string") {
      if (m.media.track && m.media.track !== "inbound") return;
      if (started) send(ai, { type: "session.input_audio.append", audio: m.media.payload });
      else if (early.length < 150) early.push(m.media.payload);
    } else if (m?.event === "stop") close("caller hung up");
  });
  twilio.on("close", () => close("caller hung up"));
  twilio.on("error", () => close("twilio stream error"));
}
