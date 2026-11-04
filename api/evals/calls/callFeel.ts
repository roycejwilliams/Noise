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
const base = { userId: "u-jordan", callSid: "CA1", firstName: "Jordan", team: false, voiceLayer: VOICE, contextSummary: "Where things stand now: leaving the agency on the 21st.", rightNow: "Tuesday 2pm.", findsNow: "", callReason: "", timeOfDay: "Wednesday afternoon" };

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
const seenSql: { sql: string; args?: unknown[] }[] = [];
const fakeDb = (o: { loops?: string[]; texts?: string[]; removed?: string[]; closed?: string[]; fail?: boolean }) => ({
  query: async (sql: string, args?: unknown[]) => {
    seenSql.push({ sql, args });
    if (o.fail) throw new Error("db down");
    if (/UNION ALL/.test(sql)) return { rows: (o.closed ?? []).map((label) => ({ label, status: "done", closed_at: new Date() })) };
    if (/FROM open_loops/.test(sql)) return { rows: (o.loops ?? []).map((title) => ({ title, status: "open", due_date: null, last_confirmed_at: new Date(Date.now() - (title.startsWith("STALE ") ? 20 : 1) * 86_400_000), decay_asked_at: null })) };
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
  const long = "Alexandria-Maximiliana-Bartholomew-Fitzgerald";
  const worst = G.buildLiveCall({ ...base, firstName: long, direction: "inbound", team: true, first: { firstCall: false }, thread: "x".repeat(400) });
  const worstFirst = G.buildLiveCall({ ...base, firstName: long, direction: "inbound", team: true, first: { firstCall: true, theirWords: "x".repeat(400), inviter: "Bartholomew-Fitzgerald-Montgomery", emailOnFile: false } });
  check("later call, thread at its longest, long name: under the 6,500 cap", worst.instructions.length < G.GPT_LIVE.maxInstructionChars && worst.opening.thread!.length === 160, worst.instructions.length);
  check("first call, every line at its longest, long names: under the cap", worstFirst.instructions.length < G.GPT_LIVE.maxInstructionChars, worstFirst.instructions.length);
  check("names are capped at 24 characters in the prompt", !worst.instructions.includes(long) && worst.instructions.includes(long.slice(0, 24)) && !worstFirst.instructions.includes("Bartholomew-Fitzgerald-Montgomery"));
  // The cap holds at runtime: an over-long identity pushes the prompt over, and the thread (then their words) goes first.
  const over = G.liveInstructions({ firstName: "Jordan", direction: "inbound", team: true, opening: { timeOfDay: "Wednesday afternoon", reason: null, thread: line, firstCall: false }, identity: "y".repeat(G.GPT_LIVE.maxInstructionChars - G.liveInstructions({ firstName: "Jordan", direction: "inbound", team: true, opening: { timeOfDay: "Wednesday afternoon", reason: null, firstCall: false } }).length - 10) });
  check("runtime cap: over the cap, the thread is dropped first and the prompt fits", !over.includes("Where you left off") && over.length < G.GPT_LIVE.maxInstructionChars, over.length);
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
// A call: Cue's opening, then (member, Cue) pairs, ending on the member's last line. cues[i] is what Cue said before members[i].
const call = (cues: string[], members: string[]) => ({ model: "x", messages: members.flatMap((m, i) => [{ role: "assistant", content: cues[i] }, { role: "user", content: m }]) }) as any;
const STATE = "That plan holds up, and the venue is the right size.";
const member = (...m: string[]) => call(m.map(() => STATE), m);
check("signal: two short agreements in a row after finished points (the real wrap-up)", G.windDownSignal(member("Yeah, I agree.", "Yeah, I agree")) === true);
check("signal: thanks after an agreement", G.windDownSignal(member("Totally", "Thanks")) === true);
check("signal: an agreement plus a 'hello?' check in one turn, after a finished point", G.windDownSignal(member("Tell me more", "Yeah, I agree. Hello?")) === true);
check("signal: not on one bare yeah or thanks (they may go on)", G.windDownSignal(member("Tell me more", "Yeah")) === false && G.windDownSignal(member("Tell me more", "Thanks")) === false);
check("signal: not on a bare 'hello?' (the line dropped: I'm still here)", G.windDownSignal(member("Tell me more", "Hello?")) === false);
check("signal: not when either turn says more", G.windDownSignal(member("Yeah, I agree, but what about the venue", "Yeah")) === false && G.windDownSignal(member("Yeah I agree", "Okay so what do I do about Ellis")) === false);
check("signal: only the last two of their turns count", G.windDownSignal(member("Yeah", "Yeah", "Tell me about the studio launch plan")) === false);
// The review's probes, each one that must NOT fire:
check("probe: walkthrough 'Okay.' / 'Right.' never fires", G.windDownSignal(member("Okay.", "Right.")) === false && G.windDownSignal(member("Okay", "Okay")) === false);
check("probe: 'Mm-hmm' / 'Uh huh' never fires", G.windDownSignal(member("Mm-hmm", "Uh huh")) === false && G.windDownSignal(member("Mm-hmm.", "Mhm")) === false);
check("probe: 'No.' / 'No, no.' answers never fire", G.windDownSignal(member("No.", "No, no.")) === false && G.agreedBriefly(call(["Hi", STATE], ["Hey", "No."])) === false);
check("probe: a yes to an offer never fires", G.windDownSignal(call(["Hi", "Want me to text you the list?"], ["Hey", "Yeah"])) === false && G.windDownSignal(call(["Want me to send it?", "Want me to send it too?"], ["Yeah", "Yes, please"])) === false && G.agreedBriefly(call(["Hi", "Want me to text you the list?"], ["Hey", "Yeah"])) === false);
check("probe: an agreement to a question never fires", G.windDownSignal(call(["Hi", "Does Thursday work?"], ["Hey", "Yeah, I agree"])) === false);
check("probe: a capped walkthrough ('say go on') never fires", G.windDownSignal(call(["Step one, open settings. Step two, tap the account. Say go on for the rest.", "Step three is the toggle, then save. Say go on when you're ready."], ["Yeah", "Yeah, I agree"])) === false && G.agreedBriefly(call(["Hi", "Step two, tap the account. Say go on for the rest."], ["Hey", "Yeah"])) === false);
check("probe: 'Yeah, hello?' at pickup never fires (nothing finished yet)", G.windDownSignal(call(["Hey Jordan, good to catch you."], ["Yeah, hello?"])) === false && G.windDownSignal(call(["Hey Jordan, good to catch you."], ["Yeah, I agree. Hello?"])) === false);
check("probe: 'Okay... hello?' during a tool run or silence never fires", G.windDownSignal(call(["Hi", "Let me check that for you, one moment."], ["Hey", "Okay... hello?"])) === false && G.windDownSignal(call(["Hi", "Hang on, looking that up."], ["Hey", "Yeah, I agree. Hello?"])) === false);
check("probe: the hello reading is only after agreement plus hello (a plain hello after a finished point is still the line dropping)", G.windDownSignal(member("Tell me more", "Hello?")) === false && G.windDownSignal(member("Tell me more", "Hello, you there?")) === false);
check("the voice's hello rule keeps the line-dropped meaning and the closing exception", /say you're still here and pick up where you were/.test(src("prompts/co-system-prompt.md")) && /unless it comes right after they agreed with a point you had just finished/.test(src("prompts/co-system-prompt.md")));
check("signal: the thinking is told as a fact, not a command to hang up", /winding down/.test(G.WIND_DOWN_NOTE) && /Don't ask a new question or bring a topic back/.test(G.WIND_DOWN_NOTE));
check("question rhythm: noted only when Cue's last turn ended on a question", G.askedLastTurn(req("Hi", "What part grabbed you?", "The pricing")) === true && G.askedLastTurn(req("Hi", "That sounds like a solid plan.", "Thanks")) === false);
check("a lone short agreement after a statement gets the soft note; after a question it does not", G.agreedBriefly(member("Tell me more", "Yeah, I agree")) === true && G.agreedBriefly({ model: "x", messages: [{ role: "assistant", content: "Hi." }, { role: "user", content: "hey" }, { role: "assistant", content: "What part grabbed you?" }, { role: "user", content: "Yeah" }] } as any) === false && G.agreedBriefly(member("Tell me more", "Yeah, but what about the venue")) === false);
check("the signal is fed to the thinking every non-safety turn (turn notes)", /!safety0 && windDownSignal\(req\) \? WIND_DOWN_NOTE/.test(src("src/services/gptLive.ts")));


// ---------------------------------------------------------------- the review's fixes: fresh, not Cue's own, not cancelled, no other people
check("thread read: a stale open loop (past isDraftable's freshness) is not used", (await F.laterCallThread("u-jordan", fakeDb({ loops: ["STALE Plan the studio launch event"] }))) === null);
check("thread read: Cue's own offers and intros are never the thread", (await F.laterCallThread("u-jordan", fakeDb({ loops: ["Sent them the studio launch event list", "Intro to a studio launch event planner"] }))) === null);
check("thread read: their texts come only from the last 14 days", seenSql.some((q) => /User said:/.test(q.sql) && /created_at > \$2/.test(q.sql) && q.args?.[1] instanceof Date && Date.now() - (q.args[1] as Date).getTime() < 15 * 86_400_000 && Date.now() - (q.args[1] as Date).getTime() > 13 * 86_400_000));
check("thread: a cancellation is never the thread", F.threadLine([], ["We cancelled the studio launch event for now."]) === null && F.threadLine([], ["The studio launch event is off, we're no longer doing it."]) === null && F.threadLine(["Plan the studio launch event"], []) !== null);
check("thread: a topic they closed is not used (the exchange record's closed items)", F.threadLine([], ["We're planning the studio launch event for next month."], 160, ["Plan the studio launch event"]) === null && F.threadLine([], ["We're hiring two engineers for the startup."], 160, ["Plan the studio launch event"]) !== null);
check("thread read: a closed item from the exchange record keeps its topic out of the text fallback", (await F.laterCallThread("u-jordan", fakeDb({ texts: ["We're planning the studio launch event for next month."], closed: ["Plan the studio launch event"] }))) === null);
check("thread: nothing fresh, no thread, and the opening still avoids the stock opener", G.buildLiveCall({ ...base, direction: "inbound", first: { firstCall: false }, thread: null }).instructions.includes(G.OPEN_NO_MIND));
check("thread: a line that names another person is dropped", F.threadLine(["Plan the launch event with Dana"], ["I'm hiring two engineers with Noor at the startup"]) === null && F.threadLine(["Plan the launch event with my cofounder"], []) === null);
check("sensitive: visa, immigration, court, custody, lawsuit, divorce, eviction and similar never reach an opening", ["Renewing my visa before the new job", "Immigration lawyer for the move to Oakland for work", "Court date next week before the launch", "Custody hearing and the new job", "The lawsuit over the studio", "Divorce is final so moving for work", "Eviction notice at the studio"].every((t) => SENSITIVE.test(t) && F.threadLine([t], [t]) === null));
check("sensitive: ordinary work lines still pass", F.threadLine(["Plan the studio launch event"], []) !== null);
check("outbound: the thread is read only when they asked for the call (member_asked) or it is inbound", /o\.direction === "inbound" \|\| \(await import\("\.\.\/services\/callReason\.js"\)\.then\(\(m\) => m\.heldCallReason\(o\.userId\)\?\.result\.reason\?\.kind === "member_asked"/.test(src("src/routes/co.ts")) && /\.firstCall \|\| !memberAsked \? null/.test(src("src/routes/co.ts")));
// callClosing after a goodbye
const P = await import("../../src/services/callLlmProxy.js");
const bye = (reply: string) => ({ model: "x", messages: [{ role: "assistant", content: "Good luck with the launch. Talk soon, Jordan." }, { role: "user", content: reply }] }) as any;
check("callClosing: a reply to Cue's goodbye still closes in any words", P.callClosing(bye("You too.")) === true && P.callClosing(bye("Thanks, bye")) === true && P.callClosing(bye("Okay")) === true);
check("callClosing: a new question or topic after a goodbye keeps the call going", P.callClosing(bye("Wait, what about step three?")) === false && P.callClosing(bye("Actually one more thing about the venue")) === false && P.callClosing(bye("Hold on, can you resend that?")) === false);
check("callClosing: their own goodbye still closes", P.callClosing(bye("Wait, bye!")) === true);

console.log(`call feel: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
