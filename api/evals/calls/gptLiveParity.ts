// GPT-Live parity with the ElevenLabs path (notes/gpt-live-parity-1031.md, PR A2): OpenAI's own closes read as abnormal ends in call
// health, one activity timer (silence, and after both say goodbye) since GPT-Live can't hang up, a wrap-up before the cap, the live
// guards on every delegated turn, safety turns said word for word, a safety-filter cut during a safety moment taking the safety path,
// and no voice-read ask after a GPT-Live call while the read can't run on one.
// Layer 1: OpenAI, Twilio and Claude are fakes; no network, no tokens. Invented member (Jordan).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveParity.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const G = await import("../../src/services/gptLive.js");
const B = await import("../../src/services/gptLiveBridge.js");
const H = await import("../../src/services/callHealth.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const callFor = (context = "Jordan is moving to Oakland in March.") => G.buildLiveCall({ userId: "u-jordan", callSid: "CA-par", firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: context, rightNow: "", findsNow: "", callReason: "", timeOfDay: null });

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(d: unknown) { this.sent.push(JSON.parse(String(d))); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  in(m: unknown) { this.emit("message", JSON.stringify(m)); }
  of(type: string) { return this.sent.filter((m) => m.type === type || m.event === type); }
}
const textEvents = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }];
type Opts = Partial<import("../../src/services/gptLiveBridge.js").LiveDeps> & { answer?: (req: any) => string };
function bridge(o: Opts = {}, call = callFor()) {
  const tw = new FakeSocket(), ai = new FakeSocket();
  const reqs: any[] = [], records: any[] = [], cuts: any[] = [];
  const id = G.issueLiveLink(call);
  const { answer, ...deps } = o;
  B.setLiveDeps({
    connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; },
    apiKey: () => "sk-test",
    upstream: (req) => { reqs.push(req); const s = (answer ?? (() => "Mostly bouldering, or rope too?"))(req); return (async function* () { for (const e of textEvents(s)) yield e as any; })(); },
    record: (d) => records.push(d),
    postCall: async () => {},
    minutes: () => {},
    log: () => {},
    now: Date.now,
    maxSessionMs: 60_000,
    startTimeoutMs: 60_000,
    heartbeatMs: 60_000,
    silenceEndMs: 60_000,
    goodbyeQuietMs: 60_000,
    wrapUpMs: 10,
    guardRows: async () => [],
    safetyCut: async (c) => { cuts.push(c.userId); },
    ...deps,
  });
  B.handleGptLiveStream(tw as any);
  B.setLiveDeps(null);
  tw.in({ event: "start", streamSid: "MZ1", start: { customParameters: { s: id } } });
  return { tw, ai, reqs, records, cuts };
}
const start = async (b: ReturnType<typeof bridge>, sid: string) => { await sleep(5); b.ai.in({ type: "session.started", session: { id: sid } }); };
const say = (b: ReturnType<typeof bridge>, who: "member" | "cue", text: string, s: number) => b.ai.in({ type: who === "member" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: text, start_ms: s, end_ms: s + 800 });

// ---------------------------------------------------------------- 1. OpenAI's own closes are abnormal ends in call health
{
  const flags = (endedBy: string, reason: string) => H.callHealthReasons({ durationSecs: 300, terminationReason: G.liveTermination(endedBy, reason), status: null, turns: [{ role: "agent", message: "Okay." }], decisions: [], frustratedWithCo: false });
  check("OpenAI's safety filter, a lost connection, its own time limit, or the socket dropping: abnormal_end", ["content", "connection_lost", "expired", "openai closed"].every((r) => flags("openai_closed", r).includes("abnormal_end")));
  check("a close we asked for (hang-up, cap, goodbye, silence) or a remote hang-up: not abnormal", [["caller_hangup", "caller hung up"], ["session_cap", "session cap"], ["goodbye", "goodbye"], ["silence", "silence"], ["openai_closed", "close_requested"], ["openai_closed", "remote_hangup"]].every(([e, r]) => !flags(e, r).includes("abnormal_end")));
  check("the post-call adapter hands call health the mapped termination", /terminationReason: G\.liveTermination\(r\.endedBy, r\.reason\)/.test(src("routes/co.ts")));
}

