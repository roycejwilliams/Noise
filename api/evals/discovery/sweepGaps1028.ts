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
  const events = ["https://luma.com/2gizvh99", "https://lu.ma/atnnffe2", "https://www.eventbrite.com/e/founder-supper-tickets-123456789", "https://partiful.com/e/AbC123", "https://www.meetup.com/sf-builders/events/301234567/"];
  const notEvents = ["https://luma.com/discover", "https://lu.ma/calendar", "https://luma.com/sf/ai", "https://www.eventbrite.com/d/ca--san-francisco/ai/", "https://www.meetup.com/sf-builders/", "https://memorybox.ai/", "https://allai.events/event/agent-building--founder-networking-salon", "not a url"];
  check("one event's own page on a ticketing site is known by its url", events.every((u) => W.oneEventPage(u)), events.filter((u) => !W.oneEventPage(u)));
  check("a ticketing site's discover, calendar or group page, a homepage, or a directory listing isn't one", notEvents.every((u) => !W.oneEventPage(u)), notEvents.filter((u) => W.oneEventPage(u)));

  const lumaText = `MemoryBox Beta Launch 🏓 AI that remembers. A party you won't forget.\nThursday, November 6, 6:00 PM - 9:00 PM\nSoMa, San Francisco\nHosted by MemoryBox. Join us to celebrate the beta launch with ping pong, drinks and demos. Register to attend.`;
  const home = `MemoryBox. AI that remembers. Your memories, organized. Download the app.`;
  const raw = { name: "MemoryBox Beta Launch 🏓 AI that remembers. A party you won't forget.", url: "https://luma.com/2gizvh99", details: [{ label: "date", value: "Thursday, November 6, 6:00 PM" }, { label: "neighborhood", value: "SoMa, San Francisco" }], date: "2026-11-06", deadline: null };
  let lookedUp = false;
  const reads: Record<string, string> = { "https://luma.com/2gizvh99": lumaText, "https://www.memorybox.ai/": home };
  const page = await W.pickPage(raw, { read: async (u) => reads[u] ?? null, official: async () => { lookedUp = true; return "https://www.memorybox.ai/"; } });
  check("the 10-28 MemoryBox party: its Luma page stays, never swapped for memorybox.ai", page.url === raw.url && !page.swapped && page.text === lumaText, page);
  check("and no homepage is even looked up for it", !lookedUp);
  check("its Luma page isn't marked the company's own page: facts on it are still checked next to its name", page.official === false);
  const v = W.verifyResult({ ...raw, url: page.url }, page.text!, { now: new Date("2026-10-28T16:00:00Z"), zone: "America/Los_Angeles", official: page.official });
  const kept = W.withVerifiedFacts(v.kept ? [v.kept] : []);
  check("checked on the page that holds it, the party keeps its facts and is kept (not dropped as nothing verified)", kept.kept.length === 1 && kept.kept[0].url === raw.url && kept.kept[0].facts.length > 0, { v, kept });
  // The rule itself is unchanged: on the homepage, the same result would have had nothing verified and been dropped.
  const onHome = W.verifyResult({ ...raw, url: "https://www.memorybox.ai/" }, home, { now: new Date("2026-10-28T16:00:00Z"), zone: "America/Los_Angeles", official: true });
  check("the verification rule is unchanged: checked against the homepage, it has nothing verified and is dropped", W.withVerifiedFacts(onHome.kept ? [onHome.kept] : []).kept.length === 0);

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

  const sum = D.dailySummary([item, { kind: "goal", id: "g2", text: "pre-seed funding", status: "searched", sources: { events: true, web: true, x: true }, found: 1, pooled: 1, queued: 0, unverified: 2 }, { ...b, id: "g3", status: "error", why: "x" }]);
  check("the summary: an incomplete goal isn't counted as searched, nor its places", sum.totals.goalsSearched === 1 && sum.totals.incomplete === 1 && sum.totals.sources.web === 1, sum.totals);
  check("but its finds are (they're real and in the pool)", sum.totals.kept === 3 && sum.totals.pooled === 3);
  check("the line says it, and web results dropped unverified", /incomplete 1/.test(sum.action) && /web results dropped unverified 2/.test(sum.action) && /errors 1/.test(sum.action), sum.action);

  // The reply's "what's running" still counts an incomplete goal (it's retried), never a quiet "nothing's running".
  check("an incomplete goal still counts as being searched for the reply's running-work line", SC.searchedGoals({ items: [item, { kind: "goal", text: "skipped one", status: "skipped" }] }).join() === item.text);

  // Wiring (sweepFind can't run here without a model): the outage branches name their place, a failed loop marks what it didn't reach.
  const sf = src("services/sweepFind.ts");
  check("sweepFind: events, web and X failures each mark their place as an outage", /outages\.add\("events"\);\s*sourceFailures\.push\(`events: the search failed/.test(sf) && /outages\.add\("web"\);\s*sourceFailures\.push\("web: the search failed \(an outage/.test(sf) && /outages\.add\("x"\);\s*sourceFailures\.push\(`x: the search failed/.test(sf));
  check("sweepFind: a failed loop marks every place it hadn't reached as an outage", /the search loop failed[\s\S]{0,300}for \(const s of SWEEP_SOURCES\) if \(!called\.has\(s\.source\)\) outages\.add\(s\.source\);/.test(sf));
  check("sweepFind: a refusal or a used-up budget isn't an outage", !/outages\.add\([^)]*\);\s*sourceFailures\.push\(`?[a-z]+: (query refused|queries refused|unavailable)/.test(sf) && !/outages\.add\("web"\);\s*sourceFailures\.push\("web: the day's web search budget/.test(sf));
  check("sweepFind: the report carries outages and the unverified count", /outages: \[\.\.\.outages\]/.test(sf) && /unverified \+= all\.reduce/.test(sf));
  const ds = src("services/dailySweep.ts");
  check("the floor reports each search through searchedItem and retries incomplete ones through its error record", /items\.push\(searchedItem\(b, r!\)\);/.test(ds) && /retryIncomplete === "retry" \? incompleteLines : \[\]/.test(ds) && /await writeDaily\(userId, "skip", "error"/.test(ds));
}

// ---------------------------------------------------------------- 3. the /sweeps page shows it
{
  const run = (action: string, totals: Record<string, number>, outcome = action === "error" ? "skip" : "act") => ({ outcome, action, reason: action === "error" ? "goal incomplete: web failed (run again next hour)" : null, proposal: { totals } });
  const retried = D.rollupDay([run("error", { goalsSearched: 3, incomplete: 1, unverified: 2, kept: 3 }), run("asks searched 0, goals searched 4", { goalsSearched: 4, incomplete: 0, unverified: 2, kept: 4 })], 1, true, true);
  check("a day whose retry finished it: ran, nothing left incomplete", retried.status === "ran" && retried.incomplete === 0 && retried.goalsSearched === 4 && retried.unverified === 2, retried);
  const stuck = D.rollupDay([run("error", { incomplete: 1 }), run("error", { incomplete: 1 }), run("goals searched 3", { goalsSearched: 3, incomplete: 1, unverified: 5, errors: 0 })], 0, true, true);
  check("a goal still incomplete after the retries shows on the day", stuck.status === "ran" && stuck.incomplete === 1 && stuck.unverified === 5, stuck);
  const failedDay = D.rollupDay([run("error", { errors: 2, goalsSearched: 1 }), run("error", { errors: 2 }), run("error", { errors: 2, unverified: 1 })], 0, true, true);
  check("a day of failed runs shows how many items failed in the last one", failedDay.status === "error" && failedDay.failed === 2 && failedDay.unverified === 1, failedDay);
  const old = D.rollupDay([{ outcome: "act", action: "x", reason: null, proposal: { totals: { goalsSearched: 1 } } }], 0, true, true);
  check("an older record without them reads as zero", old.incomplete === 0 && old.failed === 0 && old.unverified === 0);
  const client = readFileSync(new URL("../../../co-test/src/client/sweeps.ts", import.meta.url), "utf8");
  check("the page has the three columns and counts an incomplete or failed day as one to look at", /<th>Incomplete<\/th><th>Failed<\/th><th>Web dropped unverified<\/th>/.test(client) && /\(r\.incomplete \?\? 0\) > 0 \|\| \(r\.failed \?\? 0\) > 0/.test(client));
}

console.log(`sweep gaps (2026-10-28): ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
