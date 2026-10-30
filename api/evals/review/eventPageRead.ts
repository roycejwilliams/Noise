// An event page's own data, settled before Cue says it (2026-10-28 Partiful read test, #298 rebuilt on eventPage.ts: one zone rule, one
// Partiful rule). Layer 1, zero tokens, no outside calls: the zone lookup is injected; invented events.
//   npx tsx evals/review/eventPageRead.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [] });
import { readFileSync } from "fs";
const L = await import("../../src/services/linkReader.js");
const P = await import("../../src/services/eventPage.js");
const W = await import("../../src/services/webOpportunitySearch.js");
const ED = await import("../../src/services/eventDetails.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail)}` : ""}`); } };
const page = (ev: object, extra = "") => `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Event", ...ev })}</script>${extra}</head><body>x</body></html>`;
const rooftopEv = { name: "Founder & Investor Rooftop Mixer", startDate: "2026-10-08T00:00:00.000Z", endDate: "2026-10-08T03:00:00.000Z", location: { "@type": "Place", name: "Werqwise SF", address: { "@type": "PostalAddress", streetAddress: "1301 Sansome St", addressLocality: "San Francisco", addressRegion: "California" } }, organizer: { name: "Venture Bridge Hub" } };
const rooftop = page(rooftopEv);
const asked: string[] = [];
const zoneOf = async (p: string) => (asked.push(p), /San Francisco/.test(p) ? "America/Los_Angeles" : null);
const PARTIFUL = "https://partiful.com/e/q4NrvVRpxwvwuGLJfUcT";

// The zone: from the city only, a guess when the start doesn't carry it, said as one.
const f = L.structuredEvent(rooftop)!;
await L.settleRead(f, rooftop, PARTIFUL, zoneOf);
// With the region its record lists (2026-10-29 place audit: a bare city can be another state's).
check("the zone is looked up from the city and its listed region alone: never the street or the venue", asked.join("|") === "San Francisco, California", asked);
check("a zone from the city for a UTC start is kept unverified (a guess)", f.timezone?.value === "America/Los_Angeles" && f.timezone?.verified === false && !/Sansome|Werqwise/.test(f.timezone?.quote ?? ""), f.timezone);
check("a guessed zone keeps the city it's assumed from (never a street)", f.timezone?.quote === "San Francisco", f.timezone);
const said = L.timeFact(f.start!.value, f.timezone, "Founder & Investor Rooftop Mixer");
check("COPY (Royce 10-28): the listed time in the assumed zone, short zone name, never 'around'; the assumption names the city", said.said === "Wednesday, October 7 at 5 PM PT" && said.note === "The listing doesn't specify a timezone, so I'm assuming local time in San Francisco." && said.assumed, said);
check("Partiful: only the city, never the street or the venue the host keeps for confirmed guests", f.address?.value === "San Francisco, California" && !f.venue && !JSON.stringify(f).includes("1301 Sansome"), f);
const eb = L.structuredEvent(rooftop)!;
await L.settleRead(eb, rooftop, "https://www.eventbrite.com/e/123", zoneOf);
check("another site's address is kept whole", eb.address?.value === "1301 Sansome St, San Francisco, California", eb.address);
const offsetPage = page({ name: "x", startDate: "2026-10-07T17:00:00-07:00", location: { name: "Somewhere", address: { addressLocality: "San Francisco" } } });
const offset = L.structuredEvent(offsetPage)!;
await L.settleRead(offset, offsetPage, "https://www.eventbrite.com/e/1", zoneOf);
check("a start that carries the city zone's own offset: the zone only names it, verified, said plainly", offset.timezone?.verified === true && /^Wednesday, October 7 at 5:00 PM PDT$/.test(L.saidTime(offset.start!.value, offset.timezone)), { tz: offset.timezone, said: L.saidTime(offset.start!.value, offset.timezone) });
// Royce 10-28, case 3: no zone Cue can establish (online, no city, a failed lookup): no time turned into a confirmed one.
const UNCLEAR = 'The listing for "Launch Night" doesn\'t say what time zone its start time is in. Check the page before you plan around it.';
check("COPY: a UTC start with no zone established: no time at all, the listing's zone said to be unclear", JSON.stringify(L.timeFact("2026-10-08T00:00:00Z", null, "Launch Night")) === JSON.stringify({ said: null, note: UNCLEAR, assumed: false }));
check("an offset-less start with no zone: no time either", L.timeFact("2026-10-07T17:00:00", null, "Launch Night").said === null);
check("a start with its own offset and no zone: the listing's own time, said as listed (nothing converted)", L.timeFact("2026-10-07T17:00:00-07:00", null, "Launch Night").said === "Wednesday, October 7 at 5 PM (UTC\u22127, as listed)", L.timeFact("2026-10-07T17:00:00-07:00", null, "Launch Night"));
asked.length = 0;
const onlinePage = page({ name: "x", startDate: "2026-10-08T00:00:00Z", eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode", location: { name: "Zoom", address: { addressLocality: "San Francisco" } } });
const online = L.structuredEvent(onlinePage)!;
await L.settleRead(online, onlinePage, "https://www.eventbrite.com/e/2", zoneOf);
check("an online event gets no zone lookup", asked.length === 0 && !online.timezone);
const venueOnlyPage = page({ name: "x", startDate: "2026-10-08T00:00:00Z", location: { name: "Werqwise SF" } });
const venueOnly = L.structuredEvent(venueOnlyPage)!;
await L.settleRead(venueOnly, venueOnlyPage, "https://www.eventbrite.com/e/3", zoneOf);
check("a venue alone is never looked up", asked.length === 0 && !venueOnly.timezone);
const nowhere = L.structuredEvent(rooftop)!;
await L.settleRead(nowhere, rooftop, "https://www.eventbrite.com/e/4", async () => { throw new Error("geocoder down"); });
check("a failed lookup leaves the time as it was, never throws", !nowhere.timezone && nowhere.start?.value === "2026-10-08T00:00:00.000Z");
const ownZone = page(rooftopEv, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { event: { timezone: "America/Los_Angeles", isPublic: true } } } })}</script>`);
asked.length = 0;
const pz = L.structuredEvent(ownZone)!;
await L.settleRead(pz, ownZone, PARTIFUL, zoneOf);
check("Partiful's own zone: no lookup, verified, said plainly", asked.length === 0 && pz.timezone?.verified === true && !/assuming|around/.test(L.saidTime(pz.start!.value, pz.timezone)));
// The link read's facts handed to the model (describeRead): the time in the assumed zone, the disclosure naming the city, marked.
const readOf = (fields: any) => ({ url: "https://www.eventbrite.com/e/1", finalUrl: "https://www.eventbrite.com/e/1", status: "ok", why: null, fields, summary: null, source: "structured", fetchedAt: new Date() }) as any;
const assumedRead = L.describeRead("Launch Night", readOf({ name: { value: "Launch Night", quote: "Launch Night", verified: true }, start: { value: "2026-10-08T00:00:00.000Z", quote: "x", verified: true }, timezone: { value: "America/Los_Angeles", quote: "San Francisco", verified: false } }));
check("COPY: the link read's fact gives the time in the assumed zone, then the disclosure naming the city, marked to be said once and kept", /start: Wednesday, October 7 at 5 PM PT/.test(assumedRead.facts.join(" ")) && assumedRead.facts.some((x) => x === "About that time: The listing doesn't specify a timezone, so I'm assuming local time in San Francisco. Say this assumption once when you give the time, in these words or close to them, and don't leave it out.") && !/around|12:00 AM/.test(assumedRead.facts.join(" ")), assumedRead.facts);
const unclearRead = L.describeRead("Launch Night", readOf({ name: { value: "Launch Night", quote: "Launch Night", verified: true }, start: { value: "2026-10-08T00:00:00Z", quote: "x", verified: true } }));
check("COPY: with no zone, the link read's facts give no start time, only that the listing's zone is unclear", !/start:/.test(unclearRead.facts.join(" ")) && unclearRead.facts.includes(UNCLEAR) && !/12:00 AM/.test(unclearRead.facts.join(" ")), unclearRead.facts);
const SW = await import("../../src/services/staleWatch.js");
const prevRead = readOf({ start: { value: "2026-10-07T23:00:00Z", quote: "x", verified: true } });
const moved = SW.staleChange(prevRead, readOf({ start: { value: "2026-10-08T00:00:00Z", quote: "x", verified: true }, timezone: { value: "America/Los_Angeles", quote: "San Francisco", verified: false } }));
check("COPY: a moved start (stale watch) says the new time in the assumed zone and the city it's assumed from", moved?.detail === "it now starts Wednesday, October 7 at 5 PM PT (the listing doesn't specify a timezone, so I'm assuming local time in San Francisco)", moved);
const movedUnclear = SW.staleChange(prevRead, readOf({ start: { value: "2026-10-08T00:00:00Z", quote: "x", verified: true } }));
check("COPY: a moved start with no zone gives no time", movedUnclear?.detail === "its start time changed, and the listing doesn't say what time zone it's in. Check the page before you plan around it", movedUnclear);
check("one zone rule: the link read and the live page read both settle through settleRead; settleStructured is gone", /if \(structured\) await settleRead\(structured, got\.body, got\.finalUrl\);/.test(src("services/linkReader.ts")) && /await settleRead\(f, r\.body, r\.finalUrl\);[\s\S]{0,200}timeFact\(f\.start\.value, f\.timezone/.test(src("harness/replyGrounding.ts")) && !/settleStructured/.test(src("services/linkReader.ts") + src("harness/replyGrounding.ts")));

// The street never reaches text, an excerpt or the reply from a page that withholds it.
const withData = page(rooftopEv, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { event: { location: "Werqwise SF, 1301 Sansome St, San Francisco, CA", locationInfo: { displayAddressLines: ["1301 Sansome St", "San Francisco, CA"] } } } } })}</script>`).replace("<body>x</body>", "<body><p>Founder & Investor Rooftop Mixer. Sign in for full location. San Francisco, CA. Hosted by Venture Bridge Hub.</p></body>");
check("the link read's page text (and so its excerpt and the model's read) has no street for a Partiful page", !/Sansome/.test(L.pageText(withData, PARTIFUL)) && /Sign in for full location/.test(L.pageText(withData, PARTIFUL)), L.pageText(withData, PARTIFUL));
check("another site's page text keeps its schema.org data as before", /Sansome/.test(L.pageText(withData, "https://www.eventbrite.com/e/5")));
check("the web read's text (scriptText) has no street for a Partiful page", !/Sansome/.test(W.htmlToText(withData, PARTIFUL)) && /Sign in for full location/.test(W.htmlToText(withData, PARTIFUL)), W.htmlToText(withData, PARTIFUL));
check("another page's script text is still read (NFX's data-only facts)", /Sansome/.test(W.htmlToText(withData, "https://www.nfx.com/x")) && /Sansome/.test(W.htmlToText(withData)));
check("the readers pass the page's url: the link read, the web read, the event-page read", /const text = pageText\(got\.body, got\.finalUrl\);/.test(src("services/linkReader.ts")) && /htmlToText\(res!\.body, res!\.finalUrl \?\? u\.toString\(\)\)/.test(src("services/webOpportunitySearch.ts")) && /d\.toText\(got\.html, url\)/.test(src("services/eventPage.ts")));

