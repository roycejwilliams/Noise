// Crisis numbers survive the call brain's spoken check (found 2026-10-31): offerGuard.ts spokenProblem held every number that isn't in
// what Cue knows about the member, and 988 lives in the prompt's guardrails, so "you can call or text 988 right now" was dropped from a
// crisis turn before it was spoken. On GPT-Live's delegated turns (live on co-test) and on the ElevenLabs proxy path alike: both run
// callLlmProxy.ts runCallLlm. The text reply path was checked too: its facts carry CRISIS_RESOURCES in every situation and its only
// number check is for 10-digit phone numbers, so it never had this overreach.
// Layer 1: Claude is a fake; no network, no tokens. Invented member (Jordan).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/crisisNumbers.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

const O = await import("../../src/services/offerGuard.js");
const P = await import("../../src/services/callLlmProxy.js");
const G = await import("../../src/services/gptLive.js");
const E = await import("../../src/services/elevenLabsCalls.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const VOICE = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const LINE = "I'm really glad you told me. If you're thinking about ending your life, you can call or text 988 right now. If you're in danger this minute, call 911. You can also text 741741. Are you safe tonight?";
const THEIRS = "Honestly I don't want to be here anymore.";
const events = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }] as any[];

// ---- the check itself
{
  const srcs = P.callSources({ messages: [{ role: "system", content: "You are Cue." }, { role: "user", content: THEIRS }] } as any);
  check("988, 911 and 741741 are backed on a crisis-resource line", ["You can call or text 988 right now.", "If you're in danger, call 911.", "You can also text 741741."].every((x) => O.spokenProblem(x, srcs) === null) && [...O.CRISIS_NUMBERS].join() === "988,911,741741");
  check("...the text line's keyword and other spellings too: \"Text HOME to 741741\", \"Call 9-8-8\", \"nine eight eight\"", ["Text HOME to 741741.", "Call 9-8-8 any time.", "You can call nine eight eight."].every((x) => O.spokenProblem(x, srcs) === null), ["Text HOME to 741741.", "Call 9-8-8 any time."].map((x) => O.spokenProblem(x, srcs)));
  check("...but the same numbers anywhere else are just numbers, checked as any other (review of #330)", O.spokenProblem("It was $988 a month.", srcs)?.kind === "number" && O.spokenProblem("We met in room 911.", srcs)?.kind === "number" && O.spokenProblem("About 741741 people went.", srcs)?.kind === "number");
  check("...any other number nothing backs is still held (the check isn't loosened)", O.spokenProblem("Call me back at 4155550123.", srcs)?.kind === "number" && O.spokenProblem("It starts at 8 and costs 45 dollars.", srcs) !== null);
}

// ---- the ElevenLabs proxy path: runCallLlm with the agent's own prompt, cleaned as on a call
{
  let out = "";
  const dropped: string[] = [];
  for await (const c of P.runCallLlm({ messages: [{ role: "system", content: E.promptForElevenLabs(VOICE) }, { role: "user", content: THEIRS }], stream: true } as any, { stream: () => (async function* () { for (const e of events(LINE)) yield e; })(), clean: true, tools: null, onDropped: (s: string, w: string) => dropped.push(`${w}: ${s}`) } as any)) {
    const d: any = c.choices[0].delta;
    if (typeof d.content === "string") out += d.content;
  }
  check("proxy path: a crisis turn keeps \"call or text 988\", 911 and 741741, nothing held", /call or text 988 right now/.test(out) && /call 911/.test(out) && /text 741741/.test(out) && dropped.length === 0, { out, dropped });
}

// ---- a GPT-Live delegated turn (gptLive.ts thinkOnCall, the same runCallLlm behind GPT-Live)
{
  const call = G.buildLiveCall({ userId: "u-jordan", callSid: null, firstName: "Jordan", direction: "inbound", team: true, voiceLayer: VOICE, contextSummary: "Jordan is moving to Oakland in March.", rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  const dropped: string[] = [];
  const out = await G.thinkOnCall(call, [{ who: "member", text: THEIRS, startMs: 0, endMs: 1500 }], () => (async function* () { for (const e of events(LINE)) yield e; })(), (s, w) => dropped.push(`${w}: ${s}`));
  check("delegated: what GPT-Live is handed keeps \"call or text 988\", 911 and 741741, nothing held", /call or text 988 right now/.test(out.text) && /call 911/.test(out.text) && /text 741741/.test(out.text) && dropped.length === 0, { text: out.text, dropped });
}

console.log(`crisis numbers on calls: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
