// Where Cue searches from now on (services/searchArea.ts), and the honesty gap that let a change be claimed with nothing behind it.
// 2026-10-31, Royce: "Let's switch the search to San Francisco please going forward". Cue answered "Got it, switching to SF from here
// on out." with only saveFeedbackForTeam run: nothing changed, and the reply check skipped the claim read ("nothing claim-shaped").
// Zero tokens: the geocoders, the database and the model are stubs; the place candidates are the open geocoder's real answers.
//   npx tsx evals/discovery/searchArea.ts
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
import { readFileSync } from "fs";

const A = await import("../../src/services/searchArea.js");
const R = await import("../../src/services/placeResolve.js");
const E = await import("../../src/services/eventSurfacingSweep.js");
const G = await import("../../src/harness/replyGrounding.js");
const K = await import("../../src/services/whatCoKnows.js");
const CAP = await import("../../src/services/capabilities.js");
const CT = await import("../../src/agent/conversationTools.js");
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

const ROYCE = "Let’s switch the search to San Francisco please going forward";
const om = (name: string, admin1: string, country: string, lat: number, lng: number, population: number | null): C => ({ name, admin1, country, lat, lng, population, source: "geonames" });
const OPEN: Record<string, C[]> = {
  "san francisco": [om("San Francisco", "California", "US", 37.77493, -122.41942, 864816)],
  springfield: [om("Springfield", "Missouri", "US", 37.21533, -93.29824, 170188), om("Springfield", "Illinois", "US", 39.80172, -89.64371, 114394), om("Springfield", "Massachusetts", "US", 42.10148, -72.58981, 154341), om("Springfield", "Ohio", "US", 39.92423, -83.80882, 59680), om("Springfield", "Oregon", "US", 44.04624, -123.02203, 60870)],
};
const SAC = { lat: 38.5781342, lng: -121.4944209 };

// The member's record, stubbed: their home city, their area row, their pooled finds and pending offers, and what's written.
// Royce's real shape on 10-31: finds pooled for his asks and goals searched in Sacramento by fallback ("home"), one for his Bay Area
// ask at its own place.
const find = (name: string, source: string, key: string | null, place: string) => ({ name, match: { name, searchedIn: { key, place, source } } });
// failDrop: dropping the old finds throws, inside the transaction (writes are kept only when the whole transaction commits).
function world(o: { home?: string | null; down?: boolean; area?: string | null; backlog?: any[]; offers?: any[]; failDrop?: boolean } = {}) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const backlog = [{ ask_id: "a1", items: o.backlog ?? [] }];
  const offers = o.offers ?? [];
  const on = (sink: { sql: string; args: unknown[] }[]) => ({
    query: async (sql: string, args: unknown[] = []) => {
      if (/^\s*SELECT place, source, quote/.test(sql)) return { rows: o.area ? [{ place: o.area, source: "their_words", quote: null, resolved_for: o.area, resolved_status: "resolved", resolved_label: `${o.area}, California` }] : [], rowCount: 0 };
      if (/^\s*SELECT ask_id, items FROM event_backlogs/.test(sql)) return { rows: backlog, rowCount: backlog.length };
      if (/^\s*SELECT id, summary, payload::text AS payload FROM proactive_candidates/.test(sql)) return { rows: offers.map((x, i) => ({ id: i + 1, summary: x.name, payload: JSON.stringify(x) })), rowCount: offers.length };
      if (o.failDrop && /UPDATE event_backlogs/.test(sql)) throw new Error("drop failed");
      sink.push({ sql, args });
      if (/AND place IS NOT NULL/.test(sql) && /SET place = NULL/.test(sql)) return { rows: [], rowCount: o.area ? 1 : 0 };
      return { rows: [] as any[], rowCount: 1 };
    },
  });
  const db = on(writes);
  const tx = async <T,>(fn: (d: any) => Promise<T>): Promise<T> => {
    const staged: { sql: string; args: unknown[] }[] = [];
    const out = await fn(on(staged));
    writes.push(...staged);
    return out;
  };
  const stores: any[] = [];
  const resolve: import("../../src/services/placeResolve.js").ResolveDeps = {
    home: async (city) => (city === "Sacramento" ? SAC : null),
    homeCountry: async () => "US",
    lookup: async (place) => {
      if (o.down) throw new Error("geocoders down");
      return { google: [], local: OPEN[R.normName(R.parseQualified(place).name)] ?? [] };
    },
    row: async () => null,
    store: async (_u, _k, r) => void stores.push(r),
    log: async () => {},
    today: async () => "2026-10-31",
  };
  const changed = () => writes.filter((x) => /INSERT INTO want_places|UPDATE want_places/.test(x.sql));
  const backlogWrite = () => writes.find((x) => /UPDATE event_backlogs/.test(x.sql));
  const cancels = () => writes.filter((x) => /UPDATE proactive_candidates SET status = 'skipped'/.test(x.sql));
  return { writes, stores, changed, backlogWrite, cancels, deps: { db, tx, home: async () => (o.home === undefined ? "Sacramento" : o.home), resolve } as import("../../src/services/searchArea.js").SetAreaDeps };
}

