// draft_skip_wait (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). Every proactive draft sees how they've been
// feeling (draftProactive's feeling block) and may answer SKIP, and a SKIP was dropped (dropCandidate), including a check-in the hard
// day's hold had just released at the cap. Now a model SKIP while they're struggling waits once (moodDraftSkipAt, mood_draft_wait) and is
// written again once they're okay, or at the cap after the skip, the feeling as tone only. A skip code decides is never a mood and is
// dropped as before, and so is a second SKIP or a SKIP when they're not struggling. Safety is unchanged. Logs: rule and kind, no words.
// The fallback line after the one wait goes only for a skip the hard day caused: never a fit skip the draft gave its reason for, never
// the held recap; and once a stretch on the ledger, even for a stretch longer than the read's 96h lookback (review of #261).
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
  check("one mood wait per item in total: at the stretch's cap (a check-in the hold kept till then has had its wait), no draft wait on top", !P.firstDraftMoodWait(c, "model chose SKIP", CAP));
  check("one mood wait per item in total: a find that already waited for the composer gets no draft wait", !P.firstDraftMoodWait(cand("event_offer", { moodSkipAt: ago(5).toISOString() }), "model chose SKIP", HELD));
  check("okay again or not struggling: a normal skip", !P.firstDraftMoodWait(c, "model chose SKIP", OKAY) && !P.firstDraftMoodWait(c, "model chose SKIP", CALM));
  check("a skip code decided is never a mood (dropped as before)", ["Cue owns this thread: an open task delivers it", "the state it was about has changed", "not the moment: they've texted since", "the moment isn't confirmed by them: only theirs to say"].every((r) => !P.firstDraftMoodWait(c, r, HELD)));
  check("one wait per item: a second SKIP is a normal skip", !P.firstDraftMoodWait(cand("companion", { moodDraftSkipAt: ago(50).toISOString() }), "model chose SKIP", HELD));
}

