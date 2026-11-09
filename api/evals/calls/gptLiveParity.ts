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
// An answer "…|END" is Claude's text plus an end_call tool use (Cue's thinking deciding to hang up).
const endEvents = [{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_end", name: "end_call" } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 1 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }];
const textEvents = (s: string) => s.endsWith("|END") ? [...textEvents0(s.slice(0, -4)), ...endEvents] : textEvents0(s);
const textEvents0 = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }];
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
    endGraceMs: 30,
    endWaitMs: 60_000,
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

// ---------------------------------------------------------------- 2. one activity timer: silence, and Cue's own end_call
{
  check("silence ends a call after the ElevenLabs agent's own 120 s; Cue's end_call waits for its goodbye plus 2 s", G.GPT_LIVE.silenceEndMs === E.AGENT_DEFAULTS.silenceEndCallSecs * 1000 && G.GPT_LIVE.endGraceMs === 2000);
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

  // Ending the call is Cue's decision (review of #331): goodbyes are delegated and the thinking has one tool, end_call; the bridge hangs
  // up after Cue's goodbye has played, guarded on facts only. No code reads their words for a goodbye.
  check("the thinking gets end_call with its rule; GPT-Live delegates goodbyes; the regex goodbye end is gone", JSON.stringify(G.delegationRequest(callFor(), []).tools) === JSON.stringify([G.END_CALL_TOOL]) && G.END_CALL_TOOL.function.description === G.END_CALL_RULE && /- They're wrapping up the call or saying goodbye\./.test(callFor().instructions) && !/a greeting, a thanks, a goodbye/.test(callFor().instructions) && !("bothSaidGoodbye" in B) && !/MEMBER_CLOSING/.test(src("services/gptLiveBridge.ts")));
  const turn = async (b: ReturnType<typeof bridge>, id: string, member: string, at: number) => {
    say(b, "member", member, at);
    b.ai.in({ type: "session.delegation.created", offset_ms: at + 900, delegation: { id, target: "client" } });
    await sleep(40);
  };
  // The reviewer's mid-conversation cases (rv331/goodbye.mts): Cue's thinking answers and doesn't end; nothing else can.
  const midCases: [string, string][] = [
    ["she just said goodbye and walked out, after eight years", "Eight years. Do you want to tell me what happened?"],
    ["my manager said we'd talk soon about the promotion", "That's worth preparing for. What do you want to see happen?"],
    ["I have to go see my mom this weekend, she's sick and I'm scared", "I'm sorry. Is anyone going with you?"],
    ["I just... I need to go. I can't...", "Take your time. I'm here."],
  ];
  for (const [theirs, ours] of midCases) {
    const m = bridge({ answer: () => ours, endGraceMs: 20 });
    await start(m, "live_mid");
    await turn(m, "m1", theirs, 0);
    say(m, "cue", ours, 2000);
    await sleep(80);
    check(`mid-conversation ("${theirs}"): the call stays open`, m.ai.of("session.close").length === 0);
    m.tw.close();
  }
  // A real mutual goodbye: Cue's thinking says goodbye and calls end_call; once the goodbye has played and the grace passed, it ends.
  // GPT-Live says its own short goodbye at once (review of #331: a delegated goodbye arrived 4-5.5 s late); the turn is still delegated
  // and the thinking only decides whether the call ends (end_call with no text).
  check("GPT-Live is told to say its own short goodbye right away and still hand the turn over; the thinking, to end with no text", /say a short goodbye of your own right away, and still generate <\|SpawnThinking\|>: your thinking only decides whether the call ends/.test(callFor().instructions) && /if the call should end, use your tool that ends the call and write nothing/.test(callFor().backendSystem));
  const bye = bridge({ answer: () => "|END", endGraceMs: 30 });
  await start(bye, "live_bye");
  say(bye, "member", "Okay, I should get going. Talk soon.", 0);
  say(bye, "cue", "Talk soon, Jordan. Good luck tomorrow.", 1200); // GPT-Live's own goodbye, at once
  bye.ai.in({ type: "session.output_audio.delta", delta: Buffer.alloc(8000, 9).toString("base64") }); // a second of it, still playing
  bye.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "b1", target: "client" } });
  await sleep(40);
  check("a real goodbye: nothing is sent back for the turn (no answer to repeat the goodbye, no \"no answer\" note)", !bye.ai.sent.some((m: any) => m.event_id === "answer_b1") && bye.ai.of("session.close").length === 0, bye.ai.sent.filter((m: any) => m.event_id === "answer_b1"));
  await sleep(20);
  check("...not while the goodbye is still playing", bye.ai.of("session.close").length === 0);
  await sleep(1100);
  check("...then, played and the grace passed, Cue's end_call ends the call", bye.ai.of("session.close").length === 1);
  bye.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 12 } });
  check("...recorded as ended by goodbye; the Twilio stream closes (the <Connect> action hangs up)", bye.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "goodbye" && bye.tw.readyState === 3);
  // The guards, on facts only.
  const refusedWith = (b: ReturnType<typeof bridge>) => b.records.filter((r) => r.decision === "call.end_refused").map((r) => r.action);
  const asked = bridge({ answer: () => "|END", endGraceMs: 20 });
  await start(asked, "live_asked");
  await turn(asked, "a1", "Okay bye.", 0);
  say(asked, "cue", "Bye for now. Same time next week?", 2000);
  await sleep(80);
  check("guard: Cue's last line ends in a question: refused (call.end_refused cue_asked), the call stays open", asked.ai.of("session.close").length === 0 && refusedWith(asked).join() === "cue_asked", refusedWith(asked));
  asked.tw.close();
  const after = bridge({ answer: () => "|END", endGraceMs: 20 });
  await start(after, "live_after");
  await turn(after, "f1", "Okay bye.", 0);
  say(after, "cue", "Bye, Jordan.", 2000);
  say(after, "member", "Oh wait, one more thing.", 3000);
  await sleep(80);
  check("guard: they said something after Cue's last line: refused (member_spoke_after)", after.ai.of("session.close").length === 0 && refusedWith(after).join() === "member_spoke_after", refusedWith(after));
  after.tw.close();
  check("guard: they're speaking now (heard within the grace): refused (member_speaking)", B.endGuard({ cueLast: { text: "Bye, Jordan.", startMs: 2000 }, memberAfterMs: 0, memberHeardAgoMs: 10, graceMs: 2000 }) === "member_speaking" && B.endGuard({ cueLast: { text: "Bye, Jordan.", startMs: 2000 }, memberAfterMs: 0, memberHeardAgoMs: 5000, graceMs: 2000 }) === null && B.endGuard({ cueLast: { text: "Bye, Jordan?", startMs: 2000 }, memberAfterMs: null, memberHeardAgoMs: null, graceMs: 2000 }) === "cue_asked");
  const never = bridge({ answer: () => "|END", endGraceMs: 20, endWaitMs: 50 });
  await start(never, "live_never");
  await turn(never, "n1", "Okay bye.", 0);
  await sleep(120);
  const stay = bridge({ answer: () => "Before you go, did the landlord get back to you?", endGraceMs: 20 });
  await start(stay, "live_stay");
  say(stay, "member", "Okay bye.", 0);
  say(stay, "cue", "Bye, Jordan.", 1200);
  stay.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "s1", target: "client" } });
  await sleep(120);
  check("no end_call from the thinking: nothing ends, and its answer carries the conversation on", stay.ai.of("session.close").length === 0 && stay.ai.sent.some((m: any) => m.event_id === "answer_s1" && /landlord/.test(m.content)));
  stay.tw.close();
  check("an end_call whose goodbye is never said is dropped (no_goodbye), never a silent hang-up", never.ai.of("session.close").length === 0 && refusedWith(never).join() === "no_goodbye", refusedWith(never));
  never.tw.close();
  // The end_call rule matches the flow: the voice has already said its goodbye, the thinking writes nothing (review of #333).
  check("END_CALL_RULE: the voice has already said its goodbye; write nothing with it", /the voice has already said its goodbye/.test(G.END_CALL_RULE) && /Write nothing with it/.test(G.END_CALL_RULE) && !/your reply says goodbye/.test(G.END_CALL_RULE));
  // Goodbye overlap (review of #333): GPT-Live's goodbye may start up to goodbyeOverlapMs before the end of their turn and still count.
  const overlap = bridge({ answer: () => "|END", endGraceMs: 20 });
  await start(overlap, "live_overlap");
  say(overlap, "member", "Okay, talk soon.", 0); // their turn: 0-800 ms
  say(overlap, "cue", "Talk soon, Jordan.", 800 - G.GPT_LIVE.goodbyeOverlapMs + 100); // starts 400 ms before their turn ends
  overlap.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "o1", target: "client" } });
  await sleep(150);
  check("goodbye overlap: a goodbye that starts just before their words end still counts, and end_call ends the call", G.GPT_LIVE.goodbyeOverlapMs === 500 && overlap.ai.of("session.close").length === 1 && refusedWith(overlap).length === 0, refusedWith(overlap));
  overlap.tw.close();
  const early = bridge({ answer: () => "|END", endGraceMs: 20, endWaitMs: 50 });
  await start(early, "live_early");
  say(early, "member", "Okay, talk soon.", 0);
  say(early, "cue", "Mm-hm, yeah.", 800 - G.GPT_LIVE.goodbyeOverlapMs - 200); // well inside their turn: not this turn's goodbye
  early.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "e1", target: "client" } });
  await sleep(150);
  check("...a line that started well inside their turn isn't the goodbye: no_goodbye, nothing ends", early.ai.of("session.close").length === 0 && refusedWith(early).join() === "no_goodbye", refusedWith(early));
  early.tw.close();
  // No "no answer" note once GPT-Live has spoken this turn (its goodbye) and the answer came back empty with no tool (review of #333);
  // a failed answer always gets the note (review of #337: a real question still gets the fallback when Claude errored).
  const latency = (b: ReturnType<typeof bridge>) => b.records.filter((r) => r.decision === "call.turn_latency").map((r) => r.proposal);
  const quietBye = bridge({ answer: () => "", endGraceMs: 20 });
  await start(quietBye, "live_nonote");
  say(quietBye, "member", "Okay bye.", 0);
  say(quietBye, "cue", "Bye, Jordan.", 900);
  quietBye.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "q1", target: "client" } });
  await sleep(80);
  check("GPT-Live already said its goodbye, then an empty answer with no end_call: no \"no answer\" note (nothing sent for the turn)", !quietBye.ai.sent.some((m: any) => m.event_id === "answer_q1") && latency(quietBye).some((l) => l.noteSkipped === true), latency(quietBye));
  quietBye.tw.close();
  const failed = bridge({ answer: () => { throw new Error("upstream down"); }, endGraceMs: 20 });
  await start(failed, "live_failed");
  say(failed, "member", "Wait, what was the name of that climbing gym?", 0);
  say(failed, "cue", "Hm, let me think.", 2100); // a line of its own after their turn
  failed.ai.in({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "q3", target: "client" } });
  await sleep(80);
  check("a failed answer after GPT-Live already spoke this turn: the note still goes (never skipped on an error)", failed.ai.sent.some((m: any) => m.event_id === "answer_q3" && m.type === "session.thinking.append" && /No answer came back/.test(m.content)) && latency(failed).some((l) => l.error === true && l.noteSkipped === false), latency(failed));
  failed.tw.close();
  const note = bridge({ answer: () => "", endGraceMs: 20 });
  await start(note, "live_note");
  say(note, "member", "What was the name of that climbing gym?", 0);
  note.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "q2", target: "client" } });
  await sleep(80);
  check("...but with nothing said yet this turn, an empty answer still gets the note (it says it'll text, never guesses)", note.ai.sent.some((m: any) => m.event_id === "answer_q2" && m.type === "session.thinking.append" && /No answer came back/.test(m.content)));
  note.tw.close();
}

