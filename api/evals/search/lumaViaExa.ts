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
// Google's geocoder never answers in layer 1 (it used to reach maps.googleapis.com with the placeholder key and fail there; the
// outside-socket guard now refuses that): it fails the same way here, with no network.
(await import("../../src/services/geocoding.js")).geoDeps.google = async () => { throw new Error("layer 1: no geocoder"); };
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
// A page read: only the feed's events may be read this way. Every read is counted, so a test can say an Exa-found event never was.
let pageReads: string[] = [];
const pageDep = async (url: string) => {
  pageReads.push(url);
  return world.pages[V.lumaEventSlug(url) ?? ""] ?? null;
};
// Luma's official API, answered from the same world: a slug in world.pages is a public Luma event Luma's API knows; "refused" is a
// 429; "calendar:..." is a calendar page. The event's API record is built from the page fixture (its visibility, place, times).
let apiCalls: string[] = [];
const idOf = (slug: string) => world.pages[slug]?.apiId ?? `evt-${slug}`;
const lookupDep = async (slug: string): Promise<any> => {
  apiCalls.push(`lookup ${slug}`);
  const p = world.pages[slug];
  if (p === "refused") return "refused";
  if (p === "limited") return "limited";
  if (typeof p === "string" && p.startsWith("calendar:")) return { type: "calendar", id: p.slice(9) };
  if (!p) return null;
  // lookupStartAt: what the lookup says, when a test needs it to differ from the event's own record (a start the host moved).
  return { type: "event", id: idOf(slug), slug, startAt: p.lookupStartAt !== undefined ? p.lookupStartAt : p.startAt, endAt: p.endAt };
};
const eventDep = async (id: string): Promise<any> => {
  apiCalls.push(`event ${id}`);
  const slug = Object.keys(world.pages).find((k) => idOf(k) === id);
  const p = slug ? world.pages[slug] : null;
  if (!p || typeof p === "string") return null;
  return {
    id, name: p.name ?? "", slug, startAt: p.startAt, endAt: p.endAt, timezone: p.timezone, visibility: p.visibility ?? null,
    locationType: "locationType" in p ? p.locationType : (p.online ? "zoom" : p.city ? "offline" : "missing"), locationVisibility: p.addressHidden || !(p.venue || p.address) ? "guests-only" : "public",
    city: p.city ?? null, address: p.venue ?? null, fullAddress: p.address ?? null, hosts: p.hosts ?? [], description: p.description ?? null,
    registrationOpen: p.soldOut ? false : true, requireApproval: p.requiresApproval ?? null, spotsRemaining: p.spotsRemaining ?? null,
  };
};
// The daily budget: every reservation, with its share; room unless a test says otherwise. Luma isn't refusing unless a test says so.
let reserves: { userId: string | null; source: string }[] = [];
let budgetSays: { ok: boolean; reason: string | null } = { ok: true, reason: null };
let lumaRefusing = false;
const reserveDep = async (userId: string | null, source: string) => {
  reserves.push({ userId, source });
  return budgetSays;
};
// Luma's catalog of discover cities, as lu.ma/discover publishes it (names, slugs, coordinates).
const CATALOG = [
  { apiId: "discplace-sf", name: "San Francisco", slug: "sf", lat: 37.7749, lng: -122.4194 },
  { apiId: "discplace-chi", name: "Chicago", slug: "chicago", lat: 41.8781, lng: -87.6298 },
  { apiId: "discplace-la", name: "Los Angeles", slug: "la", lat: 34.0522, lng: -118.2437 },
  { apiId: "discplace-nyc", name: "New York", slug: "nyc", lat: 40.7128, lng: -74.006 },
];
const placeDep = async (city: string | null) => V.catalogCity(CATALOG, city);
const viaDeps = (configured = true) => ({ exa: exaDep, lookup: lookupDep, event: eventDep, lumaApi: () => true, configured: () => configured, now: () => new Date(), refusing: () => lumaRefusing, pauseMinutes: 10, reserve: reserveDep, place: placeDep });
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
  pageReads = [];
  apiCalls = [];
  reserves = [];
  budgetSays = { ok: true, reason: null };
  lumaRefusing = false;
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
  check("...the report counts it: 5 event links (Discover and a repeat aren't), 4 Luma knows, 3 over or outside the window by the lookup alone, 1 read, 1 kept", r?.report.pages === 5 && r?.report.looked === 4 && r?.report.past === 3 && r?.report.read === 1 && r?.report.kept === 1 && r?.report.cached === false, r?.report);
  check("...and the 3 the lookup showed over or outside the window were never read further (one events/get, for the kept one)", apiCalls.filter((c) => c.startsWith("event ")).length === 1 && apiCalls.filter((c) => c.startsWith("lookup ")).length === 5 && pageReads.length === 0, apiCalls);
  check("the search is built from fixed parts only: the kinds, the city (dates not in Cue's own form are left out)", exaCalls[0] === "startup founder, dinner events in San Francisco", exaCalls);
}

