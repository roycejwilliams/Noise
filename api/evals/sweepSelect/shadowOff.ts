// The shadow week's own picker run is off, and an empty pool loads nothing (efficiency audit, 2026-10-29). A cost cut, not a search
// change: what the live sweep sends members is untouched. Zero tokens: the database is a stub that answers by query, and no run here
// reaches the picker's model call.
//   npx tsx evals/sweepSelect/shadowOff.ts
import { readFileSync } from "fs";
import * as SH from "../../src/services/sweepShadow.js";

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
const flat = (f: Function) => f.toString().replace(/\s+/g, "");

// ---------------------------------------------------------------- the picker run, on a stubbed database
{
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const NOW = new Date("2026-10-30T17:00:00Z");
  type World = { lastInbound: Date; backlog: any[]; queued: any[] };
  const seen: string[] = [];
  const decisions: any[] = [];
  let world: World = { lastInbound: NOW, backlog: [], queued: [] };
  const LOAD_ASKS = /FROM ask_checkins WHERE user_id = \$1 ORDER BY created_at, id/;
  (pool as any).query = async (sql: string, args: any[] = []) => {
    seen.push(sql.replace(/\s+/g, " ").trim());
    if (/INSERT INTO harness_decisions/.test(sql)) {
      decisions.push({ decision: args[1], outcome: args[3], action: args[4], proposal: typeof args[5] === "string" ? JSON.parse(args[5]) : args[5] });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT MAX\(created_at\) AS at FROM co_memories/.test(sql)) return { rows: [{ at: world.lastInbound }] };
    if (/FROM event_backlogs WHERE user_id = \$1/.test(sql)) return { rows: world.backlog };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND type = 'event_offer' AND status = 'pending'/.test(sql)) return { rows: world.queued };
    // The member's asks: the first read of the member layer. Stopped here so no run in this file goes further.
    if (LOAD_ASKS.test(sql)) throw new Error("stub: the member's asks were loaded");
    return { rows: [], rowCount: 0 };
  };
  const run = async (w: World) => {
    world = w;
    seen.length = 0;
    decisions.length = 0;
    const r = await SH.runSweepShadow("11111111-2222-4333-8444-555555555555", NOW, { trigger: "after_sweep", morning: true }).then(
      (x) => ({ ok: true as const, r: x }),
      (err: any) => ({ ok: false as const, err: String(err?.message ?? err) }),
    );
    return { r, loadedAsks: seen.some((q) => LOAD_ASKS.test(q)), decisions: [...decisions] };
  };
  try {
    // Engaged, nothing waiting: recorded as an empty pool, and the member layer is never loaded for it.
    const empty = await run({ lastInbound: new Date("2026-10-30T15:00:00Z"), backlog: [], queued: [] });
    check("an empty pool: the run ends skipped, with an empty pool", empty.r.ok && !!empty.r.r && empty.r.r.skipped === true && empty.r.r.pool.length === 0, empty);
    check("an empty pool: the member's asks and knowledge are not loaded for it", !empty.loadedAsks, empty);
    check("an empty pool: the same record as before (sweep.select.shadow, skip, empty_pool, the day, pool 0)", empty.decisions.some((d) => d.decision === "sweep.select.shadow" && d.outcome === "skip" && d.action === "empty_pool" && d.proposal?.day === "2026-10-30" && d.proposal?.poolSize === 0), empty.decisions);
    check("an empty pool: nothing is queued or picked (no sweep.select.queue)", !empty.decisions.some((d) => d.decision === "sweep.select.queue"), empty.decisions);
    // A backlog that holds only past finds is not empty here: the pool is built and filtered as before (the early end is only for nothing
    // waiting at all).
    const past = await run({ lastInbound: new Date("2026-10-30T15:00:00Z"), backlog: [{ ask_id: "a1", items: [{ match: { name: "Old thing", event_date: "2026-10-01" } }] }], queued: [] });
    check("something waiting (even a past find): the member layer is loaded exactly as before", past.loadedAsks, past);
    // Something waiting: the run goes on to load the member, as before.
    const some = await run({ lastInbound: new Date("2026-10-30T15:00:00Z"), backlog: [{ ask_id: "a1", items: [{ match: { name: "A dinner", event_date: "2026-11-05", tier: 2 } }] }], queued: [] });
    check("a find waiting: the member layer is loaded exactly as before", some.loadedAsks && !some.decisions.some((d) => d.action === "empty_pool"), some);
    // Queued offers alone are a pool too.
    const queued = await run({ lastInbound: new Date("2026-10-30T15:00:00Z"), backlog: [], queued: [{ payload: { askId: "a1", match: { name: "A dinner", event_date: "2026-11-05" } } }] });
    check("a queued offer alone: the member layer is loaded exactly as before", queued.loadedAsks, queued);
    // Tapered (quiet over a week): held before anything is loaded or picked.
    const quiet = await run({ lastInbound: new Date("2026-10-15T15:00:00Z"), backlog: [{ ask_id: "a1", items: [{ match: { name: "A dinner", event_date: "2026-11-05" } }] }], queued: [] });
    check("tapered: held, logged as tapered_hold, nothing loaded or picked", quiet.r.ok && quiet.r.r?.skipped === true && !quiet.loadedAsks && quiet.decisions.some((d) => d.action === "tapered_hold"), quiet);
  } finally {
    (pool as any).query = real;
  }
  // No model call on either skip path: both end before the picker's selection (pinned by position in the run).
  const rs = flat(SH.runSweepShadow);
  const emptyAt = rs.indexOf("if(!raw.length)");
  check("pin: the empty-pool end comes before the member layer and before the picker's model call", emptyAt > 0 && emptyAt < rs.indexOf("loadAsks(") && emptyAt < rs.indexOf("loadKnowledge(") && emptyAt < rs.indexOf("selectForMember("));
  check("pin: the empty-pool end comes after the prune and the closed-ask clearing (those run as before)", emptyAt > rs.indexOf("pruneBacklogs") && emptyAt > rs.indexOf("splitDeadBacklog(awaitq("));
}

