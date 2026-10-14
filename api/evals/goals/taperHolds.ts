// The quiet-member taper only slows searching (Royce, 2026-10-14: "Instant resume: any reply or activity from the member restores full
// daily searching on the very next run ... The taper only slows searching. It never deletes goals, plans, or finds. Anything found while
// tapered is held and surfaces on resume ... Engaged members are untouched"). Zero tokens: the store, the model and the clock are stubbed.
//   npx tsx evals/goals/taperHolds.ts
import { readFileSync } from "fs";
import * as DS from "../../src/services/dailySweep.js";
import * as SH from "../../src/services/sweepShadow.js";
import * as W from "../../src/services/workingSet.js";
import * as F from "../../src/services/findForm.js";
import * as G from "../../src/services/goalEdges.js";
import * as GS from "../../src/services/goalSweep.js";
import { guardVerdicts, parseVerdicts, tierPicks, type PoolItem, type SelectContext } from "../../src/services/sweepSelect.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};
const flat = (f: Function) => f.toString().replace(/\s+/g, "");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const Z = "America/Los_Angeles";
const at = (d: string, h = 16) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
const NOW = at("2026-10-30");

// ---------------------------------------------------------------- who is tapered: their own silence past a week
{
  // Their message at 11am their time on that day.
  const t = (d: string | null) => DS.quietTapered({ now: NOW, zone: Z, lastInboundAt: d ? at(d, 18) : null });
  check("wrote 7 days ago: not tapered (engaged and active are untouched)", !t("2026-10-23") && !t("2026-10-29"));
  check("quiet 8 days or more: tapered", t("2026-10-22") && t("2026-09-01"));
  check("no message on record: not tapered (never taper on missing data)", !t(null));
  check("it matches the cadence: tapered exactly when the search cadence is past daily", ["2026-10-29", "2026-10-23", "2026-10-22", "2026-10-15", "2026-10-01"].every((d) => t(d) === (DS.searchCadence({ now: NOW, zone: Z, lastInboundAt: at(d, 18), lastSearchAt: at("2026-10-29") }).everyDays > 1)));
}

// ---------------------------------------------------------------- instant resume, the same day
{
  const rec = (action: string, hour: number, extra: any = {}) => ({ action, created_at: at("2026-10-30", hour), proposal: extra });
  check("a tapered day, and they wrote after it: today's floor isn't done (the next hourly tick runs it in full)", !DS.floorDoneToday([rec("tapered", 16)], at("2026-10-30", 19)));
  check("a tapered search day whose finds were held, and they wrote after: not done either", !DS.floorDoneToday([rec("searched 3", 16, { heldQuiet: true })], at("2026-10-30", 19)));
  check("a tapered day with no message since: done", DS.floorDoneToday([rec("tapered", 16)], at("2026-10-20", 2)));
  check("an ordinary day (engaged): done once it ran, whatever they write after (unchanged)", DS.floorDoneToday([rec("searched 3", 16)], at("2026-10-30", 19)));
  check("errors never count as done (unchanged)", !DS.floorDoneToday([rec("error", 16)], null));
  const resume = DS.searchCadence({ now: at("2026-10-30", 19), zone: Z, lastInboundAt: at("2026-10-30", 18), lastSearchAt: at("2026-10-28") });
  check("after they write, the next run searches everything (no warm-up, daily again)", resume.search && resume.everyDays === 1 && !DS.quietTapered({ now: at("2026-10-30", 19), zone: Z, lastInboundAt: at("2026-10-30", 18) }));
  const rd = flat(DS.runDailySweep);
  check("pin: the floor reads their last message once, and a quiet day's record gives way to it", rd.includes("constinboundAt=awaitlastInboundAt(userId);if(floorDoneToday(earlier,inboundAt))return;") && rd.includes("lastInboundAt:inboundAt,lastSearchAt:"));
}

