// "Drop that" retires everything related (closure audit, 2026-11-02). On 10-28 a member wrote "The Sequin AI launch party is off, so
// drop that": search and texts stopped, but two goal entries, two profile goals, their goal states and an ask for the same launch
// stayed active, because the resolution read only retired an item the member named as over, and never saw Cue's tasks. Now:
//   1. the read sees every open goal, ask, look-out and Cue's task, each labelled; the rule for a drop is in all three reads
//   2. what exists only for the dropped thing closes the same turn (related), quietly, and only beside a resolution the same read
//      accepted (tied to it and its quote); a task only when the ask it serves is the one resolved; an unrelated goal stays
//      (review of #351: a vague remark with nothing resolved closes nothing; a goal Cue carries is never settled by a related close)
//   3. when the read can't tell, the goal stays and is asked about once (the goal recheck, due now); answered or asked, the mark goes,
//      and the same drop re-read on later turns never marks it again; a removal clears their words from the mark; logs carry ids only
//   4. the correction shows in the next search, task and snapshot inputs, not just the reply
// Zero tokens: the model's answer is a fixture and the store is an in-memory fake. Invented names throughout.
//   npx tsx evals/corrections/dropRelated.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const P = await import("../../src/services/profileExtraction.js");
const J = await import("../../src/services/goalJourney.js");
const TL = await import("../../src/services/turnLearning.js");
const CL = await import("../../src/services/callLearning.js");
const R = await import("../../src/services/goalRecheck.js");
const G = await import("../../src/services/goalEdges.js");
const T = await import("../../src/services/coTasks.js");
const GS = await import("../../src/services/goalSweep.js");
const K = await import("../../src/services/memberKnowledge.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the member's world before the drop
const U = "member-ellis";
const LAUNCH = "host the Northwind launch party in November";
const ACCEL = "get into an accelerator";
const G_LEAD = "Lead the partnership strategy with Northwind for the launch";
const G_FUND = "Raise a pre-seed round for the new company";
const G_FIT = "Figure out whether Northwind fits our city plan";
const DJ = "book a DJ for the Northwind launch";
const DROP = "The Northwind launch party is off, so drop that.";
const transcript = `user: ${DROP}\nassistant: Got it, I'll stop on the launch.`;

type Row = Record<string, any>;
function world() {
  return {
    profile: { goals: [LAUNCH, ACCEL, DJ], blockers: [] as string[], city: "Oakland", intent: [
      { id: "g-lead", kind: "goal", status: "active", text: G_LEAD, created_at: "2026-10-07T00:00:00Z" },
      { id: "g-fund", kind: "goal", status: "active", text: G_FUND, created_at: "2026-10-07T00:00:00Z" },
      { id: "g-fit", kind: "goal", status: "active", text: G_FIT, created_at: "2026-10-07T00:00:00Z" },
      { id: "a-venue", kind: "ask", status: "active", text: "Venues for the Northwind launch party", type: "seeking" },
      { id: "a-djs", kind: "ask", status: "active", text: "Let me know about launch-party DJs in Oakland", type: "seeking" },
      { id: "a-inv", kind: "ask", status: "active", text: "Investors who back consumer apps", type: "seeking" },
    ] as Row[] },
    asks: [
      { ask_id: "a-venue", ask_text: "Venues for the Northwind launch party", intent: null, kind: "find", resolved_at: null },
      { ask_id: "a-djs", ask_text: "Let me know about launch-party DJs in Oakland", intent: "lookout", kind: "find", resolved_at: null },
      { ask_id: "a-inv", ask_text: "Investors who back consumer apps", intent: null, kind: "find", resolved_at: null },
    ] as Row[],
    tasks: [
      { id: 7, user_id: U, goal: "Draft the Northwind launch run-of-show", their_words: "draft the run of show", status: "open", kind: "work", source: "ask", steps: [], notes: [], followup: null, texts_sent: 0, wakes: 0, created_at: new Date("2026-10-20T00:00:00Z"), outcome: null },
      { id: 8, user_id: U, goal: "Research seed investors for consumer apps", their_words: "find me investors", status: "open", kind: "work", source: "ask", steps: [], notes: [], followup: null, texts_sent: 0, wakes: 0, created_at: new Date("2026-10-21T00:00:00Z"), outcome: null },
      { id: 9, user_id: U, goal: "Check in on what they told you they want: venues for the Northwind launch", their_words: "", status: "open", kind: "followup", source: "ask", target_key: "ask_checkin:a-venue", steps: [], notes: [], followup: null, texts_sent: 0, wakes: 0, created_at: new Date("2026-10-22T00:00:00Z"), outcome: null },
      { id: 10, user_id: U, goal: "Shortlist launch caterers (a piece of the launch plan Cue carries)", their_words: "", status: "open", kind: "work", source: "ask", steps: [], notes: [], followup: { goalId: 41, goalItem: 0 }, texts_sent: 0, wakes: 0, created_at: new Date("2026-10-22T00:00:00Z"), outcome: null },
    ] as Row[],
    states: [LAUNCH, G_LEAD, G_FUND, G_FIT].map((g) => ({ user_id: U, goal_hash: G.goalHash(g), goal_text: g, state: "active", reason: "", source: "context", changed_at: new Date("2026-10-14T00:00:00Z"), told_at: new Date("2026-10-14T00:00:00Z"), hints: 0, last_signal_at: new Date("2026-10-20T00:00:00Z"), recheck_asked_at: null })) as Row[],
    decisions: [] as { decision: string; action: string; proposal: any }[],
    coGoalsClosed: 0,
    candidates: [] as string[],
    sql: [] as string[],
  };
}
type World = ReturnType<typeof world>;

// The fake store: just the statements these paths run, the way Postgres would answer them.
function install(w: World) {
  const orig = { query: (pool as any).query, connect: (pool as any).connect };
  const q = async (raw: string, a: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
    const sql = raw.replace(/\s+/g, " ").trim();
    w.sql.push(sql);
    const r = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });
    if (/^INSERT INTO harness_decisions/.test(sql)) { w.decisions.push({ decision: String(a[1] ?? ""), action: String(a.find((x) => typeof x === "string" && /^[a-z_]+$/.test(x) && x !== a[1]) ?? ""), proposal: a }); return r([]); }
    if (/^INSERT INTO proactive_candidates/.test(sql)) { w.candidates.push(String(a[1] ?? "")); return r([{ id: "c1" }]); }
    if (/^SELECT life_chapters, social_energy, connection_style, activity_preferences, goals, blockers, availability_pattern, city, long_term_direction FROM co_profiles/.test(sql))
      return r([{ life_chapters: [], social_energy: 50, connection_style: "small_group", activity_preferences: [], goals: w.profile.goals, blockers: w.profile.blockers, availability_pattern: null, city: w.profile.city, long_term_direction: null }]);
    if (/^SELECT intent FROM co_profiles WHERE user_id = \$1$/.test(sql)) return r([{ intent: JSON.parse(JSON.stringify(w.profile.intent)) }]);
    if (/^SELECT goals, intent FROM co_profiles/.test(sql)) return r([{ goals: w.profile.goals, intent: w.profile.intent }]);
    if (/^UPDATE co_profiles SET intent = \$2::jsonb/.test(sql)) { w.profile.intent = JSON.parse(a[1]); return r([], 1); }
    if (/^INSERT INTO co_profiles \(/.test(sql)) { w.profile.goals = a[6]; return r([], 1); }
    if (/^SELECT ask_id, ask_text, intent FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL/.test(sql)) return r(w.asks.filter((x) => !x.resolved_at));
    if (/^UPDATE ask_checkins SET resolved_at = NOW\(\)/.test(sql)) { let n = 0; for (const x of w.asks) if (a[1].includes(x.ask_id) && !x.resolved_at) { x.resolved_at = new Date(); x.closed_reason = "member"; n++; } return r([], n); }
    if (/^SELECT id, goal, target_key, followup->>'goalId' AS goal_id FROM co_tasks WHERE user_id = \$1 AND status = 'open'/.test(sql)) return r(w.tasks.filter((t) => t.status === "open").map((t) => ({ id: t.id, goal: t.goal, target_key: t.target_key ?? null, goal_id: t.followup?.goalId ?? null })));
    if (/^SELECT 1 FROM harness_decisions WHERE user_id = \$1 AND decision = 'goal.recheck_due' AND action = 'unsure_after_drop'/.test(sql)) return r(w.decisions.filter((d) => d.decision === "goal.recheck_due" && JSON.stringify(d.proposal).includes("unsure_after_drop") && JSON.stringify(d.proposal).includes(a[1])).slice(0, 1).map(() => ({ "?column?": 1 })));
    if (/FROM co_goals WHERE user_id = \$1 AND id = \$2/.test(sql)) return r([{ id: 41, user_id: U, title: "The launch plan", their_words: "", items: [], status: "active", offered_at: new Date(), updated_at: new Date() }]);
    if (/^UPDATE co_goals SET status = 'closed'/.test(sql)) { w.coGoalsClosed++; return r([], 1); }
    if (/^SELECT goal_hash, reason FROM goal_states WHERE user_id = \$1 AND reason LIKE 'unsure: %'/.test(sql)) return r(w.states.filter((s) => String(s.reason).startsWith(R.UNSURE_PREFIX)).map((s) => ({ goal_hash: s.goal_hash, reason: s.reason })));
    if (/^UPDATE goal_states SET reason = '' WHERE user_id = \$1 AND goal_hash = \$2/.test(sql)) { const ex = w.states.find((s) => s.goal_hash === a[1] && String(s.reason).startsWith(R.UNSURE_PREFIX)); if (!ex) return r([], 0); ex.reason = ""; return r([], 1); }
    if (/^SELECT \* FROM co_tasks WHERE user_id = \$1 AND status = 'open' AND kind = 'work'/.test(sql)) return r(w.tasks.filter((t) => t.status === "open" && t.kind === "work"));
    if (/^UPDATE co_tasks SET status = \$3, outcome = \$4/.test(sql)) {
      const t = w.tasks.find((x) => x.id === a[1] && x.status === "open");
      if (!t) return r([], 0);
      Object.assign(t, { status: a[2], outcome: a[3], closed_at: new Date() });
      return r([{ id: t.id, kind: t.kind, source: t.source, followup: t.followup, steps: t.steps, goal: t.goal, texts_sent: t.texts_sent }], 1);
    }
    if (/^SELECT state FROM goal_states WHERE user_id = \$1 AND goal_hash = \$2/.test(sql)) return r(w.states.filter((s) => s.goal_hash === a[1]).map((s) => ({ state: s.state })));
    if (/^SELECT goal_hash FROM goal_states WHERE user_id = \$1 AND state = 'active' AND goal_hash = ANY/.test(sql)) return r(w.states.filter((s) => s.state === "active" && a[1].includes(s.goal_hash)).map((s) => ({ goal_hash: s.goal_hash })));
    if (/^SELECT \* FROM goal_states WHERE user_id = \$1$/.test(sql)) return r(w.states.map((s) => ({ ...s })));
    if (/^INSERT INTO goal_states \(user_id, goal_hash, goal_text, state, reason, source, changed_at, told_at, hints\) VALUES/.test(sql)) {
      // setGoalState's write: a change of state or source updates the row.
      const ex = w.states.find((s) => s.goal_hash === a[1]);
      if (!ex) { w.states.push({ user_id: U, goal_hash: a[1], goal_text: a[2], state: a[3], reason: a[4], source: a[5], changed_at: new Date(), told_at: new Date(), hints: 0, last_signal_at: new Date(), recheck_asked_at: null }); return r([], 1); }
      if (ex.state === a[3] && ex.source === a[5]) return r([], 0);
      Object.assign(ex, { state: a[3], reason: a[4], source: a[5], changed_at: new Date(), hints: 0 });
      return r([], 1);
    }
    if (/^INSERT INTO goal_states \(user_id, goal_hash, goal_text, state, reason, source, changed_at, told_at, hints, last_signal_at\) VALUES \(\$1, \$2, \$3, 'active', \$4/.test(sql)) {
      // markUnsure: a new row, or an active one with no recheck out.
      const ex = w.states.find((s) => s.goal_hash === a[1]);
      if (!ex) { const now = new Date(); w.states.push({ user_id: U, goal_hash: a[1], goal_text: a[2], state: "active", reason: a[3], source: "context", changed_at: now, told_at: now, hints: 0, last_signal_at: now, recheck_asked_at: null }); return r([], 1); }
      if (ex.state !== "active" || ex.recheck_asked_at || String(ex.reason).startsWith(R.UNSURE_PREFIX)) return r([], 0);
      Object.assign(ex, { reason: a[3], changed_at: new Date(), hints: 0 });
      return r([], 1);
    }
    if (/^UPDATE goal_states SET recheck_asked_at = NOW\(\), reason = CASE WHEN reason LIKE 'unsure: %'/.test(sql)) {
      const ex = w.states.find((s) => s.goal_hash === a[1] && s.state === "active" && !s.recheck_asked_at);
      if (!ex) return r([], 0);
      ex.recheck_asked_at = new Date();
      if (String(ex.reason).startsWith(R.UNSURE_PREFIX)) ex.reason = "";
      return r([], 1);
    }
    if (/^UPDATE goal_states SET last_signal_at = NOW\(\), recheck_asked_at = NULL/.test(sql)) {
      for (const s of w.states) if (a[1].includes(s.goal_hash)) { s.last_signal_at = new Date(); s.recheck_asked_at = null; if (String(s.reason).startsWith(R.UNSURE_PREFIX)) s.reason = ""; }
      return r([], 1);
    }
    return r([], 0);
  };
  (pool as any).query = q;
  (pool as any).connect = async () => ({ query: q, release: () => {} });
  return () => { (pool as any).query = orig.query; (pool as any).connect = orig.connect; };
}

// ---------------------------------------------------------------- 1. the read sees everything, labelled, with the rule
{
  const w = world();
  const restore = install(w);
  try {
    const items = await J.openErrandsAndGoals(U);
    const kinds = Object.fromEntries(items.map((i) => [i.ask_id, i.kind]));
    check("the retire read sees their asks, look-outs, goal entries and Cue's open tasks", kinds["a-venue"] === "ask" && kinds["a-djs"] === "lookout" && kinds["g-lead"] === "goal" && kinds["task:7"] === "task" && kinds["task:8"] === "task", items);
    const block = P.openItemsBlock(items.map((i) => ({ id: i.ask_id, text: i.ask_text, kind: i.kind })));
    check("... each numbered and labelled for the read", /\(look-out\) Let me know about launch-party DJs/.test(block) && /\(Cue's task\) Draft the Northwind launch run-of-show/.test(block) && /\(goal\) Lead the partnership strategy/.test(block), block);
  } finally { restore(); }
  const tl = TL.turnLearningPrompt({ transcript, message: DROP, today: "2026-11-02", onFile: null, openAsks: [{ id: "task:7", text: "Draft the run-of-show", kind: "task" }], styleNotes: [], coSaidBefore: null });
  const cl = CL.callLearningPrompt({ transcript, today: "2026-11-02", onFile: null, openAsks: [{ id: "task:7", text: "Draft the run-of-show", kind: "task" }] });
  const sa = P.buildResolutionPrompt(transcript, [LAUNCH], [], P.openItemsBlock([{ id: "task:7", text: "Draft the run-of-show", kind: "task" }]));
  check("the drop rule and its related/unsure answer are in the text read, the call read and the standalone read", [tl, cl, sa].every((p) => p.includes(P.RELATED_DROP_RULE) && p.includes('"related"') && p.includes('"unsure"') && /\(Cue's task\) Draft the run-of-show/.test(p)));
  check("... it's the model's read of what each item is for, never shared words, and unsure keeps it and asks once", /never from shared words alone/.test(P.RELATED_DROP_RULE) && /it stays, and Cue asks them once/.test(P.RELATED_DROP_RULE));
  check("... and relatedness is never a word match in code: the apply step takes only what the read named", !/mentionsGoal|restates|nearDuplicate|RegExp|\.test\(/.test(src("services/profileExtraction.ts").split("export async function applyRetirements")[1].split("\n}\n")[0]));
}

// ---------------------------------------------------------------- 2-4. the 10-28 shape, end to end
const QUOTE = "The Northwind launch party is off";
const runRead = async (w: World, answer: object, words = transcript, message = DROP) => {
  const items = (await J.openErrandsAndGoals(U)).map((i) => ({ id: i.ask_id, text: i.ask_text, kind: i.kind, link: i.link ?? null, owned: !!i.owned }));
  const raw = JSON.stringify(answer);
  await P.storeProfile(U, { goals: [] } as any, words, { newWords: message, precomputed: { resolutionRaw: raw, openAsks: items, correctionsRaw: JSON.stringify({ corrections: [] }), cadence: "unstated" } });
  return { items, raw };
};
const idx = async (id: string) => (await J.openErrandsAndGoals(U)).findIndex((i) => i.ask_id === id);
{
  const w = world();
  const restore = install(w);
  try {
    // What the read answered (a fixture): the launch itself is over; the goal entry, the ask, the look-out and the DJ profile goal go with
    // it; three tasks are pointed at it too (one unlinked, one serving an ask that isn't the one resolved, one a piece of a goal Cue
    // carries); one related item names nothing it goes with (and quotes Cue); it can't tell about the fit goal.
    const answer = {
      resolved_goals: [{ item: LAUNCH, quote: QUOTE }],
      resolved_blockers: [],
      resolved_asks: [],
      related: [
        { goal: null, index: await idx("g-lead"), with: LAUNCH, quote: "drop that" },
        { goal: null, index: await idx("a-venue"), with: LAUNCH, quote: QUOTE },
        { goal: null, index: await idx("a-djs"), with: LAUNCH, quote: QUOTE },
        { goal: DJ, index: null, with: LAUNCH, quote: QUOTE },
        { goal: null, index: await idx("task:7"), with: LAUNCH, quote: QUOTE },
        { goal: null, index: await idx("task:9"), with: LAUNCH, quote: QUOTE },
        { goal: null, index: await idx("task:10"), with: LAUNCH, quote: QUOTE },
        { goal: null, index: await idx("a-inv"), quote: "I'll stop on the launch" },
        { goal: null, index: 99, with: LAUNCH, quote: QUOTE },
      ],
      unsure: [{ goal: null, index: await idx("g-fit"), quote: QUOTE }],
    };
    const items = (await J.openErrandsAndGoals(U)).map((i) => ({ id: i.ask_id, text: i.ask_text, kind: i.kind, link: i.link ?? null, owned: !!i.owned }));
    const gated = P.gateResolutionOutput(JSON.stringify(answer), transcript, w.profile.goals, [], items);
    check("related items tied to the accepted resolution take its quote; the four that exist only for it are accepted", gated.related.accepted.length === 4 && gated.related.accepted.every((p) => p.quote === QUOTE), gated.related.accepted);
    check("a related item that names nothing it goes with is demoted to unsure, where Cue's own words are refused", gated.unsure.rejected.some((x) => /something Cue said/.test(x.reason)), gated.unsure.rejected);
    check("a task goes with a drop only when the ask it serves is the one resolved: unlinked, other-ask and goal-piece tasks are demoted", ["task:7", "task:9", "task:10"].every((t) => !gated.related.accepted.some((p) => p.item === t) && gated.unsure.accepted.some((p) => p.item === t)), gated.unsure.accepted);

    await runRead(w, answer);
    const entry = (id: string) => w.profile.intent.find((e) => e.id === id)!;
    const state = (g: string) => w.states.find((s) => s.goal_hash === G.goalHash(g));
    check("dropping the launch takes the named goal off their goals", !w.profile.goals.includes(LAUNCH) && w.profile.goals.includes(ACCEL), w.profile.goals);
    check("... and its goal state with it (done), so it never reads as an active goal no longer on file", state(LAUNCH)?.state === "done", state(LAUNCH));
    check("a related profile goal named by its text comes off their goals the same turn", !w.profile.goals.includes(DJ), w.profile.goals);
    check("the related goal entry closes the same turn, quietly: set aside, no goal-closed moment, no words kept on it", entry("g-lead").status === "resolved" && !entry("g-lead").closed_quote && state(G_LEAD)?.state === "stale" && state(G_LEAD)?.reason === "went with something they dropped" && !w.candidates.length, { e: entry("g-lead"), s: state(G_LEAD), c: w.candidates });
    check("the related ask and look-out close (resolved, at their word), in the profile too", w.asks.find((a) => a.ask_id === "a-venue")!.resolved_at && w.asks.find((a) => a.ask_id === "a-djs")!.resolved_at && entry("a-venue").status === "resolved" && entry("a-djs").status === "resolved");
    check("no task closes on a related guess: the unlinked one, the one for another ask and the goal piece stay open", [7, 9, 10].every((id) => w.tasks.find((t) => t.id === id)!.status === "open"), w.tasks.map((t) => [t.id, t.status]));
    check("... and the goal Cue carries for them is never settled by it", w.coGoalsClosed === 0);
    check("the unrelated goal, ask and task are left alone", entry("g-fund").status === "active" && state(G_FUND)?.state === "active" && !w.asks.find((a) => a.ask_id === "a-inv")!.resolved_at && w.tasks.find((t) => t.id === 8)!.status === "open");
    check("unsure: the fit goal stays active, marked for its one question with their words", entry("g-fit").status === "active" && state(G_FIT)?.state === "active" && R.unsureQuote(state(G_FIT)?.reason) === QUOTE, state(G_FIT));
    check("nothing about any of it sends a text (no candidate queued)", w.candidates.length === 0 && !w.sql.some((s) => /sendblue|outbound_messages/i.test(s)));
    const logs = w.decisions.filter((d) => JSON.stringify(d.proposal).includes("retire_related") || JSON.stringify(d.proposal).includes("unsure_after_drop"));
    check("what went with it, and what's kept to ask, is logged by kind and id only: never their words or a goal's text", logs.length === 2 && logs.every((d) => !/Northwind|launch party is off/i.test(JSON.stringify(d.proposal))), logs.map((d) => d.proposal));

    // ---- the next search, task and snapshot inputs
    const searchGoals = GS.goalSweepGoals({ goals: w.profile.goals, intent: w.profile.intent }) ?? [];
    check("the next goal search reads none of the launch goals, and still the rest", !searchGoals.some((g) => /Northwind launch|Lead the partnership/.test(g)) && searchGoals.includes(ACCEL) && searchGoals.includes(G_FUND) && searchGoals.includes(G_FIT), searchGoals);
    const nextRead = await J.openErrandsAndGoals(U);
    check("the next ask search and the next retire read see no launch ask, look-out or goal; the kept tasks are still there", !nextRead.some((i) => ["a-venue", "a-djs", "g-lead"].includes(i.ask_id)) && nextRead.some((i) => i.ask_id === "a-inv") && ["task:7", "task:8", "task:9", "task:10"].every((t) => nextRead.some((i) => i.ask_id === t)), nextRead.map((i) => i.ask_id));
    const goals = K.goalsOf({ firstName: "Ellis", city: "Oakland", goals: w.profile.goals, intent: w.profile.intent, updatedAt: new Date() }, await G.goalStates(U).then((m) => [...m.values()]));
    const active = goals.filter((g) => g.state === "active").map((g) => g.text);
    check("the snapshot's goals: none of the launch ones active, the unrelated and the unsure ones still are", !active.some((t) => /Northwind launch|Lead the partnership/.test(t)) && active.includes(G_FUND) && active.includes(G_FIT) && active.includes(ACCEL), goals.map((g) => `${g.state}: ${g.text}`));

    // ---- ask once: the recheck is due now for the unsure goal, it rides the reply, then the mark goes
    const now = new Date();
    const fence = { userId: U, strip: (t: string) => t } as any;
    const turnDeps = { rows: async () => (await G.goalStates(U).then((m) => [...m.values()])), reactions: async () => [], plans: async () => [], onFile: async () => new Set([...searchGoals.map((g) => G.goalHash(g))]), lastAsk: async () => null };
    const turn = await R.recheckForTurn(U, "ok thanks", fence, now, turnDeps);
    check("the next reply is handed the unsure goal as its one question (due now, though it isn't searched)", turn.length === 1 && turn[0].goal === G_FIT && turn[0].recheck === "ask", turn.map((t) => [t.goal, t.recheck]));
    check("... no other active goal is asked about on a quiet clock it hasn't reached", !turn.some((t) => t.goal === G_FUND));
    const rows = (await G.goalStates(U).then((m) => [...m.values()])).filter((r) => r.state === "active");
    const later = new Date(now.getTime() + 60_000);
    const steps = R.recheckDecide({ rows: rows.map((r) => ({ ...r, lastSignalAt: r.lastSignalAt ?? now, searched: false, hints: 0 })), now: later, signals: [{ goalHash: G.goalHash(G_FIT), at: new Date(now.getTime() + 30_000), kind: "text" }], lastExchangeAt: later, held: [], pendingText: [] });
    check("if they bring it up after the drop, that's their answer: it stays, nothing is asked", steps.find((s) => s.goalHash === G.goalHash(G_FIT))?.action === "signal");
    await R.markRecheckAsked(U, G.goalHash(G_FIT), G_FIT, "reply");
    check("once the question goes out, the mark goes", !String(state(G_FIT)?.reason).startsWith(R.UNSURE_PREFIX) && !!state(G_FIT)?.recheck_asked_at, state(G_FIT));
    // They answer "still on" (markGoal active: a goal action), and the next turns' reads re-read the same drop line.
    await R.noteGoalAction(U, [G_FIT]);
    await runRead(w, { resolved_goals: [], resolved_blockers: [], resolved_asks: [], related: [], unsure: [{ goal: null, index: await idx("g-fit"), quote: QUOTE }] });
    await runRead(w, { resolved_goals: [], resolved_blockers: [], resolved_asks: [], related: [], unsure: [{ goal: null, index: await idx("g-fit"), quote: QUOTE }] });
    const again = await R.recheckForTurn(U, "sounds good", fence, new Date(), turnDeps);
    check("the same drop re-read after they answered marks nothing again: no second question", !String(state(G_FIT)?.reason).startsWith(R.UNSURE_PREFIX) && again.length === 0, { s: state(G_FIT), again: again.map((t) => t.goal) });
  } finally { restore(); }
}

// ---------------------------------------------------------------- a vague remark closes nothing; a resolved ask takes its own check-in
{
  const w = world();
  const restore = install(w);
  try {
    const vague = "I'm done with that part, it was exhausting";
    const words = `user: ${vague}\nassistant: That sounds like a lot.`;
    await runRead(w, { resolved_goals: [], resolved_blockers: [], resolved_asks: [], related: [{ goal: null, index: await idx("task:9"), with: null, quote: vague }, { goal: null, index: await idx("a-venue"), with: null, quote: vague }, { goal: LAUNCH, index: null, with: LAUNCH, quote: vague }], unsure: [] }, words, vague);
    check("a vague drop with nothing resolved closes nothing: every task, ask and goal stays", w.tasks.every((t) => t.status === "open") && w.asks.every((a) => !a.resolved_at) && w.profile.goals.includes(LAUNCH) && w.profile.intent.every((e) => e.status === "active") && w.coGoalsClosed === 0);
  } finally { restore(); }

  const w2 = world();
  const restore2 = install(w2);
  try {
    const said = "I don't need venues for the launch anymore";
    const words = `user: ${said}\nassistant: Okay.`;
    const venue = await idx("a-venue");
    await runRead(w2, { resolved_goals: [], resolved_blockers: [], resolved_asks: [{ index: venue, quote: said }], related: [{ goal: null, index: await idx("task:9"), with: venue, quote: said }, { goal: null, index: await idx("task:10"), with: venue, quote: said }], unsure: [] }, words, said);
    const t9 = w2.tasks.find((t) => t.id === 9)!;
    check("a check-in serving the ask they said is over closes with it, dropped, without their words on it", w2.asks.find((a) => a.ask_id === "a-venue")!.resolved_at && t9.status === "dropped" && !/venues for the launch anymore/i.test(t9.outcome), t9);
    check("a task linked to a goal Cue carries isn't closed by a related guess, and the goal isn't settled", w2.tasks.find((t) => t.id === 10)!.status === "open" && w2.coGoalsClosed === 0);
  } finally { restore2(); }
}

// ---------------------------------------------------------------- forget: a removal clears their words from an unsure mark
{
  const w = world();
  const restore = install(w);
  try {
    const W = await import("../../src/services/whatCoKnows.js");
    await R.markUnsure(U, G_FIT, QUOTE);
    await R.markUnsure(U, G_FUND, "money is tight this month");
    const gone = W.removalRows([{ ref: "goal:g-x", source: "goal", was: "the Northwind launch party", now: null } as any]);
    const n = await R.forgetUnsureQuotes(U, (t) => !!W.forgets(t, gone, "their_words"));
    const st = (g: string) => w.states.find((s) => s.goal_hash === G.goalHash(g))!;
    check("a removal clears the unsure mark whose words say the removed thing (and its question), and only that one", n === 1 && st(G_FIT).reason === "" && R.unsureQuote(st(G_FUND).reason) === "money is tight this month", { n, fit: st(G_FIT).reason, fund: st(G_FUND).reason });
    check("the removal path runs it after the change commits", /forgetUnsureQuotes\(userId, \(t\) => !!forgets\(t, gone, "their_words"\)\)/.test(src("services/whatCoKnows.ts")));
  } finally { restore(); }
}

// ---------------------------------------------------------------- the pieces
{
  const w = world();
  const restore = install(w);
  try {
    // A goal already asked about (a recheck out) is never marked again; a settled one is left alone.
    w.states.find((s) => s.goal_hash === G.goalHash(G_FUND))!.recheck_asked_at = new Date();
    check("a goal with a recheck already out is not marked again", !(await R.markUnsure(U, G_FUND, "the launch is off")));
    w.states.find((s) => s.goal_hash === G.goalHash(G_LEAD))!.state = "done";
    check("a settled goal is never brought back to ask about", !(await R.markUnsure(U, G_LEAD, "the launch is off")));
    // markGoal on it (a goal action) answers it.
    await R.markUnsure(U, G_FIT, "the launch is off");
    await R.noteGoalAction(U, [G_FIT]);
    check("markGoal on it clears the mark", w.states.find((s) => s.goal_hash === G.goalHash(G_FIT))!.reason === "");
  } finally { restore(); }
  // A closed goal entry by the member's direct word is still the companion moment; only a related one is quiet.
  const w2 = world();
  const restore2 = install(w2);
  try {
    check("a goal they named as over still gets its moment; a related one doesn't", (await J.closeGoal(U, "g-fund", "we closed the round")) && w2.candidates.length === 1 && (await J.closeGoal(U, "g-lead", "the launch is off", { quiet: true })) && w2.candidates.length === 1);
  } finally { restore2(); }
  // A task read that fails leaves tasks out (nothing closes from a list it didn't see); asks and goals still read.
  const w3 = world();
  const restore3 = install(w3);
  const inner = (pool as any).query;
  (pool as any).query = async (sql: string, a: any[]) => (/FROM co_tasks/.test(sql) ? Promise.reject(new Error("down")) : inner(sql, a));
  try {
    const items = await J.openErrandsAndGoals(U);
    check("a failed task read leaves tasks out of the read, never fails it", items.length > 0 && !items.some((i) => i.kind === "task"));
  } finally { restore3(); }
  // The reply's question for an unsure goal is about the drop, never "nothing in a while".
  const RG = src("harness/replyGrounding.ts");
  check("the reply hint for an unsure goal names what they said and asks once whether it's still on", /const dropped = aside\.recheck === "ask" \? unsureQuote\(aside\.reason\) : null;/.test(RG) && /it wasn't clear whether their goal/.test(RG) && /ask once, in your own words and naming it plainly, whether that's still on/.test(RG));
}

console.log(`drop retires related: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
