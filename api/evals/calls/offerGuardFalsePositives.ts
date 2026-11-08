// The call's line guards held ordinary conversation back as unsourced offers (call.offer_unsourced) on Royce's dev calls, 2026-10-31
// to 11-04, cutting Cue off mid-thought. Two causes, each narrowed here; real unsourced offers stay held.
//   1. "A lot of TTS systems sound fine in isolation..." : offerGuard.ts spokenProblem read "TTS" as an unbacked name. An all-caps
//      term in a sentence that offers nothing, not after an org or place word, is vocabulary (vocabularyTerm).
//   2. "Like what's the first thing...?" / "Like if you woke up tomorrow...?" : said straight after the turn's question, the one-question
//      rule (callLlmProxy.ts say, second_question / after_question) held them as a second question. Royce, 2026-11-07: decided by
//      meaning. A follow-on is read by the model (services/questionRead.ts sameQuestion): same answer, said; different answer, held.
//      No read (none, failed, slow): held, as before. No word list.
//   3. Found here: "I'll book that", "I'll reserve a table", "You'll have three intros by next week" passed every guard. They are their
//      own check (offerGuard.ts offerNeedingPath): said only when a tool on this call that carries that kind out came back done.
// Layer 1: a fake model stream through the real proxy (both call paths run it: ElevenLabs and GPT-Live's thinkOnCall); zero tokens.
//   npx tsx evals/calls/offerGuardFalsePositives.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/services/callLlmProxy.js");
const G = await import("../../src/services/offerGuard.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const SW = await import("../../src/services/abilitySwitches.js");
SW.setSwitchesForTest({});
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

const base = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const system = E.promptForElevenLabs(base).replace(/\{\{first_name\}\}/g, "Jordan").replace("{{context_summary}}", "Jordan is a founder in San Francisco building a voice product. New to Cue.").replace(/\{\{[a-z_]+\}\}/g, "");
const THEIR = "Honestly I'm stuck on the pitch for the voice thing. It's hard to explain what makes it different.";
const body = (their = THEIR, sys = system) => ({ model: "co", stream: true, messages: [{ role: "system", content: sys }, { role: "assistant", content: "Hey Jordan, it's Cue." }, { role: "user", content: their }] });
const text = (s: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: 0 },
];
// One scripted reply, then (if the turn is held to nothing) a plain retry line. jobClaims as GPT-Live's path runs it; the ElevenLabs
// path runs the same say() without it.
const turn = async (reply: string | any[][], o: { their?: string; sys?: string; jobClaims?: boolean; sameQuestion?: (a: string, b: string) => Promise<boolean | null>; tools?: any } = {}) => {
  const spoken: string[] = [], dropped: string[] = [], reqs: any[] = [];
  let n = 0, content = "";
  const replies = typeof reply === "string" ? [text(reply)] : reply;
  const stream = (r: any) => { reqs.push(r); const ev = replies[n] ?? text("Tell me more."); n++; return (async function* () { for (const e of ev) yield e as any; })(); };
  for await (const c of P.runCallLlm(body(o.their, o.sys) as any, { stream, clean: true, jobClaims: o.jobClaims ?? false, sameQuestion: o.sameQuestion, tools: o.tools, onSpoken: (s: string) => spoken.push(s), onDropped: (s: string, w: string) => dropped.push(`${s} | ${w}`) } as any)) content += (c.choices[0].delta as any).content ?? "";
  return { spoken, dropped, content, reqs };
};
// The model's read, stubbed: what it was asked, and the answer it gives.
const reads: [string, string][] = [];
const judge = (same: boolean | null, ms = 0) => async (a: string, b: string) => { reads.push([a, b]); if (ms) await new Promise((r) => setTimeout(r, ms)); return same; };
const src = P.callSources(body() as any, "", "");
const said = (r: { spoken: string[] }, line: string) => r.spoken.some((s) => s.includes(line));

