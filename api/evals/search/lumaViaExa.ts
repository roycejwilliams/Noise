// Tier 2 through Exa (services/lumaViaExa.ts, Royce 2026-10-17: "it finds the Luma events the feed misses"). One Exa search limited
// to Luma's pages joins the feed's events, deduped by slug, and goes through the same window, nearby filter, ranking, page read, gate
// and start check, out as a Luma link, tier 2. Exa's index is mostly past events: the page decides. Calls skip it; no key, no search;
// a failed search leaves the feed's events as they were. Zero tokens: Exa, Luma's pages, the feed, the ranking, the nearby test and
// the log are all stubbed, nothing leaves the machine.
//   npx tsx evals/search/lumaViaExa.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.EXA_API_KEY;
import { readFileSync } from "fs";

const V = await import("../../src/services/lumaViaExa.js");
const T = await import("../../src/services/tieredRecommendation.js");
const X = await import("../../src/services/exaSearch.js");
const D = await import("../../src/services/eventDetails.js");
const { gateMatches: T_gate } = await import("../../src/harness/matchGate.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

const H = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * H).toISOString();
// A Luma page as eventDetails reads it.
const page = (o: Record<string, unknown> = {}): any => ({ startAt: at(48), endAt: null, timezone: "America/Los_Angeles", online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: false, soldOut: false, guestCount: null, description: null, apiId: null, visibility: "public", ...o });
const exaPage = (url: string, title: string) => ({ url, title, published: null, text: "" });

