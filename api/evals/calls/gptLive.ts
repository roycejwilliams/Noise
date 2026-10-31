// The GPT-Live trial (services/gptLive.ts, services/gptLiveBridge.ts, routes/co.ts /co/gpt-live/*): the session setup, the
// Twilio <-> OpenAI audio framing, a delegated turn through the call brain, the transcript into the post-call steps, the cost
// guard, the unknown-caller path, two calls at once keeping to their own member, and the ElevenLabs routes left as they were.
// Layer 1: OpenAI, Twilio, Claude and the database are fakes; no network, no tokens. Invented members (Jordan, Noor).
//   npx tsx evals/calls/gptLive.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ELEVENLABS_TOOL_SECRET ||= "dummy-tool-secret";
process.env.TWILIO_AUTH = "dummy-twilio-auth";
process.env.API_URL = "https://cue.example.test";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import twilio from "twilio";

const G = await import("../../src/services/gptLive.js");
const B = await import("../../src/services/gptLiveBridge.js");
const H = await import("../../src/services/callHealth.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const { CUE_GUIDE } = await import("../../src/services/voiceCues.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const callFor = (name: string, context: string) => G.buildLiveCall({ userId: `u-${name.toLowerCase()}`, callSid: `CA-${name}`, firstName: name, voiceLayer: VOICE, contextSummary: context, rightNow: "It's Saturday afternoon for them.", findsNow: "", callReason: "", opening: `Hey ${name}, it's Cue. Glad you called.` });

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(d: unknown) { this.sent.push(JSON.parse(String(d))); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  in(m: unknown) { this.emit("message", JSON.stringify(m)); }
  of(type: string) { return this.sent.filter((m) => m.type === type || m.event === type); }
}
const textEvents = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }];

// One bridged call with fakes on every side; returns the sockets and what was recorded.
function bridge(call: import("../../src/services/gptLive.js").LiveCall | null, o: { answer?: (req: any) => string; now?: () => number; maxSessionMs?: number; delayMs?: number; key?: string | undefined; noStart?: boolean; startTimeoutMs?: number; heartbeatMs?: number; id?: string } = {}) {
  const tw = new FakeSocket(), ai = new FakeSocket();
  const reqs: any[] = [], records: any[] = [], results: any[] = [], minutes: any[] = [];
  let keyUsed = "";
  const issued = call ? G.issueLiveLink(call, Date.now(), o.id) : "not-a-link";
  B.setLiveDeps({
    connectOpenAI: (k) => { keyUsed = k; setImmediate(() => ai.emit("open")); return ai as any; },
    apiKey: () => ("key" in o ? o.key : "sk-test"),
    upstream: (req) => { reqs.push(req); const s = (o.answer ?? (() => "Friday works, and the Mission one is at seven."))(req); return (async function* () { if (o.delayMs) await sleep(o.delayMs); for (const e of textEvents(s)) yield e as any; })(); },
    record: (d) => records.push(d),
    postCall: async (r) => { results.push(r); },
    minutes: (id, secs, by) => minutes.push({ id, secs, by }),
    now: o.now ?? Date.now,
    log: () => {},
    maxSessionMs: o.maxSessionMs ?? 60_000,
    startTimeoutMs: o.startTimeoutMs ?? 60_000,
    heartbeatMs: o.heartbeatMs ?? 60_000,
  });
  B.handleGptLiveStream(tw as any);
  B.setLiveDeps(null);
  tw.in({ event: "connected" });
  if (!o.noStart) tw.in({ event: "start", streamSid: "MZ1", start: { callSid: "CA1", customParameters: { s: issued } } });
  return { tw, ai, reqs, records, results, minutes, key: () => keyUsed };
}

