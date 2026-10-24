// The call brain's endpoint (services/callLlmProxy.ts, routes/callLlm.ts), the finds guard (services/offerGuard.ts) and the five
// call-quality behaviours around it. Layer 1: a fake model stream, a fake clock, a fake store; zero tokens, no network.
//   npx tsx evals/calls/llmProxy.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/services/callLlmProxy.js");
const G = await import("../../src/services/offerGuard.js");
const R = await import("../../src/routes/callLlm.js");
const S = await import("../../src/services/speakable.js");
// The read of their answer (services/theirYes.ts) is a model call: stubbed to yes, so these checks are about the guard's facts.
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/call-2026-10-06.json", import.meta.url), "utf8"));
const g = fixture.given;

const text = (s: string, index = 0) => [
  { type: "content_block_start", index, content_block: { type: "text" } },
  ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index },
];
const tool = (id: string, name: string, args: string, index = 1) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args.slice(0, 4) } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args.slice(4) } },
  { type: "content_block_stop", index },
];
const upstream = (events: any[]) => (_req: any) => (async function* () { for (const e of events) yield e; })();
const baseBody = (extra: any = {}) => ({
  model: "claude-haiku-4-5",
  stream: true,
  temperature: 0.8,
  messages: [
    { role: "system", content: `You are Cue, on a call with Royce (the call prompt carries their first name).\n# Right now\n${g.rightNow}\n# What Cue has found for them\n${g.findsNow}\n${g.contextSummary}` },
    { role: "assistant", content: "Hey Royce, it's Cue." },
    { role: "user", content: "Yeah, so what do you think?" },
  ],
  tools: [{ type: "function", function: { name: "assess_conversation_coverage", description: "check", parameters: { type: "object", properties: {} } } }],
  ...extra,
});
const run = async (body: any, events: any[], o: { clean?: boolean } = {}) => {
  const spoken: string[] = [], dropped: string[] = [];
  const out: any[] = [];
  for await (const c of P.runCallLlm(body, { stream: upstream(events), onSpoken: (s) => spoken.push(s), onDropped: (s, w) => dropped.push(`${s} | ${w}`), ...o })) out.push(c);
  const content = out.map((c) => c.choices[0].delta.content ?? "").join("");
  return { out, content, spoken, dropped, finish: out[out.length - 1].choices[0].finish_reason };
};

// ---- translation: OpenAI in, Anthropic out
{
  const body = baseBody({
    messages: [
      { role: "system", content: "SYS" },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "assess_conversation_coverage", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: '{"ok":1}' },
      { role: "user", content: [{ type: "text", text: "Next" }] },
    ],
  });
  const a = P.toAnthropic(body);
  check("the system prompt is cached and carried whole", a.system[0].text === "SYS" && a.system[0].cache_control.type === "ephemeral");
  check("the call's own greeting is not the first message: the model's turn follows the member's", a.messages[0].role === "user");
  check("roles alternate", a.messages.every((m, i) => i === 0 || m.role !== a.messages[i - 1].role), a.messages.map((m) => m.role));
  check("a tool call and its result become tool_use and tool_result blocks, the result with the member's next words", a.messages.some((m) => m.content.some((b: any) => b.type === "tool_use" && b.id === "t1")) && a.messages.some((m) => m.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "t1")));
  check("tools are passed with their schemas", a.tools?.[0].name === "assess_conversation_coverage" && !!a.tools?.[0].input_schema);
  check("the model is Sonnet 4.6, Hume's brain (2026-10-08), and streams", a.model === "claude-sonnet-4-6" && a.stream === true);
  check("the last message is the member's (no accidental prefill)", a.messages[a.messages.length - 1].role === "user");
  check("Sonnet 4.6 gets the call's temperature; Haiku 5.5 never does (it 400s on one)", P.toAnthropic({ ...body, temperature: 1 }).temperature === 1 && !("temperature" in P.toAnthropic({ ...body, temperature: 0.8 }, "claude-haiku-5-5")));
  check("a 4.x model still gets the call's temperature", P.toAnthropic({ ...body, temperature: 0.8 }, "claude-haiku-4-5").temperature === 0.8);
  // 2026-10-07 replay: Haiku 5.5's default thinking was ~1.5s of silence per turn (first token 2.0s -> 0.4s with it off).
  check("Sonnet 4.6 is sent no thinking option (it thinks only when asked); Haiku 5.5 would run with it off", !("thinking" in a) && P.toAnthropic(body, "claude-haiku-5-5").thinking?.type === "disabled");
  check("a 4.x model is sent no thinking field (it never thinks unasked)", !("thinking" in P.toAnthropic(body, "claude-haiku-4-5")));
  check("Sonnet 5.5 is not sent thinking: disabled (it 400s on it)", !("thinking" in P.toAnthropic(body, "claude-sonnet-5-5")));
  const last = a.messages[a.messages.length - 1].content;
  check("the conversation so far is cached at its last block, and only there", (last[last.length - 1] as any).cache_control?.type === "ephemeral" && a.messages.flatMap((m) => m.content).filter((b: any) => b.cache_control).length === 1);
  const empty = P.toAnthropic(baseBody({ messages: [{ role: "system", content: "SYS" }] }));
  check("a call with no turns yet still caches its one quiet line", (empty.messages[0].content[0] as any).cache_control?.type === "ephemeral");
}