// The world, per test: what Exa returns, each page, the feed.
type World = { exa: { url: string; title: string }[] | Error | "error"; pages: Record<string, any>; feed: any[] };
let world: World = { exa: [], pages: {}, feed: [] };
let exaCalls: string[] = [];
let logs: any[] = [];
const exaDep = async (query: string): Promise<any> => {
  exaCalls.push(query);
  if (world.exa instanceof Error) throw world.exa;
  if (world.exa === "error") return { pages: [], cost: null, error: "Exa timed out" };
  return { pages: world.exa.map((p) => exaPage(p.url, p.title)), cost: 0.022, error: null };
};
const pageDep = async (url: string) => world.pages[V.lumaEventSlug(url) ?? ""] ?? null;
const viaDeps = (configured = true) => ({ exa: exaDep, page: pageDep, configured: () => configured, now: () => new Date() });
// eventCandidates with every outside source stubbed. Nearby: San Francisco and Oakland are near each other, nothing else is.
const BAY = new Set(["san francisco", "oakland"]);
const sources = (o: { configured?: boolean; viaExa?: any } = {}) => ({
  feed: async () => world.feed,
  calendar: async () => [],
  viaExa: o.viaExa ?? ((what: string, city: string | null, opt: any) => V.lumaEventsViaExa(what, city, { ...opt, deps: viaDeps(o.configured ?? true) })),
  page: pageDep,
  near: async (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || (BAY.has(a.toLowerCase()) && BAY.has(b.toLowerCase())),
  rank: (async (events: any[], _what: string, opts: any) => ({ ranked: events.slice(0, opts.limit ?? 8).map((e) => ({ ...e, similarity: 1 })), closest: null })) as any,
  // The real gate (the start check, sold out, the window), without its geocoding (a real call): the nearby test above stands in.
  gate: ((m: any, ctx: any) => T_gate(m, { ...ctx, searchCity: null })) as any,
  record: (async (d: any) => { logs.push(d); }) as any,
  exaOn: () => o.configured ?? true,
});
const reset = (w: Partial<World>) => {
  V.clearLumaViaExaCache();
  world = { exa: [], pages: {}, feed: [], ...w };
  exaCalls = [];
  logs = [];
};
const search = (o: { configured?: boolean; viaExa?: any; exaOn?: boolean; city?: string } = {}) =>
  T.eventCandidates("founder dinners", o.city ?? "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, ...(o.exaOn === false ? { viaExa: false } : {}), sources: sources(o) });
const links = (r: Awaited<ReturnType<typeof search>>) => r.candidates.map(({ match }) => ("url" in match ? match.url : null));

// The feed (2 SF events) and what Exa finds for the same want.
const FEED = [
  { api_id: "evt-feed1", name: "Founders Panel: The Agentic Stack", start_at: at(30), city: "San Francisco", url: "https://lu.ma/feed1" },
  { api_id: "evt-feed2", name: "Lessons from Open Source DevTools Founders", start_at: at(54), city: "San Francisco", url: "https://lu.ma/feed2" },
];
const FEED_PAGES = { feed1: page({ startAt: FEED[0].start_at, apiId: "evt-feed1" }), feed2: page({ startAt: FEED[1].start_at, apiId: "evt-feed2" }) };

// ================================================================ the merge (pure)
{
  const feed = [{ api_id: "evt-a", url: "https://lu.ma/abc123", name: "Feed's copy" }];
  const exa = [
    { api_id: "luma:ABC123", url: "https://luma.com/ABC123?utm_source=x", name: "Exa's copy, same slug" },
    { api_id: "evt-a", url: "https://lu.ma/renamed-slug", name: "Exa's copy, same Luma id" },
    { api_id: "evt-b", url: "https://lu.ma/new1", name: "New" },
    { api_id: "evt-b", url: "https://lu.ma/new1", name: "New, twice" },
  ];
  const m = V.withExaEvents(feed, exa);
  check("merge: an event the feed has (same slug on either domain, any case, or the same Luma id) is the feed's copy; new ones follow it, once", m.map((e) => e.name).join("|") === "Feed's copy|New", m);
  check("merge: no Exa events, the feed as it was", JSON.stringify(V.withExaEvents(feed, [])) === JSON.stringify(feed));
  check("slugs: an event page is one; Luma's own pages aren't", V.lumaEventSlug("https://luma.com/hgikjz1r") === "hgikjz1r" && V.lumaEventSlug("https://lu.ma/discover") === null && V.lumaEventSlug("https://lu.ma/sf/events") === null && V.lumaEventSlug("https://example.com/abc") === null);
  check("titles lose Luma's suffix", V.eventTitle("Founder Dinner · Luma") === "Founder Dinner");
}

// ================================================================ what Exa finds: the page decides
{
  reset({
    exa: [
      { url: "https://lu.ma/past1", title: "Founder dinner, last spring · Luma" },
      { url: "https://lu.ma/later1", title: "Founder dinner in January · Luma" },
      { url: "https://lu.ma/started1", title: "Founder breakfast, this morning · Luma" },
      { url: "https://lu.ma/good1", title: "GP/LP mixer · Luma" },
      { url: "https://lu.ma/noread", title: "A page that won't load · Luma" },
      { url: "https://lu.ma/discover", title: "Discover · Luma" },
      { url: "https://lu.ma/good1/", title: "GP/LP mixer (again) · Luma" },
    ],
    pages: { past1: page({ startAt: "2026-04-01T02:00:00.000Z" }), later1: page({ startAt: at(24 * 90) }), started1: page({ startAt: at(-2), endAt: at(1) }), good1: page({ startAt: at(50), apiId: "evt-good1" }) },
  });
  const inRange = (s: string) => new Date(s).getTime() < Date.now() + 14 * 24 * H;
  const r = await V.lumaEventsViaExa("founder dinners", "San Francisco", { inRange, dates: "now to then", deps: viaDeps() });
  check("only the upcoming, in-window event survives: past, a start outside the window and one already started are dropped (by its page, not Exa's title)", r?.events.map((e) => e.url).join() === "https://lu.ma/good1", r);
  check("...its start, city and Luma id come from its own page, and its link is the plain lu.ma one", r?.events[0]?.start_at === world.pages.good1.startAt && r?.events[0]?.city === "San Francisco" && r?.events[0]?.api_id === "evt-good1", r?.events[0]);
  check("...the report counts it: 5 event pages (Discover and a repeat aren't), 4 read, 1 kept", r?.report.pages === 5 && r?.report.read === 4 && r?.report.kept === 1 && r?.report.cached === false, r?.report);
  check("the search is Luma's pages only, 25 results, no page text, with the want, the city and the dates", exaCalls[0] === "founder dinners in San Francisco, now to then");
}

// ================================================================ no key, no search
{
  reset({ exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }], pages: { good1: page() } });
  const r = await V.lumaEventsViaExa("founder dinners", "San Francisco", { inRange: () => true, dates: "x", deps: { ...viaDeps(), configured: undefined } as any });
  check("no EXA_API_KEY: no Exa call, nothing added", r === null && exaCalls.length === 0, { r, exaCalls });
  reset({ feed: FEED, pages: { ...FEED_PAGES, good1: page({ startAt: at(50) }) }, exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }] });
  const s = await search({ configured: false });
  check("...and the search is the feed's; the log says once that Exa is off and how to turn it on (no key, not a failure)", exaCalls.length === 0 && links(s).join() === "https://lu.ma/feed1,https://lu.ma/feed2" && s.viaExa === null && logs.length === 1 && logs[0].action === "off" && /EXA_API_KEY isn't set on this service.*set EXA_API_KEY to turn on/.test(logs[0].reason), { links: links(s), logs });
  logs = [];
  await search({ configured: false });
  check("...once per start, not on every search", logs.length === 0, logs);
}