// ================================================================ what Luma's API says decides
{
  reset({
    exa: [
      { url: "https://lu.ma/moved1", title: "Moved dinner" },
      { url: "https://lu.ma/nodate1", title: "No date at lookup" },
      { url: "https://lu.ma/acal", title: "A calendar" },
      { url: "https://lu.ma/noplace1", title: "Nowhere dinner" },
      { url: "https://lu.ma/online2", title: "Online talk" },
    ],
    pages: {
      // The lookup still had the old date; the event's own record says it moved to last week.
      moved1: page({ startAt: at(-24 * 7), lookupStartAt: at(40) }),
      // The lookup gave no start; the record says it's past.
      nodate1: page({ startAt: at(-3), lookupStartAt: null }),
      acal: "calendar:cal-abc",
      noplace1: page({ startAt: at(40), city: null }),
      online2: page({ startAt: at(42), city: null, online: true }),
    },
  });
  const r = await V.lumaEventsViaExa("founder dinners", "San Francisco", { inRange: () => true, dates: "October 20 to October 26, 2026", deps: viaDeps() });
  const got = r?.events.map((e) => e.url) ?? [];
  check("a start the event's own record moved into the past drops it, whatever the lookup said", !got.includes("https://lu.ma/moved1") && !got.includes("https://lu.ma/nodate1"), got);
  check("a calendar link is skipped (counted), and never read as an event", r?.report.calendars === 1 && !apiCalls.includes("event cal-abc"), { report: r?.report, apiCalls });
  check("no place and not online: dropped and counted; online with no city: kept", r?.report.noLocation === 1 && !got.includes("https://lu.ma/noplace1") && got.includes("https://lu.ma/online2"), { got, report: r?.report });
}