// ---------------------------------------------------------------- 2b. calls end after goodbyes (2026-11-09: 8 of 8 GPT-Live calls ended by the caller)
{
  const refusedWith = (b: ReturnType<typeof bridge>) => b.records.filter((r) => r.decision === "call.end_refused").map((r) => r.action);
  const frag = (b: ReturnType<typeof bridge>, who: "member" | "cue", text: string, s: number, e: number) => b.ai.in({ type: who === "member" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: text, start_ms: s, end_ms: e });
  const lastUser = (req: any) => { const u = (req.messages ?? []).filter((m: any) => m.role === "user"); const c = u[u.length - 1]?.content; return Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join(" ") : String(c ?? ""); };
  const sentFor = (b: ReturnType<typeof bridge>, id: string) => b.ai.sent.filter((m: any) => m.delegation_id === id && m.content);
  check("the continuation gap and the goodbye tail window are named constants (about 1.2 s; one word within 250 ms of Cue's line)", G.GPT_LIVE.continuationGapMs === 1200 && G.GPT_LIVE.goodbyeTailMs === 250 && !("continuationMaxWords" in G.GPT_LIVE));

  // This morning: "Bye. Have a good" / Cue "You too" / "one": speech recognition split their goodbye, and the trailing "one" landed after
  // Cue's goodbye started. It is the end of their utterance (300 ms after it, one word), so it no longer holds the end.
  const m = bridge({ answer: (req) => (/^one\b/.test(lastUser(req).trim()) ? "." : "|END"), endGraceMs: 30 });
  await start(m, "live_morning");
  frag(m, "member", "Bye. Have a good", 0, 1000);
  m.ai.in({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "mo1", target: "client" } });
  await sleep(40);
  frag(m, "cue", "You too", 1100, 1500);
  frag(m, "member", "one", 1300, 1500);
  m.ai.in({ type: "session.delegation.created", offset_ms: 1500, delegation: { id: "mo2", target: "client" } });
  await sleep(150);
  check("this morning's sequence (\"Bye. Have a good\" / \"You too\" / \"one\"): Cue's end_call ends the call", m.ai.of("session.close").length === 1 && refusedWith(m).length === 0, refusedWith(m));
  check("...and the stray \"one\" gets nothing spoken: no \".\", and no \"no answer\" note (the voice already spoke this utterance)", sentFor(m, "mo2").length === 0, sentFor(m, "mo2"));
  m.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 30 } });
  check("...recorded as ended by goodbye", m.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "goodbye");

  // 11-07: "Cool. I appreciate it. Thank" / Cue "Sure thing" / "you" / Cue's goodbye / "Cool". Cue's thinking decides the call is over
  // (Royce, 2026-11-09: no word-reading hold on the end); the "you" is the end of their thanks (200 ms, one word), and "Cool" well after
  // the goodbye holds the end until their turn decides again.
  const f1107: import("../../src/services/gptLive.js").Frag[] = [
    { who: "member", text: "Cool. I appreciate it. Thank", startMs: 0, endMs: 1500 },
    { who: "cue", text: "Sure thing", startMs: 1600, endMs: 2000 },
    { who: "member", text: "you", startMs: 1700, endMs: 1900 },
  ];
  const a1107 = B.memberAfter(f1107, 1600);
  check("the 11-07 \"you\" is the end of their thanks (timing and length), not new words", a1107.newAt === null && a1107.tail === true, a1107);
  const e = bridge({ answer: () => "|END", endGraceMs: 30 });
  await start(e, "live_1107");
  frag(e, "member", "Cool. I appreciate it. Thank", 0, 1500);
  e.ai.in({ type: "session.delegation.created", offset_ms: 1500, delegation: { id: "e71", target: "client" } });
  await sleep(40);
  frag(e, "cue", "Sure thing", 1600, 2000);
  frag(e, "member", "you", 1700, 1900);
  frag(e, "cue", ". I'm glad you picked up. Talk again soon.", 2000, 4500);
  frag(e, "member", "Cool", 5000, 5300);
  await sleep(120);
  check("the 11-07 sequence: the thinking's end on their thanks goes through (no \"they haven't said goodbye\" hold); the late \"Cool\" holds it", e.records.some((r) => r.decision === "call.end_refused" && r.action === "member_spoke_after") && !e.records.some((r) => r.decision === "call.offer_unsourced" && /end_call/.test(r.proposal?.sentence ?? "")) && e.ai.of("session.close").length === 0, e.records.filter((r) => /end_|offer_unsourced/.test(r.decision)).map((r) => [r.decision, r.action]));
  e.ai.in({ type: "session.delegation.created", offset_ms: 5300, delegation: { id: "e72", target: "client" } });
  await sleep(150);
  check("...their \"Cool\" turn decides again and ends the call after the first goodbye, with nothing more said", e.ai.of("session.close").length === 1 && e.ai.of("session.commentary.append").length === 0 && JSON.stringify(e.reqs[1]?.messages ?? []).includes(G.END_HELD_NOTE));
  e.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 40 } });
  check("...recorded as ended by goodbye", e.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "goodbye");

  // Cue still can't hang up after its own question, or while they're speaking.
  const ask = bridge({ answer: () => "|END", endGraceMs: 30 });
  await start(ask, "live_ask");
  frag(ask, "member", "I've been thinking about the move a lot.", 0, 2000);
  ask.ai.in({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "k1", target: "client" } });
  await sleep(40);
  frag(ask, "cue", "What's pulling you toward Oakland?", 2100, 3500);
  await sleep(150);
  check("Cue's thinking ends mid-call right after its own question: refused (cue_asked), the call stays open", ask.ai.of("session.close").length === 0 && refusedWith(ask).join() === "cue_asked", refusedWith(ask));
  ask.tw.close();
  const talking = bridge({ answer: () => "|END", endGraceMs: 60 });
  await start(talking, "live_talking");
  frag(talking, "member", "Okay, bye.", 0, 800);
  talking.ai.in({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "t1", target: "client" } });
  await sleep(40);
  frag(talking, "cue", "Bye, Jordan.", 900, 1500);
  for (let i = 0; i < 6; i++) { frag(talking, "member", i ? "and" : "Actually", 1300 + i * 300, 1500 + i * 300); await sleep(30); }
  check("while they're still speaking (words keep arriving), the call never closes", talking.ai.of("session.close").length === 0);
  await sleep(150);
  check("...and once they stop, words after the goodbye hold it (member_spoke_after)", talking.ai.of("session.close").length === 0 && refusedWith(talking).join() === "member_spoke_after", refusedWith(talking));
  talking.tw.close();
  check("endGuard: they're speaking now (heard within the grace) refuses", B.endGuard({ cueLast: { text: "Bye, Jordan.", startMs: 900 }, memberAfterMs: null, memberHeardAgoMs: 10, graceMs: 2000 }) === "member_speaking");
  check("the closing read no longer holds GPT-Live's end_call (except on a safety turn); the ElevenLabs path keeps it", /endGuardedByCaller: !safety0/.test(src("services/gptLive.ts")) && /closed: callClosing\(b\) \|\| !!deps\.endGuardedByCaller,/.test(src("services/callLlmProxy.ts")) && !/endGuardedByCaller/.test(src("routes/callLlm.ts")));

  // A real new sentence after Cue's goodbye still refuses: quick but longer than three words, or short after a real gap.
  for (const [label, text, s] of [["four words or more, even within the gap", "one more thing, actually wait", 1300], ["two words after a gap past 1.2 s", "Wait, actually", 2400]] as [string, string, number][]) {
    const n = bridge({ answer: () => "|END", endGraceMs: 30 });
    await start(n, "live_new");
    frag(n, "member", "Bye. Have a good", 0, 1000);
    n.ai.in({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "n1", target: "client" } });
    await sleep(40);
    frag(n, "cue", "You too", 1100, 1500);
    frag(n, "member", text, s, s + 600);
    await sleep(150);
    check(`a real new sentence after Cue's goodbye (${label}): refused (member_spoke_after), the call stays open`, n.ai.of("session.close").length === 0 && refusedWith(n).join() === "member_spoke_after", refusedWith(n));
    n.tw.close();
  }
  // Review of #427: a short real "wait" right after Cue's goodbye (within 1.2 s of their own goodbye) is new words, never the end of
  // their goodbye: only one word starting within goodbyeTailMs of Cue's line starting can be that.
  for (const w of ["Oh wait", "Hold on", "One more thing"]) {
    const n = bridge({ answer: () => "|END", endGraceMs: 30 });
    await start(n, "live_wait");
    frag(n, "member", "Okay, bye.", 0, 800);
    n.ai.in({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "w1", target: "client" } });
    await sleep(40);
    frag(n, "cue", "Bye, Jordan.", 900, 1600);
    frag(n, "member", w, 1900, 2400);
    await sleep(150);
    check(`"${w}" about 1 s after Cue's goodbye: refused (member_spoke_after), the call stays open`, n.ai.of("session.close").length === 0 && refusedWith(n).join() === "member_spoke_after", refusedWith(n));
    n.tw.close();
  }
  // Re-review of #427: inside the old 500 ms window, and two words even at 200 ms.
  for (const [w, at] of [["Oh wait", 400], ["One more thing.", 500], ["Hold on", 200]] as [string, number][]) {
    const n = bridge({ answer: () => "|END", endGraceMs: 30 });
    await start(n, "live_wait2");
    frag(n, "member", "Okay, bye.", 0, 800);
    n.ai.in({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "w2", target: "client" } });
    await sleep(40);
    frag(n, "cue", "Bye, Jordan.", 900, 1600);
    frag(n, "member", w, 900 + at, 900 + at + 400);
    await sleep(150);
    check(`"${w}" ${at} ms into Cue's goodbye: refused (member_spoke_after), the call stays open`, n.ai.of("session.close").length === 0 && refusedWith(n).join() === "member_spoke_after", refusedWith(n));
    n.tw.close();
  }
  check("memberAfter: one word within goodbyeTailMs of Cue's line is the end of their goodbye; a later or longer start is new", B.memberAfter([{ who: "member", text: "Okay, bye.", startMs: 0, endMs: 800 }, { who: "member", text: "Oh wait", startMs: 1900, endMs: 2400 }], 900).newAt === 1900 && B.memberAfter([{ who: "member", text: "Bye. Have a good", startMs: 0, endMs: 1000 }, { who: "member", text: "one", startMs: 1300, endMs: 1500 }], 1100).newAt === null);

  // Review of #427: a held end lapses (heldEndMs). A turn long after carries no note, and an end there needs a fresh goodbye.
  check("the hold lapses after a named few seconds", G.GPT_LIVE.heldEndMs === 6000);
  const stale = bridge({ answer: () => "|END", endGraceMs: 30, heldEndMs: 50, endWaitMs: 80 });
  await start(stale, "live_stale");
  frag(stale, "member", "Okay bye.", 0, 800);
  stale.ai.in({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "h1", target: "client" } });
  await sleep(40);
  frag(stale, "cue", "Bye, Jordan.", 1000, 1600);
  frag(stale, "member", "Cool, cheers.", 3000, 3500);
  await sleep(120);
  check("stale hold: their words after the goodbye hold the end", refusedWith(stale).join() === "member_spoke_after" && stale.ai.of("session.close").length === 0, refusedWith(stale));
  await sleep(80); // past heldEndMs
  frag(stale, "member", "Anyway, about the lease in Oakland.", 33000, 35000);
  stale.ai.in({ type: "session.delegation.created", offset_ms: 35000, delegation: { id: "h2", target: "client" } });
  await sleep(200);
  check("...a turn 30 s later carries no held-end note", stale.reqs.length === 2 && !JSON.stringify(stale.reqs[1].messages).includes(G.END_HELD_NOTE));
  check("...and its end needs a fresh goodbye: with none said, it's dropped (no_goodbye), never a hang-up on the old one", stale.ai.of("session.close").length === 0 && refusedWith(stale).join() === "member_spoke_after,no_goodbye", refusedWith(stale));
  stale.tw.close();
  // A question from Cue still refuses, stray word or not.
  const q = bridge({ answer: () => "|END", endGraceMs: 30 });
  await start(q, "live_q2");
  frag(q, "member", "Bye. Have a good", 0, 1000);
  q.ai.in({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "q1", target: "client" } });
  await sleep(40);
  frag(q, "cue", "You too. Same time next week?", 1100, 2500);
  frag(q, "member", "one", 1300, 1500);
  await sleep(150);
  check("a question from Cue still refuses (cue_asked), with the split-off \"one\" inside it", q.ai.of("session.close").length === 0 && refusedWith(q).join() === "cue_asked", refusedWith(q));
  q.tw.close();

  // A "." answer is never spoken: as no answer (the note) when the voice hasn't spoken this turn, and nothing when it has.
  const dot = bridge({ answer: () => "." });
  await start(dot, "live_dot");
  frag(dot, "member", "What do you think I should do about the lease?", 0, 2000);
  dot.ai.in({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "p1", target: "client" } });
  await sleep(60);
  const p1 = sentFor(dot, "p1");
  check("a \".\" answer is never spoken: it counts as no answer (the existing note, nothing in the voice's mouth)", p1.length === 1 && p1[0].type === "session.thinking.append" && /No answer came back/.test(p1[0].content) && !p1.some((x: any) => /^\W+$/.test(x.content)), p1);
  frag(dot, "cue", "Hm.", 2600, 2900);
  frag(dot, "member", "Okay so", 4000, 4500);
  dot.ai.in({ type: "session.delegation.created", offset_ms: 4500, delegation: { id: "p2", target: "client" } });
  frag(dot, "cue", "Mm, go on.", 4700, 5200);
  await sleep(60);
  check("...and when the voice already spoke this turn, nothing is sent at all (noteSkipped)", sentFor(dot, "p2").length === 0, sentFor(dot, "p2"));
  dot.tw.close();
  check("thinkOnCall: punctuation-only text is no answer", (await G.thinkOnCall(callFor(), [{ who: "member", text: "one", startMs: 0, endMs: 300 }], () => (async function* () { for (const e of textEvents(", .")) yield e as any; })())).text === "");

  // A refused end is decided again on their next turn, told why; ending again goes through the normal guard.
  const r = bridge({ answer: () => "|END", endGraceMs: 30 });
  await start(r, "live_redo");
  frag(r, "member", "Okay bye.", 0, 800);
  r.ai.in({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "r1", target: "client" } });
  await sleep(40);
  frag(r, "cue", "Bye, Jordan.", 1000, 1600);
  frag(r, "member", "Cool, cheers.", 3000, 3500);
  await sleep(120);
  check("re-decide: their words after Cue's goodbye hold the end (member_spoke_after) and the call stays open", r.ai.of("session.close").length === 0 && refusedWith(r).join() === "member_spoke_after", refusedWith(r));
  r.ai.in({ type: "session.delegation.created", offset_ms: 3500, delegation: { id: "r2", target: "client" } });
  await sleep(150);
  const r2 = r.reqs[r.reqs.length - 1];
  check("...their next turn decides again and is told the end was held because they spoke", r.reqs.length === 2 && JSON.stringify(r2.messages).includes(G.END_HELD_NOTE));
  check("...ending again there passes the normal guard: the call ends, with no second goodbye", r.ai.of("session.close").length === 1 && sentFor(r, "r2").length === 0 && refusedWith(r).join() === "member_spoke_after", { refused: refusedWith(r), sent: sentFor(r, "r2") });
  r.tw.close();
  // The same when the voice hands their turn over before the bridge's own check: the pending end is decided again with that turn.
  const r3 = bridge({ answer: (req) => (/one more thing/.test(lastUser(req)) ? "Sure, what is it?" : "|END"), endGraceMs: 30 });
  await start(r3, "live_redo2");
  frag(r3, "member", "Okay bye.", 0, 800);
  r3.ai.in({ type: "session.delegation.created", offset_ms: 800, delegation: { id: "s1", target: "client" } });
  await sleep(40);
  frag(r3, "cue", "Bye, Jordan.", 1000, 1600);
  frag(r3, "member", "Oh wait, one more thing.", 3000, 4000);
  r3.ai.in({ type: "session.delegation.created", offset_ms: 4000, delegation: { id: "s2", target: "client" } });
  await sleep(150);
  check("...a new sentence handed over first: that turn decides again (told why), answers, and the call stays open", JSON.stringify(r3.reqs[1]?.messages ?? []).includes(G.END_HELD_NOTE) && r3.ai.of("session.close").length === 0 && sentFor(r3, "s2").some((x: any) => /what is it/.test(x.content)) && r3.records.some((x) => x.decision === "call.end_refused" && x.proposal.redecide === true));
  r3.tw.close();
  check("the end-call rule and the thinking's note say: a stray word after both goodbyes ends it, never a second goodbye", /isn't new conversation/.test(G.END_CALL_RULE) && /never a second goodbye/.test(G.END_CALL_RULE) && /An agreement or thanks alone isn't a goodbye unless it follows one/.test(G.END_CALL_RULE) && /Never add a second goodbye line/.test(callFor().backendSystem) && !/\bend_call\b/.test(G.END_HELD_NOTE));
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

  // Exact wording only when the answer itself carries a crisis or safety line (review of #330).
  check("the exact-wording instruction scopes itself: once, now, not again unless they ask", /once, exactly as written and in full/.test(G.sayExactly("x")) && /don't say it again unless they ask/.test(G.sayExactly("x")));
  const everyday = [
    ["The boss said I'm safe from the layoffs.", "That's a relief. Did he say what happens to your team?"],
    ["I'll stay safe on the drive, don't worry.", "Good. Text me when you're there if you want."],
    ["I can't do this anymore, the visa paperwork is endless.", "That paperwork sounds brutal. Which part is holding it up?"],
    ["I feel like I'm a burden on my cofounder.", "What makes it feel that way this week?"],
  ];
  for (const [theirs, ours] of everyday) {
    const e = bridge({ answer: () => ours });
    await start(e, "live_e");
    say(e, "member", theirs, 0);
    e.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "e1", target: "client" } });
    await sleep(40);
    const sent = e.ai.sent.find((m: any) => m.event_id === "answer_e1");
    check(`an everyday line ("${theirs}"): the answer goes in GPT-Live's own words (commentary), not as an exact-wording instruction`, sent?.type === "session.commentary.append" && sent.content === ours, sent);
    e.tw.close();
  }
  const sticky = bridge({ answer: (req: any) => (JSON.stringify(req.messages).includes("Friday") ? "Nothing on Friday yet. Want me to look into it after the call?" : LINE) });
  await start(sticky, "live_sticky");
  say(sticky, "member", "Honestly I don't want to be here anymore.", 0);
  sticky.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "k1", target: "client" } });
  await sleep(40);
  say(sticky, "cue", "I'm really glad you told me.", 1500);
  say(sticky, "member", "I'm okay now. What's on for Friday?", 4000);
  sticky.ai.in({ type: "session.delegation.created", offset_ms: 5000, delegation: { id: "k2", target: "client" } });
  await sleep(40);
  const k1 = sticky.ai.sent.find((m: any) => m.event_id === "answer_k1"), k2 = sticky.ai.sent.find((m: any) => m.event_id === "answer_k2");
  check("a real crisis answer goes word for word", k1?.type === "session.instructions.append" && k1.content.includes("988"));
  check("...but it isn't sticky: a later everyday answer on the same call goes in GPT-Live's own words", k2?.type === "session.commentary.append" && /Friday/.test(k2.content), k2);
  sticky.tw.close();
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

