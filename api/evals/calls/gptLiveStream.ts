// GPT-Live delegated answers go out as they're written (2026-11-02, "Cue's voice feels too slow"): on the 10-31 GPT-Live calls the
// bridge waited for Claude's whole answer before handing any of it to GPT-Live (p50 3.9 s, p90 5.6 s from the handover, n=8), while the
// first sentence was ready at ~1.5 s. OpenAI's delegation guide: "Stream useful results ... Send each result as soon as you have enough
// text to understand it on its own"; several commentary appends may share one delegation id.
// Covered here: the first sentence reaches GPT-Live before the rest is written; sentences written together go in one append; a caller
// cutting in stops the rest (not sent, not written) while a "yeah" doesn't; a crisis line mid-answer and everything after it goes word
// for word; a call that has touched their safety is never streamed; text written together with end_call isn't said; the handover's
// transcript lag is measured. The thinking's copy on answer length (BACKEND_NOTE) is checked in gptLive.ts.
// Layer 1: OpenAI, Twilio and Claude are fakes; no network, no tokens. Invented member (Jordan).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveStream.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const G = await import("../../src/services/gptLive.js");
const B = await import("../../src/services/gptLiveBridge.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const callFor = () => G.buildLiveCall({ userId: "u-jordan", callSid: "CA-str", firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: "Jordan is moving to Oakland in March and looking for a climbing partner.", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(d: unknown) { this.sent.push(JSON.parse(String(d))); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  in(m: unknown) { this.emit("message", JSON.stringify(m)); }
}
// Claude's answer as timed pieces: each piece is one text delta, written gapMs after the one before (a real stream, not one burst).
// "|END" as a piece is an end_call tool use, "|THROW" the stream failing there. written: how many pieces the fake model actually produced
// (a stopped answer stops early). cuts: the members the safety-cut path ran for.
const endEvents = [{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_end", name: "end_call" } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 1 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }];
function bridge(pieces: string[], gapMs: number) {
  const tw = new FakeSocket(), ai = new FakeSocket();
  const records: any[] = [], cuts: string[] = [];
  const state = { written: 0, done: false };
  B.setLiveDeps({
    connectOpenAI: () => { setImmediate(() => ai.emit("open")); return ai as any; },
    apiKey: () => "sk-test",
    upstream: () => (async function* () {
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
      for (const [i, p] of pieces.entries()) {
        if (i && gapMs) await sleep(gapMs);
        if (p === "|THROW") throw new Error("upstream overloaded");
        if (p === "|END") { yield { type: "content_block_stop", index: 0 } as any; for (const e of endEvents) yield e as any; state.written++; continue; }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } } as any;
        state.written++;
      }
      if (pieces.at(-1) !== "|END") yield { type: "content_block_stop", index: 0 } as any;
      state.done = true;
    })(),
    record: (d) => records.push(d),
    postCall: async () => {},
    minutes: () => {},
    log: () => {},
    now: Date.now,
    maxSessionMs: 60_000,
    startTimeoutMs: 60_000,
    heartbeatMs: 60_000,
    silenceEndMs: 60_000,
    endGraceMs: 60_000,
    endWaitMs: 60_000,
    guardRows: async () => [],
    safetyCut: async (c) => { cuts.push(c.userId); },
  });
  B.handleGptLiveStream(tw as any);
  B.setLiveDeps(null);
  tw.in({ event: "start", streamSid: "MZ1", start: { customParameters: { s: G.issueLiveLink(callFor()) } } });
  const forD = (id: string) => ai.sent.filter((m: any) => m.delegation_id === id && m.event_id !== `quiet_${id}`);
  const lat = () => records.find((r) => r.decision === "call.turn_latency" && r.action === "gpt_live")?.proposal;
  return { tw, ai, records, cuts, state, forD, lat };
}
const start = async (b: ReturnType<typeof bridge>) => { await sleep(5); b.ai.in({ type: "session.started", session: { id: "live_str" } }); };
const say = (b: ReturnType<typeof bridge>, who: "member" | "cue", text: string, s: number) => b.ai.in({ type: who === "member" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: text, start_ms: s, end_ms: s + 800 });
const until = async (ok: () => boolean, ms = 1500) => { for (let t = 0; t < ms && !ok(); t += 10) await sleep(10); };