// ---------------------------------------------------------------- 1. session setup
{
  const call = callFor("Jordan", "Jordan is moving to Oakland in March and looking for a climbing partner.");
  const start: any = G.sessionStart(call, G.gptLiveVoice({}));
  check("session.start: gpt-live-1, mu-law 8 kHz both ways (Twilio's own format), client delegation", start.type === "session.start" && start.session.model === "gpt-live-1" && start.session.audio.format.type === "audio/pcmu" && start.session.audio.format.rate === 8000 && start.session.delegation.type === "client");
  check("voice: marin by default, GPT_LIVE_VOICE picks another", start.session.audio.output.voice === "marin" && G.gptLiveVoice({ GPT_LIVE_VOICE: " gleam " }) === "gleam");
  check("instructions are the ElevenLabs agent's call prompt with this member's values filled in", ["# Staying with them", "# Names the transcript gets wrong", "# Offers and promises"].every((h) => call.instructions.includes(h)) && call.instructions.includes(E.CALL_NOW.split("\n")[0]) && call.instructions.includes("Jordan is moving to Oakland") && call.instructions.includes("This call is inbound") && !/\{\{(first_name|context_summary|direction|right_now|finds_now|call_reason)\}\}/.test(call.instructions));
  check("...adapted only in format: no bracketed voice cues (GPT-Live would read them aloud)", !call.instructions.includes(CUE_GUIDE) && !/except a cue in square brackets/.test(call.instructions) && E.promptForElevenLabs(VOICE).includes(CUE_GUIDE));
  check("...plus GPT-Live's three policy headings and its <|SpawnThinking|> token", /Backchannel policy:/.test(call.instructions) && /Interruption policy:/.test(call.instructions) && /Delegation policy:/.test(call.instructions) && /Generate <\|SpawnThinking\|> when:/.test(call.instructions));
  check("the brain gets the same prompt plus how the call runs", call.backendSystem.startsWith(call.instructions.slice(0, 2000)) && call.backendSystem.includes(G.BACKEND_NOTE) && !call.backendSystem.includes("<|SpawnThinking|>"));
  check("no finds: the same line ElevenLabs gets", call.given.findsNow === "Nothing to offer right now. Don't offer an event.");
  check("the greeting is the opening line, as a developer message and once as commentary", start.session.input[0].role === "developer" && /Hey Jordan, it's Cue/.test(start.session.input[0].content[0].text) && G.greetingEvent(call).delegation_id === null);
  check("the stream URL is ours, wss", G.gptLiveStreamUrl("https://cue.example.test") === "wss://cue.example.test/co/gpt-live/stream" && G.isGptLiveStreamPath("/co/gpt-live/stream?x=1") && !G.isGptLiveStreamPath("/co/voice-stream"));
  const raw = E.promptForElevenLabs(VOICE);
  check("honesty: every act-on-the-call line being rewritten is really in the agent prompt (a moved line fails here, loudly)", G.ON_CALL_REWRITES.every(([from]) => raw.includes(from)), G.ON_CALL_REWRITES.filter(([from]) => !raw.includes(from)).map(([f]) => f));
  const hits = (t: string) => G.GPT_LIVE_FORBIDDEN.filter((re) => re.test(t)).map(String);
  check("honesty: GPT-Live's instructions never say to set it up, look it up now, say it's set up, or end_call", hits(call.instructions).length === 0, hits(call.instructions));
  check("honesty: nor does the brain's prompt", hits(call.backendSystem).length === 0, hits(call.backendSystem));
  check("honesty: both say nothing can be set up, looked up, sent or scheduled on the call; it's done right after; never claim it", [call.instructions, call.backendSystem].every((t) => t.includes(G.NOTHING_ON_THIS_CALL) && /right after the call/.test(t)) && /Never say it's done, set up, started or on its way/.test(G.NOTHING_ON_THIS_CALL));
  check("the automatic acknowledgment waits long enough to be cancelled", start.session.delegation.acknowledgement_delay_ms === 800);
  check("instructions fit GPT-Live's 16,384-token limit with room for a long context", call.instructions.length / 4 < 12_000, Math.round(call.instructions.length / 4));
}

// ---------------------------------------------------------------- 2. the audio bridge's framing
{
  let now = 1_000_000;
  const b = bridge(callFor("Jordan", "Jordan is moving to Oakland."), { now: () => now });
  await sleep(5);
  check("OpenAI is opened with our key, and session.start is the first thing sent", b.key() === "sk-test" && b.ai.sent[0]?.type === "session.start");
  b.tw.in({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: Buffer.alloc(160, 1).toString("base64") } });
  check("caller audio before session.started waits (nothing sent early)", b.ai.of("session.input_audio.append").length === 0);
  b.ai.in({ type: "session.started", session: { id: "live_1" } });
  const early = b.ai.of("session.input_audio.append");
  check("...then goes, byte for byte (mu-law passes through unconverted)", early.length === 1 && early[0].audio === Buffer.alloc(160, 1).toString("base64"));
  check("the greeting goes once the session starts", b.ai.of("session.commentary.append").length === 1 && b.ai.of("session.commentary.append")[0].delegation_id === null);
  const live = Buffer.alloc(160, 7).toString("base64");
  b.tw.in({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: live } });
  check("live caller audio goes as session.input_audio.append with Twilio's payload", b.ai.of("session.input_audio.append").at(-1)?.audio === live);
  b.ai.in({ type: "session.output_audio.delta", delta: Buffer.alloc(8000, 9).toString("base64") }); // one second of Cue
  const frames = b.tw.of("media");
  check("Cue's audio goes to Twilio as media frames on the call's stream, 20 ms each", frames.length > 0 && frames.every((f: any) => f.streamSid === "MZ1" && Buffer.from(f.media.payload, "base64").length === 160));
  check("...at most ~300 ms ahead of real time; the rest waits here", frames.length === 15, frames.length);
  now += 500;
  await sleep(45);
  check("...and follows as time passes, never more than ~300 ms ahead", b.tw.of("media").length === 30, b.tw.of("media").length);
  b.ai.in({ type: "session.input_transcript.delta", delta: "mm", start_ms: 9000, end_ms: 9200 });
  check("barge-in: a 'mm' while Cue talks clears nothing", b.tw.of("clear").length === 0);
  b.ai.in({ type: "session.input_transcript.delta", delta: " wait, actually", start_ms: 9200, end_ms: 9800 });
  check("barge-in: the caller taking the turn clears Twilio's buffer, once", b.tw.of("clear").length === 1 && b.tw.of("clear")[0].streamSid === "MZ1");
  now += 2000;
  await sleep(45);
  check("...and the audio waiting here is dropped, not played after it", b.tw.of("media").length === 30, b.tw.of("media").length);
  b.tw.in({ event: "stop" });
  check("the caller hanging up asks OpenAI to close", b.ai.of("session.close").length === 1);
  b.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 42.5 } });
  const sess = b.records.find((r) => r.decision === "call.gpt_live_session");
  check("the session's minutes are recorded from OpenAI's final usage", sess?.proposal.seconds === 42.5 && sess.proposal.confirmed === true && sess.proposal.provider === "gpt-live" && sess.proposal.maxQueuedMs === 1000 && sess.proposal.endedBy === "caller_hangup" && sess.proposal.clears === 1, sess);
  check("minutes are written as the session starts and when it ends, with how it ended", b.minutes[0]?.id === "live_1" && b.minutes[0].secs === 0 && b.minutes.at(-1)?.secs === 42.5 && b.minutes.at(-1)?.by === "caller_hangup", b.minutes);
}

