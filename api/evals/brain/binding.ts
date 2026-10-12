// Decisions bind (brain/index.ts): one check group per decision type the brain produces on the paths it owns (text replies and
// call briefings), each proving the acting code enforces the effect, not just a log row. Plus: guards veto after the brain, and
// briefing decisions are logged at take time with what the call actually got.
//
//   npx tsx evals/brain/binding.ts
// Model-free: the reply agent's model calls are answered by a fake fetch defined here (it records the system prompt), never the stub.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const B = await import("../../src/brain/index.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { createReplyFacts } = await import("../../src/harness/replyGrounding.js");
const { callSources } = await import("../../src/services/callLlmProxy.js");
const { spokenProblem } = await import("../../src/services/offerGuard.js");
const CB = await import("../../src/services/callBriefing.js");
const pool = (await import("../../src/db/db.js")).default as any;

const quiet = console.log;
const quietErr = console.error;
let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    quiet(`FAIL ${label}`);
  }
};

// ---- a fake model: records each request's system prompt and answers with one plain line (no tool calls)
const systems: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (/api\.anthropic\.com/.test(url)) {
    let body: any = {};
    try { body = JSON.parse(init?.body ?? "{}"); } catch {}
    const sys = Array.isArray(body.system) ? body.system.map((b: any) => b?.text ?? "").join("\n") : String(body.system ?? "");
    systems.push(sys);
    const out = { id: "msg_fake", type: "message", role: "assistant", model: body.model ?? "fake", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as any;

const picture = (o: Partial<Parameters<typeof B.judgeText>[0]> = {}) => ({ userId: "u", read: null, owed: false, safetyConcern: false, clarify: null, turn: null, ...o });
const tools = (decision: any, extra: Record<string, unknown> = {}) => {
  const facts: { kind: string; text: string }[] = [];
  const t = createConversationTools({
    userId: "u", phoneNumber: "+14155550190", resolvedContent: "sounds good", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true,
    sendCoReply: async () => true, decision, lastCoMessage: "Nice, enjoy it.", ackSent: "👍", lastReaction: null,
    facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" }, ...extra,
  } as any);
  return { tools: t.tools as any, facts };
};
// Facts with a steer and a first read on offer, so withdrawing them is visible.
const factsWithMoments = () => {
  const rf = createReplyFacts();
  rf.coldStart = { offered: true, why: "seed", seeds: { seeded: false } as any, instruction: "STEER: ask what they like doing" };
  rf.door = { offered: true, why: "first", instruction: "FIRST READ: tell them what you see" };
  rf.instructions.push("STEER: ask what they like doing", "FIRST READ: tell them what you see");
  return rf;
};
const replyInput = (decision: any, o: Record<string, unknown> = {}) => ({
  userId: "u", phoneNumber: "+14155550190", firstName: "Jordan", resolvedContent: "I had a rough week honestly", isVoice: false, imageForVision: null,
  hasPendingOffer: false, recentOfferBurstActive: false, callAction: "would_benefit", isThinProfileFirstMessage: false, isFirstContact: false,
  missingTopic: null, missingTopicDescription: null, facts: factsWithMoments(), toneContext: "", seekingModeContext: "", styleHint: "",
  recentConversation: "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true, isTeam: false, decision, ...o,
}) as any;
const CALL_OFFERED = /Then offer a call as a warm gesture/;
const CALL_WITHHELD = /A call offer is NOT available this turn/;

console.log = () => {};
console.error = () => {};

// ======== act: the reply runs now and Co keeps its own choice (nothing forced)
{
  const d = B.judgeText(picture());
  check("act: a plain text is judged act with nothing ruled out", d.kind === "act" && d.dontSay.length === 0);
  const { tools: t } = tools(d);
  const r = await t.reactInsteadOfReplying.execute({ reaction: "🥂" }, {});
  check("act: a tapback is Co's own choice (allowed)", r.ok === true);
  systems.length = 0;
  const input = replyInput(d);
  const out = await runConversationReplyAgent(input, { dryRun: true, record: false });
  check("act: the reply is not held (the model ran and a reply went out)", systems.length > 0 && out.sent === true);
  check("act: the call offer stays eligible", systems.some((s) => CALL_OFFERED.test(s)));
  const plain = replyInput(d, { callAction: "none" });
  await runConversationReplyAgent(plain, { dryRun: true, record: false });
  check("act: with no call offer due, the steer and first read are left on offer", plain.facts.coldStart.offered === true && plain.facts.door.offered === true);
}

// ======== act on a safety turn: words, no steer, no first read (the safety lines the brain now carries)
{
  const d = B.judgeText(picture({ safetyConcern: true, owed: true }));
  check("safety: judged act with the safety guard, and a tapback, steer and first read ruled out", d.kind === "act" && d.guards.includes("safety") && ["tapback", "steer", "first_read"].every((w) => B.ruledOut(d, w as any)));
  const { tools: t, facts } = tools(d);
  const r = await t.reactInsteadOfReplying.execute({ reaction: "❤️" }, {});
  check("safety: the tapback is refused with the safety line", r.ok === false && /They may not be safe/.test(r.error) && facts.some((f) => f.kind === "not_done" && /may not be safe/.test(f.text)));
  const l = await t.leaveItAtReaction.execute({}, {});
  check("safety: leaving it at the reaction is refused", l.ok === false);
  const input = replyInput(d, { safetyConcern: true });
  await runConversationReplyAgent(input, { dryRun: true, record: false });
  check("safety: the steer and the first read are withdrawn from what the reply drafts from", !input.facts.coldStart.offered && !input.facts.door.offered && !input.facts.instructions.some((i: string) => /STEER|FIRST READ/.test(i)));
}

// ======== ask: the ask is the reply's one question
{
  const d = B.judgeText(picture({ clarify: "Ask which Friday they mean." }));
  check("ask: a clarifying question is judged ask, with tapback, call offer, steer and first read ruled out", d.kind === "ask" && ["tapback", "call_offer", "steer", "first_read"].every((w) => B.ruledOut(d, w as any)));
  check("ask: the question is in what the reply drafts from", d.instructions.includes("Ask which Friday they mean."));
  const { tools: t } = tools(d);
  const r = await t.reactInsteadOfReplying.execute({ reaction: "👍" }, {});
  check("ask: a tapback is refused (a reaction can't ask)", r.ok === false && /a reaction can't ask it/.test(r.error));
  systems.length = 0;
  const input = replyInput(d);
  await runConversationReplyAgent(input, { dryRun: true, record: false });
  check("ask: the call offer is withheld from the reply, though the turn was eligible", systems.length > 0 && systems.every((s) => !CALL_OFFERED.test(s)) && systems.some((s) => CALL_WITHHELD.test(s)));
  check("ask: the steer and the first read are withdrawn", !input.facts.coldStart.offered && !input.facts.door.offered && !input.facts.instructions.some((i: string) => /STEER|FIRST READ/.test(i)));
  const walkin = B.judgeText(picture({ walkinAsk: "Ask what they're hoping to find here." }));
  check("ask: the walk-in ask binds the same way", walkin.kind === "ask" && !!B.ruledOut(walkin, "call_offer"));
}

// ======== deliver: an owed answer and the list both need words
{
  const owed = B.judgeText(picture({ owed: true }));
  check("deliver: an owed answer is judged deliver, with a tapback ruled out", owed.kind === "deliver" && !!B.ruledOut(owed, "tapback"));
  const { tools: t, facts } = tools(owed);
  const r = await t.reactInsteadOfReplying.execute({ reaction: "👍" }, {});
  check("deliver: the tapback is refused with the owed line", r.ok === false && /still owe them an answer/.test(r.error) && facts.some((f) => f.kind === "not_done" && /still owes them/.test(f.text)));
  const list = B.judgeText(picture({ read: { aboutCo: true, asksForList: true, feedback: [] } as any }));
  check("deliver: 'what can you do' is judged deliver, with the list in what the reply drafts from", list.kind === "deliver" && list.instructions.length === 1 && !!B.ruledOut(list, "tapback"));
  const r2 = await tools(list).tools.reactInsteadOfReplying.execute({ reaction: "👍" }, {});
  check("deliver: a tapback can't answer the list", r2.ok === false && /They asked what you can do/.test(r2.error));
  check("deliver: the call offer stays Co's choice (only an ask rules it out)", !B.ruledOut(owed, "call_offer") && !B.ruledOut(list, "call_offer"));
}

// ======== wait (texts): the send is held, not dropped
{
  const d: any = { ...B.judgeText(picture()), kind: "wait", why: "test hold" };
  systems.length = 0;
  let resumed: null | (() => Promise<void>) = null;
  const sentTexts: string[] = [];
  const input = replyInput(d, { resumeLater: (r: () => Promise<void>) => { resumed = r; }, sendCoReply: async (m: any) => { sentTexts.push(m.message); return true; } });
  const out = await runConversationReplyAgent(input, { dryRun: true, record: false });
  check("wait: nothing is sent and no model runs", out.sent === false && systems.length === 0 && sentTexts.length === 0 && out.move === "quiet");
  check("wait: the reply is requeued on the turn's resume path (never dropped)", typeof resumed === "function");
  if (resumed) await (resumed as () => Promise<void>)();
  check("wait: the requeued turn is answered (it runs as act)", systems.length > 0);
}

// ======== briefings: deliver hands the call its finds; wait hands it none, so the spoken offer guard backs no find
const finds = { available: true as const, lookingFor: "founder rooms", note: "Candidates, not picks.", items: [{ name: "Haunted Agent Night", details: ["Hosted by Heavybit."], link: "https://lu.ma/x", starts: "tomorrow, Tuesday, October 6 at 6:30 PM" }] };
const offer = "There's Haunted Agent Night tomorrow at 6:30 PM, want me to text you the link?";
const spokenAgainst = (findsNow: string) => spokenProblem(offer, callSources({ messages: [{ role: "system", content: `# What Co has found for them\n${findsNow}` }, { role: "user", content: "anything good this week?" }] } as any));
const NOW = new Date("2026-10-06T04:48:00Z");
{
  const d = B.judgeBriefing({ userId: "u", now: NOW, clock: null, finds });
  check("deliver (call): finds on file are judged deliver and handed to the call", d.kind === "deliver" && /Haunted Agent Night/.test(d.briefing.findsNow) && !B.ruledOut(d, "event_offer"));
  check("deliver (call): the spoken offer of a find is backed", spokenAgainst(d.briefing.findsNow) === null);
  const w = B.judgeBriefing({ userId: "u", now: NOW, clock: null, finds: { available: false, reason: "nothing real on file yet" } });
  check("wait (call): nothing on file is judged wait with event_offer ruled out", w.kind === "wait" && !!B.ruledOut(w, "event_offer") && /Don't offer an event/.test(w.briefing.findsNow));
  check("wait (call): an event offered aloud anyway is held by the spoken guard", spokenAgainst(w.briefing.findsNow)?.kind === "event");
  const empty = B.judgeBriefing({ userId: "u", now: NOW, clock: null, finds: { ...finds, items: [] } });
  check("wait (call): an available lookup with no items still says don't offer (the decision, not the lookup, sets the text)", empty.kind === "wait" && /Don't offer an event/.test(empty.briefing.findsNow));
}

// ======== guards veto after the brain, and can't be lifted by it
{
  const held = B.judgeBriefing({ userId: "u", now: NOW, clock: null, finds, vetoes: [{ guard: "safety", why: "a safety hold is on: only care, no offers" }] });
  check("veto: a safety hold turns the brain's deliver into wait, with the safety guard named", held.kind === "wait" && held.guards.includes("safety") && !!B.ruledOut(held, "event_offer"));
  check("veto: the call is handed no finds and the spoken offer is held", !/Haunted Agent Night/.test(held.briefing.findsNow) && /Don't offer an event/.test(held.briefing.findsNow) && spokenAgainst(held.briefing.findsNow)?.kind === "event");
  const loose = await tools(B.judgeText(picture()), { safetyConcern: true }).tools.reactInsteadOfReplying.execute({ reaction: "🥂" }, {});
  check("veto (texts): the safety guard refuses a tapback even when the decision rules none out", loose.ok === false && /They may not be safe/.test(loose.error));
  const again = B.vetoBriefingOffers(held, finds, "privacy", "test");
  check("veto: a veto only ever adds a hold (never back to deliver)", again.kind === "wait" && again.dontSay.filter((r) => r.what === "event_offer").length === 1);
}

// ======== briefing decisions are logged at take time, with what the call actually got
{
  const inserts: any[][] = [];
  const realQuery = pool.query;
  pool.query = async (sql: string, params?: any[]) => {
    if (/INSERT INTO harness_decisions/.test(sql)) inserts.push(params ?? []);
    return { rows: [] };
  };
  CB.prebuildCallBriefing("built-user", Date.now());
  await new Promise((r) => setTimeout(r, 1200));
  check("take time: nothing is logged when the briefing is only built", inserts.filter((p) => p[1] === "brain.briefing").length === 0);
  await CB.takeCallBriefing("built-user", Date.now());
  await new Promise((r) => setTimeout(r, 50));
  const builtRows = inserts.filter((p) => p[1] === "brain.briefing");
  check("take time: one brain.briefing row, from the built briefing", builtRows.length === 1 && JSON.parse(builtRows[0][5]).source === "built");
  inserts.length = 0;
  pool.query = (sql: string, params?: any[]) => {
    if (/INSERT INTO harness_decisions/.test(sql)) { inserts.push(params ?? []); return Promise.resolve({ rows: [] }); }
    return new Promise(() => {});
  };
  CB.prebuildCallBriefing("slow-user", Date.now());
  const b = await CB.takeCallBriefing("slow-user", Date.now());
  await new Promise((r) => setTimeout(r, 50));
  const slowRows = inserts.filter((p) => p[1] === "brain.briefing");
  check("take time: a slow build logs the fallback the call actually got (wait, no offers)", slowRows.length === 1 && JSON.parse(slowRows[0][5]).source === "fallback" && slowRows[0][4] === "wait" && /Don't offer an event/.test(b.findsNow));
  pool.query = realQuery;
}

console.log = quiet;
console.error = quietErr;
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
