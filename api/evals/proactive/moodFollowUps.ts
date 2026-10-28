// followup_skip_wait (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). The follow-up decider sees "they've been
// having a hard time lately" and could skip, which closed the follow-up for good. Now: the decider is told how they feel is never a
// reason to skip; a skip while the hard day's hold is on (and not one for space) is one wait (followup.moodWaitAt), the task sleeps
// without a model call until they're okay or the cap, then the decider looks again with the feeling as tone only. A second skip, a skip
// for space, or a skip when they're not struggling closes it as before. The waits don't spend its looks; its own clock still ends it.
// Logs: rule and kind, never their words.
// Layer 1: pure functions and the skip and wait paths on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/proactive/moodFollowUps.ts
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");
const F = await import("../../src/services/followUps.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const HOUR = 3_600_000;
const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
const THEIR_WORDS = "my dad is back in the hospital and I can't think";
const hard = (h: number): Sig => ({ source: "text", emotion: "scared", intensity: "high", valence: "negative", about: "their dad in the hospital", quote: THEIR_WORDS, at: ago(h), target: "life" });
const read = (sigs: Sig[], lastIn: Date | null) => MH.moodHold(E.summarizeSignals(sigs, NOW), { now: NOW, lastInboundAt: lastIn });
const HELD = read([hard(2)], ago(2.1));
const OKAY = read([hard(8)], ago(1));
const CAP = read([hard(1), hard(20), hard(40), hard(49)], ago(1.5));
const CALM = read([], null);

// ================================================================ 1. which skip waits
{
  check("the cap is the one shared constant", MH.MOOD_HOLD_CAP_HOURS === 48);
  check("struggling, a skip: its one wait", F.followUpMoodWait({ waitedAt: null, because: "no_longer_matters", read: HELD }) && F.followUpMoodWait({ waitedAt: null, because: null, read: HELD }));
  check("a skip because they asked for space is their own ask: closed, never a wait", !F.followUpMoodWait({ waitedAt: null, because: "asked_for_space", read: HELD }));
  // Review of #274 (2026-10-27): they already answered is a fact, not a mood: looking again risks asking what they told Cue.
  check("a skip because they already answered: closed, never a wait", !F.followUpMoodWait({ waitedAt: null, because: "answered", read: HELD }));
  check("one wait: a second skip closes", !F.followUpMoodWait({ waitedAt: ago(30).toISOString(), because: null, read: HELD }));
  check("okay again, at the stretch's cap, or not struggling: a skip closes as before", [OKAY, CAP, CALM].every((r) => !F.followUpMoodWait({ waitedAt: null, because: null, read: r })));
}

// ================================================================ 2. the wait: held, released early, released at the cap
{
  const w = (h: number, r: any) => F.followUpStillWaiting({ waitedAt: ago(h).toISOString(), read: r, now: NOW });
  check("waiting: held", w(1, HELD)?.hold === true);
  check("released early when they're okay, or the read clears", w(1, OKAY)?.hold === false && w(1, CALM)?.hold === false);
  check("released at the cap after the skip even if still struggling", w(48, HELD)?.state === "released_cap" && w(47, HELD)?.hold === true);
  check("released when the stretch reaches its cap (total wait never past the cap)", w(1, CAP)?.hold === false);
  check("not waiting: nothing", F.followUpStillWaiting({ waitedAt: null, read: HELD, now: NOW }) === null);
  const hours = F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW });
  check("it looks again within the okay window, never past the cap", hours <= MH.OKAY_AFTER_HOURS && hours >= F.FOLLOWUP_LIMITS.minHours && F.followUpWakeHours({ waitedAt: ago(46).toISOString(), now: NOW }) <= 2);
  // A window that ends (review of #266): a skip at 0h with the window ending at +2h slept 6h and checked in after the window.
  const inH = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString();
  const w0 = F.followUpWakeHours({ waitedAt: NOW.toISOString(), now: NOW, until: inH(2) });
  check("a window ending in 2h: a skip at 0h wakes at its last moment (10 minutes before), never past it", Math.abs(w0 - (2 - 10 / 60)) < 1e-9, w0);
  check("its last moment already here or past: it looks now, no extra wait", F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW, until: inH(5 / 60) }) === 0 && F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW, until: ago(1).toISOString() }) === 0);
  check("an until that doesn't parse: no clamp, the okay window as before (never NaN)", F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW, until: "not a date" }) === hours && Number.isFinite(F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW, until: "2026-13-45T99:00" })));
  check("a window far off, or none: the okay window as before", F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW, until: inH(72) }) === hours && F.followUpWakeHours({ waitedAt: ago(1).toISOString(), now: NOW, until: null }) === hours);
}

