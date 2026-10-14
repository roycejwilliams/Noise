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
  // The resume is the next attempt: an empty one says the honest give-up line, never a second "give me a minute".
  let again: null | (() => Promise<void>) = null;
  const live: string[] = [];
  const held = replyInput(d, { resumeLater: (r: () => Promise<void>) => { again = r; }, sendCoReply: async (m: any) => { live.push(m.message); return true; } });
  await runConversationReplyAgent(held, { record: false });
  let second = false;
  held.resumeLater = () => { second = true; };
  if (again) await (again as () => Promise<void>)();
  const { REPLY_GAVE_UP_NOTE, REPLY_DELAYED_NOTE } = await import("../../src/services/turnFailure.js");
  check("wait: an empty resumed reply gets the give-up line and schedules no second resume", live.includes(REPLY_GAVE_UP_NOTE) && !live.includes(REPLY_DELAYED_NOTE) && !second);
  // A turn with no resume path (a replay) can't be held without stranding them: it runs now, as act.
  systems.length = 0;
  const replay = await runConversationReplyAgent(replyInput(d), { dryRun: true, record: false });
  check("wait: with no resume path (a replay) the turn is answered now, not held", systems.length > 0 && replay.sent === true);
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
  const owedLifted = await tools(B.judgeText(picture()), { replyOwed: true }).tools.reactInsteadOfReplying.execute({ reaction: "🥂" }, {});
  const owedLeave = await tools(B.judgeText(picture()), { replyOwed: true }).tools.leaveItAtReaction.execute({}, {});
  check("veto (texts): an owed answer refuses a tapback even when the decision rules none out", owedLifted.ok === false && /still owe them an answer/.test(owedLifted.error) && owedLeave.ok === false);
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
  // The safety hold is read again when the call takes the briefing (a prebuilt one can be minutes old), and fails closed.
  inserts.length = 0;
  pool.query = async (sql: string, params?: any[]) => {
    if (/INSERT INTO harness_decisions/.test(sql)) inserts.push(params ?? []);
    if (/safety_hold_until/.test(sql)) return { rows: [{ "?column?": 1 }] };
    return { rows: [] };
  };
  const taken = await CB.takeCallBriefing("held-user", Date.now());
  await new Promise((r) => setTimeout(r, 50));
  const heldRows = inserts.filter((p) => p[1] === "brain.briefing");
  check("safety hold at take time: no finds, and the log names the safety guard", /Don't offer an event/.test(taken.findsNow) && heldRows.length === 1 && JSON.parse(heldRows[0][5]).guards.includes("safety"));
  pool.query = async () => { throw new Error("db down"); };
  check("safety hold check fails closed: an error means no offers", (await CB.safetyHoldOrUnknown("u")) === true);
  pool.query = realQuery;
}