// ---------------------------------------------------------------- the picker holds while quiet: no aging tick, no exit, no send
{
  const calls: string[] = [];
  const deps = (tapered: boolean): SH.QuietDeps => ({
    tapered: async () => tapered,
    prunePast: async () => { calls.push("prunePast"); return { exited: 1 }; },
    record: (async (d: any) => { calls.push(`record:${d.action}:${d.reason}`); }) as any,
  });
  const held = await SH.holdWhileQuiet("u", "2026-10-30", NOW, deps(true));
  check("tapered: the run is held; only passed finds are pruned; it's logged with how many passed while quiet", held && calls[0] === "prunePast" && /^record:tapered_hold:tapered: .*1 passed while quiet$/.test(calls[1]), calls);
  calls.length = 0;
  check("engaged: nothing is held, nothing is called (the picker runs exactly as before)", !(await SH.holdWhileQuiet("u", "2026-10-30", NOW, deps(false))) && calls.length === 0);
  const rs = flat(SH.runSweepShadow);
  // Compared without whitespace or the parentheses a build may drop.
  const rsP = rs.replace(/[()]/g, "");
  const guard = "if!opts.dryRun&&awaitholdWhileQuietuserId,today,nowreturn";
  check("pin: every picker run (morning, hourly, urgent, retry) is held while quiet before any exit, aging or pick", rsP.includes(guard) && rsP.indexOf(guard) < rsP.indexOf("closedAskRefs") && rsP.indexOf(guard) < rsP.indexOf("pruneBacklogs") && rsP.indexOf(guard) < rsP.indexOf("selectForMember") && rsP.indexOf(guard) < rsP.indexOf("applyPicks"));
  check("pin: the real quiet check is the member's own silence, and its prune is the past-only one", /memberTapered\(userId, now\)/.test(src("services/sweepShadow.ts")) && /pruneBacklogs\(userId, today, realPruneDeps, \{ quiet: true \}\)/.test(src("services/sweepShadow.ts")));
  check("a read of their silence that fails counts as tapered (holding loses nothing; an exit can't be undone)", /return quietTapered\(\{ now, zone, lastInboundAt: await lastInboundAt\(userId\) \}\);\s*\} catch \{\s*return true;/.test(src("services/dailySweep.ts")));
}

// ---------------------------------------------------------------- while quiet only a passed find leaves, and it says so
{
  const TODAY = "2026-10-30";
  const facts: any[] = [];
  let classified = 0;
  const items = [
    { askText: "x", match: { tier: 2, kind: "public_event", form: "event", name: "Last Week Mixer", url: "https://x/1", event_date: "2026-10-20" } },
    { askText: "x", match: { tier: 2, kind: "public_event", form: "event", name: "Next Week Dinner", url: "https://x/2", event_date: "2026-11-06" } },
    { askText: "x", match: { tier: 3, kind: "opportunity", name: "Undated Program", url: "https://x/3" }, unread: { days: ["2026-10-28", "2026-10-29"], why: "undated" } },
    { askText: "x", match: { tier: 3, kind: "opportunity", name: "Stalled Opening", url: "https://x/4", form: "opening", deadline: "2026-12-01" }, unread: { days: ["2026-10-28", "2026-10-29"], why: "stalled" } },
  ];
  const store = new Map<string, any[]>([["profile", items]]);
  const deps: any = { backlogs: async () => [...store.entries()].map(([ask_id, items]) => ({ ask_id, items })), merge: async (_u: string, a: string, ch: any) => { store.set(a, W.applyChange(store.get(a) ?? [], ch, deps.key)); }, classify: async (m: any) => { classified++; return { match: m, result: "undated" }; }, zone: async () => Z, key: (m: any) => F.exitKey(m), writeFact: async (e: any) => { facts.push(e); } };
  const r = await W.pruneBacklogs("u", TODAY, deps, { quiet: true });
  check("quiet prune: the past event leaves with 'passed while quiet'; the rest stay (nothing read, nothing exits for being unread or stalled)", r.exited === 1 && facts.length === 1 && /passed while quiet/.test(facts[0].reason) && store.get("profile")!.map((i: any) => i.match.name).join() === "Next Week Dinner,Undated Program,Stalled Opening" && classified === 0, { r, facts, left: store.get("profile")!.map((i: any) => i.match.name) });
  // The same backlog on an engaged day: the ordinary prune (unread items are read; the third unread day exits them).
  const facts2: any[] = [];
  const store2 = new Map<string, any[]>([["profile", JSON.parse(JSON.stringify(items))]]);
  const deps2: any = { ...deps, backlogs: async () => [...store2.entries()].map(([ask_id, items]) => ({ ask_id, items })), merge: async (_u: string, a: string, ch: any) => { store2.set(a, W.applyChange(store2.get(a) ?? [], ch, deps2.key)); }, writeFact: async (e: any) => { facts2.push(e); } };
  const r2 = await W.pruneBacklogs("u", TODAY, deps2, {});
  check("engaged: the prune is unchanged (the past one and the long-unread ones exit as before)", r2.exited >= 2 && facts2.some((f) => /passed$/.test(f.reason)) && !facts2.some((f) => /while quiet/.test(f.reason)), facts2.map((f) => f.reason));
}

