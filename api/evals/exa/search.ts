// Search through Exa (Royce, 2026-10-16): Exa finds the pages, a model picks from those pages alone, and Cue's own checks run after,
// unchanged. Without EXA_API_KEY every caller keeps Anthropic's web search as before. Zero tokens: Exa and the model are stubbed
// here, nothing leaves the machine.
//   npx tsx evals/exa/search.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import { readFileSync } from "fs";

const X = await import("../../src/services/exaSearch.js");
const T = await import("../../src/services/taskWeb.js");
const O = await import("../../src/services/webOpportunitySearch.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

// ---------------------------------------------------------------- the stub web: Exa, the model, and nothing else
const exaCalls: { headers: any; body: any }[] = [];
const modelCalls: any[] = [];
let exaAnswer: any = { results: [] };
let exaStatus = 200;
let modelText = '{"items": []}';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url instanceof URL ? url.href : typeof url === "string" ? url : url?.url);
  if (u.startsWith("https://api.exa.ai/")) {
    exaCalls.push({ headers: init?.headers, body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify(exaAnswer), { status: exaStatus, headers: { "content-type": "application/json" } });
  }
  if (/api\.anthropic\.com/.test(u)) {
    modelCalls.push(JSON.parse(init?.body ?? "{}"));
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: modelText }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("", { status: 404 });
}) as typeof fetch;
const promptOf = (c: any) => JSON.stringify(c?.messages ?? "");

const PAGES = {
  results: [
    { url: "https://joulesaccelerator.org/apply", title: "Joules Accelerator: apply", publishedDate: "2026-10-01T00:00:00Z", text: "Joules Accelerator. Applications open until Nov 30, 2026. $100K for climate hardware founders." },
    { url: "https://joulesaccelerator.org/apply", title: "dupe", text: "dupe" },
    { url: "http://insecure.example.com", title: "http only", text: "x" },
    { url: "https://blog.example.com/top-10-accelerators", title: "Top 10", text: "A list." },
  ],
  costDollars: { total: 0.0132 },
};

