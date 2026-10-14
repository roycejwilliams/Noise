// A reject that claims a closed or known record must cite THE record, one about this very find, or the find survives (Royce,
// 2026-10-14: "The picker killed a live find on a hallucinated 'closed' ... a reject claiming 'closed' or 'already known' has to cite
// the actual record or the find survives"; review: the actual record is one about THIS find). Zero tokens: the picker's verdicts are
// fixed strings, the claim check's Haiku read is a stub that answers by rule, the store is stubbed.
//   npx tsx evals/sweepSelect/rejectCites.ts
import { readFileSync } from "fs";
import {
  carryGuardedRuns,
  checkClaims,
  claimCheckPrompt,
  claimItems,
  contextIds,
  GUARDED_RECHECKS,
  guardVerdicts,
  holdDueDates,
  parseVerdicts,
  selectPrompt,
  selectSignature,
  SELECT_SYSTEM,
  UNCITED_CLAIM_GUARD,
  type ClaimJudge,
  type Judgment,
  type SelectContext,
} from "../../src/services/sweepSelect.js";
import { activeGoals, factsFromKnowledge, GOALS_CEILING, pastGoals } from "../../src/services/sweepSelectContext.js";
import { memberSafeWhy, planPicks, rejectedFindsOf, renderShadowReport, shadowKey } from "../../src/services/sweepShadow.js";
import { judgeSweepItem } from "../../src/brain/index.js";
import { goalHash } from "../../src/services/goalEdges.js";
import * as W from "../../src/services/workingSet.js";
import * as F from "../../src/services/findForm.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

// ---------------------------------------------------------------- the claim check's stub
// Stands in for the Haiku read, by rule: a record is about the find only when it names "speedrun"; a reason claims a record when it
// says closed, done, set aside, finished or already. Counts its calls and keeps its last prompt.
const judgeLog: { calls: number; prompt: string } = { calls: 0, prompt: "" };
const stubJudge = (o: { fail?: "throw" | "garbage" } = {}): ClaimJudge => async (prompt) => {
  judgeLog.calls++;
  judgeLog.prompt = prompt;
  if (o.fail === "throw") throw new Error("gateway down");
  if (o.fail === "garbage") return { text: "I think so", input: 300, output: 4 };
  const answers: { id: string; yes: boolean }[] = [];
  for (const m of prompt.matchAll(/^(R\d+): this thing: [^\n]*\n\s+the record: ([^\n]*)$/gm)) answers.push({ id: m[1], yes: /speedrun/i.test(m[2]) });
  for (const m of prompt.matchAll(/^(W\d+): "([^\n]*)"$/gm)) answers.push({ id: m[1], yes: /\b(closed|done|set aside|finished|already)\b/i.test(m[2]) });
  // Timing: over or too late only when the find's own line says so.
  for (const m of prompt.matchAll(/^(L\d+): ([^\n]*)$/gm)) answers.push({ id: m[1], yes: /closed|already over/i.test(m[2]) });
  return { text: JSON.stringify({ answers }), input: 400, output: 30 };
};