// The event tier's own lines say a guessed zone as a guess too.
const guessed = await P.settleZone({ name: "Rooftop", startAt: "2026-10-08T00:00:00.000Z", endAt: null, timezone: null, online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: null, soldOut: null, guestCount: null, description: null }, zoneOf);
check("an event page's zone from its city is marked a guess for a UTC start", guessed?.zoneGuessed === true);
const lines = ED.renderEventDetails("Rooftop", guessed!);
check("COPY: an event find's line: the time as listed in the assumed zone, then the assumption naming the city", lines[0] === `"Rooftop" starts Wednesday, October 7 at 5 PM PT. The listing doesn't specify a timezone, so I'm assuming local time in San Francisco.`, lines[0]);
check("on the half hour it says 5:30 PM", ED.renderEventDetails("Launch Night", { ...guessed!, startAt: "2026-10-08T00:30:00.000Z" })[0] === `"Launch Night" starts Wednesday, October 7 at 5:30 PM PT. The listing doesn't specify a timezone, so I'm assuming local time in San Francisco.`);
check("COPY: an event with no zone and no offset of its own: no time, the listing's zone unclear", ED.renderEventDetails("Launch Night", { ...guessed!, zoneGuessed: undefined, timezone: null })[0] === UNCLEAR);
const exact = await P.settleZone({ ...guessed!, zoneGuessed: undefined, timezone: null, startAt: "2026-10-07T17:00:00-07:00" }, zoneOf);
check("a start carrying the zone's offset isn't a guess", !exact?.zoneGuessed && /^"Rooftop" starts Wednesday, October 7 at 5:00 PM \(America\/Los_Angeles\)\.$/.test(ED.renderEventDetails("Rooftop", exact!)[0]));

