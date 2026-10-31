// The call brain never runs past ElevenLabs' timeout (2026-10-31, conv_7201m69d2wadf8tafcfzf8vp2mmh: Cue hung up on Royce mid-call).
// Layer 1: the model, the tools and the database are stubbed; zero tokens, no network.
//   npx tsx evals/calls/proxyTimeout.ts
// What happened: ElevenLabs waits cascade_timeout_seconds (3s on the agent) on our endpoint, then gives up on the try and sends the
// turn again with what Cue had already said appended; with the backup "disabled" the third timeout ended the call. Our turns ran
// 10-14s: the stream went quiet while the model wrote startTask's input, the tool ran, and a held claim was answered again. The
// retries read the member's turn as empty (Cue's partial reply was last), so startTask's quote check refused them, and nothing stopped
// the same write from running once per try.
// What it holds:
//   1. a turn ends inside the cap, a slow tool and a held-claim regeneration included, and once anything has gone out the stream is
//      never quiet longer than the heartbeat; with nothing said by the cap it ends on the approved after-call line
//   2. the member's turn is never empty: a retried request's trailing Cue line is skipped, and startTask on a call checks their spoken
//      words (fillers aside) in the call transcript
//   3. a tool refused twice in one turn isn't tried a third time: the model answers
//   4. the same write from another try of the same turn runs once
//   5. the agent config carries the backup LLM (Sonnet 4.6) and a cascade timeout the cap sits inside
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { z } = await import("zod");
const { tool: aiTool } = await import("ai");
const P = await import("../../src/services/callLlmProxy.js");
const CT = await import("../../src/services/callTools.js");
const T = await import("../../src/services/coTasks.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const R = await import("../../src/routes/callLlm.js");
const { SAFE_LINE } = await import("../../src/services/offerGuard.js");
const { default: pool } = await import("../../src/db/db.js");
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});

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
// A model that takes its time: `gap` ms before each event of each reply, `before` ms before the first (its time to first token).
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
          if (signal?.aborted) throw new Error("aborted");
          await wait(o.slowAt?.[k] ?? o.gap ?? 0);
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
// Every chunk with the time it went out, through the turn's cap.
const timed = async (gen: AsyncGenerator<any>) => {
  const t0 = Date.now();
  const out: { at: number; c: any }[] = [];
  for await (const c of gen) out.push({ at: Date.now() - t0, c });
  const content = out.map((x) => x.c.choices[0].delta.content ?? "").join("");
  const firstSaid = out.find((x) => (x.c.choices[0].delta.content ?? "").trim())?.at ?? null;
  let maxGap = 0;
  for (let k = 1; k < out.length; k++) if (firstSaid !== null && out[k - 1].at >= firstSaid) maxGap = Math.max(maxGap, out[k].at - out[k - 1].at);
  return { out, content, ms: Date.now() - t0, maxGap, firstSaid, finish: out.at(-1)?.c.choices[0].finish_reason ?? null };
};

