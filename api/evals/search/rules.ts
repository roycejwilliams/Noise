// Model-free checks for the search/matching pure pieces (code review,
// 2026-09-17). No API calls, no database: npx tsx evals/search/rules.ts
//
// Covers: local-today gating (matchGate.ts checkTiming), out-of-range time
// frames (askWindow.ts resolveAskWindow), Tier 3 posts with past stated
// dates (matchGate.ts checkTiming), search cache key differences
// (searchRules.ts searchCacheKey), and online Co event handling
// (luma.ts resolveCoEventPlace).
import { DateTime } from "luxon";
import { checkTiming, checkLocation, type MatchFacts } from "../../src/harness/matchGate.js";
import type { TierMatch } from "../../src/services/tieredRecommendation.js";
import { carryTimeFrame, resolveAskWindow } from "../../src/services/askWindow.js";
import { searchCacheKey, triesInOrder, xSearchBudget } from "../../src/services/searchRules.js";
import { profileForSearch } from "../../src/harness/personSnapshot.js";
import { resolveCoEventPlace } from "../../src/services/luma.js";
import { localToday, searchZone } from "../../src/services/eventOrder.js";
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
console.log(`search rules: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;
