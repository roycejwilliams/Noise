// The Hume voice read on GPT-Live calls (notes/gpt-live-parity-1031.md "Hume voice read on GPT-Live: design"): the bridge tees the
// caller's frames into the same session machinery as the ElevenLabs fork (services/mediaStreamBridge.ts startVoiceTee), with the same
// consent reads and withdrawal; the read's line goes to Claude on delegated turns, never to GPT-Live; its moments go to the post-call
// steps; the call's context carries VOICE_READ_CALL_RULE while it's on; and the ask after the call is back.
// Layer 1: Hume, OpenAI, Twilio and Claude are fakes; no network, no tokens. Invented member (Jordan).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveHume.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const G = await import("../../src/services/gptLive.js");
const B = await import("../../src/services/gptLiveBridge.js");
const M = await import("../../src/services/mediaStreamBridge.js");
const C = await import("../../src/services/voiceReadConsent.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(d: unknown) { this.sent.push(typeof d === "string" ? JSON.parse(d) : d); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  in(m: unknown) { this.emit("message", JSON.stringify(m)); }
  of(type: string) { return this.sent.filter((m) => m?.type === type || m?.event === type); }
}
const frame = (n: number) => Buffer.alloc(160, n).toString("base64");

// ---------------------------------------------------------------- 1. the tee: the fork's own session, consent reads and withdrawal
const humes: FakeSocket[] = [];
let consent = true, reads = 0;
const records: any[] = [];
M.setBridgeDeps({ connectHume: () => { const h = new FakeSocket(); humes.push(h); setImmediate(() => h.emit("open")); return h as any; }, takeLink: async () => null, now: Date.now, log: () => {}, record: (u, s) => records.push({ u, s }), apiKey: () => "dummy", allowed: async () => (reads++, consent) });
{
  const key = "u-jordan:gl:abc";
  const tee = M.startVoiceTee({ userId: "u-jordan", callKey: key, callSid: "CA-tee" });
  for (let i = 0; i < 5; i++) tee.push(frame(i));
  await tick(); await tick(); await tick();
  check("tee: their consent is read twice (before and after the session is registered), then Hume opens", reads === 2 && humes.length === 1 && humes[0].sent.some((m) => m?.type === "session.update"));
  check("tee: the session is held under the call's key hash, like the fork's", M.sessionShape(key) !== null && M.sessionShape(key)!.finished === false);
  tee.end("caller hung up");
  await sleep(10);
  check("tee: ending it finishes the session (its summary recorded, never audio)", M.sessionShape(key)?.finished === true && records.length === 1 && records[0].u === "u-jordan" && !JSON.stringify(records[0].s).includes(frame(1)));

  consent = false; reads = 0;
  const off = M.startVoiceTee({ userId: "u-jordan", callKey: "u-jordan:gl:off", callSid: "CA-off" });
  off.push(frame(1));
  await tick(); await tick();
  check("tee: no consent, no read: Hume never opens and no session is kept", humes.length === 1 && M.sessionShape("u-jordan:gl:off") === null);
  off.end("caller hung up");
  check("...and nothing is recorded for it", records.length === 1);

  consent = true; reads = 0;
  const w = M.startVoiceTee({ userId: "u-jordan", callKey: "u-jordan:gl:w", callSid: "CA-w" });
  await tick(); await tick(); await tick();
  check("tee: a stop mid-call (endVoiceSessionsFor) ends it, as it ends the fork", M.sessionShape("u-jordan:gl:w") !== null && M.endVoiceSessionsFor("u-jordan") >= 1 && M.sessionShape("u-jordan:gl:w") === null);
  w.end("caller hung up");
  M.resetVoiceSessions();
}

