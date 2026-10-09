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
check("text path: threads, loops and carrying", /memberSafeLine\(userId\)/.test(tc) && /loops: safeLoops/.test(tc) && /threads: safeThreads/.test(tc) && /carryingItems\([\s\S]{0,140}\)\.flatMap\(\(c\) => \{ const label = keep\(c\.label\)/.test(tc));

console.log(`member safety gaps: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
