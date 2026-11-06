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
  check("wrote 6 days ago or less: not tapered (engaged and active are untouched)", !t("2026-10-24") && !t("2026-10-29"));
  check("quiet 7 days or more: tapered (a week is the unit, Royce 2026-10-14)", t("2026-10-23") && t("2026-10-22") && t("2026-09-01"));
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
  const deps = (silence: "quiet" | "engaged" | "unknown"): SH.QuietDeps => ({
    silence: async () => silence,
    prunePast: async () => { calls.push("prunePast"); return { exited: 1 }; },
    record: (async (d: any) => { calls.push(`record:${d.action}:${d.reason}`); }) as any,
  });
  const held = await SH.holdWhileQuiet("u", "2026-10-30", NOW, deps("quiet"));
  check("tapered: the run is held; only passed finds are pruned; it's logged with how many passed while quiet", held === "held" && calls[0] === "prunePast" && /^record:tapered_hold:tapered: .*1 passed while quiet$/.test(calls[1]), calls);
  calls.length = 0;
  check("engaged: nothing is held, nothing is called (the picker runs exactly as before)", (await SH.holdWhileQuiet("u", "2026-10-30", NOW, deps("engaged"))) === "run" && calls.length === 0);
  calls.length = 0;
  const unread = await SH.holdWhileQuiet("u", "2026-10-30", NOW, deps("unknown"));
  check("a failed silence read: the run still picks and sends (protect), nothing is pruned, and it's never logged as tapered", unread === "protect" && !calls.includes("prunePast") && calls.length === 1 && /^record:protect:their last message couldn't be read/.test(calls[0]) && !/tapered/.test(calls[0]), calls);
  const rs = flat(SH.runSweepShadow);
  // Compared without whitespace or the parentheses a build may drop.
  const rsP = rs.replace(/[()]/g, "");
  const guard = 'constquietRun=opts.dryRun?"run":awaitholdWhileQuietuserId,today,now;ifquietRun==="held"return';
  check("pin: every picker run (morning, hourly, urgent, retry) is held while quiet before any exit, aging or pick", rsP.includes(guard) && rsP.indexOf(guard) < rsP.indexOf("closedAskRefs") && rsP.indexOf(guard) < rsP.indexOf("pruneBacklogs") && rsP.indexOf(guard) < rsP.indexOf("selectForMember") && rsP.indexOf(guard) < rsP.indexOf("applyPicks"));
  check("pin: the real quiet check is the member's own silence, and its prune is the past-only one", /memberSilence\(userId, now\)/.test(src("services/sweepShadow.ts")) && /pruneBacklogs\(userId, today, realPruneDeps, \{ quiet: true \}\)/.test(src("services/sweepShadow.ts")));
  check("a read of their silence that fails is 'unknown': the deletions treat it as quiet, nothing logs it as tapered", /\? "quiet" : "engaged";\s*\} catch \{\s*return "unknown";/.test(src("services/dailySweep.ts")) && /return \(await memberSilence\(userId, now\)\) !== "engaged";/.test(src("services/dailySweep.ts")));
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
  const run = async (quiet: "quiet" | "engaged" | "unknown" | undefined) => {
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
  check("quiet: no recheck (which idles an unanswered goal), no plan, no search; said", (await run("quiet")) === "mark,skipped:tapered");
  check("a failed silence read holds the goals this run too, said as what it is (never 'tapered')", (await run("unknown")) === "mark,skipped:silence_unread");
  check("engaged: exactly as before (recheck, plan, search)", (await run("engaged")) === "recheck,mark,plan,surface" && (await run(undefined)) === "recheck,mark,plan,surface");
  check("pin: the real goal sweep reads the same silence", /quiet: async \(userId\) => \(await import\("\.\/dailySweep\.js"\)\)\.memberSilence\(userId\)/.test(src("services/goalSweep.ts")));
}

// ---------------------------------------------------------------- the other exit paths
{
  const ax = src("services/askExpiry.ts");
  check("ask expiry: an ask with no time frame has no clock; an old one comes off, said once in the log, never closed on silence", /if \(!named\) \{[\s\S]{0,200}expires_at = NULL[\s\S]{0,300}decision: "ask\.expiry_held"/.test(ax) && !/memberSilence/.test(ax));
  check("ask expiry: one whose named time passed expires (that is evidence, not silence)", /the time it was for passed \(\$\{new Date\(r\.expires_at\)\.toISOString\(\)\.slice\(0, 10\)\}\)`/.test(ax));
  const es = src("services/eventSurfacingSweep.ts");
  check("a queued find whose send window ended while quiet goes back to the backlog (unless its date passed), said", /const silence = status === "expired" && !isPastEvent\(payload\.match, await memberZone\(userId\)\) \? await import\("\.\/dailySweep\.js"\)\.then\(\(D\) => D\.memberSilence\(userId\)\)/.test(es) && /if \(silence !== "engaged"\) \{/.test(es) && /action: "expired_offer_kept"/.test(es));
}

// ---------------------------------------------------------------- the 7:30 daily prune keeps a quiet member's finds
{
  // An undated opening found on a tapered search day: the daily prune runs at 7:30 every morning while they're quiet.
  const facts: any[] = [];
  let classified = 0;
  const store = new Map<string, any[]>([["profile", [{ askText: "x", match: { tier: 3, kind: "opportunity", name: "Rolling Founder Residency", url: "https://x/r" } }, { askText: "x", match: { tier: 2, kind: "public_event", form: "event", name: "Past Mixer", url: "https://x/p", event_date: "2026-10-01" } }]]]);
  const deps: any = { backlogs: async () => [...store.entries()].map(([ask_id, items]) => ({ ask_id, items })), merge: async (_u: string, a: string, ch: any) => { store.set(a, W.applyChange(store.get(a) ?? [], ch, deps.key)); }, classify: async (m: any) => { classified++; return { match: m, result: "undated" }; }, zone: async () => Z, key: (m: any) => F.exitKey(m), writeFact: async (e: any) => { facts.push(e); } };
  for (const d of ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]) await W.pruneBacklogs("u", d, deps, { quiet: true });
  const left = store.get("profile")!.map((i: any) => i.match.name);
  check("a quiet member's undated opening survives a week of 7:30 passes (only the past mixer leaves, 'passed while quiet')", left.join() === "Rolling Founder Residency" && facts.length === 1 && /passed while quiet/.test(facts[0].reason) && classified === 0, { left, facts });
  const pool = SH.buildShadowPool(store.get("profile")!.map((i: any) => ({ name: i.match.name, date: null, tier: 3, askId: null, fromProfile: true, reminder: false, details: null })), "2026-10-31", new Map(), new Set());
  check("and it's in the pool on the resume morning", pool.some((p) => p.name === "Rolling Founder Residency"));
  check("pin: the 7:30 prune passes each member's silence (quiet, or a failed read, keeps all but what passed)", /const quiet = await import\("\.\/dailySweep\.js"\)\.then\(\(D\) => D\.memberTapered\(String\(r\.user_id\), now\)\)\.catch\(\(\) => true\);\s*pruned \+= \(await pruneBacklogs\(r\.user_id, today, deps, \{ quiet \}\)\)\.exited;/.test(src("services/workingSet.ts")));
}

// ---------------------------------------------------------------- the hourly ask sweep's empty-run exit never takes a quiet member's ask
{
  let n = { emptyRuns: 5, held: false };
  for (let i = 0; i < 40; i++) n = W.nextEmptyRuns({ prev: n.emptyRuns, found: false, quiet: true, heldBefore: n.held || i > 0 });
  check("a quiet member's ask survives any number of empty runs: the count is frozen and the ask held", n.emptyRuns === 5 && n.held && !W.askExitDue({ empty_runs: 6 }, "quiet") && !W.askExitDue({ empty_runs: 99 }, "unknown"));
  const resumed = W.nextEmptyRuns({ prev: 5, found: false, quiet: false, heldBefore: true });
  check("after they write, counting starts fresh (the first empty run counts 1, not 6)", resumed.emptyRuns === 1 && !resumed.held && !W.askExitDue({ empty_runs: resumed.emptyRuns }, "engaged"));
  let e = { emptyRuns: 0, held: false };
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) { e = W.nextEmptyRuns({ prev: e.emptyRuns, found: false, quiet: false, heldBefore: false }); seen.push(e.emptyRuns); }
  check("engaged: unchanged (counts 1..6 and exits at 6; a find resets it)", seen.join() === "1,2,3,4,5,6" && W.askExitDue({ empty_runs: 6 }, "engaged") && W.nextEmptyRuns({ prev: 4, found: true, quiet: false, heldBefore: false }).emptyRuns === 0);
  const es = src("services/eventSurfacingSweep.ts").replace(/\s+/g, "");
  check("pin: the hourly search counts through nextEmptyRuns with the member's silence, and marks held asks", es.includes("nextEmptyRuns({prev:Number(cur.empty_runs??0),found:trace.found.length>0,quiet,heldBefore:!!cur.quiet_held_at})") && es.includes("quiet_held_at=CASEWHEN$3THENCOALESCE(quiet_held_at,NOW())ELSENULLEND"));
  const jobs = src("jobs/index.ts").replace(/\s+/g, "");
  check("pin: the empty-run exit asks askExitDue with the member's silence, and logs a held ask once a day", jobs.includes("if(!W.askExitDue(t,silence)){") && jobs.includes("decision:\"ask.empty_exit_held\"") && jobs.indexOf("if(!W.askExitDue(t,silence)){") < jobs.indexOf("awaitW.exitAsk({userId:t.user_id"));
  check("the held-ask column is migrated", /ADD COLUMN IF NOT EXISTS quiet_held_at TIMESTAMPTZ/.test(src("db/migrations.ts")));
}

// ---------------------------------------------------------------- a failed silence read never costs an engaged member's morning
{
  const rs = src("services/sweepShadow.ts").replace(/\s+/g, "");
  check("pin: on a failed read the run goes on (picks and sends), with the dead-backlog clear and the prune skipped", rs.includes('constprotect=quietRun==="protect";') && rs.includes("if(!opts.dryRun&&!protect){const{dead}=splitDeadBacklog(") && rs.includes('if(!opts.dryRun&&!protect)awaitimport("./workingSet.js").then((W)=>W.pruneBacklogs(userId,today,realPruneDeps))'));
  const ap = src("services/sweepShadow.ts").replace(/\s+/g, "");
  check("pin: and its apply queues the picks but exits nothing (no reject exit, no aged-out exit; a rejected queued row is only kept from sending)", ap.includes("applyPicks(userId,r.judgments,backlogs,today,r.set??null,applied,contextIds(ctx),{protect})") && ap.includes("if(o.protect)continue;") && ap.includes("constuniq=o.protect?[]:rejectedFindsOf(") && ap.includes("constaged=o.protect?[]:ageOutFitOnly(judgments);"));
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

// ---------------------------------------------------------------- the hourly ask sweep follows the same cadence (Royce, 2026-10-14)
{
  // Per ask: the ask's own last search against their own last message, the same rule as the 9am floor.
  const ask = (inbound: string | null, lastSearch: string | null) => DS.searchCadence({ now: NOW, zone: Z, lastInboundAt: inbound ? at(inbound, 18) : null, lastSearchAt: lastSearch ? at(lastSearch, 17) : null });
  check("quiet ask: engaged member's ask (wrote 2 days ago) is due daily", ask("2026-10-28", "2026-10-29").search);
  check("quiet ask: 10 days quiet, searched yesterday: not due (every 3 days)", !ask("2026-10-20", "2026-10-29").search && ask("2026-10-20", "2026-10-29").everyDays === 3);
  check("quiet ask: 10 days quiet, searched 3 days ago: due", ask("2026-10-20", "2026-10-27").search);
  check("quiet ask: 30 days quiet, searched 3 days ago: not due (weekly); 7 days ago: due", !ask("2026-09-30", "2026-10-27").search && ask("2026-09-30", "2026-10-23").search);
  check("quiet ask: they wrote since the ask's last search: due on the next tick (same-day resume)", DS.searchCadence({ now: NOW, zone: Z, lastInboundAt: at("2026-10-30", 15), lastSearchAt: at("2026-10-27", 17) }).search);
  check("quiet ask: never searched: due", ask("2026-09-30", null).search);

  const j = src("jobs/index.ts").replace(/\s+/g, "");
  check("pin: the hourly ask sweep reads the same cadence, from their last message and the ask's own last search only",
    j.includes("constcadenceDue=(r:any):boolean=>lastIn===undefined||searchCadence({now:newDate(),zone:timezone,lastInboundAt:lastIn,lastSearchAt:r.last_attempted_at?newDate(r.last_attempted_at):null}).search;"));
  check("pin: a silence read that fails searches as usual (it only slows, never deletes)", j.includes("constlastIn=awaitlastInboundAt(userRows[0].user_id).catch(()=>undefined);") && j.includes("lastIn===undefined||"));
  const loop = j.slice(j.indexOf("for(constrowofuserRows){"));
  check("pin: a tapered ask is skipped before it counts as a search or moves its last search (nothing written, nothing deleted)",
    loop.indexOf("if(!cadenceDue(row))continue;") > 0 && loop.indexOf("if(!cadenceDue(row))continue;") < loop.indexOf("searchedToday++") && loop.indexOf("if(!cadenceDue(row))continue;") < loop.indexOf("UPDATEask_checkinsSETlast_attempted_at"));
  check("pin: the due check before the sweep hold uses the cadence too", j.includes("askSearchDue(r)&&cadenceDue(r));"));
  check("pin: a tapered member's asks are said once a day (sweep.ask_tapered), never skipped in silence",
    j.includes("decision='sweep.ask_tapered'ANDuser_id=$1ANDproposal->>'day'=$2") && j.includes('decision:"sweep.ask_tapered"'));
  check("pin: no send-side input reaches the ask cadence (only lastInboundAt and last_attempted_at)",
    !/cadenceDue=[^;]*(last_surfaced_at|sent_at|outbound|proactive_candidates)/.test(j));
}

console.log(`taper holds: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
