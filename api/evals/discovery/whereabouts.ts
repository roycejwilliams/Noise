// Where a search looks, and where they are (Royce, 2026-11-11). Zero tokens: the database, the geocoders and the model are stubs.
//   npx tsx evals/discovery/whereabouts.ts
// The place the search intended comes first (its own words, the conversation that started it, its plan, their search area); only a
// near-me search uses where they are now, and only from their own dated line within its window; a standing search with a place of its
// own never moves for a trip. A move ("moved to", "live in", "based in") changes home; "I'm in X" is a trip.
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
const W = await import("../../src/services/wantPlace.js");
const WH = await import("../../src/services/whereabouts.js");
const PE = await import("../../src/services/profileExtraction.js");
const MT = await import("../../src/services/memberTime.js");
const B = await import("../../src/harness/bundleComposer.js");
const ER = await import("../../src/services/eventRanking.js");
type PlaceDeps = import("../../src/services/wantPlace.js").PlaceDeps;
type ResolveDeps = import("../../src/services/placeResolve.js").ResolveDeps;
type Stored = import("../../src/services/placeResolve.js").StoredResolution;

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

const HOME = "Sacramento";
const SAC = { lat: 38.5781342, lng: -121.4944209 };
const NOW = new Date("2026-11-11T17:00:00Z");
const resolved = (forPlace: string, label: string, lat: number, lng: number): Stored => ({ forPlace, forHome: HOME, status: "resolved", label, lat, lng, options: [], homeCountry: "US" });
const ON_MAP: Record<string, Stored> = {
  SF: resolved("SF", "San Francisco, California", 37.77493, -122.41942),
  "San Francisco": resolved("San Francisco", "San Francisco, California", 37.77493, -122.41942),
  "Los Angeles": resolved("Los Angeles", "Los Angeles, California", 34.05223, -118.24368),
  NYC: resolved("NYC", "New York, New York", 40.71278, -74.00597),
};
const rdeps: ResolveDeps = {
  home: async () => SAC,
  homeCountry: async () => "US",
  lookup: async () => ({ google: [], local: [], partial: false }) as any,
  row: async () => ({ windowEnd: null, resolution: null }),
  store: async () => {},
  log: async () => {},
  today: async () => "2026-11-11",
};
// The resolver has each place word on file (a stored resolution), whatever key asks.
const rd = (word: string): ResolveDeps => ({ ...rdeps, row: async () => ({ windowEnd: null, resolution: ON_MAP[word] ?? null }) });
const placeDeps = (o: { row?: any; model?: string; current?: import("../../src/services/wantPlace.js").CurrentPlace | null; told?: string[] } = {}): PlaceDeps => ({
  since: async () => new Date("2026-10-15T00:00:00Z"),
  row: async () => o.row ?? null,
  told: async () => o.told ?? [],
  model: async () => o.model ?? JSON.stringify({ place: null }),
  save: async () => {},
  log: async () => {},
  area: async () => null,
  whereNow: async () => o.current ?? null,
});
const ask = (text: string) => ({ askId: "11111111-1111-1111-1111-111111111111", userId: "m1", askText: text, city: HOME, want: { key: "ask:11111111-1111-1111-1111-111111111111", text, createdAt: new Date("2026-10-30T02:10:00Z") } });
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// ---------------------------------------------------------------- 1. the place the search intended comes first
{
  const r = await E.placeToSearch(ask("find me an engineer in SF"), { place: placeDeps({ model: JSON.stringify({ place: "SF", quote: "find me an engineer in SF" }) }), resolve: rd("SF") });
  check("an ask made as 'find me an engineer in SF', its place blank: searched in SF (its own words)", r.city === "San Francisco, California" && r.searchedIn.source === "their_words", r);
  const fromTalk = await E.placeToSearch(ask("find me another engineer to build with"), { place: placeDeps({ told: ["I'm only looking in SF for this"], model: JSON.stringify({ place: "SF", quote: "I'm only looking in SF for this" }) }), resolve: rd("SF") });
  check("no place in the ask, but the conversation that started it named SF: SF (told)", fromTalk.city === "San Francisco, California" && fromTalk.searchedIn.source === "told", fromTalk);
}