// ======== calls (cutover 3): each turn's decision binds the call brain's endpoint
{
  const P = await import("../../src/services/callLlmProxy.js");
  const say = (t: string) => [
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
    { type: "content_block_stop", index: 0 },
  ];
  const endCall = [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "e1", name: "end_call" } }, { type: "content_block_stop", index: 0 }];
  const turn = async (sys: string, msgs: [string, string][], script: any[][], tools: any = null) => {
    const decisions: any[] = [], spoken: string[] = [], reqs: any[] = [];
    let n = 0;
    const chunks: any[] = [];
    const body = { messages: [{ role: "system", content: sys }, ...msgs.map(([role, content]) => ({ role, content }))], tools: [{ type: "function", function: { name: "end_call", parameters: {} } }] };
    for await (const c of P.runCallLlm(body as any, { stream: (r: any) => { reqs.push(r); const ev = script[Math.min(n++, script.length - 1)]; return (async function* () { for (const e of ev) yield e; })(); }, onSpoken: (x: string) => spoken.push(x), onDecision: (d: any) => decisions.push(d), tools })) chunks.push(c);
    const ended = chunks.some((c) => (c.choices[0].delta.tool_calls ?? []).some((t: any) => t.function?.name === "end_call"));
    return { d: decisions[0], spoken, reqs, ended };
  };
  const OUT = "This call is outbound: you called them.";
  const act = await turn(OUT, [["assistant", "Hey, it's Co."], ["user", "The dinner is next week."]], [say("Next week works. Which night? And how many people?")]);
  check("call act: one question a turn is ruled out past the first, and the second isn't spoken", act.d?.kind === "act" && !!B.ruledOut(act.d, "second_question") && act.spoken.join(" ") === "Next week works. Which night?");
  const ask = await turn("This call is inbound: they called you.", [["assistant", "Hey, it's Co."], ["user", "Hey, just catching up."]], [say("Good to hear from you. What's on your mind? I also found a dinner spot.")]);
  check("call ask: an inbound first reply is judged ask and ends at its question (they lead)", ask.d?.kind === "ask" && !!B.ruledOut(ask.d, "after_question") && !/dinner spot/.test(ask.spoken.join(" ")));
  const safe = await turn(OUT, [["assistant", "Hey, it's Co."], ["user", "I don't feel safe right now."]], [say("I'm here. Are you safe right now? Is someone with you?")]);
  check("call act on a safety call: no question limit (both questions spoken)", safe.d?.guards.includes("safety") && !B.ruledOut(safe.d, "second_question") && /Is someone with you\?/.test(safe.spoken.join(" ")));
  const held = await turn(OUT, [["assistant", "Hey, it's Co."], ["user", "Yeah the dinner is next week."]], [endCall, say("Next week works.")]);
  check("call: end_call is ruled out before they close, and the call isn't ended", !!B.ruledOut(held.d, "end_call") && !held.ended);
  const bye = await turn(OUT, [["assistant", "Talk soon."], ["user", "Ok, bye!"]], [endCall]);
  check("call: after their goodbye end_call isn't ruled out, and the call ends", !B.ruledOut(bye.d, "end_call") && bye.ended);
  const drained = await turn(OUT, [["assistant", "Hey, it's Co."], ["user", "Honestly I'm exhausted, rough week."]], [say("That sounds heavy.")], { defs: [], names: new Set(), note: "TOOLS GUIDE", run: async () => ({ ok: true }), turnFacts: { turnWords: "Honestly I'm exhausted, rough week.", tasks: [], avoid: ["crypto events"], canWriteTasks: false } });
  const sys = drained.reqs[0].system.map((x: any) => x.text).join("\n");
  const last = drained.reqs[0].messages[drained.reqs[0].messages.length - 1].content.map((c: any) => c.text).join("\n");
  check("call: the turn's notes come from the decision (the drained note and tools guide in the system, the stop list after their words)", /# This turn: they told you how they are/.test(sys) && /TOOLS GUIDE/.test(sys) && /never to suggest "crypto events"/.test(last) && !/crypto events/.test(sys) && drained.d.turnNote === B.avoidNote(["crypto events"]));
}

