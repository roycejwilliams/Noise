// Phase A, know and filter early (Royce, 2026-10-10). Zero tokens: the record's loaders, the judge and the store are stubbed.
//   The work order's tests: a sweep query reflects stated taste and the avoid list; a backed-off member gets zero sweeps; the goal
//   cooldown is enforced; taste ranks a non-picker member's finds. Plus each item: A1 the sweep reads the record (the mood guess is
//   gone), A2 the avoid list at planning, keep and the working set, A3 the sweep gate is dispatch's own, A4 goal planning reads the
//   record, A5 taste wherever fit is judged, A6 one reader per fact; and the small items carried from #133's re-review.
//   npx tsx evals/phaseA/knowFilter.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const MK = await import("../../src/services/memberKnowledge.js");
const SF = await import("../../src/services/sweepFind.js");
const L = await import("../../src/services/memberLimits.js");
const Q = await import("../../src/services/sweepQuery.js");
const G = await import("../../src/services/goalEdges.js");
const GS = await import("../../src/services/goalSweep.js");
const P = await import("../../src/harness/proactive.js");
const ES = await import("../../src/services/eventSurfacingSweep.js");
const W = await import("../../src/services/workingSet.js");
const F = await import("../../src/services/findForm.js");
const ED = await import("../../src/services/eventDetails.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-10T17:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// A member as the record holds them: stated taste, a ruled-out list, availability, a correction, a done goal, something sent.
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;
const seen: { corrections?: { limit: number; days: number | null } } = {};
const deps = (o: Partial<Deps> = {}): Deps => ({
  forgotten: async () => [],
  profile: async () => ({ firstName: "Jordan", city: "San Francisco", goals: ["meet other founders who aren't performing"], intent: [{ kind: "goal", text: "run a marathon", status: "resolved", created_at: ago(900).toISOString() }], updatedAt: ago(10) }),
  zone: async () => "America/Los_Angeles",
  linkedNames: async () => [],
  goalStates: async () => [],
  asks: async () => [{ id: "a1", text: "AI founder events this month", kind: "find", createdAt: ago(30), lastMentionedAt: ago(3) }, { id: "a2", text: "a quiet coworking spot", kind: "find", createdAt: ago(60), lastMentionedAt: null }],
  receipts: async () => [],
  ledgerSent: async () => [],
  offers: async () => [{ key: "event:fd", name: "Founder Dinner at Zuni", kind: "event", url: "https://lu.ma/fd", sentAt: ago(24), reaction: null, details: null, postText: null }],
  tasks: async () => [],
  briefs: async () => [],
  loops: async () => [],
  promiseResults: async () => [],
  lessons: async () => [{ text: "big mixers land badly", at: ago(48) }],
  corrections: async (_u, c) => { seen.corrections = c; return [{ field: "city", old_value: "Oakland", new_value: "San Francisco", corrected_at: ago(100) } as any]; },
  taste: async () => ({ text: "small dinners got a yes; a big expo was ignored", at: ago(50) }),
  roomTaste: async () => [{ text: "wants a room where they can drop their guard; avoids performative events", at: ago(20) }],
  claims: async () => [],
  restraint: async () => ({ holdUntil: null, spaceUntil: null, safetyHold: false, emotional: null, suppressed: [], trial: [], lastInboundAt: ago(5), unansweredSends: [] }),
  exchanges: async () => [],
  person: async () => "Jordan is a technical founder in SF, two years into a seed-stage company.",
  limits: async () => ({ avoid: ["hackathons", "crypto events"], availability: "weeknights only", at: ago(40) }),
  ...o,
});

// ---------------------------------------------------------------- A1 + the work order's first test: the sweep reads the record
{
  const k = await MK.memberKnowledge("u", { now: NOW, include: SF.SWEEP_KNOWLEDGE }, deps());
  const r = SF.sweepRecord(k, "AI founder events this month");
  const p = SF.sweepPrompt({ userId: "u", firstName: "Jordan", askText: "AI founder events this month", city: "San Francisco" }, { today: "2026-10-10", record: r });
  check("A1: the sweep reads the record: who they are, active goals, done goals as history, what they corrected and Cue learned", /technical founder in SF/.test(p) && /Where they're headed now:\n- meet other founders/.test(p) && /history, not what to look for\):\n- run a marathon/.test(p) && /Corrected city: San Francisco/.test(p) && /Lesson: big mixers land badly/.test(p), p.slice(0, 1600));
  check("test: the sweep is told the room they've said they want, and to judge every keep against it", /THE KIND OF ROOM THEY'VE TOLD CO THEY WANT[\s\S]*drop their guard[\s\S]*give each keep a taste: "matches", "neutral" or "clashes"[\s\S]*Something that clashes isn't kept/.test(p));
  check("test: the sweep is told what they ruled out and when they're free", /stop suggesting these kinds of things: "hackathons", "crypto events"\. Never search for them and never keep one/.test(p) && /When they've said they're free, in their words: "weeknights only"\. Weigh an event's day and time against it as they said it/.test(p));
  check("what was already sent comes from the record (one list), and their other asks are context only", /Already sent to them recently \(don't keep these again\): Founder Dinner at Zuni/.test(p) && /other open asks[\s\S]*a quiet coworking spot/.test(p) && !/other open asks[\s\S]*- AI founder events this month/.test(p));
  check("how what Cue sent landed is in, as context", /How what Cue sent has landed: small dinners got a yes/.test(p));
  const ledger = new Q.QueryLedger([], "AI founder events this month", r.avoid);
  check("test: a query for a kind they ruled out is refused before it runs (web and X), in their words", ledger.check("web", "SF hackathon this weekend").some((x) => /told Cue to stop suggesting/.test(x)) && ledger.check("x", "(crypto OR web3) events SF").length > 0 && !ledger.check("web", "SF AI founder dinners October").length);
  check("an ask that names a ruled-out kind gets it back for that ask (the ask is newer than the rule)", L.avoidFor(["hackathons", "crypto events"], "find me a hackathon this month").join() === "crypto events" && SF.sweepRecord(k, "any good hackathons?").avoid.join() === "crypto events");
  check("the regex mood guess is gone from the code", !/roomPreferenceFromFeelings/.test(src("harness/emotion.ts") + src("services/eventSurfacingSweep.ts") + src("services/sweepFind.ts")) && !/ROOM_FOR_FEELING/.test(src("harness/emotion.ts")));
  check("the sweep reads the record itself, and runs no sweep when it (or the limits in it) can't be read", /const k = await read\(c\.userId\)/.test(src("services/sweepFind.ts")) && /if \(!k \|\| !k\.limits\) return \{ matches: \[\], did, searched: false, frustratedWithCo: false \};/.test(src("services/sweepFind.ts")));
  const none = await SF.sweepFind({ userId: "u", firstName: "J", askText: "x", city: "SF" }, { knowledge: async () => { throw new Error("names unreadable"); } });
  check("a record that fails closed means no search and no empty run", none.matches.length === 0 && none.searched === false && none.did.length === 0);
  const noLimits = await SF.sweepFind({ userId: "u", firstName: "J", askText: "x", city: "SF" }, { knowledge: async () => ({ ...k, limits: null }) });
  check("limits that couldn't be read mean no search either", noLimits.searched === false && noLimits.did.length === 0);
  check("the caller no longer reads feelings or sent items itself: the sweep's record does", !/getEmotionalContext|sentItems\(candidate\.userId\)/.test(src("services/eventSurfacingSweep.ts").slice(src("services/eventSurfacingSweep.ts").indexOf("async function findFreshPending"), src("services/eventSurfacingSweep.ts").indexOf("function sameMatch"))));
}

// ---------------------------------------------------------------- A2: the avoid list at keep and on the working set
{
  const hack = { name: "SF AI Hackathon", url: "https://h", reason: "48-hour hackathon for AI builders", tier: 3, kind: "opportunity" };
  const sat = { name: "Founder Supper", url: "https://s", tier: 1, kind: "public_event", details: { startAt: "2026-10-17T02:00:00Z", timezone: "America/Los_Angeles" } }; // Fri 7pm PT
  const sun = { name: "Sunday Brunch Circle", url: "https://b", tier: 1, kind: "public_event", details: { startAt: "2026-10-18T18:00:00Z", timezone: "America/Los_Angeles" } }; // Sun 11am PT
  const dinner = { name: "Small founder dinner", url: "https://d", tier: 1, kind: "public_event", details: { startAt: "2026-10-14T02:00:00Z", timezone: "America/Los_Angeles" } }; // Tue 7pm PT
  let prompt = "";
  const judge = { model: async (p: string) => { prompt = p; return '[{"n":1,"kind":"hackathons"},{"n":2,"kind":null},{"n":3,"kind":null},{"n":4,"kind":null}]'; } };
  const g = await L.limitsGate([hack, sat, sun, dinner], { avoid: ["hackathons"], availability: "weeknights only" }, { askText: "AI founder events", deps: judge });
  check("A2 keep: a ruled-out kind is out, judged by its main activity, with the reason in their terms", g.out.some((o) => o.match === hack && /stop suggesting hackathons/.test(o.why)) && /judged by its own main activity/.test(prompt), g.out);
  check("availability at keep, in code: a Sunday is out for 'weeknights only'; a weeknight stays", g.out.some((o) => o.match === sun && /outside when they said they're usually free/.test(o.why)) && g.kept.includes(dinner), g.out.map((o) => (o.match as any).name));
  const AV = await import("../../src/services/availability.js");
  check("review of #134: a negation the windows would read backwards is context, never a rule", ["can't do weekdays", "not mornings", "anytime except mornings", "busy weeknights", "never Sundays"].every((t) => !AV.availabilityIsLimit(t)) && !AV.availabilityConflict("can't do weekdays", "2026-10-18T02:00:00Z", "America/Los_Angeles") && !AV.availabilityConflict("busy weeknights", "2026-10-18T02:00:00Z", "America/Los_Angeles"));
  const askedSunday = await L.limitsGate([sun], { avoid: [], availability: "weeknights only" }, { askText: "anything fun this Sunday?" });
  check("review of #134: an ask that names a day or time asks for it: their usual availability doesn't overrule it", askedSunday.kept.length === 1 && L.askNamesATime("this weekend") && L.askNamesATime("Saturday hikes") && !L.askNamesATime("AI founder events") && !L.askNamesATime("trivia night") && !L.askNamesATime("good lunch spots") && !L.askNamesATime("a morning run club") && ["something after work", "drinks at 7pm", "evenings next month", "after 6", "around 6:30"].every((t) => L.askNamesATime(t)) && !["a 5k run club", "around 50 people", "from 20 companies", "at 3 venues"].some((t) => L.askNamesATime(t)));
  check("an ask's gate reads only what can hold it (paused, opted out, a safety hold): one query an hour while held", /if \(kind === "ask"\) \{[\s\S]{0,500}safetyHoldActive\(userId\)\) \? \["safety_hold"\] : \[\];/.test(src("harness/proactive.ts")) && P.SWEEP_BLOCKERS.ask.join() === "not_opted_out,safety_hold");
  check("re-review of #134: the sweep's keep passes the ask, so its day or time is honored there too", /limitsGate\(factGated, k\.limits \? \{ avoid: record\.avoid, availability: record\.availability, rules: k\.limits\.rules \} : null, \{ askText: c\.askText, onTopicReadFail: c\.fromProfile \? "hold" : "keep" \}\)/.test(src("services/sweepFind.ts")));
  check("found on the way: a leaning is not a limit ('more flexible on weekends' cut every weekday event; it's context now); 'only' and a bare window still are", !AV.availabilityIsLimit("more flexible on weekends") && !AV.availabilityConflict("more flexible on weekends", dinner.details.startAt, "America/Los_Angeles") && AV.availabilityIsLimit("weeknights only") && AV.availabilityIsLimit("evenings") && AV.availabilityIsLimit("no weekends") && AV.availabilityIsLimit("prefer weeknights only"));
  const lean = await L.limitsGate([sun, dinner], { avoid: [], availability: "more flexible on weekends" }, { deps: judge });
  check("so the keep holds nothing back for a leaning", lean.kept.length === 2 && !lean.out.length);
  const broken = await L.limitsGate([hack, dinner], { avoid: ["hackathons"], availability: null }, { deps: { model: async () => "sorry" } });
  check("when the judge can't be read, their own words still keep the rule (it never lapses on a failed call)", broken.read === "words" && broken.out.length === 1 && broken.out[0].match === hack && broken.kept[0] === dinner);
  const wrongKind = L.readAvoidAnswer('[{"n":1,"kind":"poetry"}]', 1, ["hackathons"]);
  check("the judge can only name a kind on their list", wrongKind?.[0] === null);
  check("the sweep runs the limits gate after the fact gate, for every member, and logs what it took out", /const limits = await limitsGate\(factGated,/.test(src("services/sweepFind.ts")) && /limitsOut: limits\.out\.map/.test(src("services/sweepFind.ts")));
  check("review of #134: no false hits from words that only look plural or only say how a thing is", !L.avoidHits("New York tech week", ["news"]).length && L.avoidHits("tech news roundup", ["news"]).length === 1 && !L.avoidHits("SF founder dinner late October", ["anything late"]).length && !L.avoidHits("big founder dinner", ["big events"]).length && L.kindWords("big events").length === 0 && L.kindWords("chess").join() === "chess");
  check("kind words: 'crypto events' is the kind 'crypto'; plurals are the same word", L.kindWords("crypto events").join() === "crypto" && L.avoidHits("Hackathon night", ["hackathons"]).length === 1 && !L.avoidHits("AI founders dinner", ["hackathons"]).length);
  // The working set: a kind ruled out takes what's waiting.
  const store = new Map<string, any[]>([["a1", [{ askText: "AI events", match: { name: "Cal Hacks", url: "https://cal" } }, { askText: "AI events", match: { name: "Founder Dinner", url: "https://fd" } }]]]);
  const facts: any[] = [], skipped: string[] = [];
  const r = await W.exitAvoidedFinds("u", "hackathons", {
    backlogs: async () => [...store.entries()].map(([ask_id, items]) => ({ ask_id, items })),
    merge: async (_u, askId, change) => { store.set(askId, W.applyChange(store.get(askId)!, change, F.exitKey)); },
    key: F.exitKey,
    writeFact: async (e) => { facts.push(e); },
    judge: async (items) => items.map((i) => (/Cal Hacks|Hack Night/.test(i.name) ? "hackathons" : null)),
    pending: async () => [{ id: "c9", match: { name: "Hack Night SF", url: "https://hn" }, askText: "AI events" }],
    skipPending: async (id) => { skipped.push(id); },
  });
  check("A2 working set: a backlog find of that kind leaves, a queued offer is skipped, each with its fact first", r.backlog === 1 && r.queued === 1 && store.get("a1")!.map((i) => i.match.name).join() === "Founder Dinner" && skipped.join() === "c9" && facts.length === 2 && facts.every((f) => f.state === "rejected" && /stop suggesting hackathons/.test(f.reason) && /the rule itself is on their record/.test(f.scope)), { r, facts });
  const lt = src("agent/loopTools.ts");
  check("A2 live search: every reply search (events, web, X) refuses a ruled-out kind before it runs, unless this text names it", (lt.match(/const avoided = await ruledOut\(/g) ?? []).length === 3 && /avoidHits\(query, avoidFor\(l\.avoid, askWords\(\)\)\)/.test(lt) && /M\.realKnowledgeDeps\.limits\(ctx\.userId\)/.test(lt));
  check("A2 live keep: shareFinds holds every item (this turn's or the shortlist's) to their limits before anything sends", /const g = await limitsGate\(known\.map[\s\S]{0,200}\{ askText: askWords\(\), onTopicReadFail: "keep" \}\)/.test(lt) && /if \(outByLink\.has\(it\.link\)\) \{\s*refused\.push/.test(lt) && /const known = items\.map\(\(it\) => \(\{ link: it\.link, f: foundFor\(it\.link\) \}\)\)/.test(lt));
  const many = new Map<string, any[]>([["a1", Array.from({ length: 25 }, (_, i) => ({ askText: "x", match: { name: `Thing ${i}`, url: `https://t/${i}` } }))]]);
  const judgedNames: string[][] = [];
  const r2 = await W.exitAvoidedFinds("u", "hackathons", {
    backlogs: async () => [...many.entries()].map(([ask_id, items]) => ({ ask_id, items })),
    merge: async (_u, askId, change) => { many.set(askId, W.applyChange(many.get(askId)!, change, F.exitKey)); },
    key: F.exitKey,
    writeFact: async () => {},
    judge: async (items) => { judgedNames.push(items.map((i) => i.name)); return items.map((i) => (/Hack|Thing 24/.test(i.name) ? "hackathons" : null)); },
    pending: async () => [{ id: "c1", match: { name: "Hack Night", url: "https://hn" }, askText: "x" }],
    skipPending: async () => {},
  });
  check("review of #134: queued offers are judged first, and everything waiting is judged (a full backlog no longer hides them)", judgedNames[0][0] === "Hack Night" && judgedNames.flat().length === 26 && r2.queued === 1 && r2.backlog === 1, { judged: judgedNames.map((j) => j.length), r2 });
  check("steerAwayFrom runs it in the background when a kind is added (not on undo)", /if \(!undo\) \{[\s\S]{0,400}W\.exitAvoidedFinds\(userId, k, \{ \.\.\.S\.realPruneDeps, \.\.\.S\.realAvoidDeps \}\)/.test(src("agent/conversationTools.ts")));
}

// ---------------------------------------------------------------- A3 + the work order's second test: a backed-off member gets zero sweeps
{
  const send = (h: number, type = "event_offer") => ({ type, targetKey: `t${h}`, topicKey: null, sentAt: ago(h), exempt: false });
  const base = { now: NOW, timezone: "America/Los_Angeles", optedOut: false, lastInboundAt: ago(2), sends: [] as any[], needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [] as any[] };
  const st = (o: any = {}, hold: any = {}) => ({ state: { ...base, ...o }, holdUntil: hold.holdUntil ?? null, spaceUntil: hold.spaceUntil ?? null });
  check("an engaged member sweeps (both kinds)", !P.sweepBlockedBy(st(), "goal").length && !P.sweepBlockedBy(st(), "ask").length);
  const dormant = st({ lastInboundAt: ago(24 * 20), sends: [send(30), send(80), send(130), send(200)] });
  check("test: a dormant member with unanswered texts gets zero goal sweeps (the discovery pace that holds their finds)", P.sweepBlockedBy(dormant, "goal").some((x) => ["engagement_pace", "weekly_cap", "unanswered_pause"].includes(x)), P.sweepBlockedBy(dormant, "goal"));
  check("their asks are still answered (an answer skips the discovery pace, as at dispatch)", !P.sweepBlockedBy(dormant, "ask").length);
  const muted = st({ suppressedKinds: ["find"] });
  check("test: a member whose finds are backed off (kind restraint) gets zero goal sweeps; an ask's answer still goes", P.sweepBlockedBy(muted, "goal").includes("kind_restraint") && !P.sweepBlockedBy(muted, "ask").length);
  check("a safety hold stops every sweep; finds paused for everyone too", P.sweepBlockedBy(st({ safetyHold: true }), "ask").includes("safety_hold") && P.sweepBlockedBy(st(), "goal", ["event_offer"]).includes("paused") && !P.sweepBlockedBy(st(), "goal", ["companion"]).length);
  check("review of #134: the pick's hold (cleared only by a new find) and the hours of space after a task never stop a sweep", !P.sweepBlockedBy(st({}, { holdUntil: new Date(NOW.getTime() + 6 * 3_600_000) }), "ask").length && !P.sweepBlockedBy(st({}, { spaceUntil: new Date(NOW.getTime() + 3_600_000) }), "goal").length);
  check("hours, the daily cap and spacing never stop a sweep (they clear within the day)", !P.sweepBlockedBy(st({ now: new Date("2026-10-10T10:00:00Z"), sends: [{ ...send(1, "companion"), exempt: false }] }), "ask").length);
  check("the gate is dispatch's own state and checks (one builder, memberSendState), never a copy", /export function sweepBlockedBy[\s\S]{0,1600}evaluateCandidates\(\{ \.\.\.s\.state, candidates: \[find\] \}\)/.test(src("harness/proactive.ts")) && /return sweepBlockedBy\(await memberSendState\(userId, person, now\), kind\);/.test(src("harness/proactive.ts")));
  const calls: string[] = [];
  const row = { user_id: "u", goals: ["meet founders"], intent: [], last_attempted_at: null, cooldown_cleared: true };
  const run = async (r: any, held: string[]) => {
    calls.length = 0;
    await GS.runGoalSweep(async (items: any[], _n: number, fn: any) => { for (const i of items) await fn(i); }, {
      rows: async () => [r],
      mark: async () => { calls.push("mark"); },
      plan: async () => { calls.push("plan"); return { searchText: "x" }; },
      surface: async () => { calls.push("surface"); },
      held: async () => held,
      skipped: async (_r, why) => { calls.push(`skipped:${why}`); },
    });
    return calls.join(",");
  };
  check("test: a held member costs zero goal sweeps: no plan, no search; the budget is marked so it's looked at again later", (await run(row, ["unanswered_pause"])) === "mark,skipped:held");
  check("a member nothing holds is planned and searched", (await run(row, [])) === "mark,plan,surface");
  check("a gate that can't be read holds (nothing spent on a guess)", /deps\.held\(row\.user_id\)\.catch\(\(\) => \["gate_unreadable"\]\)/.test(src("services/goalSweep.ts")));
  const jobs = src("jobs/index.ts");
  const gate = jobs.slice(jobs.indexOf("// Zero sweeps for a member dispatch would hold every find for"), jobs.indexOf("const localToday = DateTime.now()"));
  check("the ask sweep checks the gate once per member, only when an ask is due (run-today, backoff, daily cap), before any search", /askSearchDue\(r\)( && cadenceDue\(r\))?\)/.test(gate) && /ranToday >= MAX_ASK_SEARCHES_PER_USER_PER_DAY\) return;/.test(gate) && /sweepHold\(userRows\[0\]\.user_id, "ask"\)[\s\S]{0,200}decision: "sweep\.held"[\s\S]{0,200}return;/.test(gate) && jobs.indexOf('sweepHold(userRows[0].user_id, "ask")') < jobs.indexOf("await attemptEventSurfacing({"));
  check("review of #134: a held ask is never marked attempted (a held day doesn't move its backoff clock)", !/UPDATE ask_checkins/.test(gate));

  // ---------------------------------------------------------------- A4 + the work order's third test: the goal cooldown is enforced
  check("test: a find within the cooldown means no goal sweep (no plan, no search), not a computed-and-logged flag", (await run({ ...row, cooldown_cleared: false }, [])) === "mark,skipped:cooldown");
}

// ---------------------------------------------------------------- A4: goal planning reads the record
{
  const rec = { person: "a technical founder", statedTaste: ["a room where they can drop their guard"], avoid: ["hackathons"], openAsks: ["a quiet coworking spot"] };
  const p = G.edgePrompt(["meet other founders"], { city: "San Francisco", today: "2026-10-10", record: rec });
  check("A4: edges see who they are, the room they want, what they ruled out and what their asks already search", /Who they are \(Cue's record\): a technical founder/.test(p) && /drop their guard[\s\S]*Write edges for that kind of room/.test(p) && /stop suggesting: "hackathons"\. Never an edge/.test(p) && /don't write an edge that repeats one: "a quiet coworking spot"/.test(p));
  const e = G.parseEdges(["meet other founders"], '[{"n":1,"kind":"findable","edges":["SF founder hackathons October","small SF founder dinners"],"why":""}]', "Jordan", { today: "2026-10-10", avoid: ["hackathons"] });
  check("an edge for a ruled-out kind is dropped in code, however the model wrote it", e[0].edges.join() === "small SF founder dinners", e[0].edges);
  const gs = src("services/goalSweep.ts");
  check("the plan reads the record: active goals on file only, the limits, taste, open asks, the person", /memberKnowledge\(row\.user_id, \{ include: \["goals", "asks", "preferences", "limits", "person"\] \}\)/.test(gs) && /planGoals\(row, k\.goals\)/.test(gs) && /if \(!k\.limits\) throw/.test(gs));
  const k = await MK.memberKnowledge("u", { now: NOW, include: ["goals"] }, deps({ goalStates: async () => [{ goalHash: G.goalHash("old plan"), goal: "old plan", state: "active", reason: "", source: "member", changedAt: ago(500), toldAt: null, hints: 0 }] }));
  const row = { goals: ["intro me to Maya's team at Stripe", "meet other founders"], intent: [] };
  const recordGoals = [{ hash: G.goalHash("intro me to Maya's team at Stripe"), state: "active", onFile: true, text: "intro me to another member's team" }, { hash: G.goalHash("meet other founders"), state: "active", onFile: true, text: "meet other founders" }];
  check("review of #134: the plan uses their own words, chosen by the record's hash (a stripped goal keeps its state row)", GS.planGoals(row, recordGoals).join("|") === "intro me to Maya's team at Stripe|meet other founders" && GS.planGoals(row, [{ ...recordGoals[1], state: "done" }]).length === 0 && /planGoals\(row, k\.goals\)/.test(src("services/goalSweep.ts")) && /const STRUCTURAL = new Set\(\["hash",/.test(src("services/memberKnowledge.ts")));
  check("a closed goal entry is done and a state row whose goal is gone isn't on file: neither is planned", k.goals.find((g) => g.text === "run a marathon")?.state === "done" && k.goals.find((g) => g.text === "old plan")?.onFile === false && k.goals.filter((g) => g.state === "active" && g.onFile).map((g) => g.text).join() === "meet other founders who aren't performing");
}

// ---------------------------------------------------------------- A5 + the work order's fourth test: taste ranks a non-picker member's finds
{
  const items = [
    { match: { name: "Big expo", tier: 1, taste: "neutral" } },
    { match: { name: "Founder fireside, no stage", tier: 1, taste: "matches" } },
    { match: { name: "Unrated", tier: 1 } },
    { match: { name: "Quiet supper club", tier: 1, taste: "matches" } },
  ];
  check("test: what matches the room they want goes first in a non-picker member's backlog, otherwise in order", ES.byTaste(items).map((i) => i.match.name).join("|") === "Founder fireside, no stage|Quiet supper club|Big expo|Unrated");
  const ess = src("services/eventSurfacingSweep.ts");
  check("the backlog orders by taste in both groups (urgent, and the tier rotation), for every member", /\.\.\.byTaste\(merged\.filter\(\(i\) => i\.source === "urgent"/.test(ess) && /interleaveByTier\(\s*byTaste\(merged\.filter/.test(ess));
  const sf = src("services/sweepFind.ts");
  check("the sweep's keep carries a taste, refuses what clashes, and orders its keeps matches first", /taste: z\.enum\(\["matches", "neutral", "clashes"\]\)/.test(sf) && /if \(fit === "clashes"\) \{[\s\S]{0,200}isn't kept/.test(sf) && /const gated = limits\.kept\.map\(\(m, i\) => \(\{ m, i \}\)\)\.sort\(\(a, b\) => rankOf\(a\.m\) - rankOf\(b\.m\)/.test(sf));
  const fit = ED.fitPrompt({ name: "Startup Expo", kind: "public_event" } as any, { firstName: "Jordan", askText: "founder events", roomTaste: ["a room where they can drop their guard"] }, "");
  check("the reveal's fit read sees their stated taste too", /The kind of room they've told Cue they want, in their words: "a room where they can drop their guard"/.test(fit));
  check("goal planning and the picker already read it (edges above; sweepSelect roomTaste)", /roomTaste: k\.preferences\.filter\(\(p\) => p\.source === "stated"\)/.test(src("services/sweepSelectContext.ts")));
}

// ---------------------------------------------------------------- A6: one reader per fact
{
  const ed = src("services/eventDetails.ts");
  check("A6 avoid/availability: one reader (the record's limits); explainFit and the asks listing read it there", !/FROM co_profiles/.test(ed) && /memberKnowledge\(userId, \{ include: \["limits", "person", "preferences"\] \}\)/.test(ed) && /realKnowledgeDeps\.limits\(ctx\.userId\)/.test(src("agent/conversationTools.ts")) && !/SELECT intent, avoid FROM co_profiles/.test(src("agent/conversationTools.ts")));
  check("A6 the person picture: explainFit reads the record's person model, never the raw snapshot", !/getPersonSnapshot|renderSnapshot/.test(ed));
  check("review of #134: a record that fails closed still has their limits applied in explainFit (the same reader, alone)", /const limits = k\?\.limits \?\? \(person\.userId \? await import\("\.\/memberKnowledge\.js"\)\.then\(\(M\) => M\.realKnowledgeDeps\.limits\(person\.userId!\)\)/.test(ed));
  const k = await MK.memberKnowledge("u", { now: NOW, include: ["corrections"], corrections: { limit: 40, days: null } }, deps());
  check("A6 corrections: one reader with a window the caller sets (replies the recent 8, goal planning all 40)", seen.corrections?.limit === 40 && seen.corrections?.days === null && k.corrections.length === 1 && /realKnowledgeDeps\.corrections\(userId, \{ limit: 40, days: null \}\)/.test(src("services/goalEdges.ts")) && !/FROM profile_corrections/.test(src("services/goalEdges.ts")));
  await MK.memberKnowledge("u", { now: NOW, include: ["corrections"] }, deps());
  check("the default window is unchanged for every other path", seen.corrections?.limit === 8 && seen.corrections?.days === 90);
  const body = src("harness/proactive.ts").slice(src("harness/proactive.ts").indexOf("export async function dispatchForUser"));
  check("A6 restraint and emotion: read once at dispatch, for the gates and the drafts", /\{ restraint: async \(\) => member\.raw \}/.test(body) && /const feelingText = member\.raw\.emotional \? renderEmotionalContext\(member\.raw\.emotional\) : "";/.test(body) && !/getEmotionalContext\(/.test(body));
  check("A6 'what was sent': the sweep reads the record's merged list, not a third read", !/reactionCatchup/.test(src("services/eventSurfacingSweep.ts")) && /shown: k\.delivered\.map/.test(src("services/sweepFind.ts")));
  check("A6 raw profile goals: the sweep's names-out list and the plan read goals with their state", /memberTerms\(\{ firstName: c\.firstName, goals: record\.goalWords/.test(src("services/sweepFind.ts")) && !/goals: candidate\.goals/.test(src("services/eventSurfacingSweep.ts").slice(src("services/eventSurfacingSweep.ts").indexOf("async function findFreshPending"))));
  const r = MK.restraintOf({ holdUntil: null, spaceUntil: null, safetyHold: false, emotional: null, suppressed: [], trial: ["find"], lastInboundAt: null, unansweredSends: [] }, NOW);
  check("found on the way: a kind whose days off are up was never named as a trial (suppressed && trial is never true); now it is", r.trialKinds.join() === "find" && /filter\(\(v\) => v\.trial\)/.test(src("services/memberKnowledge.ts")) && /one trial may go now \(find\)/.test(MK.restraintRule(r, null)));
}

// ---------------------------------------------------------------- the small items carried from #133's re-review
{
  const sf = src("services/sweepFind.ts");
  check("a web search that fails outright is an outage, not an empty run (taskWebSearch says so in its note; it never returns null)", /if \(all\.every\(\(r\) => r === null \|\| \/\^Web search failed\/\.test\(r\.note \?\? ""\)\)\) \{\s*blocked = true;/.test(sf) && /note: `Web search failed: /.test(src("services/taskWeb.ts")));
  const k = F.exitKey;
  const held = { askText: "x", match: { name: "Pop-up", url: "https://p" }, unread: { days: ["2026-10-09"], why: "unknown" } };
  const classified = { askText: "x", match: { name: "Pop-up", url: "https://p", form: "opening" } };
  const merged = W.mergeSweepSave([held], [held], [classified], k);
  check("a held item a prune classified meanwhile keeps the prune's version when the sweep left it alone", merged.length === 1 && !merged[0].unread && merged[0].match.form === "opening", merged);
  const sweepChanged = { ...held, reminder: true };
  check("when both changed it, the sweep's version wins, with the read days since", W.mergeSweepSave([held], [sweepChanged], [{ ...held, unread: { days: ["2026-10-09", "2026-10-10"], why: "unknown" } }], k)[0].unread.days.length === 2 && W.mergeSweepSave([held], [sweepChanged], [classified], k)[0].reminder === true);
  const on = (t: string) => [...F.datesOnPage(t, 2026)];
  check("'rated 4/5' and 'ver. 1.2.2026' aren't dates; a real date still is", !on("rated 4/5").length && !on("ver. 1.2.2026").length && on("Doors 10/12").join() === "2026-10-12");
  check("a name with two group words isn't a place; plain 'women' and 'men' are group words", Q.assumedIdentity("Gay Men's Chorus Hall", "choir").length === 2 && Q.assumedIdentity("Women in Tech mixer", "mixers").join() === "women" && !Q.assumedIdentity("Asian Art Museum night", "events").length && !Q.assumedIdentity("women founders dinner", "dinners for women founders").length);
}

console.log(`phase A, know and filter early: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
