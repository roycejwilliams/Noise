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
  const two = await run("A month in, new city, new job. What's the work like day to day? I'm curious what drew you to climate.");
  check(`voice-only: a turn ends at its first question ("${two}")`, /day to day\?$/.test(two) && !/curious/.test(two));
  const twoQ = await run("What kind of messages are you getting? Like, people wanting to come, or something else?");
  check("voice-only: never two questions in one turn", (twoQ.match(/\?/g) ?? []).length === 1);
  const safety = await run("Are you safe right now? If you're not, call or text 988, any time. I'm staying right here with you.");
  check(`voice-only: a safety line after the question is never cut ("${safety}")`, /988/.test(safety) && /Are you safe right now\?/.test(safety));
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