// ================================================================ the cache
{
  reset({ exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }], pages: { good1: page({ startAt: at(50) }) } });
  const o = { inRange: () => true, dates: "October 19 to October 25, 2026", deps: viaDeps() };
  const a = await V.lumaEventsViaExa("Founder dinners", "San Francisco", o);
  const b = await V.lumaEventsViaExa("founder dinners ", "san francisco", o);
  check("the same want, city and dates within 6 hours: Exa is called once, the second is a cache hit with the same event", exaCalls.length === 1 && b?.report.cached === true && b?.events[0]?.url === a?.events[0]?.url, { exaCalls, b });
  world.pages.good1 = page({ startAt: at(-1) });
  const c = await V.lumaEventsViaExa("founder dinners", "San Francisco", o);
  check("...but each page is read again, so an event that has since started is dropped from the cached search", exaCalls.length === 1 && c?.events.length === 0, c);
  await V.lumaEventsViaExa("founder dinners", "San Francisco", { ...o, dates: "November 1 to November 7, 2026" });
  check("...other dates are another search", exaCalls.length === 2);
  reset({ exa: "error" });
  await V.lumaEventsViaExa("founder dinners", "San Francisco", o);
  world.exa = [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }];
  world.pages = { good1: page({ startAt: at(50) }) };
  const d = await V.lumaEventsViaExa("founder dinners", "San Francisco", o);
  check("a search that failed isn't kept: the next ask searches again and finds it", exaCalls.length === 2 && d?.events.length === 1, { exaCalls, d });
}

