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
check("outbound voicemail never carries it (the instructions hold none of it)", !/Where you left off with them/.test(laterOut.instructions));
check("no thread, no line (as before)", !G.buildLiveCall({ ...base, direction: "inbound" }).instructions.includes("Where you left off with them") && G.heldOpeningNote(G.buildLiveCall({ ...base, direction: "outbound", callReason: "R." }).opening) === G.reasonNote("R."));
check("a first call keeps its own words, not a thread", !G.buildLiveCall({ ...base, direction: "inbound", first: { firstCall: true, theirWords: "gave notice, last day the 21st", emailOnFile: false }, thread: line }).instructions.includes("Where you left off with them"));
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
  check("runtime cap: over the cap, the thread is dropped first and the prompt fits", !over.includes("Where you left off with them") && over.length < G.GPT_LIVE.maxInstructionChars, over.length);
  console.log(`worst-case instructions: later ${worst.instructions.length}, first ${worstFirst.instructions.length} of ${G.GPT_LIVE.maxInstructionChars}`);
}

// ---------------------------------------------------------------- 2-5. the prompt lines
for (const [label, c] of [["inbound", laterIn], ["outbound", laterOut]] as const) {
  check(`${label}: GPT-Live has both feel lines`, G.LIVE_FEEL.length === 2 && G.LIVE_FEEL.every((l) => c.instructions.includes(l)));
  check(`${label}: the thinking has the feel guidance`, c.backendSystem.includes(G.BACKEND_FEEL));
  check(`${label}: nothing GPT-Live may never say`, !G.GPT_LIVE_FORBIDDEN.some((re) => re.test(c.backendSystem) || re.test(c.instructions)));
}
check("opinions: the thinking (which answers any ask for advice or a read) gives an opinion and its reason, never a verdict", /opinion and the reason/.test(G.BACKEND_FEEL) && /never state their feelings or motives as fact/.test(G.BACKEND_FEEL));
check("moment: light and brief when with others, hi, or short on time", /with other people, just saying hi, or short on time/.test(G.BACKEND_FEEL));
check("texts keep the family (call-only change): the shared stock list does not flag it", stockLine("Hey Jordan, what's on your mind tonight?") === null);

// ---------------------------------------------------------------- the wind-down signal
const req = (...t: string[]) => ({ model: "x", messages: t.flatMap((x, i) => (x ? [{ role: i % 2 === 0 ? "user" : "assistant", content: x }] : [])) }) as any;
// A call: Cue's opening, then (member, Cue) pairs, ending on the member's last line. cues[i] is what Cue said before members[i].
const call = (cues: string[], members: string[]) => ({ model: "x", messages: members.flatMap((m, i) => [{ role: "assistant", content: cues[i] }, { role: "user", content: m }]) }) as any;
const STATE = "That plan holds up, and the venue is the right size.";
const member = (...m: string[]) => call(m.map(() => STATE), m);
check("signal: two short agreements in a row after finished points (the real wrap-up)", G.windDownSignal(member("Yeah, I agree.", "Yeah, I agree")) === true);
check("signal: thanks after an agreement", G.windDownSignal(member("Totally", "Thanks")) === true);
check("signal: not on one bare yeah or thanks (they may go on)", G.windDownSignal(member("Tell me more", "Yeah")) === false && G.windDownSignal(member("Tell me more", "Thanks")) === false);
check("signal: not when either turn says more", G.windDownSignal(member("Yeah, I agree, but what about the venue", "Yeah")) === false && G.windDownSignal(member("Yeah I agree", "Okay so what do I do about Ellis")) === false);
check("signal: only the last two of their turns count", G.windDownSignal(member("Yeah", "Yeah", "Tell me about the studio launch plan")) === false);
// The review's probes, each one that must NOT fire:
check("probe: walkthrough 'Okay.' / 'Right.' never fires", G.windDownSignal(member("Okay.", "Right.")) === false && G.windDownSignal(member("Okay", "Okay")) === false);
check("probe: 'Mm-hmm' / 'Uh huh' never fires", G.windDownSignal(member("Mm-hmm", "Uh huh")) === false && G.windDownSignal(member("Mm-hmm.", "Mhm")) === false);
check("probe: 'No.' / 'No, no.' answers never fire", G.windDownSignal(member("No.", "No, no.")) === false && G.agreedBriefly(call(["Hi", STATE], ["Hey", "No."])) === false);
check("probe: a yes to an offer never fires", G.windDownSignal(call(["Hi", "Want me to text you the list?"], ["Hey", "Yeah"])) === false && G.windDownSignal(call(["Want me to send it?", "Want me to send it too?"], ["Yeah", "Yes, please"])) === false && G.agreedBriefly(call(["Hi", "Want me to text you the list?"], ["Hey", "Yeah"])) === false);
check("probe: an agreement to a question never fires", G.windDownSignal(call(["Hi", "Does Thursday work?"], ["Hey", "Yeah, I agree"])) === false);
check("probe: a capped walkthrough ('say go on') never fires", G.windDownSignal(call(["Step one, open settings. Step two, tap the account. Say go on for the rest.", "Step three is the toggle, then save. Say go on when you're ready."], ["Yeah", "Yeah, I agree"])) === false && G.agreedBriefly(call(["Hi", "Step two, tap the account. Say go on for the rest."], ["Hey", "Yeah"])) === false);
check("a lone short agreement after a statement gets the soft note; after a question it does not", G.agreedBriefly(member("Tell me more", "Yeah, I agree")) === true && G.agreedBriefly({ model: "x", messages: [{ role: "assistant", content: "Hi." }, { role: "user", content: "hey" }, { role: "assistant", content: "What part grabbed you?" }, { role: "user", content: "Yeah" }] } as any) === false && G.agreedBriefly(member("Tell me more", "Yeah, but what about the venue")) === false);


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