// ---------------------------------------------------------------- 3. a delegated turn (read-only) and 4. two calls at once
{
  const jordan = bridge(callFor("Jordan", "Jordan is moving to Oakland in March and looking for a climbing partner."), { answer: () => "Good question. Do you mostly boulder, or rope climb?" });
  const noor = bridge(callFor("Noor", "Noor is leaving her design job and wants to meet founders in Austin."), { answer: () => "That's a big step. What made today the day?" });
  await sleep(5);
  jordan.ai.in({ type: "session.started", session: { id: "live_j" } });
  noor.ai.in({ type: "session.started", session: { id: "live_n" } });
  jordan.ai.in({ type: "session.output_transcript.delta", delta: "Hey Jordan, it's Cue.", start_ms: 0, end_ms: 1200 });
  jordan.ai.in({ type: "session.input_transcript.delta", delta: "Any climbing gyms near the new place?", start_ms: 1500, end_ms: 3200 });
  noor.ai.in({ type: "session.input_transcript.delta", delta: "I handed in my notice today.", start_ms: 900, end_ms: 2400 });
  jordan.ai.in({ type: "session.delegation.created", offset_ms: 3300, delegation: { id: "item_j1", type: "delegation", target: "client" } });
  noor.ai.in({ type: "session.delegation.created", offset_ms: 2500, delegation: { id: "item_n1", type: "delegation", target: "client" } });
  await sleep(60);
  const ans = jordan.ai.of("session.commentary.append").find((m: any) => m.delegation_id === "item_j1");
  check("delegation round trip: the brain's answer goes back as commentary under the delegation's id", ans?.content === "Good question. Do you mostly boulder, or rope climb?", ans);
  const forJ = jordan.ai.sent.filter((m: any) => m.delegation_id === "item_j1");
  check("the automatic 'let me think' is cancelled first: an empty thinking append under the delegation's id", forJ[0]?.type === "session.thinking.append" && forJ[0].content === "" && forJ[0].event_id === "quiet_item_j1");
  const req = jordan.reqs[0];
  const sys = req?.system?.map((x: any) => x.text).join("\n") ?? "";
  check("the brain is Claude through the call brain, with the caller's prompt and this call's transcript", /^claude-/.test(req?.model) && sys.includes("Jordan is moving to Oakland") && sys.includes(G.BACKEND_NOTE) && JSON.stringify(req.messages).includes("Any climbing gyms near the new place?"));
  check("read-only: the brain gets no tools", !req?.tools || req.tools.length === 0);
  const lat = jordan.records.find((r) => r.decision === "call.turn_latency" && r.action === "gpt_live");
  check("each delegated turn records its latency, tagged with the provider", lat?.proposal.provider === "gpt-live" && typeof lat.proposal.totalMs === "number" && "firstTokenMs" in lat.proposal && lat.userId === "u-jordan", lat);
  const both = [...jordan.reqs, ...noor.reqs];
  const jText = JSON.stringify(jordan.reqs), nText = JSON.stringify(noor.reqs);
  check("cross-member: Jordan's brain never sees Noor's context or words", jordan.reqs.length >= 1 && noor.reqs.length >= 1 && !jText.includes("Noor") && !jText.includes("Austin") && !jText.includes("handed in my notice"));
  check("cross-member: Noor's brain never sees Jordan's context or words", !nText.includes("Jordan") && !nText.includes("Oakland") && !nText.includes("climbing"));
  check("cross-member: each answer goes back to its own session only", !noor.ai.sent.some((m: any) => m.delegation_id === "item_j1") && !jordan.ai.sent.some((m: any) => m.delegation_id === "item_n1") && noor.ai.of("session.commentary.append").some((m: any) => m.delegation_id === "item_n1"));
  check("cross-member: records name their own member", jordan.records.every((r) => r.userId === "u-jordan") && noor.records.every((r) => r.userId === "u-noor"));
  // A failed brain: no guessing, and the health check sees the error.
  const broken = bridge(callFor("Jordan", "x"), { answer: () => { throw new Error("upstream 529"); } });
  await sleep(5);
  broken.ai.in({ type: "session.started", session: { id: "live_b" } });
  broken.ai.in({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "item_b", target: "client" } });
  await sleep(30);
  check("a failed brain turn: a silent note to GPT-Live (no guess), and call.turn_health error for the health check", broken.ai.of("session.thinking.append").some((m: any) => m.event_id === "answer_item_b" && m.content) && broken.records.some((r) => r.decision === "call.turn_health" && r.action === "error"));
  // The call brain's own checks still hold: an event, day and time nothing backs is not passed on to be said.
  const unsourced = bridge(callFor("Jordan", "Jordan is moving to Oakland."), { answer: () => "Friday works, and the Mission one is at seven." });
  await sleep(5);
  unsourced.ai.in({ type: "session.started", session: { id: "live_u" } });
  unsourced.ai.in({ type: "session.input_transcript.delta", delta: "Anything this week?", start_ms: 0, end_ms: 900 });
  unsourced.ai.in({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "item_u", target: "client" } });
  await sleep(40);
  const said = unsourced.ai.sent.filter((m: any) => m.delegation_id === "item_u").map((m: any) => m.content).join(" ");
  check("an unsourced event offer from the brain is held back and logged (call.offer_unsourced), never handed to GPT-Live", !/Mission|Friday/.test(said) && unsourced.records.some((r) => r.decision === "call.offer_unsourced"), said);
  // The caller moved on while the brain thought: its answer is dropped, not said over the new question.
  const moved = bridge(callFor("Jordan", "Jordan is moving to Oakland."), { answer: () => "The one near you opens at six.", delayMs: 30 });
  await sleep(5);
  moved.ai.in({ type: "session.started", session: { id: "live_m" } });
  moved.ai.in({ type: "session.input_transcript.delta", delta: "Is the gym open early?", start_ms: 0, end_ms: 1000 });
  moved.ai.in({ type: "session.delegation.created", offset_ms: 1100, delegation: { id: "item_m", target: "client" } });
  await sleep(10);
  moved.ai.in({ type: "session.output_transcript.delta", delta: "Mm.", start_ms: 1150, end_ms: 1300 });
  moved.ai.in({ type: "session.input_transcript.delta", delta: "Actually forget that, what about Sunday?", start_ms: 1500, end_ms: 3000 });
  await sleep(60);
  check("stale answer: the caller moved on, so the answer is dropped (and logged stale)", !moved.ai.sent.some((m: any) => m.delegation_id === "item_m" && m.type === "session.commentary.append") && moved.records.some((r) => r.decision === "call.turn_latency" && r.action === "gpt_live" && r.proposal.stale === true));
  check("...while an answer to the latest question still goes (the Jordan turn above)", jordan.records.some((r) => r.action === "gpt_live" && r.proposal.stale === false));
  for (const b of [jordan, noor, broken, unsourced, moved]) b.tw.close();
}