// ---------------------------------------------------------------- the fixture: his state on 2026-10-14, names invented
const TODAY = "2026-10-14";
const asOf = "2026-10-14T16:00:00Z";
const goal = (text: string, state: "active" | "done" | "stale", reason: string | null = null, o: { at?: string; source?: "context" | "member" | "co" | null } = {}) => ({ text, state, reason, told: true, onFile: true, hash: goalHash(text), source: o.source ?? null, verifiedAt: o.at ?? asOf });
// Seven unrelated active goals first and older, the accelerator and funding goals after them and newest: the old cut of 6 dropped
// exactly those (10-14).
const UNRELATED = ["Plan out the launch event and take the lead", "Seeking genuine friendships with dependable people", "use Cue to drive a guest list to test matching", "lead the partnership strategy with a launch partner", "work out whether the city-adoption problem is solvable", "draft planning docs for branding and launch strategy", "host a small launch dinner in November"];
const k: any = {
  userId: "u-jordan",
  asOf,
  identity: { firstName: "Jordan", city: "Sacramento", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: asOf },
  goals: [
    ...UNRELATED.map((t) => goal(t, "active", null, { at: "2026-10-01T16:00:00Z" })),
    goal("secure pre-seed investment funding from investors who understand consumer social products", "active", null, { at: "2026-10-12T16:00:00Z" }),
    goal("apply to South Park Commons or Blueprint II", "active", null, { at: "2026-10-12T23:30:00Z" }),
    goal("build Cue full time while pursuing funding and an accelerator to support that path", "active", null, { at: "2026-10-13T16:00:00Z" }),
    // Only replaced: hidden from the picker (#188).
    goal("get into an accelerator or residency (e.g. South Park Commons)", "stale", 'replaced by a newer goal: "apply to South Park Commons or Blueprint II"', { source: "context" }),
    goal("secure funding since the civic grant fell through", "stale", 'they said since: "that\'s no longer the plan"', { source: "context" }),
    goal("attend Tech Week in San Francisco this weekend", "stale", "its window passed (2026-10-11)", { source: "context" }),
    goal("Focus on both accelerators with open applications and ways to get in front of VCs", "done", "they closed it"),
  ],
  asks: [],
  delivered: [
    { what: "Founder Fellows by Upfront Ventures", kind: "opportunity", at: "2026-10-13T17:30:00Z", via: ["ledger"], url: null, reaction: null, verifiedAt: "2026-10-13T17:30:00Z" },
    { what: "AI Grant", kind: "opportunity", at: "2026-10-13T14:50:00Z", via: ["ledger"], url: null, reaction: null, verifiedAt: "2026-10-13T14:50:00Z" },
  ],
  carrying: [],
  lessons: [],
  corrections: [],
  preferences: [],
  claims: [],
  restraint: null,
  exchanges: [
    { from: "co", text: "AI Grant, applications open now: $250K via an uncapped SAFE. You've been weighing whether now's the right time to raise.", call: false, verifiedAt: "2026-10-13T21:50:00Z" },
    { from: "member", text: "What's the benefits? Which one do you think is best for me?", call: false, verifiedAt: "2026-10-13T23:04:00Z" },
    { from: "member", text: "Anything I should look forward to this week?", call: false, verifiedAt: "2026-10-13T23:06:00Z" },
  ],
  person: null,
  limits: null,
};
const facts = factsFromKnowledge(k);
const RESIDENCY = { id: "C1", key: "a16z speedrun sr008 residency|2026-11-01", name: "a16z Speedrun SR008 Residency", date: "2026-11-01", tier: 3, kind: "discovery" as const, asks: [] as string[], details: "12-week residency for early founders; applications close Nov 1" };
const ctx: SelectContext = {
  ...facts,
  today: TODAY,
  weekday: "Wednesday",
  asks: [
    { id: "A1", text: "Seeking guidance on how to think about getting their first paying customer", since: "2026-09-28" },
    // The one-off question that was answered: closed, and about accelerators in general, not this residency.
    { id: "A2", text: "find me a couple of accelerators with open applications", since: "2026-10-01", closed: true },
  ],
  sent: [
    { id: "S1", at: "Oct 12", what: "event_offer: Found one: a16z Speedrun SR008 Residency, applications open to Nov 1", reaction: null },
    { id: "S2", at: "Oct 13", what: "event_offer: Found one: Founder Fellows by Upfront Ventures", reaction: null },
  ],
  outcomes: [
    { id: "O1", at: "Oct 6", item: "Compute Trading Happy Hour", result: "declined", note: null, closes: true },
    { id: "O2", at: "Oct 8", item: "a16z Speedrun SR008 Residency", result: "interested", note: null, closes: false },
    { id: "O3", at: "Oct 9", item: "a16z Speedrun SR008 Residency", result: "declined", note: null, closes: true },
  ],
  discoveryLeft: 0,
  pool: [RESIDENCY],
};
const gid = (prefix: string) => (ctx.goalsPast ?? []).find((g) => g.text.startsWith(prefix))?.id;
const SETASIDE_G = gid("secure funding since")!;
const LAPSED_G = gid("attend Tech Week")!;
const DONE_G = gid("Focus on both accelerators")!;
// The same member, plus their text that they already applied to this very residency.
const withApplied: SelectContext = { ...ctx, texts: [...ctx.texts, { id: "T9", at: "Oct 13 18:00", from: "member", text: "Already applied to Speedrun last week, waiting to hear back." }] };

