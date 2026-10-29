// Places resolve near home (2026-10-29): "Bay Area" from a Sacramento member was searched in Houston (the open geocoder's first US
// hit, a park, cached under the bare name). Zero tokens: the geocoders, the database and the clock are stubs; invented people.
// The open geocoder's candidates below are its real answers for these names (populated places only, as the lookup keeps them).
//   npx tsx evals/discovery/placeResolve.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
// No Google key: the real lookup below runs on the stubbed open geocoder only (no outside call).
process.env.GOOGLE_API_KEY = "";
process.env.GOOGLE_PLACES_API_KEY = "";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const R = await import("../../src/services/placeResolve.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
type C = import("../../src/services/placeResolve.js").PlaceCandidate;

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const om = (name: string, admin1: string, country: string, lat: number, lng: number, population: number | null): C => ({ name, admin1, country, lat, lng, population, source: "open_meteo" });
const OPEN: Record<string, C[]> = {
  // "Bay Area": the open geocoder has only parks and a heliport (not places), so nothing here.
  "bay area": [],
  portland: [om("Portland", "Oregon", "US", 45.52345, -122.67621, 652503), om("Portland", "Maine", "US", 43.65737, -70.2589, 66881), om("Portland", "Indiana", "US", 40.43449, -84.97775, 6186), om("Portland", "Texas", "US", 27.87725, -97.32388, 16116), om("Portland", "England", "GB", 50.56748, -2.44472, 12710)],
  cambridge: [om("Cambridge", "England", "GB", 52.2, 0.11667, 145674), om("Cambridge", "Massachusetts", "US", 42.3751, -71.10561, 110402), om("Cambridge", "Ontario", "CA", 43.3601, -80.31269, 129920), om("Cambridge", "Maryland", "US", 38.56317, -76.07883, 12507), om("Cambridge", "Ohio", "US", 40.03118, -81.58846, 10402)],
  springfield: [om("Springfield", "Missouri", "US", 37.21533, -93.29824, 170188), om("Springfield", "Illinois", "US", 39.80172, -89.64371, 114394), om("Springfield", "Massachusetts", "US", 42.10148, -72.58981, 154341), om("Springfield", "Ohio", "US", 39.92423, -83.80882, 59680), om("Springfield", "Oregon", "US", 44.04624, -123.02203, 60870)],
  "kansas city": [om("Kansas City", "Missouri", "US", 39.09973, -94.57857, 475378), om("Kansas City", "Kansas", "US", 39.11417, -94.62746, 152933), om("Kansas City", "Oregon", "US", 45.59595, -123.14705, null)],
  austin: [om("Austin", "Texas", "US", 30.26715, -97.74306, 974447), om("Austin", "Minnesota", "US", 43.66663, -92.97464, 24563), om("Austin", "Nevada", "US", 39.49326, -117.06953, 192)],
  "san francisco": [om("San Francisco", "California", "US", 37.77493, -122.41942, 864816)],
  dublin: [om("Dublin", "Leinster", "IE", 53.33306, -6.24889, 1024027), om("Dublin", "California", "US", 37.70215, -121.93579, 57721), om("Dublin", "Ohio", "US", 40.09923, -83.11408, 45098)],
};
const GOOGLE_SF_BAY: C = { name: "San Francisco Bay Area", admin1: "California", country: "US", lat: 37.8271784, lng: -122.2913078, population: null, source: "google" };
const cands = (place: string, google: C[] = []) => R.mergeCandidates(google, OPEN[R.normName(R.parseQualified(place).name)] ?? [], place);

const HOME = {
  sacramento: { lat: 38.5781342, lng: -121.4944209, country: "US" },
  houston: { lat: 29.7604, lng: -95.3698, country: "US" },
  bangor: { lat: 44.8012, lng: -68.7778, country: "US" },
  eugene: { lat: 44.0521, lng: -123.0868, country: "US" },
  boston: { lat: 42.3601, lng: -71.0589, country: "US" },
  london: { lat: 51.5072, lng: -0.1276, country: "GB" },
  chicago: { lat: 41.8781, lng: -87.6298, country: "US" },
  kcmo: { lat: 39.0997, lng: -94.5786, country: "US" },
  wichita: { lat: 37.6872, lng: -97.3301, country: "US" },
  seattle: { lat: 47.6062, lng: -122.3321, country: "US" },
  toronto: { lat: 43.6532, lng: -79.3832, country: "CA" },
};
const home = (h: { lat: number; lng: number; country: string }) => ({ point: { lat: h.lat, lng: h.lng }, country: h.country });
const pick = (place: string, h: keyof typeof HOME | null, google: C[] = []) => R.pickPlace(place, cands(place, google), h ? home(HOME[h]) : null);
const at = (p: ReturnType<typeof pick>) => (p.status === "resolved" ? `${p.place.name}|${p.place.admin1}` : p.status);

// ---------------------------------------------------------------- 1. the traps
check("'Bay Area' for a Sacramento member is the SF Bay Area", at(pick("Bay Area", "sacramento")) === "San Francisco Bay Area|California", pick("Bay Area", "sacramento"));
check("... and with Google answering the SF Bay Area, still that (one place, going by 'Bay Area')", at(pick("Bay Area", "sacramento", [GOOGLE_SF_BAY])) === "San Francisco Bay Area|California");
check("'Bay Area' for a Houston member is the Bay Area by Houston", at(pick("Bay Area", "houston")) === "Bay Area Houston|Texas" && at(pick("Bay Area", "houston", [GOOGLE_SF_BAY])) === "Bay Area Houston|Texas");
check("Bay Area Park (a park, not a place) is never a candidate", !R.mergeCandidates([], [], "Bay Area").some((c) => /park/i.test(c.name)) && /\^\(PPL\|ADM\)/.test(src("services/placeResolve.ts")));
check("Portland: Maine for a Maine member, Oregon for an Oregon member", at(pick("Portland", "bangor")) === "Portland|Maine" && at(pick("Portland", "eugene")) === "Portland|Oregon");
check("Portland from Sacramento (none near): the much bigger one, Oregon", at(pick("Portland", "sacramento")) === "Portland|Oregon");
check("Cambridge: Massachusetts for a Boston member, England for a London member", at(pick("Cambridge", "boston")) === "Cambridge|Massachusetts" && at(pick("Cambridge", "london")) === "Cambridge|England");
check("Springfield: Illinois from Chicago, Massachusetts from Boston, Missouri from Kansas City", at(pick("Springfield", "chicago")) === "Springfield|Illinois" && at(pick("Springfield", "boston")) === "Springfield|Massachusetts" && at(pick("Springfield", "kcmo")) === "Springfield|Missouri");
check("Springfield from Sacramento is ambiguous (Missouri, Massachusetts, Illinois are all about the same size)", pick("Springfield", "sacramento").status === "ambiguous", pick("Springfield", "sacramento"));
const kc = at(pick("Kansas City", "wichita"));
check("Kansas City from Wichita: Kansas or Missouri (both fine); from Sacramento: Missouri", (kc === "Kansas City|Kansas" || kc === "Kansas City|Missouri") && at(pick("Kansas City", "sacramento")) === "Kansas City|Missouri");
check("Austin from Sacramento is Austin, Texas (never Austin, Nevada, population 192, though it's closer)", at(pick("Austin", "sacramento")) === "Austin|Texas");
check("Dublin from Sacramento is Dublin, California (near home), not Ireland", at(pick("Dublin", "sacramento")) === "Dublin|California");
check("SF is San Francisco", at(pick("SF", "sacramento")) === "San Francisco|California");

// ---------------------------------------------------------------- 2. a qualified place must land where it says
check("'San Francisco Bay Area, CA, US' resolves there", at(pick("San Francisco Bay Area, CA, US", "houston", [GOOGLE_SF_BAY])) === "San Francisco Bay Area|California");
check("'Portland, ME' from Sacramento is Maine (the qualifier wins over size)", at(pick("Portland, ME", "sacramento")) === "Portland|Maine" && at(pick("Portland ME", "sacramento")) === "Portland|Maine");
check("'Cambridge, UK' from Boston is England (the qualifier wins over nearness)", at(pick("Cambridge, UK", "boston")) === "Cambridge|England");
const wrongState = pick("Portland, CA", "sacramento");
check("'Portland, CA' (no Portland in California) is rejected, not moved to another state", wrongState.status === "rejected" && (wrongState as any).why === "not_in_that_region", wrongState);
const wrongCountry = pick("Dublin, US", "london");
check("'Dublin, US' from London never resolves to Ireland (it's California or Ohio: ambiguous)", wrongCountry.status === "ambiguous" && !wrongCountry.options.some((o) => /Leinster|IE/.test(o)), wrongCountry);
check("hits that aren't the name asked for are rejected (the geocoder answered something else)", R.pickPlace("Bay Area", [om("Bay Area Park", "Texas", "US", 29.6, -95.1, null)], home(HOME.sacramento)).status === "rejected");
check("the label is always qualified (a state itself too), so geocoding it again downstream can't land elsewhere", R.placeLabel(OPEN.portland[1]) === "Portland, Maine" && R.placeLabel(OPEN.cambridge[0]) === "Cambridge, England, GB" && R.placeLabel(R.REGIONS[0]) === "San Francisco Bay Area, California" && R.placeLabel(om("Washington", "Washington", "US", 47.5, -120.5, 7_700_000)) === "Washington, US");
// Canada's provinces, and any region code the geocoder returns.
const VANCOUVER: C[] = [{ name: "Vancouver", admin1: "British Columbia", admin1Code: "BC", country: "CA", lat: 49.2827, lng: -123.1207, population: null, source: "google" }, om("Vancouver", "Washington", "US", 45.6387, -122.6615, 190915)];
check("'Vancouver, BC' resolves in British Columbia (a confirmed place with a province code isn't rejected)", (() => { const r = R.pickPlace("Vancouver, BC", VANCOUVER, home(HOME.sacramento)); return r.status === "resolved" && r.place.country === "CA"; })());
check("'Vancouver BC' (no comma) too, and plain 'Vancouver' from Sacramento is Vancouver, Washington (nearer, same country)", (() => { const a = R.pickPlace("Vancouver BC", VANCOUVER, home(HOME.sacramento)); const b = R.pickPlace("Vancouver", VANCOUVER, home(HOME.sacramento)); return a.status === "resolved" && a.place.country === "CA" && b.status === "resolved" && b.place.admin1 === "Washington"; })());
check("'London, ON' resolves in Ontario, not England", (() => { const r = R.pickPlace("London, ON", [om("London", "England", "GB", 51.5072, -0.1276, 8_961_989), om("London", "Ontario", "CA", 42.9849, -81.2453, 383822)], home(HOME.sacramento)); return r.status === "resolved" && r.place.admin1 === "Ontario"; })());
check("a region code only the geocoder knows ('Sydney, NSW') matches its admin1 code", (() => { const r = R.pickPlace("Sydney, NSW", [{ name: "Sydney", admin1: "New South Wales", admin1Code: "NSW", country: "AU", lat: -33.8688, lng: 151.2093, population: null, source: "google" }, om("Sydney", "Nova Scotia", "CA", 46.1368, -60.1942, 31597)], home(HOME.sacramento)); return r.status === "resolved" && r.place.country === "AU"; })());
check("an unsized Google hit near home never beats a known bigger place by that name (the 5k floor holds for Google too)", at(R.pickPlace("Austin", [{ name: "Austin", admin1: "Nevada", country: "US", lat: 39.49326, lng: -117.06953, population: null, source: "google" }, OPEN.austin[0]], home(HOME.sacramento))) === "Austin|Texas");
check("their country comes from the geocoder, not a box on the map: a Toronto member's 'Cambridge' is Cambridge, Ontario", R.countryAt(HOME.toronto, [om("Toronto", "Ontario", "CA", 43.70011, -79.4163, 2_600_000)]) === "CA" && at(pick("Cambridge", "toronto")) === "Cambridge|Ontario");

// ---------------------------------------------------------------- 3. the far-from-home check: confirmed vs inferred, and windows
check("how: their words and their correction are confirmed; Cue's read of their lines is inferred", R.placeHow("their_words") === "confirmed" && R.placeHow("corrected") === "confirmed" && R.placeHow("told") === "inferred" && R.placeHow("home") === "inferred");
check("a confirmed place far from home is searched", R.farCheck({ miles: 1500, how: "confirmed", windowEnd: null, today: "2026-10-29" }) === "far_named_by_them");
check("an inferred place far from home is not searched", R.farCheck({ miles: 1500, how: "inferred", windowEnd: null, today: "2026-10-29" }) === "far_not_searched");
check("... unless this want's own window covers it, and only until the window ends", R.farCheck({ miles: 1500, how: "inferred", windowEnd: "2026-11-02", today: "2026-10-29" }) === "far_in_window" && R.farCheck({ miles: 1500, how: "inferred", windowEnd: "2026-10-28", today: "2026-10-29" }) === "far_not_searched");
check("near home is never held", R.farCheck({ miles: 80, how: "inferred", windowEnd: null, today: "2026-10-29" }) === "near");

// The full resolution of one want, with its record stubbed.
function deps(o: { stored?: any; windowEnd?: string | null; google?: Record<string, C[]>; homeCity?: Record<string, { lat: number; lng: number; country: string }> } = {}) {
  const logs: any[] = [];
  const stores: any[] = [];
  const seeds: any[] = [];
  const lookups: string[] = [];
  const d: import("../../src/services/placeResolve.js").ResolveDeps = {
    home: async (city) => {
      const h = (o.homeCity ?? { Sacramento: HOME.sacramento, Houston: HOME.houston, Seattle: HOME.seattle })[city];
      return h ? home(h as any) : null;
    },
    lookup: async (place) => (lookups.push(place), { google: o.google?.[R.normName(place)] ?? [], openMeteo: OPEN[R.normName(R.parseQualified(place).name)] ?? [] }),
    row: async () => ({ windowEnd: o.windowEnd ?? null, resolution: o.stored ?? null }),
    store: async (_u, _k, r) => void stores.push(r),
    seed: async (label, p) => void seeds.push({ label, p }),
    log: async (x) => void logs.push(x),
    today: async () => "2026-10-29",
  };
  return { d, logs, stores, seeds, lookups };
}
{
  const t = deps();
  const r = await R.resolveWantPlace({ userId: "u1", key: "ask:a1", place: "Bay Area", source: "their_words", homeCity: "Sacramento" }, t.d);
  check("a Sacramento member's Bay Area ask searches 'San Francisco Bay Area, California'", r.city === "San Francisco Bay Area, California" && !r.skip && r.place?.verdict === "near" && (r.place?.miles ?? 999) < 100, r);
  check("... the resolution is kept on the want (for this place and this home), and its label seeded for downstream lookups", t.stores[0]?.forPlace === "Bay Area" && t.stores[0]?.forHome === "Sacramento" && t.seeds[0]?.label === "San Francisco Bay Area, California");
  const tx = deps();
  const h = await R.resolveWantPlace({ userId: "u2", key: "ask:a2", place: "Bay Area", source: "their_words", homeCity: "Houston" }, tx.d);
  check("a Houston member's Bay Area ask searches by Houston", h.city === "Bay Area Houston, Texas" && !h.skip, h);
}
{
  const t = deps();
  const r = await R.resolveWantPlace({ userId: "u3", key: "ask:trip", place: "Austin", source: "their_words", homeCity: "Sacramento" }, t.d);
  check("a traveling member ('founder dinners in Austin next week', home Sacramento) searches Austin, with no far-from-home block", r.city === "Austin, Texas" && !r.skip && r.place?.verdict === "far_named_by_them", r);
  check("... and it's on record as searched far from home: place, miles, how, never their words", t.logs.some((l) => l.decision === "place.far_from_home" && l.outcome === "act" && l.proposal.place === "Austin, Texas" && l.proposal.miles > 1000 && l.proposal.how === "confirmed" && !("want" in l.proposal) && !JSON.stringify(l.proposal).includes("next week")), t.logs);
  const inf = deps();
  const b = await R.resolveWantPlace({ userId: "u3", key: "goal:g", place: "Austin", source: "told", homeCity: "Sacramento" }, inf.d);
  check("an inferred far place is not searched, and nothing searches home in its place", b.city === null && !!b.skip && b.place?.verdict === "far_not_searched" && inf.logs.some((l) => l.decision === "place.far_from_home" && l.outcome === "skip"), b);
  const win = deps({ windowEnd: "2026-11-02" });
  const w = await R.resolveWantPlace({ userId: "u3", key: "goal:g", place: "Austin", source: "told", homeCity: "Sacramento" }, win.d);
  check("an inferred far place inside this want's own window is searched", w.city === "Austin, Texas" && w.place?.verdict === "far_in_window");
  const over = deps({ windowEnd: "2026-10-27" });
  const o2 = await R.resolveWantPlace({ userId: "u3", key: "goal:g", place: "Austin", source: "told", homeCity: "Sacramento" }, over.d);
  check("the window over, the trip no longer makes it searchable", o2.city === null && o2.place?.verdict === "far_not_searched");
}
{
  const t = deps();
  const r = await R.resolveWantPlace({ userId: "u4", key: "ask:s", place: "Springfield", source: "their_words", homeCity: "Sacramento" }, t.d);
  check("an ambiguous place is skipped (logged with its options), never searched at home", r.city === null && !!r.skip && r.place?.verdict === "ambiguous" && t.logs.some((l) => l.decision === "place.ambiguous" && l.outcome === "skip" && l.proposal.options.length >= 2), r);
  const q = deps();
  const rq = await R.resolveWantPlace({ userId: "u4", key: "ask:p", place: "Portland, CA", source: "their_words", homeCity: "Sacramento" }, q.d);
  check("a confirmed place that lands outside its stated state is rejected and not searched (its confirmation doesn't excuse a wrong resolution)", rq.city === null && rq.place?.verdict === "rejected" && q.logs.some((l) => l.decision === "place.rejected"));
}
{
  // A resolution made for another place (before a correction) or another home is never reused.
  const stale = { forPlace: "Bay Area", forHome: "Houston", status: "resolved", label: "Bay Area Houston, Texas", lat: 29.55, lng: -95.11, options: [] };
  const t = deps({ stored: stale });
  const r = await R.resolveWantPlace({ userId: "u5", key: "ask:a", place: "Bay Area", source: "their_words", homeCity: "Sacramento" }, t.d);
  check("a stored resolution for another home is resolved again (the member moved)", r.city === "San Francisco Bay Area, California" && t.lookups.length === 1, r);
  const same = deps({ stored: { ...stale, forHome: "Sacramento", label: "San Francisco Bay Area, California", lat: 37.83, lng: -122.29 } });
  const s2 = await R.resolveWantPlace({ userId: "u5", key: "ask:a", place: "Bay Area", source: "their_words", homeCity: "Sacramento" }, same.d);
  check("a stored resolution for this place and home is used without a lookup", s2.city === "San Francisco Bay Area, California" && same.lookups.length === 0 && s2.place?.from === "stored");
  const down = deps();
  down.d.lookup = async (place) => (down.lookups.push(place), { google: [], openMeteo: OPEN[R.normName(place)] ?? [], partial: true });
  const dn = await R.resolveWantPlace({ userId: "u5", key: "ask:s", place: "Springfield", source: "their_words", homeCity: "Sacramento" }, down.d);
  check("an ambiguous answer while a geocoder is down is used this once, not kept (asked again next time)", dn.place?.verdict === "ambiguous" && down.stores.length === 0);
  const none = deps();
  const n = await R.resolveWantPlace({ userId: "u5", key: "ask:a", place: "Bay Area", source: "their_words", homeCity: null }, none.d);
  check("no home city on file: the place word as before (no lookup)", n.city === "Bay Area" && none.lookups.length === 0);
}

// ---------------------------------------------------------------- 4. the old cache row is never read for a want's place
{
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = (pool as any).query;
  const realFetch = globalThis.fetch;
  const asked: { sql: string; args: unknown[] }[] = [];
  (pool as any).query = async (sql: string, args: unknown[] = []) => {
    asked.push({ sql, args });
    // The stale shared rows, as co-test had them: the bare "Bay Area" at Bay Area Park, Texas; Sacramento right.
    if (/FROM geocode_cache WHERE query = \$1/.test(sql)) return { rows: args[0] === "Bay Area" ? [{ lat: 29.59523, lng: -95.08715 }] : args[0] === "Sacramento" ? [{ lat: 38.5781342, lng: -121.4944209 }] : [] };
    if (/FROM want_places/.test(sql)) return { rows: [{ window_end: null, resolved_status: null }] };
    return { rows: [], rowCount: 1 };
  };
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input?.url ?? input));
    if (url.hostname === "geocoding-api.open-meteo.com") {
      // Its real answer for "Bay Area": a park, a heliport and two ball fields.
      return new Response(JSON.stringify({ results: [{ name: "Bay Area Park", admin1: "Texas", country_code: "US", latitude: 29.59523, longitude: -95.08715, feature_code: "PRK" }, { name: "Bay Area Hospital Heliport", admin1: "Oregon", country_code: "US", latitude: 43.4, longitude: -124.23, feature_code: "AIRH" }] }), { status: 200 });
    }
    throw new Error(`refused: ${url.hostname}`);
  }) as typeof fetch;
  try {
    const r = await R.resolveWantPlace({ userId: "u6", key: "ask:old", place: "Bay Area", source: "their_words", homeCity: "Sacramento" }, { ...R.realResolveDeps, today: async () => "2026-10-29" });
    check("with the stale 'Bay Area' row still cached, the real resolution searches the SF Bay Area", r.city === "San Francisco Bay Area, California", r);
    check("... and never reads the bare 'Bay Area' cache row", !asked.some((a) => /geocode_cache/.test(a.sql) && /SELECT/.test(a.sql) && a.args[0] === "Bay Area"), asked.map((a) => a.args[0]));
    check("... and seeds the qualified label (never the bare name) for the code downstream", asked.some((a) => /INSERT INTO geocode_cache/.test(a.sql) && a.args[0] === "San Francisco Bay Area, California") && !asked.some((a) => /INSERT INTO geocode_cache/.test(a.sql) && a.args[0] === "Bay Area"));
    check("... and stores the resolution only while the place is still the one resolved", asked.some((a) => /UPDATE want_places SET resolved_for/.test(a.sql) && /AND place = \$3/.test(a.sql)));
  } finally {
    (pool as any).query = realQuery;
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- 5. the sweep: place resolved before any search; goals too
{
  const E = await import("../../src/services/eventSurfacingSweep.js");
  const placeDeps = (place: string | null, source: string) => ({
    since: async () => null,
    row: async (_u: string, key: string) => ({ key, place, source: source as any, quote: place, notedAt: null }),
    told: async () => [],
    model: async () => "{}",
    save: async () => {},
    log: async () => {},
  });
  const t = deps();
  const sf = await E.placeToSearch({ askId: "profile", userId: "u7", askText: "founder community events", city: "Sacramento", want: { key: "goal:sf", text: "get outreach help for founder communities in San Francisco", createdAt: null } }, { place: placeDeps("San Francisco", "their_words"), resolve: t.d });
  check("a goal naming San Francisco searches San Francisco, while their home stays Sacramento", sf.city === "San Francisco, California" && sf.searchedIn.place === "San Francisco" && sf.searchedIn.key === "goal:sf" && !sf.skip, sf);
  const own = await E.placeToSearch({ askId: "a", userId: "u7", askText: "x", city: "Sacramento", want: { key: "ask:h", text: "runs in Sacramento", createdAt: null } }, { place: placeDeps("Sacramento", "their_words"), resolve: t.d });
  check("a want whose place is their home city is searched as home, as before", own.city === "Sacramento" && !own.place && !own.skip);
  const home = await E.placeToSearch({ askId: "profile", userId: "u7", askText: "friends", city: "Sacramento", want: { key: "goal:f", text: "friendships", createdAt: null } }, { place: placeDeps(null, "none"), resolve: deps().d });
  check("a goal with no place searches home, unresolved (as before)", home.city === "Sacramento" && home.searchedIn.source === "home" && !home.place);
  const amb = await E.placeToSearch({ askId: "profile", userId: "u7", askText: "x", city: "Sacramento", want: { key: "goal:s", text: "meetups in Springfield", createdAt: null } }, { place: placeDeps("Springfield", "their_words"), resolve: deps().d });
  check("an ambiguous place: the search is skipped, and home isn't searched instead", amb.city === null && !!amb.skip && amb.searchedIn.source !== "home");
  const ess = src("services/eventSurfacingSweep.ts");
  check("wiring: a skipped place returns before the backlog is read or anything is searched, and says so", /const where = await placeToSearch\(candidate\);[\s\S]{0,900}?if \(where\.skip\) \{[\s\S]{0,700}placeSkip: where\.skip[\s\S]{0,120}return \{ queued: false \};\s*\}\s*const readAtStart/.test(ess) && /findFreshPending\(candidate, zone, where\)/.test(ess));
  const ds = src("services/dailySweep.ts");
  check("wiring: the 9am sweep shows a place skip as a skipped item with why (not an error that retries)", /if \(r\?\.placeSkip\) \{ items\.push\(\{ \.\.\.b, status: "skipped", why: `place: \$\{r\.placeSkip\}`/.test(ds) && ds.indexOf("r?.placeSkip") < ds.indexOf("if (searchFailed(r))"));

  const GS = await import("../../src/services/goalSweep.js");
  const reads: string[] = [];
  const places = await GS.goalPlaces({ user_id: "u7", intent: [] }, [{ key: "goal:sf", goal: "attend Tech Week in San Francisco" }, { key: "goal:f", goal: "friendships" }, { key: "goal:old", goal: "SPC" }], {
    stored: async () => [{ key: "goal:old", place: null, source: "none" }],
    read: async (_u, w) => (reads.push(w.key), { key: w.key, place: w.key === "goal:sf" ? "San Francisco" : null }),
  });
  const W = await import("../../src/services/wantPlace.js");
  const split = W.splitByPlace([{ key: "goal:sf", item: 1 }, { key: "goal:f", item: 2 }, { key: "goal:old", item: 3 }], places, "Sacramento");
  check("the hourly goal sweep reads a goal's place it hasn't read yet (once), so an SF goal is searched on its own in SF", reads.join(",") === "goal:sf,goal:f" && split.own.length === 1 && split.own[0].key === "goal:sf" && split.own[0].place === "San Francisco" && split.home.length === 2, { reads, split });
}

// ---------------------------------------------------------------- 6. a correction: that want's place, resolution and pooled finds only
{
  const W = await import("../../src/services/wantPlace.js");
  const writes: { sql: string; args: unknown[] }[] = [];
  const backlogs = [
    { ask_id: "a1", items: [{ match: { name: "Houston mixer", searchedIn: { key: "ask:a1", place: "Bay Area" } } }, { match: { name: "Houston dinner" } }] },
    { ask_id: "a2", items: [{ match: { name: "Other ask's find", searchedIn: { key: "ask:a2", place: "Oakland" } } }] },
    { ask_id: "profile", items: [{ match: { name: "Goal x find", searchedIn: { key: "goal:x", place: "Bay Area" } } }, { match: { name: "Goal y find", searchedIn: { key: "goal:y", place: "Bay Area" } } }] },
  ];
  const db = { query: async (sql: string, args: unknown[] = []) => (writes.push({ sql, args }), /SELECT ask_id, items FROM event_backlogs/.test(sql) ? { rows: backlogs } : { rows: [], rowCount: 1 }) };
  await W.setPlace(db, "u8", "ask:a1", "San Francisco", "not there, SF");
  const up = writes.find((w) => /UPDATE want_places SET place/.test(w.sql))!;
  check("a correction sets that want's place and clears its resolution, for that member and want only", /resolved_label = NULL/.test(up.sql) && /resolved_for = NULL/.test(up.sql) && /WHERE user_id = \$1 AND want_key = \$2\s*$/.test(up.sql.trim()) && up.args[0] === "u8" && up.args[1] === "ask:a1");
  const bl = writes.filter((w) => /UPDATE event_backlogs/.test(w.sql));
  check("... and drops that ask's pooled finds, leaving every other ask's and goal's", bl.length === 1 && bl[0].args[1] === "a1" && JSON.parse(String(bl[0].args[2])).length === 0, bl);
  check("never their home: nothing touches co_profiles", !writes.some((w) => /co_profiles/.test(w.sql)));
  writes.length = 0;
  await W.setPlace(db, "u8", "goal:x", "Oakland", "actually Oakland");
  const gb = writes.filter((w) => /UPDATE event_backlogs/.test(w.sql));
  check("a goal's correction drops only that goal's finds from the shared profile pool", gb.length === 1 && gb[0].args[1] === "profile" && JSON.stringify(JSON.parse(String(gb[0].args[2])).map((i: any) => i.match.name)) === JSON.stringify(["Goal y find"]), gb);
  const K = await import("../../src/services/whatCoKnows.js");
  const items = K.knownItems({ profile: { city: "Sacramento", long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent: [] }, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], places: [{ key: "ask:a1", want: "founder dinners in the Bay Area", place: "Bay Area", searching: "San Francisco Bay Area, California" }, { key: "ask:a3", want: "SF dinners", place: "San Francisco", searching: "San Francisco" }] } as any);
  const line = items.find((i) => i.ref === "place:ask:a1");
  check("what Cue knows shows where it's searching, in the line they can correct", line?.text === `where I look for "founder dinners in the Bay Area": Bay Area · searching San Francisco Bay Area, California` && !!line?.canCorrect, line);
  const live = await K.livePlaces([
    { want_key: "ask:a1", want_text: "dinners in the Bay Area", place: "Bay Area", source: "their_words", resolved_for: "Bay Area", resolved_status: "resolved", resolved_label: "San Francisco Bay Area, California" },
    { want_key: "ask:a4", want_text: "tech meetups", place: "Austin", source: "told", resolved_for: "Austin", resolved_status: "resolved", resolved_label: "Austin, Texas" },
    { want_key: "ask:a5", want_text: "dinners in Oakland", place: "Oakland", source: "corrected", resolved_for: "Bay Area", resolved_status: "resolved", resolved_label: "San Francisco Bay Area, California" },
  ], { goals: [], intent: [] });
  check("the searched place is shown for a place they named, never for one Cue inferred (it may be held), never from an old place's resolution", live[0].searching === "San Francisco Bay Area, California" && !live[1].searching && !live[2].searching, live);
  check("... and says nothing extra when it's the same place said the same way", items.find((i) => i.ref === "place:ask:a3")?.text === `where I look for "SF dinners": San Francisco`);
}

// ---------------------------------------------------------------- 7. visible to the team: /sweeps and the morning review
{
  const D = await import("../../src/services/dailySweep.js");
  const notes = D.placeNotes([
    { kind: "ask", id: "018e3545-1042", text: "founder dinners in Austin next week", status: "searched", place: { label: "Austin, Texas", miles: 1500, how: "confirmed", verdict: "far_named_by_them", from: "fresh" } },
    { kind: "goal", id: "abcdef123456", text: "tech", status: "skipped", place: { label: "Austin, Texas", miles: 1500, how: "inferred", verdict: "far_not_searched", from: "fresh" } },
    { kind: "ask", id: "near", text: "x", status: "searched", place: { label: "San Francisco Bay Area, California", miles: 75, how: "confirmed", verdict: "near", from: "fresh" } },
  ]);
  check("/sweeps shows far and unsearched places by item and resolved place, never the member's words", !!notes && /ask 018e3545: Austin, Texas 1500 mi from home \(confirmed\), searched: they named it/.test(notes) && /goal abcdef12: .* not searched/.test(notes) && !/next week/.test(notes) && !/San Francisco/.test(notes), notes);
  const DR = await import("../../src/harness/devReview.js");
  const flags = DR.logFlags({ userId: "u9", messages: [], decisions: [
    { id: 1, at: "2026-10-29T16:05:00Z", decision: "place.far_from_home", outcome: "skip", action: "far_not_searched", reason: null, proposal: { key: "goal:g", how: "inferred", place: "Austin, Texas", miles: 1500 }, checks: [] },
    { id: 2, at: "2026-10-29T16:06:00Z", decision: "place.ambiguous", outcome: "skip", action: "not_searched", reason: null, proposal: { key: "ask:s", how: "confirmed", options: ["Springfield, Missouri", "Springfield, Massachusetts"] }, checks: [] },
    { id: 3, at: "2026-10-29T16:07:00Z", decision: "place.far_from_home", outcome: "act", action: "far_named_by_them", reason: null, proposal: { key: "ask:t", how: "confirmed", place: "Austin, Texas", miles: 1500 }, checks: [] },
  ] } as any);
  check("the morning review flags a place not searched (medium) and one searched far from home (low)", flags.filter((f) => f.type === "place_not_searched").length === 2 && flags.some((f) => f.type === "place_far_from_home" && f.severity === "low") && flags.every((f) => f.type !== "place_not_searched" || f.severity === "medium"), flags.map((f) => [f.type, f.severity, f.snippet]));
}

// ---------------------------------------------------------------- 9. review of #314: outages retry, shared rows, home by name, queued finds
{
  // An outage (Portland, both geocoders down): nothing searched this run, retried, never the bare word.
  const t = deps();
  t.d.lookup = async () => { throw new Error("both geocoders failed"); };
  const r = await R.resolveWantPlace({ userId: "u10", key: "ask:pdx", place: "Portland", source: "their_words", homeCity: "Sacramento" }, t.d);
  check("geocoders down: the want waits for the next run (no city, no skip, a retry), never the bare 'Portland'", r.city === null && !r.skip && !!r.retry && t.logs.some((l) => l.decision === "place.unresolved" && l.outcome === "skip" && l.action === "lookup_failed") && t.stores.length === 0, r);
  const nh = deps();
  nh.d.lookup = async () => ({ google: [], openMeteo: [] });
  const n2 = await R.resolveWantPlace({ userId: "u10", key: "ask:x", place: "Zzyzxville", source: "their_words", homeCity: "Sacramento" }, nh.d);
  check("no hit at all: waits for the next run too", n2.city === null && !!n2.retry);
  const hd = deps({ homeCity: {} });
  const h2 = await R.resolveWantPlace({ userId: "u10", key: "ask:pdx", place: "Portland", source: "their_words", homeCity: "Sacramento" }, hd.d);
  check("their home couldn't be placed: waits for the next run", h2.city === null && !!h2.retry && hd.lookups.length === 0);
  const E = await import("../../src/services/eventSurfacingSweep.js");
  const pd = (place: string) => ({ since: async () => null, row: async (_u: string, key: string) => ({ key, place, source: "their_words" as const, quote: place, notedAt: null }), told: async () => [], model: async () => "{}", save: async () => {}, log: async () => {} });
  const w = await E.placeToSearch({ askId: "a", userId: "u10", askText: "x", city: "Sacramento", want: { key: "ask:pdx", text: "Portland", createdAt: null } }, { place: pd("Portland"), resolve: t.d });
  check("... through the sweep: nothing to search this run, and the retry carried", w.city === null && !!w.retry && !w.skip);
  const ess = src("services/eventSurfacingSweep.ts");
  check("wiring: a retry returns before anything is searched; the 9am item is incomplete (retried on a later hour)", /if \(where\.retry\) \{[\s\S]{0,600}placeRetry: where\.retry[\s\S]{0,60}return \{ queued: false \};/.test(ess) && /if \(r\?\.placeRetry\) \{ items\.push\(\{ \.\.\.b, status: "incomplete"/.test(src("services/dailySweep.ts")));
  const homeNamed = await E.placeToSearch({ askId: "a", userId: "u10", askText: "x", city: "Portland, ME", want: { key: "ask:h", text: "runs in Portland", createdAt: null } }, { place: pd("Portland"), resolve: deps().d });
  check("a place that is their home by name searches their home as on file ('Portland, ME'), never the bare word", homeNamed.city === "Portland, ME" && !homeNamed.place);
}
{
  // A Seattle member's "Washington": the state, under a qualified label; the shared bare row is never written.
  const t = deps();
  t.d.lookup = async () => ({ google: [], openMeteo: [om("Washington", "Washington", "US", 47.50012, -120.50147, 7_705_281), om("Washington", "District of Columbia", "US", 38.89511, -77.03637, 689545)] });
  const r = await R.resolveWantPlace({ userId: "u11", key: "ask:wa", place: "Washington", source: "their_words", homeCity: "Seattle" }, t.d);
  check("a Seattle member's 'Washington' is the state, seeded as 'Washington, US' (never the bare name)", r.city === "Washington, US" && t.seeds.length === 1 && t.seeds[0].label === "Washington, US", { r, seeds: t.seeds });
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = (pool as any).query;
  const sql: { sql: string; args: unknown[] }[] = [];
  (pool as any).query = async (q: string, args: unknown[] = []) => (sql.push({ sql: q, args }), { rows: [], rowCount: 0 });
  try {
    await R.realResolveDeps.seed("Washington", { lat: 47.5, lng: -120.5 });
    await R.realResolveDeps.seed("Washington, US", { lat: 47.5, lng: -120.5 });
  } finally {
    (pool as any).query = realQuery;
  }
  check("the bare 'Washington' row is untouched: a bare label is never seeded", !sql.some((x) => x.args[0] === "Washington") && R.seedable("Washington") === false);
  check("a qualified label is seeded only where no row exists (DO NOTHING: one member's resolution never moves a shared row)", sql.length === 1 && /ON CONFLICT \(query\) DO NOTHING/.test(sql[0].sql) && !/DO UPDATE/.test(sql[0].sql));
  const G = await import("../../src/services/geocoding.js");
  check("the open geocoder fallback takes populated places only: a bare 'Bay Area' can't re-cache Bay Area Park", G.openMeteoHit([{ name: "Bay Area Park", admin1: "Texas", country_code: "US", feature_code: "PRK" }, { name: "Bay Area Hospital Heliport", country_code: "US", feature_code: "AIRH" }], "") === undefined && G.openMeteoHit([{ name: "Bay Area Park", country_code: "US", feature_code: "PRK" }, { name: "Portland", admin1: "Oregon", country_code: "US", feature_code: "PPLA2" }], "")?.name === "Portland");
}
{
  // A correction cancels that want's queued-but-unsent finds, and nothing else.
  const K = await import("../../src/services/whatCoKnows.js");
  const WS = await import("../../src/services/workingSet.js");
  const cand = (id: number, type: string, payload: any) => ({ id, type, target_key: `t${id}`, summary: `find ${id}`, payload: JSON.stringify(payload) });
  const queued = [
    cand(1, "event_offer", { askId: "A1", match: { name: "Austin founders" } }),
    cand(2, "event_offer", { askId: "profile", match: { name: "Austin builders", searchedIn: { key: "ask:A1", place: "Austin" } } }),
    cand(3, "event_offer", { askId: "A2", match: { name: "Austin other ask", searchedIn: { key: "ask:A2", place: "Austin" } } }),
    cand(4, "event_offer", { askId: "profile", match: { name: "Portland goal one", searchedIn: { key: "goal:G1", place: "Portland" } } }),
    cand(5, "companion", { askId: "A1" }),
    cand(6, "event_offer", { askId: "profile", match: { name: "Portland goal two", searchedIn: { key: "goal:G2", place: "Portland" } } }),
    cand(7, "event_offer", { askId: "profile", match: { name: "Portland profile find" } }),
  ];
  const run = async (ref: string, was: string, now: string) => {
    const ups: { id: unknown; reason: unknown }[] = [];
    const db = { query: async (q: string, args: unknown[] = []) => {
      if (/FROM proactive_candidates/.test(q)) return { rows: queued };
      if (/^\s*SELECT/.test(q)) return { rows: [] };
      if (/UPDATE proactive_candidates/.test(q)) ups.push({ id: args[0], reason: args[2] });
      return { rows: [], rowCount: 1 };
    } };
    const out = await K.cancelQueued(db as any, "u12", [{ ref, source: "place", was, now } as any]);
    return { ups, out };
  };
  const a = await run("place:ask:A1", "Austin", "Boston");
  check("Austin -> Boston on an ask cancels that ask's queued finds (by askId, and a find searched for it), 'place corrected'", JSON.stringify(a.ups.map((u) => u.id).sort()) === "[1,2]" && a.ups.every((u) => /^place corrected/.test(String(u.reason))), a.ups);
  check("... another ask's find, a goal's find, a profile find and a non-find are untouched", !a.ups.some((u) => [3, 4, 5, 6, 7].includes(Number(u.id))));
  const g = await run("place:goal:G1", "Portland", "Portland, ME");
  check("Portland -> Portland, ME on a goal cancels only that goal's queued find (by its searchedIn key, never the shared profile askId)", JSON.stringify(g.ups.map((u) => u.id)) === "[4]", g.ups);
  check("a 'place corrected' skip is no decision: the same event can queue again when found for the right place", WS.isFailedAttempt("place corrected: corrected at their request: x") && !WS.isFailedAttempt("not for them"));
  const live = await K.livePlaces([{ want_key: "ask:s", want_text: "meetups in Springfield", place: "Springfield", source: "their_words", resolved_for: "Springfield", resolved_status: "ambiguous", resolved_label: null }], { goals: [], intent: [] });
  check("an ambiguous (skipped) place never says it's being searched", !live[0].searching);
}

// ---------------------------------------------------------------- 8. the one-time audit
{
  const wants = [
    { w: { userId: "u1", key: "ask:a", place: "Springfield", source: "their_words" as const, homeCity: "Sacramento", resolution: null }, fresh: { status: "ambiguous" as const, options: ["Springfield, Missouri", "Springfield, Massachusetts"] }, homeMiles: null },
    { w: { userId: "u1", key: "goal:b", place: "Austin", source: "told" as const, homeCity: "Sacramento", resolution: null }, fresh: R.pickPlace("Austin", cands("Austin"), home(HOME.sacramento)), homeMiles: 1500 },
    { w: { userId: "u2", key: "ask:c", place: "Bay Area", source: "corrected" as const, homeCity: "Sacramento", resolution: { forPlace: "Bay Area", forHome: "Sacramento", status: "resolved" as const, label: "Bay Area Houston, Texas", lat: 29.55, lng: -95.11, options: [] } }, fresh: R.pickPlace("Bay Area", cands("Bay Area"), home(HOME.sacramento)), homeMiles: 1600 },
  ];
  const cache = [
    { row: { query: "Bay Area", lat: 29.59523, lng: -95.08715 }, conflictMiles: 1600, conflictWith: "want" as const },
    { row: { query: "Sacramento", lat: 38.578, lng: -121.494 }, conflictMiles: 0, conflictWith: "home" as const },
    // Far from a Sacramento member's home, and exactly where their own "Austin" resolves: legitimate, not flagged.
    { row: { query: "Austin", lat: 30.26715, lng: -97.74306 }, conflictMiles: 0, conflictWith: "want" as const },
    { row: { query: "venue:1 Main St", lat: 1, lng: 1 }, conflictMiles: 5000, conflictWith: null },
  ];
  const plan = R.auditPlan(wants, cache);
  check("the audit lists each disagreement with how it was set", plan.some((f) => f.ref === "u1:ask:a" && f.how === "confirmed") && plan.some((f) => f.ref === "u1:goal:b" && f.how === "inferred") && plan.some((f) => f.ref === "u2:ask:c" && f.how === "confirmed") && plan.some((f) => f.ref === "Bay Area" && f.how === "cached"), plan);
  check("... a confirmed place is only ever reported", plan.filter((f) => f.how === "confirmed").every((f) => f.action === "report_only"));
  check("... the stale bare 'Bay Area' row is marked for deletion; a good row, a legitimately far row and a venue row are left", plan.some((f) => f.ref === "Bay Area" && f.action === "delete_cache_row") && !plan.some((f) => f.ref === "Sacramento" || f.ref === "Austin" || f.ref.startsWith("venue:")));
  const dry: string[] = [];
  const would = await R.applyAudit(plan, { query: async (sql: string) => void dry.push(sql) }, false);
  check("the dry run writes nothing at all", dry.length === 0 && would.length === 2, would);
  const wet: { sql: string; args: unknown[] }[] = [];
  await R.applyAudit(plan, { query: async (sql: string, args: unknown[] = []) => void wet.push({ sql, args }) }, true);
  check("--apply never writes a confirmed place (and its SQL refuses one even if asked)", !wet.some((w) => w.args.includes("ask:a") || w.args.includes("ask:c")) && wet.filter((w) => /UPDATE want_places/.test(w.sql)).every((w) => /source NOT IN \('their_words', 'corrected'\)/.test(w.sql)) && !wet.some((w) => /SET place/.test(w.sql)), wet);
  check("... it clears the inferred place's resolution and deletes the bad cache row", wet.some((w) => /UPDATE want_places SET resolved_for = NULL/.test(w.sql) && w.args[1] === "goal:b") && wet.some((w) => /DELETE FROM geocode_cache/.test(w.sql) && w.args[0] === "Bay Area"));
  const script = src("scripts/auditPlaces.ts");
  check("the audit script is a dry run unless --apply is given, and its dry run writes nothing (no geocodeCity or seed, which cache)", /const apply = process\.argv\.includes\("--apply"\)/.test(script) && /applyAudit\(findings, pool, apply\)/.test(script) && !/geocodeCity|realResolveDeps|\.seed\(|INSERT|UPDATE|DELETE/.test(script));
}

console.log(`places resolve near home: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
