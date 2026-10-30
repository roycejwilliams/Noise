// Bare place names are never written to the geocode cache (2026-10-29 place audit: bare rows held Auburn in Alabama, Davis as Davis
// County, Utah, Emerald Hills in Georgia and Bay Area in Houston, for California members, and each answered every later caller).
// Zero tokens: Google, the open geocoder and the database are stubs; no outside call.
//   TZ=UTC node evals/runLayer1.mjs evals/discovery/barePlaces.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const G = await import("../../src/services/geocoding.js");
const P = await import("../../src/services/eventPage.js");
const ED = await import("../../src/services/eventDetails.js");
const MG = await import("../../src/harness/matchGate.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

type Pt = { lat: number; lng: number };
const SACRAMENTO = { lat: 38.5816, lng: -121.4944 };
const DAVIS_CA = { lat: 38.5449, lng: -121.7405 };
const DAVIS_UT = { lat: 40.963, lng: -112.095 };
const AUBURN_CA = { lat: 38.8966, lng: -121.0769 };
const AUBURN_AL = { lat: 32.6099, lng: -85.4808 };
const LONDON_UK = { lat: 51.5072, lng: -0.1276 };
const PARIS_FR = { lat: 48.8566, lng: 2.3522 };
const TORONTO_CA = { lat: 43.6532, lng: -79.3832 };

// Google: a bare name with no bias gets its default (the wrong state for Auburn and Davis, as the bad rows held); with a viewport
// near a point (bounds), the place inside it. A qualified name gets that place.
let googleAsked: { address: string; near: Pt | null }[] = [];
let googleDown = false;
const inBox = (p: Pt, n: Pt) => Math.abs(p.lat - n.lat) <= 0.75 && Math.abs(p.lng - n.lng) <= 0.75;
const GOOGLE: Record<string, Pt[]> = {
  Auburn: [AUBURN_AL, AUBURN_CA],
  Davis: [DAVIS_UT, DAVIS_CA],
  London: [LONDON_UK],
  Paris: [PARIS_FR],
  Toronto: [TORONTO_CA],
  "Auburn, CA": [AUBURN_CA],
  "Davis, CA": [DAVIS_CA],
  "Sacramento, CA": [SACRAMENTO],
};
G.geoDeps.google = (async (address: string, near: Pt | null = null) => {
  googleAsked.push({ address, near });
  if (googleDown) throw new Error("REQUEST_DENIED");
  const all = GOOGLE[address] ?? [];
  const pts = near ? [...all.filter((p) => inBox(p, near)), ...all.filter((p) => !inBox(p, near))] : all;
  return { data: { results: pts.slice(0, 1).map((p) => ({ geometry: { location: p } })) } };
}) as any;

// The open geocoder (fallback only).
let omAsked: string[] = [];
let omMode: "up" | "down" | "hang" = "up";
let omSignal: AbortSignal | null = null;
const ppl = (name: string, admin1: string, cc: string, p: Pt) => ({ name, admin1, country_code: cc, country: cc, feature_code: "PPL", latitude: p.lat, longitude: p.lng });
const OPEN_METEO: Record<string, any[]> = {
  davis: [ppl("Davis", "Utah", "US", DAVIS_UT), ppl("Davis", "California", "US", DAVIS_CA)],
  auburn: [ppl("Auburn", "Alabama", "US", AUBURN_AL), ppl("Auburn", "California", "US", AUBURN_CA)],
};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.host !== "geocoding-api.open-meteo.com") throw new Error(`barePlaces: refused outside call to ${url.host}`);
  omAsked.push(String(url.searchParams.get("name")));
  omSignal = init?.signal ?? null;
  if (omMode === "down") return new Response("down", { status: 503 });
  if (omMode === "hang") return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  return new Response(JSON.stringify({ results: OPEN_METEO[String(url.searchParams.get("name")).toLowerCase()] ?? [] }), { status: 200 });
}) as typeof fetch;

let cache = new Map<string, Pt & { timezone?: string | null }>();
let writes: { sql: string; args: any[] }[] = [];
(pool as any).query = async (sql: string, args: any[] = []) => {
  if (/SELECT lat, lng(, timezone)? FROM geocode_cache WHERE query = \$1/.test(sql)) { const r = cache.get(args[0]); return { rows: r ? [{ ...r }] : [] }; }
  if (/INSERT INTO geocode_cache/.test(sql)) { writes.push({ sql, args }); if (!cache.has(args[0])) cache.set(args[0], { lat: args[1], lng: args[2] }); return { rows: [] }; }
  if (/UPDATE geocode_cache SET timezone/.test(sql)) { writes.push({ sql, args }); const r = cache.get(args[1]); if (r) r.timezone = args[0]; return { rows: [] }; }
  return { rows: [] };
};
const reset = () => { googleAsked = []; omAsked = []; writes = []; cache = new Map(); googleDown = false; omMode = "up"; omSignal = null; G.clearBareMemo(); G.resetOpenMeteoDown(); };
const cachedUnder = (q: string) => writes.some((w) => /INSERT INTO geocode_cache/.test(w.sql) && w.args[0] === q);
const anyInsert = () => writes.some((w) => /INSERT INTO geocode_cache/.test(w.sql));
const miles = (a: Pt | null, b: Pt) => (a ? G.haversineMiles(a, b) : Infinity);

