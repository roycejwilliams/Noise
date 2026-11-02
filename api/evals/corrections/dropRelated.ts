// "Drop that" retires everything related (closure audit, 2026-11-02). On 10-28 a member wrote "The Sequin AI launch party is off, so
// drop that": search and texts stopped, but two goal entries, two profile goals, their goal states and an ask for the same launch
// stayed active, because the resolution read only retired an item the member named as over, and never saw Cue's tasks. Now:
//   1. the read sees every open goal, ask, look-out and Cue's task, each labelled; the rule for a drop is in all three reads
//   2. what exists only for the dropped thing closes the same turn (related), quietly; an unrelated goal stays; each needs their quote
//   3. when the read can't tell, the goal stays and is asked about once (the goal recheck, due now); answered or asked, the mark goes
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
const DROP = "The Northwind launch party is off, so drop that.";
const transcript = `user: ${DROP}\nassistant: Got it, I'll stop on the launch.`;

type Row = Record<string, any>;
function world() {
  return {
    profile: { goals: [LAUNCH, ACCEL], blockers: [] as string[], city: "Oakland", intent: [
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
    ] as Row[],
    states: [LAUNCH, G_LEAD, G_FUND, G_FIT].map((g) => ({ user_id: U, goal_hash: G.goalHash(g), goal_text: g, state: "active", reason: "", source: "context", changed_at: new Date("2026-10-14T00:00:00Z"), told_at: new Date("2026-10-14T00:00:00Z"), hints: 0, last_signal_at: new Date("2026-10-20T00:00:00Z"), recheck_asked_at: null })) as Row[],
    decisions: [] as { decision: string; action: string; proposal: any }[],
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
    if (/^SELECT id, goal FROM co_tasks WHERE user_id = \$1 AND status = 'open'/.test(sql)) return r(w.tasks.filter((t) => t.status === "open").map((t) => ({ id: t.id, goal: t.goal })));
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
      if (ex.state !== "active" || ex.recheck_asked_at) return r([], 0);
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
{
  const w = world();
  const restore = install(w);
  try {
    const items = (await J.openErrandsAndGoals(U)).map((i) => ({ id: i.ask_id, text: i.ask_text, kind: i.kind }));
    const at = (id: string) => items.findIndex((i) => i.id === id);
    // What the read answered (a fixture): the named goal is over; the goal entry, the ask, the look-out and the task exist only for the
    // launch; it can't tell about the fit goal; one "related" quote is Cue's own words, and one points past the list.
    const answer = JSON.stringify({
      resolved_goals: [{ item: LAUNCH, quote: "The Northwind launch party is off" }],
      resolved_blockers: [],
      resolved_asks: [],
      related: [
        { goal: null, index: at("g-lead"), quote: "The Northwind launch party is off, so drop that" },
        { goal: null, index: at("a-venue"), quote: "The Northwind launch party is off, so drop that" },
        { goal: null, index: at("a-djs"), quote: "The Northwind launch party is off, so drop that" },
        { goal: null, index: at("task:7"), quote: "The Northwind launch party is off, so drop that" },
        { goal: null, index: at("a-inv"), quote: "I'll stop on the launch" },
        { goal: null, index: 99, quote: "The Northwind launch party is off" },
      ],
      unsure: [{ goal: null, index: at("g-fit"), quote: "The Northwind launch party is off" }],
    });
    const gated = P.gateResolutionOutput(answer, transcript, w.profile.goals, [], items);
    check("a related item quoted from Cue's own line is refused, one past the list is never read", gated.related.accepted.length === 4 && gated.related.rejected.some((x) => /something Cue said/.test(x.reason)) && !gated.related.proposals.some((p) => p.item === undefined), gated.related);

    await P.storeProfile(U, { goals: [] } as any, transcript, { newWords: DROP, precomputed: { resolutionRaw: answer, openAsks: items, correctionsRaw: JSON.stringify({ corrections: [] }), cadence: "unstated" } });

    const entry = (id: string) => w.profile.intent.find((e) => e.id === id)!;
    const state = (g: string) => w.states.find((s) => s.goal_hash === G.goalHash(g));
    check("dropping the launch takes the named goal off their goals", !w.profile.goals.includes(LAUNCH) && w.profile.goals.includes(ACCEL), w.profile.goals);
    check("... and its goal state with it (done), so it never reads as an active goal no longer on file", state(LAUNCH)?.state === "done", state(LAUNCH));
    check("the related goal entry closes the same turn, quietly: set aside, no goal-closed moment", entry("g-lead").status === "resolved" && state(G_LEAD)?.state === "stale" && /went with what they dropped/.test(state(G_LEAD)?.reason) && !w.candidates.length, { e: entry("g-lead"), s: state(G_LEAD), c: w.candidates });
    check("the related ask and look-out close (resolved, at their word), in the profile too", w.asks.find((a) => a.ask_id === "a-venue")!.resolved_at && w.asks.find((a) => a.ask_id === "a-djs")!.resolved_at && entry("a-venue").status === "resolved" && entry("a-djs").status === "resolved");
    const t7 = w.tasks.find((t) => t.id === 7)!;
    check("Cue's task for the launch closes as dropped, with their words", t7.status === "dropped" && /Northwind launch party is off/.test(t7.outcome), t7);
    check("the unrelated goal, ask and task are left alone", entry("g-fund").status === "active" && state(G_FUND)?.state === "active" && !w.asks.find((a) => a.ask_id === "a-inv")!.resolved_at && w.tasks.find((t) => t.id === 8)!.status === "open");
    check("unsure: the fit goal stays active, marked for its one question with their words", entry("g-fit").status === "active" && state(G_FIT)?.state === "active" && R.unsureQuote(state(G_FIT)?.reason) === "The Northwind launch party is off", state(G_FIT));
    check("nothing about any of it sends a text (no candidate queued)", w.candidates.length === 0 && !w.sql.some((s) => /sendblue|outbound_messages/i.test(s)));
    check("what went with it, and what's kept to ask, is logged as one decision", w.sql.some((s) => /^INSERT INTO harness_decisions/.test(s)) && w.decisions.some((d) => d.proposal.includes("retire_related")));

    // ---- the next search, task and snapshot inputs
    const searchGoals = GS.goalSweepGoals({ goals: w.profile.goals, intent: w.profile.intent }) ?? [];
    check("the next goal search reads none of the launch goals, and still the rest", !searchGoals.some((g) => /Northwind launch|Lead the partnership/.test(g)) && searchGoals.includes(ACCEL) && searchGoals.includes(G_FUND) && searchGoals.includes(G_FIT), searchGoals);
    const nextRead = await J.openErrandsAndGoals(U);
    check("the next ask search and the next retire read see no launch ask, look-out or task", !nextRead.some((i) => ["a-venue", "a-djs", "task:7", "g-lead"].includes(i.ask_id)) && nextRead.some((i) => i.ask_id === "a-inv") && nextRead.some((i) => i.ask_id === "task:8"), nextRead.map((i) => i.ask_id));
    const open = await T.openTasks(U);
    check("the next task wake has only the unrelated task", open.map((t) => t.id).join() === "8", open.map((t) => t.id));
    const goals = K.goalsOf({ firstName: "Ellis", city: "Oakland", goals: w.profile.goals, intent: w.profile.intent, updatedAt: new Date() }, await G.goalStates(U).then((m) => [...m.values()]));
    const active = goals.filter((g) => g.state === "active").map((g) => g.text);
    check("the snapshot's goals: none of the launch ones active, the unrelated and the unsure ones still are", !active.some((t) => /Northwind launch|Lead the partnership/.test(t)) && active.includes(G_FUND) && active.includes(G_FIT) && active.includes(ACCEL), goals.map((g) => `${g.state}: ${g.text}`));

    // ---- ask once: the recheck is due now for the unsure goal, it rides the reply, then the mark goes
    const now = new Date();
    const rows = (await G.goalStates(U).then((m) => [...m.values()])).filter((r) => r.state === "active");
    const turn = await R.recheckForTurn(U, "ok thanks", { userId: U, strip: (t: string) => t } as any, now, {
      rows: async () => rows,
      reactions: async () => [],
      plans: async () => [],
      onFile: async () => new Set([...searchGoals.map((g) => G.goalHash(g))]),
      lastAsk: async () => null,
    });
    check("the next reply is handed the unsure goal as its one question (due now, though it isn't searched)", turn.length === 1 && turn[0].goal === G_FIT && turn[0].recheck === "ask", turn.map((t) => [t.goal, t.recheck]));
    check("... no other active goal is asked about on a quiet clock it hasn't reached", !turn.some((t) => t.goal === G_FUND));
    const later = new Date(now.getTime() + 60_000);
    const steps = R.recheckDecide({ rows: rows.map((r) => ({ ...r, lastSignalAt: r.lastSignalAt ?? now, searched: false, hints: 0 })), now: later, signals: [{ goalHash: G.goalHash(G_FIT), at: new Date(now.getTime() + 30_000), kind: "text" }], lastExchangeAt: later, held: [], pendingText: [] });
    check("if they bring it up after the drop, that's their answer: it stays, nothing is asked", steps.find((s) => s.goalHash === G.goalHash(G_FIT))?.action === "signal");
    await R.markRecheckAsked(U, G.goalHash(G_FIT), G_FIT, "reply");
    check("once the question goes out, the mark goes: it's asked once, never again", !String(state(G_FIT)?.reason).startsWith(R.UNSURE_PREFIX) && !!state(G_FIT)?.recheck_asked_at, state(G_FIT));
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
