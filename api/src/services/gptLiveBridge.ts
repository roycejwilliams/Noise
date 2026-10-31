// GPT-Live's audio bridge (services/gptLive.ts): Twilio's bidirectional Media Stream on one side, OpenAI's Live
// WebSocket on the other. Both carry G.711 mu-law at 8 kHz, so audio bytes pass through unconverted; only the framing changes
// (Twilio: {event:"media", media:{payload}}; OpenAI: session.input_audio.append / session.output_audio.delta).
//
// Who the call is comes only from the stream's one-time id (the TwiML route issued it for the verified caller), on top of
// Twilio's signature on the WebSocket handshake (server.ts). Cue's audio goes to Twilio at most GPT_LIVE.leadMs ahead of real time,
// the rest queued here, so when the caller cuts in, little stale audio is left at Twilio.
//
// When the caller cuts in, Twilio's buffer is cleared and the local queue dropped. A delegated answer that comes back after the
// caller has moved on is dropped, and the automatic "let me think" is cancelled the way OpenAI's delegation guide shows.
//
// Per call it records: each delegated turn's latency (call.turn_latency, action gpt_live), each reply's gap after the call
// (call.turn_latency, action gpt_live_voice), the session (call.gpt_live_session: seconds, endedBy) and its minutes as it runs
// (gpt_live_minutes, for the team's monthly minutes), all numbers only.
import { timingSafeEqual } from "crypto";
import WebSocket from "ws";
import { recordDecision, type HarnessDecision } from "../harness/core.js";
import { anthropicStream } from "./callLlmProxy.js";
import { failClassOf, GPT_LIVE, gptLiveVoice, listeningSound, markCall, openSessions, replyGaps, sessionStart, takeLiveLink, thinkOnCall, turnsFrom, writeMinutes, type FailClass, type Frag, type LiveCall, type LiveTurn, type Upstream } from "./gptLive.js";
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

// endedBy: who or what ended the call, so the comparison can set aside endings ElevenLabs has no match for.
export type EndedBy = "caller_hangup" | "session_cap" | "budget_cap" | "openai_closed" | "not_started";
export type LiveResult = { call: LiveCall; sessionId: string; turns: LiveTurn[]; startedAt: Date; endedAt: Date; seconds: number | null; reason: string; endedBy: EndedBy };
export type LiveDeps = {
  connectOpenAI: (apiKey: string) => SocketLike;
  apiKey: () => string | undefined;
  takeLink: (id: unknown) => LiveCall | null;
  upstream: Upstream;
  record: (d: HarnessDecision) => void;
  postCall: (r: LiveResult) => Promise<unknown>;
  minutes: (sessionId: string, seconds: number, endedBy: string | null) => void;
  now: () => number;
  log: (line: string) => void;
  maxSessionMs: number;
  startTimeoutMs: number;
  heartbeatMs: number;
};
const defaults = (): LiveDeps => ({
  connectOpenAI: (key) => new WebSocket(GPT_LIVE.url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: GPT_LIVE.startTimeoutMs, perMessageDeflate: false }) as unknown as SocketLike,
  apiKey: () => process.env.OPENAI_API_KEY,
  takeLink: (id) => takeLiveLink(id),
  upstream: (req, userId) => anthropicStream(req, undefined, undefined, userId),
  record: (d) => void recordDecision(d).catch(() => {}),
  postCall: (r) => import("../routes/co.js").then((m) => m.runGptLivePostCall(r)),
  minutes: (id, secs, by) => void writeMinutes(id, secs, by),
  now: Date.now,
  log: (l) => console.log(l),
  maxSessionMs: GPT_LIVE.maxSessionMs,
  startTimeoutMs: GPT_LIVE.startTimeoutMs,
  heartbeatMs: GPT_LIVE.heartbeatMs,
});
let override: Partial<LiveDeps> | null = null;
export const setLiveDeps = (d: Partial<LiveDeps> | null): void => void (override = d);
const OPEN = 1;
const parse = (raw: unknown): any => { try { return JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return null; } };
const send = (ws: SocketLike | null, m: unknown) => { try { if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(m)); } catch { /* the close handler ends it */ } };
const timer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; };

