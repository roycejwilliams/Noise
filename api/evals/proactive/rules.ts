// Model-free checks for the pure decisions behind the 2026-09-17 code
// review fixes: no-timezone hours window, opt-out blocking, expiry never
// getting extended by a re-enqueue, the self-report match-nudge dedupe key,
// and the Luma webhook replay window. No model, no DB — every function here
// is pure.
//
//   npx tsx evals/proactive/rules.ts
import "dotenv/config";
import { isReasonableLocalHour } from "../../src/services/localHours.js";
import { userLevelChecks, mergeExpiry, localHourOk, candidateChecks, laneOf, type Candidate, type SendRecord } from "../../src/harness/proactive.js";
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

console.log(`proactive rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