// What the stubbed store looks like: the residency waiting in the profile backlog, and a pending queue row for it.
const residencyMatch = { tier: 3, kind: "opportunity", source: "web", name: RESIDENCY.name, url: "https://speedrun.a16z.com/", deadline: "2026-11-01" };
function world() {
  const facts: any[] = [];
  const store = new Map<string, any[]>([["profile", [{ askText: "look for: consumer AI pre-seed open calls", match: residencyMatch }]]]);
  const deps: any = {
    backlogs: async () => [...store.entries()].map(([ask_id, items]) => ({ ask_id, items })),
    merge: async (_u: string, askId: string, change: any) => { store.set(askId, W.applyChange(store.get(askId) ?? [], change, deps.key)); },
    key: (m: any) => F.exitKey(m),
    writeFact: async (e: any) => { facts.push(e); },
  };
  const backlog = [...store.entries()].flatMap(([askId, items]) => items.map((it) => ({ askId, askText: it.askText, fromProfile: askId === "profile", match: it.match })));
  return { deps, facts, store, backlog };
}
// One run end to end, as selectForMember and applyPicksInner do it: the guard, the claim check, the queue plan, the exits.
async function runOnce(raw: string, c: SelectContext = ctx, judge: ClaimJudge = stubJudge()) {
  const before = judgeLog.calls;
  const checked = await checkClaims(c, guardVerdicts(c, parseVerdicts(raw) ?? []), judge);
  const judgments = checked.judgments;
  const w = world();
  const waiting = [{ id: "row-1", key: shadowKey(RESIDENCY.name, RESIDENCY.date) }];
  const ids = contextIds(c);
  const plan = planPicks(judgments, w.backlog as any, waiting, ids);
  const exited = await W.exitRejectedFinds("u-jordan", rejectedFindsOf(judgments, w.backlog as any, ids), w.deps);
  const j = judgments.find((x) => x.id === "C1")!;
  return { j, judgments, plan, exited, facts: w.facts, left: w.store.get("profile") ?? [], calls: judgeLog.calls - before, check: checked.check };
}
const reject = (reason: string, cites?: string[], why = "it's for a goal that's closed", id = "C1") => JSON.stringify({ verdicts: [{ id, verdict: "reject", reason, ...(cites ? { cites } : {}), why }] });
const kept = (r: { j: Judgment; exited: number }) => r.j.verdict === "reject" && r.exited === 1;
const held = (r: { j: Judgment; exited: number; left: any[] }) => r.j.verdict === "hold" && r.j.reason === "uncited_claim" && r.exited === 0 && r.left.length === 1;
// A fit-only reject (since one find per tier, 2026-10-14): a hold that stays in the backlog, never an exit.
const waits = (r: { j: Judgment; exited: number; left: any[] }) => r.j.verdict === "hold" && r.j.reason === "fit_only" && r.exited === 0 && r.left.length === 1;

// ---------------------------------------------------------------- the fixture reads as his state did
check("fixture: the replaced accelerator goal isn't listed (#188); set aside in their words, lapsed and done are", !(ctx.goalsPast ?? []).some((g) => g.text.startsWith("get into an accelerator")) && ctx.goalsPast!.find((g) => g.id === SETASIDE_G)!.state === "set_aside" && ctx.goalsPast!.find((g) => g.id === LAPSED_G)!.state === "lapsed" && ctx.goalsPast!.find((g) => g.id === DONE_G)!.state === "done", ctx.goalsPast);
check("every active goal is the lens, newest first: the accelerator goals beyond position 6 are in, at the top", ctx.goals!.length === 10 && ctx.goals![0].startsWith("build Cue full time") && ctx.goals![1] === "apply to South Park Commons or Blueprint II" && ctx.goals!.slice(3).every((g) => UNRELATED.includes(g)), ctx.goals);

// ---------------------------------------------------------------- 1. today's exact verdict
{
  const TODAYS = '{"verdicts":[{"id":"C1","verdict":"reject","reason":"already_known","why":"Accelerator/funding search was explicitly marked done and funding-seeking was set aside; this is the same kind of opportunity against a closed goal, not something on his current asks or lens."}]}';
  const r = await runOnce(TODAYS);
  check("today's verdict (already_known, no cites) ends as a hold, not a reject", r.j.verdict === "hold" && r.j.reason === "uncited_claim" && r.j.claimed === "already_known", r.j);
  check("it is logged with the guard and keeps the model's why for the team", r.j.guard?.startsWith(UNCITED_CLAIM_GUARD) === true && /no record cited/.test(r.j.guard) && /explicitly marked done/.test(r.j.why), r.j);
  check("no exit fact is written and the find stays in the backlog", held(r) && r.facts.length === 0 && r.left[0].match.name === RESIDENCY.name, { exited: r.exited, facts: r.facts, left: r.left });
  check("it takes no send slot today: the queue plan doesn't queue or drop it; its queued row goes back to waiting", r.plan.queue.length === 0 && r.plan.reject.length === 0 && r.plan.unqueue.map((u) => u.id).join() === "row-1", r.plan);
  check("the brain reads it as a wait, never a drop", (() => { const d = judgeSweepItem(r.j as any); return d.kind === "wait" && d.drop === false && d.leave === false; })());
  check("it comes due the next day, so tomorrow's run judges it again", holdDueDates([r.j], TODAY).join() === "2026-10-15" && r.j.until === "2026-10-15");
  check("a structural miss needs no read: the claim check isn't called", r.calls === 0 && r.check.read === "none");
}

