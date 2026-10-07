// The call brain's endpoint for ElevenLabs (services/callLlmProxy.ts): POST /co/el/llm/chat/completions, OpenAI chat-completions in,
// server-sent events out. Mounted before the general rate limiter (a call is a request per turn, from one address).
// Auth: the bearer token ElevenLabs holds as a workspace secret (CALL_LLM_PROXY_SECRET). Who the call is comes from the extra body we
// attach when the call is registered, and is checked with the call token like the agent's tools are.
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { recordDecision } from "../harness/core.js";
import { verifyCallToken } from "../services/elevenLabsCalls.js";
import { anthropicStream, runCallLlm, type OaiChunk, type OaiRequest, type ProxyDeps } from "../services/callLlmProxy.js";
import { commitmentProblem, trackCallCommitment } from "../services/callCommitments.js";

export const proxyAuthorized = (header: string | undefined, secret = process.env.CALL_LLM_PROXY_SECRET): boolean => {
  if (!secret || !header) return false;
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
};

const lastUserLine = (b: OaiRequest): string => {
  const m = [...b.messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m!.content.map((p: any) => p?.text ?? "").join("") : "";
};

export function createCallLlmRouter(upstream: ProxyDeps["stream"] = anthropicStream): Router {
  const router = Router();
  const handler = async (req: Request, res: Response) => {
    if (!process.env.CALL_LLM_PROXY_SECRET) return res.status(503).json({ error: "the call brain endpoint is not configured" });
    if (!proxyAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });
    const body = req.body as OaiRequest;
    if (!body || !Array.isArray(body.messages)) return res.status(400).json({ error: "messages required" });
    const extra = body.elevenlabs_extra_body ?? {};
    const userId = verifyCallToken(String(extra.user_id ?? ""), extra.call_token) ? String(extra.user_id) : null;
    const theirLine = lastUserLine(body);
    const t0 = Date.now();
    let timing: { upstreamFirstTokenMs: number; firstSentenceMs: number } | null = null;
    let spoken = 0, dropped = 0;
    const deps: ProxyDeps = {
      stream: upstream,
      clean: process.env.CALL_LLM_CLEAN !== "off",
      onSpoken: (s) => {
        spoken++;
        // A spoken "I'll text you the links" opens a task the moment it is said.
        if (userId && commitmentProblem(s) === null) trackCallCommitment({ userId, sentence: s, theirLine }).catch(() => {});
      },
      onDropped: (s, why) => {
        dropped++;
        if (userId) recordDecision({ layer: 8, decision: "call.offer_unsourced", userId, outcome: "skip", action: "dropped_sentence", proposal: { sentence: s.slice(0, 240) }, reason: why }).catch(() => {});
      },
      onFirstText: (t) => { timing = t; },
    };
    const gen = runCallLlm(body, deps);
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
      console.error("co/el/llm failed:", err?.message ?? err);
      if (!res.headersSent) return res.status(502).json({ error: "upstream model failed" });
      // Mid-reply: close the stream cleanly with what was already said.
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-co", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "co", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } finally {
      const t = timing as { upstreamFirstTokenMs: number; firstSentenceMs: number } | null;
      console.log(`co/el/llm: ${userId ? "call" : "anon"} first_token=${t?.upstreamFirstTokenMs ?? "-"}ms first_sentence=${t?.firstSentenceMs ?? "-"}ms total=${Date.now() - t0}ms spoken=${spoken} dropped=${dropped}${process.env.CALL_LLM_CLEAN === "off" ? " (clean off)" : ""}`);
    }
  };
  router.post("/chat/completions", handler);
  router.post("/", handler);
  return router;
}