// ---------------------------------------------------------------- the shadow week's own run is off; every live picker path is untouched
{
  const jobs = src("jobs/index.ts");
  check("no 10am shadow run and no shadow retry are scheduled", !/runSweepShadowAll/.test(jobs) && !/sweep shadow (retry )?cron error/.test(jobs));
  check("the shadow-only entry point is gone", !("runSweepShadowAll" in SH) && !/trigger\?: "urgent_find" \| "retry"/.test(src("services/sweepShadow.ts")));
  // The live picker runs after every sweep, for every member, from the same five places with the same arguments.
  check("live: the 9am floor's morning pick", /S\.runPickerAfterSweep\(userId, "daily"\)/.test(src("services/dailySweep.ts")));
  check("live: the hourly ask sweep's pick", /S\.runPickerAfterSweep\(userRows\[0\]\.user_id, "hourly"\)/.test(jobs));
  check("live: the goal sweep's pick", /S\.runPickerAfterSweep\(row\.user_id, "goal"\)/.test(src("services/goalSweep.ts")));
  check("live: a call promise's pick", /S\.runPickerAfterSweep\(userId, "call"\)/.test(src("harness/callGrounding.ts")));
  check("live: a new ask's first search's pick", /S\.runPickerAfterSweep\(userId, "new_ask"\)/.test(src("services/eventSurfacingSweep.ts")));
  check("live: the after-sweep run is unchanged (gate, trigger, morning only for the floor)", /if \(!pickerLive\(\)\) return;\n\s+\/\/[^\n]*\n\s+await runSweepShadow\(userId, new Date\(\), \{ trigger: "after_sweep", \.\.\.\(after === "daily" \? \{ morning: true \} : \{\}\) \}\)/.test(src("services/sweepShadow.ts")));
  check("live: the urgent-find and taste reruns are kept", typeof SH.rerunPickerForUrgentFind === "function" && typeof SH.rerunPickerForTaste === "function");
}

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