// ================================================================ 3. the decider is told: tone, never a reason to skip
{
  const knowledge = F.followUpKnowledge({ restraint: { needsCare: true, frustratedWithCo: false, safetyHold: false, feeling: null } as any, delivered: [], corrections: [], lessons: [] }, NOW);
  check("struggling: the decider reads how they feel shapes when and how, never whether", /how they feel shapes when and how you check in, never whether/.test(knowledge), knowledge);
  check("calm: no such line", !/never whether/.test(F.followUpKnowledge({ restraint: { needsCare: false, frustratedWithCo: false, safetyHold: false, feeling: null } as any, delivered: [], corrections: [], lessons: [] }, NOW)));
  const prompt = F.followUpPrompt({ task: { id: 1, goal: "g", wakes: 1, followup: { type: "companion", summary: "how the pitch went", payload: {} } } as any, firstName: "Jordan", recent: "", recentSends: "", now: "now" });
  check("the skip tool asks why, and says a feeling is never a reason to skip", /Say which in "because": answered, asked_for_space, or no_longer_matters\. How they feel is never a reason to skip/.test(prompt));
  check("after its wait the decider gets the gentle line, model-facing only", /knowledge: f\?\.moodWaitAt \? \[ctx\.knowledge, FOLLOWUP_GENTLE\]/.test(src("services/followUps.ts")) && /keep it soft/.test(F.FOLLOWUP_GENTLE) && !/"/.test(F.FOLLOWUP_GENTLE));
  check("safety unchanged: the decider still reads a safety hold as care only", /a safety hold is on \(only care, no offers or nudges\)/.test(src("services/followUps.ts")));
}

// ================================================================ 4. the skip and the wait on a fake store
{
  const realQuery = pool.query;
  const writes: { sql: string; params: any[] }[] = [];
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) writes.push({ sql: q, params });
    if (/^SELECT \* FROM co_tasks/i.test(q) || /FROM co_tasks WHERE user_id = \$1 AND id = \$2/i.test(q)) return { rows: [{ id: 71, user_id: "u-jordan", status: "open", goal: "g", their_words: "", steps: [], kind: "followup", followup: {}, wakes: 1, created_at: NOW, next_check_at: NOW }] };
    return { rows: [], rowCount: 0 };
  };
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const task = (followup: Record<string, unknown>) => ({ id: 71, userId: "u-jordan", goal: "g", planNext: "ask how the pitch landed", wakes: 2, createdAt: ago(30), followup: { type: "companion", targetKey: "companion:pitch", summary: `About ${THEIR_WORDS}`, payload: {}, ...followup } }) as any;
  const run = async (fn: () => Promise<unknown>) => { writes.length = 0; const r = await fn(); return { r, w: writes.slice() }; };
  const closed = (w: { sql: string }[]) => w.some((x) => /UPDATE co_tasks SET status/i.test(x.sql) || /status = \$3/.test(x.sql) && /closed|dropped/.test(JSON.stringify(x)));
  const a = await run(() => F.handleFollowUpSkip("u-jordan", task({}), "no_longer_matters", null, HELD, NOW));
  const b = await run(() => F.handleFollowUpSkip("u-jordan", task({ moodWaitAt: ago(50).toISOString() }), "no_longer_matters", null, HELD, NOW));
  const c = await run(() => F.handleFollowUpSkip("u-jordan", task({}), "they asked for a break", "asked_for_space", HELD, NOW));
  const d = await run(() => F.handleFollowUpSkip("u-jordan", task({}), "answered", "answered", CALM, NOW));
  const e = await run(() => F.followUpWaitGate("u-jordan", task({ moodWaitAt: ago(1).toISOString() }), HELD, NOW));
  const g = await run(() => F.followUpWaitGate("u-jordan", task({ moodWaitAt: ago(1).toISOString() }), OKAY, NOW));
  const h = await run(() => F.followUpWaitGate("u-jordan", task({ moodWaitAt: ago(49).toISOString() }), HELD, NOW));
  const untilAt = new Date(NOW.getTime() + 2 * HOUR);
  const win = await run(() => F.handleFollowUpSkip("u-jordan", task({ payload: { until: untilAt.toISOString() } }), "no_longer_matters", null, HELD, NOW));
  const winGate = await run(() => F.followUpWaitGate("u-jordan", task({ moodWaitAt: ago(1).toISOString(), payload: { until: untilAt.toISOString() } }), HELD, NOW));
  console.log = log; console.error = err;
  (pool as any).query = realQuery;
  const stamped = (w: { sql: string }[]) => w.some((x) => /'\{moodWaitAt\}'/.test(x.sql) && !/SET status/.test(x.sql));
  const unspent = (w: { sql: string }[]) => w.some((x) => /wakes = GREATEST\(wakes - 1, 0\)/.test(x.sql));
  const keepsPlan = (w: { sql: string; params: any[] }[]) => w.some((x) => /SET next_check_at = \$3, plan_next = \$4/.test(x.sql) && x.params[3] === "ask how the pitch landed");
  check("struggling: the skip waits (stamped, asleep, its look not spent, its plan unchanged), never closed", a.r === "waits" && stamped(a.w) && unspent(a.w) && keepsPlan(a.w), a.w.map((x) => x.sql.slice(0, 80)));
  check("a second skip after its wait: closed as before", b.r === "closed");
  check("a skip for space: closed as before", c.r === "closed");
  check("not struggling: closed as before", d.r === "closed");
  check("waiting at the next look: it sleeps again with no model call, its look not spent", e.r === true && unspent(e.w) && !stamped(e.w));
  check("released when they're okay: the decider looks again", g.r === false);
  check("released at the cap after the skip even if still struggling: the decider looks again", h.r === false);
  const wokenAt = (w: { sql: string; params: any[] }[]) => w.filter((x) => /SET next_check_at = \$3, plan_next = \$4/.test(x.sql)).map((x) => new Date(x.params[2]).getTime());
  const lastMoment = untilAt.getTime() - 10 * 60_000;
  check("a skip inside a window that ends: it waits, waking by the window's last moment, where it goes", win.r === "waits" && wokenAt(win.w).length === 1 && wokenAt(win.w)[0] <= lastMoment && wokenAt(win.w)[0] > NOW.getTime(), wokenAt(win.w).map((t) => (t - NOW.getTime()) / HOUR));
  check("still waiting, inside that window: it sleeps again only to its last moment", winGate.r === true && wokenAt(winGate.w).every((t) => t <= lastMoment) && wokenAt(winGate.w).length === 1);
  check("runFollowUpTurn: the window's last moment goes before any mood wait", src("services/followUps.ts").indexOf("if (atWindowEnd(new Date(), until)) {") > 0 && src("services/followUps.ts").indexOf("if (atWindowEnd(new Date(), until)) {") < src("services/followUps.ts").indexOf("await followUpWaitGate(userId, task, mood)"));
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("the wait is logged with the rule and the kind", lines.some((l) => /rule=followup_skip_wait kind=followup:companion ref=u-jordan:71 held/.test(l)), lines);
  check("logs carry no member text", lines.length > 0 && lines.every((l) => !l.includes("hospital") && !l.includes("pitch") && !l.includes("Jordan")), lines);
  check("runFollowUpTurn: the wait gate runs before the decider, and the skip goes through handleFollowUpSkip", /if \(await followUpWaitGate\(userId, task, mood\)\) \{/.test(src("services/followUps.ts")) && /await handleFollowUpSkip\(userId, task, why, because, mood\);/.test(src("services/followUps.ts")) && src("services/followUps.ts").indexOf("await followUpWaitGate(userId, task, mood)") < src("services/followUps.ts").indexOf("const r = await runFollowUpTurnWith(task, {"));
  check("its own clock still ends it (the expiry check runs first, unchanged)", /if \(task\.wakes > FOLLOWUP_LIMITS\.maxWakes \|\| age > FOLLOWUP_LIMITS\.maxDays \* 86_400_000\) \{/.test(src("services/followUps.ts")));
}

console.log(`\nfollow-ups wait: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