// ---------------------------------------------------------------- 5. the transcript into the post-call steps
{
  const b = bridge(callFor("Jordan", "Jordan is moving to Oakland."));
  await sleep(5);
  b.ai.in({ type: "session.started", session: { id: "live_t" } });
  const say = (who: "in" | "out", delta: string, s: number, e: number) => b.ai.in({ type: `session.${who === "in" ? "input" : "output"}_transcript.delta`, delta, start_ms: s, end_ms: e });
  say("out", "Hey Jordan,", 0, 600); say("out", " it's Cue.", 600, 1200);
  say("in", "Hi. So the move", 1500, 2500); say("out", "mm", 2100, 2300); say("in", " is set for March.", 2500, 3500);
  say("out", "That's soon. Have you found a place", 3900, 5400); say("in", "Actually wait", 5000, 5600); say("out", " yet?", 5400, 5700);
  say("in", "Okay bye.", 6000, 6600); say("out", "Talk soon.", 6800, 7400);
  b.tw.in({ event: "stop" });
  b.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 8 } });
  await sleep(5);
  const r = b.results[0];
  check("after the call the post-call steps get the whole call", r?.sessionId === "live_t" && r.call.userId === "u-jordan" && r.seconds === 8 && r.reason === "caller hung up");
  const turns = G.elTurnsOf(r.turns);
  const transcript = E.transcriptFromTurns(turns as any);
  check("fragments join as sent into turns, in ElevenLabs' transcript shape", /^assistant: Hey Jordan, it's Cue\.\nuser: Hi\. So the move\nassistant: mm\nuser: is set for March\./.test(transcript), transcript);
  check("a Cue line the member cut into is marked interrupted (talk_over reads it); a backchannel 'mm' is not a cut-in", turns.find((t) => /Have you found/.test(t.message))?.interrupted === true && turns.find((t) => t.message === "Hey Jordan, it's Cue.")?.interrupted === false);
  const two = G.elTurnsOf(G.turnsFrom([{ who: "cue", text: "One two three four five.", startMs: 0, endMs: 2000 }, { who: "member", text: "wait", startMs: 1000, endMs: 1300 }, { who: "cue", text: "Six seven eight nine.", startMs: 3000, endMs: 5000 }, { who: "member", text: "no", startMs: 4000, endMs: 4200 }, { who: "cue", text: "Okay.", startMs: 5000, endMs: 5400 }]));
  check("call health reads GPT-Live's turns: two cut-ins is talk_over", H.callHealthReasons({ durationSecs: 60, terminationReason: "close_requested", status: null, turns: two, decisions: [], frustratedWithCo: false }).includes("talk_over"));
  check("reply gaps: member's last word to Cue's first, listening sounds skipped", JSON.stringify(G.replyGaps(r.turns)) === JSON.stringify([400, -200, 200]), G.replyGaps(r.turns));
  check("each reply's gap is recorded as call.turn_latency gpt_live_voice", b.records.filter((x) => x.decision === "call.turn_latency" && x.action === "gpt_live_voice").length === 3);
  const co = src("routes/co.ts");
  const post = co.slice(co.indexOf("export async function runGptLivePostCall"), co.indexOf("// Root-cause guard"));
  check("the post-call adapter runs the same steps as ElevenLabs' webhook: grade, source check, processEndedCall, call health, audits", ["recordCallEvaluation", "recordOfferSourceCheck", "processEndedCall({", "recordCallHealth({", "flagNotStored(", "call.emotion_label", "call.narration"].every((x) => post.includes(x)));
  check("...keyed gpt-live:<session> so call health compares the two by source", /const conversationId = `gpt-live:\$\{r\.sessionId\}`;/.test(post) && /callKey: conversationId/.test(post));
  // And actually through them, with the database a recording stub (the model calls inside answer with layer 1's canned stub; nothing
  // here reads what a model said): the call is claimed under gpt-live:<session>, its transcript stored, the follow-up text queued
  // and call health written under the same id.
  {
    const { runGptLivePostCall } = await import("../../src/routes/co.js");
    const { default: pool } = await import("../../src/db/db.js");
    const realQuery = pool.query.bind(pool), realConnect = (pool as any).connect;
    const writes: { sql: string; params: any[] }[] = [];
    (pool as any).query = async (sql: string, params: any[] = []) => {
      if (/^\s*(INSERT|UPDATE)/.test(sql)) writes.push({ sql: sql.replace(/\s+/g, " "), params });
      if (/INSERT INTO call_processing/.test(sql)) return { rows: [{ chat_id: params[0] }] };
      if (/UPDATE users SET call_status = 'processing'/.test(sql)) return { rows: [{ id: params[0] }] };
      if (/SELECT id, first_name, phone_number, call_sid FROM users/.test(sql)) return { rows: [{ id: "u-jordan", first_name: "Jordan", phone_number: "+15550001111", call_sid: "CA-Jordan" }] };
      if (/INSERT INTO co_memories/.test(sql)) return { rows: [{ id: "m1" }] };
      return { rows: [] };
    };
    (pool as any).connect = async () => ({ query: (pool as any).query, release() {} });
    const body = await runGptLivePostCall(r).catch((e: any) => ({ error: String(e?.message ?? e) }));
    await sleep(800);
    (pool as any).query = realQuery;
    (pool as any).connect = realConnect;
    const w = (re: RegExp) => writes.filter((x) => re.test(x.sql));
    check("post-call: processed to the end", (body as any)?.success === true, body);
    check("post-call: claimed once under gpt-live:<session>", w(/INSERT INTO call_processing/).some((x) => x.params[0] === "gpt-live:live_t"));
    check("post-call: the transcript is stored as the call's transcript", w(/INSERT INTO co_memories .*'call_transcript'/).some((x) => x.params.some((p: any) => typeof p === "string" && p.includes("user: Hi. So the move"))));
    check("post-call: the follow-up text is queued from the call", w(/INSERT INTO post_call_follow_ups/).length === 1);
    check("post-call: call health is written under the same id", w(/INSERT INTO call_health/).some((x) => x.params[0] === "gpt-live:live_t"));
  }
  const graded = await G.gradeLiveCall("user: hi\nassistant: hey", async () => JSON.stringify({ results: [{ id: "no_invented_specifics", result: "failure", rationale: "named 'Blue Door'" }, { id: "made_up", result: "failure" }, { id: "short_spoken_replies", result: "success" }] }));
  check("the grade comes back in ElevenLabs' analysis shape, known criteria only", Object.keys(graded.evaluation_criteria_results).join() === "no_invented_specifics,short_spoken_replies" && (await import("../../src/services/callEvals.js")).failedCriteria(graded).map((f) => f.id).join() === "no_invented_specifics");
}

