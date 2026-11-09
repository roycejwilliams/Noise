// A search that failed is not a search that found nothing (2026-11-09: one member's ask failed its morning search on four days in a
// row, quietly). A failed loop isn't an empty run, and an ask or goal failing SWEEP_FAILING_DAYS days in a row is flagged on the dev
// review and the /sweeps page. Model-free, no outside calls:
//   npx tsx evals/sweepFind/failedNotEmpty.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const SF = await import("../../src/services/sweepFind.js");
const E = await import("../../src/services/eventSurfacingSweep.js");
const D = await import("../../src/services/dailySweep.js");
const R = await import("../../src/harness/devReview.js");
const MT = await import("../../src/services/modelText.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};

// ---- a failed loop looked nowhere; it never moves the ask toward its backoff
{
  check("a loop that failed before any search came back didn't look", SF.ranClean({ searched: false, blocked: false, loopFailed: true }) === false);
  check("what came back before a later step failed still counts", SF.ranClean({ searched: true, blocked: false, loopFailed: true }) === true);
  check("a clean run that chose not to search still counts (unchanged)", SF.ranClean({ searched: false, blocked: false, loopFailed: false }) === true && SF.ranClean({ searched: false, blocked: true, loopFailed: false }) === false);
  check("a failed loop is not an empty run", E.movesEmptyRuns({ searched: SF.ranClean({ searched: false, blocked: false, loopFailed: true }), found: [] }) === false);
  check("a clean empty run still is one", E.movesEmptyRuns({ searched: true, found: [] }) === true);
  const sf = fs.readFileSync(new URL("../../src/services/sweepFind.ts", import.meta.url), "utf8");
  check("the loop's catch marks the failure and the result reads it", /loopFailed = true;/.test(sf) && /searched: ranClean\(\{ searched, blocked, loopFailed \}\)/.test(sf));
  check("the morning sweep still says a failed item as an error, not as searched", D.searchFailed({ sources: { events: false, web: false, x: false } }) === true);
}

// ---- days in a row
{
  const item = (kind: string, id: string, status: string) => ({ kind, id, status });
  const earlier = [
    { day: "2026-11-07", items: [item("ask", "a1", "searched")] }, // the day's last run (newest first): a retry searched it
    { day: "2026-11-07", items: [item("ask", "a1", "error")] },
    { day: "2026-11-06", items: [item("ask", "a1", "error"), item("goal", "g1", "error")] },
    { day: "2026-11-05", items: [item("ask", "a1", "error"), item("goal", "g1", "error")] },
  ];
  const s = D.failingStreaks("2026-11-08", ["ask:a1", "goal:g1", "ask:new"], earlier);
  check("a day counts by its own last record: a later retry that searched it ends the run", s.get("ask:a1") === 1, JSON.stringify([...s]));
  check("a day with no record (tapered, nothing ran) ends the run too", s.get("goal:g1") === 1);
  check("first failure: one day", s.get("ask:new") === 1);
  const s2 = D.failingStreaks("2026-11-08", ["ask:a1"], [{ day: "2026-11-07", items: [item("ask", "a1", "error")] }, { day: "2026-11-06", items: [item("ask", "a1", "error")] }, { day: "2026-11-05", items: [item("ask", "a1", "error")] }, { day: "2026-11-04", items: [item("ask", "a1", "searched")] }]);
  check("the 11-05 to 11-08 case: four days in a row", s2.get("ask:a1") === 4);
  check("flagged from the second day (SWEEP_FAILING_DAYS)", D.SWEEP_FAILING_DAYS === 2 && D.failingStreaks("2026-11-08", ["ask:a1"], [{ day: "2026-11-07", items: [item("ask", "a1", "error")] }]).get("ask:a1")! >= D.SWEEP_FAILING_DAYS);
  check("today's own earlier records never count as another day", D.failingStreaks("2026-11-08", ["ask:a1"], [{ day: "2026-11-08", items: [item("ask", "a1", "error")] }]).get("ask:a1") === 1);
  const ds = fs.readFileSync(new URL("../../src/services/dailySweep.ts", import.meta.url), "utf8");
  check("flagged only after the day's last retry, never on an on-demand run", /if \(last && base\.trigger !== "manual"\) await flagFailingAgain\(/.test(ds));
}

// ---- manual runs and missed days (review of #429)
{
  const item = (kind: string, id: string, status: string) => ({ kind, id, status });
  const withManual = D.failingStreaks("2026-11-08", ["ask:a1"], [
    { day: "2026-11-07", items: [item("ask", "a1", "searched")], trigger: "manual" }, // an on-demand run never stands for the day
    { day: "2026-11-07", items: [item("ask", "a1", "error")] },
  ]);
  check("an on-demand run is never the day's record (it can't end or start a run of days)", withManual.get("ask:a1") === 2, JSON.stringify([...withManual]));
  const missed = D.failingStreaks("2026-11-08", ["ask:a1"], [{ day: "2026-11-07", items: [], action: "missed" }, { day: "2026-11-06", items: [item("ask", "a1", "error")] }]);
  check("a day whose last record is missed ends the run (nothing was searched that day, so it isn't a failed search)", missed.get("ask:a1") === 1);
  const ds = fs.readFileSync(new URL("../../src/services/dailySweep.ts", import.meta.url), "utf8");
  check("the history read leaves on-demand runs out in SQL too", /AND COALESCE\(proposal->>'trigger', ''\) <> 'manual' ORDER BY created_at DESC`,\n    \[userId, day\],/.test(ds));
}

// ---- the sweep.daily record (jsonb) never carries half a pair (review of #429)
{
  const lone = (v: unknown): boolean => (typeof v === "string" ? MT.hasLoneSurrogate(v) : Array.isArray(v) ? v.some(lone) : v && typeof v === "object" ? Object.values(v).some(lone) : false) || /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(typeof v === "object" ? JSON.stringify(v) : "");
  const ask = `${"x".repeat(D.ITEM_TEXT_CHARS - 1)}🚀 an engineer to build with`;
  check("the old cut would leave half a pair at the boundary (the case, reproduced)", /[\uD800-\uDBFF]$/.test(ask.slice(0, D.ITEM_TEXT_CHARS)));
  const b = { kind: "ask" as const, id: "a1", text: D.itemText(ask) };
  const rec = D.searchedItem(b, { sources: { events: true, web: true, x: true, failures: [] }, found: 0, pooled: 0, queued: 0, outcome: "empty" });
  const proposal = { day: "2026-11-08", items: [rec, { ...b, status: "error", why: "it looked nowhere" }], totals: D.dailySummary([rec]).totals };
  check("an emoji at the boundary: the item's words go into the jsonb record whole-only", b.text.length === D.ITEM_TEXT_CHARS - 1 && !lone(proposal), JSON.stringify(b.text.slice(-3)));
  const ds = fs.readFileSync(new URL("../../src/services/dailySweep.ts", import.meta.url), "utf8");
  check("every ask and goal text on the record is cut by itemText, and no code-unit cut of text is left in the daily sweep", (ds.match(/itemText\(/g) ?? []).length >= 6 && !/(ask_text \?\? ""\)|askText|\bg|g\.goal|i\.text|join\("[^"]*"\)|why \?\? ""\)|reason \?\? ""\)|reason|message \?\? err\))\.slice\(0, \d{2,}\)/.test(ds));
  check("the repeated-failure record's words are clipped too", /text: itemText\(i\.text\), why: i\.why \?\? null/.test(ds) && /reason: clip\(repeated\.map/.test(ds));
  const sf = fs.readFileSync(new URL("../../src/services/sweepFind.ts", import.meta.url), "utf8");
  check("the loop-failure message is clipped", /the search loop failed \(\$\{clip\(String\(err\?\.message \?\? err\), 120\)\}\)/.test(sf));
}

// ---- where the team sees it
{
  const note = D.failingAgainNote([{ kind: "ask", id: "3f2a9c11-aaaa", text: "their words", days: 4, why: "it looked nowhere" }]);
  check("/sweeps: by kind and id with the days, never the member's words", note === "failing 2+ days in a row: ask 3f2a9c11 (4 days)" && !/their words/.test(note ?? ""), String(note));
  check("/sweeps: nothing to say when nothing repeated", D.failingAgainNote(undefined) === null && D.failingAgainNote([]) === null);
  const flags = R.logFlags({ userId: "u", messages: [], decisions: [{ id: 1, at: "2026-11-08T19:05:00Z", decision: "sweep.failing_again", outcome: "skip", action: "error", reason: "r", proposal: { day: "2026-11-08", items: [{ kind: "ask", id: "a1", text: "Seeking an engineer", days: 4, why: "it looked nowhere: the search loop failed" }] } }] } as any);
  const f = flags.find((x: any) => x.type === "search_failing");
  check("the dev review's what-broke flags it, high", !!f && f.severity === "high" && /failed 4 days in a row/.test(f.snippet) && /search loop failed/.test(f.cause), JSON.stringify(f));
  check("labelled", typeof (R.FLAG_LABELS as any).search_failing === "string");
}

console.log(`search failed is not nothing found: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