// ---------------------------------------------------------------- 2. cites must be about THIS find
{
  // Records code checks by name (the shadow pool's own match).
  const sent = await runOnce(reject("already_known", ["S1"], "Cue already sent this exact residency on Oct 12"));
  check("already_known citing an S# that names this residency stays a reject and exits, with no read needed", kept(sent) && sent.facts.length === 1 && sent.left.length === 0 && sent.plan.reject.map((x) => x.id).join() === "row-1" && sent.calls === 0, sent.j);
  const otherSend = await runOnce(reject("already_known", ["S2"], "Cue already sent a fellowship"));
  check("an S# about a different program holds it", held(otherSend) && /none of its cites is a closed or known record about this find \(S2\)/.test(otherSend.j.guard ?? ""), otherSend.j);
  const otherDelivered = await runOnce(reject("already_known", ["D1"]));
  check("a D# about a different program holds it", held(otherDelivered));
  const declinedThis = await runOnce(reject("already_known", ["O3"]));
  const declinedOther = await runOnce(reject("already_known", ["O1"]));
  const interestedThis = await runOnce(reject("already_known", ["O2"]));
  check("an O# carries it only when they declined (or did) THIS thing", kept(declinedThis) && held(declinedOther) && held(interestedThis));
  // Records only a read can tie to the find.
  const closedAsk = await runOnce(reject("closed", ["A2"], "the accelerator list they asked for is done"));
  check("closed citing the closed 'find me a couple of accelerators' ask holds (a closed ask about accelerators in general, not this one)", held(closedAsk) && /no cited record is about this find \(A2\)/.test(closedAsk.j.guard ?? "") && closedAsk.calls === 1, closedAsk.j);
  const setAside = await runOnce(reject("closed", [SETASIDE_G], "rests on the funding goal they set aside"));
  check("closed citing a goal they set aside holds when the goal isn't about this residency", held(setAside), setAside.j);
  const done = await runOnce(reject("closed", [DONE_G], "the accelerator goal is done"));
  check("closed citing the done 'focus on accelerators' goal holds: a finished goal of the same kind isn't this find", held(done), done.j);
  const lapsed = await runOnce(reject("closed", [LAPSED_G]));
  check("a lapsed goal (its window passed: Cue's bookkeeping) carries nothing, and needs no read", held(lapsed) && lapsed.calls === 0 && /none of its cites/.test(lapsed.j.guard ?? ""), lapsed.j);
  const applied = await runOnce(reject("already_known", ["T9"], "they already applied to Speedrun"), withApplied);
  check("already_known citing their own text 'already applied to Speedrun' stays a reject (the read ties it to this find)", kept(applied) && applied.calls === 1, applied.j);
  const coText = await runOnce(reject("already_known", ["T1"]));
  check("Cue's own text never carries it (only theirs does)", held(coText) && coText.calls === 0);
  const ghost = await runOnce(reject("closed", ["A9"]));
  check("a cite to a nonexistent id holds", held(ghost) && /isn't there \(A9\)/.test(ghost.j.guard ?? ""));
  const replacedOld = await runOnce(reject("closed", ["G9"], "the accelerator goal was replaced"));
  check("a replaced goal isn't listed, so a cite to it is a nonexistent id and holds", held(replacedOld));
  const ghostWithReal = await runOnce(reject("already_known", ["G42", "S1"]));
  check("one nonexistent cite beside a real one still holds it (every cite must exist)", held(ghostWithReal));
  // The read fails toward the find.
  const thrown = await runOnce(reject("already_known", ["T9"], "they already applied to Speedrun"), withApplied, stubJudge({ fail: "throw" }));
  const garbage = await runOnce(reject("already_known", ["T9"], "they already applied to Speedrun"), withApplied, stubJudge({ fail: "garbage" }));
  check("a claim check that throws, or answers what can't be read, holds the find (flagged, never exited) and says why", held(thrown) && held(garbage) && thrown.j.checkFailed === true && /the claim check couldn't run \(gateway down\)/.test(thrown.j.guard ?? "") && garbage.check.read === "failed" && garbage.check.heldIds?.join() === "C1", { thrown: thrown.j, garbage: garbage.check });
}

// ---------------------------------------------------------------- 3. judgment rejects, and a why that claims a record
{
  // Since one find per tier (2026-10-14): a judgment reject never takes a find out; it waits in the backlog with the picker's why.
  for (const code of ["not_them", "weak_fit", "too_late", "other"]) {
    const r = await runOnce(reject(code, undefined, "not the room they want"));
    check(`${code} without a verified reason waits in the backlog (a fit-only hold, never an exit)`, waits(r) && r.calls === 1 && r.j.claimed === code && /not the room they want/.test(r.j.why), r.j);
  }
  const prose = await runOnce(reject("weak_fit", undefined, "the goal behind it is closed and funding was set aside"));
  check("a weak_fit whose why claims something closed is a record claim: no cite, so it holds, its why kept", held(prose) && /its why claims something finished or known; no record cited/.test(prose.j.guard ?? "") && /funding was set aside/.test(prose.j.why), prose.j);
  const proseCited = await runOnce(reject("other", ["T9"], "they already applied to Speedrun"), withApplied);
  check("an other whose why claims a record and cites one about this find stays a reject (verified)", kept(proseCited) && proseCited.calls === 1 && proseCited.j.verified === true);
  const proseFact = await runOnce(reject("weak_fit", ["S1"], "already sent it"));
  check("a weak_fit claiming a record with a cite code can tie to the find stays a reject", kept(proseFact));
  const unreadWhy = await runOnce(reject("weak_fit", undefined, "not their scene"), ctx, stubJudge({ fail: "throw" }));
  check("when the claim check can't run at all, a judgment reject is held too (flagged), never exited", held(unreadWhy) && unreadWhy.j.checkFailed === true, unreadWhy.j);
  // Several rejects: one read for the whole run.
  const two: SelectContext = { ...withApplied, pool: [RESIDENCY, { id: "C2", key: "pitch night|2026-10-20", name: "Pitch Night", date: "2026-10-20", tier: 2, kind: "discovery", asks: [] }] };
  const before = judgeLog.calls;
  const both = await checkClaims(two, guardVerdicts(two, parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "reject", reason: "closed", cites: ["A2", "T9"], why: "applied already" }, { id: "C2", verdict: "reject", reason: "weak_fit", why: "a pitch night isn't their scene" }] }))!), stubJudge());
  check("one claim check per run, batching every reject that needs a read", judgeLog.calls - before === 1 && both.check.items === 3 && both.judgments[0].verdict === "reject" && both.judgments[1].reason === "fit_only", both);
}

