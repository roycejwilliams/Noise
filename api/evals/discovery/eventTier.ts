// The event tier by kind of page (Royce, 2026-10-28): any page that is one public event by its own record is an event (tier 2), checked
// against that record; Partiful's public listings as an event source; one event on two platforms kept once; goals with no place leave
// city events out of the 9am sweep; per-tier counts on /sweeps. Zero tokens: every page, the zone lookup and the database are stubs,
// with invented events.
//   npx tsx evals/discovery/eventTier.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const P = await import("../../src/services/eventPage.js");
const ID = await import("../../src/services/eventIdentity.js");
const PF = await import("../../src/services/partiful.js");
const W = await import("../../src/services/taskWeb.js");
const SF = await import("../../src/services/sweepFind.js");
const T = await import("../../src/services/tieredRecommendation.js");
const ES = await import("../../src/services/eventSurfacingSweep.js");
const SS = await import("../../src/services/sweepShadow.js");
const D = await import("../../src/services/dailySweep.js");
const G = await import("../../src/harness/matchGate.js");
const ED = await import("../../src/services/eventDetails.js");
const { transientFailure } = await import("../../src/services/searchFailure.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

// ---------------------------------------------------------------- fixtures (invented events, the platforms' own data shapes)
const NOW = Date.now();
const iso = (hoursAhead: number) => new Date(NOW + hoursAhead * 3_600_000).toISOString();
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const next = (o: unknown) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(o)}</script>`;
const body = (words: string) => `<html><head><title>x</title></head><body><p>${words} ${"Join us for an evening of demos and drinks with builders from around the city. ".repeat(8)}</p></body></html>`;
const partifulPage = (o: { id: string; name: string; start: string; isPublic?: boolean; password?: boolean; atCapacity?: boolean }) =>
  body(o.name).replace(
    "</head>",
    `${ld({ "@context": "https://schema.org", "@type": "Event", name: o.name, startDate: o.start, eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode", location: { "@type": "Place", name: "Dolores Park", address: { "@type": "PostalAddress", streetAddress: "566 Dolores St", addressLocality: "San Francisco", addressRegion: "California" } }, organizer: [{ "@type": "Person", name: "Rae Lin" }], offers: { "@type": "Offer", price: 0, priceCurrency: "USD", availability: "https://schema.org/InStock" } })}${next({ props: { pageProps: { passwordRequired: !!o.password, event: { id: o.id, title: o.name, isPublic: o.isPublic ?? true, visibility: o.isPublic === false ? "private" : "public", timezone: "America/Los_Angeles", atCapacity: !!o.atCapacity } } } })}</head>`,
  );
const lumaPage = (o: { name: string; start: string; visibility?: string }) =>
  body(o.name).replace("</head>", `${next({ props: { pageProps: { initialData: { data: { event: { name: o.name, start_at: o.start, end_at: null, timezone: "America/Los_Angeles", location_type: "offline", visibility: o.visibility ?? "public", geo_address_visibility: "public", geo_address_info: { address: "SPIN San Francisco", full_address: "690 Folsom St, San Francisco, CA", city: "San Francisco" } }, hosts: [{ name: "MemoryBox" }], ticket_info: { is_free: true, spots_remaining: 40, require_approval: false }, sold_out: false, guest_count: 120 } } } } })}</head>`);
const eventbritePage = (o: { name: string; start: string; city?: string | null }) =>
  body(o.name).replace("</head>", `${ld({ "@context": "https://schema.org", "@type": "Event", name: o.name, startDate: o.start, location: { "@type": "Place", name: "The Midway", address: { "@type": "PostalAddress", streetAddress: "900 Marin St", addressLocality: o.city === undefined ? "San Francisco" : o.city, addressRegion: "CA" } }, offers: [{ "@type": "Offer", price: "25.00", priceCurrency: "USD", availability: "https://schema.org/InStock" }] })}</head>`);

const zoneOf = async (place: string) => (/san francisco/i.test(place) ? "America/Los_Angeles" : null);
const pagesDeps = (pages: Record<string, string | Error>, fetched: string[] = []): import("../../src/services/eventPage.js").EventPageDeps => ({
  fetchHtml: async (url) => {
    fetched.push(url);
    const p = pages[url];
    if (p instanceof Error) return { html: null, error: p.message };
    return p ? { html: p, error: null } : { html: null, error: "HTTP 404" };
  },
  zoneOf,
  parseLuma: ED.parseLumaEventPage,
  toText: (h) => h.replace(/<[^>]+>/g, " "),
});

// ---------------------------------------------------------------- 1. a page's own event record
{
  const pf = P.pageEventData(partifulPage({ id: "a", name: "SF Halloween Park Crawl", start: iso(48) }), "https://partiful.com/e/a", ED.parseLumaEventPage);
  check("a public Partiful page is one event by its own record, with its own zone", !!pf.event && pf.one && pf.event.name === "SF Halloween Park Crawl" && pf.event.timezone === "America/Los_Angeles" && pf.event.city === "San Francisco", pf);
  check("Partiful: only the city; the street (for confirmed guests) and the venue are never kept", pf.event?.address === null && pf.event?.venue === null && !JSON.stringify(pf.event).includes("566 Dolores"));
  const priv = P.pageEventData(partifulPage({ id: "b", name: "Maya's 30th", start: iso(48), isPublic: false }), "https://partiful.com/e/b", ED.parseLumaEventPage);
  check("a private Partiful invite is never an event find (it's still one event's page, so it's never swapped)", !priv.event && priv.one && /private invite/.test(priv.why ?? ""), priv);
  check("a password-locked Partiful page isn't either", !P.pageEventData(partifulPage({ id: "c", name: "Secret Supper", start: iso(48), password: true }), "https://partiful.com/e/c", ED.parseLumaEventPage).event);
  const lu = P.pageEventData(lumaPage({ name: "MemoryBox Beta Launch", start: iso(200) }), "https://luma.com/2gizvh99", ED.parseLumaEventPage);
  check("a public Luma page: its record, from Luma's own data", !!lu.event && lu.event.hosts.includes("MemoryBox") && lu.event.timezone === "America/Los_Angeles", lu);
  const luPriv = P.pageEventData(lumaPage({ name: "Team offsite", start: iso(200), visibility: "private" }), "https://luma.com/offsite1", ED.parseLumaEventPage);
  check("a Luma page that says it's private isn't an event find", !luPriv.event && luPriv.one);
  const eb = P.pageEventData(eventbritePage({ name: "Founders & Funders Night", start: "2026-11-20T18:00:00-08:00" }), "https://www.eventbrite.com/e/founders-funders-night-1", ED.parseLumaEventPage);
  check("any page with one schema.org Event: its record, venue and price; no zone yet", !!eb.event && eb.event.venue === "The Midway" && eb.event.price === "25.00 USD" && eb.event.timezone === null, eb);
  const two = P.pageEventData(body("x").replace("</head>", ld({ "@type": "Event", name: "A", startDate: iso(10) }) + ld({ "@type": "Event", name: "B", startDate: iso(20) }) + "</head>"), "https://example.com/calendar", ED.parseLumaEventPage);
  check("a page with several events is a list, not an event", !two.event && !two.one && /a list/.test(two.why ?? ""));
  check("a page with no event record isn't one", !P.pageEventData(body("plain"), "https://example.com/", ED.parseLumaEventPage).one);
  const settled = await P.settleZone(eb.event!, zoneOf);
  check("its zone comes from its city when the page has none", settled?.timezone === "America/Los_Angeles");
  const noZone = await P.settleZone(P.pageEventData(eventbritePage({ name: "Somewhere Mixer", start: iso(30), city: null }), "https://www.eventbrite.com/e/x-2", ED.parseLumaEventPage).event!, zoneOf);
  check("no zone its time can be said in: not an event find (Cue never says a time in the wrong zone)", noZone === null);
}

// ---------------------------------------------------------------- 2. web results: event pages checked as events (the 10-28 morning)
{
  P.clearEventPageCache();
  const fetched: string[] = [];
  const deps = pagesDeps({ "https://partiful.com/e/pf1": partifulPage({ id: "pf1", name: "AI Builders Rooftop", start: iso(72) }) }, fetched);
  const r1 = await P.readEventPage("https://partiful.com/e/pf1", { deps });
  const r2 = await P.readEventPage("https://partiful.com/e/pf1", { deps });
  check("an event page is read once and kept (the hour's cache)", !!r1.event && r2 === r1 && fetched.length === 1);
  const pick = await W.pickPage({ name: "AI Builders Rooftop", url: "https://partiful.com/e/pf1", details: [] }, { read: async () => { throw new Error("read twice"); }, official: async () => { throw new Error("no lookup for an event page"); }, eventPage: async (u) => { const r = await P.readEventPage(u, { deps }); return { oneEvent: r.one, text: r.text, event: r.event, shareable: P.shareableRead(u, r) }; } });
  check("pickPage hands back the page's record from its one read", !pick.swapped && pick.event?.name === "AI Builders Rooftop" && !!pick.text);
  const v = W.verifyEventResult(pick.event!, pick.url, { now: new Date(), official: false, render: ED.renderEventDetails });
  check("checked as an event: kept with its record's own lines as facts (never 'nothing verified on its page')", !!v.kept && v.kept.facts.length > 0 && v.kept.event?.name === "AI Builders Rooftop" && !!v.kept.date && W.withVerifiedFacts([v.kept]).kept.length === 1, v);
  check("its facts say the city and that the address is for registered guests (Partiful)", v.kept!.facts.some((f) => /San Francisco; the exact address is only shown to registered guests/.test(f)));
  const sold = W.verifyEventResult({ ...pick.event!, soldOut: true }, pick.url, { now: new Date(), official: false, render: ED.renderEventDetails });
  check("sold out by its record: dropped as an event (tier 2, counted)", !sold.kept && sold.dropped?.tier === 2);
  const over = W.verifyEventResult({ ...pick.event!, startAt: iso(-3), endAt: null }, pick.url, { now: new Date(), official: false, render: ED.renderEventDetails });
  check("already under way by its record: dropped", !over.kept && /under way/.test(over.dropped?.why ?? ""));
  const tw = src("services/taskWeb.ts");
  check("taskWebSearch checks a page with an event record as an event, before (and instead of) the web's text check", /const fromHtml = !page\.event && htmlOf\.has\(page\.url\)/.test(tw) && /const ev = page\.event \?\? fromHtml\?\.event \?\? null;/.test(tw) && /if \(ev\) \{[\s\S]{0,400}continue;\s*\}\s*const v = verifyResult/.test(tw));
  check("and reads the record from the same response a plain page read fetched (no second fetch)", /if \(r\.html\) htmlOf\.set\(u, r\.html\);/.test(tw) && /html: res!\.body/.test(src("services/webOpportunitySearch.ts")));
  const sf = src("services/sweepFind.ts");
  check("the sweep files a web result with an event record as an event (tier 2)", /if \(k\.event\) found\.set\(k\.url, pageEventMatch\(k\.event, k\.url, \{ source: "web" \}\)\);/.test(sf));
  const m = P.pageEventMatch(pick.event!, pick.url, { source: "web" }) as any;
  check("an event page's match has the feed event's shape: tier 2, its link as its id, its day in its own zone, its record", m.tier === 2 && m.kind === "public_event" && m.event_api_id === pick.url && m.event_date && m.details?.startAt && !("name" in m.details));
  // The gate: a tier 2 event is a Luma link, or a page it was filed from by its record.
  const facts = { searchCity: null, distanceMiles: null, alreadyOffered: false, now: new Date(), zone: null } as any;
  check("the gate takes an event page filed from its record (Partiful)", G.checkGrounding(m, facts).pass, G.checkGrounding(m, facts));
  check("but not a tier 2 'event' with no record behind a non-Luma link", !G.checkGrounding({ tier: 2, kind: "public_event", name: "X", url: "https://example.com/x", reason: "A public event." } as any, facts).pass);
  check("a Luma link still passes as before", G.checkGrounding({ tier: 2, kind: "public_event", name: "X", url: "https://lu.ma/abc123", reason: "A public event.", city: null } as any, facts).pass);
  check("the send-time re-read reads any event page's record (not only Luma's)", /luma: async \(url\) => \(await import\("\.\/eventPage\.js"\)\)\.eventPageDetails\(url, RECHECK_FRESH_MS\)/.test(src("services/sendCheck.ts")));
  check("which, for a non-Luma page, is its event-page read", (await P.eventPageDetails("https://partiful.com/e/pf1", 60_000))?.startAt === pick.event!.startAt);
  // A post's link: kept as an opening, then read and filed as an event.
  const kept = [
    { tier: 3, kind: "opportunity", source: "web", via: "x", name: "post", url: "https://partiful.com/e/pf1", reason: "", whyItFits: "they want AI builder rooms", taste: "matches" },
    { tier: 3, kind: "opportunity", source: "web", name: "Founder fellowship", url: "https://example.org/fellowship", reason: "" },
    { tier: 3, kind: "opportunity", source: "web", name: "Gone", url: "https://partiful.com/e/sold", reason: "" },
  ] as any[];
  const pr = await SF.promoteEventPages(kept, async (u) => (u.endsWith("pf1") ? pick.event! : u.endsWith("sold") ? { ...pick.event!, soldOut: true } : null));
  const up = pr.kept[0] as any;
  check("an X post's Partiful link becomes an event find, keeping why it fits and how it was found", up.tier === 2 && up.whyItFits === "they want AI builder rooms" && up.via === "x" && up.taste === "matches");
  check("a non-event link stays an opening; one sold out by its record is dropped and counted", (pr.kept[1] as any).tier === 3 && pr.kept.length === 2 && pr.dropped === 1);
}

// ---------------------------------------------------------------- 3. Partiful's public listings
{
  check("Partiful's explore page by city; none where it has none (Sacramento)", PF.partifulExploreUrl("San Francisco, CA") === "https://partiful.com/explore/sf" && PF.partifulExploreUrl("SF") === "https://partiful.com/explore/sf" && PF.partifulExploreUrl("Sacramento") === null && PF.partifulExploreUrl(null) === null);
  const explore = body("explore").replace("</head>", ld({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ url: "https://partiful.com/e/e1" }, { url: "https://partiful.com/e/e2" }, { url: "https://partiful.com/e/e1" }, { url: "https://partiful.com/u/someone" }, { url: "https://partiful.com/e/e3?c=invite" }, { url: "https://partiful.com/e/e4" }, { url: "https://partiful.com/e/e5" }] }) + ld({ "@type": "BreadcrumbList" }) + "</head>");
  const links = PF.exploreEventLinks(explore);
  check("only the explore page's own list of /e/ links, once each, never a profile link", links.join() === ["e1", "e2", "e3", "e4", "e5"].map((x) => `https://partiful.com/e/${x}`).join(), links);
  PF.clearPartifulCache();
  P.clearEventPageCache();
  const fetched: string[] = [];
  const until = new Date(NOW + 14 * 86_400_000);
  const deps = pagesDeps(
    {
      "https://partiful.com/explore/sf": explore,
      "https://partiful.com/e/e1": partifulPage({ id: "e1", name: "Dolores Run Club", start: iso(30) }),
      "https://partiful.com/e/e2": partifulPage({ id: "e2", name: "Private Birthday", start: iso(30), isPublic: false }),
      "https://partiful.com/e/e3": partifulPage({ id: "e3", name: "Last Week's Party", start: iso(-30) }),
      "https://partiful.com/e/e4": partifulPage({ id: "e4", name: "Next Month Gala", start: iso(24 * 40) }),
      "https://partiful.com/e/e5": new Error("timed out"),
    },
    fetched,
  );
  const evs = await PF.partifulEvents("San Francisco", until, { deps });
  check("read like the feed: public, upcoming, inside the window, each from its own page; a failed page is skipped", evs?.length === 1 && evs[0].name === "Dolores Run Club" && evs[0].details.timezone === "America/Los_Angeles" && evs[0].url === "https://partiful.com/e/e1", evs);
  const again = await PF.partifulEvents("San Francisco", until, { deps });
  check("cached like the feed: a second read in the window fetches nothing", JSON.stringify(again) === JSON.stringify(evs) && fetched.filter((u) => u.endsWith("/explore/sf")).length === 1);
  check("capped: at most PARTIFUL_LIMITS.events event pages a read", PF.PARTIFUL_LIMITS.events === 12 && /\.slice\(0, PARTIFUL_LIMITS\.events\)/.test(src("services/partiful.ts")));
  check("no explore page for the city: nothing read, not a failure", (await PF.partifulEvents("Sacramento", until, { deps })) === null);
  PF.clearPartifulCache();
  let thrown = "";
  await PF.partifulEvents("San Francisco", until, { deps: pagesDeps({ "https://partiful.com/explore/sf": new Error("timed out") }) }).catch((e) => (thrown = e.message));
  check("an explore page that timed out throws, as a failure that clears (an outage by #293's rule)", /timed out/.test(thrown) && transientFailure(thrown), thrown);
  PF.clearPartifulCache();
  await PF.partifulEvents("San Francisco", until, { deps: pagesDeps({ "https://partiful.com/explore/sf": new Error("couldn't load") }) }).catch((e) => (thrown = e.message));
  check("a network failure reads as one that clears too", transientFailure(thrown), thrown);
  check("every Partiful read goes through safeFetch (each redirect hop checked)", /const got = await L\.safeFetch\(url\);/.test(src("services/eventPage.ts")));

  // In the event search: Partiful's events join Luma's; one Luma also has stays Luma's.
  const lumaFeed = [{ api_id: "evt-1", name: "Dolores Run Club 🏃 #SFRuns", start_at: new Date(Date.parse(evs![0].start_at) + 10 * 60_000).toISOString(), city: "San Francisco", url: "https://lu.ma/runclub" }];
  const pfOnly = { ...evs![0], api_id: "https://partiful.com/e/e9", url: "https://partiful.com/e/e9", name: "Mission Trivia Night", start_at: iso(50), details: { ...evs![0].details, startAt: iso(50) } };
  let pageReads: string[] = [];
  const sources = (partiful: any) => ({
    feed: async () => lumaFeed,
    calendar: async () => [],
    viaExa: async () => ({ events: [], report: { cached: false, error: null, pages: 0, read: 0, notPublic: 0, kept: 0 } }),
    partiful,
    page: async (u: string) => (pageReads.push(u), null),
    near: async () => true,
    rank: (async (events: any[]) => ({ ranked: events.map((e) => ({ ...e })), closest: null })) as any,
    gate: (async (m: any) => m) as any,
    record: (async () => {}) as any,
    exaOn: () => true,
  });
  const r = await T.eventCandidates("run clubs and trivia", "San Francisco", { userId: null, timezone: "America/Los_Angeles", limit: 8, sources: sources(async () => [evs![0], pfOnly]) as any });
  const urls = r.candidates.map((c) => (c.match as any).url);
  check("Partiful's events are event-tier candidates; the run club on both is kept once, as Luma's", urls.includes("https://lu.ma/runclub") && urls.includes("https://partiful.com/e/e9") && !urls.includes("https://partiful.com/e/e1"), urls);
  check("a Partiful event carries its own page's record (no second page read)", !pageReads.includes("https://partiful.com/e/e9") && !!(r.candidates.find((c) => (c.match as any).url === "https://partiful.com/e/e9")?.match as any)?.details?.startAt);
  check("Partiful answering counts as an events source answering; none for the city counts as neither", (r.answered ?? 0) === 3 && ((await T.eventCandidates("x", "Sacramento", { userId: null, timezone: "America/Los_Angeles", sources: sources(async () => null) as any })).answered ?? 0) === 2, r.answered);
  const down = await T.eventCandidates("x", "San Francisco", { userId: null, timezone: "America/Los_Angeles", sources: sources(async () => { throw new Error("Partiful's explore page failed (timed out)"); }) as any });
  check("Partiful failing is said in the search's failures", (down.failures ?? []).some((f) => /Partiful's listings failed/.test(f)));
}

// ---------------------------------------------------------------- 4. one event on two platforms, kept once
{
  check("names compared without case, emoji, punctuation or tags", ID.eventNameKey("SF Tech Week: AI Mixer 🚀 #SFTechWeek") === "sf tech week ai mixer" && ID.eventNameKey("sf tech week — AI mixer!") === "sf tech week ai mixer");
  const start = "2026-11-06T02:00:00.000Z";
  const luma = { name: "MemoryBox Beta Launch 🏓", url: "https://lu.ma/2gizvh99", details: { startAt: start, city: "San Francisco", venue: "SPIN San Francisco", hosts: ["MemoryBox"], price: "free", spotsRemaining: 40 } };
  const partiful = { name: "MemoryBox beta launch! #SFTechWeek", url: "https://partiful.com/e/mb", details: { startAt: "2026-11-06T02:20:00.000Z", city: "San Francisco", venue: null, hosts: ["MemoryBox"], price: "free" } };
  check("the Luma/Partiful pair is one event (same name, 20 minutes apart, same city)", ID.sameEvent(luma, partiful));
  check("45 minutes apart: two events", !ID.sameEvent(luma, { ...partiful, details: { ...partiful.details, startAt: "2026-11-06T02:45:00.000Z" } }));
  check("another city and venue: two events", !ID.sameEvent(luma, { ...partiful, details: { ...partiful.details, city: "Oakland" } }));
  check("no start of its own: never merged by name alone", !ID.sameEvent({ name: "Founder Dinner" }, { name: "Founder Dinner" }));
  check("the richer record is kept; on a tie, Luma's", ID.preferEvent(partiful, luma) === luma && ID.preferEvent({ ...luma, url: "https://partiful.com/e/x" }, { ...luma }).url === "https://lu.ma/2gizvh99");
  const asMatch = (o: any, tier = 2) => ({ tier, kind: "public_event", event_api_id: o.url, name: o.name, url: o.url, reason: "", details: o.details, startAt: o.details.startAt, city: o.details.city });
  // The backlog merge: a Partiful copy waiting, the Luma one found: one item, Luma's.
  const merged = ES.mergeFinds([{ match: asMatch(partiful) as any }], [{ match: asMatch(luma) as any }]);
  check("backlog merge: the same event found again on Luma replaces the poorer Partiful copy, once", merged.length === 1 && (merged[0].match as any).url === luma.url, merged.map((m) => (m.match as any).url));
  const merged2 = ES.mergeFinds([{ match: asMatch(luma) as any }], [{ match: asMatch(partiful) as any }]);
  check("and a poorer copy found later doesn't replace or join it", merged2.length === 1 && (merged2[0].match as any).url === luma.url);
  const fresh = ES.mergeFinds([], [{ match: asMatch(partiful) as any }, { match: asMatch(luma) as any }]);
  check("two copies found in one search are kept once", fresh.length === 1 && (fresh[0].match as any).url === luma.url);
  check("sameMatch knows one event across platforms", ES.sameMatch(asMatch(luma) as any, asMatch(partiful) as any));
  // The picker's pool: one item serving both asks; and one already sent under another link isn't picked again.
  const raw = (m: any, askId: string) => ({ name: m.name, date: "2026-11-05", tier: 2, askId, fromProfile: false, reminder: false, details: "x", ident: SS.identOf(m) });
  const pool = SS.buildShadowPool([raw(asMatch(partiful), "a1"), raw(asMatch(luma), "a2")], "2026-10-28", new Map([["a1", "A1"], ["a2", "A2"]]), new Set());
  check("picker pool: one item for the pair, Luma's, serving both asks", pool.length === 1 && pool[0].name === luma.name && pool[0].asks.sort().join() === "A1,A2", pool);
  const after = SS.buildShadowPool([raw(asMatch(partiful), "a1")], "2026-10-28", new Map([["a1", "A1"]]), new Set(), new Set(), new Set(), [SS.identOf(asMatch(luma))]);
  check("sent on Luma: the Partiful copy isn't picked again", after.length === 0);
  check("what was shown is matched by record too (offerHistory reads the event's twins)", /const twins = [\s\S]{0,120}await shownTwins\(userId, match\)/.test(src("harness/matchGate.ts")));
}

// ---------------------------------------------------------------- 5. goals with no place leave city events out of the 9am sweep
{
  const plan = { edges: [{ goal: "secure pre-seed funding", edges: ["consumer AI pre-seed open calls"], placeBound: false }, { goal: "SF founder dinners", edges: ["SF founder dinners"], placeBound: true }, { goal: "learn piano", edges: ["piano lessons"] }] };
  const items = D.goalItemsFromPlan(plan, (e) => e.edges.join("; "));
  check("the plan's read reaches the floor as it is: false, true, or left out", items[0].placeBound === false && items[1].placeBound === true && !("placeBound" in items[2]), items);
  check("away still holds only an explicit true", D.floorGoalDecision(items[0], { states: new Map(), statesError: null, gateError: null, hold: ["away_hold"], goalId: "g" }) === null);
  check("a goal read as not tied to a place leaves events out of the morning sweep; unknown or tied keeps them", SF.sweepSkips({ placeBound: false }, true).has("events") && !SF.sweepSkips({ placeBound: null }, true).size && !SF.sweepSkips({}, true).size && !SF.sweepSkips({ placeBound: true }, true).size && !SF.sweepSkips({ placeBound: false }, false).size);
  check("so events isn't forced for it: web first, then X", SF.nextRequiredSource(new Set(), 0, 9, new Set(["events"])) === "webSearch" && SF.nextRequiredSource(new Set(["web"]), 1, 9, new Set(["events"])) === "searchPosts" && SF.nextRequiredSource(new Set(["web", "x"]), 2, 9, new Set(["events"])) === null);
  check("and with no read, events is still forced first", SF.nextRequiredSource(new Set(), 0) === "searchEvents");
  const base = { userId: "u", firstName: "Jordan", askText: "look for: consumer AI pre-seed open calls", fromProfile: true, city: "Sacramento" };
  const portable = SF.sweepPrompt({ ...base, placeBound: false }, { today: "2026-10-28", record: SF.emptySweepRecord(), allSources: true });
  const local = SF.sweepPrompt({ ...base, placeBound: null }, { today: "2026-10-28", record: SF.emptySweepRecord(), allSources: true });
  check("its prompt says two places, never all three; unknown says all three as before", portable.includes(SF.SWEEP_PORTABLE_SOURCES) && !portable.includes(SF.SWEEP_ALL_SOURCES) && local.includes(SF.SWEEP_ALL_SOURCES) && !local.includes(SF.SWEEP_PORTABLE_SOURCES));
  check("an ask's prompt is unchanged (asks carry no place read)", SF.sweepPrompt(base, { today: "2026-10-28", record: SF.emptySweepRecord(), allSources: true }) === local);
  const sf = src("services/sweepFind.ts");
  check("the events tool isn't offered for it, and its skip is never said as 'not reached' or failed", /skips\.has\("events"\) \? \{ activeTools: \["webSearch", "searchPosts", "readPage", "keep", "skip"\]/.test(sf) && /!called\.has\(s\.source\) && !skips\.has\(s\.source\)\) sourceFailures\.push\(`\$\{s\.source\}: not reached/.test(sf) && /!called\.has\(s\.source\) && !skips\.has\(s\.source\)\) placeFailed/.test(sf));
  check("the floor hands each goal's read to its search", /\.\.\.\(typeof g\.placeBound === "boolean" \? \{ placeBound: g\.placeBound \} : \{\}\) \}\);/.test(src("services/dailySweep.ts")) && /\.\.\.\(candidate\.placeBound !== undefined \? \{ placeBound: candidate\.placeBound \} : \{\}\)/.test(src("services/eventSurfacingSweep.ts")));
  // Skipped by design is a searched goal, not an outage or a place down.
  const it = D.searchedItem({ kind: "goal", id: "g", text: "secure pre-seed funding" }, { sources: { events: false, web: true, x: true, failures: [] }, found: 1, pooled: 1, queued: 0, outcome: "x" });
  check("a goal searched in web and X only is 'searched' (coverage reads it as running), not incomplete or down", it.status === "searched" && !it.outages && !it.placesDown && !D.searchFailed({ sources: { events: false, web: true, x: true } }));
}

// ---------------------------------------------------------------- 6. per-tier counts on /sweeps
{
  const t = (a: number[], b: number[], c: number[]) => ({ "1": { searched: a[0], found: a[1], kept: a[2], dropped: a[3] }, "2": { searched: b[0], found: b[1], kept: b[2], dropped: b[3] }, "3": { searched: c[0], found: c[1], kept: c[2], dropped: c[3] } });
  const sum = D.dailySummary([
    { kind: "goal", id: "g1", text: "a", status: "searched", tiers: t([1, 2, 0, 1], [3, 4, 1, 2], [2, 5, 1, 3]) },
    { kind: "ask", id: "a1", text: "b", status: "incomplete", tiers: t([1, 0, 0, 0], [2, 1, 1, 0], [1, 0, 0, 0]) },
    { kind: "ask", id: "a2", text: "c", status: "searched" },
  ]);
  check("the day's totals add each item's tiers (an older item adds nothing)", JSON.stringify(sum.totals.tiers) === JSON.stringify(t([2, 2, 0, 1], [5, 5, 2, 2], [3, 5, 1, 3])), sum.totals.tiers);
  const day = D.rollupDay([{ outcome: "act", action: "x", reason: null, proposal: { totals: { tiers: t([1, 1, 1, 0], [2, 2, 1, 1], [3, 3, 0, 3]) } } }], 0, true, true);
  check("the rollup shows the day's last run's tiers", day.tiers["2"].kept === 1 && day.tiers["3"].dropped === 3);
  check("an older record reads 0", JSON.stringify(D.rollupDay([{ outcome: "act", action: "x", reason: null, proposal: { totals: {} } }], 0, true, true).tiers) === JSON.stringify(t([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0])));
  const sf = src("services/sweepFind.ts");
  check("the search counts each tier: searched per call, found by what it filed, kept after the gate, dropped by a page's check, the gate or their limits", /tierCounts\["2"\]\.dropped \+= eventDrops;/.test(sf) && /for \(const m of found\.values\(\)\) tierCounts\[tierKey\(\(m as any\)\.tier\)\]\.found\+\+;/.test(sf) && /for \(const g of gatedOut\) tierCounts\[tierKey\(g\.tier\)\]\.dropped\+\+;/.test(sf) && /for \(const m of gated\) tierCounts\[tierKey\(\(m as any\)\.tier\)\]\.kept\+\+;/.test(sf) && /tiers: tierCounts \} \};/.test(sf));
  const client = readFileSync(new URL("../../../co-test/src/client/sweeps.ts", import.meta.url), "utf8");
  check("/sweeps shows a column per tier (searched · found · kept · dropped)", /<th title="searched · found · kept · dropped">Noise events<\/th><th title="searched · found · kept · dropped">Event pages<\/th><th title="searched · found · kept · dropped">Web and X<\/th>/.test(client) && /tierCell\(r\.tiers\?\.\["2"\]\)/.test(client));
}

// ---------------------------------------------------------------- 7. batched review of #299
{
  // 1. A page known to be private is dropped everywhere, never kept as an opening; one that couldn't be read keeps today's behavior.
  P.clearEventPageCache();
  const priv = await P.readEventPage("https://partiful.com/e/inv", { deps: pagesDeps({ "https://partiful.com/e/inv": partifulPage({ id: "inv", name: "Maya's 30th", start: iso(48), isPublic: false }) }) });
  check("#299 review 1: readEventPage says private apart from couldn't-read", priv.private === true && !priv.event && !(await P.readEventPage("https://partiful.com/e/gone", { deps: pagesDeps({}) })).private);
  const kept = [{ tier: 3, kind: "opportunity", source: "web", via: "x", name: "Maya's 30th", url: "https://partiful.com/e/inv", reason: "" }, { tier: 3, kind: "opportunity", source: "web", name: "Unreadable", url: "https://partiful.com/e/gone", reason: "" }] as any[];
  const pr = await SF.promoteEventPages(kept, async (u) => (u.endsWith("inv") ? "private" : null));
  check("#299 review 1: a private invite an X post points to is dropped, never kept as an opening; an unreadable one stays as it was", pr.kept.length === 1 && (pr.kept[0] as any).url.endsWith("gone") && pr.dropped === 1);
  const pick = await W.pickPage({ name: "Maya's 30th", url: "https://partiful.com/e/inv", details: [] }, { read: async () => "a page of text ".repeat(50), official: async () => "https://maya.example.com/", eventPage: async () => ({ oneEvent: true, text: "x", event: null, private: true }) });
  check("#299 review 1: pickPage marks it private, with no text to fall through to the web check", pick.private === true && pick.text === null && !pick.swapped);
  const tw = src("services/taskWeb.ts");
  check("#299 review 1: taskWebSearch drops a private page before any check, from pickPage's read or the plain read's html", /if \("private" in page && page\.private\) \{\s*dropped\.push\(\{ name: raw\.name, url: raw\.url, why: "its page's own record doesn't say it's public \(or it couldn't be read\)", tier: 2 \}\);\s*continue;/.test(tw) && /if \(fromHtml\?\.private\) \{/.test(tw));
  // 2. Luma: public only when it says so.
  const noVis = P.pageEventData(lumaPage({ name: "Quiet thing", start: iso(48), visibility: "" }), "https://luma.com/q1", ED.parseLumaEventPage);
  check("#299 review 2: a Luma page that doesn't say public isn't an event find (and isn't called private either)", !noVis.event && !noVis.private && /doesn't say it's public/.test(noVis.why ?? ""), noVis);
  // 3. Declines by record, and no reminder after an answer that wasn't recorded.
  const shortNotice = { isEvent: true, date: "2026-10-29", shortNotice: true };
  check("#299 review 3: shown, answered (no outcome recorded), within a day: no reminder", G.repeatRule({ shownAt: [new Date(NOW - 86_400_000)], outcome: null, answered: true }, shortNotice, "2026-10-28", new Date(NOW)).action === "blocked");
  check("#299 review 3: never answered, within a day: still a reminder; interested: a reminder", G.repeatRule({ shownAt: [new Date(NOW - 86_400_000)], outcome: null, answered: false }, shortNotice, "2026-10-28", new Date(NOW)).action === "remind" && G.repeatRule({ shownAt: [new Date(NOW - 86_400_000)], outcome: "interested", answered: true }, shortNotice, "2026-10-28", new Date(NOW)).action === "remind");
  check("#299 review 3: declined is blocked first, as before", G.repeatRule({ shownAt: [new Date(NOW - 86_400_000)], outcome: "declined", answered: true }, shortNotice, "2026-10-28", new Date(NOW)).action === "blocked");
  const mg = src("harness/matchGate.ts");
  check("#299 review 3: outcomes are read under this link and every twin's (by record)", /const keys = \[\.\.\.new Set\(\[eventId \? `event:\$\{eventId\}` : "", `name:\$\{match\.name\.toLowerCase\(\)\}`, \.\.\.twins\.flatMap/.test(mg) && /item_key = ANY\(\$2::text\[\]\) OR lower\(item_name\) = ANY\(\$3::text\[\]\)/.test(mg));
  // 4. Two venues: two events.
  const start = "2026-11-06T02:00:00.000Z";
  const a = { name: "Founder Dinner", details: { startAt: start, city: "San Francisco", venue: "Zuni Cafe" } };
  check("#299 review 4: one name, one city, one night, two venues: two events", !ID.sameEvent(a, { ...a, details: { ...a.details, venue: "Nopa" } }));
  check("#299 review 4: a venue missing on one side: the city decides", ID.sameEvent(a, { ...a, details: { ...a.details, venue: null } }));
  // 5. Missed twins.
  check("#299 review 5: word order set aside", ID.sameEvent({ name: "SF Tech Week: AI Mixer", details: { startAt: start, city: "San Francisco" } }, { name: "AI Mixer | SF Tech Week", details: { startAt: start, city: "SF" } }));
  check("#299 review 5: an offset-less start is read in the event's own zone, never the server's", ID.sameEvent({ name: "Run Club", details: { startAt: "2026-11-05T18:00:00", timezone: "America/Los_Angeles", city: "San Francisco" } }, { name: "Run Club", details: { startAt: "2026-11-06T02:00:00.000Z", city: "San Francisco" } }) && !ID.sameEvent({ name: "Run Club", details: { startAt: "2026-11-05T18:00:00", city: "San Francisco" } }, { name: "Run Club", details: { startAt: "2026-11-06T02:00:00.000Z", city: "San Francisco" } }));
  check("#299 review 5: one side with no place: only the same name and the very same start", ID.sameEvent({ name: "Run Club", details: { startAt: start } }, { name: "Run Club", details: { startAt: start, city: "San Francisco" } }) && !ID.sameEvent({ name: "Run Club", details: { startAt: start } }, { name: "Run Club", details: { startAt: "2026-11-06T02:10:00.000Z", city: "San Francisco" } }) && !ID.sameEvent({ name: "Club Run", details: { startAt: start } }, { name: "Run Club", details: { startAt: start, city: "San Francisco" } }));
  // Zone from a locality only; never a street or a venue, never for an online event.
  const asked: string[] = [];
  const z = async (p: string) => (asked.push(p), "America/Los_Angeles");
  const base = P.pageEventData(eventbritePage({ name: "Gala", start: "2026-11-20T18:00:00-08:00", city: null }), "https://www.eventbrite.com/e/gala-1", ED.parseLumaEventPage).event!;
  check("#299 review: no locality, no zone lookup (never the street or the venue)", (await P.settleZone(base, z)) === null && asked.length === 0);
  check("#299 review: an online event gets no zone lookup", (await P.settleZone({ ...base, city: "San Francisco", online: true }, z)) === null && asked.length === 0);
  check("#299 review: a locality is looked up", (await P.settleZone({ ...base, city: "San Francisco" }, z))?.timezone === "America/Los_Angeles" && asked.join() === "San Francisco");
  // 6. Held, not dropped.
  const far = P.pageEventMatch({ ...base, city: "San Francisco", timezone: "America/Los_Angeles", startAt: "2026-12-10T18:00:00-08:00" }, "https://www.eventbrite.com/e/gala-1", { source: "web" });
  const held = SF.holdForWindow(far, "2026-10-28") as any;
  check("#299 review 6: an event page past the event window is held until it's inside it", held.heldUntil === "2026-11-26", held.heldUntil);
  check("#299 review 6: one inside the window isn't held", !("heldUntil" in (SF.holdForWindow(P.pageEventMatch({ ...base, city: "San Francisco", timezone: "America/Los_Angeles", startAt: "2026-11-05T18:00:00-08:00" }, "https://x.example/e", { source: "web" }), "2026-10-28") as any)));
  const sf = src("services/sweepFind.ts");
  check("#299 review 6: the web's and X's event pages are gated with the hold window and marked; the rest as before", /gateMatches\(kept\.filter\(isPageFind\), \{ \.\.\.gateOpts, lookaheadDays: HOLD_EVENT_DAYS \}\)/.test(sf) && /gatedPages\.map\(\(m\) => holdForWindow\(m, today\)\)/.test(sf) && SF.HOLD_EVENT_DAYS === 60);
  const rawHeld = { name: "Gala", date: "2026-12-10", tier: 2, askId: null, fromProfile: true, reminder: false, details: "x", heldUntil: "2026-11-26" };
  check("#299 review 6: the picker doesn't judge it until its day, then does", SS.buildShadowPool([rawHeld], "2026-10-28", new Map(), new Set()).length === 0 && SS.buildShadowPool([rawHeld], "2026-11-26", new Map(), new Set()).length === 1);
  check("#299 review 6: the queue leaves it in the backlog until its day", /if \(heldUntil && heldUntil > localDay\(new Date\(\), zone\)\) \{/.test(src("services/eventSurfacingSweep.ts")));
  // 7. Partiful: not on calls; cached by city, each search's dates applied after.
  let calls = 0;
  const viaFalse = await T.eventCandidates("x", "San Francisco", { userId: null, timezone: "America/Los_Angeles", viaExa: false, sources: { feed: async () => [], calendar: async () => [], viaExa: async () => { throw new Error("no"); }, partiful: async () => (calls++, []), page: async () => null, near: async () => true, rank: (async (e: any[]) => ({ ranked: e, closest: null })) as any, gate: (async (m: any) => m) as any, record: (async () => {}) as any, exaOn: () => true } as any });
  check("#299 review 7: no Partiful read on a call or a voice reply (viaExa false)", calls === 0 && !(viaFalse.failures ?? []).length);
  PF.clearPartifulCache();
  P.clearEventPageCache();
  const fetched: string[] = [];
  const explore = body("explore").replace("</head>", ld({ "@type": "ItemList", itemListElement: [{ url: "https://partiful.com/e/w1" }, { url: "https://partiful.com/e/w2" }] }) + "</head>");
  const deps = pagesDeps({ "https://partiful.com/explore/sf": explore, "https://partiful.com/e/w1": partifulPage({ id: "w1", name: "Soon", start: iso(30) }), "https://partiful.com/e/w2": partifulPage({ id: "w2", name: "Later", start: iso(24 * 20) }) }, fetched);
  const week = await PF.partifulEvents("San Francisco", new Date(NOW + 7 * 86_400_000), { deps });
  const month = await PF.partifulEvents("San Francisco", new Date(NOW + 30 * 86_400_000), { deps });
  check("#299 review 7: one read per city serves every window (this week, this month)", week?.map((e) => e.name).join() === "Soon" && month?.map((e) => e.name).join() === "Soon,Later" && fetched.filter((u) => u.endsWith("/explore/sf")).length === 1, { week: week?.map((e) => e.name), month: month?.map((e) => e.name), fetched });
}

// ---------------------------------------------------------------- 8. a Luma or Partiful link an X post points to: fail closed, everywhere
{
  check("only Luma and Partiful event-shaped links are judged", P.mayBePrivateEvent("https://partiful.com/e/abc") && P.mayBePrivateEvent("https://lu.ma/abc123") && !P.mayBePrivateEvent("https://partiful.com/explore/sf") && !P.mayBePrivateEvent("https://www.eventbrite.com/e/x-1") && !P.mayBePrivateEvent("https://x.com/a/status/1"));
  check("shareable only when its own record says public (or a Luma page read with no event in it)", P.shareableRead("https://partiful.com/e/a", { html: "x", one: true, public: true }) && !P.shareableRead("https://partiful.com/e/a", { html: "x", one: true }) && !P.shareableRead("https://partiful.com/e/a", { html: "x", one: false }) && !P.shareableRead("https://partiful.com/e/a", null) && !P.shareableRead("https://lu.ma/x1", { html: "x", one: true, private: true }) && P.shareableRead("https://lu.ma/genai-sf", { html: "x", one: false }) && !P.shareableRead("https://lu.ma/genai-sf", { html: null, one: false }) && P.shareableRead("https://www.eventbrite.com/e/x-1", null));
  const reads: string[] = [];
  const pub = { html: "x", one: true, public: true };
  const out = await P.unshareableEventLinks(["https://partiful.com/e/inv", "https://lu.ma/open1", "https://example.com/post", "https://partiful.com/e/inv"], async (u) => (reads.push(u), u.endsWith("inv") ? { html: "x", one: true, private: true } : pub));
  check("the private one is unshareable, the public one isn't; only Luma and Partiful links are read, each once", out.size === 1 && out.has("https://partiful.com/e/inv") && reads.sort().join() === "https://lu.ma/open1,https://partiful.com/e/inv", { out: [...out], reads });
  const slow = await P.unshareableEventLinks(["https://partiful.com/e/slow"], () => new Promise((r) => setTimeout(() => r(pub), P.PRIVATE_CHECK.deadlineMs + 2000)));
  check("final review: a slow page (past the deadline) is dropped", slow.has("https://partiful.com/e/slow"));
  const err = await P.unshareableEventLinks(["https://lu.ma/err1"], async () => { throw new Error("HTTP 429"); });
  check("final review: a read error (429) is dropped", err.has("https://lu.ma/err1"));
  const nine = Array.from({ length: 9 }, (_, i) => `https://partiful.com/e/p${i}`);
  const seen: string[] = [];
  const ninth = await P.unshareableEventLinks(nine, async (u) => (seen.push(u), u.endsWith("p8") ? { html: "x", one: true } : pub));
  check("final review: every link is checked (a 9th too), and one not confirmed public is dropped", seen.length === 9 && ninth.size === 1 && ninth.has("https://partiful.com/e/p8"), { seen: seen.length, ninth: [...ninth] });
  // A read already under way is shared.
  P.clearEventPageCache();
  let fetches = 0;
  const slowDeps = { ...pagesDeps({ "https://partiful.com/e/once": partifulPage({ id: "once", name: "Once", start: iso(30) }) }), fetchHtml: async (u: string) => (fetches++, await new Promise((r) => setTimeout(r, 50)), { html: partifulPage({ id: "once", name: "Once", start: iso(30) }), error: null }) };
  const [a1, a2] = await Promise.all([P.readEventPage("https://partiful.com/e/once", { deps: slowDeps }), P.readEventPage("https://partiful.com/e/once", { deps: slowDeps })]);
  check("final review: two checks of one link at once share one read", fetches === 1 && a1 === a2 && a1.public === true);
  // promoteEventPages: a Luma or Partiful link whose read failed is dropped, any other stays.
  const kept = [{ tier: 3, kind: "opportunity", source: "web", via: "x", name: "p", url: "https://partiful.com/e/err", reason: "" }, { tier: 3, kind: "opportunity", source: "web", via: "x", name: "e", url: "https://www.eventbrite.com/e/err-2", reason: "" }] as any[];
  const pr = await SF.promoteEventPages(kept, async () => { throw new Error("timed out"); });
  check("final review: a post's Partiful link whose read failed is dropped; an Eventbrite one stays as it was", pr.kept.length === 1 && (pr.kept[0] as any).url.includes("eventbrite") && pr.dropped === 1);
  const sf = src("services/sweepFind.ts");
  check("the sweep's eventPageFor fails closed (not shareable is 'private')", /return !shareableRead\(url, r\) \? \("private" as const\) : r\.event;/.test(sf) && /m\.unshareableEventLinks\(allLinks\)\)\.catch\(\(\) => new Set\(allLinks\.filter\(mayBePrivateEvent\)\)\)/.test(sf));
  const lt = src("agent/loopTools.ts");
  check("reply loop: an X post's unshareable links are dropped before they're finds or shown (a failed check drops them all)", /const privateLinks = await unshareableEventLinks\(allLinks\)\.catch\(\(\) => new Set\(allLinks\.filter\(mayBePrivateEvent\)\)\);/.test(lt) && /for \(const p of posts\) p\.links = p\.links\.filter\(\(l\) => !privateLinks\.has\(l\)\);\s*for \(const p of posts\) \{/.test(lt));
  check("reply loop: shareFinds checks every post link at once, before its loop, and refuses an unshareable one", /const unshareable = postLinks\.length \? await unshareableEventLinks\(postLinks\)/.test(lt) && /if \(unshareable\.has\(it\.link\)\) \{/.test(lt) && !/for \(const it of items\) \{[\s\S]{0,1500}unshareableEventLinks\(/.test(lt));
  check("a post's link is marked, so shareFinds checks it", /loop\.found\.set\(l, \{ name: p\.text\.slice\(0, 80\), url: l, facts: p\.text, match: null, blocked: null, viaPost: true \}\)/.test(lt));
  const pick = await W.pickPage({ name: "Unread", url: "https://partiful.com/e/unread", details: [] }, { read: async () => "a page of text ".repeat(50), official: async () => "https://x.example.com/", eventPage: async () => { throw new Error("timed out"); } });
  check("final review: the web search drops a Partiful result whose page couldn't be confirmed public (read failed)", pick.private === true && pick.text === null);
}

console.log(`event tier by page: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
