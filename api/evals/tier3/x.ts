// Tier 3 from X (2026-10-07): the search's own flags and expanded links, the
// sweep's guidance on when and how to search X, and the monitor reading the
// log the sweep actually writes. Model-free, no outside calls.
//   npx tsx evals/tier3/x.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const X = await import("../../src/services/xSearch.js");
const SF = await import("../../src/services/sweepFind.js");
const M = await import("../../src/harness/monitor.js");
const G = await import("../../src/harness/matchGate.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};
const src = (f: string) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

// The search itself.
{
  const q = X.xSearchQuery("(accelerator OR cohort) (applications open OR apply)");
  check("English originals only: -is:retweet and lang:en added", q.endsWith("-is:retweet lang:en"), q);
  check("flags a query already has aren't doubled", X.xSearchQuery("founders -is:retweet lang:es") === "founders -is:retweet lang:es");
  const u = X.xSearchUrl("founder dinner");
  check("20 posts a search by default", X.X_SEARCH_RESULTS === 20 && u.searchParams.get("max_results") === "20");
  check("max_results stays inside X's 10 to 100", X.xSearchUrl("a", 5).searchParams.get("max_results") === "10" && X.xSearchUrl("a", 500).searchParams.get("max_results") === "100");
  check("entities (and long posts) asked for, so links come back expanded", /\bentities\b/.test(u.searchParams.get("tweet.fields") ?? "") && /note_tweet/.test(u.searchParams.get("tweet.fields") ?? ""));
  check("authors asked for", u.searchParams.get("expansions") === "author_id" && u.searchParams.get("user.fields") === "username");
  check("the query sent carries the flags", u.searchParams.get("query") === "founder dinner -is:retweet lang:en");
}

// Expanded links.
{
  const raw = {
    id: "1975000000000000001",
    author_id: "42",
    text: "Applications are open for the Foundry Fellowship, 12 weeks for pre-seed founders. Apply by Oct 31: https://t.co/AbCdEf1234 https://t.co/PhOtO98765",
    entities: {
      urls: [
        { url: "https://t.co/AbCdEf1234", expanded_url: "https://foundry.example.org/fellowship", display_url: "foundry.example.org/fellowship" },
        { url: "https://t.co/PhOtO98765", expanded_url: "https://x.com/foundry/status/1975000000000000001/photo/1", media_key: "3_1" },
      ],
    },
  };
  const p = X.expandPost(raw, new Map([["42", "foundry"]]));
  check("t.co links are replaced by where they go", p.text.includes("https://foundry.example.org/fellowship") && !p.text.includes("t.co/"), p.text);
  check("a photo's link is dropped from the text and the links", !p.text.includes("/photo/") && p.links.length === 1 && p.links[0] === "https://foundry.example.org/fellowship", JSON.stringify(p.links));
  check("the author's @ comes along", p.author === "foundry");
  check("the post link keeps the form the gate checks", p.url === "https://x.com/i/status/1975000000000000001");
  const unwound = X.expandPost({ id: "1", author_id: "9", text: "x https://t.co/ZzZzZzZzZz", entities: { urls: [{ url: "https://t.co/ZzZzZzZzZz", expanded_url: "https://bit.ly/abc", unwound_url: "https://program.example.com/apply" }] } });
  check("an unwound link wins over a shortener", unwound.links[0] === "https://program.example.com/apply" && unwound.text.endsWith("https://program.example.com/apply"));
  const long = X.expandPost({ id: "2", author_id: "9", text: "short…", note_tweet: { text: "The full long post about the Builders Residency https://t.co/LoNgLoNg12", entities: { urls: [{ url: "https://t.co/LoNgLoNg12", expanded_url: "https://residency.example.com" }] } } });
  check("a long post's full text is used", long.text.startsWith("The full long post") && long.links[0] === "https://residency.example.com");
  const article = X.expandPost({ id: "4", author_id: "1", text: "Read it https://t.co/ArTiClE123", entities: { urls: [{ url: "https://t.co/ArTiClE123", expanded_url: "https://x.com/i/article/2105752826726977537" }] } });
  check("an X article isn't offered as the program's page", article.links.length === 0 && article.text.includes("x.com/i/article/"));
  check("no entities: the post still comes through as written", X.expandPost({ id: "3", author_id: "1", text: "plain post" }).text === "plain post");
  const gate = G.checkGrounding({ tier: 3, kind: "opportunity", source: "x", name: "Foundry Fellowship", url: p.url, reason: p.text, evidence: p.text } as any, { searchCity: null, distanceMiles: null, evidence: p.text, alreadyOffered: false, now: new Date("2026-10-07") } as any);
  check("an expanded post still passes the gate's grounding check", gate.pass, gate.reason ?? "");
}

// The sweep: when and how to search X.
{
  const p = SF.sweepPrompt({ userId: "u", firstName: "Jordan", askText: "accelerators for a pre-seed consumer app", city: "San Francisco" }, { today: "2026-10-07", record: SF.emptySweepRecord() });
  check("the sweep prompt carries the X guidance", p.includes(SF.SWEEP_X_GUIDANCE));
  check("X once a sweep, for the asks X covers", /search X once in this sweep/.test(SF.SWEEP_X_GUIDANCE) && /accelerator/.test(SF.SWEEP_X_GUIDANCE) && /open call/.test(SF.SWEEP_X_GUIDANCE) && /founder or builder gatherings/.test(SF.SWEEP_X_GUIDANCE));
  check("an OR-synonym query written the way posts are", /OR/.test(SF.SWEEP_X_GUIDANCE) && /the way those posts are written/.test(SF.SWEEP_X_GUIDANCE) && /\(applications open OR now accepting OR apply\)/.test(SF.SWEEP_X_GUIDANCE) && /Keep it broad/.test(SF.SWEEP_X_GUIDANCE) && /broad/.test(SF.SWEEP_X_TOOL));
  check("no city, no year they didn't say", /Leave out their city and any year/.test(SF.SWEEP_X_GUIDANCE));
  check("not for venues or vendors", /Don't use X for venues, vendors/.test(SF.SWEEP_X_GUIDANCE) && /no venue or vendor names/.test(SF.SWEEP_X_TOOL));
  check("the club's bar for what's kept", /never a token or coin promotion, a giveaway, engagement bait or a bare headline/.test(p));
  check("the X budget is still one search a sweep", SF.SWEEP_BUDGET.xSearches === 1 && /One search a sweep/.test(SF.SWEEP_X_TOOL));
  const roles = /\b(concierge|assistant|matchmaker)\b/i;
  check("no role nouns for Co in the guidance", !roles.test(p) && !roles.test(SF.SWEEP_X_TOOL));
  const sf = src("services/sweepFind.ts");
  check("the sweep's X tool uses the guidance text and 20 posts", /description: SWEEP_X_TOOL/.test(sf) && /searchRecentPosts\(q, X_SEARCH_RESULTS\)/.test(sf));
  check("a post's own link can be kept, as a web page found through X", /source: "web", via: "x", url: l/.test(sf));
  check("the sweep logs its X search and what it kept from X", /did\.push\(`x: \$\{q\}\$\{checked\.loosenedFrom/.test(sf) && /xKept: gated\.filter/.test(sf) && /xPosts/.test(sf));
  const lt = src("agent/loopTools.ts");
  check("replies read 20 posts too, with links expanded", /searchRecentPosts\(q, X_SEARCH_RESULTS\)/.test(lt) && /links: p\.links\.length/.test(lt));
}

// The monitor reads the log the sweep writes.
{
  const sig = M.SIGNALS.find((s) => s.key === "tier3_x_nothing_kept");
  check("a Tier 3 X signal exists", !!sig);
  check("it reads sweep.find's X searches and xKept", !!sig && sig.bad.includes("'sweep.find'") && sig.bad.includes("'x: %'") && sig.bad.includes("xKept") && sig.total.includes("'sweep.find'") && sig.total.includes("'x: %'"));
  check("no signal reads the dead scope.xQuery any more", !M.SIGNALS.some((s) => /xQuery/.test(s.bad + s.total)));
  check("it reads a week, alerting on the level", !!sig?.steady && M.signalWindow(sig).recent === "7 days" && /INTERVAL '7 days' - INTERVAL '\$\{w\.recent\}'/.test(src("harness/monitor.ts")));
  if (sig) {
    const r = (bad: number, tot: number, base: number) => ({ signal: sig, recentBad: bad, recentTotal: tot, recentRate: tot ? bad / tot : 0, baselineRate: base });
    check("a week of X searches with nothing kept alerts, even when last week was the same", M.shouldAlert(r(8, 8, 1)));
    check("one thing kept from X in the week doesn't", !M.shouldAlert(r(11, 12, 1)));
    check("too few X searches to tell doesn't", !M.shouldAlert(r(5, 5, 0)));
  }
  const other = M.SIGNALS.find((s) => s.key === "reply_redrafted")!;
  check("other signals keep their 6-hour window", M.signalWindow(other).recent === "6 hours");
  check("the sweep's did lines match what the signal looks for", /did\.push\(`x: /.test(src("services/sweepFind.ts")));
}

console.log(`tier3 X rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
