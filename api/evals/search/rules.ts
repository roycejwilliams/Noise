// Model-free checks for the search/matching pure pieces (code review,
// 2026-09-17). No API calls, no database: npx tsx evals/search/rules.ts
//
// Covers: local-today gating (matchGate.ts checkTiming), out-of-range time
// frames (askWindow.ts resolveAskWindow), Tier 3 posts with past stated
// dates (matchGate.ts checkTiming), search cache key differences
// (searchRules.ts searchCacheKey), and online Co event handling
// (luma.ts resolveCoEventPlace).
import { DateTime } from "luxon";
import { readFileSync } from "fs";
import { checkTiming, checkLocation, type MatchFacts } from "../../src/harness/matchGate.js";
import type { TierMatch } from "../../src/services/tieredRecommendation.js";
import { carryTimeFrame, mentionsUnknownDay, resolveAskWindow } from "../../src/services/askWindow.js";
import { alreadySentNames, searchCacheKey, triesInOrder, xSearchBudget } from "../../src/services/searchRules.js";
import { profileForSearch } from "../../src/harness/personSnapshot.js";
import { resolveCoEventPlace } from "../../src/services/luma.js";
import { localToday, searchZone } from "../../src/services/eventOrder.js";
import { interleaveByTier, tierAlreadyCovered } from "../../src/services/eventSurfacingSweep.js";
import { spelledNumbers } from "../../src/harness/matchGate.js";
import { htmlToText, looksOfficial, pageExcerpt } from "../../src/services/webOpportunitySearch.js";

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
  !checkTiming(sameEveningEvent, { ...baseFacts, now: evening, zone: null }).pass,
  "sanity: without a zone, UTC 'today' (the 17th) does reject the 16th (shows the bug this replaces)",
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
  reason: "Matches a Co event happening Sunday, September 20, online.",
  online: true,
  city: null,
};
c(
  checkLocation(onlineMatch, { ...baseFacts, now: evening, searchCity: "Fargo, ND" }).pass,
  "an online Co event passes the location check for a searcher anywhere, with no radius filter",
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
const base = { city: "San Francisco", askText: "founder meetups", windowStart: null, windowEnd: null, today: "2026-09-17", zone: "America/Los_Angeles", browse: false, profile: "profile text" };
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
c(z1.zone === "America/Los_Angeles" && z1.defaulted === true, "no timezone on file falls back to Co's home zone, not server/UTC, and records the default");
const z2 = searchZone("America/New_York");
c(z2.zone === "America/New_York" && z2.defaulted === false, "a real timezone is used as-is, not defaulted");
c(localToday(evening, null) === "2026-09-17", "localToday with no zone falls back to the UTC date");
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
const searchProfile = profileForSearch({ asOf: "2026-09-18T19:53", work: "Founder of Co, pre-seed", place: "San Francisco", worked: [], wantsNow: ["Find pre-seed VCs in SF", "Find grants for a founder event"], didntWork: [], weighingOn: ["stressed about fundraising"], valuesInPeople: ["laid-back founders"] } as any);
c(searchProfile.includes("Founder of Co") && searchProfile.includes("laid-back founders"), "the search profile keeps who they are");
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

// The reply agent must not search a second time in a turn the pipeline already searched
// (2026-09-21: it re-ran, found only what had just been sent, and told the member "nothing
// solid came up" right after "two that fit, sending both now").
{
  const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  const reply = readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
  c(/if \(ctx\.searchedThisTurn\) \{\s*return \{ ok: true, found: \[\]/.test(tools), "searchNow refuses to run when a search already ran this turn");
  c(reply.includes("searchedThisTurn: input.searchedThisTurn"), "the reply agent tells its tools a search already ran");
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

console.log(`search rules: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;
