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
    { role: "system", content: `You are Co.\n# Right now\n${g.rightNow}\n# What Co has found for them\n${g.findsNow}\n${g.contextSummary}` },
    { role: "assistant", content: "Hey Royce, it's Co." },
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
  check("the model is Haiku 4.5 and streams", a.model === "claude-haiku-4-5" && a.stream === true);
  check("the last message is the member's (no accidental prefill)", a.messages[a.messages.length - 1].role === "user");
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
  check("a drained member's turn: the prompt ends with the note, for this turn only", /# This turn: they said they are drained/.test(sys) && sys.trimEnd().endsWith(M.DRAINED_NOTE.trimEnd().slice(-40)) && flagged === 1, sys.slice(-200));
  check("replay: Co's six sentences are cut to two, with no pitch (the events keep)", spoken.length === 2 && !/workshop|fair|links|PDF|Sequent/.test(spoken.join(" ")), spoken);
  sys = ""; spoken.length = 0;
  for await (const _ of P.runCallLlm(baseBody({ messages: [...baseBody().messages.slice(0, 2), { role: "user", content: "Can you send the PDF?" }] }), { stream: spy(text(long)), onSpoken: (s) => spoken.push(s) })) { /* drain */ }
  check("any other turn: no note, no cap", !/they said they are drained/.test(sys) && spoken.length === 6, spoken.length);
  // the tool round after the same drained message keeps the note and the cap
  sys = ""; spoken.length = 0;
  const afterTool = baseBody({ messages: [...baseBody().messages.slice(0, 2), { role: "user", content: yes[0] }, { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "assess_conversation_coverage", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t1", content: "{}" }] });
  for await (const _ of P.runCallLlm(afterTool, { stream: spy(text(long)), onSpoken: (s) => spoken.push(s) })) { /* drain */ }
  check("the tool round inside the same drained turn keeps the note and the two-sentence cap", /they said they are drained/.test(sys) && spoken.length === 2, spoken);
  sys = "";
  for await (const _ of P.runCallLlm(baseBody({ messages: [...afterTool.messages, { role: "assistant", content: "Take care." }, { role: "user", content: "Thanks, what about Friday?" }] }), { stream: spy(text("Friday works.")), onSpoken: () => {} })) { /* drain */ }
  check("the next turn is no longer drained", !/they said they are drained/.test(sys));
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
  check("if that was the whole reply, Co says it will look, never silence", only.content.trim() === G.SAFE_LINE, only.content);
  const said = await run(baseBody({ messages: [...baseBody().messages, { role: "assistant", content: "x" }, { role: "user", content: "What about the Founders Mixer at The Battery?" }] }), text("The Founders Mixer at The Battery sounds good."));
  check("a name the member said themselves is theirs to be repeated", /Founders Mixer/.test(said.content), said.content);
  const lowSelf = await run(baseBody({ messages: [{ role: "system", content: "You are Co. What Co has found: nothing." }, { role: "user", content: "hi" }, { role: "assistant", content: "There's a Founders Mixer at The Battery." }, { role: "user", content: "ok" }] }), text("That Founders Mixer at The Battery is on Friday."));
  check("Co's own earlier line never sources a name (a made-up event can't vouch for itself)", !/Founders Mixer/.test(lowSelf.content), lowSelf.content);
}
{
  // The real call: 55 sentences Co said, none flagged, given what the call was given.
  const flagged = G.unsourcedInCall(fixture.turns, { firstName: g.firstName, contextSummary: g.contextSummary, findsNow: g.findsNow, rightNow: g.rightNow });
  check("replay of the real call: nothing Co named was unsourced (no false flags)", flagged.length === 0, flagged);
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
  check("what Co can't do is not", said("I'll send you a list of investors.") !== null && said("I'll email Maya for you.") !== null);
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
    check("the upstream request is the translated one, streaming, with the key header", sent.stream === true && sent.model === "claude-haiku-4-5" && init.headers["x-api-key"] === "k");
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
  check("an upstream failure before any text is a real error, not an empty reply", /502/.test(rs) && /res\.headersSent/.test(rs));
  check("the call's identity is checked with the call token", /verifyCallToken\(String\(extra\.user_id/.test(rs));
  check("CALL_LLM_CLEAN=off is the pass-through switch", /CALL_LLM_CLEAN !== "off"/.test(rs));
}

console.log(`llmProxy: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
