// GPT-Live's audio bridge (services/gptLive.ts): Twilio's bidirectional Media Stream on one side, OpenAI's Live
// WebSocket on the other. Both carry G.711 mu-law at 8 kHz, so audio bytes pass through unconverted; only the framing changes
// (Twilio: {event:"media", media:{payload}}; OpenAI: session.input_audio.append / session.output_audio.delta).
//
// Who the call is comes only from the stream's one-time id (the TwiML route issued it for the verified caller), on top of
// Twilio's signature on the WebSocket handshake (server.ts). Cue's audio goes to Twilio at most GPT_LIVE.leadMs ahead of real time,
// the rest queued here, so when the caller cuts in, little stale audio is left at Twilio.
//
// When the caller cuts in, Twilio's buffer is cleared and the local queue dropped. A delegated answer goes to GPT-Live sentence by
// sentence as the call brain writes it (2026-11-02: waiting for the whole answer held the substance back ~4 s a turn); once the caller
// has moved on, the rest of it is dropped and no longer written. The automatic "let me think" is cancelled the way OpenAI's
// delegation guide shows.
//
// Per call it records: each delegated turn's latency (call.turn_latency, action gpt_live), each reply's gap after the call
// (call.turn_latency, action gpt_live_voice), the session (call.gpt_live_session: seconds, endedBy) and its minutes as it runs
// (gpt_live_minutes, for the month's minutes), all numbers only.
import { timingSafeEqual } from "crypto";
import WebSocket from "ws";
import { recordDecision, type HarnessDecision } from "../harness/core.js";
import { guardCallMessages } from "./whatCoKnows.js";
import { startVoiceTee, type VoiceTee } from "./mediaStreamBridge.js";
import type { OaiRequest } from "./callLlmProxy.js";
import { isVoicemailGreeting } from "../harness/callGate.js";
import { anthropicStream, SAFETY_LINE } from "./callLlmProxy.js";
import { stripCues } from "./voiceCues.js";
import { failClassOf, GPT_LIVE, gptLiveVoice, listeningSound, markCall, onAmd, openSessions, OPEN_NO_STOCK, OPEN_NOW, reasonNote, VOICEMAIL_NOW, replyGaps, sayExactly, sessionStart, takeLiveLink, thinkOnCall, turnsFrom, WRAP_UP, writeMinutes, type FailClass, type Frag, type LiveCall, type LiveTurn, type MessageGuard, type Upstream } from "./gptLive.js";
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
export type EndedBy = "caller_hangup" | "session_cap" | "budget_cap" | "goodbye" | "silence" | "voicemail" | "openai_closed" | "not_started";
// voicemail: GPT-Live was told to leave a message (VOICEMAIL_NOW) at fromMs on the session's transcript timeline; null: it never was.
export type LiveResult = { call: LiveCall; sessionId: string; turns: LiveTurn[]; startedAt: Date; endedAt: Date; seconds: number | null; reason: string; endedBy: EndedBy; voicemail?: { fromMs: number } | null };
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
  silenceEndMs: number;
  endGraceMs: number;
  endWaitMs: number;
  openWaitMs: number;
  wordsSettleMs: number;
  amdHoldMs: number;
  wrapUpMs: number;
  // The live guards for this member (services/whatCoKnows.ts forgottenRows + guardCallMessages), read at most every guardCacheMs.
  guardRows: (userId: string) => Promise<import("./whatCoKnows.js").ForgottenRow[]>;
  guardMessages: (messages: Parameters<MessageGuard>[0], rows: import("./whatCoKnows.js").ForgottenRow[]) => Parameters<MessageGuard>[0];
  // OpenAI's safety filter closed the call during a safety moment: the existing safety path (services/safety.ts recordSafetyConcern:
  // the team alert, the hold, and the gentle check-in the next day).
  safetyCut: (call: LiveCall) => Promise<void>;
  // The Hume voice read (services/mediaStreamBridge.ts startVoiceTee): the caller's frames teed to it, for consented members only.
  startTee: (o: { userId: string; callKey: string; callSid: string | null }) => VoiceTee;
  // Its line for a delegated turn (routes/callLlm.ts voiceLineForTurn), Claude only.
  voiceLine: (callKey: string, req: OaiRequest) => Promise<string | null>;
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
  silenceEndMs: GPT_LIVE.silenceEndMs,
  endGraceMs: GPT_LIVE.endGraceMs,
  endWaitMs: GPT_LIVE.endWaitMs,
  openWaitMs: GPT_LIVE.openWaitMs,
  wordsSettleMs: GPT_LIVE.wordsSettleMs,
  amdHoldMs: GPT_LIVE.amdHoldMs,
  wrapUpMs: GPT_LIVE.wrapUpMs,
  guardRows: (userId) => import("./whatCoKnows.js").then((W) => W.forgottenRows(userId)).catch(() => []),
  guardMessages: (messages, rows) => guardCallMessages(messages, rows),
  startTee: (o) => startVoiceTee(o),
  voiceLine: (callKey, req) => import("../routes/callLlm.js").then((m) => m.voiceLineForTurn(callKey, req)),
  safetyCut: async (call) => {
    const S = await import("./safety.js");
    await S.recordSafetyConcern(call.userId, call.firstName || null, "co", "a GPT-Live call was cut by OpenAI's safety filter during a safety moment");
  },
});
let override: Partial<LiveDeps> | null = null;
export const setLiveDeps = (d: Partial<LiveDeps> | null): void => void (override = d);
const OPEN = 1;
const parse = (raw: unknown): any => { try { return JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return null; } };
const send = (ws: SocketLike | null, m: unknown) => { try { if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(m)); } catch { /* the close handler ends it */ } };
const timer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; };