// ---- the cleaned stream
{
  const r = await run(baseBody(), text("That's smart—keeping it warm first. So Jacqueline's already connected with him, and you're thinking dinners or lunch to see what makes sense to do together. What would you want out of it?"));
  const st = S.speechStats(r.content);
  check("what reaches the voice has no dashes and no sentence past 15 words", st.dashes === 0 && st.over === 0, r.content);
  check("the first chunk is the role, the last carries stop", r.out[0].choices[0].delta.role === "assistant" && r.finish === "stop");
  check("each content chunk is a whole sentence", r.out.filter((c) => c.choices[0].delta.content).every((c) => /[.!?]\s$/.test(c.choices[0].delta.content)), r.out.map((c) => c.choices[0].delta.content));
}
{
  // The first sentence ships when it is complete: with a fake clock that ticks per upstream event.
  let t = 1000; const times: number[] = [];
  const events = text("That makes sense. Keep it warm first, and see what fits. What would you want out of it?");
  let first = 0, firstChunkAt = 0, upstreamFirst = 0, idx = 0;
  const stream = (_r: any) => (async function* () { for (const e of events) { t += 10; idx++; yield e; } })();
  for await (const c of P.runCallLlm(baseBody(), { stream, now: () => t, onFirstText: (m) => { first = m.firstSentenceMs; upstreamFirst = m.upstreamFirstTokenMs; } })) { if (c.choices[0].delta.content && !firstChunkAt) firstChunkAt = idx; }
  check("the first sentence goes out after the token that completes it, not at the end of the reply", firstChunkAt > 0 && firstChunkAt < events.length - 3, { firstChunkAt, of: events.length });
  check("its delay over the model's own first token is a few tokens, not the reply", first - upstreamFirst <= 60, { first, upstreamFirst });
}
{
  const r = await run(baseBody(), [...text("Let me check that for you."), ...tool("t9", "assess_conversation_coverage", '{"a":1}')]);
  const calls = r.out.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
  check("a tool call passes through whole, after the text before it", calls[0]?.function.name === "assess_conversation_coverage" && calls.map((c: any) => c.function?.arguments ?? "").join("") === '{"a":1}' && r.finish === "tool_calls" && /^Let me check that for you\./.test(r.content));
}
{
  const r = await run(baseBody(), text("That makes sense—go on."), { clean: false });
  check("CALL_LLM_CLEAN=off (clean:false) passes the model's words through untouched", r.content.replace(/\s+/g, "") === "Thatmakessense—goon.");
}

