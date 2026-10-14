// In-room matching, pure rules (analysis/in-room-matching, 2026-10-07). No DB, no network, no model.
//
//   npx tsx evals/inroom/rules.ts
//
// In layer 1 since 2026-10-07 (every open finding fixed): it gates pushes.
import "../testEnv.js";
import { check, finding, results } from "./world.js";

const G = await import("../../src/harness/matchGate.js");
const C = await import("../../src/harness/introConsent.js");
const B = await import("../../src/services/eventBrief.js");
const MS = await import("../../src/services/memberSafeMemories.js");
const M = await import("../../src/services/matching.js");
const WK = await import("../../src/services/eventWalkinCheckin.js");
const PA = await import("../../src/services/preArrival.js");

// ------------------------------------------------------------ the share-reason gate on sensitive asks
// The share reason is "what they've said they're looking for: <their ask>". Which private asks get through?
const sensitiveAsks: [string, boolean][] = [
  // [ask, blocked before the 2026-10-07 rewrite?]
  ["a therapist who works with founders", true],
  ["help with my anxiety before pitches", true],
  ["a new job since my startup is running out of money", false],
  ["a lawyer for my custody case", false],
  ["a good immigration lawyer for my H-1B transfer", false],
  ["a sober community in SF", false],
  ["a psychiatrist who takes my insurance", false],
  ["fertility clinic recommendations", false],
  ["a bankruptcy attorney", false],
  ["people who have been through cancer treatment", false],
  ["a couples counselor", false],
  ["roommates since I got evicted", false],
  ["a recruiter, I'm interviewing quietly while still employed", false],
  ["an ADHD coach", false],
];
let leaky = 0;
for (const [a, blockedToday] of sensitiveAsks) {
  // Marked shareable, so this exercises the word backstop (the flag itself is checked below).
  const reason = M.shareReasonFromOwnAsk([{ text: a, type: "seeking", status: "active", kind: "ask", shareable: true }], "S1");
  const r = G.checkShareReason({ shareReason: reason, candidateStatedAsks: [a], candidatePrivateTexts: [], alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true });
  if (blockedToday) check(`share gate blocks "${a}"`, !r.pass);
  else if (r.pass) leaky++;
}
finding(`share gate: ${leaky} of ${sensitiveAsks.filter(([, b]) => !b).length} clearly private asks (custody, H-1B, sober, psychiatrist, fertility, bankruptcy, cancer, eviction, secret job search...) pass and would be quoted verbatim to another member`, leaky >= 10, { leaky });

// False positives: ordinary professional asks blocked by substring matches.
const benign = ["a health-tech cofounder", "an engineering manager to hire", "equity crowdfunding advice", "someone who knows the Visa partner program", "a quite technical PM"];
const blocked = benign.filter((a) => !G.checkShareReason({ shareReason: M.shareReasonFromOwnAsk([{ text: a, type: "seeking", status: "active", kind: "ask", shareable: true }], "S1"), candidateStatedAsks: [a], candidatePrivateTexts: [], alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true }).pass);
finding(`share gate false positives: ${blocked.length}/${benign.length} ordinary professional asks are blocked by substring matches (${blocked.join("; ")})`, blocked.length >= 4, blocked);

// The shareReason is the NEWEST open ask, whichever ask the scorer actually matched on.
{
  const intent = [
    { text: "seed checks for consumer founders", type: "offering", status: "active", kind: "ask" },
    { text: "a pediatric dentist for my kid", type: "seeking", status: "active", kind: "ask" },
  ];
  finding("share reason: built from the newest open ask (here a dentist errand), not the ask that made the match (seed checks)", /pediatric dentist/.test(M.shareReasonFromOwnAsk(intent)), M.shareReasonFromOwnAsk(intent));
  check("share reason: an ask the member never marked shareable is never used", M.shareReasonFromOwnAsk([{ text: "seed checks", type: "offering", status: "active", kind: "ask" }], "S1") === "");
  check("share reason: a marked ask can't pass the gate for someone whose shared asks don't include it", !G.checkShareReason({ shareReason: M.shareReasonFromOwnAsk([{ text: "seed checks", type: "offering", status: "active", kind: "ask", shareable: true }], "S1"), candidateStatedAsks: [], candidatePrivateTexts: [], alreadySuggestedOrDeclined: false, askerActive: true, candidateActive: true }).pass);
  check("share reason: a closed ask is never used", M.shareReasonFromOwnAsk([{ text: "old ask", type: "seeking", status: "resolved", kind: "ask" }]) === "");
  check("share reason: a goal is never used", M.shareReasonFromOwnAsk([{ text: "be a better founder", type: "seeking", status: "active", kind: "goal" }]) === "");
}

