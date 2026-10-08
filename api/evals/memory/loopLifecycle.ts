// The life of an open loop: states, the three ways out, and the drafting filter (services/loopLifecycle.ts, services/openLoops.ts). Layer 1.
//   npx tsx evals/memory/loopLifecycle.ts
// The regression (2026-10-06): the 9/29 pitch loop stayed open after Friday passed and a check-in stated it as current.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const LC = await import("../../src/services/loopLifecycle.js");
const OL = await import("../../src/services/openLoops.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const day = (iso: string) => new Date(`${iso}T20:00:00Z`);
const row = (o: Partial<any> = {}) => ({ status: "open", closedAt: null, closedReason: null, dueDate: null, lastConfirmedAt: day("2026-10-05"), decayAskedAt: null, ...o });
const NOW = day("2026-10-06"), TODAY = "2026-10-06";

// ---- states
check("four states", LC.LOOP_STATES.join() === "open,waiting,closed,expired");
check("open and the other live statuses are 'open'; waiting on a reply is 'waiting'", LC.stateOf(row()) === "open" && LC.stateOf(row({ status: "unconfirmed" })) === "open" && LC.stateOf(row({ status: "decision_needed" })) === "open" && LC.stateOf(row({ status: "waiting_on_reply" })) === "waiting");
check("done/dropped/closed are 'closed'; one that decayed is 'expired'", LC.stateOf(row({ status: "done", closedAt: NOW, closedReason: "co" })) === "closed" && LC.stateOf(row({ closedAt: NOW, closedReason: "date_passed", status: "dropped" })) === "closed" && LC.stateOf(row({ closedAt: NOW, closedReason: "expired", status: "dropped" })) === "expired");

// ---- the drafting filter: open AND recently confirmed
check("open + confirmed yesterday: draftable", LC.isDraftable(row(), NOW, TODAY));
check("open but confirmed 8 days ago: not draftable (background only)", !LC.isDraftable(row({ lastConfirmedAt: day("2026-09-28") }), NOW, TODAY));
check("7 days is still recent; 8 is not", LC.isDraftable(row({ lastConfirmedAt: day("2026-09-29") }), NOW, TODAY) && !LC.isDraftable(row({ lastConfirmedAt: day("2026-09-28") }), NOW, TODAY));
check("never confirmed (a row from before the lifecycle) is not draftable", !LC.isDraftable(row({ lastConfirmedAt: null }), NOW, TODAY));
check("waiting, closed and expired are not draftable, however fresh", !LC.isDraftable(row({ status: "waiting_on_reply" }), NOW, TODAY) && !LC.isDraftable(row({ closedAt: NOW, status: "done" }), NOW, TODAY) && !LC.isDraftable(row({ closedAt: NOW, closedReason: "expired", status: "dropped" }), NOW, TODAY));
check("the 9/29 pitch: confirmed 9/29, due 10/2: not draftable on 10/6 for either reason", !LC.isDraftable(row({ lastConfirmedAt: day("2026-09-29"), dueDate: "2026-10-02" }), NOW, TODAY));
check("a loop whose date passed is not draftable even if confirmed this morning", !LC.isDraftable(row({ dueDate: "2026-10-05" }), NOW, TODAY) && LC.isDraftable(row({ dueDate: "2026-10-06" }), NOW, TODAY));

// ---- the three ways out
check("evidence: a passed date closes it", LC.decayAction(row({ dueDate: "2026-10-02" }), NOW, TODAY).kind === "close_date_passed");
check("evidence beats everything: asked already, date passed -> closed, not expired", LC.decayAction(row({ dueDate: "2026-10-02", decayAskedAt: day("2026-10-01") }), NOW, TODAY).kind === "close_date_passed");
check("decay: no signal for 7 days -> ask once", LC.decayAction(row({ lastConfirmedAt: day("2026-09-29") }), NOW, TODAY).kind === "ask" && LC.decayAction(row({ lastConfirmedAt: day("2026-09-30") }), NOW, TODAY).kind === "none");
check("asked once, still nothing 5 days later -> expire; sooner -> wait", LC.decayAction(row({ lastConfirmedAt: day("2026-09-20"), decayAskedAt: day("2026-10-01") }), NOW, TODAY).kind === "expire" && LC.decayAction(row({ lastConfirmedAt: day("2026-09-20"), decayAskedAt: day("2026-10-03") }), NOW, TODAY).kind === "none");
check("asked once is never asked twice", LC.decayAction(row({ lastConfirmedAt: day("2026-09-20"), decayAskedAt: day("2026-10-05") }), NOW, TODAY).kind === "none");
check("they answered after the ask: the clock restarts (no expire, no second ask yet)", LC.decayAction(row({ lastConfirmedAt: day("2026-10-04"), decayAskedAt: day("2026-10-01") }), NOW, TODAY).kind === "none");
check("closed and expired loops get no action", LC.decayAction(row({ closedAt: NOW, status: "done" }), NOW, TODAY).kind === "none");

// ---- the daily pass, with a fake store
type L = any;
const loops: L[] = [
  { id: 1, title: "Pitch investors Friday", ...row({ lastConfirmedAt: day("2026-09-29"), dueDate: "2026-10-02" }) },
  { id: 2, title: "Find a venue for dinner", ...row({ lastConfirmedAt: day("2026-09-28") }) },
  { id: 3, title: "Find an advisor", ...row({ lastConfirmedAt: day("2026-10-05") }) },
  { id: 4, title: "Old thing", ...row({ lastConfirmedAt: day("2026-09-15"), decayAskedAt: day("2026-09-30") }) },
];
const log: string[] = [];
const deps = { live: async () => loops, close: async (id: number) => { log.push(`close ${id}`); }, expire: async (id: number) => { log.push(`expire ${id}`); }, ask: async (l: L) => { log.push(`ask ${l.id}`); return true; } };
const out = await OL.runLoopDecay(NOW, deps as any);
check("the pass closes the 9/29 pitch on evidence, asks once about the dinner, leaves the fresh one, expires the one asked and ignored", out.closed === 1 && out.asked === 1 && out.expired === 1 && log.join() === "close 1,ask 2,expire 4");
let queued = 0;
await OL.runLoopDecay(NOW, { ...deps, live: async () => [loops[1]], ask: async () => { queued++; return false; } } as any);
const none = await OL.runLoopDecay(NOW, { ...deps, live: async () => [loops[1]], ask: async () => false } as any);
check("an ask that was not queued is not counted, and is simply tried again next pass", queued === 1 && none.asked === 0);
check("a pass asks at most MAX_ASKS_PER_PASS members", await (async () => { let n = 0; const many = Array.from({ length: 25 }, (_, k) => ({ id: 100 + k, title: "t", ...row({ lastConfirmedAt: day("2026-09-20") }) })); await OL.runLoopDecay(NOW, { ...deps, live: async () => many, ask: async () => { n++; return true; } } as any); return n === OL.MAX_ASKS_PER_PASS; })());

// ---- the reviewer's cases (2026-10-06)
check("work Co has scheduled (in motion) is never asked about or expired, even long after anyone confirmed it", LC.decayAction(row({ lastConfirmedAt: day("2026-08-01"), inMotion: true }), NOW, TODAY).kind === "none" && LC.decayAction(row({ lastConfirmedAt: day("2026-09-01"), dueDate: "2026-10-01", inMotion: true }), NOW, TODAY).kind === "none");
check("a loop waiting on someone else's reply is not asked about; the hard limit ends it", LC.decayAction(row({ status: "waiting_on_reply", lastConfirmedAt: day("2026-09-20") }), NOW, TODAY).kind === "none" && LC.decayAction(row({ status: "waiting_on_reply", lastConfirmedAt: day("2026-09-01") }), NOW, TODAY).kind === "expire");
check("30 days with no signal expires it even if the ask never went out", LC.decayAction(row({ lastConfirmedAt: day("2026-09-05") }), NOW, TODAY).kind === "expire" && LC.decayAction(row({ lastConfirmedAt: day("2026-09-07") }), NOW, TODAY).kind === "ask");
check("asked means SENT: the ask sets decay_asked_at in onSent, not at queueing", /async onSent\(c\) \{\s*await pool\.query\(`UPDATE open_loops SET decay_asked_at = NOW\(\)/.test(src("harness/proactiveRegistry.ts")) && !/decay_asked_at = NOW\(\)/.test(src("services/openLoops.ts").replace(/closed_reason[^\n]*/g, "")));
check("an unsent ask is re-queued on a later day (the key carries the day) and never stacks while one is pending", /targetKey: `loop_check:\$\{l\.id\}:\$\{localDay\(new Date\(\), \(l as LoopRow & \{ zone\?: string \| null \}\)\.zone \?\? null\)\}`/.test(src("services/openLoops.ts")) && /type = 'loop_check' AND status = 'pending'/.test(src("services/openLoops.ts")));
check("archived and opted-out members get no loop asks", /u\.archived_at IS NULL AND u\.sms_opted_out = false/.test(src("services/openLoops.ts")));

// ---- what drafting reads
const rows = [
  { id: 1, title: "Pitch investors Friday", status: "open", detail: null, dueDate: "2026-10-02", source: "task", closedAt: null, closedReason: null, lastConfirmedAt: day("2026-09-29"), decayAskedAt: null },
  { id: 2, title: "Find an advisor", status: "open", detail: null, dueDate: null, source: "task", closedAt: null, closedReason: null, lastConfirmedAt: day("2026-10-05"), decayAskedAt: null },
  { id: 3, title: "Venue for dinner", status: "waiting_on_reply", detail: null, dueDate: null, source: "task", closedAt: null, closedReason: null, lastConfirmedAt: day("2026-10-05"), decayAskedAt: null },
];
check("draftableLoops: only the open, recently confirmed one", OL.draftableLoops(rows as any, NOW).map((r: any) => r.id).join() === "2");
const forDraft = OL.describeLoops(rows as any, { now: NOW, today: TODAY, draftOnly: true })!;
check("a draft's loops hold the advisor and nothing about the pitch or the waiting one", /advisor/.test(forDraft) && !/Pitch|Friday|investor|Venue/.test(forDraft) && !/not confirmed lately/.test(forDraft));
const forReply = OL.describeLoops(rows as any, { now: NOW, today: TODAY })!;
check("a reply can see the rest as background, marked not confirmed lately", /Pitch investors Friday[^;]*\[not confirmed lately: check before saying it is current\]/.test(forReply));
check("the advisor line is not marked stale", !/advisor[^;]*not confirmed lately/.test(forReply));
check("nothing draftable -> no loops block at all", OL.describeLoops([rows[0]] as any, { now: NOW, today: TODAY, draftOnly: true }) === null);

// ---- the member's own text confirms a loop they are talking about
const lp = [
  { id: 1, title: "Find a venue for dinner Oct 10", detail: "shortlist: Lola's, Marlow" },
  { id: 2, title: "Find an advisor", detail: null },
  { id: 3, title: "Pitch investors", detail: null },
];
check("talking about the loop confirms it (two content words in common)", OL.loopsMentioned(lp, "Did you hear back from Lola's about the dinner venue?").join() === "1");
check("a short title is confirmed by all of its words", OL.loopsMentioned(lp, "any luck with the advisor?").join() === "2");
check("an unrelated text confirms nothing (so a check-in cannot be kept alive by 'ok thanks')", OL.loopsMentioned(lp, "ok thanks!").length === 0 && OL.loopsMentioned(lp, "how is the weather").length === 0);
check("one shared word in a longer title is not enough", OL.loopsMentioned(lp, "dinner sounds great").length === 0);
let updated: any[] = [];
const dbq = (await import("../../src/db/db.js")).default as any;
dbq.query = async (sql: string, a: any[]) => { updated.push([sql, a]); return { rows: [] }; };
const rowsIn = [{ ...lp[1], lastConfirmedAt: day("2026-09-20") }, { ...lp[2], lastConfirmedAt: day("2026-09-20") }];
const after = await OL.confirmMentioned("u1", rowsIn, "any luck with the advisor?");
check("confirmMentioned writes last_confirmed_at for that loop only, and returns it fresh to the same turn's reply", updated.length === 1 && /SET last_confirmed_at = NOW\(\)/.test(updated[0][0]) && updated[0][1][1].join() === "2" && /user_id = \$1 AND id = ANY\(\$2::bigint\[\]\) AND closed_at IS NULL/.test(updated[0][0]) && +after[0].lastConfirmedAt! > +NOW - 86_400_000 * 2 && +after[1].lastConfirmedAt! === +day("2026-09-20"));
updated = [];
await OL.confirmMentioned("u1", rowsIn, "ok thanks");
check("nothing mentioned, no write", updated.length === 0);
check("a confirmed loop is draftable again, and the decay clock restarts (an ask made before it no longer counts)", LC.isDraftable(row({ lastConfirmedAt: NOW }), NOW, TODAY) && LC.decayAction(row({ lastConfirmedAt: NOW, decayAskedAt: day("2026-09-25") }), NOW, TODAY).kind === "none");
check("the reply path confirms what the member's text is about before it describes the loops", /o\.confirmMentioned\(user\.id, \(await o\.syncOpenLoops\(user\.id\)\)\.rows, content\)/.test(src("routes/sendblue.ts")));

// ---- a reply doesn't hedge on work that is in motion
const mo = [{ id: 9, title: "Find a venue for dinner", status: "open", detail: null, dueDate: null, source: "task", lastConfirmedAt: day("2026-09-10"), inMotion: true }, { id: 10, title: "Old idea about a podcast", status: "open", detail: null, dueDate: null, source: "task", lastConfirmedAt: day("2026-09-10"), inMotion: false }];
const rep = OL.describeLoops(mo as any, { now: NOW, today: TODAY, withIds: true })!;
check("a reply: work Co has scheduled is described plainly even if no one confirmed it lately; the idle one is tagged", !/venue for dinner[^;]*not confirmed lately/.test(rep) && /podcast[^;]*not confirmed lately/.test(rep));
check("but a draft never uses it unless it is open and recently confirmed, in motion or not", !/venue/.test(OL.describeLoops(mo as any, { now: NOW, today: TODAY, draftOnly: true }) ?? ""));
check("the reply's loops carry whether Co has them in motion", /AS in_motion FROM open_loops o LEFT JOIN co_tasks/.test(src("services/openLoops.ts")));

// ---- wiring
const ol = src("services/openLoops.ts"), pm = src("services/personModel.ts"), mig = src("db/migrations.ts");
check("check-ins, tasks, the sweep and calls read loops through the draft filter", /describeLoops\(loops, \{ draftOnly: true, zone \}\)/.test(pm) && /last_confirmed_at, decay_asked_at FROM open_loops/.test(pm));
check("an expired or date-passed loop is a tombstone the sync never reopens (unless they signal after it)", /closed_reason IN \('co', 'expired', 'date_passed'\)/.test(ol) && /signalAt/.test(ol));
check("what Co does at their word confirms a loop; a sync alone doesn't", /updated_at = NOW\(\), last_confirmed_at = NOW\(\)/.test(ol) && !/changed_at = NOW\(\)" : ""\}[^`]*last_confirmed_at = NOW/.test(ol));
check("the columns exist and old rows start from their last touch", /ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS decay_asked_at/.test(mig) && /SET last_confirmed_at = COALESCE\(updated_at, changed_at, created_at\)/.test(mig));
check("the decay pass runs with the loop sync", /runLoopDecay\(\)/.test(src("jobs/index.ts")));
check("the ask is a registered proactive type, a question, once per loop", /loop_check: \{/.test(src("harness/proactiveRegistry.ts")) && /targetKey: `loop_check:\$\{l\.id\}:/.test(ol) && /loop_check: "companion"/.test(src("harness/proactivePurpose.ts")) && /loop_check: \{ priority/.test(src("harness/proactive.ts")));

console.log(`loop lifecycle: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
