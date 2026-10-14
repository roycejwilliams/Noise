// The tier PR's review fixes and Royce's rulings on the morning send (2026-10-14). Zero tokens: the picker's verdicts are fixed strings,
// the claim check and the composer are stubs that answer by rule, the store is stubbed.
//   npx tsx evals/sweepSelect/morningReview.ts
import { readFileSync } from "fs";
import { carryGuardedRuns, checkClaims, FIT_ONLY_MORNINGS, guardVerdicts, heldBackFor, memberWhyOf, parseVerdicts, SELECT_LIMITS, selectPrompt, tierPicks, type ClaimJudge, type Judgment, type PoolItem, type SelectContext } from "../../src/services/sweepSelect.js";
import * as SH from "../../src/services/sweepShadow.js";
import * as P from "../../src/harness/proactive.js";
import * as B from "../../src/harness/bundleComposer.js";
import * as E from "../../src/agent/eventDiscoverySurfacing.js";
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
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const TODAY = "2026-10-15";
const item = (id: string, name: string, tier: number, o: Partial<PoolItem> = {}): PoolItem => ({ id, key: SH.shadowKey(name, o.date ?? null), name, date: null, tier, kind: "discovery", asks: [], ...o });
const base = (pool: PoolItem[], o: Partial<SelectContext> = {}): SelectContext => ({
  firstName: "Marcus", city: "Berkeley", today: TODAY, weekday: "Thursday",
  asks: [{ id: "A1", text: "seeking help drafting a pleading for dismissal for their client's case", since: "2026-10-12" }],
  texts: [
    { id: "T1", at: "Oct 12 21:33", from: "member", text: "Job applications, I'm a third year law student applying to law firms. I also am a student attorney with a client who has a hearing on Friday in criminal court" },
    { id: "T2", at: "Oct 13 18:00", from: "member", text: "Already applied to Speedrun last week, waiting to hear back." },
  ],
  sent: [], outcomes: [], feeling: null, discoveryLeft: 4, pool, morning: true, ...o,
});
const answerAll = (yes: (kind: string, line: string) => boolean): ClaimJudge => async (prompt) => {
  const answers: { id: string; yes: boolean }[] = [];
  for (const m of prompt.matchAll(/^([RUWL]\d+): ([^\n]*(?:\n\s+the record: [^\n]*)?)$/gm)) answers.push({ id: m[1], yes: yes(m[1][0], m[2]) });
  return { text: JSON.stringify({ answers }), input: 200, output: 20 };
};
const timeout: ClaimJudge = async () => { throw new Error("The operation was aborted due to timeout"); };
const run = async (c: SelectContext, verdicts: unknown[], judge: ClaimJudge) => {
  const checked = await checkClaims(c, guardVerdicts(c, parseVerdicts(JSON.stringify({ verdicts }))!), judge);
  return { js: c.morning ? tierPicks(c, checked.judgments) : checked.judgments, check: checked.check };
};
const sends = (js: Judgment[]) => js.filter((j) => j.verdict === "send").map((j) => j.id).sort().join(",");

