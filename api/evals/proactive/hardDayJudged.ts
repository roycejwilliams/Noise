// A hard day informs, it never silences (Royce, 2026-11-09): "a hard-day read is a reason to be more thoughtful, not a blanket reason to
// go silent"; "mood shouldn't stop the sweeps from running or evaluating possible fits. It should inform whether a particular find is
// worth bringing to the member now." On a hard day the sweep runs, fits are picked, the find is queued, and the delivery decision reaches
// the send-time read (harness/momentFit.ts) with the hard-day line and their own latest words. The read decides; code neither sends nor
// holds a find or an offer on the mood. Model-free (the read is stubbed), no outside calls:
//   npx tsx evals/proactive/hardDayJudged.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync } from "fs";
import type { Candidate } from "../../src/harness/proactive.js";
const PR = await import("../../src/harness/proactive.js");
const MF = await import("../../src/harness/momentFit.js");
const G = await import("../../src/harness/notifyGate.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};
const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url).pathname, "utf8");
const ZONE = "America/Los_Angeles";
const pt = (iso: string) => new Date(`${iso}-08:00`);
const HOUR = 3_600_000;
const NOW = pt("2026-11-09T14:00:00");
let seq = 0;
const cand = (type: string, payload: any = {}, over: Partial<Candidate> = {}): Candidate => {
  const id = over.id ?? `c${++seq}`;
  return { id, userId: "u-1", type: type as any, targetKey: `${type}:${id}`, topicKey: `${type}:${id}`, summary: `${type} ${id}`, priority: 50, dueAt: pt("2026-11-09T08:00:00"), expiresAt: pt("2026-11-14T08:00:00"), payload, attempts: 0, createdAt: pt("2026-11-09T08:00:00"), ...over };
};
// The same queued offer for both members: a relevant event three days out, found for where they're headed (Cue's own find).
const OFFER = cand("event_offer", { askId: "profile", fromProfile: true, picked: true, match: { tier: 2, name: "Builders' supper", event_date: "2026-11-12" } }, { id: "offer" });
const OFFER_TEXT = "https://lu.ma/builders-supper\nA builders' supper on Thursday, twelve founders around one table, for the cofounder search you're weighing.";
const held = { needsCare: true, moodHold: { state: "held", hold: true, heldHours: 3 } as any };
const capped = { needsCare: true, moodHold: { state: "released_cap", hold: false, heldHours: 49 } as any };
const base = { now: NOW, timezone: ZONE, optedOut: false, sends: [], lastInboundAt: pt("2026-11-09T12:00:00"), joinedAt: pt("2026-10-01T10:00:00") };
const failedChecks = (ev: ReturnType<typeof PR.evaluateCandidates>, id: string) => ev.perCandidate.find((p) => p.candidate.id === id)!.checks.filter((k) => !k.pass).map((k) => k.name);

// ---------------------------------------------------------------- 1. upstream runs on a hard day
{
  const sendState = { state: { ...base, ...held, candidates: [] }, holdUntil: null, spaceUntil: null } as any;
  check("sweep: the ask sweep, the goal sweep and the 9am goal search all run on a hard day", PR.sweepBlockedBy(sendState, "ask", []).length === 0 && PR.sweepBlockedBy(sendState, "goal", []).length === 0 && PR.sweepBlockedBy(sendState, "floor_goal", []).length === 0, [PR.sweepBlockedBy(sendState, "goal", [])]);
  const MOOD_CHECKS = ["emotional_timing", "hard_day", "mood_wait", "mood_draft_wait", "recap_mood_wait"];
  check("sweep: no mood check can stop a sweep (none is a sweep blocker)", Object.values(PR.SWEEP_BLOCKERS).every((l) => !l.some((n) => MOOD_CHECKS.includes(n))));
  check("sweep: a safety hold still stops it (untouched)", PR.SWEEP_BLOCKERS.ask.includes("safety_hold") && PR.SWEEP_BLOCKERS.floor_goal.includes("safety_hold"));
  const ev = PR.evaluateCandidates({ ...base, ...held, candidates: [OFFER] } as any);
  check("pick: the queued find is eligible on a hard day (no class hold)", ev.eligible.some((c) => c.id === "offer") && !failedChecks(ev, "offer").includes("hard_day"), failedChecks(ev, "offer"));
  // The picker sees how they've been as context only, and enqueueing reads no mood at all: the mood census proves no mood read in src/
  // gates anything outside the capped holds and the send-time read (evals/proactive/moodNeverCancels.ts).
  check("pick: the picker reads how they've been as one context line, never a rule", /if \(c\.feeling\) lines\.push\(`How they've been: \$\{c\.feeling\}`\);/.test(src("services/sweepSelect.ts")));
}

