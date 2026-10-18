// One goal nudge (Royce, 2026-10-17: "'the Nudges helper' is the goal recheck, rows 1 to 3. That is the one goal nudge. It replaces
// 'goal gone quiet', which does the same job later and has never fired."). A goal quiet for 21-55 days takes the recheck path
// (services/goalRecheck.ts), never the parked goal_nudge (services/proactivePause.ts PARKED_TYPES), and a goal_nudge already queued
// sends nothing while the recheck's text still goes through the dispatcher.
// Layer 1: pure planners, plus the dispatcher in dry run on a fake store. Zero tokens, no DB.   npx tsx evals/goals/oneGoalNudge.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
const { default: pool } = await import("../../src/db/db.js");
const N = await import("../../src/services/memberStateNudges.js");
const R = await import("../../src/services/goalRecheck.js");
const G = await import("../../src/services/goalEdges.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

const DAY = 86_400_000;
const NOW = new Date("2026-10-13T18:00:00Z");
const GOAL = "Raise a pre-seed round for the climate startup";

// ================================================================ 1. quiet 21-55 days: the recheck, never the parked nudge
for (const quietDays of [21, 30, 45, 55]) {
  const confirmedAt = new Date(NOW.getTime() - quietDays * DAY);
  // The member-state pass (the parked nudge's detector still sees it; nothing is queued).
  const snap = { userId: "u-jordan", zone: "America/Los_Angeles", now: NOW, ownLines: [], intros: [], cared: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [],
    goals: [{ id: "g1", text: GOAL, confirmedAt, state: "active" as const, coTask: false, hash: G.goalHash(GOAL) }] };
  const plan = N.planNudges(snap as any, []);
  check(`${quietDays} days quiet: the parked nudge queues nothing`, !plan.queue.some((e) => e.type === "goal_nudge"), plan.queue.map((e) => e.type));
  // The recheck (a searched goal, nothing from them since it was set): its one text.
  const step = R.recheckDecide({
    rows: [{ goalHash: G.goalHash(GOAL), goal: GOAL, state: "active", reason: "", source: "context", changedAt: confirmedAt, lastSignalAt: confirmedAt, recheckAskedAt: null, searched: true, hints: 0 }],
    now: NOW, signals: [], lastExchangeAt: null, held: [], pendingText: [],
  } as any)[0];
  check(`${quietDays} days quiet: the recheck sends its one text`, step.action === "text", step);
}

// ================================================================ 2. both queued: the dispatcher drafts the recheck, never the nudge
{
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(NOW.getTime()); }
    static now() { return NOW.getTime(); }
  } as DateConstructor;
  const P = await import("../../src/harness/proactive.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const realQuery = pool.query;
  const row = (id: string, type: string, payload: any, priority: number) => ({ id, user_id: "dry-u", type, target_key: `${type}:goal:g1`, topic_key: `${type}:g1`, summary: `${type} on the pre-seed goal`, priority, due_at: new Date(NOW.getTime() - 60_000), expires_at: new Date(NOW.getTime() + 3 * DAY), attempts: 0, created_at: new Date(NOW.getTime() - 3_600_000), payload });
  const pending = [
    row("c-nudge", "goal_nudge", { entryKey: "goal:g1", fingerprint: "fp", kind: "goal_nudge", facts: { the_goal_in_their_words: GOAL }, meta: { goalId: "g1", goalHash: G.goalHash(GOAL) } }, 11),
    row("c-recheck", "goal_recheck", { goalHash: G.goalHash(GOAL), queuedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), lastSignalAt: new Date(NOW.getTime() - 30 * DAY).toISOString() }, 10),
  ];
  let loaded: string[] | null = null;
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql).trim();
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) return { rows: [], rowCount: 0 };
    if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Jordan", phone_number: "+14155550199", sms_opted_out: false, city: "San Francisco" }] };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending' AND NOT \(type = ANY\(\$2::text\[\]\)\)/i.test(q)) {
      const skip: string[] = Array.isArray(params[1]) ? params[1] : [];
      const rows = pending.filter((r) => !skip.includes(r.type));
      loaded = rows.map((r) => r.type);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  };
  const drafted: string[] = [];
  const real = { nudge: (proactiveRegistry as any).goal_nudge.draft, recheck: (proactiveRegistry as any).goal_recheck.draft };
  (proactiveRegistry as any).goal_nudge.draft = async (...a: any[]) => { drafted.push("goal_nudge"); return real.nudge(...a); };
  (proactiveRegistry as any).goal_recheck.draft = async (...a: any[]) => { drafted.push("goal_recheck"); return real.recheck(...a); };
  P.setProactiveModelForTests((async () => "Still want things for the pre-seed round, or has it run its course?") as any);
  const log = console.log, err = console.error;
  const printed: string[] = [];
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  await P.dispatchForUser(proactiveRegistry, "dry-u", { dryRun: true, ignorePacing: true }).catch((e: any) => printed.push(`THREW ${e?.message}`));
  console.log = log; console.error = err;
  P.setProactiveModelForTests(null);
  (proactiveRegistry as any).goal_nudge.draft = real.nudge;
  (proactiveRegistry as any).goal_recheck.draft = real.recheck;
  (pool as any).query = realQuery;
  globalThis.Date = RealDate;
  check("the dispatcher loads the recheck and leaves the parked nudge out", JSON.stringify(loaded) === JSON.stringify(["goal_recheck"]), loaded);
  check("the recheck is the one drafted; the parked nudge never is", drafted.join() === "goal_recheck", drafted);
  check("nothing threw", !printed.some((l) => l.startsWith("THREW")), printed.filter((l) => l.startsWith("THREW")));
}

console.log(`\none goal nudge: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
