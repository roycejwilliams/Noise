// Member preferences, PR C (services/memberPreferences.ts DECISION_AREAS, services/prefTopics.ts): preferences change decisions, not
// just sends. Royce's spec (2026-11-02), section 3: "an SF-only preference must change the search results, not just the sentence
// introducing them." Zero tokens: the model reads are canned answers (marked where they stand in), the geocoders are the open
// geocoder's real candidates, and the database is in memory. Everything between a rule's capture and the search, the queue and the
// reply runs for real: learnPreferences, resolveReads, setSearchArea, placeToSearch, the radius filter, the keep gate, the enqueue check.
//   npx tsx evals/preferences/decisions.ts
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

const P = await import("../../src/services/memberPreferences.js");
const T = await import("../../src/services/prefTopics.js");
const A = await import("../../src/services/searchArea.js");
const R = await import("../../src/services/placeResolve.js");
const E = await import("../../src/services/eventSurfacingSweep.js");
const TR = await import("../../src/services/tieredRecommendation.js");
const L = await import("../../src/services/memberLimits.js");
const G = await import("../../src/harness/replyGrounding.js");
const W = await import("../../src/services/whatCoKnows.js");
const CC = await import("../../src/services/callContext.js");
const CAP = await import("../../src/services/capabilities.js");
const { haversineMiles } = await import("../../src/services/geocoding.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
type C = import("../../src/services/placeResolve.js").PlaceCandidate;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

// ---------------------------------------------------------------- the world: one in-memory database for every member
const MEMBER_A = "00000000-0000-4000-8000-0000000000a1"; // lives in Sacramento, wants SF only
const MEMBER_B = "00000000-0000-4000-8000-0000000000b2"; // lives in Sacramento, set nothing
const MEMBER_C = "00000000-0000-4000-8000-0000000000c3"; // lives in Davis, corrects Sacramento to SF
const homes: Record<string, string> = { [MEMBER_A]: "Sacramento", [MEMBER_B]: "Sacramento", [MEMBER_C]: "Davis" };
type Fact = { id: number; owner_user_id: string; object_label: string; happened_at: Date; retired_at: Date | null; meta: any };
const facts: Fact[] = [];
const areas: Record<string, { place: string; quote: string; label: string | null } | undefined> = {};
const backlogs: Record<string, { ask_id: string; items: any[] }[]> = {};
const cands: Record<string, { id: number; type: string; summary: string; payload: any; status: string; skip_reason?: string }[]> = {};
const profileWrites: unknown[][] = [];
const handle = async (raw: string, a: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
  const sql = raw.replace(/\s+/g, " ").trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
  // co_facts: their rules
  if (/^SELECT id, object_label, happened_at, retired_at, meta FROM co_facts/.test(sql)) {
    const rows = facts.filter((r) => r.owner_user_id === a[0] && (/retired_at IS NULL/.test(sql) ? !r.retired_at : true));
    return { rows: rows.map((r) => ({ ...r, meta: JSON.parse(JSON.stringify(r.meta)) })), rowCount: rows.length };
  }
  if (/^INSERT INTO co_facts/.test(sql)) {
    const id = facts.length + 1;
    facts.push({ id, owner_user_id: a[0], object_label: a[1], happened_at: a[4], retired_at: null, meta: JSON.parse(a[5]) });
    return { rows: [{ id }], rowCount: 1 };
  }
  if (/^UPDATE co_facts SET retired_at = \$3/.test(sql)) {
    const r = facts.find((x) => String(x.id) === String(a[0]) && x.owner_user_id === a[1] && !x.retired_at);
    if (!r) return { rows: [], rowCount: 0 };
    r.retired_at = a[2];
    r.meta.state = /withdrawn/.test(sql) ? "withdrawn" : a[3];
    if (/object_label = ''/.test(sql)) { r.object_label = ""; r.meta.words = []; }
    return { rows: [{ meta: r.meta }], rowCount: 1 };
  }
  if (/^UPDATE co_facts SET retired_at = \$2/.test(sql)) {
    const hit = facts.filter((r) => r.owner_user_id === a[0] && !r.retired_at && r.meta.area === "search_area" && !r.meta.ruleRaw?.topic);
    for (const r of hit) { r.retired_at = a[1]; r.meta.state = "withdrawn"; r.meta.words = []; r.object_label = ""; }
    return { rows: [], rowCount: hit.length };
  }
  // want_places: their search area
  if (/^SELECT place, source, quote, resolved_for/.test(sql)) {
    const x = areas[a[0]];
    return { rows: x ? [{ place: x.place, source: "their_words", quote: x.quote, resolved_for: x.place, resolved_status: x.label ? "resolved" : null, resolved_label: x.label }] : [], rowCount: x ? 1 : 0 };
  }
  if (/^INSERT INTO want_places/.test(sql)) {
    areas[a[0]] = { place: a[3], quote: a[4], label: a[8] };
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE want_places SET place = NULL, source = 'removed'/.test(sql)) {
    const x = areas[a[0]];
    if (!x || (a[3] && x.place.toLowerCase() !== String(a[3]).toLowerCase())) return { rows: [], rowCount: 0 };
    areas[a[0]] = undefined;
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE want_places SET place = \$3/.test(sql) || /^INSERT INTO want_places .*ON CONFLICT .* place = \$3/.test(sql)) return { rows: [], rowCount: 1 };
  // co_profiles: their home (never written by any of this)
  if (/^SELECT city FROM co_profiles/.test(sql)) return { rows: homes[a[0]] ? [{ city: homes[a[0]] }] : [], rowCount: 1 };
  if (/co_profiles/.test(sql)) { profileWrites.push([sql, ...a]); return { rows: [], rowCount: 0 }; }
  // event_backlogs and proactive_candidates: what's waiting for them
  if (/^SELECT ask_id, items FROM event_backlogs/.test(sql)) return { rows: (backlogs[a[0]] ?? []).map((b) => ({ ask_id: b.ask_id, items: JSON.parse(JSON.stringify(b.items)) })), rowCount: 1 };
  if (/^SELECT items FROM event_backlogs/.test(sql)) return { rows: (backlogs[a[0]] ?? []).filter((b) => b.ask_id === a[1]).map((b) => ({ items: JSON.parse(JSON.stringify(b.items)) })), rowCount: 1 };
  if (/^UPDATE event_backlogs SET items/.test(sql)) {
    const b = (backlogs[a[0]] ?? []).find((x) => x.ask_id === a[1]);
    if (b) b.items = JSON.parse(a[2]);
    return { rows: [], rowCount: b ? 1 : 0 };
  }
  if (/^SELECT id, summary, payload::text AS payload FROM proactive_candidates/.test(sql)) {
    const rows = (cands[a[0]] ?? []).filter((c) => c.status === "pending" && c.type === "event_offer").map((c) => ({ id: c.id, summary: c.summary, payload: JSON.stringify(c.payload) }));
    return { rows, rowCount: rows.length };
  }
  if (/^UPDATE proactive_candidates SET status = 'skipped'/.test(sql)) {
    const c = (cands[a[1]] ?? []).find((x) => String(x.id) === String(a[0]) && x.status === "pending");
    if (c) { c.status = "skipped"; c.skip_reason = a[2]; }
    return { rows: [], rowCount: c ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });
const db = { query: handle };

// The geocoders: the open geocoder's real answers for these names (lat/lng, population).
const om = (name: string, admin1: string, lat: number, lng: number, population: number): C => ({ name, admin1, country: "US", lat, lng, population, source: "geonames" });
const PLACES: Record<string, C> = {
  "san francisco": om("San Francisco", "California", 37.77493, -122.41942, 864816),
  sacramento: om("Sacramento", "California", 38.58157, -121.4944, 490712),
  davis: om("Davis", "California", 38.54491, -121.74052, 65622),
  oakland: om("Oakland", "California", 37.80437, -122.2708, 419267),
};
const resolve: import("../../src/services/placeResolve.js").ResolveDeps = {
  home: async (city) => { const c = PLACES[R.normName(R.parseQualified(city).name)]; return c ? { lat: c.lat, lng: c.lng } : null; },
  homeCountry: async () => "US",
  lookup: async (place) => { const c = PLACES[R.normName(R.parseQualified(place).name)]; return { google: [], local: c ? [c] : [] }; },
  row: async () => null,
  store: async () => {},
  log: async () => {},
  today: async () => "2026-11-02",
};
const areaDeps: import("../../src/services/searchArea.js").SetAreaDeps = { db, tx: async (fn) => fn(db), home: async (u) => homes[u] ?? null, resolve };
// The real setSearchArea and clear, on the in-memory world; the topic drop on canned reads (below).
const topicCalls: { userId: string; topic: string }[] = [];
P.setRuleEffectsForTests({
  setArea: (userId, input) => A.setSearchArea(userId, input, areaDeps),
  clearArea: (userId, place, because) => A.clearSearchArea(userId, { because, onlyPlace: place }, areaDeps),
  dropTopic: async (userId, topic) => void topicCalls.push({ userId, topic }),
});

const NY = "America/Los_Angeles";
const now = new Date();
const read = (o: any) => [o];
const learn = (user: string, o: any, message: string, via: "text" | "call" = "text") => P.learnPreferences(user, read(o), { message, zone: NY, now: new Date(), source: { via, ref: "h1" } });
const active = (user: string) => P.activePreferences(user, new Date());

// Where a search runs, the way the sweep and look-outs place it (eventSurfacingSweep.ts placeToSearch), and which events survive the
// recommendation engine's radius filter there (tieredRecommendation.ts filterByRadius; real distances).
const placeDeps = (ownPlaces: Record<string, string> = {}): import("../../src/services/wantPlace.js").PlaceDeps => ({
  since: async () => null,
  row: async (_u, key) => (ownPlaces[key] ? { key, place: ownPlaces[key], source: "their_words", quote: ownPlaces[key], notedAt: null } : { key, place: null, source: "none", quote: null, notedAt: null }),
  told: async () => [],
  model: async () => "{}",
  save: async () => {},
  log: (async () => {}) as any,
  area: (u) => A.searchAreaOf(u, db),
});
const where = (user: string, want: { key: string; text: string } | null = null, own: Record<string, string> = {}) =>
  E.placeToSearch({ askId: want ? "a1" : E.PROFILE_ASK_ID, userId: user, askText: want?.text ?? "founder dinners", city: homes[user], want: want ? { ...want, createdAt: null } : null } as any, { place: placeDeps(own), resolve });
const EVENTS = [
  { name: "SF Founders Dinner", city: "San Francisco" },
  { name: "Oakland Builders Night", city: "Oakland" },
  { name: "Sacramento Startup Mixer", city: "Sacramento" },
  { name: "Davis Demo Night", city: "Davis" },
  { name: "Online AMA", city: null, online: true },
];
const near = async (a: string, b: string) => {
  const p = PLACES[R.normName(R.parseQualified(a).name)];
  const q = PLACES[R.normName(R.parseQualified(b).name)];
  return !p || !q ? true : haversineMiles(p, q) <= 50;
};
const results = async (city: string | null) => (await TR.filterByRadius(EVENTS, city, near)).map((e) => e.name);

// ---------------------------------------------------------------- 1. "Only suggest events in SF, even though I live elsewhere"
const GOAL = { key: "goal:oak1", text: "find a climbing partner in Oakland" };
const OWN = { "goal:oak1": "Oakland" };
backlogs[MEMBER_A] = [{ ask_id: "a1", items: [
  { match: { name: "Sacramento Startup Mixer", searchedIn: { key: null, place: "Sacramento", source: "home" } } },
  { match: { name: "Oakland Climbing Social", searchedIn: { key: "goal:oak1", place: "Oakland", source: "their_words" } } },
] }];
cands[MEMBER_A] = [{ id: 1, type: "event_offer", summary: "Sacramento Startup Mixer", payload: { match: { name: "Sacramento Startup Mixer", searchedIn: { key: null, place: "Sacramento", source: "home" } } }, status: "pending" }];
{
  const before = await where(MEMBER_A);
  const beforeResults = await results(before.city);
  check("before: a search with no place of its own runs at home (Sacramento) and keeps Sacramento's events", before.city === "Sacramento" && beforeResults.includes("Sacramento Startup Mixer") && !beforeResults.includes("SF Founders Dinner"), { before, beforeResults });

  const msg = "Only suggest events in SF, even though I live elsewhere";
  const r = await learn(MEMBER_A, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "SF" }, quote: "Only suggest events in SF" }, msg);
  check("the rule is stored in their words", r.added.length === 1 && (await active(MEMBER_A))[0].rule.place === "SF");
  check("... and set as their search area through setSearchArea (resolved against their Sacramento home)", areas[MEMBER_A]?.place === "SF" && areas[MEMBER_A]?.label === "San Francisco, California", areas[MEMBER_A]);

  const after = await where(MEMBER_A);
  const afterResults = await results(after.city);
  check("after: the same search runs in San Francisco", after.city === "San Francisco, California" && after.searchedIn.source === "area", after);
  check("... and the results change: SF's (and Oakland's, within the metro) come back, Sacramento's and Davis's don't", afterResults.includes("SF Founders Dinner") && afterResults.includes("Oakland Builders Night") && !afterResults.includes("Sacramento Startup Mixer") && !afterResults.includes("Davis Demo Night"), afterResults);
  check("... an online event is reachable either way", beforeResults.includes("Online AMA") && afterResults.includes("Online AMA"));
  const goal = await where(MEMBER_A, GOAL, OWN);
  check("a goal that names its own place keeps it (Oakland), rule or not", goal.city === "Oakland, California" && goal.searchedIn.source === "their_words", goal);
  check("their home city is untouched (nothing written to their profile)", homes[MEMBER_A] === "Sacramento" && profileWrites.length === 0);
  const items = backlogs[MEMBER_A][0].items.map((i) => i.match.name);
  check("results that no longer fit go: the find searched at home leaves the backlog; the Oakland goal's find stays", !items.includes("Sacramento Startup Mixer") && items.includes("Oakland Climbing Social"), items);
  check("... and its queued offer is cancelled as a corrected place", cands[MEMBER_A][0].status === "skipped" && /place corrected/.test(cands[MEMBER_A][0].skip_reason ?? ""), cands[MEMBER_A][0]);

  // Honest: applied in what-Cue-knows and in the reply's facts, only because the area really is SF.
  const ctx = await A.areaCtxOf(MEMBER_A, db);
  const p = (await active(MEMBER_A))[0];
  check("what-Cue-knows shows it applied (no 'noted, not applied yet')", P.describePreference(p, { applied: P.ruleApplied(p, ctx) }) === "look for things in SF");
  const rf = P.replyPreferenceFacts(await active(MEMBER_A), new Date(), ctx);
  check("the reply's facts say it's applied and what that means", rf.known.some((k) => /Applied: their search area is set/.test(k) && /home city didn't change/.test(k)));
  check("... and it's this turn's change, so 'searching SF from now on' stands on it", rf.appliedNow.length === 1 && /p\.area === "search_area" \? "setSearchArea"/.test(src("harness/replyGrounding.ts")));
  const reply = G.baseReplyFacts();
  reply.changedBy = ["setSearchArea"];
  check("a reply saying the change passes the change check on that record", !G.codeChecks("Got it, only SF from here on out.", reply, { message: msg, recentConversation: "" }).some((c) => c.name === "no_unbacked_change"));
  // The same rule held against an area that isn't its place (changed since, or never set) is never said to be applied.
  check("held against a different area, it's noted, not applied", P.describePreference(p, { applied: P.ruleApplied(p, { area: { place: "Oakland" }, home: "Sacramento" }) }).endsWith("(noted, not applied yet)"));
  check("with no area read at all, it's never said to be applied", !P.ruleApplied(p, {}));
}

// ---------------------------------------------------------------- 2. a correction repairs the active search: "SF, not Sacramento"
backlogs[MEMBER_C] = [{ ask_id: "c1", items: [
  { match: { name: "Sacramento Food Fest", searchedIn: { key: null, place: "Sacramento", source: "area" } } },
  { match: { name: "Davis Farmers Market", searchedIn: { key: "goal:d1", place: "Davis", source: "their_words" } } },
] }];
cands[MEMBER_C] = [{ id: 7, type: "event_offer", summary: "Sacramento Food Fest", payload: { match: { name: "Sacramento Food Fest", searchedIn: { key: null, place: "Sacramento", source: "area" } } }, status: "pending" }];
{
  await learn(MEMBER_C, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "Sacramento" }, quote: "only look for events in Sacramento" }, "only look for events in Sacramento");
  // The Sacramento finds above stand for what that area found before the correction.
  const mid = await where(MEMBER_C);
  check("set first to Sacramento (a Davis member's area)", areas[MEMBER_C]?.place === "Sacramento" && mid.city === "Sacramento, California", mid);
  const r = await learn(MEMBER_C, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "SF" }, replaces: [0], quote: "SF, not Sacramento" }, "sorry, I meant SF, not Sacramento");
  const live = await active(MEMBER_C);
  check("the correction replaces the rule (one active rule, SF; the Sacramento one superseded, not deleted)", r.retired.length === 1 && live.length === 1 && live[0].rule.place === "SF" && facts.some((f) => f.owner_user_id === MEMBER_C && f.meta.state === "superseded"));
  const after = await where(MEMBER_C);
  check("the active search moves: it now runs in San Francisco", areas[MEMBER_C]?.place === "SF" && after.city === "San Francisco, California", after);
  check("what was found for Sacramento goes; a goal with its own place keeps its finds", backlogs[MEMBER_C][0].items.map((i) => i.match.name).join() === "Davis Farmers Market", backlogs[MEMBER_C][0].items);
  check("... and Sacramento's queued offer is cancelled", cands[MEMBER_C][0].status === "skipped");
  check("their home (Davis) never changed", homes[MEMBER_C] === "Davis" && profileWrites.length === 0);
  // Withdrawn in conversation: the area goes back to home.
  await learn(MEMBER_C, { type: "withdraw", area: "search_area", replaces: [0], quote: "forget the SF thing" }, "forget the SF thing, search near me again");
  check("withdrawing the rule takes their searches back home", !areas[MEMBER_C] && (await where(MEMBER_C)).city === "Davis");
}

