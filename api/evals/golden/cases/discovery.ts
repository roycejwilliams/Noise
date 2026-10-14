// Discovery cases (plan: "Discovery as its own subsystem"). Discovery runs on lookouts, goals and interests; a one-off task (research,
// a doc, advice) is never a discovery input. Live cases drive the real decision code with injected deps: no database, no sends.
import "../../lib/requireMeter.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../../../src/models.js";
import { parseModelJson } from "../../../src/services/modelJson.js";
import { closeAnsweredAsks, defaultDeps, intentPrompt, type AskDeps, type AskIntent, type AskRow, type Closure, type Msg } from "../../../src/services/askLifecycle.js";
import { classifyAsk } from "../../../src/services/askKind.js";
import { goalHash, lifecycle, type GoalEdge } from "../../../src/services/goalEdges.js";
import type { MemberKnowledge } from "../../../src/services/memberKnowledge.js";
import { selectForMember, type SelectContext } from "../../../src/services/sweepSelect.js";
import { factsFromKnowledge } from "../../../src/services/sweepSelectContext.js";
import { result, type GoldenCase } from "../types.js";

// The model step of askLifecycle.readIntents on fixture words (2026-10-13: readIntents isn't exported and reads their words from the
// database; same prompt, model and parse).
async function readIntentsOn(asks: { id: string; ask: string; words: string[] }[]): Promise<{ intents: Map<string, AskIntent | null>; why: Map<string, string> }> {
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 800, prompt: intentPrompt(asks.map((a, i) => ({ n: `A${i + 1}`, ask: a.ask, words: a.words }))) });
  const raw = parseModelJson<{ asks?: { ask?: unknown; intent?: unknown; why?: unknown }[] }>(text).asks ?? [];
  const intents = new Map<string, AskIntent | null>();
  const why = new Map<string, string>();
  asks.forEach((a, i) => {
    const r = raw.find((y) => String(y.ask) === `A${i + 1}`);
    intents.set(a.id, r?.intent === "question" || r?.intent === "lookout" ? (r.intent as AskIntent) : null);
    why.set(a.id, typeof r?.why === "string" ? r.why : "");
  });
  return { intents, why };
}

const pending = (until: string, why: string, assertion: string, n: number, id: string, title: string, from: string): GoldenCase => ({
  n,
  id,
  title,
  status: { live: false, until, why },
  from,
  run: async () => result([`not built yet: ${assertion}`], ""),
});

