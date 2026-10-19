// A hard day decides when, never whether (Royce, 2026-10-18, option a: "timing only, with the cap"). Three holds that read how a member
// feels (services/moodHold.ts): the check-ins held while struggling (checkin_hold), the stopped-looking line (stop_note_hold), and a find
// the bundle composer skipped in the prompt that saw the feeling (bundle_skip_wait). For each: struggling holds it and nothing drops it;
// it goes early once they're okay; it goes at the cap even if the read still says struggling; safety holds are unchanged; an item's own
// expiry still ends it; the log names the rule and the kind, never their words. Plus the helper-choice pin: these three are ruled.
// Layer 1: pure functions, the real reads on a fake store, the reply facts on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/proactive/moodHolds.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const MH = await import("../../src/services/moodHold.js");
const E = await import("../../src/harness/emotion.js");
const P = await import("../../src/harness/proactive.js");
const A = await import("../../src/services/askRetire.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = new Date("2026-10-18T19:00:00Z");
const ago = (h: number, from = NOW) => new Date(from.getTime() - h * HOUR);
type Sig = import("../../src/harness/emotion.js").EmotionSignal;
// Their words, so the log checks can look for them.
const THEIR_WORDS = "my dad is back in the hospital and I can't think";
const hardSig = (h: number, from = NOW): Sig => ({ source: "text", emotion: "scared", intensity: "high", valence: "negative", about: "their dad in the hospital", quote: THEIR_WORDS, at: ago(h, from), target: "life" });
const goodSig = (h: number, from = NOW): Sig => ({ source: "text", emotion: "relieved", intensity: "medium", valence: "positive", about: "their dad home", quote: "he's home, thank god", at: ago(h, from), target: "life" });
const read = (sigs: Sig[], lastInboundAt: Date | null, now = NOW) => MH.moodHold(E.summarizeSignals(sigs, now), { now, lastInboundAt });
const cand = (type: string, over: Record<string, unknown> = {}) => ({ id: "c1", userId: "u", type, targetKey: `${type}:1`, topicKey: `${type}:t`, summary: `About ${THEIR_WORDS}`, payload: {}, priority: 10, dueAt: ago(1), expiresAt: new Date(NOW.getTime() + 5 * DAY), attempts: 0, createdAt: ago(2), ...over }) as any;
const baseState = (over: Record<string, unknown> = {}) => ({ now: NOW, sends: [], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, ...over }) as any;
const failsOn = (checks: { name: string; pass: boolean }[], name: string) => checks.some((k) => k.name === name && !k.pass);

// ================================================================ 0. the read: the hard stretch, okay again, the cap
{
  check("the cap is one constant, 48 hours, the same for all three", MH.MOOD_HOLD_CAP_HOURS === 48 && !/process\.env/.test(src("services/moodHold.ts")));
  const one = E.summarizeSignals([hardSig(2)], NOW);
  check("a hard read: struggling, with when it was and when the stretch began", one.needsCare && one.hardAt?.getTime() === ago(2).getTime() && one.hardSince?.getTime() === ago(2).getTime());
  const chain = E.summarizeSignals([hardSig(2), hardSig(20), hardSig(40)], NOW);
  check("hard reads at most a day apart are one stretch", chain.hardSince?.getTime() === ago(40).getTime(), chain.hardSince);
  const gap = E.summarizeSignals([hardSig(2), hardSig(30)], NOW);
  check("a gap of more than a day starts a new stretch", gap.hardSince?.getTime() === ago(2).getTime(), gap.hardSince);
  const broken = E.summarizeSignals([hardSig(2), goodSig(10), hardSig(20)], NOW);
  check("a positive read between two hard ones starts a new stretch", broken.needsCare && broken.hardSince?.getTime() === ago(2).getTime(), broken.hardSince);
  const cleared = E.summarizeSignals([goodSig(1), hardSig(2)], NOW);
  check("a positive read after it clears it: no times", !cleared.needsCare && cleared.hardAt === null && cleared.hardSince === null);
  check("the feeling block they draft from is unchanged by the times", E.renderEmotionalContext(one, NOW) === E.renderEmotionalContext({ ...one, hardAt: undefined, hardSince: undefined }, NOW));

  check("not struggling: no hold", read([], null).state === "none" && !read([], null).hold);
  check("struggling: held", read([hardSig(2)], ago(2.1)).state === "held");
  check("okay again: they texted normally 6h+ after the hard read", read([hardSig(8)], ago(1)).state === "released_okay" && !read([hardSig(8)], ago(1)).hold);
  check("a text right after hard news ('thanks') isn't okay yet", read([hardSig(3)], ago(1)).hold);
  check("their own hard text (its row is written just before its read) isn't a text after it", read([hardSig(8)], ago(8.01)).hold);
  check("okay again: the read clears (a positive read, or a day with no hard read)", read([goodSig(1), hardSig(3)], null).state === "none" && read([hardSig(25)], null).state === "none");
  const longStretch = [hardSig(1), hardSig(20), hardSig(40), hardSig(49)];
  check("at the cap: released even though the read still says struggling", E.summarizeSignals(longStretch, NOW).needsCare && read(longStretch, ago(1.5)).state === "released_cap", read(longStretch, ago(1.5)));
  check("just under the cap: still held", read([hardSig(1), hardSig(20), hardSig(40), hardSig(47)], ago(1.5)).hold);
  check("no times on the read (an older state): struggling holds, as before", MH.moodHold({ needsCare: true }, { now: NOW, lastInboundAt: null }).hold);
}

// ================================================================ 0b. the stretch's start comes from its own read, not the newest hundred (review of #253)
{
  const realQuery = pool.query;
  let all: Sig[] = [];
  const asRow = (x: Sig) => ({ ...x, created_at: x.at });
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql);
    if (/FROM emotion_signals/i.test(q) && /LIMIT 100\b/.test(q)) return { rows: [...all].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 100).map(asRow) };
    if (/FROM emotion_signals/i.test(q) && /make_interval\(hours => \$3\)/.test(q)) {
      const now = new Date(params[1]).getTime(), back = Number(params[2]) * HOUR;
      return { rows: all.filter((x) => x.at.getTime() > now - back && x.at.getTime() <= now).sort((a, b) => b.at.getTime() - a.at.getTime()).map(asRow) };
    }
    return { rows: [], rowCount: 0 };
  };
  // A hard read every 25 minutes for about 125 hours: the newest hundred span only about 41 hours.
  all = Array.from({ length: 300 }, (_, i) => hardSig(i * (25 / 60)));
  const heavy = await E.getEmotionalContext("u-jordan", NOW);
  const newest100 = E.summarizeSignals([...all].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 100), NOW);
  check("a heavy texter: the newest hundred alone would hold the stretch under the cap (the leak)", MH.moodHold(newest100, { now: NOW, lastInboundAt: ago(0.1) }).hold);
  check("a heavy texter: the stretch's own read reaches the cap (released_cap)", MH.moodHold(heavy, { now: NOW, lastInboundAt: ago(0.1) }).state === "released_cap", { since: heavy.hardSince, hold: MH.moodHold(heavy, { now: NOW, lastInboundAt: ago(0.1) }) });
  // 125 hard reads over 125 hours: released at the cap.
  all = Array.from({ length: 125 }, (_, i) => hardSig(i));
  const hourly = await E.getEmotionalContext("u-jordan", NOW);
  check("125 hard reads over 125 hours: released_cap", MH.moodHold(hourly, { now: NOW, lastInboundAt: ago(0.1) }).state === "released_cap", hourly.hardSince);
  // A positive read inside the window still starts a new stretch.
  all = [...Array.from({ length: 200 }, (_, i) => hardSig(i * (25 / 60))), goodSig(10.2)];
  const broken = await E.getEmotionalContext("u-jordan", NOW);
  check("the stretch's own read still stops at a positive read between two hard ones", Math.abs(NOW.getTime() - broken.hardSince!.getTime()) <= 10.2 * HOUR, broken.hardSince);
  check("the stretch read is bounded by time and asks for no words", /created_at > \$2::timestamptz - make_interval\(hours => \$3\)/.test(src("harness/emotion.ts")) && /SELECT source, intensity, valence, about, target, basis, created_at FROM emotion_signals/.test(src("harness/emotion.ts")) && E.STRETCH_LOOKBACK_HOURS >= MH.MOOD_HOLD_CAP_HOURS + 24);
  (pool as any).query = realQuery;
}

