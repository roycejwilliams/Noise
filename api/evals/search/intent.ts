// The search brief (services/searchIntent.ts, 2026-09-30): understanding the
// ask, routing by kind, short queries, budget and headcount in code, a wider
// round, and the brief carried across texts. Model-free.
//   npx tsx evals/search/intent.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const S = await import("../../src/services/searchIntent.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};
const src = (f: string) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

// Routing: only events use Tiers 1 and 2.
check("events go to the event tiers", S.routeFor("event") === "events");
check("spaces, vendors, people, places, programs and facts go to the web tier", (["venue", "vendor", "person", "place", "program", "info"] as const).every((k) => S.routeFor(k) === "web"));

// Parsing and query shape.
const raw = JSON.stringify({
  kind: "venue",
  what: "bookable event space",
  city: "San Francisco",
  area: "NoPa / Western Addition",
  when: "Oct 10",
  budget: "$1,000",
  headcount: 120,
  vibe: "DJ set",
  summary: "a bookable space in NoPa for a 120-person DJ night on Oct 10, under $1000",
  queries: ["event space NoPa San Francisco", "\"peerspace\" party venue Western Addition 120 guests DJ allowed under 1000 dollars on October 10th", "event space NoPa San Francisco", "x"],
  sites: ["peerspace.com", "tagvenue.com", "not a domain"],
  ask: null,
});
const i = S.parseIntent(raw, "Oakland")!;
check("a budget in words becomes a number", i.budget === 1000, String(i.budget));
check("queries are short, deduped, and junk is dropped", i.queries.length === 2 && i.queries.every((q) => q.length <= S.SEARCH_LIMITS.maxQueryChars) && !i.queries.some((q) => q.includes('"')), JSON.stringify(i.queries));
check("only real domains are kept as sites", i.sites.join() === "peerspace.com,tagvenue.com");
check("an unknown kind is refused", S.parseIntent(JSON.stringify({ kind: "vibes" }), null) === null);
check("no queries: one is built from what, area and city", S.parseIntent(JSON.stringify({ kind: "vendor", what: "DJ for a party" }), "San Francisco")!.queries[0] === "DJ for a party San Francisco");
check("their city on file fills in a missing city", S.parseIntent(JSON.stringify({ kind: "place", what: "quiet bar" }), "Oakland")!.city === "Oakland");

// Broadening drops the neighborhood and vibe.
const wide = S.broaden(i);
check("with no neighbors known, a wider round drops the neighborhood and vibe, keeps size and city", wide[0] === "bookable event space San Francisco 120 people" && !wide.join(" ").includes("NoPa"), JSON.stringify(wide));
{
  const pin = { ...i, nearby: ["Lower Haight", "Alamo Square", "Hayes Valley"] };
  const w = S.broaden(pin);
  check("the wider round tries the neighborhoods next door before the whole city", w[0] === "bookable event space Lower Haight or Alamo Square San Francisco" && w[1] === "bookable event space San Francisco 120 people", JSON.stringify(w));
  check("in their area ranks above next door, above elsewhere", S.areaScore(["neighborhood: NoPa"], pin) === 2 && S.areaScore(["address: 663 Haight St, Lower Haight"], pin) === 1 && S.areaScore(["neighborhood: Chinatown"], pin) === 0);
  check("nearby neighborhoods are parsed, at most 4", S.parseIntent(JSON.stringify({ kind: "venue", what: "space", area: "NoPa", nearby: ["Lower Haight", "Alamo Square", "Panhandle", "Hayes Valley", "Western Addition", 5] }), null)!.nearby!.length === 4);
}

// Budget and headcount in code (Instinct, 2026-09-30: "$180/hr on Saturdays. Four hours is about $720").
const fit = (facts: string[]) => S.fitsConstraints(facts, { budget: 1000, headcount: 120 });
check("an hourly rate is judged over a 4-hour evening", fit(["Price: $180/hr on Saturdays", "Capacity: 120 standing"]).ok && !fit(["Price: $400 per hour"]).ok);
check("a flat price over budget is dropped", fit(["Rental: $2,500 flat"]).why?.startsWith("over budget") === true);
check("a space too small for the headcount is dropped", fit(["Capacity: 40 guests"]).why === "too small (up to 40)");
check("a space a bit small is kept and said to be tight", fit(["Capacity: 100 guests"]).ok && fit(["Capacity: 100 guests"]).tight === "fit: holds up to 100, tight for 120" && !fit(["Capacity: 120 guests"]).tight && !fit(["Capacity: 80 guests"]).ok);
check("no price or capacity on the page: kept (the reply says it's unknown)", fit(["Address: 663 Haight St"]).ok);
check("square footage isn't read as capacity", fit(["space: Approximately 40,000 square feet of flexible event space, multiple rooms; capacity: events of 500 guests"]).ok, JSON.stringify(fit(["space: Approximately 40,000 square feet of flexible event space; capacity: events of 500 guests"])));
check("an address in a capacity line isn't read as capacity", fit(["capacity: 150 standing at 151 Powell St"]).ok && !fit(["capacity: 60 guests at 995 Market St"]).ok);
check("a tight fit is ranked after full fits and the reply sees it", /Number\(!b\.tight\) - Number\(!a\.tight\) \|\| areaScore/.test(src("services/searchIntent.ts")) && /\.\.\.\(r\.tight \? \[r\.tight\] : \[\]\)/.test(src("services/searchIntent.ts")));
check("results in the area they named go first", S.inArea(["neighborhood: Lower Haight, San Francisco"], "NoPa/Western Addition near Divisadero & Haight St") && !S.inArea(["neighborhood: Chinatown"], "NoPa/Western Addition near Divisadero") && !S.inArea(["x"], null));
check("a street number isn't read as capacity", fit(["Address: 151 Powell St"]).ok);