// ---------------------------------------------------------------- 2. one activity timer: silence, and after both say goodbye
{
  check("silence ends a call after the ElevenLabs agent's own 120 s; goodbye after 4 s", G.GPT_LIVE.silenceEndMs === E.AGENT_DEFAULTS.silenceEndCallSecs * 1000 && G.GPT_LIVE.goodbyeQuietMs === 4000);
  const quiet = bridge({ silenceEndMs: 60 });
  await start(quiet, "live_q");
  say(quiet, "cue", "Hey, what's up?", 0);
  await sleep(30);
  check("silence: not before the window", quiet.ai.of("session.close").length === 0);
  await sleep(90);
  check("silence: nothing said either way past the window ends it (session.close)", quiet.ai.of("session.close").length === 1);
  quiet.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 125 } });
  check("...recorded as ended by silence", quiet.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "silence");

  const playing = bridge({ silenceEndMs: 40 });
  await start(playing, "live_p");
  playing.ai.in({ type: "session.output_audio.delta", delta: Buffer.alloc(8000 * 2, 9).toString("base64") }); // two seconds of Cue
  await sleep(120);
  check("silence: never while Cue's audio is still playing", playing.ai.of("session.close").length === 0);
  playing.tw.close();

  const bye = bridge({ goodbyeQuietMs: 40 });
  await start(bye, "live_bye");
  say(bye, "cue", "Hey, what's up?", 0);
  say(bye, "member", "Not much, just wanted to say thanks. Okay, I gotta go, bye.", 1000);
  say(bye, "cue", "Talk soon, Jordan.", 3000);
  await sleep(20);
  check("goodbye: not before the quiet window", bye.ai.of("session.close").length === 0);
  await sleep(80);
  check("goodbye: both said goodbye and nothing more came: the session is closed", bye.ai.of("session.close").length === 1);
  bye.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 20 } });
  check("...the Twilio stream is closed too (the <Connect> action then hangs up) and it's recorded as goodbye", bye.tw.readyState === 3 && bye.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "goodbye");

  const more = bridge({ goodbyeQuietMs: 40 });
  await start(more, "live_more");
  say(more, "member", "Okay bye.", 0);
  say(more, "cue", "Take care.", 1000);
  say(more, "member", "Oh wait, one more thing about the move.", 2000);
  await sleep(100);
  check("goodbye: something real said after it keeps the call open", more.ai.of("session.close").length === 0);
  more.tw.close();
  check("both-said-goodbye reads the call brain's own closing words, not a new list", B.bothSaidGoodbye([{ who: "member", text: "I'll let you go.", startMs: 0, endMs: 1 }, { who: "cue", text: "Bye Jordan.", startMs: 2, endMs: 3 }]) && !B.bothSaidGoodbye([{ who: "member", text: "bye", startMs: 0, endMs: 1 }]) && /MEMBER_CLOSING/.test(src("services/gptLiveBridge.ts")));
}

