// Cold start (Royce, 2026-10-08), layer 1: zero tokens, no database (pure functions, stubbed sweep deps, the source's own text).
//   1. seeds: what counts as a findable interest (active findable goals, open find asks, what they enjoy as one), what doesn't
//   2. steering: an unseeded member's reply gets the steering instruction, with its guardrails in the text
//   3. guardrails in the state: never in a heavy moment or while frustrated, never two in a row, a weekly cap, never beside
//      another question (a call offer, a set-aside goal), never re-asking what was asked; it stops once 2 to 3 seeds exist
//   4. backfill: an existing member with no findable goals gets it on their next reply; one with 3 doesn't
//   5. sweeps from day one: 2 seeded goals are due right away and get a plan with edges; a new member's changed seeds rerun early
//   6. a new member's empty sweep is a flagged miss (decision + monitor signal); an established member's is a normal pass
//   7. wiring: the turn loads it, the reply records it, the sweep notes it, extraction keeps an answered interest
//   npx tsx evals/coldstart/rules.ts   (or: node evals/runLayer1.mjs coldstart)
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const C = await import("../../src/services/coldStart.js");
const RG = await import("../../src/harness/replyGrounding.js");
const RA = await import("../../src/harness/repeatAsk.js");
const G = await import("../../src/services/goalEdges.js");
const GS = await import("../../src/services/goalSweep.js");
const M = await import("../../src/harness/monitor.js");
const PE = await import("../../src/services/profileExtraction.js");
const CAP = await import("../../src/services/capabilities.js");
const CC = await import("../../src/services/callContext.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const calm = { current: null, lastCall: null, recurring: [], needsCare: false, withCo: { frustrated: false, about: null, count: 0 } } as any;
const heavy = { ...calm, needsCare: true } as any;
const frustrated = { ...calm, withCo: { frustrated: true, about: "what Co found", count: 2 } } as any;
const view = (seeds: ReturnType<typeof C.countSeeds>, history: any[] = [], joinedAt: Date | null = daysAgo(1)) => ({ seeds, history, joinedAt });
const steer = (cs: any, emotional: any = calm, otherQuestion: string | null = null) => {
  const rf = RG.createReplyFacts();
  const r = RG.addColdStartSteer(rf, cs, { emotional, otherQuestion, now: NOW });
  return { rf, r, instruction: rf.instructions.find((i) => i === r?.instruction) ?? null };
};
const EMPTY = C.countSeeds({ goals: [], findAsks: [] });
const ROYCE = ["partnering with Sequin AI for a November launch party", "have Co draft planning docs for branding and launch strategy with Sequin AI", "maintain Co's presence after the November event"];

// ---- 1. seeds
{
  check("an empty profile has no seeds and isn't seeded", EMPTY.n === 0 && !EMPTY.seeded);
  const two = C.countSeeds({ goals: ["find a run club in the Marina", "meet other climate founders"], findAsks: [] });
  check("two findable goals are seeded (the target is 2)", two.n === 2 && two.seeded && C.COLD_START.seedTarget === 2);
  const royce = C.countSeeds({ goals: ROYCE, findAsks: [], passedByLastPlan: [ROYCE[0]] });
  check("Co's own tasks never count, and a goal the last sweep passed as having no findable side doesn't either", royce.n === 0 && royce.notFindable.length === 3, royce);
  const unread = C.countSeeds({ goals: [ROYCE[0]], findAsks: [] });
  check("...while a goal no sweep has read yet counts until one does", unread.n === 1);
  const states = new Map([[G.goalHash("find a run club in the Marina"), { state: "done" as const }], [G.goalHash("meet other climate founders"), { state: "stale" as const }]]);
  check("done and stale goals don't count", C.countSeeds({ goals: ["find a run club in the Marina", "meet other climate founders"], findAsks: [], states }).n === 0);
  check("an open find ask counts; one that restates a goal counts once", C.countSeeds({ goals: ["meet other climate founders"], findAsks: ["small founder dinners in SF", "meet other climate founders"] }).n === 2);
  check("Co's own promise saved as an ask never counts", C.countSeeds({ goals: [], findAsks: ["I'll send the outline tonight"] }).n === 0);
  const tastes = C.countSeeds({ goals: [], findAsks: [], enjoys: ["hiking", "jazz", "ceramics", "natural wine"] });
  check("what they enjoy counts as ONE seed however many, so tastes alone still get one more question", tastes.n === 1 && !tastes.seeded && tastes.seeds[0].from === "enjoys");
  check("their direction is read like a goal", C.countSeeds({ goals: ["find a run club"], findAsks: [], direction: "build a life in SF with people who make things" }).n === 2);
  check("a plan that couldn't be read says nothing about what's findable", C.passedInPlan({ reason: "the goals couldn't be read this time", proposal: { passed: [{ goal: "x", why: "work: couldn't be read this time" }] } }).length === 0 && C.passedInPlan({ reason: "no active goal with a findable side", proposal: { passed: [{ goal: "x", why: "work: their own plan" }] } }).join() === "x");
}

// ---- 2. steering for a brand-new member with an empty profile
{
  const { rf, r, instruction } = steer(view(EMPTY));
  check("a new member with an empty profile gets the steering instruction on their reply", !!r?.offered && !!instruction && rf.instructions.includes(instruction!), r);
  const t = instruction ?? "";
  check("it names what to steer toward: a scene, a kind of event, people to meet, something they're exploring", /scene/.test(t) && /kind of event/.test(t) && /people they'd want to meet/.test(t) && /exploring/.test(t));
  check("guardrail: ONE question at most, and only when nothing else is being asked", /ONE easy question/.test(t) && /One question at most in this reply, and only when you aren't asking them anything else/.test(t));
  check("guardrail: it follows their topic, never a jump", /follows their topic/.test(t) && /never jump to a new subject/.test(t) && /grows naturally out of what they just said/.test(t));
  check("guardrail: never a quiz (no list of questions, no form-style interests question, never says it's collecting)", /Never a list of questions/.test(t) && /like a form would ask/.test(t) && /never mention a profile, a search setup or that you're collecting/.test(t));
  check("guardrail: a message that needs an answer just gets the answer", /needs a real answer or is about something else, just answer it/.test(t));
  check("what they name is saved through the normal ask path (saveAsk), and not asked again", /save it with saveAsk in their words/.test(t) && /don't ask about it again/.test(t));
  check("the instruction shows no quoted survey question for Co to copy", !/"what are your interests\?"|"tell me about your hobbies"/i.test(t));
  check("written the way Co texts: no em dashes, no exclamation points", !/[—–]/.test(t) && !/!/.test(t));
  const one = C.countSeeds({ goals: ["find a run club in the Marina"], findAsks: [] });
  check("with one seed it says what's there and still steers", /only one thing on file/.test(steer(view(one)).instruction ?? "") && /run club/.test(steer(view(one)).instruction ?? ""));
}

// ---- 3. guardrails in the state
{
  const h = steer(view(EMPTY), heavy);
  check("never in a heavy moment: no instruction, recorded why", !h.r?.offered && !h.rf.instructions.some((i) => /ONE easy question/.test(i)) && h.r?.why === "a heavy moment");
  const f = steer(view(EMPTY), frustrated);
  check("never while they're frustrated with Co", !f.r?.offered && /frustrated/.test(f.r?.why ?? ""));
  const after = steer(view(EMPTY, [{ action: "steered", at: hoursAgo(1), question: "What kind of rooms do you find yourself wanting more of lately?" }]));
  check("never two replies in a row that both steer", !after.r?.offered && after.r?.why === "the last reply steered");
  const rested = steer(view(EMPTY, [{ action: "rested", at: hoursAgo(0.5), question: null }, { action: "steered", at: hoursAgo(1), question: "What kind of rooms do you find yourself wanting more of lately?" }]));
  check("after a reply that rested, it may steer again", !!rested.r?.offered);
  check("...and the question already asked is named so it's never asked again", /You already asked them: "What kind of rooms do you find yourself wanting more of lately\?"/.test(rested.instruction ?? "") && /Never ask any of these again, in any wording/.test(rested.instruction ?? ""));
  const week = [0.5, 10, 20, 40].map((h, i) => ({ action: i % 2 ? "steered" : "rested", at: hoursAgo(h), question: i % 2 ? `q${i}?` : null }));
  const capped = steer(view(EMPTY, [...week, { action: "steered", at: hoursAgo(60), question: "q5?" }]));
  check("at most three steering questions a week", !capped.r?.offered && /3 steering questions this week/.test(capped.r?.why ?? ""), capped.r);
  const other = steer(view(EMPTY), calm, "a set-aside goal to ask about");
  check("never beside another question the reply already has", !other.r?.offered && /already has a question/.test(other.r?.why ?? ""));
  const w = steer(view(EMPTY));
  RG.withdrawColdStartSteer(w.rf, "this reply offers a call");
  check("a reply that offers a call takes the steering back off before it drafts", !w.rf.instructions.some((i) => /ONE easy question/.test(i)) && w.rf.coldStart?.offered === false && w.rf.coldStart?.why === "this reply offers a call");
  const two = C.countSeeds({ goals: ["find a run club in the Marina", "meet other climate founders"], findAsks: [] });
  const s2 = steer(view(two));
  check("steering stops once 2 seeds exist: no instruction, nothing to record", s2.r === null && !s2.rf.coldStart && s2.rf.instructions.length === 0);
  const three = C.countSeeds({ goals: ["find a run club in the Marina", "meet other climate founders"], findAsks: ["small founder dinners in SF"] });
  check("...and with 3", steer(view(three)).r === null && three.n === 3);
  // What the reply did with it, after it went out.
  check("a sent question on a steering reply records a steer", C.steerOutcome("Love that. What kind of people would you want around you there?", true, RA.questionsIn).action === "steered");
  check("no question: offered, not taken", C.steerOutcome("Congrats on the move. That neighborhood is great in the fall.", true, RA.questionsIn).action === "offered_not_taken");
  check("not offered: rested, and two questions are counted for the quiz signal", C.steerOutcome("Hm?", false, RA.questionsIn).action === "rested" && C.steerOutcome("What kind? And where?", true, RA.questionsIn).questions === 2);
}

// ---- 4. backfill: existing members, same mechanism, next natural reply, no outreach
{
  const royce = C.countSeeds({ goals: ROYCE, findAsks: [], passedByLastPlan: ROYCE });
  const old = steer(view(royce, [], daysAgo(90)));
  check("an existing member with zero findable goals gets the steering on their next reply", !!old.r?.offered && !!old.instruction);
  const full = C.countSeeds({ goals: ["find a run club in the Marina", "meet other climate founders", "SF ceramics studios with open hours"], findAsks: [] });
  check("...and one with 3 doesn't", steer(view(full, [], daysAgo(90))).r === null);
  check("the hint never depends on when they joined (backfill uses the same seeded count)", !/joinedAt/.test(src("harness/replyGrounding.ts").split("export function addColdStartSteer")[1].split("\n}\n")[0]));
  check("no proactive outreach for it: nothing in coldStart queues or sends a text", !/enqueueCandidate|sendSMS|sendCoReply|sendAndLog/.test(src("services/coldStart.ts")));
}

// ---- 5. sweeps from day one
{
  const runAll = async (items: any[], _l: number, fn: (i: any) => Promise<void>) => { for (const i of items) await fn(i); };
  // A brand-new member whose opening conversation saved two findable goals: never swept before.
  const member = { user_id: "u1", first_name: "Jordan", phone_number: "+14155550100", joined_at: hoursAgo(5), city: "San Francisco", goals: ["meet other climate founders", "find a run club in the Marina"], activity_preferences: [], long_term_direction: "", intent: [], last_attempted_at: null, cooldown_cleared: true };
  check("a member with 2 seeded goals and no sweep yet is due right away", GS.goalSweepDue(member) && GS.goalSweepRuns(member, GS.rowSeedSignature(member), null, NOW).run);
  const goalLog: any[] = [];
  const goalDeps: any = {
    model: async () => JSON.stringify([{ n: 1, kind: "findable", edges: ["climate founder meetups SF"], until: null, superseded_by: null }, { n: 2, kind: "findable", edges: ["Marina run clubs"], until: null, superseded_by: null }]),
    states: async () => new Map(), setState: async () => {}, corrections: async () => [], retired: CC.retiredBy, findAsks: async () => [], helpAsk: async () => {},
    log: async (d: any) => { goalLog.push(d); },
  };
  const surfaced: string[] = [], marked: string[] = [];
  await GS.runGoalSweep(runAll as any, {
    rows: async () => [member],
    mark: async (id) => { marked.push(id); },
    surface: async (_r, ctx) => { surfaced.push(ctx); },
    plan: (row, seedSig) => G.planGoalSweep(row.user_id, GS.goalSweepGoals(row) ?? [], { city: row.city, zone: "America/Los_Angeles", now: NOW, seedSig }, goalDeps),
    lastSeedSig: async () => null,
  });
  check("...and gets a goal sweep plan with edges on the first run", marked.join() === "u1" && surfaced.length === 1 && /climate founder meetups SF/.test(surfaced[0]) && /Marina run clubs/.test(surfaced[0]), surfaced);
  check("the plan logs the seed signature it read", goalLog[0]?.proposal?.seedSig === GS.rowSeedSignature(member));
  // Swept two hours ago with one goal; the second seed landed since.
  const sig1 = GS.rowSeedSignature({ ...member, goals: ["meet other climate founders"] });
  const recent = { ...member, last_attempted_at: hoursAgo(2) };
  check("a new member whose seeds changed since the last run is swept again now, not 20 hours later", GS.goalSweepRuns(recent, GS.rowSeedSignature(recent), sig1, NOW).why === "new_seeds");
  check("...unchanged seeds wait for the budget", !GS.goalSweepRuns(recent, GS.rowSeedSignature(recent), GS.rowSeedSignature(recent), NOW).run);
  check("...and an established member waits for the budget whatever changed", !GS.goalSweepRuns({ ...recent, joined_at: daysAgo(60) }, GS.rowSeedSignature(recent), sig1, NOW).run);
  const sql = GS.GOAL_SWEEP_SQL;
  check("the query brings in new members whose profile changed, after the budget's due members, with the old budget intact", /u\.created_at > NOW\(\) - INTERVAL '7 days' AND cp\.updated_at > pss\.last_attempted_at/.test(sql) && /ORDER BY \(pss\.last_attempted_at IS NULL OR pss\.last_attempted_at <= NOW\(\) - INTERVAL '20 hours'\) DESC/.test(sql) && /INTERVAL '20 hours'/.test(sql) && /INTERVAL '3 days'/.test(sql) && !/ask_checkins/.test(sql));
  const order: string[] = [];
  await GS.runGoalSweep(runAll as any, { rows: async () => [{ ...recent, user_id: "early" }, { ...recent, user_id: "same" }], mark: async (id) => { order.push(id); }, surface: async () => {}, plan: async () => ({ searchText: "look for: x" }), lastSeedSig: async (id) => (id === "same" ? GS.rowSeedSignature(recent) : sig1) });
  check("in the run: the changed one is swept, the unchanged one isn't touched (not even marked)", order.join() === "early");
  check("a new find ask is searched by the next hourly ask sweep (never searched yet goes first)", /ac\.last_attempted_at ASC NULLS FIRST/.test(src("jobs/index.ts")));
}

// ---- 6. a new member's empty sweep is a flagged miss; an established member's is a normal pass
{
  const seeds = C.countSeeds({ goals: ["meet other climate founders"], findAsks: ["small founder dinners in SF"] }).seeds;
  const miss = C.coldStartRecord({ userId: "u1", joinedAt: daysAgo(2), now: NOW, sweep: "ask", searched: "small founder dinners in SF", found: false, why: "the search found nothing", tried: ["events: founder dinners, next two weeks", "web: SF founder dinner series"], seeds });
  check("a new member's empty sweep records sweep.cold_start_miss", miss?.decision === "sweep.cold_start_miss" && miss.outcome === "skip" && miss.reason === "the search found nothing", miss);
  check("...with their seeds, the queries tried, and how many days in", (miss?.proposal.seeds as any[]).length === 2 && (miss?.proposal.tried as string[]).includes("web: SF founder dinner series") && miss?.proposal.daysSinceJoined === 2);
  check("an established member's empty sweep is a normal pass: nothing recorded", C.coldStartRecord({ userId: "u2", joinedAt: daysAgo(30), now: NOW, sweep: "ask", searched: "x", found: false, why: "the search found nothing" }) === null);
  check("a new member's sweep that found something is a hit (the share the monitor reads)", C.coldStartRecord({ userId: "u1", joinedAt: daysAgo(1), now: NOW, sweep: "goal", searched: "x", found: true, why: "" })?.decision === "sweep.cold_start_hit");
  check("the window is the first 7 days", C.isNewMember(daysAgo(6.9), NOW) && !C.isNewMember(daysAgo(7.1), NOW) && !C.isNewMember(null, NOW));
  // The goal sweep: a new member whose goals have no findable side.
  const runAll = async (items: any[], _l: number, fn: (i: any) => Promise<void>) => { for (const i of items) await fn(i); };
  const misses: { id: string; why: string }[] = [];
  const base = { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco", goals: ROYCE, activity_preferences: [], long_term_direction: "", intent: [], last_attempted_at: null, cooldown_cleared: true };
  const surfaced: string[] = [];
  await GS.runGoalSweep(runAll as any, { rows: async () => [{ ...base, user_id: "new", joined_at: new Date(Date.now() - 86_400_000) }, { ...base, user_id: "old", joined_at: new Date(Date.now() - 60 * 86_400_000) }], mark: async () => {}, surface: async (_r, c) => { surfaced.push(c); }, plan: async () => ({ searchText: null, passed: ROYCE.map((g) => ({ goal: g, why: "work: their own plan" })) }), coldStartMiss: async (row, why) => { misses.push({ id: row.user_id, why }); } });
  check("goal sweep: a new member with nothing findable to search is a miss; the established member isn't; nothing is sent", misses.length === 1 && misses[0].id === "new" && /findable side/.test(misses[0].why) && surfaced.length === 0, misses);
  // The monitor.
  const sig = M.SIGNALS.find((s) => s.key === "cold_start_miss");
  check("the monitor watches cold-start misses (any one alerts, at most daily)", !!sig && /decision = 'sweep\.cold_start_miss'/.test(sig.bad) && /sweep\.cold_start_hit/.test(sig.total) && sig.minCount === 1 && !!sig.steady && sig.steady.repeatHours === 24);
  check("...one miss out of four new-member sweeps alerts", !!sig && M.shouldAlert({ signal: sig, recentBad: 1, recentTotal: 4, recentRate: 0.25, baselineRate: 0 }));
  check("...no misses doesn't", !!sig && !M.shouldAlert({ signal: sig, recentBad: 0, recentTotal: 4, recentRate: 0, baselineRate: 0 }));
  const quiz = M.SIGNALS.find((s) => s.key === "cold_start_quiz");
  check("the monitor also watches steering replies that asked more than one question", !!quiz && /\(proposal->>'questions'\)::int, 0\) > 1/.test(quiz.bad));
  check("the sweep notes every new member's run before it decides there's nothing to queue (and sends nothing for a miss)", /noteColdStartSweep\(\{ userId: candidate\.userId[\s\S]*?found: pending\.length > 0[\s\S]*?\n  if \(!pending\.length\) \{/.test(src("services/eventSurfacingSweep.ts")));
}

// ---- 7. wiring
{
  check("the turn loads the cold-start view for every reply", /loadColdStart\(userId, \{ profile, asks \}\)/.test(src("services/turnContext.ts")) && /coldStart(, [^;]*)? \};/.test(src("services/turnContext.ts")));
  check("the reply grounding adds it, after the set-aside goal and never beside it or a document offer", /addColdStartSteer\(rf, opts\.turn\.coldStart, \{ emotional: opts\.turn\.emotional, otherQuestion: aside \? "a set-aside goal to ask about" : docQuestion \}\)/.test(src("harness/replyGrounding.ts")));
  const cr = src("agent/conversationReply.ts");
  check("a reply that offers a call or meets a safety concern never also steers", /if \(input\.safetyConcern\) withdrawColdStartSteer[\s\S]{0,120}else if \(callOfferEligible\) withdrawColdStartSteer/.test(cr));
  check("what the reply did is recorded once it went out (never on a dry run)", /const cold = input\.facts\.coldStart;\s*if \(cold && state\.sent && !opts\.dryRun && opts\.record !== false\)/.test(cr) && /recordSteer\(input\.userId/.test(cr));
  check("steering history is read from those records", /decision = 'coldstart\.reply'/.test(src("services/coldStart.ts")));
  // Extraction: an interest named in answer to Co's question lands as a find request.
  for (const scope of ["last_user_message", "whole_transcript"] as const) {
    const p = PE.captureIntentPrompt("assistant: What kind of rooms do you want more of?\nuser: honestly small dinners with other founders", scope);
    check(`capture (${scope}): an interest named in answer to Co's question is still a seeking ask; facts about them aren't`, p.includes(PE.ANSWERED_INTEREST_RULE) && /answers to Co's questions/.test(p) && /Facts about who they are/.test(p));
  }
  const save = CAP.ABILITIES.find((a) => a.tool === "saveAsk");
  check("saveAsk's entry tells Co to save an interest they mention in passing or in answer", /in passing or answering you/.test(save?.use ?? "") && /scene/.test(save?.use ?? ""));
}

// Royce, 2026-10-08: "Cap it at 5 total. If 5 natural tries never produce a findable interest, stop asking and record that."
{
  const empty = C.countSeeds({ goals: [], findAsks: [] });
  const ask = (n: number) => C.steerDecision({ seeds: empty, heavy: false, history: [], now: new Date("2026-10-08T18:00:00Z"), lifetimeSteers: n });
  check("lifetime cap: 4 tries so far, a fifth may come", ask(4).steer);
  check("lifetime cap: after 5 tries, never again, with why", !ask(5).steer && /stopped asking: 5 natural tries/.test(ask(5).why));
  const src = fs.readFileSync(new URL("../../src/services/coldStart.ts", import.meta.url), "utf8");
  check("giving up is recorded once (coldstart.gave_up, only when not already on record)", /decision: "coldstart\.gave_up"/.test(src) && /!lifetime\.gave/.test(src) && C.COLD_START.steerLifetime === 5);
  check("the reply passes the lifetime count", /lifetimeSteers: cs\.lifetimeSteers/.test(fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")));
}

console.log(`cold start: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