// ---------------------------------------------------------------- 5b. the safety moment is the answer's, not the call history's (review of #331)
{
  const lay = bridge({ answer: () => "That's a relief. Did he say what happens to your team?" });
  await start(lay, "live_lay");
  say(lay, "member", "The boss said I'm safe from the layoffs.", 0);
  lay.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "l1", target: "client" } });
  await sleep(40);
  lay.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 20 } });
  await sleep(5);
  check("an ordinary line (\"I'm safe from the layoffs\") then a safety-filter close: no safety path (no hold, no alert, no check-in)", lay.cuts.length === 0 && !lay.records.some((r) => r.decision === "call.gpt_live_safety_cut"));
  const LINE2 = "I'm really glad you told me. You can call or text 988 right now. Are you safe tonight?";
  const real = bridge({ answer: () => LINE2 });
  await start(real, "live_real");
  say(real, "member", "Honestly I don't want to be here anymore.", 0);
  real.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "r1", target: "client" } });
  await sleep(40);
  real.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 20 } });
  await sleep(5);
  check("a real crisis answer then a safety-filter close: the safety path runs once", real.cuts.length === 1 && real.records.filter((r) => r.decision === "call.gpt_live_safety_cut").length === 1);
}

// ---------------------------------------------------------------- 6. the voice-read ask after a call (back on GPT-Live with the Hume tee: evals/calls/gptLiveHume.ts)
{
  const co = src("routes/co.ts");
  check("the ElevenLabs path still queues the voice read's ask after a call", /if \(callUser && o\.askVoiceRead !== false\) import\("\.\.\/services\/voiceReadConsent\.js"\)\.then\(\(m\) => m\.queueVoiceReadAsk\(user_id\)\)/.test(co));
}

console.log(`gpt-live parity: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
