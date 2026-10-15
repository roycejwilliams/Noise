// Sweep queries are generalized, not member-specific (Royce, 2026-10-08). Zero tokens, no outside calls:
//   1. given a member's goals, derived queries carry no member or company identifiers
//   2. queries stay within the simplicity bound (four content words; city, dates and operators don't count)
//   3. X and web get differently phrased queries for the same intent
//   4. every sweep's queries are logged beside its keeps and passes
//   npx tsx evals/sweepFind/queries.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const Q = await import("../../src/services/sweepQuery.js");
const G = await import("../../src/services/goalEdges.js");
const SF = await import("../../src/services/sweepFind.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const GOALS = [
  "partnering with Sequin AI for a November launch party",
  "have Co draft planning docs for branding and launch strategy with Sequin AI",
  "Connected with Jeremy Toce/House of AI for a November event",
];
const terms = Q.memberTerms({ firstName: "Royce", goals: GOALS });

// ---- 1. no member or company identifiers
{
  check("the member's identifiers: their name, Co, and the names in their own work", ["Royce", "Co", "Sequin AI", "House of AI", "Jeremy Toce"].every((t) => terms.includes(t)), terms);
  const t2 = Q.memberTerms({ goals: ["Launch the Oct 10 DJ night at Rick & Roxy's", "Sequin AI wants a launch", "Get Co in front of users"] });
  check("a goal's sentence-starting word isn't a name (Get, Launch), a month abbreviation isn't either, a company starting a goal still is", !t2.some((t) => /^(?:Get|Get Co|Launch|Launch the Oct|Oct)$/.test(t)) && t2.includes("Rick & Roxy's") && t2.includes("Sequin AI"), t2);
  check("Co is matched as a word, never inside co-working", Q.queryProblems("co-working spaces SF", { terms: ["Co"], source: "web" }).length === 0 && Q.queryProblems("Co-working spaces SF", { terms: ["Co"], source: "web" }).length === 0 && Q.queryProblems("events like Co SF", { terms: ["Co"], source: "web" }).length > 0);
  check("the X guidance's own recommended shape passes the bound", Q.queryProblems("(accelerator OR cohort OR fellowship) (applications open OR now accepting OR apply) consumer AI", { terms: [], source: "x" }).length === 0);
  check("months, cities and category acronyms are never identifiers", !terms.some((t) => /^(?:November|SF|AI|San Francisco)$/.test(t)));
  for (const q of ["Sequin AI House of AI November launch party sponsors", "Royce founder dinners SF", "events like CoPatible", "AI events for someone building a private social club"]) {
    check(`refused, names or describes the member: "${q}"`, Q.queryProblems(q, { terms, source: "web" }).some((p) => /member/.test(p)));
  }
  for (const q of ["SF AI founder events November", "consumer AI pre-seed open calls", "founder wellness community SF"]) {
    check(`allowed, names the thing: "${q}"`, Q.queryProblems(q, { terms, source: "web" }).length === 0, Q.queryProblems(q, { terms, source: "web" }));
  }
  const edges = G.parseEdges(GOALS, JSON.stringify([
    { n: 1, kind: "work", edges: ["Sequin AI launch party sponsors SF", "SF AI founder events November"] },
    { n: 2, kind: "co_task", edges: ["House of AI November events"] },
    { n: 3, kind: "work", edges: ["AI demo nights SF"] },
  ]), "Royce");
  const all = edges.flatMap((e) => e.edges);
  check("derived goal edges with a member or company name are dropped; the generic ones stay", all.join("|") === "SF AI founder events November|AI demo nights SF", all);
  const place = G.parseEdges(["find a running club in the Marina"], JSON.stringify([{ n: 1, kind: "findable", edges: ["Marina run clubs"] }]));
  check("a name in a findable goal (a neighborhood) is the thing being found, not the member", place[0].edges[0] === "Marina run clubs");
  check("a name in the ask itself is the thing being found (the sweep exempts the ask's own words)", Q.memberTerms({ firstName: "Royce", goals: ["host a dinner at Peerspace venues"], except: "Peerspace venues in NoPa" }).every((t) => t !== "Peerspace venues"));
  check("the edge prompt asks for the thing, never their names or a description of them", /Never a name \(theirs, their company, partners or people\), never a description of them/.test(G.edgePrompt(["x"], { city: "SF", today: "2026-10-08" })));
}

{
  // The review of #107: capitalized category words in goals are not names, and the prompt's own examples pass.
  const t = Q.memberTerms({ firstName: "Royce", goals: ["Host Events for the club", "Connect with Founders building in AI", "Meet other AI Founders in SF", "I want to meet Investors", "Join a Book Club", "Get into Climbing", "partnering with Sequin AI for a November launch"] });
  check("Events, Founders, AI Founders, Investors, Book Club, Climbing are not member terms; Sequin AI is", !t.some((x) => /^(?:Events|Founders|AI Founders|Investors|Book Club|Climbing)$/.test(x)) && t.includes("Sequin AI"), t);
  for (const q of ["AI founder events SF", "AI founders SF tonight", "SF tech events November 2026", "book club SF"]) check(`with those goals on file, "${q}" is allowed`, Q.queryProblems(q, { terms: t, source: "web" }).length === 0);
  check("a one-word name matches case as written ('Royce', never 'royce' in a word list); longer names in any case", Q.queryProblems("royce gardens SF", { terms: ["Royce"], source: "web" }).length === 0 && Q.queryProblems("sequin ai launch SF", { terms: ["Sequin AI"], source: "web" }).length > 0);
}