// ---------------------------------------------------------------- 2. THE KEY CHECK: the same offer, two members, the read decides
{
  const cls = G.candidateClass(OFFER.type, PR.isAnswering(OFFER), OFFER.payload);
  check("route: Cue's own find is unsolicited and goes to the send-time read while the hard-day read is on", cls === "unsolicited" && MF.momentFitApplies(cls, OFFER.payload, { type: OFFER.type, hardDay: true }));
  check("route: on an ordinary day it isn't read (no extra call)", !MF.momentFitApplies(cls, OFFER.payload, { type: OFFER.type, hardDay: false }));
  check("route: the hard-day line is on while held, and past the 48h cap for a find (a fresh judgment, never an automatic release)", MF.hardDayLineFor({ held: true, on: true, cls, type: OFFER.type, payload: OFFER.payload }) && MF.hardDayLineFor({ held: false, on: true, cls, type: OFFER.type, payload: OFFER.payload }));
  const ev2 = PR.evaluateCandidates({ ...base, ...capped, candidates: [OFFER] } as any);
  check("route: at the cap it is still in the pick and still read (needsCare), not sent on the clock", ev2.eligible.some((c) => c.id === "offer") && MF.momentFitApplies(cls, OFFER.payload, { type: OFFER.type, hardDay: !!capped.needsCare }));
  const calm = "[Mon 9:10am] User said: Weighing whether to bring on a cofounder or keep it solo for now. Not urgent, just thinking it through.\n[Mon 9:12am] Cue said: Both are real options. What would a cofounder take off your plate?\n[Mon 9:30am] User said: Mostly the technical side. I'd like to meet a few people before deciding.";
  const distress = "[Mon 2:10am] User said: I can't sleep. Everything is piling up and I feel like I'm drowning.\n[Mon 2:12am] Cue said: That sounds like a lot to carry at 2am. I'm here.\n[Mon 2:20am] User said: I just need it to stop for a bit.";
  const ready = { ready: true as const, line: null };
  const run = async (recent: string, verdict: "send" | "wait" | "drop") => {
    const prompts: string[] = [];
    MF.setMomentModelForTests(async (p) => (prompts.push(p), JSON.stringify({ verdict, why: "stub" })));
    const v = await MF.momentFit({ userId: "u-1", firstName: "Jordan", message: OFFER_TEXT, recent, call: ready, queuedAt: OFFER.createdAt, now: NOW, kind: OFFER.type, hardDay: MF.hardDayLineFor({ held: true, on: true, cls, type: OFFER.type, payload: OFFER.payload }), queued: [] });
    MF.setMomentModelForTests(null);
    return { v, prompt: prompts[0] ?? "", calls: prompts.length };
  };
  const calmSend = await run(calm, "send");
  const distressWait = await run(distress, "wait");
  check("key: both reach the read, once each", calmSend.calls === 1 && distressWait.calls === 1);
  check("key: both carry the hard-day line and the same offer", [calmSend, distressWait].every((r) => r.prompt.includes(MF.HARD_DAY_LINE) && r.prompt.includes("builders' supper on Thursday")));
  check("key: each carries their actual state, in their own words", calmSend.prompt.includes("Not urgent, just thinking it through.") && !calmSend.prompt.includes("drowning") && distressWait.prompt.includes("I feel like I'm drowning.") && !distressWait.prompt.includes("Not urgent"));
  check("key: the read's send goes (calm deliberation)", calmSend.v.read === "model" && MF.momentAction(calmSend.v, { waits: 0 }, NOW).act === "send");
  check("key: the read's wait waits (genuine distress)", distressWait.v.read === "model" && MF.momentAction(distressWait.v, { waits: 0 }, NOW).act === "wait");
  // The same two members with the read's verdicts swapped: code follows the read, never the mood.
  const calmWait = await run(calm, "wait");
  const distressSend = await run(distress, "send");
  check("key: code doesn't auto-send the calm one (the read's wait holds it)", MF.momentAction(calmWait.v, { waits: 0 }, NOW).act === "wait");
  check("key: code doesn't auto-suppress the distressed one (the read's send sends it)", MF.momentAction(distressSend.v, { waits: 0 }, NOW).act === "send");
  check("key: what they asked for during distress is never read or held: it goes as asked", !MF.momentFitApplies("requested", { askId: "a1" }, { type: "event_offer", hardDay: true }) && !failedChecks(PR.evaluateCandidates({ ...base, ...held, candidates: [cand("event_offer", { askId: "a1", fromProfile: false, match: { tier: 2 } }, { id: "asked" })] } as any), "asked").includes("hard_day"));
  check("key: a safety follow-up is never read for the mood", !MF.momentFitApplies("unsolicited", { safetyFollowUp: true }, { type: "event_offer", hardDay: true }));
  check("key: check-ins are read as before (unchanged)", MF.momentFitApplies("checkin", {}, { type: "goal_checkin" }) && !MF.momentFitApplies("checkin", {}, { type: "ask_checkin", hardDay: true }));
  check("key: the check-ins and nudges that wait out a hard day still do (HOLD_WHILE_STRUGGLING unchanged)", PR.HOLD_WHILE_STRUGGLING.has("goal_checkin") && PR.HOLD_WHILE_STRUGGLING.has("calendar_follow") && !PR.HOLD_WHILE_STRUGGLING.has("event_offer"));
}