// ---------------------------------------------------------------- 1. the turn cap and the heartbeat
{
  check("1. the cap sits 2.5s inside the agent's cascade timeout, the tool budget leaves room to answer", P.CALL_PROXY_CASCADE_TIMEOUT_SECS * 1000 - P.CALL_TURN_CAP_MS >= 2500 && P.CALL_TURN_CAP_MS - P.CALL_TOOL_BUDGET_MS >= P.CALL_REGEN_MIN_MS && P.CALL_HEARTBEAT_MS < 2000);

  // The 10-31 turn, scaled down 10x: a line, a slow tool input and a slow tool, then a claim that's held and answered again.
  // Cap 950ms (9.5s), heartbeat 100ms (1s), tool budget 650ms (6.5s), regeneration needs 200ms (2s).
  const replies = [
    [...text("Yeah, let me get that going."), ...toolUse("t1", "startTask", '{"goal":"grants","theirWords":"knowing what you know about our company"}')],
    text("That's set up, I'll text you what I find on grants."),
    text("I'm on it, and I'll text you what turns up."),
  ];
  const m = paced(replies, { gap: 10, before: 90, slowAt: { 9: 350 } });
  let aborted = false;
  let cappedWith: string | null | undefined;
  const r = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: m.stream, tools: fakeSet(async () => { await wait(300); return { ok: false, stillRunning: true, note: "Not back yet" }; }), toolBudgetMs: 650, turnCapMs: 950 }), { capMs: 950, heartbeatMs: 100, abort: () => { aborted = true; }, onCapped: (l) => { cappedWith = l; } }));
  check("1. a slow tool plus a held claim answered again still ends inside the cap", r.ms <= 950 + 120 && r.finish === "stop", { ms: r.ms, finish: r.finish });
  check("1. once anything has gone out, the stream is never quiet longer than the heartbeat", r.maxGap <= 100 + 80, { maxGap: r.maxGap });
  check("1. what was said went out, and the held claim never did", /let me get that going/.test(r.content) && !/That's set up/.test(r.content), r.content);
  check("1. capped or not, the turn ends on one finish chunk and nothing after it", r.out.filter((x) => x.c.choices[0].finish_reason).length === 1);
  void aborted; void cappedWith;

  // The same turn with room: the regeneration runs and the turn completes on its own, well inside the cap.
  const m2 = paced(replies, { gap: 2, before: 20 });
  let capped2 = false;
  const r2 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: m2.stream, tools: fakeSet(async () => { await wait(30); return { ok: false, stillRunning: true, note: "Not back yet" }; }), toolBudgetMs: 650, turnCapMs: 5000 }), { capMs: 5000, heartbeatMs: 100, onCapped: () => { capped2 = true; } }));
  check("1. with time left, the held claim is answered again and the turn completes before the cap", !capped2 && r2.ms < 1500 && m2.reqs.length === 3 && /I'm on it/.test(r2.content) && !/That's set up/.test(r2.content) && r2.finish === "stop", { reqs: m2.reqs.length, content: r2.content });

  // Too little time left for a regeneration: the held line's fallback, never a regeneration cut off by the cap.
  const m3 = paced(replies, { gap: 2, before: 20 });
  const r3 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: m3.stream, tools: fakeSet(async () => { await wait(30); return { ok: false, stillRunning: true }; }), toolBudgetMs: 650, turnCapMs: 150 }), { capMs: 2000, heartbeatMs: 100 }));
  check("1. with under CALL_REGEN_MIN_MS left, no regeneration is started", m3.reqs.length === 2 && r3.finish === "stop", { reqs: m3.reqs.length });

  // Nothing said by the cap: the approved after-call line, then stop; the upstream is aborted.
  let aborted4 = false;
  let line4: string | null | undefined;
  const silent = paced([text("Here is a reply that comes far too late.")], { before: 600 });
  const r4 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: silent.stream }), { capMs: 250, heartbeatMs: 50, abort: () => { aborted4 = true; }, onCapped: (l) => { line4 = l; } }));
  check("1. nothing said by the cap: the turn ends on the approved after-call line, then stop", r4.ms <= 250 + 80 && r4.content.trim() === SAFE_LINE && r4.finish === "stop" && line4 === SAFE_LINE && aborted4, { ms: r4.ms, content: r4.content, line4, aborted4 });
  check("1. ...and no heartbeat goes out before the first real chunk (a failure there is still a real error)", r4.out.length === 3, r4.out.map((x) => x.c.choices[0].delta));
  check("1. the approved line is the existing after-call one, no new copy", SAFE_LINE === "I'll look into that after the call and text it over.");

  // Something said, then the model stalls: the turn ends on what was said, with no line added.
  let line5: string | null | undefined = "unset";
  const stall = paced([[...text("Let me look into that."), ...text(" And one more thing.", 1)]], { gap: 2, slowAt: { 8: 800 } });
  const r5 = await timed(P.capTurn(P.runCallLlm(body() as any, { stream: stall.stream }), { capMs: 300, heartbeatMs: 60, onCapped: (l) => { line5 = l; } }));
  check("1. something said, then a stall: ends at the cap on what was said, no line added, heartbeats between", line5 === null && /Let me look into that\./.test(r5.content) && !r5.content.includes(SAFE_LINE) && r5.ms <= 300 + 80 && r5.maxGap <= 60 + 60 && r5.finish === "stop", { line5, content: r5.content, ms: r5.ms, maxGap: r5.maxGap });

  // The route: the cap's abort reaches the model request, the line reaches the member, the turn is logged as capped.
  const U = "71717171-1111-2222-3333-444444444444";
  const saved = { ...process.env };
  Object.assign(process.env, { CALL_LLM_PROXY_SECRET: "proxy-secret", ELEVENLABS_TOOL_SECRET: "tool-secret", CALL_TOOLS: "off" });
  let sawSignal: AbortSignal | undefined;
  const router = R.createCallLlmRouter(((req: any, _u: any, signal?: AbortSignal) => { sawSignal = signal; return paced([text("Too late.")], { before: 700 }).stream(req, _u, signal); }) as any, { turnCapMs: 250, heartbeatMs: 50 });
  const written: string[] = [];
  const t0 = Date.now();
  await quiet(() => new Promise<void>((resolve) => {
    const res: any = { statusCode: 200, headersSent: false, status(c: number) { this.statusCode = c; return this; }, json() { resolve(); return this; }, set() { return this; }, flushHeaders() { this.headersSent = true; }, write(s: string) { written.push(s); return true; }, end() { resolve(); } };
    const req: any = { method: "POST", url: "/", headers: { authorization: "Bearer proxy-secret" }, body: { ...body(), elevenlabs_extra_body: { user_id: U, call_token: E.issueCallToken(U) } } };
    (router as any).handle(req, res, () => resolve());
  }));
  const ms = Date.now() - t0;
  await wait(30);
  const sse = written.join("");
  check("route: a stalled model is cut at the cap, its request aborted, and the member hears the after-call line", ms < 250 + 150 && sawSignal?.aborted === true && sse.includes(SAFE_LINE) && sse.trim().endsWith("data: [DONE]"), { ms, aborted: sawSignal?.aborted, sse: sse.slice(0, 400) });
  check("route: the turn is logged as capped (and slow) for the after-call health check", rows.some((x) => x.decision === "call.turn_capped" && x.action === "after_call_line") && rows.some((x) => x.decision === "call.turn_latency" && x.proposal?.capped === true && x.proposal?.slow === true), rows.map((x) => x.decision));
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// ---------------------------------------------------------------- 2. the member's turn is never empty, and their spoken words count
{
  const said = "Um, yeah, knowing what you know about our company, um, I would want you to go research and find that.";
  // ElevenLabs' second and third tries: Cue's partial reply from the try it gave up on, after their words.
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
  const plain = R.callWordsOf(body() as any);
  check("2. an ordinary turn reads as before", plain.turnWords === said && plain.lastCoLine === "Hey Royce, it's Cue.");
  const member = { phone: "", firstName: "Royce", city: "San Francisco", tasks: [], loops: null } as any;
  const set = CT.buildCallTools({ userId: "u-empty", callKey: "u-empty:t", turnWords: "  ", callWords: `We need grants for three dinners.\n${said}`, lastCoLine: null, member, dryRun: true, tools: { updateNotes: aiTool({ description: "n", inputSchema: z.object({ what: z.string() }), execute: async () => ({ ok: true }) }) } });
  check("2. an empty turn is never passed in: their last line on the call stands for it", set.turnFacts?.turnWords === said, set.turnFacts?.turnWords);

  // The quote check on spoken words.
  const quote = "knowing what you know about our company, I would want you to go research and find that";
  check("2. a quote of what they said, without the transcript's um's, is theirs", !T.wordsAreTheirs(quote, said) && T.spokenWordsAreTheirs(quote, said));
  check("2. fillers aside, the words must still be theirs (a real word is never dropped, nothing invented passes)", !T.spokenWordsAreTheirs("research grants for Noise in LA", said) && !T.spokenWordsAreTheirs("knowing what you know about our startup", said) && !T.spokenWordsAreTheirs("um uh", said) && T.spokenWordsAreTheirs("I'd like a hand, like now", "uh, I'd like a hand, like, now"));

  // The real startTask, on a call (dry run): the 10-31 quote passes on the spoken words; a made-up one is refused.
  CT._resetCallMemoryForTest();
  const callSet = (turnWords: string, key: string) => CT.buildCallTools({ userId: "u-st", callKey: `u-st:${key}`, turnWords, callWords: `We need grants for three dinners.\n${said}`, lastCoLine: "Got it, three dinners.", member, dryRun: true });
  const input = { goal: "Research grants for the dinners", theirWords: quote, steps: ["Look for grants"], firstStep: "Look for grants", inHours: 4 };
  const ok1: any = await quiet(() => callSet(said, "k1").run("startTask", input, "s1"));
  check("2. startTask on a call takes their spoken words (the 10-31 quote, refused then)", ok1?.ok === true, ok1);
  const ok2: any = await quiet(() => callSet("", "k2").run("startTask", input, "s2"));
  check("2. ...and on a retried request whose turn came in empty", ok2?.ok === true, ok2);
  const bad: any = await quiet(() => callSet(said, "k3").run("startTask", { ...input, theirWords: "please research grants in LA for us" }, "s3"));
  check("2. a quote they never said is still refused, with the call's own wording", bad?.ok === false && /their own words from this call/.test(bad?.error ?? ""), bad);
}