// Final review of #298: no zone of its own but an offset in its start: its own offset, as listed, never the next day in UTC.
const listed = ED.renderEventDetails("Launch Night", { ...guessed!, zoneGuessed: undefined, timezone: null, startAt: "2026-10-07T17:00:00-07:00", endAt: "2026-10-07T20:00:00-07:00" });
check("COPY (approved by Royce 2026-10-28): an offset start with no zone, as listed, with its end", listed[0] === `"Launch Night" starts Wednesday, October 7 at 5 PM (UTC\u22127, as listed) and ends at 8 PM.` && !/Thursday|12:00 AM/.test(listed[0]), listed[0]);
const lineFor = (startAt: string, endAt: string | null) => ED.renderEventDetails("Launch Night", { ...guessed!, zoneGuessed: undefined, timezone: null, startAt, endAt })[0];
check("on the half hour: 5:30 PM; a half-hour offset: UTC+5:30", lineFor("2026-10-07T17:30:00+05:30", null) === `"Launch Night" starts Wednesday, October 7 at 5:30 PM (UTC+5:30, as listed).`, lineFor("2026-10-07T17:30:00+05:30", null));
check("an end on another day names the day", lineFor("2026-10-07T21:00:00-07:00", "2026-10-08T01:00:00-07:00") === `"Launch Night" starts Wednesday, October 7 at 9 PM (UTC\u22127, as listed) and ends Thursday at 1 AM.`, lineFor("2026-10-07T21:00:00-07:00", "2026-10-08T01:00:00-07:00"));
check("no end in the listing: none said; the true minus sign, never a hyphen", lineFor("2026-10-07T17:00:00-07:00", null) === `"Launch Night" starts Wednesday, October 7 at 5 PM (UTC\u22127, as listed).` && !/UTC-/.test(lineFor("2026-10-07T17:00:00-07:00", null)));

// The live check ("still spots?"): a time with no zone isn't said; the listing's zone is said to be unclear in its place.
const A = await import("../../src/services/asOf.js");
const live = await A.liveDetailFacts("is it still on? any spots left?", [{ name: "Launch Night", url: "https://www.eventbrite.com/e/9", sentAt: new Date() } as any], { luma: async () => null, isLuma: () => false, page: async () => ({ timeNote: "The listing for \"Launch Night\" doesn't say what time zone its start time is in. Check the page before you plan around it", cost: "free" }) }).catch((e) => [String(e)]);
check("the live check says the listing's zone is unclear instead of a time", live.some((l) => /doesn't say what time zone its start time is in/.test(l) && !/starts /.test(l)), live);
check("livePageFacts hands back no start and a note when the zone can't be established", /\.\.\.\(t && !t\.said && t\.note \? \{ timeNote: t\.note\.replace/.test(src("harness/replyGrounding.ts")));

console.log(`event page read: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