// ================================================================ 2. the wait: held, released early, released at the cap
{
  const stamped = (h: number, over: Record<string, unknown> = {}) => cand("companion", { moodDraftSkipAt: ago(h).toISOString() }, over);
  check("struggling: it waits (mood_draft_wait)", failsOn(P.candidateChecks(stamped(1), baseState(HELD)), "mood_draft_wait"));
  check("released at the cap after the skip even if still struggling", !failsOn(P.candidateChecks(stamped(48), baseState(HELD)), "mood_draft_wait") && failsOn(P.candidateChecks(stamped(47), baseState(HELD)), "mood_draft_wait"));
  check("the stretch's cap ends the draft's wait too: total wait never passes the cap", !failsOn(P.candidateChecks(stamped(1), baseState(CAP)), "mood_draft_wait"));
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
  // b) still struggling, its one wait used (stamped 49h ago, past its cap), and the fallback can't go from this store (no ledger): a
  //    second SKIP drops it as before, never another wait.
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
  check("b) past its one wait, when the fallback can't go: dropped as before, never stamped again", dropped(b.writes) && !stampedW(b.writes), b.writes.map((w) => w.sql.slice(0, 90)));
  check("c) not struggling: a normal SKIP drops, as before", dropped(c.writes) && !stampedW(c.writes), c.writes.map((w) => w.sql.slice(0, 90)));
  check("d) released (okay again): written again with the feeling in view, and it would go", d.prompts.length >= 1 && d.prompts.some((p) => /HOW THEY'VE BEEN FEELING/.test(p)) && printed.some((l) => /would send 1 text\(s\) for companion:51/.test(l)) && !dropped(d.writes), { prompts: d.prompts.length, printed: printed.filter((l) => /dryRun|would send/.test(l)).slice(0, 4) });
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("the wait is logged with the rule and the kind", lines.some((l) => /rule=draft_skip_wait kind=companion ref=u-jordan:51 held/.test(l)), lines);
  check("logs carry no member text", lines.length > 0 && lines.every((l) => !l.includes("hospital") && !l.includes("pitch") && !l.includes("Jordan")), lines);
  check("nothing threw", !printed.some((l) => l.startsWith("THREW")), printed.filter((l) => l.startsWith("THREW")));
}

// ================================================================ 4. the approved fallback line (Royce, 2026-10-19, option A)
{
  check("the line is word for word what Royce approved", MH.MOOD_FALLBACK_LINE === "No rush on anything. I'm around whenever you want to pick things back up.");
  check("the line keeps the voice rules: no dash, no exclamation, no question, short", !/[—–!?]/.test(MH.MOOD_FALLBACK_LINE) && MH.MOOD_FALLBACK_LINE.length < 100);
  const since = ago(30);
  const waited = cand("companion", { moodDraftSkipAt: ago(49).toISOString() });
  const dec = (o: Record<string, unknown>, c: any = waited, skip = "model chose SKIP") => P.moodFallbackDecision({ candidate: c, skip, state: { now: NOW, sends: [], safetyHold: false, ...CAP, ...o } as any, hardSince: since });
  const key = `${MH.MOOD_FALLBACK_KEY}${since.toISOString()}`;
  check("past its one wait, still struggling: the fallback goes, keyed to the stretch", JSON.stringify(dec({})) === JSON.stringify({ send: true, key }));
  check("a check-in the hold kept to the cap (no stamp), skipping while still struggling: the fallback goes", dec({}, cand("ask_checkin")).send === true);
  check("once a hard stretch a member: a second item in the same stretch drops as before", dec({ sends: [{ type: "companion", targetKey: key, topicKey: "mood_fallback", sentAt: ago(3), exempt: false }, { type: "companion", targetKey: "companion:9", topicKey: "x", sentAt: ago(1), exempt: false }] }, cand("goal_checkin", { moodDraftSkipAt: ago(49).toISOString() })).send === false);
  // The last fallback went before this stretch began (okay since), and nothing went after it: only "twice in a row" decides.
  const prev = [{ type: "companion", targetKey: `${MH.MOOD_FALLBACK_KEY}${ago(100).toISOString()}`, topicKey: "mood_fallback", sentAt: ago(40), exempt: false }];
  check("never twice in a row (even across stretches)", (dec({ sends: prev }) as any).why === "never twice in a row" && dec({ sends: [...prev, { type: "companion", targetKey: "companion:9", topicKey: "x", sentAt: ago(20), exempt: false }] }).send === true);
  check("never under a safety hold", dec({ safetyHold: true }).send === false);
  check("not struggling, or okay again: a normal skip", dec({ ...CALM }).send === false && dec({ ...OKAY }).send === false);
  check("a skip code decided: a normal skip", dec({}, waited, "Cue owns this thread: an open task delivers it").send === false);
  check("while its one wait is still to give: the wait, not the fallback", dec({ ...HELD }, cand("companion")).send === false);
  // Only a skip the hard day caused (review of #261): a fit skip, where the draft gave its reason the content doesn't belong, never gets
  // the line; nor does the held recap, whose SKIP is its own approved fit rule.
  check("a fit skip the draft gave its reason for: a normal skip, never the fallback", dec({}, waited, "model chose SKIP: no specific open thread").send === false);
  const heldRecap = cand("post_call", { followUpId: "f1", recapHeldAt: ago(49).toISOString(), moodDraftSkipAt: ago(49).toISOString() });
  check("the held recap's own SKIP (nothing settled, or they moved on): never the fallback", dec({}, heldRecap, "model chose SKIP: nothing settled on the call, or they have moved on to something else").send === false);
  check("the held recap is excluded whatever its SKIP says", dec({}, heldRecap, "model chose SKIP").send === false);
  check("a plain post-call text (not the held recap) past its wait still can", dec({}, cand("post_call", { followUpId: "f2", moodDraftSkipAt: ago(49).toISOString() })).send === true);

  // The send: through the ledger's own gates (hours, caps, opt-out) after one more safety read; the item closed as skipped, never sent.
  const { default: sendblue } = await import("../../src/services/sendblue.js");
  const { installFakeLedger } = await import("../lib/fakeLedger.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const RealD = Date;
  globalThis.Date = class extends RealD {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(FIXED); }
    static now() { return FIXED; }
  } as DateConstructor;
  const send = async (zone: string, safety = false, type = "companion", findsToday = 0) => {
    const f = installFakeLedger(pool, sendblue);
    f.ledger.findsToday = findsToday;
    const q = pool.query;
    const sqls: string[] = [];
    (pool as any).query = async (sql: string, args: any[] = []) => { sqls.push(String(sql).replace(/\s+/g, " ").trim()); if (/safety_hold_until > NOW\(\)/.test(sql)) return { rows: safety ? [{ "?column?": 1 }] : [] }; return q(sql, args); };
    const printed: string[] = [];
    const log = console.log;
    console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
    const person = { userId: "u-jordan", firstName: "Jordan", phoneNumber: "+14155550199", timezone: zone, city: "San Francisco" } as any;
    const c = { ...cand(type, { moodDraftSkipAt: ago(49).toISOString(), recap: THEIR_WORDS }), id: "61", userId: "u-jordan", summary: `About ${THEIR_WORDS}` };
    const ok = await P.sendMoodFallback(proactiveRegistry, c, person, key, "model chose SKIP").catch(() => false);
    console.log = log;
    f.restore();
    return { ok, ledger: f.ledger, sqls, printed };
  };
  const day = await send("America/Los_Angeles");
  check("in their hours: the line goes, exactly, once, keyed to the stretch", day.ok && day.ledger.outbox.length === 1 && day.ledger.outbox[0].content === MH.MOOD_FALLBACK_LINE && day.ledger.sends.some((r: any) => r.target_key === key), day.ledger);
  // Review of #274 (2026-10-27): replacing an event offer, the line counted as a discovery find (refused at the day's cap) and was
  // ledgered with the "find" kind restraint learns from.
  const forOffer = await send("America/Los_Angeles", false, "event_offer", 3);
  check("replacing a find at the day's find cap, the line still goes (it is never a find)", forOffer.ok && forOffer.ledger.outbox.length === 1, forOffer.ledger);
  check("... ledgered under its own topic with no kind", forOffer.ledger.sends.some((r: any) => r.target_key === key && r.topic_key === "mood_fallback" && r.kind === null), forOffer.ledger.sends);
  const kr = (await import("node:fs")).readFileSync(new URL("../../src/services/kindRestraint.ts", import.meta.url), "utf8");
  const ac = (await import("node:fs")).readFileSync(new URL("../../src/agent/askCheckin.ts", import.meta.url), "utf8");
  check("... and restraint and the past check-ins never read it", /ps\.topic_key IS DISTINCT FROM '\$\{MOOD_FALLBACK_TOPIC\}'/.test(kr) && /type = 'ask_checkin' AND topic_key IS DISTINCT FROM \$2[^`]*`, \[userId, MOOD_FALLBACK_TOPIC\]/.test(ac));
  check("the item it replaces is closed as skipped (with the draft's reason), never marked sent", day.sqls.some((x) => /^UPDATE proactive_candidates SET status = 'skipped'/.test(x)) && !day.ledger.sentCandidates.includes("61") || day.ledger.sentCandidates.includes("61") && day.sqls.findIndex((x) => /SET status = 'skipped'/.test(x)) > day.sqls.findIndex((x) => /SET status = 'sent'/.test(x)), day.sqls.filter((x) => /proactive_candidates/.test(x)));
  check("no recap: the line carries nothing from the item", !day.ledger.outbox.some((m: any) => m.content.includes("hospital")));
  check("logged with the rule and the kind, no member text", day.printed.some((l) => /^mood hold: rule=draft_skip_wait kind=companion ref=u-jordan:61 the approved fallback line went in its place$/.test(l)) && day.printed.every((l) => !l.includes("hospital") && !l.includes("Jordan")), day.printed);
  const night = await send("Asia/Tokyo");
  check("quiet hours: nothing goes (the ledger's hours gate), and the caller drops it as before", !night.ok && night.ledger.outbox.length === 0);
  const held = await send("America/Los_Angeles", true);
  check("a safety hold: nothing goes", !held.ok && held.ledger.outbox.length === 0);
  globalThis.Date = RealD;
  const px = src("harness/proactive.ts");
  check("dispatch: the one wait first, then the fallback, then the drop as before", /if \(firstDraftMoodWait\(c, draft\.skip, state\)\) \{[\s\S]{0,900}const fallback = moodFallbackDecision\(\{ candidate: c, skip: draft\.skip, state, hardSince: member\.raw\.emotional\?\.hardSince \?\? null \}\);[\s\S]{0,300}\n    if \(fallback\.send && !opts\.dryRun && sends\(decision, c\.id\) && \(await sendMoodFallback\(registry, c, person, fallback\.key, draft\.skip, [\s\S]{0,600}\n      done\(c\.type\);\n      return;\n    \}\n    if \(!opts\.dryRun\) await dropCandidate\(registry, c, "skipped", draft\.skip\);/.test(px));
}


// ================================================================ 5. once a stretch, on the ledger, for a stretch longer than the read's lookback
// The review's case: one continuous hard stretch from hour 0, a read every 45 minutes (more than a hundred), the fallback at hour 120;
// the stretch's start drifts forward with the 96h lookback, so a key built on it changed and a second fallback went at 150h and 200h.
{
  const T0 = FIXED - 300 * HOUR;
  const at = (h: number) => new Date(T0 + h * HOUR);
  const steady: Sig[] = [];
  for (let h = 0; h <= 260; h += 0.75) steady.push({ ...hard(0), at: at(h) });
  // getEmotionalContext's own two reads on a fake store: the newest hundred in 14 days, then every hard or positive read in the lookback.
  const realQuery = pool.query;
  let sigs: Sig[] = steady;
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql);
    if (/FROM emotion_signals/i.test(q) && /LIMIT 100\b/.test(q)) return { rows: sigs.filter((x) => x.at.getTime() <= FIXED_AT).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 100).map((x) => ({ ...x, created_at: x.at })) };
    if (/FROM emotion_signals/i.test(q) && /make_interval/.test(q)) {
      const end = Date.parse(params[1]), from = end - Number(params[2]) * HOUR;
      return { rows: sigs.filter((x) => x.at.getTime() > from && x.at.getTime() <= end && (x.valence === "positive" || (x.valence === "negative" && x.intensity !== "low"))).sort((a, b) => b.at.getTime() - a.at.getTime()).map((x) => ({ ...x, created_at: x.at })) };
    }
    return { rows: [], rowCount: 0 };
  };
  let FIXED_AT = 0;
  const readAt = async (h: number) => { FIXED_AT = at(h).getTime(); return E.getEmotionalContext("u-jordan", at(h)); };
  const decideAt = async (h: number, sends: any[]) => {
    const e = await readAt(h);
    const state = { now: at(h), sends, safetyHold: false, needsCare: e.needsCare, moodHold: MH.moodHold(e, { now: at(h), lastInboundAt: at(h - 0.5) }) };
    return { e, d: P.moodFallbackDecision({ candidate: cand("goal_checkin", { moodDraftSkipAt: at(h - 49).toISOString() }), skip: "model chose SKIP", state: state as any, hardSince: e.hardSince ?? null }) };
  };
  const first = await decideAt(120, []);
  check("120h into one stretch (over a hundred reads): the first fallback goes", first.d.send === true && steady.filter((x) => x.at <= at(120)).length > 100, first.d);
  const fell = first.d.send ? first.d.key : "";
  // Another text went after it, so "never twice in a row" isn't what decides below: only the ledger rule.
  const ledger = [{ type: "goal_checkin", targetKey: fell, topicKey: "mood_fallback", sentAt: at(120), exempt: false }, { type: "companion", targetKey: "companion:9", topicKey: "x", sentAt: at(126), exempt: false }];
  // 230h too: the drifted start is past the fallback by then, so only the edge rule tells it from a new stretch.
  const later = await Promise.all([150, 200, 230].map((h) => decideAt(h, ledger)));
  check("the stretch's start drifts with the lookback (why a key on it failed)", later.every((x) => x.e.hardSince !== null && x.e.hardSince.getTime() > Date.parse(fell.slice(MH.MOOD_FALLBACK_KEY.length))), later.map((x) => x.e.hardSince));
  check("150h, 200h and 230h, still the same stretch, never okay since: no second fallback", later.every((x) => x.d.send === false && /haven't been okay since/.test((x.d as any).why)), later.map((x) => x.d));
  // Okay in between (a good moment at 130h, then a new hard stretch from 140h): a later fallback may go again.
  sigs = [...steady.filter((x) => x.at <= at(128)), { ...hard(0), valence: "positive", intensity: "medium", emotion: "relieved", at: at(130) }, ...steady.filter((x) => x.at >= at(140))];
  const after = await decideAt(200, ledger);
  check("okay since the last fallback (a good moment, then a new stretch): it may go again", after.d.send === true && after.e.hardSince?.getTime() === steady.find((x) => x.at >= at(140))!.at.getTime(), { d: after.d, since: after.e.hardSince });
  check("okaySinceFallback: a start at the lookback's edge is not a break; one inside it, after the fallback, is", !P.okaySinceFallback(at(120), at(104), at(200)) && !P.okaySinceFallback(at(120), at(134), at(230)) && P.okaySinceFallback(at(120), at(140), at(200)) && !P.okaySinceFallback(at(120), at(110), at(150)));
  (pool as any).query = realQuery;
}

console.log(`\ndraft skips wait: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