// ================================================================ through the whole search (eventCandidates)
{
  reset({
    feed: FEED,
    exa: [
      { url: "https://luma.com/feed1?utm_source=exa", title: "Founders Panel: The Agentic Stack · Luma" }, // the feed has it
      { url: "https://lu.ma/mixer1", title: "GP/LP mixer · Luma" },
      { url: "https://lu.ma/chicago1", title: "Founder dinner, Chicago · Luma" },
      { url: "https://lu.ma/oak1", title: "Founder dinner, Oakland · Luma" },
      { url: "https://lu.ma/online1", title: "Founder AMA, online · Luma" },
      { url: "https://lu.ma/past2", title: "Founder dinner, past · Luma" },
      { url: "https://lu.ma/soon1", title: "Founder coffee in 30 minutes · Luma" },
    ],
    pages: {
      ...FEED_PAGES,
      mixer1: page({ startAt: at(40), apiId: "evt-mixer1" }),
      chicago1: page({ startAt: at(44), city: "Chicago", apiId: "evt-chi1" }),
      oak1: page({ startAt: at(46), city: "Oakland", apiId: "evt-oak1" }),
      online1: page({ startAt: at(60), city: null, online: true, apiId: "evt-online1" }),
      past2: page({ startAt: at(-24 * 30), apiId: "evt-past2" }),
      soon1: page({ startAt: at(0.5), apiId: "evt-soon1" }),
    },
  });
  const r = await search();
  const got = links(r);
  check("the feed's two events are all still there, once each (Exa's copy of feed1 is dropped)", got.filter((u) => u === "https://lu.ma/feed1").length === 1 && got.includes("https://lu.ma/feed2"), got);
  check("Exa's mixer, the Oakland dinner (nearby) and the online AMA are added", ["https://lu.ma/mixer1", "https://lu.ma/oak1", "https://lu.ma/online1"].every((u) => got.includes(u)), got);
  check("a Chicago event Exa found is filtered out for San Francisco by the same nearby test as a feed event", !got.includes("https://lu.ma/chicago1"), got);
  check("a past one never reaches the search", !got.includes("https://lu.ma/past2") && !r.turnedAway.some((g) => g.url === "https://lu.ma/past2"), { got, turnedAway: r.turnedAway });
  check("one starting in 30 minutes goes through #229's start check like a feed event: turned away, with why", !got.includes("https://lu.ma/soon1") && r.turnedAway.some((g) => g.url === "https://lu.ma/soon1" && g.reasons.some((x) => /too soon/.test(x))), r.turnedAway);
  const mixer = r.candidates.find(({ match }) => "url" in match && match.url === "https://lu.ma/mixer1")?.match as any;
  check("Exa's event goes out as a Luma link, tier 2, a public event, with its Luma id and the details from its page", mixer?.tier === 2 && mixer?.kind === "public_event" && mixer?.event_api_id === "evt-mixer1" && mixer?.details?.startAt === world.pages.mixer1.startAt && mixer?.reason === "A public event.", mixer);
  check("the log: what Exa added, counts only, not the want", r.viaExa?.added === 5 && r.viaExa?.nearby === 4 && r.viaExa?.offered === 3 && logs.length === 1 && logs[0].decision === "luma.via_exa" && logs[0].proposal.added === 5 && logs[0].proposal.feed === 2 && !JSON.stringify(logs[0]).includes("founder"), { viaExa: r.viaExa, logs });
}
{
  // Feed-only baseline for the next two.
  reset({ feed: FEED, pages: FEED_PAGES });
  const alone = links(await search({ configured: false }));
  for (const [label, how] of [
    ["Exa timed out", { w: { exa: "error" as const } }],
    ["Exa threw", { w: { exa: new Error("socket hang up") } }],
    ["the whole Exa step threw", { via: async () => { throw new Error("boom"); } }],
  ] as const) {
    reset({ feed: FEED, pages: FEED_PAGES, ...((how as any).w ?? {}) });
    const r = await search((how as any).via ? { viaExa: (how as any).via } : {}).catch((err) => ({ threw: String(err?.message ?? err) }) as any);
    check(`${label}: the feed's results are exactly what the feed alone gives, never fewer (and the search never throws)`, alone.length === 2 && !r.threw && JSON.stringify(links(r)) === JSON.stringify(alone), r.threw ? { threw: r.threw } : { alone, got: links(r) });
  }
  // The ranking reads at most 40: a feed with 45 in the window still lets Exa's in.
  const big = Array.from({ length: 45 }, (_, i) => ({ api_id: `evt-f${i}`, name: `Feed event ${i}`, start_at: at(24 + i), city: "San Francisco", url: `https://lu.ma/f${i}` }));
  reset({ feed: big, exa: [{ url: "https://lu.ma/mixer1", title: "GP/LP mixer" }], pages: { mixer1: page({ startAt: at(40) }) } });
  let pool: string[] = [];
  const s = await T.eventCandidates("founder dinners", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, sources: { ...sources(), rank: (async (events: any[]) => { pool = events.map((e) => e.url); return { ranked: [], closest: null }; }) as any } });
  check("a full feed (45 in the window) doesn't push Exa's event out of what the ranking reads", pool[0] === "https://lu.ma/mixer1" && pool.length === 46 && s.viaExa?.added === 1, pool.slice(0, 3));
}

