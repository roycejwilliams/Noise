// The reply's search looks where the ask is, not where the profile says they live (Royce, 2026-10-18: "The situation decides what Cue
// looks for and which helpers run. What we know about a member shapes how, never which helper."). The plan's example: Remy's profile
// city is Sacramento, she texts "any founder runs in SF Saturday?", and the reply search was told "they're in Sacramento" and searched
// "in or near Sacramento" (agent/loopTools.ts webSearch, searchEvents; services/askPlace.ts has the rule). The sweep was fixed by #219.
// Zero tokens: Exa, the model, Luma, geocoding and the database are stubbed; nothing leaves the machine.
//   npx tsx evals/search/askPlace.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.GOOGLE_PLACES_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync } from "fs";

const { default: pool } = await import("../../src/db/db.js");
const A = await import("../../src/services/askPlace.js");
const { samePlace } = await import("../../src/services/wantPlace.js");
const LT = await import("../../src/agent/loopTools.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};

// ================================================================ 1. the rule (pure)
const SF = "San Francisco";
const web = (words: string, o: { toolCity?: string | null; message?: string | null; home?: string | null } = {}) => A.replySearchPlace({ kind: "web", words, home: SF, ...o });
const events = (words: string, o: { toolCity?: string | null; message?: string | null; home?: string | null } = {}) => A.replySearchPlace({ kind: "events", words, home: SF, ...o });

// The ask names Lisbon, the profile says SF: the search uses Lisbon.
{
  const p = web("founder dinners in Lisbon");
  check("web: the query names Lisbon, profile SF: the place is Lisbon, from the ask's words", p.place === "Lisbon" && p.from === "words", p);
  check("... and nothing is added on top (no 'in or near San Francisco')", A.webSearchCity(p) === null);
}
{
  const p = web("Lisbon founder dinners", { message: "any founder dinners in Lisbon next week?" });
  check("web: their message names Lisbon and the query repeats it without 'in': Lisbon, from the words", p.place === "Lisbon" && p.from === "words" && A.webSearchCity(p) === null, p);
}
{
  const p = web("founder dinners", { toolCity: "Lisbon" });
  check("web: the query names no place, the tool call carries Lisbon (theirs.city): Lisbon", p.place === "Lisbon" && p.from === "tool" && A.webSearchCity(p) === "Lisbon", p);
}
{
  const p = events("founder runs in Lisbon");
  check("events: 'what' names Lisbon, no city passed, profile SF: the feed is Lisbon's (the bug: it was SF)", p.place === "Lisbon" && p.from === "words", p);
}
check("events: the city passed is Lisbon: Lisbon", events("founder runs", { toolCity: "Lisbon" }).place === "Lisbon");
check("events: the model passed their home city but 'what' names Lisbon: Lisbon (the ask's words win)", events("founder runs in Lisbon", { toolCity: SF }).place === "Lisbon");
{
  // Remy: the model writes "founder runs SF" (no "in"): SF is a city short name, so it's the ask's place on its own.
  const p = events("founder runs SF", { message: "any founder runs in SF Saturday?", home: "Sacramento" });
  check("events: Remy (profile Sacramento) asks for SF: SF, never Sacramento", p.place === "SF" && p.from === "words", p);
  const w = web("founder runs SF Saturday", { message: "any founder runs in SF Saturday?", home: "Sacramento" });
  check("web: the same ask: nothing added on top (no 'they're in Sacramento')", A.webSearchCity(w) === null && w.place === "SF", w);
}
check("a place phrase ends at the day: 'in Lisbon Saturday' is Lisbon", A.placesNamed("any founder runs in Lisbon Saturday?").join() === "Lisbon", A.placesNamed("any founder runs in Lisbon Saturday?"));
check("multi-word places and short names: 'in New York', NYC, LA, Oakland", A.placesNamed("dinners in New York").includes("New York") && A.placesNamed("NYC founder dinners").includes("NYC") && A.placesNamed("LA runs").includes("LA") && A.placesNamed("venues near Oakland").includes("Oakland"));
check("a short name only counts in capitals ('la' and 'chi' in a sentence are no place)", !A.placesNamed("ooh la la tai chi classes").length, A.placesNamed("ooh la la tai chi classes"));
check("'founders in AI', 'talks in Spanish', 'in October' are not places", !A.placesNamed("founders in AI").length && !A.placesNamed("talks in Spanish").length && !A.placesNamed("demo days in October").length);

// The ask names no place: the documented fallback.
{
  const p = web("founder dinners", { message: "any good founder dinners this week?" });
  check("web: no place anywhere: their home city stands in (as the sweep does for a want with no place)", p.place === SF && p.from === "home" && A.webSearchCity(p) === SF, p);
  check("web: 'near me' names no place: their home city", web("dinner spots near me").place === SF && web("coworking around here").place === SF);
  check("events: no place: their home city (an event feed is by city)", events("founder runs").place === SF && events("founder runs").from === "home");
  const o = web("online design workshops");
  check("web: a search for no place (online, remote, anywhere) gets no city", o.place === null && o.from === "none" && web("remote product design jobs").place === null && web("grants open to anyone anywhere").place === null, o);
  check("events: 'online' still looks in their city's feed (the feed is by city; online events are in it)", events("online workshops").place === SF);
  check("no home city and no place: none", web("founder dinners", { home: null }).from === "none" && events("founder runs", { home: null }).place === null);
  const m = web("dinner spots", { message: "I was in Lisbon last week. Any dinner spots?" });
  check("their message names a place the query doesn't use ('I was in Lisbon last week'): not the search's place, so home", m.place === SF && m.from === "home", m);
}

// The pin: the profile city alone never decides where to look when the ask names a place.
{
  const asks: [string, string][] = [
    ["founder dinners in Lisbon", "Lisbon"], ["climate meetups near Oakland", "Oakland"], ["NYC demo days", "NYC"], ["jazz bars in New Orleans", "New Orleans"],
    ["SF founder runs", "SF"], ["venues in Los Angeles", "Los Angeles"], ["hackathons in Austin this weekend", "Austin"], ["supper clubs in Mexico City", "Mexico City"],
  ];
  const homes = [SF, "Sacramento", "Lisbon", "New York", "Chicago", null];
  const bad: unknown[] = [];
  for (const [q, named] of asks)
    for (const home of homes)
      for (const kind of ["web", "events"] as const)
        for (const toolCity of [null, home]) {
          const p = A.replySearchPlace({ kind, words: q, toolCity, home, message: null });
          const sent = kind === "web" ? A.webSearchCity(p) : p.place;
          // Allowed: the ask's own place, or nothing added on top. Never the home city, unless it is the named place.
          const ok = p.from === "words" && samePlace(p.place, named) && (kind === "web" ? sent === null : samePlace(sent, named));
          if (!ok) bad.push({ q, home, kind, toolCity, p, sent });
        }
  check("pin: across 8 asks naming a place x 6 home cities x both searches x city passed or not: the ask's place every time, the home city never", bad.length === 0, bad.slice(0, 3));
}

// Review of #252: a topic after "in" is not a place, and on the event search it never overrides the city the model passed. The
// words win over the model's city only when that city is just their home city (the case this PR fixes).
{
  const rows: [string, string][] = [
    ["women in Venture", "Austin"], ["meetups in Robotics", "Austin"], ["panels in Healthcare", "Boston"], ["workshops in Python", "Seattle"],
    ["talks in Real Estate", "Miami"], ["speed dating for people in Love", "Chicago"], ["jazz in Williamsburg", "New York"], ["jazz near Union Square", "New York"],
  ];
  for (const [what, city] of rows) {
    const p = events(what, { toolCity: city });
    check(`events: "${what}" with the model's city ${city} (profile SF): ${city}`, p.place === city && p.from === "tool", p);
  }
  for (const [what] of rows.slice(0, 6)) {
    check(`"${what}": the topic is not a place (no city passed: their home city; web: the home city is added)`, events(what).place === SF && events(what).from === "home" && A.webSearchCity(web(what)) === SF, { e: events(what), w: web(what) });
  }
  check("events: the model fell back to their home city while 'what' names Lisbon: Lisbon (the fix)", events("founder runs in Lisbon", { toolCity: SF }).place === "Lisbon" && events("founder runs in Lisbon", { toolCity: "SF" }).place === "Lisbon");
  check("events: the model's city that isn't their home wins over a place in the words", events("founder runs in Lisbon", { toolCity: "Porto" }).place === "Porto");
  // What the comments say isn't seen, isn't: no "in/near/around" ("visiting Lisbon"), or lowercase ("in lisbon"): the home city.
  check("not seen as a place: 'visiting Lisbon' and 'in lisbon' (lowercase): the home city stands in", web("founder dinners visiting Lisbon").place === SF && events("founder runs in lisbon").place === SF);
  // Known, not fixed here (web query words read as an alias city): "Washington Post internships" reads Washington, "DC comics
  // events" reads DC, so nothing is added on top of those queries.
}

// ================================================================ 2. the tools themselves (the wiring)
// Exa, the model, Luma and geocoding answer from here; every outside call and every database statement is recorded.
const calls: string[] = [];
const exaQueries: string[] = [];
const prompts: string[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url instanceof URL ? url.href : typeof url === "string" ? url : url?.url);
  calls.push(`${u} ${typeof init?.body === "string" ? init.body : ""}`);
  if (u.startsWith("https://api.exa.ai/")) {
    exaQueries.push(String(JSON.parse(init?.body ?? "{}").query ?? ""));
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (/api\.anthropic\.com/.test(u)) {
    prompts.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: '{"items": []}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const sqlParams: string[] = [];
// The geocoder answers from its cache (a point for any city), so the Google client (node http, which the layer 1 guard can't see) is
// never reached; the city it was asked about is still recorded.
(pool as any).query = async (sql: string, p: any[] = []) => {
  sqlParams.push(JSON.stringify(p));
  if (/SELECT lat, lng FROM geocode_cache/.test(sql)) return { rows: [{ lat: 0, lng: 0 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
(pool as any).connect = async () => ({
  query: async (sql: string, p: any[] = []) => {
    sqlParams.push(JSON.stringify(p));
    if (/COUNT\(\*\)::int AS today/.test(sql)) return { rows: [{ today: 0 }] };
    return { rows: [] };
  },
  release: () => {},
});
const ctxFor = (message: string, city: string | null): any => ({ userId: "u1", phoneNumber: "+15550100001", firstName: "Jordan", resolvedContent: message, turn: { message: "", profile: { city } }, dryRun: true, facts: { add: () => {} }, sendCoReply: async () => true });
const make = (ctx: any): any => LT.loopTools(ctx, { sent: false, sentMessages: [] }, LT.newLoopState(), () => {});
const reset = () => { calls.length = 0; exaQueries.length = 0; prompts.length = 0; sqlParams.length = 0; };

try {
  // ---- the reply's webSearch, through Exa
  process.env.EXA_API_KEY = "test-key";
  reset();
  await make(ctxFor("any founder dinners in Lisbon next week?", SF)).webSearch.execute({ queries: ["founder dinners in Lisbon"] }, { toolCallId: "w1", messages: [] });
  check("webSearch: Lisbon asked, profile SF: Exa is sent the query as written, with no 'in or near San Francisco'", exaQueries.length >= 1 && exaQueries.every((q) => q === "founder dinners in Lisbon"), exaQueries);
  reset();
  await make(ctxFor("any founder dinners in Lisbon next week?", SF)).webSearch.execute({ queries: ["Lisbon founder dinners"] }, { toolCallId: "w2", messages: [] });
  check("webSearch: the query repeats their Lisbon without 'in': still nothing added", exaQueries.length >= 1 && exaQueries.every((q) => q === "Lisbon founder dinners"), exaQueries);
  reset();
  await make(ctxFor("founder dinners next week?", SF)).webSearch.execute({ queries: ["founder dinners"], theirs: { city: "Lisbon" } }, { toolCallId: "w3", messages: [] });
  check("webSearch: the tool call carries Lisbon: 'in or near Lisbon', never SF", exaQueries.length >= 1 && exaQueries.every((q) => q === "founder dinners in or near Lisbon"), exaQueries);
  reset();
  await make(ctxFor("any good founder dinners this week?", SF)).webSearch.execute({ queries: ["founder dinners"] }, { toolCallId: "w4", messages: [] });
  check("webSearch: no place in the ask: their home city stands in ('in or near San Francisco')", exaQueries.length >= 1 && exaQueries.every((q) => q === "founder dinners in or near San Francisco"), exaQueries);
  reset();
  await make(ctxFor("any online design workshops?", SF)).webSearch.execute({ queries: ["online design workshops"] }, { toolCallId: "w5", messages: [] });
  check("webSearch: an online search gets no city", exaQueries.length >= 1 && exaQueries.every((q) => q === "online design workshops"), exaQueries);

  // ---- without Exa: the model's search prompt
  delete process.env.EXA_API_KEY;
  reset();
  await make(ctxFor("any founder dinners in Lisbon next week?", SF)).webSearch.execute({ queries: ["founder dinners in Lisbon"] }, { toolCallId: "w6", messages: [] });
  check("webSearch without Exa: the search prompt never says they're in San Francisco when the ask names Lisbon", prompts.length >= 1 && prompts.every((p) => /founder dinners in Lisbon/.test(p) && !/they're in San Francisco/.test(p)), prompts.map((p) => p.slice(0, 200)));

  // ---- the reply's searchEvents: the feed's place (Luma's places, the geocoder and its cache are all asked about the place it looks in)
  reset();
  await make(ctxFor("any founder runs in Lisbon Saturday?", SF)).searchEvents.execute({ what: "founder runs in Lisbon", when: "Saturday" }, { toolCallId: "e1", messages: [] });
  const seen = [...calls, ...sqlParams].join("\n");
  check("searchEvents: Lisbon asked, no city passed, profile SF: the feed is looked up for Lisbon, never San Francisco", /Lisbon/.test(seen) && !/San Francisco/.test(seen), seen.slice(0, 600));
  reset();
  await make(ctxFor("anything for women in Venture in Austin?", SF)).searchEvents.execute({ what: "women in Venture", city: "Austin" }, { toolCallId: "e3", messages: [] });
  const seen3 = [...calls, ...sqlParams].join("\n");
  check("searchEvents: 'women in Venture' with the model's Austin: the feed is Austin's, never 'Venture' or San Francisco", /Austin/.test(seen3) && !/Venture"/.test(sqlParams.join("\n")) && !/San Francisco/.test(seen3), seen3.slice(0, 600));
  reset();
  await make(ctxFor("any founder runs this weekend?", SF)).searchEvents.execute({ what: "founder runs", when: "this weekend" }, { toolCallId: "e2", messages: [] });
  const seen2 = [...calls, ...sqlParams].join("\n");
  check("searchEvents: no place in the ask: their home city's feed", /San Francisco/.test(seen2), seen2.slice(0, 600));
} finally {
  delete process.env.EXA_API_KEY;
}

// ================================================================ 3. pinned in the source
{
  const lt = src("agent/loopTools.ts");
  const body = (name: string, next: string) => lt.slice(lt.indexOf(`    ${name}: tool({`), lt.indexOf(`    ${next}: tool({`));
  const ev = body("searchEvents", "webSearch");
  const ws = body("webSearch", "searchPosts");
  check("searchEvents looks where replySearchPlace says, and reads the profile city only as its home fallback", /const where = replySearchPlace\(\{ kind: "events", words: what, toolCity: city, message: askWords\(\), home: ctx\.turn\?\.profile\?\.city \?\? null \}\);/.test(ev) && /eventCandidates\(what, where\.place,/.test(ev) && (ev.match(/profile\?\.city/g) ?? []).length === 1);
  check("webSearch hands each search the city replySearchPlace gives it, and reads the profile city only as its home fallback", /taskWebSearch\(ctx\.userId, q, \{ city: cityFor\(q\),/.test(ws) && /webSearchCity\(replySearchPlace\(\{ kind: "web", words: q, toolCity: theirs\?\.city \?\? null, message: askWords\(\), home \}\)\)/.test(ws) && (ws.match(/profile\?\.city/g) ?? []).length === 1 && /const home = ctx\.turn\?\.profile\?\.city \?\? null;/.test(ws));
}

console.log(`\naskPlace: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