// ======== outgoing drafts (cutover 4): the dispatch acts only on the brain's decision
{
  const urgent = B.judgeDailyPick({ urgent: { id: "9", why: "expires before the next slot" }, chosen: { id: "3", why: "Co's pick", source: "co" }, noneHoldHours: 6 });
  check("draft deliver: a find that would miss its slot is delivered ahead of Co's pick", urgent.kind === "deliver" && urgent.pick === "9" && urgent.source === "code" && B.sends(urgent, "9") && !B.sends(urgent, "3"));
  const none = B.judgeDailyPick({ urgent: null, chosen: { id: null, why: "nothing eligible", source: "code" }, noneHoldHours: 6 });
  check("draft wait: Co picking nothing holds the day (6h) and sends nothing", none.kind === "wait" && none.holdHours === 6 && none.why === "pick: none (nothing eligible)" && !B.sends(none, "3"));
  const co = B.judgeDailyPick({ urgent: null, chosen: { id: "3", why: "Co's pick of 2: fits", source: "co" }, noneHoldHours: 6 });
  const last = B.lastDayVeto(co, { id: "7", why: "its last day is today" });
  check("draft guard: a find on its last day goes first after the brain (re-pointed, still deliver)", last.kind === "deliver" && last.pick === "7" && last.source === "code" && B.sends(last, "7") && !B.sends(last, "3"));
  check("draft guard: the last-day rule never makes a hold send", B.lastDayVeto(none, { id: "7", why: "x" }).kind === "wait");
  const unanswered = B.afterRelevance(co, null, 2);
  check("draft wait: an unanswered re-read holds it (2h), no drop, nothing sent", unanswered.kind === "wait" && unanswered.holdHours === 2 && !unanswered.drop && !B.sends(unanswered, "3"));
  const stale = B.afterRelevance(co, { relevant: false, why: "they already went" }, 2);
  check("draft wait + drop: a stale answer leaves the queue silently", stale.kind === "wait" && stale.drop === "stale: they already went" && !B.sends(stale, "3"));
  check("draft: a relevant answer stays deliver", B.afterRelevance(co, { relevant: true, why: "" }, 2).kind === "deliver");
  const at = new Date("2026-10-12T20:00:00Z");
  const live = B.afterComposeWait(co, "they're mid-conversation", at);
  check("draft wait: a live conversation makes the bundle wait until the hour", live.kind === "wait" && live.until === at && !B.sends(live, "3"));
  const task = B.afterPayloadFirst(co, { handedTo: "41", why: "Co can just do it" });
  check("draft act: payload first hands the work to a task and sends no question", task.kind === "act" && task.task === "41" && !B.sends(task, "3"));
  const held = B.afterPayloadFirst(co, { hold: "theirs to decide" });
  check("draft drop: a question that shouldn't be asked leaves the queue", held.kind === "wait" && held.drop === "payload first: theirs to decide" && !B.sends(held, "3"));
  check("draft: a later stage never revives a wait", B.afterPayloadFirst(none, null).kind === "wait" && B.afterRelevance(none, { relevant: true, why: "" }, 2).kind === "wait");
  const { readFileSync } = await import("node:fs");
  const ps = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
  const gateAt = ps.indexOf("if (!sends(decision, c.id)) {");
  check("draft binding: the send is reached only past the decision's check", gateAt > 0 && ps.indexOf("result = await sendWithLedger(", gateAt) > gateAt && ps.indexOf("result = await sendWithLedger(") > gateAt);

  // Companion check-ins: what it's about and whether it may carry anything
  const P = await import("../../src/harness/proactive.js");
  const C = await import("../../src/agent/companionCheckin.js");
  const ask = (o: any) => B.judgeCheckin({ heavy: false, advice: false, story: false, thread: false, curious: false, item: false, ...o });
  check("check-in ask: the most pressing basis wins (heavy, advice, story, thread, curious, recap)", ask({ heavy: true, thread: true }).basis === "heavy" && ask({ advice: true, story: true }).basis === "advice" && ask({ story: true, thread: true }).basis === "story" && ask({ thread: true, curious: true }).basis === "thread" && ask({ curious: true }).basis === "curious" && ask({}).basis === "recap" && ask({}).kind === "ask");
  check("check-in: only a thread with one thing found may offer", !B.ruledOut(ask({ thread: true, item: true }), "offer") && !!B.ruledOut(ask({ thread: true }), "offer") && !!B.ruledOut(ask({ heavy: true, item: true }), "offer"));
  P.setProactiveModelForTests(async () => "How did the pitch sit overnight? This might help: https://example.com/x");
  const heavy = await C.draftCompanionCheckin("Jordan", "", { text: "the pitch", quote: "", dueDate: null, feeling: null }, { kind: "web", name: "X", url: "https://example.com/x", reason: "r" }, null, null, null, { about: "a hard pitch", quote: null, emotion: "low", when: "yesterday" });
  check("check-in binding: a heavy check-in that slipped a link in is refused by its own checks", !!heavy && heavy.rules.allowUrl === false && P.checkDraft(heavy.text, heavy.rules).some((c) => !c.pass));
  const thread = await C.draftCompanionCheckin("Jordan", "", { text: "the pitch", quote: "", dueDate: null, feeling: null }, { kind: "web", name: "X", url: "https://example.com/x", reason: "r" });
  check("check-in: a thread with its one find keeps its link", !!thread && thread.rules.allowUrl === true && (thread.rules.mustIncludeAny ?? []).includes("https://example.com/x"));
  P.setProactiveModelForTests(null);

  // Sweep picks: what each guarded verdict does to the queue
  const S = await import("../../src/services/sweepShadow.js");
  const m = (name: string) => ({ askId: "a1", askText: "x", fromProfile: false, match: { name } });
  const k = (n: string) => S.shadowKey(n, null);
  const plan = S.planPicks(
    [{ key: k("Send me"), verdict: "send", why: "fits", name: "Send me" }, { key: k("Hold me"), verdict: "hold", why: "later", name: "Hold me" }, { key: k("Drop me"), verdict: "reject", why: "not them", name: "Drop me" }, { key: k("Unseen"), verdict: "no_verdict", why: "", name: "Unseen" }] as any,
    [m("Send me"), m("Hold me")],
    [{ id: "h", key: k("Hold me") }, { id: "d", key: k("Drop me") }, { id: "u", key: k("Unseen") }],
  );
  check("sweep: deliver queues, a drop comes out, a wait goes back, a never-judged find is left alone", B.judgeSweepItem({ key: "x", verdict: "send" }).kind === "deliver" && plan.queue.map((q: any) => q.match.name).join() === "Send me" && plan.reject.map((r) => r.id).join() === "d" && plan.unqueue.map((r) => r.id).join() === "h");
}