// ------------------------------------------------------------ the shareable-asks question at RSVP
{
  const S = await import("../../src/services/askSharing.js");
  const R = S;
  const B = await import("../../src/services/eventBrief.js");
  const A = (id: string, text: string, shareable?: boolean) => ({ id, text, type: "seeking", status: "active", kind: "ask", ...(shareable === undefined ? {} : { shareable }) });
  const intent = [A("a1", "a sailing crew", true), A("a2", "a technical cofounder"), A("a3", "a pediatric dentist"), A("a4", "seed investors"), { id: "g1", text: "be calmer", type: "seeking", status: "active", kind: "goal" }];
  const offered = S.undecidedAsks(intent);
  check("rsvp share: offers only undecided open asks, newest first, never a goal or an ask already decided", JSON.stringify(offered.map((a) => a.id)) === JSON.stringify(["a4", "a3", "a2"]), offered);
  const msg = S.shareAskMessage(offered) ?? "";
  check("rsvp share: one question, numbered per ask, private unless picked", /good match/.test(msg) && /1\. seed investors/.test(msg) && /3\. a technical cofounder/.test(msg) && /stays between us/.test(msg), msg);
  check("rsvp share: a single ask is a plain yes or no", /you're looking for a sailing crew\? Yes or no/.test(S.shareAskMessage([{ text: "a sailing crew" }]) ?? ""));
  check("rsvp share: nothing undecided, no question", S.shareAskMessage([]) === null && B.nameAskMessages("Co Night", null).length === 2);
  check("rsvp share: it sits beside the brief question", B.nameAskMessages("Co Night", msg).length === 3);
  const ids = offered.map((a) => a.id);
  const picks = R.readPicks("1 and 3", ids.length)!;
  const next = S.applyAskPicks(intent as any[], ids, picks) as any[];
  const by = (id: string) => next.find((e) => e.id === id);
  check("rsvp share: '1 and 3' shares exactly those asks", by("a4").shareable === true && by("a2").shareable === true && by("a3").shareable === false, next);
  check("rsvp share: an ask that wasn't offered is untouched", by("a1").shareable === true && by("g1").shareable === undefined);
  check("rsvp share: 'none' keeps every offered ask private", (S.applyAskPicks(intent as any[], ids, R.readPicks("none", 3)!) as any[]).filter((e) => ids.includes(e.id)).every((e) => e.shareable === false));
  check("rsvp share: an unclear answer is no answer", R.readPicks("maybe the cofounder one?", 3) === null && R.readPicks("all but not 2", 3) === null);
  // The strict reader, pinned here since it moved out of the removed outreach code (2026-10-14).
  check("picks: numbers, all, none", JSON.stringify(R.readPicks("1 and 3", 3)) === "[1,3]" && JSON.stringify(R.readPicks("all", 3)) === "[1,2,3]" && JSON.stringify(R.readPicks("none", 3)) === "[]" && JSON.stringify(R.readPicks("2", 3)) === "[2]");
  check("picks: ordinals and 'all but'", JSON.stringify(R.readPicks("the first and the third", 3)) === "[1,3]" && JSON.stringify(R.readPicks("all but 2", 3)) === "[1,3]" && JSON.stringify(R.readPicks("everyone except 1", 3)) === "[2,3]" && JSON.stringify(R.readPicks("just 2", 3)) === "[2]" && JSON.stringify(R.readPicks("yes, 1 and 3 please", 3)) === "[1,3]");
  for (const m of ["not all of them, just 2", "only 2, not 1 and 3", "I don't want 1 or 3", "no, not 1 or 3", "the second one", "that's all for now", "they each look good, let me think", "what's everyone's background?", "1, 3, not 2", "not 1", "skip 2", "all but 4", "all 1 and 2", "maybe 1?", "1?", "no 1", "no 1 and 3", "no, 1", "1 or 3 if you think so", "sure, whatever you think", "yes"]) check(`picks: "${m}" is unclear (null), never a guess`, R.readPicks(m, 3) === null);
  check("picks: a number beyond the list or zero is unclear", R.readPicks("4", 3) === null && R.readPicks("0 and 1", 3) === null && R.readPicks("10", 3) === null);
  check("picks: 'all three' only when there are three", JSON.stringify(R.readPicks("all three", 3)) === "[1,2,3]" && R.readPicks("all three", 2) === null);
  check("picks: 'nobody' and 'none of them' are none", JSON.stringify(R.readPicks("nobody", 3)) === "[]" && JSON.stringify(R.readPicks("none of them", 3)) === "[]");
  const M = await import("../../src/services/matching.js");
  check("rsvp share: the nudge can only quote a picked ask", M.shareReasonFromOwnAsk(next, "S1").includes("sailing crew") && !M.shareableAsks(next).some((a: any) => a.text === "a pediatric dentist"));
}

// ------------------------------------------------------------ no end time: the end of that evening, local
{
  const e = (start: string, tz: string | null) => C.effectiveEnd({ start_at: start, end_at: null, timezone: tz });
  check("no end: a 7pm event in SF closes at midnight SF time", e("2026-11-05T19:00:00-08:00", "America/Los_Angeles") === "2026-11-06T08:00:00.000Z", e("2026-11-05T19:00:00-08:00", "America/Los_Angeles"));
  check("no end: a 7pm event in New York closes at midnight New York time", e("2026-11-05T19:00:00-05:00", "America/New_York") === "2026-11-06T05:00:00.000Z", e("2026-11-05T19:00:00-05:00", "America/New_York"));
  check("no end: a 10:30pm start still gets 3 hours", e("2026-11-05T22:30:00-08:00", "America/Los_Angeles") === "2026-11-06T09:30:00.000Z", e("2026-11-05T22:30:00-08:00", "America/Los_Angeles"));
  check("no end: a real end_at is kept as is", C.effectiveEnd({ start_at: "2026-11-05T19:00:00-08:00", end_at: "2026-11-05T21:00:00-08:00" }) === "2026-11-05T21:00:00-08:00");
  check("no end: the window is open that evening and closed the next day", C.checkEventWindow({ start_at: "2026-11-05T19:00:00-08:00", end_at: null, timezone: "America/Los_Angeles" }, new Date("2026-11-06T05:00:00Z")).pass && !C.checkEventWindow({ start_at: "2026-11-05T19:00:00-08:00", end_at: null, timezone: "America/Los_Angeles" }, new Date("2026-11-06T18:00:00Z")).pass);
}

// ------------------------------------------------------------ guest phone formats (Luma) -> stored E.164
{
  const { matchablePhone } = await import("../../src/utils/phone.js");
  for (const f of ["+1 (415) 555-0142", "415-555-0142", "(415) 555 0142", "1 415 555 0142", "415.555.0142", "+14155550142", "001 415 555 0142"]) check(`phone: "${f}" matches +14155550142`, matchablePhone(f) === "+14155550142", matchablePhone(f));
  check("phone: an international number keeps its own country code", matchablePhone("+44 20 7946 0958") === "+442079460958", matchablePhone("+44 20 7946 0958"));
  check("phone: junk is no number, never a guess", matchablePhone("ext 12") === null && matchablePhone("") === null);
}

// ------------------------------------------------------------ event windows
{
  const start = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const end = new Date(Date.now() + 3_600_000).toISOString();
  const t = { start_at: start, end_at: end };
  check("window: open mid-event", C.checkEventWindow(t, new Date()).pass);
  check("window: closed before start", !C.checkEventWindow(t, new Date(Date.parse(start) - 60_000)).pass);
  check("window: closed in the last 30 minutes", !C.checkEventWindow(t, new Date(Date.parse(end) - 29 * 60_000)).pass);
  // The unmatched pass is due at end - UNMATCHED_SEND_BEFORE_END_MINUTES and runs on a 15-minute cron: the LAST tick
  // that can pick it up is a full cron period after it's due, and it still has to be inside the window then.
  const U = await import("../../src/services/eventUnmatchedFollowUp.js");
  const sendAt = new Date(Date.parse(end) - U.UNMATCHED_SEND_BEFORE_END_MINUTES * 60_000);
  const firstCronTick = new Date(sendAt.getTime() + U.UNMATCHED_CRON_MINUTES * 60_000);
  finding("window: at (or after) the unmatched pass's send_at, checkEventWindow already refuses, so its pair nudges can't send", !C.checkEventWindow(t, firstCronTick).pass);
  check("window: absolute instants, so a time zone can't shift it", C.checkEventWindow({ start_at: "2026-11-01T01:00:00-07:00", end_at: "2026-11-01T04:00:00-08:00" }, new Date("2026-11-01T09:00:00Z")).pass);
  finding("window: no end_at means no end at all (open for days)", C.checkEventWindow({ start_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), end_at: null }, new Date()).pass);
  check("window: no timing on a 'requireTiming' check fails closed", !C.checkEventWindow(null, new Date(), { requireTiming: true }).pass);
  finding("window: the live nudge path calls checkEventWindow WITHOUT requireTiming, so missing timing falls to the no-timing (queued anonymous) branch", !C.checkEventWindow(null, new Date()).pass === false);
}

