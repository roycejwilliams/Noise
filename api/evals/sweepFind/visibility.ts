// The sweep's audit trail and brief (2026-10-08): an X failure is logged and
// told to Co as a failure (not "no posts"), what Co looked at and passed over
// is recorded with a reason, X is spent only on asks it covers, and the brief
// names every tier Co can fill. Model-free, no outside calls:
//   npx tsx evals/sweepFind/visibility.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const SF = await import("../../src/services/sweepFind.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};
const sf = fs.readFileSync(new URL("../../src/services/sweepFind.ts", import.meta.url), "utf8");

// ---- X failures: by kind and status, never swallowed
{
  const err = (m: string) => new Error(m);
  check("429 reads as rate limited", JSON.stringify(SF.xFailure(err('xSearch: searchRecentPosts failed (429): {"title":"Too Many Requests"}'))) === JSON.stringify({ kind: "rate_limited", status: 429 }));
  check("401 and 403 read as auth", SF.xFailure(err("xSearch: searchRecentPosts failed (401): Unauthorized")).kind === "auth" && SF.xFailure(err("xSearch: searchRecentPosts failed (403): Forbidden")).kind === "auth");
  check("a missing token reads as not configured", SF.xFailure(err("xSearch: X_API_BEARER_TOKEN is not configured")).kind === "not_configured");
  check("5xx reads as server", SF.xFailure(err("xSearch: searchRecentPosts failed (503): down")).kind === "server");
  check("a network error reads as error, no status", JSON.stringify(SF.xFailure(err("fetch failed"))) === JSON.stringify({ kind: "error", status: null }));
  const note = SF.xFailedNote({ kind: "rate_limited", status: 429 });
  check("Co is told the search failed, not that there were no posts", /X search failed/.test(note) && /says nothing about whether posts exist/.test(note) && /webSearch/.test(note) && !/No posts for that/.test(note), note);
  check("the note carries no em dash or exclamation point", !/[—–!]/.test(note + SF.xFailedNote({ kind: "auth", status: 401 }) + SF.xFailedNote({ kind: "error", status: null })));
  check("the X call is no longer swallowed by catch(() => [])", !/searchRecentPosts\(q, X_SEARCH_RESULTS\)\.catch\(/.test(sf) && /xError = xFailure\(err\)/.test(sf) && /return \{ ok: false, error: xFailedNote\(xError\) \}/.test(sf));
  check("the failure is logged by kind and status only (no response body)", /console\.error\(`sweepFind: X search failed \(\$\{xError\.kind\}/.test(sf) && !/console\.error\([^)]*err\.message/.test(sf.slice(sf.indexOf("xError = xFailure(err)"), sf.indexOf("xError = xFailure(err)") + 300)));
  check("the sweep.find record carries the X failure", /\.\.\.\(xError \? \{ xError \} : \{\}\)/.test(sf));
}

// ---- what Co looked at and passed over
{
  const looked = [
    { source: "events" as const, name: "Founder Supper", url: "https://lu.ma/supper" },
    { source: "web" as const, name: "Builders Residency", url: "https://residency.example.com" },
    ...Array.from({ length: 12 }, (_, i) => ({ source: "x" as const, name: `@acct${i}: post ${i}`, url: `https://x.com/i/status/${i}` })),
    { source: "web" as const, name: "Kept Fellowship", url: "https://kept.example.org" },
    { source: "x" as const, name: "@dup: same post", url: "https://x.com/i/status/3" },
  ];
  const reasons = new Map([["https://x.com/i/status/5", "token promotion"], ["https://residency.example.com", "applications closed"]]);
  const p = SF.passedOver(looked, new Set(["https://kept.example.org"]), reasons);
  check("capped at ten", p.length === SF.PASSED_OVER_CAP && SF.PASSED_OVER_CAP === 10);
  check("X first, and a post Co gave a reason for leads", p[0].source === "x" && p[0].url === "https://x.com/i/status/5" && p[0].why === "token promotion", JSON.stringify(p[0]));
  check("what Co kept is not listed as passed over", !p.some((x) => x.url === "https://kept.example.org"));
  check("each link once", new Set(p.map((x) => x.url)).size === p.length);
  check("no reason given reads as 'not kept'", p.filter((x) => x.url !== "https://x.com/i/status/5").every((x) => x.why === "not kept"));
  const small = SF.passedOver(looked.slice(0, 3), new Set(), reasons);
  check("web and events are listed after X, with their reason", small.map((x) => x.source).join() === "x,web,events" && small[1].why === "applications closed", JSON.stringify(small));
  check("a page kept in place of its X post keeps the post off the list", /postOf\.set\(l, p\.url\)/.test(sf) && /postOf\.get\(String\(m\.url\)\)/.test(sf));
  check("the gate's reason is used for what Co kept and the gate stopped", /gatedOut \}\)/.test(sf) && /kept, then the fact gate: /.test(sf));
  check("the sweep.find record carries passedOver, counts of what was looked at, and the tiers tried", /passedOver: passed/.test(sf) && /lookedAt: \{ x: /.test(sf) && /tried, kept:/.test(sf));
  check("Co states its reasons in the same loop (a skip tool), not a second model call", sf.includes("skip: tool(") && /description: SWEEP_PASS_TOOL/.test(sf) && (sf.match(/generateText\(/g) ?? []).length === 1);
}

// ---- the brief: tiers, and when X fits
{
  const p = SF.sweepPrompt({ userId: "u", firstName: "Jordan", askText: "a founder dinner this month", city: "San Francisco" }, { today: "2026-10-08", record: SF.emptySweepRecord() });
  check("the brief names every tier and how to reach it", p.includes(SF.SWEEP_TIERS) && /Co's own events/.test(SF.SWEEP_TIERS) && /public event feed/.test(SF.SWEEP_TIERS) && /webSearch/.test(SF.SWEEP_TIERS) && /searchPosts/.test(SF.SWEEP_TIERS));
  // Royce, 2026-10-13: forcing all three sources is allowed only in the 9am floor run (opts.allSources); the hourly sweeps keep
  // "guidance, not forced".
  check("an event-shaped ask looks at searchEvents before finishing (hourly: guidance, not a forced call)", /look at searchEvents before you finish/.test(SF.SWEEP_TIERS) && (sf.match(/toolChoice/g) ?? []).length === 1 && /\.\.\.\(opts\.allSources\s*\?\s*\{\s*prepareStep:[\s\S]{0,300}?toolChoice[\s\S]{0,200}?\}\s*:\s*\{\}\)/.test(sf));
  check("only the 9am floor forces all three sources", SF.nextRequiredSource(new Set(), 0) === "searchEvents" && !SF.sweepPrompt({ userId: "u", firstName: "J", askText: "a", city: null }, { today: "2026-10-13", record: SF.emptySweepRecord() }).includes(SF.SWEEP_ALL_SOURCES));
  check("X is skipped for things that aren't to find", /isn't a thing to find at all/.test(SF.SWEEP_X_GUIDANCE) && /skip X for that sweep/.test(SF.SWEEP_X_GUIDANCE));
  check("X still named for programs, cohorts, open calls", /cohort/.test(SF.SWEEP_X_GUIDANCE) && /open call/.test(SF.SWEEP_X_GUIDANCE));
  check("the brief asks Co to note what it passed on", /skip\(\)/.test(p));
  check("no em dash or exclamation point in what Co reads", !/[—–!]/.test(SF.SWEEP_TIERS + SF.SWEEP_PASS_TOOL + SF.SWEEP_X_GUIDANCE));
}

console.log(`sweepFind visibility: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