// ---------------------------------------------------------------- 3. removing it in what-Cue-knows does the same; correcting the area there retires it
{
  await learn(MEMBER_C, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "SF" }, quote: "search SF from now on" }, "search SF from now on");
  check("set again", areas[MEMBER_C]?.place === "SF");
  const p = (await active(MEMBER_C))[0];
  const item = W.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], prefs: [{ id: p.id, text: P.describePreference(p, { applied: true }), quote: p.words[0] }] }).find((i) => i.source === "pref")!;
  const out = await W.applyOne(db as any, MEMBER_C, { prefs: [] } as any, item, "remove", null, "remove the SF rule");
  check("removing the rule there withdraws it and sets their area back to home", "source" in out && !areas[MEMBER_C] && !(await active(MEMBER_C)).length, out);
  await learn(MEMBER_C, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "SF" }, quote: "search SF from now on" }, "search SF from now on");
  check("a removal of the area itself in what-Cue-knows retires the rule with it (no stale 'noted' rule left)", (await P.retireAreaRules(db as any, MEMBER_C)) === 1 && !(await active(MEMBER_C)).length && /retireAreaRules\(db as any, userId\)/.test(src("services/whatCoKnows.ts")));
}

// ---------------------------------------------------------------- 4. honest when it can't apply: scoped, inferred, one-time, unsettled
{
  const D = "00000000-0000-4000-8000-0000000000d4";
  homes[D] = "Sacramento";
  await learn(D, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "Oakland", topic: "climbing gyms" }, quote: "climbing gyms in Oakland only" }, "climbing gyms in Oakland only");
  check("a where-to-search rule for one subject doesn't move every search", !areas[D]);
  const facts1 = P.replyPreferenceFacts(await active(D), new Date(), await A.areaCtxOf(D, db));
  check("... it's noted, not applied, and Cue offers what it can do instead (that ask's own place, or everything)", facts1.known.some((k) => /not applied yet/.test(k) && /Never say it's applied/.test(k) && /put that place on the one ask or goal/.test(k)), facts1.known);
  await learn(D, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "Springfield" }, quote: "search Springfield from now on" }, "search Springfield from now on");
  const facts2 = P.replyPreferenceFacts(await active(D), new Date(), await A.areaCtxOf(D, db));
  check("a place that couldn't be settled changes nothing and is never said to be applied", !areas[D] && facts2.known.some((k) => /look for things in Springfield \(noted, not applied yet\)/.test(k) && /Never say it changed/.test(k)), facts2.known);
  const inferred = { id: "x", area: "search_area", covers: "unsolicited", channel: "all", rule: { place: "SF" }, basis: "inferred", type: "standing", words: ["I'm always in SF anyway"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: NY, state: "active", setAt: new Date(0).toISOString() } as any;
  check("an inferred where-to-search read is never applied (no setSearchArea), and Cue asks", !P.areaRuleAppliable(inferred) && P.replyPreferenceFacts([inferred], new Date(), { area: { place: "SF" } }).known.some((k) => /tentative read, not applied/.test(k)));
  const other = { ...inferred, area: "other", basis: "explicit", rule: { topic: "use emoji with me" } };
  const oFacts = P.replyPreferenceFacts([other], new Date(), {});
  check("an unsupported rule ('other') is never acknowledged as applied, and Cue offers what it can do", P.describePreference(other).endsWith("(noted, not applied yet)") && oFacts.known.some((k) => /never say it's applied/.test(k) && /offer the closest thing Cue can do/.test(k)) && !oFacts.appliedNow.length && !oFacts.instructions.some((i) => /emoji/.test(i)));
  const oneTime = { ...inferred, basis: "explicit", type: "one_time" };
  check("a one-time where-to-search request isn't a standing move", !P.areaRuleAppliable(oneTime) && P.replyPreferenceFacts([oneTime], new Date(), { area: null, home: "Sacramento" }).known.some((k) => /never say their searches moved/.test(k)));
  check("a rule naming their home city is applied while no area is set (searches are at home)", P.ruleApplied({ ...inferred, basis: "explicit", rule: { place: "Sacramento" } }, { area: null, home: "Sacramento" }));
  check("send rules keep their meaning, and a send limit never rides on a where-to-search, reply or topic rule", P.ruleForArea("avoid_topic", { topic: "crypto", none: true, maxPerDay: 1 }).none === undefined && P.ruleForArea("contact", { maxPerDay: 1 }).maxPerDay === 1 && !P.ENFORCED_AREAS.has("avoid_topic") && !P.ENFORCED_AREAS.has("search_area"));
}

// ---------------------------------------------------------------- 5. "Keep work replies short, but explain technical things fully"
const S = "00000000-0000-4000-8000-0000000000e5";
{
  const msg = "Keep work replies short, but explain technical things fully";
  const r = await P.learnPreferences(S, [
    { type: "standing", area: "reply_style", covers: "unsolicited", channel: "all", basis: "explicit", rule: { style: "short", topic: "work" }, quote: "Keep work replies short" },
    { type: "standing", area: "reply_style", covers: "unsolicited", channel: "all", basis: "explicit", rule: { style: "explain fully", topic: "technical things" }, quote: "explain technical things fully" },
  ], { message: msg, zone: NY, now: new Date(), source: { via: "text", ref: "h2" } });
  check("two scoped style rules from one message, both kept", r.added.length === 2 && (await active(S)).length === 2);
  await learn(S, { type: "standing", area: "reply_style", covers: "unsolicited", channel: "all", basis: "explicit", rule: { style: "a few sentences", topic: "work" }, quote: "work replies can be a few sentences" }, "actually work replies can be a few sentences");
  const live = await active(S);
  check("a correction to one subject's rule replaces only that one (the technical rule stands)", live.length === 2 && live.some((p) => p.rule.topic === "technical things" && p.rule.style === "explain fully") && live.some((p) => p.rule.topic === "work" && p.rule.style === "a few sentences"), live.map((p) => p.rule));
  const text = P.replyPreferenceFacts(live, new Date(), {});
  const workLine = text.instructions.find((i) => /subject is work: a few sentences/.test(i));
  const techLine = text.instructions.find((i) => /subject is technical things: explain fully/.test(i));
  check("the text reply gets each as a standing instruction, scoped to its subject", !!workLine && !!techLine && /applies only to that subject/.test(workLine!), text.instructions);
  check("... and both are shown applied in what-Cue-knows (in force in every reply path)", live.every((p) => !P.describePreference(p, { applied: P.ruleApplied(p) }).includes("not applied")));
  // The call: the member record's limits carry the same rules into callFitLines, and GPT-Live's thinking prompt is filled from it.
  const lines = CC.callFitLines({ preferences: [], claims: [], identity: { zone: NY } as any, limits: { avoid: [], availability: null, rules: live, verifiedAt: new Date().toISOString() } } as any);
  const callBlock = lines.find((l) => /The rules they set/.test(l)) ?? "";
  check("the call gets the same scoped instructions", callBlock.includes(workLine!) && callBlock.includes(techLine!));
  const GL = await import("../../src/services/gptLive.js");
  const voiceLayer = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
  const call = GL.buildLiveCall({ userId: S, callSid: null, firstName: "Sam", direction: "inbound", team: false, voiceLayer, contextSummary: lines.join("\n\n"), rightNow: "", findsNow: "", callReason: "", timeOfDay: null });
  check("GPT-Live's thinking prompt carries them", call.backendSystem.includes(workLine!) && call.backendSystem.includes(techLine!));
  check("the text reply reads them with the area context, and the reply check is given them", /const pf = P\.replyPreferenceFacts\(prefs, new Date\(\), area\);[\s\S]{0,400}rf\.prefRules = /.test(src("harness/replyGrounding.ts")));
  // The reply check: one read (canned here), checked in code; a clear break is flagged, never cut.
  const rules = text.rules;
  const longWork = "Here is the whole plan for the board meeting, every step. First the deck. Then the numbers. Then the asks. Then the follow-ups. Then the hiring plan.";
  const flagged = T.readReplyRulesAnswer(JSON.stringify({ style: [rules.style.findIndex((x) => x.topic === "work") + 1, 9], raises: [] }), longWork, rules);
  check("the reply check flags a reply that clearly breaks a scoped style rule (a rule number not listed is ignored)", flagged.length === 1 && flagged[0].name === T.PREF_STYLE && /about work/.test(flagged[0].reason ?? ""), flagged);
  check("a style flag never cuts the reply (style can't be guaranteed in code; it's logged)", /c\.name !== "pref_style"/.test(src("harness/replyGrounding.ts")) && G.stripUnsupported(longWork, []) === longWork);
  check("an unreadable answer flags nothing", T.readReplyRulesAnswer("not json", longWork, rules).length === 0);
  const prompt = T.replyRulesPrompt(longWork, rules, "can you send the board plan?");
  check("the read is told a subject's rule applies only on that subject", /A rule for one subject applies only when the reply is about that subject/.test(prompt) && /When the subject is work/.test(prompt));
  const inferredStyle = { ...live[0], basis: "inferred" } as any;
  check("an inferred style read stays tentative: not applied, no instruction", !P.ruleApplied(inferredStyle) && !P.replyPreferenceFacts([inferredStyle], new Date(), {}).instructions.some((i) => /How they asked you to reply/.test(i)));
}

// ---------------------------------------------------------------- 6. "Don't bring up crypto"
const X = "00000000-0000-4000-8000-0000000000f6";
{
  await learn(X, { type: "standing", area: "avoid_topic", covers: "unsolicited", channel: "all", basis: "explicit", rule: { topic: "crypto" }, quote: "please don't bring up crypto" }, "please don't bring up crypto anymore");
  check("the rule is stored, and setting it drops what's waiting about it (dropTopicWork, for this member only)", (await active(X)).length === 1 && topicCalls.length === 1 && topicCalls[0].userId === X && topicCalls[0].topic === "crypto");
  // The model read, canned: a thing is "about crypto" when its own words say so. It stands in for Haiku; code only checks the answer.
  const canned = (items: { name: string; details: string }[], topics: string[]) => items.map((it) => (/crypto|bitcoin|web3/i.test(`${it.name} ${it.details}`) && topics.includes("crypto") ? "crypto" : null));
  const asModel: import("../../src/services/memberLimits.js").JudgeDeps = { model: async (prompt) => {
    const items = [...prompt.matchAll(/^(\d+)\. (.*)\n(.*)$/gm)].map((m) => ({ name: m[2], details: m[3] }));
    const subjects = [...(prompt.match(/not to bring up these subjects: (.*)\./)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return JSON.stringify(canned(items, subjects).map((kind, i) => ({ n: i + 1, kind })));
  } };
  // Finds: the keep gate (sweeps and reply searches alike).
  const finds = [{ name: "Bitcoin Builders Happy Hour", details: { description: "web3 founders" } }, { name: "Climbing Social", details: { description: "bouldering night" } }];
  const kept = await L.limitsGate(finds, { avoid: [], availability: null, rules: await active(X) }, { askText: "anything fun this week", topicDeps: asModel });
  check("a find about the subject is dropped at the keep; the rest stay", kept.kept.map((k) => k.name).join() === "Climbing Social" && /not to bring up crypto/.test(kept.out[0]?.why ?? ""), kept);
  const failedRead = await L.limitsGate(finds, { avoid: [], availability: null, rules: await active(X) }, { askText: "anything fun", topicDeps: { model: async () => "sorry" } });
  check("a read that fails keeps nothing (never shown unread), and never falls back to word matching", failedRead.kept.length === 0 && failedRead.out.length === 2 && !/avoidHits|kindWords|new RegExp/.test(src("services/prefTopics.ts")));
  check("the sweep's keep and the reply search's keep both carry their rules", /rules: k\.limits\.rules/.test(src("services/sweepFind.ts")) && /lim\.rules\?\.some\(\(r\) => r\.area === "avoid_topic"\)/.test(src("agent/loopTools.ts")));
  const theirAsk = T.topicPrompt([{ name: "Crypto Night", details: "" }], ["crypto"], "any crypto meetups this week?");
  check("when their own ask is about it, the read is told they raised it", /A subject their own request is about is theirs to raise/.test(theirAsk));
  // Proactive candidates: Cue's own are held at enqueue; what they asked for never is.
  const deps: import("../../src/services/prefTopics.js").TopicDeps = { prefs: (u) => P.activePreferences(u), judge: async (items, topics) => canned(items, topics) };
  check("a new offer about the subject is never queued", (await T.candidateTopicHold({ userId: X, type: "event_offer", summary: "Bitcoin Builders Happy Hour", payload: { match: { name: "Bitcoin Builders Happy Hour" } } }, deps)) === "they asked Cue not to bring up crypto");
  check("a check-in about it isn't either", !!(await T.candidateTopicHold({ userId: X, type: "ask_checkin", summary: "how the crypto fund raise is going", payload: {} }, deps)));
  check("something else queues as usual", (await T.candidateTopicHold({ userId: X, type: "event_offer", summary: "Climbing Social", payload: {} }, deps)) === null);
  check("a requested delivery is never held (they asked for it)", (await T.candidateTopicHold({ userId: X, type: "pre_arrival", summary: "your crypto night starts at 7", payload: {} }, deps)) === null);
  check("a read that fails holds Cue's own offer (never queued unread)", /couldn't be checked/.test((await T.candidateTopicHold({ userId: X, type: "event_offer", summary: "Climbing Social", payload: {} }, { ...deps, judge: async () => null })) ?? ""));
  let judged = 0;
  check("a member with no such rule costs no read", (await T.candidateTopicHold({ userId: MEMBER_B, type: "event_offer", summary: "Bitcoin Builders Happy Hour", payload: {} }, { ...deps, judge: async (i, t) => (judged++, canned(i, t)) })) === null && judged === 0);
  check("enqueueCandidate asks before a new candidate is queued", /T\.candidateTopicHold\(input, T\.realTopicDeps, isNew\)/.test(src("harness/proactive.ts")));
  // What's already waiting when the rule is set.
  const waiting = [
    { id: "1", type: "event_offer", summary: "Bitcoin Builders Happy Hour", payload: { match: { name: "Bitcoin Builders Happy Hour" } } },
    { id: "2", type: "companion", summary: "checking in on the running plan", payload: {} },
    { id: "3", type: "event_brief", summary: "brief for the crypto night you're going to", payload: {} },
  ];
  const skipped: string[] = [];
  const removed: string[] = [];
  const res = await T.dropTopicWork(X, "crypto", {
    judge: async (items, topics) => canned(items, topics),
    pending: async (u) => (u === X ? waiting : []),
    skipPending: async (_u, id) => (skipped.push(id), true),
    backlogs: async () => [{ ask_id: "x1", items: [{ match: { name: "Web3 Demo Day", details: { description: "crypto demos" } } }, { match: { name: "Climbing Social" } }] }],
    removeFromBacklog: async (_u, _a, names) => (removed.push(...names), names.size),
  });
  check("setting the rule drops what's waiting about it: Cue's own offer skipped, the backlog find removed", res.skipped === 1 && skipped.join() === "1" && removed.join() === "Web3 Demo Day", { res, skipped, removed });
  check("... never a requested brief, never anything else", !skipped.includes("2") && !skipped.includes("3") && !removed.includes("Climbing Social"));
  // Replies: told not to raise it, and the check cuts a sentence that does.
  const rf = P.replyPreferenceFacts(await active(X), new Date(), {});
  check("the reply (and call) is told not to raise it unless they do", rf.instructions.some((i) => /not to bring up crypto/.test(i) && /If they bring it up themselves, follow their lead/.test(i)) && rf.rules.avoid.join() === "crypto");
  const draft = "Saw a wild bitcoin rally today. Anyway, Climbing Social is Thursday at 7.";
  const cut = T.readReplyRulesAnswer(JSON.stringify({ style: [], raises: [{ topic: "crypto", sentence: "Saw a wild bitcoin rally today." }, { topic: "crypto", sentence: "a sentence that isn't in the reply" }, { topic: "politics", sentence: "Anyway, Climbing Social is Thursday at 7." }] }), draft, rf.rules);
  check("the reply check flags only a real sentence of the reply, on a subject on their list", cut.length === 1 && cut[0].name === T.PREF_TOPIC, cut);
  check("... and that sentence is cut, the rest goes", G.stripUnsupported(draft, cut).trim() === "Anyway, Climbing Social is Thursday at 7.", G.stripUnsupported(draft, cut));
  check("the read is told their own message bringing it up makes it theirs", /when their message didn't bring it up/.test(T.replyRulesPrompt(draft, rf.rules, "how's crypto looking?")));
}

// ---------------------------------------------------------------- 7. cross-member isolation
{
  check("another member's searches stay where they were (B is at home, A's rule never touches B)", !areas[MEMBER_B] && (await where(MEMBER_B)).city === "Sacramento");
  check("B has none of A's, C's or X's rules", !(await active(MEMBER_B)).length);
  const aRule = (await active(MEMBER_A))[0];
  check("a withdrawal under another member's id changes nothing, and A's area stays", !(await P.withdrawPreference(db as any, MEMBER_B, aRule.id)) && areas[MEMBER_A]?.place === "SF");
  check("B's queue is never held by A's or X's subjects", (await T.candidateTopicHold({ userId: MEMBER_B, type: "event_offer", summary: "Bitcoin Builders Happy Hour", payload: {} })) === null);
  check("every read of rules and areas is one member's (owner_user_id / user_id = $1)", /WHERE owner_user_id = \$1 AND relation = '\$\{PREF_RELATION\}'/.test(src("services/memberPreferences.ts")) && /FROM want_places WHERE user_id = \$1 AND want_key = \$2/.test(src("services/searchArea.ts")) && /FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/.test(src("services/prefTopics.ts")) && /WHERE id = \$1 AND user_id = \$2 AND status = 'pending'/.test(src("services/prefTopics.ts")));
}

// ---------------------------------------------------------------- 8. calls: the same rule, said on a call, changes the same decision
{
  const V = "00000000-0000-4000-8000-0000000000a7";
  homes[V] = "Sacramento";
  await learn(V, { type: "standing", area: "search_area", covers: "unsolicited", channel: "all", basis: "explicit", rule: { place: "SF" }, quote: "only events in SF from now on" }, "user: only events in SF from now on please", "call");
  check("said on a call (the call's learning read, right after it), it sets their area the same way", areas[V]?.place === "SF" && (await active(V))[0].source.via === "call");
  check("the call's learning stores rules through learnPreferences (which applies them)", /learnPreferences\(input\.userId, learned\.preferences/.test(src("services/callLearning.ts")) && /await applyRuleEffects\(userId, changes, stored/.test(src("services/memberPreferences.ts")));
  check("setSearchArea is on the call's allow-list (both mediums)", CAP.callToolNames().includes("setSearchArea") && CAP.callRunFor("setSearchArea")?.run === "now");
}

P.setRuleEffectsForTests(null);
console.log(`preferences decisions: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
