// Reply check: a cut on a sharing turn never leaves a flat stub (Royce, 2026-10-28). Layer 1: every model call is scripted here.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/shareCut.ts
// The incident: "Cool, I'm just getting back from my birthday/vacation. I'm honestly feeling hopeful and recharged". The draft's
// closing line invented "the gym today"; the check rightly cut it, and "That's a good place to come back from." went out alone.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const G = await import("../../src/harness/replyGrounding.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };

const MESSAGE = "Cool, I'm just getting back from my birthday/vacation. I'm honestly feeling hopeful and recharged";
const STUB = "That's a good place to come back from.";
const GYM = "Hope the gym today was a nice bridge back into it too.";
const DRAFT = `${STUB} ${GYM}`;
const GYM_FAIL = { name: "claim_member_life", pass: false, reason: `member_life: "${GYM}" (cited support not found)` };

// ---- 1. When the share rewrite is asked (pure) ----
check("birthday turn: the cut stub on a sharing turn asks for the rewrite", G.shareCutStub({ moment: "sharing", draft: DRAFT, cut: STUB, message: MESSAGE }));
check("feedback turns count too", G.shareCutStub({ moment: "feedback", draft: DRAFT, cut: STUB, message: MESSAGE }));
check("not on an asking turn", !G.shareCutStub({ moment: "asking", draft: DRAFT, cut: STUB, message: MESSAGE }));
check("not with no moment read (the golden cases, a failed read)", !G.shareCutStub({ moment: null, draft: DRAFT, cut: STUB, message: MESSAGE }));
check("not when nothing was cut", !G.shareCutStub({ moment: "sharing", draft: STUB, cut: STUB, message: MESSAGE }));
check("not when the cut took a small part of a long reply", !G.shareCutStub({ moment: "sharing", draft: `${STUB} Birthdays that double as a reset are the best kind, and coming back with energy instead of dread is rare. ${GYM}`, cut: `${STUB} Birthdays that double as a reset are the best kind, and coming back with energy instead of dread is rare.`, message: MESSAGE }));
check("not when a question to them survived", !G.shareCutStub({ moment: "sharing", draft: `What made this one land? ${GYM}`, cut: "What made this one land?", message: MESSAGE }));
// Royce 2026-10-28, "respect when the moment is complete": a short warm line that fits them is a whole reply, not a broken one.
const FITTING = "Glad you're back hopeful and recharged.";
check("a fitting short warm line (it carries what they said) is never taken for a stub", !G.shareCutStub({ moment: "sharing", draft: `${FITTING} ${GYM}`, cut: FITTING, message: MESSAGE }));
check("their everyday words don't count as engaging ('honestly', 'getting')", !G.echoesThem("Honestly, getting there.", MESSAGE) && G.echoesThem("A birthday trip, nice.", MESSAGE));
check("the removed claim's words are read from the failed check", G.removedClaims([GYM_FAIL])[0] === GYM);