// ================================================================ a host's private or unlisted event never goes out through Exa
{
  reset({
    feed: FEED,
    exa: [
      { url: "https://lu.ma/pub1", title: "Founder dinner (public) · Luma" },
      { url: "https://lu.ma/priv1", title: "Robot Wave Founder Dinner · Luma" },
      { url: "https://lu.ma/unl1", title: "Members-only founder breakfast · Luma" },
      { url: "https://lu.ma/unk1", title: "A page with no visibility · Luma" },
    ],
    pages: {
      ...FEED_PAGES,
      pub1: page({ startAt: at(40), apiId: "evt-pub1" }),
      // lu.ma/45r1tqno, read 2026-10-17: a real SF founder dinner Exa found, listed by its host as "private".
      priv1: page({ startAt: at(42), apiId: "evt-priv1", visibility: "private" }),
      unl1: page({ startAt: at(44), apiId: "evt-unl1", visibility: "members-only" }),
      unk1: page({ startAt: at(46), apiId: "evt-unk1", visibility: null }),
    },
  });
  const r = await search();
  const got = links(r);
  check("a private event Exa found never reaches the search (its page says private)", !got.includes("https://lu.ma/priv1") && !r.turnedAway.some((g) => g.url === "https://lu.ma/priv1"), got);
  check("...nor one listed for members only", !got.includes("https://lu.ma/unl1"), got);
  check("...nor one whose page doesn't say (unknown is not public: fails closed)", !got.includes("https://lu.ma/unk1"), got);
  check("...the public one goes out, and the feed's events are untouched", got.includes("https://lu.ma/pub1") && got.includes("https://lu.ma/feed1") && got.includes("https://lu.ma/feed2"), got);
  check("...and the log counts the three dropped as not public", r.viaExa?.notPublic === 3 && r.viaExa?.kept === 1 && logs[0]?.proposal?.notPublic === 3, r.viaExa);
  const parse = (v: unknown) => D.parseLumaEventPage(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { event: { api_id: "evt-x", start_at: at(40), ...(v === undefined ? {} : { visibility: v }) } } } } } })}</script></html>`)?.visibility;
  check("a Luma page's visibility is read as written, and missing is null", parse("public") === "public" && parse("private") === "private" && parse(undefined) === null);
}

// ================================================================ the reply's event searches are capped per turn, like web searches
{
  const L = await import("../../src/agent/loopTools.js");
  const { LOOP_BUDGET } = await import("../../src/agent/loop.js");
  // No network at all here: the feed, the calendar and the openings fail, so each search is empty and costs nothing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network in this test"); }) as any;
  const ctx = { userId: "u", phoneNumber: "+14155550101", resolvedContent: "Anything this weekend?", isVoice: false, dryRun: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any;
  const loop = L.newLoopState(Date.now());
  const tools = L.loopTools(ctx, { sent: false, sentMessages: [] }, loop, () => {}) as any;
  const results: any[] = [];
  for (let i = 0; i < LOOP_BUDGET.eventSearches + 1; i++) results.push(await tools.searchEvents.execute({ what: `founder dinners ${i}`, when: "this weekend" }, { toolCallId: String(i), messages: [] }).catch((e: any) => ({ threw: String(e) })));
  globalThis.fetch = realFetch;
  const last = results[results.length - 1];
  check(`the reply runs ${LOOP_BUDGET.eventSearches} event searches a turn; the next is refused, saying what to do instead`, LOOP_BUDGET.eventSearches === 3 && results.slice(0, 3).every((r) => r.ok === true) && last.ok === false && /No event searches left this turn \(3 used\): work with the events you already have, or try webSearch\./.test(last.error), results.map((r) => JSON.stringify(r).slice(0, 120)));
  check("the sweep's note says 'Luma is thin' once Exa added any, 'the feed is thin' when it's the feed's alone (pinned)", /note: r\.inWindow < 4 \? `\$\{r\.viaExa\?\.nearby \? "Luma is" : "The feed is"\} thin here; webSearch may find more\.`/.test(src("services/sweepFind.ts")));
}

// ================================================================ errors say what failed and the fix; the member's results don't change
{
  const reasonFor = async (exa: any) => {
    reset({ feed: FEED, pages: FEED_PAGES });
    const via = async (what: string, city: string | null, opt: any) => V.lumaEventsViaExa(what, city, { ...opt, deps: { ...viaDeps(), exa } });
    const r = await search({ viaExa: via });
    return { reason: logs.find((l) => l.decision === "luma.via_exa")?.reason ?? null, links: links(r) };
  };
  const fail = (error: string) => async () => ({ pages: [], cost: null, error });
  const cases: [string, any, RegExp][] = [
    ["timed out", fail("Exa timed out"), /^Exa timed out \(no answer in 10s\); tier 2 went out from Luma's feed alone; the next search for this want asks Exa again/],
    ["a refused key", fail("Exa 401 INVALID_API_KEY"), /^Exa refused the key \(HTTP 401 INVALID_API_KEY\): check EXA_API_KEY on this service; tier 2 went out from Luma's feed alone$/],
    ["out of credit", fail("Exa 402"), /^Exa says the account is out of credit \(HTTP 402\): add credit in Exa's dashboard/],
    ["rate-limited", fail("Exa 429"), /^Exa rate-limited the search \(HTTP 429\)/],
    ["Exa's own outage", fail("Exa 503"), /^Exa's own side failed \(HTTP 503\)/],
    ["a bad request", fail("Exa 400 INVALID_REQUEST"), /^Exa rejected the request \(HTTP 400 INVALID_REQUEST\): the request services\/lumaViaExa\.ts builds needs fixing/],
    ["unreachable", fail("Exa couldn't be reached"), /^Exa couldn't be reached \(network\): check this service's outbound connection to api\.exa\.ai/],
    ["an unreadable reply", fail("Exa sent a reply that couldn't be read"), /^Exa answered with a reply that couldn't be read/],
    ["a throw", async () => { throw new Error("socket hang up"); }, /^the Luma search through Exa threw \(socket hang up\); tier 2 went out from Luma's feed alone$/],
  ];
  for (const [label, exa, want] of cases) {
    const { reason, links: got } = await reasonFor(exa);
    check(`Exa ${label}: the log's reason says exactly that, with its fix; the member gets the feed's events unchanged`, want.test(reason ?? "") && got.join() === "https://lu.ma/feed1,https://lu.ma/feed2", { reason, got });
  }
  reset({ feed: FEED, pages: FEED_PAGES });
  await search({ viaExa: async () => { throw new Error("boom"); } });
  check("the whole Exa step throwing is logged too, saying so", /^the Luma search through Exa threw \(boom\)/.test(logs[0]?.reason ?? ""), logs);
  check("a search that worked has no reason", V.exaFailureReason(null) === null);
}

// ================================================================ what Cue's model reads: the same lines, the same limit
{
  reset({
    feed: FEED,
    exa: [{ url: "https://lu.ma/mixer1", title: "Register: GP/LP mixer (SF) | Luma" }],
    pages: { ...FEED_PAGES, mixer1: page({ startAt: at(40), apiId: "evt-mixer1", name: "GP/LP Mixer at AngelList", venue: "AngelList", address: "45 Fremont St, San Francisco", hosts: ["Ada"], price: "free" }) },
  });
  const r = await search();
  const c = r.candidates.find(({ match }) => "url" in match && match.url === "https://lu.ma/mixer1");
  check("an Exa-found event is named as its own page names it, not by Exa's page title", c?.match.name === "GP/LP Mixer at AngelList", c?.match.name);
  check("its lines are the feed's lines: the same renderer on its own page (name, start, place, host, price), nothing else", JSON.stringify(c?.lines) === JSON.stringify(D.renderEventDetails("GP/LP Mixer at AngelList", world.pages.mixer1)) && /starts .* at /.test(c?.lines[0] ?? "") && c!.lines.some((l) => /is at AngelList, 45 Fremont St/.test(l)), c?.lines);
  check("no internal ids in what the model reads (no evt-, no luma: ids) and the link is the plain Luma one", !/evt-|luma:/.test(JSON.stringify(r.candidates.map((x) => x.lines))) && ("url" in c!.match && c!.match.url === "https://lu.ma/mixer1"));
  const lt = src("agent/loopTools.ts");
  check("the reply's tool gives the model name, link, own-event flag and lines per event, no ids (pinned)", /return \{ name: match\.name, link: url \|\| null, ownEvent: match\.tier === 1, details: lines \};/.test(lt));
  check("the reply's count says 'on Luma' once Exa added any nearby, 'in the feed' when it's the feed's alone (pinned)", /\$\{r\.inWindow\} events \$\{r\.viaExa\?\.nearby \? "on Luma" : "in the feed"\}/.test(lt) && /\$\{r\.viaExa\?\.nearby \? "Luma" : "The feed"\} is thin here/.test(lt));
}
{
  // A full feed: 20 events in the window. With Exa's 3 more, the reply still gets the same number of events (the limit), not more.
  const feed = Array.from({ length: 20 }, (_, i) => ({ api_id: `evt-f${i}`, name: `Feed event ${i}`, start_at: at(24 + i), city: "San Francisco", url: `https://lu.ma/f${i}` }));
  const pages = Object.fromEntries(feed.map((e, i) => [`f${i}`, page({ startAt: e.start_at, apiId: e.api_id, description: "x".repeat(400) })]));
  reset({ feed, pages: { ...pages, x1: page({ startAt: at(30) }), x2: page({ startAt: at(31) }), x3: page({ startAt: at(32) }) }, exa: [1, 2, 3].map((n) => ({ url: `https://lu.ma/x${n}`, title: `Exa event ${n}` })) });
  const withExa = await search();
  reset({ feed, pages });
  const alone = await search({ exaOn: false });
  const lines = (r: any) => r.candidates.reduce((n: number, c: any) => n + c.lines.length, 0);
  check("same limit: with Exa the reply gets 8 events, as from the feed alone (Exa's take places, they don't add any)", withExa.candidates.length === 8 && alone.candidates.length === 8 && withExa.candidates.filter(({ match }) => /\/x\d$/.test((match as any).url)).length === 3, { withExa: links(withExa), alone: links(alone) });
  check("...and no more lines in the model's context than the feed's eight would give", lines(withExa) <= lines(alone), { withExa: lines(withExa), alone: lines(alone) });
}

