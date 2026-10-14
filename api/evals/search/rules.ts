// Model-free checks for the search/matching pure pieces (code review,
// 2026-09-17). No API calls, no database: npx tsx evals/search/rules.ts
//
// Covers: local-today gating (matchGate.ts checkTiming), out-of-range time
// frames (askWindow.ts resolveAskWindow), Tier 3 posts with past stated
// dates (matchGate.ts checkTiming), search cache key differences
// (searchRules.ts searchCacheKey), and online Co event handling
// (luma.ts resolveCoEventPlace).
import "../testEnv.js";
import { DateTime } from "luxon";
import { readFileSync } from "fs";
import { checkTiming, checkLocation, type MatchFacts } from "../../src/harness/matchGate.js";
import type { TierMatch } from "../../src/services/tieredRecommendation.js";
import { carryTimeFrame, mentionsUnknownDay, resolveAskWindow } from "../../src/services/askWindow.js";
import { alreadySentNames, eventLookupFromModel, isTicketingHost, namedEventFromModel, searchCacheKey, triesInOrder, xSearchBudget } from "../../src/services/searchRules.js";
import { profileForSearch } from "../../src/harness/personSnapshot.js";
import { resolveCoEventPlace } from "../../src/services/luma.js";
import { localToday, searchZone } from "../../src/services/eventOrder.js";
import { interleaveByTier, tierAlreadyCovered } from "../../src/services/eventSurfacingSweep.js";
import { spelledNumbers } from "../../src/harness/matchGate.js";
import { htmlToText, looksOfficial, pageExcerpt } from "../../src/services/webOpportunitySearch.js";
import { availabilityConflict, availabilityWindows } from "../../src/services/availability.js";

const cases: [boolean, string][] = [];
const c = (ok: boolean, label: string) => cases.push([ok, label]);

// ---------------------------------------------------------------------------
// local-today gating (checkTiming)
// "now" is 2026-09-17T02:30:00Z, which is already 2026-09-16 19:30 Pacific
// (evening) but still 2026-09-17 in UTC.
const evening = new Date("2026-09-17T02:30:00Z");
const baseFacts: Omit<MatchFacts, "now"> = { searchCity: null, distanceMiles: null, alreadyOffered: false };

const sameEveningEvent: TierMatch = {
  tier: 1,
  kind: "co_event",
  event_api_id: "e1",
  event_date: "2026-09-16",
  name: "Same evening event",
  reason: "test",
};
c(
  checkTiming(sameEveningEvent, { ...baseFacts, now: evening, zone: "America/Los_Angeles" }).pass,
  "a same-evening event isn't rejected as already happened when checked in the person's own zone",
);
c(
  checkTiming(sameEveningEvent, { ...baseFacts, now: evening, zone: null }).pass,
  "without a zone, today is the fallback zone's (Pacific, the 16th), not UTC's (the 17th): the same-evening event isn't rejected (2026-10-07)",
);

// askedUntil in the person's zone too.
const justInsideAskedUntil: TierMatch = { ...sameEveningEvent, event_api_id: "e2", event_date: "2026-09-16" };
c(
  checkTiming(justInsideAskedUntil, { ...baseFacts, now: evening, zone: "America/Los_Angeles", askedUntil: "2026-09-16" }).pass,
  "askedUntil comparison also uses the person's local today, not UTC",
);

// ---------------------------------------------------------------------------
// Tier 3: post's own stated dates in the past reject even with no deadline,
// or a deadline still ahead.
const pastStatedDates: TierMatch = {
  tier: 3,
  kind: "opportunity",
  name: "Demo Day",
  url: "https://x.com/i/status/123",
  reason: "test",
  statedDates: { start: "2026-09-10", end: "2026-09-10" },
};
c(
  !checkTiming(pastStatedDates, { ...baseFacts, now: evening, zone: "America/Los_Angeles" }).pass,
  "a Tier 3 post whose own statedDates are in the past is rejected even with no deadline",
);

const futureDeadlinePastEvent: TierMatch = {
  ...pastStatedDates,
  name: "Demo Day 2",
  deadline: "2026-12-01",
};
c(
  !checkTiming(futureDeadlinePastEvent, { ...baseFacts, now: evening, zone: "America/Los_Angeles" }).pass,
  "a past statedDates.end rejects the post even when its own deadline is still ahead (the event already happened)",
);