// ---------------------------------------------------------------- 1. the first sentence goes before the rest is written
{
  const b = bridge(["Bouldering gyms fill up after work. ", "Mornings are quieter. ", "Do you climb before work or after?"], 120);
  await start(b);
  say(b, "member", "Any climbing gyms near the new place?", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d1", target: "client" } });
  await until(() => b.forD("d1").length >= 1);
  const first = b.forD("d1");
  check("the answer's first sentence reaches GPT-Live as commentary while the rest is still being written", first.length === 1 && first[0].type === "session.commentary.append" && first[0].event_id === "answer_d1" && first[0].content === "Bouldering gyms fill up after work." && b.state.written < 3, { first, written: b.state.written });
  await until(() => !!b.lat());
  const all = b.forD("d1");
  check("...then each later sentence in its own append under the same delegation id, in order", all.map((m: any) => m.event_id).join() === "answer_d1,answer_d1_2,answer_d1_3" && all.every((m: any) => m.type === "session.commentary.append") && all.map((m: any) => m.content).join(" ") === "Bouldering gyms fill up after work. Mornings are quieter. Do you climb before work or after?", all);
  const p = b.lat();
  check("...logged: streamed, three appends, and the first send well before the whole answer was done", p?.streamed === true && p.appends === 3 && typeof p.firstSendMs === "number" && p.firstSendMs < p.totalMs - 150 && p.stale === false, p);
  check("...and no 'no answer' note alongside a streamed answer", !b.ai.sent.some((m: any) => m.type === "session.thinking.append" && m.delegation_id === "d1" && m.content));
  b.tw.close();
}

// ---------------------------------------------------------------- 2. sentences written together go together (one append, not a stutter)
{
  const b = bridge(["Mornings are quieter. Do you climb before work?"], 0);
  await start(b);
  say(b, "member", "When's the gym least busy?", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d2", target: "client" } });
  await until(() => !!b.lat());
  const all = b.forD("d2");
  check("two sentences that arrive in one burst go in one commentary append", all.length === 1 && all[0].event_id === "answer_d2" && all[0].content === "Mornings are quieter. Do you climb before work?", all);
  b.tw.close();
}

// ---------------------------------------------------------------- 3. the caller cuts in: the rest is neither sent nor written
{
  const b = bridge(["Early is a good call. ", "The walls are empty before work. ", "You'd have most of it to yourself. ", "Which side of town is the new place?"], 120);
  await start(b);
  say(b, "member", "Is the gym open early?", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d3", target: "client" } });
  await until(() => b.forD("d3").length >= 1);
  say(b, "cue", "Early is a good call.", 1200);
  say(b, "member", "Actually wait, what about Sunday?", 1900);
  await until(() => !!b.lat());
  const all = b.forD("d3");
  check("barge-in mid-answer: what was already said stays, nothing after their new words is sent", all.length === 1 && all[0].content === "Early is a good call.", all);
  check("...the rest of the answer isn't written (the stream stops; no tokens for an answer nobody asked for)", b.state.written < 4 && !b.state.done, b.state);
  check("...logged stale, so the morning numbers count cut answers", b.lat()?.stale === true && b.lat()?.streamed === true);
  b.tw.close();
}

// ---------------------------------------------------------------- 4. a "yeah" while Cue answers is listening, not cutting in
{
  const b = bridge(["Early is a good call. ", "The walls are empty before work."], 120);
  await start(b);
  say(b, "member", "Is the gym open early?", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d4", target: "client" } });
  await until(() => b.forD("d4").length >= 1);
  say(b, "member", "yeah", 1800);
  await until(() => !!b.lat());
  check("a backchannel ('yeah') mid-answer doesn't cut it: both sentences go", b.forD("d4").length === 2 && b.lat()?.stale === false, b.forD("d4"));
  b.tw.close();
}

// ---------------------------------------------------------------- 5. a crisis line mid-answer, and everything after it, goes word for word
{
  const b = bridge(["That sounds like a brutal week. ", "If it ever gets to where you're thinking of ending your life, you can call or text 988 any time. ", "Are you safe tonight?"], 60);
  await start(b);
  say(b, "member", "This week has been a lot, the move and work.", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d5", target: "client" } });
  await until(() => !!b.lat());
  const all = b.forD("d5");
  const exact = all.find((m: any) => m.type === "session.instructions.append");
  check("the ordinary first sentence streams as commentary", all[0]?.type === "session.commentary.append" && all[0].content === "That sounds like a brutal week.", all);
  check("...the crisis line and the rest go once, as an instruction to say them exactly and in full (988 kept)", all.length === 2 && exact?.content === G.sayExactly("If it ever gets to where you're thinking of ending your life, you can call or text 988 any time. Are you safe tonight?") && exact.event_id === "answer_d5_2", all);
  check("...and the turn is logged exact (a safety moment for the safety-cut path)", b.lat()?.exact === true);
  b.tw.close();
}

// ---------------------------------------------------------------- 6. a call that has touched their safety isn't streamed
{
  const LINE = ["I'm really glad you told me. ", "You can call or text 988 right now. ", "Are you safe tonight?"];
  const b = bridge(LINE, 60);
  await start(b);
  say(b, "member", "Honestly I'd rather not be here anymore.", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d6", target: "client" } });
  await until(() => !!b.lat());
  const all = b.forD("d6");
  check("their words raise safety: the whole answer is read first and goes once, word for word, as before", all.length === 1 && all[0].type === "session.instructions.append" && all[0].content === G.sayExactly(LINE.join("").trim()) && b.lat()?.streamed === false, all);
  b.tw.close();
}

// ---------------------------------------------------------------- 7. text written together with end_call isn't said
{
  const b = bridge(["Talk soon, Jordan.", "|END"], 0);
  await start(b);
  say(b, "member", "Okay I have to run, bye!", 0);
  say(b, "cue", "Bye Jordan, good luck with the move.", 900);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d7", target: "client" } });
  await until(() => !!b.lat());
  check("Claude's goodbye text written with end_call in one burst isn't handed to GPT-Live (its own goodbye is the last word)", b.forD("d7").length === 0 && b.lat()?.endAfterText === false, b.forD("d7"));
  b.tw.close();
}

// ---------------------------------------------------------------- 8. the handover's transcript lag is measured
{
  const b = bridge(["Mornings are quieter."], 0);
  await start(b);
  say(b, "member", "When's the gym least busy?", 0); // ends at 800
  b.ai.in({ type: "session.delegation.created", offset_ms: 1700, delegation: { id: "d8", target: "client" } });
  await until(() => !!b.lat());
  const p = b.lat();
  check("each delegated turn logs how far the transcript trailed the handover, and whether the wait brought in their words", p?.lagMs === 900 && p.waitAddedWords === false && p.waitMs >= G.GPT_LIVE.catchUpMs - 20, p);
  b.tw.close();
}

// ---------------------------------------------------------------- 7b. a closing turn isn't streamed: end_call comes hundreds of ms after the text
{
  const b = bridge(["Talk soon, Jordan. ", "|END"], 150);
  await start(b);
  say(b, "member", "Okay I have to run, bye!", 0);
  say(b, "cue", "Bye Jordan, good luck with the move.", 900);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d7b", target: "client" } });
  await until(() => !!b.lat());
  check("review of #345: a goodbye written 150 ms before end_call is never handed to GPT-Live (a closing turn waits for the whole answer)", b.forD("d7b").length === 0 && b.lat()?.streamed === false && b.lat()?.endAfterText === false, { sent: b.forD("d7b"), lat: b.lat() });
  b.tw.close();
  const r = bridge(["Before you go, ", "the move sounds like it's in good shape. ", "Good luck Saturday."], 150);
  await start(r);
  say(r, "member", "Okay I have to run, bye!", 0);
  r.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d7c", target: "client" } });
  await until(() => !!r.lat());
  const sent = r.forD("d7c");
  check("...and when the thinking doesn't end it, its whole answer still goes, once, as before", sent.length === 1 && sent[0].type === "session.commentary.append" && sent[0].event_id === "answer_d7c" && /good shape/.test(sent[0].content) && r.lat()?.streamed === false, sent);
  r.tw.close();
  const P = await import("../../src/services/callLlmProxy.js");
  const req = (msgs: [string, string][]) => ({ messages: [{ role: "system", content: "x" }, ...msgs.map(([role, content]) => ({ role, content }))] }) as any;
  check("callClosing: their goodbye, or their reply to Cue's own goodbye; not an ordinary turn", P.callClosing(req([["user", "Okay I have to run, bye!"]])) && P.callClosing(req([["assistant", "Alright, take care Jordan."], ["user", "You too"]])) && !P.callClosing(req([["assistant", "Which gym?"], ["user", "The one by the lake"]])) && !P.callClosing(req([["user", "I'll go with the first one, it's closer."]])));
  check("...and runCallLlm reads the turn's closed fact through it (one read, never two that drift)", /closed: callClosing\(b\),/.test(fs.readFileSync(new URL("../../src/services/callLlmProxy.ts", import.meta.url), "utf8")));
}

// ---------------------------------------------------------------- 5b. anything unsent when the crisis line arrives goes word for word with it
{
  const b = bridge(["That sounds like a brutal week. ", "Some weeks just pile up. If it ever gets to where you're thinking of ending your life, you can call or text 988 any time. ", "Are you safe tonight?"], 60);
  await start(b);
  say(b, "member", "This week has been a lot, the move and work.", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d5b", target: "client" } });
  await until(() => !!b.lat());
  const all = b.forD("d5b");
  check("a sentence written together with the crisis line isn't paraphrased: it goes word for word with the line and the rest", all.length === 2 && all[0].type === "session.commentary.append" && all[0].content === "That sounds like a brutal week." && all[1].type === "session.instructions.append" && all[1].content === G.sayExactly("Some weeks just pile up. If it ever gets to where you're thinking of ending your life, you can call or text 988 any time. Are you safe tonight?"), all);
  b.tw.close();
}

// ---------------------------------------------------------------- 10. the stream fails after the crisis line: said word for word, safety path on a content close
{
  const b = bridge(["That sounds like a brutal week. ", "If it ever gets to where you're thinking of ending your life, you can call or text 988 any time. ", "|THROW"], 60);
  await start(b);
  say(b, "member", "This week has been a lot, the move and work.", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d10", target: "client" } });
  await until(() => !!b.lat());
  const exact = b.forD("d10").find((m: any) => m.type === "session.instructions.append");
  check("review of #345: Claude's stream fails after the crisis line; the line still goes, word for word, 988 kept", exact?.content === G.sayExactly("If it ever gets to where you're thinking of ending your life, you can call or text 988 any time.") && b.lat()?.error === true, b.forD("d10"));
  b.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 30 } });
  await sleep(10);
  check("...and a safety-filter close afterwards takes the safety-cut path (once)", b.cuts.length === 1 && b.records.filter((r) => r.decision === "call.gpt_live_safety_cut").length === 1, b.cuts);
}

// ---------------------------------------------------------------- 11. a content close while the answer is still being written
{
  const b = bridge(["That sounds like a brutal week. ", "If it ever gets to where you're thinking of ending your life, you can call or text 988 any time. ", "Are you safe tonight?"], 150);
  await start(b);
  say(b, "member", "This week has been a lot, the move and work.", 0);
  b.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d11", target: "client" } });
  await until(() => b.state.written >= 2, 2000);
  await sleep(10);
  b.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 30 } });
  await until(() => !!b.lat(), 2000);
  check("review of #345: the filter closes the session after the crisis line was written but before it was sent: the safety-cut path runs", b.cuts.length === 1 && b.records.some((r) => r.decision === "call.gpt_live_safety_cut"), { cuts: b.cuts });
  check("...and nothing is sent to the closed session", !b.forD("d11").some((m: any) => m.type === "session.instructions.append"), b.forD("d11"));
  const late = bridge(["That sounds like a brutal week. ", "If it ever gets to where you're thinking of ending your life, you can call or text 988 any time."], 200);
  await start(late);
  say(late, "member", "This week has been a lot, the move and work.", 0);
  late.ai.in({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "d11b", target: "client" } });
  await until(() => late.state.written >= 1, 2000);
  await sleep(20);
  late.ai.in({ type: "session.closed", reason: "content", usage: { seconds: 30 } });
  await until(() => late.state.done, 2000);
  await sleep(10);
  check("...a crisis line written after the filter's close still takes the safety-cut path, once", late.cuts.length === 1, late.cuts);
}

// ---------------------------------------------------------------- 12. one append's cap never drops a crisis line; usage on an early stop
{
  const long = "That sounds like a lot. ".repeat(80) + "If you're thinking of ending your life, you can call or text 988 any time. Are you safe tonight?";
  const capped = G.voiceCap(long);
  check("voiceCap: an answer longer than one append keeps its crisis line (starting at that sentence), within the cap", capped.length <= G.GPT_LIVE.commentaryMaxChars && capped.startsWith("If you're thinking of ending your life") && capped.includes("988"), capped.slice(0, 120));
  check("...and the thinking's answer goes through it", /const said = voiceCap\(stripCues\(text\)/.test(fs.readFileSync(new URL("../../src/services/gptLive.ts", import.meta.url), "utf8")));
  check("voiceCap: an ordinary long answer is cut at the cap as before; a short one is untouched", G.voiceCap("a".repeat(2000)).length === G.GPT_LIVE.commentaryMaxChars && G.voiceCap("Short one.") === "Short one.");
  const P = await import("../../src/services/callLlmProxy.js");
  const u = P.usageAtStop({ input_tokens: 10, cache_read_input_tokens: 9000, output_tokens: 1 }, 402);
  check("review of #345: a stream stopped early records the output it received (about 4 chars a token), never below what was reported", u.output_tokens === 101 && u.input_tokens === 10 && u.cache_read_input_tokens === 9000 && P.usageAtStop({ output_tokens: 300 }, 40).output_tokens === 300);
  check("...and anthropicStream records it that way only when stopped early", /recordAnthropicUsage\("call\.turn", model, ended \? usage : usageAtStop\(usage, outChars\), userId\)/.test(fs.readFileSync(new URL("../../src/services/callLlmProxy.ts", import.meta.url), "utf8")));
}

// ---------------------------------------------------------------- 9. the real upstream closes its connection when the answer is stopped
{
  const P = await import("../../src/services/callLlmProxy.js");
  let cancelled = false;
  const sse = (ev: unknown) => new TextEncoder().encode(`event: x\ndata: ${JSON.stringify(ev)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(sse({ type: "content_block_start", index: 0, content_block: { type: "text" } })); c.enqueue(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Early is a good call. " } })); },
    cancel() { cancelled = true; },
  });
  const fakeFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  let seen = 0;
  for await (const _ of P.anthropicStream({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] } as any, "sk-test", fakeFetch, null)) { seen++; if (seen === 2) break; }
  await sleep(5);
  check("anthropicStream: stopping early cancels the response body (the model stops writing an answer nobody will hear)", cancelled && seen === 2, { cancelled, seen });
}

console.log(`gpt-live streaming: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
