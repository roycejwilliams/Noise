// The recap after a call waits out a hard time; it is never cancelled by one (Royce, 2026-10-19: "feelings change timing and tone,
// never cancel... it still happens, later or gentler, with a capped wait so it never waits forever"). The place:
// jobs/postCallFollowUp.ts recapOfferFor, where a hard time (needsCare) or a heavy call blocked the one-line recap offer, and since the
// offer rode only the post-call text, it never came back for that call. Now the mood decides when: held, it's queued for that call
// (holdRecapForMood, payload.recapHeldAt) and waits while the mood hold is on (harness/proactive.ts recapWaitRead, recap_mood_wait),
// going once they're okay or at the latest MOOD_HOLD_CAP_HOURS after it was held, gently (draftHeldRecap).
// Covered: mood on -> delayed, not dropped; released early when okay; released at the cap even if still struggling; non-mood reasons
// unchanged; safety unchanged; logs carry no member text; tied to its call; the pin that this place can't cancel on mood.
// Layer 1: pure functions, the real reads and the registry on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/calls/recapMoodHold.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const PC = await import("../../src/jobs/postCallFollowUp.js");
const O = await import("../../src/services/documentOffer.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");
const P = await import("../../src/harness/proactive.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const HOUR = 3_600_000;
// 2pm in Los Angeles: inside their hours and the recap's.
const NOW = new Date("2026-10-19T21:00:00Z");
const ago = (h: number, from = NOW) => new Date(from.getTime() - h * HOUR);
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
// Their words, so the log checks can look for them.
const THEIR_WORDS = "my dad is back in the hospital and I can't think";
const TRANSCRIPT = "assistant: How did it land?\nuser: We decided: Jacqueline takes product, I take the raise. Friday we tell the team.";
const FID = "7d1c0b2e-0000-4000-8000-00000000c411";
const hardSig = (h: number, from = NOW, source: "text" | "call" = "text"): Sig => ({ source, emotion: "scared", intensity: "high", valence: "negative", about: "their dad in the hospital", quote: THEIR_WORDS, at: ago(h, from), target: "life" });
const read = (sigs: Sig[], lastInboundAt: Date | null, now = NOW) => MH.moodHold(E.summarizeSignals(sigs, now), { now, lastInboundAt });
const HELD = read([hardSig(2)], ago(2.1));
const OKAY = read([hardSig(8)], ago(1));
const CAPPED = read([hardSig(1), hardSig(20), hardSig(40), hardSig(49)], ago(1.5));
const failsOn = (checks: { name: string; pass: boolean }[], name: string) => checks.some((k) => k.name === name && !k.pass);
const baseState = (over: Record<string, unknown> = {}) => ({ now: NOW, sends: [], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, ...over }) as any;
const heldRecap = (over: Record<string, unknown> = {}) => ({ id: "c9", userId: "u-jordan", type: "post_call", targetKey: PC.recapHoldKey(FID), topicKey: PC.recapHoldKey(FID), summary: "Offer once, gently, a one-page recap", payload: { followUpId: FID, recapHeldAt: ago(1).toISOString() }, priority: 80, dueAt: ago(1), expiresAt: new Date(NOW.getTime() + 60 * HOUR), attempts: 0, createdAt: ago(1), ...over }) as any;
const postCallText = () => ({ ...heldRecap(), targetKey: `post_call:${FID}`, topicKey: `post_call:${FID}`, payload: { followUpId: FID } }) as any;

// A fake store: the emotion read, their last inbound, the offer record, the call's row, and the candidate queue (captured writes).
type Store = { sigs: Sig[]; inbound: Date | null; offers: any[]; writes: { sql: string; params: any[] }[]; transcript: string | null; confirmed: string | null };
const store: Store = { sigs: [], inbound: null, offers: [], writes: [], transcript: TRANSCRIPT, confirmed: null };
const realQuery = pool.query, realConnect = (pool as any).connect;
const answer = async (sql: string, params: any[] = []) => {
  const q = String(sql).trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q)) return { rows: [] };
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) { store.writes.push({ sql: q, params }); return { rows: /RETURNING id/i.test(q) ? [{ id: 501 }] : [], rowCount: 1 }; }
  if (/FROM emotion_signals/i.test(q)) return { rows: store.sigs.map((s) => ({ ...s, created_at: s.at, basis: s.basis ?? null })) };
  if (/MAX\(created_at\) AS at FROM co_memories/i.test(q)) return { rows: [{ at: store.inbound }] };
  if (/FROM document_offers/i.test(q)) return { rows: store.offers };
  if (/FROM post_call_follow_ups/i.test(q)) return { rows: store.transcript ? [{ transcript: store.transcript, created_at: ago(1) }] : [] };
  if (/FROM proactive_sends WHERE user_id = \$1 AND target_key = \$2 LIMIT 1/i.test(q)) return { rows: store.confirmed ? [{ message: store.confirmed }] : [] };
  return { rows: [] };
};
const fake = () => {
  (pool as any).query = answer;
  (pool as any).connect = async () => ({ query: answer, release: () => {} });
};
const real = () => { (pool as any).query = realQuery; (pool as any).connect = realConnect; };
const reset = (o: Partial<Store> = {}) => { Object.assign(store, { sigs: [], inbound: null, offers: [], writes: [], transcript: TRANSCRIPT, confirmed: null }, o); MH.resetMoodHoldLog(); };
const known = (needsCare: boolean) => ({ identity: { zone: "America/Los_Angeles", timeZone: "America/Los_Angeles" }, restraint: { needsCare }, delivered: [] }) as any;
const callIn = { callAt: ago(1), confirmed: false, coCommitted: false, now: NOW };

