// The call brain never leaves the caller in silence past ElevenLabs' timeout (2026-10-31, conv_7201m69d2wadf8tafcfzf8vp2mmh: Cue
// hung up on Royce mid-call).
// Layer 1: the model, the tools and the database are stubbed; zero tokens, no network.
//   npx tsx evals/calls/proxyTimeout.ts
// What happened: ElevenLabs waits cascade_timeout_seconds (3s on the agent) for a first token and through a stalled stream, then gives
// up on the try and sends the turn again with what Cue had already said appended; with the backup "disabled" the third timeout ended
// the call. Our turns went quiet for ~6s while the model wrote startTask's input. The retries read the member's turn as empty, and
// nothing stopped the same write from running once per try.
// What it holds:
//   1. silence is capped, not length: no words by 3.5s and the request fails before a byte (ElevenLabs' backup answers in its own
//      words); no new words for 3.5s and the turn ends on what was said; nothing scripted is added; a long reply is never cut; once the
//      turn has ended, nothing in it reports, logs or calls the model again
//   2. the member's turn: a retried request's trailing Cue line is skipped, an empty line of theirs stays empty, a re-prompt shares its
//      turn's key, and startTask's quote check reads this turn's words (fillers aside), never the whole call
//   3. a tool refused twice in one turn isn't tried a third time
//   4. the same write from another try of the same turn runs once
//   5. the agent config: backup Sonnet 4.6, cascade timeout 5s
//   6. tasks, research, pages, decks and documents are off the call; a spoken after-call promise, however Cue phrases it, opens
//      exactly one after-call task, tied to what they asked on that turn
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { z } = await import("zod");
const { tool: aiTool } = await import("ai");
const P = await import("../../src/services/callLlmProxy.js");
const CT = await import("../../src/services/callTools.js");
const T = await import("../../src/services/coTasks.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const R = await import("../../src/routes/callLlm.js");
const CC = await import("../../src/services/callCommitments.js");
const TK = await import("../../src/services/callTasks.js");
const CAP = await import("../../src/services/capabilities.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
// The fixed lines the proxy used to say (gone 2026-10-31: no scripted line on a call); none may reach the member.
const OLD_LINES = ["I'll look into that after the call and text it over.", "Got it.", "That didn't go through, so I'll text it to you right after the call."];
const saysOldLine = (t: string) => OLD_LINES.some((l) => (l === "Got it." ? t.trim() === l : t.includes(l)));
const { default: pool } = await import("../../src/db/db.js");
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The database: every read is empty, every decision row is kept for the checks.
const rows: { decision: string; action: string; proposal: any }[] = [];
const realQuery = pool.query.bind(pool);
(pool as any).query = async (sql: string, params: any[] = []) => {
  if (/INSERT INTO harness_decisions/.test(sql)) { rows.push({ decision: params[1], action: params[4], proposal: JSON.parse(params[5] ?? "null") }); return { rows: [{ id: rows.length, created_at: new Date() }] }; }
  if (/SELECT phone_number, first_name, sms_opted_out, archived_at FROM users/.test(sql)) return { rows: [{ phone_number: "+14155550123", first_name: "Jordan" }] };
  return { rows: [] };
};
const quiet = <T,>(f: () => Promise<T>): Promise<T> => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; return f().finally(() => { console.log = l; console.error = e; }); };

const text = (s: string, index = 0) => [
  { type: "content_block_start", index, content_block: { type: "text" } },
  ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index },
];
const toolUse = (id: string, name: string, args: string, index = 1) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } },
  { type: "content_block_stop", index },
];
// A model that takes its time: `gap` ms before each event, `before` ms before the first, `slowAt` ms before event k. It stops when
// its request is aborted, as the real upstream does.
const paced = (replies: any[][], o: { gap?: number; before?: number; slowAt?: Record<number, number> } = {}) => {
  const reqs: any[] = [];
  let n = 0;
  return {
    reqs,
    stream: (r: any, _u?: unknown, signal?: AbortSignal) => {
      reqs.push(JSON.parse(JSON.stringify(r)));
      const ev = replies[Math.min(n++, replies.length - 1)];
      return (async function* () {
        await wait(o.before ?? 0);
        for (const [k, e] of ev.entries()) {
          await wait(o.slowAt?.[k] ?? o.gap ?? 0);
          if (signal?.aborted) throw new Error("aborted");
          yield e;
        }
      })();
    },
  };
};
const fakeSet = (run: (name: string, input: any) => Promise<unknown>, names = ["startTask"]) => ({ defs: names.map((n) => ({ name: n, description: `${n} for them`, input_schema: { type: "object", properties: {} } })), names: new Set(names), note: CT.CALL_TOOLS_GUIDE, run });
const body = (messages?: any[]) => ({
  model: "x",
  stream: true,
  messages: messages ?? [
    { role: "system", content: "You are Cue, on a call with Royce. This call is outbound." },
    { role: "assistant", content: "Hey Royce, it's Cue." },
    { role: "user", content: "Um, yeah, knowing what you know about our company, um, I would want you to go research and find that." },
  ],
});
// Every chunk with the time it went out.
const timed = async (gen: AsyncGenerator<any>) => {
  const t0 = Date.now();
  const out: { at: number; c: any }[] = [];
  let error: unknown = null;
  try { for await (const c of gen) out.push({ at: Date.now() - t0, c }); } catch (err) { error = err; }
  const words = out.filter((x) => (x.c.choices[0].delta.content ?? "").trim());
  const content = out.map((x) => x.c.choices[0].delta.content ?? "").join("");
  let maxGap = 0;
  for (let k = 1; k < out.length; k++) if (words.length && out[k - 1].at >= words[0].at) maxGap = Math.max(maxGap, out[k].at - out[k - 1].at);
  return { out, content, ms: Date.now() - t0, maxGap, lastWordsAt: words.at(-1)?.at ?? null, beats: out.filter((x) => x.c.choices[0].delta.content === "" && !x.c.choices[0].delta.role).length, finish: out.at(-1)?.c.choices[0].finish_reason ?? null, error };
};