// ---------------------------------------------------------------- 2. the bridge: tee at session.started, the line to Claude only
{
  const call = G.buildLiveCall({ userId: "u-jordan", callSid: "CA-h", firstName: "Jordan", direction: "inbound", team: true, voiceOn: true, callKey: "u-jordan:gl:h", voiceLayer: VOICE, contextSummary: "Jordan is moving to Oakland.", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  const plain = G.buildLiveCall({ userId: "u-jordan", callSid: "CA-p", firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: "Jordan is moving to Oakland.", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  check("context: with the read on, the thinking gets VOICE_READ_CALL_RULE (as ElevenLabs' context does); GPT-Live's own prompt never does", call.backendSystem.includes(C.VOICE_READ_CALL_RULE) && !call.instructions.includes(C.VOICE_READ_CALL_RULE) && !plain.backendSystem.includes(C.VOICE_READ_CALL_RULE));
  const run = (c: typeof call, answer = "Mostly bouldering, or rope too?") => {
    const tw = new FakeSocket(), ai = new FakeSocket();
    const reqs: any[] = [], tees: any[] = [], pushed: string[] = [], ended: string[] = [];
    const id = G.issueLiveLink(c);
    B.setLiveDeps({
      connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; }, apiKey: () => "sk-test",
      upstream: (req) => { reqs.push(req); return (async function* () { for (const e of [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }, { type: "content_block_stop", index: 0 }]) yield e as any; })(); },
      record: () => {}, postCall: async () => {}, minutes: () => {}, log: () => {}, now: Date.now, maxSessionMs: 60_000, startTimeoutMs: 60_000, heartbeatMs: 60_000, guardRows: async () => [],
      startTee: (o) => { tees.push(o); return { push: (p) => pushed.push(p), end: (by) => ended.push(by) }; },
      voiceLine: async () => "[voice read] They sound flat under upbeat words.",
    });
    B.handleGptLiveStream(tw as any);
    B.setLiveDeps(null);
    tw.in({ event: "start", streamSid: "MZ1", start: { customParameters: { s: id } } });
    return { tw, ai, reqs, tees, pushed, ended };
  };
  const h = run(call);
  await sleep(5);
  h.tw.in({ event: "media", media: { track: "inbound", payload: frame(1) } });
  check("tee: nothing teed before the session starts", h.tees.length === 0 && h.pushed.length === 0);
  h.ai.in({ type: "session.started", session: { id: "live_h" } });
  h.tw.in({ event: "media", media: { track: "inbound", payload: frame(2) } });
  check("tee: started at session.started for the call's own key, with the early frame first, then each live one (the same frames OpenAI gets)", h.tees.length === 1 && h.tees[0].callKey === "u-jordan:gl:h" && h.tees[0].userId === "u-jordan" && JSON.stringify(h.pushed) === JSON.stringify([frame(1), frame(2)]) && h.ai.of("session.input_audio.append").map((m) => m.audio).join() === [frame(1), frame(2)].join());
  h.ai.in({ type: "session.input_transcript.delta", delta: "Yeah it's all fine, the move is great.", start_ms: 0, end_ms: 2000 });
  h.ai.in({ type: "session.delegation.created", offset_ms: 2100, delegation: { id: "d1", target: "client" } });
  await sleep(40);
  const last = h.reqs[0]?.messages?.at(-1);
  const lastText = JSON.stringify(last);
  check("the read's line reaches Claude after their words on a delegated turn", lastText.includes("the move is great") && lastText.includes("[voice read] They sound flat") && lastText.indexOf("the move is great") < lastText.indexOf("[voice read]"));
  check("...and never GPT-Live: nothing sent to OpenAI carries it", !JSON.stringify(h.ai.sent).includes("[voice read]"));
  h.tw.in({ event: "stop" });
  h.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 5 } });
  await sleep(5);
  check("tee: ended with the call", h.ended.length === 1);

  const s = run(call, "I'm really glad you told me. You can call or text 988 right now. Are you safe tonight?");
  await sleep(5);
  s.ai.in({ type: "session.started", session: { id: "live_s" } });
  s.ai.in({ type: "session.input_transcript.delta", delta: "Honestly I don't want to be here anymore.", start_ms: 0, end_ms: 2000 });
  s.ai.in({ type: "session.delegation.created", offset_ms: 2100, delegation: { id: "s1", target: "client" } });
  await sleep(40);
  check("a safety turn: the read's line is dropped (it can't soften or outweigh serious words), as on ElevenLabs", s.reqs.length === 1 && !JSON.stringify(s.reqs[0]).includes("[voice read]"));
  s.tw.close();

  const p = run(plain);
  await sleep(5);
  p.ai.in({ type: "session.started", session: { id: "live_p" } });
  p.ai.in({ type: "session.input_transcript.delta", delta: "Yeah all good.", start_ms: 0, end_ms: 1000 });
  p.ai.in({ type: "session.delegation.created", offset_ms: 1100, delegation: { id: "p1", target: "client" } });
  await sleep(40);
  check("read off for them: no tee, and no line on any turn", p.tees.length === 0 && !JSON.stringify(p.reqs).includes("[voice read]"));
  p.tw.close();
}

// ---------------------------------------------------------------- 3. the TwiML route and the post-call steps
{
  const co = src("routes/co.ts");
  const block = co.slice(co.indexOf("// ---------- GPT-Live calls"), co.indexOf("// Root-cause guard"));
  check("TwiML route: the read runs only where voiceReadOnFor says it may (their yes, or a test number), with the call's own key", /m\.voiceReadOnFor\(o\.userId\)/.test(block) && /voiceOn, callKey: `\$\{o\.userId\}:gl:\$\{admitted\.id\}`/.test(block));
  const post = co.slice(co.indexOf("export async function runGptLivePostCall"), co.indexOf("// Root-cause guard"));
  check("post-call: the tee's moments go to the same steps as ElevenLabs' (takeVoiceMoments by the call's key; consent read again inside)", /voice: async \(\) => momentSignals\(await takeVoiceMoments\(r\.call\.callKey, callerTurnsFrom\(turns\)\)\)/.test(post));
  check("post-call: the voice read's ask after the call is back on GPT-Live calls", !/askVoiceRead: false/.test(post));
  const bridge = src("services/mediaStreamBridge.ts");
  check("one session path: the fork and the tee both go through admitVoiceSession (the same consent reads)", (bridge.match(/admitVoiceSession\(d, /g) ?? []).length === 2 && /export function startVoiceTee/.test(bridge));
}

M.setBridgeDeps(null);
console.log(`gpt-live hume: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