// The brief line the reply sees.
check("the brief reads as one line", S.describeBrief(i) === "bookable event space, NoPa / Western Addition, Oct 10, 120 people, under $1000, DJ set", S.describeBrief(i));

// The prompt carries the conversation, the brief and map photos.
const prompt = S.intentPrompt({ message: "120 people", recent: "Member: find me a space for Oct 10", city: "San Francisco", known: "", today: "2026-09-30", brief: i });
check("the prompt carries the brief to update, not restart", prompt.includes("already working on") && prompt.includes('"headcount":120') && prompt.includes("keep everything they didn't change"));
check("the prompt reads a map photo as an area", prompt.includes("a map means the area around the pin"));
check("photo descriptions name the area around a map pin", /if it's a map, name the neighborhood and the streets around any pin/.test(src("services/imageRead.ts")));

// Wiring.
const rec = src("services/recommendation.ts");
check("the search understands the ask before searching, and saves the brief", /brief = await understandAsk\(userId, currentMessage/.test(rec) && /await saveBrief\(userId, brief\)/.test(rec));
check("non-event asks skip the event tiers for the verified web search", /routeFor\(brief\.kind\) === "web"[\s\S]{0,200}webFind\(userId, brief/.test(rec));
check("the event tiers search the short summary in the brief's city", /askText = brief\.summary/.test(rec) && /const searchCity = brief\?\.city \?\? profile\.city/.test(rec));
{
  const A = await import("../../src/services/askWindow.js");
  const { DateTime } = await import("luxon");
  const now = DateTime.fromISO("2026-09-30T22:13:00", { zone: "America/Los_Angeles" });
  const span = (t: string | null) => {
    const w = t ? A.resolveAskWindow(t, now).window : null;
    return w ? `${w.start.toISODate()}..${w.end.toISODate()}` : null;
  };
  // 2026-09-30: "this weekend" became "Saturday Oct 3 - Sunday Oct 4, 2026" and was searched as Saturday only.
  check("a brief's weekend written as dates with weekday names is read as both days", span(S.whenForWindow("Saturday Oct 3 - Sunday Oct 4, 2026")) === "2026-10-03..2026-10-04", String(span(S.whenForWindow("Saturday Oct 3 - Sunday Oct 4, 2026"))));
  check("their own words are left alone", S.whenForWindow("this weekend") === "this weekend" && S.whenForWindow("Friday night") === "Friday night" && S.whenForWindow(null) === null);
  check("the brief keeps the time in their own words", /the time in their own words, as they said it/.test(src("services/searchIntent.ts")) && /whenForWindow\(brief\?\.when\)/.test(src("services/recommendation.ts")));
}
check("a date from earlier in the brief scopes the event search", /briefWhen && !\(forTimeFrame && resolveAskWindow/.test(rec));
check("thin event results get one wider pass", /const wider = await searchTiers\(true\)/.test(rec));
check("understanding failing falls back to the old rewrite", /else if \(currentMessage\) \{[\s\S]{0,120}toSearchRequest/.test(rec));
const sb = src("routes/sendblue.ts");
// (2026-10-01) Replies find things in Co's own loop: it sees every result itself,
// shares up to three at a time, and a caption that says more than its facts is
// refused so Co rewrites it (agent/loopTools.ts shareFinds).
check("finds go out as a short list, up to three, each caption held to its own facts", /\.min\(1\)\s*\.max\(3\)/.test(src("agent/loopTools.ts")) && /caption says more than its facts/.test(src("agent/loopTools.ts")));
const tw = src("services/taskWeb.ts");
check("web search budget is the live-request pool for replies", /source: "request"/.test(src("services/searchIntent.ts")) && /reserveWebSearch\(userId, opts\.source \?\? "sweep", what\)/.test(tw));

// Marketplaces that block reading.
const TW = await import("../../src/services/taskWeb.js");
check("GigSalad, Yelp and The Knot are known unreadable; Peerspace and The Bash read in a browser", ["gigsalad.com", "www.yelp.com", "theknot.com"].every(TW.cantCheck) && !["peerspace.com", "thebash.com", "giggster.com"].some(TW.cantCheck));
check("a search naming an unreadable marketplace asks for the place's own site", /can't be opened to check, so for anything found there give the place's OWN website/.test(tw));
check("a result with nothing on its page isn't sent", /nothing about it on its page/.test(src("services/searchIntent.ts")));
check("the reply is told why Peerspace listings weren't used", /hide the venue or block checking/.test(src("services/searchIntent.ts")));

// A real browser when a fetch is turned away (services/browserRead.ts).
const B = await import("../../src/services/browserRead.js");
check("the browser never opens a private or local address", ["localhost", "127.0.0.1", "10.2.3.4", "192.168.1.1", "172.20.0.1", "169.254.169.254", "[::1]", "db.internal"].every(B.privateHost) && !B.privateHost("www.peerspace.com") && !B.privateHost("8.8.8.8"));
B.rememberLinks("https://www.peerspace.com/venues/san-francisco--ca/corporate-event-venue", [
  { text: "Versatile and Modern Event Space in Downtown SF\nFinancial District", href: "https://www.peerspace.com/pages/listings/abc123" },
  { text: "Versatile and Modern Event Space in Downtown SF", href: "https://evil.example.com/x" },
]);
check("a result on a list page links its own listing, on the same site", B.ownLink("https://www.peerspace.com/venues/san-francisco--ca/corporate-event-venue", "Versatile and Modern Event Space in Downtown SF") === "https://www.peerspace.com/pages/listings/abc123" && B.ownLink("https://www.peerspace.com/venues/san-francisco--ca/corporate-event-venue", "Something Else") === null);
check("BROWSER_READ=off turns it off", !B.browserReadEnabled({ BROWSER_READ: "off" } as any) && B.browserReadEnabled({} as any));
const wos = src("services/webOpportunitySearch.ts");
check("the browser is only a fallback: a readable fetch is used as is, a 404 isn't retried", /if \(text\.length >= MIN_FETCHED_TEXT\) return/.test(wos) && /res\.status === 404 \|\| res\.status === 410\)\)\s*return null/.test(wos) && /browserPageText\(u\.toString\(\)\)/.test(wos));
const docker = fs.readFileSync(new URL("../../../co-test/Dockerfile", import.meta.url), "utf8") + fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
// co-test runs api code compiled into its own folder, so packages resolve from
// co-test's node_modules (2026-10-01: playwright-core was only in api's, and the
// browser fallback quietly never ran on co-test).
check("co-test can load playwright-core itself", /"playwright-core"/.test(fs.readFileSync(new URL("../../../co-test/package.json", import.meta.url), "utf8")));
check("both images install Chromium", (docker.match(/apk add --no-cache chromium/g) ?? []).length === 2 && /CHROMIUM_PATH=\/usr\/bin\/chromium-browser/.test(docker));

// A fact next to its own name on a list page.
const list = "Top venues. The Loft on Market. Holds 80 guests. From $150/hr. Second venue: Harbor Room. Holds 200 guests. From $900/hr. " + "Filler text about the city. ".repeat(80) + "Contact us.";
// Two cards side by side are within the window: the code check can't tell, the second reader can.
check("side-by-side listings are left to the second reader (the passage it reads covers both)", TW.nearName("The Loft on Market", "$900/hr", list, true).excerpt.includes("Harbor Room"));
const far = "The Loft on Market. Holds 80 guests. " + "Other listings and filler. ".repeat(90) + "Harbor Room. Holds 200 guests. From $900/hr.";
check("a price far from the name on a list page doesn't count", !TW.nearName("The Loft on Market", "$900/hr", far, true).ok && TW.nearName("The Loft on Market", "80 guests", far, true).ok);
check("the thing's own page or a single listing doesn't need it", TW.nearName("The Loft on Market", "$900/hr", far, false).ok && TW.singleItemUrl("https://www.peerspace.com/pages/listings/69383e05227dfd74f5b9f577") && !TW.singleItemUrl("https://www.peerspace.com/venues/san-francisco--ca/photo-studio"));
{
  const own = "House of AI\nEvents Calendar Floor Plan Host Your Event " + "Menu item. ".repeat(60) + "Where: 40 Boardman Pl., in the heart of SoMa, SF. Up to 200 guests.";
  check("on its own page, the passage is where the fact is, mixed case and acronyms included", TW.nearName("House of AI", "SoMa, SF", own, false).excerpt.includes("heart of SoMa") && TW.nearName("House of AI", "industrial loft feel", own + " An industrial loft feel.", false).excerpt.includes("industrial loft"));
}
check("the passage around the fact is kept for the second reader", TW.nearName("The Loft on Market", "80 guests", far, true).excerpt.includes("80 guests"));

// Price math in code.
check("an hourly rate becomes a total for 4 assumed hours", S.priceEstimate(["price: $180/hr on Saturdays"], null) === "estimate: $180/hr × 4 hrs ≈ $720 (4 hours assumed), before fees", String(S.priceEstimate(["price: $180/hr on Saturdays"], null)));
check("their hours are used when they said them", S.priceEstimate(["price: $180/hr"], 5)!.includes("× 5 hrs ≈ $900") && !S.priceEstimate(["price: $180/hr"], 5)!.includes("assumed"));
check("a minimum longer than their hours wins", S.priceEstimate(["price: $75/hr", "minimum: 6 hr minimum"], 4)!.includes("× 6 hrs ≈ $450"));
check("a rate range stays a range", S.priceEstimate(["price: $20–$100/hr"], 4)!.includes("$20–$100/hr × 4 hrs ≈ $80–$400"));
check("a flat price gets no estimate", S.priceEstimate(["price: $1,200 flat"], null) === null);
check("the budget check uses their hours", !S.fitsConstraints(["price: $180/hr"], { budget: 1000, headcount: null, hours: 8 }).ok && S.fitsConstraints(["price: $180/hr"], { budget: 1000, headcount: null, hours: 4 }).ok);

// Claims a page rarely makes.
const facts = "Wave. capacity: 120 standing; price: $180/hr";
check("'available on the 10th' isn't said unless the page says it", TW.unbackedClaims("Wave holds 120 and is available on Oct 10.", facts).length === 1 && TW.unbackedClaims("Wave is available for private events.", "availability: available Saturdays").length === 0);
check("'open to hosting' and 'has done DJ nights' need the page", TW.unbackedClaims("They're open to hosting community events.", facts).length === 1 && TW.unbackedClaims("It has hosted DJ nights before.", facts).length === 1 && TW.unbackedClaims("It has hosted DJ nights before.", "past events: hosted DJ nights").length === 0);
check("'confirmed' is never said from a page that doesn't", TW.unbackedClaims("Confirmed for 120.", facts).length === 1);
check("'allows your own DJ' needs the page", TW.unbackedClaims("It allows your own DJ.", facts).length === 1 && TW.unbackedClaims("It allows your own DJ.", "rules: outside DJs allowed").length === 0);
check("plain facts pass", TW.unbackedClaims("Wave in Lower Haight holds 120 standing, about $720 for four hours.", facts).length === 0);

// The second reader (services/factCheck.ts).
const F = await import("../../src/services/factCheck.js");
check("on by default (measured: evals/search/factCheck.ts); shadow and off by switch", F.factCheckMode({} as any) === "on" && F.factCheckMode({ SEARCH_FACT_CHECK: "shadow" } as any) === "shadow" && F.factCheckMode({ SEARCH_FACT_CHECK: "off" } as any) === "off");
check("Jev's probabilities become yes / no / unclear", F.verdictFrom(0.9) === "yes" && F.verdictFrom(0.1) === "no" && F.verdictFrom(0.5) === "unclear");
{
  const items = [{ thing: "A", fact: "x", passage: "p" }, { thing: "B", fact: "y", passage: "q" }];
  const viaJev = await F.checkFacts(items, { jev: async () => ({ f0: 0.95, f1: 0.05 }), haiku: async () => { throw new Error("no"); } });
  const viaHaiku = await F.checkFacts(items, { jev: async () => null, haiku: async () => '{"verdicts": ["no", "yes"]}' });
  const neither = await F.checkFacts(items, { jev: async () => null, haiku: async () => "garbage" });
  check("Jev answers when it can", viaJev.verdicts.join() === "yes,no" && viaJev.by.join() === "jev");
  check("Haiku reads the batch when Jev is busy", viaHaiku.verdicts.join() === "no,yes" && viaHaiku.by.join() === "haiku");
  check("neither answering drops nothing", neither.verdicts.every((v) => v === "unclear"));
  const many = Array.from({ length: 25 }, (_, i) => ({ thing: `T${i}`, fact: "f", passage: "p" }));
  let calls = 0;
  await F.checkFacts(many, { jev: async (_s, q) => { calls++; return Object.fromEntries(Object.keys(q).map((k) => [k, 0.9])); } });
  check("facts go in batches of 12 (the gateway's rate limit)", calls === 3);
}
const si = src("services/searchIntent.ts");
check("only an 'on' fact check drops facts or tells the reply", /if \(mode === "on"\) factChecks\.forEach/.test(si) && /if \(mode === "on"\) \{\s*for \(const r of top\)/.test(si));

console.log(`\nsearch intent rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