// ---- 2. The bounded repair (repairShareCut), with its calls injected ----
type Calls = { write: number; recheck: number };
const deps = (answer: string | (() => never), recheckFails: (rw: string) => string[] = () => [], calls: Calls = { write: 0, recheck: 0 }) => ({
  calls,
  d: {
    write: async () => { calls.write++; if (typeof answer === "function") answer(); return answer as string; },
    recheck: async (rw: string) => { calls.recheck++; const bad = recheckFails(rw); return { checks: bad.length ? bad.map((t) => ({ name: "claim_member_life", pass: false, reason: `member_life: "${t}" (cited support not found)` })) : [{ name: "claim_read", pass: true }], modelOk: true }; },
    codeFails: () => [],
  },
});
const base = { draft: DRAFT, cut: STUB, failed: [GYM_FAIL], message: MESSAGE, allowed: "", offerKeep: false };
const GOOD = "Happy belated birthday. Coming back hopeful is a good sign the trip did its job. What made this one land?";
{
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: GOOD }));
  const r = await G.repairShareCut(base, d);
  check("birthday: the stub gets one rewrite, rechecked, and it goes out", r.how === "rewrite" && r.final === GOOD && calls.write === 1 && calls.recheck === 1);
}
{
  const BAD = "Happy belated birthday. Hope the morning run today eased you back in.";
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: BAD }), (rw) => (/morning run/.test(rw) ? ["Hope the morning run today eased you back in."] : []));
  const r = await G.repairShareCut(base, d);
  check("a rewrite that invents again: its unsupported sentence is cut, the grounded rest goes out, no second rewrite", r.how === "rewrite_trimmed" && r.final === "Happy belated birthday." && calls.write === 1 && calls.recheck === 1);
}
{
  const ALL_BAD = "Hope the morning run today eased you back in.";
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: ALL_BAD }), () => [ALL_BAD]);
  const r = await G.repairShareCut(base, d);
  check("a rewrite that fails the recheck whole: nothing from it goes out (the caller sends the cut), one call, no loop", r.how === "none" && r.final === null && calls.write === 1 && calls.recheck === 1);
}
{
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: `Happy belated birthday. ${GYM}` }));
  const r = await G.repairShareCut(base, d);
  check("a rewrite that says the removed claim again is refused in code, before any recheck", r.how === "none" && calls.recheck === 0);
}
{
  // Royce, 2026-10-28: as many questions as it takes to understand. Whether they're one thread is the model's call; code holds only the
  // questionnaire line.
  const LAND = "Happy belated birthday. What made this one land? Was it the people or the place?";
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: LAND }));
  const r = await G.repairShareCut(base, d);
  check("a continuous follow-up with no shared word passes ('What made this one land? Was it the people or the place?')", r.how === "rewrite" && r.final === LAND && calls.recheck === 1, r.why);
}
{
  const THREE = "Happy belated birthday. Where did you go? Who was there with you? What made it land?";
  const { d } = deps(JSON.stringify({ engages: false, reply: THREE }));
  const r3 = await G.repairShareCut(base, d);
  check("three questions pass", r3.how === "rewrite", r3.why);
}
{
  const FOUR = "Happy belated birthday. Where did you go? Who was there with you? What made it land? Going back next year?";
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: FOUR }));
  const r = await G.repairShareCut(base, d);
  check("four questions in one message is a questionnaire: refused in code", r.how === "none" && /questionnaire/.test(r.why) && calls.recheck === 0, r.why);
  check("…counted as questions, not question marks inside one", G.questionCount("Was it the people? Or the place?") === 2 && G.questionCount("No questions here.") === 0);
}
{
  const { d } = deps(JSON.stringify({ engages: false, reply: "Happy belated birthday. Sounds like you were exhausted before it." }));
  const r = await G.repairShareCut(base, d);
  check("a feeling they didn't name is refused (they said hopeful and recharged, not exhausted)", r.how === "none" && /how they feel/.test(r.why));
}
{
  const { d } = deps(JSON.stringify({ engages: false, reply: "Happy belated birthday. Feeling hopeful after a trip is the best souvenir." }));
  const r = await G.repairShareCut(base, d);
  check("a feeling word they used themselves may come back", r.how === "rewrite");
}
{
  const { d } = deps(JSON.stringify({ engages: false, reply: "Happy belated birthday. Sounds like Tahoe was perfect." }));
  const r = await G.repairShareCut(base, d);
  check("a place they never named is refused in code", r.how === "none" && /tahoe/.test(r.why));
}
{
  const { d, calls } = deps(JSON.stringify({ engages: true, reply: "" }));
  const r = await G.repairShareCut({ ...base, cut: FITTING, offerKeep: true }, d);
  check("when what's left carries their words, the call may decide it already fits: it goes out as is, no recheck", r.how === "kept" && r.final === FITTING && calls.recheck === 0);
}
{
  // Royce, 2026-10-28: live, the call answered {"engages": true} for the stub itself. With none of their words left, that answer isn't taken.
  const { d, calls } = deps(JSON.stringify({ engages: true, reply: "" }));
  const r = await G.repairShareCut(base, d);
  check("none of their words left: an 'it fits' answer isn't taken, the stub is never kept as fitting", r.how === "none" && r.final === null && calls.recheck === 0 && /wasn't on offer/.test(r.why), r);
}
{
  const { d } = deps(JSON.stringify({ engages: true, reply: GOOD }));
  const r = await G.repairShareCut(base, d);
  check("…and a reply that comes back anyway is used, checked like any rewrite", r.how === "rewrite" && r.final === GOOD);
}
{
  const { d, calls } = deps(() => { throw new Error("timeout"); });
  const r = await G.repairShareCut(base, d);
  check("a rewrite call that fails leaves the cut, once", r.how === "none" && calls.write === 1);
}
{
  const { d } = deps("not json");
  check("an answer out of shape leaves the cut", (await G.repairShareCut(base, d)).how === "none");
}

// ---- 3. Through groundReply, with the model calls scripted by what each prompt is for ----
const realFetch = globalThis.fetch;
type Script = { claims: (toSend: string) => unknown[]; rewrite: string };
let script: Script = { claims: () => [], rewrite: "" };
const counts = { claimRead: 0, shareRewrite: 0, otherRedraft: 0, voiceLine: 0 };
let lastShare = "";
let redraftReply: string | null = null;
// The honest line in Cue's own words (replyGrounding.ts honestNoAnswer, services/voiceLine.ts), scripted.
const HONEST = "I don't have a real answer to that one yet.";
let voiceLineReply = HONEST;
let lastRedraftPrompt = "";
const readSends: string[] = [];
const readModels: string[] = [];
const reply = (text: string) => new Response(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  if (!/api\.anthropic\.com/.test(url)) return realFetch(input, init);
  const body = String(init?.body ?? "");
  const prompt = (() => { try { const j = JSON.parse(body); return JSON.stringify(j.messages ?? j); } catch { return body; } })();
  if (prompt.includes("You check a text message Cue is about to send")) {
    counts.claimRead++;
    const toSend = JSON.parse(`"${(prompt.match(/Message Cue is about to send:\\n\\"([\s\S]*?)\\"\\n\\nReturn ONLY JSON/)?.[1] ?? "")}"`);
    readSends.push(toSend);
    try { readModels.push(String(JSON.parse(body).model ?? "")); } catch { readModels.push(""); }
    return reply(JSON.stringify({ claims: script.claims(toSend) }));
  }
  if (prompt.includes("They were telling you something that matters to them")) {
    counts.shareRewrite++;
    lastShare = JSON.parse(prompt)[0]?.content?.[0]?.text ?? prompt;
    // A rewrite call that fails outright (a 400 isn't retried).
    if (script.rewrite === "__throw__") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted failure" } }), { status: 400, headers: { "content-type": "application/json" } });
    return reply(script.rewrite);
  }
  if (prompt.includes("Write one text message from Cue.")) { counts.voiceLine++; return reply(voiceLineReply); }
  if (prompt.includes("write the smallest true reply instead")) { counts.otherRedraft++; lastRedraftPrompt = prompt; return reply(redraftReply ?? "Got it."); }
  if (prompt.includes("Does this line assert anything")) return reply(JSON.stringify({ onlyAdmission: false }));
  return reply("stub");
}) as any;
const gymClaim = (toSend: string) => (toSend.includes("gym") ? [{ text: GYM, type: "member_life", supported: false, factId: null, quote: null }] : []);
const ground = (draft: string, moment: string | null, message = MESSAGE, recentConversation = "") => {
  const rf = G.baseReplyFacts();
  rf.moment = moment;
  return G.groundReply(draft, rf, { message, recentConversation, contextSummary: "", recentMemories: "" }, { record: false });
};
// The same turn twice, one rf (the send tool's empty-after-check contract asks Cue again in the same turn).
const twoPasses = async (draft: string, moment: string | null, message = MESSAGE) => {
  const rf = G.baseReplyFacts();
  rf.moment = moment;
  const src = { message, recentConversation: "", contextSummary: "", recentMemories: "" };
  const first = await G.groundReply(draft, rf, src, { record: false });
  const second = await G.groundReply(draft, rf, src, { record: false });
  return { first, second };
};
const reset = () => { counts.claimRead = 0; counts.shareRewrite = 0; counts.otherRedraft = 0; counts.voiceLine = 0; voiceLineReply = HONEST; lastShare = ""; readSends.length = 0; readModels.length = 0; };