// ================================================================ 1. the pure read: held, okay again, the cap, a heavy call
{
  check("the reads used here: held, okay again, at the cap", HELD.state === "held" && OKAY.state === "released_okay" && CAPPED.state === "released_cap", [HELD, OKAY, CAPPED]);
  const r = PC.recapMoodRead;
  check("struggling while the hold is on: held (waits)", r({ care: true, mood: HELD, heavyCall: false }).held);
  check("okay again: goes now, gently", !r({ care: true, mood: OKAY, heavyCall: false }).held && r({ care: true, mood: OKAY, heavyCall: false }).gentle);
  check("at the cap: goes now even though still struggling, gently", !r({ care: true, mood: CAPPED, heavyCall: false }).held && r({ care: true, mood: CAPPED, heavyCall: false }).gentle);
  check("not struggling: goes, as before, no hard-stretch tone", !r({ care: false, mood: null, heavyCall: false }).held && !r({ care: false, mood: null, heavyCall: false }).gentle);
  check("a heavy call: held (waits), never cancelled", r({ care: false, mood: null, heavyCall: true }).held);
  check("a read without times: held, as before (the held recap's own cap still ends it)", r({ care: true, mood: null, heavyCall: false }).held);
}

// ================================================================ 2. recapOfferFor on a fake store: held vs offered, and non-mood reasons
{
  fake();
  try {
    reset({ sigs: [hardSig(2)], inbound: ago(2.1) });
    const held = await PC.recapOfferFor("u-jordan", FID, callIn, known(true));
    check("mood on: not offered in this text, held for the call", !held.offer && held.held && !held.gentle, held);
    reset({ sigs: [hardSig(8)], inbound: ago(1) });
    const okay = await PC.recapOfferFor("u-jordan", FID, callIn, known(true));
    check("released early (they texted normally since): offered in this text, gently", okay.offer && !okay.held && okay.gentle, okay);
    reset({ sigs: [hardSig(1), hardSig(20), hardSig(40), hardSig(49)], inbound: ago(1.5) });
    const cap = await PC.recapOfferFor("u-jordan", FID, callIn, known(true));
    check("released at the cap though still struggling: offered, gently", cap.offer && cap.gentle, cap);
    reset();
    const calm = await PC.recapOfferFor("u-jordan", FID, callIn, known(false));
    check("not struggling: offered as before, no hard-stretch tone", calm.offer && !calm.held && !calm.gentle, calm);
    // A frustration score on the call: a heavy call moment that isn't a hard day (needsCare stays off).
    reset({ sigs: [{ ...hardSig(1, NOW, "call"), basis: "frustration_score" }] });
    const heavy = await PC.recapOfferFor("u-jordan", FID, callIn, known(false));
    check("a heavy call (a high hard moment on it): held, not offered and not dropped", !heavy.offer && heavy.held, heavy);
    // Non-mood reasons: unchanged, and never turned into a hold.
    reset({ sigs: [hardSig(2)], inbound: ago(2.1) });
    const night = await PC.recapOfferFor("u-jordan", FID, { ...callIn, now: new Date("2026-10-20T06:00:00Z") }, known(true));
    check("their night: not offered and not held (as before)", !night.offer && !night.held && night.why === "it's night for them", night);
    const conf = await PC.recapOfferFor("u-jordan", FID, { ...callIn, confirmed: true }, known(true));
    check("the confirmation text already went: neither (as before)", !conf.offer && !conf.held, conf);
    const committed = await PC.recapOfferFor("u-jordan", FID, { ...callIn, coCommitted: true }, known(true));
    check("Cue committed to something on the call: neither (as before)", !committed.offer && !committed.held, committed);
    reset({ sigs: [hardSig(2)], inbound: ago(2.1), offers: [{ topic: `[recap] ${PC.recapKey(FID)}`, source: "offered", status: "offered", at: new Date(NOW.getTime() - 20 * 24 * HOUR) }] });
    const twice = await PC.recapOfferFor("u-jordan", FID, callIn, known(true));
    check("already offered for this call: neither (once per call)", !twice.offer && !twice.held && /already offered for this call/.test(twice.why ?? ""), twice);
    reset({ sigs: [hardSig(2)], inbound: ago(2.1), offers: [{ topic: "[brief] dinner", source: "offered", status: "offered", at: new Date(NOW.getTime() - 4 * 24 * HOUR) }] });
    const cool = await PC.recapOfferFor("u-jordan", FID, callIn, known(true));
    check("the fortnight cooldown: neither", !cool.offer && !cool.held, cool);
    const delivered = await PC.recapOfferFor("u-jordan", FID, callIn, { ...known(true), delivered: [{ via: ["receipt"], at: NOW.toISOString() }] });
    check("a document went since the call: neither", !delivered.offer && !delivered.held, delivered);
  } finally {
    real();
  }
}