// ---------------------------------------------------------------- 3. waiting is bounded, and a read that fails never sends
{
  const wait = { verdict: "wait" as const, why: "not now", read: "model" as const };
  check("bounded: a wait re-queues it MOMENT_FIT.waitHours later", (() => { const a = MF.momentAction(wait, { waits: 0 }, NOW); return a.act === "wait" && a.retryAt.getTime() === NOW.getTime() + MF.MOMENT_FIT.waitHours * HOUR; })());
  check("bounded: after MOMENT_FIT.maxWaits waits it is dropped with the reason, never held forever", MF.momentAction(wait, { waits: MF.MOMENT_FIT.maxWaits }, NOW).act === "drop");
  check("bounded: a read that failed waits (never sends), and is let go after maxUnread", MF.momentAction({ verdict: "wait", why: "x", read: "failed" }, { waits: 0, unread: 0 }, NOW).act === "wait" && MF.momentAction({ verdict: "wait", why: "x", read: "failed" }, { waits: 0, unread: MF.MOMENT_FIT.maxUnread }, NOW).act === "drop");
}

// ---------------------------------------------------------------- 4. no backlog dump, stale offers dropped
{
  // Several finds waiting from a hard stretch (a composer skip's moodSkipAt), past the cap: the pick still sends one message.
  const waited = [0, 1, 2, 3].map((i) => cand("event_offer", { askId: "profile", fromProfile: true, picked: true, match: { tier: (i % 3) + 1 }, moodSkipAt: pt("2026-11-07T10:00:00").toISOString() }, { id: `w${i}`, createdAt: pt("2026-11-07T09:00:00") }));
  const ev = PR.evaluateCandidates({ ...base, ...capped, candidates: waited } as any);
  const lead = ev.eligible[0];
  check("release: past the cap they compete again", ev.eligible.length >= 1, failedChecks(ev, "w0"));
  check("release: one message carries at most MAX_PICKED_TOGETHER finds (no stacking)", !!lead && PR.pickSiblingOffers(lead, ev.eligible.filter((c) => c !== lead)).length <= PR.MAX_PICKED_TOGETHER - 1);
  check("release: the day's find cap still holds (a discovery lead at the cap waits for tomorrow)", PR.capBundle(waited[0], waited.slice(1), 0).deferLead === true && PR.capBundle(waited[0], waited.slice(1), 1).sibs.length === 0);
  check("release: a find that waited past a day is re-read for relevance before it goes (stale ones are archived)", PR.needsRelevanceCheck(waited[0], NOW));
  const past = cand("event_offer", { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } }, { id: "past", expiresAt: pt("2026-11-08T20:00:00") });
  check("release: a past event is out (expired), never sent late", failedChecks(PR.evaluateCandidates({ ...base, ...capped, candidates: [past] } as any), "past").includes("not_expired"));
  const P = src("harness/proactive.ts");
  check("release: the send-time read sees what else is waiting and their latest texts and call before anything goes", /const queued = await STR\.loadQueuedFor\(pool, userId, c\.id\);/.test(P) && /recent: known \? recentStamped/.test(P) && /const call = await STR\.loadCallContext\(userId\)/.test(P));
}

// ---------------------------------------------------------------- 5. the dispatch wiring
{
  const P = src("harness/proactive.ts");
  check("wiring: the read applies with the hard-day read (needsCare), the composed find bundle included", /const applies = !opts\.dryRun && STR\.momentFitApplies\(cls, c\.payload, \{ pulled: opts\.pulled, type: c\.type, hardDay: hardDayOn \}\);/.test(P) && !/!composed && STR\.momentFitApplies/.test(P));
  check("wiring: the bundle's composed text is what the read judges", /draft = composed \? \{ messages: composed\.messages/.test(P) && /if \(!\(await moment\.judge\(draft\.messages\.join\("\\n"\), draftChecks\)\)\) return;/.test(P));
  check("wiring: no class hold on a hard day for anything Cue starts outside a pull", !/hardDayHolds\(/.test(P) && !/only companionship goes; a find or an offer/.test(P));
  check("wiring: the safety hold is untouched", /if \(state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer" \|\| c\.type === "name_change" \|\| c\.type === "announcement"\)\) \{/.test(P));
}

console.log(`\nhard day judged: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
