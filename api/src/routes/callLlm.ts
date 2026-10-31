// The call brain's endpoint for ElevenLabs (services/callLlmProxy.ts): POST /co/el/llm/chat/completions, OpenAI chat-completions in,
// server-sent events out. Mounted before the general rate limiter (a call is a request per turn, from one address).
// Auth: the bearer token ElevenLabs holds as a workspace secret (CALL_LLM_PROXY_SECRET). Who the call is comes from the extra body we
// attach when the call is registered, and is checked with the call token like the agent's tools are.
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { recordDecision } from "../harness/core.js";
import { exchangeText } from "../services/theirYes.js";
import { verifyCallToken } from "../services/elevenLabsCalls.js";
import { noteTraceUser } from "../services/llmTraceText.js";
import { anthropicStream, capTurn, runCallLlm, safetyCall, TurnDeadline, type TurnDeadlineKind, type ARequest, type AnthropicEvent, type OaiChunk, type OaiRequest, type ProxyDeps } from "../services/callLlmProxy.js";
import { setScopeMember, withMember } from "../services/llmUsage.js";
import { commitmentProblem, trackCallCommitment } from "../services/callCommitments.js";
import type { CallToolset, MemberOnCall } from "../services/callTools.js";
import { voiceReadLineFor } from "../services/mediaStreamBridge.js";

// This turn's voice line, if the call has a voice read and it found something strong (services/voiceRead.ts). Only this
// call's own session (keyed by its user and call token) and only their own words; anything wrong means no line.
export function voiceLineForTurn(callKey: string, body: OaiRequest): string | null {
  try {
    const w = callWordsOf(body);
    return voiceReadLineFor(callKey, w.turnWords, w.callWords.split("\n"), { safety: safetyCall(body) })?.line ?? null;
  } catch {
    return null;
  }
}

const textOfMsg = (m: OaiRequest["messages"][number] | undefined): string =>
  typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m!.content.map((p: any) => p?.text ?? "").join("") : "";

// Pure: what the member said this turn (their lines since Co last spoke), everything they said on the call, and Co's last line.
// Cue's own words AFTER their last line are this same turn, not a new one: ElevenLabs re-sends a turn it gave up waiting on with what
// Cue had already said appended (2026-10-31 call: the second and third tries read their turn as empty, so startTask's quote check had
// nothing to check against). Those trailing lines are skipped; the turn is still their last words. A re-prompt after their silence
// (Cue's whole line last) reads the same way and shares that turn's dedupe key (services/callTools.ts turnKeyOf): intended. An empty
// line of theirs after Cue's newest line is an empty turn, never their older words (review of #327).
export function callWordsOf(b: OaiRequest): { turnWords: string; callWords: string; lastCoLine: string | null; recentExchange: string } {
  const msgs = b.messages.filter((m) => m.role === "user" || (m.role === "assistant" && textOfMsg(m).trim()));
  let end = msgs.length;
  while (end > 0 && msgs[end - 1].role === "assistant" && msgs.slice(0, end - 1).some((m) => m.role === "user")) end--;
  let i = end;
  while (i > 0 && msgs[i - 1].role === "user") i--;
  const lastCo = i > 0 ? textOfMsg(msgs[i - 1]).trim() : "";
  return {
    turnWords: msgs.slice(i, end).map(textOfMsg).join(" ").trim(),
    callWords: msgs.filter((m) => m.role === "user").map(textOfMsg).join("\n"),
    lastCoLine: lastCo || null,
    // The turns before this one, for the yes read on a confirm tool (services/theirYes.ts).
    recentExchange: exchangeText(msgs.slice(0, i).map((m) => ({ side: m.role === "user" ? ("member" as const) : ("co" as const), text: textOfMsg(m) }))),
  };
}