// ================================================================ 3. holdRecapForMood: queued for that call, once, logged by rule and kind
{
  fake();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  try {
    reset({ sigs: [hardSig(2, new Date())], inbound: new Date(Date.now() - 2.1 * HOUR) });
    console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
    console.error = () => {};
    const now = new Date();
    const queued = await PC.holdRecapForMood("u-jordan", FID, now).catch((e: any) => `threw: ${e?.message}`);
    console.log = log; console.error = err;
    const ins = store.writes.find((w) => /INSERT INTO proactive_candidates/.test(w.sql));
    const payload = ins ? JSON.parse(ins.params[5]) : null;
    check("held: a recap candidate is queued (not dropped)", queued === true && !!ins, { queued, writes: store.writes.map((w) => w.sql.slice(0, 80)) });
    check("one held recap per call: the key names the call, two calls never share one", PC.recapHoldKey(FID).endsWith(FID) && PC.recapHoldKey(FID) !== PC.recapHoldKey("another-call") && PC.recapHoldKey(FID) !== `post_call:${FID}`);
    check("tied to that call: its own key per call, and the call's id", ins?.params[1] === "post_call" && ins?.params[2] === PC.recapHoldKey(FID) && payload?.followUpId === FID && payload?.recapHeldAt === now.toISOString(), ins?.params);
    check("it has a lifetime of its own: the cap plus a day, so it never waits forever", ins && new Date(ins.params[7]).getTime() - now.getTime() === (MH.MOOD_HOLD_CAP_HOURS + 24) * HOUR && PC.RECAP_HELD_EXPIRY_HOURS === MH.MOOD_HOLD_CAP_HOURS + 24, ins?.params[7]);
    check("the summary carries no member text", !!ins && !String(ins.params[4]).includes("hospital") && !String(ins.params[4]).includes("Jacqueline"), ins?.params[4]);
    const lines = printed.filter((l) => l.startsWith("mood hold:"));
    check("the hold is logged with the rule and the kind, ids only", lines.length === 1 && new RegExp(`^mood hold: rule=recap_hold kind=post_call_recap ref=u-jordan:${FID} held`).test(lines[0]) && !/hospital|Jacqueline|raise/.test(lines[0]), lines);
    check("the call's own record is not touched by holding (its text went)", !store.writes.some((w) => /post_call_follow_ups/.test(w.sql)));
    reset({ inbound: new Date() });
    const notHeld = await PC.holdRecapForMood("u-jordan", FID).catch(() => "threw");
    check("not struggling (Cue chose not to offer it): nothing is queued", notHeld === false && !store.writes.length, store.writes);
    reset({ sigs: [hardSig(2, new Date())], inbound: new Date(Date.now() - 2.1 * HOUR), transcript: null });
    check("no call record: nothing queued", (await PC.holdRecapForMood("u-jordan", FID).catch(() => "threw")) === false && !store.writes.length);
  } finally {
    console.log = log; console.error = err;
    real();
  }
}