// ---- qualified vs bare ----
check("qualified: 'Auburn, CA', 'Auburn CA', 'Davis, California'; bare: 'Auburn', 'Bay Area'", G.isQualified("Auburn, CA") && G.isQualified("Auburn CA") && G.isQualified("Davis, California") && !G.isQualified("Auburn") && !G.isQualified("Bay Area"));

// ---- bare names are never cached ----
reset();
await G.geocodeCity("Auburn");
check("bare 'Auburn' with no context is not cached", !anyInsert(), writes);
check("... Google is the geocoder (the open one isn't asked)", googleAsked.map((g) => g.address).join() === "Auburn" && omAsked.length === 0, { googleAsked, omAsked });
reset();
await G.geocodeCity("Davis");
check("bare 'Davis' with no context is not cached", !anyInsert(), writes);
reset();
await G.geocodeCity("Auburn");
await G.geocodeCity("Auburn");
check("asked twice in a run: one Google call (kept in memory a few minutes, never a cache row)", googleAsked.length === 1 && !anyInsert(), googleAsked);
for (const [name, at] of [["London", LONDON_UK], ["Paris", PARIS_FR], ["Toronto", TORONTO_CA]] as const) {
  reset();
  const p = await G.geocodeCity(name);
  check(`bare '${name}' is Google's answer (not forced to a same-named US town), and not cached`, miles(p, at) < 1 && !anyInsert(), p);
}

// ---- qualified names cache as before ----
reset();
const auburnCA = await G.geocodeCity("Auburn, CA");
check("'Auburn, CA' caches under 'Auburn, CA'", cachedUnder("Auburn, CA") && miles(auburnCA, AUBURN_CA) < 1, writes);
reset();
await G.geocodeCity("Auburn", { region: "CA" });
check("bare 'Auburn' with a region (CA) is looked up and cached as 'Auburn, CA', never under 'Auburn'", cachedUnder("Auburn, CA") && !cachedUnder("Auburn"), writes);
reset();
cache.set("Sacramento", { ...SACRAMENTO });
const sac = await G.geocodeCity("Sacramento");
check("a row already in the cache is still read first (no lookup)", miles(sac, SACRAMENTO) < 1 && googleAsked.length === 0);

// ---- near: a bare name read near a point ----
reset();
const davisNear = await G.geocodeCity("Davis", { near: SACRAMENTO });
check("bare 'Davis' read near Sacramento: Google gets the viewport, and it's Davis, California", miles(davisNear, DAVIS_CA) < 1 && googleAsked[0]?.near === SACRAMENTO, { davisNear, googleAsked });
check("... and isn't cached", !anyInsert(), writes);

