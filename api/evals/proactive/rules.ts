// Model-free checks for the pure decisions behind the 2026-09-17 code
// review fixes: no-timezone hours window, opt-out blocking, expiry never
// getting extended by a re-enqueue, the self-report match-nudge dedupe key,
// and the Luma webhook replay window. No model, no DB — every function here
// is pure.
//
//   npx tsx evals/proactive/rules.ts
import "dotenv/config";
import { readFileSync } from "fs";
import { isReasonableLocalHour } from "../../src/services/localHours.js";
import { userLevelChecks, mergeExpiry, localHourOk, candidateChecks, laneOf, unansweredPauseFor, pickSiblingOffers, codePick, TYPE_POLICY, RULES, type Candidate, type SendRecord } from "../../src/harness/proactive.js";
import { OFFER_FOLLOWUP_MANY, OFFER_FOLLOWUP_ONE, offerFollowUp, stripClosingQuestion } from "../../src/services/offerFollowUp.js";
import { pickCanonicalEventId, type CrossMatch } from "../../src/services/eventMatching.js";
import { lumaTimestampInWindow } from "../../src/routes/luma.js";
import { gate } from "../../src/harness/core.js";
import { countShowings, repeatRule, type OfferHistory } from "../../src/harness/matchGate.js";
import { offerItemKey, outcomeForReaction, reactionFact } from "../../src/services/offerReactions.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// ---------------------------------------------------------------------------
// No-timezone hours window (localHours.ts / proactive.ts's localHourOk) —
// used to fail open (always true) for anyone with no resolvable timezone.
// Now: only 16:00-24:00 UTC (roughly 9am Pacific - 8pm Eastern) counts.
function utcDate(hour: number): Date {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

check("no timezone: before the US-safe window is blocked (10:00 UTC)", isReasonableLocalHour(null, utcDate(10)) === false);
check("no timezone: right at the window start is allowed (16:00 UTC)", isReasonableLocalHour(null, utcDate(16)) === true);
check("no timezone: mid-window is allowed (20:00 UTC)", isReasonableLocalHour(null, utcDate(20)) === true);
check("no timezone: right before midnight is allowed (23:00 UTC)", isReasonableLocalHour(null, utcDate(23)) === true);
check("no timezone: after midnight is blocked (0:00 UTC — the original 2am Pacific bug)", isReasonableLocalHour(null, utcDate(0)) === false);
check("an invalid/unresolvable zone falls back to the same US-safe window, not fail-open", isReasonableLocalHour("Not/A_Real_Zone", utcDate(10)) === false);
check("a real timezone still uses its own local hours, not the UTC fallback", isReasonableLocalHour("America/Los_Angeles", utcDate(16)) === true); // 9am PT
check("proactive.ts's localHourOk matches the same no-timezone window", localHourOk(utcDate(10), null) === false && localHourOk(utcDate(20), null) === true);

// ---------------------------------------------------------------------------
// Opt-out blocks a proactive send — pure gate check (userLevelChecks),
// exercised the same way sendWithLedger/sendExempt re-check it at send time.
const baseState = { now: new Date("2026-09-17T18:00:00Z"), timezone: "America/Los_Angeles", sends: [] as SendRecord[], lastInboundAt: null };
check("opted-out user fails the not_opted_out check", gate(userLevelChecks({ ...baseState, optedOut: true })).failed.some((c) => c.name === "not_opted_out"));
check("a non-opted-out user passes not_opted_out", gate(userLevelChecks({ ...baseState, optedOut: false })).failed.every((c) => c.name !== "not_opted_out"));

// ---------------------------------------------------------------------------
// Expiry never gets extended by a re-enqueue (proactive.ts's mergeExpiry) —
// the hourly ask-checkin/companion crons used to push a blocked candidate's
// expiry out every tick, so it could never expire.
const earlier = new Date("2026-09-18T00:00:00Z");
const later = new Date("2026-09-25T00:00:00Z");
check("re-enqueue with a LATER expiry keeps the earlier one", mergeExpiry(earlier, later)?.getTime() === earlier.getTime());
check("re-enqueue with an EARLIER expiry adopts it (still the earliest seen)", mergeExpiry(later, earlier)?.getTime() === earlier.getTime());
check("no existing expiry adopts the incoming one", mergeExpiry(null, later)?.getTime() === later.getTime());
check("no incoming expiry keeps the existing one", mergeExpiry(earlier, null)?.getTime() === earlier.getTime());
check("neither side has an expiry stays null (no expiry, not a bug)", mergeExpiry(null, null) === null);

// ---------------------------------------------------------------------------
// Self-report match-nudge dedupe key (eventMatching.ts's pickCanonicalEventId)
// — used to be `self:${mentionId}`, a fresh id every mention that reset the
// one-nudge-per-event dedup for the exact same pair of real people.
const alice = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";
const carol = "33333333-3333-3333-3333-333333333333";
const noRealEvent: CrossMatch[] = [{ user_id: bob, event_api_id: null }];
check(
  "same pair, no real event: the id is identical across two separate mentions (was self:${mentionId}, different every time)",
  pickCanonicalEventId(noRealEvent, [alice, bob]) === pickCanonicalEventId(noRealEvent, [bob, alice]),
);
check(
  "a different pair gets a different id",
  pickCanonicalEventId(noRealEvent, [alice, bob]) !== pickCanonicalEventId([{ user_id: carol, event_api_id: null }], [alice, carol]),
);
check(
  "a real Luma event id always wins over the synthetic fallback",
  pickCanonicalEventId([{ user_id: bob, event_api_id: "evt_real123" }], [alice, bob]) === "evt_real123",
);

// ---------------------------------------------------------------------------
// Luma webhook replay window (routes/luma.ts's lumaTimestampInWindow) — a
// captured, still-correctly-signed delivery replayed later must be rejected
// on the timestamp before the signature is even compared.
const nowSec = Math.floor(Date.now() / 1000);
check("a fresh timestamp (now) is in the window", lumaTimestampInWindow(String(nowSec), new Date(nowSec * 1000)));
check("a timestamp 2 minutes old is still in the window", lumaTimestampInWindow(String(nowSec - 120), new Date(nowSec * 1000)));
check("a timestamp 30 minutes old (a captured replay) is rejected", !lumaTimestampInWindow(String(nowSec - 1800), new Date(nowSec * 1000)));
check("a timestamp from the future (clock skew abuse) is rejected past the window", !lumaTimestampInWindow(String(nowSec + 1800), new Date(nowSec * 1000)));
check("a non-numeric timestamp is rejected, not treated as valid", !lumaTimestampInWindow("not-a-number", new Date(nowSec * 1000)));

// Feelings shape how, never whether (2026-09-18): on a hard day, anything
// that brings them into the room still goes; only check-ins and updates wait.
const hardDay = { now: new Date("2026-09-18T20:00:00Z"), sends: [] as SendRecord[], lastInboundAt: null, needsCare: true };
const cand = (type: Candidate["type"]): Candidate => ({ id: "1", userId: "u", type, targetKey: `${type}:x`, topicKey: `${type}:x`, summary: "", priority: 50, dueAt: new Date("2026-09-18T19:00:00Z"), expiresAt: null, payload: {}, attempts: 0, createdAt: new Date("2026-09-18T19:00:00Z") });
const heldFor = (type: Candidate["type"]) => candidateChecks(cand(type), hardDay).some((c) => c.name === "emotional_timing" && !c.pass);
check("a struggling guest's event question (ask_solicitation) is not held", !heldFor("ask_solicitation"));
check("a struggling member's event offer is not held", !heldFor("event_offer"));
check("a struggling member's ask check-in still waits", heldFor("ask_checkin"));
check("a struggling member's product update still waits", heldFor("product_update"));

// Openings share the room lane (2026-09-18, merged back from their own lane).
check("an opening's offer is in the room lane", laneOf("event_offer") === "room");
check("a check-in stays in the other lane", laneOf("ask_checkin") === "other");

// Repeats depend on what happened (2026-09-18), not just that it was shown.
const rNow = new Date("2026-10-20T18:00:00Z");
const rToday = "2026-10-20";
const hist = (daysAgo: number[], outcome: OfferHistory["outcome"] = null, answered = false): OfferHistory => ({
  shownAt: daysAgo.map((d) => new Date(rNow.getTime() - d * 86_400_000)),
  outcome,
  answered,
});
const opening = (date: string | null) => ({ isEvent: false, date, shortNotice: false });
const event = (date: string, shortNotice = false) => ({ isEvent: true, date, shortNotice });
const act = (h: OfferHistory, m: { isEvent: boolean; date: string | null; shortNotice: boolean }) => repeatRule(h, m, rToday, rNow).action;
check("never shown is new", act(hist([]), opening("2026-11-02")) === "new");
check("declined never comes back, even a month later", act(hist([40], "declined"), opening("2026-11-02")) === "blocked");
check("declined gets no day-before reminder either", act(hist([5], "declined"), event("2026-10-21", true)) === "blocked");
check("went or applied never comes back", act(hist([40], "acted"), opening(null)) === "blocked");
check("unanswered, 31 days ago, still open: comes back once", act(hist([31]), opening("2026-11-02")) === "resurface");
check("unanswered with no stated deadline can come back too", act(hist([31]), opening(null)) === "resurface");
check("unanswered, 10 days ago: not yet", act(hist([10]), opening("2026-11-02")) === "blocked");
check("unanswered but past its deadline: never", act(hist([31]), opening("2026-10-01")) === "blocked");
check("already came back once: never a third time", act(hist([70, 35]), opening("2026-11-02")) === "blocked");
check("same-day records count as one showing", countShowings(hist([31, 31, 30.5]).shownAt).length === 1);
check("they replied right after seeing it: not re-pitched", act(hist([40], null, true), opening("2026-11-02")) === "blocked");
check("interested, deadline 3 days out: one reminder", act(hist([20], "interested"), opening("2026-10-23")) === "remind");
check("interested, deadline 5 days out: reminder", act(hist([20], "interested"), opening("2026-10-25")) === "remind");
check("interested, deadline 12 days out: waits", act(hist([20], "interested"), opening("2026-11-01")) === "blocked");
check("interested, no stated deadline: no reminder", act(hist([20], "interested"), opening(null)) === "blocked");
check("interested, deadline today: too late for a reminder", act(hist([20], "interested"), opening("2026-10-20")) === "blocked");
check("an event they saw, happening within a day: the day-before reminder stays", act(hist([6]), event("2026-10-21", true)) === "remind");

// Reactions to sent offers become the outcome the repeat rule reads (2026-09-18).
check("an event's reaction is keyed by its event id", offerItemKey({ name: "Demo Night", event_api_id: "evt-1" }) === "event:evt-1");
check("an opening's reaction is keyed by its name", offerItemKey({ name: "Y Combinator Winter 2027 Batch" }) === "name:y combinator winter 2027 batch");
check("'not interested' is saved as declined, so it never comes back", outcomeForReaction("not_interested") === "declined" && act(hist([40], "declined"), opening("2026-11-02")) === "blocked");
check("'already applied' is saved as acted, so no reminder", outcomeForReaction("already_did_it") === "acted" && act(hist([20], "acted"), opening("2026-10-23")) === "blocked");
check("'interested' earns the deadline reminder", outcomeForReaction("interested") === "interested" && act(hist([20], "interested"), opening("2026-10-23")) === "remind");
const passed = { id: 1, itemKey: "name:x", itemName: "Precursor Ventures", kind: "opportunity" as const, url: null, sentAt: new Date() };
check("the reply is told not to push after a pass", /no pressure/.test(reactionFact(passed, "not_interested")) && /don't push/.test(reactionFact(passed, "not_interested")));

// The pause after unanswered texts: a day after one, three days after two in a
// row (2026-09-21: one quiet text must not silence events for 72 hours).
check("one unanswered text pauses for 24 hours", unansweredPauseFor(1) === 24 && RULES.unansweredPauseHours === 24);
check("two unanswered texts in a row pause for 72 hours", unansweredPauseFor(2) === 72 && unansweredPauseFor(5) === 72);
{
  const now = new Date("2026-09-21T16:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000);
  const send = (h: number, type = "event_offer"): SendRecord => ({ type, sentAt: hoursAgo(h), targetKey: `t${h}`, topicKey: null, exempt: false } as SendRecord);
  const st = (sends: SendRecord[], lastInboundAt: Date | null) => ({ now, sends, lastInboundAt, timezone: "America/Los_Angeles", optedOut: false, needsCare: false } as any);
  const paused = (state: any) => gate(userLevelChecks(state, { lane: "room" })).failed.some((c) => c.name === "unanswered_pause");
  check("one unanswered offer 16h ago still pauses", paused(st([send(16)], hoursAgo(20))));
  check("one unanswered offer 25h ago no longer pauses", !paused(st([send(25)], hoursAgo(30))));
  check("two unanswered offers, the last 25h ago, still pause", paused(st([send(49), send(25)], hoursAgo(60))));
  check("two unanswered offers, the last 73h ago, no longer pause", !paused(st([send(100), send(73)], hoursAgo(120))));
  check("a reply after the offer lifts the pause", !paused(st([send(10)], hoursAgo(5))));
}

// Companion first (2026-09-22, Royce: Co is a companion first; events are the wedge). Real case:
// an offer boosted to 85 because the member seemed frustrated beat a post-call reflection (80),
// then its unanswered pause kept the reflection from ever going out.
{
  const now = new Date("2026-09-22T16:02:00Z");
  const cand = (type: string, priority: number, id: string): Candidate =>
    ({ id, userId: "u", type, targetKey: `${type}:${id}`, topicKey: `${type}:${id}`, summary: "", priority, dueAt: now, expiresAt: null, payload: {}, attempts: 0, createdAt: now } as unknown as Candidate);
  check("a companion message is picked before an offer, even one boosted to 85", codePick([cand("event_offer", 85, "a"), cand("post_call", 80, "b")])?.type === "post_call");
  check("even the lowest companion message (a check-in) goes before an offer", codePick([cand("event_offer", 95, "a"), cand("companion", 10, "b")])?.type === "companion");
  check("between two offers, priority still decides", codePick([cand("event_offer", 60, "a"), cand("event_offer", 85, "b")])?.id === "b");

  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000);
  const send = (h: number, type: string): SendRecord => ({ type, sentAt: hoursAgo(h), targetKey: `${type}${h}`, topicKey: null, exempt: false } as SendRecord);
  const st = (sends: SendRecord[]) => ({ now, sends, lastInboundAt: null, timezone: "America/Los_Angeles", optedOut: false, needsCare: false } as any);
  const failed = (state: any, lane: "room" | "other") => gate(userLevelChecks(state, { lane })).failed.map((c) => c.name);
  check("an unanswered offer no longer pauses a check-in on the person", !failed(st([send(5, "event_offer")]), "other").includes("unanswered_pause"));
  check("an unanswered check-in still never pauses an offer", !failed(st([send(5, "post_call")]), "room").includes("unanswered_pause"));
  check("an unanswered offer still pauses the next offer", failed(st([send(5, "event_offer")]), "room").includes("unanswered_pause"));
  check("any two unprompted texts are at least 3 hours apart, whatever their lane", failed(st([send(1, "event_offer")]), "other").includes("spacing") && !failed(st([send(4, "event_offer")]), "other").includes("spacing"));
  check("an exempt send (event change, reminder) doesn't count toward spacing", !failed(st([{ ...send(1, "event_change"), exempt: true } as SendRecord]), "other").includes("spacing"));
  check("caps are unchanged: 1 room text a day, 4 a week", RULES.roomMaxPerLocalDay === 1 && RULES.roomMaxPer7Days === 4);
  check("ask check-ins wait 7 days, not 14", TYPE_POLICY.ask_checkin.topicGapDays === 7);
  check("the 'thinking about you' rhythm is every ~4 days (Royce, 2026-09-28)", TYPE_POLICY.companion.typeGapDays === 4 && /INTERVAL '4 days'/.test(readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8")));

  const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  const companionCron = jobs.slice(jobs.indexOf("// No paid subscription needed"), jobs.indexOf("Companion check-in cron error"));
  const companionWhere = companionCron.slice(companionCron.indexOf("WHERE u.sms_opted_out"), companionCron.indexOf("LIMIT 50"));
  check("companion check-ins no longer require a paid subscription", companionWhere.length > 0 && !/subscription_status/.test(companionWhere));
  check("a stretch of offers with nothing about the person queues a check-in early", /count\(DISTINCT date_trunc\('day', ps\.sent_at\)\)[\s\S]{0,200}>= 3/.test(companionCron) && /NOT EXISTS \(SELECT 1 FROM proactive_sends ps/.test(companionCron));
  check("archived accounts never get a check-in", /u\.archived_at IS NULL/.test(companionCron));
  check("the ask check-in cron waits 7 days", /COALESCE\(ac\.last_checked_at, ac\.created_at\) <= NOW\(\) - INTERVAL '7 days'/.test(jobs));
}

// Everyone who has talked to Co gets a recap, and check-ins aren't silently off for anyone
// (2026-09-22): a member who stopped after name and email had no profile row, so no recap, so no
// check-in, and the auto-intake call needs a paid subscription, so nothing could reach them.
{
  const mc = readFileSync(new URL("../../src/services/memoryCompaction.ts", import.meta.url), "utf8");
  const recapSelect = mc.slice(mc.indexOf("export async function findUsersDueForRecap"), mc.indexOf("return rows.map", mc.indexOf("export async function findUsersDueForRecap")));
  check("recap selection starts from members, not only those with a profile row", /FROM users u\s+LEFT JOIN co_profiles cp/.test(recapSelect));
  check("recap selection skips archived and pre-intake rows", /u\.identity_captured = true/.test(recapSelect) && /u\.archived_at IS NULL/.test(recapSelect));
  check("a recap creates the profile row if it's missing", /INSERT INTO co_profiles \(user_id, last_recap_at, updated_at\)[\s\S]{0,120}ON CONFLICT \(user_id\) DO UPDATE SET last_recap_at = NOW\(\)/.test(mc));
  const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  const where = jobs.slice(jobs.indexOf("WHERE u.sms_opted_out = false\n           AND u.archived_at IS NULL\n           AND u.identity_captured"), jobs.indexOf("LIMIT 50", jobs.indexOf("No paid subscription needed")));
  check("companion check-ins need a recap, not life chapters (text-only members qualify)", where.length > 0 && !/life_chapters/.test(where) && /cp\.last_recap_at IS NOT NULL/.test(where));
  const cc = readFileSync(new URL("../../src/agent/companionCheckin.ts", import.meta.url), "utf8");
  check("a member Co barely knows gets a warm check-in instead of SKIP", /if the recap shows Co barely knows them yet[\s\S]{0,80}don't SKIP/.test(cc));
  check("that check-in carries no events, offers, pitch or promises", /No events, no offers, no pitch, no promise of anything Co will do/.test(cc));
  check("a member Co knows well with nothing open still gets SKIP, never a generic check-in", /a generic "thinking of you" is never acceptable/.test(cc));
}

// Every tier that has something goes out together, then one question
// (2026-09-21, Royce: "it should always surface the 3 tiers if they are available").
check("a closing offer question is dropped", stripClosingQuestion("Demo Night at WorkOS is Oct 5, live demos only. Want me to grab you a spot?") === "Demo Night at WorkOS is Oct 5, live demos only.");
check("a closing 'on your radar' question is dropped", stripClosingQuestion("The SOLO Founder Club is Oct 6 in SF. It fits what you're building. Want this on your radar?") === "The SOLO Founder Club is Oct 6 in SF. It fits what you're building.");
check("a description with no question is untouched", stripClosingQuestion("Tech Week runs Oct 5 to 11 and fits your window.") === "Tech Week runs Oct 5 to 11 and fits your window.");
check("a question in the middle is kept", stripClosingQuestion("Ever been to Demo Night? It is Oct 5 and fits you.") === "Ever been to Demo Night? It is Oct 5 and fits you.");
check("a lone question is kept rather than emptied", stripClosingQuestion("Want to hear about Demo Night?") === "Want to hear about Demo Night?");
check("follow-up for several offers asks about 'any of these'", OFFER_FOLLOWUP_MANY.includes(offerFollowUp(3, () => 0)) && OFFER_FOLLOWUP_MANY.includes(offerFollowUp(2, () => 0.99)));
check("follow-up for one offer asks about that one", OFFER_FOLLOWUP_ONE.includes(offerFollowUp(1, () => 0)));
check("no follow-up line has an em dash or exclamation", [...OFFER_FOLLOWUP_MANY, ...OFFER_FOLLOWUP_ONE].every((l) => !/[—–!]/.test(l) && l.endsWith("?")));
{
  const cand = (id: string, tier: number, priority = 60, extra: Record<string, unknown> = {}): Candidate =>
    ({ id, userId: "u", type: "event_offer", targetKey: `event_offer:${id}`, topicKey: `t:${id}`, summary: "", priority, dueAt: new Date("2026-09-21T16:00:00Z"), expiresAt: new Date("2026-10-06T00:00:00Z"), status: "pending", attempts: 0, payload: { match: { tier }, ...extra } } as unknown as Candidate);
  const t1 = cand("a", 1), t2 = cand("b", 2), t3 = cand("c", 3), t3b = cand("d", 3, 55);
  const ids = (xs: Candidate[]) => xs.map((x) => x.id).join(",");
  check("the other tiers ride along with the picked offer", ids(pickSiblingOffers(t2, [t1, t2, t3])) === "a,c");
  check("only one offer per tier goes out", ids(pickSiblingOffers(t2, [t2, t3, t3b])) === "c");
  check("a second offer from the picked tier waits", ids(pickSiblingOffers(t3, [t3, t3b])) === "");
  check("the best offer in a tier is the one that rides along", ids(pickSiblingOffers(t2, [t2, t3b, t3])) === "c");
  check("a reminder rides alone", ids(pickSiblingOffers(cand("r", 2, 60, { reminder: true }), [t1, t3])) === "");
  check("a reminder is never pulled into another offer", ids(pickSiblingOffers(t2, [t1, cand("r", 3, 60, { reminder: true })])) === "a");
  check("non-offer candidates never ride along", ids(pickSiblingOffers(t2, [{ ...t1, type: "ask_checkin" } as Candidate])) === "");
}

// Dispatch must follow the sweeps, not race them (2026-09-21: the :00 dispatch
// sent one tier's offer three seconds before the sweep queued the others).
{
  const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
  check("the dispatch cron is not on the sweep minutes", jobs.includes('cron.schedule("15,45 * * * *", runDispatch)') && !/cron\.schedule\("\*\/15 \* \* \* \*", async \(\) => \{\s*if \(dispatchRunning\)/.test(jobs));
  check("each surfacing sweep dispatches when it finishes queueing", (jobs.match(/await runDispatch\(\);/g) ?? []).length === 2);
}

// Follow-ups about something Co sent (2026-09-26: "Did anything come of
// AgentFi demo day?" on Sep 26 for an Oct 7 event; then Co agreed it had
// never sent it).
{
  const { followUpDate } = await import("../../src/services/recommendationOutcome.js");
  check("follow-up date: a post's stated date counts", followUpDate({ statedDates: { start: "2026-10-07", end: null } }) === "2026-10-07");
  check("follow-up date: the last day when it spans", followUpDate({ statedDates: { start: "2026-10-05", end: "2026-10-11" } }) === "2026-10-11");
  check("follow-up date: a real event date wins", followUpDate({ event_date: "2026-10-10", statedDates: { start: "2026-10-01", end: null } }) === "2026-10-10");
  check("follow-up date: none is none", followUpDate({}) === null && followUpDate({ statedDates: { start: "soon" } }) === null);
  const ro = readFileSync(new URL("../../src/services/recommendationOutcome.ts", import.meta.url), "utf8");
  check("scheduling and queueing both use it", /const eventDate = followUpDate\(match\);/.test(ro) && /const eventDate: string \| undefined = followUpDate\(match\) \?\? undefined;/.test(ro));
  const reg = readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
  check("a follow-up before its day is deferred, not sent or dropped", /if \(end\.getTime\(\) > Date\.now\(\)\) return \{ defer: nextLocalHour\(end, tz, 10\)/.test(reg));
  check("no record of sending it, no follow-up about it", /if \(onlyAboutASend && !sent\) return skip\("no record of Co sending it to them"\);/.test(reg));
  check("the draft knows when Co sent it and what it said", /co_sent_it_on: sent\?\.date/.test(reg) && /what_co_said_when_it_sent_it/.test(reg) && !/"a few days ago"/.test(reg));
  check("the send is remembered for Co's next replies", /writeMemory\(c\.userId, "followup_context"/.test(reg) && /memory_type = 'followup_context'/.test(readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8")));
  const pr = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
  check("a deferred candidate moves, it isn't dropped", /if \("defer" in draft\) \{\s*await pool\.query\(\s*`UPDATE proactive_candidates SET due_at = \$2/.test(pr));
}

// Every memory type code writes must be allowed by the table (2026-09-26:
// five weren't, so those writes all failed quietly, one of them for weeks).
{
  const { readdirSync, statSync } = await import("fs");
  const { join } = await import("path");
  const root = new URL("../../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(root);
  const written = new Set<string>();
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    for (const m of t.matchAll(/writeMemory\([^,]+,\s*"([a-z_]+)"/g)) written.add(m[1]);
    for (const m of t.matchAll(/INTO co_memories \(user_id, memory_type, content\)\s*(?:VALUES \(\$1, |SELECT \$1, )'([a-z_]+)'/g)) written.add(m[1]);
  }
  const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
  const list = mig.slice(mig.indexOf("const memoryTypes = ["), mig.indexOf("];", mig.indexOf("const memoryTypes = [")));
  const allowed = new Set(Array.from(list.matchAll(/"([a-z_]+)"/g)).map((m) => m[1]));
  const missing = [...written].filter((w) => !allowed.has(w));
  check(`every memory type code writes is allowed by the table${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`, written.size > 5 && missing.length === 0);
}

// Smarter first texts (2026-09-28): Co's pick is read even when cut off, and a
// draft that breaks a check gets one rewrite told what to fix.
{
  const P = await import("../../src/harness/proactive.js");
  check("a whole pick is read", P.readPick('{"id": "4", "why": "stressed about the deck"}')?.id === "4");
  check("a pick cut off mid-reason still counts", P.readPick('{"id": "4", "why": "They\'re stuck on sponsors for the 10th, so checking in on the deck meets them wh')?.id === "4");
  check("no id is no pick", P.readPick("") === null && P.readPick("I think the companion one") === null);
  const pr = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
  check("the pick has room to answer, and time", /maxOutputTokens: 1000,\s*experimental_telemetry: \{ isEnabled: true, functionId: "proactive.choosePick" \}/.test(pr) && /"pick timed out"\)\), 15_000\)/.test(pr));
  check("a failed draft gets one rewrite, told what it broke", /draftAgain\(first, \(\) => registry\[c\.type\]\.draft\(c, person\)\)/.test(pr) && /It broke: \$\{redo\.failed\}/.test(pr));
  const reg = readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
  check("only Co's own skip holds check-ins for 14 days; a failed draft retries in about 2", /const coChoseSkip = \/\^model chose SKIP\//.test(reg) && /coChoseSkip \? "0" : "12"/.test(reg) && /onDropped\?\.\(c, status, reason\)/.test(pr) && /skip\("model chose SKIP/.test(reg));
  const U = await import("../../src/services/understanding.js");
  const now = new Date("2026-09-28T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const all = (d: number) => Object.fromEntries(U.RAPPORT_TOPICS.map((t) => [t, daysAgo(d)]));
  check("a new member: everything is still to figure out, what's going on first", U.understandingGaps({}, {}, now)[0]?.topic === "current_situation" && U.understandingGaps({}, {}, now).length === U.RAPPORT_TOPICS.length);
  check("recently heard: nothing to catch up on", U.understandingGaps(all(3), {}, now).length === 0);
  check("what's going on goes stale after five weeks; who they are lasts longer", (() => { const g = U.understandingGaps(all(40), {}, now); return g.some((x) => x.topic === "current_situation" && x.kind === "stale") && !g.some((x) => x.topic === "personality"); })());
  check("never asks the same thing twice in two weeks", U.understandingGaps({}, { current_situation: daysAgo(3) }, now)[0]?.topic !== "current_situation");
  check("unknown comes before stale", (() => { const c = all(40); delete (c as any).people_to_meet; return U.understandingGaps(c, {}, now)[0]?.kind === "unknown"; })());
  check("a stale topic reads as what's changed, with when Co last heard", /^what's changed with .*last heard about it on 2026-08-19/.test(U.gapDescription({ topic: "goals_challenges", kind: "stale", lastHeard: "2026-08-19" })));
  check("last learned is the newest stamp", U.lastLearned({ a: "2026-09-01T00:00:00Z", b: "2026-09-20T00:00:00Z" }) === "2026-09-20T00:00:00Z" && U.lastLearned({}) === null);
  check("companion texts can come every ~4 days, not 14", TYPE_POLICY.companion.typeGapDays === 4);
  const pe = readFileSync(new URL("../../src/services/profileExtraction.ts", import.meta.url), "utf8");
  check("only what they said in this conversation counts as freshly heard", /const covered = \(coverage\.fresh_topics \?\? \[\]\)/.test(pe) && /"fresh_topics": \[/.test(pe));
  const cr = readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
  const cc = readFileSync(new URL("../../src/agent/companionCheckin.ts", import.meta.url), "utf8");
  check("curiosity only where the conversation leads, in replies and check-ins", /Only if what they just said actually leads there/.test(cr) && /never steer to it/.test(cr) && /If nothing they said leads there, return SKIP/.test(cc) && /what_co_cannot_do: "find sponsors, investors or funders themselves/.test(cc));
  {
    // Three other-lane texts this week: a check-in still goes; a fourth follow-up doesn't.
    const now2 = new Date("2026-09-28T19:30:00Z");
    const sent = (h: number, type: string) => ({ type, sentAt: new Date(now2.getTime() - h * 3_600_000), exempt: false }) as SendRecord;
    const cand = (type: string) => ({ id: type, type, targetKey: type, topicKey: type, priority: TYPE_POLICY[type as keyof typeof TYPE_POLICY].priority, dueAt: now2, createdAt: now2, expiresAt: null, payload: {}, attempts: 0, summary: type }) as unknown as Candidate;
    const state = { now: now2, timezone: "America/Los_Angeles", optedOut: false, lastInboundAt: now2, sends: [sent(100, "debrief"), sent(60, "post_call"), sent(30, "window_followup")], candidates: [cand("companion"), cand("ask_checkin")] } as any;
    const ev = P.evaluateCandidates(state);
    check("a full week of follow-ups doesn't block a companion check-in", ev.eligible.some((c: Candidate) => c.type === "companion"));
    // An ask check-in answers their ask (2026-10-02): no longer behind the weekly cap.
    check("...and a check-in on their own ask isn't held by it either", ev.eligible.some((c: Candidate) => c.type === "ask_checkin"));
    const state2 = { ...state, sends: [sent(100, "companion"), sent(60, "companion"), sent(30, "debrief")] };
    check("check-ins don't use up the follow-ups' weekly room", P.evaluateCandidates({ ...state2, candidates: [cand("ask_checkin")] }).eligible.length === 1);
  }
  {
    // Replies vs. broadcasts (Royce, 2026-10-02).
    const now3 = new Date("2026-10-02T19:00:00Z"); // noon Pacific
    const sent = (h: number, type: string, exempt = false) => ({ type, targetKey: `${type}:${h}`, topicKey: `${type}:${h}`, sentAt: new Date(now3.getTime() - h * 3_600_000), exempt }) as SendRecord;
    const offer = (id: string, payload: any) => ({ id, type: "event_offer", targetKey: `event_offer:${id}`, topicKey: `event_offer:${id}`, priority: 60, dueAt: now3, createdAt: now3, expiresAt: null, payload, attempts: 0, summary: id }) as unknown as Candidate;
    const asked = offer("asked", { askId: "ask-1", match: { tier: 1 } });
    const discovery = offer("discovery", { askId: "profile", fromProfile: true, match: { tier: 1 } });
    const reminder = offer("reminder", { askId: "ask-1", reminder: true });
    const profileReminder = offer("profileReminder", { askId: "profile", fromProfile: true, reminder: true });
    const resurfaced = offer("resurfaced", { askId: "ask-1", again: true });
    // Four room-lane discovery texts this week, the last one an hour ago and unanswered.
    const full = { now: now3, timezone: "America/Los_Angeles", optedOut: false, lastInboundAt: new Date(now3.getTime() - 100 * 3_600_000), sends: [sent(90, "event_offer"), sent(60, "event_offer"), sent(30, "event_offer"), sent(1, "event_offer")] } as any;
    const ev = P.evaluateCandidates({ ...full, candidates: [asked, discovery, reminder] });
    const ok = (id: string) => ev.eligible.some((c: Candidate) => c.id === id);
    check("an answer still keeps 3h spacing: a text an hour ago holds it", !ok("asked") && !ok("reminder") && ev.perCandidate.find((p: any) => p.candidate.id === "asked").checks.filter((k: any) => !k.pass).map((k: any) => k.name).join() === "spacing");
    // Same full week, the last text 4h ago and still unanswered.
    const spaced = { ...full, sends: [sent(90, "event_offer"), sent(60, "event_offer"), sent(30, "event_offer"), sent(4, "event_offer")] };
    const ev2 = P.evaluateCandidates({ ...spaced, candidates: [asked, discovery, reminder] });
    const ok2 = (id: string) => ev2.eligible.some((c: Candidate) => c.id === id);
    check("answering an explicit ask sends past a full week, today's cap and the unanswered pause", ok2("asked"));
    check("a reminder about something they asked for sends past the quota too", ok2("reminder"));
    check("a reminder or 30-day resurface of something they never asked for is discovery, held at the cap", !P.isAnswering(profileReminder) && !P.isAnswering(resurfaced) && !P.evaluateCandidates({ ...spaced, candidates: [profileReminder, resurfaced] }).eligible.length);
    // Review of #55: spacing counts every text, so nothing lands 15 minutes after an answer.
    const afterAnswer = { ...spaced, lastInboundAt: now3, sends: [sent(0.25, "debrief", true)] };
    check("15 minutes after an answer, nothing goes: not an answer, not discovery, not a companion check-in", !P.evaluateCandidates({ ...afterAnswer, candidates: [asked, discovery, { ...discovery, id: "c", type: "companion", targetKey: "companion:x", topicKey: "companion" }] }).eligible.length);
    check("3h after an answer, discovery goes again", P.evaluateCandidates({ ...afterAnswer, sends: [sent(3, "debrief", true)], candidates: [discovery] }).eligible.length === 1);
    // Queued h hours ago; due_at moved to now (a re-enqueue or a defer), as in the re-review's failure case.
    const aged = (h: number, c: Candidate, payload: any = c.payload) => ({ ...c, dueAt: now3, createdAt: new Date(now3.getTime() - h * 3_600_000), payload }) as Candidate;
    check("an answer queued over a day ago is re-checked before it goes, even if its due time moved; a fresh one or discovery isn't", P.needsRelevanceCheck(aged(25, asked), now3) && !P.needsRelevanceCheck(aged(23, asked), now3) && !P.needsRelevanceCheck(aged(72, discovery), now3));
    const triedAgo = (h: number) => aged(48, asked, { ...asked.payload, relevanceTriedAt: new Date(now3.getTime() - h * 3_600_000).toISOString() });
    check("when Co couldn't say, the item sits out 2h (others go), then is checked again, never sent unchecked", !P.evaluateCandidates({ ...spaced, candidates: [triedAgo(1)] }).eligible.length && P.evaluateCandidates({ ...spaced, candidates: [triedAgo(3)] }).eligible.length === 1 && P.needsRelevanceCheck(triedAgo(3), now3) && P.evaluateCandidates({ ...spaced, candidates: [triedAgo(1), reminder] }).eligible.length === 1);
    check("a 'still relevant' answer is remembered for a day, so it isn't paid for twice", !P.needsRelevanceCheck(aged(30, asked, { ...asked.payload, relevantAt: new Date(now3.getTime() - 2 * 3_600_000).toISOString() }), now3) && P.needsRelevanceCheck(aged(30, asked, { ...asked.payload, relevantAt: new Date(now3.getTime() - 25 * 3_600_000).toISOString() }), now3));
    check("Co's relevance answer is read; anything else holds it (null), never sends or archives", P.readRelevance('{"relevant": false, "why": "Oct 1 has passed"}')?.relevant === false && P.readRelevance('```json\n{"relevant": true, "why": "still open"}\n```')?.relevant === true && P.readRelevance("not sure") === null && P.readRelevance('{"relevant": "maybe"}') === null);
    check("unsolicited discovery stays held at the weekly cap", !ok("discovery") && ev.perCandidate.find((p: any) => p.candidate.id === "discovery").checks.some((k: any) => k.name === "weekly_cap" && !k.pass));
    check("the text after a call they were on is an answer", P.isAnswering({ type: "post_call", payload: {} } as any));
    check("a network tease (always for an open ask) and a debrief are answers; a profile offer and a guest-match nudge are discovery", P.isAnswering({ type: "network_tease", payload: { askId: "a" } } as any) && P.isAnswering({ type: "debrief", payload: {} } as any) && !P.isAnswering(discovery) && !P.isAnswering({ type: "event_match_nudge", payload: {} } as any) && !P.isAnswering({ type: "companion", payload: {} } as any));
    check("an offer with no ask behind it is discovery", !P.isAnswering(offer("x", {})));
    check("answers never use up discovery's room: three exempt answers leave the week open", P.evaluateCandidates({ ...full, lastInboundAt: now3, sends: [sent(90, "event_offer", true), sent(60, "network_tease", true), sent(30, "event_offer", true)], candidates: [discovery] }).eligible.length === 1);
    check("opt-out and local hours still hold an answer", P.evaluateCandidates({ ...spaced, optedOut: true, candidates: [asked] }).eligible.length === 0 && P.evaluateCandidates({ ...spaced, now: new Date("2026-10-02T11:00:00Z"), candidates: [{ ...asked, dueAt: new Date("2026-10-02T11:00:00Z") }] }).eligible.length === 0);
    check("an answer still never goes twice", !P.evaluateCandidates({ ...full, sends: [...full.sends, { ...sent(5, "event_offer", true), targetKey: asked.targetKey }], candidates: [asked] }).eligible.length);
    check("one text counts once: a batch of answers is exempt; a discovery offer in it makes it one counted send", P.sendIsExempt(asked, [reminder]) && !P.sendIsExempt(asked, [discovery]) && !P.sendIsExempt(discovery, [asked]) && P.sendIsExempt(discovery, [], true));
    const pr2 = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
    check("the send re-checks with the same rule and ledgers extras exempt", (pr2.match(/!\(answering && QUOTA_CHECKS\.has\(k\.name\)\)/g) ?? []).length === 2 && /sendIsExempt\(c, extras\.map\(\(e\) => e\.candidate\), opts\.ignorePacing === true\)/.test(pr2) && /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, true\) ON CONFLICT/.test(pr2));
    check("a stale answer is archived silently (no text), the pick and every sibling re-checked", /if \(!r\.relevant\) \{\s*if \(!opts\.dryRun\) await dropCandidate\(registry, c, "skipped", `stale: \$\{r\.why\}`\);[\s\S]{0,400}return;/.test(pr2) && /needsRelevanceCheck\(sib, state\.now\)/.test(pr2) && (pr2.match(/await settleRelevance\((c|sib), r\)/g) ?? []).length === 2);
  }
  {
    // One open follow-up per ask (Royce, 2026-10-02). Producers already hold
    // it, so this pins them rather than merging after the fact (review of
    // #56: a merge here would be dead code that could lose a follow-up).
    // A new producer of either type fails here until it's keyed the same way.
    const { readdirSync, statSync } = await import("fs");
    const { join } = await import("path");
    const root = new URL("../../src", import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
    const producers = walk(root)
      .filter((f) => /type: "(ask_checkin|window_followup)"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1))
      .sort();
    check("follow-ups about an ask come from exactly two producers (ask check-in cron, commitment threads)", producers.join() === "harness/memberThreads.ts,jobs/index.ts");
    const jobs = readFileSync(join(root, "jobs/index.ts"), "utf8");
    const threads = readFileSync(join(root, "harness/memberThreads.ts"), "utf8");
    check("an ask check-in is keyed to its ask, and a new one only queues once the last was sent or dropped", /targetKey: `ask_checkin:\$\{row\.ask_id\}:\$\{row\.checkin_count \+ 1\}`/.test(jobs) && /COALESCE\(ac\.last_checked_at, ac\.created_at\) <= NOW\(\) - INTERVAL '7 days'/.test(jobs));
    check("a commitment follow-up is keyed to its thread, one per thread", /type: "window_followup",\s*targetKey: `thread:\$\{threadId\}`/.test(threads));
  }
  check("principles, not quoted phrasings, and a greeting is guidance, not a veto", !/"the event"|"someone cool"|"Hey Sam,"/.test(P.PROACTIVE_RULES) && /a greeting is fine when it's natural, never a formula/.test(P.PROACTIVE_RULES) && !P.checkDraft("Hey Maya, how was the Climate Founders Mixer?", { maxSentences: 2 }).some((c: any) => !c.pass));
  check("stacked questions are still caught", P.checkDraft("How was the mixer. Did you meet anyone. Want to call this week?", { maxSentences: 2 }).some((c: any) => c.name === "draft_one_question" && !c.pass));
}

console.log(`proactive rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