// ---------------------------------------------------------------- Royce 1: a failed claim check never leads to a send
{
  // Golden 39's member: they already applied to Speedrun; the picker rejects it citing their text; the claim check times out.
  const pool = [item("C1", "a16z Speedrun Residency (SR008)", 3, { date: "2026-11-01" }), item("C2", "On Deck Climate Fellowship", 3)];
  // C2 the picker held (it needed no check); C1's check is the one that can't run. With the check down, every claim it would have read
  // is held: only a find that needed no check can go.
  const r = await run(base(pool), [{ id: "C1", verdict: "reject", reason: "already_known", cites: ["T2"], why: "they already applied", rank: 1 }, { id: "C2", verdict: "hold", why: "opens later", until: null, rank: 2, forThem: "a part-time fellowship for climate operators" }], timeout);
  const c1 = r.js.find((j) => j.id === "C1")!;
  check("the check times out: the find is held for the morning (not sent, not exited), flagged", c1.verdict === "hold" && c1.checkFailed === true && heldBackFor(c1) !== null && r.check.read === "failed" && /timeout/.test(r.check.error ?? ""), c1);
  check("and the next best in its tier goes instead, with its forThem line", sends(r.js) === "C2" && r.js.find((j) => j.id === "C2")!.why === "a part-time fellowship for climate operators", r.js.map((j) => `${j.id}:${j.verdict}/${j.reason}`));
  check("the run carries what the alarm needs: the error and the finds it held", r.check.heldIds?.includes("C1") === true);
  const backlog = pool.map((p) => ({ askId: "profile", askText: "x", fromProfile: true, match: { name: p.name, ...(p.date ? { event_date: p.date } : {}) } }));
  check("it writes no exit fact (it isn't a reject)", SH.rejectedFindsOf(r.js, backlog as any).length === 0);
  const runs = carryGuardedRuns(r.js, []);
  check("it's judged again next run, under the guarded-hold bound (counted like any guarded hold)", runs.find((j) => j.id === "C1")!.guardedRuns === 1);
  const sh = src("services/sweepShadow.ts");
  check("the alarm: picker.claim_check_failed with the member, the finds and the error; counted hourly by the monitor; never an email", /decision: "picker\.claim_check_failed", userId, outcome: "skip", action: "held", reason: r\.claimCheck\.error/.test(sh) && /key: "picker_claim_check_failed"/.test(src("harness/monitor.ts")) && !/sendTeamEmail|alertTeamNow|sendReportEmail/.test(sh.slice(sh.indexOf("A claim check that couldn't run is an alarm"), sh.indexOf("A claim check that couldn't run is an alarm") + 800)));
  check("the team list shows the day's count of claim checks that couldn't run", /picker claim checks that couldn't run: \$\{fails\}/.test(src("services/dailySweep.ts")));
}

// ---------------------------------------------------------------- 2. the member's why, and the composer never drops a tier pick for fit
{
  // The 10-14 law workshop: the picker said weak_fit ("doesn't match his practice area"); it goes as tier 3's pick.
  const pool = [item("C1", "BCLT Transactional Law Skills Workshop with Freshfields", 3, { date: "2026-10-21", details: "a skills workshop for law students with Freshfields lawyers" })];
  const r = await run(base(pool), [{ id: "C1", verdict: "reject", reason: "weak_fit", why: "transactional law doesn't match his criminal-law practice area" }], answerAll(() => false));
  const c1 = r.js[0];
  check("the law workshop goes as its tier's pick, and its member why is never the reject's reason (empty: its own details speak)", c1.verdict === "send" && c1.reason === "tier_pick" && c1.why === "" && /practice area/.test(c1.notSentWhy ?? ""), c1);
  check("memberWhyOf: a send's own why; a tier pick's forThem; never a reject's or a hold's reason", memberWhyOf({ verdict: "send", why: "they asked", reason: "clears_bar" }) === "they asked" && memberWhyOf({ verdict: "hold", why: "only loosely related", forThem: "a hike crew", reason: "fit_only" }) === "a hike crew" && memberWhyOf({ verdict: "reject", why: "not their scene", reason: "weak_fit" }) === "");
  // The composer: a tier pick is told it goes when skipped; only a second skip drops it (and flags it for the tier's next best).
  const m = (name: string, url: string) => ({ tier: 3, kind: "opportunity", name, url, deadline: "2026-11-01", whyItFits: "" }) as any;
  const cand = (id: string, match: any) => ({ id, userId: "u", type: "event_offer", targetKey: `event_offer:${id}`, topicKey: id, summary: "", priority: 50, dueAt: new Date(), expiresAt: null, payload: { askId: "profile", askText: "x", fromProfile: true, match, picked: true, morningDay: TODAY, pick: { whyMember: "", whyNow: "", set: null, tierPick: true } }, attempts: 0, createdAt: new Date() }) as any;
  const f1 = m("Co Supper", "https://lu.ma/supper"), f2 = m("BCLT Workshop", "https://law.berkeley.edu/bclt");
  const items = [{ candidate: cand("c1", f1), item: E.revealItem("x", false, f1), pick: null, again: false, tierPick: true }, { candidate: cand("c2", f2), item: E.revealItem("x", false, f2), pick: null, again: false, tierPick: true }];
  const input = { firstName: "Marcus", items, set: null, leadWhy: null, memberBlock: null, feeling: null, thread: "", recent: "", threadLive: false };
  const skip2 = { opening: "Two things for this week.", items: [{ n: 1, caption: "Co Supper, a small table of people building things." }, { n: 2, skip: "transactional law isn't his practice area" }], closing: "Either one?" };
  const ok = { opening: "Two things for this week.", items: [{ n: 1, caption: "Co Supper, a small table of people building things." }, { n: 2, caption: "BCLT Workshop with Freshfields lawyers, a skills day for law students." }], closing: "Either one?" };
  const prompts: string[] = [];
  const stub = (answers: any[]) => ({ model: async (p: string) => { prompts.push(p); return JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)]); } });
  const once: any = await B.composeBundle(input as any, stub([skip2, ok]));
  check("the composer skips a tier pick for fit once: it's told the pick goes, and it's written", "messages" in once && once.dropped.length === 0 && /thing 2 is the best of its kind for them this morning: it goes, never skipped for fit/.test(prompts[1]) && /the best of its kind for them this morning: it goes; never skip it for fit/.test(prompts[0]), { once, p: prompts[1]?.slice(-600) });
  prompts.length = 0;
  const twice: any = await B.composeBundle(input as any, stub([skip2, skip2, ok]));
  check("skipped again: it's left out and flagged tierSkipped, so dispatch queues its tier's next best", "messages" in twice && twice.dropped.length === 1 && twice.dropped[0].tierSkipped === true, twice.dropped);
  const px = src("harness/proactive.ts");
  check("dispatch: a twice-skipped tier pick comes out and its tier's next best is queued (lead or sibling)", /if \(res\.leadSkipped && res\.tierSkipped\) await import\("\.\.\/services\/sweepShadow\.js"\)\.then\(\(S\) => S\.queueTierNext\(/.test(px) && /if \(!d\.tierSkipped \|\| opts\.dryRun\) continue;\s*await dropCandidate\(registry, d\.item\.candidate, "skipped", d\.why\)[\s\S]{0,200}queueTierNext\(userId, d\.item\.candidate, d\.why\)/.test(px));
  check("a find with no why-member reaches the composer with no pick line: its own facts speak", /pick: pk\?\.whyMember \? \{ whyMember: pk\.whyMember, whyNow: pk\.whyNow \?\? "" \} : null/.test(px));
  // The queued tier pick carries the rest of its tier, with member-safe whys from forThem (never a reject reason).
  const js = tierPicks(base([item("C1", "First", 2), item("C2", "Second", 2), item("C3", "Third", 2)]), guardVerdicts(base([item("C1", "First", 2), item("C2", "Second", 2), item("C3", "Third", 2)]), parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "send", whyMember: "they asked", cites: ["A1"], whyNow: "this week", wow: true, lastDay: null, rank: 1 }, { id: "C2", verdict: "reject", reason: "weak_fit", why: "only loosely related", rank: 2, forThem: "a smaller room of the same kind" }, { id: "C3", verdict: "reject", reason: "not_them", why: "not his scene", rank: 3 }] }))!));
  const backlog = ["First", "Second", "Third"].map((n) => ({ askId: "profile", askText: "x", fromProfile: true, match: { name: n } }));
  const plan = SH.planPicks(js, backlog as any, []);
  check("the queued tier pick carries its tier's next best, in order, with forThem (or nothing), never the reject's reason", JSON.stringify(plan.queue[0].tierNext) === JSON.stringify([{ key: SH.shadowKey("Second", null), why: "a smaller room of the same kind" }, { key: SH.shadowKey("Third", null), why: "" }]), plan.queue[0]);
}