// ================================================================ calls skip it
{
  reset({ feed: FEED, pages: { ...FEED_PAGES, mixer1: page({ startAt: at(40) }) }, exa: [{ url: "https://lu.ma/mixer1", title: "GP/LP mixer" }] });
  const r = await search({ exaOn: false });
  check("viaExa: false (a call): no Exa search, the feed's events only, nothing logged", exaCalls.length === 0 && links(r).join() === "https://lu.ma/feed1,https://lu.ma/feed2" && r.viaExa === null && logs.length === 0, { exaCalls, links: links(r) });
  check("calls (voiceFinds) pass viaExa: false; replies, tasks and the sweep leave it on (pinned)",
    /eventCandidates\(what, city, \{ when: brief\?\.when \?\? null, userId, limit: 5, viaExa: false \}\)/.test(src("services/voiceFinds.ts")) &&
    /eventCandidates\(what, city \?\? ctx\.turn\?\.profile\?\.city \?\? null, \{ when: when \?\? null, userId: ctx\.userId, limit: 8 \}\)/.test(src("agent/loopTools.ts")) &&
    /eventCandidates\(what, person\.city \?\? null, \{ when: when \?\? null, userId, timezone: zone, limit: 6 \}\)/.test(src("services/taskTurn.ts")) &&
    /eventCandidates\(what, c\.city, \{ when: when \?\? null, userId: c\.userId, timezone: opts\.timezone \?\? null, limit: 8 \}\)/.test(src("services/sweepFind.ts")));
}

