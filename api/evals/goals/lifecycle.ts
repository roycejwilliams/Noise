// Goals in the sweep and their lifecycle (Royce, 2026-10-08). Zero tokens: the model, the store and the clock are stubbed.
//   1. work and Co-task goals search only their findable edge, or pass with a logged reason; never raw goal text
//   2. a dated goal stops generating searches once its window passes (and stays on file)
//   3. a superseded goal (a correction, or a newer goal that replaces it) is marked stale and its searches end
//   4. a mixed list searches only the findable side of active goals; done goals aren't even read
//   5. find requests already saved from a work or Co-task goal are reclassified and stop being searched (and spending X)
//   6. every run derives from scratch (no cache); set-asides are told in the next natural reply, never silent
//   npx tsx evals/goals/lifecycle.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const G = await import("../../src/services/goalEdges.js");
const GS = await import("../../src/services/goalSweep.js");
const CC = await import("../../src/services/callContext.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const SF = "America/Los_Angeles";
const OCT8 = new Date("2026-10-08T17:00:00Z");

// Royce's goals on file, 2026-10-08 (work and Co tasks, no findable thing in their own words).
const ROYCE = [
  "partnering with Sequin AI for a November launch party",
  "have Co draft planning docs for branding and launch strategy with Sequin AI",
  "maintain Co's presence after the November event",
];

function harness(answer: (prompt: string) => string, o: { states?: Map<string, any>; corrections?: any[]; asks?: { id: number; text: string }[] } = {}) {
  const prompts: string[] = [], set: { goal: string; state: string; reason: string; source: string }[] = [], logs: any[] = [], helped: number[] = [];
  const states = o.states ?? new Map();
  const deps: any = {
    model: async (p: string) => { prompts.push(p); return answer(p); },
    states: async () => states,
    setState: async (_u: string, goal: string, state: string, reason: string, source: string) => { set.push({ goal, state, reason, source }); states.set(G.goalHash(goal), { goalHash: G.goalHash(goal), goal, state, reason, source, changedAt: new Date(), toldAt: null, hints: 0 }); },
    corrections: async () => o.corrections ?? [],
    retired: CC.retiredBy,
    findAsks: async () => o.asks ?? [],
    helpAsk: async (_u: string, id: number) => { helped.push(id); },
    log: async (d: any) => { logs.push(d); },
  };
  return { deps, prompts, set, logs, helped, states };
}
const plan = (h: ReturnType<typeof harness>, goals: string[], now = OCT8, extra: any = {}) => G.planGoalSweep("u1", goals, { city: "San Francisco", zone: SF, now, ...extra }, h.deps);
const rawIn = (text: string | null, goals: string[]) => !!text && goals.some((g) => text.toLowerCase().includes(g.toLowerCase()));

// ---- 1. work and Co-task goals: only the findable edge, or a logged pass
{
  const h = harness(() => JSON.stringify([
    { n: 1, kind: "work", edges: ["AI and founder gatherings in SF in November", "partnering with Sequin AI for a November launch party"], until: "2026-11-30", superseded_by: null, why: "their own partnership" },
    { n: 2, kind: "findable", edges: [], until: null, superseded_by: null, why: "Co's own drafting, nothing to find" },
    { n: 3, kind: "co_task", edges: ["open calls for consumer AI founders"], until: null, superseded_by: null, why: "" },
  ]));
  const p = await plan(h, ROYCE);
  check("the search is the findable edges, never a goal's own words", !!p.searchText && /AI and founder gatherings in SF in November/.test(p.searchText) && /open calls for consumer AI founders/.test(p.searchText) && !rawIn(p.searchText, ROYCE), p.searchText);
  check("an edge that restates the goal is dropped in code", !/partnering with Sequin AI for a November launch party/.test(p.searchText ?? ""));
  check("a Co task is a Co task whatever the model says (the asks guard, extended to goals)", G.isCoTaskGoal(ROYCE[1]) && G.isCoTaskGoal(ROYCE[2]) && !G.isCoTaskGoal("find a running club in the Marina"));
  check("a goal with no findable edge is passed with its reason", p.passed.some((x) => x.goal === ROYCE[1] && /co_task: Co's own drafting/.test(x.why)), p.passed);
  check("the plan is logged: what it searches, what it passed and why", h.logs.length === 1 && h.logs[0].action === "searching_edges" && h.logs[0].proposal.passed.length === 1);
  const none = harness(() => JSON.stringify(ROYCE.map((_, i) => ({ n: i + 1, kind: i === 0 ? "work" : "co_task", edges: [], until: null, superseded_by: null, why: "no findable side" }))));
  const np = await plan(none, ROYCE);
  check("all work with no findable side: no search at all, and the pass is logged with the reason", np.searchText === null && none.logs[0].action === "passed" && /no active goal with a findable side/.test(none.logs[0].reason) && np.passed.length === 3);
  const down = harness(() => { throw new Error("model down"); });
  const dp = await plan(down, ROYCE);
  check("the model can't be read: no search (never the raw goals as a fallback), logged as a failure (2026-10-09: never \"passed\")", dp.searchText === null && down.logs[0].action === "read_failed" && down.logs[0].failed === true && /couldn't be read/.test(down.logs[0].reason));
  // The real sweep: the plan's text is what's searched; a passed plan surfaces nothing.
  const member = { user_id: "u1", first_name: "Royce", phone_number: "+14155550100", city: "San Francisco", goals: ROYCE, activity_preferences: [], long_term_direction: "", intent: [], last_attempted_at: null, cooldown_cleared: true };
  const surfaced: string[] = [];
  await GS.runGoalSweep(async (items, _l, fn) => { for (const i of items) await fn(i); }, { rows: async () => [member], mark: async () => {}, surface: async (_r, ctx) => { surfaced.push(ctx); }, plan: async () => ({ searchText: null }) });
  check("the goal sweep surfaces nothing when the plan passes", surfaced.length === 0);
  await GS.runGoalSweep(async (items, _l, fn) => { for (const i of items) await fn(i); }, { rows: async () => [member], mark: async () => {}, surface: async (_r, ctx) => { surfaced.push(ctx); }, plan: async () => ({ searchText: p.searchText }) });
  check("...and searches the plan's edges when there are some, never the goals", surfaced.length === 1 && surfaced[0] === p.searchText && !rawIn(surfaced[0], ROYCE));
}

// ---- 2. a dated goal stops generating searches once its window passes
{
  const answer = () => JSON.stringify([{ n: 1, kind: "work", edges: ["AI and founder gatherings in SF in November"], until: "2026-11-30", superseded_by: null, why: "" }]);
  const h = harness(answer);
  const oct = await plan(h, [ROYCE[0]], OCT8);
  check("inside its window it searches its edge", !!oct.searchText && oct.setAside.length === 0);
  const dec = await plan(h, [ROYCE[0]], new Date("2026-12-02T18:00:00Z"));
  check("after the window: stale, no search", dec.searchText === null && dec.setAside[0]?.state === "stale" && /window passed \(2026-11-30\)/.test(dec.setAside[0].reason), dec);
  check("...recorded as a context set-aside (to be told), not deleted", h.set.some((x) => x.state === "stale" && x.source === "context" && x.goal === ROYCE[0]));
  const prompts = h.prompts.length;
  const later = await plan(h, [ROYCE[0]], new Date("2026-12-03T18:00:00Z"));
  check("a stale goal isn't read again: no model call, no search", h.prompts.length === prompts && later.searchText === null);
  check("a date the model makes up is ignored (only real YYYY-MM-DD)", G.parseEdges(["x"], JSON.stringify([{ n: 1, kind: "work", edges: [], until: "end of November" }]))[0].until === null);
}

// ---- 3. a superseded goal is stale and its searches end
{
  const goals = ["launch Co's first in-person event on Oct 10", "partnering with Sequin AI for a November launch party"];
  const corrections = [{ field: "goals", old_value: "launch Co's first in-person event (Oct 10th)", new_value: "partnering with Sequin AI for a November launch party", corrected_at: "2026-10-06T17:00:00Z" }];
  const answer = () => JSON.stringify([
    { n: 1, kind: "work", edges: ["SF venues for a 120-person launch night"], until: null, superseded_by: null, why: "" },
    { n: 2, kind: "work", edges: ["AI and founder gatherings in SF in November"], until: null, superseded_by: null, why: "" },
  ]);
  const h = harness(answer, { corrections });
  const p = await plan(h, goals);
  check("their correction supersedes the old goal: stale, with what they said since", p.setAside.some((x) => x.goal === goals[0] && x.state === "stale" && /they said since/.test(x.reason)), p.setAside);
  check("...its searches end; the newer goal's go on", !!p.searchText && !/120-person/.test(p.searchText) && /November/.test(p.searchText));
  const byNewer = G.parseEdges(["host an October launch at our own venue", "move the launch to November with Sequin AI"], JSON.stringify([{ n: 1, kind: "work", edges: [], superseded_by: 2 }, { n: 2, kind: "work", edges: [], superseded_by: 1 }]));
  check("a newer goal in the list can supersede an older one; never the other way round", byNewer[0].supersededBy === "move the launch to November with Sequin AI" && byNewer[1].supersededBy === null);
  const life = G.lifecycle({ goal: "x", kind: "work", edges: ["y"], why: "", until: null, supersededBy: "z" }, { today: "2026-10-08", corrections: [], prior: null, retired: () => null });
  check("superseded by a newer goal: stale, with the newer one named", life.state === "stale" && /replaced by a newer goal: "z"/.test(life.reason));
}

// ---- 4. a mixed list: only the findable side of active goals; done goals aren't read
{
  const goals = ["find a running club in the Marina", ROYCE[0], ROYCE[1], "raise a pre-seed round"];
  const states = new Map([[G.goalHash("raise a pre-seed round"), { goalHash: G.goalHash("raise a pre-seed round"), goal: "raise a pre-seed round", state: "done", reason: "they closed it", source: "member", changedAt: new Date(), toldAt: new Date(), hints: 0 }]]);
  const h = harness(() => JSON.stringify([
    { n: 1, kind: "findable", edges: ["Marina running clubs with weekday morning runs"], until: null, superseded_by: null, why: "" },
    { n: 2, kind: "work", edges: ["AI and founder gatherings in SF in November"], until: "2026-11-30", superseded_by: null, why: "" },
    { n: 3, kind: "co_task", edges: [], until: null, superseded_by: null, why: "Co's own drafting" },
  ]), { states });
  const p = await plan(h, goals);
  check("the done goal isn't sent to the model at all", h.prompts.length === 1 && !/raise a pre-seed round/.test(h.prompts[0]));
  check("the search has the active goals' edges only", !!p.searchText && /Marina running clubs/.test(p.searchText) && /November/.test(p.searchText) && !rawIn(p.searchText, goals));
  check("the Co task with no edge is passed, the done goal neither searched nor passed", p.passed.length === 1 && p.passed[0].goal === ROYCE[1] && p.active.length === 2);
}

// ---- 5. find requests saved from a work or Co-task goal stop being searched
{
  const asks = [
    { id: 1, text: "Offering to partner with Sequin AI for a November launch party" },
    { id: 2, text: "have Co draft planning docs for branding and launch strategy with Sequin AI" },
    { id: 3, text: "plan will be delivered once ready" },
    { id: 4, text: "find a dinner series for founders in Hayes Valley" },
  ];
  const h = harness(() => JSON.stringify([
    { n: 1, kind: "work", edges: ["AI and founder gatherings in SF in November"], until: null, superseded_by: null, why: "" },
    { n: 2, kind: "co_task", edges: [], until: null, superseded_by: null, why: "Co's own drafting" },
    { n: 3, kind: "co_task", edges: [], until: null, superseded_by: null, why: "" },
  ]), { asks });
  const p = await plan(h, ROYCE);
  check("goal-derived find requests (work, Co tasks, Co's promises) are marked retire-due (they retire through the ask-once flow, services/askRetire.ts)", h.helped.sort().join() === "1,2,3" && p.retiredAsks === 3, h.helped);
  check("a real find request stays a find request", !h.helped.includes(4));
  check("help asks are never searched by the ask sweep (find and person only, and person asks go to intros, never the search)", /if \(row\.kind === "person"\) \{[\s\S]{0,400}attemptNetworkSurfacing[\s\S]{0,200}continue;\s*\}\s*try \{\s*await attemptEventSurfacing/.test(src("jobs/index.ts")) && /WHERE ac\.resolved_at IS NULL AND ac\.kind IN \('find', 'person'\)\s+AND u\.archived_at IS NULL/.test(src("jobs/index.ts")));
}

// ---- 6. no cache; told, never silent; done at their word or Co's
{
  let calls = 0;
  const h = harness(() => { calls++; return JSON.stringify([{ n: 1, kind: "work", edges: ["AI and founder gatherings in SF in November"], until: null, superseded_by: null, why: "" }]); });
  await plan(h, [ROYCE[0]]);
  await plan(h, [ROYCE[0]]);
  check("every run derives from scratch (two runs, two model calls; nothing cached)", calls === 2 && !/goal_find_edges|cached/.test(src("services/goalEdges.ts").replace(/never cached|nothing cached/g, "")));
  check("a context set-aside waits to be told (told_at NULL); one made in conversation is already said", /CASE WHEN \$6 = 'context' AND \$4 <> 'active' THEN NULL ELSE NOW\(\) END/.test(src("services/goalEdges.ts")));
  check("the next reply is handed the untold set-aside as a hint to raise naturally, never a list", /Co stopped looking for things for their goal/.test(src("harness/replyGrounding.ts")) && /goalSetAsides = await import\("\.\/goalEdges\.js"\)/.test(src("services/turnContext.ts")));
  check("told once a sent reply raises it; else one more hint", G.raisedGoal("Still want things for the Sequin AI November launch party?", ROYCE[0]) && !G.raisedGoal("Good morning, how was the run?", ROYCE[0]) && /noteGoalHints\(input\.userId, \[aside\]/.test(src("agent/conversationReply.ts")));
  check("done at their word: closing a goal marks it done (it stays on file)", /setGoalState\(userId, String\(goal\.text\), "done"/.test(src("services/goalJourney.ts")));
  check("Co can mark a goal done, stale or active again (markGoal, registry entry), only a goal on file", /markGoal: tool\(/.test(src("agent/loopTools.ts")) && /That isn't one of their goals on file/.test(src("agent/loopTools.ts")) && /tool: "markGoal"/.test(src("services/capabilities.ts")));
}

// ---- 7. the review of #107
{
  // A model timeout never switches off a real find request.
  const asks = [{ id: 7, text: "find a running club in the Marina" }];
  const down = harness(() => { throw new Error("timeout"); }, { asks });
  await plan(down, ["find a running club in the Marina"]);
  check("a model timeout retires no find request (only an answer that was read, or Co's own task)", down.helped.length === 0, down.helped);
  const coDown = harness(() => { throw new Error("timeout"); }, { asks: [{ id: 8, text: "have Co draft planning docs for branding and launch strategy with Sequin AI" }] });
  await plan(coDown, [ROYCE[1]]);
  check("...Co's own task is still caught in code without the model", coDown.helped.join() === "8");
  // Marking a goal active again sticks: older corrections, a window that had passed, a newer goal don't re-stale it.
  const goal = "raise a pre-seed round in December";
  const corrections = [{ field: "goals", old_value: "raise a pre-seed round in December", new_value: "raising in January instead", corrected_at: "2026-10-01T17:00:00Z" }];
  const reaffirmed = new Map([[G.goalHash(goal), { goalHash: G.goalHash(goal), goal, state: "active", reason: "they still want it", source: "member", changedAt: new Date("2026-10-05T17:00:00Z"), toldAt: new Date(), hints: 0 }]]);
  const back = harness(() => JSON.stringify([{ n: 1, kind: "findable", edges: ["pre-seed founder programs SF"], until: null, superseded_by: null }]), { states: reaffirmed as any, corrections });
  const bp = await plan(back, [goal]);
  check("marked active again after a correction: the older correction doesn't re-stale it", bp.setAside.length === 0 && !!bp.searchText, bp.setAside);
  const fresh = harness(() => JSON.stringify([{ n: 1, kind: "findable", edges: ["pre-seed founder programs SF"], until: null, superseded_by: null }]), { corrections });
  const fp = await plan(fresh, [goal]);
  check("...while without that, the same correction does make it stale", fp.setAside.length === 1);
  // A wrong model date doesn't stale a goal that names no date; the direction never supersedes a goal.
  const slip = G.parseEdges(["find a climbing gym community"], JSON.stringify([{ n: 1, kind: "findable", edges: ["SF climbing gym community"], until: "2025-11-30" }]), null, { today: "2026-10-08" });
  check("a past date on a goal that names no date is a model slip: ignored", slip[0].until === null);
  const dated = G.parseEdges(["the November launch party"], JSON.stringify([{ n: 1, kind: "work", edges: [], until: "2025-11-30" }]), null, { today: "2026-10-08" });
  check("...a goal that names its month keeps its date", dated[0].until === "2025-11-30");
  const dir = G.parseEdges(["find founder dinners", "build a life in SF"], JSON.stringify([{ n: 1, kind: "findable", edges: ["SF founder dinners"], superseded_by: 2 }, { n: 2, kind: "work", edges: [] }]), null, { direction: 1 });
  check("their long-term direction never supersedes a goal", dir[0].supersededBy === null);
  // A goal with no meaning words never matches everything.
  check("an empty word set never 'restates' (it used to match any goal or ask)", !G.restates("find a running club", "AI") && !G.restates("AI", "find a running club"));
  // Told: a question that names the goal, not two shared words; no cap that silences it for good.
  check("told only when the reply asks about it by name", G.raisedGoal("Still want things for the pre-seed round in December?", "raise a pre-seed round in December") && !G.raisedGoal("Found a running club near you.", "find a running club in the Marina"));
  check("a set-aside is never dropped by a hint cap", G.TELL_MAX_HINTS === Infinity && !/AND hints < \$2/.test(src("services/goalEdges.ts")));
  check("markGoal reaches their direction, and refuses an ambiguous match", /long_term_direction FROM co_profiles/.test(src("agent/loopTools.ts")) && /That could be more than one of their goals/.test(src("agent/loopTools.ts")));
}

console.log(`goals lifecycle: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