// ---- the three dev-call lines pass
const TTS = "A lot of TTS systems sound fine in isolation but fall apart in actual back and forth because they're not built for conversation.";
const FIRST = "Like what's the first thing you want to say before you get into the product?";
const WOKE = "Like if you woke up tomorrow and you knew, what would you have figured out?";
check("1. TTS line: no spoken problem", G.spokenProblem(TTS, src) === null, G.spokenProblem(TTS, src));
for (const jobClaims of [false, true]) {
  const tag = jobClaims ? "gpt-live path" : "elevenlabs path";
  const r1 = await turn(`That's the hard part. ${TTS}`, { jobClaims });
  check(`1. TTS line reaches the voice (${tag})`, said(r1, TTS) && !r1.dropped.length, r1);
  reads.length = 0;
  const r2 = await turn(`What do you want them to walk away with? ${FIRST}`, { jobClaims, sameQuestion: judge(true) });
  check(`2. "Like what's the first thing...?" read as the same question reaches the voice, in order (${tag})`, r2.spoken.join(" ") === `What do you want them to walk away with? ${FIRST}` && !r2.dropped.length, r2);
  check(`...the read was asked about the turn's question and the follow-on (${tag})`, reads.length === 1 && reads[0][0] === "What do you want them to walk away with?" && reads[0][1] === FIRST, reads);
  const r3 = await turn(`What's the part you're still figuring out? ${WOKE}`, { jobClaims, sameQuestion: judge(true) });
  check(`3. "Like if you woke up tomorrow...?" read as the same question reaches the voice (${tag})`, said(r3, WOKE) && !r3.dropped.length, r3);
}
// Royce's pair (2026-11-07): the same opener, two meanings. The read decides, not the word "Like".
{
  const Q = "What's the first thing you want to say?";
  const same = await turn(`${Q} Like, before you get into the product?`, { sameQuestion: judge(true) });
  check("same answer ('Like, before you get into the product?'): said", said(same, "before you get into the product?") && !same.dropped.length, same);
  const diff = await turn(`${Q} Like, who's your audience?`, { sameQuestion: judge(false) });
  check("different answer ('Like, who's your audience?'): held as a second question", said(diff, Q) && !said(diff, "audience") && diff.dropped.some((d) => /audience.*second question/.test(d)), diff);
  const none = await turn(`${Q} Like, before you get into the product?`);
  check("no read on this path: the follow-on is held, as before (one question)", !said(none, "before you get") && none.dropped.some((d) => /second question/.test(d)), none);
  const failed = await turn(`${Q} Like, before you get into the product?`, { sameQuestion: judge(null) });
  check("a read that can't tell: held", !said(failed, "before you get"), failed);
  const t0 = Date.now();
  const slow = await turn(`${Q} Like, before you get into the product?`, { sameQuestion: judge(true, 4000) });
  check(`a read past its time bound: held, and the turn doesn't wait on it (${Date.now() - t0}ms)`, !said(slow, "before you get") && Date.now() - t0 < 3000, slow);
  const thrown = await turn(`${Q} Like, before you get into the product?`, { sameQuestion: async () => { throw new Error("down"); } });
  check("a read that fails: held, never an error", !said(thrown, "before you get") && said(thrown, Q), thrown);
  reads.length = 0;
  const third = await turn(`${Q} Like, before you get into the product? Like, the very first line?`, { sameQuestion: judge(true) });
  check("one follow-on a turn is read: a third question is held without a read", said(third, "before you get into the product?") && !said(third, "very first line") && reads.length === 1, { third, reads });
  const after = await turn(`${Q} Like, before you get into the product? I ask because the opening sets the tone.`, { sameQuestion: judge(true) });
  check("what's said after the follow-on waits for it: nothing out of order", after.spoken.join(" ") === `${Q} Like, before you get into the product? I ask because the opening sets the tone.`, after.spoken);
  const afterDiff = await turn(`${Q} Like, who's your audience? I ask because the opening sets the tone.`, { sameQuestion: judge(false) });
  check("...and still said when the follow-on is held", afterDiff.spoken.join(" ") === `${Q} I ask because the opening sets the tone.`, afterDiff.spoken);
  const ground = await turn(`${Q} Like, want me to intro you to someone at Stripe?`, { sameQuestion: judge(true) });
  check("a same-answer follow-on is still grounded: an unbacked name in it is held", !said(ground, "Stripe") && ground.dropped.some((d) => /Stripe/.test(d)), ground);
}
// The read: its prompt and its answer.
{
  const Qr = await import("../../src/services/questionRead.js");
  const pr = Qr.sameQuestionPrompt("What's the first thing you want to say?", "Like, who's your audience?");
  check("the read's prompt gives both questions and asks same answer or different answer", pr.includes("What's the first thing you want to say?") && pr.includes("Like, who's your audience?") && /SAME answer/.test(pr) && /DIFFERENT answer/.test(pr));
  check("the read's answer parses; anything else is no read", Qr.parseSameQuestion('{"same": true}') === true && Qr.parseSameQuestion('Sure: {"same": false}') === false && Qr.parseSameQuestion("same") === null && Qr.parseSameQuestion('{"same":"yes"}') === null);
}

