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
check("the zone is looked up from the city alone: never the street or the venue", asked.join("|") === "San Francisco", asked);
check("a zone from the city for a UTC start is kept unverified (a guess)", f.timezone?.value === "America/Los_Angeles" && f.timezone?.verified === false && !/Sansome|Werqwise/.test(f.timezone?.quote ?? ""), f.timezone);
const said = L.saidTime(f.start!.value, f.timezone);
check("COPY: a guessed zone is said as a guess: around Wednesday 5pm, judging by the city", /^around Wednesday, October 7 at 5:00 PM (PDT|PST), judging by the city$/.test(said), said);
check("Partiful: only the city, never the street or the venue the host keeps for confirmed guests", f.address?.value === "San Francisco, California" && !f.venue && !JSON.stringify(f).includes("1301 Sansome"), f);
const eb = L.structuredEvent(rooftop)!;
await L.settleRead(eb, rooftop, "https://www.eventbrite.com/e/123", zoneOf);
check("another site's address is kept whole", eb.address?.value === "1301 Sansome St, San Francisco, California", eb.address);
const offsetPage = page({ name: "x", startDate: "2026-10-07T17:00:00-07:00", location: { name: "Somewhere", address: { addressLocality: "San Francisco" } } });
const offset = L.structuredEvent(offsetPage)!;
await L.settleRead(offset, offsetPage, "https://www.eventbrite.com/e/1", zoneOf);
check("a start that carries the city zone's own offset: the zone only names it, verified, said plainly", offset.timezone?.verified === true && /^Wednesday, October 7 at 5:00 PM PDT$/.test(L.saidTime(offset.start!.value, offset.timezone)), { tz: offset.timezone, said: L.saidTime(offset.start!.value, offset.timezone) });
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
check("Partiful's own zone: no lookup, verified, said plainly", asked.length === 0 && pz.timezone?.verified === true && !/around/.test(L.saidTime(pz.start!.value, pz.timezone)));
check("one zone rule: the link read and the live page read both settle through settleRead; settleStructured is gone", /if \(structured\) await settleRead\(structured, got\.body, got\.finalUrl\);/.test(src("services/linkReader.ts")) && /await settleRead\(f, r\.body, r\.finalUrl\);[\s\S]{0,200}saidTime\(f\.start\.value, f\.timezone\)/.test(src("harness/replyGrounding.ts")) && !/settleStructured/.test(src("services/linkReader.ts") + src("harness/replyGrounding.ts")));

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
check("COPY: its line says the time as a guess: starts around ... judging by the city it's in", /^"Rooftop" starts around Wednesday, October 7 at 5:00 PM (PDT|PST), judging by the city it's in\.$/.test(lines[0]), lines[0]);
const exact = await P.settleZone({ ...guessed!, zoneGuessed: undefined, timezone: null, startAt: "2026-10-07T17:00:00-07:00" }, zoneOf);
check("a start carrying the zone's offset isn't a guess", !exact?.zoneGuessed && /^"Rooftop" starts Wednesday, October 7 at 5:00 PM \(America\/Los_Angeles\)\.$/.test(ED.renderEventDetails("Rooftop", exact!)[0]));

console.log(`event page read: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