try {
  // ---------------------------------------------------------------- the module
  check("off without a key, on with one (a key, never a switch)", !X.exaConfigured({} as any) && !X.exaConfigured({ EXA_API_KEY: "  " } as any) && X.exaConfigured({ EXA_API_KEY: "k" } as any));
  const pages = X.pagesFrom(PAGES);
  check("Exa's results become pages: https only, one per url", pages.length === 2 && pages[0].url === "https://joulesaccelerator.org/apply" && pages[0].published === "2026-10-01" && pages.every((p) => p.url.startsWith("https://")));
  check("a url the picker gives must be one of the pages (a lost slash, www or tracking tag still counts; the page's own url is kept)", X.onePage("https://joulesaccelerator.org/apply", pages) === "https://joulesaccelerator.org/apply" && X.onePage("https://www.joulesaccelerator.org/apply/?utm_source=x", pages) === "https://joulesaccelerator.org/apply" && X.onePage("https://joulesaccelerator.org/apply/other", pages) === null && X.onePage("https://made-up.example.com", pages) === null && X.onePage(null, pages) === null);
  const fp = X.fromPagesPrompt("RULES STAY", pages);
  check("the picker is told it can't search, keeps every rule it had, and sees each page with its url and text", fp.startsWith("RULES STAY") && /You can't search/.test(fp) && /must be one of these, exactly as written/.test(fp) && /\[P1\] https:\/\/joulesaccelerator\.org\/apply/.test(fp) && /Applications open until Nov 30, 2026/.test(fp));

  const env = { EXA_API_KEY: "test-key" } as any;
  exaAnswer = PAGES;
  const s = await X.exaSearch("climate hardware accelerators in or near San Francisco", { purpose: "t", env });
  const call = exaCalls.at(-1)!;
  check("one search: the key in its header, auto search, page text with a freshness limit", call.headers?.["x-api-key"] === "test-key" && call.body.type === "auto" && call.body.numResults === X.EXA.pages && call.body.contents?.text?.maxCharacters === X.EXA.pageChars && call.body.contents?.maxAgeHours === X.EXA.maxAgeHours, call);
  check("... and its cost is read", s.cost === 0.0132 && s.pages.length === 2 && s.error === null);
  const noText = await X.exaSearch("Joules Accelerator official site", { purpose: "t", env, text: false });
  check("a lookup that needs only urls asks for no page text", !("contents" in exaCalls.at(-1)!.body) && noText.pages.length === 2);
  exaStatus = 429;
  exaAnswer = { error: "rate limited" };
  const bad = await X.exaSearch("x", { purpose: "t", env });
  check("a failed search is no pages and says why; it never throws", bad.pages.length === 0 && /Exa 429/.test(bad.error ?? ""));
  exaStatus = 400;
  exaAnswer = { error: "query 'founder dinners for Jordan' rejected", tag: "INVALID_REQUEST" };
  const echoed = await X.exaSearch("x", { purpose: "t", env });
  check("an Exa error keeps only its status and tag (its text can echo the member's want)", echoed.error === "Exa 400 INVALID_REQUEST", echoed.error);
  exaStatus = 200;
  exaAnswer = "<html>not json</html>";
  const unreadable = await X.exaSearch("x", { purpose: "t", env });
  check("a reply that can't be read is a failed search, never 'nothing exists'", unreadable.pages.length === 0 && /couldn't be read/.test(unreadable.error ?? ""), unreadable);
  exaAnswer = PAGES;
  check("an email or phone number never goes to Exa", X.scrubQuery("venues for jordan@example.com, call 415-555-0101, 60 people in SF") === "venues for , call , 60 people in SF" && X.scrubQuery("Oct 22 2026 events for 40") === "Oct 22 2026 events for 40");
  exaStatus = 200;
  const callsNow = exaCalls.length;
  const off = await X.exaSearch("x", { purpose: "t", env: {} as any });
  check("without a key nothing is sent to Exa", off.error === "Exa isn't configured" && exaCalls.length === callsNow);
  check("what's logged is counts and cost, never the query (it's the member's want)", /proposal: \{ pages: out\.pages\.length, cost: out\.cost \}/.test(src("services/exaSearch.ts")) && !/proposal: \{[^}]*query/.test(src("services/exaSearch.ts")));

  // ---------------------------------------------------------------- the callers, with and without the key
  // Without a key: Anthropic's web search, as before.
  delete process.env.EXA_API_KEY;
  modelText = '{"found": false}';
  const before = exaCalls.length;
  await O.searchWebForOpportunity("climate hardware accelerators", "San Francisco", null, "2026-10-16", { source: "sweep" });
  const m0 = modelCalls.at(-1);
  check("no key: the opportunity search uses Anthropic's web search tool, and Exa isn't called", exaCalls.length === before && JSON.stringify(m0?.tools ?? []).includes("web_search"), m0?.tools);

  // With a key: Exa finds, the model picks from those pages only, with no search tool.
  process.env.EXA_API_KEY = "test-key";
  exaAnswer = PAGES;
  modelText = '{"found": true, "name": "Joules Accelerator", "url": "https://joulesaccelerator.org/apply", "category": "accelerator", "reason": "Applications are open until Nov 30.", "deadline": "2026-11-30", "date": null}';
  const r1 = await O.searchWebForOpportunity("climate hardware accelerators", "San Francisco", null, "2026-10-16", { source: "sweep" });
  const m1 = modelCalls.at(-1);
  check("with a key: the opportunity search asks Exa (the ask and the city), then a model with no search tool picks from the pages", exaCalls.at(-1)!.body.query === "climate hardware accelerators in or near San Francisco" && !JSON.stringify(m1?.tools ?? []).includes("web_search") && /\[P1\] https:\/\/joulesaccelerator\.org\/apply/.test(promptOf(m1)));
  check("... and a pick on one of the pages comes back, to be checked as every web find is", r1?.url === "https://joulesaccelerator.org/apply" && r1?.name === "Joules Accelerator", r1);
  modelText = '{"found": true, "name": "Joules Accelerator", "url": "https://joules-remembered.example.com", "category": "accelerator", "reason": "x", "deadline": null, "date": null}';
  check("a url that isn't one of the pages found is nothing (never a remembered or made-up link)", (await O.searchWebForOpportunity("climate hardware accelerators", "San Francisco", null, "2026-10-16", { source: "sweep" })) === null);
  exaAnswer = { results: [] };
  const calls = modelCalls.length;
  check("no pages: nothing, and no model call is spent", (await O.searchWebForOpportunity("x", null, null, "2026-10-16")) === null && modelCalls.length === calls);

  // The official-page lookup needs no model: the first result that's the thing's own site.
  exaAnswer = { results: [{ url: "https://www.crunchbase.com/organization/joules", title: "Joules on Crunchbase" }, { url: "https://joulesaccelerator.org/", title: "Joules" }] };
  const mBefore = modelCalls.length;
  const official = await O.findOfficialPage("Joules Accelerator", 20_000);
  check("the official page through Exa: the first result on its own site, no model call", official === "https://joulesaccelerator.org/" && modelCalls.length === mBefore && exaCalls.at(-1)!.body.contents === undefined, { official });

  // The task search: only picks on the found pages go on to Cue's own page checks.
  exaAnswer = PAGES;
  modelText = JSON.stringify({ items: [{ name: "Joules Accelerator", url: "https://joulesaccelerator.org/apply", details: [{ label: "deadline", value: "Nov 30, 2026" }], date: null, deadline: "2026-11-30" }, { name: "Invented Fund", url: "https://invented.example.com", details: [], date: null, deadline: null }] });
  const t = await T.taskWebSearch("u1", "climate hardware accelerators", { city: "San Francisco", skipBudget: true, log: false });
  check("the task search through Exa: the pick on a found page goes on to be read and checked; the made-up one never does", t.dropped.some((d) => d.url === "https://joulesaccelerator.org/apply") && !t.dropped.some((d) => /invented/.test(d.url)) && !t.kept.some((k) => /invented/.test(k.url)), t);
  // The sites and the recent window the task names reach Exa as searches of their own.
  exaAnswer = PAGES;
  const n0 = exaCalls.length;
  await T.taskWebSearch("u1", "a private event space for 60 people", { city: "San Francisco", skipBudget: true, log: false, sites: ["peerspace.com", "yelp.com"], recentHours: 48 });
  const sent = exaCalls.slice(n0).map((c) => c.body);
  check("a site list and a recent window each get their own Exa search (includeDomains, startPublishedDate)", sent.length === 3 && sent.some((b) => JSON.stringify(b.includeDomains) === '["peerspace.com","yelp.com"]') && sent.some((b) => typeof b.startPublishedDate === "string" && Date.now() - Date.parse(b.startPublishedDate) > 47 * 3_600_000), sent);
  const pickPrompt = modelCalls.map(promptOf).reverse().find((t) => t.includes("You can't search")) ?? "";
  check("a listing site that can't be checked: the picker gives the listing's real name, not an own site that isn't among the pages", /give its real name exactly as the listing shows it/.test(pickPrompt) && !/give the place's OWN website/.test(pickPrompt));
  exaStatus = 500;
  exaAnswer = { error: "down" };
  const t2 = await T.taskWebSearch("u1", "x", { skipBudget: true, log: false });
  check("Exa down: the task search says the search failed (never 'nothing exists')", /^Web search failed: Exa 500/.test(t2.note) && !t2.kept.length, t2.note);
  exaStatus = 200;

  // The named-event lookup and every caller keep the old path without a key, and check the url with one.
  const ne = src("services/namedEventLookup.ts");
  check("the named-event lookup: Exa with a key, the url must be a found page, the old search without", /if \(exaConfigured\(\)\)/.test(ne) && /if \(pages && !onePage\(found\.url, pages\)\)/.test(ne) && /webSearch_20250305/.test(ne));
  const tw = src("services/taskWeb.ts");
  check("every page check after the search is unchanged (pickPage, verifyResult, withVerifiedFacts run on Exa's picks too)", /raws = parseRawResults\(text, opts\.max \?\? 3\)\.flatMap\(\(r\) => \{\s*const url = onePage\(r\.url, found\.pages\);\s*return url \? \[\{ \.\.\.r, url \}\] : \[\];/.test(tw) && /const pages = await Promise\.all\(raws\.map\(\(raw\) => pickPage\(/.test(tw) && /withVerifiedFacts\(kept/.test(tw));
} finally {
  globalThis.fetch = realFetch;
  delete process.env.EXA_API_KEY;
}

console.log(`exa search: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