// ================================================================ 4. the dispatch gate: waits, okay again, the cap, pacing, safety, expiry
{
  const c = heldRecap();
  check("struggling: the held recap waits (recap_mood_wait), it isn't dropped", failsOn(P.candidateChecks(c, baseState({ needsCare: true, moodHold: HELD })), "recap_mood_wait"));
  check("released early when they're okay", !failsOn(P.candidateChecks(c, baseState({ needsCare: true, moodHold: OKAY })), "recap_mood_wait"));
  check("released at the cap of the stretch even if still struggling", !failsOn(P.candidateChecks(c, baseState({ needsCare: true, moodHold: CAPPED })), "recap_mood_wait"));
  const old = heldRecap({ payload: { followUpId: FID, recapHeldAt: ago(MH.MOOD_HOLD_CAP_HOURS + 0.5).toISOString() } });
  check("released 48h after it was held, whatever the read says then", !failsOn(P.candidateChecks(old, baseState({ needsCare: true, moodHold: HELD })), "recap_mood_wait") && P.recapWaitRead(old, baseState({ needsCare: true, moodHold: HELD }))?.state === "released_cap");
  check("a state without the read's times: waits until its own cap", failsOn(P.candidateChecks(c, baseState({ needsCare: true })), "recap_mood_wait") && !failsOn(P.candidateChecks(old, baseState({ needsCare: true })), "recap_mood_wait"));
  check("not struggling: goes", !failsOn(P.candidateChecks(c, baseState()), "recap_mood_wait"));
  check("the post-call text itself is never held by it (unchanged)", P.recapWaitRead(postCallText(), baseState({ needsCare: true, moodHold: HELD })) === null && !P.candidateChecks(postCallText(), baseState({ needsCare: true, moodHold: HELD })).some((k) => k.name === "recap_mood_wait"));
  check("its own clock still ends it: expired is expired, held or released", [HELD, OKAY, CAPPED].every((mh) => failsOn(P.candidateChecks(heldRecap({ expiresAt: ago(0.5) }), baseState({ needsCare: true, moodHold: mh })), "not_expired")));
  check("pacing as for the text it would have ridden: an answer to their call (3h spacing, no quota)", P.isAnswering(c) && P.isAnswering(postCallText()));
  check("their hours and opt-out still apply once released", P.evaluateCandidates({ ...baseState({ needsCare: true, moodHold: OKAY, timezone: "America/Los_Angeles", optedOut: true }), candidates: [c] } as any).eligible.length === 0);
  // Safety is not mood: the held recap gets exactly the checks a post-call text gets under a safety hold (none added, none removed).
  const names = (x: any, s: any) => P.candidateChecks(x, s).map((k) => k.name).filter((n) => n !== "recap_mood_wait" && n !== "awaiting_prompt_approval").sort().join();
  check("safety unchanged: a safety hold reads the held recap as it reads the post-call text", names(heldRecap({ targetKey: `post_call:${FID}` }), baseState({ safetyHold: true })) === names(postCallText(), baseState({ safetyHold: true })) && !/safetyHold|safety\.js|safety_hold/.test(src("jobs/postCallFollowUp.ts")));
  check("the hold and its release are logged once each by the dispatch, rule and kind, ids only", /const recapWait = recapWaitRead\(p\.candidate, state\);[\s\S]{0,200}if \(recapWait\) noteMoodHold\("recap_hold", recapWait\.hold \|\| HELD_RECAP_APPROVED \? "post_call_recap" : "awaiting_prompt_approval", `\$\{userId\}:\$\{String\(\(p\.candidate\.payload as \{ followUpId\?: string \} \| null\)\?\.followUpId \?\? p\.candidate\.id\)\}`, recapWait\);/.test(src("harness/proactive.ts")));
  MH.resetMoodHoldLog();
  const out: string[] = [];
  const ref = `u-jordan:${FID}`;
  MH.noteMoodHold("recap_hold", "post_call_recap", ref, P.recapWaitRead(c, baseState({ needsCare: true, moodHold: HELD }))!, (l) => out.push(l));
  MH.noteMoodHold("recap_hold", "post_call_recap", ref, P.recapWaitRead(c, baseState({ needsCare: true, moodHold: HELD }))!, (l) => out.push(l));
  MH.noteMoodHold("recap_hold", "post_call_recap", ref, P.recapWaitRead(c, baseState({ needsCare: true, moodHold: OKAY }))!, (l) => out.push(l));
  check("held once, released once (they texted normally), no member text", out.length === 2 && / held/.test(out[0]) && /released: they texted normally/.test(out[1]) && out.every((l) => !/hospital|Jacqueline/.test(l)), out);
}