// ---- 2. the simplicity bound
{
  check("four content words pass; city, dates and years don't count", Q.contentWords("SF tech events November 2026").join(" ") === "tech events" && Q.queryProblems("SF AI founder events November", { terms: [], source: "web" }).length === 0);
  check("a term searched as one counts as one (open calls, applications open)", Q.contentWords("consumer AI pre-seed open calls").length === 4 && Q.contentWords("(accelerator OR cohort OR fellowship) consumer AI applications open").length === 4);
  const tight = "post-event community engagement strategy social club platform";
  check(`over four: refused as too tight ("${tight}")`, Q.queryProblems(tight, { terms: [], source: "web" }).some((p) => /too tight \(\d+ content words, at most 4/.test(p)));
  check("X operators don't count (-is:retweet lang:en)", Q.contentWords("AI founders SF tonight -is:retweet lang:en").length === 2);
  check("the events feed matches meaning, so only the member rule applies there", Q.queryProblems("founder or investor social events weekday evenings after work", { terms: [], source: "events" }).length === 0);
}

// ---- 3. X and web phrased differently for the same intent
{
  const L = new Q.QueryLedger([]);
  check("a web query runs", L.check("web", "SF AI founder events November").length === 0);
  L.ran("web", "SF AI founder events November", 6);
  const same = L.check("x", "SF AI founder events November");
  check("the same words to X are refused, with how posts read", same.some((p) => /same as the web query/.test(p) && /the way posts read/.test(p)), same);
  check("...reordered or near-identical too", L.check("x", "AI founder events SF November").length > 0);
  check("phrased the way posts read: allowed", L.check("x", "AI founders SF tonight").length === 0);
  L.ran("x", "AI founders SF tonight", 12);
  check("and a later web query can't repeat the X one", L.check("web", "AI founders SF tonight").some((p) => /same as the X query/.test(p)));
  check("the sweep is told to phrase for each source and never send the same words to both", /X like what people post/.test(Q.SWEEP_QUERY_RULES) && /the web like the title of a page/.test(Q.SWEEP_QUERY_RULES) && /Never send the same words to both/.test(Q.SWEEP_QUERY_RULES) && SF.sweepPrompt({ userId: "u", firstName: "J", askText: "x", city: "SF" }, { today: "2026-10-08", record: SF.emptySweepRecord() }).includes(Q.SWEEP_QUERY_RULES));
}

// ---- 4. every query logged beside its keeps and passes
{
  const L = new Q.QueryLedger(Q.memberTerms({ firstName: "Royce", goals: GOALS }));
  const bad = L.check("web", "Sequin AI November launch sponsors");
  check("a refused query costs nothing and tells Co what to fix", bad.length > 0 && /Rewrite it and search again; it cost nothing/.test(L.refusal("Sequin AI November launch sponsors", bad)));
  L.ran("web", "SF AI founder events November", 3);
  L.ran("x", "AI founders SF tonight", 2);
  L.ran("events", "AI founder gatherings", 2);
  const looked = [
    { source: "web" as const, url: "https://a.example", query: "SF AI founder events November" },
    { source: "web" as const, url: "https://b.example", query: "SF AI founder events November" },
    { source: "web" as const, url: "https://c.example", query: "SF AI founder events November" },
    { source: "x" as const, url: "https://x.com/i/status/1", query: "AI founders SF tonight" },
    { source: "x" as const, url: "https://x.com/i/status/2", query: "AI founders SF tonight" },
    { source: "events" as const, url: "https://lu.ma/one", query: "AI founder gatherings" },
    { source: "events" as const, url: "https://lu.ma/two", query: "AI founder gatherings" },
  ];
  // A page kept through an X post counts for the X query.
  const viaPost = new Map([["https://demo.example", "https://x.com/i/status/2"]]);
  const keptUrls = new Set(["https://a.example", "https://lu.ma/one", "https://demo.example", "https://x.com/i/status/2"]);
  const { queries, keptBy } = L.finish(looked, keptUrls, [{ name: "AI Founder Night", url: "https://a.example" }, { name: "Builders Supper", url: "https://lu.ma/one" }, { name: "Demo Night", url: "https://demo.example" }], viaPost);
  const by = (s: string) => queries.find((q) => q.source === s && !q.refused)!;
  check("each query carries its results, keeps and passes", by("web").results === 3 && by("web").kept === 1 && by("web").passed === 2 && by("events").kept === 1 && by("events").passed === 1 && by("x").kept === 1 && by("x").passed === 1, queries);
  check("the refused query is in the log with why", queries.some((q) => q.refused?.length && /Sequin AI/.test(q.query)));
  check("each keep names the query (and source) that found it, through a post too", keptBy.map((k) => `${k.name}<-${k.source}:${k.query}`).join(" | ") === "AI Founder Night<-web:SF AI founder events November | Builders Supper<-events:AI founder gatherings | Demo Night<-x:AI founders SF tonight", keptBy);
  check("each pass names its query (passedOver carries it)", SF.passedOver([{ source: "web", name: "B", url: "https://b.example", query: "SF AI founder events November" }], new Set(), new Map())[0].query === "SF AI founder events November");
  const sf = src("services/sweepFind.ts");
  check("the sweep runs every query through the ledger (events, web, X; web and X loosened when only too tight) and logs it on sweep.find", /ledger\.check\("events", what\)/.test(sf) && /ledger\.checkOrLoosen\("web", q\)/.test(sf) && /ledger\.checkOrLoosen\("x", asked\)/.test(sf) && /passedOver: passed, queries, keptBy/.test(sf));
  check("a refused X query doesn't spend the X search", sf.indexOf('ledger.check("x", q)') < sf.indexOf("xSearches++;"));
}

console.log(`sweep queries: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