// ---- both call paths ask the read (behaviour: the read stubbed, each path driven with a two-question reply)
{
  const Qr = await import("../../src/services/questionRead.js");
  const asked: string[] = [];
  Qr.setSameQuestionForTest(async (a, b) => { asked.push(`${a} || ${b}`); return true; });
  const TWOQ = "What do you want them to feel? Like, what's the one word for it?";
  // GPT-Live: the thinking (gptLive.ts thinkOnCall), with no read of its own given.
  const GL = await import("../../src/services/gptLive.js");
  const call = GL.buildLiveCall({ userId: "u-jordan", callSid: "CA-jordan", firstName: "Jordan", direction: "inbound", team: true, voiceLayer: base, contextSummary: "Jordan is building a voice product.", rightNow: "It's Saturday afternoon for them.", findsNow: "", callReason: "", timeOfDay: "Saturday afternoon" });
  const gl = await GL.thinkOnCall(call, [{ who: "member", text: "I'm stuck on the pitch.", startMs: 0, endMs: 900 }], () => (async function* () { for (const e of text(TWOQ)) yield e as any; })(), undefined, undefined, undefined, undefined, { tools: async () => null });
  check("GPT-Live's thinking asks the read, and says the same-answer follow-on", asked.length === 1 && asked[0] === "What do you want them to feel? || Like, what's the one word for it?" && /one word for it\?/.test(gl.text), { asked, text: gl.text });
  // ElevenLabs: the call route (routes/callLlm.ts), its database stubbed.
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = pool.query.bind(pool);
  (pool as any).query = async () => ({ rows: [] });
  const savedEnv = { ...process.env };
  Object.assign(process.env, { CALL_LLM_PROXY_SECRET: "proxy-secret", ELEVENLABS_TOOL_SECRET: "tool-secret", CALL_TOOLS: "off" });
  const { createCallLlmRouter } = await import("../../src/routes/callLlm.js");
  const U = "41414141-1111-2222-3333-444444444444";
  let wrote = "";
  const router = createCallLlmRouter((() => (async function* () { yield { type: "message_start", message: { id: "m", usage: { input_tokens: 0, output_tokens: 0 } } } as any; for (const e of text(TWOQ)) yield e as any; yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } as any; })()) as any);
  await new Promise<void>((resolve) => {
    const res: any = { statusCode: 200, headersSent: false, status(c: number) { this.statusCode = c; return this; }, json() { resolve(); return this; }, set() { return this; }, setHeader() {}, flushHeaders() {}, write(d: string) { wrote += d; return true; }, end() { resolve(); } };
    const req: any = { method: "POST", url: "/", headers: { authorization: "Bearer proxy-secret" }, body: { model: "x", stream: true, messages: [{ role: "system", content: "You are Cue." }, { role: "assistant", content: "Hi Jordan." }, { role: "user", content: "I'm stuck on the pitch." }], elevenlabs_extra_body: { user_id: U, call_token: E.issueCallToken(U) } } };
    (router as any).handle(req, res, () => resolve());
    setTimeout(resolve, 5000);
  });
  check("the ElevenLabs route asks the read too, and says the same-answer follow-on", asked.length === 2 && asked[1] === asked[0] && /one word for it\?/.test(wrote), { asked, wrote: wrote.slice(0, 400) });
  (pool as any).query = realQuery;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  Qr.setSameQuestionForTest(null);
}

