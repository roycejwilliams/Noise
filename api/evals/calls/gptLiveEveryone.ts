// Every member on GPT-Live (Royce, 2026-10-31): the processor line in what Cue knows (approved wording, fixed), and no call placed or
// answered through ElevenLabs. Inbound and outbound for a member not on the team are tested in evals/calls/gptLive.ts §7 and §9 and
// evals/calls/gptLiveOutbound.ts §2 and §3; this holds the line and the reachability.
// Layer 1: no network, no tokens.
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveEveryone.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

const W = await import("../../src/services/whatCoKnows.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };

// ---------------------------------------------------------------- the processor line, in what Cue knows
{
  const APPROVED = "Cue's phone calls run on OpenAI's voice model, so OpenAI processes the call audio and what Cue knows to help on it. OpenAI doesn't train on it and keeps it at most 30 days for safety checks.";
  check("the line is the approved wording, exactly", W.CALLS_PROCESSOR_LINE === APPROVED);
  const view = W.groupKnown([{ group: "where" as any, text: "moving to Oakland in March", ref: "r1", theirWords: null, canCorrect: true } as any]);
  const empty = W.groupKnown([]);
  check("the what-Cue-knows view carries it, with something known and with nothing yet", view.calls === APPROVED && empty.calls === APPROVED);
  check("...and the reply's fact line from the view says it word for word, both ways", view.groups.length === 1 && W.knownFact(view).includes("moving to Oakland") && W.knownFact(view).includes(APPROVED) && W.knownFact(empty).includes(APPROVED) && W.knownFact(empty).startsWith("What Cue knows about them: nothing yet"));
  check("...and the whatCoKnows tool returns it with the groups", /calls: got\.view\.calls,/.test(src("agent/conversationTools.ts")));
  check("no message goes out about it: nothing but the view reads it", (() => {
    const users = ["agent/conversationTools.ts", "services/whatCoKnows.ts"];
    const all = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    return all.filter((f) => !users.includes(f)).every((f) => !src(f).includes("CALLS_PROCESSOR_LINE") && !src(f).includes("OpenAI's voice model"));
  })());
}

// ---------------------------------------------------------------- ElevenLabs out of the call path
{
  const co = src("routes/co.ts");
  const trigger = src("services/callTrigger.ts");
  const calls = (fn: string) => (co.match(new RegExp(`\\b${fn}\\(`, "g")) ?? []).length;
  check("registerElevenLabsCall is called only inside the two old ElevenLabs answers", (co.match(/registerElevenLabsCall\(\{/g) ?? []).length === 2 && co.indexOf("registerElevenLabsCall({") > co.indexOf("async function elevenLabsInboundTwiml(") && co.lastIndexOf("registerElevenLabsCall({") > co.indexOf("async function elevenLabsOutboundTwiml("));
  check("...and nothing calls those answers (kept for the deletion PR)", calls("elevenLabsInboundTwiml") === 1 && calls("elevenLabsOutboundTwiml") === 1);
  check("the main number answers only through GPT-Live", (() => { const h = co.slice(co.indexOf('"/incoming-call"'), co.indexOf("async function elevenLabsInboundTwiml(")); return /const live = await gptLiveAnswer\(/.test(h) && /return res\.type\("text\/xml"\)\.send\(await gptLiveRefusalTwiml\(/.test(h); })());
  check("every dial is checked for GPT-Live, gets AMD, and its TwiML route answers only through GPT-Live", /if \(!live\.ok\) return gptLiveNotPlaced\(/.test(trigger) && /\.\.\.amdDialOptions\(process\.env\.API_URL\),/.test(trigger) && (() => { const h = co.slice(co.indexOf('router.post("/el/outbound-twiml"'), co.indexOf("async function elevenLabsOutboundTwiml(")); return /gptLiveAnswer\(/.test(h) && !/registerElevenLabsCall/.test(h); })());
  check("no team gate left on the call path (team only shapes the prompt)", !/refused: "not_team"/.test(co) && !/isTeamMember\(id\)/.test(src("services/gptLive.ts")));
  const elsewhere = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts") && f !== "services/elevenLabsCalls.ts" && f !== "routes/co.ts");
  check("nothing else in the code places or registers an ElevenLabs call (no outbound-call API, no register-call)", elsewhere.every((f) => !/registerElevenLabsCall\(|conversationalAi\.twilio\.(registerCall|outboundCall)|outbound[-_]call/i.test(src(f))), elsewhere.filter((f) => /registerElevenLabsCall\(|conversationalAi\.twilio\.(registerCall|outboundCall)|outbound[-_]call/i.test(src(f))));
}

console.log(`everyone on gpt-live: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