// ------------------------------------------------------------ walk-in check-in window and matching
{
  const ev = { start_at: new Date(Date.now() + 2 * 3_600_000).toISOString(), end_at: null };
  check("walk-in: opens 3h before the start", WK.isCheckinOpen(ev, new Date()));
  check("walk-in: not 4h before", !WK.isCheckinOpen({ start_at: new Date(Date.now() + 4 * 3_600_000).toISOString(), end_at: null }, new Date()));
}

// ------------------------------------------------------------ what memory carries across
{
  const additive = `Additive offer sent to Jordan at "Co Night": 2 new candidate(s) checked in since their last match (Noor, Sarah Hao)`;
  finding("memory: an additive-offer record (names never told to the member) survives memberSafe whole", MS.safeMemory("event_guest_match_nudge", additive, ["Ellis"]) === additive);
  const nudge = `Nudged Jordan that Ellis is also going to "Co Night" and worth meeting: what they've said they're looking for: "a growth stage startup to join" (score 88)`;
  check("memory: the nudge record carries only what the member was already told (name + shared ask)", MS.safeMemory("event_guest_match_nudge", nudge, ["Ellis"]) === nudge);
  finding("memory: the nudge record also carries the internal score ('score 88') into the member's reply context", /score 88/.test(MS.introFacts([{ memory_type: "event_guest_match_nudge", content: nudge }]).join(" ")));
  const recap = `Co replied: Ellis is building grid storage and left Tesla, worth a chat.`;
  check("memory: Co's own line about a linked member is cut to a history line", !/Tesla/.test(MS.safeMemory("text_exchange", recap, ["Ellis"]) ?? ""));
  {
    // Linked names come from linkedMemberNames: someone who was only in an additive offer must be linked too.
    const { W, reset, addMember } = await import("./world.js");
    reset();
    const jordan = addMember({ first_name: "Jordan" });
    const noor = addMember({ first_name: "Noor" });
    W.offers.push({ event_id: "evt-x", person_id: jordan.id, candidate_key: "additive", kind: "additive", candidate_id: null, candidate_ids: [noor.id], status: "open", opened_at: new Date(), created_at: new Date() });
    const linked = await MS.linkedMemberNames(jordan.id);
    finding("memory: but a member who was only in an ADDITIVE offer is not 'linked' (no nudge row), so Co's own lines about them are not cut", /Tesla/.test(MS.safeMemory("text_exchange", `Co replied: Noor left Tesla.`, linked) ?? ""), linked);
  }
}

