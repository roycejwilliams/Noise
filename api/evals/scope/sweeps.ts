// The purpose boundary, PR B: capture, sweeps and goals. Layer 1: model stubbed, store faked, zero tokens.
//   - passive capture REMEMBERS an out-of-scope ask (kind "outside"), but it is never swept, checked in on or made a look-out
//   - funding and investor searches stop; job postings stop; recruiting events and job fairs are rooms
//   - a fellowship or accelerator is surfaced as a community, with no "how was it" and no application-cycle follow-up
//   - the goal "club world" test follows the boundary; admin goals get no reminder
//   npx tsx evals/scope/sweeps.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const dbm = await import("../../src/db/db.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const pool: any = dbm.default;
const log: { sql: string; params: any[] }[] = [];
let answer: (sql: string, params: any[]) => any[] | null = () => null;
const fakeQuery = async (sql: string, params: any[] = []) => {
  log.push({ sql: String(sql), params });
  const rows = answer(String(sql), params);
  return { rows: rows ?? [], rowCount: rows ? rows.length : 0 };
};
pool.query = fakeQuery;
pool.connect = async () => ({ query: fakeQuery, release() {} });
const reset = (a: typeof answer = () => null) => { log.length = 0; answer = a; };
const quiet = console.log;

const K = await import("../../src/services/askKind.js");
const LM = await import("../../src/services/laneMoves.js");

// ---- 1. an ask outside the boundary is kept, as kind "outside", and decided in code (no model call)
check("a phone plan, a jobs watch and a trip are outside, by the backstop alone", ["Find me the cheapest phone plan", "Keep an eye on job listings in climate tech", "Plan my trip to Lisbon in March"].every((t) => K.outsideAsk(t)));
check("an investor search and a therapist search are NOT decided by words: the model's read decides them", ["Find investors for my seed round", "Find me a therapist who takes my insurance"].every((t) => !K.outsideAsk(t)));
check("founder dinners, an intro, a climate job fair and an investor dinner are not", ["Founder dinners in the Mission", "Someone who has raised a pre-seed to talk to", "Job fairs and recruiting events for climate tech", "Investor dinners in SF", "Find a photographer meetup", "help me find a job through people I know"].every((t) => !K.outsideAsk(t)));
check("classifyAsk decides an out-of-scope ask as outside with no model call", (await K.classifyAsk("Find me the cheapest phone plan")) === "outside" && (await K.classifyAsk("Keep an eye on job listings in climate tech")) === "outside");
check("a lookout keeps its kind, except that an out-of-scope one moves to outside", LM.askKindAfter({ kind: "find", intent: "lookout" }, "help") === null && LM.askKindAfter({ kind: "find", intent: "lookout" }, "outside") === "outside" && LM.askKindAfter({ kind: "outside", intent: null }, "outside") === null);
{
  reset();
  const rows = [
    { id: 1, user_id: "u1", ask_text: "Find me the cheapest phone plan", kind: "find", intent: null, kind_checked_at: new Date() },
    { id: 2, user_id: "u1", ask_text: "Keep an eye on job listings in climate tech", kind: null, intent: null, kind_checked_at: null },
    { id: 3, user_id: "u1", ask_text: "Founder dinners in the Mission", kind: "find", intent: null, kind_checked_at: new Date() },
    { id: 4, user_id: "u1", ask_text: "Someone who has raised a pre-seed to talk to", kind: null, intent: null, kind_checked_at: null },
    { id: 5, user_id: "u1", ask_text: "Find me a therapist who takes my insurance", kind: "help", intent: null, kind_checked_at: new Date() },
    { id: 6, user_id: "u1", ask_text: "Find me an apartment in the Mission", kind: "person", intent: null, kind_checked_at: new Date() },
    { id: 7, user_id: "u1", ask_text: "Keep an eye out for a gym near me", kind: "find", intent: "lookout", kind_checked_at: new Date() },
  ];
  answer = (sql) => (/SELECT id, user_id, ask_text, kind, intent/.test(sql) ? rows : null);
  const asked: string[] = [];
  const n = await K.classifyOpenAsks(25, { db: pool, read: async (t) => (asked.push(t), /therapist|apartment|gym/.test(t) ? { kind: "outside" as const, connection: null } : /dinners/.test(t) ? { kind: "find" as const, connection: "founder dinners in the Mission" } : { kind: "person" as const, connection: null }) });
  const updates = log.filter((l) => /UPDATE ask_checkins SET kind/.test(l.sql));
  const kindOf = (id: number) => updates.find((u) => u.params[0] === id)?.params[1] ?? "(unchanged)";
  check("the kind job moves the old phone plan ask and the new jobs ask to outside, with no model call for either (the backstop)", n === 7 && kindOf(1) === "outside" && kindOf(2) === "outside" && !asked.some((t) => /phone plan|job listings/.test(t)), { kinds: [1, 2, 3, 4].map(kindOf), asked });
  check("a stored HELP ask, a PERSON ask and a LOOKOUT the model reads as outside move to outside too (every stored ask is read for scope once, not only find asks)", kindOf(5) === "outside" && kindOf(6) === "outside" && kindOf(7) === "outside", [5, 6, 7].map(kindOf));
  check("an in-scope find ask keeps its kind (read for scope only); an unread in-scope ask takes the read's kind", kindOf(3) === "(unchanged)" && kindOf(4) === "person", { k3: kindOf(3), k4: kindOf(4) });
  check("the model's connection part for a mixed ask is kept, in the same guarded write", updates.find((u) => u.params[0] === 3)?.params[6] === "founder dinners in the Mission" && updates.every((u) => /intent IS NOT DISTINCT FROM \$6/.test(u.sql)), updates.find((u) => u.params[0] === 3));
  check("remembered, not closed: the kind write never resolves or deletes the ask", updates.every((u) => !/resolved_at|DELETE/.test(u.sql)) && !log.some((l) => /DELETE FROM ask_checkins|resolved_at = /.test(l.sql)));
}

