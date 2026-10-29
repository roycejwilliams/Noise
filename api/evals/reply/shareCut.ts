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
const counts = { claimRead: 0, shareRewrite: 0, otherRedraft: 0 };
let lastShare = "";
const readSends: string[] = [];
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
    return reply(JSON.stringify({ claims: script.claims(toSend) }));
  }
  if (prompt.includes("They were telling you something that matters to them")) { counts.shareRewrite++; lastShare = JSON.parse(prompt)[0]?.content?.[0]?.text ?? prompt; return reply(script.rewrite); }
  if (prompt.includes("write the smallest true reply instead")) { counts.otherRedraft++; return reply("Got it."); }
  if (prompt.includes("Does this line assert anything")) return reply(JSON.stringify({ onlyAdmission: false }));
  return reply("stub");
}) as any;
const gymClaim = (toSend: string) => (toSend.includes("gym") ? [{ text: GYM, type: "member_life", supported: false, factId: null, quote: null }] : []);
const ground = (draft: string, moment: string | null, message = MESSAGE, recentConversation = "") => {
  const rf = G.baseReplyFacts();
  rf.moment = moment;
  return G.groundReply(draft, rf, { message, recentConversation, contextSummary: "", recentMemories: "" }, { record: false });
};
const reset = () => { counts.claimRead = 0; counts.shareRewrite = 0; counts.otherRedraft = 0; lastShare = ""; readSends.length = 0; };

