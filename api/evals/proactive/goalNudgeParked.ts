// The goal nudge is parked (Royce, 2026-10-17: "Park the goal nudge." / "Goal nudge: park it."). services/proactivePause.ts
// PARKED_TYPES: the hourly pass never queues one, and one already pending is never loaded, picked, drafted or sent. Its code is kept,
// and the other member-state nudges (intro, deadline, commitment) still queue.
// Layer 1: pure planner, plus the dispatcher in dry run on a fake store. Zero tokens, no DB.
//   npx tsx evals/proactive/goalNudgeParked.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
const { default: pool } = await import("../../src/db/db.js");
const N = await import("../../src/services/memberStateNudges.js");
const PP = await import("../../src/services/proactivePause.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

const ZONE = "America/Los_Angeles";
const DAY = 86_400_000;
const pt = (iso: string) => new Date(`${iso}-07:00`);
type Snap = import("../../src/services/memberStateNudges.js").Snapshot;
const base = (now: Date, over: Partial<Snap> = {}): Snap => ({
  userId: "u-jordan", zone: ZONE, now, ownLines: [], intros: [], cared: [], goals: [], intent: [], lastGoalSurfaceAt: null, lastKeptAt: null, commitments: [], ...over,
});

// ================================================================ 1. the list, in code
check("goal_nudge is parked, and only it", PP.PARKED_TYPES.includes("goal_nudge") && PP.PARKED_TYPES.length === 1, PP.PARKED_TYPES);
check("parked is held by the dispatcher with no env set", PP.heldTypes({} as any).includes("goal_nudge"), PP.heldTypes({} as any));
check("the env pause list still adds to it", PP.heldTypes({ PROACTIVE_PAUSED_TYPES: "ask_checkin" } as any).join() === "ask_checkin,goal_nudge", PP.heldTypes({ PROACTIVE_PAUSED_TYPES: "ask_checkin" } as any));

// ================================================================ 2. the hourly pass: detected, never queued; the others still queue
{
  const now = pt("2026-10-08T12:00:00");
  const goal = { id: "g1", text: "Raise a pre-seed round for the climate startup", confirmedAt: new Date(now.getTime() - 30 * DAY), state: "active" as const, coTask: false };
  const intro = { otherId: "u-ellis", otherFirstName: "Ellis", introducedAt: pt("2026-10-04T12:00:00"), how: "network" as const, eventName: null, reasonAsEmailed: null, hasOutcomeFollowup: false, otherActive: true };
  const commitment = { threadId: "t1", text: "send the deck to Noor", quote: "I'll send Noor the deck Friday", openedAt: pt("2026-10-05T18:00:00"), dueDate: "2026-10-09", status: "open", followedUp: false };
  const s = base(now, { goals: [goal], intros: [intro], commitments: [commitment] });
  check("the detector is kept: a goal quiet 30 days is still detected", N.detectGoalNudge(s).length === 1 && N.detectAll(s).some((e) => e.type === "goal_nudge"));
  const plan = N.planNudges(s, []);
  check("the hourly pass never queues a goal nudge", !plan.queue.some((e) => e.type === "goal_nudge"), plan.queue.map((e) => e.type));
  check("it is held, and says it is parked", plan.held.some((h) => h.entry.type === "goal_nudge" && /parked/.test(h.why)), plan.held.map((h) => [h.entry.type, h.why]));
  check("intro and commitment nudges in the same pass still queue", plan.queue.some((e) => e.type === "intro_nudge") && plan.queue.some((e) => e.type === "commitment_nudge"), plan.queue.map((e) => e.type));
}

// ================================================================ 3. one already pending: never loaded, picked or drafted
{
  const RealDate = Date;
  const FIXED = new RealDate("2026-10-13T18:00:00Z").getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(FIXED); }
    static now() { return FIXED; }
  } as DateConstructor;
  const P = await import("../../src/harness/proactive.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const realQuery = pool.query;
  const pending = [{
    id: "c-goal", user_id: "dry-u", type: "goal_nudge", target_key: "goal_nudge:goal:g1:fp", topic_key: "msn:goal:g1:fp", summary: "A goal gone quiet for 30 days", priority: 11,
    due_at: new Date(FIXED - 60_000), expires_at: new Date(FIXED + 4 * DAY), attempts: 0, created_at: new Date(FIXED - 3_600_000),
    payload: { entryKey: "goal:g1", fingerprint: "fp", kind: "goal_nudge", facts: { the_goal_in_their_words: "Raise a pre-seed round" }, meta: { goalId: "g1", goalHash: null } },
  }];
  let loadedTypes: string[] | null = null;
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql).trim();
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) return { rows: [], rowCount: 0 };
    if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Jordan", phone_number: "+14155550199", sms_opted_out: false, city: "San Francisco" }] };
    // The candidate load: the store answers it the way Postgres would, leaving out the types it was told to leave out.
    if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending' AND NOT \(type = ANY\(\$2::text\[\]\)\)/i.test(q)) {
      const skip: string[] = Array.isArray(params[1]) ? params[1] : [];
      const rows = pending.filter((r) => !skip.includes(r.type));
      loadedTypes = rows.map((r) => r.type);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  };
  const realDraft = (proactiveRegistry as any).goal_nudge.draft;
  let drafted = 0;
  (proactiveRegistry as any).goal_nudge.draft = async (...a: any[]) => { drafted++; return realDraft(...a); };
  let modelCalls = 0;
  P.setProactiveModelForTests((async () => { modelCalls++; return "Still chasing the pre-seed round?"; }) as any);
  const log = console.log, err = console.error;
  const printed: string[] = [];
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  await P.dispatchForUser(proactiveRegistry, "dry-u", { dryRun: true, ignorePacing: true }).catch((e: any) => printed.push(`THREW ${e?.message}`));
  console.log = log; console.error = err;
  P.setProactiveModelForTests(null);
  (proactiveRegistry as any).goal_nudge.draft = realDraft;
  (pool as any).query = realQuery;
  globalThis.Date = RealDate;
  check("the dispatcher read its pending candidates", loadedTypes !== null, printed.slice(0, 5));
  check("a pending goal nudge is never loaded", Array.isArray(loadedTypes) && !(loadedTypes as string[]).includes("goal_nudge"), loadedTypes);
  check("so it is never drafted, and no model is asked", drafted === 0 && modelCalls === 0, { drafted, modelCalls });
  check("and nothing would send", !printed.some((l) => /would send/.test(l)) && !printed.some((l) => l.startsWith("THREW")), printed.filter((l) => /would send|THREW/.test(l)));
  check("its code is kept: still registered with a draft, so it can be turned back on", typeof (proactiveRegistry as any).goal_nudge?.draft === "function" && !!(P.TYPE_POLICY as any).goal_nudge);
}