// ---------------------------------------------------------------- 7
// A question and a lookout open together; Co's reply answers the question and also mentions a find for the lookout. Co's summary of
// the lookout has no "keep an eye out" in it (the summary loses it), so only the intent read keeps it open.
const closingAQuestion: GoldenCase = {
  n: 7,
  id: "closing-a-question",
  title: "Answering a question closes it; an open lookout stays open",
  status: { live: true },
  from: "Royce 2026-10-13: questions close when answered, lookouts stay open until their date, stop, or fulfilled (askLifecycle header)",
  run: async () => {
    const at = (iso: string) => new Date(iso);
    const q: AskRow = { id: "row-q", user_id: "u-jordan", ask_id: "ask-q", ask_text: "Quiet dinner spot near Jackson Square for Thursday with Ellis", kind: "help", created_at: at("2026-10-13T17:00:00Z"), last_mentioned_at: null, resolved_at: null, expired_at: null, closed_reason: null, awaiting_response_since: null };
    const l: AskRow = { id: "row-l", user_id: "u-jordan", ask_id: "ask-l", ask_text: "Rooftop jazz nights in SF this fall", kind: "find", created_at: at("2026-10-12T02:00:00Z"), last_mentioned_at: null, resolved_at: null, expired_at: null, closed_reason: null, awaiting_response_since: null };
    const words: Record<string, string[]> = {
      "row-q": ["Where should I take Ellis for a quiet dinner near Jackson Square Thursday? Somewhere we can actually talk."],
      "row-l": ["Keep an eye out for rooftop jazz nights in SF this fall and tell me when one comes up, I'd go to a few."],
    };
    const convo: Msg[] = [
      { at: at("2026-10-12T02:00:00Z"), side: "member", text: words["row-l"][0] },
      { at: at("2026-10-12T02:01:00Z"), side: "co", text: "Will do. I'll watch for rooftop sets and send the good ones." },
      { at: at("2026-10-13T17:00:00Z"), side: "member", text: words["row-q"][0] },
      { at: at("2026-10-13T17:01:00Z"), side: "co", text: "Bix on Gold Street. Supper-club room, low light, booths along the wall so you and Ellis can hear each other. Book the 7:30 Thursday and ask for a booth upstairs. Separately, for your jazz watch: there's a rooftop set at the Charmaine's on Friday the 17th." },
      { at: at("2026-10-13T17:05:00Z"), side: "member", text: "Perfect, booking Bix now." },
    ];
    const closed: { askId: string; how: string; evidence: string }[] = [];
    let read: Awaited<ReturnType<typeof readIntentsOn>> | null = null;
    const deps: AskDeps = {
      openAsks: async () => [q, l].filter((a) => !closed.some((c) => c.askId === a.ask_id)),
      conversation: async (_u, since) => convo.filter((m) => +new Date(m.at) >= +since),
      // A find already went out for the lookout: delivered never closes a lookout.
      delivered: async (_u, a) => (a.id === "row-l" ? 'Sent them "Rooftop jazz at Charmaine\'s" for this ask' : null),
      judge: defaultDeps().judge, // the real Sonnet judge
      close: async (_u, askId, how, evidence) => { closed.push({ askId, how, evidence }); },
      markChecked: async () => {},
      zone: async () => "America/Los_Angeles",
      intent: async (_u, asks) => {
        read = await readIntentsOn(asks.map((a) => ({ id: a.id, ask: a.ask_text, words: words[a.id] ?? [] })));
        return read.intents;
      },
    };
    const closures: Closure[] = await closeAnsweredAsks("u-jordan", deps);
    const misses: string[] = [];
    const qc = closed.find((c) => c.askId === "ask-q");
    if (!qc) misses.push("the answered question was not closed");
    else if (qc.how !== "answered") misses.push(`the question closed as ${qc.how}, not answered`);
    const lc = closed.find((c) => c.askId === "ask-l");
    if (lc) misses.push(`the open lookout was closed (${lc.how}: "${lc.evidence.slice(0, 80)}")`);
    const r = read as Awaited<ReturnType<typeof readIntentsOn>> | null;
    const intents = r ? `intents q=${r.intents.get("row-q")} ("${r.why.get("row-q")}"), l=${r.intents.get("row-l")} ("${r.why.get("row-l")}")` : "intents not read";
    return result(misses, `${intents}; closures: ${closures.map((c) => `${c.askId} ${c.how} "${c.evidence.slice(0, 80)}"`).join(" | ") || "(none)"}`);
  },
};

