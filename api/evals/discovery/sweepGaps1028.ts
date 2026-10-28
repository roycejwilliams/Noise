// The 2026-10-28 9am sweep's two gaps: a Luma event page swapped for the company's homepage and then dropped for having nothing
// verified on it, and a goal whose web search timed out counted as searched and never retried. Plus what the team's /sweeps page now
// shows (incomplete, failed, web results dropped unverified). Zero tokens: nothing is read from the web, the model or the database.
//   npx tsx evals/discovery/sweepGaps1028.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const W = await import("../../src/services/taskWeb.js");
const D = await import("../../src/services/dailySweep.js");
const SC = await import("../../src/services/searchCoverage.js");
const SF = await import("../../src/services/sweepFind.js");
const T = await import("../../src/services/tieredRecommendation.js");
const LV = await import("../../src/services/lumaViaExa.js");
const { transientFailure } = await import("../../src/services/searchFailure.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

// ---------------------------------------------------------------- 1. one event's own page is never swapped for a homepage
{
  const events = ["https://www.eventbrite.com/e/founder-supper-tickets-123456789", "https://partiful.com/e/AbC123", "https://www.meetup.com/sf-builders/events/301234567/"];
  const lumaMaybe = ["https://luma.com/2gizvh99", "https://lu.ma/atnnffe2", "https://lu.ma/sf", "https://luma.com/nyc", "https://luma.com/ai", "https://lu.ma/genai-sf"];
  const notEvents = ["https://luma.com/discover", "https://lu.ma/calendar", "https://luma.com/about", "https://luma.com/blog", "https://luma.com/terms", "https://luma.com/signup", "https://luma.com/search", "https://luma.com/sf/ai", "https://www.eventbrite.com/d/ca--san-francisco/ai/", "https://www.meetup.com/sf-builders/", "https://memorybox.ai/", "https://allai.events/event/agent-building--founder-networking-salon", "not a url"];
  check("an Eventbrite, Partiful or Meetup event url can only be one event", events.every((u) => W.eventPageUrl(u) === "event"), events.map((u) => W.eventPageUrl(u)));
  check("a one-part Luma path may be an event or a city or calendar page: the page decides", lumaMaybe.every((u) => W.eventPageUrl(u) === "luma"), lumaMaybe.map((u) => W.eventPageUrl(u)));
  check("Luma's own pages (about, blog, terms, signup, search, discover, calendar), a homepage or a directory listing aren't one", notEvents.every((u) => W.eventPageUrl(u) === null), notEvents.filter((u) => W.eventPageUrl(u) !== null));
  check("taskWeb reads Luma's not-an-event list from lumaViaExa.ts, not a copy", LV.LUMA_NOT_EVENTS.has("about") && LV.lumaEventSlug("https://luma.com/blog") === null && !/new Set\(\["discover"/.test(src("services/taskWeb.ts")));

  const lumaText = `MemoryBox Beta Launch 🏓 AI that remembers. A party you won't forget.\nThursday, November 6, 6:00 PM - 9:00 PM\nSoMa, San Francisco\nHosted by MemoryBox. Join us to celebrate the beta launch with ping pong, drinks and demos. Register to attend.\nAbout the event: MemoryBox is an AI that remembers the people, places and moments in your life, so you never lose the thread. Come meet the team behind the beta, try it on your own phone, play a round of ping pong with the founders, and hear what we're building next. Doors open at six; demos start at seven. Space is limited, so please register ahead and bring a friend who forgets birthdays.`;
  const home = `MemoryBox. AI that remembers. Your memories, organized. Download the app.`;
  const raw = { name: "MemoryBox Beta Launch 🏓 AI that remembers. A party you won't forget.", url: "https://luma.com/2gizvh99", details: [{ label: "date", value: "Thursday, November 6, 6:00 PM" }, { label: "neighborhood", value: "SoMa, San Francisco" }], date: "2026-11-06", deadline: null };
  let lookedUp = false;
  const reads: Record<string, string> = { "https://luma.com/2gizvh99": lumaText, "https://www.memorybox.ai/": home };
  let askedPage = "";
  const pageReads: string[] = [];
  const page = await W.pickPage(raw, { read: async (u) => (pageReads.push(u), reads[u] ?? null), official: async () => { lookedUp = true; return "https://www.memorybox.ai/"; }, eventPage: async (u) => { askedPage = u; return { oneEvent: true, text: lumaText, shareable: true }; } });
  check("the 10-28 MemoryBox party: its Luma page stays, never swapped for memorybox.ai", page.url === raw.url && !page.swapped && page.text === lumaText, page);
  check("and no homepage is even looked up for it: its own page's data says it's one event", !lookedUp && askedPage === raw.url);
  check("re-review of #293: the Luma page is fetched once, for the check and its text both (no second read)", pageReads.length === 0, pageReads);
  const shell = await W.pickPage(raw, { read: async (u) => (u === raw.url ? lumaText : null), official: async () => null, eventPage: async () => ({ oneEvent: true, text: "Luma", shareable: true }) });
  check("a fetch that came back as a short shell is read as any page is", shell.text === lumaText && !shell.swapped);
  check("its Luma page isn't marked the company's own page: facts on it are still checked next to its name", page.official === false);
  const v = W.verifyResult({ ...raw, url: page.url }, page.text!, { now: new Date("2026-10-28T16:00:00Z"), zone: "America/Los_Angeles", official: page.official });
  const kept = W.withVerifiedFacts(v.kept ? [v.kept] : []);
  check("checked on the page that holds it, the party keeps its facts and is kept (not dropped as nothing verified)", kept.kept.length === 1 && kept.kept[0].url === raw.url && kept.kept[0].facts.length > 0, { v, kept });
  // The rule itself is unchanged: on the homepage, the same result would have had nothing verified and been dropped.
  const onHome = W.verifyResult({ ...raw, url: "https://www.memorybox.ai/" }, home, { now: new Date("2026-10-28T16:00:00Z"), zone: "America/Los_Angeles", official: true });
  check("the verification rule is unchanged: checked against the homepage, it has nothing verified and is dropped", W.withVerifiedFacts(onHome.kept ? [onHome.kept] : []).kept.length === 0);

  // A Luma calendar named like an event (lu.ma/genai-sf): its page's data isn't one event, so it's treated as before (swapped).
  const cal = await W.pickPage({ ...raw, url: "https://lu.ma/genai-sf" }, { read: async (u) => reads[u] ?? "calendar", official: async () => "https://www.memorybox.ai/", eventPage: async () => ({ oneEvent: false, text: null, shareable: true }) });
  check("a Luma calendar or city page isn't kept as an event page: its own data decides, and it's swapped as before", cal.swapped && cal.url === "https://www.memorybox.ai/");
  const eb = await W.pickPage({ ...raw, url: "https://www.eventbrite.com/e/memorybox-beta-launch-tickets-1" }, { read: async () => lumaText, official: async () => "https://www.memorybox.ai/", eventPage: async () => ({ oneEvent: false, text: null }) });
  check("an Eventbrite event page is kept by its url alone", !eb.swapped && eb.url.includes("eventbrite.com/e/"));
  // 2026-10-28 (event tier by page): any event-shaped page is read once, through eventPage.ts readEventPage (Luma's record or one schema.org Event).
  check("Luma's own page data decides it, from one fetch (eventPage.ts readEventPage), read for an event-shaped url", /m\.readEventPage\(url\)/.test(src("services/taskWeb.ts")) && /return \(await readLumaPage\(url\)\)\.details;/.test(src("services/eventDetails.ts")));
  const calText = await W.pickPage({ ...raw, url: "https://lu.ma/genai-sf" }, { read: async () => { throw new Error("read twice"); }, official: async () => null, eventPage: async () => ({ oneEvent: false, text: lumaText, shareable: true }) });
  check("a Luma page that isn't one event and has no own site found is checked on the text that one fetch read", !calText.swapped && calText.text === lumaText);
  const blog = { name: "The Loft at Mission Bay", url: "https://bestvenues-blog.com/top-10-sf-venues", details: [] };
  const swap = await W.pickPage(blog, { read: async (u) => (u === "https://theloftsf.com/" ? "The Loft at Mission Bay" : "Top 10 venues"), official: async () => "https://theloftsf.com/" });
  check("a blog or directory result is still swapped for the thing's own page", swap.swapped && swap.url === "https://theloftsf.com/" && swap.official);
}

// ---------------------------------------------------------------- 2. a place that failed or timed out leaves the search incomplete
{
  const b = { kind: "goal" as const, id: "g1", text: "apply to South Park Commons or Blueprint II" };
  const timedOut = { sources: { events: true, web: true, x: true, failures: ["web: the search failed (an outage, nothing came back)"], outages: ["web"] }, found: 2, pooled: 2, queued: 0, outcome: "in the pool for the picker" };
  const item = D.searchedItem(b, timedOut);
  check("the 10-28 goal: Exa timed out on the web, events and X ran: incomplete, not searched", item.status === "incomplete" && item.outages?.join() === "web" && /web failed or timed out/.test(item.why ?? ""), item);
  check("what its other places found is kept on the item (the finds are in the pool)", item.found === 2 && item.pooled === 2);
  const refused = { sources: { events: true, web: true, x: true, failures: ["web: queries refused (too tight)", "x: unavailable (budget)", "web: the day's web search budget is used up"] }, found: 1, pooled: 1, queued: 0, outcome: "x" };
  check("a refused query or a used-up budget isn't an outage: the search is done (a later hour would do the same)", D.searchedItem(b, refused).status === "searched");
  check("a search with no failures is searched", D.searchedItem(b, { sources: { events: true, web: true, x: true, failures: [] }, found: 0, pooled: 0, queued: 0, outcome: "nothing found" }).status === "searched");

  // Bounded: the 9am run and two retries at most (DAILY_SWEEP_ERRORS_PER_DAY runs), through the floor's own retry.
  check("the cap is the floor's own: three runs a day", D.DAILY_SWEEP_ERRORS_PER_DAY === 3);
  check("an incomplete item retries the day on the 9am run and the first retry", D.incompleteRetry([item], 0, false) === "retry" && D.incompleteRetry([item], 1, false) === "retry");
  check("the day's last run keeps what it has: no third retry", D.incompleteRetry([item], 2, false) === "last" && D.incompleteRetry([item], 5, false) === "last");
  check("an on-demand run is never retried", D.incompleteRetry([item], 0, true) === "last");
  check("nothing incomplete: no retry", D.incompleteRetry([{ ...b, status: "searched" }], 0, false) === null);

  // The retry: what was searched in full is carried, never searched twice; the incomplete one is searched again.
  const earlier = [{ proposal: { items: [item, { kind: "goal", id: "g2", text: "pre-seed funding", status: "searched", found: 1, pooled: 1, queued: 0 }] } }];
  const done = D.searchedEarlierToday(earlier);
  check("a retry carries the fully searched goal and searches the incomplete one again", done.has("goal:g2") && !done.has("goal:g1"));

  // Review of #293: a retried item counts a find once across its runs (the first attempt's finds are in the pool too).
  const first = D.searchedItem(b, { ...timedOut, foundKeys: ["A|", "B|"], pooledKeys: ["https://a", "https://b"], queued: 1 });
  const again = D.searchedItem(b, { sources: { events: true, web: true, x: true, failures: [] }, found: 1, pooled: 1, queued: 0, outcome: "x", foundKeys: ["A|"], pooledKeys: ["https://a"] });
  const merged = D.mergeRetried(again, D.incompleteEarlierToday([{ proposal: { items: [first] } }]).get("goal:g1"));
  check("a retry that finds fewer doesn't lose the first attempt's finds, and one found twice counts once", merged.status === "searched" && merged.found === 2 && merged.pooled === 2 && merged.queued === 1, merged);
  const more = D.mergeRetried(D.searchedItem(b, { sources: { events: true, web: true, x: true, failures: [] }, found: 3, pooled: 3, queued: 0, outcome: "x", foundKeys: ["A|", "C|", "D|"], pooledKeys: ["https://a", "https://c", "https://d"] }), first);
  check("and one that finds more counts each find once (no double count of what both found)", more.found === 4 && more.pooled === 4, more);
  check("an older record without keys: the larger count stands", D.mergeRetried({ ...b, status: "searched", found: 1, pooled: 1, queued: 0 }, { ...b, status: "incomplete", found: 3, pooled: 2, queued: 0 }).found === 3);
  check("the floor merges a retried item with its earlier incomplete attempt", /items\.push\(mergeRetried\(searchedItem\(b, r!\), retried\.get\(`\$\{b\.kind\}:\$\{b\.id\}`\)\)\);/.test(src("services/dailySweep.ts")));
  check("places down are carried on the item and counted", D.searchedItem(b, { sources: { events: true, web: true, x: true, failures: ["web: ..."], lasting: ["web"] }, found: 0, pooled: 0, queued: 0, outcome: "x" }).placesDown?.join() === "web" && D.dailySummary([{ ...b, status: "searched", placesDown: ["web", "x"] }]).totals.placesDown === 2);

  const sum = D.dailySummary([item, { kind: "goal", id: "g2", text: "pre-seed funding", status: "searched", sources: { events: true, web: true, x: true }, found: 1, pooled: 1, queued: 0, unverified: 2 }, { ...b, id: "g3", status: "error", why: "x" }]);
  check("the summary: an incomplete goal isn't counted as searched, nor its places", sum.totals.goalsSearched === 1 && sum.totals.incomplete === 1 && sum.totals.sources.web === 1, sum.totals);
  check("but its finds are (they're real and in the pool)", sum.totals.kept === 3 && sum.totals.pooled === 3);
  check("the line says it, and web results dropped unverified", /incomplete 1/.test(sum.action) && /web results dropped unverified 2/.test(sum.action) && /errors 1/.test(sum.action), sum.action);

  // The reply's "what's running" still counts an incomplete goal (it's retried), never a quiet "nothing's running".
  check("an incomplete goal still counts as being searched for the reply's running-work line", SC.searchedGoals({ items: [item, { kind: "goal", text: "skipped one", status: "skipped" }] }).join() === item.text);

  // Which failures clear (review of #293): a timeout, a network error, a 5xx. A key, credit, a rate limit or a budget doesn't.
  const clears = ["Exa timed out", "Web search failed: Exa timed out.", "Web search failed: Exa 503.", "Exa couldn't be reached", "fetch failed", "connect ETIMEDOUT 1.2.3.4:443", "Overloaded", "Cannot connect to API: other side closed", "read ECONNRESET", "socket hang up", "status 502", LV.exaFailureReason("Exa timed out"), LV.exaFailureReason("Exa 503"), LV.exaFailureReason("threw: ETIMEDOUT"), "Luma's feed failed (lumaDiscovery: fetchPublicEvents failed (504): gateway)"];
  const stays = ["Web search failed: Exa 401.", "Web search failed: Exa 402 NO_MORE_CREDITS.", "Exa 429", "auth (401)", "rate_limited (429)", "error (402)", "not_configured (no status)", "the day's web search budget is used up", "unavailable (the daily X cap is reached)", LV.exaFailureReason("Exa 402"), LV.exaFailureReason("Exa 401"), LV.exaFailureReason("Exa 429"), LV.lumaRefusedReason(3, 0, 10, 10), LV.LUMA_API_OFF, "Luma's feed failed (luma: listCalendarEvents failed (401): bad key)", "", "something unknown"];
  check("a timeout, a network error or a 5xx clears", clears.every((t) => transientFailure(t)), clears.filter((t) => !transientFailure(t)));
  check("a key, credit, a rate limit, a cap or anything unknown doesn't", stays.every((t) => !transientFailure(t)), stays.filter((t) => transientFailure(t)));

  // Each place: an outage only for a failure that clears and no clean call; a failure that doesn't clear is "down", shown, not retried.
  const reads = (f: (r: ReturnType<typeof SF.newPlaceReads>) => void) => { const r = SF.newPlaceReads(); f(r); return SF.placeReport(r); };
  check("web timed out on every call: an outage", reads((r) => { SF.placeFailed(r, "web", "Web search failed: Exa timed out."); }).outages.join() === "web");
  check("review of #293: web timed out once, then a later web call answered: not an outage", reads((r) => { SF.placeFailed(r, "web", "Web search failed: Exa timed out."); r.web.ok = true; }).outages.length === 0);
  const credit = reads((r) => { SF.placeFailed(r, "web", "Web search failed: Exa 402."); SF.placeFailed(r, "x", "auth (401)"); });
  check("review of #293: Exa out of credit and X's key refused: down (shown), never an outage (retried)", credit.outages.length === 0 && credit.lasting.join() === "web,x", credit);

  // Review of #293: an events search whose feed, calendar and Exa all time out comes back empty without throwing.
  const timeout = () => { throw Object.assign(new Error("connect ETIMEDOUT 104.18.0.1:443"), { code: "ETIMEDOUT" }); };
  const ev = await T.eventCandidates("AI founder events", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, sources: { feed: async () => timeout(), calendar: async () => timeout(), viaExa: async () => timeout(), page: async () => null, near: async () => true, rank: (async () => ({ ranked: [], closest: null })) as any, gate: (async (m: any) => m) as any, record: (async () => {}) as any, exaOn: () => true } });
  const evFailed = SF.eventSearchFailures(ev);
  check("review of #293: a timed-out feed, calendar and Exa are said, not an empty feed", ev.candidates.length === 0 && evFailed.length === 3 && evFailed.every((f) => transientFailure(f)) && ev.answered === 0, { evFailed, answered: ev.answered });
  check("so the events place is an outage (none of its sources answered)", reads((r) => { SF.noteEventSearch(r, ev); }).outages.join() === "events");
  const stub = { page: async () => null, near: async () => true, rank: (async () => ({ ranked: [], closest: null })) as any, gate: (async (m: any) => m) as any, record: (async () => {}) as any, exaOn: () => true };
  // Re-review of #293: Luma's feed answered and only the Luma search through Exa timed out: said, not an outage (no retry).
  const partial = await T.eventCandidates("AI founder events", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, sources: { ...stub, feed: async () => [], calendar: async () => [], viaExa: async () => timeout() } });
  const partialRead = reads((r) => { check("the partial timeout is still said on the item", SF.noteEventSearch(r, partial).length === 1); });
  check("re-review of #293: the feed answered and only Exa timed out: no outage, nothing down", (partial.answered ?? 0) >= 1 && partialRead.outages.length === 0 && partialRead.lasting.length === 0, { answered: partial.answered, partialRead });
  // Batched review of #293: Noise's own calendar is a cache, so it answering alone isn't events having searched.
  const cacheOnly = await T.eventCandidates("AI founder events", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, sources: { ...stub, feed: async () => timeout(), calendar: async () => [], viaExa: async () => timeout() } });
  check("batched review of #293: feed and Exa timed out, only the cached calendar answered: an outage (retried)", cacheOnly.answered === 0 && reads((r) => { SF.noteEventSearch(r, cacheOnly); }).outages.join() === "events", { answered: cacheOnly.answered });
  check("batched review of #293: only undici's bare \"terminated\" clears, not any message with the word", transientFailure("TypeError: terminated") && transientFailure("terminated") && transientFailure("Luma's feed failed (terminated)") && transientFailure("the Luma search through Exa threw (terminated); tier 2 went out from Luma's feed alone") && !transientFailure("Session terminated by the provider: account closed"));
  // Re-review of #293: no LUMA_API_KEY is a setting, as on the Exa path: no failure, nothing red.
  const { LUMA_KEY_MISSING } = await import("../../src/services/luma.js");
  const noKey = await T.eventCandidates("AI founder events", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, viaExa: false, sources: { ...stub, feed: async () => [], calendar: async () => { throw new Error(LUMA_KEY_MISSING); } } });
  check("re-review of #293: a missing LUMA_API_KEY on the calendar is no failure, and events isn't down", !noKey.failures && reads((r) => { SF.noteEventSearch(r, noKey); }).lasting.length === 0, noKey.failures);
  check("Exa being off, no Luma key, no catalog city or a test account isn't an events failure", SF.eventSearchFailures({ viaExa: { error: LV.EXA_OFF } }).length === 0 && SF.eventSearchFailures({ viaExa: { error: LV.NO_PLACE } }).length === 0 && SF.eventSearchFailures({ viaExa: { error: LV.LUMA_API_OFF } }).length === 0 && SF.eventSearchFailures({ viaExa: { error: LV.TEST_ACCOUNT } }).length === 0);
  check("Exa out of credit while the feed answered: an events failure that doesn't clear (down, not an outage)", (() => { const x = reads((r) => { SF.noteEventSearch(r, { viaExa: { error: LV.exaFailureReason("Exa 402") }, answered: 1 }); }); return x.lasting.join() === "events" && !x.outages.length; })());

  // Wiring (sweepFind's loop can't run here without a model).
  const sf = src("services/sweepFind.ts");
  check("sweepFind: an events throw, an events part that failed, every web query failed, X's failure and a failed loop each go through placeFailed", /placeFailed\(places, "events", String\(err\?\.message \?\? err\)\);/.test(sf) && /const partFailed = noteEventSearch\(places, r\);/.test(sf) && /for \(const r of all\) placeFailed\(places, "web"/.test(sf) && /placeFailed\(places, "x", xError\.kind === "server"/.test(sf) && /if \(!called\.has\(s\.source\)( && !skips\.has\(s\.source\))?\) placeFailed\(places, s\.source/.test(sf));
  check("sweepFind: a clean call marks its place ok (events with nothing that clears failing, any web query answering, X answering)", /if \(\(r\.answered \?\? 1\) > 0\) reads\.events\.ok = true;/.test(sf) && /\) places\.web\.ok = true;/.test(sf) && /places\.x\.ok = true;/.test(sf));
  check("sweepFind: the report carries outages, places down and the unverified count", /outages: report\.outages/.test(sf) && /lasting: report\.lasting/.test(sf) && /unverified \+= all\.reduce/.test(sf));
  const ds = src("services/dailySweep.ts");
  check("the floor reports each search through searchedItem and retries incomplete ones through its error record", /searchedItem\(b, r!\)/.test(ds) && /retryIncomplete === "retry" \? incompleteLines : \[\]/.test(ds) && /await writeDaily\(userId, "skip", "error"/.test(ds));
}

// ---------------------------------------------------------------- 2b. the hourly ask sweep: a timed-out place isn't an empty run
{
  const ES = await import("../../src/services/eventSurfacingSweep.js");
  check("Royce 10-28 'close those gaps': the web timed out while events answered and nothing was found: not an empty run", !ES.movesEmptyRuns({ searched: true, found: [], sources: { outages: ["web"] } }));
  check("a run that found something still resets the count, outage or not", ES.movesEmptyRuns({ searched: true, found: [{}], sources: { outages: ["web"] } }));
  check("a clean run that found nothing is an empty run, as before (a place down for good doesn't stop it)", ES.movesEmptyRuns({ searched: true, found: [], sources: {} }) && ES.movesEmptyRuns({ searched: true, found: [] }));
  check("a run that never really looked moves nothing, as before", !ES.movesEmptyRuns({ searched: false, found: [] }));
  check("the hourly sweep's empty-run count reads it", /&& movesEmptyRuns\(trace\)\) \{/.test(src("services/eventSurfacingSweep.ts")));
}

// ---------------------------------------------------------------- 3. the /sweeps page shows it
{
  const run = (action: string, totals: Record<string, number>, outcome = action === "error" ? "skip" : "act") => ({ outcome, action, reason: action === "error" ? "goal incomplete: web failed (run again next hour)" : null, proposal: { totals } });
  const retried = D.rollupDay([run("error", { goalsSearched: 3, incomplete: 1, unverified: 2, kept: 3 }), run("asks searched 0, goals searched 4", { goalsSearched: 4, incomplete: 0, unverified: 2, kept: 4 })], 1, true, true);
  check("a day whose retry finished it: ran, nothing left incomplete", retried.status === "ran" && retried.incomplete === 0 && retried.goalsSearched === 4 && retried.unverified === 2, retried);
  const stuck = D.rollupDay([run("error", { incomplete: 1 }), run("error", { incomplete: 1 }), run("goals searched 3", { goalsSearched: 3, incomplete: 1, unverified: 5, errors: 0 })], 0, true, true);
  check("a goal still incomplete after the retries shows on the day", stuck.status === "ran" && stuck.incomplete === 1 && stuck.unverified === 5, stuck);
  const failedDay = D.rollupDay([run("error", { errors: 2, goalsSearched: 1 }), run("error", { errors: 2 }), run("error", { errors: 2, unverified: 1, placesDown: 1 })], 0, true, true);
  check("a day of failed runs shows how many items failed in the last one, and places down", failedDay.status === "error" && failedDay.failed === 2 && failedDay.unverified === 1 && failedDay.placesDown === 1, failedDay);
  const old = D.rollupDay([{ outcome: "act", action: "x", reason: null, proposal: { totals: { goalsSearched: 1 } } }], 0, true, true);
  check("an older record without them reads as zero", old.incomplete === 0 && old.failed === 0 && old.placesDown === 0 && old.unverified === 0);
  const client = readFileSync(new URL("../../../co-test/src/client/sweeps.ts", import.meta.url), "utf8");
  check("the page has the four columns and counts an incomplete, failed or down day as one to look at", /<th>Incomplete<\/th><th>Failed<\/th><th>Places down<\/th><th>Web dropped unverified<\/th>/.test(client) && /\(r\.incomplete \?\? 0\) > 0 \|\| \(r\.failed \?\? 0\) > 0 \|\| \(r\.placesDown \?\? 0\) > 0/.test(client));
  const html = readFileSync(new URL("../../../co-test/public/sweeps.html", import.meta.url), "utf8");
  check("the explainer says what turns red (a mark, not a row)", !/A red row/.test(html) && /A red mark/.test(html));
}

console.log(`sweep gaps (2026-10-28): ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