// ---------------------------------------------------------------- 2. a near-me search: where they are now, only fresh and cited
{
  const none = { key: "ask:x", place: null, source: "none", quote: null, notedAt: null };
  const fresh = await E.placeToSearch(ask("find me another engineer to build with"), { place: placeDeps({ row: none, current: { place: "SF", quote: "I'm in SF this week", at: days(2) } }), resolve: rd("SF") });
  check("no place, a fresh cited current place (their line, 2 days ago): searched there", fresh.city === "San Francisco, California" && fresh.searchedIn.source === "current", fresh);
  const stale = await E.placeToSearch(ask("find me another engineer to build with"), { place: placeDeps({ row: none, current: { place: "SF", quote: "I'm in SF this week", at: days(W.CURRENT_PLACE_DAYS + 3) } }), resolve: rd("SF") });
  check("a stale current place: home", stale.city === HOME && stale.searchedIn.source === "home", stale);
  const uncited = await E.placeToSearch(ask("find me another engineer to build with"), { place: placeDeps({ row: none, current: { place: "SF", quote: "", at: days(1) } }), resolve: rd("SF") });
  check("an uncited current place: home", uncited.city === HOME && uncited.searchedIn.source === "home", uncited);
  const far = await E.placeToSearch(ask("find me another engineer to build with"), { place: placeDeps({ row: none, current: { place: "NYC", quote: "I'm in NYC", at: days(1) } }), resolve: rd("NYC") });
  check("a current place far from home (inferred, not searched there): home, never skipped", far.city === HOME && far.searchedIn.source === "home" && !far.skip, far);
  const removed = await E.placeToSearch(ask("find me another engineer to build with"), { place: placeDeps({ row: { ...none, source: "removed" }, current: { place: "SF", quote: "I'm in SF this week", at: days(1) } }), resolve: rd("SF") });
  check("a search whose place they removed: home, never their current place", removed.city === HOME, removed);
}

// ---------------------------------------------------------------- 3. a standing search with a stated place stays put
{
  const stated = { key: "ask:x", place: "SF", source: "their_words", quote: "founder dinners in SF", notedAt: null };
  const r = await E.placeToSearch(ask("founder dinners in SF"), { place: placeDeps({ row: stated, current: { place: "Los Angeles", quote: "in LA till Friday", at: days(1) } }), resolve: rd("SF") });
  check("a standing SF search stays in SF while they're in LA", r.city === "San Francisco, California" && r.searchedIn.source === "their_words", r);
}

// ---------------------------------------------------------------- 4. move vs trip
{
  const t = (line: string) => `assistant: hey\nuser: ${line}`;
  check("'moved to New York' is a move: home changes", PE.cityChangeAllowed(HOME, "New York", t("I moved to New York last week")));
  check("'I live in Oakland now' is a move", PE.cityChangeAllowed(HOME, "Oakland", t("I live in Oakland now")));
  check("'I'm based in Denver' is a move", PE.cityChangeAllowed(HOME, "Denver", t("I'm based in Denver")));
  for (const line of ["I'm in NYC", "heading to NYC Thu-Sun", "visiting Boston this week", "back in SF tomorrow"]) check(`'${line}' never changes home (a trip)`, !PE.cityChangeAllowed(HOME, line.match(/NYC|Boston|SF/)![0], t(line)));
  check("the move's own line is kept as its source", PE.personsOwnLineFor(t("I moved to New York last week"), "New York") === "I moved to New York last week");
  const today = "2026-11-11";
  const window = WH.tripFrom({ place: "NYC", quote: "heading to NYC Thu-Sun", from: "2026-11-12", until: "2026-11-15" }, "heading to NYC Thu-Sun", today);
  check("'heading to NYC Thu-Sun': a trip with its window", !!window && window.from === "2026-11-12" && window.until === "2026-11-15", window);
  const row = (w: NonNullable<typeof window>) => ({ place: w.place, quote: w.quote, read_at: NOW, window_start: w.from, window_end: w.until });
  check("... a near-me search uses NYC inside the window", WH.tripRowCurrent(row(window!), "2026-11-13")?.place === "NYC");
  check("... and home again after it ends", WH.tripRowCurrent(row(window!), "2026-11-16") === null);
  check("... and not before it starts", WH.tripRowCurrent(row(window!), "2026-11-11") === null);
  const unclear = WH.tripFrom({ place: "NYC", quote: "I'm in NYC", from: null, until: null }, "I'm in NYC", today);
  check("unclear 'I'm in NYC': a trip of TRIP_DEFAULT_DAYS from today, never a move", !!unclear && unclear.from === today && unclear.until === "2026-11-14", unclear);
  check("a trip's quote must be their words", WH.tripFrom({ place: "NYC", quote: "I'll be in NYC", from: null, until: null }, "I'm in NYC", today) === null);
  check("a 'trip' longer than three weeks isn't kept as one", WH.tripFrom({ place: "NYC", quote: "I'm in NYC", from: "2026-11-11", until: "2027-01-30" }, "I'm in NYC", today) === null);
  const zone = await MT.zoneFromProfile({ city: "New York", timezone: "America/Los_Angeles", timezone_city: "Sacramento" }, async (c) => (/new york/i.test(c) ? "America/New_York" : null));
  check("their zone follows home: a move to New York reads ET", zone.zone === "America/New_York" && zone.store?.timezone_city === "New York", zone);
}

