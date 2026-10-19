// draft_skip_wait (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). Every proactive draft sees how they've been
// feeling (draftProactive's feeling block) and may answer SKIP, and a SKIP was dropped (dropCandidate), including a check-in the hard
// day's hold had just released at the cap. Now a model SKIP while they're struggling waits once (moodDraftSkipAt, mood_draft_wait) and is
// written again once they're okay, or at the cap after the skip, the feeling as tone only. A skip code decides is never a mood and is
// dropped as before, and so is a second SKIP or a SKIP when they're not struggling. Safety is unchanged. Logs: rule and kind, no words.
// Layer 1: pure functions, then dispatchForUser on a fake store with a stubbed draft model. Zero tokens, no DB, nothing sent.
//   npx tsx evals/proactive/moodDraftSkips.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const HOUR = 3_600_000, DAY = 24 * HOUR;
// A weekday late morning in their zone, so their hours never decide a check here.
const RealDate = Date;
const FIXED = new RealDate("2026-10-13T18:00:00Z").getTime();
globalThis.Date = class extends RealDate {
  constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(FIXED); }
  static now() { return FIXED; }
} as DateConstructor;
const NOW = new Date(FIXED);
const ago = (h: number) => new Date(FIXED - h * HOUR);
const P = await import("../../src/harness/proactive.js");
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
const THEIR_WORDS = "my dad is back in the hospital and I can't think";
const hard = (h: number): Sig => ({ source: "text", emotion: "scared", intensity: "high", valence: "negative", about: "their dad in the hospital", quote: THEIR_WORDS, at: ago(h), target: "life" });
const read = (sigs: Sig[], lastIn: Date | null) => MH.moodHold(E.summarizeSignals(sigs, NOW), { now: NOW, lastInboundAt: lastIn });
const HELD = { needsCare: true, moodHold: read([hard(2)], ago(2.1)) };
const OKAY = { needsCare: true, moodHold: read([hard(8)], ago(1)) };
const CAP = { needsCare: true, moodHold: read([hard(1), hard(20), hard(40), hard(49)], ago(1.5)) };
const CALM = { needsCare: false, moodHold: read([], null) };
const cand = (type: string, payload: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ id: "c1", userId: "u", type, targetKey: `${type}:1`, topicKey: `${type}:t`, summary: `About ${THEIR_WORDS}`, payload, priority: 10, dueAt: ago(1), expiresAt: new Date(FIXED + 5 * DAY), attempts: 0, createdAt: ago(2), ...over }) as any;
const baseState = (over: Record<string, unknown> = {}) => ({ now: NOW, sends: [], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, ...over }) as any;
const failsOn = (checks: { name: string; pass: boolean }[], name: string) => checks.some((k) => k.name === name && !k.pass);

// ================================================================ 1. which skip waits
{
  check("the cap is the one shared constant", MH.MOOD_HOLD_CAP_HOURS === 48);
  const c = cand("companion");
  check("struggling, the model's SKIP: its one wait", P.firstDraftMoodWait(c, "model chose SKIP", HELD) && P.firstDraftMoodWait(c, "model chose SKIP: no specific open thread", HELD));
  check("released at the cap but still struggling, the model's SKIP: its one wait too", P.firstDraftMoodWait(c, "model chose SKIP", CAP));
  check("okay again or not struggling: a normal skip", !P.firstDraftMoodWait(c, "model chose SKIP", OKAY) && !P.firstDraftMoodWait(c, "model chose SKIP", CALM));
  check("a skip code decided is never a mood (dropped as before)", ["Cue owns this thread: an open task delivers it", "the state it was about has changed", "not the moment: they've texted since", "the moment isn't confirmed by them: only theirs to say"].every((r) => !P.firstDraftMoodWait(c, r, HELD)));
  check("one wait per item: a second SKIP is a normal skip", !P.firstDraftMoodWait(cand("companion", { moodDraftSkipAt: ago(50).toISOString() }), "model chose SKIP", HELD));
}

// ================================================================ 2. the wait: held, released early, released at the cap
{
  const stamped = (h: number, over: Record<string, unknown> = {}) => cand("companion", { moodDraftSkipAt: ago(h).toISOString() }, over);
  check("struggling: it waits (mood_draft_wait)", failsOn(P.candidateChecks(stamped(1), baseState(HELD)), "mood_draft_wait"));
  check("released at the cap after the skip even if still struggling", !failsOn(P.candidateChecks(stamped(48), baseState(HELD)), "mood_draft_wait") && failsOn(P.candidateChecks(stamped(47), baseState(HELD)), "mood_draft_wait"));
  check("the stretch's cap doesn't end the draft's own wait (it waited 1h of 48)", failsOn(P.candidateChecks(stamped(1), baseState(CAP)), "mood_draft_wait"));
  check("released early when they're okay, or the read clears", !failsOn(P.candidateChecks(stamped(1), baseState(OKAY)), "mood_draft_wait") && !failsOn(P.candidateChecks(stamped(1), baseState(CALM)), "mood_draft_wait"));
  check("never stamped: no wait", !failsOn(P.candidateChecks(cand("companion"), baseState(HELD)), "mood_draft_wait"));
  check("its own expiry still ends it", failsOn(P.candidateChecks(stamped(1, { expiresAt: ago(0.1) }), baseState(HELD)), "not_expired"));
  for (const [label, s] of [["held", HELD], ["okay", OKAY], ["cap", CAP]] as const) {
    check(`safety hold unchanged (${label})`, failsOn(P.candidateChecks(cand("event_offer", { moodDraftSkipAt: ago(1).toISOString() }), baseState({ ...s, safetyHold: true })), "safety_hold"));
  }
  check("planning carries on: no sweep waits on it", Object.values(P.SWEEP_BLOCKERS).every((b) => !b.includes("mood_draft_wait")));
  check("tone only at release: the feeling block every draft sees already says it's never a reason to SKIP (no prompt changed)", /HOW THEY'VE BEEN FEELING \(let it shape how you say this, never whether you say it: it's not a reason to SKIP\./.test(src("harness/proactive.ts")));
}