// ---------------------------------------------------------------- 1. Royce's message: the change is made, and its receipt backs the reply
{
  const w = world();
  const r = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco please going forward", message: ROYCE }, w.deps);
  check("Royce's exact message sets his search area to San Francisco, resolved against his Sacramento home", r.ok && r.changed === "set" && r.label === "San Francisco, California", r);
  const up = w.changed().find((x) => /INSERT INTO want_places/.test(x.sql));
  check("... kept on his own row under the area key, as his words, with the point it resolved to", !!up && up.args[0] === "royce" && up.args[1] === A.AREA_KEY && up.args[3] === "San Francisco" && /'their_words'/.test(up.sql) && up.args[8] === "San Francisco, California" && up.args[9] === 37.77493, up?.args);
  check("... and nothing else about places is written (his home city, his asks and goals keep their own places)", w.changed().length === 1 && !w.writes.some((x) => /co_profiles|UPDATE want_places SET place/.test(x.sql)));
  const rf = G.baseReplyFacts();
  if (r.ok) G.addFact(rf, "did_this_turn", A.areaReceipt(r));
  // What the guard records when setSearchArea goes through (agent/toolGuard.ts, CHANGES_SOMETHING; checked in section 6).
  rf.changedBy = ["setSearchArea"];
  check("the receipt says where, what follows it, and that home stays", /San Francisco, California/.test(rf.facts.at(-1)!.text) && /home city stays Sacramento/.test(rf.facts.at(-1)!.text) && /name a place keep it/.test(rf.facts.at(-1)!.text));
  const honest = "Done. Your searches look in San Francisco from now on; asks that name a place keep theirs.";
  check("an honest reply on that receipt passes the change check", !G.codeChecks(honest, rf, { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  check("... and so does the reply Cue wrote that morning, once a tool really did it", !G.codeChecks("Got it, switching to SF from here on out.", rf, { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  const receiptId = rf.facts.at(-1)!.id;
  const passed = G.claimChecks([{ text: "switching to SF from here on out", type: "past_action", supported: true, factId: receiptId, quote: null }], rf, { message: ROYCE, recentConversation: "" });
  check("... and the claim read's citation of that receipt holds in code", passed.every((c) => c.pass), passed);
}

// ---------------------------------------------------------------- 2. without the tool: the claim is cut
{
  const rf = G.baseReplyFacts();
  G.addFact(rf, "did_this_turn", `Saved for the team: their feedback, summarized as "Royce asked Cue to switch his event/opportunity searches from Sacramento to San Francisco going forward." Only that feedback was saved; it is not a report of anything that broke on Cue's side.`);
  const draft = "Got it, switching to SF from here on out.";
  check("the 10-31 reply is now read for claims (it was skipped as 'nothing claim-shaped')", G.needsClaimCheck(draft));
  const checks = G.codeChecks(draft, rf, { message: ROYCE, recentConversation: "" });
  const bad = checks.filter((c) => !c.pass && c.name === "no_unbacked_change");
  check("with only a note for the team behind it, the change claim fails in code", bad.length === 1, checks);
  check("... and the cut takes exactly that sentence", G.stripUnsupported(draft, bad) === "", G.stripUnsupported(draft, bad));
  check("... keeping what's true beside it", G.stripUnsupported(`Got it, switching to SF from here on out. Passed it along to the team.`, bad) === "Passed it along to the team.");
  const fb = rf.facts.find((f) => /^Saved for the team:/.test(f.text))!.id;
  const read = G.claimChecks([{ text: "switching to SF from here on out", type: "past_action", supported: true, factId: fb, quote: null }], rf, { message: ROYCE, recentConversation: "" });
  check("a claim read that cites the team note for the change is overruled: a note for the team never backs a change", read.length === 1 && !read[0].pass && /saved for the team backs only/.test(read[0].reason ?? ""), read);
  const team = G.claimChecks([{ text: "passed it along to the team", type: "past_action", supported: true, factId: fb, quote: null }], rf, { message: ROYCE, recentConversation: "" });
  check("... while 'passed it along to the team' still stands on it", team.every((c) => c.pass), team);
  const flagged = G.claimChecks([{ text: "I've flagged it to get fixed", type: "past_action", supported: true, factId: fb, quote: null }], rf, { message: ROYCE, recentConversation: "" });
  check("... and so does 'I've flagged it to get fixed' (passing it along, not a change)", flagged.every((c) => c.pass), flagged);
  check("the same with nothing at all behind it", G.codeChecks(draft, G.baseReplyFacts(), { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change" && !c.pass));
  check("'from now on I'll...' with nothing behind it is cut too", G.codeChecks("From now on I'll only send SF events.", G.baseReplyFacts(), { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  // Not a claim of Cue's: an offer, advice, their own move, a change of subject.
  for (const ok of ["Want me to switch your searches to SF from now on?", "Going forward, it might help to block Fridays.", "Moving to SF is a big step.", "Switching gears to the dinner: who's coming?", "I'll point you to the RSVP link."]) check(`not a change claim: "${ok}"`, G.changeClaims(ok).length === 0, G.changeClaims(ok));
  // Keeping going on work already running for them is not a change: the daily search of an open ask backs "from now on" there.
  const running = G.baseReplyFacts();
  G.addFact(running, "ongoing", "Cue's daily search is looking for: founder dinners in SF.");
  check("'I'll keep looking for that from now on' on running work isn't cut by the change check (the claim read still holds it)", !G.codeChecks("I'll keep looking for that from now on.", running, { message: "x", recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  check("... but a switch said as made still needs this turn's receipt", G.codeChecks("Switched your searches over to SF.", running, { message: "x", recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
}

// ---------------------------------------------------------------- 3. ambiguous places ask; nothing changes
{
  const w = world();
  const r = await A.setSearchArea("royce", { place: "Springfield", theirWords: "Springfield going forward", message: "Springfield going forward" }, w.deps);
  check("'Springfield going forward' from Sacramento asks which one, with the options", !r.ok && "ask" in r && r.ask.length >= 2 && r.ask.every((x) => /^Springfield, /.test(x)), r);
  check("... and writes nothing", w.writes.length === 0, w.writes);
  const which = world();
  const settled = await A.setSearchArea("royce", { place: "Springfield, Missouri", theirWords: "the Missouri one", message: "the Missouri one", recent: "Royce: Springfield going forward\nCue: Which Springfield, Missouri or Massachusetts?" }, which.deps);
  check("his answer to 'which Springfield?' settles it: Springfield, Missouri, kept", settled.ok && settled.changed === "set" && settled.label === "Springfield, Missouri" && which.changed().length === 1, settled);
  const made = world();
  const invented = await A.setSearchArea("royce", { place: "Springfield, Missouri", theirWords: "yes", message: "yes", recent: "Royce: anything fun this weekend?" }, made.deps);
  check("... but a place no one said in the exchange is never kept", !invented.ok && made.writes.length === 0, invented);
  const failing = world({ failDrop: true, backlog: [find("Sac mixer", "home", "goal:inv", "Sacramento")] });
  const f = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco please going forward", message: ROYCE }, failing.deps);
  check("if dropping the old finds fails, nothing is saved (one transaction) and the result says nothing changed", !f.ok && "error" in f && /couldn't be saved/.test(f.error) && failing.changed().length === 0 && failing.writes.length === 0, { f, writes: failing.writes });
  const failHome = world({ failDrop: true, area: "San Francisco", backlog: [find("SF thing", "area", "goal:inv", "San Francisco")] });
  const fh = await A.setSearchArea("royce", { place: "Sacramento", theirWords: "back to Sacramento from now on", message: "ok back to Sacramento from now on" }, failHome.deps);
  check("... the same setting it back to home", !fh.ok && failHome.writes.length === 0, { fh, writes: failHome.writes });
  check("the real transaction is one connection: BEGIN, the writes, COMMIT, or ROLLBACK", /tx: async \(fn\) => \{\s*const client = await pool\.connect\(\);[\s\S]{0,200}BEGIN[\s\S]{0,200}COMMIT[\s\S]{0,200}ROLLBACK[\s\S]{0,120}client\.release\(\)/.test(src("services/searchArea.ts")));
  const down = world({ down: true });
  const d = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco", message: ROYCE }, down.deps);
  check("a lookup that's down changes nothing and says so (never the bare word kept)", !d.ok && "error" in d && /couldn't be checked/.test(d.error) && down.writes.length === 0, d);
  const nq = world();
  const q = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "search San Francisco", message: ROYCE }, nq.deps);
  check("a quote that isn't in their message changes nothing", !q.ok && nq.writes.length === 0, q);
  const back = world({ area: "San Francisco" });
  const h = await A.setSearchArea("royce", { place: "Sacramento", theirWords: "back to Sacramento from now on", message: "ok back to Sacramento from now on" }, back.deps);
  check("their home city by name sets it back to home: the area is cleared, never their home written as an area", h.ok && h.changed === "home" && back.changed().length === 1 && /SET place = NULL, source = 'removed'/.test(back.changed()[0].sql), back.writes);
}

// ---------------------------------------------------------------- 4. the sweep uses it, for him only
{
  const area = { place: "San Francisco", source: "their_words" as const, quote: "switch the search to San Francisco please going forward", label: "San Francisco, California" };
  const placeDeps = (place: string | null): import("../../src/services/wantPlace.js").PlaceDeps => ({
    since: async () => null,
    row: async () => ({ key: "k", place, source: place ? "their_words" : "none", quote: null, notedAt: null }),
    told: async () => [],
    model: async () => "{}",
    save: async () => {},
    log: async () => {},
    area: async (userId) => (userId === "royce" ? area : null),
  });
  const stored = { forPlace: "San Francisco", forHome: "Sacramento", status: "resolved" as const, label: "San Francisco, California", lat: 37.77493, lng: -122.41942, options: [], homeCountry: "US" };
  const keys: string[] = [];
  const rdeps: import("../../src/services/placeResolve.js").ResolveDeps = {
    home: async () => SAC, homeCountry: async () => "US", lookup: async () => { throw new Error("no lookup expected"); },
    row: async (_u, key) => (keys.push(key), { windowEnd: null, resolution: key === A.AREA_KEY ? stored : null }), store: async () => {}, log: async () => {}, today: async () => "2026-10-31",
  };
  const goalNoPlace = { askId: "profile", askText: "investors who back consumer apps", city: "Sacramento", want: { key: "goal:inv", text: "investors who back consumer apps", createdAt: null } };
  const mine = await E.placeToSearch({ ...goalNoPlace, userId: "royce" }, { place: placeDeps(null), resolve: rdeps });
  check("his goal with no place of its own is searched in his area, at its stored point (no fresh lookup)", mine.city === "San Francisco, California" && mine.point?.lat === 37.77493 && mine.searchedIn.source === "area" && mine.searchedIn.key === "goal:inv" && keys.includes(A.AREA_KEY), mine);
  const shared = await E.placeToSearch({ askId: "profile", askText: "consumer founders", city: "Sacramento", userId: "royce" }, { place: placeDeps(null), resolve: rdeps });
  check("... and so is his goals' shared search (no want named)", shared.city === "San Francisco, California", shared);
  const own = await E.placeToSearch({ ...goalNoPlace, userId: "royce", want: { key: "ask:bay", text: "founder dinners in the Bay Area", createdAt: null } }, { place: placeDeps("Bay Area"), resolve: { ...rdeps, row: async () => ({ windowEnd: null, resolution: { forPlace: "Bay Area", forHome: "Sacramento", status: "resolved", label: "San Francisco Bay Area, California", lat: 37.83, lng: -122.29, options: [], homeCountry: "US" } }) } });
  check("an ask that names its own place keeps it", own.city === "San Francisco Bay Area, California" && own.searchedIn.source === "their_words", own);
  const other = await E.placeToSearch({ ...goalNoPlace, userId: "jordan" }, { place: placeDeps(null), resolve: rdeps });
  check("another member's searches are unaffected: still their home city", other.city === "Sacramento" && other.searchedIn.source === "home", other);
}

// ---------------------------------------------------------------- 5. visible and removable; the tool is Cue's
{
  const items = K.knownItems({ profile: { city: "Sacramento", long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent: [] }, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], places: [{ key: "goal:inv", want: "investors who back consumer apps", place: null, source: "none" }], area: { place: "San Francisco", searching: "San Francisco, California" } });
  const line = items.find((i) => i.ref === `place:${A.AREA_KEY}`);
  check("what Cue knows shows his search area, correctable and removable like a want's place", !!line && line.canCorrect && /San Francisco · searching San Francisco, California/.test(line.text), items);
  check("... and his wants with no place say they look there, not 'near home'", items.some((i) => i.ref === "place:goal:inv" && /San Francisco, where you asked me to search/.test(i.text)));
  const none = K.knownItems({ profile: { city: "Sacramento", long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent: [] }, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], places: [{ key: "goal:inv", want: "x", place: null, source: "none" }] });
  check("with no area set, nothing changes there ('near home (Sacramento)')", !none.some((i) => i.ref === `place:${A.AREA_KEY}`) && none.some((i) => /near home \(Sacramento\)/.test(i.text)));
  const wk = src("services/whatCoKnows.ts");
  check("removing or correcting it goes through the want-place correction (setPlace), which clears its stored point", /case "place": \{[\s\S]{0,400}setPlace\(db, userId, key/.test(wk));
  const { tools } = CT.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true } as any);
  check("setSearchArea is a tool Cue chooses, described from the registry", "setSearchArea" in tools && (tools as any).setSearchArea.description === CAP.toolUse("setSearchArea"));
  check("... its result can be worth a line to them (not silent bookkeeping)", CT.NEW_FOR_THEM.has("setSearchArea") && !CT.SILENT_TOOLS.has("setSearchArea"));
  check("the turn says where Cue searches while it's set", /areaFact\(a, profile\?\.city/.test(src("routes/sendblue.ts")));
  check("the reply's own searches use it as home when it's set", (src("agent/loopTools.ts").match(/await searchHome\(\)/g) ?? []).length === 2);
}

// ---------------------------------------------------------------- 6. review of #336
// 6a. The hourly goal sweep: a goal naming their home city is searched at home, never carried into the area by the shared search.
{
  const W = await import("../../src/services/wantPlace.js");
  const items = [{ key: "goal:sac", item: "Sacramento founder dinners" }, { key: "goal:none", item: "investors" }, { key: "goal:bay", item: "Bay Area mixers" }];
  const places = [{ key: "goal:sac", place: "Sacramento" }, { key: "goal:none", place: null }, { key: "goal:bay", place: "Bay Area" }];
  const before = W.splitByPlace(items, places, "Sacramento");
  check("with no area, a home-named goal rides the shared (home) search, as before", before.home.map((x) => x.key).join() === "goal:sac,goal:none" && before.own.map((x) => x.key).join() === "goal:bay", before);
  const after = W.splitByPlace(items, places, "Sacramento", { homeIsOwn: true });
  check("with an area set, a home-named goal is its own search; only goals with no place share the area search", after.home.map((x) => x.key).join() === "goal:none" && after.own.map((x) => x.key).join() === "goal:sac,goal:bay", after);
  check("the hourly sweep sets homeIsOwn from their search area (a failed read counts as set)", /searchAreaOf\(row\.user_id\)\)\.then\(\(a\) => !!a\)\.catch\(\(\) => true\)/.test(src("services/goalSweep.ts")) && /row\.city \?\? null, \{ homeIsOwn: areaSet \}\)/.test(src("services/goalSweep.ts")));
  const area = { place: "San Francisco", source: "their_words" as const, quote: null, label: "San Francisco, California" };
  const pd: import("../../src/services/wantPlace.js").PlaceDeps = { since: async () => null, row: async () => ({ key: "goal:sac", place: "Sacramento", source: "their_words", quote: null, notedAt: null }), told: async () => [], model: async () => "{}", save: async () => {}, log: async () => {}, area: async () => area };
  const rd: import("../../src/services/placeResolve.js").ResolveDeps = { home: async () => SAC, homeCountry: async () => "US", lookup: async () => { throw new Error("none"); }, row: async () => null, store: async () => {}, log: async () => {}, today: async () => "2026-10-31" };
  const sac = await E.placeToSearch({ askId: "profile", userId: "royce", askText: "x", city: "Sacramento", want: { key: "goal:sac", text: "Sacramento founder dinners", createdAt: null } }, { place: pd, resolve: rd });
  check("... and that own search looks in Sacramento, not San Francisco", sac.city === "Sacramento" && sac.searchedIn.source === "their_words", sac);
}
// 6b. What was found for the old fallback goes when the area moves; finds for wants with their own place stay.
{
  const backlog = [find("Sac mixer", "home", "goal:inv", "Sacramento"), find("Sac dinner", "home", "ask:a1", "Sacramento"), find("SF thing", "area", "goal:inv", "San Francisco"), find("Bay dinner", "their_words", "ask:bay", "Bay Area"), { name: "old find, no searchedIn" }];
  const offers = [find("Sac offer", "home", "goal:inv", "Sacramento"), find("Bay offer", "their_words", "ask:bay", "Bay Area")];
  const w = world({ backlog, offers });
  const r = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco please going forward", message: ROYCE }, w.deps);
  const kept = JSON.parse(String(w.backlogWrite()?.args[2] ?? "[]")).map((x: any) => x.name);
  check("setting the area drops the finds found where wants with no place looked (home, or an old area)", r.ok && kept.join() === "Bay dinner,old find, no searchedIn", kept);
  check("... and cancels their pending offers as 'place corrected' (so they can queue again), leaving own-place offers alone", w.cancels().length === 1 && w.cancels()[0].args[0] === 1 && /^place corrected: /.test(String(w.cancels()[0].args[2])), w.cancels());
  const same = world({ area: "San Francisco", backlog, offers });
  await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco please going forward", message: ROYCE }, same.deps);
  check("the same area said again moves nothing, so nothing is dropped", !same.backlogWrite() && same.cancels().length === 0);
  const clear = world({ area: "San Francisco", backlog, offers });
  const c = await A.setSearchArea("royce", { place: "Sacramento", theirWords: "back to Sacramento from now on", message: "ok back to Sacramento from now on" }, clear.deps);
  const keptC = JSON.parse(String(clear.backlogWrite()?.args[2] ?? "[]")).map((x: any) => x.name);
  check("clearing it back to home does the same: fallback finds dropped, own-place finds kept", c.ok && keptC.join() === "Bay dinner,old find, no searchedIn" && clear.cancels().length === 1, keptC);
  const none = world({ backlog, offers });
  await A.setSearchArea("royce", { place: "Sacramento", theirWords: "back to Sacramento from now on", message: "ok back to Sacramento from now on" }, none.deps);
  check("... but with no area set, home by name changes nothing and drops nothing", !none.backlogWrite() && none.cancels().length === 0);
  // Corrected or removed in what Cue knows: the same drop, on the change's own transaction (whatCoKnows.ts cancelQueued).
  const cq = world({ backlog, offers });
  const db2 = { query: async (sql: string, args: unknown[] = []) => (/FROM co_tasks|FROM deferred_sends/.test(sql) || /SELECT id, type, target_key, summary/.test(sql) ? { rows: [] as any[], rowCount: 0 } : cq.deps.db.query(sql, args)) };
  const out = await K.cancelQueued(db2 as any, "royce", [{ ref: `place:${A.AREA_KEY}`, source: "place", was: "San Francisco", now: null } as any]);
  const keptK = JSON.parse(String(cq.backlogWrite()?.args[2] ?? "[]")).map((x: any) => x.name);
  check("removing the area in what Cue knows drops the fallback finds and cancels their offers, and says so", keptK.join() === "Bay dinner,old find, no searchedIn" && out.some((x) => x.kind === "candidate" && x.action === "cancelled") && out.some((x) => x.kind === "backlog"), out);
  check("a corrected area is resolved right away, not at the next sweep", /A\.settleArea\(userId, areaNow, A\.realSetAreaDeps\(\)\)/.test(src("services/whatCoKnows.ts")));
  const st = world();
  const settled = await A.settleArea("royce", "San Francisco", st.deps);
  check("... settleArea stores the resolution on the row", settled.ok && settled.label === "San Francisco, California" && st.stores[0]?.label === "San Francisco, California", settled);
  const amb = await A.settleArea("royce", "Springfield", world().deps);
  check("... and an ambiguous correction says which ones, so Cue asks", !amb.ok && (amb.ask?.length ?? 0) >= 2, amb);
}
// 6c. No silent fallback: an area that can't be read is never quietly home.
{
  const pd: import("../../src/services/wantPlace.js").PlaceDeps = { since: async () => null, row: async () => ({ key: "goal:inv", place: null, source: "none", quote: null, notedAt: null }), told: async () => [], model: async () => "{}", save: async () => {}, log: async () => {}, area: async () => { throw new Error("db down"); } };
  const r = await E.placeToSearch({ askId: "profile", userId: "royce", askText: "x", city: "Sacramento", want: { key: "goal:inv", text: "investors", createdAt: null } }, { place: pd });
  check("the sweep: an area read that fails searches nowhere this run and retries, never Sacramento", r.city === null && !!r.retry && /search area couldn't be read/.test(r.retry ?? ""), r);
  const loop = src("agent/loopTools.ts");
  check("reply searches: an area read that fails runs no search, is logged, and Cue is told (never the profile city)", /decision: "search\.area_unread"/.test(loop) && (loop.match(/=== AREA_UNREAD\) return areaUnread\(\)/g) ?? []).length === 2 && /r\.ok \? \(r\.area \?\? ctx\.turn\?\.profile\?\.city \?\? null\) : AREA_UNREAD/.test(loop));
}
// 6d. The change check, tightened.
{
  const fb = `Saved for the team: their feedback, summarized as "switch searches to SF going forward". Only that feedback was saved; it is not a report of anything that broke on Cue's side.`;
  for (const ok of ["Swap it to this: a smaller dinner, six people.", "Got it, switching to the Friday one: https://lu.ma/abc", "Let me switch over to your calendar question."]) check(`not a change claim: "${ok}"`, G.changeClaims(ok).length === 0, G.changeClaims(ok));
  check("'I'll move the dinner to Thursday.' is a change claim", G.changeClaims("I'll move the dinner to Thursday.").some((c) => c.kind === "change"));
  check("'Switched your searches over to SF.' is a change claim (bare, onto something of theirs)", G.changeClaims("Switched your searches over to SF.").some((c) => c.kind === "change"));
  const unrelated = G.baseReplyFacts();
  G.addFact(unrelated, "did_this_turn", "Sent them the link to the Friday dinner.");
  check("an unrelated receipt this turn (a send) backs no change claim", G.codeChecks("Got it, switching to SF from here on out.", unrelated, { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  const real = G.baseReplyFacts();
  real.changedBy = ["updateTask"];
  check("a tool that changed a record this turn backs it (the claim read still matches the words to its receipt)", !G.codeChecks("I'll move the dinner to Thursday.", real, { message: "x", recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  const team = G.baseReplyFacts();
  G.addFact(team, "did_this_turn", fb);
  const said = "I passed it to the team so your searches switch to SF going forward.";
  check("'passed it to the team so your searches switch to SF going forward' is cut with only the team note behind it", G.codeChecks(said, team, { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  const id = team.facts.find((f) => f.text === fb)!.id;
  const read = G.claimChecks([{ text: said, type: "past_action", supported: true, factId: id, quote: null }], team, { message: ROYCE, recentConversation: "" });
  check("... and the team note can't back it in the claim read either, 'team' in it or not", read.length === 1 && !read[0].pass, read);
  const registry = CAP.ABILITIES.filter((a) => a.tool).map((a) => a.tool!);
  const unclassified = registry.filter((t) => CAP.CHANGES_NOTHING.has(t) === CAP.CHANGES_SOMETHING.has(t));
  check("every registry tool is classified exactly once: changes nothing, or changes something (a new tool can't go unclassified)", unclassified.length === 0, unclassified);
  check("... and both lists name only registry tools", [...CAP.CHANGES_NOTHING, ...CAP.CHANGES_SOMETHING].every((t) => registry.includes(t)), [...CAP.CHANGES_NOTHING, ...CAP.CHANGES_SOMETHING].filter((t) => !registry.includes(t)));
  check("the guard reads 'changes nothing', so a tool is backing by default", /if \(!failed && !CHANGES_NOTHING\.has\(name\)\) ctx\.changed\?\.\(name\)/.test(src("agent/toolGuard.ts")) && CAP.CHANGES_NOTHING.has("saveFeedbackForTeam") && CAP.CHANGES_NOTHING.has("shareLink") && CAP.CHANGES_NOTHING.has("whatCoKnows") && !CAP.CHANGES_NOTHING.has("setSearchArea"));
  // The reviewer's true claims, each with the tool that made it this turn: never cut.
  for (const [line, tool] of [["I just updated the deck.", "updateDeck"], ["I've set a reminder to text Maya Friday.", "followUp"], ["I've updated your notes.", "updateNotes"], ["I've moved your intro request to Thursday.", "requestEventIntro"]] as const) {
    const f = G.baseReplyFacts();
    f.changedBy = [tool];
    check(`a true change with its tool behind it stands: "${line}" (${tool})`, !CAP.CHANGES_NOTHING.has(tool) && !G.codeChecks(line, f, { message: "x", recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  }
  // Widened verbs (round 2): the same claims without a tool are cut; advice and pointing are not claims.
  for (const bad of ["Let me change your searches to SF going forward.", "Let me move your searches to SF going forward.", "Changing your searches to SF going forward.", "Your searches move to SF from now on."]) check(`cut with no tool behind it: "${bad}"`, G.codeChecks(bad, G.baseReplyFacts(), { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  for (const ok of ["Moving forward, it might help to block Fridays.", "Going forward, it might help to change your pitch to focus on revenue.", "You could move your dinner to Thursday.", "You're all set from now on."]) check(`not a change claim: "${ok}"`, G.changeClaims(ok).length === 0, G.changeClaims(ok));
  // "We" is Cue too (it speaks as "I"): with "your" or the marker, a change claim; on its own, or advice, not one.
  for (const bad of ["We moved your searches to SF from now on.", "We've switched your searches over to SF.", "We'll move your searches to SF.", "We're switching to SF going forward."]) check(`a "we" change is a change claim, cut with no tool behind it: "${bad}"`, G.changeClaims(bad).some((c) => c.kind === "change") && G.codeChecks(bad, G.baseReplyFacts(), { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  for (const ok of ["We could move your dinner to Thursday if that helps?", "We moved on to the dinner, which is great.", "Sounds like we switched gears.", "So you and Sam moved to Oakland last year, and we changed nothing since."]) check(`not a "we" change claim: "${ok}"`, G.changeClaims(ok).length === 0, G.changeClaims(ok));
  const weTool = G.baseReplyFacts();
  weTool.changedBy = ["setSearchArea"];
  check("a true \"we\" change with its tool behind it stands", !G.codeChecks("We moved your searches to SF from now on.", weTool, { message: ROYCE, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  // Reclassified (2026-10-31): a share link made, an invite used, a connection that can be disconnected each change something.
  const moved = ["sendInvite", "calendarConnection"];
  check("sendInvite and the connection tools change something (they back a change claim)", moved.every((t) => CAP.CHANGES_SOMETHING.has(t) && !CAP.CHANGES_NOTHING.has(t)), moved.filter((t) => !CAP.CHANGES_SOMETHING.has(t) || CAP.CHANGES_NOTHING.has(t)));
  for (const [line, tool] of [["I've disconnected your calendar, so it's switched off from now on.", "calendarConnection"], ["I just changed your Google Docs connection over to off.", "docsConnection"]] as const) {
    const f = G.baseReplyFacts();
    f.changedBy = [tool];
    check(`a change claim with ${tool} behind it stands: "${line}"`, !G.codeChecks(line, f, { message: "x", recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  }
  // The guard records it: setSearchArea, run through Cue's own guarded tools (dry run), lands in the turn's changedBy.
  const changed: string[] = [];
  const { tools } = CT.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: ROYCE, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "", changed: (t: string) => changed.push(t) } } as any);
  await (tools as any).setSearchArea.execute({ place: "San Francisco", theirWords: "switch the search to San Francisco please going forward" }, {});
  await (tools as any).listSentOffers.execute({}, {});
  check("the guard records a state-changing tool that went through, and only that one", changed.join() === "setSearchArea", changed);
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