// ---- their state outranks the agenda
{
  const M = await import("../../src/services/memberState.js");
  const yes = ["No, that's pretty much it. You know, today was a long day. Um, just kind of tired and drained. Um, ultimately, we'll be open to this weekend", "I'm exhausted", "I'm so overwhelmed right now", "honestly I'm burnt out", "it's been a rough week", "I just need a break", "I'm really wiped"];
  const no = ["I'm tired of waiting on the VC", "We're excited about the November launch", "Can you send the PDF?", "That was a long email thread", "I'm stressed about nothing, ha, just kidding"];
  check("the signal: tired, drained, exhausted, overwhelmed, burnt out, a long or rough day, mental health", yes.every((t) => M.memberStateSignal(t)), yes.filter((t) => !M.memberStateSignal(t)));
  check("and not: 'tired of waiting', plain work talk", no.slice(0, 4).every((t) => !M.memberStateSignal(t)), no.filter((t) => M.memberStateSignal(t)));
  const long = "That's real. A long day will drain anyone. I've got a dance workshop Saturday and a fair Sunday. Want the links? I'm also carrying the PDF and the Sequent research. Talk soon, Royce.";
  let sys = "";
  const spy = (events: any[]) => (r: any) => { sys = r.system.map((x: any) => x.text).join("\n"); return (async function* () { for (const e of events) yield e; })(); };
  const spoken: string[] = []; let flagged = 0;
  const body = baseBody({ messages: [...baseBody().messages.slice(0, 2), { role: "user", content: yes[0] }] });
  for await (const _ of P.runCallLlm(body, { stream: spy(text(long)), onSpoken: (s) => spoken.push(s), onState: () => { flagged++; } })) { /* drain */ }
  check("a drained member's turn: the prompt ends with the note, for this turn only", /# This turn: they told you how they are/.test(sys) && sys.trimEnd().endsWith(M.DRAINED_NOTE.trimEnd().slice(-40)) && flagged === 1, sys.slice(-200));
  // 2026-10-08: no cap in code any more. Royce said he'd been "kinda stressed" and Co said get some rest and hung up; the note now
  // keeps Co's agenda out and Co with them, and the model decides how much to say.
  check("no sentence cap on a drained turn: what the model says goes out (the note, not code, keeps the agenda out)", spoken.length > 2, spoken);
  check("the note keeps Cue with them: stay, the call ends when they want, never sent off to rest", /Stay with them/.test(M.DRAINED_NOTE) && /Never end the call or send them off to rest/.test(M.DRAINED_NOTE) && /no pitch, no events, no recap/.test(M.DRAINED_NOTE) && !/two short sentences|lets them go/.test(M.DRAINED_NOTE));
  check("last night's words are the signal", M.memberStateSignal("Um, I've just been kinda stressed, uh, lately, and I'm just trying to figure out what's next."));
  sys = ""; spoken.length = 0;
  for await (const _ of P.runCallLlm(baseBody({ messages: [...baseBody().messages.slice(0, 2), { role: "user", content: "Can you send the PDF on Sequent AI?" }] }), { stream: spy(text(long)), onSpoken: (s) => spoken.push(s) })) { /* drain */ }
  // 2026-10-08: one question per turn is a hard rule in code: a second question is dropped; statements after the first stay.
  check("any other turn: no note, and at most one question", !/they told you how they are/.test(sys) && spoken.filter((x) => /\?$/.test(x)).length <= 1, spoken);
  // the tool round after the same drained message keeps the note
  sys = ""; spoken.length = 0;
  const afterTool = baseBody({ messages: [...baseBody().messages.slice(0, 2), { role: "user", content: yes[0] }, { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "assess_conversation_coverage", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t1", content: "{}" }] });
  for await (const _ of P.runCallLlm(afterTool, { stream: spy(text(long)), onSpoken: (s) => spoken.push(s) })) { /* drain */ }
  check("the tool round inside the same drained turn keeps the note", /they told you how they are/.test(sys) && spoken.length > 2, spoken);
  sys = "";
  for await (const _ of P.runCallLlm(baseBody({ messages: [...afterTool.messages, { role: "assistant", content: "Take care." }, { role: "user", content: "Thanks, what about Friday?" }] }), { stream: spy(text("Friday works.")), onSpoken: () => {} })) { /* drain */ }
  check("the next turn is no longer drained", !/they told you how they are/.test(sys));
  check("with CALL_LLM_CLEAN off there is no note and no cap", await (async () => { sys = ""; for await (const _ of P.runCallLlm(body, { stream: spy(text(long)), clean: false })) { /* */ } return !/drained/.test(sys); })());
}

// ---- real finds only
{
  const found = await run(baseBody(), text("I've got the dance workshop with the BlackPink choreographer on Saturday, and the Oakland Join-Up fair Sunday. Want the links?"));
  check("an event that is in the finds list is said", /dance workshop/.test(found.content) && /Oakland Join-Up/.test(found.content) && found.dropped.length === 0, found.dropped);
  const invented = await run(baseBody(), text("There's a Founders Mixer at The Battery on Friday at 7pm. Want the link?"));
  check("an event with no source row is never said", !/Founders Mixer|Battery|7pm/.test(invented.content) && invented.dropped.length >= 1, invented.content);
  check("the member still hears the rest of the reply", /Want the link\?/.test(invented.content), invented.content);
  const only = await run(baseBody(), text("There's a Founders Mixer at The Battery on Friday at 7pm."));
  check("if that was the whole reply, Cue says it will look, never silence", only.content.trim() === G.SAFE_LINE, only.content);
  const said = await run(baseBody({ messages: [...baseBody().messages, { role: "assistant", content: "x" }, { role: "user", content: "What about the Founders Mixer at The Battery?" }] }), text("The Founders Mixer at The Battery sounds good."));
  check("a name the member said themselves is theirs to be repeated", /Founders Mixer/.test(said.content), said.content);
  const lowSelf = await run(baseBody({ messages: [{ role: "system", content: "You are Cue. What Cue has found: nothing." }, { role: "user", content: "hi" }, { role: "assistant", content: "There's a Founders Mixer at The Battery." }, { role: "user", content: "ok" }] }), text("That Founders Mixer at The Battery is on Friday."));
  check("Cue's own earlier line never sources a name (a made-up event can't vouch for itself)", !/Founders Mixer/.test(lowSelf.content), lowSelf.content);
}
{
  // The real call: 55 sentences Co said, none flagged, given what the call was given.
  const flagged = G.unsourcedInCall(fixture.turns, { firstName: g.firstName, contextSummary: g.contextSummary, findsNow: g.findsNow, rightNow: g.rightNow });
  check("replay of the real call: nothing Cue named was unsourced (no false flags)", flagged.length === 0, flagged);
  const withInvented = G.unsourcedInCall([...fixture.turns, { role: "agent", message: "There's a Founders Mixer at The Battery on Friday at 7pm." }], { firstName: g.firstName, contextSummary: g.contextSummary, findsNow: g.findsNow, rightNow: g.rightNow });
  check("an invented event in a finished call is caught", withInvented.length === 1 && /Founders Mixer/.test(withInvented[0].names.join()), withInvented);
  check("an event sentence is checked and an ordinary one is not", G.placesAnEvent("The workshop is Saturday.") && !G.placesAnEvent("Jacqueline's leading that one."));
}

// ---- a spoken commitment opens a task (the endpoint notices each sentence as it goes out)
{
  const C = await import("../../src/services/callCommitments.js");
  const said = (s: string) => C.commitmentProblem(s);
  check("'I'll text them to you right after we hang up' is a commitment", said("Done. I'll text them to you right after we hang up.") === null || said("I'll text them to you right after we hang up.") === null);
  check("'I'll put together a PDF after we hang up' is one", said("I'll put together a PDF after we hang up.") === null);
  check("'I'll send you the links tonight' is one", said("I'll send you the links tonight.") === null);
  check("a question or an offer is not", said("Want me to text you those links?") !== null && said("I can text you the link.") !== null);
  check("multi-day work set up from their words is not (the call-task read opens that)", said("I'll set that up when we hang up and text you what I find.") !== null);
  check("so is 'I'll text you what I find over the next few days' (a task they asked for, opened from their words)", said("I'll text you what I find over the next few days.") !== null);
  check("what Cue can't do is not", said("I'll send you a list of investors.") !== null && said("I'll email Maya for you.") !== null);
  const calls: any[] = []; const dues: Date[] = []; const notes: string[] = [];
  const deps: any = {
    open: async () => [],
    start: async (i: any) => { calls.push(i); return { ok: true, task: { id: 77, goal: i.goal, nextCheckAt: null } }; },
    setDue: async (_u: string, _id: number, d: Date) => { dues.push(d); },
    note: async (_u: string, _id: number, t: string) => { notes.push(t); },
  };
  const now = new Date("2026-10-06T19:00:00Z");
  const r = await C.trackCallCommitment({ userId: "u1", sentence: "I'll text you those links right after we hang up.", theirLine: "Yeah, just send those over.", now }, deps);
  check("a spoken 'I'll send X' produces a task, as a promise, in the member's own words", r.ok && calls.length === 1 && calls[0].source === "promise" && /^Keep your word from the call: /.test(calls[0].goal) && /send those over/.test(calls[0].theirWords), calls);
  check("its due is minutes after the call, not hours", dues.length === 1 && dues[0].getTime() - now.getTime() === C.DUE_AFTER_MINUTES * 60_000);
  const dup = await C.trackCallCommitment({ userId: "u1", sentence: "Let me look.", now }, deps);
  check("a sentence that is not a commitment opens nothing", !dup.ok && calls.length === 1);
  const capped = await C.trackCallCommitment({ userId: "u1", sentence: "I'll send you the notes tonight." }, { ...deps, open: async () => Array.from({ length: 4 }, () => ({ source: "promise" })) });
  check("promise tasks stay capped", !capped.ok);
  // the endpoint calls it for every sentence it says
  let tracked = 0;
  const r2: string[] = [];
  for await (const _ of P.runCallLlm(baseBody(), { stream: upstream(text("Got it. I'll text you those links right after we hang up. Talk soon.")), onSpoken: (s) => { r2.push(s); if (C.commitmentProblem(s) === null) tracked++; } })) { /* drain */ }
  check("the endpoint hands each spoken sentence to the tracker: one commitment found in three sentences", tracked === 1 && r2.length === 3, r2);
  // the transcript fallback finds the same ones, once each
  const fromTranscript = C.commitmentsIn(fixture.turns.filter((t: any) => t.role === "agent").map((t: any) => String(t.message)));
  check("the real call's 'I'll text them to you right after we hang up' is found from its transcript", fromTranscript.some((s: string) => /text them to you right after we hang up/.test(s)), fromTranscript);
  check("and its 'I'll set that up when we hang up and text you what I find' is not double-counted", !fromTranscript.some((s: string) => /what I find/.test(s)));
  // the check that it actually went out
  const recorded: any[] = []; const checked: string[] = [];
  const mkCheck = (sent: Date | null): any => ({
    due: async () => [{ id: "77", user_id: "u1", goal: "Keep your word from the call: x", created_at: new Date("2026-10-06T19:00:00Z") }],
    sentSince: async () => sent,
    note: async (_u: string, _id: number, t: string) => { checked.push(t); },
    record: async (d: any) => { recorded.push(d); },
  });
  const later = new Date("2026-10-06T20:00:00Z");
  const kept = await C.checkCallCommitments(later, mkCheck(new Date("2026-10-06T19:30:00Z")));
  check("the check: a text went out, so the commitment is kept", kept.kept === 1 && kept.unkept === 0 && recorded[0].action === "kept" && /Checked: a text went out/.test(checked[0]));
  const missed = await C.checkCallCommitments(later, mkCheck(null));
  check("the check: nothing went out, so it is recorded for the morning review and the task is told", missed.unkept === 1 && recorded[1].action === "unkept" && recorded[1].outcome === "skip" && /nothing has been sent/.test(checked[1]));
}

// ---- the real upstream parser, fed SSE split at awkward places
{
  const sse = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_del',
    'ta","index":0,"delta":{"type":"text_delta","text":"lo there."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n: ping\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ];
  const enc = new TextEncoder();
  const fakeFetch: any = async (_u: string, init: any) => {
    const sent = JSON.parse(init.body);
    check("the upstream request is the translated one, streaming, with the key header", sent.stream === true && sent.model === "claude-sonnet-4-6" && init.headers["x-api-key"] === "k");
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { sse.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } }), text: async () => "" };
  };
  const evs: any[] = [];
  for await (const e of P.anthropicStream(P.toAnthropic(baseBody()), "k", fakeFetch)) evs.push(e);
  const joined = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  check("SSE split mid-event still parses, and a keep-alive comment is ignored", joined === "Hello there." && evs.some((e) => e.type === "message_delta"), joined);
  let threw = false;
  try { for await (const _ of P.anthropicStream(P.toAnthropic(baseBody()), "k", (async () => ({ ok: false, status: 529, body: null, text: async () => "overloaded" })) as any)) { /* */ } } catch { threw = true; }
  check("an upstream error is thrown (the route turns it into a real error response)", threw);
}

// ---- the endpoint's door
{
  check("the shared secret is required (constant time)", R.proxyAuthorized("Bearer s3cret", "s3cret") && !R.proxyAuthorized("Bearer wrong!", "s3cret") && !R.proxyAuthorized(undefined, "s3cret") && !R.proxyAuthorized("Bearer s3cret", undefined));
  const rs = fs.readFileSync(new URL("../../src/routes/callLlm.ts", import.meta.url), "utf8");
  const srv = fs.readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
  check("the endpoint is mounted before the general rate limiter (a call is a request per turn)", srv.indexOf('app.use("/co/el/llm"') > 0 && srv.indexOf('app.use("/co/el/llm"') < srv.indexOf("app.use(limiter)"));
  const coTest = fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8");
  check("co-test mounts it too (co-test runs its own server file, not api/src/server.ts: the 10/7 deploy 404ed until it did)", /createCallLlmRouter/.test(coTest) && /app\.use\("\/co\/el\/llm", express\.json\(\{ limit: "4mb" \}\), createCallLlmRouter\(\)\)/.test(coTest) && coTest.indexOf('"/co/el/llm"') < coTest.indexOf("app.use(express.json("));
  check("an upstream failure before any text is a real error, not an empty reply", /502/.test(rs) && /res\.headersSent/.test(rs));
  check("the call's identity is checked with the call token", /verifyCallToken\(String\(extra\.user_id/.test(rs));
  check("CALL_LLM_CLEAN=off is the pass-through switch", /CALL_LLM_CLEAN !== "off"/.test(rs));
}

// ---- Co's own tools on a call (services/callTools.ts): run on the server mid-turn, never seen by ElevenLabs
{
  const { z } = await import("zod");
  const { tool: aiTool } = await import("ai");
  const CT = await import("../../src/services/callTools.js");
  const SW = await import("../../src/services/abilitySwitches.js");
  SW.setSwitchesForTest({});
  // A request-aware upstream: each request gets the next scripted reply, and every request is kept for inspection.
  const scripted = (replies: any[][]) => { const reqs: any[] = []; let n = 0; return { reqs, stream: (r: any) => { reqs.push(JSON.parse(JSON.stringify(r))); const ev = replies[Math.min(n++, replies.length - 1)]; return (async function* () { for (const e of ev) yield e; })(); } }; };
  const fakeSet = (run: (name: string, input: any) => Promise<unknown>, names = ["startTask"]) => ({ defs: names.map((n) => ({ name: n, description: `${n} for them`, input_schema: { type: "object", properties: {} } })), names: new Set(names), note: CT.CALL_TOOLS_GUIDE, run });
  const elTools = { tools: [{ type: "function", function: { name: "end_call", description: "End the call", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } }, { type: "function", function: { name: "voicemail_detection", description: "Voicemail", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } }] };
  const go = async (body: any, deps: any) => { const out: any[] = []; const spoken: string[] = []; for await (const c of P.runCallLlm(body, { onSpoken: (s: string) => spoken.push(s), ...deps })) out.push(c); return { out, spoken, content: out.map((c) => c.choices[0].delta.content ?? "").join(""), calls: out.flatMap((c) => c.choices[0].delta.tool_calls ?? []), finish: out[out.length - 1].choices[0].finish_reason }; };

  // 1. the model emits Co's tool, the proxy runs it, feeds the result back, and the text streams
  {
    const ran: any[] = [];
    const up = scripted([[...text("On it, I'll take that on now."), ...tool("tu1", "startTask", '{"goal":"partner event planning doc"}')], text("Done, it's on my list and I'll text you the plan.")]);
    const r = await go(baseBody(elTools), { stream: up.stream, tools: fakeSet(async (n, i) => { ran.push({ n, i }); return { ok: true, taskId: 41 }; }) });
    check("call tools: the model's Cue tool runs on the server with its input", ran.length === 1 && ran[0].n === "startTask" && ran[0].i.goal === "partner event planning doc", ran);
    check("call tools: ElevenLabs never sees Cue's tool call (only text and its own tools)", !r.calls.some((c: any) => c.function?.name === "startTask") && r.finish === "stop", r.calls);
    const second = up.reqs[1];
    check("call tools: the result is fed back as a tool_result after the model's own tool_use", !!second && second.messages.at(-2).content.some((b: any) => b.type === "tool_use" && b.id === "tu1") && second.messages.at(-1).content.some((b: any) => b.type === "tool_result" && b.tool_use_id === "tu1" && /"taskId":41/.test(b.content)), second?.messages.slice(-2));
    check("call tools: the line before the tool streams first, then the answer after it (its \"Done,\" taken off: nothing is sent on a call)", /^On it, I'll take that on now\. It's on my list/.test(r.content), r.content);
    check("call tools: Cue's tools are offered beside ElevenLabs' end_call and voicemail_detection, with the call note in the prompt", ["end_call", "voicemail_detection", "startTask"].every((n) => up.reqs[0].tools.some((t: any) => t.name === n)) && /# Doing things on this call/.test(up.reqs[0].system[0].text));
  }
  // 2. end_call passes through, with Co's tools on, once they've said goodbye (#113: Co never hangs up first; the hold is tested in
  // evals/calls/contextAndVoice.ts)
  {
    const bye = (extra: any) => { const b: any = baseBody(extra); b.messages = [...b.messages.slice(0, -1), { role: "user", content: "Alright, I've gotta run. Bye!" }]; return b; };
    const up = scripted([[...text("Talk soon, take care."), ...tool("ec1", "end_call", '{"reason":"goodbye said"}')]]);
    let ran = 0;
    const r = await go(bye(elTools), { stream: up.stream, tools: fakeSet(async () => { ran++; return { ok: true }; }) });
    check("end_call passes through to ElevenLabs whole, after the goodbye", r.calls[0]?.function?.name === "end_call" && r.calls.map((c: any) => c.function?.arguments ?? "").join("") === '{"reason":"goodbye said"}' && r.finish === "tool_calls" && /Talk soon/.test(r.content) && ran === 0 && up.reqs.length === 1, r.calls);
    const empty = await go(bye(elTools), { stream: scripted([[{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "e2", name: "end_call" } }, { type: "content_block_stop", index: 0 }]]).stream });
    check("a call tool with no input still reaches ElevenLabs as valid JSON ({})", empty.calls.map((c: any) => c.function?.arguments ?? "").join("") === "{}", empty.calls);
    // ElevenLabs may send its own tool call back with no result: the request still pairs every tool_use with a tool_result.
    const orphan = P.toAnthropic(baseBody({ messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }, { role: "assistant", content: "Bye.", tool_calls: [{ id: "el0", type: "function", function: { name: "end_call", arguments: '{"reason":"x"}' } }] }, { role: "user", content: "wait, one more thing" }] }));
    const after = orphan.messages[orphan.messages.findIndex((m) => m.content.some((x: any) => x.type === "tool_use")) + 1];
    check("a tool call ElevenLabs sent back without a result gets one, first in the next message", after?.role === "user" && (after.content[0] as any).type === "tool_result" && (after.content[0] as any).tool_use_id === "el0" && after.content.some((x: any) => x.type === "text" && /one more thing/.test(x.text)), after);
    // A goodbye that also acts: Co's tool runs, end_call still goes out, and no second model round is started.
    const ran2: string[] = [];
    const up3 = scripted([[...text("I'll note that, bye for now."), ...tool("n1", "startTask", '{"goal":"x y z"}', 1), ...tool("ec3", "end_call", '{"reason":"bye"}', 2)]]);
    const r3 = await go(bye(elTools), { stream: up3.stream, tools: fakeSet(async (n) => { ran2.push(n); return { ok: true }; }) });
    check("a goodbye with a Cue tool and end_call: the tool runs and end_call still goes out, no extra round", ran2.length === 1 && r3.calls.some((c: any) => c.function?.name === "end_call") && r3.finish === "tool_calls" && up3.reqs.length === 1);
  }
  // 3. the real guard: a tool that needs their yes is refused without it (and runs with it)
  {
    let wrote = 0;
    const raw = () => ({ writeDocument: aiTool({ description: "write", inputSchema: z.object({ title: z.string() }), execute: async () => { wrote++; return { ok: true }; } }) });
    const member = { phone: "", firstName: "Jordan", city: "San Francisco", tasks: [], loops: null };
    const noYes = CT.buildCallTools({ userId: "u-call", callKey: "u-call:t1", turnWords: "We have a partner event in November.", callWords: "We have a partner event in November.", lastCoLine: "Want me to put that in a doc?", member, dryRun: true, tools: raw() });
    check("the call's writeDocument carries the registry's theirYes field (the same guard as texting)", JSON.stringify(noYes.defs.find((d) => d.name === "writeDocument")?.input_schema).includes("theirYes"));
    const up = scripted([[...text("Let me write that up."), ...tool("w1", "writeDocument", '{"title":"Partner plan","theirYes":"yes please"}')], text("I'll hold off until you say so.")]);
    await go(baseBody(), { stream: up.stream, tools: noYes });
    const fed = up.reqs[1]?.messages.at(-1).content[0]?.content ?? "";
    check("a tool needing their yes is refused when their words this turn hold no yes", wrote === 0 && /Quote only the words in their message that say yes/.test(fed), fed);
    const yes = CT.buildCallTools({ userId: "u-call", callKey: "u-call:t1", turnWords: "Yes please, take the lead on it.", callWords: "Yes please, take the lead on it.", lastCoLine: null, member, dryRun: true, tools: raw() });
    const up2 = scripted([[...tool("w2", "writeDocument", '{"title":"Partner plan","theirYes":"yes please"}', 0)], text("It's on its way by text.")]);
    await go(baseBody(), { stream: up2.stream, tools: yes });
    check("and runs when their yes is in what they just said", wrote === 1);
    // A refused attempt can be fixed and tried once more in the same turn (the tool's own refusal says so), not a third time.
    let tries = 0;
    const flaky = CT.buildCallTools({ userId: "u-call", callKey: "u-call:t2", turnWords: "Yes please.", callWords: "Yes please.", lastCoLine: null, member, dryRun: true, tools: { writeDocument: aiTool({ description: "w", inputSchema: z.object({ title: z.string() }), execute: async () => { tries++; return { ok: false, error: "Not sent: fix the second line." }; } }) } });
    const a1: any = await flaky.run("writeDocument", { title: "A", theirYes: "yes please" }, "1");
    const a2: any = await flaky.run("writeDocument", { title: "A", theirYes: "yes please" }, "2");
    const a3: any = await flaky.run("writeDocument", { title: "A", theirYes: "yes please" }, "3");
    check("a refused document is retried once in the turn, then the per-turn limit holds", tries === 2 && a1.ok === false && a2.ok === false && /Already done this turn/.test(a3.error ?? ""), { tries, a3 });
  }
  // 4. the step cap and the time budget
  {
    let runs = 0;
    const loopForever = scripted([[...text("One more."), ...tool("s", "startTask", '{"goal":"again"}')]]);
    const r = await go(baseBody(), { stream: loopForever.stream, tools: fakeSet(async () => { runs++; return { ok: true }; }), maxToolSteps: 2 });
    check("the step cap: at most maxToolSteps rounds of Cue's tools, then the model answers with tools off", runs === 2 && loopForever.reqs.length === 3 && loopForever.reqs[2].tool_choice?.type === "none" && !loopForever.reqs[1].tool_choice, { runs, reqs: loopForever.reqs.length });
    check("the default cap is 3 rounds in 8 seconds", P.CALL_TOOL_STEPS === 3 && P.CALL_TOOL_BUDGET_MS === 8000);
    const slow = scripted([[...text("On it."), ...tool("sl", "startTask", '{"goal":"slow"}')], text("It'll come by text.")]);
    let finished = false;
    const t0 = Date.now();
    const rounds: any[] = [];
    const r2 = await go(baseBody(), { stream: slow.stream, toolBudgetMs: 60, onToolRound: (x: any) => rounds.push(x), tools: fakeSet(() => new Promise((res) => setTimeout(() => { finished = true; res({ ok: true }); }, 400))) });
    // The after-call health check's slow_turn (services/callHealth.ts, via routes/callLlm.ts call.turn_health).
    check("a round past the time budget says so (overBudget), for the after-call health check", rounds.length === 1 && rounds[0].overBudget === true && rounds[0].last === true, rounds);
    const fastRounds: any[] = [];
    await go(baseBody(), { stream: scripted([[...text("On it."), ...tool("f1", "startTask", '{"goal":"quick"}')], text("Done.")]).stream, onToolRound: (x: any) => fastRounds.push(x), tools: fakeSet(async () => ({ ok: true })) });
    check("a round inside the budget is not overBudget", fastRounds.length === 1 && fastRounds[0].overBudget === false, fastRounds);
    const fed = slow.reqs[1]?.messages.at(-1).content[0]?.content ?? "";
    check("the time budget: a slow tool doesn't hold the voice past it; the model is told it isn't back yet", Date.now() - t0 < 350 && /stillRunning/.test(fed) && slow.reqs[1].tool_choice?.type === "none" && /It'll come by text/.test(r2.content), { ms: Date.now() - t0, fed });
    await new Promise((res) => setTimeout(res, 450));
    check("and the slow tool still finishes on its own (the action happens)", finished);
    void r;
  }
  // 5. member scope
  {
    const seen: any[] = [];
    const raw = { updateNotes: aiTool({ description: "notes", inputSchema: z.object({ what: z.string().optional() }), execute: async (i: any) => { seen.push(i); return { ok: true }; } }) };
    const member = { phone: "", firstName: "Jordan", city: null, tasks: [], loops: null };
    const set = CT.buildCallTools({ userId: "member-a", callKey: "member-a:tokA", turnWords: "note it", callWords: "note it", lastCoLine: null, member, dryRun: true, tools: raw });
    await set.run("updateNotes", { what: "dinner", userId: "member-b", phone: "+10000000000" }, "x");
    check("tools act only for the call's member: an id or number in the model's input is dropped by the schema", seen.length === 1 && !("userId" in seen[0]) && !("phone" in seen[0]) && seen[0].what === "dinner", seen);
    const other = await set.run("sendReply", { message: "hi" }, "y");
    check("only the call subset exists on a call (no texting send, no intros)", (other as any)?.ok === false && !CT.CALL_TOOL_NAMES.includes("sendReply" as any) && !CT.CALL_TOOL_NAMES.some((n) => /requestEventIntro|shareFinds|webSearch|draftEmail/.test(n)));
    // What one call did is remembered for that call only, never shown on another member's call.
    CT._resetCallMemoryForTest();
    const a = CT.buildCallTools({ userId: "member-a", callKey: "member-a:tokA", turnWords: "", callWords: "", lastCoLine: null, member, dryRun: true, tools: { startTask: aiTool({ description: "s", inputSchema: z.object({ goal: z.string() }), execute: async () => ({ ok: true }) }) } });
    void a;
    const fullA = CT.buildCallTools({ userId: "member-a", callKey: "member-a:tokA", turnWords: "", callWords: "", lastCoLine: null, member, dryRun: true });
    void fullA;
    const note = (k: string, did: string[]) => CT.callToolsNote({ tasks: [{ id: 7, goal: "Plan the partner event" }], loops: null }, did);
    check("the call note lists their open tasks by id and what was done earlier on this call", /#7 "Plan the partner event"/.test(note("k", ["Started task #7."])) && /Done earlier on this call/.test(note("k", ["Started task #7."])));
    const bNote = CT.buildCallTools({ userId: "member-b", callKey: "member-b:tokB", turnWords: "", callWords: "", lastCoLine: null, member, dryRun: true }).note;
    check("another member's call never carries this call's record", !/Done earlier on this call/.test(bNote));
    const route = fs.readFileSync(new URL("../../src/routes/callLlm.ts", import.meta.url), "utf8");
    check("the route builds the tools only for the verified member (call token), never from the request's say-so", /if \(userId && !voiceOnly && process\.env\.CALL_TOOLS !== "off"\)/.test(route) && /buildCallTools\(\{ userId, callKey/.test(route));
    const w = R.callWordsOf({ messages: [{ role: "system", content: "S" }, { role: "assistant", content: "Want me to put it in a doc?" }, { role: "user", content: "Yes." }, { role: "user", content: "Please take the lead." }] } as any);
    check("their words this turn are their lines since Cue last spoke; Cue's last line is kept for a yes to an offer", w.turnWords === "Yes. Please take the lead." && w.lastCoLine === "Want me to put it in a doc?");
  }
  // 6. the real texting tools, built for a call: the same descriptions, the same schemas
  {
    const member = { phone: "", firstName: "Jordan", city: "San Francisco", tasks: [], loops: null };
    const real = CT.buildCallTools({ userId: "u-real", callKey: "u-real:t", turnWords: "hi", callWords: "hi", lastCoLine: null, member: { ...member, tasks: [{ id: 3, goal: "Venue by Friday" }] }, dryRun: true, stubSearch: true });
    const none = CT.buildCallTools({ userId: "u-real", callKey: "u-real:t", turnWords: "hi", callWords: "hi", lastCoLine: null, member, dryRun: true, stubSearch: true });
    check("with no open task, updateTask and closeTask aren't offered (the same situations as texting)", !none.names.has("updateTask") && !none.names.has("closeTask") && none.names.has("startTask"), [...none.names]);
    const C = await import("../../src/services/capabilities.js");
    check("the real call toolset is the texting tools: every one, described by its registry entry", CT.CALL_TOOL_NAMES.every((n) => real.names.has(n)) && real.defs.every((d) => d.description === C.toolUse(d.name)), [...real.names]);
    check("each schema is a JSON object schema with the guard's fields", real.defs.every((d: any) => d.input_schema.type === "object" && d.input_schema.properties?.why) && JSON.stringify(real.defs.find((d) => d.name === "researchBrief")?.input_schema).includes("theirYes"));
  }
}

// ---- 2026-10-08 live call: goodbye once, and no "I'm not sure of the name" out of nowhere
{
  const bye = (extra: any[]) => baseBody({ messages: [
    { role: "system", content: "You are Cue. # Right now\nThursday evening." },
    { role: "assistant", content: "Hey Royce, it's Cue." },
    { role: "user", content: "Okay, sounds good. Thank you so much." },
    { role: "assistant", content: "You're welcome, Royce. The doc will be in your texts in the morning. Take care tonight." },
    ...extra,
  ] });
  const r = await run(bye([{ role: "user", content: "All right, you too." }]), text("Take care, Royce."));
  check("a second goodbye is never spoken", !/Take care/.test(r.content), r.content);
  check("...and the call ends (end_call), in silence", r.finish === "tool_calls" && JSON.stringify(r.out).includes("end_call"), r.out.map((c: any) => c.choices[0].delta));
  const r2 = await run(bye([{ role: "user", content: "Wait, one more thing. Can Jacqueline see the doc?" }]), text("Yes, forward it to her once it lands."));
  check("after a goodbye, a real answer still goes through", /forward it to her/.test(r2.content), r2.content);
  check("GOODBYE matches sign-offs, not thanks or answers", P.GOODBYE.test("Take care, Royce.") && P.GOODBYE.test("Talk soon.") && P.GOODBYE.test("Okay, have a good night.") && !P.GOODBYE.test("Thanks for telling me.") && !P.GOODBYE.test("Take a look at the doc."));
}
console.log(`llmProxy: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
