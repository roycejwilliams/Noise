// A goal with no place of its own is searched where its own search plan names (Royce, 2026-11-10). Goal 26de184a, "Seeking genuine
// friendships…": its plan said "look for: small founder dinners SF", its web search looked in SF, and its event search looked in
// Sacramento (home). Now the place the plan names steers that goal's event search, resolved by the existing resolver; a want's own
// place still wins, their search area still stands in first, and a name that doesn't settle falls back to home (never a guess).
// Zero tokens: the database, the geocoders and the model are stubs.
//   npx tsx evals/discovery/planPlace.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.GOOGLE_API_KEY = "";
process.env.GOOGLE_PLACES_API_KEY = "";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const E = await import("../../src/services/eventSurfacingSweep.js");
const P = await import("../../src/services/askPlace.js");
const A = await import("../../src/services/searchArea.js");
type PlaceDeps = import("../../src/services/wantPlace.js").PlaceDeps;
type ResolveDeps = import("../../src/services/placeResolve.js").ResolveDeps;
type Stored = import("../../src/services/placeResolve.js").StoredResolution;

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const SAC = { lat: 38.5781342, lng: -121.4944209 };
const HOME = "Sacramento";
const resolved = (forPlace: string, label: string, lat: number, lng: number): Stored => ({ forPlace, forHome: HOME, status: "resolved", label, lat, lng, options: [], homeCountry: "US" });
// What the resolver has on file, by the place word it was asked about (a stored resolution, so no lookup runs for these).
const ON_MAP: Record<string, Stored> = {
  SF: resolved("SF", "San Francisco, California", 37.77493, -122.41942),
  Oakland: resolved("Oakland", "Oakland, California", 37.80437, -122.2708),
  Lisbon: resolved("Lisbon", "Lisbon, Portugal", 38.72225, -9.13933),
  Springfield: { forPlace: "Springfield", forHome: HOME, status: "ambiguous", label: null, lat: null, lng: null, options: ["Springfield, Illinois", "Springfield, Missouri"], homeCountry: "US" },
};

// The want's own place on file (null: none), and their search area (null: none set).
const placeDeps = (own: { place: string | null; source?: string }, area: string | null = null): PlaceDeps => ({
  since: async () => null,
  row: async (_u, key) => ({ key, place: own.place, source: (own.source ?? (own.place ? "their_words" : "none")) as any, quote: null, notedAt: null }),
  told: async () => [],
  model: async () => { throw new Error("no model read expected"); },
  save: async () => {},
  log: async () => {},
  area: async () => (area ? { place: area, source: "their_words" as const, quote: null, label: null } : null),
});
const lookedUp: string[] = [];
const resolveDeps = (): ResolveDeps => ({
  home: async () => SAC,
  homeCountry: async () => "US",
  // A place not on file: no place by that name comes back (unresolvable).
  lookup: async (name) => (lookedUp.push(name), { google: [], local: [], partial: false } as any),
  row: async () => ({ windowEnd: null, resolution: null }),
  store: async () => {},
  log: async () => {},
  today: async () => "2026-11-10",
});
// The stored resolution each goal key has (resolveWantPlace uses it only when its forPlace is the word asked about).
const rdeps = (byKey: Record<string, string>): ResolveDeps => ({ ...resolveDeps(), row: async (_u, key) => ({ windowEnd: null, resolution: ON_MAP[byKey[key]] ?? null }) });

const goal = (key: string, plan: string) => ({ askId: "profile", userId: "m1", askText: plan, city: HOME, want: { key, text: "Seeking genuine friendships with people building things", createdAt: null } });

// ---------------------------------------------------------------- the detector
check("the plan's SF is the place it names", P.planNamesPlace("look for: small founder dinners SF") === "SF", P.planNamesPlace("look for: small founder dinners SF"));
check("SF and San Francisco in one plan are one place", P.planNamesPlace("look for: founder dinners SF; climbing nights in San Francisco") !== null);
check("two different places in one plan: none (never a pick)", P.planNamesPlace("look for: founder dinners SF; hikes in Oakland") === null, P.planNamesPlace("look for: founder dinners SF; hikes in Oakland"));
check("a plan naming no place: none", P.planNamesPlace("look for: small founder dinners; climbing gyms") === null);
check("a topic after \"in\" isn't a place", P.planNamesPlace("look for: women in Venture dinners") === null);

// ---------------------------------------------------------------- 1. the plan says SF, the want has no place: the event search uses SF
{
  const r = await E.placeToSearch(goal("goal:sf", "look for: small founder dinners SF"), { place: placeDeps({ place: null }), resolve: rdeps({ "goal:sf": "SF" }) });
  check("goal 26de184a's shape: no place of its own, plan says SF -> searched in San Francisco", r.city === "San Francisco, California" && r.searchedIn.source === "plan" && r.searchedIn.key === "goal:sf" && !r.skip && !r.retry, r);
  check("... at its resolved point", r.point?.lat === 37.77493, r.point);
}

