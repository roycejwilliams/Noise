// The goal recheck (Royce, 2026-10-13: "a quiet goal gets searched every morning forever. Give goals a recheck: no new signal inside a
// set window, Co asks me once, no answer moves the goal to idle and it stops being searched. Any reply brings it back."). Zero tokens:
// the store, the fence and the clock are stubbed.
//   1. due at RECHECK_AFTER_DAYS with no signal, for a goal the sweep searches; a signal (their text, a reaction to its find, a goal
//      action) moves the clock
//   2. asked once: in the next natural reply, or one text after RECHECK_TEXT_AFTER_DAYS with no exchange; never while held, one at a time
//   3. idle after RECHECK_ANSWER_DAYS unanswered, told, never asked twice; the sweeps stop searching it
//   4. any text of theirs naming it brings it back; the deploy backfill asks nobody anything
//   npx tsx evals/goals/recheck.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const R = await import("../../src/services/goalRecheck.js");
const G = await import("../../src/services/goalEdges.js");
const GS = await import("../../src/services/goalSweep.js");
const SF = await import("../../src/services/sourceFence.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const DAY = 86_400_000;
const NOW = new Date("2026-11-20T18:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const RUN = "find a running club in the Marina";
const SEED = "raise a pre-seed round in December";
const POT = "take a pottery class";
const row = (goal: string, o: Partial<import("../../src/services/goalRecheck.js").RecheckRow> = {}): import("../../src/services/goalRecheck.js").RecheckRow => ({
  goalHash: G.goalHash(goal), goal, state: "active", reason: "", source: "context", changedAt: ago(60), lastSignalAt: ago(1), recheckAskedAt: null, searched: true, ...o,
});
const decide = (rows: any[], o: Partial<import("../../src/services/goalRecheck.js").RecheckInput> = {}) => R.recheckDecide({ rows, now: NOW, signals: [], lastExchangeAt: ago(1), held: [], pendingText: [], ...o });
const one = (r: any, o: any = {}) => decide([r], o)[0];

// ---- 1. due at 14 days with no signal; a signal moves the clock
{
  check("the windows are named: 14 days to due, 7 to answer, 3 before a text", R.RECHECK_AFTER_DAYS === 14 && R.RECHECK_ANSWER_DAYS === 7 && R.RECHECK_TEXT_AFTER_DAYS === 3 && R.RECHECK_IDLE_REASON === "no answer to the recheck");
  check("13 days quiet: not due", one(row(RUN, { lastSignalAt: ago(13) })).action === "none");
  const due = one(row(RUN, { lastSignalAt: ago(14) }));
  check("14 days quiet: due, asked in the next natural reply", due.action === "due" && due.dueAt?.getTime() === NOW.getTime(), due);
  check("a goal the sweep isn't searching (a work plan, a Cue task) is never rechecked", one(row(RUN, { lastSignalAt: ago(40), searched: false })).action === "none");
  check("done and set-aside goals are never rechecked", one(row(RUN, { lastSignalAt: ago(40), state: "done" })).action === "none" && one(row(RUN, { lastSignalAt: ago(40), state: "stale", reason: "its window passed (2026-11-01)" })).action === "none");
  const fresh = one(row(RUN, { lastSignalAt: ago(20) }), { signals: [{ goalHash: G.goalHash(RUN), at: ago(2), kind: "text" }] });
  check("their text naming it 2 days ago: the clock moves, not due", fresh.action === "signal" && fresh.signalAt?.getTime() === ago(2).getTime(), fresh);
  const reacted = one(row(SEED, { lastSignalAt: ago(20) }), { signals: [{ goalHash: G.goalHash(SEED), at: ago(1), kind: "reaction" }] });
  check("a reaction to a find for it: the clock moves", reacted.action === "signal");
  check("an old signal (before the clock) changes nothing", one(row(RUN, { lastSignalAt: ago(14) }), { signals: [{ goalHash: G.goalHash(RUN), at: ago(30), kind: "text" }] }).action === "due");
  check("a signal for another goal doesn't count", one(row(RUN, { lastSignalAt: ago(14) }), { signals: [{ goalHash: G.goalHash(POT), at: ago(1), kind: "text" }] }).action === "due");
  // Their text names the goal: word match on meaning words, no model.
  check("their text names the goal (meaning words, light stem)", R.mentionsGoal("Went to a Marina run club thing, the clubs there are great", RUN) && R.mentionsGoal("the seed round is moving", SEED) && R.mentionsGoal("pottery classes start Monday", POT));
  check("...and a text about something else doesn't", !R.mentionsGoal("Good morning, how was your weekend?", RUN) && !R.mentionsGoal("I want to find more people", RUN) && !R.mentionsGoal("december is busy", SEED));
  check("a goal with no meaning words is never named by a word match", !R.mentionsGoal("AI AI AI", "AI") && !R.mentionsGoal("anything", "find something"));
  const lines = [{ at: ago(3), text: "the Marina running club was fun" }, { at: ago(2), text: "nothing new" }];
  const sig = R.textSignals(lines, [row(RUN), row(POT)]);
  check("their texts become signals for the goals they name, with when", sig.length === 1 && sig[0].goalHash === G.goalHash(RUN) && sig[0].at.getTime() === ago(3).getTime(), sig);
  // Only their own texts to Co: a line to a teammate, or one the fence blanks for another member's details, never counts.
  const fence = { strip: (t: string) => (/Jordan/.test(t) ? null : t) };
  const fenced = SF.fenceTheirTexts(fence, [{ at: ago(1), text: "tell them about the Marina running club [to Mo]" }, { at: ago(1), text: "Jordan joined the Marina running club" }]);
  check("a text to a teammate or with another member's details is fenced out before it can be a signal", R.textSignals(fenced, [row(RUN)]).length === 0);
  // A find served for a goal: its search was that goal's own edges.
  const plans = [{ goalHash: G.goalHash(RUN), edges: ["Marina run clubs", "SF running groups"] }, { goalHash: G.goalHash(POT), edges: ["SF pottery classes"] }];
  check("a find from one goal's own search belongs to that goal", R.findGoalOf(G.edgeSearchText([{ goal: RUN, kind: "findable", edges: ["Marina run clubs", "SF running groups"], why: "", until: null, supersededBy: null }])!, plans) === G.goalHash(RUN));
  check("a find from the mixed hourly search belongs to no one goal", R.findGoalOf("look for: Marina run clubs; SF pottery classes. enjoys: hiking", plans) === null && R.findGoalOf("enjoys: hiking", plans) === null);
}

// ---- 2. asked once: the reply first, one text only when quiet, never while held, one at a time
{
  const asked = one(row(RUN, { lastSignalAt: ago(20), recheckAskedAt: ago(3) }));
  check("asked 3 days ago, nothing since: waiting, never due again", asked.action === "asked");
  const answered = one(row(RUN, { lastSignalAt: ago(20), recheckAskedAt: ago(3) }), { signals: [{ goalHash: G.goalHash(RUN), at: ago(1), kind: "text" }] });
  check("a signal after the ask answers it: the ask is cleared, the clock moves", answered.action === "signal" && answered.clearAsk && answered.signalAt?.getTime() === ago(1).getTime());
  const quietDue = row(RUN, { lastSignalAt: ago(17) });
  check("due 3 days with no exchange in 3 days: one text", one(quietDue, { lastExchangeAt: ago(4) }).action === "text" && one(quietDue, { lastExchangeAt: null }).action === "text");
  check("...an exchange in the last 3 days: the reply raises it, no text", one(quietDue, { lastExchangeAt: ago(2) }).action === "due");
  check("...due under 3 days: no text yet", one(row(RUN, { lastSignalAt: ago(16) }), { lastExchangeAt: null }).action === "due");
  const held = one(quietDue, { lastExchangeAt: null, held: ["safety_hold"] });
  check("a held member gets no text (it stays due, the reason said)", held.action === "due" && /held: safety_hold/.test(held.why), held);
  check("...nor while a recheck text is already waiting", one(quietDue, { lastExchangeAt: null, pendingText: [G.goalHash(POT)] }).action === "due");
  const many = decide([row(RUN, { lastSignalAt: ago(18) }), row(POT, { lastSignalAt: ago(25) }), row(SEED, { lastSignalAt: ago(19) })], { lastExchangeAt: null });
  check("several due at once: one question per member, the goal due longest; the others wait", many.filter((s) => s.action === "text").length === 1 && many.find((s) => s.action === "text")?.goal === POT && many.filter((s) => s.action === "due").length === 0 && many.filter((s) => s.action === "none" && /one question at a time/.test(s.why)).length === 2, many.map((s) => s.action));
  // Asked means sent: the reply's hint counts only when a text that went out raised it; the text counts on send.
  check("the reply raises it only by naming it as a question", G.raisedGoal("Still want things for the running club in the Marina?", RUN) && !G.raisedGoal("Found a running club near you.", RUN));
  check("asked is set only by a sent text the judge read as asking it, once per quiet stretch, only if nothing moved the goal since the turn began; else a hint is used", /if \(\(await R\.judgeRecheckAsked\(r\.goal, sent, o\.judge\)\)\.asked\) await R\.markRecheckAsked\(userId, r\.goalHash, r\.goal, "reply", \{ signalBefore: o\.turnStartedAt \?\? r\.lastSignalAt \?\? null \}\);\s*else await R\.noteRecheckHint\(userId, r\.goalHash\)/.test(src("services/goalEdges.ts")) && /recheck_asked_at IS NULL AND \(\$3::timestamptz IS NULL OR last_signal_at <= \$3::timestamptz\)/.test(src("services/goalRecheck.ts")) && /turnStartedAt: input\.turnStartedAt \?\? null/.test(src("agent/conversationReply.ts")));
  check("the text marks asked on send only, and only a draft the judge reads as asking whether they still want it goes", /goal_recheck: \{[\s\S]*?const read = await R\.judgeRecheckAsked\(still\.goal, text\);\s*if \(!read\.asked\) return skip[\s\S]*?async onSent\(c\) \{[\s\S]*?markRecheckAsked\(c\.userId, String\(c\.payload\.goalHash\), String\(c\.payload\.goal \?\? ""\), "text"\)/.test(src("harness/proactiveRegistry.ts")));
  check("the text is a registered proactive type under every gate: a companion message, held while they struggle, spaced", /goal_recheck: \{ priority: 10, typeGapDays: 3 \}/.test(src("harness/proactive.ts")) && /"commitment_nudge",\s*"goal_recheck",\s*(?:"name_change",\s*)?(?:"announcement",\s*)?\]\);/.test(src("harness/proactive.ts")) && /goal_recheck: "companion"/.test(src("harness/proactivePurpose.ts")));
  const reg = src("harness/proactiveRegistry.ts");
  const block = reg.slice(reg.indexOf("  goal_recheck: {"), reg.indexOf("  // Member-state nudges"));
  const hint = src("harness/replyGrounding.ts");
  const hintLines = (hint.match(/addHint\(rf, `(?:Their goal|You asked them|You've been looking)[^`]*`\)/g) ?? []).join("\n");
  check("the member-facing asks: no em dash, no exclamation point, never an offer to keep looking, no role noun", block.length > 200 && !/[—–]/.test(block + hintLines) && /forbidden: \[\{ pattern: \/!\/, reason: "exclamation point" \}\]/.test(block) && /Never an offer to keep looking/.test(block) && hintLines.split("\n").length === 4 && !/\b(assistant|matchmaker|concierge|companion)\b/i.test(block + hintLines), hintLines);
}

// ---- 3. idle after 7 days unanswered; never asked twice; the sweeps stop searching it
{
  check("asked 6 days ago, nothing: still waiting", one(row(RUN, { lastSignalAt: ago(25), recheckAskedAt: ago(6) })).action === "asked");
  const idle = one(row(RUN, { lastSignalAt: ago(25), recheckAskedAt: ago(7) }));
  check("asked 7 days ago, nothing: idle", idle.action === "idle", idle);
  const after = row(RUN, { state: "stale", reason: R.RECHECK_IDLE_REASON, changedAt: ago(10), lastSignalAt: ago(30), recheckAskedAt: ago(17) });
  check("an idle goal is never asked again, however long it stays quiet", R.isRecheckIdle(after) && one(after).action === "none" && one({ ...after, lastSignalAt: ago(90) }, { lastExchangeAt: null }).action === "none");
  check("idle is stale from context with the reason, its note owed (told_at NULL), and never raised again as a set-aside question", /setGoalState\(userId, goal, "stale", RECHECK_IDLE_REASON, "context", \{ told: false \}\)/.test(src("services/goalRecheck.ts")) && /told_at IS NULL AND reason IS DISTINCT FROM \$2 ORDER BY changed_at`, \[userId, "no answer to the recheck"\]/.test(src("services/goalEdges.ts")) && /COALESCE\(CASE WHEN \$7::boolean THEN NOW\(\) END, CASE WHEN \$6 = 'context' AND \$4 <> 'active' THEN NULL ELSE NOW\(\) END\)/.test(src("services/goalEdges.ts")));
  // The goal sweep plans active goals only, so an idle goal is never read or searched.
  const prompts: string[] = [];
  const states = new Map([[G.goalHash(RUN), { goalHash: G.goalHash(RUN), goal: RUN, state: "stale" as const, reason: R.RECHECK_IDLE_REASON, source: "context" as const, changedAt: ago(1), toldAt: ago(1), hints: 0 }]]);
  const p = await G.planGoalSweep("u1", [RUN, POT], { city: "San Francisco", zone: "America/Los_Angeles", now: NOW }, {
    model: async (pr) => { prompts.push(pr); return JSON.stringify([{ n: 1, kind: "findable", edges: ["SF pottery classes"], until: null, superseded_by: null }]); },
    states: async () => states, setState: async () => true, corrections: async () => [], retired: () => null, findAsks: async () => [], helpAsk: async () => {}, log: async () => {},
  });
  check("the goal sweep never reads or searches an idle goal", prompts.length === 1 && !prompts[0].includes(RUN) && p.searchText === "look for: SF pottery classes", { prompt: prompts[0]?.slice(0, 300), s: p.searchText });
  check("the 9am sweep skips a goal set aside since its plan", /if \(st && st\.state !== "active"\) return \{ status: "skipped", why: `set aside since its plan/.test(src("services/dailySweep.ts")));
}

// ---- 4. revive on mention; the deploy backfill asks nobody
{
  const idle = row(RUN, { state: "stale", reason: R.RECHECK_IDLE_REASON, changedAt: ago(5), lastSignalAt: ago(30), recheckAskedAt: ago(12) });
  const back = one(idle, { signals: R.textSignals([{ at: ago(0.1), text: "actually still keen on a Marina running club" }], [idle]) });
  check("their text naming an idle goal brings it back, the ask cleared", back.action === "revive" && back.clearAsk && back.signalAt?.getTime() === ago(0.1).getTime(), back);
  check("...a mention from before it went idle doesn't", one(idle, { signals: [{ goalHash: idle.goalHash, at: ago(6), kind: "text" }] }).action === "none");
  check("...another set-aside (its window passed) is only revived by markGoal, never a word match", one({ ...idle, reason: "its window passed (2026-11-01)" }, { signals: [{ goalHash: idle.goalHash, at: ago(0.1), kind: "text" }] }).action === "none");
  check("revive is one conditional write (only an idle goal flips back) and clears the ask; markGoal (and pickGoalItems) is a signal too", /recheck_asked_at = NULL\s+WHERE user_id = \$1 AND goal_hash = \$2 AND state = 'stale' AND source = 'context' AND reason = \$4`/.test(src("services/goalRecheck.ts")) && /R\.noteGoalAction\(ctx\.userId, \[match\]\)/.test(src("agent/loopTools.ts")) && /R\.noteGoalActionText\(ctx\.userId/.test(src("agent/conversationTools.ts")));
  check("the text route records their text's signals as it arrives (signals and revives only)", /R\.noteTextSignals\(user\.id, content\)/.test(src("routes/sendblue.ts")) && /new Set<RecheckAction>\(\["signal", "revive"\]\)/.test(src("services/goalRecheck.ts")));
  // Deploy: every existing row's clock is the deploy moment; a goal with no row starts its clock when the sweep first sees it.
  const mig = src("db/migrations.ts");
  check("migration: the default before the fill, NOT NULL after it, recheck_asked_at its own statement", /ADD COLUMN IF NOT EXISTS last_signal_at TIMESTAMPTZ`\)\s*\.then\(\(\) => pool\.query\(`ALTER TABLE goal_states ALTER COLUMN last_signal_at SET DEFAULT NOW\(\)`\)\)\s*\.then\(\(\) => pool\.query\(`UPDATE goal_states SET last_signal_at = NOW\(\) \+ \(\(\('x' \|\| substr\(goal_hash, 1, 7\)\)::bit\(28\)::int % 7\) \* INTERVAL '1 day'\) WHERE last_signal_at IS NULL`\)\)\s*\.then\(\(\) => pool\.query\(`ALTER TABLE goal_states ALTER COLUMN last_signal_at SET NOT NULL`\)\)/.test(mig) && /await pool\s*\.query\(`ALTER TABLE goal_states ADD COLUMN IF NOT EXISTS recheck_asked_at TIMESTAMPTZ`\)\s*\.catch/.test(mig));
  const deploy = ago(13);
  const backfilled = decide([row(RUN, { lastSignalAt: deploy, changedAt: ago(200) }), row(POT, { lastSignalAt: deploy, changedAt: ago(400) }), row(SEED, { lastSignalAt: deploy })], { lastExchangeAt: null });
  check("13 days after deploy, goals quiet for months: nobody is asked anything", backfilled.every((s) => s.action === "none"), backfilled.map((s) => s.action));
}

// ---- the run, with stubbed deps
function stubDeps(o: { rows: any[]; texts?: { at: Date; text: string }[] | null; reactions?: { askText: string; at: Date }[]; plans?: any[]; held?: string[]; pending?: string[]; lastAsk?: Date | null }) {
  const calls: { kind: string; args: any[] }[] = [];
  const rows = o.rows;
  const deps: import("../../src/services/goalRecheck.js").RecheckDeps = {
    rows: async () => rows,
    ensure: async (_u, goal) => { calls.push({ kind: "ensure", args: [goal] }); rows.push({ goalHash: G.goalHash(goal), goal, state: "active", reason: "", source: "context", changedAt: NOW, toldAt: NOW, hints: 0, lastSignalAt: NOW, recheckAskedAt: null }); },
    texts: async () => (o.texts === undefined ? [] : o.texts),
    reactions: async () => o.reactions ?? [],
    plans: async () => o.plans ?? [],
    held: async () => o.held ?? [],
    pendingText: async () => o.pending ?? [],
    lastAsk: async () => o.lastAsk ?? null,
    signal: async (...a) => { calls.push({ kind: "signal", args: a }); },
    revive: async (...a) => { calls.push({ kind: "revive", args: a }); return true; },
    idle: async (...a) => { calls.push({ kind: "idle", args: a }); return true; },
    queueText: async (...a) => { calls.push({ kind: "text", args: a }); return true; },
    log: async (d) => { calls.push({ kind: "log", args: [d] }); },
  };
  return { deps, calls, logs: () => calls.filter((c) => c.kind === "log").map((c) => c.args[0]) };
}
const stateRow = (goal: string, o: any = {}) => ({ goalHash: G.goalHash(goal), goal, state: "active", reason: "", source: "context", changedAt: ago(60), toldAt: ago(60), hints: 0, lastSignalAt: ago(1), recheckAskedAt: null, ...o });
const searching = (...goals: string[]) => goals.map((g) => ({ goalHash: G.goalHash(g), edges: [`${g} edge`], latest: true }));
{
  // A goal on file with no row gets one, its clock starting now: nothing asked.
  const s = stubDeps({ rows: [], plans: searching(RUN) });
  const steps = await R.runGoalRecheck("u1", [RUN], NOW, s.deps);
  check("a goal on file with no row gets one (active, clock now) and isn't asked", s.calls.some((c) => c.kind === "ensure" && c.args[0] === RUN) && steps.length === 1 && steps[0].action === "none");
  // The fence failed: nothing decided on a partial picture.
  const f = stubDeps({ rows: [stateRow(RUN, { lastSignalAt: ago(30), recheckAskedAt: ago(10) })], texts: null, plans: searching(RUN) });
  check("their texts can't be read through the fence: nothing is decided (no idle, no ask)", (await R.runGoalRecheck("u1", [RUN], NOW, f.deps)).length === 0 && !f.calls.some((c) => c.kind === "idle" || c.kind === "text"));
  // Each decision applied and logged under its own name.
  const all = stubDeps({
    rows: [
      stateRow(RUN, { lastSignalAt: ago(30), recheckAskedAt: ago(8) }),
      stateRow(POT, { lastSignalAt: ago(20) }),
      stateRow(SEED, { state: "stale", reason: R.RECHECK_IDLE_REASON, changedAt: ago(4), lastSignalAt: ago(40), recheckAskedAt: ago(11) }),
      stateRow("find a book club in Noe Valley", { lastSignalAt: ago(15) }),
    ],
    texts: [{ at: ago(4.5), text: "nothing much" }, { at: ago(3.5), text: "the seed round in December is back on" }],
    plans: searching(RUN, POT, "find a book club in Noe Valley"),
  });
  await R.runGoalRecheck("u1", [RUN, POT, SEED, "find a book club in Noe Valley"], NOW, all.deps);
  const names = all.logs().map((d: any) => `${d.decision}:${d.action}`);
  check("idle, revive and the text are applied and logged (goal.idle, goal.revived, goal.recheck_due); the other due goal waits its turn", all.calls.some((c) => c.kind === "idle" && c.args[1] === RUN) && all.calls.some((c) => c.kind === "revive" && c.args[1] === SEED) && all.calls.filter((c) => c.kind === "text").length === 1 && names.includes("goal.idle:stale") && names.includes("goal.revived:active") && names.includes("goal.recheck_due:text_queued") && !names.includes("goal.recheck_due:ask_in_reply"), names);
  check("the text goes to the goal due longest", all.calls.find((c) => c.kind === "text")?.args[1].goal === POT);
  const heldRun = stubDeps({ rows: [stateRow(POT, { lastSignalAt: ago(20) })], texts: [], plans: searching(POT), held: ["unanswered_pause"] });
  await R.runGoalRecheck("u1", [POT], NOW, heldRun.deps);
  check("a held member: no text queued, the hold logged as a skip", !heldRun.calls.some((c) => c.kind === "text") && heldRun.logs().some((d: any) => d.decision === "goal.recheck_due" && d.outcome === "skip" && /held: unanswered_pause/.test(d.reason)));
  const goneRow = stubDeps({ rows: [stateRow("an old goal no longer on file", { lastSignalAt: ago(40) })], texts: [], plans: [] });
  check("a row whose goal left the file is never asked about", (await R.runGoalRecheck("u1", [POT], NOW, goneRow.deps)).every((s) => s.goal !== "an old goal no longer on file"));
  // The text route: signals and revives only, never an ask or an idle.
  const route = stubDeps({ rows: [] });
  const routeRows = [row(RUN, { lastSignalAt: ago(30), recheckAskedAt: ago(9) }), row(POT, { lastSignalAt: ago(20) })];
  const routeSteps = decide(routeRows, { lastExchangeAt: null });
  await R.applySteps("u1", routeSteps, routeRows, route.deps, new Set(["signal", "revive"]));
  check("the text route never idles or asks", routeSteps.some((s) => s.action === "idle") && routeSteps.some((s) => s.action === "text") && !route.calls.some((c) => c.kind === "idle" || c.kind === "text" || c.kind === "log"));
}

// ---- the reply's recheck
{
  const fence = { userId: "u1", strip: (t: string) => t };
  const deps = (rows: any[]) => ({ rows: async () => rows, reactions: async () => [], plans: async () => searching(RUN, POT) });
  const turn = await R.recheckForTurn("u1", "How's your week going?", fence, NOW, deps([stateRow(RUN, { lastSignalAt: ago(15) }), stateRow(POT, { lastSignalAt: ago(25), recheckAskedAt: ago(4) }), stateRow(SEED, { lastSignalAt: ago(2) })]));
  check("the reply is handed one due goal to ask (the oldest), and the asked one to read their answer once spaced", turn.length === 2 && turn[0].goal === RUN && turn[0].recheck === "ask" && turn[1].goal === POT && turn[1].recheck === "asked", turn.map((t) => `${t.goal}:${t.recheck}`));
  const named = await R.recheckForTurn("u1", "Signed up for a Marina running club trial", fence, NOW, deps([stateRow(RUN, { lastSignalAt: ago(15) })]));
  check("a goal this very message names is never asked about", named.length === 0);
  check("no fence, no recheck (fails closed)", (await R.recheckForTurn("u1", "hi", { userId: "u1", strip: () => null, failed: true }, NOW, deps([stateRow(RUN, { lastSignalAt: ago(15) })]))).length === 0 && (await R.recheckForTurn("u1", "hi", null, NOW, deps([stateRow(RUN, { lastSignalAt: ago(15) })]))).length === 0);
  check("the turn hands rechecks after the set-asides, on the same hint, through the turn's keep()", /goalSetAsides: \[\.\.\.goalSetAsides, \.\.\.goalRechecks\]\.flatMap\(\(r\) => \{ const g = keep\(r\.goal\); return g \? \[\{ \.\.\.r, goal: g \}\] : \[\]; \}\)/.test(src("services/turnContext.ts")) && /const aside = asides\.find\(\(a\) => a\.recheck !== "asked"\)/.test(src("harness/replyGrounding.ts")));
  // The goal sweep runs the recheck first, whatever the cooldown says.
  const order: string[] = [];
  const member = { user_id: "u1", first_name: "Ellis", phone_number: "+14155550100", city: "San Francisco", goals: [RUN], activity_preferences: [], long_term_direction: "", intent: [], last_attempted_at: null, cooldown_cleared: false };
  await GS.runGoalSweep(async (items, _l, fn) => { for (const i of items) await fn(i); }, { rows: async () => [member], mark: async () => { order.push("mark"); }, surface: async () => {}, plan: async () => ({ searchText: null }), recheck: async () => { order.push("recheck"); } });
  check("the goal sweep runs the recheck before its cooldown, hold and plan", order[0] === "recheck" && order.includes("mark"), order);
}

// ---- review fixes (2026-10-13)
{
  // 1. One question at a time; the deploy backfill is staggered.
  const BOOK = "find a book club in Noe Valley";
  const three = [row(RUN, { lastSignalAt: ago(15) }), row(POT, { lastSignalAt: ago(16) }), row(BOOK, { lastSignalAt: ago(15.5) })];
  const fence = { userId: "u1", strip: (t: string) => t };
  const turnDeps = (rows: any[], o: { onFile?: Set<string> } = {}) => ({ rows: async () => rows, reactions: async () => [], plans: async () => searching(RUN, POT, BOOK), ...(o.onFile ? { onFile: async () => o.onFile! } : {}) });
  const t3 = await R.recheckForTurn("u1", "Morning", fence, NOW, turnDeps(three.map((r) => stateRow(r.goal, { lastSignalAt: r.lastSignalAt }))));
  check("three goals due: the reply gets one ask (the goal due longest)", t3.length === 1 && t3[0].goal === POT && t3[0].recheck === "ask", t3.map((t) => t.goal));
  const after1 = decide([row(POT, { lastSignalAt: ago(17), recheckAskedAt: ago(1) }), row(RUN, { lastSignalAt: ago(15) }), row(BOOK, { lastSignalAt: ago(15.5) })]);
  check("...the next ask waits out the spacing: a recheck asked a day ago holds every other goal", after1.filter((x) => x.action === "due" || x.action === "text").length === 0 && after1.filter((x) => /within 3 days/.test(x.why)).length === 2, after1.map((x) => `${x.action}:${x.why}`));
  const after3 = decide([row(POT, { lastSignalAt: ago(19), recheckAskedAt: ago(3) }), row(RUN, { lastSignalAt: ago(15) }), row(BOOK, { lastSignalAt: ago(15.5) })]);
  check("...and after RECHECK_TEXT_AFTER_DAYS the next one (the oldest) comes due", after3.filter((x) => x.action === "due").map((x) => x.goal).join() === BOOK, after3.map((x) => x.action));
  const offs = [RUN, POT, SEED, BOOK, "learn Spanish", "write a book", "a", "b", "c", "d"].map((g) => R.backfillOffsetDays(G.goalHash(g)));
  check("the backfill offset is 0 to 6 days, from the hash, and spreads goals over several days", offs.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && new Set(offs).size >= 3 && R.backfillOffsetDays(G.goalHash(RUN)) === parseInt(G.goalHash(RUN).slice(0, 7), 16) % 7, offs);
  check("a goal first seen by the sweep gets the same offset", /NOW\(\) \+ \(\$4 \|\| ' days'\)::interval\) ON CONFLICT \(user_id, goal_hash\) DO NOTHING`,\s*\[userId, goalHash\(goal\), goal\.slice\(0, 500\), String\(backfillOffsetDays\(goalHash\(goal\)\)\)\]/.test(src("services/goalRecheck.ts")));

  // 2. Coordinated with the goal nudge and the seasonal check-in.
  const N = await import("../../src/services/memberStateNudges.js");
  const g1 = { id: "g1", text: "Raise a pre-seed round for the climate startup", confirmedAt: new Date(NOW.getTime() - 30 * DAY), state: "active" as const, coTask: false };
  const snap = (goals: any[]) => ({ userId: "u1", zone: "America/Los_Angeles", now: NOW, ownLines: [], intros: [], cared: [], goals, intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [] });
  check("a goal under recheck gets no goal nudge (one without does)", N.detectGoalNudge(snap([{ ...g1, underRecheck: true }])).length === 0 && N.detectGoalNudge(snap([g1])).length === 1);
  {
  const R0 = await import("../../src/services/goalRecheck.js");
  const now = new Date("2026-11-01T12:00:00Z");
  check("an ask holds back other goal messages only inside the answer window", R0.recheckAskOpen(new Date(now.getTime() - 3 * 86_400_000), now) && !R0.recheckAskOpen(new Date(now.getTime() - 8 * 86_400_000), now) && !R0.recheckAskOpen(null, now));
}
check("the goal nudge carries its goal's hash, and sending it counts as the recheck's question", /meta: \{ goalId: g\.id, goalHash: g\.hash \?\? null \}/.test(src("services/memberStateNudges.ts")) && /c\.type === "goal_nudge" && c\.payload\?\.meta\?\.goalHash\) await import\("\.\/goalRecheck\.js"\)\.then\(\(R\) => R\.noteRecheckSent\(/.test(src("services/memberStateNudges.ts")) && /underRecheck: recheckAskOpen\(st\?\.recheckAskedAt\)/.test(src("services/memberStateNudges.ts")));
  check("a recheck text counts in the goal season and in the last goal surface", /s\.type === "goal_checkin" \|\| s\.type === "goal_nudge" \|\| s\.type === "goal_recheck"/.test(src("harness/proactive.ts")) && /type IN \('goal_checkin', 'goal_nudge', 'goal_recheck'\)/.test(src("services/memberStateNudges.ts")));
  const P = await import("../../src/harness/proactive.js");
  const KR = await import("../../src/services/kindRestraint.js");
  check("kind restraint reads the recheck text as a goal nudge", KR.kindOf("goal_recheck") === "goal_nudge");
  const st = { now: NOW, sends: [{ type: "goal_recheck", targetKey: "goal_recheck:x:2026-11-01", topicKey: "goal:x", sentAt: ago(10), exempt: false }], lastInboundAt: null };
  const cand = { id: "c", userId: "u1", type: "goal_nudge", targetKey: "k", topicKey: "t", summary: "s", priority: 11, dueAt: NOW, expiresAt: null, payload: {}, attempts: 0, createdAt: NOW } as any;
  check("a goal nudge is held inside the season after a recheck text", P.candidateChecks(cand, st as any).some((k: any) => k.name === "goal_season" && !k.pass));
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const J = await import("../../src/services/goalJourney.js");
  const { default: pool } = await import("../../src/db/db.js");
  const orig = (pool as any).query;
  const text = "Raise a pre-seed round";
  const intent = [{ id: "g1", kind: "goal", status: "active", text, confirmed_at: ago(120).toISOString() }];
  const stateOf = (o: any) => ({ goal_hash: G.goalHash(text), goal_text: text, state: "active", reason: "", source: "context", changed_at: ago(40), told_at: ago(40), hints: 0, last_signal_at: ago(40), recheck_asked_at: null, ...o });
  P.setProactiveModelForTests(async () => "Still chasing the pre-seed, or has that shifted?");
  const draftWith = async (o: any) => {
    (pool as any).query = async (sql: string) => (/FROM goal_states/.test(sql) ? { rows: [stateOf(o)] } : { rows: [{ intent }] });
    try { return await proactiveRegistry.goal_checkin.draft({ id: "c", userId: "u1", type: "goal_checkin", payload: { goalId: "g1", text } } as any, { firstName: "Jordan", userId: "u1" } as any) as any; } finally { (pool as any).query = orig; }
  };
  const live = await draftWith({});
  const idled = await draftWith({ state: "stale", reason: R.RECHECK_IDLE_REASON, recheck_asked_at: ago(10) });
  const out = await draftWith({ recheck_asked_at: ago(2) });
  P.setProactiveModelForTests(null);
  check("an idle goal never gets a seasonal check-in: dropped as done (so the cron stops re-queuing it)", !live.skip && idled.skip === J.GOAL_DONE_SKIP, { live, idled });
  check("...and one whose recheck is out waits for the answer", typeof out.skip === "string" && /recheck already asked/.test(out.skip));
  check("sending the seasonal check-in counts as the recheck's question (when the judge reads it so)", /goal_checkin: \{[\s\S]*?async onSent\(c, _p, messages\) \{[\s\S]*?R\.noteRecheckSent\(c\.userId, goalHash\(String\(c\.payload\.text \?\? ""\)\), String\(c\.payload\.text \?\? ""\), messages\.join\("\\n"\), "goal_checkin"\)/.test(src("harness/proactiveRegistry.ts")));

  // 3. Asked detection: a question about still wanting it, never an offer; a reply that doesn't ask uses a hint; after two, the text.
  const hinted = await R.recheckForTurn("u1", "Morning", fence, NOW, turnDeps([stateRow(RUN, { lastSignalAt: ago(15), hints: 2 })]));
  check("after two replies carried it without asking, the reply stops offering it (the text takes it)", hinted.length === 0 && (await R.recheckForTurn("u1", "Morning", fence, NOW, turnDeps([stateRow(RUN, { lastSignalAt: ago(15), hints: 1 })]))).length === 1);

  // 5. The text waits for the reply when they've texted since it was queued.
  const queuedAt = ago(1);
  const okRow = { ...stateRow(RUN, { lastSignalAt: ago(18) }) } as any;
  const base = { onFile: true, queuedAt, queuedSignalAt: ago(18), latestText: null as Date | null | "unreadable" };
  check("the recheck text goes when nothing changed since it was queued", R.recheckTextCheck(okRow, base).ok === true);
  const since = R.recheckTextCheck(okRow, { ...base, latestText: ago(0.5) });
  check("...but not when they've texted since it was queued (the reply raises it instead)", since.ok === false && /texted since/.test((since as any).why), since);
  check("...nor when their texts can't be read through the fence, nor when it's asked, set aside or off file", R.recheckTextCheck(okRow, { ...base, latestText: "unreadable" }).ok === false && R.recheckTextCheck({ ...okRow, recheckAskedAt: ago(0.2) }, base).ok === false && R.recheckTextCheck({ ...okRow, state: "stale" }, base).ok === false && R.recheckTextCheck(okRow, { ...base, onFile: false }).ok === false && R.recheckTextCheck(okRow, { ...base, latestText: ago(2) }).ok === true);
  check("the queued text carries when it was queued, and the signal it was queued on", /queuedAt: new Date\(\)\.toISOString\(\)/.test(src("services/goalRecheck.ts")) && /deps\.queueText\(userId, s, s\.signalAt \?\? r\?\.lastSignalAt \?\? new Date\(\)\)/.test(src("services/goalRecheck.ts")));

  // 7. Fewer false mentions.
  check("'booked a table' doesn't name 'write a book'", !R.mentionsGoal("I booked a table for Friday", "write a book"));
  check("'learn more about that gallery' doesn't name 'learn Spanish'", !R.mentionsGoal("I want to learn more about that gallery", "learn Spanish") && R.mentionsGoal("my Spanish lessons start next week, finally going to learn it", "learn Spanish"));

  // 8. Only goals still on file reach the reply.
  const gone = await R.recheckForTurn("u1", "Morning", fence, NOW, turnDeps([stateRow(RUN, { lastSignalAt: ago(15) }), stateRow(POT, { lastSignalAt: ago(25), recheckAskedAt: ago(4) })], { onFile: new Set([G.goalHash(BOOK)]) }));
  check("a goal removed from the file is never handed to the reply, asked or not", gone.length === 0, gone.map((g) => g.goal));
}

// ---- re-review fixes (2026-10-13)
{
  const BOOK = "find a book club in Noe Valley";
  const fence = { userId: "u1", strip: (t: string) => t };
  // 1. An asked goal no longer searched never goes idle.
  check("an asked goal the sweep stopped searching is left alone, never idled", one(row(RUN, { lastSignalAt: ago(30), recheckAskedAt: ago(9), searched: false })).action === "none" && one(row(RUN, { lastSignalAt: ago(30), recheckAskedAt: ago(9) })).action === "idle");
  // 2. The spacing survives an answer: the last logged ask holds the next goal.
  const answeredA = row(RUN, { lastSignalAt: ago(1 / 24), recheckAskedAt: null });
  const dueB = row(POT, { lastSignalAt: ago(16) });
  const held2 = decide([answeredA, dueB], { lastAskAt: ago(2) });
  check("A answered an hour ago (asked 2 days ago), B due: no ask for B inside the spacing", held2.find((x) => x.goal === POT)?.action === "none" && /within 3 days/.test(held2.find((x) => x.goal === POT)!.why), held2.map((x) => `${x.action}:${x.why}`));
  check("...and B's ask comes once the spacing has passed", decide([answeredA, dueB], { lastAskAt: ago(3) }).find((x) => x.goal === POT)?.action === "due");
  const turnB = await R.recheckForTurn("u1", "Morning", fence, NOW, { rows: async () => [stateRow(RUN, { lastSignalAt: ago(1 / 24) }), stateRow(POT, { lastSignalAt: ago(16) })], reactions: async () => [], plans: async () => searching(RUN, POT), lastAsk: async () => ago(2) });
  check("...the reply path reads the logged ask too", turnB.length === 0);
  const turnFail = await R.recheckForTurn("u1", "Morning", fence, NOW, { rows: async () => [stateRow(POT, { lastSignalAt: ago(16) })], reactions: async () => [], plans: async () => searching(POT), lastAsk: async () => { throw new Error("down"); } });
  check("...and a last-ask read that fails holds the ask (fails closed)", turnFail.length === 0);
  check("the logged ask is read from goal.recheck_asked (and ask.retire_asked), never an answer, in the run and the nudge's season", /decision IN \('goal\.recheck_asked', 'ask\.retire_asked'\) AND action <> 'answered'/.test(src("services/goalRecheck.ts")) && /decision = 'goal\.recheck_asked' AND action <> 'answered'/.test(src("services/memberStateNudges.ts")) && /lastGoalSurfaceAt: \[surface\.rows\[0\]\?\.at, rechecked\.rows\[0\]\?\.at\]/.test(src("services/memberStateNudges.ts")));
  // 3. A goal whose reply attempts are used up never blocks the next.
  const exhaustedA = row(POT, { lastSignalAt: ago(16), hints: 2 });
  const freshB = row(BOOK, { lastSignalAt: ago(15) });
  const pick = decide([exhaustedA, freshB]);
  check("A's reply attempts used up, B due: B is the reply's ask, A doesn't block it", pick.find((x) => x.goal === BOOK)?.action === "due" && pick.find((x) => x.goal === POT)?.action !== "due", pick.map((x) => `${x.goal}:${x.action}`));
  const both = decide([row(POT, { lastSignalAt: ago(18), hints: 2 }), freshB]);
  check("...once A is due long enough it stays due for the text alongside B's reply ask", both.find((x) => x.goal === POT)?.action === "due" && /left to the text/.test(both.find((x) => x.goal === POT)!.why) && both.find((x) => x.goal === BOOK)?.action === "due", both.map((x) => `${x.goal}:${x.action}:${x.why}`));
  const offered = await R.recheckForTurn("u1", "Morning", fence, NOW, { rows: async () => [stateRow(POT, { lastSignalAt: ago(16), hints: 2 }), stateRow(BOOK, { lastSignalAt: ago(15) })], reactions: async () => [], plans: async () => searching(POT, BOOK), lastAsk: async () => null });
  check("...so the reply is offered B", offered.length === 1 && offered[0].goal === BOOK && offered[0].recheck === "ask", offered.map((x) => x.goal));
  const textA = decide([row(POT, { lastSignalAt: ago(18), hints: 2 }), freshB], { lastExchangeAt: null });
  check("...and the text still goes to A once it's due long enough", textA.find((x) => x.goal === POT)?.action === "text", textA.map((x) => `${x.goal}:${x.action}`));
  // 4. The Haiku read: strict JSON, fails closed, no call without a question mark, stubbed here.
  let calls = 0;
  const yes = async (p: string) => { calls++; return JSON.stringify({ asked: /Still up for a run club/.test(p), reason: "stub" }); };
  check("no question mark: no read at all, not asked", !(await R.judgeRecheckAsked(RUN, "Found a running club near you.", yes)).asked && calls === 0);
  check("the judge's yes is a yes", (await R.judgeRecheckAsked(RUN, "Still up for a run club, or has that passed?", yes)).asked && calls === 1);
  check("an error, a timeout or anything but strict JSON with a boolean is not asked", !(await R.judgeRecheckAsked(RUN, "Still on?", async () => { throw new Error("timeout"); })).asked && !(await R.judgeRecheckAsked(RUN, "Still on?", async () => "yes")).asked && !(await R.judgeRecheckAsked(RUN, "Still on?", async () => '{"asked":"yes"}')).asked && R.readRecheckJudge('{"asked": true, "reason": "asks if still on"}').asked);
  const prompt = R.recheckJudgePrompt(RUN, "Want me to send the Marina running club details?");
  check("the judge sees the goal and the sent text, and is told an offer or another topic doesn't count", prompt.includes(RUN) && prompt.includes("Want me to send the Marina running club details?") && /offer/.test(prompt) && /different topic/.test(prompt) && /\{"asked": true or false, "reason": "a few words"\}/.test(prompt));
  check("the real judge is Haiku with its own usage name and a timeout", /anthropic\(MODELS\.haiku\)[\s\S]{0,120}functionId: "goal\.recheckAsked"[\s\S]{0,80}abortSignal: AbortSignal\.timeout\(RECHECK_JUDGE\.timeoutMs\)/.test(src("services/goalRecheck.ts")));
  check("the reply's hint bookkeeping (and its read) is not awaited: off the reply's path", /void import\("\.\.\/services\/goalEdges\.js"\)\.then\(\(g\) => g\.noteGoalHints\(/.test(src("agent/conversationReply.ts")));
  const { default: pool } = await import("../../src/db/db.js");
  const orig = (pool as any).query;
  const sqls: string[] = [];
  (pool as any).query = async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 1 }; };
  try {
    const ask = { ...stateRow(RUN, { lastSignalAt: ago(15) }), recheck: "ask" as const };
    await G.noteGoalHints("u1", [ask], "Want me to send the Marina running club details?", { judge: async () => JSON.stringify({ asked: false, reason: "an offer" }) });
    const offerSqls = sqls.splice(0);
    await G.noteGoalHints("u1", [ask], "Still up for a run club, or has that passed?", { judge: async () => { throw new Error("down"); } });
    const downSqls = sqls.splice(0);
    await G.noteGoalHints("u1", [ask], "Still up for a run club, or has that passed?", { judge: async () => JSON.stringify({ asked: true, reason: "asks if still on" }) });
    const yesSqls = sqls.splice(0);
    check("judged not asked (an offer): one hint used, never marked asked", offerSqls.some((q) => /hints = hints \+ 1/.test(q)) && !offerSqls.some((q) => /SET recheck_asked_at = NOW\(\)/.test(q)), offerSqls);
    check("the judge failed: a hint used, never marked asked (fails closed)", downSqls.some((q) => /hints = hints \+ 1/.test(q)) && !downSqls.some((q) => /SET recheck_asked_at = NOW\(\)/.test(q)));
    check("judged asked: marked asked (and logged)", yesSqls.some((q) => /SET recheck_asked_at = NOW\(\)/.test(q)) && yesSqls.some((q) => /INSERT INTO harness_decisions/.test(q)) && !yesSqls.some((q) => /hints = hints \+ 1/.test(q)), yesSqls);
    const nudged = await R.noteRecheckSent("u1", G.goalHash(RUN), RUN, "Thought of your Marina running club plan this morning.", "goal_nudge", async () => JSON.stringify({ asked: true, reason: "x" }));
    const nudgeAsk = await R.noteRecheckSent("u1", G.goalHash(RUN), RUN, "Still chasing a Marina running club, or has that shifted?", "goal_nudge", async () => JSON.stringify({ asked: true, reason: "x" }));
    const nudgeNo = await R.noteRecheckSent("u1", G.goalHash(RUN), RUN, "How's the Marina running club search?", "goal_nudge", async () => JSON.stringify({ asked: false, reason: "asks how it's going" }));
    check("a goal nudge or check-in counts as the recheck only when the judge reads it as asking it", !nudged && nudgeAsk && !nudgeNo);
  } finally {
    (pool as any).query = orig;
  }
  check("the goal_nudge and goal_checkin sends go through the judge", /R\.noteRecheckSent\(c\.userId, String\(c\.payload\.meta\.goalHash\)/.test(src("services/memberStateNudges.ts")) && /R\.noteRecheckSent\(c\.userId, goalHash\(String\(c\.payload\.text \?\? ""\)\)/.test(src("harness/proactiveRegistry.ts")));
}

console.log(`goal recheck: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