const futureStatedDates: TierMatch = {
  ...pastStatedDates,
  name: "Upcoming Cohort",
  statedDates: { start: "2026-12-01", end: "2026-12-05" },
};
c(
  checkTiming(futureStatedDates, { ...baseFacts, now: evening, zone: "America/Los_Angeles" }).pass,
  "a Tier 3 post with statedDates still ahead passes",
);

// ---------------------------------------------------------------------------
// Online Co event handling: no city, skip the radius filter, no "in X" claim.
const onlineMatch: TierMatch = {
  tier: 1,
  kind: "co_event",
  event_api_id: "e3",
  event_date: "2026-09-20",
  name: "Online Founder AMA",
  reason: "Matches a Cue event happening Sunday, September 20, online.",
  online: true,
  city: null,
};
c(
  checkLocation(onlineMatch, { ...baseFacts, now: evening, searchCity: "Fargo, ND" }).pass,
  "an online Cue event passes the location check for a searcher anywhere, with no radius filter",
);

const p1 = resolveCoEventPlace(null, { online: true, city: null }, "San Francisco");
c(p1.online === true && p1.city === null, "resolveCoEventPlace: an online event has no city and isn't described as being anywhere");

const p2 = resolveCoEventPlace(null, null, "San Francisco", true);
c(p2.source === "unresolved" && p2.city === null, "resolveCoEventPlace: a failed/timed-out page fetch is left unresolved, not defaulted to the home city");

const p3 = resolveCoEventPlace(null, null, "San Francisco", false);
c(p3.source === "home_city" && p3.city === "San Francisco", "resolveCoEventPlace: no url to fetch at all (genuinely no address info) does use the home city");

const p4 = resolveCoEventPlace(null, { city: "Austin", online: false }, "San Francisco");
c(p4.city === "Austin" && p4.source === "event_page", "resolveCoEventPlace: a successfully read page's own city wins over the home city");

// ---------------------------------------------------------------------------
// Out-of-range time frames: return outOfRange, not silently no-window.
const now917 = DateTime.fromISO("2026-09-17T18:00:00", { zone: "America/Los_Angeles" });
const r1 = resolveAskWindow("anything Jan 20?", now917);
c(r1.window === null, "a date beyond the 90-day limit resolves to no window");
c(r1.outOfRange !== null && r1.outOfRange.label.includes("Jan"), "...and is reported as out of range, not silently absent");

const r2 = resolveAskWindow("find me climate founders", now917);
c(r2.window === null && r2.outOfRange === null, "no time frame at all is still just 'no window', not out of range");

const r3 = resolveAskWindow("anything this weekend?", now917);
c(r3.window !== null && r3.outOfRange === null, "a normal near-term window is unaffected");

// A past date that rolls into next year beyond 90 days is also out of range,
// not silently dropped (2026-09-17: "anything sept 3" from a September 2026
// vantage point would roll to Sept 2027, which is way past 90 days).
const r4 = resolveAskWindow("anything sept 3", now917);
c(r4.window === null && r4.outOfRange !== null, "a past date rolled to next year beyond 90 days is reported out of range");

// ---------------------------------------------------------------------------
// searchCacheKey: differences that must produce different keys.
const base = { userId: "member-a", city: "San Francisco", askText: "founder meetups", windowStart: null, windowEnd: null, today: "2026-09-17", zone: "America/Los_Angeles", browse: false, profile: "profile text" };
c(
  searchCacheKey(base) !== searchCacheKey({ ...base, today: "2026-09-18" }),
  "same window label but a different 'today' (no named window) produces a different cache key",
);
c(
  searchCacheKey(base) !== searchCacheKey({ ...base, zone: "America/New_York" }),
  "a different time zone produces a different cache key",
);
c(
  searchCacheKey(base) !== searchCacheKey({ ...base, browse: true }),
  "browse vs. non-browse produces a different cache key",
);
c(
  searchCacheKey(base) !== searchCacheKey({ ...base, profile: "a completely different profile, same length" }),
  "two different profile texts of the same length produce different cache keys (a real hash, not length + 40 chars)",
);
c(
  searchCacheKey(base) === searchCacheKey({ ...base }),
  "identical inputs produce the same cache key",
);
c(
  searchCacheKey(base) !== searchCacheKey({ ...base, userId: "member-b" }),
  "two members with the same city, ask and profile never share a cached search (2026-09-22: the trace carries one person's own history)",
);
c(
  searchCacheKey({ ...base, profile: null }) !== searchCacheKey({ ...base, userId: "member-b", profile: null }),
  "two members with no profile at all never share a cached search either",
);
c(
  searchCacheKey({ ...base, windowStart: "2026-09-19", windowEnd: "2026-09-20" }) !==
    searchCacheKey({ ...base, windowStart: "2026-09-26", windowEnd: "2026-09-27" }),
  "a resolved window (two different weekends) produces different cache keys even if both would carry the same label",
);