// ================================================================ 5. the registry: the held recap drafts, sends and ends as its own thing
{
  const { proactiveRegistry: registry } = await import("../../src/harness/proactiveRegistry.js");
  check("the registry is reachable", !!registry?.post_call);
  fake();
  const err = console.error;
  console.error = () => {};
  try {
    reset();
    await registry.post_call.onDropped(heldRecap(), "expired", "expired");
    check("a held recap that expires leaves the call's record alone", !store.writes.some((w) => /post_call_follow_ups/.test(w.sql)), store.writes);
    reset();
    await registry.post_call.onSent(heldRecap(), { firstName: "Jordan" }, ["Want me to put what you two decided on Friday's call on a one-page recap?"]);
    check("a held recap sent: the offer is recorded for that call (once per call), the call's record untouched", store.writes.some((w) => /INSERT INTO document_offers/.test(w.sql) && w.params.includes(`[recap] ${PC.recapKey(FID)}`)) && !store.writes.some((w) => /post_call_follow_ups/.test(w.sql)) && !store.writes.some((w) => /INSERT INTO proactive_candidates/.test(w.sql)), store.writes);
    reset({ sigs: [hardSig(2, new Date())], inbound: new Date(Date.now() - 2.1 * HOUR) });
    await registry.post_call.onSent(postCallText(), { firstName: "Jordan" }, ["Telling the team Friday is the right call."]);
    check("the post-call text went without the recap while struggling: the call is marked sent and the recap is held for it", store.writes.some((w) => /UPDATE post_call_follow_ups SET sent_at/.test(w.sql)) && store.writes.some((w) => /INSERT INTO proactive_candidates/.test(w.sql) && w.params[2] === PC.recapHoldKey(FID)), store.writes.map((w) => w.sql.slice(0, 70)));
    reset({ sigs: [hardSig(2, new Date())], inbound: new Date(Date.now() - 2.1 * HOUR) });
    await registry.post_call.onSent(postCallText(), { firstName: "Jordan" }, ["Want me to put what you decided on a one-page recap?"]);
    check("the text made the offer itself: recorded, nothing held", store.writes.some((w) => /INSERT INTO document_offers/.test(w.sql)) && !store.writes.some((w) => /INSERT INTO proactive_candidates/.test(w.sql)));
    // Drafting: night defers (never dropped for the hour); a fact that no longer holds ends it; no call record ends it.
    reset();
    const night = await PC.draftHeldRecap("u-jordan", "Jordan", FID, new Date("2026-10-20T06:00:00Z"), true).catch((e: any) => ({ threw: e?.message }));
    check("drafting at their night defers it (not dropped)", "defer" in (night as any), night);
    reset({ offers: [{ topic: `[recap] ${PC.recapKey(FID)}`, source: "offered", status: "offered", at: new Date(NOW.getTime() - 20 * 24 * HOUR) }] });
    const twice = await PC.draftHeldRecap("u-jordan", "Jordan", FID, NOW, true).catch((e: any) => ({ threw: e?.message }));
    check("already offered for this call: ends (once per call)", "skip" in (twice as any) && /already offered for this call/.test((twice as any).skip), twice);
    reset({ confirmed: "Sending the deck tonight." });
    const conf = await PC.draftHeldRecap("u-jordan", "Jordan", FID, NOW, true).catch((e: any) => ({ threw: e?.message }));
    check("the confirmation text went for that call: ends", "skip" in (conf as any), conf);
    reset({ transcript: null });
    check("no call record: ends", "skip" in ((await PC.draftHeldRecap("u-jordan", "Jordan", FID, NOW, true).catch((e: any) => ({ threw: e?.message }))) as any));
  } finally {
    console.error = err;
    real();
  }
  const pc = src("jobs/postCallFollowUp.ts");
  check("the held draft offers only the recap of that call, gently, and may SKIP only when nothing was settled", /may_offer_a_one_page_recap: RECAP_OFFER_RULE,\s*recap_offer_tone: RECAP_GENTLE,/.test(pc) && /If they settled nothing on that call, return SKIP\./.test(PC.HELD_RECAP_TASK) && /Never write the recap itself/.test(PC.HELD_RECAP_TASK));
  check("the gentle line is model-facing guidance, not a line the member gets as is", /if you offer the recap/.test(PC.RECAP_GENTLE) && !/"/.test(PC.RECAP_GENTLE));
  check("released in the post-call text itself: the same gentle guidance rides with the permission", /recap_offer_tone: recapOffer && recapGentle && !confirmationSent \? RECAP_GENTLE : null,/.test(pc) && /!!recap\?\.offer, k, !!recap\?\.gentle\)/.test(pc));
}