// ================================================================ 4. the one goal nudge left: the goal recheck (services/goalRecheck.ts)
// Royce (2026-10-17): "verify the helper covers what the old one did: quiet goal, one nudge, an ignored nudge gets let go. Show me
// anything it doesn't cover." Pinned here so the coverage claim in the PR stays true.
{
  const R = await import("../../src/services/goalRecheck.js");
  const G = await import("../../src/services/goalEdges.js");
  const NOW = new Date("2026-10-17T18:00:00Z");
  const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
  const GOAL = "Raise a pre-seed round for the climate startup";
  const row = (over: Record<string, unknown> = {}): import("../../src/services/goalRecheck.js").RecheckRow => ({
    goalHash: G.goalHash(GOAL), goal: GOAL, state: "active", reason: "", source: "context", changedAt: ago(60), lastSignalAt: ago(30), recheckAskedAt: null, searched: true, hints: 0, ...over,
  } as any);
  const one = (r: ReturnType<typeof row>, o: Record<string, unknown> = {}) => R.recheckDecide({ rows: [r], now: NOW, signals: [], lastExchangeAt: null, held: [], pendingText: [], ...o } as any)[0];
  check("covered (a): a quiet goal (14+3 days, nothing from them) gets one text", one(row({ lastSignalAt: ago(17) })).action === "text");
  check("covered (b): once asked, it is never asked again in the same quiet stretch (waiting, not due)", one(row({ lastSignalAt: ago(25), recheckAskedAt: ago(3) })).action === "asked");
  check("covered (c): ignored for 7 days, the goal is let go (idle, no longer searched)", one(row({ lastSignalAt: ago(30), recheckAskedAt: ago(7) })).action === "idle");
  const idle = row({ state: "stale", reason: R.RECHECK_IDLE_REASON, source: "context", changedAt: ago(1), lastSignalAt: ago(90), recheckAskedAt: ago(8) });
  check("covered (c): an idle goal is never asked again, however long it stays quiet", one(idle).action === "none");
  check("NOT covered: a goal the sweep isn't searching (a work plan) is never rechecked; the parked nudge did surface it", one(row({ lastSignalAt: ago(40), searched: false })).action === "none" && N.detectGoalNudge(base(pt("2026-10-06T11:00:00"), { goals: [{ id: "g1", text: GOAL, confirmedAt: new Date(pt("2026-10-06T11:00:00").getTime() - 30 * DAY), state: "active", coTask: false }] })).length === 1);
}

console.log(`\ngoal nudge parked: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