// ---------------------------------------------------------------- 1. silence is capped, not length
{
  check("1. both deadlines are 3.5s, 1.5s inside the agent's 5s cascade timeout; the ceiling is 15s", P.CALL_FIRST_WORDS_MS === 3500 && P.CALL_SILENCE_MS === 3500 && P.CALL_PROXY_CASCADE_TIMEOUT_SECS * 1000 - Math.max(P.CALL_FIRST_WORDS_MS, P.CALL_SILENCE_MS) === 1500 && P.CALL_TURN_CEILING_MS === 15000);
  check("1. inside the silence: a tool's floor plus one first sentence fit (200 + 1500 <= 3500), and a regeneration needs one first sentence", P.CALL_TOOL_FLOOR_MS + P.CALL_ANSWER_RESERVE_MS <= P.CALL_SILENCE_MS && P.CALL_REGEN_MIN_MS === P.CALL_ANSWER_RESERVE_MS && P.CALL_TOOL_BUDGET_MS === P.CALL_TURN_CEILING_MS - P.CALL_SILENCE_MS && P.CALL_HEARTBEAT_MS < P.CALL_SILENCE_MS);

  // A long reply that keeps talking is never cut for length (10-31: healthy replies ran 6.5-7.6s).
  const long = paced([text("One thing first. Then another thing. And a third thing. And a fourth thing to close.")], { gap: 40, before: 50 });
  let ended1: any = null;
  const r1 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: long.stream }), { firstMs: 300, gapMs: 300, ceilingMs: 5000, heartbeatMs: 100, onDeadline: (d) => { ended1 = d; } }));
  check("1. a reply that keeps talking past the first and silence deadlines runs to its end", ended1 === null && r1.ms > 300 && /fourth thing to close/.test(r1.content) && r1.finish === "stop", { ended1, ms: r1.ms });

  // The 10-31 shape: a line, then a long silence (a slow tool input, a slow tool, a held claim answered again).
  const stop = new AbortController();
  const spokenAfter: string[] = [];
  const lastResort: string[] = [];
  let endedAt = 0;
  let ended2: any = null;
  const replies = [
    [...text("Yeah, let me get that going."), ...toolUse("t1", "updateNotes", '{"what":"grants"}')],
    text("That's set up, I'll text you what I find on grants."),
    text("I'm on it, and I'll text you what turns up."),
  ];
  const m = paced(replies, { gap: 10, before: 60, slowAt: { 9: 350 } });
  const r2 = await timed(P.capTurn(P.runCallLlm(body() as any, {
    stream: (q: any) => m.stream(q, null, stop.signal),
    signal: stop.signal,
    silenceMs: 400,
    onSpoken: (s: string) => { if (endedAt) spokenAfter.push(s); },
    onLastResort: (l: string) => { lastResort.push(l); },
    tools: fakeSet(async () => { await wait(300); return { ok: false, stillRunning: true, note: "Not back yet" }; }, ["updateNotes"]),
  }), { firstMs: 400, gapMs: 400, ceilingMs: 5000, heartbeatMs: 100, abort: () => { stop.abort(); endedAt = Date.now(); }, onDeadline: (d) => { ended2 = d; } }));
  await wait(700);
  check("1. a long silence mid-reply ends the turn on what was said, about one silence after the last words", ended2?.kind === "silence" && ended2?.said === true && r2.lastWordsAt !== null && r2.ms - r2.lastWordsAt! <= 400 + 120 && r2.finish === "stop", { ended2, ms: r2.ms, lastWordsAt: r2.lastWordsAt });
  check("1. ...with nothing added: no fixed line, and the held claim never went out", /let me get that going/.test(r2.content) && !saysOldLine(r2.content) && !/That's set up/.test(r2.content), r2.content);
  check("1. ...heartbeats filled the silence (empty, never words), and didn't extend it", r2.beats >= 2 && r2.maxGap <= 100 + 80 && ended2.heartbeats === r2.beats, { beats: r2.beats, maxGap: r2.maxGap });
  check("1. once the turn has ended, nothing in it speaks, logs a last resort or calls the model again", spokenAfter.length === 0 && lastResort.length === 0 && m.reqs.length <= 2, { spokenAfter, lastResort, reqs: m.reqs.length });

  // With room, the held claim is answered again and the turn completes on its own.
  const m2 = paced(replies, { gap: 2, before: 20 });
  let ended3: any = null;
  const r3 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: m2.stream, tools: fakeSet(async () => { await wait(30); return { ok: false, stillRunning: true }; }, ["updateNotes"]) }), { heartbeatMs: 100, onDeadline: (d) => { ended3 = d; } }));
  check("1. with time in the silence, a held claim is answered again and the turn completes", ended3 === null && m2.reqs.length === 3 && /I'm on it/.test(r3.content) && !/That's set up/.test(r3.content) && r3.finish === "stop", { reqs: m2.reqs.length, content: r3.content });
  // Not enough of the silence left for a fresh first sentence: the held sentence is only dropped.
  const m3 = paced(replies, { gap: 2, before: 20 });
  await timed(P.capTurn(P.runCallLlm(body() as any, { stream: m3.stream, silenceMs: 100, tools: fakeSet(async () => { await wait(30); return { ok: false, stillRunning: true }; }, ["updateNotes"]) }), { heartbeatMs: 100 }));
  check("1. with under CALL_REGEN_MIN_MS of silence left, no regeneration is started", m3.reqs.length === 2, { reqs: m3.reqs.length });

  // No words by the first deadline: an error before anything goes out (not even a heartbeat), so ElevenLabs' backup answers.
  let aborted4 = false;
  let ended4: any = null;
  const r4 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: paced([text("Here is a reply that comes far too late.")], { before: 600 }).stream }), { firstMs: 250, heartbeatMs: 50, abort: () => { aborted4 = true; }, onDeadline: (d) => { ended4 = d; } }));
  check("1. no words by the first deadline: it throws (the route answers with an error) and the upstream is aborted", r4.error instanceof P.TurnDeadline && (r4.error as any).kind === "first_words" && aborted4 && ended4?.said === false && r4.ms <= 250 + 80, { error: String(r4.error), ms: r4.ms });
  check("1. ...and before that only the role chunk was produced (the route holds it): no words, no heartbeat, no line", r4.out.length === 1 && r4.out[0].c.choices[0].delta.role === "assistant" && !r4.content.trim(), r4.out.map((x) => x.c.choices[0].delta));

  // The ceiling is a backstop only.
  const chatty = paced([text("Word. ".repeat(80))], { gap: 10 });
  let ended5: any = null;
  const r5 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: chatty.stream }), { firstMs: 1000, gapMs: 1000, ceilingMs: 400, heartbeatMs: 100, onDeadline: (d) => { ended5 = d; } }));
  check("1. the whole-turn ceiling ends a reply that never stops, on what was said", ended5?.kind === "ceiling" && r5.ms <= 400 + 80 && r5.finish === "stop" && /Word\./.test(r5.content), { ended5, ms: r5.ms });

  // The route: a model with no words in time gets an error back before any byte; the turn is logged as handed to the backup.
  const U = "71717171-1111-2222-3333-444444444444";
  const saved = { ...process.env };
  Object.assign(process.env, { CALL_LLM_PROXY_SECRET: "proxy-secret", ELEVENLABS_TOOL_SECRET: "tool-secret", CALL_TOOLS: "off" });
  const post = (router: any) => {
    const written: string[] = [];
    const res: any = { statusCode: 200, headersSent: false, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; this.done(); return this; }, set() { return this; }, flushHeaders() { this.headersSent = true; }, write(s: string) { this.headersSent = true; written.push(s); return true; }, end() { this.done(); }, done: () => {} };
    const p = new Promise<void>((resolve) => { res.done = resolve; });
    const req: any = { method: "POST", url: "/", headers: { authorization: "Bearer proxy-secret" }, body: { ...body(), elevenlabs_extra_body: { user_id: U, call_token: E.issueCallToken(U) } } };
    router.handle(req, res, () => res.done());
    return p.then(() => ({ res, written }));
  };
  let sawSignal: AbortSignal | undefined;
  rows.length = 0;
  const late = R.createCallLlmRouter(((req: any, _u: any, signal?: AbortSignal) => { sawSignal = signal; return paced([text("Too late.")], { before: 700 }).stream(req, _u, signal); }) as any, { firstMs: 250, heartbeatMs: 50 });
  const t0 = Date.now();
  const a = await quiet(() => post(late));
  const ms = Date.now() - t0;
  await wait(30);
  check("route: no words by the first deadline: a 502 with not one byte streamed, the model request aborted", a.res.statusCode === 502 && a.written.length === 0 && sawSignal?.aborted === true && ms < 250 + 150, { status: a.res.statusCode, written: a.written.length, ms });
  check("route: logged as call.turn_deadline, ended on the backup; the latency row carries it", rows.some((x) => x.decision === "call.turn_deadline" && x.proposal?.ended === "backup" && x.proposal?.deadline === "first_words") && rows.some((x) => x.decision === "call.turn_latency" && x.proposal?.deadline === "first_words" && x.proposal?.endedOn === "backup" && x.proposal?.error === false), rows.map((x) => [x.decision, x.proposal?.ended ?? x.proposal?.deadline]));
  rows.length = 0;
  const stall = R.createCallLlmRouter(((req: any, _u: any, signal?: AbortSignal) => paced([[...text("Let me look into that."), ...text(" And one more thing.", 1)]], { gap: 2, slowAt: { 8: 900 } }).stream(req, _u, signal)) as any, { gapMs: 250, heartbeatMs: 60 });
  const b = await quiet(() => post(stall));
  await wait(30);
  const sse = b.written.join("");
  check("route: a stall mid-reply ends on what was said, with no line added, and closes the stream", /Let me look into that\./.test(sse) && !saysOldLine(sse) && sse.trim().endsWith("data: [DONE]") && b.res.statusCode === 200, sse.slice(0, 300));
  check("route: logged as call.turn_deadline ended on what was said, with the heartbeats it sent", rows.some((x) => x.decision === "call.turn_deadline" && x.proposal?.ended === "said" && x.proposal?.deadline === "silence" && x.proposal?.heartbeats >= 1) && rows.some((x) => x.decision === "call.turn_latency" && x.proposal?.endedOn === "said" && x.proposal?.heartbeats >= 1), rows.map((x) => [x.decision, x.proposal]));
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// ---------------------------------------------------------------- 2. the member's turn
{
  const said = "Um, yeah, knowing what you know about our company, um, I would want you to go research and find that.";
  const retry = body([
    { role: "system", content: "S" },
    { role: "assistant", content: "Hey Royce, it's Cue." },
    { role: "user", content: "We need grants for three dinners." },
    { role: "assistant", content: "Got it, three dinners." },
    { role: "user", content: said },
    { role: "assistant", content: "Yeah, let me get that going." },
  ]);
  const w = R.callWordsOf(retry as any);
  check("2. a retried request's trailing Cue line is skipped: the turn is still their last words", w.turnWords === said && w.lastCoLine === "Got it, three dinners." && w.callWords.split("\n").length === 2, w);
  const first = R.callWordsOf(body([{ role: "system", content: "S" }, { role: "assistant", content: "Hey Royce, it's Cue." }]) as any);
  check("2. the call's opening (no words of theirs yet) is still no turn, with Cue's greeting as the last line", first.turnWords === "" && first.lastCoLine === "Hey Royce, it's Cue.", first);
  // The reviewer's sequence: an empty line of theirs after Cue's newest offer stays an empty turn, never their earlier yes.
  const offerMsgs = [
    { role: "system", content: "S" },
    { role: "assistant", content: "Want me to text you that link?" },
    { role: "user", content: "Yes please." },
    { role: "assistant", content: "Sent. Want me to start looking for caterers for the dinner too?" },
    { role: "user", content: "" },
  ];
  const wo = R.callWordsOf(body(offerMsgs) as any);
  CT._resetCallMemoryForTest();
  let corrected = 0;
  const member = { phone: "", firstName: "Royce", city: "San Francisco", tasks: [], loops: null } as any;
  const setO = CT.buildCallTools({ userId: "u-empty", callKey: "u-empty:t", member, dryRun: true, ...wo, tools: { correctWhatCoKnows: aiTool({ description: "c", inputSchema: z.object({ what: z.string() }), execute: async () => { corrected++; return { ok: true }; } }) } });
  const yo: any = await quiet(() => setO.run("correctWhatCoKnows", { what: "x", theirYes: "yes please" }, "c1"));
  check("2. an empty line of theirs after Cue's newest offer is an empty turn: their earlier yes doesn't answer the new offer", wo.turnWords === "" && wo.lastCoLine?.startsWith("Sent. Want me") && setO.turnFacts?.turnWords === "" && yo?.ok === false && corrected === 0, { wo, yo });
  // A re-prompt after their silence (Cue's whole line last) is the same turn: it shares the turn's dedupe key, on purpose.
  const re = R.callWordsOf(body([{ role: "system", content: "S" }, { role: "assistant", content: "Hey" }, { role: "user", content: "Hi." }, { role: "assistant", content: "Hi!" }, { role: "user", content: "Find me a caterer." }, { role: "assistant", content: "On it. Anything else on your mind?" }]) as any);
  check("2. a re-prompt after their silence shares the previous turn's key (a write done for it isn't done again)", CT.turnKeyOf(re.turnWords, re.callWords) === CT.turnKeyOf("Find me a caterer.", "Hi.\nFind me a caterer."));

  // The quote check on spoken words.
  const quote = "knowing what you know about our company, I would want you to go research and find that";
  check("2. a quote of what they said, without the transcript's um's, is theirs", !T.wordsAreTheirs(quote, said) && T.spokenWordsAreTheirs(quote, said));
  check("2. fillers aside, the words must still be theirs", !T.spokenWordsAreTheirs("research grants for Noise in LA", said) && !T.spokenWordsAreTheirs("knowing what you know about our startup", said) && !T.spokenWordsAreTheirs("um uh", said) && T.spokenWordsAreTheirs("I'd like a hand, like now", "uh, I'd like a hand, like, now"));
  // startTask itself (it's no longer on a call, but its check holds wherever it runs): this turn's words, never the whole call.
  const startTaskOn = (turnWords: string, callWords: string) => createConversationTools({ turnStartedAt: Date.now(), userId: "u-st", phoneNumber: "", resolvedContent: turnWords, isVoice: true, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => false, onCall: true, firstName: "Royce", lastCoMessage: "Want me to start looking for caterers for the dinner?", recentExchange: null, turn: { userId: "u-st", message: callWords, profile: { city: null }, tasks: [] } as any, facts: { add: () => {}, text: () => "" } } as any).tools.startTask;
  const input = { goal: "Research grants for the dinners", theirWords: quote, steps: ["Look for grants"], firstStep: "Look for grants", inHours: 4 };
  const ok1: any = await quiet(() => startTaskOn(said, `We need grants for three dinners.\n${said}`).execute(input, { toolCallId: "s1", messages: [] }));
  check("2. startTask on a call takes this turn's spoken words without the um's", ok1?.ok === true, ok1);
  // The reviewer's repro: the turn is a "maybe not", and the quote is a yes from earlier in the call.
  const callWords = "Can you text me that link?\nYes please.\nHmm, I don't know, maybe not right now.";
  for (const q of ["yes please", "can you text me that"]) {
    const r: any = await quiet(() => startTaskOn("Hmm, I don't know, maybe not right now.", callWords).execute({ ...input, goal: "Find caterers for the dinner", theirWords: q }, { toolCallId: "s2", messages: [] }));
    check(`2. a quote from earlier in the call ("${q}") doesn't start a task on a "maybe not" turn`, r?.ok === false && /theirWords/.test(r?.error ?? ""), r);
  }
}