// ---------------------------------------------------------------- 8
// A replaced goal (goalEdges supersededBy) is not an abandoned one: a find under it is judged on fit. lifecycle() makes the goal's
// state, factsFromKnowledge() builds the picker's facts from it, and the real picker model judges the pool.
// Run 2 (2026-10-13) rejected it as "a program they've already ruled out": that wording counts too.
const ABANDONED = /\b(set aside|abandon\w*|dropped|no longer|gave up|given up|moved (on|away) from|old goal|previous goal|former goal|past goal|retired|deprioriti\w+|ruled (it |them |this )?out|not pursuing|walked away|stepped away|replaced|instead of)\b/i;
const replacedGoal: GoldenCase = {
  n: 8,
  id: "replaced-goal",
  title: "A find under a replaced goal is judged on fit, never rejected as abandoned",
  status: { live: true },
  from: "2026-10-13 picker rejected a founder fellowship as matching 'the accelerator goal he set aside' when it was only replaced; fixed in #188",
  run: async () => {
    const today = "2026-10-13";
    const asOf = "2026-10-13T16:00:00Z";
    const older = "Get into a startup accelerator for my fintech company";
    const newer = "Apply to South Park Commons this winter";
    const oldEdge: GoalEdge = { goal: older, kind: "findable", edges: ["accelerator programs", "founder programs"], why: "", until: null, supersededBy: newer };
    const newEdge: GoalEdge = { goal: newer, kind: "findable", edges: ["founder communities", "founder fellowships"], why: "", until: null, supersededBy: null };
    const opts = { today, corrections: [], prior: null, retired: () => null };
    const oldState = lifecycle(oldEdge, opts);
    const newState = lifecycle(newEdge, opts);
    const goal = (text: string, s: { state: any; reason: string }) => ({ text, state: s.state, reason: s.reason || null, told: true, onFile: true, hash: goalHash(text), verifiedAt: asOf });
    const k: MemberKnowledge = {
      userId: "u-jordan",
      asOf,
      identity: { firstName: "Jordan", city: "San Francisco", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: asOf },
      goals: [goal(newer, newState), goal(older, oldState)],
      asks: [],
      delivered: [],
      carrying: [],
      lessons: [],
      corrections: [],
      preferences: [],
      claims: [],
      restraint: null,
      exchanges: [
        { from: "member", text: "Thinking South Park Commons is the move this winter. Want to be around other founders while I figure out the product.", call: false, verifiedAt: "2026-10-10T18:00:00Z" },
        { from: "co", text: "That fits where you are. Their application usually opens in the fall; I'll keep it in view.", call: false, verifiedAt: "2026-10-10T18:01:00Z" },
        { from: "member", text: "Still pre-incorporation. Noor and I are sorting out the cofounder split first.", call: false, verifiedAt: "2026-10-11T20:00:00Z" },
      ],
      person: null,
      limits: null,
    };
    const facts = factsFromKnowledge(k);
    const c: SelectContext = {
      ...facts,
      today,
      weekday: "Tuesday",
      asks: [],
      sent: [],
      outcomes: [],
      discoveryLeft: 4,
      pool: [{ id: "C1", key: "founder-fellowship-8wk", name: "Founder Fellowship: 8-week program for early founders", date: null, tier: 3, kind: "discovery", asks: [], details: "8 weeks in SF for founders before or around incorporation; $75K+ investment on incorporation; applications open now, close Oct 31" }],
    };
    const misses: string[] = [];
    if (oldState.state !== "stale" || !/^replaced by a newer goal/.test(oldState.reason)) misses.push(`fixture: the older goal didn't read as replaced (${oldState.state}: ${oldState.reason})`);
    if ((facts.goalsPast ?? []).some((g) => g.text.startsWith(older))) misses.push(`the replaced goal reached the picker as history: ${facts.goalsPast!.map((g) => g.text).join("; ")}`);
    const r = await selectForMember(c, { userId: "u-jordan" });
    if (r.error) misses.push(`picker error: ${r.error}`);
    const j = r.judgments.find((x) => x.id === "C1");
    if (!j || j.verdict === "no_verdict") misses.push("no verdict for the fellowship");
    else if (j.verdict === "reject" && ABANDONED.test(`${j.why} ${j.guard ?? ""}`)) misses.push(`rejected citing an abandoned/set-aside goal: "${j.why.slice(0, 160)}"`);
    return result(misses, `goals=${JSON.stringify(facts.goals)} goalsPast=${JSON.stringify(facts.goalsPast)}; C1 ${j?.verdict ?? "?"}/${j?.reason ?? "?"}: ${(j?.why ?? "").slice(0, 200)}${j?.guard ? ` [guard: ${j.guard}]` : ""}`);
  },
};

// ---------------------------------------------------------------- 15
// A one-off research request is a task, never a discovery input (2026-10-13: a research request about a person became a daily search).
const RESEARCH = "Can you do some research on Sarah Hao before our call?";
const oneOffResearch: GoldenCase = {
  n: 15,
  id: "one-off-research",
  title: "A one-off research request is a task: no lookout, never searched by the 9am run",
  status: { live: false, until: "phase 5 (inputs move: question asks never searched)", why: "today's 9am floor searches every open kind='find' ask whatever its intent" },
  from: "2026-10-13: a one-off research request about a person was searched every morning by the 9am floor",
  run: async () => {
    // What exists today, informational: the intent split (askLifecycle readIntents' model step) and the kind the floor gates on.
    const r = await readIntentsOn([{ id: "a", ask: "Research Sarah Hao before their call", words: [RESEARCH] }]);
    const kind = await classifyAsk(RESEARCH);
    const observed = `intent=${r.intents.get("a")} ("${r.why.get("a")}"); kind=${kind}`;
    return result([
      `not built yet: a task, no lookout, never searched by the 9am run. Today the floor (src/services/dailySweep.ts:247) gates on kind only (kind !== 'find' skips) and never reads intent, so a kind='find' question ask is searched daily; this ask reads intent=${r.intents.get("a")}, kind=${kind}`,
    ], observed);
  },
};

