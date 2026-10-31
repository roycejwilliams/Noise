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

// The member's record, stubbed: their home city and what's written.
function world(o: { home?: string | null; down?: boolean } = {}) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args: unknown[] = []) => (writes.push({ sql, args }), { rows: [] as any[], rowCount: 1 }) };
  const resolve: import("../../src/services/placeResolve.js").ResolveDeps = {
    home: async (city) => (city === "Sacramento" ? SAC : null),
    homeCountry: async () => "US",
    lookup: async (place) => {
      if (o.down) throw new Error("geocoders down");
      return { google: [], local: OPEN[R.normName(R.parseQualified(place).name)] ?? [] };
    },
    row: async () => null,
    store: async () => {},
    log: async () => {},
    today: async () => "2026-10-31",
  };
  return { writes, deps: { db, home: async () => (o.home === undefined ? "Sacramento" : o.home), resolve } as import("../../src/services/searchArea.js").SetAreaDeps };
}

// ---------------------------------------------------------------- 1. Royce's message: the change is made, and its receipt backs the reply
{
  const w = world();
  const r = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco please going forward", message: ROYCE }, w.deps);
  check("Royce's exact message sets his search area to San Francisco, resolved against his Sacramento home", r.ok && r.changed === "set" && r.label === "San Francisco, California", r);
  const up = w.writes.find((x) => /INSERT INTO want_places/.test(x.sql));
  check("... kept on his own row under the area key, as his words, with the point it resolved to", !!up && up.args[0] === "royce" && up.args[1] === A.AREA_KEY && up.args[3] === "San Francisco" && /'their_words'/.test(up.sql) && up.args[8] === "San Francisco, California" && up.args[9] === 37.77493, up?.args);
  check("... and nothing else is written (his home city, his asks and goals keep their own places)", w.writes.length === 1 && !w.writes.some((x) => /co_profiles|UPDATE want_places SET place/.test(x.sql)));
  const rf = G.baseReplyFacts();
  if (r.ok) G.addFact(rf, "did_this_turn", A.areaReceipt(r));
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
  check("his answer to 'which Springfield?' settles it: Springfield, Missouri, kept", settled.ok && settled.changed === "set" && settled.label === "Springfield, Missouri" && which.writes.length === 1, settled);
  const made = world();
  const invented = await A.setSearchArea("royce", { place: "Springfield, Missouri", theirWords: "yes", message: "yes", recent: "Royce: anything fun this weekend?" }, made.deps);
  check("... but a place no one said in the exchange is never kept", !invented.ok && made.writes.length === 0, invented);
  const down = world({ down: true });
  const d = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "switch the search to San Francisco", message: ROYCE }, down.deps);
  check("a lookup that's down changes nothing and says so (never the bare word kept)", !d.ok && "error" in d && /couldn't be checked/.test(d.error) && down.writes.length === 0, d);
  const nq = world();
  const q = await A.setSearchArea("royce", { place: "San Francisco", theirWords: "search San Francisco", message: ROYCE }, nq.deps);
  check("a quote that isn't in their message changes nothing", !q.ok && nq.writes.length === 0, q);
  const back = world();
  const h = await A.setSearchArea("royce", { place: "Sacramento", theirWords: "back to Sacramento from now on", message: "ok back to Sacramento from now on" }, back.deps);
  check("their home city by name sets it back to home: the area is cleared, never their home written as an area", h.ok && h.changed === "home" && back.writes.length === 1 && /SET place = NULL, source = 'removed'/.test(back.writes[0].sql), back.writes);
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

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