// ---------------------------------------------------------------- 3. a wrap-up before the cap, in GPT-Live's own words
{
  const capped = bridge({ maxSessionMs: 80, wrapUpMs: 30 });
  await start(capped, "live_cap");
  await sleep(65);
  const wrap = capped.ai.of("session.instructions.append").find((m: any) => m.event_id === "wrap_up");
  check("about a minute before the cap: a session-wide instruction to wrap up (no set line to say)", wrap?.delegation_id === null && wrap.content === G.WRAP_UP && !/"/.test(G.WRAP_UP) && capped.ai.of("session.close").length === 0);
  await sleep(40);
  check("...then the cap closes it as before", capped.ai.of("session.close").length === 1);
  capped.tw.close();
  const short = bridge({ maxSessionMs: 40, wrapUpMs: 30 });
  await start(short, "live_short");
  await sleep(10);
  check("no wrap-up on a call capped too short for one", short.ai.of("session.instructions.append").length === 0);
  short.tw.close();
}

// ---------------------------------------------------------------- 4. the live guards on every delegated turn
{
  let reads = 0;
  const rows = [{ field: "goal", old: "climbing partner", now: null, ref: "", removed: true }] as any;
  const g = bridge({ guardRows: async () => (reads++, rows), guardMessages: (messages, r) => messages.map((m: any) => (m.role === "system" ? { ...m, content: String(m.content).replace(/climbing partner/g, "[removed]") } : m)) }, callFor("Jordan wants a climbing partner in Oakland."));
  await start(g, "live_g");
  say(g, "member", "What do you remember about me?", 0);
  g.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d1", target: "client" } });
  await sleep(40);
  say(g, "member", "And anything else?", 2000);
  g.ai.in({ type: "session.delegation.created", offset_ms: 2900, delegation: { id: "d2", target: "client" } });
  await sleep(40);
  const sys = (i: number) => (g.reqs[i]?.system ?? []).map((x: any) => x.text).join("\n");
  check("a removal made by text during the call is out of the very next delegated turn's prompt", g.reqs.length === 2 && !sys(0).includes("climbing partner") && sys(0).includes("[removed]"), sys(0).slice(0, 200));
  check("...read at most every 20 s per call (once for two turns here), as on the ElevenLabs proxy", reads === 1 && G.GPT_LIVE.guardCacheMs === 20_000);
  check("the bridge's default guard is the ElevenLabs path's own (whatCoKnows forgottenRows + guardCallMessages)", /W\.forgottenRows\(userId\)/.test(src("services/gptLiveBridge.ts")) && /guardCallMessages\(messages, rows\)/.test(src("services/gptLiveBridge.ts")));
  g.tw.close();
}

// ---------------------------------------------------------------- 5. safety: said word for word; a safety-filter cut takes the safety path
{
  const LINE = "I'm really glad you told me. If you're thinking about ending your life, you can call or text 988 right now. Are you safe tonight?";
  const s = bridge({ answer: () => LINE });
  await start(s, "live_s");
  say(s, "member", "Honestly I don't want to be here anymore.", 0);
  s.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "s1", target: "client" } });
  await sleep(40);
  const sent = s.ai.sent.filter((m: any) => m.delegation_id === "s1" && m.event_id === "answer_s1");
  check("a safety turn: Claude's line goes as a trusted instruction to say it exactly and in full, never paraphrased commentary", sent.length === 1 && sent[0].type === "session.instructions.append" && sent[0].content === G.sayExactly(LINE) && sent[0].content.includes("988") && /exactly as written and in full/.test(sent[0].content), sent);
  check("...logged as exact", s.records.some((r) => r.decision === "call.turn_latency" && r.action === "gpt_live" && r.proposal.exact === true));
  s.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 40 } });
  await sleep(5);
  check("OpenAI's safety filter cut the call during the safety moment: the safety path runs (team alert, hold, next-day check-in) and it's logged", s.cuts.length === 1 && s.cuts[0] === "u-jordan" && s.records.some((r) => r.decision === "call.gpt_live_safety_cut"));
  check("...and call health marks it an abnormal end", H.callHealthReasons({ durationSecs: 40, terminationReason: G.liveTermination("openai_closed", "content"), status: null, turns: [], decisions: [], frustratedWithCo: false }).includes("abnormal_end"));
  check("the safety path is the existing one (services/safety.ts recordSafetyConcern), never a new alert", /recordSafetyConcern\(call\.userId, call\.firstName \|\| null, "co",/.test(src("services/gptLiveBridge.ts")));

  const plain = bridge({ answer: () => "Mostly bouldering, or rope too?" });
  await start(plain, "live_plain");
  say(plain, "member", "I've been climbing a lot lately.", 0);
  plain.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "p1", target: "client" } });
  await sleep(40);
  check("an ordinary turn still goes as commentary", plain.ai.sent.find((m: any) => m.event_id === "answer_p1")?.type === "session.commentary.append");
  plain.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 10 } });
  await sleep(5);
  check("a safety-filter cut with no safety moment on the call: no safety path (call health flags it)", plain.cuts.length === 0 && !plain.records.some((r) => r.decision === "call.gpt_live_safety_cut"));
}

// ---------------------------------------------------------------- 6. no voice-read ask after a GPT-Live call (the read can't run on one yet)
{
  const co = src("routes/co.ts");
  const post = co.slice(co.indexOf("export async function runGptLivePostCall"), co.indexOf("// Root-cause guard"));
  check("GPT-Live's post-call steps don't queue the voice read's ask", /askVoiceRead: false/.test(post));
  check("...the ElevenLabs path still does, as before", /if \(callUser && o\.askVoiceRead !== false\) import\("\.\.\/services\/voiceReadConsent\.js"\)\.then\(\(m\) => m\.queueVoiceReadAsk\(user_id\)\)/.test(co) && !/askVoiceRead/.test(co.slice(co.indexOf('router.post("/el/post-call"'), co.indexOf("// ---------- GPT-Live calls"))));
}

console.log(`gpt-live parity: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