// ---------------------------------------------------------------- 24, 25 (Royce, 2026-10-13: own work follows its task; mixed requests split)
const MIXED_ASK = "Draft the launch plan for the Sequin party and keep an eye out for venues";
const mixedSplit: GoldenCase = {
  n: 24,
  id: "mixed-split",
  title: "A request that is half Co's work, half a lookout is split: the work part a task, the find part a lookout, never binned whole",
  status: { live: true },
  from: "Royce 2026-10-13: \"'Draft the launch plan and keep an eye out for venues' is half task, half lookout - split those\"",
  run: async () => {
    // The real Haiku split read (services/askSplit.ts readSplit), then the creation step with its writes stubbed (splitAsks).
    const AS = await import("../../../src/services/askSplit.js");
    const read = await AS.readSplit(MIXED_ASK, MIXED_ASK);
    const followed: string[] = [];
    const saved = await AS.splitAsks("u-golden", [{ text: MIXED_ASK, type: "seeking" as const }], { transcript: `user: ${MIXED_ASK}`, message: MIXED_ASK }, { kindOf: async () => "ask", read: async () => read, follow: async (_u, sp) => (followed.push(sp.work), { ok: true, taskId: 1, existing: false }), log: async () => {} });
    const misses: string[] = [];
    if (!read.read) misses.push(`the split read failed: ${read.why}`);
    if (read.kind !== "mixed" || !read.split) misses.push(`not read as mixed (kind ${read.kind})`);
    else {
      if (!/draft|launch plan|plan/i.test(read.split.work)) misses.push(`the work part isn't the drafting: "${read.split.work}"`);
      if (!/venue/i.test(read.split.find)) misses.push(`the find part isn't the venues: "${read.split.find}"`);
      if (/draft|plan\b/i.test(read.split.find)) misses.push(`the find part carries the work: "${read.split.find}"`);
      if (!read.split.findIsLookout) misses.push("the find part isn't read as a lookout (their words say keep an eye out)");
    }
    if (followed.length !== 1) misses.push("the work part wasn't followed as a task");
    if (saved.length !== 1 || saved[0].ask.text === MIXED_ASK) misses.push("the whole request was saved as one ask (binned wholesale)");
    // And the floor: the find part is searched, the work part never.
    const D = await import("../../../src/services/dailySweep.js");
    const plan = D.planAsk({ kind: "ask", id: "x", text: MIXED_ASK }, MIXED_ASK, read, { id: 1 }, AS.floorPlan);
    if (!plan.search || !/venue/i.test(plan.search)) misses.push(`the 9am run wouldn't search the venues part (planned: ${plan.search ?? "nothing"})`);
    return result(misses, `read=${read.kind} ${JSON.stringify(read.split)} (${read.why}); saved=${JSON.stringify(saved.map((x) => x.ask.text))}; floor searches: ${plan.search}`);
  },
};
const OWN_WORK_ASK = "Draft the launch plan for the Sequin party";
const FIND_VIA_CO = "Have Co look for venues for the launch party";
const ownWorkNotInSpend: GoldenCase = {
  n: 25,
  id: "own-work-not-in-spend",
  title: "Co's own work with its task is followed, never in the 9am web or X spend; a find worded around Co is still searched",
  status: { live: true },
  from: "Royce 2026-10-13: \"for requests that are Co's own work the 9am run skips web and X searches - they're logged as 'followed as its task'\"; review: \"Nothing silently switches off\"",
  run: async () => {
    // The real sweep planning (services/askSplit.ts askSearchPlan, with the real split read) and the floor's per-ask decision
    // (services/dailySweep.ts planAsk): no network search and no database (the kept read and the open tasks are stubbed).
    const AS = await import("../../../src/services/askSplit.js");
    const D = await import("../../../src/services/dailySweep.js");
    const TASK = { id: 52, goal: "Draft the launch plan for the Sequin party", source: "ask" };
    AS.setPlanDepsForTests({ store: async () => {}, work: async () => [TASK] });
    const misses: string[] = [];
    const items: import("../../../src/services/dailySweep.js").ItemResult[] = [];
    const seen: string[] = [];
    try {
      for (const text of [OWN_WORK_ASK, FIND_VIA_CO]) {
        const b = { kind: "ask" as const, id: text === OWN_WORK_ASK ? "own" : "find", text };
        const sp = await AS.askSearchPlan("u-golden", { id: b.id, ask_text: text, split_read: null });
        const p = D.planAsk(b, text, sp.read, sp.taskId != null ? { id: sp.taskId } : null, AS.floorPlan);
        seen.push(`${b.id}: read=${sp.read?.kind ?? "none"} task=${sp.taskId} search=${p.search ?? "none"}`);
        // What the floor would spend: a searched ask looks in all three places; a followed one in none.
        items.push(p.item ?? { ...b, status: "searched", sources: { events: true, web: true, x: true } });
      }
    } finally {
      AS.setPlanDepsForTests(null);
    }
    const own = items.find((i) => i.id === "own")!;
    const found = items.find((i) => i.id === "find")!;
    if (own.status !== "followed_as_task" || own.taskId !== 52) misses.push(`the own-work request with its task isn't followed (${JSON.stringify(own)})`);
    if (own.sources?.web || own.sources?.x) misses.push("the own-work request is in the web or X spend");
    if (found.status !== "searched") misses.push(`"${FIND_VIA_CO}" isn't searched (${JSON.stringify(found)})`);
    const sum = D.dailySummary(items);
    if (sum.totals.sources.web !== 1 || sum.totals.sources.x !== 1 || sum.totals.followed !== 1) misses.push(`the day's spend is wrong: ${sum.action}`);
    return result(misses, `${seen.join(" | ")}; day: ${sum.action}`);
  },
};

