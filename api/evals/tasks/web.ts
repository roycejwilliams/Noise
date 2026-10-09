// Model-free checks: task web results prove themselves (services/taskWeb.ts),
// and only verified fields reach a task text (services/taskTurn.ts).
//
//   npx tsx evals/tasks/web.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const W = await import("../../src/services/taskWeb.js");
const TT = await import("../../src/services/taskTurn.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const now = new Date("2026-09-30T18:00:00Z");
const page = `The Loft at Mission Bay. Private event space in Mission Bay, San Francisco. Standing capacity 80 guests, seated 60. Rental from $1,200 per evening. Address: 1 Channel Street. Now booking October 10 and later dates.`;
const raw = {
  name: "The Loft at Mission Bay",
  url: "https://theloftsf.com/events",
  details: [
    { label: "capacity", value: "seated 60, standing 80" },
    { label: "price", value: "from $1,500 per evening" },
    { label: "neighborhood", value: "Mission Bay" },
    { label: "address", value: "1 Channel Street" },
    { label: "neighborhood", value: "SoMa" },
  ],
  date: "2026-10-10",
  deadline: null,
};

// 1. Facts must be on the page
const v = W.verifyResult(raw, page, { now, official: true });
check("a result whose name is on its page is kept", !!v.kept);
check("a detail that is on the page is kept", !!v.kept?.facts.includes("capacity: seated 60, standing 80") && !!v.kept?.facts.includes("address: 1 Channel Street") && !!v.kept?.facts.includes("neighborhood: Mission Bay"));
check("a price that isn't on the page is dropped ($1,500 vs $1,200)", !v.kept?.facts.some((f) => /1,500/.test(f)) && v.droppedDetails.some((d) => /1,500/.test(d.detail)));
check("a neighborhood that isn't on the page is dropped", !v.kept?.facts.some((f) => /SoMa/.test(f)) && v.droppedDetails.some((d) => /SoMa/.test(d.detail)));
check("the event date is kept only because the page states it", v.kept?.date === "2026-10-10");
check("a date the page doesn't state is dropped", W.verifyResult({ ...raw, date: "2026-11-14" }, page, { now, official: true }).kept?.date === null);
check("a result whose name isn't on its page is dropped whole", !W.verifyResult({ ...raw, name: "Pier 70 Warehouse" }, page, { now, official: true }).kept);

// 3. Stale results
check("a past date is rejected", !!W.verifyResult({ ...raw, date: "2026-09-12" }, page.replace("October 10", "September 12"), { now, official: true }).dropped);
check("a passed deadline is rejected", !!W.verifyResult({ ...raw, date: null, deadline: "2026-09-01" }, `${page} Apply by September 1.`, { now, official: true }).dropped);
check("closed applications are rejected", /closed/.test(W.verifyResult(raw, `${page} Applications are closed for this cycle.`, { now, official: true }).dropped?.why ?? ""));
check("a sold-out or no-longer-available listing is rejected", !!W.verifyResult(raw, `${page} This event is sold out.`, { now, official: true }).dropped && !!W.verifyResult(raw, `${page} This space is no longer available.`, { now, official: true }).dropped);

check("a closed phrase far from the thing, in page boilerplate, doesn't reject it", !!W.verifyResult(raw, `${page} ${"Other content. ".repeat(80)} Return to the calendar. The time you selected is no longer available.`, { now, official: true }).kept);
check("a closed phrase next to the thing's name still rejects it", !!W.verifyResult(raw, `${"Intro. ".repeat(150)} The Loft at Mission Bay is no longer available for private events.`, { now, official: true }).dropped);
check("a descriptive detail with words not on the page is dropped", (() => { const r = W.verifyResult({ ...raw, details: [{ label: "booking", value: "Instant book online" }, { label: "type", value: "private event space" }] }, page, { now, official: true }); return !r.kept!.facts.some((f) => /Instant/.test(f)) && r.kept!.facts.includes("type: private event space"); })());
check("a person's name that isn't on the page is dropped", !W.verifyResult({ ...raw, details: [{ label: "contact", value: "ask for Malcolm Lewis" }] }, page, { now, official: true }).kept!.facts.length);

// 2. Prefer the official page
const blog = { ...raw, url: "https://bestvenues-blog.com/top-10-sf-venues" };
const reads: Record<string, string | null> = { "https://theloftsf.com/": page, "https://bestvenues-blog.com/top-10-sf-venues": "Top 10 venues ... The Loft at Mission Bay seats 60." };
const swap = await W.pickPage(blog, { read: async (u) => reads[u] ?? null, official: async () => "https://theloftsf.com/" });
check("a blog result is swapped for the thing's own page when it reads", swap.swapped && swap.url === "https://theloftsf.com/" && swap.official);
const noOfficial = await W.pickPage(blog, { read: async (u) => reads[u] ?? null, official: async () => "https://theloftsf.com/unreadable" });
check("the found page is kept when the official one can't be read", !noOfficial.swapped && noOfficial.url === blog.url && !noOfficial.official);
const already = await W.pickPage(raw, { read: async () => page, official: async () => { throw new Error("should not be called"); } });
check("an official page isn't looked up again", !already.swapped && already.official);

// 4. Only verified fields reach a task text
{
  const priced = W.verifyResult({ ...raw, details: [...raw.details, { label: "price", value: "from $1,200 per evening" }] }, page, { now, official: true }).kept!;
  const lines = W.verifiedFactLines([priced]).join(" ");
  check("a draft number no verified fact backs is caught, a verified one passes", !W.numbersBacked("It seats 60 and costs $1,500.", lines).ok && W.numbersBacked("It seats 60, from $1,200.", lines).ok);
}
check("the verified lines carry kept facts only", !W.verifiedFactLines([v.kept!]).join(" ").includes("1,500") && !W.verifiedFactLines([v.kept!]).join(" ").includes("SoMa"));

// Behavior: run a dry task turn with a scripted model? Not model-free. Instead check what tellThem hands the draft.
{
  const fs = await import("node:fs");
  const tt = fs.readFileSync(new URL("../../src/services/taskTurn.ts", import.meta.url), "utf8");
  const facts = tt.slice(tt.indexOf("const facts = {"), tt.indexOf("};", tt.indexOf("const facts = {")));
  check("tellThem's draft facts hold only verified fields, never raw page text or Co's own intent line", /verified_results: verifiedFactLines\(verified\)/.test(facts) && !/pages|pageText|what_co_wants|what_the_pages_say/.test(facts));
  check("a draft is checked for unbacked numbers before it sends", /numbersBacked\(text, Object\.values\(facts\)\.join\(" "\)\)/.test(tt));
  check("links must come from results that passed", /const linkOk = \(l: string\) => verified\.some\(\(v\) => v\.url === l\) \|\| events\.some/.test(tt));
  check("every web search is logged as task.webSearch with kept and dropped", /decision: "task\.webSearch"/.test(fs.readFileSync(new URL("../../src/services/taskWeb.ts", import.meta.url), "utf8")));
}
void TT;

check("a place the facts don't back is caught, a backed one passes", !W.placesBacked("Penny Roma in Bernal Heights holds 60.", "Penny Roma: address: 3000 20th Street San Francisco CA").ok && W.placesBacked("The Loft in Mission Bay holds 60.", "The Loft at Mission Bay: neighborhood: Mission Bay").ok);
check("an offer to call, book or contact anyone is caught", ["Want me to call and check before Friday?", "I'll book it for you.", "Should I reach out to them?"].every((t) => W.OFFERS_WHAT_CO_CANT.test(t)) && !W.OFFERS_WHAT_CO_CANT.test("You could call them to confirm the date."));
{
  const tt2 = (await import("node:fs")).readFileSync(new URL("../../src/services/taskTurn.ts", import.meta.url), "utf8");
  check("a task text is blocked for unbacked places or an offer Co can't keep", /placesBacked\(text, Object\.values\(facts\)\.join\(" "\)\)/.test(tt2) && /text\.match\(OFFERS_WHAT_CO_CANT\)/.test(tt2));
}

// Link first, then its description, in tier order (Royce, 2026-09-30)
{
  const M = await import("../../src/services/taskMessages.js");
  const items = M.orderByTier([
    { url: "https://web.example/a", name: "Web A", tier: 3, facts: [] },
    { url: "https://lu.ma/b", name: "Public B", tier: 2, facts: [] },
    { url: "https://co.example/c", name: "Co C", tier: 1, facts: [] },
    { url: "https://web.example/d", name: "Web D", tier: 3, facts: [] },
  ]);
  check("things are sent in tier order: Co's own, then public events, then the web (stable within a tier)", items.map((i) => i.name).join(",") === "Co C,Public B,Web A,Web D");
  const msgs = M.assembleMessages(items.slice(0, 2).map((i) => ({ url: i.url, caption: `about ${i.name}` })), "Want me to keep going?");
  check("several things: each link followed by its own caption, closing last, no lead line narrating the send", JSON.stringify(msgs) === JSON.stringify(["https://co.example/c", "about Co C", "https://lu.ma/b", "about Public B", "Want me to keep going?"]));
  check("one thing: its link, then its caption, no heads-up", JSON.stringify(M.assembleMessages([{ url: "https://x.example", caption: "It fits." }], null)) === JSON.stringify(["https://x.example", "It fits."]));
  check("a caption can only use its own item's verified facts", !M.captionOk("Seats 80 in SoMa, from $900.", "The Loft capacity: seated 60 price: from $1,200").ok && M.captionOk("Seats 60, from $1,200.", "The Loft capacity: seated 60 price: from $1,200").ok);
  const tt3 = (await import("node:fs")).readFileSync(new URL("../../src/services/taskTurn.ts", import.meta.url), "utf8");
  check("a task text with links goes out link-then-caption, never links trailing a paragraph", /const messages = assembleMessages\(good, closing\)/.test(tt3) && /await deps\.send\(\[text\]\)/.test(tt3) && !/deps\.send\(\[text, \.\.\.known\]\)/.test(tt3));
}

// 5. Names with the search model's qualifiers (2026-10-07 live brief: "Beretta Mission (Private Dining Room)" dropped)
{
  check("the core name drops a parenthetical and anything after a spaced dash, slash, bar or colon", W.coreName("Beretta Mission (Private Dining Room)") === "Beretta Mission" && W.coreName("Copra - The Greenhouse / Mezzanine") === "Copra" && W.coreName("Perbacco — Barbaresco Room") === "Perbacco" && W.coreName("Nari: Suda Room") === "Nari" && W.coreName("Four Seasons San Francisco – MKT (Vista)") === "Four Seasons San Francisco");
  check("a hyphenated or plain name is left whole", W.coreName("Mastro's Steakhouse") === "Mastro's Steakhouse" && W.coreName("Saint-Germain Room") === "Saint-Germain Room" && W.coreName("(Private)") === "(Private)");
  const beretta = "Valencia | Beretta | Italian Restaurant in CA. Beretta Mission, 1199 Valencia Street. Group events for up to 40 guests seated.";
  const bRaw = { name: "Beretta Mission (Private Dining Room)", url: "https://www.berettasf.com/valencia-2/", details: [{ label: "capacity", value: "up to 40 guests seated" }], date: null, deadline: null };
  const bOwn = W.verifyResult(bRaw, beretta, { now, official: true });
  check("a qualified name passes on its core name, and goes on as the core name", bOwn.kept?.name === "Beretta Mission" && bOwn.kept.facts.includes("capacity: up to 40 guests seated"), bOwn);
  check("the full name stays when every word of it is on the page", W.verifyResult({ ...bRaw, name: "Beretta (Valencia)" }, beretta, { now, official: true }).kept?.name === "Beretta (Valencia)");
  check("a core name that isn't on the page is still dropped", !W.verifyResult({ ...bRaw, name: "Delfina (Private Room)" }, beretta, { now, official: true }).kept);
  const half = "Top 10 private dining rooms: Beretta Valencia seats 40, and more.";
  check("on a page that isn't the place's own, every core word must be there", !W.verifyResult({ ...bRaw, name: "Beretta Mission (Private Dining Room)", url: "https://bestvenues-blog.com/top-10" }, half, { now, official: false }).kept && W.verifyResult({ ...bRaw, name: "Beretta Valencia (Private Dining Room)", url: "https://bestvenues-blog.com/top-10", details: [] }, half, { now, official: false }).kept?.name === "Beretta Valencia");
  check("a qualifier's generic words never carry a name the page doesn't have", !W.verifyResult({ ...bRaw, name: "Delfina Mission (Private Dining Room)", url: "https://bestvenues-blog.com/top-10" }, `${half} Mission district.`, { now, official: false }).kept);
  check("nameAllOnPage needs every word", W.nameAllOnPage("Leo's Oyster Bar", "Leo’s Oyster Bar - San Francisco") && !W.nameAllOnPage("Leo's Oyster Bar Private Events", "Leo’s Oyster Bar - San Francisco"));
  let asked = "";
  await W.pickPage({ ...bRaw, url: "https://www.7x7.com/best-private-dining-rooms-sf" }, { read: async () => "page", official: async (n) => { asked = n; return null; } });
  check("a listicle result is looked up by its core name", asked === "Beretta Mission", asked);
  const many = JSON.stringify({ items: Array.from({ length: 6 }, (_, i) => ({ name: `Place ${i}`, url: `https://p${i}.com/`, details: [] })) });
  check("a search keeps as many results as it asked for (up to 6), three by default", W.parseRawResults(many).length === 3 && W.parseRawResults(many, 6).length === 6 && W.parseRawResults(many, 10).length === 6);
  const factless = [{ name: "Copra", url: "https://www.coprarestaurant.com/private-events", official: true, facts: [], date: null, deadline: null }, { name: "Del Popolo", url: "https://www.7x7.com/x", official: false, facts: [], date: null, deadline: null }];
  check("a name with no verified facts is dropped by default", W.withVerifiedFacts(factless).kept.length === 0);
  check("a caller that reads the page itself keeps a factless OWN page, never a factless listicle", W.withVerifiedFacts(factless, { ownPageReadAfter: true }).kept.map((k) => k.name).join() === "Copra");
}

console.log(`task web rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