// The member's details the call tools need, read once per call and again after a tool changes them (services/callTools.ts).
const memberCache = new Map<string, { at: number; m: Promise<MemberOnCall> }>();
// The last good stop-suggesting list per call (an hour outlasts any call).
const lastAvoid = new Map<string, { at: number; avoid: string[] }>();
const LAST_AVOID_MS = 60 * 60_000;
const MEMBER_CACHE_MS = 60_000;
function memberOnCall(key: string, userId: string, fresh = false): Promise<MemberOnCall> {
  const now = Date.now();
  for (const [k, v] of memberCache) if (now - v.at > MEMBER_CACHE_MS) memberCache.delete(k);
  for (const [k, v] of lastAvoid) if (now - v.at > LAST_AVOID_MS) lastAvoid.delete(k);
  const hit = memberCache.get(key);
  if (hit && !fresh) return hit.m;
  // A re-read whose avoid list couldn't be read keeps the last good one, kept per call apart from the 60s cache (re-review of #139: the
  // cache entry had usually expired by then, so the note still dropped on any call over a minute).
  const m = import("../services/callTools.js").then((t) => t.loadMemberOnCall(userId)).then((x) => {
    if (x.avoid !== undefined) lastAvoid.set(key, { at: Date.now(), avoid: x.avoid });
    return x.avoid === undefined && lastAvoid.has(key) ? { ...x, avoid: lastAvoid.get(key)!.avoid } : x;
  });
  memberCache.set(key, { at: now, m });
  m.catch(() => memberCache.delete(key));
  return m;
}

// What they corrected or removed (services/whatCoKnows.ts live guards), per call: read at most every 20 seconds, and again right after
// a tool acts, so a change made by text during the call, or by a tool on it, reaches the next turn.
const guardCache = new Map<string, { at: number; rows: Promise<import("../services/whatCoKnows.js").ForgottenRow[]> }>();
const GUARD_CACHE_MS = 20_000;
function liveGuardsFor(key: string, userId: string, fresh = false) {
  const now = Date.now();
  for (const [k, v] of guardCache) if (now - v.at > GUARD_CACHE_MS) guardCache.delete(k);
  const hit = guardCache.get(key);
  if (hit && !fresh) return hit.rows;
  const rows = import("../services/whatCoKnows.js").then((W) => W.forgottenRows(userId)).catch(() => []);
  guardCache.set(key, { at: now, rows });
  return rows;
}

export const proxyAuthorized = (header: string | undefined, secret = process.env.CALL_LLM_PROXY_SECRET): boolean => {
  if (!secret || !header) return false;
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
};

// Co's line before their last one: what a vague "I'll send that over" was about.
const coLineBefore = (b: OaiRequest): string => {
  const at = b.messages.map((x) => x.role).lastIndexOf("user");
  const m = [...b.messages.slice(0, Math.max(0, at))].reverse().find((x) => x.role === "assistant" && (typeof x.content === "string" ? x.content.trim() : Array.isArray(x.content)));
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m!.content.map((p: any) => p?.text ?? "").join("") : "";
};