// ---------------------------------------------------------------- 6. the cost guard
{
  const db = (secs: number) => ({ sqls: [] as string[], query: async function (sql: string) { this.sqls.push(sql); return { rows: [{ s: String(secs) }] }; } });
  G.openSessions.clear();
  const min = 60_000;
  const a1 = await G.admitSession(db(100 * 60));
  check("100 of 130 minutes used: admitted with the full 30-minute session cap", a1?.capMs === 30 * min && a1.trialLimited === false, a1);
  G.openSessions.clear();
  const a2 = await G.admitSession(db(115 * 60));
  check("115 used: admitted, capped at the 15 minutes the trial has left", a2?.capMs === 15 * min && a2.trialLimited === true, a2);
  G.openSessions.clear();
  check("129.5 used: refused (less than a minute left)", (await G.admitSession(db(129.5 * 60))) === null);
  G.openSessions.clear();
  const both = await Promise.all([G.admitSession(db(80 * 60)), G.admitSession(db(80 * 60)), G.admitSession(db(80 * 60))]);
  check("calls at once share what's left: 30, then the 20 left after it, then none", both[0]?.capMs === 30 * min && both[1]?.capMs === 20 * min && both[2] === null, both.map((x) => x?.capMs ?? null));
  G.openSessions.clear();
  check("a total that can't be read refuses (fails closed)", (await G.admitSession({ query: async () => { throw new Error("db down"); } })) === null);
  const d0 = db(0);
  await G.admitSession(d0);
  check("minutes come from gpt_live_minutes (no user column, never pruned), not harness_decisions", d0.sqls.every((q) => /FROM gpt_live_minutes/.test(q)) && /CREATE TABLE IF NOT EXISTS gpt_live_minutes \(\s*session_id TEXT PRIMARY KEY,[^)]*\)/.test(src("db/migrations.ts")) && !/gpt_live_minutes[^`]*REFERENCES/.test(src("db/migrations.ts")) && !/DELETE FROM gpt_live_minutes/.test(src("jobs/index.ts")));
  G.openSessions.clear();

  // Held while the call runs: the bridge closes the session at its own cap, the same way as the 30-minute one.
  const adm = await G.admitSession(db(129 * 60 - 0.04)); // just over a minute left
  check("near the end of the trial a call gets only what's left", adm?.trialLimited === true && adm.capMs < 2 * min, adm);
  const short = { ...callFor("Jordan", "x"), capMs: 40, trialLimited: true };
  const t = bridge(short, { id: adm!.id, heartbeatMs: 15 });
  await sleep(5);
  t.ai.in({ type: "session.started", session: { id: "live_trialcap" } });
  check("a running session counts while it runs, under its admission", G.openSessions.get(adm!.id)?.sessionId === "live_trialcap" && (await G.trialMinutesUsed(db(0))) >= 0);
  await sleep(70);
  check("heartbeat: minutes are written while the call runs", t.minutes.filter((m: any) => m.by === null).length >= 2, t.minutes);
  check("the trial cap ends the session the same way as the session cap (session.close)", t.ai.of("session.close").length === 1);
  t.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 64 } });
  const ts = t.records.find((r) => r.decision === "call.gpt_live_session");
  check("...recorded as ended by the trial cap, minutes logged, admission released", ts?.proposal.endedBy === "trial_cap" && t.minutes.at(-1)?.by === "trial_cap" && t.tw.readyState === 3 && !G.openSessions.has(adm!.id), ts);
  const b = bridge(callFor("Jordan", "x"), { maxSessionMs: 40 });
  await sleep(5);
  b.ai.in({ type: "session.started", session: { id: "live_cap" } });
  await sleep(70);
  check("each session is capped at 30 minutes: at its limit the session is closed", b.ai.of("session.close").length === 1);
  b.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 1800 } });
  check("...recorded as ended by the session cap", b.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "session_cap");
  check("the route checks team, then the cap, before anything is loaded, and refuses busy (no new words)", (() => { const co = src("routes/co.ts"); const h = co.slice(co.indexOf('"/gpt-live/incoming-call"'), co.indexOf('"/gpt-live/after-stream"')); return h.indexOf("isTeamMember(userId)") < h.indexOf("admitSession()") && h.indexOf("admitSession()") < h.indexOf("buildCallContextSummary") && /twiml\.reject\(\{ reason: "busy" \}\)/.test(h); })());
  G.openSessions.clear();
}

// ---------------------------------------------------------------- 7. the unknown caller, and a stream nobody issued
{
  const { createCoRouter } = await import("../../src/routes/co.js");
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = pool.query.bind(pool);
  (pool as any).query = async (sql: string) => (/FROM users WHERE phone_number/.test(sql) ? { rows: [] } : { rows: [] });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/co", createCoRouter(null as any));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = async (path: string, body: Record<string, string>) => {
    const sig = twilio.getExpectedTwilioSignature("dummy-twilio-auth", `${process.env.API_URL}${path}`, body);
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(body) });
    return { status: r.status, text: await r.text() };
  };
  const unknown = await post("/co/gpt-live/incoming-call", { From: "+15550001111", To: "+15550002222", CallSid: "CA-x", StirVerstat: "TN-Validation-Passed-A" });
  check("an unknown number hears today's line and the call ends, nothing streamed", unknown.status === 200 && /we don't recognize this number/.test(unknown.text) && /<Hangup\/>/.test(unknown.text) && !/<Stream/.test(unknown.text), unknown);
  // A verified member who isn't on the team: refused busy, with a decision row, and nothing of theirs loaded or sent.
  const writes: { sql: string; params: any[] }[] = [];
  let team = false, logged = 0;
  (pool as any).query = async (sql: string, params: any[] = []) => {
    if (/^\s*(INSERT|UPDATE)/.test(sql)) writes.push({ sql, params });
    if (/FROM users WHERE phone_number/.test(sql)) return { rows: [{ id: "u-noor", invite_verified: true, identity_captured: true, archived_at: null }] };
    if (/SELECT mo_approver FROM users/.test(sql)) return { rows: [{ mo_approver: team }] };
    if (/FROM gpt_live_minutes/.test(sql)) return { rows: [{ s: String(logged) }] };
    return { rows: [] };
  };
  const member = await post("/co/gpt-live/incoming-call", { From: "+15550003333", To: "+15550002222", CallSid: "CA-m", StirVerstat: "TN-Validation-Passed-A" });
  const refusedRow = (why: string) => writes.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.gpt_live_refused" && w.params[4] === why);
  check("team only: a member not on the team is refused busy, with a decision row; nothing is loaded or streamed", /<Reject reason="busy"\/>/.test(member.text) && !/<Stream/.test(member.text) && refusedRow("not_team") && !writes.some((w) => /call_status = 'initiated'/.test(w.sql)), member);
  team = true;
  logged = 130 * 60;
  const capped = await post("/co/gpt-live/incoming-call", { From: "+15550003333", To: "+15550002222", CallSid: "CA-c", StirVerstat: "TN-Validation-Passed-A" });
  check("a team member past the trial's 130 minutes is refused busy too", /<Reject reason="busy"\/>/.test(capped.text) && refusedRow("trial_minutes_used"), capped);
  // The <Connect> action: a stream that never started plays the existing can't-connect line and releases call_status.
  const { CANT_CONNECT_LINE } = await import("../../src/services/elevenLabsCalls.js");
  G.markCall("CA-fail", "u-noor", "pending");
  const failed = await post("/co/gpt-live/after-stream", { CallSid: "CA-fail" });
  check("never connected: the ElevenLabs path's own can't-connect line, then hang up, and call_status released", failed.text.includes(CANT_CONNECT_LINE) && /<Hangup\/>/.test(failed.text) && writes.some((w) => /SET call_status = 'failed'/.test(w.sql) && w.params[0] === "u-noor"), failed);
  G.markCall("CA-ok", "u-noor", "pending");
  G.markCall("CA-ok", "u-noor", "started");
  G.markCall("CA-ok", "u-noor", "failed");
  const ok = await post("/co/gpt-live/after-stream", { CallSid: "CA-ok" });
  check("a call that ran just hangs up (no can't-connect line after a real call)", !ok.text.includes(CANT_CONNECT_LINE) && /<Hangup\/>/.test(ok.text));
  const unsigned = await fetch(`http://127.0.0.1:${port}/co/gpt-live/incoming-call`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "From=%2B15550001111" });
  check("an unsigned request is refused", unsigned.status === 401);
  server.close();
  (pool as any).query = realQuery;
  const stray = bridge(null);
  await sleep(5);
  check("a stream without a live one-time id is refused: OpenAI is never opened", stray.key() === "" && stray.tw.readyState === 3);
  G.takeCallState("CA-Jordan");
  // Hangs end cleanly: no Twilio start, no session.started, no key. Each leaves the call marked failed for the <Connect> action.
  const noStart = bridge(callFor("Jordan", "x"), { noStart: true, startTimeoutMs: 20 });
  await sleep(40);
  check("Twilio never sends start: the stream is closed after the timeout", noStart.tw.readyState === 3 && noStart.key() === "");
  const noSession = bridge(callFor("Jordan", "x"), { startTimeoutMs: 20 });
  await sleep(40);
  check("OpenAI never starts the session: closed after the timeout, both sides", noSession.tw.readyState === 3 && noSession.ai.readyState === 3 && G.takeCallState("CA-Jordan")?.state === "failed");
  const noKey = bridge(callFor("Jordan", "x"), { key: undefined });
  await sleep(5);
  check("no OpenAI key: ended at once, nothing opened, the call marked failed", noKey.key() === "" && noKey.tw.readyState === 3 && G.takeCallState("CA-Jordan")?.state === "failed");
  const once = callFor("Jordan", "x");
  const id = G.issueLiveLink(once);
  check("stream ids are single use and expire", G.takeLiveLink(id) === once && G.takeLiveLink(id) === null && G.takeLiveLink(G.issueLiveLink(once, Date.now() - G.GPT_LIVE.linkTtlMs - 1)) === null);
  const wss = "wss://cue.example.test/co/gpt-live/stream";
  const { twilioSignatureFor } = await import("../../src/services/mediaStreamBridge.js");
  check("the stream handshake needs Twilio's signature over our URL", B.twilioStreamSignatureOk(twilioSignatureFor("dummy-twilio-auth", wss), wss) && !B.twilioStreamSignatureOk("bogus", wss) && !B.twilioStreamSignatureOk(twilioSignatureFor("dummy-twilio-auth", wss), wss, {}));
}

// ---------------------------------------------------------------- 8. ElevenLabs left as it was
{
  const { createCoRouter } = await import("../../src/routes/co.js");
  const routes = ((createCoRouter(null as any) as any).stack as any[]).filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(",")} ${l.route.path}`);
  check("the ElevenLabs routes are all still there", ["post /incoming-call", "post /el/outbound-twiml", "post /el/tool/:name", "post /el/post-call"].every((r) => routes.includes(r)), routes);
  check("the trial has its own route; /incoming-call still goes to ElevenLabs", routes.includes("post /gpt-live/incoming-call") && (() => { const co = src("routes/co.ts"); const h = co.slice(co.indexOf('"/incoming-call"'), co.indexOf("// ---------- ElevenLabs calls")); return h.includes("registerElevenLabsCall({") && !/gpt-?live/i.test(h); })());
  const server = src("server.ts");
  check("the voice read's stream handler is unchanged beside the trial's", /if \(!isVoiceStreamPath\(req\.url\)\) return;/.test(server) && /if \(!isGptLiveStreamPath\(req\.url\)\) return;/.test(server) && /handleTwilioStream\(ws as unknown as SocketLike\)/.test(server));
  check("nothing in the ElevenLabs files mentions the trial", ["services/elevenLabsCalls.ts", "routes/callLlm.ts", "services/callLlmProxy.ts", "services/mediaStreamBridge.ts"].every((f) => !/gpt-?live/i.test(src(f))));
  check("no switch: the trial is live only on its route (no GPT_LIVE_ENABLED-style flag)", !/process\.env\.GPT_LIVE_(?!VOICE)/.test(src("services/gptLive.ts") + src("services/gptLiveBridge.ts") + src("routes/co.ts")));
}

console.log(`gpt-live trial: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
