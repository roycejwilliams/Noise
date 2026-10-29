// Reply check: a cut on a sharing turn never leaves a flat stub (Royce, 2026-10-28). Layer 1: every model call is scripted here.
//   TZ=UTC node evals/runLayer1.mjs evals/reply/shareCut.ts
// The incident: "Cool, I'm just getting back from my birthday/vacation. I'm honestly feeling hopeful and recharged". The draft's
// closing line invented "the gym today"; the check rightly cut it, and "That's a good place to come back from." went out alone.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const G = await import("../../src/harness/replyGrounding.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

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
const base = { draft: DRAFT, cut: STUB, failed: [GYM_FAIL], message: MESSAGE, allowed: "" };
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
  const { d, calls } = deps(JSON.stringify({ engages: false, reply: "Happy belated birthday. Where did you go? Who'd you go with?" }));
  const r = await G.repairShareCut(base, d);
  check("stacked questions are refused in code", r.how === "none" && /more than one question/.test(r.why) && calls.recheck === 0);
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
  const r = await G.repairShareCut({ ...base, cut: "Love that for you." }, d);
  check("the rewrite call may decide what's left already fits them: it goes out as is, no recheck", r.how === "kept" && r.final === "Love that for you." && calls.recheck === 0);
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
const reply = (text: string) => new Response(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  if (!/api\.anthropic\.com/.test(url)) return realFetch(input, init);
  const body = String(init?.body ?? "");
  const prompt = (() => { try { const j = JSON.parse(body); return JSON.stringify(j.messages ?? j); } catch { return body; } })();
  if (prompt.includes("You check a text message Cue is about to send")) {
    counts.claimRead++;
    const toSend = JSON.parse(`"${(prompt.match(/Message Cue is about to send:\\n\\"([\s\S]*?)\\"\\n\\nReturn ONLY JSON/)?.[1] ?? "")}"`);
    return reply(JSON.stringify({ claims: script.claims(toSend) }));
  }
  if (prompt.includes("They were telling you something that matters to them")) { counts.shareRewrite++; return reply(script.rewrite); }
  if (prompt.includes("write the smallest true reply instead")) { counts.otherRedraft++; return reply("Got it."); }
  if (prompt.includes("Does this line assert anything")) return reply(JSON.stringify({ onlyAdmission: false }));
  return reply("stub");
}) as any;
const gymClaim = (toSend: string) => (toSend.includes("gym") ? [{ text: GYM, type: "member_life", supported: false, factId: null, quote: null }] : []);
const ground = (draft: string, moment: string | null) => {
  const rf = G.baseReplyFacts();
  rf.moment = moment;
  return G.groundReply(draft, rf, { message: MESSAGE, recentConversation: "", contextSummary: "", recentMemories: "" }, { record: false });
};
const reset = () => { counts.claimRead = 0; counts.shareRewrite = 0; counts.otherRedraft = 0; };

reset();
script = { claims: gymClaim, rewrite: JSON.stringify({ engages: false, reply: GOOD }) };
{
  const r = await ground(DRAFT, "sharing");
  check("replay of the birthday turn: the rewrite goes out, not the stub", r.final === GOOD && r.outcome === "redrafted");
  check("  one rewrite call, the invented gym never goes out", counts.shareRewrite === 1 && !/gym/i.test(r.final));
  check("  the final reply was checked again (the rewrite's claim read or code checks are on the record)", r.checks.some((c) => c.name.startsWith("redraft.")) && r.checks.some((c) => c.name === "share_repair" && /^rewrite:/.test(c.reason ?? "")));
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
check("the route hands the moment to the reply check", /replyFacts\.moment = moment\?\.mode \?\? null;/.test(fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8")));

globalThis.fetch = realFetch;
console.log(`reply share cut: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