const lastUserLine = (b: OaiRequest): string => {
  const m = [...b.messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m!.content.map((p: any) => p?.text ?? "").join("") : "";
};

// The upstream gets the call's member so each turn's cost row names them (llm_usage "call.turn").
// signal: the turn's deadlines stop the model request (services/callLlmProxy.ts capTurn).
export type CallUpstream = (req: ARequest, userId: string | null, signal?: AbortSignal) => AsyncIterable<AnthropicEvent>;
const realUpstream: CallUpstream = (req, userId, signal) => anthropicStream(req, undefined, undefined, userId, signal);

// Deadlines: tests only (short ones); a call always runs on services/callLlmProxy.ts CALL_FIRST_WORDS_MS and the rest.
export function createCallLlmRouter(upstream: CallUpstream = realUpstream, o: { firstMs?: number; gapMs?: number; ceilingMs?: number; silenceMs?: number; heartbeatMs?: number } = {}): Router {
  const router = Router();
  // Every model call a turn makes (its tools, a task it starts) is the call's member's (services/llmUsage.ts withMember).
  const handler = (req: Request, res: Response) => withMember(null, () => handleTurn(req, res));
  const handleTurn = async (req: Request, res: Response) => {
    if (!process.env.CALL_LLM_PROXY_SECRET) return res.status(503).json({ error: "the call brain endpoint is not configured" });
    if (!proxyAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });
    const body = req.body as OaiRequest;
    if (!body || !Array.isArray(body.messages)) return res.status(400).json({ error: "messages required" });
    const extra = body.elevenlabs_extra_body ?? {};
    const userId = verifyCallToken(String(extra.user_id ?? ""), extra.call_token) ? String(extra.user_id) : null;
    noteTraceUser(userId); // this call turn's model calls, under them in our trace text (services/llmTraceText.ts)
    setScopeMember(userId);
    const theirLine = lastUserLine(body);
    const coBefore = coLineBefore(body);
    const t0 = Date.now();
    // The agent's mode (custom_llm request_headers, services/elevenLabsCalls.ts): voice-only keeps the voice speakable and one question
    // to a turn, and does nothing else (no tools, no checks).
    const voiceOnly = String(req.headers["x-co-mode"] ?? "") === "voice";
    // Co's own tools on the call (services/callTools.ts), for the verified member only. CALL_TOOLS=off is the kill switch.
    const callKey = `${userId}:${String(extra.call_token ?? "")}`;
    let tools: CallToolset | null = null;
    if (userId && !voiceOnly && process.env.CALL_TOOLS !== "off") {
      try {
        const T = await import("../services/callTools.js");
        const member = await memberOnCall(callKey, userId);
        tools = T.buildCallTools({ userId, callKey, member, ...callWordsOf(body) });
        // What this call can text them by name, read now so a send later in the call doesn't wait on it.
        T.warmCallOnFile(callKey, userId);
      } catch (err: any) {
        console.error("co/el/llm: call tools unavailable this turn:", err?.message ?? err);
      }
    }
    let toolRuns = 0, toolOk = 0;
    // Each of Cue's tools this turn: its name, how long it took, and how it came back (for the latency record; no words).
    const toolTimes: { name: string; ms: number; outcome: "done" | "not_done" | "still_running" }[] = [];
    // What came back done this turn, with what each was about: a spoken "I'll text you X" is kept by a tool only when that tool did X.
    const doneThisTurn: { name: string; input: unknown; result: unknown }[] = [];
    // A spoken commitment opens a promise task when the turn ends, and only when no tool acted this turn (the deed is on record).
    const commitments: string[] = [];
    let timing: { upstreamFirstTokenMs: number; firstSentenceMs: number } | null = null;
    let spoken = 0, dropped = 0;
    // What was said aloud and which of Cue's tools came back, for the after-turn check when the cap ends the turn.
    const spokenLines: string[] = [];
    const ranTools: string[] = [];
    // The after-call health check reads these (services/callHealth.ts): the turn hit its time budget or a tool was still running at
    // it, or the model failed. Codes only.
    let slow = false, brainError = false;
    // The turn's deadline, when one ended it (services/callLlmProxy.ts capTurn), and the empty chunks it sent; capTurn aborts the
    // model request in flight and the turn's own reports stop (ProxyDeps.signal).
    let deadline: { kind: TurnDeadlineKind; ended: "backup" | "said" } | null = null;
    let heartbeats = 0;
    const stop = new AbortController();
    const deps: ProxyDeps = {
      stream: (r) => upstream(r, userId, stop.signal),
      startedAt: t0,
      signal: stop.signal,
      ...(o.silenceMs ? { silenceMs: o.silenceMs } : {}),
      clean: process.env.CALL_LLM_CLEAN !== "off",
      voiceOnly,
      onSpoken: (s) => {
        spoken++;
        spokenLines.push(s);
        // A spoken "I'll text you the links" opens a task when the turn ends (below), unless a tool already did the thing.
        if (userId && commitmentProblem(s) === null) commitments.push(s);
      },
      tools,
      onTool: (t) => {
        toolRuns++;
        ranTools.push(t.name);
        if (t.timedOut) slow = true;
        if (!t.timedOut && (t.result as any)?.ok !== false) toolOk++;
        toolTimes.push({ name: t.name, ms: t.ms, outcome: t.timedOut ? "still_running" : (t.result as any)?.ok === false ? "not_done" : "done" });
        if (!t.timedOut && (t.result as any)?.ok !== false) doneThisTurn.push({ name: t.name, input: t.input, result: t.result });
        console.log(`co/el/llm: tool ${t.name} ${t.timedOut ? "still running at the budget" : (t.result as any)?.ok === false ? "not done" : "done"} in ${t.ms}ms`);
        // What the tool changed (a task, a loop, what Co knows about them) is read fresh for the next turn.
        if (userId) memberOnCall(callKey, userId, true).catch(() => {});
        if (userId) void liveGuardsFor(callKey, userId, true);
      },
      onDropped: (s, why) => {
        dropped++;
        // A held claim of doing something isn't an unsourced offer: it has its own decision (services/callClaims.ts).
        const claim = /^claim held: /.test(why);
        if (userId) recordDecision({ layer: 8, decision: claim ? "call.claim_held" : "call.offer_unsourced", userId, outcome: "skip", action: claim ? "held_claim" : "dropped_sentence", proposal: { sentence: s.slice(0, 240) }, reason: why }).catch(() => {});
      },
      onToolRound: (r) => { if (r.overBudget) slow = true; },
      onFirstText: (t) => { timing = t; },
      // The turn ended on the last-resort line: a member who didn't get help (harness/failureCount.ts counts it).
      onLastResort: (line) => {
        if (userId) recordDecision({ layer: 8, decision: "call.last_resort", userId, outcome: "skip", action: "last_resort_line", proposal: { line } }).catch(() => {});
      },
      // The brain's judgment of this turn (brain/index.ts judgeCallTurn), logged as brain.call without waiting.
      onDecision: (d) => { if (userId) import("../brain/index.js").then((B) => B.logCallTurn(userId, d)).catch(() => {}); },
      // The live voice read (services/mediaStreamBridge.ts): whatever Hume has already scored, read synchronously, never awaited.
      voiceRead: userId && !voiceOnly ? voiceLineForTurn(callKey, body) : null,
    };
    // The call's instructions through the live guards, every turn (services/whatCoKnows.ts guardCallMessages).
    if (userId) {
      const rows = await liveGuardsFor(callKey, userId);
      if (rows.length) body.messages = (await import("../services/whatCoKnows.js")).guardCallMessages(body.messages, rows);
      // They turned the voice read off earlier on this call: its lines are gone from every later turn (services/voiceReadConsent.ts).
      if ((await import("../services/callTools.js")).callVoiceReadOff(callKey)) body.messages = (await import("../services/voiceReadConsent.js")).stripVoiceReadLines(body.messages);
    }
    // Silence is capped, not length (Royce, 2026-10-31: three tries of one turn ran 10-14s each against a 3s timeout, and the call
    // ended mid-sentence). No words by the first deadline: an error before any byte, and ElevenLabs' backup model answers in its own
    // words. A silence mid-reply: the turn ends on what was said. No scripted line either way.
    const gen = capTurn(runCallLlm(body, deps), {
      firstMs: o.firstMs,
      gapMs: o.gapMs,
      ceilingMs: o.ceilingMs,
      heartbeatMs: o.heartbeatMs,
      startedAt: t0,
      abort: () => stop.abort(),
      onHeartbeat: () => { heartbeats++; },
      onDeadline: (d) => {
        deadline = { kind: d.kind, ended: d.said ? "said" : "backup" };
        slow = true;
        // The after-turn check (services/callTools.ts afterTurn: a specific they gave and Cue said back, with nothing written, goes on the
        // task in their words) still runs for what was said; the ended turn doesn't run it itself.
        if (d.said && tools?.afterTurn) Promise.resolve().then(() => tools!.afterTurn!({ spoken: [...spokenLines], ran: [...ranTools] })).catch(() => {});
        // Whether the heartbeats kept ElevenLabs' clock going is read against its agents_llm_service_failed_attempts_latency after the call.
        if (userId) recordDecision({ layer: 8, decision: "call.turn_deadline", userId, outcome: "skip", action: d.kind, proposal: { deadline: d.kind, ended: deadline.ended, heartbeats: d.heartbeats, msSinceArrival: Date.now() - t0, spoken, dropped, tools: toolTimes.map((x) => x.name) } }).catch(() => {});
      },
    });
    const write = (c: OaiChunk) => res.write(`data: ${JSON.stringify(c)}\n\n`);
    try {
      if (body.stream === false) {
        let text = ""; const calls: any[] = []; let finish = "stop";
        for await (const c of gen) {
          const d = c.choices[0].delta as any;
          if (d.content) text += d.content;
          for (const tc of d.tool_calls ?? []) { const i = tc.index ?? 0; calls[i] = calls[i] ?? { id: tc.id, type: "function", function: { name: "", arguments: "" } }; if (tc.id) calls[i].id = tc.id; if (tc.function?.name) calls[i].function.name = tc.function.name; calls[i].function.arguments += tc.function?.arguments ?? ""; }
          if (c.choices[0].finish_reason) finish = c.choices[0].finish_reason;
        }
        return res.json({ id: "chatcmpl-co", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model ?? "co", choices: [{ index: 0, message: { role: "assistant", content: text.trim(), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }] });
      }
      // The first chunk (the role) waits for the second: if the upstream fails before saying anything, ElevenLabs gets a real error.
      let held: OaiChunk | null = null;
      let started = false;
      for await (const c of gen) {
        if (!started) {
          if (!held) { held = c; continue; }
          res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          res.flushHeaders();
          write(held);
          started = true;
        }
        write(c);
      }
      if (!started) {
        res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        if (held) write(held);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      // No words by the first deadline: the error is the hand-off to ElevenLabs' backup model, not a failure of the model.
      if (err instanceof TurnDeadline) { if (!res.headersSent) return res.status(502).json({ error: "no words in time; the backup answers this turn" }); }
      else {
        console.error("co/el/llm failed:", err?.message ?? err);
        brainError = true;
      }
      if (!res.headersSent) return res.status(502).json({ error: "upstream model failed" });
      // Mid-reply: close the stream cleanly with what was already said.
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-co", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "co", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } finally {
      // After this turn's owed records are written, so "I'll text it right after" joins the promise opened for a send that didn't go.
      // A turn whose tool did it: those lines are Cue's word already kept, never re-opened from the transcript after the call.
      if (userId && commitments.length)
        Promise.resolve(tools?.pending?.())
          .catch(() => {})
          .then(async () => {
            // Each one on its own: kept only by a tool done this turn for that same thing; the rest open as promises as before.
            const { commitmentKeptBy } = await import("../services/callCommitments.js");
            const covered = commitments.filter((s) => commitmentKeptBy(s, coBefore, doneThisTurn));
            for (const s of commitments.filter((x) => !covered.includes(x))) await trackCallCommitment({ userId, sentence: s, theirLine, coBefore }).catch(() => {});
            if (covered.length) await import("../services/callLedger.js").then((L) => L.recordTurnActed(userId, covered)).catch(() => {});
          })
          .catch(() => {});
      if (userId && (slow || brainError)) recordDecision({ layer: 8, decision: "call.turn_health", userId, outcome: "skip", action: [slow ? "slow" : null, brainError ? "error" : null].filter(Boolean).join(","), proposal: { slow, error: brainError } }).catch(() => {});
      const t = timing as { upstreamFirstTokenMs: number; firstSentenceMs: number } | null;
      // Per-turn latency through this endpoint (Royce, 2026-10-29: compare a test call against the direct path): time to the
      // model's first token and to the first sentence released to the voice, the whole turn, and each of Cue's tools. Numbers and
      // tool names only, never anyone's words. ElevenLabs' own per-turn numbers for every call, direct or not, are logged after the
      // call (routes/co.ts call.el_turn_metrics).
      if (userId) recordDecision({ layer: 8, decision: "call.turn_latency", userId, outcome: "act", action: voiceOnly ? "proxy_voice" : "proxy", proposal: { firstTokenMs: t?.upstreamFirstTokenMs ?? null, firstSentenceMs: t?.firstSentenceMs ?? null, totalMs: Date.now() - t0, toolMs: toolTimes.reduce((a, x) => a + x.ms, 0), tools: toolTimes, spoken, dropped, slow, error: brainError, deadline: (deadline as { kind: TurnDeadlineKind; ended: string } | null)?.kind ?? null, endedOn: (deadline as { kind: TurnDeadlineKind; ended: string } | null)?.ended ?? null, heartbeats } }).catch(() => {});
      console.log(`co/el/llm: ${userId ? "call" : "anon"} first_token=${t?.upstreamFirstTokenMs ?? "-"}ms first_sentence=${t?.firstSentenceMs ?? "-"}ms total=${Date.now() - t0}ms spoken=${spoken} dropped=${dropped} tools=${(body.tools ?? []).map((x) => x?.function?.name).filter(Boolean).join(",") || "none"}${tools ? `+co(${tools.defs.length})` : ""} co_tool_runs=${toolRuns}${process.env.CALL_LLM_CLEAN === "off" ? " (clean off)" : ""}`);
    }
  };
  router.post("/chat/completions", handler);
  router.post("/", handler);
  return router;
}