// ---------------------------------------------------------------- 3. the same-morning fallback is queued with forThem, never the reject reason
{
  const pool = [item("C1", "First", 2), item("C2", "Second", 2)];
  const js = tierPicks(base(pool), guardVerdicts(base(pool), parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "send", whyMember: "they asked", cites: ["A1"], whyNow: "now", wow: true, lastDay: null, rank: 1 }, { id: "C2", verdict: "reject", reason: "weak_fit", why: "only loosely related", rank: 2, forThem: "a smaller room of the same kind" }] }))!));
  const report = { live: true, chosen: ["First"], queued: [], notQueued: [{ name: "First", why: "already decided" }], error: null } as any;
  let gotWhy = "";
  await SH.fillTiers(js, report, async (j) => { gotWhy = memberWhyOf(j); return "queued"; });
  const c2 = js.find((j) => j.id === "C2")!;
  check("the alternate goes with its forThem line as its why, never 'only loosely related'", gotWhy === "a smaller room of the same kind" && c2.verdict === "send" && c2.why === "a smaller room of the same kind" && c2.notSentWhy === "only loosely related", { gotWhy, c2 });
  check("pin: the fallback's queue call builds its why with memberWhyOf", /const why = memberSafeWhy\(memberWhyOf\(j\), ids\);/.test(src("services/sweepShadow.ts")));
}

