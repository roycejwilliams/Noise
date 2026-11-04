// Commitment windows in member-local time, early warnings, and promised documents sent as documents (Royce, 2026-10-08):
//   "Every commitment carries a window in member-local time, and a miss warns BEFORE the window passes."
//   "A promised plan or doc goes through writeDocument (a PDF, or a Docs link per the existing gates), never as a wall of text."
// Layer 1: pinned clock, stubbed store, and the model scripted here (a fake Anthropic endpoint inside this process), so nothing
// depends on the canned stub and no token is spent.
//   npx tsx evals/tasks/windows.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

// ---- the model, scripted: each Anthropic call takes the next answer (a tool call or plain text); none left = "Nothing more."
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
const CT = await import("../../src/services/coTasks.js");
const FT = await import("../../src/services/followThrough.js");
const CC = await import("../../src/services/callCommitments.js");
const OL = await import("../../src/services/openLoops.js");
const { narratesInternalState } = await import("../../src/services/speakable.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const SF = "America/Los_Angeles";
const local = (iso: string | Date, zone = SF) => new Date(iso).toLocaleString("en-US", { timeZone: zone, hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// ======================================================================= 1. "tonight" and friends, in member-local time
{
  const evening = new Date("2026-10-08T02:30:00Z"); // Wed Oct 7, 7:30pm in San Francisco
  const w = M.commitmentWindow("I'll text you the options tonight.", evening, SF);
  check("tonight at 7:30pm SF: the window is that night, in SF time", w.words === "tonight" && local(w.deadline) === "10/07, 23:59" && w.stated, { w, d: local(w.deadline) });
  check("...and the warn-by is the last texting moment before 9pm, less the cron margin (8:40pm)", local(w.warnBy) === "10/07, 20:40", local(w.warnBy));
  check("the case: a next check 3h out (10:30pm) lands past it", M.missesWindow(w, new Date(evening.getTime() + 3 * 3_600_000), evening));
  check("a next check at 7:35pm does not", !M.missesWindow(w, new Date(evening.getTime() + 5 * 60_000), evening));

  const late = new Date("2026-10-08T05:30:00Z"); // 10:30pm SF
  const wl = M.commitmentWindow("I'll text you the options tonight.", late, SF);
  check("late night (10:30pm): still tonight, ending at midnight", wl.words === "tonight" && local(wl.deadline) === "10/07, 23:59", local(wl.deadline));
  check("...with nothing textable left in it, the warn-by is the first moment they can be told: 8am", local(wl.warnBy) === "10/08, 08:00", local(wl.warnBy));

  const past = new Date("2026-10-08T07:30:00Z"); // 12:30am SF, Thursday
  const wm = M.commitmentWindow("I'll text you the options tonight.", past, SF);
  check("across midnight (12:30am): 'tonight' is the night under way (ends 5am), not the next evening", local(wm.deadline) === "10/08, 05:00", local(wm.deadline));
  const wt = M.commitmentWindow("I'll have it for you tomorrow.", past, SF);
  check("across midnight: 'tomorrow' is the day about to start (Thursday 9pm, the end of the 8am-9pm window), not Friday", local(wt.deadline) === "10/08, 21:00", local(wt.deadline));
  const wtm = M.commitmentWindow("I'll send it tomorrow morning.", evening, SF);
  check("'tomorrow morning' from the evening: by noon the next day", local(wtm.deadline) === "10/08, 12:00" && wtm.words === "tomorrow morning", local(wtm.deadline));

  const ny = M.commitmentWindow("I'll text you the options tonight.", new Date("2026-10-07T23:30:00Z"), "America/New_York");
  check("a New York member's tonight ends at midnight New York time, warn-by 8:40pm there", local(ny.deadline, "America/New_York") === "10/07, 23:59" && local(ny.warnBy, "America/New_York") === "10/07, 20:40", [local(ny.deadline, "America/New_York"), local(ny.warnBy, "America/New_York")]);

  const unk = M.commitmentWindow("I'll text you the options tonight.", evening, null);
  check("unknown zone: the words are read in the one fallback (Pacific)", M.FALLBACK_ZONE === SF && local(unk.deadline) === "10/07, 23:59" && unk.zone === null);
  check("unknown zone: the warn-by follows the send gate measured in Pacific (8am-9pm, 2026-10-08): 8:40pm Pacific, never a text the gate would block", new Date(unk.warnBy).toISOString() === "2026-10-08T03:40:00.000Z", unk.warnBy);
  check("unknown zone, invalid string: same fallback", M.commitmentWindow("tonight", evening, "Not/AZone").zone === null);

  const noon = new Date("2026-10-07T20:00:00Z"); // 1pm SF
  const hr = M.commitmentWindow("I'll send it in an hour.", noon, SF);
  check("'in an hour' at 1pm: due 2pm, warn by 1:40pm", local(hr.deadline) === "10/07, 14:00" && local(hr.warnBy) === "10/07, 13:40", [local(hr.deadline), local(hr.warnBy)]);
  const fri = M.commitmentWindow("I'll get you a couple of options by Friday.", noon, SF);
  check("'by Friday' (said Wednesday): Friday 9pm their time (the end of the window)", local(fri.deadline) === "10/09, 21:00" && fri.words === "by Friday", local(fri.deadline));
  const def = M.commitmentWindow("I'll send that over.", noon, SF);
  check("no window said: the default, within a day", def.words === "within a day" && !def.stated && new Date(def.deadline).getTime() - noon.getTime() === 24 * 3_600_000);
  check("a call commitment with no time takes the confirmation's own words ('tonight' for an evening call)", M.commitmentWindow("I'll text you the links.", evening, SF, M.deliveryWords(evening, SF)).words === "tonight");

  check("new time in their words: 9am next day from the evening is 'in the morning'", M.whenWords(new Date("2026-10-08T19:00:00Z"), evening, SF) === "in the morning");
  check("new time, same afternoon: 'by 5pm'", M.whenWords(new Date("2026-10-08T00:00:00Z"), noon, SF) === "by 5pm");
  check("the send rule is 8am to 9pm (Royce, 2026-10-08), and proactive.ts reads it from localHours.ts", /REASONABLE_HOUR_START = 8;/.test(src("services/localHours.ts")) && /REASONABLE_HOUR_END = 21;/.test(src("services/localHours.ts")) && /startHour: REASONABLE_HOUR_START,\s*endHour: REASONABLE_HOUR_END,/.test(src("harness/proactive.ts")));
  check("promiseHours reads weekdays in their zone, not always Pacific", /zone = wordsZone\(zone\)/.test(src("services/promises.ts")) && /promiseHours\(sentence, now, zone\)/.test(src("services/promises.ts")));
  check("the first check of a 6pm 'tonight' promise lands inside the window, not at 10pm", (() => {
    const at6 = new Date("2026-10-08T01:00:00Z");
    const w6 = M.commitmentWindow("tonight", at6, SF);
    return local(CT.firstCheckInWindow(new Date(at6.getTime() + 4 * 3_600_000), w6, at6)) === "10/07, 20:30"; // warn-by 8:40pm, less 10 minutes
  })());
}

// ======================================================================= 2. the voice of the warning
{
  const GOOD = "No luck on the rooms yet, I'll have them for you in the morning.";
  check("the early-warning line passes the narration detector", narratesInternalState(GOOD) === null);
  const g = TT.warningChecks(GOOD, { thing: "the rooms", when: "in the morning" });
  check("...and every check of the warning (checkDraft, new time, names what's missing)", g.every((c) => c.pass), g.filter((c) => !c.pass));
  for (const bad of ["Still digging on the rooms, I have a few leads and I'm working on it.", "No solid options yet, I'll have them soon.", "Working on the rooms now, more soon."]) {
    const c = TT.warningChecks(bad, { thing: "the rooms", when: "in the morning" });
    check(`a status ramble fails the voice check: "${bad}"`, c.some((x) => x.name === "draft_narrates_state" && !x.pass), c.filter((x) => !x.pass));
  }
  // The first live run (2026-10-07, dev) drafted "Quick update: won't have the private dining options tonight after all. ...".
  check("a status preamble fails", TT.warningChecks("Quick update: won't have the private dining options tonight after all. I'll get them to you in the morning.", { thing: "the private dining options", when: "in the morning" }).some((c) => c.name === "warning_no_preamble" && !c.pass));
  check("a line with no new time fails", TT.warningChecks("No luck on the rooms yet.", { thing: "the rooms", when: "in the morning" }).some((c) => c.name === "warning_new_time" && !c.pass));
  check("a line that doesn't say what's missing fails", TT.warningChecks("I'll have something for you in the morning.", { thing: "the rooms", when: "in the morning" }).some((c) => c.name === "warning_names_it" && !c.pass));
  const fb = TT.fallbackWarning(TT.promisedThing("Keep your word from the call: \"I'll text you the options tonight\""), "in the morning");
  check("the fallback line, from Cue's own promise", fb === "No luck on the options yet, I'll have them for you in the morning.", fb);
  check("...passes the same checks", TT.warningChecks(fb, { thing: "the options", when: "in the morning" }).every((c) => c.pass));
  const fp = TT.fallbackWarning("the plan", "by 3pm");
  check("the fallback never promises a document: it's the same plain line for a plan", fp === "No luck on the plan yet, I'll have it for you by 3pm." && !/document|finished/i.test(fp) && TT.warningChecks(fp, { thing: "the plan", when: "by 3pm" }).every((c) => c.pass), fp);
}

// ======================================================================= 3. the reproduction: first wake finds nothing, next check 3h out
const TONIGHT_AT = new Date("2026-10-08T02:20:00Z"); // promise made 7:20pm SF
const NOW = new Date("2026-10-08T02:30:00Z"); // first wake 7:30pm SF
const baseTask = (over: any = {}): any => ({
  id: 501, userId: "u-test", goal: "Keep your word from the call: \"I'll text you the options tonight\"", theirWords: "can you find me a private dining room for twelve near Hayes Valley",
  steps: [{ text: "Send what you said you would", done: false }], planNext: "Send it now", nextCheckAt: NOW.toISOString(), status: "open", wakes: 1, notes: [], textsSent: 0, lastTextedAt: null,
  createdAt: TONIGHT_AT.toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "promise",
  window: M.commitmentWindow("I'll text you the options tonight", TONIGHT_AT, SF), ...over,
});
function harness(clock: Date, o: { draft?: (f: any) => Promise<string | null> } = {}) {
  const log = { warns: [] as { text: string; key: string; at: Date }[], texts: [] as string[], windows: [] as any[], at: [] as Date[], scheduled: [] as number[], notes: [] as string[], closed: [] as string[], docs: [] as any[] };
  const sentKeys = new Set<string>();
  const deps: any = {
    person: { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco" }, recent: "", zone: SF,
    note: async (t: string) => { log.notes.push(t); },
    schedule: async (h: number) => { log.scheduled.push(h); return new Date(clock.getTime() + h * 3_600_000).toISOString(); },
    scheduleAt: async (at: Date) => { log.at.push(at); return at.toISOString(); },
    close: async (s: string, out: string) => { log.closed.push(`${s}: ${out}`); },
    textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {},
    send: async (m: string[]) => { log.texts.push(...m); return { sent: true }; },
    search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "Nothing came back that proved itself on its page." }), readPage: async () => ({ ok: false, facts: [], text: "" }),
    now: () => clock, sentSince: async () => [],
    // The real send path keys the warning by window (proactive_sends unique target_key): a second send of the same key is a no-op.
    warn: async (text: string, key: string) => { if (sentKeys.has(key)) return { sent: false, reason: "already sent" }; sentKeys.add(key); log.warns.push({ text, key, at: clock }); return { sent: true }; },
    setWindow: async (w: any) => { log.windows.push(w); },
    draftWarning: o.draft ?? (async () => "No luck on the private dining rooms yet, I'll have them for you in the morning."),
  };
  return { deps, log };
}
{
  // Co searched, found nothing it could verify, and set its next look three hours out (10:30pm SF).
  script.push({ tool: "search", input: { what: "private dining room for twelve near Hayes Valley", when: "this week" } }, { tool: "scheduleNext", input: { inHours: 3, plan: "Look again for private dining rooms near Hayes Valley" } });
  const { deps, log } = harness(NOW);
  const t = baseTask();
  const r = await TT.runTaskTurnWith(t, deps);
  check("the turn ran as scripted: searched, found nothing, scheduled 3h out", r.did.some((d) => d.startsWith("search:")) && log.scheduled[0] === 3, r.did);
  // Royce, 2026-10-08 evening: progress reports are forbidden, the window warning included. Silence until there's something real.
  check("an empty result sends nothing: no \"not yet\" warning", log.warns.length === 0 && log.texts.length === 0, log.warns);
  const nw = log.windows[0];
  check("the window moves quietly to the new time (by noon tomorrow, their time)", nw && local(nw.deadline) === "10/08, 12:00" && nw.words === "in the morning", nw);
  check("the next check moves to 8am their time, when the deliverable can go out", log.at.length === 1 && local(log.at[0]) === "10/08, 08:00", log.at.map((d) => local(d)));
  check("the turn returns no warning", !r.warning);
  check("no other text went out", log.texts.length === 0);

  // The same window again (a second wake for it): never warned twice.
  script.push({ text: "Nothing yet." });
  const h2 = harness(new Date(NOW.getTime() + 5 * 60_000));
  await TT.runTaskTurnWith(baseTask({ window: { ...t.window, warnedFor: [t.window.deadline] } }), h2.deps);
  check("a second wake sends nothing either", h2.log.warns.length === 0 && h2.log.texts.length === 0);
  // They replied at 9pm, so the task woke before its new morning window: held to the morning, not a second warning.
  script.push({ text: "Nothing yet." });
  const h3 = harness(new Date("2026-10-08T04:00:00Z"));
  await TT.runTaskTurnWith(baseTask({ window: nw }), h3.deps);
  check("a wake before the new window opens sends nothing", h3.log.warns.length === 0 && h3.log.texts.length === 0, h3.log);
  // The warn-by passed with the process down: past 9pm nothing is sent; the check moves to their morning, which warns then.
  script.push({ text: "Nothing yet." });
  const h4 = harness(new Date("2026-10-08T04:30:00Z")); // 9:30pm SF
  await TT.runTaskTurnWith(baseTask(), h4.deps);
  check("past 9pm with the window missed: nothing sent, the next check moves to 8am", h4.log.warns.length === 0 && h4.log.texts.length === 0 && h4.log.at.length === 1 && local(h4.log.at[0]) === "10/08, 08:00", h4.log);
  // A bad draft twice: the plain fallback still goes, rather than silence.
  script.push({ text: "Nothing yet." });
  const h5 = harness(NOW, { draft: async () => "Still digging on this, have a few leads. Working on it!" });
  await TT.runTaskTurnWith(baseTask(), h5.deps);
  check("no warning draft is ever sent, however it reads", h5.log.warns.length === 0 && h5.log.texts.length === 0, h5.log.warns);
  // Co told them itself this turn (tellThem), and its next look is past the window: no second line, the window moves, marked told.
  script.length = 0;
  script.push({ tool: "tellThem", input: { what: "Nothing verified on the rooms yet; they'll have them in the morning" } }, { text: "No luck on the rooms yet, you'll have them in the morning." }, { tool: "scheduleNext", input: { inHours: 13, plan: "Search again" } });
  const h7 = harness(NOW);
  await TT.runTaskTurnWith(baseTask(), h7.deps);
  script.length = 0;
  check("Cue's own \"no luck yet\" text is refused too: a progress report never goes", h7.log.texts.length === 0 && h7.log.warns.length === 0, { texts: h7.log.texts, windows: h7.log.windows });
  // A next check inside the window: no warning.
  script.push({ tool: "scheduleNext", input: { inHours: 1, plan: "Check again" } });
  const h6 = harness(new Date("2026-10-07T20:00:00Z")); // 1pm SF, window tonight
  await TT.runTaskTurnWith(baseTask({ window: M.commitmentWindow("tonight", new Date("2026-10-07T19:50:00Z"), SF), createdAt: "2026-10-07T19:50:00Z" }), h6.deps);
  check("a next check that still lands inside the window sends nothing", h6.log.warns.length === 0);
  check("the prompt shows Cue the time in their zone and its window, not UTC", (() => { const p = JSON.stringify(seen[0] ?? {}); return /Now, their time: Wed Oct 7, 7:30pm PDT/.test(p) && /Cue told them they'd have it tonight/.test(p); })());
  check("the warning is its own exempt type, through sendExempt with quiet hours", /type: "task_window", targetKey: key, messages: \[text\], timezone: zone, respectHours: true/.test(src("services/taskTurn.ts")));
  check("a warning never counts as the promise kept", /ps\.type IN \('call_confirm', 'task_window'\)/.test(src("services/followThrough.ts")) && /ps\.type IN \('call_confirm', 'task_window'\)/.test(src("services/callCommitments.ts")));
}

// ======================================================================= 3b. the delivery is never held back by the update cap
{
  // Royce's call, 2026-10-08: the run link was found and ready, and "already sent them two task updates today" held it back. A
  // promise's first text is the delivery, not an update.
  const RUN = { name: "Builders who Run, Golden Gate Bridge 4M", url: "https://lu.ma/run-test", date: "2026-10-10", details: ["time: 9:00 AM", "address: Golden Gate Bridge"], tier: 2 };
  script.length = 0;
  script.push(
    { tool: "search", input: { what: "founder run club", when: "this weekend" } },
    { tool: "tellThem", input: { what: "Here's the founder run this Saturday at the Golden Gate Bridge", links: [RUN.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "Builders who Run, a founder run across the Golden Gate Bridge on Saturday." }], closing: null }) },
    { tool: "finish", input: { status: "done", outcome: "sent the run" } },
  );
  const h = harness(NOW);
  h.deps.textsToday = async () => 2;
  h.deps.search = async () => [RUN];
  const r = await TT.runTaskTurnWith(baseTask({ goal: "Keep your word from the call: \"I'll send that over now.\"", theirWords: "Yeah, that would be perfect." }), h.deps);
  script.length = 0;
  // Review of #115: the exemption is the delivery only, never every text in the turn.
  script.length = 0;
  script.push(
    { tool: "search", input: { what: "founder run club", when: "this weekend" } },
    { tool: "tellThem", input: { what: "Here's the founder run this Saturday at the Golden Gate Bridge", links: [RUN.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "Builders who Run, a founder run across the Golden Gate Bridge on Saturday." }], closing: null }) },
    { tool: "tellThem", input: { what: "Builders who Run again, a second note about the run", links: [RUN.url] } },
    { text: "Builders who Run starts at the Golden Gate Bridge on Saturday." },
    { tool: "tellThem", input: { what: "Builders who Run, a third note" } },
    { text: "Builders who Run is free, Saturday at the Golden Gate Bridge." },
  );
  const hf = harness(NOW);
  hf.deps.textsToday = async () => 2;
  hf.deps.search = async () => [RUN];
  await TT.runTaskTurnWith(baseTask({ goal: "Keep your word from the call: \"I'll send that over now.\"", theirWords: "Yeah, that would be perfect." }), hf.deps);
  script.length = 0;
  check(`one promise turn past the cap sends its delivery once, never a run of texts (${hf.log.texts.length})`, hf.log.texts.filter((t) => t === RUN.url).length === 1, hf.log.texts);
  check(`the promised delivery goes out with two task updates already sent today (${JSON.stringify(h.log.texts)})`, h.log.texts.includes(RUN.url) && h.log.texts.some((t) => /Builders who Run/.test(t)) && !h.log.warns.length, { did: r.did, texts: h.log.texts });
}

// ======================================================================= 4. completion closes the loop
{
  check("closing a task closes its window", /jsonb_set\(followup, '\{window,closedAt\}', to_jsonb\(NOW\(\)\)\)/.test(src("services/coTasks.ts")));
  check("...and the real close syncs the open loops right then", /await closeTask\(userId, task\.id, status, outcome\);\s*await import\("\.\/openLoops\.js"\)\.then\(\(m\) => m\.syncOpenLoops\(userId\)\)/.test(src("services/taskTurn.ts")));
  check("a loop whose task is done closes as done (direct read of the task)", OL.closeVerdict("task", { status: "done" })?.status === "done");
  const w = M.commitmentWindow("tonight", NOW, SF);
  check("a closed window drops out of what Cue reads as open work", !CT.taskFactLines([{ ...baseTask(), window: { ...w, closedAt: NOW.toISOString() } }], undefined, SF).join(" ").includes("they'd have it") && CT.taskFactLines([baseTask()], undefined, SF).join(" ").includes("they'd have it tonight"));
  check("and what Cue reads is in their time, not UTC", !/UTC/.test(CT.taskFactLines([baseTask()], undefined, SF).join(" ")));
  check("a closed window never warns", await (async () => { script.push({ text: "Nothing yet." }); const h = harness(NOW); await TT.runTaskTurnWith(baseTask({ window: { ...w, closedAt: NOW.toISOString() } }), h.deps); return h.log.warns.length === 0; })());
}

// ======================================================================= 6. where windows come from
{
  const calls: any[] = [];
  const cdeps: any = { open: async () => [], start: async (i: any) => { calls.push(i); return { ok: true, task: { id: 9, goal: i.goal, nextCheckAt: null } }; }, setDue: async () => {}, note: async () => {}, zone: async () => SF };
  await CC.trackCallCommitment({ userId: "u1", sentence: "I'll text you the options.", theirLine: "find me a private dining room", now: new Date("2026-10-08T02:20:00Z") }, cdeps);
  check("a call commitment with no time carries the confirmation's window ('tonight'), in their zone", calls[0]?.window?.words === "tonight" && local(calls[0].window.deadline) === "10/07, 23:59", calls[0]?.window);
  await CC.trackCallCommitment({ userId: "u1", sentence: "I'll put together the plan for after the Sequin event and text you the draft tonight.", theirLine: "what's the plan after the event", now: new Date("2026-10-08T02:20:00Z") }, cdeps);
  check("a reply's promise carries its window too, in their zone", /window: commitmentWindow\(sentence, now, zone\)/.test(src("services/promises.ts")) && /const zone = await memberZone\(o\.userId\)/.test(src("services/promises.ts")));
}

globalThis.fetch = prior;
// 2026-10-08: a call that ends with no texting time left tonight confirms "in the morning" (no confirmation then a warning).
{
  const z = "America/Los_Angeles";
  const dw = (iso: string) => M.deliveryWords(new Date(iso), z);
  check("6pm, 7:30pm and 7:45pm confirm tonight (texting time left before 9pm)", dw("2026-10-08T18:00:00-07:00") === "tonight" && dw("2026-10-08T19:30:00-07:00") === "tonight" && dw("2026-10-08T19:45:00-07:00") === "tonight");
  check("8:45pm, 10:30pm and 2am confirm in the morning", dw("2026-10-08T20:45:00-07:00") === "in the morning" && dw("2026-10-08T22:30:00-07:00") === "in the morning" && dw("2026-10-09T02:00:00-07:00") === "in the morning");
  check("morning and afternoon unchanged", dw("2026-10-09T10:00:00-07:00") === "this morning" && dw("2026-10-09T14:00:00-07:00") === "this afternoon");
}
console.log(`windows: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