check("the sweep's own log (sweep.find) carries what Exa added on each of its event searches (pinned)", /if \(r\.viaExa\) exaAdded\.push\(\{ added: r\.viaExa\.added, offered: r\.viaExa\.offered/.test(src("services/sweepFind.ts")) && /\.\.\.\(exaAdded\.length \? \{ exaAdded \} : \{\}\) \} \}\)/.test(src("services/sweepFind.ts")));

// ================================================================ the Exa request itself, and Luma's page id
{
  let body: any = null;
  const fetchImpl = (async (_u: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [{ url: "https://luma.com/mixer1?utm_source=exa&utm_medium=x", title: "GP/LP mixer · Luma" }], costDollars: { total: 0.022 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  const r = await X.exaSearch("founder dinners in San Francisco", { purpose: "luma_events", pages: V.LUMA_VIA_EXA.results, text: false, includeDomains: V.LUMA_DOMAINS, fetchImpl, env: { EXA_API_KEY: "k" } as any });
  check("Exa is asked for 25 results on lu.ma and luma.com, with no page text", body?.numResults === 25 && JSON.stringify(body?.includeDomains) === '["lu.ma","luma.com"]' && body?.contents === undefined, body);
  check("...and its links come back without tracking tags (#235), so the slug and the link are clean", r.pages[0]?.url === "https://luma.com/mixer1" && V.lumaEventSlug(r.pages[0].url) === "mixer1", r.pages);
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { event: { api_id: "evt-r6tazveGHPqyaFv", name: " ElevenLabs Funded Founders Three Course Private Dinner ", start_at: "2026-10-23T01:00:00.000Z", geo_address_info: { city: "San Francisco" } } } } } } })}</script></html>`;
  check("a Luma page gives its event id (the feed's evt- id), so the same event is one event however it was found", D.parseLumaEventPage(html)?.apiId === "evt-r6tazveGHPqyaFv");
  check("...and its own name, trimmed", D.parseLumaEventPage(html)?.name === "ElevenLabs Funded Founders Three Course Private Dinner");
}

console.log(`luma via exa: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
