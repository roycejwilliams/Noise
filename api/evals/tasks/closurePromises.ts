// Closure audit 11-02, items 1 and 2: a promise is kept only by a send after its own turn, and a promise to bring something up
// goes out at its window (or says once that it's late), never slips quietly and never closes as done without a send.
//   1. promiseKeptBy counted Cue's own promise sentence (task 1089, 2 s after its row) and the turn's own acknowledgment (task 1096)
//      as the send that kept it. Both real "kept" promises on dev sent nothing.
//   2. "Bring it up tomorrow afternoon" moved quietly six times in seven days, then closed as done with no text.
// The two real shapes are here with invented names and words. Layer 1: pinned clock, stubbed store, the model scripted inside this
// process (a fake Anthropic endpoint), zero tokens.   npx tsx evals/tasks/closurePromises.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

type Answer = { tool: string; input: any } | { text: string };
const script: Answer[] = [];
const seen: any[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  try { seen.push(JSON.parse(init?.body ?? "{}")); } catch { seen.push({}); }
  const a = script.shift() ?? { text: "Nothing more." };
  const usage = { input_tokens: 0, output_tokens: 0 };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${seen.length}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: `msg_${seen.length}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const M = await import("../../src/services/memberTime.js");
const TT = await import("../../src/services/taskTurn.js");
const FT = await import("../../src/services/followThrough.js");
const L = await import("../../src/services/commitmentLog.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const SF = "America/Los_Angeles";
const sec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const text = (at: Date, t: string, forThis = false) => ({ at, text: t, kind: "text" as const, ...(forThis ? { forThis } : {}) });

// ---- shape 1 (task 1089): a promise to bring something up; its own sentence went out 2 s after the task row
const T1 = new Date("2026-10-21T23:46:40Z"); // Wed 4:46pm in San Francisco
const GOAL1 = 'Keep your promise: "I\'ll bring it back up tomorrow afternoon."';
const THEIRS1 = "Bring this up to me again tmrw afternoon thanks";
const PROMISE1 = text(sec(T1, 2), "Sounds good, I'll bring it back up tomorrow afternoon.");
// ---- shape 2 (task 1096): a promise of something real; the reply's acknowledgment went out 6 to 9 s after the task row
const T2 = new Date("2026-10-28T22:45:29Z");
const GOAL2 = 'Keep your promise: "I\'ll text you when something real turns up on either one."';
const THEIRS2 = "Quick update so you're looking for the right things. The rooftop launch is off, so drop that. I work days while Sam and I build our startup, so my time is evenings and weekends. The main goal is funding so I can go full time: investors and accelerators that back consumer apps";
const ACK2 = [text(sec(T2, 6), "Got it, the rooftop launch is off my list."), text(sec(T2, 8), "Dropping it, and pointing search at two things now: investor and accelerator programs backing consumer apps, and small founder dinners that fit evenings and weekends."), text(sec(T2, 9), "I'll text you when something real turns up on either one.")];

// ======================================================================= 1. a promise is kept only by a send after its own turn
{
  const p1 = { goal: GOAL1, theirWords: THEIRS1, at: T1 };
  const v1 = FT.promiseKeptBy(p1, [PROMISE1]);
  check("shape 1: the promise sentence itself (2 s after the row) never keeps it", !v1.kept && /promise being made/.test(v1.why), v1);
  const p2 = { goal: GOAL2, theirWords: THEIRS2, at: T2 };
  const v2 = FT.promiseKeptBy(p2, ACK2);
  check("shape 2: the turn's own acknowledgment (6 to 9 s after the row) never keeps it", !v2.kept, v2);
  check("the promise said again a day later doesn't keep it either", !FT.promiseKeptBy(p1, [PROMISE1, text(new Date("2026-10-22T18:00:00Z"), "I'll bring it back up tomorrow afternoon.")]).kept);
  check("the task's own text saying it again doesn't keep it", !FT.promiseKeptBy(p1, [text(new Date("2026-10-22T23:30:00Z"), "Sounds good, I'll bring it back up tomorrow afternoon.", true)]).kept);
  const bringUp = text(new Date("2026-10-22T23:30:00Z"), "Picking the paralegal search back up, like you asked: still after roles that don't ask for a transcript?", true);
  check("shape 1: a later bring-up by the task keeping it does keep it", FT.promiseKeptBy(p1, [PROMISE1, bringUp]).kept);
  check("shape 2: a later delivery about it does keep it", FT.promiseKeptBy(p2, [...ACK2, text(new Date("2026-10-29T22:31:00Z"), "Harbor Angels is an investor group backing pre-seed consumer apps; applications are open on their site.")]).kept);
  check("a bring-up promise isn't kept by another text that only shares a word with it ('back', 'tomorrow')", !FT.promiseKeptBy(p1, [PROMISE1, text(new Date("2026-10-22T18:00:00Z"), "Welcome back! The tasting is tomorrow afternoon at four, by the way.")]).kept);
  const unrelated = text(new Date("2026-10-28T15:00:28Z"), "Been thinking about your client's hearing. How's it going?");
  check("shape 1: a later unrelated text doesn't keep it", !FT.promiseKeptBy(p1, [PROMISE1, unrelated]).kept);
  check("shape 2: a later unrelated text doesn't keep it", !FT.promiseKeptBy(p2, [...ACK2, text(new Date("2026-10-30T16:00:00Z"), "How did the dentist appointment go this morning?")]).kept);
  check("the promise's turn is a reply's, not a call's: a call promise is kept by the owed send right after its task row", FT.promiseKeptBy({ goal: 'Keep your word from the call: "I\'ll text you those links."', at: T1 }, [{ at: sec(T1, 20), text: "https://lu.ma/x", kind: "link" }]).kept);
  check("the turn's span is the one constant, and only a reply promise has one", FT.PROMISE_TURN_MS === 60_000 && FT.promiseTurnEnd(GOAL1, T1).getTime() === T1.getTime() + 60_000 && FT.promiseTurnEnd('Keep your word from the call: "x"', T1).getTime() === T1.getTime());

  // The task runner's close: finish(done) on shape 2 is refused (the model claimed "sent X", and nothing after its turn sent it).
  const task2: any = { goal: GOAL2, theirWords: THEIRS2, createdAt: T2.toISOString(), source: "promise" };
  const refused = await TT.promiseCloseCheck(task2, [], { now: () => new Date("2026-10-29T22:31:00Z"), sentSince: async () => ACK2 });
  check("shape 2: the close check refuses finish(done)", !refused.ok, refused);
  const task1: any = { goal: GOAL1, theirWords: THEIRS1, createdAt: T1.toISOString(), source: "promise" };
  check("shape 1: the close check refuses finish(done)", !(await TT.promiseCloseCheck(task1, [], { now: () => new Date("2026-10-28T15:01:00Z"), sentSince: async () => [PROMISE1, unrelated] })).ok);
  check("a task that isn't a promise closes as before", (await TT.promiseCloseCheck({ ...task2, source: "ask" }, [], { now: () => new Date(), sentSince: async () => [] })).ok);
  check("a done close with nothing sent never logs kept: it stays open, and an expired promise logs missed", L.outcomeOf("expired", "Ran out of wake-ups or days.") === "missed");
  check("the real turn reads the task's own earlier texts as its own (proactive_sends task:<id>:)", /sentSince: \(since\) => sendsSince\(userId, since, task\.id\)/.test(src("services/taskTurn.ts")) && /starts_with\(target_key, \$2\)/.test(src("services/followThrough.ts")));
}

// ======================================================================= the turn harness
const zoneTask = (over: any = {}): any => ({
  id: 1089, userId: "u-test", goal: GOAL1, theirWords: THEIRS1,
  steps: [{ text: "Do what you said, or tell them plainly where it stands", done: false }], planNext: "Do what you promised them", nextCheckAt: null, status: "open", wakes: 1, notes: [{ at: T1.toISOString(), text: "Started." }], textsSent: 0, lastTextedAt: null,
  createdAt: T1.toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "promise",
  window: M.commitmentWindow("I'll bring it back up tomorrow afternoon.", T1, SF), ...over,
});
const THREAD = [
  "[Wed Oct 21, 4:45pm PDT] User said: any paralegal roles that don't ask for a transcript?",
  "[Wed Oct 21, 4:46pm PDT] Co replied: Nothing came back that says no transcript required; firms don't really advertise that.",
  "[Wed Oct 21, 4:46pm PDT] User said: Bring this up to me again tmrw afternoon thanks",
  "[Wed Oct 21, 4:46pm PDT] Co replied: Sounds good, I'll bring it back up tomorrow afternoon.",
].join("\n");
const BRING_UP = "Picking the paralegal search back up, like you asked: still after roles that don't ask for a transcript, or is the transcript itself the snag?";
function harness(clock: Date, o: { send?: (m: string[]) => Promise<{ sent: boolean; reason?: string }>; textsToday?: number; sentSince?: () => Promise<any[]> } = {}) {
  const log = { texts: [] as string[], windows: [] as any[], at: [] as Date[], scheduled: [] as number[], closed: [] as string[] };
  const deps: any = {
    person: { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco" }, recent: THREAD, zone: SF,
    note: async () => {},
    schedule: async (h: number) => { log.scheduled.push(h); return new Date(clock.getTime() + h * 3_600_000).toISOString(); },
    scheduleAt: async (at: Date) => { log.at.push(at); return at.toISOString(); },
    close: async (s: string, out: string) => { log.closed.push(`${s}: ${out}`); },
    textsToday: async () => o.textsToday ?? 0, markTexted: async () => {}, markFinalTold: async () => {},
    send: o.send ?? (async (m: string[]) => { log.texts.push(...m); return { sent: true }; }),
    search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: false, facts: [], text: "" }),
    now: () => clock, sentSince: o.sentSince ?? (async () => [PROMISE1]),
    setWindow: async (w: any) => { log.windows.push(w); },
  };
  return { deps, log };
}
// One wake where the task model calls no tool (the 10-22 to 10-27 wakes: the model call came back with nothing), then the draft.
const wake = (draft: string | null) => {
  script.length = 0;
  script.push({ text: '{"done": false, "quote": null}' }, { text: "Nothing more." });
  if (draft !== null) script.push({ text: draft }, { text: draft });
  else script.push({ text: "SKIP" }, { text: "SKIP" });
};
const draftPrompts = () => seen.map((b) => JSON.stringify(b)).filter((s) => /taskTurn\.tell|CONFIRMED_FACTS/.test(s));

// ======================================================================= 2. a reminder-type promise goes out at its window
{
  check("the promise is to bring it up (Cue's own sentence), and another kind isn't", FT.reminderPromise({ source: "promise", goal: GOAL1 }) && FT.reminderPromise({ source: "promise", goal: 'Keep your promise: "I\'ll remind you Friday morning."' }) && !FT.reminderPromise({ source: "promise", goal: GOAL2 }) && !FT.reminderPromise({ source: "ask", goal: GOAL1 }));
  check("the task prompt tells Cue the text that brings it up is the delivery", /WHAT YOU PROMISED IS TO BRING IT UP AGAIN/.test(TT.taskTurnPrompt({ task: zoneTask(), firstName: "Jordan", now: "Thu Oct 22, 4:30pm PDT", zone: SF, recent: THREAD })) && !/BRING IT UP AGAIN/.test(TT.taskTurnPrompt({ task: zoneTask({ goal: GOAL2 }), firstName: "Jordan", now: "x", zone: SF, recent: "" })));

  // The slip loop, at its window: 4:30pm their time the next day, the model calls no tool. Before: the window moved quietly to
  // "tomorrow morning" and nothing went. Now: one text brings it up, and the promise closes itself as kept.
  const at = new Date("2026-10-22T23:30:00Z");
  seen.length = 0;
  wake(BRING_UP);
  const h = harness(at);
  const r = await TT.runTaskTurnWith(zoneTask(), h.deps);
  check("in its window, a stub model that calls no tool: one text goes", h.log.texts.length === 1 && h.log.texts[0] === BRING_UP, { did: r.did, texts: h.log.texts });
  check("...and the promise closes as kept, by that send", h.log.closed.length === 1 && /^done: Kept: brought it up/.test(h.log.closed[0]) && r.action === "finished", h.log.closed);
  check("...with no quiet move of its window", h.log.windows.length === 0 && !r.did.some((d) => /moved quietly/.test(d)), r.did);
  check("...drafted from facts that include their own thread (not a scripted line)", draftPrompts().some((p) => /their_recent_thread/.test(p) && /paralegal roles/.test(p)) && !draftPrompts().some((p) => /later than you said/.test(p)));

  // Past its window (the earlier wakes were lost): it goes now and says once, plainly, that it's late.
  seen.length = 0;
  wake(BRING_UP);
  const late = harness(new Date("2026-10-23T15:00:00Z")); // 8am their time, the next morning
  const rl = await TT.runTaskTurnWith(zoneTask(), late.deps);
  check("past its window: one text, closed as kept", late.log.texts.length === 1 && late.log.closed.length === 1 && /^done:/.test(late.log.closed[0]), { did: rl.did, closed: late.log.closed });
  check("...and the draft is told to own that it's late, once, with no time named", draftPrompts().some((p) => /later than you said/.test(p) && /no excuse, reason or time/.test(p)));
  // A window moved before (by an older build, quietly): still late against the time Cue first said.
  const moved = M.rescheduledWindow(new Date("2026-10-23T19:00:00Z"), new Date("2026-10-22T23:30:00Z"), SF, zoneTask().window).window;
  seen.length = 0;
  wake(BRING_UP);
  const hm = harness(new Date(new Date(moved.warnBy).getTime() - 10 * 60_000));
  await TT.runTaskTurnWith(zoneTask({ window: moved }), hm.deps);
  check("a window an older build moved quietly is late against the first time Cue said", hm.log.texts.length === 1 && draftPrompts().some((p) => /later than you said/.test(p)));

  // Before its window's last good moment: nothing is said early; the next check moves into the window.
  wake(BRING_UP);
  const early = harness(new Date("2026-10-22T17:00:00Z")); // 10am their time
  const re = await TT.runTaskTurnWith(zoneTask(), early.deps);
  const lastGood = new Date(new Date(zoneTask().window.warnBy).getTime() - 10 * 60_000);
  check("hours before the window's end: no text yet, and the next check lands inside the window, not tomorrow", early.log.texts.length === 0 && early.log.closed.length === 0 && early.log.at.length === 1 && early.log.at[0].getTime() === lastGood.getTime() && early.log.windows.length === 0, { did: re.did, at: early.log.at });

  // A gate delays it, never marks it done: their quiet hours. 10:30pm their time, past the window.
  wake(BRING_UP);
  const night = harness(new Date("2026-10-23T05:30:00Z"));
  const rn = await TT.runTaskTurnWith(zoneTask(), night.deps);
  check("quiet hours: nothing sent, not closed", night.log.texts.length === 0 && night.log.closed.length === 0, rn.did);
  check("...it tries again at their 8am, and the slip says why (never 'moved quietly')", night.log.at.some((d) => d.toISOString() === "2026-10-23T15:00:00.000Z") && rn.did.some((d) => /reminder: not sent \(outside their hours\)/.test(d)) && !rn.did.some((d) => /moved quietly/.test(d)), { did: rn.did, at: night.log.at });

  // The daily task-update cap never holds a promise's first text (it's the delivery: Royce, 2026-10-08), so it goes.
  wake(BRING_UP);
  const capped = harness(new Date("2026-10-22T23:30:00Z"), { textsToday: 2 });
  await TT.runTaskTurnWith(zoneTask(), capped.deps);
  check("the update cap doesn't hold the delivery itself", capped.log.texts.length === 1);
  // The send itself fails (10-22: Sendblue answered 401): not sent, not done, tried again with the reason logged.
  wake(BRING_UP);
  const err = harness(new Date("2026-10-22T23:30:00Z"), { send: async () => ({ sent: false, reason: "401 Invalid Credentials" }) });
  const rc = await TT.runTaskTurnWith(zoneTask(), err.deps);
  check("a failed send: nothing closed, tried again, the slip says why", err.log.closed.length === 0 && err.log.at.length >= 1 && rc.did.some((d) => /reminder: not sent \(Couldn't send: 401/.test(d)), rc.did);

  // A failed draft (the model gave nothing): not sent, not done, tried again; the next wake that can draft sends it, once, late.
  wake(null);
  const f1 = harness(new Date("2026-10-22T23:30:00Z"));
  const rf = await TT.runTaskTurnWith(zoneTask(), f1.deps);
  check("a failed draft: nothing sent, never closed as done", f1.log.texts.length === 0 && f1.log.closed.length === 0 && rf.did.some((d) => /reminder: not sent/.test(d)), rf.did);
  check("...its next check is set and its window moves, with the slip logged", f1.log.at.length >= 1 && f1.log.windows.length === 1);
  seen.length = 0;
  wake(BRING_UP);
  const f2 = harness(new Date(f1.log.at[f1.log.at.length - 1]));
  await TT.runTaskTurnWith(zoneTask({ window: f1.log.windows[0] }), f2.deps);
  const rf2 = await Promise.resolve(f2.log);
  check("...and the next wake brings it up once, saying it's late", f2.log.texts.length === 1 && /^done:/.test(f2.log.closed[0] ?? "") && draftPrompts().some((p) => /later than you said/.test(p)), { log: rf2, at: f1.log.at, w: f1.log.windows[0], did: rf.did });

  // Never twice: the bring-up went on an earlier wake (its own text), and that wake didn't close it. The next wake closes it.
  wake(BRING_UP);
  const twice = harness(new Date("2026-10-23T16:00:00Z"), { sentSince: async () => [PROMISE1, text(new Date("2026-10-22T23:30:05Z"), BRING_UP, true)] });
  await TT.runTaskTurnWith(zoneTask(), twice.deps);
  check("brought up on an earlier wake: nothing sent again, closed as kept", twice.log.texts.length === 0 && twice.log.closed.length === 1 && /^done: Kept: it was already brought up/.test(twice.log.closed[0]), twice.log);

  // They opted out: the send path refuses, and the task stops (dropped on their STOP, logged as released), never done.
  wake(BRING_UP);
  const stop = harness(new Date("2026-10-22T23:30:00Z"), { send: async () => ({ sent: false, reason: "opted out" }) });
  const rs = await TT.runTaskTurnWith(zoneTask(), stop.deps);
  check("opted out: no text, closed as dropped on their opt-out, not done", stop.log.closed.length === 1 && stop.log.closed[0] === "dropped: Member opted out or archived." && rs.action === "finished", stop.log.closed);
  check("...which the ledger counts as released, never kept", L.outcomeOf("dropped", "Member opted out or archived.") === "released");
  check("...and no retry is scheduled", stop.log.at.length === 0 && stop.log.windows.length === 0);

  // finish(done) with nothing sent after the promise's turn (the 10-28 wake): refused; the bring-up goes instead.
  seen.length = 0;
  script.length = 0;
  script.push({ text: '{"done": false, "quote": null}' }, { tool: "finish", input: { outcome: "Brought it back up as promised.", status: "done" } }, { text: "Nothing more." }, { text: BRING_UP }, { text: BRING_UP });
  const fin = harness(new Date("2026-10-28T15:00:00Z"), { sentSince: async () => [PROMISE1, unrelatedText()] });
  const rfin = await TT.runTaskTurnWith(zoneTask(), fin.deps);
  check("finish(done) with nothing sent after the promise's turn is refused", rfin.did.some((d) => /^finish refused/.test(d)), rfin.did);
  check("...and the bring-up goes instead, then it closes as kept", fin.log.texts.length === 1 && fin.log.closed.length === 1 && /^done: Kept: brought it up/.test(fin.log.closed[0]), { texts: fin.log.texts, closed: fin.log.closed, did: rfin.did });
}
function unrelatedText() { return text(new Date("2026-10-28T15:00:28Z"), "Been thinking about your client's hearing. How's it going?"); }

// ======================================================================= 3. a promise that isn't a reminder keeps its quiet move
{
  wake(null);
  const h = harness(new Date("2026-10-29T22:30:00Z"), { sentSince: async () => ACK2 });
  const r = await TT.runTaskTurnWith(zoneTask({ id: 1096, goal: GOAL2, theirWords: THEIRS2, createdAt: T2.toISOString(), window: M.commitmentWindow("within a day", T2, SF) }), h.deps);
  check("an empty turn on a find promise sends nothing (no progress report), as before", h.log.texts.length === 0 && h.log.closed.length === 0 && !r.did.some((d) => /^reminder/.test(d)), r.did);
}

console.log(`closurePromises: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