// ---------------------------------------------------------------- Royce's revised call rules (2026-11-04), through the real functions
const P2 = await import("../../src/services/callLlmProxy.js");
const closes = (msgs: [string, string][]) => P2.callClosing({ model: "x", messages: msgs.map(([role, content]) => ({ role, content })) } as any);
// 1. "hello?" is not a closing signal
check("hello: never a closing signal, alone or after an agreement", G.windDownSignal(member("Tell me more", "Hello?")) === false && G.windDownSignal(member("Tell me more", "Yeah, I agree. Hello?")) === false && G.windDownSignal(member("Yeah", "Hello?")) === false);
check("hello: it doesn't close the call", closes([["assistant", "That plan holds up."], ["user", "Hello?"]]) === false && closes([["assistant", "Hi."], ["user", "Yeah, I agree"], ["assistant", "Good."], ["user", "Yeah, I agree. Hello?"]]) === false);
check("hello: the rule says acknowledge, answer what was unclear, don't repeat the last point or assume they're done, in the voice, the thinking and the prompt", [G.LIVE_VOICE_RULES.map((r) => r.line + (r.end ?? "")).join(" "), G.BACKEND_FEEL, src("prompts/co-system-prompt.md")].every((t) => /hello/i.test(t) && /answer what was unclear/.test(t) && /(?:repeat your last point|assume they're done)/.test(t)) && !/pick up where you were/.test(src("prompts/co-system-prompt.md")));
check("hello: no closing guidance mentions it as a sign of being done", !G.LIVE_FEEL.some((l) => /hello/i.test(l)) && !/agree and then say/.test(G.BACKEND_FEEL) && !/hello/i.test(G.WIND_DOWN_NOTE));
// 2. short agreements, thanks and "I'm good" are read in context
check("I'm good after 'how are you?' does not close or signal", closes([["assistant", "Hey Jordan. How are you?"], ["user", "I'm good"]]) === false && G.windDownSignal(call(["Hi", "Hey Jordan. How are you?"], ["Hey", "I'm good"])) === false);
check("'I'm good, that's all' is a soft cue, and a soft one", G.windDownSignal(member("Tell me more", "I'm good, that's all")) === true && /may be wrapping up/.test(G.WIND_DOWN_NOTE) && /if not, carry on as usual/.test(G.WIND_DOWN_NOTE) && !/\b(?:end the call|goodbye)\b/i.test(G.WIND_DOWN_NOTE));
check("a mid-call 'thanks' is not a close", closes([["assistant", "The venue is the right size."], ["user", "Thanks"]]) === false && G.windDownSignal(member("Tell me more", "Thanks")) === false);
check("an explicit end request closes with no confirmation", closes([["assistant", "The venue is the right size."], ["user", "We could end the call."]]) === true && closes([["assistant", "Anything else?"], ["user", "Let's end the call"]]) === true && closes([["assistant", "Hi."], ["user", "Okay, hang up now"]]) === true && /needs no confirmation/.test(G.BACKEND_FEEL));
check("a reply after Cue's guessed goodbye continues the call", closes([["user", "Yeah, I agree"], ["assistant", "Good luck with it. Talk soon, Jordan."], ["user", "Okay"]]) === false && closes([["user", "Thanks"], ["assistant", "Take care, Jordan."], ["user", "Wait, what about step three?"]]) === false);
check("a reply to Cue's goodbye answering THEIR goodbye closes", closes([["user", "Alright, gotta go, bye"], ["assistant", "Take care, Jordan."], ["user", "You too"]]) === true && closes([["user", "ok bye"], ["assistant", "Talk soon, Jordan."], ["user", "Actually, one more thing?"]]) === false);
check("if they speak again while Cue is closing: listen and answer (voice and thinking)", /if they speak, listen/.test(G.LIVE_FEEL[1]) && /if they speak again while you're closing, listen and answer/.test(G.BACKEND_FEEL));
check("silence and connection loss stay separate from social closing cues", !/silence|connection|dropped line/.test(G.WIND_DOWN_NOTE) && /If someone goes quiet/.test(G.LIVE_VOICE_RULES.map((r) => r.line).join("\n")));
// 3. no every-other-turn rule, no note for it
check("no every-other-turn question rule or last-turn question note remains", !/every other turn/.test(G.LIVE_FEEL.join(" ") + G.BACKEND_FEEL + G.BACKEND_NOTE) && (G as any).askedLastTurn === undefined && (G as any).NO_QUESTION_NOTE === undefined && !/NO_QUESTION_NOTE|askedLastTurn/.test(src("src/services/gptLive.ts")));
check("questions: ask when the answer helps, one at a time, never again in other words, never just to keep the call going, never block a needed one", /Ask when the answer helps, one question at a time/.test(G.BACKEND_FEEL) && /never the same question again in other words/.test(G.BACKEND_FEEL) && /just to keep the call going/.test(G.BACKEND_FEEL) && /never hold back one you need/.test(G.BACKEND_FEEL) && /never again in other words/.test(G.LIVE_FEEL[0]));
// 4. where we left off is optional background
check("where we left off: optional background, only if relevant and fine to say aloud, no quick-hi drag-back, no assumption it still holds", /optional background/.test(G.OPEN_NO_MIND) && /fine to say aloud/.test(G.OPEN_NO_MIND) && /a quick hi stays a quick hi/.test(G.OPEN_NO_MIND) && /background only/.test(G.threadNote("x")) && /to pull them back if they start somewhere new/.test(G.threadNote("x")) && /never assume it still holds/.test(G.BACKEND_FEEL));
// 5. don't re-ask what was answered (guidance; the sentence-level re-ask hold already exists in callSentenceMiss)
check("re-asking: guidance to clarify only the gap, respect a decline, carry corrections; the existing re-ask hold is still wired", /ask only for that gap/.test(G.BACKEND_FEEL) && /if they decline or move on, respect it/.test(G.BACKEND_FEEL) && /carry their corrections forward/.test(G.BACKEND_FEEL) && /callSentenceMiss/.test(src("src/services/callLlmProxy.ts")));
// 6. a closing commitment is kept, and nothing is invented to fill the line
const CC = await import("../../src/services/callCommitments.js");
const CG = await import("../../src/harness/callGrounding.js");
const closingLine = "Good luck with the launch, Jordan. I'll text you the venue list tomorrow.";
check("a closing commitment is picked up as a commitment to keep (the call's follow-through)", CC.commitmentsIn([closingLine]).length === 1 && /venue list/.test(CC.commitmentsIn([closingLine])[0]) && CC.commitmentProblem(CC.commitmentsIn([closingLine])[0]) === null);
check("...and it opens a task through the after-call path, never nothing", CG.promiseOpens({ coveredBy: null, asked: "send me the venue list" }) === "their_ask" && CG.promiseOpens({ coveredBy: null, asked: null }) === "promise_thread" && CG.promiseOpens({ coveredBy: 3, asked: null }) === "task_from_call");
{
  const co = src("src/routes/co.ts");
  const post = co.slice(co.indexOf("export async function runGptLivePostCall"));
  const ended = co.slice(co.indexOf("async function processEndedCall"));
  check("...and a GPT-Live call's end reaches that path (post-call -> processEndedCall -> tasksFromCall + auditCall -> keepCallPromise)", /processEndedCall\(/.test(post.slice(0, post.indexOf("\n}\n"))) && /tasksFromCall\(/.test(ended) && /auditCall\(/.test(ended) && /keepCallPromise\(/.test(src("src/harness/callGrounding.ts")));
}
check("a goodbye is not proof the request was done, and no invented takeaway or promise fills the closing line", /a goodbye is not proof their request is done/.test(G.BACKEND_FEEL) && /Don't invent a takeaway or a promise to fill the closing line/.test(G.BACKEND_FEEL) && /Never fill the closing line with a takeaway or promise you won't keep/.test(src("prompts/co-system-prompt.md")));
check("the mid-call notes are reminders of the same rules, never stronger (no 'end the call', no 'goodbye', no 'must')", [G.WIND_DOWN_NOTE, G.AGREED_NOTE].every((n) => !/\b(?:end the call|goodbye|must|never ask|don't ask)\b/i.test(n)));

console.log(`call feel: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