export function handleGptLiveStream(twilio: SocketLike): void {
  const d: LiveDeps = { ...defaults(), ...(override ?? {}) };
  let call: LiveCall | null = null;
  let ai: SocketLike | null = null;
  let streamSid = "", slotKey = "", sessionId = "", reason = "", seconds: number | null = null;
  let endedBy: EndedBy | null = null;
  let failClass: FailClass | null = null; // why OpenAI didn't start, when it didn't
  let started = false, finished = false, closing = false;
  const t0 = d.now();
  let startedAt = t0;
  const frags: Frag[] = [];
  const early: string[] = []; // caller audio before session.started (3 s at most)
  const queue: Buffer[] = [];
  let queued = 0, playhead = 0, maxQueuedMs = 0, delegations = 0, clears = 0, staleDropped = 0;
  let memberRun = "", cleared = false; // the caller's words since Cue last spoke, and whether this run already cleared Cue's audio
  const timers: ReturnType<typeof setTimeout>[] = [];
  let pump: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  const elapsedSecs = () => Math.round((d.now() - startedAt) / 1000);

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
  // The caller cut in: what Twilio still holds and what waits here are dropped (GPT-Live stops on its own; this stops the echo of it).
  const bargeIn = () => {
    if (cleared || (!queued && playhead <= d.now())) return;
    cleared = true;
    clears++;
    queue.length = 0;
    queued = 0;
    playhead = 0;
    send(twilio, { event: "clear", streamSid });
  };

  const finish = (why: string, by: EndedBy) => {
    if (finished) return;
    finished = true;
    reason ||= why;
    endedBy ??= by;
    for (const t of timers) clearTimeout(t);
    if (pump) clearInterval(pump);
    if (beat) clearInterval(beat);
    if (slotKey) openSessions.delete(slotKey);
    try { ai?.close(); } catch { /* gone */ }
    try { if (twilio.readyState === OPEN) twilio.close(); } catch { /* gone */ }
    if (!call || !started) {
      // Never connected: the <Connect> action plays the can't-connect line and releases the call's status (routes/co.ts).
      if (call) markCall(call.callSid, call.userId, "failed", Date.now(), failClass ?? "refused");
      return void d.log(`gpt-live: session ended before it started (${reason})`);
    }
    const turns = turnsFrom(frags);
    const secs = seconds ?? elapsedSecs();
    d.minutes(sessionId, secs, endedBy);
    d.record({ layer: 8, decision: "call.gpt_live_session", userId: call.userId, outcome: "act", action: endedBy, proposal: { provider: "gpt-live", sessionId, seconds: secs, confirmed: seconds != null, endedBy, reason, capMs: call.capMs ?? null, delegations, staleDropped, clears, maxQueuedMs, turns: turns.length } });
    for (const gapMs of replyGaps(turns)) d.record({ layer: 8, decision: "call.turn_latency", userId: call.userId, outcome: "act", action: "gpt_live_voice", proposal: { provider: "gpt-live", sessionId, gapMs } });
    d.log(`gpt-live: session ${sessionId} ended (${endedBy}: ${reason}) ${secs}s, ${turns.length} turns, ${delegations} delegations, ${clears} clears`);
    d.postCall({ call, sessionId, turns, startedAt: new Date(startedAt), endedAt: new Date(d.now()), seconds: secs, reason, endedBy: endedBy! }).catch((err: any) => d.log(`gpt-live: post-call failed for ${sessionId}: ${err?.message ?? err}`));
  };
  // Ask OpenAI to close, keep reading until session.closed (final usage), then finish. Every ending (hang-up, either cap) goes here.
  const close = (why: string, by: EndedBy) => {
    if (closing || finished) return;
    closing = true;
    reason ||= why;
    endedBy ??= by;
    if (!ai || ai.readyState !== OPEN || !started) return finish(why, by);
    send(ai, { type: "session.close" });
    timers.push(timer(() => finish(why, by), GPT_LIVE.closeWaitMs));
  };

  // A delegated turn: the call brain answers from the caller's prompt and the transcript, and GPT-Live says it.
  const delegate = async (id: string, offsetMs: number) => {
    if (!call) return;
    delegations++;
    // Cancel the automatic acknowledgment (OpenAI's delegation guide: an empty thinking append inside acknowledgement_delay_ms).
    send(ai, { type: "session.thinking.append", event_id: `quiet_${id}`, delegation_id: id, content: "" });
    const at = d.now();
    // The transcript can trail the audio: wait briefly for it to reach where the turn was handed over.
    const latest = () => frags.reduce((m, f) => Math.max(m, f.endMs), 0);
    while (d.now() - at < GPT_LIVE.catchUpMs && latest() < offsetMs - 300) await new Promise((r) => setTimeout(r, 50));
    const waitMs = d.now() - at;
    const turns = turnsFrom(frags);
    const seenUpTo = Math.max(offsetMs, ...turns.filter((t) => t.who === "member").map((t) => t.startMs));
    let dropped = 0, error = false;
    const c = call;
    const out = await thinkOnCall(c, turns, d.upstream, (sentence, why) => {
      dropped++;
      const claim = /^claim held: /.test(why);
      d.record({ layer: 8, decision: claim ? "call.claim_held" : "call.offer_unsourced", userId: c.userId, outcome: "skip", action: claim ? "held_claim" : "dropped_sentence", proposal: { provider: "gpt-live", sentence: sentence.slice(0, 240) }, reason: why });
    }).catch((err: any) => { error = true; d.log(`gpt-live: delegation ${id} failed: ${err?.message ?? err}`); return { text: "", timing: null }; });
    // The caller has moved on (said something new since this turn was handed over): the answer is to a question no longer asked.
    const stale = turnsFrom(frags).some((t) => t.who === "member" && t.startMs > seenUpTo && !listeningSound(t.text));
    if (stale) staleDropped++;
    if (!finished && !stale)
      send(ai, out.text
        ? { type: "session.commentary.append", event_id: `answer_${id}`, delegation_id: id, content: out.text }
        : { type: "session.thinking.append", event_id: `answer_${id}`, delegation_id: id, content: "No answer came back this time. Don't guess: say you'll text them on it after the call, or ask them to say more." });
    if (error) d.record({ layer: 8, decision: "call.turn_health", userId: c.userId, outcome: "skip", action: "error", proposal: { provider: "gpt-live", slow: false, error: true } });
    d.record({ layer: 8, decision: "call.turn_latency", userId: c.userId, outcome: "act", action: "gpt_live", proposal: { provider: "gpt-live", sessionId, waitMs, firstTokenMs: out.timing?.upstreamFirstTokenMs ?? null, firstSentenceMs: out.timing?.firstSentenceMs ?? null, totalMs: d.now() - at, chars: out.text.length, dropped, stale, error } });
  };

  const onAi = (raw: unknown) => {
    const m = parse(raw);
    switch (m?.type) {
      case "session.started": {
        if (started || !call) return;
        started = true;
        startedAt = d.now();
        sessionId = String(m.session?.id ?? "");
        const slot = openSessions.get(slotKey);
        if (slot) Object.assign(slot, { startedAt, sessionId });
        markCall(call.callSid, call.userId, "started");
        d.minutes(sessionId, 0, null);
        beat = setInterval(() => d.minutes(sessionId, Math.max(seconds ?? 0, elapsedSecs()), null), d.heartbeatMs);
        (beat as any).unref?.();
        for (const a of early.splice(0)) send(ai, { type: "session.input_audio.append", audio: a });
        // Its own cap, set at admission: 30 minutes, or less when the month's team minutes have less left (gptLive.ts admitSession).
        const capMs = Math.min(call.capMs ?? d.maxSessionMs, d.maxSessionMs);
        timers.push(timer(() => close(call?.budgetLimited ? "budget cap" : "session cap", call?.budgetLimited ? "budget_cap" : "session_cap"), capMs));
        return;
      }
      case "session.output_audio.delta": {
        const b = Buffer.from(String(m.delta ?? ""), "base64");
        if (!b.length) return;
        queue.push(b);
        queued += b.length;
        maxQueuedMs = Math.max(maxQueuedMs, Math.round(queued / 8));
        return drain();
      }
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        if (typeof m.delta !== "string") return;
        const member = m.type === "session.input_transcript.delta";
        frags.push({ who: member ? "member" : "cue", text: m.delta, startMs: Number(m.start_ms) || 0, endMs: Number(m.end_ms) || 0 });
        if (!member) { memberRun = ""; cleared = false; return; }
        memberRun += m.delta;
        // Two words or more, and not a "yeah" or "mm": they're taking the turn.
        if (memberRun.trim().split(/\s+/).length >= 2 && !listeningSound(memberRun)) bargeIn();
        return;
      }
      case "session.delegation.created":
        if (m.delegation?.target === "client" && m.delegation?.id) void delegate(String(m.delegation.id), Number(m.offset_ms) || 0);
        return;
      case "session.usage.updated":
      case "session.closed":
        if (Number.isFinite(Number(m.usage?.seconds))) seconds = Number(m.usage.seconds);
        if (m.type === "session.closed") { reason ||= String(m.reason ?? "closed"); finish(reason, "openai_closed"); }
        return;
      case "error":
        d.log(`gpt-live: error ${m.error?.code ?? "?"}: ${String(m.error?.message ?? "").slice(0, 160)}`);
        if (!started) failClass ??= failClassOf(m.error);
        return;
    }
  };

  const openAi = (c: LiveCall) => {
    const key = d.apiKey();
    if (!key) { failClass = "no_key"; return finish("no OpenAI key", "not_started"); }
    try { ai = d.connectOpenAI(key); } catch (err: any) { failClass = failClassOf(err); return finish(`connect: ${String(err?.message ?? err).slice(0, 80)}`, "not_started"); }
    ai.on("open", () => send(ai, sessionStart(c, gptLiveVoice())));
    ai.on("message", (raw: unknown) => { try { onAi(raw); } catch { /* one bad event never ends the call */ } });
    ai.on("error", (err: any) => { reason ||= `openai: ${String(err?.message ?? err).slice(0, 80)}`; if (!started) failClass ??= failClassOf(err); });
    ai.on("close", () => finish(started ? "openai closed" : reason || "openai refused", started ? "openai_closed" : "not_started"));
  };

  // Twilio's start, then OpenAI's session.started, each within startTimeoutMs; otherwise the call ends cleanly.
  timers.push(timer(() => { if (!call) { d.log("gpt-live: no stream start in time"); finish("no stream start", "not_started"); } }, d.startTimeoutMs));
  twilio.on("message", (raw: unknown) => {
    const m = parse(raw);
    if (m?.event === "start" && !call && !finished) {
      streamSid = String(m.streamSid ?? m.start?.streamSid ?? "");
      slotKey = String(m.start?.customParameters?.s ?? "");
      call = d.takeLink(slotKey);
      if (!call) { d.log("gpt-live: stream refused (no live stream id)"); slotKey = ""; return finish("no live stream id", "not_started"); }
      pump = setInterval(drain, 20);
      (pump as any).unref?.();
      timers.push(timer(() => { if (!started) { failClass ??= "timeout"; finish("session not started in time", "not_started"); } }, d.startTimeoutMs));
      openAi(call);
    } else if (m?.event === "media" && call && typeof m.media?.payload === "string") {
      if (m.media.track && m.media.track !== "inbound") return;
      if (started) send(ai, { type: "session.input_audio.append", audio: m.media.payload });
      else if (early.length < 150) early.push(m.media.payload);
    } else if (m?.event === "stop") close("caller hung up", "caller_hangup");
  });
  twilio.on("close", () => close("caller hung up", "caller_hangup"));
  twilio.on("error", () => close("twilio stream error", "caller_hangup"));
}