// ======== a dry-run dispatch writes nothing, on every path it can take (and still reaches the brain's decision)
{
  // A fixed daytime clock (a Tuesday, 11am Pacific): the dispatch keeps quiet hours, so a run after 8pm Pacific never reached the
  // brain's decision and every case failed at night (found 2026-10-13, when layer 1 became a required check).
  const RealDate = Date;
  const FIXED = new RealDate("2026-10-13T18:00:00Z").getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(FIXED); }
    static now() { return FIXED; }
  } as DateConstructor;
  const P = await import("../../src/harness/proactive.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const realQuery = pool.query;
  const writes: string[] = [];
  const cand = (id: string, key: string) => ({ id, user_id: "dry-u", type: "companion", target_key: key, topic_key: key, summary: `check-in ${key}`, priority: 50, due_at: new Date(Date.now() - 60_000), expires_at: null, payload: { recap: "Noor is launching the beta of a budgeting app this Friday." }, attempts: 0, created_at: new Date(Date.now() - 3_600_000) });
  let candidates: any[] = [];
  pool.query = async (sql: string) => {
    const q = String(sql).trim();
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q) || /\bINSERT INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE FROM\b/i.test(q)) { writes.push(q.slice(0, 80)); return { rows: [], rowCount: 0 }; }
    if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Noor", phone_number: "+14155550199", sms_opted_out: false, city: "Honolulu" }] };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/i.test(q)) return { rows: candidates };
    return { rows: [], rowCount: 0 };
  };
  const dry: { path: string; text: () => Promise<string> }[] = [
    { path: "a draft that goes (would send)", text: async () => "How are things going with the app these days?" },
    { path: "the model chose SKIP", text: async () => "SKIP" },
    { path: "a draft error", text: async () => { throw new Error("boom"); } },
    { path: "a draft that fails its checks twice", text: async () => "Hey Noor! ".repeat(80) },
  ];
  for (const d of dry) {
    for (const cands of [[cand("1", "companion:a")], [cand("1", "companion:a"), cand("2", "companion:b")]]) {
      candidates = cands;
      writes.length = 0;
      const printed: string[] = [];
      const log = console.log;
      console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
      P.setProactiveModelForTests(d.text as any);
      await P.dispatchForUser(proactiveRegistry, "dry-u", { dryRun: true, ignorePacing: true }).catch((e: any) => printed.push(`THREW ${e?.message}`));
      P.setProactiveModelForTests(null);
      console.log = log;
      const reached = printed.some((l) => /\[dispatch dryRun\] brain: /.test(l)) && (!/would send/.test(d.path) || printed.some((l) => /\[dispatch dryRun\] would send/.test(l)));
      check(`dry run writes nothing: ${d.path} (${cands.length} candidate${cands.length > 1 ? "s" : ""})${writes.length ? `: ${writes.join(" | ")}` : ""}`, writes.length === 0 && reached && !printed.some((l) => l.startsWith("THREW")));
    }
  }
  pool.query = realQuery;
  globalThis.Date = RealDate;
}

console.log = quiet;
console.error = quietErr;
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