// ------------------------------------------------------------ brief naming with stale rankings
{
  const members = [{ user_id: "a", first_name: "Jordan" }, { user_id: "b", first_name: "Ellis" }];
  // Ellis's ask closed after the ranking was stored; the stored shareReason still carries it.
  const ranked = [{ candidate_id: "b", score: 80, reason: "", shareReason: `what they've said they're looking for: "a buyer for my company"`, mutual: false, method: "ask" as const }];
  // As the brief calls it: with each guest's asks that are shareable NOW (Ellis's ask closed, so none).
  const r = B.pickNamed({ ranked, recipientId: "a", members, nameOk: new Set(["b"]), notGoing: new Set(), stillShareable: new Map([["b", []]]) });
  finding("brief: a stored ranking's shareReason is reused as-is; an ask Ellis has since closed ('a buyer for my company') can still be named in the brief", r.picks[0]?.reason.includes("a buyer for my company"));
  check("brief: no name without the RSVP yes", B.pickNamed({ ranked, recipientId: "a", members, nameOk: new Set(), notGoing: new Set() }).picks.length === 0);
  check("brief: a shared first name is never named", B.pickNamed({ ranked, recipientId: "a", members: [...members, { user_id: "c", first_name: "Ellis" }], nameOk: new Set(["b"]), notGoing: new Set() }).picks.length === 0);
  check("brief: a name with an accent is still caught as an outsider", B.namesOutsiders("Find Zoë tonight", [{ user_id: "z", first_name: "Zoë" }], new Set(), "a") === "Zoë");
  finding("brief: a 1-letter or initial-only first name ('J') is never caught as an outsider", B.namesOutsiders("Find J. by the bar", [{ user_id: "j", first_name: "J" }], new Set(), "a") === null);
}