export const CASES: GoldenCase[] = [
  closingAQuestion,
  replacedGoal,
  pending("phase 3 (discoveryStatus idle states)", "discoveryStatus has no idle states yet", "a member with interests only (no goals, no lookouts): the 9am run still runs but searches nothing, and discoveryStatus reads idle with reason \"interests only\" and its next_run_at; asked what Co is looking for, Co says nothing specific is being searched (interests are a lens, never searched alone until Royce approves an interests-only floor)", 9, "interests-only", "Interests alone: idle, never silently off", "plan v2 (10-13): When inputs run out, interests-only row"),
  pending("phase 3 (discoveryStatus idle states)", "discoveryStatus has no idle states yet", "closing a member's last open lookout (with no goals or interests left) puts discoveryStatus in its idle state with that reason, and the next 9am run searches nothing for them", 10, "closing-last-lookout", "Closing the last lookout idles discovery", "plan: discovery status reads idle when nothing is left to search"),
  pending("phase 4 (mapping report / seed)", "the mapping report and seed don't exist yet", "an old open ask whose intent can't be read from the member's words is listed in the mapping report as ambiguous and seeded as neither a lookout nor a task; it is never searched until the member's words say which", 11, "ambiguous-old-ask", "An ambiguous old ask is reported, not guessed", "plan: the mapping report seeds lanes from existing asks"),
  oneOffResearch,
  pending("phase 7 (lookout end-of-life, all members)", "lookout end-of-life isn't built", "on a lookout's last day the 9am run does a final sweep; a find that passes the picker and the send checks goes out as the one closing message in today's send format; the lookout is archived with that message's id; never a second message", 16, "lookout-ends-with-find", "A lookout's last day: the find is the closing message", "plan v2 (10-13): lookout end-of-life, amendment 5"),
  pending("phase 7 (lookout end-of-life, all members)", "lookout end-of-life isn't built", "on a lookout's last day with nothing new: one short line in Co's voice (a last check, nothing new for <their words>), no question, no renewal offer; the lookout is archived; never silent, never sent for a lookout the member closed themselves", 17, "lookout-ends-with-nothing", "A lookout's last day with nothing: one closing line", "plan v2 (10-13): lookout end-of-life, amendment 5"),
  pending("phase 5 (lane transitions)", "lane transitions aren't built", "Co proposes moving an input between lanes (e.g. a goal to a lookout) and the member doesn't confirm: nothing changes (no lane change, no member-visible note); a task becomes a lookout only on the member's own words; a confirmed change leaves exactly one member-visible line (\"moved X from goals to lookouts\")", 20, "lane-change-needs-confirmation", "A lane change needs the member's yes", "Royce 2026-10-13: lane changes need the member's confirmation"),
  pending("phase 5 (stale-goal recheck)", "the stale-goal recheck isn't built", "a goal with no new signal for 14 days gets one check-in question from Co; no answer within 7 days and the goal goes idle and the next 9am run doesn't search it; never a second ask", 21, "stale-goal-goes-idle", "A quiet goal gets one check-in, then goes idle", "Royce 2026-10-13: stale goals are rechecked once, then idle"),
  pending("phase 5 (stale-goal recheck)", "the stale-goal recheck isn't built", "any reply about an idle goal brings it back to active, and the next 9am run searches it again", 22, "reply-revives-goal", "A reply about an idle goal revives it", "Royce 2026-10-13: an idle goal comes back on any reply about it"),
  mixedSplit,
  ownWorkNotInSpend,
];