// ---------------------------------------------------------------- the floor on a tapered search day: searched, held, no plan written
{
  const GOALS = ["meet other climate founders", "find a hiking crew in the Bay Area"];
  const world = (o: { stored?: any; goals?: string[] }) => {
    const calls = { model: 0, log: 0 };
    const deps: DS.FloorPlanDeps = {
      inputs: async () => ({ goals: o.goals ?? GOALS, city: "SF", zone: Z, firstName: "Rina", direction: null, enjoys: null, specifics: null, record: { person: "", statedTaste: [], avoid: [], openAsks: [] } }),
      states: async () => new Map(),
      stored: async () => o.stored ?? null,
      build: G.buildFloorPlan,
      model: async () => { calls.model++; return JSON.stringify((o.goals ?? GOALS).map((g, i) => ({ n: i + 1, kind: "findable", edges: [`edge ${i}`], until: null, superseded_by: null }))); },
      log: async () => { calls.log++; },
    };
    return { deps, calls };
  };
  const oldPlan = { proposal: { edges: GOALS.map((g) => ({ goal: g, kind: "findable", edges: ["a b"] })), passed: [], setAside: [], goalsSig: "old" }, created_at: at("2026-09-01") };
  const kept = world({ stored: oldPlan, goals: [...GOALS, "a goal added since"] });
  const k = await DS.floorGoalPlan({ user_id: "u" }, NOW, kept.deps, { quiet: true });
  check("quiet: their last plan is searched as it is, even with goals changed or past the backstop; nothing read, nothing written", k.how === "kept_quiet" && kept.calls.model === 0 && kept.calls.log === 0 && !!k.plan, k);
  const fresh = world({});
  const f = await DS.floorGoalPlan({ user_id: "u" }, NOW, fresh.deps, { quiet: true });
  check("quiet with no plan at all: the list is read for this search only and never written as their plan", f.how === "built" && fresh.calls.model === 1 && fresh.calls.log === 0 && /for this search only/.test(f.note ?? ""));
  const eng = world({ stored: oldPlan, goals: [...GOALS, "a goal added since"] });
  const e = await DS.floorGoalPlan({ user_id: "u" }, NOW, eng.deps);
  const e2 = await DS.floorGoalPlan({ user_id: "u" }, NOW, world({ stored: oldPlan, goals: [...GOALS, "a goal added since"] }).deps, { quiet: false });
  check("engaged: the plan path is unchanged (changed goals rebuild and write, as before; quiet:false is the same as no flag)", e.how === "built" && eng.calls.log === 1 && e2.how === e.how && JSON.stringify(e2.live) === JSON.stringify(e.live));
  const sm = flat(DS.sweepMember);
  check("pin: a tapered search day passes quiet to the plan and holds its finds (no picker run, no morning send)", /floorGoalPlan\(row,now,(undefined|void0),\{quiet:!!o\.quiet\}\)/.test(sm) && sm.includes("&&!o.quiet)awaitsendMorningFinds(userId,base.day)") && (sm.match(/sendMorningFinds\(/g) ?? []).length === (sm.match(/!o\.quiet\)awaitsendMorningFinds\(/g) ?? []).length && sm.includes("heldQuiet:true"));
  check("pin: the floor passes quiet only when their own silence tapers them", flat(DS.runDailySweep).includes("{quiet:quietTapered({now,zone,lastInboundAt:inboundAt})}"));
}

// ---------------------------------------------------------------- the hourly goal sweep holds a quiet member's goals
{
  const run = async (quiet: boolean | undefined) => {
    const calls: string[] = [];
    const row = { user_id: "u", goals: ["meet founders"], intent: [], last_attempted_at: null, cooldown_cleared: true };
    await GS.runGoalSweep(async (items: any[], _n: number, fn: any) => { for (const i of items) await fn(i); }, {
      rows: async () => [row],
      mark: async () => { calls.push("mark"); },
      recheck: async () => { calls.push("recheck"); },
      plan: async () => { calls.push("plan"); return { searchText: "x" }; },
      surface: async () => { calls.push("surface"); },
      held: async () => [],
      skipped: async (_r, why) => { calls.push(`skipped:${why}`); },
      ...(quiet === undefined ? {} : { quiet: async () => quiet }),
    });
    return calls.join(",");
  };
  check("quiet: no recheck (which idles an unanswered goal), no plan, no search; said", (await run(true)) === "mark,skipped:tapered");
  check("engaged: exactly as before (recheck, plan, search)", (await run(false)) === "recheck,mark,plan,surface" && (await run(undefined)) === "recheck,mark,plan,surface");
  check("pin: the real goal sweep reads the same silence", /quiet: async \(userId\) => \(await import\("\.\/dailySweep\.js"\)\)\.memberTapered\(userId\)/.test(src("services/goalSweep.ts")));
}

// ---------------------------------------------------------------- the other exit paths
{
  const ax = src("services/askExpiry.ts");
  check("ask expiry: while quiet an ask with no time frame of its own isn't expired on its 30 days (pushed a day, said once a day)", /if \(quiet && !named\) \{[\s\S]{0,200}expires_at = NOW\(\) \+ INTERVAL '1 day'[\s\S]{0,300}decision: "ask\.expiry_held"/.test(ax));
  check("ask expiry: one whose named time passed expires, said 'while quiet'", /the time it was for passed \(\$\{new Date\(r\.expires_at\)\.toISOString\(\)\.slice\(0, 10\)\}\)\$\{quiet \? " while quiet" : ""\}/.test(ax));
  const es = src("services/eventSurfacingSweep.ts");
  check("a queued find whose send window ended while quiet goes back to the backlog (unless its date passed), said", /if \(status === "expired" && !isPastEvent\(payload\.match, await memberZone\(userId\)\) && \(await import\("\.\/dailySweep\.js"\)\.then\(\(D\) => D\.memberTapered\(userId\)\)/.test(es) && /action: "expired_offer_kept"/.test(es));
}

// ---------------------------------------------------------------- surfacing on resume: held finds compete, never dumped
{
  // The last picker run (before they went quiet) judged A; B and C were found on tapered days and never judged: they lead the pool.
  const raw = ["A judged before", "B held 1", "C held 2"].map((name, i) => ({ name, date: null, tier: i === 0 ? 2 : 3, askId: null, fromProfile: true, reminder: false, details: null }));
  const judged = new Set([SH.shadowKey("A judged before", null)]);
  const pool = SH.buildShadowPool(raw, "2026-10-30", new Map(), new Set(), new Set(), judged);
  check("held finds (never judged) come first in the pool on the first full morning", pool.map((p) => p.name).join() === "B held 1,C held 2,A judged before");
  const c: SelectContext = { firstName: "Rina", city: "SF", today: "2026-10-30", weekday: "Friday", asks: [], texts: [{ id: "T1", at: "Oct 30 08:00", from: "member", text: "back! been heads down" }], sent: [], outcomes: [], feeling: null, discoveryLeft: 4, pool: pool as PoolItem[], morning: true };
  const v = parseVerdicts(JSON.stringify({ verdicts: [{ id: "C1", verdict: "send", whyMember: "small rooms", cites: ["T1"], whyNow: "this week", wow: true, lastDay: null, rank: 1 }, { id: "C2", verdict: "send", whyMember: "small rooms", cites: ["T1"], whyNow: "this week", wow: true, lastDay: null, rank: 2 }, { id: "C3", verdict: "send", whyMember: "they asked", cites: ["T1"], whyNow: "now", wow: true, lastDay: null, rank: 1 }] }))!;
  const js = tierPicks(c, guardVerdicts(c, v));
  check("the first full morning after resume is a normal morning: one per tier (two held finds in one tier send one), not a dump", js.filter((j) => j.verdict === "send").map((j) => j.name).sort().join() === "A judged before,B held 1" && js.find((j) => j.name === "C held 2")!.reason === "tier_taken");
}

console.log(`taper holds: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
