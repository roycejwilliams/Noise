// The goal read and what drives sweeps (Royce, 2026-10-09). Zero tokens: the model, the store and the clock are stubbed.
//   1. the goal read has room for 17+ goals (2026-10-09: Royce's 17 ran past 900 tokens and every goal read as unreadable)
//   2. a cut-off answer keeps every complete goal instead of dropping the whole list
//   3. a cut-off or failed read logs as a failure (a skip), never as "searching"
//   4. asks win contested send slots; goal finds fill what's left
//   5. ask finds read as "Co did what you said", goal finds as "Co noticed this for you" (never "you asked")
//   6. goals starved while asks take every slot are logged for review
//   npx tsx evals/goals/readCutOff.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const G = await import("../../src/services/goalEdges.js");
const SS = await import("../../src/services/sweepSelect.js");
const SH = await import("../../src/services/sweepShadow.js");
const ED = await import("../../src/agent/eventDiscoverySurfacing.js");
const DR = await import("../../src/harness/devReview.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// Royce's goals on file, 2026-10-09: 17, plus his direction; 4 already set aside as stale, so the read covers 14 live ones.
const ROYCE_LIVE = [
  "wait for Jacqueline to be settled so they can move together on Sequin AI partnership",
  "pivoting to a partnership with Sequin AI after canceling the October launch date",
  "partnering with Sequin AI for a November launch party",
  "have Cue draft planning docs for branding and launch strategy with Sequin AI",
  "maintain Cue's presence after the November event",
  "secure pre-seed investment funding from investors who understand consumer social products",
  "get into an accelerator or residency (e.g. South Park Commons)",
  "apply to South Park Commons or Blueprint II",
  "Plan out the event and take lead",
  "Seeking genuine friendships with dependable, intelligent people who want to work and build together",
  "seeking to use Cue to funnel and drive Jeremy Toce's guest list to test product matching",
  "Help lead the partnership strategy with Sequin AI and generate alignment notes on potential connections between Cue and their company",
  "Seeking guidance on whether the platform/city-adoption problem and the cultural/personal-invite problem with Sequin AI are solvable",
  "They want Cue to maintain a presence within the Sequin AI partnership beyond the November launch event.",
];
const EDGES: Record<number, string[]> = {
  6: ["SF pre-seed investor office hours", "consumer social founder investor dinners SF"],
  7: ["SF founder residency open applications", "SF founder residency programs"],
  8: ["Blueprint accelerator application deadline"],
  10: ["SF builder dinners small group"],
};
// A full answer in the shape the model gives (about 170 characters a goal: 14 goals is ~2,400, which 900 tokens cut off at goal 11 or 12).
const full = JSON.stringify(
  ROYCE_LIVE.map((g, i) => ({ n: i + 1, kind: EDGES[i + 1] ? "findable" : "work", edges: EDGES[i + 1] ?? [], until: null, superseded_by: null, why: EDGES[i + 1] ? "has a findable side" : "their own work plan; nothing to look for" })),
  null,
  2,
);
// What 900 tokens returned on 10-09: cut off partway through goal 12.
const cutAt = full.indexOf('"n": 12') + 40;
const cut = full.slice(0, cutAt);

// 1. Room for the answer.
{
  check("the goal read asks for room for 25 goals (4000 tokens)", G.EDGE_LIMITS.maxTokens >= 4000 && /max_tokens: EDGE_LIMITS\.maxTokens/.test(src("services/goalEdges.ts")), G.EDGE_LIMITS);
  check("the timeout grows with the answer (30s, the sweep runs in the background)", G.EDGE_LIMITS.timeoutMs >= 30000);
  check("Royce's 14 live goals in this shape are over 2,000 characters (why 900 tokens cut it off)", full.length > 2000, full.length);
}

// 2. A cut-off answer keeps what it can.
{
  const whole = G.readEdgeAnswer(full);
  check("a whole answer reads as full, every goal", whole.read === "full" && whole.arr.length === 14, { read: whole.read, n: whole.arr.length });
  const part = G.readEdgeAnswer(cut);
  check("a cut-off answer reads as cut_off, keeping the 11 complete goals", part.read === "cut_off" && part.arr.length === 11, { read: part.read, n: part.arr.length });
  check("nothing usable reads as failed", G.readEdgeAnswer("").read === "failed" && G.readEdgeAnswer("[{\"n\": 1, \"kind\": \"wo").read === "failed" && G.readEdgeAnswer("I can't help").read === "failed");
  check("a brace inside a string doesn't break the salvage", G.readEdgeAnswer('[{"n": 1, "why": "a {curly} and a \\"quote\\""}, {"n": 2, "why": "ok"}, {"n": 3').arr.length === 2);
  const parsed = G.parseEdges(ROYCE_LIVE, cut);
  check("the goals read from a cut-off answer keep their edges (pre-seed, residency, accelerator)", parsed[5].edges.length === 2 && parsed[6].edges.length === 2 && parsed[7].edges.length === 1, parsed.slice(5, 8).map((e) => e.edges));
  check("only the goals the answer never reached read as unreadable (a Cue task is known in code)", parsed.slice(11).every((e) => e.kind === "co_task" || e.why === "couldn't be read this time") && parsed.slice(0, 11).every((e) => e.why !== "couldn't be read this time"), parsed.map((e) => [e.kind, e.why]));
  check("an unread goal is never treated as explicitly not findable (its find requests stay)", parsed.slice(11).filter((e) => e.kind !== "co_task").every((e) => !e.explicit), parsed.slice(11).map((e) => [e.kind, e.explicit]));
}

// 3. The plan logs the real read outcome.
{
  const run = async (model: (p: string) => Promise<string>, enjoys: string[] | null = null) => {
    const logs: any[] = [];
    const plan = await G.planGoalSweep("u1", ROYCE_LIVE, { city: "San Francisco", zone: "America/Los_Angeles", now: new Date("2026-10-09T12:30:00Z"), enjoys }, {
      model,
      states: async () => new Map(),
      setState: async () => {},
      corrections: async () => [],
      retired: () => null,
      findAsks: async () => [],
      helpAsk: async () => {},
      log: async (d) => void logs.push(d),
    });
    return { plan, log: logs[0] };
  };
  const ok = await run(async () => full);
  check("a whole read searches the goal edges and logs searching_edges", ok.log.action === "searching_edges" && !ok.log.failed && /pre-seed investor office hours/.test(ok.plan.searchText ?? "") && /founder residency open applications/.test(ok.plan.searchText ?? ""), ok.log);
  check("a whole read logs every goal read", ok.log.proposal.read === "full" && ok.log.proposal.goalsRead === 14 && ok.log.proposal.goalsLive === 14, ok.log.proposal);
  const part = await run(async () => cut);
  check("a cut-off read still searches the goals it read", /pre-seed investor office hours/.test(part.plan.searchText ?? ""), part.plan.searchText);
  check("a cut-off read logs as a failure, never as searching", part.log.action === "read_cut_off" && part.log.failed === true && /11 of 14 goals read/.test(part.log.reason ?? ""), part.log);
  const skipped = JSON.stringify(JSON.parse(full).filter((x: any) => x.n !== 3 && x.n !== 9));
  const gap = await run(async () => skipped);
  check("a closed list that leaves goals out logs as cut off, not searching (review of #128)", gap.log.action === "read_cut_off" && /12 of 14 goals read/.test(gap.log.reason ?? ""), gap.log);
  const none = await run(async () => { throw new Error("timeout"); }, ["networking with VCs and founders"]);
  check("a failed read logs as read_failed even when what they enjoy still gives a search (no silent success)", none.log.action === "read_failed" && none.log.failed === true && !!none.plan.searchText, none.log);
  check("the real log writes a failed read as a skip", /outcome: d\.action === "passed" \|\| d\.failed \? "skip" : "act"/.test(src("services/goalEdges.ts")));
  const flags = DR.logFlags({ userId: "u1", firstName: "R", messages: [], emotions: [], issues: [], asks: [], decisions: [{ id: 1, at: "2026-10-09T12:30:00Z", decision: "goal_sweep.plan", outcome: "skip", action: "read_cut_off", reason: "the answer was cut off: 11 of 14 goals read", proposal: { goalsRead: 11, goalsLive: 14, searching: true }, checks: null }] } as any);
  check("the morning review flags a cut-off goal read", flags.some((f) => f.type === "goal_read_failed" && /11 of 14/.test(f.snippet)), flags);
}

// 4. Asks win contested slots.
{
  const pool = [
    { id: "C1", key: "k1", name: "Goal find one", date: null, tier: 2, kind: "discovery" as const, asks: [] },
    { id: "C2", key: "k2", name: "Goal find two", date: null, tier: 2, kind: "discovery" as const, asks: [] },
    { id: "C3", key: "k3", name: "Ask find one", date: null, tier: 2, kind: "answer" as const, asks: ["A1"] },
    { id: "C4", key: "k4", name: "Ask find two", date: null, tier: 2, kind: "answer" as const, asks: ["A1"] },
  ];
  const c = { firstName: "R", city: "SF", today: "2026-10-09", weekday: "Friday", asks: [{ id: "A1", text: "weekend things", since: "2026-10-08" }], texts: [], sent: [], outcomes: [], feeling: null, discoveryLeft: 4, pool } as any;
  const send = (id: string) => ({ id, verdict: "send" as const, whyMember: "fits", cites: ["A1"], whyNow: "this weekend", wow: true, lastDay: null });
  const j = SS.guardVerdicts(c, [send("C1"), send("C2"), send("C3"), send("C4")]);
  const verdict = (id: string) => j.find((x) => x.id === id)?.verdict;
  check("with 4 sends for 3 slots, both asks go and the first goal find fills the last slot", verdict("C3") === "send" && verdict("C4") === "send" && verdict("C1") === "send" && verdict("C2") === "hold", j.map((x) => [x.id, x.verdict]));
  check("the goal find that lost its slot says why", /what they asked for went first/.test(j.find((x) => x.id === "C2")?.guard ?? ""), j.find((x) => x.id === "C2"));
  const goalsOnly = SS.guardVerdicts(c, [send("C1"), send("C2")]);
  check("with no ask competing, goal finds take the slots (neither starves the other)", goalsOnly.every((x) => x.id === "C3" || x.id === "C4" || x.verdict === "send"), goalsOnly.map((x) => [x.id, x.verdict]));
  check("the picker is told asks go first when both clear the bar", /what they asked for goes first; what you noticed for them fills what's left/.test(SS.SELECT_SYSTEM));
  check("slotOrder: answers first, each kind in the model's order", JSON.stringify(SS.slotOrder([{ at: 0, kind: "discovery" }, { at: 1, kind: "answer" }, { at: 2, kind: "discovery" }, { at: 3, kind: "answer" }])) === "[1,3,0,2]");
}

// 5. Framing.
{
  check("an ask find is Cue doing what they said", /They asked you for this: "weekend plans"\. This is you doing what they asked/.test(ED.describeAsk("weekend plans", false)));
  check("a goal find is something Cue noticed for them, never their request", /didn't ask for this\. You noticed it for them/.test(ED.describeAsk("look for: SF founder dinners", true)) && /never say or imply they asked/.test(ED.describeAsk("x", true)));
  const asked = ["Found the founder dinner you asked about", "Like you asked, here's one for Saturday", "You were looking for something like this", "Per your request: SPC opens Monday", "You've been looking for a builder community", "You're looking for investors, so this fits"];
  const fine = ["Noticed SPC's residency opens Monday", "This one has your name on it: a founder dinner Saturday", "You'd like this one", "Saw this and it fits where you're headed", "You mentioned wanting to raise pre-seed by spring, so Hustle Fund's office hours on Oct 21 fit", "Since you were hoping to launch in November, the SF Builders demo night is worth a look"];
  check("a goal find saying they asked is caught", asked.every((t) => ED.CLAIMS_THEY_ASKED.pattern.test(t)), asked.filter((t) => !ED.CLAIMS_THEY_ASKED.pattern.test(t)));
  check("a goal find said as noticed passes", fine.every((t) => !ED.CLAIMS_THEY_ASKED.pattern.test(t)), fine.filter((t) => ED.CLAIMS_THEY_ASKED.pattern.test(t)));
  check("the backstop applies to goal finds only", /forbidden: \[OFFER_FORBIDDEN, IMPLIES_IDENTITY, \.\.\.\(fromProfile \? \[CLAIMS_THEY_ASKED\] : \[\]\)\]/.test(src("agent/eventDiscoverySurfacing.ts")));
}

// 6. Starvation is logged, never forced.
{
  const now = new Date("2026-10-09T17:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  check("goals with no find in 7+ days while asks got sends: starved", SH.goalsStarved({ now, activeGoals: 14, askSends: 5, lastGoalSend: daysAgo(8), goalsSince: daysAgo(30) }).starved);
  check("a goal find 2 days ago: not starved", !SH.goalsStarved({ now, activeGoals: 14, askSends: 5, lastGoalSend: daysAgo(2), goalsSince: daysAgo(30) }).starved);
  check("no ask sends in the window: a quiet week, not starvation by asks", !SH.goalsStarved({ now, activeGoals: 14, askSends: 0, lastGoalSend: daysAgo(10), goalsSince: daysAgo(30) }).starved);
  check("no active goals: nothing to starve", !SH.goalsStarved({ now, activeGoals: 0, askSends: 5, lastGoalSend: null, goalsSince: daysAgo(30) }).starved);
  check("never a goal find, goals swept for 7+ days: starved", SH.goalsStarved({ now, activeGoals: 3, askSends: 2, lastGoalSend: null, goalsSince: daysAgo(9) }).starved);
  check("never a goal find, but goals only swept 3 days: too early", !SH.goalsStarved({ now, activeGoals: 3, askSends: 2, lastGoalSend: null, goalsSince: daysAgo(3) }).starved);
  check("starvation is a review flag, once a day, holding nothing", /decision: "sweep\.goals_starved", userId, outcome: "skip", action: "flag"/.test(src("services/sweepShadow.ts")) && /proposal->>'day' = \$2 LIMIT 1/.test(src("services/sweepShadow.ts")));
  const flags = DR.logFlags({ userId: "u1", firstName: "R", messages: [], emotions: [], issues: [], asks: [], decisions: [{ id: 2, at: "2026-10-09T17:00:00Z", decision: "sweep.goals_starved", outcome: "skip", action: "flag", reason: "no goal find sent in 8 days while 5 ask find(s) went out", proposal: { days: 8, askSends: 5, activeGoals: 14 }, checks: null }] } as any);
  check("the morning review flags starved goals", flags.some((f) => f.type === "goals_starved"), flags);
}

console.log(`goal read + sweep priority: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