// ---- real unsourced offers stay held (each never reaches the voice)
const OFFERS = [
  "I'll send you three events tonight.",
  "I can intro you to someone at Stripe.",
  "I'll put you in touch with the founder of Linear.",
  "Let me set up a call with Priya from Figma.",
  "I'll text you the guest list for the Foundry Hall dinner.",
  "I can get you in front of someone at IBM.",
  "I'll find you a cofounder by Friday.",
  "I can get you on the list at SOMA House.",
  "Want me to intro you to someone at Stripe?",
  "I'll send you the TTS benchmarks from OpenAI.",
  "Like if you want, I'll text you three events tonight.",
  // The gap found on this PR: these passed every guard before it.
  "I'll book that.",
  "I'll reserve a table for you.",
  "You'll have three intros by next week.",
];
for (const jobClaims of [false, true]) for (const o of OFFERS) {
  const r = await turn(`That makes sense. ${o}`, { jobClaims });
  check(`offer held (${jobClaims ? "gpt-live" : "elevenlabs"}): ${o}`, !said(r, o) && r.dropped.some((d) => d.startsWith(o)), r);
}
check("an acronym in an offer is still checked as a name", G.spokenProblem("I can set you up with the TTS team.", src)?.kind === "name");
check("an acronym after an org or place word is still a name: 'someone at IBM', 'the scene in SF'", G.spokenProblem("I know someone at IBM who'd get it.", src)?.kind === "name" && G.spokenProblem("The voice scene in SF is pretty deep.", src)?.kind === "name");
// Review of #418: an all-caps name is still a name. A subject, after a person cue, or followed by a verb: checked, held unbacked.
for (const l of ["AJ would be a great person for you to meet.", "IBM has a program for exactly that.", "YC is a good fit for this.", "Honestly, AJ would be a great person for you to meet.", "You should meet AJ.", "I know someone who knows JT really well.", "For this, YC is a good fit."]) {
  check(`an all-caps name is checked, held unbacked: ${l}`, G.spokenProblem(l, src)?.kind === "name", G.spokenProblem(l, src));
}
for (const jobClaims of [false, true]) {
  const r = await turn("AJ would be a great person for you to meet.", { jobClaims });
  check(`...and never reaches the voice (${jobClaims ? "gpt-live" : "elevenlabs"})`, !said(r, "AJ"), r);
}
check("the same names pass when they said them", G.spokenProblem("AJ would be a great person for you to meet.", P.callSources(body("My friend AJ runs a voice studio.") as any, "", "")) === null && G.spokenProblem("YC is a good fit for this.", P.callSources(body("I'm thinking about applying to YC.") as any, "", "")) === null);
check("a proper name in an observation is still checked (the 10-08 rule): 'Brightline Studio'", G.spokenProblem("Brightline Studio does a lot of voice work.", src)?.kind === "name");