// ---------------------------------------------------------------- 3. one retry of a refused tool, then the model answers
{
  let runs = 0;
  const m = paced([[...text("Let me set that up."), ...toolUse("r1", "startTask", '{"goal":"x"}')], [...toolUse("r2", "startTask", '{"goal":"x"}', 0)], text("I couldn't set that up just now.")]);
  const r = await timed(P.runCallLlm(body() as any, { stream: m.stream, tools: fakeSet(async () => { runs++; return { ok: false, error: "theirWords must be their own words from this call." }; }) }));
  check("3. a tool refused, retried once and refused again: no third try, the next round answers with tools off", runs === 2 && m.reqs.length === 3 && m.reqs[2].tool_choice?.type === "none" && !m.reqs[1].tool_choice && /couldn't set that up/.test(r.content), { runs, reqs: m.reqs.length, choice: m.reqs.map((x: any) => x.tool_choice?.type ?? null) });
  let runs2 = 0;
  const m2 = paced([[...toolUse("q1", "startTask", '{"goal":"x"}', 0)], [...toolUse("q2", "startTask", '{"goal":"x"}', 0)], text("That's set up.")]);
  await timed(P.runCallLlm(body() as any, { stream: m2.stream, tools: fakeSet(async () => (++runs2 === 1 ? { ok: false, error: "fix it" } : { ok: true })) }));
  check("3. a refusal fixed on its one retry carries on as before", runs2 === 2 && m2.reqs.length === 3, { runs2, reqs: m2.reqs.length });
  let runs3 = 0;
  const m3 = paced([[...toolUse("v1", "startTask", '{"goal":"x"}', 0)], text("Okay.")]);
  await timed(P.runCallLlm(body() as any, { stream: m3.stream, tools: fakeSet(async () => { runs3++; return { ok: false, stillRunning: true }; }) }));
  check("3. a tool that's only still running isn't a refusal", runs3 === 1 && !m3.reqs[1].tool_choice, m3.reqs[1]?.tool_choice);
}

// ---------------------------------------------------------------- 4. another try of the same turn never runs a write twice
{
  CT._resetCallMemoryForTest();
  const member = { phone: "", firstName: "Royce", city: null, tasks: [{ id: 7, goal: "dinners" }, { id: 8, goal: "venue" }], loops: null } as any;
  const said = "Um, can you go research grants for the dinners and bring that back to me?";
  const counts: Record<string, number> = {};
  const raw = () => ({
    startTask: aiTool({ description: "s", inputSchema: z.object({ goal: z.string() }), execute: async () => { counts.startTask = (counts.startTask ?? 0) + 1; await wait(80); return { ok: true, taskId: 1103 }; } }),
    updateTask: aiTool({ description: "u", inputSchema: z.object({ taskId: z.number(), note: z.string() }), execute: async () => { counts.updateTask = (counts.updateTask ?? 0) + 1; return { ok: true }; } }),
    searchEvents: aiTool({ description: "e", inputSchema: z.object({ q: z.string() }), execute: async () => { counts.searchEvents = (counts.searchEvents ?? 0) + 1; return { ok: true, events: [] }; } }),
  });
  // Three tries of one turn, as ElevenLabs sent them: the first and second overlap; the third reads a turn that came in empty.
  const tryOf = (turnWords: string) => CT.buildCallTools({ userId: "u-dup", callKey: "u-dup:tok", turnWords, callWords: `Hi.\n${said}`, lastCoLine: null, member, dryRun: true, tools: raw() });
  const a = tryOf(said), b = tryOf(said), c = tryOf("");
  const [ra, rb]: any[] = await Promise.all([a.run("startTask", { goal: "Research grants" }, "a1"), b.run("startTask", { goal: "Grants that fit Noise" }, "b1")]);
  const rc: any = await c.run("startTask", { goal: "Grants for the three dinners" }, "c1");
  check("4. three overlapping tries of one turn open one task, not three", counts.startTask === 1 && ra.ok === true && rb.ok === true && rc.ok === true && rb.taskId === 1103 && rc.taskId === 1103, { counts, ra, rb, rc });
  check("4. the repeat is told it's already done on this turn (not run again)", rb.alreadyThisTurn === true && /Already done on this turn/.test(rb.note) && !ra.alreadyThisTurn, rb);
  await a.run("updateTask", { taskId: 7, note: "three dinners" }, "a2");
  await b.run("updateTask", { taskId: 7, note: "three dinners, $5-8k" }, "b2");
  await b.run("updateTask", { taskId: 8, note: "a private room" }, "b3");
  check("4. the same task's update from another try runs once; another task's update is its own write", counts.updateTask === 2, counts);
  await a.run("searchEvents", { q: "grant info sessions" }, "a3");
  await b.run("searchEvents", { q: "grant info sessions" }, "b4");
  check("4. a read runs again (it changes nothing)", counts.searchEvents === 2, counts);
  // A refusal on one try doesn't stand in for the work: the next try may run it.
  CT._resetCallMemoryForTest();
  let tries = 0;
  const flaky = () => ({ startTask: aiTool({ description: "s", inputSchema: z.object({ goal: z.string() }), execute: async () => (++tries === 1 ? { ok: false, error: "quote" } : { ok: true, taskId: 2 }) }) });
  const x1: any = await CT.buildCallTools({ userId: "u-f", callKey: "u-f:t", turnWords: said, callWords: said, lastCoLine: null, member, dryRun: true, tools: flaky() }).run("startTask", { goal: "g" }, "f1");
  const x2: any = await CT.buildCallTools({ userId: "u-f", callKey: "u-f:t", turnWords: said, callWords: said, lastCoLine: null, member, dryRun: true, tools: flaky() }).run("startTask", { goal: "g" }, "f2");
  check("4. refused on one try, the next try runs it", tries === 2 && x1.ok === false && x2.ok === true && !x2.alreadyThisTurn, { tries, x1, x2 });
  // A new turn of theirs is new work.
  const y: any = await CT.buildCallTools({ userId: "u-f", callKey: "u-f:t", turnWords: "And one for the venue too.", callWords: `${said}\nAnd one for the venue too.`, lastCoLine: null, member, dryRun: true, tools: flaky() }).run("startTask", { goal: "venue" }, "f3");
  check("4. the next turn of theirs runs it again (the key is per turn)", tries === 3 && y.ok === true && !y.alreadyThisTurn, { tries, y });
  check("4. the turn key is the same across tries and differs across turns", CT.turnKeyOf(said, `Hi.\n${said}`) === CT.turnKeyOf(said, `Hi.\n${said}`) && CT.turnKeyOf(said, `Hi.\n${said}`) !== CT.turnKeyOf(said, `Hi.\n${said}\n${said}`));
}

// ---------------------------------------------------------------- 5. the backup LLM in the built agent config
{
  const prompt = "You are Cue.";
  const on: any = E.buildAgentConfig({ name: "Cue", prompt, voiceId: "v", apiUrl: "https://x.test", proxy: { url: "https://x.test/co/el/llm", secretId: "sec_1" } });
  const off: any = E.buildAgentConfig({ name: "Cue", prompt, voiceId: "v", apiUrl: "https://x.test" });
  const p = on.conversation_config.agent.prompt, d = off.conversation_config.agent.prompt;
  check("5. proxy on: the backup is ElevenLabs' own Sonnet 4.6 (the direct path's model), so a failed endpoint never ends the call", p.llm === "custom-llm" && p.backup_llm_config.preference === "override" && JSON.stringify(p.backup_llm_config.order) === '["claude-sonnet-4-6"]' && d.llm === p.backup_llm_config.order[0], p.backup_llm_config);
  check("5. proxy on: the cascade timeout is set explicitly, inside ElevenLabs' 2-15s, with the turn cap 2.5s inside it", p.cascade_timeout_seconds === P.CALL_PROXY_CASCADE_TIMEOUT_SECS && p.cascade_timeout_seconds >= 2 && p.cascade_timeout_seconds <= 15 && p.cascade_timeout_seconds * 1000 - P.CALL_TURN_CAP_MS >= 2500);
  check("5. proxy off: unchanged (dated Sonnet 4.5 backup, 3s)", d.backup_llm_config.order[0] === "claude-sonnet-4-5@20250929" && d.cascade_timeout_seconds === 3);
  const el = (await import("node:fs")).readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8");
  check("5. what the backup can't do is written down where it's set", /What it can't do: Cue's own tools/.test(el) && /held-claim and spoken fact checks/.test(el));
}

(pool as any).query = realQuery;
console.log(`proxy timeout: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
