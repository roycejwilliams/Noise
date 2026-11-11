// The page route for tier 2 (Royce, 2026-11-10): when Luma's API can't be used (403 "no active Luma Plus plan" from 2026-10-31), each
// Luma link Exa finds is checked on its own public page, by the same rules the API answer had: public only (fails closed), upcoming,
// inside the window, a confirmed place. The page's embedded record (shaped here like the 2026-11-10 sample of 17 real lu.ma pages, with
// invented names; the real-page fixtures below are anonymized too) carries visibility, start/end/zone, location type, city and whether the street is shown, registration ("open",
// "waitlist", "sold-out"), approval, spots; its schema.org record carries cancellation. A page Luma won't serve (403/429/503 or an
// access check) stops the route and pauses it, and no paid search runs while neither route can check. Zero tokens, no network.
//   npx tsx evals/search/lumaPages.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
delete process.env.EXA_API_KEY;

const V = await import("../../src/services/lumaViaExa.js");
const E = await import("../../src/services/eventDetails.js");
const T = await import("../../src/services/tieredRecommendation.js");
const SC = await import("../../src/services/sendCheck.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

const H = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
// A Luma event page as Luma serves it: __NEXT_DATA__ (props.pageProps.initialData.data), a schema.org Event for a public page, and a
// robots noindex for a private one (both as seen 2026-11-10).
type Ev = {
  id?: string; slug?: string; name?: string; start?: string; end?: string | null; tz?: string | null; visibility?: string | null; loc?: string | null; addrVis?: string;
  city?: string | null; address?: string; registration?: string; soldOut?: boolean; approval?: boolean; spots?: number | null; status?: string; noindex?: boolean; ld?: boolean;
};
const html = (o: Ev = {}) => {
  const event: Record<string, unknown> = {
    api_id: o.id ?? "evt-aaa", url: o.slug ?? "aaa111", name: o.name ?? "Founders Supper", start_at: o.start ?? at(48), end_at: o.end === undefined ? at(51) : o.end, timezone: o.tz === undefined ? "America/Los_Angeles" : o.tz,
    location_type: o.loc === undefined ? "offline" : o.loc, geo_address_visibility: o.addrVis ?? "public",
    geo_address_info: o.city === null ? {} : { city: o.city ?? "San Francisco", address: o.address ?? "Pier 1", full_address: `${o.address ?? "Pier 1"}, ${o.city ?? "San Francisco"}, CA`, city_state: "San Francisco, CA" },
    waitlist_status: o.registration === "waitlist" ? "active" : "disabled",
  };
  if (o.visibility !== null) event.visibility = o.visibility ?? "public";
  const data = {
    event, hosts: [{ name: "A Host" }], guest_count: 12, sold_out: o.soldOut ?? false, registration_availability: o.registration ?? "open",
    ticket_info: { is_free: true, price: null, is_sold_out: false, spots_remaining: o.spots ?? null, require_approval: o.approval ?? false }, calendar: { access_level: "public" },
  };
  const ld = o.ld === false || (o.visibility && o.visibility !== "public") ? "" : `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: event.name, eventStatus: `https://schema.org/${o.status ?? "EventScheduled"}` })}</script>`;
  return `<html><head>${o.noindex || (o.visibility && o.visibility !== "public") ? '<meta name="robots" content="noindex" data-next-head=""/>' : ""}${ld}</head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data } } } })}</script></body></html>`;
};
const CAL = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { calendar: { api_id: "cal-1" } } } } } })}</script></html>`;
const classify = (r: { html: string | null; status: number | null; error: string | null }) => V.classifyLumaPage(r, E.lumaPageRecord);
const ok200 = (h: string) => classify({ html: h, status: 200, error: null });

// ================================================================ what a page establishes (pure)
{
  const c = ok200(html({ start: "2026-11-15T21:00:00.000Z", end: "2026-11-15T22:30:00.000Z" }));
  const r = c.kind === "event" ? c.record : null;
  check("a public page: its record, with its own start, end and zone as given", !!r && r.id === "evt-aaa" && r.visibility === "public" && r.startAt === "2026-11-15T21:00:00.000Z" && r.endAt === "2026-11-15T22:30:00.000Z" && r.timezone === "America/Los_Angeles", r);
  check("...registration open, not sold out, not cancelled, listed", !!r && r.registration === "open" && r.registrationOpen === true && r.soldOut === false && !r.cancelled && !r.noindex, r);
  const w = ok200(html({ registration: "waitlist", soldOut: true, spots: 0, approval: true }));
  const wr = w.kind === "event" ? w.record : null;
  // Royce, 2026-11-10: a waitlist is offered as waitlist only, never turned away as sold out (its page's sold_out true notwithstanding).
  check("a waitlist: exists, upcoming, not open (registration 'waitlist'), waitlist only and not sold out, approval kept", !!wr && wr.registration === "waitlist" && wr.registrationOpen === false && wr.soldOut === false && wr.details.waitlist === true && wr.requireApproval === true && wr.spotsRemaining === 0, wr);
  const so = ok200(html({ registration: "sold-out", soldOut: false }));
  check("sold out by its registration state alone (sold_out false on the page, as one sampled real page had it) is sold out", so.kind === "event" && so.record.soldOut === true && so.record.details.soldOut === true, so);
  const cx = ok200(html({ status: "EventCancelled" }));
  check("cancelled by its own schema.org record", cx.kind === "event" && cx.record.cancelled === true && cx.record.details.cancelled === true, cx);
  const nold = ok200(html({ ld: false }));
  check("no schema.org record: cancellation unknown, never assumed", nold.kind === "event" && nold.record.cancelled === false, nold);
  const pv = ok200(html({ visibility: "private" }));
  check("a private page (anyone with the link): read as private, with its noindex", pv.kind === "event" && pv.record.visibility === "private" && pv.record.noindex === true, pv);
  const nv = ok200(html({ visibility: null }));
  check("a page that doesn't say its visibility: null (unknown), never 'public'", nv.kind === "event" && nv.record.visibility === null, nv);
  const gs = ok200(html({ addrVis: "guests-only" }));
  check("street for guests only: the city stays, the street isn't read as shown", gs.kind === "event" && gs.record.city === "San Francisco" && gs.record.locationVisibility === "guests-only" && gs.record.details.venue === null && gs.record.details.address === null, gs);
}
{
  check("404: missing", classify({ html: null, status: 404, error: "HTTP 404" }).kind === "missing");
  check("410: missing", classify({ html: null, status: 410, error: "HTTP 410" }).kind === "missing");
  check("403: blocked, never 'no such event'", classify({ html: null, status: 403, error: "HTTP 403" }).kind === "blocked");
  check("429: blocked (stop, don't retry fast)", classify({ html: null, status: 429, error: "HTTP 429" }).kind === "blocked");
  check("503: blocked", classify({ html: null, status: 503, error: "HTTP 503" }).kind === "blocked");
  check("an access-check page served as 200: blocked", ok200("<html><title>Just a moment...</title><div id='cf-chl-widget'></div></html>").kind === "blocked");
  check("a timeout: failed (unchecked)", classify({ html: null, status: null, error: "timed out (6s)" }).kind === "failed");
  check("a page without Luma's data: failed (unreadable), not missing", ok200("<html><body>hello</body></html>").kind === "failed");
  check("a calendar's page: not an event", ok200(CAL).kind === "not_event");
  check("an event record with no start: failed, not an event", ok200(html().replace(/"start_at":"[^"]+",/, "")).kind === "failed");
}

// ================================================================ real page shapes (review of #447): the structure of lu.ma/discover, lu.ma/sf
// and one public event page as Luma served them on 2026-11-10 (evals/search/fixtures), with every value that could identify anyone or
// anything replaced: names are "Test ...", ids are evt-/cal-/discplace-TEST..., slugs are test-..., places are city level only (no
// street, venue, coordinates or place ids), and only Luma's own enum values and times are kept. Their listings still hold
// "event": { ... } entries, the shape a loose match read as a broken event page.
{
  const { readFileSync } = await import("fs");
  const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
  const disc = ok200(fx("luma-discover.html"));
  check("real lu.ma/discover: not an event (the probe's page is served, not 'failed')", disc.kind === "not_event", disc);
  const sf = ok200(fx("luma-sf.html"));
  check("real lu.ma/sf (a city page listing events): not an event", sf.kind === "not_event", sf);
  const ev = ok200(fx("luma-public-event.html"));
  const r = ev.kind === "event" ? ev.record : null;
  check("real public event page: an event, public, offline in San Francisco, open, its own zone", !!r && r.visibility === "public" && r.locationType === "offline" && r.city === "San Francisco" && r.registration === "open" && r.timezone === "America/Los_Angeles" && r.startAt === "2026-11-15T21:00:00.000Z" && !r.cancelled && !r.noindex, r);
  check("an unparseable app-data page is failed but served (Luma is serving us)", (() => { const c = ok200('<script id="__NEXT_DATA__" type="application/json">{not json</script>'); return c.kind === "failed" && c.served === true; })());
  // The probe passes on the real discover page with the API denied: the route runs and checks the real event page end to end.
  const d: any = {
    exa: async () => ({ pages: [{ url: "https://lu.ma/test-ev-1", title: "Test Event", published: null, text: "" }], cost: 0.022, error: null }),
    lookup: async () => { throw new Error("no API"); }, event: async () => { throw new Error("no API"); },
    lumaApi: () => true, apiState: async () => "denied", denial: () => ({ at: 0, until: Date.now() + 60_000, status: 403, message: "x", streak: 1 }),
    page: async (slug: string) => ok200(fx(slug === "discover" ? "luma-discover.html" : "luma-public-event.html")),
    configured: () => true, now: () => new Date("2026-11-10T20:00:00Z"), refusing: () => false, pauseMinutes: 10,
    reserve: async () => ({ ok: true, reason: null }), place: async (c: string | null) => (c ? { name: c } : null),
  };
  V.clearLumaViaExaCache();
  V.resetLumaPages();
  const res = await V.lumaEventsViaExa("community walk", "San Francisco", { userId: null, source: "sweep", inRange: () => true, dates: "November 10 to November 24, 2026", deps: d });
  check("API denied + real discover probe: the page route runs and keeps the real public event", res!.report.route === "page" && !res!.report.sourceDown && res!.events.length === 1 && res!.events[0].api_id === "evt-TESTEV0001", res?.report);
}

// ================================================================ the route inside the search
let exaCalls = 0;
let reads: string[] = [];
let pageWorld: Record<string, { html: string | null; status: number | null; error: string | null }> = {};
const via = (o: { found: string[]; state?: "ok" | "denied" | "off" }) => ({
  exa: async () => (exaCalls++, { pages: o.found.map((s) => ({ url: `https://lu.ma/${s}`, title: `Title ${s}`, published: null, text: "" })), cost: 0.022, error: null }),
  lookup: async () => { throw new Error("the API must not be called on the page route"); },
  event: async () => { throw new Error("the API must not be called on the page route"); },
  lumaApi: () => true,
  apiState: async () => o.state ?? "denied",
  denial: () => ({ at: Date.now(), until: Date.now() + 30 * 60_000, status: 403, message: "Your calendar must have an active Luma Plus plan to make API requests", streak: 1 }),
  page: async (slug: string) => (reads.push(slug), classify(pageWorld[slug] ?? (slug === "discover" ? { html: CAL, status: 200, error: null } : { html: null, status: 404, error: "HTTP 404" }))),
  configured: () => true,
  now: () => new Date(),
  refusing: () => false,
  pauseMinutes: 10,
  reserve: async () => ({ ok: true, reason: null }),
  place: async (c: string | null) => (c ? { name: c } : null),
});
const run = (found: string[], o: { reset?: boolean; city?: string; what?: string; inRange?: (s: string) => boolean } = {}) => {
  V.clearLumaViaExaCache();
  if (o.reset !== false) V.resetLumaPages();
  return V.lumaEventsViaExa(o.what ?? "founder dinners", o.city ?? "San Francisco", { userId: null, source: "sweep", inRange: o.inRange ?? (() => true), dates: "November 10 to November 24, 2026", deps: via({ found }) as any });
};
const page = (o: Ev = {}) => ({ html: html(o), status: 200, error: null });
{
  exaCalls = 0; reads = [];
  pageWorld = {
    good1: page({ id: "evt-good1", slug: "good1" }),
    wait1: page({ id: "evt-wait1", slug: "wait1", registration: "waitlist", soldOut: true, approval: true, spots: 0 }),
    appr1: page({ id: "evt-appr1", slug: "appr1", approval: true, addrVis: "guests-only" }),
    priv1: page({ id: "evt-priv1", slug: "priv1", visibility: "private" }),
    unk1: page({ id: "evt-unk1", slug: "unk1", visibility: null }),
    noidx: page({ id: "evt-noidx", slug: "noidx", noindex: true }),
    canc1: page({ id: "evt-canc1", slug: "canc1", status: "EventCancelled" }),
    past1: page({ id: "evt-past1", slug: "past1", start: at(-30), end: at(-27) }),
    nocity: page({ id: "evt-nocity", slug: "nocity", city: null }),
    zoom1: page({ id: "evt-zoom1", slug: "zoom1", loc: "zoom", city: null }),
    cal1: { html: CAL, status: 200, error: null },
    slow1: { html: null, status: null, error: "timed out (6s)" },
  };
  const r = await run([...Object.keys(pageWorld), "gone1"]);
  const kept = (r?.events ?? []).map((e) => e.api_id).sort();
  check("the page route keeps public, upcoming events with a confirmed place (approval-required and online included)", JSON.stringify(kept) === JSON.stringify(["evt-appr1", "evt-good1", "evt-wait1", "evt-zoom1"]), kept);
  check("no API call on the page route; one read per link (plus the free probe)", reads.filter((s) => s !== "discover").length === 13, reads);
  const rep = r!.report;
  check("each outcome counted apart: private, unknown and noindex as not public; cancelled; past; no place; calendar; missing; failed", rep.notPublic === 3 && rep.cancelled === 1 && rep.past === 1 && rep.noLocation === 1 && rep.calendars === 1 && rep.missing === 1 && rep.failed === 1, rep);
  check("...logged as the page route, the API's 403 named, and not a failure (the route answered)", rep.route === "page" && /HTTP 403/.test(rep.apiDown ?? "") && !rep.sourceDown && /1 of 13 Luma checks got no usable answer/.test(rep.error ?? ""), rep);
  const wait = r!.events.find((e) => e.api_id === "evt-wait1")!;
  check("a waitlisted event is kept and carried honestly: registration 'waitlist', waitlist only, not sold out (Royce, 2026-11-10), approval true", wait.details.registration === "waitlist" && wait.details.waitlist === true && wait.details.soldOut === false && wait.details.requiresApproval === true, wait.details);
  const appr = r!.events.find((e) => e.api_id === "evt-appr1")!;
  check("approval required is carried, not dropped; the street the host hides stays hidden, the city stays", appr.details.requiresApproval === true && appr.details.soldOut === false && appr.details.venue === null && appr.details.address === null && appr.city === "San Francisco", appr.details);
  const good = r!.events.find((e) => e.api_id === "evt-good1")!;
  check("the page's own zone, start, price and headcount travel with the find", good.details.timezone === "America/Los_Angeles" && good.details.price === "free" && good.details.guestCount === 12 && good.url === "https://lu.ma/good1", good.details);
  check("an online event (zoom) is online, with no city", r!.events.find((e) => e.api_id === "evt-zoom1")?.online === true);
}
{
  // Outside the asked window: by the page's own start.
  pageWorld = { late1: page({ id: "evt-late1", slug: "late1", start: at(24 * 30), end: at(24 * 30 + 2) }) };
  const r = await run(["late1"], { inRange: (s) => Date.parse(s) < Date.now() + 14 * 24 * H });
  check("outside the asked window: counted past, not kept", r!.events.length === 0 && r!.report.past === 1, r?.report);
}
{
  // The same event under two links (a custom slug and Luma's own): one event (its Luma id), and the feed's copy wins.
  pageWorld = { "founders-supper": page({ id: "evt-same", slug: "founders-supper" }), abc999: page({ id: "evt-same", slug: "founders-supper" }) };
  const r = await run(["founders-supper", "abc999"]);
  const merged = V.withExaEvents([{ api_id: "evt-same", url: "https://lu.ma/x7x7x7", name: "Feed copy", start_at: at(48), city: "San Francisco" }] as any[], r!.events as any[]);
  check("the same event at two links is one event once merged with the feed (by its Luma id)", merged.length === 1 && merged[0].name === "Feed copy", merged.map((m: any) => m.url));
  const alone = V.withExaEvents([] as any[], r!.events as any[]);
  check("...and once among Exa's own finds", alone.length === 1, alone.map((m: any) => m.url));
}
{
  // City mismatch: an SF event found for a Chicago ask never passes the nearby filter (services/tieredRecommendation.ts filterByRadius).
  pageWorld = { sf1: page({ id: "evt-sf1", slug: "sf1" }) };
  const r = await run(["sf1"], { city: "Chicago" });
  const near = await T.filterByRadius(r!.events, "Chicago", async (a, b) => a.toLowerCase() === b.toLowerCase());
  check("an event in another city than the ask's is dropped by the nearby filter", r!.events.length === 1 && near.length === 0, { found: r!.events.length, near: near.length });
}
{
  // Blocked: the route stops at the first block, leaves the rest unread, and pauses; the next search pays for nothing.
  exaCalls = 0; reads = [];
  pageWorld = { b1: page({ id: "evt-b1", slug: "b1" }), b2: { html: null, status: 429, error: "HTTP 429" }, b3: page({ id: "evt-b3", slug: "b3" }), b4: page({ id: "evt-b4", slug: "b4" }), b5: page({ id: "evt-b5", slug: "b5" }), b6: page({ id: "evt-b6", slug: "b6" }), b7: page({ id: "evt-b7", slug: "b7" }) };
  const r = await run(["b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
  check("a block stops the route: the next batch is never read", !reads.includes("b6") && !reads.includes("b7") && (r!.report.blocked ?? 0) >= 3, { reads, rep: r!.report });
  check("...said once as a source-wide failure: unchecked, not 'no such event', with the pause", r!.report.sourceDown === true && /weren't served to us \(HTTP 429\)/.test(r!.report.error ?? "") && /went unchecked \(not "no such event"\)/.test(r!.report.error ?? "") && /tried again \(one free read\) in 30 minutes/.test(r!.report.error ?? ""), r!.report.error);
  check("the pause is in force", !!V.lumaPagesBlocked());
  const before = exaCalls;
  reads = [];
  const again = await run(["b1"], { reset: false });
  check("while paused (and the API down too): no Exa search, no page read, a source-wide failure", exaCalls === before && reads.length === 0 && again!.report.sourceDown === true && again!.events.length === 0, { exaCalls, reads, rep: again!.report });
}
{
  // Before the first search: a free probe; one that's blocked means no paid search at all.
  exaCalls = 0; reads = [];
  pageWorld = { discover: { html: null, status: 403, error: "HTTP 403" } };
  const r = await run(["x1"]);
  check("the free probe blocked: no Exa search, a source-wide failure", exaCalls === 0 && reads.join(",") === "discover" && r!.report.sourceDown === true, { exaCalls, reads, rep: r!.report });
  pageWorld = { discover: { html: null, status: null, error: "timed out (6s)" } };
  exaCalls = 0;
  const u = await run(["x1"]);
  check("a probe with no answer: no Exa search this time either (unknown isn't usable)", exaCalls === 0 && u!.report.sourceDown === true, u?.report);
}
{
  // With the API working, the API route is used and pages are never read for it.
  exaCalls = 0; reads = [];
  pageWorld = { good1: page({ id: "evt-good1", slug: "good1" }) };
  const d: any = { ...via({ found: ["good1"], state: "ok" }), lookup: async () => null, event: async () => null };
  V.clearLumaViaExaCache();
  V.resetLumaPages();
  const r = await V.lumaEventsViaExa("founder dinners", "San Francisco", { userId: null, source: "sweep", inRange: () => true, dates: "November 10 to November 24, 2026", deps: d });
  check("API healthy: the API route, no page reads", r!.report.route === "api" && reads.length === 0, { reads, rep: r!.report });
}

// ================================================================ the send-time re-read (services/sendCheck.ts recheckFind)
{
  const now = new Date();
  const m = (tier: 1 | 2) => ({ tier, kind: tier === 1 ? "co_event" : "public_event", event_api_id: "evt-1", event_date: at(48).slice(0, 10), name: "Founders Supper", url: "https://lu.ma/aaa111", reason: "" }) as any;
  const deps = (d: any) => ({ luma: async () => d, page: async () => ({ text: null, gone: false }) }) as any;
  const pv = E.parseLumaEventPage(html({ visibility: "private" }))!;
  const r2 = await SC.recheckFind(m(2), { now, zone: "America/Los_Angeles", deps: deps(pv) });
  check("a queued public find whose page is private now is never sent (an exit)", !r2.ok && r2.exit === true && /private, not public/.test(r2.why), r2);
  const r1 = await SC.recheckFind(m(1), { now, zone: "America/Los_Angeles", deps: deps(pv) });
  check("a Noise event (tier 1) is ours to share, whatever its listing", r1.ok === true, r1);
  const cx = E.parseLumaEventPage(html({ status: "EventCancelled" }))!;
  const rc = await SC.recheckFind(m(2), { now, zone: "America/Los_Angeles", deps: deps(cx) });
  check("cancelled on its page now: an exit, as cancelled", !rc.ok && rc.exit === true && (rc as any).state === "cancelled", rc);
  const so = E.parseLumaEventPage(html({ registration: "sold-out", soldOut: false }))!;
  const rs = await SC.recheckFind(m(2), { now, zone: "America/Los_Angeles", deps: deps(so) });
  check("sold out by its registration state alone: an exit (it used to read as open)", !rs.ok && /sold out/.test((rs as any).why), rs);
  const okp = E.parseLumaEventPage(html())!;
  const ro = await SC.recheckFind(m(2), { now, zone: "America/Los_Angeles", deps: deps(okp) });
  check("still public, open and ahead: it goes", ro.ok === true, ro);
}

console.log(`lumaPages: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