{
  // Review of a0285221: a location type outside Luma's online platforms ("tba", "unknown") was read as online and said "is online".
  reset({
    exa: ["tba1", "unk1", "zoom1", "tbacity1", "unkcity1", "nulltype1", "off1"].map((s) => ({ url: `https://lu.ma/${s}`, title: s })),
    pages: {
      tba1: page({ startAt: at(40), city: null, locationType: "tba" }),
      unk1: page({ startAt: at(41), city: null, locationType: "unknown" }),
      zoom1: page({ startAt: at(42), city: null, locationType: "zoom" }),
      tbacity1: page({ startAt: at(43), city: "San Francisco", locationType: "tba" }),
      unkcity1: page({ startAt: at(44), city: "San Francisco", locationType: "unknown" }),
      nulltype1: page({ startAt: at(45), city: "San Francisco", locationType: null }),
      off1: page({ startAt: at(46), city: "San Francisco", locationType: "offline" }),
    },
  });
  const r = await V.lumaEventsViaExa("founder dinners", "San Francisco", { inRange: () => true, dates: "October 20 to October 26, 2026", deps: viaDeps() });
  const by = (u: string) => r?.events.find((e) => e.url === `https://lu.ma/${u}`);
  check("a location type Luma doesn't name as an online platform ('tba', 'unknown') with no city: dropped and counted, never 'online'", !by("tba1") && !by("unk1"), r?.report);
  check("...zoom with no city is online; 'offline' with a city is in that city, not online", by("zoom1")?.online === true && by("zoom1")?.details.online === true && !!by("off1") && !by("off1")?.online && by("off1")?.details.online === false && by("off1")?.city === "San Francisco", r?.events.map((e) => [e.url, e.online]));
  // The "unknown" ruling (2026-10-23): a place that can't be confirmed is never offered as in the member's city, even with a city.
  check("...'unknown', 'tba' or no type WITH a city: dropped and counted (place unconfirmed), never offered as in that city", !by("unkcity1") && !by("tbacity1") && !by("nulltype1") && r?.report.noLocation === 5 && r?.report.kept === 2, r?.report);
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
  check("the log: what Exa added, counts only, not the want", r.viaExa?.added === 5 && r.viaExa?.nearby === 4 && r.viaExa?.offered === 3 && logs.length === 1 && logs[0].decision === "luma.via_exa" && logs[0].proposal.added === 5 && logs[0].proposal.feed === 2 && !JSON.stringify(logs[0]).includes("founder dinners") && (logs[0].proposal.kinds ?? []).every((k: string) => V.EVENT_KINDS.some((x) => x.kind === k)), { viaExa: r.viaExa, logs });
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
  // A call's turn (isVoice) never runs Exa; a text turn does. Exa is "configured" here and answered by a stub that counts its calls.
  const exaCalls: string[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    // Luma's city catalog (lumaDiscovery.ts discoverPlaces): one city it confirms. With no confirmed place there's no Exa search.
    if (String(u?.url ?? u) === "https://lu.ma/discover") {
      const data = { props: { pageProps: { initialData: { places: [{ api_id: "discplace-sf", name: "San Francisco", slug: "sf", coordinate: { latitude: 37.77, longitude: -122.42 } }] } } } };
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (String(u?.url ?? u).startsWith("https://api.exa.ai/")) {
      exaCalls.push(JSON.parse(init?.body ?? "{}").query ?? "");
      return new Response(JSON.stringify({ results: [], costDollars: { total: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("no network in this test");
  }) as any;
  process.env.EXA_API_KEY = "test-key";
  process.env.LUMA_API_KEY = "test-luma-key";
  // The daily budget's lock and count, answered by a fake client: room for the search (nothing reaches a database).
  const { default: pool } = await import("../../src/db/db.js");
  const realConnect = (pool as any).connect;
  // Only the awaited form (the budget's): pg's own pool.query connects with a callback, and that keeps the real (dead) database.
  (pool as any).connect = function (cb?: any) {
    if (typeof cb === "function") return realConnect.call(pool, cb);
    return Promise.resolve({ query: async (sql: string) => ({ rows: /COUNT\(\*\)::int AS today/.test(sql) ? [{ today: 0 }] : [] }), release: () => {} });
  };
  const turn = async (isVoice: boolean, what: string) => {
    const L2 = L.loopTools({ ...ctx, isVoice }, { sent: false, sentMessages: [] }, L.newLoopState(Date.now()), () => {}) as any;
    return L2.searchEvents.execute({ what, when: "this weekend", city: "San Francisco" }, { toolCallId: what, messages: [] }).catch((e: any) => ({ threw: String(e) }));
  };
  const voice = await turn(true, "jazz on a call");
  const onCall = exaCalls.length;
  const text = await turn(false, "jazz by text");
  delete process.env.EXA_API_KEY;
  delete process.env.LUMA_API_KEY;
  globalThis.fetch = realFetch;
  (pool as any).connect = realConnect;
  check("a call's searchEvents (isVoice) makes no Exa call; a text turn's does", voice.ok === true && onCall === 0 && text.ok === true && exaCalls.length === 1 && /^jazz events/.test(exaCalls[0]) && !/by text/.test(exaCalls[0]), { onCall, exaCalls, voice: JSON.stringify(voice).slice(0, 120) });
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
  check("its lines are the feed's renderer on what Luma's API gave (name, start, place, host), nothing else", JSON.stringify(c?.lines) === JSON.stringify(D.renderEventDetails("GP/LP Mixer at AngelList", (c!.match as any).details)) && /starts .* at /.test(c?.lines[0] ?? "") && c!.lines.some((l) => /is at AngelList, 45 Fremont St/.test(l)) && c!.lines.some((l) => /Hosted by Ada/.test(l)), c?.lines);
  reset({ feed: FEED, exa: [{ url: "https://lu.ma/hid1", title: "Supper" }, { url: "https://lu.ma/full1", title: "Closed dinner" }], pages: { ...FEED_PAGES, hid1: page({ startAt: at(40), name: "Supper", venue: "A home", address: "1 Private Rd, San Francisco", addressHidden: true }), full1: page({ startAt: at(41), name: "Closed dinner", soldOut: true }) } });
  const r2 = await search();
  const hid = r2.candidates.find(({ match }) => "url" in match && match.url === "https://lu.ma/hid1");
  check("an address the host shows only to guests is never in the lines (the city alone, as the event page does)", !!hid && !hid.lines.some((l) => /Private Rd|A home/.test(l)) && hid.lines.some((l) => /is in San Francisco; the exact address is only shown to registered guests/.test(l)), hid?.lines);
  check("registration closed (from the API) is turned away like a sold-out page, with why", !links(r2).includes("https://lu.ma/full1") && r2.turnedAway.some((g) => g.url === "https://lu.ma/full1"), r2.turnedAway);
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
    /eventCandidates\(what, where\.place, \{ when: when \?\? null, userId: ctx\.userId, limit: 8, viaExa: !ctx\.isVoice, source: "request" \}\)/.test(src("agent/loopTools.ts")) &&
    /eventCandidates\(what, person\.city \?\? null, \{ when: when \?\? null, userId, timezone: zone, limit: 6, source: "request" \}\)/.test(src("services/taskTurn.ts")) &&
    /eventCandidates\(what, c\.city, \{ when: when \?\? null, userId: c\.userId, timezone: opts\.timezone \?\? null, limit: 8, source: "sweep" \}\)/.test(src("services/sweepFind.ts")));
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
}

// ================================================================ Luma's API refusing (429): said, and the Exa search pauses
{
  reset({
    feed: FEED,
    exa: [1, 2, 3, 4, 5].map((n) => ({ url: `https://lu.ma/r${n}`, title: `Founder thing ${n}` })),
    pages: { ...FEED_PAGES, r1: page({ startAt: at(40) }), r2: page({ startAt: at(41) }), r3: "refused", r4: "refused", r5: "refused" },
  });
  const r = await search();
  check("Luma's API refused 3 of the 5 checks: the log says exactly that, and what happens next", r.viaExa?.refused === 3 && /^Luma's API refused 3 of 5 checks \(429\): those events couldn't be checked, so they were left out; the Luma search through Exa pauses for 10 minutes$/.test(logs[0]?.reason ?? ""), { viaExa: r.viaExa, reason: logs[0]?.reason });
  check("...the two it did serve still go out, and the feed's events are untouched", ["https://lu.ma/r1", "https://lu.ma/r2", "https://lu.ma/feed1", "https://lu.ma/feed2"].every((u) => links(r).includes(u)) && !links(r).includes("https://lu.ma/r3"), links(r));

  reset({ feed: FEED, pages: FEED_PAGES });
  const alone = links(await search({ exaOn: false }));
  reset({ feed: FEED, pages: { ...FEED_PAGES, good1: page({ startAt: at(40) }) }, exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }] });
  lumaRefusing = true;
  const s = await search();
  check("while Luma's API is refusing: no Exa search, no budget taken, no API checks", exaCalls.length === 0 && reserves.length === 0 && apiCalls.length === 0, { exaCalls, reserves, apiCalls });
  check("...logged with why, and the member's results are exactly the feed's", /^Luma's API refused a request \(429\) in the last 10 minutes, so no Luma search through Exa/.test(logs[0]?.reason ?? "") && JSON.stringify(links(s)) === JSON.stringify(alone), { reason: logs[0]?.reason, got: links(s), alone });
  // Our own per-minute stop: said apart from Luma's refusals.
  reset({ feed: FEED, exa: [{ url: "https://lu.ma/l1", title: "Founder dinner" }, { url: "https://lu.ma/l2", title: "Founder dinner 2" }], pages: { ...FEED_PAGES, l1: page({ startAt: at(40) }), l2: "limited" } });
  const lim = await search();
  check("a check left unread at our own per-minute stop is said as that, and the rest go out", lim.viaExa?.limited === 1 && /^1 of 2 were left unchecked at the per-minute stop: those events couldn't be checked, so they were left out$/.test(logs[0]?.reason ?? "") && links(lim).includes("https://lu.ma/l1"), { viaExa: lim.viaExa, reason: logs[0]?.reason });
  // No Luma API key: Exa isn't asked (its links couldn't be checked).
  reset({ feed: FEED, pages: FEED_PAGES, exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }] });
  const noApi = await search({ viaExa: (w: string, c: string | null, opt: any) => V.lumaEventsViaExa(w, c, { ...opt, deps: { ...viaDeps(), lumaApi: () => false } }) });
  check("no LUMA_API_KEY: no Exa call, no budget, the feed alone, and the log says how to turn it on", exaCalls.length === 0 && reserves.length === 0 && /^LUMA_API_KEY isn't set on this service, so Exa's Luma links can't be checked/.test(logs[0]?.reason ?? "") && JSON.stringify(links(noApi)) === JSON.stringify(alone), { reason: logs[0]?.reason });
}
{
  // Luma's official API client (services/luma.ts), against a fake fetch. The records are shaped like the live answers of 2026-10-19
  // (lu.ma/16nclyz5, a public event Noise doesn't manage: access "view"), with invented names and ids.
  const A = await import("../../src/services/luma.js");
  const env = { LUMA_API_KEY: "test-luma-key" } as any;
  const calls: string[] = [];
  let status = 200;
  const VIEW = {
    platform: "luma", id: "evt-test123", user_id: "usr-x", calendar_id: "cal-test", start_at: at(30), duration_interval: "PT3H", end_at: at(33), created_at: at(-200),
    timezone: "America/Los_Angeles", name: " Founders Dinner in San Francisco ", cover_url: "https://images.lumacdn.com/x.png", url: "https://luma.com/abc12xyz", visibility: "public",
    location_type: "offline", location_visibility: "guests-only", waitlist_status: "enabled", registration_open: true, require_approval: true, spots_remaining: 11, display_price: null,
    access: "view", geo_address_json: { address: "", city: "San Francisco", region: "California", country: "United States", city_state: "San Francisco, California", full_address: null },
    coordinate: { latitude: 37.77, longitude: -122.42 }, description: "A dinner for founders.", description_md: "A dinner for founders.", hosts: [{ name: "Noor" }, { name: "Ellis" }],
  };
  const fetchImpl = (async (u: any, init: any) => {
    const url = new URL(String(u));
    calls.push(`${url.pathname}?${url.searchParams} key=${init?.headers?.["x-luma-api-key"] ? "yes" : "no"}`);
    if (status !== 200) return new Response("{}", { status });
    if (url.pathname === "/v1/entities/lookup") {
      const slug = url.searchParams.get("slug");
      if (slug === "abc12xyz") return new Response(JSON.stringify({ entity: { type: "event", event: { id: "evt-test123", name: "Founders Dinner", slug: "abc12xyz", cover_url: "x", start_at: VIEW.start_at, end_at: VIEW.end_at } } }), { status: 200 });
      if (slug === "somecal") return new Response(JSON.stringify({ entity: { type: "calendar", calendar: { id: "cal-test", name: "A calendar", slug: "somecal", avatar_url: null } } }), { status: 200 });
      return new Response(JSON.stringify({ entity: null }), { status: 200 });
    }
    if (url.pathname === "/v1/events/get") return new Response(JSON.stringify(VIEW), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as any;
  A.resetLumaPublicApi();
  const ent = await A.lookupLumaEntity("abc12xyz", { fetchImpl, env });
  check("lookup: GET public-api /v1/entities/lookup?slug=, with the key, gives the event's id, slug, start and end", JSON.stringify(ent) === JSON.stringify({ type: "event", id: "evt-test123", slug: "abc12xyz", startAt: VIEW.start_at, endAt: VIEW.end_at }) && calls[0] === "/v1/entities/lookup?slug=abc12xyz key=yes", { ent, calls });
  await A.lookupLumaEntity("abc12xyz", { fetchImpl, env });
  check("...the same slug again is cached (no second request)", calls.length === 1, calls);
  const cal = await A.lookupLumaEntity("somecal", { fetchImpl, env });
  const none = await A.lookupLumaEntity("nothing-here", { fetchImpl, env });
  check("...a calendar is said as a calendar; an unknown slug is nothing", (cal as any)?.type === "calendar" && none === null);
  const ev = await A.getPublicLumaEvent("evt-test123", { fetchImpl, env });
  check("events/get: GET /v1/events/get?event_id=, read into the visitor's fields (name trimmed, city, guests-only address, hosts, registration)", !!ev && typeof ev !== "string" && ev.name === "Founders Dinner in San Francisco" && ev.slug === "abc12xyz" && ev.visibility === "public" && ev.locationType === "offline" && ev.locationVisibility === "guests-only" && ev.city === "San Francisco" && ev.fullAddress === null && JSON.stringify(ev.hosts) === '["Noor","Ellis"]' && ev.spotsRemaining === 11 && ev.registrationOpen === true && calls.includes("/v1/events/get?event_id=evt-test123 key=yes"), ev);
  const n0 = calls.length;
  await A.getPublicLumaEvent("evt-test123", { fetchImpl, env });
  check("...read again within the hour: cached", calls.length === n0);
  check("...and nothing in this client reads an event's page (only public-api.luma.com)", calls.every((c) => c.startsWith("/v1/")));
  // A 429 is said as refused, pauses for 10 minutes, and isn't cached.
  A.resetLumaPublicApi();
  status = 429;
  const r429 = await A.lookupLumaEntity("abc12xyz", { fetchImpl, env });
  check("a 429: 'refused', and Luma's API counts as refusing for 10 minutes", r429 === "refused" && A.lumaApiRefusedRecently() === true && A.lumaApiRefusedRecently(Date.now() + 11 * 60_000) === false && A.LUMA_PUBLIC_API.refusalPauseMinutes === 10);
  status = 200;
  const after429 = await A.lookupLumaEntity("abc12xyz", { fetchImpl, env });
  check("...a refusal isn't cached: the next ask asks again", (after429 as any)?.type === "event");
  // Our own per-minute stop, below Luma's 200 a minute (the key is shared with Noise's own calendar calls).
  A.resetLumaPublicApi();
  const t = Date.now();
  let limited = 0;
  for (let i = 0; i < A.LUMA_PUBLIC_API.perMinute + 5; i++) if ((await A.lookupLumaEntity(`s${i}`, { fetchImpl, env, now: () => t })) === "limited") limited++;
  check(`no more than ${A.LUMA_PUBLIC_API.perMinute} API calls a minute (under Luma's 200); the rest are 'limited', not sent`, A.LUMA_PUBLIC_API.perMinute === 150 && limited === 5);
  const later = await A.lookupLumaEntity("s-later", { fetchImpl, env, now: () => t + 61_000 });
  check("...a minute later there's room again", later === null);
  A.resetLumaPublicApi();
  check("no LUMA_API_KEY: nothing is sent ('off')", (await A.lookupLumaEntity("abc12xyz", { fetchImpl, env: {} as any })) === "off" && !A.lumaApiConfigured({} as any) && A.lumaApiConfigured(env));
  A.resetLumaPublicApi();
}
{
  // No per-event page reads anywhere on this path: through the whole search, with the real ranking (its embeddings stubbed), every
  // fetch counted. Exa's events are checked through the API only; nothing reads lu.ma or luma.com.
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u?.url ?? u);
    hosts.push(new URL(url).host);
    if (/api\.openai\.com/.test(url)) {
      const body = JSON.parse(init?.body ?? "{}");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ object: "list", data: inputs.map((_: unknown, index: number) => ({ object: "embedding", index, embedding: new Array(1536).fill(0.01) })), usage: { prompt_tokens: 0, total_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`no network in this test (${url})`);
  }) as any;
  const { rankEventsByDescription } = await import("../../src/services/eventRanking.js");
  reset({ feed: [], exa: [{ url: "https://lu.ma/apiev1", title: "Founder dinner" }, { url: "https://luma.com/apiev2", title: "Founder mixer" }], pages: { apiev1: page({ startAt: at(40), name: "Founder dinner" }), apiev2: page({ startAt: at(44), name: "Founder mixer" }) } });
  const r = await T.eventCandidates("founder dinners", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, sources: { ...sources(), rank: rankEventsByDescription } });
  globalThis.fetch = realFetch;
  check("through the whole search (real ranking): both Exa events go out, read from the API only, and no page is read anywhere", links(r).length === 2 && pageReads.length === 0 && !hosts.some((h) => /(^|\.)(lu\.ma|luma\.com)$/.test(h)) && apiCalls.filter((c) => c.startsWith("event ")).length === 2, { links: links(r), pageReads, hosts, apiCalls });
  check("the ranking and the gate take an Exa event's details from the API (pinned)", /\(c as \{ details\?: EventDetails \}\)\.details \? Promise\.resolve/.test(src("services/eventRanking.ts")) && /const details = "url" in m && m\.url \? \(fromApi\.get\(m\.url\) \?\? \(await src\.page\(m\.url\)/.test(src("services/tieredRecommendation.ts")));
  check("the Exa path's checks are Luma's official API, never a page read (pinned)", /lookup: d\.lookup \?\? \(\(slug\) => A\.lookupLumaEntity\(slug\)\)/.test(src("services/lumaViaExa.ts")) && /event: d\.event \?\? \(\(id\) => A\.getPublicLumaEvent\(id\)\)/.test(src("services/lumaViaExa.ts")) && !/fetchLumaEventDetails|readLumaEventPage|parseLumaEventPage/.test(src("services/lumaViaExa.ts")));
}

// ================================================================ the daily budget: 60 a day, 20 held for member asks
{
  check("the limits default to 60 a day and 20 held for member asks", V.LUMA_EXA_BUDGET.dailyCap === 60 && V.LUMA_EXA_BUDGET.requestReserve === 20);
  const b = (used: number, source: "request" | "sweep") => V.lumaExaBudget(used, source, 60, 20);
  check("the sweep runs to 40, then stops, saying the rest is held for member asks", b(39, "sweep").ok && !b(40, "sweep").ok && /the sweep's share of Luma searches through Exa is used \(40 of 60; the rest is held for member asks\); tier 2 went out from Luma's feed alone/.test(b(40, "sweep").reason ?? ""));
  check("member asks (replies, tasks) run to 60", b(40, "request").ok && b(59, "request").ok && !b(60, "request").ok && /^the daily cap of 60 Luma searches through Exa is reached; tier 2 went out from Luma's feed alone/.test(b(60, "request").reason ?? ""));
  check("past the cap both are refused", !b(75, "sweep").ok && !b(75, "request").ok);

  // The reservation itself, against a fake client: the lock, the count, the insert (who, which share; never the want).
  const sql: { q: string; p?: any[] }[] = [];
  const db = (today: number) => ({ connect: async () => ({ query: async (q: string, p?: any[]) => { sql.push({ q, p }); return { rows: /COUNT/.test(q) ? [{ today }] : [] }; }, release: () => {} }) });
  const yes = await V.reserveLumaExaSearch("u1", "request", db(0));
  const insert = sql.find((s) => /INSERT INTO luma_exa_search_log/.test(s.q));
  check("a reservation: one lock, the day's count, and one row of who and which share, committed", yes.ok && sql.some((s) => /pg_advisory_xact_lock\(hashtext\('luma_exa_search_budget'\)\)/.test(s.q)) && /INSERT INTO luma_exa_search_log \(user_id, source\) VALUES \(\$1, \$2\)/.test(insert?.q ?? "") && JSON.stringify(insert?.p) === '["u1","request"]' && sql.some((s) => s.q === "COMMIT"), sql);
  sql.length = 0;
  const full = await V.reserveLumaExaSearch("u1", "sweep", db(40));
  check("...the sweep at 40: refused, rolled back, nothing written", !full.ok && sql.some((s) => s.q === "ROLLBACK") && !sql.some((s) => /INSERT/.test(s.q)));
  const broken = await V.reserveLumaExaSearch("u1", "request", { connect: async () => { throw new Error("connect ECONNREFUSED"); } });
  check("the budget can't be checked: no Exa search (fails closed), saying why", !broken.ok && /^the daily budget for Luma searches through Exa couldn't be checked \(connect ECONNREFUSED\), so no Exa search; tier 2 went out from Luma's feed alone$/.test(broken.reason ?? ""), broken);
  // A test account (services/testMemberSpend.ts, #271): no slot taken, the database never touched, no Exa search.
  {
    const TM = await import("../../src/services/testMemberSpend.js");
    const TEST_ID = "00000000-0000-4000-8000-0000000000e1";
    const REAL_ID = "00000000-0000-4000-8000-0000000000e2";
    TM.setTestMemberLookupForTests(async (id) => ({ phone_number: null, archived_phone: null, archived_at: id === TEST_ID ? new Date() : null, live_test_id: null }));
    let touched = 0;
    const counting = { connect: async () => { touched++; return { query: async (q: string) => ({ rows: /COUNT/.test(q) ? [{ today: 0 }] : [] }), release: () => {} }; } };
    const testRes = await V.reserveLumaExaSearch(TEST_ID, "request", counting);
    check("a test account: refused before the budget, the database never touched, saying why", !testRes.ok && touched === 0 && testRes.reason === V.TEST_ACCOUNT && /tier 2 went out from Luma's feed alone$/.test(V.TEST_ACCOUNT), { testRes, touched });
    const realRes = await V.reserveLumaExaSearch(REAL_ID, "request", counting);
    check("...a real member still reserves as before", realRes.ok && touched === 1, { realRes, touched });
    TM.setTestMemberLookupForTests(null);
  }
  // No place the catalog confirms: no Exa search at all, and the report says so with its fix.
  {
    let searched = 0;
    const r = await V.lumaEventsViaExa("jazz", "Atlantis", { inRange: () => true, dates: "this weekend", deps: { ...viaDeps(), exa: async (...a: any[]) => (searched++, (exaDep as any)(...a)), reserve: async () => (searched++, { ok: true, reason: null }) } as any });
    check("no confirmed place: no reservation, no Exa search, the report says why and that the feed answered", !!r && r.events.length === 0 && searched === 0 && r.report.error === V.NO_PLACE && /tier 2 went out from Luma's feed alone$/.test(V.NO_PLACE), { r, searched });
  }
  // An online ask needs no place: with none confirmed it still searches, and keeps online events only (review of 87d07fc3).
  {
    reset({ exa: [{ url: "https://lu.ma/zoomtalk", title: "AI talk" }, { url: "https://lu.ma/inperson9", title: "AI talk IRL" }], pages: { zoomtalk: page({ startAt: at(30), city: null, online: true }), inperson9: page({ startAt: at(31), city: "Boise" }) } });
    const r = await V.lumaEventsViaExa("online AI talks", "Boise", { inRange: () => true, dates: "this week", deps: viaDeps() });
    const got = r?.events.map((e) => e.url) ?? [];
    check("an online ask with no confirmed place: one Exa search with no city, online events kept, in-person dropped", exaCalls.length === 1 && !/ in /.test(exaCalls[0]) && / online/.test(exaCalls[0]) && got.includes("https://lu.ma/zoomtalk") && !got.includes("https://lu.ma/inperson9"), { exaCalls, got, report: r?.report });
    reset({ exa: [{ url: "https://lu.ma/zoomtalk", title: "AI talk" }], pages: { zoomtalk: page({ startAt: at(30), city: null, online: true }) } });
    const down = await V.lumaEventsViaExa("jazz", "San Francisco", { inRange: () => true, dates: "this weekend", deps: { ...viaDeps(), place: async () => { throw new Error("catalog unreachable"); } } as any });
    check("the catalog can't be read: no search, and the report says that, not 'no city'", !!down && exaCalls.length === 0 && down.report.error === V.CATALOG_DOWN, { exaCalls, down });
    // A test account is refused before the shared cache: a real member asking the same thing still searches.
    const TM = await import("../../src/services/testMemberSpend.js");
    const TID = "00000000-0000-4000-8000-0000000000e3";
    TM.setTestMemberLookupForTests(async (id) => ({ phone_number: null, archived_phone: null, archived_at: id === TID ? new Date() : null, live_test_id: null }));
    reset({ exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }], pages: { good1: page() } });
    const t = await V.lumaEventsViaExa("founder dinners", "San Francisco", { userId: TID, inRange: () => true, dates: "this weekend", deps: viaDeps() });
    const real = await V.lumaEventsViaExa("founder dinners", "San Francisco", { userId: "00000000-0000-4000-8000-0000000000e4", inRange: () => true, dates: "this weekend", deps: viaDeps() });
    check("a test account: no Exa search, said; the same ask from a real member right after still searches", t?.report.error === V.TEST_ACCOUNT && exaCalls.length === 1 && (real?.events.length ?? 0) === 1, { t: t?.report, exaCalls, real: real?.report });
    TM.setTestMemberLookupForTests(null);
  }
  const mig = src("db/migrations.ts");
  check("the table: id, user, share, time, and no query column (pinned)", /CREATE TABLE IF NOT EXISTS luma_exa_search_log \(\n\s+id BIGSERIAL PRIMARY KEY,\n\s+user_id UUID REFERENCES users\(id\) ON DELETE CASCADE,\n\s+source TEXT NOT NULL,\n\s+created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)\n\s+\)/.test(mig) && /idx_luma_exa_search_log_created ON luma_exa_search_log \(created_at DESC\)/.test(mig));

  // Through the search: a hit cap is the feed alone, logged; a cache hit takes no slot; the share is the caller's.
  reset({ feed: FEED, pages: FEED_PAGES });
  const alone = links(await search({ exaOn: false }));
  reset({ feed: FEED, pages: { ...FEED_PAGES, good1: page({ startAt: at(40) }) }, exa: [{ url: "https://lu.ma/good1", title: "GP/LP mixer" }] });
  budgetSays = V.lumaExaBudget(60, "request", 60, 20);
  const capped = await search();
  check("the cap reached: no Exa call, the feed's results exactly, and the log says the cap", exaCalls.length === 0 && reserves.length === 1 && JSON.stringify(links(capped)) === JSON.stringify(alone) && /^the daily cap of 60 Luma searches through Exa is reached/.test(logs[0]?.reason ?? ""), { exaCalls, got: links(capped), reason: logs[0]?.reason });
  budgetSays = { ok: true, reason: null };
  const after = await search();
  check("...a refused search isn't kept: once there's room, the next ask searches", exaCalls.length === 1 && links(after).includes("https://lu.ma/good1"), links(after));
  const hit = await search();
  check("a cache hit makes no Exa call and takes no slot", exaCalls.length === 1 && reserves.length === 2 && hit.viaExa?.cached === true, { exaCalls, reserves });
  reset({ feed: FEED, pages: FEED_PAGES, exa: [] });
  await T.eventCandidates("supper clubs", "San Francisco", { userId: "u9", timezone: "America/Los_Angeles", limit: 8, source: "request", sources: sources() });
  await T.eventCandidates("gallery openings", "San Francisco", { userId: "u9", timezone: "America/Los_Angeles", limit: 8, sources: sources() });
  check("a member's ask draws on the request share; with none named, the sweep's (the stricter one)", reserves.map((x) => x.source).join() === "request,sweep" && reserves[0].userId === "u9", reserves);
}

// ================================================================ what Exa is sent: never their words (Royce, 2026-10-18, option (d))
{
  const D1 = "October 20 to October 26, 2026";
  const q = (w: string, city: string | null = "San Francisco", dates = D1) => V.lumaExaQuery(w, V.catalogCity(CATALOG, city), dates).query;
  const plan = "dinner with Jordan Lee to talk about her raise, somewhere quiet in the Mission";
  check("a private plan: only the kind of event, the city and the dates go to Exa", q(plan) === "dinner events in San Francisco, October 20 to October 26, 2026", q(plan));
  const adversarial: [string, RegExp][] = [
    [plan, /jordan|lee|raise|quiet|mission|talk/i],
    ["coffee with Priya Patel from Stripe about my Series A", /priya|patel|stripe|series|coffee/i],
    ["Ellis Park looking for founder dinners near his office", /ellis|park|office|looking/i],
    ["founder dinners, email me at ellis.park@example.com or text 415-555-0142", /ellis|example|415|555|0142|@/i],
    ["find a cofounder for my climate startup so I can quit my job by spring", /cofounder|quit|job|spring|find/i],
    ["something to take my mind off the divorce", /divorce|mind/i],
    ["AI meetups where I could meet Sam Altman", /sam|altman|could/i],
    ["supper club for my 40th birthday with Noor and the Acme Corp team", /noor|acme|corp|birthday|40th|team/i],
  ];
  for (const [w, bad] of adversarial) check(`"${w.slice(0, 50)}": none of their words reach Exa`, !bad.test(q(w)), q(w));
  // Every word of every query is one of the fixed parts: a kind, "events", "online"/"in person", the city, the dates.
  const allowed = new Set([...V.EVENT_KINDS.flatMap((k) => k.kind.toLowerCase().split(/[\s,]+/)), "events", "online", "in", "person", "san", "francisco", "to", "october", "20", "26", "2026"]);
  const strays = adversarial.flatMap(([w]) => q(w).toLowerCase().split(/[\s,]+/).filter((x) => x && !allowed.has(x)));
  check("every word sent is from the fixed parts (kinds, city, dates, online / in person)", strays.length === 0, strays);
  check("no kind on the list: plain events for the city and dates", q("something to take my mind off the divorce") === "events in San Francisco, October 20 to October 26, 2026");
  check("online or in person is said when they say it", q("virtual AI talks") === "AI, talk events online in San Francisco, October 20 to October 26, 2026" && q("in-person design workshops") === "design, workshop events in person in San Francisco, October 20 to October 26, 2026", [q("virtual AI talks"), q("in-person design workshops")]);
  check("a city that isn't in Luma's catalog is left out, and so are dates not in Cue's own form", q("jazz", "SF <script>") === "jazz events, October 20 to October 26, 2026" && q("jazz", "jordan@example.com") === "jazz events, October 20 to October 26, 2026" && q("jazz", "Chicago", "next Tuesday with Jordan") === "jazz events in Chicago", [q("jazz", "SF <script>"), q("jazz", "Chicago", "next Tuesday with Jordan")]);
  // The review of 14f6d2f8: a city slot that takes any place-shaped text sends a person, a home, a clinic. Only the catalog's name goes.
  const cities = ["Jordan's place", "Sarah Chen", "my ex's house", "Mount Sinai Hospital", "Betty Ford Center", "rehab in Malibu", "near my moms in Oakland", "Acme Corp HQ"];
  const noPoint = cities.map((c) => q("dinner", c));
  check("the review's 8 cities, by name: none is in Luma's catalog, so no city is sent at all", noPoint.every((x) => x === "dinner events, October 20 to October 26, 2026"), noPoint);
  // Geocoded to a point (the feed's own place lookup does this), the catalog's nearest city is named, never the string.
  const OAKLAND = { lat: 37.8044, lng: -122.2712 };
  const MALIBU = { lat: 34.0259, lng: -118.7798 };
  const nearSf = V.lumaExaQuery("dinner", V.catalogCity(CATALOG, "near my moms in Oakland", OAKLAND), D1).query;
  const nearLa = V.lumaExaQuery("dinner", V.catalogCity(CATALOG, "rehab in Malibu", MALIBU), D1).query;
  check("...near a catalog city, that city's catalog name is sent, never the words ('near my moms in Oakland' -> San Francisco, 'rehab in Malibu' -> Los Angeles)", nearSf === "dinner events in San Francisco, October 20 to October 26, 2026" && nearLa === "dinner events in Los Angeles, October 20 to October 26, 2026", [nearSf, nearLa]);
  const farAway = V.lumaExaQuery("dinner", V.catalogCity(CATALOG, "Sarah Chen", { lat: 0, lng: 0 }), D1).query;
  check("...and far from every catalog city, no city", farAway === "dinner events, October 20 to October 26, 2026", farAway);
  check("a catalog slug resolves to its name ('sf' -> San Francisco)", q("dinner", "sf") === "dinner events in San Francisco, October 20 to October 26, 2026" && q("dinner", "SAN FRANCISCO") === "dinner events in San Francisco, October 20 to October 26, 2026");
  check("a place that isn't a plain place name is never named, even from the catalog (the last line)", V.lumaExaQuery("jazz", { name: "SF <script>" }, D1).query === "jazz events, October 20 to October 26, 2026");
  check("'a pottery class' is a workshop; 'world-class' isn't", q("a pottery class") === "workshop events in San Francisco, October 20 to October 26, 2026" && q("a world-class dinner") === "dinner events in San Francisco, October 20 to October 26, 2026", [q("a pottery class"), q("a world-class dinner")]);
  check("dates need real month names (a name in a month's place is left out)", q("online talks", "San Francisco", "Jordan 1 to Lee 2, 2026") === "talk events online in San Francisco" && q("jazz", "Chicago", "October 20 to November 2, 2026") === "jazz events in Chicago, October 20 to November 2, 2026");
  check("'show me', 'state-of-the-art' and 'world-class' aren't live music, art or a workshop", q("show me something fun, world-class and state-of-the-art") === "events in San Francisco, October 20 to October 26, 2026" && q("live shows and art classes") === "workshop, live music, art events in San Francisco, October 20 to October 26, 2026", [q("show me something fun, world-class and state-of-the-art"), q("live shows and art classes")]);
  check("everyday words that look like a kind aren't one ('talk about', 'book a table', 'no energy', 'it runs late')", q("I want to talk about it, book a table, I have no energy and it runs late") === "events in San Francisco, October 20 to October 26, 2026", q("I want to talk about it, book a table, I have no energy and it runs late"));
  check("at most 3 kinds", V.lumaExaQuery("founder investor climate hardware AI meetups", { name: "San Francisco" }, D1).kinds.length === 3);
  check("the search itself names the city only through the catalog (pinned)", /const place = await deps\.place\(city\)\.catch\(\(\) => \(\(catalogDown = true\), null\)\);\n[\s\S]{0,500}?if \(!place && !onlineOnly\) return [^\n]*\n  const \{ query, kinds \} = lumaExaQuery\(what, place, o\.dates\);/.test(src("services/lumaViaExa.ts")) && /place: d\.place \?\? \(\(city\) => L\.discoverPlaceFor\(city\)\.then\(\(p\) => \(p \? \{ name: p\.name \} : null\)\)\)/.test(src("services/lumaViaExa.ts")));
  // The receipt's wants (search-compare q4, q5, q10), as Exa now gets them.
  const receipt: [string, string, string, string][] = [
    ["q4", "startup founder events and meetups", "October 19 to October 25, 2026", "startup founder, meetup events in San Francisco, October 19 to October 25, 2026"],
    ["q5", "climate tech or climate hardware founder meetups", "October 18 to November 30, 2026", "startup founder, climate tech, hardware events in San Francisco, October 18 to November 30, 2026"],
    ["q10", "intimate supper clubs or chef's table dinners", "October 20 to October 31, 2026", "supper club, chef's table dinner events in San Francisco, October 20 to October 31, 2026"],
  ];
  for (const [id, w, d, want] of receipt) {
    const got = q(w, "San Francisco", d);
    console.log(`  ${id}: "${w}" -> "${got}"`);
    check(`${id} still makes a sensible search: ${want}`, got === want, got);
  }
  // The cache key is the built query: two different wants with the same kinds are one search (their words can't be in the key).
  reset({ exa: [{ url: "https://lu.ma/good1", title: "Founder dinner" }], pages: { good1: page({ startAt: at(50) }) } });
  const o = { inRange: () => true, dates: D1, deps: viaDeps() };
  await V.lumaEventsViaExa("founder dinner with Jordan Lee", "San Francisco", o);
  const second = await V.lumaEventsViaExa("a dinner for founders, maybe Priya comes", "San Francisco", o);
  check("the cache key is the built query: two wants with the same kinds are one Exa call, and neither's words are in it", exaCalls.length === 1 && second?.report.cached === true && exaCalls[0] === "startup founder, dinner events in San Francisco, October 20 to October 26, 2026", exaCalls);
  check("the log records the kinds used (fixed words only)", JSON.stringify(second?.report.kinds) === '["startup founder","dinner"]');
}

console.log(`luma via exa: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