// ================================================================ 5b. unwired until Royce reads the prompt (HELD_RECAP_APPROVED = false)
{
  check("the held recap's prompt is not approved: a code constant, false, no env switch", MH.HELD_RECAP_APPROVED === false && /export const HELD_RECAP_APPROVED: boolean = false;/.test(src("services/moodHold.ts")) && !/process\.env[^\n]*HELD_RECAP/.test(src("services/moodHold.ts") + src("harness/proactive.ts") + src("jobs/postCallFollowUp.ts")));
  const released = [OKAY, CAPPED, { state: "none" as const, hold: false, heldHours: null }];
  const st = (mh: any) => baseState({ needsCare: mh.state !== "none", moodHold: mh });
  check("still held while struggling, as before (the mood wait, not the approval)", failsOn(P.candidateChecks(heldRecap(), st(HELD)), "recap_mood_wait") && !P.candidateChecks(heldRecap(), st(HELD)).some((k) => k.name === "awaiting_prompt_approval"));
  check("released (okay, the cap, the read cleared): it stays pending, awaiting approval", released.every((mh) => failsOn(P.candidateChecks(heldRecap(), st(mh)), "awaiting_prompt_approval") && !failsOn(P.candidateChecks(heldRecap(), st(mh)), "recap_mood_wait")));
  check("released at 48h after it was held: still awaiting approval, never sent", failsOn(P.candidateChecks(heldRecap({ payload: { followUpId: FID, recapHeldAt: ago(50).toISOString() } }), st(HELD)), "awaiting_prompt_approval"));
  const lis = { timezone: "America/Los_Angeles", optedOut: false };
  const elig = (c: any, mh: any, opts: any = {}) => P.evaluateCandidates({ ...baseState({ needsCare: mh.state !== "none", moodHold: mh, ...lis }), candidates: [c] } as any, opts).eligible.map((x: any) => x.id);
  check("the dispatch never picks it while unapproved (not eligible), though the post-call text itself would be", elig(heldRecap(), OKAY).length === 0 && elig(postCallText(), OKAY).length === 1, [elig(heldRecap(), OKAY), elig(postCallText(), OKAY)]);
  check("its own clock still ends it, unsent: expired is expired", failsOn(P.candidateChecks(heldRecap({ expiresAt: ago(0.5) }), st(OKAY)), "not_expired") && PC.RECAP_HELD_EXPIRY_HOURS === MH.MOOD_HOLD_CAP_HOURS + 24);
  check("ending unsent leaves the call's record alone (onDropped returns for a held recap)", /if \(isHeldRecap\(c\)\) return;\s*await markPostCallDropped/.test(src("harness/proactiveRegistry.ts")));
  // The draft path, if ever reached unapproved: no reads, no model, a defer (never a send).
  fake();
  try {
    reset();
    const d = await PC.draftHeldRecap("u-jordan", "Jordan", FID, NOW);
    check("unapproved draft: defers, reads nothing, writes nothing, drafts nothing", "defer" in (d as any) && /approval/.test((d as any).reason) && !("messages" in (d as any)) && store.writes.length === 0, d);
  } finally {
    real();
  }
  // Flip the approval (the parameter the constant feeds): the path is ready.
  check("approved: released, it is eligible again (the check lifts)", released.every((mh) => !failsOn(P.candidateChecks(heldRecap(), st(mh), { recapApproved: true }), "awaiting_prompt_approval")) && failsOn(P.candidateChecks(heldRecap(), st(HELD), { recapApproved: true }), "recap_mood_wait"));
  check("approved: the dispatch would pick it", elig(heldRecap(), OKAY, { recapApproved: true }).length === 1);
  check("approved: the draft path re-checks the facts and drafts with HELD_RECAP_TASK (see section 5)", /task: HELD_RECAP_TASK,/.test(src("jobs/postCallFollowUp.ts")) && /if \(!approved\) return \{ defer:/.test(src("jobs/postCallFollowUp.ts")));
  // The log at release names the waiting kind, ids only.
  MH.resetMoodHoldLog();
  const out: string[] = [];
  const ref = `u-jordan:${FID}`;
  MH.noteMoodHold("recap_hold", "post_call_recap", ref, P.recapWaitRead(heldRecap(), st(HELD))!, (l) => out.push(l));
  const rel = P.recapWaitRead(heldRecap(), st(OKAY))!;
  MH.noteMoodHold("recap_hold", rel.hold || MH.HELD_RECAP_APPROVED ? "post_call_recap" : "awaiting_prompt_approval", ref, rel, (l) => out.push(l));
  check("release while unapproved is logged as kind=awaiting_prompt_approval, ids only", out.length === 2 && new RegExp(`^mood hold: rule=recap_hold kind=awaiting_prompt_approval ref=u-jordan:${FID} released`).test(out[1]) && out.every((l) => !/hospital|Jacqueline/.test(l)), out);
  check("the dispatch logs it that way", /noteMoodHold\("recap_hold", recapWait\.hold \|\| HELD_RECAP_APPROVED \? "post_call_recap" : "awaiting_prompt_approval"/.test(src("harness/proactive.ts")));
}

// ================================================================ 6. the pin: this place can't cancel on mood
{
  const pc = src("jobs/postCallFollowUp.ts");
  check("the gate gets no feeling: needsCare and the heavy call never reach postCallRecapAllowed from here", (pc.match(/gate: \{ now, needsCare: false, heavyNow: false, history \}/g) ?? []).length === 2 && !/needsCare: k\.restraint \? k\.restraint\.needsCare/.test(pc) && !/heavyNow: heavyCall/.test(pc));
  check("a feeling only ever sets held or gentle, and held queues it (holdRecapForMood from onSent)", /return \{ offer: r\.ok && !m\.held, held: r\.ok && m\.held, gentle: r\.ok && m\.gentle,/.test(pc) && /if \(offered === false\) await holdRecapForMood\(c\.userId, c\.payload\.followUpId\)/.test(src("harness/proactiveRegistry.ts")));
  check("the dispatch's mood check only waits (a failed check, never a drop)", !/recap_mood_wait[\s\S]{0,200}dropCandidate/.test(src("harness/proactive.ts")) && /name: "recap_mood_wait", pass: false/.test(src("harness/proactive.ts")));
  check("ruled (timing only, capped) and off the not-changed list", MH.MOOD_RULES.recap_hold?.ruling.startsWith("timing only, capped") && !MH.FEELING_PICKS_NOT_CHANGED.some((o) => o.where.includes("postCallFollowUp.ts")));
  check("the same cap, one constant (no second clock, no env)", /moodWaitRead\(\{ payload: \{ moodSkipAt: at \} \}, s\)/.test(src("harness/proactive.ts")) && !/process\.env/.test(src("services/moodHold.ts")));
  check("the pure gate still says not now on a feeling for any other caller (unchanged)", O.postCallRecapAllowed({ gate: { now: NOW, needsCare: true, heavyNow: false, history: [] }, localHour: 14, confirmationSent: false, coCommitted: false, deliveredSinceCall: false, callKey: PC.recapKey(FID) }).ok === false);
}

console.log(`\nrecap mood hold: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
