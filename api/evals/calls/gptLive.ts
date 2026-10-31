// GPT-Live calls (services/gptLive.ts, services/gptLiveBridge.ts, routes/co.ts): the short prompt, the session setup, the
// Twilio <-> OpenAI audio framing, a delegated turn through the call brain, the transcript into the post-call steps, the team's
// monthly minutes, the unknown-caller path, the main number answering the team with GPT-Live and everyone else with ElevenLabs
// byte for byte, two calls at once keeping to their own member, and the ElevenLabs routes left as they were.
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
const callFor = (name: string, context: string) => G.buildLiveCall({ userId: `u-${name.toLowerCase()}`, callSid: `CA-${name}`, firstName: name, direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: context, rightNow: "It's Saturday afternoon for them.", findsNow: "", callReason: "", timeOfDay: "Saturday afternoon" });

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
  // GPT-Live's own prompt is short (OpenAI's prompting guide; on the 10-31 trial call the full prompt gave "I hear you.", narration of
  // how voice systems work, and long replies). Everything detailed is the thinking's.
  const I = call.instructions, sys = call.backendSystem;
  check(`GPT-Live's prompt stays under ${G.GPT_LIVE.maxInstructionChars} characters`, I.length < G.GPT_LIVE.maxInstructionChars, I.length);
  const outbound = G.buildLiveCall({ userId: "u-noor", callSid: "CA-N", firstName: "Noor", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "x".repeat(9000), rightNow: "y".repeat(500), findsNow: "- " + "z".repeat(3000), callReason: "w".repeat(500), timeOfDay: "Tuesday morning" });
  const longReason = G.buildLiveCall({ userId: "u-noor", callSid: "CA-N", firstName: "Noor", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "x".repeat(9000), rightNow: "y".repeat(500), findsNow: "- " + "z".repeat(3000), callReason: "Their pitch to the second fund is Thursday.", timeOfDay: "Tuesday morning" });
  const worst = G.buildLiveCall({ userId: "u-noor", callSid: "CA-N", firstName: "Maximiliana-Josephine", direction: "outbound", team: true, voiceLayer: VOICE, contextSummary: "What they're in the middle of:\n- " + "m".repeat(2000), rightNow: "", findsNow: "", callReason: "r".repeat(3000), timeOfDay: "Wednesday afternoon" });
  check("...even with the longest reason and name", worst.instructions.length < G.GPT_LIVE.maxInstructionChars, worst.instructions.length);
  check("...whatever the member's context or finds weigh (none of it is in GPT-Live's prompt; the call's reason is)", longReason.instructions.length < G.GPT_LIVE.maxInstructionChars && !/xxxx|yyyy|zzzz/.test(longReason.instructions) && longReason.instructions.includes("Their pitch to the second fund is Thursday."), longReason.instructions.length);
  check("...roles and style first, then the three policy headings in the guide's order, and <|SpawnThinking|>", I.startsWith(`${G.LIVE_WHO} You're on a phone call with Jordan.`) && I.indexOf("Backchannel policy:") > I.indexOf(G.LIVE_VOICE_RULES[0].line) && I.indexOf("Backchannel policy:") < I.indexOf("Interruption policy:") && I.indexOf("Interruption policy:") < I.indexOf("Delegation policy:") && /Generate <\|SpawnThinking\|> when:/.test(I) && /Do not generate <\|SpawnThinking\|> when:/.test(I) && /Backend tools:/.test(I));
  check("...opens with the call prompt's own first sentences, word for word", VOICE.startsWith(G.LIVE_WHO));
  check("...carries who Cue is never and its old name, read from the voice layer (not copied into code)", G.identityFromVoice(VOICE).startsWith('You are only ever "Cue":') && G.identityFromVoice(VOICE).endsWith("don't correct them.") && I.includes(G.identityFromVoice(VOICE)) && !src("services/gptLive.ts").includes("never a concierge"));
  check("...and carries every voice rule", G.LIVE_VOICE_RULES.every((r) => I.includes(r.line)), G.LIVE_VOICE_RULES.filter((r) => !I.includes(r.line)).map((r) => r.line));
  const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const VOICE_SOURCES: Record<string, string> = { "call prompt": VOICE, CO_VOICE: (await import("../../src/services/coVoice.js")).CO_VOICE, VARIETY_GUIDE: (await import("../../src/harness/stockLines.js")).VARIETY_GUIDE, OPENING_NOTE: E.OPENING_NOTE };
  check("...each copied word for word from where it already lives (no new voice rules)", G.LIVE_VOICE_RULES.every((r) => VOICE_SOURCES[r.from].includes(r.line) || VOICE_SOURCES[r.from].includes(lc(r.line))), G.LIVE_VOICE_RULES.filter((r) => !VOICE_SOURCES[r.from].includes(r.line) && !VOICE_SOURCES[r.from].includes(lc(r.line))).map((r) => r.line));
  check("...the voice rules the trial call broke: stock empathy, narrating how Cue works, long replies", /stock lines of empathy/.test(I) && /A sentence that would fit after any answer is a stock sentence/.test(I) && /How you work behind the scenes is never news\./.test(I) && /Short sentences, one thought each/.test(I) && /Say less than you could\./.test(I));
  check("...the honesty line: nothing can be done on this call, and GPT-Live promises nothing itself (promises are the thinking's)", I.includes(G.NOTHING_ON_THIS_CALL_LIVE) && /Never promise anything yourself/.test(G.NOTHING_ON_THIS_CALL_LIVE) && !I.includes("say you'll do it right after the call"));
  check("...safety on GPT-Live's side: crisis resources come from the thinking, said exactly", I.includes(G.SAFETY_FROM_THINKING) && /any crisis line or number, comes from your thinking: say it exactly/.test(G.SAFETY_FROM_THINKING));
  check("...the goodbye line is cut before \"after you've done something for them mid-call\" (nothing is done on the call)", !I.includes("after you've done something for them mid-call") && I.includes("never sign off at the end of an ordinary turn.\nSay that goodbye once."));
  check("...what GPT-Live says on its own is conversational only; facts, specifics, promises and claims about Cue come from its thinking", I.includes(G.SAY_ON_YOUR_OWN) && /say only conversational lines: acknowledging, saying back what they just said, a short warm response, or a clarifying question/.test(G.SAY_ON_YOUR_OWN) && ["any fact about their life, plans or history", "any event, place, time, person or link", "any promise or anything Cue will do", "anything about what Cue knows or has done"].every((x) => G.SAY_ON_YOUR_OWN.includes(x)));
  const genWhen = I.slice(I.indexOf("Generate <|SpawnThinking|> when:"), I.indexOf("Do not generate <|SpawnThinking|> when:"));
  check("...and the delegation policy sends those turns to the thinking", ["- You would state a fact about their life, plans or history.", "- You would name an event, place, time, person or link.", "- You would promise anything, or say what Cue will do.", "- You would say what Cue knows or has done."].every((x) => genWhen.includes(x)) && I.indexOf(G.SAY_ON_YOUR_OWN) < I.indexOf("Backchannel policy:"));
  check("...who's calling whom (and that they build Cue) rides in it; no member context does", I.includes("This call: they called you.") && I.includes("Noise team that builds you") && !I.includes("Jordan is moving to Oakland") && !I.includes("# What you know about") && !I.includes("# Offers and promises") && !/\{\{\w+\}\}/.test(I));
  check("the thinking gets the ElevenLabs agent's whole call prompt with this member's values filled in", ["# Staying with them", "# Names the transcript gets wrong", "# Offers and promises"].every((h) => sys.includes(h)) && sys.includes(E.CALL_NOW.split("\n")[0]) && sys.includes("Jordan is moving to Oakland") && sys.includes("This call is inbound") && sys.includes("This call: they called you.") && !/\{\{(first_name|context_summary|direction|right_now|finds_now|call_reason)\}\}/.test(sys));
  check("...adapted only in format: no bracketed voice cues", !sys.includes(CUE_GUIDE) && !/except a cue in square brackets/.test(sys) && E.promptForElevenLabs(VOICE).includes(CUE_GUIDE));
  check("...plus how the call runs, and no GPT-Live policy tokens", sys.includes(G.BACKEND_NOTE) && !sys.includes("<|SpawnThinking|>"));
  check("an outbound call says so in both prompts", outbound.instructions.includes("This call: you called them") && outbound.backendSystem.includes("This call is outbound") && outbound.direction === "outbound");
  check("no finds: the same line ElevenLabs gets", call.given.findsNow === "Nothing to offer right now. Don't offer an event.");
  // No scripted opening (Royce, 10-31): GPT-Live opens in its own words; the session carries no greeting text and no template.
  const E2 = E as any;
  const templates: string[] = (E2.OPENINGS ?? []).map((t: any) => String(t.text ?? "")).filter(Boolean);
  const startText = JSON.stringify(start);
  const templateBits = templates.flatMap((t) => t.split(/\{\{?\w+\}?\}/).map((x) => x.trim()).filter((x) => x.length >= 8));
  check("opening: the session's one developer message only says the call connected (no greeting text, no commentary nudge)", start.session.input.length === 1 && start.session.input[0].role === "developer" && start.session.input[0].content[0].text === `${G.OPEN_NOW} ${G.OPEN_NO_STOCK}` && !("greetingEvent" in G) && !/Hey Jordan|it's Cue\.|You've got Cue|Morning,/.test(startText));
  check("opening: no template from the ElevenLabs path's pool is anywhere in the session config", templates.length > 0 && templateBits.length > 0 && !templateBits.some((b) => startText.includes(b)), templateBits.filter((b) => startText.includes(b)));
  check("opening: GPT-Live is told to open in its own words, with the time of day as background", I.includes(G.OPEN_IN_OWN_WORDS) && I.includes("It's Saturday afternoon for them."));
  check("opening: the opener writer's no-stock-opener rule, word for word from it", I.includes(G.OPEN_NO_STOCK) && fs.readFileSync(new URL("../../src/services/callOpening.ts", import.meta.url), "utf8").includes(`- ${G.OPEN_NO_STOCK}`));
  const withMiddle = G.buildLiveCall({ userId: "u-jordan", callSid: null, firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: "Where things stand now: x\n\nWhat they're in the middle of:\n- the move to Oakland in March (they said Oct 28)", rightNow: "", findsNow: "", callReason: "Not used inbound.", timeOfDay: "Saturday afternoon" });
  check("opening, inbound: only their name and the time of day; what they're in the middle of stays the thinking's (in its prompt, not GPT-Live's)", !withMiddle.instructions.includes("the move to Oakland") && !withMiddle.instructions.includes("Not used inbound.") && withMiddle.backendSystem.includes("the move to Oakland") && withMiddle.opening.reason === null && Object.keys(withMiddle.opening).join() === "timeOfDay,reason");
  check("opening, outbound: the call's reason as background, never to read out", /Why you called them \(background for how you open, never to read out\): Their pitch to the second fund is Thursday\./.test(longReason.instructions) && !("middleOf" in longReason.opening));
  check("opening: time of day in their zone", G.timeOfDay(new Date("2026-10-31T16:00:00Z"), "America/Los_Angeles") === "Saturday morning" && G.timeOfDay(new Date("2026-10-31T23:30:00Z"), "America/Los_Angeles") === "Saturday afternoon" && G.timeOfDay(new Date("2026-11-01T05:00:00Z"), "America/Los_Angeles") === "Saturday night");
  const gptPath = src("services/gptLive.ts") + src("services/gptLiveBridge.ts") + (() => { const co = src("routes/co.ts"); return co.slice(co.indexOf("// ---------- GPT-Live calls"), co.indexOf("// Root-cause guard")); })();
  const gptCode = gptPath.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  check("opening: the GPT-Live path's code never reaches the opening templates or the written opener", !/\b(chooseOpening|pickOpening|OPENINGS|openingForCall|takeOpening|writeOpening|prebuildOpening|recordOpening|OPENING_LINE|callOpening)\b/.test(gptCode), /\b(chooseOpening|pickOpening|OPENINGS|openingForCall|takeOpening|writeOpening|prebuildOpening|recordOpening|OPENING_LINE|callOpening)\b/.exec(gptCode)?.[0]);
  check("opening: logged call.opening with provider gpt-live, own words, and which background it had", /decision: "call\.opening", userId: o\.userId, outcome: "act", action: o\.direction, proposal: \{ provider: "gpt-live", mode: "own_words", had: \{/.test(gptPath) && !/call\.opening_fallback/.test(gptPath));
  check("the stream URL is ours, wss", G.gptLiveStreamUrl("https://cue.example.test") === "wss://cue.example.test/co/gpt-live/stream" && G.isGptLiveStreamPath("/co/gpt-live/stream?x=1") && !G.isGptLiveStreamPath("/co/voice-stream"));
  const raw = E.promptForElevenLabs(VOICE);
  check("honesty: every act-on-the-call line being rewritten is really in the agent prompt (a moved line fails here, loudly)", G.ON_CALL_REWRITES.every(([from]) => raw.includes(from)), G.ON_CALL_REWRITES.filter(([from]) => !raw.includes(from)).map(([f]) => f));
  const hits = (t: string) => G.GPT_LIVE_FORBIDDEN.filter((re) => re.test(t)).map(String);
  check("honesty: GPT-Live's instructions never say to set it up, look it up now, say it's set up, or end_call", hits(call.instructions).length === 0, hits(call.instructions));
  check("honesty: nor does the brain's prompt", hits(call.backendSystem).length === 0, hits(call.backendSystem));
  check("honesty: the thinking is told nothing happens on the call and it's done right after; GPT-Live that nothing happens and it promises nothing", call.backendSystem.includes(G.NOTHING_ON_THIS_CALL) && /right after the call/.test(call.backendSystem) && call.instructions.includes(G.NOTHING_ON_THIS_CALL_LIVE) && [G.NOTHING_ON_THIS_CALL, G.NOTHING_ON_THIS_CALL_LIVE].every((t) => /never say it's done, set up, started or on its way/i.test(t)));
  check("the automatic acknowledgment waits long enough to be cancelled", start.session.delegation.acknowledgement_delay_ms === 800);
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
  check("nothing is appended when the session starts: GPT-Live opens on its own from the developer message", b.ai.of("session.commentary.append").length === 0 && b.ai.of("session.thinking.append").length === 0);
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
  // A crisis turn on a team call: Claude's line, with 988 and 911, reaches GPT-Live un-dropped (the call brain's number check let them
  // through: offerGuard CRISIS_NUMBERS) and as an instruction to say it exactly (never paraphrased commentary).
  const LINE = "I'm really glad you told me. If you're thinking about ending your life, you can call or text 988 right now. If you're in danger this minute, call 911. Are you safe tonight?";
  const crisis = bridge(callFor("Jordan", "Jordan is moving to Oakland."), { answer: () => LINE });
  await sleep(5);
  crisis.ai.in({ type: "session.started", session: { id: "live_crisis" } });
  crisis.ai.in({ type: "session.input_transcript.delta", delta: "Honestly I don't want to be here anymore.", start_ms: 0, end_ms: 1500 });
  crisis.ai.in({ type: "session.delegation.created", offset_ms: 1600, delegation: { id: "item_c", target: "client" } });
  await sleep(40);
  const crisisSaid = crisis.ai.sent.filter((m: any) => m.event_id === "answer_item_c");
  check("crisis turn on a team call: Claude's whole line, 988 and 911 included, reaches GPT-Live as an instruction to say it exactly", crisisSaid.length === 1 && crisisSaid[0].type === "session.instructions.append" && crisisSaid[0].delegation_id === "item_c" && crisisSaid[0].content === G.sayExactly(LINE) && /call or text 988 right now/.test(crisisSaid[0].content) && /call 911/.test(crisisSaid[0].content), crisisSaid);
  check("...nothing held back from it, and the turn is logged as exact", !crisis.records.some((r) => r.decision === "call.offer_unsourced") && crisis.records.some((r) => r.action === "gpt_live" && r.proposal.exact === true));
  check("an ordinary turn still goes as commentary", jordan.ai.sent.find((m: any) => m.event_id === "answer_item_j1")?.type === "session.commentary.append");
  crisis.tw.close();
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

// ---------------------------------------------------------------- 6. the team's monthly minutes
{
  const db = (secs: number) => ({ sqls: [] as string[], query: async function (sql: string) { this.sqls.push(sql); return { rows: [{ s: String(secs) }] }; } });
  G.openSessions.clear();
  const min = 60_000;
  check("the team's budget is one number: 300 minutes a month (about $21 at ~$0.07 a minute; Royce to confirm)", G.GPT_LIVE.teamMonthlyMinutes === 300 && !("trialMinutesCap" in G.GPT_LIVE));
  const a1 = await G.admitSession(db(270 * 60));
  check("270 of 300 minutes used: admitted with the full 30-minute session cap", a1?.capMs === 30 * min && a1.budgetLimited === false, a1);
  G.openSessions.clear();
  const a2 = await G.admitSession(db(285 * 60));
  check("285 used: admitted, capped at the 15 minutes the month has left", a2?.capMs === 15 * min && a2.budgetLimited === true, a2);
  G.openSessions.clear();
  check("299.5 used: refused (less than a minute left)", JSON.stringify(await G.admitSession(db(299.5 * 60))) === JSON.stringify({ refused: "minutes_used" }));
  G.openSessions.clear();
  const both = await Promise.all([G.admitSession(db(250 * 60)), G.admitSession(db(250 * 60)), G.admitSession(db(250 * 60))]);
  check("calls at once share what's left: 30, then the 20 left after it, then none", both[0]?.capMs === 30 * min && both[1]?.capMs === 20 * min && JSON.stringify(both[2]) === JSON.stringify({ refused: "minutes_used" }), both.map((x: any) => x?.capMs ?? x));
  G.openSessions.clear();
  check("a total that can't be read refuses (fails closed)", JSON.stringify(await G.admitSession({ query: async () => { throw new Error("db down"); } })) === JSON.stringify({ refused: "unreadable" }));
  const d0 = db(0);
  await G.admitSession(d0);
  check("minutes come from gpt_live_minutes (no user column, never pruned), this calendar month only, not harness_decisions", d0.sqls.every((q) => /FROM gpt_live_minutes WHERE started_at >= date_trunc\('month', NOW\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/.test(q)) && /CREATE TABLE IF NOT EXISTS gpt_live_minutes \(\s*session_id TEXT PRIMARY KEY,[^)]*\)/.test(src("db/migrations.ts")) && !/gpt_live_minutes[^`]*REFERENCES/.test(src("db/migrations.ts")) && !/DELETE FROM gpt_live_minutes/.test(src("jobs/index.ts")));
  G.openSessions.clear();

  // Held while the call runs: the bridge closes the session at its own cap, the same way as the 30-minute one.
  const adm = await G.admitSession(db(299 * 60 - 0.04)); // just over a minute left
  check("near the end of the month's minutes a call gets only what's left", adm?.budgetLimited === true && adm.capMs < 2 * min, adm);
  const short = { ...callFor("Jordan", "x"), capMs: 40, budgetLimited: true };
  const t = bridge(short, { id: adm!.id, heartbeatMs: 15 });
  await sleep(5);
  t.ai.in({ type: "session.started", session: { id: "live_budgetcap" } });
  check("a running session counts while it runs, under its admission", G.openSessions.get(adm!.id)?.sessionId === "live_budgetcap" && (await G.teamMinutesThisMonth(db(0))) >= 0);
  await sleep(70);
  check("heartbeat: minutes are written while the call runs", t.minutes.filter((m: any) => m.by === null).length >= 2, t.minutes);
  check("the budget cap ends the session the same way as the session cap (session.close)", t.ai.of("session.close").length === 1);
  t.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 64 } });
  const ts = t.records.find((r) => r.decision === "call.gpt_live_session");
  check("...recorded as ended by the budget cap, minutes logged, admission released", ts?.proposal.endedBy === "budget_cap" && t.minutes.at(-1)?.by === "budget_cap" && t.tw.readyState === 3 && !G.openSessions.has(adm!.id), ts);
  const b = bridge(callFor("Jordan", "x"), { maxSessionMs: 40 });
  await sleep(5);
  b.ai.in({ type: "session.started", session: { id: "live_cap" } });
  await sleep(70);
  check("each session is capped at 30 minutes: at its limit the session is closed", b.ai.of("session.close").length === 1);
  b.ai.in({ type: "session.closed", reason: "close_requested", usage: { seconds: 1800 } });
  check("...recorded as ended by the session cap", b.records.find((r) => r.decision === "call.gpt_live_session")?.proposal.endedBy === "session_cap");
  check("GPT-Live checks team, then the minutes, before anything of theirs is loaded; the trial number refuses busy (no new words)", (() => { const co = src("routes/co.ts"); const h = co.slice(co.indexOf("async function gptLiveAnswer"), co.indexOf('"/gpt-live/after-stream"')); return h.indexOf("isTeamMember(o.userId)") < h.indexOf("admitSession()") && h.indexOf("admitSession()") < h.indexOf("buildCallContextSummary") && /twiml\.reject\(\{ reason: "busy" \}\)/.test(h); })());
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
  logged = 300 * 60;
  const capped = await post("/co/gpt-live/incoming-call", { From: "+15550003333", To: "+15550002222", CallSid: "CA-c", StirVerstat: "TN-Validation-Passed-A" });
  const budgetRow = writes.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.gpt_live_budget_reached" && w.params[4] === "minutes_used");
  check("on the trial number, a team member past the month's 300 minutes is refused busy, logged call.gpt_live_budget_reached", /<Reject reason="busy"\/>/.test(capped.text) && budgetRow, capped);
  // The <Connect> action: a stream that never started plays the existing can't-connect line and releases call_status.
  const { CANT_CONNECT_LINE } = await import("../../src/services/elevenLabsCalls.js");
  G.markCall("CA-fail", "u-noor", "pending");
  const failed = await post("/co/gpt-live/after-stream", { CallSid: "CA-fail" });
  check("never connected: the ElevenLabs path's own can't-connect line, then hang up, and call_status released", failed.text.includes(CANT_CONNECT_LINE) && /<Hangup\/>/.test(failed.text) && writes.some((w) => /SET call_status = 'failed'/.test(w.sql) && w.params[0] === "u-noor"), failed);
  const unavail = (cls: string) => writes.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.gpt_live_unavailable" && w.params[4] === cls);
  check("...logged call.gpt_live_unavailable; with no class recorded, Twilio never started the stream", unavail("no_stream"));
  const KA = await import("../../src/services/modelKeyAlert.js");
  const alerts: string[] = [];
  KA.setKeyAlertForTests(KA.createKeyAlert({ send: async (t) => (alerts.push(t), true) }));
  G.markCall("CA-quota", "u-jordan", "failed", Date.now(), "quota");
  const quota = await post("/co/gpt-live/after-stream", { CallSid: "CA-quota" });
  check("OpenAI out of balance before the session: the can't-connect line (never ElevenLabs), logged with its class", quota.text.includes(CANT_CONNECT_LINE) && !/elevenlabs/i.test(quota.text) && unavail("quota") && alerts.length === 0);
  G.markCall("CA-auth", "u-jordan", "failed", Date.now(), "auth");
  await post("/co/gpt-live/after-stream", { CallSid: "CA-auth" });
  await sleep(20);
  check("a refused OpenAI key also raises the existing dead-key text to the team", unavail("auth") && alerts.length === 1 && alerts[0] === KA.KEY_DEAD_TEXT.openai);
  KA.setKeyAlertForTests(null);
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
  check("the trial number keeps its own route; /incoming-call's only GPT-Live code is the team hand-off, before ElevenLabs as it was", routes.includes("post /gpt-live/incoming-call") && (() => {
    const co = src("routes/co.ts");
    const h = co.slice(co.indexOf('"/incoming-call"'), co.indexOf("// ---------- ElevenLabs calls"));
    const a = h.indexOf("// The team's calls answer with GPT-Live"), b = h.indexOf("\n", h.indexOf("gptLiveRefusalTwiml(userId"));
    const rest = h.slice(0, a) + h.slice(b);
    return a > 0 && b > a && (h.match(/gptLiveAnswer\(/g) ?? []).length === 1 && h.indexOf("gptLiveAnswer(") < h.indexOf("registerElevenLabsCall({") && h.indexOf("inboundCallerVerified(") < h.indexOf("gptLiveAnswer(") && rest.includes("registerElevenLabsCall({") && !/gpt-?live/i.test(rest);
  })());
  const server = src("server.ts");
  check("the voice read's stream handler is unchanged beside GPT-Live's", /if \(!isVoiceStreamPath\(req\.url\)\) return;/.test(server) && /if \(!isGptLiveStreamPath\(req\.url\)\) return;/.test(server) && /handleTwilioStream\(ws as unknown as SocketLike\)/.test(server));
  check("nothing in the ElevenLabs files mentions GPT-Live", ["services/elevenLabsCalls.ts", "routes/callLlm.ts", "services/callLlmProxy.ts", "services/mediaStreamBridge.ts"].every((f) => !/gpt-?live/i.test(src(f))));
  check("no switch: GPT-Live is gated on team and minutes only (no GPT_LIVE_ENABLED-style flag)", !/process\.env\.GPT_LIVE_(?!VOICE)/.test(src("services/gptLive.ts") + src("services/gptLiveBridge.ts") + src("routes/co.ts")));
}

// ---------------------------------------------------------------- 9. the main number: the team on GPT-Live, everyone else on ElevenLabs as before
{
  const { createCoRouter } = await import("../../src/routes/co.js");
  const { default: pool } = await import("../../src/db/db.js");
  const { TEAM_BUILDER_LINE } = await import("../../src/services/extensions.js");
  const realQuery = pool.query.bind(pool);
  const EL_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.us.elevenlabs.io/v1/convai/twilio?agent_id=agent-x&amp;conversation_signature=sig"/></Connect></Response>';
  const tw = E.elevenLabs().conversationalAi.twilio as any;
  const realRegister = tw.registerCall;
  const registered: any[] = [];
  tw.registerCall = async (args: any) => { registered.push(args); return EL_TWIML; };
  process.env.ELEVENLABS_AGENT_ID = "agent-x";
  // Invented members: Jordan and Ellis on the team, Noor not.
  const people: Record<string, { id: string; name: string; team: boolean }> = { "+15550000001": { id: "u-jordan", name: "Jordan", team: true }, "+15550000002": { id: "u-noor", name: "Noor", team: false }, "+15550000003": { id: "u-ellis", name: "Ellis", team: true } };
  const byId = (id: unknown) => Object.values(people).find((p) => p.id === id);
  let loggedSecs = 0, minutesBroken = false;
  const sqls: { sql: string; params: any[] }[] = [];
  (pool as any).query = async (sql: string, params: any[] = []) => {
    sqls.push({ sql: sql.replace(/\s+/g, " "), params });
    if (/FROM users WHERE phone_number/.test(sql)) { const p = people[params[0]]; return { rows: p ? [{ id: p.id, invite_verified: true, identity_captured: true, archived_at: null }] : [] }; }
    if (/SELECT mo_approver FROM users/.test(sql)) return { rows: [{ mo_approver: byId(params[0])?.team === true }] };
    if (/SELECT first_name(, phone_number)? FROM users WHERE id/.test(sql)) { const p = byId(params[0]); return { rows: p ? [{ first_name: p.name, phone_number: Object.keys(people).find((k) => people[k].id === p.id) }] : [] }; }
    if (/FROM gpt_live_minutes/.test(sql)) { if (minutesBroken) throw new Error("db down"); return { rows: [{ s: String(loggedSecs) }] }; }
    return { rows: [] };
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/co", createCoRouter(null as any));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const call = async (from: string, sid: string) => {
    const body = { From: from, To: "+15550009999", CallSid: sid, StirVerstat: "TN-Validation-Passed-A" };
    const sig = twilio.getExpectedTwilioSignature("dummy-twilio-auth", `${process.env.API_URL}/co/incoming-call`, body);
    const r = await fetch(`http://127.0.0.1:${port}/co/incoming-call`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(body) });
    return { status: r.status, text: await r.text() };
  };
  const streamId = (t: string) => /<Parameter name="s" value="([^"]+)"\/>/.exec(t)?.[1] ?? null;
  const decided = (decision: string, action: string) => sqls.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === decision && w.params[4] === action);
  const reset = () => { registered.length = 0; sqls.length = 0; G.openSessions.clear(); };

  // Not on the team: today's ElevenLabs path, byte for byte.
  reset();
  const noor = await call("+15550000002", "CA-noor");
  const reg = registered[0];
  const vars = reg?.conversationInitiationClientData?.dynamicVariables ?? {};
  check("main number, not on the team: the TwiML is ElevenLabs' own, byte for byte", noor.status === 200 && noor.text === EL_TWIML, noor);
  check("...registered with ElevenLabs once, inbound, from their number to ours, as today", registered.length === 1 && reg.agentId === "agent-x" && reg.fromNumber === "+15550000002" && reg.toNumber === "+15550009999" && reg.direction === "inbound" && vars.user_id === "u-noor" && vars.first_name === "Noor" && vars.direction === "inbound" && /^This call: they called you\./.test(vars.context_summary) && !vars.context_summary.includes(TEAM_BUILDER_LINE), reg);
  check("...nothing of GPT-Live touched: no minutes read, nothing admitted, no stream, no fallback row", !sqls.some((w) => /gpt_live/.test(w.sql)) && G.openSessions.size === 0 && !/gpt-live/.test(noor.text) && !sqls.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && /^call\.gpt_live/.test(String(w.params[1]))));
  check("...and the same call status write as today", sqls.filter((w) => /^\s*UPDATE users SET call_sid/.test(w.sql)).length === 1 && sqls.some((w) => /UPDATE users SET call_sid = \$2, call_status = 'initiated'/.test(w.sql) && w.params[0] === "u-noor" && w.params[1] === "CA-noor"));

  // On the team, minutes left: GPT-Live.
  reset();
  const jordan = await call("+15550000001", "CA-jordan");
  const jid = streamId(jordan.text);
  check("main number, on the team: answered with GPT-Live's stream, with the <Connect> action, and ElevenLabs never registered", jordan.status === 200 && /<Connect action="https:\/\/cue\.example\.test\/co\/gpt-live\/after-stream"><Stream url="wss:\/\/cue\.example\.test\/co\/gpt-live\/stream"><Parameter name="s" value="[^"]+"\/><\/Stream><\/Connect>/.test(jordan.text) && registered.length === 0, jordan);
  check("...the TwiML carries a one-time id only: never their id, name or number", !!jid && !/u-jordan|Jordan|15550000001/.test(jordan.text));
  check("...call status set for the call, as on ElevenLabs", sqls.some((w) => /UPDATE users SET call_sid = \$2, call_status = 'initiated'/.test(w.sql) && w.params[0] === "u-jordan" && w.params[1] === "CA-jordan"));
  const jcall = G.takeLiveLink(jid);
  check("...the stream id opens their own call: GPT-Live's short prompt, inbound, the 30-minute cap", jcall?.userId === "u-jordan" && jcall.direction === "inbound" && jcall.instructions.startsWith(`${G.LIVE_WHO} You're on a phone call with Jordan.`) && jcall.instructions.length < G.GPT_LIVE.maxInstructionChars && jcall.capMs === 30 * 60_000 && jcall.budgetLimited === false && G.openSessions.has(jid!));

  // On the team, the month's minutes used: busy, never ElevenLabs (Royce, 10-31).
  reset();
  loggedSecs = 300 * 60;
  const spent = await call("+15550000001", "CA-jordan2");
  check("main number, on the team, minutes used: refused busy, ElevenLabs never registered", /<Reject reason="busy"\/>/.test(spent.text) && registered.length === 0 && !/<Stream/.test(spent.text), spent);
  check("...logged call.gpt_live_budget_reached, nothing of theirs loaded, no call status written", sqls.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.gpt_live_budget_reached" && w.params[4] === "minutes_used") && !sqls.some((w) => /UPDATE users SET call_sid/.test(w.sql)));
  reset();
  loggedSecs = 0;
  minutesBroken = true;
  const unreadable = await call("+15550000001", "CA-jordan3");
  check("main number, on the team, minutes unreadable: refused GPT-Live (fails closed): busy, never ElevenLabs, logged apart as unreadable", /<Reject reason="busy"\/>/.test(unreadable.text) && registered.length === 0 && G.openSessions.size === 0 && sqls.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.gpt_live_budget_reached" && w.params[4] === "unreadable"));
  minutesBroken = false;
  // OpenAI unavailable before anything starts (no key): the can't-connect line, never ElevenLabs.
  reset();
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const noKey = await call("+15550000001", "CA-jordan4");
  process.env.OPENAI_API_KEY = key;
  const { CANT_CONNECT_LINE } = await import("../../src/services/elevenLabsCalls.js");
  check("main number, on the team, no OpenAI key: the existing can't-connect line and hang up, never ElevenLabs", noKey.text.includes(CANT_CONNECT_LINE) && /<Hangup\/>/.test(noKey.text) && registered.length === 0 && !/<Stream|<Reject/.test(noKey.text), noKey);
  check("...logged call.gpt_live_unavailable no_key, the failure noted as on the ElevenLabs path, nothing admitted", sqls.some((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.gpt_live_unavailable" && w.params[4] === "no_key") && sqls.some((w) => /INSERT INTO co_memories/.test(w.sql) && w.params[0] === "u-jordan") && G.openSessions.size === 0);
  // A team call that does get GPT-Live logs its opening as GPT-Live's own words, with which background it had.
  reset();
  await call("+15550000001", "CA-jordan5");
  const opened = sqls.find((w) => /INSERT INTO harness_decisions/.test(w.sql) && w.params[1] === "call.opening");
  const op = opened ? JSON.parse(opened.params[5]) : null;
  check("opening logged: call.opening, provider gpt-live, own words, which background it had; no template, no fallback row", op?.provider === "gpt-live" && op.mode === "own_words" && op.had?.firstName === true && typeof op.had.timeOfDay === "boolean" && !("template" in op) && !("line" in op) && !sqls.some((w) => w.params?.[1] === "call.opening_fallback"), op);

  // Two calls at once: each gets its own path and only its own member.
  reset();
  const [j2, n2, e2] = await Promise.all([call("+15550000001", "CA-j"), call("+15550000002", "CA-n"), call("+15550000003", "CA-e")]);
  const jc = G.takeLiveLink(streamId(j2.text)), ec = G.takeLiveLink(streamId(e2.text));
  check("at once: Jordan and Ellis (team) on GPT-Live, Noor on ElevenLabs", !!jc && !!ec && n2.text === EL_TWIML && registered.length === 1 && registered[0].conversationInitiationClientData.dynamicVariables.user_id === "u-noor");
  check("at once: each GPT-Live call is its own member's, with nobody else's name in either prompt", jc?.userId === "u-jordan" && ec?.userId === "u-ellis" && !/Ellis|Noor/.test(jc!.instructions + jc!.backendSystem) && !/Jordan|Noor/.test(ec!.instructions + ec!.backendSystem));
  check("at once: Noor's ElevenLabs registration carries nothing of Jordan's or Ellis's", !/Jordan|Ellis|u-jordan|u-ellis/.test(JSON.stringify(registered[0])));
  check("at once: two admissions, each with its own reservation", G.openSessions.size === 2);

  server.close();
  tw.registerCall = realRegister;
  (pool as any).query = realQuery;
  G.openSessions.clear();
}

// ---------------------------------------------------------------- 10. OpenAI failing before the session, and the grade's reasons
{
  check("failure classes: balance, key, rate, connect, timeout, else refused", G.failClassOf({ code: "insufficient_quota", message: "You exceeded your current quota" }) === "quota" && G.failClassOf("Unexpected server response: 401") === "auth" && G.failClassOf({ code: "invalid_api_key" }) === "auth" && G.failClassOf("Unexpected server response: 429") === "rate_limit" && G.failClassOf("getaddrinfo ENOTFOUND api.openai.com") === "connect" && G.failClassOf("Opening handshake has timed out") === "timeout" && G.failClassOf({ code: "server_error" }) === "refused");
  // The bridge keeps the class for the <Connect> action when OpenAI refuses before session.started.
  const q = bridge(callFor("Jordan", "x"));
  await sleep(5);
  q.ai.in({ type: "error", error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } });
  q.ai.close();
  await sleep(5);
  const st = G.takeCallState("CA-Jordan");
  check("OpenAI out of balance before the session: the call is marked failed with class quota, no minutes, no post-call", st?.state === "failed" && st.failClass === "quota" && q.minutes.length === 0 && q.results.length === 0, st);
  const early = bridge(callFor("Jordan", "x"), { startTimeoutMs: 30 });
  await sleep(5);
  early.ai.in({ type: "error", error: { code: "unknown_parameter", message: "Unknown parameter: session.foo" } });
  await sleep(50);
  check("a harmless early error doesn't mask what really happened: a session that then never starts is a timeout", G.takeCallState("CA-Jordan")?.failClass === "timeout");
  const k = bridge(callFor("Jordan", "x"), { key: undefined });
  await sleep(5);
  check("no key in the bridge: marked failed with class no_key", G.takeCallState("CA-Jordan")?.failClass === "no_key" && k.key() === "");
  const t = bridge(callFor("Jordan", "x"), { startTimeoutMs: 20 });
  await sleep(40);
  check("OpenAI never starts the session: class timeout", G.takeCallState("CA-Jordan")?.failClass === "timeout" && t.ai.readyState === 3);

  // The grade's reasons: a short reason and the one Cue line, kept only when it is Cue's.
  const V = await import("../../src/services/callEvals.js");
  const transcript = "assistant: Hey Jordan.\nuser: My sister Maya is visiting.\nassistant: The Mission one starts at seven on Friday, you'll love it.\nuser: ok";
  const seen: any[] = [];
  const analysis = await G.gradeLiveCall(transcript, async () => JSON.stringify({ results: [
    { id: "no_invented_specifics", result: "failure", rationale: "Cue named a time nobody gave: 'The Mission one starts at seven on Friday'.", quote: "The Mission one starts at seven on Friday" },
    { id: "short_spoken_replies", result: "failure", rationale: "One reply was long.", quote: "My sister Maya is visiting." },
    { id: "names_and_voice", result: "success", rationale: "fine", quote: "Hey Jordan." },
  ] }));
  check("GPT-Live's grader returns a quote on a failure only", analysis.evaluation_criteria_results.no_invented_specifics.quote === "The Mission one starts at seven on Friday" && !("quote" in analysis.evaluation_criteria_results.names_and_voice) && /"quote"/.test(G.gradePrompt("x")));
  await V.recordCallEvaluation("u-jordan", "gpt-live:x", analysis, (async (d: any) => { seen.push(d); }) as any, { transcript, records: async () => "", judge: async () => [] });
  const det = seen[0]?.proposal?.detail ?? [];
  check("call.evaluation stores each failed criterion's short reason and the quoted Cue line", det.length === 2 && det[0].id === "no_invented_specifics" && det[0].quote === "The Mission one starts at seven on Friday" && /named a time nobody gave/.test(det[0].reason) && det[0].reason.length <= V.DETAIL_REASON_MAX, det);
  check("...a quote that isn't Cue's words (here the member's) is never stored", det[1].id === "short_spoken_replies" && det[1].quote === null && !JSON.stringify(seen[0].proposal).includes("Maya"), det[1]);
  // ElevenLabs' grader has no quote field: the first quoted span in its rationale, if it is Cue's.
  const elDet = V.failureDetail({ id: "names_and_voice", rationale: 'Cue said "as an AI I don\'t really feel things" when asked how it felt.' }, "user: how do you feel?\nagent: Honestly, as an AI I don't really feel things.");
  check("the ElevenLabs path gets the same shape: the quote from its rationale, when it's in a Cue line", elDet.quote === "as an AI I don't really feel things" && elDet.reason.startsWith("Cue said"));
  check("...and none when the rationale quotes nothing of Cue's", V.failureDetail({ id: "x", rationale: "Replies ran long." }, transcript).quote === null);
  const long = V.failureDetail({ id: "x", rationale: "r".repeat(500) }, transcript);
  check("reasons are cut short", long.reason.length === V.DETAIL_REASON_MAX);

  // The morning review shows the team's GPT-Live failures and a reached budget (harness/devReview.ts).
  const DR = await import("../../src/harness/devReview.js");
  const at = new Date();
  const flags = DR.logFlags({ userId: "u-jordan", firstName: "Jordan", messages: [], emotions: [], issues: [], decisions: [
    { id: 1, at: at.toISOString(), decision: "call.gpt_live_unavailable", outcome: "skip", action: "quota", reason: null, proposal: { failClass: "quota", stage: "session" }, checks: [] },
    { id: 2, at: at.toISOString(), decision: "call.gpt_live_budget_reached", outcome: "skip", action: "minutes_used", reason: null, proposal: { direction: "inbound" }, checks: [] },
  ] } as any);
  check("the morning review flags a GPT-Live call that couldn't start (with its class) and a reached budget, both high", flags.some((f: any) => f.type === "gpt_live_unavailable" && f.severity === "high" && /quota/.test(f.snippet)) && flags.some((f: any) => f.type === "gpt_live_budget_reached" && f.severity === "high"), flags);
}

console.log(`gpt-live: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