// ---- offers that need a way to carry them out (the gap): held without one, said with one
{
  const GAP = ["I'll book that.", "I'll reserve a table for you.", "You'll have three intros by next week."];
  check("each is an offer that needs a path", GAP.map((l) => G.offerNeedingPath(l)).join() === "book,book,intro", GAP.map((l) => G.offerNeedingPath(l)));
  check("not one: a question, a negation, ordinary encouragement", ["Want me to book it?", "I can't book it from here.", "You'll have a great time.", "You'll get there.", "You'll have to tell me how it goes."].every((l) => G.offerNeedingPath(l) === null));
  for (const jobClaims of [false, true]) {
    const tag = jobClaims ? "gpt-live" : "elevenlabs";
    const r = await turn("Sure. I'll book that.", { their: "Can you book a table for us at the place?", jobClaims });
    check(`held even when they asked, with no tool that books on the call (${tag})`, !said(r, "book that") && r.dropped.some((d) => /^I'll book that\. \| offer held: /.test(d)), r);
    check(`...and the turn isn't answered with another promise: the retry is told not to offer it later or by text (${tag})`, r.reqs.length === 2 && JSON.stringify(r.reqs[1].system).includes("don't offer or promise it another way (later, by text, after the call)") && !/after the call|by text|I'll/i.test(r.spoken.join(" ").replace(/^Sure\.\s*/, "")), r);
  }
  check("the turn never falls back to the safe line (itself a promise)", !(await turn("I'll reserve a table for you.")).content.includes(G.SAFE_LINE));
  // The retry held too: the last line is never "Got it." (after "can you book it?" that's a yes) and never a promise.
  for (const jobClaims of [false, true]) {
    const tag = jobClaims ? "gpt-live" : "elevenlabs";
    const both = await turn([text("I'll book that."), text("I'll reserve it for you.")], { their: "Can you book it?", jobClaims });
    check(`retry held too: the held-offer line, not "Got it." (${tag})`, both.content.trim() === G.HELD_OFFER_LINE && !both.content.includes(G.HELD_LINE), both);
    const sure = await turn([text("Sure. I'll book that."), text("I'll reserve it for you.")], { their: "Can you book it?", jobClaims });
    check(`after a "Sure." with the booking held and the retry held: the held-offer line follows, so it isn't left as a yes (${tag})`, sure.spoken.join(" ") === `Sure. ${G.HELD_OFFER_LINE}`, sure.spoken);
  }
  const plain = await turn([text("There's a mixer at Foundry Hall on Friday."), text("Maybe the Foundry Hall one.")], { their: "Anything on this week?" });
  check("other held turns keep their line (the event fallback is unchanged)", plain.content.trim() === G.SAFE_LINE, plain.content);
  const S = await import("../../src/services/speakable.js");
  check("the held-offer line is speakable, narrates nothing, and promises nothing", S.speakable(G.HELD_OFFER_LINE) === G.HELD_OFFER_LINE && S.narratesInternalState(G.HELD_OFFER_LINE) === null && G.offerNeedingPath(G.HELD_OFFER_LINE) === null && !G.promisesLaterWork(G.HELD_OFFER_LINE));
  // A tool on the call that books: its own guard holds the member's yes; done this turn, the line is said.
  const booker = (ok: boolean) => ({ defs: [{ name: "bookTable", description: "b", input_schema: { type: "object", properties: {} } }], names: new Set(["bookTable"]), note: "", records: "", carries: (n: string) => (n === "bookTable" ? "book" : null), run: async () => (ok ? { ok: true, booked: true } : { ok: false, error: "They haven't said yes." }) });
  const tool = { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "b1", name: "bookTable" } };
  const toolEnd = [{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 1 }];
  const withPath = await turn([[...text("I'll book that."), tool, ...toolEnd], text("It's done.")], { their: "Yes, book the table.", tools: booker(true), jobClaims: true });
  check("allowed with the path: a tool that books came back done this turn, so 'I'll book that' is said", said(withPath, "I'll book that.") && !withPath.dropped.some((d) => /offer held/.test(d)), withPath);
  const refused = await turn([[...text("I'll book that."), tool, ...toolEnd], text("I couldn't do that one.")], { their: "Maybe book the table?", tools: booker(false), jobClaims: true });
  check("the tool came back not done (no yes): held", !said(refused, "I'll book that.") && refused.dropped.some((d) => /offer held/.test(d)), refused);
  const noRun = await turn("I'll book that.", { their: "Yes, book the table.", tools: booker(true), jobClaims: true });
  check("the tool is on the call but never ran: held", !said(noRun, "I'll book that.") && noRun.dropped.some((d) => /offer held/.test(d)), noRun);
  const wrongKind = await turn([[...text("You'll have three intros by next week."), tool, ...toolEnd], text("Ok.")], { their: "Yes, book the table.", tools: booker(true), jobClaims: true });
  check("a booking tool carries no intro promise", !said(wrongKind, "three intros") && wrongKind.dropped.some((d) => /promises introductions/.test(d)), wrongKind);
}

// ---- 2026-11-07 live call: the member's own words, said back a turn later, were held ("names what nothing backs")
{
  const said1 = "So the Stripe CEO and Ramp connected last week, which is huge for us.";
  const call = (first: string, reply: string, sameQuestion?: any) => ({ model: "co", stream: true, messages: [{ role: "system", content: system }, { role: "assistant", content: "Hey Jordan, it's Cue." }, { role: "user", content: first }, { role: "assistant", content: "That's big." }, { role: "user", content: "Yeah. Anyway, what do I do with it?" }] });
  const REFLECT = "The fact that Stripe's CEO and Ramp connected is your proof point.";
  for (const [their, label] of [[said1, "the Stripe CEO"], ["Stripe's CEO and Ramp connected last week.", "Stripe's CEO"], ["The CEO of Stripe and Ramp connected.", "the CEO of Stripe"], ["stripes ceo and ramp connected", "speech recognition's 'stripes ceo'"]]) {
    const s2 = P.callSources(call(their, REFLECT) as any, "", "");
    check(`their own words said back pass: they said ${label}`, G.spokenProblem(REFLECT, s2) === null, G.spokenProblem(REFLECT, s2));
  }
  const never = P.callSources(call("Ramp's been growing fast.", REFLECT) as any, "", "");
  check("a name they never said is still held (Stripe, when they only said Ramp)", G.spokenProblem(REFLECT, never)?.kind === "name" && G.spokenProblem(REFLECT, never)!.missing.some((m) => /Stripe/.test(m)), G.spokenProblem(REFLECT, never));
  check("...and one with a possessive they never said ('Brex's CEO')", G.spokenProblem("The fact that Brex's CEO and Ramp connected is your proof point.", P.callSources(call(said1, "") as any, "", ""))?.kind === "name");
  // Through the proxy: the whole reply, in one generation, in order (the live turn took 8.3s and came out broken: a hold, then a retry).
  for (const jobClaims of [false, true]) {
    const reqs: any[] = [], spoken: string[] = [], dropped: string[] = [];
    const reply = `${REFLECT} Lead with it in the first minute. What's the one number that shows it?`;
    for await (const _ of P.runCallLlm(call(said1, reply) as any, { stream: (r: any) => { reqs.push(r); return (async function* () { for (const e of text(reply)) yield e as any; })(); }, clean: true, jobClaims, onSpoken: (x: string) => spoken.push(x), onDropped: (x: string, w: string) => dropped.push(`${x} | ${w}`) } as any)) {}
    check(`the reflection reaches the voice whole, in one generation, no hold and no retry (${jobClaims ? "gpt-live" : "elevenlabs"})`, spoken.join(" ") === reply && !dropped.length && reqs.length === 1, { spoken, dropped, reqs: reqs.length });
  }
}

// ---- 2026-11-07 live call: two questions asking for different answers, in one turn
{
  const TWO = "What's the contract you're thinking about with him? Are you two on the same page about it?";
  for (const jobClaims of [false, true]) {
    const tag = jobClaims ? "gpt-live" : "elevenlabs";
    reads.length = 0;
    const r = await turn(TWO, { their: "I'm thinking about a contract with my cofounder.", jobClaims, sameQuestion: judge(false) });
    check(`the read says different answers: the second is held (${tag})`, r.spoken.join(" ") === "What's the contract you're thinking about with him?" && r.dropped.some((d) => /same page.*second question/.test(d)) && reads.length === 1 && reads[0][1] === "Are you two on the same page about it?", { r, reads });
    const nr = await turn(TWO, { their: "I'm thinking about a contract with my cofounder.", jobClaims });
    check(`with no read: still held (${tag})`, !said(nr, "same page"), nr);
  }
}

// ---- edge cases that pass: questions, hypotheticals, observations about the world, "like if you..."
const PASS = [
  "What would you want an investor to feel in the first ten seconds?",
  "If you woke up tomorrow and it just worked, what would be different?",
  "Most LLM apps feel slow on the phone because they wait for the whole answer.",
  "APIs change, but the problem you're solving doesn't.",
  "Like if you had to say it in one line, what would it be?",
  "Voice is harder than text because people interrupt.",
];
for (const l of PASS) {
  check(`passes the spoken check: ${l}`, G.spokenProblem(l, src) === null, G.spokenProblem(l, src));
  check(`not an offer: ${l}`, !G.offersToAct(l));
}
check("offers are offers", ["I can intro you to someone there.", "Want me to book it?", "Let me set that up.", "You'll have three intros by Friday.", "I'll text you what I find."].every((l) => G.offersToAct(l)));

// ---- the one-question rule still holds
{
  const r = await turn("What do you want them to feel? And who's the audience for it?", { sameQuestion: judge(false) });
  check("a different second question is still held", !said(r, "audience") && r.dropped.some((d) => /second question/.test(d)), r);
  const inbound = await turn(`Hey. What's on your mind? ${WOKE}`, { their: "Hey Cue.", sys: `${system}\nThis call: they called you.`, sameQuestion: judge(true) });
  check("a same-answer follow-on on any turn is the turn's question: said", said(inbound, WOKE), inbound);
}
console.log(`offerGuardFalsePositives: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