// ---- the open geocoder: fallback only, bounded ----
reset();
googleDown = true;
const fb = await G.geocodeCity("Davis", { near: SACRAMENTO });
check("Google down: the open geocoder answers, near the point (Davis, CA), and a bare name still isn't cached", miles(fb, DAVIS_CA) < 1 && omAsked.join() === "Davis" && !anyInsert(), { fb, omAsked, writes });
reset();
googleDown = true;
await G.geocodeCity("Davis, CA");
check("Google down: a qualified name from the open geocoder caches as before", cachedUnder("Davis, CA"), writes);
reset();
googleDown = true;
omMode = "hang";
const t0 = Date.now();
const keepAlive = setTimeout(() => {}, 10_000); // AbortSignal.timeout's timer doesn't hold the process open on its own
const hung = await G.geocodeCity("Auburn, CA");
clearTimeout(keepAlive);
check("the open geocoder is asked with a timeout signal, and a hang ends in it (null, nothing cached)", !!omSignal && hung === null && !anyInsert() && Date.now() - t0 < G.OPEN_METEO.timeoutMs + 2000, { ms: Date.now() - t0 });
check("its timeout is ~3s", G.OPEN_METEO.timeoutMs === 3000);
G.clearBareMemo();
googleAsked = []; omAsked = [];
await G.geocodeCity("Davis, CA");
check("after a failure it isn't asked again for a while (short failure memory)", omAsked.length === 0, omAsked);
reset();
check("the open geocoder is never the primary: geocodeCity reaches it only from Google's failure or no answer", (src("services/geocoding.ts").match(/openMeteoGeocode\(/g) ?? []).length === 3);

// ---- timezones ----
reset();
await G.getTimezoneForCity("Auburn");
check("getTimezoneForCity on bare 'Auburn' writes no cache row", !anyInsert(), writes);
reset();
const zoneCA = await G.getTimezoneForCity("Auburn", { region: "CA" });
check("getTimezoneForCity with a region: Auburn, CA, Pacific, cached with its zone", zoneCA === "America/Los_Angeles" && cachedUnder("Auburn, CA") && writes.some((w) => /UPDATE geocode_cache SET timezone/.test(w.sql) && w.args[1] === "Auburn, CA"), { zoneCA, writes });
check("getTimezoneForCity passes the city as given and its bias to geocodeCity (so the partial-match retry runs)", /const point = await geocodeCity\(city, bias\);/.test(src("services/geocoding.ts")));

// ---- an event page in Davis, CA ----
const page = (locality: string, region: string | null) => `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Event", name: "Farmers Market Social", startDate: "2026-11-07T10:00:00-07:00",
  location: { "@type": "Place", name: "Central Park", address: { "@type": "PostalAddress", addressLocality: locality, ...(region ? { addressRegion: region } : {}) } },
})}</script></head><body></body></html>`;
reset();
const ev = P.pageEventData(page("Davis", "CA"), "https://www.eventbrite.com/e/farmers-market-social-1", ED.parseLumaEventPage).event!;
check("an event page in Davis, CA keeps the city as listed and its region beside it", ev.city === "Davis" && ev.region === "CA", ev);
const settled = await P.settleZone(ev, (place) => G.getTimezoneForCity(place));
check("an event page in Davis, CA resolves to California (Pacific)", settled?.timezone === "America/Los_Angeles", settled);
check("... looked up and cached as 'Davis, CA', never bare 'Davis'", googleAsked.map((g) => g.address).join() === "Davis, CA" && cachedUnder("Davis, CA") && !cachedUnder("Davis"), { googleAsked, writes });
const asked: string[] = [];
const z = await P.zoneForPage(page("Davis", "CA"), "https://www.eventbrite.com/e/farmers-market-social-1", "2026-11-07T10:00:00", async (p) => (asked.push(p), "America/Los_Angeles"));
check("a link read's zone (zoneForPage) is looked up as 'Davis, CA', and the city alone stays the quote", asked.join() === "Davis, CA" && z.city === "Davis", { asked, z });

// ---- distance checks: the second city is read near the first ----
reset();
cache.set("Sacramento, CA", { ...SACRAMENTO });
const d = await MG.distanceBetween("Sacramento, CA", "Davis");
check("matchGate: an event in bare 'Davis' searched from Sacramento is ~13mi (Davis, CA), not 525mi (Utah)", d !== null && d < 25, d);
check("... and 'Davis' is not cached", !anyInsert(), writes);
reset();
cache.set("Sacramento, CA", { ...SACRAMENTO });
check("withinRadius: bare 'Auburn' from Sacramento is within the metro radius (Auburn, CA)", await G.withinRadius("Sacramento, CA", "Auburn"));
check("... and isn't cached", !anyInsert(), writes);

// ---- wiring ----
const jobs = src("jobs/index.ts");
check("jobs: every member-zone read is memberZone (the stored zone), no fresh city lookup", !/getTimezoneForCity/.test(jobs.replace(/\/\/.*$/gm, "")) && (jobs.match(/await memberZone\((user\.id|row\.user_id|userRows\[0\]\.user_id)\)/g) ?? []).length === 5);
check("relay: both member-zone reads are memberZone", !/getTimezoneForCity\(/.test(src("services/relay.ts")) && (src("services/relay.ts").match(/await memberZone\((to\.userId|r\.user_id)\)/g) ?? []).length === 2);
check("guest handoff and intro nudge: their zone is memberZone", [src("services/eventGuestMatchHandoff.ts"), src("services/networkIntroNudge.ts")].every((s) => /memberZone\(userId\)/.test(s) && !/getTimezoneForCity/.test(s)));
check("no phone-area-code state at these sites", ![jobs, src("services/relay.ts"), src("services/eventGuestMatchHandoff.ts"), src("services/networkIntroNudge.ts")].some((s) => /regionFor/.test(s)));
check("Co event announcement: the member's city read near the event's (withinRadius), never the phone's state", /withinRadius\(event\.city, r\.city\)/.test(src("services/coEventAnnouncement.ts")) && !/regionFor|phone_number\)/.test(src("services/coEventAnnouncement.ts").slice(src("services/coEventAnnouncement.ts").indexOf("const distances"))));
check("want places are untouched: placeResolve's home lookup is as it was", /home: async \(city\) => \(await import\("\.\/geocoding\.js"\)\)\.geocodeCity\(city\),/.test(src("services/placeResolve.ts")));

console.log(`bare places: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