// ================================================================ 3. dispatch on a fake store: waits, then a second SKIP drops; a normal skip drops
{
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const realQuery = pool.query;
  const writes: { sql: string; params: any[] }[] = [];
  let sigRows: Sig[] = [];
  let lastIn: Date | null = null;
  let pending: any[] = [];
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql).trim();
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) { writes.push({ sql: q, params }); return { rows: [], rowCount: 0 }; }
    if (/FROM emotion_signals/i.test(q)) return { rows: sigRows.map((s) => ({ ...s, created_at: s.at })) };
    if (/MAX\(created_at\) AS at FROM co_memories/i.test(q)) return { rows: [{ at: lastIn }] };
    if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Jordan", phone_number: "+14155550199", sms_opted_out: false, city: "San Francisco" }] };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/i.test(q)) return { rows: pending };
    return { rows: [], rowCount: 0 };
  };
  let prompts: string[] = [];
  let answer = "SKIP";
  P.setProactiveModelForTests((async (prompt: string) => { prompts.push(prompt); return answer; }) as any);
  const row = (payload: Record<string, unknown> = {}) => ({ id: "51", user_id: "u-jordan", type: "companion", target_key: "companion:51", topic_key: "companion:t", summary: `Check in on ${THEIR_WORDS}`, priority: 10, due_at: new Date(FIXED - HOUR), expires_at: new Date(FIXED + 5 * DAY), attempts: 0, created_at: new Date(FIXED - 2 * HOUR), payload: { recap: "", thread: { text: "the pitch to the second fund", quote: "pitching the second fund Thursday", dueDate: null, feeling: null }, ...payload } });
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const runOnce = async (dryRun = false) => { writes.length = 0; prompts = []; await P.dispatchForUser(proactiveRegistry, "u-jordan", { ignorePacing: true, dryRun }).catch((e: any) => printed.push(`THREW ${e?.message}`)); return { writes: writes.slice(), prompts: prompts.slice() }; };
  const dropped = (w: { sql: string }[]) => w.some((x) => /UPDATE proactive_candidates SET status = \$2/.test(x.sql));
  const stampedW = (w: { sql: string }[]) => w.some((x) => /'\{moodDraftSkipAt\}'/.test(x.sql) && !/SET status/.test(x.sql) && !/expires_at/.test(x.sql));

  // a) struggling (a companion check-in isn't held by the check-in hold): the model's SKIP waits.
  sigRows = [hard(2)]; lastIn = ago(2.1); pending = [row()];
  const a = await runOnce();
  // b) still struggling, its one wait used (stamped 49h ago, past its cap): a second SKIP drops it as a normal skip.
  pending = [row({ moodDraftSkipAt: ago(49).toISOString() })];
  const b = await runOnce();
  // c) not struggling: a normal SKIP drops, as before.
  sigRows = []; lastIn = ago(30); pending = [row()];
  const c = await runOnce();
  // d) a released wait is written again, and it would go (a dry run: drafted and printed, nothing written or sent).
  sigRows = [hard(8)]; lastIn = ago(1); pending = [row({ moodDraftSkipAt: ago(3).toISOString() })]; answer = "How did the pitch to the second fund land?";
  const d = await runOnce(true);
  console.log = log; console.error = err;
  P.setProactiveModelForTests(null);
  (pool as any).query = realQuery;
  globalThis.Date = RealDate;
  check("a) the draft was asked, saw the feeling block, and chose SKIP", a.prompts.length >= 1 && a.prompts.some((p) => /HOW THEY'VE BEEN FEELING/.test(p)), a.prompts.length);
  check("a) struggling: stamped and kept, never dropped", stampedW(a.writes) && !dropped(a.writes), a.writes.map((w) => w.sql.slice(0, 90)));
  check("b) its second SKIP is a normal skip: dropped", dropped(b.writes) && !stampedW(b.writes), b.writes.map((w) => w.sql.slice(0, 90)));
  check("c) not struggling: a normal SKIP drops, as before", dropped(c.writes) && !stampedW(c.writes), c.writes.map((w) => w.sql.slice(0, 90)));
  check("d) released (okay again): written again with the feeling in view, and it would go", d.prompts.length >= 1 && d.prompts.some((p) => /HOW THEY'VE BEEN FEELING/.test(p)) && printed.some((l) => /would send 1 text\(s\) for companion:51/.test(l)) && !dropped(d.writes), { prompts: d.prompts.length, printed: printed.filter((l) => /dryRun|would send/.test(l)).slice(0, 4) });
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("the wait is logged with the rule and the kind", lines.some((l) => /rule=draft_skip_wait kind=companion ref=u-jordan:51 held/.test(l)), lines);
  check("logs carry no member text", lines.length > 0 && lines.every((l) => !l.includes("hospital") && !l.includes("pitch") && !l.includes("Jordan")), lines);
  check("nothing threw", !printed.some((l) => l.startsWith("THREW")), printed.filter((l) => l.startsWith("THREW")));
}

console.log(`\ndraft skips wait: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