// ---- 1b. a mixed ask is searched for its connection part only
{
  const SC = await import("../../src/harness/scope.js");
  check("a mixed ask is searched for the connection part: the errand clause is left out", SC.connectionPart("Founder dinners in the Mission, and book me a dentist") === "Founder dinners in the Mission" && K.searchPartOf("Founder dinners in the Mission and find me a dentist near the Mission") === "Founder dinners in the Mission");
  check("an ask with nothing outside it is unchanged, and one that is all outside has no part", SC.connectionPart("Founder dinners and mixers in the Mission") === "Founder dinners and mixers in the Mission" && SC.connectionPart("Find me a dentist") === null && K.searchPartOf("Find me a dentist") === null && K.searchPartOf("Founder dinners and a dentist near the Mission", { scope_connection: "founder dinners" }) === "founder dinners" && K.searchPartOf("anything", { kind: "outside" }) === null && K.searchPartOf("Plan my Austin trip and book a table") === null);
  const sweepSrc = src("services/dailySweep.ts") + src("jobs/index.ts") + src("services/eventSurfacingSweep.ts");
  check("all three searches (morning floor, hourly, new ask after a call) use the connection part", (sweepSrc.match(/searchPartOf\(/g) ?? []).length >= 3);
}

// ---- 2. the morning sweep skips an out-of-scope ask (an old row still marked find too) and searches nothing
{
  const D = await import("../../src/services/dailySweep.js");
  const E = await import("../../src/services/eventSurfacingSweep.js");
  reset((sql) => {
    if (/FROM ask_checkins ac WHERE ac\.user_id = \$1 AND ac\.resolved_at IS NULL/.test(sql)) return [
      { id: 11, ask_text: "Find me the cheapest phone plan", kind: "outside", split_read: null, created_at: new Date() },
      { id: 12, ask_text: "Find me a dentist near the Mission", kind: "find", split_read: null, created_at: new Date() },
      { id: 13, ask_text: "Keep an eye on job listings in climate tech", kind: "find", split_read: null, created_at: new Date() },
    ];
    return null;
  });
  const prior = (E as any).attemptEventSurfacing;
  let searched = 0;
  const base = { day: "2026-11-04", zone: "America/Los_Angeles" };
  console.log = () => {};
  let err: unknown = null;
  try { await D.sweepMember({ first_name: "Jordan", phone_number: "+10000000000", intent: [], goals: [], city: "San Francisco" }, "u1", new Date("2026-11-04T17:00:00Z"), base, [], 0, { quiet: true }); } catch (e) { err = e; }
  console.log = quiet;
  const decisions = log.filter((l) => /INSERT INTO harness_decisions/.test(l.sql));
  const items = decisions.flatMap((d) => d.params.map((p) => { try { return typeof p === "string" && p.includes('"items"') ? JSON.parse(p).items : null; } catch { return null; } })).find(Boolean) as any[] | undefined;
  check("the morning sweep over three out-of-scope asks searches none of them and reports each as skipped", !err && !!items && items.length === 3 && items.every((i) => i.status === "skipped") && searched === 0, { err: String(err), items });
  void prior;
}

// ---- 3. goal edges: no search for funding, investors, job postings or errands; recruiting events and job fairs stay
{
  const GE = await import("../../src/services/goalEdges.js");
  const goals = ["Get my taxes done by the 15th", "Find investors for my seed round", "Move into climate tech from consulting", "Meet climate founders"];
  const raw = JSON.stringify([
    { n: 1, kind: "findable", edges: ["tax preparers in SF"], why: "" },
    { n: 2, kind: "findable", edges: ["seed investors consumer AI", "investor dinners SF"], why: "" },
    { n: 3, kind: "findable", edges: ["climate tech job board listings", "climate tech recruiting events SF", "climate job fair Bay Area", "monitor hiring season at climate startups"], why: "" },
    { n: 4, kind: "findable", edges: ["climate founder dinners SF", "climate founder community"], why: "" },
  ]);
  const out = GE.parseEdges(goals, raw, "Jordan");
  check("a taxes goal has no findable side, stays on file, and says why", out[0].edges.length === 0 && /remembered only/.test(out[0].why), out[0]);
  check("an investor dinner is a room (kept); a funding search is the model's call, made in the plan prompt below, not a word list", out[1].edges.some((e: string) => /dinner/.test(e)), out[1]);
  check("a job change keeps recruiting events and job fairs, loses job boards and hiring-season monitoring", out[2].edges.join("|") === "climate tech recruiting events SF|climate job fair Bay Area", out[2]);
  check("a people goal is untouched", out[3].edges.length === 2, out[3]);
  const prompt = GE.edgePrompt(goals, { city: "San Francisco", today: "2026-11-04" });
  check("the goal plan prompt no longer treats funding, jobs or grants as findable, and offers programs once as communities", !/fellowships and grants|\(funding, programs, jobs|funding, programs, jobs, learning/.test(prompt) && /surfaced once, never tracked by application cycle/.test(prompt) && /never searches for funding or investors/.test(prompt), prompt.slice(prompt.indexOf("Cue searches"), prompt.indexOf("Cue searches") + 400));
}

// ---- 4. a program is surfaced as a community, once; nothing asks "how was it" about it
{
  const R = await import("../../src/services/recommendationOutcome.js");
  const program = { tier: 3, name: "Harbor Climate Accelerator, cohort 4", statedDates: { start: "2026-11-01", end: "2026-12-01" }, url: "https://harbor.example/apply" };
  const dinner = { tier: 2, name: "Founders Dinner at the Battery", event_date: "2026-11-12", event_api_id: "evt-1" };
  const tier3Post = { tier: 3, name: "Hardware founders breakfast" };
  check("a real event with a day is followed up; a program, a cohort and an undated web find are not", R.isRealEventForFollowUp(dinner) && !R.isRealEventForFollowUp(program) && !R.isRealEventForFollowUp(tier3Post) && R.isRealEventForFollowUp({ kind: "intro", name: "your intro to Grant Lee", event_date: "2026-11-09" }));
  reset();
  await R.scheduleOutcomeFollowUp("u1", "climate accelerators", program as any);
  await R.scheduleOutcomeFollowUp("u1", "hardware founders", tier3Post as any);
  check("recommending a program schedules no follow-up", !log.some((l) => /INSERT INTO recommendation_outcome_followups/.test(l.sql)), log.map((l) => l.sql.slice(0, 60)));
  reset();
  await R.scheduleOutcomeFollowUp("u1", "founder dinners", dinner as any);
  check("recommending a real event still schedules the morning-after follow-up", log.filter((l) => /INSERT INTO recommendation_outcome_followups/.test(l.sql)).length === 1);
  reset((sql) => (/FROM recommendation_outcome_followups rof/.test(sql) ? [{ id: "f1", user_id: "u1", ask_text: "climate accelerators", match_name: program.name, match: program, send_at: new Date(Date.now() - 1000), city: "San Francisco" }] : null));
  await R.enqueueDueOutcomeFollowUps();
  check("a program follow-up queued before the boundary closes without a text: dropped, no debrief candidate", log.some((l) => /harness_status = 'dropped'/.test(l.sql)) && !log.some((l) => /INSERT INTO proactive_candidates/.test(l.sql)), log.map((l) => l.sql.slice(0, 70)));
}

// ---- 5. goals: the club-world test follows the boundary; no admin reminder
{
  const GO = await import("../../src/services/goalOwnership.js");
  const prompt = GO.goalReadPrompt("Get my taxes done", "I need to get my taxes done by the 15th", [{ n: 1, text: "gather receipts" }]);
  check("the club-world test is about people and rooms, and names errands, shopping, travel, job boards and funding as outside", /end with the right people in a room/.test(prompt) && /errands, shopping, travel, general research, job boards, funding searches/.test(prompt) && !/city life, meeting people/.test(prompt));
  const split = GO.splitFor([{ n: 1, text: "gather receipts", owner: "co", how: "reminder", reach: "internal" }, { n: 2, text: "research accountants", owner: "co", how: "research", reach: "internal" }], false);
  check("outside the club's world nothing is Cue's, not even a reminder", split.every((i) => i.owner === "member" && i.how === null && i.status === "theirs"), split);
  const inside = GO.splitFor([{ n: 1, text: "founder dinners for the launch", owner: "co", how: "research", reach: "internal" }], true);
  check("inside it, a piece Cue can do is still offered", inside[0].owner === "co" && inside[0].status === "offered");
  check("the light-reminder path is gone", !("withLightReminder" in GO) && !("suggestedReminderAt" in GO) && !("deadlineInTheirWords" in GO));
  const lines = GO.goalFactLines([{ id: 7, title: "Get my taxes done", clubWorld: false, status: "offered", items: [], theirWords: "x", offeredAt: new Date().toISOString() } as any], [], null);
  check("what Cue reads about an admin goal says nothing was offered or held", lines.length === 1 && /isn't something Cue works on or holds a reminder for/.test(lines[0].text) && !/offered to hold a reminder/.test(lines[0].text), lines);
  const cap = await import("../../src/services/capabilities.js");
  const take = cap.ABILITIES.find((a) => a.id === "goal_take_on")!;
  check("the takeOnGoal guidance no longer offers a reminder for taxes or the inbox", !/admin too: taxes, expense reports, their inbox/.test(take.use ?? "") && !/gives you one thing to offer, a reminder/.test(take.use ?? ""));
}

// ---- 6. the tools: a phone-plan ask is saved (remembered) and never promised, by text and on a call; an in-scope ask is promised as before
const T = await import("../../src/agent/conversationTools.js");
for (const voice of [false, true]) {
  const how = voice ? "call" : "text";
  const run = async (msg: string, what: string) => {
    reset();
    const facts: { kind: string; text: string }[] = [];
    const t = T.createConversationTools({ userId: "u1", phoneNumber: "+10000000000", resolvedContent: msg, isVoice: voice, onCall: voice, callKey: voice ? "call-1" : undefined, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, isTeam: false, sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" } } as any);
    console.log = () => {};
    try { const r = await (t.tools as any).saveAsk.execute({ what }, {}); return { r, facts }; } finally { console.log = quiet; }
  };
  const phone = await run("Can you find me the cheapest phone plan?", "the cheapest phone plan");
  check(`(${how}) a phone-plan ask is noted on file only: no promise to keep looking, no ongoing search fact`, phone.r.ok === true && /on file only/.test(phone.r.note) && !/^Saved/.test(phone.r.note) && !phone.facts.some((f) => f.kind === "ongoing"), phone);
  const jobs = await run("Keep an eye out for job openings in climate tech", "job openings in climate tech");
  check(`(${how}) a job-postings ask is noted on file only`, jobs.r.ok === true && /on file only/.test(jobs.r.note) && !jobs.facts.some((f) => f.kind === "ongoing"), jobs);
  const dinner = await run("Can you look for founder dinners in SF?", "founder dinners in SF");
  check(`(${how}) an in-scope ask is saved and promised as before`, dinner.r.ok === true && /keep looking/.test(dinner.r.note) && dinner.facts.some((f) => f.kind === "ongoing"), dinner);
}

// ---- 7. every place that would sweep, check in on or loop an ask leaves the outside ones alone (source checks on the real SQL)
const jobsSrc = src("jobs/index.ts");
check("the ask check-in cron skips outside asks", /ac\.kind IS DISTINCT FROM 'outside'/.test(jobsSrc));
check("the hourly sweep re-checks the ask in code before searching it", /outsideAsk\(askText\)\) continue/.test(jobsSrc));
check("open loops never carry an outside ask", /kind IS DISTINCT FROM 'outside' ORDER BY created_at DESC/.test(src("services/openLoops.ts")));
check("the new-ask search reads find asks only, so an outside ask is never searched right after a call", /ac\.kind = 'find'/.test(src("services/eventSurfacingSweep.ts")) && /classifyAskRead\(ask\.text\)/.test(src("services/profileExtraction.ts")));
check("the X sweep guidance and tool no longer search for investors, grants or job postings, or by application cycle", !/investors or people/.test(src("services/sweepFind.ts")) && !/applications open OR/.test(src("services/sweepFind.ts")) && /Never funding, investors, grants or job postings/.test(src("services/sweepFind.ts")));
const cap = await import("../../src/services/capabilities.js");
const ask = cap.ABILITIES.find((a) => a.id === "save_ask")!;
check("the saveAsk sheet says funding, job postings, errands and travel are kept on file, not searched or checked in on", /funding, job postings, errands, shopping, travel, general research and advice are kept on file/.test(`${ask.sheet} ${ask.can}`.replace(/Sponsors, investors, /, "")) || /Sponsors, investors, funding, job postings, errands, shopping, travel, general research and advice are kept on file, not searched or checked in on/.test(ask.sheet ?? ""), ask.sheet);

// ---- 8. real events keep their follow-up whatever their name says; programs and openings do not (decided by what the find IS)
{
  const R = await import("../../src/services/recommendationOutcome.js");
  const room = (name: string, over: any = {}) => ({ name, kind: "public_event", tier: 2, event_date: "2026-11-10", details: { startAt: "2026-11-10T18:30:00-08:00" }, ...over });
  check("dated rooms with 'program', 'cohort', 'competition' or 'funding' in the name still get the morning-after follow-up", ["SF Startup Pitch Competition", "Accelerator Demo Day \u2014 Fall Cohort", "Women in Product: Mentorship Program Kickoff Mixer", "Founders Funding Mixer"].every((n) => R.isRealEventForFollowUp(room(n))), ["SF Startup Pitch Competition", "Founders Funding Mixer"].map((n) => R.isRealEventForFollowUp(room(n))));
  check("…also when the find is a plain event with a date and a start time", R.isRealEventForFollowUp({ name: "Founders Funding Mixer", form: "event", event_date: "2026-11-10", details: { startAt: "2026-11-10T18:30:00-08:00" } }));
  check("an opening (a deadline to apply by) gets none, whatever it is called", !R.isRealEventForFollowUp({ name: "Founders Dinner Fellowship", deadline: "2026-11-20", statedDates: { start: "2026-12-01" }, tier: 3 }) && !R.isRealEventForFollowUp({ name: "Harbor Climate Accelerator, cohort 4", form: "opening", statedDates: { start: "2026-11-01", end: "2026-12-01" }, tier: 3 }));
  check("a web post that only states a start date, with no start time, is not a real event", !R.isRealEventForFollowUp({ name: "Fall cohort starts", tier: 3, statedDates: { start: "2026-11-10" } }));
  check("no name-word list decides it any more", !/PROGRAM\.test|const PROGRAM = /.test(src("services/recommendationOutcome.ts")) && /formOf\(match\)/.test(src("services/recommendationOutcome.ts")));
}

// ---- 9. goals: an outside goal gets no check-in, and a queued one is rechecked when it wakes
{
  const GJ = await import("../../src/services/goalJourney.js");
  const now = new Date("2026-11-04T18:00:00Z");
  const old = new Date(now.getTime() - 120 * 86400e3).toISOString();
  const g = (id: string, text: string, over: any = {}) => ({ id, kind: "goal", status: "active", text, created_at: old, confirmed_at: old, ...over });
  check("a goal the model read as outside gets no seasonal check-in", GJ.dueGoalCheckin([g("g1", "Find a gym that fits my schedule", { scope: "out" })], null, now) === null);
  check("…nor one that is unmistakably outside by its words (taxes)", GJ.dueGoalCheckin([g("g2", "File my taxes by the 15th")], null, now) === null);
  check("…while an in-scope goal is still checked in on", GJ.dueGoalCheckin([g("g3", "Meet climate founders", { scope: "in" })], null, now)?.id === "g3");
  check("the check-in is skipped again when it wakes (a candidate queued before the goal was read as outside)", /goalIsOutside\(entry\)\) return skip\(/.test(src("harness/proactiveRegistry.ts")));
  check("a new goal is read for scope by the same classifyAsk read and the verdict is kept on the entry", /goalRead\.kind === "outside" \? \("out" as const\)/.test(src("services/profileExtraction.ts")) && /\.\.\.\(goalScope \? \{ scope: goalScope \} : \{\}\)/.test(src("services/profileExtraction.ts")));
}

// ---- 10. saveAsk: the model's scope decides; a mixed ask is saved as its connection part or not at all
for (const voice of [false, true]) {
  const how = voice ? "call" : "text";
  const run = async (msg: string, args: any) => {
    reset();
    const facts: { kind: string; text: string }[] = [];
    const t = T.createConversationTools({ userId: "u1", phoneNumber: "+10000000000", resolvedContent: msg, isVoice: voice, onCall: voice, callKey: voice ? "call-1" : undefined, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, isTeam: false, sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" } } as any);
    console.log = () => {};
    try { return { r: await (t.tools as any).saveAsk.execute(args, {}), facts }; } finally { console.log = quiet; }
  };
  const therapist = await run("find me a therapist who takes my insurance", { what: "a therapist who takes their insurance", scope: "out" });
  check(`(${how}) the model's out is honoured where no word would have caught it: noted on file only`, therapist.r.ok === true && /on file only/.test(therapist.r.note) && !therapist.facts.some((f) => f.kind === "ongoing"), therapist);
  const meetup = await run("find a photographer meetup", { what: "a photographer meetup" });
  check(`(${how}) a meetup is saved and promised as before, with no verdict at all`, meetup.r.ok === true && /keep looking/.test(meetup.r.note), meetup);
  const mixedAsk = await run("find a DJ and some founder dinners", { what: "a DJ and some founder dinners", scope: "mixed", connection: "founder dinners" });
  check(`(${how}) a mixed ask is not saved whole: Cue is told to save only the connection part`, mixedAsk.r.ok === false && /founder dinners/.test(mixedAsk.r.error) && /ONLY the connection part/.test(mixedAsk.r.error), mixedAsk);
  const noPart = await run("plan my trip and find a table", { what: "plan my trip and find a table", scope: "mixed" });
  check(`(${how}) a mixed ask with no clean part asks one short question and saves nothing`, noPart.r.ok === false && /ONE short question/.test(noPart.r.error), noPart);
}

// ---- 11. queued work from before the boundary has no verdict: the model reads it once when it wakes (the same classifyAsk read), the verdict is kept
{
  const TT = await import("../../src/services/taskTurn.js");
  const legacy = (id: number, goal: string, extra: any = {}) => ({ id, userId: "u1", goal, theirWords: goal, steps: [], planNext: null, nextCheckAt: null, status: "open", wakes: 1, notes: [], textsSent: 0, lastTextedAt: null, createdAt: new Date().toISOString(), deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "research_brief", followup: null, source: "ask", ...extra }) as any;
  reset();
  let reads = 0; const told: string[] = [];
  const deps = async () => ({ firstName: "Jordan", draft: async () => "Not something I take on.", send: async (t: string) => (told.push(t), { sent: true, queued: false }), close: async () => {} });
  console.log = () => {};
  await TT.runDueTask(legacy(31, "Research: a venue for my launch dinner for 40"), { handBack: deps, scopeRead: async () => (reads++, { kind: "outside" }) });
  console.log = quiet;
  check("a queued venue brief from before the boundary: no word catches it, the model's read does, and the member who asked is told once", reads === 1 && told.length === 1 && log.some((l) => /UPDATE co_tasks SET followup = COALESCE\(followup/.test(l.sql) && /"out"/.test(String(l.params[2]))), { reads, told, sql: log.map((l) => l.sql.slice(0, 50)) });
  reads = 0; told.length = 0;
  console.log = () => {};
  await TT.runDueTask(legacy(32, "Find a dentist near the Mission", { kind: "work" }), { handBack: deps, scopeRead: async () => (reads++, { kind: "find" }) });
  console.log = quiet;
  check("an unmistakable out is closed by the backstop alone, with no model read", reads === 0 && told.length === 1);
  check("a task with a stored verdict is not read again", /!t\.followup\?\.scope/.test(src("services/taskTurn.ts")));
}

// ---- 12. a failed read is not "in": nothing is stored, and the ask is read again next run
{
  reset();
  const rows = [
    { id: 41, user_id: "u1", ask_text: "Find me founders in climate", kind: null, intent: null, kind_checked_at: null },
    { id: 42, user_id: "u1", ask_text: "Someone to talk to about a career change", kind: null, intent: null, kind_checked_at: null },
  ];
  answer = (sql) => (/SELECT id, user_id, ask_text, kind, intent/.test(sql) ? rows : null);
  const n = await K.classifyOpenAsks(25, { db: pool, read: async (t) => (/climate/.test(t) ? null : { kind: "person" as const, connection: null }) });
  const updates = log.filter((l) => /UPDATE ask_checkins SET kind/.test(l.sql));
  check("a failed read writes nothing for that ask (no kind, no checked mark, no version), so the next run reads it again; the other ask is stored", n === 2 && !updates.some((u) => u.params[0] === 41) && updates.some((u) => u.params[0] === 42), updates.map((u) => u.params[0]));
  const ak = src("services/askKind.ts");
  check("classifyAskRead returns null on an error, a timeout or an empty answer, and the capture and goal paths store nothing then", /\} catch \{\s*return null;/.test(ak) && /if \(!w\) return null;/.test(ak) && /askRead \? ASK_KIND_VERSION : null/.test(src("services/profileExtraction.ts")) && /const goalScope = goalRead \?/.test(src("services/profileExtraction.ts")) && /if \(!got\) continue;/.test(ak));
}

// ---- 13. a mixed ask keeps its mixed flag even when the connection phrase is short or missing: it is never searched whole
{
  const row = (c: string | null) => ({ kind: "find", scope_connection: c });
  check("flagged mixed with no usable phrase: not searched at all", K.searchPartOf("find me a therapist and some founder dinners", row("")) === null);
  check("flagged mixed with a phrase: only the phrase", K.searchPartOf("find me a therapist and some founder dinners", row("founder dinners")) === "founder dinners");
  check("the plain probe (an ask not flagged mixed) is the read's 'in': searched as written", K.searchPartOf("find me a therapist and some founder dinners", { kind: "find", scope_connection: null }) === "find me a therapist and some founder dinners");
  check("the read keeps the flag for a short phrase (\"\"), and a not-mixed ask stays null", /phrase\.length >= 4 \? phrase : ""/.test(src("services/askKind.ts")));
}

if (failed) { console.log(`\n${failed} of ${total} checks failed.`); process.exit(1); }
console.log(`scope boundary (B): ${total} checks passed.`);
process.exit(0);
