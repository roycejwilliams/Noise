// How a call feels (Royce, 2026-11-04 review of his own GPT-Live calls). Layer 1: zero tokens, no database (stubs), nothing sent.
// Invented members (Jordan, Noor, Ellis).
//   TZ=UTC node evals/runLayer1.mjs evals/calls/callFeel.ts
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const G = await import("../../src/services/gptLive.js");
const F = await import("../../src/services/firstCall.js");
const { SENSITIVE } = await import("../../src/services/callReason.js");
const { stockLine } = await import("../../src/harness/stockLines.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`); }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const VOICE = src("prompts/co-system-prompt.md");
const base = { userId: "u-jordan", callSid: "CA1", firstName: "Jordan", team: false, voiceLayer: VOICE, contextSummary: "Where things stand now: leaving the agency on the 21st.", rightNow: "Tuesday 2pm.", findsNow: "", callReason: "", timeOfDay: "Tuesday afternoon" };

// ---------------------------------------------------------------- 1. a later call opens from where they left off
check("thread: an open loop passes the work-or-plans filter", F.threadLine(["Plan the studio launch event"], []) === "Plan the studio launch event", F.threadLine(["Plan the studio launch event"], []));
check("thread: the most recent open thread wins over their texts", F.threadLine(["Plan the studio launch event"], ["I'm hiring two engineers for the startup"]) === "Plan the studio launch event");
check("thread: falls back to their latest work-or-plans sentence", F.threadLine([], ["lol ok", "We're raising a seed round in March and hiring two engineers"]) === "We're raising a seed round in March and hiring two engineers");
check("thread: a sensitive line is dropped", F.threadLine(["Wait on the biopsy results before the new job"], ["The divorce is final so I'm moving to Oakland for work"]) === null);
check("thread: feelings and other people's business never pass", F.threadLine(["Feeling lonely"], ["my sister is visiting"]) === null);
check("thread: no code, email, number or link", F.threadLine(["Send the invite code to Noor"], ["my work email is jordan@studio.co", "the project https://x.test/p"]) === null);
{
  const long = F.threadLine([`Plan the packaging studio launch ${"with the two old clients ".repeat(10)}`], []);
  check("thread: at most 160 characters", !!long && long.length <= 160, long?.length);
  check("thread: every line it can return passes SENSITIVE", [long, F.threadLine(["Plan the studio launch event"], [])].every((t) => !!t && !SENSITIVE.test(t)));
}
const fakeDb = (o: { loops?: string[]; texts?: string[]; removed?: string[]; fail?: boolean }) => ({
  query: async (sql: string) => {
    if (o.fail) throw new Error("db down");
    if (/FROM open_loops/.test(sql)) return { rows: (o.loops ?? []).map((title) => ({ title })) };
    if (/User said:/.test(sql)) return { rows: (o.texts ?? []).map((t) => ({ content: `User said: ${t}` })) };
    if (/FROM profile_corrections/.test(sql)) return { rows: (o.removed ?? []).map((old, i) => ({ field: "text", old_value: old, new_value: null, item_ref: `t${i}`, removed: true })) };
    return { rows: [] };
  },
});
check("thread read: open loop first", (await F.laterCallThread("u-jordan", fakeDb({ loops: ["Plan the studio launch event"], texts: ["We're hiring two engineers for the startup"] }))) === "Plan the studio launch event");
check("thread read: a line they removed never reaches the opening", (await F.laterCallThread("u-jordan", fakeDb({ texts: ["I'm interviewing at Stripe for a design role next week"], removed: ["interviewing at Stripe for a design role"] }))) === null);
check("thread read: a failed read is no line, not an error", (await F.laterCallThread("u-jordan", fakeDb({ fail: true }))) === null);
const line = "Plan the studio launch event";
const laterIn = G.buildLiveCall({ ...base, direction: "inbound", first: { firstCall: false }, thread: line });
check("inbound later call: the thread is in GPT-Live's instructions, framed never to read out", laterIn.instructions.includes(G.threadNote(line)) && /never to read out/.test(G.threadNote("x")));
const laterOut = G.buildLiveCall({ ...base, direction: "outbound", callReason: "A nudge about the venue.", first: { firstCall: false }, thread: line });
check("outbound later call: the thread waits for a person on the line, never in the instructions", !laterOut.instructions.includes(line) && G.heldOpeningNote(laterOut.opening).includes(G.threadNote(line)) && G.heldOpeningNote(laterOut.opening).includes(G.reasonNote("A nudge about the venue.")));
check("outbound voicemail never carries it (the instructions hold none of it)", !/Where you left off/.test(laterOut.instructions));
check("no thread, no line (as before)", !G.buildLiveCall({ ...base, direction: "inbound" }).instructions.includes("Where you left off") && G.heldOpeningNote(G.buildLiveCall({ ...base, direction: "outbound", callReason: "R." }).opening) === G.reasonNote("R."));
check("a first call keeps its own words, not a thread", !G.buildLiveCall({ ...base, direction: "inbound", first: { firstCall: true, theirWords: "gave notice, last day the 21st", emailOnFile: false }, thread: line }).instructions.includes("Where you left off"));
check("the bridge sends the held note only on confirmPerson (unchanged)", /const held = heldOpeningNote\(call\.opening\);\s*\n\s*if \(held\) send\(ai, \{ type: "session\.thinking\.append", event_id: "reason"/.test(src("src/services/gptLiveBridge.ts")));
check("the route reads the thread for a later call and passes it", /laterCallThread\(o\.userId\)/.test(src("src/routes/co.ts")) && /first, thread \}\);/.test(src("src/routes/co.ts")));
check("the 'what's on your mind' family is in the opening's avoid list", /what's on your mind/.test(G.OPEN_NO_MIND) && /I'm here, I'm with you/.test(G.OPEN_NO_MIND) && laterIn.instructions.includes(G.OPEN_NO_MIND));
{
  const worst = G.buildLiveCall({ ...base, firstName: "Alexandria-Maximiliana", direction: "inbound", team: true, first: { firstCall: false }, thread: "x".repeat(400) });
  const worstFirst = G.buildLiveCall({ ...base, firstName: "Alexandria-Maximiliana", direction: "inbound", team: true, first: { firstCall: true, theirWords: "x".repeat(400), inviter: "Bartholomew", emailOnFile: false } });
  check("later call, thread at its longest: under the 6,500 cap", worst.instructions.length < G.GPT_LIVE.maxInstructionChars && worst.opening.thread!.length === 160, worst.instructions.length);
  check("first call, every line at its longest: under the cap", worstFirst.instructions.length < G.GPT_LIVE.maxInstructionChars, worstFirst.instructions.length);
  console.log(`worst-case instructions: later ${worst.instructions.length}, first ${worstFirst.instructions.length} of ${G.GPT_LIVE.maxInstructionChars}`);
}

// ---------------------------------------------------------------- 2-5. the prompt lines
for (const [label, c] of [["inbound", laterIn], ["outbound", laterOut]] as const) {
  check(`${label}: GPT-Live has all four feel lines`, G.LIVE_FEEL.length === 3 && G.LIVE_FEEL.every((l) => c.instructions.includes(l)));
  check(`${label}: the thinking has the feel guidance`, c.backendSystem.includes(G.BACKEND_FEEL));
  check(`${label}: nothing GPT-Live may never say`, !G.GPT_LIVE_FORBIDDEN.some((re) => re.test(c.backendSystem) || re.test(c.instructions)));
}
check("wind-down: the thinking keeps its end-call line and the feel guidance names the signals", /use your tool that ends the call and write nothing/.test(G.BACKEND_NOTE) && /short agreements in a row/.test(G.BACKEND_FEEL) && /never ask a new question or bring a topic back/.test(G.BACKEND_FEEL));
check("opinions: the thinking (which answers any ask for advice or a read) gives an opinion and its reason, never a verdict", /opinion and the reason/.test(G.BACKEND_FEEL) && /never state their feelings or motives as fact/.test(G.BACKEND_FEEL));
check("moment: light and brief when with others, hi, or short on time", /with other people, just saying hi, or short on time/.test(G.BACKEND_FEEL) && /light and brief with others around/.test(G.LIVE_FEEL[1]));
check("rhythm: at most one question every other turn, in both prompts", /at most one question every other turn/.test(G.BACKEND_FEEL) && /not every turn/.test(G.LIVE_FEEL[0]));
check("texts keep the family (call-only change): the shared stock list does not flag it", stockLine("Hey Jordan, what's on your mind tonight?") === null);

// ---------------------------------------------------------------- the wind-down signal
const req = (...t: string[]) => ({ model: "x", messages: t.flatMap((x, i) => (x ? [{ role: i % 2 === 0 ? "user" : "assistant", content: x }] : [])) }) as any;
const member = (...m: string[]) => ({ model: "x", messages: m.flatMap((x) => [{ role: "assistant", content: "A line from Cue." }, { role: "user", content: x }]) }) as any;
check("signal: two short agreements in a row", G.windDownSignal(member("Yeah, I agree.", "Yeah, I agree")) === true);
check("signal: thanks after an agreement", G.windDownSignal(member("Right, totally", "Thanks")) === true);
check("signal: an agreement plus a 'hello?' check in one turn", G.windDownSignal(member("Yeah, I agree. Hello?")) === true);
check("signal: not on one bare yeah or thanks (they may go on)", G.windDownSignal(member("Yeah")) === false && G.windDownSignal(member("Thanks")) === false);
check("signal: not on a bare 'hello?'", G.windDownSignal(member("Hello?")) === false);
check("signal: not when either turn says more", G.windDownSignal(member("Yeah, I agree, but what about the venue", "Yeah")) === false && G.windDownSignal(member("Yeah I agree", "Okay so what do I do about Ellis")) === false);
check("signal: only the last two of their turns count", G.windDownSignal(member("Yeah", "Yeah", "Tell me about the studio launch plan")) === false);
check("signal: the thinking is told as a fact, not a command to hang up", /winding down/.test(G.WIND_DOWN_NOTE) && /Don't ask a new question or bring a topic back/.test(G.WIND_DOWN_NOTE));
check("question rhythm: noted only when Cue's last turn ended on a question", G.askedLastTurn(req("Hi", "What part grabbed you?", "The pricing")) === true && G.askedLastTurn(req("Hi", "That sounds like a solid plan.", "Thanks")) === false);
check("a lone short agreement after a statement gets the soft note; after a question it does not", G.agreedBriefly(member("Tell me more", "Yeah, I agree")) === true && G.agreedBriefly({ model: "x", messages: [{ role: "assistant", content: "Hi." }, { role: "user", content: "hey" }, { role: "assistant", content: "What part grabbed you?" }, { role: "user", content: "Yeah" }] } as any) === false && G.agreedBriefly(member("Tell me more", "Yeah, but what about the venue")) === false);
check("the signal is fed to the thinking every non-safety turn (turn notes)", /!safety0 && windDownSignal\(req\) \? WIND_DOWN_NOTE/.test(src("src/services/gptLive.ts")));

console.log(`call feel: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