reset();
script = { claims: gymClaim, rewrite: JSON.stringify({ engages: false, reply: GOOD }) };
{
  const r = await ground(DRAFT, "sharing");
  check("replay of the birthday turn: the rewrite goes out, not the stub", r.final === GOOD && r.outcome === "redrafted");
  check("  one rewrite call, the invented gym never goes out", counts.shareRewrite === 1 && !/gym/i.test(r.final));
  check("  the final reply was checked again (the rewrite's claim read or code checks are on the record)", r.checks.some((c) => c.name.startsWith("redraft.")) && r.checks.some((c) => c.name === "share_repair" && /rewrite: rewrite passed/.test(c.reason ?? "")), r.checks.map((c) => `${c.name}:${c.reason}`));
  // Royce, 2026-10-28 (live: the call kept the stub as fitting): with none of their words left, "it fits" isn't offered at all.
  check("  the stub's rewrite call is never offered the 'it fits' answer: it must write the reply", !!lastShare && !/"engages": true/.test(lastShare) && /Write the reply again from their words/.test(lastShare), lastShare.slice(-900));
}
reset();
script = { claims: gymClaim, rewrite: JSON.stringify({ engages: true, reply: "" }) };
{
  const r = await ground(DRAFT, "sharing");
  check("live replay: the call answers 'it fits' for the stub anyway; that isn't taken as keeping it (logged, the cut goes)", r.final === STUB && r.checks.some((c) => c.name === "share_repair" && /wasn't on offer/.test(c.reason ?? "")));
}
reset();
script = { claims: (t) => [...gymClaim(t), ...(t.includes("hike") ? [{ text: "The hike on day two sounds like it reset you.", type: "member_life", supported: false, factId: null, quote: null }] : [])], rewrite: JSON.stringify({ engages: false, reply: "Happy belated birthday. The hike on day two sounds like it reset you." }) };
{
  const r = await ground(DRAFT, "sharing");
  check("a rewrite that invents too: its bad sentence is cut after the recheck, and the grounded part goes out", r.final === "Happy belated birthday." && counts.shareRewrite === 1 && counts.otherRedraft === 0);
}
reset();
script = { claims: (t) => (t.includes("hike") || t.includes("gym") ? [{ text: t.includes("hike") ? "Sounds like the hike today reset you." : GYM, type: "member_life", supported: false, factId: null, quote: null }] : []), rewrite: JSON.stringify({ engages: false, reply: "Sounds like the hike today reset you." }) };
{
  const r = await ground(DRAFT, "sharing");
  check("a rewrite that fails whole: the cut goes out, one rewrite only, never the old redraft as a second try", r.final === STUB && r.outcome === "cut" && counts.shareRewrite === 1 && counts.otherRedraft === 0);
}
reset();
script = { claims: gymClaim, rewrite: JSON.stringify({ engages: false, reply: GOOD }) };
{
  const r = await ground(DRAFT, "asking");
  check("an asking turn keeps today's behavior: the cut goes out, no rewrite call", r.final === STUB && r.outcome === "cut" && counts.shareRewrite === 0);
}
reset();
{
  const r = await ground(`${FITTING} ${GYM}`, "sharing");
  check("a fitting short warm line left by the cut goes out as is, no rewrite call", r.final === FITTING && r.outcome === "cut" && counts.shareRewrite === 0);
}
reset();
script = { claims: gymClaim, rewrite: "" };
{
  // The whole draft was the invented line: too little left. The share rewrite is the one rewrite; here it comes back empty.
  // Final review of #310: nothing carried and nothing has answered them yet, so the first pass returns empty, once a turn, and the send
  // tool has Cue say it again plainly (Royce, 2026-10-17: a redraft, never the fallback line). No fixed warm line, ever.
  const { first, second } = await twoPasses(GYM, "sharing");
  const r = first;
  check("…nothing carried and nothing had answered them: the first pass is empty (Cue says it again), never a fallback line, not 'not sure'", first.final === "" && !first.notSure && !("SHARE_FALLBACK" in G), first);
  check("…a second fully cut pass in the same turn ends on the honest line in Cue's own words (no loop)", second.final === HONEST && counts.voiceLine === 1 && !/glad you told me/i.test(second.final), second.final);
  check("cut to nothing on a sharing turn: each pass makes only the one share rewrite, never the old redraft as well", counts.shareRewrite === 2 && counts.otherRedraft === 0 && !/gym/i.test(r.final) && !/gym/i.test(second.final));
}
reset();
script = { claims: gymClaim, rewrite: JSON.stringify({ engages: false, reply: GOOD }) };
{
  const r = await ground(GYM, "sharing");
  check("cut to nothing on a sharing turn, good rewrite: it goes out", r.final === GOOD && r.outcome === "redrafted" && counts.shareRewrite === 1);
}


{
  const P = G.shareRewritePrompt({ facts: "", tail: "", theirWords: "", message: MESSAGE, draft: DRAFT, removed: [GYM], cut: STUB, offerKeep: false });
  check("the rewrite prompt: questions follow one thread, no one-question cap", /questions that follow one thread when there's something worth understanding; never unrelated ones, never one they've already answered/.test(P) && !/Never more than one question/.test(P));
  check("the rewrite prompt: don't repeat their words back", /don't repeat their words back to them/.test(P));
  check("the rewrite prompt offers 'it fits' only when asked to", /"engages": true/.test(G.shareRewritePrompt({ facts: "", tail: "", theirWords: "", message: MESSAGE, draft: DRAFT, removed: [GYM], cut: FITTING, offerKeep: true })) && !/"engages": true/.test(P));
}

// ---- 3a. The share rewrite's changed sentences are always read (review of #310: invented details nothing claim-shaped points at) ----
for (const invented of ["A trip with your sister is a good reset.", "That river run clearly did you good.", "Back from the coast with that energy is rare."]) {
  reset();
  script = { claims: (t) => [...gymClaim(t), ...(t.includes(invented) ? [{ text: invented, type: "member_life", supported: false, factId: null, quote: null }] : [])], rewrite: JSON.stringify({ engages: false, reply: invented }) };
  const r = await ground(DRAFT, "sharing");
  const i = readSends.findIndex((t) => t.includes(invented));
  check(`a rewrite's invented "${invented}" is read for claims (forced, on Haiku) and never goes out`, i >= 0 && /haiku/i.test(readModels[i] ?? "") && !r.final.includes(invented) && counts.shareRewrite === 1, { final: r.final, readSends, readModels });
}
check("the forced read of claim-free changes is Haiku", /haiku/i.test(G.SHARE_RECHECK_MODEL));
// Re-review of #310: a claim-shaped rewrite keeps the full read (Sonnet); only claim-free changes go to Haiku.
check("recheck model: claim-free changes on the forced path, Haiku", G.recheckModel("A trip with your sister is a good reset.", { force: true, model: G.SHARE_RECHECK_MODEL }) === G.SHARE_RECHECK_MODEL);
check("…claim-shaped changes, the full read (not Haiku)", G.recheckModel("Glad the dinner on Friday at 8 went well.", { force: true, model: G.SHARE_RECHECK_MODEL }) !== G.SHARE_RECHECK_MODEL && !/haiku/i.test(G.recheckModel("Glad the dinner on Friday at 8 went well.", { force: true, model: G.SHARE_RECHECK_MODEL })));
check("…and an unforced recheck is unchanged", !/haiku/i.test(G.recheckModel("anything")));
reset();
{
  const CLAIMY = "Happy belated birthday. Hope the dinner on Friday at 8 was a good one.";
  script = { claims: (t) => [...gymClaim(t), ...(t.includes("Friday") ? [{ text: "Hope the dinner on Friday at 8 was a good one.", type: "member_life", supported: false, factId: null, quote: null }] : [])], rewrite: JSON.stringify({ engages: false, reply: CLAIMY }) };
  const r = await ground(DRAFT, "sharing");
  const i = readSends.findIndex((t) => t.includes("Friday"));
  check("through groundReply: a claim-shaped rewrite is read on the full model, and its invented dinner never goes out", i >= 0 && !/haiku/i.test(readModels[i] ?? "") && !/Friday/.test(r.final), { readModels, final: r.final });
}
{
  // M4 (re-review of #310): the forced read not coming back fails the rewrite, even a claim-free one.
  const CLAIM_FREE = "Happy belated birthday. Coming back like that is the best kind of souvenir.";
  const calls = { write: 0, recheck: 0 };
  const r = await G.repairShareCut(base, { write: async () => (calls.write++, JSON.stringify({ engages: false, reply: CLAIM_FREE })), recheck: async () => (calls.recheck++, { checks: [], modelOk: false }), codeFails: () => [] });
  check("if the forced read fails, the rewrite fails (claim-free or not)", r.how === "none" && r.final === null && calls.recheck === 1, r);
}

// ---- 3c. A feedback turn: owning what Cue sent, and offering to fix that one thing (2026-10-28 live check, Inez) ----
const INEZ = "That link you sent goes to a page saying the event was cancelled. Kind of annoying";
const INEZ_THREAD = "User said: any good small music nights this week?\nCo replied: This one looks like your speed. https://lu.ma/smallmusic";
const OWN_TEXT = "that link shouldn't have gone out dead";
const SENT_LINE = "https://lu.ma/smallmusic";
const OWN = { text: OWN_TEXT, type: "past_action" as const, supported: true, factId: null, quote: SENT_LINE };
// The ownership read's answer (its own read, re-review of #310), lenient: it says yes to everything it's asked.
const OWNS = (texts: string[]) => new Map(texts.map((t) => [t, true] as [string, boolean]));
const fb = G.baseReplyFacts();
fb.moment = "feedback";
const inezSrc = { message: INEZ, recentConversation: INEZ_THREAD };
check("feedback: owning the dead link passes, backed by Cue's own sent line and its own ownership read", G.claimChecks([OWN], fb, inezSrc, new Map(), OWNS([OWN_TEXT])).every((c) => c.pass));
check("…never by their report alone, even with a lenient read", G.claimChecks([{ ...OWN, quote: "That link you sent goes to a page saying the event was cancelled" }], fb, inezSrc, new Map(), OWNS([OWN_TEXT])).some((c) => !c.pass));
check("…never when the ownership read says no", G.claimChecks([OWN], fb, inezSrc, new Map(), new Map()).some((c) => !c.pass));
const sh = G.baseReplyFacts();
sh.moment = "sharing";
check("…only on a feedback turn: elsewhere a past action still needs a fact", G.claimChecks([OWN], sh, inezSrc, new Map(), OWNS([OWN_TEXT])).some((c) => !c.pass));
check("…and a quote that isn't in Cue's sent lines backs nothing", G.claimChecks([{ ...OWN, quote: "Cue sent the wrong link on purpose" }], fb, inezSrc, new Map(), OWNS([OWN_TEXT])).some((c) => !c.pass));
{
  // Review of #310's two probes.
  const NOPA = "Wait, did you book the table at Nopa for 8? They have nothing under my name.";
  const booked = { text: "I booked the table at Nopa for 8", type: "past_action" as const, supported: true, factId: null, quote: "did you book the table at Nopa for 8" };
  check("probe 1: their question about a booking never backs Cue saying it booked it", G.claimChecks([booked], fb, { message: NOPA, recentConversation: "" }, new Map(), OWNS([booked.text])).some((c) => !c.pass));
  const CONFAB = "User said: can you get us a table Friday?\nCo replied: Done, I've booked Nopa for 8 on Friday";
  const repeat = { ...booked, quote: "Done, I've booked Nopa for 8 on Friday" };
  check("probe 2: an earlier confabulated 'Done, I've booked Nopa' never backs saying it again", G.claimChecks([repeat], fb, { message: NOPA, recentConversation: CONFAB }, new Map(), new Map()).some((c) => !c.pass));
  // Re-review of #310: lines that assume an action pass nothing, on any moment with an empty thread, even with a lenient ownership read.
  const ASSUMES = ["I booked it, sorry it didn't show up under your name", "Sorry, I booked Nopa for 8 and it didn't stick", "That's on me, the Nopa booking I made should have been under your name"];
  // Scope: these run the ownership path (ownsWhatItSent), with the general admission read saying no. The general admission shortcut is
  // tested just below: it trusts that read, so there the guard is the restored co-test prompt, not code.
  for (const line of ASSUMES) for (const moment of ["feedback", "sharing", "asking"]) {
    const rf = G.baseReplyFacts();
    rf.moment = moment;
    const claim = { text: line, type: "past_action" as const, supported: true, factId: null, quote: line };
    check(`ownership path: "${line}" (${moment}, empty thread) fails, even with a lenient ownership read`, G.claimChecks([claim], rf, { message: NOPA, recentConversation: "" }, new Map(), OWNS([line])).some((c) => !c.pass));
  }
  // Known limit (PR Known limits), against co-test after #303: the general admission shortcut passes a line the admission read calls an
  // admission (MAY_ADMIT lines go to that read in admissionsFor) when nothing done is on record and no failure of Cue's own is in view, or
  // when the claim read marked it supported. In those cases the guard for these lines is the admission prompt (co-test's, which also says
  // flagged/reported/passed-on is an action) and the claim read, not code.
  const { FAILURE_FACT_PREFIX } = await import("../../src/services/turnFailure.js");
  const viaShortcut = (o: { supported: boolean; base: boolean; failure?: boolean }) => ASSUMES.map((line) => {
    const rf = o.base ? G.baseReplyFacts() : G.createReplyFacts();
    if (o.failure) G.addFact(rf, "known", `${FAILURE_FACT_PREFIX} the booking request didn't go through.`);
    return G.claimChecks([{ text: line, type: "past_action", supported: o.supported, factId: null, quote: line }], rf, { message: NOPA, recentConversation: "" }, new Map([[line, true]])).every((c) => c.pass);
  });
  check("known limit, documented: nothing on record and no failure in view, a lenient admission read lets the shortcut pass all three, even unsupported", viaShortcut({ supported: false, base: false }).every(Boolean));
  check("…or anywhere the claim read marks them supported; the guard there is co-test's admission prompt and the claim read", viaShortcut({ supported: true, base: true }).every(Boolean) && /or owning a mistake \("that's on me", "sorry", "you're right"\)\?/.test(G.admissionPrompt("x")) && /flagged, reported, logged or passed on/.test(G.admissionPrompt("x")) && !/something Cue sent|gone out dead/.test(G.admissionPrompt("x")));
  check("…unsupported with something on record, or with a failure of Cue's own in view, all three fail", viaShortcut({ supported: false, base: true }).every((ok) => !ok) && viaShortcut({ supported: false, base: false, failure: true }).every((ok) => !ok));
  const asked: string[] = [];
  const lenient = async (prompt: string) => (asked.push(prompt), JSON.stringify({ onlyOwns: true }));
  const owns = await G.ownershipReadsFor(ASSUMES.map((t) => ({ text: t, type: "past_action" as const, supported: true, factId: null, quote: t })), fb, { recentConversation: "" }, lenient);
  check("the ownership read never runs without Cue's own sent line in the thread", asked.length === 0 && owns.size === 0);
  const ownsLink = await G.ownershipReadsFor([OWN], fb, inezSrc, lenient);
  check("…and with it, it reads the line against that sent line", asked.length === 1 && asked[0].includes(SENT_LINE) && asked[0].includes(OWN_TEXT) && ownsLink.get(OWN_TEXT) === true);
  asked.length = 0;
  await G.ownershipReadsFor([OWN], sh, inezSrc, lenient);
  check("…and only on a feedback turn", asked.length === 0);
  // The checks after ownership still run: a receipt that says it didn't happen still fails an owned line citing it.
  const rf = G.baseReplyFacts();
  rf.moment = "feedback";
  G.addFact(rf, "not_done", "Trying to send the link failed: it didn't send.");
  const nd = rf.facts[rf.facts.length - 1].id;
  check("the checks after ownership still run (a not-done receipt cited still fails)", G.claimChecks([{ ...OWN, factId: nd }], rf, inezSrc, new Map(), OWNS([OWN_TEXT])).some((c) => !c.pass && /did NOT happen/.test(c.reason ?? "")));
}
check("the general admission read is back to its own question (no 'something Cue sent')", /or owning a mistake \("that's on me", "sorry", "you're right"\)\?/.test(G.admissionPrompt("x")) && !/something Cue sent|gone out dead/.test(G.admissionPrompt("x")));
check("the ownership read asks only whether it owns a mistake in that sent thing, asserting no other action", /Does the line only own a mistake in that thing Cue sent, without asserting any other action Cue took/.test(G.ownershipPrompt("x", "y")));
const inezBase = { draft: "That's on me, that link shouldn't have gone out dead. Sorry for the runaround.", cut: "Sorry for the runaround.", removed: [], allowed: "", message: INEZ };
check("feedback: the rewrite may offer to fix the one thing it sent", G.shareRewriteAddsNothing({ ...inezBase, rewrite: "That's on me, that link was dead. Want me to find another one worth going to instead?", feedback: true }).ok);
check("…not on a sharing turn (still a recommendation there)", !G.shareRewriteAddsNothing({ ...inezBase, rewrite: "That's on me, that link was dead. Want me to find another one worth going to instead?" }).ok);
check("…and never an unrelated offer", !G.shareRewriteAddsNothing({ ...inezBase, rewrite: "That's on me, that link was dead. Want me to set up a call this week?", feedback: true }).ok);
check("…and only one fix offer", !G.shareRewriteAddsNothing({ ...inezBase, rewrite: "Want me to find another one worth going to instead? Should I resend the right one?", feedback: true }).ok);
check("the claim read: owning a mistake is backed by Cue's own sent line, never their report", /Owning a mistake in something Cue sent \("that link shouldn't have gone out dead"\) is supported by Cue's own sent line in the conversation: quote that line\. Their report of what Cue did never supports a claim that Cue did it\./.test(fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")));
check("the share rewrite on a feedback turn says it may offer the one fix", /you may offer to fix that one thing/.test(G.shareRewritePrompt({ facts: "", tail: "", theirWords: "", message: INEZ, draft: "x", removed: [], cut: "", offerKeep: false, feedback: true })) && !/you may offer to fix/.test(G.shareRewritePrompt({ facts: "", tail: "", theirWords: "", message: INEZ, draft: "x", removed: [], cut: "", offerKeep: false })));

// ---- 3d. Their thread is theirs to tell: the world line never backs a report of it (re-record of checkin-live-thread) ----
{
  const rf = G.baseReplyFacts();
  const THREAD_FACT = "Waiting to hear back from the Hayes Valley venue about the Nov 14 dinner (said Mon Oct 12)";
  rf.world = { thread: { fact: THREAD_FACT } } as any;
  G.addFact(rf, "known", `Their world right now: Nothing waits on them (not a thing to say). Their thread (theirs to tell: ask, never report): ${THREAD_FACT}.`);
  const id = rf.facts[rf.facts.length - 1].id;
  const src0 = { message: "hey", recentConversation: "" };
  check("a report of where their thread stands, citing the world line, fails", G.claimChecks([{ text: "Still nothing from the venue yet", type: "detail", supported: true, factId: id, quote: THREAD_FACT }], rf, src0).some((c) => !c.pass && /theirs to tell/.test(c.reason ?? "")));
  check("asking about it still passes", G.claimChecks([{ text: "Any word from the Hayes Valley place yet?", type: "followup", supported: true, factId: id, quote: THREAD_FACT }], rf, src0).every((c) => c.pass));
}

reset();
script = { claims: gymClaim, rewrite: "" };
{
  const r = await ground(`Love that. ${GYM}`, "sharing");
  check("a sharing turn cut to a couple of words keeps them over 'not sure' when the rewrite can't be used", r.final === "Love that." && !r.notSure, r.final);
}
reset();
script = { claims: gymClaim, rewrite: "" };
{
  const r = await ground(GYM, "asking");
  check("…an asking turn keeps the ordinary path (unchanged): no share rewrite, the smallest-true-reply redraft", r.final === "Got it." && counts.shareRewrite === 0 && counts.otherRedraft === 1, { final: r.final, counts });
}

// Third review of #310: the sharing fallback never sends a question that only pointed at what was cut, or a single word.
for (const [label, draft] of [["a dangling question", `${GYM} Want me to save that?`], ["one word", `Oh. ${GYM}`], ["one word (an apology)", `Sorry. ${GYM}`]] as const) {
  reset();
  script = { claims: gymClaim, rewrite: "" };
  const r = await ground(draft, "sharing");
  check(`sharing turn with ${label} left: never the fragment; the first pass is empty so Cue says it again`, r.final === "" && !r.notSure && counts.shareRewrite === 1, r.final);
}

// ---- Live re-record of #310, golden whats-ahead: the narration rule cut a supported answer ----
// Never trimmed by code (review of #310: a clause cut from a sentence can change what it means). The cut went too far, so the one redraft
// says that answer again without the machinery talk, rechecked; if it can't be kept, the cut goes, as before.
{
  const AHEAD = "Thursday morning I'll check in on where the branding work landed, that's the one thing on the calendar from my end. Anything else going on this week worth keeping an eye on?";
  const ANSWER = "Thursday morning I'll check in on where the branding work landed";
  const QUESTION = "Anything else going on this week worth keeping an eye on?";
  const factsFor = () => {
    const rf = G.baseReplyFacts();
    G.addFact(rf, "scheduled", "Cue will work on it next around Thu Oct 15, 8:46am PDT: Ask how the branding work went this week.");
    const fid = rf.facts[rf.facts.length - 1].id;
    // The case's open task (golden whats-ahead: task #41), which backs the check-in as a follow-up Cue will do.
    G.addFact(rf, "scheduled", 'Cue is working on task #41 for them: "Weekly branding accountability check-in". Next: Ask how the branding work went this week.');
    return { rf, fid };
  };
  const run = async (redraft: string | null) => {
    const { rf, fid } = factsFor();
    reset();
    redraftReply = redraft;
    script = { claims: (t) => (t.includes("Thursday morning") ? [{ text: ANSWER, type: "future_promise", supported: true, factId: fid, quote: "Cue will work on it next around Thu Oct 15, 8:46am PDT" }] : []), rewrite: "" };
    return G.groundReply(AHEAD, rf, { message: "anything I should look forward to this week?", recentConversation: "", contextSummary: "", recentMemories: "" }, { record: false });
  };
  const fixed = `${ANSWER}. ${QUESTION}`;
  const r = await run(fixed);
  check("whats-ahead replay: the narration cut took a supported answer, so the one redraft says it without the machinery talk, and it goes", r.final === fixed && r.outcome === "redrafted" && counts.otherRedraft === 1, { final: r.final, outcome: r.outcome });
  check("…the redraft is told to say that same answer without the machinery part, keeping its meaning and condition", lastRedraftPrompt.includes("was cut only because it talked about your own side or machinery") && lastRedraftPrompt.includes("keeping its meaning and any condition it had"));
  const failedRedraft = await run(`${ANSWER}, all set from my end. ${QUESTION}`);
  check("…a redraft that still talks machinery isn't kept: the cut goes, as before (one redraft, no loop)", failedRedraft.final === QUESTION && counts.otherRedraft === 1, failedRedraft.final);
  check("narrationCutSupported reads the claim read's verdict, not a pattern", G.narrationCutSupported({ draft: AHEAD, cut: QUESTION, checks: [{ name: "no_internal_narration", pass: false, reason: "x" }, { name: "claim_future_promise", pass: true, reason: `future_promise: "${ANSWER}"` }] }) && !G.narrationCutSupported({ draft: AHEAD, cut: QUESTION, checks: [{ name: "no_internal_narration", pass: false, reason: "x" }] }));
}
// The reviewer's sentences (review of #310): none goes out shortened by code. A narrating sentence is cut whole or, when it carried a
// supported claim, redrafted by the model; code never keeps a clause of it.
{
  const NARR = [{ name: "no_internal_narration", pass: false, reason: "narrates Cue's own machinery" }];
  const MEANING = [
    "I'll text you Thursday, or sooner if anything moves on my end.",
    "The deck is ready for you, I just need to finish it on my end.",
    "Dinner's set for Friday at 8, unless the venue cancels on my end.",
    "Nothing waiting on you right now, all quiet on my end.",
    "Your intro to the Hayes Valley host is out, I'm still waiting on my side.",
  ];
  for (const m of MEANING) {
    const out = G.stripUnsupported(`${m} Talk soon?`, NARR as any).trim();
    const head = m.split(",")[0];
    check(`not shortened by code: "${m.slice(0, 48)}…"`, out === "Talk soon?" && !out.includes(head), out);
  }
  check("no trailing-clause trim is left in the reply check", !fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8").includes("cutTrailingNarration"));
}

// A member who shared something never gets a stock empathy formula, even from the honest line: a stock answer there falls to the fixed
// honest line, which claims nothing.
reset();
script = { claims: gymClaim, rewrite: "" };
voiceLineReply = "I hear you.";
{
  const { second } = await twoPasses(GYM, "sharing");
  check("sharing turn, second pass: a stock honest line is never sent; the fixed honest line instead", second.final !== "I hear you." && second.final === "Honestly, I'm not sure on that one.", second.final);
}
// Final review of #310: "my dad's in the hospital". The draft's only sentence invented a detail; the share rewrite came back empty or the
// call failed. The first pass is empty, not "not sure", so Cue says it again plainly.
for (const [label, rw] of [["comes back empty", ""], ["throws", "__throw__"]] as const) {
  reset();
  const DAD = "Hope the cardiology team at Kaiser is taking good care of him.";
  script = { claims: (t) => (t.includes("cardiology") ? [{ text: DAD, type: "member_life", supported: false, factId: null, quote: null }] : []), rewrite: rw };
  const { first } = await twoPasses(DAD, "sharing", "my dad's in the hospital");
  check(`"my dad's in the hospital", the rewrite ${label}: the first pass is empty and not 'not sure' (Cue says it again)`, first.final === "" && !first.notSure && !/cardiology|Kaiser/.test(first.final), first);
}
// Something already answered them this turn: nothing more goes.
reset();
script = { claims: gymClaim, rewrite: "" };
{
  const rf = G.baseReplyFacts();
  rf.moment = "sharing";
  const r = await G.groundReply(GYM, rf, { message: MESSAGE, recentConversation: "", sentThisTurn: ["Welcome back."], answeredThisTurn: ["Welcome back."] }, { record: false });
  check("sharing turn: when something already answered them this turn, nothing more goes", r.final === "" && counts.voiceLine === 0, r.final);
}

// ---- 4. Warmth isn't a claim; an invented activity still is ----
const WARM = "That's a good place to come back from. Hope the week back is kind to you.";
reset();
script = { claims: () => [], rewrite: "" };
{
  const r = await ground(WARM, "sharing");
  check("a pure-warmth reply goes out whole (no code check cuts a wish)", r.final === WARM && r.outcome === "as_drafted" && G.codeChecks(WARM, G.baseReplyFacts(), { message: MESSAGE, recentConversation: "" }).every((c) => c.pass));
}
check("an invented activity inside a wish is still cut", G.stripUnsupported(DRAFT, [GYM_FAIL]).trim() === STUB);
const rg = fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
check("the claim read is told warmth isn't a claim, and that a specific inside a wish still is (member_life)", /- Warmth: wishing them well, congratulating them, or reacting to what they just told you/.test(rg) && /list only that specific, as member_life/.test(rg));
check("the route hands the moment to the reply check", /replyFacts\.moment = moment\?\.mode \?\? null;/.test(fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8")));

globalThis.fetch = realFetch;
console.log(`reply share cut: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
