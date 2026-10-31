// The place lives on the want (Royce, 2026-10-15), and the search repairs that came with it: the too-tight query loosened, the tier's
// close call going to the find that won't keep, and a find's date kept when its own text shows it. Zero tokens: the model, the database,
// Luma and the geocoder are stubs; invented people.
//   npx tsx evals/discovery/placeOnTheWant.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const W = await import("../../src/services/wantPlace.js");
const Q = await import("../../src/services/sweepQuery.js");
const SS = await import("../../src/services/sweepSelect.js");
const SF = await import("../../src/services/sweepFind.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

// ---------------------------------------------------------------- 1. what a read may keep
check("a place the want names, with a quote from it, is kept", JSON.stringify(W.backedPlace("SF", "founder dinners in SF", ["Small founder dinners in SF, weeknights"])) === JSON.stringify({ place: "SF", quote: "founder dinners in SF" }));
check("a quote that isn't in their words is no place", W.backedPlace("SF", "dinners in SF", ["Small founder dinners, weeknights"]) === null);
check("a place that isn't in its quote is no place", W.backedPlace("Oakland", "founder dinners", ["founder dinners"]) === null);
check("a whole name that is the place still counts at the end of the quote", W.backedPlace("San Francisco", "communities in San Francisco", ["get outreach help for founder communities in San Francisco"])?.place === "San Francisco");
check("something too long to be a place is no place", W.backedPlace("the whole bay area and peninsula and south bay", "x", ["x"]) === null);
// Royce, 2026-10-15: "the new path should apply to wants created after the behavior exists" (feature_epochs, written by the deploy).
const SINCE = new Date("2026-10-20T18:00:00Z");
check("a want from before the behavior existed reads its own words only; one after may use what they told Co", !W.mayUseTold({ key: "k", text: "t", createdAt: null }, SINCE) && !W.mayUseTold({ key: "k", text: "t", createdAt: new Date("2026-10-20T17:59:00Z") }, SINCE) && W.mayUseTold({ key: "k", text: "t", createdAt: new Date("2026-10-20T18:01:00Z") }, SINCE));
check("when the start can't be read, every want reads its own words only (never a guess)", !W.mayUseTold({ key: "k", text: "t", createdAt: new Date("2030-01-01") }, null));
{
  const mig = src("db/migrations.ts");
  check("the start is recorded once, by the first deploy that has the behavior, not a calendar date", /CREATE TABLE IF NOT EXISTS feature_epochs/.test(mig) && /INSERT INTO feature_epochs \(name\) VALUES \('want_places'\) ON CONFLICT \(name\) DO NOTHING/.test(mig) && !/PLACE_SINCE/.test(src("services/wantPlace.ts")));
}

// ---------------------------------------------------------------- 2. placeFor: once, never a guess
type Saved = { key: string; place: string | null; source: string };
function deps(o: { stored?: W.WantPlace | null; told?: string[]; reply?: string; fail?: boolean }) {
  const saved: Saved[] = [];
  const asked: string[] = [];
  let toldRead = 0;
  const d: W.PlaceDeps = {
    since: async () => SINCE,
    row: async () => o.stored ?? null,
    told: async () => {
      toldRead++;
      return o.told ?? [];
    },
    model: async (prompt) => {
      asked.push(prompt);
      if (o.fail) throw new Error("down");
      return o.reply ?? '{"place": null}';
    },
    save: async (_u, _w, p) => {
      saved.push({ key: p.key, place: p.place, source: p.source });
    },
    log: (async () => {}) as any,
  };
  return { d, saved, asked, toldRead: () => toldRead };
}
const NEW = new Date(SINCE.getTime() + 86_400_000);
{
  const t = deps({ reply: '{"place": "SF", "quote": "founder dinners in SF"}' });
  const p = await W.placeFor("u", { key: "goal:a", text: "Small founder dinners in SF", createdAt: null }, t.d);
  check("the want's own words: their place, stored once", p.place === "SF" && p.source === "their_words" && t.saved.length === 1 && t.saved[0].place === "SF");
}
{
  // The retrofit (Royce: "reading place from existing wants never guesses"): an older want whose text names no place gets none, even
  // when a line of theirs would have said where, and that line is never even read.
  const t = deps({ told: ["I go to SF for all tech stuff"], reply: '{"place": "SF", "quote": "I go to SF for all tech stuff"}' });
  const p = await W.placeFor("u", { key: "goal:b", text: "Seeking friendships with people who want to build together", createdAt: null }, t.d);
  check("retrofit: an older want with no place in its own words gets no place (the home city stands in)", p.place === null && p.source === "none" && t.saved[0]?.place === null);
  check("retrofit: what they told Co isn't read for an older want", t.toldRead() === 0 && !/their own words about where/i.test(t.asked[0] ?? ""));
}
{
  const t = deps({ told: ["I split time between Sacramento and go to SF for all tech stuff"], reply: '{"place": "SF", "quote": "go to SF for all tech stuff"}' });
  const p = await W.placeFor("u", { key: "ask:1", text: "tech meetups", createdAt: NEW }, t.d);
  check("a new want takes its place from what they told Co, with their words as the quote", p.place === "SF" && p.source === "told" && p.quote === "go to SF for all tech stuff");
}
{
  const t = deps({ told: ["I like Oakland"], reply: '{"place": "SF", "quote": "SF is great"}' });
  const p = await W.placeFor("u", { key: "ask:2", text: "tech meetups", createdAt: NEW }, t.d);
  check("a proposed place no line of theirs says is never kept (a model guess is no place)", p.place === null && p.source === "none");
}
{
  const t = deps({ stored: { key: "ask:3", place: "Oakland", source: "corrected", quote: "actually Oakland", notedAt: new Date() } });
  const p = await W.placeFor("u", { key: "ask:3", text: "x", createdAt: NEW }, t.d);
  check("a stored place is used as it is, with no new read", p.place === "Oakland" && t.asked.length === 0);
}
{
  const t = deps({ fail: true });
  const p = await W.placeFor("u", { key: "ask:4", text: "x in SF", createdAt: null }, t.d);
  check("a read that fails gives no place for this search and stores nothing (read again next time)", p.place === null && t.saved.length === 0);
}

// ---------------------------------------------------------------- 3. a Sacramento member with SF wants gets SF Luma results
{
  const E = await import("../../src/services/eventSurfacingSweep.js");
  const t = deps({ reply: '{"place": "SF", "quote": "founder dinners in SF"}' });
  const where = await E.searchPlace({ askId: "profile", userId: "u", askText: "founder community SF small dinners", city: "Sacramento", want: { key: "goal:c", text: "Small founder dinners in SF", createdAt: null } }, t.d);
  check("the search for an SF want looks in SF, not their home city", where.city === "SF" && where.searchedIn.place === "SF" && where.searchedIn.source === "their_words");
  const none = await E.searchPlace({ askId: "profile", userId: "u", askText: "friendships", city: "Sacramento", want: { key: "goal:d", text: "Seeking friendships", createdAt: null } }, deps({}).d);
  check("a want with no place searches their home city", none.city === "Sacramento" && none.searchedIn.source === "home");
  const noWant = await E.searchPlace({ askId: "profile", userId: "u", askText: "anything", city: "Sacramento" }, t.d);
  check("a search with no want named searches their home city", noWant.city === "Sacramento" && noWant.searchedIn.key === null);

  // Through the real Luma discovery code: the city picks the Luma place, and the feed comes from that place.
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = (pool as any).query;
  (pool as any).query = async (q: string) => (/geocode_cache/.test(q) ? { rows: [{ lat: 38.58, lng: -121.49 }] } : { rows: [] });
  const realFetch = globalThis.fetch;
  const placesHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { places: [{ place: { api_id: "pl-sf", name: "San Francisco", slug: "sf", coordinate: { latitude: 37.77, longitude: -122.42 } } }, { place: { api_id: "pl-sac", name: "Sacramento", slug: "sacramento", coordinate: { latitude: 38.58, longitude: -121.49 } } }] } } } })}</script>`;
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const feeds: Record<string, string[]> = { "pl-sf": ["SF Founders Dinner", "AI Builders Breakfast"], "pl-sac": ["Bubbleween Bash", "Kidical Mass Sacramento"] };
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input?.url ?? input));
    if (url.hostname === "lu.ma" && url.pathname === "/discover") return new Response(placesHtml, { status: 200 });
    if (url.hostname === "api.luma.com") {
      const names = feeds[url.searchParams.get("discover_place_api_id") ?? ""] ?? [];
      return new Response(JSON.stringify({ entries: names.map((name, i) => ({ event: { api_id: `${name}-${i}`, name, start_at: soon, url: `e${i}` } })), has_more: false }), { status: 200 });
    }
    throw new Error(`refused: ${url.hostname}`);
  }) as typeof fetch;
  try {
    const L = await import("../../src/services/lumaDiscovery.js");
    const sf = (await L.fetchPublicEvents(10, where.city)).map((e) => e.name);
    const home = (await L.fetchPublicEvents(10, "Sacramento")).map((e) => e.name);
    check("Sacramento member, SF want: Luma's feed is San Francisco's", sf.includes("SF Founders Dinner") && !sf.some((n) => /Bubbleween|Sacramento/.test(n)), sf);
    check("... while their home city's search would have been Sacramento's (the 10-15 morning)", home.includes("Bubbleween Bash") && !home.includes("SF Founders Dinner"), home);
  } finally {
    globalThis.fetch = realFetch;
    (pool as any).query = realQuery;
  }
  const ess = src("services/eventSurfacingSweep.ts");
  const sfind = src("services/sweepFind.ts");
  check("wiring: the search hands the want's place to sweepFind, and sweepFind's Luma and web searches use it", /city: where\.city, homeCity: candidate\.city/.test(ess) && /eventCandidates\(what, c\.city/.test(sfind) && /taskWebSearch\(c\.userId, q, \{ city: c\.city/.test(sfind));
  check("wiring: every find carries where it was searched", /searchedIn: where\.searchedIn/.test(ess));
  const ds = src("services/dailySweep.ts");
  check("wiring: the morning sweep names each ask and each goal as its own want", /want: \{ key: `ask:\$\{a\.id\}`/.test(ds) && /want: \{ key: `goal:\$\{b\.id\}`, text: g\.goal/.test(ds));
  // Hourly (Royce, 2026-10-15): "per-goal only for goals whose place differs from home, everything else rides the shared search".
  const split = W.splitByPlace([{ key: "g1", item: "tech meetups" }, { key: "g2", item: "run club" }, { key: "g3", item: "pottery" }, { key: "g4", item: "board games" }], [{ key: "g1", place: "SF" }, { key: "g2", place: null }, { key: "g3", place: "sacramento" }], "Sacramento");
  check("hourly: a goal placed somewhere other than home is searched on its own, there", split.own.length === 1 && split.own[0].key === "g1" && split.own[0].place === "SF");
  check("hourly: goals with no place, placed at home by name, or never read ride the one shared search", split.home.map((h) => h.key).join(",") === "g2,g3,g4");
  const gs = src("services/goalSweep.ts");
  check("wiring: the hourly sweep searches each non-home goal as its own want and the rest together (the shared search as before when none is elsewhere)", /W\.splitByPlace\(/.test(gs) && /want: \{ key: o\.key, text: o\.item\.goal/.test(gs) && /own\.length \? edgeSearchText\(home\.map/.test(gs) && /await deps\.surface\(row, searchText, \{ active, extras \}\)/.test(gs));
}

// ---------------------------------------------------------------- 4. the line, once
check("the line goes for a place they didn't name in the want, once", W.noteDue({ place: "SF", source: "told", notedAt: null }) === W.PLACE_NOTE("SF") && W.noteDue({ place: "SF", source: "told", notedAt: new Date() }) === null);
check("no line when the want said where, when they corrected it, or when it's their home city", W.noteDue({ place: "SF", source: "their_words", notedAt: null }) === null && W.noteDue({ place: "Oakland", source: "corrected", notedAt: null }) === null && W.noteDue({ place: null, source: "none", notedAt: null }) === null);
{
  const pr = src("harness/proactive.ts");
  check("the line rides the bundle beside its find (before the closing question if its caption can't be found), and is marked said only once delivered", /const at = i >= 0 \? i \+ 1 : composed\.messages\.length - \(composed\.closing \? 1 : 0\);/.test(pr) && /placeNote && result\.delivered\.includes\(placeNote\.line\)/.test(pr) && /W\.markNoted\(userId, placeNote!\.key\)/.test(pr));
}

// ---------------------------------------------------------------- 5. visible, correctable, removable
{
  const K = await import("../../src/services/whatCoKnows.js");
  const items = K.knownItems({ profile: { city: "Sacramento", long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent: [] }, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], places: [{ key: "goal:x", want: "founder dinners", place: "SF" }, { key: "ask:y", want: "a run club", place: null }] });
  const sf = items.find((i) => i.ref === "place:goal:x");
  const home = items.find((i) => i.ref === "place:ask:y");
  check("what Cue knows shows each want's place, correctable", !!sf && /founder dinners/.test(sf.text) && /SF/.test(sf.text) && sf.canCorrect);
  check("... and a want with no place says the home city stands in", !!home && /near home \(Sacramento\)/.test(home.text));
  const set: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args?: unknown[]) => (set.push({ sql, args: args ?? [] }), { rows: [], rowCount: 1 }) };
  const raw: any = { places: [{ key: "goal:x", want: "founder dinners", place: "SF" }] };
  const a = await K.applyOne(db, "u", raw, sf!, "correct", "Oakland", "actually Oakland");
  // Only the place writes (a correction also reads that want's pooled finds: placeResolve.ts, 2026-10-29).
  const ups = () => set.filter((x) => /UPDATE want_places SET place/.test(x.sql));
  check("'actually Oakland' changes that want's place, at its source", "now" in a && a.now === "Oakland" && (a as any).was === "SF" && /UPDATE want_places SET place = \$3, source = \$4/.test(ups()[0]?.sql ?? "") && ups()[0].args[2] === "Oakland" && ups()[0].args[3] === "corrected");
  const r = await K.applyOne(db, "u", raw, sf!, "remove", null, "forget where");
  check("removing it leaves the want with no place (the home city stands in, never read again)", "now" in r && r.now === null && ups()[1].args[2] === null && ups()[1].args[3] === "removed");
  check("removed or corrected, it's never re-read: a stored row is always used (only a window's 'unread' row is read)", /if \(have && have\.source !== "unread"\) return have;/.test(src("services/wantPlace.ts")));
}

// ---------------------------------------------------------------- 6. the too-tight query, loosened instead of refused
{
  check("loosened: the first four key words, the city and dates kept", Q.loosenQuery("pre-seed venture fund consumer apps 2026 applications open") === "pre-seed venture fund consumer 2026", Q.loosenQuery("pre-seed venture fund consumer apps 2026 applications open"));
  check("an OR group and a phrase each count once, and stay whole", Q.loosenQuery("(founder OR builder) dinner series SF small weekly private") === "(founder OR builder) dinner series SF small weekly", Q.loosenQuery("(founder OR builder) dinner series SF small weekly private"));
  const ledger = new Q.QueryLedger([]);
  const r = ledger.checkOrLoosen("web", "South Park Commons Fellowship application 2026");
  check("a query that's only too tight runs loosened, not refused", r.bad.length === 0 && r.query !== "South Park Commons Fellowship application 2026" && r.loosenedFrom === "South Park Commons Fellowship application 2026", r);
  ledger.ran("web", r.query, 3, r.loosenedFrom);
  check("every loosening is logged with what Co wrote", ledger.queries.some((q) => q.loosenedFrom === "South Park Commons Fellowship application 2026" && q.query === r.query));
  const named = new Q.QueryLedger(["Jordan"]);
  const bad = named.checkOrLoosen("web", "Jordan startup founder dinners SF weekly private");
  check("anything else wrong with it is still refused (never loosened past a real problem)", bad.bad.length > 0 && named.queries.some((q) => q.refused));
  const fine = new Q.QueryLedger([]).checkOrLoosen("web", "SF founder dinners");
  check("a query that's fine runs as written", fine.query === "SF founder dinners" && !fine.loosenedFrom && !fine.bad.length);
  const sfind = src("services/sweepFind.ts");
  check("wiring: the web and X searches loosen, and say so in what the sweep did", (sfind.match(/checkOrLoosen\(/g) ?? []).length >= 2 && /loosened from: /.test(sfind));
}

// ---------------------------------------------------------------- 7. the tier's close call goes to the find that won't keep
{
  const j = (id: string, o: Partial<import("../../src/services/sweepSelect.js").Judgment> = {}) => ({ id, key: id, name: id, kind: "discovery" as const, verdict: "send" as const, reason: "clears_bar", why: "", ...o }) as import("../../src/services/sweepSelect.js").Judgment;
  const date = (m: Record<string, string | null>) => (x: { id: string }) => m[x.id] ?? null;
  const today = "2026-10-15";
  check("close, and the runner-up ends in two days while the leader is a month out: the runner-up goes", SS.perishableFirst(j("A", { rank: 1, taste: "matches" }), j("B", { rank: 2, taste: "matches" }), date({ A: "2026-11-12", B: "2026-10-17" }), today));
  check("... or the leader has no date at all", SS.perishableFirst(j("A", { rank: 1 }), j("B", { rank: 2 }), date({ A: null, B: "2026-10-16" }), today));
  check("not close (ranks apart): fit decides", !SS.perishableFirst(j("A", { rank: 1 }), j("B", { rank: 3 }), date({ A: "2026-11-12", B: "2026-10-16" }), today));
  check("not close (a different taste, or one didn't clear the bar): fit decides", !SS.perishableFirst(j("A", { rank: 1, taste: "matches" }), j("B", { rank: 2, taste: "neutral" }), date({ A: "2026-11-12", B: "2026-10-16" }), today) && !SS.perishableFirst(j("A", { rank: 1 }), j("B", { rank: 2, verdict: "hold", reason: "fit_only" }), date({ A: "2026-11-12", B: "2026-10-16" }), today));
  check("not perishable (more than three days out, or not sooner): fit decides", !SS.perishableFirst(j("A", { rank: 1 }), j("B", { rank: 2 }), date({ A: "2026-11-12", B: "2026-10-25" }), today) && !SS.perishableFirst(j("A", { rank: 1 }), j("B", { rank: 2 }), date({ A: "2026-10-16", B: "2026-10-17" }), today));
  check("an answer to their ask always comes before a find, however soon the find ends", !SS.perishableFirst(j("A", { rank: 1, kind: "answer" as any }), j("B", { rank: 2 }), date({ A: null, B: "2026-10-16" }), today));
  check("wiring: tier picks apply it to the top two of each tier, and the loser waits (tier_taken), never removed", /perishableFirst\(inTier\[0\], inTier\[1\]/.test(src("services/sweepSelect.ts")) && /reason: "tier_taken"/.test(src("services/sweepSelect.ts")));
}

// ---------------------------------------------------------------- 8. a find's date, kept when its own text shows it
{
  const t = "Builders who Run SF, 5M Run & BBQ at Angel Island, Saturday Oct 17. No pitches.";
  check("a date its text shows is kept", SF.shownDate("2026-10-17", t, "2026-10-15") === "2026-10-17");
  check("written other ways too (October 17th, 10/17, the ISO date)", SF.shownDate("2026-10-17", "on October 17th", "2026-10-15") === "2026-10-17" && SF.shownDate("2026-10-17", "Sat 10/17 at 9am", "2026-10-15") === "2026-10-17" && SF.shownDate("2026-10-17", "date: 2026-10-17", "2026-10-15") === "2026-10-17");
  check("a date its text doesn't show is no date (never trusted from the model alone)", SF.shownDate("2026-10-18", t, "2026-10-15") === null && SF.shownDate("2026-11-17", t, "2026-10-15") === null);
  check("a past date, or a malformed one, is no date", SF.shownDate("2026-10-17", t, "2026-10-20") === null && SF.shownDate("Oct 17", t, "2026-10-15") === null);
  check("wiring: keep stores it as the find's stated date, only for a web or X find without one", /m\.tier === 3 && !\(m as any\)\.statedDates\?\.start \? shownDate\(/.test(src("services/sweepFind.ts")));
}

// ---------------------------------------------------------------- 9. the independent review's fixes (2026-10-15)
{
  check("a kind of thing after the place keeps it ('SF Tech Week', 'SF AI founder events')", W.backedPlace("SF", "SF Tech Week", ["going to SF Tech Week"])?.place === "SF" && W.backedPlace("SF", "SF AI founder events", ["SF AI founder events in November"])?.place === "SF");
  // Royce, 2026-10-31: code never regex-reads the member's intent; Cue decides, code guards facts. A place they ruled out, or a place word
  // inside a longer name, is Cue's call (its prompt and tool text say so); the code check is only that the quote is theirs and names it.
  check("code doesn't read what their words mean: a ruled-out place or a name passes the fact check (quote theirs, place in it)", W.backedPlace("SF", "anywhere but SF", ["dinners anywhere but SF"])?.place === "SF" && W.backedPlace("SF", "outside of SF", ["anything outside of SF"])?.place === "SF" && W.backedPlace("South Park", "South Park Commons", ["South Park Commons"])?.place === "South Park");
  check("... and the fact checks stand: a quote not in their words, or a place not in the quote, is still no place", W.backedPlace("SF", "anywhere but SF", ["dinners anywhere"]) === null && W.backedPlace("Oakland", "anywhere but SF", ["dinners anywhere but SF"]) === null);
  const ruledOut = /place they rule(?:d)? out \(\\?"anywhere but SF\\?"/;
  check("Cue is told: the want's place read says a ruled-out place or a word inside a name is no place", ruledOut.test(W.placePrompt({ key: "k", text: "dinners anywhere but SF", createdAt: null }, [])) && /"South Park" in South Park Commons/.test(W.placePrompt({ key: "k", text: "t", createdAt: null }, [])));
  check("no note when the place they told Co is their home city, by any spelling", W.noteDue({ place: "Sacramento", source: "told", notedAt: null }, "Sacramento, CA") === null && W.samePlace("Sacramento", "sacramento, ca") && !W.samePlace("SF", "Sacramento"));
  const split = W.splitByPlace([{ key: "g", item: 1 }], [{ key: "g", place: "Sacramento" }], "Sacramento, CA");
  check("a goal placed in their home city (any spelling) rides the shared search, not a second one", split.own.length === 0 && split.home.length === 1);
  const K = await import("../../src/services/whatCoKnows.js");
  const { goalHash } = await import("../../src/services/goalEdges.js");
  const dir = "Build a founder community in NYC";
  const live = await K.livePlaces([{ want_key: `goal:${goalHash(dir)}`, want_text: dir, place: "NYC" }, { want_key: `goal:${goalHash("an old dropped goal")}`, want_text: "an old dropped goal", place: "LA" }], { goals: [], intent: [], long_term_direction: dir });
  check("a long-term direction's place is shown (it's searched as a goal), a dropped goal's isn't", live.length === 1 && live[0].place === "NYC", live);
  const many = await K.livePlaces([...Array.from({ length: 30 }, (_, i) => ({ want_key: `goal:${goalHash(`dropped ${i}`)}`, want_text: `dropped ${i}`, place: "LA" })), { want_key: `goal:${goalHash(dir)}`, want_text: dir, place: "NYC" }], { goals: [], intent: [], long_term_direction: dir });
  check("dropped goals' rows never crowd a live one out (filtered before the limit)", many.length === 1 && many[0].place === "NYC");
  const wk = src("services/whatCoKnows.ts");
  check("a removed place is still shown (as near home) so 'actually SF' can land on it", !/source <> 'removed'/.test(wk) && /near home/.test(wk));
  const E = await import("../../src/services/eventSurfacingSweep.js");
  const promise = await E.searchPlace({ askId: "promise:send-the-plan", userId: "u", askText: "send the plan", city: "Sacramento" }, deps({ reply: '{"place":"SF","quote":"x"}' }).d);
  check("a promise Co made on a call isn't a want of theirs: no place is read or stored for it", promise.city === "Sacramento" && promise.searchedIn.key === null);
  check("a date that names another year is no date ('Oct 17, 2025')", SF.shownDate("2026-10-17", "Oct 17, 2025 at the pier", "2026-10-15") === null && SF.shownDate("2026-10-17", "Oct 17, 2026 at the pier", "2026-10-15") === "2026-10-17");
  check("'Sept 30' reads as September 30", SF.shownDate("2026-09-30", "Sept 30, demo night", "2026-09-01") === "2026-09-30");
  check("loosening keeps an exclusion and the city it's searched in, inside the limit", Q.loosenQuery("AI founder dinners networking pitch Seattle -crypto", 4, ["Seattle"]) === "AI founder Seattle -crypto", Q.loosenQuery("AI founder dinners networking pitch Seattle -crypto", 4, ["Seattle"]));
  const sac = new Q.QueryLedger([]).checkOrLoosen("web", "AI founder dinners networking Sacramento", ["Sacramento"]);
  check("a too-tight query naming their own city runs loosened (not refused)", sac.bad.length === 0 && /Sacramento/.test(sac.query) && !!sac.loosenedFrom, sac);
  const ex = new Q.QueryLedger([]).checkOrLoosen("web", "AI founder dinner pitch night -crypto");
  check("a too-tight query with an exclusion runs loosened, exclusion kept (not refused)", ex.bad.length === 0 && /-crypto/.test(ex.query), ex);
  check("SF and San Francisco are the same place (no note, no second search for their own city)", W.samePlace("SF", "San Francisco") && W.samePlace("NYC", "New York, NY") && W.noteDue({ place: "SF", source: "told", notedAt: null }, "San Francisco") === null);
  const SH = await import("../../src/services/sweepShadow.js");
  check("the picker is told a find was searched where its want is, after its own facts (not their far-off home)", /SOLD OUT.*searched in SF, where this want of theirs is/.test(SH.describeMatch({ name: "x", details: { soldOut: true }, searchedIn: { key: "goal:a", place: "SF", source: "their_words" } }) ?? "") && !/searched in/.test(SH.describeMatch({ name: "x", searchedIn: { key: null, place: "Sacramento", source: "home" } }) ?? ""));
  check("the note sits right after its own find's caption", /const i = after \? composed\.messages\.lastIndexOf\(after\) : -1;/.test(src("harness/proactive.ts")) && /W\.noteDue\(row, person\.city \?\? null\)/.test(src("harness/proactive.ts")));
  check("what they told Co is read without Co's own notes on their line", /replace\(\/\\s\*\\\[\[\^\\\]\]\*\\\]\/g, ""\)/.test(src("services/wantPlace.ts")));
}

console.log(`place on the want: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