// ---------------------------------------------------------------------------
// X search budget: sweep reserve, fail-closed shape (the DB-touching atomic
// reservation itself is exercised live; this checks the pure decision rule).
c(xSearchBudget(0, "request", 100, 30).ok, "well under budget: a direct ask is allowed");
c(xSearchBudget(0, "sweep", 100, 30).ok, "well under budget: the sweep is allowed");
c(!xSearchBudget(100, "request", 100, 30).ok, "daily cap reached: even a direct ask is blocked");
c(!xSearchBudget(71, "sweep", 100, 30).ok, "the sweep is blocked once only the reserved 30 remain for direct asks");
c(xSearchBudget(71, "request", 100, 30).ok, "a direct ask can still use the reserved slots the sweep can't");
c(xSearchBudget(99, "request", 100, 30).ok, "a direct ask can use the very last slot");

// ---------------------------------------------------------------------------
// localToday / searchZone fallback: no zone known defaults to Co's home zone,
// not the server's (UTC on Railway), and says so.
const z1 = searchZone(null);
c(z1.zone === "America/Los_Angeles" && z1.defaulted === true, "no timezone on file falls back to Cue's home zone, not server/UTC, and records the default");
const z2 = searchZone("America/New_York");
c(z2.zone === "America/New_York" && z2.defaulted === false, "a real timezone is used as-is, not defaulted");
c(localToday(evening, null) === "2026-09-16", "localToday with no zone falls back to the Pacific date, never the server's UTC one (2026-10-07)");
c(localToday(evening, "America/Los_Angeles") === "2026-09-16", "localToday in a real zone is that zone's calendar date");

// ---------------------------------------------------------------------------
// Tier 3 web results (2026-09-18): official-page detection, the drafting
// excerpt, and amounts a page spells out in words.
c(!looksOfficial("https://zyner.io/blog/yc-application-deadline", "Y Combinator Winter 2027 Batch"), "a blog about YC isn't YC's own page");
c(looksOfficial("https://www.ycombinator.com/apply", "Y Combinator Winter 2027 Batch"), "ycombinator.com is YC's own page");
c(!looksOfficial("https://www.vcsheet.com/fund/precursor-ventures", "Precursor Ventures"), "a VC directory isn't the fund's own page");
c(looksOfficial("https://precursorvc.com/", "Precursor Ventures"), "precursorvc.com is Precursor's own page");
c(looksOfficial("https://www.sf.gov/departments", "SF Community Challenge Grants"), "a .gov page counts as official");
c(looksOfficial("https://millercenterglobal.org/accelerator/", "Miller Center Accelerator"), "a distinctive name word in the domain counts");
c(!looksOfficial("https://techcrunch.com/2026/09/techstars", "Techstars Anywhere"), "a news story about a program isn't its page");
c(!looksOfficial("not a url", "Anything"), "a bad url is never official");
c(looksOfficial("https://www.leossf.com/", "Leo's Oyster Bar") && looksOfficial("https://narisf.com/", "Nari"), "a place's domain with its city added (leossf.com) is its own page");
c(!looksOfficial("https://www.bestsf.com/leos", "Leo's Oyster Bar") && !looksOfficial("https://www.eatsf.com/", "Nari"), "a city-suffixed guide whose rest isn't the name's start isn't official");
const longPage = "Intro. ".repeat(200) + "Past grantees. ".repeat(600) + "Want a $1000 grant? Our microgrants of $1,000 are given monthly.";
const ex = pageExcerpt(longPage, { name: "Awesome Foundation SF", reason: "No-strings $1,000 microgrants every month.", deadline: null });
c(ex.includes("$1000 grant") && ex.length <= 2500, "the drafting excerpt keeps the amount from deep in a long page, and stays short");
c(pageExcerpt("Short page, $500.", { name: "X", reason: "$500", deadline: null }) === "Short page, $500.", "a short page is used whole");
const nextPage = `<html><body><h1>FAST</h1><script id="__NEXT_DATA__" type="application/json">{"props":{"rule":"Founder chooses $500K - $2M SAFE investment","id":"a1b2c3d4e5f6g7h8","src":"https://cdn.example.com/app.js"}}</script><script>function x(){return "var a = 1; b();"}</script></body></html>`;
const nextText = htmlToText(nextPage);
c(nextText.includes("$500K - $2M SAFE"), "text a page keeps in its script data is read");
c(!nextText.includes("cdn.example.com") && !nextText.includes("var a = 1"), "code, links, and ids in scripts are left out");
c(JSON.stringify(spelledNumbers("grants from zero to nineteen thousand dollars")) === "[0,19000]", "spelled-out amounts become digits");
c(spelledNumbers("two hundred fifty thousand")[0] === 250000, "hundreds and thousands combine");
c(spelledNumbers("one hundred and twenty-five")[0] === 125, "'and' and hyphens inside a number are fine");