// ---------------------------------------------------------------- 2. a want place set: the want place wins
{
  const r = await E.placeToSearch(goal("goal:oak", "look for: small founder dinners SF"), { place: placeDeps({ place: "Oakland" }), resolve: rdeps({ "goal:oak": "Oakland" }) });
  check("the goal's own place (Oakland) wins over the plan's SF", r.city === "Oakland, California" && r.searchedIn.source === "their_words", r);
  const removed = await E.placeToSearch(goal("goal:rm", "look for: small founder dinners SF"), { place: placeDeps({ place: null, source: "removed" }), resolve: rdeps({ "goal:rm": "SF" }) });
  check("a place they removed from the goal isn't put back by the plan: home", removed.city === HOME && removed.searchedIn.source === "home", removed);
  const area = await E.placeToSearch(goal("goal:area", "look for: small founder dinners SF"), { place: placeDeps({ place: null }, "Oakland"), resolve: { ...rdeps({}), row: async (_u, key) => ({ windowEnd: null, resolution: key === A.AREA_KEY ? ON_MAP.Oakland : null }) } });
  check("their search area (their own words) still stands in first", area.city === "Oakland, California" && area.searchedIn.source === "area", area);
}

// ---------------------------------------------------------------- 3. a name that doesn't settle: home, never a guess
{
  lookedUp.length = 0;
  const none = await E.placeToSearch(goal("goal:x", "look for: supper clubs in Zzyzxville"), { place: placeDeps({ place: null }), resolve: rdeps({}) });
  check("an unresolvable name -> home, searched (not skipped, not retried)", none.city === HOME && none.searchedIn.source === "home" && !none.skip && !none.retry, none);
  check("... after the resolver was asked about it", lookedUp.includes("Zzyzxville"), lookedUp);
  const amb = await E.placeToSearch(goal("goal:spr", "look for: founder dinners in Springfield"), { place: placeDeps({ place: null }), resolve: rdeps({ "goal:spr": "Springfield" }) });
  check("an ambiguous name -> home, never one of its readings", amb.city === HOME && amb.searchedIn.source === "home" && !amb.skip, amb);
  const far = await E.placeToSearch(goal("goal:lis", "look for: founder dinners in Lisbon"), { place: placeDeps({ place: null }), resolve: rdeps({ "goal:lis": "Lisbon" }) });
  check("a plan place far from home (Cue's inference, not theirs) -> home", far.city === HOME && far.searchedIn.source === "home" && !far.skip, far);
  const two = await E.placeToSearch(goal("goal:two", "look for: founder dinners SF; hikes in Oakland"), { place: placeDeps({ place: null }), resolve: rdeps({ "goal:two": "SF" }) });
  check("one plan naming two places -> home", two.city === HOME && two.searchedIn.source === "home", two);
  const down = await E.placeToSearch(goal("goal:down", "look for: small founder dinners SF"), { place: placeDeps({ place: null }), resolve: { ...rdeps({}), lookup: async () => null as any } });
  check("geocoders down for the plan place -> home this run (as before), not a held goal", down.city === HOME && !down.retry, down);
}

// ---------------------------------------------------------------- 4. two plan items naming different cities each keep their own
{
  const map = { "goal:a": "SF", "goal:b": "Oakland" };
  const [a, b] = await Promise.all([
    E.placeToSearch(goal("goal:a", "look for: small founder dinners SF"), { place: placeDeps({ place: null }), resolve: rdeps(map) }),
    E.placeToSearch(goal("goal:b", "look for: pottery nights in Oakland"), { place: placeDeps({ place: null }), resolve: rdeps(map) }),
  ]);
  check("plan item A (SF) is searched in SF", a.city === "San Francisco, California" && a.searchedIn.key === "goal:a", a);
  check("plan item B (Oakland) is searched in Oakland", b.city === "Oakland, California" && b.searchedIn.key === "goal:b", b);
}

// ---------------------------------------------------------------- 5. only goals: an ask with no place, and the shared search, are as before
{
  const ask = await E.placeToSearch({ askId: "promise:1", userId: "m1", askText: "look for: founder dinners SF", city: HOME, want: { key: "ask:1", text: "founder dinners", createdAt: null } }, { place: placeDeps({ place: null }), resolve: rdeps({ "ask:1": "SF" }) });
  check("an ask (not a goal) with no place of its own: home, as before", ask.city === HOME && ask.searchedIn.source === "home", ask);
  const shared = await E.placeToSearch({ askId: "profile", userId: "m1", askText: "look for: founder dinners SF", city: HOME }, { place: placeDeps({ place: null }), resolve: rdeps({}) });
  check("the shared goal search (no want named): home, as before", shared.city === HOME && shared.searchedIn.source === "home", shared);
  check("a find searched at a plan place moves with their search area (a fallback find)", A.isFallbackFind({ match: { searchedIn: { source: "plan" } } }) && !A.isFallbackFind({ match: { searchedIn: { source: "their_words" } } }));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