// ------------------------------------------------------------ pre-arrival never names
check("pre-arrival: catches a guest's name", PA.namesAnyone("Noor will be there", ["Noor"]) === "Noor");
finding("pre-arrival: names under 3 letters ('Al', 'Bo', 'Jo') are never checked", PA.namesAnyone("Look for Jo by the door", ["Jo"]) === null);

// ------------------------------------------------------------ consent checks on nudge wording
const facts = { otherFirstName: "Ellis", otherOptedIn: false, recipientOptedIn: false, recipientFirstName: "Jordan", otherStatedAsks: ["a growth stage startup to join"] };
check("consent: 'Ellis wants to meet you' blocked", !C.checkInterestClaim("Ellis wants to meet you tonight.", facts).pass);
check("consent: 'Ellis mentioned you' blocked", !C.checkInterestClaim("Ellis mentioned you earlier.", facts).pass);
check("consent: Co's own suggestion passes", C.checkInterestClaim("Ellis is here and is looking for a growth stage startup to join, worth a hello.", facts).pass);
check("consent: contact details blocked before both yes", !C.checkContactDetails("Text Ellis at 415-555-0123", { ...facts, otherPhone: "+14155550123" }).pass);
finding("consent: 'Ellis is dying to talk to you' is not caught by the pattern check (left to the model read)", C.checkInterestClaim("Ellis is dying to talk to you.", facts).pass);

console.log(`\nin-room rules: ${results.total - results.failed}/${results.total} passed (${results.findings.length} open findings, ${results.failed - results.findings.length} other failures)`);
process.exit(results.failed ? 1 : 0);