// Pure: whether Cue's end_call may hang up now, on facts only (never reading their words for intent): Cue's last line doesn't end on a
// question, nothing of theirs was heard after Cue's last line started, and they aren't speaking now. null: it may; else why not.
export function endGuard(o: { cueLast: { text: string; startMs: number } | null; memberAfterMs: number | null; memberHeardAgoMs: number | null; graceMs: number }): "cue_asked" | "member_spoke_after" | "member_speaking" | "no_goodbye" | null {
  if (!o.cueLast) return "no_goodbye";
  if (/\?["'\u201d\u2019)\]]*\s*$/.test(o.cueLast.text.trim())) return "cue_asked";
  if (o.memberAfterMs != null && o.memberAfterMs >= o.cueLast.startMs) return "member_spoke_after";
  if (o.memberHeardAgoMs != null && o.memberHeardAgoMs < o.graceMs) return "member_speaking";
  return null;
}

export function handleGptLiveStream(twilio: SocketLike): void {
  const d: LiveDeps = { ...defaults(), ...(override ?? {}) };
  let call: LiveCall | null = null;
  let ai: SocketLike | null = null;
  let streamSid = "", slotKey = "", sessionId = "", reason = "", seconds: number | null = null;
  let endedBy: EndedBy | null = null;
  let failClass: FailClass | null = null; // why OpenAI didn't start, when it didn't
  // The most telling cause wins: a harmless early error event ("refused") never masks a later balance, key or timeout failure.
  const RANK: Record<FailClass, number> = { quota: 6, auth: 6, no_key: 6, rate_limit: 5, connect: 4, timeout: 3, refused: 1, no_stream: 0 };
  const noteFail = (c: FailClass) => { if (!failClass || RANK[c] > RANK[failClass]) failClass = c; };
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
  let quiet: ReturnType<typeof setInterval> | null = null;
  let lastHeard = t0; // the last words either side said (transcripts), for the silence and goodbye ends
  let safetyMoment = false; // a delegated answer on this call carried a crisis or safety line (out.exact)
  // Cue's thinking called end_call: hang up once its goodbye has played and endGraceMs passed, if endGuard allows.
  let pendingEnd: { at: number; fromMs: number } | null = null;
  let memberHeardAt: number | null = null; // wall clock of their last transcript fragment
  let voicemailAt: number | null = null; // when GPT-Live was told to leave a message (Twilio's AMD heard a machine)
  let voicemailMs = 0; // where the session's transcript timeline was then: Cue's words after it are the message
  // Outbound: when a person was confirmed on the line (AMD's human verdict, or their real words once settled); inbound: from the start.
  // Until then no thinking answer is spoken and GPT-Live hasn't been given the call's reason (review of #333: an answer could reach a
  // voicemail before Twilio's verdict).
  let personAt: number | null = null;
  let opened = false; // outbound: whether the opening has happened (their first words, AMD's human verdict, or the wait ran out)
  let stopWaiting: () => void = () => {};
  let tee: VoiceTee | null = null; // the voice read, while it runs
  let guardAt = 0, guardRowsP: Promise<import("./whatCoKnows.js").ForgottenRow[]> | null = null;
  const elapsedSecs = () => Math.round((d.now() - startedAt) / 1000);
  // A person really spoke: two words or more, not a "yeah" or "mm", and not a voicemail greeting. Used only to call a machine verdict a
  // misfire (which only holds back the voicemail message); it never releases anything private.
  const realWords = (t: LiveTurn) => t.who === "member" && !listeningSound(t.text) && !isVoicemailGreeting(t.text) && t.text.split(/\s+/).length >= 2;
  // Outbound: held answers and the reason are released only on AMD's verdict (human, or unknown), or when AMD never answered by
  // amdHoldMs (review of #333: never on a reading of their words, which a custom greeting can pass).
  let amdVerdict: string | null = null;
  // After a misfire (a machine verdict after real words) nothing is released for the rest of the call (review of #337: words after the
  // verdict can be a greeting's tail, since AMD's speech-end threshold can fire mid-greeting). A real person given a false machine verdict
  // loses only the thinking's answers on that call; the follow-up text still goes.
  const confirmPerson = (via: "amd_human" | "amd_unknown" | "amd_timeout") => {
    if (personAt != null || voicemailAt != null || finished || !call) return;
    personAt = d.now();
    d.record({ layer: 8, decision: "call.gpt_live_person", userId: call.userId, outcome: "act", action: via, proposal: { provider: "gpt-live", sessionId, via } });
    // The reason reaches GPT-Live only now, as silent context (never in its instructions, where any line of its own could carry it).
    if (call.opening.reason) send(ai, { type: "session.thinking.append", event_id: "reason", delegation_id: null, content: reasonNote(call.opening.reason) });
  };

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

  // Once per call: OpenAI's safety filter closed it (content) and a thinking answer on it carried a crisis or safety line, whether the
  // line was seen before the close or written after it (review of #345: an answer still being written when the filter cut in).
  let safetyCutDone = false;
  const safetyCutIfDue = () => {
    if (safetyCutDone || !call || !started || !finished || endedBy !== "openai_closed" || reason !== "content" || !safetyMoment) return;
    safetyCutDone = true;
    d.record({ layer: 8, decision: "call.gpt_live_safety_cut", userId: call.userId, outcome: "act", action: "safety_path", proposal: { provider: "gpt-live", sessionId } });
    d.safetyCut(call).catch((err: any) => d.log(`gpt-live: safety path failed for ${sessionId}: ${err?.message ?? err}`));
  };
  const finish = (why: string, by: EndedBy) => {
    if (finished) return;
    finished = true;
    reason ||= why;
    endedBy ??= by;
    for (const t of timers) clearTimeout(t);
    if (pump) clearInterval(pump);
    if (beat) clearInterval(beat);
    if (quiet) clearInterval(quiet);
    stopWaiting();
    if (tee) { tee.end(reason || why); tee = null; }
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
    // OpenAI's safety filter ended the call while it was on their safety: the team hears now and they get the safety path's follow-up.
    safetyCutIfDue();
    d.postCall({ call, sessionId, turns, startedAt: new Date(startedAt), endedAt: new Date(d.now()), seconds: secs, reason, endedBy: endedBy!, voicemail: voicemailAt != null ? { fromMs: voicemailMs } : null }).catch((err: any) => d.log(`gpt-live: post-call failed for ${sessionId}: ${err?.message ?? err}`));
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
    const memberEnd = () => frags.reduce((m, f) => (f.who === "member" ? Math.max(m, f.endMs) : m), 0);
    // Measured (2026-11-02: 6 of 8 delegations on 10-31 waited the whole catchUpMs): how far the transcript trailed the handover, and
    // whether the wait brought in any words of theirs. Numbers only.
    const lagMs = Math.max(0, offsetMs - latest());
    const memberEndBefore = memberEnd();
    while (d.now() - at < GPT_LIVE.catchUpMs && latest() < offsetMs - 300) await new Promise((r) => setTimeout(r, 50));
    const waitMs = d.now() - at;
    const waitAddedWords = memberEnd() > memberEndBefore;
    const turns = turnsFrom(frags);
    const theirTurnEnd = turns.filter((t) => t.who === "member").reduce((m, t) => Math.max(m, t.endMs), 0);
    const seenUpTo = Math.max(offsetMs, ...turns.filter((t) => t.who === "member").map((t) => t.startMs));
    let dropped = 0, error = false;
    const c = call;
    // The live guards, read at most every guardCacheMs: a correction or removal texted during the call reaches this turn.
    const guard: MessageGuard = async (messages) => {
      if (!guardRowsP || d.now() - guardAt > GPT_LIVE.guardCacheMs) { guardAt = d.now(); guardRowsP = d.guardRows(c.userId).catch(() => []); }
      const rows = await guardRowsP;
      return rows.length ? d.guardMessages(messages, rows) : messages;
    };
    // The caller has moved on (said something new since this turn was handed over): the answer, or what's left of it, is to a
    // question no longer asked.
    const movedOn = () => turnsFrom(frags).some((t) => t.who === "member" && t.startMs > seenUpTo && !listeningSound(t.text));
    // Streamed when a person is on the line (inbound from the start; outbound once confirmed, else the answer is held as before): each
    // sentence the call brain lets through goes to GPT-Live as commentary as soon as it's written, sentences that arrive together in
    // one append. A sentence carrying a crisis or safety line, and everything after it, waits for the end of the answer and goes word
    // for word (sayExactly), as a whole safety answer always has. Once they've moved on, nothing more is sent or written.
    let pending = "", exactRest = "", appends = 0, sentChars = 0, cut = false;
    let firstSendMs: number | null = null;
    let burst: ReturnType<typeof setImmediate> | null = null;
    const eventId = () => (appends ? `answer_${id}_${appends + 1}` : `answer_${id}`);
    const spoken = (t: string) => stripCues(t).replace(/\s+/g, " ").trim();
    const flush = () => {
      burst = null;
      const text = spoken(pending);
      pending = "";
      if (!text || cut || finished || voicemailAt != null) return;
      if (movedOn()) { cut = true; return; }
      if (sentChars + text.length > GPT_LIVE.commentaryMaxChars) return;
      sentChars += text.length;
      send(ai, { type: "session.commentary.append", event_id: eventId(), delegation_id: id, content: text });
      appends++;
      firstSendMs ??= d.now() - at;
    };
    const onSentence = (t: string): boolean => {
      if (cut || finished || voicemailAt != null) return false;
      if (movedOn()) { cut = true; return false; }
      // A crisis or safety line: this is a safety moment from now (review of #345: set here, not from the finished answer, so a stream
      // that fails after it, or an answer longer than one append, still takes the safety-cut path on a content close). Anything not yet
      // handed on joins it, so nothing is paraphrased once the line has been seen; it and everything after it go word for word.
      if (exactRest || SAFETY_LINE.test(t)) { safetyMoment = true; exactRest += pending + t; pending = ""; return true; }
      pending += t;
      burst ??= setImmediate(flush);
      return true;
    };
    const out = await thinkOnCall(c, turns, d.upstream, (sentence, why) => {
      dropped++;
      const claim = /^claim held: /.test(why);
      d.record({ layer: 8, decision: claim ? "call.claim_held" : "call.offer_unsourced", userId: c.userId, outcome: "skip", action: claim ? "held_claim" : "dropped_sentence", proposal: { provider: "gpt-live", sentence: sentence.slice(0, 240) }, reason: why });
    }, guard, d.voiceLine, personAt != null ? onSentence : undefined).catch((err: any) => { error = true; d.log(`gpt-live: delegation ${id} failed: ${err?.message ?? err}`); return { text: "", timing: null, safety: false, exact: false, endCall: false, streamed: false, stopped: false }; });
    const streamed = out.streamed || appends > 0 || !!exactRest;
    // The last sentences, written together at the end: sent now, unless the thinking ended the call (its goodbye is GPT-Live's own).
    if (burst) { clearImmediate(burst); burst = null; if (out.endCall) pending = ""; else flush(); }
    // Only an answer that itself carried a crisis or safety line makes this a safety moment (review of #331: safetyCall reads the whole
    // call, so "I'm safe from the layoffs" then a content close set off the safety path).
    if (out.exact) { safetyMoment = true; safetyCutIfDue(); }
    // Outbound: the answer is held until a person is confirmed on the line; still held when the voicemail message is asked for, it's
    // dropped (below, logged).
    const heldFrom = d.now();
    while (personAt == null && voicemailAt == null && !finished) await new Promise((r) => setTimeout(r, 50));
    const heldMs = d.now() - heldFrom;
    const movedNow = movedOn();
    // Stale: some of the answer went unsaid because they had moved on (streamed: what went out before that was said in time).
    const stale = streamed ? cut || (movedNow && (!!exactRest || (!appends && !!out.text))) : movedNow;
    if (stale) staleDropped++;
    // Their voicemail is recording (review of #333: someone else may hear it): no thinking answer is ever spoken from here on.
    const onVoicemail = voicemailAt != null;
    if (onVoicemail) d.record({ layer: 8, decision: "call.gpt_live_answer_dropped", userId: c.userId, outcome: "skip", action: "voicemail", proposal: { provider: "gpt-live", sessionId, chars: out.text.length, heldMs } });
    // Cue's thinking ended the call: GPT-Live has said its own goodbye, so nothing is sent (no answer to repeat it, and no "no answer"
    // note, which made it answer an echoed "bye" with "I'll text you"; review of #331).
    // An empty answer with no end_call after GPT-Live already spoke this turn (its own goodbye, say): no "no answer" note, which would
    // have it say one more line (review of #333). Spoke this turn: a line of its own that started after their turn ended, allowing
    // goodbyeOverlapMs of overlap. A failed answer always gets the note (review of #337: a real question still gets the fallback).
    const fromMs = Math.max(0, theirTurnEnd - GPT_LIVE.goodbyeOverlapMs);
    const spokeThisTurn = turnsFrom(frags).some((t) => t.who === "cue" && t.startMs >= fromMs);
    const noteSkipped = !out.text && !out.endCall && !error && spokeThisTurn;
    const noAnswer = { type: "session.thinking.append", event_id: `answer_${id}`, delegation_id: id, content: "No answer came back this time. Don't guess: say you'll text them on it after the call, or ask them to say more." };
    if (!finished && !movedNow && !onVoicemail && !out.endCall && !noteSkipped) {
      if (!streamed)
        send(ai, out.text
          ? out.exact
            ? { type: "session.instructions.append", event_id: `answer_${id}`, delegation_id: id, content: sayExactly(out.text) }
            : { type: "session.commentary.append", event_id: `answer_${id}`, delegation_id: id, content: out.text }
          : noAnswer);
      else if (exactRest) {
        send(ai, { type: "session.instructions.append", event_id: eventId(), delegation_id: id, content: sayExactly(spoken(exactRest).slice(0, GPT_LIVE.commentaryMaxChars)) });
        appends++;
        firstSendMs ??= d.now() - at;
      } else if (!out.text && !appends) send(ai, noAnswer);
    }
    if (out.endCall && !finished && !movedNow && !onVoicemail) pendingEnd = { at: d.now(), fromMs };
    if (error) d.record({ layer: 8, decision: "call.turn_health", userId: c.userId, outcome: "skip", action: "error", proposal: { provider: "gpt-live", slow: false, error: true } });
    // firstSendMs: from the handover to the first words of the answer reaching GPT-Live (streamed), the number the caller waits on.
    d.record({ layer: 8, decision: "call.turn_latency", userId: c.userId, outcome: "act", action: "gpt_live", proposal: { provider: "gpt-live", sessionId, waitMs, lagMs, waitAddedWords, firstTokenMs: out.timing?.upstreamFirstTokenMs ?? null, firstSentenceMs: out.timing?.firstSentenceMs ?? null, firstSendMs, totalMs: d.now() - at, chars: out.text.length, streamed, appends, dropped, stale, error, exact: !!out.exact, heldMs, noteSkipped, endAfterText: out.endCall && appends > 0 } });
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
        // The voice read starts with the session, from the same caller frame as OpenAI's, for a member it's on for (decided at the
        // TwiML route); its own consent reads run again inside (mediaStreamBridge.ts admitVoiceSession). Never awaited.
        if (call.voiceOn) { try { tee = d.startTee({ userId: call.userId, callKey: call.callKey, callSid: call.callSid }); } catch { tee = null; } }
        for (const a of early.splice(0)) { send(ai, { type: "session.input_audio.append", audio: a }); tee?.push(a); }
        // Its own cap, set at admission: 30 minutes, or less when the month's minutes have less left (gptLive.ts admitSession).
        // One activity timer (OpenAI: "use an application-controlled inactivity timeout"). With nothing playing: silenceEndMs with
        // nothing said either way ends the call (the ElevenLabs agent's silence_end_call_timeout). And Cue's own end_call (the thinking
        // decides, on a delegated goodbye): once its goodbye has been said and played and endGraceMs has passed, it hangs up if endGuard
        // allows on facts; refused, the call stays open and call.end_refused says why.
        // Outbound: the person who picks up usually speaks first ("Hello?"), so GPT-Live opens once they do (it answers them), once
        // Twilio's AMD says a human answered, or after openWaitMs if neither came; never over a voicemail greeting (review of #333).
        // GPT-Live's own lines (the opening, which carries no reason) are instant; delegated answers and the reason wait for AMD's verdict.
        // AMD heard a machine whose greeting ended: unless they already said real words (a misfire, logged, as the ElevenLabs path's
        // verdict treats it: no message, and held answers stay held), GPT-Live is told to leave the privacy-limited message
        // (VOICEMAIL_NOW), and from then on no thinking answer is ever spoken. Words still arriving then are let settle first.
        if (call.direction === "inbound") personAt = d.now();
        if (call.direction === "outbound") {
          const c = call;
          const openNow = (why: string) => {
            if (opened || voicemailAt != null || finished) return;
            opened = true;
            d.record({ layer: 8, decision: "call.gpt_live_open", userId: c.userId, outcome: "act", action: why, proposal: { provider: "gpt-live", sessionId } });
            // A thinking append (10-31 smoke: an instructions.append asking it to open left it silent; this opened it, in its own words).
            send(ai, { type: "session.thinking.append", event_id: "open", delegation_id: null, content: `${OPEN_NOW} ${OPEN_NO_STOCK}` });
          };
          timers.push(timer(() => { if (!frags.some((f) => f.who === "member")) openNow("no_words_in_time"); }, d.openWaitMs));
          // AMD never answered within its own window: held answers are released as unknown, logged (via amd_timeout).
          timers.push(timer(() => { if (amdVerdict == null) confirmPerson("amd_timeout"); }, d.amdHoldMs));
          // (Declared before onAmd, which calls back at once when the verdict came before the stream.)
          const leaveMessage = () => {
            voicemailAt = d.now();
            opened = true;
            pendingEnd = null;
            voicemailMs = frags.reduce((m, f) => Math.max(m, f.endMs), 0);
            send(ai, { type: "session.instructions.append", event_id: "voicemail", delegation_id: null, content: VOICEMAIL_NOW });
          };
          stopWaiting = onAmd(c.callSid, (by) => {
            amdVerdict ??= by;
            if (by === "human") { confirmPerson("amd_human"); return openNow("amd_human"); }
            if (by === "unknown") return confirmPerson("amd_unknown");
            if (!/^machine_end_/.test(by)) return void d.record({ layer: 8, decision: "call.gpt_live_amd", userId: c.userId, outcome: "skip", action: by, proposal: { provider: "gpt-live", sessionId } });
            const decide = () => {
              if (voicemailAt != null || finished) return;
              if (memberHeardAt != null && d.now() - memberHeardAt < d.wordsSettleMs) return void timers.push(timer(decide, d.wordsSettleMs - (d.now() - memberHeardAt) + 10));
              // A misfire holds back the voicemail message only; held answers and the reason stay held (AMD said machine).
              const spoke = turnsFrom(frags).some(realWords);
              d.record({ layer: 8, decision: "call.gpt_live_amd", userId: c.userId, outcome: spoke ? "skip" : "act", action: spoke ? "misfire" : "leave_message", proposal: { provider: "gpt-live", sessionId } });
              if (spoke) return;
              leaveMessage();
            };
            decide();
          });
        }
        lastHeard = d.now();
        quiet = setInterval(() => {
          const now = d.now();
          if (queued || playhead > now) return;
          if (now - lastHeard >= d.silenceEndMs) return close("silence", "silence");
          // The voicemail message has been said and has finished playing: the call ends, as the ElevenLabs voicemail tool ends it.
          if (voicemailAt != null) {
            if (frags.some((f) => f.who === "cue" && f.startMs >= voicemailMs) && now - lastHeard >= d.endGraceMs) close("voicemail", "voicemail");
            return;
          }
          const pend = pendingEnd;
          if (!pend || !call) return;
          const turns = turnsFrom(frags);
          const cueTurns = turns.filter((t) => t.who === "cue" && t.startMs >= pend.fromMs);
          if (!cueTurns.length) {
            if (now - pend.at < d.endWaitMs) return;
            d.record({ layer: 8, decision: "call.end_refused", userId: call.userId, outcome: "skip", action: "no_goodbye", proposal: { provider: "gpt-live", sessionId } });
            pendingEnd = null;
            return;
          }
          if (now - lastHeard < d.endGraceMs) return;
          const cueLast = [...turns].reverse().find((t) => t.who === "cue") ?? null;
          const memberAfter = turns.filter((t) => t.who === "member" && !listeningSound(t.text)).reduce<number | null>((m, t) => Math.max(m ?? -1, t.startMs), null);
          const why = endGuard({ cueLast, memberAfterMs: memberAfter, memberHeardAgoMs: memberHeardAt == null ? null : now - memberHeardAt, graceMs: d.endGraceMs });
          pendingEnd = null;
          if (why) return d.record({ layer: 8, decision: "call.end_refused", userId: call.userId, outcome: "skip", action: why, proposal: { provider: "gpt-live", sessionId } });
          close("goodbye", "goodbye");
        }, Math.max(10, Math.min(500, Math.floor(Math.min(d.endGraceMs, d.silenceEndMs) / 4))));
        (quiet as any).unref?.();
        const capMs = Math.min(call.capMs ?? d.maxSessionMs, d.maxSessionMs);
        // About a minute before the cap, GPT-Live is asked to bring the call to a close in its own words (no set line).
        if (capMs > 2 * d.wrapUpMs) timers.push(timer(() => send(ai, { type: "session.instructions.append", event_id: "wrap_up", delegation_id: null, content: WRAP_UP }), capMs - d.wrapUpMs));
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
        // Outbound: their first words are the cue to open; GPT-Live answers them on its own.
        if (member && !opened && call?.direction === "outbound" && m.delta.trim()) {
          opened = true;
          d.record({ layer: 8, decision: "call.gpt_live_open", userId: call.userId, outcome: "act", action: "their_first_words", proposal: { provider: "gpt-live", sessionId } });
        }
        lastHeard = d.now();
        if (member) memberHeardAt = d.now();
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
        if (!started) noteFail(failClassOf(m.error));
        return;
    }
  };

  const openAi = (c: LiveCall) => {
    const key = d.apiKey();
    if (!key) { failClass = "no_key"; return finish("no OpenAI key", "not_started"); }
    try { ai = d.connectOpenAI(key); } catch (err: any) { failClass = failClassOf(err); return finish(`connect: ${String(err?.message ?? err).slice(0, 80)}`, "not_started"); }
    ai.on("open", () => send(ai, sessionStart(c, gptLiveVoice())));
    ai.on("message", (raw: unknown) => { try { onAi(raw); } catch { /* one bad event never ends the call */ } });
    ai.on("error", (err: any) => { reason ||= `openai: ${String(err?.message ?? err).slice(0, 80)}`; if (!started) noteFail(failClassOf(err)); });
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
      timers.push(timer(() => { if (!started) { noteFail("timeout"); finish("session not started in time", "not_started"); } }, d.startTimeoutMs));
      openAi(call);
    } else if (m?.event === "media" && call && typeof m.media?.payload === "string") {
      if (m.media.track && m.media.track !== "inbound") return;
      if (started) { send(ai, { type: "session.input_audio.append", audio: m.media.payload }); tee?.push(m.media.payload); }
      else if (early.length < 150) early.push(m.media.payload);
    } else if (m?.event === "stop") close("caller hung up", "caller_hangup");
  });
  twilio.on("close", () => close("caller hung up", "caller_hangup"));
  twilio.on("error", () => close("twilio stream error", "caller_hangup"));
}