// ---------------------------------------------------------------- 1. a bounded backlog: fit-only holds age out; the never-judged come first
{
  const pool = [item("C1", "Founders Supper", 2)];
  const verdicts = [{ id: "C1", verdict: "reject", reason: "weak_fit", why: "meh" }];
  let last: Judgment[] = [];
  const seen: string[] = [];
  for (let d = 0; d < 9; d++) {
    const morning = d % 2 === 0; // a morning, then an hourly run, and so on
    const c = { ...base(pool), morning: false };
    const js = carryGuardedRuns((await run(c, verdicts, answerAll(() => false))).js, last, { morning });
    seen.push(`${morning ? "am" : "pm"}:${js[0].verdict}/${js[0].reason}/${js[0].fitOnlyMornings}`);
    last = js;
  }
  check(`a fit-only hold ages out after ${FIT_ONLY_MORNINGS} unpicked mornings (hourly runs don't count) as a verified exit`, seen[8] === `am:reject/aged_out/${FIT_ONLY_MORNINGS}` && seen[6] === `am:hold/fit_only/${FIT_ONLY_MORNINGS - 1}` && seen[7] === `pm:hold/fit_only/${FIT_ONLY_MORNINGS - 1}` && heldBackFor(last[0]) !== null, seen);
  const backlog = [{ askId: "profile", askText: "x", fromProfile: true, match: { name: "Founders Supper" } }];
  const facts: any[] = [];
  const store = new Map<string, any[]>([["profile", [{ askText: "x", match: { name: "Founders Supper" } }]]]);
  const deps: any = { backlogs: async () => [...store.entries()].map(([ask_id, items]) => ({ ask_id, items })), merge: async (_u: string, a: string, ch: any) => { store.set(a, W.applyChange(store.get(a) ?? [], ch, deps.key)); }, key: (m: any) => F.exitKey(m), writeFact: async (e: any) => { facts.push(e); } };
  await W.exitRejectedFinds("u", SH.rejectedFindsOf(last, backlog as any), deps);
  check("an aged-out find leaves the backlog with its exit fact, which says it aged out", facts.length === 1 && /left unpicked for 5 mornings/.test(facts[0].reason) && store.get("profile")!.length === 0, facts);
  const picked = carryGuardedRuns([{ ...last[0], verdict: "send", reason: "tier_pick", fitOnlyMornings: undefined } as Judgment], last, { morning: true });
  check("a find that's picked isn't counted (the count is for fit-only holds only)", picked[0].fitOnlyMornings === undefined);
  // A pool over 40: what the last run never judged comes first, so nothing sits past the cut forever.
  const raw = Array.from({ length: 45 }, (_, i) => ({ name: `Find ${i + 1}`, date: null, tier: 3, askId: null, fromProfile: true, reminder: false, details: null }));
  const first = SH.buildShadowPool(raw, TODAY, new Map(), new Set());
  const judged = new Set(first.slice(0, SELECT_LIMITS.maxPool).map((p) => p.key));
  const second = SH.buildShadowPool(raw, TODAY, new Map(), new Set(), new Set(), judged);
  const promptSecond = selectPrompt(base(second));
  check(`a pool of 45: the 5 the last run never saw lead the next prompt (the first ${SELECT_LIMITS.maxPool} shown)`, second.slice(0, 5).map((p) => p.name).join() === "Find 41,Find 42,Find 43,Find 44,Find 45" && /C1 Find 41/.test(promptSecond) && second.map((p) => p.id).join() === second.map((_, i) => `C${i + 1}`).join());
  check("pin: the run orders its pool by what the last run judged", /const judgedKeys = new Set<string>\(\(\(last\?\.proposal\?\.judgments \?\? \[\]\) as Judgment\[\]\)\.filter\(\(j\) => j\.verdict !== "no_verdict"\)/.test(src("services/sweepShadow.ts")) && /buildShadowPool\(raw, today, idFor, sentNames, closed, judgedKeys\)/.test(src("services/sweepShadow.ts")));
}

// ---------------------------------------------------------------- 9. a send's own last day is too late only when the check agrees
{
  const pool = [item("C1", "Fall Mixer", 2, { date: "2026-10-30" }), item("C2", "Hike", 2)];
  const v = [{ id: "C1", verdict: "send", whyMember: "they asked", cites: ["A1"], whyNow: "now", wow: true, lastDay: "2026-10-10", rank: 1 }, { id: "C2", verdict: "reject", reason: "weak_fit", why: "meh", rank: 2 }];
  const no = await run(base(pool), v, answerAll(() => false));
  const yes = await run(base(pool), v, answerAll((k) => k === "L"));
  check("the picker's own past last day: a claim-check 'no' doesn't hold the find back (it goes as its tier's pick)", sends(no.js) === "C1", no.js.map((j) => `${j.id}:${j.verdict}/${j.reason}`));
  check("a 'yes' holds it back and the next best goes; it exits as too late", sends(yes.js) === "C2" && yes.js.find((j) => j.id === "C1")!.late === true && yes.js.find((j) => j.id === "C1")!.verdict === "reject");
  const hourlyNo = await run({ ...base(pool), morning: false }, v, answerAll(() => false));
  check("hourly: an unconfirmed last day waits in the backlog (never exits)", hourlyNo.js.find((j) => j.id === "C1")!.reason === "fit_only");
}

// ---------------------------------------------------------------- 5. up to three finds a day
{
  check("three finds a day: the morning bundle of three leaves none for the hourly picks; two leave one", P.DAILY_FIND_CAP === 3 && P.findsLeftToday(0) === 3 && P.findsLeftToday(3) === 0 && P.findsLeftToday(2) === 1 && P.findsLeftToday(5) === 0);
  // The sequence: a morning of 3 goes; an hourly pick at noon finds none left and waits for tomorrow; a retried morning queues nothing.
  const seq: string[] = [];
  let sentToday = 0;
  const morning = Math.min(3, P.findsLeftToday(sentToday)); sentToday += morning; seq.push(`morning sends ${morning}`);
  const noon = P.findsLeftToday(sentToday); seq.push(noon > 0 ? "noon pick goes" : "noon pick waits for tomorrow");
  const retried = P.findsLeftToday(sentToday); seq.push(`retried morning queues ${retried}`);
  check("3 in the morning, then an hourly pick that day waits, and a retried morning queues none", seq.join(" | ") === "morning sends 3 | noon pick waits for tomorrow | retried morning queues 0", seq);
  const px = src("harness/proactive.ts");
  check("pin: dispatch counts today's finds before a find bundle, defers to tomorrow at the cap, and trims the bundle to what's left", /const left = findsLeftToday\(await findsSentToday\(userId, person\.timezone, state\.now\)\.catch\(\(\) => DAILY_FIND_CAP\)\);\s*if \(left <= 0\) \{/.test(px) && /pickSiblingOffers\(c, ev\.eligible\)\.slice\(0, left - 1\)/.test(px) && /action: `daily_find_cap:\$\{c\.type\}`/.test(px));
  check("pin: the cap counts finds (not reminders) that went in their own day, and an unreadable count holds", /export async function findsSentToday[\s\S]{0,500}type = 'event_offer' AND status = 'sent' AND COALESCE\(payload->>'reminder', 'false'\) <> 'true'/.test(px) && /\.catch\(\(\) => DAILY_FIND_CAP\)/.test(px));
  const sh = src("services/sweepShadow.ts");
  check("pin: a retried morning never queues past the cap, and what's cut is said, never replaced by its tier's next best", /if \(judgments\.some\(\(j\) => j\.tierPick\)\) \{[\s\S]{0,400}findsLeftToday\(await P\.findsSentToday\(/.test(sh) && /plan\.queue\.splice\(left\)/.test(sh) && /!n\.why\.startsWith\(DAY_CAP_NOTE\)/.test(sh));
  check("the weekly cap stays skipped for the morning (silence pacing is the guardrail)", /const MORNING_SKIPS = new Set\(\[\.\.\.QUOTA_CHECKS, "spacing"\]\);/.test(px) && /"weekly_cap"/.test(px.slice(px.indexOf("const QUOTA_CHECKS"), px.indexOf("const QUOTA_CHECKS") + 120)));
}

console.log(`morning review fixes: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
