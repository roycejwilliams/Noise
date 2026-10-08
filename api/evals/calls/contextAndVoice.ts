// The call fix (Royce, 2026-10-08, after a 10-call eval: 4 of 9 outbound calls opened with Co's homework, 5 of 10 asked two
// questions in a turn, and em dashes reached the voice on the direct path). Zero tokens:
//   1. one item, said once: the promise, the open loop and the recap about the same deliverable collapse into one line; what they
//      already have is marked "they have it" and kept out of "where things stand"
//   2. the voice-only endpoint: a dash becomes a full stop, a turn ends at its first question, nothing is held back or added
//   npx tsx evals/calls/contextAndVoice.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const CC = await import("../../src/services/callContext.js");
const P = await import("../../src/services/callLlmProxy.js");
const E = await import("../../src/services/elevenLabsCalls.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const day = () => "Oct 8";

// ---- 1. the context: one item once; what they have, apart
{
  const lines = [
    { text: "Oct 7: Promised on the call: draft and text a plan on Co's post-event presence. Sent.", from: "promise" as const, sent: true },
    { text: "Oct 7: Promised on the call: text the drafted planning document. Not sent yet.", from: "promise" as const, sent: false },
    { text: "Keep your word from the call: the plan for how Co keeps its presence after the Sequin AI November event: in progress (document finalized, send blocked until hours resume)", from: "loop" as const },
    { text: "Find a caterer for the November open house: searching, 2 options so far", from: "loop" as const },
  ];
  const r = CC.collapseCarried(lines, [{ title: "Co Presence Plan: After the Sequin AI November Event", at: new Date("2026-10-08T16:00:00Z") }], day);
  check("a sent deliverable leaves 'where things stand' (promise, its loop and the not-sent line all go)", !r.open.some((l) => /presence|planning document/i.test(l.text)), r.open);
  check("...and appears once, as something they have, with when", r.theyHaveIt.length === 1 && /Co Presence Plan/.test(r.theyHaveIt[0]) && /sent Oct 8/.test(r.theyHaveIt[0]), r.theyHaveIt);
  check("an open, different item stays where things stand", r.open.length === 1 && /caterer/.test(r.open[0].text));
  check("a recap or thread sentence about what they have is covered (dropped from the context)", r.covered("Royce discussed the finished post-event presence doc, which will be sent to Royce's texts the next morning.") && !r.covered("Royce is stressed about what's next after building Co."));
  // Review of #110: never drop what Co still owes, or the member's own life.
  const owed = CC.collapseCarried([
    { text: "Oct 5: Promised on the call: send the restaurant shortlist. Sent.", from: "promise" as const, sent: true },
    { text: "Oct 5: Promised on the call: draft the investor update email outline. Not sent yet.", from: "promise" as const, sent: false },
  ], [], day);
  check("a different deliverable promised the same day stays open (the same-call rule is only for rewordings)", owed.open.some((l) => /investor update/.test(l.text)), owed.open);
  const place = CC.collapseCarried([{ text: "find a pitch coach in San Francisco: research started", from: "loop" as const }], [{ title: "San Francisco dinner options for Friday", at: new Date() }], day);
  check("a shared place name never matches two different things", place.open.length === 1);
  const own = CC.collapseCarried([], [{ title: "Investor meeting prep brief", at: new Date() }, { title: "SF dinner options", at: new Date() }], day);
  check("the member's own deck and plans are never removed from threads or recap", !own.covered("Their pitch deck for the investor meeting on Thursday is nearly done.") && !own.covered("putting together a plan for their mom's birthday dinner in San Francisco Friday."));
  const dup = CC.collapseCarried([
    { text: "Oct 9: Promised on the call: send three private dining options near Hayes Valley. Not sent yet.", from: "promise" as const, sent: false },
    { text: "Keep your word: send three private dining options near Hayes Valley for the 20th: searching, 1 option verified", from: "loop" as const },
  ], [], day);
  check("an open promise and its loop collapse into one line (the more specific)", dup.open.length === 1 && /1 option verified/.test(dup.open[0].text), dup.open);
  const summary = CC.assembleCallSummary({ haveIt: r.theyHaveIt.join("\n"), now: "- Find a caterer: searching", lastCalls: null, settled: null, lessons: [], sentLines: [], threads: [], base: "Who they are:\nruns a studio" });
  check("'they have it' sits after what's current, marked never a reason to call or an opener", summary.indexOf("Where things stand now") < summary.indexOf("They already have these") && /never a reason to call or an opener/.test(summary) && /changed since they last heard about it, or they ask/.test(summary), summary);
  check("the call prompt says the same", /never why you called and never how you open/.test(E.CALL_GUIDE));
  check("the builder uses it: receipts and sent promises collapse; threads, recap and last calls drop what's covered", /collapseCarried\(/.test(src("services/callContext.ts")) && /!carried\.covered\(t\.text\)/.test(src("services/callContext.ts")) && /!carried\.covered\(s\)/.test(src("services/callContext.ts")) && /filter\(\(x\) => !carried\.covered\(x\)\)/.test(src("services/callContext.ts")));
}

// ---- 2. the voice-only endpoint
{
  const text = (s: string) => {
    const evs: any[] = [{ type: "message_start" }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
    for (const piece of s.match(/.{1,12}/gs) ?? []) evs.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
    evs.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" });
    return evs;
  };
  let seenReq: any = null;
  const spy = (events: any[]) => (r: any) => { seenReq = r; return (async function* () { for (const e of events) yield e; })(); };
  const body = { model: "x", stream: true, messages: [{ role: "system", content: "You are Co. # What you know about Jordan\nnothing" }, { role: "user", content: "my mentor died this week" }], tools: [{ type: "function", function: { name: "end_call", parameters: {} } }] } as any;
  const run = async (reply: string, deps: any = {}) => {
    let out = "";
    for await (const c of P.runCallLlm(body, { stream: spy(text(reply)), voiceOnly: true, ...deps })) out += (c.choices[0].delta as any).content ?? "";
    return out.trim();
  };
  const dashed = await run("[softly] Losing someone who believed in you early on — that's its own kind of grief. Take your time.");
  check(`voice-only: an em dash never reaches the voice ("${dashed}")`, !/[—–]/.test(dashed) && /early on\. That's its own kind of grief\./.test(dashed));
  // Review of #110: only a second QUESTION is dropped; statements after the question stay (answers aren't cut).
  const two = await run("A month in, new city, new job. What's the work like day to day? I'm curious what drew you to climate. What made you pick it?");
  check(`voice-only: a second question is dropped, the statement after the first stays ("${two}")`, /day to day\?/.test(two) && /curious what drew you to climate\./.test(two) && !/pick it/.test(two));
  const echo = await run("The dinner? It's Friday at seven, at Nopa.");
  check(`voice-only: an echo question never cuts the answer ("${echo}")`, /Friday at seven/.test(echo));
  const rhet = await run("Honestly? I think you should go. What's holding you back?");
  check(`voice-only: a one-word rhetorical question isn't the turn's question ("${rhet}")`, /What's holding you back\?/.test(rhet));
  const twoQ = await run("What kind of messages are you getting? Like, people wanting to come, or something else?");
  check("voice-only: never two questions in one turn", (twoQ.match(/\?/g) ?? []).length === 1);
  const safety = await run("Are you safe right now? If you're not, call or text 988, any time. I'm staying right here with you.");
  const lifeline = await run("Are you safe right now? If not, please reach out to the crisis lifeline by calling nine eight eight. Is someone with you tonight?");
  check(`voice-only: a safety turn has no question limit and keeps every help line ("${lifeline}")`, /nine eight eight/.test(lifeline) && /someone with you tonight\?/.test(lifeline));
  check(`voice-only: a safety line after the question is never cut ("${safety}")`, /988/.test(safety) && /Are you safe right now\?/.test(safety));
  {
    const { SAFETY_TURN } = await import("../../src/services/callLlmProxy.js");
    const notSafety = ["it all felt a little... safe? Like I wasn't pushing myself", "we played it safe with the menu", "safe to say it went well", "no harm in asking", "the money is safe in savings", "I can't wait for Saturday", "it ended up fine", "I can't do this Friday", "I can't do this weekend", "I'm cutting back on drinking", "we're cutting the guest list", "my allergy pills", "that's not okay with me, the price", "I'm ending things with Sam", "we'll end it with dessert", "did you miss me?", "my feet are killing me", "my startup is killing me", "my mom would kill me", "my weekend disappeared", "get home safe", "drive safe", "stay safe", "is it safe to go there at night?", "I don't want to be here for the speeches", "I can't keep going to these mixers", "you're safe to skip it", "I'm safe on time", "is there a safe place to park?", "it's a safe bet they'll come", "the caterer is a safe pick", "we're safe on budget", "that's a safe choice for the menu"];
    const safety = ["I'm safe tonight, just tired", "I don't feel safe at home", "sometimes I wonder if anyone would notice if I disappeared", "I've thought about hurting myself", "everyone would be better off without me", "I feel unsafe", "I don't feel safe", "I didn't feel safe", "I wouldn't feel safe going home", "I haven't felt safe in weeks", "he might harm me", "I could harm someone", "Are you somewhere safe?", "Do you have somewhere safe to go tonight?", "Can you get somewhere safe?", "I don't want to be here anymore", "I want to die", "I can't do this anymore", "no one would care if I was gone", "I'm not okay", "thinking of ending things", "I've been cutting", "I took a bunch of pills", "I don't want to live", "I'm going to end my life", "nobody would miss me", "there's no way out", "Are you thinking about ending your life?", "I wish I was dead", "I'm a burden", "I keep having dark thoughts", "my partner hit me", "he'll harm the kids", "I just want to end it", "I want to disappear", "I'd rather not be here", "I do not feel safe", "I don't really feel safe", "I can't keep myself safe", "I don't think I can stay safe tonight", "Will you be safe tonight?", "Do you think I'll be safe?", "I don't know if I'll make it through the night", "I wrote a goodbye note", "I just want to sleep forever", "I'm scared of what I might do to myself", "I bought a gun"];
    check(`a bare "safe" never lifts the question limit (2026-10-08 new_member call): ${notSafety.filter((x) => SAFETY_TURN.test(x)).join(" | ") || "none"}`, notSafety.every((x) => !SAFETY_TURN.test(x)));
    check(`real safety talk still lifts it: missed ${safety.filter((x) => !SAFETY_TURN.test(x)).join(" | ") || "none"}`, safety.every((x) => SAFETY_TURN.test(x)));
    const { safetyCall } = await import("../../src/services/callLlmProxy.js");
    const call = (msgs: [string, string][]) => safetyCall({ messages: msgs.map(([role, content]) => ({ role, content })) });
    check("a safety call stays one: an earlier \"I don't feel safe\" lifts the limit on a later turn the pattern alone would miss", call([["user", "I don't feel safe"], ["assistant", "Are you safe right now?"], ["user", "I guess, it's just a lot"]]));
    check("Co's own help line earlier in the call makes it a safety call", call([["user", "it's been heavy"], ["assistant", "You can call or text 988, any time."], ["user", "yeah"]]));
    check("an ordinary call is not a safety call", !call([["user", "we played it safe with the menu"], ["assistant", "Smart. What's the headcount?"], ["user", "about forty, drive safe tonight"]]));
  }
  const stock = await run("Don't worry about the time. And I hear you. Feeling invisible in a full room is its own kind of tired. When did it start?");
  check(`voice: a sentence that's only a stock phrase isn't said, the rest is ("${stock}")`, !/hear you/i.test(stock) && /invisible in a full room/.test(stock) && /When did it start\?/.test(stock));
  const stockLead = await run("[softly] I hear you. Going through the motions while nobody sees you wears you down.");
  check(`voice: a stock phrase leading a reply is dropped too ("${stockLead}")`, !/hear you/i.test(stockLead) && /Going through the motions/.test(stockLead));
  const stockSpecific = await run("I hear you, and the part about Sam leaving the studio is the piece I'd sit with.");
  check(`voice: a sentence that goes on to say something specific is kept whole ("${stockSpecific}")`, /I hear you, and the part about Sam/.test(stockSpecific));
  const stockOnly = await run("I hear you.");
  check(`voice: a reply that's only a stock phrase is still said, never silence ("${stockOnly}")`, /I hear you\./.test(stockOnly));
  const named = await run("Your mentor Richard sounds like he was rare. What did he see in you?");
  check("voice-only: nothing is held back for an unbacked name (no fact check in this mode)", /Richard/.test(named));
  check("voice-only: no tools and no turn notes are added to the request", (seenReq?.tools ?? []).every((t: any) => t.name === "end_call") && !/This turn: they told you how they are/.test(JSON.stringify(seenReq?.system ?? "")));
  check("the endpoint takes the mode from the agent's header and skips Co's tools in it", /req\.headers\["x-co-mode"\]/.test(src("routes/callLlm.ts")) && /userId && !voiceOnly && process\.env\.CALL_TOOLS/.test(src("routes/callLlm.ts")));
  const cfg: any = E.buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test", proxy: { url: "https://x.test/co/el/llm", secretId: "s", voiceOnly: true } });
  check("the agent sends the voice-only header to the endpoint", cfg.conversation_config.agent.prompt.custom_llm.request_headers?.["x-co-mode"] === "voice");
  check("the push script sets it with ELEVENLABS_LLM_PROXY=voice", /ELEVENLABS_LLM_PROXY === "voice"/.test(src("scripts/pushElevenLabsAgent.ts")));
}

console.log(`call context + voice: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