// ---------------------------------------------------------------- 5. say where it searched; ask once after a move
{
  const homeNow = { place: "New York", at: new Date("2026-11-10T00:00:00Z") };
  const inferred = W.whereNoteFor({ key: "ask:a", place: HOME, source: "home" }, { notedAt: null, readAt: new Date("2026-10-30T00:00:00Z") }, null);
  check("an inferred place (home) carries the note", inferred?.kind === "inferred" && inferred.place === HOME, inferred);
  check("a stated place (their words) doesn't", W.whereNoteFor({ key: "ask:b", place: "SF", source: "their_words" }, { notedAt: null, readAt: new Date("2026-10-30T00:00:00Z") }, null) === null);
  check("said once: a noted search carries nothing", W.whereNoteFor({ key: "ask:a", place: HOME, source: "home" }, { notedAt: new Date(), readAt: null }, null) === null);
  const moved = W.whereNoteFor({ key: "ask:b", place: "SF", source: "their_words" }, { notedAt: null, readAt: new Date("2026-10-30T00:00:00Z") }, homeNow);
  check("a stated SF search after a move to New York: asked once (keep or switch)", moved?.kind === "moved" && (moved as any).home === "New York", moved);
  check("a stated place set after the move: no ask", W.whereNoteFor({ key: "ask:b", place: "SF", source: "their_words" }, { notedAt: null, readAt: new Date("2026-11-11T00:00:00Z") }, homeNow) === null);
  // The composer: Cue phrases it; code checks it said where.
  const item = { candidate: { id: "c1" } as any, item: { facts: {}, rules: { maxSentences: 3, maxChars: 300 }, url: "https://x.example/e", grounding: "", name: "Builders Night", fromProfile: true, shortNotice: false } as any, pick: null, again: false };
  const input = (where: any) => ({ firstName: "Jordan", items: [{ ...item, where }], set: null, leadWhy: null, memberBlock: null, feeling: null, thread: "", recent: "", threadLive: false }) as any;
  check("the composer is told where Cue looked, as a fact to phrase", /Cue looked around Sacramento: say that once, as a short clause in your caption/.test(B.composePrompt(input(inferred))));
  const without = B.checkComposed({ opening: null, items: [{ n: 1, caption: "Builders Night on Thursday." }], closing: null, connects: null }, input(inferred));
  check("an inferred-place caption that doesn't say where goes back", without.problems.some((p) => /doesn't say where Cue looked/.test(p.why)), without.problems);
  const said = B.checkComposed({ opening: null, items: [{ n: 1, caption: "Builders Night on Thursday, looked around Sacramento for this one." }], closing: null, connects: null }, input(inferred));
  check("... saying it passes", !said.problems.some((p) => /where Cue looked/.test(p.why)), said.problems);
  check("SF counts as San Francisco, NYC as New York", B.placeSaid("Looked around SF for this one", "San Francisco") && B.placeSaid("keep it on SF or switch to NYC?", "New York"));
  const noAsk = B.checkComposed({ opening: null, items: [{ n: 1, caption: "Builders Night on Thursday." }], closing: null, connects: null }, input(moved));
  check("after a move, a message with no keep-or-switch question goes back", noAsk.problems.some((p) => /keep this search on SF or switch it to New York/.test(p.why)), noAsk.problems);
  const asked = B.checkComposed({ opening: null, items: [{ n: 1, caption: "Builders Night on Thursday." }], closing: "You're in New York now: keep the SF search or switch it to NYC?", connects: null }, input(moved));
  check("... the one question passes", !asked.problems.some((p) => /keep this search/.test(p.why)), asked.problems);
}

// ---------------------------------------------------------------- 6. a fair relevance check before the shortlist
{
  const ev = (name: string, k: number) => ({ name, start_at: `2026-11-1${2 + (k % 3)}T02:00:00.000Z` });
  const many = [...Array.from({ length: 45 }, (_, k) => ev(`Generic mixer ${k}`, k)), ev("Voice AI engineers night", 0)];
  const embed = async (texts: string[]) => texts.map((t) => (/voice ai engineers|^voice ai engineers/i.test(t) || t === "voice AI engineers" ? [1, 0] : [0, 1]));
  const top = await ER.prefilterByFit(many, "voice AI engineers", 40, embed);
  check("the best event is never cut by its position: 46th in the list, first by fit", top[0].name === "Voice AI engineers night" && top.length === 40, top.slice(0, 2));
  const down = await ER.prefilterByFit(many, "x", 40, async () => { throw new Error("down"); });
  check("an embedding read that fails: the old spread, never nothing", down.length === 40);
}

console.log(`whereabouts: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