// ---------------------------------------------------------------- 4. covered must name a candidate still in the running
{
  const pool2 = [RESIDENCY, { id: "C2", key: "spc winter|2026-11-15", name: "South Park Commons Winter Founder Fellowship", date: "2026-11-15", tier: 3, kind: "discovery" as const, asks: [] }];
  const c2: SelectContext = { ...ctx, pool: pool2 };
  const sendC2 = { id: "C2", verdict: "send", whyMember: "they're applying to SPC", cites: ["T2"], whyNow: "opens now", wow: true, lastDay: "2026-11-15" };
  const run = async (cov: any, other: any) => (await checkClaims(c2, guardVerdicts(c2, parseVerdicts(JSON.stringify({ verdicts: [cov, other] }))!), stubJudge())).judgments.find((j) => j.id === "C1")!;
  const ok = await run({ id: "C1", verdict: "reject", reason: "covered", cites: ["C2"], why: "the SPC fellowship does the same job better" }, sendC2);
  check("covered citing a candidate going out today: a fit-only hold that waits (covered is judgment, never an exit)", ok.verdict === "hold" && ok.reason === "fit_only" && ok.claimed === "covered", ok);
  const noCite = await run({ id: "C1", verdict: "reject", reason: "covered", why: "another one is better" }, sendC2);
  const rejectedOther = await run({ id: "C1", verdict: "reject", reason: "covered", cites: ["C2"], why: "C2 is better" }, { id: "C2", verdict: "reject", reason: "weak_fit", why: "not their scene" });
  const self = await run({ id: "C1", verdict: "reject", reason: "covered", cites: ["C1"], why: "itself" }, sendC2);
  const outside = await run({ id: "C1", verdict: "reject", reason: "covered", cites: ["C7"], why: "C7 is better" }, sendC2);
  check("covered with no candidate cited, one that's rejected, itself, or one not in the pool holds", [noCite, rejectedOther, self, outside].every((j) => j.verdict === "hold" && j.claimed === "covered" && /covered names no candidate in today's pool still in the running/.test(j.guard ?? "")), [noCite, rejectedOther, self, outside]);
  const heldOther = await run({ id: "C1", verdict: "reject", reason: "covered", cites: ["C2"], why: "C2 is better" }, { id: "C2", verdict: "hold", why: "opens Nov 1", until: "2026-11-01" });
  check("covered citing a held candidate passes the cite check (still in the running) and waits as a fit-only hold", heldOther.verdict === "hold" && heldOther.reason === "fit_only");
}

// ---------------------------------------------------------------- 5. a guarded hold is judged again, and can't loop forever (across days)
{
  // The days as runSweepShadow lives them: same pool, asks and texts every day; a day runs only when its signature changed from the
  // last recorded run; the picker repeats the same uncited claim each time it runs.
  const TODAYS = reject("already_known");
  // days: how many days from TODAY; changeOn: the day index a new text from them arrives (it stays on file after). A far-dated find
  // (Dec 31) so its date never ends the loop (the reviewer's case).
  const simulate = (days: number, changeOn: number | null = null) => {
    let last: { day: string; signature: string; judgments: Judgment[] } | null = null;
    const ran: string[] = [];
    for (let d = 0; d < days; d++) {
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
      const texts = changeOn !== null && d >= changeOn ? [...ctx.texts, { id: "T4", at: "Oct 24 09:00", from: "member" as const, text: "any residencies?" }] : ctx.texts;
      const c = { ...ctx, today: day, texts, pool: [{ ...RESIDENCY, date: "2026-12-31", key: "a16z speedrun sr008 residency|2026-12-31" }] };
      const signature = selectSignature(c, last ? holdDueDates(last.judgments, last.day) : []);
      if (last && last.signature === signature) continue;
      const judgments = carryGuardedRuns(guardVerdicts(c, parseVerdicts(TODAYS)!), last?.judgments ?? []);
      ran.push(`${day}:${judgments[0].verdict}/${judgments[0].guardedRuns}`);
      last = { day, signature, judgments };
    }
    return { ran, last: last! };
  };
  const quietRun = simulate(20);
  check(`a guarded hold buys ${GUARDED_RECHECKS} runs of its own on the next days and one more as it leaves what's due, then waits (never exits)`, quietRun.ran.length === GUARDED_RECHECKS + 2 && quietRun.ran.every((r) => /:hold\//.test(r)), quietRun.ran);
  // One change after the cap (a text from them on day 10): exactly one run for it, then quiet again. A due date pinned to the run's own
  // day re-armed a run every day from here (review of the picker guard).
  const changed = simulate(20, 10);
  const afterChange = changed.ran.filter((r) => r >= "2026-10-24");
  check("one change after the cap buys exactly one run, then the runs stop again", afterChange.length === 1 && afterChange[0].startsWith("2026-10-24:hold/") && changed.ran.length === GUARDED_RECHECKS + 3, changed.ran);
  const last = quietRun.last;
  // The next run's own verdict decides: a send is a send.
  const fresh = guardVerdicts({ ...ctx, today: "2026-10-15" }, parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "send", whyMember: "they're applying to South Park Commons or Blueprint II", cites: ["T2"], whyNow: "applications close Nov 1", wow: true, lastDay: "2026-11-01" }] }))!);
  check("the next run's own verdict decides: a send is a send", fresh[0].verdict === "send");
  const broken = carryGuardedRuns(guardVerdicts(ctx, parseVerdicts(TODAYS)!), [{ ...last.judgments[0], key: "something else" }]);
  check("the count is per find and resets when the run in between judged it otherwise", broken[0].guardedRuns === 1);
  check("an ordinary hold's timing is unchanged", holdDueDates([{ verdict: "hold", until: null }], TODAY).join() === "2026-10-16");
}

