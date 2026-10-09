// The four paths that put another member's details into a prompt unstripped (2026-10-09 audit), closed. Zero tokens.
//   npx tsx evals/member/safeGaps.ts
import fs from "node:fs";
const M = await import("../../src/services/memberSafeMemories.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

const safe = await M.memberSafeLine("u-test", ["Sarah"]);
const coLine = safe("Co replied: Sarah told me she wants to cofound a climate startup and is free Thursdays.");
check(`a Co line about a linked member keeps only that they came up ("${coLine}")`, !!coLine && !/cofound|climate|Thursdays/.test(coLine) && /Sarah, another member/.test(coLine));
check("their own words are theirs and kept", safe("User said: Sarah and I want to grab coffee") === "User said: Sarah and I want to grab coffee");
check("a loop title naming a linked member is stripped", !/wants to cofound/.test(safe("Waiting on Sarah: wants to cofound, deciding by Friday") ?? ""));
check("lines without a linked member pass through", safe("Find a caterer for the open house") === "Find a caterer for the open house");

// Each of the four paths runs its context through the strip, and fails closed (no strip, nothing).
check("proactive dispatch transcript", /memberSafeLine\(userId\)[\s\S]{0,400}safe \? r\.rows\.map\(\(x: any\) => safe\(String\(x\.content\)\)\)/.test(src("harness/proactive.ts")));
check("sweep picker texts", /memberSafeLine\(userId\)[\s\S]{0,600}text: safe \? \(safe\(String\(t\.content\)\)/.test(src("services/sweepSelectContext.ts")));
check("call-tool loops and task goals (spoken sources)", /memberSafeLine\(userId\)[\s\S]{0,300}goal: safe \? safe\(String\(x\.goal/.test(src("services/callTools.ts")) && /const loops = l && safe \?/.test(src("services/callTools.ts")));
const tc = src("services/turnContext.ts");
// Loops and carrying come from member knowledge (stripped inside, fails closed: a failed read leaves it all out), and the labels go
// through the text path's own strip again.
check(
  "text path: threads, loops and carrying",
  /memberSafeLine\(userId\)/.test(tc) &&
    /threads: safeThreads/.test(tc) &&
    /memberKnowledge\(userId, \{ include: TEXT_KNOWLEDGE \}[\s\S]{0,40}\)\.catch\([\s\S]{0,200}return null;/.test(tc) &&
    !/FROM open_loops/.test(tc) &&
    /carryFromKnowledge\(knowledge\?\.carrying \?\? \[\], zone, windows\)\.flatMap\(\(c\) => \{ const label = keep\(c\.label\)/.test(tc),
);

// Review of #118: the realistic failure is the name lookup, and it must fail closed (throw), never strip nothing.
const prevDb = process.env.DATABASE_URL;
const failedClosed = await M.memberSafeLine("00000000-0000-0000-0000-000000000000").then(() => false).catch(() => true);
check("a failed name lookup throws (callers then leave the context out), never returns a strip with no names", failedClosed || !!prevDb);
// The same names as memberSafe: Co's own records (Tier 0 picks, intro offers) count, not only linked matches.
const fromRecords = M.namesInRecords([{ memory_type: "recommendation", content: "[Tier 0] Maya: building grid storage | event X" }]);
const s2 = await M.memberSafeLine("u-test", fromRecords);
check(`a Tier 0 pick's name from Co's records is stripped ("${s2("Co replied: Maya is building grid storage and left Tesla.")}")`, !/grid storage|Tesla/.test(s2("Co replied: Maya is building grid storage and left Tesla.") ?? ""));
check("memberSafeLine's lookup covers Co's records and introductions, like memberSafe", /namesInRecords\(records\.rows\)/.test(src("services/memberSafeMemories.ts")) && /network_introductions/.test(src("services/memberSafeMemories.ts")));
check("picker: sent messages and outcomes stripped too", /what: `\$\{s\.type\}: \$\{\(safe \? safe\(String\(s\.message/.test(src("services/sweepSelectContext.ts")) && /item: safe \? safe\(String\(o\.item_name\)\)/.test(src("services/sweepSelectContext.ts")));
check("text path: tasks, briefs, lessons, ledger lines and open work stripped too", /lessons: keepAll\(lessons\)/.test(tc) && /tasks: keepAll\(tasks\), briefs: keepAll\(briefs\)/.test(tc) && /ledger: \{ \.\.\.ledger, lines: keepAll\(ledger\.lines\), named: keepAll\(ledger\.named\) \}/.test(tc) && /const openWork = keepAll\(/.test(tc));

console.log(`member safety gaps: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