// A late search answer tries each tier's best before the rest (2026-09-18).
const lateOrder = triesInOrder([{ tier: 2, n: "a" }, { tier: 2, n: "b" }, { tier: 2, n: "c" }, { tier: 2, n: "d" }, { tier: 3, n: "grant" }]).map((m) => m.n);
c(lateOrder.join(",") === "a,grant,b,c,d", "a late answer tries the Tier 3 grant second, not never");
c(triesInOrder([{ tier: 1 }, { tier: 2 }, { tier: 2 }, { tier: 2 }, { tier: 2 }, { tier: 2 }]).length === 5, "a late answer tries at most five");

// The search hears who they are, never their other asks or what's on their
// mind (2026-09-18: a hiring question searched funding because the profile
// listed their funding asks).
const searchProfile = profileForSearch({ asOf: "2026-09-18T19:53", work: "Founder of Cue, pre-seed", place: "San Francisco", worked: [], wantsNow: ["Find pre-seed VCs in SF", "Find grants for a founder event"], didntWork: [], weighingOn: ["stressed about fundraising"], valuesInPeople: ["laid-back founders"] } as any);
c(searchProfile.includes("Founder of Cue") && searchProfile.includes("laid-back founders"), "the search profile keeps who they are");
c(!/VCs|grants|fundraising/.test(searchProfile), "the search profile leaves out their other asks and what's on their mind");

// A what's-on follow-up keeps the time frame they just asked about (2026-09-18:
// "What's the vibes for Sunday?" then "Anything happening?" got Wed/Oct events).
const sat = DateTime.fromISO("2026-09-18T15:38:00", { zone: "America/Los_Angeles" });
const carried = carryTimeFrame("Anything happening?", "What’s the vibes for Sunday?", sat);
c(resolveAskWindow(carried, sat).window?.start.toISODate() === "2026-09-20", "'Anything happening?' after 'vibes for Sunday?' searches Sunday");
c(carryTimeFrame("Any leads on any design engineer positions?", "What’s the vibes for Sunday?", sat) === "Any leads on any design engineer positions?", "a question with its own subject doesn't inherit the time frame");
c(resolveAskWindow(carryTimeFrame("Anything happening tomorrow?", "What’s the vibes for Sunday?", sat), sat).window?.start.toISODate() === "2026-09-19", "its own time frame wins over the earlier one");
c(carryTimeFrame("Anything happening?", "Thanks 🙏🏾", sat) === "Anything happening?", "no time frame earlier, nothing carried");
c(carryTimeFrame("Anything happening?", null, sat) === "Anything happening?", "no earlier message, nothing carried");