// ---------------------------------------------------------------- 6. sends never rest on a past goal
{
  const send = (cites: string[]) => guardVerdicts(ctx, parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "send", whyMember: "fits", cites, whyNow: "closes Nov 1", wow: true, lastDay: "2026-11-01" }] }))!)[0];
  check("a send citing only a past goal (done or set aside) is refused: a past goal is never theirs for a send", send([DONE_G]).guard === "cites nothing they said or asked" && send([SETASIDE_G, DONE_G]).verdict === "reject" && send([DONE_G, "T2"]).verdict === "send");
}

// ---------------------------------------------------------------- past goals and the lens
{
  const g = pastGoals([
    { text: "A", state: "stale", reason: 'replaced by a newer goal: "B"', source: "context" },
    { text: "B", state: "active", reason: null },
    { text: "C", state: "stale", reason: "its window passed (2026-10-01)", source: "context" },
    { text: "D", state: "stale", reason: "no answer to the recheck", source: "context" },
    { text: "E", state: "stale", reason: 'they said since: "dropping it"', source: "context" },
    { text: "F", state: "stale", reason: "not the focus anymore", source: "member" },
    { text: "H", state: "stale", reason: "marked set_aside", source: null },
    { text: "I", state: "done", reason: "they closed it", source: null },
  ]);
  const by = (t: string) => g.find((x) => x.text === t);
  check("a replaced goal isn't listed; active goals aren't past goals; ids run G1..", !by("A") && !by("B") && g.map((x) => x.id).join() === "G1,G2,G3,G4,G5,G6");
  check("a window that passed, a recheck with no answer, or a state nobody is said to have set is lapsed (Cue's bookkeeping)", by("C")!.state === "lapsed" && by("D")!.state === "lapsed" && by("H")!.state === "lapsed");
  check("their own word sets a goal aside; done is done", by("E")!.state === "set_aside" && by("F")!.state === "set_aside" && by("I")!.state === "done");
  const many = Array.from({ length: GOALS_CEILING + 4 }, (_, i) => ({ text: `goal ${i}`, state: "active" as const, verifiedAt: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000).toISOString() }));
  const lens = activeGoals(many);
  check(`the lens takes every active goal newest first, up to a ceiling of ${GOALS_CEILING}, and says how many it left out`, lens.goals.length === GOALS_CEILING && lens.goals[0] === `goal ${GOALS_CEILING + 3}` && lens.trimmed === 4 && activeGoals(many.slice(0, 12)).trimmed === 0);
  const trimmed = factsFromKnowledge({ ...k, goals: many.map((x) => ({ ...x, reason: null, told: true, onFile: true, hash: goalHash(x.text) })) });
  check("a trimmed lens is reported on the context (logged with the run), never silent", trimmed.goalsTrimmed === 4);
}