reset();
script = { claims: gymClaim, rewrite: JSON.stringify({ engages: false, reply: GOOD }) };
{
  const r = await ground(DRAFT, "sharing");
  check("replay of the birthday turn: the rewrite goes out, not the stub", r.final === GOOD && r.outcome === "redrafted");
  check("  one rewrite call, the invented gym never goes out", counts.shareRewrite === 1 && !/gym/i.test(r.final));
  check("  the final reply was checked again (the rewrite's claim read or code checks are on the record)", r.checks.some((c) => c.name.startsWith("redraft.")) && r.checks.some((c) => c.name === "share_repair" && /rewrite: rewrite passed/.test(c.reason ?? "")));
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
  const r = await ground(GYM, "sharing");
  // The whole draft was the invented line: too little left. The share rewrite is the one rewrite; here it comes back empty, so the
  // usual strip path runs, without the old redraft as a second try.
  check("cut to nothing on a sharing turn: the share rewrite is the only rewrite", counts.shareRewrite === 1 && counts.otherRedraft === 0 && !/gym/i.test(r.final));
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

// ---- 3b. Saying their own words back (2026-10-28 run, Lisbon): a fact-level signal that only asks for the one rewrite ----
const LISBON = "Back from a week in Lisbon with my brother. First real trip we've taken together since our dad passed";
const LISBON_REPLY = "A week in Lisbon with your brother, the first trip together since your dad passed, that's not nothing.";
check("restates: the Lisbon reply mostly says his words back", G.restatesThem(LISBON_REPLY, LISBON));
check("restates: a fitting short warm line using two of their words isn't it", !G.restatesThem(FITTING, MESSAGE));
check("restates: Royce's own tone example isn't it", !G.restatesThem("Happy belated birthday, Royce. Glad you're coming back feeling hopeful and recharged. What felt different for you?", MESSAGE));
reset();
const LISBON_GOOD = "Trips like that usually say more afterward than during. What surprised you about him out there?";
script = { claims: () => [], rewrite: JSON.stringify({ engages: false, reply: LISBON_GOOD }) };
{
  const r = await ground(LISBON_REPLY, "sharing", LISBON);
  check("a sharing reply that says their words back gets the one rewrite (nothing cut)", r.final === LISBON_GOOD && r.outcome === "redrafted" && counts.shareRewrite === 1);
  check("  the call is told it says their words back, and isn't offered 'it fits'", /Your draft mostly says their own words back to them/.test(lastShare) && !/"engages": true/.test(lastShare));
}
reset();
script = { claims: () => [], rewrite: JSON.stringify({ engages: false, reply: LISBON_REPLY }) };
{
  const r = await ground(LISBON_REPLY, "sharing", LISBON);
  check("a rewrite that says their words back again is refused; the draft goes as drafted (never cut for it)", r.final === LISBON_REPLY && r.outcome === "as_drafted" && r.checks.some((c) => c.name === "share_repair" && /their own words back/.test(c.reason ?? "")));
}
reset();
{
  const r = await ground(LISBON_REPLY, "asking", LISBON);
  check("not on an asking turn", r.final === LISBON_REPLY && counts.shareRewrite === 0);
}

// ---- 3c. A feedback turn: owning what Cue sent, and offering to fix that one thing (2026-10-28 live check, Inez) ----
const INEZ = "That link you sent goes to a page saying the event was cancelled. Kind of annoying";
const INEZ_THREAD = "User said: any good small music nights this week?\nCo replied: This one looks like your speed. https://lu.ma/smallmusic";
const OWN = { text: "that link shouldn't have gone out dead", type: "past_action" as const, supported: true, factId: null, quote: "That link you sent goes to a page saying the event was cancelled" };
const fb = G.baseReplyFacts();
fb.moment = "feedback";
check("feedback: owning the dead link is backed by their own report of what Cue sent", G.claimChecks([OWN], fb, { message: INEZ, recentConversation: INEZ_THREAD }).every((c) => c.pass));
check("…or by Cue's own sent line in the thread", G.claimChecks([{ ...OWN, quote: "https://lu.ma/smallmusic" }], fb, { message: INEZ, recentConversation: INEZ_THREAD }).every((c) => c.pass));
const sh = G.baseReplyFacts();
sh.moment = "sharing";
check("…only on a feedback turn: elsewhere a past action still needs a fact", G.claimChecks([OWN], sh, { message: INEZ, recentConversation: INEZ_THREAD }).some((c) => !c.pass));
check("…and a quote that isn't in their message or Cue's sent lines backs nothing", G.claimChecks([{ ...OWN, quote: "Cue sent the wrong link on purpose" }], fb, { message: INEZ, recentConversation: INEZ_THREAD }).some((c) => !c.pass));
const inezBase = { draft: "That's on me, that link shouldn't have gone out dead. Sorry for the runaround.", cut: "Sorry for the runaround.", removed: [], allowed: "", message: INEZ };
check("feedback: the rewrite may offer to fix the one thing it sent", G.shareRewriteAddsNothing({ ...inezBase, rewrite: "That's on me, that link was dead. Want me to find another one worth going to instead?", feedback: true }).ok);
check("…not on a sharing turn (still a recommendation there)", !G.shareRewriteAddsNothing({ ...inezBase, rewrite: "That's on me, that link was dead. Want me to find another one worth going to instead?" }).ok);
check("…and never an unrelated offer", !G.shareRewriteAddsNothing({ ...inezBase, rewrite: "That's on me, that link was dead. Want me to set up a call this week?", feedback: true }).ok);
check("…and only one fix offer", !G.shareRewriteAddsNothing({ ...inezBase, rewrite: "Want me to find another one worth going to instead? Should I resend the right one?", feedback: true }).ok);
check("the claim read is told owning a mistake in what Cue sent is supported by the record of the send", /Owning a mistake in something Cue sent, as they describe it \("that link shouldn't have gone out dead"\), is supported when their message or Cue's own sent line in the conversation shows Cue sent it: quote those words\./.test(fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")));
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

// ---- 3e. A wish that names a specific of their life gets a claim read (live check: the river runs skipped it) ----
const MARCUS = "Honestly the trip was a lot, with everything about dad";
check("'Glad the runs along the river...' is read for claims", G.needsClaimCheck("That's a lot to carry into a trip. Glad the runs along the river gave you some space too.", MARCUS));
check("…plain warmth still skips the read", !G.needsClaimCheck("Glad you're back hopeful and recharged.", MESSAGE) && !G.needsClaimCheck("Glad you're back.", MESSAGE));
check("…a specific they named themselves doesn't count", !G.warmthWithASpecific("Glad the trip gave you room.", MARCUS));
reset();
script = { claims: (t) => (t.includes("river") ? [{ text: "Glad the runs along the river gave you some space too.", type: "member_life", supported: false, factId: null, quote: null }] : []), rewrite: JSON.stringify({ engages: false, reply: "That's a lot to carry into a trip. Glad you had it anyway." }) };
{
  const r = await ground("That's a lot to carry into a trip. Glad the runs along the river gave you some space too.", "sharing", MARCUS);
  check("through groundReply: the invented runs are read and cut", counts.claimRead >= 1 && !/river/.test(r.final), r.final);
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