// ================================================================ 1. check-ins held while struggling (checkin_hold)
{
  const types = [...P.HOLD_WHILE_STRUGGLING];
  check("the held types are the same eight", types.sort().join() === ["ask_checkin", "calendar_follow", "commitment_nudge", "goal_checkin", "goal_nudge", "goal_recheck", "name_change", "product_update"].sort().join(), types);
  const held = read([hardSig(2)], ago(2.1));
  const okay = read([hardSig(8)], ago(1));
  const capped = read([hardSig(1), hardSig(20), hardSig(40), hardSig(49)], ago(1.5));
  const at = (mh: unknown, over: Record<string, unknown> = {}) => P.candidateChecks(cand("ask_checkin", over), baseState({ needsCare: true, moodHold: mh, ...over }));
  check("struggling: every held type waits (emotional_timing)", types.every((t) => failsOn(P.candidateChecks(cand(t), baseState({ needsCare: true, moodHold: held })), "emotional_timing")));
  check("released early when they're okay", !failsOn(at(okay), "emotional_timing"));
  check("released at the cap even if still struggling", !failsOn(at(capped), "emotional_timing"));
  check("a state without the read's times holds as before", failsOn(P.candidateChecks(cand("ask_checkin"), baseState({ needsCare: true })), "emotional_timing"));
  check("finds and the room are never held by it", !failsOn(P.candidateChecks(cand("event_offer"), baseState({ needsCare: true, moodHold: held })), "emotional_timing") && !failsOn(P.candidateChecks(cand("ask_solicitation"), baseState({ needsCare: true, moodHold: held })), "emotional_timing"));
  // Safety is not mood: the cap and okay-again never touch it.
  for (const [label, mh] of [["held", held], ["okay", okay], ["cap", capped]] as const) {
    check(`safety hold unchanged (${label}): offers and the name notice still held`, failsOn(P.candidateChecks(cand("event_offer"), baseState({ needsCare: true, moodHold: mh, safetyHold: true })), "safety_hold") && failsOn(P.candidateChecks(cand("name_change"), baseState({ needsCare: true, moodHold: mh, safetyHold: true })), "safety_hold"));
  }
  check("safety: the safety follow-up still skips the conversation hold and the type gap (code unchanged)", /const safetyPassesHold = \(k: GateCheck, c: Pick<Candidate, "payload">\) => k\.name === "mid_conversation" && isSafetyFollowUp\(c\);/.test(src("harness/proactive.ts")) && /if \(state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer" \|\| c\.type === "name_change"\)\) \{/.test(src("harness/proactive.ts")));
  // Expiry: its own clock still ends it, held or released; the cap never extends it.
  const gone = { expiresAt: ago(0.5) };
  check("an expired check-in is expired whether held, okay or at the cap", [held, okay, capped].every((mh) => failsOn(at(mh, gone), "not_expired")));
  check("the expiry sweep is untouched: pending rows past expires_at are marked expired", /SET status = 'expired', skip_reason = 'expired'[\s\S]{0,200}WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW\(\)/.test(src("harness/proactive.ts")));
  check("the hold writes nothing to the row (no expiry pushed, no status)", !/emotional_timing[\s\S]{0,300}UPDATE proactive_candidates/.test(src("harness/proactive.ts").slice(src("harness/proactive.ts").indexOf("export function candidateChecks"), src("harness/proactive.ts").indexOf("const PERSON_CHECKS"))));
  check("planning carries on: no sweep waits on a hard day", Object.values(P.SWEEP_BLOCKERS).every((b) => !b.includes("emotional_timing") && !b.includes("mood_wait")));
  check("pacing still applies once released: the caps and hours are other checks it still has to pass", P.evaluateCandidates({ ...baseState({ needsCare: true, moodHold: okay, timezone: "America/Los_Angeles", optedOut: true }), candidates: [cand("ask_checkin")] } as any).eligible.length === 0);

  // The real chain on a fake store: the emotion rows -> memberSendState -> the gate; and dispatch never drops it.
  const realQuery = pool.query;
  const writes: { sql: string; params: any[] }[] = [];
  let sigRows: Sig[] = [];
  let lastIn: Date | null = null;
  let pending: any[] = [];
  let optedOut = false;
  (pool as any).query = async (sql: string, params: any[] = []) => {
    const q = String(sql).trim();
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) { writes.push({ sql: q, params }); return { rows: [], rowCount: 0 }; }
    if (/FROM emotion_signals/i.test(q)) return { rows: sigRows.map((s) => ({ ...s, created_at: s.at })) };
    if (/MAX\(created_at\) AS at FROM co_memories/i.test(q)) return { rows: [{ at: lastIn }] };
    if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Jordan", phone_number: "+14155550199", sms_opted_out: optedOut, city: "San Francisco" }] };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/i.test(q)) return { rows: pending };
    return { rows: [], rowCount: 0 };
  };
  const person = { timezone: "America/Los_Angeles", optedOut: false };
  sigRows = [hardSig(2)]; lastIn = ago(2.1);
  const sHeld = await P.memberSendState("u-jordan", person, NOW);
  sigRows = [hardSig(8)]; lastIn = ago(1);
  const sOkay = await P.memberSendState("u-jordan", person, NOW);
  sigRows = [hardSig(1), hardSig(20), hardSig(40), hardSig(49)]; lastIn = ago(1.5);
  const sCap = await P.memberSendState("u-jordan", person, NOW);
  check("the real read: struggling and held", sHeld.state.needsCare === true && sHeld.state.moodHold?.state === "held", sHeld.state.moodHold);
  check("the real read: okay again", sOkay.state.needsCare === true && sOkay.state.moodHold?.state === "released_okay", sOkay.state.moodHold);
  check("the real read: the cap", sCap.state.needsCare === true && sCap.state.moodHold?.state === "released_cap", sCap.state.moodHold);
  check("the gate on the real reads: held, then released early, then released at the cap", failsOn(P.candidateChecks(cand("goal_checkin"), sHeld.state as any), "emotional_timing") && !failsOn(P.candidateChecks(cand("goal_checkin"), sOkay.state as any), "emotional_timing") && !failsOn(P.candidateChecks(cand("goal_checkin"), sCap.state as any), "emotional_timing"));

  // Dispatch, not a dry run: the held check-in stays pending (no status written), and the hold is logged once, with no member text.
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const rowOf = (type: string) => ({ id: "41", user_id: "u-jordan", type, target_key: `${type}:41`, topic_key: `${type}:t`, summary: `Check in on ${THEIR_WORDS}`, priority: 10, due_at: new Date(Date.now() - HOUR), expires_at: new Date(Date.now() + 5 * DAY), attempts: 0, created_at: new Date(Date.now() - 2 * HOUR), payload: { ask: THEIR_WORDS } });
  pending = [rowOf("ask_checkin")];
  sigRows = [hardSig(2, new Date())]; lastIn = new Date(Date.now() - 2.1 * HOUR);
  writes.length = 0;
  await P.dispatchForUser(proactiveRegistry, "u-jordan").catch((e: any) => printed.push(`THREW ${e?.message}`));
  await P.dispatchForUser(proactiveRegistry, "u-jordan").catch((e: any) => printed.push(`THREW ${e?.message}`));
  const heldWrites = writes.slice();
  // Okay again: the release is logged on the next look. (Opted out here, so nothing could go: the look stops after the gate.)
  sigRows = [hardSig(8, new Date())]; lastIn = new Date(Date.now() - HOUR); optedOut = true;
  writes.length = 0;
  await P.dispatchForUser(proactiveRegistry, "u-jordan").catch((e: any) => printed.push(`THREW ${e?.message}`));
  console.log = log; console.error = err;
  (pool as any).query = realQuery;
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("dispatch: the held check-in is never dropped (no status written to it)", !heldWrites.some((w) => /UPDATE proactive_candidates SET status/i.test(w.sql)), heldWrites.map((w) => w.sql.slice(0, 80)));
  check("dispatch: the hold is logged once over two looks, with the rule and the kind", lines.filter((l) => / held/.test(l)).length === 1 && lines.some((l) => /rule=checkin_hold kind=ask_checkin ref=u-jordan:41 held/.test(l)), lines);
  check("dispatch: the release is logged when they're okay", lines.some((l) => /rule=checkin_hold kind=ask_checkin ref=u-jordan:41 released: they texted normally/.test(l)), lines);
  check("logs carry no member text", lines.length > 0 && lines.every((l) => !l.includes("hospital") && !l.includes("dad") && !l.includes("Jordan")), lines);
  check("nothing threw", !printed.some((l) => l.startsWith("THREW")), printed.filter((l) => l.startsWith("THREW")));
}

// ================================================================ 2. the stopped-looking line (stop_note_hold)
{
  const held = read([hardSig(2)], ago(2.1));
  const okay = read([hardSig(8)], ago(1));
  const capped = read([hardSig(1), hardSig(20), hardSig(40), hardSig(49)], ago(1.5));
  const ride = (mh: unknown) => A.noteMayRide({ type: "companion", payload: {} }, P.heldForMood({ needsCare: true, moodHold: mh as any }));
  check("paced text: struggling, the note waits", !ride(held));
  check("paced text: released early when they're okay", ride(okay));
  check("paced text: released at the cap even if still struggling", ride(capped));
  check("paced text: a heavy check-in still never carries it (its content, not a mood read)", !A.noteMayRide({ type: "companion", payload: { heavy: { endedAt: ago(1) } } }, false));
  const ps = src("harness/proactive.ts");
  check("paced text: dispatch passes the capped hold to every note ride (the line and the name notice)", (ps.match(/A\.noteMayRide\(c, heldForMood\(member\.state\)\)/g) ?? []).length === 2 && !/noteMayRide\(c, !!member\.state\.needsCare\)/.test(ps));
  check("a note has no clock of its own: owed until told, whatever its age (the cap is what ends the wait)", A.notesFrom([], [{ id: "a1", text: "jazz bars", retiredAt: ago(24 * 60), toldAt: null }]).length === 1);
  check("a held note is never marked told (only a delivered one is)", /if \(stopNote && state\.stopNotesSent\.length && !opts\.dryRun && opts\.record !== false\)/.test(src("agent/conversationReply.ts")));
  check("safety unchanged: a reply never carries it when they may not be safe", /if \(\(state\.stopNotes\.length \|\| state\.stopNotesSent\.length\) && !ctx\.safetyConcern && !state\.safetyFlagged\) message = carryLaneNotes/.test(src("agent/conversationTools.ts")));

  // The reply: decided on this message's own feeling read (the turn's read is replaced with it before the facts are gathered).
  check("the reply turn swaps in this message's read before the facts are gathered", /if \(turn\) turn\.emotional = emotional;\s*const replyFacts = await gatherReplyFacts\(/.test(src("routes/sendblue.ts")));
  const { gatherReplyFacts } = await import("../../src/harness/replyGrounding.js");
  const realQuery = pool.query;
  const writes: string[] = [];
  (pool as any).query = async (sql: string) => { if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(String(sql).trim()); return { rows: [], rowCount: 0 }; };
  const note = { kind: "ask" as const, key: "3f2a9c1e-0000-4000-8000-000000000001", line: `I've paused the search on ${THEIR_WORDS}; say the word and I'll pick it back up`, since: ago(24 * 5) };
  const now = new Date();
  const turnWith = (sigs: Sig[]) => ({
    userId: "u-jordan", message: "ok", profile: null, snapshot: null, sent: [], asks: [], threads: [], offersThisWeek: 0, emotional: E.summarizeSignals(sigs, now), lessons: [], inlineTarget: null,
    ledger: { lines: [], named: [] }, capabilities: [], google: [], kit: {}, story: [], advice: [], tasks: [], briefs: [], goals: [], deliveries: [], goalSetAsides: [], carrying: [], recentDocs: [], drift: [],
    stopNote: note, knowledge: null, rules: null,
  } as any);
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  console.error = () => {};
  const rHeld = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(2, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  const rCurrent = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(0.01, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  const rOkay = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(8, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  const rCap = await gatherReplyFacts("u-jordan", { turn: turnWith([hardSig(0.5, now), hardSig(20, now), hardSig(40, now), hardSig(49, now)]) }).catch((e: any) => ({ threw: e?.message }) as any);
  const rCalm = await gatherReplyFacts("u-jordan", { turn: turnWith([]) }).catch((e: any) => ({ threw: e?.message }) as any);
  console.log = log; console.error = err;
  (pool as any).query = realQuery;
  const hinted = (r: any) => r.stopNote?.key === note.key && JSON.stringify(r).includes("Code adds this line");
  check("reply: the facts were gathered on a fake store", ![rHeld, rCurrent, rOkay, rCap, rCalm].some((r) => r.threw), [rHeld, rCurrent, rOkay, rCap, rCalm].map((r) => r.threw ?? "ok"));
  check("reply: struggling, the note waits (not in this reply)", !rHeld.stopNote && !JSON.stringify(rHeld).includes(note.line));
  check("reply: this message itself the hard one, the note waits", !rCurrent.stopNote);
  check("reply: released early when they text normally 6h+ after", hinted(rOkay), rOkay.stopNote);
  check("reply: released at the cap even if still struggling", hinted(rCap));
  check("reply: not struggling, it goes as before", hinted(rCalm));
  check("reply: a held note writes nothing (not told, not dropped)", !writes.some((w) => /told_at|retire_note|idle_note/i.test(w)), writes);
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("reply: hold and release logged with the rule and the kind", lines.some((l) => /rule=stop_note_hold kind=ask ref=u-jordan:ask:3f2a9c1e-0000-4000-8000-000000000001 held/.test(l)) && lines.some((l) => /rule=stop_note_hold kind=ask .* released/.test(l)), lines);
  check("reply: logs carry no member text (not the note, not their words)", lines.length > 0 && lines.every((l) => !l.includes("hospital") && !l.includes("paused the search") && !l.includes("Jordan")), lines);
}

// ================================================================ 3. a find the composer skipped while they were struggling (bundle_skip_wait)
{
  const held = read([hardSig(2)], ago(2.1));
  const okay = read([hardSig(8)], ago(1));
  const capped = read([hardSig(1), hardSig(20), hardSig(40), hardSig(49)], ago(1.5));
  check("a lead skipped while held waits: no drop, no tier next", JSON.stringify(P.failedBundleActions({ leadSkipped: true }, 0, true)) === JSON.stringify(["mood_wait"]) && JSON.stringify(P.failedBundleActions({ leadSkipped: true, tierSkipped: true }, 0, true)) === JSON.stringify(["mood_wait"]));
  check("not held (okay, the cap, or not struggling): a skip is a fit skip, dropped as before", JSON.stringify(P.failedBundleActions({ leadSkipped: true }, 0, false)) === JSON.stringify(["drop_skipped"]) && JSON.stringify(P.failedBundleActions({ leadSkipped: true, tierSkipped: true }, 0, false)) === JSON.stringify(["drop_skipped", "queue_tier_next"]));
  check("a failure that isn't a skip is unchanged by the hold", JSON.stringify(P.failedBundleActions({}, 0, true)) === JSON.stringify(["count_attempt"]));
  const ps = src("harness/proactive.ts");
  check("dispatch: the lead's actions read the capped hold (its one wait), and mood_wait stamps it", /failedBundleActions\(res, c\.attempts, firstMoodWait\(c, state\)\)/.test(ps) && /if \(a === "mood_wait"\) await markMoodSkip\(userId, \[c\], state\.now\);/.test(ps));
  check("dispatch: a sibling or tier pick the composer left out while held is stamped (its one wait), never dropped, no tier next", /const moodWaits = res\.dropped\.filter\(\(d\) => firstMoodWait\(d\.item\.candidate, state\)\);\s*if \(moodWaits\.length && !opts\.dryRun\) await markMoodSkip\(userId, moodWaits\.map\(\(d\) => d\.item\.candidate\), state\.now\);/.test(ps) && /if \(!d\.tierSkipped \|\| opts\.dryRun \|\| moodWaits\.includes\(d\)\) continue;/.test(ps));
  // One wait per find (review of #253): a find that already waited, skipped again under a later hard stretch, is a fit skip.
  const waited = cand("event_offer", { payload: { moodSkipAt: ago(60).toISOString() } });
  const fresh = cand("event_offer");
  const laterStretch = { needsCare: true, moodHold: held };
  check("one wait per find: a fresh find skipped while held gets its wait", P.firstMoodWait(fresh, laterStretch));
  check("one wait per find: a find that already waited, skipped again under a new hard stretch, does not wait again", !P.firstMoodWait(waited, laterStretch) && !failsOn(P.candidateChecks(waited, baseState(laterStretch)), "mood_wait"));
  check("one wait per find: its second skip drops it as a fit skip (a tier pick also queues its next best)", JSON.stringify(P.failedBundleActions({ leadSkipped: true }, 0, P.firstMoodWait(waited, laterStretch))) === JSON.stringify(["drop_skipped"]) && JSON.stringify(P.failedBundleActions({ leadSkipped: true, tierSkipped: true }, 0, P.firstMoodWait(waited, laterStretch))) === JSON.stringify(["drop_skipped", "queue_tier_next"]));
  check("one wait per find: not held, no wait at all", !P.firstMoodWait(fresh, { needsCare: true, moodHold: okay }) && !P.firstMoodWait(fresh, { needsCare: false }));
  check("the composer's prompt is unchanged: the feeling shapes how, never whether", /HOW THEY'VE BEEN FEELING \(it shapes how you say this, never whether/.test(src("harness/bundleComposer.ts")));

  const stamped = (h: number) => cand("event_offer", { payload: { moodSkipAt: ago(h).toISOString() } });
  check("stamped and held: waits (mood_wait)", failsOn(P.candidateChecks(stamped(1), baseState({ needsCare: true, moodHold: held })), "mood_wait"));
  check("stamped, released early when they're okay", !failsOn(P.candidateChecks(stamped(1), baseState({ needsCare: true, moodHold: okay })), "mood_wait") && !failsOn(P.candidateChecks(stamped(1), baseState({ needsCare: false })), "mood_wait"));
  check("stamped, released at the cap even if still struggling (the stretch's cap)", !failsOn(P.candidateChecks(stamped(1), baseState({ needsCare: true, moodHold: capped })), "mood_wait"));
  check("stamped, released at the cap from its own skip, even inside a new hard stretch", !failsOn(P.candidateChecks(stamped(48), baseState({ needsCare: true, moodHold: held })), "mood_wait") && failsOn(P.candidateChecks(stamped(47), baseState({ needsCare: true, moodHold: held })), "mood_wait"));
  check("never stamped: no mood_wait at all (a hard day never holds a find it didn't skip)", !failsOn(P.candidateChecks(cand("event_offer"), baseState({ needsCare: true, moodHold: held })), "mood_wait"));
  for (const [label, mh] of [["held", held], ["okay", okay], ["cap", capped]] as const) {
    check(`safety hold unchanged (${label}): a stamped find is still held by safety`, failsOn(P.candidateChecks(stamped(1), baseState({ needsCare: true, moodHold: mh, safetyHold: true })), "safety_hold"));
  }
  check("a stamped find whose event has passed expires as usual (held or not)", [held, okay, capped].every((mh) => failsOn(P.candidateChecks({ ...stamped(1), expiresAt: ago(0.1) }, baseState({ needsCare: true, moodHold: mh })), "not_expired")));

  // The stamp: payload only, the row stays pending, its expiry untouched; the hold logged with ids only.
  const realQuery = pool.query;
  const writes: { sql: string; params: any[] }[] = [];
  (pool as any).query = async (sql: string, params: any[] = []) => { writes.push({ sql: String(sql).trim(), params }); return { rows: [], rowCount: 0 }; };
  MH.resetMoodHoldLog();
  const printed: string[] = [];
  const log = console.log;
  console.log = (...a: any[]) => { printed.push(a.map(String).join(" ")); };
  await P.markMoodSkip("u-jordan", [{ ...cand("event_offer"), id: "77" }], NOW);
  console.log = log;
  (pool as any).query = realQuery;
  const w = writes[0];
  check("the stamp writes the payload only, on a pending row: no status, no expiry", writes.length === 1 && /SET payload = jsonb_set\(COALESCE\(payload, '\{\}'::jsonb\), '\{moodSkipAt\}'/.test(w.sql) && /AND status = 'pending'/.test(w.sql) && !/status =\s*'(skipped|expired)'|SET status|expires_at/.test(w.sql) && w.params[1] === NOW.toISOString(), writes);
  const lines = printed.filter((l) => l.startsWith("mood hold:"));
  check("the wait is logged with the rule and the kind, no member text", lines.length === 1 && /rule=bundle_skip_wait kind=event_offer ref=u-jordan:77 held/.test(lines[0]) && !lines[0].includes("hospital"), lines);
  check("the wait's release is logged on the next look", MH.noteMoodHold("bundle_skip_wait", "event_offer", "u-jordan:77", P.moodWaitRead(stamped(1), baseState({ needsCare: true, moodHold: okay }))!, () => {})?.includes("released") === true);
}

// ================================================================ 4. the log: once per change, ids only
{
  MH.resetMoodHoldLog();
  const out: string[] = [];
  const push = (l: string) => out.push(l);
  const h = { state: "held" as const, hold: true, heldHours: 3 };
  MH.noteMoodHold("checkin_hold", "goal_checkin", "u:1", h, push);
  MH.noteMoodHold("checkin_hold", "goal_checkin", "u:1", h, push);
  MH.noteMoodHold("checkin_hold", "goal_checkin", "u:1", { state: "released_cap", hold: false, heldHours: 48 }, push);
  MH.noteMoodHold("checkin_hold", "goal_checkin", "u:1", { state: "released_cap", hold: false, heldHours: 48.5 }, push);
  MH.noteMoodHold("checkin_hold", "goal_checkin", "u:2", h, push);
  MH.noteMoodHold("checkin_hold", "goal_checkin", "u:2", { state: "none", hold: false, heldHours: null }, push);
  check("each hold and release logged once", JSON.stringify(out) === JSON.stringify([
    "mood hold: rule=checkin_hold kind=goal_checkin ref=u:1 held (hard stretch 3h)",
    "mood hold: rule=checkin_hold kind=goal_checkin ref=u:1 released: the 48h cap (hard stretch 48h)",
    "mood hold: rule=checkin_hold kind=goal_checkin ref=u:2 held (hard stretch 3h)",
    "mood hold: rule=checkin_hold kind=goal_checkin ref=u:2 released: the read cleared",
  ]), out);
  check("the line takes no text: only the rule, the kind, a ref, the state and hours", /export function moodHoldLine\(o: \{ rule: MoodRule; kind: string; ref: string; state: MoodHoldState \| "released_cleared"; heldHours: number \| null \}\): string/.test(src("services/moodHold.ts")) && /export function noteMoodHold\(rule: MoodRule, kind: string, ref: string, read: MoodHold, log/.test(src("services/moodHold.ts")));
}

// ================================================================ 5. the helper-choice pin (plan section 5, "Where member knowledge picks a helper")
// Royce, 2026-10-18: "The situation decides what Cue looks for and which helpers run. What we know about a member shapes how, never
// which helper." The three feelings-based places are ruled: timing only, capped. No longer pending.
{
  const rules = MH.MOOD_RULES;
  check("the three feelings-based places are ruled, none pending", ["bundle_skip_wait", "checkin_hold", "stop_note_hold"].every((k) => k in rules) && Object.values(rules).every((r) => /timing only, capped \(Royce 2026-10-1[89]/.test(r.ruling) && !/pending/i.test(r.ruling)));
  check("kind restraint is not a feelings rule (it reads whether they answered, not how they feel): left as it is", !Object.values(rules).some((r) => /kindRestraint|suppressedKinds/.test(r.where)) && !/emotion|needsCare/.test(src("services/kindRestraint.ts")));
  check("safety is not a mood rule and is not in the list", !Object.keys(rules).some((k) => /safety/.test(k)));
  const others = MH.FEELING_PICKS_NOT_CHANGED;
  check("the other feeling-based places are each documented as not changed (needing Royce) or ruled since (not claimed as all ruled)", others.every((o) => /documented, not changed: needs Royce/.test(o.status)) && ["documentOffer.ts offerGate", "postCallFollowUp.ts", "replyGrounding.ts heavyMoment", "feelingForDraft"].every((w) => others.some((o) => o.where.includes(w)) || Object.values(rules).some((r) => r.where.includes(w))) && /Not every\s*\n?\/\/ place a feeling read decides/.test(src("services/moodHold.ts")));
  check("those places are indeed unchanged here", /if \(s\.needsCare\) return "they are having a hard time; their state comes first";/.test(src("services/documentOffer.ts")) && /return !!e\.needsCare \|\| \(!!e\.current && e\.current\.intensity === "high" && e\.current\.valence === "negative"\);/.test(src("harness/replyGrounding.ts")));
  check("no member-facing words were added: the module writes no line to them", !/messages|sendText|sendWithLedger|carryLaneNotes/.test(src("services/moodHold.ts")));
}

console.log(`\nmood holds: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