// ---------------------------------------------------------------- the prompts and the readers
{
  const p = selectPrompt(ctx);
  check("the picker sees every active goal, the accelerator ones included", /the LENS[^\n]*\n(- [^\n]*\n){10}/.test(p) && /- apply to South Park Commons or Blueprint II/.test(p));
  check("the prompt lists past goals with ids and why each is past; lapsed ones as Cue's bookkeeping; no replaced ones", new RegExp(`${SETASIDE_G} secure funding since the civic grant fell through \\(set aside\\)`).test(p) && new RegExp(`${LAPSED_G} attend Tech Week in San Francisco this weekend \\(lapsed: its window passed \\(2026-10-11\\); Cue's bookkeeping, not their word\\)`).test(p) && !/get into an accelerator/.test(p), p.slice(p.indexOf("Past goals"), p.indexOf("Past goals") + 600));
  check("the prompt lists what they already have with D# ids", /\nD1 Founder Fellows by Upfront Ventures \(opportunity, Oct 13\)/.test(p));
  check("the instructions name the record codes, the cites rule and that the record must be about this candidate", /closed \(it rests on something finished/.test(SELECT_SYSTEM) && /already_known \(they mentioned it, are going, already have it, or said no\)/.test(SELECT_SYSTEM) && /cites that record by id in "cites"/.test(SELECT_SYSTEM) && /The record has to be about this candidate itself/.test(SELECT_SYSTEM) && /A closed ask or a finished goal about a different program doesn't close this one/.test(SELECT_SYSTEM));
  check("the instructions: covered cites its C#, lapsed goals are bookkeeping, a closed one-off question doesn't close a live aim", /covered \(another candidate in today's pool does the same job better; cite its C# in "cites"\)/.test(SELECT_SYSTEM) && /lapsed is Cue's own bookkeeping/.test(SELECT_SYSTEM) && /doesn't close an aim one of their active goals still carries/.test(SELECT_SYSTEM) && !/replaced by a newer goal isn't/.test(SELECT_SYSTEM));
  check("the instructions don't change per member (so they cache)", !SELECT_SYSTEM.includes("Jordan"));
  // The claim check's prompt: every active goal, the find, the record, and the two questions.
  const verdicts = guardVerdicts(withApplied, parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "reject", reason: "closed", cites: ["A2"], why: "x" }] }))!);
  const items = claimItems(withApplied, verdicts);
  const cp = claimCheckPrompt(withApplied, items);
  check("the claim check reads every active goal (the ones past position 6 too), the find with its line, and the cited record", items.length === 1 && ctx.goals!.every((g) => cp.includes(`- ${g}`)) && /R1: this thing: a16z Speedrun SR008 Residency \(2026-11-01\): 12-week residency/.test(cp) && /the record: an ask of theirs, now closed, A2: "find me a couple of accelerators/.test(cp) && /A finished or closed record about a different program, ask or goal does not count, even if it is the same kind\./.test(cp), cp);
  // Member-safe: only the run's own ids are stripped.
  const ids = contextIds(ctx);
  check("G# and D# ids of the run never reach a member's text", memberSafeWhy(`rests on ${SETASIDE_G} and D2, which closed (${DONE_G}, D1)`, ids) === "rests on, which closed");
  check("an id-like word that isn't one of the run's ids stays (the G20 Summit, D1 athletes when there's no D3)", memberSafeWhy("like the G20 Summit for D3 athletes", ids) === "like the G20 Summit for D3 athletes" && memberSafeWhy("the G20 Summit (A1)", ids) === "the G20 Summit");
  check("without the run's ids, the old pattern stands (A/T/S/O/C only)", memberSafeWhy("they asked (A8, T2)") === "they asked" && memberSafeWhy("G20 Summit") === "G20 Summit");
  check("made-up A/T/S/O/C ids are stripped too, whether or not the run had them", !/\b[ATSOC]\d/.test(memberSafeWhy("hallucinated (A9) and T45 and C7", ids)) && memberSafeWhy("hallucinated (A9) and T45 and C7", ids).startsWith("hallucinated") && !/\b[ATSOC]\d/.test(memberSafeWhy("it rests on S99 and O7", ids)));
  check("a G# or D# the run had is stripped even beside a word (D1 athletes loses its D1; accepted)", memberSafeWhy("for D1 athletes", ids) === "for athletes");
  const guarded = guardVerdicts(ctx, parseVerdicts(reject("already_known", ["A9"], "funding was set aside"))!)[0];
  const rep = renderShadowReport([{ name: "Jordan", day: TODAY, skipped: null, oldQueued: [], oldTexted: [], pool: [{ id: "C1", name: RESIDENCY.name, date: RESIDENCY.date }], judgments: [guarded] }]);
  check("the internal report shows a guarded hold with what Cue claimed, its cites, its why and the guard", /~ a16z Speedrun SR008 Residency until 2026-10-15: Cue said reject \[already_known: A9\]: funding was set aside \(reject claimed a closed or known record/.test(rep), rep);
}

// ---------------------------------------------------------------- pins
{
  const src = readFileSync(new URL("../../src/services/sweepSelect.ts", import.meta.url), "utf8");
  const g = src.slice(src.indexOf("export function guardVerdicts"));
  check("pin: guardVerdicts checks a record-claim reject's cites and holds it when they fail", /RECORD_CLAIMS\.includes\(v\.reason\) \? checkCites\(c, p, v\.cites, known, v\.reason\) : null/.test(g) && /if \(bad\) out\.push\(\{ \.\.\.base, verdict: "hold", reason: "uncited_claim"/.test(g));
  check("pin: the picker run guards, then runs the claim check, before anything is applied", /const checked = await checkClaims\(c, guardVerdicts\(c, verdicts\), opts\.judge\);/.test(src));
  check("pin: the record codes are in RECORD_CLAIMS (closed, already_known, and ruled_out since one-per-tier)", /export const RECORD_CLAIMS: readonly RejectReason\[\] = \["closed", "already_known", "ruled_out"\];/.test(src));
  check("pin: the claim check is Haiku, one call", /export const CLAIM_CHECK_MODEL = MODELS\.haiku;/.test(src) && (src.match(/await judge\(/g) ?? []).length === 1);
  const sh = readFileSync(new URL("../../src/services/sweepShadow.ts", import.meta.url), "utf8");
  check("pin: the run counts guarded holds against the last run before recording, and applies with the run's ids", /r\.judgments = carryGuardedRuns\(r\.judgments, \(last\?\.proposal\?\.judgments \?\? \[\]\) as Judgment\[\], \{ morning: !!opts\.morning, day: today \}\);/.test(sh) && sh.indexOf("carryGuardedRuns(r.judgments") < sh.indexOf("applyPicks(userId, r.judgments") && /applyPicks\(userId, r\.judgments, backlogs, today, r\.set \?\? null, applied, contextIds\(ctx\), \{ protect \}\)/.test(sh) && /claimCheck: r\.claimCheck \?\? null/.test(sh));
  const cx = readFileSync(new URL("../../src/services/sweepSelectContext.ts", import.meta.url), "utf8");
  check("pin: no 6-goal cut left in the picker's context", !/slice\(0, 6\)/.test(cx));
}

console.log(`picker reject cites: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