// ---------------------------------------------------------------- 3. one retry of a refused tool, then the model answers
{
  let runs = 0;
  const m = paced([[...text("Let me note that."), ...toolUse("r1", "updateNotes", '{"what":"x"}')], [...toolUse("r2", "updateNotes", '{"what":"x"}', 0)], text("I couldn't save that just now.")]);
  const r = await timed(P.runCallLlm(body() as any, { stream: m.stream, tools: fakeSet(async () => { runs++; return { ok: false, error: "The input didn't fit." }; }, ["updateNotes"]) }));
  check("3. a tool refused, retried once and refused again: no third try, the next round answers with tools off", runs === 2 && m.reqs.length === 3 && m.reqs[2].tool_choice?.type === "none" && !m.reqs[1].tool_choice && /couldn't save that/.test(r.content), { runs, reqs: m.reqs.length, choice: m.reqs.map((x: any) => x.tool_choice?.type ?? null) });
  let runs2 = 0;
  const m2 = paced([[...toolUse("q1", "updateNotes", '{"what":"x"}', 0)], [...toolUse("q2", "updateNotes", '{"what":"x"}', 0)], text("Noted.")]);
  await timed(P.runCallLlm(body() as any, { stream: m2.stream, tools: fakeSet(async () => (++runs2 === 1 ? { ok: false, error: "fix it" } : { ok: true }), ["updateNotes"]) }));
  check("3. a refusal fixed on its one retry carries on as before", runs2 === 2 && m2.reqs.length === 3, { runs2, reqs: m2.reqs.length });
  let runs3 = 0;
  const m3 = paced([[...toolUse("v1", "updateNotes", '{"what":"x"}', 0)], text("Okay.")]);
  await timed(P.runCallLlm(body() as any, { stream: m3.stream, tools: fakeSet(async () => { runs3++; return { ok: false, stillRunning: true }; }, ["updateNotes"]) }));
  check("3. a tool that's only still running isn't a refusal", runs3 === 1 && !m3.reqs[1].tool_choice, m3.reqs[1]?.tool_choice);
}

// ---------------------------------------------------------------- 4. another try of the same turn never runs a write twice
{
  CT._resetCallMemoryForTest();
  const member = { phone: "", firstName: "Royce", city: null, tasks: [{ id: 7, goal: "dinners" }, { id: 8, goal: "venue" }], loops: null } as any;
  const said = "Um, can you keep an eye out for grant deadlines for the dinners?";
  const counts: Record<string, number> = {};
  const raw = () => ({
    saveAsk: aiTool({ description: "s", inputSchema: z.object({ what: z.string() }), execute: async () => { counts.saveAsk = (counts.saveAsk ?? 0) + 1; await wait(80); return { ok: true, askId: 41 }; } }),
    updateTask: aiTool({ description: "u", inputSchema: z.object({ taskId: z.number(), note: z.string() }), execute: async () => { counts.updateTask = (counts.updateTask ?? 0) + 1; return { ok: true }; } }),
    searchEvents: aiTool({ description: "e", inputSchema: z.object({ q: z.string() }), execute: async () => { counts.searchEvents = (counts.searchEvents ?? 0) + 1; return { ok: true, events: [] }; } }),
  });
  // Three tries of one turn, as ElevenLabs sent them: the first two overlap; the third carries Cue's partial reply after their words.
  const msgs = [{ role: "system", content: "S" }, { role: "assistant", content: "Hey" }, { role: "user", content: "Hi." }, { role: "assistant", content: "Hi Royce." }, { role: "user", content: said }];
  const tryOf = (m: any[]) => CT.buildCallTools({ userId: "u-dup", callKey: "u-dup:tok", member, dryRun: true, tools: raw(), ...R.callWordsOf(body(m) as any) });
  const a = tryOf(msgs), b = tryOf(msgs), c = tryOf([...msgs, { role: "assistant", content: "Sure, on it." }]);
  const [ra, rb]: any[] = await Promise.all([a.run("saveAsk", { what: "grant deadlines" }, "a1"), b.run("saveAsk", { what: "grants for the dinners" }, "b1")]);
  const rc: any = await c.run("saveAsk", { what: "grant deadlines, dinners" }, "c1");
  check("4. three overlapping tries of one turn save one ask, not three", counts.saveAsk === 1 && ra.ok === true && rb.ok === true && rc.ok === true && rb.askId === 41 && rc.askId === 41, { counts, ra, rb, rc });
  check("4. the repeat is told it's already done on this turn (not run again)", rb.alreadyThisTurn === true && /Already done on this turn/.test(rb.note) && !ra.alreadyThisTurn, rb);
  await a.run("updateTask", { taskId: 7, note: "three dinners" }, "a2");
  await b.run("updateTask", { taskId: 7, note: "three dinners, $5-8k" }, "b2");
  await b.run("updateTask", { taskId: 8, note: "a private room" }, "b3");
  check("4. the same task's update from another try runs once; another task's update is its own write", counts.updateTask === 2, counts);
  await a.run("searchEvents", { q: "grant info sessions" }, "a3");
  await b.run("searchEvents", { q: "grant info sessions" }, "b4");
  check("4. a read runs again (it changes nothing)", counts.searchEvents === 2, counts);
  CT._resetCallMemoryForTest();
  let tries = 0;
  const flaky = () => ({ saveAsk: aiTool({ description: "s", inputSchema: z.object({ what: z.string() }), execute: async () => (++tries === 1 ? { ok: false, error: "fix it" } : { ok: true }) }) });
  const x1: any = await CT.buildCallTools({ userId: "u-f", callKey: "u-f:t", turnWords: said, callWords: said, lastCoLine: null, member, dryRun: true, tools: flaky() }).run("saveAsk", { what: "g" }, "f1");
  const x2: any = await CT.buildCallTools({ userId: "u-f", callKey: "u-f:t", turnWords: said, callWords: said, lastCoLine: null, member, dryRun: true, tools: flaky() }).run("saveAsk", { what: "g" }, "f2");
  check("4. refused on one try, the next try runs it", tries === 2 && x1.ok === false && x2.ok === true && !x2.alreadyThisTurn, { tries, x1, x2 });
  const y: any = await CT.buildCallTools({ userId: "u-f", callKey: "u-f:t", turnWords: "And one for the venue too.", callWords: `${said}\nAnd one for the venue too.`, lastCoLine: null, member, dryRun: true, tools: flaky() }).run("saveAsk", { what: "venue" }, "f3");
  check("4. the next turn of theirs runs it again (the key is per turn)", tries === 3 && y.ok === true && !y.alreadyThisTurn, { tries, y });
}

// ---------------------------------------------------------------- 5. the agent config
{
  const on: any = E.buildAgentConfig({ name: "Cue", prompt: "You are Cue.", voiceId: "v", apiUrl: "https://x.test", proxy: { url: "https://x.test/co/el/llm", secretId: "sec_1" } });
  const off: any = E.buildAgentConfig({ name: "Cue", prompt: "You are Cue.", voiceId: "v", apiUrl: "https://x.test" });
  const p = on.conversation_config.agent.prompt, d = off.conversation_config.agent.prompt;
  check("5. proxy on: the backup is ElevenLabs' own Sonnet 4.6 (the direct path's model), so a failed or wordless turn is answered", p.llm === "custom-llm" && p.backup_llm_config.preference === "override" && JSON.stringify(p.backup_llm_config.order) === '["claude-sonnet-4-6"]' && d.llm === p.backup_llm_config.order[0], p.backup_llm_config);
  check("5. proxy on: cascade timeout 5s, with both deadlines 1.5s inside it", p.cascade_timeout_seconds === 5 && p.cascade_timeout_seconds * 1000 - P.CALL_FIRST_WORDS_MS === 1500);
  check("5. proxy off: unchanged (dated Sonnet 4.5 backup, 3s)", d.backup_llm_config.order[0] === "claude-sonnet-4-5@20250929" && d.cascade_timeout_seconds === 3);
  const el = (await import("node:fs")).readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8");
  check("5. what the backup can't do is written down where it's set", /What it can't do: Cue's own tools/.test(el) && /held-claim and spoken fact checks/.test(el));
}

// ---------------------------------------------------------------- 6. off the call, and kept right after it
{
  const OFF = ["startTask", "researchBrief", "makePage", "updatePage", "makeDeck", "updateDeck", "writeDocument"];
  CT._resetCallMemoryForTest();
  const member = { phone: "", firstName: "Royce", city: null, tasks: [{ id: 3, goal: "Venue by Friday" }], loops: null } as any;
  const real = CT.buildCallTools({ userId: "u-off", callKey: "u-off:t", turnWords: "Can you research grants for us?", callWords: "Can you research grants for us?", lastCoLine: null, member, dryRun: true, stubSearch: true });
  const tried: any = await real.run("startTask", { goal: "grants", theirWords: "research grants" }, "x");
  check("6. startTask, research, pages, decks and documents aren't offered on a call, and aren't run if asked for", OFF.every((t) => !CT.CALL_TOOL_NAMES.includes(t as any) && !real.names.has(t) && CAP.callRunFor(t) === null) && tried?.ok === false && /No tool named startTask/.test(tried?.error ?? ""), { names: [...real.names] });
  check("6. quick writes stay: notes, task updates, saves, link sends", ["updateNotes", "updateTask", "saveAsk", "shareLink", "noteReaction"].every((t) => real.names.has(t)), [...real.names]);
  check("6. the call guide says it starts right after the call, in Cue's own words, and never names a removed tool", /tell them in your own words that you'll do it once you're off the call/.test(CT.CALL_TOOLS_GUIDE) && !OFF.some((t) => CT.CALL_TOOLS_GUIDE.includes(t)));

  // How Cue says it, in its own words: each one is an after-call promise, opening exactly one task tied to that turn's request.
  const phrasings = [
    "I'll dig into venues that fit the dinners right after the call.",
    "Let me look into that once we hang up, and I'll text you what turns up.",
    "I'm going to start on venue options right after this.",
    "I'll pull together a few options once we're off.",
    "I'll get you a shortlist as soon as we're done here.",
  ];
  const ask = "Um, could you go find some grants that would cover the three dinners?";
  for (const s of phrasings) {
    const made: any[] = [];
    const deps: any = {
      open: async () => made.map((t) => ({ id: t.id, source: "promise", goal: t.goal, theirWords: t.theirWords, createdAt: new Date().toISOString() })),
      start: async (x: any) => { const task = { id: made.length + 1, goal: x.goal, theirWords: x.theirWords, nextCheckAt: null }; made.push(task); return { ok: true, task }; },
      setDue: async () => {},
      note: async () => null,
    };
    const live = await CC.trackCallCommitment({ userId: "u-p", sentence: s, theirLine: ask }, deps);
    // After the call, the transcript is read again (a later line of theirs is not the request this promise answers).
    const transcript = `assistant: Hey Royce.\nuser: ${ask}\nassistant: Yes. ${s}\nuser: Thanks, talk soon.`;
    await CC.trackCommitmentsFromTranscript("u-p", transcript, {}, (o) => CC.trackCallCommitment(o, deps));
    check(`6. "${s}" is an after-call promise and opens exactly one task, tied to their request`, CC.afterCallPromise(s) && CC.commitmentProblem(s) === null && live.ok === true && made.length === 1 && made[0].theirWords === ask && made[0].goal.includes("what they asked"), { live, made });
  }
  const notPromises = ["Want me to look into that after the call?", "After this weekend I'll know more about the venue.", "I'll be honest, the dinner sounds great.", "They said they'd call after the meeting."];
  check("6. a question, an offer, another time or someone else's plan isn't an after-call promise", notPromises.every((s) => !CC.afterCallPromise(s)), notPromises.map((s) => [s, CC.afterCallPromise(s)]));
  check("6. the commitment tracker still won't keep what Cue can't do (call or book someone), after the call or not", CC.commitmentProblem("I'll call the venue right after we hang up.") !== null);
  // Round 2 of review: being around, talking, letting them go, missing or thinking about something, "let me know": no work, no task.
  const noWork = ["I'll be around after the call if you need me.", "Let's talk after the call.", "Talk after the call.", "I'll talk to you after this.", "I'll let you go so you can get to dinner after this.", "Let me know how it goes after the call.", "I'll be thinking about it after we hang up.", "I'm going to miss this after we hang up.", "I'll call you back after this."];
  check("6. an after-the-call sentence with no work in it opens nothing (review's sentences)", noWork.every((s) => !CC.afterCallPromise(s) && CC.commitmentProblem(s) !== null), noWork.map((s) => [s, CC.afterCallPromise(s), CC.commitmentProblem(s)]));
  check("6. after the call or not, Cue never promises investors, sponsors, funders or grants", ["I'll find you investors right after the call.", "I'll dig into grants that fit what you're building right after we hang up.", "Let me look for sponsors once we're off."].every((s) => CC.commitmentProblem(s) === "something Cue can't do"));
  check("6. a real promise to text after the call is still one", CC.commitmentProblem("I'll text you after the call.") === null && CC.commitmentProblem("I'll set that up when we hang up and text you what I find.") === null);

  // The 10-31 words, end to end: the live promise, the transcript pass after the call and the read of their asks open one task.
  {
    const L = "Um, yeah, knowing what you know about our company, um, I would want you to go research and find that. And if you could kind of bring that back to me, uh, that'll be great.";
    const S = "I'll dig into that right after we hang up and text you what I find.";
    const tasks: any[] = [];
    const deps: any = { open: async () => tasks, start: async (t: any) => { const task = { id: 100 + tasks.length, source: t.source, goal: t.goal, theirWords: t.theirWords, createdAt: new Date().toISOString(), status: "open" }; tasks.push(task); return { ok: true, task }; }, setDue: async () => {}, note: async () => null, zone: async () => null };
    const live = await CC.trackCallCommitment({ userId: "u", sentence: S, theirLine: L, coBefore: "Got it." }, deps);
    const tx = `assistant: Hey Royce, it's Cue.\nuser: We're planning three dinners.\nassistant: Love that.\nuser: ${L}\nassistant: Got it. ${S}\nuser: Great, thanks.\nassistant: Talk soon.`;
    await CC.trackCommitmentsFromTranscript("u", tx, {}, (o: any) => CC.trackCallCommitment(o, deps));
    const fromAsks = await TK.tasksFromCall("u", tx, { read: async () => [{ goal: "Research grants that fit Noise's dinners", quote: "knowing what you know about our company, I would want you to go research and find that" }], start: deps.start, alreadyDone: async () => false, record: async () => {}, existing: async () => tasks.map((t) => ({ id: t.id, goal: t.goal, theirWords: t.theirWords })), note: deps.note } as any);
    check("6. the 10-31 turn, end to end (live, transcript, their ask): one task, tied to their words", live.ok === true && tasks.length === 1 && tasks[0].theirWords.includes("go research and find that") && fromAsks.length === 1, { tasks: tasks.map((t) => t.goal), fromAsks });
  }

  // The research ask in their words, read after the call: one task, once, joined by the promise if Cue made one.
  let started = 0;
  const recorded = new Set<string>();
  const taskDeps: any = {
    read: async () => [{ goal: "Find grants that would cover the three dinners", quote: "could you go find some grants that would cover the three dinners" }],
    start: async () => { started++; return { ok: true, task: { id: 9 } }; },
    alreadyDone: async (_u: string, k: string) => recorded.has(k),
    record: async (_u: string, k: string) => { recorded.add(k); },
    existing: async () => [],
  };
  const tx = `assistant: Hey Royce.\nuser: ${ask} Something we can use before the end of the year.\nassistant: Yes, I'll look into it.`;
  const g1 = await TK.tasksFromCall("u-r", tx, taskDeps);
  const g2 = await TK.tasksFromCall("u-r", tx, taskDeps);
  check("6. a spoken research request becomes one after-call task from their own words (their um's aside), once per call", started === 1 && g1.length === 1 && g2.length === 0, { started, g1, g2 });
  let started2 = 0, noted = 0;
  const joined = await TK.tasksFromCall("u-r2", tx, { ...taskDeps, alreadyDone: async () => false, start: async () => { started2++; return { ok: true, task: { id: 10 } }; }, existing: async () => [{ id: 1, goal: `${CC.COMMIT_PREFIX}I'll dig into grants right after the call. (what they asked: ${ask})`, theirWords: ask }], note: async () => { noted++; } });
  check("6. ...and when Cue already promised it on the call, that promise's task carries it: still one", started2 === 0 && noted === 1 && joined.length === 1, { started2, noted });
}

// ---------------------------------------------------------------- 7. a silence never drops a write; nothing to say hands off with zero bytes
{
  // The silence deadline hits while the model is still writing updateTask's input: the spoken turn ends there, the input is read to
  // its end, the write runs once, and nothing else is said or asked of the model.
  const turn = { toolInput: null as string | null, spokenEnded: false };
  const ran: any[] = [];
  const tools = { ...fakeSet(async (name, input) => { ran.push({ name, input }); return { ok: true }; }, ["updateTask", "shareLink"]), quickWrite: (n: string) => n === "updateTask" };
  const ev = [...text("Got it, three dinners."), { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "u1", name: "updateTask" } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"taskId":7,' } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"note":"three dinners"}' } }, { type: "content_block_stop", index: 1 }];
  const m = paced([ev, text("It's on the task.")], { gap: 5, slowAt: { 7: 500 } });
  const stop = new AbortController();
  let dl: any = null, drained: string | null = null;
  const spokenAfter: string[] = [];
  let endedAt = 0;
  const r = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: (q: any) => m.stream(q, null, stop.signal), signal: stop.signal, turn, tools, onSpoken: (x: string) => { if (endedAt) spokenAfter.push(x); } }), {
    firstMs: 1000, gapMs: 300, ceilingMs: 5000, heartbeatMs: 100, abort: () => stop.abort(),
    drainable: () => (turn.toolInput && tools.quickWrite(turn.toolInput) ? turn.toolInput : null), endSpoken: () => { turn.spokenEnded = true; endedAt = Date.now(); },
    onDeadline: (d) => { dl = d; }, onDrained: (t) => { drained = t; },
  }));
  await wait(700);
  check("7. a silence mid-way through updateTask's input: the spoken turn ends on what was said", dl?.kind === "silence" && dl?.draining === "updateTask" && /Got it, three dinners\./.test(r.content) && !/on the task/.test(r.content) && r.finish === "stop", { dl, content: r.content });
  check("7. ...the input is read to its end and the write runs once, after the turn ended", ran.length === 1 && ran[0].name === "updateTask" && ran[0].input?.note === "three dinners" && drained === "updateTask", { ran, drained });
  check("7. ...and nothing else: no more speech, no further model request", spokenAfter.length === 0 && m.reqs.length === 1 && !stop.signal.aborted, { spokenAfter, reqs: m.reqs.length });
  // A send mid-input isn't run this way: the turn ends and the request is aborted (a spoken promise is followed through after the call).
  const turn2 = { toolInput: null as string | null, spokenEnded: false };
  const ran2: string[] = [];
  const tools2 = { ...fakeSet(async (name) => { ran2.push(name); return { ok: true }; }, ["updateTask", "shareLink"]), quickWrite: (n: string) => n === "updateTask" };
  const ev2 = [...text("Sure, one sec."), { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "s1", name: "shareLink" } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"what":' } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '["Jazz"]}' } }, { type: "content_block_stop", index: 1 }];
  const stop2 = new AbortController();
  let dl2: any = null;
  await timed(P.capTurn(P.runCallLlm(body() as any, { stream: (q: any) => paced([ev2], { gap: 5, slowAt: { 6: 500 } }).stream(q, null, stop2.signal), signal: stop2.signal, turn: turn2, tools: tools2 }), {
    firstMs: 1000, gapMs: 300, ceilingMs: 5000, heartbeatMs: 100, abort: () => stop2.abort(),
    drainable: () => (turn2.toolInput && tools2.quickWrite(turn2.toolInput) ? turn2.toolInput : null), endSpoken: () => { turn2.spokenEnded = true; }, onDeadline: (d) => { dl2 = d; },
  }));
  await wait(600);
  check("7. a send mid-input isn't drained: the request is aborted and nothing is sent from the call", dl2?.draining === null && stop2.signal.aborted && ran2.length === 0, { dl2, ran2 });
  check("7. the real call toolset marks quick writes (saves, notes, task and loop updates, saving an ask), never a send or a read", (() => { const set = CT.buildCallTools({ userId: "u-q", callKey: "u-q:t", turnWords: "hi", callWords: "hi", lastCoLine: null, member: { phone: "", firstName: "R", city: null, tasks: [{ id: 1, goal: "g" }], loops: null } as any, dryRun: true }); return ["updateTask", "closeTask", "updateNotes", "updateLoop", "saveAsk", "noteReaction"].every((n) => set.quickWrite!(n)) && !["shareLink", "resendLink", "searchEvents", "whatCoKnows"].some((n) => set.quickWrite!(n)); })());

  // Nothing Cue could say (an unbacked event offer, then its retry held too): no fixed line, a zero-byte 502, the backup answers.
  const U = "71717171-1111-2222-3333-444444444444";
  const saved = { ...process.env };
  Object.assign(process.env, { CALL_LLM_PROXY_SECRET: "proxy-secret", ELEVENLABS_TOOL_SECRET: "tool-secret", CALL_TOOLS: "off" });
  rows.length = 0;
  const router = R.createCallLlmRouter(((req: any, _u: any, signal?: AbortSignal) => paced([text("There's a mixer at Foundry Hall on Friday.")], { gap: 1 }).stream(req, _u, signal)) as any, { heartbeatMs: 50 });
  const written: string[] = [];
  let status = 0;
  await quiet(() => new Promise<void>((resolve) => {
    const res: any = { statusCode: 200, headersSent: false, status(c: number) { status = c; this.statusCode = c; return this; }, json() { resolve(); return this; }, set() { return this; }, flushHeaders() { this.headersSent = true; }, write(x: string) { this.headersSent = true; written.push(x); return true; }, end() { resolve(); } };
    const req: any = { method: "POST", url: "/", headers: { authorization: "Bearer proxy-secret" }, body: { ...body([{ role: "system", content: "You are Cue." }, { role: "assistant", content: "Hey Royce." }, { role: "user", content: "Anything happening this week?" }]), elevenlabs_extra_body: { user_id: U, call_token: E.issueCallToken(U) } } };
    (router as any).handle(req, res, () => resolve());
  }));
  await wait(30);
  check("7. everything held and nothing sent: a 502 with zero bytes (the backup answers), no fixed line, logged as a hand-off", status === 502 && written.length === 0 && rows.some((x) => x.decision === "call.turn_deadline" && x.proposal?.deadline === "held" && x.proposal?.ended === "backup"), { status, written: written.length, rows: rows.map((x) => x.decision) });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

(pool as any).query = realQuery;
console.log(`proxy timeout: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
