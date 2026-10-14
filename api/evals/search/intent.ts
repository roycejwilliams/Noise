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

// Budget and headcount in code (Instinct, 2026-09-30: "$180/hr on Saturdays. Four hours is about $720").
const fit = (facts: string[]) => S.fitsConstraints(facts, { budget: 1000, headcount: 120 });
check("an hourly rate is judged over a 4-hour evening", fit(["Price: $180/hr on Saturdays", "Capacity: 120 standing"]).ok && !fit(["Price: $400 per hour"]).ok);
check("a flat price over budget is dropped", fit(["Rental: $2,500 flat"]).why?.startsWith("over budget") === true);
check("a space too small for the headcount is dropped", fit(["Capacity: 40 guests"]).why === "too small (up to 40)");
check("a space a bit small is kept and said to be tight", fit(["Capacity: 100 guests"]).ok && fit(["Capacity: 100 guests"]).tight === "fit: holds up to 100, tight for 120" && !fit(["Capacity: 120 guests"]).tight && !fit(["Capacity: 80 guests"]).ok);
check("no price or capacity on the page: kept (the reply says it's unknown)", fit(["Address: 663 Haight St"]).ok);
check("square footage isn't read as capacity", fit(["space: Approximately 40,000 square feet of flexible event space, multiple rooms; capacity: events of 500 guests"]).ok, JSON.stringify(fit(["space: Approximately 40,000 square feet of flexible event space; capacity: events of 500 guests"])));
check("an address in a capacity line isn't read as capacity", fit(["capacity: 150 standing at 151 Powell St"]).ok && !fit(["capacity: 60 guests at 995 Market St"]).ok);
check("a street number isn't read as capacity", fit(["Address: 151 Powell St"]).ok);

check("photo descriptions name the area around a map pin", /if it's a map, name the neighborhood and the streets around any pin/.test(src("services/imageRead.ts")));

// The weekend reads as both days wherever a time is resolved (askWindow.ts).
{
  const A = await import("../../src/services/askWindow.js");
  const { DateTime } = await import("luxon");
  const now = DateTime.fromISO("2026-09-30T22:13:00", { zone: "America/Los_Angeles" });
  const span = (t: string | null) => {
    const w = t ? A.resolveAskWindow(t, now).window : null;
    return w ? `${w.start.toISODate()}..${w.end.toISODate()}` : null;
  };
  // 2026-09-30: "this weekend" became "Saturday Oct 3 - Sunday Oct 4, 2026" and was searched as Saturday only.
  check("a weekend written as dates with weekday names is read as both days", span(A.whenForWindow("Saturday Oct 3 - Sunday Oct 4, 2026")) === "2026-10-03..2026-10-04", String(span(A.whenForWindow("Saturday Oct 3 - Sunday Oct 4, 2026"))));
  check("their own words are left alone", A.whenForWindow("this weekend") === "this weekend" && A.whenForWindow("Friday night") === "Friday night" && A.whenForWindow(null) === null);
  check("every event search reads its time this way", /const when = whenForWindow\(opts\.when\);/.test(src("services/tieredRecommendation.ts")));
}
const sb = src("routes/sendblue.ts");
// (2026-10-01) Replies find things in Co's own loop: it sees every result itself,
// shares up to three at a time, and a caption that says more than its facts is
// refused so Co rewrites it (agent/loopTools.ts shareFinds).
check("finds go out as a short list, up to three, each caption held to its own facts", /\.min\(1\)\s*\.max\(3\)/.test(src("agent/loopTools.ts")) && /caption says more than its facts/.test(src("agent/loopTools.ts")));
const tw = src("services/taskWeb.ts");
check("web search budget is the live-request pool for replies", /source: "request"/.test(src("agent/loopTools.ts")) && /reserveWebSearch\(userId, opts\.source \?\? "sweep", what\)/.test(tw));

// Marketplaces that block reading.
const TW = await import("../../src/services/taskWeb.js");
check("GigSalad, Yelp and The Knot are known unreadable; Peerspace and The Bash read in a browser", ["gigsalad.com", "www.yelp.com", "theknot.com"].every(TW.cantCheck) && !["peerspace.com", "thebash.com", "giggster.com"].some(TW.cantCheck));
check("a search naming an unreadable marketplace asks for the place's own site", /can't be opened to check, so for anything found there give the place's OWN website/.test(tw));
check("a result with nothing on its page isn't a find", /nothing about it on its page/.test(src("agent/loopTools.ts")) && /read\.kept\.filter\(\(k\) => k\.facts\.length\)/.test(src("agent/loopTools.ts")));
check("Cue is told why listings on sites that block reading weren't used", /those sites block reading, so their listings can't be checked/.test(src("agent/loopTools.ts")));

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
check("the browser is only a fallback: a readable fetch is used as is, a 404 isn't retried", /if \(text\.length >= MIN_FETCHED_TEXT\) return/.test(wos) && /res\.status === 404 \|\| res\.status === 410\)\)\s*return \{ text: null, gone: true \}/.test(wos) && /browserPageText\(u\.toString\(\)\)/.test(wos));
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
check("only an 'on' fact check drops facts", /if \(mode !== "on"\) return \{ kept, droppedFacts: \[\] \};/.test(src("services/factCheck.ts")) && /checkVerified\(/.test(src("agent/loopTools.ts")) && /checkVerified\(/.test(src("services/sweepFind.ts")));

console.log(`\nsearch intent rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