// ---------------------------------------------------------------------------
let failed = 0;
for (const [ok, label] of cases) {
  if (!ok) {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}
// Every tier gets its turn (2026-09-21): the sweep queues one offer per run and
// the search lists Tier 1, then 2, then 3, so Tier 2 kept taking the slot.
{
  const it = (tier: number, n: number) => ({ match: { tier }, id: `t${tier}-${n}` });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(",");
  const items = [it(2, 1), it(2, 2), it(2, 3), it(3, 1), it(3, 2), it(1, 1)];
  c(ids(interleaveByTier(items, null)) === "t2-1,t3-1,t1-1,t2-2,t3-2,t2-3", "with no history, tiers alternate starting from the first one listed");
  c(ids(interleaveByTier(items, 2)).startsWith("t3-1,t1-1,t2-1"), "after a Tier 2 offer, Tier 3 goes next");
  c(ids(interleaveByTier(items, 3)).startsWith("t1-1,t2-1,t3-1"), "after a Tier 3 offer, the next tier in the rotation goes");
  c(ids(interleaveByTier(items, 9)) === ids(interleaveByTier(items, null)), "a last tier with nothing waiting changes nothing");
  c(interleaveByTier(items, 2).length === items.length && new Set(interleaveByTier(items, 2).map((x) => x.id)).size === items.length, "nothing is dropped or duplicated");
  c((() => { const o = interleaveByTier(items, null).filter((x) => x.match.tier === 2).map((x) => x.id); return o.join(",") === "t2-1,t2-2,t2-3"; })(), "order inside a tier is kept");
  c(interleaveByTier([], 2).length === 0, "an empty list stays empty");
  c(ids(interleaveByTier([it(2, 1), it(2, 2)], 2)) === "t2-1,t2-2", "one tier only keeps its order");
  c(ids(interleaveByTier(items, null, [2])).startsWith("t3-1,t1-1,t2-1"), "a tier with an offer already waiting goes last");
  c(ids(interleaveByTier(items, null, [1, 2, 3])) === ids(interleaveByTier(items, null)), "every tier waiting changes nothing");
  const full = (tier: number) => ({ match: { tier }, source: "full" });
  c(!tierAlreadyCovered(full(3), new Set([2]), false), "a tier with nothing waiting queues its offer (a missing tier holds nothing back)");
  c(tierAlreadyCovered(full(2), new Set([2]), false), "a tier that already has an offer waiting does not stack a second");
  c(!tierAlreadyCovered({ match: { tier: 2 }, source: "urgent" }, new Set([2]), false), "an urgent item queues even when its tier is covered");
  c(!tierAlreadyCovered(full(2), new Set([2]), true), "a short-notice item queues even when its tier is covered");
  c(!tierAlreadyCovered({ match: { tier: 2 }, source: "full", reminder: true }, new Set([2]), false), "a reminder queues even when its tier is covered");
}

// A day of the month with no month (2026-09-21): "What about Saturday on the 10th?",
// asked on Saturday Sept 19, was read as Saturday Sept 19, and the follow-up asked
// how a Saturday three weeks away had gone.
{
  const sat919 = DateTime.fromISO("2026-09-19T10:00:00", { zone: "America/Los_Angeles" });
  const win = (text: string, now = sat919) => resolveAskWindow(text, now).window;
  const day = (w: ReturnType<typeof win>) => w?.start.toFormat("yyyy-LL-dd");
  c(day(win("What about Saturday on the 10th?")) === "2026-10-10", "'Saturday on the 10th' is Saturday Oct 10, not the coming Saturday");
  c(day(win("anything for the 10th?")) === "2026-10-10", "'for the 10th' is the next 10th");
  c(day(win("Saturday the 26th")) === "2026-09-26", "'Saturday the 26th' is Sept 26");
  c(day(win("anything on the 21st?")) === "2026-09-21", "a day later this month resolves in this month");
  c(day(win("what's on before October 10th?")) === "2026-10-10", "a month and day still resolve as before");
  c(win("this is the 1st startup I have built") === null, "'the 1st startup' is not a date");
  c(win("my 3rd time hosting an event") === null, "'my 3rd time' is not a date");
  c(day(win("what about saturday?")) === "2026-09-19", "a bare weekday still means the coming one");
  c(mentionsUnknownDay("Saturday the 10th, the day you asked. How'd it go?", "saturday (Saturday, September 19)") === true, "a follow-up naming the 10th for a Sept 19 window is caught");
  c(mentionsUnknownDay("Saturday the 19th, the day you asked. How'd it go?", "saturday (Saturday, September 19)") === false, "a follow-up naming the real day is fine");
  c(mentionsUnknownDay("How'd your weekend go?", "this weekend") === false, "no day number is fine");
}

// "The week of Oct 5th" is seven days, not Oct 5 alone (2026-09-21: a fit event on Oct 7 was never
// looked at because the window was one day).
{
  const mon = DateTime.fromISO("2026-09-21T17:00:00", { zone: "America/Los_Angeles" });
  const win = (text: string) => resolveAskWindow(text, mon).window;
  const span = (w: ReturnType<typeof win>) => (w ? `${w.start.toFormat("yyyy-LL-dd")}..${w.end.toFormat("yyyy-LL-dd")}` : null);
  c(span(win("Find me a founder or AI event in SF the week of Oct 5th")) === "2026-10-05..2026-10-11", "'the week of Oct 5th' is Oct 5 to Oct 11");
  c(span(win("anything the week of the 28th?")) === "2026-09-28..2026-10-04", "'the week of the 28th' is seven days from the 28th");
  c(span(win("events week starting October 12")) === "2026-10-12..2026-10-18", "'week starting October 12' is seven days");
  c(span(win("the week of Oct 5 - Oct 9")) === "2026-10-05..2026-10-09", "a typed range keeps its own end");
  c(span(win("what's on Oct 5?")) === "2026-10-05..2026-10-05", "a single date with no 'week' is still one day");
  c(span(win("next week")) === "2026-09-28..2026-10-04", "'next week' is unchanged");
  c(span(win("I had a great week of meetings")) === null, "'week of meetings' is not a date");
  c(win("the week of Oct 5th")?.label === "week of Oct 5", "the label says it is a week");
}

// (2026-10-01) The pipeline that searched before the reply is gone; Co searches in its own loop, capped per turn (evals/loop/rules.ts).

// "A companion you can ask 'what are you working on for me' is more trustworthy than one
// that only surfaces results when it feels like it" (Royce, 2026-09-22) — listOpenAsks
// answers from the real stated-ask list, never a guess reconstructed from the conversation.
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  c(/listOpenAsks: tool\(\{/.test(tools), "the listOpenAsks tool exists");
  c(/Never guess or reconstruct this from the conversation alone/.test(tools), "the tool's own description forbids guessing from conversation memory");
  c(/SELECT intent, avoid FROM co_profiles WHERE user_id = \$1/.test(tools), "it reads the real stated-ask list, not a summary");
  c(/askEntries\(rows\[0\]\?\.intent/.test(tools), "it reuses the same askEntries parsing the search/profile pipeline already uses");
  c(/the real complete list\. \$\{parts\.join\(" "\)\} Never add, drop, or invent anything beyond this\./.test(tools), "the grounded fact it hands the reply agent is explicit that this is the complete, real list");
  // 2026-09-22 code review: an offer isn't something Co looks for on their behalf,
  // and dates were in the server's zone.
  c(/What they've offered to others, which Cue matches to people who want it/.test(tools), "offering asks are described as offers, not as things Cue is looking for");
  c(!/toDateString\(\)/.test(tools), "no date is formatted in the server's time zone");
  c(/d\.isValid \? d\.setZone\(zone\)/.test(tools), "dates are shown in the member's own zone, and an unreadable date is dropped instead of printing Invalid Date");
}

// "What did you send me" reads what was actually sent (2026-09-22), not the last 20 texts.
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  c(/listSentOffers: tool\(\{/.test(tools), "the listSentOffers tool exists");
  c(/FROM revealed_offers\s+WHERE user_id = \$1/.test(tools), "it reads revealed_offers, the record both live replies and sweeps write");
  c(/Never reconstruct it from the conversation alone/.test(tools), "its description forbids reconstructing the list from the conversation");
  const sweep = readFileSync(new URL("../../src/services/eventSurfacingSweep.ts", import.meta.url), "utf8");
  const rec = readFileSync(new URL("../../src/services/recommendation.ts", import.meta.url), "utf8");
  c(/recordRevealedOffers\(/.test(sweep) && /recordRevealedOffers\(/.test(rec), "both send paths (sweep and live reply) record into revealed_offers, so the list is complete");
}

// "No more hackathons" is kept as a lasting filter (2026-09-22), enforced in code.
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  c(/steerAwayFrom: tool\(\{/.test(tools), "the steerAwayFrom tool exists");
  c(/UPDATE co_profiles SET avoid = \$2 WHERE user_id = \$1/.test(tools), "it stores the kind on the member's own profile");
  c(/undo \? current\.filter/.test(tools), "it can be undone when they're open to that kind again");
  const details = readFileSync(new URL("../../src/services/eventDetails.ts", import.meta.url), "utf8");
  c(/if \(p\.avoided === true && person\.avoid\?\.length\) return \{ fits: false, rightKind: false/.test(details), "a ruled-out kind never fits and can never go out as a closest-thing stretch, and 'avoided' only counts when something was actually ruled out");
  c(/avoidList\.length \? ' "avoided": true or false,' : ""/.test(details), "the avoided field is only asked for when there's something ruled out (it caused false rejections when always present)");
  c(/const prefs = await loadFitPreferences\(person\.userId\)/.test(details), "every fit check loads the member's ruled-out kinds and availability itself");
  c(/They told Cue to stop suggesting these kinds of things/.test(details), "the fit prompt carries the ruled-out kinds");
  c(/When they've said they're usually free/.test(details), "the fit prompt carries their availability");
}

// When the good matches were already sent, say that (2026-09-21), not "nothing came up".
{
  const g = (name: string, ...reasons: string[]) => ({ name, reasons });
  c(alreadySentNames([g("A", "already offered to this person"), g("B", "too far away")]).join() === "A", "an already-offered match is named");
  c(alreadySentNames([g("A", "too far away"), g("B", "sold out")]).length === 0, "matches dropped for other reasons are not called already sent");
  c(alreadySentNames([g("A", "already offered to this person"), g("A", "already offered to this person")]).length === 1, "a name is listed once");
  c(alreadySentNames([g("A", "already offered to this person"), g("B", "already offered to this person"), g("C", "already offered to this person"), g("D", "already offered to this person")]).length === 3, "at most three names");
  c(alreadySentNames(null).length === 0 && alreadySentNames(undefined).length === 0, "no list means no names");
}

// The description prompt carries the dates they asked about, so an in-window event is never
// called "outside your window" (2026-09-21: Sep 30 inside "next week", Sep 28 to Oct 4).
{
  const sb = readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  c(/const dateRule = dateCaveatRule\(askedDates\)/.test(sb), "the description draft builds a date rule from the asked dates");
  c(/\$\{dateRule\}\\nWrite \$\{matchCount/.test(sb), "the date rule is inside the description prompt");
  c(sb.includes("if it falls inside, say nothing about their dates being off"), "the rule forbids calling an in-window event outside the dates");
  c(/function dateCaveatRule\(askedDates: string \| null\): string \{\s*if \(!askedDates\) return ""/.test(sb), "no dates means no date rule");
}

// One live web lookup for an ask that names one event (2026-09-21: "What's happening at Afro tech?"
// found nothing because live replies never search the web). Triggers only once nothing survived
// the real per-candidate fit check (2026-09-21, second pass): tier 2's own coarse relevance gate
// let 8 unrelated SF Tech Week events through for that same AfroTech ask, so a trigger keyed on
// "the raw search found nothing" never fired at all.
{
  const ask = "What’s happening at Afro tech this year?";
  c(namedEventFromModel({ name: "AfroTech" }, ask) === "AfroTech", "a name spelled differently in the ask (Afro tech / AfroTech) still counts");
  c(namedEventFromModel({ name: "Figma Config" }, "What about figcon this year?") === null, "a name that isn't in their message is refused");
  c(namedEventFromModel({ name: "SF Tech Week" }, "Anything else?") === null, "a name from earlier in the chat can't be swapped in");
  c(namedEventFromModel({ name: "Figcon" }, "What about figcon this year?") === "Figcon", "the name as they wrote it is kept");
  c(namedEventFromModel({ name: "events" }, "any events this weekend?") === null, "a generic word is not a named event");
  c(namedEventFromModel({ name: null }, ask) === null && namedEventFromModel(null, ask) === null, "no name means no lookup");
  c(namedEventFromModel({ name: "x".repeat(80) }, "x".repeat(80)) === null, "an overlong name is refused");
  const good = { found: true, name: "AfroTech", url: "https://afrotech.com/conference", reason: "A tech conference for Black professionals in Houston.", start: "2026-11-04", end: "2026-11-07" };
  c(eventLookupFromModel(good)?.start === "2026-11-04", "a good lookup keeps its dates");
  c(eventLookupFromModel({ ...good, start: "next November" })?.start === null, "a badly formed date is dropped, not kept");
  c(eventLookupFromModel({ ...good, url: "http://afrotech.com" }) === null, "a non-https page is refused");
  c(eventLookupFromModel({ found: false }) === null, "found:false is nothing");
  c(eventLookupFromModel({ ...good, reason: " " }) === null, "no reason is nothing");
  c(isTicketingHost("https://lu.ma/figma-config") && isTicketingHost("https://www.eventbrite.com/e/123"), "a ticketing page counts");
  c(!isTicketingHost("https://someblog.com/afrotech-guide") && !isTicketingHost("not a url"), "a blog or a bad url doesn't");
  const tr = readFileSync(new URL("../../src/services/tieredRecommendation.ts", import.meta.url), "utf8");
  c(!tr.includes("lookupNamedEvent"), "the raw tiered search no longer triggers the lookup itself — it fires too early, before the real fit check");
  const sb = readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  c(/if \(!prepared\.length\) \{\s*const scopeCity/.test(sb), "the lookup runs in the live reply, gated on nothing having survived the real fit check");
  c(/source: "request",\s*\}\)\.catch/.test(sb), "it always passes source: request, never sweep");
  const nel = readFileSync(new URL("../../src/services/namedEventLookup.ts", import.meta.url), "utf8");
  c(/reserveWebSearch\(opts\.userId, opts\.source/.test(nel), "the lookup spends the web search budget");
  c(/checkGrounding\(match/.test(nel) && /looksOfficial\(found\.url/.test(nel), "the lookup checks the page and that it is the event's own");
}

// When they're usually free, checked in code (2026-09-22: the fit model called a Saturday fine
// for "weeknights only" 9 of 9 times). Oct 3 2026 is a Saturday, Oct 6 a Tuesday.
{
  const LA = "America/Los_Angeles";
  const sat11 = "2026-10-03T11:00:00-07:00", sat19 = "2026-10-03T19:00:00-07:00";
  const tue1830 = "2026-10-06T18:30:00-07:00", wedNoon = "2026-10-07T12:00:00-07:00", tue8 = "2026-10-06T08:00:00-07:00";
  const conflict = (a: string, t: string) => availabilityConflict(a, t, LA) !== null;
  c(conflict("weeknights only", sat11) && conflict("weeknights only", sat19), "a Saturday is outside 'weeknights only', morning or night");
  c(!conflict("weeknights only", tue1830), "a Tuesday evening is inside 'weeknights only'");
  c(conflict("weeknights only", wedNoon), "a weekday noon is outside 'weeknights'");
  c(conflict("evenings", wedNoon) && !conflict("evenings", tue1830) && !conflict("evenings", sat19), "'evenings' is any day after 5pm");
  c(!conflict("weekday evenings", tue1830) && conflict("weekday evenings", sat19) && conflict("weekday evenings", wedNoon), "'weekday evenings' needs both a weekday and the evening");
  c(conflict("no weekends", sat11) && !conflict("no weekends", wedNoon), "'no weekends' rules out Saturday and allows a weekday");
  c(!conflict("weeknights and weekends", sat11) && !conflict("weeknights and weekends", tue1830) && conflict("weeknights and weekends", wedNoon), "two phrases allow either window");
  c(!conflict("mornings", tue8) && conflict("mornings", tue1830), "'mornings' is before noon");
  c(availabilityWindows("whenever works honestly") === null && !conflict("whenever works honestly", sat11), "an unrecognized phrase is no constraint at all");
  c(availabilityConflict(null, sat11, LA) === null && availabilityConflict("weeknights only", null, LA) === null, "no availability or no start time means no conflict");
  c(availabilityConflict("weeknights only", sat11, LA)?.includes("Saturday at 11:00 AM") === true, "the reason names the real day and time in the event's own zone");
}

// Sourcing beyond Luma (2026-09-22): the web search also looks for real events on any site, with
// the event's own date carried so past and out-of-window ones are turned away.
{
  const web = readFileSync(new URL("../../src/services/webOpportunitySearch.ts", import.meta.url), "utf8");
  c(/Eventbrite, Meetup, Partiful, or a venue's, community's or organizer's own page/.test(web), "the web search looks for events on non-Luma sites");
  c(/don't assume the right room is a tech one/.test(web), "it's told not to assume a tech room for a non-tech ask");
  c(/\.\.\.\(eventDate \? \{ statedDates: \{ start: eventDate, end: null \} \} : \{\}\)/.test(web), "an event's own date becomes statedDates, so the gate and window checks apply");
  c(/"date": "YYYY-MM-DD" or null/.test(web), "the model is asked for the event's date");
  const nel = readFileSync(new URL("../../src/services/namedEventLookup.ts", import.meta.url), "utf8");
  c(/prefer the upcoming edition in or nearest/.test(nel), "a named event prefers the edition nearest the member");
  c(/If the only upcoming edition is somewhere else, still return it, and say plainly in "reason" where it is/.test(nel), "an edition elsewhere is still returned, labeled with where it is");
}

// Several places in one ask (2026-09-27: "this weekend in Sacramento or SF"
// became an SF-only search). In Co's own loop (2026-10-01) each event search
// names its city, so Co searches each place it was asked about.
c(/city: z\.string\(\)\.optional\(\)\.describe\("The city, when they named one/.test(readFileSync(new URL("../../src/agent/loopTools.ts", import.meta.url), "utf8")), "Cue's event search takes a city per search, so each place gets its own");

console.log(`search rules: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;
